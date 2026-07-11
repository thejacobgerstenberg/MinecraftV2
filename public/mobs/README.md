# Loomfall Mobs Package

> **INTEGRATED** (public/mobs/): this package is now wired into the game via
> `public/src/main.js` — `three` resolves through the game page's importmap
> (`public/vendor/three.module.js`), the real block registry
> (`public/src/blocks/blocks.js`) is both the injected AND the fallback
> `getBlockDef`, and the standalone harness files this README mentions
> (`vendor/three.module.js`, `blocksAdapter.js`, `demo.html`, `serve.mjs`,
> `world/StubWorld.js`, `screenshots/`) were removed at integration time.
> Sections below describing them are kept as historical reference.

`mobs/` is a self-contained package implementing the Loomfall creature
archetypes as living, animated THREE.js entities plus the AI/physics/spawn
manager that drives them in the game world. It has no dependency on any
other in-repo system except `three` (imported as the bare specifier
`"three"`) and, optionally, a real block-definition lookup the game builder
will inject once it exists.

**Phase 2** added four new creatures (`bobbindeer`, `frayedhound`,
`emberspinner`, `unpicked`) and the Nevermend boss (`lastneedle`, "The Last
Needle"), plus loot drops, ambient despawn, smarter navigation (step-up
hops, cliff avoidance, flyer terrain-avoidance), and dimension-id
reconciliation with the real game engine (`overworld`/`nether`/`end`).

**Canon reconciliation pass** aligned every archetype's stats, palette, and
drops against the Loomfall canon data (`content/naming.json`,
`content/bestiary.json`, `content/boss.json`, `content/items.json` on
`feature/story-content`) and added three more creatures — `needlejack`,
`scaldwarden`, `raveler` — bringing the roster to **13 species + the
boss**. Loot now uses REAL item/block ids from the canonical content
registry, every event detail carries a `canonicalId`, and The Last Needle's
defeat path was rewritten to match canon: it is **bound, not killed**, and
drops nothing. See "Canonical alignment" below.

All of this work lives in `mobs/MobManager.js`, `mobs/lootTables.js`,
`mobs/spawnRules.js`, `mobs/ai.js`, `mobs/blocksAdapter.js`,
`mobs/world/StubWorld.js`, `mobs/demo.html`, and the thirteen creature files
under `mobs/creatures/`.

## What's in here

| File | Purpose |
|---|---|
| `mobs/creatures/*.js` | One file per archetype. Each exports `build()` (returns a `THREE.Group`) and `meta` (species/lore/palette/`canonicalId`). Thirteen files: `grazer`, `trader`, `groaner`, `exploder`, `screecher`, `bobbindeer`, `frayedhound`, `emberspinner`, `unpicked`, `needlejack`, `scaldwarden`, `raveler`, `lastneedle`. |
| `mobs/MobManager.js` | `export class MobManager extends EventTarget` (also the default export). Owns spawning, AI, physics stepping, and animation-driving for all live mob instances, including the boss. |
| `mobs/ai.js` | Pure helper functions (gravity, collision resolution, wander/seek/flee steering, grounded step-up/cliff-avoid navigation, flyer terrain-avoidance). Takes an `isSolid(x,y,z)` predicate as a parameter — no direct world/block imports. |
| `mobs/spawnRules.js` | Per-dimension, day/night-aware weighted spawn tables (`SPAWN_TABLES`, `pickSpawn`, `maxAliveFor`), the archetype → canonical entity id map (`CANONICAL_ID`, `canonicalIdFor`), dimension-id reconciliation (`normalizeDimension`, `DIMENSION_ALIASES`), and despawn rules (`DESPAWN_CONFIG`, `shouldDespawn`). |
| `mobs/lootTables.js` | Per-archetype loot tables (`LOOT_TABLES`) and `rollLoot(archetype, rng)`. Item ids are the REAL canonical ids from `content/items.json`/`content/naming.json` — see "Loot" below. |
| `mobs/blocksAdapter.js` | **Fallback** `getBlockDef(id)` shim — see "World contract" below. |
| `mobs/world/StubWorld.js` | Minimal `getBlock(x,y,z)` implementation used by demos/tests only. Supports a flat boss-arena mode (`new StubWorld({arena:true})`). |
| `mobs/demo.html` + `mobs/vendor/three.module.js` | Standalone browser harness (see "Running the demo" below). |
| `mobs/serve.mjs` | Zero-dependency static file server for local demo/testing. |

## Roster: 13 species + the boss

Canonical species names, snake_case `canonicalId` (via
`spawnRules.canonicalIdFor(archetype)`), default dimension, canon stats
(`hp` / `dmg` / `spd` from `content/bestiary.json`), and the `aiBase`
behaviour each archetype runs under in `MobManager`:

