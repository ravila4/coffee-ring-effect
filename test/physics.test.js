import test from 'node:test';
import assert from 'node:assert/strict';
import {
  radialVelocity,
  simulateDrop,
  simulateRing,
  buildKappaBins,
  holeAngularWidth,
  pickWeightedBin,
  depinOnset,
  chooseInteriorSink,
  settleInterior,
} from '../src/physics.js';
import { makeRng } from '../src/rng.js';

const normalizeTheta = (theta) => ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

test('radial velocity vanishes at the drop center', () => {
  assert.equal(radialVelocity(0, 0), 0);
  assert.ok(radialVelocity(1e-9, 0) < 1e-6);
});

test('radial velocity increases monotonically toward the contact line', () => {
  let prev = 0;
  for (let rho = 0.05; rho < 0.995; rho += 0.05) {
    const v = radialVelocity(rho, 0);
    assert.ok(v > prev, `not monotonic at rho=${rho}`);
    prev = v;
  }
});

test('radial velocity diverges near the pinned contact line', () => {
  assert.ok(radialVelocity(0.99999, 0) > 100 * radialVelocity(0.5, 0));
});

test('radial velocity accelerates as the drop dries out', () => {
  assert.ok(radialVelocity(0.5, 0.9) > radialVelocity(0.5, 0));
});

// --- contact-line bins and holes ---

test('kappa bins equal the base radius when there are no holes', () => {
  const bins = buildKappaBins(0.9, [], 0.5, 64);
  assert.equal(bins.length, 64);
  for (const k of bins) assert.equal(k, 0.9);
});

test('a hole dips the contact line only inside its angular window', () => {
  const hole = { theta: Math.PI, halfWidth: 0.3, arrestDepth: 0.05, tNucleated: 0.4, growthRate: 1 };
  const bins = buildKappaBins(1, [hole], 0.6, 256);
  for (let b = 0; b < 256; b++) {
    const theta = ((b + 0.5) / 256) * 2 * Math.PI;
    const inside = Math.abs(theta - Math.PI) < 0.3;
    if (inside) assert.ok(bins[b] <= 1, `no dip inside at θ=${theta}`);
    else assert.ok(Math.abs(bins[b] - 1) < 1e-12, `dip outside window at θ=${theta}`);
  }
  const center = bins[128];
  assert.ok(center < 1 - 0.04, `center depth ${1 - center} < expected`);
});

test('hole depth grows over time and arrests at arrestDepth', () => {
  const hole = { theta: 0.5, halfWidth: 0.2, arrestDepth: 0.06, tNucleated: 0.4, growthRate: 0.5 };
  const binOf = (t) => buildKappaBins(1, [hole], t, 512)[Math.floor((0.5 / (2 * Math.PI)) * 512)];
  const early = 1 - binOf(0.42);
  const mid = 1 - binOf(0.46);
  const late = 1 - binOf(0.9);
  assert.ok(early < mid, 'depth not growing');
  assert.ok(mid < late + 1e-12, 'depth shrank');
  // Bin center sits within half a bin of the hole center, so the sampled
  // depth is arrestDepth·cos²(ε), not exactly arrestDepth.
  assert.ok(Math.abs(late - 0.06) < 1e-3, `did not arrest at 0.06: ${late}`);
});

test('weighted azimuth pick lands by cumulative weight (stubbed rng)', () => {
  const weights = new Float64Array([0, 1, 0, 3]);
  assert.equal(pickWeightedBin(weights, { random: () => 0.1 }), 1);
  assert.equal(pickWeightedBin(weights, { random: () => 0.5 }), 3);
  assert.equal(pickWeightedBin(weights, { random: () => 0.99 }), 3);
});

test('overlapping holes compose by max (union), not sum', () => {
  const mk = (theta) => ({ theta, halfWidth: 0.3, arrestDepth: 0.05, tNucleated: 0, growthRate: 10 });
  const single = buildKappaBins(1, [mk(1.0)], 1, 512);
  const overlapped = buildKappaBins(1, [mk(1.0), mk(1.05)], 1, 512);
  const minSingle = Math.min(...single);
  const minOverlap = Math.min(...overlapped);
  assert.ok(minOverlap >= minSingle - 1e-12, `sum-like recession: ${minOverlap} < ${minSingle}`);
});

