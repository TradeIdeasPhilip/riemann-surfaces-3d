import * as THREE from "three";
import "@fontsource/roboto/latin-500.css";
import "./style.css";
import { BranchPoint, makeBlobShadow } from "./branchPoint";
import { Character, FloatingEye, loadCharacterModel } from "./characters";
import {
  abs,
  arg,
  complex,
  dot,
  format,
  negate,
  type Complex,
} from "./complex";
import { Floor } from "./floor";
import { LOGARITHM, SQUARE_ROOT, type MultiFunction } from "./functions";
import { OFF_SHEET_OPACITY, OFF_SHEET_TRAIL_OPACITY, Trail } from "./trail";
import {
  BLOCK_RADIUS,
  CAMERA_BLOCK_RADIUS,
  floorHeight,
  floorNormal,
  floorUniforms,
  FOG_DENSITY,
  gridSpacing,
  headingToward,
  makeFloorUniforms,
  SKY_COLOR,
  toMath,
  toWorld,
  toWorldIn,
  turnToward,
  view,
  wrapAngle,
  Z_COLOR,
  type Space,
} from "./world";

const WALK_SPEED = 5;
const RUN_SPEED = 11;
const TURN_SPEED = 2.4;
const START_PITCH = 0.34;
const START_DISTANCE = 10;
const LOOK_HEIGHT = 2.3;
const MIN_SCALE = 0.01;
const MAX_SCALE = 5000;
const START_SCALE = 5;
const START_Z = complex(0, -4);

function getById<T extends HTMLElement>(id: string) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing #${id}`);
  }
  return element as T;
}

function sub(a: Complex, b: Complex): Complex {
  return { re: a.re - b.re, im: a.im - b.im };
}

function normalize(z: Complex): Complex {
  const r = abs(z) || 1;
  return { re: z.re / r, im: z.im / r };
}

function polar(r: number, angle: number): Complex {
  return { re: r * Math.cos(angle), im: r * Math.sin(angle) };
}

const TAU = Math.PI * 2;

/** Something that walks around the plane:  z itself, or the floating camera. */
type Body = {
  z: Complex;
  /** One square root of z, tracked continuously as the body moves.  This is which sheet it's on. */
  w: Complex;
  heading: number;
};

/**
 * Where does the segment from a to b first touch the circle of radius r around the origin?
 * Returns a fraction from 0 to 1, or 1 if it never does.  Assumes a is outside the circle.
 */
function segmentEntry(ax: number, az: number, bx: number, bz: number, r: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const a = dx * dx + dz * dz;
  const b = 2 * (ax * dx + az * dz);
  const c = ax * ax + az * az - r * r;
  if (a < 1e-12) {
    return 1;
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant <= 0) {
    return 1;
  }
  const t = (-b - Math.sqrt(discriminant)) / (2 * a);
  return t >= 0 && t <= 1 ? t : 1;
}

/** Does the straight line from a to b pass within r of the origin?  All in math units. */
function segmentNearOrigin(a: Complex, b: Complex, r: number) {
  const d = sub(b, a);
  const lengthSquared = dot(d, d);
  const t =
    lengthSquared > 0 ? Math.max(0, Math.min(1, -dot(a, d) / lengthSquared)) : 0;
  return Math.hypot(a.re + t * d.re, a.im + t * d.im) < r;
}

