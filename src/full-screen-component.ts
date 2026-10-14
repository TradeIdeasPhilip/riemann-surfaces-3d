/**
 * Record what a program already draws on the screen, using canvas-recorder-lib.
 *
 * Nothing in this file knows about this program.  It should work in any program that
 * draws with its own canvases (three.js, WebGL, 2D, …) and can step its animation forward
 * by a given amount of time.  Copy it as is.
 */

import {
  canvasRecorder,
  NumberScheduleInfo,
  RectangleScheduleInfo,
  type Scalar,
  type Showable,
  type ShowableParent,
  type ShowOptions,
  type SoundClip,
} from "canvas-recorder-lib";

/** A size in device pixels. */
export type PixelSize = { readonly width: number; readonly height: number };

/** One line of the statistics area. */
export type StatusLine = {
  /** A CSS color for a dot at the start of the line. */
  readonly chip?: string;
  readonly label: string;
  /** Drawn on the right side of the line. */
  readonly value?: string;
  /** Smaller and dimmer, for notes. */
  readonly small?: boolean;
};

/**
 * What a program provides so {@link FullScreenComponent} can record it.
 *
 * The rule:  the same sequence of calls must always give the same pictures.
 * So `step()` must not read the clock, the keyboard or the mouse, and `restart()` must
 * put *everything* back the way it was.
 */
export type FullScreenSource = {
  /** Go back to time 0 and start over. */
  restart(): void;
  /**
   * Move the animation forward by exactly this many seconds.  Don't draw.
   * @param hold true means time passes but the action doesn't:  keep the background going
   * (idle animations, clouds drifting, …) and leave the scripted action where it is.
   * Used for the preroll, and for one step right after {@link restart}.
   */
  step(dtSeconds: number, hold: boolean): void;
  /**
   * Draw the current state.
   * @param sizes The exact size, in device pixels, for each canvas, in order.
   * @returns The canvases, freshly drawn.  We copy them immediately.
   */
  render(sizes: readonly PixelSize[]): readonly HTMLCanvasElement[];
  /** Lines for the statistics area, if any. */
  status?(): readonly StatusLine[];
  /** A caption to show, if any. */
  caption?(): string | undefined;
};

type CanvasSlot = {
  /** Shown in the Visual Editor, e.g. "Input View". */
  readonly description: string;
  /** Where to draw this canvas, in canvas units. */
  readonly rect: { x: number; y: number; width: number; height: number };
};

/**
 * Show a program's own canvases, plus some statistics and a caption, in the video editor.
 *
 * Each canvas goes in a rectangle that you can move in the Visual Editor.
 * We ask the program to draw at the exact pixel size of that rectangle on the editor's canvas,
 * then copy it 1:1.  So the result is as sharp as the program's own window, at any size,
 * including 4K when recording.
 *
 * **Time.**  The program animates by stepping forward, and its state depends on its history.
 * So we can't jump to a random time.  Instead we step forward 1/fps of a second at a time,
 * and start over from the beginning if asked to go back.
 * - When recording, every frame is exact.  We take as many steps as needed.
 * - In the live preview, a big jump can take a while to catch up.  We spend a few milliseconds
 *   per frame catching up, and show a red warning light until we have.
 *
 * **The first frame.**  Right after a restart, the program's scene still shows whatever it
 * showed before:  the camera, headings and so on are only updated when it steps.  So after
 * every restart we take one {@link FullScreenSource.step | hold} step, and frame 0 shows that.
 *
 * **Preroll and postroll** add time before and after the action, in milliseconds.
 * Positive preroll holds the opening scene, with the background still moving.
 * Negative preroll skips that much of the beginning.  Postroll is the same at the end.
 * Changing the preroll moves this component's sound clips by the same amount, so they stay
 * in sync with the action.
 */
export class FullScreenComponent implements Showable {
  /** Only one of these can drive the program at a time.  This is the one that did last. */
  static #active: FullScreenComponent | undefined;

