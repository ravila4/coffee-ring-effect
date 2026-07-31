import test from 'node:test';
import assert from 'node:assert/strict';
import { makeContactLine } from '../src/contour.js';
import { createNoise2D } from '../src/noise.js';
import { mulberry32, makeRng } from '../src/rng.js';
import { buildStain, fingerCountFor, satelliteSpecsFor, rangeShape, speckCutoff } from '../src/render.js';

const noise2D = createNoise2D(mulberry32(1));
const midRng = { uniform: (a, b) => (a + b) / 2, random: () => 0.5, int: (n) => n >> 1, gaussian: () => 0 };

test('spiked contact line has tips at the spike azimuths and stays periodic', () => {
  const azimuths = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  const line = makeContactLine({
    radius: 100,
    amp: 0.04,
    noise2D,
    offset: 5,
    spikes: { azimuths, amp: 0.3, sharpness: 3 },
  });
  for (const az of azimuths) {
    const tip = line.radiusAt(az);
    const between = line.radiusAt(az + Math.PI / 4);
    assert.ok(tip - between > 0.15 * 100, `no tip at ${az}: ${tip} vs ${between}`);
    assert.ok(line.spikeAt(az) > 0.95, `envelope not 1 at tip`);
    assert.ok(line.spikeAt(az + Math.PI / 4) < 0.05, `envelope not 0 between tips`);
  }
  assert.ok(Math.abs(line.radiusAt(0) - line.radiusAt(2 * Math.PI)) < 1e-9, 'not periodic');
});

test('spike excursion respects the declared bound', () => {
  const line = makeContactLine({
    radius: 100,
    amp: 0.06,
    noise2D,
    offset: 9,
    spikes: { azimuths: [1, 2, 3, 4, 5], amp: 0.25, sharpness: 2.5 },
  });
  for (let k = 0; k < 500; k++) {
    const r = line.radiusAt((k / 500) * 2 * Math.PI);
    assert.ok(r <= line.maxExcursion + 1e-9, `radius ${r} above bound ${line.maxExcursion}`);
  }
});

test('finger count is zero below the splash threshold and grows as √We', () => {
  assert.equal(fingerCountFor(0, midRng), 0);
  assert.equal(fingerCountFor(20, midRng), 0);
  const n60 = fingerCountFor(60, midRng);
  const n300 = fingerCountFor(300, midRng);
  assert.ok(n60 > 0);
  assert.ok(n300 > n60);
  const ratio = n300 / n60;
  assert.ok(ratio > 1.6 && ratio < 2.9, `√5 scaling off: ${ratio}`);
});

test('satellite range peaks at intermediate size: big lands near, specks nearer', () => {
  // Fine ejecta is fastest but drag-arrested (τ_p ∝ r²); big drops are
  // ballistic but slow. The farthest flyers are mid-sized.
  const peak = rangeShape(0.08);
  assert.ok(peak > rangeShape(0.16), 'big secondaries should land short of the peak');
  assert.ok(peak > rangeShape(0.03), 'specks should land short of the peak');
  assert.ok(rangeShape(0.03) < 0.5 * peak, 'speck halo not close-in');
});

test('satellites launch along finger azimuths', () => {
  const fingers = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];
  const rng = makeRng(501);
  const specs = satelliteSpecsFor(300, fingers, rng);
  assert.ok(specs.length >= 4, `too few satellites: ${specs.length}`);
  for (const s of specs) {
    const nearest = Math.min(...fingers.map((f) => Math.abs(s.theta - f)));
    assert.ok(nearest < 0.3, `satellite at ${s.theta} far from all fingers`);
    assert.ok(s.size >= 0.02 && s.size <= 0.17);
    assert.ok(s.dist > 1.05, `satellite inside the parent: ${s.dist}`);
  }
});

test('satellite count grows with impact energy', () => {
  assert.ok(
    satelliteSpecsFor(320, [1, 2, 3], midRng).length > satelliteSpecsFor(60, [1, 2, 3], midRng).length,
  );
});

test('speck cutoff scales as one over root concentration', () => {
  const ratio = speckCutoff(0.0005) / speckCutoff(0.02);
  assert.ok(Math.abs(ratio - Math.sqrt(0.02 / 0.0005)) < 1e-9, `ratio ${ratio}`);
});

test('dilute splashes make speck-only satellites: no satellite washes', () => {
  // Every satellite size (≤ 0.16) sits below speckCutoff(0.0006) ≈ 0.16, so
  // all satellites take the solid-dot path — the only wash is the parent's.
  const stain = buildStain({
    seed: 21,
    radius: 100,
    particles: 600,
    type: 'drop',
    splashEnergy: 350,
    dropOverrides: { phi: 0.0006 },
  });
  assert.equal(stain.washes.length, 1, `expected parent wash only, got ${stain.washes.length}`);
});

test('concentrated splashes ring their satellites (washes appear)', () => {
  const stain = buildStain({
    seed: 22,
    radius: 100,
    particles: 600,
    type: 'drop',
    splashEnergy: 350,
    dropOverrides: { phi: 0.03 },
  });
  assert.ok(stain.washes.length > 1, 'no ringed satellites at high phi');
});

test('washes and splats stay inside the canvas at maximum splash energy', () => {
  const bound = (0.5 / 0.26) * 100;
  for (let seed = 0; seed < 40; seed++) {
    const stain = buildStain({ seed, radius: 100, particles: 400, type: 'drop', splashEnergy: 400 });
    for (const w of stain.washes) {
      for (const p of w.points) {
        assert.ok(Math.hypot(p.x, p.y) <= bound, `seed ${seed}: wash point out of canvas`);
      }
    }
    for (const s of stain.splats) {
      assert.ok(Math.hypot(s.x, s.y) + s.r <= bound, `seed ${seed}: splat out of canvas`);
    }
  }
});

test('splatter build is deterministic per seed', () => {
  const a = buildStain({ seed: 33, radius: 100, particles: 300, type: 'drop', splashEnergy: 200 });
  const b = buildStain({ seed: 33, radius: 100, particles: 300, type: 'drop', splashEnergy: 200 });
  assert.deepEqual(a.splats, b.splats);
  assert.deepEqual(a.washes, b.washes);
});
