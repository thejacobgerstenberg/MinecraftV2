// graphics-lab/src/textures.js
//
// Procedural 16x16 pixel block textures, packed into ONE atlas built on an
// offscreen canvas at load time. Fully deterministic (seeded PRNG — never a
// bare Math.random) so every run produces identical pixels.
//
//   createBlockAtlas({ seed? }) -> {
//     texture,        // THREE.CanvasTexture, NearestFilter, no mipmaps
//     canvas,         // the backing canvas (debug / inspection)
//     tileUV(name),   // -> { u0, v0, u1, v1 } raw tile bounds (v respects flipY)
//     faceTile(id, face), // blockId + 'top'|'side'|'bottom' -> tile name
//     TILES,          // ordered tile-name list
//     FACE_TILE,      // blockId -> { top, side, bottom } tile-name map
//     tileSizePx, atlasSizePx, texelSize,
//   }
//
// The mesher (voxelMesher.js) consumes this via buildChunkGeometry(volume,
// { atlas }) — it looks up faceTile()/tileUV() per emitted face and insets the
// UVs by half a texel to prevent atlas bleeding.
//
// Atlas layout: 4x4 grid of 16x16 tiles on a 64x64 power-of-two canvas.
// Filtering is Nearest + generateMipmaps=false: crisp "big pixel" Minecraft
// look with zero cross-tile mip bleeding.

import * as THREE from 'three';
import {
  GRASS, DIRT, STONE, SAND, WOOD, LEAVES, WATER, PLANK, GLOWSTONE, SNOW,
} from './blocks.js';

export const TILE_SIZE = 16;
const ATLAS_COLS = 4;
export const ATLAS_SIZE = TILE_SIZE * ATLAS_COLS; // 64 (4x4 tiles)

// Tile order === atlas slot order (left-to-right, top-to-bottom).
export const TILES = [
  'grass-top', 'grass-side', 'dirt', 'stone',
  'sand', 'wood-bark', 'wood-top', 'leaves',
  'plank', 'glowstone', 'snow', 'water',
];

// blockId -> which tile each face bucket uses.
export const FACE_TILE = {
  [GRASS]:     { top: 'grass-top', side: 'grass-side', bottom: 'dirt' },
  [DIRT]:      { top: 'dirt', side: 'dirt', bottom: 'dirt' },
  [STONE]:     { top: 'stone', side: 'stone', bottom: 'stone' },
  [SAND]:      { top: 'sand', side: 'sand', bottom: 'sand' },
  [WOOD]:      { top: 'wood-top', side: 'wood-bark', bottom: 'wood-top' },
  [LEAVES]:    { top: 'leaves', side: 'leaves', bottom: 'leaves' },
  [WATER]:     { top: 'water', side: 'water', bottom: 'water' },
  [PLANK]:     { top: 'plank', side: 'plank', bottom: 'plank' },
  [GLOWSTONE]: { top: 'glowstone', side: 'glowstone', bottom: 'glowstone' },
  [SNOW]:      { top: 'snow', side: 'snow', bottom: 'snow' },
};

// --- Deterministic PRNG (mulberry32) -----------------------------------------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Per-tile pixel painters ---------------------------------------------------
// Each painter fills ALL 256 pixels of a 16x16 tile through set(x,y,r,g,b,a).
// They only consume the tile-local seeded rng, so tiles are order-independent.

function dirtPixel(rng) {
  const r = rng();
  let c;
  if (r < 0.58) c = [134, 96, 67];
  else if (r < 0.76) c = [121, 85, 58];
  else if (r < 0.88) c = [150, 108, 74];
  else if (r < 0.95) c = [106, 73, 49];
  else c = [163, 120, 84];
  const j = (rng() - 0.5) * 12;
  return [c[0] + j, c[1] + j, c[2] + j];
}

function paintGrassTop(set, rng) {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const r = rng();
      let c;
      if (r < 0.5) c = [106, 170, 64];        // vivid base green
      else if (r < 0.76) c = [95, 156, 56];   // mid
      else if (r < 0.9) c = [118, 183, 74];   // bright blade
      else c = [82, 136, 46];                 // dark speckle
      const j = (rng() - 0.5) * 10;
      set(x, y, c[0] + j, c[1] + j, c[2] + j);
    }
  }
}

