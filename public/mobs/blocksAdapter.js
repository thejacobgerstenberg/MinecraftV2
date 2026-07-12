// ============================================================================
// blocksAdapter.js
//
// FALLBACK ONLY. This module provides a local getBlockDef(id) implementation
// so AI/physics code (mobs/ai.js, mobs/MobManager.js) can run stand-alone
// (unit tests, the mobs/demo.html sandbox) without the real game world.
//
// In production, callers MUST inject the builder's real getBlockDef from
// public/src/blocks/blocks.js via `opts.getBlockDef` (see MobManager.js's
// constructor). This file's getBlockDef is only ever consulted when nothing
// was injected.
//
// world.getBlock(x,y,z) in the REAL game (branch feat/voxel-sandbox-game)
// ALWAYS returns a NUMBER in [0,29] — never undefined, never a string.
// (y<0 => 17 bedrock/solid; y>=128 => 0 air; ungenerated chunks => 0 air.)
// The numeric ids below (0-29) mirror that table exactly — "DO NOT modify
// the IDs" applies here too, since spawnRules/loot/etc may reference them
// symbolically via BLOCK_ID.
//
// Legacy string ids ('air', 'threadstone', 'warpgrass', 'cinderrock',
// 'looseweave', 'water', 'void') are kept as back-compat aliases only, for
// any old StubWorld usages / tests written before this reconciliation. New
// code should use the numeric ids (or the BLOCK_ID name->id map below).
//
// *** POLICY CHANGE ***
// The previous version of this file treated unknown/unlisted ids as
// solid:true ("safer to assume solid so mobs don't fall through"). The real
// getBlockDef treats unknown/out-of-range ids as AIR (solid:false) — see the
// builder's blocks.js. To reconcile, this fallback now matches production:
// unknown/undefined/null id => air def (solid:false). Callers that want a
// different failure mode for broken/throwing lookups (e.g. MobManager's
// isSolid wrapper) should handle that themselves; this function's contract
// is now "mirror the real getBlockDef", not "be maximally safe for physics".
// ============================================================================

// ----------------------------------------------------------------------
// Real numeric block ids (0-29), mirroring public/src/blocks/blocks.js on
// branch feat/voxel-sandbox-game. DO NOT modify the IDs.
// ----------------------------------------------------------------------
export const BLOCK_ID = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  COBBLESTONE: 4,
  SAND: 5,
  SANDSTONE: 6,
  GRAVEL: 7,
  WATER: 8,
  LOG: 9,
  LEAVES: 10,
  PLANKS: 11,
  GLASS: 12,
  COAL_ORE: 13,
  IRON_ORE: 14,
  GOLD_ORE: 15,
  DIAMOND_ORE: 16,
  BEDROCK: 17,
  SNOW_BLOCK: 18,
  SNOW_GRASS: 19,
  CACTUS: 20,
  RED_SAND: 21,
  NETHERRACK: 22,
  SOUL_SAND: 23,
  GLOWSTONE: 24,
  OBSIDIAN: 25,
  END_STONE: 26,
  PURPUR: 27,
  LAVA: 28,
  PORTAL: 29,
};

// name -> numeric id, lowercase-keyed (same info as BLOCK_ID, but handy for
// callers that already have a lowercase string, e.g. legacy alias lookups).
export const BLOCK_NAME_TO_ID = Object.freeze(
  Object.fromEntries(Object.entries(BLOCK_ID).map(([k, v]) => [k.toLowerCase(), v]))
);

// ----------------------------------------------------------------------
// def(id, name, solid, transparent, liquid, emissive, hardness, tool)
// Shape matches the real getBlockDef() return value exactly:
//   { id, name, solid, transparent, liquid, emissive, hardness, tool }
// (tiles is intentionally omitted here — this fallback has no texture
// atlas; real defs include it, callers that need it must use the
// injected real getBlockDef.)
// ----------------------------------------------------------------------
function def(id, name, solid, transparent = false, liquid = false, emissive = 0, hardness = 1, tool = '') {
  return { id, name, solid, transparent, liquid, emissive, hardness, tool };
}