| Archetype | Species | `canonicalId` | Dimension | hp | dmg | spd | `aiBase` |
|---|---|---|---|---:|---:|---:|---|
| `grazer` | Skeinling | `skeinling` | Warpwold | 8 | 0 | 2.5 | `grazer` |
| `bobbindeer` | Bobbin-deer | `bobbin_deer` | Warpwold | 14 | 0 | 6 | `grazer` |
| `trader` | Wickerkin | `wickerkin` | Warpwold | 20 | 0 | 3.5 | `trader` |
| `needlejack` | Needlejack | `needlejack` | Warpwold | 18 | 4 | 4.5 | `groaner` |
| `groaner` | Understruck | `understruck` | Warpwold | 24 | 5 | 3.5 | `groaner` |
| `frayedhound` | Frayed Hound | `frayed_hound` | Warpwold | 14 | 3 | 6 | `groaner` |
| `emberspinner` | Emberspinner | `emberspinner` | Cinderloom | 22 | 5 | 4 | `groaner` |
| `exploder` | Waxling | `waxling` | Cinderloom | 10 | 7 | 3.5 | `exploder` |
| `scaldwarden` | Scaldwarden | `scaldwarden` | Cinderloom | 40 | 6 | 3 | `trader` |
| `screecher` | Slagmoth | `slagmoth` | Cinderloom | 12 | 3 | 7 | `screecher` |
| `unpicked` | The Unpicked | `unpicked` | Nevermend | 26 | 6 | 3 | `groaner` |
| `raveler` | Raveler | `raveler` | Nevermend | 18 | 5 | 8 | `groaner` |
| `lastneedle` (BOSS) | The Last Needle | `last_needle` | Nevermend | 600(sim) | 14 | — | `boss` |

Notes on this table:

- `dmg` maps to `ARCHETYPE_CONFIG[*].contactDamage` for melee attackers, to
  `blastDamage` for `exploder` (it has no contact attack, only its
  detonation), and is stored-but-currently-inert on `scaldwarden` (see
  below).
- `aiBase` (an `ARCHETYPE_CONFIG[*].aiBase` field in `MobManager.js`)
  selects which internal `_ai*()` behaviour function `_updateMobAI`
  dispatches to; it is independent of the archetype's spawn-table/registry
  key, which is why `bobbindeer`/`frayedhound`/`emberspinner`/`unpicked`/
  `needlejack`/`raveler` each reuse the `grazer` or `groaner` behaviour loop
  but with their own canon-derived tuning
  (`ARCHETYPE_CONFIG[mob.archetype]` is looked up per-mob, not hardcoded
  per `aiBase`).
- **`scaldwarden` is a known simplification.** Canon describes it as
  "passive unless provoked" (attacks only after something is stolen from
  its forge). The AI set here has no provoke/retaliate mechanic, so
  `scaldwarden` runs the fully-neutral `trader` `aiBase` (idles/tethers,
  never attacks) — canon's `dmg6` is kept in config for a future provoke
  feature but is never read by any current code path. `scaldwarden` is also
  exempt from ambient despawn (`spawnRules.DESPAWN_CONFIG.exemptArchetypes`)
  since it's a stationary guardian tied to its Cinderloom post.
- **`speed` reconciliation.** Canon gives one `spd` figure per creature,
  but several `aiBase` behaviours split a calmer ambient-wander pace from a
  more urgent combat/flee pace (two config fields: `speed` vs
  `fleeSpeed`/`seekSpeed`). Where that split exists, canon `spd` is applied
  to the URGENT field (the number that actually governs player-facing
  pacing/difficulty), and the calmer ambient `speed` is derived
  proportionally below it. Archetypes with only a single `speed` field used
  directly (`trader`, `exploder`, `screecher`) take canon `spd` directly.
  See the "Canonical stats note" comment at the top of
  `ARCHETYPE_CONFIG` in `MobManager.js` for the exact derivation.
- **The Last Needle's `spd`**: `content/bestiary.json` lists `spd: 12` for
  `last_needle`, but that figure describes the full stitching-encounter
  from `content/boss.json` (horizon-long dive passes, sweeps, etc.), not a
  literal per-second movement speed comparable to the other archetypes'
  grounded/hover `spd` values. This sim's boss speed/seek-speed/phase
  speed-multiplier tuning was left at its pre-existing hand-tuned values
  rather than substituting `12` directly — flagged here as a discrepancy
  worth a second look, not applied to `ARCHETYPE_CONFIG.lastneedle` as part
  of this reconciliation pass.

Note: `groaner`, `exploder`, and `screecher` also appear (at different
weights) in `nevermend`'s and `cinderloom`'s spawn tables; `warpwold` spawns
`groaner`/`frayedhound`/`needlejack`/`screecher` at night. `lastneedle`
never appears in any `SPAWN_TABLES` entry — the boss is always
hand-triggered via `spawn()`/`spawnBoss()`, never picked by the ambient
random-spawn cadence. See "Dimension / day-night spawn rules" below for the
exact weighted tables.

## MobManager API (exact, from source)

```js
import MobManager from './mobs/MobManager.js'; // also a named export

const manager = new MobManager(scene, world, {
  getPlayerPos,     // () => {x,y,z}  — REQUIRED for aggro/attack/flee behaviour;
                     //                  guarded internally if missing or throws.
  onPlayerHurt,      // (dmg:number) => void — called when a hostile mob hits the player.
  getBlockDef,       // optional (id:number) => {solid:boolean, ...} — see World contract below.
  isDay,             // optional () => boolean — defaults to always-day (true).
  rng,               // optional () => number in [0,1) — defaults to Math.random.
  dimension,         // optional string — defaults to 'warpwold'. Accepts either an
                      //  engine id ('overworld'/'nether'/'end') or a display-name
                      //  key ('warpwold'/'cinderloom'/'nevermend'); see "World
                      //  contract" below.
  maxMobs,           // optional number — overrides spawnRules' per-dimension cap.
  onEvent,           // optional (name:string, detail:object) => void — see Events below.
});
```

