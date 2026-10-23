/**
 * The calibration sounds for record mode, and the code that finds them in a recording.
 *
 * Each sound is a sweep:  a tone that slides smoothly from one pitch to another.  Lining a sweep up
 * with its recording only works at one exact position, so it can be found to a small fraction of a
 * millisecond, even with a train going by.  A plain beep's start is fuzzy.
 *
 * Plain functions with no browser parts, so a Node script can use them too.  See analyze-take.ts.
 */

export type CalibrationSound = "start" | "stop" | "marker";

/** One sweep, from one frequency to another, in Hz. */
type Sweep = { from: number; to: number; seconds: number };

/**
 * Start rises and Stop falls, so you can tell them apart by ear.  The marker is two quick sweeps, for
 * "something important is about to happen."
 */
const SOUNDS: Record<CalibrationSound, Sweep[]> = {
  start: [{ from: 400, to: 4000, seconds: 0.2 }],
  stop: [{ from: 4000, to: 400, seconds: 0.2 }],
  marker: [
    { from: 800, to: 3200, seconds: 0.07 },
    // A silent gap.
    { from: 0, to: 0, seconds: 0.05 },
    { from: 800, to: 3200, seconds: 0.07 },
  ],
};

/** Loud enough to find easily, but not unpleasant.  About −10 dBFS. */
const AMPLITUDE = 0.3;
/** Fade in and out over this long, so there are no clicks. */
const FADE_SECONDS = 0.006;

/** The samples for one of the sounds, at this sample rate. */
export function calibrationSamples(sound: CalibrationSound, sampleRate: number): Float32Array<ArrayBuffer> {
  const parts = SOUNDS[sound].map((sweep) => sweepSamples(sweep, sampleRate));
  const result = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}

/** An exponential sweep:  every octave gets the same amount of time, so it sounds even. */
function sweepSamples({ from, to, seconds }: Sweep, sampleRate: number) {
  const count = Math.round(seconds * sampleRate);
  const samples = new Float32Array(count);
  if (from <= 0 || to <= 0) {
    return samples;
  }
  const k = Math.log(to / from);
  for (let i = 0; i < count; i++) {
    const t = i / sampleRate;
    const phase = (2 * Math.PI * from * seconds * (Math.exp((t * k) / seconds) - 1)) / k;
    samples[i] = AMPLITUDE * Math.sin(phase);
  }
  const fade = Math.min(count / 2, Math.round(FADE_SECONDS * sampleRate));
  for (let i = 0; i < fade; i++) {
    const gain = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    samples[i] *= gain;
    samples[count - 1 - i] *= gain;
  }
  return samples;
}

export type Found = {
  /** Where the sound starts in the recording, in samples.  Not a whole number:  it's interpolated. */
  position: number;
  /** How well it matched, 0 to 1.  Above about 0.1 means it really is there.  Noise alone scores about 0.03. */
  match: number;
  /** The loudest sample in the match, as dBFS. */
  peakDb: number;
};

/**
 * Find a sound in a recording, starting somewhere from `from` to `to` (sample indexes).  It searches
 * coarsely first, at a quarter of the sample rate, then exactly around the best spot.
 */
export function findSound(recording: Float32Array, sound: Float32Array, from: number, to: number): Found {
  const first = Math.max(0, Math.floor(from));
  const last = Math.min(recording.length - sound.length, Math.ceil(to));
  if (last < first) {
    return { position: NaN, match: 0, peakDb: -Infinity };
  }
  const soundEnergy = energy(sound, 0, sound.length, 1);
  const score = (lag: number, step: number) => {
    let sum = 0;
    for (let i = 0; i < sound.length; i += step) {
      sum += sound[i] * recording[lag + i];
    }
    const norm = Math.sqrt(energy(recording, lag, sound.length, step) * (soundEnergy / step));
    return norm > 0 ? sum / norm : 0;
  };
  // Coarse:  every 4th lag, every 4th sample.
  let best = first;
  let bestScore = -Infinity;
  for (let lag = first; lag <= last; lag += 4) {
    const s = score(lag, 4);
    if (s > bestScore) {
      bestScore = s;
      best = lag;
    }
  }
  // Exact:  every lag near the best one, every sample.
  const exact = new Map<number, number>();
  for (let lag = Math.max(first, best - 6); lag <= Math.min(last, best + 6); lag++) {
    exact.set(lag, score(lag, 1));
  }
  for (const [lag, s] of exact) {
    if (s > (exact.get(best) ?? -Infinity)) {
      best = lag;
    }
  }
  // Between samples:  fit a parabola through the best score and its neighbors.
  const here = exact.get(best) ?? 0;
  const before = exact.get(best - 1);
  const after = exact.get(best + 1);
  let position = best;
  if (before !== undefined && after !== undefined) {
    const curve = before - 2 * here + after;
    if (curve < 0) {
      position += (0.5 * (before - after)) / curve;
    }
  }
  let peak = 0;
  for (let i = best; i < best + sound.length; i++) {
    peak = Math.max(peak, Math.abs(recording[i]));
  }
  return { position, match: Math.max(0, here), peakDb: 20 * Math.log10(peak || 1e-12) };
}

function energy(samples: Float32Array, start: number, length: number, step: number) {
  let sum = 0;
  for (let i = 0; i < length; i += step) {
    const v = samples[start + i];
    sum += v * v;
  }
  return sum;
}
