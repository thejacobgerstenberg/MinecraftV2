// ============================================================================
// mobs/MobManager.js
//
// Default export: class MobManager extends EventTarget.
//
// Owns spawning, AI, physics stepping, and animation-driving for all Loomfall
// creature instances (grazer/Skeinling, groaner/Understruck, exploder/Waxling,
// screecher/Slagmoth, trader/Wickerkin, bobbindeer/Bobbin-deer,
// frayedhound/Frayed Hound, emberspinner/Emberspinner, unpicked/The Unpicked,
// needlejack/Needlejack, scaldwarden/Scaldwarden, raveler/Raveler,
// spoolmare/Spoolmares, silencemoth/Silence-Moths,
// selvagewarden/Selvage Wardens (Nevermend mini-boss), and the two
// dimension bosses lastneedle/The Last Needle and molthkin/Molthkin, the
// First Bobbin). Creature *visuals* come from ./creatures/<archetype>.js
// (owned by other agents) via their `build()` / `meta` exports — this file
// only ever calls that contract, never reaches into their internals beyond
// root.userData.headAnchor / root.userData.animate / root.userData.rideAnchor
// (spoolmare only, see the mount API below).
//
// Public API (see bottom of file / README-style summary in the return value
// of the agent that wrote this):
//   new MobManager(scene, world, opts)
//   .update(dt)
//   .setDimension(id)          -- accepts engine ids ('overworld'/'nether'/
//                                  'end') OR display-name keys
//                                  ('warpwold'/'cinderloom'/'nevermend'); see
//                                  spawnRules.normalizeDimension.
//   .dispose()
//   .spawn(archetype, pos)   -- addition, force-spawn (demo/tests)
//   .spawnBoss(pos)          -- addition, force-spawn the 'lastneedle' boss
//                                (thin wrapper over spawn('lastneedle', pos)).
//   .mobs                    -- addition, getter -> array snapshot
//   .setDay(bool)             -- addition, override day/night without opts.isDay
//   .mountPlayer(mob)         -- addition, mount system (item 7). Mounts a
//                                rideable mob (currently 'spoolmare', or any
//                                archetype with config.rideable:true);
//                                returns { mob, setInput, dismount } or null.
//   .dismountPlayer(mob)      -- addition, ends a ride.
//   .setRideInput(mob, input) -- addition, feeds { moveX, moveZ, jump } ride
//                                control each frame; also available as
//                                mob.setRideInput(input) on any spawned mob.
//   .spawnEgg(archetype, pos) -- addition (item 8), async. Creative-mode
//                                spawn-egg hook, thin wrapper over spawn()
//                                gated by mobs/breeding.js's SPAWN_EGGS.
//   .breed(mobA, mobB, pos?)  -- addition (item 8), async. Stub-simple
//                                breeding via mobs/breeding.js -- spawns a
//                                scaled-down baby at the midpoint (or `pos`)
//                                if both mobs share a breedable archetype.
//
// Animation/VFX integration (this pass): every spawned creature's
// root.userData.animate(t, state) is called each (LOD-eligible) frame with
// an EXTENDED state object:
//   { moving, grounded, dimension, speed01, fuse, hurt, attack, telegraph,
//     phase, dying, turn }
// -- see the per-field breakdown above _animateMob() below. All fields are
// always present (defensively defaulted to 0/false) so a creature module
// can treat any of them as optional. `dying` ramps 0->1 over ~0.8s (bosses
// ~1.4s, both overridable via opts.deathDuration) AFTER death: MobManager
// keeps a dead mob's group in the scene, AI/physics frozen, animating that
// ramp, and only removes it once the ramp completes -- see _beginDeathRamp/
// _updateDeathRamp. 'mobDeath'/'bossDefeated' + loot fire exactly once, at
// the moment hp hits 0 (unchanged timing), not at removal.
//
// New opts (all optional, all additive):
//   getCamera?:()=>THREE.Camera  -- used as a distance-origin fallback for
//                                   LOD/billboard-visibility when
//                                   getPlayerPos is missing/throws; sprites
//                                   billboard themselves so this is NOT
//                                   required for the health-bar to face the
//                                   camera, only for the *distance* used by
//                                   LOD when there's no player position.
//   lodDistance?:number           -- default 40. Beyond this (horizontal
//                                   distance to the player/camera), mobs
//                                   animate every 3rd frame and hide their
//                                   billboard; beyond 2x this, animate() is
//                                   skipped entirely that frame. Cheap
//                                   distance-only LOD -- mesh LOD/instancing
//                                   is the graphics team's domain, not
//                                   handled here.
//   deathDuration?:number         -- default 0.8s (non-boss); bosses scale
//                                   proportionally from this (default 1.4s
//                                   at the 0.8s baseline).
//
// Events (CustomEvent via EventTarget, AND opts.onEvent(name, detail)). Every
// event detail below includes both `archetype` (spawn-table slot key) AND
// `canonicalId` (spawnRules.canonicalIdFor(archetype) / mob.canonicalId --
// the stable snake_case entity id, e.g. 'last_needle') so downstream code
// can match against canonical entity ids (e.g. the boss victory trigger is
// 'kill_entity:last_needle'):
//   'mobSpawn', 'mobHurt', 'mobDeath', 'mobAttack', 'mobDrop', 'mobDespawn',
//   'bossDefeated', 'mobMount', 'mobDismount', 'mobBreed'
//
//   'mobDrop'      { mobId, archetype, canonicalId, itemId, pos:{x,y,z},
//                  count } -- emitted once per dropped stack, right after
//                  'mobDeath' OR right after 'bossDefeated' for a KILLABLE
//                  boss (see below). Computed via lootTables.rollLoot
//                  (archetype, rng). Archetypes with an empty loot table
//                  (unpicked, lastneedle) naturally produce zero 'mobDrop'
//                  events since rollLoot() returns [].
//   'mobDespawn'   { archetype, canonicalId, species, mob, position } --
//                  ambient distance/age despawn (spawnRules.shouldDespawn);
//                  quiet, no loot. Never fires for a currently-mounted mob
//                  (see mountPlayer).
//   'bossDefeated' { archetype, canonicalId, species, mob, position, bound,
//                  victoryTrigger?, achievement? } -- emitted INSTEAD OF
//                  'mobDeath' when a boss mob's (mob.isBoss) hp reaches 0.
//                  `bound` is per-archetype (ARCHETYPE_CONFIG.bound, default
//                  true): lastneedle is bound:true (bound, not killed --
//                  its loot table is empty, so no 'mobDrop' follows) with
//                  victoryTrigger ('kill_entity:last_needle') + achievement
//                  ('taught_to_mend') so the builder can wire the win
//                  condition/ending without hardcoding archetype strings.
//                  molthkin is bound:false (genuinely KILLABLE) with NO
//                  victoryTrigger/achievement fields, and IS followed by
//                  'mobDrop' events (its table has everthread) -- see
//                  _killBoss/_dropLoot.
// ============================================================================

import * as THREE from 'three';
import { getBlockDef as fallbackGetBlockDef } from './blocksAdapter.js';
import * as AI from './ai.js';
import { pickSpawn, maxAliveFor, normalizeDimension, DESPAWN_CONFIG, shouldDespawn, canonicalIdFor } from './spawnRules.js';
import { rollLoot } from './lootTables.js';

// ----------------------------------------------------------------------
// Animation/VFX system integration (additive). rig.js is THREE-free pure
// math (see its own header); Particles/Billboard both degrade gracefully
// with a null scene (Particles) or no-DOM environment (Billboard), so
// importing/using them unconditionally here is safe even in headless/test
// contexts that pass scene:null.
// ----------------------------------------------------------------------
import * as rig from './anim/rig.js';
import { Particles } from './vfx/Particles.js';
import { Billboard } from './ui/Billboard.js';

import { build as buildGrazer, meta as metaGrazer } from './creatures/grazer.js';
import { build as buildGroaner, meta as metaGroaner } from './creatures/groaner.js';
import { build as buildExploder, meta as metaExploder } from './creatures/exploder.js';
import { build as buildScreecher, meta as metaScreecher } from './creatures/screecher.js';
import { build as buildTrader, meta as metaTrader } from './creatures/trader.js';
import { build as buildBobbindeer, meta as metaBobbindeer } from './creatures/bobbindeer.js';
import { build as buildFrayedhound, meta as metaFrayedhound } from './creatures/frayedhound.js';
import { build as buildEmberspinner, meta as metaEmberspinner } from './creatures/emberspinner.js';
import { build as buildUnpicked, meta as metaUnpicked } from './creatures/unpicked.js';
import { build as buildLastneedle, meta as metaLastneedle } from './creatures/lastneedle.js';
import { build as buildNeedlejack, meta as metaNeedlejack } from './creatures/needlejack.js';
import { build as buildScaldwarden, meta as metaScaldwarden } from './creatures/scaldwarden.js';
import { build as buildRaveler, meta as metaRaveler } from './creatures/raveler.js';
import { build as buildSpoolmare, meta as metaSpoolmare } from './creatures/spoolmare.js';
import { build as buildSilencemoth, meta as metaSilencemoth } from './creatures/silencemoth.js';
import { build as buildSelvagewarden, meta as metaSelvagewarden } from './creatures/selvagewarden.js';
import { build as buildMolthkin, meta as metaMolthkin } from './creatures/molthkin.js';

// ----------------------------------------------------------------------
// Registry: archetype -> { build, meta }
//
// NOTE: the keys here are spawn-table archetype slots (see
// spawnRules.SPECIES_BY_ARCHETYPE), not necessarily the same string as a
// creature module's internal `meta.archetype` AI-behaviour tag. E.g.
// bobbindeer/frayedhound/emberspinner/unpicked each reuse an existing AI
// behaviour under the hood (see ARCHETYPE_CONFIG's `aiBase` field below),
// but each still gets its own registry/config slot so it can be
// spawned/tuned independently.
// ----------------------------------------------------------------------
const REGISTRY = {
  grazer: { build: buildGrazer, meta: metaGrazer },
  groaner: { build: buildGroaner, meta: metaGroaner },
  exploder: { build: buildExploder, meta: metaExploder },
  screecher: { build: buildScreecher, meta: metaScreecher },
  trader: { build: buildTrader, meta: metaTrader },
  bobbindeer: { build: buildBobbindeer, meta: metaBobbindeer },
  frayedhound: { build: buildFrayedhound, meta: metaFrayedhound },
  emberspinner: { build: buildEmberspinner, meta: metaEmberspinner },
  unpicked: { build: buildUnpicked, meta: metaUnpicked },
  lastneedle: { build: buildLastneedle, meta: metaLastneedle },
  needlejack: { build: buildNeedlejack, meta: metaNeedlejack },
  scaldwarden: { build: buildScaldwarden, meta: metaScaldwarden },
  raveler: { build: buildRaveler, meta: metaRaveler },
  spoolmare: { build: buildSpoolmare, meta: metaSpoolmare },
  silencemoth: { build: buildSilencemoth, meta: metaSilencemoth },
  selvagewarden: { build: buildSelvagewarden, meta: metaSelvagewarden },
  molthkin: { build: buildMolthkin, meta: metaMolthkin },
};

