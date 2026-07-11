// graphics-lab/src/worldgen.js
//
// Deterministic showcase chunk generator.
//
// generateDemoChunk() returns the Volume object described in API_CONTRACT.md:
//   { sx, sy, sz, get, isSolid, isOpaque, WATER_LEVEL, blocks, lights }
//
// The scene is a hand-tuned little Minecraft vignette:
//   - rolling hills (grass / dirt / stone) from seeded value-noise fbm
//   - a carved lake below WATER_LEVEL with a sand beach ring
//   - snow-capped high peaks
//   - a handful of trees (wood trunk + leaf canopy)
//   - a small plank cabin (walls, doorway, windows, gable roof, floor)
//   - glowstone "torch" light positions on the cabin and around the lake
//
// Everything is deterministic: a fixed SEED drives a hash-based noise, and all
// structure placement is fixed data. No Math.random anywhere.

import {
  AIR, GRASS, DIRT, STONE, SAND, WOOD, LEAVES, WATER, PLANK, GLOWSTONE, SNOW,
} from './blocks.js';

// --- Dimensions & world constants --------------------------------------------

const SX = 48;
const SY = 32;
const SZ = 48;
const WATER_LEVEL = 10;

const SEED = 1337;
const BASE_HEIGHT = 11; // natural ground floor (>= WATER_LEVEL, so land is dry)
const HILL_AMP = 10;    // hills rise up to BASE_HEIGHT + HILL_AMP
const SNOW_LINE = 18;   // top blocks at/above this become snow

// Lake carved into the terrain (only region that dips below WATER_LEVEL).
const LAKE_CX = 13;
const LAKE_CZ = 34;
const LAKE_R = 10;
const LAKE_FLOOR = 5;   // deepest point of the basin

// --- Deterministic value noise -----------------------------------------------

function hash2(ix, iz, seed) {
  // Integer hash -> [0,1). Cheap, deterministic, no allocations.
  let h = (ix | 0) * 374761393 + (iz | 0) * 668265263 + (seed | 0) * 362437;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

function valueNoise(x, z, seed) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = smooth(x - x0);
  const fz = smooth(z - z0);
  const n00 = hash2(x0, z0, seed);
  const n10 = hash2(x0 + 1, z0, seed);
  const n01 = hash2(x0, z0 + 1, seed);
  const n11 = hash2(x0 + 1, z0 + 1, seed);
  const nx0 = n00 + (n10 - n00) * fx;
  const nx1 = n01 + (n11 - n01) * fx;
  return nx0 + (nx1 - nx0) * fz;
}

function fbm(x, z, seed) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += amp * valueNoise(x * freq, z * freq, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm; // ~0..1
}

// --- Volume storage ----------------------------------------------------------

