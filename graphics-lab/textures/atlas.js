// graphics-lab/textures/atlas.js
//
// Loomfall procedural texture atlas — drop-in match for the builder contract
// in origin/feat/voxel-sandbox-game:public/src/textures/TextureAtlas.js.
//
// buildAtlas(packId) draws every tile in TILE_NAMES into one canvas using the
// requested texture pack (packs.js) and wraps it in a THREE.CanvasTexture
// ready for chunk materials.
//
// ============================== UV CONVENTION ==============================
// The texture is a THREE.CanvasTexture with the three.js DEFAULT flipY=true.
// That means canvas row 0 (the TOP of the canvas, where atlas row 0 lives)
// is uploaded to GL v=1 — i.e. canvas-up == GL-v-up after the flip.
//
// tileUV(name) returns {u0, v0, u1, v1} in [0,1] where:
//   (u0, v0) = BOTTOM-LEFT  of the tile in GL UV space
//   (u1, v1) = TOP-RIGHT    of the tile in GL UV space
// so u0 < u1 and v0 < v1, always.
//
// Canvas-space TOP of the tile art maps to v1 (the GL top). Painters draw
// "block top" detail (grass fringe, snow cap) at canvas y=0, so meshers can
// assign v1 to the upper edge of side faces and the art lands right side up.
//
// A HALF-TEXEL INSET (0.5px on every edge) is baked into the returned UVs so
// neighboring atlas tiles never bleed at tile borders under NearestFilter.
// ===========================================================================
//
// Browser module (imports `three`, uses document.createElement('canvas')).
// The pure parts (painters/packs/palettes/packFormat) are node-safe; node
// selftests exercise them through the software canvas shim in selftest.mjs.

import * as THREE from 'three';
import { TILE_NAMES, makeRng } from './painters.js';
import { TILE_PX, ATLAS_COLS } from './packFormat.js';
import { PACK_REGISTRY } from './packs.js';

export { TILE_NAMES, makeRng, TILE_PX, ATLAS_COLS, PACK_REGISTRY };

const TILE_INDEX = new Map(TILE_NAMES.map((n, i) => [n, i]));
const warned = new Set();

function warnUnknown(name) {
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(`atlas: unknown tile name "${name}" — falling back to index 0 (${TILE_NAMES[0]})`);
  }
}

/**
 * Build the atlas for a pack.
 * @param {string} packId one of Object.keys(PACK_REGISTRY); falls back to 'default'
 * @param {number|string} seed extra determinism seed (default 0)
 * @returns {{ canvas, texture, tileUV(name), tileIndex(name), cols, tilePx }}
 */
