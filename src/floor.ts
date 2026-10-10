import * as THREE from "three";
import { I, type Complex } from "./complex";
import {
  floorHeight,
  floorHeightGlsl,
  floorUniforms,
  FOG_DENSITY,
  gridSpacing,
  MY_RAINBOW,
  shaderColor,
  SKY_COLOR,
  TAPE_RADIUS,
  view,
  type FloorUniforms,
  type Space,
} from "./world";

/*
 * The floor is a big disk around the branch point, built in polar coordinates.
 * position.x is the distance from the branch point and position.y is the angle,
 * measured from the direction of the camera.  So the seam at ±π is always directly
 * behind the branch point, hidden by the cloud.  That's the branch cut.  The two copies
 * of the seam can have different heights, which is what makes the 3D floor work.
 */
const vertexShader = /* glsl */ `
${floorHeightGlsl}
/** 0 is the camera's own level.  1 is the next level up the log spiral, and so on. */
uniform float uLevel;
varying vec3 vWorld;
void main() {
  float r = position.x;
  float phi = position.y;
  // Math angle, counterclockwise from Re.
  float angle = uCameraAngle + phi;
  float height = floorHeightAt(phi, uLevel);
  vWorld = vec3(r * cos(angle), height, -r * sin(angle));
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const fragmentShader = /* glsl */ `
${floorHeightGlsl}
uniform float uLevel;
/** 1 for the see-through levels above and below the camera's. */
uniform float uGhost;
/** For the see-through levels.  0 hides them, 1 is normal. */
uniform float uGhostFill;
/** The see-through levels fade out between these distances from the branch point, in world units. */
uniform vec2 uGhostFade;
/** How solid the see-through levels are, not counting the grid lines. */
uniform float uGhostBase;
uniform float uScale;
/** The math point at the world's origin.  See Space. */
uniform vec2 uCenter;
/** 1 to draw the glow around the base of the cloud. */
uniform float uGlow;
uniform float uMajor;
uniform float uMinor;
uniform float uSheetMix;
uniform vec3 uRainbow[9];
uniform vec3 uFogColor;
uniform float uFogDensity;
varying vec3 vWorld;

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

vec3 rainbow(float k) {
  return uRainbow[int(mod(k, 9.0))];
}