function paintGrassSide(set, rng) {
  // Ragged green fringe (2..4 px deep per column) over dirt.
  const depth = [];
  for (let x = 0; x < 16; x++) depth.push(2 + Math.floor(rng() * 3));
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (y < depth[x]) {
        const r = rng();
        let c = r < 0.5 ? [100, 162, 60] : r < 0.85 ? [90, 150, 52] : [112, 176, 68];
        if (y === depth[x] - 1) c = [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8]; // shadowed lip
        set(x, y, c[0], c[1], c[2]);
      } else {
        const c = dirtPixel(rng);
        set(x, y, c[0], c[1], c[2]);
      }
    }
  }
}

function paintDirt(set, rng) {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const c = dirtPixel(rng);
      set(x, y, c[0], c[1], c[2]);
    }
  }
}

function paintStone(set, rng) {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const r = rng();
      let g;
      if (r < 0.48) g = 127;
      else if (r < 0.74) g = 118;
      else if (r < 0.9) g = 137;
      else g = 106;
      const j = (rng() - 0.5) * 8;
      set(x, y, g + j, g + j, g + j + 4); // faint cool cast
    }
  }
  // Subtle cracks: three short darker random walks.
  for (let c = 0; c < 3; c++) {
    let x = Math.floor(rng() * 16);
    let y = Math.floor(rng() * 16);
    const len = 4 + Math.floor(rng() * 5);
    for (let i = 0; i < len; i++) {
      set(x & 15, y & 15, 92, 92, 98);
      x += rng() < 0.5 ? 1 : rng() < 0.5 ? -1 : 0;
      y += rng() < 0.7 ? 1 : 0;
    }
  }
}

function paintSand(set, rng) {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const r = rng();
      let c;
      if (r < 0.55) c = [218, 205, 160];
      else if (r < 0.76) c = [227, 214, 170];
      else if (r < 0.93) c = [203, 189, 145];
      else c = [233, 222, 180];
      const j = (rng() - 0.5) * 8;
      set(x, y, c[0] + j, c[1] + j, c[2] + j);
    }
  }
}

function paintWoodBark(set, rng) {
  // Vertical grain: per-column brightness + per-pixel jitter.
  const colShade = [];
  for (let x = 0; x < 16; x++) colShade.push(0.8 + rng() * 0.32);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const s = colShade[x] * (0.93 + rng() * 0.14);
      set(x, y, 106 * s, 79 * s, 47 * s);
    }
  }
  // A few darker vertical streaks + knots.
  for (let k = 0; k < 3; k++) {
    const x = Math.floor(rng() * 16);
    const y0 = Math.floor(rng() * 8);
    const len = 5 + Math.floor(rng() * 8);
    for (let y = y0; y < Math.min(16, y0 + len); y++) set(x, y, 64, 47, 27);
  }
  for (let k = 0; k < 2; k++) {
    set(Math.floor(rng() * 16), Math.floor(rng() * 16), 56, 41, 24);
  }
}

function paintWoodTop(set, rng) {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const dx = x - 7.5;
      const dy = y - 7.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      let c;
      if (d > 7.2) c = [104, 78, 46]; // bark rim
      else {
        const ring = Math.floor(d * 1.6 + rng() * 0.35) % 2;
        c = ring ? [150, 111, 63] : [187, 148, 92];
      }
      const j = (rng() - 0.5) * 10;
      set(x, y, c[0] + j, c[1] + j, c[2] + j);
    }
  }
}

function paintLeaves(set, rng) {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const r = rng();
      if (r < 0.08) { set(x, y, 0, 0, 0, 0); continue; } // transparent hole
      let c;
      if (r < 0.45) c = [52, 96, 34];
      else if (r < 0.74) c = [44, 86, 30];
      else if (r < 0.92) c = [64, 113, 42];
      else c = [33, 69, 23];
      const j = (rng() - 0.5) * 10;
      set(x, y, c[0] + j, c[1] + j, c[2] + j);
    }
  }
}

function paintPlank(set, rng) {
  // 4px-tall boards, dark seams every 4th row, one staggered joint per board.
  const joints = [];
  for (let b = 0; b < 4; b++) joints.push(Math.floor(rng() * 16));
  for (let y = 0; y < 16; y++) {
    const band = y >> 2;
    for (let x = 0; x < 16; x++) {
      const seam = (y & 3) === 3;
      const joint = x === joints[band] && !seam;
      if (seam || joint) { set(x, y, 96, 70, 40); continue; }
      // Horizontal grain: brighter middle row per board + streak flecks.
      let tone = 0.94 + ((y & 3) === 1 ? 0.06 : 0) + rng() * 0.08;
      if (rng() < 0.08) tone *= 0.85;
      set(x, y, 178 * tone, 140 * tone, 88 * tone);
    }
  }
}

