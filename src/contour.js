// The pinned contact line: a closed noisy contour. Sampling 2D noise along a
// circle in noise space guarantees a seamless loop (the input path returns to
// its start, so the output is periodic by construction).

import { fbm } from './noise.js';

export function makeContactLine({ radius, amp = 0.06, freq = 1.6, octaves = 3, noise2D, offset = 0 }) {
  const radiusAt = (theta) =>
    radius *
    (1 +
      amp *
        fbm(noise2D, Math.cos(theta) * freq + offset, Math.sin(theta) * freq + offset, {
          octaves,
        }));

  // Sample count scales with radius so segment length stays roughly constant.
  const points = (count = Math.floor(4 * radius + 20)) => {
    const pts = [];
    for (let k = 0; k < count; k++) {
      const theta = (k / count) * 2 * Math.PI;
      const r = radiusAt(theta);
      pts.push({ x: r * Math.cos(theta), y: r * Math.sin(theta) });
    }
    return pts;
  };

  return { radiusAt, points, radius, amp };
}
