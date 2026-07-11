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
reconciliation with the real game engine (`overworld`/`nether`/`end`). All
Phase 2 work lives in `mobs/MobManager.js`, `mobs/lootTables.js`,
`mobs/spawnRules.js`, `mobs/ai.js`, `mobs/blocksAdapter.js`,
`mobs/world/StubWorld.js`, and the five new files under `mobs/creatures/`.

## What's in here

| File | Purpose |
|---|---|
| `mobs/creatures/*.js` | One file per archetype. Each exports `build()` (returns a `THREE.Group`) and `meta` (species/lore/palette). Ten files: `grazer`, `trader`, `groaner`, `exploder`, `screecher`, `bobbindeer`, `frayedhound`, `emberspinner`, `unpicked`, `lastneedle`. |
| `mobs/MobManager.js` | `export class MobManager extends EventTarget` (also the default export). Owns spawning, AI, physics stepping, and animation-driving for all live mob instances, including the boss. |
| `mobs/ai.js` | Pure helper functions (gravity, collision resolution, wander/seek/flee steering, grounded step-up/cliff-avoid navigation, flyer terrain-avoidance). Takes an `isSolid(x,y,z)` predicate as a parameter — no direct world/block imports. |
| `mobs/spawnRules.js` | Per-dimension, day/night-aware weighted spawn tables (`SPAWN_TABLES`, `pickSpawn`, `maxAliveFor`), dimension-id reconciliation (`normalizeDimension`, `DIMENSION_ALIASES`), and despawn rules (`DESPAWN_CONFIG`, `shouldDespawn`). |
| `mobs/lootTables.js` | Per-archetype loot tables (`LOOT_TABLES`) and `rollLoot(archetype, rng)`. Item ids are placeholder strings — see "Loot" below. |
| `mobs/blocksAdapter.js` | **Fallback** `getBlockDef(id)` shim — see "World contract" below. |
| `mobs/world/StubWorld.js` | Minimal `getBlock(x,y,z)` implementation used by demos/tests only. Supports a flat boss-arena mode (`new StubWorld({arena:true})`). |
| `mobs/demo.html` + `mobs/vendor/three.module.js` | Standalone browser harness (see "Running the demo" below). |
| `mobs/serve.mjs` | Zero-dependency static file server for local demo/testing. |

## Archetypes → Loomfall species

