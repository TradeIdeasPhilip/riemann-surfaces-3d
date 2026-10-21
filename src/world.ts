import * as THREE from "three";
import type { Complex } from "./complex";

/*
 * Two coordinate systems:
 *
 * "math" coordinates are the complex plane.
 * "world" coordinates are three.js units, Y is up, the floor is y = 0
 * (unless the 3D floor is turned on, see floorHeight()).
 *
 * The branch point (0) is always at the world origin.
 * Re is world +x.  Im is world -z (straight ahead when you start).
 * view.scale is world units per math unit.  Zooming changes view.scale and nothing else.
 *
 * Characters, the cloud, the cones, and the camera's distance from its subject
 * all have fixed sizes in world units.  So zooming in shrinks the forbidden
 * zone in math units, exposing more of the plane.
 */

/** Radius of the magic cloud around the branch point. */
export const CLOUD_RADIUS = 2.2;
/** The cones and caution tape. */
export const TAPE_RADIUS = 3.0;
/** z and the floating camera can't get closer than this to the branch point. */
export const BLOCK_RADIUS = 3.6;
/** The actual camera can't get closer than this.  It gets pulled in toward its subject instead. */
export const CAMERA_BLOCK_RADIUS = 3.3;

export const CHARACTER_HEIGHT = 1.7;

export const Z_COLOR = 0x3ddc84;
export const RED_COLOR = 0xff5a5f;
export const BLUE_COLOR = 0x4ea8ff;
export const SKY_COLOR = 0x121829;
export const FOG_DENSITY = 0.0065;

/**
 * How a complex plane maps onto a floor.  world = (math - center) × scale, with Im pointing toward -z.
 * The input's world always has its center at the branch point, 0.  The outputs' world moves its center
 * to keep the outputs in view.
 */
export type Space = {
  /** World units per math unit. */
  scale: number;
  center: Complex;
};

/** The input's world, where z walks. */
export const view: Space = {
  scale: 5,
  center: { re: 0, im: 0 },
};

/** Your 9 rainbow colors.  From canvas-recorder/src/glib/my-rainbow.ts. */
export const MY_RAINBOW = [
  0xff0000, // red
  0xff8000, // orange
  0xd8d800, // yellow
  0x00ee00, // green
  0x00d8d8, // cyan
  0x0080ff, // myBlue
  0x2040ff, // cssBlue
  0x8000ff, // violet
  0xff00ff, // magenta
];

/**
 * Everything about the floor is measured by angles around the branch point.  φ is a point's angle
 * measured from the camera's direction, between -π and π.  The cut is where φ jumps, directly behind
 * the branch point.  The "total angle" counts full turns too:  on the camera's sheet it's
 * uCameraTotal + φ.  It picks the colors.
 *
 * The 3D floor is the Riemann surface itself, embedded in 3D.  "level" is which sheet:  0 is the
 * camera's sheet, the opaque floor.  The others are drawn see-through.
 *   √:   Two sheets.  The camera's sheet is a valley, level under the camera's subject, rising on both
 *        sides toward the cut.  The other sheet is a ceiling, coming down on both sides.  They meet at
 *        half height, at the cut.  That's where the two sheets cross, and it's always hidden behind
 *        the cloud, so everything you can see is embedded in 3D without crossing itself.
 *   log: A spiral ramp, like a parking garage.  Each level is one full turn higher.
 *   The cubic:  Three sheets, stacked.  The camera's is the floor, and the other two are one and two
 *        levels up.  Each branch point glues two of them together, so near each one, those two lean
 *        toward each other and meet behind its cloud, like the two sheets of √.  See cubicGlsl.
 *
 * floorUniforms are shared by every shader that draws on the input's floor, and by floorHeight().
 */
