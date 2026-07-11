# Loomfall — developer / QA reference

Working title in code comments: "Voxelheim". User-facing name: **Loomfall**.

## Running

```sh
npm install
PORT=3000 node server/index.js   # serves public/ + /ws + /api/worlds
```

Open `http://localhost:3000`. Worlds persist to `saves/<id>.json`.

## Node test suites (all plain node, exit 0 = pass)

```sh
npm test                        # runs every tests/*.test.mjs via tests/run-all.mjs
node tests/worldgen.test.mjs
node tests/mesher.test.mjs
node tests/physics.test.mjs
node tests/raycast.test.mjs
node tests/dircull.test.mjs
node tests/net.test.mjs         # spawns the real server on PORT=3105
node tests/security.test.mjs    # spawns the real server on PORT=3310
```

`tests/security.test.mjs` locks in the server hardening (frame cap, rate
limits, movement/reach/bounds validation, bedrock floor, name/chat
sanitization, REST write lockdown — see docs/PROTOCOL.md §7). If you change
server behavior, keep that suite green or update it deliberately.

## QA hook: `window.__game`

`window.__game` is **`undefined` before the first game session ever starts**
(the property does not exist until a world is entered), an object while a
game session is active, and `null` after a session is torn down (quit to
title). Test code should therefore gate on truthiness (`window.__game?.…`),
not on `'__game' in window`. It is re-published (same shape, some fresh
references) after a dimension switch. **Every field is a live production
object — there are no test doubles.** The same lifecycle applies to
`window.__qa` (see "__qa adapter" below).

| Hook | Type | Notes |
| --- | --- | --- |
| `__game.version` | string | game version, e.g. `"0.1.0"` |
| `__game.player` | `Player` | `position` (AABB min corner / feet), `velocity`, `onGround`, `flying`, `health`, `respawn()`, `toggleFlight()` |
| `__game.world` | `World` | `getBlock(x,y,z)`, `setBlock(x,y,z,id)`, `dirtyChunks`. **Replaced on dimension switch** |
| `__game.controls` | `Controls` | `yaw`, `pitch`, `sensitivity`, `input` flags, `_debugSetLocked(true)` test hook (makes `isLocked` true so mouse break/place fire headlessly), `_emit(name, ...)` fires the same production handlers the DOM events use (`'break'`, `'place'`, `'togglePause'`, `'toggleInventory'`, `'openChat'`, `'toggleDebug'`, `'selectSlot'`, `'scroll'`, `'toggleFlight'`) |
| `__game.inventory` | `Inventory` | `slots[9]`, `selected`, `selectedBlock`, `select(i)`, `cycle(dir)`, `setSlot(i,id)` |
| `__game.net` | `NetClient` | `selfId`, `connected`, `sendChat/sendEdit/sendMove`, `close()` |
| `__game.chunkRenderer` | `ChunkRenderer` | `stats` -> `{chunksLoaded, queueLength}`; `materials.opaque.map.image` is the **live atlas canvas** (sample pixels to verify texture-pack hot-swap). **Replaced on dimension switch** |
| `__game.sky` | `Sky` | `group.visible` is false in nether/end |
| `__game.peers` | `PeerAvatars` | `count`, `ids`, per-peer avatar groups in the scene (`scene.getObjectByName('peer:<id>')`) |
| `__game.setDimension(dim, opts?)` | async fn | `'overworld' \| 'nether' \| 'end'` — full dimension switch (teardown meshes, regen world, respawn, fog/sky swap, net dim notify). `opts.near = {x, z}` picks where the arrival spawn-scan is centered (defaults to the origin). User-facing entry points are **portals** and the pause-menu **Travel** row |
| `__game.travelTo(dim)` | async fn | the full travel UX: fade to black (~400 ms), `setDimension` near the player's coords, fade back in. This is what portal dwell and the pause-menu Travel row call |
| `__game.portals` | `PortalSystem` | `charge` (s of continuous portal overlap), `cooldown` (s), `traveling`, `playerInPortal()`, `handlePortalPlacement(x,y,z)`, `collapseAt(x,y,z)` (see `public/src/gameplay/portals.js`) |
| `__game.getDimension()` | fn | current dimension id string |
| `__game.ui.menus` | menus API | `showMain/showWorldSelect/showSettings/showPause/hideAll/setLoading/getSettings` |
| `__game.ui.chat` | chat API | `open/close/isOpen/addMessage({name,text,system})` |
| `__game.ui.hud` | HUD API | `showCrosshair(b)/setHealth(0..20)/setBreakProgress(p\|null)` |
| `__game.ui.debugOverlay` | debug API | `toggle/setVisible/setData` (F3 overlay) |
| `__game.ui.inventoryUI` | inventory screen API | `toggle/open/close/isOpen/setBlocks(ids)` |
| `__game.ui.hotbar` | hotbar API | `setSlots(ids)/setSelected(i)` |
| `__game.settings` | object | live settings `{renderDistance, fov, sensitivity, texturePack}` — **same reference for the whole page lifetime**; mutate via the settings menu, not directly |
| `__game.quality` | `AutoQuality` | adaptive performance governor: `software` (true when the WebGL context is a software rasterizer, e.g. SwiftShader), `scale` (current internal-resolution scale, applied as the renderer pixel ratio), `fastLighting` (true when chunks use the unlit fast materials) |

