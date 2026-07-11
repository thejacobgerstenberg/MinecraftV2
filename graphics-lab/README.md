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
`toggle(name, bool)` for
`ao|sky|shadows|water|post|particles|fog|portal|crack|viewmodel|torchlights|wind|biome`
plus the Phase 3 names `ssao|godrays|bloom|greedy` (`greedy` A-Bs the chunk
between the greedy and classic meshers live) and the environment-phase names
`falls|underwaterfx|biolum|ambient|reflections` (`biolum` defaults OFF;
`reflections` re-applies the planar-reflection tier for the current quality
preset, so it stays off at `low`),
`setView('hero'|'sunrise'|'closeup'|'firstperson'|'portal'|'torches')` plus the
beauty presets `'beauty-warpwold'|'beauty-cinderloom'|'beauty-nevermend'`
(these also stage the scene — they call `setDimension` + `setTimeOfDay`, so one
call sets up the whole money shot; allow ~1 s for the crossfades),
`setDimension('warpwold'|'cinderloom'|'nevermend')` — the MASTER dimension
control: one call re-themes sky grade/aurora/smoke (DimensionSky), the ambient
life field (AmbientLife), the portal palette, the per-dimension biome grade and
the cinderloom-only lavafall —
`togglePhotoMode()` (also bound to the `P` key) and
`captureStill({ width = 2560, height = 1440 })` → PNG dataURL rendered through
the full PostFX chain, the
Phase 2 calls: `setPortalDimension('warpwold'|'cinderloom'|'nevermend')`,
`triggerBreak()`, `setHeldItem('block:<id|name>'|'tool:pickaxe'|null)`,
`swing()`, `setBiome(name)` (any of the 16 brand biomes in `BIOMES` plus the
five legacy aliases `plains|desert|tundra|swamp|cinder` — see the biomelut
section) and
`setTorchCount(n)` (0..500 synthetic stress registrations), the Phase 3
calls `setFov(deg)` (clamped 30..120) and `setFpsCap(n)` (0 = uncapped —
render-loop throttle, rAF stays scheduled), and `setScenicMode(bool)` —
hides all screen furniture (held-item view model, dev GUI, settings drawer)
for clean scenic captures and restores the previous state on the way back.
`window.demo.settings` is the
mounted settings-panel handle (see the settings section below).
`window.__demoReady === true` after the first rendered frame. `window.__gui.hide()/show()` toggles the panel from
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
| ![portal](./screenshots/08-portal.png) | Portal gate (Phase 2): obsidian-textured voxel frame, three-layer parallax swirl shader with fbm filaments, palette-tinted point light painting the terrain, drifting energy motes. |
| ![firstperson](./screenshots/09-firstperson.png) | First-person view model (Phase 2): held atlas-textured block + blocky arm anchored lower-right, idle bob, swing arc on every block break, drawn over world geometry. |
| ![torches](./screenshots/10-torches.png) | Pooled torch lighting at night (Phase 2): dozens of registered torches, a fixed budget of real point lights snapped to the nearest N, flame flicker + cross-fade handoff, emissive coal heads feeding bloom. |
| ![godrays](./screenshots/11-godrays.png) | God rays at sunrise (Phase 3): quarter-res radial-blur shafts streaming past the island silhouette, altitude-derived warm tint, occluded by geometry (mask = sky-only HDR colour), on top of SSAO + the full post chain. |
| ![settings](./screenshots/12-settings.png) | Settings drawer (Phase 3): gear-button panel with quality presets, render distance / FOV sliders, FPS cap, VSync and per-effect toggles — pure DOM, persists to `localStorage`, broadcasts `graphics-settings-change` events the demo maps onto module APIs. |
| ![benchmark](./screenshots/13-benchmark.png) | `bench.html` (Phase 3): deterministic meshing/rendering suite — naive vs greedy vs greedy+LOD+culling over the same 96×40×96 world and fixed 8 s orbit; the table below is this run. |
| ![beauty warpwold](./screenshots/20-beauty-warpwold.png) | `setView('beauty-warpwold')` (Environment phase): golden-hour diorama — the lake-outflow waterfall pouring off the south cliff (FlowFalls), quarter-res planar reflections on the ocean, drifting pollen motes (AmbientLife), brand-violet dusk undertone (DimensionSky). |
| ![beauty cinderloom](./screenshots/21-beauty-cinderloom.png) | `setView('beauty-cinderloom')`: ember dusk — the cinderloom-only lavafall blooming off the north cliff, rising ember field, dark smoke deck overhead, ash-orange sky grade, dimmer/redder sun. |
| ![beauty nevermend](./screenshots/22-beauty-nevermend.png) | `setView('beauty-nevermend')`: pale void night — three undulating aurora ribbon curtains, boosted stars, icy desaturated gradient, falling thread-wisps, moon low on the -Z band. |
| ![warpwold rain](./screenshots/23-warpwold-rain.png) | Rain over warpwold: the TWO stacked weather cloud layers thickened dark + fast (parallax drift in opposite directions), wind-tilted streaks, ambient motes thinned by the weather. |
| ![underwater caustics](./screenshots/24-underwater-caustics.png) | UnderwaterFX from inside the lake: the cellular caustic web dappling submerged block tops (one merged additive mesh), sun-aligned light shafts hanging from the surface. |
| ![photo mode](./screenshots/25-photomode.png) | Photo mode (`P`): free-fly compose camera with cinematic letterbox + vignette overlay; `captureStill()` renders 2560×1440 stills through the full PostFX chain. |
| ![real worldgen day](./screenshots/26-realworld-day.png) | Integration proof (day): the builder's REAL `TerrainGenerator` (vendored byte-exact from `feat/voxel-sandbox-game` @ `98c7ea9`), 4×4 chunks = 64×128×64, fed through the `GraphicsStack` facade at quality high — everything on. 34 draw calls / ~198k tris; world geometry is 2 of those calls. |
| ![real worldgen night](./screenshots/27-realworld-night.png) | Integration proof (night): same real overworld slice at t=0.85 — stars, moonlight key, auto night bloom. The builder palette has NO torch block and the overworld generator places zero emissive blocks, so this is what unlit builder nights look like (FINDINGS #4). |
| ![real worldgen cinderloom](./screenshots/28-realworld-cinderloom.png) | Integration proof (nether → cinderloom sky): inside the builder's real nether cavern under a glowstone ceiling blob, ~400 lights derived from real emissive blocks (registered on the ADJACENT AIR cell — FINDINGS #5). Lava ocean maps to glowstone (FINDINGS #3/#6); the orange band is dusk sky through the slice's open sides. |
| ![real worldgen nevermend](./screenshots/29-realworld-nevermend.png) | Integration proof (end → nevermend sky): the builder's real end island under the aurora curtains, water/underwater features disabled (floating islands over void — FINDINGS #10); the drop at frame right is the real island edge. |
| ![storyboard 1](./screenshots/30-storyboard-1.png) | Showcase storyboard 1/2 (`tools/flythrough.mjs` + `tools/storyboard.mjs`): warpwold and cinderloom dawn→day→dusk→night beats — waterfall/lavafall closeups, underwater caustics, island diorama, portal gate, ember dusk, torch terraces. |
| ![storyboard 2](./screenshots/31-storyboard-2.png) | Showcase storyboard 2/2: nevermend dawn→night (snow squall, cabin, aurora + moon) plus a best-of row — the scripted flythrough's definitive contact sheets, 1600×900 stills at quality high with everything on. |

## Module catalog

**Integration facade:** [`integrate.js`](./integrate.js) exports `GraphicsStack` — ONE composition of everything below (7-statement adoption, proven against the builder's real worldgen); the ordered adoption checklist + findings live in [`INTEGRATION.md`](./INTEGRATION.md).

**Emitter helper:** [`emitters.js`](./emitters.js) — `registerEmitterLights` derives pooled torch lights from the builder's emissive blocks, always registering the best ADJACENT AIR cell (FINDINGS #5) and skipping enclosed emitters, plus `makeEmissiveBlockMaterial`/`attachTorchVisual` for a future torch id.

**Emitter doc:** [`EMITTERS.md`](./EMITTERS.md) — the builder-facing one-pager for the above: derive lights from `blocks.js` `emissive` values, the adjacent-air rule explained, and what to wire when a torch id is added.

**Acceptance gate:** [`verify-integration.mjs`](./verify-integration.mjs) + [`VERIFY-INTEGRATION.md`](./VERIFY-INTEGRATION.md) — the post-integration acceptance gate: `node graphics-lab/verify-integration.mjs` boots the REAL game headless, plays through the menu into a world and probes that the stack genuinely renders the frame (fog Δ, RT writes, water motion, pack-swap pixels); every probe goes through the `window.gfx` named-global convention, so `window.gfx = gfx` (INTEGRATION.md Step 1, statement 7) is REQUIRED for a green gate.

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

**Emissive blocks.** Builder blocks with `emissive` 1–15 (lava/glowstone/portal) now mesh into a THIRD, self-lit geometry group via the facade's `meshChunk` (`geom.emissive` + `createEmissiveChunkMaterial` in `integrate.js` — animated UV-scrolling lava glow, feeds bloom).

### sky.js — `DynamicSky`

**What it does.** Full day/night sky: gradient dome with a sun-side twilight
band and baked sun/moon halos, 2200-star twinkling point field, square
Minecraft-style sun and moon sprites, LAYERED fbm clouds — TWO stacked
horizontal planes, a low deck plus a higher/larger/slower veil drifting the
opposite way for parallax, tinted by the sun colour and weather-reactive
(clear = sparse white, rain = thicker/darker/faster, snow = pale dense) — plus
the scene's light rig — a directional key (`sky.sun`: warm sun by day, cool
blue moonlight at night, never pitch black) and a hemisphere fill (`sky.hemi`).
All sky visuals are camera-centred and far-plane proof (clip-space
`z = w * 0.99995` hug, and the rig rescales to fit `camera.far`). Weather
grades the whole sky toward storm grey (rain) or cool steel blue (snow).

**Environment-phase additions** (all optional, no-ops when unused — the
baseline look is unchanged): `setCloudiness(v)` manual 0..1 cloud-cover
override (null = back to weather-driven), `setPaletteTint(tint|null)` — a
re-gradeable dimension tint applied LAST in `setTimeOfDay` (held by REFERENCE,
so a caller can mutate its fields and re-install to crossfade; `getFogColor()`
reflects the tinted horizon so fog stays seamless), and
`addSkyObject(obj)`/`removeSkyObject(obj)` — parent custom meshes (aurora
ribbons, smoke decks) into the camera-following, far-plane-fitted visuals rig,
sized against `sky.domeRadius`. These are exactly the hooks `dimensionSky.js`
drives — sky.js itself knows nothing about dimensions.

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
// Environment-phase hooks (dimension theming — see dimensionSky.js):
sky.setCloudiness(v)  // 0..1 manual cloud cover; null/undefined = auto (weather)
sky.cloudiness        // getter (null while automatic)
sky.setPaletteTint(tint | null)
  // tint fields (all optional): horizon/zenith/glow/sun/hemi (colours) with
  // horizonAmt/zenithAmt/glowAmt/sunAmt/hemiAmt lerp amounts (default 1),
  // sunIntensity/hemiIntensity multipliers, cloudLit/cloudShadow + cloudAmt,
  // starBoost. Applied last in setTimeOfDay; null restores the natural sky.
sky.paletteTint       // getter (the installed tint object, by reference)
sky.addSkyObject(obj); sky.removeSkyObject(obj)  // ride the visuals rig
sky.domeRadius        // sizing reference for custom sky objects
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
attribute uploads), two planes for the layered clouds (each layer's wind phase
is integrated, not uTime-scaled, so weather speed changes never jump the
pattern), two sprites. `setTimeOfDay` is allocation-free (scratch colours
reused); `update` only touches uniforms.

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
so the square plane border melts into fog.

