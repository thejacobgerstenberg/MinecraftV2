// ============================================================================
// mobs/ai.js
//
// Small, dependency-free AI + physics helper functions used by MobManager.
// Every function here is deliberately "pure-ish": it takes plain data
// (position/velocity objects with .x/.y/.z, an isSolid(x,y,z) predicate,
// dt, etc) and returns/mutates that data directly. Nothing here imports
// THREE or blocksAdapter — callers inject collision via an isSolid(x,y,z)
// function so the real game's block lookup can be swapped in without
// touching this file.
//
// Coordinate/unit conventions:
//   - 1 unit = 1 block.
//   - Gravity ~ -20 u/s^2, terminal fall speed clamped.
//   - Mob AABB: a box centered on position.x/position.z, position.y is the
//     FEET (bottom) of the box. halfWidth ~0.3 (0.6 wide), height per
//     species (~0.8-1.4).
// ============================================================================

export const GRAVITY = -20; // u/s^2
export const TERMINAL_FALL_SPEED = -40; // u/s, downward speed clamp

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Defensive wrapper around a caller-supplied isSolid(x,y,z) predicate: any
// throw or non-function is treated as "not solid" so a bad callback can
// never crash physics stepping.
function safeIsSolid(isSolid, x, y, z) {
  if (typeof isSolid !== 'function') return false;
  try {
    return !!isSolid(x, y, z);
  } catch (e) {
    return false;
  }
}

// ----------------------------------------------------------------------
// Gravity
// ----------------------------------------------------------------------

/**
 * applyGravity(velocity, dt, opts?) -> velocity (mutated + returned)
 * Adds gravity to velocity.y for this tick, clamped to terminal fall speed.
 */
export function applyGravity(velocity, dt, opts = {}) {
  const gravity = opts.gravity ?? GRAVITY;
  const terminal = opts.terminalVelocity ?? TERMINAL_FALL_SPEED;
  velocity.y = Math.max(terminal, velocity.y + gravity * dt);
  return velocity;
}

// ----------------------------------------------------------------------
// Collision — vertical (ground/ceiling)
// ----------------------------------------------------------------------

/**
 * The four horizontal sample points around a box centered at (x,z) with
 * the given halfWidth, inset slightly so we don't false-trigger on the
 * exact block boundary.
 */
function footprintCorners(x, z, halfWidth) {
  const inset = Math.max(0.01, halfWidth * 0.9);
  return [
    [x - inset, z - inset],
    [x + inset, z - inset],
    [x - inset, z + inset],
    [x + inset, z + inset],
  ];
}

/**
 * resolveVertical(position, velocity, halfWidth, height, isSolid, dt)
 * Moves position.y by velocity.y*dt, resolving collision against solid
 * blocks at the feet (falling) or head (rising). Mutates position.y and
 * velocity.y in place. Returns `grounded` (boolean).
 */
export function resolveVertical(position, velocity, halfWidth, height, isSolid, dt) {
  const corners = footprintCorners(position.x, position.z, halfWidth);
  let nextY = position.y + velocity.y * dt;
  let grounded = false;

  if (velocity.y <= 0) {
    // Falling (or stationary): check the block just below the new feet
    // position under each corner.
    const feetBlockY = Math.floor(nextY - 0.001);
    let hit = false;
    for (const [cx, cz] of corners) {
      if (safeIsSolid(isSolid, cx, feetBlockY, cz)) {
        hit = true;
        break;
      }
    }
    if (hit) {
      nextY = feetBlockY + 1; // rest exactly on top of the solid block
      velocity.y = 0;
      grounded = true;
    }
  } else {
    // Rising: check for a ceiling at head height.
    const headBlockY = Math.floor(nextY + height);
    let hit = false;
    for (const [cx, cz] of corners) {
      if (safeIsSolid(isSolid, cx, headBlockY, cz)) {
        hit = true;
        break;
      }
    }
    if (hit) {
      nextY = headBlockY - height;
      velocity.y = 0;
    }
  }

  position.y = nextY;

  // Even if we didn't fall this tick (already resting), confirm grounded
  // state by sampling directly beneath the current feet.
  if (!grounded && velocity.y === 0) {
    const feetBlockY = Math.floor(position.y - 0.05);
    for (const [cx, cz] of corners) {
      if (safeIsSolid(isSolid, cx, feetBlockY, cz)) {
        grounded = true;
        break;
      }
    }
  }

  return grounded;
}

/**
 * isGrounded(position, halfWidth, isSolid) -> boolean
 * Standalone ground check (no movement), used e.g. right after a teleport
 * or spawn to decide initial state.
 */
export function isGrounded(position, halfWidth, isSolid) {
  const corners = footprintCorners(position.x, position.z, halfWidth);
  const feetBlockY = Math.floor(position.y - 0.05);
  for (const [cx, cz] of corners) {
    if (safeIsSolid(isSolid, cx, feetBlockY, cz)) return true;
  }
  return false;
}

// ----------------------------------------------------------------------
// Collision — horizontal (walls)
// ----------------------------------------------------------------------

