import * as THREE from "three";
import type { Complex } from "./complex";
import {
  floorHeightGlsl,
  floorUniforms,
  FOG_DENSITY,
  shaderColor,
  SKY_COLOR,
  view,
} from "./world";

const MAX_POINTS = 20000;

/** How solid z and its trail look when they're on the other sheet from the camera. */
export const OFF_SHEET_OPACITY = 0.25;

type TrailPoint = { z: Complex; w?: Complex };

const vertexShader = /* glsl */ `
${floorHeightGlsl}
attribute float across;
/** √z at this point, continued along the path.  This says which sheet the point is on. */
attribute vec2 lift;
uniform float uFadeOffSheet;
varying vec3 vWorld;
varying float vAcross;
varying float vOnSheet;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vOnSheet = 1.0;
  if (uFadeOffSheet > 0.5) {
    // Is this part of the path on the camera's sheet?
    vec2 here = csqrt(vec2(world.x, -world.z));
    if (dot(here, uSheetDir) < 0.0) here = -here;
    vOnSheet = dot(here, lift) >= 0.0 ? 1.0 : 0.0;
  }
  // Ride on top of the 3D floor.
  world.y += floorHeight(world.xz);
  vWorld = world.xyz;
  vAcross = across;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uColor;
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
  gl_FragColor = vec4(mix(color, uFogColor, fog), vOnSheet > 0.5 ? 1.0 : ${OFF_SHEET_OPACITY.toFixed(3)});
}
`;

/**
 * A flat ribbon on the floor, following a path.
 * The path is stored in math coordinates, so zooming just rebuilds the ribbon.
 */
export class Trail {
  readonly mesh: THREE.Mesh;
  private points: TrailPoint[] = [];
  private readonly positions = new Float32Array(MAX_POINTS * 2 * 3);
  private readonly attribute: THREE.BufferAttribute;
  private readonly lifts = new Float32Array(MAX_POINTS * 2 * 2);
  private readonly liftAttribute: THREE.BufferAttribute;
  private readonly geometry = new THREE.BufferGeometry();
  /** Everything before this index is already correct in the buffer. */
  private validCount = 0;
  private builtScale = NaN;

  /**
   * width includes the dark outline.
   *
   * fadeOffSheet is for z's trail.  z lives on the Riemann surface, so parts of its trail can be on
   * the other sheet from the camera.  Those parts are faded, like z itself.  If this is true, you must
   * pass w to add().
   */
  constructor(
    color: number,
    private readonly width: number,
    y: number,
    fadeOffSheet = false
  ) {
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
    this.geometry.setAttribute("position", this.attribute);
    this.geometry.setAttribute("across", new THREE.BufferAttribute(across, 1));
    this.geometry.setAttribute("lift", this.liftAttribute);
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(
      this.geometry,
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          ...floorUniforms,
          uColor: { value: shaderColor(color) },
          uFadeOffSheet: { value: fadeOffSheet ? 1 : 0 },
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

  get last(): Complex | undefined {
    return this.points[this.points.length - 1]?.z;
  }

  /** w is the square root of z that says which sheet z is on.  Only needed with fadeOffSheet. */
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
    const scale = view.scale;
    if (scale != this.builtScale) {
      this.builtScale = scale;
      this.validCount = 0;
    }
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
      const x = point.re * scale;
      const z = -point.im * scale;
      p.set([x + nx * half, 0, z + nz * half, x - nx * half, 0, z - nz * half], i * 6);
      if (w) {
        this.lifts.set([w.re, w.im, w.re, w.im], i * 4);
      }
    }
    this.validCount = count;
    this.attribute.clearUpdateRanges();
    this.attribute.addUpdateRange(start * 6, (count - start) * 6);
    this.attribute.needsUpdate = true;
    this.liftAttribute.clearUpdateRanges();
    this.liftAttribute.addUpdateRange(start * 4, (count - start) * 4);
    this.liftAttribute.needsUpdate = true;
    this.geometry.setDrawRange(0, Math.max(0, (count - 1) * 6));
  }
}
