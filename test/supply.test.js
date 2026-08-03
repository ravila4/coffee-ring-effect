import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSupplySampler } from '../src/physics.js';
import { buildStain } from '../src/stain.js';
import { makeRng } from '../src/rng.js';
import { circDist } from './helpers.js';

// The drip may run down the rim at more than one point. Each stream carries
// its own volume (weight), so the supply is a list of lobes: big and small
// arcs that merge where they touch and leave dry gaps where they don't.

const TWO_LOBES = [
  { originTheta: 0, arcHalfLength: 0.4 * Math.PI, falloff: 1, weight: 1 },
  { originTheta: Math.PI, arcHalfLength: 0.4 * Math.PI, falloff: 1, weight: 0.25 },
];

test('two disjoint lobes wet two arcs and leave two dry gaps', () => {
  const s = makeSupplySampler(TWO_LOBES);
  assert.ok(s.massAt(0) > 0, 'primary lobe dry');
  assert.ok(s.massAt(Math.PI) > 0, 'secondary lobe dry');
  assert.equal(s.massAt(0.5 * Math.PI), 0, 'gap between lobes is wet');
  assert.equal(s.massAt(1.5 * Math.PI), 0, 'far gap is wet');
});

test('weight is the volume knob: relative density scales with it', () => {
  const s = makeSupplySampler(TWO_LOBES);
  // Same lobe shape, weights 1 vs 0.25: density ratio is exactly the
  // weight ratio (both share one normalization).
  const ratio = s.relDensityAt(0) / s.relDensityAt(Math.PI);
  assert.ok(Math.abs(ratio - 4) < 1e-9, `density ratio ${ratio}, want 4`);
});

test('samples split across lobes in proportion to their volumes', () => {
  const lobes = [
    { originTheta: 0, arcHalfLength: 0.4 * Math.PI, falloff: 1, weight: 1 },
    { originTheta: Math.PI, arcHalfLength: 0.4 * Math.PI, falloff: 1, weight: 0.5 },
  ];
  const s = makeSupplySampler(lobes);
  const rng = makeRng(501);
  const n = 20000;
  let primary = 0;
  for (let i = 0; i < n; i++) {
    const theta = s.sample(rng);
    const inA = circDist(theta, 0) <= 0.4 * Math.PI + 0.004;
    const inB = circDist(theta, Math.PI) <= 0.4 * Math.PI + 0.004;
    assert.ok(inA || inB, `sample ${theta} landed in a dry gap`);
    if (inA) primary++;
  }
  // Identical shapes, weights 1 : 0.5 → shares 2/3 : 1/3.
  const share = primary / n;
  assert.ok(Math.abs(share - 2 / 3) < 0.02, `primary share ${share.toFixed(3)}`);
});

test('touching lobes merge into one lopsided wetted arc', () => {
  const s = makeSupplySampler([
    { originTheta: 0, arcHalfLength: 0.6 * Math.PI, falloff: 1, weight: 1 },
    { originTheta: Math.PI, arcHalfLength: 0.6 * Math.PI, falloff: 1, weight: 0.4 },
  ]);
  // Reaches overlap (0.6π + 0.6π > π): no dry point anywhere.
  for (let k = 0; k < 64; k++) {
    const theta = (k / 64) * 2 * Math.PI;
    assert.ok(s.massAt(theta) > 0, `dry point at ${theta.toFixed(2)}`);
  }
  // Density in the overlap seam is the sum, not a dip to zero.
  assert.ok(s.massAt(0.5 * Math.PI) > 0);
});

