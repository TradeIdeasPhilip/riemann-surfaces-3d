# Record Mode

Record the user's voice.
My code hasn't asked for that permission yet, but we've done a lot of similar tasks so this isn't out of scope.
Record this ourselves so we can synchronize between the voiceover and the other events we record.
Save it continuously as a stream so a large voiceover is not a problem.

Periodically sample and record the current setup.
E.g. the current value of z and position of the camera.
Anything that the user might have modified, any possibly the automated items too.

Record any relevant user actions exactly when they happen.
E.g. start a demo or disable the rainbow floor.
Sampling is required for continuous motion, like dragging the mouse, but starting a demo is a pretty discrete action.

## Goal / Use Case

Do a rough demo where I'm talking and using the mouse and keyboard to do things.
Use the recorded actions to see what I was trying to do and when.
Use these to recreate the demos programmatically and more smoothly and remove any mistakes.

We will have a way to cut the audio parts, as needed, cutting the other parts of the script, too, to keep them in sync.
And we can _nondestructively_ cut everything so it's easy to make adjustments to the cut and to peek at what was cut.
I had good results doing pretty much the same thing in the video editor project recently, so I'm sure we can do the same here.

Note that the video editor also makes it easy to extract (and cache) the text and timings of everything that is spoken in an audio track.
Claude helped me edit the first Riemann video.
In particular, Claude would adjust the code to match the voiceover, and it worked very well.

Next time, instead of just a voiceover and a few additional stage directions, I also want to provide this recording of a live demo.
Claude could do magic with those three combined.

## Notes from Claude (2026-10-20)

### Will it be useful?

Yes.
Most of the back and forth on the narrated tour was me guessing what you meant, then you correcting it:  where the camera should be, which way it should turn, the exact moment something should happen.
A recording turns "what you meant" into numbers with times on them.
Camera framing is where it helps most, because it's the hardest thing to describe in words.

It won't replace building the demo in code.
Live mouse paths and drags are noisy, and the code version can hit exact landmarks, like "just barely past the cones."
I'd treat the recording as the plan:  what happens, in what order, when, and roughly where.
Sometimes smoothing the recorded motion might be good enough, especially for camera swings.
Decide that scene by scene.

### What to record

**Events**, at the moment they happen:
- a demo starting or stopping, and which one
- switching functions, walk/explore mode, Reset, Clear trails
- every checkbox, slider, and select change
- zooming, and click-to-walk targets
- keys down and up, and pointer down and up
- markers (see below)

**Samples**, about 20 per second:
- z, heading, and **w**.  z alone doesn't say which sheet you're on.
- the floating eye's z, w, and heading
- the camera rig (yawOffset, pitch, distance, pull) and the camera's actual position
- view.scale and targetScale
- the running demo and its remaining time
- the 3D floor's lift and the rainbow floor's fade

There's no need to record the outputs, since they come from w, or anything purely decorative.

### Format

JSON lines, one object per line, so a long take is easy to append to and easy for me to read.
Every time is in ms from the start of the recording, all from one clock (`performance.now()`).
The first line says what was running:  the git commit, the function, the starting state, and the window size.
20 samples a second for 10 minutes is about 12,000 lines, a few MB.

### Audio, and keeping it in sync

The audio clock is the master, the same as in the video editor.
`AudioContext.currentTime` is driven by the sound hardware, so it's just as steady while recording as while playing.

- Run the mic through an `AudioContext` (`getUserMedia`, then a `MediaStreamAudioSourceNode`), and copy the raw samples out with a small AudioWorklet.
  Then sample *n* of the file is at exactly the start time plus *n* / sampleRate on the audio clock.
  Don't use `MediaRecorder`:  it hides its timing, and its start can be off by tens of ms or more.
- Stream the samples to disk as they arrive, through the File System Access API.
  That's how the editor's Save As already writes to `properties/`, and the browser remembers the folder, so a long take never lives only in memory.
  Save 32-bit float WAV, mono:  about 12 MB a minute.  Compress it later if we want.
  16-bit would be half the size, but float never throws away detail, so turning a quiet stretch up later costs nothing.
  The one thing nothing can fix afterward is clipping, when a sound is too loud for the mic before any software sees it.
  That's what the volume meter is for.
  Check that the library's transcriber (`makeTranscript()`) accepts WAV, or convert with ffmpeg.
