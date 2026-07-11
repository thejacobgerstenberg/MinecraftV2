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
| `__game.controls` | `Controls` | `yaw`, `pitch`, `sensitivity`, `input` flags, `_debugSetLocked(true)` test hook (makes `isLocked` true so mouse break/place fire headlessly), `_emit(name, ...)` fires the same production handlers the DOM events use (`'break'` — per-click instant actions: mob attack, portal collapse, flight instant-break; `'breakStart'`/`'breakEnd'` — bracket the hold-to-break timed mining; `'place'`, `'togglePause'`, `'toggleInventory'`, `'openChat'`, `'toggleDebug'`, `'selectSlot'`, `'scroll'`, `'toggleFlight'`) |
| `__game.inventory` | `Inventory` | `slots[9]`, `selected`, `selectedBlock`, `select(i)`, `cycle(dir)`, `setSlot(i,id)` |
| `__game.net` | `NetClient` | `selfId`, `connected`, `sendChat/sendEdit/sendMove`, `close()` |
| `__game.chunkRenderer` | `ChunkRenderer` | `stats` -> `{chunksLoaded, queueLength}`; `materials.opaque.map.image` is the **live atlas canvas** (sample pixels to verify texture-pack hot-swap). **Replaced on dimension switch** |
| `__game.sky` | `Sky` | `group.visible` is false in nether/end |
| `__game.peers` | `PeerAvatarsPlus` | (= `__game.stack.peersManager`) `count`, `ids`, per-peer skinned avatar groups in the scene (`scene.getObjectByName('peer:<id>')`), `receiveEmote(id, emoteId)` |
| `__game.stack` | `PlayerStack` | the avatars/social facade (`public/avatars-integrate/integrate.js`) — the SINGLE owner of `net.onState/onPeerJoin/onPeerLeave/onPeerMove/onChat/onDisconnect` (never re-bind those; read `stack.presence` instead). `presence` (roster store: `players`, `get(id)`, skins/swatches/pings), `whisper` (`handleInput('/w name text')`, `isMuted/isBlocked`), `social` (`toggleSpectator()`, `isSpectating()`, `feed.events()`, `playerList`), `emote(id)` (plays locally + broadcasts), `cycleViewMode()` / `setViewMode('first'\|'third-back'\|'third-front')`, `thirdPersonCamera` |
| `__game.localAvatar` | avatar handle | our own third-person body (`createAvatarPlus`): `group` (`player:self`), `isEmoting()`, `stopEmote()` — hidden in first person |
| `__game.setDimension(dim, opts?)` | async fn | `'overworld' \| 'nether' \| 'end'` — full dimension switch (teardown meshes, regen world, respawn, fog/sky swap, net dim notify). `opts.near = {x, z}` picks where the arrival spawn-scan is centered (defaults to the origin). User-facing entry points are **portals** and the pause-menu **Travel** row |
| `__game.travelTo(dim)` | async fn | the full travel UX: fade to black (~400 ms), `setDimension` near the player's coords, fade back in. This is what portal dwell and the pause-menu Travel row call |
| `__game.portals` | `PortalSystem` | `charge` (s of continuous portal overlap), `cooldown` (s), `traveling`, `playerInPortal()`, `handlePortalPlacement(x,y,z)`, `collapseAt(x,y,z)` (see `public/src/gameplay/portals.js`) |
| `__game.getDimension()` | fn | current dimension id string |
| `__game.weather` | weather API | `setWeather('clear'\|'rain'\|'storm'\|'snow')` forces the logical machine state; `getState()` -> `{machine, presented, weather, intensity}` (`presented` is what the `WeatherSystem` shows: snow biomes present precip as snow, non-overworld dims force clear); `strike(opts?)` -> Promise resolving `{far}` at the flash peak; `setIntensity(v, ramp?)`; `on(type, handler)`; `system` is the raw `WeatherSystem` (public/weather/) |
| `__game.audio` | `GameAudio` | crash-proof wrapper over the procedural engine (public/audio/). `audio.state` is the QA stub-check surface: `{resumed, contextState, plays, lastSound, music, rain, volumes}` — `plays` counts every attempted `play()` even while the AudioContext is suspended (autoplay policy). `audio.engine` is the raw `AudioEngine` |
| `__game.fx` | object | `{ post: PostFX, fog: DistanceFog, particles: Particles, cracks: BlockCracks, viewmodel: FirstPersonViewModel, grading: BiomeGrading }` — `post`/`fog`/`particles` are OWNED by the GraphicsStack facade (same live objects as `window.gfx.exposes.*`); `post.enabled`/`post.quality`/`post.features` (`ssao`/`godrays` are preset toggles: off at medium, on at high/ultra), `fog.fog` is the live `THREE.Fog` installed on the scene, `particles.spawnBlockBreak(pos, [r,g,b])`, `cracks` shows destroy-stage decals during hold-to-break (stage = floor(progress\*5)), `viewmodel` is the first-person held block (`swing()` fires on break/place clicks and while mining), `grading.biome` follows the dimension (sennmeadows / emberwarp / the_fraying) |
| `window.gfx` (also `__game.gfx`) | `GraphicsStack` | the graphics-lab facade (public/graphics/integrate.js) — single owner of PostFX, distance fog, particles, the animated water plane and pooled torch lights. `gfx.exposes.{post,fog,particles,water,torches,ctx,atlas}`, `gfx.setQuality('low'..'ultra')` (driven by the Graphics Quality dropdown; 'off' = `gfx.toggle('post', false)`), `gfx.setTexturePack(id)` hot-swaps BOTH the facade atlas and the game atlas (and the dropdown path notifies the facade back). Required by the acceptance gate `node graphics-lab/verify-integration.mjs`. Placed torches (30) / lanterns (31) / glowstone / lava / portal register pooled dynamic lights in their adjacent air cell (graphics-lab emitters; scan window re-centres on the player and re-scans on emissive edits) |
| `__game.mobs` | `MobManager` | public/mobs/ package (see its README): `mobs` (live array snapshot), `spawn(archetype, pos)`, `spawnBoss(pos)`, `setDimension(id)`, `setDay(bool)`, `dimension` (canonical key `warpwold`/`cinderloom`/`nevermend`), `addEventListener('mobSpawn'\|'mobHurt'\|'mobDeath'\|'mobAttack'\|'mobDrop'\|'mobDespawn'\|'bossDefeated', h)`. Frozen while paused. Every mob carries `canonicalId`, `halfWidth`, `height`, `hurt(dmg)` |
| `__game.achievements` | achievements engine | `openScreen()/closeScreen()/isOpen()`, `isUnlocked(id)`, `unlockedIds()`, `stats()` -> `{total, wired}`, `wiredIds()`, `_debugUnlock(id)` (full toast/persist path). Per-world persistence — see "Achievements" below |
| `__game.events` | event bus | the page-lifetime game event bus (`on(name, fn)` -> unsubscribe, `emit(name, detail)`) — event names below |
| `__game.deathScreen` | death screen API | `show(message)/hide()/isShowing()` — production path is health reaching 0 |
| `__game.help` | How to Play panel | `open()/close()/isOpen()` — renders /content/GAME_GUIDE.md |
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

