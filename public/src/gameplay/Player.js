// Voxelheim — player movement controller.
//
// Camera ownership split (important):
//   • Controls owns camera ROTATION (yaw/pitch, rotation.order 'YXZ') and
//     applies it directly on mouse movement.
//   • Player owns camera POSITION only: every update() the camera is placed
//     at the player's eyes = feet + EYE_HEIGHT (1.62), centered on the AABB.
//   Player never writes camera.rotation; Controls never writes
//   camera.position.
//
// Position convention: `player.position` is the MIN corner of the physics
// AABB (0.6 × 1.8 × 0.6) — the same {pos,size} convention physics.js uses.
// "Feet" = position.y; the horizontal center is position.x + 0.3 /
// position.z + 0.3.
//
// This module deliberately avoids importing three so it can also be smoke
// tested under plain node; the camera passed in just needs a
// `.position.set(x,y,z)` method (a THREE.PerspectiveCamera works).

import { moveAndCollide, isInLiquid } from './physics.js';
import { getBlockDef } from '../blocks/blocks.js';
import { CHUNK_SY, SEA_LEVEL } from '../constants.js';

const SIZE = { x: 0.6, y: 1.8, z: 0.6 };
const EYE_HEIGHT = 1.62;
const SNEAK_EYE_DROP = 0.12;   // eyes sit lower while sneaking (1.62 -> 1.50)

// Locomotion constants follow the tick-derived design spec (docs/PARITY.md
// §8A.1, 20 Hz: b/tick × 20 = b/s, b/tick² × 400 = b/s²).
const WALK_SPEED = 4.317;      // blocks/s (spec SPEED_WALK)
const SPRINT_MULT = 1.3;       // ×4.317 ≈ 5.612 blocks/s (spec SPEED_SPRINT)
const SNEAK_MULT = 0.3;        // ×4.317 ≈ 1.295 blocks/s (spec SPEED_SNEAK);
                               // sneaking cancels sprint
const FLY_SPEED = 10;          // deliberately NOT the spec's 10.89 — flight
const FLY_SPRINT_SPEED = 20;   // speeds are a product decision, kept as-is
const GRAVITY = -32;           // blocks/s² (spec −0.08 b/tick² × 400)
const JUMP_VELOCITY = 8.4;     // blocks/s (spec 0.42 b/tick × 20); onGround only
const SPRINT_JUMP_BOOST = 1.2; // forward impulse on the jump tick while sprinting
const TERMINAL_FALL_SPEED = 78.4; // blocks/s cap (spec −3.92 b/tick × 20);
                               // physics substepping is tunnel-free at any speed
const STEP_HEIGHT = 0.6;       // auto step-up onto obstacles this low (spec
                               // step_height; never while sneaking or flying)
const AIR_CONTROL_RATE = 5;    // 1/s — how fast airborne velocity approaches the wish dir
const WATER_SPEED_MULT = 0.5;  // horizontal damping in liquid
const WATER_SINK_SPEED = -2.2; // slow sink terminal velocity
const WATER_SWIM_SPEED = 3.2;  // upward speed while holding jump in liquid
const WATER_VERTICAL_RATE = 6; // 1/s — vertical velocity approach rate in liquid
const KILL_PLANE_Y = -10;      // falling below this respawns
const MAX_DT = 0.1;            // clamp huge frame gaps

export class Player {
  /**
   * @param {{getBlock:(x:number,y:number,z:number)=>number}} world
   * @param {{position:{set:(x:number,y:number,z:number)=>void}}|null} camera
   *        typically a THREE.PerspectiveCamera; Player only sets its position.
   */
  constructor(world, camera) {
    this.world = world;
    this.camera = camera || null;

    /** AABB min corner (feet). */
    this.position = { x: 0, y: 0, z: 0 };
    /** blocks/s */
    this.velocity = { x: 0, y: 0, z: 0 };
    this.onGround = false;
    this.flying = false;
    /** True while walking with input.sneak held (never while flying). */
    this.sneaking = false;
    this.health = 20;
    /** AABB size, min-corner convention (see physics.js). */
    this.size = { ...SIZE };
    /** Spawn point: horizontal CENTER of the player (block column 8,8). */
    this.spawn = { x: 8.5, z: 8.5 };
    /** Optional kill-plane handler: when set, falling below the kill plane
     *  calls it (once per crossing) INSTEAD of the silent auto-respawn, so
     *  the game can route it through the death flow ('void_unravel'). */
    this.onKillPlane = null;

    this.respawn();
  }

