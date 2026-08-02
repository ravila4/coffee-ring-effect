import test from 'node:test';
import assert from 'node:assert/strict';
import { scaleStain } from '../src/stain.js';
import { paintStain } from '../src/render.js';
import { createStain, paintStains } from '../src/coffee-stains.js';

// A context that records the circles it is asked to draw. Splat geometry is
// the whole subject here, so arcs are the only calls worth keeping.
const arcRecorder = () => {
  const arcs = [];
  const ctx = {
    canvas: { width: 600, height: 600 },
    fillStyle: '',
    globalAlpha: 1,
    globalCompositeOperation: '',
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    fill() {},
    fillRect() {},
    arc: (x, y, r) => arcs.push(r),
  };
  return { ctx, arcs };
};

const relClose = (a, b, rtol, what) =>
  assert.ok(
    Math.abs(a - b) <= rtol * Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE),
    `${what}: ${a} vs ${b} (rel ${Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b))})`,
  );

// The size laws as they stand before any grain knob exists: the reference a
// default paint must keep reproducing.
const PLAIN_LAWS = {
  grain: (r, radius) => Math.max(0.8, radius * 0.016) * r,
  speck: (r, radius) => Math.max(0.5, radius * r),
  droplet: (r, radius) => radius * r,
};

// A gentle droplet throws no satellites, so every splat is grain-law: ratios
// between two paints of it are not diluted by speck or droplet geometry.
const dropletSpec = { type: 'drop', seed: 7, phi: 0.012, particles: 1800, splashEnergy: 0 };
// A mug at a fair particle count carries the mixed populations — grain, the
// structural splats that paint at rInk, and a handful of trail specks.
const mugSpec = { type: 'mug', seed: 42, phi: 0.008, particles: 2000, splashEnergy: 260 };

// Ink is area times alpha. Summed over the grain-law splats it is the quantity
// every claim below is about, so it gets computed one way only.
const grainInk = (unit, scaled, key = 'r') => {
  let sum = 0;
  unit.splats.forEach((u, i) => {
    if (u.sizing !== 'grain') return;
    const s = scaled.splats[i];
    const radius = key === 'rInk' ? (s.rInk ?? s.r) : s.r;
    sum += s.alpha * radius * radius;
  });
  return sum;
};

test('at radius 50 and up a default paint is the plain size laws, untouched', () => {
  const stain = createStain(mugSpec);
  const bare = scaleStain(stain, 172);
  const empty = scaleStain(stain, 172, {});

  stain.splats.forEach((u, i) => {
    const a = bare.splats[i];
    const b = empty.splats[i];
    assert.deepEqual(a, b, `splat ${i}: an empty options object was not a no-op`);
    assert.equal(a.r, PLAIN_LAWS[u.sizing](u.r, 172), `splat ${i} (${u.sizing}): r moved`);
    if (u.rInk !== undefined) {
      assert.equal(a.rInk, PLAIN_LAWS[u.sizing](u.rInk, 172), `splat ${i} (${u.sizing}): rInk moved`);
    }
    if (u.sizing === 'grain') {
      assert.equal(a.alpha, u.alpha, `grain splat ${i}: alpha moved at a radius the floor cannot reach`);
      // The un-overridden law is recorded even when nothing overrode it.
      assert.equal(a.rDefault, a.r, `grain splat ${i}: rDefault disagrees with r at default grain`);
    }
    if (u.sizing === 'droplet' || (u.sizing === 'speck' && 172 * u.r >= 0.5)) {
      assert.equal(a.alpha, u.alpha, `splat ${i} (${u.sizing}): alpha moved with no floor in play`);
    }
  });
});

test('a stain painted small keeps its ink density instead of saturating', () => {
  const stain = createStain(dropletSpec);
  const density = (radius) => grainInk(stain, scaleStain(stain, radius)) / (radius * radius);
  const reference = density(172);
  for (const radius of [9, 29, 172]) {
    relClose(density(radius), reference, 1e-6, `density at radius ${radius}`);
  }
});

