// Voxelheim — AABB-vs-voxel physics (PURE module: no three.js import,
// plain {x,y,z} objects only, runs under plain node for tests).
//
// ── Shapes (exact — integration and tests rely on these) ──────────────────
//
// world    : { getBlock(x, y, z) -> blockId }  (integer block coords)
// aabb     : { pos:  {x, y, z},     // MIN corner of the box (feet corner)
//              size: {x, y, z} }    // extents; player is 0.6 × 1.8 × 0.6
// velocity : { x, y, z }            // blocks/second. MUTATED: any component
//                                   // whose axis collided is set to 0.
// dt       : seconds
//
// moveAndCollide(world, aabb, velocity, dt, opts?) ->
//   { position: {x, y, z},              // NEW min corner (aabb.pos is NOT mutated)
//     onGround: boolean,                // true if a downward Y collision occurred
//     collided: {x: bool, y: bool, z: bool},
//     stepped: boolean }                // true if an auto step-up was performed
//
// opts (all optional):
//   stepHeight — auto step-up (spec STEP_HEIGHT, 0.6): when a HORIZONTAL sweep
//     is blocked and the blocking obstacle's collision top is <= stepHeight
//     above the feet AND the lifted box has headroom, the box is lifted onto
//     the obstacle and the horizontal move is retried (velocity NOT zeroed).
//     Default 0 (off). The caller gates it (Player: only onGround, never while
//     sneaking or flying). Note: with the game's all-full-block palette an
//     obstacle top is always feet+1.0 > 0.6, so step-up never fires in-game;
//     it activates on partial-height cells (collisionHeight < 1, see below).
//
// Resolution is axis-separated: for each substep we integrate + resolve X,
// then Y, then Z. Substepping caps per-axis movement at MAX_SUBSTEP blocks
// per step so a velocity of 78.4 blocks/s (terminal) at dt = 0.05 (3.92
// blocks of travel) cannot tunnel through a 1-block-thick wall.
//
// Solidity comes from getBlockDef(world.getBlock(...)).solid — liquids
// (water, lava) are solid:false and never collide. A world may override the
// def lookup by exposing its own `world.getBlockDef(id)` (test worlds use
// this to model partial-height cells); a def may carry `collisionHeight`
// (0 < h <= 1, default 1): the cell's collision volume spans
// [cellY, cellY + h] growing from the cell floor.
//
// Clamping convention: after a collision on an axis the box is placed flush
// against the blocking cell face, offset by SKIN (1e-6) so the box does not
// re-register as overlapping on subsequent perpendicular sweeps. E.g. walking
// +x into a wall whose cell min-x is 5 stops the 0.6-wide box at
// pos.x = 5 - 0.6 - SKIN ≈ 4.4.

import { getBlockDef } from '../blocks/blocks.js';

/** Gap left between the box and a block face after clamping. */
const SKIN = 1e-6;
/** Maximum per-axis displacement per substep (blocks). Must be < 1. */
const MAX_SUBSTEP = 0.4;
/** Tolerance used when converting a float interval to overlapped cells. */
const BOUND_EPS = 1e-9;

/**
 * Inclusive integer cell range [min, max] overlapped by the 1-D interval
 * [minCoord, minCoord + size). Touching a face exactly does not count as
 * overlapping.
 */
function cellRange(minCoord, size) {
  return [
    Math.floor(minCoord + BOUND_EPS),
    Math.floor(minCoord + size - BOUND_EPS),
  ];
}

function blockDef(world, x, y, z) {
  const id = world.getBlock(x, y, z);
  return world.getBlockDef ? world.getBlockDef(id) : getBlockDef(id);
}

/** Collision height of the def (partial-height cells; default full cell). */
function defHeight(def) {
  const h = def.collisionHeight;
  return (typeof h === 'number' && h > 0 && h <= 1) ? h : 1;
}

/**
 * Move the box by `delta` along `axis` ('x'|'y'|'z'), then push it back out
 * of any solid cell it now overlaps, flush (+SKIN) against the nearest
 * blocking face. Mutates pos. Returns true if a collision happened.
 *
 * Partial-height cells (collisionHeight < 1): the cell's collision volume is
 * [cellY, cellY + h]. Horizontally, a cell whose top is at/below the feet
 * does not block; vertically, a downward move rests on cellY + h.
 */
function sweepAxis(world, pos, size, axis, delta) {
  pos[axis] += delta;

  const [x0, x1] = cellRange(pos.x, size.x);
  const [y0, y1] = cellRange(pos.y, size.y);
  const [z0, z1] = cellRange(pos.z, size.z);

  let hit = false;
  // Nearest blocking face along the movement direction. For -y this is the
  // highest blocking TOP (cellY + h); for the other directions cell index.
  let clamp = delta > 0 ? Infinity : -Infinity;

  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const def = blockDef(world, x, y, z);
        if (!def.solid) continue;
        // Partial-height: the box only overlaps if its bottom is below the
        // cell's collision top.
        const top = y + defHeight(def);
        if (pos.y + BOUND_EPS >= top) continue;
        hit = true;
        if (axis === 'y' && delta < 0) {
          clamp = Math.max(clamp, top);
        } else {
          const cell = axis === 'x' ? x : axis === 'y' ? y : z;
          clamp = delta > 0 ? Math.min(clamp, cell) : Math.max(clamp, cell);
        }
      }
    }
  }

  if (hit) {
    if (delta > 0) {
      pos[axis] = clamp - size[axis] - SKIN; // stop against the cell's low face
    } else if (axis === 'y') {
      pos[axis] = clamp + SKIN;              // rest on the blocking top
    } else {
      pos[axis] = clamp + 1 + SKIN;          // stop against the cell's high face
    }
  }
  return hit;
}

