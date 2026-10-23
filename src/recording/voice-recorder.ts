import { calibrationSamples, findSound, type CalibrationSound } from "./calibration-sounds";

/*
 * Record mode's engine:  the mic, the audio file, the log, and the calibration sounds.  No user
 * interface; see record-panel.ts.  Nothing here knows about the app it's recording.  The app supplies
 * a sample() function that describes its state.
 *
 * Everything is timed by the audio hardware's clock, the same clock the video editor plays by.  An
 * AudioWorklet copies the mic's samples, and tells us exactly which frame of that clock each one belongs
 * to.  Sample n of the file is frame startFrame + n.  See development-notes/record-mode.md.
 *
 * Two files per take, written as the take goes, so a long take never lives only in memory:
 *   <name>.wav    The mic, raw.  32-bit float, mono.
 *   <name>.jsonl  The log:  one JSON object per line.  Times (t) are in ms from the start of the take, on
 *                 the page's clock, performance.now().  Sample lines also hold a pair of clock
 *                 readings, so the log can be lined up with the audio exactly.
 */

/** The browser's voice processing.  Each one is a checkbox.  All off by default:  record raw. */
export const PROCESSING = [
  {
    name: "echoCancellation",
    label: "Echo cancellation",
    help: "For calls.  Removes whatever your own speakers are playing.  It would erase the calibration sounds.",
  },
  {
    name: "noiseSuppression",
    label: "Noise suppression",
    help: "Removes steady background noise, like fans and hum, and some clicks.",
  },
  {
    name: "autoGainControl",
    label: "Automatic gain control",
    help: "Turns the volume up and down to keep your voice level.  It turns background noise up during your pauses.",
  },
  {
    name: "voiceIsolation",
    label: "Voice isolation",
    help: "Only in newer browsers.  Tries to keep your voice and nothing else.",
  },
] as const;
export type ProcessingName = (typeof PROCESSING)[number]["name"];
export type ProcessingChoices = Partial<Record<ProcessingName, boolean>>;

/** The parts of PROCESSING that this browser offers. */
export function supportedProcessing() {
  const supported = navigator.mediaDevices.getSupportedConstraints() as Record<string, boolean | undefined>;
  return PROCESSING.filter(({ name }) => supported[name]);
}

const SAMPLE_RATE = 48000;
/** How often to sample the app's state while recording. */
const SAMPLE_MS = 50;
/** How far ahead to schedule the Start sound, so it's sure to land inside the recording. */
const START_LEAD = 0.25;
/** How long to keep recording after the Stop sound ends, so its echo is inside the file too. */
const STOP_TAIL = 0.5;
/** Where to look for a calibration sound:  from a little before it was played, to this long after. */
const SEARCH_AFTER = 0.3;
/** A match better than this means the sound really was heard.  Noise scores about 0.03, speech up to about 0.08.  See findSound(). */
const HEARD = 0.15;

/**
 * The AudioWorklet.  It runs on the audio thread, and sends the mic's samples to the page in blocks of
 * 2048, with the clock frame of the first one, and the levels for the meter.  It's a string, so this
 * folder doesn't need any build setup to copy into another project.
 */
const WORKLET = /* js */ `
class VoiceRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.reset();
  }
  reset() {
    this.samples = new Float32Array(2048);
    this.filled = 0;
    this.peak = 0;
    this.squares = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    const length = channels.length ? channels[0].length : 128;
    if (this.filled + length > this.samples.length) {
      this.send();
    }
    if (this.filled == 0) {
      this.first = currentFrame;
    }
    for (let i = 0; i < length; i++) {
      // Mono.  Average the channels if there's more than one.
      let v = 0;
      for (const channel of channels) {
        v += channel[i];
      }
      if (channels.length > 1) {
        v /= channels.length;
      }
      this.samples[this.filled + i] = v;
      this.peak = Math.max(this.peak, Math.abs(v));
      this.squares += v * v;
    }
    this.filled += length;
    if (this.filled == this.samples.length) {
      this.send();
    }
    return true;
  }
  send() {
    const samples = this.samples.subarray(0, this.filled);
    const rms = Math.sqrt(this.squares / Math.max(1, this.filled));
    this.port.postMessage({ first: this.first, samples, peak: this.peak, rms }, [this.samples.buffer]);
    this.reset();
  }
}
registerProcessor("voice-recorder", VoiceRecorderProcessor);
`;

