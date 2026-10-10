import {
  abs,
  arg,
  dot,
  negate,
  sqrtNear,
  sqrtPrincipal,
  type Complex,
} from "./complex";
import { BLUE_COLOR, RED_COLOR, wrapAngle } from "./world";

/**
 * A multi-valued function with one branch point, at 0.
 *
 * w is always one particular value of the function, chosen by continuity.  Every body that walks
 * around (z, the floating camera) carries its own w.  That says where it is on the Riemann surface.
 */
export interface MultiFunction {
  readonly id: "sqrt" | "log";
  /** For the user interface and over the robots' heads. */
  readonly name: string;
  /** Tells the shaders which function this is. */
  readonly shaderId: number;
  /** The 3D floor's height scale when the slider is all the way up.  See floorUniforms. */
  readonly maxLift: number;
  principal(z: Complex): Complex;
  /**
   * The value at z closest to previous.  This is analytic continuation, if z is a small step away,
   * or at the end of a straight line that doesn't pass through the branch point.
   */
  continueTo(z: Complex, previous: Complex): Complex;
  /** All of the outputs we draw.  w, z's own value, is outputs(w)[ownIndex]. */
  outputs(w: Complex): Complex[];
  readonly ownIndex: number;
  readonly outputColors: readonly number[];
  /**
   * The total angle that z has turned around the branch point to reach this value, counting full turns.
   * √: 2 arg w, so it's only meaningful mod 4π.  log: Im w.
   */
  total(w: Complex): number;
  /** total(to) - total(from), for two nearby values on the same sheet. */
  relative(from: Complex, to: Complex): number;
  /** How many sheets above b is a?  Both are values at the same z.  0 means the same sheet. */
  levels(a: Complex, b: Complex): number;
}

export const SQUARE_ROOT: MultiFunction = {
  id: "sqrt",
  name: "√z",
  shaderId: 0,
  maxLift: 1.2,
  principal: sqrtPrincipal,
  continueTo: sqrtNear,
  outputs: (w) => [w, negate(w)],
  ownIndex: 0,
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
  // From the top down:  2π𝒾 above z's own value, then 1 above, z's own (red, like √), 1 below, 2 below.
  outputColors: [0xf2e14c, 0xffa53d, RED_COLOR, BLUE_COLOR, 0xa47bff],
  total: (w) => w.im,
  relative: (from, to) => to.im - from.im,
  levels: (a, b) => Math.round((a.im - b.im) / TAU),
};
