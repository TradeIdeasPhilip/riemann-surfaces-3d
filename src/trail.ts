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

const vertexShader = /* glsl */ `
${floorHeightGlsl}
attribute float across;
varying vec3 vWorld;
varying float vAcross;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
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
void main() {
  // A dark outline so the trail stands out, even on a floor wedge of the same color.
  float a = abs(vAcross);
  float fw = fwidth(vAcross);
  float inside = 1.0 - smoothstep(0.62 - fw, 0.62 + fw, a);
  vec3 color = mix(vec3(0.03, 0.04, 0.07), uColor, inside);
  float dist = distance(vWorld, cameraPosition);
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  gl_FragColor = vec4(mix(color, uFogColor, fog), 1.0);
}
`;

/**
 * A flat ribbon on the floor, following a path.
 * The path is stored in math coordinates, so zooming just rebuilds the ribbon.
 */
export class Trail {
  readonly mesh: THREE.Mesh;
  private points: Complex[] = [];
  private readonly positions = new Float32Array(MAX_POINTS * 2 * 3);
  private readonly attribute: THREE.BufferAttribute;
  private readonly geometry = new THREE.BufferGeometry();
  /** Everything before this index is already correct in the buffer. */
  private validCount = 0;
  private builtScale = NaN;

  /** width includes the dark outline. */
  constructor(color: number, private readonly width: number, y: number) {
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
    this.geometry.setAttribute("position", this.attribute);
    this.geometry.setAttribute("across", new THREE.BufferAttribute(across, 1));
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
          uFogColor: { value: shaderColor(SKY_COLOR) },
          uFogDensity: { value: FOG_DENSITY },
        },
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
    return this.points[this.points.length - 1];
  }

  add(z: Complex) {
    if (this.points.length >= MAX_POINTS) {
      this.points = this.points.slice(MAX_POINTS / 2);
      this.validCount = 0;
    }
    this.points.push(z);
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
      const before = points[Math.max(0, i - 1)];
      const after = points[Math.min(count - 1, i + 1)];
      // Direction in world coordinates.  World z is -Im.
      const dx = after.re - before.re;
      const dz = -(after.im - before.im);
      const length = Math.hypot(dx, dz);
      if (length > 0) {
        nx = -dz / length;
        nz = dx / length;
      }
      const x = points[i].re * scale;
      const z = -points[i].im * scale;
      p.set([x + nx * half, 0, z + nz * half, x - nx * half, 0, z - nz * half], i * 6);
    }
    this.validCount = count;
    this.attribute.clearUpdateRanges();
    this.attribute.addUpdateRange(start * 6, (count - start) * 6);
    this.attribute.needsUpdate = true;
    this.geometry.setDrawRange(0, Math.max(0, (count - 1) * 6));
  }
}