**Environment-phase additions.** (1) ANIMATED FLOW: the whole wave/ripple
phase field translates along a flow vector accumulated on the CPU
(`uFlowOffset`), so the surface reads as a gently drifting body of water;
`setFlow({dirX, dirZ, speed})` steers it live and never jumps phase (the
offset accumulates, so direction/speed changes glide). (2) REFLECTION-LITE: an
optional planar reflection — the scene re-rendered through a camera mirrored
about the water plane into a small RT (oblique near-plane clip at
`y = level`), sampled projectively, distorted by the ripple normal and blended
INTO the existing sky-colour fresnel term, so with it off (or the camera
underwater) the shader degrades to exactly the previous look. The RT pass runs
inside `update()` via `ctx.renderer/scene/camera`, hides particles/transparent
objects and the water itself, freezes shadow-map updates for the pass and
restores all state after (re-entrancy guarded; flag `userData.noReflection`
to exclude an object).

`UnderwaterOverlay` swaps in dense
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
  opacity = 0.75, fadeStart = 0.85,
  flow = null,                        // initial { dirX, dirZ, speed } (see setFlow)
  reflectionQuality = 'medium',       // 'off'|'low'(=off)|'medium'|'high'|'ultra'
  reflectionStrength = 0.85 } = {})   // RT vs analytic sky-fresnel blend
water.object3d                        // auto-added to scene when one is passed
water.setSkyReflectionColor(color)    // pin reflection colour (ctx.skyColor still wins)
water.setSunLight(intensity, color?)  // manual override; setSunLight(null) => auto
water.setFlow({ dirX?, dirZ?, speed? })  // partial updates OK; zero-length dir
                                      // ignored; speed clamped >= 0; never jumps phase
water.getFlow()                       // -> { dirX, dirZ, speed } (allocates)
water.setReflectionQuality(q)         // quality tiers + RT sizes:
                                      //   'off'/'low' (or false/null/0) = disabled
                                      //     (pure analytic sky fresnel)
                                      //   'medium' = quarter-res RT
                                      //   'high'/'ultra' = half-res RT
water.reflectionQuality               // getter
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

**Perf notes.** One draw call, one material; waves are vertex-stage sines;
ripples are 3 noise fetches. The ONLY render-to-texture cost is the optional
reflection pass: off at `'off'`/`'low'`, one quarter-res scene re-render at
`'medium'`, half-res at `'high'`/`'ultra'` (RT + mirror camera created lazily
on the first update that wants one; particles/transparent objects are hidden
for the pass to keep it cheap). `transparent`, `depthWrite:false`,
`DoubleSide` (visible from below).
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
post.toggle('bloom'|'tonemap'|'vignette'|'fxaa'|'ssao'|'godrays', on)
post.setSsaoEnabled(on)      // convenience for toggle('ssao', on)
post.setGodRaysEnabled(on)   // convenience for toggle('godrays', on)
post.setSsaoIntensity(x); post.setSsaoRadius(r); post.setGodRaysStrength(x)
post.ssao / post.godrays     // the pass objects (null when depth textures
                             // are unavailable — the toggles then no-op)
post.features                // live { bloom, tonemap, vignette, fxaa, ssao, godrays }
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

| quality | bloom | bloom buffer | blur iterations | FXAA | SSAO | god rays |
|---|---|---|---|---|---|---|
| low | off | — | — | off | off | off |
| medium | on | half-res | 2 | on | 8 samples, half-res | on (¼-res, 12 taps × 2 passes) |
| high | on | half-res | 3 | on | 12 samples, half-res | on (¼-res, 16 taps × 3 passes) |
| ultra | on | full-res | 4 | on | 12 samples, full-res | on (¼-res, 20 taps × 3 passes) |

`setQuality` re-gates SSAO/god rays per this table (both OFF at low, ON at
medium+); `post.toggle(...)` afterwards overrides the gate until the next
`setQuality`. Both passes also hard-require a readable depth texture (WebGL2,
or `WEBGL_depth_texture` on WebGL1) — without it `post.ssao`/`post.godrays`
are `null` and the features stay off silently.

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

### portals.js — `PortalGate` (Phase 2)

**What it does.** A swirling dimensional gate: an obsidian-style voxel frame
(one `InstancedMesh` of unit cubes with a procedural 64×64 conchoidal obsidian
texture and deterministic per-instance shade variation), a swirl surface plane
drawn with a lean `ShaderMaterial` (three parallax depth layers of
fbm-warped rotating spiral + soft filaments, emissive core that feeds bloom,
soft rectangular alpha edges), a palette-tinted flickering `PointLight` at the
centre strong enough to paint the frame/ground (intensity 5.0, decay 1.8), and
70 additive glow motes drifting through the plane. The three dimension
palettes are sampled **verbatim from the LOOMFALL brand 8-stop dimension
ramps** in `brand/palette.json` (feature/brand, PR #9 — same source as the
biome LUT, see `BRAND_VERSION` in `biomelut.js`): `warpwold` violet-blue
understitch base / woven-green arms / dawn-gold filaments, `cinderloom` ember
orange over charred umber with brick smoke veins, `nevermend` violet-black
breaking to cold cyan + hemstone pale. Palettes remain pure uniform data —
switching crossfades every colour over ~0.6 s and fires an activation burst.

**Public API.**

```js
new PortalGate({
  position = new THREE.Vector3(), width = 4, height = 5,
  dimension = 'warpwold' } = {})
gate.object3d          // Group (frame + surface + light + motes) — add to scene
gate.setDimension('warpwold'|'cinderloom'|'nevermend')
                       // ~0.6s palette crossfade + activate(); re-selecting the
                       // current dimension just pulses; unknown names warn+no-op
gate.activate()        // burst: expanding bright ring + flash, ~0.8s envelope
gate.dimension         // getter: current palette name
gate.update(dt, ctx); gate.setEnabled(on); gate.enabled; gate.dispose();
PALETTES               // exported { name: { label, deep, bright, filament, glow, light } }
                       // hex colours (each a verbatim brand ramp stop) —
                       // the GUI lists them as swatches
```

**Integration snippet.**

```js
import { PortalGate } from './portals.js';
const portal = new PortalGate({
  position: new THREE.Vector3(22, 16, 25.5),  // frame base sits at local y=0
  width: 4, height: 5, dimension: 'warpwold',
});
scene.add(portal.object3d);
portal.activate();                 // boot burst
// per frame: portal.update(dt, ctx);
// on dimension change: portal.setDimension('cinderloom');
```

**Perf notes.** 3 draw calls (instanced frame, surface plane, one Points cloud
for all motes). Allocation-free per frame — palette fades, burst envelope and
mote orbits only mutate prebuilt uniforms/colours/typed arrays. The point
light deliberately does not cast shadows. Surface is `transparent`,
`depthWrite:false`, `renderOrder 2` (after water); motes at `renderOrder 3`.

### blockcrack.js — `BlockCracks` (Phase 2)

