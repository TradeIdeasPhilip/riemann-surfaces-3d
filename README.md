# Riemann Walkabout

Riemann surfaces in 3D, for √z and log z.  A walk-around version of
[Riemann Surfaces and Multi-Valued Functions](https://tradeideasphilip.github.io/riemann-surfaces/).

**[Try it live](https://tradeideasphilip.github.io/riemann-surfaces-3d/)** ·
**[Watch the narrated tour on YouTube](https://www.youtube.com/watch?v=btTi0iAX6tw)**

The floor is the complex plane. You steer **z** (green). Its outputs (red and blue for √z)
walk wherever they have to, and everyone leaves a trail. A glowing column of mist sits on the branch
point. It's infinitely tall, so from wherever the camera is, it hides the ray of floor directly behind
the branch point. That ray is the branch cut, so whatever you can see is analytic.

```
npm install
npm run dev
```

## Controls

| | |
|---|---|
| W/S or ↑/↓ | walk forward / back |
| A/D or ←/→ | turn |
| Q/E | sidestep |
| Shift | run |
| Click the floor | walk there (around the branch point if needed) |
| Drag | look around (the camera swings back behind you when you walk) |
| Right-drag | steer |
| Scroll / pinch, or +/− | zoom the complex plane |
| Shift + scroll | camera distance |
| C or Tab | switch between moving z and moving only the camera |
| Esc | stop a demo |

## Functions

- **√z**: two sheets.  The two square roots trade places each time z goes around the branch point.
- **log z**: infinitely many sheets, stacked like a parking garage.  We draw 5 of the values: z's own
  (red), and 2π𝒾 and 4π𝒾 above and below it.  With the 3D floor on, the floor is the spiral ramp, and the
  levels above the camera's are drawn see-through near the branch point.

Each function is one object in `src/functions.ts`.  Everything else (the floor, the camera's sheet, which
things fade) works through that interface, using the "total angle" around the branch point.

## How it works

- `src/world.ts` maps math coordinates to world coordinates. The branch point is always at the world origin.
  Zooming changes only `view.scale`. Characters, the cloud, and the forbidden zone keep a fixed world
  size, so zooming in shrinks the zone in math units.
- z and the floating camera are blocked at `BLOCK_RADIUS`. The real camera is pulled in toward its
  subject (like a game camera hitting a wall) so it never enters the zone either.
- The roots follow z by analytic continuation: each frame, pick whichever root of z is closest to last
  frame's answer (`sqrtNear`).
- **Sheets.** The camera's subject (z, or the floating eye) carries its own square root, so it knows which
  sheet it's on. The camera is tied to its subject by a segment that never crosses the branch point, so
  the camera is on the same sheet. The optional rainbow floor shows the branch of √z that agrees with
  the camera. Its cut is directly behind the cloud. Walk the camera once around the branch point and you're
  on the other sheet.
- **Who fades.** z lives on the Riemann surface; the square roots live on an ordinary plane. So the roots
  are always solid, and z (and the parts of its trail) fade when they're on the other sheet from the camera.
  That happens when the camera, or z, goes around the branch point an odd number of times. The switch
  always happens directly behind the cloud, so you never see it happen.
- Numbers over the robots use Roboto (bundled from `@fontsource/roboto`) because its digits are all the
  same width, so the labels don't jiggle as the numbers change.
- **Rainbow floor.** Nine solid wedges ([myRainbow](https://github.com/TradeIdeasPhilip/canvas-recorder/blob/master/src/glib/my-rainbow.ts)),
  by the angle of √z. All nine go around once per turn of √z, which is two turns of z, so each sheet
  shows half the rainbow.
- **3D floor.** The floor is the Riemann surface, embedded in 3D. For √z the camera's sheet is an opaque
  valley, level under whatever the camera is following and rising on both sides toward the cut. The other
  sheet is a see-through ceiling coming down on both sides. They meet at the cut, behind the cloud, which is
  the only place the surface crosses itself. For log it's a spiral ramp. The floor is a polar mesh whose
  seam always points directly away from the camera (`src/floor.ts`). `floorHeight()` in `src/world.ts`
  computes the same height for everything that stands on the floor.
- **Two views.** z's world is on the left. The outputs live on an ordinary plane, so they get their own
  small view on the right, with a camera that follows them and zooms to fit.

## Publishing

Every push to `master` builds the site and publishes it to GitHub Pages, using
[.github/workflows/deploy.yml](.github/workflows/deploy.yml). The compiled output is never committed:
`dist/` is in `.gitignore`, and the Actions run builds a fresh copy each time. To redeploy without a
new commit, use **Actions → Deploy to GitHub Pages → Run workflow**.

One-time setup: in the GitHub repo, **Settings → Pages → Build and deployment → Source: GitHub Actions**.

`npm run build` also runs `tsc`, so a type error fails the deploy and the live site keeps the last
good version.

## Credits

Robot model: "RobotExpressive" by [Tomás Laulhé (Quaternius)](https://quaternius.com/), CC0 1.0,
with modifications by [Don McCurdy](https://donmccurdy.com/). Copied from the
[three.js examples](https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf/RobotExpressive).

## Finding more 3D models like the robot

The robot is a **rigged and animated 3D character**:  a mesh, plus a skeleton (the **rig**, with bones
like Head and Arm.L), **animation clips** (Idle, Walking, Running, Wave, No, …), and **morph targets**
(also called blend shapes) for facial expressions.  The file format is **glTF / GLB**.  Good search terms:
"rigged animated character glTF", "CC0 animated character", "game-ready low poly character".

- [Quaternius](https://quaternius.com):  the artist who made the robot.  Lots of free CC0 packs of
  characters, animals and monsters, with animations already in them.  A consistent style, and the
  easiest license.
- [Poly Pizza](https://poly.pizza):  a search engine for free low-poly models, including all of
  Quaternius, with previews in the browser.
- [Kenney](https://kenney.nl/assets):  another huge CC0 library, with a few animated character sets.
- [Sketchfab](https://sketchfab.com):  the biggest showcase.  Every model spins in the browser, and you
  can play its animations.  Filter by "Downloadable", "Animated" and "Rigged".  Licenses vary, so check
  each one.
- [Mixamo](https://www.mixamo.com):  free from Adobe.  Hundreds of human motion clips, and it can rig
  a character you upload.  Downloads are FBX; Blender converts them to glTF.
- [three.js examples](https://threejs.org/examples/?q=skinning):  search "skinning" or "animation".
  That's where the robot came from, along with a soldier and a dancer, each with working code.
- [glTF viewer](https://gltf-viewer.donmccurdy.com):  drop in a GLB file to see its animations, morph
  targets and skeleton before you decide to use it.

CC0 (Quaternius, Kenney) is the easiest choice for videos:  no credit required, and safe for YouTube.