// ----------------------------------------------------------------------
// Per-archetype physics/behaviour tuning. AABB sizes are approximate
// (1 unit = 1 block); real visuals may not fill the box exactly, that's
// fine for collision purposes.
//
// `aiBase` selects which _ai*() behaviour function _updateMobAI dispatches
// to (see below) — several new archetypes deliberately reuse an existing
// behaviour (e.g. frayedhound/emberspinner/unpicked all reuse the 'groaner'
// aggro/attack loop, just with different speed/hp/range numbers).
//
// Canonical stats note (speed reconciliation): the canon data table gives
// ONE headline "spd" figure per creature (u/s). Several AI behaviours here
// (grazer's flee, groaner-family's seek) differentiate a calmer ambient
// wander pace from a more urgent combat/flee pace via two separate config
// fields. Where that split exists, the canon spd is applied to the URGENT
// field (fleeSpeed / seekSpeed -- the number that actually matters for
// player-facing pacing/difficulty) and the calmer `speed` (ambient wander)
// is derived proportionally below it, preserving each archetype's
// pre-existing wander:urgent ratio (or ~1:2 for the brand-new archetypes,
// matching groaner's own ratio). Archetypes with only a single `speed`
// field used directly as their real movement speed (trader, exploder,
// screecher -- screecher's AI already derates it internally for
// approach/ambient) take the canon spd value directly.
// ----------------------------------------------------------------------
const ARCHETYPE_CONFIG = {
  // Skeinling. canon: hp8 dmg0 spd2.5
  grazer: {
    aiBase: 'grazer',
    maxHp: 8,
    halfWidth: 0.3, height: 0.5,
    speed: 1.05, fleeSpeed: 2.5,
    hostile: false, flies: false,
  },
  // Wickerkin. canon: hp20 dmg0 spd3.5
  trader: {
    aiBase: 'trader',
    maxHp: 20,
    halfWidth: 0.3, height: 1.1,
    speed: 3.5,
    hostile: false, flies: false,
    tetherRadius: 5,
  },
  // Understruck. canon: hp24 dmg5 spd3.5
  groaner: {
    aiBase: 'groaner',
    maxHp: 24,
    halfWidth: 0.3, height: 1.3,
    speed: 1.75, seekSpeed: 3.5,
    hostile: true, flies: false,
    aggroRange: 8, attackRange: 0.9,
    contactDamage: 5, attackCooldown: 1.0,
  },
  // Waxling. canon: hp10 dmg7 spd3.5 (dmg maps to blastDamage -- exploder
  // has no contact-melee attack, only its detonation).
  exploder: {
    aiBase: 'exploder',
    maxHp: 10,
    halfWidth: 0.4, height: 0.6,
    speed: 3.5,
    hostile: true, flies: false,
    aggroRange: 7, fuseRange: 2.0, fuseDuration: 1.5,
    blastRadius: 3.0, blastDamage: 7,
  },
  // Slagmoth. canon: hp12 dmg3 spd7
  screecher: {
    aiBase: 'screecher',
    maxHp: 12,
    halfWidth: 0.25, height: 0.3,
    speed: 7,
    hostile: true, flies: true,
    hoverHeight: 1.3,
    aggroRange: 10, attackRange: 1.2,
    contactDamage: 3, attackCooldown: 1.2,
  },

  // ---- Phase 2 additions -------------------------------------------------

  // Bobbin-deer: passive grazer, reuses 'grazer' AI. canon: hp14 dmg0 spd6
  bobbindeer: {
    aiBase: 'grazer',
    maxHp: 14,
    halfWidth: 0.28, height: 0.9,
    speed: 2.1, fleeSpeed: 6,
    fleeDuration: 4.5,
    hostile: false, flies: false,
  },

  // Frayed Hound: hostile pack-predator, reuses 'groaner' AI.
  // canon: hp14 dmg3 spd6
  frayedhound: {
    aiBase: 'groaner',
    maxHp: 14,
    halfWidth: 0.28, height: 0.5,
    speed: 3.2, seekSpeed: 6,
    hostile: true, flies: false,
    aggroRange: 10, attackRange: 0.9,
    contactDamage: 3, attackCooldown: 0.8,
  },

  // Emberspinner: hostile, reuses 'groaner' AI. canon: hp22 dmg5 spd4
  emberspinner: {
    aiBase: 'groaner',
    maxHp: 22,
    halfWidth: 0.5, height: 0.55,
    speed: 2.2, seekSpeed: 4,
    hostile: true, flies: false,
    aggroRange: 9, attackRange: 0.9,
    contactDamage: 5, attackCooldown: 0.9,
  },

  // The Unpicked: hostile, reuses 'groaner' AI. Slow, tall, tanky bruiser.
  // canon: hp26 dmg6 spd3. No corpse -- LOOT_TABLES.unpicked is empty.
  unpicked: {
    aiBase: 'groaner',
    maxHp: 26,
    halfWidth: 0.35, height: 1.7,
    speed: 2.0, seekSpeed: 3.0,
    hostile: true, flies: false,
    aggroRange: 8, attackRange: 1.0,
    contactDamage: 6, attackCooldown: 1.4,
  },

  // ---- New (Warpwold/Cinderloom/Nevermend) additions ---------------------

  // Needlejack: hostile nocturnal Warpwold prowler, reuses 'groaner' AI.
  // canon: hp18 dmg4 spd4.5
  needlejack: {
    aiBase: 'groaner',
    maxHp: 18,
    halfWidth: 0.25, height: 1.2,
    speed: 2.25, seekSpeed: 4.5,
    hostile: true, flies: false,
    aggroRange: 9, attackRange: 0.9,
    contactDamage: 4, attackCooldown: 0.9,
  },

  // Scaldwarden: neutral Cinderloom guardian, PROVOKE fix (item 5): now
  // uses its own 'guardian' aiBase (was previously simplified down to
  // 'trader', a known deviation from the canonical "passive unless
  // provoked" retaliation behaviour). _aiGuardian idles/tethers near its
  // post exactly like trader until hurt; _hurtMob then sets
  // mob.provoked=true + mob.provokeTimer=provokeDuration, and for as long
  // as that timer is running (decremented every tick in _updateMobAI) it
  // seeks + attacks like a groaner using contactDamage. Once the timer
  // expires it reverts to neutral idling. Still despawn-exempt (see
  // DESPAWN_CONFIG.exemptArchetypes in spawnRules.js).
  // canon: hp40 dmg6 spd3.
  scaldwarden: {
    aiBase: 'guardian',
    maxHp: 40,
    halfWidth: 0.4, height: 1.5,
    speed: 3,
    hostile: false, flies: false,
    tetherRadius: 5,
    aggroRange: 9, attackRange: 1.0,
    contactDamage: 6, attackCooldown: 1.2,
    provokeDuration: 8,
  },

  // Raveler: fast Nevermend hostile, reuses 'groaner' AI. canon: hp18 dmg5
  // spd8 (FAST -- summoned by the Last Needle as "a Shed of Ravelers").
  // HOVER fix (item 6, known deviation): now flies:true with a low
  // hoverHeight so it actually hovers via the flyer physics path in
  // _updateMobPhysics, rather than merely being animated as if hovering
  // while actually walking. _aiGroaner is now flight-aware (see below): it
  // composes the SAME flyer physics + flyerAvoid terrain-avoidance used by
  // the boss with groaner's own horizontal seek/attack logic, so raveler
  // gets real target-seeking hover flight without a bespoke AI function.
  raveler: {
    aiBase: 'groaner',
    maxHp: 18,
    halfWidth: 0.35, height: 1.1,
    speed: 4.0, seekSpeed: 8,
    hostile: true, flies: true,
    hoverHeight: 0.6,
    aggroRange: 10, attackRange: 0.9,
    contactDamage: 5, attackCooldown: 0.7,
  },

  // The Last Needle: Nevermend boss. Flies, huge hp pool, tall, slow but
  // relentless, with a large aggro/attack range (ranged thread-lash
  // attacks rather than needing to close to melee). Phase-dependent tuning
  // (speed/attack cooldown/damage/attack range escalate across phases 0-2,
  // see _aiLastNeedle) lives in the phase* arrays below, indexed by
  // mob.bossPhase (0/1/2).
  //
  // canon: hp800 dmg14, phase thresholds 60%/15%. maxHp:800 (canon,
  // boss.json) with phase clamps at 480 and 120 hp (eight-stitch finish);
  // the existing fractional thresholds (phase1HpFrac 0.60 / phase2HpFrac
  // 0.15) land exactly on those clamps at 800 hp (800*0.60=480,
  // 800*0.15=120), so they are left as-is. No canon `spd` figure was
  // supplied for the boss, so its speed/seekSpeed/phaseSpeedMul are left
  // as previously tuned. dmg14 already matched the existing
  // phaseAttackDamage[2] value.
  lastneedle: {
    aiBase: 'boss',
    isBoss: true,
    bound: true, // bound, not killed -- see _killBoss (default when unset)
    maxHp: 800,
    halfWidth: 0.5, height: 3.8,
    speed: 0.6, seekSpeed: 1.0,
    hostile: true, flies: true,
    hoverHeight: 3.0,
    aggroRange: 24, attackRange: 7,
    contactDamage: 6, attackCooldown: 2.2,
    // Per-phase escalation, indexed by bossPhase (0/1/2).
    phaseSpeedMul: [1.0, 1.5, 2.0],
    phaseAttackRanges: [7, 10, 5],
    phaseAttackCooldowns: [2.2, 1.7, 0.6],
    phaseAttackDamage: [6, 8, 14],
    // Canonical phase thresholds: >60% = phase0, 15%-60% = phase1,
    // <=15% = phase2.
    phase1HpFrac: 0.60,
    phase2HpFrac: 0.15,
    // Add-summoning: phase 1 summons a "Shed of Ravelers" (all 'raveler');
    // phase 2 (most aggressive) summons a mix, mostly 'raveler' with an
    // occasional 'unpicked' mixed in. maxAdds caps alive adds (counted via
    // spawnedBy) across both phases combined.
    summonArchetype: 'raveler',
    summonArchetypePhase2: 'raveler',
    summonArchetypePhase2Alt: 'unpicked',
    summonArchetypePhase2AltChance: 0.25,
    summonCooldown: 6,
    maxAdds: 4,
    // Victory wiring for the builder: kill_entity:last_needle is the
    // canonical victory trigger id; achievement is granted alongside it.
    victoryTrigger: 'kill_entity:last_needle',
    achievement: 'taught_to_mend',
  },

  // ---- Phase 4 additions (mounts, ambience, mini-boss, second boss) -----

  // Spoolmares: passive, RIDEABLE Warpwold mount, reuses 'grazer' AI when
  // unmounted (wanders; flees briefly if hurt -- see item 7 for the mount
  // system itself). canon: hp26 dmg0 spd9. config.rideable opts this (and
  // any future archetype) into mountPlayer(); config.rideSpeed is the top
  // ground speed a *rider* can drive it at via setRideInput (see
  // _driveRideInput), kept separate from its own ambient wander/flee
  // speeds so being ridden doesn't change its unridden behaviour tuning.
  spoolmare: {
    aiBase: 'grazer',
    maxHp: 26,
    halfWidth: 0.3, height: 1.5,
    speed: 4.5, fleeSpeed: 9,
    hostile: false, flies: false,
    rideable: true,
    rideSpeed: 9,
  },

  // Silence-Moths: harmless ambient Warpwold flyer, reuses 'screecher' AI
  // but with hostile:false. Item 2 fix: _aiScreecher now branches on
  // config.hostile -- a non-hostile flyer just wanders/hovers and NEVER
  // seeks or attacks the player, regardless of aggroRange/attackRange.
  // canon: hp4 dmg1 spd3 (contactDamage/attackCooldown kept for data
  // completeness only -- silencemoth is effectively inert, its attack path
  // is never reached).
  silencemoth: {
    aiBase: 'screecher',
    maxHp: 4,
    halfWidth: 0.12, height: 0.3,
    speed: 3,
    hostile: false, flies: true,
    hoverHeight: 1.0,
    aggroRange: 10, attackRange: 1.0,
    contactDamage: 1, attackCooldown: 1.5,
  },

  // Selvage Wardens: Nevermend MINI-boss -- deliberately NOT isBoss/bound;
  // it dies through the normal _killMob path (plain 'mobDeath' + 'mobDrop'
  // hemstone), never 'bossDefeated' (see item 3/4). Reuses 'groaner' AI
  // for hostile melee. canon: hp90 dmg9 spd4. regenPerSec/regenDelay drive
  // its self-mending (see _updateRegen, called every AI tick for every
  // mob): once regenDelay seconds have passed since it was last hurt
  // (mob.sinceHurt, reset in _hurtMob), it heals regenPerSec hp/sec, capped
  // at maxHp -- selling the "re-stitches, doesn't bleed" lore from its own
  // creature module's re-stitch shimmer animation.
  selvagewarden: {
    aiBase: 'groaner',
    maxHp: 90,
    halfWidth: 0.4, height: 1.7,
    speed: 2.0, seekSpeed: 4,
    hostile: true, flies: false,
    aggroRange: 12, attackRange: 1.1,
    contactDamage: 9, attackCooldown: 1.3,
    regenPerSec: 2, regenDelay: 5,
  },

  // Molthkin, the First Bobbin: Cinderloom boss, the canonical Everthread
  // source. Unlike lastneedle it is bound:false -- genuinely KILLABLE, and
  // DROPS loot (its table has everthread; see _killBoss/_dropLoot). Grounded
  // (not flying) -- reuses the same grounded-hostile nav path
  // (_steerGroundedHostile) as groaner-family mobs. Simplified 2-PHASE
  // hp-fraction model (canonical threshold: 50%), see _aiMolthkin:
  //   phase 0 (frac > phase1HpFrac):  slow deliberate approach + heavy
  //                                   thread-arm melee/short-range attack.
  //   phase 1 (frac <= phase1HpFrac): enraged -- faster (phaseSpeedMul),
  //                                   and periodically summons adds
  //                                   ('exploder'/Waxling, occasional
  //                                   'emberspinner'/Emberspinner) near
  //                                   itself, capped at maxAdds alive (via
  //                                   spawnedBy) -- same pattern as
  //                                   lastneedle's own add-summoning.
  // mob.bossPhase (0/1) feeds animate() as state.phase (molthkin's own
  // animate treats it as a 0..1 float, so 0/1 map directly to its
  // phase0/phase1 poses); mob.attackFlash feeds state.attack -- both via
  // the existing shared _animateMob path, no changes needed there.
  // canon: hp280 dmg11 spd2. No victoryTrigger/achievement -- those are
  // lastneedle-only; molthkin's 'bossDefeated' detail omits both fields.
  molthkin: {
    aiBase: 'boss',
    isBoss: true,
    bound: false,
    maxHp: 280,
    halfWidth: 1.4, height: 3.4,
    speed: 1.0, seekSpeed: 2.0,
    hostile: true, flies: false,
    aggroRange: 14, attackRange: 2.2,
    contactDamage: 11, attackCooldown: 2.0,
    phaseSpeedMul: [1.0, 1.6],
    phaseAttackRanges: [2.2, 2.6],
    phaseAttackCooldowns: [2.0, 1.1],
    phaseAttackDamage: [11, 14],
    phase1HpFrac: 0.5,
    // Add-summoning (phase 1 / enraged only). Archetype keys here are
    // REGISTRY/spawn-table slot keys, not display species names --
    // 'exploder' is the Waxling archetype slot, 'emberspinner' matches its
    // own species name directly (see spawnRules.SPECIES_BY_ARCHETYPE).
    summonArchetypePrimary: 'exploder', // Waxling
    summonArchetypeAlt: 'emberspinner', // Emberspinner
    summonArchetypeAltChance: 0.4,
    summonCooldown: 7,
    maxAdds: 3,
  },
};

