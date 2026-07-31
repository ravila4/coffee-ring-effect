import test from 'node:test';
import assert from 'node:assert/strict';
import { radialVelocity, simulateDrop } from '../src/physics.js';
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

test('simulation is deterministic for a given seed', () => {
  const a = simulateDrop({ particles: 300, rng: makeRng(105) });
  const b = simulateDrop({ particles: 300, rng: makeRng(105) });
  assert.deepEqual(a.deposits, b.deposits);
});

test('simulation requires a seeded rng', () => {
  assert.throws(() => simulateDrop({ particles: 10 }));
});
