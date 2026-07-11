# P1 QA Plan — Acceptance Tests for Waves W1–W8

**Companion work plan:** [P1_WORKPLAN.md](./P1_WORKPLAN.md) · **Harness:** [QA_PLAN.md §1](./QA_PLAN.md) · **Bug filing:** [BUG_TAXONOMY.md](./BUG_TAXONOMY.md)

## 1. Harness

The harness is **docs/QA_PLAN.md §1, verbatim** — Playwright + Chromium at 1280×720, pointer-lock & input synthesis (§1.2: `ensureLocked`, `lookDelta`, `aimAt`), state reads (§1.3), the `window.__qa` test-hook contract (§1.4), the QA DOM contract (§1.5), screenshot conventions (§1.6), fixtures (§1.7), applicability gates (§1.8), measurement recipes (§1.9), and SUT launch/teardown (§1.10). It is deliberately **not duplicated here**; only the additions below are new.

**Real-SUT adaptation (normative for every W-test; supersedes QA_PLAN §1.1/§1.10's idealized endpoints):** the SUT is the builder branch `feat/voxel-sandbox-game` — a single Express + `ws` server. Launch `npm start` (= `node server/index.js`, port 3000/`PORT`; add env `QA=1` for W7's qa-flush/storage endpoints); readiness probe `GET /api/health` → `{ok:true}`; page URL **`http://localhost:3000/?qa=1`**. There is no `:5173` dev server and no separate `:25565` game server — those belong to the idealized spec stack. World fixtures are created via the real REST API (`POST /api/worlds`, docs/PROTOCOL.md). `window.__qa` is published by `main.js publishHooks()` (a thin adapter over the live `window.__game` objects, docs/DEV.md) when `?qa=1` is present. **Server authority (hardened `server/index.js` — supersedes the earlier "no server authority" parity note):** `__qa` mutators still apply **locally** and immediately (client-local dev commands), but the wire side is validated server-side — movement is charged against token buckets (controllable 25 b/s, fall 90 b/s; an over-budget `move` is **silently dropped**, and a grace teleport is honored at most once per `GRACE_COOLDOWN_MS` = 2000 ms), `edit` frames require reach ≤ 7 (`MAX_REACH`, measured from the **server-tracked** feet column, height 1.8) and ≤ 20 edits/s (`EDIT_RATE`; excess silently dropped), every edit at y=0 is rejected (bedrock floor), chat is capped at 3 msgs / 2 s (`CHAT_RATE`), payloads at 64 KiB (`MAX_WS_PAYLOAD_BYTES` = 65536), and the global inbound rate at 60 msgs/s (`MSG_RATE`, burst 120, 3 strikes → close). Normative consequences for every W-test in this document: (i) after any `__qa.tp`, **wait ≥ 2 s** (one grace-teleport window) before sending edits or asserting anything peer-visible/persisted — an immediate post-tp edit is measured against the STALE server position and silently dropped; (ii) bulk `setBlock` staging lands locally at full speed but reaches persistence/peers only for cells within reach 7 and at ≤ 20 edits/s — tests asserting a peer-visible or reload-persisted result of staged edits must stage within reach and throttle to the edit budget; (iii) never infer a FAIL from a silent server-side drop of a bursty or remote edit — assert the local state, and gate replication asserts on the budgets above.

