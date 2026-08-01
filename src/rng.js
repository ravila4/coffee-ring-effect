// Seeded PRNG (mulberry32) + derived samplers. Deterministic per seed so
// every stain is reproducible from its seed alone.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Hash a parent seed with a stream index into the seed of an independent
// sub-stream. Consumers that draw an input-dependent NUMBER of values (the
// particle sims eat more randomness at low φ, a hard splash grows more
// fingers) get their own stream, so turning one knob can never shift the
// draws behind an unrelated decision. Murmur3-style finalizer for avalanche.
export function forkSeed(seed, stream) {
  let a = (Math.imul(seed, 0x9e3779b9) + Math.imul(stream + 1, 0x85ebca6b)) >>> 0;
  a = Math.imul(a ^ (a >>> 16), 0xc2b2ae35);
  return (a ^ (a >>> 13)) >>> 0;
}

export function makeRng(seed) {
  const random = mulberry32(seed);
  let spare = null;
  return {
    random,
    uniform: (a, b) => a + (b - a) * random(),
    int: (n) => Math.floor(random() * n),
    // Marsaglia polar method; caches the second deviate.
    gaussian() {
      if (spare !== null) {
        const v = spare;
        spare = null;
        return v;
      }
      let u;
      let v;
      let s;
      do {
        u = 2 * random() - 1;
        v = 2 * random() - 1;
        s = u * u + v * v;
      } while (s === 0 || s >= 1);
      const m = Math.sqrt((-2 * Math.log(s)) / s);
      spare = v * m;
      return u * m;
    },
  };
}