// Numeric block table (0-29), values matching the real block table.
const NUMERIC_TABLE = {
  0: def(0, 'air', false, true, false, 0, 0, ''),
  1: def(1, 'grass', true, false, false, 0, 0.6, 'shovel'),
  2: def(2, 'dirt', true, false, false, 0, 0.5, 'shovel'),
  3: def(3, 'stone', true, false, false, 0, 1.5, 'pickaxe'),
  4: def(4, 'cobblestone', true, false, false, 0, 2.0, 'pickaxe'),
  5: def(5, 'sand', true, false, false, 0, 0.5, 'shovel'),
  6: def(6, 'sandstone', true, false, false, 0, 0.8, 'pickaxe'),
  7: def(7, 'gravel', true, false, false, 0, 0.6, 'shovel'),
  8: def(8, 'water', false, true, true, 0, 0, ''),
  9: def(9, 'log', true, false, false, 0, 2.0, 'axe'),
  10: def(10, 'leaves', true, true, false, 0, 0.2, ''),
  11: def(11, 'planks', true, false, false, 0, 2.0, 'axe'),
  12: def(12, 'glass', true, true, false, 0, 0.3, ''),
  13: def(13, 'coal_ore', true, false, false, 0, 3.0, 'pickaxe'),
  14: def(14, 'iron_ore', true, false, false, 0, 3.0, 'pickaxe'),
  15: def(15, 'gold_ore', true, false, false, 0, 3.0, 'pickaxe'),
  16: def(16, 'diamond_ore', true, false, false, 0, 3.0, 'pickaxe'),
  17: def(17, 'bedrock', true, false, false, 0, Infinity, 'pickaxe'),
  18: def(18, 'snow_block', true, false, false, 0, 0.5, 'shovel'),
  19: def(19, 'snow_grass', true, false, false, 0, 0.6, 'shovel'),
  20: def(20, 'cactus', true, false, false, 0, 0.4, ''),
  21: def(21, 'red_sand', true, false, false, 0, 0.5, 'shovel'),
  22: def(22, 'netherrack', true, false, false, 0, 0.4, 'pickaxe'),
  23: def(23, 'soul_sand', true, false, false, 0, 0.5, 'shovel'),
  24: def(24, 'glowstone', true, false, false, 15, 0.3, ''),
  25: def(25, 'obsidian', true, false, false, 0, 50.0, 'pickaxe'),
  26: def(26, 'end_stone', true, false, false, 0, 3.0, 'pickaxe'),
  27: def(27, 'purpur', true, false, false, 0, 1.5, 'pickaxe'),
  28: def(28, 'lava', false, false, true, 15, 0, ''),
  29: def(29, 'portal', false, true, false, 11, 0, ''),
};

// Legacy string-id aliases (pre-reconciliation Loomfall placeholder names),
// kept ONLY for back-compat with old StubWorld/tests. Mapped onto the
// closest real-id semantics so solidity/etc stays sane.
const LEGACY_ALIASES = {
  'air': NUMERIC_TABLE[0],
  'threadstone': def('threadstone', 'threadstone', true, false, false, 0, 1.5, 'pickaxe'),
  'warpgrass': def('warpgrass', 'warpgrass', true, false, false, 0, 0.6, 'shovel'),
  'cinderrock': def('cinderrock', 'cinderrock', true, false, false, 0, 1.5, 'pickaxe'),
  'looseweave': def('looseweave', 'looseweave', true, false, false, 0, 0.6, 'shovel'),
  'water': def('water', 'water', false, true, true, 0, 0, ''),
  'void': def('void', 'void', false, true, false, 0, 0, ''),
};

// Air def, returned for unknown/undefined/out-of-range/null ids — matches
// the real getBlockDef's OOB/unknown-id policy. See "POLICY CHANGE" note
// above.
const AIR_DEF = NUMERIC_TABLE[0];

/**
 * getBlockDef(id) -> { id, name, solid, transparent, liquid, emissive,
 *                       hardness, tool }
 *
 * Fallback-only lookup, shaped to match the real (production) getBlockDef.
 * Accepts either a numeric id (0-29, real ids) or a legacy string id
 * (back-compat aliases, see LEGACY_ALIASES). Unknown/unlisted ids, and
 * null/undefined, all resolve to the air def (solid:false) — this MATCHES
 * the real getBlockDef's policy of treating unknown/OOB ids as air, and is
 * a change from this file's previous "unknown => solid:true" behavior.
 */
export function getBlockDef(id) {
  if (id === null || id === undefined) {
    return AIR_DEF;
  }

  if (typeof id === 'number') {
    const found = NUMERIC_TABLE[id];
    return found || AIR_DEF;
  }

  // String id: try legacy alias table first, then fall back to treating a
  // numeric-looking string as its numeric id (defensive; real world never
  // sends strings, but old test doubles might).
  const alias = LEGACY_ALIASES[id];
  if (alias) return alias;

  const asNumber = Number(id);
  if (Number.isFinite(asNumber) && NUMERIC_TABLE[asNumber]) {
    return NUMERIC_TABLE[asNumber];
  }

  return AIR_DEF;
}

export default { getBlockDef, BLOCK_ID, BLOCK_NAME_TO_ID };