**What it does.** Progressive Minecraft-style destroy-stage overlay. Five
16×16 crack-stage alpha textures are painted procedurally at construction
(seeded rng, deterministic): the crack web is generated ONCE as random-walk
polylines and each stage draws a longer prefix, so later stages strictly
extend earlier ones — no crack "teleports" between stages. Decals darken the
block under them via multiply-ish blending, so they read correctly day and
night.

**Public API.**

```js
new BlockCracks(scene, {
  seed = 20117,
  maxSlots = 4,        // pooled decal slots (Group of 6 unit quads each)
  volume = null,       // optional worldgen Volume: hide quads against opaque neighbours
  blend = 'multiply',  // 'multiply' (MC-like darkening) | 'normal' (alpha-cutout grey)
} = {})
CRACK_STAGES                      // exported: 5 (stage indices 0..4)
bc.showCrack(x, y, z, stage)      // stage 0..4; null/undefined/<0 removes
bc.clearCrack(x, y, z); bc.clearAll();
bc.animateBreak(x, y, z, { duration = 1.5, onComplete } = {}) -> { cancel() }
   // steps stages 0..4 over duration, then clears + calls onComplete(x, y, z)
bc.setVolume(volume)              // enable/refresh exposed-face culling
bc.update(dt, ctx); bc.setEnabled(on); bc.enabled; bc.dispose(); bc.object3d
```

**Integration snippet.**

```js
import { BlockCracks } from './blockcrack.js';
const cracks = new BlockCracks(scene, { volume });   // volume-aware face culling
// per frame: cracks.update(dt, ctx);
// on dig: cracks.animateBreak(x, y, z, {
//   duration: 1.5,
//   onComplete: (bx, by, bz) => {           // remove the block + burst debris
//     particles.spawnBlockBreak({ x: bx, y: by, z: bz }, BLOCKS[id].color);
//   },
// });
```

**Perf notes.** Everything is pooled: `maxSlots` reusable decal slots (default
4 — the demo never breaks more than a couple of blocks at once) sharing one
`PlaneGeometry`, and a fixed pool of 4 concurrent `animateBreak` entries
recycled in place (pool exhaustion force-finishes the oldest so game logic
still runs). Zero per-frame allocation; textures/geometry/materials built once
in the constructor. Decals use `polygonOffset` + a 0.001 outward push against
z-fighting, `renderOrder 2`, and are flagged `noShadow`. `setEnabled(false)`
hides the decals but keeps animations ticking so `onComplete` still fires.

### viewmodel.js — `FirstPersonViewModel` (Phase 2)

**What it does.** The Minecraft-style held-item "hand": a rig parented to the
camera (screen-stable, anchored lower-right, can never be near-clipped), with
a blocky Steve-style forearm, an idle walk bob (figure-eight + rotational
sway) and a ~0.35 s eased swing arc. Held blocks sample real atlas tiles per
face (half-texel inset) when the `textures.js` atlas helper is provided,
falling back to flat `blocks.js` face colours otherwise; `tool:pickaxe` is a
procedural blocky pickaxe. Materials are `MeshLambert` (scene lights apply)
with a tiny emissive floor plus a short-range point fill that follows the sun,
so the item is lit like the world — bright at noon, dark at night, never a
glowing lantern.

**Public API.**

```js
new FirstPersonViewModel(camera, { atlasTexture = null, atlas = null } = {})
  // atlas: object from createBlockAtlas() — needs .tileUV(name)/.faceTile(id, face);
  // atlasTexture defaults to atlas.texture when omitted
vm.setItem('block:<id|name>')   // e.g. 'block:1' or 'block:grass' — textured mini cube
vm.setItem('tool:pickaxe')      // procedural pickaxe
vm.setItem(null)                // hide (also '' — falsy hides)
vm.swing()                      // ~0.35s arc; spam-safe (at most one queued follow-up)
vm.update(dt, ctx); vm.setEnabled(on); vm.enabled; vm.dispose(); vm.object3d
```

**Integration snippet.**

```js
import { FirstPersonViewModel } from './viewmodel.js';
// CRITICAL: camera children only render if the camera is in the scene graph.
if (!camera.parent) scene.add(camera);
const viewmodel = new FirstPersonViewModel(camera, { atlas, atlasTexture: atlas.texture });
viewmodel.setItem('block:1');
// per frame: viewmodel.update(dt, ctx);   // reads ctx.sunDir for the fill
// on dig/attack: viewmodel.swing();
```

**Perf notes.** Item variants are built once and cached per spec string
(hidden holder children — switching items is a visibility flip). Zero
per-frame allocation. Overlay drawing: `depthTest:false` + `transparent:true`
+ `renderOrder 950+` so nearby walls never slice through the hand AND the
water plane (drawn earlier in the transparent queue) never blends over it —
see the comment in `makeLambert` for the GL depth-mask subtlety. Everything is
`noShadow`/`frustumCulled=false`.

### torchlights.js — `TorchLightManager` (Phase 2)

**What it does.** Hundreds of registered torches, a fixed budget of real
`THREE.PointLight`s. Every frame the manager snaps its pooled warm lights onto
the N registered torches nearest the camera; when the winning set changes,
lights cross-fade over ~0.25 s instead of popping. Each active light flickers
with two octaves of smoothed value noise seeded by torch id (deterministic,
C1-smooth — a flame, not a strobe) plus a ±0.03 position jitter. Defaults:
warm orange, distance 14, decay 1.8, base intensity 3.0.

**Public API.**

```js
new TorchLightManager(scene, {
  maxLights = 6, color = 0xffa64d, distance = 14, decay = 1.8,
  baseIntensity = 3.0, fadeTime = 0.25 } = {})
tm.register(pos) -> id      // Vector3 or {x,y,z}; integer coords are centred
                            // (+0.5 x/z, +0.55 y = flame height, matching particles.addTorch)
tm.unregister(id) -> bool   // O(1) swap-remove; its light fades out naturally
tm.setMaxLights(n)          // re-pool to a new budget; kept slots keep brightness
tm.maxLights; tm.count      // getters (pool size / registered torches)
tm.update(dt, ctx); tm.setEnabled(on); tm.enabled; tm.dispose();
// no .object3d — pool lights are added directly to the scene

QUALITY_LIGHTS = { low: 2, medium: 6, high: 10, ultra: 14 }  // demo quality map
makeTorchMesh() -> THREE.Group   // stick + emissive coal head prop (shared geo/mats)
disposeTorchMeshAssets()         // free the shared prop assets on full teardown
```

**Integration snippet.**

```js
import { TorchLightManager, QUALITY_LIGHTS, makeTorchMesh } from './torchlights.js';
const torchMgr = new TorchLightManager(scene, { maxLights: QUALITY_LIGHTS.medium });
for (const l of volume.lights) torchMgr.register(l);
// visible prop per torch (the pooled lights need a source to read from):
const prop = makeTorchMesh();
prop.position.set(x + 0.5, yTop, z + 0.5);   // base on the block top
scene.add(prop);
torchMgr.register({ x, y: yTop, z });
// per frame: torchMgr.update(dt, ctx);       // reads ctx.camera + ctx.elapsed
// on quality change: torchMgr.setMaxLights(QUALITY_LIGHTS[q]);
```

**Perf notes.** This is the light-pooling budget per quality tier: **2 (low) /
6 (medium) / 10 (high) / 14 (ultra)** real point lights, no matter how many
torches are registered (stress-tested to 500 via `demo.setTorchCount`).
Registrations are plain parallel arrays (`px/py/pz`) — register is an array
push, unregister an O(1) swap-remove. Nearest-N selection is an
allocation-free top-K insertion scan: O(count × K), K ≤ 14 — no per-frame
sort, no comparator closures. Pool lights never cast shadows. The torch prop
meshes share one geometry/material set lazily built once (300 torches = 300
tiny Object3Ds, not 300 materials); the emissive coal head reads through bloom
even when a torch loses the light-budget lottery.

### windsway.js — `applyWindSway` + `WindController` (Phase 2)

**What it does.** Foliage wind sway as a **material patcher** — no geometry
rebuild, no new meshes. `applyWindSway(material)` hooks
`material.onBeforeCompile` to displace vertices in the vertex stage: phase is
hashed from the vertex WORLD position (continuous, so vertices shared by
neighbouring leaf blocks get identical phase and the alpha-cutout canopy never
tears open), two summed sines give a gusty non-metronomic feel, and max
displacement is ~0.08 world units at strength 1 — deliberately subtle. The
`WindController` owns the two shared uniforms and eases strength toward the
weather target: **clear 0.35, rain 1.0, snow 0.6**.

**Public API.**

```js
applyWindSway(material, { mode = 'leaves', controller = null } = {}) -> material
  // idempotent (material.userData.windSway guard); controller defaults to the
  // getWindController() singleton; registers the material + untracks on dispose

new WindController()  /  getWindController()   // default singleton
wc.uniforms                 // { uWindTime, uWindStrength } — shared by every patch
wc.update(dt, ctx)          // eases strength toward the ctx.weather target
wc.setStrength(x)           // manual override; setStrength(null) => weather control
wc.setEnabled(on)           // false eases strength to 0 (geometry glides to rest)
wc.enabled; wc.dispose();
```

**Integration snippet.**

```js
import { applyWindSway, getWindController } from './windsway.js';
applyWindSway(leavesMat, { mode: 'leaves' });   // the transparent voxel material
const wind = getWindController();
// per frame: wind.update(dt, ctx);   // TWO scalar uniform writes, total
```

