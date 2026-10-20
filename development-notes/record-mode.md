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
