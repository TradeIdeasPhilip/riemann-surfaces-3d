import * as THREE from "three";
import {
  CLOUD_RADIUS,
  FOG_DENSITY,
  shaderColor,
  SKY_COLOR,
  TAPE_RADIUS,
} from "./world";

const CLOUD_HEIGHT = 600;
/**
 * The cloud also goes below the floor.  When the 3D floor tilts down on the left,
 * the low edge of the cut is behind the part of the cloud that's below y = 0.
 */
const CLOUD_DEPTH = 100;

const cloudVertexShader = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const cloudFragmentShader = /* glsl */ `
uniform float uTime;
uniform float uRadius;
uniform float uCore;
uniform float uStrength;
uniform vec3 uFogColor;
uniform float uFogDensity;
varying vec3 vWorld;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i + vec3(0, 0, 0)), hash(i + vec3(1, 0, 0)), f.x),
                 mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
                 mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return v;
}

void main() {
  // How far does the line of sight pass from the axis of the cylinder, looking down from above?
  // 0 means straight through the middle, 1 means just grazing the edge.
  // Anything on the floor directly behind the branch point is seen with b = 0.
  vec2 c = cameraPosition.xz;
  vec2 d = normalize(vWorld.xz - c);
  float signedB = (c.x * d.y - c.y * d.x) / uRadius;
  float b = clamp(abs(signedB), 0.0, 1.0);
  float y = vWorld.y;
  float t = uTime;

  // Swirling, rising mist.
  float twist = y * 0.12 + t * 0.35;
  mat2 rot = mat2(cos(twist), -sin(twist), sin(twist), cos(twist));
  vec2 xz = rot * vWorld.xz;
  float n = fbm(vec3(xz.x * 0.9, y * 0.28 - t * 0.6, xz.y * 0.9));
  float n2 = fbm(vec3(signedB * 2.5, y * 0.1 - t * 0.25, t * 0.05));

  // The core is solid so the branch cut is always hidden.  The edges are wispy.
  float core = uCore * (1.0 - smoothstep(0.4, 0.95, b));
  float wisps = smoothstep(0.38, 0.8, n) * (1.0 - smoothstep(0.75, 1.0, b));
  float alpha = max(core, wisps * uStrength);

  vec3 violet = vec3(0.42, 0.28, 0.95);
  vec3 cyan = vec3(0.45, 0.95, 1.0);
  vec3 white = vec3(0.93, 0.92, 1.0);
  vec3 color = mix(violet, cyan, smoothstep(0.3, 0.75, n));
  color = mix(color, white, (1.0 - smoothstep(0.0, 0.6, b)) * (0.35 + 0.4 * n2));
  color *= 0.75 + 0.5 * n;
  color *= 1.0 + 0.7 * exp(-abs(y) * 0.5);
  color += cyan * 0.4 * smoothstep(0.55, 1.0, b) * n;

  float dist = distance(vWorld, cameraPosition);
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  color = mix(color, uFogColor, fog * 0.9);
  alpha *= 1.0 - smoothstep(150.0, 450.0, y);

  gl_FragColor = vec4(color, alpha);
}
`;

