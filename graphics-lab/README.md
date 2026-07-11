# graphics-lab

Standalone showcase of production-quality rendering modules for a Three.js voxel
game. Every module in `src/` is written against a shared effect contract
(`update(dt, ctx)` / `setEnabled(bool)` / `get enabled` / `dispose()`, plus an
`.object3d` when the module adds scene objects) so the builder session can lift
them into the main game one at a time. Three.js **r160 is vendored** under
`vendor/` (no CDN, resolved through the importmap in `index.html`).

This README is the integration guide: exact public APIs (verified against the
source), the per-frame wiring `demo.js` uses, and honest perf/limitation notes.

## Running the demo

```bash
cd graphics-lab
python3 -m http.server 8099        # or: npm run serve
# open http://localhost:8099/index.html
# clean beauty shots (no control panel): http://localhost:8099/index.html?nogui=1
```

`window.demo` exposes the scriptable control API (`setTimeOfDay(t)`,
`setWeather('clear'|'rain'|'snow')`, `setUnderwater(bool)`,
`setQuality('low'|'medium'|'high'|'ultra')`,
`toggle(name, bool)` for `ao|sky|shadows|water|post|particles|fog`, plus
`setView('hero'|'sunrise'|'closeup'|'firstperson'|'portal'|'torches')`), and `window.__demoReady === true` after
the first rendered frame. `window.__gui.hide()/show()` toggles the panel from
automation scripts. `verify.mjs` is the headless Playwright harness that
produced the screenshots below.

## Screenshot gallery

| Shot | Caption |
|---|---|
| ![day](./screenshots/01-day.png) | Day (t=0.35): textured AO-meshed chunk, dynamic sky + clouds, soft sun shadows, waving water, block-break debris. |
| ![night](./screenshots/02-night.png) | Night (t=0.85): star field, square pixel moon, cool moonlight key, glowstone torch flames blooming wide (auto night boost). |
| ![rain](./screenshots/03-rain.png) | Rain: storm-grey sky grade, dimmed sun, wind-tilted rain streaks, splash rings on the water surface, thicker fog. |
| ![underwater](./screenshots/04-underwater.png) | Underwater: dense blue-green murk, full-screen tint, surface visible overhead, sky hidden so no white void leaks through. |
| ![snow](./screenshots/05-snow.png) | Snow: cool steel-blue grade, dense swaying flakes, softened light. |
| ![sunrise](./screenshots/06-sunrise.png) | Sunrise (t=0.25): warm horizon band + square sun disc, fog tinted to the exact sky colour, long golden-hour shadows. |
| ![closeup](./screenshots/07-closeup.png) | Close-up at the cabin: 16x16 procedural atlas textures, per-vertex corner AO in the crevices, torch flame + smoke particles. |

## Module catalog

