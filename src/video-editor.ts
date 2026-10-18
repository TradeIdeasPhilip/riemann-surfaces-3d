/**
 * The "Open video editor" button.  Replace this page with canvas-recorder's editor,
 * showing our demos, so they can be recorded in 4K with sound and annotations.
 *
 * main.ts loads this file only when the button is pressed, so the app itself never
 * loads the library.
 */

import {
  canvasRecorder,
  componentRegistry,
  DurationAgnosticComponent,
  InSeriesComponent,
  RectangleComponent,
  type SoundClip,
} from "canvas-recorder-lib";
import {
  FullScreenComponent,
  type PixelSize,
  type StatusLine,
} from "./full-screen-component";

/** What main.ts gives us. */
export type VideoEditorApp = {
  /** The demos, in the order of the buttons. */
  readonly demoNames: readonly string[];
  /** Put the whole app back in its starting state, then start this demo. */
  restart(demoName: string): void;
  /** The current demo's estimate of how long it has left, or undefined if no demo is running. */
  remainingSeconds(): number | undefined;
  /**
   * Move everything forward by this many seconds, with no keyboard or mouse input.
   * @param hold true to keep the demo where it is, while the robots and the cloud keep moving.
   */
  step(dtSeconds: number, hold: boolean): void;
  /** Draw the input and output views at these sizes.  Returns those two canvases. */
  render(sizes: readonly PixelSize[]): readonly HTMLCanvasElement[];
  /** The same information as the readout card. */
  readout(): {
    rows: readonly { color: number; label: string; value: string }[];
    notes: readonly string[];
  };
  /** The narrated tour's current line. */
  caption(): string | undefined;
};

/** The demo that opens in the editor.  This is the video. */
const MAIN_DEMO = "Narrated tour";

/** Where things go, in canvas units (16 × 9).  All of these can be changed in the Visual Editor. */
const LAYOUT = {
  input: { x: 0, y: 0, width: 9, height: 9 },
  output: { x: 9, y: 2, width: 7, height: 7 },
  status: { x: 9.25, y: 0.2, width: 6.5, height: 1.7 },
  caption: { x: 0.25, y: 7.1, width: 8.5, height: 1.75 },
};

/** The page's background color, from style.css. */
const BACKGROUND = "#121829";

