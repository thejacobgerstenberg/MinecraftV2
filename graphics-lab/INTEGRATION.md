# INTEGRATION.md — adopting graphics-lab in the builder's game

Ordered, paint-by-numbers checklist for wiring the graphics-lab stack into the
builder repo (`feat/voxel-sandbox-game`, verified against head `98c7ea9`).
Everything below was proven end-to-end against the builder's **real**
`TerrainGenerator` — see `integration/FINDINGS.md`, the demo
`integration-demo.html`, and screenshots 26–29. The single entry point is
`integrate.js` (`GraphicsStack`): one facade, 7 statements, instead of wiring
20+ modules individually. Every signature below is copied from the shipped
source, not from memory.

Do the steps **in order**. Each of steps 1–3 is independently revertible.

---

## Step 0 — copy files (no code changes yet)

Copy these four artifacts into the builder repo, **preserving their relative
layout** (integrate.js resolves `./src/…`, `./textures/…`, `./settings/…`
via relative imports, and injects `./settings/settings.css` via
`import.meta.url`). Recommended target: `public/graphics/`.

| Copy | To | Notes |
|---|---|---|
| `graphics-lab/integrate.js` | `public/graphics/integrate.js` | The facade. Must stay a sibling of `src/`, `textures/`, `settings/`. |
| `graphics-lab/src/*` (whole dir, 30 files) | `public/graphics/src/` | The modules. `demo.js` / `gui.js` / `worldgen.js` / `benchmark.js` ride along harmlessly (reference demo only; nothing in `integrate.js` imports them). |
| `graphics-lab/textures/*` (whole dir) | `public/graphics/textures/` | `atlas.js`, `labAdapter.js`, `packFormat.js`, `packs.js`, `painters.js`, `palettes.js` are required imports; `browser/`, `gallery.html`, `selftest.mjs`, `test.html` are optional extras. |
| `graphics-lab/settings/*` | `public/graphics/settings/` | `settings.js` + `settings.css` (the CSS is auto-injected by `attachSettingsPanel`). `preview.html` optional. |

**three.js — do NOT copy `graphics-lab/vendor/`.** The lab vendors three
**r160**; the builder repo already vendors the **same revision r160** at
`public/vendor/three.module.js`, and `public/index.html` already has the
importmap entry

```json
{ "imports": { "three": "./vendor/three.module.js" } }
```

Every lab module imports the bare specifier `three`, so with the files under
`public/` they resolve through the builder's existing importmap onto the
builder's own copy — zero remap work, one three instance on the page
(verified: import resolution was finding #1 in `integration/FINDINGS.md`,
"clean — no adapters needed"). Only if the copied files ever move to a page
*without* that importmap do you add the same `"three"` mapping there.

Sanity check: load any page that imports
`public/graphics/integrate.js` — the module graph must resolve with **zero**
console errors before you continue.

## Step 1 — minimal adoption (the 7-statement init)

This is `integrate-selftest.html` verbatim, with the lab's demo volume swapped
for the builder's chunk store. The provider contract (from
`adaptVolume` in `integrate.js`) is
`{ getBlock(x,y,z), size:{sx,sy,sz}, ids:'builder', waterLevel?, lights? }`
— local coords `0..size-1`, out-of-range handled by the facade (returns air).
`ids:'builder'` (the default) makes the facade remap builder ids 0–29 to lab
semantics itself via its exported `BUILDER_TO_LAB` table.

In `public/src/main.js`, after the world exists:

```js
import { GraphicsStack } from '../graphics/integrate.js';                    // 1
import { SEA_LEVEL, CHUNK_SY } from './constants.js';                        //  (already there)

const volumeProvider = {                                                     // 2
  // World.getBlock is WORLD-space; the provider is LOCAL 0..size-1, so
  // offset by the slice origin (ox/oz = min world x/z of the region you
  // hand the stack, e.g. renderDistance chunks around spawn).
  getBlock: (x, y, z) => world.getBlock(ox + x, y, oz + z),
  size: { sx: SX, sy: CHUNK_SY, sz: SZ },
  ids: 'builder',
  waterLevel: SEA_LEVEL,          // 40 — NOT the lab default 10 (finding 10)
};
const gfx = new GraphicsStack({ quality: 'medium', texturePack: 'default',   // 3
                                dimension: 'warpwold' });
await gfx.init({ domElement: document.body, volumeProvider,                  // 4
                 waterLevel: SEA_LEVEL });
gfx.setTimeOfDay(0.35);                                                      // 5
gfx.start();                                                                 // 6  (throwaway; replaced in 1b)
window.gfx = gfx;                                                            // 7  (debug hook, optional)
```

That renders the builder's real terrain through the full stack in its own
canvas — the smoke test. Verify: terrain textured + AO'd, sky + clouds, water
plane at y=40 on overworld, no console errors (`gfx.init()` measured
300–360 ms including atlas build + first mesh).

**Step 1b — merge into the real loop.** For the actual game, don't let the
facade own the frame or the scene:

- Pass the game's objects: `gfx.init({ scene, camera, renderer, volumeProvider, waterLevel: SEA_LEVEL })`.
  `init` sets `renderer.outputColorSpace = SRGBColorSpace` and
  `renderer.toneMapping = NoToneMapping` — main.js already runs exactly that
  config (main.js:545–546), so nothing observably changes.
- Skip `gfx.start()`. In the game loop call `gfx.update(dt)` then
  `gfx.render()` **instead of** the existing `renderer.render`/PostFX call
  (`render()` goes through the stack's PostFX and self-bypasses when post is
  disabled).
- Games that stream their own chunk meshes pass
  `enable: { worldMesh: false }` to the constructor so the facade doesn't
  build its single world mesh (then see Step 2).
- Drive game state through the facade's mirrors of the proven demo fan-outs:
  `setTimeOfDay(t)`, `setWeather('clear'|'rain'|'snow')`,
  `setUnderwater(bool)`, `setDimension('warpwold'|'cinderloom'|'nevermend')`,
  `setQuality('low'|'medium'|'high'|'ultra')`, `toggle(name, bool)`.

Rollback: delete the block, restore the old `renderer.render` call.

## Step 2 — mesher swap (ChunkMesher → `gfx.meshChunk`)

The builder's `buildChunkMesh(world, cx, cz, atlas)` →
`{ opaque, transparent, cutout }` is replaced per chunk by the stack's greedy
path:

```js
const geom = gfx.meshChunk(chunkProvider);            // { greedy:true, ao:true } defaults
// geom = { solid, transparent, stats:{ quadsBefore, quadsAfter } }
const solid  = new THREE.Mesh(geom.solid, gfx.materials.solid);
const leaves = geom.transparent
  ? new THREE.Mesh(geom.transparent, gfx.materials.leaves) : null;
if (leaves) leaves.renderOrder = 1;
```

Rules (all verified in code / on real terrain):

- **Pair greedy output ONLY with `gfx.materials`** (the tiled pair) — greedy
  geometry carries `tileOrigin`/`tileSpan` + local UVs that a plain material
  would smear across the whole atlas. `gfx.meshChunk(vol, { greedy:false })`
  is the classic-mesher fallback; pair that with `gfx.plainMaterials`.
- **Positions are volume-local**, not world-space like ChunkMesher's output —
  set `mesh.position` to the chunk origin.
- **`BUILDER_TO_LAB` remap semantics** (exported from `integrate.js`): the
  remap happens at the volume boundary, so solidity/opacity/water/leaves
  semantics are native (water 8→7 is *not* meshed — the water plane module
  owns it; leaves 10→6 land in the `transparent` bucket). Ids without a lab
  analogue map to the nearest visual equivalent: ores/cobble/bedrock/
  obsidian/purpur/netherrack read as stone, sandstone/end-stone as sand.
  Keep the builder mesher (Step 2 is optional!) if per-block texture identity
  matters more than greedy merging + wind sway + tiled AO.
