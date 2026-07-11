// Voxelheim procedural texture atlas.
//
// buildAtlas(packName) draws every tile in TILE_NAMES into one canvas using
// the requested texture pack (see texturePacks.js) and wraps it in a
// THREE.CanvasTexture ready for chunk materials.
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
// assign v1 to the upper edge of side faces and the art lands right side up:
//
//   quad vertex        UV
//   ------------------------------
//   bottom-left    ->  (u0, v0)
//   bottom-right   ->  (u1, v0)
//   top-right      ->  (u1, v1)
//   top-left       ->  (u0, v1)
//
// A HALF-TEXEL INSET (0.5px on every edge) is baked into the returned UVs so
// neighboring atlas tiles never bleed at tile borders under NearestFilter.
// ===========================================================================

import * as THREE from 'three';
import { TILE_PX, ATLAS_COLS } from '../constants.js';
import { PACKS, makeRng, TILE_NAMES } from './texturePacks.js';

// Canonical ordered tile list (defined in texturePacks.js, which is a pure
// module so node tests can validate coverage; re-exported here per contract).
export { TILE_NAMES };

const TILE_INDEX = new Map(TILE_NAMES.map((n, i) => [n, i]));
const warned = new Set();

/**
 * Build the atlas for a pack.
 * @param {string} packName one of Object.keys(PACKS); falls back to 'default'
 * @returns {{ canvas, texture, tileUV(name), tileIndex(name), cols, tilePx }}
 */
export function buildAtlas(packName = 'default') {
  const pack = PACKS[packName] || PACKS.default;
  const cols = ATLAS_COLS;
  const tilePx = TILE_PX;
  const rows = Math.ceil(TILE_NAMES.length / cols);

  const canvas = document.createElement('canvas');
  canvas.width = cols * tilePx;
  canvas.height = rows * tilePx;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  for (let i = 0; i < TILE_NAMES.length; i++) {
    const name = TILE_NAMES[i];
    const x = (i % cols) * tilePx;
    const y = Math.floor(i / cols) * tilePx;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.rect(0, 0, tilePx, tilePx);
    ctx.clip();
    // Seed per (pack, tile): the same tile always renders identically.
    pack.drawTile(ctx, name, tilePx, makeRng(`${pack.id}:${name}`));
    ctx.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const W = canvas.width;
  const H = canvas.height;

  function tileIndex(name) {
    const i = TILE_INDEX.get(name);
    if (i === undefined) {
      if (!warned.has(name)) {
        warned.add(name);
        console.warn(`TextureAtlas: unknown tile name "${name}"`);
      }
      return 0;
    }
    return i;
  }

  function tileUV(name) {
    const i = tileIndex(name);
    const x0 = (i % cols) * tilePx;        // canvas px, from left
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
