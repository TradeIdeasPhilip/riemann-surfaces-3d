import { canWrite, chooseFolder, rememberedFolder } from "./folder";
import {
  supportedProcessing,
  VoiceRecorder,
  type HeardResult,
  type ProcessingChoices,
  type ProcessingName,
} from "./voice-recorder";

/*
 * Record mode's controls:  a small floating panel with a level meter, the voice processing checkboxes,
 * and Record, Stop, and Marker.  It brings its own styles, so it can be copied into another project
 * along with the rest of this folder.
 */

export type RecordPanelOptions = {
  /** The panel floats in the bottom left corner of this element.  It should be position: relative. */
  parent: HTMLElement;
  /** The app's state, for the log.  Called 20 times a second while recording. */
  sample?: () => unknown;
  /** More about the app, for the first line of each take's log. */
  describe?: () => unknown;
  /** Called after the panel closes. */
  onClose?: () => void;
};

export type RecordPanel = {
  readonly recorder: VoiceRecorder;
  close(): Promise<void>;
};

/** The meter shows −60 to 0 dBFS. */
const METER_FLOOR = -60;
/** Where your voice's peaks should land.  The usual target for speech. */
const VOICE_TARGET_DB = -12;
/** Peaks louder than this count as clipping. */
const CLIP_DB = -1;
const STORAGE = {
  processing: "record-mode.processing",
  soundLevel: "record-mode.sound-level",
};

const CSS = /* css */ `
.rm-panel {
  position: absolute;
  left: 12px;
  bottom: 12px;
  width: 300px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(160, 180, 230, 0.25);
  background: rgba(14, 18, 32, 0.88);
  backdrop-filter: blur(6px);
  color: #e6ecfa;
  font: 13px/1.35 system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
  display: flex;
  flex-direction: column;
  gap: 7px;
  z-index: 20;
}
.rm-panel.rm-recording {
  border-color: #ff5a5f;
}
.rm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 650;
}
.rm-panel button {
  font: inherit;
  color: inherit;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(160, 180, 230, 0.25);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
}
.rm-panel button:hover {
  background: rgba(255, 255, 255, 0.16);
}
.rm-panel button:disabled {
  opacity: 0.5;
  cursor: default;
}
.rm-close {
  padding: 0 7px !important;
  font-size: 16px !important;
}
.rm-meter {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rm-track {
  position: relative;
  flex: 1;
  height: 14px;
  border-radius: 3px;
  background: linear-gradient(to right, #1f6f3d 0%, #1f6f3d 75%, #7a6a10 75%, #7a6a10 93%, #7a1f22 93%);
  overflow: hidden;
}
.rm-level {
  position: absolute;
  inset: 0;
  background: linear-gradient(to right, #3ddc84 0%, #3ddc84 75%, #f2d14c 75%, #f2d14c 93%, #ff5a5f 93%);
}
.rm-peak {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #fff;
}
.rm-mark {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 0;
  border-left: 2px dashed;
}
.rm-mark.rm-voice {
  border-color: #7fd0ff;
}
.rm-mark.rm-sound {
  border-color: #ff9df2;
}
.rm-db {
  width: 62px;
  text-align: right;
}
.rm-clipping .rm-db {
  color: #ff5a5f;
  font-weight: 700;
}
.rm-legend {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: #9aa7c4;
}
.rm-legend span::before {
  content: "";
  display: inline-block;
  width: 10px;
  margin-right: 4px;
  vertical-align: middle;
  border-top: 2px dashed;
}
.rm-legend .rm-voice::before {
  border-color: #7fd0ff;
}
.rm-legend .rm-sound::before {
  border-color: #ff9df2;
}
.rm-choice {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.rm-got {
  margin-left: auto;
  font-size: 11px;
  color: #9aa7c4;
}
.rm-got.rm-mismatch {
  color: #ff9a5f;
}
.rm-small {
  font-size: 11px;
  color: #9aa7c4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rm-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rm-record {
  min-width: 92px;
}
.rm-recording .rm-record {
  background: rgba(255, 90, 95, 0.3) !important;
  border-color: #ff5a5f !important;
}
.rm-time {
  margin-left: auto;
  font-size: 15px;
}
.rm-recording .rm-time::before {
  content: "● ";
  color: #ff5a5f;
}
.rm-status:empty {
  display: none;
}
.rm-status.rm-warning {
  color: #ff9a5f;
}
`;

function addStyles() {
  if (!document.getElementById("rm-styles")) {
    const style = document.createElement("style");
    style.id = "rm-styles";
    style.textContent = CSS;
    document.head.append(style);
  }
}

