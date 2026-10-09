import * as THREE from "three";
import type { Complex } from "./complex";

/*
 * Two coordinate systems:
 *
 * "math" coordinates are the complex plane.
 * "world" coordinates are three.js units, Y is up, the floor is y = 0.
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