export function generateDemoChunk() {
  const data = new Uint8Array(SX * SY * SZ); // 0 = air everywhere initially
  const heights = new Int16Array(SX * SZ);   // surface y per column

  const idx = (x, y, z) => (y * SZ + z) * SX + x;
  const inRange = (x, y, z) =>
    x >= 0 && y >= 0 && z >= 0 && x < SX && y < SY && z < SZ;

  const get = (x, y, z) => (inRange(x, y, z) ? data[idx(x, y, z)] : AIR);
  const set = (x, y, z, id) => {
    if (inRange(x, y, z)) data[idx(x, y, z)] = id;
  };
  const hAt = (x, z) => heights[z * SX + x];
  const setH = (x, z, y) => { heights[z * SX + x] = y; };

  // --- Pass 1: terrain, lake basin, water, beach, snow -----------------------

  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      // Natural rolling height.
      let h = BASE_HEIGHT + fbm(x * 0.09, z * 0.09, SEED) * HILL_AMP;

      // Carve the lake basin as a smooth bowl.
      const ldx = x - LAKE_CX;
      const ldz = z - LAKE_CZ;
      const lakeDist = Math.sqrt(ldx * ldx + ldz * ldz);
      if (lakeDist < LAKE_R) {
        const t = smooth(lakeDist / LAKE_R);        // 0 at center -> 1 at rim
        const floor = LAKE_FLOOR + (h - LAKE_FLOOR) * t;
        h = Math.min(h, floor);
      }

      let surfaceY = Math.max(1, Math.round(h));
      surfaceY = Math.min(surfaceY, SY - 6);
      setH(x, z, surfaceY);

      // Choose the surface (top) block.
      const nearLake = lakeDist < LAKE_R + 2.5;
      let topBlock;
      if (surfaceY <= WATER_LEVEL) {
        topBlock = SAND;                             // lake bed
      } else if (nearLake && surfaceY <= WATER_LEVEL + 1) {
        topBlock = SAND;                             // beach ring
      } else if (surfaceY >= SNOW_LINE) {
        topBlock = SNOW;                             // frosty peaks
      } else {
        topBlock = GRASS;
      }

      // Fill the column: stone core, dirt (or sand) shell, surface block.
      for (let y = 0; y <= surfaceY; y++) {
        let block;
        if (y === surfaceY) {
          block = topBlock;
        } else if (y >= surfaceY - 3) {
          // Sandy bed under sand tops, otherwise dirt.
          block = topBlock === SAND ? SAND : DIRT;
        } else {
          block = STONE;
        }
        set(x, y, z, block);
      }

      // Fill water from the surface up to WATER_LEVEL in the basin.
      if (surfaceY < WATER_LEVEL) {
        for (let y = surfaceY + 1; y <= WATER_LEVEL; y++) set(x, y, z, WATER);
      }
    }
  }

  // --- Pass 2: cabin ---------------------------------------------------------

  const lights = [];

  const cx0 = 26;
  const cx1 = 32;   // 7 wide (x)
  const cz0 = 12;
  const cz1 = 18;   // 7 deep (z)
  const ccx = (cx0 + cx1) >> 1; // 29
  const ccz = (cz0 + cz1) >> 1; // 15
  const floorY = hAt(ccx, ccz);
  const halfW = Math.ceil((cx1 - cx0) / 2);

  // Flatten a footprint (plus a 1-block yard margin) to floorY.
  for (let x = cx0 - 1; x <= cx1 + 1; x++) {
    for (let z = cz0 - 1; z <= cz1 + 1; z++) {
      if (!inRange(x, 0, z)) continue;
      // Clear anything above the floor.
      for (let y = floorY + 1; y < SY; y++) set(x, y, z, AIR);
      // Fill any gap below the floor.
      for (let y = floorY; y >= 0; y--) {
        if (get(x, y, z) === AIR) {
          set(x, y, z, y === floorY ? GRASS : DIRT);
        } else {
          break;
        }
      }
      set(x, floorY, z, GRASS);
      setH(x, z, floorY);
    }
  }

  const wallTop = floorY + 3;      // 3-tall walls
  const roofBase = floorY + 4;
  const doorX = ccx;

  // Interior plank floor.
  for (let x = cx0; x <= cx1; x++) {
    for (let z = cz0; z <= cz1; z++) set(x, floorY, z, PLANK);
  }

  // Walls (perimeter).
  for (let x = cx0; x <= cx1; x++) {
    for (let z = cz0; z <= cz1; z++) {
      const perimeter = x === cx0 || x === cx1 || z === cz0 || z === cz1;
      if (!perimeter) continue;
      for (let y = floorY + 1; y <= wallTop; y++) set(x, y, z, PLANK);
    }
  }

  // Doorway on the front (z === cz1), 2 tall.
  set(doorX, floorY + 1, cz1, AIR);
  set(doorX, floorY + 2, cz1, AIR);

  // Windows: open holes at eye level on the two side walls.
  const winY = floorY + 2;
  set(cx0, winY, cz0 + 2, AIR);
  set(cx0, winY, cz1 - 2, AIR);
  set(cx1, winY, cz0 + 2, AIR);
  set(cx1, winY, cz1 - 2, AIR);

  // Gable roof: ridge runs along z at x === ccx, sloping down toward the eaves.
  const roofYAt = (x) => roofBase + Math.max(0, halfW - Math.abs(x - ccx));
  for (let x = cx0 - 1; x <= cx1 + 1; x++) {
    const ry = roofYAt(x);
    for (let z = cz0 - 1; z <= cz1 + 1; z++) set(x, ry, z, PLANK);
  }
  // Close the gable triangles on the front/back walls.
  for (const z of [cz0, cz1]) {
    for (let x = cx0; x <= cx1; x++) {
      const ry = roofYAt(x);
      for (let y = roofBase; y < ry; y++) set(x, y, z, PLANK);
    }
  }

  // Cabin lights: a hanging lantern inside + a torch beside the door.
  set(ccx, wallTop, ccz, GLOWSTONE);
  lights.push({ x: ccx, y: wallTop, z: ccz });

  set(doorX + 1, wallTop, cz1, GLOWSTONE);
  lights.push({ x: doorX + 1, y: wallTop, z: cz1 });

  // --- Pass 3: trees ---------------------------------------------------------

  const treeSpots = [
    [8, 8], [16, 14], [40, 10], [43, 22], [9, 20],
    [20, 42], [38, 40], [44, 44], [6, 44], [34, 30], [22, 6], [40, 32],
  ];

  const insideCabin = (x, z) =>
    x >= cx0 - 2 && x <= cx1 + 2 && z >= cz0 - 2 && z <= cz1 + 2;

  const placeTree = (bx, bz, seed) => {
    const gy = hAt(bx, bz);
    if (get(bx, gy, bz) !== GRASS) return; // only on grass
    const trunkH = 4 + Math.floor(hash2(bx, bz, seed) * 3); // 4..6
    const topY = gy + trunkH;

    // Canopy: wide bottom layers, narrow top, corners trimmed.
    for (let dy = -2; dy <= 1; dy++) {
      const r = dy <= -1 ? 2 : 1;
      const yy = topY + dy;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const corner = Math.abs(dx) === r && Math.abs(dz) === r;
          if (corner && (r === 2) && hash2(bx + dx, bz + dz, seed + dy) < 0.5) {
            continue; // trim ~half the outer corners for a rounder look
          }
          const x = bx + dx;
          const y = yy;
          const z = bz + dz;
          if (get(x, y, z) === AIR) set(x, y, z, LEAVES);
        }
      }
    }
    // Trunk (drawn last so it shows through the canopy).
    for (let y = gy + 1; y <= topY; y++) set(bx, y, bz, WOOD);
  };

  for (let i = 0; i < treeSpots.length; i++) {
    const [bx, bz] = treeSpots[i];
    if (!inRange(bx, 0, bz)) continue;
    if (insideCabin(bx, bz)) continue;
    placeTree(bx, bz, SEED + i * 53);
  }

  // --- Pass 4: lakeside torches ----------------------------------------------

  const torchSpots = [
    [LAKE_CX + LAKE_R + 1, LAKE_CZ - 2],
    [LAKE_CX - LAKE_R + 1, LAKE_CZ + LAKE_R - 3],
  ];
  for (const [tx, tz] of torchSpots) {
    if (!inRange(tx, 0, tz)) continue;
    const gy = hAt(tx, tz);
    // Only stand torches on dry-ish ground.
    if (gy < WATER_LEVEL) continue;
    set(tx, gy + 1, tz, WOOD);       // short post
    set(tx, gy + 2, tz, GLOWSTONE);  // flame
    lights.push({ x: tx, y: gy + 2, z: tz });
  }

  // --- Build convenience list of non-air blocks ------------------------------

  const blocks = [];
  for (let y = 0; y < SY; y++) {
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const id = data[idx(x, y, z)];
        if (id !== AIR) blocks.push({ x, y, z, id });
      }
    }
  }

  // --- Public volume API -----------------------------------------------------

  const isSolid = (x, y, z) => {
    const id = get(x, y, z);
    return id !== AIR && id !== WATER;
  };
  const isOpaque = (x, y, z) => {
    const id = get(x, y, z);
    return id !== AIR && id !== WATER && id !== LEAVES;
  };

  return {
    sx: SX,
    sy: SY,
    sz: SZ,
    get,
    isSolid,
    isOpaque,
    WATER_LEVEL,
    blocks,
    lights,
  };
}