function cssColor(color: number) {
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function openVideoEditor(app: VideoEditorApp) {
  hideOurStyles();

  /** In milliseconds.  Each demo is measured the first time it's needed. */
  const durations = new Map<string, number>();
  function durationOf(name: string) {
    let duration = durations.get(name);
    if (duration === undefined) {
      app.restart(name);
      // The demos' own estimate.  Plus a little time at the end, so the last moment isn't cut off.
      const seconds = (app.remainingSeconds() ?? 60) + 2;
      duration = Math.ceil(seconds * 1000);
      durations.set(name, duration);
    }
    return duration;
  }

  function status(): StatusLine[] {
    const { rows, notes } = app.readout();
    return [
      ...rows.map(({ color, label, value }) => ({ chip: cssColor(color), label, value })),
      ...notes.map((note) => ({ label: note, small: true })),
    ];
  }

  function makeDemo(name: string) {
    const demo = new FullScreenComponent({
      registryKey: `Riemann: ${name}`,
      description: name,
      duration: durationOf(name),
      source: {
        restart: () => app.restart(name),
        step: app.step,
        render: app.render,
        status,
      },
      canvases: [
        { description: "Input View", rect: LAYOUT.input },
        { description: "Output View", rect: LAYOUT.output },
      ],
      statusRect: LAYOUT.status,
      captionRect: LAYOUT.caption,
      soundClips:
        name == MAIN_DEMO
          ? [{ source: "./Narrated Tour.m4a", startMsIntoScene: 0, notes: "Voiceover" }]
          : undefined,
    });
    madeDemos.push(demo);
    return demo;
  }

  // Register every demo, so the Visual Editor can add any of them, and save and load them.
  for (const name of app.demoNames) {
    componentRegistry.set(`Riemann: ${name}`, {
      create: () => makeDemo(name),
      description: `The "${name}" demo from Riemann Surfaces 3D, drawn by the program itself.`,
    });
  }

  const root = new DurationAgnosticComponent("Riemann Surfaces 3D");
  const background = new RectangleComponent({
    description: "Background",
    color: BACKGROUND,
    rect: { x: 0, y: 0, width: 16, height: 9 },
  });
  const demos = new InSeriesComponent({ description: "Demos" });
  demos.replaceableComponents!.push(makeDemo(MAIN_DEMO));
  root.replaceableComponents!.push(background, demos);

  canvasRecorder.start(root, { name: "riemann-surfaces-3d" });
  philDebug.cutSound = cutSound;
  /** The demo components in the video.  For poking at from the console, e.g. `philDebug.demos()[0].prerollScalar.value`. */
  philDebug.demos = () => madeDemos.filter((demo) => demo.parent);
  /** Every sound clip in our demos, as a table.  Times in ms. */
  philDebug.listSounds = () =>
    console.table(madeDemos.flatMap((demo) => (demo.parent ? (demo.soundClips ?? []) : [])));
}

//
// Console tools.  philDebug is the library's object for things to call from the browser's console.
//

const philDebug = (globalThis as unknown as { philDebug: Record<string, unknown> }).philDebug;

/** Every demo component we've made, so the console tools can find the one in the video. */
const madeDemos: FullScreenComponent[] = [];

/**
 * Cut holes out of a sound clip, without moving anything else.  Each clip that plays from `source`
 * becomes one clip per piece that's left, each playing at exactly the same moment as before.
 *
 * `holes` are `[fromMs, toMs]` pairs, measured from the start of the sound *file*, like the times in
 * properties/Narrated Tour.transcript.json.
 *
 * For example, the two retakes in the first recording:
 * `philDebug.cutSound("./Narrated Tour.m4a", [[161400, 165280], [200670, 207560]])`
 */
function cutSound(source: string, holes: readonly (readonly [number, number])[]) {
  const sorted = [...holes].sort((a, b) => a[0] - b[0]);
  const report: { notes: string; fileFromMs: number; fileToMs: number | string; startMsIntoScene: number }[] = [];
  let changed = 0;
  for (const demo of madeDemos) {
    const clips = demo.soundClips;
    // Only the ones in the video have a parent.
    if (!clips || !demo.parent) {
      continue;
    }
    for (let index = clips.length - 1; index >= 0; index--) {
      const clip = clips[index];
      if (clip.source != source) {
        continue;
      }
      // The part of the file this clip plays.
      const from = clip.startMsIntoClip ?? 0;
      const to = clip.lengthMs === undefined ? Infinity : from + clip.lengthMs;
      const pieces: [number, number][] = [];
      let start = from;
      for (const [holeFrom, holeTo] of sorted) {
        if (holeTo <= start || holeFrom >= to) {
          continue;
        }
        if (holeFrom > start) {
          pieces.push([start, holeFrom]);
        }
        start = Math.max(start, holeTo);
      }
      if (start < to) {
        pieces.push([start, to]);
      }
      const replacements: SoundClip[] = pieces.map(([a, b], i) => ({
        source,
        startMsIntoScene: clip.startMsIntoScene + (a - from),
        startMsIntoClip: a,
        ...(b === Infinity ? {} : { lengthMs: b - a }),
        notes: pieces.length > 1 ? `${clip.notes ?? "Sound"} ${i + 1}/${pieces.length}` : clip.notes,
      }));
      clips.splice(index, 1, ...replacements);
      changed++;
      for (const r of replacements) {
        report.push({
          notes: r.notes ?? "",
          fileFromMs: r.startMsIntoClip!,
          fileToMs: r.lengthMs === undefined ? "end of file" : r.startMsIntoClip! + r.lengthMs,
          startMsIntoScene: r.startMsIntoScene,
        });
      }
    }
    if (changed) {
      // Tell the editor, so it saves, and rebuild the sound.
      demo.parent?.scheduleHasChanged();
    }
  }
  (philDebug.refreshSounds as (() => void) | undefined)?.();
  if (changed == 0) {
    console.warn(`No sound clip plays "${source}".`);
  } else {
    console.table(report);
  }
}

/**
 * Turn off this app's own CSS, so it doesn't restyle the editor.
 * Keep the stylesheets that only load fonts:  the editor still draws with Roboto.
 */
function hideOurStyles() {
  for (const sheet of document.styleSheets) {
    let onlyFonts = true;
    try {
      onlyFonts = [...sheet.cssRules].every((rule) => rule instanceof CSSFontFaceRule);
    } catch {
      // Can't read another origin's rules.  Leave that sheet alone.
      continue;
    }
    if (!onlyFonts) {
      sheet.disabled = true;
    }
  }
}