void main() {
  // Math coordinates.  Re = world x, Im = -world z.
  vec2 p = vec2(vWorld.x, -vWorld.z) / uScale + uCenter;
  vec3 plain = vec3(0.10, 0.125, 0.19);
  vec3 color = plain;

  if (uSheetMix > 0.0) {
    // Nine solid wedges of color, by the total angle around the branch point.  Red is centered on
    // the positive real axis of the principal sheet.  All nine colors take two laps around the branch
    // point, which is once around for √z itself.  So each sheet of √z, or each level of log, shows
    // half of the rainbow, and the two edges of the cut, hidden behind the cloud, are about half a
    // rainbow apart.
    float total = uCameraTotal + cameraRelativeAngle(vWorld.xz) + F_TAU * uLevel;
    float t = total * 9.0 / (2.0 * F_TAU) + 0.5;
    float k = floor(t);
    float f = t - k;
    float fw = max(fwidth(t), 1e-6);
    // Sharp edges, but anti-aliased:  how much of this pixel is in the neighboring wedge?
    float below = clamp((0.5 * fw - f) / fw, 0.0, 1.0);
    float above = clamp((f + 0.5 * fw - 1.0) / fw, 0.0, 1.0);
    vec3 wedge = rainbow(k) * (1.0 - below - above) + rainbow(k - 1.0) * below + rainbow(k + 1.0) * above;
    color = mix(plain, wedge, uSheetMix);
  }

  // The glow around the base of the cloud.
  float d = length(vWorld.xz);
  float glow = (1.0 - smoothstep(0.0, 7.0, d)) * uGlow;
  color += mix(vec3(0.43, 0.47, 1.0), vec3(0.55, 0.86, 1.0), exp(-d / 1.5)) * 0.8 * glow * glow;

  float minor = grid(p, uMinor, 1.0);
  float major = grid(p, uMajor, 1.6);
  vec2 fwp = fwidth(p);
  float axes = max(
    clamp(1.6 + 0.5 - abs(p.y) / fwp.y, 0.0, 1.0),
    clamp(1.6 + 0.5 - abs(p.x) / fwp.x, 0.0, 1.0));

  // Light lines on the plain floor, dark lines on the colors.
  vec3 minorColor = mix(vec3(0.24, 0.29, 0.40), vec3(0.0), uSheetMix);
  vec3 majorColor = mix(vec3(0.42, 0.50, 0.66), vec3(0.0), uSheetMix);
  color = mix(color, minorColor, minor * mix(0.6, 0.3, uSheetMix));
  color = mix(color, majorColor, major * mix(0.85, 0.55, uSheetMix));
  color = mix(color, vec3(0.80, 0.86, 1.00), axes);

  // The other levels are mostly see-through, with the grid lines showing more.  Far from the
  // branch point they're nearly flat and just stack up like plain floors, so fade them out there.
  float alpha = 1.0;
  if (uGhost > 0.5) {
    alpha = uGhostBase + max(minor * 0.15, max(major * 0.45, axes * 0.6));
    alpha *= (1.0 - smoothstep(uGhostFade.x, uGhostFade.y, d)) * uGhostFill;
  }

  float dist = distance(vWorld, cameraPosition);
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  gl_FragColor = vec4(mix(color, uFogColor, fog), alpha);
}
`;

/** Levels of the log spiral to draw above the camera's own.  The ones below are hidden by the floor. */
const GHOST_LEVELS = 3;

/** How bright the rainbow is on the floor.  Dim enough that the trails and robots stand out. */
const RAINBOW_BRIGHTNESS = 0.6;

/**
 * A disk from innerRadius to far past the fog, in polar coordinates.  See vertexShader.
 * The input's floor starts just inside the cloud.  The outputs' floor has no cloud, so it starts at
 * almost 0.
 */
function polarGeometry(innerRadius: number) {
  const rings = 220;
  const segments = 360;
  const outerRadius = 1e6;
  const positions: number[] = [];
  for (let i = 0; i <= rings; i++) {
    // Rings get farther apart as they go out, so there's detail near the branch point.
    const r = innerRadius * Math.pow(outerRadius / innerRadius, i / rings);
    for (let j = 0; j <= segments; j++) {
      positions.push(r, -Math.PI + (2 * Math.PI * j) / segments, 0);
    }
  }
  const indices: number[] = [];
  const columns = segments + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * columns + j;
      const b = a + columns;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

type LabelInfo = { text: string; x: number; z: number; title: boolean };

function floorMaterial(level: number, shared: FloorUniforms, glow: boolean) {
  const ghost = level != 0;
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      // These are shared, so changing them changes every material on this floor.
      ...shared,
      uLevel: { value: level },
      uGhost: { value: ghost ? 1 : 0 },
      uGhostFill: { value: 1 },
      uGhostFade: { value: new THREE.Vector2(16, 36) },
      uGhostBase: { value: 0.16 },
      uGlow: { value: glow ? 1 : 0 },
      uCenter: { value: new THREE.Vector2() },
      uScale: { value: 1 },
      uMajor: { value: 1 },
      uMinor: { value: 0.2 },
      uSheetMix: { value: 0 },
      uRainbow: {
        value: MY_RAINBOW.map((hex) => shaderColor(hex).multiplyScalar(RAINBOW_BRIGHTNESS)),
      },
      uFogColor: { value: shaderColor(SKY_COLOR) },
      uFogDensity: { value: FOG_DENSITY },
    },
    // Both sides, in case the 3D floor tilts a piece away from the camera.
    side: THREE.DoubleSide,
    transparent: ghost,
    depthWrite: !ghost,
    // With a flat floor, the other levels are in the same place as this one.  Draw them on top.
    polygonOffset: ghost,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
}

export type FloorOptions = {
  /** The default is the input's floor, with its cloud, its cut, and its 3D shape. */
  uniforms?: FloorUniforms;
  space?: Space;
  /** The glow around the base of the cloud. */
  glow?: boolean;
  /** Where the labels stand.  The default follows the input's 3D floor. */
  heightAt?: (x: number, z: number) => number;
  /** How far from the middle of the view to put labels, in world units. */
  labelRange?: number;
  /** Don't put labels this close to the branch point, in world units.  They'd be in the cloud. */
  keepClear?: number;
  /** The floor has a hole in the middle this big, in world units.  The cloud covers it. */
  hole?: number;
};

/** The complex plane, drawn on the floor. */
export class Floor {
  /** The camera's own level, plus see-through copies of the levels above it, for log. */
  readonly meshes: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[] = [];
  readonly labels = new THREE.Group();
  private readonly sprites: THREE.Sprite[] = [];
  private readonly spriteMaterials = new Map<string, THREE.SpriteMaterial>();
  private labelKey = "";
  private readonly space: Space;
  private readonly heightAt: (x: number, z: number) => number;
  private readonly labelRange: number;
  private readonly keepClear: number;

  constructor(options: FloorOptions = {}) {
    this.space = options.space ?? view;
    this.heightAt = options.heightAt ?? floorHeight;
    this.labelRange = options.labelRange ?? 160;
    this.keepClear = options.keepClear ?? TAPE_RADIUS + 0.8;
    const geometry = polarGeometry(options.hole ?? 1);
    for (let level = 0; level <= GHOST_LEVELS; level++) {
      const material = floorMaterial(level, options.uniforms ?? floorUniforms, options.glow ?? true);
      const mesh = new THREE.Mesh(geometry, material);
      // The vertex shader moves everything, so three.js can't know where the floor is.
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
    }
  }

  /**
   * The see-through levels above the camera's:  how many to draw (for log, or 1 for the other sheet of
   * √), how solid they are (0 to 1), and where they fade out.
   */
  update(sheetMix: number, levels = { count: 0, fill: 0, fade: [16, 36], base: 0.16 }) {
    const { scale, center } = this.space;
    const { major, minor } = gridSpacing(scale);
    this.meshes.forEach((mesh, level) => {
      const u = mesh.material.uniforms;
      u.uScale.value = scale;
      u.uCenter.value.set(center.re, center.im);
      u.uMajor.value = major;
      u.uMinor.value = minor;
      u.uSheetMix.value = sheetMix;
      u.uGhostFill.value = levels.fill;
      u.uGhostFade.value.set(levels.fade[0], levels.fade[1]);
      u.uGhostBase.value = levels.base;
      mesh.visible = level == 0 || (level <= levels.count && levels.fill > 0);
    });
    const key = `${scale} ${center.re} ${center.im}`;
    if (key != this.labelKey) {
      this.labelKey = key;
      this.updateLabels(scale, major, center);
    }
    // The 3D floor moves up and down, so the labels have to follow it.
    for (const sprite of this.sprites) {
      if (sprite.visible) {
        sprite.position.y = this.heightAt(sprite.position.x, sprite.position.z) + 0.05;
      }
    }
  }

  private updateLabels(scale: number, major: number, center: Complex) {
    const items: LabelInfo[] = [];
    const step = major * scale;
    const decimals = Math.max(0, -Math.floor(Math.log10(major) + 1e-9));
    const reach = this.labelRange / scale;
    /** Labels along one axis, within reach of the middle of the view. */
    const along = (middle: number, add: (value: number, text: string) => void) => {
      const first = Math.ceil((middle - reach) / major);
      const last = Math.floor((middle + reach) / major);
      // Don't make too many.  Skip some if we have to.
      const skip = Math.max(1, Math.ceil((last - first) / 80));
      for (let k = first; k <= last; k += skip) {
        const value = k * major;
        if (k == 0 || Math.abs(value) * scale < this.keepClear) {
          continue;
        }
        add(value, value.toFixed(decimals).replace("-", "−"));
      }
    };
    // Real numbers along the real axis, imaginary numbers along the imaginary axis.
    along(center.re, (value, text) =>
      items.push({ text, x: (value - center.re) * scale, z: center.im * scale, title: false })
    );
    along(center.im, (value, text) => {
      const imaginary = Math.abs(value) == 1 ? (value < 0 ? "−" : "") + I : text + I;
      items.push({ text: imaginary, x: -center.re * scale, z: -(value - center.im) * scale, title: false });
    });
    // Axis names, half way between two numbers so they don't collide.
    const titleSteps = Math.max(2, Math.ceil((this.keepClear + 1.2) / step)) + 0.5;
    const titleRe = Math.round(center.re / major) * major + titleSteps * major;
    const titleIm = Math.round(center.im / major) * major + titleSteps * major;
    items.push({ text: "Re", x: (titleRe - center.re) * scale, z: center.im * scale, title: true });
    items.push({ text: "Im", x: -center.re * scale, z: -(titleIm - center.im) * scale, title: true });

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