/**
 * Auto step-up probe for a blocked horizontal sweep. `pos` is the CLAMPED
 * position sweepAxis left behind; `tryPos` is where the box tried to go on
 * that axis. Returns the required lift (> 0) if every blocking obstacle top
 * at the attempted footprint is within stepHeight of the feet AND the lifted
 * box has headroom there; otherwise returns 0.
 */
function stepUpLift(world, pos, size, axis, tryPos, stepHeight) {
  const probe = { x: pos.x, y: pos.y, z: pos.z };
  probe[axis] = tryPos;

  const [x0, x1] = cellRange(probe.x, size.x);
  const [z0, z1] = cellRange(probe.z, size.z);
  const [y0, y1] = cellRange(probe.y, size.y);

  // Highest blocking collision top over the attempted footprint.
  let obstacleTop = -Infinity;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const def = blockDef(world, x, y, z);
        if (!def.solid) continue;
        const top = y + defHeight(def);
        if (probe.y + BOUND_EPS >= top) continue; // below the feet: not blocking
        obstacleTop = Math.max(obstacleTop, top);
      }
    }
  }

  const lift = obstacleTop - probe.y;
  if (!(lift > 0) || lift > stepHeight + 1e-9) return 0;

  // Headroom: the lifted box at the attempted position must be collision-free.
  const ly = obstacleTop + SKIN;
  const [hy0, hy1] = cellRange(ly, size.y);
  for (let y = hy0; y <= hy1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const def = blockDef(world, x, y, z);
        if (!def.solid) continue;
        if (ly + BOUND_EPS < y + defHeight(def)) return 0;
      }
    }
  }
  return lift;
}

/**
 * Axis-separated swept AABB vs. voxel collision. See module header for the
 * exact shapes. `aabb` is not mutated; `velocity` IS mutated (collided
 * components are zeroed).
 *
 * @param {{getBlock:(x:number,y:number,z:number)=>number}} world
 * @param {{pos:{x:number,y:number,z:number}, size:{x:number,y:number,z:number}}} aabb
 * @param {{x:number,y:number,z:number}} velocity  blocks/s, mutated on collision
 * @param {number} dt seconds
 * @param {{stepHeight?:number}} [opts]  stepHeight > 0 enables auto step-up
 * @returns {{position:{x:number,y:number,z:number}, onGround:boolean, collided:{x:boolean,y:boolean,z:boolean}, stepped:boolean}}
 */
export function moveAndCollide(world, aabb, velocity, dt, opts) {
  const pos = { x: aabb.pos.x, y: aabb.pos.y, z: aabb.pos.z };
  const size = aabb.size;
  const collided = { x: false, y: false, z: false };
  const stepHeight = (opts && opts.stepHeight) || 0;
  let onGround = false;
  let stepped = false;

  const maxDisp = Math.max(
    Math.abs(velocity.x),
    Math.abs(velocity.y),
    Math.abs(velocity.z),
  ) * dt;
  const steps = Math.max(1, Math.ceil(maxDisp / MAX_SUBSTEP));
  const h = dt / steps;

  for (let i = 0; i < steps; i++) {
    for (const axis of ['x', 'y', 'z']) {
      const delta = velocity[axis] * h; // re-read: zeroed axes stop moving
      if (delta === 0) continue;
      const before = pos[axis];
      if (sweepAxis(world, pos, size, axis, delta)) {
        // Auto step-up: a blocked HORIZONTAL move may climb a low obstacle
        // (top <= stepHeight above the feet, headroom permitting).
        if (stepHeight > 0 && axis !== 'y') {
          const lift = stepUpLift(world, pos, size, axis, before + delta, stepHeight);
          if (lift > 0) {
            pos.y += lift + SKIN;      // onto the obstacle top
            pos[axis] = before + delta; // the horizontal move goes through
            stepped = true;
            onGround = true;            // stepping keeps ground contact
            continue;                   // velocity NOT zeroed
          }
        }
        collided[axis] = true;
        if (axis === 'y' && delta < 0) onGround = true;
        velocity[axis] = 0;
      }
    }
  }

  return { position: pos, onGround, collided, stepped };
}

/**
 * True if any voxel cell overlapped by the AABB is a liquid
 * (getBlockDef(id).liquid — water or lava).
 *
 * @param {{getBlock:(x:number,y:number,z:number)=>number}} world
 * @param {{pos:{x:number,y:number,z:number}, size:{x:number,y:number,z:number}}} aabb
 * @returns {boolean}
 */
export function isInLiquid(world, aabb) {
  const [x0, x1] = cellRange(aabb.pos.x, aabb.size.x);
  const [y0, y1] = cellRange(aabb.pos.y, aabb.size.y);
  const [z0, z1] = cellRange(aabb.pos.z, aabb.size.z);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (getBlockDef(world.getBlock(x, y, z)).liquid) return true;
      }
    }
  }
  return false;
}
