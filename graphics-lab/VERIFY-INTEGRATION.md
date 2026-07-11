# VERIFY-INTEGRATION.md — the acceptance gate for a wired GraphicsStack

Run this AFTER doing INTEGRATION.md in the real game (`feat/voxel-sandbox-game`).
It boots your game headless, enters a world through the real menu, and probes
whether the stack is **genuinely rendering the frame** — not just copied in.
Exit code 0 = every required check green.

## Run it (one command)

```sh
node graphics-lab/verify-integration.mjs
```

That clones this repo to a temp dir, checks out `feat/voxel-sandbox-game`,
runs `npm ci --omit=dev`, starts `node server/index.js` (your `npm start`),
plays through Main menu → Play → Create world, runs the checks, prints the
table, and kills/removes everything it started.

Variants:

```sh
node graphics-lab/verify-integration.mjs --game-dir /path/to/checkout   # your working copy
node graphics-lab/verify-integration.mjs --url http://localhost:3000    # already-running server
node graphics-lab/verify-integration.mjs --json                         # machine-readable
# also: --branch <name>  --port <n>  --keep  --shots-dir <dir>
```

## The named-global convention (the contract)

**`window.gfx` must be the live `GraphicsStack` instance.** This is
INTEGRATION.md Step 1, statement 7 (`window.gfx = gfx;`) — marked "optional
debug hook" there, **required** here. But only the checks that must reach
*inside* the stack are gated on it: PostFX (RT-chain instrumentation on
`gfx.renderer`), water (`gfx.exposes.water` uniforms), and texture pack
(`gfx.setTexturePack`). AO and sky are judged on the **observable outcome**
and pass independently of `window.gfx` (see Equivalences below). No
`window.gfx` still means no green gate — the `gfx-global` check itself stays
required.

## Equivalences — outcomes accepted in place of lab conventions

The gate tests what the player sees, not graphics-lab's internal conventions.
Two implementations are accepted as equivalent:

1. **AO baked into `color` (accepted alongside the `'ao'` attribute).** The
   lab's greedy mesher emits a dedicated `ao` vertex attribute; the game's own
   `ChunkMesher` bakes face-shade × AO directly into the per-vertex `color`
   attribute (grayscale, indexed quads, 4 verts/face). Both produce the same
   on-screen result. Detector: sample chunk-scale meshes (`>=300` verts) that
   carry a `color` attribute; walk the index buffer in 6-index strides — two
   triangles sharing ≥2 verts form a quad face, otherwise each triangle is
   judged alone (a triangle always lies within one face, so flat per-face
   tinting can never false-positive); non-indexed geometry is judged
   per-triangle. A face counts as AO-varying when its per-channel
   (max − min) vertex-color spread exceeds **0.02** (auto-rescaled for 0–255
   byte colors). PASS needs **≥10%** of ≥50 sampled faces varying — flat
   per-face shading (face shade or biome tint only) measures 0%.
2. **Client-owned sky (accepted alongside DynamicSky).** Any sky whose
   *rendered output responds to time of day* passes. Probe order:
   - **path=gfx.setTimeOfDay** — day (0.35) vs midnight (0.0) via the stack,
     `ctx.skyColor` Δ > 0.05;
   - **path=__game.sky hook** — the game loop calls
     `__game.sky.update(timeOfDay, pos)` every frame; the gate wraps it to
     force day (0.40) vs midnight (0.0), then requires fog/background color
     Δ > 0.05 **and** > 1% of sky-band pixels (top 30% of frame) changed
     between the two screenshots (`sky-day.png` / `sky-night.png`);
   - **path=gradient-fallback** — no time hook at all: measure a vertical sky
     gradient on the boot shot and report **SKIP with reason** (advisory,
     never fails the gate).
   The evidence line always names which path ran.

## The checks, and what each RED means