- Put the events on the audio clock too.
  Use `event.timeStamp`, which is when the input really happened, not when the handler ran.
  `audioContext.getOutputTimestamp()` gives matched pairs of the audio clock and `performance.now()`, so the conversion is exact.
  The two clocks drift apart by maybe a few ms a minute, so log a fresh pair in every sample line.
- One small constant offset is left:  the mic and the OS buffer the sound, maybe 10–20 ms, before we see it.
  The key and trackpad clicks are audible in the recording, so find them in the waveform and compare them with the logged events.
  That measures the offset once, and it's a good automatic check that everything lines up.

All of this is far more precise than we need (a spoken word is a few hundred ms, and live mouse moves are rough anyway), but it's the simple way to never think about sync again.

**Turn off the browser's voice processing.**
Chrome's `getUserMedia` turns on echo cancellation, noise suppression, and automatic gain control by default.
Ask for `{ echoCancellation: false, noiseSuppression: false, autoGainControl: false }`.
Echo cancellation exists to remove whatever the speakers play from the mic, so it would erase the calibration sounds below.
Automatic gain control changes the level in the middle of a take, and Chrome's version can even move the Mac's own input volume.
That might explain some of the input volume surprises.

### Calibration sounds

Play a calibration sound when recording starts, and another when it stops.
It doubles as confirmation that the Record or Stop button worked.

- Schedule it on the audio clock (`oscillator.start(when)`, or an `AudioBufferSourceNode`), so we know exactly when it left.
  `audioContext.outputLatency` says how long it takes to reach the speakers.
- Find it in the recording.  The difference is the whole round trip, output plus input, measured instead of guessed.
  Using two of them, at the start and at the end, also measures any drift across the take.
- Use a short chirp (a quick sweep, maybe 0.2 s), not a plain beep.  Cross-correlation can find a chirp to well under a ms, while a beep's start is fuzzy.
  It should be loud enough to find easily, but not unpleasant.
- It only works through speakers.  With headphones the mic won't hear it, so fall back to the key clicks.
  Say so on the screen if the sound isn't found.
- Record the start sound and end the take after the stop sound, so both are inside the file.

### Volume meter

Show a live input level meter, so a surprise change in the Mac's input volume is obvious before it ruins a take.
Show it as soon as the mic is on, before recording starts, so you can check your level first.

- Compute it in the AudioWorklet that's already copying the samples:  RMS and peak for each block, in dBFS.
- A bar with a short peak hold, and a clip warning (red) near 0 dBFS.
- Two markers on the scale:  the target level for your voice, and the expected level of the calibration sound.
  Start with the usual speech target (peaks around −12 dBFS), then switch to "whatever your last good take was," since consistency matters more than any particular number.
  The calibration sound's level depends on the speaker volume, so its marker is "what we measured last time," and the meter can warn if it's way off.
- Log the levels in the sample lines too.  Then a quiet stretch in a take can be explained later.

Keep the recording raw.
Cuts happen later and nondestructively, applied to the audio and the log together, as described above.

### Markers and directions

- A hotkey to drop a marker.  Maybe two:  "that was good" and "that was a mistake, ignore the last few seconds."  It's cheap, and it saves a lot of guessing.
- Say "Claude, …" for directions that aren't meant for the final video.  The transcript makes those easy to find.

### Replay (later, but important)

A replay mode would drive the app from the log, setting the state from the samples on every frame.
Then I can screenshot any moment, with Playwright, to see what you saw, and put my rebuilt version next to yours.
Without replay I'd be reading numbers blind.
Replay should set the state from the samples, not rerun the demos:  a demo started during a take ran on the live clock, so rerunning it wouldn't land in exactly the same places.

### Open questions

- Where do the files go?  The voiceover lives in `public/` (the editor plays it from there), and the transcripts are in `properties/`.  Maybe audio goes in `public/` and the log in `properties/`.
- Should the narration's timing (`MOMENTS` and `lineTimes()` in `src/narration.ts`) read event times straight from the log?  It might save a step.

### A cheap first version