  /** Eye position (camera anchor): AABB center in x/z, feet + 1.62 in y
   *  (feet + 1.50 while sneaking — the classic sneak "duck"). */
  get eyePosition() {
    return {
      x: this.position.x + SIZE.x / 2,
      y: this.position.y + this.eyeHeight,
      z: this.position.z + SIZE.z / 2,
    };
  }

  /** Current eye height above the feet: 1.62, or 1.50 while sneaking. */
  get eyeHeight() {
    return EYE_HEIGHT - (this.sneaking ? SNEAK_EYE_DROP : 0);
  }

  /** Toggle creative flight (wired to Controls' double-tap-space event). */
  toggleFlight() {
    this.flying = !this.flying;
    if (this.flying) this.velocity.y = 0;
  }

  /**
   * Respawn at the spawn column: scan down from y = CHUNK_SY-1 (127) for the
   * first solid block and stand on top of it. If the column is all air
   * (e.g. the end void), fall back to SEA_LEVEL. Resets velocity and health.
   */
  respawn() {
    const bx = Math.floor(this.spawn.x);
    const bz = Math.floor(this.spawn.z);
    let groundY = -1;
    for (let y = CHUNK_SY - 1; y >= 0; y--) {
      if (getBlockDef(this.world.getBlock(bx, y, bz)).solid) { groundY = y; break; }
    }
    if (groundY < 0) groundY = SEA_LEVEL; // void column fallback
    this.position.x = this.spawn.x - SIZE.x / 2;
    this.position.z = this.spawn.z - SIZE.z / 2;
    this.position.y = groundY + 1;
    this.velocity.x = 0; this.velocity.y = 0; this.velocity.z = 0;
    this.onGround = true;
    this.health = 20;
  }

