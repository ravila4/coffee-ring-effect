import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDropStepper, simulateDrop } from '../src/physics.js';
import { makeRng } from '../src/rng.js';

// Two seeds cover both interior endgames — dilute (recession sweep) and
// strong (pinned interior).
const CASES = [
  { seed: 7, phi: 0.004, nEvents: 2, interiorMode: 'recession' },
  { seed: 42, phi: 0.02, nEvents: 2, interiorMode: 'pinned' },
];

const OPTS = { particles: 400, steps: 120, tEnd: 0.97, diffusion: 0.02 };

for (const c of CASES) {
  test(`a full drying run deposits every particle, mostly at the rim (seed ${c.seed}, phi ${c.phi})`, () => {
    const { deposits, events } = simulateDrop({ ...OPTS, phi: c.phi, rng: makeRng(c.seed) });
    // Mass conservation: drying ends with one deposit per particle, none lost.
    assert.equal(deposits.length, OPTS.particles);
    // Rim capture: the ring exists only because outward flow strands most
    // particles at the contact line instead of drying them in the interior.
    const pinnedFraction = deposits.filter((d) => d.pinned).length / OPTS.particles;
    assert.ok(pinnedFraction > 0.8, `pinned fraction ${pinnedFraction} too low for a ring`);
    assert.equal(events.length, c.nEvents);
    // Concentration picks how the interior finishes: dilute drops sweep the
    // film inward, strong ones pin it in place.
    assert.equal(events[events.length - 1].interiorMode, c.interiorMode);
  });
}

for (const c of CASES) {
  test(`externally driven stepper reproduces simulateDrop (seed ${c.seed}, phi ${c.phi})`, () => {
    const ref = simulateDrop({ ...OPTS, phi: c.phi, rng: makeRng(c.seed) });
    const st = makeDropStepper({ ...OPTS, phi: c.phi, rng: makeRng(c.seed) });
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
