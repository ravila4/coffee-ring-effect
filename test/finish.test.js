import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDropStepper } from '../src/physics.js';
import { makeRng } from '../src/rng.js';

// finish() is the terminal read: an animation that stops scrubbing early still
// wants a complete stain, and nothing may deposit twice afterwards.

test('finish() called early ends the run and settles every particle once', () => {
  const particles = 150;
  const st = makeDropStepper({ particles, steps: 200, phi: 0.02, rng: makeRng(5) });
  for (let k = 0; k < 20; k++) st.step();
  assert.ok(!st.done, 'stepper should still be running 20 of 200 steps in');

  st.finish();
  assert.equal(st.done, true, 'finish() must make the stepper done');
  assert.equal(st.aliveCount, 0, 'nothing may remain suspended after finish()');
  for (let i = 0; i < particles; i++) assert.equal(st.alive[i], 0, `particle ${i} still alive`);
  assert.equal(st.deposits.length, particles, 'mass conservation: one deposit per particle');
});

test('step() after an early finish() deposits nothing further', () => {
  const particles = 150;
  const st = makeDropStepper({ particles, steps: 200, phi: 0.02, rng: makeRng(5) });
  for (let k = 0; k < 20; k++) st.step();
  st.finish();
  const settled = st.deposits.slice();
  const t = st.t;

  for (let k = 0; k < 10; k++) st.step();
  assert.equal(st.t, t, 'the clock must not advance past finish()');
  assert.deepEqual(st.deposits, settled, 'a settled deposit was advected or duplicated');
});

// Dilute drops end by free recession before the step budget runs out; that
// path flips done on its own and must keep doing so.
test('free recession still ends the run without finish()', () => {
  const st = makeDropStepper({ particles: 400, steps: 400, phi: 0.0008, rng: makeRng(7) });
  let stepped = 0;
  while (!st.done) {
    st.step();
    stepped++;
  }
  assert.ok(stepped < 400, `expected free recession before the step budget, ran ${stepped}`);
  assert.ok(st.aliveCount > 0, 'free recession leaves the interior suspended for finish()');
  st.finish();
  assert.equal(st.deposits.length, 400);
});
