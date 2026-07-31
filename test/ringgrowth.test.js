import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRingGrowth, eq3Width, depinOnset } from '../src/physics.js';

// The Appendix ODE pair (Deegan PRE 61, 475 (2000), Eqs. A6-A7) in
// epoch-normalized variables: x = 4w/R, y = 4h/(θ·R), τ ∈ [0,1).

const integrateTo = (growth, tauEnd, dtau = 1e-4) => {
  while (growth.tau < tauEnd && !growth.done) growth.step(dtau);
  return growth;
};

test('integrator matches Eq. 3 in the small-τ limit (the wedge asymptote)', () => {
  const g = integrateTo(makeRingGrowth({ phi: 0.01 }), 0.005, 1e-5);
  const w = g.x / 4;
  const wedge = eq3Width(0.01, g.tau);
  assert.ok(Math.abs(w / wedge - 1) < 0.01, `w/eq3 = ${w / wedge}`);
});

test('height tracks width early: y ≈ x while Θ ≈ θ0', () => {
  const g = integrateTo(makeRingGrowth({ phi: 0.01 }), 0.005, 1e-5);
  assert.ok(Math.abs(g.y / g.x - 1) < 0.02, `y/x = ${g.y / g.x}`);
});

test('Appendix ring is strictly wider than Eq. 3 away from τ=0', () => {
  // The Appendix's physical content: Eq. 3 underestimates ring growth because
  // the true cross-section is not a wedge. Ratio grows with τ.
  const g = makeRingGrowth({ phi: 0.01 });
  integrateTo(g, 0.5, 1e-4);
  const ratioHalf = g.x / 4 / eq3Width(0.01, g.tau);
  assert.ok(ratioHalf > 1.05 && ratioHalf < 1.15, `ratio at τ=0.5: ${ratioHalf}`);
  integrateTo(g, 0.8, 1e-4);
  const ratioLate = g.x / 4 / eq3Width(0.01, g.tau);
  assert.ok(ratioLate > ratioHalf, `ratio must grow: ${ratioLate} vs ${ratioHalf}`);
});

test('surface-angle ratio decreases strictly, slope at most −1', () => {
  // d(Θ/θ)/dτ = −1 − dy/dτ ≤ −1 while Θ ≥ 0: a theorem of the ODE pair.
  const g = makeRingGrowth({ phi: 0.01 });
  const dtau = 1e-3;
  g.step(dtau);
  let prev = g.thetaRatio;
  for (let i = 0; i < 500 && !g.done; i++) {
    g.step(dtau);
    assert.ok(g.thetaRatio <= prev - dtau + 1e-12, `slope > −1 at τ=${g.tau}`);
    prev = g.thetaRatio;
  }
});

test('ring width grows monotonically', () => {
  const g = makeRingGrowth({ phi: 0.005 });
  const dtau = 1e-3;
  g.step(dtau);
  let prev = g.x;
  for (let i = 0; i < 800 && !g.done; i++) {
    g.step(dtau);
    assert.ok(g.x >= prev, `x shrank at τ=${g.tau}`);
    prev = g.x;
  }
});

test('epoch terminates when the ring meets the liquid surface (Θ → 0)', () => {
  // At high φ the guard must fire before τ = 1 — Θ would go negative
  // otherwise (ring taller than the liquid).
  const g = makeRingGrowth({ phi: 0.03 });
  const dtau = 1e-4;
  for (let i = 0; i < 2e4 && !g.done; i++) g.step(dtau);
  assert.ok(g.done, 'never terminated');
  assert.ok(g.tau < 1, `ran to τ=${g.tau}`);
  assert.ok(g.thetaRatio <= 1e-3, `Θ ratio at stop: ${g.thetaRatio}`);
  const before = { x: g.x, y: g.y, tau: g.tau };
  g.step(dtau); // stepping past done is a no-op
  assert.deepEqual({ x: g.x, y: g.y, tau: g.tau }, before);
});

test('width growth accelerates with concentration', () => {
  const lo = integrateTo(makeRingGrowth({ phi: 0.002 }), 0.4);
  const hi = integrateTo(makeRingGrowth({ phi: 0.02 }), 0.4);
  assert.ok(hi.x > 2 * lo.x, `x(φ=0.02)=${hi.x} vs x(φ=0.002)=${lo.x}`);
});

test('depin onset follows the measured power law τ_d = 2.41·φ^0.26', () => {
  // Fig. 4(b): t_d/t_f ≈ 0.40 at φ=0.001, ≈ 0.87 at φ=0.02.
  assert.ok(Math.abs(depinOnset(0.001) - 0.4) < 0.005, `${depinOnset(0.001)}`);
  assert.ok(Math.abs(depinOnset(0.02) - 0.872) < 0.005, `${depinOnset(0.02)}`);
  let prev = 0;
  for (const phi of [0.0005, 0.001, 0.005, 0.01, 0.02, 0.03]) {
    const td = depinOnset(phi);
    assert.ok(td > prev, `not monotone at φ=${phi}`);
    prev = td;
  }
});
