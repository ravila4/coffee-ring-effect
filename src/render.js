// Turn simulated deposits into drawable primitives (buildStain) and paint
// them on a canvas (paintStain). The stain is static once generated, so the
// intended usage is render-once: generate to a canvas, reuse as an image.
//
// Two archetypes:
//   'drop' — a sessile spill: liquid covers the full footprint, so the ring
//            encloses a translucent mottled wash.
//   'mug'  — a cup-bottom ring: liquid sits only in an annular band under the
//            rim, so the center is dry, the band wanders thick/thin, and both
//            band edges collect pigment. Cups get moved — overlapping
//            placements land at slightly offset centers and multiply-darken
//            where they cross.

import { makeRng, mulberry32 } from './rng.js';
import { createNoise2D, fbm, smoothstep } from './noise.js';
import { makeContactLine } from './contour.js';
import { simulateDrop, simulateRing } from './physics.js';

const RING_COLORS = [
  [110, 62, 20],
  [140, 88, 36],
  [84, 45, 12],
];
const WASH_COLOR = [172, 122, 62];

export function buildStain({
  seed,
  radius = 140,
  particles = 3500,
  type = 'auto', // 'drop' | 'mug' | 'auto'
  partialChance = 0.55,
  dripChance = 0.4,
  mugChance = 0.5,
  overlapChance = 0.45,
  dropOverrides = {},
} = {}) {
  const rng = makeRng(seed);
  const noise2D = createNoise2D(mulberry32((seed ^ 0x9e3779b9) >>> 0));
  const splats = [];
  const washes = [];
  const splashDir = rng.uniform(0, 2 * Math.PI);
  const stainType = type === 'auto' ? (rng.random() < mugChance ? 'mug' : 'drop') : type;
  const splatBase = Math.max(0.8, radius * 0.016);

  // Weak-pinning arcs where the contact line recedes instead of jamming —
  // this is what turns a full ring into a C-shape or leaves random gaps.
  const makePinning = () => {
    const gateOffset = rng.uniform(300, 400);
    const threshold = rng.uniform(-0.05, 0.35);
    return (theta) =>
      smoothstep(
        threshold - 0.25,
        threshold + 0.25,
        fbm(noise2D, Math.cos(theta) * 0.7 + gateOffset, Math.sin(theta) * 0.7 + gateOffset, {
          octaves: 2,
        }),
      );
  };

  // Pigment deposition is not azimuthally even in real stains: broad
  // light/dark arcs from uneven pinning. Low-frequency noise over theta.
  const makeShade = () => {
    const shadeOffset = rng.uniform(200, 300);
    return (theta) =>
      0.65 +
      0.45 *
        fbm(noise2D, Math.cos(theta) * 0.8 + shadeOffset, Math.sin(theta) * 0.8 + shadeOffset, {
          octaves: 2,
        });
  };

  const pushSplat = (x, y, residue, shade, centerFade = 1) => {
    splats.push({
      x,
      y,
      r: splatBase * rng.uniform(0.6, 1.4) * (residue ? 2 : 1),
      alpha: residue ? rng.uniform(0.012, 0.03) * centerFade : rng.uniform(0.06, 0.13) * shade,
      color: RING_COLORS[rng.int(RING_COLORS.length)],
    });
  };

  const addDrop = ({ cx, cy, r, count, overrides = {} }) => {
    const line = makeContactLine({
      radius: r,
      amp: rng.uniform(0.025, 0.09),
      freq: rng.uniform(1.2, 2.6),
      noise2D,
      offset: rng.uniform(0, 100),
    });
    const { deposits } = simulateDrop({
      particles: count,
      steps: 220,
      tEnd: rng.uniform(0.9, 0.985),
      diffusion: rng.uniform(0.008, 0.035),
      depinEvents: rng.random() < 0.45 ? 0 : 1 + rng.int(3),
      depinJump: [0.05, 0.16],
      pinningAt: rng.random() < partialChance ? makePinning() : null,
      rng,
      ...overrides,
    });
    const shadeAt = makeShade();
    // The thin residue film left over the whole footprint.
    washes.push({
      points: line.points().map((p) => ({ x: cx + p.x, y: cy + p.y })),
      color: WASH_COLOR,
      alpha: rng.uniform(0.1, 0.18),
    });
    for (const d of deposits) {
      const rr = d.rho * line.radiusAt(d.theta);
      // Soft-pedal the pile-up at the very center so it reads as a faint
      // last-pool deposit rather than a bullseye.
      const centerFade = 0.4 + 0.6 * Math.min(1, d.rho / 0.3);
      pushSplat(
        cx + rr * Math.cos(d.theta),
        cy + rr * Math.sin(d.theta),
        !d.pinned,
        shadeAt(d.theta),
        centerFade,
      );
    }
  };

  const addMugRing = ({ cx, cy, R, wBase, count, overrides = {} }) => {
    const offW = rng.uniform(100, 200);
    const offO = rng.uniform(400, 500);
    const offI = rng.uniform(600, 700);
    // Band half-width wanders slowly around the ring: thick where the liquid
    // spread, thin where it didn't.
    const wAt = (theta) =>
      wBase *
      (1 +
        0.45 *
          fbm(noise2D, Math.cos(theta) * 0.9 + offW, Math.sin(theta) * 0.9 + offW, { octaves: 2 }));
    const jag = (off) => (theta) =>
      0.035 *
      R *
      fbm(noise2D, Math.cos(theta) * 2.2 + off, Math.sin(theta) * 2.2 + off, { octaves: 3 });
    const jo = jag(offO);
    const ji = jag(offI);
    const outerR = (theta) => R + wAt(theta) + jo(theta);
    const innerR = (theta) => Math.max(R * 0.2, R - wAt(theta) + ji(theta));
    const { deposits } = simulateRing({
      particles: count,
      steps: 250,
      tEnd: rng.uniform(0.9, 0.985),
      diffusion: rng.uniform(0.01, 0.03),
      pinningAt: rng.random() < partialChance ? makePinning() : null,
      rng,
      ...overrides,
    });
    const shadeAt = makeShade();
    const n = Math.floor(4 * R + 20);
    const ringPts = (fn) =>
      Array.from({ length: n }, (_, k) => {
        const theta = (k / n) * 2 * Math.PI;
        const r = fn(theta);
        return { x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) };
      });
    // Annular wash only — the middle of the footprint stays dry paper.
    washes.push({
      points: ringPts(outerR),
      holePoints: ringPts(innerR),
      color: WASH_COLOR,
      alpha: rng.uniform(0.08, 0.15),
    });
    for (const d of deposits) {
      const out = outerR(d.theta);
      const inn = innerR(d.theta);
      const rr = (out + inn) / 2 + (d.u * (out - inn)) / 2;
      pushSplat(cx + rr * Math.cos(d.theta), cy + rr * Math.sin(d.theta), !d.pinned, shadeAt(d.theta));
    }
    return outerR;
  };

  let outerEdge = () => radius * 0.96;
  if (stainType === 'mug') {
    const wBase = radius * rng.uniform(0.1, 0.16);
    const R = radius - wBase;
    const placements = rng.random() < overlapChance ? 2 + rng.int(2) : 1;
    for (let k = 0; k < placements; k++) {
      const edge = addMugRing({
        cx: k === 0 ? 0 : rng.gaussian() * 0.1 * radius,
        cy: k === 0 ? 0 : rng.gaussian() * 0.1 * radius,
        R: R * rng.uniform(0.97, 1.03),
        wBase: wBase * rng.uniform(0.85, 1.15),
        count: Math.floor(particles * 0.55),
        overrides: k === 0 ? dropOverrides : {},
      });
      if (k === 0) outerEdge = edge;
    }
  } else {
    addDrop({ cx: 0, cy: 0, r: radius, count: particles, overrides: dropOverrides });
  }

  // Satellite droplets along a splash direction — a spill splashes plenty,
  // a set-down cup only dribbles a little.
  const satellites = stainType === 'mug' ? rng.int(3) : rng.int(7);
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

  // Runs that dribbled off the rim. They share one direction (the table's
  // tilt), bend only gently, dry with darker margins (their own edge
  // deposition) and end in a rounded dried bulb. Biased downward on screen —
  // any direction is physically valid on a table, but eyes expect runs to
  // fall, and upward pairs read as antennae.
  if (rng.random() < dripChance) {
    const drips = 1 + rng.int(2);
    const tilt = Math.PI / 2 + rng.gaussian() * 0.5;
    for (let k = 0; k < drips; k++) {
      const a = tilt + rng.gaussian() * 0.35;
      const len = rng.uniform(0.25, 0.6) * radius;
      const w0 = radius * rng.uniform(0.06, 0.09);
      const curve = rng.uniform(-0.2, 0.2);
      const startR = outerEdge(a) * 0.99;
      const sx = startR * Math.cos(a);
      const sy = startR * Math.sin(a);
      const steps = Math.max(14, Math.floor(len / (w0 * 0.3)));
      const left = [];
      const right = [];
      let ex = sx;
      let ey = sy;
      let endAng = a;
      for (let s = 0; s <= steps; s++) {
        const f = s / steps;
        const ang = a + curve * f;
        const x = sx + len * f * Math.cos(ang);
        const y = sy + len * f * Math.sin(ang);
        const w = w0 * (1 - 0.45 * f);
        const px = -Math.sin(ang);
        const py = Math.cos(ang);
        left.push({ x: x + px * w, y: y + py * w });
        right.push({ x: x - px * w, y: y - py * w });
        // The run dries with its own edge deposition: darker margins.
        if (s % 2 === 0) {
          for (const side of [-1, 1]) {
            splats.push({
              x: x + side * px * w,
              y: y + side * py * w,
              r: w * 0.35,
              alpha: 0.12,
              color: RING_COLORS[2],
            });
          }
        }
        ex = x;
        ey = y;
        endAng = ang;
      }
      // Rounded dried bulb where the run stopped.
      const bw = w0 * 0.9;
      for (let m = 0; m <= 10; m++) {
        const phi = endAng + Math.PI / 2 - (m / 10) * Math.PI;
        const bx = ex + bw * Math.cos(phi);
        const by = ey + bw * Math.sin(phi);
        left.push({ x: bx, y: by });
        splats.push({ x: bx, y: by, r: bw * 0.35, alpha: 0.13, color: RING_COLORS[2] });
      }
      washes.push({
        points: left.concat(right.reverse()),
        color: WASH_COLOR,
        alpha: rng.uniform(0.2, 0.28),
      });
    }
  }

  return { splats, washes, radius, seed, type: stainType };
}

export function paintStain(ctx, stain, { cx = 0, cy = 0 } = {}) {
  const trace = (pts) => {
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
  };
  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalCompositeOperation = 'multiply';
  for (const w of stain.washes) {
    ctx.beginPath();
    trace(w.points);
    if (w.holePoints) trace(w.holePoints);
    ctx.fillStyle = `rgba(${w.color.join(',')},${w.alpha})`;
    ctx.fill('evenodd');
  }
  for (const s of stain.splats) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, 2 * Math.PI);
    ctx.fillStyle = `rgba(${s.color.join(',')},${s.alpha})`;
    ctx.fill();
  }
  ctx.restore();
}

export function generateStainCanvas({ size = 512, seed, canvas, ...options } = {}) {
  const c =
    canvas ??
    (typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(size, size)
      : document.createElement('canvas'));
  c.width = size;
  c.height = size;
  const stain = buildStain({ seed, radius: size * 0.26, ...options });
  paintStain(c.getContext('2d'), stain, { cx: size / 2, cy: size / 2 });
  return c;
}
