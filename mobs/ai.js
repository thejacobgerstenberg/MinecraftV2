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

// ----------------------------------------------------------------------
// Cheap local navigation helpers
//
// Neither of the functions below does any real pathfinding (no A*, no
// graph search). They just look a handful of blocks ahead of a steering
// direction that some other function (wanderSteer/seekSteer/fleeSteer)
// already produced, and nudge it so grounded mobs hop 1-block steps,
// slide around short walls, and avoid walking off cliffs, and so flying
// mobs rise over terrain / settle back down toward the ground. All of it
// is a small, fixed number of isSolid(x,y,z) samples per call.
// ----------------------------------------------------------------------

/**
 * JUMP_SPEED: sensible upward velocity.y impulse (u/s) for hopping a
 * 1-block step, e.g. `velocity.y = JUMP_SPEED` when navSteer reports
 * wantJump. Tuned so, combined with GRAVITY, a grounded mob clears one
 * block of height.
 */
export const JUMP_SPEED = 7.5;

/**
 * navSteer(position, desired, halfWidth, isSolid, opts?) -> { vx, vz, wantJump }
 *
 * Takes a desired horizontal steering direction (as produced by
 * wanderSteer/seekSteer/fleeSteer, {vx,vz}) for a grounded mob standing at
 * `position` (position.y = feet) and adjusts it based on a cheap look-ahead
 * at the block roughly `halfWidth + 0.5` out in front, at foot level:
 *
 *   - 1-block step: the block directly ahead at foot level is solid but the
 *     block one above it is free (and there's headroom to stand) -> desired
 *     direction is passed through unchanged and `wantJump: true` is set so
 *     the caller applies a jump impulse (e.g. velocity.y = JUMP_SPEED) to
 *     hop the step.
 *   - Wall (>=2 blocks tall): both the ahead cell and the cell above it are
 *     solid -> the desired direction is deflected ~90 degrees to slide
 *     along the wall, picking whichever side looks more open.
 *   - Cliff/drop: the ahead cell (and above it) are clear, but there's no
 *     solid ground within `opts.maxDrop` (default 3) blocks below the ahead
 *     cell -> the forward component is reduced and a sideways deflection
 *     away from the edge is added, to avoid walking off.
 *   - Otherwise: `desired` is returned unchanged with `wantJump: false`.
 *
 * opts:
 *   - aheadDist (default halfWidth + 0.5): how far out to sample.
 *   - maxDrop (default 3): how many blocks down counts as "still ground".
 *
 * Only a handful of isSolid samples are taken (never more than ~6), and
 * isSolid is called through the same defensive wrapper used elsewhere in
 * this file, so a throwing/misbehaving predicate can't crash steering.
 */
