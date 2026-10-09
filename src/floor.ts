import * as THREE from "three";
import type { Complex } from "./complex";
import {
  FOG_DENSITY,
  gridSpacing,
  shaderColor,
  SKY_COLOR,
  TAPE_RADIUS,
} from "./world";

const vertexShader = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
uniform float uScale;
uniform float uMajor;
uniform float uMinor;
uniform vec2 uSheetDir;
uniform float uSheetMix;
uniform vec3 uFogColor;
uniform float uFogDensity;
varying vec3 vWorld;

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

// Anti-aliased line, about widthPx pixels wide.  Fades out when the cells get too small to see.
float gridAxis(float q, float fw, float widthPx) {
  float d = abs(fract(q - 0.5) - 0.5) / max(fw, 1e-6);
  float line = clamp(widthPx * 0.5 + 0.5 - d, 0.0, 1.0);
  return line * (1.0 - smoothstep(0.08, 0.3, fw));
}

float grid(vec2 p, float spacing, float widthPx) {
  vec2 q = p / spacing;
  vec2 fw = fwidth(q);
  return max(gridAxis(q.x, fw.x, widthPx), gridAxis(q.y, fw.y, widthPx));
}

vec2 csqrt(vec2 z) {
  float r = length(z);
  float a = sqrt(max(0.0, (r + z.x) * 0.5));
  float b = sqrt(max(0.0, (r - z.x) * 0.5));
  return vec2(a, z.y < 0.0 ? -b : b);
}