1. The event and sample log, plus markers.  This part really is easy.
2. Audio on the audio clock, with the calibration sounds and the volume meter.
3. Replay, once the first real take shows whether we need it.  I expect we will.

## The numbers

The floor for anything we care about is **100 ms**, the time it takes you to notice something.
The real use case is you saying "hey, what's that?", which is about 200 ms after the thing happened.
Everything below that line is only about making sure the machinery never adds an error you could notice.

"Measure" means it depends on this computer, so the first real take should measure it.
"Estimate" means a typical figure, not something I've checked here.

| Duration | What it is | Kind |
| ---: | --- | --- |
| 0.005–0.1 ms | Resolution of `performance.now()` and `event.timeStamp` in Chrome (0.1 ms normally, 5 µs on cross-origin-isolated pages) | Estimate |
| **0.021 ms** | **One audio sample** at 48 kHz.  The library builds its audio at 48 kHz, and Macs usually run their sound hardware at that rate too. | Definition |
| 0.02–0.1 ms | How precisely we can locate the calibration **chirp** in a recording, by cross-correlation (1 to 5 samples) | Estimate |
| 0.9 ms | Sound traveling 30 cm, from the speakers to the mic | Physics |
| 1–5 ms | How precisely we could locate a plain **beep**.  Its start is fuzzy, which is why we use a chirp. | Estimate |
| 1–10 ms | A key or trackpad press to its event time.  Input devices report on a schedule, often every 1–8 ms. | Estimate |
| 2.7 ms | One block of Web Audio processing (128 samples).  The audio clock and the volume meter advance in these steps. | Definition |
| 8.3 ms | One frame at 120 Hz, if the display is a ProMotion one | Definition |
| 10–20 ms | Mic and OS input buffering, before we see the sound.  Output to the speakers is probably similar. | Measure |
| **16.7 ms** | **One 60 fps frame:  the edge of what you can perceive.**  A one-frame flash is obvious. | Definition |
| 20–40 ms | **The round trip:**  the software starts a sound, and the software hears it come back.  It's the output delay, plus the trip through the air, plus the input delay.  The calibration chirps measure it. | Measure |
| 33.3 ms | One 30 fps frame.  Low-power mode drops to this, and you don't notice unless something flashes. | Definition |
| tens of ms | How far off `MediaRecorder`'s start can be.  That's why we don't use it. | Estimate |
| 45 ms | Audio *ahead* of the picture by more than this starts to be noticeable (ITU-R BT.1359, the broadcast lip-sync guideline) | Published |
| 50 ms | Time between samples in the log, at 20 per second | Our choice |
| 50–200 ms | How far off speech recognition's word times often are.  Probably our weakest link.  Check against the waveform. | Estimate |
| **100 ms** | **Noticing something.  Your floor.** | Your number |
| 125 ms | Audio *behind* the picture by more than this starts to be noticeable (same guideline).  We're more tolerant of late sound, as with thunder. | Published |
| 150–250 ms | One spoken syllable | Estimate |
| 200 ms | The calibration chirp itself | Our choice |
| **200 ms** | **Noticing plus reacting:**  "hey, what's that?" | Your number |
| **300–400 ms** | **One spoken word**, at a conversational 150–180 words per minute | Estimate |

**Clock speeds.**  Every clock runs a little fast or slow.  What matters is how fast two clocks drift apart:

| Clocks | Typical difference | Over 1 minute | Over a 10-minute take | Kind |
| --- | ---: | ---: | ---: | --- |
| Audio clock vs. `performance.now()` | 20–100 parts per million (crystal tolerances) | 1–6 ms | 12–60 ms | Measure |
| A video file's clock | Exact by definition:  frame *n* is at *n*/60 s | 0 | 0 | Definition |
| Screen refreshes vs. real time | 0 at a true 60 Hz.  0.1% at 59.94 Hz.  Variable on ProMotion displays, and 30 Hz in low-power mode. | up to 60 ms | up to 600 ms | Measure |

**What this says:**  after the calibration sounds, every timing error in the machinery is around 1 ms or less.
That's two orders of magnitude under your 100 ms floor, so for sync purposes it's done.
The weak links are human:  your reaction time, and the speech recognizer's word times.
The one trap is counting screen refreshes as a clock.  That can drift a lot over a long take, which is why the audio clock is the master.