| # | Check | What it probes | If RED, do this |
|---|---|---|---|
| a | console clean | zero console/page errors from page load through world entry (also fails if the game never reaches a live session) | INTEGRATION.md **Step 0** sanity check — module graph must resolve clean; fix boot errors first |
| b | GraphicsStack live (`window.gfx`) | `window.gfx` exists, is a `GraphicsStack` (duck-typed: `setTimeOfDay`/`meshChunk`/`render`/`setTexturePack`), and `exposes.ctx` is live (`init()` completed) | **Step 1**: construct, `await gfx.init({...})`, and set `window.gfx = gfx` |
| c | AO in chunk geometry | scene meshes (via `gfx.scene` / `__game.chunkRenderer.scene`) carry EITHER an `ao` vertex attribute OR AO baked into `color` with ≥10% of sampled faces showing intra-face vertex-color spread > 0.02 (see Equivalences #1). Runs without `window.gfx`. | bake per-vertex AO into `color` (side1/side2/corner rule, varying *within* faces — flat per-face tint doesn't count), or mesh through `gfx.meshChunk` (**Step 2**, greedy path bakes `ao`) |
| d | sky responds to time of day | rendered sky/fog tracks a forced day↔midnight jump via `gfx.setTimeOfDay` or the game's own `__game.sky.update` hook (see Equivalences #2). Runs without `window.gfx`. No time hook at all → **SKIP** (advisory gradient fallback), never FAIL. | if a hook exists but the frame doesn't track it: the sky update isn't in the frame loop (`gfx.update(dt)` — **Step 1b** — or the game loop's `sky.update` call) |
| e | PostFX in the render chain | `gfx.exposes.post.enabled` **and** observed offscreen `setRenderTarget` writes on `gfx.renderer` (frames really route through the RT chain) | **Step 3b** (delete `post:false`); if enabled but zero RT writes, `gfx.render()` isn't the frame's final render call (**Step 1b**) |
| f | water animated | water `uTime` uniform advances + pixels change in the lower half across two frames. **SKIP** (not fail) when the module is off (nether/end) or animating but out of view at spawn | **Step 3c**: water keys on + `waterLevel: SEA_LEVEL` (40); if `uTime` frozen, `gfx.update(dt)` missing (**Step 1b**) |
| g | `setTexturePack('gritty')` changes terrain | atlas canvas hash changes AND >1% of centre-frame pixels change on screen (pack restored afterwards) | **Step 3e**; if the atlas swaps but the screen doesn't, chunk meshes aren't using `gfx.materials` (**Step 2**) |
| h | fps budget | 5 s rAF sample + draw calls/tris for one composed frame (`renderer.info`) | **advisory only — never fails the gate.** SwiftShader (software GL) fps is not representative of real GPUs; findings 9 in INTEGRATION.md Step 4 has the perf guidance |

Required checks: a–c and e always; d, f and g when they don't SKIP (d SKIPs
only when no time hook exists at all). `--json` output has `ok`, per-check
`status`/`evidence`/`hint`, and the screenshots dir (boot, sky-day/night when
path B runs, water-1/2, pack-before/after, final — plus `server.log`).

## Current status at builder head `804e736` (2026-07-11, outcome-based gate)

Boot is healthy (menu → world entry, zero console errors), and the two
outcome-based checks now PASS on the game's own renderer:

- **AO** — PASS via the `color` convention: the game's `ChunkMesher` bakes
  face-shade × classic side1/side2/corner AO into grayscale vertex colors;
  ~70% of sampled faces show intra-face spread (threshold 10%).
- **sky** — PASS via the `__game.sky` hook: forcing day↔midnight through the
  game's own `Sky.update` swings background/fog by Δ≈2.1 and changes 100% of
  sky-band pixels.

Still red (all genuinely gfx-gated): `gfx-global` (`window.gfx` undefined),
PostFX, water, texture pack — `GATE: FAIL — 4 of 7 required checks red.`
Those go green as you land INTEGRATION.md steps 1 → 3.

The green path is validated against `integrate-selftest.html` (a live
GraphicsStack, no menu): all 7 required checks PASS there, with AO matching
via the `'ao'`-attribute convention and sky via `path=gfx.setTimeOfDay` — so
both accepted conventions are exercised by the two validation targets.