Required contract methods:

```js
manager.update(dt);        // step spawning, AI, physics, animation for one frame (dt in seconds)
manager.setDimension(id);  // despawns everyone, switches rule set, resumes spawning.
                            // `id` accepts an engine id OR a display-name key (see below).
manager.dispose();         // removes all mobs from the scene, drops references
```

Non-breaking additions (safe for the builder to use, not required by the
original contract):

```js
manager.spawn(archetype, pos);  // -> mob | null. Force-spawns at pos:{x,y,z},
                                 //    bypassing spawn-rule weighting/cadence AND the
                                 //    ambient max-alive cap. Used by the demo's
                                 //    __forceSpawnAll() and internally for boss adds.
manager.spawnBoss(pos);         // -> mob | null. Thin wrapper over spawn('lastneedle', pos).
manager.mobs;                    // getter -> array snapshot of live mob objects
manager.setDay(isDay: boolean);  // override day/night without opts.isDay
```

### Per-mob object shape

```js
{
  id, archetype, species, canonicalId,  // e.g. 'exploder', 'Waxling', 'waxling'
  group,                            // THREE.Group (the visual root, already added to scene)
  headAnchor,                       // THREE.Object3D | null — for floating name tags/UI
  hp, maxHp,
  position: {x,y,z},                // live-synced each frame, plain object (not a THREE.Vector3)
  velocity: {x,y,z},
  grounded,                         // boolean
  spawnPos: {x,y,z},                // ground/anchor y — NOT hover-adjusted even for flyers
  fuse,                             // 0..1, exploder only
  ageSeconds,                       // accumulator since spawn; feeds the despawn sweep
  attackFlash,                      // 0..1, generic to ALL mobs (not just the boss); spikes to
                                     //   1.0 on attack, decays over ATTACK_FLASH_DURATION=0.35s;
                                     //   fed into animate() as state.attack
  isBoss,                           // boolean; true only for lastneedle
  bossPhase,                        // 0/1/2, boss-only (always 0 for non-boss mobs); fed into
                                     //   animate() as state.phase
  spawnedBy,                        // id of the boss mob that summoned this add (phase-1/phase-2
                                     //   'raveler'/'unpicked' summons), else null
  dead,                             // boolean
  hurt(dmg),                        // call to damage this mob; may kill it and emit mobDeath
                                     //   + mobDrop (or, for the boss, bossDefeated with NO mobDrop)
}
```

## World contract

`MobManager` expects `world.getBlock(x, y, z) -> blockId`. Solidity is then
resolved via `getBlockDef(blockId).solid`:

- If `opts.getBlockDef` is provided, it is used.
- Otherwise `MobManager` falls back to `mobs/blocksAdapter.js`'s
  `getBlockDef`, a numeric-id-aware placeholder table.

**Reconciled with the real builder world (numeric block ids).**
`world.getBlock` in the real game (branch `feat/voxel-sandbox-game`, via
`public/src/blocks/blocks.js`) always returns a **numeric** block id in
`[0, 29]` — never a string, never `undefined`. `mobs/blocksAdapter.js`'s
`BLOCK_ID` table mirrors those ids exactly (`GRASS: 1`, `STONE: 3`,
`BEDROCK: 17`, `END_STONE: 26`, etc. — do not renumber them), and
`mobs/world/StubWorld.js`'s `getBlock()` returns these same numeric ids for
both its default test terrain and its arena mode. Legacy string ids
(`'air'`, `'threadstone'`, `'warpgrass'`, ...) are kept in
`blocksAdapter.js` only as back-compat aliases for old test doubles — new
code should use numeric ids.

**`mobs/blocksAdapter.js` is a fallback, not the source of truth.** Once
the builder ships the real block registry, inject it like this:

```js
import { getBlockDef } from '../public/src/blocks/blocks.js';
const manager = new MobManager(scene, world, { getBlockDef, /* ... */ });
```

Everything in `mobs/ai.js` takes `isSolid(x,y,z)` as a parameter rather
than importing a block module directly, so swapping in the real block
registry requires no changes to `ai.js` or the creature files — only the
`getBlockDef` passed into `MobManager`'s constructor opts.

Out-of-range/missing-world/throwing-getBlock cases all resolve to
non-solid (air) inside `MobManager._isSolid`, so mobs never get stuck on
undefined terrain. A throwing/broken `getBlockDef` resolves to solid
(`true`), per `blocksAdapter.js`'s policy of "unknown/broken def is safer
assumed solid" for that specific failure mode.

### Dimension-id reconciliation

The game engine identifies dimensions by **engine id**
(`'overworld'`/`'nether'`/`'end'`), which correspond to Loomfall's
display-named `warpwold`/`cinderloom`/`nevermend` respectively. Every
dimension-accepting entry point in this package — `MobManager`'s
`dimension` constructor opt, `manager.setDimension(id)`, and
`spawnRules.getTable`/`pickSpawn`/`maxAliveFor` — normalizes its input via
`spawnRules.normalizeDimension(id)` first, so callers may pass **either**
form interchangeably and case-insensitively:

