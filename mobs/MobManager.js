// ============================================================================
// mobs/MobManager.js
//
// Default export: class MobManager extends EventTarget.
//
// Owns spawning, AI, physics stepping, and animation-driving for all Loomfall
// creature instances (grazer/Skeinling, groaner/Understruck, exploder/Waxling,
// screecher/Slagmoth, trader/Wickerkin). Creature *visuals* come from
// ./creatures/<archetype>.js (owned by other agents) via their `build()` /
// `meta` exports — this file only ever calls that contract, never reaches
// into their internals beyond root.userData.headAnchor / root.userData.animate.
//
// Public API (see bottom of file / README-style summary in the return value
// of the agent that wrote this):
//   new MobManager(scene, world, opts)
//   .update(dt)
//   .setDimension(id)
//   .dispose()
//   .spawn(archetype, pos)   -- addition, force-spawn (demo/tests)
//   .mobs                    -- addition, getter -> array snapshot
//   .setDay(bool)             -- addition, override day/night without opts.isDay
//
// Events (CustomEvent via EventTarget, AND opts.onEvent(name, detail)):
//   'mobSpawn', 'mobHurt', 'mobDeath', 'mobAttack'
// ============================================================================

import * as THREE from 'three';
import { getBlockDef as fallbackGetBlockDef } from './blocksAdapter.js';
import * as AI from './ai.js';
import { pickSpawn, maxAliveFor } from './spawnRules.js';

import { build as buildGrazer, meta as metaGrazer } from './creatures/grazer.js';
import { build as buildGroaner, meta as metaGroaner } from './creatures/groaner.js';
import { build as buildExploder, meta as metaExploder } from './creatures/exploder.js';
import { build as buildScreecher, meta as metaScreecher } from './creatures/screecher.js';
import { build as buildTrader, meta as metaTrader } from './creatures/trader.js';

// ----------------------------------------------------------------------
// Registry: archetype -> { build, meta }
// ----------------------------------------------------------------------
const REGISTRY = {
  grazer: { build: buildGrazer, meta: metaGrazer },
  groaner: { build: buildGroaner, meta: metaGroaner },
  exploder: { build: buildExploder, meta: metaExploder },
  screecher: { build: buildScreecher, meta: metaScreecher },
  trader: { build: buildTrader, meta: metaTrader },
};

// ----------------------------------------------------------------------
// Per-archetype physics/behaviour tuning. AABB sizes are approximate
// (1 unit = 1 block); real visuals may not fill the box exactly, that's
// fine for collision purposes.
// ----------------------------------------------------------------------
const ARCHETYPE_CONFIG = {
  grazer: {
    maxHp: 6,
    halfWidth: 0.3, height: 0.5,
    speed: 1.0, fleeSpeed: 2.4,
    hostile: false, flies: false,
  },
  trader: {
    maxHp: 8,
    halfWidth: 0.3, height: 1.1,
    speed: 0.8,
    hostile: false, flies: false,
    tetherRadius: 5,
  },
  groaner: {
    maxHp: 10,
    halfWidth: 0.3, height: 1.3,
    speed: 0.8, seekSpeed: 1.6,
    hostile: true, flies: false,
    aggroRange: 8, attackRange: 0.9,
    contactDamage: 3, attackCooldown: 1.0,
  },
  exploder: {
    maxHp: 5,
    halfWidth: 0.4, height: 0.6,
    speed: 1.0,
    hostile: true, flies: false,
    aggroRange: 7, fuseRange: 2.0, fuseDuration: 1.5,
    blastRadius: 3.0, blastDamage: 6,
  },
  screecher: {
    maxHp: 6,
    halfWidth: 0.25, height: 0.3,
    speed: 1.3,
    hostile: true, flies: true,
    hoverHeight: 1.3,
    aggroRange: 10, attackRange: 1.2,
    contactDamage: 2, attackCooldown: 1.2,
  },
};

