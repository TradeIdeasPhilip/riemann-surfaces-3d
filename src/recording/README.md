# Record mode

Records your voice, what you do, and what the app is doing, all on one clock, for planning demos.
The plan, the reasons, and the numbers are in [development-notes/record-mode.md](../../development-notes/record-mode.md).

This folder doesn't depend on the rest of the app, so it can be copied into another project, like the video editor.
The app only adds a button, and a `sample()` function that describes its state (see `recordingState()` in `src/main.ts`).

| File | What it does |
| --- | --- |
| `record-panel.ts` | The floating panel:  level meter, voice processing checkboxes, Record, Stop, and Marker.  Brings its own styles. |
| `voice-recorder.ts` | The engine:  the mic, an AudioWorklet that copies the samples, the WAV and log files, and the calibration sounds.  No user interface. |
| `calibration-sounds.ts` | The Start, Stop, and Marker sounds, and the code that finds them in a recording.  Plain functions, so Node can use them too. |
| `folder.ts` | Remembers which folder the takes go in. |
| `analyze-take.ts` | A Node script.  Checks a take's timing, and writes a timeline that lines up with a transcript. |
| `transcribe.ts` | Wraps the video editor library's transcriber, for scripts. |

## Using it

1. Click **🎙 Record mode**.  The browser asks to use the mic the first time.
2. Watch the meter, and check your level.  The blue mark is the target for your voice.
3. Click **● Record**.  The first time, choose a folder.  The project's `recordings/` folder is a good place:  git ignores it, and the dev server can serve it to the transcriber.
4. You hear the Start sound.  Talk, and use the app.  Press **M** (or Marker) before something important.
5. Click **■ Stop**.  You hear the Stop sound, and the panel says what it heard.

Each take is two files:  `take <date> <time>.wav` (32-bit float, mono, 48 kHz) and `.jsonl` (the log).

## Afterward

```
node src/recording/analyze-take.ts "recordings/take 2026-10-22 11-54-40.jsonl"
```

That writes `<take>.timeline.txt`:  every action, in seconds into the WAV file.
Transcribe the WAV with the video editor library's transcriber (`transcribeTake()` in `transcribe.ts`, in a browser), and the two line up.