async function main() {
  //
  // Scene setup
  //
  const canvas = getById<HTMLCanvasElement>("scene");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY_COLOR);
  scene.fog = new THREE.FogExp2(SKY_COLOR, FOG_DENSITY);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2500);

  scene.add(new THREE.HemisphereLight(0xc8d4ff, 0x302838, 1.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-30, 50, 20);
  scene.add(sun);

  const floor = new Floor();
  scene.add(...floor.meshes, floor.labels);

  //
  // The outputs get their own view, on an ordinary flat plane.  Its camera moves itself to keep the
  // outputs in view:  it follows their middle, and zooms to fit them.
  //
  const outputCanvas = getById<HTMLCanvasElement>("outputs");
  const outputRenderer = new THREE.WebGLRenderer({ canvas: outputCanvas, antialias: true });
  outputRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  outputRenderer.toneMapping = THREE.NeutralToneMapping;
  const outputScene = new THREE.Scene();
  outputScene.background = new THREE.Color(SKY_COLOR);
  outputScene.fog = new THREE.FogExp2(SKY_COLOR, FOG_DENSITY * 2);
  outputScene.add(new THREE.HemisphereLight(0xc8d4ff, 0x302838, 1.7));
  const outputSun = new THREE.DirectionalLight(0xffffff, 1.6);
  outputSun.position.set(-30, 50, 20);
  outputScene.add(outputSun);
  const outputCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  // Looking north, like a map:  Re to the right, Im away from you.
  outputCamera.position.set(0, 17, 12);
  outputCamera.lookAt(0, 0, -0.5);
  /** The world shows everything within about this many world units of the center. */
  const OUTPUT_FIT = 6.5;
  const outputSpace: Space = { scale: 4, center: { re: 0, im: 0 } };
  // Flat, and nothing to do with the input's cloud or cut.
  const outputFloorUniforms = makeFloorUniforms();
  const outputFloor = new Floor({
    uniforms: outputFloorUniforms,
    space: outputSpace,
    glow: false,
    heightAt: () => 0,
    labelRange: 20,
    keepClear: 0,
    hole: 0.001,
  });
  outputScene.add(...outputFloor.meshes, outputFloor.labels);

  const branchPoint = new BranchPoint();
  scene.add(branchPoint.group);

  // The nameplates draw with Roboto on a canvas, which won't wait for the font by itself.
  await Promise.all([
    loadCharacterModel("models/RobotExpressive.glb"),
    document.fonts.load("500 46px Roboto").catch(() => undefined),
  ]);

  const zCharacter = new Character(Z_COLOR, "z");
  /** z's shadow on the camera's floor, when z is up on a different sheet.  See dropShadow(). */
  const zDropShadow = makeBlobShadow(0.8, true);
  zDropShadow.visible = false;
  scene.add(zDropShadow);
  const eyeMarker = new FloatingEye();
  eyeMarker.root.visible = false;
  scene.add(zCharacter.root, eyeMarker.root);
  const zTrail = new Trail(Z_COLOR, 0.34, 0.02, { fadeOffSheet: true });
  scene.add(zTrail.mesh);

  /** The robots and trails for one function's outputs. */
  type Cast = { characters: Character[]; trails: Trail[]; previous: Complex[] };
  const casts = new Map<MultiFunction, Cast>();
  /** Each function gets its own set of robots, made the first time we need them. */
  function castFor(f: MultiFunction): Cast {
    let result = casts.get(f);
    if (!result) {
      // The outputs' view is small, so the nameplates need to be bigger to be readable.
      const characters = f.outputColors.map((color) => new Character(color, f.name, 0.11));
      const trails = f.outputColors.map(
        (color, i) =>
          new Trail(color, 0.28, 0.025 + 0.003 * i, {
            uniforms: outputFloorUniforms,
            space: outputSpace,
          })
      );
      for (const character of characters) {
        // Start out facing us.
        character.heading = 0;
      }
      outputScene.add(...characters.map((c) => c.root), ...trails.map((t) => t.mesh));
      result = { characters, trails, previous: [] };
      casts.set(f, result);
    }
    return result;
  }
  let fn: MultiFunction = SQUARE_ROOT;
  let cast = castFor(fn);
  function allTrails() {
    return [zTrail, ...cast.trails];
  }

  // A ring that shows where you clicked.
  const clickRing = new THREE.Mesh(
    new THREE.RingGeometry(0.35, 0.5, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: 0x9dffc8,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    })
  );
  clickRing.position.y = 0.04;
  clickRing.visible = false;
  scene.add(clickRing);
  let clickRingAge = Infinity;

  //
  // State
  //
  const player: Body = {
    z: START_Z,
    w: fn.principal(START_Z),
    heading: Math.PI,
  };
  const eye: Body = { z: START_Z, w: player.w, heading: Math.PI };
  let mode: "walk" | "explore" = "walk";
  let targetScale = START_SCALE;
  view.scale = START_SCALE;
  const cameraRig = {
    /** Camera angle relative to the body's heading.  Drag to change, it relaxes when you walk. */
    yawOffset: 0,
    pitch: START_PITCH,
    distance: START_DISTANCE,
    /** Fraction of the distance actually used.  Less than 1 when the cloud is in the way. */
    pull: 1,
  };
  let sheetMix = 0;

  function activeBody() {
    return mode == "walk" ? player : eye;
  }

  //
  // UI
  //
  const toastElement = getById("toast");
  let toastTimer = 0;
  function toast(message: string, ms = 4500) {
    toastElement.textContent = message;
    toastElement.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastElement.classList.remove("show"), ms);
  }
  let lastBlockedToast = -Infinity;
  let lastZoomToast = -Infinity;

  const walkButton = getById<HTMLButtonElement>("walkMode");
  const exploreButton = getById<HTMLButtonElement>("exploreMode");
  const sheetCheckbox = getById<HTMLInputElement>("sheetColors");
  const liftSlider = getById<HTMLInputElement>("lift");
  /** What to do with z when it's on a different sheet from the camera:  "fade" or "solid". */
  const offSheetSelect = getById<HTMLSelectElement>("offSheet");
  /** Hide the floating eye when a demo puts it somewhere it would just be in the way. */
  let eyeHidden = false;
  const readout = getById("readout");

  function setMode(newMode: "walk" | "explore") {
    if (newMode == mode) {
      return;
    }
    autopilot = undefined;
    if (newMode == "explore") {
      // The floating camera starts just behind z, looking the same way the camera was.
      eye.z = player.z;
      eye.w = player.w;
      eye.heading = player.heading + cameraRig.yawOffset;
      moveBody(eye, -Math.sin(eye.heading) * 1.4, -Math.cos(eye.heading) * 1.4);
    }
    cameraRig.yawOffset = 0;
    cameraRig.pull = 0.2;
    mode = newMode;
    eyeHidden = false;
    walkButton.classList.toggle("active", mode == "walk");
    exploreButton.classList.toggle("active", mode == "explore");
  }
  walkButton.addEventListener("click", () => setMode("walk"));
  exploreButton.addEventListener("click", () => setMode("explore"));

  function clearTrails() {
    for (const trail of allTrails()) {
      trail.clear();
    }
  }
  getById("clearTrails").addEventListener("click", clearTrails);

  const functionButtons = new Map<MultiFunction, HTMLButtonElement>([
    [SQUARE_ROOT, getById<HTMLButtonElement>("functionSqrt")],
    [LOGARITHM, getById<HTMLButtonElement>("functionLog")],
  ]);
  const demoLists = new Map<MultiFunction, HTMLElement>([
    [SQUARE_ROOT, getById("sqrtDemos")],
    [LOGARITHM, getById("logDemos")],
  ]);
  const title = getById("title");
  function setFunction(f: MultiFunction) {
    setMode("walk");
    autopilot = undefined;
    for (const trail of cast.trails) {
      trail.mesh.visible = false;
    }
    for (const character of cast.characters) {
      character.root.visible = false;
    }
    fn = f;
    cast = castFor(fn);
    for (const trail of cast.trails) {
      trail.mesh.visible = true;
    }
    for (const character of cast.characters) {
      character.root.visible = true;
    }
    // Start over on the principal sheet.  The camera is on z's sheet now, since it follows z.
    player.w = fn.principal(player.z);
    cameraW = player.w;
    cast.previous = fn.outputs(player.w);
    snapOutputView = true;
    clearTrails();
    functionButtons.forEach((button, f) => button.classList.toggle("active", f == fn));
    demoLists.forEach((list, f) => (list.hidden = f != fn));
    title.textContent = `${fn.name} Walkabout`;
  }
  functionButtons.forEach((button, f) => button.addEventListener("click", () => setFunction(f)));

  function reset() {
    setMode("walk");
    autopilot = undefined;
    player.z = START_Z;
    player.w = fn.principal(START_Z);
    cast.previous = fn.outputs(player.w);
    snapOutputView = true;
    player.heading = Math.PI;
    view.scale = targetScale = START_SCALE;
    cameraRig.yawOffset = 0;
    cameraRig.pitch = START_PITCH;
    cameraRig.distance = START_DISTANCE;
    clearTrails();
  }
  getById("reset").addEventListener("click", reset);

  // Don't let the buttons keep keyboard focus.  Space and Enter would click them again.
  document.querySelectorAll("button, input").forEach((element) =>
    element.addEventListener("click", () => (element as HTMLElement).blur())
  );
  // A select keeps the arrow keys, which we need for walking.
  offSheetSelect.addEventListener("change", () => offSheetSelect.blur());

  //
  // Movement
  //

  /**
   * Move a body by a step in world units.  The branch point's zone stops you, but you slide along it.
   * Returns true if you were walking more or less straight into the zone.
   */
  function moveBody(body: Body, dx: number, dz: number) {
    const start = toWorld(body.z);
    let x = start.x + dx;
    let z = start.z + dz;
    const r = Math.hypot(x, z);
    let blocked = false;
    if (r < BLOCK_RADIUS) {
      x *= BLOCK_RADIUS / r;
      z *= BLOCK_RADIUS / r;
      const step = Math.hypot(dx, dz);
      blocked = step > 0 && (dx * start.x + dz * start.z) / (step * start.length()) < -0.5;
    }
    body.z = toMath(x, z);
    body.w = fn.continueTo(body.z, body.w);
    return blocked;
  }

  type CameraFraming = { pitch: number; distance: number; yawOffset: number };
  type Autopilot = {
    body: Body;
    /** Move the body for one frame.  Returns its speed in world units per second, or undefined when it's done. */
    step(dt: number): number | undefined;
    onDone?: () => void;
    /** Demos move the camera somewhere with a better view. */
    framing?: CameraFraming;
    /** About how many seconds are left.  For the demo countdown. */
    remaining?(): number;
    /** Demos have a name.  The countdown shows up while a demo is running. */
    title?: string;
  };
  let autopilot: Autopilot | undefined;

  /** Mark an autopilot as a demo, so the countdown shows up while it runs. */
  function asDemo(pilot: Autopilot, title: string) {
    pilot.title = title;
    return pilot;
  }

  /**
   * Turn toward a direction (in math coordinates) and walk.
   * Returns the speed in world units per second.
   */
  function walkToward(body: Body, direction: Complex, topSpeed: number, dt: number) {
    const target = headingToward(direction.re, -direction.im);
    body.heading = turnToward(body.heading, target, 3.5 * dt);
    // Turn in place first if we're facing the wrong way.
    const error = Math.abs(wrapAngle(target - body.heading));
    const speed = topSpeed * Math.max(0, Math.cos(error)) ** 2;
    moveBody(body, Math.sin(body.heading) * speed * dt, Math.cos(body.heading) * speed * dt);
    return speed;
  }

  /**
   * Walk counterclockwise around a circle.  It starts wherever the body is now.
   * The camera rises and looks toward the center of the circle.
   */
  function circleAutopilot(
    body: Body,
    center: Complex,
    radius: number,
    onDone: () => void
  ): Autopilot {
    let lastAngle = arg(sub(body.z, center));
    let swept = 0;
    // Take about 14 seconds no matter how big the circle looks.
    const circumference = Math.PI * 2 * radius * view.scale;
    const speed = THREE.MathUtils.clamp(circumference / 14, 6, 60);
    return {
      body,
      framing: { pitch: 0.75, distance: 24, yawOffset: 1.15 },
      step(dt) {
        const relative = sub(body.z, center);
        const angle = arg(relative);
        swept += wrapAngle(angle - lastAngle);
        lastAngle = angle;
        if (swept >= Math.PI * 2) {
          return undefined;
        }
        const r = abs(relative);
        const out = normalize(relative);
        const error = (r - radius) / radius;
        const direction = { re: -out.im - out.re * error * 4, im: out.re - out.im * error * 4 };
        return walkToward(body, direction, speed, dt);
      },
      remaining: () => (Math.max(0, Math.PI * 2 - swept) * radius * view.scale) / speed,
      onDone,
    };
  }

  /**
   * A growing spiral, centered where the body starts.  The end of each loop lands on the line
   * from the start through the branch point:
   *   1. half way from the start to the cones,
   *   2. just short of the cones,
   *   3. just past the forbidden zone, on the far side of the branch point,
   *   4. the same distance further out again.
   * The first two loops miss the branch point and the last two go around it.
   *
   * This follows the path exactly, rather than steering, so those landmarks come out right.
   *
   * If moveCamera is true, the camera rises and backs away as the spiral grows.
   */
  function spiralAutopilot(body: Body, onDone: () => void, moveCamera = true): Autopilot {
    const scale = view.scale;
    const center = body.z;
    const startDistance = abs(center);
    /** Just outside the cones, in math units. */
    const margin = (BLOCK_RADIUS + 0.4) / scale;
    // Unit vectors toward the branch point, and 90° counterclockwise from that.
    const u = normalize(negate(center));
    const v = { re: -u.im, im: u.re };
    // Distance from the center at the end of each loop.
    const radii = [
      0,
      Math.max(0, (startDistance - margin) / 2),
      Math.max(0, startDistance - margin),
      startDistance + margin,
      startDistance + 3 * margin,
    ];
    const lastTheta = Math.PI * 2 * (radii.length - 1);
    /** Radius and its derivative, as a function of the angle around the center. */
    function radius(theta: number) {
      const loop = Math.min(radii.length - 2, Math.floor(theta / (Math.PI * 2)));
      const growth = (radii[loop + 1] - radii[loop]) / (Math.PI * 2);
      return { r: radii[loop] + growth * (theta - Math.PI * 2 * loop), growth };
    }
    function position(theta: number): Complex {
      const { r } = radius(theta);
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      return {
        re: center.re + r * (c * u.re + s * v.re),
        im: center.im + r * (c * u.im + s * v.im),
      };
    }
    function tangent(theta: number): Complex {
      const { r, growth } = radius(theta);
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      return {
        re: growth * (c * u.re + s * v.re) + r * (-s * u.re + c * v.re),
        im: growth * (c * u.im + s * v.im) + r * (-s * u.im + c * v.im),
      };
    }
    // Pick a speed so the whole thing takes about 36 seconds.
    let length = 0;
    for (let i = 0; i < radii.length - 1; i++) {
      length += Math.PI * (radii[i] + radii[i + 1]) * scale;
    }
    const topSpeed = THREE.MathUtils.clamp(length / 36, 6, 200);
    /** Slow down in the tight curls near the middle.  r is in world units. */
    const speedAt = (r: number) => topSpeed * THREE.MathUtils.clamp(r / 3, 0.3, 1);
    // How long it takes to reach each angle, for the countdown.  Same speed rule as step().
    const samples = 2000;
    const timeAt = [0];
    for (let i = 1; i <= samples; i++) {
      const t = (lastTheta * (i - 0.5)) / samples;
      const worldPerRadian = Math.max(0.5, abs(tangent(t)) * scale);
      timeAt.push(timeAt[i - 1] + ((lastTheta / samples) * worldPerRadian) / speedAt(radius(t).r * scale));
    }
    const framing = { pitch: 0.85, distance: 20, yawOffset: 1.2 };
    let theta = 0;
    return {
      body,
      framing: moveCamera ? framing : undefined,
      step(dt) {
        if (theta >= lastTheta) {
          return undefined;
        }
        const r = radius(theta).r * view.scale;
        const speed = speedAt(r);
        const worldPerRadian = Math.max(0.5, abs(tangent(theta)) * view.scale);
        theta = Math.min(lastTheta, theta + (speed * dt) / worldPerRadian);
        // Aim at the point on the path, not just the next step, so we can't drift off of it.
        const here = toWorld(body.z);
        const there = toWorld(position(theta));
        moveBody(body, there.x - here.x, there.z - here.z);
        const direction = tangent(theta);
        body.heading = turnToward(body.heading, headingToward(direction.re, -direction.im), 10 * dt);
        // Back the camera up as the spiral grows.
        framing.distance = THREE.MathUtils.clamp(18 + r * 0.9, 20, 55);
        return speed;
      },
      remaining: () =>
        timeAt[samples] - timeAt[Math.min(samples, Math.floor((theta / lastTheta) * samples))],
      onDone,
    };
  }

  /** Walk to a point.  If the branch point is in the way, walk around it the short way. */
  function gotoAutopilot(body: Body, target: Complex): Autopilot {
    let side = 0;
    function steer(): Complex | undefined {
      const toTarget = sub(target, body.z);
      if (abs(toTarget) * view.scale < 0.25) {
        return undefined;
      }
      const blockRadius = (BLOCK_RADIUS - 0.1) / view.scale;
      if (!segmentNearOrigin(body.z, target, blockRadius)) {
        return toTarget;
      }
      if (side == 0) {
        side = body.z.re * target.im - body.z.im * target.re >= 0 ? 1 : -1;
      }
      const out = normalize(body.z);
      return { re: -out.im * side + out.re * 0.3, im: out.re * side + out.im * 0.3 };
    }
    return {
      body,
      step(dt) {
        const direction = steer();
        return direction && walkToward(body, direction, WALK_SPEED * 1.4, dt);
      },
      // This ignores walking around the branch point, so it's a little optimistic.
      remaining: () => (abs(sub(target, body.z)) * view.scale) / (WALK_SPEED * 1.4),
    };
  }

  function stepAutopilot(dt: number) {
    const pilot = autopilot!;
    const speed = pilot.step(dt);
    if (speed === undefined) {
      autopilot = undefined;
      pilot.onDone?.();
      return 0;
    }
    return speed;
  }

  const PATH_SAMPLES = 400;
  /** The distance along a path at PATH_SAMPLES + 1 evenly spaced values of u, in world units. */
  function pathDistances(path: (u: number) => Complex, scale = view.scale) {
    const result = [0];
    let previous = path(0);
    for (let i = 1; i <= PATH_SAMPLES; i++) {
      const next = path(i / PATH_SAMPLES);
      result.push(result[i - 1] + abs(sub(next, previous)) * scale);
      previous = next;
    }
    return result;
  }

  /** The length of a path, in world units. */
  function pathLength(path: (u: number) => Complex, scale = view.scale) {
    return pathDistances(path, scale)[PATH_SAMPLES];
  }

  /**
   * Follow a path exactly, at a steady speed in world units per second.
   * path(0) should be where the body is now.  The path is in math coordinates.
   */
  function pathAutopilot(
    body: Body,
    path: (u: number) => Complex,
    speed: number,
    framing?: CameraFraming
  ): Autopilot {
    let u = 0;
    const distances = pathDistances(path);
    const length = distances[PATH_SAMPLES];
    /** How far along the path we are, in world units. */
    const travelled = () => {
      const i = Math.min(PATH_SAMPLES - 1, Math.floor(u * PATH_SAMPLES));
      return distances[i] + (distances[i + 1] - distances[i]) * (u * PATH_SAMPLES - i);
    };
    return {
      body,
      framing,
      step(dt) {
        if (u >= 1) {
          return undefined;
        }
        // How fast does the path move, in world units per unit of u?
        const before = Math.max(0, u - 1e-4);
        const after = Math.min(1, u + 1e-4);
        const direction = sub(path(after), path(before));
        const worldPerU = (abs(direction) * view.scale) / (after - before);
        u = Math.min(1, u + (speed * dt) / Math.max(worldPerU, 1e-6));
        // Aim at the point on the path, not just the next step, so we can't drift off of it.
        const here = toWorld(body.z);
        const there = toWorld(path(u));
        moveBody(body, there.x - here.x, there.z - here.z);
        body.heading = turnToward(body.heading, headingToward(direction.re, -direction.im), 8 * dt);
        return speed;
      },
      remaining: () => (length - travelled()) / speed,
    };
  }

  /**
   * One step of a demo.  start() makes the autopilot when the step starts, so it can start wherever
   * the last step ended.  plan() guesses how long the step takes, and where it ends, so the countdown
   * can count the steps that haven't started yet.
   */
  type Step = {
    start(): Autopilot;
    plan(from: Complex): { seconds: number; end: Complex };
  };

  /** Walk to a point, around the branch point if necessary. */
  function walkTo(body: Body, target: Complex): Step {
    return {
      start: () => gotoAutopilot(body, target),
      // Plus a moment to turn around.
      plan: (from) => ({
        seconds: (abs(sub(target, from)) * view.scale) / (WALK_SPEED * 1.4) + 0.5,
        end: target,
      }),
    };
  }

  /** A straight line from wherever the body is when this step starts. */
  function lineTo(body: Body, to: Complex, speed = 8): Step {
    return {
      start() {
        const from = body.z;
        return pathAutopilot(
          body,
          (u) => ({ re: from.re + (to.re - from.re) * u, im: from.im + (to.im - from.im) * u }),
          speed
        );
      },
      plan: (from) => ({ seconds: (abs(sub(to, from)) * view.scale) / speed, end: to }),
    };
  }

  /**
   * Circle the branch point at a fixed distance, from wherever the body is when this step starts,
   * turning by angle radians.  Positive is counterclockwise.  The camera looks toward the middle.
   */
  function arcAround(body: Body, angle: number, speed: number, followWithCamera = true): Step {
    return {
      start() {
        const r = abs(body.z);
        const start = arg(body.z);
        const framing = followWithCamera
          ? {
              pitch: 0.8,
              distance: THREE.MathUtils.clamp(12 + r * view.scale * 0.9, 20, 45),
              yawOffset: angle > 0 ? 1.15 : -1.15,
            }
          : undefined;
        return pathAutopilot(body, (u) => polar(r, start + angle * u), speed, framing);
      },
      plan: (from) => ({
        seconds: (Math.abs(angle) * abs(from) * view.scale) / speed,
        end: polar(abs(from), arg(from) + angle),
      }),
    };
  }

  /** Stand still for a moment.  update(t) is called every frame, with t in seconds. */
  function pause(body: Body, seconds: number, update?: (t: number) => void): Step {
    return {
      start(): Autopilot {
        let t = 0;
        return {
          body,
          step(dt) {
            t += dt;
            update?.(Math.min(t, seconds));
            return t < seconds ? 0 : undefined;
          },
          remaining: () => Math.max(0, seconds - t),
        };
      },
      plan: (from) => ({ seconds, end: from }),
    };
  }

  /** Do something just before the step starts. */
  function before(setup: () => void, step: Step): Step {
    return {
      start() {
        setup();
        return step.start();
      },
      plan: step.plan,
    };
  }

  /** Move the camera during a step.  camera(t) says where it should be, t seconds into the step. */
  function withCamera(step: Step, camera: (t: number) => CameraFraming): Step {
    return {
      start(): Autopilot {
        const inner = step.start();
        let t = 0;
        return {
          get body() {
            return inner.body;
          },
          get framing() {
            return camera(t);
          },
          step(dt) {
            t += dt;
            return inner.step(dt);
          },
          remaining: () => inner.remaining?.() ?? 0,
        };
      },
      plan: step.plan,
    };
  }

  /** Do one step after another. */
  function sequence(body: Body, steps: Step[], onDone?: () => void): Autopilot {
    // Guess how long each step will take, for the countdown.
    const planned: number[] = [];
    let where = body.z;
    for (const step of steps) {
      const { seconds, end } = step.plan(where);
      planned.push(seconds);
      where = end;
    }
    let index = 0;
    let current = steps[0].start();
    return {
      get body() {
        return current.body;
      },
      onDone,
      get framing() {
        return current.framing;
      },
      remaining() {
        let total = current.remaining?.() ?? planned[index];
        for (let i = index + 1; i < planned.length; i++) {
          total += planned[i];
        }
        return total;
      },
      step(dt) {
        for (;;) {
          const speed = current.step(dt);
          if (speed !== undefined) {
            return speed;
          }
          index++;
          if (index >= steps.length) {
            return undefined;
          }
          current = steps[index].start();
        }
      },
    };
  }

  /**
   * Stand the camera still, looking at target from far away.  For demos where z moves and the
   * camera doesn't.  The camera starts on z's sheet:  we follow the straight line from z to target,
   * so that line must not pass near the branch point.  look is a direction in math coordinates.
   */
  function parkCamera(target: Complex, look: Complex, pitch: number, distance: number) {
    // Switching modes cancels the autopilot, but this might be called from inside one.
    const pilot = autopilot;
    setMode("explore");
    autopilot = pilot;
    eye.z = target;
    eye.w = fn.continueTo(target, player.w);
    eye.heading = headingToward(look.re, -look.im);
    eyeHidden = true;
    cameraRig.yawOffset = 0;
    cameraRig.pitch = pitch;
    cameraRig.distance = distance;
    cameraRig.pull = 1;
  }

  //
  // Demos
  //
  function demoCircle() {
    setMode("walk");
    clearTrails();
    const radius = Math.max(abs(player.z), (BLOCK_RADIUS + 2) / view.scale);
    autopilot = asDemo(
      circleAutopilot(player, complex(0, 0), radius, () =>
        toast(
          "One lap around the branch point. z is back where it started, but the two square roots traded places! Go around again and they trade back.",
          9000
        )
      ),
      "Walk z around the branch point"
    );
  }
  function demoMiss() {
    setMode("walk");
    clearTrails();
    // A circle that passes through z and stays on the far side, away from the branch point.
    const radius = 6 / view.scale;
    const out = normalize(player.z);
    const center = { re: player.z.re + out.re * radius, im: player.z.im + out.im * radius };
    autopilot = asDemo(
      circleAutopilot(player, center, radius, () =>
        toast(
          "That loop didn't go around the branch point, so each square root came back to where it started.",
          8000
        )
      ),
      "Walk a loop that misses it"
    );
  }
  function demoSpiral() {
    setMode("walk");
    clearTrails();
    autopilot = asDemo(
      spiralAutopilot(player, () =>
        toast(
          "The first two loops were too small to go around the branch point, so each square root just traced a little spiral of its own. Once the loops were big enough to go around it, each lap carried the roots half way around.",
          11000
        )
      ),
      "Spiral"
    );
  }
  function demoCamera() {
    setMode("explore");
    sheetCheckbox.checked = true;
    const radius = Math.max(abs(eye.z), (BLOCK_RADIUS + 2) / view.scale);
    autopilot = asDemo(
      circleAutopilot(eye, complex(0, 0), radius, () => {
        const level = zLevel();
        if (fn == LOGARITHM) {
          toast(
            level == 0
              ? "Only the camera moved, and it went around the branch point, so it changed levels. That put it back on z's level: z is solid again."
              : `Only the camera moved, but it went around the branch point, so it moved to a different level of the spiral. z is now ${Math.abs(level)} level${Math.abs(level) == 1 ? "" : "s"} ${level > 0 ? "above" : "below"} the camera's${floorUniforms.uLift.value > 0 && level < 0 ? ", and with the 3D floor it's hidden under your feet" : ""}. The floor's colors moved half way around the rainbow. Go around the other way to get back.`,
            13000
          );
        } else {
          toast(
            level == 0
              ? "Only the camera moved, and it went around the branch point, so it switched sheets. That put it back on z's sheet: z is solid again, and the floor's colors are back where they started."
              : "Only the camera moved, but it went around the branch point, so now it's on the other sheet. The floor's colors flipped, and z isn't on this sheet any more. The square roots don't care: they live on an ordinary plane. Go around again to get back.",
            12000
          );
        }
      }),
      "Walk the camera around it"
    );
  }
  /**
   * The same spiral, but the camera stands still, off to one side, where it can see everything.
   * Each time z crosses the cut, directly behind the cloud, it switches to the other sheet from
   * the camera and fades.  The next time it comes back.
   */
  function demoSpiralStillCamera() {
    clearTrails();
    sheetCheckbox.checked = true;
    const start = player.z;
    const startDistance = abs(start) * view.scale;
    // The camera looks at a point half way between z and the branch point.  Sliding straight
    // toward the branch point doesn't change sheets.
    const fraction = THREE.MathUtils.clamp((BLOCK_RADIUS + 0.5) / startDistance, 0.5, 1);
    // Look from 45° clockwise of straight out.  That puts the cut, directly behind the cloud,
    // away from the spiral's landmarks, which are all on the line through z and the branch point.
    // The camera looks the opposite way, toward the branch point and 45° counterclockwise.
    const out = normalize(start);
    const lookDirection = {
      re: -(out.re + out.im) * Math.SQRT1_2,
      im: -(out.im - out.re) * Math.SQRT1_2,
    };
    // Back up far enough to see the whole spiral.
    const outerRadius = startDistance + 3 * (BLOCK_RADIUS + 0.4);
    parkCamera(
      { re: start.re * fraction, im: start.im * fraction },
      lookDirection,
      0.8,
      THREE.MathUtils.clamp(outerRadius * 2.2, 25, 150)
    );
    autopilot = asDemo(
      spiralAutopilot(
        player,
        () =>
          toast(
            "The camera never moved. The small loops stayed in front of the cloud, so z stayed on the camera's sheet. The first big loop took z behind the cloud, across the cut, onto the other sheet. The next big loop brought it back. The square roots don't care: they live on an ordinary plane.",
            14000
          ),
        false
      ),
      "Spiral, camera standing still"
    );
  }

  //
  // Tours.  Each function has one, with the same four parts:
  //   1. The floor rises from flat into the 3D surface.
  //   2. z walks a path that maps out the surface.  The camera watches from low and off to one side,
  //      and keeps moving slowly, so the layers of grid lines slide past each other.  The camera
  //      stands still otherwise, so where z's trail lands shows the shape of the surface.
  //   3. The camera walks once around the branch point, looking in.
  //   4. The camera settles between two layers of the surface, then turns to look along them.
  //

  /** Tours start just outside the cones.  In world units. */
  const TOUR_INNER = BLOCK_RADIUS + 0.6;
  /** The tour's camera looks at the branch point from this direction:  south, and a little west. */
  const TOUR_CAMERA_ANGLE = -Math.PI / 2 - 0.5;
  /** The tours' paths start a little counterclockwise from the camera. */
  const TOUR_PATH_ANGLE = TOUR_CAMERA_ANGLE + 0.35;

  type CameraPlace = { pitch: number; distance: number };
  type TourOptions = {
    /** z's path, in math coordinates, at the standard zoom.  path(0) is where z starts. */
    path: (u: number) => Complex;
    /** How fast z walks, in world units per second. */
    speed: number;
    /** How high the 3D floor slider goes, 0 to 1. */
    lift: number;
    /** While z walks, the camera drifts from high to low, then keeps swaying. */
    high: CameraPlace;
    low: CameraPlace;
    /** The camera walks around the branch point:  1 for counterclockwise, -1 for clockwise. */
    orbitDirection: 1 | -1;
    orbit: CameraPlace;
    /** Where the camera ends up. */
    between: CameraPlace;
    /** At the end, the camera turns this far, in radians, to look along the surface.  Positive is left. */
    endTurn: number;
    title: string;
    message: string;
  };

  function tour(options: TourOptions) {
    const { path, speed, high, low, orbit, between, orbitDirection } = options;
    const scale = START_SCALE;
    const orbitSeconds = 12;
    const endSeconds = 11;
    const smooth = THREE.MathUtils.smootherstep;
    /** Looking in toward the branch point, while walking around it. */
    const lookIn = (orbitDirection * Math.PI) / 2;

    const setup = () => {
      setMode("walk");
      view.scale = targetScale = scale;
      clearTrails();
      sheetCheckbox.checked = true;
      // The tour is all about where z and its trail are in 3D, so keep them solid on every sheet.
      offSheetSelect.value = "solid";
      // Start flat.
      liftSlider.value = "0";
      floorUniforms.uLift.value = 0;
      player.z = path(0);
      player.w = fn.principal(player.z);
      const direction = sub(path(0.001), path(0));
      player.heading = headingToward(direction.re, -direction.im);
      cast.previous = fn.outputs(player.w);
      snapOutputView = true;
      parkCamera(
        polar(TOUR_INNER / scale, TOUR_CAMERA_ANGLE),
        polar(1, TOUR_CAMERA_ANGLE + Math.PI),
        high.pitch,
        high.distance
      );
    };

    /** The camera walks once around the branch point. */
    const walkAround: Step = {
      start() {
        const r = abs(eye.z);
        const start = arg(eye.z);
        // Face along the circle, without moving the camera.
        const tangent = headingToward(
          -orbitDirection * Math.sin(start),
          -orbitDirection * Math.cos(start)
        );
        cameraRig.yawOffset = wrapAngle(cameraRig.yawOffset + eye.heading - tangent);
        eye.heading = tangent;
        return pathAutopilot(
          eye,
          (u) => polar(r, start + orbitDirection * TAU * u),
          (TAU * r * view.scale) / orbitSeconds
        );
      },
      plan: (from) => ({ seconds: orbitSeconds, end: from }),
    };

    autopilot = asDemo(
      sequence(
        player,
        [
          // 1. The floor rises in half a second.
          before(
            setup,
            pause(player, 1.2, (t) => (liftSlider.value = String(options.lift * smooth(t, 0, 0.5))))
          ),
          // 2. z walks.  The camera drifts from the higher angle to the lower one, then keeps swaying.
          withCamera(
            {
              start: () => pathAutopilot(player, path, speed),
              plan: () => ({ seconds: pathLength(path, scale) / speed, end: path(1) }),
            },
            (t) => ({
              pitch:
                high.pitch +
                (low.pitch - high.pitch) * smooth(t, 0, 2) +
                (0.1 * (1 - Math.cos((Math.max(0, t - 2) * TAU) / 14))) / 2,
              distance: high.distance + (low.distance - high.distance) * smooth(t, 0, 2),
              yawOffset: 0.3 * Math.sin((t * TAU) / 20),
            })
          ),
          // 3. The camera walks around the branch point, looking in.
          withCamera(walkAround, () => ({ ...orbit, yawOffset: lookIn })),
          // 4. Down between two layers, looking at where they meet behind the cloud.  Then turn to
          // look along them.
          withCamera(pause(eye, endSeconds), (t) => {
            const down = smooth(t, 0, 3);
            return {
              pitch: orbit.pitch + (between.pitch - orbit.pitch) * down,
              distance: orbit.distance + (between.distance - orbit.distance) * down,
              yawOffset: lookIn + options.endTurn * smooth(t, 4, endSeconds),
            };
          }),
        ],
        () => toast(options.message, 14000)
      ),
      options.title
    );
  }

  /**
   * A tour of the whole √z surface.  z walks a tight spiral around the branch point.  Each lap lands
   * on the other sheet, so the trail maps out both of them.  Then the camera walks around the branch
   * point, which puts it on the other sheet, so the two sheets trade places.
   */
  function demoSurfaceTour() {
    const spacing = 2.4;
    const laps = 5;
    tour({
      path: (u) => {
        const theta = u * laps * TAU;
        return polar((TOUR_INNER + (spacing * theta) / TAU) / START_SCALE, TOUR_PATH_ANGLE + theta);
      },
      speed: 15,
      lift: 0.5,
      high: { pitch: 0.45, distance: 28 },
      low: { pitch: 0.22, distance: 28 },
      orbitDirection: 1,
      orbit: { pitch: 0.38, distance: 30 },
      between: { pitch: 0.03, distance: 11 },
      // Turn right, toward z.
      endTurn: -1.75,
      title: "Surface tour (3D)",
      message:
        "That's the whole surface for √z: two sheets that only cross behind the cloud. Each lap of the spiral went around the branch point, so it landed on the other sheet. Then the camera went around, so the sheets traded places. Now you're between them. Drag to look around.",
    });
  }

  /**
   * A tour of the log surface:  the parking garage.  z walks up three levels, spiraling outward, then
   * turns around and walks back down, still spiraling outward.  So the way down never covers the way
   * up, and every level gets two rings.  Then the camera walks clockwise around the branch point,
   * which takes it down one level, so the whole garage seems to rise.  That leaves z one level up.
   */
  function demoLogTour() {
    const levels = 3;
    const laps = 2 * levels;
    const spacing = 1.2;
    tour({
      path: (u) => {
        const lap = u * laps;
        // Counterclockwise, up, for the first half.  Then clockwise, back down.
        const turns = lap <= levels ? lap : laps - lap;
        return polar((TOUR_INNER + spacing * lap) / START_SCALE, TOUR_PATH_ANGLE + TAU * turns);
      },
      speed: 15,
      lift: 0.6,
      // The garage is tall, so stand back.
      high: { pitch: 0.45, distance: 40 },
      low: { pitch: 0.22, distance: 40 },
      orbitDirection: -1,
      orbit: { pitch: 0.4, distance: 34 },
      // Far enough back to see z on the level above.
      between: { pitch: 0.03, distance: 18 },
      // Turn right, toward z.
      endTurn: -0.7,
      title: "Surface tour (3D)",
      message:
        "That's the parking garage for log z. Each lap around the branch point took z up a level, or back down. The way down was farther out than the way up, so every level got two rings. Then the camera walked clockwise around the branch point, which took it down a level, so z ended up on the level above you. Drag to look around.",
    });
  }
  getById("demoCircle").addEventListener("click", demoCircle);
  getById("demoMiss").addEventListener("click", demoMiss);
  getById("demoSpiral").addEventListener("click", demoSpiral);
  getById("demoCamera").addEventListener("click", demoCamera);
  getById("demoSpiralStill").addEventListener("click", demoSpiralStillCamera);
  getById("demoSurfaceTour").addEventListener("click", demoSurfaceTour);

  //
  // Log demos
  //

  /** Log demos use absolute positions, like z = 2, so they start at the standard zoom. */
  function startLogDemo() {
    clearTrails();
    view.scale = targetScale = START_SCALE;
  }

  /**
   * From the 2D version:  circles of radius 2, 4, and 6.
   * Distance from the branch point becomes the real part, and the angle becomes the imaginary part.
   */
  function demoLogCircles() {
    setMode("walk");
    startLogDemo();
    autopilot = asDemo(
      sequence(
        player,
        [
          walkTo(player, complex(2, 0)),
          arcAround(player, TAU, 9),
          lineTo(player, complex(4, 0)),
          arcAround(player, TAU, 12),
          lineTo(player, complex(6, 0)),
          arcAround(player, -TAU, 15),
        ],
        () =>
          toast(
            "Each counterclockwise lap moved every value of log z up by 2π𝒾, and the clockwise lap moved them back down. Walking out from 2 to 4 to 6 moved them to the right, to ln 2, ln 4, and ln 6. Log turns polar coordinates into rectangular ones: the distance becomes the real part, and the angle becomes the imaginary part.",
            14000
          )
      ),
      "Circles at 2, 4, and 6"
    );
  }

  /**
   * From the 2D version:  walk straight at the branch point.  It keeps zooming in so z can keep going.
   * ln|z| heads toward -∞, so every value of log z races off together.
   */
  function demoLogApproach() {
    setMode("walk");
    startLogDemo();
    const angle = Math.PI / 2;
    const duration = 10;
    const endLn = -5;
    const approach: Step = {
      start(): Autopilot {
        const startLn = Math.log(abs(player.z));
        let t = 0;
        return {
          body: player,
          // Look across z's path, so we can see the values of log z run away.
          framing: { pitch: 0.75, distance: 30, yawOffset: -Math.PI / 2 },
          step(dt) {
            if (t >= 1) {
              return undefined;
            }
            t = Math.min(1, t + dt / duration);
            const r = Math.exp(startLn + (endLn - startLn) * t);
            // Zoom in just enough to keep z outside the forbidden zone.
            view.scale = targetScale = Math.max(START_SCALE, (BLOCK_RADIUS + 2) / r);
            player.z = polar(r, angle);
            player.w = fn.continueTo(player.z, player.w);
            player.heading = turnToward(
              player.heading,
              headingToward(-Math.cos(angle), Math.sin(angle)),
              6 * dt
            );
            // Once the zoom takes over, z walks in place while the plane rushes past.
            return 4;
          },
          remaining: () => (1 - t) * duration,
        };
      },
      plan: () => ({ seconds: duration, end: polar(Math.exp(endLn), angle) }),
    };
    autopilot = asDemo(
      sequence(player, [walkTo(player, polar(Math.E, angle)), approach], () =>
        toast(
          "As z gets closer to the branch point, ln|z| heads to −∞, so every value of log z races off in the same direction. In complex analysis there's only one infinity, so if z could reach the branch point, all of the values would be the same: ∞. Scroll to zoom back out, or press Reset.",
          14000
        )
      ),
      "Walk toward the branch point"
    );
  }

  /**
   * New:  z walks a logarithmic spiral, and every value of log z walks a straight line.
   * The camera stands still, so z climbs the camera's spiral staircase as it goes.
   */
  function demoLogSpiral() {
    setMode("walk");
    startLogDemo();
    const r0 = 1;
    const r1 = 8;
    const turns = 2;
    const growth = Math.log(r1 / r0) / (TAU * turns);
    const speed = 12;
    const path = (u: number) => {
      const theta = u * turns * TAU;
      return polar(r0 * Math.exp(growth * theta), theta);
    };
    autopilot = asDemo(
      sequence(
        player,
        [
          walkTo(player, complex(r0, 0)),
          before(
            () => {
              // Look down from high above, to the south.
              parkCamera(complex(0.8, -1.5), complex(0, 1), 0.95, 85);
              clearTrails();
            },
            {
              start: () => pathAutopilot(player, path, speed),
              plan: () => ({ seconds: pathLength(path) / speed, end: path(1) }),
            }
          ),
        ],
        () =>
          toast(
            `z walked a logarithmic spiral, but every value of log z walked a perfectly straight line. Each lap multiplied z's distance by ${Math.exp(growth * TAU).toFixed(2)}, which always adds the same amount to the real part, while the angle adds 2π to the imaginary part. Each lap behind the cloud also took z up a level from the camera's.`,
            15000
          )
      ),
      "Spiral in, straight out"
    );
  }

  /**
   * New:  z walks around a slice of pizza, with two straight sides pointing at the branch point
   * and two curved sides around it.  Every value of log z walks a rectangle.
   */
  function demoLogRectangle() {
    setMode("walk");
    startLogDemo();
    const inner = 2.5;
    const outer = 9;
    const half = (75 * Math.PI) / 180;
    autopilot = asDemo(
      sequence(
        player,
        [
          walkTo(player, polar(inner, -half)),
          before(() => {
            parkCamera(complex(6, 0), complex(-1, 0), 1.0, 90);
            clearTrails();
          }, lineTo(player, polar(outer, -half), 10)),
          arcAround(player, 2 * half, 10, false),
          lineTo(player, polar(inner, half), 10),
          arcAround(player, -2 * half, 10, false),
        ],
        () =>
          toast(
            "A slice of pizza became a rectangle! The straight sides, pointing at the branch point, became lines parallel to the real axis. The curved sides, around the branch point, became lines parallel to the imaginary axis. And the corners stayed square: log preserves angles.",
            14000
          )
      ),
      "Pizza slice to rectangle"
    );
  }

  /**
   * New:  the parking garage.  The camera stays on the ground floor while z walks up two levels and
   * back down.  This needs the 3D floor, so it turns that on.
   */
  function demoLogGarage() {
    setMode("walk");
    startLogDemo();
    sheetCheckbox.checked = true;
    if (Number(liftSlider.value) < 0.8) {
      liftSlider.value = "0.8";
    }
    const radius = 3;
    autopilot = asDemo(
      sequence(
        player,
        [
          walkTo(player, polar(radius, -Math.PI / 2)),
          before(() => {
            // Low, and off to the side, so you can see the levels stacked up.
            parkCamera(player.z, normalize(complex(-0.6, 1)), 0.28, 42);
            clearTrails();
          }, arcAround(player, TAU, 12, false)),
          arcAround(player, TAU, 12, false),
          pause(player, 1.5),
          arcAround(player, -TAU, 12, false),
          arcAround(player, -TAU, 12, false),
        ],
        () =>
          toast(
            "A spiral staircase! Each counterclockwise lap climbed one level, and each clockwise lap came back down one. The camera stayed on the ground floor while z went up and down. The levels connect behind the cloud, where you can't see the seam.",
            14000
          )
      ),
      "Parking garage (3D)"
    );
  }

  getById("demoLogCircles").addEventListener("click", demoLogCircles);
  getById("demoLogApproach").addEventListener("click", demoLogApproach);
  getById("demoLogSpiral").addEventListener("click", demoLogSpiral);
  getById("demoLogRectangle").addEventListener("click", demoLogRectangle);
  getById("demoLogGarage").addEventListener("click", demoLogGarage);
  getById("demoLogCamera").addEventListener("click", demoCamera);
  getById("demoLogTour").addEventListener("click", demoLogTour);

  //
  // Keyboard
  //
  const keys = new Set<string>();
  window.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.code == "KeyC" || event.code == "Tab") {
      event.preventDefault();
      if (!event.repeat) {
        setMode(mode == "walk" ? "explore" : "walk");
      }
      return;
    }
    if (event.code == "Escape") {
      autopilot = undefined;
    }
    if (event.code.startsWith("Arrow") || event.code == "Space") {
      event.preventDefault();
    }
    keys.add(event.code);
  });
  window.addEventListener("keyup", (event) => keys.delete(event.code));
  window.addEventListener("blur", () => keys.clear());

  function readKeys() {
    const any = (...codes: string[]) => codes.some((code) => keys.has(code));
    return {
      forward: (any("KeyW", "ArrowUp") ? 1 : 0) - (any("KeyS", "ArrowDown") ? 1 : 0),
      turn: (any("KeyA", "ArrowLeft") ? 1 : 0) - (any("KeyD", "ArrowRight") ? 1 : 0),
      strafe: (any("KeyE") ? 1 : 0) - (any("KeyQ") ? 1 : 0),
      run: any("ShiftLeft", "ShiftRight"),
    };
  }

  //
  // Mouse
  //
  let pointer:
    | { id: number; button: number; startX: number; startY: number; x: number; y: number; dragging: boolean }
    | undefined;
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointer = {
      id: event.pointerId,
      button: event.button,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      dragging: false,
    };
    if (event.button == 2) {
      // Right drag steers, WoW style.  The body turns to face where the camera is looking.
      const body = activeBody();
      body.heading += cameraRig.yawOffset;
      cameraRig.yawOffset = 0;
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!pointer || pointer.id != event.pointerId) {
      return;
    }
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (
      !pointer.dragging &&
      Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 5
    ) {
      pointer.dragging = true;
      canvas.classList.add("dragging");
    }
    if (pointer.dragging) {
      if (pointer.button == 2) {
        activeBody().heading -= dx * 0.005;
      } else {
        cameraRig.yawOffset = wrapAngle(cameraRig.yawOffset - dx * 0.005);
      }
      cameraRig.pitch = THREE.MathUtils.clamp(cameraRig.pitch + dy * 0.004, 0.05, 1.45);
    }
  });
  function endPointer(event: PointerEvent) {
    if (!pointer || pointer.id != event.pointerId) {
      return;
    }
    if (!pointer.dragging && pointer.button == 0) {
      clickToMove(event.clientX, event.clientY);
    }
    pointer = undefined;
    canvas.classList.remove("dragging");
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", () => {
    pointer = undefined;
    canvas.classList.remove("dragging");
  });

  const raycaster = new THREE.Raycaster();
  function clickToMove(clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1
      ),
      camera
    );
    // Find where the click hits the floor.  The 3D floor isn't flat, so start with the plane
    // y = 0, then slide the plane up or down to the floor's height there, and repeat.
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let hit: THREE.Vector3 | null = null;
    for (let i = 0; i < 6; i++) {
      hit = raycaster.ray.intersectPlane(floorPlane, new THREE.Vector3());
      if (!hit) {
        return;
      }
      floorPlane.constant = -floorHeight(hit.x, hit.z);
    }
    if (!hit) {
      return;
    }
    const r = Math.hypot(hit.x, hit.z);
    const minimum = BLOCK_RADIUS + 0.3;
    if (r < minimum) {
      hit.multiplyScalar(minimum / r);
    }
    clickRing.position.set(hit.x, 0.04, hit.z);
    clickRingAge = 0;
    autopilot = gotoAutopilot(activeBody(), toMath(hit.x, hit.z));
  }

  //
  // Zoom.  This changes the scale of the complex plane, not the camera.
  //
  function minimumScale() {
    let result = BLOCK_RADIUS / abs(player.z);
    if (mode == "explore") {
      result = Math.max(result, BLOCK_RADIUS / abs(eye.z));
    }
    return Math.max(result, MIN_SCALE);
  }
  function zoomBy(factor: number) {
    const minimum = minimumScale();
    let wanted = targetScale * factor;
    if (wanted < minimum) {
      wanted = minimum;
      if (factor < 1 && time - lastZoomToast > 3) {
        lastZoomToast = time;
        toast(
          mode == "explore" && BLOCK_RADIUS / abs(eye.z) >= BLOCK_RADIUS / abs(player.z)
            ? "Can't zoom out any more: the branch point's zone would swallow the camera."
            : "Can't zoom out any more: the branch point's zone would swallow z."
        );
      }
    }
    targetScale = Math.min(MAX_SCALE, wanted);
  }
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode == 1 ? 16 : 1);
      if (event.shiftKey) {
        cameraRig.distance = THREE.MathUtils.clamp(
          cameraRig.distance * Math.exp(delta * 0.001),
          4,
          60
        );
      } else {
        zoomBy(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015)));
      }
    },
    { passive: false }
  );
  window.addEventListener("keydown", (event) => {
    if (event.code == "Equal" || event.code == "NumpadAdd") {
      zoomBy(1.25);
    } else if (event.code == "Minus" || event.code == "NumpadSubtract") {
      zoomBy(0.8);
    }
  });

  function updateScale(dt: number) {
    targetScale = Math.max(targetScale, minimumScale());
    const ratio = targetScale / view.scale;
    if (Math.abs(Math.log(ratio)) < 1e-5) {
      view.scale = targetScale;
    } else {
      view.scale *= Math.pow(ratio, 1 - Math.exp(-dt * 10));
    }
  }

  //
  // Sheets
  //

  /**
   * The camera is attached to its subject by a stick that never passes through the branch point.
   * So the camera is on the same sheet as its subject.  The floor shows the branch of the function
   * that agrees with the camera, and its cut is the ray directly behind the branch point, hidden by
   * the cloud.  This is the function's value at the camera, on the camera's sheet.
   */
  function cameraValue() {
    const cameraZ = toMath(camera.position.x, camera.position.z);
    return fn.continueTo(cameraZ, activeBody().w);
  }
  let cameraW = player.w;
  /**
   * z lives on the Riemann surface.  player.w (the red robot) says where:  it's continued along
   * z's path.  This says how many sheets (or levels, for log) z is above the camera's.
   * The outputs live on an ordinary plane, so they're always visible.
   */
  function zLevel() {
    return fn.levels(player.w, fn.continueTo(player.z, cameraW));
  }
  function zOnCameraSheet() {
    return zLevel() == 0;
  }

  //
  // Camera
  //
  function updateCamera(dt: number) {
    const body = activeBody();
    const focus = toWorld(body.z, LOOK_HEIGHT);
    const yaw = body.heading + cameraRig.yawOffset;
    const horizontal = Math.cos(cameraRig.pitch) * cameraRig.distance;
    const desired = new THREE.Vector3(
      focus.x - Math.sin(yaw) * horizontal,
      focus.y + Math.sin(cameraRig.pitch) * cameraRig.distance,
      focus.z - Math.cos(yaw) * horizontal
    );
    // Don't let the camera into the forbidden zone.  Pull it in toward its subject instead.
    const hit = segmentEntry(focus.x, focus.z, desired.x, desired.z, CAMERA_BLOCK_RADIUS);
    const wanted = hit < 1 ? Math.max(0.04, hit - 0.02) : 1;
    cameraRig.pull = wanted < cameraRig.pull ? wanted : Math.min(wanted, cameraRig.pull + dt * 1.5);
    camera.position.lerpVectors(focus, desired, cameraRig.pull);
    // Don't let the 3D floor come up through the camera.
    camera.position.y = Math.max(
      camera.position.y,
      floorHeight(camera.position.x, camera.position.z) + 0.6
    );
    camera.lookAt(focus);
  }

  /**
   * When z is solid, on a sheet above the camera's, it throws a shadow straight down onto the camera's
   * floor, like the floating eye does.  The farther the shadow falls, the bigger and fainter it gets.
   */
  function dropShadow(zSheet: number, solid: boolean) {
    const { x, y, z } = zCharacter.root.position;
    const floorY = floorHeight(x, z, 0);
    const fall = y - floorY;
    zDropShadow.visible = solid && zSheet > 0 && fall > 0.1;
    if (!zDropShadow.visible) {
      return;
    }
    zDropShadow.position.set(x, floorY + 0.03, z);
    zDropShadow.quaternion.setFromUnitVectors(up, floorNormal(x, z, 0, shadowNormal));
    zDropShadow.scale.setScalar(1 + fall * 0.06);
    zDropShadow.material.opacity = THREE.MathUtils.clamp(1.15 - fall * 0.04, 0.55, 1);
  }

  /** Put something on the floor, and tilt its shadow to match the floor. */
  const shadowNormal = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  function standOnFloor(root: THREE.Object3D, shadow: THREE.Object3D, level = 0) {
    const { x, z } = root.position;
    root.position.y = floorHeight(x, z, level);
    floorNormal(x, z, level, shadowNormal).applyAxisAngle(up, -root.rotation.y);
    shadow.quaternion.setFromUnitVectors(up, shadowNormal);
  }

  /**
   * Tell the floor shaders and floorHeight() where the camera is and which sheet it's on.
   * Everything that sits on the floor needs this before it can find its height.
   */
  function updateFloorShape(dt: number) {
    const u = floorUniforms;
    const focus = activeBody().w;
    u.uFunction.value = fn.shaderId;
    u.uCameraAngle.value = Math.atan2(-camera.position.z, camera.position.x);
    u.uCameraTotal.value = fn.total(cameraW);
    u.uRelAngle.value = fn.relative(focus, cameraW);
    const wanted = Number(liftSlider.value) * fn.maxLift;
    const lift = u.uLift.value + (wanted - u.uLift.value) * (1 - Math.exp(-dt * 6));
    u.uLift.value = Math.abs(lift - wanted) < 1e-4 ? wanted : lift;
  }

  //
  // Demo countdown.  So you can tell a demo that's still running from one that's finished.
  //
  const demoStatus = getById("demoStatus");
  const demoName = getById("demoName");
  const demoTime = getById("demoTime");
  const demoBar = getById("demoBar");
  getById("demoStop").addEventListener("click", () => (autopilot = undefined));
  let shownDemo: Autopilot | undefined;
  /** The longest the current demo has had left.  For the progress bar. */
  let demoTotal = 0;
  function updateDemoStatus() {
    const demo = autopilot?.title ? autopilot : undefined;
    demoStatus.hidden = !demo;
    if (!demo) {
      shownDemo = undefined;
      return;
    }
    const remaining = Math.max(0, demo.remaining?.() ?? 0);
    if (demo != shownDemo) {
      shownDemo = demo;
      demoTotal = 0;
      demoName.textContent = demo.title!;
    }
    // The remaining time is only an estimate.  Don't let the bar go backwards.
    demoTotal = Math.max(demoTotal, remaining);
    const seconds = Math.ceil(remaining);
    demoTime.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} left`;
    demoBar.style.width = `${(100 * (1 - remaining / Math.max(demoTotal, 1e-6))).toFixed(1)}%`;
  }

  //
  // Readout
  //
  let lastReadout = -Infinity;
  function updateReadout() {
    if (time - lastReadout < 0.1) {
      return;
    }
    lastReadout = time;
    const chip = (color: number) =>
      `<span class="chip" style="background:#${color.toString(16).padStart(6, "0")}"></span>`;
    const outputs = fn.outputs(player.w);
    const rows = outputs
      .map((w, i) => `<tr><td>${chip(fn.outputColors[i])}${fn.name}</td><td>${format(w)}</td></tr>`)
      .join("");
    const { major } = gridSpacing(view.scale);
    const level = zLevel();
    let where: string;
    if (level == 0) {
      where = fn == LOGARITHM ? "z is on the camera's level" : "z is on the camera's sheet";
    } else if (fn == LOGARITHM) {
      const count = Math.abs(level) == 1 ? "1 level" : `${Math.abs(level)} levels`;
      where = `z is ${count} ${level > 0 ? "above" : "below"} the camera's`;
    } else {
      where = "z is on the other sheet";
    }
    if (level != 0 && offSheetSelect.value == "fade") {
      where += ", so it's faded";
    }
    readout.innerHTML = `
      <table>
        <tr><td>${chip(Z_COLOR)}z</td><td>${format(player.z)}</td></tr>
        ${rows}
      </table>
      <div class="small">
        ${where}<br>
        Grid lines every ${+major.toPrecision(6)} · zone radius ${(BLOCK_RADIUS / view.scale).toPrecision(3)}
        ${mode == "explore" ? "<br>Moving the camera only. z stays put." : ""}
      </div>`;
  }

  //
  // Main loop
  //
  const timer = new THREE.Timer();
  let time = 0;

  /** The page layout decides how big each canvas is.  Keep the renderer and camera in sync with that. */
  const rendererSize = new THREE.Vector2();
  function fitToCanvas(r: THREE.WebGLRenderer, c: THREE.PerspectiveCamera) {
    const width = r.domElement.clientWidth;
    const height = r.domElement.clientHeight;
    if (width == 0 || height == 0) {
      return;
    }
    r.getSize(rendererSize);
    if (rendererSize.x != width || rendererSize.y != height) {
      r.setSize(width, height, false);
      c.aspect = width / height;
      c.updateProjectionMatrix();
    }
  }

  /** Jump straight to the right framing, instead of easing into it.  For a fresh start. */
  let snapOutputView = true;
  /** Keep the outputs in view:  follow their middle, and zoom to fit them. */
  function frameOutputs(outputs: Complex[], dt: number) {
    const framed = fn.framed.map((i) => outputs[i]);
    const middle = { re: 0, im: 0 };
    for (const w of framed) {
      middle.re += w.re / framed.length;
      middle.im += w.im / framed.length;
    }
    let extent = 0;
    for (const w of framed) {
      extent = Math.max(extent, abs(sub(w, middle)));
    }
    const wanted = THREE.MathUtils.clamp(OUTPUT_FIT / Math.max(extent * 1.15, 0.5), 0.02, 200);
    const k = snapOutputView ? 1 : 1 - Math.exp(-dt * 3);
    snapOutputView = false;
    const center = outputSpace.center;
    outputSpace.center = {
      re: center.re + (middle.re - center.re) * k,
      im: center.im + (middle.im - center.im) * k,
    };
    outputSpace.scale *= Math.pow(wanted / outputSpace.scale, k);
  }

  function maybeAddToTrail(trail: Trail, z: Complex, w: Complex | undefined, scale: number) {
    const last = trail.last;
    if (!last || abs(sub(z, last)) * scale > 0.12) {
      trail.add(z, w);
    }
  }

  /** Face the direction an output is moving.  Returns its speed in world units per second. */
  function steerRoot(character: Character, step: Complex, dt: number) {
    const speed = (abs(step) * outputSpace.scale) / dt;
    if (speed > 0.1) {
      const target = headingToward(step.re, -step.im);
      character.heading = turnToward(character.heading, target, 10 * dt);
    }
    return speed;
  }

  function frame(timestamp: number) {
    timer.update(timestamp);
    const dt = Math.min(timer.getDelta(), 0.05);
    time += dt;
    fitToCanvas(renderer, camera);
    fitToCanvas(outputRenderer, outputCamera);
    updateScale(dt);

    // Move z or the floating camera.
    const input = readKeys();
    const body = activeBody();
    const manual = input.forward != 0 || input.turn != 0 || input.strafe != 0;
    if (manual) {
      autopilot = undefined;
      eyeHidden = false;
    }
    // Usually whoever you're controlling, but a demo can move z while the camera stands still.
    const moving = autopilot?.body ?? body;
    let speed = 0;
    let blocked = false;
    if (autopilot) {
      speed = stepAutopilot(dt);
    } else if (manual) {
      body.heading += input.turn * TURN_SPEED * dt;
      const topSpeed = input.run ? RUN_SPEED : WALK_SPEED;
      let forward = input.forward < 0 ? -0.6 : input.forward;
      let strafe = input.strafe;
      const length = Math.hypot(forward, strafe);
      if (length > 1) {
        forward /= length;
        strafe /= length;
      }
      const sin = Math.sin(body.heading);
      const cos = Math.cos(body.heading);
      const dx = (sin * forward - cos * strafe) * topSpeed * dt;
      const dz = (cos * forward + sin * strafe) * topSpeed * dt;
      if (dx != 0 || dz != 0) {
        blocked = moveBody(body, dx, dz);
        speed = Math.hypot(forward, strafe) * topSpeed;
      }
    }
    const framing = autopilot?.framing;
    if (framing && !pointer?.dragging) {
      const k = 1 - Math.exp(-dt * 2.5);
      cameraRig.pitch += (framing.pitch - cameraRig.pitch) * k;
      cameraRig.distance += (framing.distance - cameraRig.distance) * k;
      cameraRig.yawOffset += wrapAngle(framing.yawOffset - cameraRig.yawOffset) * k;
    } else if (manual && !pointer?.dragging) {
      // Swing the camera back behind you as you walk.
      cameraRig.yawOffset *= Math.exp(-dt * 2.5);
    }
    if (blocked && time - lastBlockedToast > 5) {
      lastBlockedToast = time;
      toast(
        "🚧 That's the branch point. Scroll or pinch to zoom in: the zone stays the same size on screen, so more of the plane opens up."
      );
      if (mode == "walk") {
        zCharacter.emote("No");
      }
    }

    // The outputs follow z continuously.  This is analytic continuation, one small step at a time.
    player.w = fn.continueTo(player.z, player.w);
    const outputs = fn.outputs(player.w);

    // Characters
    toWorld(player.z, 0, zCharacter.root.position);
    zCharacter.heading = player.heading;
    zCharacter.animate(dt, moving == player ? speed : 0);
    zCharacter.nameplate.setValue(format(player.z));

    // The outputs, in their own view, on a flat floor.
    frameOutputs(outputs, dt);
    cast.characters.forEach((character, i) => {
      const w = outputs[i];
      toWorldIn(outputSpace, w, 0, character.root.position);
      const step = sub(w, cast.previous[i] ?? w);
      character.animate(dt, steerRoot(character, step, dt));
      character.nameplate.setValue(format(w));
      maybeAddToTrail(cast.trails[i], w, undefined, outputSpace.scale);
    });
    cast.previous = outputs;
    outputFloor.update(0);

    toWorld(eye.z, 0, eyeMarker.root.position);
    eyeMarker.heading = eye.heading;
    eyeMarker.animate(time);
    eyeMarker.root.visible = mode == "explore" && !eyeHidden;

    maybeAddToTrail(zTrail, player.z, player.w, view.scale);
    for (const trail of allTrails()) {
      trail.update();
    }

    clickRingAge += dt;
    clickRing.visible = clickRingAge < 0.7;
    if (clickRing.visible) {
      clickRing.scale.setScalar(1.4 - clickRingAge);
      clickRing.material.opacity = 1 - clickRingAge / 0.7;
    }

    updateCamera(dt);
    cameraW = cameraValue();
    updateFloorShape(dt);
    sheetMix += ((sheetCheckbox.checked ? 1 : 0) - sheetMix) * (1 - Math.exp(-dt * 6));
    // z stands on its own sheet.  With the 3D floor, that might be one of the see-through ones.
    const zSheet = fn == LOGARITHM ? zLevel() : zOnCameraSheet() ? 0 : 1;
    const offSheetStyle = offSheetSelect.value;
    // The other sheets are see-through.  They fade in as the 3D floor separates them from this one.
    floor.update(sheetMix, {
      count: fn == LOGARITHM ? 3 : 1,
      fill: THREE.MathUtils.clamp(floorUniforms.uLift.value / (0.08 * fn.maxLift), 0, 1),
      // log's levels flatten out and just stack up far from the branch point.  √'s other sheet is
      // a ceiling that you can see all the way out.
      fade: fn == LOGARITHM ? [16, 36] : [40, 110],
      // √'s other sheet covers everything, so it's mostly just grid lines.
      base: fn == LOGARITHM ? 0.16 : 0.07,
    });

    standOnFloor(zCharacter.root, zCharacter.shadow, zSheet);
    standOnFloor(eyeMarker.root, eyeMarker.shadow);
    dropShadow(zSheet, offSheetStyle == "solid");
    clickRing.position.y = floorHeight(clickRing.position.x, clickRing.position.z) + 0.04;

    // z might fade when it's on the other sheet from the camera.  The outputs never fade.
    zCharacter.setOpacity(zSheet == 0 || offSheetStyle != "fade" ? 1 : OFF_SHEET_OPACITY);
    zTrail.setOffSheetOpacity(offSheetStyle == "fade" ? OFF_SHEET_TRAIL_OPACITY : 1);

    branchPoint.update(dt, time, floorHeight);
    updateReadout();
    updateDemoStatus();
    renderer.render(scene, camera);
    outputRenderer.render(outputScene, outputCamera);
  }

  // Everyone waves hello.
  setTimeout(() => {
    for (const character of [zCharacter, ...cast.characters]) {
      character.emote("Wave");
    }
  }, 700);

  renderer.setAnimationLoop(frame);
  (window as unknown as { app: unknown }).app = {
    player,
    eye,
    view,
    camera,
    cameraRig,
    keys,
    setMode,
    demoCircle,
    demoMiss,
    demoSpiral,
    demoCamera,
    demoSpiralStillCamera,
    demoSurfaceTour,
    demoLogTour,
    demoRemaining: () => autopilot?.remaining?.(),
    demoLogCircles,
    demoLogApproach,
    demoLogSpiral,
    demoLogRectangle,
    demoLogGarage,
    useLog: () => setFunction(LOGARITHM),
    useSqrt: () => setFunction(SQUARE_ROOT),
    zOnCameraSheet,
    zLevel,
    busy: () => autopilot !== undefined,
    zHeight: () => zCharacter.root.position.y,
    zDropShadow,
    zoomBy,
  };
}

main();