```js
manager.setDimension('end');        // -> canonical 'nevermend'
manager.setDimension('nevermend');  // -> canonical 'nevermend' (same result)
```

`this.dimension` always stores the canonical display-name key
(`'warpwold'`/`'cinderloom'`/`'nevermend'`), which is also what's passed as
`state.dimension` into each creature's `animate()`. Unknown/missing input
defaults to `'warpwold'`.

## Canonical alignment

Every archetype key used throughout this package (registry key, spawn-table
slot, `ARCHETYPE_CONFIG` key) is a **spawn-table slot key** — a naming
convention internal to `mobs/`. It maps 1:1 to the stable, snake_case
**canonical entity id** used by the rest of the game (persistence,
networking, achievement/victory triggers, asset lookups) via
`spawnRules.CANONICAL_ID` / `spawnRules.canonicalIdFor(archetype)`:

```js
import { canonicalIdFor } from './spawnRules.js';
canonicalIdFor('lastneedle'); // -> 'last_needle'
canonicalIdFor('bobbindeer'); // -> 'bobbin_deer'
canonicalIdFor('raveler');    // -> 'raveler'
```

`MobManager.spawn()` stamps `mob.canonicalId = canonicalIdFor(mob.archetype)`
on every mob it creates, and **every** emitted event detail
(`mobSpawn`/`mobHurt`/`mobDeath`/`mobAttack`/`mobDrop`/`mobDespawn`/
`bossDefeated`) includes both `archetype` (the internal slot key) and
`canonicalId` (the stable external id), so downstream systems (audio,
achievements, the ending sequencer) can match against canonical ids instead
of hardcoding `mobs/`-internal archetype strings. Each creature module's own
`meta.canonicalId` field (in every `mobs/creatures/*.js`) mirrors the same
value, so the mapping is consistent whether you're reading a live `mob`
object, an event `detail`, or a creature module's static `meta`.

## Events

`MobManager` emits seven event names, both as `CustomEvent` (via its
`EventTarget` base — use `manager.addEventListener(name, handler)`) **and**
via `opts.onEvent(name, detail)` if provided. Every detail below includes
both `archetype` and `canonicalId` (see "Canonical alignment" above):

- `'mobSpawn'` — `{ archetype, canonicalId, species, mob, position }`
- `'mobHurt'` — `{ archetype, canonicalId, species, mob, position, dmg }`
- `'mobDeath'` — `{ archetype, canonicalId, species, mob, position }` — **not**
  emitted for the boss; see `'bossDefeated'` below.
- `'mobAttack'` — `{ archetype, canonicalId, species, mob, position, dmg }`,
  plus for exploder detonations: `{ explosion: true, hitPlayer: boolean }`
- `'mobDrop'` — `{ mobId, archetype, canonicalId, itemId, pos:{x,y,z}, count }`
  — one event per dropped item stack, computed via `lootTables.rollLoot()`
  and emitted immediately after `'mobDeath'`. Note the field is `pos`, not
  `position`, and there is no `species`/`mob` field on this event. **Never**
  emitted for a boss (see `'bossDefeated'`); archetypes with an empty loot
  table (`unpicked`) naturally produce zero `'mobDrop'` events too, since
  `rollLoot()` returns `[]`.
- `'mobDespawn'` — `{ archetype, canonicalId, species, mob, position }` — a
  quiet ambient distance/age removal (see "Despawn rules" below); **no**
  loot is rolled for a despawn.
- `'bossDefeated'` — `{ archetype:'lastneedle', canonicalId:'last_needle',
  species, mob, position, bound:true, victoryTrigger:'kill_entity:last_needle',
  achievement:'taught_to_mend' }` — emitted **instead of** `'mobDeath'` when
  the boss's hp reaches 0. The Last Needle is **bound, not killed**, and has
  no loot table, so **no `'mobDrop'` is ever emitted for it** — see "The
  boss: The Last Needle" below.

`position`/`pos` is a plain `{x,y,z}` snapshot at emit time (not a live
reference). `mob` is the live per-mob object described above (absent on
`'mobDrop'`).

### Wiring to the audio engine

The audio engine lives on `feature/audio-engine` and is **not** a
dependency of this package (by design — `mobs/` must build/run
standalone). When integrating, something like:

```js
manager.addEventListener('mobSpawn', (e) => {
  const { archetype, canonicalId, position } = e.detail;
  audio.play(`mob.${archetype}.spawn`, { pos: position, volume: 0.6 });
});
manager.addEventListener('mobHurt', (e) => {
  audio.play(`mob.${e.detail.archetype}.hurt`, { pos: e.detail.position, volume: 0.8 });
});
manager.addEventListener('mobDeath', (e) => {
  audio.play(`mob.${e.detail.archetype}.death`, { pos: e.detail.position, volume: 1.0 });
});
manager.addEventListener('mobAttack', (e) => {
  const variant = e.detail.explosion ? 'explode' : 'attack';
  audio.play(`mob.${e.detail.archetype}.${variant}`, { pos: e.detail.position, volume: 1.0 });
});
manager.addEventListener('bossDefeated', (e) => {
  audio.play('mob.lastneedle.bound', { pos: e.detail.position, volume: 1.0 });
});
manager.addEventListener('mobDrop', (e) => {
  audio.play('loot.pickup_ping', { pos: e.detail.pos, volume: 0.4 });
});
```

