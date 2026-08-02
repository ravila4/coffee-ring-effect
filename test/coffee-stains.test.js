import test from 'node:test';
import assert from 'node:assert/strict';
import { createStain, paintStains } from '../src/coffee-stains.js';

// A 2-D context that records every drawing call and property write in order.
// The painter's promise is mostly about what it never does — no clear, no
// resize, no leaked transform — and absence is only provable against a
// recording. Canvas dimensions record their reads too: touching them at all
// is the failure.
const recordingContext = ({ width = 400, height = 400 } = {}) => {
  const log = [];
  const canvas = {};
  for (const [dim, initial] of [
    ['width', width],
    ['height', height],
  ]) {
    let value = initial;
    Object.defineProperty(canvas, dim, {
      get() {
        log.push({ op: `canvas.${dim}:read`, args: [] });
        return value;
      },
      set(v) {
        log.push({ op: `canvas.${dim}:write`, args: [v] });
        value = v;
      },
    });
  }
  const ctx = { canvas, log };
  const methods = [
    'save',
    'restore',
    'translate',
    'rotate',
    'scale',
    'beginPath',
    'closePath',
    'moveTo',
    'lineTo',
    'arc',
    'fill',
    'fillRect',
    'clearRect',
  ];
  for (const op of methods) ctx[op] = (...args) => log.push({ op, args });
  for (const name of ['fillStyle', 'globalAlpha', 'globalCompositeOperation']) {
    let value;
    Object.defineProperty(ctx, name, {
      get: () => value,
      set(v) {
        value = v;
        log.push({ op: `${name}=`, args: [v] });
      },
    });
  }
  return ctx;
};

// Split a log into one frame per placement: everything between a top-level
// save and its matching restore, each call tagged with the depth it ran at.
// Calls at depth 1 are the painter's own; deeper ones belong to paintStain.
const placementFrames = (log) => {
  const frames = [];
  let depth = 0;
  let frame = null;
  for (const call of log) {
    if (call.op === 'save') {
      if (depth++ === 0) {
        frame = [];
        continue;
      }
    } else if (call.op === 'restore') {
      if (--depth === 0) {
        frames.push(frame);
        frame = null;
        continue;
      }
      assert.ok(depth >= 0, 'restore without a matching save');
    }
    assert.ok(frame, `${call.op} ran outside any save/restore frame`);
    frame.push({ ...call, depth });
  }
  assert.equal(depth, 0, 'save/restore left unbalanced');
  return frames;
};

const ownCalls = (frame, op) => frame.filter((c) => c.depth === 1 && c.op === op);

const mugSpec = { type: 'mug', seed: 42, phi: 0.008, particles: 600 };
const dropletSpec = { type: 'drop', seed: 7, particles: 400, splashEnergy: 0 };

test('a stain is plain data that survives a JSON round trip', () => {
  const stain = createStain(mugSpec);
  assert.equal(stain.unit, true);
  assert.ok(stain.splats.length > 0, 'no splats');
  assert.ok(stain.washes.length > 0, 'no washes');
  assert.deepEqual(JSON.parse(JSON.stringify(stain)), stain);
});

test('a stain carries its composition, not a pixel size', () => {
  const stain = createStain(mugSpec);
  assert.equal(stain.type, 'mug');
  assert.equal(stain.phi, 0.008);
  assert.equal(stain.seed, 42);
  assert.ok(Number.isFinite(stain.splashEnergy));
  // A radius would mean the stain had already been committed to a size.
  assert.ok(!('radius' in stain), 'stain carries a pixel radius');
  const reach = Math.max(...stain.splats.map((s) => Math.hypot(s.x, s.y)));
  assert.ok(reach < 2, `coordinates look like pixels, not radii: reach ${reach}`);
});

test('the same seed makes the same stain, a different seed does not', () => {
  assert.deepEqual(createStain(mugSpec), createStain(mugSpec));
  assert.notDeepEqual(createStain(mugSpec), createStain({ ...mugSpec, seed: 43 }));
});

test('painting never clears or resizes the canvas it was handed', () => {
  const ctx = recordingContext();
  paintStains(ctx, [{ stain: createStain(dropletSpec), x: 50, y: 60, radius: 20 }]);
  for (const op of ['clearRect', 'fillRect', 'canvas.width:read', 'canvas.width:write']) {
    assert.ok(!ctx.log.some((c) => c.op === op), `painting called ${op}`);
  }
  assert.ok(!ctx.log.some((c) => c.op.startsWith('canvas.height')), 'painting read canvas.height');
});