test('arch angular width shrinks with concentration and stays floored', () => {
  assert.ok(holeAngularWidth(0.001) > holeAngularWidth(0.01));
  assert.ok(holeAngularWidth(0.05) > 0, 'width must stay positive past the law zero');
});

// --- simulateDrop: the reworked API ---

test('every particle ends up deposited (mass conservation)', () => {
  const { deposits } = simulateDrop({ particles: 500, phi: 0.01, rng: makeRng(101) });
  assert.equal(deposits.length, 500);
});

test('deposits stay within the drop footprint', () => {
  const { deposits } = simulateDrop({ particles: 800, phi: 0.01, rng: makeRng(102) });
  for (const d of deposits) {
    assert.ok(d.rho >= 0 && d.rho <= 1 + 1e-9, `rho out of range: ${d.rho}`);
  }
});

test('most mass concentrates at the rim (the coffee-ring effect)', () => {
  const { deposits } = simulateDrop({ particles: 2000, phi: 0.01, rng: makeRng(103) });
  const rim = deposits.filter((d) => d.rho > 0.85).length;
  assert.ok(rim / deposits.length >= 0.6, `rim fraction ${rim / deposits.length}`);
});

test('ring radial spread grows with concentration', () => {
  // Appendix: w_d/R ~ 6x wider at phi=0.02 vs 0.002. Suppress depinning
  // (empty schedule) so the comparison sees a single clean epoch.
  const spread = (phi, seed) => {
    const { deposits } = simulateDrop({
      particles: 2500,
      phi,
      depinSchedule: [],
      rng: makeRng(seed),
    });
    const pinned = deposits.filter((d) => d.pinned).map((d) => d.rho);
    pinned.sort((a, b) => a - b);
    return pinned[Math.floor(pinned.length * 0.9)] - pinned[Math.floor(pinned.length * 0.05)];
  };
  let wins = 0;
  for (const seed of [201, 202, 203]) {
    if (spread(0.02, seed) > 2 * spread(0.002, seed)) wins++;
  }
  assert.ok(wins >= 2, `high-phi ring not consistently wider (${wins}/3 seeds)`);
});

test('emergent depin onset lands on the measured power law', () => {
  const dt = 0.98 / 300;
  for (const phi of [0.001, 0.01]) {
    const { events } = simulateDrop({ particles: 400, phi, rng: makeRng(104) });
    const expected = depinOnset(phi);
    assert.ok(events[0].tOnset !== null, `no depin at phi=${phi}`);
    assert.ok(
      Math.abs(events[0].tOnset - expected) <= 2 * dt,
      `tOnset ${events[0].tOnset} vs ${expected} at phi=${phi}`,
    );
  }
});

test('an empty depin schedule suppresses depinning entirely', () => {
  const { events } = simulateDrop({ particles: 300, phi: 0.02, depinSchedule: [], rng: makeRng(105) });
  assert.equal(events.length, 1);
  assert.equal(events[0].tOnset, null);
  assert.equal(events[0].holes.length, 0);
});

test('forcing the schedule at the emergent onsets reproduces the emergent run', () => {
  const a = simulateDrop({ particles: 600, phi: 0.005, rng: makeRng(106) });
  const onsets = a.events.filter((e) => e.tOnset !== null).map((e) => ({ t: e.tOnset }));
  assert.ok(onsets.length > 0, 'emergent run never depinned; test is vacuous');
  const b = simulateDrop({
    particles: 600,
    phi: 0.005,
    depinSchedule: onsets,
    rng: makeRng(106),
  });
  assert.deepEqual(b.events, a.events);
  assert.deepEqual(b.deposits, a.deposits);
});

test('a forced hole leaves an arch: deposits trace its window below the ring', () => {
  const hole = { t: 0.5, theta: Math.PI / 2, halfWidth: 0.25, arrestDepth: 0.07 };
  const { deposits, events } = simulateDrop({
    particles: 3000,
    phi: 0.008,
    holeSchedule: [hole],
    rng: makeRng(107),
  });
  assert.equal(events[0].holes.filter((h) => h.generation === 0).length, 1);
  const wFinal = events[0].wAtEnd;
  const ringFloor = 1 - wFinal - 0.02; // below the un-holed interface band
  const arch = deposits.filter((d) => d.pinned && d.rho < ringFloor && d.rho > 1 - 0.07 - wFinal - 0.03);
  assert.ok(arch.length > 0, 'no arch deposits below the ring');
  for (const d of arch) {
    const off = Math.abs(normalizeTheta(d.theta) - Math.PI / 2);
    assert.ok(off < 0.25 + 0.15, `arch deposit far outside hole window: Δθ=${off}`);
  }
});