/** Make an element, with a class and some content. */
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", ...content: (Node | string)[]) {
  const result = document.createElement(tag);
  result.className = className;
  result.append(...content);
  return result;
}

const toDb = (level: number) => 20 * Math.log10(Math.max(level, 1e-6));
/** Where on the meter, 0 to 1. */
const meterFraction = (db: number) => Math.min(1, Math.max(0, (db - METER_FLOOR) / -METER_FLOOR));
const formatDb = (db: number) => (db <= METER_FLOOR ? "−∞ dB" : `${db.toFixed(1).replace("-", "−")} dB`);

function loadChoices(): ProcessingChoices {
  try {
    return JSON.parse(localStorage.getItem(STORAGE.processing) ?? "{}");
  } catch {
    return {};
  }
}

/**
 * Open the panel and turn on the mic.  Call this from a click, so the browser lets audio start.
 * The browser asks for permission to use the mic the first time.
 */
export async function openRecordPanel(options: RecordPanelOptions): Promise<RecordPanel> {
  addStyles();
  const panel = element("div", "rm-panel");
  const close = element("button", "rm-close", "×");
  close.title = "Close record mode";
  const level = element("div", "rm-level");
  const peak = element("div", "rm-peak");
  const voiceMark = element("div", "rm-mark rm-voice");
  const soundMark = element("div", "rm-mark rm-sound");
  const db = element("span", "rm-db", formatDb(-Infinity));
  const meter = element("div", "rm-meter", element("div", "rm-track", level, peak, voiceMark, soundMark), db);
  const legend = element(
    "div",
    "rm-legend",
    element("span", "rm-voice", "voice target"),
    element("span", "rm-sound", "calibration sound, last time")
  );
  const choicesBox = element("div");
  const micLine = element("div", "rm-small", "Turning on the mic…");
  const folderName = element("b", "", "not chosen yet");
  const changeFolder = element("button", "", "Change…");
  changeFolder.style.padding = "0 6px";
  const folderLine = element("div", "rm-small", "Folder: ", folderName, " ", changeFolder);
  const record = element("button", "rm-record", "● Record");
  const marker = element("button", "", "Marker");
  marker.title = "Plays the marker sound, for \"something important is about to happen\".  Shortcut: M";
  const time = element("span", "rm-time", "0:00");
  const status = element("div", "rm-status");
  panel.append(
    element("div", "rm-head", element("span", "", "🎙 Record mode"), close),
    meter,
    legend,
    choicesBox,
    micLine,
    folderLine,
    element("div", "rm-buttons", record, marker, time),
    status
  );
  options.parent.append(panel);

  const say = (text: string, warning = false) => {
    status.textContent = text;
    status.classList.toggle("rm-warning", warning);
  };
  const placeMark = (mark: HTMLElement, value: number | undefined) => {
    mark.hidden = value === undefined;
    mark.style.left = `${meterFraction(value ?? 0) * 100}%`;
  };
  placeMark(voiceMark, VOICE_TARGET_DB);
  const savedSoundLevel = Number(localStorage.getItem(STORAGE.soundLevel));
  placeMark(soundMark, Number.isFinite(savedSoundLevel) && savedSoundLevel < 0 ? savedSoundLevel : undefined);

  let recorder: VoiceRecorder;
  try {
    recorder = await VoiceRecorder.open(loadChoices());
  } catch (error) {
    micLine.textContent = "No mic.";
    say(`Couldn't turn on the mic: ${error instanceof Error ? error.message : error}`, true);
    // Leave the panel up, so you can read why.
    close.addEventListener("click", () => {
      panel.remove();
      options.onClose?.();
    });
    throw error;
  }
  recorder.sample = options.sample;
  recorder.describe = options.describe;

  // The level meter.  The bar is the average level, and the line is the peak, held for a moment.
  let held = -Infinity;
  let heldAt = 0;
  let lastLevel = performance.now();
  let clippedAt = -Infinity;
  recorder.onLevel = (peakLevel, rms) => {
    const now = performance.now();
    const seconds = (now - lastLevel) / 1000;
    lastLevel = now;
    const peakDb = toDb(peakLevel);
    if (peakDb >= held) {
      held = peakDb;
      heldAt = now;
    } else if (now - heldAt > 1000) {
      // Hold the peak for a second, then let it fall 20 dB a second.
      held = Math.max(peakDb, held - 20 * seconds);
    }
    if (peakDb >= CLIP_DB) {
      clippedAt = now;
    }
    level.style.clipPath = `inset(0 ${(1 - meterFraction(toDb(rms))) * 100}% 0 0)`;
    peak.style.left = `calc(${meterFraction(held) * 100}% - 1px)`;
    db.textContent = formatDb(held);
    panel.classList.toggle("rm-clipping", now - clippedAt < 2000);
  };

  // The voice processing checkboxes, and what the mic actually got.
  const gotLabels = new Map<ProcessingName, HTMLElement>();
  const showSettings = () => {
    const actual = recorder.actualSettings();
    const requested = loadChoices();
    for (const [name, got] of gotLabels) {
      const value = actual[name];
      got.textContent = value === undefined ? "got: ?" : `got: ${value ? "on" : "off"}`;
      got.classList.toggle("rm-mismatch", value !== undefined && value !== (requested[name] ?? false));
    }
    const rate = actual.sampleRate ? ` · ${Number(actual.sampleRate) / 1000} kHz` : "";
    micLine.textContent = `Mic: ${recorder.micName || "unknown"}${rate}`;
  };
  for (const { name, label, help } of supportedProcessing()) {
    const box = element("input");
    box.type = "checkbox";
    box.checked = loadChoices()[name] ?? false;
    box.setAttribute("aria-label", label);
    const got = element("span", "rm-got");
    gotLabels.set(name, got);
    const row = element("label", "rm-choice", box, label, got);
    row.title = help;
    box.addEventListener("change", async () => {
      box.blur();
      localStorage.setItem(STORAGE.processing, JSON.stringify({ ...loadChoices(), [name]: box.checked }));
      box.disabled = true;
      try {
        await recorder.setProcessing(name, box.checked);
      } catch (error) {
        say(`Couldn't change ${label.toLowerCase()}: ${error instanceof Error ? error.message : error}`, true);
      }
      box.disabled = false;
      showSettings();
    });
    choicesBox.append(row);
  }
  showSettings();

  // The folder.
  let folder = await rememberedFolder();
  const folderTitle = () => (folder ? folder.name || "browser storage" : "not chosen yet");
  folderName.textContent = folderTitle();
  changeFolder.addEventListener("click", async () => {
    changeFolder.blur();
    try {
      folder = (await chooseFolder()) ?? folder;
      folderName.textContent = folderTitle();
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    }
  });

  // What we heard of the calibration sounds.
  recorder.onHeard = (result: HeardResult) => {
    const name = { start: "Start", stop: "Stop", marker: "Marker" }[result.sound];
    if (result.roundTripMs === undefined) {
      say(
        result.sound == "start"
          ? "Didn't hear the Start sound.  Are the speakers muted, or are you using headphones?  We can line things up with the key clicks instead."
          : `Didn't hear the ${name} sound.`,
        true
      );
      return;
    }
    if (result.sound == "start") {
      localStorage.setItem(STORAGE.soundLevel, String(result.peakDb));
      placeMark(soundMark, result.peakDb);
    }
    say(`Heard the ${name} sound.  Round trip ${result.roundTripMs.toFixed(1)} ms, at ${formatDb(result.peakDb)}.`);
  };

  // Record and Stop.
  let started = 0;
  let clock = 0;
  const showTime = () => {
    const seconds = Math.floor((performance.now() - started) / 1000);
    time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const toggle = async () => {
    record.blur();
    record.disabled = true;
    try {
      if (recorder.recording) {
        const name = recorder.takeName;
        record.textContent = "Saving…";
        await recorder.stop();
        window.clearInterval(clock);
        panel.classList.remove("rm-recording");
        record.textContent = "● Record";
        if (!status.classList.contains("rm-warning")) {
          say(`Saved "${name}" in ${folderTitle()}.`);
        }
      } else {
        if (!folder || !(await canWrite(folder, true))) {
          folder = await chooseFolder();
          folderName.textContent = folderTitle();
        }
        if (!folder) {
          say("Choose a folder for the recordings first.", true);
          return;
        }
        say("");
        await recorder.start(folder);
        started = performance.now();
        clock = window.setInterval(showTime, 250);
        showTime();
        panel.classList.add("rm-recording");
        record.textContent = "■ Stop";
      }
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    } finally {
      record.disabled = false;
    }
  };
  record.addEventListener("click", toggle);
  marker.addEventListener("click", () => {
    marker.blur();
    recorder.marker();
  });
  const onKey = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const typing = target?.closest("input, textarea, select, [contenteditable]");
    if (event.code == "KeyM" && !event.repeat && !typing && recorder.recording) {
      recorder.marker();
    }
  };
  window.addEventListener("keydown", onKey);

  const result: RecordPanel = {
    recorder,
    async close() {
      window.removeEventListener("keydown", onKey);
      window.clearInterval(clock);
      await recorder.close();
      panel.remove();
      options.onClose?.();
    },
  };
  close.addEventListener("click", () => void result.close());
  return result;
}
