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