export function makeFloorUniforms() {
  return {
    /** 0 for √, 1 for log, 2 for the cubic.  See MultiFunction.shaderId. */
    uFunction: { value: 0 },
    /** 0 for a flat floor.  Bigger is taller. */
    uLift: { value: 0 },
    /** The angle of the camera, as seen from the branch point.  The cut is directly opposite. */
    uCameraAngle: { value: 0 },
    /** The total angle of the camera's own value.  This picks the colors. */
    uCameraTotal: { value: 0 },
    /** The camera's total angle minus its subject's.  Always between -π and π. */
    uRelAngle: { value: 0 },
    /** The cubic:  where the camera is, in math coordinates, and its value there.  See cubicGlsl. */
    uCameraZ: { value: new THREE.Vector2() },
    uCameraW: { value: new THREE.Vector2() },
    /** The cubic:  the value at the camera for the sheet one level up.  Two levels up is −uCameraW − uCameraW1. */
    uCameraW1: { value: new THREE.Vector2() },
    /** Where the camera is, in world coordinates (x, z). */
    uCameraXZ: { value: new THREE.Vector2() },
    /**
     * The cubic, for each branch point:  how much it pulls levels 0 and 1 together, and levels 1 and 2.
     * 1 if it glues those two levels, 0 if it doesn't, and in between while it fades.  See cubicHeight.
     */
    uPinch01: { value: [0, 0, 0] },
    uPinch12: { value: [0, 0, 0] },
    /** The cubic:  the angle of the camera's subject around each branch point, measured from the camera. */
    uSubjectPhi: { value: [0, 0, 0] },
    /** Where the branch points are, in world coordinates (x, z).  The first uBranchCount are used. */
    uBranches: { value: [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()] },
    uBranchCount: { value: 1 },
  };
}
export type FloorUniforms = ReturnType<typeof makeFloorUniforms>;
export const floorUniforms = makeFloorUniforms();

/** The angle of this point around the branch point, measured from the camera's direction, -π to π. */
export function cameraRelativeAngle(x: number, worldZ: number) {
  return wrapAngle(Math.atan2(-worldZ, x) - floorUniforms.uCameraAngle.value);
}

/**
 * Height of the floor at this point, in world units.  This matches floorHeightAt() in the shaders.
 * level 0 is the camera's sheet.
 */
export function floorHeight(x: number, worldZ: number, level = 0) {
  const u = floorUniforms;
  const lift = u.uLift.value;
  if (lift == 0) {
    return 0;
  }
  if (u.uFunction.value == 2) {
    return cubicHeight(x, worldZ, level);
  }
  const phi = cameraRelativeAngle(x, worldZ);
  if (u.uFunction.value == 0) {
    // The camera's subject is at the bottom of the valley.
    const subject = -u.uRelAngle.value;
    const s = phi >= subject ? (phi - subject) / (Math.PI - subject) : (subject - phi) / (Math.PI + subject);
    const rise = 0.5 * lift * s * s;
    return level == 0 ? rise : lift - rise;
  } else {
    return lift * (phi + u.uRelAngle.value + 2 * Math.PI * level);
  }
}

/**
 * How wide the crease behind each of the cubic's branch points is, in world units.  Far from the branch
 * points, the three sheets are flat and stay apart, except in a strip about this wide behind each cloud.
 */
export const CUBIC_CREASE_WIDTH = 9;

/**
 * The cubic:  how far branch point i has pulled its two sheets together at this point.  0 under the
 * camera's subject, rising to 1 on the cut directly behind the branch point, like the valley of √.
 * Unlike √, it fades away from the line through the camera and the branch point, so far away it's
 * only a crease.  It's still exactly 1 everywhere on the cut.  This matches cubicRise() in cubicGlsl.
 */
function cubicRise(x: number, worldZ: number, i: number) {
  const u = floorUniforms;
  const b = u.uBranches.value[i];
  const c = u.uCameraXZ.value;
  const phi = angleAround(b.x, b.y, c.x, c.y, x, worldZ);
  const subject = u.uSubjectPhi.value[i];
  const s = phi >= subject ? (phi - subject) / (Math.PI - subject) : (subject - phi) / (Math.PI + subject);
  // Distance from the line through the camera and the branch point.
  const lineX = b.x - c.x;
  const lineZ = b.y - c.y;
  const away = Math.abs(lineX * (worldZ - c.y) - lineZ * (x - c.x)) / Math.hypot(lineX, lineZ) / CUBIC_CREASE_WIDTH;
  return s * s * Math.exp(-away * away);
}

