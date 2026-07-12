// tests-plus/physics.test.mjs
//
// node:test coverage for the REAL player-physics stack (per TEST RECON):
//   public/src/gameplay/physics.js -> { moveAndCollide, isInLiquid }
//   public/src/gameplay/Player.js  -> { Player }
//   public/src/gameplay/raycast.js -> { raycastVoxel }   (reach / edit-reach)
//   public/src/blocks/blocks.js    -> { getBlockDef }
// All pure — no `three`, no DOM. Integration lives in Player.update(dt,input,yaw).
//
// This file PINS the shipped code's real numbers (regression pins that PASS)
// AND, in clearly-labelled separate checks, compares them to the design-spec
// values (docs/PARITY.md §8A.1 / MULTIPLAYER_PROTOCOL §0). The shipped model
// is continuous (blocks/s^2, dt-integrated) with constants DERIVED from the
// tick-based spec via SIM_HZ = 20 (b/tick -> b/s = *20 ; b/tick^2 -> b/s^2 =
// *400): the spec-alignment pass reconciled gravity/jump/terminal/walk/
// sprint/sneak, added STEP_HEIGHT 0.6 auto-step, and unified reach at 6, and
// a follow-up flipped flight to the spec's SPEED_FLY 10.89 (sprint-fly keeps
// the 2x ratio: 21.78), so ALL NINE former SPEC-DELTA skips now RUN and PASS.
//
// FEATURE-DETECT / SKIP GUARD: on the feature/ci branch the game tree
// (public/src/...) is absent, so every real module is dynamic-imported inside
// a try/catch. If any import fails the whole file self-skips with one skipped
// test instead of crashing, so `node --test tests-plus/` stays green when the
// game code is not present. In the game worktree
// (origin/feat/voxel-sandbox-game, where tests-plus/ sits next to public/) the
// real assertions run.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- Feature-detect the real modules ---------------------------------------
let Player = null;
let moveAndCollide = null;
let isInLiquid = null;
let raycastVoxel = null;
let getBlockDef = null;
let loadError = null;

try {
  const [physMod, playerMod, rayMod, blockMod] = await Promise.all([
    import('../public/src/gameplay/physics.js'),
    import('../public/src/gameplay/Player.js'),
    import('../public/src/gameplay/raycast.js'),
    import('../public/src/blocks/blocks.js'),
  ]);
  moveAndCollide = physMod.moveAndCollide;
  isInLiquid = physMod.isInLiquid;
  Player = playerMod.Player;
  raycastVoxel = rayMod.raycastVoxel;
  getBlockDef = blockMod.getBlockDef;
  if (typeof Player !== 'function' || typeof moveAndCollide !== 'function' ||
      typeof raycastVoxel !== 'function' || typeof getBlockDef !== 'function') {
    throw new Error('physics/Player/raycast/blocks exports not callable');
  }
} catch (err) {
  loadError = err;
}

// ---- Shared simulation constants -------------------------------------------
const DT = 1 / 60;            // fixed frame step used for every simulation
const SIM_HZ = 20;            // spec tick rate, for b/tick -> b/s conversions
const GROUND_Y = 64;          // floor top plane in the mock worlds

// Design-spec values (docs/MULTIPLAYER_PROTOCOL.md §0), converted to blocks/s.
const SPEC = {
  SPEED_WALK: 4.317,
  SPEED_SPRINT: 5.612,
  SPEED_SNEAK: 1.295,
  SPEED_FLY: 10.89,
  GRAVITY: -0.08 * SIM_HZ * SIM_HZ,   // -0.08 b/tick^2 -> -32 b/s^2
  TERMINAL: -3.92 * SIM_HZ,           // -3.92 b/tick   -> -78.4 b/s
  JUMP_VY: 0.42 * SIM_HZ,             //  0.42 b/tick   ->  8.4  b/s
  EDIT_REACH_BLOCKS: 6,
  STEP_HEIGHT: 0.6,
};

// ---- Test-body helpers (only referenced inside the non-skipped branch) -----
const NO_INPUT = {
  forward: false, back: false, left: false, right: false,
  jump: false, sprint: false, sneak: false, sneakOrDescend: false,
};
const inp = (over) => ({ ...NO_INPUT, ...over });
const makeCamera = () => ({ position: { set() {} } });

