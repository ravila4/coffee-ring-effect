// The coffee-ring effect, per Deegan et al.: the contact line stays pinned
// while evaporation flux diverges at the thin edge, driving an outward
// capillary flow that carries suspended particles to the rim, where they jam.
// We integrate that flow field directly instead of solving fluid dynamics.

const LAMBDA = 0.5; // evaporation-flux exponent for a vanishing contact angle
const PACKING = 0.656; // ring packing fraction p (Deegan Appendix)

// Deegan's Eq. 3 (wedge approximation): w/R as a function of concentration and
// normalized time. The Appendix ODE reduces to this as τ → 0.
export function eq3Width(phi, tau) {
  return Math.sqrt(phi / (4 * PACKING)) * Math.pow(1 - Math.pow(1 - tau, 0.75), 2 / 3);
}

// First-hole depinning time, Fig. 4(b) measured power law. The retraction
// mechanism itself is unsolved (Deegan's words), so the timing is empirical:
// no local criterion reproduces the weak 0.26 exponent — a surface-angle
// threshold moves the wrong way with φ, and force balances give φ^1.5.
export function depinOnset(phi) {
  return 2.41 * Math.pow(phi, 0.26);
}

// Appendix ODE pair (A6)/(A7) in epoch-normalized variables x = 4w/R,
// y = 4h/(θ·R), τ ∈ [0,1):  y·dx/dτ = S(τ),  dy/dτ = (1−τ−y)·dx/dτ,
// with source S(τ) = (2φ/p)·(1−(1−τ)^(3/4))^(1/3)/(1−τ)^(1/4).
// The IC x = y = 0 is singular (dx/dτ ~ τ^(−1/3)), so the first step seeds
// from the small-τ asymptote x = y = 2√(φ/p)·(3τ/4)^(2/3), which is exactly
// Eq. 3's wedge limit. Forward Euler after that is within 0.6% of RK4.
// The epoch ends when 1−τ−y ≤ 0: the ring has met the liquid surface and Θ
// would go negative on the next step.
export function makeRingGrowth({ phi }) {
  let tau = 0;
  let x = 0;
  let y = 0;
  let started = false;
  let done = false;
  return {
    get tau() { return tau; },
    get x() { return x; },
    get y() { return y; },
    get w() { return x / 4; },
    get thetaRatio() { return 1 - tau - y; },
    get done() { return done; },
    step(dtau) {
      if (done) return;
      if (!started) {
        tau = dtau;
        x = y = 2 * Math.sqrt(phi / PACKING) * Math.pow(0.75 * tau, 2 / 3);
        started = true;
        return;
      }
      const S =
        ((2 * phi) / PACKING) *
        (Math.pow(1 - Math.pow(1 - tau, 0.75), 1 / 3) / Math.pow(1 - tau, 0.25));
      const dxdtau = S / y;
      x = Math.min(x + dxdtau * dtau, 3.999); // interface radius stays positive
      y += (1 - tau - y) * dxdtau * dtau;
      tau += dtau;
      if (1 - tau - y <= 0 || tau >= 1) done = true;
    },
  };
}

// Depth-averaged outward radial velocity in normalized units (drop radius = 1,
// drying time = 1): v(ρ,t) = [ (1−ρ²)^(−λ) − (1−ρ²) ] / (4ρ(1−t)).
// Vanishes at the center, diverges at the rim and as the drop dries.
export function radialVelocity(rho, t) {
  if (rho <= 0) return 0;
  const clamped = Math.min(rho, 0.999999);
  const one = 1 - clamped * clamped;
  return (Math.pow(one, -LAMBDA) - one) / (4 * (1 - t) * clamped);
}

const NBINS = 512; // azimuthal contact-line bins; oversamples 0.02-0.07 rad holes
const GRAIN = 0.004; // deposit jitter at the interface, a few grain diameters
const SEVER_COVERAGE = 0.63; // N·⟨L⟩ ~ C (paper) → 1−e⁻¹ union coverage
const MAX_ARCH_GENERATION = 2; // parent + 2 layers of subarches per epoch
// A hole's edge is receding contact line, so its speed carries the flow
// field's 1/(1−t) divergence: speed = HOLE_FRONT_SPEED/(1−t). A fixed
// arrest timescale starves high-φ drops (depin at τ_d ≈ 0.87 leaves the
// whole arch zone 13% of the drying) and over-arrests dilute ones, where
// Deegan sees arches "grow without bound". 0.5 anchors the φ = 0.005 arch
// (0.037R deep, depin t ≈ 0.6) at its cell-morphometrics-calibrated ~0.03
// arrest time.
const HOLE_FRONT_SPEED = 0.5;
const TWO_PI = 2 * Math.PI;

const wrap = (theta) => ((theta % TWO_PI) + TWO_PI) % TWO_PI;

// Arch arc length over drop radius, Fig. 13's linear law, floored where the
// law crosses zero (φ ≈ 0.029, inside the render range). The naive jamming
// argument gives 1/φ, which the paper's data reject.
export function holeAngularWidth(phiEff) {
  return Math.max(0.015, 0.069 - 2.38 * phiEff);
}

