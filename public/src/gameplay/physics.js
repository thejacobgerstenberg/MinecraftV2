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
// moveAndCollide(world, aabb, velocity, dt) ->
//   { position: {x, y, z},              // NEW min corner (aabb.pos is NOT mutated)
//     onGround: boolean,                // true if a downward Y collision occurred
//     collided: {x: bool, y: bool, z: bool} }
//
// Resolution is axis-separated: for each substep we integrate + resolve X,
// then Y, then Z. Substepping caps per-axis movement at MAX_SUBSTEP blocks
// per step so a velocity of 50 blocks/s at dt = 0.05 (2.5 blocks of travel)
// cannot tunnel through a 1-block-thick wall.
//
// Solidity comes from getBlockDef(world.getBlock(...)).solid — liquids
// (water, lava) are solid:false and never collide.
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

function isSolid(world, x, y, z) {
  return getBlockDef(world.getBlock(x, y, z)).solid;
}

/**
 * Move the box by `delta` along `axis` ('x'|'y'|'z'), then push it back out
 * of any solid cell it now overlaps, flush (+SKIN) against the nearest
 * blocking face. Mutates pos. Returns true if a collision happened.
 */
function sweepAxis(world, pos, size, axis, delta) {
  pos[axis] += delta;

  const [x0, x1] = cellRange(pos.x, size.x);
  const [y0, y1] = cellRange(pos.y, size.y);
  const [z0, z1] = cellRange(pos.z, size.z);

  let hit = false;
  // Nearest blocking face along the movement direction.
  let clamp = delta > 0 ? Infinity : -Infinity;

  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (!isSolid(world, x, y, z)) continue;
        hit = true;
        const cell = axis === 'x' ? x : axis === 'y' ? y : z;
        clamp = delta > 0 ? Math.min(clamp, cell) : Math.max(clamp, cell);
      }
    }
  }

  if (hit) {
    if (delta > 0) {
      pos[axis] = clamp - size[axis] - SKIN; // stop against the cell's low face
    } else {
      pos[axis] = clamp + 1 + SKIN;          // stop against the cell's high face
    }
  }
  return hit;
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
 * @returns {{position:{x:number,y:number,z:number}, onGround:boolean, collided:{x:boolean,y:boolean,z:boolean}}}
 */
export function moveAndCollide(world, aabb, velocity, dt) {
  const pos = { x: aabb.pos.x, y: aabb.pos.y, z: aabb.pos.z };
  const size = aabb.size;
  const collided = { x: false, y: false, z: false };
  let onGround = false;

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
      if (sweepAxis(world, pos, size, axis, delta)) {
        collided[axis] = true;
        if (axis === 'y' && delta < 0) onGround = true;
        velocity[axis] = 0;
      }
    }
  }

  return { position: pos, onGround, collided };
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
