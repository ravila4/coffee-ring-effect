import test from 'node:test';
import assert from 'node:assert/strict';
import { makeContactLine } from '../src/contour.js';
import { createNoise2D } from '../src/noise.js';
import { mulberry32 } from '../src/rng.js';

const noise = () => createNoise2D(mulberry32(21));

test('contact line closes seamlessly (radius is 2π-periodic)', () => {
  const line = makeContactLine({ radius: 100, amp: 0.08, freq: 1.5, noise2D: noise() });
  for (let i = 0; i < 32; i++) {
    const theta = (i / 32) * 2 * Math.PI;
    const diff = Math.abs(line.radiusAt(theta) - line.radiusAt(theta + 2 * Math.PI));
    assert.ok(diff < 1e-6, `seam at theta=${theta}: ${diff}`);
  }
});

test('radius deviation is bounded by amp fraction', () => {
  const R = 100;
  const amp = 0.08;
  const line = makeContactLine({ radius: R, amp, freq: 2, noise2D: noise() });
  for (let i = 0; i < 720; i++) {
    const r = line.radiusAt((i / 720) * 2 * Math.PI);
    assert.ok(Math.abs(r / R - 1) <= amp + 1e-9, `deviation ${r / R - 1}`);
  }
});

test('contact line is deterministic for a given noise field', () => {
  const a = makeContactLine({ radius: 80, amp: 0.05, freq: 1.8, noise2D: noise() });
  const b = makeContactLine({ radius: 80, amp: 0.05, freq: 1.8, noise2D: noise() });
  for (let i = 0; i < 100; i++) {
    const theta = (i / 100) * 2 * Math.PI;
    assert.equal(a.radiusAt(theta), b.radiusAt(theta));
  }
});

test('offset decorrelates two contact lines sharing one noise field', () => {
  const shared = noise();
  const a = makeContactLine({ radius: 80, amp: 0.05, freq: 1.8, noise2D: shared, offset: 0 });
  const b = makeContactLine({ radius: 80, amp: 0.05, freq: 1.8, noise2D: shared, offset: 37 });
  const anyDiffer = Array.from({ length: 50 }, (_, i) => {
    const theta = (i / 50) * 2 * Math.PI;
    return a.radiusAt(theta) !== b.radiusAt(theta);
  }).includes(true);
  assert.ok(anyDiffer);
});

test('default sample count scales with radius', () => {
  // A bigger circle needs more samples to hold the same arc-length detail.
  // How many per unit radius is the sampler's business, not the caller's.
  const countAt = (radius) =>
    makeContactLine({ radius, amp: 0.05, freq: 2, noise2D: noise() }).points().length;
  const small = countAt(50);
  const big = countAt(100);
  assert.ok(small > 8, `too few samples to describe a closed loop: ${small}`);
  assert.ok(big > small, `sample count did not grow with radius: ${small} -> ${big}`);
});

test('sampled points lie on the contact line', () => {
  const line = makeContactLine({ radius: 60, amp: 0.07, freq: 2, noise2D: noise() });
  const pts = line.points(64);
  pts.forEach((p, k) => {
    const theta = (k / 64) * 2 * Math.PI;
    const r = Math.hypot(p.x, p.y);
    assert.ok(Math.abs(r - line.radiusAt(theta)) < 1e-9);
  });
});