test('an arrested arch hosts the next generation of holes (subarches)', () => {
  // Fig. 11: large arches are composed of multiple subarches — holes nucleate
  // on the new contact line an arrested arch creates, not just the rim.
  const hole = { t: 0.45, theta: Math.PI / 2, halfWidth: 0.3, arrestDepth: 0.06 };
  const { events } = simulateDrop({
    particles: 2500,
    phi: 0.01,
    holeSchedule: [hole],
    rng: makeRng(401),
  });
  const children = events[0].holes.filter((h) => h.generation > 0);
  assert.ok(children.length > 0, 'no subarches nucleated');
  const dt = 0.98 / 300;
  for (const c of children) {
    // A forced hole arrests at tNucleated + 0.03; children only after that.
    assert.ok(c.tNucleated >= 0.45 + 0.03 - dt, `child before parent arrest: t=${c.tNucleated}`);
    const off = Math.abs(normalizeTheta(c.theta) - Math.PI / 2);
    assert.ok(off + c.halfWidth <= 0.3 + 1e-9, `child window pokes outside the parent arch`);
    assert.ok(c.halfWidth < 0.3, 'child as wide as its parent');
  }
});

test('subarch deposits build a second fence below the parent arch floor', () => {
  // Low phi → large subarches (Fig. 13), so the child fence separates
  // cleanly from the parent floor's grain jitter.
  const hole = { t: 0.4, theta: Math.PI / 2, halfWidth: 0.3, arrestDepth: 0.05 };
  const { deposits, events } = simulateDrop({
    particles: 4000,
    phi: 0.005,
    holeSchedule: [hole],
    rng: makeRng(402),
  });
  const children = events[0].holes.filter((h) => h.generation > 0);
  assert.ok(children.length > 0, 'no subarches nucleated');
  const deepest = Math.max(...children.map((h) => h.arrestDepth));
  assert.ok(deepest > 0.06, `no child carved below the parent floor: ${deepest}`);
  // Child holes carve below the parent's arrest floor, so pinned deposits
  // must appear deeper than the parent fence within the hole's window.
  const wEnd = events[0].wAtEnd;
  const parentFloor = (1 - 0.05) * (1 - wEnd);
  const deeper = deposits.filter((d) => {
    const off = Math.abs(normalizeTheta(d.theta) - Math.PI / 2);
    return d.pinned && off < 0.3 && d.rho < parentFloor - 0.015;
  });
  assert.ok(deeper.length >= 5, `only ${deeper.length} deposits below the parent arch floor`);
});

test('a growing hole snowplows swept particles onto its arrest contour', () => {
  // The paper's arch walls are bright: particles caught by the receding
  // front ride it and jam at the arrest line ("walled in by jamming
  // particles"). Deposits caught mid-growth must land on the arch contour,
  // not smear across the swept area — the cell interiors stay dark.
  const hole = { t: 0.5, theta: Math.PI / 2, halfWidth: 0.25, arrestDepth: 0.08 };
  const { deposits, events } = simulateDrop({
    particles: 5000,
    phi: 0.01,
    holeSchedule: [hole],
    rng: makeRng(404),
  });
  // Core of the window during the growth window only (a forced hole arrests
  // at t + 0.03): where its own floor is the deepest contour and subarches
  // have not yet nucleated.
  const grow = deposits.filter((d) => {
    const off = Math.abs(normalizeTheta(d.theta) - Math.PI / 2);
    return d.pinned && off < 0.1 && d.t >= 0.5 && d.t < 0.53;
  });
  assert.ok(grow.length >= 5, `too few growth-window deposits to judge: ${grow.length}`);
  // Arch contour follows the hole's cos² edge profile: at azimuthal offset
  // ε the floor is 1 − 0.08·cos²((π/2)(ε/0.25)). With w ≥ wAtDepin nothing
  // may sit above that contour in the swept band.
  for (const d of grow) {
    const off = Math.abs(normalizeTheta(d.theta) - Math.PI / 2);
    const edge = Math.cos((Math.PI / 2) * (off / 0.25));
    // Slack covers grain jitter plus half-bin quantization of the contour.
    const wall = (1 - 0.08 * edge * edge) * (1 - events[0].wAtDepin) + 0.008;
    assert.ok(d.rho <= wall, `mid-growth deposit smeared at rho=${d.rho.toFixed(3)} > ${wall.toFixed(3)}`);
  }
});

