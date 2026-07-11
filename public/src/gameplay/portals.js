// Loomfall — physical portals (portals/travel phase).
//
// PURE module: no three.js, no DOM — safe to import under plain node.
//
// A portal is a standing rectangular frame in a vertical plane (either the
// X-plane, interior spanning world-x at a fixed z, or the Z-plane, spanning
// world-z at a fixed x). The frame material decides the destination:
//
//   OBSIDIAN  (id 25) -> Cinderloom ('nether')
//   END_STONE (id 26) -> Nevermend  ('end')
//
// Interior dimensions: width 2-4, height 3-5 (interior cells, not counting
// the frame). Corners are NOT required (only the four edge runs are checked).
// Placing a PORTAL block (id 29) anywhere in the empty interior of a valid
// frame fills the whole interior with portal blocks. Breaking any frame
// block or any portal block collapses the connected portal fill.
//
// Travel rule (see PortalSystem): standing in a portal for DWELL_S seconds
// charges a jump — overworld goes to the frame's target dimension; any
// non-overworld dimension returns to the overworld.
//
// Exports:
//   PORTAL_BLOCK, FRAME_TARGETS, DWELL_S, COOLDOWN_S
//   detectFrame(world, x, y, z)      -> frame | null
//   fillPortal(frame, applyBlock)    -> number of cells filled
//   collapsePortal(world, x, y, z, applyBlock) -> number of cells cleared
//   class PortalSystem

import { BLOCK_ID } from '../blocks/blocks.js';
import { CHUNK_SY } from '../constants.js';

export const PORTAL_BLOCK = BLOCK_ID.portal; // 29

/** Frame material -> destination dimension id (when leaving the overworld). */
export const FRAME_TARGETS = {
  [BLOCK_ID.obsidian]: 'nether', // Cinderloom
  [BLOCK_ID.end_stone]: 'end',   // Nevermend
};

export const MIN_W = 2;
export const MAX_W = 4;
export const MIN_H = 3;
export const MAX_H = 5;

/** Seconds the player AABB must continuously overlap a portal block. */
export const DWELL_S = 1.5;
/** Seconds after arrival before a portal can charge again. */
export const COOLDOWN_S = 4;

/** Interior cells may be air (pre-fill) or portal (already lit). */
function isInterior(id) {
  return id === 0 || id === PORTAL_BLOCK;
}

/**
 * Detect a valid portal frame whose interior contains (x, y, z).
 *
 * Tries the X-plane (interior varies along x, z fixed) then the Z-plane.
 * Returns null when no valid frame surrounds the cell, otherwise:
 *   { axis: 'x'|'z', frameId, target, cells: [{x,y,z}, ...],
 *     x0, x1, z0, z1, y0, y1 }   (cells enumerate the interior rectangle)
 */
export function detectFrame(world, x, y, z) {
  return detectInPlane(world, x, y, z, 'x') || detectInPlane(world, x, y, z, 'z');
}

