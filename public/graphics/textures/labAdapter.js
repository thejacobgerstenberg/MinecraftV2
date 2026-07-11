// graphics-lab/textures/labAdapter.js
//
// Bridge: Loomfall texture packs (textures/atlas.js buildAtlas) -> the lab
// demo's atlas contract (src/textures.js createBlockAtlas), so the pack
// atlases drive voxelMesher / greedyMesher / voxelMaterial / viewmodel
// UNCHANGED.
//
//   createPackAtlas(packId, seed?) -> {
//     texture, canvas, tileUV(name), faceTile(blockId, face),
//     TILES, FACE_TILE, tileSizePx, atlasSizePx, texelSize,
//     packId, packCanvas, tileIndex(name),
//   }
//
// ======================= ADAPTER MATH (why, exactly) =======================
// 1. INSET: buildAtlas().tileUV bakes a half-texel inset into its rects, but
//    every lab consumer applies its own half-texel inset on top of RAW rects:
//      - voxelMesher.buildAtlasLUTs: inset = atlas.texelSize * 0.5
//      - greedyMesher/voxelMaterial tiled shader: sampleUV = tileOrigin +
//        uTileInset + fract(uv) * (uTileSizeUV - 2*uTileInset)  (tileOrigin
//        documented as the RAW, un-inset rect origin)
//      - viewmodel._remapBoxUVs: inset = texelSize * 0.5
//    Feeding them the pack's pre-inset rects would DOUBLE-inset (visible
//    zoom-in / edge crop on every tile). So tileUV() here returns RAW rects
//    recomputed from the tile index — the pack's baked inset is not used.
//
// 2. SQUARE RE-LAYOUT: the pack atlas is 16 cols x 32px = 512x128 (NON-square,
//    ceil(55/16) = 4 rows). The tiled material's uniforms are SCALARS
//    (uTileSizeUV = tileSizePx/atlasSizePx, uTileInset = texelSize*0.5) applied
//    to BOTH u and v — correct only when tile spans match on both axes, i.e.
//    a square atlas. So the pack canvas is re-blitted 1:1 (no scaling,
//    imageSmoothing off) into an 8-col 256x256 square canvas; every reported
//    dimension (tileSizePx 32, atlasSizePx 256, texelSize 1/256) is then
//    consistent on both axes for every consumer.
//
// 3. FLIP: none needed. Both atlases are THREE.CanvasTexture with the default
//    flipY=true and both report tileUV with v measured bottom-up where v1 =
//    the TOP of the tile art (grass fringe / block-top detail at canvas y=0).
//    The re-blit preserves canvas orientation, so the lab meshers' "tile up ==
//    world +Y" side-face mapping keeps art upright with no extra transform.
// ===========================================================================

import * as THREE from 'three';
import { buildAtlas, TILE_NAMES, TILE_PX, ATLAS_COLS, PACK_REGISTRY } from './atlas.js';
import {
  GRASS, DIRT, STONE, SAND, WOOD, LEAVES, WATER, PLANK, GLOWSTONE, SNOW,
} from '../src/blocks.js';

export { PACK_REGISTRY };

// Square re-layout geometry: 8 cols x 8 rows of 32px tiles = 256x256 holds all
// 55 pack tiles (indices preserved; layout differs from the pack canvas only
// in column count).
const SQ_COLS = 8;
const SQ_SIZE = SQ_COLS * TILE_PX; // 256

// Lab block id -> pack tile names, mirroring src/textures.js FACE_TILE but in
// the pack tile vocabulary (underscore names from textures/painters.js).
export const LAB_FACE_TILE = {
  [GRASS]:     { top: 'grass_top', side: 'grass_side', bottom: 'dirt' },
  [DIRT]:      { top: 'dirt', side: 'dirt', bottom: 'dirt' },
  [STONE]:     { top: 'stone', side: 'stone', bottom: 'stone' },
  [SAND]:      { top: 'sand', side: 'sand', bottom: 'sand' },
  [WOOD]:      { top: 'log_top', side: 'log_side', bottom: 'log_top' },
  [LEAVES]:    { top: 'leaves', side: 'leaves', bottom: 'leaves' },
  [WATER]:     { top: 'water', side: 'water', bottom: 'water' },
  [PLANK]:     { top: 'planks', side: 'planks', bottom: 'planks' },
  [GLOWSTONE]: { top: 'glowstone', side: 'glowstone', bottom: 'glowstone' },
  [SNOW]:      { top: 'snow', side: 'snow', bottom: 'snow' },
};

