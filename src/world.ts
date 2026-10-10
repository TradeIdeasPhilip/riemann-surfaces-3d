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
 *
 * floorUniforms are shared by every shader that draws on the input's floor, and by floorHeight().
 */
export function makeFloorUniforms() {
  return {
    /** 0 for √, 1 for log.  See MultiFunction.shaderId. */
    uFunction: { value: 0 },
    /** 0 for a flat floor.  Bigger is taller. */
    uLift: { value: 0 },
    /** The angle of the camera, as seen from the branch point.  The cut is directly opposite. */
    uCameraAngle: { value: 0 },
    /** The total angle of the camera's own value.  This picks the colors. */
    uCameraTotal: { value: 0 },
    /** The camera's total angle minus its subject's.  Always between -π and π. */
    uRelAngle: { value: 0 },
    /**
     * Show the see-through level uSpotLevel as solid in a small circle, under z.
     * x and y are the world x and z of the middle, and z is the radius.
     */
    uSpot: { value: new THREE.Vector3() },
    /** -1 for no spot. */
    uSpotLevel: { value: -1 },
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

/** The floor's surface normal, for tilting shadows. */
export function floorNormal(x: number, worldZ: number, level = 0, target = new THREE.Vector3()) {
  const e = 0.05;
  const dx = (floorHeight(x + e, worldZ, level) - floorHeight(x - e, worldZ, level)) / (2 * e);
  const dz = (floorHeight(x, worldZ + e, level) - floorHeight(x, worldZ - e, level)) / (2 * e);
  return target.set(-dx, 1, -dz).normalize();
}

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
/** phi is measured from the camera's direction.  level 0 is the camera's sheet. */
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
float floorHeight(vec2 worldXZ) {
  return floorHeightAt(cameraRelativeAngle(worldXZ), 0.0);
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