- **Caveats from FINDINGS (3/6):** `glass(12)` and `portal(29)` map to **air**
  — they vanish. `lava(28)` maps to **glowstone(9)**: a solid emissive-*textured*
  block, not a liquid and not an emissive material (the nether lava ocean
  renders as a glowstone-textured plane). Do not swap the nether mesher until
  the emissive-lava TODO (Step 4, item 6) lands.
- **Chunk seams (finding 7):** the provider bounds-check returns air outside
  `size`, so per-chunk providers emit walls on chunk borders. Mesh with
  neighbour reads (route `getBlock` through `world.getBlock`, which already
  resolves neighbour chunks — size the provider to the full loaded region) or
  accept the demo's island-edge look only for throwaway slices.

Rollback: this is a per-chunk geometry swap behind whatever flag you gate it
with — flip back to `buildChunkMesh` and dispose the greedy geometries.

## Step 3 — per-module adoption, in this order

Adopt features by *subtraction*: init with everything off, then delete one
`enable` key per step. Every key is honoured by `GraphicsStack._on()` —
default **on** except the opt-ins `viewmodel`/`photomode`. Each step is
revertible by putting its key back (or at runtime via `gfx.toggle(name, bool)`).

Start from:

```js
new GraphicsStack({ quality: 'medium', texturePack: 'default', enable: {
  worldMesh: false,                                   // game streams its own chunks
  water: false, underwater: false, underwaterfx: false,
  post: false, biome: false,
  particles: false, ambient: false, torchlights: false, wind: false,
  // sky, dimensionSky, shadows, fog stay ON — that's step 3a
}});
```

1. **3a — sky + fog (+ shadows).** Keys `sky`, `dimensionSky`, `shadows`,
   `fog` on. The sky owns the sun + hemisphere rig; fog tracks the horizon
   colour. With `post:false`, `gfx.render()` self-bypasses to plain
   `renderer.render`. *Rollback:* `enable:{ sky:false, fog:false, shadows:false }`
   (shadows/dimensionSky auto-skip when the sky is off).