  /**
   * Advance the player one frame.
   *
   * @param {number} dt seconds
   * @param {{forward:boolean,back:boolean,left:boolean,right:boolean,
   *          jump:boolean,sprint:boolean,sneak:boolean,
   *          sneakOrDescend?:boolean}} input  from Controls.input.
   *        sprint = ShiftLeft; sneak = KeyC/ControlLeft (slow walk + edge
   *        guard + eye drop, cancels sprint); sneakOrDescend = Shift OR
   *        sneak keys — read as "descend" while flying (falls back to
   *        sneak for harnesses that only set input.sneak).
   * @param {number} yaw radians, from Controls (rotation about +Y; yaw 0
   *        faces -Z, matching THREE's YXZ camera convention).
   */
  update(dt, input, yaw = 0) {
    dt = Math.min(dt, MAX_DT);
    if (dt <= 0) return;

    const aabb = { pos: this.position, size: this.size };
    const inWater = isInLiquid(this.world, aabb);
    const descend = (input.sneakOrDescend ?? false) || input.sneak;
    // Sneaking: walk-mode only (flying reads the same keys as "descend").
    this.sneaking = !this.flying && !!input.sneak;

    // ── Wish direction (horizontal), camera-relative ─────────────────────
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    let wx = 0, wz = 0;
    if (input.forward) { wx -= sin; wz -= cos; }
    if (input.back)    { wx += sin; wz += cos; }
    if (input.left)    { wx -= cos; wz += sin; }
    if (input.right)   { wx += cos; wz -= sin; }
    const wlen = Math.hypot(wx, wz);
    if (wlen > 0) { wx /= wlen; wz /= wlen; }

    let speed;
    if (this.flying) speed = input.sprint ? FLY_SPRINT_SPEED : FLY_SPEED;
    else if (this.sneaking) speed = WALK_SPEED * SNEAK_MULT; // sneak cancels sprint
    else speed = WALK_SPEED * (input.sprint ? SPRINT_MULT : 1);
    if (inWater && !this.flying) speed *= WATER_SPEED_MULT;

    const targetX = wx * speed;
    const targetZ = wz * speed;

    // On ground (or flying) velocity snaps to the wish direction; airborne
    // control is reduced — velocity only eases toward it.
    let control;
    if (this.flying || this.onGround) control = 1;
    else if (inWater) control = Math.min(1, AIR_CONTROL_RATE * 2 * dt);
    else control = Math.min(1, AIR_CONTROL_RATE * dt);
    this.velocity.x += (targetX - this.velocity.x) * control;
    this.velocity.z += (targetZ - this.velocity.z) * control;

    // ── Vertical ─────────────────────────────────────────────────────────
    if (this.flying) {
      // Gravity off; jump ascends, shift descends.
      const vTarget = (input.jump ? speed : 0) + (descend ? -speed : 0);
      this.velocity.y = vTarget;
    } else if (inWater) {
      // Damped: slow sink, hold jump to swim up.
      const vTarget = input.jump ? WATER_SWIM_SPEED : WATER_SINK_SPEED;
      this.velocity.y += (vTarget - this.velocity.y) *
        Math.min(1, WATER_VERTICAL_RATE * dt);
    } else {
      this.velocity.y += GRAVITY * dt;
      // Terminal velocity: cap fall speed at 78.4 b/s (physics substepping
      // is verified tunnel-free at this speed).
      if (this.velocity.y < -TERMINAL_FALL_SPEED) {
        this.velocity.y = -TERMINAL_FALL_SPEED;
      }
      if (input.jump && this.onGround) {
        this.velocity.y = JUMP_VELOCITY;
        // Sprint-jump: a small forward impulse on the jump tick.
        if (input.sprint && !this.sneaking) {
          this.velocity.x *= SPRINT_JUMP_BOOST;
          this.velocity.z *= SPRINT_JUMP_BOOST;
        }
      }
    }

    // ── Sneak edge-guard ─────────────────────────────────────────────────
    // While sneaking on the ground, horizontal movement that would leave the
    // feet AABB without ANY solid support below is clamped per axis (probe
    // the candidate footprint before integrating): you cannot walk off an
    // edge while sneaking.
    if (this.sneaking && this.onGround && !inWater) {
      const dx = this.velocity.x * dt;
      const dz = this.velocity.z * dt;
      if (dx !== 0 &&
          !this._hasSupportAt(this.position.x + dx, this.position.z)) {
        this.velocity.x = 0;
      }
      if (dz !== 0 &&
          !this._hasSupportAt(this.position.x + this.velocity.x * dt,
            this.position.z + dz)) {
        this.velocity.z = 0;
      }
    }

    // ── Integrate + collide (axis-separated, substepped) ─────────────────
    // Auto step-up (STEP_HEIGHT 0.6) only while walking on the ground: never
    // while sneaking (the edge-guard owns sneak movement), flying, or
    // swimming. onGround is preserved across a step.
    const stepHeight =
      (this.onGround && !this.flying && !this.sneaking && !inWater)
        ? STEP_HEIGHT : 0;
    const res = moveAndCollide(this.world, aabb, this.velocity, dt, { stepHeight });
    this.position = res.position;
    this.onGround = inWater ? false : res.onGround;

    // ── Kill plane ───────────────────────────────────────────────────────
    if (this.position.y < KILL_PLANE_Y) {
      if (typeof this.onKillPlane === 'function') this.onKillPlane();
      else this.respawn();
    }

    // ── Camera follows the eyes; rotation belongs to Controls ────────────
    if (this.camera) {
      const eye = this.eyePosition;
      this.camera.position.set(eye.x, eye.y, eye.z);
    }
  }

  /**
   * Sneak edge-guard probe: would the feet AABB footprint at horizontal min
   * corner (px, pz) still have at least one solid cell directly below it?
   * Uses the same eps conventions as physics.js cellRange.
   */
  _hasSupportAt(px, pz) {
    const EPS = 1e-9;
    const y = Math.floor(this.position.y + 0.001) - 1; // cell under the feet
    const x0 = Math.floor(px + EPS);
    const x1 = Math.floor(px + this.size.x - EPS);
    const z0 = Math.floor(pz + EPS);
    const z1 = Math.floor(pz + this.size.z - EPS);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (getBlockDef(this.world.getBlock(x, y, z)).solid) return true;
      }
    }
    return false;
  }
}