The suggested sound-key convention is `"mob." + archetype + "." + variant`
(e.g. `mob.exploder.explode`, `mob.grazer.spawn`, `mob.groaner.attack`).
The same events are a natural hook for achievements (e.g. "first
Understruck defeated" on a `mobDeath` where `canonicalId === 'understruck'`,
or `taught_to_mend` on `bossDefeated` — see below).

## Loot

`mobs/lootTables.js` defines `LOOT_TABLES` (archetype → array of
`{ itemId, chance, min, max }`) and `rollLoot(archetype, rng)`, which
independently rolls each entry's `chance` and returns
`[{ itemId, count }, ...]` for the hits. `MobManager._dropLoot(mob)` calls
this after every `mobDeath` (never for the boss, never on `mobDespawn`) and
emits one `'mobDrop'` event per resulting stack.

**Item ids are the REAL canonical ids** from `content/items.json` (crafting
materials) and `content/naming.json`'s `blocks` array (raw/gathered
materials — several canon "item" drops, e.g. `raw_skein`, `needle_iron`,
`voidknot`, are actually block ids in the naming registry, per
`content/bestiary.json`'s own drop-id convention: "Drop ids reference
items.json item ids or naming.json block ids only"). No placeholder/stub
strings remain in any table:

| Archetype | Item/block ids | Source |
|---|---|---|
| `grazer` | `raw_skein` | naming.json block |
| `bobbindeer` | `thread_sinew`, `hide_cloth` | items.json |
| `trader` | `knot_charm`, `lore_scroll` | items.json |
| `needlejack` | `thread_sinew`, `needle_iron` | items.json / naming.json block |
| `groaner` | `loose_thread` | items.json |
| `frayedhound` | `thread_sinew`, `hide_cloth` | items.json |
| `emberspinner` | `scorched_silk` | items.json |
| `exploder` | `tallowstone` | naming.json block |
| `scaldwarden` | `emberskein_ore`, `scorched_silk` | naming.json block / items.json |
| `screecher` | `cinderthread` | naming.json block |
| `unpicked` | **none** — drops nothing (canonical: leaves no corpse) | — |
| `raveler` | `loose_thread`, `voidknot` | items.json / naming.json block |
| `lastneedle` (BOSS) | **none** — drops nothing (canonical: bound, not killed; no loot table) | — |

Wiring into the builder's Inventory system:

```js
manager.addEventListener('mobDrop', (e) => {
  const { itemId, count, pos } = e.detail;
  inventory.addOrSpawnPickup(itemId, count, pos); // itemId is a real content/items.json / naming.json id
});
```

## The boss: The Last Needle

`lastneedle` (species **The Last Needle**, `canonicalId: 'last_needle'`) is
the Nevermend final boss: `aiBase: 'boss'`, `isBoss: true`, flies. It is
**never** listed in `spawnRules.SPAWN_TABLES` — it's hand-triggered via
`manager.spawn('lastneedle', pos)` or the `manager.spawnBoss(pos)`
convenience wrapper — and it is exempt from both the ambient max-alive cap
and the despawn sweep (`spawnRules.DESPAWN_CONFIG.exemptArchetypes`
includes `'lastneedle'`, plus a belt-and-suspenders `bossExempt`/`isBoss`
check).

