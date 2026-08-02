// Coffee stains as a texture, for any page that has a canvas. Two functions:
// make a stain once, paint it wherever and however often you like.
//
//   import { createStain, paintStains } from './src/coffee-stains.js';
//   const mug = createStain({ type: 'mug', seed: 42, phi: 0.008 });
//   const droplet = createStain({ type: 'drop', seed: 7, particles: 400, splashEnergy: 0 });
//   paintStains(ctx, [
//     { stain: mug, x: 420, y: 260, radius: 180, opacity: 0.55, rotation: 0.1 },
//     { stain: droplet, x: 130, y: 90, radius: 24, opacity: 0.4 },
//   ]);
//
// A stain is a shape, not a size: createStain returns plain serializable data
// in units of its own radius, so one stain can be cached, shipped as JSON, and
// painted at any size. The simulation runs once, in createStain; painting
// never re-runs it.
//
// paintStains does not own your canvas. It never clears it, never resizes it,
// and leaves no transform or blend state behind — whatever was underneath
// stays and blends. (generateStainCanvas in render.js is the other bargain:
// it owns the canvas it hands back.)
//
// There is no droplet type. A droplet is a small 'drop' that landed gently:
// few particles (~300–600) and low or zero splashEnergy, because a 20 px speck
// with its own satellite field reads as a splatter rather than a drip. The two
// counts are easy to confuse:
//   particles  resolution — how finely the drying is sampled. More costs time
//              and buys structure, not ink: splat alpha normalizes against the
//              tracer count, so painted mass holds steady as the count moves.
//   phi        pigment — how strong the coffee is. This is the knob for a
//              darker, broader, or sparser stain.

import { composeStain, emitStain, scaleStain, DEFAULT_RADIUS_FRACTION } from './stain.js';
import { paintStain } from './render.js';

// composeStain strikes the band radius, half-width and set-down offsets in
// pixels and emitStain divides them back out, so both calls have to be shown
// the same radius. The value is arbitrary but frozen: it is not a size — the
// stain comes out in units of its own radius — yet it lives in the low bits of
// every float that passes through, which makes it part of the seed contract.
// Change it and every seed paints a different stain.
const CANONICAL_RADIUS = 145;

// How far satellites may fly, in radii. Nothing clips a texture, but this is
// the framing the splatter was tuned in, so it stays the default spread.
const DEFAULT_BOUND = 0.5 / DEFAULT_RADIUS_FRACTION;

export function createStain(spec = {}) {
  const {
    seed,
    particles = 3500,
    partialChance = 0.55,
    canvasBound = DEFAULT_BOUND,
    type = 'drop',
  } = spec;
  const composition = composeStain({ ...spec, type, radius: CANONICAL_RADIUS });
  const emitted = emitStain(composition, {
    seed,
    radius: CANONICAL_RADIUS,
    particles,
    partialChance,
    canvasBound,
  });
  return {
    ...emitted,
    seed,
    type: composition.type,
    phi: composition.phi,
    supply: composition.supply,
    splashEnergy: composition.splashEnergy,
    splashDir: composition.splashDir,
    fingerAzimuths: composition.fingerAzimuths,
    satellites: composition.satellites,
  };
}

// Paint a scene of placements in array order, each inside its own save frame:
// { stain, x, y, radius, opacity = 1, rotation = 0 }. Opacity rides
// globalAlpha, so it scales the stain's own per-splat alphas rather than
// replacing them.
export function paintStains(ctx, scene, { composite = 'multiply' } = {}) {
  for (const { stain, x = 0, y = 0, radius, opacity = 1, rotation = 0 } of scene) {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(x, y);
    if (rotation) ctx.rotate(rotation);
    paintStain(ctx, scaleStain(stain, radius), { composite });
    ctx.restore();
  }
}