const FLEE_DURATION = 4.0;       // seconds a grazer flees after being hurt
const HURT_FLASH_DURATION = 0.4; // seconds the `hurt` animate flash decays over
const ATTACK_FLASH_DURATION = 0.35; // seconds the `attack` animate spike decays over
const MAX_DT = 0.1;              // clamp huge dt spikes (tab-switch, debugger pause)
const SPAWN_RING_MIN = 6;
const SPAWN_RING_MAX = 16;
const GROUND_SCAN_MAX = 48;
const DESPAWN_CHECK_MIN = 3;     // low-rate despawn sweep cadence (seconds)
const DESPAWN_CHECK_JITTER = 2;

// ---- Animation/VFX system integration constants (this pass) -------------
const TELEGRAPH_DURATION = 0.35;   // seconds an attack winds up before it fires
const DEATH_DURATION = 0.8;        // seconds a non-boss death-ramp plays before removal
const BOSS_DEATH_DURATION = 1.4;   // seconds a boss death-ramp plays before removal
const DEFAULT_LOD_DISTANCE = 40;   // beyond this: animate every 3rd frame + hide billboard
const LOD_FAR_MULTIPLIER = 2;      // beyond lodDistance * this: animate may be skipped
const TURN_LAMBDA = 8;             // rig.damp-style rate (1/s) for yaw catch-up
const BANK_LAMBDA = 10;            // rig.damp-style rate (1/s) for bank-lean catch-up
const BANK_FACTOR = 0.12;          // turn-rate -> bank-angle multiplier
const MAX_BANK = 0.3;              // radians, clamp on lean bank
const TURN_HEADING_MIN_SPEED = 0.08; // below this horizontal speed, keep last heading
const SPARK_INTERVAL = 0.08;       // seconds between exploder fuse spark emits

function safeCall(fn, fallback) {
  if (typeof fn !== 'function') return fallback;
  try {
    return fn();
  } catch (e) {
    return fallback;
  }
}

function safeCall1(fn, arg, fallback) {
  if (typeof fn !== 'function') return fallback;
  try {
    return fn(arg);
  } catch (e) {
    return fallback;
  }
}

/** First value in a creature's meta.palette (its "primary" thread color),
 * used to tint VFX (unravel/shimmer/burst/sparks) and the health-bar name
 * text so each species' particles/UI read as its own color. Defensive
 * against a missing/empty palette. */
function primaryPaletteColor(meta) {
  const palette = meta && meta.palette;
  if (!palette || typeof palette !== 'object') return '#e0e0e0';
  const keys = Object.keys(palette);
  return keys.length ? palette[keys[0]] : '#e0e0e0';
}

export class MobManager extends EventTarget {
  /**
   * @param {THREE.Scene|null} scene
   * @param {{getBlock:(x:number,y:number,z:number)=>any}|null} world
   * @param {object} opts
   *   getPlayerPos:()=>({x,y,z})   -- required for aggro/attack behaviour;
   *                                    guarded if missing/throws.
   *   onPlayerHurt:(dmg)=>void
   *   getBlockDef?:(id)=>({solid})  -- if omitted, falls back to
   *                                    ./blocksAdapter.js's getBlockDef.
   *                                    Real getBlockDef takes a NUMERIC
   *                                    block id (0-29); world.getBlock in
   *                                    production always returns one.
   *   isDay?:()=>boolean            -- defaults to always-day (true).
   *   rng?:()=>number                -- defaults to Math.random.
   *   dimension?:string              -- defaults to 'warpwold'. Accepts
   *                                     either an engine id
   *                                     ('overworld'/'nether'/'end') or a
   *                                     display-name key
   *                                     ('warpwold'/'cinderloom'/'nevermend');
   *                                     normalized via spawnRules.normalizeDimension.
   *   maxMobs?:number                -- overrides spawnRules' per-dimension cap.
   *   onEvent?:(name,detail)=>void
   *   getCamera?:()=>THREE.Camera    -- optional. Distance-origin fallback
   *                                     for LOD when getPlayerPos is
   *                                     missing/throws; see class header.
   *   lodDistance?:number            -- optional, default 40. See class header.
   *   deathDuration?:number          -- optional, default 0.8 (seconds).
   *                                     See class header.
   */
  constructor(scene, world, opts = {}) {
    super();

    this._scene = scene || null;
    this._world = world || null;
    this._opts = opts && typeof opts === 'object' ? opts : {};

    // getBlockDef injection: prefer opts.getBlockDef; fall back to the
    // local blocksAdapter shim. See blocksAdapter.js header comment. Both
    // the real getBlockDef and the fallback accept a NUMERIC block id, and
    // world.getBlock (real or StubWorld) always returns one.
    this._getBlockDef = typeof this._opts.getBlockDef === 'function'
      ? this._opts.getBlockDef
      : fallbackGetBlockDef;

    // isSolid(x,y,z): defensive against missing world / out-of-range /
    // throwing getBlock / missing getBlockDef result. Anything we can't
    // positively resolve is treated as non-solid (air) so mobs don't get
    // stuck on undefined terrain, per the physics contract.
    this._isSolid = (x, y, z) => {
      if (!this._world || typeof this._world.getBlock !== 'function') return false;
      let id;
      try {
        id = this._world.getBlock(x, y, z);
      } catch (e) {
        return false;
      }
      if (id === undefined) return false; // out-of-range convention: air
      let def;
      try {
        def = this._getBlockDef(id);
      } catch (e) {
        return true; // unknown/broken def: safer to assume solid per blocksAdapter policy
      }
      return !!(def && def.solid);
    };

    this._rng = typeof this._opts.rng === 'function' ? this._opts.rng : Math.random;

    this.dimension = normalizeDimension(this._opts.dimension || 'warpwold');
    this._dayOverride = null; // set via setDay(); takes precedence over opts.isDay

    this._mobs = [];
    this._pendingRemoval = [];
    this._nextId = 1;
    this._elapsed = 0;
    this._spawnTimer = 1 + this._rng() * 2; // brief initial delay before first spawn
    this._despawnTimer = DESPAWN_CHECK_MIN + this._rng() * DESPAWN_CHECK_JITTER;

    // ---- Animation/VFX system integration (this pass) -------------------
    // getCamera: optional distance-origin fallback for LOD when
    // getPlayerPos is missing/throws (see _resolveObserverPos).
    this._getCamera = typeof this._opts.getCamera === 'function' ? this._opts.getCamera : null;
    this._lodDistance = Number.isFinite(this._opts.lodDistance)
      ? this._opts.lodDistance
      : DEFAULT_LOD_DISTANCE;
    // deathDuration override scales the boss death-ramp proportionally so
    // the two stay in the same ~1:1.75 ratio as the defaults (0.8s/1.4s).
    this._deathDuration = Number.isFinite(this._opts.deathDuration)
      ? this._opts.deathDuration
      : DEATH_DURATION;
    this._bossDeathDuration = Number.isFinite(this._opts.deathDuration)
      ? this._opts.deathDuration * (BOSS_DEATH_DURATION / DEATH_DURATION)
      : BOSS_DEATH_DURATION;
    this._frameCounter = 0;
    // Particles handles a null scene gracefully (every emit*/update is a
    // no-op without one), so constructing it unconditionally is safe.
    this._particles = new Particles(this._scene);
  }

  // ----------------------------------------------------------------
  // Public: additions (non-breaking; the builder's contract only
  // requires update/setDimension/dispose, everything else here is extra).
  // ----------------------------------------------------------------

  /** get mobs() -> array snapshot of live mob objects. */
  get mobs() {
    return this._mobs.slice();
  }

  /** setDay(bool): override day/night state without needing opts.isDay. */
  setDay(isDay) {
    this._dayOverride = !!isDay;
  }

