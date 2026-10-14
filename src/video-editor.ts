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
    return new FullScreenComponent({
      registryKey: `Riemann: ${name}`,
      description: name,
      duration: durationOf(name),
      source: {
        restart: () => app.restart(name),
        step: app.step,
        render: app.render,
        status,
        caption: app.caption,
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