export function buildAtlas(packId = 'default', seed = 0) {
  const pack = PACK_REGISTRY[packId] || PACK_REGISTRY.default;
  const cols = ATLAS_COLS;
  const tilePx = TILE_PX;
  const rows = Math.ceil(TILE_NAMES.length / cols);

  const canvas = document.createElement('canvas');
  canvas.width = cols * tilePx;
  canvas.height = rows * tilePx;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  // Tiles render into a scratch canvas, then blit. (Painters' overlay passes
  // use getImageData/putImageData, which ignore transforms/clips — a scratch
  // surface keeps them tile-local instead of stomping the atlas corner.)
  const scratch = document.createElement('canvas');
  scratch.width = tilePx;
  scratch.height = tilePx;
  const sctx = scratch.getContext('2d');
  sctx.imageSmoothingEnabled = false;

  for (let i = 0; i < TILE_NAMES.length; i++) {
    const name = TILE_NAMES[i];
    const x = (i % cols) * tilePx;
    const y = Math.floor(i / cols) * tilePx;
    // Seed per (pack, tile, seed): the same tile always renders identically.
    pack.drawTile(sctx, name, tilePx, makeRng(`${pack.id}:${name}:${seed}`));
    ctx.clearRect(x, y, tilePx, tilePx);
    ctx.drawImage(scratch, x, y);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true; // three default; stated for the contract
  texture.needsUpdate = true;

  const W = canvas.width;
  const H = canvas.height;

  function tileIndex(name) {
    const i = TILE_INDEX.get(name);
    if (i === undefined) {
      warnUnknown(name);
      return 0;
    }
    return i;
  }

  function tileUV(name) {
    const i = tileIndex(name);
    const x0 = (i % cols) * tilePx;           // canvas px, from left
    const y0 = Math.floor(i / cols) * tilePx; // canvas px, from TOP
    // Half-texel inset on every edge; v measured bottom-up (flipY, see note).
    return {
      u0: (x0 + 0.5) / W,
      v0: (H - y0 - tilePx + 0.5) / H,
      u1: (x0 + tilePx - 0.5) / W,
      v1: (H - y0 - 0.5) / H,
    };
  }

  return { canvas, texture, tileUV, tileIndex, cols, tilePx };
}

// ---------------------------------------------------------------------------
// Block-id -> tiles map, replicating the builder's blocks.js (ids 0-29 frozen,
// origin/feat/voxel-sandbox-game:public/src/blocks/blocks.js) and its
// tileForFace fallback semantics: {all} | {top,bottom,side}, side->top->bottom.
// ---------------------------------------------------------------------------
export const BLOCK_TILES = {
  0: { name: 'air', tiles: null },
  1: { name: 'grass', tiles: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' } },
  2: { name: 'dirt', tiles: { all: 'dirt' } },
  3: { name: 'stone', tiles: { all: 'stone' } },
  4: { name: 'cobblestone', tiles: { all: 'cobblestone' } },
  5: { name: 'sand', tiles: { all: 'sand' } },
  6: { name: 'sandstone', tiles: { top: 'sandstone_top', side: 'sandstone', bottom: 'sandstone_top' } },
  7: { name: 'gravel', tiles: { all: 'gravel' } },
  8: { name: 'water', tiles: { all: 'water' } },
  9: { name: 'log', tiles: { top: 'log_top', side: 'log_side', bottom: 'log_top' } },
  10: { name: 'leaves', tiles: { all: 'leaves' } },
  11: { name: 'planks', tiles: { all: 'planks' } },
  12: { name: 'glass', tiles: { all: 'glass' } },
  13: { name: 'coal_ore', tiles: { all: 'coal_ore' } },
  14: { name: 'iron_ore', tiles: { all: 'iron_ore' } },
  15: { name: 'gold_ore', tiles: { all: 'gold_ore' } },
  16: { name: 'diamond_ore', tiles: { all: 'diamond_ore' } },
  17: { name: 'bedrock', tiles: { all: 'bedrock' } },
  18: { name: 'snow_block', tiles: { all: 'snow' } },
  19: { name: 'snow_grass', tiles: { top: 'snow', side: 'snow_side', bottom: 'dirt' } },
  20: { name: 'cactus', tiles: { top: 'cactus_top', side: 'cactus_side', bottom: 'cactus_top' } },
  21: { name: 'red_sand', tiles: { all: 'red_sand' } },
  22: { name: 'netherrack', tiles: { all: 'netherrack' } },
  23: { name: 'soul_sand', tiles: { all: 'soul_sand' } },
  24: { name: 'glowstone', tiles: { all: 'glowstone' } },
  25: { name: 'obsidian', tiles: { all: 'obsidian' } },
  26: { name: 'end_stone', tiles: { all: 'end_stone' } },
  27: { name: 'purpur', tiles: { all: 'purpur' } },
  28: { name: 'lava', tiles: { all: 'lava' } },
  29: { name: 'portal', tiles: { all: 'portal' } },
};

/** Resolve the tile name for a face: 'top' | 'bottom' | 'side'. */
export function tileForFace(blockDef, face) {
  const t = blockDef && blockDef.tiles;
  if (!t) return null;
  if (t.all != null) return t.all;
  return t[face] ?? t.side ?? t.top ?? t.bottom ?? null;
}

/**
 * Render a single 32x32 canvas for a block's 'side' tile.
 * @param {number} blockId builder block id (0-29)
 * @param {string} packId pack id; falls back to 'default'
 * @param {number|string} seed determinism seed (matches buildAtlas(packId, seed))
 * @returns {HTMLCanvasElement} 32x32 canvas (transparent for air/unknown ids)
 */
export function genTexture(blockId, packId = 'default', seed = 0) {
  const pack = PACK_REGISTRY[packId] || PACK_REGISTRY.default;
  const canvas = document.createElement('canvas');
  canvas.width = TILE_PX;
  canvas.height = TILE_PX;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const def = BLOCK_TILES[blockId];
  const tile = tileForFace(def, 'side');
  if (tile != null) {
    pack.drawTile(ctx, tile, TILE_PX, makeRng(`${pack.id}:${tile}:${seed}`));
  }
  return canvas;
}
