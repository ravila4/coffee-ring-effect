import test from 'node:test';
import assert from 'node:assert/strict';
import { makeContactLine, makeSpikeField } from '../src/contour.js';
import { createNoise2D } from '../src/noise.js';
import { mulberry32, makeRng } from '../src/rng.js';
import {
  buildStain,
  fingerCountFor,
  satelliteSpecsFor,
  rangeShape,
  speckCutoff,
  splatStyleFor,
  trailSpecsFor,
  DEFAULT_RADIUS_FRACTION,
} from '../src/stain.js';

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

test('spike field is reusable outside a contact line', () => {
  const field = makeSpikeField({ azimuths: [1, 2], amps: [1, 0.5], amp: 0.2, sharpness: 3 });
  assert.ok(Math.abs(field.at(1) - 0.2) < 1e-12, 'full-strength tip');
  assert.ok(Math.abs(field.at(2) - 0.1) < 1e-12, 'half-strength tip');
  assert.equal(field.at(1 + Math.PI), 0, 'zero between fingers');
  assert.ok(Math.abs(field.envelopeAt(1) - 1) < 1e-12, 'envelope 1 at strongest tip');
  assert.ok(Math.abs(field.maxAmp - 0.2) < 1e-12);
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

test('satellite reach scales with the canvas bound', () => {
  const maxDist = (bound) =>
    Math.max(...satelliteSpecsFor(320, [1], midRng, { bound }).map((s) => s.dist));
  const tight = maxDist(0.5 / DEFAULT_RADIUS_FRACTION);
  const roomy = maxDist(0.5 / 0.18);
  assert.ok(roomy > tight + 0.5, `no extra reach: ${tight} vs ${roomy}`);
});

test('sub-splash dribbles aim at the drip origin when given one', () => {
  const rng = makeRng(77);
  for (let k = 0; k < 20; k++) {
    for (const s of satelliteSpecsFor(25, [], rng, { scatterDir: 1.0 })) {
      assert.ok(Math.abs(s.theta - 1.0) < 2.0, `dribble at ${s.theta} ignores the drip`);
    }
  }
});

test('ligament trails dot the flight line between rim and landing', () => {
  const spec = { size: 0.08, theta: 1.2, dist: 2.4 };
  const specks = trailSpecsFor(spec, makeRng(88));
  assert.ok(specks.length >= 4, `trail too sparse: ${specks.length}`);
  for (const p of specks) {
    assert.ok(p.dist > 1.02 && p.dist < 2.4 - 0.08, `speck at ${p.dist} off the flight line`);
    assert.ok(Math.abs(p.theta - 1.2) < 0.15, `speck at theta ${p.theta} off azimuth`);
    assert.ok(p.size < spec.size, 'trail droplets must be smaller than the satellite');
  }
});

test('no trail when the satellite lands at the rim', () => {
  assert.equal(trailSpecsFor({ size: 0.12, theta: 0, dist: 1.15 }, makeRng(1)).length, 0);
});

test('longer flights leave longer trails', () => {
  const n = (dist) => trailSpecsFor({ size: 0.06, theta: 0, dist }, midRng).length;
  assert.ok(n(2.6) > n(1.7), 'trail length must grow with the gap');
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
    phi: 0.0006,
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
    phi: 0.03,
  });
  assert.ok(stain.washes.length > 1, 'no ringed satellites at high phi');
});

