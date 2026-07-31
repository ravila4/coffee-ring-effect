import test from 'node:test';
import assert from 'node:assert/strict';
import { warpT, warpU, slowMoFactor, radialHistogram, frameIndexFor } from '../src/animate.js';

// rAF timestamps can precede the performance.now() sampled at play(), so the
// playback clock can tick slightly negative; the frame lookup must clamp both
// ends or the first animation frame reads frames[-1] and crashes.
test('frame index clamps playback outside [0,1]', () => {
  assert.equal(frameIndexFor(-0.001, 300), 0);
  assert.equal(frameIndexFor(0, 300), 0);
  assert.equal(frameIndexFor(1, 300), 299);
  assert.equal(frameIndexFor(1.002, 300), 299);
});

test('frame index is monotonic across the playback range', () => {
  let prev = 0;
  for (let u = 0; u <= 1; u += 0.01) {
    const i = frameIndexFor(u, 360);
    assert.ok(i >= prev && i >= 0 && i <= 359);
    prev = i;
  }
});

// --- playback time warp ---
// Radial velocity diverges as 1/(1−t), so playback lingers near dry-out:
// t = 1 − (1−u)^p maps playback fraction u to drying fraction t.

test('warp pins the endpoints', () => {
  assert.equal(warpT(0), 0);
  assert.equal(warpT(1), 1);
  assert.equal(warpU(0), 0);
  assert.equal(warpU(1), 1);
});

test('at p=2 the last quarter of drying gets half the playback', () => {
  assert.ok(Math.abs(warpT(0.5) - 0.75) < 1e-12);
  assert.ok(Math.abs(warpU(0.75) - 0.5) < 1e-12);
});

test('warpU inverts warpT', () => {
  for (let u = 0; u <= 1; u += 0.083) {
    assert.ok(Math.abs(warpU(warpT(u)) - u) < 1e-9, `roundtrip fails at u=${u}`);
  }
});

test('warped time is monotonic in playback', () => {
  let prev = -1;
  for (let u = 0; u <= 1.0001; u += 0.01) {
    const t = warpT(Math.min(u, 1));
    assert.ok(t > prev);
    prev = t;
  }
});

test('slow-mo factor starts at 1 and grows toward dry-out', () => {
  assert.equal(slowMoFactor(0), 1);
  assert.ok(Math.abs(slowMoFactor(0.5) - 2) < 1e-12); // p=2: 1/(1−u)
  assert.ok(Math.abs(slowMoFactor(0.9) - 10) < 1e-9);
});

// --- radial histogram (the "mass migrates to the rim" panel) ---

test('histogram counts only live particles into the right bins', () => {
  const rho = Float64Array.from([0.05, 0.55, 0.95, 0.95, 0.5]);
  const alive = Uint8Array.from([1, 1, 1, 1, 0]);
  const h = radialHistogram(rho, alive, { bins: 10 });
  assert.equal(h.length, 10);
  assert.equal(h[0], 1);
  assert.equal(h[5], 1);
  assert.equal(h[9], 2);
  assert.equal(h.reduce((a, b) => a + b, 0), 4);
});

test('histogram clamps overshoot beyond rho=1 into the last bin', () => {
  const h = radialHistogram(Float64Array.from([1.0, 1.04]), Uint8Array.from([1, 1]), { bins: 4 });
  assert.equal(h[3], 2);
});

test('density mode divides counts by annulus area', () => {
  const rho = Float64Array.from([0.1, 0.9]);
  const alive = Uint8Array.from([1, 1]);
  const h = radialHistogram(rho, alive, { bins: 2, density: true });
  // bin areas ∝ 0.25 and 0.75 of the disk: one particle each → 4 and 4/3.
  assert.ok(Math.abs(h[0] - 4) < 1e-12);
  assert.ok(Math.abs(h[1] - 4 / 3) < 1e-12);
});

test('a uniform disk reads as flat density', () => {
  const n = 20000;
  const rho = new Float64Array(n);
  const alive = new Uint8Array(n).fill(1);
  let x = 12345;
  const rand = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < n; i++) rho[i] = Math.sqrt(rand());
  const h = radialHistogram(rho, alive, { bins: 8, density: true });
  const mean = h.reduce((a, b) => a + b, 0) / h.length;
  for (const v of h) assert.ok(Math.abs(v - mean) / mean < 0.15, `bin off flat: ${v} vs ${mean}`);
});
