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
export function traceCuspFront({ rho0, spacing, wander, rng }) {
  let thetas = [];
  const count0 = Math.max(3, Math.round((TWO_PI * rho0) / spacing));
  const offset = rng.uniform(0, TWO_PI / count0);
  for (let k = 0; k < count0; k++) {
    thetas.push(offset + (k / count0) * TWO_PI + rng.gaussian() * 0.15 * (spacing / rho0));
  }
  const levels = [{ rho: rho0, thetas: [...thetas] }];
  for (let rho = rho0 - FRONT_STEP; rho > 0; rho -= FRONT_STEP) {
    const sigma = (wander * FRONT_STEP) / Math.max(rho, 0.12);
    thetas = thetas.map((th) => th + rng.gaussian() * sigma).sort((a, b) => wrap(a) - wrap(b));
    const target = Math.max(3, Math.round((TWO_PI * rho) / spacing));
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
}) {
  const sorted = [...items].sort((a, b) => b.rho - a.rho);
  if (sorted.length === 0) return { deposits: [], cuspLevels: [] };
  const arcSpacing = 0.05 + 0.04 * rng.random();
  const rho0 = Math.max(sorted[0].rho, 0.1);
  const cuspLevels = traceCuspFront({ rho0, spacing: cuspSpacing, wander: cuspWander, rng });
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
      const level = clamp01(Math.round(p.rho / arcSpacing) * arcSpacing + rng.gaussian() * 0.002);
      deposits.push({
        rho: level,
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
export function simulateDrop({
  particles = 3000,
  steps = 300,
  tEnd = 0.98,
  diffusion = 0.02,
  phi = 0.01,
  depinSchedule = null,
  holeSchedule = null,
  interiorSink = null, // test-only: force the recession-pass sink
  pinningAt = null, // θ → [0,1] strength, read as hold fraction of the drying
  rng,
} = {}) {
  if (!rng) throw new Error('simulateDrop requires a seeded rng');

  const dt = tEnd / steps;
  const rho = new Float64Array(particles);
  const theta = new Float64Array(particles);
  const alive = new Uint8Array(particles).fill(1);
  for (let i = 0; i < particles; i++) {
    rho[i] = Math.sqrt(rng.random()); // uniform over the disk
    theta[i] = rng.uniform(0, 2 * Math.PI);
  }
  let aliveCount = particles;

  const deposits = [];
  const events = [];
  const depositMass = new Float64Array(NBINS);

  const forcedDepins = depinSchedule ? [...depinSchedule].sort((a, b) => a.t - b.t) : null;
  let nextForcedDepin = 0;
  const forcedHoles = holeSchedule ? [...holeSchedule].sort((a, b) => a.t - b.t) : null;
  let nextForcedHole = 0;

  const phiEffAt = (tStart) =>
    Math.min(PACKING, (phi * (aliveCount / particles)) / (1 - tStart));

  const newEpoch = (base, tStart, thetaEpoch) => ({
    base,
    tStart,
    thetaEpoch,
    phiEff: phiEffAt(tStart),
    growth: makeRingGrowth({ phi: phiEffAt(tStart) }),
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
    const weights = new Float64Array(NBINS);
    let anyMass = false;
    for (let b = 0; b < NBINS; b++) if (depositMass[b] > 0) anyMass = true;
    for (let b = 0; b < NBINS; b++) {
      const thetaB = ((b + 0.5) / NBINS) * TWO_PI;
      weights[b] = anyMass
        ? 1 / (1 + depositMass[b])
        : pinningAt
          ? 1.01 - pinningAt(thetaB)
          : 1;
    }
    const bin = pickWeightedBin(weights, rng);
    return ((bin + rng.random()) / NBINS) * TWO_PI;
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
      const arcOverR = holeAngularWidth(epoch.phiEff);
      const halfWidth = ((arcOverR / epoch.base) / 2) * rng.uniform(0.7, 1.3);
      // Depth ≈ width·1.3: Fig. 9's cells measure round-to-tall (equivalent
      // diameter ≈ the Fig. 13 arc length), not the shallow scallops a
      // semicircular cap would leave. Width stays the calibrated law.
      const arrestDepth = 1.3 * halfWidth * epoch.base * rng.uniform(0.75, 1.25);
      epoch.holes.push({
        theta: holeAzimuth(),
        halfWidth,
        arrestDepth,
        tNucleated: t,
        growthRate: arrestDepth / (0.03 * rng.uniform(0.7, 1.3)),
        generation: 0,
      });
    }
    if (epoch.tOnset === null) {
      epoch.tOnset = t;
      epoch.wAtDepin = epoch.growth.w;
      // Spread the fence of holes over ~60% of the remaining drying time so
      // the union crosses the severing threshold before dry-out.
      const expectedHoles = TWO_PI / (holeAngularWidth(epoch.phiEff) / epoch.base);
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
        (holeAngularWidth(phiEffAt(t)) / localR / 2) * rng.uniform(0.7, 1.3),
        parent.halfWidth * 0.95,
      );
      const off = rng.uniform(-1, 1) * (parent.halfWidth - halfWidth);
      // Parent floor under the child's centre (the cos² edge profile).
      const edge = Math.cos((Math.PI / 2) * (Math.abs(off) / parent.halfWidth));
      const ownDepth = 1.3 * halfWidth * localR * rng.uniform(0.75, 1.25);
      epoch.holes.push({
        theta: parent.theta + off,
        halfWidth,
        arrestDepth: parent.arrestDepth * edge * edge + ownDepth,
        tNucleated: t,
        growthRate: ownDepth / (0.03 * rng.uniform(0.7, 1.3)),
        generation: parent.generation + 1,
      });
    }
  };

  const recordEpoch = (rNext) => {
    events.push({
      tOnset: epoch.tOnset,
      rBase: epoch.base,
      rNext,
      wAtDepin: epoch.wAtDepin,
      wAtEnd: epoch.growth.w,
      thetaEpoch: epoch.thetaEpoch,
      holes: epoch.holes.map((h) => ({
        theta: h.theta,
        halfWidth: h.halfWidth,
        arrestDepth: h.arrestDepth,
        tNucleated: h.tNucleated,
        generation: h.generation,
      })),
    });
  };

  for (let s = 0; s < steps; s++) {
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

    const kappaBins = buildKappaBins(epoch.base, epoch.holes, t);
    // Arrest contour (holes at full depth): a particle caught by a growing
    // hole rides the receding front and jams where the front will arrest —
    // the snowplow that makes arch walls bright and cell interiors dark.
    // Passing t = ∞ rasterizes every hole at its arrestDepth.
    const floorBins = buildKappaBins(epoch.base, epoch.holes, Infinity);

    // Severing: union of grown holes covers enough of the circumference.
    if (epoch.holes.length > 0) {
      let covered = 0;
      let floorSum = 0;
      for (let b = 0; b < NBINS; b++) {
        if (kappaBins[b] < epoch.base - 1e-6) {
          covered++;
          floorSum += kappaBins[b];
        }
      }
      if (covered / NBINS >= SEVER_COVERAGE) {
        // Severed liquid retracts freely (Fig. 2's post-depin shrink) before
        // self-pinning re-establishes; the retreat distance is part of the
        // unsolved dewetting-vs-pinning competition, so it stays stochastic.
        // Without it the next epoch would pin at the hole floors, ~2% inside
        // the old ring — nested rings would be invisible.
        const retreat = epoch.base * rng.uniform(0.06, 0.14);
        const rNext = Math.max(0.15, floorSum / covered - retreat);
        recordEpoch(rNext);
        if (phiEffAt(t) < FREE_RECESSION_PHI) {
          // Too few particles left to arrest the next generation of holes:
          // the line never re-pins. The interior settles via the recession
          // pass after the loop.
          freeRecession = true;
          break;
        }
        const thetaEpoch = Math.min(1, (1 - t) / Math.pow(rNext, 3));
        epoch = newEpoch(rNext, t, thetaEpoch);
        continue; // rebuild bins next step under the new epoch
      }
    }

    const sigma = Math.sqrt(2 * diffusion * dt);
    for (let i = 0; i < particles; i++) {
      if (!alive[i]) continue;
      const bin = Math.floor((wrap(theta[i]) / TWO_PI) * NBINS);
      const kb = kappaBins[bin];
      const interface_ = kb * (1 - w);
      // The D/rho term is the Itô drift of 2-D Brownian motion's radial
      // coordinate; without it the walk is 1-D-in-rho and piles a 1/r
      // density spike at the centre (the old render hid it with centerFade).
      let r =
        rho[i] +
        (radialVelocity(rho[i] / kb, t) * kb + diffusion / Math.max(rho[i], 0.02)) * dt +
        sigma * rng.gaussian();
      theta[i] += (sigma / Math.max(r, 0.05)) * rng.gaussian();
      if (r < 0) {
        r = -r;
        theta[i] += Math.PI;
      }
      if (r >= interface_) {
        // Pinning is temporal, not a coin flip: an arc holds until the
        // depinning pull (growing as the drop thins) exceeds its strength,
        // so strength reads as a hold time and weak arcs keep only the thin
        // early-time ring — gap edges taper instead of stepping. Strength
        // maps to hold time linearly: steeper maps (strength², A/B-tested)
        // release the moderate arcs that carry most of the rim and bleach
        // the ring wholesale.
        if (!pinningAt || t < pinningAt(theta[i]) * tEnd) {
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
          // would land inside the solid ring), sloshed along the rim.
          rho[i] = interface_ * (1 - 0.02 - 0.05 * rng.random());
          theta[i] += rng.gaussian() * 0.3;
        }
      } else {
        rho[i] = r;
      }
    }
  }

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
  if (sweeping) {
    deposits.push(
      ...settleInterior({
        items: leftovers,
        total: particles,
        tEnd,
        rng,
        forceSink: interiorSink,
        cuspSpacing: 0.05 + 0.02 * rng.random(),
      }).deposits,
    );
  } else {
    for (const p of leftovers) {
      deposits.push({ rho: p.rho, theta: p.theta, t: tEnd, pinned: false, sink: 'residue' });
    }
  }

  return { deposits, events };
}

// Supply profile for a rim drip: finite volume wicking both ways along the
// channel between the cup rim and the surface. Compact support with a smooth
// maximum at the drip (finite-volume corner spreading — a Barenblatt-type
// similarity profile, not Washburn's infinite-reservoir law, and not
// linear-in-s, which would cusp):
// m(θ) = max(0, 1 − (s/L)²)^γ with s the arc distance from the origin.
// The sampler normalizes total mass automatically (every particle lands in
// the wetted arc), so a shorter reach concentrates the same volume — thicker,
// darker near the drip. relDensityAt is mass density relative to a uniform
// ring; L ≫ π reads as uniform.
export function makeSupplySampler({ originTheta = 0, arcHalfLength = Math.PI, falloff = 1 } = {}) {
  const L = arcHalfLength;
  const origin = wrap(originTheta);
  const massAt = (theta) => {
    let s = Math.abs(wrap(theta) - origin);
    if (s > Math.PI) s = TWO_PI - s;
    if (s >= L) return 0;
    const u = 1 - (s / L) * (s / L);
    return Math.pow(u, falloff);
  };
  const N = 512;
  const span = Math.min(L, Math.PI);
  const cdf = new Float64Array(N + 1);
  for (let k = 0; k < N; k++) {
    const theta = origin - span + ((k + 0.5) / N) * 2 * span;
    cdf[k + 1] = cdf[k] + massAt(theta);
  }
  const total = cdf[N];
  const integral = total * ((2 * span) / N);
  const relDensityAt = (theta) => (massAt(theta) * TWO_PI) / integral;
  const sample = (rng) => {
    const target = rng.random() * total;
    let lo = 0;
    let hi = N - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid + 1] < target) lo = mid + 1;
      else hi = mid;
    }
    const frac = (target - cdf[lo]) / (cdf[lo + 1] - cdf[lo] || 1);
    return origin - span + ((lo + frac) / N) * 2 * span;
  };
  return { massAt, relDensityAt, sample, originTheta: origin, arcHalfLength };
}