## User Request

If we're going to control the noise cancellation, etc, please make those check boxes.
I'm not familiar with all of the choices.
We may eventually hide these, but I want to explore.

Can we change these settings after the recording has started?
It might make sense to turn the noise cancellation off completely for the calibration sounds, then turn it way up when I'm trying to use the keyboard or mouse or just accidentally touching my computer while talking.

I'm in a noisy environment.
There's often a train that blows its whistle just a block away from me.
I've noticed that the train is louder sometimes than others in my recordings.
I can only guess that various pieces of software are changing the settings on me and I haven't been paying enough attention.

### Claude's answer

**Checkboxes:  yes.**  One for each of these, all off by default:

- **Echo cancellation:**  for phone calls.  It removes whatever your own speakers are playing from the mic, so the other person doesn't hear themselves.  When nothing is playing it has nothing to do, and it would erase our calibration chirp.
- **Noise suppression:**  removes steady background noise, like fans, hum, and rumble, and some clicks.  At its worst it makes a voice sound a little watery.
- **Automatic gain control:**  keeps your voice at one loudness by turning the volume up and down for you.  It turns things *up* during your pauses, which is exactly when the train gets loud.  In Chrome it can also move the Mac's own input volume.  That's my best guess for the train sounding louder in some recordings than others.

Build the list from `navigator.mediaDevices.getSupportedConstraints()`, so it shows exactly what this browser offers.
Newer versions may add a "voice isolation" choice.
Next to each checkbox, show what the mic *actually* got, from `track.getSettings()`.
A browser can quietly ignore a request, and that's exactly the kind of surprise you've been running into.
Log the settings at the start of every take, and whenever they change.

**Changing them during a take:  yes, one way or another.**
The standard way is `track.applyConstraints(...)` on the live mic.
Chrome has had limits on changing these three while the mic is on, so it might need a fresh `getUserMedia` instead.
That's fine either way:  the recorder in the AudioWorklet keeps running on the audio clock, and we just plug the new mic into it.
At worst there's a gap of a few ms, logged as an event, and the clock never stops.
A five-minute test will tell us which way Chrome does it today.

**My recommendation, though:  record raw, and clean it up afterward.**
- The raw recording keeps the calibration chirps and the key clicks, which are what keep everything in sync.
- The browser's processing is built for live calls:  it can't wait, so it guesses.  An offline noise reducer can look ahead, so it does a better job.
- Cleaning up afterward is nondestructive, like your cuts.  It can use different settings for different stretches, it can be redone, and you can compare before and after.
  The train whistle in particular can be handled where it happens, by ducking or cutting just that stretch.
- So keep the checkboxes for exploring, but expect the best takes to come from all three off.

**Why you never hear echo or feedback:**  feedback needs a loop, where the mic is played back out of the speakers and picked up again.
A recording app doesn't play the mic back, so there's no loop, with or without noise reduction.
The calibration chirp is a single sound that goes out once and gets recorded once.  It isn't a loop either.

## Potential Reuse

I've wanted to add *integrated* recordings into the video editor for a while.
If we do it right, if we customize and perfect it for my needs, it will be better than any of the 3rd party tools I use now.

Whatever we create here might get copied into the video editor library and other places.
Let's try to keep the code and the GUI all in pieces that will be easy to copy, rather than letting it get mixed in the rest of the program.

In fact recording voiceovers might be the last major addition needed before the video editor could be 

Let's explore, let's try things (e.g. let the mac remove the echo vs do it in post processing), let's get this right as it is an important feature that will be used and reused.

## Initial Use Case

Ideally I'd be recording my first and final voiceover while I was running the demo.
And we are working in that general direction.
But the initial use case would be me trying things out and describing what I see and what I like and what I don't like.
This tool would help me give feedback on what's there before adding anything new, a step we always do but maybe next time it will be faster *and* more precise.
And I'll probably be sketching out very rough ideas of what I want, using my voice to record stage direction and commentary.

We can use these initial trials to check out the various settings, like echo reduction.
Eventually we will want to record the highest quality sounds.
But for now we are free to explore as long as the sound quality is *good enough*.