test('choosing a grain size moves the flecks, not the ink', () => {
  const stain = createStain(dropletSpec);
  const reference = grainInk(stain, scaleStain(stain, 172));
  for (const grain of [4, 6]) {
    const coarse = scaleStain(stain, 172, { grain });
    assert.equal(coarse.splats[0].r, grain * stain.splats[0].r, `grain ${grain} did not set the fleck size`);
    relClose(grainInk(stain, coarse), reference, 1e-9, `ink at grain ${grain}`);
  }
  // Grain far below the default cannot conserve ink — there is no alpha above
  // opaque to spend — so it clamps rather than emitting nonsense.
  const fine = scaleStain(stain, 172, { grain: 0.8 });
  for (const s of fine.splats) {
    assert.ok(Number.isFinite(s.alpha) && s.alpha <= 1, `alpha ${s.alpha} is not a usable opacity`);
  }
});

test('a structural splat conserves the ink it paints with, not just the ink it is sized by', () => {
  const stain = createStain(dropletSpec);
  const index = stain.splats.findIndex(
    (s) => s.sizing === 'grain' && s.rInk !== undefined && s.rInk !== s.r,
  );
  assert.ok(index >= 0, 'no splat paints at a radius other than its own');
  const inkOf = (options) => {
    const s = scaleStain(stain, 172, options).splats[index];
    return { r: s.r, byR: s.alpha * s.r ** 2, byInk: s.alpha * (s.rInk ?? s.r) ** 2 };
  };
  const reference = inkOf(undefined);
  for (const grain of [4, 6]) {
    const got = inkOf({ grain });
    assert.equal(got.r, grain * stain.splats[index].r, `grain ${grain} did not resize splat ${index}`);
    relClose(got.byR, reference.byR, 1e-9, `splat ${index} ink by r at grain ${grain}`);
    relClose(got.byInk, reference.byInk, 1e-9, `splat ${index} ink by rInk at grain ${grain}`);
  }
});

test('a speck held up by the pixel floor pays for the area it did not earn', () => {
  const unit = {
    splats: [
      { x: 0.1, y: 0, sizing: 'speck', r: 0.001, alpha: 0.1, color: [0, 0, 0] },
      { x: 0.2, y: 0, sizing: 'speck', r: 0.02, alpha: 0.1, color: [0, 0, 0] },
    ],
    washes: [],
  };
  const [floored, clear] = scaleStain(unit, 100).splats;
  assert.equal(floored.r, 0.5, 'the floored speck did not land on the floor');
  relClose(floored.alpha, 0.1 * (0.1 / 0.5) ** 2, 1e-12, 'floored speck alpha');
  assert.equal(clear.r, 2, 'the clear speck was resized');
  assert.equal(clear.alpha, 0.1, 'the clear speck was faded for no reason');
  // The knob is about pigment resolution; a ligament fragment has a size.
  assert.deepEqual(scaleStain(unit, 100, { grain: 5 }).splats, scaleStain(unit, 100).splats);
});

test('the dark-field instrument keeps its dot geometry when grain is retuned', () => {
  const stain = createStain(dropletSpec);
  const painted = (options, renderOptions) => {
    const { ctx, arcs } = arcRecorder();
    paintStain(ctx, scaleStain(stain, 172, options), renderOptions);
    return arcs;
  };
  // The knob has to be live, or invariance below would prove nothing.
  assert.notDeepEqual(
    painted({ grain: 3 }, {}),
    painted(undefined, {}),
    'grain did not reach the painted splats at all',
  );
  const reference = painted(undefined, { darkField: true });
  assert.deepEqual(painted({ grain: 3 }, { darkField: true }), reference, 'dark-field dots shifted');
  // And the reference is still the plain law, not merely self-consistent.
  const expected = stain.splats.map((s) => Math.max(0.55, PLAIN_LAWS[s.sizing](s.r, 172) * 0.25));
  assert.deepEqual(reference, expected, 'dark-field dots left the deposit-grain scale');
});

test('a placement picks its own grain over the one the call set', () => {
  const stain = createStain(dropletSpec);
  const { ctx, arcs } = arcRecorder();
  const count = stain.splats.length;
  paintStains(
    ctx,
    [
      { stain, x: 0, y: 0, radius: 172, grain: 2 },
      { stain, x: 300, y: 0, radius: 172 },
    ],
    { grain: 6 },
  );
  assert.equal(arcs.length, 2 * count, 'both placements did not paint every splat');
  const overridden = arcs.slice(0, count);
  const inherited = arcs.slice(count);
  stain.splats.forEach((u, i) => {
    relClose(overridden[i], 2 * (u.rInk ?? u.r), 1e-12, `splat ${i} under the placement's grain`);
    relClose(inherited[i], 6 * (u.rInk ?? u.r), 1e-12, `splat ${i} under the call's grain`);
  });
});
