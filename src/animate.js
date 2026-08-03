// Time-based animation of a single drying drop: drives makeDropStepper one
// frame at a time and draws the live suspension, the accumulating deposit,
// and side plots. DOM access only happens inside mountDryingAnimation, so
// the pure helpers stay importable under node for tests.

import { RING_COLORS, WASH_COLOR } from './palette.js';
import { makeDropStepper } from './physics.js';
import { makeRng } from './rng.js';

// Playback time warp. The outward velocity diverges as 1/(1−t), so almost
// everything visible happens late; playing t linearly would look becalmed
// and then explode. t = 1 − (1−u)^p concentrates playback near dry-out
// (p = 2: the last quarter of the drying gets half the wall-clock). The UI
// must say so — HUD slow-mo factor and warped scrubber ticks, not a hidden
// remap.
export function warpT(u, p = 2) {
  return 1 - Math.pow(1 - u, p);
}

export function warpU(t, p = 2) {
  return 1 - Math.pow(1 - t, 1 / p);
}

// How much slower the drying clock runs than at playback start: the HUD's
// "×N slow-mo". Infinity at u=1; display code clamps.
export function slowMoFactor(u, p = 2) {
  return Math.pow(1 - u, 1 - p);
}

// Playback fraction → snapshot index, clamped on both ends: rAF timestamps
// can precede the performance.now() sampled when play starts, so the clock
// can tick slightly outside [0,1].
export function frameIndexFor(u, frameCount, p = 2) {
  const t = warpT(Math.min(1, Math.max(0, u)), p);
  return Math.min(frameCount - 1, Math.max(0, Math.floor(t * frameCount)));
}

// Mass by radius. density=true divides by annulus area so the initial
// uniform splash reads flat (= the particle count, since the area fractions
// sum to 1) and the rim spike reads as the coffee-ring effect, not as "more
// area out there".
export function radialHistogram(rho, alive, { bins = 24, density = false } = {}) {
  const h = new Float64Array(bins);
  for (let i = 0; i < rho.length; i++) {
    if (!alive[i]) continue;
    h[Math.min(bins - 1, Math.floor(rho[i] * bins))]++;
  }
  if (density) {
    for (let b = 0; b < bins; b++) {
      const r0 = b / bins;
      const r1 = (b + 1) / bins;
      h[b] /= r1 * r1 - r0 * r0;
    }
  }
  return h;
}

const PAPER = '#fffdf7';
const INK = '#4a3b2a';
const MUTED = '#8a7a60';
const ACCENT = '#8a6b3f';
const HIST_BINS = 28;

// Run the whole sim up front, snapshotting the live suspension after every
// step. Playback and scrubbing are then pure lookups — no re-simulation, no
// rng state to rewind. ~1800 particles × 360 steps ≈ a few MB of Float32.
function precompute({ seed, particles, steps, tEnd, diffusion, phi }) {
  const sim = makeDropStepper({ particles, steps, tEnd, diffusion, phi, rng: makeRng(seed) });
  const frames = [];
  let histMax = particles; // the initial flat density
  while (!sim.done) {
    sim.step();
    const pos = new Float32Array(sim.aliveCount * 2);
    let j = 0;
    for (let i = 0; i < particles; i++) {
      if (sim.alive[i]) {
        pos[j++] = sim.rho[i];
        pos[j++] = sim.theta[i];
      }
    }
    frames.push({
      t: sim.t,
      pos,
      depositCount: sim.deposits.length,
      alive: sim.aliveCount,
      base: sim.base,
      innerEdge: sim.base * (1 - sim.ringW),
    });
  }
  const loopDeposits = sim.deposits.length;
  sim.finish();
  // Fixed y-scale for the histogram panel: the finished stain's profile is
  // where density peaks (the ring holds most of the pigment in a bin or two).
  const ones = new Uint8Array(sim.deposits.length).fill(1);
  const finalHist = radialHistogram(
    Float64Array.from(sim.deposits, (d) => d.rho),
    ones,
    { bins: HIST_BINS, density: true },
  );
  for (const v of finalHist) if (v > histMax) histMax = v;
  return {
    frames,
    deposits: sim.deposits,
    loopDeposits,
    histMax,
    interiorMode: sim.events[sim.events.length - 1].interiorMode,
    particles,
    tEnd,
  };
}