// Lab dash-style tile names (src/textures.js TILES) -> pack tile names, so any
// caller still holding a lab name resolves to the equivalent pack tile.
export const LAB_TILE_ALIASES = {
  'grass-top': 'grass_top',
  'grass-side': 'grass_side',
  'wood-bark': 'log_side',
  'wood-top': 'log_top',
  'plank': 'planks',
  // dirt / stone / sand / leaves / glowstone / snow / water: same name.
};

const SQ_TILE_INDEX = new Map(TILE_NAMES.map((n, i) => [n, i]));

/**
 * Build a pack-backed atlas exposing EXACTLY the createBlockAtlas() shape.
 * @param {string} packId key of PACK_REGISTRY ('default'|'smooth'|'gritty'|
 *   'woven'|'accessible'); unknown ids fall back to 'default' (same as
 *   buildAtlas).
 * @param {number|string} seed determinism seed forwarded to buildAtlas.
 */
export function createPackAtlas(packId = 'default', seed = 0) {
  const pack = PACK_REGISTRY[packId] || PACK_REGISTRY.default;
  const src = buildAtlas(pack.id, seed);

  // --- Square re-blit (see ADAPTER MATH note 2) ----------------------------
  const canvas = document.createElement('canvas');
  canvas.width = SQ_SIZE;
  canvas.height = SQ_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  // Unused slots: opaque neutral grey (matches src/textures.js — any
  // accidental sample shows grey, never transparent black).
  ctx.fillStyle = '#6b6b6b';
  ctx.fillRect(0, 0, SQ_SIZE, SQ_SIZE);

  for (let i = 0; i < TILE_NAMES.length; i++) {
    const sx = (i % ATLAS_COLS) * TILE_PX;
    const sy = Math.floor(i / ATLAS_COLS) * TILE_PX;
    const dx = (i % SQ_COLS) * TILE_PX;
    const dy = Math.floor(i / SQ_COLS) * TILE_PX;
    // clearRect first so tiles with alpha holes (leaves/glass) keep them.
    ctx.clearRect(dx, dy, TILE_PX, TILE_PX);
    ctx.drawImage(src.canvas, sx, sy, TILE_PX, TILE_PX, dx, dy, TILE_PX, TILE_PX);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true; // three default; part of the UV convention above
  texture.needsUpdate = true;

  function tileIndex(name) {
    const resolved = LAB_TILE_ALIASES[name] || name;
    const i = SQ_TILE_INDEX.get(resolved);
    return i === undefined ? -1 : i;
  }

  // RAW (un-inset) rect in the square layout; v bottom-up, art top at v1
  // (see ADAPTER MATH notes 1 + 3). Returns null for unknown names so lab
  // meshers take their documented flat-colour fallback.
  function tileUV(name) {
    const i = tileIndex(name);
    if (i < 0) return null;
    const col = i % SQ_COLS;
    const row = Math.floor(i / SQ_COLS);
    return {
      u0: (col * TILE_PX) / SQ_SIZE,
      v0: 1 - ((row + 1) * TILE_PX) / SQ_SIZE,
      u1: ((col + 1) * TILE_PX) / SQ_SIZE,
      v1: 1 - (row * TILE_PX) / SQ_SIZE,
    };
  }

  function faceTile(blockId, face) {
    const m = LAB_FACE_TILE[blockId];
    if (!m) return null;
    return m[face] || m.side || null;
  }

  return {
    texture,
    canvas,
    tileUV,
    faceTile,
    TILES: TILE_NAMES,
    FACE_TILE: LAB_FACE_TILE,
    tileSizePx: TILE_PX,        // 32
    atlasSizePx: SQ_SIZE,       // 256 (square — required by the tiled shader)
    texelSize: 1 / SQ_SIZE,
    // Extras (not in the lab contract; used by the pack browser / debugging).
    packId: pack.id,
    packCanvas: src.canvas,
    tileIndex,
  };
}

export default createPackAtlas;
