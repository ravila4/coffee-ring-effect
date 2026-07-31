// Turn simulated deposits into drawable primitives (buildStain) and paint
// them on a canvas (paintStain). The stain is static once generated, so the
// intended usage is render-once: generate to a canvas, reuse as an image.

import { makeRng, mulberry32 } from './rng.js';
import { createNoise2D, fbm } from './noise.js';
import { makeContactLine } from './contour.js';
import { simulateDrop } from './physics.js';

const RING_COLORS = [
  [110, 62, 20],
  [140, 88, 36],
  [84, 45, 12],
];
const WASH_COLOR = [172, 122, 62];

export function buildStain({ seed, radius = 140, particles = 3500, dropOverrides = {} } = {}) {
  const rng = makeRng(seed);
  const noise2D = createNoise2D(mulberry32((seed ^ 0x9e3779b9) >>> 0));
  const splats = [];
  const washes = [];
  const splashDir = rng.uniform(0, 2 * Math.PI);

  const addDrop = ({ cx, cy, r, count, overrides = {} }) => {
    const line = makeContactLine({
      radius: r,
      amp: rng.uniform(0.025, 0.09),
      freq: rng.uniform(1.2, 2.6),
      noise2D,
      offset: rng.uniform(0, 100),
    });
    const tEnd = rng.uniform(0.9, 0.985);
    const { deposits } = simulateDrop({
      particles: count,
      steps: 220,
      tEnd,
      diffusion: rng.uniform(0.008, 0.035),
      depinEvents: rng.random() < 0.45 ? 0 : 1 + rng.int(3),
      depinJump: [0.05, 0.16],
      rng,
      ...overrides,
    });
    // Pigment deposition is not azimuthally even in real stains: broad
    // light/dark arcs from uneven pinning. Low-frequency noise over theta.
    const shadeOffset = rng.uniform(200, 300);
    const shadeAt = (theta) =>
      0.65 +
      0.45 * fbm(noise2D, Math.cos(theta) * 0.8 + shadeOffset, Math.sin(theta) * 0.8 + shadeOffset, { octaves: 2 });
    // The thin residue film left over the whole footprint.
    washes.push({
      points: line.points().map((p) => ({ x: cx + p.x, y: cy + p.y })),
      color: WASH_COLOR,
      alpha: rng.uniform(0.1, 0.18),
    });
    const splatBase = Math.max(0.8, r * 0.016);
    for (const d of deposits) {
      const rr = d.rho * line.radiusAt(d.theta);
      // Particles still suspended at dry-out settle as soft interior mottle;
      // particles jammed at the contact line read as sharp dark pigment.
      const residue = d.t >= tEnd - 1e-9;
      // Soft-pedal the pile-up at the very center so it reads as a faint
      // last-pool deposit rather than a bullseye.
      const centerFade = residue ? 0.4 + 0.6 * Math.min(1, d.rho / 0.3) : 1;
      const alpha = residue
        ? rng.uniform(0.012, 0.03) * centerFade
        : rng.uniform(0.06, 0.13) * shadeAt(d.theta);
      splats.push({
        x: cx + rr * Math.cos(d.theta),
        y: cy + rr * Math.sin(d.theta),
        r: splatBase * rng.uniform(0.6, 1.4) * (residue ? 2.2 : 1),
        alpha,
        color: RING_COLORS[rng.int(RING_COLORS.length)],
      });
    }
  };

  addDrop({ cx: 0, cy: 0, r: radius, count: particles, overrides: dropOverrides });

  const satellites = rng.int(7);
  for (let k = 0; k < satellites; k++) {
    const frac = rng.uniform(0.04, 0.16);
    const dist = rng.uniform(1.25, 2.0) * radius;
    const ang = splashDir + rng.gaussian() * 0.9;
    addDrop({
      cx: dist * Math.cos(ang),
      cy: dist * Math.sin(ang),
      r: frac * radius,
      count: Math.max(120, Math.floor(particles * frac * frac * 4)),
    });
  }

  return { splats, washes, radius, seed };
}

export function paintStain(ctx, stain, { cx = 0, cy = 0 } = {}) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalCompositeOperation = 'multiply';
  for (const w of stain.washes) {
    ctx.beginPath();
    w.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = `rgba(${w.color.join(',')},${w.alpha})`;
    ctx.fill();
  }
  for (const s of stain.splats) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, 2 * Math.PI);
    ctx.fillStyle = `rgba(${s.color.join(',')},${s.alpha})`;
    ctx.fill();
  }
  ctx.restore();
}

export function generateStainCanvas({ size = 512, seed, canvas } = {}) {
  const c =
    canvas ??
    (typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(size, size)
      : document.createElement('canvas'));
  c.width = size;
  c.height = size;
  const stain = buildStain({ seed, radius: size * 0.26 });
  paintStain(c.getContext('2d'), stain, { cx: size / 2, cy: size / 2 });
  return c;
}
