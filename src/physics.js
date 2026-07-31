// The coffee-ring effect, per Deegan et al.: the contact line stays pinned
// while evaporation flux diverges at the thin edge, driving an outward
// capillary flow that carries suspended particles to the rim, where they jam.
// We integrate that flow field directly instead of solving fluid dynamics.

const LAMBDA = 0.5; // evaporation-flux exponent for a vanishing contact angle

// Depth-averaged outward radial velocity in normalized units (drop radius = 1,
// drying time = 1): v(ρ,t) = [ (1−ρ²)^(−λ) − (1−ρ²) ] / (4ρ(1−t)).
// Vanishes at the center, diverges at the rim and as the drop dries.
export function radialVelocity(rho, t) {
  if (rho <= 0) return 0;
  const clamped = Math.min(rho, 0.999999);
  const one = 1 - clamped * clamped;
  return (Math.pow(one, -LAMBDA) - one) / (4 * (1 - t) * clamped);
}

// Advect solute particles through the Deegan flow with Brownian diffusion.
// Particles deposit when they reach the pinned contact line; stick-slip
// depinning events pull the line inward, leaving secondary rings; whatever is
// still suspended at dry-out deposits in place (the mottled interior residue).
export function simulateDrop({
  particles = 3000,
  steps = 300,
  tEnd = 0.98,
  diffusion = 0.02,
  ringWidth = 0.015,
  depinEvents = 0,
  depinJump = [0.04, 0.1],
  depinWindow = [0.35, 0.85],
  depinSchedule = null,
  pinningAt = null, // θ → [0,1] pinning strength; weak arcs leave ring gaps
  rng,
} = {}) {
  if (!rng) throw new Error('simulateDrop requires a seeded rng');

  let schedule = depinSchedule;
  if (!schedule) {
    schedule = [];
    for (let k = 0; k < depinEvents; k++) {
      schedule.push({
        t: rng.uniform(depinWindow[0], depinWindow[1]),
        jump: rng.uniform(depinJump[0], depinJump[1]),
      });
    }
  }
  schedule = [...schedule].sort((a, b) => a.t - b.t);

  const rho = new Float64Array(particles);
  const theta = new Float64Array(particles);
  const alive = new Uint8Array(particles).fill(1);
  for (let i = 0; i < particles; i++) {
    rho[i] = Math.sqrt(rng.random()); // uniform over the disk
    theta[i] = rng.uniform(0, 2 * Math.PI);
  }

  const deposits = [];
  let kappa = 1; // current pinned contact-line position
  let nextEvent = 0;
  const dt = tEnd / steps;

  for (let s = 0; s < steps; s++) {
    const t = s * dt;
    while (nextEvent < schedule.length && schedule[nextEvent].t <= t) {
      kappa = Math.max(0.2, kappa - schedule[nextEvent].jump);
      nextEvent++;
    }
    const sigma = Math.sqrt(2 * diffusion * dt);
    for (let i = 0; i < particles; i++) {
      if (!alive[i]) continue;
      let r = rho[i] + radialVelocity(rho[i] / kappa, t) * kappa * dt + sigma * rng.gaussian();
      theta[i] += (sigma / Math.max(r, 0.05)) * rng.gaussian();
      if (r < 0) {
        r = -r;
        theta[i] += Math.PI;
      }
      if (r >= kappa) {
        if (!pinningAt || rng.random() < pinningAt(theta[i])) {
          // Jammed at the pinned line: sharp outer edge, short inward tail.
          alive[i] = 0;
          deposits.push({
            rho: kappa - Math.abs(rng.gaussian()) * ringWidth,
            theta: theta[i],
            t,
            pinned: true,
          });
        } else {
          // Locally receding line: the interface sweeps the particle back
          // into the liquid, which sloshes it along the rim — mass migrates
          // to pinned arcs instead of accumulating in the gap.
          rho[i] = kappa * (1 - 0.02 - 0.05 * rng.random());
          theta[i] += rng.gaussian() * 0.3;
        }
      } else {
        rho[i] = r;
      }
    }
  }

  for (let i = 0; i < particles; i++) {
    if (alive[i]) deposits.push({ rho: rho[i], theta: theta[i], t: tEnd, pinned: false });
  }

  return { deposits };
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
  pinningAt = null,
  rng,
} = {}) {
  if (!rng) throw new Error('simulateRing requires a seeded rng');

  const u = new Float64Array(particles);
  const theta = new Float64Array(particles);
  const alive = new Uint8Array(particles).fill(1);
  for (let i = 0; i < particles; i++) {
    u[i] = rng.uniform(-1, 1);
    theta[i] = rng.uniform(0, 2 * Math.PI);
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
        if (!pinningAt || rng.random() < pinningAt(theta[i])) {
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