function makeCloud(radius: number, core: number, strength: number) {
  const geometry = new THREE.CylinderGeometry(
    radius,
    radius,
    CLOUD_HEIGHT + CLOUD_DEPTH,
    96,
    1,
    true
  );
  geometry.translate(0, (CLOUD_HEIGHT - CLOUD_DEPTH) / 2, 0);
  const material = new THREE.ShaderMaterial({
    vertexShader: cloudVertexShader,
    fragmentShader: cloudFragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uRadius: { value: radius },
      uCore: { value: core },
      uStrength: { value: strength },
      uFogColor: { value: shaderColor(SKY_COLOR) },
      uFogDensity: { value: FOG_DENSITY },
    },
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}

function radialTexture(stops: [number, string][]) {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2
  );
  for (const [offset, color] of stops) {
    gradient.addColorStop(offset, color);
  }
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A soft dark spot to put under things so they look like they're standing on the floor. */
export function makeBlobShadow(radius: number) {
  const geometry = new THREE.CircleGeometry(radius, 32);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    map: blobTexture,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  // A little higher than you'd think, because the 3D floor isn't perfectly flat under it.
  mesh.position.y = 0.03;
  mesh.renderOrder = -1;
  return mesh;
}
const blobTexture = radialTexture([
  [0, "rgba(0,0,0,0.6)"],
  [0.6, "rgba(0,0,0,0.25)"],
  [1, "rgba(0,0,0,0)"],
]);

function coneTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 128;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#ff6a13";
  context.fillRect(0, 0, 8, 128);
  context.fillStyle = "#f4f4f4";
  context.fillRect(0, 128 * 0.3, 8, 128 * 0.13);
  context.fillRect(0, 128 * 0.55, 8, 128 * 0.13);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function tapeTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 96;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#ffd400";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111";
  context.fillRect(0, 0, canvas.width, 8);
  context.fillRect(0, canvas.height - 8, canvas.width, 8);
  context.font = "900 56px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("CAUTION · BRANCH POINT", canvas.width / 2, canvas.height / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

/** The orange cones and the caution tape strung between them.  They sit on the (maybe 3D) floor. */
class Barrier {
  readonly group = new THREE.Group();
  private readonly cones: THREE.Object3D[] = [];
  private readonly tapePositions: Float32Array;
  private readonly tapeGeometry = new THREE.BufferGeometry();
  private static readonly TAPE_HEIGHT = 0.66;
  private static readonly TAPE_WIDTH = 0.17;

  constructor(private readonly count: number) {
    const coneMaterial = new THREE.MeshStandardMaterial({
      map: coneTexture(),
      roughness: 0.6,
    });
    const baseMaterial = new THREE.MeshStandardMaterial({
      color: 0x2a1a10,
      roughness: 0.8,
    });
    const coneGeometry = new THREE.ConeGeometry(0.26, 0.8, 24, 1, true);
    coneGeometry.translate(0, 0.44, 0);
    const baseGeometry = new THREE.BoxGeometry(0.56, 0.05, 0.56);
    baseGeometry.translate(0, 0.025, 0);
    for (let i = 0; i < count; i++) {
      const cone = new THREE.Group();
      cone.add(new THREE.Mesh(coneGeometry, coneMaterial), new THREE.Mesh(baseGeometry, baseMaterial));
      const angle = this.angle(i);
      cone.position.set(TAPE_RADIUS * Math.cos(angle), 0, -TAPE_RADIUS * Math.sin(angle));
      cone.rotation.y = angle;
      this.cones.push(cone);
      this.group.add(cone);
    }

    // A ribbon through the cones, with a top and bottom vertex at each cone.
    // u counts cones, so the texture repeats once between each pair of cones.
    this.tapePositions = new Float32Array((count + 1) * 2 * 3);
    const uv: number[] = [];
    const index: number[] = [];
    for (let i = 0; i <= count; i++) {
      uv.push(i, 1, i, 0);
      if (i < count) {
        const a = 2 * i;
        index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    }
    this.tapeGeometry.setAttribute("position", new THREE.BufferAttribute(this.tapePositions, 3));
    this.tapeGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    this.tapeGeometry.setIndex(index);
    const tape = new THREE.Mesh(
      this.tapeGeometry,
      new THREE.MeshBasicMaterial({
        map: tapeTexture(),
        side: THREE.DoubleSide,
        toneMapped: false,
      })
    );
    tape.frustumCulled = false;
    this.group.add(tape);
  }

  /** Math angle, counterclockwise from Re. */
  private angle(i: number) {
    return (i / this.count) * Math.PI * 2;
  }

  update(heightAt: (x: number, z: number) => number) {
    for (const cone of this.cones) {
      cone.position.y = heightAt(cone.position.x, cone.position.z);
    }
    const p = this.tapePositions;
    const half = Barrier.TAPE_WIDTH / 2;
    for (let i = 0; i <= this.count; i++) {
      const cone = this.cones[i % this.count];
      const { x, y, z } = cone.position;
      const middle = y + Barrier.TAPE_HEIGHT;
      p.set([x, middle + half, z, x, middle - half, z], i * 6);
    }
    this.tapeGeometry.attributes.position.needsUpdate = true;
  }
}

class Sparkles {
  readonly points: THREE.Points;
  private readonly speeds: Float32Array;
  private readonly positions: Float32Array;
  private static readonly COUNT = 450;
  private static readonly HEIGHT = 28;

  constructor() {
    const count = Sparkles.COUNT;
    this.positions = new Float32Array(count * 3);
    this.speeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = CLOUD_RADIUS * 1.5 * Math.sqrt(Math.random());
      const theta = Math.random() * Math.PI * 2;
      this.positions[i * 3] = r * Math.sin(theta);
      this.positions[i * 3 + 1] = Math.random() * Sparkles.HEIGHT;
      this.positions[i * 3 + 2] = r * Math.cos(theta);
      this.speeds[i] = 0.4 + Math.random() * 1.4;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3).setUsage(
        THREE.DynamicDrawUsage
      )
    );
    const material = new THREE.PointsMaterial({
      size: 0.16,
      map: radialTexture([
        [0, "rgba(255,255,255,1)"],
        [0.25, "rgba(190,240,255,0.8)"],
        [1, "rgba(120,160,255,0)"],
      ]),
      color: 0xbfe9ff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  update(dt: number, time: number) {
    const p = this.positions;
    for (let i = 0; i < Sparkles.COUNT; i++) {
      let y = p[i * 3 + 1] + this.speeds[i] * dt;
      if (y > Sparkles.HEIGHT) {
        y -= Sparkles.HEIGHT;
      }
      p[i * 3 + 1] = y;
      // A slow spiral.
      const angle = dt * 0.5 * this.speeds[i];
      const x = p[i * 3];
      const z = p[i * 3 + 2];
      p[i * 3] = x * Math.cos(angle) - z * Math.sin(angle);
      p[i * 3 + 2] = x * Math.sin(angle) + z * Math.cos(angle);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    (this.points.material as THREE.PointsMaterial).opacity =
      0.75 + 0.25 * Math.sin(time * 2.3);
  }
}

/**
 * Everything at the branch point:  the cloud, the sparkles, the cones, and the tape.
 * The glow on the floor is drawn by the floor's shader.
 */
export class BranchPoint {
  readonly group = new THREE.Group();
  private readonly clouds: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[];
  private readonly sparkles = new Sparkles();
  private readonly barrier = new Barrier(12);

  constructor() {
    const inner = makeCloud(CLOUD_RADIUS, 1, 0.85);
    inner.renderOrder = 1;
    const outer = makeCloud(CLOUD_RADIUS * 1.45, 0, 0.35);
    outer.renderOrder = 2;
    this.clouds = [inner, outer];

    const light = new THREE.PointLight(0x8fd8ff, 40, 30, 1.4);
    light.position.y = 2.5;

    this.group.add(inner, outer, this.sparkles.points, this.barrier.group, light);
  }

  update(dt: number, time: number, heightAt: (x: number, z: number) => number) {
    for (const cloud of this.clouds) {
      cloud.material.uniforms.uTime.value = time;
    }
    this.sparkles.update(dt, time);
    this.barrier.update(heightAt);
  }
}
