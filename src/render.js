// Paint a stain on a canvas. The stain is static once generated, so the
// intended usage is render-once: generate to a canvas, reuse as an image.

import { buildStain, DEFAULT_RADIUS_FRACTION } from './stain.js';

export function paintStain(ctx, stain, { cx = 0, cy = 0, darkField = false } = {}) {
  const trace = (pts) => {
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
  };
  if (darkField) {
    // Debug view matching Deegan's binarized dark-field photographs (PRE 61
    // Fig. 9): deposit scatters light → white, bare substrate → black. No
    // washes, no pigment palette, dots near grain scale — the structural
    // skeleton (arch fences, veins, arcs) without the aesthetic blur on top.
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.translate(cx, cy);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const s of stain.splats) {
      ctx.beginPath();
      // 0.25 × splat base ≈ the sim's deposit-grain scale (GRAIN·R): fence
      // walls and veins stay resolvable instead of smearing into blobs.
      ctx.arc(s.x, s.y, Math.max(0.55, s.r * 0.25), 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.restore();
    return;
  }
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
    ctx.arc(s.x, s.y, s.rInk ?? s.r, 0, 2 * Math.PI);
    ctx.fillStyle = `rgba(${s.color.join(',')},${s.alpha})`;
    ctx.fill();
  }
  ctx.restore();
}

export function generateStainCanvas({
  size = 512,
  seed,
  canvas,
  radiusFraction = DEFAULT_RADIUS_FRACTION,
  darkField = false,
  ...options
} = {}) {
  // A DOM canvas where there is a DOM: OffscreenCanvas has no toDataURL, so
  // preferring it would break the documented "render once, keep the image"
  // usage on the main thread. In a worker there is no document and the
  // offscreen surface is the only option.
  const c =
    canvas ??
    (typeof document !== 'undefined'
      ? document.createElement('canvas')
      : new OffscreenCanvas(size, size));
  c.width = size;
  c.height = size;
  const stain = buildStain({
    seed,
    radius: size * radiusFraction,
    canvasBound: 0.5 / radiusFraction,
    ...options,
  });
  paintStain(c.getContext('2d'), stain, { cx: size / 2, cy: size / 2, darkField });
  return { canvas: c, stain };
}
