import * as THREE from "three";
import "@fontsource/roboto/latin-500.css";
import "./style.css";
import { BranchPoint, makeBlobShadow } from "./branchPoint";
import { Character, FloatingEye, loadCharacterModel } from "./characters";
import {
  abs,
  add,
  arg,
  complex,
  dot,
  format,
  multiply,
  negate,
  times,
  type Complex,
} from "./complex";
import { Floor } from "./floor";
import {
  CUBIC,
  CUBIC_BRANCH_POINTS,
  cubicValuesAt,
  LOGARITHM,
  otherRoots,
  SQUARE_ROOT,
  type MultiFunction,
} from "./functions";
import { lineTimes, MOMENTS } from "./narration";
import { OFF_SHEET_OPACITY, OFF_SHEET_TRAIL_OPACITY, Trail } from "./trail";
import {
  angleAround,
  BLOCK_RADIUS,
  CAMERA_BLOCK_RADIUS,
  CLOUD_RADIUS,
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
 * For a circle somewhere else, subtract its center from a and b first.
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

/** Does the straight line from a to b pass within r of point?  All in math units. */
function segmentNear(a: Complex, b: Complex, point: Complex, r: number) {
  const d = sub(b, a);
  const from = sub(a, point);
  const lengthSquared = dot(d, d);
  const t =
    lengthSquared > 0 ? Math.max(0, Math.min(1, -dot(from, d) / lengthSquared)) : 0;
  return Math.hypot(from.re + t * d.re, from.im + t * d.im) < r;
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

  // √ and log use the first one, at the origin.  The cubic uses all three.
  const branchPoints = CUBIC_BRANCH_POINTS.map(() => new BranchPoint());
  scene.add(...branchPoints.map((b) => b.group));
  /** Put each cloud on its branch point.  Zooming moves them, except the one at the origin. */
  function placeBranchPoints() {
    branchPoints.forEach((b, i) => {
      const where = fn.branchPoints[i];
      b.group.visible = where !== undefined;
      if (where) {
        toWorld(where, 0, b.group.position);
        floorUniforms.uBranches.value[i].set(b.group.position.x, b.group.position.z);
      }
    });
    floorUniforms.uBranchCount.value = fn.branchPoints.length;
  }

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
    [CUBIC, getById<HTMLButtonElement>("functionCubic")],
  ]);
  const demoLists = new Map<MultiFunction, HTMLElement>([
    [SQUARE_ROOT, getById("sqrtDemos")],
    [LOGARITHM, getById("logDemos")],
    [CUBIC, getById("cubicDemos")],
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
    cameraOthers = [];
    cast.previous = fn.outputs(player.w);
    snapOutputView = true;
    clearTrails();
    functionButtons.forEach((button, f) => button.classList.toggle("active", f == fn));
    demoLists.forEach((list, f) => (list.hidden = f != fn));
    title.textContent = `${fn.label} Walkabout`;
    liftSlider.disabled = fn.maxLift == 0;
    if (fn == CUBIC) {
      // The floor's colors are the best way to see the cubic's sheets.
      sheetCheckbox.checked = true;
    }
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
    let blocked = false;
    // Twice, in case getting pushed out of one zone pushed you into another.
    for (let pass = 0; pass < 2; pass++) {
      for (const branch of fn.branchPoints) {
        const center = toWorld(branch);
        const r = Math.hypot(x - center.x, z - center.z);
        if (r < BLOCK_RADIUS && r > 0) {
          x = center.x + ((x - center.x) * BLOCK_RADIUS) / r;
          z = center.z + ((z - center.z) * BLOCK_RADIUS) / r;
          const step = Math.hypot(dx, dz);
          const outX = start.x - center.x;
          const outZ = start.z - center.z;
          blocked ||= step > 0 && (dx * outX + dz * outZ) / (step * Math.hypot(outX, outZ)) < -0.5;
        }
      }
    }
    const from = body.z;
    body.z = toMath(x, z);
    body.w = fn.continueTo(body.z, body.w, from);
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
    /** Use the framing exactly, instead of easing toward it.  For carefully timed camera moves. */
    exactFraming?: boolean;
    /** Narrated demos show what's being said. */
    caption?(): string | undefined;
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
   * from the start through the branch point (the origin, unless you give another one):
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
  function spiralAutopilot(
    body: Body,
    onDone: () => void,
    moveCamera = true,
    branch = complex(0, 0)
  ): Autopilot {
    const scale = view.scale;
    const center = body.z;
    const startDistance = abs(sub(center, branch));
    /** Just outside the cones, in math units. */
    const margin = (BLOCK_RADIUS + 0.4) / scale;
    // Unit vectors toward the branch point, and 90° counterclockwise from that.
    const u = normalize(sub(branch, center));
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

  /** Walk to a point.  If a branch point is in the way, walk around it the short way. */
  function gotoAutopilot(body: Body, target: Complex): Autopilot {
    /** Which way we're going around each branch point, once we've picked. */
    const sides = new Map<Complex, number>();
    function steer(): Complex | undefined {
      const toTarget = sub(target, body.z);
      if (abs(toTarget) * view.scale < 0.25) {
        return undefined;
      }
      const blockRadius = (BLOCK_RADIUS - 0.1) / view.scale;
      // The nearest one in the way, if any.
      const branch = fn.branchPoints
        .filter((b) => segmentNear(body.z, target, b, blockRadius))
        .sort((a, b) => abs(sub(body.z, a)) - abs(sub(body.z, b)))[0];
      if (!branch) {
        return toTarget;
      }
      const from = sub(body.z, branch);
      const to = sub(target, branch);
      let side = sides.get(branch);
      if (side === undefined) {
        side = from.re * to.im - from.im * to.re >= 0 ? 1 : -1;
        sides.set(branch, side);
      }
      const out = normalize(from);
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
    eye.w = fn.continueTo(target, player.w, player.z);
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

  const TOUR_RISE_SECONDS = 1.2;
  const TOUR_ORBIT_SECONDS = 12;
  const TOUR_END_SECONDS = 11;

  /** How long a tour takes, in seconds. */
  function tourSeconds(options: TourOptions) {
    return (
      TOUR_RISE_SECONDS +
      pathLength(options.path, START_SCALE) / options.speed +
      TOUR_ORBIT_SECONDS +
      TOUR_END_SECONDS
    );
  }

  /** Make a tour.  The tour starts, and sets everything up, as soon as this is called. */
  function tour(options: TourOptions): Autopilot {
    const { path, speed, high, low, orbit, between, orbitDirection } = options;
    const scale = START_SCALE;
    const orbitSeconds = TOUR_ORBIT_SECONDS;
    const endSeconds = TOUR_END_SECONDS;
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

    return asDemo(
      sequence(
        player,
        [
          // 1. The floor rises in half a second.
          before(
            setup,
            pause(player, TOUR_RISE_SECONDS, (t) =>
              (liftSlider.value = String(options.lift * smooth(t, 0, 0.5)))
            )
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
    autopilot = tour({
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
  function logTourOptions(): TourOptions {
    const levels = 3;
    const laps = 2 * levels;
    const spacing = 1.2;
    return {
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
    };
  }
  function demoLogTour() {
    autopilot = tour(logTourOptions());
  }

  //
  // The narrated demo.  It follows full_script.md.  Every move is pinned to a line of the script, so
  // the timing all comes from narration.ts.  Change when the lines are spoken, and the animation
  // follows.
  //

  /**
   * Speed up for the first `ramp` of the time, coast, then slow down for the last `ramp`.
   * Maps time, 0 to 1, to distance, 0 to 1.
   */
  function easeEnds(u: number, ramp = 0.18) {
    const v = 1 / (1 - ramp);
    if (u < ramp) {
      return (v * u * u) / (2 * ramp);
    } else if (u > 1 - ramp) {
      return 1 - (v * (1 - u) ** 2) / (2 * ramp);
    } else {
      return v * (u - ramp / 2);
    }
  }
  /** Speed up at the start, but still be walking at full speed at the end.  For bumping into things. */
  function easeStart(u: number, ramp = 0.1) {
    const v = 1 / (1 - ramp / 2);
    return u < ramp ? (v * u * u) / (2 * ramp) : v * (u - ramp / 2);
  }

  /** A move that happens between two times, in seconds from the start of the demo. */
  type Move = {
    from: number;
    to: number;
    /** Make the path when the move starts, from wherever the body is.  u goes from 0 to 1. */
    make(start: Complex): (u: number) => Complex;
    /** Called just before the move starts. */
    onStart?(): void;
    /** Walk in place at this speed, in world units per second, instead of following the path. */
    walkInPlace?: number;
  };

  /** Walk straight toward or away from the branch point.  radius is in world units. */
  function radialMove(from: number, to: number, radius: number, scale: number, ease = easeEnds): Move {
    return {
      from,
      to,
      make(start) {
        const angle = arg(start);
        const r0 = abs(start);
        const r1 = radius / scale;
        return (u) => polar(r0 + (r1 - r0) * ease(u), angle);
      },
    };
  }

  /** One leg of a walk around the branch point. */
  type Leg =
    /** Walk straight toward or away from the branch point, to this many world units from it. */
    | { radial: number }
    /** Walk once around the branch point.  1 for counterclockwise, -1 for clockwise. */
    | { lap: 1 | -1 }
    | { pause: number };

  /**
   * Fit some legs between two times, at a steady pace.  Pauses take exactly as long as they say.
   * startRadius is how far from the branch point the body is when this starts, in world units.
   */
  function fitLegs(from: number, to: number, startRadius: number, scale: number, legs: Leg[]) {
    let r = startRadius;
    let distance = 0;
    let pausing = 0;
    const lengths = legs.map((leg) => {
      let length = 0;
      if ("radial" in leg) {
        length = Math.abs(leg.radial - r);
        r = leg.radial;
      } else if ("lap" in leg) {
        length = TAU * r;
      } else {
        pausing += leg.pause;
      }
      distance += length;
      return length;
    });
    const secondsPerUnit = Math.max(0, to - from - pausing) / Math.max(distance, 1e-9);
    const moves: Move[] = [];
    let t = from;
    legs.forEach((leg, index) => {
      if ("pause" in leg) {
        t += leg.pause;
        return;
      }
      const end = t + lengths[index] * secondsPerUnit;
      if ("radial" in leg) {
        moves.push(radialMove(t, end, leg.radial, scale));
      } else {
        moves.push({
          from: t,
          to: end,
          make(start) {
            const angle = arg(start);
            const radius = abs(start);
            return (u) => polar(radius, angle + leg.lap * TAU * easeEnds(u));
          },
        });
      }
      t = end;
    });
    return moves;
  }

  /**
   * Moves a body along a list of moves that don't overlap.  Between moves it stands still.
   * Returns a function to call every frame.  That returns the body's speed, in world units per second.
   */
  function follow(body: Body, moves: Move[]) {
    let next = 0;
    let path: ((u: number) => Complex) | undefined;
    let current: Move | undefined;
    const goTo = (target: Complex, dt: number) => {
      const here = toWorld(body.z);
      const there = toWorld(target);
      const dx = there.x - here.x;
      const dz = there.z - here.z;
      moveBody(body, dx, dz);
      const step = Math.hypot(dx, dz);
      if (step > 1e-4) {
        body.heading = turnToward(body.heading, headingToward(dx, dz), 8 * Math.max(dt, 1 / 60));
      }
      return dt > 0 ? step / dt : 0;
    };
    return (t: number, dt: number) => {
      while (next < moves.length && moves[next].from <= t) {
        // Finish the last move exactly, in case we skipped past its end.
        if (path) {
          goTo(path(1), 0);
        }
        current = moves[next++];
        current.onStart?.();
        path = current.make(body.z);
      }
      if (!current || !path) {
        return 0;
      }
      if (current.walkInPlace !== undefined) {
        return t < current.to ? current.walkInPlace : 0;
      }
      const u = THREE.MathUtils.clamp((t - current.from) / Math.max(current.to - current.from, 1e-9), 0, 1);
      return goTo(path(u), dt);
    };
  }

  function demoNarrated() {
    const lines = lineTimes();
    const start = (id: string) => lines.get(id)!.start;
    const end = (id: string) => lines.get(id)!.end;
    /** Part way through a line.  0 is the start, 1 is the end. */
    const during = (id: string, fraction: number) => start(id) + (end(id) - start(id)) * fraction;
    const smooth = THREE.MathUtils.smootherstep;
    const clamp = THREE.MathUtils.clamp;

    //
    // The knobs.
    //
    /** The 3D floor is on the whole time, at this setting, 0 to 1. */
    const LIFT = 0.5;
    /** Zoom levels.  World units per math unit. */
    const SCALES = [START_SCALE, 12.5, 31.25];
    /** Aim this far into the zone, in world units, so z walks right into the rope. */
    const INTO_THE_ROPE = 2.8;
    /** The first circle, in world units at the last zoom level. */
    const FIRST_CIRCLE = 6;
    /** Looking straight down, almost, so it looks like an ordinary plot of the complex plane. */
    const overhead = { pitch: 1.3, distance: 46 };
    /** The camera comes down to here.  See descentStart and descentEnd. */
    const low = { pitch: 0.22, distance: 32 };
    /** While the camera walks around the branch point. */
    const orbit = { pitch: 0.38, distance: 30 };
    /** The finale:  between the two sheets. */
    const between = { pitch: 0.03, distance: 11 };
    /** The camera starts down half way through this line, slowly at first, then stops suddenly. */
    const descentStart = during("trackColors", 0.5);
    const descentEnd = end("height") - 0.1;
    /** When we switch to log. */
    const switchToLog = MOMENTS.logStart;

    //
    // Set up the opening:  √z, standing at −4𝒾, looking at the branch point.
    //
    if (fn != SQUARE_ROOT) {
      setFunction(SQUARE_ROOT);
    }
    reset();
    sheetCheckbox.checked = false;
    offSheetSelect.value = "solid";
    liftSlider.value = String(LIFT);
    floorUniforms.uLift.value = LIFT * fn.maxLift;

    //
    // z's moves.
    //
    const zMoves: Move[] = [
      // Walk toward 0, weaving a little, right into the rope.
      {
        from: end("walk") - 0.6,
        // Arrive at the rope exactly now, still walking at full speed.
        to: MOMENTS.ropeBump,
        make(from) {
          const r0 = abs(from) * SCALES[0];
          return (u) => {
            // How far along the walk, 0 to 1, by distance.
            const p = easeStart(u);
            const r = r0 + (BLOCK_RADIUS - r0) * p;
            // Three small bumps, the middle one biggest.  The envelope is 0 at both ends, so z
            // starts out heading straight at 0, and ends going straight into the rope.  This is
            // measured by distance, not time, so speeding up at the start doesn't bend the path.
            const weave = 1.2 * Math.sin(3 * Math.PI * p) * 4 * p * (1 - p);
            return { re: weave / SCALES[0], im: -r / SCALES[0] };
          };
        },
      },
      // Keep trying to walk into the rope for a moment.  Then stand still.
      {
        from: MOMENTS.ropeBump,
        to: MOMENTS.ropeBump + MOMENTS.pushingSeconds,
        // Fast enough to run, not just walk.  Frantic, on purpose.
        walkInPlace: 10,
        make: (from) => () => from,
      },
      // Zoom in, then walk closer.
      radialMove(MOMENTS.walkCloser, MOMENTS.walkCloserEnd, 4.4, SCALES[1]),
      // Zoom in again, and walk closer.
      radialMove(MOMENTS.zoomInAgainEnd, end("furtherIn") + 0.2, 6, SCALES[2]),
      // Right into the rope again.
      radialMove(start("notAllowed"), end("notAllowed") - 0.3, INTO_THE_ROPE, SCALES[2], easeStart),
      // Step back out to the first circle.
      radialMove(start("important"), end("important") + 0.4, FIRST_CIRCLE, SCALES[2]),
      // Three circles, each one ending at the same spot.
      ...fitLegs(start("circle") + 0.6, end("sameValues") - 0.2, FIRST_CIRCLE, SCALES[2], [
        { lap: 1 },
        { pause: 0.8 },
        { radial: FIRST_CIRCLE + 1.4 },
        { lap: 1 },
        { radial: FIRST_CIRCLE },
        { pause: 0.8 },
        { radial: FIRST_CIRCLE + 3 },
        { lap: 1 },
        { radial: FIRST_CIRCLE },
      ]),
      // Expanding circles, pausing after each one.
      ...fitLegs(start("continuous") + 0.2, start("notReally") - 0.5, FIRST_CIRCLE, SCALES[2], [
        { radial: FIRST_CIRCLE + 2.4 },
        { lap: 1 },
        { pause: 0.5 },
        { radial: FIRST_CIRCLE + 4.8 },
        { lap: 1 },
        { pause: 0.5 },
        { radial: FIRST_CIRCLE + 7.2 },
        { lap: 1 },
        { pause: 0.5 },
        { radial: FIRST_CIRCLE + 9.6 },
        { lap: 1 },
      ]),
    ];

    //
    // The camera walks once around the branch point while z stands still.
    //
    let orbitYaw = 0;
    const lookIn = Math.PI / 2;
    const eyeMoves: Move[] = [
      {
        from: start("notReally"),
        to: end("identical"),
        onStart() {
          // Face along the circle, without moving the camera.
          const angle = arg(eye.z);
          const tangent = headingToward(-Math.sin(angle), -Math.cos(angle));
          orbitYaw = wrapAngle(cameraRig.yawOffset + eye.heading - tangent);
          eye.heading = tangent;
        },
        make(from) {
          const angle = arg(from);
          const radius = abs(from);
          return (u) => polar(radius, angle + TAU * easeEnds(u, 0.12));
        },
      },
    ];

    //
    // Zooming.
    //
    const zooms = [
      { from: MOMENTS.zoomIn, to: MOMENTS.zoomInEnd, scales: [SCALES[0], SCALES[1]] },
      { from: MOMENTS.zoomInAgain, to: MOMENTS.zoomInAgainEnd, scales: [SCALES[1], SCALES[2]] },
    ];
    function zoomAt(t: number) {
      let result: number | undefined;
      for (const zoom of zooms) {
        if (t >= zoom.from) {
          const u = smooth(t, zoom.from, zoom.to);
          result = zoom.scales[0] * Math.pow(zoom.scales[1] / zoom.scales[0], u);
        }
      }
      return result;
    }

    //
    // Things that happen once.
    //
    const events: { at: number; run(): void }[] = [
      { at: MOMENTS.zWaves, run: () => zCharacter.emote("Wave") },
      { at: MOMENTS.outputsWave, run: () => cast.characters.forEach((c) => c.emote("Wave")) },
      // Shake his head when he stops trying to walk.
      { at: MOMENTS.ropeBump + MOMENTS.pushingSeconds, run: () => zCharacter.emote("No") },
      // Blue, then red.  cast.characters is [red, blue].
      { at: MOMENTS.blueWaves, run: () => cast.characters[1].emote("Wave") },
      { at: MOMENTS.redWaves, run: () => cast.characters[0].emote("Wave") },
      { at: end("notAllowed"), run: () => zCharacter.emote("No") },
      {
        // Cut to looking down from high above, like an ordinary plot.  The camera holds still.
        at: start("important"),
        run() {
          parkCamera(
            polar(TOUR_INNER / SCALES[2], TOUR_CAMERA_ANGLE),
            polar(1, TOUR_CAMERA_ANGLE + Math.PI),
            overhead.pitch,
            overhead.distance
          );
          sheetCheckbox.checked = true;
        },
      },
      {
        at: switchToLog,
        run() {
          // Switching functions stops any demo, including this one.  Keep going.
          setFunction(LOGARITHM);
          logTour = tour(logTourOptions());
          autopilot = narrated;
        },
      },
    ];

    /** The camera, from when it parks until we switch to log. */
    /**
     * While we talk about the branch point, z gently looks left and right, and the camera turns with
     * his head and rocks up and down a little.  This fades in and out:  0 to 1 and back to 0.
     */
    function surveyAt(t: number) {
      return Math.sin(Math.PI * smooth(t, MOMENTS.surveyStart, MOMENTS.surveyEnd));
    }
    /** How far z turns his head, in radians.  Positive is left.  Two slow sways, about 12° each way. */
    function headAt(t: number) {
      const phase = (t - MOMENTS.surveyStart) / (MOMENTS.surveyEnd - MOMENTS.surveyStart);
      return 0.2 * Math.sin(2 * TAU * phase) * surveyAt(t);
    }

    function cameraAt(t: number): CameraFraming | undefined {
      if (t < start("important")) {
        const survey = surveyAt(t);
        if (survey > 0) {
          // Follow z, the usual way, rocking a little.
          return {
            pitch: START_PITCH + 0.07 * Math.sin(2 * Math.PI * survey),
            distance: START_DISTANCE,
            // Look where z is looking.
            yawOffset: headAt(t),
          };
        }
        // Follow z, the usual way.
        return undefined;
      }
      if (t < start("notReally")) {
        // Hold still, high up.  Then come down, slowly at first, and stop suddenly.
        const u = clamp((t - descentStart) / (descentEnd - descentStart), 0, 1);
        const k = u * u;
        return {
          pitch: overhead.pitch + (low.pitch - overhead.pitch) * k,
          distance: overhead.distance + (low.distance - overhead.distance) * k,
          yawOffset: 0,
        };
      }
      if (t < start("oneSurface")) {
        // Walk around the branch point, looking in.
        const k = smooth(t, start("notReally"), start("notReally") + 2);
        return {
          pitch: low.pitch + (orbit.pitch - low.pitch) * k,
          distance: low.distance + (orbit.distance - low.distance) * k,
          yawOffset: orbitYaw + wrapAngle(lookIn - orbitYaw) * k,
        };
      }
      // The finale.  Down between the sheets, looking at the branch point, then turn toward z.
      const t0 = start("oneSurface");
      const down = smooth(t, t0, t0 + 3);
      return {
        pitch: orbit.pitch + (between.pitch - orbit.pitch) * down,
        distance: orbit.distance + (between.distance - orbit.distance) * down,
        // Keep turning slowly, the whole time, until we switch to log.  Don't turn more than this:
        // any farther and the column gets between the camera and the eye, and the camera jumps.
        yawOffset: lookIn - 1.75 * smooth(t, t0 + 4, switchToLog),
      };
    }

    const moveZ = follow(player, zMoves);
    const moveEye = follow(eye, eyeMoves);
    const logSeconds = tourSeconds(logTourOptions());
    let logTour: Autopilot | undefined;
    let t = 0;
    let fired = 0;
    events.sort((a, b) => a.at - b.at);

    const narrated: Autopilot = {
      get body() {
        return logTour?.body ?? player;
      },
      title: "Narrated tour",
      get framing() {
        return logTour ? logTour.framing : cameraAt(t);
      },
      get exactFraming() {
        return !logTour;
      },
      remaining: () => (logTour ? logTour.remaining?.() ?? 0 : switchToLog - t + logSeconds),
      caption() {
        // The line being spoken, until a moment after it ends.
        let result: string | undefined;
        for (const { line, start, end } of lines.values()) {
          if (t >= start && t < end + 1.2) {
            result = line.text;
          }
        }
        return result;
      },
      step(dt) {
        t += dt;
        while (fired < events.length && events[fired].at <= t) {
          events[fired++].run();
        }
        if (logTour) {
          return logTour.step(dt);
        }
        const scale = zoomAt(t);
        if (scale !== undefined) {
          view.scale = targetScale = scale;
        }
        moveEye(t, dt);
        zCharacter.headTurn = headAt(t);
        return moveZ(t, dt);
      },
    };
    autopilot = narrated;
  }
  getById("demoCircle").addEventListener("click", demoCircle);
  getById("demoMiss").addEventListener("click", demoMiss);
  getById("demoSpiral").addEventListener("click", demoSpiral);
  getById("demoCamera").addEventListener("click", demoCamera);
  getById("demoSpiralStill").addEventListener("click", demoSpiralStillCamera);
  getById("demoSurfaceTour").addEventListener("click", demoSurfaceTour);
  getById("demoNarrated").addEventListener("click", demoNarrated);

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
  // Cubic demos.  w³ − zw − 2 = 0 has three branch points, at 3, 3ω, and 3ω².  Most of these start at
  // z = 0, right in the middle, like the 2D version.  From there, the straight line out to each branch
  // point is clear, and going around one of them trades two of the three values.
  //

  const ZERO = complex(0, 0);
  /** How fast z walks around the loops, in world units per second. */
  const LOOP_SPEED = 12;

  /** Cubic demos use absolute positions, like z = 0, so they set the zoom.  And the floor's colors are the whole point. */
  function startCubicDemo(scale = START_SCALE) {
    setMode("walk");
    clearTrails();
    view.scale = targetScale = scale;
    sheetCheckbox.checked = true;
  }

  /** Looking from here, none of the three clouds hides another:  south-east, half way between 3 and 3ω². */
  const CUBIC_VIEW_FROM = polar(1, -Math.PI / 3);
  /**
   * Park the camera high above, looking at `look`, from the direction `from`, in math coordinates.
   * The default looks at all three branch points.
   */
  function cubicOverview(look = complex(0, 0), from = CUBIC_VIEW_FROM, pitch = 1.1, distance = 62) {
    parkCamera(look, negate(from), pitch, distance);
  }

  /**
   * Does going around branch point b, from where the body is, trade z's own value?  Follow the
   * straight line to b, and see if z's value is one of the two that meet there.
   */
  function movesOwnValue(body: Body, b: Complex) {
    return movesValue(body.z, body.w, b);
  }
  /** Does going around branch point b, from z, trade the value w?  See movesOwnValue(). */
  function movesValue(z: Complex, w: Complex, b: Complex) {
    const near = add(b, times(normalize(sub(z, b)), 0.01));
    const there = CUBIC.continueTo(near, w, z);
    const { double, single } = cubicValuesAt(b);
    return abs(sub(there, double)) < abs(sub(there, single));
  }
  /** Pick a branch point that trades z's own value, so z changes sheets, and you can see it fade. */
  function branchThatMovesZ() {
    return CUBIC_BRANCH_POINTS.find((b) => movesOwnValue(player, b)) ?? CUBIC_BRANCH_POINTS[1];
  }

  /** Once around a circle through `start`, centered at center.  1 for counterclockwise, -1 for clockwise. */
  function loopPath(start: Complex, center: Complex, direction: 1 | -1) {
    const offset = sub(start, center);
    return (u: number) => add(center, multiply(offset, polar(1, direction * TAU * u)));
  }
  /** From 0, once around branch point b.  Bigger sizes reach farther past it. */
  function loopAround(b: Complex, direction: 1 | -1, size = 2) {
    return loopPath(ZERO, times(b, size / 3), direction);
  }

  /** Follow a path.  make() makes it when the step starts.  guess is for the countdown. */
  function pathStep(body: Body, make: () => (u: number) => Complex, speed: number, guess = make()): Step {
    return {
      start: () => pathAutopilot(body, make(), speed),
      plan: () => ({ seconds: pathLength(guess) / speed, end: guess(1) }),
    };
  }

  /** Each robot's place, at the start of the interesting part of a demo.  See describeShuffle(). */
  let shuffleStart: Complex[] = [];
  function rememberOutputs() {
    shuffleStart = fn.outputs(player.w, cast.previous);
  }
  const ROBOT_NAMES = ["red", "blue", "yellow"];
  const capitalize = (text: string) => text[0].toUpperCase() + text.slice(1);
  /**
   * Who ended up where?  This assumes z is back where it was at rememberOutputs(), so the robots are
   * standing on the same three places, maybe in a different order.
   */
  function describeShuffle() {
    const now = fn.outputs(player.w, cast.previous);
    /** where[i] is the robot whose starting place robot i is standing on now. */
    const where = now.map((w) => {
      let best = 0;
      shuffleStart.forEach((start, j) => {
        if (abs(sub(w, start)) < abs(sub(w, shuffleStart[best]))) {
          best = j;
        }
      });
      return best;
    });
    const moved = where.flatMap((j, i) => (j == i ? [] : [i]));
    const z =
      where[0] == 0
        ? "Red, z's own value, came back, so z is on the same sheet it started on."
        : "Red, z's own value, moved, so z is on a different sheet now.";
    if (moved.length == 0) {
      return "Every robot came back to its own place.";
    } else if (moved.length == 2) {
      const [a, b] = moved.map((i) => ROBOT_NAMES[i]);
      const stayed = ROBOT_NAMES[[0, 1, 2].find((i) => !moved.includes(i))!];
      return `${capitalize(a)} and ${b} traded places. ${capitalize(stayed)} came back to its own place. ${z}`;
    } else {
      const took = (i: number) => `${ROBOT_NAMES[i]} is where ${ROBOT_NAMES[where[i]]} started`;
      return `All three moved: ${took(0)}, ${took(1)}, and ${took(2)}. ${z}`;
    }
  }

  /**
   * From the 2D version:  z walks from 0, once around one branch point, and back to 0.
   * We pick one that trades z's own value, so z changes sheets.
   */
  function demoCubicOne() {
    startCubicDemo();
    let branch = CUBIC_BRANCH_POINTS[1];
    autopilot = asDemo(
      sequence(
        player,
        [
          walkTo(player, ZERO),
          before(() => {
            branch = branchThatMovesZ();
            cubicOverview();
            clearTrails();
            rememberOutputs();
          }, pathStep(player, () => loopAround(branch, 1), LOOP_SPEED)),
        ],
        () =>
          toast(
            `${describeShuffle()} Each branch point only trades two of the three values. The third one just takes a walk and comes back.`,
            14000
          )
      ),
      "Around one branch point"
    );
  }

  /**
   * From the 2D version:  once around each branch point, in turn.  Then around each again, in the
   * opposite order, on slightly bigger loops so the trails don't land on top of each other.
   */
  function demoCubicEach() {
    startCubicDemo();
    const loops = [
      ...CUBIC_BRANCH_POINTS.map((b) => loopAround(b, 1)),
      ...[...CUBIC_BRANCH_POINTS].reverse().map((b) => loopAround(b, 1, 2.3)),
    ];
    const steps: Step[] = [];
    loops.forEach((loop, i) => {
      if (i > 0) {
        steps.push(pause(player, 0.6));
      }
      steps.push(pathStep(player, () => loop, LOOP_SPEED));
    });
    steps[0] = before(() => {
      cubicOverview();
      clearTrails();
      rememberOutputs();
    }, steps[0]);
    autopilot = asDemo(
      sequence(player, [walkTo(player, ZERO), ...steps], () =>
        toast(
          `${describeShuffle()} Each loop traded two values. The last three loops undid the first three, in the opposite order.`,
          14000
        )
      ),
      "Around each one, in turn"
    );
  }

  /**
   * From the 2D version:  one loop that goes around two branch points at once, 3ω and 3ω².  That's two
   * trades in a row, so all three values move.
   */
  function demoCubicTwo() {
    startCubicDemo();
    // An ellipse through 0, around the two branch points on the left.
    const path = (u: number) => {
      const theta = TAU * u;
      return complex(-1.5 + 1.5 * Math.cos(theta), 4 * Math.sin(theta));
    };
    autopilot = asDemo(
      sequence(
        player,
        [
          walkTo(player, ZERO),
          before(() => {
            cubicOverview();
            clearTrails();
            rememberOutputs();
          }, pathStep(player, () => path, LOOP_SPEED)),
        ],
        () =>
          toast(
            `${describeShuffle()} Going around two branch points at once is two trades in a row, so nobody gets to stay home. Go around twice more and everyone's back.`,
            14000
          )
      ),
      "Around two at once"
    );
  }

  /**
   * Around one branch point, then another, then back around the first one the other way, then back
   * around the second one the other way.  Every lap is undone, but the values still end up shuffled:
   * the order matters.
   */
  function demoCubicThereAndBack() {
    startCubicDemo();
    const [a, b] = CUBIC_BRANCH_POINTS;
    const loops = [loopAround(a, 1), loopAround(b, 1), loopAround(a, -1, 2.3), loopAround(b, -1, 2.3)];
    const steps: Step[] = [];
    loops.forEach((loop, i) => {
      if (i > 0) {
        steps.push(pause(player, 0.6));
      }
      steps.push(pathStep(player, () => loop, LOOP_SPEED));
    });
    steps[0] = before(() => {
      cubicOverview();
      clearTrails();
      rememberOutputs();
    }, steps[0]);
    autopilot = asDemo(
      sequence(player, [walkTo(player, ZERO), ...steps], () =>
        toast(
          `${describeShuffle()} z went counterclockwise around 3, then around 3ω, then clockwise around 3, then around 3ω. Every lap was undone, but the values didn't go back. The order matters!`,
          16000
        )
      ),
      "There and back again"
    );
  }

  /**
   * The √ spiral, aimed at one branch point.  Two loops miss it, the second one just barely.  Then two go
   * around it, the first one just barely.  We pick a branch point that trades z's own value.
   * Zoomed in a little, so the biggest loop stays clear of the other branch points.
   */
  function demoCubicSpiral() {
    const scale = 8;
    startCubicDemo(scale);
    let branch = CUBIC_BRANCH_POINTS[1];
    /** The spiral's center, on the line from 0 to the branch point. */
    const center = () => times(branch, 1 - 1.6 / 3);
    const spiral: Step = {
      start: () =>
        spiralAutopilot(
          player,
          () => {},
          false,
          branch
        ),
      // About how long spiralAutopilot takes.
      plan: (from) => ({ seconds: 36, end: from }),
    };
    autopilot = asDemo(
      sequence(
        player,
        [
          walkTo(player, ZERO),
          before(() => (branch = branchThatMovesZ()), {
            start: () => lineTo(player, center(), 10).start(),
            plan: () => ({ seconds: (1.4 * scale) / 10, end: center() }),
          }),
          before(() => {
            // Look along the line from 0 to the branch point, but 25° off to the side, so the cut
            // behind the cloud doesn't land on the spiral's landmarks.
            const look = multiply(normalize(branch), polar(1, -0.45));
            parkCamera(center(), look, 0.95, 70);
            clearTrails();
          }, spiral),
        ],
        () =>
          toast(
            "The first two loops missed the branch point, so each robot just drew a little loop of its own. The next two went around it, just barely, then with room to spare. Each of those traded z's value with one of the others. Watch z: it faded each time it crossed behind the cloud, onto another sheet.",
            15000
          )
      ),
      "Spiral past one branch point"
    );
  }

  /**
   * Far from the branch points, the cubic looks like √z:  two of its values are close to ±√z, and the
   * third one is small, close to −2/z.  A spiral that stays outside all three branch points shows it.
   */
  function demoCubicFar() {
    const scale = 4;
    startCubicDemo(scale);
    const r0 = 4.5;
    const laps = 3;
    const spacing = 1.8;
    const startAngle = Math.PI / 3;
    const path = (u: number) => polar(r0 + spacing * laps * u, startAngle + laps * TAU * u);
    autopilot = asDemo(
      sequence(
        player,
        [
          walkTo(player, path(0)),
          before(() => {
            cubicOverview(complex(0, 0), CUBIC_VIEW_FROM, 1.1, 115);
            clearTrails();
          }, pathStep(player, () => path, 25)),
        ],
        () => {
          const outputs = fn.outputs(player.w, cast.previous);
          const small = outputs.reduce((best, w, i) => (abs(w) < abs(outputs[best]) ? i : best), 0);
          const big = [0, 1, 2].filter((i) => i != small).map((i) => ROBOT_NAMES[i]);
          toast(
            `From far away, the three branch points look like one, and the cubic looks like √z. ${capitalize(big[0])} and ${big[1]} acted like the two square roots: each lap moved them half way around, so they traded places. ${capitalize(ROBOT_NAMES[small])} stayed small, near −2/z, and went the other way around, once per lap.`,
            16000
          );
        }
      ),
      "Spiral around all three"
    );
  }

  /** The camera walks around a branch point that trades z's own value, so it changes sheets. */
  function demoCubicCamera() {
    startCubicDemo();
    let center = ZERO;
    autopilot = asDemo(
      sequence(
        player,
        [
          walkTo(player, ZERO),
          before(
            () => {
              const branch = branchThatMovesZ();
              center = times(branch, 2 / 3);
              // Switching modes cancels the autopilot.
              const pilot = autopilot;
              setMode("explore");
              autopilot = pilot;
            },
            {
              start: () => circleAutopilot(eye, center, abs(sub(eye.z, center)), () => {}),
              plan: () => ({ seconds: 14, end: ZERO }),
            }
          ),
        ],
        () =>
          toast(
            zLevel() == 0
              ? "Only the camera moved, and it went around a branch point, so it changed sheets. That put it back on z's sheet: z is solid again."
              : "Only the camera moved, but it went around a branch point that trades z's value, so now the camera is on a different sheet. z faded, and part of the floor changed colors. The robots don't care: they live on an ordinary plane. Go around again to get back.",
            13000
          )
      ),
      "Walk the camera around one"
    );
  }


  /**
   * Join paths end to end into one, with u spread evenly by length.  Each piece should start where the
   * last one ended.
   */
  function joinPaths(pieces: ((u: number) => Complex)[]) {
    const lengths = pieces.map((piece) => pathLength(piece, 1));
    const total = lengths.reduce((a, b) => a + b);
    return (u: number) => {
      let distance = THREE.MathUtils.clamp(u, 0, 1) * total;
      for (let i = 0; i < pieces.length; i++) {
        if (distance <= lengths[i] || i == pieces.length - 1) {
          return pieces[i](Math.min(1, distance / lengths[i]));
        }
        distance -= lengths[i];
      }
      return pieces[pieces.length - 1](1);
    };
  }

  /**
   * A tour of the cubic's whole surface, with the same four parts as the other tours.
   *   1. The floor rises into 3D:  three sheets, stacked.
   *   2. z walks a spiral out from the branch point at 3, crosses a short bridge, and walks a spiral in
   *      to the one at 3ω.  Each lap around a branch point that glues z's sheet to another takes z to
   *      that other sheet.  We pick z's starting sheet so the trail lands on all three.
   *   3. The camera walks once around a branch point that glues its own sheet to another, so those two
   *      sheets trade places.
   *   4. The camera settles between two layers, then turns to look along them.
   */
  function demoCubicTour() {
    const scale = START_SCALE;
    const [a, b] = CUBIC_BRANCH_POINTS;
    const smooth = THREE.MathUtils.smootherstep;
    const inner = TOUR_INNER / scale;
    const spacing = 2.4 / scale;
    const laps = 3;
    const outer = inner + laps * spacing;
    const along = normalize(sub(b, a));
    const toward = arg(along);
    const path = joinPaths([
      // Counterclockwise and out, around a.  It starts and ends on the side facing b.
      (t) => add(a, polar(inner + spacing * laps * t, toward + laps * TAU * (t - 1))),
      // The bridge.
      (t) => add(add(a, times(along, outer)), times(along, (abs(sub(b, a)) - 2 * outer) * t)),
      // Clockwise and in, around b, starting on the side facing a.  The two spirals make an S.
      (t) => add(b, polar(outer - spacing * laps * t, toward + Math.PI - laps * TAU * t)),
    ]);
    const speed = 15;
    const lift = 0.6;
    // Which of the three values should z start with?  One that a trades, and that b trades after the
    // first spiral, so the trail visits all three sheets.  Follow each one along the path to find out.
    const start = path(0);
    const first = CUBIC.principal(start);
    const candidates = [first, ...otherRoots(first)];
    const bridgeEnd = path(0.5);
    const startW =
      candidates.find((w) => {
        if (!movesValue(start, w, a)) {
          return false;
        }
        let here = start;
        let value = w;
        for (let i = 1; i <= 2000; i++) {
          const next = path((0.5 * i) / 2000);
          value = CUBIC.continueTo(next, value, here);
          here = next;
        }
        return movesValue(bridgeEnd, value, b);
      }) ?? first;
    // Watch from outside the triangle of branch points, beyond the edge from a to b, looking in.
    const middle = times(add(a, b), 0.5);
    const out = normalize(middle);
    const high = { pitch: 0.42, distance: 50 };
    const low = { pitch: 0.26, distance: 46 };
    const orbit = { pitch: 0.38, distance: 17 };
    const between = { pitch: 0.03, distance: 11 };
    const orbitDirection = 1;
    const lookIn = (orbitDirection * Math.PI) / 2;
    let orbitCenter = a;

    const setup = () => {
      setMode("walk");
      view.scale = targetScale = scale;
      clearTrails();
      sheetCheckbox.checked = true;
      // The tour is all about where z and its trail are in 3D, so keep them solid on every sheet.
      offSheetSelect.value = "solid";
      liftSlider.value = "0";
      floorUniforms.uLift.value = 0;
      player.z = start;
      player.w = startW;
      const direction = sub(path(0.001), path(0));
      player.heading = headingToward(direction.re, -direction.im);
      cast.previous = fn.outputs(player.w);
      snapOutputView = true;
      parkCamera(add(middle, times(out, 0.4)), negate(out), high.pitch, high.distance);
    };

    /** Does going around b from the camera trade the camera's own value?  Then the floor changes sheets. */
    const gluesCameraSheet = (branch: Complex) => movesValue(cameraZ, cameraW, branch);
    const walkToOrbit: Step = {
      start() {
        // The nearest of the two that glues the camera's sheet to another.  Usually one of them does.
        orbitCenter =
          [a, b]
            .filter(gluesCameraSheet)
            .sort((p, q) => abs(sub(eye.z, p)) - abs(sub(eye.z, q)))[0] ??
          CUBIC_BRANCH_POINTS.find(gluesCameraSheet) ??
          a;
        const from = eye.z;
        const to = add(orbitCenter, times(normalize(sub(eye.z, orbitCenter)), inner));
        return pathAutopilot(eye, (u) => add(from, times(sub(to, from), easeEnds(u))), 8);
      },
      plan: (from) => ({ seconds: (abs(sub(a, from)) * scale) / 8, end: a }),
    };
    const walkAround: Step = {
      start() {
        const offset = sub(eye.z, orbitCenter);
        const r = abs(offset);
        const startAngle = arg(offset);
        // Face along the circle, without moving the camera.
        const tangent = headingToward(
          -orbitDirection * Math.sin(startAngle),
          -orbitDirection * Math.cos(startAngle)
        );
        cameraRig.yawOffset = wrapAngle(cameraRig.yawOffset + eye.heading - tangent);
        eye.heading = tangent;
        return pathAutopilot(
          eye,
          (u) => add(orbitCenter, polar(r, startAngle + orbitDirection * TAU * u)),
          (TAU * r * view.scale) / TOUR_ORBIT_SECONDS
        );
      },
      plan: (from) => ({ seconds: TOUR_ORBIT_SECONDS, end: from }),
    };

    autopilot = asDemo(
      sequence(
        player,
        [
          // 1. The floor rises.
          before(
            setup,
            pause(player, TOUR_RISE_SECONDS, (t) => (liftSlider.value = String(lift * smooth(t, 0, 0.5))))
          ),
          // 2. z walks.  The camera drifts from the higher angle to the lower one, then keeps swaying.
          withCamera(pathStep(player, () => path, speed), (t) => ({
            pitch:
              high.pitch +
              (low.pitch - high.pitch) * smooth(t, 0, 2) +
              (0.1 * (1 - Math.cos((Math.max(0, t - 2) * TAU) / 14))) / 2,
            distance: high.distance + (low.distance - high.distance) * smooth(t, 0, 2),
            yawOffset: 0.3 * Math.sin((t * TAU) / 20),
          })),
          // 3. The camera moves in close to a branch point, and walks around it, looking in.
          withCamera(walkToOrbit, (t) => ({
            pitch: low.pitch + (orbit.pitch - low.pitch) * smooth(t, 0, 3),
            distance: low.distance + (orbit.distance - low.distance) * smooth(t, 0, 3),
            yawOffset: 0,
          })),
          withCamera(walkAround, () => ({ ...orbit, yawOffset: lookIn })),
          // 4. Down between two layers, looking at where they meet behind the cloud.  Then turn to look
          // along them.
          withCamera(pause(eye, TOUR_END_SECONDS), (t) => {
            const down = smooth(t, 0, 3);
            return {
              pitch: orbit.pitch + (between.pitch - orbit.pitch) * down,
              distance: orbit.distance + (between.distance - orbit.distance) * down,
              yawOffset: lookIn - 1.2 * smooth(t, 4, TOUR_END_SECONDS),
            };
          }),
        ],
        () =>
          toast(
            "That's the whole surface for the cubic: three sheets. Each branch point glues two of them together, crossing behind its cloud. z's spirals went around two different branch points, so its trail landed on all three sheets. Then the camera walked around a branch point, so its own sheet traded places with another. Drag to look around.",
            16000
          )
      ),
      "Surface tour (3D)"
    );
  }

  getById("demoCubicOne").addEventListener("click", demoCubicOne);
  getById("demoCubicEach").addEventListener("click", demoCubicEach);
  getById("demoCubicTwo").addEventListener("click", demoCubicTwo);
  getById("demoCubicThereAndBack").addEventListener("click", demoCubicThereAndBack);
  getById("demoCubicSpiral").addEventListener("click", demoCubicSpiral);
  getById("demoCubicFar").addEventListener("click", demoCubicFar);
  getById("demoCubicCamera").addEventListener("click", demoCubicCamera);
  getById("demoCubicTour").addEventListener("click", demoCubicTour);

  //
  // Keyboard
  //
  /**
   * Once the video editor takes over the page, the keyboard belongs to it.
   * Otherwise typing in one of its text boxes would walk z around.
   */
  let videoEditorOpen = false;
  const keys = new Set<string>();
  window.addEventListener("keydown", (event) => {
    if (videoEditorOpen || event.metaKey || event.ctrlKey || event.altKey) {
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
    const minimum = BLOCK_RADIUS + 0.3;
    for (const branch of fn.branchPoints) {
      const center = toWorld(branch);
      const r = Math.hypot(hit.x - center.x, hit.z - center.z);
      if (r < minimum && r > 0) {
        hit.set(center.x + ((hit.x - center.x) * minimum) / r, hit.y, center.z + ((hit.z - center.z) * minimum) / r);
      }
    }
    clickRing.position.set(hit.x, 0.04, hit.z);
    clickRingAge = 0;
    autopilot = gotoAutopilot(activeBody(), toMath(hit.x, hit.z));
  }

  //
  // Zoom.  This changes the scale of the complex plane, not the camera.
  //
  /** Zooming out any more than this would put z inside a branch point's zone. */
  function zoneScale(z: Complex) {
    return Math.max(...fn.branchPoints.map((b) => BLOCK_RADIUS / abs(sub(z, b))));
  }
  function minimumScale() {
    let result = zoneScale(player.z);
    if (mode == "explore") {
      result = Math.max(result, zoneScale(eye.z));
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
          mode == "explore" && zoneScale(eye.z) >= zoneScale(player.z)
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
    if (videoEditorOpen) {
      return;
    }
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
    const body = activeBody();
    return fn.continueTo(cameraZ, body.w, body.z);
  }
  /** Where the camera is, in math coordinates. */
  let cameraZ = player.z;
  let cameraW = player.w;
  /**
   * z lives on the Riemann surface.  player.w (the red robot) says where:  it's continued along
   * z's path.  This says how many sheets (or levels, for log) z is above the camera's.
   * The outputs live on an ordinary plane, so they're always visible.
   */
  function zLevel() {
    if (fn == CUBIC) {
      return cubicLevel(player.z, player.w);
    }
    return fn.levels(player.w, fn.continueTo(player.z, cameraW, cameraZ));
  }

  //
  // The cubic's levels.  The camera's sheet is level 0, the floor.  The other two sheets are levels 1
  // and 2, stacked above it.  Which is which is decided by the values at the camera, followed
  // continuously from frame to frame, so the levels never jump while you watch.
  //

  /** The cubic's values at the camera for levels 1 and 2.  Level 0 is cameraW. */
  let cameraOthers: Complex[] = [];
  /** Where the camera was when cameraOthers was last updated. */
  let lastCameraZ = cameraZ;
  function trackCameraLevels() {
    let [a, b] = otherRoots(cameraW);
    if (cameraOthers.length == 2) {
      // The camera can jump, like when it gets pulled in to stay out of a cloud, so follow last frame's
      // values along the way.  Then keep each level on the value closest to its own.
      const [x, y] = cameraOthers.map((w) => fn.continueTo(cameraZ, w, lastCameraZ));
      const d = (p: Complex, q: Complex) => abs(sub(p, q));
      if (d(a, x) + d(b, y) > d(b, x) + d(a, y)) {
        [a, b] = [b, a];
      }
    } else if (wrapAngle(arg(a) - arg(cameraW)) < wrapAngle(arg(b) - arg(cameraW))) {
      // A fresh start:  any order works.  This one is the same every time.
      [a, b] = [b, a];
    }
    cameraOthers = [a, b];
    lastCameraZ = cameraZ;
  }
  /** Which level is this value of the cubic on, at z?  0, 1, or 2. */
  function cubicLevel(z: Complex, w: Complex) {
    const levels = [cameraW, ...cameraOthers].map((value) => fn.continueTo(z, value, cameraZ));
    let best = 0;
    levels.forEach((value, i) => {
      if (abs(sub(value, w)) < abs(sub(levels[best], w))) {
        best = i;
      }
    });
    return best;
  }
  /**
   * Tell the cubic's 3D floor which levels each branch point glues together, as seen from the camera,
   * and where the camera's subject is.  See cubicHeight() in world.ts.
   * snap skips the easing, for a fresh start.
   */
  function updateCubicLevels(dt: number, snap: boolean) {
    const u = floorUniforms;
    const levels = [cameraW, ...cameraOthers];
    const cameraX = camera.position.x;
    const cameraZWorld = camera.position.z;
    const subject = toWorld(activeBody().z);
    const places = CUBIC_BRANCH_POINTS.map((b) => toWorld(b));
    CUBIC_BRANCH_POINTS.forEach((b, i) => {
      // Follow each level's value along the straight line to the branch point.  Two of them meet there.
      const toward = sub(cameraZ, b);
      const near = add(b, times(toward, Math.min(0.01, (0.2 * BLOCK_RADIUS) / view.scale) / abs(toward)));
      const { double } = cubicValuesAt(b);
      const meeting = levels
        .map((w, level) => ({ level, miss: abs(sub(fn.continueTo(near, w, cameraZ), double)) }))
        .sort((x, y) => x.miss - y.miss)
        .slice(0, 2)
        .map(({ level }) => level);
      const glues = (level: number) => meeting.includes(level);
      // Which two levels a branch point glues can change, but only at the moment it's directly behind
      // another cloud, as seen from the camera.  So fade it out while it's behind one.  That way the
      // floor never jumps.
      const here = places[i];
      const distance = Math.hypot(here.x - cameraX, here.z - cameraZWorld);
      let fade = 1;
      places.forEach((other, k) => {
        const otherDistance = Math.hypot(other.x - cameraX, other.z - cameraZWorld);
        if (k != i && otherDistance < distance) {
          const separation = Math.abs(angleAround(cameraX, cameraZWorld, here.x, here.z, other.x, other.z));
          const size = Math.atan(CLOUD_RADIUS / otherDistance);
          fade = Math.min(fade, THREE.MathUtils.smoothstep(separation, 0.5 * size, 1.5 * size));
        }
      });
      // Ease toward the new values.  When the camera moves smoothly, the fade above already does the
      // work, and this barely lags.  But the camera can jump, like when it snaps in to stay out of a
      // cloud, and then this turns what would be a jump into a quick change of shape.
      const k = snap ? 1 : 1 - Math.exp(-dt * 12);
      const target01 = glues(0) && (glues(1) || glues(2)) ? fade : 0;
      const target12 = glues(2) && (glues(1) || glues(0)) ? fade : 0;
      u.uPinch01.value[i] += (target01 - u.uPinch01.value[i]) * k;
      u.uPinch12.value[i] += (target12 - u.uPinch12.value[i]) * k;
      // The camera's subject stands at the bottom of each valley.
      const phi = angleAround(here.x, here.z, cameraX, cameraZWorld, subject.x, subject.z);
      u.uSubjectPhi.value[i] = THREE.MathUtils.clamp(phi, -Math.PI + 0.3, Math.PI - 0.3);
    });
    u.uCameraW1.value.set(cameraOthers[0].re, cameraOthers[0].im);
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
    // Don't let the camera into a forbidden zone.  Pull it in toward its subject instead.
    let hit = 1;
    for (const branch of fn.branchPoints) {
      const c = toWorld(branch);
      hit = Math.min(hit, segmentEntry(focus.x - c.x, focus.z - c.z, desired.x - c.x, desired.z - c.z, CAMERA_BLOCK_RADIUS));
    }
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
    u.uCameraZ.value.set(cameraZ.re, cameraZ.im);
    u.uCameraW.value.set(cameraW.re, cameraW.im);
    u.uCameraXZ.value.set(camera.position.x, camera.position.z);
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
  const captionElement = getById("caption");
  const captionCheckbox = getById<HTMLInputElement>("showCaptions");
  let shownCaption: string | undefined;
  /** The longest the current demo has had left.  For the progress bar. */
  let demoTotal = 0;
  function updateDemoStatus() {
    const caption = captionCheckbox.checked ? autopilot?.caption?.() : undefined;
    if (caption != shownCaption) {
      shownCaption = caption;
      captionElement.textContent = caption ?? "";
      captionElement.hidden = !caption;
    }
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
  /** What the readout shows, as data.  The readout draws this as HTML, and the video editor draws it on its canvas. */
  function readoutInfo() {
    const outputs = fn.outputs(player.w);
    const rows = [
      { color: Z_COLOR, label: "z", value: format(player.z) },
      ...outputs.map((w, i) => ({ color: fn.outputColors[i], label: fn.name, value: format(w) })),
    ];
    const { major } = gridSpacing(view.scale);
    const level = zLevel();
    let where: string;
    if (level == 0) {
      where = fn == LOGARITHM ? "z is on the camera's level" : "z is on the camera's sheet";
    } else if (fn == LOGARITHM) {
      const count = Math.abs(level) == 1 ? "1 level" : `${Math.abs(level)} levels`;
      where = `z is ${count} ${level > 0 ? "above" : "below"} the camera's`;
    } else if (fn == CUBIC) {
      where = `z is on a different sheet, ${level == 1 ? "one level" : "two levels"} up from the camera's`;
    } else {
      where = "z is on the other sheet";
    }
    if (level != 0 && offSheetSelect.value == "fade") {
      where += ", so it's faded";
    }
    const notes = [
      where,
      `Grid lines every ${+major.toPrecision(6)} · zone radius ${(BLOCK_RADIUS / view.scale).toPrecision(3)}`,
    ];
    if (mode == "explore") {
      notes.push("Moving the camera only. z stays put.");
    }
    return { rows, notes };
  }

  let lastReadout = -Infinity;
  function updateReadout() {
    if (time - lastReadout < 0.1) {
      return;
    }
    lastReadout = time;
    const chip = (color: number) =>
      `<span class="chip" style="background:#${color.toString(16).padStart(6, "0")}"></span>`;
    const { rows, notes } = readoutInfo();
    readout.innerHTML = `
      <table>
        ${rows.map(({ color, label, value }) => `<tr><td>${chip(color)}${label}</td><td>${value}</td></tr>`).join("")}
      </table>
      <div class="small">${notes.join("<br>")}</div>`;
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

  /** The browser calls this once per screen refresh, while the app is running on its own. */
  function frame(timestamp: number) {
    timer.update(timestamp);
    const dt = Math.min(timer.getDelta(), 0.05);
    fitToCanvas(renderer, camera);
    fitToCanvas(outputRenderer, outputCamera);
    step(dt, readKeys());
    render();
  }

  /** Draw both views. */
  function render() {
    renderer.render(scene, camera);
    outputRenderer.render(outputScene, outputCamera);
  }

  /**
   * Move everything forward by dt seconds.  This doesn't draw.
   *
   * The video editor calls this directly, with a fixed dt and no input, so the same
   * time always gives the same picture.
   * @param holdDemo Leave the demo where it is.  Everything else keeps moving, like the
   * robots shifting their weight and the cloud drifting.  For the video editor's preroll.
   */
  function step(dt: number, input: ReturnType<typeof readKeys>, holdDemo = false) {
    time += dt;
    updateScale(dt);

    // Move z or the floating camera.
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
      if (!holdDemo) {
        speed = stepAutopilot(dt);
      }
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
    if (framing && autopilot?.exactFraming) {
      cameraRig.pitch = framing.pitch;
      cameraRig.distance = framing.distance;
      cameraRig.yawOffset = framing.yawOffset;
    } else if (framing && !pointer?.dragging) {
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
    const outputs = fn.outputs(player.w, cast.previous);

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

    placeBranchPoints();
    updateCamera(dt);
    cameraZ = toMath(camera.position.x, camera.position.z);
    cameraW = cameraValue();
    if (fn == CUBIC) {
      const fresh = cameraOthers.length == 0;
      trackCameraLevels();
      updateCubicLevels(dt, fresh);
    }
    updateFloorShape(dt);
    sheetMix += ((sheetCheckbox.checked ? 1 : 0) - sheetMix) * (1 - Math.exp(-dt * 6));
    // z stands on its own sheet.  With the 3D floor, that might be one of the see-through ones.
    const zSheet = zLevel();
    const offSheetStyle = offSheetSelect.value;
    // The other sheets are see-through.  They fade in as the 3D floor separates them from this one.
    floor.update(sheetMix, {
      count: fn == LOGARITHM ? 3 : fn == SQUARE_ROOT ? 1 : 2,
      fill: THREE.MathUtils.clamp(floorUniforms.uLift.value / (0.08 * fn.maxLift), 0, 1),
      // log's levels flatten out and just stack up far from the branch point.  √'s other sheet is
      // a ceiling that you can see all the way out, and so are the cubic's.
      fade: fn == LOGARITHM ? [16, 36] : fn == SQUARE_ROOT ? [40, 110] : [60, 150],
      // √'s other sheet covers everything, so it's mostly just grid lines.  The cubic has two of those.
      base: fn == LOGARITHM ? 0.16 : fn == SQUARE_ROOT ? 0.07 : 0.12,
    });

    standOnFloor(zCharacter.root, zCharacter.shadow, zSheet);
    standOnFloor(eyeMarker.root, eyeMarker.shadow);
    dropShadow(zSheet, offSheetStyle == "solid");
    clickRing.position.y = floorHeight(clickRing.position.x, clickRing.position.z) + 0.04;

    // z might fade when it's on the other sheet from the camera.  The outputs never fade.
    zCharacter.setOpacity(zSheet == 0 || offSheetStyle != "fade" ? 1 : OFF_SHEET_OPACITY);
    zTrail.setOffSheetOpacity(offSheetStyle == "fade" ? OFF_SHEET_TRAIL_OPACITY : 1);

    for (const b of branchPoints) {
      if (b.group.visible) {
        b.update(dt, time, floorHeight);
      }
    }
    updateReadout();
    updateDemoStatus();
  }

  // Everyone waves hello.
  setTimeout(() => {
    for (const character of [zCharacter, ...cast.characters]) {
      character.emote("Wave");
    }
  }, 700);

  renderer.setAnimationLoop(frame);

  //
  // Video editor
  //
  // Replace this page with canvas-recorder's editor, which records our two views to a video file.
  // From then on the editor drives the clock:  it calls step() with a fixed dt and render() when it
  // wants a picture.  Everything else here stays the same.
  //
  const NO_INPUT: ReturnType<typeof readKeys> = { forward: 0, turn: 0, strafe: 0, run: false };
  /** The demos the editor can show, in the order of the buttons.  Each starts fresh, the same way every time. */
  const editorDemos = [
    { name: "Narrated tour", fn: SQUARE_ROOT, start: demoNarrated },
    { name: "√z: Walk z around the branch point", fn: SQUARE_ROOT, start: demoCircle },
    { name: "√z: Walk a loop that misses it", fn: SQUARE_ROOT, start: demoMiss },
    { name: "√z: Spiral", fn: SQUARE_ROOT, start: demoSpiral },
    { name: "√z: Walk the camera around it", fn: SQUARE_ROOT, start: demoCamera },
    { name: "√z: Spiral, camera standing still", fn: SQUARE_ROOT, start: demoSpiralStillCamera },
    { name: "√z: Surface tour (3D)", fn: SQUARE_ROOT, start: demoSurfaceTour },
    { name: "log z: Circles at 2, 4, and 6", fn: LOGARITHM, start: demoLogCircles },
    { name: "log z: Walk toward the branch point", fn: LOGARITHM, start: demoLogApproach },
    { name: "log z: Spiral in, straight out", fn: LOGARITHM, start: demoLogSpiral },
    { name: "log z: Pizza slice to rectangle", fn: LOGARITHM, start: demoLogRectangle },
    { name: "log z: Parking garage (3D)", fn: LOGARITHM, start: demoLogGarage },
    { name: "log z: Walk the camera around it", fn: LOGARITHM, start: demoCamera },
    { name: "log z: Surface tour (3D)", fn: LOGARITHM, start: demoLogTour },
    { name: "Cubic: Around one branch point", fn: CUBIC, start: demoCubicOne },
    { name: "Cubic: Around each one, in turn", fn: CUBIC, start: demoCubicEach },
    { name: "Cubic: Around two at once", fn: CUBIC, start: demoCubicTwo },
    { name: "Cubic: There and back again", fn: CUBIC, start: demoCubicThereAndBack },
    { name: "Cubic: Spiral past one branch point", fn: CUBIC, start: demoCubicSpiral },
    { name: "Cubic: Spiral around all three", fn: CUBIC, start: demoCubicFar },
    { name: "Cubic: Walk the camera around one", fn: CUBIC, start: demoCubicCamera },
    { name: "Cubic: Surface tour (3D)", fn: CUBIC, start: demoCubicTour },
  ];
  getById("openVideoEditor").addEventListener("click", async () => {
    // Record mode doesn't work inside the video editor, yet.
    await recordPanel?.close();
    videoEditorOpen = true;
    keys.clear();
    renderer.setAnimationLoop(null);
    // The editor asks for exact pixel sizes.
    renderer.setPixelRatio(1);
    outputRenderer.setPixelRatio(1);
    const { openVideoEditor } = await import("./video-editor");
    openVideoEditor({
      demoNames: editorDemos.map(({ name }) => name),
      restart(demoName) {
        const demo = editorDemos.find(({ name }) => name == demoName);
        if (!demo) {
          throw new Error(`Unknown demo: ${demoName}`);
        }
        // Back to the page's starting state, so every run is the same.
        setFunction(demo.fn);
        reset();
        eye.z = START_Z;
        eye.w = player.w;
        eye.heading = Math.PI;
        eyeHidden = false;
        sheetCheckbox.checked = sheetCheckbox.defaultChecked;
        liftSlider.value = liftSlider.defaultValue;
        offSheetSelect.selectedIndex = 0;
        floorUniforms.uLift.value = 0;
        sheetMix = 0;
        time = 0;
        demo.start();
      },
      remainingSeconds: () => autopilot?.remaining?.(),
      step: (dt, hold) => step(dt, NO_INPUT, hold),
      render(sizes) {
        const pairs = [
          [renderer, camera],
          [outputRenderer, outputCamera],
        ] as const;
        pairs.forEach(([r, c], i) => {
          const { width, height } = sizes[i];
          r.getSize(rendererSize);
          if (rendererSize.x != width || rendererSize.y != height) {
            r.setSize(width, height, false);
            c.aspect = width / height;
            c.updateProjectionMatrix();
          }
        });
        render();
        return [canvas, outputCanvas];
      },
      readout: readoutInfo,
      caption: () => autopilot?.caption?.(),
    });
  });

  //
  // Record mode.  Records your voice, what you do, and what the app is doing, for planning demos.
  // Everything but this is in src/recording/.  See development-notes/record-mode.md.
  //
  /** What the app is doing, for record mode's log, 20 times a second.  Positions are math coordinates. */
  function recordingState() {
    const pair = (c: Complex) => [c.re, c.im];
    return {
      function: fn.id,
      mode,
      z: pair(player.z),
      w: pair(player.w),
      heading: player.heading,
      zLevel: zLevel(),
      eye: mode == "explore" ? { z: pair(eye.z), w: pair(eye.w), heading: eye.heading } : undefined,
      camera: {
        yaw: cameraRig.yawOffset,
        pitch: cameraRig.pitch,
        distance: cameraRig.distance,
        pull: cameraRig.pull,
        at: camera.position.toArray(),
      },
      scale: view.scale,
      targetScale,
      demo: autopilot?.title,
      remaining: autopilot?.remaining?.(),
      lift: Number(liftSlider.value),
      rainbow: sheetCheckbox.checked,
      offSheet: offSheetSelect.value,
    };
  }
  let recordPanel: { close(): Promise<void> } | undefined;
  const recordButton = getById<HTMLButtonElement>("recordMode");
  recordButton.addEventListener("click", async () => {
    if (recordPanel) {
      return;
    }
    recordButton.disabled = true;
    try {
      const { openRecordPanel } = await import("./recording/record-panel");
      recordPanel = await openRecordPanel({
        parent: getById("mainView"),
        sample: recordingState,
        describe: () => ({ app: "Riemann Walkabout", function: fn.id }),
        onClose: () => {
          recordPanel = undefined;
          recordButton.disabled = false;
        },
      });
    } catch (error) {
      console.error("Record mode", error);
      recordButton.disabled = false;
    }
  });

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
    demoNarrated,
    narrationTimes: () => [...lineTimes().values()].map(({ line, start, end }) => ({ id: line.id, start, end })),
    zLevel2: () => zLevel(),
    scale: () => view.scale,
    demoRemaining: () => autopilot?.remaining?.(),
    demoLogCircles,
    demoLogApproach,
    demoLogSpiral,
    demoLogRectangle,
    demoLogGarage,
    useLog: () => setFunction(LOGARITHM),
    useSqrt: () => setFunction(SQUARE_ROOT),
    useCubic: () => setFunction(CUBIC),
    demoCubicOne,
    demoCubicEach,
    demoCubicTwo,
    demoCubicThereAndBack,
    demoCubicSpiral,
    demoCubicFar,
    demoCubicCamera,
    demoCubicTour,
    outputs: () => cast.previous,
    parkCamera: (target: Complex, look: Complex, pitch: number, distance: number) =>
      parkCamera(target, look, pitch, distance),
    cubicPinches: () => ({
      p01: [...floorUniforms.uPinch01.value],
      p12: [...floorUniforms.uPinch12.value],
      subject: [...floorUniforms.uSubjectPhi.value],
    }),
    zOnCameraSheet,
    zLevel,
    busy: () => autopilot !== undefined,
    zHeight: () => zCharacter.root.position.y,
    zDropShadow,
    zoomBy,
  };
}

main();