// Band width from local supply density: V_r = πRw²θc, so deposited mass per
// unit arc goes as w² and width as √density. Floored so the wash polygon
// degenerates to a sliver (not a self-intersection) in the dry gap; capped so
// crescent lobes stay plausible.
export function widthFactor(relDensity) {
  return Math.min(1.8, Math.max(0.04, Math.sqrt(relDensity)));
}

// A mug-bottom ring: liquid sits only in an annular band under the cup rim,
// with pinned contact lines on BOTH sides. The band cross-section behaves
// like a 1D drying drop, so we reuse the same edge-diverging velocity on the
// transverse coordinate u ∈ (−1, 1): −1 inner edge, +1 outer edge. The
// center of the cup's footprint stays dry — no deposit ever lands there.
export function simulateRing({
  particles = 2500,
  steps = 300,
  tEnd = 0.98,
  diffusion = 0.02,
  ringWidth = 0.05,
  sampleTheta = null, // rng → θ; supply profile for crescents (default uniform)
  pinningAt = null,
  rng,
} = {}) {
  if (!rng) throw new Error('simulateRing requires a seeded rng');

  const u = new Float64Array(particles);
  const theta = new Float64Array(particles);
  const alive = new Uint8Array(particles).fill(1);
  for (let i = 0; i < particles; i++) {
    u[i] = rng.uniform(-1, 1);
    theta[i] = sampleTheta ? sampleTheta(rng) : rng.uniform(0, 2 * Math.PI);
  }

  const deposits = [];
  const dt = tEnd / steps;

  for (let s = 0; s < steps; s++) {
    const t = s * dt;
    const sigma = Math.sqrt(2 * diffusion * dt);
    for (let i = 0; i < particles; i++) {
      if (!alive[i]) continue;
      const dir = Math.sign(u[i]) || (rng.random() < 0.5 ? -1 : 1);
      const v = u[i] + dir * radialVelocity(Math.abs(u[i]), t) * dt + sigma * rng.gaussian();
      theta[i] += sigma * 0.3 * rng.gaussian();
      if (Math.abs(v) >= 1) {
        // Same temporal gate as the sessile drop: strength = hold fraction.
        if (!pinningAt || t < pinningAt(theta[i]) * tEnd) {
          alive[i] = 0;
          deposits.push({
            u: Math.sign(v) * (1 - Math.abs(rng.gaussian()) * ringWidth),
            theta: theta[i],
            t,
            pinned: true,
          });
        } else {
          // Receding arc: swept back into the band, sloshed along it. The
          // narrow band re-delivers particles to the edge quickly, so the
          // sweep-back and slosh are stronger than the sessile-drop case.
          u[i] = Math.sign(v) * (1 - 0.15 - 0.25 * rng.random());
          theta[i] += rng.gaussian() * 0.45;
        }
      } else {
        u[i] = v;
      }
    }
  }

  for (let i = 0; i < particles; i++) {
    if (alive[i]) deposits.push({ u: u[i], theta: theta[i], t: tEnd, pinned: false });
  }

  return { deposits };
}
