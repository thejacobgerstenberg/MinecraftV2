// tests-plus/worldgen.determinism.test.mjs
//
// Determinism + golden-vector + invariant tests for the REAL Loomfall
// terrain generator (public/src/world/TerrainGenerator.js).
//
// These are ADOPTABLE tests: they import the builder's real game modules
// with relative paths (../public/src/...). In the game worktree tests-plus/
// sits at repo root next to public/, so the paths resolve. On a standalone
// feature/ci checkout the game code is absent, so the top-level feature
// detect below skips the whole file gracefully (node --test stays green).
//
// The golden hashes pinned in GOLDEN[] were computed from the real generator
// at commit 71689cf (feat/voxel-sandbox-game) while authoring this file. They
// lock byte-level determinism: any change to worldgen output flips a hash and
// fails the golden test.

import test from 'node:test';
import assert from 'node:assert/strict';

// ---- top-level feature detect -------------------------------------------
let TG = null;      // { TerrainGenerator, BIOME_NAMES }
let CONST = null;   // constants.js
let BLK = null;     // blocks.js
let DIM = null;     // dimensions.js (optional)
let importError = null;

try {
  TG = await import('../public/src/world/TerrainGenerator.js');
  CONST = await import('../public/src/constants.js');
  BLK = await import('../public/src/blocks/blocks.js');
  try {
    DIM = await import('../public/src/dimensions/dimensions.js');
  } catch { DIM = null; } // dimensions is a nice-to-have, not required
} catch (err) {
  importError = err;
}

const available =
  !importError &&
  TG && typeof TG.TerrainGenerator === 'function' &&
  CONST && typeof CONST.blockIndex === 'function' &&
  BLK && BLK.BLOCK_ID && Array.isArray(BLK.BLOCKS);