// Contact line as azimuthal bins: base radius minus hole bumps. Holes compose
// by max recession (union of dry regions) — summing would double-recede.
export function buildKappaBins(base, holes, t, nBins = NBINS) {
  const bins = new Float64Array(nBins).fill(base);
  for (const h of holes) {
    const depth = Math.min(h.arrestDepth, Math.max(0, (t - h.tNucleated) * h.growthRate));
    if (depth <= 0) continue;
    const center = wrap(h.theta);
    const centerBin = Math.floor((center / TWO_PI) * nBins);
    const halfBins = Math.ceil((h.halfWidth / TWO_PI) * nBins) + 1;
    for (let db = -halfBins; db <= halfBins; db++) {
      const b = (((centerBin + db) % nBins) + nBins) % nBins;
      const thetaB = ((b + 0.5) / nBins) * TWO_PI;
      let off = Math.abs(thetaB - center);
      if (off > Math.PI) off = TWO_PI - off;
      if (off >= h.halfWidth) continue;
      const edge = Math.cos((Math.PI / 2) * (off / h.halfWidth));
      const kappa = base - depth * edge * edge;
      if (kappa < bins[b]) bins[b] = kappa;
    }
  }
  return bins;
}

// Sample a bin index by cumulative weight. Used for hole-azimuth selection,
// weighted toward thin realized deposit.
export function pickWeightedBin(weights, rng) {
  let total = 0;
  for (const w of weights) total += w;
  let target = rng.random() * total;
  for (let b = 0; b < weights.length; b++) {
    target -= weights[b];
    if (target <= 0) return b;
  }
  return weights.length - 1;
}

