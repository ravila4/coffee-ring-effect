import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSupplySampler, widthFactor, simulateBand } from '../src/physics.js';
import { buildStain } from '../src/render.js';
import { makeRng } from '../src/rng.js';

// A drip at the cup rim wicks along the rim-surface channel with finite volume:
// smooth thick lobe at the origin, sharp tips, dry far side.

const arcDist = (a, b) => {
  let d = Math.abs((((a - b) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
  return d > Math.PI ? 2 * Math.PI - d : d;
};

test('supply mass peaks smoothly at the drip and vanishes beyond the reach', () => {
  const s = makeSupplySampler([{ originTheta: 1, arcHalfLength: 0.6 * Math.PI, falloff: 1 }]);
  assert.equal(s.massAt(1), 1);
  // Smooth maximum, not a cusp: near-origin mass stays near 1.
  assert.ok(s.massAt(1.1) > 0.95);
  let prev = 1.1;
  for (let f = 0.1; f <= 0.9; f += 0.2) {
    const m = s.massAt(1 + f * 0.6 * Math.PI);
    assert.ok(m < prev, `not monotone at f=${f}`);
    prev = m;
  }
  assert.equal(s.massAt(1 + 0.61 * Math.PI), 0);
  assert.equal(s.massAt(1 - 0.61 * Math.PI), 0);
});

test('sampled azimuths reproduce the supply profile', () => {
  const s = makeSupplySampler([{ originTheta: 0, arcHalfLength: 0.7 * Math.PI, falloff: 1.2 }]);
  const rng = makeRng(401);
  const bins = new Float64Array(24);
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const theta = s.sample(rng);
    const d = arcDist(theta, 0);
    assert.ok(d <= 0.7 * Math.PI + 1e-9, `sample outside support: ${d}`);
    bins[Math.min(23, Math.floor((d / (0.7 * Math.PI)) * 24))]++;
  }
  // Compare binned counts against the profile (both directions fold into
  // arc distance, so expected mass per bin is proportional to massAt).
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let b = 0; b < 24; b++) {
    const mid = ((b + 0.5) / 24) * 0.7 * Math.PI;
    const expected = s.massAt(mid);
    num += bins[b] * expected;
    denA += bins[b] * bins[b];
    denB += expected * expected;
  }
  const corr = num / Math.sqrt(denA * denB);
  assert.ok(corr > 0.97, `profile correlation ${corr}`);
});

test('a shorter reach concentrates the same mass: denser at the origin', () => {
  const short = makeSupplySampler([{ originTheta: 0, arcHalfLength: 0.5 * Math.PI, falloff: 1 }]);
  const long = makeSupplySampler([{ originTheta: 0, arcHalfLength: 3 * Math.PI, falloff: 1 }]);
  assert.ok(short.relDensityAt(0) > 1.5 * long.relDensityAt(0), 'short crescent not denser');
  // A very long reach reads as a uniform ring.
  assert.ok(Math.abs(long.relDensityAt(0) - 1) < 0.15);
  assert.ok(Math.abs(long.relDensityAt(Math.PI) - 1) < 0.15);
});

test('band width couples as the square root of local density', () => {
  // V_r = πRw²θc: deposited mass per arc goes as w², so w ∝ √density.
  assert.ok(Math.abs(widthFactor(1) - 1) < 1e-12);
  assert.ok(Math.abs(widthFactor(4) - 1.8) < 1e-12, 'not clamped above');
  assert.ok(Math.abs(widthFactor(0) - 0.04) < 1e-12, 'not floored below');
  assert.ok(Math.abs(widthFactor(0.25) - 0.5) < 1e-12);
});

test('the supply gap collects no deposits at all', () => {
  const s = makeSupplySampler([{ originTheta: 0, arcHalfLength: 0.5 * Math.PI, falloff: 1 }]);
  const { deposits } = simulateBand({
    particles: 2500,
    rng: makeRng(402),
    sampleTheta: (rng) => s.sample(rng),
  });
  // θ diffusion adds ~0.06 rad of smear plus pinning-fail slosh; allow slop.
  const escaped = deposits.filter((d) => arcDist(d.theta, 0) > 0.5 * Math.PI + 0.5);
  assert.equal(escaped.length, 0, `${escaped.length} deposits in the dry gap`);
});

test('band mass decays with arc distance from the drip', () => {
  const s = makeSupplySampler([{ originTheta: 0, arcHalfLength: 0.8 * Math.PI, falloff: 1 }]);
  const { deposits } = simulateBand({
    particles: 3000,
    rng: makeRng(403),
    sampleTheta: (rng) => s.sample(rng),
  });
  const counts = [0, 0, 0];
  for (const d of deposits) {
    const f = arcDist(d.theta, 0) / (0.8 * Math.PI);
    if (f < 1) counts[Math.min(2, Math.floor(f * 3))]++;
  }
  assert.ok(counts[0] > counts[1] && counts[1] > counts[2], `not monotone: ${counts}`);
});

test('crescent sampling is deterministic per seed', () => {
  const mk = () => {
    const s = makeSupplySampler([{ originTheta: 2, arcHalfLength: 0.6 * Math.PI, falloff: 1.1 }]);
    return simulateBand({ particles: 400, rng: makeRng(404), sampleTheta: (rng) => s.sample(rng) });
  };
  assert.deepEqual(mk().deposits, mk().deposits);
});

test('the wash polygon collapses in the supply gap', () => {
  const stain = buildStain({
    seed: 7,
    radius: 100,
    particles: 800,
    type: 'mug',
    partialChance: 0,
    overlapChance: 0,
    mugSupply: [{ originTheta: 0, arcHalfLength: 0.6 * Math.PI, falloff: 1 }],
  });
  const wash = stain.washes[0];
  assert.ok(wash.holePoints, 'mug wash must be an annulus');
  const n = wash.points.length;
  const widthAt = (k) =>
    Math.hypot(wash.points[k].x, wash.points[k].y) -
    Math.hypot(wash.holePoints[k].x, wash.holePoints[k].y);
  const atOrigin = widthAt(0);
  const atAntipode = widthAt(Math.floor(n / 2));
  assert.ok(
    atOrigin > 4 * atAntipode,
    `wash width origin ${atOrigin.toFixed(1)} vs antipode ${atAntipode.toFixed(1)}`,
  );
});
