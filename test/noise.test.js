import test from 'node:test';
import assert from 'node:assert/strict';
import { createNoise2D, fbm } from '../src/noise.js';
import { mulberry32 } from '../src/rng.js';

test('noise2D is deterministic for a given seed', () => {
  const a = createNoise2D(mulberry32(11));
  const b = createNoise2D(mulberry32(11));
  for (let i = 0; i < 200; i++) {
    const x = i * 0.173;
    const y = i * -0.311;
    assert.equal(a(x, y), b(x, y));
  }
});

test('noise2D differs across seeds', () => {
  const a = createNoise2D(mulberry32(1));
  const b = createNoise2D(mulberry32(2));
  const anyDiffer = Array.from({ length: 50 }, (_, i) => a(i * 0.37, i * 0.53) !== b(i * 0.37, i * 0.53)).includes(true);
  assert.ok(anyDiffer);
});

test('noise2D output stays within [-1, 1]', () => {
  const noise = createNoise2D(mulberry32(3));
  const r = mulberry32(4);
  for (let i = 0; i < 20000; i++) {
    const v = noise(r() * 100 - 50, r() * 100 - 50);
    assert.ok(v >= -1 && v <= 1, `out of range: ${v}`);
  }
});

test('noise2D is continuous (small input step gives small output step)', () => {
  const noise = createNoise2D(mulberry32(5));
  const r = mulberry32(6);
  const eps = 1e-4;
  for (let i = 0; i < 2000; i++) {
    const x = r() * 20 - 10;
    const y = r() * 20 - 10;
    assert.ok(Math.abs(noise(x + eps, y) - noise(x, y)) < 0.02);
    assert.ok(Math.abs(noise(x, y + eps) - noise(x, y)) < 0.02);
  }
});

test('fbm output stays within [-1, 1]', () => {
  const noise = createNoise2D(mulberry32(7));
  const r = mulberry32(8);
  for (let i = 0; i < 5000; i++) {
    const v = fbm(noise, r() * 20 - 10, r() * 20 - 10, { octaves: 4 });
    assert.ok(v >= -1 && v <= 1, `out of range: ${v}`);
  }
});

test('fbm with one octave equals base noise', () => {
  const noise = createNoise2D(mulberry32(9));
  for (let i = 0; i < 100; i++) {
    const x = i * 0.21;
    const y = i * 0.19;
    assert.equal(fbm(noise, x, y, { octaves: 1 }), noise(x, y));
  }
});