/**
 * The angle at (bx, bz), from the direction of (cx, cz) to the direction of (x, z).  -π to π.
 * All in world coordinates.  This matches angleAround() in cubicGlsl.
 */
export function angleAround(bx: number, bz: number, cx: number, cz: number, x: number, z: number) {
  const ax = cx - bx;
  const az = cz - bz;
  const px = x - bx;
  const pz = z - bz;
  return Math.atan2(ax * pz - az * px, ax * px + az * pz);
}

/**
 * The cubic's 3D floor.  Level 0 (the camera's sheet) starts at 0, level 1 is always at uLift, and level
 * 2 starts at twice that.  gap01 and gap12 are the spaces between them, as a fraction of uLift.
 * Each branch point closes the gaps between the sheets it glues, all the way to 0 on its cut.  Gluing
 * levels 0 and 2 closes both gaps, so level 1 goes through that crossing too.  Multiplying the
 * factors means each cut closes its gaps exactly, wherever it is, no matter what the others are doing.
 * This matches cubicHeight() in cubicGlsl.
 */
function cubicHeight(x: number, worldZ: number, level: number) {
  const u = floorUniforms;
  let gap01 = 1;
  let gap12 = 1;
  for (let i = 0; i < 3; i++) {
    const rise = cubicRise(x, worldZ, i);
    gap01 *= 1 - u.uPinch01.value[i] * rise;
    gap12 *= 1 - u.uPinch12.value[i] * rise;
  }
  const lift = u.uLift.value;
  return level == 0 ? lift * (1 - gap01) : level == 1 ? lift : lift * (1 + gap12);
}

/** The floor's surface normal, for tilting shadows. */
export function floorNormal(x: number, worldZ: number, level = 0, target = new THREE.Vector3()) {
  const e = 0.05;
  const dx = (floorHeight(x + e, worldZ, level) - floorHeight(x - e, worldZ, level)) / (2 * e);
  const dz = (floorHeight(x, worldZ + e, level) - floorHeight(x, worldZ - e, level)) / (2 * e);
  return target.set(-dx, 1, -dz).normalize();
}

/**
 * GLSL for the cubic, w³ − zw − 2 = 0.  The same continuation as continueCubic() in functions.ts:  start
 * at the camera with the camera's value, and walk the straight line to p in steps that are small
 * compared to the distance to the nearest branch point.  That's the camera's sheet.  The line only
 * jumps sheets when it passes through a branch point, so the cuts are the rays directly behind the
 * branch points, hidden by the clouds.
 */
