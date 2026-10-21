import * as THREE from "three";
import type { Complex } from "./complex";
import {
  floorHeightGlsl,
  floorUniforms,
  FOG_DENSITY,
  shaderColor,
  SKY_COLOR,
  view,
  type FloorUniforms,
  type Space,
} from "./world";

const MAX_POINTS = 20000;

/** How solid z looks when it's on the other sheet from the camera. */
export const OFF_SHEET_OPACITY = 0.25;
/** The trail is thinner than z, so it needs a little more to stay visible. */
export const OFF_SHEET_TRAIL_OPACITY = 0.4;

type TrailPoint = { z: Complex; w?: Complex };

const vertexShader = /* glsl */ `
${floorHeightGlsl}
attribute float across;
/** From the middle of the ribbon out to this edge, at the trail's normal width. */
attribute vec2 side;
/** The function's value at this point, continued along the path.  This says which sheet it's on. */
attribute vec2 lift;
uniform float uFadeOffSheet;
uniform float uWidth;
/** World units per math unit, and the math point at the world's origin.  See Space. */
uniform float uScale;
uniform vec2 uCenter;
varying vec3 vWorld;
varying float vAcross;
varying float vOnSheet;
void main() {
  // position is in math coordinates:  (Re, 0, -Im).
  vec3 local = vec3((position.x - uCenter.x) * uScale, position.y, (position.z + uCenter.y) * uScale);
  vec4 world = modelMatrix * vec4(local, 1.0);
  // Never let the trail get thinner than a few pixels, so it's still visible from far away.
  float grow = max(1.0, 0.005 * distance(cameraPosition, world.xyz) / uWidth);
  world.xz += side * grow;
  // Usually ride on top of the 3D floor, the camera's sheet.
  float phi = cameraRelativeAngle(world.xz);
  float level = 0.0;
  if (uFadeOffSheet > 0.5) {
    // Which sheet is this part of the path on?
    float cameraTotal = uCameraTotal + phi;
    if (uFunction > 1.5) {
      // The cubic:  which level's value is it?  Two different values are never this close, even right
      // next to a branch point.
      vec2 here = vec2(position.x, -position.z);
      vec2 w0;
      vec2 w1;
      cubicSheets(here, w0, w1);
      float tolerance = 1e-3 * (1.0 + length(lift));
      level = distance(lift, w0) < tolerance ? 0.0 : distance(lift, w1) < tolerance ? 1.0 : 2.0;
    } else if (uFunction < 0.5) {
      // √:  Is it the same square root as the camera's, or the other one?
      level = cos(atan(lift.y, lift.x) - cameraTotal * 0.5) >= 0.0 ? 0.0 : 1.0;
    } else {
      // log:  How many levels away is it?
      level = floor((lift.y - cameraTotal) / F_TAU + 0.5);
    }
  }
  vOnSheet = level == 0.0 ? 1.0 : 0.0;
  // Ride on the sheet it's on.
  world.y += floorHeightAtXZ(world.xz, phi, level);
  vWorld = world.xyz;
  vAcross = across;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uColor;
/** How solid the parts of the trail on other sheets are. */
uniform float uOffSheetAlpha;
uniform vec3 uFogColor;
uniform float uFogDensity;
varying vec3 vWorld;
varying float vAcross;
varying float vOnSheet;
void main() {
  // A dark outline so the trail stands out, even on a floor wedge of the same color.
  float a = abs(vAcross);
  float fw = fwidth(vAcross);
  float inside = 1.0 - smoothstep(0.62 - fw, 0.62 + fw, a);
  vec3 color = mix(vec3(0.03, 0.04, 0.07), uColor, inside);
  float dist = distance(vWorld, cameraPosition);
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  gl_FragColor = vec4(mix(color, uFogColor, fog), vOnSheet > 0.5 ? 1.0 : uOffSheetAlpha);
}
`;

export type TrailOptions = {
  /**
   * For z's trail.  z lives on the Riemann surface, so parts of its trail can be on the other sheet
   * from the camera.  Those parts are faded, like z itself.  If this is true, you must pass w to add().
   */
  fadeOffSheet?: boolean;
  /** Which floor this trail sits on.  The default is the input's floor. */
  uniforms?: FloorUniforms;
  space?: Space;
};

/**
 * A flat ribbon on the floor, following a path.
 * The path is stored in math coordinates.  The shader applies the zoom, so zooming is free.
 */
export class Trail {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private points: TrailPoint[] = [];
  private readonly positions = new Float32Array(MAX_POINTS * 2 * 3);
  private readonly attribute: THREE.BufferAttribute;
  private readonly sides = new Float32Array(MAX_POINTS * 2 * 2);
  private readonly sideAttribute: THREE.BufferAttribute;
  private readonly lifts = new Float32Array(MAX_POINTS * 2 * 2);
  private readonly liftAttribute: THREE.BufferAttribute;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly space: Space;
  /** Everything before this index is already correct in the buffer. */
  private validCount = 0;

