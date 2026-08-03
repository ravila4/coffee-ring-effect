import test from 'node:test';
import assert from 'node:assert/strict';
import {
  warpT,
  warpU,
  slowMoFactor,
  radialHistogram,
  frameIndexFor,
  depositTargetAt,
  scrubberTicks,
  makePlaybackController,
} from '../src/animate.js';

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

// --- how much of the deposit is on screen at a given playback position ---
// Playback has two acts: the warped drying (deposit count comes from the
// snapshot) and the interior sweep (the tail is revealed linearly).

// 10 snapshots pinning 10 particles each; the sweep then lays down 50 more.
const schedule = {
  frames: Array.from({ length: 10 }, (_, k) => ({ depositCount: 10 * k })),
  uSplit: 0.8,
  loopDeposits: 90,
  totalDeposits: 140,
  warpP: 2,
};

test('deposit target spans nothing to everything', () => {
  assert.equal(depositTargetAt(0, schedule), 0);
  assert.equal(depositTargetAt(1, schedule), 140);
});

test('the sweep starts where the drying loop stopped', () => {
  assert.equal(depositTargetAt(schedule.uSplit, schedule), 90);
  // Half the sweep has revealed half the tail.
  assert.equal(depositTargetAt(0.9, schedule), 115);
});

test('deposit target never goes backwards or past the last deposit', () => {
  let prev = -1;
  const seen = new Set();
  for (let v = 0; v <= 1.0001; v += 0.005) {
    const n = depositTargetAt(Math.min(1, v), schedule);
    assert.ok(n >= prev, `deposit target dropped at v=${v}: ${n} < ${prev}`);
    assert.ok(n <= 140, `deposit target overshot at v=${v}: ${n}`);
    seen.add(n);
    prev = n;
  }
  assert.ok(seen.size > 20, `deposit target barely moves: ${seen.size} distinct values`);
});

// --- scrubber ticks ---
// Ticks mark realized drying fraction. A free-recession run tears loose before
// t=1, so ticks past the realized end are dropped rather than drawn off-strip.

test('a full drying run ticks every mark plus the dry-out split', () => {
  const ticks = scrubberTicks({ tLast: 1, width: 400, uSplit: 0.8 });
  assert.deepEqual(ticks.map((t) => t.label), ['25%', '50%', '75%', '90%', 'dry']);
  assert.ok(Math.abs(ticks[0].x - warpU(0.25) * 320) < 1e-12);
  assert.equal(ticks[4].x, 320);
});

test('ticks past the realized drying end are dropped', () => {
  const ticks = scrubberTicks({ tLast: 0.8, width: 400, uSplit: 0.8 });
  assert.deepEqual(ticks.map((t) => t.label), ['25%', '50%', '75%', 'tears free']);
});

test('the split reads dry only from 95% of the drying on', () => {
  assert.equal(scrubberTicks({ tLast: 0.95, width: 400, uSplit: 0.8 }).at(-1).label, 'dry');
  assert.equal(scrubberTicks({ tLast: 0.949, width: 400, uSplit: 0.8 }).at(-1).label, 'tears free');
});

test('ticks stretch to fill the drying half and stay ordered', () => {
  const ticks = scrubberTicks({ tLast: 0.9, width: 400, uSplit: 0.8 });
  // The last realized fraction lands on the split, not short of it.
  assert.ok(Math.abs(ticks[3].x - 320) < 1e-12);
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(ticks[i].x >= ticks[i - 1].x, `tick ${i} runs backwards`);
    assert.ok(ticks[i].x <= 320, `tick ${i} spills past the split`);
  }
});

// --- playback controller ---
// Injectable clock and frame scheduler so playback is testable without a DOM.

function fakeHost() {
  let clock = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    lastCb: null,
    frames: 0,
    now: () => clock,
    raf(cb) {
      this.lastCb = cb;
      const id = nextId++;
      pending.set(id, cb);
      return id;
    },
    caf: (id) => pending.delete(id),
    get scheduled() {
      return pending.size;
    },
    // One rAF turn: everything queued fires with the new timestamp.
    advance(ms) {
      clock += ms;
      const due = [...pending.values()];
      pending.clear();
      for (const cb of due) cb(clock);
    },
  };
}

const controllerOn = (host) => makePlaybackController({
  total: 1000,
  onFrame: () => host.frames++,
  now: host.now,
  raf: (cb) => host.raf(cb),
  caf: host.caf,
});

test('playing advances the position by elapsed wall-clock', () => {
  const host = fakeHost();
  const pb = controllerOn(host);
  pb.play();
  host.advance(250);
  assert.ok(Math.abs(pb.position - 0.25) < 1e-12);
  host.advance(250);
  assert.ok(Math.abs(pb.position - 0.5) < 1e-12);
  assert.equal(pb.playing, true);
});

test('pausing freezes the position and stops scheduling frames', () => {
  const host = fakeHost();
  const pb = controllerOn(host);
  pb.play();
  host.advance(250);
  pb.pause();
  assert.equal(pb.playing, false);
  assert.equal(host.scheduled, 0);
  host.advance(500);
  assert.ok(Math.abs(pb.position - 0.25) < 1e-12);
  // A frame already in flight when the pause landed must not advance either.
  host.lastCb(host.now());
  assert.ok(Math.abs(pb.position - 0.25) < 1e-12);
  assert.equal(host.scheduled, 0);
});

test('time spent paused does not count as playback', () => {
  const host = fakeHost();
  const pb = controllerOn(host);
  pb.play();
  host.advance(250);
  pb.pause();
  host.advance(9000);
  pb.play();
  host.advance(250);
  assert.ok(Math.abs(pb.position - 0.5) < 1e-12);
});

test('play is idempotent — no second clock running', () => {
  const host = fakeHost();
  const pb = controllerOn(host);
  pb.play();
  pb.play();
  assert.equal(host.scheduled, 1);
  host.advance(100);
  assert.ok(Math.abs(pb.position - 0.1) < 1e-12);
});

test('playback stops itself at the end and replays from the start', () => {
  const host = fakeHost();
  const pb = controllerOn(host);
  pb.play();
  host.advance(1500);
  assert.equal(pb.position, 1);
  assert.equal(pb.playing, false);
  assert.equal(host.scheduled, 0);
  pb.play();
  assert.equal(pb.position, 0);
});

test('seeking clamps to the timeline and redraws', () => {
  const host = fakeHost();
  const pb = controllerOn(host);
  const before = host.frames;
  pb.seek(0.3);
  assert.equal(pb.position, 0.3);
  assert.equal(host.frames, before + 1);
  pb.seek(-1);
  assert.equal(pb.position, 0);
  pb.seek(2);
  assert.equal(pb.position, 1);
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