function detectInPlane(world, x, y, z, axis) {
  // u = coordinate along the interior span; getAt maps (u, yy) -> world block.
  const u0Start = axis === 'x' ? x : z;
  const getAt = axis === 'x'
    ? (u, yy) => world.getBlock(u, yy, z)
    : (u, yy) => world.getBlock(x, yy, u);

  if (!isInterior(getAt(u0Start, y))) return null;

  // Horizontal extent (interior cells), bounded by MAX_W.
  let uLo = u0Start;
  let uHi = u0Start;
  while (uHi - uLo + 1 <= MAX_W && isInterior(getAt(uLo - 1, y))) uLo--;
  while (uHi - uLo + 1 <= MAX_W && isInterior(getAt(uHi + 1, y))) uHi++;
  const w = uHi - uLo + 1;
  if (w < MIN_W || w > MAX_W) return null;

  // Vertical extent (interior cells), bounded by MAX_H.
  let yLo = y;
  let yHi = y;
  while (yHi - yLo + 1 <= MAX_H && yLo - 1 >= 0 && isInterior(getAt(u0Start, yLo - 1))) yLo--;
  while (yHi - yLo + 1 <= MAX_H && yHi + 1 < CHUNK_SY && isInterior(getAt(u0Start, yHi + 1))) yHi++;
  const h = yHi - yLo + 1;
  if (h < MIN_H || h > MAX_H) return null;
  if (yLo - 1 < 0 || yHi + 1 >= CHUNK_SY) return null; // frame must fit vertically

  // The whole interior rectangle must be interior cells.
  for (let yy = yLo; yy <= yHi; yy++) {
    for (let u = uLo; u <= uHi; u++) {
      if (!isInterior(getAt(u, yy))) return null;
    }
  }

  // All four edge runs must be one uniform, valid frame material.
  const frameId = getAt(uLo - 1, yLo);
  if (!(frameId in FRAME_TARGETS)) return null;
  for (let u = uLo; u <= uHi; u++) {
    if (getAt(u, yLo - 1) !== frameId) return null; // bottom
    if (getAt(u, yHi + 1) !== frameId) return null; // top
  }
  for (let yy = yLo; yy <= yHi; yy++) {
    if (getAt(uLo - 1, yy) !== frameId) return null; // left
    if (getAt(uHi + 1, yy) !== frameId) return null; // right
  }

  const cells = [];
  for (let yy = yLo; yy <= yHi; yy++) {
    for (let u = uLo; u <= uHi; u++) {
      cells.push(axis === 'x' ? { x: u, y: yy, z } : { x, y: yy, z: u });
    }
  }
  return {
    axis,
    frameId,
    target: FRAME_TARGETS[frameId],
    cells,
    x0: axis === 'x' ? uLo : x,
    x1: axis === 'x' ? uHi : x,
    z0: axis === 'x' ? z : uLo,
    z1: axis === 'x' ? z : uHi,
    y0: yLo,
    y1: yHi,
  };
}

/**
 * Fill a detected frame's interior with portal blocks.
 * `applyBlock(x, y, z, id)` must perform the real edit (world.setBlock +
 * edit record + net sync) — this module never touches the network itself.
 * Returns the number of cells actually changed.
 */
export function fillPortal(frame, applyBlock) {
  let n = 0;
  for (const c of frame.cells) {
    applyBlock(c.x, c.y, c.z, PORTAL_BLOCK);
    n++;
  }
  return n;
}

/**
 * Collapse the connected portal fill containing (x, y, z): flood-fill over
 * 6-connected portal blocks and clear each via applyBlock(x, y, z, 0).
 * Safe to call on a non-portal cell (returns 0). Returns cells cleared.
 */