**The Last Needle is BOUND, not killed.** Canonically it cannot be killed
by any weapon — its hp is "total binding progress," not flesh — and the
encounter resolves by stitching it down rather than reducing it to 0 hp in
melee. This sim uses a **simplified raw-hp 3-phase model** as a
visualization/placeholder for that full binding encounter (see "Sim vs.
full design" below): `mob.hurt(dmg)` still subtracts from a raw hp pool for
demo purposes, but on reaching 0 the boss routes through `_killBoss`
(distinct from `_killMob`) which emits **only** `'bossDefeated'` — never
`'mobDeath'`, never `'mobDrop'` — carrying:

```js
{
  archetype: 'lastneedle',
  canonicalId: 'last_needle',
  bound: true,
  victoryTrigger: 'kill_entity:last_needle',
  achievement: 'taught_to_mend',
  // ...species, mob, position as usual
}
```

`victoryTrigger` and `achievement` let the builder wire the win condition
without hardcoding archetype strings — see `content/boss.json`'s
`onVictory` block, which grants `taught_to_mend` and then shows
`content/ending.md` ("The Turning of the Needle") as a full-screen document
before presenting the two-choice epilogue:

- **Finish the Weaving** (`choice:finish_the_weaving`, achievement
  `to_finish_the_weaving`)
- **Still the Loom** (`choice:still_the_loom`, achievement
  `let_it_come_to_rest`)

Suggested wiring:

```js
manager.addEventListener('bossDefeated', (e) => {
  game.grantAchievement(e.detail.achievement);       // 'taught_to_mend'
  game.fireTrigger(e.detail.victoryTrigger);          // 'kill_entity:last_needle'
  game.showDocument('content/ending.md', { title: 'The Turning of the Needle' });
  game.presentChoice({
    prompt: 'The choice was always this, and always yours.',
    options: [
      { id: 'finish_the_weaving', achievementId: 'to_finish_the_weaving' },
      { id: 'still_the_loom', achievementId: 'let_it_come_to_rest' },
    ],
  });
});
```

### Phases

Every AI tick recomputes `mob.bossPhase` (0/1/2) from the boss's current hp
fraction (`ARCHETYPE_CONFIG.lastneedle.phase1HpFrac = 0.60`,
`phase2HpFrac = 0.15` — the canonical thresholds) and exposes it both on
the mob object and as `state.phase` passed into `animate()`:

- **Phase 0** (`frac > 0.60`): slow hover-drift toward the player. Ranged
  attack at `attackRange: 7`, `cooldown: 2.2s`, `damage: 6`.
- **Phase 1** (`0.15 < frac <= 0.60`): `1.5x` speed, wider `attackRange:
  10`, `cooldown: 1.7s`, `damage: 8`. Every `summonCooldown: 6s` the boss
  summons a **"Shed of Ravelers"** — a `'raveler'` add near itself (tagged
  `spawnedBy: <bossId>`), capped at `maxAdds: 4` simultaneously-alive adds
  across both summoning phases.
- **Phase 2** (`frac <= 0.15`): `2.0x` speed, short `attackRange: 5`, rapid
  `cooldown: 0.6s`, `damage: 14`. **Also keeps summoning** (unlike Phase 2
  ambient design in earlier revisions of this sim) — mostly `'raveler'`
  with a `summonArchetypePhase2AltChance: 0.25` (25%) chance of `'unpicked'`
  mixed in, same shared `maxAdds` cap.

### Sim vs. full design (discrepancy notes)

- **hp: 600 (this sim) vs. 800 (`content/boss.json`).**
  `content/bestiary.json` lists `hp: 600` (200 per phase, matching this
  sim's simplified 3-phase raw-hp model), while `content/boss.json`
  specifies `hp: 800` with a much richer damage-immunity/exposure-window/
  stitching system (damage lands only through a 3x3x3 "Eye" hitbox during
  specific windows; the final 120 hp — 15% — can *only* be removed by
  completing 8 stitches at the binding-anvil, not by weapon damage at all).
  This sim adopts `maxHp: 600` per the canon table supplied for this
  reconciliation pass, and is explicitly a simplified visualization, not a
  1:1 implementation of the full `boss.json` encounter. A future pass
  implementing the real stitch-phase/binding-anvil/loom-gate-anchor
  mechanics from `boss.json` would need to reconcile this 600/800 hp
  mismatch first.
- **No literal `spd` applied.** `content/bestiary.json`'s `spd: 12` for
  `last_needle` describes the scale of the full encounter (horizon-long
  dive passes, ring-wide sweeps), not a directly-comparable per-second
  movement speed; this sim's boss speed/seek-speed/phase-speed-multiplier
  values were left at their pre-existing hand-tuned figures rather than
  substituting `12` in — see the roster table above.

## Movement: navigation + despawn

**Smarter movement.** `mobs/ai.js` adds two navigation helpers, wrapped by
`MobManager._steerGroundedHostile`/`_steerFlyer`:

- `navSteer(position, desired, halfWidth, isSolid, opts)` — used for
  **grounded hostile** mobs (any `ARCHETYPE_CONFIG[*].hostile === true`,
  non-flying archetype) while wandering pre-aggro and while seeking. Takes
  a small, fixed number of `isSolid()` samples per call to detect a
  1-block step directly ahead and signal `wantJump` (consumed by
  `MobManager` as `mob.velocity.y = AI.JUMP_SPEED`), and to avoid steering
  straight off a cliff edge. Passive/neutral grounded archetypes
  (`grazer`/`trader`/`bobbindeer`/`scaldwarden`) keep the original plain
  `wanderSteer`/`fleeSteer`/tethered-wander path unchanged.
- `flyerAvoid(position, desired, isSolid, opts)` — used for **all** flying
  archetypes (`screecher`, `lastneedle`). Suggests a `vy` nudge to climb
  over terrain ahead / settle toward a cruise altitude; this is layered
  **additively** on top of each flyer's existing hover-height lerp
  (`spawnPos.y + hoverHeight`) physics in `_updateMobPhysics`, rather than
  replacing it, so the pre-existing hover mechanic is preserved.

**Despawn rules.** `mobs/spawnRules.js`'s `DESPAWN_CONFIG` (`radius: 48`
blocks, `minAgeSeconds: 12`, `exemptArchetypes: ['trader', 'lastneedle',
'scaldwarden']`, `bossExempt: true`) and `shouldDespawn(mob, playerPos,
opts)` are consulted by `MobManager._updateDespawn`, a low-rate sweep
(every ~3-5s, not every tick) that quietly removes mobs that are both old
enough (`mob.ageSeconds >= minAgeSeconds`) and far enough from the player
(horizontal distance `>= radius`). Despawn emits `'mobDespawn'` — no loot,
no `'mobDeath'`. Traders (persistent NPCs), Scaldwardens (stationary
forge-guardians tied to their post), and the boss (hand-managed by its
encounter) are exempt.

## THREE.js loading

There is no npm dependency. `three` is vendored directly at
`mobs/vendor/three.module.js` (r160) and mapped via a native-ES-module
import map:

```html
<script type="importmap">
{ "imports": { "three": "./vendor/three.module.js" } }
</script>
<script type="module">
  import * as THREE from 'three';
  ...
</script>
```

Every file under `mobs/` (creatures, `MobManager.js`, the demo) imports
`three` via this bare specifier, so as long as the importing HTML page
declares the same importmap (or the game's bundler resolves `"three"` to
the same or a compatible build), no code changes are needed at
integration time.

## Running the demo

```sh
node mobs/serve.mjs            # serves the whole repo at http://localhost:8130/
# or: PORT=9000 node mobs/serve.mjs
```

Then open:

- `http://localhost:8130/mobs/demo.html` — showcase row of all thirteen
  creatures plus a live `MobManager` simulation over a `StubWorld` with a
  scripted moving "player" position (so mobs wander/seek/flee/attack on
  their own). An on-page HUD shows dimension (all 3:
  `warpwold`/`cinderloom`/`nevermend`), day/night, mob count, and (once
  triggered) the boss's current phase/hp. An event log panel prints every
  `mobSpawn`/`mobHurt`/`mobDeath`/`mobAttack`/`mobDrop`/`mobDespawn`/
  `bossDefeated` event, each tagged with both `archetype` and
  `canonicalId`. Buttons let you toggle day/night, force-spawn one of each
  of the twelve non-boss archetypes, and **run the boss sim** (see below).
- `http://localhost:8130/mobs/demo.html?mob=<archetype>` — isolates that
  one creature, centered and slowly auto-rotating, with a synthetic
  `animate()` state driven for it (looping fuse ramp for `exploder`,
  hover/moving for `screecher`, a full phase-0→1→2 cycle with periodic
  attack flashes for `lastneedle`, walking/attack-pulse for the hostile
  grounded archetypes, idle for the rest). `<archetype>` is any of
  `grazer`/`trader`/`groaner`/`exploder`/`screecher`/`bobbindeer`/
  `frayedhound`/`emberspinner`/`unpicked`/`needlejack`/`scaldwarden`/
  `raveler`/`lastneedle`. Intended for per-creature screenshots.

### Boss sim

Click **"Run Boss Sim (The Last Needle)"** in the HUD, or call
`window.__runBossSim()` directly. This:

1. Switches the main manager's dimension to Nevermend using the **engine
   id** `'end'` (`manager.setDimension('end')`) — proving the
   `normalizeDimension` reconcile resolves it to `'nevermend'`.
2. Builds a dedicated boss-arena world (`new StubWorld({ arena: true })`)
   and a second, scoped `MobManager` over it (also constructed with
   `dimension: 'end'`), since `MobManager`'s world is fixed at
   construction time (there's no `setWorld()`).
3. Spawns The Last Needle via `bossManager.spawnBoss(pos)`.
4. Scripts repeated `boss.hurt(dmg)` calls on a ~200ms timer over ~7
   seconds, sized from the boss's `maxHp` so hp sweeps through both
   canonical phase thresholds (60%/15%) and reaches 0 — driving the
   encounter through all 3 phases (observing Phase 1/2 `'raveler'`
   summons along the way) and firing exactly one `'bossDefeated'` (bound,
   with `victoryTrigger`/`achievement`) and **zero** `'mobDrop'` at the
   end.

The demo exposes Playwright-friendly hooks on `window`:

- `window.__ready` — `true` once the first frame has rendered.
- `window.__events` — array of every event the manager(s) have emitted so
  far (`{name, archetype, canonicalId, species, position, dmg, explosion,
  itemId, count, mobId, bound, victoryTrigger, achievement, t}`; irrelevant
  fields are `undefined` per event type — e.g. `mobDrop` entries have
  `itemId`/`count`/`mobId` but no `species`).
- `window.__mobCount` — getter, current live mob count on the main manager
  (showcase mode only; 0 in isolate mode; does not include the separate
  boss-sim manager's mobs — see `hudCount` in the HUD for the combined
  total).
- `window.__forceSpawnAll()` — spawns one of each of the **twelve
  non-boss** archetypes via `manager.spawn(archetype, pos)` around the
  current player position; returns the spawned mob array. Never spawns the
  boss.
- `window.__testLoot(maxAttempts?)` — spawns a `grazer`/Skeinling at a
  fixed off-screen position, kills it in one hit
  (`mob.hurt(mob.maxHp + 1000)`), and returns the `'mobDrop'` event(s) it
  produced (from `window.__events`, filtered to that mob's id). Since
  `LOOT_TABLES.grazer` rolls `raw_skein` at a 90% independent chance (not
  guaranteed), this retries with a fresh grazer up to `maxAttempts`
  (default 25) until a drop lands. Lets a verifier assert
  `drops[0].itemId === 'raw_skein'` — confirming the drop is the REAL
  canonical id, not a stub.
- `window.__runBossSim()` — triggers the boss sim described above; returns
  `true` if it started, `false` if a run is already in progress or spawn
  failed.
- `window.__bossState` — `{ phase, hp, maxHp }`, live-updated every frame
  while the boss sim's boss mob is alive; `phase`/`hp` reflect
  `mob.bossPhase`/`mob.hp` directly.
- `window.__bossDefeated` — `boolean`, flips to `true` the moment a
  `'bossDefeated'` event fires (persists until the next `__runBossSim()`
  call resets it to `false`).
- `window.__setMob(archetype)` — navigates to `?mob=<archetype>` (isolate
  mode) for scripted screenshotting.
- `window.__error` — set to a string (and rendered in a visible `<pre>`)
  if anything in init or the render loop throws.
- `window.__manager` — the main showcase-mode `MobManager` instance
  (showcase mode only).
- `window.__getPlayerPos()` — the scripted figure-eight player position
  function (showcase mode only).

Verified in this session via a headless Node smoke test driving the real
`MobManager`/`StubWorld` modules directly (no browser): all twelve
non-boss archetypes spawn without error; `__testLoot`-equivalent logic
confirms a killed grazer drops `{ itemId: 'raw_skein', count }` (the real
canonical id); a scripted ~7.6s boss encounter (60fps `update()` ticks,
damage applied every ~200ms) sweeps `maxHp: 600` through both canonical
phase thresholds, observes a `'raveler'` Phase-1 summon spawn, and ends
with exactly one `'bossDefeated'` event (`canonicalId: 'last_needle'`,
`victoryTrigger: 'kill_entity:last_needle'`, `achievement:
'taught_to_mend'`, `bound: true`) and **zero** `'mobDrop'` events.

## Dimension / day-night spawn rules

From `mobs/spawnRules.js` (`SPAWN_TABLES`, weighted random pick via
`pickSpawn(dimension, isDay, rng, biome)`):

| Dimension | Period | Table (archetype: weight) | Max alive |
|---|---|---|---|
| `warpwold` | day | grazer: 6, bobbindeer: 4, trader: 2 | 14 |
| `warpwold` | night | groaner: 4, frayedhound: 4, needlejack: 3, screecher: 1 | 14 |
| `cinderloom` | always (no day/night split) | exploder: 5, emberspinner: 5, screecher: 4, scaldwarden: 2, groaner: 1 | 12 |
| `nevermend` | always (no day/night split) | unpicked: 5, raveler: 4, screecher: 2, groaner: 2 | 10 |

`cinderloom` and `nevermend` are in `ALWAYS_HOSTILE_DIMENSIONS`, so
`isDay` is ignored for them (both their "day" and "night" tables are
identical). `maxAliveFor(dimension)` falls back to `DEFAULT_MAX_ALIVE`
(10) for unknown dimensions; `opts.maxMobs` on the `MobManager` overrides
the per-dimension cap entirely if set. `lastneedle` never appears in any
table — see "The boss: The Last Needle" above.

An optional `BIOME_MODIFIERS` layer (`warpwold` only: `plains`/`forest`/
`desert`/`mountains`/`snow`/`ocean`) applies additive per-archetype weight
deltas on top of the base table when a `biome` argument is passed to
`pickSpawn`; `cinderloom`/`nevermend` have no biome set, so any biome
passed for them safely falls back to the unmodified base table.

## Unimplemented canonical species (future phases)

`content/bestiary.json` defines 17 canonical Loomfall mobs total; this
package implements 13 species + the boss (14 of 17). The remaining four are
**not yet implemented** in `mobs/` and have no registry entry, spawn-table
slot, or creature file:

| `canonicalId` | Species | Dimension | Role | Why it's deferred |
|---|---|---|---|---|
| `spoolmare` | Spoolmares | Warpwold | passive / mount | Requires a taming/mount/riding system (`tame_entity:spoolmare`, saddle interaction, Nevermend thread-tread mechanic) that doesn't exist yet in this package. |
| `silence_moth` | Silence-Moths | Warpwold | ambient | Requires a block-durability-damage-over-time ambient mechanic (nibbles woven blocks/armor) distinct from anything `MobManager`'s AI set currently models. |
| `selvage_warden` | Selvage Wardens | Nevermend | mini-boss | Guards the causeway to The Last Needle's arena per `content/boss.json`; needs its own regen/burst-damage-suppression mechanic and is logically prerequisite content for the full boss encounter (see "Sim vs. full design" above). |
| `molthkin` | Molthkin, the First Bobbin | Cinderloom | boss | The Cinderloom boss and **canonical source of `everthread`** (guarded, one-time drop, `chance: 1.0`) — a second full boss encounter (2-phase, structure-bound, unique-per-world) out of scope for this pass. `everthread` therefore does not appear in any `mobs/lootTables.js` table in this package; do not add it as a drop for any currently-implemented archetype. |

If/when these are implemented, follow the same pattern as this
reconciliation pass: add a `mobs/creatures/<archetype>.js` with `build()` +
`meta` (including `canonicalId`), register it in `MobManager.js`'s
`REGISTRY`/`ARCHETYPE_CONFIG`, add its `canonicalId` to
`spawnRules.CANONICAL_ID`, and (if it should spawn ambiently) a
`SPAWN_TABLES` entry.
