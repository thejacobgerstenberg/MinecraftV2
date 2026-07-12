# Loomfall Module Contract (v1)

> Naming note: the game's user-facing name is **Loomfall**. The working name
> "Voxelheim" survives in some internal keys, code comments, and file headers
> — that is fine; do not churn identifiers over it.

All client code is browser ES modules under `public/src/`. Three.js is imported as `import * as THREE from 'three'` (resolved by the importmap in index.html to `./vendor/three.module.js`). NO bundler, NO build step. NO three/addons — implement pointer lock and controls manually.

## Coordinate & size conventions
- `CHUNK_SX = 16`, `CHUNK_SZ = 16`, `CHUNK_SY = 128` (world height). Sea level `SEA_LEVEL = 40`.
- World (x,y,z) are integer block coords. y in [0, CHUNK_SY). Chunk coords: `cx = floor(x/16)`, `cz = floor(z/16)`.
- Blocks are integer IDs stored in `Uint8Array` per chunk, indexed `x + z*16 + y*16*16` (x fastest, then z, then y).

## public/src/constants.js  (written by foundation — DO NOT modify)
Exports: `CHUNK_SX, CHUNK_SZ, CHUNK_SY, SEA_LEVEL, RENDER_DISTANCE_DEFAULT, TILE_PX, ATLAS_COLS, blockIndex(x,y,z)`.

## public/src/blocks/blocks.js  (written by foundation — DO NOT modify the IDs)
Exports `BLOCKS` (array indexed by id) and `getBlockDef(id)`. Each def: `{ id, name, tiles:{top,bottom,side} OR {all}, solid, transparent, liquid, emissive(0-15), hardness, tool }`. Tile values are STRING tile names consumed by the texture atlas. `air` is id 0 with solid:false, transparent:true.

## public/src/textures/TextureAtlas.js  (Phase: textures)
- `export const TILE_NAMES` — ordered array of every tile name used by blocks (grass_top, grass_side, dirt, stone, sand, water, log_top, log_side, leaves, planks, glass, cobblestone, coal_ore, iron_ore, gold_ore, diamond_ore, bedrock, snow, snow_side, cactus_top, cactus_side, gravel, netherrack, soul_sand, glowstone, obsidian, end_stone, purpur, red_sand, sandstone, sandstone_top, lava, portal, ...). Provide a stable index for each.
- `export function buildAtlas(packName='default') -> { canvas, texture, tileUV(name), tileIndex(name), cols, tilePx }` where `texture` is a `THREE.CanvasTexture` (NearestFilter, no mipmaps flicker: use NearestFilter mag, LinearMipmapLinear min OR NearestFilter both — pick crisp look), and `tileUV(name) -> {u0,v0,u1,v1}` in [0,1]. Atlas is `ATLAS_COLS` wide, `TILE_PX` per tile.
- Textures are drawn PROCEDURALLY (Canvas2D) by the active pack. Must look good, not noise.

## public/src/textures/texturePacks.js  (Phase: textures)
- `export const PACKS` — object keyed by pack id. At least `default`, `smooth`, `gritty`. Each: `{ id, name, drawTile(ctx, name, px, rng) }` that renders one tile at (0,0,px,px). `rng` is a seeded PRNG function returning [0,1). Provide a `makeRng(seedString)` helper (export it).

## public/src/world/noise.js  (Phase: worldgen)
- `export function makeNoise2D(seed)` and `export function makeNoise3D(seed)` returning `(x,y?,z)=>[-1,1]` value/perlin noise. Also `export function fbm2D(noise, x, z, octaves, lacunarity, gain)`. Deterministic from integer/string seed.

## public/src/world/TerrainGenerator.js  (Phase: worldgen)
- `export class TerrainGenerator { constructor(seed, dimension='overworld'){} generateChunk(cx, cz) -> Uint8Array(16*16*128) }`.
- Overworld: biomes plains, forest, desert, mountains, snow, ocean chosen via temperature+humidity noise; height via fbm; water up to SEA_LEVEL; dirt/grass/sand/snow surface; stone below; bedrock at y=0; caves (3D noise threshold); ore veins (coal/iron common low, gold/diamond deep); trees in plains/forest (log+leaves), cactus in desert.
- `dimension='nether'`: netherrack, lava seas ~y31, soul sand patches, glowstone, low ceiling, no sky.
- `dimension='end'`: floating end_stone islands over void, sparse.
- Must be deterministic from seed.