void main() {
  // Math coordinates.  Re = world x, Im = -world z.
  vec2 p = vec2(vWorld.x, -vWorld.z) / uScale;

  vec3 color = vec3(0.10, 0.125, 0.19);

  if (uSheetMix > 0.0) {
    // Domain coloring of the branch of sqrt that the camera is standing on.
    // The cut is the ray directly behind the branch point, as seen from the camera,
    // so the cloud always hides it.
    vec2 w = csqrt(p);
    if (dot(w, uSheetDir) < 0.0) w = -w;
    float hue = atan(w.y, w.x) / 6.28318530718;
    float band = fract(log2(length(w) + 1e-20) * 2.0);
    vec3 dc = hsv2rgb(vec3(fract(hue), 0.6, 0.30 + 0.14 * band));
    color = mix(color, dc, uSheetMix);
  }

  float minor = grid(p, uMinor, 1.0);
  float major = grid(p, uMajor, 1.6);
  vec2 fwp = fwidth(p);
  float axes = max(
    clamp(1.6 + 0.5 - abs(p.y) / fwp.y, 0.0, 1.0),
    clamp(1.6 + 0.5 - abs(p.x) / fwp.x, 0.0, 1.0));

  color = mix(color, vec3(0.24, 0.29, 0.40), minor * 0.6);
  color = mix(color, vec3(0.42, 0.50, 0.66), major * 0.85);
  color = mix(color, vec3(0.80, 0.86, 1.00), axes);

  float dist = distance(vWorld, cameraPosition);
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  gl_FragColor = vec4(mix(color, uFogColor, fog), 1.0);
}
`;

type LabelInfo = { text: string; x: number; z: number; title: boolean };

/** The complex plane, drawn on the floor. */
export class Floor {
  readonly mesh: THREE.Mesh;
  readonly labels = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;
  private readonly sprites: THREE.Sprite[] = [];
  private readonly spriteMaterials = new Map<string, THREE.SpriteMaterial>();
  private labelScale = NaN;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uScale: { value: 1 },
        uMajor: { value: 1 },
        uMinor: { value: 0.2 },
        uSheetDir: { value: new THREE.Vector2(1, 0) },
        uSheetMix: { value: 0 },
        uFogColor: { value: shaderColor(SKY_COLOR) },
        uFogDensity: { value: FOG_DENSITY },
      },
    });
    const geometry = new THREE.PlaneGeometry(3000, 3000);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
  }

  update(
    scale: number,
    cameraPosition: THREE.Vector3,
    sheetDirection: Complex,
    sheetMix: number
  ) {
    // The plane follows the camera so it looks infinite.  The shader works in world coordinates.
    this.mesh.position.set(cameraPosition.x, 0, cameraPosition.z);
    const { major, minor } = gridSpacing(scale);
    const u = this.material.uniforms;
    u.uScale.value = scale;
    u.uMajor.value = major;
    u.uMinor.value = minor;
    u.uSheetDir.value.set(sheetDirection.re, sheetDirection.im);
    u.uSheetMix.value = sheetMix;
    if (scale != this.labelScale) {
      this.labelScale = scale;
      this.updateLabels(scale, major);
    }
  }

  private updateLabels(scale: number, major: number) {
    const items: LabelInfo[] = [];
    const step = major * scale;
    const count = Math.min(40, Math.floor(160 / step));
    const decimals = Math.max(0, -Math.floor(Math.log10(major) + 1e-9));
    for (let k = 1; k <= count; k++) {
      for (const sign of [1, -1]) {
        const value = sign * k * major;
        const world = value * scale;
        if (Math.abs(world) < TAPE_RADIUS + 0.8) {
          continue;
        }
        const text = value.toFixed(decimals).replace("-", "−");
        items.push({ text, x: world, z: 0, title: false });
        const imaginary =
          Math.abs(value) == 1 ? (sign < 0 ? "−i" : "i") : text + "i";
        items.push({ text: imaginary, x: 0, z: -world, title: false });
      }
    }
    // Axis names, half way between two numbers so they don't collide.
    const titleSteps = Math.max(2, Math.ceil((TAPE_RADIUS + 2) / step)) + 0.5;
    items.push({ text: "Re", x: titleSteps * step, z: 0, title: true });
    items.push({ text: "Im", x: 0, z: -titleSteps * step, title: true });

    while (this.sprites.length < items.length) {
      const sprite = new THREE.Sprite();
      sprite.center.set(0.5, 0);
      this.sprites.push(sprite);
      this.labels.add(sprite);
    }
    this.sprites.forEach((sprite, index) => {
      const item = items[index];
      if (!item) {
        sprite.visible = false;
        return;
      }
      sprite.visible = true;
      const material = this.getMaterial(item.text, item.title);
      sprite.material = material;
      const image = material.map!.image as HTMLCanvasElement;
      const height = item.title ? 1.3 : 0.8;
      sprite.scale.set((height * image.width) / image.height, height, 1);
      sprite.position.set(item.x, 0.05, item.z);
    });
  }

  private getMaterial(text: string, title: boolean) {
    const key = (title ? "T:" : "") + text;
    let material = this.spriteMaterials.get(key);
    if (!material) {
      if (this.spriteMaterials.size > 400) {
        this.spriteMaterials.forEach((m) => {
          m.map?.dispose();
          m.dispose();
        });
        this.spriteMaterials.clear();
      }
      material = new THREE.SpriteMaterial({
        map: textTexture(text, title ? "#ffd27a" : "#c9d5f2", title),
        toneMapped: false,
        transparent: true,
        // Otherwise the clear parts of the label hide the cloud behind it.
        alphaTest: 0.05,
      });
      this.spriteMaterials.set(key, material);
    }
    return material;
  }
}

function textTexture(text: string, color: string, italic: boolean) {
  const fontSize = 64;
  const font = `${italic ? "italic " : ""}600 ${fontSize}px system-ui, sans-serif`;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d")!;
  context.font = font;
  const width = Math.ceil(context.measureText(text).width) + 24;
  canvas.width = width;
  canvas.height = fontSize + 20;
  context.font = font;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineWidth = 8;
  context.strokeStyle = "rgba(10, 14, 26, 0.85)";
  context.strokeText(text, width / 2, canvas.height / 2);
  context.fillStyle = color;
  context.fillText(text, width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
