// ============================================================================
// StubWorld.js
//
// A minimal demo/test world implementing the same getBlock(x,y,z) surface
// the real game world exposes (branch feat/voxel-sandbox-game). This is
// ONLY for local demos and unit tests of mobs/ai.js + mobs/MobManager.js —
// real integration passes in the game's actual world object.
//
// getBlock(x,y,z) returns a NUMERIC block id (0-29), matching the real
// world.getBlock contract exactly (never a string, never undefined).
//
// Default (test) terrain — ground fills y<1, so mobs stand at y>=1:
//   - y === 0                    -> 1 (grass), the top solid row/surface.
//   - DEEP_BEDROCK_Y <= y < 0    -> 3 (stone), below-ground solid fill.
//   - y < DEEP_BEDROCK_Y         -> 17 (bedrock), mirrors the real world's
//                                   "probe far enough down and you hit
//                                   bedrock" behaviour (real world does
//                                   this unconditionally for any y<0; the
//                                   stub uses a shallow stone band first so
//                                   ordinary probes near the surface still
//                                   see stone, matching the "below-ground
//                                   solid = stone" test requirement).
//   - y >= 1                     -> 0 (air), except:
//   - y === 1 at a pillar coordinate -> 1 (grass), a scattered 1-block-tall
//     bump so collision/step-up behavior has something to bump into.
//
// Arena (boss-fight) terrain — new StubWorld({ arena: true }):
//   - A large flat solid floor of end_stone (id 26) at y < 1, no pillars,
//     for the Nevermend boss arena. Everything at y >= 1 is air (0).
// ============================================================================

import { BLOCK_ID } from '../blocksAdapter.js';

// A short, fixed list of pillar coordinates (x, z) that get one extra solid
// (grass, id 1) block at y === 1 (i.e. a 1-block-tall bump standing on the
// ground). Only used in the default (non-arena) terrain.
const PILLARS = [
  { x: 3, z: 2 },
  { x: -4, z: 5 },
  { x: 6, z: -3 },
  { x: -2, z: -6 },
];

// Below this y, the default terrain returns bedrock instead of stone —
// mirrors the real world's "y<0 is always solid/bedrock-ish deep down"
// convention without making the shallow stone band unreachable.
const DEEP_BEDROCK_Y = -8;

// How far out (in blocks, +/- on both axes) the flat arena floor extends.
// Generously large so a boss fight has room to roam without falling off
// the edge into air.
const ARENA_RADIUS = 48;

export class StubWorld {
  /**
   * @param {object} [opts]
   *   arena?: boolean  -- if true, use a large flat end_stone (id 26) floor
   *                       with no pillars (Nevermend boss arena). Defaults
   *                       to false (normal test terrain with grass/stone/
   *                       bedrock ground + pillars).
   */
  constructor(opts = {}) {
    this.arena = !!(opts && opts.arena);
    this.pillars = new Set(PILLARS.map((p) => `${p.x},${p.z}`));
  }

  /**
   * getBlock(x, y, z) -> numeric block id (0-29)
   * Coordinates are treated as block-grid coordinates; fractional inputs
   * are floored, matching typical voxel-world semantics.
   */
  getBlock(x, y, z) {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);

    if (this.arena) {
      if (by < 1 && Math.abs(bx) <= ARENA_RADIUS && Math.abs(bz) <= ARENA_RADIUS) {
        // Flat solid end_stone floor — bounded so it reads as a finite
        // arena rather than infinite ground (still plenty large).
        return BLOCK_ID.END_STONE;
      }
      return BLOCK_ID.AIR;
    }

    if (by === 0) {
      return BLOCK_ID.GRASS; // top solid row / surface
    }
    if (by < 0) {
      return by >= DEEP_BEDROCK_Y ? BLOCK_ID.STONE : BLOCK_ID.BEDROCK;
    }
    if (by === 1 && this.pillars.has(`${bx},${bz}`)) {
      return BLOCK_ID.GRASS; // grass-topped pillar bump
    }
    return BLOCK_ID.AIR;
  }
}

export default StubWorld;