/**
 * resolveHorizontal(position, velocity, halfWidth, height, isSolid, dt)
 * Moves position.x/z by velocity.x/z*dt, one axis at a time, zeroing the
 * velocity component (and not moving) on that axis if the destination
 * would overlap a solid block anywhere across the mob's vertical extent
 * (sampled at feet and at ~mid-height). Mutates position + velocity.
 */
export function resolveHorizontal(position, velocity, halfWidth, height, isSolid, dt) {
  const sampleYs = [position.y + 0.05, position.y + Math.max(0.1, height * 0.5)];

  function blockedAt(x, z) {
    const corners = footprintCorners(x, z, halfWidth);
    for (const y of sampleYs) {
      const by = Math.floor(y);
      for (const [cx, cz] of corners) {
        if (safeIsSolid(isSolid, cx, by, cz)) return true;
      }
    }
    return false;
  }

  // X axis
  if (velocity.x !== 0) {
    const nextX = position.x + velocity.x * dt;
    if (blockedAt(nextX, position.z)) {
      velocity.x = 0;
    } else {
      position.x = nextX;
    }
  }

  // Z axis (checked independently so sliding along a wall still works)
  if (velocity.z !== 0) {
    const nextZ = position.z + velocity.z * dt;
    if (blockedAt(position.x, nextZ)) {
      velocity.z = 0;
    } else {
      position.z = nextZ;
    }
  }
}

// ----------------------------------------------------------------------
// Combined step for a normal (walking, gravity-affected) mob
// ----------------------------------------------------------------------

/**
 * stepGroundedBody(position, velocity, halfWidth, height, isSolid, dt, opts?)
 * Convenience: applies gravity, resolves vertical then horizontal
 * collision. Returns { grounded }.
 */
export function stepGroundedBody(position, velocity, halfWidth, height, isSolid, dt, opts = {}) {
  applyGravity(velocity, dt, opts);
  const grounded = resolveVertical(position, velocity, halfWidth, height, isSolid, dt);
  resolveHorizontal(position, velocity, halfWidth, height, isSolid, dt);
  return { grounded };
}

// ----------------------------------------------------------------------
// Steering behaviours
// ----------------------------------------------------------------------

/**
 * wanderState() -> a fresh state blob for use with wanderSteer.
 */
export function wanderState() {
  return {
    phase: 'idle', // 'idle' | 'walk'
    timer: 0,
    headingX: 0,
    headingZ: 0,
  };
}

/**
 * wanderSteer(state, dt, rng, speed?) -> { vx, vz, moving }
 * Mutates `state` (phase/timer/heading) and returns a desired horizontal
 * velocity for this tick. Alternates between short idle pauses and walking
 * in a randomly chosen heading.
 */
export function wanderSteer(state, dt, rng, speed = 1.2) {
  const random = typeof rng === 'function' ? rng : Math.random;
  state.timer -= dt;

  if (state.timer <= 0) {
    if (state.phase === 'idle') {
      // Start walking in a new random heading.
      state.phase = 'walk';
      const angle = random() * Math.PI * 2;
      state.headingX = Math.cos(angle);
      state.headingZ = Math.sin(angle);
      state.timer = 1.5 + random() * 2.5; // walk for 1.5-4s
    } else {
      // Stop and idle for a bit.
      state.phase = 'idle';
      state.headingX = 0;
      state.headingZ = 0;
      state.timer = 0.8 + random() * 2.0; // idle for 0.8-2.8s
    }
  }

  if (state.phase === 'walk') {
    return { vx: state.headingX * speed, vz: state.headingZ * speed, moving: true };
  }
  return { vx: 0, vz: 0, moving: false };
}

/**
 * seekSteer(position, targetPos, speed) -> { vx, vz, moving }
 * Horizontal-only steering toward targetPos. If already effectively at the
 * target (within a small epsilon), returns zero velocity.
 */
export function seekSteer(position, targetPos, speed = 1.5) {
  if (!targetPos) return { vx: 0, vz: 0, moving: false };
  const dx = targetPos.x - position.x;
  const dz = targetPos.z - position.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.05) return { vx: 0, vz: 0, moving: false };
  return { vx: (dx / dist) * speed, vz: (dz / dist) * speed, moving: true };
}

/**
 * fleeSteer(position, targetPos, speed) -> { vx, vz, moving }
 * Horizontal-only steering directly away from targetPos.
 */
export function fleeSteer(position, targetPos, speed = 1.8) {
  if (!targetPos) return { vx: 0, vz: 0, moving: false };
  const dx = position.x - targetPos.x;
  const dz = position.z - targetPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.001) {
    // Degenerate (exactly on top of the target) — pick an arbitrary
    // direction rather than divide by zero.
    return { vx: speed, vz: 0, moving: true };
  }
  return { vx: (dx / dist) * speed, vz: (dz / dist) * speed, moving: true };
}

/**
 * horizontalDistance(a, b) -> number
 * Small shared utility: XZ-plane distance between two {x,z}-bearing points.
 */
export function horizontalDistance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.z - b.z);
}
