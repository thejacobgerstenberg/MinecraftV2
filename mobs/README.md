# Loomfall Mobs Package

`mobs/` is a self-contained package implementing the five Loomfall creature
archetypes as living, animated THREE.js entities plus the AI/physics/spawn
manager that drives them in the game world. It has no dependency on any
other in-repo system except `three` (imported as the bare specifier
`"three"`) and, optionally, a real block-definition lookup the game builder
will inject once it exists.

## What's in here

| File | Purpose |
|---|---|
| `mobs/creatures/*.js` | One file per archetype. Each exports `build()` (returns a `THREE.Group`) and `meta` (species/lore/palette). |
| `mobs/MobManager.js` | `export class MobManager extends EventTarget` (also the default export). Owns spawning, AI, physics stepping, and animation-driving for all live mob instances. |
| `mobs/ai.js` | Pure helper functions (gravity, collision resolution, wander/seek/flee steering). Takes an `isSolid(x,y,z)` predicate as a parameter — no direct world/block imports. |
| `mobs/spawnRules.js` | Per-dimension, day/night-aware weighted spawn tables (`SPAWN_TABLES`, `pickSpawn`, `maxAliveFor`). |
| `mobs/blocksAdapter.js` | **Fallback** `getBlockDef(id)` shim — see "World contract" below. |
| `mobs/world/StubWorld.js` | Minimal `getBlock(x,y,z)` implementation used by demos/tests only. |
| `mobs/demo.html` + `mobs/vendor/three.module.js` | Standalone browser harness (see "Running the demo" below). |
| `mobs/serve.mjs` | Zero-dependency static file server for local demo/testing. |

## Archetypes → Loomfall species

| Archetype | Species | Temperament | Default dimension | Flies? |
|---|---|---|---|---|
| `grazer` | **Skeinling** | Passive (wanders, flees ~4s when hurt) | `warpwold` | no |
| `trader` | **Wickerkin** | Neutral (tethered-wander near spawn, never attacks) | `warpwold` | no |
| `groaner` | **Understruck** | Hostile (wanders → seeks in aggro range → contact-damages on cooldown) | `warpwold` | no |
| `exploder` | **Waxling** | Hostile (approaches, fuses 0→1 over 1.5s in range, detonates: blast damage + self-death) | `cinderloom` | no |
| `screecher` | **Slagmoth** | Hostile flyer (ignores gravity, hovers at `spawnPos.y + hoverHeight`, drifts/attacks) | `cinderloom` | yes |

Note: `groaner`, `exploder`, and `screecher` also appear (at different
weights) in `nevermend`'s spawn table, and `warpwold` spawns `groaner`/
`screecher` at night. See "Dimension / day-night spawn rules" below for the
exact weighted tables.

## MobManager API (exact, from source)

```js
import MobManager from './mobs/MobManager.js'; // also a named export

const manager = new MobManager(scene, world, {
  getPlayerPos,     // () => {x,y,z}  — REQUIRED for aggro/attack/flee behaviour;
                     //                  guarded internally if missing or throws.
  onPlayerHurt,      // (dmg:number) => void — called when a hostile mob hits the player.
  getBlockDef,       // optional (id) => {solid:boolean, ...} — see World contract below.
  isDay,             // optional () => boolean — defaults to always-day (true).
  rng,               // optional () => number in [0,1) — defaults to Math.random.
  dimension,         // optional string — defaults to 'warpwold'.
  maxMobs,           // optional number — overrides spawnRules' per-dimension cap.
  onEvent,           // optional (name:string, detail:object) => void — see Events below.
});
```

Required contract methods:

```js
manager.update(dt);        // step spawning, AI, physics, animation for one frame (dt in seconds)
manager.setDimension(id);  // despawns everyone, switches rule set, resumes spawning
manager.dispose();         // removes all mobs from the scene, drops references
```

Non-breaking additions (safe for the builder to use, not required by the
original contract):

```js
manager.spawn(archetype, pos);  // -> mob | null. Force-spawns at pos:{x,y,z},
                                 //    bypassing spawn-rule weighting/cadence.
                                 //    Used by the demo's __forceSpawnAll().
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
  dead,                             // boolean
  hurt(dmg),                        // call to damage this mob; may kill it and emit mobDeath
}
```

## World contract

`MobManager` expects `world.getBlock(x, y, z) -> blockId`. Solidity is then
resolved via `getBlockDef(blockId).solid`:

- If `opts.getBlockDef` is provided, it is used.
- Otherwise `MobManager` falls back to `mobs/blocksAdapter.js`'s
  `getBlockDef`, a small placeholder table (`threadstone`, `warpgrass`,
  `cinderrock`, `looseweave`, `water`, `void`, plus numeric ids 0-6).

**`mobs/blocksAdapter.js` is a fallback, not the source of truth.** The
real block registry (`public/src/blocks/blocks.js`) does not exist on any
branch yet, so all mob code was written defensively against its absence.
Once the builder ships it, wire it in like this:

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
undefined terrain.

## Events

`MobManager` emits four event names, both as `CustomEvent` (via its
`EventTarget` base — use `manager.addEventListener(name, handler)`) **and**
via `opts.onEvent(name, detail)` if provided:

- `'mobSpawn'` — `{ archetype, species, mob, position }`
- `'mobHurt'` — `{ archetype, species, mob, position, dmg }`
- `'mobDeath'` — `{ archetype, species, mob, position }`
- `'mobAttack'` — `{ archetype, species, mob, position, dmg }`, plus for
  exploder detonations: `{ explosion: true, hitPlayer: boolean }`

`position` is a plain `{x,y,z}` snapshot at emit time (not a live
reference). `mob` is the live per-mob object described above.

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
```

The suggested sound-key convention is `"mob." + archetype + "." + variant`
(e.g. `mob.exploder.explode`, `mob.grazer.spawn`, `mob.groaner.attack`).
The same events are a natural hook for achievements (e.g. "first
Understruck defeated" on a `mobDeath` where `archetype === 'groaner'`).

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

- `http://localhost:8130/mobs/demo.html` — showcase row of all five
  creatures plus a live `MobManager` simulation over a `StubWorld` with a
  scripted moving "player" position (so mobs wander/seek/flee/attack on
  their own). An on-page HUD shows dimension/day-night/mob count, and an
  event log panel prints every `mobSpawn`/`mobHurt`/`mobDeath`/`mobAttack`
  event. Buttons let you toggle day/night and force-spawn one of each
  archetype.
- `http://localhost:8130/mobs/demo.html?mob=grazer` (or `trader` /
  `groaner` / `exploder` / `screecher`) — isolates that one creature,
  centered and slowly auto-rotating, with a synthetic `animate()` state
  driven for it (looping fuse ramp for `exploder`, hover/moving for
  `screecher`, walking for the rest). Intended for per-creature
  screenshots.

The demo exposes Playwright-friendly hooks on `window`:

- `window.__ready` — `true` once the first frame has rendered.
- `window.__events` — array of every event the manager has emitted so far
  (`{name, archetype, species, position, dmg, explosion, t}`).
- `window.__mobCount` — getter, current live mob count (showcase mode
  only; 0 in isolate mode).
- `window.__forceSpawnAll()` — spawns one of each archetype via
  `manager.spawn(archetype, pos)` around the current player position;
  returns the spawned mob array.
- `window.__setMob(archetype)` — navigates to `?mob=<archetype>` (isolate
  mode) for scripted screenshotting.
- `window.__error` — set to a string (and rendered in a visible `<pre>`)
  if anything in init or the render loop throws.

Verified via a headless Playwright pass in this session: both modes reach
`__ready`, produce zero console errors, `mobSpawn`/`mobAttack` events flow
through the log in real time in showcase mode, and `__forceSpawnAll()`
adds exactly 5 mobs to `manager.mobs`.

## Dimension / day-night spawn rules

From `mobs/spawnRules.js` (`SPAWN_TABLES`, weighted random pick via
`pickSpawn(dimension, isDay, rng)`):

| Dimension | Period | Table (archetype: weight) | Max alive |
|---|---|---|---|
| `warpwold` | day | grazer: 6, trader: 2 | 12 |
| `warpwold` | night | groaner: 6, screecher: 1 | 12 |
| `cinderloom` | always (no day/night split) | exploder: 5, screecher: 4, groaner: 2 | 10 |
| `nevermend` | always (no day/night split) | groaner: 4, screecher: 4, exploder: 3 | 8 |

`cinderloom` and `nevermend` are in `ALWAYS_HOSTILE_DIMENSIONS`, so
`isDay` is ignored for them (both their "day" and "night" tables are
identical). `maxAliveFor(dimension)` falls back to `DEFAULT_MAX_ALIVE`
(10) for unknown dimensions; `opts.maxMobs` on the `MobManager` overrides
the per-dimension cap entirely if set.