**Perf notes / material-patch composition.** The patch COMPOSES with any
existing `onBeforeCompile` hook — the previous hook runs first (the voxel
material's AO injection), then the sway chunk is appended after
`#include <begin_vertex>`; both survive because each replace leaves the
include marker in place. `customProgramCacheKey` is extended (identifying the
previous hook explicitly) so a swayed material never shares a compiled program
with an unswayed sibling. Displacement is applied to `transformed` before
`project_vertex`, so RECEIVED shadows, fog depth and lighting all use the
displaced position. Per-frame cost is exactly two uniform scalar writes no
matter how many materials sway; `uWindTime` wraps at the sines' common period
so the float never degrades over long sessions. KNOWN LIMITATION (accepted):
the depth material used for the shadow-map pass is not patched, so the CAST
shadow of foliage does not sway — invisible at ≤ 0.08 units of travel.

### biomelut.js — `BiomeGrading` (Phase 2)

**What it does.** Per-biome colour grading applied through `PostFX.setGrade()`,
folded into the existing composite pass (after ACES tonemapping, before
vignette/FXAA): `c = mix(vec3(luma(c)), c, sat) * gain + lift`.

**Brand alignment.** The biome list is now the canonical **16-biome LOOMFALL
brand set**, and every grade is DERIVED deterministically from its
`brand/palette.json` swatch (feature/brand, PR #9) instead of hand-picked:
weighted swatch mean → chromatic gain, sky/fog brightness → lift, mean swatch
saturation → sat (exact formulas in `deriveGrade` in the source). The exported
`BRAND_VERSION` identifies the palette the LUT was built from (system name +
source commit — the brand json carries no numeric version field). The five
pre-brand names keep working as **aliases** of their nearest brand biome
(same frozen entry object): `plains → sennmeadows`, `desert → bleachlands`,
`tundra → the_frostlace`, `swamp → muslin_fens`, `cinder → emberwarp`.

PostFX eases the live grade toward each target over ~0.5 s, so biome switches
cross-fade instead of popping. Value discipline (enforced by clamps in
`deriveGrade`): gain within ±0.08 of 1.0, lift within ±0.03, sat 0.85..1.05 —
the scene look is owned by the sky/lighting, the grade is seasoning.

**Public API.**

```js
new BiomeGrading(postFX)   // postFX: a PostFX instance (or anything with setGrade({lift,gain,sat}))
bg.setBiome(name) -> bool  // any of the 16 brand biomes or a legacy alias;
                           // false + warn on unknown
bg.biome                   // getter: current biome name
bg.list()                  // -> fresh array of biome names (brand + aliases)
bg.setEnabled(on)          // false => neutral grade (biome remembered)
bg.enabled; bg.update(dt, ctx) /* no-op */; bg.dispose() /* resets to neutral */
BIOMES                     // frozen { name: { lift:[r,g,b], gain:[r,g,b], sat,
                           //                  description, brandColors } }
BRAND_VERSION              // id of the brand palette the LUT is derived from
NEUTRAL_GRADE              // frozen identity grade
```

**Integration snippet.**

```js
import { BiomeGrading } from './biomelut.js';
const biomes = new BiomeGrading(post);          // the PostFX instance
biomes.setBiome('desert');
// per frame: biomes.update(dt, ctx);           // no-op; PostFX does the easing
```

**Perf notes.** Costs nothing per frame: `setGrade` is only called when the
biome or enabled state changes, and the grade itself is a handful of ALU ops
already living in the composite shader (no extra pass, no LUT texture fetch).

### greedyMesher.js — `buildGreedyChunkGeometry` (Phase 3)

**What it does.** Greedy variant of the chunk mesher: collapses runs of
identical coplanar faces into single quads while preserving the per-vertex
corner AO and atlas texturing of `voxelMesher.js`. Drop-in for the same volume
contract; on the 96×40×96 bench world it cuts meshed triangles **101,338 →
42,154 (2.4×)**; the flat 8×1×8 self-test slab collapses 160 faces → 6 quads.

**AO-merge rule** (the correctness core). Two cells merge only when their
`(blockId, face direction)` match — which fixes the atlas tile, shade bucket
and vertex colour — **and** their four corner-AO tuples are IDENTICAL, **and**
the tuple is UNIFORM ALONG EACH MERGE AXIS (extend width only when
`ao(u0,*) == ao(u1,*)`, extend height only when `ao(*,v0) == ao(*,v1)`). That
last condition is what makes the merged quad's interpolated AO field
bit-identical to the unmerged mesh — identical tuples alone would smooth a
repeating per-cell AO ramp into one long gradient. The quad-flip rule
(triangulate along the darker diagonal) is preserved verbatim. In practice
most merge candidates are fully lit, so merging stays dramatic.

**Tiled-atlas attributes.** The geometry is an attribute **superset** of
`voxelMesher.js` (materials stay interchangeable): `position`, `normal`,
`uv`, `color`, `ao` **plus** `tileOrigin` (vec2 — RAW, un-inset atlas rect
origin of the face's tile) and `tileSpan` (vec2 — quad size in blocks along
the face's texture axes). In atlas mode `uv` carries LOCAL tile-space coords
`0..W / 0..H` (one unit per block); the tiled material reconstructs the sample
per fragment as

```glsl
sampleUV = tileOrigin + halfTexelInset + fract(localUV) * (tileSizeUV - 2.0 * halfTexelInset)
```

so one 16×16 tile repeats cleanly across a merged W×H quad and the anti-bleed
half-texel inset moves from baked UVs into the shader. Pair greedy atlas
geometry ONLY with `createVoxelMaterial({ tiled: true, map: atlas.texture,
atlasInfo: atlas })` — a plain material would sample the local UVs across the
whole atlas.

**Public API.**

```js
buildGreedyChunkGeometry(volume, { ao = true, atlas = null } = {})
  -> { solid: THREE.BufferGeometry, transparent: THREE.BufferGeometry | null,
       stats: { quadsBefore, quadsAfter } }   // face-culled vs merged quad counts
lastGreedyStats   // module-level { quadsBefore, quadsAfter } mirror of the last build
selfTest()        // node src/greedyMesher.js — slab/stepped/atlas/AO-formula asserts
```

**Documented difference vs voxelMesher.** The per-block deterministic
brightness variation ("vary" tint) is dropped in atlas mode — a unique tint
per block would forbid all merging. Greedy atlas colour = neutral tint × face
shade. `demo.toggle('greedy', bool)` A-Bs the two meshers on the live chunk.

### chunkManager.js — `ChunkManager` + `sliceVolume` (Phase 3)

**What it does.** Splits a big voxel world into per-chunk meshes so THREE's
built-in per-mesh frustum culling applies, adds distance-based LOD swapping
(lazy-built, cached, with hysteresis so orbiting on a boundary never flaps)
and a render-distance cutoff. Works with `buildChunkGeometry` AND
`buildGreedyChunkGeometry` (a bare `BufferGeometry` return is treated as the
solid pass).

`sliceVolume(world, cx, cz, chunkSize)` wraps a big Volume into a chunk-local
window whose accessors read ACROSS chunk borders from the parent world
(out-of-slice coords land in the neighbouring chunk) — that is exactly what
culls faces on chunk seams instead of emitting hidden interior walls. The
returned accessors are `this`-free closures, safe for the meshers.

**Public API.**

```js
new ChunkManager(scene, {
  chunkSize = 16,
  mesher = buildChunkGeometry,     // or buildGreedyChunkGeometry
  material, transparentMaterial,   // e.g. createVoxelMaterial({ tiled: true, ... })
  lod = [{ dist: 0, ao: true }, { dist: 96, ao: false }],  // per-level mesher opts
  mesherOpts = {},                 // shared opts merged into every level (e.g. { atlas })
  maxDistance = Infinity,          // render distance, world units
  hysteresis = 4, maxBuildsPerFrame = 2,
})
cm.addChunk(cx, cz, sliceVolume(world, cx, cz, 16))  // builds LOD 0 immediately
cm.removeChunk(cx, cz); cm.rebuildChunk(cx, cz, newSlice?)  // chunk edits
cm.update(dt, ctx)                 // per frame: AABB distance, LOD swap, distance hide
cm.setRenderDistance(units)        // null / <=0 / Infinity = unlimited
cm.stats() -> { chunks, visibleEstimate, trianglesTotal }
cm.object3d; cm.setEnabled(on); cm.enabled; cm.dispose();

sliceVolume(world, cx, cz, chunkSize = 16) -> chunk-local Volume (+ cx/cz/origin metadata)
```

**Perf notes.** Per-frame cost: one clamped-AABB distance + a compare per
chunk, zero allocations. Geometry builds happen only when a chunk crosses an
unbuilt LOD boundary, capped at `maxBuildsPerFrame` (hidden chunks never spend
builds); once both LODs are cached a swap is a `mesh.geometry` pointer
assignment. Node self-test covers seam culling, LOD swap, render distance and
stats (run command in the file header).

### instancedProps.js — `InstancedProps` (Phase 3)

**What it does.** `THREE.InstancedMesh` helper for repeated scene props: one
InstancedMesh per registered type = **one draw call per type** no matter how
many placements. `addType` takes a `BufferGeometry` + material, or ANY
`Object3D` (e.g. `makeTorchMesh()`) — every child mesh is merged into one
geometry with each part's transform baked into positions/normals and each
part's material colour baked into a vertex `color` attribute. In the demo the
~36 scatter-torch props render as ONE draw call (previously ~72 small draws).

**Public API.**

```js
new InstancedProps(scene)
props.addType(name, geometryOrObject3D, material = null, maxCount = 256)
props.place(name, position, { rotationY = 0, scale = 1 } = {}) -> index (-1 when full)
   // position: Vector3 | {x,y,z} | [x,y,z]; scale: number | {x,y,z}
props.clear(name); props.clearAll()          // reset placements, keep capacity
props.getCount(name); props.capacityOf(name); props.stats()
props.object3d; props.update(dt, ctx); props.setEnabled(on); props.enabled; props.dispose();
```

**Limitation (single material).** An InstancedMesh draws with one material,
so per-part materials collapse to one vertex-colored `MeshStandardMaterial`;
emissive parts (the torch coal head) are approximated by folding
`emissive × intensity` into the vertex colour — they read bright but do NOT
feed bloom or emit light. Pass an explicit `material` to override. Per-frame
cost is zero when static: `place()` writes instance matrices with pooled
scratch (no allocation); `update()` only refreshes the bounding sphere on
frames after placements changed (keeps frustum culling correct).

### ssao.js — `SSAOPass` (Phase 3)

**What it does.** Screen-space ambient occlusion from the depth buffer alone —
no G-buffer: view-space position is reconstructed via
`camera.projectionMatrixInverse`, the normal comes from screen-space
derivatives. 8–12 golden-angle spiral disk samples, rotated per pixel by a
tiny repeating 4×4 cos/sin noise texture (deterministic), each range-checked
(occluders beyond `radius` contribute nothing, so distant silhouettes never
bleed AO) and cosine-weighted. One 4-tap box denoise (16-texel box for 4
bilinear fetches), then the composite pass multiplies the AO term into the
scene colour before tonemapping. Sky pixels early-out to 1.0. Runs half-res
by default, full-res at ultra.

The default intensity (0.55) is deliberately modest: the mesher already bakes
per-vertex corner AO — SSAO only adds contact darkening under overhangs and
props. It must complement, not double-darken.

**Public API** (owned by PostFX — game code normally only touches
`post.toggle('ssao', on)` / `post.setSsaoIntensity/Radius`):

```js
new SSAOPass({ samples, radius, intensity, power, bias, resolutionDiv })
setSize(w, h); setResolutionDiv(d)   // 2 = half-res (default), 1 = full-res
setSamples(n)                        // 1..12; recompiles (quality-change time only)
setRadius(r)  /* default 0.8 */; setIntensity(x) /* default 0.55 */; setPower(p); setBias(b)
render(pass, depthTexture, camera); texture /* blurred AO, r channel */; dispose()
```

**Quality gating.** Off at low; 8 samples half-res at medium; 12 half-res at
high; 12 full-res at ultra. Requires a readable depth texture (WebGL2 or
`WEBGL_depth_texture`) — PostFX performs that gate and never constructs the
pass when unavailable.

### godrays.js — `GodRaysPass` (Phase 3)

**What it does.** Crepuscular light shafts (GPU Gems 3 ch. 13-style radial
blur), everything at QUARTER resolution and **no second scene render**: the
occlusion mask reuses the main HDR colour buffer gated by depth. **Shaft
definition tuning:** the mask is now HIGH-CONTRAST — geometry is hard black,
sky is Reinhard-compressed then threshold+power shaped so dim sky drops out
and only genuinely bright sky feeds the shafts (that mask contrast IS the
shaft structure: occluder silhouettes carve crisp dark wedges instead of
uniform haze), and the hard-edged square sun quad is superseded as the shaft
driver by an analytic ROUND gaussian core (feathered in the mask — the sky
module's square sun is untouched), all windowed around the sun's screen
position. 1–3 compounding radial blur iterations (short reach first, longest
last, taps^passes effective taps) ping-pong toward the sun with a per-pixel
interleaved-gradient-noise jitter on each tap ladder to hide banding. The
composite then ADDs `rays × tint × (strength × fade)` before tonemapping,
with three wash-out guards: a soft cap on ray luminance, scene-luminance
suppression (bright sky gets less add, the dark wedges keep it all), and a
near-depth fade (~4–18 world units) so near terrain keeps its texture.

`updateSun()` runs on the CPU each frame (allocation-free): projects the sun
to screen UV and combines fade from (a) sun behind camera, (b) sun off screen,
(c) sun altitude — strongest at sunrise/sunset, subtle at noon, off at night —
and (d) underwater. It also derives the warm tint from altitude (horizon
orange → pale warm white). When `fade == 0` PostFX skips the passes entirely,
so god rays cost nothing at night.

**Public API** (owned by PostFX — game code normally only touches
`post.toggle('godrays', on)` / `post.setGodRaysStrength`):

```js
new GodRaysPass({ strength, decay, maskRadius, type })
setSize(w, h); setStrength(x)        // composite add weight (default 0.55)
setDecay(d)                          // per-tap decay 0.5..0.999 (default 0.92),
                                     // energy-normalised so brightness holds
setTaps(n)                           // taps per radial pass 4..32 (default 12;
                                     // one-off shader recompile)
setPasses(n)                         // radial blur iterations 1..3 (default 2)
updateSun(camera, sunDir, underwater) -> fade 0..1
fadeValue; active; tint              // getters
render(pass, sceneTexture, depthTexture) -> bool (false when faded out)
texture; dispose()
```

**Quality gating.** Off at low, on at medium+ (always quarter-res — there is
no per-tier resolution knob by design); PostFX scales taps/passes per tier —
**12 × 2** at medium, **16 × 3** at high, **20 × 3** at ultra — so the longer,
higher-contrast shafts stay smooth. Same depth-texture requirement as SSAO.

### benchmark.js + bench.html — the measurement harness (Phase 3)

`bench.html` runs the suite on load; `benchmark.js` exports
`runBenchmark(renderer, opts) -> Promise<results>`. Three scenarios over the
SAME `generateTestWorld` volume and the SAME fixed 8-second camera orbit
advanced by an accumulated FIXED dt (never wall clock — every run renders the
identical frame sequence): **naive** (`buildChunkGeometry` per chunk),
**greedy** (`buildGreedyChunkGeometry` per chunk), **greedy+LOD+culling**
(`ChunkManager`, greedy mesher, 2 LOD levels, render-distance cap). Measured
per scenario: meshing ms, meshed triangles, draw calls + rendered triangles
per frame (`renderer.info` with `autoReset = false`), avg/p95 JS frame ms
(warmup excluded) and scenario `update()` ms. Each scenario runs in
try/catch — one failure is reported in `results.scenarios[i].error` without
killing the suite. See "Performance" below for how to run it and the measured
table.

### settings/ — graphics settings panel (Phase 3)

**Full embed guide: [`settings/README.md`](./settings/README.md)** (API,
preset semantics, the settings → graphics-lab hook-mapping table, FPS-cap loop
snippet, dispatcher skeleton). Summary: a self-contained, dependency-free
settings drawer (gear button + right-side panel) — pure DOM ES module, no
three.js import, no network. State persists to `localStorage`
(`mc2.graphics`); Low/Medium/High/Ultra presets expand per-toggle profiles
with automatic **Custom** detection; sliders for render distance (2–32
chunks) and FOV (60–110°), FPS cap and an advisory VSync flag.

**Preset toggle profiles** (`PRESETS` in `settings/settings.js`). A preset
click emits `preset` first, then re-asserts the FULL profile below (one event
per toggle) so consumers land exactly on it even when a downstream
`setQuality` re-gates effects; any manual toggle flips the readout to
**Custom**:

| preset | ao | ssao | shadows | water | bloom | god rays | wind | particles | fog | biome grade | portal fx |
|---|---|---|---|---|---|---|---|---|---|---|---|
| low | ✓ | — | — | — | — | — | — | — | ✓ | — | — |
| medium | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | ✓ | ✓ | ✓ |
| high | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ultra | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

`ultra` differs from `high` in pass INTERNALS (sample counts, resolutions,
light budgets via `setQuality`), which the boolean toggles do not capture.

```js
import { createSettingsPanel } from './settings/settings.js';
const panel = createSettingsPanel({
  mount: document.body, initial: { fov: 80 },
  storageKey: 'mc2.graphics',
  onChange: (d) => applySetting(d.key, d.value, d.settings),
});
```

**Event contract.** One `graphics-settings-change` `CustomEvent` on `window`
per key that actually changed (a preset click can emit several — one per
flipped toggle, plus `preset` itself). `detail` is
`{ key, value, settings }`; `detail.settings` is a fresh copy, safe to keep.
`panel.set(patch, { silent: true })` applies + persists without firing. On
boot, replay `panel.get()` once so the renderer matches storage:

```js
window.addEventListener('graphics-settings-change', (e) => {
  const { key, value, settings } = e.detail;
  applySetting(key, value, settings);
});
const s = panel.get();
for (const [key, value] of Object.entries(s)) applySetting(key, value, s);
```

`demo.js` is the reference dispatcher: `preset` → `demo.setQuality`,
`renderDistance` → (reserved for `chunkManager.setRenderDistance(v * 16)` in
the game; the single-chunk demo stretches fog instead), `fov` → `demo.setFov`,
`fpsCap` → `demo.setFpsCap`, and every effect key → the matching
`demo.toggle(...)` (`ssao` → `'ssao'`, `godRays` → `'godrays'`, `windSway` →
`'wind'`, `biomeGrading` → `'biome'`, `portalFx` → `'portal'`). The panel does
nothing per frame — renderer code reads its own copy of the settings.

### textures/ — texture pack system

Five switchable texture packs over a deterministic 55-tile procedural
generator whose `buildAtlas(packId, seed)` is a drop-in match for the
builder's `TextureAtlas` contract (frozen 33-name tile prefix + 22 appended
tiles, 32px tiles, half-texel-inset `tileUV`, `BLOCK_TILES` ids 0–29 with the
builder's face-fallback semantics). Packs are knob transforms (`sat / light /
contrast / grain / wear / edge / outline / weave…`) plus optional per-tile
painter overrides — a 6th pack is ~20 lines in `textures/packs.js`.
`textures/labAdapter.js` bridges pack atlases into this demo's
`createBlockAtlas()` contract (raw-rect UVs + square 256×256 re-blit), so both
meshers, the tiled material and the viewmodel consume them unchanged:
`demo.setTexturePack(id)` hot-swaps the world live, persists to
`localStorage['mc2.texturePack']` and emits `'pack:switched'`; the in-game
pack browser drawer (`textures/browser/`, ui-kit tokens vendored) sits next to
the settings gear. Distinctness and seam-free tiling are enforced numerically
by `textures/selftest.mjs` (smooth 1.39x saturation, gritty 0.57x sat / 1.34x
contrast, accessible 1.66x contrast vs classic; 250/250 opaque tiles
seam-clean). Full docs: [`textures/README.md`](./textures/README.md); visual
gallery: `textures/gallery.html`.

| Shot | Caption |
|---|---|
| ![pack default](./screenshots/14-pack-default.png) | Loomfall Classic (`default`): the reference pack — clean 32px pixel art straight off the brand palette. |
| ![pack smooth](./screenshots/15-pack-smooth.png) | Softstone (`smooth`): cel-ish gradients, merged ramp ends, 1.39x saturation, grain nearly gone. |
| ![pack gritty](./screenshots/16-pack-gritty.png) | Gritstone (`gritty`): desaturated to 0.57x, contrast up 1.34x, heavy grain, cracks and chipped edges. |
| ![pack woven](./screenshots/17-pack-woven.png) | Threadbare (`woven`): lore-native stitched-cloth look — warp/weft weave, cross-stitch dither, frayed edges, thread sheen. |
| ![pack accessible](./screenshots/18-pack-accessible.png) | Loudstone (`accessible`): 1.66x contrast, 2px outlines, colorblind-safe ore shapes (dots/stripes/diamonds/crosses/rings/zigzag). |
| ![pack in scene](./screenshots/19-pack-inscene.png) | A pack hot-swapped into the live demo via `demo.setTexturePack()` — chunk re-meshed, held-item viewmodel rebuilt, same lighting/post chain. |

### waterfx.js — `FlowFalls` (Environment phase)

**What it does.** Waterfall + lavafall showcase pieces. Each fall is an
animated falling SHEET between a lip (`from`) and a landing point (`to`): the
fragment shader scrolls stretched value-noise streaks down the fall (no
textures, no CPU UV animation), the bottom of the SAME sheet carries the foam
fringe (water: churning white band) / ember fringe (lava: hot glow band) so
the fringe costs zero extra draws, and the vertex stage adds a gentle billow +
base flare so the sheet never reads as a flat card. Lava is emissive (HDR
values > 1 feed the bloom chain) and near-opaque. Each fall also gets one soft
MIST quad at the base (water: pale normal-blended; lava: hot additive glow)
and feeds ONE shared splash/ember particle pool.

**Public API.**

```js
new FlowFalls(scene, { atlas = null } = {})   // atlas accepted for forward
                                              // compat; visuals are procedural
ff.addFall({ type: 'water'|'lava', from, to, width = 3 })
  -> { id, type, remove() } | null            // from = lip, to = landing point
                                              // (Vector3-like); remove()
                                              // disposes the fall's geometry
ff.update(dt, ctx); ff.setEnabled(on); ff.enabled; ff.dispose(); ff.object3d
```

**Integration snippet.**

```js
import { FlowFalls } from './waterfx.js';
const falls = new FlowFalls(scene, { atlas });
falls.addFall({
  type: 'water',
  from: { x: 14, y: 16.9, z: 48.32 },          // cliff lip
  to: { x: 14, y: WATER_LEVEL + 0.15, z: 48.85 }, // splash-down
  width: 3.2,
});
// per frame: falls.update(dt, ctx);
// dimension-conditional falls: keep the handle, handle.remove() to tear down
// (the demo creates/removes its lavafall on the master dimension switch).
```

**Perf notes.** Exactly 2 draw calls per fall (sheet + mist) + 1 shared Points
draw for ALL falls' splash/embers (capacity 320, fixed typed arrays recycled
in place via swap-with-last, hidden when nothing is alive). All water sheets
share ONE material and all lava sheets share ONE material — per-fall length
and width travel in an `aInfo` vertex attribute, not uniforms, so no per-fall
shader programs. Particle randomness is a seeded LCG (deterministic, no
`Math.random`). Sheets draw at `renderOrder 6` (after the lake surface), mist
at 7, the pool at 8; everything is `noShadow`.

### underwaterfx.js — `UnderwaterFX` (Environment phase)

**What it does.** Three underwater environment effects in one module, 3 draw
calls total, each auto-hidden while its eased level is ~0. (1) CAUSTICS —
`setVolume(volume)` scans for underwater TOP faces (solid block with WATER
directly above) and lays one additive depth-tested quad 3 cm above each,
merged into ONE static geometry; the dapple pattern is a procedural
cellular/voronoi "bright web" canvas texture sampled twice at different
scales/scroll directions and min()-combined (the classic caustic trick) with
a time-based UV warp, per-vertex depth attenuation (strongest in the
shallows), day-driven. (2) LIGHT SHAFTS — 4..8 slanted translucent quads
hanging from the surface, aligned to the LIVE sun direction each update (kept
at least 25% downward so they never go horizontal at sunset), swaying, faded
by night and by camera state: full strength underwater, partial when looking
steeply down from above, gone otherwise. (3) BIOLUMINESCENCE (default OFF) —
sparse cyan-green pulsing motes + a few larger floor glows, deterministically
placed in submerged water cells weighted toward the deep basin, strongest at
night (strength scales with 1 − sun contribution).

**Public API.**

```js
new UnderwaterFX(scene, {
  waterLevel = 10,
  bounds = null,           // optional { minX, maxX, minZ, maxZ } clamp region
  shafts = 7,              // 4..8 light shafts
  causticIntensity = 1.0 } = {})
ufx.setVolume(volume)      // (re)build caustic quads + biolum placements
ufx.setBiolum(on)          // master switch, default OFF; ufx.biolum getter
ufx.setCausticIntensity(v) // master caustic strength (>= 0)
ufx.update(dt, ctx)        // uniform writes only; reads ctx.sunDir/camera/underwater
ufx.setEnabled(on); ufx.enabled; ufx.dispose(); ufx.object3d
```

**Integration snippet.**

```js
import { UnderwaterFX } from './underwaterfx.js';
const underwaterFx = new UnderwaterFX(scene, { waterLevel: WATER_LEVEL });
underwaterFx.setVolume(volume);      // after worldgen (and after chunk edits)
// per frame: underwaterFx.update(dt, ctx);
// demo.toggle('underwaterfx', b) => setEnabled; demo.toggle('biolum', b) => setBiolum
```

**Perf notes.** Geometry is built once (or on explicit `setVolume`); per-frame
work is uniform writes only, zero allocation (`getWorldDirection` writes into
a preallocated scratch). Visibility levels ease frame-rate-independently so
day/night and surface transitions never pop. Caustics are also drawn (at 55%
strength) when viewed from ABOVE the surface, so the lake floor dapples read
in overhead shots.

### dimensionSky.js — `DimensionSky` (Environment phase)

**What it does.** Re-skins the EXISTING `DynamicSky` per Loomfall dimension
without forking it — all colour work goes through the additive hooks sky.js
exposes (`setPaletteTint` / `addSkyObject` / `domeRadius`), so the underlying
day/night/star/moon machinery is untouched and switching back to `'warpwold'`
(or disposing) restores the natural look exactly. `warpwold` = the natural
baseline + a subtle Duskwarp-violet twilight tint; `cinderloom` = ember
atmosphere (warm smoky gradient, dimmer/redder sun, a drifting DARK SMOKE
cloud deck, ash-haze horizon so `sky.getFogColor()` feeds ash-coloured fog);
`nevermend` = pale void (desaturated icy gradient, boosted stars, and an
AURORA — 3 slowly undulating translucent ribbon curtains, vertex-waved,
additive, pale cyan-green, visible mainly at night/dusk). All ramp hexes come
from `textures/palettes.js`, which embeds the canonical `brand/palette.json`
dimension ramps — nothing is invented.

**Public API.**

```js
new DimensionSky(sky, { fadeTime = 1.0 } = {})   // sky: a DynamicSky (kept, never forked)
DIMENSIONS                 // exported: ['warpwold', 'cinderloom', 'nevermend']
ds.setDimension(name) -> bool  // ~1s eased crossfade; re-selecting = no-op;
                               // unknown names warn + return false
ds.dimension               // getter
ds.update(dt, ctx)         // crossfade step + aurora night gating + smoke drift
ds.setEnabled(on)          // off = natural sky (tint removed, smoke/aurora
                           // hidden); dimension + fade state remembered
ds.enabled; ds.dispose();  // dispose restores the natural sky
// no .object3d — smoke/aurora are parented into the sky rig via addSkyObject
```

**Integration snippet.**

```js
import { DimensionSky } from './dimensionSky.js';
const dimSky = new DimensionSky(sky, { fadeTime: 1.0 });
// per frame, right after sky.update: dimSky.update(dt, ctx);
// then sky.getFogColor(ctx.skyColor) — fog/water inherit the dimension grade.
dimSky.setDimension('cinderloom');
```

**Perf notes.** Allocation-free per frame (all Colors/uniform objects
prebuilt; the tint object handed to `sky.setPaletteTint` is mutated in place
and re-installed only while fading). Adds 1 draw for the smoke deck and 3 for
the aurora ribbons, each `visible=false` whenever its opacity is ~0 — the
warpwold steady state costs zero extra draws. Aurora visibility is driven by
the live sun altitude, so it fades in at dusk without any scripting.

### ambientLife.js — `AmbientLife` (Environment phase)

**What it does.** Dimension-keyed ambient particle fields, switched with a
~1 s opacity crossfade (per-field `uFade` uniform — no per-particle work):
`'warpwold'` = drifting warm-gold pollen/dust motes (normal blending, reads as
sunlit dust; thinned smoothly by rain), `'cinderloom'` = floating embers
rising with sinusoidal turbulence + per-particle flicker (additive, feeds
bloom), `'nevermend'` = slender pale thread-wisps descending in slow spirals.
Optional leaf drift: tiny green squares tumbling through the tree-canopy band
(from `setFoliageBand` or the `setVolume` leaf-block scan). Fields are
camera-boxed with toroidal wrapping (same scheme as the rain/snow systems), so
they work anywhere in the world.

**Public API.**

```js
new AmbientLife(scene, { camera = null } = {})
al.setDimension(name)      // 'warpwold'|'cinderloom'|'nevermend'; ~1s crossfade;
                           // unknown names fade all fields out
al.setLeafDrift(on)        // tumbling-leaf sprinkles near canopy height
al.setFoliageBand(yMin, yMax)  // explicit canopy band (world Y)
al.setVolume(volume)       // heuristic band from leaf blocks (id 6), padded
al.setDensity(d)           // 0..1 particle budget (demo maps quality presets:
                           // low .3 / medium .6 / high .85 / ultra 1)
al.update(dt, ctx); al.setEnabled(on); al.enabled; al.dispose(); al.object3d
```

**Integration snippet.**

```js
import { AmbientLife } from './ambientLife.js';
const ambient = new AmbientLife(scene, { camera });
ambient.setVolume(volume);           // foliage band from leaf blocks
ambient.setDimension('warpwold');
ambient.setDensity(0.6);             // medium preset
// per frame: ambient.update(dt, ctx);  // rain thins the warpwold motes
```

**Perf notes.** Architecture mirrors `particles.js` exactly: one
`THREE.Points` per field over fixed-capacity typed-array pools (motes 700,
embers 550, wisps 400, leaves 64 — live-point ceiling at density 1 is 764),
zero per-frame allocation, screen-capped `gl_PointSize`. Steady state is 1
draw call (+1 with leaf drift); during a crossfade two fields overlap for
~1 s. Fields fully faded out are not drawn at all.

### photomode.js — `PhotoMode` (Environment phase)

**What it does.** Self-contained photo mode: free-fly compose camera,
cinematic framing overlay, and high-resolution still capture — designed to
sit BESIDE the demo without touching demo.js or postprocessing.js. `enter()`
saves the camera transform + OrbitControls state, disables the controls and
switches to drag-look free-fly (deliberately NOT pointer-lock — plain
left-drag to look — so it works in iframes and headless captures); `exit()`
restores everything bit-for-bit. Controls: W/S/A/D + Q/E (world up/down),
Shift = ×4, left-drag = look (YXZ, pitch clamped). Dispatches window
CustomEvents `photomode:enter`/`photomode:exit` — the demo listens and flips
scenic mode + letterbox, this module never reaches into the demo.

**The DoF decision (skipped — letterbox/vignette instead).** A depth-aware
DoF pass needs the scene depth buffer, which lives inside postprocessing.js's
render-target chain: reproducing it here would mean a second scene render
(doubling frame cost) or reaching into PostFX internals (out of bounds for
this module), and a depth-less fake (framebuffer copy + radial blur) is
fragile against composer timing. So DoF was deliberately SKIPPED in favour of
`setFrame({ vignette, letterbox })` — two DOM letterbox bars + a CSS
radial-gradient vignette, animated with CSS transitions, zero GPU cost.
`setDoF()`/`setFocus()` exist as safe inert stubs (record state, warn once,
return false) so callers can feature-detect:
`if (!photo.setDoF(true)) photo.setFrame({ vignette: true })`.

**Public API.**

```js
new PhotoMode(camera, renderer, {
  domElement,        // drag-listen target (default renderer.domElement)
  controls,          // OrbitControls-like: disabled on enter, restored on exit
  scene,             // for captureStill's default plain-render path
  render,            // ({width,height,camera,renderer}) => void — capture
                     // through a custom pipeline (wins over the scene path)
  onEnter, onExit, moveSpeed = 8, fastMultiplier = 4,
  lookSpeed = 0.0035, damping = 12 } = {})
pm.enter(); pm.exit(); pm.toggle(); pm.active
pm.update(dt)                       // call every frame; cheap no-op when inactive
pm.setFrame({ vignette?, letterbox? }) -> state   // partial updates OK;
                                    // auto-cleared on exit()
pm.setDoF(on) -> false; pm.setFocus(d) -> false   // inert stubs (see above)
pm.captureStill({ width = 2560, height = 1440, render } = {}) -> PNG dataURL
  // ONE frame at the requested resolution: drawing buffer resized at
  // pixelRatio 1 (CSS size untouched — no reflow), camera aspect fixed,
  // rendered, toDataURL read in the same JS task (valid without
  // preserveDrawingBuffer). Renderer size/pixelRatio/aspect restored in a
  // try/finally, so a render exception can never leave the renderer resized.
pm.triggerDownload(filename?, opts?) // captureStill + synthetic <a download>
pm.dispose()                        // exits if active, removes listeners + DOM
```

**Integration snippet** (how the demo captures through the full post chain):

```js
import { PhotoMode } from './photomode.js';
const photo = new PhotoMode(camera, renderer, {
  controls, scene,
  render: ({ width, height }) => {   // capture THROUGH PostFX, not around it
    post.setSize(width, height);
    post.render(0);
  },
});
window.addEventListener('photomode:enter', () => {
  demo.setScenicMode(true);          // hide viewmodel + GUI
  photo.setFrame({ letterbox: true, vignette: true });
});
window.addEventListener('photomode:exit', () => demo.setScenicMode(false));
// per frame: if (photo.active) photo.update(dt);
// after a captureStill through PostFX: post.setSize() to re-detect the live size.
```

**Perf notes.** No pointer lock, no rAF of its own, no render targets, no
per-frame allocation in `update()` (module-level scratch vectors). The
framing overlay is pure DOM (pointer-events:none) — zero interaction with the
render pipeline. `window.demo.captureStill(opts)` wraps
`photo.captureStill` and restores PostFX's RT sizes afterwards; `P` toggles
photo mode in the demo.

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
  if (photo.active) photo.update(dt);          // free-fly camera (photo mode only)

  sky.update(dt, ctx);                         // 1. sky first (owns sun + colours)
  dimSky.update(dt, ctx);                      // 1b. dimension grade crossfade +
                                               //     aurora/smoke (BEFORE getFogColor
                                               //     so fog inherits the tint)
  sky.getFogColor(ctxSkyColor);                // 2. horizon -> shared skyColor
  if (ctx.underwater) underwater.getFogColor(ctxSkyColor); // murk wins submerged

  shadows.update(dt, ctx);                     // 3. frustum follows camera + sunDir
  water.update(dt, ctx);                       // 4. waves + flow + (optional)
                                               //    planar-reflection RT pass
  underwaterOverlay.update(dt, ctx);           // 5. fog/background swap below level
  falls.update(dt, ctx);                       // 5b. waterfall/lavafall sheets + pool
  underwaterFx.update(dt, ctx);                // 5c. caustics + shafts + biolum
  ambient.update(dt, ctx);                     // 5d. dimension ambient field + leaves
  fog.update(dt, ctx);                         // 6. colour <- skyColor, density <- weather
  particles.update(dt, ctx);                   // 7. flames/weather/debris sim

  // Phase 2 modules (order among themselves does not matter):
  portal.update(dt, ctx);                      // swirl time + palette fade + burst
  cracks.update(dt, ctx);                      // break-stage animations (fires onComplete)
  viewmodel.update(dt, ctx);                   // idle bob + swing arc + sun-scaled fill
  torchMgr.update(dt, ctx);                    // nearest-N light pooling + flicker
  wind.update(dt, ctx);                        // weather-driven sway (2 uniform writes)
  biomes.update(dt, ctx);                      // no-op (PostFX eases the grade)

  // Phase 3 modules:
  props.update(dt, ctx);                       // instanced props: bounds refresh when dirty
  // chunkManager.update(dt, ctx) goes here in a multi-chunk world (LOD + distance)

  post.update(dt, ctx);                        // 8. auto night bloom boost
                                               //    (also drives god-ray sun fade + SSAO)
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

`demo.setQuality(q)` fans out to `post.setQuality(q)`, `shadows.setQuality(q)`,
`torchMgr.setMaxLights(QUALITY_LIGHTS[q])`, and (Environment phase)
`water.setReflectionQuality` (off/quarter-res/half-res/half-res),
`ambient.setDensity` (.3/.6/.85/1) and `ambient.setLeafDrift` (on at high+).
`post.setQuality` also re-gates SSAO/god rays (both OFF at low, ON at
medium+) — the demo mirrors `post.features` back into its GUI state so the
checkboxes stay honest:

| tier | shadow map | shadow frustum / PCF | bloom | blur iters | FXAA | SSAO | god rays | torch lights |
|---|---|---|---|---|---|---|---|---|
| low | 1024² | 80u / 2.0 | off | — | off | off | off | 2 |
| medium | 2048² | 70u / 3.0 | half-res | 2 | on | 8 smp, ½-res | 12 taps × 2 | 6 |
| high | 4096² | 64u / 3.5 | half-res | 3 | on | 12 smp, ½-res | 16 taps × 3 | 10 |
| ultra | 4096² | 52u / 4.0 | full-res | 4 | on | 12 smp, full-res | 20 taps × 3 | 14 |

Everything else (sky, water, particles, fog, mesher) is tier-independent by
design — their costs are already flat and low. Natural extension points for
the game: scale `Water` `segments`, `Particles` intensity, and `DynamicSky`
`stars` per tier.

## Performance

### The Phase 3 chunk pipeline in one paragraph

`buildGreedyChunkGeometry` merges runs of identical coplanar faces into single
quads under the strict AO rule (identical corner-AO tuples + per-axis
uniformity ⇒ the merged AO interpolation is bit-identical to the unmerged
mesh) and emits `tileOrigin`/`tileSpan` + local UVs so the tiled
`createVoxelMaterial({ tiled: true })` repeats one 16×16 atlas tile across a
merged W×H quad. `ChunkManager` + `sliceVolume` split the world into
per-chunk meshes (per-mesh frustum culling, seam faces culled across chunk
borders), swap distance-based LODs lazily and hide chunks past the render
distance. `InstancedProps` collapses repeated props into one draw call per
type (the demo's ~36 torch props: ~72 draws → 1). Full APIs in the module
catalog above.

### Benchmark: `bench.html`

```bash
cd graphics-lab
npm run serve                      # or: python3 -m http.server 8099
# open http://localhost:8099/bench.html — runs on load, renders the table,
# results land in window.__benchResults, window.__benchDone === true when done.
# URL overrides for quick headless runs:
#   bench.html?frames=120&warmup=5&chunks=4&seed=7&rd=72
```

Measured 2026-07-11, headless Chromium + SwiftShader, 960×540 canvas, world
96×40×96 (6×6 chunks of 16, seed 7, worldgen 15.5 ms), 480 frames at fixed dt
16.67 ms over the same 8 s orbit (10 warmup frames excluded), render distance
72 for the ChunkManager scenario:

| scenario | meshing ms | meshed tris | draw calls avg (max) | tris/frame avg | frame ms avg | frame ms p95 | update ms avg |
|---|---|---|---|---|---|---|---|
| naive (`buildChunkGeometry`/chunk) | 183.3 | 101,338 | 67 (67) | 101,338 | 0.68 | 1.3 | 0 |
| greedy (`buildGreedyChunkGeometry`/chunk) | 209.0 | 42,154 | 67 (67) | 42,154 | 0.64 | 1.2 | 0 |
| greedy + LOD + culling (`ChunkManager`, rd 72) | 133.0 | 42,154 | 37.9 (41) | 17,584 | 0.56 | 0.8 | 0.15 |

Takeaways: greedy cuts meshed triangles **2.4×** (101,338 → 42,154) for ~14%
more meshing time; ChunkManager on top drops draw calls **67 → ~38** and
rendered triangles to **~17.6k avg** (render-distance hiding + the cheaper
far LOD; THREE's frustum culling then trims further per frame), and its
meshing total is *lower* (133 ms) because distant chunks lazily build only
the LOD they need. **SwiftShader caveat:** frame-ms here is software
rasterisation — meaningless as absolute GPU numbers. Trust draw calls,
triangle counts, meshing time and the RELATIVE deltas; the frame-ms ordering
(naive > greedy > greedy+LOD) is consistent with them.

### Demo-scene budget

Measured on the Phase 1 demo chunk (48×32×48, 1600×900): **~19 draw calls,
~62k triangles** for the whole frame — 1 solid chunk mesh + 1 leaves mesh +
1 water plane + sky (dome, stars, clouds, 2 sprites) + up to 6 particle pools
+ underwater tint + fullscreen post passes.

Phase 2 adds on top of that: 3 draws for the portal (instanced frame, surface,
motes), the held item/arm overlay (a handful of tiny boxes), and 2–14 pooled
point lights whose cost is per-light shading on lit materials, not draw calls
(that per-light cost is exactly why the pool budget exists). Crack decals and
the biome grade are effectively free (≤ 4 pooled quad groups; a few ALU ops
already in the composite pass). Wind sway costs two uniform writes per frame.

Phase 3 changes to the same scene: the 36 scatter-torch props now render as
**one** `InstancedProps` draw call (was ~72 small draws), the chunk itself is
greedy-meshed by default (fewer triangles, same AO), and the post chain gains
the SSAO passes (half-res AO + 4-tap denoise at medium/high, full-res at
ultra) and the god-rays passes (quarter-res mask + 2 radial blurs — skipped
entirely whenever the sun fade is 0, i.e. all night).

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
- SSAO needs no G-buffer (normals from depth derivatives), runs half-res with
  8–12 static-loop samples and a 4-tap denoise; the AO multiply lives in the
  existing composite pass.
- God rays reuse the main HDR buffer as their occlusion mask (no second scene
  render), run everything at quarter res, and are skipped outright when the
  sun fade is 0 — night costs nothing.
- Zero per-frame allocation on the hot path everywhere (shared mutated ctx,
  scratch vectors/colours, fixed particle pools with `DynamicDrawUsage`).

## Known limitations / future work

- **Single-plane water.** One big wavy plane at `WATER_LEVEL` — correct for a
  sea/lake at a global level, wrong for elevated pools. The surface now flows
  (`setFlow`) and `FlowFalls` provides showcase waterfall/lavafall sheets, but
  those are hand-placed set pieces, not derived from voxel water data —
  per-block water meshing (and simulated flow) is still future work; the
  mesher already skips water faces in anticipation.
- **No wet-surface response in rain.** Blocks don't darken or gain specular
  when it rains; rain also falls through overhangs (no occlusion test) and only
  splashes on the water plane, not on terrain.
- **No snow accumulation.** Snow weather is particles + colour grade only; the
  terrain never whitens over time.
- **Clouds are textured layers, not volumetric.** Two stacked scrolling fbm
  alpha planes (parallax, weather-reactive) — no raymarched depth, no cloud
  shadows on the ground.
- **Greedy atlas mode drops the per-block brightness variation.** A unique
  tint per block would forbid all merging, so greedy atlas colour is neutral
  tint × face shade (the classic mesher, kept for A-B via
  `demo.toggle('greedy', false)`, still has the vary tint).
- **Single shadow frustum, no cascades.** Tuned for one ~48u chunk; a real
  view-distance world needs CSM (the texel-snap logic carries over directly).
- **SSAO normals come from depth derivatives** — 1-pixel halos can appear at
  hard depth edges (hidden by the denoise + modest intensity); torch and
  portal point lights still cast no shadows (deliberate — budget).
- **Full re-mesh per chunk edit.** `ChunkManager.rebuildChunk` limits the blast
  radius to the dirty chunk (and rebuilds only its active LOD synchronously),
  but within a chunk the build is still whole-chunk — dirty-region meshing is
  future work.
- **Underwater god rays stay off by design** (the fade includes an underwater
  term); the submerged look is fog + tint + `UnderwaterFX` (caustics, its own
  purpose-built light shafts, optional bioluminescence). The planar water
  reflection is also disabled while the camera is underwater — there is no
  refraction/Snell's-window rendering.
- **Foliage cast shadows don't sway.** Wind sway (Phase 2) displaces vertices
  in the render pass only — the depth material used for the shadow map is not
  patched, so the canopy's cast shadow stays still (invisible at ≤ 0.08u of
  travel, and the depth pass stays maximally cheap). Block-break debris still
  doesn't collide with terrain.
- **Held-item view model is unshadowed.** It's a screen-space overlay
  (`depthTest:false`); it receives scene light colour/intensity but no shadow
  maps, and its albedo is tuned to compensate.
- **Crack decal pool is small by design.** 4 decal slots / 4 concurrent break
  animations; pool exhaustion steals the oldest (never hit in the demo — size
  it up for a real game with many concurrent diggers).
- **Wind sway height mask is coarse on pure cube geometry.** The
  `fract(worldPos.y)` heuristic lands at a uniform baseline on integer-corner
  voxel meshes (whole-canopy sway, crack-free); crossed-quad plants or offset
  meshes automatically get the "upper part sways more" behaviour.
- **Sky objects are 2D.** Sun/moon are sprites, stars are screen-size points —
  fine for the pixel aesthetic, but there's no parallax/eclipse logic.