### Recipes

```js
// Wait for the spawn area to be meshed
await page.waitForFunction(() => window.__game?.chunkRenderer.stats.chunksLoaded >= 9);

// Headless input: enable mouse handlers without real pointer lock
window.__game.controls._debugSetLocked(true);

// Aim the camera (Controls owns rotation; angles are radians)
const c = window.__game.controls;
c.yaw = 0; c.pitch = -0.8; c._applyCameraRotation();

// Break / place through the production path (same handlers as mousedown)
window.__game.controls._emit('break');
window.__game.controls._emit('place');

// Open the pause menu through the production path
window.__game.controls._emit('togglePause');

// Sample the live atlas canvas (texture-pack hot-swap check)
const img = window.__game.chunkRenderer.materials.opaque.map.image;
const px = img.getContext('2d').getImageData(0, 0, 1, 1).data.join(',');

// Switch dimension (raw switch — no fade; portals/Travel use travelTo)
await window.__game.setDimension('nether');
```

## Portals & dimension travel

Physical portals (`public/src/gameplay/portals.js`):

- Build a standing rectangular frame of **obsidian (id 25)** — interior
  width 2–4, height 3–5, in a vertical X- or Z-plane; corners optional.
  Place a **portal block (id 29**, in the creative palette**)** anywhere in
  the empty interior: the interior auto-fills with portal blocks (each fill
  cell goes through the synced edit path, so peers see it). An **end stone
  (id 26)** frame makes a Nevermend portal instead.
- Invalid placement (no valid frame) places nothing and prints the system
  chat hint `The frame is incomplete...`.
- Breaking any frame block or any portal block collapses the connected fill
  (also synced).
- Stand so your AABB overlaps a portal block for **1.5 s** (a violet
  vignette closes in while charging): the screen fades to black (~400 ms),
  the dimension switches — **overworld → the frame material's dimension**
  (obsidian → Cinderloom, end stone → Nevermend); **any other dimension →
  overworld** — and fades back in. Arrival spawn-scans a safe, dry spot near
  your departure coordinates (1:1 coordinate mapping). A **4 s cooldown**
  after arrival prevents instant bounce-back.
- The **pause menu has a "Travel" row** with the three dimension names as a
  creative/accessibility shortcut to the same fade + switch (documented as a
  convenience — portals are the physical route).

Related QoL behaviors:

- **Dry spawns:** the initial spawn, respawns, and overworld arrivals reject
  water/lava-topped columns — a spiral scan (up to 24 blocks) finds the
  nearest solid, non-liquid column, falling back gracefully to the original
  column when everything in range is wet.
- **Escape without pointer lock:** if pointer lock is not held while a game
  is running, an `Escape` keydown toggles the pause menu directly (the same
  production `togglePause` event). With lock held, the browser's lock-exit
  still drives pause as before.
- **F3 Biome row:** the debug overlay shows the real biome name at the
  player's column in the Warpwold (via `TerrainGenerator.biomeAt(x,z)`,
  which re-queries the exact generator noise); in Cinderloom/Nevermend the
  row shows the dimension name (their terrain has no biome field).

## __qa adapter

