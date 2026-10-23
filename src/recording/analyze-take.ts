/// <reference types="node" />
/*
 * Read a take from record mode, check its timing, and write a timeline that's easy to read next to a
 * transcript.  Runs in Node, which understands TypeScript directly:
 *
 *   node src/recording/analyze-take.ts "recordings/take 2026-10-22 11-51-54.jsonl"
 *
 * It looks for <name>.wav next to the log, and writes <name>.timeline.txt there too.
 *
 * Every time in the timeline is in seconds from the start of the WAV file, so it lines up with the
 * transcript.  Events are logged on the page's clock, so this converts them:
 *   1. Fit a line through the clock pairs in the sample lines, from the page's clock to the audio clock.
 *   2. The file's first sample is at audio frame startFrame.
 *   3. Sound reaches the file a little after it reaches the mic.  The calibration sounds measure the
 *      round trip.  Take away the output's part, and what's left is the input's delay.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { calibrationSamples, findSound, type CalibrationSound } from "./calibration-sounds.ts";

type Line = { t: number; type: string; [key: string]: unknown };

const logPath = process.argv[2];
if (!logPath?.endsWith(".jsonl")) {
  console.log('Usage:  node src/recording/analyze-take.ts "<folder>/take ….jsonl"');
  process.exit(1);
}
const base = logPath.slice(0, -".jsonl".length);
const lines: Line[] = readFileSync(logPath, "utf8")
  .trim()
  .split("\n")
  .map((text: string) => JSON.parse(text));
const report: string[] = [];
const say = (text = "") => report.push(text);

// The audio.
const wav = readFileSync(`${base}.wav`);
const rate = wav.readUInt32LE(24);
const frames = wav.readUInt32LE(46);
const audio = new Float32Array(wav.buffer.slice(wav.byteOffset + 58, wav.byteOffset + 58 + frames * 4));
let peak = 0;
let clipped = 0;
for (const v of audio) {
  peak = Math.max(peak, Math.abs(v));
  if (Math.abs(v) >= 0.99) {
    clipped++;
  }
}
const dB = (level: number) => (20 * Math.log10(Math.max(level, 1e-9))).toFixed(1);
const take = lines.find((line) => line.type == "take");
say(`Take:  ${take?.name ?? base}`);
say(`Mic:  ${take?.mic}.  Asked for ${JSON.stringify(take?.requested)}.`);
say(`Audio:  ${(frames / rate).toFixed(2)} s at ${rate} Hz.  Loudest sample ${dB(peak)} dBFS.  ${clipped} clipped samples.`);

// 1. The page's clock to the audio clock:  a straight line through the pairs.
const pairs = lines
  .filter((line) => line.type == "sample")
  .map((line) => line.clock as { perf: number; audio: number });
const n = pairs.length;
const meanPerf = pairs.reduce((sum, p) => sum + p.perf, 0) / n;
const meanAudio = pairs.reduce((sum, p) => sum + p.audio, 0) / n;
let covariance = 0;
let variance = 0;
for (const p of pairs) {
  covariance += (p.perf - meanPerf) * (p.audio - meanAudio);
  variance += (p.perf - meanPerf) ** 2;
}
/** Seconds of audio clock per ms of page clock.  Ideally exactly 0.001. */
const slope = n > 1 ? covariance / variance : 0.001;
const audioAt = (t: number) => meanAudio + slope * (t - meanPerf);
const scatter = Math.sqrt(pairs.reduce((sum, p) => sum + (p.audio - audioAt(p.perf)) ** 2, 0) / Math.max(1, n));
say(
  `Clocks:  the audio clock ran ${((slope / 0.001 - 1) * 1e6).toFixed(0)} parts per million ${slope >= 0.001 ? "fast" : "slow"} compared to the page's.  ` +
    `The pairs scatter by ${(scatter * 1000).toFixed(2)} ms around the line, from ${n} samples.`
);