const cubicGlsl = /* glsl */ `
uniform vec2 uCameraZ;
uniform vec2 uCameraW;
uniform vec2 uCameraW1;
uniform vec2 uCameraXZ;
uniform vec2 uBranches[3];
uniform float uBranchCount;
uniform float uPinch01[3];
uniform float uPinch12[3];
uniform float uSubjectPhi[3];
vec2 cmul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}
vec2 cdiv(vec2 a, vec2 b) {
  return vec2(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / dot(b, b);
}
float cubicBranchDistance(vec2 z) {
  return min(distance(z, vec2(3.0, 0.0)),
    min(distance(z, vec2(-1.5, 2.598076211)), distance(z, vec2(-1.5, -2.598076211))));
}
vec2 cubicNewton(vec2 w, vec2 z) {
  vec2 w2 = cmul(w, w);
  return w - cdiv(cmul(w2, w) - cmul(z, w) - vec2(2.0, 0.0), 3.0 * w2 - z);
}
/** The value of w at p, in math coordinates, on the camera's sheet. */
vec2 cubicCameraSheet(vec2 p) {
  vec2 z = uCameraZ;
  vec2 w = uCameraW;
  float span = distance(p, z);
  vec2 direction = span > 0.0 ? (p - z) / span : vec2(0.0);
  float travelled = 0.0;
  // Far away, or right behind a branch point, it might give up early.  That's hidden by the fog or a cloud.
  for (int i = 0; i < 96; i++) {
    if (travelled >= span) {
      break;
    }
    travelled = min(span, travelled + max(0.3 * cubicBranchDistance(z), 1e-5));
    vec2 next = uCameraZ + direction * travelled;
    // Predict with the slope, dw/dz = w / (3w² − z).  Then correct with Newton's method.
    w += cdiv(cmul(w, next - z), 3.0 * cmul(w, w) - z);
    z = next;
    w = cubicNewton(w, z);
  }
  return cubicNewton(cubicNewton(w, z), z);
}
/**
 * The values on levels 0 and 1 at p, continued from the camera together, in the same steps.
 * Level 2 is −w0 − w1:  the three values always add up to 0.
 */
void cubicSheets(vec2 p, out vec2 w0, out vec2 w1) {
  vec2 z = uCameraZ;
  w0 = uCameraW;
  w1 = uCameraW1;
  float span = distance(p, z);
  vec2 direction = span > 0.0 ? (p - z) / span : vec2(0.0);
  float travelled = 0.0;
  for (int i = 0; i < 96; i++) {
    if (travelled >= span) {
      break;
    }
    travelled = min(span, travelled + max(0.3 * cubicBranchDistance(z), 1e-5));
    vec2 next = uCameraZ + direction * travelled;
    w0 += cdiv(cmul(w0, next - z), 3.0 * cmul(w0, w0) - z);
    w1 += cdiv(cmul(w1, next - z), 3.0 * cmul(w1, w1) - z);
    z = next;
    w0 = cubicNewton(w0, z);
    w1 = cubicNewton(w1, z);
  }
  w0 = cubicNewton(cubicNewton(w0, z), z);
  w1 = cubicNewton(cubicNewton(w1, z), z);
}
/** The value on this level at p.  See cubicSheets(). */
vec2 cubicLevelValue(vec2 p, float level) {
  if (level < 0.5) {
    return cubicCameraSheet(p);
  }
  vec2 w0;
  vec2 w1;
  cubicSheets(p, w0, w1);
  return level < 1.5 ? w1 : -w0 - w1;
}
/** See angleAround() in world.ts. */
float angleAround(vec2 b, vec2 c, vec2 p) {
  vec2 a = c - b;
  vec2 q = p - b;
  return atan(a.x * q.y - a.y * q.x, a.x * q.x + a.y * q.y);
}
/** See cubicRise() in world.ts. */
float cubicRise(vec2 worldXZ, int i) {
  vec2 b = uBranches[i];
  float phi = angleAround(b, uCameraXZ, worldXZ);
  float subject = uSubjectPhi[i];
  float s = phi >= subject ? (phi - subject) / (F_PI - subject) : (subject - phi) / (F_PI + subject);
  vec2 line = b - uCameraXZ;
  vec2 q = worldXZ - uCameraXZ;
  float away = abs(line.x * q.y - line.y * q.x) / length(line) / ${CUBIC_CREASE_WIDTH.toFixed(1)};
  return s * s * exp(-away * away);
}
/** See cubicHeight() in world.ts. */
float cubicHeight(vec2 worldXZ, float level) {
  float gap01 = 1.0;
  float gap12 = 1.0;
  for (int i = 0; i < 3; i++) {
    float rise = cubicRise(worldXZ, i);
    gap01 *= 1.0 - uPinch01[i] * rise;
    gap12 *= 1.0 - uPinch12[i] * rise;
  }
  return level < 0.5 ? uLift * (1.0 - gap01) : level < 1.5 ? uLift : uLift * (1.0 + gap12);
}
/** Distance from worldXZ to the nearest branch point, in world units. */
float branchDistanceWorld(vec2 worldXZ) {
  float d = 1e9;
  for (int i = 0; i < 3; i++) {
    if (float(i) < uBranchCount) {
      d = min(d, distance(worldXZ, uBranches[i]));
    }
  }
  return d;
}
`;

