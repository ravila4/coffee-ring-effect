// The stain itself: what happened on the table (composeStain), what the
// drying particles left behind (emitStain), and the two together as splats,
// washes and metadata (buildStain). Plain data all the way out — nothing here
// knows what will draw it.
//
// Two archetypes:
//   'drop' — a sessile spill: liquid covers the full footprint, so the ring
//            encloses a translucent mottled wash.
//   'mug'  — a cup-bottom ring: liquid sits only in an annular band under the
//            rim, so the center is dry, the band wanders thick/thin, and both
//            band edges collect pigment. Cups get moved — overlapping
//            placements land at slightly offset centers and multiply-darken
//            where they cross.

import { forkSeed, makeRng, mulberry32 } from './rng.js';
import { createNoise2D, fbm, smoothstep } from './noise.js';
import { makeContactLine, makeSpikeField } from './contour.js';
import { RING_COLORS, WASH_COLOR } from './palette.js';
import { makeSupplySampler, simulateBand, simulateDrop, widthFactor } from './physics.js';

// Tracer count the alpha palette was tuned at. The count is numerical
// resolution, not physics — the coffee's pigment is set by phi — so pigment
// splats normalize their alpha against this baseline. Dark-field ignores
// alpha on purpose: fluorescence brightness IS particle count.
const TRACER_BASELINE = 3500;

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

// How a deposit paints depends on what it is. Jammed rim/arch mass is
// darkest and sharpest; organized recession structure (spokes, arcs) stays
// small and dark enough to read as lines; dots and in-place residue blur
// into the pale interior speckle. Deegan's grey level is particle count —
// structure exists in the deposit data, and a flat mapping buries it.
// rInk narrows the pigment footprint in the beige view only: a vein is a
// line of concentrated deposit, and the same ink in half the width reads
// twice as dark under multiply — at demo tracer counts alphaNorm pushes
// line splats to ~2% alpha, where a 2 px soft blob vanishes into the wash
// but a sharp one still draws. Dark-field keeps r: its dot geometry is the
// Fig. 9 comparison instrument and must not shift under aesthetic tuning.
const SPLAT_STYLES = {
  pinned: { r: 1, aLo: 0.06, aHi: 0.13 },
  spoke: { r: 0.85, rInk: 0.45, aLo: 0.22, aHi: 0.36, dark: true },
  arc: { r: 0.85, rInk: 0.45, aLo: 0.22, aHi: 0.36, dark: true },
  dot: { r: 1.3, aLo: 0.018, aHi: 0.042 },
  residue: { r: 1.3, aLo: 0.018, aHi: 0.042 },
};
export function splatStyleFor(deposit) {
  return SPLAT_STYLES[deposit.pinned ? 'pinned' : (deposit.sink ?? 'residue')];
}

// Independent random streams, forked from the seed. The particle sims eat
// a φ-dependent number of draws and a hard splash grows more fingers, so a
// single shared stream would let one knob shift the draws behind every
// unrelated decision — turn φ, and the satellites move. Instead:
//   rng          composition — what happened on the table (stain type,
//                drip, coffee strength, how many times the cup came down)
//   splashRng    impact — fingers, spike strengths, satellite launches
//   componentRng one stream per simulated component (parent placements,
//                then each satellite), so no sim can shift a neighbor
// composeStain owns the first two, emitStain the third. Within one stream
// the order of draws is the stain's identity: a seed reproduces a stain only
// for as long as that order holds, so a new draw belongs at the end of its
// stream, never spliced into the middle.

