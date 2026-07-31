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
        // Jammed at the contact line: sharp outer edge, short inward tail.
        alive[i] = 0;
        deposits.push({
          rho: kappa - Math.abs(rng.gaussian()) * ringWidth,
          theta: theta[i],
          t,
        });
      } else {
        rho[i] = r;
      }
    }
  }

  for (let i = 0; i < particles; i++) {
    if (alive[i]) deposits.push({ rho: rho[i], theta: theta[i], t: tEnd });
  }

  return { deposits };
}
