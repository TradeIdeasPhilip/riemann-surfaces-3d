import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { makeBlobShadow } from "./branchPoint";
import { CHARACTER_HEIGHT } from "./world";

let template: GLTF | undefined;
let templateScale = 1;
let templateOffset = 0;

/** Load the robot once.  If it fails we fall back to a very simple procedural figure. */
export async function loadCharacterModel(url: string) {
  try {
    template = await new GLTFLoader().loadAsync(url);
    const scene = template.scene;
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene, true);
    const height = box.max.y - box.min.y;
    templateScale =
      height > 0.01 && height < 1000 ? CHARACTER_HEIGHT / height : 0.37;
    templateOffset = Number.isFinite(box.min.y) ? -box.min.y * templateScale : 0;
  } catch (reason) {
    console.warn("Unable to load the character model.  Using a stand-in.", reason);
    template = undefined;
  }
}

/** A floating name tag, World of Warcraft style. */
class Nameplate {
  readonly sprite: THREE.Sprite;
  private readonly canvas = document.createElement("canvas");
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private lastText = "";

  /** size is relative to the height of the view. */
  constructor(
    private readonly title: string,
    private readonly color: string,
    size = 0.065
  ) {
    this.canvas.width = 512;
    this.canvas.height = 150;
    this.context = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.texture,
        toneMapped: false,
        transparent: true,
        alphaTest: 0.05,
        // Same size on the screen no matter how far away.
        sizeAttenuation: false,
      })
    );
    this.sprite.center.set(0.5, 0);
    this.sprite.scale.set((size * 512) / 150, size, 1);
    this.setValue("");
  }

  setValue(value: string) {
    if (value == this.lastText) {
      return;
    }
    this.lastText = value;
    const { context, canvas } = this;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.font = "700 72px system-ui, sans-serif";
    context.lineWidth = 10;
    context.strokeStyle = "rgba(8, 10, 20, 0.85)";
    context.strokeText(this.title, canvas.width / 2, 45);
    context.fillStyle = this.color;
    context.fillText(this.title, canvas.width / 2, 45);
    if (value) {
      // Roboto's digits are all the same width, so the text doesn't jiggle as the numbers change.
      // Main waits for this font to load before creating any nameplates.
      context.font = "500 46px Roboto, system-ui, sans-serif";
      context.lineWidth = 8;
      context.strokeText(value, canvas.width / 2, 115);
      context.fillStyle = "#e8eefc";
      context.fillText(value, canvas.width / 2, 115);
    }
    this.texture.needsUpdate = true;
  }

  setOpacity(opacity: number) {
    this.sprite.material.opacity = opacity;
  }
}

function cssColor(hex: number) {
  return "#" + hex.toString(16).padStart(6, "0");
}

/** A walking, animated character.  Used for z and for both square roots. */
export class Character {
  /** At the character's feet.  rotation.y is the heading. */
  readonly root = new THREE.Group();
  readonly nameplate: Nameplate;
  readonly shadow = makeBlobShadow(0.6);
  private readonly materials: THREE.Material[] = [];
  private mixer?: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current?: THREE.AnimationAction;
  private emoting = false;
  private headBone?: THREE.Object3D;
  /**
   * Turn the head, without the body, in radians.  Positive is to the robot's left.
   * Every animation sets the head's rotation each frame, so this is added on top, fresh each frame.
   */
  headTurn = 0;
  private opacity = 1;

  /** nameplateSize is relative to the height of the view.  Small views need bigger nameplates. */
  constructor(color: number, title: string, nameplateSize?: number) {
    this.nameplate = new Nameplate(title, cssColor(color), nameplateSize);
    this.nameplate.sprite.position.y = CHARACTER_HEIGHT + 0.35;
    this.root.add(this.nameplate.sprite, this.shadow);
    if (template) {
      this.buildFromTemplate(template, color);
    } else {
      this.buildStandIn(color);
    }
  }

  get heading() {
    return this.root.rotation.y;
  }
  set heading(value: number) {
    this.root.rotation.y = value;
  }

