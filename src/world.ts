import * as THREE from "three";
import { dot, sqrtPrincipal, type Complex } from "./complex";

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
 * The 3D floor is the Riemann surface itself:  the height is the imaginary part of √z,
 * measured relative to √ of whatever the camera is following.  So the floor is level
 * under the camera's subject, rises on the right as it goes behind the branch point,
 * and falls on the left.  The two edges meet behind the cloud, at different heights.
 *
 * These are shared by every shader that draws on the floor, and by floorHeight().
 */
export const floorUniforms = {
  /** 0 for a flat floor.  Bigger is taller. */
  uLift: { value: 0 },
  /** Unit vector.  The value of √z straight toward the camera, on the camera's sheet. */
  uSheetDir: { value: new THREE.Vector2(1, 0) },
  /** Unit vector.  √z where the camera's subject is standing. */
  uFocusDir: { value: new THREE.Vector2(1, 0) },
  /** The angle of the camera, as seen from the branch point.  The cut is directly opposite. */
  uCameraAngle: { value: 0 },
};

/** Height of the floor at this point, in world units.  This matches the floor and trail shaders. */
export function floorHeight(x: number, worldZ: number) {
  const lift = floorUniforms.uLift.value;
  if (lift == 0) {
    return 0;
  }
  const sheet = floorUniforms.uSheetDir.value;
  const focus = floorUniforms.uFocusDir.value;
  let w = sqrtPrincipal({ re: x, im: -worldZ });
  if (dot(w, { re: sheet.x, im: sheet.y }) < 0) {
    w = { re: -w.re, im: -w.im };
  }
  return lift * (w.im * focus.x - w.re * focus.y);
}

/** The floor's surface normal, for tilting shadows. */
export function floorNormal(x: number, worldZ: number, target = new THREE.Vector3()) {
  const e = 0.05;
  const dx = (floorHeight(x + e, worldZ) - floorHeight(x - e, worldZ)) / (2 * e);
  const dz = (floorHeight(x, worldZ + e) - floorHeight(x, worldZ - e)) / (2 * e);
  return target.set(-dx, 1, -dz).normalize();
}

/**
 * GLSL to match floorHeight().  Expects the uniforms in floorUniforms.
 * The floor itself doesn't use this, because it needs both sides of the cut at the same spot.
 */
export const floorHeightGlsl = /* glsl */ `
uniform float uLift;
uniform vec2 uSheetDir;
uniform vec2 uFocusDir;
vec2 csqrt(vec2 z) {
  float r = length(z);
  float a = sqrt(max(0.0, (r + z.x) * 0.5));
  float b = sqrt(max(0.0, (r - z.x) * 0.5));
  return vec2(a, z.y < 0.0 ? -b : b);
}
float floorHeight(vec2 worldXZ) {
  vec2 w = csqrt(vec2(worldXZ.x, -worldXZ.y));
  if (dot(w, uSheetDir) < 0.0) w = -w;
  return uLift * (w.y * uFocusDir.x - w.x * uFocusDir.y);
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