// Break / place through the production path (same handlers as mousedown).
// 'break' fires the per-click instant actions (mob attack, portal collapse,
// flight instant-break). On foot, breaking is TIMED: hold via breakStart,
// wait breakTimeFor(hardness) seconds of sim time, then breakEnd —
// min(1.5, 0.15 + 0.5*hardness)s (0.5 -> 0.4s, 1.5 -> 0.9s, 3+ -> 1.5s;
// hardness < 0 unbreakable). While flying, _emit('break') breaks instantly.
window.__game.controls._emit('break');      // instant actions / flight break
window.__game.controls._emit('breakStart'); // begin hold-to-break
// ... wait for the progress bar ... then:
window.__game.controls._emit('breakEnd');
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
| `recordTicks(n)` | Promise of `n` per-tick samples `{tick, pos, vel, onGround, pose, breakProgress, targetBlock, heldCount, itemEntities}` taken on the sim's **50 ms tick**. Caveats: `pose` is `'standing'` or `'sneaking'` (no other poses), `breakProgress` is the live hold-to-break accumulator (0..1), `heldCount` is `1`/`null` (creative — no stack counts), `itemEntities` is always `[]` (no item entities). Ticks pause with the sim (pause menu / inventory), so the promise stalls while paused; it rejects if the session ends |
| `prngSample(kind, seed, n)` | first n outputs as decimal strings. `'legacy'` = exact `java.util.Random(seed).nextInt()` sequence and `'xoroshiro'` = exact xoroshiro128++ (incl. `'state:<s0>,<s1>'` raw-state form) — both match the QA plan's golden vectors (QA-S2-06). Extra kind `'noise2d'` samples the **engine's actual** `makeNoise2D(seed)` at a fixed lattice — the golden-vector probe for Loomfall's own worldgen noise (the engine uses neither java-Random nor xoroshiro). Implementation: `public/src/qa/prng.js` |