| Archetype | Species | aiBase | Temperament | Default dimension | Flies? |
|---|---|---|---|---|---|
| `grazer` | **Skeinling** | `grazer` | Passive (wanders, flees ~4s when hurt) | `warpwold` | no |
| `trader` | **Wickerkin** | `trader` | Neutral (tethered-wander near spawn, never attacks) | `warpwold` | no |
| `groaner` | **Understruck** | `groaner` | Hostile (wanders → seeks in aggro range → contact-damages on cooldown) | `warpwold` | no |
| `exploder` | **Waxling** | `exploder` | Hostile (approaches, fuses 0→1 over 1.5s in range, detonates: blast damage + self-death) | `cinderloom` | no |
| `screecher` | **Slagmoth** | `screecher` | Hostile flyer (ignores gravity, hovers at `spawnPos.y + hoverHeight`, drifts/attacks) | `cinderloom` | yes |
| `bobbindeer` | **Bobbin-deer** | `grazer` | Passive grazer, notably faster/more skittish flee (fleeSpeed 3.2 vs grazer's 2.4) | `warpwold` | no |
| `frayedhound` | **Frayed Hound** | `groaner` | Hostile pack-predator: low hp, fast (speed 1.4/seek 2.6), short attack cooldown (0.8s) | `warpwold` | no |
| `emberspinner` | **Emberspinner** | `groaner` | Hostile, very fast (seek 2.4), very fragile (maxHp 4), wide stance (halfWidth 0.5) | `cinderloom` | no |
| `unpicked` | **The Unpicked** | `groaner` | Hostile tanky bruiser: high hp (22), slow (speed 0.4), heavy contact damage (5) | `nevermend` | no |
| `lastneedle` | **The Last Needle** (BOSS) | `boss` | Hostile flyer, 3-phase encounter, maxHp 300 — see "The boss: The Last Needle" below | `nevermend` | yes |

`aiBase` (an `ARCHETYPE_CONFIG[*].aiBase` field in `MobManager.js`) selects
which internal `_ai*()` behaviour function `_updateMobAI` dispatches to; it
is independent of the archetype's spawn-table/registry key, which is why
e.g. `frayedhound`/`emberspinner`/`unpicked` each reuse the `groaner`
aggro/attack loop but with their own tuning (`ARCHETYPE_CONFIG[mob.archetype]`
is looked up per-mob, not hardcoded per aiBase). Each creature module's own
`meta.archetype` field matches its `aiBase` (e.g. `bobbindeer.js`'s
`meta.archetype === 'grazer'`).

Note: `groaner`, `exploder`, and `screecher` also appear (at different
weights) in `nevermend`'s spawn table, and `warpwold` spawns
`groaner`/`frayedhound`/`screecher` at night. `lastneedle` never appears in
any `SPAWN_TABLES` entry — the boss is always hand-triggered via
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
manager.mobs;                    // getter -> array snapshot of live mob objects
manager.setDay(isDay: boolean);  // override day/night without opts.isDay
```

### Per-mob object shape

```js
{
  id, archetype, species,           // e.g. 'exploder', 'Waxling'
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
  spawnedBy,                        // id of the boss mob that summoned this add (phase-1
                                     //   'unpicked' summons), else null
  dead,                             // boolean
  hurt(dmg),                        // call to damage this mob; may kill it and emit mobDeath
                                     //   (or, for the boss, bossDefeated) + mobDrop
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

## Events

`MobManager` emits seven event names, both as `CustomEvent` (via its
`EventTarget` base — use `manager.addEventListener(name, handler)`) **and**
via `opts.onEvent(name, detail)` if provided:

- `'mobSpawn'` — `{ archetype, species, mob, position }`
- `'mobHurt'` — `{ archetype, species, mob, position, dmg }`
- `'mobDeath'` — `{ archetype, species, mob, position }` — **not** emitted
  for the boss; see `'bossDefeated'` below.
- `'mobAttack'` — `{ archetype, species, mob, position, dmg }`, plus for
  exploder detonations: `{ explosion: true, hitPlayer: boolean }`
- `'mobDrop'` (Phase 2) — `{ mobId, itemId, pos:{x,y,z}, count }` — one
  event per dropped item stack, computed via `lootTables.rollLoot()` and
  emitted immediately after `'mobDeath'` (or, for the boss, immediately
  after `'bossDefeated'`). Note the field is `pos`, not `position`, and
  there is no `archetype`/`species`/`mob` field on this event.
- `'mobDespawn'` (Phase 2) — `{ archetype, species, mob, position }` — a
  quiet ambient distance/age removal (see "Despawn rules" below); **no**
  loot is rolled for a despawn.
- `'bossDefeated'` (Phase 2) — `{ archetype:'lastneedle', species, mob, position, bound:true }`
  — emitted **instead of** `'mobDeath'` when a boss mob's hp reaches 0.
  `'mobDrop'` events for the boss's loot table follow immediately after.

`position`/`pos` is a plain `{x,y,z}` snapshot at emit time (not a live
reference). `mob` is the live per-mob object described above (absent on
`'mobDrop'`).

### Wiring to the audio engine

The audio engine lives on `feature/audio-engine` and is **not** a
dependency of this package (by design — `mobs/` must build/run
standalone). When integrating, something like:

```js
manager.addEventListener('mobSpawn', (e) => {
  const { archetype, position } = e.detail;
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
  audio.play('mob.lastneedle.defeat', { pos: e.detail.position, volume: 1.0 });
});
manager.addEventListener('mobDrop', (e) => {
  audio.play('loot.pickup_ping', { pos: e.detail.pos, volume: 0.4 });
});
```

The suggested sound-key convention is `"mob." + archetype + "." + variant`
(e.g. `mob.exploder.explode`, `mob.grazer.spawn`, `mob.groaner.attack`).
The same events are a natural hook for achievements (e.g. "first
Understruck defeated" on a `mobDeath` where `archetype === 'groaner'`, or
"The Loom Unmade" on `bossDefeated`).

## Loot

`mobs/lootTables.js` defines `LOOT_TABLES` (archetype → array of
`{ itemId, chance, min, max }`) and `rollLoot(archetype, rng)`, which
independently rolls each entry's `chance` and returns
`[{ itemId, count }, ...]` for the hits. `MobManager._dropLoot(mob)` calls
this after every `mobDeath`/`bossDefeated` (never on `mobDespawn`) and
emits one `'mobDrop'` event per resulting stack.

**Item ids are placeholder stub strings**, not a real content registry —
`content/items.json` does not exist yet in this repo. When it lands, these
ids must be reconciled (renamed/remapped) against the real item registry.
The current stub ids, by dropping archetype:

| Archetype | Item ids (stub) |
|---|---|
| `grazer` | `raw_skein` |
| `trader` | `spare_button` |
| `groaner` | `tattered_thread`, `dawnthread` |
| `exploder` | `bindwax` |
| `screecher` | `mothdust` |
| `bobbindeer` | `thread_sinew`, `hide_cloth` |
| `frayedhound` | `fray_fang`, `raw_skein` |
| `emberspinner` | `ember_silk`, `cinderthread` |
| `unpicked` | `loose_thread`, `voidknot` |
| `lastneedle` | `everthread` (3-5), `the_last_stitch` (1, guaranteed) |

Wiring into the builder's Inventory system:

```js
manager.addEventListener('mobDrop', (e) => {
  const { itemId, count, pos } = e.detail;
  inventory.addOrSpawnPickup(itemId, count, pos); // reconcile itemId once content/items.json exists
});
```

## The boss: The Last Needle

`lastneedle` (species **The Last Needle**) is the Nevermend boss:
`aiBase: 'boss'`, `isBoss: true`, `maxHp: 300`, flies. It is **never**
listed in `spawnRules.SPAWN_TABLES` — it's hand-triggered via
`manager.spawn('lastneedle', pos)` or the `manager.spawnBoss(pos)`
convenience wrapper — and it is exempt from both the ambient max-alive cap
and the despawn sweep (`spawnRules.DESPAWN_CONFIG.exemptArchetypes`
includes `'lastneedle'`, plus a belt-and-suspenders `bossExempt`/`isBoss`
check).

Every AI tick recomputes `mob.bossPhase` (0/1/2) from the boss's current hp
fraction (`ARCHETYPE_CONFIG.lastneedle.phase1HpFrac = 0.66`,
`phase2HpFrac = 0.33`) and exposes it both on the mob object and as
`state.phase` passed into `animate()`:

- **Phase 0** (`frac > 0.66`): slow hover-drift toward the player.
  Ranged attack at `attackRange: 7`, `cooldown: 2.2s`, `damage: 6`.
- **Phase 1** (`0.33 < frac <= 0.66`): `1.5x` speed, wider `attackRange: 10`,
  `cooldown: 1.7s`, `damage: 8`. Additionally, every `summonCooldown: 6s`
  the boss spawns an `'unpicked'` add near itself (tagged
  `spawnedBy: <bossId>`), capped at `maxAdds: 4` simultaneously-alive adds.
- **Phase 2** (`frac <= 0.33`): `2.0x` speed, short `attackRange: 5`, rapid
  `cooldown: 0.6s`, `damage: 14`. No further summoning.

On hp reaching 0, the boss routes to a distinct kill path
(`_killBoss` rather than `_killMob`): it emits `'bossDefeated'`
(**not** `'mobDeath'`) followed by `'mobDrop'` events for its loot table
(`everthread` x3-5, `the_last_stitch` x1 guaranteed).

**Suggested wiring to the ending epilogue:**

```js
manager.addEventListener('bossDefeated', (e) => {
  game.triggerEpilogue({ boss: e.detail.species, at: e.detail.position });
});
```

## Movement: navigation + despawn (Phase 2)

**Smarter movement.** `mobs/ai.js` adds two navigation helpers, wrapped by
`MobManager._steerGroundedHostile`/`_steerFlyer`:

- `navSteer(position, desired, halfWidth, isSolid, opts)` — used for
  **grounded hostile** mobs (any `ARCHETYPE_CONFIG[*].hostile === true`,
  non-flying archetype) while wandering pre-aggro and while seeking. Takes
  a small, fixed number of `isSolid()` samples per call to detect a
  1-block step directly ahead and signal `wantJump` (consumed by
  `MobManager` as `mob.velocity.y = AI.JUMP_SPEED`), and to avoid steering
  straight off a cliff edge. Passive/neutral grounded archetypes
  (`grazer`/`trader`/`bobbindeer`) keep the original plain
  `wanderSteer`/`fleeSteer` path unchanged.
- `flyerAvoid(position, desired, isSolid, opts)` — used for **all** flying
  archetypes (`screecher`, `lastneedle`). Suggests a `vy` nudge to climb
  over terrain ahead / settle toward a cruise altitude; this is layered
  **additively** on top of each flyer's existing hover-height lerp
  (`spawnPos.y + hoverHeight`) physics in `_updateMobPhysics`, rather than
  replacing it, so the pre-existing hover mechanic is preserved.

**Despawn rules.** `mobs/spawnRules.js`'s `DESPAWN_CONFIG` (`radius: 48`
blocks, `minAgeSeconds: 12`, `exemptArchetypes: ['trader', 'lastneedle']`,
`bossExempt: true`) and `shouldDespawn(mob, playerPos, opts)` are consulted
by `MobManager._updateDespawn`, a low-rate sweep (every ~3-5s, not every
tick) that quietly removes mobs that are both old enough
(`mob.ageSeconds >= minAgeSeconds`) and far enough from the player
(horizontal distance `>= radius`). Despawn emits `'mobDespawn'` — no loot,
no `'mobDeath'`. Traders (persistent NPCs) and the boss (hand-managed by
its encounter) are exempt.

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

- `http://localhost:8130/mobs/demo.html` — showcase row of all ten
  creatures (the original five plus Phase 2's `bobbindeer`/
  `frayedhound`/`emberspinner`/`unpicked`/`lastneedle`) plus a live
  `MobManager` simulation over a `StubWorld` with a scripted moving
  "player" position (so mobs wander/seek/flee/attack on their own). An
  on-page HUD shows dimension (all 3: `warpwold`/`cinderloom`/`nevermend`),
  day/night, mob count, and (once triggered) the boss's current phase/hp.
  An event log panel prints every `mobSpawn`/`mobHurt`/`mobDeath`/
  `mobAttack`/`mobDrop`/`mobDespawn`/`bossDefeated` event. Buttons let you
  toggle day/night, force-spawn one of each of the nine non-boss
  archetypes, and **run the boss sim** (see below).
- `http://localhost:8130/mobs/demo.html?mob=<archetype>` — isolates that
  one creature, centered and slowly auto-rotating, with a synthetic
  `animate()` state driven for it (looping fuse ramp for `exploder`,
  hover/moving for `screecher`, a full phase-0→1→2 cycle with periodic
  attack flashes for `lastneedle`, walking/attack-pulse for the rest).
  `<archetype>` is any of `grazer`/`trader`/`groaner`/`exploder`/
  `screecher`/`bobbindeer`/`frayedhound`/`emberspinner`/`unpicked`/
  `lastneedle`. Intended for per-creature screenshots.

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
   seconds, sized from the boss's `maxHp` so hp sweeps through both phase
   thresholds and reaches 0 — driving the encounter through all 3 phases
   and firing `'bossDefeated'` + `'mobDrop'` at the end.

The demo exposes Playwright-friendly hooks on `window`:

- `window.__ready` — `true` once the first frame has rendered.
- `window.__events` — array of every event the manager(s) have emitted so
  far (`{name, archetype, species, position, dmg, explosion, itemId,
  count, mobId, bound, t}`; irrelevant fields are `undefined` per event
  type — e.g. `mobDrop` entries have `itemId`/`count`/`mobId` but no
  `archetype`/`species`).
- `window.__mobCount` — getter, current live mob count on the main manager
  (showcase mode only; 0 in isolate mode; does not include the separate
  boss-sim manager's mobs — see `hudCount` in the HUD for the combined
  total).
- `window.__forceSpawnAll()` — spawns one of each of the **nine non-boss**
  archetypes via `manager.spawn(archetype, pos)` around the current player
  position; returns the spawned mob array. Never spawns the boss.
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

Verified in this session via a headless Playwright pass against
`mobs/serve.mjs`: showcase mode reaches `__ready` with zero console errors;
`__forceSpawnAll()` adds exactly the 9 non-boss archetypes (never the
boss) to `manager.mobs`; `__runBossSim()` switches dimension to
`'nevermend'` via the `'end'` engine id, drives the boss through all 3
observed `bossPhase` values (0, 1, 2), and ends with `__bossDefeated ===
true`, exactly one `'bossDefeated'` event, and 2 `'mobDrop'` events
(`everthread` + `the_last_stitch`); and isolate mode
(`?mob=bobbindeer|frayedhound|emberspinner|unpicked|lastneedle`) loads
cleanly for every Phase 2 archetype with zero console errors.

## Dimension / day-night spawn rules

From `mobs/spawnRules.js` (`SPAWN_TABLES`, weighted random pick via
`pickSpawn(dimension, isDay, rng, biome)`):

| Dimension | Period | Table (archetype: weight) | Max alive |
|---|---|---|---|
| `warpwold` | day | grazer: 6, bobbindeer: 4, trader: 2 | 14 |
| `warpwold` | night | groaner: 5, frayedhound: 4, screecher: 1 | 14 |
| `cinderloom` | always (no day/night split) | exploder: 5, emberspinner: 5, screecher: 4, groaner: 1 | 12 |
| `nevermend` | always (no day/night split) | unpicked: 5, screecher: 3, groaner: 2, exploder: 2 | 10 |

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