const FLEE_DURATION = 4.0;       // seconds a grazer flees after being hurt
const HURT_FLASH_DURATION = 0.4; // seconds the `hurt` animate flash decays over
const MAX_DT = 0.1;              // clamp huge dt spikes (tab-switch, debugger pause)
const SPAWN_RING_MIN = 6;
const SPAWN_RING_MAX = 16;
const GROUND_SCAN_MAX = 48;

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
   *   isDay?:()=>boolean            -- defaults to always-day (true).
   *   rng?:()=>number                -- defaults to Math.random.
   *   dimension?:string              -- defaults to 'warpwold'.
   *   maxMobs?:number                -- overrides spawnRules' per-dimension cap.
   *   onEvent?:(name,detail)=>void
   */
  constructor(scene, world, opts = {}) {
    super();

    this._scene = scene || null;
    this._world = world || null;
    this._opts = opts && typeof opts === 'object' ? opts : {};

    // getBlockDef injection: prefer opts.getBlockDef; fall back to the
    // local blocksAdapter shim. See blocksAdapter.js header comment.
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

    this.dimension = this._opts.dimension || 'warpwold';
    this._dayOverride = null; // set via setDay(); takes precedence over opts.isDay

    this._mobs = [];
    this._pendingRemoval = [];
    this._nextId = 1;
    this._elapsed = 0;
    this._spawnTimer = 1 + this._rng() * 2; // brief initial delay before first spawn
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
   * spawn-rule weighting/cadence (still counts toward the alive list).
   * Used by demos/tests; also used internally by the spawn scheduler.
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
      // the offset and make screechers climb too high.
      spawnPos: { x: group.position.x, y: baseY, z: group.position.z },
      wander: AI.wanderState(),
      fleeTimer: 0,
      fuse: 0,
      hurtTimer: 0,
      attackCooldownTimer: 0,
      dead: false,
      _moving: false,
      hurt: null, // assigned below
    };
    mob.hurt = (dmg) => this._hurtMob(mob, dmg);

    this._mobs.push(mob);
    this._emit('mobSpawn', {
      archetype,
      species: mob.species,
      mob,
      position: { ...mob.position },
    });

    return mob;
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
      this._updateMobAI(mob, clampedDt, playerPos);
      if (mob.dead) continue; // e.g. exploder detonated mid-AI-step
      this._updateMobPhysics(mob, clampedDt);
      this._animateMob(mob, clampedDt);
    }

    this._flushRemovals();
  }

  /** setDimension(id): despawn everyone, switch rule set, resume spawning. */
  setDimension(id) {
    this._despawnAll();
    this.dimension = id;
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
  // Internal: per-archetype AI
  // ----------------------------------------------------------------

  _updateMobAI(mob, dt, playerPos) {
    switch (mob.archetype) {
      case 'grazer': return this._aiGrazer(mob, dt, playerPos);
      case 'trader': return this._aiTrader(mob, dt, playerPos);
      case 'groaner': return this._aiGroaner(mob, dt, playerPos);
      case 'exploder': return this._aiExploder(mob, dt, playerPos);
      case 'screecher': return this._aiScreecher(mob, dt, playerPos);
      default: return this._aiWanderOnly(mob, dt);
    }
  }

  _aiWanderOnly(mob, dt) {
    const config = ARCHETYPE_CONFIG[mob.archetype] || {};
    const steer = AI.wanderSteer(mob.wander, dt, this._rng, config.speed ?? 1.0);
    mob.velocity.x = steer.vx;
    mob.velocity.z = steer.vz;
    mob._moving = steer.moving;
  }

  // Passive: wanders; flees from the player for a few seconds after being hurt.
  _aiGrazer(mob, dt, playerPos) {
    const config = ARCHETYPE_CONFIG.grazer;
    if (mob.fleeTimer > 0) {
      mob.fleeTimer = Math.max(0, mob.fleeTimer - dt);
      const steer = AI.fleeSteer(mob.position, playerPos, config.fleeSpeed);
      mob.velocity.x = steer.vx;
      mob.velocity.z = steer.vz;
      mob._moving = steer.moving;
    } else {
      this._aiWanderOnly(mob, dt);
    }
  }

  // Neutral: idles near its spawn point (tethered wander), never attacks.
  _aiTrader(mob, dt) {
    const config = ARCHETYPE_CONFIG.trader;
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
  _aiGroaner(mob, dt, playerPos) {
    const config = ARCHETYPE_CONFIG.groaner;
    mob.attackCooldownTimer = Math.max(0, mob.attackCooldownTimer - dt);

    const dist = AI.horizontalDistance(mob.position, playerPos);
    if (dist <= config.aggroRange) {
      if (dist <= config.attackRange) {
        mob.velocity.x = 0;
        mob.velocity.z = 0;
        mob._moving = false;
        if (mob.attackCooldownTimer <= 0) {
          mob.attackCooldownTimer = config.attackCooldown;
          this._doAttack(mob, config.contactDamage);
        }
      } else {
        const steer = AI.seekSteer(mob.position, playerPos, config.seekSpeed ?? config.speed);
        mob.velocity.x = steer.vx;
        mob.velocity.z = steer.vz;
        mob._moving = steer.moving;
      }
    } else {
      this._aiWanderOnly(mob, dt);
    }
  }

  // Hostile: approaches, fuses within fuseRange, detonates at fuse===1.
  _aiExploder(mob, dt, playerPos) {
    const config = ARCHETYPE_CONFIG.exploder;
    const dist = AI.horizontalDistance(mob.position, playerPos);

    if (dist <= config.aggroRange) {
      if (dist <= config.fuseRange) {
        mob.velocity.x = 0;
        mob.velocity.z = 0;
        mob._moving = false;
        mob.fuse = Math.min(1, mob.fuse + dt / config.fuseDuration);
        if (mob.fuse >= 1) {
          this._explode(mob, playerPos);
          return;
        }
      } else {
        const steer = AI.seekSteer(mob.position, playerPos, config.speed);
        mob.velocity.x = steer.vx;
        mob.velocity.z = steer.vz;
        mob._moving = steer.moving;
        mob.fuse = Math.max(0, mob.fuse - dt * 0.5); // cools while out of fuse range
      }
    } else {
      this._aiWanderOnly(mob, dt);
      mob.fuse = Math.max(0, mob.fuse - dt * 0.5);
    }
  }

  // Hostile-ish flyer: hovers, drifts toward the player, attacks on contact.
  _aiScreecher(mob, dt, playerPos) {
    const config = ARCHETYPE_CONFIG.screecher;
    mob.attackCooldownTimer = Math.max(0, mob.attackCooldownTimer - dt);

    const dist = AI.horizontalDistance(mob.position, playerPos);
    if (dist <= config.aggroRange) {
      if (dist <= config.attackRange) {
        mob.velocity.x = 0;
        mob.velocity.z = 0;
        mob._moving = true; // still hovers/flaps in place
        if (mob.attackCooldownTimer <= 0) {
          mob.attackCooldownTimer = config.attackCooldown;
          this._doAttack(mob, config.contactDamage);
        }
      } else {
        // Slow drift toward the player -- deliberately gentler than a
        // ground-hostile's seek speed.
        const steer = AI.seekSteer(mob.position, playerPos, config.speed * 0.6);
        mob.velocity.x = steer.vx;
        mob.velocity.z = steer.vz;
        mob._moving = steer.moving;
      }
    } else {
      const steer = AI.wanderSteer(mob.wander, dt, this._rng, config.speed * 0.5);
      mob.velocity.x = steer.vx;
      mob.velocity.z = steer.vz;
      mob._moving = steer.moving;
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
      mob.position.y += (targetY - mob.position.y) * Math.min(1, dt * 2);
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
    const state = {
      moving: !!mob._moving,
      grounded: !!mob.grounded,
      fuse: mob.fuse || 0,
      hurt: mob.hurtTimer || 0,
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
    safeCall1(this._opts.onPlayerHurt, dmg, undefined);
    this._emit('mobAttack', {
      archetype: mob.archetype,
      species: mob.species,
      mob,
      position: { ...mob.position },
      dmg,
    });
  }

  _explode(mob, playerPos) {
    const config = ARCHETYPE_CONFIG.exploder;
    const dist = AI.horizontalDistance(mob.position, playerPos);
    const hitPlayer = Number.isFinite(dist) && dist <= config.blastRadius;

    this._emit('mobAttack', {
      archetype: mob.archetype,
      species: mob.species,
      mob,
      position: { ...mob.position },
      explosion: true,
      dmg: config.blastDamage,
      hitPlayer,
    });

    if (hitPlayer) {
      safeCall1(this._opts.onPlayerHurt, config.blastDamage, undefined);
    }

    mob.hp = 0;
    this._killMob(mob);
  }

  _hurtMob(mob, dmg) {
    if (!mob || mob.dead) return;
    const amount = Math.max(0, Number.isFinite(dmg) ? dmg : 0);
    mob.hp -= amount;
    mob.hurtTimer = 1.0;

    this._emit('mobHurt', {
      archetype: mob.archetype,
      species: mob.species,
      mob,
      position: { ...mob.position },
      dmg: amount,
    });

    if (mob.archetype === 'grazer') {
      mob.fleeTimer = FLEE_DURATION;
    }

    if (mob.hp <= 0) {
      this._killMob(mob);
    }
  }

  _killMob(mob) {
    if (!mob || mob.dead) return;
    mob.dead = true;
    this._emit('mobDeath', {
      archetype: mob.archetype,
      species: mob.species,
      mob,
      position: { ...mob.position },
    });
    this._pendingRemoval.push(mob);
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
