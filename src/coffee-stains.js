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
// few particles (~300–600 for a mark a few pixels across) and low or zero
// splashEnergy, because a 20 px speck with its own satellite field reads as a
// splatter rather than a drip. The knobs are easy to confuse:
//   particles  resolution — how finely the drying is sampled. Splat alpha
//              normalizes against the tracer count, so past ~1750 tracers more
//              particles cost time and buy structure, not ink. Below that the
//              normalization hits its cap and the stain paints lighter as well
//              as coarser: a droplet big enough to read as a ring wants the
//              tracers even though its footprint is small.
//   phi        pigment — how strong the coffee is. This is the knob for a
//              darker, broader, or sparser stain.
//   grain      fleck size in canvas units — how coarsely the pigment lands.
//              The unit is whatever the ctx draws in (CSS px on the usual
//              DPR-scaled context: do not multiply by devicePixelRatio). The
//              one knob here that belongs to painting rather than to the
//              stain: paintStains takes it, createStain never sees it. Left
//              alone it scales with the stain, so painting one at two sizes
//              is a pure zoom; pin it and the flecks hold their size while
//              the footprint changes, the way marks on a real desk do.
//              Coarser flecks paint proportionally fainter, so the ink
//              survives — until the compensation saturates: grain much finer
//              than the default has no alpha headroom above 1 to spend, and
//              paints lighter. A texture knob, not a weight knob.
// particles and grain are the pair worth keeping straight: particles is how
// finely the drying was sampled, grain is how coarsely the result gets
// painted. More particles buys structure; finer grain only draws the
// structure already there with a finer nib.

import { composeStain, emitStain, scaleStain, DEFAULT_BOUND } from './stain.js';
import { paintStain } from './render.js';

// composeStain strikes the band radius, half-width and set-down offsets in
// pixels and emitStain divides them back out, so both calls have to be shown
// the same radius. The value is arbitrary but frozen: it is not a size — the
// stain comes out in units of its own radius — yet it lives in the low bits of
// every float that passes through, which makes it part of the seed contract.
// Change it and every seed paints a different stain.
const CANONICAL_RADIUS = 145;

export function createStain(spec = {}) {
  // An omitted seed draws one and records it on the stain: a page can
  // sprinkle fresh stains without bookkeeping, and any stain that comes out
  // can still be reproduced from the seed it names. Randomness at the door,
  // pure function of the seed behind it.
  const seed = spec.seed ?? (Math.random() * 2 ** 32) >>> 0;
  const {
    particles = 3500,
    partialChance = 0.55,
    // Nothing clips a texture, but the default spread stays the framing the
    // splatter was tuned in.
    canvasBound = DEFAULT_BOUND,
    type = 'drop',
  } = spec;
  const composition = composeStain({ ...spec, seed, type, radius: CANONICAL_RADIUS });
  const emitted = emitStain(composition, { particles, partialChance, canvasBound });
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
// { stain, x, y, radius, opacity = 1, rotation = 0, grain }. Opacity
// multiplies the alpha already on the context — a page-level fade applies to
// its stains the same way the page's pixels show through the multiply blend —
// and scales the stain's own per-splat alphas rather than replacing them. A
// placement's grain wins over the call's, the same way its opacity and
// rotation are its own.
export function paintStains(ctx, scene, { composite = 'multiply', grain } = {}) {
  for (const p of scene) {
    const { stain, x = 0, y = 0, radius, opacity = 1, rotation = 0 } = p;
    const scaled = scaleStain(stain, radius, { grain: p.grain ?? grain });
    ctx.save();
    try {
      ctx.globalAlpha *= opacity;
      ctx.translate(x, y);
      if (rotation) ctx.rotate(rotation);
      paintStain(ctx, scaled, { composite });
    } finally {
      ctx.restore();
    }
  }
}
