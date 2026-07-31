import test from 'node:test';
import assert from 'node:assert/strict';
import { radialVelocity, simulateDrop, simulateRing } from '../src/physics.js';
import { makeRng } from '../src/rng.js';

test('radial velocity vanishes at the drop center', () => {
  assert.equal(radialVelocity(0, 0), 0);
  assert.ok(radialVelocity(1e-9, 0) < 1e-6);
});

test('radial velocity increases monotonically toward the contact line', () => {
  let prev = 0;
  for (let rho = 0.05; rho < 0.995; rho += 0.05) {
    const v = radialVelocity(rho, 0);
    assert.ok(v > prev, `not monotonic at rho=${rho}`);
    prev = v;
  }
});

test('radial velocity diverges near the pinned contact line', () => {
  assert.ok(radialVelocity(0.99999, 0) > 100 * radialVelocity(0.5, 0));
});

test('radial velocity accelerates as the drop dries out', () => {
  assert.ok(radialVelocity(0.5, 0.9) > radialVelocity(0.5, 0));
});

test('every particle ends up deposited (mass conservation)', () => {
  const result = simulateDrop({ particles: 500, rng: makeRng(101) });
  assert.equal(result.deposits.length, 500);
});

test('deposits stay within the drop footprint', () => {
  const { deposits } = simulateDrop({ particles: 800, rng: makeRng(102) });
  for (const d of deposits) {
    assert.ok(d.rho >= 0 && d.rho <= 1 + 1e-9, `rho out of range: ${d.rho}`);
  }
});

test('most mass concentrates at the rim (the coffee-ring effect)', () => {
  const { deposits } = simulateDrop({ particles: 2000, rng: makeRng(103) });
  const rim = deposits.filter((d) => d.rho > 0.9).length;
  assert.ok(rim / deposits.length >= 0.6, `rim fraction ${rim / deposits.length}`);
});

test('stick-slip recession leaves a secondary inner ring', () => {
  const { deposits } = simulateDrop({
    particles: 3000,
    rng: makeRng(104),
    depinSchedule: [{ t: 0.5, jump: 0.12 }],
  });
  const outerRing = deposits.filter((d) => d.rho > 0.95).length;
  const innerRing = deposits.filter((d) => d.rho > 0.82 && d.rho < 0.9).length;
  assert.ok(outerRing > 0, 'no deposits at the original contact line');
  assert.ok(innerRing > 0, 'no deposits at the receded contact line');
});

test('mug-ring sim conserves mass', () => {
  const { deposits } = simulateRing({ particles: 600, rng: makeRng(201) });
  assert.equal(deposits.length, 600);
});

test('mug-ring deposits collect at both band edges', () => {
  // The annular band has pinned contact lines on BOTH sides; evaporation
  // drives particles transversely to whichever edge is nearer.
  const { deposits } = simulateRing({ particles: 3000, rng: makeRng(202) });
  const outer = deposits.filter((d) => d.u > 0.9).length;
  const inner = deposits.filter((d) => d.u < -0.9).length;
  assert.ok((outer + inner) / deposits.length >= 0.55, `edge fraction ${(outer + inner) / deposits.length}`);
  assert.ok(outer / deposits.length >= 0.15, `outer fraction ${outer / deposits.length}`);
  assert.ok(inner / deposits.length >= 0.15, `inner fraction ${inner / deposits.length}`);
});

test('mug-ring deposits stay within the band', () => {
  const { deposits } = simulateRing({ particles: 800, rng: makeRng(203) });
  for (const d of deposits) {
    assert.ok(Math.abs(d.u) <= 1 + 1e-9, `u out of band: ${d.u}`);
  }
});

test('mug-ring sim is deterministic for a given seed', () => {
  const a = simulateRing({ particles: 300, rng: makeRng(204) });
  const b = simulateRing({ particles: 300, rng: makeRng(204) });
  assert.deepEqual(a.deposits, b.deposits);
});

test('mug-ring pinning gate thins unpinned arcs', () => {
  const pinningAt = (theta) => (normalizeTheta(theta) < Math.PI ? 0.02 : 1);
  const { deposits } = simulateRing({ particles: 3000, rng: makeRng(205), pinningAt });
  const edge = deposits.filter((d) => Math.abs(d.u) > 0.9);
  const gap = edge.filter((d) => normalizeTheta(d.theta) < Math.PI).length;
  const pinned = edge.filter((d) => normalizeTheta(d.theta) >= Math.PI).length;
  assert.ok(gap < 0.3 * pinned, `gap arc has ${gap} edge deposits vs ${pinned} pinned`);
});

test('simulation is deterministic for a given seed', () => {
  const a = simulateDrop({ particles: 300, rng: makeRng(105) });
  const b = simulateDrop({ particles: 300, rng: makeRng(105) });
  assert.deepEqual(a.deposits, b.deposits);
});

test('simulation requires a seeded rng', () => {
  assert.throws(() => simulateDrop({ particles: 10 }));
});

const normalizeTheta = (theta) => ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

test('unpinned sectors collect no jammed ring deposits (partial rings)', () => {
  // Pinning fails entirely on the half circle [0, π): that arc must show a
  // gap in the ring while the pinned half still jams particles.
  const pinningAt = (theta) => (normalizeTheta(theta) < Math.PI ? 0 : 1);
  const { deposits } = simulateDrop({ particles: 2000, rng: makeRng(107), pinningAt });
  const jammed = deposits.filter((d) => d.pinned);
  assert.ok(jammed.length > 0, 'no jammed deposits at all');
  const inGap = jammed.filter((d) => normalizeTheta(d.theta) < Math.PI);
  assert.equal(inGap.length, 0, `${inGap.length} jammed deposits inside the unpinned arc`);
});

test('unpinned arcs end up visibly thinner than pinned arcs', () => {
  // Mass arriving at a receding arc must migrate to pinned arcs rather than
  // pile up in place, or the ring gap never shows.
  const pinningAt = (theta) => (normalizeTheta(theta) < Math.PI ? 0.02 : 1);
  const { deposits } = simulateDrop({ particles: 3000, rng: makeRng(109), pinningAt });
  const rim = deposits.filter((d) => d.rho > 0.9);
  const gap = rim.filter((d) => normalizeTheta(d.theta) < Math.PI).length;
  const pinned = rim.filter((d) => normalizeTheta(d.theta) >= Math.PI).length;
  assert.ok(gap < 0.3 * pinned, `gap arc has ${gap} rim deposits vs ${pinned} on the pinned arc`);
});

test('mass is conserved with a pinning gate', () => {
  const pinningAt = (theta) => (normalizeTheta(theta) < Math.PI ? 0 : 1);
  const { deposits } = simulateDrop({ particles: 800, rng: makeRng(108), pinningAt });
  assert.equal(deposits.length, 800);
});
