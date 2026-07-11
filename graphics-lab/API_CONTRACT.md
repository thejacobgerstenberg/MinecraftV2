# graphics-lab

A standalone Three.js voxel graphics demo. Three.js is **vendored locally** under
`vendor/` — there is **no runtime CDN**. Serve the folder over HTTP and open
`index.html`:

```bash
npm run serve      # python3 -m http.server 8099  ->  http://localhost:8099/
```

Vendored: `three` r160 (`vendor/three.module.js`) + `OrbitControls`
(`vendor/OrbitControls.js`), resolved through the importmap in `index.html`.

---

## GRAPHICS-LAB API CONTRACT (read fully before writing code)

GRAPHICS-LAB API CONTRACT (read fully before writing code)

Root dir: /home/user/MinecraftV2/graphics-lab
Branch: feature/graphics-lab (already checked out; DO NOT run git yourself unless told)
All source lives in graphics-lab/src/*.js as native ES modules.
Three.js is VENDORED locally at graphics-lab/vendor/three.module.js and imported via
the bare specifier "three" (an importmap in index.html maps it). NEVER import three from a CDN.
OrbitControls vendored at graphics-lab/vendor/OrbitControls.js (import "three/addons/OrbitControls.js" via importmap, or relative path — check index.html importmap).

Coordinate system: Y is up. 1 voxel = 1 world unit. Water level y = WATER_LEVEL (exported by worldgen).

Volume format (produced by src/worldgen.js -> generateDemoChunk()):
  {
    sx, sy, sz,                      // dimensions
    get(x,y,z) -> blockId (0 = air), // safe: out-of-range returns 0
    isSolid(x,y,z) -> bool,          // true if block occludes (not air, not water)
    isOpaque(x,y,z) -> bool,         // solid AND not water/leaves-transparent
    WATER_LEVEL,
    blocks: [{x,y,z,id}],            // convenience list of non-air
    lights: [{x,y,z}],               // torch positions (for point lights + flame particles)
  }
Block ids/palette (src/blocks.js exports BLOCKS): 0 air,1 grass,2 dirt,3 stone,4 sand,5 wood,6 leaves,7 water,8 plank,9 glowstone,10 snow. Each block has {name, color:[r,g,b] 0..1, top?, side?, bottom? color overrides, transparent?:bool, emissive?:[r,g,b]}.

Every effect module exports a class with this shape (adapt args as noted):
  class Xxx {
    constructor(opts)          // opts documented per module
    update(dt, ctx)            // ctx = { camera, renderer, scene, elapsed, timeOfDay(0..1), sunDir:THREE.Vector3, weather:'clear'|'rain'|'snow', underwater:bool }
    setEnabled(bool)           // toggle the whole effect on/off cleanly
    get enabled() -> bool
    dispose()
  }
Effects that add scene objects expose a THREE.Object3D via .object3d (add it to the scene once).

The demo entry (src/demo.js, written by the integrator) MUST expose a global window.demo with:
  demo.setTimeOfDay(t 0..1)   // 0=midnight,0.25=sunrise,0.5=noon,0.75=sunset
  demo.setWeather('clear'|'rain'|'snow')
  demo.setUnderwater(bool)    // dips the camera below WATER_LEVEL for the underwater shot
  demo.setQuality('low'|'medium'|'high'|'ultra')
  demo.toggle(name, bool)     // name in: 'ao','sky','shadows','water','post','particles','fog'
and sets window.__demoReady = true after the first frame renders.

Performance target: 60fps at 'medium' on software WebGL. Keep shaders lean, avoid per-frame allocations, reuse geometries/materials.
Do NOT edit index.html, demo.js, gui.js, or any file that is not your assigned file. Do NOT run git. Write ONLY your assigned module file(s).

---

## Files

```
graphics-lab/
  index.html            # canvas, importmap (three -> ./vendor/...), loading screen, #gui
  package.json          # name graphics-lab, type module, "serve" script
  vendor/
    three.module.js     # THREE r160 (vendored, no CDN)
    OrbitControls.js    # imports bare 'three'
  src/
    blocks.js           # BLOCKS palette + id constants + helpers
    worldgen.js         # generateDemoChunk() -> Volume (see contract)
    gui.js              # createGUI(demo, state) control panel + FPS
    demo.js             # PLACEHOLDER entry (integrator replaces)
  screenshots/          # capture output
```

---

## Per-module status & TODO

### `src/blocks.js` — DONE
Exports `BLOCKS` (id === array index), id constants (`GRASS`, `WATER`, …), and
helpers `getBlock`, `isAir`, `isTransparent`, `isSolidId`, `isOpaqueId`,
`faceColor(id, face)`. Each block: `{name, color, top?/side?/bottom?,
topShade?/sideShade?/bottomShade?, transparent?, opacity?, emissive?}`.
- TODO (optional): add per-face texture atlas UVs once a texture pass exists.

### `src/worldgen.js` — DONE
`generateDemoChunk()` returns the full Volume (48×32×48, `WATER_LEVEL = 10`).
Deterministic (seeded hash noise, no `Math.random`). Contains rolling hills,
carved lake + sand beach, snow peaks, trees, a plank cabin (walls, doorway,
windows, gable roof), and glowstone `lights[]` on the cabin + lakeside.
- TODO (optional): cave/overhang carving; biome variation; more structures.

### `src/gui.js` — DONE
`createGUI(demo, state)` injects CSS + builds the top-right panel: effect
checkboxes (`ao, sky, shadows, water, post, particles, fog`), quality dropdown,
time-of-day slider, weather selector, underwater checkbox, live FPS counter.
All controls call the `window.demo` API. Returns `{ root, dispose() }`.
- TODO (optional): collapse/expand; persist state to localStorage.

### `src/demo.js` — PLACEHOLDER (integrator to replace)
Renders the volume as instanced colored cubes (exposed blocks only), frames an
OrbitControls camera, wires a minimal `window.demo`, builds the GUI, sets
`window.__demoReady = true`.
- TODO (integrator): swap plain cubes for the real greedy-meshed chunk; wire the
  effect modules (AO, sky, shadows, water, post, particles, fog) through the
  shared `update(dt, ctx)` contract; implement full quality tiers and weather.

### Effect modules — NOT YET WRITTEN
Each will export a class with `constructor(opts)`, `update(dt, ctx)`,
`setEnabled(bool)`, `get enabled()`, `dispose()`, and (if it adds scene objects)
an `.object3d`. `ctx = { camera, renderer, scene, elapsed, timeOfDay, sunDir,
weather, underwater }`.
