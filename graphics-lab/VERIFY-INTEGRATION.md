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
debug hook" there, **required** here: every stack probe goes through
`window.gfx` (and its `exposes` escape hatch). No `window.gfx`, no green gate.

## The checks, and what each RED means

| # | Check | What it probes | If RED, do this |
|---|---|---|---|
| a | console clean | zero console/page errors from page load through world entry (also fails if the game never reaches a live session) | INTEGRATION.md **Step 0** sanity check — module graph must resolve clean; fix boot errors first |
| b | GraphicsStack live (`window.gfx`) | `window.gfx` exists, is a `GraphicsStack` (duck-typed: `setTimeOfDay`/`meshChunk`/`render`/`setTexturePack`), and `exposes.ctx` is live (`init()` completed) | **Step 1**: construct, `await gfx.init({...})`, and set `window.gfx = gfx` |
| c | chunk geometry has `'ao'` | scene meshes (via `gfx.scene` / `__game.chunkRenderer.scene`) whose geometry carries the `ao` vertex attribute | **Step 2**: mesh chunks through `gfx.meshChunk` (greedy path bakes `ao`), paired with `gfx.materials` |
| d | DynamicSky drives fog colour | `gfx.exposes.ctx.skyColor` changes when `setTimeOfDay` jumps day↔midnight (Δrgb > 0.05) | **Step 3a** (sky/fog keys on); if the module exists but is inert, `gfx.update(dt)` isn't in the game loop (**Step 1b**) |
| e | PostFX in the render chain | `gfx.exposes.post.enabled` **and** observed offscreen `setRenderTarget` writes on `gfx.renderer` (frames really route through the RT chain) | **Step 3b** (delete `post:false`); if enabled but zero RT writes, `gfx.render()` isn't the frame's final render call (**Step 1b**) |
| f | water animated | water `uTime` uniform advances + pixels change in the lower half across two frames. **SKIP** (not fail) when the module is off (nether/end) or animating but out of view at spawn | **Step 3c**: water keys on + `waterLevel: SEA_LEVEL` (40); if `uTime` frozen, `gfx.update(dt)` missing (**Step 1b**) |
| g | `setTexturePack('gritty')` changes terrain | atlas canvas hash changes AND >1% of centre-frame pixels change on screen (pack restored afterwards) | **Step 3e**; if the atlas swaps but the screen doesn't, chunk meshes aren't using `gfx.materials` (**Step 2**) |
| h | fps budget | 5 s rAF sample + draw calls/tris for one composed frame (`renderer.info`) | **advisory only — never fails the gate.** SwiftShader (software GL) fps is not representative of real GPUs; findings 9 in INTEGRATION.md Step 4 has the perf guidance |

Required checks: a–e always; f and g when they don't SKIP. `--json` output has
`ok`, per-check `status`/`evidence`/`hint`, and the screenshots dir (boot,
water-1/2, pack-before/after, final — plus `server.log`).

## Current status at builder head `804e736` (2026-07-11)

Boot is healthy (menu → world entry, zero console errors) but the stack is not
wired: checks b–g all red with `window.gfx` undefined, 0/625 meshes carrying
`ao`. That is the expected starting state — the gate goes green as you land
INTEGRATION.md steps 1 → 2 → 3.