// Where a severed line re-pins is azimuthally heterogeneous: weak sectors
// keep receding before they anchor — spatially incomplete repinning, the
// difference between closed tree-ring multirings and the broken arcs and
// webs of Figs. 9/18. Strength in [0,1] from low harmonics with random
// phases: the line's |q| capillary stiffness low-pass filters the defect
// disorder, so only long-wavelength weakness expresses (amplitudes fall as
// k^(-1/2), the elastic response to white disorder; k=1 is a rigid
// off-center shift — Fig. 18's inner rings are visibly eccentric).
// Normalized, then contrast-shaped so wide arcs sit at the extremes —
// fully anchored fragments and true gaps, tapering between. Without the
// shaping the field hugs mid-strength and every sector catches at least
// the epoch's early deposits: the fence closes into a ring again.
// A parent epoch's field carries 60% of the blend: the anchoring landscape
// persists across epochs, so the same weak azimuths keep receding — the
// radial vein channels that let the web cross rings. Independent fields
// give broken rings whose gaps never line up.
export function makeAnchorField(rng, nBins = NBINS, parent = null) {
  const modes = [];
  for (let k = 1; k <= 6; k++) {
    modes.push({ k, a: Math.pow(k, -0.5) * rng.uniform(0.6, 1.4), ph: rng.uniform(0, TWO_PI) });
  }
  const s = new Float64Array(nBins);
  let lo = Infinity;
  let hi = -Infinity;
  for (let b = 0; b < nBins; b++) {
    const th = ((b + 0.5) / nBins) * TWO_PI;
    let v = 0;
    for (const m of modes) v += m.a * Math.cos(m.k * th + m.ph);
    s[b] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  for (let b = 0; b < nBins; b++) {
    const fresh = (s[b] - lo) / (hi - lo || 1);
    const blended = parent ? 0.6 * parent[b] + 0.4 * fresh : fresh;
    s[b] = smoothstepLocal(0.2, 0.8, blended);
  }
  return s;
}

// Below this effective concentration there are too few particles to arrest a
// growing hole ("insufficient number of particles to stop the contact line"),
// so the severed line never re-pins: the drop ends in free recession and the
// interior settles through the recession pass instead of in place.
const FREE_RECESSION_PHI = 0.0013;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

const smoothstepLocal = (e0, e1, v) => {
  const t = clamp01((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// Which sink an interior particle settles through, as a function of the live
// remaining load (suspended fraction of all particles) at its pickup moment.
// High load: the receding line is overwhelmed and erratic — half-formed
// arches. Mid load: organized cusp emission — radial spokes (with arcs it
// forms the gridlike interior). Near-zero load: disorganized dots. Weights
// ramp smoothly so the mixed zone is a genuine mixture.
export function chooseInteriorSink(load, rng) {
  const arcW = smoothstepLocal(0.06, 0.2, load);
  const dotW = 1 - smoothstepLocal(0.008, 0.04, load);
  const spokeW = Math.max(0, 1 - arcW - dotW);
  let pick = rng.random() * (arcW + dotW + spokeW);
  if ((pick -= arcW) <= 0) return 'arc';
  if ((pick -= spokeW) <= 0) return 'spoke';
  return 'dot';
}

// The receding line organizes itself into a series of cusps that emit
// particles (PRE 61 §IV). Cusp-to-cusp distance stays roughly constant in
// arc length (~0.06·R; Figs. 13–14), so as the front's circumference
// shrinks, cusps merge — seen outward, that's a vein Y-junction. Between
// merges each cusp wanders, which is why real spokes wiggle. The evolution
// is precomputed in radial slabs; spoke emission reads the live cusp set at
// the particle's pickup radius.
const FRONT_STEP = 0.02; // radial slab per cusp-evolution step
export function traceCuspFront({ rho0, spacing, wander, rng, aspect = null }) {
  // Spacing is a length in stepper units. On a disk the front's
  // circumference in those units shrinks with ρ, forcing merges; on a band
  // the front recedes toward the midline circle, whose circumference is the
  // constant 2π/aspect — band cusps never merge, they stay parallel ticks.
  let thetas = [];
  const count0 = Math.max(
    3,
    Math.round(aspect ? TWO_PI / aspect / spacing : (TWO_PI * rho0) / spacing),
  );
  const offset = rng.uniform(0, TWO_PI / count0);
  for (let k = 0; k < count0; k++) {
    thetas.push(
      offset +
        (k / count0) * TWO_PI +
        rng.gaussian() * 0.15 * (aspect ? spacing * aspect : spacing / rho0),
    );
  }
  const levels = [{ rho: rho0, thetas: [...thetas] }];
  for (let rho = rho0 - FRONT_STEP; rho > 0; rho -= FRONT_STEP) {
    const sigma = aspect
      ? wander * FRONT_STEP * aspect
      : (wander * FRONT_STEP) / Math.max(rho, 0.12);
    thetas = thetas.map((th) => th + rng.gaussian() * sigma).sort((a, b) => wrap(a) - wrap(b));
    const target = Math.max(
      3,
      Math.round(aspect ? TWO_PI / aspect / spacing : (TWO_PI * rho) / spacing),
    );
    while (thetas.length > target) {
      // Merge the closest adjacent pair (circularly): the two veins join.
      let best = 0;
      let bestGap = Infinity;
      for (let k = 0; k < thetas.length; k++) {
        const next = thetas[(k + 1) % thetas.length];
        let gap = Math.abs(wrap(next) - wrap(thetas[k]));
        if (gap > Math.PI) gap = TWO_PI - gap;
        if (gap < bestGap) {
          bestGap = gap;
          best = k;
        }
      }
      const a = thetas[best];
      const b = thetas[(best + 1) % thetas.length];
      const mergedTheta = a + (circGapSigned(a, b) / 2);
      thetas.splice(best, 1);
      thetas[best % thetas.length] = mergedTheta;
    }
    levels.push({ rho, thetas: [...thetas] });
  }
  return levels;
}

const circGapSigned = (from, to) => {
  let d = wrap(to) - wrap(from);
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
};

// The recession pass: the freed contact line sweeps the interior outside-in,
// settling each still-suspended particle through a load-dependent sink.
// Spokes deposit around the live cusp azimuths with an exponential kernel
// (Fig. 16 — not a delta snap); at the lowest loads emission goes
// discontinuous and a fraction scatters off-line (disjointed dotted trails).
// Arcs quantize onto stick-slip rest radii. Dots stay near where they were
// picked up. Every deposit carries its sink so the render can weight
// structure over speckle.
export function settleInterior({
  items,
  total,
  tEnd,
  rng,
  forceSink = null,
  cuspSpacing = 0.06,
  cuspWander = 0.5,
  aspect = null, // band metric: radians per stepper length unit
}) {
  const sorted = [...items].sort((a, b) => b.rho - a.rho);
  if (sorted.length === 0) return { deposits: [], cuspLevels: [] };
  // Stick-slip rest arcs are local: a receding arc catches over a finite
  // angular window at a radius its neighbours don't share — Figs. 9/18 show
  // broken arcs and webs, hardly any closed inner ring. A disk-wide rest
  // ladder here rendered as tree growth rings. Fragments are created lazily
  // by the sweep and reused by later particles landing within reach, so
  // arc coherence is per-sector, not per-circle.
  const arcCapture = 0.02 + 0.015 * rng.random();
  const arcFragments = [];
  const settleArc = (p) => {
    let best = null;
    let bestD = Infinity;
    for (const f of arcFragments) {
      let off = Math.abs(wrap(p.theta) - wrap(f.theta));
      if (off > Math.PI) off = TWO_PI - off;
      if (off > f.halfWidth) continue;
      const d = Math.abs(p.rho - f.rho);
      if (d < arcCapture && d < bestD) {
        bestD = d;
        best = f;
      }
    }
    if (!best) {
      // Always seed a fragment: a creation coin flip made the realized
      // arc/dot split a function of particle count (more particles → more
      // joins → fewer silent dots), breaking "tracer count is resolution".
      // An isolated single-particle fragment reads as a dot anyway.
      // Fragment reach is a length in cross-section units, so on a band the
      // metric shrinks it to the same physical scale as the drop's arcs.
      best = { rho: p.rho, theta: p.theta, halfWidth: rng.uniform(0.25, 0.8) * (aspect ?? 1) };
      arcFragments.push(best);
    }
    return clamp01(best.rho + rng.gaussian() * 0.002);
  };
  const rho0 = Math.max(sorted[0].rho, 0.1);
  const cuspLevels = traceCuspFront({ rho0, spacing: cuspSpacing, wander: cuspWander, rng, aspect });
  const levelAt = (rho) => {
    const k = Math.min(
      cuspLevels.length - 1,
      Math.max(0, Math.round((rho0 - rho) / FRONT_STEP)),
    );
    return cuspLevels[k];
  };
  const deposits = [];
  let remaining = sorted.length;
  for (const p of sorted) {
    const load = remaining / total;
    // "The central region is composed of apparently disorganized dots"
    // (Fig. 9): near the hub, cusp azimuths converge and organized emission
    // breaks down — everything inside settles as dots.
    const sink = forceSink ?? (p.rho < 0.08 ? 'dot' : chooseInteriorSink(load, rng));
    if (sink === 'spoke') {
      const { thetas } = levelAt(p.rho);
      const spacingHere = TWO_PI / thetas.length;
      let best = thetas[0];
      let bestOff = Infinity;
      for (const c of thetas) {
        let off = Math.abs(wrap(p.theta) - wrap(c));
        if (off > Math.PI) off = TWO_PI - off;
        if (off < bestOff) {
          bestOff = off;
          best = c;
        }
      }
      const sign = rng.random() < 0.5 ? -1 : 1;
      const offset =
        load < 0.03 && rng.random() < 0.55
          ? sign * rng.uniform(0.08, 0.5) * spacingHere
          : sign * -(spacingHere * 0.12) * Math.log(1 - rng.random());
      deposits.push({ rho: p.rho, theta: best + offset, t: tEnd, pinned: false, sink });
    } else if (sink === 'arc') {
      deposits.push({
        rho: settleArc(p),
        theta: p.theta + rng.gaussian() * 0.01,
        t: tEnd,
        pinned: false,
        sink,
      });
    } else {
      deposits.push({
        rho: p.rho * (0.98 + 0.02 * rng.random()),
        theta: p.theta + rng.gaussian() * 0.02,
        t: tEnd,
        pinned: false,
        sink,
      });
    }
    remaining--;
  }
  return { deposits, cuspLevels };
}

// Advect solute particles through the Deegan flow with Brownian diffusion.
// The ring grows inward per the Appendix ODE; depinning begins at the
// measured onset time as dry holes nucleating on the ring's inner edge
// (Fig. 3), which grow, arrest (walled in by jamming particles → arch
// loops), and — once their union covers ~63% of the circumference — sever
// the liquid from the ring, starting the next pinned epoch. Whatever is
// still suspended at dry-out deposits in place (the mottled interior).
//
// depinSchedule ([{t}], forces depin onsets) and holeSchedule ([{t, theta,
// halfWidth, arrestDepth}], forces individual holes) exist for deterministic
// tests; both drive the identical epoch machinery.
//
// makeDropStepper exposes the integration one dt at a time with the live
// state (rho/theta/alive, deposits so far, epoch radius and ring width)
// readable between steps — the drying animation drives it frame by frame.
// step() past the end is a no-op; finish() settles the interior once.
// simulateDrop runs the same machinery to completion.
export function makeDropStepper({
  particles = 3000,
  steps = 300,
  tEnd = 0.98,
  diffusion = 0.02,
  phi = 0.01,
  depinSchedule = null,
  holeSchedule = null,
  interiorSink = null, // test-only: force the recession-pass sink
  pinningAt = null, // θ → [0,1] strength, read as hold fraction of the drying
  sampleTheta = null, // rng → θ; supply profile for crescents (default uniform)
  bandAspect = null, // w/R_mid when this "drop" is one half of an annular band
  rng,
} = {}) {
  if (!rng) throw new Error('makeDropStepper requires a seeded rng');
  // null is the disk sentinel, not a missing value; anything else is the
  // band's w/R_mid, a ratio of two lengths and so strictly positive.
  if (!(bandAspect === null || (Number.isFinite(bandAspect) && bandAspect > 0))) {
    throw new RangeError(`bandAspect must be null (a disk) or a positive ratio, got ${bandAspect}`);
  }

  const dt = tEnd / steps;
  // Slosh diffusion normalized to the 300-step reference calibration.
  const sloshKick = 0.3 * Math.sqrt(dt / (0.98 / 300));
  // The stepper is contour-independent: it thinks in (ρ, θ) with the contact
  // line at ρ = 1. What a mug band changes is the metric, not the machinery.
  // On a disk, ρ and θ share the drop-radius unit, so a physical length L on
  // a line at radius r spans L/r radians. On one half of an annular band
  // (mirrored about the band midline), the ρ-unit is the half-width w while
  // a radian costs R_mid — and the azimuthal radius stays R_mid as the line
  // recedes toward the midline — so the exchange rate is the constant aspect
  // w/R_mid. Every law stays in stepper length units; only the conversion to
  // radians branches.
  const angPerLen = (r) => bandAspect ?? 1 / r;
  // NBINS oversamples disk holes (0.02–0.07 rad), but band holes are ~aspect
  // times narrower in angle; without more bins a hole spans no bin center,
  // carves nothing, and severing can never trigger.
  const nBins = bandAspect ? Math.round(NBINS / bandAspect) : NBINS;
  const rho = new Float64Array(particles);
  const theta = new Float64Array(particles);
  const alive = new Uint8Array(particles).fill(1);
  for (let i = 0; i < particles; i++) {
    // Disk: uniform over the area. Band: the cross-section is quasi-1-D
    // (area element ∝ du), so uniform over the half-width.
    rho[i] = bandAspect ? rng.random() : Math.sqrt(rng.random());
    theta[i] = sampleTheta ? sampleTheta(rng) : rng.uniform(0, 2 * Math.PI);
  }
  let aliveCount = particles;

  const deposits = [];
  const events = [];
  const depositMass = new Float64Array(nBins);

  const forcedDepins = depinSchedule ? [...depinSchedule].sort((a, b) => a.t - b.t) : null;
  let nextForcedDepin = 0;
  const forcedHoles = holeSchedule ? [...holeSchedule].sort((a, b) => a.t - b.t) : null;
  let nextForcedHole = 0;

  const phiEffAt = (tStart) =>
    Math.min(PACKING, (phi * (aliveCount / particles)) / (1 - tStart));

  const newEpoch = (base, tStart, thetaEpoch, parentAnchors = null) => ({
    base,
    tStart,
    thetaEpoch,
    phiEff: phiEffAt(tStart),
    growth: makeRingGrowth({ phi: phiEffAt(tStart) }),
    // The first epoch is the outer rim — always a complete circle. Re-pinned
    // epochs anchor sector-wise: weak sectors sit deeper (relief) and let go
    // partway through the epoch (the hold gate in the particle loop), so
    // inner fences come out as broken, wavy arcs instead of tree rings.
    anchors: tStart === 0 ? null : makeAnchorField(rng, nBins, parentAnchors),
    anchorRelief: tStart === 0 ? 0 : base * rng.uniform(0.04, 0.1),
    holes: [],
    tOnset: null,
    wAtDepin: null,
    nextNucleation: Infinity,
    nucleationGap: Infinity,
  });

  let epoch = newEpoch(1, 0, 1);
  let freeRecession = false;

  const holeAzimuth = () => {
    // Nucleate where the realized ring is thinnest ("the thinnest portion of
    // the ring indicates where the first depinning event occurred"); before
    // any deposit exists, fall back to the weak-pinning arcs.
    const weights = new Float64Array(nBins);
    let anyMass = false;
    for (let b = 0; b < nBins; b++) if (depositMass[b] > 0) anyMass = true;
    for (let b = 0; b < nBins; b++) {
      const thetaB = ((b + 0.5) / nBins) * TWO_PI;
      weights[b] = anyMass
        ? 1 / (1 + depositMass[b])
        : pinningAt
          ? 1.01 - pinningAt(thetaB)
          : 1;
    }
    const bin = pickWeightedBin(weights, rng);
    return ((bin + rng.random()) / nBins) * TWO_PI;
  };

  const nucleate = (t, forced) => {
    if (forced) {
      epoch.holes.push({
        theta: forced.theta,
        halfWidth: forced.halfWidth,
        arrestDepth: forced.arrestDepth,
        tNucleated: t,
        growthRate: forced.arrestDepth / 0.03,
        generation: 0,
      });
    } else {
      // The Fig. 13 law gives arc length in stepper length units; the metric
      // converts to radians last (band: constant aspect, no epoch.base).
      const arcOverR = holeAngularWidth(epoch.phiEff);
      const halfWidth = bandAspect
        ? ((arcOverR * bandAspect) / 2) * rng.uniform(0.7, 1.3)
        : ((arcOverR / epoch.base) / 2) * rng.uniform(0.7, 1.3);
      // Depth ≈ length·1.3: Fig. 9's cells measure round-to-tall (equivalent
      // diameter ≈ the Fig. 13 arc length), not the shallow scallops a
      // semicircular cap would leave. Width stays the calibrated law.
      const arrestDepth = bandAspect
        ? 1.3 * (halfWidth / bandAspect) * rng.uniform(0.75, 1.25)
        : 1.3 * halfWidth * epoch.base * rng.uniform(0.75, 1.25);
      epoch.holes.push({
        theta: holeAzimuth(),
        halfWidth,
        arrestDepth,
        tNucleated: t,
        growthRate: (HOLE_FRONT_SPEED / (1 - t)) * rng.uniform(0.7, 1.3),
        generation: 0,
      });
    }
    if (epoch.tOnset === null) {
      epoch.tOnset = t;
      epoch.wAtDepin = epoch.growth.w;
      // Spread the fence of holes over ~60% of the remaining drying time so
      // the union crosses the severing threshold before dry-out.
      const expectedHoles = bandAspect
        ? TWO_PI / (holeAngularWidth(epoch.phiEff) * bandAspect)
        : TWO_PI / (holeAngularWidth(epoch.phiEff) / epoch.base);
      epoch.nucleationGap = (0.6 * (1 - t)) / Math.max(1, expectedHoles);
      epoch.nextNucleation = t + epoch.nucleationGap * rng.uniform(0.5, 1.5);
    }
  };

  // Recursive depinning (Fig. 11: large arches are composed of subarches):
  // an arrested arch is itself a pinned contact line, so the next generation
  // of holes nucleates on it — sized by the same Fig. 13 arch-length law at
  // the receded local radius and nested inside the parent's window. A child's
  // depth is stored from the epoch base so the kappa-bin union composes
  // unchanged; its growth therefore spends its early life "re-drying" the
  // parent's hole, and that dead time is the nucleation delay.
  const spawnChildren = (parent, t) => {
    const localR = epoch.base - parent.arrestDepth;
    if (localR < 0.15) return;
    const count = 1 + rng.int(2);
    for (let k = 0; k < count; k++) {
      const halfWidth = Math.min(
        bandAspect
          ? ((holeAngularWidth(phiEffAt(t)) * bandAspect) / 2) * rng.uniform(0.7, 1.3)
          : (holeAngularWidth(phiEffAt(t)) / localR / 2) * rng.uniform(0.7, 1.3),
        parent.halfWidth * 0.95,
      );
      const off = rng.uniform(-1, 1) * (parent.halfWidth - halfWidth);
      // Parent floor under the child's centre (the cos² edge profile).
      const edge = Math.cos((Math.PI / 2) * (Math.abs(off) / parent.halfWidth));
      const ownDepth = bandAspect
        ? 1.3 * (halfWidth / bandAspect) * rng.uniform(0.75, 1.25)
        : 1.3 * halfWidth * localR * rng.uniform(0.75, 1.25);
      epoch.holes.push({
        theta: parent.theta + off,
        halfWidth,
        arrestDepth: parent.arrestDepth * edge * edge + ownDepth,
        tNucleated: t,
        growthRate: (HOLE_FRONT_SPEED / (1 - t)) * rng.uniform(0.7, 1.3),
        generation: parent.generation + 1,
      });
    }
  };

  const recordEpoch = (rNext) => {
    events.push({
      tStart: epoch.tStart,
      tOnset: epoch.tOnset,
      rBase: epoch.base,
      rNext,
      anchors: epoch.anchors,
      anchorRelief: epoch.anchorRelief,
      wAtDepin: epoch.wAtDepin,
      wAtEnd: epoch.growth.w,
      thetaEpoch: epoch.thetaEpoch,
      holes: epoch.holes.map((h) => ({
        theta: h.theta,
        halfWidth: h.halfWidth,
        arrestDepth: h.arrestDepth,
        tNucleated: h.tNucleated,
        growthRate: h.growthRate,
        generation: h.generation,
      })),
    });
  };

  let s = 0;
  let finished = false;
  const isDone = () => finished || freeRecession || s >= steps;

  const stepOnce = () => {
    const t = s * dt;
    epoch.growth.step(dt / (1 - epoch.tStart));
    const w = epoch.growth.w;

    // Depin onset: forced schedule bypasses the empirical law but drives the
    // same machinery. An empty schedule means "never depins".
    if (epoch.tOnset === null && !forcedHoles) {
      if (forcedDepins) {
        if (nextForcedDepin < forcedDepins.length && t >= forcedDepins[nextForcedDepin].t) {
          nextForcedDepin++;
          nucleate(t, null);
        }
      } else if (
        epoch.growth.tau >= depinOnset(epoch.phiEff) ||
        epoch.growth.done
      ) {
        nucleate(t, null);
      }
    }
    if (forcedHoles) {
      while (nextForcedHole < forcedHoles.length && t >= forcedHoles[nextForcedHole].t) {
        nucleate(t, forcedHoles[nextForcedHole]);
        nextForcedHole++;
      }
    } else if (epoch.tOnset !== null) {
      while (t >= epoch.nextNucleation) {
        nucleate(t, null);
        epoch.nextNucleation += epoch.nucleationGap * rng.uniform(0.5, 1.5);
      }
    }

    // Arrested arches host the next generation (bounded recursion). Snapshot
    // the length: children pushed here arrest later, not this step.
    const grown = epoch.holes.length;
    for (let h = 0; h < grown; h++) {
      const hole = epoch.holes[h];
      if (hole.generation >= MAX_ARCH_GENERATION || hole.spawned) continue;
      if (t >= hole.tNucleated + hole.arrestDepth / hole.growthRate) {
        hole.spawned = true;
        spawnChildren(hole, t);
      }
    }

    const kappaBins = buildKappaBins(epoch.base, epoch.holes, t, nBins);
    // Arrest contour (holes at full depth): a particle caught by a growing
    // hole rides the receding front and jams where the front will arrest —
    // the snowplow that makes arch walls bright and cell interiors dark.
    // Passing t = ∞ rasterizes every hole at its arrestDepth.
    const floorBins = buildKappaBins(epoch.base, epoch.holes, Infinity, nBins);

    // Severing: union of grown holes covers enough of the circumference.
    if (epoch.holes.length > 0) {
      let covered = 0;
      let floorSum = 0;
      for (let b = 0; b < nBins; b++) {
        if (kappaBins[b] < epoch.base - 1e-6) {
          covered++;
          floorSum += kappaBins[b];
        }
      }
      if (covered / nBins >= SEVER_COVERAGE) {
        // Severed liquid retracts freely (Fig. 2's post-depin shrink) before
        // self-pinning re-establishes; the retreat distance is part of the
        // unsolved dewetting-vs-pinning competition, so it stays stochastic.
        // Without it the next epoch would pin at the hole floors, ~2% inside
        // the old ring — nested rings would be invisible. On a band the
        // observable is the doubled edge of a real mug ring, which sits a
        // large fraction of the half-width inside the first ridge: the
        // retracting film is squeezed across a thin cross-section, so the
        // dewetting jump is proportionally deeper than a disk's.
        const retreat = bandAspect
          ? epoch.base * rng.uniform(0.15, 0.3)
          : epoch.base * rng.uniform(0.06, 0.14);
        const rNext = Math.max(0.15, floorSum / covered - retreat);
        recordEpoch(rNext);
        if (phiEffAt(t) < FREE_RECESSION_PHI) {
          // Too few particles left to arrest the next generation of holes:
          // the line never re-pins. The interior settles via the recession
          // pass after the loop.
          freeRecession = true;
          return;
        }
        const thetaEpoch = Math.min(1, (1 - t) / Math.pow(rNext, 3));
        epoch = newEpoch(rNext, t, thetaEpoch, epoch.anchors);
        s++;
        return; // rebuild bins next step under the new epoch
      }
    }

    // Sector relief: weak-anchor sectors re-pinned deeper, strong sectors
    // caught slightly outside the mean. Centered on 1/2 so rNext stays the
    // azimuthal MEAN catching radius — one-sided relief (1 − s) shifted
    // every re-pinned ring inward by half the amplitude, silently re-tuning
    // the calibrated retreat draw. Applied after the sever test, which
    // measures hole coverage against the unrelieved base.
    if (epoch.anchors) {
      for (let b = 0; b < nBins; b++) {
        const d = epoch.anchorRelief * (0.5 - epoch.anchors[b]);
        kappaBins[b] -= d;
        floorBins[b] -= d;
      }
    }

    const sigma = Math.sqrt(2 * diffusion * dt);
    for (let i = 0; i < particles; i++) {
      if (!alive[i]) continue;
      const bin = Math.floor((wrap(theta[i]) / TWO_PI) * nBins);
      const kb = kappaBins[bin];
      const interface_ = kb * (1 - w);
      // The D/rho term is the Itô drift of 2-D Brownian motion's radial
      // coordinate; without it the walk is 1-D-in-rho and piles a 1/r
      // density spike at the centre (the old render hid it with centerFade).
      // A band's cross-section IS 1-D in u — no Jacobian drift — and its
      // midline is a circle, not a point: crossing reflects without the
      // antipodal θ flip a disk center demands.
      let r =
        rho[i] +
        (radialVelocity(rho[i] / kb, t) * kb +
          (bandAspect ? 0 : diffusion / Math.max(rho[i], 0.02))) *
          dt +
        sigma * rng.gaussian();
      theta[i] += bandAspect
        ? sigma * bandAspect * rng.gaussian()
        : (sigma / Math.max(r, 0.05)) * rng.gaussian();
      if (r < 0) {
        r = -r;
        if (!bandAspect) theta[i] += Math.PI;
      }
      if (r >= interface_) {
        // Pinning is temporal, not a coin flip: an arc holds until the
        // depinning pull (growing as the drop thins) exceeds its strength,
        // so strength reads as a hold time and weak arcs keep only the thin
        // early-time ring — gap edges taper instead of stepping. Strength
        // maps to hold time linearly: steeper maps (strength², A/B-tested)
        // release the moderate arcs that carry most of the rim and bleach
        // the ring wholesale.
        // Anchor strength is the fraction of the epoch a fence sector holds
        // before releasing — the same linear strength→hold-time map as
        // partial rims, so fence gaps taper instead of stepping, and the
        // weakest sectors never anchor at all (the fence's true gaps).
        const anchorHolds =
          !epoch.anchors ||
          t < epoch.tStart + epoch.anchors[bin] * (tEnd - epoch.tStart);
        if (anchorHolds && (!pinningAt || t < pinningAt(theta[i]) * tEnd)) {
          // Jammed at the growing solid-liquid interface — on the arrest
          // contour where a hole is still deepening (the snowplow).
          alive[i] = 0;
          aliveCount--;
          depositMass[bin]++;
          deposits.push({
            rho: Math.max(0, floorBins[bin] * (1 - w) - Math.abs(rng.gaussian()) * GRAIN),
            theta: theta[i],
            t,
            pinned: true,
          });
        } else {
          // Locally receding line: swept back into the liquid, measured
          // inward from the interface (not the contact line — at high φ that
          // would land inside the solid ring), sloshed along the rim. The
          // kick scales as √dt: re-offers happen once per step, so an
          // unscaled kick makes slosh diffusion (and how far released
          // particles migrate before re-pinning) a function of step count —
          // render, animation, and tests all use different counts.
          rho[i] = interface_ * (1 - 0.02 - 0.05 * rng.random());
          theta[i] += rng.gaussian() * sloshKick * (bandAspect ?? 1);
        }
      } else {
        rho[i] = r;
      }
    }
    s++;
  };

  // Terminal: dries the drop out wherever it stands. Suspended particles
  // settle, the run ends (done, no live particles, step() a no-op), and every
  // read afterwards is the final state — calling it early is "the water ran
  // out now", not a pause.
  const finish = () => {
    if (finished) return;
    // "The water ran out now": an early call settles its leftovers at the
    // current clock. Natural completion and free recession are real dry-outs
    // and keep tEnd — the animation timeline is built on those dates.
    const tStop = isDone() ? tEnd : s * dt;
    finished = true;
    if (!freeRecession) recordEpoch(null);

    // Interior settlement: if the liquid was still pinned at dry-out the
    // residue stays where it was (the dense speckle of high-φ interiors); if
    // the line was receding — free recession, or mid-depinning at tEnd — the
    // sweep organizes it into arcs, spokes, and dots.
    const sweeping = freeRecession || events[events.length - 1].tOnset !== null;
    events[events.length - 1].interiorMode = sweeping ? 'recession' : 'pinned';
    const leftovers = [];
    for (let i = 0; i < particles; i++) {
      if (alive[i]) leftovers.push({ rho: rho[i], theta: theta[i] });
    }
    alive.fill(0);
    aliveCount = 0;
    if (sweeping) {
      deposits.push(
        ...settleInterior({
          items: leftovers,
          total: particles,
          tEnd: tStop,
          rng,
          forceSink: interiorSink,
          cuspSpacing: 0.05 + 0.02 * rng.random(),
          aspect: bandAspect,
        }).deposits,
      );
    } else {
      for (const p of leftovers) {
        deposits.push({ rho: p.rho, theta: p.theta, t: tStop, pinned: false, sink: 'residue' });
      }
    }
  };

  return {
    rho,
    theta,
    alive,
    deposits,
    events,
    get t() { return s * dt; },
    get done() { return isDone(); },
    get aliveCount() { return aliveCount; },
    get base() { return epoch.base; },
    get ringW() { return epoch.growth.w; },
    step() { if (!isDone()) stepOnce(); },
    finish,
  };
}

export function simulateDrop(options) {
  const sim = makeDropStepper(options);
  while (!sim.done) sim.step();
  sim.finish();
  return { deposits: sim.deposits, events: sim.events };
}

// Supply profile for rim drips: each drip is a finite volume wicking both
// ways along the channel between the cup rim and the surface. Compact
// support with a smooth maximum at the drip (finite-volume corner spreading
// — a Barenblatt-type similarity profile, not Washburn's infinite-reservoir
// law, and not linear-in-s, which would cusp):
// m(θ) = Σ_k w_k · max(0, 1 − (s_k/L_k)²)^γ_k with s_k the arc distance
// from lobe k's origin and w_k its volume scale. Lobes that touch merge
// (masses add); lobes that don't leave dry gaps between them. The sampler
// normalizes total mass automatically (every particle lands in a wetted
// arc), so a shorter reach concentrates the same volume — thicker, darker
// near the drip. relDensityAt is mass density relative to a uniform ring;
// a single lobe with L ≫ π reads as uniform.
export function makeSupplySampler(lobes = [{}]) {
  if (!Array.isArray(lobes) || lobes.length === 0) {
    throw new RangeError('makeSupplySampler needs at least one lobe');
  }
  const parsed = lobes.map(
    ({ originTheta = 0, arcHalfLength = Math.PI, falloff = 1, weight = 1 }) => ({
      origin: wrap(originTheta),
      L: arcHalfLength,
      falloff,
      weight,
    }),
  );
  // A lobe is a reach and a volume: both are lengths, both strictly positive.
  // Origin and falloff get the same door — a NaN in either poisons the CDF
  // into all-NaN, which the zero-mass guard below cannot see (NaN <= 0 is
  // false), and the sampler would hand back NaN density.
  for (const lobe of parsed) {
    if (!Number.isFinite(lobe.origin)) {
      throw new RangeError('lobe originTheta must be finite');
    }
    if (!Number.isFinite(lobe.L) || lobe.L <= 0) {
      throw new RangeError(`lobe arcHalfLength must be finite and positive, got ${lobe.L}`);
    }
    if (!Number.isFinite(lobe.falloff) || lobe.falloff <= 0) {
      throw new RangeError(`lobe falloff must be finite and positive, got ${lobe.falloff}`);
    }
    if (!Number.isFinite(lobe.weight) || lobe.weight <= 0) {
      throw new RangeError(`lobe weight must be finite and positive, got ${lobe.weight}`);
    }
  }
  const massAt = (theta) => {
    let m = 0;
    for (const lobe of parsed) {
      let s = Math.abs(wrap(theta) - lobe.origin);
      if (s > Math.PI) s = TWO_PI - s;
      if (s >= lobe.L) continue;
      const u = 1 - (s / lobe.L) * (s / lobe.L);
      m += lobe.weight * Math.pow(u, lobe.falloff);
    }
    return m;
  };
  // The CDF grid spans the whole circle: lobes can sit anywhere on the rim.
  const N = 2048;
  const cdf = new Float64Array(N + 1);
  for (let k = 0; k < N; k++) {
    const theta = ((k + 0.5) / N) * TWO_PI;
    cdf[k + 1] = cdf[k] + massAt(theta);
  }
  const total = cdf[N];
  // Every lobe carries mass, but a reach below the grid spacing can still
  // fall between bin centers; normalizing by that would hand back NaN.
  if (total <= 0) {
    throw new RangeError('supply lobes integrate to zero mass: reach is below the sampling grid');
  }
  const integral = total * (TWO_PI / N);
  const relDensityAt = (theta) => (massAt(theta) * TWO_PI) / integral;
  const sample = (rng) => {
    const target = rng.random() * total;
    // First bin with cdf[k+1] > target: zero-mass bins (flat cdf) can never
    // be selected, so samples always land inside a wetted arc.
    let lo = 0;
    let hi = N - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid + 1] <= target) lo = mid + 1;
      else hi = mid;
    }
    const frac = (target - cdf[lo]) / (cdf[lo + 1] - cdf[lo] || 1);
    return ((lo + frac) / N) * TWO_PI;
  };
  return { massAt, relDensityAt, sample };
}

// Band width from local supply density: V_r = πRw²θc, so deposited mass per
// unit arc goes as w² and width as √density. Floored so the wash polygon
// degenerates to a sliver (not a self-intersection) in the dry gap; capped so
// crescent lobes stay plausible.
export function widthFactor(relDensity) {
  return Math.min(1.8, Math.max(0.04, Math.sqrt(relDensity)));
}

// A mug-bottom ring: liquid sits only in an annular band under the cup rim,
// with pinned contact lines on BOTH sides and the evaporation-driven flow
// diverging toward each. Not a separate simulation — the band is the drop
// stepper run twice, mirrored about the band midline. Each half maps
// ρ ∈ [0,1] as "distance from the midline toward that side's edge" over the
// transverse coordinate u = side·ρ: the contact line at ρ = 1 is the band
// edge, and ρ = 0 is the midline, where the flow vanishes by symmetry — the
// same boundary condition as a drop center. A line receding toward ρ = 0 is
// therefore inward for the outer half and outward for the inner half; the
// annulus contracting in two directions is the mirror, not new physics.
// The halves share the rng stream but not particles: each dries on its own
// solute share (midline crossings were rare and inert in the old 1-D toy).
// All the φ physics — τ_d depinning, epochs, anchor fields, holes and
// arches, interior sinks — runs per edge unchanged; `aspect` = w/R_mid
// tells the stepper what a radian costs. The center of the cup's footprint
// stays dry — no deposit ever lands there.
export function simulateBand({
  particles = 2500,
  steps = 300,
  tEnd = 0.98,
  diffusion = 0.02,
  phi = 0.01,
  aspect = 0.12,
  sampleTheta = null,
  pinningAt = null,
  rng,
} = {}) {
  if (!rng) throw new Error('simulateBand requires a seeded rng');
  const nOuter = Math.round(particles / 2);
  const deposits = [];
  const events = {};
  for (const [side, count, key] of [
    [1, nOuter, 'outer'],
    [-1, particles - nOuter, 'inner'],
  ]) {
    const half = simulateDrop({
      particles: count,
      steps,
      tEnd,
      diffusion,
      phi,
      bandAspect: aspect,
      sampleTheta,
      pinningAt,
      rng,
    });
    for (const d of half.deposits) deposits.push({ ...d, u: side * d.rho, side });
    events[key] = half.events;
  }
  return { deposits, events };
}