export function collapsePortal(world, x, y, z, applyBlock) {
  if (world.getBlock(x, y, z) !== PORTAL_BLOCK) return 0;
  const seen = new Set();
  const queue = [[x, y, z]];
  const cells = [];
  const LIMIT = 512; // portals are at most 4x5; this only guards corrupt data
  while (queue.length > 0 && cells.length < LIMIT) {
    const [cx, cy, cz] = queue.pop();
    const key = `${cx},${cy},${cz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (world.getBlock(cx, cy, cz) !== PORTAL_BLOCK) continue;
    cells.push([cx, cy, cz]);
    queue.push(
      [cx + 1, cy, cz], [cx - 1, cy, cz],
      [cx, cy + 1, cz], [cx, cy - 1, cz],
      [cx, cy, cz + 1], [cx, cy, cz - 1],
    );
  }
  for (const [cx, cy, cz] of cells) applyBlock(cx, cy, cz, 0);
  return cells.length;
}

/**
 * PortalSystem — session glue: portal-block placement, collapse on break,
 * and dwell-to-travel charging.
 *
 * Construction options (all functions; kept as closures so the system stays
 * valid across dimension switches, where world references are replaced):
 *   getWorld()  -> current World
 *   getDim()    -> current dimension id
 *   player      -> Player (position = AABB min corner, size = AABB size)
 *   applyBlock(x, y, z, id) — production edit path (setBlock+record+net)
 *   onHint(text)            — system chat line (invalid frame, etc.)
 *   onCharge(progress)      — 0..1 while charging, 0 to clear
 *   onTravel(targetDim)     — fires ONCE when the dwell completes
 */
export class PortalSystem {
  constructor({ getWorld, getDim, player, applyBlock, onHint, onCharge, onTravel }) {
    this.getWorld = getWorld;
    this.getDim = getDim;
    this.player = player;
    this.applyBlock = applyBlock;
    this.onHint = onHint || (() => {});
    this.onCharge = onCharge || (() => {});
    this.onTravel = onTravel || (() => {});

    this.charge = 0; // seconds of continuous overlap
    this.cooldown = 0; // seconds until charging may start again
    this.traveling = false; // latched while a travel is in flight
  }

  /**
   * Handle an attempt to place a portal block at (x, y, z) — the production
   * place path routes portal-block placements here INSTEAD of setting the
   * block. Fills the frame interior when valid; otherwise shows the hint and
   * places nothing. Returns true when a portal was lit.
   */
  handlePortalPlacement(x, y, z) {
    const world = this.getWorld();
    if (world.getBlock(x, y, z) !== 0) return false; // must be an empty cell
    const frame = detectFrame(world, x, y, z);
    if (!frame) {
      this.onHint('The frame is incomplete...');
      return false;
    }
    fillPortal(frame, this.applyBlock);
    return true;
  }

  /**
   * Notify the system that a block was broken (already removed from the
   * world and synced by the caller). Collapses any portal fill that block
   * supported: breaking a frame block collapses adjacent fills; breaking a
   * portal block is handled by collapseAt() before removal instead.
   */
  handleFrameBreak(x, y, z) {
    const world = this.getWorld();
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      collapsePortal(world, x + dx, y + dy, z + dz, this.applyBlock);
    }
  }

  /** Collapse the connected portal group containing (x, y, z). */
  collapseAt(x, y, z) {
    return collapsePortal(this.getWorld(), x, y, z, this.applyBlock);
  }

  /** True when the player AABB overlaps at least one portal block. */
  playerInPortal() {
    const world = this.getWorld();
    const p = this.player.position;
    const s = this.player.size;
    const eps = 1e-7;
    const x0 = Math.floor(p.x), x1 = Math.floor(p.x + s.x - eps);
    const y0 = Math.floor(p.y), y1 = Math.floor(p.y + s.y - eps);
    const z0 = Math.floor(p.z), z1 = Math.floor(p.z + s.z - eps);
    for (let yy = y0; yy <= y1; yy++) {
      for (let zz = z0; zz <= z1; zz++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (world.getBlock(xx, yy, zz) === PORTAL_BLOCK) return { x: xx, y: yy, z: zz };
        }
      }
    }
    return null;
  }

  /** Destination for a jump from `cell` given the current dimension. */
  destinationFor(cell) {
    const dim = this.getDim();
    if (dim !== 'overworld') return 'overworld'; // any portal leads home
    const frame = detectFrame(this.getWorld(), cell.x, cell.y, cell.z);
    return frame ? frame.target : 'nether'; // frameless fill: default target
  }

  /** Start the post-travel cooldown (called by the travel orchestrator). */
  notifyTravelStart() {
    this.traveling = true;
    this.charge = 0;
    this.onCharge(0);
  }

  notifyTravelEnd() {
    this.traveling = false;
    this.cooldown = COOLDOWN_S;
    this.charge = 0;
  }

  /** Advance charging by dt seconds. Call once per frame while gameplay runs. */
  update(dt) {
    if (this.traveling) return;
    if (this.cooldown > 0) {
      this.cooldown = Math.max(0, this.cooldown - dt);
      this.onCharge(0);
      return;
    }
    const cell = this.playerInPortal();
    if (!cell) {
      if (this.charge !== 0) {
        this.charge = 0;
        this.onCharge(0);
      }
      return;
    }
    this.charge += dt;
    this.onCharge(Math.min(1, this.charge / DWELL_S));
    if (this.charge >= DWELL_S) {
      const target = this.destinationFor(cell);
      this.notifyTravelStart();
      this.onTravel(target);
    }
  }
}