test('subarch recursion is bounded and tagged by generation', () => {
  const { events } = simulateDrop({ particles: 2000, phi: 0.02, rng: makeRng(403) });
  let sawChild = false;
  for (const e of events) {
    for (const h of e.holes) {
      assert.ok(Number.isInteger(h.generation) && h.generation >= 0, 'untagged hole');
      assert.ok(h.generation <= 2, `runaway recursion: generation ${h.generation}`);
      if (h.generation > 0) sawChild = true;
    }
  }
  assert.ok(sawChild, 'a rich drop nucleated no subarches at all');
});

test('severing occurs when hole coverage passes ~63% and starts a new epoch', () => {
  // Force a dense fence of holes; coverage crosses the union threshold.
  const holes = [];
  for (let k = 0; k < 40; k++) {
    holes.push({ t: 0.4 + 0.002 * k, theta: (k / 40) * 2 * Math.PI, halfWidth: 0.16, arrestDepth: 0.05 });
  }
  const { events } = simulateDrop({ particles: 800, phi: 0.008, holeSchedule: holes, rng: makeRng(108) });
  assert.ok(events.length >= 2, `no second epoch: ${events.length}`);
  assert.ok(events[0].rNext < events[0].rBase, 'epoch radius did not shrink');
  assert.equal(events[1].rBase, events[0].rNext);
});

test('events are ordered and internally consistent', () => {
  const { events } = simulateDrop({ particles: 1500, phi: 0.012, rng: makeRng(109) });
  let prevOnset = -1;
  let prevBase = 1 + 1e-9;
  for (const e of events) {
    assert.ok(e.rBase < prevBase, 'epoch radii must decrease');
    if (e.tOnset !== null) {
      assert.ok(e.tOnset > prevOnset, 'onsets must be ordered');
      assert.ok(e.wAtDepin > 0, 'ring width at depin must be positive');
      prevOnset = e.tOnset;
    }
    for (const h of e.holes) {
      assert.ok(h.halfWidth > 0 && h.arrestDepth > 0);
      assert.ok(h.tNucleated >= (e.tOnset ?? 0) - 1e-9);
    }
    prevBase = e.rBase;
  }
});

test('simulation is deterministic for a given seed', () => {
  const a = simulateDrop({ particles: 300, phi: 0.01, rng: makeRng(110) });
  const b = simulateDrop({ particles: 300, phi: 0.01, rng: makeRng(110) });
  assert.deepEqual(a.deposits, b.deposits);
  assert.deepEqual(a.events, b.events);
});

test('simulation requires a seeded rng', () => {
  assert.throws(() => simulateDrop({ particles: 10 }));
});

test('unpinned sectors collect no jammed ring deposits (partial rings)', () => {
  const pinningAt = (theta) => (normalizeTheta(theta) < Math.PI ? 0 : 1);
  const { deposits } = simulateDrop({
    particles: 2000,
    phi: 0.01,
    depinSchedule: [],
    pinningAt,
    rng: makeRng(111),
  });
  const jammed = deposits.filter((d) => d.pinned);
  assert.ok(jammed.length > 0, 'no jammed deposits at all');
  const inGap = jammed.filter((d) => normalizeTheta(d.theta) < Math.PI);
  assert.equal(inGap.length, 0, `${inGap.length} jammed deposits inside the unpinned arc`);
});

