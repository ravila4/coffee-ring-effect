import test from 'node:test';
import assert from 'node:assert/strict';
import { queryFlag } from '../demo/query.js';

// Demo boot flags are opt-in and explicit: only "=1" turns one on, so a link
// carrying ?dark=0 lands in the light view instead of the one it names.

test('only an explicit 1 enables a flag', () => {
  assert.equal(queryFlag('?dark=1', 'dark'), true);
  assert.equal(queryFlag('?dark=0', 'dark'), false);
  assert.equal(queryFlag('?dark=false', 'dark'), false);
  assert.equal(queryFlag('?dark', 'dark'), false, 'a bare flag has no value to affirm');
  assert.equal(queryFlag('?dark=', 'dark'), false);
  assert.equal(queryFlag('', 'dark'), false, 'absent flag');
  assert.equal(queryFlag('?play=1', 'dark'), false, 'a different flag must not leak across');
});

test('the flag is read by name out of a mixed query string', () => {
  const search = '?seed=99&dark=1&play=0';
  assert.equal(queryFlag(search, 'dark'), true);
  assert.equal(queryFlag(search, 'play'), false);
  assert.equal(queryFlag(search, 'seed'), false, 'seed=99 is not a flag');
});
