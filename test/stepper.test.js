import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDropStepper, simulateDrop } from '../src/physics.js';
import { makeRng } from '../src/rng.js';

// Characterization pins simulateDrop's exact output across the stepper
// extraction: same seed, same floats. Two seeds cover both endgames —
// dilute (recession sweep) and strong (pinned interior).
const GOLDEN = [
  { seed: 7, phi: 0.004, n: 400, pinned: 382, sumRho: 376.32363169135107, sumTheta: 1374.31062279605, nEvents: 2, interiorMode: 'recession' },
  { seed: 42, phi: 0.02, n: 400, pinned: 386, sumRho: 373.2311299517806, sumTheta: 1302.7012795931223, nEvents: 2, interiorMode: 'pinned' },
];

const OPTS = { particles: 400, steps: 120, tEnd: 0.97, diffusion: 0.02 };

for (const g of GOLDEN) {
  test(`simulateDrop output is unchanged (seed ${g.seed}, phi ${g.phi})`, () => {
    const { deposits, events } = simulateDrop({ ...OPTS, phi: g.phi, rng: makeRng(g.seed) });
    assert.equal(deposits.length, g.n);
    assert.equal(deposits.filter((d) => d.pinned).length, g.pinned);
    const sum = (f) => deposits.reduce((a, d) => a + f(d), 0);
    assert.ok(Math.abs(sum((d) => d.rho) - g.sumRho) < 1e-9);
    assert.ok(Math.abs(sum((d) => d.theta) - g.sumTheta) < 1e-9);
    assert.equal(events.length, g.nEvents);
    assert.equal(events[events.length - 1].interiorMode, g.interiorMode);
  });
}

for (const g of GOLDEN) {
  test(`externally driven stepper reproduces simulateDrop (seed ${g.seed}, phi ${g.phi})`, () => {
    const ref = simulateDrop({ ...OPTS, phi: g.phi, rng: makeRng(g.seed) });
    const st = makeDropStepper({ ...OPTS, phi: g.phi, rng: makeRng(g.seed) });
    while (!st.done) st.step();
    st.finish();
    assert.deepEqual(st.deposits, ref.deposits);
    assert.deepEqual(st.events, ref.events);
  });
}

test('stepper exposes live drying state mid-run', () => {
  const st = makeDropStepper({ particles: 200, steps: 100, phi: 0.02, rng: makeRng(3) });
  for (let k = 0; k < 50; k++) st.step();
  assert.ok(!st.done);
  assert.ok(st.t > 0.4 && st.t < 0.6, `t=${st.t} not mid-drying`);
  // During the pinned loop every death is a deposit: mass is conserved.
  assert.equal(st.aliveCount + st.deposits.length, 200);
  assert.ok(st.aliveCount < 200, 'no pinning by mid-drying');
  assert.ok(st.base > 0 && st.base <= 1);
  assert.ok(st.ringW >= 0, 'ring width readable');
  for (let i = 0; i < 200; i++) {
    if (st.alive[i]) assert.ok(st.rho[i] >= 0 && st.rho[i] <= 1.05);
  }
});

test('finish() is idempotent and step() is a no-op once done', () => {
  const st = makeDropStepper({ particles: 100, steps: 40, phi: 0.02, rng: makeRng(11) });
  while (!st.done) st.step();
  st.finish();
  const n = st.deposits.length;
  st.finish();
  st.step();
  assert.equal(st.deposits.length, n);
});
