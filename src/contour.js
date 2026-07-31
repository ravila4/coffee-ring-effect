// The pinned contact line: a closed noisy contour. Sampling 2D noise along a
// circle in noise space guarantees a seamless loop (the input path returns to
// its start, so the output is periodic by construction). An optional spike
// term adds the fingers of an impact splash: raised-cosine^p bumps, sharp at
// the tip, zero outside their window.

import { fbm } from './noise.js';

const TWO_PI = 2 * Math.PI;
const wrap = (theta) => ((theta % TWO_PI) + TWO_PI) % TWO_PI;

export function makeContactLine({
  radius,
  amp = 0.06,
  freq = 1.6,
  octaves = 3,
  noise2D,
  offset = 0,
  spikes = null, // { azimuths, amp, sharpness, halfWidth? }
}) {
  const spikeAmp = spikes?.amp ?? 0;
  const halfWidth =
    spikes && (spikes.halfWidth ?? 0.35 * (TWO_PI / Math.max(1, spikes.azimuths.length)));
  // Per-finger strength: real fingers vary in length, some barely form.
  const rel = spikes ? (spikes.amps ?? spikes.azimuths.map(() => 1)) : [];
  const maxRel = rel.length ? Math.max(...rel) : 0;

  const rawSpike = (theta) => {
    if (!spikes) return 0;
    let best = 0;
    for (let k = 0; k < spikes.azimuths.length; k++) {
      let off = Math.abs(wrap(theta) - wrap(spikes.azimuths[k]));
      if (off > Math.PI) off = TWO_PI - off;
      if (off >= halfWidth) continue;
      const c = Math.cos((off / halfWidth) * (Math.PI / 2));
      best = Math.max(best, rel[k] * Math.pow(c, spikes.sharpness ?? 3));
    }
    return best;
  };

  // Normalized finger envelope in [0, 1]: 1 at the strongest tip, 0 between
  // fingers. Also used for tip shading — flux diverges at sharp tips.
  const spikeAt = (theta) => (maxRel ? rawSpike(theta) / maxRel : 0);

  const radiusAt = (theta) =>
    radius *
    (1 +
      amp *
        fbm(noise2D, Math.cos(theta) * freq + offset, Math.sin(theta) * freq + offset, {
          octaves,
        }) +
      spikeAmp * rawSpike(theta));

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

  return {
    radiusAt,
    points,
    radius,
    amp,
    spikeAt,
    maxExcursion: radius * (1 + amp + spikeAmp * (maxRel || 1)),
  };
}