Global conventions repeated by every wave section: **1 game tick = 50 ms** (client fixed-step accumulator; there is no server tick — tick counts are asserted via `getGameTick()` deltas, never wall clock, wherever a stepper exists); the world is 16×16×**128**, y∈[0,128), `SEA_LEVEL 40` (parity delta vs PARITY's 384/63 — every staging y-value in this document is code-space); `__qa.getBlock` returns block-def **names** from `public/src/blocks/blocks.js`; the render-distance settings key is `renderDistance` (`loomfall.settings`, `ui/menu.js`). Every test is cap-gated (§1.8) on the tokens in §2.4, so the suite is runnable at any merge state: a missing cap yields **SKIPPED-GATED**, and in-test "annotate, don't FAIL" notes record known parity deltas — neither is a failure.

## 2. New `__qa` hooks required (consolidated)

All hooks below are **additive** to the QA_PLAN §1.4 `QaHook` interface (`version` stays 1). Getters are synchronous, side-effect-free snapshots; mutators are dev commands gated on `?qa=1`; everything is implemented in `main.js` beside the existing `window.__game` wiring, landing with its owning wave. The per-wave blocks in §2.3 are normative — they already show the **resolved** signatures where wave fragments conflicted (§2.1).

### 2.1 Signature-conflict resolutions

1. **`setDifficulty`** — W2 declared `(d) => void` (settings-screen mirror); W3 declared `(d) => Promise<void>` (world-record path). **Resolved:** `setDifficulty(d): Promise<void>` — always routes through the CURRENT authoritative difficulty store (W2 interim `settings.difficulty` → W3 `world.difficulty` → W7 `world-meta` patch) and resolves when applied. `getDifficulty()` was declared identically by both — one hook.
2. **`feedMob`** — W3 declared `feedMob(id): void` as a dev stand-in until items exist; W4 supersedes it with `feedMob(mobId, itemId): boolean` through the real `MobManager.feed` path (W4's fragment states the supersession). **Resolved:** the two-arg form is the final contract; until W4 merges, the W3 interim accepts `(id)` and behaves as if fed a valid breed food (W3 tests annotate this).
3. **`getSpawnPoint`** — W6 declared `{type:'world'|'bed'|'anchor', x, y, z, dim}`; W7 declared `{x,y,z,dim} | null` (null = world spawn). **Resolved:** W6's typed shape is normative and the hook **never returns null** — "no personal spawn" is `type:'world'` with the world-spawn coordinates. W7's QA-W7-12 null-assertions read `type === 'world'` instead. The enum additionally carries **`'command'`** for a `/spawnpoint`-set personal spawn (W7) — a command-set spawn fits neither `bed` nor `anchor`, and QA-W7-12 asserts it.
4. **Gamerule dev mutators** — W6 declared `setGameRule('doDaylightCycle'|'doWeatherCycle', bool)`; W8 declared `setRule('doFireTick'|'mobGriefing'|'tntExplosionDropDecay', bool)`; W4 declared `setRandomTickSpeed(n)`. **Resolved:** one `setGameRule(rule: string, value: boolean|number)` over the shared `G.rules` read-with-default store, accepting any registered rule name (validated against W7's `GAMERULE_SPEC` once that lands). `setRandomTickSpeed(n)` survives as a W4 convenience alias for `setGameRule('randomTickSpeed', n)`; W8's `setRule` name is dropped.
5. **`setSetting` keys** — fragments use flat keys (`renderDistance`, W1) and QA_PLAN-namespaced keys (`video.renderDistance` in W3/W6 tests). **Resolved (per W7's declaration):** `setSetting` accepts the flat `loomfall.settings` keys as canonical AND aliases QA_PLAN's namespaced names (`video.renderDistance` → `renderDistance`); W6's `sound.<cat>`/`sound.subtitles` keys are genuinely nested in the settings record.
6. **`setTime` semantics shift at W6** — pre-W6, `setTime(t)` maps a nominal world time onto `main.js timeOfDay` (W3's shim: 6000→0.5 noon, 18000→0.0 midnight); once W6 lands, `setTime(t)` sets **dayTime only**, `getWorldTime()` ≡ `dayTime`, `getGameTick()` ≡ `gameTime`. Tests written against the post-W6 semantics carry the `gtTime` gate.
7. **`getEntities(type)`** — the type set grows monotonically, one enumeration surface: W2 adds `'xp_orb' | 'arrow' | 'dummy'`; W3 adds `'mob'` (entries typed `mob:<archetype>`, via the `mobEntityBridge`; suspended mobs still enumerated); W5 adds `'item'`; W8 adds `'falling_block' | 'tnt'`.

### 2.2 Upgraded existing hooks (no interface change)

- `getHealth()` → `{health, absorption, food, air, armor}` (W2; `air` in gt 0..300). The §1.8 gate token `damage` is superseded by `survival` for the extended fields.
- `getItemDef(id)` resolves item ids by name from W2's registry onward, incl. `{durability}` for armor (W2) and `maxStack`/`tool.class`/`tool.tier`/`tool.miningSpeed`/`attackSpeed` (W5). `tool.tier` IS P1_WORKPLAN P1-7-1's "harvestTier" — one field, canonical name `tool.tier`; `tool.miningSpeed` is the per-tier dig-speed divisor QA-W5-04 asserts. Stack objects returned by `getHeldItem()/getHotbar()/getInventorySlot()/getCursorStack()` gain an optional additive `damage: number` field when the def has `maxDurability` (W5).
- `getLight(x,y,z)` becomes truthful at W8: real BFS block channel + vertical-column sky channel (was heuristic/stub).
- `getBlockState(x,y,z)` returns `{block, props}` from W8's sidecar store (was `props:{}` always).
- `getChatLog(n)` entries gain an optional additive `component?: object` field — the raw text-component tree — at W7.
- `give(itemId, count)` accepts item names from W2 onward; pre-W5 it overwrites the selected hotbar slot (no stack counts — annotated), from W5 it fills real stacks.

### 2.3 Per-wave hook blocks (normative signatures)

#### W1 — worldgen

```ts
getClimate(x: number, z: number): { temperature: number; humidity: number; continentalness: number;
  erosion: number; depth: number; weirdness: number; pv: number };   // the quart-resolution sample used for biome pick
biomeAt(x: number, z: number): string;         // pure generator sample (TerrainGenerator.biomeAt), NO chunk load needed
densityAt(x: number, y: number, z: number): number | null; // final clamped density (post-slides, pre-carver); null on flat gen
scanBlocks(x0,y0,z0,x1,y1,z1): Record<string, number[]>;   // per-block-name counts indexed by y (arrays length 128);
                                                            // throws 'unloaded' if any overlapped column is not loaded
getChunkStatus(cx: number, cz: number): 'empty'|'base'|'populated'|'full'|null; // null = untracked/unloaded
getChunkSeeds(cx: number, cz: number): { popSeed: number;
  features: { name: string; step: string; stepIndex: number; index: number; seed: number }[] };
getWorldgenInfo(): { worldSeed: number; generatorType: 'default'|'flat'; seaLevel: number; worldHeight: number;
  popA: number; popB: number;                               // the odd multipliers of P1-1-1
  noiseSeeds: Record<string, number>;                       // resource-string → forked seed (P1-1-2/3)
  decorationSteps: string[];                                // full 11-name ordered enum (P1-1-29)
  oreConfigs: { block: string; size: number; count: number; height: { type: 'uniform'|'trapezoid';
    min: number; max: number; peak?: number }; discardOnAirExposure: number; deepslateVariant: string|null }[];
  biomeParameters: { biome: string; temperature: [number,number]; humidity: [number,number];
    continentalness: [number,number]; erosion: [number,number]; pv: [number,number]; weirdness: [number,number] }[];
  levelTables: { temperature: number[]; humidity: number[]; erosion: number[]; pv: number[];
    continentalness: { name: string; min: number; max: number }[] } };
getBiomeDef(id: string): Record<string, unknown>;           // the P1-2-5 registry record (world/gen/biomes.js)
getWorldSpawn(): { x: number; y: number; z: number };       // the P1-10-10 spiral result (pre-scatter)
```

#### W2 — survival core

```ts
// ---- getters (synchronous snapshots) ----
getFoodState(): { food: number; saturation: number; exhaustion: number }; // §10 meters; food/sat 0..20, exhaustion 0..4
getXp(): { level: number; progress: number; total: number };              // progress 0..1 into next level
getStatusEffects(): { id: string; amplifier: number; remainingTicks: number }[]; // amplifier 0-based (0 = L1)
getXpOrbs(): { pos: {x:number;y:number;z:number}; value: number }[];      // all live client-side XP orbs
getUseProgress(): number;                    // 0..1 eat/drink hold progress (32 gt = 1.6 s ramp); 0 when idle
getHandAnim(): { swing01: number | null; use01: number | null };          // viewmodel: attack/place swing arc, use wobble
getAttackDamage(): number;                   // melee damage if a hit landed NOW: (1 + strength − weakness) × (0.2 + t²·0.8)
getAttackCooldown(): number;                 // 0..1 charge t (used by W2/W5 timing tests)
getLastAttack(): { damage: number; crit: boolean; targetId: number | null } | null; // last player melee swing that hit an entity
getBreakSpeedMultiplier(): number;           // haste ×(1+0.1L) · fatigue ×0.3^L product (consumed by the timed-break wave)
getFallDistance(): number;                   // live fallDistance accumulator (blocks)
getDifficulty(): 'peaceful'|'easy'|'normal'|'hard';
qaComputeDamage(raw: number, opts: { armorPoints?: number; toughness?: number; epf?: number;
  resistanceLvl?: number; type?: string }): number; // pure probe of gameplay/combat.js computeDamage
getDummy(id: number): { hp: number; pos: {x,y,z}; vel: {x,y,z}; lastDamage: number } | null;

// ---- dev mutators ----
hurt(amount: number, type: string): void;    // routes through the FULL production pipeline (Player.hurt: flags, armor, iframes)
setFood(food: number, saturation: number): void;      // clamped 0..20; saturation clamped ≤ food; exhaustion reset to 0
setAir(gt: number): void;                    // 0..300 staging for drowning tests
setArmor(spec: { head?: string|null; chest?: string|null; legs?: string|null; feet?: string|null }): void;
  // material names 'leather'|'gold'|'chain'|'iron'|'diamond'|'netherite'; null clears; {} clears all
addEffect(id: string, amplifier: number, seconds: number): void;  // ids: speed, slowness, haste, mining_fatigue,
clearEffects(): void;                                             //      strength, weakness, poison, hunger
addXp(n: number): void;                      // direct add (no orbs)
spawnXpOrb(x: number, y: number, z: number, value: number): void;
spawnTestDummy(x: number, y: number, z: number): number;   // static attackable (hp 20, kbResist 0), returns id
removeTestDummies(): void;
spawnArrow(x: number, y: number, z: number, vx: number, vy: number, vz: number): number; // returns entity id
setDifficulty(d: 'peaceful'|'easy'|'normal'|'hard'): Promise<void>; // RESOLVED signature (§2.1-1): routes through the
                                             // current authoritative difficulty store; live-applies, resolves when applied
```

#### W3 — entities & mobs

```ts
// ---- mobs / entities (gate: mobs unless noted) ----
spawnMob(archetype: string, x: number, y: number, z: number): Promise<number>;
  // dev mutator. Force-spawns one mob of the given Loomfall archetype id
  // ('grazer'|'bobbindeer'|'trader'|'groaner'|'exploder'|'frayedhound'|'screecher'|'emberspinner'|'unpicked'
  //  |'needlejack'|'raveler'|'scaldwarden') — every spawn-table archetype in mobs/spawnRules.js
  // SPAWN_TABLES/SPECIES_BY_ARCHETYPE (boss 'lastneedle' excluded: hand-placed, never table-spawned)
  // at feet position (x,y,z), BYPASSING spawn-cycle checks (caps/light/radius) but not solid-overlap
  // (rejects with a thrown Error if the target AABB intersects solid). Resolves to the entity id.
clearMobs(): void;                       // remove ALL mobs instantly (no mobDeath/mobDespawn events); QA staging
setMobSpawning(on: boolean): void;       // gate the natural spawn cycle on/off; default on
getMob(id: number): {
  archetype: string; species: string; hp: number; maxHp: number;
  pos: {x:number;y:number;z:number}; vel: {x:number;y:number;z:number};
  onGround: boolean; ageTicks: number; fuse: number | null;         // fuse: remaining ticks, null unless exploder priming
  goal: string | null;                   // active goal id: 'panic'|'melee_attack'|'ranged_attack'|'random_stroll'|
                                         // 'eat_grass'|'flee_sun'|'float'|'look_at_player'|'avoid_entity'|'breed'|null
  target: 'player' | number | null;      // current attack target
  persistent: boolean; burning: boolean; woolGrown?: boolean;       // woolGrown only on grazer
  invulnerableTicks: number;
} | null;                                // null = no such live mob
getEntityAttribute(id: number, attr: string): number;               // resolved attribute value (entities/attributes.js)
hurtMob(id: number, dmg: number, source?: 'player'|'env'): void;    // dev mutator; source 'player' sets lastHurtBy=player
setMobState(id: number, patch: { woolGrown?: boolean; hp?: number }): void; // narrow QA staging mutator
// feedMob — final two-arg signature lives in the W4 block (§2.1-2); W3's interim stub accepts (id) only
//           and assumes a valid breed food (starts the Breed goal).
getMobEvents(n: number): { tick: number; type: 'mobSpawn'|'mobHurt'|'mobDeath'|'mobAttack'|'mobDrop'|'mobDespawn';
  mobId: number; archetype: string; itemId?: string; count?: number;
  explosion?: boolean; hitPlayer?: boolean }[];                     // last n entries of a ≥256-entry ring buffer
                                         // mirroring MobManager's CustomEvent stream (public/src/mobs/MobManager.js)
runSpawnCycle(nTicks: number): Promise<{ spawned: { archetype: string; pos: {x:number;y:number;z:number} }[];
  attempts: number }>;                   // run exactly nTicks spawn-cycle ticks synchronously (natural cadence
                                         // must be OFF via setMobSpawning(false)); deterministic given world+seed
getSpawnDebug(): { spawnableChunks: number;
  caps: Record<'monster'|'creature', { cap: number; count: number }> };
// setDifficulty / getDifficulty — shared with W2; resolved signature lives in the W2 block (§2.1-1). Gate: difficulty.
```

#### W4 — farming & random ticks

```ts
getRandomTick(): { speed: number;                    // effective randomTickSpeed (rules seam, default 3)
  simDistance: number;                               // Chebyshev chunks, = min(renderDistance, 6)
  sectionsPerChunk: number;                          // 8 (CHUNK_SY=128 / 16)
  positionsPerChunkPerTick: number;                  // speed × sectionsPerChunk
  tickedChunks: number;                              // owned+loaded+in-range chunks last tick
  dispatchedLastTick: number;                        // positions sampled last tick (= tickedChunks × positionsPerChunkPerTick)
  handledLastTick: number };                         // positions that hit a registered handler
setRandomTickSpeed(n: number): void;                 // convenience alias of setGameRule('randomTickSpeed', n) (§2.1-4); 0 disables
isChunkTicked(cx: number, cz: number): boolean;      // loaded ∧ within simDistance ∧ owned by this client
getChunkTickOwner(cx: number, cz: number): string;   // client id (e.g. 'p1') per the W4 ownership rule
forceRandomTicks(x: number, y: number, z: number, n: number): void; // synchronously deliver n random-tick
  // events to exactly this block (same handler path; each event rolls its own chance) — deterministic staging
getPlantInfo(x: number, y: number, z: number): { kind: 'crop'|'sapling'|'stem'|'cane'|'mushroom';
  base: string;                                      // family name, e.g. 'wheat'
  age: number; maxAge: number;                       // id-stage index within STAGE_TABLE
  growthPoints: number | null;                       // P1-21-3 points (crops/stems; null otherwise)
  chance: number | null;                             // final per-random-tick probability incl. ×0.5 compression
  lightOk: boolean; soilOk: boolean } | null;        // null if the block is not a plant
getFarmland(x: number, y: number, z: number): { wet: boolean; moisture: number;  // 0..7 (session counter)
  waterFound: boolean; rainSeam: boolean } | null;
useItemOn(x: number, y: number, z: number, itemId: string): boolean; // simulate right-click-use of an item on a
  // block via the REAL main.js use path (seeds plant, bone_meal applies); returns whether it took effect
feedMob(mobId: number|string, itemId: string): boolean;              // CANONICAL signature (§2.1-2) — real MobManager.feed path;
                                                                     // supersedes W3's one-arg interim stub
getBreeding(mobId: number|string): { archetype: string; isBaby: boolean; loveTicks: number;
  breedCooldownTicks: number; growthTicksRemaining: number; persistent: boolean } | null;
getBreedingFoods(): { species: string; vanillaName: string; foods: string[]; active: boolean }[];
setDimension(dim: 'overworld'|'nether'|'end'): void; // thin alias of window.__game.setDimension (exists per docs/DEV.md)
```

#### W5 — items, crafting, containers

```ts
// ---- break feedback (gate: items) ----
getBreakOverlay(): { stage: number;                 // 0..9 destroy stage = floor(progress*10)
  pos: [number, number, number]; face: string } | null;   // null when not mining

// ---- containers / block entities (gate: containers) ----
getBlockEntity(x: number, y: number, z: number):
  { type: string; data: Record<string, unknown> } | null; // raw sidecar record at key 'x,y,z'
    // (public/src/world/blockEntities.js — the P1-4-10 store)
getFurnace(x: number, y: number, z: number): {
  slots: { input: Stack|null; fuel: Stack|null; output: Stack|null };
  cookProgress: number;                             // 0..1 for the item in progress
  fuelRemainingGt: number; fuelTotalGt: number; lit: boolean;
  xpBanked: number } | null;                        // fractional accumulated smelt XP (P1-6-5)
qaSetContainerSlot(x: number, y: number, z: number, index: number,
  itemId: string | null, count?: number): Promise<void>;  // dev mutator, QA staging only;
    // routes through the same bedit/persistence path as UI slot edits

// ---- item entities (gate: itemEntities) ----
qaAgeItemEntity(entityId: number, ticks: number): void;   // advance ageGt (despawn tests; 6000gt is 5 real min)

// ---- crafting / content bridge (gate: crafting) ----
getRecipeBook(): { unlockedCount: number; total: number; craftableNow: string[] }; // string result ids
qaContentReport(): { itemCount: number;             // registered items incl. locally-registered
  unresolvedRecipeCells: string[];                  // recipe cell ids with no numeric mapping — MUST be []
  unresolvedLootIds: string[];                      // lootTables itemIds with no registry entry — MUST be []
  aliasesApplied: Record<string, string>;           // legacy-id → canonical-id renames applied by the bridge;
                                                    // expected {} — mobs/lootTables.js already emits canonical
                                                    // items.json/naming.json ids (e.g. scorched_silk), no alias fires
  localOverrides: string[] };                       // bridge-added recipes (handloom bootstrap, planks, furnace, chest)
```

#### W6 — time, weather, atmosphere, audio, particles

```ts
// ---- time (gate: gtTime) ----
setGameRule(rule: string, value: boolean|number): void;  // RESOLVED (§2.1-4): any registered rule name over the G.rules
  // store (W6 needs doDaylightCycle/doWeatherCycle; W8 doFireTick/mobGriefing/tntExplosionDropDecay);
  // validated against W7's GAMERULE_SPEC once it lands
getTimeState(): { gameTime: number; dayTime: number; doDaylightCycle: boolean;
  timeOfDay01: number;                    // the Sky.js phase (0=midnight, .25 dawn, .5 noon)
  skyDarken: number;                      // integer 0..11 (sim/time.js curve)
  hostileNight: boolean;                  // dayTime%24000 in [13000,23000)
  timeSinceRest: number };                // gameTime at last sleep (insomnia counter)

// ---- weather (gate: weather) ----
getWeather(): { state: 'clear'|'rain'|'thunder';        // the machine (sim/weatherCycle.js)
  packageState: 'clear'|'rain'|'storm'|'snow';          // WeatherSystem.getState().weather
  intensity: number;                                    // current ramped value (0..1, after biome/dim gating)
  raining: boolean; thundering: boolean;
  untilChangeGt: number;                                // gt remaining on the active duration draw
  epoch: number };                                      // weatherEpoch (bumps on sleep-clear / setWeather)
setWeather(state: 'clear'|'rain'|'thunder', durationGt?: number): Promise<void>; // routes weatherCycle.set (the /weather surface)
strike(opts?: { far?: boolean }): Promise<{ far: boolean; resolvedAtTick: number }>; // wraps WeatherSystem.strike;
  // resolves at flash peak (~90 ms) and reports the gameTick at resolution
advanceWeather(nTicks: number): { transitions: { atGameTime: number; from: string; to: string;
  thundering: boolean }[] };              // fast-forwards ONLY the weather machine (no wall clock, no other sims);
                                          // deterministic given (worldSeed, epoch)
isRainingAt(x: number, y: number, z: number): boolean;  // the cluster-W seam W4 consumes

// ---- biome atmosphere (gate: biomeColors) ----
getBiomeColors(x: number, y: number, z: number): { grass: string; foliage: string; water: string;
  sky: string; fog: string; waterFog: string };         // '#rrggbb', from world/gen/colors.js colorsFor(biomeAt)
sampleColorLUT(kind: 'grass'|'foliage', x: number, y: number): string; // raw 256x256 LUT texel, '#rrggbb'
getVertexTint(x: number, y: number, z: number): { r: number; g: number; b: number } | null;
  // the smoothed tint the mesher would bake for the TOP face at that cell (3x3-averaged), floats 0..1;
  // null if the block's tile is untinted
getSkyState(): { backgroundHex: string;                 // scene.background as '#rrggbb' (Sky.js-owned)
  fogHex: string; fogNear: number; fogFar: number;      // scene.fog (main.js updateFog-owned)
  weatherDarken: number; flash: number };               // engineSkyBridge accumulators (0..1)

// ---- beds / spawn (gate: beds) ----
getSpawnPoint(): { type: 'world'|'bed'|'anchor'|'command'; x: number; y: number; z: number; dim: string };
  // RESOLVED shape (§2.1-3): never null — 'no personal spawn' = type:'world' with the world-spawn coords;
  // 'command' = a /spawnpoint-set personal spawn (arrives with W7's commands)
getSleepState(): { sleeping: boolean; lastDenial: string | null;  // exact last denial message text
  lastWakeDayTime: number | null };
respawnPlayer(): Promise<void>;           // dev mutator: run the full death->resolveSpawn->respawn path
                                          // (gameplay/Player.js resolveSpawn), no damage system needed

// ---- audio (gate: audio; getAudio()/getAudioRms() already exist in §1.4) ----
getSoundLog(n: number): { tick: number; name: string;   // namespaced event, e.g. 'block.stone.break'
  category: string; pos: { x: number; y: number; z: number } | null;
  volume: number; pitch: number }[];      // last n of a >=256-entry ring buffer of AudioEngine.play calls
playSound(name: string, x: number, y: number, z: number, opts?: { loop?: boolean }): number; // dev; handle id
stopSound(id: number): void;

// ---- particles (gate: particles) ----
emitParticle(type: 'flame'|'smoke'|'crit'|'heart'|'break', x: number, y: number, z: number,
  count?: number, blockId?: string): void; // dev wrapper over fx/Particles.js emit
getParticles(): { live: number; byType: Record<string, number> };
```

#### W7 — persistence, commands, menus

```ts
// ---- gamerules / world meta (gate: gamerules) ----
getRules(): Record<string, boolean|number>;         // live G.rules snapshot (full registry)
getWorldMeta(): { difficulty: string; difficultyLocked: boolean; gamemode: string;
  cheats: boolean; worldType: string; spawn: {x:number;y:number|null;z:number;angle:number};
  time: { dayTime: number };                        // current dayTime (0..24000 phase + day count)
  weather: { raining: boolean; thundering: boolean } };

// ---- commands (gate: commands) ----
runCommand(text: string): Promise<{ ok: boolean; feedback: string[] }>;
  // routes through the SAME engine as chat '/' input (public/src/commands/registry.js
  // execute(text, ctx)); feedback = flattenComponent() of each feedback line

// ---- gamemode / abilities (gate: gamemodes) ----
getAbilities(): { invulnerable: boolean; flying: boolean; allowFlying: boolean;
  creativeMode: boolean; instabuild: boolean; flySpeed: number; walkSpeed: number };
// getSpawnPoint — normative typed shape lives in the W6 block (§2.1-3);
//                 'no personal spawn' = type:'world', never null.

// ---- persistence (gate: playerPersistence) ----
getUuid(): string;                                  // localStorage loomfall.uuid
qaSavePlayerNow(): Promise<void>;                   // send the player-save frame immediately (bypass 10 s cadence)
qaFlushWorldSave(): Promise<void>;                  // POST /api/worlds/<id>/qa-flush (QA=1 builds) + await 200

// ---- UI (gate: perspective / menusV2) ----
getPerspective(): { mode: 'first'|'third-back'|'third-front'; camDistance: number };
  // camDistance = current eye→camera distance (0 in first person)
isHudVisible(): boolean;                            // false while F1-hidden

// ---- chat components (gate: textComponents) ----
qaAddChatComponent(comp: object): void;             // render an arbitrary component through
  // ui/textComponent.js renderComponent into the chat log (client-local; renderer probe)
```

#### W8 — block-update engine

```ts
// ---- game-tick stepping (gate: scheduledTicks) ----
setTickFreeze(on: boolean): void;        // halt the shared 50ms fixed-step dispatcher (all subscribers:
                                         // entities, randomTick, blockTicks). Rendering/rAF continues.
stepTicks(n: number): Promise<number>;   // run exactly n fixed-step game ticks synchronously across ALL
                                         // subscribers; requires freeze ON (throws otherwise); resolves to
                                         // getGameTick() after stepping. Deterministic given world seed
                                         // (BlockSim rng is seeded from it).
// ---- scheduled-tick queue introspection (gate: scheduledTicks) ----
scheduleTick(x: number, y: number, z: number, blockName: string, delay: number, priority?: number): void;
                                         // dev enqueue, same dedupe path as engine callers (priority −3..3, default 0)
getScheduledTicks(): { size: number; next: { x:number; y:number; z:number; block:string;
  dueTick:number; priority:number }[] };  // next = first 32 entries in drain order
getTickLog(n: number): { tick:number; x:number; y:number; z:number; block:string;
  priority:number }[];                    // last n EXECUTED entries of a ≥256-entry ring buffer
// ---- fluids (gate: fluids) ----
getFluidState(x: number, y: number, z: number): { type:'water'|'lava'; level:number;  // 0=source, 1..7 flowing
  falling:boolean; source:boolean } | null;                                            // null = no fluid
// ---- fire / tnt (gates: fire, tnt) ----
igniteTnt(x: number, y: number, z: number): Promise<number>;  // tnt block at cell -> air + PrimedTnt;
                                                              // resolves entity id; throws if cell is not tnt
// gamerule dev mutator — use setGameRule (W6 block, §2.1-4); W8's `setRule` name is dropped.
// ---- blockstate props (gate: blockProps) ----
setBlockState(x: number, y: number, z: number, blockName: string,
  props: Record<string, string|number|boolean>): Promise<void>;  // routes through the ordinary edit path
                                                                 // INCLUDING props replication (edit frame `props` field)
// ---- entity events (gates: fallingBlocks / tnt) ----
spawnFallingBlock(x: number, y: number, z: number, blockName: string): Promise<number>;
                                         // dev spawn at position (bypasses support check); resolves entity id
getEntityEvents(n: number): { tick:number; type:'fallingBlockLand'|'fallingBlockDrop'|'tntPrimed'|'explosion'|'explosionDrops';
  entityId?: number; blockId?: string; pos?: {x:number;y:number;z:number}; power?: number }[];
                                         // last n entries of a ≥256-entry ring on the EntityManager event stream
```

### 2.4 New `getCaps()` tokens by wave (QA_PLAN §1.8)

| Wave | New cap tokens |
|---|---|
| W1 | `worldgen2`, `worldgen2.ores`, `worldgen2.pipeline`, `worldgen2.flat`, `biomes.registry`, `spawn.spiral` |
| W2 | `survival`, `moveBlocks`, `projectiles` |
| W3 | `mobs`, `entitybase`, `difficulty` |
| W4 | `randomTick`, `farming`, `farming.stems`, `farming.growers`, `sapling` (§1.8-named), `spread`, `breeding` (requires `mobs`) |
| W5 | `items`, `containers`, `itemEntities`, `crafting` (§1.8-named — implemented by this wave) |
| W6 | `gtTime`, `weather`, `beds`, `particles`, `biomeColors` (`audio` already exists in §1.8) |
| W7 | `commands` (§1.8-named — implemented by this wave), `gamerules`, `gamemodes`, `textComponents`, `playerPersistence`, `regionPersistence`, `menusV2`, `perspective`, `serverProperties` |
| W8 | `scheduledTicks`, `blockLight`, `fluids`, `fire`, `tnt`, `fallingBlocks`, `blockProps` |

## 3. Bug filing

Bugs found by these tests are filed per **[docs/BUG_TAXONOMY.md](./BUG_TAXONOMY.md)** — one markdown file per bug at `qa/bugs/<BUG-ID>.md`, evidence under `qa/bugs/<BUG-ID>/` — with `testRef` = the failing test id **`QA-W<k>-<nn>`**, a new id namespace beside QA_PLAN's `QA-S<k>-<nn>` (unambiguous, so the taxonomy's `QA:`/`RUBRIC:` scenario-prefix rule is not needed for these ids). Screenshot evidence is nested **`qa/W<k>/QA-W<k>-<nn>-<slug>.png`**, mirroring QA_PLAN §1.6.

Severity follows the taxonomy ladder unchanged: these are P1-tier features, so a spec-number/behavior disagreement defaults to **S2** ("feature defect … blocks P1/P2 tests"), escalating only when a taxonomy decision rule fires — crash/hang, data loss (e.g. any wave's persistence round-trip corrupting `saves/<id>.json` or a container/player record is **S0**), or a broken P0 capability (**S1**). Results marked **SKIPPED-GATED** (missing cap token per §1.8) or carrying an in-test "annotate, don't FAIL" parity-delta note are **not** bugs — the deltas are already recorded in P1_WORKPLAN.md. A rubric criterion scoring ≤ 2 while shooting W-test screenshots still files per the taxonomy's `[rubric:<Rn>]` rule.

---

## W1 acceptance tests — Worldgen depth: climate/splines, caves, ores, chunk pipeline

Harness per QA_PLAN.md §1 (Playwright + Chromium, 1280×720, `ensureLocked`, `lookDelta`, `aimAt`, screenshot rules §1.6). **Real-SUT adaptations (feat/voxel-sandbox-game):** the client is served by the game server itself — launch `npm start` (→ `node server/index.js`, port 3000), readiness probe `curl -sf http://localhost:3000/api/health` → `{ok:true}`; base URL **`http://localhost:3000/?qa=1`**. World fixtures are created via the real REST API (`POST /api/worlds`, docs/PROTOCOL.md) — QA_PLAN §1.10's 5173/25565 endpoints belong to the idealized spec. `__qa.getBlock` returns block-def **names** from `public/src/blocks/blocks.js` (`'grass'`, `'stone'`, `'deepslate_iron_ore'`, …); valid y domain is **[0,128)** (`CHUNK_SY=128`), sea level **40** — all Y assertions below are code-space. The settings key for render distance is `renderDistance` (`ui/menu.js` `loomfall.settings`), not `video.renderDistance`.

**New `__qa` hooks & cap tokens for this wave:** consolidated in §2 above (per-wave block **W1** in §2.3 + cap-token table §2.4); the signatures there are normative, including the conflict resolutions of §2.1.

**Fixtures:**
- `WG_A`: `POST /api/worlds {name:'qa-wg-a', seed:'8675309'}`; `WG_A2`: `{name:'qa-wg-a2', seed:'8675309'}` (same seed, distinct world id); `WG_C`: `{name:'qa-wg-c', seed:'424242'}`.
- `WG_FLAT`: `{name:'qa-wg-flat', seed:'1', type:'flat'}`.
- `WG_OCEAN`: iterate candidate seeds `'pelagic1','pelagic2',…`; create, join, keep the first where `__qa.biomeAt(0,0)==='ocean'`.
- Enter a world via the real menus (`ui/menu.js`): title → world select → click the `.world-row`/row matching the fixture name → play; then `ensureLocked(page)`.
- **Load-wait rule** (QA_PLAN §1.7): after every `__qa.tp(x, 100, z)` run `await page.waitForFunction(([x,z]) => __qa.isColumnLoaded(x,z), [x,z], {timeout:15000})` before sampling blocks. `scanBlocks` regions additionally need all corners loaded — tp to the region center first.

---

- **QA-W1-01 — same seed ⇒ same world; different seed ⇒ different world.**
  **Verifies:** P1-1-1, P1-1-2 (determinism half). **Gate:** caps `worldgen2`.
  **Steps:** In `WG_A`: for columns `{(8,8),(37,−12),(100,100),(−64,64),(255,−255)}`: `__qa.tp(x,100,z)` → load-wait → record signature `{h:getHeightmapAt(x,z), b:[getBlock(x,h−1,z), getBlock(x,h−5,z), getBlock(x,1,z), getBlock(x,20,z)], biome: biomeAt(x,z)}`. Repeat in `WG_A2` and `WG_C`.
  **Pass:** all 5 signatures deep-equal between WG_A and WG_A2; ≥1 signature field differs between WG_A and WG_C.
  **Screenshot:** `qa/W1/QA-W1-01-seed-determinism.png` (WG_A at (100,100), `F3` open — press `F3` via `page.keyboard.press('F3')` first).

- **QA-W1-02 — population seed formula + independent noise forks.**
  **Verifies:** P1-1-1, P1-1-2, P1-1-3. **Gate:** caps `worldgen2`.
  **Steps:** In WG_A: `page.evaluate(() => ({info: __qa.getWorldgenInfo(), seeds: [[0,0],[1,0],[0,1],[5,-7],[-3,4]].map(([cx,cz]) => ({cx,cz,s:__qa.getChunkSeeds(cx,cz)}))}))`.
  **Pass:** `popA % 2 === 1 && popB % 2 === 1`; for each chunk `popSeed === ((Math.imul(popA,cx) + Math.imul(popB,cz)) ^ worldSeed) | 0`; `noiseSeeds` contains **all ten** of the keys `temperature, humidity, continentalness, erosion, weirdness, cave_cheese, cave_spaghetti, deepslate, ore, structure` (namespaced; every one mandatory ⇒ key count ≥ 10), all values pairwise distinct and ≠ worldSeed.
  **Screenshot:** `qa/W1/QA-W1-02-seed-forks.png` (F3 open, world view).

- **QA-W1-03 — six climate params, PV formula, quart resolution.**
  **Verifies:** P1-1-4, P1-1-5, P1-1-9 (quart half). **Gate:** caps `worldgen2`.
  **Steps:** one `page.evaluate`: for 200 mulberry-seeded pseudo-random (x,z) in ±2048 read `__qa.getClimate(x,z)`; for 50 quart cells compare `getClimate(4q, 4r)` vs `getClimate(4q+3, 4r+3)`.
  **Pass:** all of temperature/humidity/continentalness/erosion/depth/weirdness finite with |v| ≤ 1.5; `pv === 1 − |3·|weirdness| − 2|` within 1e−9 at every sample; the two reads inside each quart cell are identical (climate constant per 4×4 quart).
  **Screenshot:** `qa/W1/QA-W1-03-climate-params.png`.

- **QA-W1-04 — biome selection = published tables + nearest-point rule.**
  **Verifies:** P1-1-6, P1-1-7, P1-1-8, P1-2-1, P1-2-2, P1-2-3, P1-2-4. **Gate:** caps `worldgen2`.
  **Steps:** read `getWorldgenInfo().levelTables` and `.biomeParameters`; in-test assert tables verbatim: temperature cuts `[−0.45,−0.15,0.2,0.55]`, humidity `[−0.35,−0.1,0.1,0.3]`, erosion `[−0.78,−0.375,−0.2225,0.05,0.45,0.55]`, PV `[−0.85,−0.6,0.2,0.7]`, continentalness zones incl. `deep_ocean[−1.05,−0.455) ocean[−0.455,−0.19) coast[−0.19,−0.11)` etc. Then for 300 pseudo-random columns recompute the expected biome in-test from `getClimate(x,z)` + `biomeParameters` (distance = Σ squared gap outside each interval, argmin) and compare to `__qa.biomeAt(x,z)`.
  **Pass:** tables match PARITY §1/§2 values exactly; recomputed biome === `biomeAt` for ≥ 299/300 columns (1 tie tolerance).
  **Screenshot:** `qa/W1/QA-W1-04-biome-tables.png`.

- **QA-W1-05 — all 12 core biomes reachable.**
  **Verifies:** P1-2-6. **Gate:** caps `worldgen2`.
  **Steps:** one `page.evaluate`: grid-scan `__qa.biomeAt(x,z)` stride 32 over x,z ∈ [−4096, 4096] (≈65k samples, no chunk loads); tally shares.
  **Pass:** all 12 ids present: `plains, forest, birch_forest, taiga, snowy_plains, desert, savanna, beach, river, ocean, swamp, windswept_hills`; each of the 8 area biomes ≥ 0.5% share; each of `beach, river, swamp, birch_forest` ≥ 0.05%.
  **Screenshot:** `qa/W1/QA-W1-05-biome-census.png` (tp to one `windswept_hills` sample, F3 shows `Biome:`).

- **QA-W1-06 — rivers sit at |weirdness|≈0 and below sea level.**
  **Verifies:** P1-1-17, P1-1-16 (partial). **Gate:** caps `worldgen2`.
  **Steps:** from the QA-W1-05 scan collect ≥ 300 river columns; evaluate `getClimate` at each. Tp to one river column, load-wait; sample 64 cells of the river strip.
  **Pass:** |weirdness| < 0.08 for ≥ 90% of river samples; at the visited river: `getBlock(x,39,z)==='water'` and `getHeightmapAt ≤ 40` for ≥ 80% of the 64 cells.
  **Screenshot:** `qa/W1/QA-W1-06-river.png` (standing on the bank, F3 `Biome: river`).

- **QA-W1-07 — spline behavior: flat oceans, jagged hills, level plains.**
  **Verifies:** P1-1-11, P1-1-12, P1-1-15, P1-1-16. **Gate:** caps `worldgen2`.
  **Steps:** from the biome census pick a mostly-ocean 64×64 area, a `windswept_hills` 64×64 area, a `plains` 64×64 area; tp to each center, load-wait all 4 corners; collect `getHeightmapAt` on a stride-2 grid (water columns: use depth-to-floor via first non-water block for ocean).
  **Pass:** ocean floor: mean < 36, all < 40, σ ≤ 3.5. windswept_hills: max ≥ 85, σ ≥ 7. plains: mean ∈ [42, 60], σ ≤ 3.
  **Screenshot:** `qa/W1/QA-W1-07-mountain-vista.png` (hills area, F3 open) + `qa/W1/QA-W1-07-ocean.png`.

- **QA-W1-08 — slides + density clamp + bedrock floor.**
  **Verifies:** P1-1-13, P1-1-14 (clamp), P1-1-3 (carver presence, partial). **Gate:** caps `worldgen2`.
  **Steps:** in a loaded 4×4-chunk region: for 40 pseudo-random columns read `getBlock(x,0,z)`, blocks y∈[1..4], all blocks y∈[124..127]; for 100 random (x,y,z) read `__qa.densityAt`.
  **Pass:** y0 === `'bedrock'` for 40/40; y∈[1..4] all non-air for ≥ 95% of columns (solid floor slide); zero non-air blocks at y ≥ 124 (air roof slide — parity delta: roof at 128, not 256); |densityAt| ≤ 64 for 100/100 samples.
  **Screenshot:** `qa/W1/QA-W1-08-bedrock-floor.png` (F3 at y≈2 inside a stage-carved shaft: `__qa.setBlock` a 1×3×1 air shaft down to y1 first).

- **QA-W1-09 — 4×8 cell trilinear interpolation.**
  **Verifies:** P1-1-9, P1-1-14 (threshold half). **Gate:** caps `worldgen2`.
  **Steps:** one `page.evaluate`: for 20 cells with corners at x∈{4i,4i+4}, y∈{8j,8j+8}, z∈{4k,4k+4} (y∈[8,112]): read the 8 corner `densityAt` values, then all 27 interior lattice points; compute trilinear expectation in-test. Also, in a loaded region, sample 100 points ≥ 6 below the heightmap: compare `sign(densityAt)` to block solidity (`getBlockDef(getBlock(...)).solid`).
  **Pass:** |densityAt(interior) − trilerp(corners)| ≤ 1e−6 at all 20×27 points; density>0 ⇔ solid for ≥ 85% of the 100 underground samples (carvers/features account for the gap).
  **Screenshot:** `qa/W1/QA-W1-09-density-probe.png`.

- **QA-W1-10 — ore Y-bands, counts, deepslate variants.**
  **Verifies:** P1-1-18, P1-1-19, P1-1-20, P1-1-21, P1-1-22, P1-1-23, P1-1-24, P1-1-25, P1-4-4. **Gate:** caps `worldgen2.ores`.
  **Steps:** `__qa.tp(32,100,32)` → load-wait chunks (0..3, 0..3) → `h = __qa.scanBlocks(0,0,0, 63,127,63)` (per-Y histograms). Also verify `getWorldgenInfo().oreConfigs` bands match the W1-plan code-space table. Flood-fill one located coal vein via `getBlock` (26-neighborhood, in one evaluate).
  **Pass (counting stone+deepslate variants together per ore):** coal ≥ 300 total, zero outside y∈[21,127], present both at y ≥ 67 and y ∈ [21,66]; iron ≥ 200, present below y45 and above y60, `count(y∈[91,107]) ≥ count(y∈[120,127])`; copper zero outside [16,59]; gold zero outside [0,32]; redstone zero outside [0,26]; diamond zero outside [1,26] and `count(y∈[1,8]) ≥ count(y∈[19,26])`; lapis zero outside [0,43]. Deepslate swap (P1-1-18): 100% of ore blocks at y ≤ 7 are `deepslate_*_ore`; 100% at y ≥ 17 are stone variants. Coal vein flood-fill ≥ 5 contiguous blocks.
  **Screenshot:** `qa/W1/QA-W1-10-ore-histogram.png` (F3 open facing an exposed deepslate ore at y≈6 — stage with `setBlock` air window).

- **QA-W1-11 — deepslate band, stone blobs, tuff, clay, caves.**
  **Verifies:** P1-1-26, P1-1-27, P1-1-3 (carver fork, behavioral). **Gate:** caps `worldgen2.ores`.
  **Steps:** reuse the QA-W1-10 `scanBlocks` histograms.
  **Pass:** `deepslate/(stone+deepslate)` ≥ 0.95 for y∈[1..7] and ≤ 0.05 for y∈[17..40]; tuff count zero at y ≥ 16 and ≥ 64 below; granite, diorite, andesite each ≥ 64 blocks; dirt ≥ 100 and gravel ≥ 100 at y < (min surface − 5); clay ≥ 8 blocks located beneath water columns; cave air fraction at y∈[10..30] within [1%, 25%].
  **Screenshot:** `qa/W1/QA-W1-11-deepslate-band.png` (F3 at y≈10 in a staged shaft showing the stone→deepslate transition).

- **QA-W1-12 — biome surface materials.**
  **Verifies:** P1-1-28. **Gate:** caps `worldgen2`.
  **Steps:** for each biome in `{desert, taiga, snowy_plains, swamp}`: locate via `biomeAt` scan, tp, load-wait; sample 25 columns of a 32×32 area: top block, and for desert the blocks at h−3..h−6.
  **Pass:** desert: ≥ 90% tops `sand`, `sandstone` present within h−6..h−3 in ≥ 80% of columns; taiga: `podzol` ≥ 10% of tops, remainder `grass`; snowy_plains: ≥ 90% tops `snow_grass` or `snow_block`; swamp: `mud` ≥ 10% of tops and ≥ 20 `water` cells at y∈{39,40} in the area.
  **Screenshot:** `qa/W1/QA-W1-12-surfaces.png` (taiga podzol, F3) + `qa/W1/QA-W1-12-swamp.png`.

- **QA-W1-13 — TOP_LAYER freeze pass: ice + altitude snow.**
  **Verifies:** P1-1-30. **Gate:** caps `worldgen2`.
  **Steps:** in the snowy_plains area: enumerate exposed water cells (`water` at y39 with air at y40 — expect them replaced) vs `ice`; in windswept_hills find 20 columns with h ≥ 95 and 20 plains columns.
  **Pass:** ≥ 90% of surface-water cells in snowy_plains are `ice` (not `water`); ≥ 90% of the h≥95 hills tops are snow-covered (`snow_block`/`snow_grass`) even though the biome is not snowy (height-adjusted temperature); ≤ 10% of plains tops snow-covered.
  **Screenshot:** `qa/W1/QA-W1-13-frozen-lake.png` (standing on ice, F3) + `qa/W1/QA-W1-13-snowcap.png`.

- **QA-W1-14 — decoration-step enum order + feature salts.**
  **Verifies:** P1-1-29, P1-1-1 (salt half). **Gate:** caps `worldgen2`.
  **Steps:** `page.evaluate(() => ({steps: __qa.getWorldgenInfo().decorationSteps, s: __qa.getChunkSeeds(3,-2)}))`.
  **Pass:** `decorationSteps` deep-equals `[RAW_GENERATION, LAKES, LOCAL_MODIFICATIONS, UNDERGROUND_STRUCTURES, SURFACE_STRUCTURES, STRONGHOLDS, UNDERGROUND_ORES, UNDERGROUND_DECORATION, FLUID_SPRINGS, VEGETAL_DECORATION, TOP_LAYER_MODIFICATION]`; every feature's `seed === popSeed + index + 10000·stepIndex`; ore features carry step `UNDERGROUND_ORES`, tree features `VEGETAL_DECORATION`, freeze `TOP_LAYER_MODIFICATION`; ≥ 5 distinct steps in use.
  **Screenshot:** `qa/W1/QA-W1-14-steps.png`.

- **QA-W1-15 — features cross chunk borders (trees unclipped).**
  **Verifies:** P1-1-31 (behavioral half). **Gate:** caps `worldgen2.pipeline`.
  **Steps:** locate a forest ≥ 6×6 chunks; tp, load-wait; one evaluate: find all `log` columns whose base has `x mod 16 ∈ {0,1,14,15}` or `z mod 16 ∈ {0,1,14,15}`; for one such trunk at x mod 16 === 15, assert `getBlock(x+1, canopyY, z)` (the neighboring chunk) is `leaves`/`birch_leaves`. Also verify no floating trees: for 30 trunks, block under base ∈ {grass, dirt, podzol, snow_grass}.
  **Pass:** ≥ 3 border-band trunks found (impossible under the old x,z∈[2,13] clamp); ≥ 1 canopy provably crosses a chunk border; ≥ 95% of trunks grounded.
  **Screenshot:** `qa/W1/QA-W1-15-border-tree.png` (aim at the border-straddling tree with `__qa.setLook`, F3 open showing `Chunk:` line).

- **QA-W1-16 — ChunkStatus ladder + load levels (border ring).**
  **Verifies:** P1-1-31, P1-1-34. **Gate:** caps `worldgen2.pipeline`.
  **Steps:** `__qa.setSetting('renderDistance', 4)` → `__qa.tp(5003,100,5003)` (virgin area); poll `getChunkStatus` over cx,cz ∈ pchunk±7 every 200 ms for 3 s (streaming phase), then wait 10 s (settled) and snapshot the grid.
  **Pass:** streaming phase: ≥ 1 chunk observed at `'base'` or `'populated'` before turning `'full'`, and statuses only ever advance (empty→base→populated→full — never regress). Settled: 100% of Chebyshev ≤ 4 chunks `'full'`; ring 5 chunks ≥ 80% at `'base'`/`'populated'` (border level — generated, unmeshed); Chebyshev ≥ 6 all `null` (unloaded, matches ChunkRenderer's rd+1 unload).
  **Screenshot:** `qa/W1/QA-W1-16-chunk-ring.png` (F3 open; `Chunk:` line in frame).

- **QA-W1-17 — superflat generator.**
  **Verifies:** P1-1-35. **Gate:** caps `worldgen2.flat`.
  **Steps:** create/join `WG_FLAT` (REST `POST /api/worlds {name:'qa-wg-flat', seed:'1', type:'flat'}` → join via world select). For 20 pseudo-random columns in ±200: tp/load-wait once at (0,100,0) then (160,100,160); read blocks y∈{0,1,2,3,4,10}, `getHeightmapAt`, `biomeAt`. `scanBlocks(0,0,0,31,127,31)`.
  **Pass:** every column: y0 `bedrock`, y1–2 `dirt`, y3 `grass`, y4 & y10 `air`; heightmap === 3 everywhere; `biomeAt` === `'plains'`; scan shows zero ore/water blocks and zero `air` at y ≤ 3 (no caves); `getWorldgenInfo().generatorType === 'flat'`.
  **Screenshot:** `qa/W1/QA-W1-17-superflat.png` (flat horizon, F3 open).

- **QA-W1-18 — world-spawn spiral + spawnRadius scatter + respawn.**
  **Verifies:** P1-10-10. **Gate:** caps `spawn.spiral`.
  **Steps:** in `WG_OCEAN` (seed picked so `biomeAt(0,0)==='ocean'`): read `s = __qa.getWorldSpawn()`, `p0 = __qa.getPlayerPos()` at first join. Validate the spawn column via `biomeAt`/`getHeightmapAt`/`getBlock`. Then run the **canonical kill procedure** (used verbatim by every test that needs a kill): `page.evaluate(() => { window.__game.player.position.y = -15; })` — a direct position write below the client `KILL_PLANE_Y = −10` (`gameplay/Player.js`; `__game.player` is a live `main.js publishHooks()` export, so no tp-clamp semantics are involved). Branch on caps: **with cap `survival` (W2 merged)** the kill plane routes through the death flow — `waitForSelector('section.screen[data-screen="death"]')`, click `getByRole('button', {name:'Respawn'})`, then `waitForFunction(() => __qa.getPlayerPos().y > 0, null, {timeout:10000})`; **without `survival`** the code's KILL_PLANE_Y insta-respawn applies — just `waitForFunction(() => __qa.getPlayerPos().y > 0, null, {timeout:10000})`.
  **Pass:** `biomeAt(s.x, s.z)` ∉ {ocean, river}; `getHeightmapAt(s.x,s.z)` ∈ [40, 100]; top block solid with 2 air above; Chebyshev distance (s → origin) > 16 (ocean at origin forced the spiral outward) and ≤ 1024; `p0` within Chebyshev 11 of `s` (spawnRadius 10 + 1 tolerance); post-kill respawn position within Chebyshev 11 of `s` (same bound under either caps branch). Repeat spawn-validity (not ocean distance) in `WG_A`: same invariants; `getWorldSpawn()` identical across two joins of the same world (deterministic).
  **Screenshot:** `qa/W1/QA-W1-18-world-spawn.png` (at spawn, F3 open showing XYZ + Biome).

- **QA-W1-19 — biome registry record shape.**
  **Verifies:** P1-2-5. **Gate:** caps `biomes.registry`.
  **Steps:** one evaluate: for each of the 12 biome ids call `__qa.getBiomeDef(id)`; typecheck fields. Press `F3`; read the `Biome:` line at the current position and cross-check `getBiomeDef(biomeAt(x,z)).id`.
  **Pass:** every record has `temperature: number`, `downfall: number`, `has_precipitation: boolean`, `effects` object with numeric `fogColor, waterColor, waterFogColor, grassTint, foliageTint`, `spawners` object with arrays under `monster`/`creature` (entries `{type, weight, minCount, maxCount}` when non-empty), `carvers: array`, `features: array` whose length === 11 (indexed by decoration step). Spot values: `desert.has_precipitation === false` and `desert.downfall === 0`; `snowy_plains.temperature ≤ 0`; `swamp.has_precipitation === true`. F3 `Biome:` string equals the registry id at the player column.
  **Screenshot:** `qa/W1/QA-W1-19-biome-registry.png` (F3 open, `Biome:` line legible).

---

## W2 acceptance tests — Player survival core: combat, health/hunger/regen, movement physics, XP, status effects

Format follows QA_PLAN.md §2; harness per QA_PLAN §1 (Playwright + Chromium, 1280×720, `ensureLocked`/`lookDelta`/`aimAt` helpers, 1 gt = 50 ms). **SUT delta vs QA_PLAN §1.1/§1.10 (real builder code):** launch is `npm start` (`node server/index.js`) → client + WS relay on **`http://localhost:3000/?qa=1`** — there is no `:5173` dev server and no separate `:25565` game server. `window.__qa` is published by `main.js publishHooks()` (adapter over the live `window.__game` objects) when `?qa=1` is present; mutators apply client-locally, but the hardened server validates the wire side (edit reach 7 / 20 edits/s, move budgets, y=0 rejection, chat 3/2 s — see the §1 server-authority note; every tp-then-edit sequence must respect the 2 s grace-teleport window). `recordTicks(n)` is implemented as a 50 ms-accumulator sampler inside the rAF loop. Keyboard input works without pointer lock (Controls listens on `window`); mouse attack/use clicks require pointer lock — run `ensureLocked(page)` first (fallback for flaky headless lock: `__game.controls._debugSetLocked(true)` per docs/DEV.md).

**Fixture `W2A`** (used by every test): create a survival world named `qa-w2`, seed `8675309`, open with `?qa=1`; `await waitForFunction(() => window.__qa && __game.chunkRenderer.stats.chunksLoaded >= 9)`; `__qa.setGameMode('survival')`; `__qa.setDifficulty('normal')`.
**Fixture `W2-RUNWAY`**: stone strip via `__qa.setBlock(x, 60, z, 'stone')` for x∈[−5..60], z∈[−1..1] (top surface y=61), 4 cells of air cleared above; `__qa.tp(0.5, 61, 0.5)`; `__qa.setLook(270, 0)` (QA_PLAN §1.2 convention: yaw 270 = +X, down the runway). World height is 0..127 (PARITY delta vs 384) — all staging fits y∈[55..80].
**Reset between damage probes:** `__qa.setFood(20, 20)` + `__qa.hurt(-0)`-style healing is NOT provided; tests either chain expected cumulative health values or click through death/respawn to reset.

**New `__qa` hooks & cap tokens for this wave:** consolidated in §2 above (per-wave block **W2** in §2.3 + cap-token table §2.4); the signatures there are normative, including the conflict resolutions of §2.1.

**New QA DOM contract (additive, §1.5 style):** HUD row roots `data-hud="health"|"hunger"|"armor"|"air"|"xp"` inside `#hud-root` (the QA_PLAN §1.5 HUD root — there is **no** `#hud` element; earlier drafts' `#hud` reads here as `#hud-root`); death screen `section.screen[data-screen="death"]` with buttons accessible as `Respawn` and `Title`.

---

**QA-W2-01 — Armor points/toughness/durability tables + reduction formula & order**
*Verifies:* P1-7-5, P1-7-6, P1-7-7, P1-9-5, P1-9-6, P1-9-7, P1-9-8. *Gate:* `survival`.
*Steps:* W2A+RUNWAY. (1) `__qa.setArmor({})`; assert `getHealth().health === 20`. (2) `__qa.hurt(5,'melee')`. (3) wait 600 ms (iframes clear); `__qa.setArmor({head:'iron',chest:'iron',legs:'iron',feet:'iron'})`; `__qa.hurt(10,'melee')`. (4) wait 600 ms; `__qa.setArmor({head:'diamond',chest:'diamond',legs:'diamond',feet:'diamond'})`; `__qa.hurt(10,'melee')`. (5) `page.evaluate(() => __qa.qaComputeDamage(10,{armorPoints:0,toughness:0,epf:8,resistanceLvl:1,type:'melee'}))` and `qaComputeDamage(10,{armorPoints:20,toughness:8,type:'melee'})` and `getItemDef('diamond_chestplate').durability`, `getItemDef('gold_boots').durability`.
*Pass:* step 2 → health 15.00 ± 0.05 (no armor, full 5). Step 3 → 15 − 6.0 = 9.00 ± 0.05 (iron: points 15, toughness 0 → reduction `max(3, 15−10/2)=10` → ×0.6); `getHealth().armor === 15`. Step 4 → 9 − 3.0 = 6.00 ± 0.05 (diamond: 20 pts, toughness 8 → 17.5/25 → ×0.30); `armor === 20`. Step 5 → `10·(1−0.2)·(1−8·0.04) = 5.44 ± 0.001` (order: armor→Resistance→EPF per P1-9-5); durability 16×33 = **528** and 13×7 = **91** exactly.
*Screenshot:* `qa/W2/QA-W2-01-armor-reduction.png` (F3 open, armor HUD row visible).

**QA-W2-02 — 10-tick iframes with (new−last) overflow**
*Verifies:* P1-9-9. *Gate:* `survival`.
*Steps:* W2A, no armor, health 20 (fresh respawn). (1) `__qa.hurt(4,'melee')`; (2) within 200 ms `__qa.hurt(6,'melee')`; (3) at +300 ms `__qa.hurt(2,'melee')`; (4) wait 600 ms; `__qa.hurt(2,'melee')`.
*Pass:* after (2): health 14.00 ± 0.05 (only `6−4=2` extra lands); after (3): unchanged 14.00 (2 < 6, swallowed); after (4): 12.00 ± 0.05 (window expired).
*Screenshot:* `qa/W2/QA-W2-02-iframes.png`.

**QA-W2-03 — Damage-type flags (armor-reducible / bypass-iframes / bypass-armor)**
*Verifies:* P1-9-10. *Gate:* `survival`.
*Steps:* W2A; `__qa.setArmor(full diamond)`; health 20. (1) `__qa.hurt(8,'fall')`; (2) wait 600 ms, `__qa.hurt(8,'melee')`; (3) wait 600 ms, `__qa.hurt(2,'drown')`; (4) wait 600 ms, `__qa.hurt(1,'cactus')` then immediately (≤100 ms) `__qa.hurt(1,'cactus')`; (5) `qaComputeDamage(10,{armorPoints:20,toughness:8,type:'sonic_boom'})`.
*Pass:* (1) −8.00 exactly (fall ignores armor) → 12.00 ± 0.05; (2) −2.40 ± 0.05 (melee reduced ×0.30) → 9.60; (3) −2.00 (drown ignores armor) → 7.60; (4) −2.00 total (cactus bypasses iframes: both land) → 5.60 ± 0.1; (5) returns 10.0 (sonic_boom bypasses armor).
*Screenshot:* `qa/W2/QA-W2-03-damage-types.png`.

**QA-W2-04 — Fall damage + water negation + slime bounce/sneak-cancel**
*Verifies:* P1-9-11, P1-8A-4. *Gate:* `survival` (sub-checks (c)/(d) additionally gate `moveBlocks` — `slime_block` ships with the W2 movement-modifier block appends, not the survival core; without `moveBlocks` report (c)/(d) SKIPPED-GATED, never FAIL on a missing block id).
*Steps:* W2A+RUNWAY, no armor. (a) `__qa.tp(20.5, 68.5, 0.5)` (feet 7.5 above the y=61 surface); wait `onGround()`. (b) heal via death-free chain: note health, `__qa.setBlock(30,61,0,'water')`, `__qa.setBlock(30,62,0,'water')` (static cells — no fluid flow exists); `__qa.tp(30.5, 76, 0.5)`; wait 2 s. (c) `__qa.setBlock(40,61,0,'slime_block')`; `__qa.tp(40.5, 69, 0.5)` (drop 7 onto slime top y=62); `s = recordTicks(30)` spanning the landing. (d) `page.keyboard.down('ShiftLeft')`; `__qa.tp(40.5, 69, 0.5)`; wait landing; `page.keyboard.up('ShiftLeft')`.
*Pass:* (a) damage `⌊7.5⌋−3 = 4` → −4 HP ± 1. (b) NO damage (water negates; health unchanged ± 0.05) despite ~14-block fall. (c) NO damage AND bounce: max `pos.y` after first contact ≥ 65.0 (apex ≥ 3 above slime top; reflected velocity). (d) sneak cancels: apex < 62.7 (no bounce) AND damage `⌊7⌋−3 = 4` ± 1 applied.
*Screenshot:* `qa/W2/QA-W2-04-fall-damage.png` (post-bounce frame).

**QA-W2-05 — Air supply 300 gt, drowning 2 HP/s, refill**
*Verifies:* P1-9-12. *Gate:* `survival`.
*Steps:* W2A+RUNWAY. Stack water: `setBlock(50,61,0,'water')`, `(50,62,0)`, `(50,63,0)`; `__qa.tp(50.5, 61, 0.5)` (eye y≈62.6 inside water). (1) sample `getHealth().air` at t=0 and t=5 s. (2) assert `[data-hud="air"]` visible. (3) `__qa.setAir(20)`; wait 1.2 s (air hits 0); note health; wait 4.0 s. (4) `__qa.tp(0.5, 61, 0.5)` (dry runway); wait 5 s.
*Pass:* (1) air 300 → 200 ± 20 after 5 s (−20 gt/s). (2) bubble row visible only while submerged. (3) health drops 8 ± 1 over the 4 s at 2 HP/s (drown ignores armor). (4) air back to 300 within 5 s; bubble row hidden.
*Screenshot:* `qa/W2/QA-W2-05-drowning.png` (submerged, bubbles + F3).

**QA-W2-06 — Exhaustion accumulation → hunger drain**
*Verifies:* P1-10-4, P1-10-5. *Gate:* `survival`.
*Steps:* W2A+RUNWAY. `__qa.setFood(20, 0)`; `setLook(270,0)`; `keyboard.down('ControlLeft')`; `keyboard.down('KeyW')`; `waitForFunction(() => __qa.getPlayerPos().x >= 40.5)` (40 m sprinted); release both; read `getFoodState()`. Mid-check: at x ≥ 20.5 (20 m) sample exhaustion.
*Pass:* mid-check exhaustion ≈ 2.0 ± 0.5 (sprint 0.1/m); final food = **19** (one point deducted at the 4.0 rollover; saturation was 0) with exhaustion < 1.5 residual.
*Screenshot:* `qa/W2/QA-W2-06-exhaustion.png` (hunger row showing 19/20).

**QA-W2-07 — Eating: 32 gt hold, food table values, use-animation**
*Verifies:* P1-10-6, P1-10-8, P1-27-2 (use-hold). *Gate:* `survival`.
*Steps:* W2A+RUNWAY, `ensureLocked(page)`. (1) `__qa.setFood(14, 0)`; `__qa.give('bread', 1)`; `page.mouse.down({button:'right'})`; poll `getUseProgress()` every 100 ms; on completion `page.mouse.up(...)`; read `getFoodState()`, `getHeldItem()`. (2) `give('bread',1)`; `setFood(14,0)`; hold right 800 ms then release; wait 200 ms. (3) `setFood(20, 0)`; hold right 2 s.
*Pass:* (1) progress reaches 1.0 at 1.6 s ± 0.15 from press (32 gt); `getHandAnim().use01` tracked > 0 during the hold; on finish food = 19 (14+5), saturation = 6.0 ± 0.01, held slot consumed (`getHeldItem() === null`). (2) early release: progress back to 0, food stays 14, bread NOT consumed. (3) food==20 blocks eating: `getUseProgress()` stays 0, bread kept.
*Screenshot:* `qa/W2/QA-W2-07-eating.png` (mid-hold, use anim visible).

**QA-W2-08 — Natural regen tiers, starvation floors, Peaceful continuous regen**
*Verifies:* P1-10-1, P1-10-2, P1-10-3, P1-23-2 (regen/starve half). *Gate:* `survival`.
*Steps:* W2A. (a) `setDifficulty('normal')`; `setFood(20, 10)`; `hurt(6,'magic')` (→14); wait 3.0 s. (b) `setFood(18, 0)`; `hurt(2,'magic')`; poll health every 100 ms; anchor at the FIRST observed +1 regen tick (note `t_anchor` and health `h`); sample health again at `t_anchor` + 4.4 s. (c) `hurt(9,'magic')` until health ≈ 11; `setFood(0,0)`; `setDifficulty('easy')`; wait 8 s; then 10 s more. (d) `setDifficulty('normal')`; wait until health ≤ 2 then 10 s more. (e) `setDifficulty('hard')`; wait ≤ 20 s. (f) after death → click `Respawn`; `setDifficulty('peaceful')`; `setFood(0, 0)`; `hurt(8,'magic')`; wait 2.2 s; wait 5 s more.
*Pass:* (a) health ≥ 18 after 3 s (fast regen 1 HP/0.5 s while food==20 & sat>0; max clamped at 20 — P1-10-1). (b) exactly +1 HP between `t_anchor` and `t_anchor` + 4.4 s (slow regen 1 HP/4 s at food 18, sat 0 — the window is phase-anchored to a just-observed regen tick so the next tick lands at ~4 s and the one after at ~8 s; an unanchored window straddling two ticks would flake); if no anchor tick is observed within 5 s of the hurt, FAIL on cadence, not on the delta. (c) Easy: decays 1 HP/4 s to **10** and holds (no change over the extra 10 s). (d) Normal: floors at **1**, holds. (e) Hard: reaches 0 → death screen appears. (f) Peaceful: +4 HP ± 1 in 2.2 s despite food==0 (continuous regen), no starvation damage, and food self-recovers > 0 within 5 s.
*Screenshot:* `qa/W2/QA-W2-08-regen-floors.png` (Normal floor at 1 HP, F3 open).

**QA-W2-09 — Sprint requires food > 6**
*Verifies:* P1-10-7. *Gate:* `survival`.
*Steps:* W2A+RUNWAY. (1) `setFood(6, 0)`; hold `ControlLeft`+`KeyW` 2 s; `s = recordTicks(40)`. (2) release; `setFood(7, 0)`; repeat.
*Pass:* (1) `isSprinting() === false`; speed `hypot(Δx,Δz)/t` = 4.3 ± 0.25 b/s. (2) `isSprinting() === true`; speed 5.805 ± 0.3 b/s.
*Screenshot:* `qa/W2/QA-W2-09-sprint-gate.png`.

**QA-W2-10 — Sprint / Speed-effect FOV widening**
*Verifies:* P1-8A-1. *Gate:* `survival`.
*Steps:* W2A+RUNWAY (settings fov at real-code default 75). (1) standing: `getCameraFov()`. (2) hold `ControlLeft`+`KeyW`; poll fov for 0.8 s. (3) release; wait 0.8 s. (4) `addEffect('speed', 0, 30)`; sprint again 0.8 s.
*Pass:* (1) 75.0 ± 0.1; (2) settles 82.5 ± 1.0 (75×1.10); (3) returns 75 ± 1; (4) ≥ 86 (sprint × Speed-I widening). Visual-only: `getPlayerVel()` unaffected by the fov lerp.
*Screenshot:* `qa/W2/QA-W2-10-sprint-fov.png`.

**QA-W2-11 — Speed/Slowness movement, Haste/Fatigue break multiplier**
*Verifies:* P1-11-1. *Gate:* `survival`.
*Steps:* W2A+RUNWAY, walk 2 s + `recordTicks(40)` per case: (a) no effects; (b) `addEffect('speed',0,60)`; (c) `clearEffects(); addEffect('slowness',0,60)`; (d) `clearEffects(); addEffect('slowness',5,60)` (L6). Then (e) `clearEffects()`; read `getBreakSpeedMultiplier()`; `addEffect('haste',1,60)` read; `clearEffects(); addEffect('mining_fatigue',0,60)` read; `addEffect('mining_fatigue',1,60)` read.
*Pass:* speeds b/s: (a) 4.3 ± 0.2; (b) 5.16 ± 0.25 (+20%/L); (c) 3.655 ± 0.2 (−15%/L); (d) ≤ 0.1 (L6+ immobile). (e) multipliers exactly (±0.001): base 1.0, haste L2 1.2 (+10%/L), fatigue L1 0.3, L2 0.09 (×0.3^L). `getStatusEffects()` lists each with correct amplifier/remainingTicks.
*Screenshot:* `qa/W2/QA-W2-11-status-effects.png`.

**QA-W2-12 — Strength/Weakness melee modifiers**
*Verifies:* P1-11-2. *Gate:* `survival`.
*Steps:* W2A; wait 1 s (full attack charge). (1) `getAttackDamage()`. (2) `addEffect('strength',0,60)`; read. (3) `clearEffects(); addEffect('weakness',0,60)`; read.
*Pass:* (1) 1.00 ± 0.01 (bare hand, full charge); (2) 4.00 ± 0.01 (+3 HP/L); (3) 0.00 (1−4 clamped ≥ 0).
*Screenshot:* `qa/W2/QA-W2-12-strength-weakness.png`.

**QA-W2-13 — Attack cooldown & charge-scaled damage**
*Verifies:* P1-9-1, P1-9-2. *Gate:* `survival`.
*Steps:* W2A+RUNWAY; `ensureLocked(page)`; aim at open air. (1) `page.mouse.down({button:'left'})` + `up`; immediately (≤50 ms) sample `getAttackCooldown()` and `getAttackDamage()`. (2) sample both again at +300 ms.
*Pass:* (1) cooldown < 0.15; damage ≈ 0.2 ± 0.05 (t≈0 → ×0.2 floor). (2) cooldown ≥ 0.99 and damage 1.00 ± 0.02 (hand attack_speed 4 → full recovery in 250 ms; 300 ms sample is past it). Full-charge flag: `getAttackCooldown() > 0.9` ⇔ crit-eligible (cross-checked in QA-W2-14).
*Screenshot:* `qa/W2/QA-W2-13-attack-charge.png`.

**QA-W2-14 — Critical hits ×1.5 and conditions**
*Verifies:* P1-9-3, P1-9-2. *Gate:* `survival`.
*Steps:* W2A+RUNWAY; `ensureLocked`. `id = __qa.spawnTestDummy(5.5, 61, 0.5)`; `__qa.tp(2.5, 61, 0.5)`; aim at dummy center (`aimAt` → `setLook`). (1) grounded full-charge click. (2) wait 600 ms; `keyboard.press('Space')`; wait 350 ms (past apex, `getPlayerVel().y < 0`); click. (3) wait 600 ms; hold `ControlLeft`+`KeyW` (sprinting) and click on approach.
*Pass:* (1) `getLastAttack()` → `{crit:false, damage 1.0 ± 0.05}`; `getDummy(id).hp = 19 ± 0.1`. (2) `{crit:true, damage 1.5 ± 0.1}` (falling + airborne + full charge). (3) `crit:false` (sprinting excludes crit).
*Screenshot:* `qa/W2/QA-W2-14-crit.png` (mid-air hit frame).

**QA-W2-15 — Knockback: base vs sprint bonus**
*Verifies:* P1-9-4. *Gate:* `survival`.
*Steps:* W2A+RUNWAY; `ensureLocked`. (1) dummy at (6.5, 61, 0.5); player at (4.5, 61, 0.5) facing +X; full-charge standing click; record `getDummy(id).pos` displacement from spawn after 1 s → `d_stand`. (2) `removeTestDummies()`; fresh dummy same spot; back player to x=1.5; sprint-attack (hold `ControlLeft`+`KeyW`, click when within reach ≤ 3.0); displacement after 1 s → `d_sprint`.
*Pass:* `d_stand` ∈ [0.4, 2.5] blocks and along +X (pos.x increased, |Δz| < 0.3); `d_sprint ≥ 1.3 × d_stand` (sprint bonus impulse).
*Screenshot:* `qa/W2/QA-W2-15-knockback.png`.

**QA-W2-16 — XP curves + orb entity magnet/pickup**
*Verifies:* P1-15-1, P1-15-2, P1-8-14 (orb mechanics; per-archetype values are asserted in `tests/survival.test.mjs` against `XP_BY_ARCHETYPE`, live mob-kill drops gated on `mobs` cap in W3). *Gate:* `survival`.
*Steps:* W2A fresh respawn (xp 0). (1) `addXp(7)`; read `getXp()`. (2) `addXp(2)`; read. (3) `addXp(343)` (total 352); read. (4) `spawnXpOrb(px+4, 61, pz, 5)` 4 blocks ahead; walk toward it (`KeyW`); poll `getXpOrbs()` and `getXp().total` for 3 s.
*Pass:* (1) `{level:1, progress:0 ± 0.01}` (xpToNext(0)=7). (2) progress 2/9 = 0.222 ± 0.01. (3) `{level:16, progress:0 ± 0.01, total:352}` (totalXpAt(16)=16²+6·16=352 — curve-boundary known answer). (4) orb magnetizes (its pos approaches player) and is collected ≤ 3 s: `getXpOrbs()` empty, total +5.
*Screenshot:* `qa/W2/QA-W2-16-xp-orbs.png` (orb + XP bar).

**QA-W2-17 — XP from ore mining**
*Verifies:* P1-15-3. *Gate:* `survival`.
*Steps:* W2A+RUNWAY; `ensureLocked`. Note `T0 = getXp().total`. `setBlock(4, 62, 0, 'diamond_ore')`; `aimAt`+`setLook` → assert `getTargetedBlock().pos` = [4,62,0]; break the block, branching on caps: **without `items` (pre-W5)** a single left click insta-breaks; **with `items` (W5 timed breaking merged)** `give('needle_iron_pickaxe', 1)`, select it, and hold `page.mouse.down()` until `getBlock(4,62,0) === 'air'` (~15 gt for diamond_ore; a bare hand would never harvest, so no XP would ever drop). Walk over spawn point 2 s; read total. Repeat with `'coal_ore'` (same caps branch).
*Pass:* diamond_ore Δtotal ∈ [3,7]; coal_ore Δtotal ∈ [0,2] (integers). PARITY delta (annotate, don't fail): registry has no lapis/redstone/emerald/quartz; iron/gold yield 0 until smelting lands.
*Screenshot:* `qa/W2/QA-W2-17-ore-xp.png`.

**QA-W2-18 — Death: XP drop min(7·L,100), respawn screen flow**
*Verifies:* P1-15-5, P1-10-12. *Gate:* `survival`.
*Steps:* W2A. `addXp(100)`; `L = getXp().level` (expect ≥ 3); note death-drop expectation `min(7·L, 100)`; note pos. `__qa.hurt(999, 'void')`. (1) assert death screen: `[data-screen="death"]` visible, `getByRole('button',{name:'Respawn'})` and `{name:'Title'}` present; sim frozen for the player (pos stable). (2) sum `getXpOrbs()` values (orbs at death pos). (3) click `Respawn`.
*Pass:* (1) death screen shown (no auto-respawn — old KILL_PLANE insta-respawn is gone). (2) orb value sum = `min(7·L,100)` exactly. (3) after respawn: `getScreen()===null`, health 20, `getFoodState().food === 20`, `getXp()` = `{level:0, total:0}`, feet at the respawn target column — **with cap `spawn.spiral` (W1 merged in parallel)**: within Chebyshev 11 (spawnRadius 10 + 1) of `__qa.getWorldSpawn()` (respawn priority player spawn → world.spawn → column 8,8 per P1_WORKPLAN; the spiral world spawn is by construction NOT at the origin); **without `spawn.spiral`**: the code's fixed spawn column (8.5 ± 1, 8.5 ± 1) (`gameplay/Player.js` `spawn = {x:8.5, z:8.5}`) — effects cleared. PARITY delta (annotate): hotbar is NOT dropped (no item entities / keepInventory gamerule yet) — only XP drops.
*Screenshot:* `qa/W2/QA-W2-18-death-screen.png` (full screen section).

**QA-W2-19 — Movement-modifier blocks: ice, soul_sand, honey, cobweb, powder_snow**
*Verifies:* P1-4-3, P1-8A-5, P1-8A-6, P1-8A-7. *Gate:* `moveBlocks`.
*Steps:* W2A+RUNWAY. (a) **ice**: `setBlock(x,61,z,'ice')` for x∈[10..30], z∈[−1..1]; `tp(6.5,61,0.5)`; sprint +X onto the ice; at x ≥ 18 release ALL keys; `recordTicks(40)`. Control run: same on bare stone. (b) **soul_sand**: strip at x∈[10..20] y=61 `'soul_sand'` (id 23 pre-exists); walk on top 2 s, `recordTicks(40)`. (c) **honey**: `setBlock(35,61,0,'honey_block')` (+neighbors z −1..1); stand on it: walk speed sample; then `Space` jump: max Δy. Control: jump on stone. (d) **cobweb**: webs at (45, 62..66, 0); `tp(45.5, 75, 0.5)`; `recordTicks(60)` through the fall. (e) **powder_snow**: `setBlock(48,61,0,'powder_snow')`, `(48,62,0)`; walk in; then hold `Space`; then `setArmor({feet:'leather'})` and walk on again.
*Pass:* (a) slide ≥ 2.0 blocks after key release before speed < 0.5 b/s (friction 0.98); stone control ≤ 0.6. (b) speed 1.72 ± 0.2 b/s (×0.4). (c) honey speed 1.72 ± 0.2 (×0.4); jump apex Δy ≤ 0.7 vs stone control 1.40 ± 0.05 (real-code apex 8.2²/48 = 1.40 — PARITY delta vs vanilla 1.25, tests use the code number). (d) inside webs |vy| ≤ 1.5 b/s (gravity accumulation cancelled), horizontal ≤ 1.2 b/s, NO fall damage on landing despite >10 total drop; `getFallDistance()` resets in web. (e) sinks: onGround false inside cells and feet y descends below cell top; `Space` climbs out; with leather boots stays on top (feet y ≈ 63.0 ± 0.05, onGround true).
*Screenshot:* `qa/W2/QA-W2-19-modifier-blocks.png` (ice slide, F3 open).

**QA-W2-20 — Ladder climb / sneak-cling**
*Verifies:* P1-8A-3. *Gate:* `moveBlocks`.
*Steps:* W2A+RUNWAY. Ladder column `setBlock(10, y, 0, 'ladder')` y∈[61..66] (PARITY delta: no wall-attachment requirement — climbable overlap cell only). `tp(8.5, 61, 0.5)`; face +X; hold `KeyW` into the ladder cell; `recordTicks(40)` during ascent. At y ≈ 64 hold `ShiftLeft` 1 s. Release all keys.
*Pass:* ascent vy = 2.35 ± 0.25 b/s; sneak-cling: |vy| ≤ 0.05, no descent while held; after release, slide down with `getFallDistance()` pinned 0 → zero damage on ground.
*Screenshot:* `qa/W2/QA-W2-20-ladder.png`.

**QA-W2-21 — Sneak ledge-stop + crouch pose**
*Verifies:* P1-8A-8. *Gate:* `survival`.
*Steps:* W2A+RUNWAY (edge at x=60, top y=61). `tp(58.5, 61, 0.5)`; `setLook(270, 0)`; hold `ShiftLeft`; assert pose; hold `KeyW` 2.5 s with `recordTicks(50)` running. Then release `ShiftLeft` only (keep `KeyW`) 1 s.
*Pass:* while sneaking: `getPose()==='crouching'`, `getEyeHeight()` = 1.27 ± 0.02; recordTicks: `onGround` true in ≥ 95% of samples, `pos.y` = 61 ± 0.01 throughout (never falls), final `pos.x ≤ 60.99` (stopped at the last supported cell). After releasing sneak: player walks off (`pos.y` drops) within 1 s — proves the stop was sneak-conditioned, not a wall.
*Screenshot:* `qa/W2/QA-W2-21-ledge-stop.png` (crouched at edge, F3 open).

**QA-W2-22 — Swim pose, sprint-swim speed, buoyancy, crawl through 1-high gap**
*Verifies:* P1-8A-2. *Gate:* `survival`.
*Steps:* W2A+RUNWAY. Pool: water cells (55..58, 61..63, −1..1). `tp(56.5, 61, 0.5)` (eye submerged). (1) hold `KeyW`: read pose/AABB. (2) add `ControlLeft`: `recordTicks(40)` horizontal speed. (3) release all: sample vy over 1 s; then hold `ShiftLeft` 1 s. (4) crawl: ceiling `setBlock(x, 63, 0, 'stone')` x∈[20..24] over the runway (gap = single cell y62); enter the crawl pose via `tp(20.5, 62, 0.5)` (directly into the gap); hold `KeyW` 2 s.
*Pass:* (1) `getPose()==='swimming'`, `getAABB().h` = 0.6 ± 0.05, `getEyeHeight()` = 0.4 ± 0.05. (2) sprint-swim 2.2 ± 0.3 b/s. (3) passive vy ≥ −0.7 b/s (buoyant drift), sneak-dive vy ≤ −1.8. (4) pose stays low (h 0.6) inside the gap, traverses ≥ 2 blocks of x, zero suffocation damage.
*Screenshot:* `qa/W2/QA-W2-22-swim-crawl.png`.

**QA-W2-23 — HUD survival rows**
*Verifies:* P1-27-4. *Gate:* `survival`.
*Steps:* W2A. (1) count children of `[data-hud="health"]` and `[data-hud="hunger"]`. (2) `setFood(13, 0)` → inspect hunger icon states. (3) `[data-hud="armor"]` hidden with no armor; `setArmor(full iron)` → inspect. (4) submerge (QA-W2-05 pool) → `[data-hud="air"]` visible, bubbles = `ceil(air/30)`. (5) fresh xp: `addXp(9)` → `[data-hud="xp"]` bar fill ratio & level text.
*Pass:* (1) 10 icons each (2 half-units per icon). (2) 6 full + 1 half (13/20). (3) hidden ⇄ visible; 7 full + 1 half (15 armor points). (4) air row only while submerged/depleted; 10 bubbles at full 300 gt. (5) level text "1", bar width ratio = 2/9 = 0.222 ± 0.03 of its track. Health shards row (existing vitality shards) unchanged and pulses at ≤ 6 HP.
*Screenshot:* `qa/W2/QA-W2-23-hud-rows.png` (armor + hunger + xp + air all visible).

**QA-W2-24 — Hand swing animation on attack/place**
*Verifies:* P1-27-2 (swing half; eat-hold covered in QA-W2-07). *Gate:* `survival`.
*Steps:* W2A+RUNWAY; `ensureLocked`. (1) idle: `getHandAnim()`. (2) left click at air: poll `getHandAnim().swing01` at 60 Hz for 0.5 s. (3) select a block slot (`Digit1`), aim at runway top, right click (place): poll again.
*Pass:* (1) `{swing01:null}`. (2) swing01 becomes non-null, sweeps 0→1 within 0.3 s, returns to null. (3) place also triggers a full swing; viewmodel mesh shows the held block (present in scene as a camera child).
*Screenshot:* `qa/W2/QA-W2-24-hand-swing.png` (mid-swing).

**QA-W2-25 — Arrow projectile: gravity/drag integration, block-stick, pickup**
*Verifies:* P1-8-17, P1-8-18. *Gate:* `projectiles`.
*Steps:* W2A+RUNWAY. Pre-place wall `setBlock(40, 63, 0, 'stone')` (and 62/64 neighbors). `id = __qa.spawnArrow(2.5, 63.5, 0.5, 30, 0, 0)`; `recordTicks(40)` sampling `getEntities('arrow')`. After impact wait 5 s. Then walk the player to the wall base under the arrow.
*Pass:* (a) over the first 0.5 s, Δvy/Δt = −20 b/s² ± 20% (PARITY 0.05 b/t² converted at 20 t/s — code plans per-second constants, delta noted); (b) horizontal speed after 1.0 s of free flight ≈ 30 × 0.818 = 24.5 ± 2.5 b/s (drag 0.99/t) — if the wall is reached sooner, assert (b) on a second unobstructed arrow fired along −X instead; (c) on impact `inGround === true`, vel = 0 ± 0.01, pos stable ≥ 5 s (no early despawn; despawn budget 60 s); (d) pickup: arrow entity removed AND `getHotbar()` gains `{id:'arrow'}` in a slot (PARITY delta: no stack counts). Peers never see the arrow (client-local — annotate, don't fail).
*Screenshot:* `qa/W2/QA-W2-25-arrow-stick.png` (arrow in wall, F3 open).

**QA-W2-26 — Poison floor at 1 HP; Peaceful nullifies poison**
*Verifies:* P1-23-2 (poison/wither gate), P1-9-10 (poison floor). *Gate:* `survival`.
*Steps:* W2A. (1) `setDifficulty('normal')`; `hurt(15,'magic')` (→5 HP); `addEffect('poison', 0, 30)`; sample health each second for 12 s. (2) `clearEffects()`; `setDifficulty('peaceful')`; wait for regen ≥ 10 HP; `addEffect('poison', 0, 10)`; sample for 5 s.
*Pass:* (1) health decreases ≥ 3 HP total, floors at exactly **1** and never reaches 0 (holds ≥ 3 samples at 1). (2) health strictly non-decreasing (poison deals 0 in Peaceful; peaceful regen may raise it).
*Screenshot:* `qa/W2/QA-W2-26-poison-floor.png` (1 HP, poison effect active).

**QA-W2-27 — Milk bucket clears effects, returns bucket**
*Verifies:* P1-10-9. *Gate:* `survival`.
*Steps:* W2A; `ensureLocked`. `addEffect('speed',0,120)`; `addEffect('slowness',1,120)`; assert `getStatusEffects().length === 2`. `give('milk_bucket', 1)`; hold `page.mouse.down({button:'right'})` until `getUseProgress()` completes (≈1.6 s); release.
*Pass:* `getStatusEffects()` empty; held slot is now `{id:'bucket'}` (milk_bucket 110 → bucket 111 — bucket returned); drinking is allowed even at food 20 (alwaysEdible class per P1-10-6).
*Screenshot:* `qa/W2/QA-W2-27-milk.png`.

---

## W3 acceptance tests — Entity layer + mob integration/spawning (bridge to feature/mobs)

Harness per QA_PLAN.md §1 (Playwright + `?qa=1`, viewport 1280×720, `ensureLocked` after every screen close, 1 game tick = 50 ms, fixtures §1.7). All world staging uses `WORLD_B` (creative, cheats ON, `doDaylightCycle=false`) unless stated. **WORLD_B staging recipe (normative for W3/W6/W8 at pre-W7 merge states):** the real REST API accepts only `{name, seed(, type — W1)}` (docs/PROTOCOL.md `POST /api/worlds`); gamemode/cheats/gamerules-at-creation arrive with W7's create-world depth, so WORLD_B is **not** creatable as specified via REST pre-W7. Construct it instead as: `POST /api/worlds {name:'qa-vis', seed:'8675309'}` → join via the menus → `__qa.setGameMode('creative')` → **with cap `gtTime` (W6)**: `__qa.setGameRule('doDaylightCycle', false)`; **without it**: pin the light per test via `__qa.setTime(6000)` (no cheats flag exists pre-W7 — moot). With W7 merged, create it in one step (create-world screen or the W7 REST body `{gamemode:'creative', cheats:true, ...}`) and set `doDaylightCycle=false` at creation. Block ids in assertions are the `__qa` string names that the shim maps from the builder's numeric registry (`public/src/blocks/blocks.js`): `grass`=1, `dirt`=2, `stone`=3, `glowstone`=24, `air`=0. Distances/heights use the REAL world: height 128, SEA_LEVEL 40 (parity delta vs spec 384/63 — all staging y-values below are chosen for the 0..127 range).

**New `__qa` hooks & cap tokens for this wave:** consolidated in §2 above (per-wave block **W3** in §2.3 + cap-token table §2.4); the signatures there are normative, including the conflict resolutions of §2.1.

`getEntities('mob')` (existing M0 hook) must enumerate live mobs with `type: 'mob:<archetype>'` via the cluster-A `mobEntityBridge`. `getEntities` coverage note (§1.4) applies: mobs in unloaded chunks are suspended but still enumerated (they hold no world reference).

Common staging recipe `STAGE_PEN` (used below): in WORLD_B — `__qa.setMobSpawning(false); __qa.clearMobs();` then `__qa.tp(0,120,0)`; build a stone platform `setBlock(x,99,z,'stone')` for `x∈[−16..16], z∈[−16..16]`; clear air y∈[100..103] over it; `__qa.tp(0,100,0)`; `await page.waitForFunction(() => __qa.isColumnLoaded(0,0))`. Noon = `__qa.setTime(6000)`; midnight = `__qa.setTime(18000)` (shim maps worldTime → main.js `timeOfDay`; 6000→0.5, 18000→0.0).

---

#### QA-W3-01 — Entity base fields + i-frames
- **Verifies:** P1-8-2
- **Gate:** caps `mobs` + `entitybase`
- **Steps:**
  1. `STAGE_PEN`; `const id = await __qa.spawnMob('grazer', 4, 100, 4)`.
  2. `e = __qa.getEntities('mob').find(x => x.id === id)`; `m = __qa.getMob(id)`.
  3. `__qa.hurtMob(id, 2, 'env')`; read `m1 = __qa.getMob(id)` within 2 ticks; immediately `__qa.hurtMob(id, 2, 'env')` again (same tick window); read `m2`.
  4. Wait 12 ticks (600 ms), `__qa.hurtMob(id, 2, 'env')`; read `m3`.
- **Pass criteria:** (a) `e.type === 'mob:grazer'`, `e.pos/e.vel` finite triples, `e.ageTicks ≥ 0`; (b) `m.onGround === true` within 20 ticks of spawn, `m.invulnerableTicks` field present; (c) second hit inside the 10gt window applies only the delta: `m2.hp === m1.hp` (equal damage → 0 extra), i.e. hp after step 3 = 8−2 = **6 ±0**; (d) after step 4, hp = **4 ±0** (i-frames expired).
- **Screenshot:** `qa/W3/QA-W3-01-entity-base-iframes.png`

#### QA-W3-02 — Attribute records per archetype
- **Verifies:** P1-8-1
- **Gate:** caps `mobs` + `entitybase`
- **Steps:**
  1. `STAGE_PEN`; spawn one each: `grazer(2,100,2)`, `bobbindeer(6,100,2)`, `trader(10,100,2)`, `groaner(2,100,8)`, `exploder(6,100,8)`, `frayedhound(10,100,8)`, `needlejack(14,100,2)`, `scaldwarden(2,100,12)`, `raveler(6,100,12)` (noon keeps hostiles passive-ish; they still exist).
  2. For each id read `getEntityAttribute(id, a)` for `a ∈ {max_health, movement_speed, follow_range, attack_damage, safe_fall_distance, step_height}`.
- **Pass criteria:** max_health exact per the package canon (`mobs/MobManager.js` `ARCHETYPE_CONFIG.maxHp`, = `content/bestiary.json` hp): grazer 8, bobbindeer 14, trader 20, groaner 24, exploder 10, frayedhound 14, needlejack 18, scaldwarden 40, raveler 18; `getMob(id).maxHp === max_health`; follow_range = 16 for all except groaner = 35; safe_fall_distance = 3 and step_height = 1 for all; movement_speed > 0; unknown attr name returns the documented default (not NaN/undefined → assert `Number.isFinite`).
- **Screenshot:** `qa/W3/QA-W3-02-attributes.png`

#### QA-W3-03 — Entity physics: gravity, AABB rest, liquid buoyancy
- **Verifies:** P1-8-3
- **Gate:** caps `mobs` + `entitybase`
- **Steps:**
  1. `STAGE_PEN`; `const id = await __qa.spawnMob('bobbindeer', 4, 110, 4)` (10 blocks up, air below down to platform y=100).
  2. `const s = await page.evaluate(() => __qa.recordTicks(60))` while polling `__qa.getMob(id)` each 5 ticks (record pos.y, vel.y, onGround).
  3. After rest: build a 3×3 water pool: `setBlock(x,100,z,'water')` for x,z∈[10..12] with stone walls/floor at y=99; `spawnMob('bobbindeer', 11, 103, 11)`; sample 40 ticks.
- **Pass criteria:** (a) while airborne, vel.y decreases monotonically with slope −20 b/s² ±15% sampled over ≥10 ticks, clamped at terminal ≥ −40 b/s; (b) mob comes to rest with `onGround === true` and `pos.y === 100 ± 0.05` (top of stone, AABB min corner convention); no tunneling below y=100 at any sample; (c) in water the fall rate magnitude is < 50% of the airborne rate at the same tick-age (buoyancy/drag active) and the mob does not sink through the pool floor.
- **Screenshot:** `qa/W3/QA-W3-03-entity-physics.png`

#### QA-W3-04 — Passive archetypes: stats, death drops, panic
- **Verifies:** P1-8-4 (with P1-8-6 Panic overlap)
- **Gate:** caps `mobs`
- **Steps:**
  1. `STAGE_PEN`, noon. `const id = await __qa.spawnMob('grazer', 6, 100, 6)`.
  2. `__qa.hurtMob(id, 1, 'player')`; sample `getMob(id).goal` + pos each 2 ticks for 40 ticks.
  3. `__qa.hurtMob(id, 99, 'player')` (kill). Read `__qa.getMobEvents(20)`.
- **Pass criteria:** (a) after step 2, goal becomes `'panic'` within 5 ticks and horizontal speed over the next 20 ticks satisfies BOTH: ≥ 1.5 b/s absolute (floor — the ratio alone is vacuous when the mob idled pre-hurt and pre-hurt max ≈ 0) AND ≥ 1.2× the pre-hurt max speed; (b) after step 3: exactly one `mobDeath` event with `archetype:'grazer'`, followed by ≥0 `mobDrop` events; if a `mobDrop` fires, it carries `itemId` (string) + `count ≥ 1` + `pos` within 1.5 blocks of death pos (drop→ItemEntity spawn is W5 — only the event is asserted here); (c) `getMob(id) === null` and `getEntities('mob')` no longer contains id within 20 ticks (death animation may delay removal ≤ 20 ticks).
- **Screenshot:** `qa/W3/QA-W3-04-passive-drops.png`

#### QA-W3-05 — Exploder fuse timing (creeper parity) + player damage
- **Verifies:** P1-8-5
- **Gate:** caps `mobs` + `damage` (uses `getLastHurt`/`getHealth`)
- **Steps:**
  1. `STAGE_PEN`, midnight (`setTime(18000)`). `__qa.setGameMode('survival')`. Stand at (0,100,0); `await __qa.spawnMob('exploder', 1.5, 100, 0)` (within fuse trigger range 2.0).
  2. `const t0 = __qa.getGameTick()`; poll `getMob(id).fuse` every tick; record tick `tArm` when fuse first non-null and tick `tBoom` when a `mobAttack` event with `explosion:true` appears in `getMobEvents(10)`.
  3. Read `__qa.getLastHurt()` and `__qa.getHealth()`.
- **Pass criteria:** (a) `tBoom − tArm = 30 ± 3` ticks (1.5 s fuse); (b) `mobAttack` event has `explosion:true, hitPlayer:true`; (c) `getLastHurt().tick` within 3 ticks of `tBoom` and `getHealth().health < 20`; (d) exploder removed after blast (`getMob(id)===null`). Block destruction is asserted ONLY if `getCaps()` includes the W8 explosion token — otherwise annotate `blocks-intact (explode() module absent)`, not FAIL.
- **Screenshot:** `qa/W3/QA-W3-05-exploder-fuse.png`

#### QA-W3-06 — Hostile day-burn (zombie/skeleton parity)
- **Verifies:** P1-8-5
- **Gate:** caps `mobs`
- **Steps:**
  1. `STAGE_PEN`, midnight. `const a = await __qa.spawnMob('groaner', 8, 100, 0)` (open sky); build a roof `setBlock(x,104,z,'stone')` for x,z∈[−10..−6] and `const b = await __qa.spawnMob('groaner', −8, 100, 0)` under it.
  2. `__qa.setTime(6000)` (noon). Record `getMob(a).hp/burning` and `getMob(b).hp/burning` every 10 ticks for 200 ticks (10 s).
- **Pass criteria:** (a) within 40 ticks of noon, `getMob(a).burning === true` and hp strictly decreases at 1 HP per 20 ± 5 ticks; (b) `getMob(b).burning === false` for the whole window and hp = 20 unchanged; (c) frayedhound control (optional spawn at (8,100,8)): never burning (spider parity — no day-burn).
- **Screenshot:** `qa/W3/QA-W3-06-day-burn.png` (F3 open, both mobs in frame — aim via `__qa.setLook` at (0,101,0))

#### QA-W3-07 — Goal selector: MeleeAttack approach + attack
- **Verifies:** P1-8-6
- **Gate:** caps `mobs` + `damage`
- **Steps:**
  1. `STAGE_PEN`, midnight, survival. Stand at (0,100,0), do not move (no keys). `const id = await __qa.spawnMob('groaner', 10, 100, 0)` (within follow_range 35, LoS clear).
  2. Sample `getMob(id).goal/target/pos` every 5 ticks for 200 ticks; capture `getMobEvents(20)` and `getLastHurt()` at the end.
- **Pass criteria:** (a) `target === 'player'` within 20 ticks; goal becomes `'melee_attack'`; (b) horizontal distance to player decreases monotonically (allow ≤3 non-decreasing samples for pathing wiggle) to ≤ 1.5 blocks; (c) ≥1 `mobAttack` event and `getLastHurt().sourceType` reflects mob melee; consecutive `mobAttack` events for id are ≥ 16 ticks apart (attack cooldown ≈ 1.0 s /attack_speed, ±4 ticks).
- **Screenshot:** `qa/W3/QA-W3-07-melee-approach.png`

#### QA-W3-08 — Target selectors: follow_range gate, LoS, HurtByTarget
- **Verifies:** P1-8-7
- **Gate:** caps `mobs`
- **Steps:**
  1. Flat staging: WORLD_B, `setMobSpawning(false)`, `clearMobs()`, midnight; build stone platform y=99 for x∈[−4..40], z∈[−6..6]; tp player to (0,100,0).
  2. `const far = await __qa.spawnMob('frayedhound', 30, 100, 0)` (30 > follow_range 16). Sample `getMob(far).target` for 60 ticks → expect null.
  3. Build a wall: `setBlock(12, y, z, 'stone')` for y∈[100..103], z∈[−2..2]; `const holed = await __qa.spawnMob('frayedhound', 14, 100, 0)` (14 ≤ 16 but wall blocks eye-line). Sample target 60 ticks → expect null. Remove wall (`setBlock(...,'air')`); sample 40 ticks → target acquired.
  4. `__qa.hurtMob(far, 1, 'player')` (still ~30 blocks away). Sample `getMob(far).target/goal` for 40 ticks.
- **Pass criteria:** (a) step 2: `target === null` all samples (out of follow_range); (b) step 3: null while walled (raycastVoxel LoS blocked), `'player'` within 20 ticks after wall removal; (c) step 4: HurtByTarget overrides range — `target === 'player'` within 5 ticks of the hit and mob closes distance ≥ 5 blocks over the next 100 ticks. Note: frayedhound is day-neutral; midnight staging keeps NearestAttackableTarget active.
- **Screenshot:** `qa/W3/QA-W3-08-target-selectors.png`

#### QA-W3-09 — Pathfinding: cliff avoidance + step-up routing
- **Verifies:** P1-8-8
- **Gate:** caps `mobs`
- **Steps:**
  1. WORLD_B, `setMobSpawning(false)`, `clearMobs()`, midnight. Build two stone platforms at y=99: A for x∈[0..6], B for x∈[12..18], both z∈[−3..3]; the gap x∈[7..11] is open air down to a floor at y=79 (drop of 20 > safe_fall_distance 3). Player at (16,100,0) on B; `const id = await __qa.spawnMob('groaner', 3, 100, 0)` on A.
  2. Sample `getMob(id).pos` every 5 ticks for 200 ticks.
  3. Then bridge the gap at a step: `setBlock(x,99,z,'stone')` for x∈[7..11], z∈[−3..3], plus a 1-high step `setBlock(9,100,0,'stone')`. Sample 200 more ticks.
- **Pass criteria:** (a) phase 2: mob never falls — min sampled pos.y ≥ 99.9; mob stays on A (pos.x ≤ 6.8 at all samples; cliff-node rejection); (b) phase 3: mob crosses to B (reaches pos.x ≥ 12 within 200 ticks), traversing the 1-block step (step_height 1) without getting stuck > 60 consecutive ticks at the same ±0.2-block position.
- **Screenshot:** `qa/W3/QA-W3-09-cliff-stepup.png`

#### QA-W3-10 — Spawn cycle: 17×17 area, packs of 1–4, valid-spawn predicate
- **Verifies:** P1-8-9, P1-8-10
- **Gate:** caps `mobs`
- **Steps:**
  1. WORLD_A (survival, Normal), night: `__qa.setTime(18000)`; `setMobSpawning(false)`; `clearMobs()`; tp to a plains surface column (use PROBES-style scan: tp (100,200,100), wait `isColumnLoaded`, land on surface).
  2. `const r = await __qa.runSpawnCycle(400)` (400 ticks ≈ 20 s of attempts).
  3. For every `r.spawned[i]`: read `__qa.getBlock` at (⌊x⌋, ⌊y⌋−1, ⌊z⌋), (⌊x⌋,⌊y⌋,⌊z⌋), (⌊x⌋,⌊y⌋+1,⌊z⌋); compute horizontal+vertical distance to player; chunk delta `(⌊x/16⌋−pcx, ⌊z/16⌋−pcz)`.
  4. Group spawns by (tick, archetype) into packs.
- **Pass criteria:** (a) `r.spawned.length ≥ 1` (night surface world must produce hostiles); (b) every spawn: block below has `getBlockDef(idBelow).solid === true` and not transparent; spawn cell + above are `'air'`; distance to player ≥ 24 blocks; chunk delta within ±8 in both axes (17×17), and every spawn chunk satisfies `isColumnLoaded`; (c) every pack size ∈ [1,4] and all members of a pack share one archetype ∈ {groaner, frayedhound, needlejack, screecher} (warpwold night table, `mobs/spawnRules.js` `SPAWN_TABLES.warpwold.night` — needlejack weight 3 is a regular member, not a surprise); pack member scatter ≤ 8 blocks; (d) zero passives spawned at night on non-grass/dark columns.
- **Screenshot:** `qa/W3/QA-W3-10-spawn-cycle.png`

#### QA-W3-11 — Light rule seam: emitter blocks hostile spawn; passives need grass+day
- **Verifies:** P1-8-11 (heuristic seam — see plan cluster E; real block-light propagation is the lighting wave)
- **Gate:** caps `mobs`
- **Steps:**
  1. WORLD_B, `setMobSpawning(false)`, `clearMobs()`. Build a sealed 16×16 stone room 26–40 blocks from the player (player proximity blocks spawns within 24): floor y=59 spanning x∈[26..42], ceiling y=63, interior air y∈[60..62], walls at the perimeter (fully sky-occluded, below surface); player at (0,60,0) in a small side alcove. Midnight.
  2. `const dark = await __qa.runSpawnCycle(600)`; count spawns with pos inside the room.
  3. Place glowstone grid: `setBlock(x,60,z,'glowstone')` every 6 blocks across the room floor (emissive 15 ⇒ every interior cell within 4 Chebyshev of an emitter). `const lit = await __qa.runSpawnCycle(600)`.
  4. Passive check: on the daylight grass surface (noon, `setTime(6000)`), `const day = await __qa.runSpawnCycle(600)`; verify passive spawns sit on `'grass'` or `'snow_grass'` top blocks; then replace a 16×16 surface patch with stone and rerun → no passive spawns on the stone patch.
- **Pass criteria:** (a) `dark` produces ≥ 1 hostile inside the room; (b) `lit` produces **0** spawns inside the room (blockLight seam > 0 everywhere); (c) `day` passives (grazer/bobbindeer/trader) only ever on grass-family top blocks with open sky; 0 passives on the stone patch; (d) annotate result `light-seam-heuristic` so the lighting wave re-runs this test against real propagation.
- **Screenshot:** `qa/W3/QA-W3-11-light-rule.png`

#### QA-W3-12 — Mob caps: `cap × spawnableChunks/289`
- **Verifies:** P1-8-12
- **Gate:** caps `mobs`
- **Steps:**
  1. WORLD_A, night, `setMobSpawning(false)`, `clearMobs()`; stand still on open terrain; `__qa.setSetting('video.renderDistance', 6)`; wait 10 s for chunk streaming to settle (`__qa.getLoadedSectionCount()` stable across 2 s).
  2. `const d0 = __qa.getSpawnDebug()`.
  3. Saturate: `await __qa.runSpawnCycle(3000)`; `const d1 = __qa.getSpawnDebug()`; `const mobs = __qa.getEntities('mob')`.
- **Pass criteria:** (a) `d0.spawnableChunks ≤ 169` (13×13 at rd 6 — plan delta: 17×17 clamped to loaded) and > 100; (b) `d0.caps.monster.cap === Math.ceil(70 * d0.spawnableChunks / 289)` exactly (e.g. 169 → 41); `d0.caps.creature.cap === Math.ceil(10 * d0.spawnableChunks / 289)`; (c) after saturation: `d1.caps.monster.count ≤ d1.caps.monster.cap` and hostile count in `mobs` (types prefixed `mob:` ∈ monster set) equals `d1.caps.monster.count ± 0`; a further `runSpawnCycle(200)` adds **0** monsters while count == cap; (d) count also ≤ the perf clamp `maxMobs` (48) — if cap > 48 annotate `perf-clamp-active`, not FAIL.
- **Screenshot:** `qa/W3/QA-W3-12-mob-caps.png`

#### QA-W3-13 — Despawn tiers: >128 instant, 32–128 probabilistic 1/800, ≤32 never, persistence
- **Verifies:** P1-8-13
- **Gate:** caps `mobs`
- **Steps:**
  1. WORLD_B, flat staging, `setMobSpawning(false)`, `clearMobs()`, noon. Build a stone strip y=99 from x=0 to x=160, z∈[−2..2].
  2. **≤32 tier:** spawn `groaner` at (20,100,0) (d=20); wait 1200 ticks (60 s). Assert alive.
  3. **1/800 tier:** `clearMobs()`; spawn 30 groaners spread x∈[60..70] (d≈60–70); record `getEntities('mob').length` every 100 ticks for 800 ticks. Expected survivors after t ticks ≈ 30·(1−1/800)^t → after 800 ticks ≈ 11.0.
  4. **>128 tier:** `clearMobs()`; spawn `groaner` at (10,100,0), then `await __qa.tp(150, 100, 0)` (d>128; mob's chunk may unload — despawn check must still run per plan cluster F). Poll `getMobEvents(10)` for `mobDespawn`.
  5. **Persistence:** spawn `trader` at (60,100,0) (despawn-exempt archetype; the customName persistence route is untestable — `customName` is not in `setMobState`'s allowed keys, so the trader is the only persistence probe). Wait 800 ticks.
- **Pass criteria:** (a) step 2 mob alive at 1200 ticks (`getMob(id) !== null`); (b) step 3: survivors after 800 ticks ∈ [4, 19] (±3σ around 11 for n=30; binomial σ≈2.6); at least 1 `mobDespawn` event observed; (c) step 4: `mobDespawn` for the mob within 40 ticks of the tp (instant tier + sweep cadence tolerance); (d) trader alive after 800 ticks at d≈60 (exempt).
- **Screenshot:** `qa/W3/QA-W3-13-despawn-tiers.png`

#### QA-W3-14 — Grazer eats grass to regrow wool (sheep parity)
- **Verifies:** P1-8-21
- **Gate:** caps `mobs`
- **Steps:**
  1. WORLD_B, noon, `setMobSpawning(false)`, `clearMobs()`. Find/stage a grass area: `setBlock(x,99,z,'grass')` for x,z∈[4..12], air above. Player at (0,100,0).
  2. `const id = await __qa.spawnMob('grazer', 8, 100, 8)`; assert `getMob(id).woolGrown === true` (spawn default).
  3. `__qa.setMobState(id, { woolGrown: false })`.
  4. Record `s = []`: every 10 ticks for 1600 ticks push `{ goal: getMob(id).goal, woolGrown: getMob(id).woolGrown, pos }`; also snapshot the 9×9 grass patch block ids each 100 ticks via `getBlock(x,99,z)`.
- **Pass criteria:** (a) within 1600 ticks the goal `'eat_grass'` appears in samples; (b) exactly the block under the mob's position at that sample transitions `'grass'` → `'dirt'` (≥1 cell changed; changed cell within 1 block of mob pos at the eat sample); (c) `woolGrown` flips false→true within 60 ticks after the block change; (d) no other grass cells changed (no collateral edits); (e) in a second run with the future `mobGriefing=false` rule available (`getCaps()` contains `gamerules`), grass is NOT converted — otherwise annotate `gamerule-pending`.
- **Screenshot:** `qa/W3/QA-W3-14-eat-grass.png` (aim at the eaten cell, F3 open)

#### QA-W3-15 — Difficulty scaling: melee damage + groaner reinforcements
- **Verifies:** P1-23-3
- **Gate:** caps `mobs` + `difficulty` + `damage`
- **Steps:**
  1. WORLD_A, survival, midnight, `setMobSpawning(false)`, `clearMobs()`. Note groaner base attack_damage `D = getEntityAttribute(id,'attack_damage')` from a probe spawn (then `clearMobs()`).
  2. For each `d ∈ ['easy','normal','hard']`: `await __qa.setDifficulty(d)`; heal via respawn if needed; stand still; `spawnMob('groaner', 3, 100, 0)`; wait for first `mobAttack` event; record `h0−h1` from `getHealth()` sampled just before/after (poll every tick); `clearMobs()`.
  3. Reinforcements: `await __qa.setDifficulty('hard')`; `const id = await __qa.spawnMob('groaner', 8, 100, 0)`; wait until `getMob(id).target === 'player'`; apply `__qa.hurtMob(id, 1, 'player')` 20 times, 10 ticks apart; count `mobSpawn` events with `archetype:'groaner'` (excluding id) in `getMobEvents(64)`. Repeat identically on `'easy'`.
- **Pass criteria:** (a) observed melee damage: easy = `floor(D/2)+1`, normal = `D`, hard = `ceil(D*1.5)`, each ±0 (integers; player armor is 0); (b) hard run: ≥ 2 reinforcement spawns in 20 trials (p=0.25 ⇒ P(≥2)≈0.976); easy run: **0** reinforcement spawns; reinforcement positions 8–16 blocks from the hurt mob and pass the valid-spawn predicate (solid below, 2 air); (c) `getDifficulty()` round-trips each set value; (d) door-breaking/potion-spider fragments: annotate `N/A — no doors / no status effects` (parity delta per plan cluster G), never FAIL.
- **Screenshot:** `qa/W3/QA-W3-15-difficulty.png`

#### QA-W3-16 — Dimension switch rebuilds the mob layer (fresh MobManager, per-dimension tables)
- **Verifies:** P1-8-9/P1-8-10 dimension conditions + the plan's KNOWN CONSTRAINT (no `setWorld()`; `main.js switchDimension` rebuilds `G.world`)
- **Gate:** caps `mobs` + `nether`
- **Steps:**
  1. WORLD_B, `setMobSpawning(false)`; in overworld spawn 3 grazers via `spawnMob`; note their ids.
  2. Switch dimension via the game's QA path (`__game.setDimension('nether')` per docs/DEV.md — or the `__qa` equivalent if shimmed); wait `__qa.getDimension().id === 'nether'`, then `isColumnLoaded(⌊px⌋,⌊pz⌋)`.
  3. Assert mob registry state; then `const r = await __qa.runSpawnCycle(600)`.
  4. Switch back to `'overworld'`; `runSpawnCycle(200)` at noon.
- **Pass criteria:** (a) immediately after switch, `getEntities('mob')` is empty and all 3 grazer ids return `getMob(id) === null` (old MobManager disposed — no orphaned THREE.Group in scene: `chunkRenderer`-independent check via scene child count delta ≤ 0 for mob groups, or a `__qa`-visible `getEntities` emptiness suffices); (b) every archetype in `r.spawned` ∈ {exploder, emberspinner, screecher, scaldwarden, groaner} (cinderloom table, `mobs/spawnRules.js` `SPAWN_TABLES.cinderloom` — scaldwarden weight 2 is a regular member) — no grazer/trader/frayedhound/needlejack; spawns satisfy the valid-spawn predicate on netherrack (solid opaque top, 2 air, y∈[1,126]); (c) after switching back, overworld day spawns ∈ {grazer, bobbindeer, trader} only; (d) no console errors across both switches (page `console` listener: zero `error`-level entries containing `MobManager` or `three`).
- **Screenshot:** `qa/W3/QA-W3-16-dimension-mobs.png`

---

## W4 acceptance tests — Farming, crops, growth & breeding (random-tick foundation)

Harness per QA_PLAN.md §1 (Playwright + Chromium, 1280×720, `ensureLocked`, `aimAt`/`setLook`, screenshot rules §1.6). **Real-SUT adaptations (feat/voxel-sandbox-game), same as W1-qa:** launch `npm start` (`node server/index.js`, port 3000), readiness `curl -sf http://localhost:3000/api/health` → `{ok:true}`; base URL **`http://localhost:3000/?qa=1`**; fixtures via the real REST API (`POST /api/worlds`, docs/PROTOCOL.md) — QA_PLAN §1.10's 5173/25565 endpoints are the idealized spec. `__qa.getBlock` returns block-def **names** from `public/src/blocks/blocks.js` (`'farmland_wet'`, `'wheat_3'`, …); valid y domain **[0,128)**, sea level **40**. 1 game tick = 50 ms (client fixed-step accumulator — there is no server tick). Settings key for render distance is `renderDistance`. Block-id NUMBERS below are nominal (W4-plan id budget); tests assert by NAME only.

**Reused hooks** (already specified elsewhere; this file depends on them): core §1.4 `getCaps, getBlock, setBlock, tp, give, isColumnLoaded, getGameTick, getPlayerPos, setLook, getTargetedBlock, getEntities, setSetting, getHeldItem, getSelectedSlot`; W1-qa `scanBlocks(x0,y0,z0,x1,y1,z1)`; W3-qa `spawnMob(archetype, x, y, z) → mobId` and `feedMob` (W4 **extends** feedMob's signature — see §2.1-2; supersedes W3's zero-arg dev stub).

**New `__qa` hooks & cap tokens for this wave:** consolidated in §2 above (per-wave block **W4** in §2.3 + cap-token table §2.4); the signatures there are normative, including the conflict resolutions of §2.1.

**Fixtures:**
- `FARM_A`: `POST /api/worlds {name:'qa-farm', seed:'8675309'}`; join via the real menus (title → world select → row `qa-farm` → play) then `ensureLocked(page)`.
- `STAGE`: in FARM_A — `__qa.tp(0,90,0)`, load-wait (§1.7 rule: `waitForFunction(__qa.isColumnLoaded(x,z))` after every tp), then `setBlock` a stone platform y=79 for x∈[−24..24], z∈[−24..24] and clear air y∈[80..90]. Sky-exposed (nothing above y80). All plots below are built on STAGE.
- `DARKBOX`: on STAGE, a sealed stone room, interior 5×5×3 air at x∈[10..14], z∈[10..14], y∈[80..82] (roof at y83 ⇒ `skyExposed=false`, no emitters).
- Unless a test says otherwise: `__qa.setRandomTickSpeed(0)` during staging (freeze growth), restore before measuring. Tick counts are asserted via `getGameTick()` deltas, never wall-clock.

---

- **QA-W4-01 — random-tick engine: rate, section math, sim-distance gating.**
  **Verifies:** P1-1-32. **Gate:** caps `randomTick`.
  **Steps:** In FARM_A on STAGE: `r = __qa.getRandomTick()`. Then `__qa.setSetting('renderDistance', 8)`; sample `{getGameTick, dispatchedLastTick, tickedChunks}` via one `page.evaluate` polling 100 consecutive ticks. Gating: `__qa.isChunkTicked(0,0)` (player chunk) and `isChunkTicked(7,7)` (Chebyshev 7 — loaded at rd 8, beyond simDistance 6). Behavioral: build two 4×4 hydrated-farmland+`wheat_0` plots — plot N at (4,80,4) (near), plot F centered at x=z=118 (chunk (7,7)); `setRandomTickSpeed(300)`, wait 1200 ticks, read all 32 crops.
  **Pass:** defaults `speed===3`, `sectionsPerChunk===8`, `positionsPerChunkPerTick===24`, `simDistance===6`; over the 100-tick sample `dispatchedLastTick === tickedChunks × positionsPerChunkPerTick` on ≥ 99 ticks (per-block expectation 3/4096 by construction); `isChunkTicked(0,0)===true`, `isChunkTicked(7,7)===false`; after the run, plot N mean stage ≥ 3 and plot F all 16 crops still `wheat_0`.
  **Screenshot:** `qa/W4/QA-W4-01-ticked-plot.png` (plot N in frame, F3 open — `page.keyboard.press('F3')`).

- **QA-W4-02 — crops need farmland + light ≥ 9 (heuristic).**
  **Verifies:** P1-21-1 (+P1-4-7 wheat core). **Gate:** caps `farming`.
  **Steps:** on STAGE: `give('wheat_seeds', 64)`; (a) `useItemOn(2,80,2,'wheat_seeds')` on hydrated farmland at (2,79,2) → expect plant; (b) `useItemOn(4,80,2,'wheat_seeds')` on bare stone/dirt → expect reject; (c) plant wheat inside DARKBOX on farmland (water pot in a corner), and a fourth crop in DARKBOX with `setBlock` glowstone 2 blocks away; `forceRandomTicks(...,200)` on each planted crop.
  **Pass:** (a) `getBlock(2,80,2)==='wheat_0'` and `getPlantInfo(2,80,2).lightOk===true`; (b) returns false and block stays air; (c) roofed no-emitter crop: `lightOk===false` and stage still 0 after 200 forced ticks; roofed + glowstone-within-4 crop: `lightOk===true` and stage ≥ 1. Sky-exposed crops report `lightOk===true` regardless of time of day.
  **Screenshot:** `qa/W4/QA-W4-02-light-gate.png` (DARKBOX interior, glowstone crop grown, dark crop age 0, F3 open).

- **QA-W4-03 — farmland hydration, dry→dirt, water geometry.**
  **Verifies:** P1-21-2 (hydration half). **Gate:** caps `farming`.
  **Steps:** on STAGE build 3 farmland cells (`setBlock ... 'farmland_dry'`): F1 with water at horizontal Chebyshev 4, same y; F2 with water at Chebyshev 5 (out of range); F3 with water at dy=+2 (above plane). `forceRandomTicks` ×10 each; read `getFarmland`. Then delete F1's water, `forceRandomTicks(F1, 8)` reading `moisture` after each; keep no crop above; 2 more forced ticks.
  **Pass:** F1 → `wet===true, moisture===7, waterFound===true`; F2 and F3 stay `wet===false, waterFound===false` (range is Chebyshev ≤4 at dy∈{0,−1} per PARITY wording); after water removal F1's `moisture` strictly decrements 7→0 across ~8 ticks (id flips to `farmland_dry` at 0), and within 2 further ticks `getBlock(F1)==='dirt'`.
  **Screenshot:** `qa/W4/QA-W4-03-hydration.png` (F1 wet + F2 dry side by side, water channel visible, F3 overlay open).

- **QA-W4-04 — trampling reverts farmland on fall.**
  **Verifies:** P1-21-2 (trampling half). **Gate:** caps `farming`.
  **Steps:** hydrated farmland at (8,79,8) with `wheat_2` above (stage via `forceRandomTicks` under `setRandomTickSpeed(0)`); `__qa.tp(8,84,8)` (4-block fall onto the crop cell); wait for landing (`waitForFunction(() => __qa.getPlayerPos().y < 81)` + 10 ticks). Control: walk (KeyW ~300 ms) across an adjacent farmland cell without falling.
  **Pass:** landed cell: `getBlock(8,79,8)==='dirt'` and `getBlock(8,80,8)==='air'` (crop popped); walked cell still `farmland_wet` with crop intact.
  **Screenshot:** `qa/W4/QA-W4-04-trample.png` (dirt crater in the farmland row, F3 open).

- **QA-W4-05 — growth-points formula + chance.**
  **Verifies:** P1-21-3. **Gate:** caps `farming`.
  **Steps:** four staged configs on STAGE (setRandomTickSpeed 0): (A) lone `wheat_0` on hydrated farmland, 8 neighbors stone → expect points 1+3=4; (B) lone wheat, DRY farmland below, dry farmland ×8 around → 1+1+8×0.25=4; (C) wheat centered in 3×3 all-hydrated farmland, no other crops → 1+3+8×0.75=10; (D) config C plus same-crop wheat at N and E neighbors (both axes) → penalty halves. Read `getPlantInfo(...).{growthPoints,chance}` for each. Statistics: 64 lone-hydrated crops (config A), `forceRandomTicks(...,14)` each; sum stages gained.
  **Pass:** points exactly {A:4, B:4, C:10, D:10 with chance halved}; chance A/B `=== 1/(Math.floor(25/4)+1) === 1/7` ±1e−9, C `=== 1/3` ±1e−9, D `=== 1/6` ±1e−9; statistical: total stages gained across 64×14 rolls ∈ [96, 160] (mean 128 = 896×1/7, ±3σ≈±31).
  **Screenshot:** `qa/W4/QA-W4-05-growth-points.png` (the 3×3 hydrated plot, F3 open).

- **QA-W4-06 — stage ladders + bonemeal +2–5.**
  **Verifies:** P1-21-4 (+P1-4-7). **Gate:** caps `farming`.
  **Steps:** plant one of each crop on hydrated farmland. Wheat: `forceRandomTicks` until mature, recording every distinct `getBlock` name. Beetroot likewise. Carrot/potato: read `getPlantInfo.maxAge` and `chance`. Bonemeal: `give('bone_meal',64)`; on 30 fresh `wheat_0`, one `useItemOn(...,'bone_meal')` each, record stage deltas; then apply bonemeal to a mature `wheat_7`.
  **Pass:** wheat walks exactly `wheat_0..wheat_7` (8 distinct names, strictly ascending, no skips under forced single ticks); beetroot exactly `beetroots_0..beetroots_3`; carrot/potato `maxAge===3` with `chance === (points formula)×0.5` ±1e−9 (documented 4-id compression, W4-plan Cluster B); bonemeal deltas all ∈ [2,5] with ≥ 2 distinct values across 30 trials; on `wheat_7` `useItemOn` returns false and held bone_meal count is unchanged.
  **Screenshot:** `qa/W4/QA-W4-06-stages.png` (row showing wheat 0→7 ladder staged side-by-side, F3 open).

- **QA-W4-07 — stems: fruit on adjacent valid soil.**
  **Verifies:** P1-21-5. **Gate:** caps `farming.stems`.
  **Steps:** grow a `pumpkin_stem_3` (plant `pumpkin_seeds` on hydrated farmland, `forceRandomTicks` to mature). Case 1: exactly one of the 4 horizontal neighbors is air-over-dirt (other three stone-blocked or air-over-air); `forceRandomTicks(stem, 64)`. Break the fruit (`setBlock` air), `forceRandomTicks(stem, 64)` again. Case 2: a second mature stem with all 4 neighbors invalid; 200 forced ticks.
  **Pass:** case 1: `getBlock(neighbor)==='pumpkin'` within the 64 forced ticks, stem block name still `pumpkin_stem_3` (does not reset); after breaking, fruit regrows within 64 more; melon variant (repeat with melon_seeds) yields `'melon'`; case 2: no fruit ever placed, all 4 neighbor cells unchanged.
  **Screenshot:** `qa/W4/QA-W4-07-stem-fruit.png` (stem + attached pumpkin, F3 open).

- **QA-W4-08 — canes & growers: sugar cane, cactus, bamboo, chorus.**
  **Verifies:** P1-21-6. **Gate:** caps `farming.growers` (cactus-damage sub-check additionally gated `damage`; chorus sub-check gated on `setDimension` availability — dev hook, always present in qa builds).
  **Steps:** (a) sugar_cane: place on dirt with adjacent water → accepted; on dry dirt → rejected; `setRandomTickSpeed(400)`, wait 2400 ticks. (b) cactus: `setBlock` sand + cactus, same run; then walk the player into the cactus cell face for 3 s (KeyW hold). (c) bamboo ×8 columns, same run, then read heights. (d) `__qa.setDimension('end')`, tp to (0,72,0) region, load-wait, `setBlock` end_stone pedestal + `chorus_flower`, `forceRandomTicks(...,400)` walking up the column.
  **Pass:** (a) placement returns per spec; cane column reaches EXACTLY 3 (never 4) within the run — top cell above height-3 stays air; (b) cactus reaches exactly 3; with cap `damage`: player health drops ≥ 1 HP during contact (via `getHealth()` if present, else the W3 damage hook); (c) all bamboo heights ∈ [12,16], ≥ 2 distinct heights across 8 columns; (d) chorus grows ≥ 3 `chorus_plant` blocks above the pedestal with a `chorus_flower` tip; total chorus blocks ≥ 5.
  **Screenshot:** `qa/W4/QA-W4-08-growers.png` (cane/cactus/bamboo row on STAGE, F3 open) + `qa/W4/QA-W4-08-chorus.png` (End, F3 open).

- **QA-W4-09 — sapling → tree: space, light, bonemeal, border-crossing.**
  **Verifies:** P1-21-7 (growth half). **Gate:** caps `sapling`.
  **Steps:** (a) `oak_sapling` on dirt on STAGE; `useItemOn(...,'bone_meal')` up to 20× or until grown. (b) sapling inside DARKBOX (no emitter): `forceRandomTicks(...,500)`. (c) sapling with stone roof 3 above (space check): 20 bonemeals. (d) border case: sapling at x with `x mod 16 === 15` (e.g. (15,80,4) is in chunk (0,0)); bonemeal to grown; `scanBlocks` the 7×10×7 volume spanning both chunks.
  **Pass:** (a) tree appears: ≥ 4 vertical `log` blocks at the sapling column + ≥ 20 `leaves` (scanBlocks counts), sapling gone; (b) still `oak_sapling` after 500 dark ticks; (c) still `oak_sapling` after 20 roofed bonemeals (each `useItemOn` returns false or consumes without growth — assert block unchanged); (d) ≥ 1 `leaves` block at x ≥ 16 (neighboring chunk (1,0)) and the neighbor chunk's mesh updated (no error; visual confirmed by screenshot).
  **Screenshot:** `qa/W4/QA-W4-09-border-tree.png` (aim at the border-straddling canopy with `setLook`, F3 open showing the `Chunk:` line).

- **QA-W4-10 — leaf decay: >6 from log decays, near-log and player-placed persist.**
  **Verifies:** P1-21-7 (decay half). **Gate:** caps `sapling`.
  **Steps:** on STAGE: (a) build a free-floating 3×3×1 `leaves` plate at y=86, ≥ 10 blocks from any log; (b) build a `log` column with a leaves block 3 steps away (BFS through 2 leaves); (c) while pointer-locked, PLACE one leaves block by hand ≥ 10 from any log (select leaves in hotbar via `__game.inventory.setSlot` + `Digit1`, aim with `setLook`, `page.mouse.down({button:'right'})`). `setRandomTickSpeed(400)`, wait 2400 ticks.
  **Pass:** (a) all 9 floating leaves decayed to air (with per-block p_tick = 400/4096 per random tick, P(survive 2400 ticks) = (1 − 400/4096)^2400 < 10⁻⁶); (b) the connected leaves (BFS distance ≤ 6 to log) remain; (c) the hand-placed leaf remains (session `placedByPlayer` set — parity delta re: persistence across reload is documented, not asserted).
  **Screenshot:** `qa/W4/QA-W4-10-leaf-decay.png` (before/after framing: log-attached leaves intact, floating plate gone, F3 open).

- **QA-W4-11 — grass spread + grass→dirt when covered.**
  **Verifies:** P1-21-8 (grass half). **Gate:** caps `spread`.
  **Steps:** on STAGE: dirt strip x∈[0..6] at y=79 with ONE grass source at x=0; air above all. A separate dirt block at horizontal distance 3 from any grass (isolation control). A grass block with a stone cube placed directly on top. `setRandomTickSpeed(400)`, wait 2400 ticks.
  **Pass:** ≥ 4 of the 6 strip dirt blocks converted to `grass` (spread propagates cell-to-cell); the isolated dirt (no grass within the dx,dz∈±1, dy∈±2 reach) is still `dirt`; the covered grass block is `dirt` (covered rule); uncovered control grass unchanged.
  **Screenshot:** `qa/W4/QA-W4-11-grass-spread.png` (strip mid-conversion or fully converted, F3 open).

- **QA-W4-12 — mushroom spread cap + bonemeal giant mushroom.**
  **Verifies:** P1-21-8 (mushroom half). **Gate:** caps `spread`.
  **Steps:** enlarge DARKBOX to interior 11×3×11 (rebuild sealed). Place ONE `brown_mushroom` at center on stone; `setRandomTickSpeed(400)`, wait 3000 ticks; count brown_mushroom in the 9×3×9 box (scanBlocks). Sunlit control: one brown_mushroom on STAGE in the open, same run. Giant: in the open, `brown_mushroom` on dirt, `useItemOn(...,'bone_meal')` up to 10×.
  **Pass:** dark room count ∈ [2,5] and NEVER > 5 across three 1000-tick polls (cap enforced); sky-exposed control never spreads (count 1); giant mushroom appears: ≥ 4 `mushroom_stem` blocks stacked + ≥ 9 `brown_mushroom_block` cap blocks, small mushroom consumed.
  **Screenshot:** `qa/W4/QA-W4-12-mushrooms.png` (dark-room cluster, F3 open) + `qa/W4/QA-W4-12-giant.png` (giant mushroom).

- **QA-W4-13 — breeding: feed 2 adults → baby; cooldowns; −10%/feed.**
  **Verifies:** P1-21-9. **Gate:** caps `breeding` (requires `mobs`).
  **Steps:** on STAGE: `a = __qa.spawnMob('grazer', 4,80,4)`, `b = __qa.spawnMob('grazer', 6,80,6)`; `give('wheat', 8)`; select the wheat hotbar slot (`Digit1`), `ensureLocked`, aim at mob a via `setLook(aimAt(eye, ax,ay+0.5,az))`, `page.mouse.down({button:'right'})` (REAL use path); then `__qa.feedMob(b,'wheat')` for the second. `waitForFunction(() => __qa.getEntities().filter(e => e.type==='mob:grazer').length === 3, null, {timeout:15000})`. Read `getBreeding` for all three; `feedMob(baby,'wheat')` twice, reading `growthTicksRemaining` before/after each.
  **Pass:** the real right-click feed consumed 1 wheat (held count −1) and set `loveTicks > 0` on mob a; a baby exists with `isBaby===true`, `persistent===true`, `growthTicksRemaining ∈ [23000, 24000]`; both parents `breedCooldownTicks ∈ [5800, 6000]` (= 6000gt minus elapsed); re-feeding a parent during cooldown returns false and sets no loveTicks; each baby feed multiplies `growthTicksRemaining` by 0.9 ±1% (−10%/feed).
  **Screenshot:** `qa/W4/QA-W4-13-baby.png` (two adults + half-scale baby, F3 open).

- **QA-W4-14 — breeding-foods table: right food only; full 18-row data.**
  **Verifies:** P1-21-10. **Gate:** caps `breeding`.
  **Steps:** `t = __qa.getBreedingFoods()`. Spawn one `grazer`, one `bobbindeer`, one `trader`; call in order: `feedMob(grazer,'carrot')`, `feedMob(grazer,'wheat')`, `feedMob(bobbindeer,'carrot')`, `feedMob(bobbindeer,'bone_meal')`, `feedMob(trader,'wheat')`; read `getBreeding` after each rejected call.
  **Pass:** table has 18 rows; every vanilla mapping from PARITY §21 present verbatim under `vanillaName`+`foods` (cow/sheep→wheat … armadillo→spider_eye); exactly the W3-integrated species are `active:true` (`grazer` foods `['wheat']`; `bobbindeer` foods `['wheat','carrot','potato','beetroot']`); behavioral: `feedMob(grazer,'carrot')===false` with `loveTicks===0` after; `feedMob(grazer,'wheat')===true`; `feedMob(bobbindeer,'carrot')===true`; `feedMob(bobbindeer,'bone_meal')===false`; trader: every food returns false (not breedable).
  **Screenshot:** `qa/W4/QA-W4-14-breeding-foods.png` (grazer being fed, F3 open).

- **QA-W4-15 — growth persists and replicates: edits path, reload, second client, tick ownership.**
  **Verifies:** P1-1-32 (client-sim replication half), P1-21-4 (persistence of stage ids). **Gate:** caps `randomTick`+`farming`.
  **Steps:** grow a wheat to `wheat_5` at a known cell via `forceRandomTicks` — **hardened-server staging constraint (§1 server-authority note):** the tick-owner's growth edits are ordinary `edit` frames, so they persist/replicate ONLY if the owning client's server-tracked position is within reach 7 (`MAX_REACH`) of the crop cell and inside the 20/s edit bucket — stand the owner within 7 blocks of the cell for the whole growth run (and after any `tp`, wait the 2 s grace window). Wait ≥ 2.5 s (server `SAVE_DEBOUNCE_MS=2000`); `page.reload()` → rejoin `qa-farm` via menus → load-wait → read the cell (edits arrive in `welcome.world.edits`). Then open a SECOND browser context, join the same world (name `qa2`); on both pages read the cell and `__qa.getChunkTickOwner(0,0)` + `isChunkTicked(0,0)`; on the owner page `setRandomTickSpeed(200)` and confirm only the owner's `getRandomTick().dispatchedLastTick > 0` for 100 ticks while the non-owner's stays 0 for chunk-owned work (`isChunkTicked(0,0)===false` on the non-owner).
  **Pass:** after reload the cell is still `'wheat_5'` (stage id round-tripped through `saves/<id>.json` edits); second client sees `'wheat_5'` live (edit broadcast/welcome) **in the players-adjacent staging above** — annotate `reach-capped replication`: the general tick-ownership relay is broken under the hardened server (growth edits from an owner > 7 blocks away, or beyond the 20/s bucket, are silently dropped server-side; the design assumed an unrestricted relay — open W4/W7 coordination item, this test certifies only the adjacent case); both clients report the SAME owner id for chunk (0,0) (the numerically-lowest `p<N>`), and exactly one client has `isChunkTicked(0,0)===true`.
  **Screenshot:** `qa/W4/QA-W4-15-persistence.png` (post-reload view of the wheat_5 cell, F3 open).

---

## W5 acceptance tests — Items, crafting UI, tools progression, containers & drops (bridge to content/items.json)

Harness per QA_PLAN.md §1 (Playwright + `?qa=1`, viewport 1280×720, `ensureLocked` after every screen close, 1 game tick = 50 ms, `aimAt`+`__qa.setLook` before every mouse press, fixtures §1.7). Item/block ids in assertions are the `__qa` STRING ids the shim maps from the numeric registries (`public/src/blocks/blocks.js` BLOCK_ID + `gameplay/items.js` ITEM_ID): `stone, cobblestone, dirt, planks, log, glass, sand, raw_skein, handloom, furnace, furnace_lit, chest, coal_ore, iron_ore, diamond_ore, emberskein, needle_iron, dawnthread, knotwood_pickaxe, …`. World is 16×16×128, SEA_LEVEL 40 (parity delta vs 384/63) — all staging y-values fit [55..80]. Break-time expectations use the QA_PLAN §1.9 recipe: `ticks = ceil(hardness · (canHarvest ? 30 : 100) / speed)`, bare-hand speed 1.0.

**Fixture `W5S`** (used unless stated): singleplayer world `qa-w5`, seed `8675309`, cheats ON; `__qa.setGameMode('survival')`; stone platform `__qa.setBlock(x, 60, z, 'stone')` for x∈[−8..24], z∈[−8..8] (surface y=61), 4 air above; `__qa.tp(0.5, 61, 0.5)`; `await page.waitForFunction(() => __qa.isColumnLoaded(0, 0))`; `ensureLocked(page)`. **`W5C`** = same but `setGameMode('creative')`.

**New `__qa` hooks & cap tokens for this wave:** consolidated in §2 above (per-wave block **W5** in §2.3 + cap-token table §2.4); the signatures there are normative, including the conflict resolutions of §2.1.

Existing M0 hooks reused heavily below: `give(itemId, count)`, `getItemDef(id)`, `getHeldItem/getHotbar/getInventorySlot/getCursorStack`, `getBreakProgress`, `getEntities('item')`, `recordTicks` (its `itemEntities` + `heldCount` per-tick channels), `getTargetedBlock`, `setBlock`, `tp`, `setGameMode`, and the §1.5 `data-slot`/`data-tab` DOM contract (`craft0..craft3` / `craft0..craft8`, `craftResult`, `c0..c{N-1}`, `data-tab="<label>"`). W3 hooks (`spawnMob`, `hurtMob`, `getMobEvents`) are used only in QA-W5-16 (gate `mobs`).

---

#### QA-W5-01 — Item registry + content bridge integrity
- **Verifies:** P1-5-2 (+ the items.json/naming.json bridge and loot reconciliation)
- **Gate:** caps `items` + `crafting`
- **Steps:**
  1. `W5S`. `const r = await page.evaluate(() => __qa.qaContentReport())`.
  2. For each of the 40 items.json ids (spot-check 10: `loose_thread, woven_cloth, handloom, knotwood_pickaxe, threadstone_blade, needle_iron_shears, dawnthread_pickaxe, everthread_blade, needle_iron_mail, scorched_silk`) read `__qa.getItemDef(id)`.
  3. Read `getItemDef` for locally-registered ids: the W5 tool/smelt locals `emberskein, charcoal, giltspool, needle_iron, dawnthread, everthread, lava_bucket` plus the naming.json-block loot ids the mob tables reference (`mobs/lootTables.js` header list): `tallowstone, cinderthread, voidknot, emberskein_ore`.
  4. `__qa.give('knotwood_pickaxe', 5)`; read `getHeldItem()` after selecting the slot; `give('emberskein', 80)`.
- **Pass criteria:** (a) `r.unresolvedRecipeCells.length === 0` AND `r.unresolvedLootIds.length === 0` (the reconciliation deliverable); `r.aliasesApplied` is `{}` (deep-equal — `mobs/lootTables.js` already emits canonical ids like `scorched_silk`, so NO alias may fire; a non-empty map means a stale legacy id crept back in); `r.localOverrides` contains `'handloom'` and `'planks'`; `r.itemCount ≥ 51` (items.json's 40 + the step-3 locals); (b) every spot-checked def is non-null with `displayName` and `maxStack` (tools/armor = 1, materials = 64); tool defs carry `tool.class ∈ {pickaxe,axe,spade,blade,shears}` and `tool.tier ∈ [1..5]`; (c) `give` of 5 unstackable pickaxes fills 5 slots of count 1; 80 emberskein fills one 64 + one 16 (`getHotbar()` counts exact).
- **Screenshot:** `qa/W5/QA-W5-01-registry-bridge.png`

#### QA-W5-02 — Creative tabs + search
- **Verifies:** P1-5-1
- **Gate:** caps `items`
- **Steps:**
  1. `W5C`. Press `KeyE` (creative screen opens; `getScreen()` non-null).
  2. Enumerate `[data-tab]` buttons; click `[data-tab="Tools & Utilities"]`; read the `data-slot="creative0.."` grid contents via `getInventorySlot('creative<i>')`-equivalent DOM icons + tooltip names; click `[data-tab="Building Blocks"]`.
  3. Click `[data-tab="Search"]`; type `needle` into the search field; read grid.
  4. Click a grid slot (`creative0`) then `data-slot="hotbar0"`; close (`Escape`, `ensureLocked`).
- **Pass criteria:** (a) `data-tab` present for ALL 12 labels: `Building Blocks, Colored Blocks, Natural Blocks, Functional Blocks, Redstone Blocks, Tools & Utilities, Combat, Food & Drinks, Ingredients, Spawn Eggs, Operator Utilities, Search` (empty tabs allowed, buttons must exist); (b) Tools & Utilities shows ≥ 15 entries, ALL satisfying the membership predicate: def has `tool.class` OR id ∈ the enumerated utility set `{handloom, mending_needle, binding_needle, saddle_frame, everthread_needle, mothdust_poultice}` (the untiered utility items of items.json) — zero plain building blocks; Building Blocks contains `planks, cobblestone, glass, raw_skein`; (c) search `needle` returns ≥ 5 and every result's stringId or displayName matches `/needle/i`; (d) the picked item lands in hotbar slot 0 (`getHotbar()[0]` non-null).
- **Screenshot:** `qa/W5/QA-W5-02-creative-tabs.png`

#### QA-W5-03 — P1 core building blocks incl. wool (raw_skein)
- **Verifies:** P1-4-5
- **Gate:** caps `items`
- **Steps:**
  1. `W5S`. `give('raw_skein', 4)`; `give('planks', 4)`; `give('glass', 4)`; `give('cobblestone', 4)`.
  2. For each, select its slot (`Digit1..Digit4`), aim at surface cell `(3+i, 61, 3)` top face via `aimAt`/`setLook`, right-click to place. Read `getBlock` at each target.
  3. `give('needle_iron_shears', 1)`; select; hold LMB on the placed raw_skein until broken; `recordTicks(30)` spanning the break.
- **Pass criteria:** (a) all four place: `getBlock` returns `raw_skein / planks / glass / cobblestone`; survival placement decremented each stack (count 4→3); (b) raw_skein with shears breaks in `ceil(0.8·30/5) = 5 ± 1` gt and drops a `raw_skein` item entity (appears in `recordTicks` `itemEntities`); (c) `getBlockDef('raw_skein').hardness === 0.8`.
- **Screenshot:** `qa/W5/QA-W5-03-core-blocks-wool.png`

#### QA-W5-04 — Tool material table: durability/speed per tier (break-time ladder)
- **Verifies:** P1-7-1
- **Gate:** caps `items`
- **Steps:**
  1. `W5S`. For each `m ∈ [knotwood, threadstone, needle_iron, giltspool, dawnthread, everthread]` read `getItemDef(m + '_pickaxe')` — giltspool expected ABSENT (no recipes/def; annotate, don't FAIL, unless the builder chose to register it dataonly).
  2. For each existing tier pickaxe: `give(id, 1)`, select, aim at a fresh stone cell `(6, 61, −2−k)`, hold `page.mouse.down()` until `getBlock(...) === 'air'`, measuring ticks via `recordTicks` (first `breakProgress > 0` → block air).
  3. Bare hand on stone: same measurement, and check drop.
- **Pass criteria:** (a) def table exact (`durability`/`tool.miningSpeed` — declared §2.2 fields): knotwood 59/2.0, threadstone 131/4.0, needle_iron 250/6.0, dawnthread 1561/8.0, everthread 2031/9.0; `tool.tier` (= P1-7-1's harvestTier; one field, §2.2) 1/2/3/4/4; (b) measured stone (hardness 1.5) break ticks: knotwood `23 ± 1`, threadstone `12 ± 1`, needle_iron `8 ± 1`, dawnthread `6 ± 1`, everthread `5 ± 1`; (c) bare hand: `150 ± 3` gt (canHarvest false → 100 divisor) and **no** item entity spawns (wrong tool = no drop).
- **Screenshot:** `qa/W5/QA-W5-04-tier-ladder.png`

#### QA-W5-05 — Tool classes, effective blocks, harvest-tier gating, drop table
- **Verifies:** P1-7-2 (+ drop-table half of P1-8-15 spawn sources)
- **Gate:** caps `items`
- **Steps:**
  1. `W5S`. Stage blocks on the platform via `setBlock`: `log(4,62,4), dirt(6,62,4), coal_ore(8,62,4), diamond_ore(10,62,4), leaves(12,62,4)`.
  2. `give('knotwood_axe',1)` → break log (measure ticks); `give('knotwood_spade',1)` → break dirt; bare hand → break a second dirt.
  3. `give('threadstone_pickaxe',1)` → break diamond_ore (tier 2 < harvestTier 3); then `give('needle_iron_pickaxe',1)` → break a re-placed diamond_ore. Break coal_ore with the needle_iron pickaxe.
  4. If `getCaps()` includes `moveBlocks` (W2): `setBlock(14,62,4,'cobweb')`; break with `knotwood_blade` and measure.
- **Pass criteria:** (a) axe on log (hardness 2.0): `ceil(2·30/2)=30 ± 1` gt; spade on dirt (0.5): `8 ± 1` gt vs bare hand `15 ± 1` gt; (b) diamond_ore with threadstone pick: slow path `ceil(3·100/4)=75 ± 2` gt AND no drop; with needle_iron pick: `ceil(3·30/6)=15 ± 1` gt AND drops item `dawnthread` ×1; coal_ore drops `emberskein` ×1; (c) drop identities: log→`log`, dirt→`dirt`, stone→`cobblestone` (from QA-W5-04 run), leaves→NO item entity (delta: no sapling item); (d) cobweb with blade breaks ≤ 3 gt (15× multiplier) — else `SKIPPED-GATED (moveBlocks)`.
- **Screenshot:** `qa/W5/QA-W5-05-tool-classes.png`

#### QA-W5-06 — Attack damage & speed per tool
- **Verifies:** P1-7-3
- **Gate:** caps `items` + `survival` (W2's `spawnTestDummy`, `getAttackCooldown`)
- **Steps:**
  1. `W5S`. `__qa.tp(1.0, 61, 0.5)`.
  2. For each `w ∈ [knotwood_blade(4), needle_iron_blade(6), everthread_blade(8), needle_iron_axe(9), needle_iron_pickaxe(4), needle_iron_spade(4.5)]`: `__qa.removeTestDummies()`; `const id = __qa.spawnTestDummy(3.5, 61, 0.5)` (a FRESH hp-20 dummy per weapon — dummies have no hp-reset mutator, and the six deltas sum to 35.5 > 20, so a single dummy would die mid-ladder); re-aim at the dummy; give+select w, wait `getAttackCooldown() ≥ 0.999` (full charge), single LMB click, read the fresh dummy's hp delta (W2's dummy hp hook), wait 1.5 s before the next weapon.
  3. Timing: with `needle_iron_blade` held, click twice 200 ms apart; sample `getAttackCooldown()` recovery slope.
- **Pass criteria:** (a) full-charge damage exact per table (±0 — integers/halves, dummy has no armor): blade 4/6/8, axe 9, pickaxe 4, spade 4.5; (b) `getItemDef` attackSpeed: blade 1.6, axe 0.9 (needle_iron), pickaxe 1.2, spade 1.0 — cooldown recovery time `1/attackSpeed` s ± 10%; (c) the 200 ms second click lands partial damage per W2's `×(0.2 + t²·0.8)` (cross-checked, not re-derived).
- **Screenshot:** `qa/W5/QA-W5-06-attack-table.png`

#### QA-W5-07 — Durability consumption & tool break
- **Verifies:** P1-7-4
- **Gate:** caps `items`
- **Steps:**
  1. `W5S`. `give('knotwood_pickaxe', 1)` (durability 59); select. Mine 10 stone cells; read `getHeldItem().damage` after each.
  2. `give('knotwood_blade', 1)`; break 3 dirt blocks with it; read damage.
  3. Hit the W2 test dummy 2× with the blade (full charge, 1.5 s apart); read damage.
  4. Set a nearly-broken pickaxe: mine stone with the knotwood pickaxe until `damage === 58`, then mine one more.
  5. If caps include `survival`: `__qa.setArmor`-free check — equip a `needle_iron_mail` via the inventory screen armor slot (`data-slot="armor.chest"`), `__qa.hurt(8,'melee')` (W2 hook), read the armor stack's damage.
- **Pass criteria:** (a) mining: +1 damage per block, exactly 10 after step 1; (b) blade block-break: +2 per block (damage 6 after 3 dirt); (c) blade entity hit: +1 per hit; (d) at damage == max the stack is DESTROYED — `getHeldItem() === null` and slot empty (no negative-durability ghost); (e) armor: +1 damage per 4 dmg absorbed (8-dmg hit → +2); (f) Unbreaking/Mending: annotate `dormant — no enchantments (P2)`, never FAIL.
- **Screenshot:** `qa/W5/QA-W5-07-durability.png`

#### QA-W5-08 — Break-time accumulator + destroy-stage overlay + outline
- **Verifies:** P1-27-1
- **Gate:** caps `items`
- **Steps:**
  1. `W5S`. `give('knotwood_pickaxe',1)`; aim at stone `(5, 61, 0)` top face; confirm `getTargetedBlock().pos` equals `[5,61,0]`.
  2. `page.mouse.down()`; sample every tick via `recordTicks(30)` + poll `getBreakOverlay()` each 2 gt; screenshot at ~50% progress; keep held until break.
  3. Re-aim at a second stone; `mouse.down()` for 10 gt then `mouse.up()` (release early); wait 5 gt; read `getBreakProgress()` + `getBreakOverlay()`.
  4. `setGameMode('creative')`; LMB a stone block once.
- **Pass criteria:** (a) `getBreakProgress()` ramps monotonically 0→1 over `23 ± 1` gt; `getBreakOverlay().stage === floor(progress·10)` at every sample (0→9, never decreasing, pos always `[5,61,0]`); overlay null after break; (b) block outline: the existing wireframe (main.js `S.outline`) is visible and positioned on the targeted cell in the mid-break screenshot (pixel check: ≥ 40 near-black edge pixels — defined mechanically as rec-709 luminance < 40/255 AND every channel < 60/255 — along the cell's projected edges in a 200×200 crop centered on the block); `getBreakOverlay().face` matches the aimed face (`'+y'`); (c) early release resets: progress back to 0 and overlay null within 2 gt, block intact; (d) creative: block gone in ≤ 3 gt with NO overlay stages (instant path preserved) and no item entity dropped.
- **Screenshot:** `qa/W5/QA-W5-08-destroy-stages.png`

#### QA-W5-09 — Item entity physics: spawn, gravity/bob, merge, pickup delay
- **Verifies:** P1-8-15
- **Gate:** caps `itemEntities`
- **Steps:**
  1. `W5S`. Break stone `(5,61,0)` with a pickaxe; immediately `const s = await page.evaluate(() => __qa.recordTicks(40))` capturing the `itemEntities` channel; stand 3 blocks away (`tp(8.5,61,0.5)` first so no pickup).
  2. Pickup delay: `tp(5.5, 61, 0.5)` (stand on the drop) as soon as the entity exists; from `recordTicks`, find the tick the entity vanishes and `heldCount` increments.
  3. Merge: `tp(0.5,61,0.5)`; `give('cobblestone', 10)`; press `KeyQ` twice, 500 ms apart, aiming at the same spot (`setLook` fixed).
- **Pass criteria:** (a) exactly one item entity `cobblestone ×1` spawns within 0.5 of `(5.5, 61.5, 0.5)`; its vel.y goes negative (gravity −16 b/s² ± 20% over the first 5 airborne ticks) and it settles resting on y≈61 (bob allowed ±0.1, no tunneling); (b) pickup occurs at `10 ± 2` gt after spawn (pickupDelay 10 gt for break drops), `heldCount`/hotbar gains 1; (c) the two Q-dropped entities MERGE within 20 gt into ONE entity with `count === 2` (positions within 0.5 blocks); `getEntities('item').length` decreases by 1 at merge; merged stack never exceeds `maxStack`.
- **Screenshot:** `qa/W5/QA-W5-09-item-entity-physics.png`

#### QA-W5-10 — Item entity hazards + despawn clock
- **Verifies:** P1-8-15
- **Gate:** caps `itemEntities`
- **Steps:**
  1. `W5S`. Cactus: `setBlock(10,61,4,'cactus')`; `give('dirt',1)`; stand at `(8.5,61,4.5)`, aim at the cactus, `KeyQ` (toss lands against it).
  2. Lava: `setBlock(12,60,−4,'lava')` in a dug pit (`setBlock(12,61,−4,'air')` first); toss a dirt item into the pit.
  3. Water float: pit at `(14,60,−4)` filled `water`; toss dirt in; sample entity pos.y for 40 gt.
  4. Despawn: toss one dirt on open ground; note its entity id; `__qa.qaAgeItemEntity(id, 5990)`; poll `getEntities('item')` for 20 gt.
- **Pass criteria:** (a) cactus contact destroys the entity within 10 gt of contact (no pickup, count of item entities returns to baseline); (b) lava contact destroys within 10 gt; (c) in water the entity FLOATS: settles with pos.y ≥ 60.3 (above pit floor 60) and |vel.y| < 0.5 b/s after 20 gt — flow-drift annotated `N/A — static liquids (fluids wave)`; (d) despawn: entity vanishes within `10 ± 4` gt of aging to 5990 (6000 gt lifetime), no pickup event; hoppers/explosions annotated `N/A — P2 / W8 absent`.
- **Screenshot:** `qa/W5/QA-W5-10-item-hazards.png`

#### QA-W5-11 — Q-drop, Ctrl+Q, drag-outside, pickup space rules
- **Verifies:** P1-8-16 (+ P1-8-15 pickup-when-space clause)
- **Gate:** caps `itemEntities`
- **Steps:**
  1. `W5S`, `ensureLocked`. `give('cobblestone', 5)`; select; `__qa.setLook(270, 0)` (facing +X). Press `KeyQ`.
  2. `keyboard.down('ControlLeft')`; press `KeyQ`; `keyboard.up('ControlLeft')`.
  3. Drag-outside: `give('dirt', 7)`; `KeyE` (inventory screen); click `[data-slot="hotbar1"]` (dirt to cursor — `getCursorStack()` = dirt×7); click at viewport (60, 360) (outside the panel); `Escape`; `ensureLocked`.
  4. Space rules: fill the inventory — loop `give('stone', 64)` until `getHotbar()` + `main9..35` all full (36 × stone×64 minus the test slots; top up others with distinct full stacks); break one placed stone (drop cobblestone — no space); wait 80 gt; then Ctrl+Q the held full stone stack (frees a slot) and observe.
- **Pass criteria:** (a) Q: ONE entity `cobblestone ×1`, launch velocity has `vel.x ≥ 2` b/s (along facing, yaw 270 = +X per §1.2) and `vel.y > 0`; held count 5→4; NOT re-picked before `40 ± 4` gt (toss pickupDelay), re-picked after (stand still); (b) Ctrl+Q: ONE entity with the ENTIRE remaining count, held slot → null; (c) drag-outside: cursor stack `dirt ×7` becomes one tossed entity, cursor empty; (d) full inventory: the cobblestone drop is NOT picked up for ≥ 60 gt while overlap persists; after Ctrl+Q frees a slot, PARTIAL pickup is honored — if the freed capacity is smaller than an entity's count, the entity remains with the remainder (assert inventory gains exactly the fitting amount and `getEntities('item')` still contains the remainder entity).
- **Screenshot:** `qa/W5/QA-W5-11-qdrop.png`

#### QA-W5-12 — 2×2 crafting grid + recipe book + bootstrap chain
- **Verifies:** P1-6-1, P1-6-2 (2×2 half)
- **Gate:** caps `crafting`
- **Steps:**
  1. `W5S` (fresh world — recipe book empty). Read `getRecipeBook()` baseline. `give('raw_skein', 1)`; read again. Persistence probe: `page.reload()` → rejoin `qa-w5` via the menus → `ensureLocked` → read `getRecipeBook()` a third time.
  2. `KeyE`; click `[data-slot="hotbar0"]` (pick raw_skein), click `[data-slot="craft0"]` (place); read `getInventorySlot('craftResult')`.
  3. Click `[data-slot="craftResult"]` (take result), place into `main9`; repeat the craft loop to bank 4 `loose_thread`; then fill `craft0..craft3` with one loose_thread each; take result.
  4. Bootstrap: `give('planks', 3)`; arrange the handloom 2×2 override (`craft0=planks, craft1=raw_skein` — give one more — `craft2=planks, craft3=planks`); take result. Toggle the recipe book's "craftable only" filter and read the visible list.
- **Pass criteria:** (a) unlock: baseline `unlockedCount` small/0; after `give('raw_skein')` it increases (ingredient-based unlock), and the post-reload read (step 1's persistence probe) returns the SAME `unlockedCount` (localStorage `loomfall.recipes.<worldId>`); (b) raw_skein 1×1 in the 2×2 → `craftResult` = `loose_thread` (count per recipe); taking the result consumes the grid cell; (c) 4× loose_thread in 2×2 → `woven_cloth ×1` (the shape fills the whole 2×2 grid, so offset-invariance is not assertable here; QA-W5-13 asserts it at the 3×3's corner offsets); (d) the 2×2 bootstrap yields `handloom ×1` (`qaContentReport().localOverrides` includes it); (e) "craftable only" filter: with the current inventory, `craftableNow` from `getRecipeBook()` matches exactly the recipes shown filtered.
- **Screenshot:** `qa/W5/QA-W5-12-craft-2x2.png`

#### QA-W5-13 — 3×3 handloom: shaped offsets, mirroring, shapeless
- **Verifies:** P1-6-2, P1-6-3, P1-4-6 (handloom block)
- **Gate:** caps `crafting`
- **Steps:**
  1. `W5S`. `give('handloom', 1)`; place at `(4, 62, 2)` (aim at `(4,61,2)` top face); right-click the placed handloom (NOT sneaking).
  2. Shapeless: `give('log', 2)`; place ONE log in `craft4` (center) → read result; take it; place the other log in `craft8` (corner) → read result.
  3. Shaped + offset: `give('loose_thread', 8)`; place `woven_cloth`'s 2×2 shape in the TOP-LEFT of the 3×3 (`craft0,craft1,craft3,craft4`), read result; clear; repeat at BOTTOM-RIGHT (`craft4,craft5,craft7,craft8`), read result.
  4. Mirror: `give('planks', 10)`; lay `knotwood_axe` canonical shape (`craft0,craft1,craft3,craft4,craft7` = plank,plank,plank,plank,plank per the items.json shape) → result; clear; lay the HORIZONTAL MIRROR (`craft1,craft2,craft4,craft5,craft7`) → result.
  5. Tier recipe: `give('cobblestone', 3)` + planks: lay `threadstone_pickaxe` (top row cobblestone ×3 via the `#threadstone` tag, middle+bottom center planks) → result. Sneak-place check: hold `ShiftLeft` and right-click the handloom with planks held.
- **Pass criteria:** (a) right-click opens the 3×3 screen (`data-slot craft0..craft8` + `craftResult` present; `getScreen()` non-null); (b) shapeless log → `planks ×4` from BOTH cell positions; (c) shaped woven_cloth matches at BOTH offsets (position-relative), result identical; (d) axe matches in BOTH chiralities (mirrorable), result `knotwood_axe ×1` each; (e) `#threadstone` tag: cobblestone satisfies the threadstone cells → `threadstone_pickaxe ×1`; (f) sneak + right-click on the handloom PLACES the held block instead of opening (vanilla precedence).
- **Screenshot:** `qa/W5/QA-W5-13-craft-3x3.png`

#### QA-W5-14 — Furnace: smelt timing, fuel table, lit state, XP bank, lava bucket
- **Verifies:** P1-6-4, P1-6-5, P1-6-6, P1-4-6 (furnace)
- **Gate:** caps `containers`
- **Steps:**
  1. `W5S`. `give('furnace',1)`; place at `(6, 62, −2)`. `await __qa.qaSetContainerSlot(6,62,−2, 0, 'sand', 3)` (input); `qaSetContainerSlot(6,62,−2, 1, 'emberskein', 1)` (fuel).
  2. Poll `getFurnace(6,62,−2)` every 10 gt for 700 gt; also `getBlock(6,62,−2)` at 100 gt.
  3. After all 3 smelt: right-click the furnace, shift-click the output slot (`data-slot="c2"`); read `getFurnace().xpBanked` before/after and (caps `survival`) W2's `getXpOrbs()`.
  4. Fuel table: fresh furnace at `(8,62,−2)`; `qaSetContainerSlot(…,1,'planks',1)` + input sand ×2 → observe; then `qaSetContainerSlot(…,1,'lava_bucket',1)` + input `iron_ore` ×2.
- **Pass criteria:** (a) cookProgress ramps 0→1 in `200 ± 4` gt per item; 3 sand → `glass ×3` in output ≈ 600 gt total; (b) lit: `getBlock` returns `furnace_lit` while burning and reverts to `furnace` within 20 gt of finishing; `getFurnace().lit` agrees; (c) emberskein `fuelTotalGt = 1600` (8 items — after 3 sand, `fuelRemainingGt ≈ 1000 ± 20`, still burning idle or stopping per builder's idle rule — assert remaining value only); (d) XP: `xpBanked ≈ 0.1·3 = 0.3 ± 0.001` before collect; on collect it grants floor(0.3)=0 orbs and RETAINS the 0.3 fraction OR grants on threshold — assert the invariant `banked_before − banked_after === orbs_granted` and total accumulation continues (smelt 7 more sand → cumulative 1.0 → exactly 1 XP granted at the next collect); iron_ore smelt yields `needle_iron` with xp 0.7/item; (e) planks fuel smelts exactly 1.5 items' worth (second sand stalls at cookProgress ≈ 0.5 when fuel dies, `300 ± 8` gt of burn); (f) lava_bucket: `fuelTotalGt = 20000` and the fuel slot becomes item `bucket` when consumed.
- **Screenshot:** `qa/W5/QA-W5-14-furnace.png`

#### QA-W5-15 — Chest 27 / double 54, sidecar store, spill, persistence
- **Verifies:** P1-26-1, P1-4-10, P1-4-6 (chest)
- **Gate:** caps `containers`
- **Steps:**
  1. `W5S`. `give('chest', 2)`; place chest A at `(10, 62, 2)`. Right-click → count `[data-slot^="c"]` slots. `qaSetContainerSlot(10,62,2, 0, 'cobblestone', 17)`; `qaSetContainerSlot(10,62,2, 26, 'emberskein', 3)`; close.
  2. `const be = await page.evaluate(() => __qa.getBlockEntity(10,62,2))`.
  3. Place chest B at `(11, 62, 2)` (adjacent); right-click either → count slots; put `glass ×5` into slot c30 via clicks (pick from hotbar after `give('glass',5)`); close.
  4. Persistence: quit to title (Escape → Quit per `ui/menu.js`), re-enter `qa-w5`; wait `isColumnLoaded(10,2)`; read `getBlockEntity` for both chest positions.
  5. Spill: mine chest A with an axe; sample `getEntities('item')` + `getBlockEntity(10,62,2)`.
- **Pass criteria:** (a) single chest = exactly **27** container slots; (b) sidecar record: `be.type === 'chest'`, `be.data.slots[0] = {id:'cobblestone', count:17}`, `slots[26] = {id:'emberskein', count:3}` — keyed at `'10,62,2'`; (c) adjacent pair opens as ONE window with **54** slots; the c30 glass persists in whichever record owns it (re-open shows glass ×5 at the same window index) — if double-chest slipped per plan, report `PARTIAL: single-27 ok, double pending`, not FAIL; (d) after reload, both records round-trip exactly — persisted via the `bedit` WS-frame path into `saves/<id>.json` and delivered back through `welcome.world.blockEntities` (the hardened server has NO REST write endpoint: `PUT /api/worlds/:id` was removed for security and returns 404 per docs/PROTOCOL.md §7 — do not reintroduce it for this test); (e) breaking chest A spills item entities totalling `cobblestone ×17 + emberskein ×3` within 1.5 blocks, and `getBlockEntity(10,62,2) === null`.
- **Screenshot:** `qa/W5/QA-W5-15-chest-sidecar.png`

#### QA-W5-16 — mobDrop → ItemEntity + loot-id reconciliation live
- **Verifies:** P1-8-15 (mob-death spawn source) + the cluster-A reconciliation
- **Gate:** caps `itemEntities` + `mobs` (W3 hooks)
- **Steps:**
  1. `W5S`, noon (`setTime(6000)`), `__qa.setMobSpawning(false)`; `__qa.clearMobs()`.
  2. `const id = await __qa.spawnMob('grazer', 4, 61, 4)`; `__qa.hurtMob(id, 99, 'player')`; within 40 gt read `__qa.getMobEvents(10)` and `getEntities('item')`.
  3. For each `a ∈ ['emberspinner', 'exploder', 'screecher', 'raveler']`: `const e = await __qa.spawnMob(a, 8, 61, 4)`; `__qa.hurtMob(e, 99, 'player')`; read events + items (repeat up to 5 spawns per archetype if the chance roll misses — `mobs/lootTables.js` chances: scorched_silk 0.75, tallowstone 0.5, cinderthread 0.4, voidknot 0.2).
- **Pass criteria:** (a) grazer death: for every `mobDrop` event emitted (`public/src/mobs/MobManager.js`), a matching item entity exists within 20 gt, `itemId === 'raw_skein'`, pos within 1.5 of death pos, count matching the event; the item is pickup-able (walk over → inventory gains raw_skein, a PLACEABLE block id); (b) the naming.json-block loot ids resolve to registered items: emberspinner drops carry `scorched_silk` NATIVELY (`mobs/lootTables.js` emits the canonical id — no alias step exists to test), and exploder→`tallowstone`, screecher→`cinderthread`, raveler→`voidknot` each spawn an item entity whose `itemId` is a registered registry entry (scaldwarden's `emberskein_ore` is covered by the QA-W5-01 registry read); (c) `qaContentReport().unresolvedLootIds === []` in the live session; (d) zero console errors mentioning `itemId` or `undefined` across all kills.
- **Screenshot:** `qa/W5/QA-W5-16-mob-drops.png`

#### QA-W5-17 — Container sync across two clients (`bedit` relay)
- **Verifies:** P1-4-10 (sync/persistence half), P1-26-1 (shared containers)
- **Gate:** caps `containers` + a second Playwright page (QA_PLAN §S9 pattern; same world id)
- **Steps:**
  1. Client 1: `W5S` on world `qa-w5-mp`. Place a chest at `(10,62,2)`; `qaSetContainerSlot(10,62,2, 0, 'cobblestone', 12)`.
  2. Client 2: second page/context joins `qa-w5-mp` (same dimension); `tp(12.5,61,2.5)`; wait `isColumnLoaded(10,2)`; read `getBlockEntity(10,62,2)`; open the chest via right-click and read `getInventorySlot('c0')`.
  3. Client 2 edits slot c1 to `dirt ×4` (`qaSetContainerSlot`); Client 1 reads `getBlockEntity` after ≤ 1 s.
  4. CDP frame sniff on either client (§1.9): capture WS frames during steps 1–3.
- **Pass criteria:** (a) Client 2 sees Client 1's chest contents (`c0 = cobblestone ×12`) without rejoining — `bedit` broadcast applied; (b) Client 1 sees Client 2's `dirt ×4` within 1 s (relay latency, LAN); (c) sniffed frames include `{t:'bedit', x:10, y:62, z:2, dim:'overworld', data:…}` and NO echo back to the sender (matches the `edit` semantics in `server/index.js`/docs/PROTOCOL.md); (d) known delta annotated: concurrent same-slot writes are last-writer-wins (client-authoritative) — record, don't FAIL.
- **Screenshot:** `qa/W5/QA-W5-17-bedit-sync.png`

---

## W6 acceptance tests — Weather, day/night gt-time, sleeping, biome atmosphere, sound & particles (bridge to feature/weather)

Harness per QA_PLAN.md §1 (Playwright + `?qa=1`, viewport 1280×720, `ensureLocked` after every screen close, **1 game tick = 50 ms**, fixtures §1.7). Staging uses `WORLD_B` (creative, cheats ON) unless stated; at pre-W7 merge states construct it per the **WORLD_B staging recipe** in the W3 header (`POST /api/worlds {name, seed}` only — gamemode/cheats/gamerules-at-creation are W7 features; `doDaylightCycle=false` is set post-join via `setGameRule`, a W6 hook, so "WORLD_B is created doDaylightCycle=false" holds only from W7 onward); W6 tests that need the daylight cycle RUNNING re-enable it via the new `setGameRule` hook. Block ids in assertions are the `__qa` string names the shim maps from the numeric registry (`public/src/blocks/blocks.js` + W6 appends): `stone`=3, `water`=8, `glowstone`=24, and nominally `bed`=52, `bed_occupied`=53, `respawn_anchor_0..4`=54..58 (per-wave ledger numbers — tests assert by NAME only). **MAX_BLOCK_ID precondition:** ids 52–58 exceed the server's `MAX_BLOCK_ID = 40` (`server/index.js` `validBlockId`, ws `edit` handler — ids > 40 are rejected), so bed/anchor blocks can neither persist nor replicate until the registrar's one-time bump to 255 (P1_WORKPLAN Cluster-B resolution; practical ceiling 254 — W7's dense-store sentinel is 255) ships; QA-W6-10/13 and every W6 block-persistence assert carry that bump as an explicit applicability precondition. **New QA DOM contract (additive, §1.5 style):** subtitle overlay root `#subtitles` inside `#hud-root`, stamped by W6's audio work (one child entry per active subtitle) — QA-W6-14(e) reads it. Real-world constants: height 128, `SEA_LEVEL 40` (parity delta vs spec 384/63); day = 24000 gt = 1200 s wall. Time semantics after W6: `__qa.getWorldTime()` ≡ `dayTime`, `__qa.getGameTick()` ≡ `gameTime`, `__qa.setTime(t)` sets **dayTime** only. Phase mapping (plan delta 5): `timeOfDay01 = (dayTime/24000 + 0.25) % 1`.

**New `__qa` hooks & cap tokens for this wave:** consolidated in §2 above (per-wave block **W6** in §2.3 + cap-token table §2.4); the signatures there are normative, including the conflict resolutions of §2.1.

Existing hooks reused throughout: `setTime`, `getWorldTime`, `getGameTick`, `getBiome`, `getBlock`, `setBlock`, `tp`, `give`, `getPose` (value `'sleeping'`), `getChatLog`, `setSetting` (new keys `sound.master|music|record|weather|block|hostile|neutral|player|ambient|voice`, `sound.subtitles`, `video.particles`), `getAudio`, `getAudioRms`, `getTargetedBlock`, `setLook`, `isColumnLoaded`; W3 hooks `spawnMob/clearMobs/setMobSpawning/runSpawnCycle` where gated on `mobs`.

**Common staging `STAGE_SKYLAB`:** WORLD_B → `setMobSpawning?.(false); clearMobs?.()` (if `mobs` cap) → `__qa.tp(0,120,0)` → stone platform `setBlock(x,99,z,'stone')` for x,z∈[−16..16], clear air y∈[100..104] → `__qa.tp(0,100,0)` → `waitForFunction(() => __qa.isColumnLoaded(0,0))` → `ensureLocked(page)`. Biome hunt helper `findBiome(name)`: scan `__qa.getBiome(x, 64, z)` on a 64-block grid spiral (x,z up to ±2048) until match; `tp` there and wait `isColumnLoaded`.

---

#### QA-W6-01 — Day = 24000 gt; anchor times drive the sky phase
- **Verifies:** P1-18-1
- **Gate:** caps `gtTime`
- **Steps:**
  1. `STAGE_SKYLAB`; `__qa.setGameRule('doDaylightCycle', true)`; if `getCaps()` includes `weather`: `__qa.setWeather('clear')` (visual determinism — `setWeather` is gated `weather` (§2.3 W6) and this test's gate is only `gtTime`, so the call MUST be cap-conditional; without the weather cap there is no weather darkening to clear).
  2. For each `t ∈ [0, 6000, 12000, 13000, 18000, 23000]`: `__qa.setTime(t)`; wait 5 frames; record `getTimeState()` and `getSkyState().backgroundHex` (compute rec-709 luma).
  3. Rate check: `__qa.setTime(3000)`; `d0 = getWorldTime()`; wait 10 000 ms wall; `d1 = getWorldTime()`.
- **Pass criteria:** (a) `timeOfDay01` = 0.25 / 0.50 / 0.75 / ~0.7917 / 0.00 / ~0.2083 at the six anchors (each ±0.002); (b) luma(6000) ≥ 0.55; luma(18000) ≤ 0.10; luma(12000) between them (dusk); (c) `hostileNight` false at 0/6000/12000, true at 13000 and 18000, false at 23000 (window [13000,23000)); (d) `d1 − d0 = 200 ± 10` gt (20 gt/s at 50 ms/gt — the 24000 gt day is 1200 s wall; plan delta 4 vs the old `DAY_LENGTH_S=600`).
- **Screenshot:** `qa/W6/QA-W6-01-gt-anchors.png` (noon frame, F3 open)

#### QA-W6-02 — gameTime/dayTime split; doDaylightCycle freezes dayTime only
- **Verifies:** P1-18-2
- **Gate:** caps `gtTime`
- **Steps:**
  1. `STAGE_SKYLAB`; `setGameRule('doDaylightCycle', false)`; `t0 = getTimeState()`; wait 5000 ms; `t1 = getTimeState()`.
  2. `setGameRule('doDaylightCycle', true)`; `t2 = getTimeState()`; wait 5000 ms; `t3 = getTimeState()`.
  3. `g = getGameTick(); __qa.setTime(5000)`; `t4 = getTimeState()`.
- **Pass criteria:** (a) frozen: `t1.dayTime === t0.dayTime` exactly, while `t1.gameTime − t0.gameTime = 100 ± 10`; (b) running: `t3.dayTime − t2.dayTime = 100 ± 10` AND `t3.gameTime − t2.gameTime = 100 ± 10`; (c) `setTime` sets dayTime only: `t4.dayTime = 5000 ± 2` and `t4.gameTime − g ≤ 5` (gameTime never set/reset).
- **Screenshot:** `qa/W6/QA-W6-02-time-split.png`

#### QA-W6-03 — skyDarken 0→11 curve; night sky light ≈ 4; hostile check stays block-light-only
- **Verifies:** P1-18-3
- **Gate:** caps `gtTime` (sub-check 3 additionally caps `mobs`)
- **Steps:**
  1. `STAGE_SKYLAB`; `setGameRule('doDaylightCycle', false)`. For each `t ∈ [6000, 11000, 12040, 12800, 13670, 15000, 18000, 22330, 23000, 23961]`: `setTime(t)`; read `getTimeState().skyDarken`.
  2. Monotonicity sweep: sample skyDarken at 100-gt steps over [12000, 14000] and [22300, 24000].
  3. (gate `mobs`) Noon `setTime(6000)`; build a sealed opaque room 26–40 blocks away (QA-W3-11 geometry), no emitters; `runSpawnCycle(600)`.
- **Pass criteria:** (a) skyDarken exact 0 at 6000/11000/23961, exact 11 at 13670/15000/18000/22330; 12800 → 5 ± 1; 23000 → 6 ± 1; (b) dusk sweep is non-decreasing, dawn sweep non-increasing, no step > 2 between adjacent samples; effective night sky light = 15 − 11 = **4** (assert the constant relation, this is what W3's `spawnLightAt` sky term consumes); (c) hostile spawns occur inside the dark room at NOON (block light 0 wins; skyDarken irrelevant indoors — 1.18+ block-light-only rule); annotate `light-seam-heuristic` per W3.
- **Screenshot:** `qa/W6/QA-W6-03-skydarken.png` (dusk frame)

#### QA-W6-04 — Weather state machine durations + /weather surface + doWeatherCycle
- **Verifies:** P1-18-4
- **Gate:** caps `weather` + `gtTime`
- **Steps:**
  1. `STAGE_SKYLAB`; `setGameRule('doWeatherCycle', true)`; `const r = __qa.advanceWeather(1_500_000)` (fast-forward; ≥ 7 full cycles even at max durations).
  2. From `r.transitions` compute every span: clear runs, rain runs, and thundering sub-spans.
  3. `await __qa.setWeather('rain')`; read `getWeather()` immediately and after 3 s. Then `await __qa.setWeather('thunder')`; then `await __qa.setWeather('clear')`.
  4. `setGameRule('doWeatherCycle', false)`; `u0 = getWeather().untilChangeGt`; wait 3000 ms; `u1 = getWeather().untilChangeGt`.
  5. Two-client sync: open a second page/context joined to the same world (QA S9 pattern); compare `getWeather()` on both.
- **Pass criteria:** (a) every clear span ∈ [12000, 180000] gt, every rain span ∈ [12000, 24000] gt, every thunder sub-span ∈ [3600, 15600] gt and only while raining; ≥ 3 rain spans observed; (b) `setWeather('rain')` → `state:'rain'`, `raining:true`, `packageState ∈ {'rain','snow'}`, `epoch` incremented by 1; `'thunder'` → `thundering:true`, `packageState:'storm'`; `'clear'` → all off; (c) freeze: `u1 === u0` exactly with cycle off; (d) both clients report identical `state/epoch` and `untilChangeGt` within 40 gt (deterministic machine + `{t:'time'}` sync; no weather protocol frames — plan delta 1).
- **Screenshot:** `qa/W6/QA-W6-04-weather-machine.png`

#### QA-W6-05 — Rain visuals, biome/dimension gating, `isRainingAt`, single sky/fog owner
- **Verifies:** P1-18-5 (+ the plan's delta-6 ownership resolution)
- **Gate:** caps `weather` + `biomeColors`
- **Steps:**
  1. `findBiome('plains')`; stand under open sky; pin the aim (`__qa.setLook(270, 10)` — held fixed for every capture in this test); `await __qa.setWeather('clear')`; wait 2 s; capture the CLEAR-weather baseline screenshot of the horizon region; then `await __qa.setWeather('rain')`; wait 3 s; capture the same aim again.
  2. Read `isRainingAt` at: own feet (open sky); a cell under a 3×3 stone roof built at y+6; a cell at y=20 under terrain.
  3. `findBiome('desert')`; wait 5 s; read `getWeather().intensity`. Then `findBiome('snowy_plains')` (fallback: the 8-biome shim's `snow`); wait 5 s; read `packageState`.
  4. Ownership stability: back in plains rain, record `getSkyState().backgroundHex/fogHex` every frame for 120 frames.
  5. (cap `nether`) `__game.setDimension('nether')`; read `intensity`.
- **Pass criteria:** (a) plains: `intensity ≥ 0.4` and rain streaks visible (screenshot region over the horizon shows ≥ 1% pixel delta vs the step-1 clear-weather baseline of the same pinned aim); (b) `isRainingAt`: true at open-sky feet, **false** under the roof, false at y=20; (c) desert: `intensity ≤ 0.05` while `getWeather().state` stays `'rain'` (biome `has_precipitation=false` gates locally, machine unaffected); snowy biome: `packageState === 'snow'`; (d) over 120 frames no channel of backgroundHex/fogHex changes by > 8/255 between consecutive frames (no two-owner flicker: Sky.js owns background, `updateFog` owns fog — SkyController never constructed); (e) nether: `intensity ≤ 0.05`.
- **Screenshot:** `qa/W6/QA-W6-05-rain-gating.png` (plains rain, F3 open)

#### QA-W6-06 — Lightning: strike promise at flash peak, thunder after light
- **Verifies:** P1-18-4 (strike), P1-29-3 (pairing)
- **Gate:** caps `weather` + `audio`
- **Steps:**
  1. `STAGE_SKYLAB`; `await __qa.setWeather('thunder')`; record `getSoundLog(50)` and poll `getSkyState().flash` at ~16 ms cadence for 30 s wall.
  2. Manual strike: `const s = await __qa.strike()`; immediately sample `getSkyState().flash` for the next 10 frames; then `getSoundLog(10)`.
  3. Far strike: `const f = await __qa.strike({ far: true })`; read the following thunder log entry.
- **Pass criteria:** (a) storm auto-strikes: ≥ 2 flash events (`flash ≥ 0.3`) within 30 s (package interval ~4–12 s); each followed ≤ 40 gt later by a `weather.thunder*` entry in the sound log with `category:'weather'`; (b) manual: max sampled `flash ≥ 0.5` around `s.resolvedAtTick`; the thunder log entry has `tick ≥ s.resolvedAtTick` (**light before sound** — promise resolves at flash peak ~90 ms, thunder plays after); (c) far strike thunder entry name is `weather.thunder.distant` with lower `volume` than the near one; (d) background whitens during flash: luma at flash peak ≥ 1.5× the pre-flash storm luma.
- **Screenshot:** `qa/W6/QA-W6-06-lightning.png` (captured within 100 ms of `strike()` resolving)

#### QA-W6-07 — Biome color constants + underwater fog
- **Verifies:** P1-2-7
- **Gate:** caps `biomeColors`
- **Steps:**
  1. `findBiome('plains')`; `c = __qa.getBiomeColors(px, 64, pz)`.
  2. `findBiome('ocean')`; tp so the eye is submerged: `__qa.tp(x, 34, z)` inside water (verify `getBlock(⌊x⌋,36,⌊z⌋)==='water'`; sea fills to y=39, `SEA_LEVEL 40` — code numbers, not spec 63); wait 5 frames; `s1 = getSkyState()`.
  3. Surface: tp to a plains column top; `setSetting('video.renderDistance', 6)`; wait 2 s; `s2 = getSkyState()`.
- **Pass criteria:** (a) defaults exact: `c.fog === '#c0d8ff'`, `c.water === '#3f76e4'`, `c.waterFog === '#050533'` (P1-2-7 verbatim, from `world/gen/colors.js COLOR_DEFAULTS`); (b) submerged: `s1.fogHex` within ±2/channel of `#050533` and `s1.fogFar ≤ 24`; (c) surfaced at rd 6: `s2.fogFar = max(48, 6.5·16) = 104 ± 1` and `s2.fogNear = 57.2 ± 1` (the real `updateFog` formula in `main.js`); `s2.fogHex ≠ s1.fogHex` and each channel lies between `#aad4ff` (`DIMENSIONS.overworld.fog`) and `#c0d8ff` ± 8 (biome blend).
- **Screenshot:** `qa/W6/QA-W6-07-underwater-fog.png` (submerged frame)

#### QA-W6-08 — Sky color = HSV formula of biome temperature
- **Verifies:** P1-2-8
- **Gate:** caps `biomeColors`
- **Steps:**
  1. For each biome b ∈ {plains, desert, snowy_plains (or shim `snow`)}: `findBiome(b)`; read `getBiomeColors(px,64,pz).sky` and the biome's temperature T, pinned by cap: **if `getCaps()` includes `biomes.registry` (W1)** — `T = __qa.getBiomeDef(__qa.biomeAt(px,pz)).temperature` (the W1 registry hook; `getBlockDef` takes BLOCK ids, never biome ids); **else** — the hardcoded in-test table `{plains: 0.8, desert: 2.0, snowy_plains: 0.0}` (the W1 registry values). Record which source was used.
  2. Recompute in the test: `h = 0.62222 − clamp(T/3,−1,1)·0.05; s = 0.5 + clamp(T/3,−1,1)·0.1; v = 1.0` → RGB.
  3. Noon comparison: `setTime(6000)`; capture `getSkyState().backgroundHex` in desert, then in the snowy biome.
- **Pass criteria:** (a) `getBiomeColors(...).sky` equals the recomputed HSV→RGB within ±1/255 per channel for all three biomes; (b) hue ordering holds end-to-end: hue(desert sky) < hue(plains sky) < hue(snowy sky) (temp 2.0 > 0.8 > ~0 pulls hue down); (c) the rendered noon backgrounds differ between desert and snowy by ≥ 4/255 in at least one channel and in the same hue direction (Sky.js `atmo.skyTint` applied against the noon keyframe `(0.52,0.8,0.95)`).
- **Screenshot:** `qa/W6/QA-W6-08-sky-color.png` (side-by-side crops noted in report; single capture = desert noon)

#### QA-W6-09 — Grass/foliage LUT corners + vertex tint + seam smoothing
- **Verifies:** P1-2-9
- **Gate:** caps `biomeColors`
- **Steps:**
  1. `a = __qa.sampleColorLUT('grass', 0, 255)` (warm-dry index: t'=1, d'=0 → x=0, y=255); `b = sampleColorLUT('grass', 255, 255)` (cold-wet: t'=0 → x=255, y=255).
  2. `findBiome('desert')` → `g1 = getBiomeColors(...).grass`; `findBiome('snowy_plains')` → `g2`; verify index math: for the biome's (T,D), `x=(1−clamp(T,0,1))·255, y=(1−clamp(D,0,1)·clamp(T,0,1))·255` and `getBiomeColors().grass === sampleColorLUT('grass', round(x), round(y))`.
  3. Tint in the mesh: at a grass-topped cell in each of the two biomes, `t1/t2 = getVertexTint(x, h−1, z)`; at a stone cell, `getVertexTint` → null.
  4. Border smoothing: locate a biome border (scan `getBiome` along +x until it changes); sample `getVertexTint` at 16 consecutive grass columns crossing it.
- **Pass criteria:** (a) `a` within ±0x10/channel of `#bfb755`; `b` within ±0x10/channel of `#4c7f3d` (P1-2-9 target corners); (b) index equation holds exactly (same texel); (c) `t1 ≠ t2` (per-channel delta ≥ 0.05 somewhere) and each matches its biome's `grass` color × the top-face brightness within ±0.06/channel; stone → null (untinted tile); (d) across the border, consecutive-column tint deltas ≤ 0.12/channel (3×3 radius averaging — no hard chunk-seam pop).
- **Screenshot:** `qa/W6/QA-W6-09-grass-lut.png` (border vista, F3 open)

#### QA-W6-10 — Bed: sets personal spawn; sleep only in 12541–23458 gt window or thunderstorm; occupied swap
- **Verifies:** P1-18-6
- **Gate:** caps `beds` + `gtTime`
- **Steps:**
  1. `STAGE_SKYLAB`; `setGameRule('doDaylightCycle', false)`; if `getCaps()` includes `weather`: `setWeather('clear')` (`setWeather` is gated `weather` (§2.3 W6), not part of this test's `beds`+`gtTime` gate — the call must be cap-conditional); `__qa.setBlock(4, 100, 4, 'bed')`; stand at (2,100,4); aim via `aimAt`/`setLook`; assert `getTargetedBlock().pos` = [4,100,4].
  2. Noon attempt: `setTime(6000)`; right-click (`page.mouse.down({button:'right'}); page.mouse.up({button:'right'})`); read `getSpawnPoint()`, `getSleepState()`, `getPose()`.
  3. Boundary attempts, same aim: `setTime(12500)` → click; `setTime(12541)` → click, poll `getPose()` and `getBlock(4,100,4)` for 40 ticks, wait for wake; `setTime(23458)` → click (expect accept); `setTime(23459)` → click (expect deny).
  4. Thunderstorm daytime (sub-check gated `weather`, like QA-W6-12 — SKIPPED-GATED without the cap, never a thrown `setWeather`): `setTime(6000)`; `await setWeather('thunder')`; click.
- **Pass criteria:** (a) after step 2: `getSpawnPoint().type === 'bed'` with pos within 2 blocks of (4,100,4) (spawn set even when sleep is refused — vanilla behavior), `getSleepState().lastDenial === 'You can sleep only at night'` (exact string, also present in `getChatLog(3)` as system), `getPose() !== 'sleeping'`; (b) 12500 → denied; 12541 → `getPose()==='sleeping'` within 20 ticks AND `getBlock(4,100,4) === 'bed_occupied'` while asleep, reverting to `'bed'` after wake (occupied-blockstate stand-in, plan delta 3); (c) 23458 accepted, 23459 denied (window inclusive bounds); (d) (gate `weather`) thunderstorm at noon: sleep accepted.
- **Screenshot:** `qa/W6/QA-W6-10-bed-window.png` (asleep frame with occupied bed)

#### QA-W6-11 — Sleep blocked by monsters within 8 blocks
- **Verifies:** P1-18-7
- **Gate:** caps `beds` + `mobs`
- **Steps:**
  1. `STAGE_SKYLAB` + bed at (4,100,4) as in QA-W6-10; `setGameRule('doDaylightCycle', false)`; `setTime(18000)`; `setMobSpawning(false)`; `clearMobs()`.
  2. `spawnMob('groaner', 10, 100, 4)` (distance 6 from the bed); aim + right-click; read `getSleepState()`.
  3. `clearMobs()`; `spawnMob('groaner', 14, 100, 4)` (distance 10 > 8); click. Wake (or `setTime(18000)` re-stage between attempts).
  4. `clearMobs()`; `spawnMob('grazer', 6, 100, 4)` (passive at distance 2); click.
- **Pass criteria:** (a) step 2 denied with `lastDenial === 'You may not rest now; there are monsters nearby'` (exact string; system chat entry too); `getPose() !== 'sleeping'`; (b) step 3 accepted (hostile beyond 8 blocks); (c) step 4 accepted (passives don't block — only the package's hostile archetypes {groaner, exploder, frayedhound, screecher, emberspinner, unpicked, needlejack, raveler} count (`mobs/MobManager.js` `ARCHETYPE_CONFIG.hostile:true`; scaldwarden is `hostile:false` — neutral, never blocks)); (d) with `mobs` cap absent this test reports SKIPPED-GATED (the check passes vacuously without `G.mobs` — plan cluster S).
- **Screenshot:** `qa/W6/QA-W6-11-monsters-block-sleep.png`

#### QA-W6-12 — Sleep success: dayTime → next 0, weather cleared, timeSinceRest reset, gameTime continuous
- **Verifies:** P1-18-8
- **Gate:** caps `beds` + `gtTime` + `weather`
- **Steps:**
  1. `STAGE_SKYLAB` + bed; `setGameRule('doDaylightCycle', false)`; `setTime(15000)`; `await setWeather('thunder')`; record `g0 = getGameTick()`, `e0 = getWeather().epoch`, `d0 = getWorldTime()`.
  2. Aim + right-click; wait for wake (`getPose()` returns to `'standing'`, ≤ 6 s wall).
  3. Read `getWorldTime()`, `getGameTick()`, `getWeather()`, `getTimeState()`, `getSleepState()`.
- **Pass criteria:** (a) `getWorldTime() % 24000 ∈ [0, 200]` and `getWorldTime() > d0` (jumped FORWARD to the next morning-0, never backward); `getSleepState().lastWakeDayTime` matches ±200; (b) `getWeather().state === 'clear'`, `raining === false`, `thundering === false`, and `epoch === e0 + 1` (sleep-clear bumps the epoch so all clients re-anchor); (c) `getTimeState().timeSinceRest` within 200 gt of `getGameTick()` (insomnia counter reset); (d) `getGameTick() ≥ g0` and `getGameTick() − g0 ≤ 2000` (gameTime advanced normally through sleep — never reset; the P1-18-2 split holds through P1-18-8).
- **Screenshot:** `qa/W6/QA-W6-12-sleep-morning.png` (post-wake dawn sky, F3 open)

#### QA-W6-13 — Respawn resolution: bed → anchor (charges) → world-spawn fallback + exact message
- **Verifies:** P1-10-11
- **Gate:** caps `beds` (anchor sub-checks additionally cap `nether`)
- **Steps:**
  1. `STAGE_SKYLAB` + bed at (4,100,4); right-click once (sets bed spawn). `__qa.tp(200, 100, 200)`; `await __qa.respawnPlayer()`; read `getPlayerPos()`.
  2. Obstruct: rebuild, then box the bed in stone on all 6 sides + the 8 adjacent standing cells; `tp(200,100,200)`; `respawnPlayer()`; read pos + `getChatLog(3)`.
  3. Remove the bed entirely (`setBlock(4,100,4,'air')`, clear obstruction); `respawnPlayer()`; read pos + chat.
  4. (cap `nether`) `__game.setDimension('nether')`; find/stage a netherrack floor; `setBlock(bx,by,bz,'respawn_anchor_0')`; `give('glowstone', 4)` and select that hotbar slot (`Digit<n>`); aim at the anchor; right-click 4 times reading `getBlock` after each; right-click a 5th time; then select an empty/non-glowstone slot and right-click once (set spawn); `tp` 100 blocks away; `respawnPlayer()`; read pos and the anchor block id.
  5. Overworld misuse: back in overworld, `setBlock(6,100,6,'respawn_anchor_1')`; aim; right-click.
- **Pass criteria:** (a) step 1: respawn pos within 2 blocks of the bed (adjacent standing cell, 2-air validated); (b) step 2 (obstructed) and step 3 (missing): respawn at WORLD spawn (`getSpawnPoint()` resolution falls back; pos matches the W1 `findWorldSpawn` point ± spawnRadius) AND system chat contains exactly **"You have no home bed or charged respawn anchor, or it was obstructed"**; (c) anchor charging: block id walks `respawn_anchor_1 → _2 → _3 → _4` (one per glowstone click, glowstone = existing id 24), 5th click leaves `_4` (cap 4 charges); after set-spawn + `respawnPlayer()` in the nether: pos within 2 blocks of the anchor AND block id decremented to `respawn_anchor_3` (**consumes 1 charge per respawn**); (d) step 5: anchor interact in overworld destroys the anchor (block → `'air'`); if `getCaps()` includes the W8 explosion token assert a ≥ power-5 crater + player damage, else annotate `explode-module-absent (damage-only)` — never FAIL on the crater.
- **Screenshot:** `qa/W6/QA-W6-13-respawn-anchor.png` (charged anchor targeted, F3 open)

#### QA-W6-14 — Sound categories: 10 gain channels, sliders live-apply + persist, subtitles
- **Verifies:** P1-29-1
- **Gate:** caps `audio`
- **Steps:**
  1. `STAGE_SKYLAB`; trigger one block sound (break a stone via mouse) to force AudioContext init; `a = getAudio()`.
  2. `setSetting('sound.block', 0)`; break a stone block; sample `getAudioRms()` at 30 ms cadence for 400 ms around the break; `setSetting('sound.block', 1)`; repeat.
  3. `await setWeather('rain')` (rain loop in category `weather`); `setSetting('sound.master', 0)`; sample RMS 1 s; restore `sound.master` 1.
  4. Reload the page (`page.reload()` + rejoin world); read `getAudio().gains`.
  5. `setSetting('sound.subtitles', true)`; break a block; check the `#subtitles` element.
- **Pass criteria:** (a) `a.gains` has exactly the 10 keys `master, music, record, weather, block, hostile, neutral, player, ambient, voice` (P1-29-1 category list) and `a.ctxState === 'running'`; (b) with `sound.block=0`: peak RMS ≤ 0.005 while `getSoundLog` STILL records the `block.stone.break` event (muted, not suppressed); with `=1`: peak RMS ≥ 0.02; (c) `sound.master=0` silences the rain loop (RMS ≤ 0.005) without changing `getWeather().intensity`; (d) after reload, the previously-set slider values persist (localStorage `loomfall.settings` `sound.*` keys, same store as renderDistance/fov); (e) subtitles: `#subtitles` shows ≥ 1 entry within 500 ms of the sound (text non-empty), and none when toggled off.
- **Screenshot:** `qa/W6/QA-W6-14-sound-categories.png` (settings screen showing the audio sliders)

#### QA-W6-15 — Namespaced events per block sound group; ~16-block positional attenuation; pitch variance
- **Verifies:** P1-29-2, P1-29-3
- **Gate:** caps `audio`
- **Steps:**
  1. `STAGE_SKYLAB`. Break a stone at (3,100,0); place planks (select from creative palette) at (3,100,1); build a sand strip `setBlock(x,99,z,'sand')` x∈[6..14], z=0 and walk it (`KeyW` ~2 s). Read `getSoundLog(20)`.
  2. Positional: `const h = __qa.playSound('block.stone.break', 2, 101, 0, { loop: true })` with the player at (0,100,0) (d=2); record peak RMS over 500 ms → `r2`; `tp(−12, 100, 0)` (d=14) → `r14`; `tp(−16, 100, 0)` (d=18) → `r18`; `stopSound(h)`.
  3. Pitch: break 12 stone blocks; collect `pitch` from the 12 `block.stone.break` log entries.
- **Pass criteria:** (a) log contains `{name:'block.stone.break', category:'block', pos ≈ (3.5,100.5,0.5) ± 1}`, `{name:'block.wood.place'}`, and ≥ 2 `{name:'block.sand.step', category:'block'}` entries — namespace `block.<group>.<verb>` with the group from `audio/soundGroups.js` (registry untouched, parallel map); (b) attenuation: `r2 ≥ 2·r14` and `r14 > 0.005` and `r18 ≤ 0.005` (linear panner, maxDistance 16 → inaudible ≥ 16 blocks); (c) pitches: all 12 ∈ [0.85, 1.15] (±10% variance model) ⊂ hard clamp [0.5, 2.0], with ≥ 3 distinct values (variance actually applied).
- **Screenshot:** `qa/W6/QA-W6-15-sound-events.png`

#### QA-W6-16 — Core particle types: flame/smoke/crit/heart/break, lifetimes, block tint, settings scale
- **Verifies:** P1-29-4
- **Gate:** caps `particles`
- **Steps:**
  1. `STAGE_SKYLAB`; `setSetting('video.particles', 'all')`. For each `t ∈ ['flame','smoke','crit','heart']`: `emitParticle(t, 4, 101, 4, 16)`; read `getParticles()` immediately, then poll until `byType[t] === 0` recording the elapsed wall time; screenshot mid-life for `crit`.
  2. Break: aim at a grass block and break it with the mouse (the real main.js call site, not the dev hook); read `getParticles().byType.break` within 3 frames; also `emitParticle('break', 4, 101, 4, 16, 'stone')` for the tinted-pool path.
  3. `setSetting('video.particles', 'minimal')`; `emitParticle('crit', 4, 101, 4, 16)`; read count. Restore `'all'`.
- **Pass criteria:** (a) each dev emit registers `byType[t] ≥ 12` immediately (≥ 75% of requested, pool-capacity tolerance) and decays to 0 within: flame ≤ 1.5 s, smoke ≤ 2.5 s, crit ≤ 1.0 s, heart ≤ 1.5 s (registry lifetimes + margin); `live` returns to 0; (b) mouse-break spawns `byType.break ≥ 4` without any dev call (real call-site wiring); break particles are visibly block-colored (screenshot shows green-ish chips over grass — region assert: ≥ 10 pixels within ±25% of the grass tint from QA-W6-09 in the 100×100 px crop around the broken cell); (c) `'minimal'` scales the same emit to ≤ 4 particles (×0.1 with floor); (d) only the 5 core types exist in `byType` keys (flame/smoke/crit/heart/break — the ~95-type set is P2; unknown type to `emitParticle` throws or no-ops with a console warning, never crashes the rAF loop: zero page errors during the test).
- **Screenshot:** `qa/W6/QA-W6-16-particles.png` (crit burst mid-life, F3 open)

---

## W7 acceptance tests — Persistence, settings, gamerules, gamemode/difficulty plumbing, commands & menus depth

Harness per QA_PLAN.md §1 (Playwright + `?qa=1`, viewport 1280×720, `ensureLocked` after every screen close, 1 game tick = 50 ms). **SUT delta:** the real code is a single Express+ws server — launch `node server/index.js` (env `QA=1` for the qa-flush/storage endpoints), page URL `http://localhost:3000/?qa=1`; QA_PLAN's `5173`/`25565` split describes the spec stack, not this code. All REST assertions use in-page `fetch('/api/...')`. World is 16×16×128, `SEA_LEVEL 40` — staging y-values fit [55..80]. Chat interaction uses the REAL DOM: `#chat` root, `.chat-input` field (maxLength 256), Enter sends, Escape closes (`public/src/ui/chat.js`); `KeyT` opens via main.js, `Slash` opens pre-filled `/`.

**Fixture `W7S`** (used unless stated): create world `qa-w7` via REST from the page — `fetch('/api/worlds', {method:'POST', body:JSON.stringify({name:'qa-w7', seed:8675309, gamemode:'survival', difficulty:'normal', cheats:true})})` — then enter it from World Select (`Play` on the `qa-w7` row); `await page.waitForFunction(() => __qa.isColumnLoaded(8, 8))`; `ensureLocked(page)`. Stone platform when blocks are staged: `__qa.setBlock(x, 60, z, 'stone')` for x∈[−8..24], z∈[−8..8]; `__qa.tp(0.5, 61, 0.5)`. **`W7C2`** = a second Playwright context (fresh localStorage ⇒ fresh `loomfall.uuid`) joining the SAME world id (QA_PLAN §S9 pattern). Helper `chatSend(text)`: `keyboard.press('KeyT')` → `waitForSelector('.chat-input:focus')` → `keyboard.type(text)` → `keyboard.press('Enter')` → `ensureLocked`.

**New `__qa` hooks & cap tokens for this wave:** consolidated in §2 above (per-wave block **W7** in §2.3 + cap-token table §2.4); the signatures there are normative, including the conflict resolutions of §2.1.

Existing M0 hooks reused heavily below: `getBlock/setBlock`, `tp`, `give`, `setTime`, `getWorldTime`, `getSeed`, `getPlayerPos/getPlayerVel`, `isFlying`, `getGameMode/setGameMode`, `getSelectedSlot`, `getHotbar`, `getChatLog`, `getScreen`, `getCameraFov`, `setSetting`, `isColumnLoaded`, `getHealth` (gate `damage`), plus the §1.5 `data-setting` rows and W7's additive `data-create`/`data-menu` attributes.

---

#### QA-W7-01 — Gamerule registry: typed record, defaults, /gamerule get/set
- **Verifies:** P1-25-1, P1-25-2, P1-25-3
- **Gate:** caps `gamerules` + `commands`
- **Steps:**
  1. `W7S`. `const r = await page.evaluate(() => __qa.getRules())`.
  2. `chatSend('/gamerule keepInventory')`; read `getChatLog(1)`.
  3. `chatSend('/gamerule keepInventory true')`; `chatSend('/gamerule randomTickSpeed 12')`; re-read `getRules()`.
  4. Invalid inputs: `runCommand('/gamerule keepInventory banana')`, `runCommand('/gamerule randomTickSpeed true')`, `runCommand('/gamerule notARule 1')` — capture `{ok, feedback}` for each.
- **Pass criteria:** (a) registry defaults exact for the full P1 list — spot-assert the 13 rules named here: `doDaylightCycle:true, doWeatherCycle:true, doFireTick:true, mobGriefing:true, doMobSpawning:true, keepInventory:false, naturalRegeneration:true, doImmediateRespawn:false, randomTickSpeed:3, spawnRadius:10, maxEntityCramming:24, playersSleepingPercentage:100, commandModificationBlockLimit:32768` (types: booleans are `typeof 'boolean'`, ints `Number.isInteger`); total key count ≥ 51 (39 bools + 12 ints); (b) query form feedback contains `keepInventory` and `false`; (c) after set: `getRules().keepInventory === true` and `randomTickSpeed === 12`; (d) all three invalid calls return `ok:false` with a feedback line, and `getRules()` values unchanged by them.
- **Screenshot:** `qa/W7/QA-W7-01-gamerule-registry.png`

#### QA-W7-02 — Gamerule sync (world-meta broadcast) + persistence round-trip
- **Verifies:** P1-25-1, P1-30-1 (gamerules field)
- **Gate:** caps `gamerules` + `playerPersistence`
- **Steps:**
  1. `W7S` + `W7C2` (client 2 in the same world). Client 1: `chatSend('/gamerule mobGriefing false')`.
  2. Client 2 within 1 s: `getRules().mobGriefing`.
  3. Client 1: `await __qa.qaFlushWorldSave()`; `const w = await (await fetch('/api/worlds/' + worldId)).json()`.
  4. Client 1: Escape → click `Save & Quit` (pause menu, `ui/menu.js`) → re-enter `qa-w7` from World Select; read `getRules()`.
- **Pass criteria:** (a) client 2 sees `mobGriefing === false` within 1 s without rejoining (S→C `world-meta` broadcast); (b) the REST record has `w.gamerules.mobGriefing === false` and carries the FULL registry (same key count as QA-W7-01a); (c) after quit/rejoin, `getRules().mobGriefing === false` (welcome-delivered) — and `saves/qa-w7*.json` round-tripped through the atomic tmp+rename path (no partial-JSON error in server log).
- **Screenshot:** `qa/W7/QA-W7-02-gamerule-sync.png`

#### QA-W7-03 — Rule consumers: doDaylightCycle freeze + sendCommandFeedback
- **Verifies:** P1-25-2 (live consumers), P1-24-1 (/time interplay)
- **Gate:** caps `gamerules` + `commands`
- **Steps:**
  1. `W7S`. `runCommand('/time set 6000')`. Sample `t1 = __qa.getWorldTime()`, wait 3000 ms, `t2 = getWorldTime()`.
  2. `runCommand('/gamerule doDaylightCycle false')`; sample `t3`, wait 3000 ms, `t4`.
  3. `runCommand('/gamerule sendCommandFeedback false')`; `const n0 = getChatLog(50).length`; `runCommand('/time set 13000')`; `const n1 = getChatLog(50).length`; read `getWorldTime()`.
  4. `runCommand('/gamerule sendCommandFeedback true')`.
- **Pass criteria:** (a) cycling: `(t2 − t1) / 3 s = 24000 / 1200 = 20` gt-units/s ± 10% (i.e. `t2 − t1` over the 3 s window ≈ 60 ± 10%) — fixed at W6's normative 24000 gt = 1200 s day (P1_WORKPLAN delta 4; W7 runs after W6, and QA-W6-01(d) asserts the same 20 gt/s rate; the pre-W6 `main.js` `DAY_LENGTH_S = 600` rate of 40/s is superseded, not a valid alternative); (b) frozen: `t4 − t3 === 0` exactly; (c) with feedback off, `/time set 13000` APPLIES (`getWorldTime()` phase = 13000 ± 5) but adds NO chat line (`n1 === n0`).
- **Screenshot:** `qa/W7/QA-W7-03-rule-consumers.png`

#### QA-W7-04 — /gamemode, abilities record, flight gating
- **Verifies:** P1-22-1 (command half), P1-31-2
- **Gate:** caps `gamemodes` + `commands`
- **Steps:**
  1. `W7S` (survival). `const a1 = __qa.getAbilities()`.
  2. Double-space in survival: `keyboard.press('Space')`, wait 150 ms, `keyboard.press('Space')` (inside Controls' 300 ms window); wait 300 ms; read `isFlying()`.
  3. `chatSend('/gamemode creative')`; read `getGameMode()`, `getAbilities()`.
  4. Double-space again; wait 300 ms; read `isFlying()`; `__qa.tp(0.5, 75, 0.5)` (airborne, still flying).
  5. `runCommand('/gamemode survival')` while flying; sample `getPlayerVel()` over the next 10 ticks; read `getAbilities()`.
  6. `runCommand('/gamemode adventure')` — capture feedback.
- **Pass criteria:** (a) survival abilities exact: `{invulnerable:false, flying:false, allowFlying:false, creativeMode:false, instabuild:false, flySpeed:0.05, walkSpeed:0.1}` (flySpeed/walkSpeed are the vanilla packet values — parity fields; physics stays Player.js constants, delta); (b) survival double-space does NOT enable flight: `isFlying() === false` (the un-gated double-space flight of `010b2a8` is now gamemode-gated); (c) creative: `getGameMode()==='creative'`, abilities `{invulnerable:true, allowFlying:true, creativeMode:true, instabuild:true}`; double-space → `isFlying() === true`; (d) switch to survival mid-air forces `flying:false` and vel.y goes negative within 5 ticks (gravity −24 b/s² resumes); (e) adventure: `ok:false`, feedback mentions unsupported (P2 delta), mode unchanged.
- **Screenshot:** `qa/W7/QA-W7-04-gamemode-abilities.png`

#### QA-W7-05 — playerGameType persistence + defaultgamemode
- **Verifies:** P1-22-1 (persistence half), P1-30-4 (gameType fields)
- **Gate:** caps `gamemodes` + `playerPersistence`
- **Steps:**
  1. `W7S`. `const uuid = __qa.getUuid()`; `runCommand('/gamemode creative')`; `await __qa.qaSavePlayerNow()`.
  2. `const p = await (await fetch('/api/worlds/' + worldId + '/players/' + uuid)).json()`.
  3. Reload the page (`page.reload()`), re-enter `qa-w7`; read `getGameMode()`.
  4. `W7C2` (fresh context → NEW uuid) joins `qa-w7`; read its `getGameMode()` (world was created `gamemode:'survival'`).
- **Pass criteria:** (a) REST record: `p.gameType === 'creative'` AND `p.previousGameType === 'survival'` (the playerGameType/previousPlayerGameType pair); (b) after reload + rejoin, `getGameMode() === 'creative'` (restored from `welcome.you`, not the world default); (c) the fresh-uuid client gets `'survival'` — `defaultgamemode` = `world.gamemode` applies only to players with no record. (`force-gamemode` override is QA-W7-17.)
- **Screenshot:** `qa/W7/QA-W7-05-gametype-persist.png`

#### QA-W7-06 — /difficulty + DifficultyLocked
- **Verifies:** P1-23-1
- **Gate:** caps `commands` + `menusV2`
- **Steps:**
  1. `W7S`. `runCommand('/difficulty')` — capture feedback. `chatSend('/difficulty peaceful')`; read `getWorldMeta()`.
  2. `await __qa.qaFlushWorldSave()`; fetch `/api/worlds/<id>` → `difficulty`.
  3. Escape (pause) → open Options → click the difficulty-lock button (row stamped `data-setting="difficultyLock"` beside the difficulty row) → confirm; read `getWorldMeta().difficultyLocked`.
  4. `runCommand('/difficulty hard')` — capture `{ok, feedback}`; re-read `getWorldMeta().difficulty`. Close menus, `ensureLocked`.
- **Pass criteria:** (a) no-arg feedback names the current difficulty (`normal`); after set, `getWorldMeta().difficulty === 'peaceful'` (enum order peaceful=0/easy=1/normal=2/hard=3 accepted in numeric form too: `runCommand('/difficulty 3')` before locking maps to `hard` — run this between steps 1 and 2, then set back to peaceful); (b) REST record persists the value; (c) lock: `difficultyLocked === true`; (d) post-lock `/difficulty hard` returns `ok:false` (server `error bad_meta` surfaced as feedback) and the value is unchanged.
- **Screenshot:** `qa/W7/QA-W7-06-difficulty-lock.png`

#### QA-W7-07 — World commands: /tp, /setblock, /fill (+limit), /seed, /help
- **Verifies:** P1-24-1, P1-25-3 (commandModificationBlockLimit consumer)
- **Gate:** caps `commands`
- **Steps:**
  1. `W7S` with platform. `chatSend('/tp 20 70 20')`; read `getPlayerPos()`. `runCommand('/tp ~ ~5 ~')`; read again.
  2. `runCommand('/setblock 22 69 20 stone')`; `__qa.getBlock(22, 69, 20)`.
  3. `runCommand('/fill 24 69 20 27 71 23 planks')` (4×3×4 = 48 cells); sample all 8 corners + center via `getBlock`.
  4. `runCommand('/fill 0 0 0 40 100 40 stone')` (41·101·41 = 169,741 > 32768) — capture `{ok, feedback}`; probe `getBlock(0, 90, 0)`.
  5. `runCommand('/seed')`; `runCommand('/help')`.
- **Pass criteria:** (a) `/tp`: pos within 0.01 of (20,70,20); relative form lands at (20,75,20) ±0.01 (`~` resolves against current pos); a `move` frame reaches peers (sniff optional); (b) setblock: `'stone'`; (c) fill: all 9 probes `'planks'` and the edits went through the normal path (client 2, if open, sees them — `edit` broadcast, no echo to sender per docs/PROTOCOL.md); (d) oversize fill: `ok:false`, feedback cites the 32768 limit, `getBlock(0,90,0)` unchanged (no partial fill); (e) `/seed` feedback contains `String(__qa.getSeed())` (= 8675309); `/help` lists ≥ 14 registered commands including every P1-24-1 name.
- **Screenshot:** `qa/W7/QA-W7-07-world-commands.png`

#### QA-W7-08 — Player commands: /give, /kill, /time named values, /weather
- **Verifies:** P1-24-1
- **Gate:** caps `commands` (sub-gates: `items` for stack counts, `damage` for death screen, `weather` for /weather)
- **Steps:**
  1. `W7S`. `runCommand('/give stone 5')`; read `getHotbar()`.
  2. `runCommand('/time set noon')`; read `getWorldTime()`; `runCommand('/time add 6000')`; read again; `runCommand('/time query')` feedback.
  3. `runCommand('/weather rain')` — capture `{ok, feedback}`; if caps include `weather`: read `getWorldMeta().weather.raining`.
  4. `chatSend('/kill')`; observe.
- **Pass criteria:** (a) give: hotbar contains stone — count 5 with caps `items` (W5 stacks); without, one slot set to stone (degraded form, annotate `pre-W5 give`); (b) noon → phase `6000 ± 5`; add → `12000 ± 5`; query feedback contains the current value; (c) weather: with cap, `ok:true` and `raining === true` within 2 s; without cap, `ok:false` with the "Weather system not installed" message — report the sub-check `SKIPPED-GATED (weather)`, never FAIL; (d) kill: with caps `damage`, the W2 death screen appears (`data-screen="death"`, `getHealth().health === 0`); without, the player respawns at the spawn column (pos.x ≈ world spawn ±1) — either outcome passes per its gate.
- **Screenshot:** `qa/W7/QA-W7-08-player-commands.png`

#### QA-W7-09 — Chat send modes: T, Slash-prefill, /say, /me, /msg targeting
- **Verifies:** P1-28-1
- **Gate:** caps `commands` + a THIRD context (three clients: A = W7S, B, C = W7C2-style fresh contexts in `qa-w7`)
- **Steps:**
  1. Client A: `keyboard.press('KeyT')` → assert `document.activeElement` has class `chat-input`; type `hello world`, Enter.
  2. Client A: `keyboard.press('Slash')` → assert chat opened AND input value is exactly `'/'`; type `say broadcast test`, Enter.
  3. Client A: `chatSend('/me waves')`.
  4. Client A: `chatSend('/msg ' + nameB + ' psst')` (nameB = client B's `loomfall.name`).
  5. All three clients read `getChatLog(10)`.
- **Pass criteria:** (a) plain chat: B and C both have a line with `from === nameA`, `text === 'hello world'`, and A sees its own echo (server echoes chat to sender per docs/PROTOCOL.md); (b) `/say`: all three see a line rendered `[nameA] broadcast test` (kind `say` forwarded by the server); (c) `/me`: all three see `* nameA waves`; (d) `/msg`: B sees the whisper (`psst`, styled italic/gray), A sees a "you whisper to" confirmation, and **C's log does NOT contain `psst`** (targeted delivery — server sends only to target + sender); a `/msg unknownName x` returns `ok:false` (`bad_chat_target`); (e) input maxLength 256 still enforced (type 300 chars, input value length === 256).
- **Screenshot:** `qa/W7/QA-W7-09-chat-modes.png`

#### QA-W7-10 — JSON text components: renderer + command feedback
- **Verifies:** P1-28-2
- **Gate:** caps `textComponents`
- **Steps:**
  1. `W7S`. `page.evaluate(() => __qa.qaAddChatComponent({ text: 'root ', color: 'gold', bold: true, extra: [ { text: 'red-italic ', color: 'red', italic: true }, { text: 'hexed', color: '#55FFFF', underlined: true } ] }))`.
  2. Locate the newest `.chat-line`; read computed styles of its three spans.
  3. `runCommand('/gamerule keepInventory true')`; `const e = getChatLog(1)[0]`.
  4. `qaAddChatComponent({ translate: 'unsupported.key', text: 'fallback' })` — assert graceful.
- **Pass criteria:** (a) the line renders as a nested tree: span 1 `font-weight ≥ 700` and gold-ish color (`rgb(255,170,0)` ±10/channel — vanilla `gold`), span 2 italic + `rgb(255,85,85)` ±10, span 3 underlined + `rgb(85,255,255)` ±10 (hex passthrough); children INHERIT bold from root unless overridden (span 2 and 3 also bold — vanilla inheritance); (b) command feedback lines carry `e.component` (object with `text`) and `e.system === true`; `e.text` equals `flattenComponent(e.component)`; (c) unknown `translate` degrades to visible text, zero console errors; (d) 8 s fade + 50-line scrollback behavior unchanged (spot: line still present in scrollback after fade class applies).
- **Screenshot:** `qa/W7/QA-W7-10-text-components.png`

#### QA-W7-11 — level.dat-equivalent world record round-trip
- **Verifies:** P1-30-1
- **Gate:** caps `playerPersistence` + `gamerules`
- **Steps:**
  1. `W7S`. Stage distinct state: `runCommand('/time set 9000')`, `runCommand('/gamerule doFireTick false')`, `runCommand('/difficulty easy')`, `runCommand('/spawnpoint 12 62 12')` — then `await __qa.qaFlushWorldSave()`.
  2. `const w = await (await fetch('/api/worlds/' + worldId)).json()`.
  3. Escape → `Save & Quit` → from the title, re-enter `qa-w7`; read `getWorldTime()`, `getRules().doFireTick`, `getWorldMeta()`.
- **Pass criteria:** (a) the record contains EVERY W7 field: `seed (8675309)`, `spawn {x,y,z,angle}`, `time {dayTime, savedAt}` with phase 9000 ± 60, `gamerules` (full registry, `doFireTick:false`), `difficulty:'easy'`, `difficultyLocked:false`, `gamemode`, `cheats:true`, `worldType:'default'`, `weather {raining,thundering,rainTime,thunderTime}`, `version {name:'0.1.0', data:1}`, `createdAt`, plus legacy `id/name/edits` — **parity delta annotated:** this is the JSON mirror of level.dat content; gzip-NBT/`level.dat_old`/`session.lock`/worldborder are vanilla-only (P2/N-A); (b) after quit + rejoin: `doFireTick` still false, difficulty `easy`, and time resumed from ~9000 advancing at the QA-W7-03a rate (wall-clock elapsed while at the title is bridged by the server's `{dayTime, savedAt}` arithmetic — value ≥ 9000, monotonic); (c) a pre-W7 legacy save (fixture: write `{id,name,seed,createdAt,edits}` JSON into `saves/` before boot) loads without error and `normalizeWorld` backfills every new field with defaults.
- **Screenshot:** `qa/W7/QA-W7-11-world-record.png`

#### QA-W7-12 — Per-player persistence round-trip (P1-30-4)
- **Verifies:** P1-30-4 (+ /spawnpoint)
- **Gate:** caps `playerPersistence`
- **Steps:**
  1. `W7S` with platform. `__qa.tp(14.5, 61, 6.5)`; `keyboard.press('Digit6')` (select slot 5); if caps `items`: `give('planks', 12)`; if caps `damage`: stage health to 14 via `__qa` damage hook (W2). `runCommand('/spawnpoint 14 61 6')`; read `getSpawnPoint()` — expect `{type:'command', x:14, y:61, z:6, dim:'overworld'}` (the §2.1-3/§2.3-W6 enum's `'command'` value for a `/spawnpoint`-set personal spawn).
  2. `await __qa.qaSavePlayerNow()`; `const p = await (await fetch('/api/worlds/' + worldId + '/players/' + __qa.getUuid())).json()`.
  3. `page.reload()`; re-enter `qa-w7`; wait `isColumnLoaded(14, 6)`; read `getPlayerPos()`, `getSelectedSlot()`, `getSpawnPoint()`, (gated) `getHealth()`, `getHotbar()`.
  4. `W7C2` (fresh uuid): read ITS `getPlayerPos()` and `getSpawnPoint()`.
- **Pass criteria:** (a) the step-1 in-page read returns `getSpawnPoint()` = `{type:'command', x:14, y:61, z:6, dim:'overworld'}` AND the REST record fields are present and correct: `pos ≈ [14.5, 61, 6.5]` (±0.01), `yaw/pitch` finite, `dim:'overworld'`, `selectedSlot:5`, `spawn {x:14,y:61,z:6,dim:'overworld'}`, `gameType`, `abilities`, `savedAt`; gated fields: `health:14`, `inventory` non-null with planks×12 (else null — annotate which waves are absent, don't FAIL); Motion/EnderItems/Attributes/Brain annotated `N/A — parity delta`; (b) after reload: position restored within 0.5 (NOT the spawn-column scan at 8,8), slot 5 selected, spawn point intact, gated health/hotbar restored; (c) the fresh-uuid client spawns at the world spawn with `getSpawnPoint().type === 'world'` (the §2.1-3 resolved shape never returns null — 'no personal spawn' IS `type:'world'` with the world-spawn coords) — zero cross-uuid bleed; (d) `beforeunload` beacon: kill the page WITHOUT qaSavePlayerNow after moving to a new spot; REST record's pos updates within 2 s (sendBeacon PUT path) — soft-assert (browser beacon timing), annotate on miss.
- **Screenshot:** `qa/W7/QA-W7-12-playerdata.png`

#### QA-W7-13 — Region-sharded chunk store: layout, dense mode, migration, integrity
- **Verifies:** P1-30-2, P1-30-3
- **Gate:** caps `regionPersistence` (server started with `QA=1`)
- **Steps:**
  1. `W7S`. Local edits: `runCommand('/fill 0 60 0 15 63 15 planks')` (1024 cells, chunk 0,0). Far edits: `runCommand('/tp 640 80 0')`, wait `isColumnLoaded(640, 0)`, `runCommand('/setblock 640 60 0 stone')` (cx = 40 → region r.1.0). Dense trigger: `runCommand('/fill 0 30 0 15 46 15 stone')` (+4096 cells in chunk 0,0 → > 4096 total).
  2. `await __qa.qaFlushWorldSave()`; `const s = await (await fetch('/api/worlds/' + worldId + '/storage')).json()`.
  3. Quit to title, rejoin; wait for columns; probe `getBlock` at 6 spots: `(0,60,0), (15,63,15), (8,38,8), (640,60,0)` + 2 mid-fill cells.
  4. Fetch `/api/worlds/<id>` and measure `JSON.stringify(w).length`.
- **Pass criteria:** (a) `s.storageVersion === 2`; `s.regions` contains `{dim:'overworld', rx:0, rz:0}` AND `{dim:'overworld', rx:1, rz:0}` (rx = ⌊cx/32⌋: cx 0 → r.0, cx 40 → r.1 — the 32×32-chunks-per-file Anvil-mirroring layout); (b) chunk (0,0)'s record reports `mode:'dense'` (edit count 5120 > 4096 → base64 `Uint8Array(32768)` override array with 255 sentinel) while the cx-40 chunk stays `mode:'edits'` (sparse); (c) all 6 probes return the placed blocks after rejoin (assembleEdits → welcome path intact, including the `switchDimension` REST refetch shape); (d) the world meta JSON no longer embeds the edits payload: stringified length < 20 KB despite > 5000 edits; (e) migration: a v1 legacy save with 500 edits (fixture-written) is split into region files on first load (`storage` endpoint shows them) and every edit survives; (f) **parity delta annotated:** JSON regions (gzip > 256 KiB), not `.mca` sectors; per-chunk `light`/`blockTicks` are reserved-null until W8; Heightmaps/palette N/A (client regenerates terrain from seed).
- **Screenshot:** `qa/W7/QA-W7-13-region-store.png`

#### QA-W7-14 — Create-world screen depth + Multiplayer panel
- **Verifies:** P1-27-5
- **Gate:** caps `menusV2`
- **Steps:**
  1. Fresh page at `/?qa=1` (title screen). Click `Play` → the `Select World` panel (`data-menu="worlds"`); under `Create New World` assert the field set: name input (placeholder `World name`), seed input (placeholder `Seed (optional)`), `[data-create="gamemode"]`, `[data-create="difficulty"]`, `[data-create="worldtype"]`, `[data-create="cheats"]`.
  2. Cycle `[data-create="gamemode"]` once (→ Creative); cycle `[data-create="difficulty"]` to Peaceful (3 clicks); toggle `[data-create="cheats"]` ON; type name `qa-w7-create`, seed `42`; click `Create`; wait for world entry.
  3. Read `getGameMode()`, `getWorldMeta()`, `getSeed()`.
  4. Quit to title. Click `Multiplayer` (`data-menu="multiplayer"`): type `http://localhost:3000` in the address field, click Join/connect; assert the host's world list renders (row for `qa-w7`) and the motd line is visible.
- **Pass criteria:** (a) all six create controls exist and cycle with the correct value sets (gamemode 2 values, difficulty 4, worldtype ≥ 1 — `Superflat` present only with W1 caps, else annotate); (b) entering the created world: `getGameMode()==='creative'`, `getWorldMeta().difficulty==='peaceful'`, `cheats===true`, `getSeed()==='42'`; the REST record (`GET /api/worlds`) shows the same; (c) structures/datapacks rows are ABSENT by design — annotate `parity delta (P2/N-A)`, never FAIL; (d) Multiplayer panel lists the host's worlds via that origin's `GET /api/worlds` and joining a row lands in-world (welcome received). Pause menu (`Resume`/`Save & Quit`) and title/world-select/options screens all reachable — the P1-27-5 screen census.
- **Screenshot:** `qa/W7/QA-W7-14-create-world.png`

#### QA-W7-15 — Video options: full list + live apply + persistence
- **Verifies:** P1-27-6
- **Gate:** caps `menusV2`
- **Steps:**
  1. `W7S`. Escape → Options. Enumerate `[data-setting]` rows.
  2. `__qa.setSetting('fov', 110)`; read `getCameraFov()`. `setSetting('renderDistance', 3)`; wait 5 s; read `window.__game.chunkRenderer.stats` (or the shim's loaded-count) — call it `n3`.
  3. `setSetting('brightness', 0)`; screenshot region A (200×200 at canvas center); `setSetting('brightness', 100)`; screenshot region B; compare mean luminance.
  4. `setSetting('smoothLighting', false)`; wait for remesh (queue drains); sample a 40×40 crop at a known interior block corner before/after.
  5. `page.reload()`; read `localStorage.getItem('loomfall.settings')`.
- **Pass criteria:** (a) rows present for ALL: `renderDistance, fov, sensitivity, texturePack, guiScale, brightness, graphics, smoothLighting, clouds, particles, maxFramerate, simDistance` — and NO `vsync`/`mipmap` row (annotated `N/A — browser rAF / Nearest atlas`, per plan; range deltas 2..12 and 60..110 annotated vs PARITY 2..32 / 30..110); (b) fov applies live: `getCameraFov() === 110` within 1 frame; renderDistance 3: `n3 ≤ (2·(3+1)+1)² = 81` chunks after settle (unload beyond Chebyshev rd+1 per `engine/ChunkRenderer.js`); (c) brightness: mean luminance(B) − mean luminance(A) ≥ 25 (8-bit units); (d) smoothLighting off: corner-crop brightness variance drops ≥ 40% (AO gradient removed; face shading remains) and a full remesh occurred without frame-lock (no single frame > 250 ms during rebuild); (e) reload: persisted JSON contains every new key with the set values (same `loomfall.settings` storage, `sanitizeSettings` accepts them).
- **Screenshot:** `qa/W7/QA-W7-15-video-options.png`

#### QA-W7-16 — F5 perspective cycle + F1 HUD hide
- **Verifies:** P1-27-3
- **Gate:** caps `perspective`
- **Steps:**
  1. `W7S` with platform, `ensureLocked`. `keyboard.press('F5')`; read `getPerspective()`; screenshot.
  2. `keyboard.press('F5')` (→ third-front); read `getPerspective()`; `keyboard.press('F5')` (→ first).
  3. Camera collision: `__qa.setBlock(0, 61, 2, 'stone')`; `setBlock(0, 62, 2, 'stone')` (wall directly behind when facing −Z); `__qa.setLook(180, 0)` (face away from the wall); `keyboard.press('F5')`; read `getPerspective().camDistance`.
  4. `keyboard.press('F5')`; `keyboard.press('F5')` (back to first). `keyboard.press('F1')`; read `isHudVisible()`; assert hotbar/health/`#chat` hidden; `keyboard.press('F3')` — debug overlay must still show; `keyboard.press('F1')` again.
- **Pass criteria:** (a) cycle order exact: `first → third-back → third-front → first`; in third-back the local avatar (the `buildAvatarMesh` body/head extracted from `net/PeerAvatars.js`) is visible in-frame — mechanical pixel check: sample the sky reference color as the mean RGB of the top-center 40×40 px crop, classify a pixel "non-sky" when its max per-channel delta from that reference is > 24/255, and assert ≥ 200 non-sky pixels inside the center 200×200 px crop (the avatar hue is id-hash-derived per PeerAvatars and unknown a priori, so the check is sky-difference, never avatar-color-match) — and `camDistance = 4 ± 0.1` in open air; in third-front the camera looks BACK at the player (avatar faces camera); in first person the avatar is hidden and `camDistance === 0`; (b) with the wall behind, `camDistance ≤ 1.9` (raycast clamp `hitDist − 0.2` via `gameplay/raycast.js` — camera never inside the block: the wall face at 2 blocks minus player half-width); (c) F1: `isHudVisible() === false`, hotbar + vitality shards + crosshair + chat log all display:none, but the F3 overlay renders; F5/F1 both `preventDefault` (browser help/refresh not triggered — page still alive); second F1 restores everything; (d) keys ignored while chat input is focused (open chat, press F5 — perspective unchanged; the Controls typing-guard).
- **Screenshot:** `qa/W7/QA-W7-16-f5-f1.png`

#### QA-W7-17 — server.properties core subset
- **Verifies:** P1-31-1 (+ P1-22-1 force-gamemode)
- **Gate:** caps `serverProperties` — requires a dedicated server relaunch (run LAST in the suite)
- **Steps:**
  1. Teardown the shared server. Write `server.properties` at the repo root: `motd=QA Loomfall\nmax-players=2\nspawn-protection=4\nview-distance=4\ngamemode=creative\ndifficulty=hard\nforce-gamemode=true\nlevel-seed=777`. Relaunch `QA=1 node server/index.js`.
  2. Page 1: `const srv = await (await fetch('/api/server')).json()`.
  3. Page 1 joins by DIRECT world id `qa-props-1` (auto-create path — no POST first); read `getSeed()`, `getWorldMeta()`, `getGameMode()`.
  4. Page 2 (fresh context) joins the same world. Page 3 attempts to join — capture the WS result (CDP frame sniff per QA_PLAN §1.9).
  5. Page 1 (forced creative — switch to survival first: `runCommand('/gamemode survival')`): aim + place a block at Chebyshev distance ≤ 4 of the world spawn; then at distance 8. Page 2 watches for `edit` broadcasts.
  6. Page 1: `setSetting('renderDistance', 12)`; wait 5 s; read loaded-chunk count.
- **Pass criteria:** (a) `/api/server` = `{motd:'QA Loomfall', maxPlayers:2, players:<live>, version:'0.1.0', viewDistance:4}`; (b) the auto-created world took the properties defaults: seed `'777'` (level-seed overrides FNV-1a(id)), `difficulty:'hard'`, `gamemode:'creative'` — and force-gamemode gave page 1 creative even after its record said survival on a rejoin (rejoin once to prove the override); (c) third join receives `error {code:'server_full'}` and the socket closes — pages 1–2 unaffected; (d) spawn-protection: the ≤ 4 edit (as survival) is rejected — sender gets `error bad_edit`, the block does NOT appear locally-confirmed on page 2 (no broadcast), and `getBlock` on page 2 shows terrain; the distance-8 edit succeeds; creative retry inside the radius succeeds (creative bypass); (e) view-distance advisory: effective loaded chunks ≤ `(2·(4+1)+1)² = 121` despite the client's renderDistance 12 (welcome `server.viewDistance` clamp at the main.js `chunkRenderer.update` call); (f) `white-list=true` added + relaunch (sub-step): server boots with a WARN log and ignores it — parity delta (no accounts), annotate. Delete `server.properties` and relaunch for suite teardown hygiene.
- **Screenshot:** `qa/W7/QA-W7-17-server-properties.png`

---

## W8 acceptance tests — Block-update engine: scheduled ticks, lighting propagation, fluids, fire, gravity blocks & TNT (redstone-analogue groundwork)

Harness per QA_PLAN.md §1 (Playwright + `?qa=1`, viewport 1280×720, `ensureLocked` after every screen close, **1 game tick = 50 ms**, fixtures §1.7, screenshots §1.6). All staging uses `WORLD_B` (creative, cheats ON, `doDaylightCycle=false`) unless stated — at pre-W7 merge states construct it per the **WORLD_B staging recipe** in the W3 header (REST accepts only `{name, seed(, type)}` pre-W7; gamemode/gamerule set post-join). Block ids in assertions are the `__qa` string names the shim maps from the numeric registry (`public/src/blocks/blocks.js`): `stone`=3, `cobblestone`=4, `sand`=5, `gravel`=7, `water`=8, `planks`=11, `glass`=12, `red_sand`=21, `netherrack`=22, `glowstone`=24, `obsidian`=25, `lava`=28, plus W8's appended `fire` and `tnt` — numeric ids for the W8 appends are assigned by the shared id registrar, NOT 30/31 (P1_WORKPLAN's per-wave ledger gives W1 ids 30–51 and W5 60–106; the earlier "fire=30 / tnt=31" numbers collide with W1's range and are withdrawn — tests assert by NAME only, so the numerals are commentary). **MAX_BLOCK_ID precondition:** the server validates `edit.block ∈ [0,40]` (`server/index.js` `validBlockId`, ws `edit` handler; ids > 40 rejected — the old REST `PUT` second validation site was removed with the endpoint), so any appended id > 40 (W8's fire/tnt post-registrar, W6's bed/anchor 52–58, W4/W5 ids ≥ 60) can neither persist nor replicate until the registrar's one-time `MAX_BLOCK_ID` bump to 255 (practical ceiling 254 — W7's dense-store no-edit sentinel is 255) ships; that bump is an explicit applicability precondition for QA-W6-10/13 and ALL W4/W5/W6/W8 block persistence/replication tests (e.g. QA-W4-15's `wheat_5` round-trip). World is y∈[0,128), SEA_LEVEL 40 (parity delta vs spec 384/63 — all staging y-values chosen for [0,128)).

**Upgraded existing hooks (no interface change):** W8 makes two M0 hooks truthful — `getLight(x,y,z)` now returns the real BFS block channel + vertical-column sky channel (was heuristic/stub), and `getBlockState(x,y,z)` now returns `{block, props}` from the cluster-E sidecar (was `props:{}` always). `getEntities(type)` must enumerate `'falling_block'` and `'tnt'` types.

**New `__qa` hooks & cap tokens for this wave:** consolidated in §2 above (per-wave block **W8** in §2.3 + cap-token table §2.4); the signatures there are normative, including the conflict resolutions of §2.1.

Common staging recipe `STAGE_FLAT` (used below): `__qa.setTickFreeze(false)`; `__qa.tp(0,120,0)`; stone platform `setBlock(x,99,z,'stone')` for x,z∈[−20..20]; clear air y∈[100..110] above it; `__qa.tp(0,100,0)`; `await page.waitForFunction(() => __qa.isColumnLoaded(0,0))`; `__qa.setTime(6000)` (noon). Recipe `STAGE_ROOM` (sealed dark room): stone shell enclosing interior air x∈[20..44], y∈[60..64], z∈[−3..3] (floor y=59, ceiling y=65, perimeter walls) — fully below the staged surface, sky-occluded; verify `__qa.getLight(22,61,0)` returns `{block:0, sky:0}` before each lighting test.

---

#### QA-W8-01 — Scheduled-tick queue: delay, priority order, dedupe
- **Verifies:** P1-1-33
- **Gate:** caps `scheduledTicks`
- **Steps:**
  1. `STAGE_FLAT`; `__qa.setTickFreeze(true)`; `const t0 = __qa.getGameTick()`.
  2. `scheduleTick(5,100,5,'water',10,0)`; `scheduleTick(5,100,5,'water',10,0)` again (dedupe probe); `scheduleTick(6,100,5,'water',10,-3)`; `scheduleTick(7,100,5,'water',20,0)`. Read `q = getScheduledTicks()`.
  3. `await stepTicks(9)`; read `getTickLog(10)`. Then `await stepTicks(1)`; read `logA = getTickLog(10)`. Then `await stepTicks(10)`; read `logB = getTickLog(10)`.
- **Pass criteria:** (a) `q.size === 3` (second identical schedule deduped) and `q.next` order is `(6,100,5) pri −3` → `(5,100,5) pri 0` → `(7,100,5) pri 20-delay`; (b) after `stepTicks(9)` none of the three appear in the log; (c) `logA` contains exactly the two delay-10 entries, both with `tick === t0+10 ±0`, and the pri −3 entry precedes the pri 0 entry in log order; (d) `logB` additionally contains the delay-20 entry at `tick === t0+20 ±0`; (e) `getScheduledTicks().size` for these three is now 0 (fluid handlers may have enqueued follow-ups at the ticked cells — filter by position).
- **Screenshot:** `qa/W8/QA-W8-01-tick-queue.png`

#### QA-W8-02 — Emitter table + block-light BFS + rendered brightness
- **Verifies:** P1-19-2, P1-4-2
- **Gate:** caps `blockLight`
- **Steps:**
  1. `STAGE_ROOM`. Registry check: `getBlockDef('glowstone').emissive`, `getBlockDef('lava').emissive`, `getBlockDef('portal').emissive`, `getBlockDef('fire').emissive`.
  2. Aim at the room's far interior wall via `setLook` (player parked in the room at (21,60,0)); screenshot region R = central 200×200 px → `darkLum` (mean luminance).
  3. `setBlock(22,61,0,'glowstone')`. Read `getLight(22+d, 61, 0).block` for d ∈ {0,1,4,8,14}; `getLight(26,63,0).block` (taxicab 4+2); `getLight(26,61,2).block` (taxicab 4+2).
  4. Screenshot region R again → `litLum`.
  5. `setBlock(22,61,0,'air')`; re-read all step-3 cells.
- **Pass criteria:** (a) emissive: glowstone 15, lava 15, fire 15, portal **12** (code value; annotate `parity-delta: PARITY §19 says nether_portal 13`); (b) light = `15 − taxicab distance` exactly: d0→15, d1→14, d4→11, d8→7, d14→1, and both taxicab-6 probes → 9 (6-neighbor BFS, step −1 through air per `max(1, opacity)`); (c) `litLum ≥ 3 × darkLum`; (d) after removal every probed cell reads block 0 (decrease propagation) within ≤1 game tick.
- **Screenshot:** `qa/W8/QA-W8-02-blocklight-bfs.png` (lit state, F3 open)

#### QA-W8-03 — Opacity table: glass 0, opaque 15, water 1
- **Verifies:** P1-19-1
- **Gate:** caps `blockLight`
- **Steps:**
  1. `STAGE_ROOM`; emitter `setBlock(26,61,0,'glowstone')`.
  2. Control: `c = getLight(32,61,0).block` (6 air blocks away, expect 9).
  3. Glass wall: `setBlock(30,y,z,'glass')` for y∈[60..64], z∈[−3..3] (full cross-section). Re-read `g = getLight(32,61,0).block`.
  4. Stone wall: replace the same cells with `'stone'`. Re-read `s = getLight(32,61,0).block`.
  5. Water skylight: outdoors on the STAGE_FLAT surface, build a 1×1 glass tube x=10,z=10, walls y∈[100..104], open sky above; fill `setBlock(10,y,10,'water')` for y∈[101..104] (4 water); floor stone at y=100. Read `getLight(10,101,10).sky` — the LOWEST water cell, an air/fluid cell with a defined sky value (the stone floor cell (10,100,10) is opaque: a per-cell store returns 0 inside solids, and §2.2 does not pin any in-solid semantics — never probe it) — and control `getLight(12,100,12).sky` (open air, no roof — expect 15).
- **Pass criteria:** (a) `c === 9`; (b) `g === 9` — glass opacity 0 attenuates exactly like air (`max(1,0)=1` per block); (c) `s === 0` — opaque 15 kills the path (room is sealed; no alternate route); (d) water column: control sky 15; at the lowest water cell (10,101,10) sky = `15 − 3 = 12 ±0` (opacity-1 extra attenuation per water cell ABOVE the probe — 3 water cells at y∈[102..104]; the probed cell's own opacity does not attenuate the light arriving at it); (e) annotate `parity-delta: ice/slab position-dependent opacity N/A (blocks absent)`.
- **Screenshot:** `qa/W8/QA-W8-03-opacity.png`

#### QA-W8-04 — Light crosses chunk borders + incremental re-mesh both sides
- **Verifies:** P1-19-2 (cross-chunk propagation clause of §19's implementation note)
- **Gate:** caps `blockLight`
- **Steps:**
  1. Build a STAGE_ROOM variant straddling a chunk border: interior x∈[24..40] spans cx=1/cx=2 (border at x=32). Emitter `setBlock(31,61,0,'glowstone')` (local x=15 of cx=1 — border cell).
  2. Read `getLight(32,61,0).block` and `getLight(35,61,0).block` (cells in cx=2).
  3. Screenshot with both sides of the border in frame (player at (26,61,0), `setLook` down-corridor).
  4. `setBlock(31,61,0,'air')`; re-read both cells; screenshot again.
- **Pass criteria:** (a) `getLight(32,61,0).block === 14`, `getLight(35,61,0).block === 11` — BFS crossed the chunk boundary (`World.setBlock` border dirty-marking + light module's world-coord flood, plan cluster B); (b) the lit screenshot shows no brightness seam at x=32: mean luminance of two 60×120 px strips flanking the border differ by < 25%; (c) after removal both cells read 0 and both strips return to within 10% of the pre-emitter dark reading (both chunk meshes rebuilt — `engine/ChunkRenderer.js` rebuilds all `dirtyChunks` same frame).
- **Screenshot:** `qa/W8/QA-W8-04-crosschunk-light.png`

#### QA-W8-05 — Water spread runs on the tick queue (5gt cadence, range 7, down-flow)
- **Verifies:** P1-1-33 (fluid-flow client of the queue; water numbers are the §20 P0 substrate)
- **Gate:** caps `scheduledTicks` + `fluids`
- **Steps:**
  1. `STAGE_FLAT`; add a lower floor: `setBlock(x,95,z,'stone')` for x,z∈[−20..20]; punch a hole `setBlock(6,99,1,'air')`.
  2. `setTickFreeze(true)`; `setBlock(0,100,0,'water')` (source).
  3. `await stepTicks(5)`; record grid A = `getFluidState(x,100,z)` for x,z∈[−9..9]. `await stepTicks(45)`; record grid B. `await stepTicks(150)`; record grid C + `getFluidState(6,100,1)`, `getFluidState(6,96..99,1)`.
- **Pass criteria:** (a) grid A: fluid only at taxicab d ≤ 1 from the source (first ring at 5gt cadence; ±1 ring tolerance); (b) grid C: every reachable cell at taxicab d ≤ 7 has water with `level === d ±0`; zero cells at d = 8; source cell reads `{level:0, source:true}`; (c) down-flow: water present in the hole column — `getFluidState(6,96,1)` non-null with `falling:true` (flows down from y=99 to the y=95 floor and pools); (d) `getBlock` at flowing cells returns `'water'` (mesher-visible) but see QA-W8-13 for the no-replication assertion.
- **Screenshot:** `qa/W8/QA-W8-05-water-spread.png` (top-down `setLook(yaw, 89)` over the puddle, F3 open)

#### QA-W8-06 — Lava spread: overworld ≤3 @30gt, nether ≤7 @10gt
- **Verifies:** P1-20-2 (spread ranges + cadence)
- **Gate:** caps `scheduledTicks` + `fluids`; the nether half (step 3 / pass (b) and the nether side of (c)) additionally caps `nether` — same token QA-W3-16 and QA-W6-13's anchor sub-checks gate on, so SKIPPED-GATED evaluation stays mechanical and consistent across the plan
- **Steps:**
  1. `STAGE_FLAT`; `setTickFreeze(true)`; `setBlock(0,100,0,'lava')`.
  2. `await stepTicks(35)`; grid A (x,z∈[−5..5] at y=100 via `getFluidState`). `await stepTicks(35)`; grid B. `await stepTicks(200)`; grid C.
  3. Nether: switch via the game's QA path (`__game.setDimension('nether')` per docs/DEV.md, or the `__qa` shim equivalent); wait `getDimension().id === 'nether'` + `isColumnLoaded` at spawn; stage a netherrack platform `setBlock(x,60,z,'netherrack')` x,z∈[−10..10], air above (well over the y=31 lava sea); `setTickFreeze(true)`; `setBlock(0,61,0,'lava')`; `await stepTicks(15)` → grid N1; `await stepTicks(120)` → grid N2.
- **Pass criteria:** (a) grid A: lava only at d ≤ 1 (one ring after 35gt ≈ one 30gt step; ±1 ring); grid B: d ≤ 2; grid C: every cell d ≤ 3 has lava with `level === d`, **zero** cells at d = 4 (overworld range 3); (b) nether: N1 shows ≥1 ring within 15gt (10gt cadence), N2 reaches full extent d ≤ 7 with zero cells at d = 8; (c) ring-advance timing: consecutive ring appearances in the overworld batches are 30 ±5 gt apart, nether 10 ±3 gt (from `getTickLog` entries for the lava cells).
- **Screenshot:** `qa/W8/QA-W8-06-lava-spread.png` (overworld d≤3 pool, top-down, F3 open)

#### QA-W8-07 — Lava↔water products: obsidian / cobblestone / stone
- **Verifies:** P1-20-3
- **Gate:** caps `fluids`
- **Steps:**
  1. **Obsidian:** `STAGE_FLAT`; `setTickFreeze(true)`; `setBlock(0,100,0,'lava')` (source); `setBlock(1,100,0,'water')`; `await stepTicks(40)`; read `getBlock(0,100,0)`.
  2. **Cobblestone:** fresh area (x offset +10): lava source at (10,100,0); `stepTicks(120)` so flowing lava reaches (12,100,0) (`getFluidState(12,100,0).level ≥ 1`); then water source at (14,100,0); `stepTicks(60)`; read `getBlock(12,100,0)` and `getBlock(13,100,0)`.
  3. **Stone:** build a 3×3 water pool at y=100 (stone basin walls/floor at 99, water sources x,z∈[−14..−12]); ledge `setBlock(-13,103,-15,'stone')` with lava source on top at (−13,104,−15) positioned so flowing lava pours over the pool edge cell (−13,y,−14); `stepTicks(200)`; read the column (−13, 101..103, −14).
  4. **Basalt:** no step — record `SKIPPED-ANNOTATED: lava+soul_soil+blue_ice→basalt N/A (no soul_soil/blue_ice/basalt ids in registry — parity delta, P2 blocks)`.
- **Pass criteria:** (a) step 1: `getBlock(0,100,0) === 'obsidian'` within the 40gt window (lava **source** + water); the cell is no longer a fluid (`getFluidState` null); (b) step 2: at least one of the flowing-lava cells contacted by water reads `'cobblestone'`; the lava **source** at (10,100,0) is unchanged (`'lava'`); (c) step 3: exactly the falling-lava cell directly above the water surface reads `'stone'` (flowing lava down onto water); pool sources below survive; (d) all three products are durable: `getBlockState(cell).block` matches and survives a `stepTicks(100)` follow-up.
- **Screenshot:** `qa/W8/QA-W8-07-lava-water-products.png` (all three staging areas in one frame if possible, else the obsidian cell centered)

#### QA-W8-08 — Lava contact: 4 HP per 0.5 s + ignition (fireTicks)
- **Verifies:** P1-20-2 (contact clause)
- **Gate:** caps `fluids` + `damage` (W2's `getHealth`/`getLastHurt`; absent → `SKIPPED-GATED: damage`)
- **Steps:**
  1. `STAGE_FLAT`; `__qa.setGameMode('survival')`; build a lava pit: `setBlock(x,99,z,'stone')` then `setBlock(x,100,z,'lava')` for x,z∈[4..6], stone rim at y=100 around it.
  2. Note `h0 = getHealth().health`; `await __qa.tp(5, 100.1, 5)` (feet in lava); sample `getHealth()` + `getLastHurt()` every tick for 30gt.
  3. `await __qa.tp(0, 100, 0)` (out, onto dry stone); sample `getHealth()` every tick for 40gt more.
- **Pass criteria:** (a) in-lava: health decrements in steps of 4 HP (armor 0) with consecutive decrements 10 ±2 gt apart; `getLastHurt().sourceType` reflects lava; (b) after exit: at least one further 1-HP decrement within 30gt (fireTicks burn — ignited by contact). Cadence tolerance 10–25 gt between burn ticks, covering the PARITY-internal conflict (§9 says 1 HP/0.5 s, §20 says 1 HP/s — W2's table is authoritative; annotate which cadence was observed); (c) player does not die (abort via `tp` to safety if health ≤ 6).
- **Screenshot:** `qa/W8/QA-W8-08-lava-contact.png` (HUD vitality shards visible mid-drain)

#### QA-W8-09 — Fire: age, spread volume, burn-out, eternal netherrack, doFireTick
- **Verifies:** P1-20-4 (with P1-4-8 `age` prop overlap)
- **Gate:** caps `fire` (+ `scheduledTicks`)
- **Steps:**
  1. `STAGE_FLAT`; `setTickFreeze(true)`.
  2. **Age/prop:** `setBlock(2,100,2,'fire')` (on stone); read `a0 = getBlockState(2,100,2).props.age`; `await stepTicks(45)`; read `a1`.
  3. **Burn-out:** keep stepping in 100gt batches until `getBlock(2,100,2) === 'air'`, max 1500gt; record extinction tick.
  4. **Spread:** planks wall `setBlock(10,y,0,'planks')` for y∈[100..103] plus `setBlock(11,100,0,'planks')`; ignite `setBlock(9,100,0,'fire')`; `await stepTicks(1200)`; snapshot all planks cells + every cell in the scan volume (x∈[8..12], z∈[−1..1], y∈[99..107]).
  5. **Eternal:** `setBlock(-5,100,-5,'netherrack')`, `setBlock(-5,101,-5,'fire')`; `await stepTicks(2400)`; read the cell.
  6. **doFireTick:** `__qa.setGameRule('doFireTick', false)` (the §2.1-4 resolved mutator — W8's `setRule` name is dropped); fresh fire on stone at (2,100,6) + planks at (3,100,6); `await stepTicks(600)`; read fire age + planks.
- **Pass criteria:** (a) `a0 === 0` and `a1 ≥ 1` with age ∈ [0,15] always (30gt+rng·10 reschedule cadence ⇒ ≥1 increment in 45gt); (b) isolated fire on stone extinguishes within [60, 1500] gt; (c) spread: ≥1 planks cell consumed (now `'air'` or `'fire'`) within 1200gt AND every new fire cell that appeared lies inside the vanilla scan volume of a pre-existing fire (Δx,Δz ∈ ±1, Δy ∈ [−1,+4]); leaves/log flammability rows exist: `getBlockDef` sidecar check via a one-off `getCaps()` token is NOT required — assert via behavior only; (d) fire on netherrack still `'fire'` after 2400gt (eternal; annotate `magma N/A — id absent`); (e) with doFireTick false: age unchanged (±0) and planks intact after 600gt.
- **Screenshot:** `qa/W8/QA-W8-09-fire-spread.png` (burning planks wall, F3 open)

#### QA-W8-10 — Gravity blocks fall as FallingBlockEntity; land-place vs drop-as-item
- **Verifies:** P1-4-1, P1-8-19
- **Gate:** caps `fallingBlocks`
- **Steps:**
  1. `STAGE_FLAT`; `setTickFreeze(true)`.
  2. For each `b ∈ ['sand','gravel','red_sand']`: `setBlock(0,105,0,b)` (air below down to the y=99 platform); `await stepTicks(2)` (schedule delay); assert entity appears; then step in 1gt increments recording `getEntities('falling_block')[0]` pos/vel until it disappears (≤ 40gt); read `getBlock(0,100,0)`; then `setBlock(0,100,0,'air')` to reset. Control: `setBlock(0,105,0,'stone')`; `await stepTicks(10)`.
  3. **Support removal:** `setBlock(5,100,5,'stone')`, `setBlock(5,101,5,'sand')`; `await stepTicks(2)` (no fall — supported); `setBlock(5,100,5,'air')`; `await stepTicks(30)`; read `getBlock(5,100,5)`.
  4. **Drop-as-item:** `const id = await __qa.spawnFallingBlock(8, 110, 8, 'sand')`; step 1gt at a time; when the entity's `pos.y ∈ [104.1, 104.9]`, `setBlock(8,104,8,'stone')` (fills the cell it is falling through); continue 20gt; read `getEntityEvents(10)` and the column (8, 100..110, 8).
- **Pass criteria:** (a) step 2, each gravity id: block at (0,105,0) becomes `'air'` within 2gt of placement and exactly one `'falling_block'` entity exists; while airborne `vel.y` slope ≈ **−16 b/s² ±20%** (W3 `entityPhysics` PHYS.falling_block, vanilla 0.04 b/t² converted); on landing `getBlock(0,100,0) === b` and the entity is removed, with a `fallingBlockLand` event; control stone never falls (still at (0,105,0)); (b) step 3: supported sand does not fall; after support removal it re-places at (5,100,5) within 30gt; (c) step 4: a `fallingBlockDrop` event fires with `blockId:'sand'`; **no** sand block placed anywhere in the probed column; if `getCaps()` includes W5's item-entity token, additionally assert one `'item'` entity spawned near the drop pos — else annotate `drop-event-only (W5 item entities absent)`; (d) annotate `N/A — anvil/pointed_dripstone fall damage + concrete_powder→concrete (ids absent, parity delta)`.
- **Screenshot:** `qa/W8/QA-W8-10-falling-blocks.png` (entity mid-fall — pause stepping with the entity airborne)

#### QA-W8-11 — PrimedTnt: 80gt fuse, upward launch, power-4 explosion, obsidian survives, chain ignite
- **Verifies:** P1-8-20
- **Gate:** caps `tnt`
- **Steps:**
  1. `STAGE_FLAT` variant: field `setBlock(x,99,z,'dirt')` + `setBlock(x,98,z,'dirt')` for x,z∈[−8..8] (stone below at 97). Pre-place `setBlock(2,100,0,'obsidian')` and `setBlock(-2,100,0,'tnt')`. Player at (0,100,14) (creative — no self-damage concern; if `damage` cap present, record knockback/damage as bonus, not required).
  2. `setBlock(0,100,0,'tnt')`; `setTickFreeze(true)`; `const t0 = __qa.getGameTick()`; `const id = await __qa.igniteTnt(0,100,0)`; `await stepTicks(1)` (with the stepper frozen, gameTick stays at t0 until stepped — the sample point needs this explicit tick); sample `getEntities('tnt')` at t0+1.
  3. `await stepTicks(77)` (cumulative t0+78); assert still no explosion event; `await stepTicks(4)` (cumulative t0+82); read `getEntityEvents(20)`.
  4. Census: for every cell in the box x,z∈[−8..8], y∈[96..104], read `getBlock`; also `getEntities('tnt')` and `getEntityEvents(20)` for the chain; `await stepTicks(35)`; read events again.
- **Pass criteria:** (a) ignition: `getBlock(0,100,0) === 'air'` immediately and exactly one `'tnt'` entity with `vel.y = 4 ± 1` b/s at first sample (0.2 b/t launch, per-second convention); (b) explosion event tick = `t0 + 80 ± 2`; (c) crater: ≥ 15 dirt cells destroyed within Euclidean r ≤ 5 of (0.5,100.5,0.5); **zero** block changes at r > 8 (power-4 ray reach bound); (d) obsidian at (2,100,0) intact (BLAST_RESISTANCE 1200); (e) chain: the tnt block at (−2,100,0) is gone AND a `tntPrimed` event fired for it; its follow-up explosion event arrives 10–30 gt (+2 tolerance) after the first (randomized short fuse); (f) `explosionDrops` event present with `power:4`; item drops annotated `W5-gated`.
- **Screenshot:** `qa/W8/QA-W8-11-tnt-crater.png` (crater centered, obsidian visible, F3 open)

#### QA-W8-12 — Blockstate props sidecar: round-trip, schema strip, clear-on-change, persistence
- **Verifies:** P1-4-8
- **Gate:** caps `blockProps`
- **Steps:**
  1. `STAGE_FLAT`; `setTickFreeze(true)` (so fire age doesn't advance mid-assert). `await __qa.setBlockState(4,100,4,'fire',{age:7})`; read `s1 = getBlockState(4,100,4)`.
  2. Schema strip: `await __qa.setBlockState(6,100,4,'fire',{age:3, bogusKey:'x', level:99})`; read `s2`.
  3. Clear-on-change: `setBlock(4,100,4,'stone')`; read `s3 = getBlockState(4,100,4)`.
  4. Persistence: `await __qa.setBlockState(8,100,4,'fire',{age:5})`; wait 3 s wall-clock (> server `SAVE_DEBOUNCE_MS` 2000); quit to title (Esc → pause → Quit per `ui/menu.js` flow); re-enter WORLD_B via the world-select flow; `waitForFunction(() => __qa.isColumnLoaded(8,4))`; read `s4 = getBlockState(8,100,4)`.
  5. Reserved keys: `PROPS_SCHEMA` exposure — `getBlockDef('fire')` is not required to carry props; instead assert `setBlockState(10,100,4,'tnt',{powered:true})` does not throw and round-trips (`powered` is a registered future-redstone key on the schema).
- **Pass criteria:** (a) `s1` deep-equals `{block:'fire', props:{age:7}}`; (b) `s2.props.age === 3`, `bogusKey` absent, and `level` either clamped to the schema range 0–7 or stripped (assert NOT 99 — server/client validation per plan cluster E, mirroring the edits "invalid silently skipped" semantics); (c) `s3.props` is `{}` (sidecar cleared when the id changed); (d) `s4.props.age === 5` — props survived save/quit/reload via the additive `edit.props` field and `welcome.world.edits` value shape `{id, props}`; (e) step 5 round-trips `powered:true`; (f) annotate: interim W4/W6 stage-ids (wheat_0..7 etc.) still id-based until the owning waves execute `migrateStageIds` — `migration-pending`, not FAIL.
- **Screenshot:** `qa/W8/QA-W8-12-blockstate-props.png` (F3 open aimed at the fire cell)

#### QA-W8-13 — Multiplayer: flowing cells never sent; products replicate once and converge
- **Verifies:** P1-1-33 + P1-20-3 under the client-sim convergence rule (plan governing delta 1)
- **Gate:** caps `fluids` (two-client staging per QA_PLAN §2 S9 pattern)
- **Steps:**
  1. Client A (page 1) in WORLD_B; client B (page 2, second context) joins the same world id; both `waitForFunction(isColumnLoaded)` at the staging area. On A: `cdp.send('Network.enable')` + collect `Network.webSocketFrameSent` (JSON `t:'edit'` frames, §1.9). Do NOT freeze ticks (real-time; both sims run).
  2. On A: `setBlock(0,100,0,'lava')` then `setBlock(3,100,0,'water')` (two source placements on the STAGE_FLAT platform, staged pre-collection so only the interaction window is sniffed; start frame collection immediately after the second placement).
  3. Wait 15 s wall-clock. On B: poll `getBlock` over x∈[0..3], z=0, y=100 and `getFluidState(2,100,0)`.
  4. Tally A's sent `edit` frames from the collection window by target cell and block id; same on B (second CDP session).
- **Pass criteria:** (a) B converges: at least one product cell (`'cobblestone'` or `'obsidian'` per the QA-W8-07 geometry) reads identically on A and B within 15 s; (b) B's `getFluidState` shows flowing water cells locally even though **zero** `edit` frames in either client's window carried a flowing-cell update (no frame whose (x,y,z) is a derived flow cell — flowing state is derived, never replicated); (c) product-cell `edit` frames number ≤ 2 per product cell across BOTH clients combined (both sims may race to the same durable conclusion; the `World.setBlock` same-value guard suppresses re-broadcast loops), and all frames for one cell carry the same block id (absolute-edit convergence); (d) neither client's console has error-level entries during the window.
- **Screenshot:** `qa/W8/QA-W8-13-mp-fluid-convergence.png` (client B's view of the product cell, F3 open)

---

## Coverage

| Wave | Tests | Ids |
|---|---:|---|
| W1 | 19 | QA-W1-01 … QA-W1-19 |
| W2 | 27 | QA-W2-01 … QA-W2-27 |
| W3 | 16 | QA-W3-01 … QA-W3-16 |
| W4 | 15 | QA-W4-01 … QA-W4-15 |
| W5 | 17 | QA-W5-01 … QA-W5-17 |
| W6 | 16 | QA-W6-01 … QA-W6-16 |
| W7 | 17 | QA-W7-01 … QA-W7-17 |
| W8 | 13 | QA-W8-01 … QA-W8-13 |
| **Total** | **140** | |

Every wave's tests are self-staging (fixtures live in each wave section) and cap-gated on the §2.4 tokens, so the suite degrades gracefully to whatever set of waves has merged. Item-level traceability (which PARITY P1 refs each test verifies) is carried in each test's **Verifies:** line; the wave→item partition itself is proven in P1_WORKPLAN.md's coverage appendix.