export function navSteer(position, desired, halfWidth, isSolid, opts = {}) {
  const vx = desired?.vx ?? 0;
  const vz = desired?.vz ?? 0;
  const dlen = Math.hypot(vx, vz);

  // Not moving (or degenerate direction) -- nothing to look ahead at.
  if (dlen < 1e-6) {
    return { vx, vz, wantJump: false };
  }

  const dirX = vx / dlen;
  const dirZ = vz / dlen;
  const aheadDist = opts.aheadDist ?? halfWidth + 0.5;
  const aheadX = position.x + dirX * aheadDist;
  const aheadZ = position.z + dirZ * aheadDist;
  const feetY = Math.floor(position.y + 0.05);
  const maxDrop = opts.maxDrop ?? 3;

  const aheadSolid = safeIsSolid(isSolid, aheadX, feetY, aheadZ);

  if (aheadSolid) {
    const aheadAboveSolid = safeIsSolid(isSolid, aheadX, feetY + 1, aheadZ);
    if (!aheadAboveSolid) {
      // Looks like a 1-block step. Confirm there's headroom to stand once
      // stepped up (both at the destination and above the mob's current
      // spot, so it doesn't jump straight into a low ceiling).
      const headroomFree =
        !safeIsSolid(isSolid, aheadX, feetY + 2, aheadZ) &&
        !safeIsSolid(isSolid, position.x, feetY + 2, position.z);
      if (headroomFree) {
        return { vx, vz, wantJump: true };
      }
      // No headroom to hop -- fall through to wall-deflect behaviour below.
    }

    // Wall (too tall to step, or no headroom): slide along it. Try both
    // perpendicular directions and pick whichever is not immediately
    // blocked; default to the "left" rotation if both/neither are open.
    const leftX = -dirZ;
    const leftZ = dirX;
    const rightX = dirZ;
    const rightZ = -dirX;
    const leftBlocked = safeIsSolid(
      isSolid,
      position.x + leftX * aheadDist,
      feetY,
      position.z + leftZ * aheadDist
    );
    const rightBlocked = safeIsSolid(
      isSolid,
      position.x + rightX * aheadDist,
      feetY,
      position.z + rightZ * aheadDist
    );

    let sideX = leftX;
    let sideZ = leftZ;
    if (leftBlocked && !rightBlocked) {
      sideX = rightX;
      sideZ = rightZ;
    }
    return { vx: sideX * dlen, vz: sideZ * dlen, wantJump: false };
  }

  // Ahead at foot level is clear. Check for a cliff: is there solid ground
  // within maxDrop blocks below the ahead cell?
  let groundFound = false;
  for (let d = 1; d <= maxDrop; d++) {
    if (safeIsSolid(isSolid, aheadX, feetY - d, aheadZ)) {
      groundFound = true;
      break;
    }
  }

  if (!groundFound) {
    // Edge ahead: cut forward speed way down and deflect sideways, toward
    // whichever side still has ground under the mob's own footprint.
    const leftX = -dirZ;
    const leftZ = dirX;
    const rightX = dirZ;
    const rightZ = -dirX;
    const leftGround = safeIsSolid(
      isSolid,
      position.x + leftX * aheadDist,
      feetY - 1,
      position.z + leftZ * aheadDist
    );
    const rightGround = safeIsSolid(
      isSolid,
      position.x + rightX * aheadDist,
      feetY - 1,
      position.z + rightZ * aheadDist
    );

    let sideX = leftX;
    let sideZ = leftZ;
    if (!leftGround && rightGround) {
      sideX = rightX;
      sideZ = rightZ;
    }

    const forwardScale = 0.15; // keep a whisper of forward motion
    const sideScale = 0.85;
    const outX = (dirX * forwardScale + sideX * sideScale) * dlen;
    const outZ = (dirZ * forwardScale + sideZ * sideScale) * dlen;
    return { vx: outX, vz: outZ, wantJump: false };
  }

  // Clear path, solid ground ahead -- pass the desired steering through.
  return { vx, vz, wantJump: false };
}

/**
 * flyerAvoid(position, desired, isSolid, opts?) -> { vx, vz, vy }
 *
 * Cheap terrain-avoidance for flying mobs. Takes a desired horizontal
 * direction and, sampling only a couple of blocks:
 *   - If the block directly ahead (in the desired direction) at the
 *     flyer's current altitude is solid, biases vy upward by
 *     `opts.climbSpeed` (default 4) so it rises over the obstacle.
 *   - Else if there's no solid ground within `opts.cruiseHeight` (default
 *     5) blocks below, it's cruising high above the ground, so a gentle
 *     descent is applied (`-opts.descendSpeed`, default 1) to bring it
 *     back down toward a normal flight altitude.
 *   - Otherwise vy is left at 0 (level flight).
 *
 * The horizontal components of `desired` are passed through unchanged --
 * this only ever adjusts vy.
 */
export function flyerAvoid(position, desired, isSolid, opts = {}) {
  const vx = desired?.vx ?? 0;
  const vz = desired?.vz ?? 0;
  const climbSpeed = opts.climbSpeed ?? 4;
  const descendSpeed = opts.descendSpeed ?? 1;
  const cruiseHeight = opts.cruiseHeight ?? 5;
  const aheadDist = opts.aheadDist ?? 1.5;

  const dlen = Math.hypot(vx, vz);
  if (dlen >= 1e-6) {
    const dirX = vx / dlen;
    const dirZ = vz / dlen;
    const aheadX = position.x + dirX * aheadDist;
    const aheadZ = position.z + dirZ * aheadDist;
    const y = Math.floor(position.y);
    if (safeIsSolid(isSolid, aheadX, y, aheadZ)) {
      return { vx, vz, vy: climbSpeed };
    }
  }

  const nearGround = safeIsSolid(isSolid, position.x, Math.floor(position.y - 2), position.z);
  if (nearGround) {
    return { vx, vz, vy: 0 };
  }

  const farGround = safeIsSolid(
    isSolid,
    position.x,
    Math.floor(position.y - cruiseHeight),
    position.z
  );
  return { vx, vz, vy: farGround ? 0 : -descendSpeed };
}
