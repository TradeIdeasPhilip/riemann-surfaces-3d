/*
 * The script for the narrated demo, from full_script.md, one entry per spoken line.
 *
 * Every move in the narrated demo is pinned to these lines, like "z bumps into the rope at the start
 * of 'Whoops'".  So to change the timing, change when the lines are spoken.  The animation follows.
 *
 * Before there's a recording, each line's timing is estimated from its word count.
 * After recording, fill in RECORDED with when each line actually starts (and optionally ends) in the
 * voiceover, in seconds from the start of the recording.  Any line you leave out is estimated from
 * the line before it.
 */

export type Line = {
  /** A short name, so the animation can say "at the start of this line." */
  readonly id: string;
  readonly text: string;
  /** Extra silence after this line, in seconds, before the next one starts.  Only for estimates. */
  readonly pauseAfter?: number;
};

export const SCRIPT: readonly Line[] = [
  { id: "left", text: "On the left you see your input, z, currently standing on the complex plane at z = −4𝒾." },
  { id: "right", text: "On the right you see both answers, they are both equally valid.", pauseAfter: 0.5 },
  { id: "walk", text: "What happens if z walks toward 0?", pauseAfter: 0.5 },
  { id: "smallChanges", text: "As z makes small changes, both of the outputs also make small changes." },
  { id: "calculus", text: "That's fundamental to calculus." },
  { id: "smooth", text: "We only work with functions that are smooth." },
  { id: "noSwitch", text: "The red robot and the blue robot are not suddenly going to switch places." },
  { id: "stillCorrect", text: "Those would still be two correct answers." },
  { id: "cantJump", text: "But the answers can't jump like that." },
  { id: "history", text: "So it's not just about knowing an answer, it involves history.", pauseAfter: 0.8 },
  { id: "whoops", text: "Whoops, I can't go any further." },
  { id: "whatsGoingOn", text: "What's going on?", pauseAfter: 0.5 },
  { id: "branchPoint", text: "This is called a branch point." },
  { id: "touch", text: "If z was allowed to touch that point, the two solutions would touch." },
  { id: "whichIsWhich", text: "Then we don't know which solution is which any more.", pauseAfter: 0.5 },
  { id: "zoomIn", text: "Let me zoom in a little." },
  { id: "onlyZero", text: "Really, the only bad point is at 0." },
  { id: "furtherIn", text: "As I zoom further and further in that safety rope will let me get closer." },
  { id: "notAllowed", text: "But I am not allowed to actually get to 0.", pauseAfter: 0.8 },
  { id: "important", text: "Now the important part:" },
  { id: "circle", text: "What happens if I take z in a circle around this branch point?" },
  {
    id: "halfWay",
    text: "The interesting thing about square root is that when the input goes around the origin once, each solution only rotates half way around the origin.",
  },
  { id: "thinkAbout", text: "Think about what that means." },
  {
    id: "sameValues",
    text: "If you only care about the square root of one specific value of z, nothing changed, we keep returning to the same two values for √z.",
    pauseAfter: 1.5,
  },
  { id: "continuous", text: "But, in calculus we care what happens when you make small continuous changes." },
  {
    id: "trackColors",
    text: "That's why it's important to track the colors and the paths, they are a collection of these small changes.",
  },
  { id: "swap", text: "And mathematicians want to know when the two solutions swap." },
  { id: "keepTrack", text: "How do we keep track of that?", pauseAfter: 0.8 },
  { id: "upDown", text: "Did you notice how our input has been moving up and down?" },
  { id: "twoPieces", text: "We now have two pieces of information." },
  { id: "position", text: "Our 2D position is all you need for the current z." },
  { id: "height", text: "And our height tells you how many times we've circled around the branch point.", pauseAfter: 0.8 },
  {
    id: "notReally",
    text: "That sounds simple until you notice that the input isn't really sitting on the “top” surface or the “bottom” surface.",
  },
  { id: "illusion", text: "That's just an illusion." },
  {
    id: "identical",
    text: "The two surfaces are identical, there is no obvious top or bottom, and there is no point in time when you switch between surfaces.",
  },
  // A pause while that sinks in.
  { id: "oneSurface", text: "Really there's just one continuous surface.", pauseAfter: 3 },
  { id: "another", text: "Are you ready for another function?", pauseAfter: 0.6 },
  { id: "logSurface", text: "Look at the surface required for the log of z." },
  { id: "garage", text: "It's like a parking garage." },
  { id: "everyTime", text: "Every time around the solutions switch places." },
  { id: "infinite", text: "But now we have an infinite number of solutions!", pauseAfter: 1.5 },
  { id: "highlights", text: "These were just a few highlights." },
  { id: "interactive", text: "You can click a link in the description for an interactive version of this demonstration.", pauseAfter: 0.5 },
  { id: "beforeAI", text: "Wanna know how we did math before AI and robots?" },
  { id: "gradSchool", text: "Click the link on the screen to see how I solved the same problem back in grad school." },
];

/** For estimates.  About 156 words per minute. */
const WORDS_PER_SECOND = 2.6;
/** For estimates.  Silence between lines, in seconds. */
const GAP = 0.35;
/** For estimates.  Silence before the first line. */
const LEAD_IN = 0.8;

/**
 * After recording the voiceover:  when each line starts, and optionally ends, in seconds from the
 * start of the recording.  For example `whoops: { start: 41.2, end: 43.0 }`.
 */
export const RECORDED: Partial<Record<string, { start: number; end?: number }>> = {};

export type Timing = { readonly line: Line; readonly start: number; readonly end: number };

function spokenSeconds(text: string) {
  const words = text.split(/\s+/).filter((word) => word.length > 0).length;
  return words / WORDS_PER_SECOND;
}

/** When each line starts and ends, in seconds from the start of the demo. */
export function lineTimes(): Map<string, Timing> {
  const result = new Map<string, Timing>();
  let next = LEAD_IN;
  SCRIPT.forEach((line, index) => {
    const recorded = RECORDED[line.id];
    const start = recorded?.start ?? next;
    let end = recorded?.end ?? start + spokenSeconds(line.text);
    // An estimated end can't run into the next line's recorded start.
    const following = SCRIPT[index + 1];
    const followingStart = following && RECORDED[following.id]?.start;
    if (recorded?.end === undefined && followingStart !== undefined) {
      end = Math.min(end, followingStart - GAP / 2);
    }
    result.set(line.id, { line, start, end });
    next = end + GAP + (line.pauseAfter ?? 0);
  });
  return result;
}
