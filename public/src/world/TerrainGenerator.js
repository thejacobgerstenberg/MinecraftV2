// Voxelheim deterministic terrain generation for three dimensions
// (worldgen phase).
//
// PURE module: no three.js import — must run under plain node.
//
//   const gen = new TerrainGenerator(seed, 'overworld' | 'nether' | 'end');
//   const data = gen.generateChunk(cx, cz); // Uint8Array(16*16*128)
//
// Documented simplifications:
//   - Tree trunks are only planted with local x,z in [2,13] so the 5x5 leaf
//     canopy never crosses a chunk border (chunks generate independently).
//   - Ore veins and glowstone blobs are clipped at chunk borders.

import { CHUNK_SX, CHUNK_SZ, CHUNK_SY, SEA_LEVEL, blockIndex } from '../constants.js';
import { BLOCK_ID } from '../blocks/blocks.js';
import { makeNoise2D, makeNoise3D, fbm2D } from './noise.js';

const B = BLOCK_ID;

// ---------------------------------------------------------------- helpers

function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mix32(h) {
  h = h >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic uint32 hash of a seed and 2 integer coordinates. */
function hash2(seed, x, z) {
  let h = (seed ^ Math.imul(x, 0x9e3779b1)) >>> 0;
  h = mix32(h);
  h = (h ^ Math.imul(z, 0x85ebca77)) >>> 0;
  return mix32(h);
}

/** Small deterministic PRNG (mulberry32) returning [0,1). */
function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Biome ids (internal to the generator).
const BIOME = {
  OCEAN: 0,
  BEACH: 1,
  PLAINS: 2,
  FOREST: 3,
  DESERT: 4,
  MOUNTAINS: 5,
  SNOW: 6,
  SNOWCAP: 7,
};

// Display names for biomeAt(), indexed by BIOME id.
export const BIOME_NAMES = [
  'Ocean', 'Beach', 'Plains', 'Forest', 'Desert',
  'Mountains', 'Snowfield', 'Snowcap',
];

// ------------------------------------------------------------- generator

export class TerrainGenerator {
  /**
   * @param {string|number} seed  world seed (string or integer)
   * @param {'overworld'|'nether'|'end'} dimension
   */
  constructor(seed, dimension = 'overworld') {
    this.seed = seed;
    this.dimension = dimension;
    const s = String(seed);
    this.intSeed = mix32(hashString(s));

    // Overworld noises.
    this.nCont = makeNoise2D(s + '/continental');
    this.nDetail = makeNoise2D(s + '/detail');
    this.nMask = makeNoise2D(s + '/mountain-mask');
    this.nRidge = makeNoise2D(s + '/ridge');
    this.nTemp = makeNoise2D(s + '/temperature');
    this.nHumid = makeNoise2D(s + '/humidity');
    this.nFloorMat = makeNoise2D(s + '/ocean-floor');
    this.nCaveA = makeNoise3D(s + '/cave-a');
    this.nCaveB = makeNoise3D(s + '/cave-b');

    // Nether noises.
    this.nNetherFloor = makeNoise2D(s + '/nether-floor');
    this.nNetherCeil = makeNoise2D(s + '/nether-ceil');
    this.nSoul = makeNoise2D(s + '/soul-sand');

    // End noises.
    this.nOuter = makeNoise2D(s + '/end-outer');
    this.nEnd3 = makeNoise3D(s + '/end-shape');
  }

  /**
   * Biome display name at a world column — the SAME noise query the
   * overworld generator uses for its surface pass (cheap: two fbm2D
   * evaluations plus the height stack). Returns null for nether/end,
   * where terrain has no biome field.
   * @returns {string|null} e.g. 'Forest' (see BIOME_NAMES)
   */
  biomeAt(wx, wz) {
    if (this.dimension !== 'overworld') return null;
    const { biome } = this._column(Math.floor(wx), Math.floor(wz));
    return BIOME_NAMES[biome] ?? null;
  }

  /**
   * Generate one chunk of block ids.
   * @returns {Uint8Array} length 16*16*128 indexed via blockIndex(x,y,z)
   */
  generateChunk(cx, cz) {
    switch (this.dimension) {
      case 'nether':
        return this._genNether(cx, cz);
      case 'end':
        return this._genEnd(cx, cz);
      default:
        return this._genOverworld(cx, cz);
    }
  }

  // ---------------------------------------------------------- overworld

  /** Ridged multifractal in [0,1] used for mountains. */
  _ridged(x, z, octaves) {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.nRidge(x * freq, z * freq));
      sum += n * n * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.13;
    }
    return sum / norm;
  }

  /** Terrain height + biome for a world column. Returns {height, biome}. */
  _column(wx, wz) {
    const cont = fbm2D(this.nCont, wx * 0.0032, wz * 0.0032, 5, 2.0, 0.5);
    const detail = fbm2D(this.nDetail, wx * 0.016, wz * 0.016, 3, 2.0, 0.5);
    const mMask = fbm2D(this.nMask, wx * 0.0021, wz * 0.0021, 3, 2.0, 0.5);
    const gate = smoothstep(0.02, 0.38, mMask);

    let h = SEA_LEVEL + 3 + cont * 22 + detail * 5;
    let ridge = 0;
    if (gate > 0.001) {
      ridge = this._ridged(wx * 0.006, wz * 0.006, 4);
      h += gate * ridge * ridge * 64;
    }
    const height = clamp(Math.round(h), 1, CHUNK_SY - 12);

    let temp = fbm2D(this.nTemp, wx * 0.0035, wz * 0.0035, 3, 2.0, 0.5);
    const humid = fbm2D(this.nHumid, 31.7 + wx * 0.0035, -11.3 + wz * 0.0035, 3, 2.0, 0.5);
    // Altitude cooling above the mid-lands.
    temp -= Math.max(0, height - (SEA_LEVEL + 18)) * 0.012;

    let biome;
    if (height < SEA_LEVEL - 1) biome = BIOME.OCEAN;
    else if (height <= SEA_LEVEL + 1) biome = BIOME.BEACH;
    else if (height >= SEA_LEVEL + 46) biome = BIOME.SNOWCAP;
    else if (height >= SEA_LEVEL + 28) biome = BIOME.MOUNTAINS;
    else if (temp < -0.22) biome = BIOME.SNOW;
    else if (temp > 0.2 && humid < 0.02) biome = BIOME.DESERT;
    else if (humid > 0.06) biome = BIOME.FOREST;
    else biome = BIOME.PLAINS;

    return { height, biome };
  }

  _genOverworld(cx, cz) {
    const data = new Uint8Array(CHUNK_SX * CHUNK_SZ * CHUNK_SY);
    const heights = new Int16Array(CHUNK_SX * CHUNK_SZ);
    const biomes = new Uint8Array(CHUNK_SX * CHUNK_SZ);
    const baseX = cx * CHUNK_SX;
    const baseZ = cz * CHUNK_SZ;

    // --- pass 1: heightmap, biomes, base column fill -------------------
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const wx = baseX + x;
        const wz = baseZ + z;
        const col = z * CHUNK_SX + x;
        const { height, biome } = this._column(wx, wz);
        heights[col] = height;
        biomes[col] = biome;

        data[blockIndex(x, 0, z)] = B.bedrock;
        for (let y = 1; y <= height; y++) data[blockIndex(x, y, z)] = B.stone;

        // Surface layers by biome.
        switch (biome) {
          case BIOME.OCEAN: {
            const mat = this.nFloorMat(wx * 0.05, wz * 0.05) > 0.25 ? B.gravel : B.sand;
            for (let y = Math.max(1, height - 2); y <= height; y++) {
              data[blockIndex(x, y, z)] = mat;
            }
            break;
          }
          case BIOME.BEACH:
            for (let y = Math.max(1, height - 2); y <= height; y++) {
              data[blockIndex(x, y, z)] = B.sand;
            }
            break;
          case BIOME.DESERT:
            for (let y = Math.max(1, height - 6); y <= height - 4; y++) {
              data[blockIndex(x, y, z)] = B.sandstone;
            }
            for (let y = Math.max(1, height - 3); y <= height; y++) {
              data[blockIndex(x, y, z)] = B.sand;
            }
            break;
          case BIOME.PLAINS:
          case BIOME.FOREST:
            for (let y = Math.max(1, height - 3); y < height; y++) {
              data[blockIndex(x, y, z)] = B.dirt;
            }
            data[blockIndex(x, height, z)] = B.grass;
            break;
          case BIOME.SNOW:
            for (let y = Math.max(1, height - 3); y < height; y++) {
              data[blockIndex(x, y, z)] = B.dirt;
            }
            data[blockIndex(x, height, z)] = B.snow_grass;
            break;
          case BIOME.SNOWCAP:
            for (let y = Math.max(1, height - 1); y <= height; y++) {
              data[blockIndex(x, y, z)] = B.snow_block;
            }
            break;
          case BIOME.MOUNTAINS:
          default:
            break; // bare stone
        }

        // Water fill up to sea level.
        if (height < SEA_LEVEL) {
          for (let y = height + 1; y <= SEA_LEVEL; y++) {
            data[blockIndex(x, y, z)] = B.water;
          }
        }
      }
    }

    // --- pass 2: caves (never touch bedrock, keep a 4-block crust) -----
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const col = z * CHUNK_SX + x;
        const limit = heights[col] - 4;
        const wx = baseX + x;
        const wz = baseZ + z;
        for (let y = 2; y <= limit; y++) {
          const a = this.nCaveA(wx * 0.052, y * 0.082, wz * 0.052);
          // Cheese caverns.
          if (a > 0.54) {
            const i = blockIndex(x, y, z);
            if (data[i] === B.stone) data[i] = B.air;
            continue;
          }
          // Spaghetti tunnels: intersection of two noise zero-surfaces.
          const b = this.nCaveB(wx * 0.045, y * 0.06, wz * 0.045);
          if (a * a + b * b < 0.012) {
            const i = blockIndex(x, y, z);
            if (data[i] === B.stone) data[i] = B.air;
          }
        }
      }
    }

    // --- pass 3: ore veins (replace stone only) -------------------------
    const oreRng = mulberry32(hash2(this.intSeed ^ 0x0be5, cx, cz));
    this._placeVeins(data, oreRng, B.coal_ore, 12, 5, 70, 5, 9);
    this._placeVeins(data, oreRng, B.iron_ore, 9, 5, 54, 4, 7);
    this._placeVeins(data, oreRng, B.gold_ore, 4, 5, 30, 3, 5);
    this._placeVeins(data, oreRng, B.diamond_ore, 2, 1, 14, 2, 4);

    // --- pass 4: features (trees, cactus) -------------------------------
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const col = z * CHUNK_SX + x;
        const biome = biomes[col];
        const h = heights[col];
        const wx = baseX + x;
        const wz = baseZ + z;

        if (biome === BIOME.DESERT) {
          const hc = hash2(this.intSeed ^ 0xcac7, wx, wz);
          if (hc % 70 === 0 && h > SEA_LEVEL && h + 4 < CHUNK_SY &&
              data[blockIndex(x, h, z)] === B.sand) {
            const tall = 1 + (hc >>> 8) % 3; // 1-3 tall
            for (let dy = 1; dy <= tall; dy++) {
              data[blockIndex(x, h + dy, z)] = B.cactus;
            }
          }
          continue;
        }

        if (biome !== BIOME.PLAINS && biome !== BIOME.FOREST) continue;
        // Simplification: trunks at least 2 blocks inside the chunk border
        // so the canopy never crosses into a neighbor chunk.
        if (x < 2 || x > 13 || z < 2 || z > 13) continue;
        const ht = hash2(this.intSeed ^ 0x7ee5, wx, wz);
        const period = biome === BIOME.FOREST ? 24 : 120;
        if (ht % period !== 0) continue;
        if (data[blockIndex(x, h, z)] !== B.grass) continue;
        const trunkH = 4 + ((ht >>> 8) % 3); // 4-6
        if (h + trunkH + 2 >= CHUNK_SY) continue;
        this._placeTree(data, x, h, z, trunkH, ht);
      }
    }

    return data;
  }

  _placeVeins(data, rng, ore, count, minY, maxY, sizeMin, sizeMax) {
    for (let v = 0; v < count; v++) {
      let x = Math.floor(rng() * CHUNK_SX);
      let z = Math.floor(rng() * CHUNK_SZ);
      let y = minY + Math.floor(rng() * (maxY - minY + 1));
      const size = sizeMin + Math.floor(rng() * (sizeMax - sizeMin + 1));
      for (let n = 0; n < size; n++) {
        if (x >= 0 && x < CHUNK_SX && z >= 0 && z < CHUNK_SZ && y >= 1 && y < CHUNK_SY) {
          const i = blockIndex(x, y, z);
          if (data[i] === B.stone) data[i] = ore;
        }
        // Random-walk blob (clipped at chunk borders — accepted simplification).
        x += Math.floor(rng() * 3) - 1;
        y += Math.floor(rng() * 3) - 1;
        z += Math.floor(rng() * 3) - 1;
        if (y < minY) y = minY;
        if (y > maxY) y = maxY;
      }
    }
  }

  _placeTree(data, x, h, z, trunkH, hashBits) {
    data[blockIndex(x, h, z)] = B.dirt; // dirt under the trunk
    const top = h + trunkH;
    // Canopy: two 5x5 layers minus corners, then a 3x3 layer, then a plus cap.
    for (let ly = top - 2; ly <= top - 1; ly++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue; // clip corners
          const i = blockIndex(x + dx, ly, z + dz);
          if (data[i] === B.air) data[i] = B.leaves;
        }
      }
    }
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const i = blockIndex(x + dx, top, z + dz);
        if (data[i] === B.air) data[i] = B.leaves;
        if (Math.abs(dx) + Math.abs(dz) <= 1) {
          const j = blockIndex(x + dx, top + 1, z + dz);
          if (data[j] === B.air) data[j] = B.leaves;
        }
      }
    }
    for (let y = h + 1; y <= top; y++) data[blockIndex(x, y, z)] = B.log;
  }

  // ------------------------------------------------------------- nether

  _genNether(cx, cz) {
    const data = new Uint8Array(CHUNK_SX * CHUNK_SZ * CHUNK_SY);
    const baseX = cx * CHUNK_SX;
    const baseZ = cz * CHUNK_SZ;
    const ceilBottom = new Int16Array(CHUNK_SX * CHUNK_SZ);
    const floorTop = new Int16Array(CHUNK_SX * CHUNK_SZ);
    const LAVA_LEVEL = 31;

    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const wx = baseX + x;
        const wz = baseZ + z;
        const col = z * CHUNK_SX + x;

        const fh = clamp(Math.round(
          30 + fbm2D(this.nNetherFloor, wx * 0.013, wz * 0.013, 4, 2.0, 0.5) * 16), 3, 60);
        const ch = clamp(Math.round(
          97 - fbm2D(this.nNetherCeil, wx * 0.013, wz * 0.013, 4, 2.0, 0.5) * 15), 78, 124);
        floorTop[col] = fh;
        ceilBottom[col] = ch;

        data[blockIndex(x, 0, z)] = B.bedrock;
        data[blockIndex(x, CHUNK_SY - 1, z)] = B.bedrock;
        for (let y = 1; y <= fh; y++) data[blockIndex(x, y, z)] = B.netherrack;
        for (let y = ch; y < CHUNK_SY - 1; y++) data[blockIndex(x, y, z)] = B.netherrack;

        // Lava ocean fills the open cavern up to y=31.
        for (let y = fh + 1; y <= LAVA_LEVEL; y++) {
          data[blockIndex(x, y, z)] = B.lava;
        }

        // Soul sand patches on floors that stand above the lava ocean.
        if (fh > LAVA_LEVEL &&
            fbm2D(this.nSoul, wx * 0.035, wz * 0.035, 2, 2.0, 0.5) > 0.16) {
          data[blockIndex(x, fh, z)] = B.soul_sand;
          if (fh - 1 > LAVA_LEVEL) data[blockIndex(x, fh - 1, z)] = B.soul_sand;
        }

        // Occasional netherrack pillar joining floor to ceiling.
        const hp = hash2(this.intSeed ^ 0x9111, wx, wz);
        if (hp % 260 === 0 && fh > LAVA_LEVEL) {
          for (let y = fh + 1; y < ch; y++) data[blockIndex(x, y, z)] = B.netherrack;
          // Cross-shaped thickening, clipped at chunk borders.
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx;
            const nz = z + dz;
            if (nx < 0 || nx > 15 || nz < 0 || nz > 15) continue;
            for (let y = fh + 1; y < ch; y++) {
              const i = blockIndex(nx, y, nz);
              if (data[i] === B.air) data[i] = B.netherrack;
            }
          }
        }
      }
    }

    // Glowstone blobs hanging from the ceiling.
    const rng = mulberry32(hash2(this.intSeed ^ 0x610b, cx, cz));
    const blobs = 1 + Math.floor(rng() * 3); // 1-3 per chunk
    for (let bIdx = 0; bIdx < blobs; bIdx++) {
      const bx = 1 + Math.floor(rng() * 14);
      const bz = 1 + Math.floor(rng() * 14);
      const cb = ceilBottom[bz * CHUNK_SX + bx];
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = 1; dy <= 3; dy++) {
            const gx = bx + dx;
            const gz = bz + dz;
            const gy = cb - dy;
            if (gx < 0 || gx > 15 || gz < 0 || gz > 15 || gy < 2) continue;
            const core = dx === 0 && dz === 0 && dy <= 2;
            if (!core && rng() >= 0.4) continue;
            const i = blockIndex(gx, gy, gz);
            if (data[i] === B.air) data[i] = B.glowstone;
          }
        }
      }
    }

    return data;
  }

  // ---------------------------------------------------------------- end

  _genEnd(cx, cz) {
    const data = new Uint8Array(CHUNK_SX * CHUNK_SZ * CHUNK_SY);
    const baseX = cx * CHUNK_SX;
    const baseZ = cz * CHUNK_SZ;
    const Y_MID = 56;
    const Y_SPAN = 16; // island lives roughly in y 40..72

    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const wx = baseX + x;
        const wz = baseZ + z;
        const r = Math.hypot(wx, wz);

        // Main island: radius ~100, centered at the origin.
        let colFactor = 1 - (r / 105) * (r / 105);
        // Sparse small outer islands beyond the void gap.
        if (r > 170) {
          const om = fbm2D(this.nOuter, wx * 0.013, wz * 0.013, 3, 2.0, 0.5);
          const outer = (om - 0.42) * 2.2;
          if (outer > colFactor) colFactor = outer;
        }
        if (colFactor <= 0) continue; // pure void column

        for (let y = Y_MID - Y_SPAN; y <= Y_MID + Y_SPAN; y++) {
          const dy = (y - Y_MID) / Y_SPAN;
          const vert = 1 - dy * dy;
          if (vert <= 0) continue;
          const d = colFactor * vert
            + this.nEnd3(wx * 0.024, y * 0.05, wz * 0.024) * 0.45
            - 0.42;
          if (d > 0) data[blockIndex(x, y, z)] = B.end_stone;
        }
      }
    }

    return data;
  }
}
