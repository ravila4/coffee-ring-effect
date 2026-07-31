import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStain } from '../src/render.js';

test('every splat stays inside the canvas footprint', () => {
  // generateStainCanvas draws at radius = 0.26 * size, so anything further
  // than (0.5 / 0.26) * radius from centre is clipped off the canvas edge.
  const bound = 0.5 / 0.26;
  for (let seed = 0; seed < 200; seed++) {
    const stain = buildStain({ seed, radius: 100, particles: 400, steps: 60 });
    for (const s of stain.splats) {
      const reach = Math.hypot(s.x, s.y) + s.r;
      assert.ok(
        reach <= bound * 100,
        `seed ${seed}: splat at ${reach.toFixed(1)} vs bound ${(bound * 100).toFixed(1)}`,
      );
    }
  }
});