test('each placement is wrapped in its own save/restore', () => {
  const ctx = recordingContext();
  const stain = createStain(dropletSpec);
  paintStains(ctx, [
    { stain, x: 10, y: 20, radius: 20 },
    { stain, x: 30, y: 40, radius: 30 },
  ]);
  // placementFrames asserts the balance; two frames means neither placement
  // leaked its transform onto the next.
  assert.equal(placementFrames(ctx.log).length, 2);
});

test('opacity reaches globalAlpha and defaults to fully opaque', () => {
  const ctx = recordingContext();
  const stain = createStain(dropletSpec);
  paintStains(ctx, [
    { stain, x: 10, y: 20, radius: 20, opacity: 0.4 },
    { stain, x: 30, y: 40, radius: 20 },
  ]);
  const alphas = placementFrames(ctx.log).map((frame) => {
    const sets = ownCalls(frame, 'globalAlpha=');
    assert.equal(sets.length, 1, 'globalAlpha not set exactly once inside the placement');
    return sets[0].args[0];
  });
  assert.deepEqual(alphas, [0.4, 1]);
});

test('the blend is multiply unless the caller asks otherwise', () => {
  const stain = createStain(dropletSpec);
  const blends = (options) => {
    const ctx = recordingContext();
    paintStains(ctx, [{ stain, x: 10, y: 20, radius: 20 }], options);
    return ctx.log.filter((c) => c.op === 'globalCompositeOperation=').map((c) => c.args[0]);
  };
  assert.deepEqual(blends(undefined), ['multiply']);
  assert.deepEqual(blends({ composite: 'source-over' }), ['source-over']);
});

test('placements paint in array order, each at its own spot', () => {
  const ctx = recordingContext();
  const stain = createStain(dropletSpec);
  paintStains(ctx, [
    { stain, x: 10, y: 20, radius: 20 },
    { stain, x: 30, y: 40, radius: 20 },
    { stain, x: 55, y: 5, radius: 20 },
  ]);
  const spots = placementFrames(ctx.log).map((frame) => ownCalls(frame, 'translate')[0].args);
  assert.deepEqual(spots, [
    [10, 20],
    [30, 40],
    [55, 5],
  ]);
});

test('rotation is applied only when the placement asks for one', () => {
  const ctx = recordingContext();
  const stain = createStain(dropletSpec);
  paintStains(ctx, [
    { stain, x: 10, y: 20, radius: 20, rotation: 0.3 },
    { stain, x: 30, y: 40, radius: 20 },
  ]);
  const [turned, straight] = placementFrames(ctx.log);
  assert.deepEqual(
    ownCalls(turned, 'rotate').map((c) => c.args),
    [[0.3]],
  );
  assert.deepEqual(ownCalls(straight, 'rotate'), []);
});

test('the placement radius scales what actually gets painted', () => {
  const stain = createStain(dropletSpec);
  const paintedReach = (radius) => {
    const ctx = recordingContext();
    paintStains(ctx, [{ stain, x: 0, y: 0, radius }]);
    const arcs = ctx.log.filter((c) => c.op === 'arc');
    assert.ok(arcs.length > 0, 'nothing was painted');
    return Math.max(...arcs.map((c) => Math.hypot(c.args[0], c.args[1])));
  };
  const unitReach = Math.max(...stain.splats.map((s) => Math.hypot(s.x, s.y)));
  assert.ok(Math.abs(paintedReach(100) - unitReach * 100) < 1e-9, 'radius 100 did not scale');
  assert.ok(Math.abs(paintedReach(250) - unitReach * 250) < 1e-9, 'radius 250 did not scale');
});

test('a droplet spec throws off no satellites', () => {
  // A droplet is a small drop that landed gently: nothing to finger, nothing
  // to pinch off, so every splat stays inside the footprint. The bound is the
  // contact line's own excursion (1 + amp, amp ≤ 0.09) in units of the radius.
  for (let seed = 0; seed < 12; seed++) {
    const stain = createStain({ ...dropletSpec, seed });
    assert.equal(stain.satellites.length, 0, `seed ${seed}: satellites off a gentle droplet`);
    for (const s of stain.splats) {
      const reach = Math.hypot(s.x, s.y);
      assert.ok(reach <= 1.1, `seed ${seed}: splat ${reach.toFixed(3)} radii out`);
    }
  }
});

test('the public entry rejects an empty mug supply like buildStain does', () => {
  assert.throws(
    () => createStain({ type: 'mug', seed: 1, mugSupply: [] }),
    /mugSupply/,
  );
  assert.throws(
    () => createStain({ type: 'mug', seed: 1, mugSupply: 'lobes' }),
    /mugSupply/,
  );
});
