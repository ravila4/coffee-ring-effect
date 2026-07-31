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
import { makeContactLine, makeSpikeField } from './contour.js';
import { makeSupplySampler, simulateDrop, simulateRing, widthFactor } from './physics.js';

const RING_COLORS = [
  [110, 62, 20],
  [140, 88, 36],
  [84, 45, 12],
];
const WASH_COLOR = [172, 122, 62];

// generateStainCanvas draws at radius = radiusFraction * size, so anything
// further than 0.5/radiusFraction radii from centre is clipped off the canvas
// edge. Shrinking the fraction buys splatter headroom.
export const DEFAULT_RADIUS_FRACTION = 0.26;
const DEFAULT_BOUND = 0.5 / DEFAULT_RADIUS_FRACTION;
const WE_SPLASH = 30; // Weber-number stand-in below which nothing fingers

// Fingers from the Rayleigh-Taylor instability of the decelerating rim:
// N ∝ √We (with We ∝ v² ∝ drop height, finger count goes as √H).
export function fingerCountFor(We, rng) {
  if (We <= WE_SPLASH) return 0;
  return Math.max(3, Math.round(1.14 * Math.sqrt(We) * rng.uniform(0.85, 1.15)));
}

// Normalized flight range vs satellite size. Fine ejecta is fastest
// (v ∝ r^(−1/2)) but drag-arrested (Stokes τ_p ∝ r²); big drops are ballistic
// but slow. range = min(ballistic, drag-arrest) peaks at intermediate size:
// big secondaries land near, specks form a close-in halo, the farthest
// flyers are mid-sized.
export function rangeShape(size) {
  const s = size / 0.08;
  return Math.min(1 / Math.sqrt(s), Math.pow(s, 1.5));
}

// Satellites pinch off finger tips, so their azimuths sample the finger set
// (or scatter for sub-splash dribbles — toward the drip when there is one).
export function satelliteSpecsFor(
  We,
  fingerAzimuths,
  rng,
  { bound = DEFAULT_BOUND, scatterDir = null } = {},
) {
  const count =
    We <= WE_SPLASH
      ? rng.random() < We / 40
        ? 1 + rng.int(2)
        : 0
      : Math.round(rng.uniform(0.35, 0.7) * Math.sqrt(We));
  // Reach fills whatever room the canvas leaves beyond the landing base; the
  // per-droplet clamp at placement time stays as the safety net.
  const reach = Math.max(0, bound - 1.12) * Math.min(1, Math.sqrt(We / 320));
  const specs = [];
  for (let k = 0; k < count; k++) {
    const size = rng.uniform(0.03, 0.16);
    const theta =
      fingerAzimuths.length > 0
        ? fingerAzimuths[rng.int(fingerAzimuths.length)] + rng.gaussian() * 0.08
        : scatterDir != null
          ? scatterDir + rng.gaussian() * 0.55
          : rng.uniform(0, 2 * Math.PI);
    const dist = 1.12 + reach * rangeShape(size) * rng.uniform(0.75, 1);
    specs.push({ size, theta, dist });
  }
  return specs;
}

// Plateau–Rayleigh breakup of the ligament that flung a satellite: the thread
// pinches into a chain of droplets landing along the flight azimuth at
// graduated distances — a dotted streak between rim and landing point.
export function trailSpecsFor(spec, rng, { from = 1.05 } = {}) {
  const to = spec.dist - spec.size * 1.6;
  if (to <= from) return [];
  const count = Math.max(2, Math.round((to - from) * rng.uniform(7, 12)));
  const specks = [];
  for (let k = 0; k < count; k++) {
    const t = (k + rng.uniform(0.1, 0.9)) / count;
    specks.push({
      dist: from + t * (to - from),
      theta: spec.theta + rng.gaussian() * 0.02,
      size: spec.size * rng.uniform(0.12, 0.3),
    });
  }
  return specks;
}

// Below this radius (in units of the parent radius) a droplet carries too few
// particles per unit perimeter to self-pin — no ring forms, it dries as a
// solid blob. Particles per perimeter go as φR²/r_grain², hence R ~ r/√φ.
export function speckCutoff(phi) {
  return 0.004 / Math.sqrt(phi);
}

