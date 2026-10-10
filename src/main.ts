import * as THREE from "three";
import "@fontsource/roboto/latin-500.css";
import "./style.css";
import { BranchPoint } from "./branchPoint";
import { Character, FloatingEye, loadCharacterModel } from "./characters";
import {
  abs,
  arg,
  complex,
  dot,
  format,
  negate,
  sqrtNear,
  sqrtPrincipal,
  type Complex,
} from "./complex";
import { Floor } from "./floor";
import { OFF_SHEET_OPACITY, Trail } from "./trail";
import {
  BLOCK_RADIUS,
  BLUE_COLOR,
  CAMERA_BLOCK_RADIUS,
  floorHeight,
  floorNormal,
  floorUniforms,
  FOG_DENSITY,
  gridSpacing,
  headingToward,
  RED_COLOR,
  SKY_COLOR,
  toMath,
  toWorld,
  turnToward,
  view,
  wrapAngle,
  Z_COLOR,
} from "./world";

const WALK_SPEED = 5;
const RUN_SPEED = 11;
const TURN_SPEED = 2.4;
/** The 3D floor slider at its maximum.  See floorUniforms in world.ts. */
const MAX_LIFT = 1.2;
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
  scene.add(floor.mesh, floor.labels);

  const branchPoint = new BranchPoint();
  scene.add(branchPoint.group);

  // The nameplates draw with Roboto on a canvas, which won't wait for the font by itself.
  await Promise.all([
    loadCharacterModel("models/RobotExpressive.glb"),
    document.fonts.load("500 46px Roboto").catch(() => undefined),
  ]);

  const zCharacter = new Character(Z_COLOR, "z");
  const redCharacter = new Character(RED_COLOR, "√z");
  const blueCharacter = new Character(BLUE_COLOR, "√z");
  const eyeMarker = new FloatingEye();
  eyeMarker.root.visible = false;
  scene.add(zCharacter.root, redCharacter.root, blueCharacter.root, eyeMarker.root);

  const zTrail = new Trail(Z_COLOR, 0.34, 0.02, true);
  const redTrail = new Trail(RED_COLOR, 0.28, 0.025);
  const blueTrail = new Trail(BLUE_COLOR, 0.28, 0.03);
  const trails = [zTrail, redTrail, blueTrail];
  scene.add(...trails.map((trail) => trail.mesh));

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
    w: sqrtPrincipal(START_Z),
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
  let previousRed = player.w;

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
    for (const trail of trails) {
      trail.clear();
    }
  }
  getById("clearTrails").addEventListener("click", clearTrails);

  function reset() {
    setMode("walk");
    autopilot = undefined;
    player.z = START_Z;
    player.w = sqrtPrincipal(START_Z);
    previousRed = player.w;
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
    body.w = sqrtNear(body.z, body.w);
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
  };
  let autopilot: Autopilot | undefined;

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
        // Slow down in the tight curls near the middle.
        const speed = topSpeed * THREE.MathUtils.clamp(r / 3, 0.3, 1);
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

  //
  // Demos
  //
  function demoCircle() {
    setMode("walk");
    clearTrails();
    const radius = Math.max(abs(player.z), (BLOCK_RADIUS + 2) / view.scale);
    autopilot = circleAutopilot(player, complex(0, 0), radius, () =>
      toast(
        "One lap around the branch point. z is back where it started, but the two square roots traded places! Go around again and they trade back.",
        9000
      )
    );
  }
  function demoMiss() {
    setMode("walk");
    clearTrails();
    // A circle that passes through z and stays on the far side, away from the branch point.
    const radius = 6 / view.scale;
    const out = normalize(player.z);
    const center = { re: player.z.re + out.re * radius, im: player.z.im + out.im * radius };
    autopilot = circleAutopilot(player, center, radius, () =>
      toast(
        "That loop didn't go around the branch point, so each square root came back to where it started.",
        8000
      )
    );
  }
  function demoSpiral() {
    setMode("walk");
    clearTrails();
    autopilot = spiralAutopilot(player, () =>
      toast(
        "The first two loops were too small to go around the branch point, so each square root just traced a little spiral of its own. Once the loops were big enough to go around it, each lap carried the roots half way around.",
        11000
      )
    );
  }
  function demoCamera() {
    setMode("explore");
    sheetCheckbox.checked = true;
    const radius = Math.max(abs(eye.z), (BLOCK_RADIUS + 2) / view.scale);
    autopilot = circleAutopilot(eye, complex(0, 0), radius, () => {
      toast(
        zOnCameraSheet()
          ? "Only the camera moved, and it went around the branch point, so it switched sheets. That put it back on z's sheet: z is solid again, and the floor's colors are back where they started."
          : "Only the camera moved, but it went around the branch point, so now it's on the other sheet. The floor's colors flipped, and z faded out because it's not on this sheet. The square roots never fade: they live on an ordinary plane. Go around again to get back.",
        12000
      );
    });
  }
  /**
   * The same spiral, but the camera stands still, off to one side, where it can see everything.
   * Each time z crosses the cut, directly behind the cloud, it switches to the other sheet from
   * the camera and fades.  The next time it comes back.
   */
  function demoSpiralStillCamera() {
    setMode("explore");
    clearTrails();
    sheetCheckbox.checked = true;
    const start = player.z;
    const startDistance = abs(start) * view.scale;
    // The camera looks at a point half way between z and the branch point.  Sliding straight
    // toward the branch point doesn't change sheets, so the camera starts on z's sheet.
    const fraction = THREE.MathUtils.clamp((BLOCK_RADIUS + 0.5) / startDistance, 0.5, 1);
    eye.z = { re: start.re * fraction, im: start.im * fraction };
    eye.w = sqrtNear(eye.z, player.w);
    // Look from 45° clockwise of straight out.  That puts the cut, directly behind the cloud,
    // away from the spiral's landmarks, which are all on the line through z and the branch point.
    // The camera looks the opposite way, toward the branch point and 45° counterclockwise.
    const out = normalize(start);
    const lookDirection = {
      re: -(out.re + out.im) * Math.SQRT1_2,
      im: -(out.im - out.re) * Math.SQRT1_2,
    };
    eye.heading = headingToward(lookDirection.re, -lookDirection.im);
    eyeHidden = true;
    // Back up far enough to see the whole spiral.
    const outerRadius = startDistance + 3 * (BLOCK_RADIUS + 0.4);
    cameraRig.yawOffset = 0;
    cameraRig.pitch = 0.8;
    cameraRig.distance = THREE.MathUtils.clamp(outerRadius * 2.2, 25, 150);
    cameraRig.pull = 1;
    autopilot = spiralAutopilot(
      player,
      () =>
        toast(
          "The camera never moved. The small loops stayed in front of the cloud, so z stayed on the camera's sheet. The first big loop took z behind the cloud, across the cut, onto the other sheet, so it faded. The next big loop brought it back. The square roots never fade: they live on an ordinary plane.",
          14000
        ),
      false
    );
  }
  getById("demoCircle").addEventListener("click", demoCircle);
  getById("demoMiss").addEventListener("click", demoMiss);
  getById("demoSpiral").addEventListener("click", demoSpiral);
  getById("demoCamera").addEventListener("click", demoCamera);
  getById("demoSpiralStill").addEventListener("click", demoSpiralStillCamera);

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
   * So the camera is on the same sheet as its subject.  The floor shows the branch of √z that agrees
   * with the camera, and its cut is the ray directly behind the branch point, hidden by the cloud.
   */
  function cameraSheetDirection() {
    const cameraZ = toMath(camera.position.x, camera.position.z);
    return normalize(sqrtNear(cameraZ, activeBody().w));
  }
  let sheetDirection = cameraSheetDirection();
  /**
   * z lives on the Riemann surface.  player.w (the red root) says where:  it's continued along
   * z's path.  The camera's sheet agrees with z if its value of √z here is the same as player.w.
   * The square roots live on an ordinary plane, so they're always visible.
   */
  function zOnCameraSheet() {
    return dot(player.w, sheetDirection) >= 0;
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

  /** Put something on the floor, and tilt its shadow to match the floor. */
  const shadowNormal = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  function standOnFloor(root: THREE.Object3D, shadow: THREE.Object3D) {
    const { x, z } = root.position;
    root.position.y = floorHeight(x, z);
    floorNormal(x, z, shadowNormal).applyAxisAngle(up, -root.rotation.y);
    shadow.quaternion.setFromUnitVectors(up, shadowNormal);
  }

  /**
   * Tell the floor shaders and floorHeight() where the camera is and which sheet it's on.
   * Everything that sits on the floor needs this before it can find its height.
   */
  function updateFloorShape(dt: number) {
    const u = floorUniforms;
    u.uSheetDir.value.set(sheetDirection.re, sheetDirection.im);
    const focus = normalize(activeBody().w);
    u.uFocusDir.value.set(focus.re, focus.im);
    u.uCameraAngle.value = Math.atan2(-camera.position.z, camera.position.x);
    const wanted = Number(liftSlider.value) * MAX_LIFT;
    const lift = u.uLift.value + (wanted - u.uLift.value) * (1 - Math.exp(-dt * 6));
    u.uLift.value = Math.abs(lift - wanted) < 1e-4 ? wanted : lift;
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
    const red = player.w;
    const blue = negate(player.w);
    const { major } = gridSpacing(view.scale);
    readout.innerHTML = `
      <table>
        <tr><td>${chip(Z_COLOR)}z</td><td>${format(player.z)}</td></tr>
        <tr><td>${chip(RED_COLOR)}√z</td><td>${format(red)}</td></tr>
        <tr><td>${chip(BLUE_COLOR)}√z</td><td>${format(blue)}</td></tr>
      </table>
      <div class="small">
        ${zOnCameraSheet() ? "z is on the camera's sheet" : "z is on the other sheet, so it's faded"}<br>
        Grid lines every ${+major.toPrecision(6)} · zone radius ${(BLOCK_RADIUS / view.scale).toPrecision(3)}
        ${mode == "explore" ? "<br>Moving the camera only. z stays put." : ""}
      </div>`;
  }

  //
  // Main loop
  //
  const timer = new THREE.Timer();
  let time = 0;

  function resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  function maybeAddToTrail(trail: Trail, z: Complex, w?: Complex) {
    const last = trail.last;
    if (!last || abs(sub(z, last)) * view.scale > 0.12) {
      trail.add(z, w);
    }
  }

  /** Face the direction a root is moving.  Returns its speed in world units per second. */
  function steerRoot(character: Character, step: Complex, dt: number) {
    const speed = (abs(step) * view.scale) / dt;
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

    // The square roots follow z continuously.  This is analytic continuation, one small step at a time.
    player.w = sqrtNear(player.z, player.w);
    const redStep = sub(player.w, previousRed);
    previousRed = player.w;
    const red = player.w;
    const blue = negate(red);

    // Characters
    toWorld(player.z, 0, zCharacter.root.position);
    zCharacter.heading = player.heading;
    zCharacter.animate(dt, moving == player ? speed : 0);
    zCharacter.nameplate.setValue(format(player.z));

    toWorld(red, 0, redCharacter.root.position);
    toWorld(blue, 0, blueCharacter.root.position);
    const rootSpeed = steerRoot(redCharacter, redStep, dt);
    steerRoot(blueCharacter, negate(redStep), dt);
    redCharacter.animate(dt, rootSpeed);
    blueCharacter.animate(dt, rootSpeed);
    redCharacter.nameplate.setValue(format(red));
    blueCharacter.nameplate.setValue(format(blue));

    toWorld(eye.z, 0, eyeMarker.root.position);
    eyeMarker.heading = eye.heading;
    eyeMarker.animate(time);
    eyeMarker.root.visible = mode == "explore" && !eyeHidden;

    maybeAddToTrail(zTrail, player.z, player.w);
    maybeAddToTrail(redTrail, red);
    maybeAddToTrail(blueTrail, blue);
    for (const trail of trails) {
      trail.update();
    }

    clickRingAge += dt;
    clickRing.visible = clickRingAge < 0.7;
    if (clickRing.visible) {
      clickRing.scale.setScalar(1.4 - clickRingAge);
      clickRing.material.opacity = 1 - clickRingAge / 0.7;
    }

    updateCamera(dt);
    sheetDirection = cameraSheetDirection();
    updateFloorShape(dt);
    sheetMix += ((sheetCheckbox.checked ? 1 : 0) - sheetMix) * (1 - Math.exp(-dt * 6));
    floor.update(view.scale, sheetMix);

    standOnFloor(zCharacter.root, zCharacter.shadow);
    standOnFloor(redCharacter.root, redCharacter.shadow);
    standOnFloor(blueCharacter.root, blueCharacter.shadow);
    standOnFloor(eyeMarker.root, eyeMarker.shadow);
    clickRing.position.y = floorHeight(clickRing.position.x, clickRing.position.z) + 0.04;

    // z fades when it's on the other sheet from the camera.  The square roots never fade.
    zCharacter.setOpacity(zOnCameraSheet() ? 1 : OFF_SHEET_OPACITY);

    branchPoint.update(dt, time, floorHeight);
    updateReadout();
    renderer.render(scene, camera);
  }

  // Start with the roots facing us, and everyone waving hello.
  redCharacter.heading = 0;
  blueCharacter.heading = 0;
  setTimeout(() => {
    for (const character of [zCharacter, redCharacter, blueCharacter]) {
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
    zOnCameraSheet,
    zoomBy,
  };
}

main();
