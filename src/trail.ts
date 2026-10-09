import * as THREE from "three";
import type { Complex } from "./complex";
import { view } from "./world";

const MAX_POINTS = 20000;

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

  constructor(color: number, private readonly width: number, y: number) {
    const index = new Uint32Array((MAX_POINTS - 1) * 6);
    for (let i = 0; i < MAX_POINTS - 1; i++) {
      const a = 2 * i;
      index.set([a, a + 2, a + 1, a + 1, a + 2, a + 3], i * 6);
    }
    this.attribute = new THREE.BufferAttribute(this.positions, 3);
    this.attribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("position", this.attribute);
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(
      this.geometry,
      new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        toneMapped: false,
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