`window.__qa` implements a subset of the QA-plan hook contract
(`docs/QA_PLAN.md` §1.4 on the `design/parity-spec` branch), mapped onto
`__game` and live session objects. It is published/torn down together with
`__game` (object in game, `null` after quit, `undefined` before the first
session). It is always available in this build — no `?qa=1` gate (this
whole build is a dev build; deviation from the spec's gating note).

| Function | Mapping / notes |
| --- | --- |
| `version` | `1` |
| `getCaps()` | `['portals','travel','dimensions','biome','recorder','prng.legacy','prng.xoroshiro','prng.noise2d']` |
| `getPlayerPos()` | feet position: AABB horizontal **center**, feet y (`player.position` itself is the AABB min corner) |
| `getPlayerVel()` | `player.velocity / 20` — **blocks per 50 ms tick** per the spec (the engine stores blocks/s) |
| `getYawPitch()` / `setLook(yaw, pitch)` | MC-convention **degrees**: yaw 0 = +Z (south), 90 = −X (west), 180 = north; pitch + = down. Converted to/from the engine's radians (engine yaw 0 faces −Z, + turns west; engine pitch + is up) |
| `isPointerLocked()` | `!!document.pointerLockElement` |
| `onGround()` / `isFlying()` | `player.onGround` / `player.flying` |
| `getEyeHeight()` / `getAABB()` | constants `1.62` / `{w:0.6, h:1.8}` (no pose system) |
| `getBlock(x,y,z)` | block **name** string (e.g. `'air'`, `'netherrack'`) via the block registry. World y-range is `0..127` (not the spec's −64..319) |
| `isColumnLoaded(x,z)` | `world.hasChunk` for the containing chunk |
| `getHeightmapAt(x,z)` | highest non-air y, −1 for an all-air column |
| `getBiome(x,_y,z)` | biome display name in the overworld (`TerrainGenerator.biomeAt`); the dimension display name in nether/end. y is ignored (biomes are 2-D here) |
| `getSeed()` | `String(world.seed)` |
| `getDimension()` | copy of the `DIMENSIONS[dim]` record (`{id, name, fog, skyType, portalBlock}`) |
| `getFps()` | 1 s rolling average (same number as F3) |
| `getCameraFov()` | live camera fov |
| `recordTicks(n)` | Promise of `n` per-tick samples `{tick, pos, vel, onGround, pose, breakProgress, targetBlock, heldCount, itemEntities}` taken on the sim's **50 ms tick**. Caveats: `pose` is always `'standing'` (no pose system), `breakProgress` is always 0 (breaking is instant), `heldCount` is `1`/`null` (creative — no stack counts), `itemEntities` is always `[]` (no item entities). Ticks pause with the sim (pause menu / inventory), so the promise stalls while paused; it rejects if the session ends |
| `prngSample(kind, seed, n)` | first n outputs as decimal strings. `'legacy'` = exact `java.util.Random(seed).nextInt()` sequence and `'xoroshiro'` = exact xoroshiro128++ (incl. `'state:<s0>,<s1>'` raw-state form) — both match the QA plan's golden vectors (QA-S2-06). Extra kind `'noise2d'` samples the **engine's actual** `makeNoise2D(seed)` at a fixed lattice — the golden-vector probe for Loomfall's own worldgen noise (the engine uses neither java-Random nor xoroshiro). Implementation: `public/src/qa/prng.js` |

Spec items **not implemented** (the engine has no equivalent): screens/`getScreen`, poses, game modes, block states/light levels, entities/item drops, health/hunger records, net-stats/TPS mirrors, `setSetting`/`tp`/`give`/`setBlock` mutators (use `__game.world.setBlock` + `__game.net.sendEdit` directly, or `__game.player.position` for teleports), atlas hashes, audio probes.

### Local storage keys

- `loomfall.settings` — persisted settings JSON.
- `loomfall.name` — multiplayer display name (default `Wanderer` + 3 digits,
  generated and persisted on first join).

### Notes for test authors

- Keyboard `KeyT` opens chat on a `setTimeout(0)` so the "t" keystroke is not
  typed into the input — `await` a frame before typing.
- Real pointer lock needs a user gesture; headless tests should use
  `_debugSetLocked(true)` and drive `page.mouse` / `_emit` instead.
- The day cycle is 10 real minutes starting at ~0.42 (late morning), so
  fresh worlds are in daylight for screenshots.
- On software rasterizers (headless Chromium's SwiftShader) the game
  auto-engages a performance mode: `AutoQuality` scales the internal render
  resolution adaptively (floor 0.1) and chunk meshes use unlit
  `MeshBasicMaterial` with baked AO plus a day/night tint
  (`ChunkRenderer.setFastLighting`/`setLightLevel`). `ChunkRenderer` also
  applies exact culling every frame: chunks entirely beyond the fog wall are
  hidden, and provably backfacing face segments (away-pointing ±x/±z sides
  and bottom faces at or below the eye) are skipped via pre-sorted index
  variants + `drawRange` (see `engine/DirectionalCulling.js`; the culled
  faces are ones GL backface culling would discard anyway, so pixels are
  identical). The F3 `Tris` counter reports post-cull submitted triangles.
- Node suites cover the culling math: `tests/dircull.test.mjs` (including a
  brute-force check that every front-facing face is always drawn).