type Chunk = { first: number; samples: Float32Array; peak: number; rms: number };

export type HeardResult = {
  sound: CalibrationSound;
  /** Undefined if the sound wasn't found:  speakers muted, or headphones. */
  roundTripMs?: number;
  match: number;
  peakDb: number;
};

/** One recording, from Record to Stop. */
type Take = {
  name: string;
  wav: FileSystemWritableFileStream;
  log: FileSystemWritableFileStream;
  /** performance.now() when the take started.  The log's times are relative to this. */
  perfStart: number;
  /** The clock frame of the file's first sample.  Undefined until the first block arrives. */
  startFrame?: number;
  /** How many samples are in the file so far. */
  frames: number;
  /** Stop writing at this clock frame. */
  stopFrame?: number;
  /** Writes happen in order, one after another. */
  writing: Promise<unknown>;
  lines: string[];
  /** Recent audio, for finding the calibration sounds.  first is a sample index in the file. */
  recent: { first: number; samples: Float32Array }[];
  /** Calibration sounds waiting to be found. */
  listening: { sound: CalibrationSound; frame: number; samples: Float32Array }[];
  finished: Promise<void>;
  finish: () => void;
  sampler: number;
  removeListeners: () => void;
};

/** Numbers in the log get 7 significant digits.  That's plenty, and it keeps the file small. */
function rounded(_key: string, value: unknown) {
  return typeof value == "number" && !Number.isInteger(value) ? Number(value.toPrecision(7)) : value;
}

/** A short description of an element, for the log:  its id, its aria-label, or its tag and text or its label's text. */
function describeElement(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return undefined;
  }
  if (target.id) {
    return `#${target.id}`;
  }
  const named = target.getAttribute("aria-label");
  if (named) {
    return `${target.tagName.toLowerCase()} "${named}"`;
  }
  const text = (target.closest("label") ?? target).textContent?.trim().replace(/\s+/g, " ").slice(0, 40);
  return text ? `${target.tagName.toLowerCase()} "${text}"` : target.tagName.toLowerCase();
}

export class VoiceRecorder {
  readonly context: AudioContext;
  private readonly node: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private stream?: MediaStream;
  private choices: ProcessingChoices;
  private take?: Take;
  /** Called for each block of audio, about 23 times a second, with levels from 0 to 1. */
  onLevel?: (peak: number, rms: number) => void;
  /** Called when a calibration sound is found in the recording, or isn't. */
  onHeard?: (result: HeardResult) => void;
  /** The app's state.  Called 20 times a second while recording. */
  sample?: () => unknown;
  /** More about the app, for the first line of the log. */
  describe?: () => unknown;

  private constructor(context: AudioContext, node: AudioWorkletNode, choices: ProcessingChoices) {
    this.context = context;
    this.node = node;
    this.choices = choices;
    node.port.onmessage = (event: MessageEvent<Chunk>) => this.receive(event.data);
  }

  /** Turn on the mic.  Call this from a click, so the browser lets the audio start. */
  static async open(choices: ProcessingChoices) {
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(context, "voice-recorder");
    // An audio node only runs if it leads to the speakers.  The worklet never writes anything to its
    // output, so this is silent.
    node.connect(context.destination);
    const recorder = new VoiceRecorder(context, node, choices);
    await recorder.connectMic();
    await context.resume();
    return recorder;
  }

  private constraints(): MediaTrackConstraints {
    const result: Record<string, unknown> = { channelCount: { ideal: 1 } };
    for (const { name } of supportedProcessing()) {
      result[name] = this.choices[name] ?? false;
    }
    return result as MediaTrackConstraints;
  }