// What happened on the table, before a single particle moves: the stain's
// type, where the coffee ran down the rim, how strong it was, how hard it
// landed, and where each set-down of the cup sat. Plain serializable data.
export function composeStain({
  seed,
  radius = 140,
  type = 'auto', // 'drop' | 'mug' | 'auto'
  mugChance = 0.5,
  overlapChance = 0.2,
  multiDripChance = 0.25,
  mugSupply = null, // lobe list [{originTheta, arcHalfLength, falloff, weight}] override for tests/art
  splashEnergy = null, // Weber-number stand-in; continuous draw when null
  canvasBound = DEFAULT_BOUND, // clip radius in units of the parent radius
  phi = null, // pigment concentration; continuous draw when null
} = {}) {
  const rng = makeRng(seed);
  const splashRng = makeRng(forkSeed(seed, 1));
  const stainType = type === 'auto' ? (rng.random() < mugChance ? 'mug' : 'drop') : type;
  // One drip event per stain: overlap placements share the supply with
  // small jitter (the cup was set down twice, the drip only happened once).
  // The coffee may run down the rim at more than one point, though — each
  // stream is a lobe with its own volume (weight). Splitting conserves the
  // coffee: with more streams each carries less and runs shorter, so
  // multi-drip lobes usually stay disjoint (a disconnected donut), merging
  // into a lopsided ring only when they happen to touch. Reach is
  // log-spread: short = crescent; a single lobe with L ≫ π reads as a
  // uniform ring (L = π would still zero at the antipode).
  const drawSupplyLobes = () => {
    const origin = rng.uniform(0, 2 * Math.PI);
    const drips = rng.random() < multiDripChance ? 2 + rng.int(2) : 1;
    const reach = (lo, hi) => Math.PI * Math.exp(rng.uniform(Math.log(lo), Math.log(hi)));
    const lobes = [
      {
        originTheta: origin,
        arcHalfLength: drips === 1 ? reach(0.55, 4) : reach(0.3, 1.1),
        falloff: rng.uniform(0.8, 1.6),
        weight: 1,
      },
    ];
    // Extra drips spread around the rim (evenly spaced plus jitter, so two
    // drips face each other) and carry less coffee than the primary.
    for (let j = 1; j < drips; j++) {
      lobes.push({
        originTheta: origin + j * ((2 * Math.PI) / drips) + rng.gaussian() * 0.45,
        arcHalfLength: reach(0.15, 0.6),
        falloff: rng.uniform(0.8, 1.6),
        weight: Math.exp(rng.uniform(Math.log(0.15), Math.log(0.7))),
      });
    }
    return lobes;
  };
  const supply = stainType === 'mug' ? (mugSupply ?? drawSupplyLobes()) : null;
  // One liquid per stain: parent and satellites share the concentration.
  // Log-uniform — φ is a scale parameter and the low decades carry the sparse
  // morphologies (Fig. 8's series), which a linear draw would starve.
  // The draw always runs, override or not, so holding the slider at the
  // auto-drawn value reproduces the auto stain exactly.
  const phiDraw = Math.exp(rng.uniform(Math.log(0.0005), Math.log(0.03)));
  const stainPhi = phi ?? phiDraw;
  // Mug composition: band width and how many times the cup was set down.
  const mugHalfWidth = stainType === 'mug' ? radius * rng.uniform(0.1, 0.16) : 0;
  const placementCount =
    stainType === 'mug' && rng.random() < overlapChance ? 2 + rng.int(2) : 1;
  // Where each set-down landed. The first is the reference; later ones are
  // nudged off centre, take their own band width, and carry the same drip
  // supply shifted a little — the cup was not put back down in quite the
  // same spot.
  const placements = [];
  if (stainType === 'mug') {
    const wBase = mugHalfWidth;
    const R = radius - wBase;
    for (let k = 0; k < placementCount; k++) {
      placements.push({
        cx: k === 0 ? 0 : rng.gaussian() * 0.1 * radius,
        cy: k === 0 ? 0 : rng.gaussian() * 0.1 * radius,
        R: R * rng.uniform(0.97, 1.03),
        wBase: wBase * rng.uniform(0.85, 1.15),
        supply:
          k === 0
            ? supply
            : supply.map((lobe) => ({
                ...lobe,
                originTheta: lobe.originTheta + rng.gaussian() * 0.06,
                arcHalfLength: lobe.arcHalfLength * rng.uniform(0.94, 1.06),
              })),
      });
    }
  }
  // A mug's splash happened as the cup came down, at the rim point of first
  // contact — the primary drip. Extra lobes just wet, no impact.
  const splashDir = stainType === 'mug' ? supply[0].originTheta : splashRng.uniform(0, 2 * Math.PI);
  // Impact energy: set-downs are mostly gentle, but a hard one splashes;
  // a spilled drop can always splash. Always drawn, same as φ.
  const weDraw =
    stainType === 'mug'
      ? Math.exp(splashRng.uniform(Math.log(2), Math.log(120)))
      : Math.exp(splashRng.uniform(Math.log(8), Math.log(320)));
  const We = splashEnergy ?? weDraw;
  const fullFingerCount = fingerCountFor(We, splashRng);
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
            splashRng.gaussian() * 0.05,
        )
      : Array.from(
          { length: fullFingerCount },
          (_, k) =>
            splashDir +
            (k / Math.max(1, fullFingerCount)) * 2 * Math.PI +
            splashRng.gaussian() * ((0.25 * Math.PI) / Math.max(1, fullFingerCount)),
        );
  const fingerCount = fingerAzimuths.length;
  // The splash fingers, as a spike-field spec. On a mug they ride the band's
  // outer edge, clustered at the drip origin; on a drop they deform the whole
  // contact line.
  const spikes =
    fingerCount === 0
      ? null
      : stainType === 'mug'
        ? {
            azimuths: fingerAzimuths,
            amps: fingerAzimuths.map(() => splashRng.uniform(0.35, 1.3)),
            // Steeper than the drop's law: the band is thin, so the same
            // impact throws proportionally longer fingers off its edge.
            amp: Math.min(0.25, 0.03 + 0.009 * Math.sqrt(We)),
            sharpness: splashRng.uniform(2.2, 3.5),
            halfWidth: (0.84 * fanHalf) / Math.max(1, fingerCount - 1),
          }
        : {
            azimuths: fingerAzimuths,
            amps: fingerAzimuths.map(() => splashRng.uniform(0.35, 1.3)),
            // Cap is geometric, not aesthetic: fingers may reach as long as
            // the canvas leaves room (wobble 0.09 + amps up to 1.3× fit).
            amp: Math.min(0.4 * (canvasBound - 1.12), 0.02 + 0.006 * Math.sqrt(We)),
            sharpness: splashRng.uniform(2.2, 3.5),
          };
  // Satellites pinch off the finger tips; dribbles from a set-down cup
  // scatter around the drip.
  const satellites = satelliteSpecsFor(We, fingerAzimuths, splashRng, {
    bound: canvasBound,
    scatterDir: stainType === 'mug' ? splashDir : null,
  });

  return {
    // The seed and radius ride along: every number above was drawn from
    // streams forked off this seed at this radius, so emission must not be
    // able to disagree — a mismatched pair would mix geometry from one
    // configuration with random streams from another.
    seed,
    radius,
    type: stainType,
    phi: stainPhi,
    supply,
    splashEnergy: We,
    splashDir,
    fingerAzimuths,
    placements,
    spikes,
    satellites,
  };
}