/** GLSL to match floorHeight() and cameraRelativeAngle().  Uses the uniforms in floorUniforms. */
export const floorHeightGlsl = /* glsl */ `
uniform float uFunction;
uniform float uLift;
uniform float uCameraAngle;
uniform float uCameraTotal;
uniform float uRelAngle;
const float F_PI = 3.14159265358979;
const float F_TAU = 6.28318530717959;
float wrapAngle(float a) {
  return mod(a + F_PI, F_TAU) - F_PI;
}
float cameraRelativeAngle(vec2 worldXZ) {
  return wrapAngle(atan(-worldXZ.y, worldXZ.x) - uCameraAngle);
}
${cubicGlsl}
/**
 * phi is measured from the camera's direction, around the branch point at the origin.  level 0 is the
 * camera's sheet.  √ and log only.  See floorHeightAtXZ().
 */
float floorHeightAt(float phi, float level) {
  if (uFunction < 0.5) {
    // The camera's subject is at the bottom of the valley.
    float subject = -uRelAngle;
    float s = phi >= subject ? (phi - subject) / (F_PI - subject) : (subject - phi) / (F_PI + subject);
    float rise = 0.5 * uLift * s * s;
    return level < 0.5 ? rise : uLift - rise;
  }
  return uLift * (phi + uRelAngle + F_TAU * level);
}
/** The height of this level at this point, for any function.  phi is cameraRelativeAngle(worldXZ). */
float floorHeightAtXZ(vec2 worldXZ, float phi, float level) {
  if (uLift == 0.0) {
    return 0.0;
  }
  return uFunction > 1.5 ? cubicHeight(worldXZ, level) : floorHeightAt(phi, level);
}
float floorHeight(vec2 worldXZ) {
  return floorHeightAtXZ(worldXZ, cameraRelativeAngle(worldXZ), 0.0);
}
`;

export function toWorld(z: Complex, y = 0, target = new THREE.Vector3()) {
  return toWorldIn(view, z, y, target);
}

export function toWorldIn(space: Space, z: Complex, y = 0, target = new THREE.Vector3()) {
  return target.set(
    (z.re - space.center.re) * space.scale,
    y,
    -(z.im - space.center.im) * space.scale
  );
}

export function toMath(x: number, worldZ: number): Complex {
  return { re: x / view.scale, im: -worldZ / view.scale };
}

/**
 * Grid spacing in math units.  Major lines are 1, 2, or 5 times a power of 10,
 * chosen so the major squares are at least a few world units across.
 */
export function gridSpacing(scale: number) {
  const raw = 4 / scale;
  const base = Math.pow(10, Math.floor(Math.log10(raw)));
  let mantissa = 10;
  for (const m of [1, 2, 5]) {
    if (m * base >= raw) {
      mantissa = m;
      break;
    }
  }
  const major = mantissa * base;
  const minor = major / (mantissa == 2 ? 4 : 5);
  return { major, minor };
}

/** A color for use directly in a shader, with no color management. */
export function shaderColor(hex: number) {
  return new THREE.Vector3(
    ((hex >> 16) & 255) / 255,
    ((hex >> 8) & 255) / 255,
    (hex & 255) / 255
  );
}

/** Heading is an angle around the y axis.  0 faces +z.  Increasing turns left. */
export function headingToward(dx: number, dz: number) {
  return Math.atan2(dx, dz);
}

export function wrapAngle(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Turn from `current` toward `target`, at most `maxStep` radians. */
export function turnToward(current: number, target: number, maxStep: number) {
  const diff = wrapAngle(target - current);
  return current + Math.max(-maxStep, Math.min(maxStep, diff));
}
