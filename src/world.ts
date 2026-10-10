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

export const view = {
  /** World units per math unit. */
  scale: 5,
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
 * Everything about the floor is measured by a "total angle", τ:  how far z has turned around the
 * branch point, counting full turns, relative to whatever the camera is following.  On the camera's
 * sheet, τ at any point is uRelAngle plus that point's angle from the camera's direction, which is
 * between -π and π.  The cut is where that angle jumps, directly behind the branch point.
 *
 * The 3D floor is the Riemann surface itself.  The height is
 *   √:   lift × Im(√z) relative to √ at the camera's subject = lift × √r × sin(τ/2)
 *   log: lift × τ, a spiral ramp, like a parking garage.
 * Either way it's level under the camera's subject, rises on the right as it goes behind the branch
 * point, and falls on the left.  The two edges meet behind the cloud, at different heights.
 *
 * These are shared by every shader that draws on the floor, and by floorHeight().
 */
export const floorUniforms = {
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
  /** The total angle of the camera's subject.  For putting z's trail at its own height. */
  uFocusTotal: { value: 0 },
};

/** The angle of this point around the branch point, measured from the camera's direction, -π to π. */
export function cameraRelativeAngle(x: number, worldZ: number) {
  return wrapAngle(Math.atan2(-worldZ, x) - floorUniforms.uCameraAngle.value);
}

/** Height of the floor at this point, in world units.  This matches the floor and trail shaders. */
export function floorHeight(x: number, worldZ: number) {
  const u = floorUniforms;
  const lift = u.uLift.value;
  if (lift == 0) {
    return 0;
  }
  const tau = u.uRelAngle.value + cameraRelativeAngle(x, worldZ);
  if (u.uFunction.value == 0) {
    return lift * Math.sqrt(Math.hypot(x, worldZ)) * Math.sin(tau / 2);
  } else {
    return lift * tau;
  }
}

/** The floor's surface normal, for tilting shadows. */
export function floorNormal(x: number, worldZ: number, target = new THREE.Vector3()) {
  const e = 0.05;
  const dx = (floorHeight(x + e, worldZ) - floorHeight(x - e, worldZ)) / (2 * e);
  const dz = (floorHeight(x, worldZ + e) - floorHeight(x, worldZ - e)) / (2 * e);
  return target.set(-dx, 1, -dz).normalize();
}

/** GLSL to match floorHeight() and cameraRelativeAngle().  Uses the uniforms in floorUniforms. */
export const floorHeightGlsl = /* glsl */ `
uniform float uFunction;
uniform float uLift;
uniform float uCameraAngle;
uniform float uCameraTotal;
uniform float uRelAngle;
uniform float uFocusTotal;
const float F_PI = 3.14159265358979;
const float F_TAU = 6.28318530717959;
float wrapAngle(float a) {
  return mod(a + F_PI, F_TAU) - F_PI;
}
float cameraRelativeAngle(vec2 worldXZ) {
  return wrapAngle(atan(-worldXZ.y, worldXZ.x) - uCameraAngle);
}
/** r is the distance from the branch point in world units.  tau is relative to the camera's subject. */
float floorHeightAt(float r, float tau) {
  if (uFunction < 0.5) {
    return uLift * sqrt(r) * sin(tau * 0.5);
  }
  return uLift * tau;
}
float floorHeight(vec2 worldXZ) {
  return floorHeightAt(length(worldXZ), uRelAngle + cameraRelativeAngle(worldXZ));
}
`;

export function toWorld(z: Complex, y = 0, target = new THREE.Vector3()) {
  return target.set(z.re * view.scale, y, -z.im * view.scale);
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