// Dry the composition: run the particle sims and turn their deposits into
// splats and washes. Every draw here comes from a per-component stream, so
// re-rolling one component leaves its neighbors alone. The seed and radius
// come from the composition itself; the config carries only what emission
// adds — sampling resolution and clipping.
export function emitStain(composition, { particles, partialChance, canvasBound }) {
  const {
    seed,
    radius,
    type: stainType,
    phi: stainPhi,
    fingerAzimuths,
    placements,
    spikes,
    satellites,
  } = composition;
  const componentRng = (k) => makeRng(forkSeed(seed, 8 + k));
  const noise2D = createNoise2D(mulberry32((seed ^ 0x9e3779b9) >>> 0));
  const splats = [];
  const washes = [];
  const splatBase = Math.max(0.8, radius * 0.016);
  const fingerCount = fingerAzimuths.length;

  // Weak-pinning arcs where the contact line lets go partway through the
  // drying instead of jamming to the end — this is what turns a full ring
  // into a C-shape or leaves gaps. The sim reads strength as a hold
  // fraction, so gap edges fade out instead of stepping.
  const makePinning = (rng) => {
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
  const makeShade = (rng) => {
    const shadeOffset = rng.uniform(200, 300);
    return (theta) =>
      0.65 +
      0.45 *
        fbm(noise2D, Math.cos(theta) * 0.8 + shadeOffset, Math.sin(theta) * 0.8 + shadeOffset, {
          octaves: 2,
        });
  };

  // Capped for sparse test runs, where the inverse rule would blow past
  // opaque.
  const alphaNorm = Math.min(2, TRACER_BASELINE / particles);
  const pushSplat = (rng, x, y, deposit, shade) => {
    const style = splatStyleFor(deposit);
    const rJitter = rng.uniform(0.6, 1.4);
    splats.push({
      x,
      y,
      r: splatBase * rJitter * style.r,
      rInk: splatBase * rJitter * (style.rInk ?? style.r),
      // Azimuthal shade belongs to the contact line, so it only modulates
      // jammed deposits; interior structure paints flat.
      alpha: rng.uniform(style.aLo, style.aHi) * (deposit.pinned ? shade : 1) * alphaNorm,
      // Line structure always takes the darkest ink.
      color: style.dark ? RING_COLORS[2] : RING_COLORS[rng.int(RING_COLORS.length)],
    });
  };

  const addDrop = ({ rng, cx, cy, r, count, phi, spikes = null }) => {
    // Everything that shapes the footprint draws before the sim runs, so a φ
    // change (which alters how many numbers the sim eats) can only re-roll
    // the ring structure, never the contact line or the wash.
    const line = makeContactLine({
      radius: r,
      amp: rng.uniform(0.025, 0.09),
      freq: rng.uniform(1.2, 2.6),
      noise2D,
      offset: rng.uniform(0, 100),
      spikes,
    });
    const washAlpha = rng.uniform(0.1, 0.18);
    const baseShade = makeShade(rng);
    const { deposits } = simulateDrop({
      particles: count,
      steps: 220,
      tEnd: rng.uniform(0.9, 0.985),
      diffusion: rng.uniform(0.008, 0.035),
      phi,
      pinningAt: rng.random() < partialChance ? makePinning(rng) : null,
      rng,
    });
    // Evaporative flux diverges at sharp finger tips, so tips darken. Bounded
    // enhancement — flux at a mathematically sharp tip is infinite, and an
    // unbounded multiplier clips to black.
    const shadeAt = (theta) => baseShade(theta) * (1 + 0.45 * line.spikeAt(theta));
    // The thin residue film left over the whole footprint.
    washes.push({
      points: line.points().map((p) => ({ x: cx + p.x, y: cy + p.y })),
      color: WASH_COLOR,
      alpha: washAlpha,
    });
    for (const d of deposits) {
      const rr = d.rho * line.radiusAt(d.theta);
      pushSplat(rng, cx + rr * Math.cos(d.theta), cy + rr * Math.sin(d.theta), d, shadeAt(d.theta));
    }
  };

  const addMugRing = ({ rng, cx, cy, R, wBase, count, phi, supply, spikes = null }) => {
    // Same rule as addDrop: every draw that shapes the band contour and wash
    // happens before the sim, so φ only re-rolls what the physics deposits.
    const offW = rng.uniform(100, 200);
    const offO = rng.uniform(400, 500);
    const offI = rng.uniform(600, 700);
    const washAlpha = rng.uniform(0.08, 0.15);
    const baseShade = makeShade(rng);
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
    const { deposits } = simulateBand({
      particles: count,
      steps: 250,
      tEnd: rng.uniform(0.9, 0.985),
      diffusion: rng.uniform(0.01, 0.03),
      phi,
      // The metric the band stepper needs: what a radian costs in units of
      // the band half-width.
      aspect: wBase / R,
      sampleTheta: (r) => sampler.sample(r),
      pinningAt: rng.random() < partialChance ? makePinning(rng) : null,
      rng,
    });
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
      alpha: washAlpha,
    });
    for (const d of deposits) {
      const out = outerR(d.theta);
      const inn = innerR(d.theta);
      const rr = (out + inn) / 2 + (d.u * (out - inn)) / 2;
      pushSplat(rng, cx + rr * Math.cos(d.theta), cy + rr * Math.sin(d.theta), d, shadeAt(d.theta));
    }
  };

  if (stainType === 'mug') {
    // The splash rode the band's outer edge on the first placement only: the
    // cup may be set down twice, the splash happened once.
    const bandSpikes = spikes ? makeSpikeField(spikes) : null;
    placements.forEach((placement, k) => {
      addMugRing({
        rng: componentRng(k),
        cx: placement.cx,
        cy: placement.cy,
        R: placement.R,
        wBase: placement.wBase,
        count: Math.floor(particles * 0.55),
        phi: stainPhi,
        supply: placement.supply,
        spikes: k === 0 ? bandSpikes : null,
      });
    });
  } else {
    addDrop({
      rng: componentRng(0),
      cx: 0,
      cy: 0,
      r: radius,
      count: particles,
      phi: stainPhi,
      spikes,
    });
  }

  // Placement is clamped from the actual excursion each droplet can reach, so
  // nothing gets guillotined at the canvas edge.
  const cutoff = speckCutoff(stainPhi);
  satellites.forEach((spec, j) => {
    // Each satellite draws from its own stream: whether THIS one rings or
    // dries as a blob flips with φ (the speck cutoff), and that must not
    // re-roll its neighbors' trails or rings.
    const satRng = componentRng(8 + j);
    const maxCenter = canvasBound - 0.05 - spec.size * 1.3;
    const clamped = Math.min(spec.dist, maxCenter);
    const dist = clamped * radius;
    const x = dist * Math.cos(spec.theta);
    const y = dist * Math.sin(spec.theta);
    if (fingerCount > 0) {
      for (const p of trailSpecsFor({ ...spec, dist: clamped }, satRng)) {
        splats.push({
          x: p.dist * radius * Math.cos(p.theta),
          y: p.dist * radius * Math.sin(p.theta),
          r: Math.max(0.5, p.size * radius * satRng.uniform(0.5, 0.9)),
          alpha: satRng.uniform(0.05, 0.11),
          color: RING_COLORS[satRng.int(RING_COLORS.length)],
        });
      }
    }
    if (spec.size < cutoff) {
      // Too dilute to self-pin at this size: a solid blob, no ring, no sim.
      // Same pigment constants as ring splats so the populations match.
      const px = spec.size * radius;
      const n = 2 + satRng.int(3);
      for (let k = 0; k < n; k++) {
        splats.push({
          x: x + satRng.uniform(-0.3, 0.3) * px,
          y: y + satRng.uniform(-0.3, 0.3) * px,
          r: px * satRng.uniform(0.35, 0.75),
          alpha: satRng.uniform(0.06, 0.13),
          color: RING_COLORS[satRng.int(RING_COLORS.length)],
        });
      }
    } else {
      addDrop({
        rng: satRng,
        cx: x,
        cy: y,
        r: spec.size * radius,
        count: Math.max(120, Math.floor(particles * spec.size * spec.size * 4)),
        phi: stainPhi,
      });
    }
  });

  return { splats, washes };
}