  /**
   * spawn(archetype, pos) -> mob | null
   * Force-spawns a mob of the given archetype at pos ({x,y,z}), bypassing
   * spawn-rule weighting/cadence (still counts toward the alive list, and
   * is NOT subject to the ambient maxAlive cap -- that cap only gates the
   * random spawn cadence in _trySpawn). Used by demos/tests; also used
   * internally by the spawn scheduler and by the boss's add-summoning.
   */
  spawn(archetype, pos) {
    const entry = REGISTRY[archetype];
    if (!entry) return null;
    const config = ARCHETYPE_CONFIG[archetype] || {};

    let group;
    try {
      group = entry.build();
    } catch (e) {
      return null;
    }
    if (!group) return null;

    const fallbackPos = safeCall(this._opts.getPlayerPos, null) || { x: 0, y: 1, z: 0 };
    const p = pos || fallbackPos;
    const baseY = Number.isFinite(p.y) ? p.y : 1;
    const startY = config.flies ? baseY + (config.hoverHeight || 0) : baseY;

    group.position.set(
      Number.isFinite(p.x) ? p.x : 0,
      startY,
      Number.isFinite(p.z) ? p.z : 0
    );

    if (this._scene && typeof this._scene.add === 'function') {
      try { this._scene.add(group); } catch (e) { /* ignore */ }
    }

    const mob = {
      id: this._nextId++,
      archetype,
      species: (entry.meta && entry.meta.species) || archetype,
      canonicalId: canonicalIdFor(archetype),
      group,
      headAnchor: (group.userData && group.userData.headAnchor) || null,
      // rideAnchor: the saddle-point Object3D exposed by spoolmare's own
      // build() (root.userData.rideAnchor); null for every other archetype.
      // The builder reads its world position each frame to seat the
      // player/camera while mounted (see item 7 / mountPlayer below).
      rideAnchor: (group.userData && group.userData.rideAnchor) || null,
      rider: null,                 // truthy while mounted; see mountPlayer/dismountPlayer
      rideInput: null,             // { moveX, moveZ, jump }; set via setRideInput while mounted
      hp: config.maxHp ?? 6,
      maxHp: config.maxHp ?? 6,
      position: { x: group.position.x, y: group.position.y, z: group.position.z },
      velocity: { x: 0, y: 0, z: 0 },
      grounded: false,
      // NOTE: spawnPos.y stores the *ground/anchor* y (baseY), not the
      // hover-adjusted startY, even for flying archetypes. _updateMobPhysics
      // computes the hover target as spawnPos.y + hoverHeight each tick, so
      // storing the already-hover-adjusted value here would double-count
      // the offset and make flyers climb too high.
      spawnPos: { x: group.position.x, y: baseY, z: group.position.z },
      wander: AI.wanderState(),
      fleeTimer: 0,
      fuse: 0,
      hurtTimer: 0,
      attackFlash: 0,       // 0..1 spike on attack, decays; fed to animate() as state.attack
      attackCooldownTimer: 0,
      ageSeconds: 0,         // despawn-eligibility accumulator (see _updateDespawn)
      isBoss: !!config.isBoss,
      bossPhase: 0,          // meaningful only for boss mobs; exposed via animate() state.phase
      summonCooldownTimer: config.summonCooldown ?? 0,
      spawnedBy: null,       // set by _aiLastNeedle/_aiMolthkin when this mob is a boss-summoned add
      sinceHurt: Infinity,   // seconds since last hurt; drives regenPerSec/regenDelay self-mend
      provoked: false,       // 'guardian' aiBase only (scaldwarden) -- see _hurtMob/_aiGuardian
      provokeTimer: 0,
      isBaby: false,         // set by breed() on a bred baby
      dead: false,
      _moving: false,
      _navVy: 0,             // scratch: flyerAvoid's suggested vy for this tick
      hurt: null, // assigned below
      setRideInput: null, // assigned below

      // ---- Animation/VFX system integration (this pass) -----------------
      _color: primaryPaletteColor(entry.meta), // cached primary palette color, for VFX/billboard
      telegraphTimer: 0,      // 0..1 attack wind-up progress; exposed via animate() state.telegraph
      _telegraphing: false,   // true while a wind-up is in progress (see _beginTelegraph/_updateTelegraph)
      _pendingAttackDamage: 0, // damage stashed at wind-up start, applied when it completes
      dying: 0,                // 0..1 death-ramp progress; exposed via animate() state.dying
      _dying: false,           // true while the post-death ramp is playing (see _beginDeathRamp)
      _deathTimer: 0,          // seconds remaining in the death ramp
      _deathDuration: 0,       // total death-ramp duration for this mob (set at death)
      turn: 0,                 // signed yaw angular velocity (rad/s); exposed via animate() state.turn
      _targetHeading: null,    // last-known movement heading (radians), for smooth turn damping
      _lastBossPhase: 0,       // last bossPhase seen, for phase-transition VFX burst detection
      _sparkTimer: 0,          // scratch: exploder fuse spark emit cadence
      _lod: 0,                 // 0 near / 1 mid / 2 far; see _updateMobVisuals
      billboard: null,         // Billboard instance for hostiles/bosses only; see below
    };
    mob.hurt = (dmg) => this._hurtMob(mob, dmg);
    mob.setRideInput = (input) => this.setRideInput(mob, input);

    // Health-bar billboard (item 5): hostiles + bosses only, never passives.
    // Added as a child of the mob's own group so it rides along for free;
    // THREE.Sprite always faces the camera regardless of parent rotation.
    if ((config.hostile || config.isBoss) && group && typeof group.add === 'function') {
      try {
        const billboard = new Billboard({
          name: mob.species,
          color: mob._color,
          boss: !!config.isBoss,
        });
        if (billboard.sprite) {
          const height = config.height ?? 0.8;
          const anchorY = (mob.headAnchor && mob.headAnchor.position
            && Number.isFinite(mob.headAnchor.position.y))
            ? mob.headAnchor.position.y
            : height;
          const margin = config.isBoss ? 0.9 : 0.45;
          billboard.sprite.position.set(0, anchorY + margin, 0);
          group.add(billboard.sprite);
        }
        mob.billboard = billboard;
      } catch (e) {
        mob.billboard = null;
      }
    }

    this._mobs.push(mob);
    this._emit('mobSpawn', {
      archetype,
      canonicalId: mob.canonicalId,
      species: mob.species,
      mob,
      position: { ...mob.position },
    });

    if (this._particles) {
      try { this._particles.emitShimmer(mob.position, mob._color); } catch (e) { /* ignore */ }
    }

    return mob;
  }

  /**
   * spawnBoss(pos) -> mob | null
   * Addition. Thin convenience wrapper over spawn('lastneedle', pos) for
   * encounter-triggering code that doesn't want to hardcode the archetype
   * string.
   */
  spawnBoss(pos) {
    return this.spawn('lastneedle', pos);
  }

  // ----------------------------------------------------------------
  // Public: mount / ride system (item 7)
  // ----------------------------------------------------------------

  /**
   * mountPlayer(mob) -> { mob, setInput, dismount } | null
   * Mounts `mob` if it's eligible: alive, not already mounted, its
   * archetype config has rideable:true (currently just 'spoolmare'), and
   * its creature module exposed a root.userData.rideAnchor (see spawn()).
   * Sets mob.rider=true and mob.rideInput to a zeroed input, which makes
   * update() route this mob through _driveRideInput() instead of its
   * normal AI every tick from here on (AI resumes automatically once
   * dismounted). Emits 'mobMount'. Returns null (no-op, nothing mutated)
   * on any validation failure.
   */
  mountPlayer(mob) {
    if (!mob || mob.dead || mob.rider) return null;
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    const rideable = config.rideable === true || mob.archetype === 'spoolmare';
    if (!rideable || !mob.rideAnchor) return null;

    mob.rider = true;
    mob.rideInput = { moveX: 0, moveZ: 0, jump: false };
    mob.velocity.x = 0;
    mob.velocity.z = 0;
    mob._moving = false;
    // Being ridden implicitly counts as calm -- clear any in-flight flee
    // (e.g. from a recent hurt) so the mount doesn't fight the rider.
    mob.fleeTimer = 0;

    this._emit('mobMount', {
      archetype: mob.archetype,
      canonicalId: mob.canonicalId,
      mob,
    });

    return {
      mob,
      setInput: (input) => this.setRideInput(mob, input),
      dismount: () => this.dismountPlayer(mob),
    };
  }

  /**
   * dismountPlayer(mob): ends a ride started by mountPlayer(). Clears
   * mob.rider/rideInput (AI resumes next tick) and emits 'mobDismount'.
   * No-op if `mob` isn't currently mounted.
   */
  dismountPlayer(mob) {
    if (!mob || !mob.rider) return;
    mob.rider = null;
    mob.rideInput = null;
    mob.velocity.x = 0;
    mob.velocity.z = 0;
    this._emit('mobDismount', {
      archetype: mob.archetype,
      canonicalId: mob.canonicalId,
      mob,
    });
  }

  /**
   * setRideInput(mob, input) -> boolean
   * Feeds ride control for a currently-mounted mob each frame:
   * input = { moveX, moveZ, jump } -- a world-space desired horizontal
   * move direction (need not be pre-normalized; magnitude is clamped to 1
   * before being scaled by the mob's config.rideSpeed, see
   * _driveRideInput) plus an optional jump flag (applied only if grounded).
   * Also reachable as mob.setRideInput(input) (a closure bound at spawn
   * time) for callers that only hold the mob reference. Returns false
   * (no-op) if `mob` isn't currently mounted.
   */
  setRideInput(mob, input) {
    if (!mob || !mob.rider) return false;
    const moveX = input && Number.isFinite(input.moveX) ? input.moveX : 0;
    const moveZ = input && Number.isFinite(input.moveZ) ? input.moveZ : 0;
    const jump = !!(input && input.jump);
    mob.rideInput = { moveX, moveZ, jump };
    return true;
  }

  /**
   * spawnEgg(archetype, pos) -> Promise<mob | null>
   * Addition (item 8). Thin creative-mode spawn-egg hook: confirms this
   * archetype is registered here AND has a spawn-egg id in
   * mobs/breeding.js's SPAWN_EGGS (via breeding.spawnEggId), then spawns
   * it normally via spawn(). Async because mobs/breeding.js is loaded
   * through a guarded dynamic import (see _loadBreeding) -- resolves to
   * null on any validation failure or if breeding.js can't be loaded.
   */
  async spawnEgg(archetype, pos) {
    if (!REGISTRY[archetype]) return null;
    const breeding = await this._loadBreeding();
    if (!breeding || typeof breeding.spawnEggId !== 'function') return null;
    let eggId = null;
    try {
      eggId = breeding.spawnEggId(archetype);
    } catch (e) {
      eggId = null;
    }
    if (!eggId) return null;
    return this.spawn(archetype, pos);
  }

  /**
   * breed(mobA, mobB, pos?) -> Promise<mob | null>
   * Addition (item 8). Stub-simple breeding: if mobA/mobB are both alive,
   * share the same archetype, and mobs/breeding.js's canBreed(archetype)
   * is true, spawns a baby at their midpoint (or `pos`, if given),
   * described by breeding.describeBaby(archetype) -- the baby's group is
   * scaled by descriptor.scale and mob.isBaby is set. Emits 'mobBreed' on
   * success. Defensive/stub: no love-mode/feeding/cooldown state is
   * tracked here (see mobs/breeding.js's own header); this just validates
   * + spawns. Returns null on any validation failure.
   */
  async breed(mobA, mobB, pos) {
    if (!mobA || !mobB || mobA.dead || mobB.dead) return null;
    if (mobA.archetype !== mobB.archetype) return null;
    const archetype = mobA.archetype;

    const breeding = await this._loadBreeding();
    if (!breeding || typeof breeding.canBreed !== 'function') return null;
    let can = false;
    try {
      can = breeding.canBreed(archetype);
    } catch (e) {
      can = false;
    }
    if (!can) return null;

    let descriptor = null;
    try {
      descriptor = breeding.describeBaby(archetype);
    } catch (e) {
      descriptor = null;
    }
    if (!descriptor) return null;

    const midpoint = pos || {
      x: (mobA.position.x + mobB.position.x) / 2,
      y: (mobA.position.y + mobB.position.y) / 2,
      z: (mobA.position.z + mobB.position.z) / 2,
    };

    const baby = this.spawn(archetype, midpoint);
    if (!baby) return null;

    const scale = Number.isFinite(descriptor.scale) ? descriptor.scale : 1;
    if (baby.group && baby.group.scale && typeof baby.group.scale.setScalar === 'function') {
      try {
        baby.group.scale.setScalar(scale);
      } catch (e) {
        /* ignore */
      }
    }
    baby.isBaby = true;

    this._emit('mobBreed', {
      archetype,
      canonicalId: baby.canonicalId,
      baby,
    });

    return baby;
  }

  /**
   * _loadBreeding() -> Promise<module-like object | null>
   * Lazily, defensively loads mobs/breeding.js via a DYNAMIC import
   * (cached after the first call, on this._breedingPromise) rather than a
   * static top-level `import`. This is deliberate: breeding.js currently
   * exports via CommonJS `module.exports = {...}` (see its own file
   * header) instead of this codebase's ES `export` convention used
   * everywhere else, including this file. A static
   * `import * as breeding from './breeding.js'` at the top of this file
   * would throw "ReferenceError: module is not defined" the instant a real
   * browser ES-module loader evaluates breeding.js (browsers have no
   * `module` global in module scope) -- and because that would be a
   * top-level import, the error is uncatchable and would take this ENTIRE
   * file down with it (see the NOTES returned by this integration pass).
   * Routing spawnEgg()/breed() through this guarded dynamic import instead
   * means that failure is caught right here, and both methods just
   * degrade to a no-op (resolve to null) until breeding.js is updated to
   * real ESM exports -- MobManager itself keeps working either way. Under
   * Node (e.g. this file's own smoke test) this resolves fine regardless,
   * since Node's ESM loader auto-detects/wraps a CommonJS module on
   * dynamic import.
   */
  _loadBreeding() {
    if (!this._breedingPromise) {
      this._breedingPromise = import('./breeding.js')
        .then((mod) => (mod && (mod.default || mod)) || null)
        .catch(() => null);
    }
    return this._breedingPromise;
  }

  // ----------------------------------------------------------------
  // Public: required contract methods
  // ----------------------------------------------------------------

