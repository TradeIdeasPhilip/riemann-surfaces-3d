import {
  abs,
  add,
  arg,
  complex,
  divide,
  dot,
  multiply,
  negate,
  sqrtNear,
  sqrtPrincipal,
  subtract,
  times,
  type Complex,
} from "./complex";
import { BLUE_COLOR, RED_COLOR, wrapAngle } from "./world";

/**
 * A multi-valued function.  √ and log have one branch point, at 0.  The cubic has three.
 *
 * w is always one particular value of the function, chosen by continuity.  Every body that walks
 * around (z, the floating camera) carries its own w.  That says where it is on the Riemann surface.
 */
export interface MultiFunction {
  readonly id: "sqrt" | "log" | "cubic";
  /** Over the robots' heads, and in the readout. */
  readonly name: string;
  /** For the button and the title. */
  readonly label: string;
  /** Each one gets a cloud, and a zone that z can't enter. */
  readonly branchPoints: readonly Complex[];
  /** Tells the shaders which function this is. */
  readonly shaderId: number;
  /** The 3D floor's height scale when the slider is all the way up.  0 means there's no 3D floor. */
  readonly maxLift: number;
  principal(z: Complex): Complex;
  /**
   * Analytic continuation:  the value at z, continued from previous.  Give `from`, where previous
   * belongs, to continue along the straight line from there.  Without it, this is the value closest to
   * previous, which only works for a small step.
   *
   * √ and log can do any straight line that doesn't pass through the branch point in one jump, so they
   * ignore `from`.
   */
  continueTo(z: Complex, previous: Complex, from?: Complex): Complex;
  /**
   * All of the outputs we draw.  w, z's own value, is outputs(w)[ownIndex].
   * previous is the last frame's outputs, so the cubic can keep its other two robots in order.
   */
  outputs(w: Complex, previous?: readonly Complex[]): Complex[];
  readonly ownIndex: number;
  /** The outputs' view zooms to fit these.  The others can be near the edges. */
  readonly framed: readonly number[];
  readonly outputColors: readonly number[];
  /**
   * The total angle that z has turned around the branch point to reach this value, counting full turns.
   * √: 2 arg w, so it's only meaningful mod 4π.  log: Im w.  The cubic doesn't use it.
   */
  total(w: Complex): number;
  /** total(to) - total(from), for two nearby values on the same sheet. */
  relative(from: Complex, to: Complex): number;
  /** How many sheets above b is a?  Both are values at the same z.  0 means the same sheet. */
  levels(a: Complex, b: Complex): number;
}

const ORIGIN = [complex(0, 0)];

export const SQUARE_ROOT: MultiFunction = {
  id: "sqrt",
  name: "√z",
  label: "√z",
  branchPoints: ORIGIN,
  shaderId: 0,
  // For √ this is the height of the other sheet, right above the camera's subject.
  maxLift: 10,
  principal: sqrtPrincipal,
  continueTo: sqrtNear,
  outputs: (w) => [w, negate(w)],
  ownIndex: 0,
  framed: [0, 1],
  outputColors: [RED_COLOR, BLUE_COLOR],
  total: (w) => 2 * arg(w),
  relative: (from, to) => 2 * wrapAngle(arg(to) - arg(from)),
  // There are only two sheets, so "the other one" is 1.
  levels: (a, b) => (dot(a, b) >= 0 ? 0 : 1),
};

function logPrincipal(z: Complex): Complex {
  return { re: Math.log(abs(z)), im: arg(z) };
}

const TAU = Math.PI * 2;

/** log has infinitely many values.  We draw this many above and below z's own value. */
const LOG_NEIGHBORS = 2;

export const LOGARITHM: MultiFunction = {
  id: "log",
  name: "log z",
  label: "log z",
  branchPoints: ORIGIN,
  shaderId: 1,
  maxLift: 1.5,
  principal: logPrincipal,
  continueTo(z, previous) {
    const p = logPrincipal(z);
    return { re: p.re, im: previous.im + wrapAngle(p.im - previous.im) };
  },
  outputs(w) {
    const result: Complex[] = [];
    for (let k = LOG_NEIGHBORS; k >= -LOG_NEIGHBORS; k--) {
      result.push({ re: w.re, im: w.im + TAU * k });
    }
    return result;
  },
  ownIndex: LOG_NEIGHBORS,
  // Fitting all five makes them too small.  Fit z's own value and one on each side.
  framed: [LOG_NEIGHBORS - 1, LOG_NEIGHBORS, LOG_NEIGHBORS + 1],
  // From the top down:  2π𝒾 above z's own value, then 1 above, z's own (red, like √), 1 below, 2 below.
  outputColors: [0xf2e14c, 0xffa53d, RED_COLOR, BLUE_COLOR, 0xa47bff],
  total: (w) => w.im,
  relative: (from, to) => to.im - from.im,
  levels: (a, b) => Math.round((a.im - b.im) / TAU),
};

//
// The cubic, w³ − zw − 2 = 0.  The professor's polynomial, from the 2D version.
//
// Each z has three values of w.  Two of them come together at each branch point, 3, 3ω, and 3ω², where
// ω = e^(2π𝒾/3).  There the double root is w = −3/z and the other one is 6/z.  Solving for z gives
// z = w² − 2/w, so the Riemann surface is the w plane itself.
//
// There's no formula for "the right root", so this keeps every value by continuation, one small step
// at a time.  The shaders do exactly the same thing.  See cubicGlsl in world.ts.
//

