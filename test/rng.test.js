import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, makeRng } from '../src/rng.js';

test('mulberry32 is deterministic for a given seed', () => {
  const a = mulberry32(1234);
  const b = mulberry32(1234);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
});

test('mulberry32 sequences differ across seeds', () => {
  const a = mulberry32(1);
  const b = mulberry32(2);
  const anyDiffer = Array.from({ length: 20 }, () => a() !== b()).includes(true);
  assert.ok(anyDiffer);
});

test('mulberry32 outputs stay in [0, 1)', () => {
  const r = mulberry32(42);
  for (let i = 0; i < 10000; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1);
  }
});

test('gaussian has ~0 mean and ~1 stddev', () => {
  const rng = makeRng(7);
  const n = 20000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const g = rng.gaussian();
    sum += g;
    sumSq += g * g;
  }
  const mean = sum / n;
  const std = Math.sqrt(sumSq / n - mean * mean);
  assert.ok(Math.abs(mean) < 0.03, `mean ${mean}`);
  assert.ok(Math.abs(std - 1) < 0.03, `std ${std}`);
});

test('uniform(a, b) stays within [a, b)', () => {
  const rng = makeRng(9);
  for (let i = 0; i < 1000; i++) {
    const v = rng.uniform(-3, 5);
    assert.ok(v >= -3 && v < 5);
  }
});