  /** update(dt): step spawning, AI, physics, and animation for one frame. */
  update(dt) {
    if (typeof dt !== 'number' || !Number.isFinite(dt) || dt <= 0) return;
    const clampedDt = Math.min(dt, MAX_DT);
    this._elapsed += clampedDt;
    this._frameCounter = (this._frameCounter || 0) + 1;

    this._trySpawn(clampedDt);

    const playerPos = safeCall(this._opts.getPlayerPos, null);
    // observerPos: distance-origin used for LOD only. Prefers the real
    // player position; falls back to opts.getCamera()'s position so LOD
    // still works if a caller only wires a camera. Never used for
    // AI/aggro (that stays strictly playerPos, unchanged).
    const observerPos = playerPos || this._resolveCameraPos();

    for (const mob of this._mobs) {
      if (mob.dead) {
        // Death-ramp mobs (item 2) stay in `this._mobs` -- AI/physics are
        // frozen but they keep animating (state.dying ramps 0->1) until
        // _updateDeathRamp finishes and queues them for removal. Ambient
        // despawns (_despawnMob) set dead:true WITHOUT _dying, so those
        // just fall through here and get flushed below, unchanged.
        if (mob._dying) this._updateDeathRamp(mob, clampedDt, observerPos);
        continue;
      }
      mob.ageSeconds = (mob.ageSeconds || 0) + clampedDt;
      if (mob.rider) {
        // Mounted (item 7): AI is fully skipped -- velocity is driven from
        // the rider's setRideInput() instead, through the SAME physics
        // path (gravity/collision/step-up) as any grounded hostile.
        this._driveRideInput(mob, clampedDt);
      } else {
        this._updateMobAI(mob, clampedDt, playerPos);
      }
      this._checkBossPhaseTransition(mob);
      if (mob.dead) {
        // e.g. exploder detonated mid-AI-step, or a lethal hit landed this
        // tick -- the death ramp was just started (_beginDeathRamp); give
        // it its first animate() tick now instead of waiting a frame.
        if (mob._dying) this._updateDeathRamp(mob, clampedDt, observerPos);
        continue;
      }
      this._updateMobPhysics(mob, clampedDt);
      this._updateMobVisuals(mob, clampedDt, observerPos);
    }

    if (this._particles && typeof this._particles.update === 'function') {
      try { this._particles.update(clampedDt); } catch (e) { /* ignore */ }
    }

    this._updateDespawn(clampedDt, playerPos);

    this._flushRemovals();
  }

  /** setDimension(id): despawn everyone, switch rule set, resume spawning.
   * `id` accepts either an engine id ('overworld'/'nether'/'end') or a
   * display-name key ('warpwold'/'cinderloom'/'nevermend'); it's normalized
   * to the canonical display-name key via spawnRules.normalizeDimension and
   * that canonical key is what's stored on `this.dimension` / passed as
   * state.dimension to animate(). */
  setDimension(id) {
    this._despawnAll();
    this.dimension = normalizeDimension(id);
    this._spawnTimer = 0.5 + this._rng() * 1.5;
  }

  /** dispose(): remove all mobs from the scene and drop references. */
  dispose() {
    this._despawnAll();
    this._mobs = [];
    this._pendingRemoval = [];
    if (this._particles && typeof this._particles.dispose === 'function') {
      try { this._particles.dispose(); } catch (e) { /* ignore */ }
    }
    this._particles = null;
    this._scene = null;
    this._world = null;
    // No real timers (setInterval/setTimeout) are used anywhere in this
    // class -- spawning/fuse/cooldowns are all accumulator-driven inside
    // update(dt) -- so there is nothing else to clear here.
  }

  // ----------------------------------------------------------------
  // Internal: spawning
  // ----------------------------------------------------------------

  _resolveIsDay() {
    if (this._dayOverride !== null) return this._dayOverride;
    return safeCall(this._opts.isDay, true);
  }

  _trySpawn(dt) {
    this._spawnTimer -= dt;
    if (this._spawnTimer > 0) return;
    this._spawnTimer = 2 + this._rng() * 3;

    const maxAlive = Number.isFinite(this._opts.maxMobs)
      ? this._opts.maxMobs
      : maxAliveFor(this.dimension);
    if (this._mobs.length >= maxAlive) return;

    const isDay = this._resolveIsDay();
    const archetype = pickSpawn(this.dimension, isDay, this._rng);
    if (!archetype) return;

    const playerPos = safeCall(this._opts.getPlayerPos, null);
    const center = playerPos || { x: 0, y: 1, z: 0 };

    const angle = this._rng() * Math.PI * 2;
    const ringDist = SPAWN_RING_MIN + this._rng() * (SPAWN_RING_MAX - SPAWN_RING_MIN);
    const x = center.x + Math.cos(angle) * ringDist;
    const z = center.z + Math.sin(angle) * ringDist;

    const groundY = this._findGroundY(x, (center.y || 1) + 8, z);
    const y = groundY !== null ? groundY : (center.y || 1);

    this.spawn(archetype, { x, y, z });
  }

  /** Scans downward from startY looking for the first solid block; returns
   * the y just above it, or null if none found within GROUND_SCAN_MAX. */
  _findGroundY(x, startY, z) {
    let y = Math.floor(startY);
    const bottom = y - GROUND_SCAN_MAX;
    for (; y > bottom; y--) {
      if (this._isSolid(x, y, z)) return y + 1;
    }
    return null;
  }

  // ----------------------------------------------------------------
  // Internal: despawning (ambient distance/age sweep)
  // ----------------------------------------------------------------

  /**
   * Low-rate sweep (every DESPAWN_CHECK_MIN-ish seconds, not every tick) so
   * this stays cheap even with many mobs alive. Traders and the boss (and
   * anything else spawnRules.DESPAWN_CONFIG.exemptArchetypes lists) are
   * exempt via shouldDespawn() itself.
   */
  _updateDespawn(dt, playerPos) {
    this._despawnTimer -= dt;
    if (this._despawnTimer > 0) return;
    this._despawnTimer = DESPAWN_CHECK_MIN + this._rng() * DESPAWN_CHECK_JITTER;
    if (!playerPos) return;

    for (const mob of this._mobs) {
      if (mob.dead) continue;
      if (mob.rider) continue; // never despawn a mob the player is currently riding
      let despawn;
      try {
        despawn = shouldDespawn(mob, playerPos, DESPAWN_CONFIG);
      } catch (e) {
        despawn = false;
      }
      if (despawn) this._despawnMob(mob);
    }
  }

  /** Quiet removal: no mobDeath, no loot -- just an optional 'mobDespawn'.
   * (The despawn sweep itself already skips currently-mounted mobs -- see
   * _updateDespawn -- this dismount is a defensive belt-and-suspenders
   * guard for any other/future caller of _despawnMob.) */
  _despawnMob(mob) {
    if (!mob || mob.dead) return;
    if (mob.rider) this.dismountPlayer(mob);
    mob.dead = true;
    this._emit('mobDespawn', {
      archetype: mob.archetype,
      canonicalId: mob.canonicalId,
      species: mob.species,
      mob,
      position: { ...mob.position },
    });
    this._pendingRemoval.push(mob);
  }

  // ----------------------------------------------------------------
  // Internal: per-archetype AI
  // ----------------------------------------------------------------

  _updateMobAI(mob, dt, playerPos) {
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};

    // Self-mend (item 3) + provoke-timer decrement (item 5) apply
    // regardless of aiBase, ahead of dispatch -- cheap no-ops for any mob
    // whose config doesn't opt in (no regenPerSec) / that never got
    // provoked (provokeTimer stays 0).
    this._updateRegen(mob, dt, config);
    if (mob.provokeTimer > 0) {
      mob.provokeTimer = Math.max(0, mob.provokeTimer - dt);
      if (mob.provokeTimer <= 0) mob.provoked = false;
    }
    // Attack wind-up (item 1): advances mob.telegraphTimer 0->1 over
    // TELEGRAPH_DURATION and fires the actual _doAttack() once it
    // completes -- see _beginTelegraph (called from each aiBase's own
    // attack-cooldown branch below) / _updateTelegraph.
    this._updateTelegraph(mob, dt);