## public/src/engine/Chunk.js  (Phase: engine)
- `export class Chunk { constructor(cx, cz){ this.data=Uint8Array(16*16*128) } get(x,y,z) set(x,y,z,id) }` (LOCAL coords 0..15 / 0..127). `key` helper `chunkKey(cx,cz)`.

## public/src/engine/World.js  (Phase: engine)
- `export class World { constructor(generator){} getBlock(x,y,z)->id  setBlock(x,y,z,id)  getChunk(cx,cz)  ensureChunk(cx,cz)  hasChunk() }`. Handles out-of-range y as air/solid-bottom. `setBlock` marks the affected chunk(s) dirty (and neighbor chunks if on a border) via a `dirtyChunks` Set of keys.

## public/src/engine/ChunkMesher.js  (Phase: engine)
- `export function buildChunkMesh(world, cx, cz, atlas) -> { opaque: THREE.BufferGeometry|null, transparent: THREE.BufferGeometry|null }`. Use GREEDY MESHING or at minimum face-culling (skip faces between two opaque blocks). Per-face UVs from `atlas.tileUV(tileName)` for the correct face (top/bottom/side). Include per-vertex AO or face shading (top brightest, sides mid, bottom dark) baked into a color attribute. Water/glass/leaves go in the `transparent` geometry. Positions are in WORLD space (offset by cx*16, cz*16) so meshes can be added directly to the scene.

## public/src/engine/ChunkRenderer.js  (Phase: engine)
- `export class ChunkRenderer { constructor(scene, world, atlas){} update(playerPos, renderDistance)  rebuild(cx,cz)  dispose() }` — loads/unloads chunk meshes around the player, rebuilds dirty chunks, applies frustum culling (rely on THREE frustum via mesh.frustumCulled=true), uses a MeshLambert/Standard material with `map: atlas.texture, vertexColors:true` for opaque and a transparent material for water/glass. Additive extensions (optional, backward compatible): `constructor(scene, world, atlas, opts?)` with `opts.fastLighting` (unlit MeshBasicMaterial chunk materials for software rasterizers; see `setFastLighting`/`setLightLevel`), and `update(playerPos, renderDistance, eyePos?)` where eyePos drives exact fog-distance chunk hiding and directional backface culling (engine/DirectionalCulling.js, engine/AutoQuality.js).

## public/src/engine/Sky.js  (Phase: engine)
- `export class Sky { constructor(scene){} update(timeOfDay /*0..1*/) }` — gradient sky color, sun + moon directional lights, hemisphere/ambient light, animated clouds (simple). Day/night cycle drives colors.

## public/src/gameplay/physics.js  (Phase: gameplay)
- `export function moveAndCollide(world, aabb, velocity, dt) -> {position, onGround}` AABB-vs-voxel swept collision. Player AABB ~0.6×1.8×0.6.

## public/src/gameplay/Player.js  (Phase: gameplay)
- `export class Player { constructor(world, camera){ position, velocity, onGround, flying } update(dt, input)  respawn() }` — gravity, jump, sprint, creative flight toggle (double-tap space), applies physics via physics.js, mounts camera at eye height.

## public/src/gameplay/Controls.js  (Phase: gameplay)
- `export class Controls { constructor(domElement, camera){} input // {forward,back,left,right,jump,sprint,sneak,sneakOrDescend,mouseDX,mouseDY} lock() unlock() }` — pointer lock, WASD, mouse look (yaw/pitch), space/shift, keys for hotbar 1-9, scroll wheel, E, Esc. Expose an event emitter or callbacks for: break, place, selectSlot(i), toggleInventory, togglePause, toggleFlight.

## public/src/gameplay/raycast.js  (Phase: gameplay)
- `export function raycastVoxel(world, origin, dir, maxDist) -> { hit:bool, x,y,z (block hit), nx,ny,nz (adjacent empty for placement), face }` DDA voxel raycast.

