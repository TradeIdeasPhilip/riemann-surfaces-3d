# √z Walkabout

A 3D, walk-around version of [Riemann Surfaces and Multi-Valued Functions](https://tradeideasphilip.github.io/riemann-surfaces/).

The floor is the complex plane. You steer **z** (green). The two square roots of z (red and blue)
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
  the camera is on the same sheet. The optional floor coloring shows the branch of √z that agrees with
  the camera. Its cut is directly behind the cloud. Walk the camera once around the branch point and you're
  on the other sheet.

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
