# Loomfall Mobs Package

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

**Phase 3** ("Loomfall canon expansion") added four more creatures —
`spoolmare` (a passive, rideable Warpwold mount), `silencemoth` (a harmless
ambient Warpwold flyer), `selvagewarden` (a Nevermend mini-boss that guards
the causeway to The Last Needle), and `molthkin` (the Cinderloom boss, "the
First Bobbin," the canonical `everthread` source) — bringing the roster to
**17 total archetypes** (14 species + `selvagewarden` mini-boss + 2
bosses). It also fixed two known
Phase-2-era simplifications flagged as deviations from canon
(`scaldwarden` now genuinely provokes on being hurt instead of running the
fully-neutral `trader` AI; `raveler` now truly hovers via real flyer
physics instead of just being animated as if hovering), and added a
mount/ride system (`mountPlayer`/`dismountPlayer`/`setRideInput`) plus
stub-simple breeding/spawn-egg hooks (`spawnEgg`/`breed`, backed by
`mobs/breeding.js`). See "Mounts", "Breeding & spawn eggs", and "Fixed
deviations" below.

All of this work lives in `mobs/MobManager.js`, `mobs/lootTables.js`,
`mobs/spawnRules.js`, `mobs/ai.js`, `mobs/blocksAdapter.js`,
`mobs/breeding.js`, `mobs/world/StubWorld.js`, `mobs/demo.html`, and the
seventeen creature files under `mobs/creatures/`.

## What's in here

| File | Purpose |
|---|---|
| `mobs/creatures/*.js` | One file per archetype. Each exports `build()` (returns a `THREE.Group`) and `meta` (species/lore/palette/`canonicalId`). Seventeen files: `grazer`, `trader`, `groaner`, `exploder`, `screecher`, `bobbindeer`, `frayedhound`, `emberspinner`, `unpicked`, `needlejack`, `scaldwarden`, `raveler`, `spoolmare`, `silencemoth`, `selvagewarden`, `molthkin`, `lastneedle`. |
| `mobs/MobManager.js` | `export class MobManager extends EventTarget` (also the default export). Owns spawning, AI, physics stepping, and animation-driving for all live mob instances, including mounts and both bosses. |
| `mobs/ai.js` | Pure helper functions (gravity, collision resolution, wander/seek/flee steering, grounded step-up/cliff-avoid navigation, flyer terrain-avoidance). Takes an `isSolid(x,y,z)` predicate as a parameter — no direct world/block imports. |
| `mobs/spawnRules.js` | Per-dimension, day/night-aware weighted spawn tables (`SPAWN_TABLES`, `pickSpawn`, `maxAliveFor`), the archetype → canonical entity id map (`CANONICAL_ID`, `canonicalIdFor`), dimension-id reconciliation (`normalizeDimension`, `DIMENSION_ALIASES`), and despawn rules (`DESPAWN_CONFIG`, `shouldDespawn`). |
| `mobs/lootTables.js` | Per-archetype loot tables (`LOOT_TABLES`) and `rollLoot(archetype, rng)`. Item ids are the REAL canonical ids from `content/items.json`/`content/naming.json` — see "Loot" below. |
| `mobs/breeding.js` | Stub breeding/spawn-egg data (`canBreed`, `describeBaby`, `spawnEggId`) consumed by `MobManager.spawnEgg()`/`.breed()` via a guarded dynamic import — see "Breeding & spawn eggs" below. |
| `mobs/blocksAdapter.js` | **Fallback** `getBlockDef(id)` shim — see "World contract" below. |
| `mobs/world/StubWorld.js` | Minimal `getBlock(x,y,z)` implementation used by demos/tests only. Supports a flat boss-arena mode (`new StubWorld({arena:true})`). |
| `mobs/demo.html` + `mobs/vendor/three.module.js` | Standalone browser harness (see "Running the demo" below). |
| `mobs/serve.mjs` | Zero-dependency static file server for local demo/testing. |
| `mobs/integration.md` + `mobs/integration/gameBridge.js` | Copy-paste integration guide + example adapter for wiring `MobManager` into the game builder's `feat/voxel-sandbox-game` branch (audio/achievements/inventory/mount hookup). Start here when integrating. |

## Roster: 17 total (14 species + 1 mini-boss + 2 bosses)

Canonical species names, snake_case `canonicalId` (via
`spawnRules.canonicalIdFor(archetype)`), default dimension, canon stats
(`hp` / `dmg` / `spd` from `content/bestiary.json`), and the `aiBase`
behaviour each archetype runs under in `MobManager`:

| Archetype | Species | `canonicalId` | Dimension | hp | dmg | spd | `aiBase` |
|---|---|---|---|---:|---:|---:|---|
| `grazer` | Skeinling | `skeinling` | Warpwold | 8 | 0 | 2.5 | `grazer` |
| `bobbindeer` | Bobbin-deer | `bobbin_deer` | Warpwold | 14 | 0 | 6 | `grazer` |
| `spoolmare` | Spoolmares | `spoolmare` | Warpwold | 26 | 0 | 9 | `grazer` (+rideable) |
| `trader` | Wickerkin | `wickerkin` | Warpwold | 20 | 0 | 3.5 | `trader` |
| `silencemoth` | Silence-Moths | `silence_moth` | Warpwold | 4 | 1 | 3 | `screecher` (`hostile:false`) |
| `needlejack` | Needlejack | `needlejack` | Warpwold | 18 | 4 | 4.5 | `groaner` |
| `groaner` | Understruck | `understruck` | Warpwold | 24 | 5 | 3.5 | `groaner` |
| `frayedhound` | Frayed Hound | `frayed_hound` | Warpwold | 14 | 3 | 6 | `groaner` |
| `emberspinner` | Emberspinner | `emberspinner` | Cinderloom | 22 | 5 | 4 | `groaner` |
| `exploder` | Waxling | `waxling` | Cinderloom | 10 | 7 | 3.5 | `exploder` |
| `scaldwarden` | Scaldwarden | `scaldwarden` | Cinderloom | 40 | 6 | 3 | `guardian` (provokes) |
| `screecher` | Slagmoth | `slagmoth` | Cinderloom | 12 | 3 | 7 | `screecher` |
| `unpicked` | The Unpicked | `unpicked` | Nevermend | 26 | 6 | 3 | `groaner` |
| `raveler` | Raveler | `raveler` | Nevermend | 18 | 5 | 8 | `groaner` (real hover flight) |
| `selvagewarden` (MINI-BOSS) | Selvage Wardens | `selvage_warden` | Nevermend | 90 | 9 | 4 | `groaner` (+self-mend) |
| `molthkin` (BOSS) | Molthkin, the First Bobbin | `molthkin` | Cinderloom | 280 | 11 | 2 | `boss` |
| `lastneedle` (BOSS) | The Last Needle | `last_needle` | Nevermend | 600(sim) | 14 | — | `boss` |

Notes on this table:

- `dmg` maps to `ARCHETYPE_CONFIG[*].contactDamage` for melee attackers, to
  `blastDamage` for `exploder` (it has no contact attack, only its
  detonation), and to `phaseAttackDamage`/phase-indexed damage for the two
  bosses.
- `aiBase` (an `ARCHETYPE_CONFIG[*].aiBase` field in `MobManager.js`)
  selects which internal `_ai*()` behaviour function `_updateMobAI`
  dispatches to; it is independent of the archetype's spawn-table/registry
  key, which is why `bobbindeer`/`frayedhound`/`emberspinner`/`unpicked`/
  `needlejack`/`raveler`/`spoolmare`/`silencemoth`/`selvagewarden` each
  reuse the `grazer`/`groaner`/`screecher` behaviour loop but with their
  own canon-derived tuning (`ARCHETYPE_CONFIG[mob.archetype]` is looked up
  per-mob, not hardcoded per `aiBase`).
- **`spoolmare` is the rideable mount.** `config.rideable:true` opts it
  into `manager.mountPlayer()`; unmounted, it just wanders/flees on the
  plain `grazer` AI like a `bobbindeer`. See "Mounts" below.
- **`silencemoth` is a harmless ambient flyer.** `config.hostile:false`
  means it runs `screecher`'s flight/hover steering but the hostile-only
  seek/attack branch is skipped entirely — it never seeks or attacks the
  player regardless of `aggroRange`/`attackRange`/`contactDamage` (those
  fields are kept for data completeness only).
- **`selvagewarden` is a mini-boss, not `isBoss`.** It's hand-placed
  (guards the causeway to The Last Needle's arena per `content/boss.json`)
  and never appears in `spawnRules.SPAWN_TABLES`, same as the two full
  bosses, but it dies through the **normal** `mobDeath`+`mobDrop` path (see
  "Loot" below), never `bossDefeated` — only `lastneedle`/`molthkin` have
  `isBoss:true`. It also self-mends (`regenPerSec:2`/`regenDelay:5` —
  heals once 5s have passed since it was last hurt), selling the "re-
  stitches, doesn't bleed" lore from its own creature module's shimmer
  animation.
- **`molthkin` is the second, genuinely-killable boss.** `isBoss:true`,
  `bound:false` — unlike The Last Needle it **is** killed and **does**
  drop loot (`everthread`, the canonical Everthread source). Grounded (not
  flying), 2-phase (canonical 50% hp threshold), summons `exploder`/Waxling
  and occasional `emberspinner` adds while enraged. See "The two bosses"
  below.
- **`scaldwarden` now genuinely provokes** (fixed in Phase 3 — see "Fixed
  deviations" below). It's still exempt from ambient despawn
  (`spawnRules.DESPAWN_CONFIG.exemptArchetypes`) since it's a stationary
  guardian tied to its Cinderloom post.
- **`raveler` now truly hovers** via real flyer physics (fixed in Phase 3
  — see "Fixed deviations" below).
- **`speed` reconciliation.** Canon gives one `spd` figure per creature,
  but several `aiBase` behaviours split a calmer ambient-wander pace from a
  more urgent combat/flee pace (two config fields: `speed` vs
  `fleeSpeed`/`seekSpeed`). Where that split exists, canon `spd` is applied
  to the URGENT field (the number that actually governs player-facing
  pacing/difficulty), and the calmer ambient `speed` is derived
  proportionally below it. Archetypes with only a single `speed` field used
  directly (`trader`, `exploder`, `screecher`) take canon `spd` directly.
  `spoolmare` follows the same convention: canon `spd9` is applied to its
  `rideable`-only `fleeSpeed`, kept separate from a dedicated `rideSpeed:9`
  used only while mounted (see "Mounts" below) so being ridden never
  perturbs its own unridden AI tuning. See the "Canonical stats note"
  comment at the top of `ARCHETYPE_CONFIG` in `MobManager.js` for the exact
  derivation.
- **The Last Needle's `spd`**: `content/bestiary.json` lists `spd: 12` for
  `last_needle`, but that figure describes the full stitching-encounter
  from `content/boss.json` (horizon-long dive passes, sweeps, etc.), not a
  literal per-second movement speed comparable to the other archetypes'
  grounded/hover `spd` values. This sim's boss speed/seek-speed/phase
  speed-multiplier tuning was left at its pre-existing hand-tuned values
  rather than substituting `12` directly — flagged here as a discrepancy
  worth a second look, not applied to `ARCHETYPE_CONFIG.lastneedle`.

Note: `groaner`, `exploder`, and `screecher` also appear (at different
weights) in `nevermend`'s and `cinderloom`'s spawn tables; `warpwold` spawns
`groaner`/`frayedhound`/`needlejack`/`screecher`/`silencemoth` at night and
`spoolmare` (uncommon) during the day. `lastneedle`, `molthkin`, and
`selvagewarden` never appear in any `SPAWN_TABLES` entry — all three are
hand-placed/structure-bound, always hand-triggered via
`spawn()`/`spawnBoss()`, never picked by the ambient random-spawn cadence.
See "Dimension / day-night spawn rules" below for the exact weighted
tables.

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
                                 //    NOTE: hardcoded to lastneedle -- for molthkin, call
                                 //    manager.spawn('molthkin', pos) directly.
manager.mobs;                    // getter -> array snapshot of live mob objects
manager.setDay(isDay: boolean);  // override day/night without opts.isDay
manager.mountPlayer(mob);        // -> {mob, setInput, dismount} | null -- see "Mounts" below.
manager.dismountPlayer(mob);     // ends a ride started by mountPlayer().
manager.setRideInput(mob, input);// -> boolean. Feeds {moveX, moveZ, jump} each frame; also
                                  //    reachable as mob.setRideInput(input).
manager.spawnEgg(archetype, pos);// -> Promise<mob | null>. See "Breeding & spawn eggs" below.
manager.breed(mobA, mobB, pos?); // -> Promise<mob | null>. See "Breeding & spawn eggs" below.
```

### Per-mob object shape

```js
{
  id, archetype, species, canonicalId,  // e.g. 'exploder', 'Waxling', 'waxling'
  group,                            // THREE.Group (the visual root, already added to scene)
  headAnchor,                       // THREE.Object3D | null — for floating name tags/UI
  rideAnchor,                       // THREE.Object3D | null — saddle-point world position for a
                                     //   rider/camera; currently only 'spoolmare' sets this (via
                                     //   root.userData.rideAnchor in its own build()).
  rider,                            // truthy while mounted (see mountPlayer/dismountPlayer)
  rideInput,                        // {moveX, moveZ, jump} | null — set via setRideInput while mounted
  hp, maxHp,
  position: {x,y,z},                // live-synced each frame, plain object (not a THREE.Vector3)
  velocity: {x,y,z},
  grounded,                         // boolean
  spawnPos: {x,y,z},                // ground/anchor y — NOT hover-adjusted even for flyers
  fuse,                             // 0..1, exploder only
  ageSeconds,                       // accumulator since spawn; feeds the despawn sweep (mounted
                                     //   mobs are exempt from the despawn sweep entirely)
  attackFlash,                      // 0..1, generic to ALL mobs (not just the bosses); spikes to
                                     //   1.0 on attack, decays over ATTACK_FLASH_DURATION=0.35s;
                                     //   fed into animate() as state.attack
  isBoss,                           // boolean; true only for lastneedle/molthkin (NOT selvagewarden)
  bossPhase,                        // 0/1/2 for lastneedle, 0/1 for molthkin, boss-only (always 0
                                     //   for non-boss mobs); fed into animate() as state.phase
  spawnedBy,                        // id of the boss mob that summoned this add (lastneedle's
                                     //   'raveler'/'unpicked' phase-1/2 summons, or molthkin's
                                     //   'exploder'/'emberspinner' phase-1 summons), else null
  sinceHurt,                        // seconds since last hurt (Infinity if never hurt); drives
                                     //   regenPerSec/regenDelay self-mend (selvagewarden only)
  provoked, provokeTimer,           // 'guardian' aiBase only (scaldwarden) — see "Fixed deviations"
  isBaby,                           // set true by breed() on a bred baby (see "Breeding" below)
  dead,                             // boolean
  hurt(dmg),                        // call to damage this mob; may kill it and emit mobDeath
                                     //   + mobDrop (or, for a boss, bossDefeated -- followed by
                                     //   mobDrop too if that boss is killable, e.g. molthkin)
  setRideInput(input),              // bound closure, equivalent to manager.setRideInput(mob, input)
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
`bossDefeated`/`mobMount`/`mobDismount`/`mobBreed`) includes both
`archetype` (the internal slot key) and `canonicalId` (the stable external
id), so downstream systems (audio,
achievements, the ending sequencer) can match against canonical ids instead
of hardcoding `mobs/`-internal archetype strings. Each creature module's own
`meta.canonicalId` field (in every `mobs/creatures/*.js`) mirrors the same
value, so the mapping is consistent whether you're reading a live `mob`
object, an event `detail`, or a creature module's static `meta`.

## Events

`MobManager` emits ten event names, both as `CustomEvent` (via its
`EventTarget` base — use `manager.addEventListener(name, handler)`) **and**
via `opts.onEvent(name, detail)` if provided. Every detail below includes
both `archetype` and `canonicalId` (see "Canonical alignment" above):

- `'mobSpawn'` — `{ archetype, canonicalId, species, mob, position }`
- `'mobHurt'` — `{ archetype, canonicalId, species, mob, position, dmg }`
- `'mobDeath'` — `{ archetype, canonicalId, species, mob, position }` — **not**
  emitted for a boss (`lastneedle`/`molthkin`); see `'bossDefeated'` below.
  **Is** emitted for `selvagewarden` (mini-boss, but `isBoss:false` — dies
  through the normal path).
- `'mobAttack'` — `{ archetype, canonicalId, species, mob, position, dmg }`,
  plus for exploder detonations: `{ explosion: true, hitPlayer: boolean }`
- `'mobDrop'` — `{ mobId, archetype, canonicalId, itemId, pos:{x,y,z}, count }`
  — one event per dropped item stack, computed via `lootTables.rollLoot()`
  and emitted immediately after `'mobDeath'` **or** after `'bossDefeated'`
  for a killable boss (`molthkin` — see below). Note the field is `pos`, not
  `position`, and there is no `species`/`mob` field on this event.
  Archetypes with an empty loot table (`unpicked`, `lastneedle`) naturally
  produce zero `'mobDrop'` events, since `rollLoot()` returns `[]`.
- `'mobDespawn'` — `{ archetype, canonicalId, species, mob, position }` — a
  quiet ambient distance/age removal (see "Despawn rules" below); **no**
  loot is rolled for a despawn. **Never** fires for a currently-mounted mob.
- `'bossDefeated'` — `{ archetype, canonicalId, species, mob, position,
  bound, victoryTrigger?, achievement? }` — emitted **instead of**
  `'mobDeath'` when a boss mob's (`mob.isBoss`) hp reaches 0. `bound` is
  per-archetype (`ARCHETYPE_CONFIG[*].bound`, default `true`):
  - `lastneedle`: `bound:true` (bound, not killed — no loot table, so **no**
    `'mobDrop'` follows), plus `victoryTrigger:'kill_entity:last_needle'`
    and `achievement:'taught_to_mend'` — see "The two bosses" below.
  - `molthkin`: `bound:false` (genuinely **killable**), **no**
    `victoryTrigger`/`achievement` fields at all, and **is** followed by a
    `'mobDrop'` (`everthread` — its loot table has `chance:1.0`).
- `'mobMount'` — `{ archetype, canonicalId, mob }` — fired by
  `mountPlayer(mob)`. No `species`/`position`/`dmg` fields.
- `'mobDismount'` — `{ archetype, canonicalId, mob }` — fired by
  `dismountPlayer(mob)`.
- `'mobBreed'` — `{ archetype, canonicalId, baby }` — fired by `breed()` on
  a successful pairing; note the mob field is called `baby`, not `mob`.

`position`/`pos` is a plain `{x,y,z}` snapshot at emit time (not a live
reference). `mob`/`baby` is the live per-mob object described above (absent
on `'mobDrop'`).

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
  const key = e.detail.bound ? `mob.${e.detail.archetype}.bound` : `mob.${e.detail.archetype}.death`;
  audio.play(key, { pos: e.detail.position, volume: 1.0 });
});
manager.addEventListener('mobDrop', (e) => {
  audio.play('loot.pickup_ping', { pos: e.detail.pos, volume: 0.4 });
});
manager.addEventListener('mobMount', (e) => {
  audio.play(`mob.${e.detail.archetype}.mount`, { volume: 0.6 });
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
this after every `mobDeath`, **and** after `'bossDefeated'` for a killable
boss (`molthkin` — see "The two bosses" below); never on `mobDespawn`. It
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
| `spoolmare` | `thread_sinew` | items.json |
| `trader` | `knot_charm`, `lore_scroll` | items.json |
| `silencemoth` | `mothdust` | items.json |
| `needlejack` | `thread_sinew`, `needle_iron` | items.json / naming.json block |
| `groaner` | `loose_thread` | items.json |
| `frayedhound` | `thread_sinew`, `hide_cloth` | items.json |
| `emberspinner` | `scorched_silk` | items.json |
| `exploder` | `tallowstone` | naming.json block |
| `scaldwarden` | `emberskein_ore`, `scorched_silk` | naming.json block / items.json |
| `screecher` | `cinderthread` | naming.json block |
| `unpicked` | **none** — drops nothing (canonical: leaves no corpse) | — |
| `raveler` | `loose_thread`, `voidknot` | items.json / naming.json block |
| `selvagewarden` (MINI-BOSS) | `hemstone` — canonical `hemstone` source; no other archetype drops it | naming.json block |
| `molthkin` (BOSS) | `everthread` (`chance:1.0`, guaranteed) — canonical `everthread` source; no other archetype drops it | items.json |
| `lastneedle` (BOSS) | **none** — drops nothing (canonical: bound, not killed; no loot table) | — |

**`molthkin` is the canonical Everthread source, and unlike The Last
Needle it IS killed.** `ARCHETYPE_CONFIG.molthkin.bound === false`, so its
`'bossDefeated'` has no `victoryTrigger`/`achievement` fields, and
`_killBoss` calls `_dropLoot` for it exactly like a normal death — the
`'mobDrop'` event carrying `everthread` fires immediately after
`'bossDefeated'`. Contrast with `lastneedle`: `bound:true`, has
`victoryTrigger`/`achievement`, and its loot table is empty (bound
creatures aren't "killed" for loot purposes) — see "The two bosses" below.

Wiring into the builder's Inventory system:

```js
manager.addEventListener('mobDrop', (e) => {
  const { itemId, count, pos } = e.detail;
  inventory.addOrSpawnPickup(itemId, count, pos); // itemId is a real content/items.json / naming.json id
});
```

## The two bosses

There are now two full bosses (`lastneedle`, `molthkin`) plus one
mini-boss (`selvagewarden`, covered separately below — it is **not**
`isBoss` and dies through the normal `mobDeath` path). Both full bosses
are `aiBase: 'boss'`, `isBoss: true`, **never** listed in
`spawnRules.SPAWN_TABLES` — hand-triggered only — and exempt from both the
ambient max-alive cap and the despawn sweep
(`spawnRules.DESPAWN_CONFIG.exemptArchetypes` includes `'lastneedle'`, plus
a belt-and-suspenders `bossExempt`/`isBoss` check covers `molthkin` too).
They differ sharply in how their defeat resolves — see `bound` below.

### The Last Needle (Nevermend, bound — not killed)

`lastneedle` (species **The Last Needle**, `canonicalId: 'last_needle'`) is
the Nevermend final boss: flies. It's hand-triggered via
`manager.spawn('lastneedle', pos)` or the `manager.spawnBoss(pos)`
convenience wrapper (spawnBoss is hardcoded to `'lastneedle'` — it can't be
reused for `molthkin`, see below).

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

### Molthkin, the First Bobbin (Cinderloom, killable — drops Everthread)

`molthkin` (species **Molthkin, the First Bobbin**, `canonicalId:
'molthkin'`) is the Cinderloom boss and the canonical `everthread` source
— no other archetype drops it. It's grounded (`flies:false`, unlike the
hovering Last Needle) and hand-triggered via `manager.spawn('molthkin',
pos)` — **not** `spawnBoss()`, which is hardcoded to `'lastneedle'`.

**Molthkin is genuinely KILLABLE.** `ARCHETYPE_CONFIG.molthkin.bound ===
false`, so on reaching 0 hp it still routes through `_killBoss` (so
`'bossDefeated'` fires, not `'mobDeath'`) but with `bound:false` and no
`victoryTrigger`/`achievement` fields, **and** `_dropLoot` is called right
after — its loot table (`everthread`, `chance:1.0`) fires a `'mobDrop'`
immediately following `'bossDefeated'`:

```js
// 'bossDefeated':
{
  archetype: 'molthkin',
  canonicalId: 'molthkin',
  bound: false,
  // no victoryTrigger, no achievement -- those are lastneedle-only
  // ...species, mob, position as usual
}
// immediately followed by 'mobDrop' (its table is chance:1.0, so this always fires):
{ mobId, archetype: 'molthkin', canonicalId: 'molthkin', itemId: 'everthread', pos, count }
```

Contrast with The Last Needle above: `bound:true` there means "the
encounter resolves by binding, not killing" (no loot, has
`victoryTrigger`/`achievement`); `bound:false` here means "this is an
ordinary kill with special loot" (no victory wiring, but very much drops
something).

**Simplified 2-phase hp-fraction model** (canonical threshold: 50%,
`ARCHETYPE_CONFIG.molthkin.phase1HpFrac = 0.5`), exposed as `mob.bossPhase`
(0 or 1, fed into `animate()` as `state.phase`):

- **Phase 0** (`frac > 0.5`): slow, deliberate grounded approach + heavy
  thread-arm melee/short-range attack (`attackRange: 2.2`, `cooldown: 2.0s`,
  `damage: 11`).
- **Phase 1** (`frac <= 0.5`, enraged): `1.6x` speed, tighter `attackRange:
  2.6`, faster `cooldown: 1.1s`, `damage: 14`. Every `summonCooldown: 7s` it
  summons an add near itself — mostly `'exploder'`/Waxling with a
  `summonArchetypeAltChance: 0.4` (40%) chance of `'emberspinner'` instead
  — capped at `maxAdds: 3` simultaneously-alive adds (tagged
  `spawnedBy: <bossId>`, same pattern as The Last Needle's own summoning).

Suggested wiring (note the `bound` branch, and that molthkin needs its own
loot-pickup handling exactly like any other `'mobDrop'`):

```js
manager.addEventListener('bossDefeated', (e) => {
  if (e.detail.bound) {
    // lastneedle: bound, not killed -- win-condition wiring (see above).
    game.grantAchievement(e.detail.achievement);
    game.fireTrigger(e.detail.victoryTrigger);
  } else {
    // molthkin: an ordinary kill of a very large thing.
    game.grantAchievement('molthkin_unwound'); // pick your own id -- not canon-specified here
  }
});
```

## Selvage Wardens (Nevermend mini-boss, self-mending, NOT `isBoss`)

`selvagewarden` (species **Selvage Wardens**, `canonicalId:
'selvage_warden'`) guards the causeway to The Last Needle's arena per
`content/boss.json`. It's hand-placed/structure-bound like the two bosses
(never in `spawnRules.SPAWN_TABLES`) but is deliberately **not**
`isBoss` — it dies through the completely ordinary `_killMob` path, firing
plain `'mobDeath'` + `'mobDrop'` (`hemstone`, the canonical `hemstone`
source), **never** `'bossDefeated'`.

**Self-mending.** `ARCHETYPE_CONFIG.selvagewarden` sets
`regenPerSec: 2, regenDelay: 5`: every AI tick, `_updateRegen` checks
`mob.sinceHurt` (seconds since `_hurtMob` last ran, reset there) and, once
at least `regenDelay` seconds have passed since it was last hurt, heals
`regenPerSec` hp/sec, capped at `maxHp`. This is generic infrastructure —
any future archetype can opt in by just setting `config.regenPerSec` — but
`selvagewarden` is currently the only one that does, selling the "re-
stitches, doesn't bleed" lore from its own creature module's shimmer
animation. Reuses the `groaner` `aiBase` for its hostile melee loop
(`aggroRange: 12`, `attackRange: 1.1`, `contactDamage: 9`).

## Movement: navigation + despawn

**Smarter movement.** `mobs/ai.js` adds two navigation helpers, wrapped by
`MobManager._steerGroundedHostile`/`_steerFlyer`:

- `navSteer(position, desired, halfWidth, isSolid, opts)` — used for
  **grounded hostile** mobs (any `ARCHETYPE_CONFIG[*].hostile === true`,
  non-flying archetype, including a currently-provoked `scaldwarden` and
  `molthkin`'s own grounded boss AI) while wandering pre-aggro and while
  seeking, **and** to drive a mounted rider's movement (see "Mounts"
  below). Takes a small, fixed number of `isSolid()` samples per call to
  detect a 1-block step directly ahead and signal `wantJump` (consumed by
  `MobManager` as `mob.velocity.y = AI.JUMP_SPEED`), and to avoid steering
  straight off a cliff edge. Passive/neutral grounded archetypes
  (`grazer`/`trader`/`bobbindeer`/`spoolmare`/an unprovoked `scaldwarden`)
  keep the original plain `wanderSteer`/`fleeSteer`/tethered-wander path
  unchanged.
- `flyerAvoid(position, desired, isSolid, opts)` — used for **all** flying
  archetypes (`screecher`, `silencemoth`, `raveler`, `lastneedle`).
  Suggests a `vy` nudge to climb over terrain ahead / settle toward a
  cruise altitude; this is layered **additively** on top of each flyer's
  existing hover-height lerp (`spawnPos.y + hoverHeight`) physics in
  `_updateMobPhysics`, rather than replacing it, so the pre-existing hover
  mechanic is preserved. `raveler` opting into this (`config.flies:true`)
  is one of the two "fixed deviations" — see below.

**Despawn rules.** `mobs/spawnRules.js`'s `DESPAWN_CONFIG` (`radius: 48`
blocks, `minAgeSeconds: 12`, `exemptArchetypes: ['trader', 'lastneedle',
'scaldwarden']`, `bossExempt: true`) and `shouldDespawn(mob, playerPos,
opts)` are consulted by `MobManager._updateDespawn`, a low-rate sweep
(every ~3-5s, not every tick) that quietly removes mobs that are both old
enough (`mob.ageSeconds >= minAgeSeconds`) and far enough from the player
(horizontal distance `>= radius`). Despawn emits `'mobDespawn'` — no loot,
no `'mobDeath'`. Traders (persistent NPCs), Scaldwardens (stationary
forge-guardians tied to their post), and both bosses (`bossExempt: true`,
hand-managed by their encounters) are exempt. A **currently-mounted mob is
always exempt too** (`_updateDespawn` skips any `mob.rider`-truthy mob,
belt-and-suspenders re-checked in `_despawnMob`) regardless of
`exemptArchetypes` — see "Mounts" below. **`molthkin` is covered by
`bossExempt` since `isBoss:true`; `selvagewarden` is currently NOT in
`exemptArchetypes` and is not a boss, so it IS subject to ordinary ambient
despawn** even though it's hand-placed/structure-bound like the two
bosses — flagged here as a possible follow-up, not fixed as part of this
pass (`spawnRules.js` isn't owned by this pass and the mini-boss's own
task scope didn't call for a despawn-exemption change).

## Mounts

`spoolmare` is the first rideable archetype (`ARCHETYPE_CONFIG.spoolmare.
rideable === true`), backed by a small, generic mount/ride API on
`MobManager` that any future `rideable:true` archetype can reuse without
further changes to `MobManager.js`:

```js
const controller = manager.mountPlayer(mob);
// -> { mob, setInput, dismount } | null
//    null if: mob is dead/already mounted, its ARCHETYPE_CONFIG lacks
//    rideable:true (spoolmare has this, or archetype === 'spoolmare'), or
//    its creature module didn't expose root.userData.rideAnchor.

controller.setInput({ moveX, moveZ, jump });
// equivalently: manager.setRideInput(mob, { moveX, moveZ, jump });
// equivalently: mob.setRideInput({ moveX, moveZ, jump }); // bound closure, set at spawn time
// -- call this once per frame with a world-space desired horizontal
//    direction (need not be pre-normalized; magnitude is clamped to 1
//    before being scaled by config.rideSpeed) plus an optional jump flag
//    (applied only if the mount is currently grounded).

controller.dismount();
// equivalently: manager.dismountPlayer(mob);
```

**How it works.** `spawn()` reads `group.userData.rideAnchor` (set by the
creature module's own `build()` — currently only `spoolmare.js`, at the
saddle point on its back) onto `mob.rideAnchor`. Once mounted,
`manager.update(dt)` routes that mob through a new `_driveRideInput(mob,
dt)` **instead of** its normal AI every tick — it reads `mob.rideInput`,
clamps/scales it by `config.rideSpeed` (kept separate from `spoolmare`'s
own unridden `speed`/`fleeSpeed` tuning so mounting never perturbs its
ambient AI), and drives it through the **exact same**
`_steerGroundedHostile` → `AI.navSteer` path used by every grounded
hostile mob — so a rider gets the same gravity/collision/1-block-step-up
physics for free, plus a jump impulse if `input.jump && mob.grounded`.
Dismounting (`mob.rider = null`) hands control back to the normal AI next
tick. A mounted mob is exempt from the ambient despawn sweep (see above)
and is force-dismounted defensively in `_killMob`/`_killBoss`/
`_despawnMob` — a mount can never die or despawn out from under its rider
silently.

**Seating the player/camera.** Read `mob.rideAnchor`'s live THREE **world**
position each frame (after `manager.update(dt)`, via
`mob.rideAnchor.getWorldPosition(vec3)`), and use that to place the
player/camera. `mobs/demo.html`'s `window.__mountSpoolmare()` does exactly
this (see "Running the demo" below) and additionally drops a small visible
marker sphere there for screenshots.

Events: `'mobMount'`/`'mobDismount'` — `{ archetype, canonicalId, mob }`,
fired by `mountPlayer()`/`dismountPlayer()` respectively — see "Events"
above.

## Breeding & spawn eggs

`mobs/breeding.js` is a deliberately **stub-simple** data module (`
canBreed(archetype)`, `describeBaby(archetype)`, `spawnEggId(archetype)`)
backing two new async `MobManager` methods:

```js
const mob = await manager.spawnEgg(archetype, pos);
// -> mob | null. Creative-mode spawn-egg hook: confirms `archetype` is
//    both registered here AND has a spawn-egg id in breeding.js's
//    SPAWN_EGGS, then spawns it normally via spawn(). Resolves to null on
//    any validation failure.

const baby = await manager.breed(mobA, mobB, pos);
// -> mob | null. If mobA/mobB are both alive, share the same archetype,
//    and breeding.js's canBreed(archetype) is true, spawns a baby
//    (mob.isBaby = true, group scaled by describeBaby(archetype).scale)
//    at their midpoint (or `pos`, if given). Emits 'mobBreed'
//    { archetype, canonicalId, baby } on success. No love-mode/feeding/
//    cooldown state is tracked here -- this just validates + spawns; a
//    richer breeding UX (feeding items, a love-mode timer/particle,
//    parent cooldowns) is future scope, same spirit as the boss/mount
//    additions before it were once "future phases" in this same file.
```

**Why these two are `async` / a guarded dynamic import.** `mobs/
breeding.js` currently exports via CommonJS `module.exports = {...}`
instead of this codebase's ES `export` convention (every other file here
uses `import`/`export`, and `demo.html` loads everything as real browser
ES modules via an import map). A static top-level `import * as breeding
from './breeding.js'` would throw `"module is not defined"` the instant a
real browser ES-module loader evaluated it — and being a top-level import,
that error would be uncatchable and would take **all** of `MobManager.js`
down with it. Both methods instead route through a private
`_loadBreeding()` that lazily, defensively loads `breeding.js` via a
**guarded, cached dynamic `import().catch(() => null)`** — so today, in a
real browser, `spawnEgg()`/`breed()` simply resolve to `null` (graceful
no-op) rather than crashing anything, and `MobManager` itself keeps
working regardless. **Fixing `breeding.js` to use real `export` statements
(swapping its one `module.exports = {...}` line) is a small, self-
contained follow-up** that makes both methods work end-to-end with no
further `MobManager.js` changes needed — flagged here, not fixed as part
of this pass since `breeding.js` isn't owned by it. Separately,
`breeding.js`'s own `SPAWN_EGGS`/breedable-archetype list does not yet
include `'molthkin'`, so `spawnEgg('molthkin')` will stay `null` even
after that export fix — a `breeding.js` data gap, not a `MobManager.js`
one.

## Fixed deviations

Two Phase-2-era simplifications, both flagged as known deviations from
canon in earlier revisions of this file, were fixed in this pass:

- **`scaldwarden` now genuinely provokes.** It previously ran the fully-
  neutral `trader` `aiBase` (idle/tether, never attack) because there was
  no provoke/retaliate mechanic in the AI set. It now has its own
  `'guardian'` `aiBase` (`_aiGuardian`): idles/tethers near its post
  exactly like a trader by default, but `_hurtMob` now sets
  `mob.provoked = true` + `mob.provokeTimer = config.provokeDuration`
  (default 8s, `ARCHETYPE_CONFIG.scaldwarden.provokeDuration = 8`)
  whenever the hurt mob's `aiBase` is `'guardian'`; the timer is
  decremented every AI tick (clearing `mob.provoked` at 0), and while
  provoked it seeks + attacks like a `groaner` using
  `config.contactDamage` (`6`, canon's `dmg6` — previously stored but
  never read by any code path). Once the timer runs out it reverts to
  neutral idling. `mob.provoked`/`mob.provokeTimer` are on every mob
  object (no-ops for any non-`'guardian'` archetype).
- **`raveler` now truly hovers.** It previously had `flies:false` and was
  only *animated* as if hovering while actually walking on the ground
  navigation path. `ARCHETYPE_CONFIG.raveler` now has `flies:true` +
  `hoverHeight:0.6`, and `_aiGroaner` (the `aiBase` it reuses) is now
  flight-aware: when `config.flies` is set, its attack-hold/seek steering
  routes through `_steerFlyer` (composing `AI.flyerAvoid` terrain
  avoidance) instead of `_steerGroundedHostile` — the same pattern the
  boss already used to compose flyer physics with its own seek logic — so
  `raveler` gets real target-seeking hover flight through the shared
  flyer physics path in `_updateMobPhysics`, rather than a bespoke
  raveler-only AI function. No other `groaner`-family archetype has
  `flies:true`, so this was additive/non-breaking for the rest of that
  family (`groaner`/`frayedhound`/`emberspinner`/`unpicked`/`needlejack`/
  `selvagewarden` are all unaffected).

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

- `http://localhost:8130/mobs/demo.html` — showcase row of all **seventeen**
  creatures (including both bosses and the mini-boss) plus a live
  `MobManager` simulation over a `StubWorld` with a scripted moving
  "player" position (so mobs wander/seek/flee/attack on their own). An
  on-page HUD shows dimension (all 3: `warpwold`/`cinderloom`/`nevermend`),
  day/night, mob count, and (once triggered) each boss's current
  phase/hp, whether a spoolmare is currently mounted, and the scaldwarden
  provoke-test result. An event log panel prints every
  `mobSpawn`/`mobHurt`/`mobDeath`/`mobAttack`/`mobDrop`/`mobDespawn`/
  `bossDefeated`/`mobMount`/`mobDismount`/`mobBreed` event, each tagged
  with both `archetype` and `canonicalId`. Buttons let you toggle
  day/night, force-spawn the non-hand-placed archetypes, **run both boss
  sims**, **mount a spoolmare**, and **run the provoke test** (see below).
- `http://localhost:8130/mobs/demo.html?mob=<archetype>` — isolates that
  one creature, centered and slowly auto-rotating, with a synthetic
  `animate()` state driven for it (looping fuse ramp for `exploder`,
  hover/moving for `screecher`/`silencemoth`, a full phase-0→1→2 cycle
  with periodic attack flashes for `lastneedle`, a phase-0→1 cycle with
  attack flashes for `molthkin`, walking/attack-pulse for the hostile
  grounded archetypes (now including `selvagewarden`), idle for the rest).
  `<archetype>` is any of `grazer`/`trader`/`groaner`/`exploder`/
  `screecher`/`bobbindeer`/`frayedhound`/`emberspinner`/`unpicked`/
  `needlejack`/`scaldwarden`/`raveler`/`spoolmare`/`silencemoth`/
  `selvagewarden`/`molthkin`/`lastneedle`. Intended for per-creature
  screenshots.

### Boss sims

Click **"Run Boss Sim (The Last Needle)"** / **"Run Molthkin Sim
(Cinderloom)"** in the HUD, or call `window.__runBossSim()` /
`window.__runMolthkinSim()` directly — the two are independent and can run
concurrently (separate `MobManager`s, separate arenas offset apart in
world space so they don't overlap). Each:

1. Switches to the boss's home dimension using an **engine id** (Last
   Needle: `'end'` → `'nevermend'`; Molthkin: `'nether'` → `'cinderloom'`)
   — proving the `normalizeDimension` reconcile resolves it correctly.
2. Builds a dedicated boss-arena world (`new StubWorld({ arena: true })`)
   and a scoped `MobManager` over it (also constructed with the same
   engine dimension id), since `MobManager`'s world is fixed at
   construction time (there's no `setWorld()`).
3. Spawns the boss — `bossManager.spawnBoss(pos)` for The Last Needle (a
   thin wrapper hardcoded to `'lastneedle'`), or `molthkinManager.spawn(
   'molthkin', pos)` directly for Molthkin (`spawnBoss()` can **not** be
   reused for it).
4. Scripts repeated `boss.hurt(dmg)` calls on a ~200ms timer over ~7
   seconds, sized from the boss's `maxHp` so hp sweeps through all
   canonical phase thresholds (Last Needle: 60%/15%; Molthkin: 50%) and
   reaches 0 — driving each encounter through all its phases (observing
   Last Needle's Phase 1/2 `'raveler'` summons, and Molthkin's Phase-1
   `'exploder'`/`'emberspinner'` summons, along the way) and firing
   exactly one `'bossDefeated'` each: The Last Needle's is `bound:true`
   with `victoryTrigger`/`achievement` and **zero** `'mobDrop'`; Molthkin's
   is `bound:false` with neither field and **is** followed by a
   `'mobDrop'` (`everthread`).

### Mount + provoke demos

- Click **"Mount Spoolmare"** or call `window.__mountSpoolmare()`: spawns a
  spoolmare at a fixed off-to-the-side spot, mounts it via
  `manager.mountPlayer()`, and scripts ~2.5s of forward ride input (via
  the returned controller's `setInput()`) so it visibly trots forward
  under the real shared grounded-body physics path. A small cyan marker
  sphere is repositioned every frame to `mob.rideAnchor`'s live world
  position (exactly how a builder would seat a player/camera), so a
  screenshot shows the saddle point. `window.__mountState` is
  live-updated every frame — see below.
- Click **"Provoke Test (Scaldwarden)"** or call `window.__provokeTest()`:
  spawns a scaldwarden at a fixed off-screen spot, confirms it spawns
  neutral (`mob.provoked === false` — it never attacks while neutral),
  hurts it once, and confirms `_hurtMob`'s `'guardian'`-specific branch
  flips `mob.provoked = true` (hostile for `provokeDuration` seconds).
  Result on `window.__scaldProvoked`.

The demo exposes Playwright-friendly hooks on `window`:

- `window.__ready` — `true` once the first frame has rendered.
- `window.__events` — array of every event the manager(s) have emitted so
  far (`{name, archetype, canonicalId, species, position, dmg, explosion,
  itemId, count, mobId, bound, victoryTrigger, achievement, t}`; irrelevant
  fields are `undefined` per event type — e.g. `mobDrop` entries have
  `itemId`/`count`/`mobId` but no `species`; `mobMount`/`mobDismount`/
  `mobBreed` entries have `mobId` derived from `detail.mob`/`detail.baby`
  but no `species`/`position`/`dmg`).
- `window.__mobCount` — getter, current live mob count on the main manager
  (showcase mode only; 0 in isolate mode; does not include the separate
  boss-sim managers' mobs — see `hudCount` in the HUD for the combined
  total).
- `window.__forceSpawnAll()` — spawns one of each **non-hand-placed**
  archetype (everything except `lastneedle`/`molthkin`/`selvagewarden` —
  the two bosses and the structure-bound mini-boss, none of which are ever
  in `spawnRules.SPAWN_TABLES`) via `manager.spawn(archetype, pos)` around
  the current player position; returns the spawned mob array.
- `window.__testLoot(maxAttempts?)` — spawns a `grazer`/Skeinling at a
  fixed off-screen position, kills it in one hit
  (`mob.hurt(mob.maxHp + 1000)`), and returns the `'mobDrop'` event(s) it
  produced (from `window.__events`, filtered to that mob's id). Since
  `LOOT_TABLES.grazer` rolls `raw_skein` at a 90% independent chance (not
  guaranteed), this retries with a fresh grazer up to `maxAttempts`
  (default 25) until a drop lands. Lets a verifier assert
  `drops[0].itemId === 'raw_skein'` — confirming the drop is the REAL
  canonical id, not a stub.
- `window.__runBossSim()` — triggers The Last Needle boss sim described
  above; returns `true` if it started, `false` if a run is already in
  progress or spawn failed.
- `window.__bossState` — `{ phase, hp, maxHp }`, live-updated every frame
  while the boss sim's boss mob is alive; `phase`/`hp` reflect
  `mob.bossPhase`/`mob.hp` directly.
- `window.__bossDefeated` — `boolean`, flips to `true` the moment
  lastneedle's `'bossDefeated'` fires (persists until the next
  `__runBossSim()` call resets it to `false`).
- `window.__runMolthkinSim()` — triggers the Molthkin boss sim described
  above; same return-value contract as `__runBossSim()`.
- `window.__molthkinState` — `{ phase, hp, maxHp }`, the Molthkin
  equivalent of `__bossState`.
- `window.__molthkinDefeated` — `boolean`, the Molthkin equivalent of
  `__bossDefeated`.
- `window.__molthkinDrops` — array of `{ itemId, count, pos }`, appended
  to every time a `'mobDrop'` with `archetype === 'molthkin'` fires (i.e.
  every Molthkin defeat, since its loot table is `chance:1.0`) — lets a
  verifier assert `everthread` was actually dropped, not just that
  `bossDefeated` fired.
- `window.__mountSpoolmare()` — triggers the mount demo described above;
  returns `true`/`false`.
- `window.__mountState` — `{ mounted: boolean, riderAnchorPos:
  {x,y,z} | null }`, live-updated every frame from the mounted spoolmare's
  `rideAnchor` world position (or `{mounted:false, riderAnchorPos:null}`
  once dismounted/dead).
- `window.__provokeTest()` — triggers the provoke demo described above;
  returns `true`/`false` (`true` only if it was neutral before AND
  provoked after).
- `window.__scaldProvoked` — `boolean`, the result of the last
  `__provokeTest()` run.
- `window.__setMob(archetype)` — navigates to `?mob=<archetype>` (isolate
  mode) for scripted screenshotting.
- `window.__error` — set to a string (and rendered in a visible `<pre>`)
  if anything in init or the render loop throws.
- `window.__manager` — the main showcase-mode `MobManager` instance
  (showcase mode only).
- `window.__getPlayerPos()` — the scripted figure-eight player position
  function (showcase mode only).

Verified in this session via a headless **real-browser** Playwright/
Chromium run against `mobs/serve.mjs` (not just a Node smoke test): all
non-hand-placed archetypes (`__forceSpawnAll()`) spawn without error;
`__mountSpoolmare()` mounts a spoolmare, feeds ride input, and
`__mountState.riderAnchorPos` visibly advances frame-over-frame (confirmed
the mount actually moves under the real physics path, not just that the
event fired); `__provokeTest()` confirms a scaldwarden is neutral before
and provoked after being hurt; `__runBossSim()`/`__runMolthkinSim()` run
concurrently to completion, each firing exactly one `'bossDefeated'` with
the correct per-boss `bound`/`victoryTrigger`/`achievement` shape, and
Molthkin's is confirmed followed by a `'mobDrop'` with `itemId:
'everthread'` (captured in both `window.__events` and
`window.__molthkinDrops`); `__testLoot()` still confirms `raw_skein`; and
isolate mode (`?mob=<archetype>`) loads without error for every new
archetype. Zero console/page errors across the whole run. (Note: this
verification required temporarily restoring the real r160 `three.module.js`
bundle from git history over the truncated 11-line stub currently
sitting in the working tree at `mobs/vendor/three.module.js` — see
`mobs/integration.md`'s "Known issues" section; the stub was restored to
its original found state afterward, unmodified, since fixing it isn't
in scope for this pass.)

## Dimension / day-night spawn rules

From `mobs/spawnRules.js` (`SPAWN_TABLES`, weighted random pick via
`pickSpawn(dimension, isDay, rng, biome)`):

| Dimension | Period | Table (archetype: weight) | Max alive |
|---|---|---|---|
| `warpwold` | day | grazer: 6, bobbindeer: 4, trader: 2, spoolmare: 2 (uncommon) | 14 |
| `warpwold` | night | groaner: 4, frayedhound: 4, needlejack: 3, screecher: 1, silencemoth: 3 (ambient) | 14 |
| `cinderloom` | always (no day/night split) | exploder: 5, emberspinner: 5, screecher: 4, scaldwarden: 2, groaner: 1 | 12 |
| `nevermend` | always (no day/night split) | unpicked: 5, raveler: 4, screecher: 2, groaner: 2 | 10 |

`cinderloom` and `nevermend` are in `ALWAYS_HOSTILE_DIMENSIONS`, so
`isDay` is ignored for them (both their "day" and "night" tables are
identical). `maxAliveFor(dimension)` falls back to `DEFAULT_MAX_ALIVE`
(10) for unknown dimensions; `opts.maxMobs` on the `MobManager` overrides
the per-dimension cap entirely if set. `lastneedle`, `molthkin`, and
`selvagewarden` never appear in any table — all three are hand-placed/
structure-bound (per `spawnRules.SPAWN_TABLES`'s own header comment) — see
"The two bosses" / "Selvage Wardens" above.

An optional `BIOME_MODIFIERS` layer (`warpwold` only: `plains`/`forest`/
`desert`/`mountains`/`snow`/`ocean`) applies additive per-archetype weight
deltas on top of the base table when a `biome` argument is passed to
`pickSpawn`; `cinderloom`/`nevermend` have no biome set, so any biome
passed for them safely falls back to the unmodified base table.

## Canonical species: fully implemented

As of this pass, `content/bestiary.json`'s full canonical Loomfall roster
is implemented in `mobs/` — no deferred/unimplemented species remain. (An
earlier revision of this file tracked `spoolmare`/`silence_moth`/
`selvage_warden`/`molthkin` here as future-phase deferrals pending a
mount/ride system, an ambient nibble mechanic, a regen mechanic, and a
second boss encounter respectively; all four now have a
`mobs/creatures/<archetype>.js`, a `REGISTRY`/`ARCHETYPE_CONFIG` entry, and
(where they're not hand-placed) a `SPAWN_TABLES` slot — see the roster
table at the top of this file.) If a future pass adds an entirely new
archetype beyond canon's current 17, follow the same pattern established
across every phase of this package: add `mobs/creatures/<archetype>.js`
with `build()` + `meta` (including `canonicalId`), register it in
`MobManager.js`'s `REGISTRY`/`ARCHETYPE_CONFIG`, add its `canonicalId` to
`spawnRules.CANONICAL_ID`, and (if it should spawn ambiently rather than
be hand-placed) a `SPAWN_TABLES` entry.