export default generateDemoChunk;

// =============================================================================
// generateTestWorld — large deterministic benchmark volume
// =============================================================================
//
// generateTestWorld({ chunksX = 6, chunksZ = 6, chunkSize = 16, seed = 7 })
//   -> Volume (same interface as generateDemoChunk):
//      { sx, sy, sz, get, isSolid, isOpaque, WATER_LEVEL, blocks, lights }
//
// A chunksX*chunkSize x 40 x chunksZ*chunkSize world of rolling fbm terrain
// (valleys dip below WATER_LEVEL and flood into natural ponds, high ground
// caps with snow), scattered trees on a hashed grid, and a handful of
// deterministic structures (plank huts with glowstone lanterns + jagged stone
// ruin towers with glowing braziers).
//
// Everything is O(columns + cells) and driven purely by hash2(seed) — no
// Math.random, no rejection loops — so a 96x40x96 world generates in
// milliseconds and byte-identical output for the same options. `blocks` (the
// convenience list of non-air voxels) is a LAZY getter: benchmark consumers
// only need get/isOpaque, so the ~100k-entry list is built on first access.

const TEST_SY = 40;               // fixed height per the benchmark contract
const TEST_WATER_LEVEL = 10;      // matches the demo chunk
const TEST_SNOW_LINE = 24;