Spec items **not implemented** (the engine has no equivalent): screens/`getScreen`, poses, game modes, block states/light levels, entities/item drops, health/hunger records, net-stats/TPS mirrors, `setSetting`/`tp`/`give`/`setBlock` mutators (use `__game.world.setBlock` + `__game.net.sendEdit` directly, or `__game.player.position` for teleports — note that in multiplayer a direct position write past the 25 b/s speed budget is REJECTED server-side (`error: move_rejected`): peers keep seeing the old spot until the player walks back, respawns, or changes dimension, because the server has no unconditional resync grace, see docs/PROTOCOL.md §7 rule 6), atlas hashes, audio probes.

## Mobs + combat + death (mobs stage)

The creature package lives at `public/mobs/` (13 species + The Last Needle
boss — see `public/mobs/README.md` for the roster, spawn tables, loot, and
events). Integration points (`public/src/main.js`):

- **Spawning** is ambient and per-dimension/day-night (the package's
  `spawnRules.js`; caps: Warpwold 14 / Cinderloom 12 / Nevermend 10). The
  manager gets OUR `getBlockDef` and a live world proxy that floors
  coordinates (mob AI samples float positions; `World.getBlock` wants ints)
  and follows dimension travel. `setDay` is fed from `sky.daylight > 0.35`;
  `setDimension` is called on every travel. Mob updates, idle voices,
  weather, and particles are all **skipped while paused**.