## public/src/gameplay/Inventory.js  (Phase: gameplay)
- `export class Inventory { slots[9], selected, creativeBlocks[] }` hotbar + selection.

## public/src/dimensions/dimensions.js  (Phase: dimensions)
- `export const DIMENSIONS = { overworld, nether, end }` each `{ id, name, fog, skyType, portalBlock }`. `export function portalTarget(current)`.

## public/src/net/NetClient.js  (Phase: multiplayer)
- `export class NetClient { connect(url, worldId, name){} onState(cb) onPeerMove(cb) onEdit(cb) onChat(cb) sendMove(pos,yaw,pitch) sendRespawn() sendEdit(x,y,z,id) sendChat(text) }` WebSocket wrapper. Protocol JSON messages `{t:'join'|'move'|'respawn'|'edit'|'chat'|'peers'|'welcome', ...}`. `sendRespawn()` announces a respawn teleport; the server only honors the following over-budget move back into the spawn anchor (no unconditional resync grace — docs/PROTOCOL.md §7 rule 6).

## public/src/ui/*  (Phase: ui)
- `hud.js` (crosshair, hotbar render, health), `debug.js` (F3 overlay: fps, xyz, chunk, biome, facing), `chat.js`, `inventory.js` (E screen, creative block palette), `menu.js` (main menu, settings, world select, pause), `hotbar.js`. Each exports init/update functions operating on DOM elements defined in index.html.

## public/src/main.js  (Phase: integration)
- Bootstraps everything: creates renderer/camera/scene, atlas, world+generator, player, controls, chunk renderer, sky, UI, net. Runs the requestAnimationFrame loop. Wires menu → start world → game. THIS FILE is written during integration; module authors must NOT edit it (except the integration agent).

