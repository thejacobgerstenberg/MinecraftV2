// ============================================================================
// mobs/MobManager.js
//
// Default export: class MobManager extends EventTarget.
//
// Owns spawning, AI, physics stepping, and animation-driving for all Loomfall
// creature instances (grazer/Skeinling, groaner/Understruck, exploder/Waxling,
// screecher/Slagmoth, trader/Wickerkin, bobbindeer/Bobbin-deer,
// frayedhound/Frayed Hound, emberspinner/Emberspinner, unpicked/The Unpicked,
// needlejack/Needlejack, scaldwarden/Scaldwarden, raveler/Raveler, and the
// lastneedle/The Last Needle boss). Creature *visuals* come from
// ./creatures/<archetype>.js (owned by other agents) via their `build()` /
// `meta` exports — this file only ever calls that contract, never reaches
// into their internals beyond root.userData.headAnchor / root.userData.animate.
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
//
// Events (CustomEvent via EventTarget, AND opts.onEvent(name, detail)). Every
// event detail below includes both `archetype` (spawn-table slot key) AND
// `canonicalId` (spawnRules.canonicalIdFor(archetype) / mob.canonicalId --
// the stable snake_case entity id, e.g. 'last_needle') so downstream code
// can match against canonical entity ids (e.g. the boss victory trigger is
// 'kill_entity:last_needle'):
//   'mobSpawn', 'mobHurt', 'mobDeath', 'mobAttack', 'mobDrop', 'mobDespawn',
//   'bossDefeated'
//
//   'mobDrop'      { mobId, archetype, canonicalId, itemId, pos:{x,y,z},
//                  count } -- emitted once per dropped stack, right after
//                  'mobDeath'. Computed via lootTables.rollLoot(archetype,
//                  rng). Never emitted for a boss mob (see 'bossDefeated');
//                  archetypes with an empty loot table (unpicked, and the
//                  boss's own table) naturally produce zero 'mobDrop'
//                  events since rollLoot() returns [].
//   'mobDespawn'   { archetype, canonicalId, species, mob, position } --
//                  ambient distance/age despawn (spawnRules.shouldDespawn);
//                  quiet, no loot.
//   'bossDefeated' { archetype, canonicalId, species, mob, position,
//                  bound:true, victoryTrigger, achievement } -- emitted
//                  INSTEAD OF 'mobDeath' when a boss mob's hp reaches 0.
//                  The boss is bound, not killed, and has no loot table, so
//                  NO 'mobDrop' is ever emitted for it. victoryTrigger
//                  (e.g. 'kill_entity:last_needle') and achievement (e.g.
//                  'taught_to_mend') let the builder wire the win
//                  condition/ending without hardcoding archetype strings.
// ============================================================================