All modules are native ES modules importing the bare specifier `three`.
Shared `ctx` shape (see "Integration guide" for the demo's exact object):
`{ camera, renderer, scene, elapsed, timeOfDay (0..1), sunDir: THREE.Vector3,
weather: 'clear'|'rain'|'snow', underwater: bool, skyColor?: THREE.Color }`.

### voxelMesher.js + voxelMaterial.js + textures.js — the chunk pipeline

**What it does.** `textures.js` paints twelve deterministic 16x16 pixel-art
tiles (seeded mulberry32, zero `Math.random`) into one 64x64 canvas atlas.
`voxelMesher.js` converts a voxel volume into face-culled geometry with classic
0fps per-vertex corner AO (with the quad-flip so triangulation follows the
darker diagonal — no AO seams) and atlas UVs inset by half a texel against
bleeding. `voxelMaterial.js` is a `MeshStandardMaterial` patched via
`onBeforeCompile` to multiply the mesher's custom `ao` attribute into the
diffuse albedo — so Three.js shadows, fog and lights all keep working.

**Public API.**

```js
// textures.js
createBlockAtlas({ seed = 1337 } = {}) -> {
  texture,            // THREE.CanvasTexture, NearestFilter, no mipmaps, sRGB
  canvas,             // backing 64x64 canvas (debug)
  tileUV(name),       // -> { u0, v0, u1, v1 } (v respects flipY)
  faceTile(id, face), // blockId + 'top'|'side'|'bottom' -> tile name
  TILES, FACE_TILE,   // tile list / blockId -> {top,side,bottom} map
  tileSizePx: 16, atlasSizePx: 64, texelSize: 1/64,
}
// also exported: TILE_SIZE, ATLAS_SIZE, TILES, FACE_TILE, mulberry32(seed)

// voxelMesher.js
buildChunkGeometry(volume, { ao = true, atlas = null } = {})
  -> { solid: THREE.BufferGeometry, transparent: THREE.BufferGeometry | null }
// attributes: position, normal, uv, color (rgb), ao (float 0..1); indexed
// (Uint32 when >65535 verts). Water is never meshed (it is its own module),
// but solid faces bordering water ARE emitted.
computeCornerAO(side1, side2, cornerN, levels = AO_LEVELS) // unit-testable AO
AO_LEVELS // [0.35, 0.55, 0.75, 1.0] — tunable occlusion ramp

// voxelMaterial.js
createVoxelMaterial({ transparent = false, map = null, alphaTest = null } = {})
  -> THREE.MeshStandardMaterial
// runtime knobs (no re-mesh, survive shader recompiles):
mat.userData.setAoStrength(s)    // 0..1 blend
mat.userData.setAoEnabled(bool)  // hard on/off (this is what demo.toggle('ao') calls)
mat.userData.setMap(tex | null)  // swap/remove atlas (triggers recompile)
mat.userData.aoUniforms          // { uAoStrength, uAoEnabled }
```

**Integration snippet.**

```js
import { createBlockAtlas } from './textures.js';
import { buildChunkGeometry } from './voxelMesher.js';
import { createVoxelMaterial } from './voxelMaterial.js';

const atlas = createBlockAtlas();
const geom = buildChunkGeometry(volume, { ao: true, atlas });
const solidMesh = new THREE.Mesh(geom.solid,
  createVoxelMaterial({ transparent: false, map: atlas.texture }));
scene.add(solidMesh);
if (geom.transparent) {           // leaves -> alpha-cutout foliage
  const leaves = new THREE.Mesh(geom.transparent,
    createVoxelMaterial({ transparent: true, map: atlas.texture }));
  leaves.renderOrder = 1;
  scene.add(leaves);
}
```

**Perf notes.** Two-pass mesher: pass 1 counts faces, pass 2 fills exact-sized
typed arrays — no intermediate arrays, no per-face allocation (colour LUT and
AO scratch are prebuilt). Whole chunk = 1 draw call for solid + 1 for leaves.
With a map + `transparent: true` the material switches to alpha-cutout
(`alphaTest 0.5`, depth-written, double-sided) — no transparency sorting cost.

**Toggle/quality.** AO toggles per-material via a uniform
(`userData.setAoEnabled`) — instant, no re-mesh. `{ ao: false }` at build time
writes `ao = 1` everywhere instead.

### sky.js — `DynamicSky`

**What it does.** Full day/night sky: gradient dome with a sun-side twilight
band and baked sun/moon halos, 2200-star twinkling point field, square
Minecraft-style sun and moon sprites, drifting fbm cloud plane, plus the scene's
light rig — a directional key (`sky.sun`: warm sun by day, cool blue moonlight
at night, never pitch black) and a hemisphere fill (`sky.hemi`). All sky visuals
are camera-centred and far-plane proof (clip-space `z = w * 0.99995` hug, and
the rig rescales to fit `camera.far`). Weather grades the whole sky toward
storm grey (rain) or cool steel blue (snow).

**Public API.**

```js
new DynamicSky(renderer, { size = 4000, stars = 2200 } = {})
sky.object3d          // add to scene ONCE (contains visuals + sun + hemi)
sky.sun               // THREE.DirectionalLight — hand this to ShadowController
sky.hemi              // THREE.HemisphereLight
sky.sunDir, sky.moonDir  // live unit Vector3s, re-aimed by setTimeOfDay
sky.setTimeOfDay(t)   // 0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset
sky.setWeather(w)     // 'clear'|'rain'|'snow' (also synced from ctx.weather)
sky.weather           // getter
sky.getFogColor(target?) // CURRENT horizon colour; pass a THREE.Color to avoid alloc
sky.update(dt, ctx); sky.setEnabled(on); sky.enabled; sky.dispose();
```

**Integration snippet.**

```js
import { DynamicSky } from './sky.js';
const sky = new DynamicSky(renderer, { size: 4000, stars: 2200 });
scene.add(sky.object3d);          // brings sun + hemi into the scene
sky.setTimeOfDay(0.35);
// per frame:
sky.update(dt, ctx);              // ctx.timeOfDay / ctx.weather drive it
sky.getFogColor(ctx.skyColor);    // feed the horizon colour to fog + water
```

**Perf notes.** One lean dome shader (gradient + band + halos in a single
fragment), one Points draw for all stars (brightness-only twinkle, so no
attribute uploads), one plane for clouds, two sprites. `setTimeOfDay` is
allocation-free (scratch colours reused); `update` only touches uniforms.

**Toggle behaviour.** `setEnabled(false)` hides only the visuals —
`sky.sun`/`sky.hemi` keep lighting the scene so shadows never die with the
dome. The demo also force-hides sky visuals while underwater.

### shadows.js — `ShadowController`

**What it does.** Wraps an existing `THREE.DirectionalLight` (the sky's sun)
into a shimmer-free voxel shadow caster: PCFSoft map, per-quality orthographic
frustum + resolution, voxel-tuned biases (`bias -0.0005`,
`normalBias 0.5` ≈ half a voxel — the anti-acne key knob), follow-the-view
frustum re-centring clamped near the chunk centre, and texel-snapping of the
frustum centre in the light's image plane so edges don't crawl as the camera
orbits.

**Public API.** (constructor differs from the base contract — it takes the shared sun)

```js
new ShadowController(renderer, sun, {
  quality = 'medium', groundY = 14, center = null, lightDistance = 140 } = {})
sc.setQuality('low'|'medium'|'high'|'ultra')
sc.applyToScene(scene)  // mark cast/receive flags; RE-CALLABLE after adding meshes
sc.update(dt, ctx)      // reads ctx.sunDir + ctx.camera
sc.setEnabled(on); sc.enabled; sc.dispose();
```

`applyToScene` rules: meshes cast + receive; anything named/flagged water
(`userData.water`, name or material name matching `/water/i`) receives only;
anything under a name matching `/sky|cloud|dome|star/i` or flagged
`userData.noShadow` / `userData.excludeFromShadows` is skipped.

**Integration snippet.**

```js
import { ShadowController } from './shadows.js';
const shadows = new ShadowController(renderer, sky.sun, {
  quality: 'medium',
  center: new THREE.Vector3(24, 12, 24),  // chunk centre
  groundY: WATER_LEVEL + 3,
  lightDistance: 140,
});
shadows.applyToScene(scene);   // AFTER all meshes (incl. water) are added
// per frame: shadows.update(dt, ctx);
```

**Perf/quality.** One shadow map, re-rendered per frame. Per-quality tuning:

| quality | map | ortho frustum | PCF radius |
|---|---|---|---|
| low | 1024² | 80u | 2.0 |
| medium | 2048² | 70u | 3.0 |
| high | 4096² | 64u | 3.5 |
| ultra | 4096² | 52u (tighter ⇒ crisper) | 4.0 |

`setEnabled(false)` flips `sun.castShadow` and `renderer.shadowMap.enabled`
and flags scene materials for the one-time recompile that toggle requires.

### water.js — `Water` + `UnderwaterOverlay`

**What it does.** `Water` is a single tessellated plane at `y = level` with a
custom shader: 3 analytic directional sine waves displaced in the vertex stage
(normals reconstructed analytically — no faceting), scrolling value-noise
ripple normals, Schlick fresnel blending body colour toward the live sky
colour, day/night-aware Blinn-Phong glints (warm sun by day, a cool moon
streak at night — direction flips automatically), and a radial edge dissolve
so the square plane border melts into fog. `UnderwaterOverlay` swaps in dense
blue-green fog + background and a camera-enveloping tint sphere when the
camera goes below `level` (or `ctx.underwater` is set), snapshotting and
restoring the previous `scene.fog`/`scene.background` verbatim.

**Public API.**

```js
new Water(scene, {
  level = 10, size = 64, sunRef = null,   // sunRef: DynamicSky (pulls sun colour/moonDir/fog colour)
  center = null,                          // {x,z} world centre (default size/2)
  segments = 64, waveHeight = 1.0,
  deepColor = 0x0a2634, shallowColor = 0x1f6f70, skyColor = 0x9fc4e8,
  sunColor = 0xfff2d0, moonColor = 0xbfd3ee,
  opacity = 0.75, fadeStart = 0.85 } = {})
water.object3d                        // auto-added to scene when one is passed
water.setSkyReflectionColor(color)    // pin reflection colour (ctx.skyColor still wins)
water.setSunLight(intensity, color?)  // manual override; setSunLight(null) => auto
water.update(dt, ctx); water.setEnabled(on); water.enabled; water.dispose();

new UnderwaterOverlay(scene, camera, {
  level = 10, tintColor = 0x0f4f5e, tintOpacity = 0.42,
  fogColor = 0x0e4653, fogNear = 1.0, fogFar = 30.0 } = {})
uw.object3d; uw.isUnderwater();
uw.getFogColor(target?)               // day/night-graded murk colour
uw.update(dt, ctx); uw.setEnabled(on); uw.enabled; uw.dispose();
```

**Integration snippet.**

```js
import { Water, UnderwaterOverlay } from './water.js';
const water = new Water(scene, {
  level: WATER_LEVEL, size: 260, segments: 96,
  center: { x: sx / 2, z: sz / 2 }, sunRef: sky,
});
const underwater = new UnderwaterOverlay(scene, camera, { level: WATER_LEVEL });
underwater.object3d.userData.noShadow = true;   // keep tint sphere out of shadows
// per frame: water.update(dt, ctx); underwater.update(dt, ctx);
```

**Perf notes.** One draw call, one material; waves are vertex-stage sines (no
render-to-texture, no reflection/refraction passes); ripples are 3 noise
fetches. `transparent`, `depthWrite:false`, `DoubleSide` (visible from below).
Sky-colour priority per frame: `ctx.skyColor` > `sunRef.getFogColor()` on
time-of-day change > pinned `setSkyReflectionColor` value.

**Toggle behaviour.** `Water.setEnabled(false)` hides the mesh.
`UnderwaterOverlay.setEnabled(false)` deactivates and restores the snapshotted
fog/background immediately.

### postprocessing.js — `PostFX`

**What it does.** Self-contained HDR post chain built on raw render targets and
a fullscreen triangle — deliberately no `EffectComposer` dependency. Pipeline:
scene → half-float HDR buffer → soft-knee bright-pass → downsampled separable
gaussian ping-pong (escalating tap radius per iteration) → composite (additive
bloom, exposure, ACES filmic tonemap, vignette, sRGB encode) → optional FXAA on
the LDR image. Auto "night boost" widens/strengthens bloom and lifts exposure
as the sun sets (derived from `ctx.sunDir.y` in `update`), so torch halos read
at night while the day image stays clean.

**Public API.**

```js
new PostFX(renderer, scene, camera, { quality = 'medium' } = {})
post.render(dt)          // call INSTEAD of renderer.render(scene, camera)
post.update(dt, ctx)     // optional: auto-derives nightBoost from ctx.sunDir/timeOfDay
post.setSize(w?, h?)     // omit args to auto-detect drawing-buffer size
post.setQuality('low'|'medium'|'high'|'ultra')
post.toggle('bloom'|'tonemap'|'vignette'|'fxaa', on)
post.setExposure(x)          // default 1.1
post.setBloomStrength(x)     // default 0.8
post.setBloomThreshold(x)    // default 0.75
post.setBloomRadius(x)       // default 1.3
post.setNightBoost(f)        // 0..1 manual (disables the auto-drive)
post.setAutoNightBoost(on)   // re-enable auto
post.setEnabled(on)          // false => plain renderer.render bypass
post.enabled; post.dispose();
```

**Integration snippet.**

```js
import { PostFX } from './postprocessing.js';
renderer.toneMapping = THREE.NoToneMapping;  // PostFX owns ACES
renderer.outputColorSpace = THREE.SRGBColorSpace;
const post = new PostFX(renderer, scene, camera, { quality: 'medium' });
// per frame, as the LAST two steps:
post.update(dt, ctx);
post.render(dt);
// on resize: post.setSize();
```

**Perf/quality.** All bloom work runs on a downsampled buffer; blur is a 9-tap
gaussian done in 5 bilinear fetches; tonemap + vignette live in the single
composite pass (~free, on at every tier). Targets are reused, uniforms mutated
in place — zero per-frame allocation.

| quality | bloom | bloom buffer | blur iterations | FXAA |
|---|---|---|---|---|
| low | off | — | — | off |
| medium | on | half-res | 2 | on |
| high | on | half-res | 3 | on |
| ultra | on | full-res | 4 | on |

### particles.js — `Particles`

**What it does.** One umbrella class managing six pooled emitters, each a
single `THREE.Points` with fixed-capacity typed-array pools recycled in place
(zero per-frame allocation): torch flames (additive, feeds bloom) + smoke,
on-demand block-break debris bursts, camera-following rain streaks with wind
tilt, swaying snow flakes, and expanding splash rings at the water surface
while raining. Every emitter has a hard screen-space point-size cap so a
near-camera particle can never balloon into a giant quad.

**Public API.**

```js
new Particles(scene, { camera = null, waterLevel = 10 } = {})
p.object3d                       // auto-added when scene is passed
p.addTorch(pos)                  // {x,y,z} or [x,y,z]; integer coords are centred (max 48)
p.spawnBlockBreak(pos, color)    // color = [r,g,b] 0..1; 12-20 debris chips
p.setWeather('clear'|'rain'|'snow', intensity = 0.7)  // 0..1 intensity
p.setWaterLevel(y)               // splash-ring height; null disables splashes
p.update(dt, ctx); p.setEnabled(on); p.enabled; p.dispose();
```

**Integration snippet.**

```js
import { Particles } from './particles.js';
const particles = new Particles(scene, { camera });
for (const l of volume.lights) particles.addTorch(l);   // glowstone/torch positions
particles.setWeather('clear');
// per frame: particles.update(dt, ctx);  // weather also syncs from ctx.weather
// on block break: particles.spawnBlockBreak({x, y, z}, BLOCKS[id].color);
```

**Perf notes.** 6 draw calls max (inactive weather pools are `visible=false`).
Pool caps: 48 torches × 12 flame + 5 smoke, 360 debris, 2000 rain, 2600 snow,
200 splashes — live-point ceiling ≈ 3.4k, well under the 4.5k budget. Sim
state (velocity/life) lives in plain arrays outside the GPU attributes so
uploads stay minimal. Torch flames/smoke auto-hide while `ctx.underwater`.

### fog.js — `DistanceFog`

**What it does.** Installs a `THREE.FogExp2` (default) or `THREE.Fog` on the
scene so chunk edges dissolve into the horizon. The fog colour tracks the
current sky colour exactly every frame (no easing lag — the sunrise fog is the
same orange as the sky). Density scales with weather (rain ×1.6, snow ×1.8)
and adds a whisper at twilight/night, but is hard-capped
(`maxBaseDensity 0.0035`, `maxDensity 0.006`, combined haze ≤ 2×) so no
configuration can wash the scene out. Cooperates with `UnderwaterOverlay`:
while `suspended` or `ctx.underwater` it never writes `scene.fog`.

**Public API.**

```js
new DistanceFog(scene, {
  color = 0xbcd9f2, near = 90, far = 260, density = 0.0026,
  mode = 'exp2',                 // 'exp2' | 'linear'
  skyRef = null,                 // e.g. the DynamicSky (getFogColor auto-pull)
  weatherScaling = true, todScaling = true, colorLerp = 0,
  rainDensity = 1.6, snowDensity = 1.8,
  maxHaze = 2.0, maxBaseDensity = 0.0035, maxDensity = 0.006 } = {})
fog.setSkyColor(color)           // snap fog colour to the sky NOW
fog.setDensity(x); fog.setRange(near, far); fog.setMode('exp2'|'linear')
fog.setMaxHaze(x); fog.setDensityCaps(maxBase, maxEffective)
fog.suspended = true             // or fog.setSuspended(on): yield scene.fog
fog.fog                          // live THREE.Fog/FogExp2 (inspection)
fog.mode                         // getter
fog.update(dt, ctx); fog.setEnabled(on); fog.enabled; fog.dispose();
```

**Integration snippet.**

```js
import { DistanceFog } from './fog.js';
const fog = new DistanceFog(scene, { mode: 'exp2', density: 0.0016, skyRef: sky });
fog.setSkyColor(sky.getFogColor());
// per frame (AFTER refreshing ctx.skyColor from the sky):
fog.update(dt, ctx);   // colour <- ctx.skyColor, density <- ctx.weather/timeOfDay
```

**Toggle behaviour.** `setEnabled(false)` detaches only its own fog and
restores whatever `scene.fog` it originally displaced; it never clobbers the
underwater overlay's fog.

### gui.js — `createGUI`

**What it does.** Dependency-free control panel (injected CSS, top-right
`#gui` mount): effect checkboxes, quality dropdown, time-of-day slider with a
clock label, weather selector, underwater checkbox, live FPS counter. Polls the
shared `state` object every 250 ms so programmatic `window.demo.*` calls stay
in sync with the controls.

**Public API.**

```js
createGUI(demo, state = {}) -> {
  root,              // the panel element
  refresh(state?),   // re-sync controls (optionally adopt a new state object)
  hide(), show(),
  fps,               // getter: latest measured FPS (works even with ?nogui=1)
  dispose(),
}
// window.__gui = { hide, show, refresh, fps } for automation scripts.
// ?nogui=1 builds the panel but never mounts it (clean screenshots).
```

**Integration snippet.**

```js
import { createGUI } from './gui.js';
const state = { effects: { ao: true, sky: true, shadows: true, water: true,
                           post: true, particles: true, fog: true },
                quality: 'medium', timeOfDay: 0.35,
                weather: 'clear', underwater: false };
const gui = createGUI(window.demo, state);  // mutate `state` in place; gui self-syncs
```

## Integration guide for the builder

### Per-frame update order (what demo.js does)

Order matters: the sky computes the frame's horizon colour, everything else
consumes it.

```js
// stable ctx object — mutated in place every frame, never reallocated
const ctxSkyColor = new THREE.Color();
const ctx = {
  camera, renderer, scene,
  elapsed: 0,
  timeOfDay: 0.35,           // 0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset
  sunDir: sky.sunDir,        // LIVE vector — re-aimed by sky.setTimeOfDay
  weather: 'clear',
  underwater: false,
  skyColor: ctxSkyColor,     // fog + water read this every frame
};

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  ctx.elapsed = clock.elapsedTime;             // + refresh timeOfDay/weather/underwater

  controls.update();

  sky.update(dt, ctx);                         // 1. sky first (owns sun + colours)
  sky.getFogColor(ctxSkyColor);                // 2. horizon -> shared skyColor
  if (ctx.underwater) underwater.getFogColor(ctxSkyColor); // murk wins submerged

  shadows.update(dt, ctx);                     // 3. frustum follows camera + sunDir
  water.update(dt, ctx);                       // 4. waves + night-correct lighting
  underwaterOverlay.update(dt, ctx);           // 5. fog/background swap below level
  fog.update(dt, ctx);                         // 6. colour <- skyColor, density <- weather
  particles.update(dt, ctx);                   // 7. flames/weather/debris sim
  post.update(dt, ctx);                        // 8. auto night bloom boost

  post.render(dt);                             // 9. FINAL — replaces renderer.render
}
```

Renderer setup that the stack assumes: `antialias: false` (FXAA does AA),
`renderer.outputColorSpace = SRGBColorSpace`,
`renderer.toneMapping = NoToneMapping` (PostFX owns ACES on the HDR buffer),
`THREE.ColorManagement.enabled = true`.

### Plugging the mesher into an existing chunk system

`buildChunkGeometry` takes **any** volume object shaped like:

```js
{
  sx, sy, sz,               // dimensions (iteration bounds)
  get(x, y, z) -> blockId,  // 0 = air; MUST return 0 for out-of-range coords
  isOpaque(x, y, z) -> bool // solid AND not water/leaves; false out-of-range
  // (isSolid is part of the demo Volume contract but the mesher itself
  //  only calls get + isOpaque)
}
```

Two gotchas: (1) the mesher hoists `get`/`isOpaque` as plain function refs —
they must be closures, not `this`-dependent methods; (2) block-id semantics
(AIR=0, WATER=7, LEAVES=6, and the atlas `FACE_TILE` map) come from
`blocks.js` — a game with a different palette either remaps ids to this one at
the volume boundary or extends `BLOCKS`/`FACE_TILE`. Out-of-range `isOpaque`
returning `false` is what makes chunk-boundary faces emit; for multi-chunk
worlds have the volume's accessors read the neighbouring chunk instead to cull
those seams. Re-mesh = rebuild the geometry for the dirty chunk and swap it on
the mesh (the build is a pure function; dispose the old geometry).

### Quality presets

`demo.setQuality(q)` fans out to exactly two modules — `post.setQuality(q)` and
`shadows.setQuality(q)`:

| tier | shadow map | shadow frustum / PCF | bloom | blur iters | FXAA |
|---|---|---|---|---|---|
| low | 1024² | 80u / 2.0 | off | — | off |
| medium | 2048² | 70u / 3.0 | half-res | 2 | on |
| high | 4096² | 64u / 3.5 | half-res | 3 | on |
| ultra | 4096² | 52u / 4.0 | full-res | 4 | on |

Everything else (sky, water, particles, fog, mesher) is tier-independent by
design — their costs are already flat and low. Natural extension points for
the game: scale `Water` `segments`, `Particles` intensity, and `DynamicSky`
`stars` per tier.

## Performance

Measured on the demo chunk (48×32×48, 1600×900): **~19 draw calls,
~62k triangles** for the whole frame — 1 solid chunk mesh + 1 leaves mesh +
1 water plane + sky (dome, stars, clouds, 2 sprites) + up to 6 particle pools
+ underwater tint + fullscreen post passes.

The 60 fps @ `medium` target is what the stack is *designed for on real
GPUs* — this repo's CI runs headless SwiftShader (software rasterisation), so
fps numbers measured in CI are meaningless as absolute values and were only
used for relative regression checks.

Lean-shader choices made throughout:

- Face-culled mesher writes exact-sized buffers in 2 passes; whole chunk is one
  (indexed) draw call per material; AO is baked per-vertex, not screen-space.
- AO integration patches `MeshStandardMaterial` instead of a custom lighting
  shader — one extra multiply in the fragment, shadows/fog stay stock.
- 64×64 nearest-filtered atlas, no mipmaps — trivial texture bandwidth, no
  cross-tile mip bleed to fight.
- Sky = 1 gradient-shader dome (sun disc + halos baked in), 1 additive Points
  star field (brightness twinkle only — no attribute re-uploads), 1 fbm cloud
  plane, 2 sprites. No cubemap re-render.
- Water = 1 plane; waves are 3 vertex-stage sines with analytic normals; the
  ripple "normal map" is 3 noise fetches. No reflection/refraction RTs.
- One 2048² shadow map at medium; torch point lights deliberately do NOT cast
  shadows; the shadow frustum is texel-snapped so no resolution is wasted
  fighting shimmer.
- Post chain: bloom bright-pass + blur run at half resolution; separable 9-tap
  gaussian done in 5 bilinear fetches; tonemap + vignette folded into the one
  composite pass; FXAA instead of MSAA (HDR MSAA resolve is expensive).
- Zero per-frame allocation on the hot path everywhere (shared mutated ctx,
  scratch vectors/colours, fixed particle pools with `DynamicDrawUsage`).

## Known limitations / future work

- **Single-plane water.** One big wavy plane at `WATER_LEVEL` — correct for a
  sea/lake at a global level, wrong for elevated pools or waterfalls. Per-block
  water meshing (and flow) is future work; the mesher already skips water faces
  in anticipation.
- **No wet-surface response in rain.** Blocks don't darken or gain specular
  when it rains; rain also falls through overhangs (no occlusion test) and only
  splashes on the water plane, not on terrain.
- **No snow accumulation.** Snow weather is particles + colour grade only; the
  terrain never whitens over time.
- **Clouds are a textured layer, not volumetric.** A scrolling fbm alpha plane —
  no raymarched depth, no cloud shadows on the ground.
- **Face-culled, not greedy, meshing.** Adjacent coplanar faces are not merged;
  a greedy pass would cut triangle count further (at the cost of the per-vertex
  AO/tint variation pattern used here).
- **Single shadow frustum, no cascades.** Tuned for one ~48u chunk; a real
  view-distance world needs CSM (the texel-snap logic carries over directly).
- **AO is voxel-neighbourhood only.** No SSAO for non-voxel props; torch point
  lights cast no shadows.
- **Full re-mesh per chunk edit.** `buildChunkGeometry` rebuilds the whole
  chunk (fast at 48³, but incremental/dirty-region meshing is future work).
- **No underwater caustics or god rays;** the underwater look is fog + tint.
- **Leaves don't sway** (no wind vertex animation) and the block-break debris
  doesn't collide with terrain.
- **Sky objects are 2D.** Sun/moon are sprites, stars are screen-size points —
  fine for the pixel aesthetic, but there's no parallax/eclipse logic.