test('a two-drip mug washes as a disconnected donut: exactly two gap arcs', () => {
  const stain = buildStain({
    seed: 21,
    radius: 100,
    particles: 800,
    type: 'mug',
    partialChance: 0,
    overlapChance: 0,
    splashEnergy: 2,
    mugSupply: [
      { originTheta: 0, arcHalfLength: 0.45 * Math.PI, falloff: 1, weight: 1 },
      { originTheta: Math.PI, arcHalfLength: 0.45 * Math.PI, falloff: 1, weight: 0.35 },
    ],
  });
  const wash = stain.washes[0];
  assert.ok(wash.holePoints, 'mug wash must be an annulus');
  const n = wash.points.length;
  const widths = Array.from({ length: n }, (_, k) =>
    Math.hypot(wash.points[k].x, wash.points[k].y) -
    Math.hypot(wash.holePoints[k].x, wash.holePoints[k].y),
  );
  const gap = widths.map((w) => w < 1e-9);
  let gapRuns = 0;
  for (let k = 0; k < n; k++) if (gap[k] && !gap[(k + n - 1) % n]) gapRuns++;
  assert.equal(gapRuns, 2, `expected 2 dry arcs, found ${gapRuns}`);
});

test('multi-drip draw yields a big primary and smaller extras', () => {
  for (const seed of [31, 32, 33, 34, 35]) {
    const stain = buildStain({
      seed,
      radius: 100,
      particles: 400,
      type: 'mug',
      overlapChance: 0,
      multiDripChance: 1,
    });
    assert.ok(stain.supply.length >= 2, `seed ${seed}: only ${stain.supply.length} lobe(s)`);
    assert.equal(stain.supply[0].weight, 1);
    for (const lobe of stain.supply.slice(1)) {
      assert.ok(lobe.weight < 1, 'extra drip should carry less volume than the primary');
      assert.ok(lobe.arcHalfLength < stain.supply[0].arcHalfLength * 4, 'runaway extra reach');
    }
  }
});

// A lobe list that carries no coffee has no profile to sample: the CDF
// normalizes by total mass, so these are rejected at construction rather than
// left to come back as silent NaN density.

test('a supply with no lobes is rejected', () => {
  assert.throws(() => makeSupplySampler([]), /lobe/);
});

test('lobe reach and volume must be finite and positive', () => {
  for (const bad of [0, -1, NaN, Infinity]) {
    assert.throws(
      () => makeSupplySampler([{ originTheta: 0, arcHalfLength: bad, weight: 1 }]),
      /arcHalfLength/,
      `arcHalfLength ${bad} was accepted`,
    );
    assert.throws(
      () => makeSupplySampler([{ originTheta: 0, arcHalfLength: 1, weight: bad }]),
      /weight/,
      `weight ${bad} was accepted`,
    );
  }
});

test('lobe origin and falloff must be finite', () => {
  // A NaN in either poisons the CDF into all-NaN, which the zero-mass guard
  // cannot see: NaN <= 0 is false, so the sampler would hand back NaN density.
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => makeSupplySampler([{ originTheta: bad, arcHalfLength: 1, falloff: 1 }]),
      /originTheta/,
      `originTheta ${bad} was accepted`,
    );
  }
  for (const bad of [0, -1, NaN, Infinity]) {
    assert.throws(
      () => makeSupplySampler([{ originTheta: 0, arcHalfLength: 1, falloff: bad }]),
      /falloff/,
      `falloff ${bad} was accepted`,
    );
  }
});

test('a supply too narrow to carry any mass is rejected', () => {
  // Positive but far below the CDF grid spacing: every bin integrates to zero.
  assert.throws(() => makeSupplySampler([{ originTheta: 0, arcHalfLength: 1e-6 }]), /mass/);
});

test('a valid supply still samples after the guards', () => {
  const s = makeSupplySampler(TWO_LOBES);
  assert.ok(s.relDensityAt(0) > 0);
  const theta = s.sample(makeRng(9));
  assert.ok(Number.isFinite(theta) && theta >= 0 && theta <= 2 * Math.PI);
  // The documented default is a single uniform-ish lobe with no arguments.
  assert.ok(makeSupplySampler().relDensityAt(0) > 0);
});

test('drops carry no drip supply', () => {
  const stain = buildStain({ seed: 41, radius: 100, particles: 300, type: 'drop' });
  assert.equal(stain.supply, null);
});