const ROOT3 = Math.sqrt(3);
export const CUBIC_BRANCH_POINTS = [complex(3, 0), complex(-1.5, 1.5 * ROOT3), complex(-1.5, -1.5 * ROOT3)];

/** At z = 0 the values are the cube roots of 2.  This one is real. */
const CUBIC_START = complex(Math.cbrt(2), 0);

/** One step of Newton's method toward a root of w³ − zw − 2. */
function cubicNewton(w: Complex, z: Complex): Complex {
  const w2 = multiply(w, w);
  const f = subtract(subtract(multiply(w2, w), multiply(z, w)), complex(2, 0));
  const slope = subtract(times(w2, 3), z);
  return subtract(w, divide(f, slope));
}

/**
 * The other two values, given one of them.  Dividing w³ − zw − 2 by (x − w) leaves x² + wx + 2/w.
 */
function otherRoots(w: Complex): [Complex, Complex] {
  const d = sqrtPrincipal(subtract(multiply(w, w), divide(complex(8, 0), w)));
  const minusHalf = times(w, -0.5);
  return [add(minusHalf, times(d, 0.5)), subtract(minusHalf, times(d, 0.5))];
}

/** The value at z closest to guess.  Polishes guess with Newton's method, then checks the others. */
function closestRoot(z: Complex, guess: Complex): Complex {
  let w = guess;
  for (let i = 0; i < 60; i++) {
    const next = cubicNewton(w, z);
    const done = abs(subtract(next, w)) <= 1e-14 * (1 + abs(next));
    w = next;
    if (done) {
      break;
    }
  }
  let best = w;
  for (const other of otherRoots(w)) {
    if (abs(subtract(other, guess)) < abs(subtract(best, guess))) {
      best = other;
    }
  }
  return best;
}

function cubicBranchDistance(z: Complex) {
  return Math.min(...CUBIC_BRANCH_POINTS.map((b) => abs(subtract(z, b))));
}

/**
 * Continue w along the straight line from `from` to `to`.  The steps are small compared to the distance
 * to the nearest branch point, which is what it takes to never jump to the wrong root.
 */
function continueCubic(to: Complex, previous: Complex, from?: Complex): Complex {
  if (!from) {
    return closestRoot(to, previous);
  }
  const length = abs(subtract(to, from));
  const direction = length > 0 ? times(subtract(to, from), 1 / length) : complex(0, 0);
  let z = from;
  let w = previous;
  let travelled = 0;
  for (let i = 0; i < 2000 && travelled < length; i++) {
    travelled = Math.min(length, travelled + Math.max(0.3 * cubicBranchDistance(z), 1e-9));
    const next = add(from, times(direction, travelled));
    // Predict with the slope, dw/dz = w / (3w² − z).  Then correct with Newton's method.
    w = add(w, divide(multiply(w, subtract(next, z)), subtract(times(multiply(w, w), 3), z)));
    z = next;
    w = cubicNewton(cubicNewton(w, z), z);
  }
  return closestRoot(to, w);
}

/** Yellow, like log's top robot.  Red and blue are the same as √. */
export const CUBIC_THIRD_COLOR = 0xf2e14c;

export const CUBIC: MultiFunction = {
  id: "cubic",
  name: "w",
  label: "w³ − zw − 2 = 0",
  branchPoints: CUBIC_BRANCH_POINTS,
  shaderId: 2,
  // Flat for now.
  maxLift: 0,
  // Start at z = 0 on the real cube root of 2, and follow the straight line out.
  principal: (z) => continueCubic(z, CUBIC_START, complex(0, 0)),
  continueTo: continueCubic,
  outputs(w, previous) {
    let [a, b] = otherRoots(w);
    if (previous?.length == 3) {
      // Keep each robot on its own value:  whichever order moves them the least.
      const d = (x: Complex, y: Complex) => abs(subtract(x, y)) ** 2;
      if (d(a, previous[1]) + d(b, previous[2]) > d(b, previous[1]) + d(a, previous[2])) {
        [a, b] = [b, a];
      }
    } else {
      // A fresh start:  counterclockwise from z's own value, blue comes first, then yellow.
      const turn = (x: Complex) => (arg(x) - arg(w) + 2 * TAU) % TAU;
      if (turn(a) > turn(b)) {
        [a, b] = [b, a];
      }
    }
    return [w, a, b];
  },
  ownIndex: 0,
  framed: [0, 1, 2],
  outputColors: [RED_COLOR, BLUE_COLOR, CUBIC_THIRD_COLOR],
  total: (w) => arg(w),
  relative: (from, to) => wrapAngle(arg(to) - arg(from)),
  // Three sheets, but no order to them.  0 is the same sheet, 1 is either of the others.
  levels(a, b) {
    const separation = Math.min(...otherRoots(b).map((other) => abs(subtract(other, b))));
    return abs(subtract(a, b)) < separation / 2 ? 0 : 1;
  },
};

/** The two values that meet at branch point b, and the one that doesn't.  See the comment above CUBIC. */
export function cubicValuesAt(b: Complex) {
  return { double: divide(complex(-3, 0), b), single: divide(complex(6, 0), b) };
}
