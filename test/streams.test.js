// A stain is built from several independent random streams: composition
// (what happened on the table), splash (how hard it hit), and one stream per
// simulated component. Splitting them is what makes the demo sliders
// legible — turning the φ knob must change the ring physics and nothing
// else, not re-roll where the satellites landed or whether the cup was set
// down twice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStain } from '../src/stain.js';
import { forkSeed } from '../src/rng.js';

test('forkSeed derives distinct deterministic sub-seeds', () => {
  assert.equal(forkSeed(42, 1), forkSeed(42, 1));
  assert.notEqual(forkSeed(42, 1), forkSeed(42, 2));
  assert.notEqual(forkSeed(42, 1), forkSeed(43, 1));
  assert.notEqual(forkSeed(42, 1), 42);
  const s = forkSeed(0xffffffff, 31);
  assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff, `not a uint32: ${s}`);
});

const mugAB = (phi) =>
  buildStain({
    seed: 909,
    radius: 100,
    particles: 500,
    type: 'mug',
    overlapChance: 1,
    splashEnergy: 300,
    phi,
  });

test('φ is a physics knob on mugs: placements, splash, and satellites hold still', () => {
  const a = mugAB(0.002);
  const b = mugAB(0.03);
  assert.ok(a.satellites.length > 0, 'no satellites at We 300 — test is vacuous');
  assert.deepEqual(a.satellites, b.satellites, 'satellite specs re-rolled with φ');
  assert.deepEqual(a.fingerAzimuths, b.fingerAzimuths, 'fingers re-rolled with φ');
  const bands = (s) => s.washes.filter((w) => w.holePoints);
  assert.ok(bands(a).length >= 2, 'overlapChance 1 should stack placements');
  assert.equal(bands(a).length, bands(b).length, 'overlap count changed with φ');
  // The band contour (width wander, jag, alpha) is drawn before the sim
  // runs, so the wash must be identical point for point.
  assert.deepEqual(bands(a), bands(b), 'band wash geometry re-rolled with φ');
});

test('φ is a physics knob on drops: contact line and satellites hold still', () => {
  const build = (phi) =>
    buildStain({
      seed: 411,
      radius: 100,
      particles: 500,
      type: 'drop',
      splashEnergy: 300,
      phi,
    });
  const a = build(0.002);
  const b = build(0.03);
  assert.ok(a.satellites.length > 0, 'no satellites at We 300 — test is vacuous');
  assert.deepEqual(a.satellites, b.satellites, 'satellite specs re-rolled with φ');
  assert.deepEqual(a.washes[0], b.washes[0], 'parent contact line re-rolled with φ');
});

test('impact energy does not re-roll the composition', () => {
  const build = (We) =>
    buildStain({
      seed: 909,
      radius: 100,
      particles: 500,
      type: 'mug',
      overlapChance: 1,
      splashEnergy: We,
      phi: 0.01,
    });
  const a = build(40);
  const b = build(300);
  const bands = (s) => s.washes.filter((w) => w.holePoints);
  assert.equal(bands(a).length, bands(b).length, 'overlap count changed with We');
  assert.equal(a.splashDir, b.splashDir, 'drip origin moved with We');
  // The inner band edge carries no splash spikes, so it must not move.
  assert.deepEqual(
    bands(a).map((w) => w.holePoints),
    bands(b).map((w) => w.holePoints),
    'inner band edges re-rolled with We',
  );
});

test('φ passed in is the stain φ; left out, it is drawn', () => {
  const base = { seed: 5150, radius: 100, particles: 300, type: 'drop' };
  assert.equal(buildStain({ ...base, phi: 0.011 }).phi, 0.011);
  const drawn = buildStain(base).phi;
  assert.ok(Number.isFinite(drawn) && drawn > 0, `φ was not drawn: ${drawn}`);
});

test('overriding φ at its auto-drawn value reproduces the auto stain exactly', () => {
  const base = { seed: 77, radius: 100, particles: 400, type: 'mug', splashEnergy: 120 };
  const auto = buildStain(base);
  const held = buildStain({ ...base, phi: auto.phi });
  assert.deepEqual(held.splats, auto.splats);
  assert.deepEqual(held.washes, auto.washes);
});

test('overriding We at its auto-drawn value reproduces the auto stain exactly', () => {
  const base = { seed: 78, radius: 100, particles: 400, type: 'drop', phi: 0.01 };
  const auto = buildStain(base);
  const held = buildStain({ ...base, splashEnergy: auto.splashEnergy });
  assert.deepEqual(held.splats, auto.splats);
  assert.deepEqual(held.washes, auto.washes);
});