import * as THREE from 'three';
import { getBlockDef as fallbackGetBlockDef } from './blocksAdapter.js';
import * as AI from './ai.js';
import { pickSpawn, maxAliveFor, normalizeDimension, DESPAWN_CONFIG, shouldDespawn, canonicalIdFor } from './spawnRules.js';
import { rollLoot } from './lootTables.js';

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

  // Scaldwarden: neutral Cinderloom guardian, reuses 'trader' AI (idles /
  // tethers near its post, never initiates an attack -- the "passive
  // unless provoked" retaliation behaviour is out of scope for this sim's
  // AI set, so it's simplified down to a stationary neutral like trader;
  // see DESPAWN_CONFIG.exemptArchetypes, it's also despawn-exempt).
  // canon: hp40 dmg6 spd3 (contactDamage stored for future provoke logic).
  scaldwarden: {
    aiBase: 'trader',
    maxHp: 40,
    halfWidth: 0.4, height: 1.5,
    speed: 3,
    hostile: false, flies: false,
    tetherRadius: 5,
    contactDamage: 6,
  },

  // Raveler: fast Nevermend hostile, reuses 'groaner' AI. canon: hp18 dmg5
  // spd8 (FAST -- summoned by the Last Needle as "a Shed of Ravelers").
  raveler: {
    aiBase: 'groaner',
    maxHp: 18,
    halfWidth: 0.35, height: 1.1,
    speed: 4.0, seekSpeed: 8,
    hostile: true, flies: false,
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
  // canon: hp600(sim) dmg14, phase thresholds 60%/15%. NOTE: canonical
  // content is internally inconsistent between sources here -- the
  // bestiary lists 600 hp while boss.json lists 800 hp with a separate
  // "stitching" mechanic; this sim uses a simplified raw-hp 3-phase model
  // (maxHp:600) purely as a visualization, per the canon table supplied
  // for this reconciliation. No canon `spd` figure was supplied for the
  // boss, so its speed/seekSpeed/phaseSpeedMul are left as previously
  // tuned. dmg14 already matched the existing phaseAttackDamage[2] value.
  lastneedle: {
    aiBase: 'boss',
    isBoss: true,
    maxHp: 600,
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
      spawnedBy: null,       // set by _aiLastNeedle when this mob is a boss-summoned add
      dead: false,
      _moving: false,
      _navVy: 0,             // scratch: flyerAvoid's suggested vy for this tick
      hurt: null, // assigned below
    };
    mob.hurt = (dmg) => this._hurtMob(mob, dmg);

    this._mobs.push(mob);
    this._emit('mobSpawn', {
      archetype,
      canonicalId: mob.canonicalId,
      species: mob.species,
      mob,
      position: { ...mob.position },
    });

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
  // Public: required contract methods
  // ----------------------------------------------------------------

  /** update(dt): step spawning, AI, physics, and animation for one frame. */
  update(dt) {
    if (typeof dt !== 'number' || !Number.isFinite(dt) || dt <= 0) return;
    const clampedDt = Math.min(dt, MAX_DT);
    this._elapsed += clampedDt;

    this._trySpawn(clampedDt);

    const playerPos = safeCall(this._opts.getPlayerPos, null);

    for (const mob of this._mobs) {
      if (mob.dead) continue;
      mob.ageSeconds = (mob.ageSeconds || 0) + clampedDt;
      this._updateMobAI(mob, clampedDt, playerPos);
      if (mob.dead) continue; // e.g. exploder detonated mid-AI-step
      this._updateMobPhysics(mob, clampedDt);
      this._animateMob(mob, clampedDt);
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
      let despawn;
      try {
        despawn = shouldDespawn(mob, playerPos, DESPAWN_CONFIG);
      } catch (e) {
        despawn = false;
      }
      if (despawn) this._despawnMob(mob);
    }
  }

  /** Quiet removal: no mobDeath, no loot -- just an optional 'mobDespawn'. */
  _despawnMob(mob) {
    if (!mob || mob.dead) return;
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
    const aiBase = config.aiBase || mob.archetype;
    switch (aiBase) {
      case 'grazer': return this._aiGrazer(mob, dt, playerPos);
      case 'trader': return this._aiTrader(mob, dt, playerPos);
      case 'groaner': return this._aiGroaner(mob, dt, playerPos);
      case 'exploder': return this._aiExploder(mob, dt, playerPos);
      case 'screecher': return this._aiScreecher(mob, dt, playerPos);
      case 'boss': return this._aiLastNeedle(mob, dt, playerPos);
      default: return this._aiWanderOnly(mob, dt);
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

  // Hostile: wanders until player in aggro range, seeks, attacks on contact.
  // Reused (via aiBase:'groaner') by frayedhound/emberspinner/unpicked --
  // ARCHETYPE_CONFIG[mob.archetype] pulls each archetype's own tuning.
  _aiGroaner(mob, dt, playerPos) {
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    mob.attackCooldownTimer = Math.max(0, mob.attackCooldownTimer - dt);

    const dist = AI.horizontalDistance(mob.position, playerPos);
    if (dist <= (config.aggroRange ?? 8)) {
      if (dist <= (config.attackRange ?? 0.9)) {
        mob.velocity.x = 0;
        mob.velocity.z = 0;
        mob._moving = false;
        if (mob.attackCooldownTimer <= 0) {
          mob.attackCooldownTimer = config.attackCooldown ?? 1.0;
          this._doAttack(mob, config.contactDamage ?? 1);
        }
      } else {
        const steer = AI.seekSteer(mob.position, playerPos, config.seekSpeed ?? config.speed);
        this._steerGroundedHostile(mob, config, steer);
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
      } else {
        const steer = AI.seekSteer(mob.position, playerPos, config.speed);
        this._steerGroundedHostile(mob, config, steer);
        mob.fuse = Math.max(0, mob.fuse - dt * 0.5); // cools while out of fuse range
      }
    } else {
      this._aiWanderOnly(mob, dt);
      mob.fuse = Math.max(0, mob.fuse - dt * 0.5);
    }
  }

  // Hostile-ish flyer: hovers, drifts toward the player, attacks on contact.
  _aiScreecher(mob, dt, playerPos) {
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    mob.attackCooldownTimer = Math.max(0, mob.attackCooldownTimer - dt);

    const dist = AI.horizontalDistance(mob.position, playerPos);
    if (dist <= (config.aggroRange ?? 10)) {
      if (dist <= (config.attackRange ?? 1.2)) {
        this._steerFlyer(mob, { vx: 0, vz: 0, moving: true }); // still hovers/flaps in place
        if (mob.attackCooldownTimer <= 0) {
          mob.attackCooldownTimer = config.attackCooldown ?? 1.2;
          this._doAttack(mob, config.contactDamage ?? 2);
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
      if (mob.attackCooldownTimer <= 0) {
        mob.attackCooldownTimer = cooldown;
        const dmg = (config.phaseAttackDamage && config.phaseAttackDamage[phase])
          ?? config.contactDamage ?? 6;
        this._doAttack(mob, dmg);
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

  _animateMob(mob, dt) {
    if (mob.hurtTimer > 0) {
      mob.hurtTimer = Math.max(0, mob.hurtTimer - dt / HURT_FLASH_DURATION);
    }
    if (mob.attackFlash > 0) {
      mob.attackFlash = Math.max(0, mob.attackFlash - dt / ATTACK_FLASH_DURATION);
    }
    const state = {
      moving: !!mob._moving,
      grounded: !!mob.grounded,
      fuse: mob.fuse || 0,
      hurt: mob.hurtTimer || 0,
      attack: mob.attackFlash || 0,
      phase: mob.bossPhase || 0,
      dimension: this.dimension,
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

    this._emit('mobHurt', {
      archetype: mob.archetype,
      canonicalId: mob.canonicalId,
      species: mob.species,
      mob,
      position: { ...mob.position },
      dmg: amount,
    });

    if ((config.aiBase || mob.archetype) === 'grazer') {
      mob.fleeTimer = config.fleeDuration ?? FLEE_DURATION;
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
    mob.dead = true;
    this._emit('mobDeath', {
      archetype: mob.archetype,
      canonicalId: mob.canonicalId,
      species: mob.species,
      mob,
      position: { ...mob.position },
    });
    this._dropLoot(mob);
    this._pendingRemoval.push(mob);
  }

  /** Boss defeat: 'bossDefeated' instead of 'mobDeath'. The boss's loot
   * table is intentionally empty (bound, not killed -- see lootTables.js),
   * and this never calls _dropLoot for a boss mob, so no 'mobDrop' is ever
   * emitted here even if a future edit accidentally populated one.
   * victoryTrigger/achievement come from ARCHETYPE_CONFIG (falling back to
   * sensible defaults derived from the mob's canonicalId) so the builder
   * can wire the win condition / ending without hardcoding archetype
   * strings. */
  _killBoss(mob) {
    if (!mob || mob.dead) return;
    mob.dead = true;
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    this._emit('bossDefeated', {
      archetype: mob.archetype,
      canonicalId: mob.canonicalId,
      species: mob.species,
      mob,
      position: { ...mob.position },
      bound: true,
      victoryTrigger: config.victoryTrigger || `kill_entity:${mob.canonicalId}`,
      achievement: config.achievement || null,
    });
    this._pendingRemoval.push(mob);
  }

  /** Rolls lootTables.rollLoot(mob.archetype, rng) and emits one 'mobDrop'
   * per resulting stack. Called after mobDeath, never on despawn and never
   * for a boss (see _killBoss). Empty tables (unpicked/lastneedle) simply
   * produce an empty `drops` array, so the loop below emits nothing --
   * no special-casing needed. Defensive against a throwing/misbehaving
   * loot table. */
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
    }
    this._mobs = [];
    this._pendingRemoval = [];
  }
}

export default MobManager;
