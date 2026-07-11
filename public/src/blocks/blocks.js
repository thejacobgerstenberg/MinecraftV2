// Voxelheim block registry (foundation — DO NOT modify the IDs).
//
// Each block definition has the shape:
//   { id, name, tiles: {top, bottom, side} | {all}, solid, transparent,
//     liquid, emissive (0-15), hardness, tool }
//
// Tile values are STRING tile names consumed by the texture atlas. They must
// match the TILE_NAMES list declared in CONTRACT.md / TextureAtlas.js.
// `hardness` of -1 means unbreakable. `tool` is the preferred tool type.

/**
 * Internal helper to build a normalized block definition.
 * Accepts either a single `all` tile or explicit top/bottom/side tiles.
 */
function def(id, name, opts = {}) {
  const {
    all,
    top,
    bottom,
    side,
    solid = true,
    transparent = false,
    liquid = false,
    emissive = 0,
    hardness = 1,
    tool = 'none',
  } = opts;

  let tiles;
  if (all != null) {
    tiles = { all };
  } else {
    tiles = {
      top: top ?? side ?? all,
      bottom: bottom ?? side ?? all,
      side: side ?? all,
    };
  }

  return { id, name, tiles, solid, transparent, liquid, emissive, hardness, tool };
}

/**
 * Resolve the tile name for a given face of a block definition.
 * `face` is one of 'top' | 'bottom' | 'side'. Falls back gracefully.
 */
export function tileForFace(blockDef, face) {
  const t = blockDef.tiles;
  if (!t) return null;
  if (t.all != null) return t.all;
  return t[face] ?? t.side ?? t.top ?? t.bottom ?? null;
}

// Array indexed by block id. Order matters — ids are part of the contract.
export const BLOCKS = [
  def(0, 'air', { solid: false, transparent: true, hardness: 0, tool: 'none' }),
  def(1, 'grass', { top: 'grass_top', side: 'grass_side', bottom: 'dirt', hardness: 0.6, tool: 'shovel' }),
  def(2, 'dirt', { all: 'dirt', hardness: 0.5, tool: 'shovel' }),
  def(3, 'stone', { all: 'stone', hardness: 1.5, tool: 'pickaxe' }),
  def(4, 'cobblestone', { all: 'cobblestone', hardness: 2.0, tool: 'pickaxe' }),
  def(5, 'sand', { all: 'sand', hardness: 0.5, tool: 'shovel' }),
  def(6, 'sandstone', { top: 'sandstone_top', side: 'sandstone', bottom: 'sandstone_top', hardness: 0.8, tool: 'pickaxe' }),
  def(7, 'gravel', { all: 'gravel', hardness: 0.6, tool: 'shovel' }),
  def(8, 'water', { all: 'water', solid: false, transparent: true, liquid: true, hardness: -1, tool: 'none' }),
  def(9, 'log', { top: 'log_top', side: 'log_side', bottom: 'log_top', hardness: 2.0, tool: 'axe' }),
  def(10, 'leaves', { all: 'leaves', transparent: true, hardness: 0.2, tool: 'shears' }),
  def(11, 'planks', { all: 'planks', hardness: 2.0, tool: 'axe' }),
  def(12, 'glass', { all: 'glass', transparent: true, hardness: 0.3, tool: 'none' }),
  def(13, 'coal_ore', { all: 'coal_ore', hardness: 3.0, tool: 'pickaxe' }),
  def(14, 'iron_ore', { all: 'iron_ore', hardness: 3.0, tool: 'pickaxe' }),
  def(15, 'gold_ore', { all: 'gold_ore', hardness: 3.0, tool: 'pickaxe' }),
  def(16, 'diamond_ore', { all: 'diamond_ore', hardness: 3.0, tool: 'pickaxe' }),
  def(17, 'bedrock', { all: 'bedrock', hardness: -1, tool: 'none' }),
  def(18, 'snow_block', { all: 'snow', hardness: 0.2, tool: 'shovel' }),
  def(19, 'snow_grass', { top: 'snow', side: 'snow_side', bottom: 'dirt', hardness: 0.6, tool: 'shovel' }),
  def(20, 'cactus', { top: 'cactus_top', side: 'cactus_side', bottom: 'cactus_top', hardness: 0.4, tool: 'none' }),
  def(21, 'red_sand', { all: 'red_sand', hardness: 0.5, tool: 'shovel' }),
  def(22, 'netherrack', { all: 'netherrack', hardness: 0.4, tool: 'pickaxe' }),
  def(23, 'soul_sand', { all: 'soul_sand', hardness: 0.5, tool: 'shovel' }),
  def(24, 'glowstone', { all: 'glowstone', emissive: 15, hardness: 0.3, tool: 'none' }),
  def(25, 'obsidian', { all: 'obsidian', hardness: 50, tool: 'pickaxe' }),
  def(26, 'end_stone', { all: 'end_stone', hardness: 3.0, tool: 'pickaxe' }),
  def(27, 'purpur', { all: 'purpur', hardness: 1.5, tool: 'pickaxe' }),
  def(28, 'lava', { all: 'lava', solid: false, transparent: true, liquid: true, emissive: 15, hardness: -1, tool: 'none' }),
];

// Fast id -> name and name -> id lookups.
export const BLOCK_ID = {};
for (const b of BLOCKS) BLOCK_ID[b.name] = b.id;

/**
 * Return the block definition for a given id. Unknown ids resolve to air.
 */
export function getBlockDef(id) {
  return BLOCKS[id] || BLOCKS[0];
}

// Blocks the player can place from the creative palette. Excludes air.
// Water and lava are included at the end so builders can use them too.
export const CREATIVE_BLOCKS = [
  1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17,
  18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 8, 28,
];