  readonly registryKey: string;
  readonly description: string;
  /** Set by our parent.  We tell it when our duration changes. */
  parent?: ShowableParent;
  /** How long the action takes, in milliseconds.  Not counting preroll or postroll. */
  readonly #actionDuration: number;
  get duration() {
    return Math.max(
      1000 / canvasRecorder.fps,
      this.#actionDuration + this.#prerollMs + this.#postrollMs,
    );
  }
  readonly source: FullScreenSource;
  readonly canvasRectSchedules: readonly RectangleScheduleInfo[];
  readonly statusRectSchedule: RectangleScheduleInfo;
  readonly statusFontSizeSchedule: NumberScheduleInfo;
  readonly captionRectSchedule: RectangleScheduleInfo;
  readonly captionFontSizeSchedule: NumberScheduleInfo;
  readonly showCaptionScalar: Scalar<"select"> = {
    description: "Show Caption",
    type: "select",
    choices: ["show", "hide"],
    value: "show",
  };
  #prerollMs = 0;
  /** See {@link FullScreenComponent}.  Changing it moves the sound clips and the duration. */
  readonly prerollScalar: Scalar<"number"> = this.#notifyingScalar(
    "Preroll (ms)",
    () => this.#prerollMs,
    (value) => {
      const change = value - this.#prerollMs;
      this.#prerollMs = value;
      // Keep the sound in sync with the action.  A clip may start before its component;
      // the part before the start of the video is skipped.
      this.soundClips?.forEach((clip) => (clip.startMsIntoScene += change));
    },
  );
  #postrollMs = 0;
  /** See {@link FullScreenComponent}.  Changing it changes the duration. */
  readonly postrollScalar: Scalar<"number"> = this.#notifyingScalar(
    "Postroll (ms)",
    () => this.#postrollMs,
    (value) => (this.#postrollMs = value),
  );
  readonly schedules: readonly (RectangleScheduleInfo | NumberScheduleInfo)[];
  readonly scalars = [this.prerollScalar, this.postrollScalar, this.showCaptionScalar];
  soundClips?: SoundClip[];

  /** A number scalar that tells our parent when it changes, because it changes our duration. */
  #notifyingScalar(
    description: string,
    get: () => number,
    set: (value: number) => void,
  ): Scalar<"number"> {
    const self = this;
    return {
      description,
      type: "number",
      get value() {
        return get();
      },
      set value(value: number) {
        if (!Number.isFinite(value) || value == get()) {
          return;
        }
        set(value);
        // Our timing changed.  Start over the next time we're shown.
        if (FullScreenComponent.#active === self) {
          FullScreenComponent.#active = undefined;
        }
        self.parent?.scheduleHasChanged();
      },
    };
  }

  constructor(options: {
    /** The name in componentRegistry. */
    registryKey: string;
    description: string;
    /** How long the action takes, in milliseconds.  Preroll and postroll are added to this. */
    duration: number;
    source: FullScreenSource;
    canvases: readonly CanvasSlot[];
    statusRect?: CanvasSlot["rect"];
    captionRect?: CanvasSlot["rect"];
    soundClips?: SoundClip[];
  }) {
    this.registryKey = options.registryKey;
    this.description = options.description;
    this.#actionDuration = options.duration;
    this.source = options.source;
    this.soundClips = options.soundClips;
    this.canvasRectSchedules = options.canvases.map(
      ({ description, rect }) => new RectangleScheduleInfo(description, rect),
    );
    this.statusRectSchedule = new RectangleScheduleInfo(
      "Statistics",
      options.statusRect ?? { x: 0.25, y: 0.25, width: 4, height: 2 },
    );
    this.statusFontSizeSchedule = new NumberScheduleInfo("Statistics Font Size", 0.22);
    this.captionRectSchedule = new RectangleScheduleInfo(
      "Caption",
      options.captionRect ?? { x: 1, y: 7.25, width: 14, height: 1.5 },
    );
    this.captionFontSizeSchedule = new NumberScheduleInfo("Caption Font Size", 0.25);
    this.schedules = [
      ...this.canvasRectSchedules,
      this.statusRectSchedule,
      this.statusFontSizeSchedule,
      this.captionRectSchedule,
      this.captionFontSizeSchedule,
    ];
  }

  // MARK: Time

  /**
   * Which frame the program is showing now:  0 right after a restart, then one more per step.
   * Frame n is what we show at time n / fps.
   */
  #frame = 0;

  /** Convert milliseconds to a whole number of frames. */
  #frames(ms: number) {
    // The small fudge keeps 1000/60 × 3 from rounding down to 2.
    return Math.floor((ms / 1000) * canvasRecorder.fps + 1e-6);
  }

  /** Go back to frame 0. */
  #restart() {
    FullScreenComponent.#active = this;
    const dt = 1 / canvasRecorder.fps;
    this.source.restart();
    // Let the program bring its scene up to date with its new state.  See "The first frame".
    this.source.step(dt, true);
    // Negative preroll:  skip the beginning of the action.
    const skip = this.#frames(-this.#prerollMs);
    for (let i = 0; i < skip; i++) {
      this.source.step(dt, false);
    }
    this.#frame = 0;
  }

  /**
   * Step the program forward until it's at `timeInMs`.
   * @param budgetMs Stop early after this much work.
   * @returns true if we got there, false if we stopped early.
   */
  #catchUp(timeInMs: number, budgetMs: number): boolean {
    const target = Math.max(0, this.#frames(timeInMs));
    if (FullScreenComponent.#active !== this || target < this.#frame) {
      this.#restart();
    }
    const dt = 1 / canvasRecorder.fps;
    // Positive preroll:  hold the opening scene for this many frames.
    const holdUntil = this.#frames(this.#prerollMs);
    const deadline = performance.now() + budgetMs;
    while (this.#frame < target) {
      this.#frame++;
      this.source.step(dt, this.#frame <= holdUntil);
      if (performance.now() > deadline) {
        break;
      }
    }
    return this.#frame == target;
  }

  /** Only called when recording.  Get to the exact frame, however long it takes. */
  getFramePromises(timeInMs: number, set: Pick<Set<Promise<unknown>>, "add">) {
    if (timeInMs < 0 || timeInMs > this.duration) {
      // Parents ask every child, even the ones that aren't on screen now.
      // Stepping now would take the program away from whoever is.
      return;
    }
    this.#catchUp(timeInMs, Infinity);
    set.add(document.fonts.load(this.#font(1)));
  }

  // MARK: Drawing

  #font(size: number) {
    return `500 ${size}px Roboto, system-ui, sans-serif`;
  }

  show({ context, timeInMs }: ShowOptions) {
    const exact = this.#catchUp(timeInMs, 8);

    // The size of each rectangle in device pixels, on whatever canvas we're drawing to now.
    const m = context.getTransform();
    const xScale = Math.hypot(m.a, m.b);
    const yScale = Math.hypot(m.c, m.d);
    const rects = this.canvasRectSchedules.map((schedule) => schedule.at(timeInMs));
    const sizes = rects.map(({ width, height }) => ({
      width: Math.max(1, Math.round(width * xScale)),
      height: Math.max(1, Math.round(height * yScale)),
    }));
    const canvases = this.source.render(sizes);
    canvases.forEach((canvas, i) => {
      const { x, y, width, height } = rects[i];
      context.drawImage(canvas, x, y, width, height);
    });

    const status = this.source.status?.();
    if (status) {
      this.#drawStatus(
        context,
        this.statusRectSchedule.at(timeInMs),
        this.statusFontSizeSchedule.at(timeInMs),
        status,
      );
    }
    const caption = this.showCaptionScalar.value == "show" ? this.source.caption?.() : undefined;
    if (caption) {
      this.#drawCaption(
        context,
        this.captionRectSchedule.at(timeInMs),
        this.captionFontSizeSchedule.at(timeInMs),
        caption,
      );
    }

    if (!exact && rects.length > 0) {
      // Still catching up.  The picture is from an earlier time.
      const { x, y, width } = rects[0];
      context.fillStyle = "red";
      context.beginPath();
      context.arc(x + width - 0.25, y + 0.25, 0.12, 0, 2 * Math.PI);
      context.fill();
    }
  }

  #drawStatus(
    context: CanvasRenderingContext2D,
    rect: CanvasSlot["rect"],
    size: number,
    lines: readonly StatusLine[],
  ) {
    context.save();
    context.beginPath();
    context.rect(rect.x, rect.y, rect.width, rect.height);
    context.clip();
    context.textBaseline = "top";
    let y = rect.y;
    for (const { chip, label, value, small } of lines) {
      const fontSize = small ? size * 0.85 : size;
      context.font = this.#font(fontSize);
      context.fillStyle = small ? "#9aa7c4" : "#e6ecfa";
      let x = rect.x;
      if (chip) {
        const radius = fontSize * 0.32;
        context.save();
        context.fillStyle = chip;
        context.beginPath();
        context.arc(x + radius, y + fontSize * 0.5, radius, 0, 2 * Math.PI);
        context.fill();
        context.restore();
        x += fontSize;
      }
      context.textAlign = "left";
      context.fillText(label, x, y);
      if (value !== undefined) {
        context.textAlign = "right";
        context.fillText(value, rect.x + rect.width, y);
      }
      y += fontSize * 1.35;
    }
    context.restore();
  }

  #drawCaption(
    context: CanvasRenderingContext2D,
    rect: CanvasSlot["rect"],
    size: number,
    caption: string,
  ) {
    context.font = this.#font(size);
    const padding = size * 0.6;
    const lines = wrap(context, caption, rect.width - 2 * padding);
    const lineHeight = size * 1.35;
    const width = Math.max(...lines.map((line) => context.measureText(line).width)) + 2 * padding;
    const height = lines.length * lineHeight + 2 * padding;
    // Centered at the bottom of its rectangle, growing up.
    const left = rect.x + (rect.width - width) / 2;
    const top = rect.y + rect.height - height;
    context.fillStyle = "rgba(10, 14, 26, 0.75)";
    context.beginPath();
    context.roundRect(left, top, width, height, size * 0.5);
    context.fill();
    context.fillStyle = "#e6ecfa";
    context.textAlign = "center";
    context.textBaseline = "top";
    lines.forEach((line, i) => {
      context.fillText(line, rect.x + rect.width / 2, top + padding + i * lineHeight);
    });
  }
}

/** Break `text` into lines no wider than `maxWidth`, using the context's current font. */
function wrap(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}
