// Angle helpers for the tests. Deposits carry unnormalized thetas, so any
// comparison has to fold onto [0, 2π) before measuring.

export const normalizeTheta = (theta) => ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

// Shortest way around the circle: never more than half a turn.
export const circDist = (a, b) => {
  const off = Math.abs(normalizeTheta(a) - normalizeTheta(b));
  return off > Math.PI ? 2 * Math.PI - off : off;
};