test('unpinned arcs end up visibly thinner than pinned arcs', () => {
  const pinningAt = (theta) => (normalizeTheta(theta) < Math.PI ? 0.02 : 1);
  const { deposits } = simulateDrop({
    particles: 3000,
    phi: 0.01,
    depinSchedule: [],
    pinningAt,
    rng: makeRng(112),
  });
  // Rim darkness is carried by jammed deposits — residue paints at ~4x lower
  // alpha — so the visible-thinness claim is about pinned mass.
  const rim = deposits.filter((d) => d.pinned && d.rho > 0.85);
  const gap = rim.filter((d) => normalizeTheta(d.theta) < Math.PI).length;
  const pinned = rim.filter((d) => normalizeTheta(d.theta) >= Math.PI).length;
  assert.ok(gap < 0.3 * pinned, `gap arc has ${gap} rim deposits vs ${pinned} on the pinned arc`);
});

test('mass is conserved with a pinning gate', () => {
  const pinningAt = (theta) => (normalizeTheta(theta) < Math.PI ? 0 : 1);
  const { deposits } = simulateDrop({ particles: 800, phi: 0.01, pinningAt, rng: makeRng(113) });
  assert.equal(deposits.length, 800);
});

test('gap edges taper: deposit density falls gradually across a pinning ramp', () => {
  // Strength ramps 1 → 0 over [π, 1.5π]. A marginal arc holds early and
  // tears free late, so its deposit is the partial-time ring — the gap edge
  // must fade out, not step.
  const ramp = (theta) => {
    const th = normalizeTheta(theta);
    if (th < Math.PI) return 1;
    if (th < 1.5 * Math.PI) return 1 - (th - Math.PI) / (0.5 * Math.PI);
    return 0;
  };
  const { deposits } = simulateDrop({
    particles: 6000,
    phi: 0.01,
    depinSchedule: [],
    pinningAt: ramp,
    rng: makeRng(114),
  });
  const pinned = deposits.filter((d) => d.pinned);
  const binWidth = (0.5 * Math.PI) / 5;
  const rampBins = new Array(5).fill(0);
  let strong = 0;
  for (const d of pinned) {
    const th = normalizeTheta(d.theta);
    if (th >= 0.2 * Math.PI && th < 0.8 * Math.PI) strong++;
    if (th >= Math.PI && th < 1.5 * Math.PI) rampBins[Math.floor((th - Math.PI) / binWidth)]++;
  }
  const strongPerBin = strong / ((0.6 * Math.PI) / binWidth);
  assert.ok(strongPerBin > 50, `too few deposits to judge: ${strongPerBin}/bin`);
  assert.ok(
    rampBins[0] > rampBins[2] && rampBins[2] > rampBins[4],
    `ramp not monotone: ${rampBins}`,
  );
  // Mid-ramp stays fairly high (~0.8): displaced gap mass sloshes onto the
  // still-holding arcs and inflates the strong half of the transition. The
  // taper lives in the weak half; the coin-flip gate put ~1.0 here and rose
  // toward the gap.
  const mid = rampBins[2] / strongPerBin;
  assert.ok(mid > 0.05 && mid < 0.92, `mid-ramp density ${mid.toFixed(2)} of full: not a taper`);
});

test('a marginal arc only collects deposits from before its release time', () => {
  // The temporal signature that distinguishes a taper from a thinned coin
  // flip: where strength is ~0.1–0.4, everything deposited must date from
  // the early fraction of the drying — no late arrivals stick there.
  const ramp = (theta) => {
    const th = normalizeTheta(theta);
    if (th < Math.PI) return 1;
    if (th < 1.5 * Math.PI) return 1 - (th - Math.PI) / (0.5 * Math.PI);
    return 0;
  };
  const { deposits } = simulateDrop({
    particles: 6000,
    phi: 0.01,
    depinSchedule: [],
    pinningAt: ramp,
    rng: makeRng(114),
  });
  const late = deposits.filter((d) => {
    const th = normalizeTheta(d.theta);
    return d.pinned && th >= 1.3 * Math.PI && th < 1.45 * Math.PI && d.t > 0.45;
  });
  assert.equal(late.length, 0, `${late.length} late deposits on a weak arc`);
});

// --- interior recession pass: arcs, spokes, dots ---

