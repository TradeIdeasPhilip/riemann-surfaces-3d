# Negative preroll, and catching up

**Status:**  on hold since 2026-10-18.  Nothing here is in `master`.  Pick one of the two options below.

`src/full-screen-component.ts` puts this program into the video editor.  It's meant to be copied
by other projects, so whatever we decide here matters beyond this project.

## The problem

The program animates by stepping forward, exactly 1/60 s per step, so getting to time *t* means
replaying every step from the beginning.  In `master` that replay is synchronous:

- **Negative preroll** skips the start of the action.  `#restart()` replays every skipped step at once,
  inside `show()`, inside the animation frame callback.  A −200 s preroll is 12,000 steps, about
  85 µs each, so **the page freezes for about a second**.  It happens again on every restart:  any
  backward seek, or any change to the timing.
- **Seeking** far ahead in the live preview takes as many steps as fit in 8 ms per screen refresh,
  with a red light until it catches up.  No freeze, but it uses only about half of each frame.
- **Recording**:  `getFramePromises()` catches up synchronously with no time limit.  The frames are
  exact, but a big jump freezes the editor, including the Stop Recording button.

In every case the steps are the same size, so the pictures are exact once it's caught up.

## Option A:  don't allow a negative preroll

Simplest, and the original feature was speculative anyway:  nobody needs a negative preroll in this
project.

- Clamp to 0 if a negative value is found, e.g. in an old saved file.
- Prevent new negative values.
- Warn about existing negative values in the Visual Editor.  Find out how the library shows a warning
  for a component's setting.
- Test any custom editors here first, and maybe port them back to the library once they're stable.
- Postroll:  decide the same question.  A negative postroll only shortens the end, so it's cheap, but
  it might be clearer to treat both the same way.
- Keep the current synchronous catch-up for seeking and recording, or combine with option B.

## Option B:  a background catch-up loop

Started on the local branch **`async-catchup-and-readme`**, commit **7f61904**:  one commit on top of
`master`, changing only `src/full-screen-component.ts`.  To look at it:

```
git diff master async-catchup-and-readme
git switch async-catchup-and-readme
```

**The user's complaint after a quick look:**  the preroll appeared to be broken, and the quality still
looked low.  Not investigated yet.  Start there.

### The design

- Count program steps, not video frames.  Video frame *n* needs step `n + skip`, where `skip` comes
  from a negative preroll.  Step *k* is a "hold" step if a positive preroll covers it.
- `#restart()` is cheap:  restart, one hold step, `#frame = 0`.  No skipping.
- `#want(time, stepsNow)` sets the target, restarting first if the target is behind, takes up to
  `stepsNow` steps right away, and starts the background loop if it's still behind.
- `show()` calls `#want(time, 3)`:  normal playback is one step per frame, done right away.  A big jump
  goes to the loop, and `show()` draws the latest state, with the red light.
- The background loop takes steps for 8 ms, yields to the browser, and repeats.  It reads everything
  fresh each time around, so restarts and new targets need no special handling.
- `getFramePromises()` calls `#want(time, 0)`.  If it's not there yet, it adds a promise that resolves
  when the loop reaches that step.  Recording waits without freezing.

### What we learned

- **How to yield matters most.**
  - `setTimeout(…, 0)` is clamped to at least 4 ms after a few nested calls, so the loop crawls.
  - `scheduler.yield()` continues *ahead of* drawing, so the screen only updated every ~150 ms.
  - A `MessageChannel` message to ourselves is an ordinary task, so the browser draws in between.
    This is what the branch uses.
- **Batching mattered.**  One step per yield took 6 s to catch up on 200 s; 8 ms batches took 2.5 s.
  Each yield costs more than one step does.

### Measurements (visible Chrome window, −200 s or 200 s jump)

| | `master` (synchronous) | 1 step per yield | 4 ms batches | 8 ms batches (the branch) |
|---|---|---|---|---|
| Preroll −200 s:  time to catch up | 1.05 s | 5.95 s | 2.77 s | 2.49 s |
| Preroll −200 s:  longest frame | **1,034 ms freeze** | 83 ms | 68 ms | 67 ms |
| Seek to 200 s:  time to catch up | 5.7 s | | 8.9 s | 6.2 s |
| `getFramePromises()`, 150 s back | freezes | | 4.9 s | 2.8 s |

The state reached was identical, bit for bit, by every path.  Normal playback was unchanged.

### Open questions for option B

- The user's complaint above.  Check the preroll and the picture quality first.
- Seeking was a little slower than `master` (6.2 s vs 5.7 s).  The loop gets only the time the editor
  isn't using, where `master` took 8 ms in every frame.
- In test C, `show()` was pulling the program toward the playhead at the same time, so it went past
  the step the promise asked for.  During a real recording the playhead follows the recording, so this
  shouldn't happen, but it's worth confirming.

### Testing

[catch-up-test.mjs](catch-up-test.mjs) is the test that produced the numbers above.  The comment at
the top says how to run it.  It needs `philDebug.demos()`, which is in `master`.
