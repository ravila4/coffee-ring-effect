import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStain, generateStainCanvas, DEFAULT_RADIUS_FRACTION } from '../src/render.js';

// A 2-D context that swallows every drawing call: paintStain only draws, it
// never reads back, so recording nothing is enough to run a full render.
const stubContext = (canvas) => ({
  canvas,
  fillStyle: '',
  globalCompositeOperation: '',
  save() {},
  restore() {},
  translate() {},
  beginPath() {},
  closePath() {},
  moveTo() {},
  lineTo() {},
  arc() {},
  fill() {},
  fillRect() {},
});

// An overridden mug supply is read before any sampler runs (the splash needs
// the primary drip's azimuth), so an empty list has to be caught at the door.
test('an overridden mug supply must be a non-empty lobe list', () => {
  for (const type of ['mug', 'drop']) {
    for (const bad of [[], {}, 'lobes']) {
      assert.throws(
        () => buildStain({ seed: 1, radius: 100, particles: 200, type, mugSupply: bad }),
        /mugSupply/,
        `${type}: ${JSON.stringify(bad)} was accepted`,
      );
    }
  }
});

test('a valid mug supply override still builds', () => {
  const stain = buildStain({
    seed: 1,
    radius: 100,
    particles: 200,
    type: 'mug',
    mugSupply: [{ originTheta: 0.5, arcHalfLength: Math.PI, falloff: 1, weight: 1 }],
  });
  assert.equal(stain.supply.length, 1);
  assert.equal(stain.splashDir, 0.5);
});

test('a document canvas wins over OffscreenCanvas when both exist', () => {
  const created = [];
  let offscreens = 0;
  const hadDocument = 'document' in globalThis;
  const hadOffscreen = 'OffscreenCanvas' in globalThis;
  try {
    globalThis.document = {
      createElement(tag) {
        const c = { tag, width: 0, height: 0 };
        c.getContext = () => stubContext(c);
        created.push(c);
        return c;
      },
    };
    globalThis.OffscreenCanvas = class {
      constructor() {
        offscreens++;
        this.getContext = () => stubContext(this);
      }
    };

    const { canvas } = generateStainCanvas({ size: 64, seed: 3, particles: 200 });

    // toDataURL is the documented way to use the result and OffscreenCanvas
    // does not have it, so the DOM canvas must win wherever there is a DOM.
    assert.equal(offscreens, 0, 'OffscreenCanvas was constructed despite a live document');
    assert.equal(created.length, 1);
    assert.equal(created[0].tag, 'canvas');
    assert.equal(canvas, created[0], 'returned canvas is not the document canvas');
    assert.equal(canvas.width, 64);
    assert.equal(canvas.height, 64);
  } finally {
    if (!hadDocument) delete globalThis.document;
    if (!hadOffscreen) delete globalThis.OffscreenCanvas;
  }
});

test('with no document at all the offscreen canvas is used', () => {
  let offscreens = 0;
  const hadOffscreen = 'OffscreenCanvas' in globalThis;
  try {
    globalThis.OffscreenCanvas = class {
      constructor(w, h) {
        offscreens++;
        this.width = w;
        this.height = h;
        this.getContext = () => stubContext(this);
      }
    };
    const { canvas } = generateStainCanvas({ size: 64, seed: 3, particles: 200 });
    assert.equal(offscreens, 1);
    assert.ok(canvas instanceof globalThis.OffscreenCanvas);
  } finally {
    if (!hadOffscreen) delete globalThis.OffscreenCanvas;
  }
});

test('every splat stays inside the canvas footprint', () => {
  // generateStainCanvas draws at radius = DEFAULT_RADIUS_FRACTION * size, so
  // anything further than half the canvas from centre is clipped at the edge.
  const bound = 0.5 / DEFAULT_RADIUS_FRACTION;
  for (let seed = 0; seed < 30; seed++) {
    const stain = buildStain({ seed, radius: 100, particles: 400 });
    for (const s of stain.splats) {
      const reach = Math.hypot(s.x, s.y) + s.r;
      assert.ok(
        reach <= bound * 100,
        `seed ${seed}: splat at ${reach.toFixed(1)} vs bound ${(bound * 100).toFixed(1)}`,
      );
    }
  }
});