    const aiBase = config.aiBase || mob.archetype;
    switch (aiBase) {
      case 'grazer': return this._aiGrazer(mob, dt, playerPos);
      case 'trader': return this._aiTrader(mob, dt, playerPos);
      case 'guardian': return this._aiGuardian(mob, dt, playerPos);
      case 'groaner': return this._aiGroaner(mob, dt, playerPos);
      case 'exploder': return this._aiExploder(mob, dt, playerPos);
      case 'screecher': return this._aiScreecher(mob, dt, playerPos);
      case 'boss':
        return mob.archetype === 'molthkin'
          ? this._aiMolthkin(mob, dt, playerPos)
          : this._aiLastNeedle(mob, dt, playerPos);
      default: return this._aiWanderOnly(mob, dt);
    }
  }

  /**
   * _updateRegen(mob, dt, config): item 3's self-mending. No-op unless
   * config.regenPerSec is set (currently just selvagewarden). Tracks
   * mob.sinceHurt (seconds since last _hurtMob call, reset there) and,
   * once it's been at least config.regenDelay seconds since the mob was
   * last hurt, heals config.regenPerSec hp/sec, capped at maxHp.
   */
  _updateRegen(mob, dt, config) {
    if (!config.regenPerSec) return;
    mob.sinceHurt = (Number.isFinite(mob.sinceHurt) ? mob.sinceHurt : Infinity) + dt;
    const delay = config.regenDelay ?? 5;
    if (mob.sinceHurt >= delay && mob.hp > 0 && mob.hp < mob.maxHp) {
      mob.hp = Math.min(mob.maxHp, mob.hp + config.regenPerSec * dt);
    }
  }

  // ----------------------------------------------------------------
  // Internal: cheap navigation helpers (item 5) -- grounded hostiles run
  // their seek/wander steering through AI.navSteer so they hop 1-block
  // steps and avoid cliffs; flyers run theirs through AI.flyerAvoid so they
  // climb over terrain / settle to a cruise altitude. Both are a small,
  // fixed number of isSolid() samples per call (see ai.js), so this stays
  // cheap per-tick even with many mobs.
  // ----------------------------------------------------------------

  /** Grounded + hostile: pass desired {vx,vz} through navSteer, jump on cue. */
  _steerGroundedHostile(mob, config, desired) {
    const halfWidth = config.halfWidth ?? 0.3;
    let nav;
    try {
      nav = AI.navSteer(mob.position, desired, halfWidth, this._isSolid);
    } catch (e) {
      nav = { vx: desired.vx, vz: desired.vz, wantJump: false };
    }
    if (nav.wantJump && mob.grounded) {
      mob.velocity.y = AI.JUMP_SPEED;
    }
    mob.velocity.x = nav.vx;
    mob.velocity.z = nav.vz;
    mob._moving = !!desired.moving;
  }

  /** Flyer: pass desired {vx,vz} through flyerAvoid; vy applied in physics. */
  _steerFlyer(mob, desired) {
    let avoid;
    try {
      avoid = AI.flyerAvoid(mob.position, desired, this._isSolid);
    } catch (e) {
      avoid = { vx: desired.vx, vz: desired.vz, vy: 0 };
    }
    mob.velocity.x = avoid.vx;
    mob.velocity.z = avoid.vz;
    mob._navVy = avoid.vy || 0;
    mob._moving = !!desired.moving;
  }

  /**
   * _driveRideInput(mob, dt): item 7. Runs INSTEAD OF _updateMobAI for a
   * currently-mounted mob (see update()). Reads mob.rideInput
   * ({ moveX, moveZ, jump }), builds a desired horizontal velocity by
   * normalizing that direction and scaling by config.rideSpeed (clamped so
   * an oversized input vector can never exceed the mount's top ride
   * speed), then runs it through the exact SAME grounded-hostile steering
   * path (_steerGroundedHostile -> AI.navSteer) used by every hostile AI
   * here, so a rider gets the same gravity/collision/1-block-step-up
   * behaviour for free. Applies a jump impulse only if input.jump is set
   * AND the mount is currently grounded.
   */
  _driveRideInput(mob, dt) {
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    const input = mob.rideInput || { moveX: 0, moveZ: 0, jump: false };
    const maxSpeed = config.rideSpeed ?? config.fleeSpeed ?? config.speed ?? 3;
    const moveX = Number.isFinite(input.moveX) ? input.moveX : 0;
    const moveZ = Number.isFinite(input.moveZ) ? input.moveZ : 0;
    const mag = Math.hypot(moveX, moveZ);

    let desired;
    if (mag > 1e-6) {
      const clampedMag = Math.min(mag, 1); // moveX/moveZ needn't be pre-normalized
      desired = {
        vx: (moveX / mag) * clampedMag * maxSpeed,
        vz: (moveZ / mag) * clampedMag * maxSpeed,
        moving: true,
      };
    } else {
      desired = { vx: 0, vz: 0, moving: false };
    }

    this._steerGroundedHostile(mob, config, desired);

    if (input.jump && mob.grounded) {
      mob.velocity.y = AI.JUMP_SPEED;
    }
  }

  _aiWanderOnly(mob, dt) {
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    const steer = AI.wanderSteer(mob.wander, dt, this._rng, config.speed ?? 1.0);
    if (config.flies) {
      this._steerFlyer(mob, steer);
    } else if (config.hostile) {
      this._steerGroundedHostile(mob, config, steer);
    } else {
      mob.velocity.x = steer.vx;
      mob.velocity.z = steer.vz;
      mob._moving = steer.moving;
    }
  }

  // Passive: wanders; flees from the player for a few seconds after being hurt.
  _aiGrazer(mob, dt, playerPos) {
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    if (mob.fleeTimer > 0) {
      mob.fleeTimer = Math.max(0, mob.fleeTimer - dt);
      const steer = AI.fleeSteer(mob.position, playerPos, config.fleeSpeed ?? 1.8);
      mob.velocity.x = steer.vx;
      mob.velocity.z = steer.vz;
      mob._moving = steer.moving;
    } else {
      this._aiWanderOnly(mob, dt);
    }
  }

  // Neutral: idles near its spawn point (tethered wander), never attacks.
  _aiTrader(mob, dt) {
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    const distFromSpawn = AI.horizontalDistance(mob.position, mob.spawnPos);
    let steer;
    if (distFromSpawn > (config.tetherRadius ?? 5)) {
      steer = AI.seekSteer(mob.position, mob.spawnPos, config.speed);
    } else {
      steer = AI.wanderSteer(mob.wander, dt, this._rng, config.speed);
    }
    mob.velocity.x = steer.vx;
    mob.velocity.z = steer.vz;
    mob._moving = steer.moving;
  }

  // Neutral-until-provoked (item 5): idles/tethers near its spawn point
  // exactly like _aiTrader by default. Once _hurtMob has set
  // mob.provoked=true (with mob.provokeTimer freshly reset -- decremented
  // every tick in _updateMobAI, which also clears mob.provoked once it
  // hits 0), this behaves hostile for the remainder of that timer: seeks
  // and attacks the player using contactDamage, groaner-style. Currently
  // used by scaldwarden (canon: a neutral guardian that retaliates when
  // attacked, then settles back down).
  _aiGuardian(mob, dt, playerPos) {
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    if (mob.provoked && mob.provokeTimer > 0) {
      mob.attackCooldownTimer = Math.max(0, mob.attackCooldownTimer - dt);
      const dist = AI.horizontalDistance(mob.position, playerPos);
      if (dist <= (config.aggroRange ?? 8)) {
        if (dist <= (config.attackRange ?? 1.0)) {
          mob.velocity.x = 0;
          mob.velocity.z = 0;
          mob._moving = false;
          if (mob.attackCooldownTimer <= 0 && !mob._telegraphing) {
            mob.attackCooldownTimer = config.attackCooldown ?? 1.2;
            this._beginTelegraph(mob, config.contactDamage ?? 6);
          }
        } else {
          const steer = AI.seekSteer(mob.position, playerPos, config.seekSpeed ?? config.speed);
          this._steerGroundedHostile(mob, config, steer);
        }
      } else {
        this._aiWanderOnly(mob, dt);
      }
      return;
    }
    // Neutral: idle/tether near spawn, same as a trader.
    this._aiTrader(mob, dt);
  }

  // Hostile: wanders until player in aggro range, seeks, attacks on contact.
  // Reused (via aiBase:'groaner') by frayedhound/emberspinner/unpicked/
  // selvagewarden -- ARCHETYPE_CONFIG[mob.archetype] pulls each archetype's
  // own tuning. Flight-aware (item 6): if config.flies is set (currently
  // just raveler), the seek/attack-hold steering is routed through
  // _steerFlyer (which itself composes AI.flyerAvoid terrain-avoidance)
  // instead of _steerGroundedHostile, exactly like the boss composes
  // flyer physics with its own seek logic -- so a flying groaner-family
  // mob gets real hover flight + terrain avoidance while keeping the same
  // aggro/attack decision tree as every grounded groaner. The out-of-range
  // wander case is already flight-aware via _aiWanderOnly.
  _aiGroaner(mob, dt, playerPos) {
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    mob.attackCooldownTimer = Math.max(0, mob.attackCooldownTimer - dt);

    const dist = AI.horizontalDistance(mob.position, playerPos);
    if (dist <= (config.aggroRange ?? 8)) {
      if (dist <= (config.attackRange ?? 0.9)) {
        if (config.flies) {
          this._steerFlyer(mob, { vx: 0, vz: 0, moving: true }); // hovers in place
        } else {
          mob.velocity.x = 0;
          mob.velocity.z = 0;
          mob._moving = false;
        }
        if (mob.attackCooldownTimer <= 0 && !mob._telegraphing) {
          mob.attackCooldownTimer = config.attackCooldown ?? 1.0;
          this._beginTelegraph(mob, config.contactDamage ?? 1);
        }
      } else {
        const steer = AI.seekSteer(mob.position, playerPos, config.seekSpeed ?? config.speed);
        if (config.flies) {
          this._steerFlyer(mob, steer);
        } else {
          this._steerGroundedHostile(mob, config, steer);
        }
      }
    } else {
      this._aiWanderOnly(mob, dt);
    }
  }

  // Hostile: approaches, fuses within fuseRange, detonates at fuse===1.
  _aiExploder(mob, dt, playerPos) {
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    const dist = AI.horizontalDistance(mob.position, playerPos);

    if (dist <= (config.aggroRange ?? 7)) {
      if (dist <= (config.fuseRange ?? 2.0)) {
        mob.velocity.x = 0;
        mob.velocity.z = 0;
        mob._moving = false;
        mob.fuse = Math.min(1, mob.fuse + dt / (config.fuseDuration ?? 1.5));
        if (mob.fuse >= 1) {
          this._explode(mob, playerPos);
          return;
        }
        // VFX (item 3): hot sparks while actively fusing, throttled so this
        // stays cheap even close to the pool's emit rate limit.
        if (this._particles) {
          mob._sparkTimer = (mob._sparkTimer || 0) + dt;
          if (mob._sparkTimer >= SPARK_INTERVAL) {
            mob._sparkTimer = 0;
            try { this._particles.emitSparks(mob.position, mob._color, 3); } catch (e) { /* ignore */ }
          }
        }
      } else {
        const steer = AI.seekSteer(mob.position, playerPos, config.speed);
        this._steerGroundedHostile(mob, config, steer);
        mob.fuse = Math.max(0, mob.fuse - dt * 0.5); // cools while out of fuse range
        mob._sparkTimer = 0;
      }
    } else {
      this._aiWanderOnly(mob, dt);
      mob.fuse = Math.max(0, mob.fuse - dt * 0.5);
    }
  }

  // Hostile-ish flyer: hovers, drifts toward the player, attacks on contact.
  // Item 2 fix: non-hostile flyers (config.hostile:false, e.g. silencemoth)
  // never seek/attack -- they just wander/hover in place, ambient-only.
  _aiScreecher(mob, dt, playerPos) {
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    if (!config.hostile) {
      const steer = AI.wanderSteer(mob.wander, dt, this._rng, (config.speed ?? 1.3) * 0.5);
      this._steerFlyer(mob, steer);
      return;
    }
    mob.attackCooldownTimer = Math.max(0, mob.attackCooldownTimer - dt);

    const dist = AI.horizontalDistance(mob.position, playerPos);
    if (dist <= (config.aggroRange ?? 10)) {
      if (dist <= (config.attackRange ?? 1.2)) {
        this._steerFlyer(mob, { vx: 0, vz: 0, moving: true }); // still hovers/flaps in place
        if (mob.attackCooldownTimer <= 0 && !mob._telegraphing) {
          mob.attackCooldownTimer = config.attackCooldown ?? 1.2;
          this._beginTelegraph(mob, config.contactDamage ?? 2);
        }
      } else {
        // Slow drift toward the player -- deliberately gentler than a
        // ground-hostile's seek speed.
        const steer = AI.seekSteer(mob.position, playerPos, (config.speed ?? 1.3) * 0.6);
        this._steerFlyer(mob, steer);
      }
    } else {
      const steer = AI.wanderSteer(mob.wander, dt, this._rng, (config.speed ?? 1.3) * 0.5);
      this._steerFlyer(mob, steer);
    }
  }

  // Boss: The Last Needle. Three hp-fraction-driven phases (canonical
  // thresholds: 60% / 15%):
  //   phase 0 (frac > phase1HpFrac, i.e. > 60%):  slow hover-drift +
  //                                   periodic ranged thread-lash attack.
  //   phase 1 (phase2HpFrac < frac <= phase1HpFrac, i.e. 15%-60%): faster,
  //                                   wider attacks, periodically summons a
  //                                   "Shed of Ravelers" ('raveler' adds)
  //                                   near itself (capped at maxAdds alive).
  //   phase 2 (frac <= phase2HpFrac, i.e. <= 15%): fast, aggressive, rapid
  //                                   short-cooldown high-damage stabs, and
  //                                   (most aggressive phase) keeps
  //                                   summoning too -- mostly 'raveler'
  //                                   with an occasional 'unpicked' mixed
  //                                   in.
  // mob.bossPhase is updated every tick and fed into animate() as
  // state.phase; mob.attackFlash (generic, see _doAttack) is fed in as
  // state.attack so the model can react to hits landing.
  _aiLastNeedle(mob, dt, playerPos) {
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    mob.attackCooldownTimer = Math.max(0, mob.attackCooldownTimer - dt);
    mob.summonCooldownTimer = Math.max(0, (mob.summonCooldownTimer || 0) - dt);

    const frac = mob.maxHp > 0 ? Math.max(0, mob.hp) / mob.maxHp : 0;
    let phase = 0;
    if (frac <= (config.phase2HpFrac ?? 0.15)) phase = 2;
    else if (frac <= (config.phase1HpFrac ?? 0.60)) phase = 1;
    mob.bossPhase = phase;

    const speedMul = (config.phaseSpeedMul && config.phaseSpeedMul[phase]) ?? 1.0;
    const seekSpeed = (config.seekSpeed ?? config.speed ?? 1.0) * speedMul;
    const attackRange = (config.phaseAttackRanges && config.phaseAttackRanges[phase])
      ?? config.attackRange ?? 7;

    const dist = AI.horizontalDistance(mob.position, playerPos);
    const aggroRange = config.aggroRange ?? 24;

    let steer;
    if (!Number.isFinite(dist) || dist > aggroRange) {
      // Player out of range (or unknown): slow idle drift near current spot.
      steer = AI.wanderSteer(mob.wander, dt, this._rng, seekSpeed * 0.25);
    } else if (dist > attackRange * 0.6) {
      steer = AI.seekSteer(mob.position, playerPos, seekSpeed);
    } else {
      // Close enough to fight: hover with only a light drift.
      steer = AI.wanderSteer(mob.wander, dt, this._rng, seekSpeed * 0.15);
    }
    this._steerFlyer(mob, steer);

    // Ranged/melee attack, cooldown + damage escalate by phase.
    if (Number.isFinite(dist) && dist <= attackRange) {
      const cooldown = (config.phaseAttackCooldowns && config.phaseAttackCooldowns[phase])
        ?? config.attackCooldown ?? 2.0;
      if (mob.attackCooldownTimer <= 0 && !mob._telegraphing) {
        mob.attackCooldownTimer = cooldown;
        const dmg = (config.phaseAttackDamage && config.phaseAttackDamage[phase])
          ?? config.contactDamage ?? 6;
        this._beginTelegraph(mob, dmg);
      }
    }

    // Phase 1 + phase 2: periodically summon adds near the boss, capped so
    // the arena doesn't flood. Phase 1 summons a straight "Shed of
    // Ravelers" (all 'raveler'); phase 2 summons a mix, mostly 'raveler'
    // with an occasional 'unpicked' (summonArchetypePhase2AltChance).
    if ((phase === 1 || phase === 2) && mob.summonCooldownTimer <= 0) {
      const maxAdds = config.maxAdds ?? 4;
      const aliveAdds = this._mobs.reduce(
        (n, m) => n + ((!m.dead && m.spawnedBy === mob.id) ? 1 : 0), 0
      );
      if (aliveAdds < maxAdds) {
        mob.summonCooldownTimer = config.summonCooldown ?? 6;
        let summonArchetype;
        if (phase === 1) {
          summonArchetype = config.summonArchetype || 'raveler';
        } else {
          const altChance = config.summonArchetypePhase2AltChance ?? 0.25;
          summonArchetype = (this._rng() < altChance)
            ? (config.summonArchetypePhase2Alt || 'unpicked')
            : (config.summonArchetypePhase2 || config.summonArchetype || 'raveler');
        }
        const angle = this._rng() * Math.PI * 2;
        const ringDist = 2 + this._rng() * 2.5;
        const spawnX = mob.position.x + Math.cos(angle) * ringDist;
        const spawnZ = mob.position.z + Math.sin(angle) * ringDist;
        const groundY = this._findGroundY(spawnX, mob.position.y + 2, spawnZ);
        const spawnY = groundY !== null ? groundY : Math.max(0, mob.position.y - (config.hoverHeight ?? 3));
        const add = this.spawn(summonArchetype, { x: spawnX, y: spawnY, z: spawnZ });
        if (add) add.spawnedBy = mob.id;
      } else {
        // Already capped -- recheck soon rather than waiting a full cycle.
        mob.summonCooldownTimer = 1.0;
      }
    }
  }

  // Boss: Molthkin, the First Bobbin. Simplified 2-PHASE hp-fraction model
  // (canonical threshold: 50%), GROUNDED (not flying, unlike lastneedle) --
  // reuses the same grounded-hostile nav path (_steerGroundedHostile) as
  // any groaner-family mob:
  //   phase 0 (frac > phase1HpFrac, i.e. > 50%):  slow deliberate approach
  //                                   + heavy thread-arm melee/short-range
  //                                   attack.
  //   phase 1 (frac <= phase1HpFrac, i.e. <= 50%): enraged -- faster
  //                                   (phaseSpeedMul), and periodically
  //                                   summons adds ('exploder'/Waxling,
  //                                   occasional 'emberspinner') near
  //                                   itself, capped at maxAdds alive (via
  //                                   spawnedBy) -- same pattern as
  //                                   _aiLastNeedle's own add-summoning.
  // mob.bossPhase (0/1) is updated every tick and fed into animate() as
  // state.phase (molthkin's own animate treats it as a 0..1 float, so
  // this maps directly onto its phase0/phase1 poses); mob.attackFlash
  // (generic, see _doAttack) is fed in as state.attack.
  _aiMolthkin(mob, dt, playerPos) {
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    mob.attackCooldownTimer = Math.max(0, mob.attackCooldownTimer - dt);
    mob.summonCooldownTimer = Math.max(0, (mob.summonCooldownTimer || 0) - dt);

    const frac = mob.maxHp > 0 ? Math.max(0, mob.hp) / mob.maxHp : 0;
    const phase = frac <= (config.phase1HpFrac ?? 0.5) ? 1 : 0;
    mob.bossPhase = phase;

    const speedMul = (config.phaseSpeedMul && config.phaseSpeedMul[phase]) ?? 1.0;
    const seekSpeed = (config.seekSpeed ?? config.speed ?? 1.0) * speedMul;
    const attackRange = (config.phaseAttackRanges && config.phaseAttackRanges[phase])
      ?? config.attackRange ?? 2.2;

    const dist = AI.horizontalDistance(mob.position, playerPos);
    const aggroRange = config.aggroRange ?? 14;

    let steer;
    if (!Number.isFinite(dist) || dist > aggroRange) {
      // Player out of range (or unknown): slow idle drift near current spot.
      steer = AI.wanderSteer(mob.wander, dt, this._rng, seekSpeed * 0.2);
    } else if (dist > attackRange * 0.7) {
      steer = AI.seekSteer(mob.position, playerPos, seekSpeed);
    } else {
      // Close enough to fight: hold ground, no drift.
      steer = { vx: 0, vz: 0, moving: false };
    }
    this._steerGroundedHostile(mob, config, steer);

    // Heavy melee/short-range attack, cooldown + damage escalate by phase.
    if (Number.isFinite(dist) && dist <= attackRange) {
      const cooldown = (config.phaseAttackCooldowns && config.phaseAttackCooldowns[phase])
        ?? config.attackCooldown ?? 2.0;
      if (mob.attackCooldownTimer <= 0 && !mob._telegraphing) {
        mob.attackCooldownTimer = cooldown;
        const dmg = (config.phaseAttackDamage && config.phaseAttackDamage[phase])
          ?? config.contactDamage ?? 11;
        this._beginTelegraph(mob, dmg);
      }
    }

    // Phase 1 (enraged) only: periodically summon adds near the boss,
    // capped so the arena doesn't flood -- mostly 'exploder' (Waxling)
    // with an occasional 'emberspinner' (summonArchetypeAltChance).
    if (phase === 1 && mob.summonCooldownTimer <= 0) {
      const maxAdds = config.maxAdds ?? 3;
      const aliveAdds = this._mobs.reduce(
        (n, m) => n + ((!m.dead && m.spawnedBy === mob.id) ? 1 : 0), 0
      );
      if (aliveAdds < maxAdds) {
        mob.summonCooldownTimer = config.summonCooldown ?? 7;
        const altChance = config.summonArchetypeAltChance ?? 0.4;
        const summonArchetype = (this._rng() < altChance)
          ? (config.summonArchetypeAlt || 'emberspinner')
          : (config.summonArchetypePrimary || 'exploder');
        const angle = this._rng() * Math.PI * 2;
        const ringDist = 2.5 + this._rng() * 2.5;
        const spawnX = mob.position.x + Math.cos(angle) * ringDist;
        const spawnZ = mob.position.z + Math.sin(angle) * ringDist;
        const groundY = this._findGroundY(spawnX, mob.position.y + 3, spawnZ);
        const spawnY = groundY !== null ? groundY : mob.position.y;
        const add = this.spawn(summonArchetype, { x: spawnX, y: spawnY, z: spawnZ });
        if (add) add.spawnedBy = mob.id;
      } else {
        // Already capped -- recheck soon rather than waiting a full cycle.
        mob.summonCooldownTimer = 1.0;
      }
    }
  }

  // ----------------------------------------------------------------
  // Internal: physics + animation
  // ----------------------------------------------------------------

  _updateMobPhysics(mob, dt) {
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    const halfWidth = config.halfWidth ?? 0.3;
    const height = config.height ?? 0.8;

    if (config.flies) {
      mob.velocity.y = 0;
      AI.resolveHorizontal(mob.position, mob.velocity, halfWidth, height, this._isSolid, dt);
      const targetY = mob.spawnPos.y + (config.hoverHeight ?? 1.0);
      const navVy = mob._navVy || 0;
      mob.position.y += (targetY - mob.position.y) * Math.min(1, dt * 2) + navVy * dt;
      mob.grounded = false;
    } else {
      const { grounded } = AI.stepGroundedBody(
        mob.position, mob.velocity, halfWidth, height, this._isSolid, dt
      );
      mob.grounded = grounded;
    }

    mob.group.position.set(mob.position.x, mob.position.y, mob.position.z);
  }

  /**
   * _animateMob(mob, dt): builds the EXTENDED animate() state (see the
   * file-header note above) and calls the creature's own
   * root.userData.animate(t, state). Also owns the two purely-visual,
   * root-level effects that live outside any single creature's own
   * animate() implementation:
   *   - speed01: normalized ground speed (horizontalSpeed/config.speed,
   *     clamped 0..1) for gait blending.
   *   - smooth turn + lean (item 4): damps mob.group.rotation.y toward the
   *     heading implied by horizontal velocity (rig.lerpAngle, frame-rate
   *     independent via an exponential damping factor -- same shape as
   *     rig.damp), exposes the signed yaw rate as state.turn, and applies a
   *     subtle proportional bank on mob.group.rotation.z. Skipped while
   *     mounted or mid-death-ramp. NOTE: raveler's own animate() sets
   *     root.rotation.y/z unconditionally every frame (its idle yaw-drift +
   *     hurt-jolt) -- since that runs AFTER this method's assignment below,
   *     it intentionally wins for raveler specifically (preserves that
   *     creature's existing behavior); every other creature module only
   *     touches sub-part rotations, so turn+lean is visible on them.
   */
  _animateMob(mob, dt) {
    if (mob.hurtTimer > 0) {
      mob.hurtTimer = Math.max(0, mob.hurtTimer - dt / HURT_FLASH_DURATION);
    }
    if (mob.attackFlash > 0) {
      mob.attackFlash = Math.max(0, mob.attackFlash - dt / ATTACK_FLASH_DURATION);
    }

    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    const vx = mob.velocity.x || 0;
    const vz = mob.velocity.z || 0;
    const speedH = Math.hypot(vx, vz);
    const maxSpeed = config.speed || config.seekSpeed || 1;
    const speed01 = maxSpeed > 0 ? Math.min(1, Math.max(0, speedH / maxSpeed)) : 0;

    if (!mob.rider && !(mob.dying > 0) && mob.group) {
      if (speedH > TURN_HEADING_MIN_SPEED) {
        mob._targetHeading = Math.atan2(vx, vz);
      }
      if (typeof mob._targetHeading === 'number' && dt > 0) {
        const prevYaw = mob.group.rotation.y;
        const factor = 1 - Math.exp(-TURN_LAMBDA * dt);
        const newYaw = rig.lerpAngle(prevYaw, mob._targetHeading, factor);
        mob.turn = (newYaw - prevYaw) / dt;
        mob.group.rotation.y = newYaw;
        const targetBank = Math.max(-MAX_BANK, Math.min(MAX_BANK, -mob.turn * BANK_FACTOR));
        mob.group.rotation.z = rig.damp(mob.group.rotation.z, targetBank, BANK_LAMBDA, dt);
      }
    } else {
      mob.turn = 0;
    }

    const state = {
      moving: !!mob._moving,
      grounded: !!mob.grounded,
      dimension: this.dimension,
      speed01,
      fuse: mob.fuse || 0,
      hurt: mob.hurtTimer || 0,
      attack: mob.attackFlash || 0,
      telegraph: mob.telegraphTimer || 0,
      phase: mob.bossPhase || 0,
      dying: mob.dying || 0,
      turn: mob.turn || 0,
    };
    const animate = mob.group && mob.group.userData && mob.group.userData.animate;
    if (typeof animate === 'function') {
      try {
        animate(this._elapsed, state);
      } catch (e) {
        // A broken creature animate() should never take down the manager.
      }
    }
  }

  /**
   * _updateMobVisuals(mob, dt, observerPos): the per-frame visual pass for
   * a live (non-dying) mob -- cheap distance-only LOD (item 6) gating
   * animate() cadence, plus the health-bar billboard (item 5). Also reused
   * by _updateDeathRamp for the death-ramp's own per-frame visuals.
   *
   * LOD is DELIBERATELY cheap (a single horizontal-distance check) and only
   * throttles/skips animate()+billboard-visibility -- it never touches
   * spawn/despawn eligibility or mesh detail/instancing, which stay the
   * graphics team's domain.
   */
  _updateMobVisuals(mob, dt, observerPos) {
    let lod = 0;
    if (observerPos && mob.position) {
      let dist;
      try {
        dist = AI.horizontalDistance(mob.position, observerPos);
      } catch (e) {
        dist = null;
      }
      if (Number.isFinite(dist)) {
        const near = this._lodDistance;
        const far = near * LOD_FAR_MULTIPLIER;
        if (dist > far) lod = 2;
        else if (dist > near) lod = 1;
      }
    }
    mob._lod = lod;

    let shouldAnimate = true;
    if (lod === 1) {
      shouldAnimate = ((this._frameCounter + mob.id) % 3) === 0;
    } else if (lod === 2) {
      shouldAnimate = false; // far enough that a skipped animate frame is imperceptible
    }
    if (shouldAnimate) this._animateMob(mob, dt);

    if (mob.billboard) {
      const hpFrac = mob.maxHp > 0 ? Math.max(0, mob.hp) / mob.maxHp : 0;
      try { mob.billboard.setHp(hpFrac); } catch (e) { /* ignore */ }
      try { mob.billboard.setVisible(lod === 0); } catch (e) { /* ignore */ }
    }
  }

  /** _resolveCameraPos() -> {x,y,z}|null. LOD-only fallback observer
   * position when opts.getPlayerPos is missing/throws; see opts.getCamera. */
  _resolveCameraPos() {
    const cam = safeCall(this._getCamera, null);
    if (cam && cam.position && Number.isFinite(cam.position.x)) {
      return { x: cam.position.x, y: cam.position.y, z: cam.position.z };
    }
    return null;
  }

  /** _checkBossPhaseTransition(mob): fires a VFX burst (item 3) the tick
   * mob.bossPhase actually changes (set by _aiLastNeedle/_aiMolthkin
   * earlier this same tick). No-op for non-bosses. */
  _checkBossPhaseTransition(mob) {
    if (!mob.isBoss) return;
    const prev = Number.isFinite(mob._lastBossPhase) ? mob._lastBossPhase : 0;
    const cur = mob.bossPhase || 0;
    if (cur === prev) return;
    mob._lastBossPhase = cur;
    if (this._particles) {
      try { this._particles.emitBurst(mob.position, mob._color, 40); } catch (e) { /* ignore */ }
    }
  }

  // ----------------------------------------------------------------
  // Internal: attack telegraph (item 1)
  // ----------------------------------------------------------------

  /** _beginTelegraph(mob, dmg): starts a TELEGRAPH_DURATION wind-up instead
   * of applying damage immediately. Called from each aiBase's own
   * attack-cooldown branch (cooldown reset semantics UNCHANGED -- it's
   * still set the instant the wind-up starts, exactly as before this pass
   * called _doAttack directly at that point); _updateTelegraph fires the
   * actual _doAttack() once telegraphTimer reaches 1. */
  _beginTelegraph(mob, dmg) {
    mob._telegraphing = true;
    mob.telegraphTimer = 0;
    mob._pendingAttackDamage = Number.isFinite(dmg) ? dmg : 0;
  }

  /** _updateTelegraph(mob, dt): advances an in-progress wind-up; no-op if
   * none is active. Called every AI tick (see _updateMobAI) -- frozen for
   * free once a mob stops receiving AI ticks (mounted/dying/dead). */
  _updateTelegraph(mob, dt) {
    if (!mob._telegraphing) return;
    mob.telegraphTimer = Math.min(1, (mob.telegraphTimer || 0) + dt / TELEGRAPH_DURATION);
    if (mob.telegraphTimer >= 1) {
      mob._telegraphing = false;
      const dmg = mob._pendingAttackDamage || 0;
      mob._pendingAttackDamage = 0;
      mob.telegraphTimer = 0;
      if (!mob.dead) this._doAttack(mob, dmg);
    }
  }

  // ----------------------------------------------------------------
  // Internal: death animation + deferred removal (item 2)
  // ----------------------------------------------------------------

  /** _beginDeathRamp(mob): called once from _killMob/_killBoss/_explode's
   * kill path, right after mob.dead is set + 'mobDeath'/'bossDefeated' +
   * loot have already fired (exactly once, unchanged timing). Does NOT
   * queue the mob for removal -- that happens once _updateDeathRamp's
   * timer expires, in the main update() loop -- so the creature's own
   * animate() gets to play a death pose against state.dying ramping 0->1
   * first. Also fires the UNRAVEL particle poof, colored from the
   * species' primary palette color. */
  _beginDeathRamp(mob) {
    mob.dying = 0;
    mob._dying = true;
    mob._deathDuration = mob.isBoss ? this._bossDeathDuration : this._deathDuration;
    mob._deathTimer = mob._deathDuration;
    mob.velocity.x = 0;
    mob.velocity.y = 0;
    mob.velocity.z = 0;
    mob._moving = false;
    if (this._particles) {
      try { this._particles.emitUnravel(mob.position, mob._color, mob.isBoss ? 48 : 24); } catch (e) { /* ignore */ }
    }
  }

  /** _updateDeathRamp(mob, dt, observerPos): advances mob.dying 0->1 over
   * mob._deathDuration while AI/physics stay frozen (mob.group.position is
   * simply left wherever the last live physics tick put it), still driving
   * per-frame visuals (LOD-aware animate() + billboard) via
   * _updateMobVisuals. Queues the mob for removal once the timer expires --
   * _flushRemovals (called at the end of every update()) does the actual
   * scene.remove()/billboard.dispose()/array splice. */
  _updateDeathRamp(mob, dt, observerPos) {
    const duration = mob._deathDuration || this._deathDuration;
    mob._deathTimer = Math.max(0, (mob._deathTimer || 0) - dt);
    mob.dying = duration > 0 ? Math.min(1, Math.max(0, 1 - mob._deathTimer / duration)) : 1;
    this._updateMobVisuals(mob, dt, observerPos);
    if (mob._deathTimer <= 0) {
      mob._dying = false;
      this._pendingRemoval.push(mob);
    }
  }

  // ----------------------------------------------------------------
  // Internal: combat / events
  // ----------------------------------------------------------------

  _doAttack(mob, dmg) {
    mob.attackFlash = 1.0;
    safeCall1(this._opts.onPlayerHurt, dmg, undefined);
    this._emit('mobAttack', {
      archetype: mob.archetype,
      canonicalId: mob.canonicalId,
      species: mob.species,
      mob,
      position: { ...mob.position },
      dmg,
    });
  }

  _explode(mob, playerPos) {
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    const blastRadius = config.blastRadius ?? 3.0;
    const blastDamage = config.blastDamage ?? 6;
    const dist = AI.horizontalDistance(mob.position, playerPos);
    const hitPlayer = Number.isFinite(dist) && dist <= blastRadius;

    mob.attackFlash = 1.0;
    this._emit('mobAttack', {
      archetype: mob.archetype,
      canonicalId: mob.canonicalId,
      species: mob.species,
      mob,
      position: { ...mob.position },
      explosion: true,
      dmg: blastDamage,
      hitPlayer,
    });

    if (hitPlayer) {
      safeCall1(this._opts.onPlayerHurt, blastDamage, undefined);
    }

    mob.hp = 0;
    this._killMob(mob);
  }

  _hurtMob(mob, dmg) {
    if (!mob || mob.dead) return;
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    const amount = Math.max(0, Number.isFinite(dmg) ? dmg : 0);
    mob.hp -= amount;
    mob.hurtTimer = 1.0;
    mob.sinceHurt = 0; // restarts the regenDelay countdown for self-mending archetypes

    this._emit('mobHurt', {
      archetype: mob.archetype,
      canonicalId: mob.canonicalId,
      species: mob.species,
      mob,
      position: { ...mob.position },
      dmg: amount,
    });

    const aiBase = config.aiBase || mob.archetype;
    if (aiBase === 'grazer') {
      mob.fleeTimer = config.fleeDuration ?? FLEE_DURATION;
    }
    // Item 5: getting hurt is what PROVOKES a 'guardian' (scaldwarden) --
    // it goes hostile for provokeDuration seconds (decremented every tick
    // in _updateMobAI), then reverts to neutral idling.
    if (aiBase === 'guardian') {
      mob.provoked = true;
      mob.provokeTimer = config.provokeDuration ?? 8;
    }

    if (mob.hp <= 0) {
      if (mob.isBoss) {
        this._killBoss(mob);
      } else {
        this._killMob(mob);
      }
    }
  }

  _killMob(mob) {
    if (!mob || mob.dead) return;
    if (mob.rider) this.dismountPlayer(mob); // never leave a rider on a dead mount
    mob.dead = true;
    this._emit('mobDeath', {
      archetype: mob.archetype,
      canonicalId: mob.canonicalId,
      species: mob.species,
      mob,
      position: { ...mob.position },
    });
    this._dropLoot(mob);
    // Death animation (item 2): defer actual removal -- see _beginDeathRamp.
    this._beginDeathRamp(mob);
  }

  /** Boss defeat: 'bossDefeated' instead of 'mobDeath'. `bound` comes from
   * ARCHETYPE_CONFIG.bound (default true when unset): lastneedle is
   * bound:true (bound, not killed -- its loot table happens to be empty
   * too, so _dropLoot below is a no-op for it either way) with
   * victoryTrigger/achievement so the builder can wire the win
   * condition/ending without hardcoding archetype strings; molthkin is
   * bound:false (genuinely KILLABLE) with NO victoryTrigger/achievement
   * fields at all (those are lastneedle-only -- only included in the
   * emitted detail when ARCHETYPE_CONFIG actually sets them). Bosses now
   * DROP loot too (item 4): _dropLoot is called for every boss, same as a
   * normal death -- molthkin's table has everthread, lastneedle's is
   * empty so this remains a silent no-op for it. */
  _killBoss(mob) {
    if (!mob || mob.dead) return;
    if (mob.rider) this.dismountPlayer(mob); // never leave a rider on a dead mount
    mob.dead = true;
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    const detail = {
      archetype: mob.archetype,
      canonicalId: mob.canonicalId,
      species: mob.species,
      mob,
      position: { ...mob.position },
      bound: config.bound !== false,
    };
    if (config.victoryTrigger) detail.victoryTrigger = config.victoryTrigger;
    if (config.achievement) detail.achievement = config.achievement;
    this._emit('bossDefeated', detail);
    this._dropLoot(mob);
    // Death animation (item 2): defer actual removal -- see _beginDeathRamp.
    this._beginDeathRamp(mob);
  }

  /** Rolls lootTables.rollLoot(mob.archetype, rng) and emits one 'mobDrop'
   * per resulting stack. Called after mobDeath AND after bossDefeated (see
   * _killMob/_killBoss), never on despawn. Empty tables (unpicked,
   * lastneedle) simply produce an empty `drops` array, so the loop below
   * emits nothing -- no special-casing needed. Defensive against a
   * throwing/misbehaving loot table. */
  _dropLoot(mob) {
    let drops;
    try {
      drops = rollLoot(mob.archetype, this._rng) || [];
    } catch (e) {
      drops = [];
    }
    for (const drop of drops) {
      if (!drop) continue;
      this._emit('mobDrop', {
        mobId: mob.id,
        archetype: mob.archetype,
        canonicalId: mob.canonicalId,
        itemId: drop.itemId,
        pos: { ...mob.position },
        count: drop.count,
      });
    }
  }

  _emit(name, detail) {
    if (typeof CustomEvent !== 'undefined') {
      try {
        this.dispatchEvent(new CustomEvent(name, { detail }));
      } catch (e) {
        // ignore
      }
    }
    if (typeof this._opts.onEvent === 'function') {
      try {
        this._opts.onEvent(name, detail);
      } catch (e) {
        // ignore
      }
    }
  }

  // ----------------------------------------------------------------
  // Internal: cleanup
  // ----------------------------------------------------------------

  _flushRemovals() {
    if (!this._pendingRemoval.length) return;
    for (const mob of this._pendingRemoval) {
      if (this._scene && mob.group && typeof this._scene.remove === 'function') {
        try { this._scene.remove(mob.group); } catch (e) { /* ignore */ }
      }
      if (mob.billboard && typeof mob.billboard.dispose === 'function') {
        try { mob.billboard.dispose(); } catch (e) { /* ignore */ }
      }
      const idx = this._mobs.indexOf(mob);
      if (idx !== -1) this._mobs.splice(idx, 1);
    }
    this._pendingRemoval.length = 0;
  }

  _despawnAll() {
    for (const mob of this._mobs) {
      if (this._scene && mob.group && typeof this._scene.remove === 'function') {
        try { this._scene.remove(mob.group); } catch (e) { /* ignore */ }
      }
      if (mob.billboard && typeof mob.billboard.dispose === 'function') {
        try { mob.billboard.dispose(); } catch (e) { /* ignore */ }
      }
    }
    this._mobs = [];
    this._pendingRemoval = [];
  }
}

export default MobManager;