export function buildStain({
  seed,
  radius = 140,
  particles = 3500,
  type = 'auto', // 'drop' | 'mug' | 'auto'
  partialChance = 0.55,
  mugChance = 0.5,
  overlapChance = 0.45,
  mugSupply = null, // {originTheta, arcHalfLength, falloff} override for tests/art
  splashEnergy = null, // Weber-number stand-in; continuous draw when null
  canvasBound = DEFAULT_BOUND, // clip radius in units of the parent radius
  dropOverrides = {},
} = {}) {
  const rng = makeRng(seed);
  const noise2D = createNoise2D(mulberry32((seed ^ 0x9e3779b9) >>> 0));
  const splats = [];
  const washes = [];
  const stainType = type === 'auto' ? (rng.random() < mugChance ? 'mug' : 'drop') : type;
  // One drip event per stain: overlap placements share the supply origin and
  // reach with small jitter (the cup was set down twice, the drip only
  // happened once). Reach is log-spread: short = crescent, L ≫ π reads as
  // a uniform ring (L = π would still zero at the antipode).
  const supply =
    stainType === 'mug'
      ? (mugSupply ?? {
          originTheta: rng.uniform(0, 2 * Math.PI),
          arcHalfLength: Math.PI * Math.exp(rng.uniform(Math.log(0.55), Math.log(4))),
          falloff: rng.uniform(0.8, 1.6),
        })
      : null;
  // A mug's splash happened as the cup came down, at the same rim point the
  // drip ran from — so the splash direction is the drip origin.
  const splashDir = stainType === 'mug' ? supply.originTheta : rng.uniform(0, 2 * Math.PI);
  const splatBase = Math.max(0.8, radius * 0.016);
  // One liquid per stain: parent and satellites share the concentration.
  // Log-uniform — φ is a scale parameter and the low decades carry the sparse
  // morphologies (Fig. 8's series), which a linear draw would starve.
  const stainPhi = dropOverrides.phi ?? Math.exp(rng.uniform(Math.log(0.0005), Math.log(0.03)));
  // Impact energy: set-downs are mostly gentle, but a hard one splashes;
  // a spilled drop can always splash.
  const We =
    splashEnergy ??
    (stainType === 'mug'
      ? Math.exp(rng.uniform(Math.log(2), Math.log(120)))
      : Math.exp(rng.uniform(Math.log(8), Math.log(320))));
  const fullFingerCount = fingerCountFor(We, rng);
  // A mug splash is localized: fingers only sprout from the rim arc near the
  // impact, so the count scales by the fan's share of the circumference
  // (same Rayleigh–Taylor wavelength, shorter rim to break up).
  const fanHalf = 0.35 + 0.25 * Math.min(1, We / 320);
  const mugFingerCount =
    fullFingerCount === 0 ? 0 : Math.max(2, Math.round((fullFingerCount * fanHalf) / Math.PI));
  const fingerAzimuths =
    stainType === 'mug'
      ? Array.from(
          { length: mugFingerCount },
          (_, k) =>
            splashDir +
            (k / Math.max(1, mugFingerCount - 1) - 0.5) * 2 * fanHalf +
            rng.gaussian() * 0.05,
        )
      : Array.from(
          { length: fullFingerCount },
          (_, k) =>
            splashDir +
            (k / Math.max(1, fullFingerCount)) * 2 * Math.PI +
            rng.gaussian() * ((0.25 * Math.PI) / Math.max(1, fullFingerCount)),
        );
  const fingerCount = fingerAzimuths.length;

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
      // Residue splats stay near grain size: the recession pass organizes
      // them into spokes/arcs, and oversized blurry blobs would erase that
      // structure into a wash.
      r: splatBase * rng.uniform(0.6, 1.4) * (residue ? 1.3 : 1),
      alpha: residue ? rng.uniform(0.018, 0.042) * centerFade : rng.uniform(0.06, 0.13) * shade,
      color: RING_COLORS[rng.int(RING_COLORS.length)],
    });
  };

  const addDrop = ({ cx, cy, r, count, phi, spikes = null, overrides = {} }) => {
    const line = makeContactLine({
      radius: r,
      amp: rng.uniform(0.025, 0.09),
      freq: rng.uniform(1.2, 2.6),
      noise2D,
      offset: rng.uniform(0, 100),
      spikes,
    });
    const { deposits } = simulateDrop({
      particles: count,
      steps: 220,
      tEnd: rng.uniform(0.9, 0.985),
      diffusion: rng.uniform(0.008, 0.035),
      phi,
      pinningAt: rng.random() < partialChance ? makePinning() : null,
      rng,
      ...overrides,
    });
    const baseShade = makeShade();
    // Evaporative flux diverges at sharp finger tips, so tips darken. Bounded
    // enhancement — flux at a mathematically sharp tip is infinite, and an
    // unbounded multiplier clips to black.
    const shadeAt = (theta) => baseShade(theta) * (1 + 0.45 * line.spikeAt(theta));
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

  const addMugRing = ({ cx, cy, R, wBase, count, supply, spikes = null, overrides = {} }) => {
    const offW = rng.uniform(100, 200);
    const offO = rng.uniform(400, 500);
    const offI = rng.uniform(600, 700);
    const sampler = makeSupplySampler(supply);
    // Band half-width wanders slowly around the ring, scaled by the drip
    // supply: thick lobe near the origin, sliver in the dry gap. The wash
    // polygon shares wAt, so it collapses where the liquid never reached.
    const wAt = (theta) =>
      wBase *
      widthFactor(sampler.relDensityAt(theta)) *
      (1 +
        0.45 *
          fbm(noise2D, Math.cos(theta) * 0.9 + offW, Math.sin(theta) * 0.9 + offW, { octaves: 2 }));
    const jag = (off) => (theta) =>
      0.035 *
      R *
      fbm(noise2D, Math.cos(theta) * 2.2 + off, Math.sin(theta) * 2.2 + off, { octaves: 3 });
    const jo = jag(offO);
    const ji = jag(offI);
    // In the dry gap both wash edges collapse onto exactly R: coincident
    // contours fill zero pixels, where a floored sliver leaves an
    // antialiasing hairline tracing the missing arc.
    const gapAt = (theta) => sampler.relDensityAt(theta) <= 0;
    const outerR = (theta) =>
      gapAt(theta) ? R : R + wAt(theta) + jo(theta) + (spikes ? R * spikes.at(theta) : 0);
    const innerR = (theta) =>
      gapAt(theta) ? R : Math.max(R * 0.2, Math.min(R - wAt(theta) + ji(theta), R + wAt(theta)));
    const { deposits } = simulateRing({
      particles: count,
      steps: 250,
      tEnd: rng.uniform(0.9, 0.985),
      diffusion: rng.uniform(0.01, 0.03),
      sampleTheta: (r) => sampler.sample(r),
      pinningAt: rng.random() < partialChance ? makePinning() : null,
      rng,
      ...overrides,
    });
    const baseShade = makeShade();
    // Same tip darkening as the drop's fingers: flux diverges at sharp tips.
    const shadeAt = spikes
      ? (theta) => baseShade(theta) * (1 + 0.45 * spikes.envelopeAt(theta))
      : baseShade;
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
  };

  if (stainType === 'mug') {
    const wBase = radius * rng.uniform(0.1, 0.16);
    const R = radius - wBase;
    // The splash spikes ride the band's outer edge, clustered at the drip
    // origin — and only on the first placement: the cup may be set down
    // twice, the splash happened once.
    const bandSpikes =
      fingerCount > 0
        ? makeSpikeField({
            azimuths: fingerAzimuths,
            amps: fingerAzimuths.map(() => rng.uniform(0.35, 1.3)),
            // Steeper than the drop's law: the band is thin, so the same
            // impact throws proportionally longer fingers off its edge.
            amp: Math.min(0.25, 0.03 + 0.009 * Math.sqrt(We)),
            sharpness: rng.uniform(2.2, 3.5),
            halfWidth: (0.84 * fanHalf) / Math.max(1, fingerCount - 1),
          })
        : null;
    const placements = rng.random() < overlapChance ? 2 + rng.int(2) : 1;
    for (let k = 0; k < placements; k++) {
      addMugRing({
        cx: k === 0 ? 0 : rng.gaussian() * 0.1 * radius,
        cy: k === 0 ? 0 : rng.gaussian() * 0.1 * radius,
        R: R * rng.uniform(0.97, 1.03),
        wBase: wBase * rng.uniform(0.85, 1.15),
        count: Math.floor(particles * 0.55),
        supply:
          k === 0
            ? supply
            : {
                originTheta: supply.originTheta + rng.gaussian() * 0.06,
                arcHalfLength: supply.arcHalfLength * rng.uniform(0.94, 1.06),
                falloff: supply.falloff,
              },
        spikes: k === 0 ? bandSpikes : null,
        overrides: k === 0 ? dropOverrides : {},
      });
    }
  } else {
    addDrop({
      cx: 0,
      cy: 0,
      r: radius,
      count: particles,
      phi: stainPhi,
      spikes:
        fingerCount > 0
          ? {
              azimuths: fingerAzimuths,
              amps: fingerAzimuths.map(() => rng.uniform(0.35, 1.3)),
              // Cap is geometric, not aesthetic: fingers may reach as long as
              // the canvas leaves room (wobble 0.09 + amps up to 1.3× fit).
              amp: Math.min(0.4 * (canvasBound - 1.12), 0.02 + 0.006 * Math.sqrt(We)),
              sharpness: rng.uniform(2.2, 3.5),
            }
          : null,
      overrides: dropOverrides,
    });
  }

  // Satellites pinch off the finger tips; dribbles from a set-down cup
  // scatter around the drip. Placement is clamped from the actual excursion
  // each droplet can reach, so nothing gets guillotined at the canvas edge.
  const specs = satelliteSpecsFor(We, fingerAzimuths, rng, {
    bound: canvasBound,
    scatterDir: stainType === 'mug' ? splashDir : null,
  });
  const cutoff = speckCutoff(stainPhi);
  for (const spec of specs) {
    const maxCenter = canvasBound - 0.05 - spec.size * 1.3;
    const clamped = Math.min(spec.dist, maxCenter);
    const dist = clamped * radius;
    const x = dist * Math.cos(spec.theta);
    const y = dist * Math.sin(spec.theta);
    if (fingerCount > 0) {
      for (const p of trailSpecsFor({ ...spec, dist: clamped }, rng)) {
        splats.push({
          x: p.dist * radius * Math.cos(p.theta),
          y: p.dist * radius * Math.sin(p.theta),
          r: Math.max(0.5, p.size * radius * rng.uniform(0.5, 0.9)),
          alpha: rng.uniform(0.05, 0.11),
          color: RING_COLORS[rng.int(RING_COLORS.length)],
        });
      }
    }
    if (spec.size < cutoff) {
      // Too dilute to self-pin at this size: a solid blob, no ring, no sim.
      // Same pigment constants as ring splats so the populations match.
      const px = spec.size * radius;
      const n = 2 + rng.int(3);
      for (let k = 0; k < n; k++) {
        splats.push({
          x: x + rng.uniform(-0.3, 0.3) * px,
          y: y + rng.uniform(-0.3, 0.3) * px,
          r: px * rng.uniform(0.35, 0.75),
          alpha: rng.uniform(0.06, 0.13),
          color: RING_COLORS[rng.int(RING_COLORS.length)],
        });
      }
    } else {
      addDrop({
        cx: x,
        cy: y,
        r: spec.size * radius,
        count: Math.max(120, Math.floor(particles * spec.size * spec.size * 4)),
        phi: stainPhi,
      });
    }
  }

  return { splats, washes, radius, seed, type: stainType, splashEnergy: We, splashDir, fingerAzimuths };
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

export function generateStainCanvas({
  size = 512,
  seed,
  canvas,
  radiusFraction = DEFAULT_RADIUS_FRACTION,
  ...options
} = {}) {
  const c =
    canvas ??
    (typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(size, size)
      : document.createElement('canvas'));
  c.width = size;
  c.height = size;
  const stain = buildStain({
    seed,
    radius: size * radiusFraction,
    canvasBound: 0.5 / radiusFraction,
    ...options,
  });
  paintStain(c.getContext('2d'), stain, { cx: size / 2, cy: size / 2 });
  return { canvas: c, stain };
}