// 2. The file's first sample.
const startFrame = (lines.find((line) => line.type == "audio")?.startFrame as number) ?? 0;

// 3. The calibration sounds.
say();
say("Calibration sounds:");
let inputDelay: number | undefined;
const roundTrips: { t: number; ms: number }[] = [];
for (const line of lines.filter((line) => line.type == "sound")) {
  const sound = line.sound as CalibrationSound;
  const template = calibrationSamples(sound, rate);
  const at = (line.frame as number) - startFrame;
  const found = findSound(audio, template, at - 0.05 * rate, at + 0.5 * rate);
  if (found.match < 0.15) {
    say(`  ${sound} at ${(at / rate).toFixed(3)} s:  not heard (match ${found.match.toFixed(2)}).`);
    continue;
  }
  const ms = ((found.position - at) / rate) * 1000;
  roundTrips.push({ t: line.t, ms });
  const outputMs = ((line.outputLatency as number) ?? 0) * 1000;
  inputDelay ??= (ms - outputMs) / 1000;
  say(
    `  ${sound} at ${(at / rate).toFixed(3)} s:  round trip ${ms.toFixed(2)} ms (the browser says output takes ${outputMs.toFixed(1)} ms, so input takes about ${(ms - outputMs).toFixed(1)} ms).  ` +
      `Match ${found.match.toFixed(2)}, peak ${found.peakDb.toFixed(1)} dBFS.`
  );
}
if (roundTrips.length >= 2) {
  const first = roundTrips[0];
  const last = roundTrips[roundTrips.length - 1];
  say(`  The round trip changed by ${(last.ms - first.ms).toFixed(2)} ms over ${((last.t - first.t) / 1000).toFixed(1)} s.`);
}
if (inputDelay === undefined) {
  say("  No calibration sound was heard, so the times below don't include the mic's delay, probably 10 to 20 ms.");
}

/** Seconds into the WAV file for a time on the page's clock. */
const fileSeconds = (t: number) => audioAt(t) - startFrame / rate + (inputDelay ?? 0);
const clock = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(3).padStart(6, "0")}`;
};

// The timeline:  everything except the samples, plus changes that only show up in the samples.
say();
say("Timeline (minutes:seconds into the WAV file):");
const timeline: { seconds: number; text: string }[] = [];
const event = (seconds: number, text: string) => timeline.push({ seconds, text });
let previous: Record<string, unknown> = {};
for (const line of lines) {
  const { t, type, ...rest } = line;
  if (type == "sample") {
    const state = (line.state ?? {}) as Record<string, unknown>;
    const changes = ["function", "mode", "demo", "zLevel", "rainbow", "offSheet"]
      .filter((key) => key in previous && JSON.stringify(state[key]) !== JSON.stringify(previous[key]))
      .map((key) => `${key}: ${JSON.stringify(previous[key])} → ${JSON.stringify(state[key])}`);
    if (changes.length) {
      event(fileSeconds(t), `state changed  ${changes.join(", ")}`);
    }
    previous = state;
    continue;
  }
  // These are summed up above.
  if (type == "take" || type == "audio" || type == "heard") {
    continue;
  }
  if (type == "sound") {
    // When it played, not when it was scheduled.
    event(((line.frame as number) - startFrame) / rate, `sound  ${line.sound}`);
    continue;
  }
  const details = Object.entries(rest)
    .filter(([key]) => !["actual", "outputLatency", "frame", "when"].includes(key))
    .map(([key, value]) => `${key}=${typeof value == "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  event(fileSeconds(t), `${type}  ${details}`);
}
timeline.sort((a, b) => a.seconds - b.seconds);
for (const { seconds, text } of timeline) {
  say(`  ${clock(seconds)}  ${text}`);
}

const text = report.join("\n") + "\n";
writeFileSync(`${base}.timeline.txt`, text);
console.log(text);
console.log(`Wrote ${base}.timeline.txt`);