// Everything below is presentation: canvases, the scrubber strip, plots.
export function mountDryingAnimation(container, {
  seed = 1,
  phi = 0.003,
  particles = 1800,
  steps = 360,
  tEnd = 0.97,
  diffusion = 0.02,
  duration = 10000, // wall-clock ms for the drying phase
  sweepDuration = 2200, // ms for the post-dry-out interior sweep
  warpP = 2,
  mainSize = 520,
  plotWidth = 250,
  darkField = false, // microscope view: white deposits on black, no wash
} = {}) {
  let dark = darkField;
  const sim = precompute({ seed, particles, steps, tEnd, diffusion, phi });
  const { frames, deposits, loopDeposits, interiorMode } = sim;
  const tail = deposits.slice(loopDeposits);
  const depositRho = Float64Array.from(deposits, (d) => d.rho);
  const ones = new Uint8Array(Math.max(particles, deposits.length)).fill(1);
  const dpr = Math.min(2, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1);

  // Deposit splat styles are fixed at mount so scrubbing is deterministic.
  // The ×3 on alpha is this view's own: it composites source-over with no
  // wash underlay, so it needs about three times the ink of the static render
  // to reach the same visual weight.
  const styleRng = makeRng((seed ^ 0x5eed) >>> 0);
  const splatStyles = deposits.map((d) => ({
    r: (d.pinned ? 1 : 1.3) * (0.6 + 0.8 * styleRng.random()),
    alpha: (d.pinned ? 0.06 + 0.07 * styleRng.random() : 0.05 + 0.05 * styleRng.random()) * 3,
    color: RING_COLORS[styleRng.int(RING_COLORS.length)],
  }));

  // --- DOM scaffold (inline styles so the blog embed needs no stylesheet) ---
  const root = document.createElement('div');
  root.style.cssText = `display:flex;gap:14px;align-items:flex-start;color:${INK};` +
    'font:12px/1.4 -apple-system,"Helvetica Neue",sans-serif;';
  const left = document.createElement('div');
  const right = document.createElement('div');
  right.style.cssText = `width:${plotWidth}px;display:flex;flex-direction:column;gap:6px;`;
  root.append(left, right);

  const mkCanvas = (w, h, parent) => {
    const c = document.createElement('canvas');
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.cssText = `width:${w}px;height:${h}px;display:block;background:${PAPER};` +
      'border:1px solid #e4d9c2;border-radius:6px;';
    parent.append(c);
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    return [c, ctx];
  };

  const [mainC, mainCtx] = mkCanvas(mainSize, mainSize, left);
  const [scrubC, scrubCtx] = mkCanvas(mainSize, 34, left);
  scrubC.style.border = 'none';
  scrubC.style.background = 'transparent';
  scrubC.style.cursor = 'pointer';
  scrubC.style.touchAction = 'none';
  mainC.style.cursor = 'pointer';

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:2px;';
  const playBtn = document.createElement('button');
  playBtn.style.cssText = 'font:inherit;padding:2px 12px;border:1px solid #b9a888;' +
    `background:${PAPER};border-radius:5px;cursor:pointer;color:${INK};`;
  const hud = document.createElement('span');
  hud.style.cssText = `color:${MUTED};font-variant-numeric:tabular-nums;flex:1;`;
  const darkLabel = document.createElement('label');
  darkLabel.style.cssText = `display:flex;align-items:center;gap:4px;color:${MUTED};cursor:pointer;`;
  const darkBox = document.createElement('input');
  darkBox.type = 'checkbox';
  darkBox.checked = dark;
  darkLabel.append(darkBox, document.createTextNode('dark-field'));
  bar.append(playBtn, hud, darkLabel);
  left.append(bar);

  const plotH = Math.round((mainSize - 2 * 20 - 2 * 6) / 3);
  const caption = (text) => {
    const el = document.createElement('div');
    el.style.cssText = `color:${MUTED};font-size:11px;padding:2px 2px 0;height:18px;`;
    el.textContent = text;
    return el;
  };
  const [, histCtx] = mkCanvas(plotWidth, plotH, right);
  right.append(caption('pigment density vs radius (log scale)'));
  const [, fracCtx] = mkCanvas(plotWidth, plotH, right);
  right.append(caption('suspended vs pinned fraction'));
  const [, radCtx] = mkCanvas(plotWidth, plotH, right);
  right.append(caption('contact line radius · band = solid ring'));

  container.append(root);

  // --- playback state ---
  // v ∈ [0,1] spans the whole wall-clock timeline; the first uSplit of it is
  // the (time-warped) drying, the remainder the interior sweep.
  const total = duration + sweepDuration;
  const uSplit = duration / total;
  let v = 0;
  let playing = false;
  let raf = 0;
  let lastNow = 0;
  let drawnDeposits = 0;

  const R = mainSize * 0.42;
  const cx = mainSize / 2;
  const cy = mainSize / 2;

  const depositLayer = document.createElement('canvas');
  depositLayer.width = mainSize * dpr;
  depositLayer.height = mainSize * dpr;
  const depCtx = depositLayer.getContext('2d');
  depCtx.scale(dpr, dpr);

  const frameFor = (u) => frames[frameIndexFor(u, frames.length, warpP)];

  const depositTargetAt = () => {
    if (v < uSplit) return frameFor(v / uSplit).depositCount;
    return Math.min(
      deposits.length,
      loopDeposits + Math.ceil(((v - uSplit) / (1 - uSplit)) * tail.length),
    );
  };

  const drawDepositsTo = (count) => {
    if (count < drawnDeposits) {
      depCtx.clearRect(0, 0, mainSize, mainSize);
      drawnDeposits = 0;
    }
    for (let i = drawnDeposits; i < count; i++) {
      const d = deposits[i];
      const s = splatStyles[i];
      depCtx.beginPath();
      if (dark) {
        // Deegan's binarized micrographs: deposit scatters light.
        depCtx.arc(cx + d.rho * R * Math.cos(d.theta), cy + d.rho * R * Math.sin(d.theta), Math.max(0.7, s.r * 0.9), 0, 2 * Math.PI);
        depCtx.fillStyle = 'rgba(255,255,255,0.85)';
      } else {
        depCtx.arc(cx + d.rho * R * Math.cos(d.theta), cy + d.rho * R * Math.sin(d.theta), s.r, 0, 2 * Math.PI);
        depCtx.fillStyle = `rgba(${s.color.join(',')},${s.alpha})`;
      }
      depCtx.fill();
    }
    drawnDeposits = count;
  };

  const circle = (ctx, r, stroke, dash = []) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.setLineDash(dash);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  };

  const drawMain = (f, depositTarget) => {
    mainCtx.fillStyle = dark ? '#000' : PAPER;
    mainCtx.fillRect(0, 0, mainSize, mainSize);
    const drying = v < uSplit;
    const tFrac = Math.min(1, f.t / sim.tEnd);

    // Original footprint, always visible so contact-line retreat reads.
    circle(mainCtx, R, dark ? 'rgba(210,200,180,0.25)' : 'rgba(74,59,42,0.18)');

    if (drying) {
      // The liquid: fades as it dries, shrinks when the line depins.
      mainCtx.beginPath();
      mainCtx.arc(cx, cy, f.base * R, 0, 2 * Math.PI);
      mainCtx.fillStyle = dark
        ? `rgba(120,100,80,${(0.14 * (1 - tFrac)).toFixed(3)})`
        : `rgba(${WASH_COLOR.join(',')},${(0.16 * (1 - tFrac)).toFixed(3)})`;
      mainCtx.fill();
    }

    drawDepositsTo(depositTarget);
    mainCtx.drawImage(depositLayer, 0, 0, mainSize, mainSize);

    const liveStyle = dark ? 'rgba(255,255,255,0.45)' : 'rgba(84,45,12,0.55)';
    const lineStyle = dark ? 'rgba(220,210,190,0.7)' : 'rgba(138,107,63,0.7)';
    const dashStyle = dark ? 'rgba(220,210,190,0.45)' : 'rgba(138,107,63,0.5)';
    if (drying) {
      // Live suspension.
      mainCtx.fillStyle = liveStyle;
      const pos = f.pos;
      for (let j = 0; j < pos.length; j += 2) {
        mainCtx.fillRect(
          cx + pos[j] * R * Math.cos(pos[j + 1]) - 1,
          cy + pos[j] * R * Math.sin(pos[j + 1]) - 1,
          2,
          2,
        );
      }
      circle(mainCtx, f.base * R, lineStyle);
      if (f.innerEdge < f.base - 1e-3) circle(mainCtx, f.innerEdge * R, dashStyle, [3, 3]);
    } else if (v < 1) {
      // Leftovers waiting for the sweep stay visible until the front takes
      // them (drawn at their settled spot — dots barely move, spokes snap).
      mainCtx.fillStyle = liveStyle;
      for (let i = depositTarget; i < deposits.length; i++) {
        const d = deposits[i];
        mainCtx.fillRect(
          cx + d.rho * R * Math.cos(d.theta) - 1,
          cy + d.rho * R * Math.sin(d.theta) - 1,
          2,
          2,
        );
      }
      if (interiorMode === 'recession' && tail.length) {
        // The receding film's front, sweeping the interior outside-in.
        const revealed = Math.max(0, depositTarget - loopDeposits - 1);
        const front = tail[Math.min(revealed, tail.length - 1)].rho;
        circle(mainCtx, front * R, dashStyle, [3, 3]);
      }
    }

    if (!playing) {
      // Click-to-play affordance.
      mainCtx.fillStyle = dark ? 'rgba(220,210,190,0.75)' : 'rgba(74,59,42,0.55)';
      mainCtx.beginPath();
      mainCtx.arc(28, mainSize - 28, 16, 0, 2 * Math.PI);
      mainCtx.fill();
      mainCtx.fillStyle = dark ? '#000' : PAPER;
      mainCtx.beginPath();
      mainCtx.moveTo(23, mainSize - 36);
      mainCtx.lineTo(23, mainSize - 20);
      mainCtx.lineTo(36, mainSize - 28);
      mainCtx.closePath();
      mainCtx.fill();
    }
  };

  // --- scrubber strip: linear in playback, ticks in drying progress, so the
  // widening gaps between 25/50/75/90% make the time warp visible. ---
  const drawScrub = () => {
    const W = mainSize;
    scrubCtx.clearRect(0, 0, W, 34);
    scrubCtx.fillStyle = 'rgba(185,168,136,0.35)';
    scrubCtx.fillRect(0, 6, W * uSplit, 4);
    scrubCtx.fillStyle = 'rgba(185,168,136,0.7)';
    scrubCtx.fillRect(W * uSplit, 6, W * (1 - uSplit), 4);
    scrubCtx.fillStyle = ACCENT;
    scrubCtx.fillRect(0, 6, W * v, 4);
    scrubCtx.font = '10px -apple-system,sans-serif';
    scrubCtx.textAlign = 'center';
    // Ticks mark realized drying fraction: a free-recession run tears loose
    // before t=1, so late ticks can fall past the end of the pinned loop.
    const tLast = frames[frames.length - 1].t / sim.tEnd;
    for (const p of [0.25, 0.5, 0.75, 0.9]) {
      if (p > tLast) continue;
      const x = warpU(p / tLast, warpP) * W * uSplit;
      scrubCtx.fillStyle = MUTED;
      scrubCtx.fillRect(x - 0.5, 4, 1, 8);
      scrubCtx.fillText(`${p * 100}%`, x, 24);
    }
    scrubCtx.fillStyle = MUTED;
    scrubCtx.fillRect(W * uSplit - 0.5, 4, 1, 8);
    scrubCtx.fillText(tLast < 0.95 ? 'tears free' : 'dry', W * uSplit, 24);
    scrubCtx.fillText('sweep', (W * (uSplit + 1)) / 2, 24);
    scrubCtx.fillStyle = ACCENT;
    scrubCtx.beginPath();
    scrubCtx.arc(W * v, 8, 5, 0, 2 * Math.PI);
    scrubCtx.fill();
  };

  const drawHud = (f) => {
    if (v >= 1) {
      const rim = deposits.filter((d) => d.pinned).length;
      hud.textContent = `dry · ${Math.round((100 * rim) / deposits.length)}% of the pigment jammed at the rim`;
    } else if (v >= uSplit) {
      hud.textContent = interiorMode === 'recession'
        ? 'dry — the receding film sweeps the leftovers into spokes and arcs'
        : 'dry — the leftover residue settles where it sits';
    } else {
      const u = v / uSplit;
      const slow = slowMoFactor(u, warpP);
      const label = slow >= 100 ? '×100+' : `×${slow < 3 ? slow.toFixed(1) : Math.round(slow)}`;
      hud.textContent = `drying: ${Math.round((100 * f.t) / sim.tEnd)}% · playback ${label} slow-mo`;
    }
    playBtn.textContent = playing ? 'pause' : v >= 1 ? 'replay' : 'play';
  };

  // --- side plots ---
  const plotFrame = (ctx) => {
    ctx.clearRect(0, 0, plotWidth, plotH);
    ctx.strokeStyle = 'rgba(185,168,136,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(8.5, 4.5, plotWidth - 17, plotH - 21);
  };
  const px = (frac) => 9 + frac * (plotWidth - 18);
  const py = (frac) => 5 + (1 - frac) * (plotH - 22);
  const axisLabel = (ctx, text, frac) => {
    ctx.fillStyle = MUTED;
    ctx.font = '9px -apple-system,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, px(frac), plotH - 6);
  };

  const logScale = (d) => Math.min(1, Math.log1p(d) / Math.log1p(sim.histMax));

  // Stacked pigment profile: deposited (dark, permanent) under suspended
  // (light, draining). At dry-out the panel IS the stain's radial profile.
  const drawHist = (f, depositTarget) => {
    plotFrame(histCtx);
    let suspRho;
    if (v < uSplit) {
      suspRho = new Float64Array(f.alive);
      for (let j = 0; j < f.alive; j++) suspRho[j] = f.pos[2 * j];
    } else {
      // Sweeping: what's still suspended is the not-yet-settled tail, so the
      // light bars drain into the dark ones instead of double-counting.
      suspRho = depositRho.subarray(depositTarget);
    }
    const susp = radialHistogram(suspRho, ones, { bins: HIST_BINS, density: true });
    const dep = radialHistogram(depositRho.subarray(0, depositTarget), ones, {
      bins: HIST_BINS,
      density: true,
    });
    const bw = (plotWidth - 18) / HIST_BINS;
    for (let b = 0; b < HIST_BINS; b++) {
      const hDep = logScale(dep[b]) * (plotH - 22);
      const hAll = logScale(dep[b] + susp[b]) * (plotH - 22);
      histCtx.fillStyle = 'rgba(140,88,36,0.45)';
      histCtx.fillRect(9 + b * bw, py(0) - hAll, bw - 1, hAll - hDep);
      histCtx.fillStyle = 'rgba(84,45,12,0.85)';
      histCtx.fillRect(9 + b * bw, py(0) - hDep, bw - 1, hDep);
    }
    // Reference: the flat density of the initial even splash.
    const flatY = py(logScale(sim.particles));
    histCtx.strokeStyle = 'rgba(74,59,42,0.4)';
    histCtx.setLineDash([3, 3]);
    histCtx.beginPath();
    histCtx.moveTo(px(0), flatY);
    histCtx.lineTo(px(1), flatY);
    histCtx.stroke();
    histCtx.setLineDash([]);
    axisLabel(histCtx, 'center', 0.08);
    axisLabel(histCtx, 'rim', 0.94);
  };

  const series = frames.map((f) => f.t / sim.tEnd);
  const drawCurve = (ctx, ys, color, width = 1.4) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let k = 0; k < frames.length; k++) {
      const x = px(series[k]);
      const y = py(ys[k]);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  const suspended = frames.map((f) => f.alive / sim.particles);
  const pinnedFrac = frames.map((f) => f.depositCount / sim.particles);
  const bases = frames.map((f) => f.base);
  const inners = frames.map((f) => f.innerEdge);

  // Dashed and muted so the time cursor can't be mistaken for a data curve
  // (a solid dark playhead next to the depinning step reads as the contact
  // line jumping back up).
  const playhead = (ctx, tFrac) => {
    ctx.strokeStyle = 'rgba(185,168,136,0.9)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(px(tFrac), py(0));
    ctx.lineTo(px(tFrac), py(1));
    ctx.stroke();
    ctx.setLineDash([]);
  };

  const drawFrac = (tFrac) => {
    plotFrame(fracCtx);
    drawCurve(fracCtx, suspended, 'rgba(140,88,36,0.9)');
    drawCurve(fracCtx, pinnedFrac, 'rgba(84,45,12,0.9)');
    playhead(fracCtx, tFrac);
    fracCtx.fillStyle = MUTED;
    fracCtx.font = '9px -apple-system,sans-serif';
    fracCtx.textAlign = 'left';
    fracCtx.fillText('suspended', px(0.03), py(0.93));
    fracCtx.fillText('pinned', px(0.03), py(0.06));
    axisLabel(fracCtx, 'drying →', 0.5);
  };

  // Zoom the radius axis to where the action is: full [0,1] would squeeze
  // the depinning steps and the ring band into the top sliver.
  const rLo = Math.max(0, Math.min(...inners) - 0.08);
  const rNorm = (val) => (val - rLo) / (1.02 - rLo);
  const basesN = bases.map(rNorm);
  const innersN = inners.map(rNorm);

  const drawRadius = (tFrac) => {
    plotFrame(radCtx);
    // Shade the solid ring: between the contact line and its inner edge.
    radCtx.fillStyle = 'rgba(140,88,36,0.25)';
    radCtx.beginPath();
    for (let k = 0; k < frames.length; k++) radCtx.lineTo(px(series[k]), py(basesN[k]));
    for (let k = frames.length - 1; k >= 0; k--) radCtx.lineTo(px(series[k]), py(innersN[k]));
    radCtx.closePath();
    radCtx.fill();
    drawCurve(radCtx, basesN, 'rgba(84,45,12,0.9)');
    playhead(radCtx, tFrac);
    axisLabel(radCtx, 'drying →', 0.5);
  };

  const render = () => {
    const f = frameFor(v < uSplit ? v / uSplit : 1);
    const depositTarget = depositTargetAt();
    const tFrac = Math.min(1, f.t / sim.tEnd);
    drawMain(f, depositTarget);
    drawScrub();
    drawHud(f);
    drawHist(f, depositTarget);
    drawFrac(tFrac);
    drawRadius(tFrac);
  };

  const tick = (now) => {
    if (playing) {
      v = Math.min(1, Math.max(0, v + (now - lastNow) / total));
      lastNow = now;
      if (v >= 1) pause();
      render();
    }
    raf = playing ? requestAnimationFrame(tick) : 0;
  };

  const play = () => {
    if (playing) return;
    if (v >= 1) v = 0;
    playing = true;
    lastNow = performance.now();
    raf = requestAnimationFrame(tick);
    render();
  };
  const pause = () => {
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    render();
  };
  playBtn.addEventListener('click', () => (playing ? pause() : play()));
  mainC.addEventListener('click', () => (playing ? pause() : play()));

  let wasPlaying = false;
  const seekTo = (clientX) => {
    const rect = scrubC.getBoundingClientRect();
    v = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    render();
  };
  scrubC.addEventListener('pointerdown', (e) => {
    wasPlaying = playing;
    pause();
    scrubC.setPointerCapture(e.pointerId);
    seekTo(e.clientX);
  });
  scrubC.addEventListener('pointermove', (e) => {
    if (scrubC.hasPointerCapture(e.pointerId)) seekTo(e.clientX);
  });
  scrubC.addEventListener('pointerup', () => {
    if (wasPlaying && v < 1) play();
  });

  // Same stain, different paint: flipping repaints the deposit layer from
  // scratch (the two modes disagree about every dot's size and color).
  const setDark = (on) => {
    dark = on;
    darkBox.checked = on;
    mainC.style.background = on ? '#000' : PAPER;
    depCtx.clearRect(0, 0, mainSize, mainSize);
    drawnDeposits = 0;
    render();
  };
  darkBox.addEventListener('change', () => setDark(darkBox.checked));
  if (dark) mainC.style.background = '#000';

  render(); // starts paused: click the drop (or the button) to play

  return {
    destroy() {
      pause();
      root.remove();
    },
    seek(frac) {
      pause();
      v = Math.min(1, Math.max(0, frac));
      render();
    },
    setDark,
    play,
    pause,
  };
}