  private buildFromTemplate(gltf: GLTF, color: number) {
    const model = SkeletonUtils.clone(gltf.scene);
    model.scale.setScalar(templateScale);
    model.position.y = templateOffset;
    // Every character gets its own copy of each material, so we can tint and fade them separately.
    const copies = new Map<THREE.Material, THREE.Material>();
    model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) {
        return;
      }
      const original = mesh.material as THREE.MeshStandardMaterial;
      let copy = copies.get(original) as THREE.MeshStandardMaterial | undefined;
      if (!copy) {
        copy = original.clone();
        if (original.name == "Main") {
          copy.color.setHex(color);
        }
        copies.set(original, copy);
        this.materials.push(copy);
      }
      mesh.material = copy;
    });
    this.root.add(model);
    model.traverse((object) => {
      if ((object as THREE.Bone).isBone && object.name == "Head") {
        this.headBone = object;
      }
    });
    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) {
      const action = this.mixer.clipAction(clip);
      if (["No", "Wave", "Yes", "ThumbsUp"].includes(clip.name)) {
        action.loop = THREE.LoopOnce;
        action.clampWhenFinished = true;
      }
      this.actions.set(clip.name, action);
    }
    this.mixer.addEventListener("finished", () => {
      this.emoting = false;
    });
    this.fadeTo("Idle", 0);
  }

  /** A capsule with a face.  Only used if the robot doesn't load. */
  private buildStandIn(color: number) {
    const body = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x111111 });
    this.materials.push(body, dark);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.7, 8, 16), body);
    torso.position.y = 0.67;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 24, 16), body);
    head.position.y = 1.4;
    const eyeGeometry = new THREE.SphereGeometry(0.05, 12, 8);
    for (const x of [-0.1, 0.1]) {
      const eye = new THREE.Mesh(eyeGeometry, dark);
      eye.position.set(x, 1.45, 0.25);
      this.root.add(eye);
    }
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.15, 12), body);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 1.38, 0.32);
    this.root.add(torso, head, nose);
  }

  private fadeTo(name: string, duration = 0.25) {
    const next = this.actions.get(name);
    if (!next || next == this.current) {
      return;
    }
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(duration).play();
    this.current?.fadeOut(duration);
    this.current = next;
  }

  /** Play a one time animation, like "Wave" or "No". */
  emote(name: string) {
    if (!this.actions.has(name) || this.emoting) {
      return;
    }
    this.emoting = true;
    this.fadeTo(name, 0.2);
  }

  /** speed is in world units per second.  It chooses between idle, walk, and run. */
  animate(dt: number, speed: number) {
    if (!this.mixer) {
      // The stand-in has no animations.
      return;
    }
    if (this.emoting && speed > 0.5) {
      this.emoting = false;
    }
    if (!this.emoting) {
      if (speed < 0.15) {
        this.fadeTo("Idle");
      } else if (speed < 6.5) {
        this.fadeTo("Walking");
        this.current!.setEffectiveTimeScale(THREE.MathUtils.clamp(speed / 3.2, 0.2, 2.2));
      } else {
        this.fadeTo("Running");
        this.current!.setEffectiveTimeScale(THREE.MathUtils.clamp(speed / 8, 0.7, 2.5));
      }
    }
    this.mixer.update(dt);
    const head = this.headBone;
    if (head && this.headTurn != 0) {
      // Turn around the world's up direction, expressed in the head's own frame.
      head.updateWorldMatrix(true, false);
      const worldRotation = head.getWorldQuaternion(new THREE.Quaternion());
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(worldRotation.invert());
      head.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(up, this.headTurn));
    }
  }

  setOpacity(opacity: number) {
    if (opacity == this.opacity) {
      return;
    }
    const wasTransparent = this.opacity < 1;
    this.opacity = opacity;
    const transparent = opacity < 1;
    for (const material of this.materials) {
      material.opacity = opacity;
      material.transparent = transparent;
      material.depthWrite = !transparent;
      if (transparent != wasTransparent) {
        material.needsUpdate = true;
      }
    }
    this.nameplate.setOpacity(Math.max(opacity, 0.35));
  }
}

/** The floating eyeball that stands in for the camera when you're exploring. */
export class FloatingEye {
  readonly root = new THREE.Group();
  readonly nameplate = new Nameplate("camera", "#f2f2ff");
  readonly shadow = makeBlobShadow(0.45);
  private readonly ball = new THREE.Group();

  constructor() {
    const white = new THREE.MeshStandardMaterial({
      color: 0xf4f4ff,
      roughness: 0.25,
      emissive: 0x334466,
    });
    const iris = new THREE.MeshStandardMaterial({ color: 0x3a8cff, roughness: 0.3 });
    const pupil = new THREE.MeshBasicMaterial({ color: 0x050505 });
    const eyeball = new THREE.Mesh(new THREE.SphereGeometry(0.38, 32, 24), white);
    const irisMesh = new THREE.Mesh(new THREE.CircleGeometry(0.2, 32), iris);
    irisMesh.position.z = 0.36;
    const pupilMesh = new THREE.Mesh(new THREE.CircleGeometry(0.09, 24), pupil);
    pupilMesh.position.z = 0.385;
    this.ball.add(eyeball, irisMesh, pupilMesh);
    this.ball.position.y = 1.5;
    this.nameplate.sprite.position.y = 2.05;
    this.root.add(this.ball, this.nameplate.sprite, this.shadow);
  }

  get heading() {
    return this.root.rotation.y;
  }
  set heading(value: number) {
    this.root.rotation.y = value;
  }

  animate(time: number) {
    this.ball.position.y = 1.5 + 0.08 * Math.sin(time * 2.2);
  }
}