  private async connectMic() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: this.constraints() });
    this.source = new MediaStreamAudioSourceNode(this.context, { mediaStream: this.stream });
    this.source.connect(this.node);
  }

  private get track() {
    return this.stream?.getAudioTracks()[0];
  }

  /** What the mic actually got.  The browser can quietly ignore a request. */
  actualSettings(): Record<string, unknown> {
    return (this.track?.getSettings() ?? {}) as Record<string, unknown>;
  }

  /** The mic's name, like "MacBook Pro Microphone". */
  get micName() {
    return this.track?.label ?? "";
  }

  get recording() {
    return this.take !== undefined;
  }

  /** The name of the take that's recording now. */
  get takeName() {
    return this.take?.name;
  }

  /**
   * Turn one kind of voice processing on or off.  Works in the middle of a take.  First try changing
   * the mic that's already open.  If the browser won't, open the mic again.  The recording keeps going,
   * on the same clock, with maybe a moment of silence.
   */
  async setProcessing(name: ProcessingName, on: boolean) {
    this.choices = { ...this.choices, [name]: on };
    const requested = this.constraints();
    let how = "applyConstraints";
    try {
      await this.track?.applyConstraints(requested);
    } catch {
      // Handled below.
    }
    if (this.actualSettings()[name] !== on) {
      how = "reopened the mic";
      const old = this.source;
      this.stream?.getTracks().forEach((track) => track.stop());
      old?.disconnect();
      await this.connectMic();
    }
    this.log("processing", { name, on, how, actual: this.actualSettings() });
  }

  /**
   * Start recording into this folder.  Plays the Start sound once the file is open.
   * Returns the take's name.
   */
  async start(folder: FileSystemDirectoryHandle) {
    if (this.take) {
      return this.take.name;
    }
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name = `take ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const open = async (file: string) => (await folder.getFileHandle(file, { create: true })).createWritable();
    const [wav, log] = await Promise.all([open(`${name}.wav`), open(`${name}.jsonl`)]);
    let finish = () => {};
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const take: Take = {
      name,
      wav,
      log,
      perfStart: performance.now(),
      frames: 0,
      writing: wav.write(wavHeader(0)),
      lines: [],
      recent: [],
      listening: [],
      finished,
      finish,
      sampler: 0,
      removeListeners: () => {},
    };
    this.take = take;
    this.log("take", {
      name,
      date: now.toISOString(),
      sampleRate: this.context.sampleRate,
      mic: this.micName,
      requested: this.constraints(),
      actual: this.actualSettings(),
      outputLatency: this.context.outputLatency,
      baseLatency: this.context.baseLatency,
      page: location.href,
      window: [innerWidth, innerHeight, devicePixelRatio],
      app: this.describe?.(),
    });
    take.removeListeners = this.listen();
    take.sampler = window.setInterval(() => this.logSample(), SAMPLE_MS);
    this.play("start", START_LEAD);
    return name;
  }

  /** Play the marker sound, and note it in the log.  For "something important is about to happen." */
  marker() {
    if (this.take) {
      this.play("marker", 0.05);
    }
  }

  /** Play the Stop sound, record a moment more, then close the files. */
  async stop() {
    const take = this.take;
    if (!take) {
      return;
    }
    if (take.stopFrame === undefined) {
      const when = this.play("stop", 0.05);
      const seconds = calibrationSamples("stop", this.context.sampleRate).length / this.context.sampleRate;
      take.stopFrame = Math.round((when + seconds + STOP_TAIL) * this.context.sampleRate);
      // In case the audio stops arriving, don't wait forever.
      window.setTimeout(() => void this.finish(take), (seconds + STOP_TAIL + 3) * 1000);
    }
    await take.finished;
  }

  /** Turn off the mic.  Stops recording first, if it's recording. */
  async close() {
    await this.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.source?.disconnect();
    this.node.disconnect();
    await this.context.close();
  }

  /** Add a line to the log.  Only while recording. */
  log(type: string, data: object = {}, timeStamp = performance.now()) {
    const take = this.take;
    if (!take) {
      return;
    }
    take.lines.push(JSON.stringify({ t: timeStamp - take.perfStart, type, ...data }, rounded) + "\n");
  }

  /** Schedule a calibration sound on the audio clock, and remember to look for it.  Returns when it starts. */
  private play(sound: CalibrationSound, lead: number) {
    const context = this.context;
    const samples = calibrationSamples(sound, context.sampleRate);
    const buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.copyToChannel(samples, 0);
    const node = new AudioBufferSourceNode(context, { buffer });
    node.connect(context.destination);
    const when = context.currentTime + lead;
    node.start(when);
    this.log("sound", {
      sound,
      when,
      frame: Math.round(when * context.sampleRate),
      seconds: samples.length / context.sampleRate,
      outputLatency: context.outputLatency,
    });
    this.take?.listening.push({ sound, frame: Math.round(when * context.sampleRate), samples });
    return when;
  }

  /** A block of audio from the worklet. */
  private receive(chunk: Chunk) {
    this.onLevel?.(chunk.peak, chunk.rms);
    const take = this.take;
    if (!take) {
      return;
    }
    if (take.startFrame === undefined) {
      take.startFrame = chunk.first;
      this.log("audio", { startFrame: chunk.first, sampleRate: this.context.sampleRate });
    }
    let samples = chunk.samples;
    if (take.stopFrame !== undefined) {
      samples = samples.subarray(0, Math.max(0, Math.min(samples.length, take.stopFrame - chunk.first)));
    }
    if (samples.length > 0) {
      const data = samples.slice();
      take.writing = take.writing.then(() => take.wav.write(data));
      take.recent.push({ first: take.frames, samples: data });
      take.frames += data.length;
      // Keep about 4 seconds.
      while (take.recent.length > 1 && take.frames - take.recent[1].first > 4 * this.context.sampleRate) {
        take.recent.shift();
      }
      this.lookForSounds(take);
    }
    if (take.stopFrame !== undefined && chunk.first + chunk.samples.length >= take.stopFrame) {
      void this.finish(take);
    }
  }

  /** Find any calibration sounds that should have arrived by now. */
  private lookForSounds(take: Take) {
    const rate = this.context.sampleRate;
    take.listening = take.listening.filter(({ sound, frame, samples }) => {
      // Where the sound would be in the file if it took no time at all to come back.
      const at = frame - take.startFrame!;
      if (take.frames < at + samples.length + SEARCH_AFTER * rate) {
        return true;
      }
      const first = take.recent[0].first;
      const recent = new Float32Array(take.frames - first);
      for (const piece of take.recent) {
        recent.set(piece.samples, piece.first - first);
      }
      const found = findSound(recent, samples, at - first - 0.02 * rate, at - first + SEARCH_AFTER * rate);
      const heard = found.match > HEARD;
      const result: HeardResult = {
        sound,
        roundTripMs: heard ? ((found.position + first - at) / rate) * 1000 : undefined,
        match: found.match,
        peakDb: found.peakDb,
      };
      this.log("heard", result);
      this.onHeard?.(result);
      return false;
    });
  }

  /** Finish the files and stop.  Safe to call more than once. */
  private async finish(take: Take) {
    if (this.take !== take) {
      return take.finished;
    }
    // The Stop sound is normally found before we get here, since STOP_TAIL is longer than SEARCH_AFTER.
    // Anything still waiting means the audio stopped arriving.
    for (const { sound } of take.listening) {
      const result: HeardResult = { sound, match: 0, peakDb: -Infinity };
      this.log("heard", { ...result, note: "The audio stopped before we could look." });
      this.onHeard?.(result);
    }
    this.log("end", { frames: take.frames, seconds: take.frames / this.context.sampleRate });
    this.take = undefined;
    window.clearInterval(take.sampler);
    take.removeListeners();
    const text = take.lines.join("");
    take.lines = [];
    take.writing = take.writing
      .then(() => take.wav.write({ type: "write", position: 0, data: wavHeader(take.frames) }))
      .then(() => take.wav.close())
      .then(() => take.log.write(text))
      .then(() => take.log.close())
      .catch((error) => console.error("Record mode:  couldn't finish the files", error))
      .finally(() => take.finish());
    return take.finished;
  }

  /** One sample line:  the app's state, the levels, and a pair of clock readings. */
  private logSample() {
    const take = this.take;
    if (!take) {
      return;
    }
    const output = this.context.getOutputTimestamp();
    this.log("sample", {
      clock: {
        perf: performance.now() - take.perfStart,
        audio: this.context.currentTime,
        output: [output.contextTime ?? 0, (output.performanceTime ?? 0) - take.perfStart],
      },
      state: this.sample?.(),
    });
    // Write the log a little at a time, so it's on disk as the take goes.
    if (take.lines.length > 0) {
      const text = take.lines.join("");
      take.lines = [];
      take.writing = take.writing.then(() => take.log.write(text));
    }
  }

  /** Log the user's actions.  Returns a function that stops listening. */
  private listen() {
    const options = { capture: true, passive: true };
    const handlers: [string, (event: Event) => void][] = [
      [
        "keydown",
        (event) => {
          const e = event as KeyboardEvent;
          if (!e.repeat) {
            this.log("keydown", { code: e.code }, e.timeStamp);
          }
        },
      ],
      ["keyup", (event) => this.log("keyup", { code: (event as KeyboardEvent).code }, event.timeStamp)],
      [
        "pointerdown",
        (event) => {
          const e = event as PointerEvent;
          this.log("pointerdown", { button: e.button, x: e.clientX, y: e.clientY, on: describeElement(e.target) }, e.timeStamp);
        },
      ],
      [
        "pointerup",
        (event) => {
          const e = event as PointerEvent;
          this.log("pointerup", { button: e.button, x: e.clientX, y: e.clientY }, e.timeStamp);
        },
      ],
      [
        "wheel",
        (event) => {
          const e = event as WheelEvent;
          this.log("wheel", { dy: e.deltaY, shift: e.shiftKey, ctrl: e.ctrlKey }, e.timeStamp);
        },
      ],
      ["click", (event) => this.log("click", { on: describeElement(event.target) }, event.timeStamp)],
      [
        "change",
        (event) => {
          const target = event.target as HTMLInputElement;
          const value = target.type == "checkbox" ? target.checked : target.value;
          this.log("change", { on: describeElement(target), value }, event.timeStamp);
        },
      ],
    ];
    for (const [type, handler] of handlers) {
      window.addEventListener(type, handler, options);
    }
    return () => {
      for (const [type, handler] of handlers) {
        window.removeEventListener(type, handler, options);
      }
    };
  }
}

/**
 * The header for a 32-bit float, mono WAV file with this many samples.  58 bytes.  It's written as a
 * placeholder first, and again with the real length when the take ends.
 */
function wavHeader(frames: number) {
  const dataBytes = frames * 4;
  const header = new DataView(new ArrayBuffer(58));
  const text = (at: number, value: string) => [...value].forEach((c, i) => header.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  header.setUint32(4, 50 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  header.setUint32(16, 18, true);
  // 3 is IEEE float.
  header.setUint16(20, 3, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, SAMPLE_RATE, true);
  header.setUint32(28, SAMPLE_RATE * 4, true);
  header.setUint16(32, 4, true);
  header.setUint16(34, 32, true);
  header.setUint16(36, 0, true);
  text(38, "fact");
  header.setUint32(42, 4, true);
  header.setUint32(46, frames, true);
  text(50, "data");
  header.setUint32(54, dataBytes, true);
  return header.buffer;
}