2. **3b — post (+ biome grading).** Delete `post:false, biome:false`. Brings
   HDR bloom/ACES/FXAA/SSAO/god-rays per quality tier. Requires the renderer
   config from step 1b (already the builder's config). *Rollback:* put the
   keys back — render falls back to plain.
3. **3c — water.** Delete `water:false, underwater:false, underwaterfx:false`
   and make sure `waterLevel: SEA_LEVEL` (40) reaches `init` or the provider
   (finding 10 — forgetting it strands the plane 30 blocks under the beach).
   Keep all three **off** for nether/end dimensions: the nether "sea" is lava
   at y=31 and the end floats over void (the integration demo does exactly
   this). *Rollback:* restore the keys.
4. **3d — atmosphere + ambient.** Delete `particles:false, ambient:false,
   torchlights:false, wind:false`. Torch lights + torch flames only do
   something when the provider carries `lights: [{x,y,z}, …]` — register the
   **adjacent air cell**, never the emissive block itself (finding 5; see
   `integration/main.js` §2 for the proven neighbour-scan). *Rollback:*
   restore keys, or `gfx.toggle('particles'|'ambient'|'torchlights'|'wind', false)`.
5. **3e — texture packs + settings panel.** Hot-swap packs with
   `gfx.setTexturePack('default'|'smooth'|'gritty'|'woven'|'accessible')`
   (re-meshes the facade-owned world; game-owned chunk meshes re-mesh
   themselves via `gfx.meshChunk` since `gfx.materials` had its atlas swapped
   in place). Mount the drawer with
   `const panel = gfx.attachSettingsPanel({ storageKey: 'mc2.graphics' })` —
   it injects `settings.css`, replays persisted state onto the stack
   (preset → `setQuality`, fov/fpsCap, per-effect toggles), and every change
   also broadcasts a `graphics-settings-change` CustomEvent on `window`
   (`detail = { key, value, settings }`) so game systems the facade doesn't
   own (render distance, vsync, portalFx) can listen and react. *Rollback:*
   `panel.destroy()`; don't call `attachSettingsPanel`.

## Step 4 — the 10 findings as TODOs

Copied from `integration/FINDINGS.md` (the real-worldgen run at builder head
`98c7ea9`; full text there). Owner + severity per item:

| # | TODO | Owner | Severity |
|---|---|---|---|
| 1 | Import resolution: clean, no adapters needed — **no action**. | — | INFO |
| 2 | Chunk-format friction: stack wants `getBlock(x,y,z)` over the region; builder chunks are per-chunk `Uint8Array` (`blockIndex(x,y,z) = x + z*16 + y*256`). Route the provider's `getBlock` through the chunk map (as `World.getBlock` already does) instead of the demo's flatten-copy. | builder | MED |
| 3 | Lossy id mappings: `glass(12)`/`portal(29)` → air, `lava(28)` → glowstone. Add glass + portal handling (or keep builder mesher for those chunks) before shipping nether/portals on the lab mesher. | both | HIGH |
| 4 | **Torch palette gap**: the builder palette has NO torch block; the overworld generator places zero emissive blocks — night overworld has no derived light emitters at all. Add a torch block / emitter placement to light overworld nights. | builder | HIGH |
| 5 | **Adjacent-air light registration**: `TorchLightManager.register()` centres the point light inside the given cell — registering the emitter's own coords buries the light in an opaque block (our first nether shots were pitch black around 400 lights). Register the exposed air neighbour; document this rule in the facade API docs. | graphics-lab | MED |
| 6 | **Emissive-lava mapping**: point-light falloff (distance 14 / decay 1.8 / ≤14 pooled lights) is torch-scale — a 3000-block lava ocean gets ~10 pools of glow. Add an emissive material path (map builder `emissive` 0–15 into the voxel material) instead of more point lights. | graphics-lab | HIGH |
| 7 | **Slice boundary handling**: out-of-bounds reads return air, so slice edges render as cut walls / open sides (the orange band in shot 28 is sky, not lava glow). Mesh with neighbour-chunk reads or clamp boundary reads so side walls cull. | builder | MED |
| 8 | **Sky-light occlusion**: the stack has no per-block sky light — sun/hemi light every face they reach, so caves/nether interiors get sunlit strips through openings. Feed the game's own light values into the mesher (lab AO is geometry-only). | both | HIGH |
| 9 | Perf (SwiftShader, 1600×900, quality high, 64×128×64): mesh **per-chunk** (~10 ms each), not whole-slice (150 ms); composed frame 34 draw calls / 197,773 tris with world geometry only 2 of those calls — headroom for render distance is in mesh count, not stack overhead. | builder | INFO |
| 10 | `waterLevel` must be `SEA_LEVEL` (40), not the lab default (10); disable water/underwater/underwaterfx for nether (lava sea at y=31) and end (void). | builder | LOW |

## Reference artifacts

- `integrate.js` — the `GraphicsStack` facade (single import surface).
- `integrate-selftest.html` — the 7-statement minimal adoption, runnable.
- `integration-demo.html` + `integration/main.js` — the proof: builder's real
  `TerrainGenerator` (vendored byte-exact, `integration/builder/PROVENANCE.md`)
  through the full stack at quality high, presets
  `?preset=day|night|cinderloom|nevermend`.
- `integration/FINDINGS.md` — the 10 findings above, in full.
- `README.md` — per-module APIs, perf tables, screenshots 26–29 (the
  real-worldgen shots).
