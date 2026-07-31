// The pinned contact line: a closed noisy contour. Sampling 2D noise along a
// circle in noise space guarantees a seamless loop (the input path returns to
// its start, so the output is periodic by construction). An optional spike
// term adds the fingers of an impact splash: raised-cosine^p bumps, sharp at
// the tip, zero outside their window.

import { fbm } from './noise.js';

const TWO_PI = 2 * Math.PI;
const wrap = (theta) => ((theta % TWO_PI) + TWO_PI) % TWO_PI;

// A reusable field of splash fingers over azimuth: raised-cosine^p bumps,
// sharp at the tip, zero outside their window. Used both on a drop's contact
// line and on a mug band's outer edge (the splash of a hard set-down).
export function makeSpikeField({ azimuths, amps = null, amp = 0.2, sharpness = 3, halfWidth = null }) {
  const hw = halfWidth ?? 0.35 * (TWO_PI / Math.max(1, azimuths.length));
  // Per-finger strength: real fingers vary in length, some barely form.
  const rel = amps ?? azimuths.map(() => 1);
  const maxRel = rel.length ? Math.max(...rel) : 0;

  const raw = (theta) => {
    let best = 0;
    for (let k = 0; k < azimuths.length; k++) {
      let off = Math.abs(wrap(theta) - wrap(azimuths[k]));
      if (off > Math.PI) off = TWO_PI - off;
      if (off >= hw) continue;
      const c = Math.cos((off / hw) * (Math.PI / 2));
      best = Math.max(best, rel[k] * Math.pow(c, sharpness));
    }
    return best;
  };

  return {
    // Radial excursion as a fraction of the host radius.
    at: (theta) => amp * raw(theta),
    // Normalized finger envelope in [0, 1]: 1 at the strongest tip, 0 between
    // fingers. Also used for tip shading — flux diverges at sharp tips.
    envelopeAt: (theta) => (maxRel ? raw(theta) / maxRel : 0),
    maxAmp: amp * (maxRel || 1),
  };
}

export function makeContactLine({
  radius,
  amp = 0.06,
  freq = 1.6,
  octaves = 3,
  noise2D,
  offset = 0,
  spikes = null, // { azimuths, amps?, amp, sharpness, halfWidth? }
}) {
  const field = spikes ? makeSpikeField(spikes) : null;

  const radiusAt = (theta) =>
    radius *
    (1 +
      amp *
        fbm(noise2D, Math.cos(theta) * freq + offset, Math.sin(theta) * freq + offset, {
          octaves,
        }) +
      (field ? field.at(theta) : 0));

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
    spikeAt: (theta) => (field ? field.envelopeAt(theta) : 0),
    maxExcursion: radius * (1 + amp + (field ? field.maxAmp : 0)),
  };
}
