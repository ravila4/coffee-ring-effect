# Research notes: procedural coffee stains for the web

Condensed from two web-research passes (2026-07-30). Source URLs inline.

## Visual checklist for a believable stain

1. Sharp dark rim, translucent lighter interior — the defining cue
   (physicstoday.aip.org quick-study; alvaromontoro.com/blog/68035).
2. Ring thickness and darkness vary around the circumference.
3. Secondary/nested inner rings from stick-slip contact-line recession
   (nature.com/articles/s41598-017-00497-x; ACS Omega 9b04310). Three pattern
   families: near-uniform disk, dual-ring, dense multi-ring.
4. Not every stain is a clean ring — patchy variants exist.
5. Color is a translucent sepia wash: light amber center → near-black-brown
   concentrated rim, never a flat brown fill.
6. Satellite droplets along a splash direction; tiny specks near the rim.
7. Porous surfaces (paper) feather the edge; ceramic keeps it crisp.

## Physics used (no fluid solver)

Deegan et al.: pinned contact line + evaporation flux diverging at the thin
edge → outward capillary flow; essentially all streamlines terminate at the
contact line. Depth-averaged velocity has a closed form,
`v(ρ,t) = [(1−ρ²)^(−λ) − (1−ρ²)] / (4ρ(1−t))` with λ→1/2 for small contact
angle — cheap to integrate per particle. Marangoni counter-flow (alcohol,
hydrophobic surfaces) suppresses the ring → uniform disk, a possible preset.

## Technique choices and why

- **Closed noisy contour**: sample 2D noise along a circle in noise space
  (`noise(cosθ·f, sinθ·f)`) — periodic by construction, no seam (varun.ca/noise;
  benfrederickson.com/flowers-from-simplex-noise). Ben Frederickson extras
  worth keeping: sample count `floor(4R + 20)` scales with radius; decorrelate
  shapes via a seed offset in noise space.
- **fBm**: 2–4 octaves, persistence ~0.5, lacunarity ~2. Low-frequency second
  noise channel modulates ring width/darkness (broad arcs), high-frequency
  handles edge jaggedness.
- **Seeded PRNG**: mulberry32 (constant 0x6D2B79F5 — the other circulating
  variant is mislabeled). Reproducible stains from a seed.
- **Canvas multiply blending** fakes pigment accumulation; layered low-alpha
  splats darken naturally where dense (MDN globalCompositeOperation).
- **Tyler Hobbs watercolor layering** (recursive polygon deformation, 30–100
  layers at ~4% alpha) — considered, not used: deposition density from the
  simulation provides the accumulation for free (tylerxhobbs.com/words/
  a-guide-to-simulating-watercolor-paint-with-generative-art).

## Why not SVG feTurbulence (live)

- `feTurbulence` is among the most expensive filter primitives; cost scales
  with filter region area and octave count (multi-second freezes documented,
  Mozilla bug 422371; "really sluggish" on iOS per GSAP forum reports).
- Filter region defaults (`-10%..120%`) clip displaced edges — needs manual
  region enlargement, which raises the cost further.
- Safari has documented failure modes applying SVG filters to HTML elements
  and large regions (commonpaper.com case study: 500 ms → 55 ms by replacing a
  live filter with a pre-rendered asset).
- Interop gaps remain in feDisplacementMap alpha handling (w3c/fxtf-drafts#113).
- Verdict (matches this repo's design): canvas rendered once, reused as a
  static bitmap — procedural like the filter path, but the cost is paid once.
  If an SVG variant is ever wanted: `type="fractalNoise"`, baseFrequency
  0.02–0.2, numOctaves ≤ 3, explicit enlarged filter region,
  `color-interpolation-filters="sRGB"`, randomize per-instance via
  `setAttribute('seed', …)` (CSS custom properties cannot drive filter
  attributes).

## Useful references

- MDN feDisplacementMap / feTurbulence; Codrops feTurbulence texture guide
  (tympanus.net/codrops/2019/02/19/…)
- CSS-only stain art: alvaromontoro.com/blog/68035 (`blur() contrast(500)`
  gooey trick + layered radial-gradient masks)
- simplex-noise npm (~2 KB gz, ~20 ns/sample) or 550-byte one-file
  implementations (github.com/attilabuti/SimplexNoise)
- Metaballs/gooey merging for splatters: field-sum + threshold, or SVG
  blur + feColorMatrix alpha threshold
