/** Minimal complex number helpers.  Plain objects, no classes, nothing clever. */
export type Complex = { readonly re: number; readonly im: number };

export function complex(re: number, im: number): Complex {
  return { re, im };
}

export function abs(z: Complex) {
  return Math.hypot(z.re, z.im);
}

export function arg(z: Complex) {
  return Math.atan2(z.im, z.re);
}

export function negate(z: Complex): Complex {
  return { re: -z.re, im: -z.im };
}

export function add(a: Complex, b: Complex): Complex {
  return { re: a.re + b.re, im: a.im + b.im };
}

export function subtract(a: Complex, b: Complex): Complex {
  return { re: a.re - b.re, im: a.im - b.im };
}

export function multiply(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

export function divide(a: Complex, b: Complex): Complex {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}

export function times(a: Complex, k: number): Complex {
  return { re: a.re * k, im: a.im * k };
}

/** Treat both numbers as 2d vectors and take the dot product. */
export function dot(a: Complex, b: Complex) {
  return a.re * b.re + a.im * b.im;
}

/** The principal square root, with the cut on the negative real axis. */
export function sqrtPrincipal(z: Complex): Complex {
  const r = abs(z);
  const re = Math.sqrt(Math.max(0, (r + z.re) / 2));
  const im = Math.sqrt(Math.max(0, (r - z.re) / 2));
  return { re, im: z.im < 0 ? -im : im };
}

/**
 * Analytic continuation, one small step at a time.
 * Returns whichever square root of z is closest to the previous answer.
 * This is valid as long as each step is small compared to the distance to the branch point.
 */
export function sqrtNear(z: Complex, previous: Complex): Complex {
  const w = sqrtPrincipal(z);
  return dot(w, previous) >= 0 ? w : negate(w);
}

/** The imaginary unit, as written in this program. */
export const I = "𝒾";

/** Like "3.00 − 1.25𝒾".  Uses a real minus sign. */
export function format(z: Complex, digits = 2) {
  const re = (z.re < 0 ? "−" : "") + Math.abs(z.re).toFixed(digits);
  const im = Math.abs(z.im).toFixed(digits) + I;
  return `${re} ${z.im < 0 ? "−" : "+"} ${im}`;
}