export function generateTestWorld({
  chunksX = 6,
  chunksZ = 6,
  chunkSize = 16,
  seed = 7,
} = {}) {
  const sx = Math.max(1, chunksX | 0) * Math.max(1, chunkSize | 0);
  const sz = Math.max(1, chunksZ | 0) * Math.max(1, chunkSize | 0);
  const sy = TEST_SY;
  const WL = TEST_WATER_LEVEL;

  const data = new Uint8Array(sx * sy * sz);
  const heights = new Int16Array(sx * sz);

  const idx = (x, y, z) => (y * sz + z) * sx + x;
  const inRange = (x, y, z) =>
    x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz;

  const get = (x, y, z) => (inRange(x, y, z) ? data[idx(x, y, z)] : AIR);
  const set = (x, y, z, id) => {
    if (inRange(x, y, z)) data[idx(x, y, z)] = id;
  };
  const hAt = (x, z) => heights[z * sx + x];

  // --- Pass 1: rolling terrain + water ---------------------------------------
  // Two noise scales: broad rolling hills + fine detail. Low valleys flood.

  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      const rolling = fbm(x * 0.022, z * 0.022, seed);
      const detail = fbm(x * 0.09, z * 0.09, seed + 4177);
      // fbm sums cluster around 0.5, so spread them around a midline: valleys
      // genuinely dip below WATER_LEVEL (flooded ponds), peaks clear SNOW_LINE.
      const h = 14 + (rolling - 0.5) * 32 + (detail - 0.5) * 5; // ~2..27
      const surfaceY = Math.max(1, Math.min(sy - 9, Math.round(h)));
      heights[z * sx + x] = surfaceY;

      const topBlock =
        surfaceY <= WL + 1 ? SAND :
        surfaceY >= TEST_SNOW_LINE ? SNOW : GRASS;

      for (let y = 0; y <= surfaceY; y++) {
        let block;
        if (y === surfaceY) block = topBlock;
        else if (y >= surfaceY - 3) block = topBlock === SAND ? SAND : DIRT;
        else block = STONE;
        data[idx(x, y, z)] = block;
      }
      // Flood valleys up to the water level (no-op on dry columns).
      for (let y = surfaceY + 1; y <= WL; y++) data[idx(x, y, z)] = WATER;
    }
  }

  // --- Pass 2: scattered structures -------------------------------------------
  // One candidate per 32x32 cell; the cell hash picks presence, type and a
  // jittered position. Placement is validated (dry, reasonably flat, in
  // bounds) and claimed footprints keep trees out.

  const lights = [];
  const claims = []; // { x0, z0, x1, z1 } tree-exclusion rects

  const claimed = (x, z) => {
    for (let i = 0; i < claims.length; i++) {
      const c = claims[i];
      if (x >= c.x0 && x <= c.x1 && z >= c.z0 && z <= c.z1) return true;
    }
    return false;
  };

  // Height spread over a footprint (corners + centre): flatness test.
  const heightSpread = (x0, z0, x1, z1) => {
    const cx = (x0 + x1) >> 1;
    const cz = (z0 + z1) >> 1;
    let lo = Infinity;
    let hi = -Infinity;
    const sample = (x, z) => {
      const y = hAt(x, z);
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    };
    sample(x0, z0); sample(x1, z0); sample(x0, z1); sample(x1, z1); sample(cx, cz);
    return { lo, hi };
  };

  // Small plank hut: 5x5 footprint, 3-high walls, doorway, flat roof,
  // glowstone lantern under the ceiling.
  const placeHut = (x0, z0) => {
    const x1 = x0 + 4;
    const z1 = z0 + 4;
    if (x0 < 1 || z0 < 1 || x1 >= sx - 1 || z1 >= sz - 1) return false;
    const { lo, hi } = heightSpread(x0, z0, x1, z1);
    if (hi - lo > 3 || lo <= WL) return false; // too steep or wet — skip

    const fy = hi; // floor sits on the highest corner; fill below
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        for (let y = fy + 1; y <= Math.min(sy - 1, fy + 7); y++) set(x, y, z, AIR);
        for (let y = fy - 1; y >= 0 && get(x, y, z) === AIR; y--) set(x, y, z, DIRT);
        set(x, fy, z, PLANK);
        heights[z * sx + x] = fy;
      }
    }
    const wallTop = fy + 3;
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        if (x !== x0 && x !== x1 && z !== z0 && z !== z1) continue;
        for (let y = fy + 1; y <= wallTop; y++) set(x, y, z, PLANK);
      }
    }
    const doorX = x0 + 2;
    set(doorX, fy + 1, z1, AIR); // doorway (2 tall) on the +z face
    set(doorX, fy + 2, z1, AIR);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) set(x, wallTop + 1, z, PLANK); // flat roof
    }
    set(x0 + 2, wallTop, z0 + 2, GLOWSTONE); // hanging lantern
    lights.push({ x: x0 + 2, y: wallTop, z: z0 + 2 });

    claims.push({ x0: x0 - 2, z0: z0 - 2, x1: x1 + 2, z1: z1 + 2 });
    return true;
  };

  // Ruined stone tower: jagged 5x5 stone ring, per-column height from the
  // hash, sometimes a glowing brazier in the centre.
  const placeRuin = (cx, cz, rseed) => {
    if (cx < 3 || cz < 3 || cx >= sx - 3 || cz >= sz - 3) return false;
    const { lo, hi } = heightSpread(cx - 2, cz - 2, cx + 2, cz + 2);
    if (hi - lo > 5 || lo <= WL) return false; // ruins tolerate slopes (per-column bases)

    const baseH = 4 + Math.floor(hash2(cx, cz, rseed) * 4); // 4..7
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue; // ring only
        const x = cx + dx;
        const z = cz + dz;
        const colH = 1 + Math.floor(hash2(x, z, rseed + 77) * baseH); // jagged
        const gy = hAt(x, z);
        for (let y = gy + 1; y <= gy + colH; y++) set(x, y, z, STONE);
      }
    }
    if (hash2(cx, cz, rseed + 5) < 0.6) {
      const gy = hAt(cx, cz);
      set(cx, gy + 1, cz, GLOWSTONE); // brazier
      lights.push({ x: cx, y: gy + 1, z: cz });
    }
    claims.push({ x0: cx - 4, z0: cz - 4, x1: cx + 4, z1: cz + 4 });
    return true;
  };

  const SCELL = 32;
  const sgx = Math.max(1, Math.round(sx / SCELL));
  const sgz = Math.max(1, Math.round(sz / SCELL));
  for (let gz = 0; gz < sgz; gz++) {
    for (let gx = 0; gx < sgx; gx++) {
      if (hash2(gx, gz, seed + 9001) < 0.25) continue; // ~75% of cells build
      const px = gx * SCELL + 5 + Math.floor(hash2(gx, gz, seed + 9002) * 20);
      const pz = gz * SCELL + 5 + Math.floor(hash2(gx, gz, seed + 9003) * 20);
      // Preferred type first; if the site rejects it (slope/water), try the
      // other one so hilly seeds still get their scattered structures.
      const rseed = seed + 9005 + gx * 131 + gz * 197;
      if (hash2(gx, gz, seed + 9004) < 0.5) {
        if (!placeHut(px, pz)) placeRuin(px + 2, pz + 2, rseed);
      } else {
        if (!placeRuin(px + 2, pz + 2, rseed)) placeHut(px, pz);
      }
    }
  }

  // --- Pass 3: trees on a hashed grid -----------------------------------------

  const placeTree = (bx, bz, tseed) => {
    const gy = hAt(bx, bz);
    if (get(bx, gy, bz) !== GRASS) return;
    const trunkH = 4 + Math.floor(hash2(bx, bz, tseed) * 3); // 4..6
    const topY = gy + trunkH;

    for (let dy = -2; dy <= 1; dy++) {
      const r = dy <= -1 ? 2 : 1;
      const yy = topY + dy;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const corner = Math.abs(dx) === r && Math.abs(dz) === r;
          if (corner && r === 2 && hash2(bx + dx, bz + dz, tseed + dy) < 0.5) {
            continue; // trim outer corners for a rounder canopy
          }
          if (get(bx + dx, yy, bz + dz) === AIR) set(bx + dx, yy, bz + dz, LEAVES);
        }
      }
    }
    for (let y = gy + 1; y <= topY; y++) set(bx, y, bz, WOOD);
  };

  const TCELL = 6;
  const tgx = Math.floor(sx / TCELL);
  const tgz = Math.floor(sz / TCELL);
  for (let gz = 0; gz < tgz; gz++) {
    for (let gx = 0; gx < tgx; gx++) {
      if (hash2(gx, gz, seed + 501) > 0.4) continue; // ~40% of cells get a tree
      const bx = gx * TCELL + 1 + Math.floor(hash2(gx, gz, seed + 502) * (TCELL - 2));
      const bz = gz * TCELL + 1 + Math.floor(hash2(gx, gz, seed + 503) * (TCELL - 2));
      if (bx < 2 || bz < 2 || bx >= sx - 2 || bz >= sz - 2) continue;
      if (claimed(bx, bz)) continue;
      placeTree(bx, bz, seed + 601 + gx * 53 + gz * 97);
    }
  }

  // --- Public volume API -------------------------------------------------------

  const isSolid = (x, y, z) => {
    const id = get(x, y, z);
    return id !== AIR && id !== WATER;
  };
  const isOpaque = (x, y, z) => {
    const id = get(x, y, z);
    return id !== AIR && id !== WATER && id !== LEAVES;
  };

  let blocksCache = null;

  return {
    sx,
    sy,
    sz,
    get,
    isSolid,
    isOpaque,
    WATER_LEVEL: WL,
    // Lazy: only built if someone actually reads .blocks (it is ~100k entries
    // at 96x40x96 and the benchmark path never needs it).
    get blocks() {
      if (!blocksCache) {
        blocksCache = [];
        for (let y = 0; y < sy; y++) {
          for (let z = 0; z < sz; z++) {
            for (let x = 0; x < sx; x++) {
              const id = data[idx(x, y, z)];
              if (id !== AIR) blocksCache.push({ x, y, z, id });
            }
          }
        }
      }
      return blocksCache;
    },
    lights,
    // Metadata (handy for benchmark labels; not part of the core contract).
    seed,
    chunksX,
    chunksZ,
    chunkSize,
  };
}