if (!available) {
  test('worldgen determinism suite (skipped — real worldgen module not importable)', { skip: true }, () => {
    // Absent game tree on a standalone feature/ci checkout: this is expected.
  });
} else {
  const { TerrainGenerator, BIOME_NAMES } = TG;
  const { CHUNK_SX, CHUNK_SZ, CHUNK_SY, SEA_LEVEL, blockIndex } = CONST;
  const { BLOCK_ID, BLOCKS } = BLK;
  const CHUNK_LEN = CHUNK_SX * CHUNK_SZ * CHUNK_SY;

  const B = BLOCK_ID;

  // 32-bit FNV-1a over the chunk byte array -> 8-char lowercase hex.
  function fnv1aHex(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // --------------------------------------------------------------------
  // 1. DETERMINISM — same (seed,dim,cx,cz) -> byte-identical chunk, twice,
  //    both from one instance and from two independent instances.
  // --------------------------------------------------------------------
  const DET_CASES = [
    { seed: 'loomfall-golden', dim: 'overworld', cx: 0, cz: 0 },
    { seed: 'loomfall-golden', dim: 'overworld', cx: 3, cz: -2 },
    { seed: 42, dim: 'overworld', cx: -5, cz: 7 },
    { seed: 'loomfall-golden', dim: 'nether', cx: 1, cz: 1 },
    { seed: 'loomfall-golden', dim: 'end', cx: 0, cz: 0 },
  ];

  for (const c of DET_CASES) {
    test(`determinism: ${c.dim} seed=${c.seed} (${c.cx},${c.cz}) is byte-stable`, () => {
      const gA = new TerrainGenerator(c.seed, c.dim);
      const a1 = gA.generateChunk(c.cx, c.cz);
      const a2 = gA.generateChunk(c.cx, c.cz); // same instance again

      const gB = new TerrainGenerator(c.seed, c.dim); // fresh instance
      const b1 = gB.generateChunk(c.cx, c.cz);

      assert.equal(a1.length, CHUNK_LEN, 'chunk length must be 16*16*128');
      assert.ok(a1 instanceof Uint8Array, 'generateChunk returns a Uint8Array');
      // Byte-for-byte identical across repeat + across instances.
      assert.deepStrictEqual(a1, a2, 'same instance regenerate must match');
      assert.deepStrictEqual(a1, b1, 'fresh instance must produce identical bytes');
      assert.equal(fnv1aHex(a1), fnv1aHex(b1), 'FNV of two runs must match');
    });
  }

  // --------------------------------------------------------------------
  // 2. GOLDEN VECTORS — pinned FNV-1a hashes. Recomputed from the real
  //    generator; a regression in worldgen output flips these.
  // --------------------------------------------------------------------
  const GOLDEN = [
    { seed: 'loomfall-golden', dim: 'overworld', cx: 0, cz: 0, fnv: '19a84e4b' },
    { seed: 'loomfall-golden', dim: 'overworld', cx: 3, cz: -2, fnv: '1cb70328' },
    { seed: 1337, dim: 'overworld', cx: 0, cz: 0, fnv: '555cbf5e' },
    { seed: 'loomfall-golden', dim: 'nether', cx: 0, cz: 0, fnv: 'f167fcd6' },
    { seed: 'loomfall-golden', dim: 'end', cx: 0, cz: 0, fnv: '241b27bf' },
  ];

  for (const g of GOLDEN) {
    test(`golden: ${g.dim} seed=${g.seed} (${g.cx},${g.cz}) == ${g.fnv}`, () => {
      const data = new TerrainGenerator(g.seed, g.dim).generateChunk(g.cx, g.cz);
      assert.equal(data.length, CHUNK_LEN);
      assert.equal(
        fnv1aHex(data), g.fnv,
        `worldgen output changed for ${g.dim} ${g.seed} (${g.cx},${g.cz}) — ` +
        `if intentional, re-pin the golden hash`,
      );
    });
  }

  // --------------------------------------------------------------------
  // 3. INVARIANTS
  // --------------------------------------------------------------------

  test('constants sanity: 16x16x128, sea level below top', () => {
    assert.equal(CHUNK_SX, 16);
    assert.equal(CHUNK_SZ, 16);
    assert.equal(CHUNK_SY, 128);
    assert.ok(SEA_LEVEL > 0 && SEA_LEVEL < CHUNK_SY, 'sea level within column');
  });

  test('block ids: every generated id maps to a defined block (0..BLOCKS.length-1)', () => {
    const dims = ['overworld', 'nether', 'end'];
    for (const dim of dims) {
      const data = new TerrainGenerator('loomfall-golden', dim).generateChunk(0, 0);
      for (let i = 0; i < data.length; i++) {
        const id = data[i];
        assert.ok(Number.isInteger(id), 'id is an integer');
        assert.ok(id >= 0 && id < BLOCKS.length,
          `${dim}: block id ${id} out of defined range [0,${BLOCKS.length - 1}]`);
      }
    }
  });

  test('overworld: bedrock floor at y=0, air ceiling at y=127', () => {
    const data = new TerrainGenerator('loomfall-golden', 'overworld').generateChunk(0, 0);
    const topY = CHUNK_SY - 1;
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        assert.equal(data[blockIndex(x, 0, z)], B.bedrock,
          `y=0 must be bedrock at (${x},${z})`);
        assert.equal(data[blockIndex(x, topY, z)], B.air,
          `y=${topY} must be air at (${x},${z})`);
      }
    }
  });

  test('overworld: water never sits above SEA_LEVEL (and some water exists)', () => {
    const gen = new TerrainGenerator('loomfall-golden', 'overworld');
    let waterCells = 0;
    let maxWaterY = -1;
    for (let cx = -4; cx <= 4; cx++) {
      for (let cz = -4; cz <= 4; cz++) {
        const data = gen.generateChunk(cx, cz);
        for (let y = 0; y < CHUNK_SY; y++) {
          const base = y * CHUNK_SX * CHUNK_SZ;
          for (let k = 0; k < CHUNK_SX * CHUNK_SZ; k++) {
            if (data[base + k] === B.water) { waterCells++; if (y > maxWaterY) maxWaterY = y; }
          }
        }
      }
    }
    assert.ok(waterCells > 0, 'expected water somewhere in a 9x9 chunk region');
    assert.ok(maxWaterY <= SEA_LEVEL,
      `water at y=${maxWaterY} exceeds SEA_LEVEL=${SEA_LEVEL}`);
  });

  test('overworld: caves carve stone into air (air pockets capped by stone)', () => {
    const data = new TerrainGenerator('loomfall-golden', 'overworld').generateChunk(0, 0);
    let carvedPockets = 0;
    // An air cell in the sub-surface band with a stone cell directly above it
    // is unambiguously carved (surface air would have air above it, not stone).
    for (let y = 2; y < 60; y++) {
      for (let z = 0; z < CHUNK_SZ; z++) {
        for (let x = 0; x < CHUNK_SX; x++) {
          const i = blockIndex(x, y, z);
          if (data[i] === B.air && data[blockIndex(x, y + 1, z)] === B.stone) {
            carvedPockets++;
          }
        }
      }
    }
    assert.ok(carvedPockets > 0, 'expected at least one carved cave pocket');
  });

  test('overworld: ores replace only sub-surface cells; diamond stays <= y16', () => {
    const gen = new TerrainGenerator('loomfall-golden', 'overworld');
    const ORE_IDS = [B.coal_ore, B.iron_ore, B.gold_ore, B.diamond_ore];
    let diamondMaxY = -1;
    let oreCells = 0;
    for (let cx = -2; cx <= 2; cx++) {
      for (let cz = -2; cz <= 2; cz++) {
        const data = gen.generateChunk(cx, cz);
        for (let y = 0; y < CHUNK_SY; y++) {
          const base = y * CHUNK_SX * CHUNK_SZ;
          for (let k = 0; k < CHUNK_SX * CHUNK_SZ; k++) {
            const id = data[base + k];
            if (ORE_IDS.includes(id)) {
              oreCells++;
              assert.ok(y >= 1, `ore never sits in the bedrock layer (y=${y})`);
              if (id === B.diamond_ore && y > diamondMaxY) diamondMaxY = y;
            }
          }
        }
      }
    }
    assert.ok(oreCells > 0, 'expected some ore across the sampled chunks');
    assert.ok(diamondMaxY <= 16,
      `diamond_ore found at y=${diamondMaxY}, expected <= 16`);
  });

  test('nether: netherrack dominant, bedrock caps both y=0 and y=127', () => {
    const data = new TerrainGenerator('loomfall-golden', 'nether').generateChunk(0, 0);
    let netherrack = 0;
    for (const id of data) if (id === B.netherrack) netherrack++;
    // Netherrack is the dominant solid; assert a healthy majority of the volume.
    assert.ok(netherrack > CHUNK_LEN * 0.25,
      `expected netherrack-dominant chunk, got ${netherrack}/${CHUNK_LEN}`);
    const topY = CHUNK_SY - 1;
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        assert.equal(data[blockIndex(x, 0, z)], B.bedrock, 'nether floor bedrock');
        assert.equal(data[blockIndex(x, topY, z)], B.bedrock, 'nether ceiling bedrock');
      }
    }
  });

  test('end: end_stone island exists near the origin', () => {
    const data = new TerrainGenerator('loomfall-golden', 'end').generateChunk(0, 0);
    let endStone = 0;
    for (const id of data) if (id === B.end_stone) endStone++;
    assert.ok(endStone > 1000,
      `expected a substantial end_stone island near origin, got ${endStone}`);
  });

  test('different seeds produce different chunks', () => {
    const coords = [[0, 0], [2, -3]];
    for (const [cx, cz] of coords) {
      const a = new TerrainGenerator('seed-alpha', 'overworld').generateChunk(cx, cz);
      const b = new TerrainGenerator('seed-bravo', 'overworld').generateChunk(cx, cz);
      assert.notEqual(fnv1aHex(a), fnv1aHex(b),
        `distinct seeds must diverge at (${cx},${cz})`);
    }
  });

  test('biomeAt: overworld returns a valid biome name; nether/end return null', () => {
    assert.ok(Array.isArray(BIOME_NAMES) && BIOME_NAMES.length === 8);
    const ow = new TerrainGenerator('loomfall-golden', 'overworld');
    const name = ow.biomeAt(0, 0);
    assert.ok(BIOME_NAMES.includes(name), `biomeAt returned unknown biome: ${name}`);
    assert.equal(new TerrainGenerator('x', 'nether').biomeAt(0, 0), null);
    assert.equal(new TerrainGenerator('x', 'end').biomeAt(0, 0), null);
  });

  test('blockAt: out-of-column convention (y<0 bedrock, y>=128 air)', () => {
    const gen = new TerrainGenerator('loomfall-golden', 'overworld');
    assert.equal(gen.blockAt(0, -1, 0), B.bedrock);
    assert.equal(gen.blockAt(0, CHUNK_SY, 0), B.air);
    // In-range single-cell query matches the generated chunk.
    const data = gen.generateChunk(0, 0);
    for (const y of [0, 1, 40, 100, 127]) {
      assert.equal(gen.blockAt(5, y, 6), data[blockIndex(5, y, 6)],
        `blockAt(5,${y},6) must match generateChunk`);
    }
  });

  // Optional: dimensions module (imported by the real worldgen test too).
  if (DIM && DIM.DIMENSIONS && typeof DIM.portalTarget === 'function') {
    test('dimensions: registry + portalTarget routing', () => {
      for (const id of ['overworld', 'nether', 'end']) {
        assert.ok(DIM.DIMENSIONS[id], `dimension ${id} present`);
        assert.equal(DIM.DIMENSIONS[id].id, id);
      }
      assert.equal(DIM.portalTarget('overworld', B.end_stone), 'end');
      assert.equal(DIM.portalTarget('overworld'), 'nether');
      assert.equal(DIM.portalTarget('nether'), 'overworld');
      assert.equal(DIM.portalTarget('end'), 'overworld');
    });
  }
}