test('interior sink weights shift arc → spoke → dot as the load depletes', () => {
  // Deterministic draw at fixed quantile: high load picks arcs (erratic
  // stick-slip), mid load radial spokes, near-zero load disorganized dots.
  const at = (load, q) => chooseInteriorSink(load, { random: () => q });
  assert.equal(at(0.3, 0.05), 'arc');
  assert.equal(at(0.05, 0.6), 'spoke');
  assert.equal(at(0.002, 0.9), 'dot');
});

test('interior sink is a genuine mixture in the mixed zone', () => {
  const rng = makeRng(301);
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(chooseInteriorSink(0.12, rng));
  assert.ok(seen.has('arc') && seen.has('spoke'), `mixed zone gave only ${[...seen]}`);
});

const circDist = (a, b) => {
  let off = Math.abs(normalizeTheta(a) - normalizeTheta(b));
  return off > Math.PI ? 2 * Math.PI - off : off;
};

test('spoke-forced interior clusters deposits on the live cusp azimuths', () => {
  const rng = makeRng(302);
  const items = Array.from({ length: 400 }, () => ({
    rho: rng.uniform(0.1, 0.8),
    theta: rng.uniform(0, 2 * Math.PI),
  }));
  const { deposits, cuspLevels } = settleInterior({
    items,
    total: 3000,
    tEnd: 0.98,
    rng,
    forceSink: 'spoke',
  });
  assert.equal(deposits.length, 400);
  // Spokes keep the pickup radius, so the deposit's own rho locates the
  // front level whose cusp set emitted it.
  const offsets = deposits.map((d) => {
    let level = cuspLevels[0];
    for (const l of cuspLevels) {
      if (Math.abs(l.rho - d.rho) < Math.abs(level.rho - d.rho)) level = l;
    }
    let best = Infinity;
    for (const c of level.thetas) best = Math.min(best, circDist(d.theta, c));
    return best / ((2 * Math.PI) / level.thetas.length);
  });
  offsets.sort((a, b) => a - b);
  // Exponential kernel: median offset well inside a quarter of the local
  // spacing, but a tail exists (it is not a delta snap).
  assert.ok(offsets[200] < 0.25, `median offset ${offsets[200]} local spacings`);
  assert.ok(offsets[399] > 0.001, 'no tail at all — delta snap?');
});

test('cusps ride the paper spacing law: ~2πρ/0.06 of them at every front radius', () => {
  // Fig. 14: cusp-to-cusp distance stays ~constant in arc length, so the
  // count scales with the shrinking circumference — ~90 near the rim.
  const rng = makeRng(310);
  const items = Array.from({ length: 600 }, () => ({
    rho: rng.uniform(0.05, 0.9),
    theta: rng.uniform(0, 2 * Math.PI),
  }));
  const { cuspLevels } = settleInterior({ items, total: 3000, tEnd: 0.98, rng, forceSink: 'spoke' });
  assert.ok(cuspLevels.length > 10, `too few front levels: ${cuspLevels.length}`);
  const first = cuspLevels[0];
  assert.ok(first.thetas.length >= 60, `too few cusps at the start: ${first.thetas.length}`);
  let mid = cuspLevels[0];
  for (const l of cuspLevels) {
    if (Math.abs(l.rho - 0.45) < Math.abs(mid.rho - 0.45)) mid = l;
  }
  const expectedMid = (2 * Math.PI * mid.rho) / 0.06;
  assert.ok(
    mid.thetas.length > 0.6 * expectedMid && mid.thetas.length < 1.5 * expectedMid,
    `mid-front count ${mid.thetas.length} vs spacing-law ${expectedMid.toFixed(0)}`,
  );
  const last = cuspLevels[cuspLevels.length - 1];
  assert.ok(
    last.thetas.length <= 0.25 * first.thetas.length,
    `cusps did not merge toward the centre: ${first.thetas.length} → ${last.thetas.length}`,
  );
});