- **Combat**: left-click raycasts mob hitboxes FIRST (reach 4, slab test
  against each mob's `halfWidth`/`height` AABB, occluded by closer blocks),
  then falls through to block breaking (reach 6). A hit calls `mob.hurt(4)`.
  Mob voices: `mob.<family>.hurt/death/idle` (new archetypes reuse their
  AI-family voice: bobbindeer->grazer, scaldwarden->trader, needlejack/
  frayedhound/emberspinner/unpicked/raveler/lastneedle->groaner). Mob death
  emits a debris-particle poof; Waxling detonations play `explosion`.
- **Player damage**: `mobAttack` events decrement `player.health`
  (explosions only when `hitPlayer`), update the HUD shards, play `hurt`,
  and flash the screen red (`.hurt-flash`). Environmental hazards
  (`environmentTick` in main.js) add three more canon causes: `fall`
  (landing tally over a 3-block grace, liquid breaks the fall), `lava`
  (molten-skein contact, 4 dmg / 0.5 s) and `drowning` (eyes under water
  past a 10 s breath, 2 dmg / s) — all three skipped while flying (creative
  concession). At 0 health the death screen shows a message from
  `/content/deathmessages.json` templated by cause (`mob:<canonicalId>`,
  `void_unravel` for the kill plane, `fall`/`lava`/`drowning`) — Respawn
  re-stitches at the spawn column and resets health. While dead the player
  sim is frozen but the world keeps running.
- **Boss**: `__game.mobs.spawnBoss(pos)` — 3 phases (60%/15% hp), summons
  Raveler adds, and on 0 hp emits `bossDefeated` (bound, no loot) which
  grants the `taught_to_mend` achievement. The defeat chat line comes from
  `dialogue.json` (`lastNeedle.onBound` / `molthkin.onFelled` via the
  ContentPack), with the old hardcoded line as offline fallback.
- **KNOWN DELTA (molthkin)**: canon `content/molthkin.json` defines a
  **3-phase** encounter ("The Long Shift" / "Feeding the Fire" / "The Last
  of the Thread", hp 280 dmg 11 spd 2); the engine's MobManager still runs
  its simplified **2-phase** molthkin (`phase1HpFrac 0.5`). The canon file
  ships and loads (`pack.boss('molthkin')`), but the encounter rework is a
  later wave — do not treat the in-engine phase count as canon. Likewise
  canon `boss.json` now gates the Last Needle summon on four
  `seal_released:*` predicates (selvage_outpost gauntlet); that data is
  loaded as data only — no seal system exists in the engine yet.

## Game event bus (`__game.events`, `public/src/systems/events.js`)

`main.js` emits; the achievements engine (and future systems) listen:

| Event | Detail | When |
| --- | --- | --- |
| `block:broken` | `{blockId, name, canonId, dim}` | production break path (not portal collapse) |
| `block:placed` | `{blockId, name, canonId, dim}` | production place path |
| `item:collected` | `{itemId, count}` | mob loot drop lands, or a canon-mapped block is broken (creative "collect") |
| `mob:killed` | `{canonicalId, archetype}` | non-boss mob death |
| `mob:drop` | `{itemId, count}` | each loot stack |
| `boss:defeated` | `{canonicalId, achievement, victoryTrigger}` | The Last Needle bound |
| `player:died` | `{cause, message}` | health reached 0 (cause e.g. `mob:waxling`, `void_unravel`, `fall`, `lava`, `drowning`) |
| `player:respawned` | `{}` | death-screen Respawn |
| `dimension:entered` | `{dim, canonDim}` | session start + every travel (canonDim: `warpwold`/`cinderloom`/`nevermend`) |
| `night:survived` | `{}` | dawn after a full overworld night without dying |
| `portal:lit` | `{dim}` | a portal frame was successfully lit |
| `chat:sent` | `{length}` | chat message sent |
| `pack:switched` | `{packId, from}` | texture pack changed in settings |
| `world:created` | `{id, name}` | world created from the menu |

`canonId`/`itemId` use the canonical naming.json ids via the curated
engine-block -> canon-block mapping in `public/src/systems/naming.js`
(grass->warpsod, stone->threadstone, obsidian->cinderglass, ...).

## Achievements (`public/src/systems/achievements.js`)

Reads achievements through the shared ContentPack (60 achievements; direct
fetch of `/content/achievements.json` is the no-pack fallback). Only
triggers whose events exist in this build are wired — **31 of 60**:
`first_block_broken`, `player_unpicked`, `survive_first_night`,
`enter_dimension:cinderloom/nevermend`, `kill_entity:*` for implemented
mobs (needlejack, emberspinner, waxling, scaldwarden, molthkin, unpicked,
raveler, selvage_warden, last_needle), `collect_count:*` / `place_block:*`
/ `place_count:*` for canon ids obtainable via loot or the block mapping
(incl. `knotlight` via the torch mapping).
NOT wired (no engine system yet — no stub triggers): crafting, trading,
biome entry (engine biomes don't map onto the canon trigger biomes),
anchors/binding, smelting, taming, depth, thrum, frays, ending choices.
Unlocks persist per world in localStorage, raise a top-right slide-in toast
+ the `achievement` fanfare, and are listed (locked/unlocked, hidden ones
masked) in the pause-menu **Achievements** screen.

## Content wiring

All runtime content flows through the shared **ContentPack**
(`public/src/systems/contentpack.js`, vendored from
`feature/content-integrate`'s frozen loader; `pack` singleton, one
idempotent `pack.load()` per page, deep-frozen getters that never throw).
It loads every `/content/*.json` (+ `GAME_GUIDE.md`, a builder extension)
and the `/ux` data files (`captions.json`, `bindings.default.json`,
`tutorial.json`); per-file failures degrade to documented fallbacks.
Consumers:

- `pack.splash()` — main-menu splash pool, 155 lines (inlined fallback list
  in `ui/menu.js` shown synchronously pre-load / offline).
- `pack.tip(category?)` — loading overlay shows a random canon tip (61),
  rotating every 6 s while chunks stream.
- `pack.naming()` (via `systems/naming.js`) — canonical display names for
  blocks (hotbar tooltips + selection label, inventory hover, F3 `Target`
  row) and biomes (F3 `Biome` row analog mapping); engine ids stay
  internal. `lava` always displays as "Molten Skein" (canon mandate),
  `portal` as "Loom-Gate", `torch` maps to canon `knotlight`.
- `pack.deathMessage(cause, {player})` (via `systems/deathmessages.js`) —
  death screen + chat broadcast lines (21 causes).
- `pack.guide()` — "How to Play" (main menu + pause), rendered by a small
  sanitizing markdown pass (headings/bold/lists; code + tables as monospace
  blocks); direct fetch fallback kept.
- `pack.getAchievements()` — the achievements engine (below).
- `pack.dialogueLine('lastNeedle','onBound')` / `('molthkin','onFelled')` —
  boss defeat chat line.
- F3 additions: `Target` (looked-at block display name), `Mobs` (live mob
  count).

## Audio / visual integration (graphics + audio + weather packages)

Three support packages live under `public/` (each README documents its full
API): `public/graphics/` (PostFX, DistanceFog, Particles — the game uses
exactly those three modules; its DynamicSky/voxelMesher/voxelMaterial
duplicate verified systems and are NOT wired), `public/audio/` (procedural
`AudioEngine`, wrapped by `public/src/audio/GameAudio.js`), and
`public/weather/` (`WeatherSystem` — its `SkyController` is neutralized at
construction because our `Sky` owns background/lights and `DistanceFog` owns
`scene.fog`; the lightning flash is bridged into our sky/light rig and, in
fast-lighting mode, into `ChunkRenderer.setLightLevel`).

- **Graphics quality** (`settings.graphicsQuality`): `off` bypasses the post
  chain entirely (plain `renderer.render`); `low`..`ultra` map to PostFX
  tiers (bloom off at low; FXAA on medium+; full-res bloom at ultra).
  Default `medium`.
- **Distance fog** is `THREE.Fog` (linear) whose far plane matches the
  chunk fog-culling wall (`max(48, (renderDistance + 0.5) * 16)`) and whose
  color tracks the live sky/horizon every frame — chunk pop-in stays hidden
  at night and during weather (the old static fog color only matched the
  midday sky).
- **Weather machine** is overworld-only: mostly clear, rolls every ~2
  in-game hours (rain sometimes, storms rarer). Storms auto-strike
  lightning; thunder plays ~90 ms after each flash starts (the visible
  peak). While the player stands in a Snowfield/Snowcap biome,
  precipitation presents as snow. Other dimensions force clear visuals.
- **Audio events**: block break/place (`break.<mat>`/`place.<mat>` via the
  block→material map in GameAudio.js), footsteps throttled by ground
  distance (~2.2 blocks/step) on the block under the feet, splash on
  entering liquid, portal whoosh on travel, `ui.click` on menu buttons,
  per-dimension music (`calm`/`nether`/`mysterious`) + ambience beds
  (overworld wind, Cinderloom cave), rain loop with live intensity, thunder
  near/far. `hurt` fires on player damage, `achievement` on unlocks,
  `levelup` on the boss binding; mob voices (`mob.<family>.*`) and
  `explosion` are driven by the mob events (see "Mobs + combat + death").
- **Autoplay policy**: the AudioContext is created lazily and `resume()`d on
  the first pointerdown/keydown/menu click. Before that, every `play()` is
  harmless (suspended context) and still counted in `__game.audio.state`.

Deferred graphics-lab modules (one line each, per the integration plan):
water plane + `UnderwaterOverlay` (single global-level plane would
double-render/z-fight our per-block meshed water), `ShadowController` (needs
lit materials + `applyToScene` after every chunk build; software-rasterizer
fast path uses unlit materials), torch flames/`TorchLightManager` +
view model + block cracks + wind sway + biome grading (no torches/held-item
rendering/progressive breaking yet — natural next-stage candidates).

### Local storage keys

- `loomfall.settings` — persisted settings JSON: `{renderDistance, fov,
  sensitivity, texturePack, graphicsQuality, volumeMaster, volumeSfx,
  volumeMusic}`.
- `loomfall.name` — multiplayer display name (default `Wanderer` + 3 digits,
  generated and persisted on first join).
- `loomfall.skin` — optional skin-descriptor JSON override (future customizer
  hook). Absent = the descriptor is derived deterministically from
  `loomfall.name` (FNV-1a → theme/hues), so a player looks the same every
  session and on every client.
- `loomfall.social` — whisper mute/block lists (name-keyed, persisted by the
  social layer's WhisperController).
- `loomfall.achievements.<worldId>` — per-world achievements state:
  `{unlocked: {id: isoTimestamp}, counters: {"collect:<itemId>"|"place:<canonId>": n}}`.

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

## HUD theming, captions & volume (HudKit + AudioStack adoption)

- **Tier-1 theme** — `main.js` boots `HudKit.init(...)` (`public/ui-integrate/
  integrate.js`) and calls `applyTheme()`: it injects 4 `<link data-hudkit>`
  stylesheets (`ui-kit/tokens.css`, `ui-kit/base.css`,
  `ui-integrate/brand-theme.css`, `ui-integrate/settings-shell-fix.css`) after
  `css/style.css` and sets `html[data-theme=dark]`. Zero markup change — the
  bespoke widgets re-skin via their own `--bg0/--panel/--green/...` vars, which
  the brand overlay remaps to `--lf-*` tokens. Revert = `hudKit.removeTheme()`.
- **Caption bridge** — `new AudioStack().attach(audio)` (`public/audio-integrate/
  integrate.js`) wraps GameAudio + its engine so **every** sound also dispatches
  window `lf-audio-event` `{name, direction, volume, loop, ended, category}`
  with real positional direction (from the wrapped `setListener`). Revert =
  `audioStack.detach()`.
- **Captions overlay** — the `Sound Captions` settings toggle (persisted as
  `loomfall.settings.captions`, default **off**) mounts/unmounts
  `<lf-captions>` (`public/ux/captions/`) into `#hud`. Caption table:
  `public/ux/captions/captions.json` (break/place/step marked `directional`
  for this game — sounds are positional). Caption lines render as
  `lf-captions .lf-captions__line` with `.lf-captions__text` and chevron
  `.lf-captions__dir` spans (`data-direction` attr).
- **Volume widget** — the settings screen docks the shadow-DOM
  `<volume-settings>` element (`public/audio/volume-settings.js`) in place of
  the three bespoke volume sliders. It binds `audio.engine`, persists to
  localStorage **`audio.volumes`**; legacy `loomfall.settings` volume keys are
  migrated there once at load (`menu.js migrateVolumeSettings`). `main.js`
  mirrors widget input into `audio.setVolumes` so `audio.state.volumes` (QA
  surface above) stays truthful.
- **Gap-fill sounds** — inventory palette pick and mob-loot pickup play `pop`
  (`audioStack.pickup`); `ui.click` now fires for **any** `button.vx-btn`
  click (menus, pause, help, achievements, death screen) via document-level
  delegation. Door/chest/eat/drink registry keys remain unwired — the game has
  no such features today.

## Multiplayer social layer (PlayerStack adoption)

`main.js` boots ONE `PlayerStack` per session (`public/avatars-integrate/
integrate.js`, wiring `public/avatars/` + `public/avatars-plus/` +
`public/social/`). It replaces `new PeerAvatars(scene)` and owns the
NetClient's single-slot peer/chat/disconnect callbacks (fan-out inside the
facade — never re-bind them; see `__game.stack` above).

- **Skinned peers** — every player carries an encoded skin descriptor in the
  join frame (`docs/PROTOCOL.md` §4); the server validates (`[a-z0-9.]`,
  ≤128) and echoes it, so the same peer renders identically on all clients.
  Missing/invalid skins fall back to a deterministic hash-of-id look.
- **Nameplates** — name + health bar sprites above peers, distance-faded
  (full ≤24 blocks, floor 0.15 at 48).
- **Hold Tab** — player-list overlay (`<lf-player-list>`): swatch, name, dim
  badge (Warpwold/Cinderloom/Nevermend), ping (heartbeat RTT via `presence`
  frames; "—" until the first 30 s pong).
- **Join/leave/dim toasts** — `<lf-toast-rack>` top-right + a session feed
  (`stack.social.feed.events()`).
- **Chat commands** — `/w <name> <msg>` (alias `/msg`) directed whisper
  (server-relayed, target-only — actually private), `/r <msg>` reply,
  `/mute` `/unmute` (hide whispers), `/block` `/unblock` (hide whispers +
  public chat), `/emote <id>` (`wave nod sit cheer point dance bow
  facepalm`) — plays on the local avatar and broadcasts to same-dim peers
  (2/s server cap).
- **F5** — cycle first → third-back → third-front; the boom ray-marches
  against block solidity (our `getBlockDef(...).solid`), so it never clips
  into walls. The local avatar (`player:self`) is visible only in third
  person.
- **F6** — free-fly spectator camera (WASD + Space/Ctrl up/down, Shift
  boost); collides with blocks via the same isSolid oracle; the player body
  freezes while spectating.
