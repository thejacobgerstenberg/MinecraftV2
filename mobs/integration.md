# Integrating MobManager into the voxel-sandbox game

Copy-paste recipe for wiring `mobs/MobManager.js` (branch `feature/mobs`)
into the game builder's `feat/voxel-sandbox-game` branch. `mobs/` is a
self-contained package (no dependency on the game's code) — everything here
is the game reaching *into* `mobs/`, never the reverse.

Two ways to use this:

- **Fast path**: use `mobs/integration/gameBridge.js`'s `createMobBridge()`
  — a tiny example adapter that wires audio/achievements/inventory for you
  defensively. Copy it into the game (e.g. `public/src/mobs/gameBridge.js`)
  and adapt the guessed method names (`audioEngine.play`,
  `achievements.unlock`, `inventory.addOrSpawnPickup`, ...) to the real
  APIs once those branches land.
- **Manual path**: construct `MobManager` directly and wire events yourself,
  following sections 1–7 below. `gameBridge.js` is just one way of doing
  exactly this.

Either way, `mobs/MobManager.js` itself never needs to change.

---

## 0. Known issues to check before/while integrating

Flagged by the mobs-side integration pass, not fixable from the game side —
just things to be aware of:

1. **`mobs/vendor/three.module.js`** in the `feature/mobs` working tree was
   found reduced to an 11-line stub (missing most of r160's real API,
   including `Vector3.prototype.copy`). The game almost certainly has its
   own real `three` install/vendor copy already — **make sure the game's
   `three` resolves to a real build**, not this stub, when `mobs/` is
   imported into it (via bundler alias / import map, whichever the game
   uses for the bare `"three"` specifier). If mob creatures fail to
   build/spawn silently (`manager.spawn()` returns `null`), this is the
   first thing to check.
2. **`mobs/breeding.js`** currently exports via CommonJS
   (`module.exports = {...}`) instead of ES `export`. `MobManager.spawnEgg()`
   / `.breed()` load it through a guarded dynamic `import()` specifically so
   this doesn't crash the rest of the file — until `breeding.js` is fixed to
   real ESM exports, `spawnEgg()`/`breed()` will just resolve to `null`
   (graceful no-op, not a crash). Not a blocker for the rest of this recipe.
3. Everything else (mount system, provoke, self-mend, hover-flight, boss
   death paths) has been smoke-tested and works standalone.

---

## 1. Construct MobManager

Construct it **after** `scene`, `world`, and `player` exist in the game's
`main.js` init sequence (or wherever the game wires up its systems) —
`MobManager` needs live references to all three via its constructor opts,
not setters.

```js
// main.js (or wherever scene/world/player are wired up)
import { getBlockDef } from './blocks/blocks.js';
import { createMobBridge } from './mobs/gameBridge.js'; // your copy of mobs/integration/gameBridge.js

// ... after scene, world (new World(generator)), and player exist:

const mobBridge = createMobBridge({
  scene,
  world,
  getBlockDef,                 // REAL block registry — see note below
  player,
  audioEngine,                 // from feature/audio-engine, once merged; optional today
  achievements,                // the game's achievement/progress tracker; optional
  inventory,                   // the game's Inventory; optional
  rng: Math.random,
  dimension: engineDimensionId, // 'overworld' | 'nether' | 'end' — see section 2
});
```

If you'd rather skip the bridge and wire `MobManager` directly:

```js
import { MobManager } from './mobs/MobManager.js'; // relative to wherever you copy mobs/ under public/src/
import { getBlockDef } from './blocks/blocks.js';

const manager = new MobManager(scene, world, {
  // getBlockDef(id) -> { solid, ... }. REQUIRED for real collision — omit
  // and MobManager silently falls back to its own placeholder table
  // (mobs/blocksAdapter.js), which will desync from the real world.
  getBlockDef,

  // getPlayerPos: () => {x,y,z}. Guarded internally (missing/throwing is
  // tolerated), but required for any aggro/attack/flee behaviour to work.
  getPlayerPos: () => player.position,

  // onPlayerHurt: (dmg:number) => void. Called whenever a hostile mob
  // lands a hit (melee contact or an exploder's blast catching the player).
  onPlayerHurt: (dmg) => player.hurt?.(dmg),

  // isDay: () => boolean. Feeds the day/night spawn tables (Warpwold only
  // splits day/night; Cinderloom/Nevermend are always-hostile). Wire to
  // whatever day/night clock the world uses; defaults to always-day if
  // omitted.
  isDay: () => world.isDay?.() ?? true,

  rng: Math.random,             // optional; defaults to Math.random anyway

  // dimension: accepts EITHER the engine id ('overworld'/'nether'/'end')
  // OR a Loomfall display key ('warpwold'/'cinderloom'/'nevermend') —
  // normalized internally, pass whichever the game already has on hand.
  dimension: engineDimensionId,

  // onEvent: (name, detail) => void — see sections 3-7 below. This is the
  // single hook point for audio/achievements/loot/etc; `manager` is also a
  // real EventTarget if you'd rather use addEventListener() per event.
  onEvent: (name, detail) => { /* ... */ },
});
```

Notes:

- `world` only needs `getBlock(x, y, z) -> number` (the game's real
  `World.js` already provides this). `MobManager` treats out-of-range /
  throwing `getBlock` as air (non-solid), so it never gets stuck on
  undefined terrain.
- `getBlockDef` must accept a **numeric** block id (0–29) and return
  `{ solid: boolean, ... }` — this matches `public/src/blocks/blocks.js`'s
  `getBlockDef(id)` exactly, no adapter needed.
- `mobs/` itself lives at the repo root (sibling to `public/`). Either
  import it in place with a relative path from wherever your game code
  lives (e.g. `../../../mobs/MobManager.js` from
  `public/src/gameplay/something.js`), or copy the whole `mobs/` directory
  under `public/src/` if the build pipeline needs everything inside its own
  root — no code inside `mobs/` needs to change either way, since it has no
  outside dependencies of its own besides the bare `"three"` specifier
  (already true of the game).

---

## 2. The update loop + dimension switching

Call `update(dt)` once per frame, alongside the rest of the game's fixed/
variable timestep loop:

```js
function frame(dt) {
  // ... world/player/physics updates ...
  mobBridge.update(dt);   // or: manager.update(dt);
  // ... render ...
}
```

`dt` is seconds; internally clamped to 0.1s max so a debugger pause/tab
switch can't cause a physics blow-up. Passing `dt <= 0` or non-finite `dt`
is a safe no-op.

On any portal use / dimension change, call `setDimension` with the engine
id — this despawns every currently-alive mob (no loot, no events besides
the despawn sweep's own bookkeeping — actually a hard reset does not itself
fire `mobDespawn` per-mob, it's a bulk clear) and switches to that
dimension's spawn table:

```js
function onDimensionChange(newEngineId) { // 'overworld' | 'nether' | 'end'
  mobBridge.setDimension(newEngineId);    // or: manager.setDimension(newEngineId);
}
```

`'overworld'` → Warpwold spawn table, `'nether'` → Cinderloom, `'end'` →
Nevermend. Pass either form; `MobManager` normalizes it.

On teardown (e.g. leaving a world, hot-reload in dev):

```js
mobBridge.dispose(); // or: manager.dispose();
```

---

## 3. Event → audio routing

Subscribe via the `onEvent` constructor opt (what `gameBridge.js` does) or
`manager.addEventListener(name, e => ...)` — both fire for every event.
Suggested sound-key convention, matching `feature/audio-engine`'s
`engine.play(name, { pos, volume })` contract:

```js
manager.addEventListener('mobSpawn', (e) => {
  const { archetype, position } = e.detail;
  if (Math.random() < 0.15) { // don't fire on EVERY ambient spawn
    audioEngine.play(`mob.${archetype}.idle`, { pos: position, volume: 0.5 });
  }
});
manager.addEventListener('mobHurt', (e) => {
  audioEngine.play(`mob.${e.detail.archetype}.hurt`, { pos: e.detail.position, volume: 0.8 });
});
manager.addEventListener('mobDeath', (e) => {
  audioEngine.play(`mob.${e.detail.archetype}.death`, { pos: e.detail.position, volume: 1.0 });
});
```

`bossDefeated` has **no sound by default** — the mobs package doesn't
prescribe one (lastneedle is "bound," not conventionally "killed," so a
plain `death` sound would be tonally wrong; molthkin dying is closer to a
normal death but still left to the game to score). Add one explicitly if
desired, e.g. `audioEngine.play('mob.lastneedle.bound', {...})` /
`audioEngine.play('mob.molthkin.death', {...})`.

`mobAttack` similarly has no fixed sound-key contract yet (`detail.explosion`
distinguishes an exploder's blast from a melee hit if you want to key off
that).

### `mob.<archetype>.<variant>` key list (all 17 archetypes)

Use `idle` / `hurt` / `death` (and optionally `attack`) for each:

```
grazer, groaner, exploder, screecher, trader, bobbindeer, frayedhound,
emberspinner, unpicked, needlejack, scaldwarden, raveler, spoolmare,
silencemoth, selvagewarden, lastneedle, molthkin
```

e.g. `mob.grazer.idle`, `mob.groaner.hurt`, `mob.exploder.death`,
`mob.lastneedle.hurt`, `mob.molthkin.death`, etc.

---

## 4. Event → achievements routing

```js
manager.addEventListener('mobDeath', (e) => {
  const { canonicalId, archetype } = e.detail;
  achievements.onMobKilled?.(canonicalId, archetype); // e.g. tally per-species kill counters
});

manager.addEventListener('bossDefeated', (e) => {
  const { canonicalId, bound, victoryTrigger, achievement } = e.detail;

  if (achievement) achievements.unlock(achievement);
  if (victoryTrigger) achievements.fireTrigger(victoryTrigger);

  if (canonicalId === 'last_needle') {
    // lastneedle: bound:true, victoryTrigger:'kill_entity:last_needle',
    // achievement:'taught_to_mend'. Show the ending doc + two-choice epilogue.
    achievements.unlock('taught_to_mend');
    game.showDocument('content/ending.md', { title: 'The Turning of the Needle' });
    game.presentChoice({
      prompt: 'The choice was always this, and always yours.',
      options: [
        { id: 'finish_the_weaving', achievementId: 'to_finish_the_weaving' },
        { id: 'still_the_loom', achievementId: 'let_it_come_to_rest' },
      ],
    });
  }
  // molthkin: bound:false, NO victoryTrigger/achievement fields at all —
  // it's a genuinely killable boss, not a victory-condition boss. Its loot
  // (everthread) arrives via a following 'mobDrop' event (see below), so
  // there's nothing extra to do here for molthkin specifically.
});

manager.addEventListener('mobDrop', (e) => {
  const { itemId, canonicalId } = e.detail;
  if (itemId === 'everthread') {
    // molthkin's guaranteed drop — grant/track it explicitly if the game
    // wants a distinct "obtained Everthread" beat separate from generic
    // inventory pickup (section 5 already adds it to the inventory).
    achievements.onEverthreadObtained?.(e.detail);
  }
});
```

Reference: `bossDefeated` detail shape is
`{ archetype, canonicalId, species, mob, position, bound, victoryTrigger?, achievement? }`
— `victoryTrigger`/`achievement` are **only present when the archetype's
config sets them** (currently `lastneedle` only). Always guard with
`if (detail.victoryTrigger)` / `if (detail.achievement)` rather than
assuming they exist.

---

## 5. Loot → Inventory

```js
manager.addEventListener('mobDrop', (e) => {
  const { itemId, count, pos } = e.detail;
  // itemId is a REAL id from content/items.json (crafting materials) or
  // content/naming.json's blocks array (raw/gathered materials, e.g.
  // raw_skein, needle_iron, voidknot) — reconcile against whichever of
  // those the Inventory's item table already uses.
  inventory.addOrSpawnPickup(itemId, count, pos);
});
```

`mobDrop` fires once per dropped stack, right after `mobDeath` (normal
mobs, including the selvagewarden mini-boss) **or** right after
`bossDefeated` for a killable boss (`molthkin` — its table has
`everthread`). It's `pos`, not `position`, and there's no `species`/`mob`
field on this event. `lastneedle` (bound, not killed) and `unpicked` (no
corpse, canonically) both have empty loot tables and simply produce zero
`mobDrop` events — no special-casing needed on the game side.

---

## 6. Mounting (Spoolmares)

```js
// On player "interact" with a live mob whose archetype is 'spoolmare'
// (or, generically, any mob with a rideable config):
function onInteract(mob) {
  const ride = manager.mountPlayer(mob); // -> { mob, setInput, dismount } | null
  if (!ride) return; // not eligible (dead / already mounted / not rideable / no rideAnchor)
  currentRide = ride;
}

// Per-frame while mounted (after manager.update(dt) has run for this frame):
function frame(dt) {
  mobBridge.update(dt); // drives the mount's physics via _driveRideInput

  if (currentRide) {
    const { mob } = currentRide;
    // Seat the player/camera at the mount's live saddle-point:
    const anchorWorldPos = new THREE.Vector3();
    mob.rideAnchor.getWorldPosition(anchorWorldPos);
    player.position.copy(anchorWorldPos); // or drive a camera rig off it

    // Feed this frame's desired movement (world-space direction, need not
    // be pre-normalized — magnitude is clamped to 1 internally) + jump:
    currentRide.setInput({
      moveX: input.moveX, // e.g. from WASD/left-stick, world-space
      moveZ: input.moveZ,
      jump: input.jumpHeld,
    });
    // Equivalent: mob.setRideInput({ moveX, moveZ, jump })
  }
}

function onDismountRequested() {
  currentRide?.dismount(); // or: manager.dismountPlayer(mob)
  currentRide = null;
}
```

Eligibility (checked inside `mountPlayer`): the mob must be alive, not
already mounted, have `rideable:true` in its archetype config (currently
just `spoolmare`) or `archetype === 'spoolmare'`, and have a non-null
`mob.rideAnchor` (populated at spawn time from the creature module's
`root.userData.rideAnchor`). A ridden mob is automatically exempt from the
ambient despawn sweep and is force-dismounted defensively if it dies.

---

## 7. Name tags

Every spawned mob exposes `mob.headAnchor` — a `THREE.Object3D | null`
positioned at the creature's head (from its creature module's
`root.userData.headAnchor`). Attach a sprite/label to it directly, or track
its live world position each frame:

```js
manager.addEventListener('mobSpawn', (e) => {
  const { mob } = e.detail;
  if (!mob.headAnchor) return; // guard: not every creature module sets one
  const label = makeNameTagSprite(mob.species); // your own sprite/label factory
  mob.headAnchor.add(label); // rides along with the creature's own animation
});
```

If you'd rather not parent into the mob's own hierarchy (e.g. for a
billboard label managed by a separate UI layer), read
`mob.headAnchor.getWorldPosition(vec3)` each frame instead.

---

## Quickstart

```js
import { createMobBridge } from './mobs/gameBridge.js';
const bridge = createMobBridge({ scene, world, getBlockDef, player, audioEngine, achievements, inventory, dimension: 'overworld' });
function frame(dt) { bridge.update(dt); } // + bridge.setDimension(id) on portal use, bridge.dispose() on teardown
```

See `mobs/integration/gameBridge.js` for the full example adapter (event →
audio/achievements/inventory wiring) and `mobs/README.md` for the complete
API/event/archetype reference this recipe is derived from.
