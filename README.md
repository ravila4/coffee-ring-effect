# coffee-ring-effect

Procedural coffee stains from a particle simulation of the coffee-ring
physics (Deegan et al.). A stain renders once to a canvas in 40 to 120 ms
and is reused as a static image after that, so generation cost never
recurs. Every stain is a pure function of its seed. No dependencies.

![Nine procedurally generated coffee stains in the demo grid](docs/demo-grid.png)

## The physics

A drying drop pins its contact line. Evaporation is strongest at the thin
edge, so an outward capillary flow feeds the rim and carries suspended
particles there, where they jam. That is the dark ring. Each particle is
advected through Deegan's closed-form depth-averaged velocity field; there is
no fluid solver.

```text
v(ρ,t) = [(1−ρ²)^(−λ) − (1−ρ²)] / (4ρ(1−t)),  λ = 1/2
```

One concentration knob, the solid volume fraction φ, drives the morphology,
following Deegan, *Phys. Rev. E* **61**, 475 (2000):

- **Ring growth.** Ring width and height integrate the paper's Appendix ODEs
  per pinned epoch, so concentrated drops build broad rims and dilute drops
  thin ones.
- **Depinning.** At the measured onset time (t_d ∝ φ^0.26) dry holes
  nucleate on the ring's inner edge, grow, and arrest into arch scallops.
  When their union spans enough of the circumference the liquid tears free,
  retracts, and re-pins: nested inner rings.
- **Interiors.** Dilute drops never re-pin. The receding front settles the
  remaining particles into stick-slip arcs, cusp-emitted radial spokes, and
  scattered center dots, chosen per particle from the live remaining load.
- **Mug rings.** Liquid wicks from a single drip along the channel between
  cup rim and table. A short reach dries as a crescent with a thick lobe and
  sharp tips; a long reach closes into a full ring. Overlapping placements
  share the drip.
- **Splashes.** Energetic drops finger into stars (finger count scales as
  √We) and eject satellites along the fingers. Fine ejecta flies fast but is
  drag-arrested into a close-in speck halo; droplets too dilute to self-pin
  dry as ringless dots.
- **Partial rings.** Azimuthal pinning noise: weakly pinned arcs recede and
  slosh their mass onto neighboring arcs, leaving C-shaped gaps.
- **Irregular outlines.** The contact line is a closed noisy contour, 2D
  simplex fBm sampled along a circle in noise space, so the contour closes
  with no seam.

The sim returns per-epoch `events` (depin onsets, hole geometry, ring radii)
alongside the deposits; ring radii come from events, never from deposit
statistics.

## Layout

| Path | What |
|---|---|
| `src/rng.js` | mulberry32 plus gaussian/uniform samplers |
| `src/noise.js` | 2D simplex noise and fBm |
| `src/contour.js` | noisy closed contact line, optional splash fingers |
| `src/physics.js` | velocity field, ring-growth ODE, hole depinning, interior settlement, crescent supply |
| `src/render.js` | deposits to splats and washes to canvas, impact-energy model |
| `demo/index.html` | 3x3 grid, click to re-brew |

## Usage

```bash
node --test                      # run the suite
python3 -m http.server 8000      # then open http://localhost:8000/demo/
```

```js
import { generateStainCanvas } from './src/render.js';
const canvas = generateStainCanvas({ size: 560, seed: 42 });
el.style.backgroundImage = `url(${canvas.toDataURL()})`;
```

Useful options: `type` ('drop' or 'mug'), `splashEnergy` (Weber-number
stand-in; high values finger and splatter), and `dropOverrides.phi`
(concentration; low values give sparse spoked interiors, high values give
broad rims).

See `docs/research-notes.md` for the research this design came from,
including why live SVG `feTurbulence` filters were rejected.