test('cusps wander continuously — veins wiggle, never teleport', () => {
  const rng = makeRng(311);
  const items = Array.from({ length: 500 }, () => ({
    rho: rng.uniform(0.05, 0.9),
    theta: rng.uniform(0, 2 * Math.PI),
  }));
  const { cuspLevels } = settleInterior({ items, total: 3000, tEnd: 0.98, rng, forceSink: 'spoke' });
  // Near the centre the last few cusps converge across wide gaps (the hub);
  // continuity is only a meaningful claim while the front is still wide.
  let maxStep = 0;
  for (let k = 1; k < cuspLevels.length; k++) {
    if (cuspLevels[k].rho < 0.25) break;
    for (const th of cuspLevels[k].thetas) {
      let best = Infinity;
      for (const p of cuspLevels[k - 1].thetas) best = Math.min(best, circDist(th, p));
      maxStep = Math.max(maxStep, best);
      assert.ok(best < 0.5, `cusp teleported by ${best} rad between adjacent levels`);
    }
  }
  assert.ok(maxStep > 0.005, `cusps frozen: max inter-level drift ${maxStep}`);
});

test('arc-forced interior quantizes radii onto few rest levels', () => {
  const rng = makeRng(303);
  const items = Array.from({ length: 300 }, () => ({
    rho: rng.uniform(0.2, 0.9),
    theta: rng.uniform(0, 2 * Math.PI),
  }));
  const { deposits } = settleInterior({ items, total: 3000, tEnd: 0.98, rng, forceSink: 'arc' });
  const levels = new Set(deposits.map((d) => Math.round(d.rho * 200)));
  assert.ok(levels.size < 40, `${levels.size} distinct radius levels — not quantized`);
});

test('dot-forced interior stays near original positions', () => {
  const rng = makeRng(304);
  const items = Array.from({ length: 200 }, () => ({
    rho: rng.uniform(0.1, 0.9),
    theta: rng.uniform(0, 2 * Math.PI),
  }));
  const { deposits } = settleInterior({ items, total: 3000, tEnd: 0.98, rng, forceSink: 'dot' });
  // The pass picks particles up outside-in, so compare the radius
  // distributions, not index-wise.
  const inR = items.map((p) => p.rho).sort((a, b) => a - b);
  const outR = deposits.map((d) => d.rho).sort((a, b) => a - b);
  for (let i = 0; i < inR.length; i++) {
    assert.ok(Math.abs(outR[i] - inR[i]) < 0.05, `dot moved radially at rank ${i}`);
  }
});

test('the drop centre settles as disorganized dots, not a spoke hub', () => {
  // Fig. 9/10: "the central region is composed of apparently disorganized
  // dots" — cusp emission cannot pile the last particles onto a bright hub.
  const { deposits } = simulateDrop({ particles: 15000, phi: 0.0008, rng: makeRng(314) });
  const core = deposits.filter((d) => !d.pinned && d.rho < 0.078);
  assert.ok(core.length > 10, `too few core deposits to judge: ${core.length}`);
  for (const d of core) {
    assert.ok(d.sink === 'dot' || d.sink === 'residue', `${d.sink} deposit at rho=${d.rho}`);
  }
});

test('recession deposits carry their sink tag; rim and pinned residue do not mix in', () => {
  const low = simulateDrop({ particles: 1500, phi: 0.0008, rng: makeRng(312) });
  const sinks = new Set(low.deposits.filter((d) => !d.pinned).map((d) => d.sink));
  assert.ok(sinks.has('spoke') || sinks.has('arc'), `no structural sinks in ${[...sinks]}`);
  for (const d of low.deposits) {
    if (d.pinned) assert.equal(d.sink, undefined, 'rim deposit got a sink tag');
  }
  // A drop still pinned at dry-out settles residue in place, tagged residue.
  const pinnedRun = simulateDrop({ particles: 900, phi: 0.01, depinSchedule: [], rng: makeRng(313) });
  for (const d of pinnedRun.deposits) {
    if (!d.pinned) assert.equal(d.sink, 'residue');
  }
});

test('recession pass conserves mass and stays in the footprint', () => {
  const { deposits } = simulateDrop({ particles: 1200, phi: 0.0008, rng: makeRng(305) });
  assert.equal(deposits.length, 1200);
  for (const d of deposits) assert.ok(d.rho >= 0 && d.rho <= 1 + 1e-9);
});

test('low concentration ends in free recession; pinned drops do not', () => {
  // Below the particle-supply threshold arches cannot arrest, the line never
  // re-pins, and the interior settles through the recession pass.
  const low = simulateDrop({ particles: 1000, phi: 0.0008, rng: makeRng(306) });
  assert.equal(low.events[low.events.length - 1].interiorMode, 'recession');
  const pinnedRun = simulateDrop({ particles: 1000, phi: 0.01, depinSchedule: [], rng: makeRng(307) });
  assert.equal(pinnedRun.events[pinnedRun.events.length - 1].interiorMode, 'pinned');
});