function paintGlowstone(set, rng) {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const j = (rng() - 0.5) * 16;
      set(x, y, 140 + j, 101 + j, 57 + j * 0.6); // ochre base
    }
  }
  // Bright yellow diamond blobs.
  for (let i = 0; i < 9; i++) {
    const bx = Math.floor(rng() * 16);
    const by = Math.floor(rng() * 16);
    const rad = rng() < 0.4 ? 2 : 1;
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > rad) continue;
        const core = dx === 0 && dy === 0;
        set((bx + dx) & 15, (by + dy) & 15,
          core ? 255 : 243, core ? 226 : 194, core ? 132 : 98);
      }
    }
  }
}

function paintSnow(set, rng) {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const r = rng();
      let c;
      if (r < 0.66) c = [238, 242, 248];
      else if (r < 0.84) c = [247, 250, 254];
      else if (r < 0.95) c = [226, 232, 242];
      else c = [255, 255, 255]; // sparkle
      set(x, y, c[0], c[1], c[2]);
    }
  }
}

function paintWater(set, rng) {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const r = rng();
      let c;
      if (r < 0.62) c = [47, 108, 176];
      else if (r < 0.82) c = [55, 118, 186];
      else if (r < 0.94) c = [40, 96, 162];
      else c = [66, 130, 196]; // ripple glint
      set(x, y, c[0], c[1], c[2]);
    }
  }
}

const PAINTERS = {
  'grass-top': paintGrassTop,
  'grass-side': paintGrassSide,
  'dirt': paintDirt,
  'stone': paintStone,
  'sand': paintSand,
  'wood-bark': paintWoodBark,
  'wood-top': paintWoodTop,
  'leaves': paintLeaves,
  'plank': paintPlank,
  'glowstone': paintGlowstone,
  'snow': paintSnow,
  'water': paintWater,
};

// --- Atlas assembly -------------------------------------------------------------

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  // Worker / headless fallback.
  return new OffscreenCanvas(w, h);
}

/**
 * Build the block texture atlas. Deterministic for a given seed.
 * @param {{seed?:number}} opts
 */
export function createBlockAtlas({ seed = 1337 } = {}) {
  const canvas = makeCanvas(ATLAS_SIZE, ATLAS_SIZE);
  const ctx = canvas.getContext('2d');

  // Unused slots: opaque neutral grey (never sampled thanks to UV insets, but
  // keeps any accidental sampling from flashing transparent black).
  ctx.fillStyle = '#6b6b6b';
  ctx.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);

  const uvByName = {};

  TILES.forEach((name, i) => {
    const col = i % ATLAS_COLS;
    const row = (i / ATLAS_COLS) | 0;

    const img = ctx.createImageData(TILE_SIZE, TILE_SIZE);
    const data = img.data;
    const set = (x, y, r, g, b, a = 255) => {
      const k = ((y | 0) * TILE_SIZE + (x | 0)) * 4;
      data[k] = r;
      data[k + 1] = g;
      data[k + 2] = b;
      data[k + 3] = a;
    };

    PAINTERS[name](set, mulberry32(seed + i * 101));
    ctx.putImageData(img, col * TILE_SIZE, row * TILE_SIZE);

    // UV rect. CanvasTexture default flipY=true: canvas row 0 (tile top) lands
    // at the HIGH v of the rect, so v1 = "top of the tile art".
    const u0 = (col * TILE_SIZE) / ATLAS_SIZE;
    const u1 = ((col + 1) * TILE_SIZE) / ATLAS_SIZE;
    const v1 = 1 - (row * TILE_SIZE) / ATLAS_SIZE;
    const v0 = 1 - ((row + 1) * TILE_SIZE) / ATLAS_SIZE;
    uvByName[name] = Object.freeze({ u0, v0, u1, v1 });
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter; // no mipmaps -> no cross-tile mip bleed
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const tileUV = (name) => uvByName[name] || null;
  const faceTile = (blockId, face) => {
    const m = FACE_TILE[blockId];
    if (!m) return null;
    return m[face] || m.side || null;
  };

  return {
    texture,
    canvas,
    tileUV,
    faceTile,
    TILES,
    FACE_TILE,
    tileSizePx: TILE_SIZE,
    atlasSizePx: ATLAS_SIZE,
    texelSize: 1 / ATLAS_SIZE,
  };
}

export default createBlockAtlas;