export function buildStain(options = {}) {
  const {
    seed,
    radius = 140,
    particles = 3500,
    partialChance = 0.55,
    canvasBound = DEFAULT_BOUND, // clip radius in units of the parent radius
    mugSupply = null,
    splashEnergy = null,
    phi = null,
  } = options;
  // The primary lobe sets the splash azimuth, so the override is read before
  // any sampler runs and an empty list has nothing to aim at.
  if (mugSupply !== null && (!Array.isArray(mugSupply) || mugSupply.length === 0)) {
    throw new TypeError('mugSupply must be a non-empty array of lobes');
  }
  // Both are continuous draws when null and NaN geometry three modules later
  // if garbage gets through. Zero splash is a legal gentle set-down; zero
  // pigment is no stain at all.
  if (phi !== null && !(Number.isFinite(phi) && phi > 0)) {
    throw new RangeError(`phi must be finite and positive, got ${phi}`);
  }
  if (splashEnergy !== null && !(Number.isFinite(splashEnergy) && splashEnergy >= 0)) {
    throw new RangeError(`splashEnergy must be finite and non-negative, got ${splashEnergy}`);
  }
  const composition = composeStain(options);
  const { splats, washes } = emitStain(composition, { particles, partialChance, canvasBound });
  return {
    splats,
    washes,
    radius,
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
