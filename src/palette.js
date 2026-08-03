// The stain palette, shared by every renderer. RGB triples rather than CSS
// strings: each renderer composites at its own alpha.

// Pigment splats. Three roast tones so a dense rim reads as grains that vary,
// not one flat brown; the darkest doubles as the deliberate deep-shadow pick.
export const RING_COLORS = [
  [110, 62, 20],
  [140, 88, 36],
  [84, 45, 12],
];

// The dilute film under the splats: the same coffee, thinner.
export const WASH_COLOR = [172, 122, 62];