## Server: server/index.js  (Phase: multiplayer, hardened)
- Express serves `public/` statically. `ws` WebSocket server on same HTTP server at path `/ws`. REST (read/create only): `GET /api/worlds`, `POST /api/worlds` (create {name,seed}), `GET /api/worlds/:id`. There is **no REST write endpoint** — the old `PUT /api/worlds/:id` was removed in the security hardening pass; world edits persist exclusively through validated WS `edit` messages. World rooms broadcast join/move/edit/chat (plus a client->server `respawn` announcement). Persist worlds to `saves/<id>.json` as `{id,name,seed,createdAt,edits:{dim:{"x,y,z":id}}}`. Default port 3000 (env PORT).
- The server is authoritative and enforces: 64 KiB frame cap, per-connection message/edit/chat rate limits, movement speed validation with explicit grace teleports only (join / dimension change / announced respawn into the spawn anchor; no unconditional resync), 6-block edit reach (unified with the client's raycast reach), coordinate bounds, y=0 bedrock protection, dimension binding, and name/chat sanitization + HTML escaping. Full table: docs/PROTOCOL.md §7. Regression suite: `tests/security.test.mjs`; `npm test` runs all suites via `tests/run-all.mjs`.

## Support packages (Phase: audio/visual integration)
- `public/graphics/` — graphics-lab package (its README + API_CONTRACT.md are the reference). The game wires exactly three modules from `src/`: `PostFX` (bloom + ACES + vignette + FXAA; `render(dt)` replaces `renderer.render`, `setQuality('low'..'ultra')`, `setEnabled(false)` = plain-render bypass for the `off` tier), `DistanceFog` (linear mode; far plane matches the chunk fog-culling wall, color tracks `ctx.skyColor` per frame), `Particles` (`spawnBlockBreak(pos, [r,g,b])` debris; its rain/snow emitters are intentionally NOT driven — the weather package owns precip visuals). Its DynamicSky/voxelMesher/voxelMaterial duplicate verified engine systems and must stay unwired.
- `public/audio/` — procedural audio engine (`engine.js`, default export `AudioEngine`; see its README for the 66 SFX keys + 5 music modes). Game code never calls it directly: `public/src/audio/GameAudio.js` wraps every call crash-proof, owns the block-id→material map, dimension music/ambience, and the rain-loop/thunder pairing. Three volume buses map to `settings.volumeMaster/volumeSfx/volumeMusic`.
- `public/weather/` — `WeatherSystem(scene, camera)` (rain/snow/lightning). Its `SkyController` is neutralized (`weather.sky.dispose()` right after construction): our `Sky` owns background/lights, `DistanceFog` owns `scene.fog`, and main.js bridges `lightning.getFlash()` into the sky light rig (and `setLightLevel` in fast-lighting mode). The overworld-only weather machine lives in main.js (`weatherMachineTick`).
- All three packages import three.js ONLY via the bare specifier `three` (the game importmap). Their vendored three copies were deleted at integration; never reintroduce a second three build.

## Mobs + content (Phase: mobs/content integration)
- `public/mobs/` — creature package (13 species + The Last Needle boss): `MobManager` (default export; `update(dt)`, `setDimension(id)`, `setDay(bool)`, `spawn(archetype,pos)`, `spawnBoss(pos)`, `dispose()`, EventTarget events `mobSpawn/mobHurt/mobDeath/mobAttack/mobDrop/mobDespawn/bossDefeated`), `spawnRules.js` (`CANONICAL_ID`, per-dimension day/night tables, despawn rules), `lootTables.js`, `ai.js`, `creatures/*`. Reference: `public/mobs/README.md`. Imports three ONLY via the bare specifier; falls back to the REAL block registry (no more blocksAdapter). main.js injects `getBlockDef` and a world proxy that **floors coordinates** (mob AI samples float positions; `World.getBlock` expects ints) and follows dimension travel.
- `public/content/` — canonical Loomfall content data (served statically, snapshot of `feature/story-content:content/` head): `achievements.json`, `naming.json`, `tips.json`, `splashes.json`, `deathmessages.json`, `GAME_GUIDE.md`, `molthkin.json`, plus reference lore/data (`bestiary`, `boss`, `items`, `books`, `dialogue`, `structures`, `lore/onboarding/ending` docs) for future stages.
- `public/src/systems/contentpack.js` — the shared ContentPack loader (vendored from `feature/content-integrate`'s frozen API + marked builder extensions): `pack` singleton, idempotent async `load()`, deep-frozen never-throw getters (`getAchievements`, `splash`, `tip`, `deathMessage`, `dialogue/dialogueLine`, `bestiary/mobs`, `item/items/recipe`, `boss`, `structures/structure`, `book/books`, `caption/captionText`, `binding/bindings`, `tutorial`, + builder `naming()`/`guide()`). Every content/ux consumer reads this one loaded snapshot.
- `public/src/systems/events.js` — `export const gameEvents` page-lifetime bus (`on(name,fn)->off`, `emit(name,detail)`); event names documented in docs/DEV.md.
- `public/src/systems/achievements.js` — `initAchievements({bus, audio, pack, caps})` engine: wires ONLY triggers whose events exist (31/60 today), per-world localStorage persistence, toast UI + `achievement` fanfare, pause-menu Achievements screen. `stats() -> {total, wired}`.
- `public/src/systems/naming.js` — canonical display layer over engine ids: `loadNaming()`, `blockDisplayName(engineName)`, `biomeDisplayName(engineBiome)`, `canonBlockIdFor(engineName)`, curated `CANON_BLOCK_ID`/`CANON_BIOME_ID` maps. Display only — engine ids stay the wire/persistence contract.
- `public/src/systems/deathmessages.js` — `loadDeathMessages()`, `deathMessageFor(cause, playerName)` ({player}-templated canon lines; causes `mob:<canonicalId>`, `void_unravel`, `fall`, `lava`, `drowning`, ...).
- `public/src/ui/deathscreen.js` (`initDeathScreen({onRespawn}) -> {show(message), hide(), isShowing()}`) and `public/src/ui/help.js` (`initHelp() -> {open, close, isOpen}` + sanitizing `renderMarkdown(md)`).
- `Player` addition: `onKillPlane` callback — when set, falling below the kill plane routes through the death flow instead of silently respawning.

## Style
- Modern ES2020+. No TypeScript. Clear names. Small focused modules. Every module is independently importable and side-effect free except main.js and server.