  /** width is in world units, and includes the dark outline. */
  constructor(color: number, private readonly width: number, y: number, options: TrailOptions = {}) {
    const fadeOffSheet = options.fadeOffSheet ?? false;
    this.space = options.space ?? view;
    const index = new Uint32Array((MAX_POINTS - 1) * 6);
    for (let i = 0; i < MAX_POINTS - 1; i++) {
      const a = 2 * i;
      index.set([a, a + 2, a + 1, a + 1, a + 2, a + 3], i * 6);
    }
    const across = new Float32Array(MAX_POINTS * 2);
    for (let i = 0; i < MAX_POINTS; i++) {
      across[2 * i] = 1;
      across[2 * i + 1] = -1;
    }
    this.attribute = new THREE.BufferAttribute(this.positions, 3);
    this.attribute.setUsage(THREE.DynamicDrawUsage);
    this.liftAttribute = new THREE.BufferAttribute(this.lifts, 2);
    this.liftAttribute.setUsage(THREE.DynamicDrawUsage);
    this.sideAttribute = new THREE.BufferAttribute(this.sides, 2);
    this.sideAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("position", this.attribute);
    this.geometry.setAttribute("across", new THREE.BufferAttribute(across, 1));
    this.geometry.setAttribute("side", this.sideAttribute);
    this.geometry.setAttribute("lift", this.liftAttribute);
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(
      this.geometry,
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          // Shared, so this follows the 3D floor it's sitting on.
          ...(options.uniforms ?? floorUniforms),
          uColor: { value: shaderColor(color) },
          uFadeOffSheet: { value: fadeOffSheet ? 1 : 0 },
          uOffSheetAlpha: { value: OFF_SHEET_TRAIL_OPACITY },
          uWidth: { value: width },
          uScale: { value: 1 },
          uCenter: { value: new THREE.Vector2() },
          uFogColor: { value: shaderColor(SKY_COLOR) },
          uFogDensity: { value: FOG_DENSITY },
        },
        transparent: fadeOffSheet,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      })
    );
    this.mesh.position.y = y;
    this.mesh.frustumCulled = false;
  }

  /** How solid the parts of the trail on other sheets are.  Only for trails with fadeOffSheet. */
  setOffSheetOpacity(opacity: number) {
    this.mesh.material.uniforms.uOffSheetAlpha.value = opacity;
  }

  get last(): Complex | undefined {
    return this.points[this.points.length - 1]?.z;
  }

  /** w is the function's value that says which sheet z is on.  Only needed with fadeOffSheet. */
  add(z: Complex, w?: Complex) {
    if (this.points.length >= MAX_POINTS) {
      this.points = this.points.slice(MAX_POINTS / 2);
      this.validCount = 0;
    }
    this.points.push({ z, w });
    // The previous point's direction changed too.
    this.validCount = Math.min(this.validCount, this.points.length - 2);
  }

  clear() {
    this.points = [];
    this.validCount = 0;
    this.geometry.setDrawRange(0, 0);
  }

  update() {
    const u = this.mesh.material.uniforms;
    u.uScale.value = this.space.scale;
    u.uCenter.value.set(this.space.center.re, this.space.center.im);
    const points = this.points;
    const count = points.length;
    const start = Math.max(0, this.validCount);
    if (start >= count) {
      return;
    }
    const half = this.width / 2;
    const p = this.positions;
    let nx = 0;
    let nz = 1;
    for (let i = start; i < count; i++) {
      const before = points[Math.max(0, i - 1)].z;
      const after = points[Math.min(count - 1, i + 1)].z;
      // Direction in world coordinates.  World z is -Im.
      const dx = after.re - before.re;
      const dz = -(after.im - before.im);
      const length = Math.hypot(dx, dz);
      if (length > 0) {
        nx = -dz / length;
        nz = dx / length;
      }
      const { z: point, w } = points[i];
      // Both edges start at the middle.  The shader moves them out, so it can widen far away trails.
      p.set([point.re, 0, -point.im, point.re, 0, -point.im], i * 6);
      this.sides.set([nx * half, nz * half, -nx * half, -nz * half], i * 4);
      if (w) {
        this.lifts.set([w.re, w.im, w.re, w.im], i * 4);
      }
    }
    this.validCount = count;
    this.attribute.clearUpdateRanges();
    this.attribute.addUpdateRange(start * 6, (count - start) * 6);
    this.attribute.needsUpdate = true;
    this.sideAttribute.clearUpdateRanges();
    this.sideAttribute.addUpdateRange(start * 4, (count - start) * 4);
    this.sideAttribute.needsUpdate = true;
    this.liftAttribute.clearUpdateRanges();
    this.liftAttribute.addUpdateRange(start * 4, (count - start) * 4);
    this.liftAttribute.needsUpdate = true;
    this.geometry.setDrawRange(0, Math.max(0, (count - 1) * 6));
  }
}