test('washes and splats stay inside the canvas at maximum splash energy', () => {
  const bound = (0.5 / DEFAULT_RADIUS_FRACTION) * 100;
  for (let seed = 0; seed < 12; seed++) {
    const stain = buildStain({
      seed,
      radius: 100,
      particles: 400,
      type: seed % 2 ? 'mug' : 'drop',
      splashEnergy: 400,
    });
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

test('a smaller drawn-radius fraction opens usable splatter headroom', () => {
  const bound = (0.5 / 0.18) * 100;
  let farthest = 0;
  for (let seed = 0; seed < 12; seed++) {
    const stain = buildStain({
      seed,
      radius: 100,
      particles: 400,
      type: 'drop',
      splashEnergy: 400,
      canvasBound: 0.5 / 0.18,
    });
    for (const w of stain.washes) {
      for (const p of w.points) {
        assert.ok(Math.hypot(p.x, p.y) <= bound, `seed ${seed}: wash point out of canvas`);
      }
    }
    for (const s of stain.splats) {
      const reach = Math.hypot(s.x, s.y) + s.r;
      assert.ok(reach <= bound, `seed ${seed}: splat out of canvas`);
      farthest = Math.max(farthest, reach);
    }
  }
  assert.ok(
    farthest > (0.5 / DEFAULT_RADIUS_FRACTION) * 100,
    `headroom unused: farthest splat at ${farthest}`,
  );
});

test('mug splash rides the drip origin', () => {
  const stain = buildStain({
    seed: 5,
    radius: 100,
    particles: 600,
    type: 'mug',
    overlapChance: 0,
    splashEnergy: 300,
    mugSupply: [{ originTheta: 2.2, arcHalfLength: 0.9 * Math.PI, falloff: 1 }],
  });
  assert.equal(stain.splashDir, 2.2);
  assert.ok(stain.fingerAzimuths.length >= 2, 'mug at We 300 must finger');
  for (const az of stain.fingerAzimuths) {
    assert.ok(Math.abs(az - 2.2) < 1.0, `finger at ${az} far from the drip`);
  }
});

test('drop fingers span the rim; mug fingers stay in a fan', () => {
  const spread = (azs) => Math.max(...azs) - Math.min(...azs);
  const drop = buildStain({ seed: 11, radius: 100, particles: 300, type: 'drop', splashEnergy: 300 });
  const mug = buildStain({
    seed: 11,
    radius: 100,
    particles: 300,
    type: 'mug',
    overlapChance: 0,
    splashEnergy: 300,
  });
  assert.ok(spread(drop.fingerAzimuths) > Math.PI, 'drop crown should ring the rim');
  assert.ok(spread(mug.fingerAzimuths) < 1.3, `mug fan too wide: ${spread(mug.fingerAzimuths)}`);
});

test('the splash bulges the band outer edge at the drip azimuth', () => {
  const stain = buildStain({
    seed: 3,
    radius: 100,
    particles: 500,
    type: 'mug',
    overlapChance: 0,
    partialChance: 0,
    splashEnergy: 300,
    mugSupply: [{ originTheta: 0, arcHalfLength: 4 * Math.PI, falloff: 1 }],
  });
  const near = [];
  const far = [];
  for (const p of stain.washes[0].points) {
    const d = Math.abs(Math.atan2(p.y, p.x));
    if (d < 0.7) near.push(Math.hypot(p.x, p.y));
    else if (d > 1.5) far.push(Math.hypot(p.x, p.y));
  }
  const bulge = Math.max(...near) - Math.max(...far);
  assert.ok(bulge > 3, `no outer-edge bulge at the drip: ${bulge.toFixed(1)}`);
});

test('set-down mugs sometimes splash', () => {
  let splashed = 0;
  let gentle = 0;
  // A fixed-seed pin on the We draw, not a statistical claim: seeds 0..14
  // give 3 splashed / 12 gentle, and any deliberate stream reassignment
  // re-rolls these counts and re-opens the thresholds anyway.
  for (let seed = 0; seed < 15; seed++) {
    const s = buildStain({ seed, radius: 100, particles: 200, type: 'mug' });
    if (s.splashEnergy > 30) splashed++;
    else gentle++;
  }
  assert.ok(splashed >= 2, `only ${splashed}/15 mugs splashed`);
  assert.ok(gentle >= 8, `only ${gentle}/15 mugs stayed gentle`);
});

test('splatter build is deterministic per seed', () => {
  const a = buildStain({ seed: 33, radius: 100, particles: 300, type: 'drop', splashEnergy: 200 });
  const b = buildStain({ seed: 33, radius: 100, particles: 300, type: 'drop', splashEnergy: 200 });
  assert.deepEqual(a.splats, b.splats);
  assert.deepEqual(a.washes, b.washes);
});

test('structural deposits paint sharper and darker than dots and residue', () => {
  const spoke = splatStyleFor({ pinned: false, sink: 'spoke' });
  const arc = splatStyleFor({ pinned: false, sink: 'arc' });
  const dot = splatStyleFor({ pinned: false, sink: 'dot' });
  const residue = splatStyleFor({ pinned: false });
  const pinned = splatStyleFor({ pinned: true });
  for (const structural of [spoke, arc]) {
    assert.ok((structural.rInk ?? structural.r) < dot.r, 'structure must be smaller than speckle');
    assert.ok(structural.aLo > dot.aHi, 'structure must out-darken speckle outright');
  }
  assert.deepEqual(residue, dot);
  // Per-splat painted ink (alpha × footprint area): the rim stays the
  // heaviest population even though line splats carry higher raw alpha —
  // their footprint is much smaller.
  const inkOf = (s) => s.aHi * (s.rInk ?? s.r) ** 2;
  assert.ok(inkOf(pinned) >= inkOf(spoke), 'rim mass stays the darkest population');
});

test('tracer count is a resolution knob: painted ink mass stays put', () => {
  // Total pigment is set by phi, not by how many tracers discretize it, so
  // per-splat alpha must scale inversely with the tracer budget — otherwise
  // a high-resolution render paints a darker stain of the same coffee.
  const ink = (particles) => {
    const stain = buildStain({ seed: 5, radius: 100, particles, type: 'drop', splashEnergy: 0 });
    return stain.splats.reduce((t, s) => t + s.alpha * (s.rInk ?? s.r) ** 2, 0);
  };
  const ratio = ink(14000) / ink(3500);
  assert.ok(ratio > 0.75 && ratio < 1.35, `ink mass scaled with tracer count: ratio ${ratio.toFixed(2)}`);
});