test('interior residue does not pile at the drop centre (2-D Brownian radial drift)', () => {
  // A 1-D random walk in rho with reflection at 0 equilibrates uniform in
  // rho — a 1/r density spike at the centre. The radial coordinate of true
  // 2-D Brownian motion carries an outward D/r Itô drift that kills it.
  const { deposits } = simulateDrop({
    particles: 8000,
    phi: 0.01,
    depinSchedule: [],
    diffusion: 0.02,
    rng: makeRng(500),
  });
  const residue = deposits.filter((d) => !d.pinned);
  const centre = residue.filter((d) => d.rho < 0.1).length / (Math.PI * 0.01);
  const mid = residue.filter((d) => d.rho >= 0.3 && d.rho < 0.4).length / (Math.PI * 0.07);
  assert.ok(mid > 0, 'no mid-interior residue to compare against');
  assert.ok(centre / mid < 2.5, `centre density ${(centre / mid).toFixed(2)}× mid — bullseye`);
});

test('pinned dry-out deposits interior residue in place (regression)', () => {
  const { deposits } = simulateDrop({ particles: 2500, phi: 0.01, depinSchedule: [], rng: makeRng(308) });
  const residue = deposits.filter((d) => !d.pinned);
  assert.ok(residue.length > 50, 'no interior residue at all');
  for (const d of residue) assert.equal(d.t, 0.98);
});

test('interiorSink override forces the mode end-to-end', () => {
  const { deposits } = simulateDrop({
    particles: 1500,
    phi: 0.0008,
    interiorSink: 'arc',
    rng: makeRng(309),
  });
  const residue = deposits.filter((d) => !d.pinned && d.rho > 0.05);
  const levels = new Set(residue.map((d) => Math.round(d.rho * 200)));
  assert.ok(residue.length > 100, `too little residue: ${residue.length}`);
  assert.ok(levels.size < residue.length / 4, `radii not quantized: ${levels.size}/${residue.length}`);
});

// --- mug ring (unchanged API this slice) ---

test('mug-ring sim conserves mass', () => {
  const { deposits } = simulateRing({ particles: 600, rng: makeRng(201) });
  assert.equal(deposits.length, 600);
});

test('mug-ring deposits collect at both band edges', () => {
  const { deposits } = simulateRing({ particles: 3000, rng: makeRng(202) });
  const outer = deposits.filter((d) => d.u > 0.9).length;
  const inner = deposits.filter((d) => d.u < -0.9).length;
  assert.ok((outer + inner) / deposits.length >= 0.55, `edge fraction ${(outer + inner) / deposits.length}`);
  assert.ok(outer / deposits.length >= 0.15, `outer fraction ${outer / deposits.length}`);
  assert.ok(inner / deposits.length >= 0.15, `inner fraction ${inner / deposits.length}`);
});

test('mug-ring deposits stay within the band', () => {
  const { deposits } = simulateRing({ particles: 800, rng: makeRng(203) });
  for (const d of deposits) {
    assert.ok(Math.abs(d.u) <= 1 + 1e-9, `u out of band: ${d.u}`);
  }
});

test('mug-ring sim is deterministic for a given seed', () => {
  const a = simulateRing({ particles: 300, rng: makeRng(204) });
  const b = simulateRing({ particles: 300, rng: makeRng(204) });
  assert.deepEqual(a.deposits, b.deposits);
});

test('mug-ring pinning gate thins unpinned arcs', () => {
  const pinningAt = (theta) => (normalizeTheta(theta) < Math.PI ? 0.02 : 1);
  const { deposits } = simulateRing({ particles: 3000, rng: makeRng(205), pinningAt });
  const edge = deposits.filter((d) => Math.abs(d.u) > 0.9);
  const gap = edge.filter((d) => normalizeTheta(d.theta) < Math.PI).length;
  const pinned = edge.filter((d) => normalizeTheta(d.theta) >= Math.PI).length;
  assert.ok(gap < 0.3 * pinned, `gap arc has ${gap} edge deposits vs ${pinned} pinned`);
});