// First solid block id (derived from the real registry so the mock worlds do
// not hard-code a specific id).
function firstSolidId() {
  for (let id = 1; id <= 40; id++) {
    try { if (getBlockDef(id)?.solid) return id; } catch { /* keep scanning */ }
  }
  return 3; // stone fallback
}

if (loadError) {
  test('physics: real modules not importable — skipped (TODO)', { skip: true }, () => {
    // Runs for real only in the game worktree (origin/feat/voxel-sandbox-game)
    // where public/src/gameplay/{physics,Player,raycast}.js and
    // public/src/blocks/blocks.js are present. On feature/ci the game tree is
    // absent, so this file self-skips.
    // Import error was: ${loadError && loadError.message}
  });
} else {
  const SOLID = firstSolidId();

  // Worlds: getBlock(x,y,z) -> block id. Player physics only reads solidity.
  const airWorld = { getBlock: () => 0 };
  const groundWorld = { getBlock: (x, y, z) => (y < GROUND_Y ? SOLID : 0) };
  // A 1-tall (top=65) or 2-tall (top=66) ledge occupying cells x>=1, on top of
  // the flat floor; used to probe auto-step behavior when walking +x.
  const stepWorld = (topY) => ({
    getBlock: (x, y, z) => {
      if (y < GROUND_Y) return SOLID;
      if (x >= 1 && y < topY) return SOLID;
      return 0;
    },
  });

  const makePlayer = (world) => new Player(world, makeCamera());
  // Hard-set the player state (bypasses respawn()'s column scan).
  function place(p, x, y, z) {
    p.position = { x, y, z };
    p.velocity = { x: 0, y: 0, z: 0 };
    p.onGround = false;
    p.flying = false;
    p.sneaking = false;
  }

  // Steady-state horizontal ground speed (blocks/s) for a given input.
  function groundSpeed(over) {
    const p = makePlayer(groundWorld);
    place(p, 8.2, GROUND_Y, 8.2);
    const i = inp({ forward: true, ...over });
    for (let k = 0; k < 200; k++) p.update(DT, i, 0);   // reach steady state
    const x0 = p.position.x, z0 = p.position.z;
    p.update(DT, i, 0);
    return Math.hypot(p.position.x - x0, p.position.z - z0) / DT;
  }

  // Steady-state horizontal FLY speed (blocks/s) — flight holds altitude.
  function flySpeed(over) {
    const p = makePlayer(airWorld);
    place(p, 8.2, 200, 8.2);
    p.flying = true;
    const i = inp({ forward: true, ...over });
    for (let k = 0; k < 150; k++) { p.flying = true; p.update(DT, i, 0); }
    const x0 = p.position.x, z0 = p.position.z;
    p.flying = true;
    p.update(DT, i, 0);
    return Math.hypot(p.position.x - x0, p.position.z - z0) / DT;
  }

  // Raycast reach probe: wall at cell x===cell, ray from (0.5,0.5,0.5) toward
  // +x. Returns whether it hits (within maxDist; default when md==null).
  function reachHits(md, cell) {
    const w = { getBlock: (x, y, z) => (x === cell ? SOLID : 0) };
    const o = { x: 0.5, y: 0.5, z: 0.5 };
    const d = { x: 1, y: 0, z: 0 };
    const r = md == null ? raycastVoxel(w, o, d) : raycastVoxel(w, o, d, md);
    return !!(r && r.hit);
  }

  // =========================================================================
  // GRAVITY  (code: GRAVITY = -32 blocks/s^2 — spec -0.08 b/tick^2 @20Hz)
  // Second difference of free-fall position = g*dt^2 exactly (constant accel),
  // independent of integration order.
  // =========================================================================

  function measureGravity() {
    const p = makePlayer(airWorld);
    place(p, 0, 5000, 0);            // high up, well above terminal velocity
    p.update(DT, NO_INPUT, 0);       // two warmup steps past construction transient
    p.update(DT, NO_INPUT, 0);
    const y0 = p.position.y;
    p.update(DT, NO_INPUT, 0); const y1 = p.position.y;
    p.update(DT, NO_INPUT, 0); const y2 = p.position.y;
    return (y2 - 2 * y1 + y0) / (DT * DT);
  }

  test('gravity: free-fall acceleration is -32 b/s^2 (regression pin)', () => {
    const g = measureGravity();
    assert.ok(Math.abs(g - (-32)) < 0.01, `gravity ${g} should pin to -32 b/s^2`);
    assert.ok(g < 0, 'gravity pulls down');
  });

  test('gravity: SPEC — -0.08 b/tick^2 (-32 b/s^2)', () => {
    const g = measureGravity();
    assert.ok(Math.abs(g - SPEC.GRAVITY) < 0.1,
      `code gravity ${g} b/s^2 != spec ${SPEC.GRAVITY} b/s^2 (-0.08 b/tick^2 @${SIM_HZ}Hz)`);
  });

  // =========================================================================
  // JUMP  (code: JUMP_VELOCITY = 8.4 b/s — spec 0.42 b/tick; only when onGround)
  // Right after the jump tick, velocity.y holds the raw launch speed (rising,
  // so no vertical collision zeroes it) — an exact read of the constant.
  // =========================================================================

  function jumpLaunchVy() {
    const p = makePlayer(groundWorld);
    place(p, 8.2, GROUND_Y, 8.2);
    p.update(DT, NO_INPUT, 0);              // settle onGround
    assert.ok(p.onGround, 'player is on the ground before jumping');
    p.update(DT, inp({ jump: true }), 0);   // jump tick
    return p.velocity.y;
  }

  test('jump: launch velocity is exactly 8.4 b/s (regression pin)', () => {
    const vy = jumpLaunchVy();
    assert.ok(Math.abs(vy - 8.4) < 1e-9, `jump launch vy ${vy} should pin to 8.4 b/s`);
  });

  test('jump: SPEC — 0.42 b/tick (8.4 b/s)', () => {
    const vy = jumpLaunchVy();
    assert.ok(Math.abs(vy - SPEC.JUMP_VY) < 0.05,
      `code jump vy ${vy} b/s != spec ${SPEC.JUMP_VY} b/s (0.42 b/tick @${SIM_HZ}Hz)`);
  });

  test('jump: onGround gate — no launch while airborne', () => {
    const p = makePlayer(airWorld);
    place(p, 0, 500, 0);                 // in the air, never onGround
    p.update(DT, NO_INPUT, 0);
    assert.equal(p.onGround, false);
    const before = p.velocity.y;
    p.update(DT, inp({ jump: true }), 0);
    // Jump ignored: vertical velocity keeps accelerating downward, not upward.
    assert.ok(p.velocity.y < before + 1e-9, 'airborne jump does not add upward velocity');
    assert.ok(p.velocity.y < 0, 'still falling');
  });

  // =========================================================================
  // JUMP PEAK  (computed by integrating step(dt) until the apex)
  // Analytic v^2/(2|g|) = 8.4^2/64 ~= 1.103; the semi-implicit integrator
  // overshoots slightly to ~1.17. Pin the integrated peak.
  // =========================================================================

  function jumpPeakHeight() {
    const p = makePlayer(groundWorld);
    place(p, 8.2, GROUND_Y, 8.2);
    p.update(DT, NO_INPUT, 0);
    const groundY = p.position.y;
    p.update(DT, inp({ jump: true }), 0);
    let peak = p.position.y;
    for (let k = 0; k < 300; k++) {           // rise to apex, then fall + land
      p.update(DT, NO_INPUT, 0);
      if (p.position.y > peak) peak = p.position.y;
    }
    return peak - groundY;
  }

  test('jump peak: integrated apex is ~1.17 blocks above launch (regression pin)', () => {
    const peak = jumpPeakHeight();
    assert.ok(peak > 1.10 && peak < 1.30, `jump peak ${peak} should be ~1.17 blocks`);
    // The apex is consistent with the spec launch speed (v0=8.4, g=32).
    const impliedV0 = Math.sqrt(2 * 32 * peak);
    assert.ok(Math.abs(impliedV0 - 8.62) < 0.25,
      `apex implies launch v0 ${impliedV0} ~= 8.62 (discrete overshoot of 8.4)`);
  });

  // =========================================================================
  // HORIZONTAL SPEEDS (spec-aligned)
  //   WALK   = 4.317              (spec SPEED_WALK)
  //   SPRINT = 4.317*1.3 ~= 5.612 (spec SPEED_SPRINT)
  //   SNEAK  = 4.317*0.3 ~= 1.295 (spec SPEED_SNEAK; sneak cancels sprint)
  //   FLY    = 10.89 / 21.78 sprint (spec SPEED_FLY; sprint-fly keeps 2x)
  // On ground / flying, velocity snaps to the wish dir, so steady-state
  // displacement/dt equals the target speed exactly.
  // =========================================================================

  test('walk speed: 4.317 b/s (regression pin) + steady-state simulation', () => {
    const v = groundSpeed({});
    assert.ok(Math.abs(v - 4.317) < 0.01, `walk speed ${v} should pin to 4.317 b/s`);
  });
  test('walk speed: SPEC — SPEED_WALK 4.317', () => {
    const v = groundSpeed({});
    assert.ok(Math.abs(v - SPEC.SPEED_WALK) < 0.001,
      `code walk ${v} != spec SPEED_WALK ${SPEC.SPEED_WALK}`);
  });

  test('sprint speed: ~5.612 b/s (regression pin) + steady-state simulation', () => {
    const v = groundSpeed({ sprint: true });
    assert.ok(Math.abs(v - 5.612) < 0.01, `sprint speed ${v} should pin to ~5.612 b/s`);
  });
  test('sprint speed: SPEC — SPEED_SPRINT 5.612', () => {
    const v = groundSpeed({ sprint: true });
    assert.ok(Math.abs(v - SPEC.SPEED_SPRINT) < 0.001,
      `code sprint ${v} != spec SPEED_SPRINT ${SPEC.SPEED_SPRINT}`);
  });

  test('sneak speed: ~1.295 b/s (regression pin) + sneak cancels sprint', () => {
    const v = groundSpeed({ sneak: true });
    assert.ok(Math.abs(v - 1.295) < 0.01, `sneak speed ${v} should pin to ~1.295 b/s`);
    const vBoth = groundSpeed({ sneak: true, sprint: true });
    assert.ok(Math.abs(vBoth - 1.295) < 0.01, `sneak cancels sprint: ${vBoth} == 1.295`);
  });
  test('sneak speed: SPEC — SPEED_SNEAK 1.295', () => {
    const v = groundSpeed({ sneak: true });
    assert.ok(Math.abs(v - SPEC.SPEED_SNEAK) < 0.001,
      `code sneak ${v} != spec SPEED_SNEAK ${SPEC.SPEED_SNEAK}`);
  });

  test('fly speed: 10.89 b/s, sprint-fly 21.78 b/s (regression pin) + simulation', () => {
    const v = flySpeed({});
    assert.ok(Math.abs(v - 10.89) < 0.02, `fly speed ${v} should pin to 10.89 b/s`);
    const vs = flySpeed({ sprint: true });
    assert.ok(Math.abs(vs - 21.78) < 0.03, `sprint-fly speed ${vs} should pin to 21.78 b/s`);
  });
  test('fly speed: SPEC — SPEED_FLY 10.89', () => {
    const v = flySpeed({});
    assert.ok(Math.abs(v - SPEC.SPEED_FLY) < 0.001,
      `code fly ${v} != spec SPEED_FLY ${SPEC.SPEED_FLY}`);
  });

  // =========================================================================
  // TERMINAL VELOCITY  (code: TERMINAL_FALL_SPEED = 78.4 b/s — spec -3.92 b/tick)
  // Long fall clamps downward velocity; steady-state displacement/dt = -78.4.
  // =========================================================================

  function terminalVy() {
    const p = makePlayer(airWorld);
    place(p, 0, 5000, 0);
    for (let k = 0; k < 600; k++) p.update(DT, NO_INPUT, 0); // >> time to clamp
    const y0 = p.position.y;
    p.update(DT, NO_INPUT, 0);
    return (p.position.y - y0) / DT;
  }

  test('terminal velocity: fall speed clamps at -78.4 b/s (regression pin)', () => {
    const vt = terminalVy();
    assert.ok(Math.abs(vt - (-78.4)) < 0.05, `terminal vy ${vt} should clamp to -78.4 b/s`);
    // Also assert the clamp holds on the stored velocity, not just position.
    const p = makePlayer(airWorld);
    place(p, 0, 5000, 0);
    for (let k = 0; k < 600; k++) p.update(DT, NO_INPUT, 0);
    assert.ok(p.velocity.y >= -78.4 - 1e-6, `velocity.y ${p.velocity.y} never exceeds -78.4`);
    assert.ok(Math.abs(p.velocity.y - (-78.4)) < 1e-6, 'velocity.y pinned at exactly -78.4');
  });

  test('terminal velocity: SPEC — -3.92 b/tick (-78.4 b/s)', () => {
    const vt = terminalVy();
    assert.ok(Math.abs(vt - SPEC.TERMINAL) < 0.1,
      `code terminal ${vt} b/s != spec ${SPEC.TERMINAL} b/s (-3.92 b/tick @${SIM_HZ}Hz)`);
  });

  // =========================================================================
  // STEP-UP  (code: STEP_HEIGHT = 0.6, per spec)
  // The palette is full blocks only, so a ground-level obstacle top is always
  // feet + 1.0 > 0.6: walking +x into a 1- or 2-block ledge still blocks the
  // player flush (regression pins below). The 0.6 boundary itself is
  // exercised with a stub world whose getBlockDef override models a
  // partial-height (collisionHeight 0.6) cell — the spec-boundary obstacle
  // IS stepped, smoothly, with onGround preserved.
  // =========================================================================

  // Walk +x (yaw = -PI/2 makes "forward" point toward +x) into a ledge whose
  // top is at `topY`, and report whether the player climbed onto it.
  function climbsStep(topY) {
    const p = makePlayer(stepWorld(topY));
    place(p, 0, GROUND_Y, 0.3);
    p.update(DT, NO_INPUT, 0);
    const groundY = p.position.y;
    const yaw = -Math.PI / 2;
    for (let k = 0; k < 120; k++) p.update(DT, inp({ forward: true }), yaw);
    return { climbed: p.position.y > groundY + 0.4, x: p.position.x, y: p.position.y };
  }

  test('step-up: a 1-block ledge is NOT auto-climbed (1.0 > STEP_HEIGHT 0.6)', () => {
    const r = climbsStep(GROUND_Y + 1);
    assert.equal(r.climbed, false, `1-block step must block (1.0 > 0.6); got y=${r.y}`);
    assert.ok(r.x < 1, `player is stopped flush before the ledge (x=${r.x} < 1)`);
    assert.ok(Math.abs(r.y - (GROUND_Y + 0.000001)) < 0.05, 'player stayed at floor height');
  });

  test('step-up: a 2-block ledge is NOT climbable (regression pin)', () => {
    const r = climbsStep(GROUND_Y + 2);
    assert.equal(r.climbed, false, `2-block step must block; got y=${r.y}`);
    assert.ok(r.x < 1, 'player stopped flush before the 2-block ledge');
  });

  test('step-up: SPEC — STEP_HEIGHT 0.6 obstacle IS auto-stepped', () => {
    // Spec §8A.1: climb ledges <= 0.6 without jumping. A full 1-block ledge is
    // 1.0 > 0.6 and must NOT step (pinned above) — the original spec-delta
    // assertion that a 1-block ledge climbs contradicted the 0.6 spec value
    // itself, so this activation asserts the EXACT boundary instead, via a
    // partial-height (collisionHeight 0.6) stub cell.
    const LOW = 99;
    const lowDef = { solid: true, liquid: false, collisionHeight: SPEC.STEP_HEIGHT };
    const world = {
      getBlock: (x, y, z) => {
        if (y < GROUND_Y) return SOLID;
        if (x >= 1 && y === GROUND_Y) return LOW;
        return 0;
      },
      getBlockDef: (id) => (id === LOW ? lowDef : getBlockDef(id)),
    };
    const p = makePlayer(world);
    place(p, 0, GROUND_Y, 0.3);
    p.update(DT, NO_INPUT, 0);
    const yaw = -Math.PI / 2; // forward -> +x
    for (let k = 0; k < 120; k++) p.update(DT, inp({ forward: true }), yaw);
    assert.ok(Math.abs(p.position.y - (GROUND_Y + SPEC.STEP_HEIGHT)) < 0.01,
      `player stepped onto the 0.6 obstacle (y=${p.position.y})`);
    assert.ok(p.position.x > 1, `horizontal motion continued past the ledge (x=${p.position.x})`);
    assert.equal(p.onGround, true, 'onGround preserved across the step');

    // Guard: sneaking must NOT auto-step (edge-guard semantics own sneaking).
    const q = makePlayer(world);
    place(q, 0, GROUND_Y, 0.3);
    q.update(DT, NO_INPUT, 0);
    for (let k = 0; k < 240; k++) q.update(DT, inp({ forward: true, sneak: true }), yaw);
    assert.ok(Math.abs(q.position.y - GROUND_Y) < 0.05,
      `sneaking player did not step up (y=${q.position.y})`);
    assert.ok(q.position.x < 1, `sneaking player blocked flush before the ledge (x=${q.position.x})`);
  });

  // =========================================================================
  // REACH / EDIT-REACH  (raycastVoxel default maxDist = 6 = spec
  // EDIT_REACH_BLOCKS; the server's MAX_REACH is the SAME 6 — one unified
  // value, closing the old client-5/server-7 anticheat gap.)
  // =========================================================================

  test('reach: default block reach is 6 blocks (regression pin)', () => {
    // near face of cell 6 is 5.5 away -> hit; cell 7 is 6.5 away -> miss.
    assert.equal(reachHits(null, 6), true, 'wall 5.5 away is within default reach 6');
    assert.equal(reachHits(null, 7), false, 'wall 6.5 away is beyond default reach 6');
  });

  test('reach: explicit maxDist still overrides the default', () => {
    assert.equal(reachHits(4, 4), true, 'explicit maxDist 4 hits a wall 3.5 away');
    assert.equal(reachHits(4, 5), false, 'explicit maxDist 4 misses a wall 4.5 away');
    assert.equal(reachHits(7, 7), true, 'explicit maxDist 7 hits a wall 6.5 away');
  });

  test('reach: SPEC — EDIT_REACH_BLOCKS 6 (client default == server MAX_REACH)', () => {
    assert.equal(reachHits(null, SPEC.EDIT_REACH_BLOCKS), true,
      `spec EDIT_REACH_BLOCKS ${SPEC.EDIT_REACH_BLOCKS}: default reach hits cell ${SPEC.EDIT_REACH_BLOCKS}`);
    assert.equal(reachHits(null, SPEC.EDIT_REACH_BLOCKS + 1), false,
      'one block past the unified reach misses');
  });

  // =========================================================================
  // moveAndCollide + isInLiquid — direct low-level sanity (velocity mutated,
  // collided axis zeroed; liquid detection). Grounds the world assumptions.
  // =========================================================================

  test('moveAndCollide: landing on a floor zeroes vy and reports onGround', () => {
    // Start just above the floor so a single -50 b/s step (~0.83 b) lands.
    const aabb = { pos: { x: 8.2, y: GROUND_Y + 0.3, z: 8.2 }, size: { x: 0.6, y: 1.8, z: 0.6 } };
    const vel = { x: 0, y: -50, z: 0 };
    const res = moveAndCollide(groundWorld, aabb, vel, DT);
    assert.equal(res.onGround, true, 'downward move onto floor reports onGround');
    assert.equal(vel.y, 0, 'collided vertical axis is zeroed in-place');
    assert.ok(res.position.y >= GROUND_Y - 1e-3, 'came to rest at/above the floor plane');
  });

  test('isInLiquid: dry air world is not liquid', () => {
    const aabb = { pos: { x: 0, y: 100, z: 0 }, size: { x: 0.6, y: 1.8, z: 0.6 } };
    assert.equal(isInLiquid(airWorld, aabb), false, 'no liquid cells overlap in an all-air world');
  });
}
