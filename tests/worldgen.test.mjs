// Voxelheim worldgen test suite (plain node, no framework).
//   node tests/worldgen.test.mjs
// Prints one PASS/FAIL line per case; exits 0 only if all pass.

import { TerrainGenerator } from '../public/src/world/TerrainGenerator.js';
import { makeNoise2D, makeNoise3D, fbm2D } from '../public/src/world/noise.js';
import { DIMENSIONS, portalTarget } from '../public/src/dimensions/dimensions.js';
import { CHUNK_SX, CHUNK_SZ, CHUNK_SY, SEA_LEVEL, blockIndex } from '../public/src/constants.js';
import { BLOCK_ID } from '../public/src/blocks/blocks.js';

let passCount = 0;
let failCount = 0;
function check(name, cond, extra = '') {
  const line = `${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`;
  console.log(line);
  if (cond) passCount++;
  else failCount++;
}

function chunksEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------- noise sanity
{
  const n2 = makeNoise2D('noise-seed');
  const n3 = makeNoise3D(12345);
  let ok = true;
  let spread = 0;
  for (let i = 0; i < 2000; i++) {
    const v2 = n2(i * 0.137, i * -0.291);
    const v3 = n3(i * 0.113, i * 0.071, i * -0.19);
    if (v2 < -1 || v2 > 1 || v3 < -1 || v3 > 1 || Number.isNaN(v2) || Number.isNaN(v3)) ok = false;
    spread = Math.max(spread, Math.abs(v2), Math.abs(v3));
  }
  const f = fbm2D(n2, 3.7, -2.1, 5, 2.0, 0.5);
  check('noise: 2D/3D in [-1,1], fbm2D finite, non-degenerate',
    ok && spread > 0.3 && f >= -1 && f <= 1 && !Number.isNaN(f),
    `maxAbs=${spread.toFixed(3)}`);
}

// --------------------------------------------------------- (a) determinism
{
  const coords = [[0, 0], [3, -2], [-5, 7], [12, 12], [-8, -8]];
  const g1 = new TerrainGenerator('alpha');
  const g2 = new TerrainGenerator('alpha');
  let same = true;
  for (const [cx, cz] of coords) {
    if (!chunksEqual(g1.generateChunk(cx, cz), g2.generateChunk(cx, cz))) same = false;
  }
  for (const dim of ['nether', 'end']) {
    const d1 = new TerrainGenerator('alpha', dim).generateChunk(1, -1);
    const d2 = new TerrainGenerator('alpha', dim).generateChunk(1, -1);
    if (!chunksEqual(d1, d2)) same = false;
  }
  check('determinism: same seed -> byte-identical chunks (5 coords + nether + end)', same);

  const g3 = new TerrainGenerator('beta');
  let differs = false;
  for (const [cx, cz] of coords) {
    if (!chunksEqual(g1.generateChunk(cx, cz), g3.generateChunk(cx, cz))) differs = true;
  }
  check('determinism: different seed -> different chunks', differs);
}

// ------------------------------------------- (b-f) overworld survey 24x24
{
  const gen = new TerrainGenerator('verify123', 'overworld');
  const R = 12; // chunks [-12,12) x [-12,12) = 24x24
  const surface = new Set();
  const counts = new Map();
  const cnt = (id) => counts.get(id) || 0;
  let diamondMaxY = -1;
  let cavePockets = 0;
  let bedrockOK = true;

  for (let cz = -R; cz < R; cz++) {
    for (let cx = -R; cx < R; cx++) {
      const d = gen.generateChunk(cx, cz);
      for (let z = 0; z < CHUNK_SZ; z++) {
        for (let x = 0; x < CHUNK_SX; x++) {
          if (d[blockIndex(x, 0, z)] !== BLOCK_ID.bedrock) bedrockOK = false;
          let surf = 0;
          let sawSolidAbove = false;
          for (let y = CHUNK_SY - 1; y >= 0; y--) {
            const id = d[blockIndex(x, y, z)];
            if (id !== 0 && surf === 0) surf = id;
            if (id !== 0 && id !== BLOCK_ID.water) sawSolidAbove = true;
            else if (id === 0 && sawSolidAbove && y < SEA_LEVEL - 10) cavePockets++;
          }
          if (surf !== 0) surface.add(surf);
        }
      }
      for (let i = 0; i < d.length; i++) {
        const id = d[i];
        if (id === 0) continue;
        counts.set(id, cnt(id) + 1);
        if (id === BLOCK_ID.diamond_ore) {
          const y = Math.floor(i / (CHUNK_SX * CHUNK_SZ));
          if (y > diamondMaxY) diamondMaxY = y;
        }
      }
    }
  }

  const hasSnowVariant = surface.has(BLOCK_ID.snow_grass) || surface.has(BLOCK_ID.snow_block) ||
    cnt(BLOCK_ID.snow_grass) + cnt(BLOCK_ID.snow_block) > 0;
  check('biomes: surface survey includes grass, sand, water, snow variant',
    surface.has(BLOCK_ID.grass) && surface.has(BLOCK_ID.sand) &&
    surface.has(BLOCK_ID.water) && hasSnowVariant,
    `surfaceIds=[${[...surface].sort((a, b) => a - b).join(',')}]`);

  check('trees: log and leaves blocks generated',
    cnt(BLOCK_ID.log) > 0 && cnt(BLOCK_ID.leaves) > 0,
    `log=${cnt(BLOCK_ID.log)} leaves=${cnt(BLOCK_ID.leaves)}`);
  check('cactus: cactus blocks generated in deserts',
    cnt(BLOCK_ID.cactus) > 0, `cactus=${cnt(BLOCK_ID.cactus)}`);

  check('ores: coal, iron, gold, diamond all present',
    cnt(BLOCK_ID.coal_ore) > 0 && cnt(BLOCK_ID.iron_ore) > 0 &&
    cnt(BLOCK_ID.gold_ore) > 0 && cnt(BLOCK_ID.diamond_ore) > 0,
    `coal=${cnt(BLOCK_ID.coal_ore)} iron=${cnt(BLOCK_ID.iron_ore)} gold=${cnt(BLOCK_ID.gold_ore)} diamond=${cnt(BLOCK_ID.diamond_ore)}`);
  check('ores: diamond only at y<=16', diamondMaxY >= 0 && diamondMaxY <= 16,
    `diamondMaxY=${diamondMaxY}`);

  check('caves: air pockets below y=SEA_LEVEL-10 beneath solid ground',
    cavePockets > 0, `pockets=${cavePockets}`);

  check('bedrock: complete layer at y=0 across survey', bedrockOK);
}

// ----------------------------------------------------------- (g) nether
{
  const gen = new TerrainGenerator('verify123', 'nether');
  let netherrack = 0;
  let solid = 0;
  let lavaBelow32 = 0;
  let glowstone = 0;
  let soulSand = 0;
  let bed0 = true;
  let bed127 = true;
  for (let cz = -2; cz <= 2; cz++) {
    for (let cx = -2; cx <= 2; cx++) {
      const d = gen.generateChunk(cx, cz);
      for (let z = 0; z < CHUNK_SZ; z++) {
        for (let x = 0; x < CHUNK_SX; x++) {
          if (d[blockIndex(x, 0, z)] !== BLOCK_ID.bedrock) bed0 = false;
          if (d[blockIndex(x, CHUNK_SY - 1, z)] !== BLOCK_ID.bedrock) bed127 = false;
        }
      }
      for (let i = 0; i < d.length; i++) {
        const id = d[i];
        if (id === 0) continue;
        if (id === BLOCK_ID.lava) {
          if (Math.floor(i / (CHUNK_SX * CHUNK_SZ)) < 32) lavaBelow32++;
          continue;
        }
        solid++;
        if (id === BLOCK_ID.netherrack) netherrack++;
        else if (id === BLOCK_ID.glowstone) glowstone++;
        else if (id === BLOCK_ID.soul_sand) soulSand++;
      }
    }
  }
  check('nether: netherrack is the dominant solid block',
    solid > 0 && netherrack / solid > 0.5,
    `dominance=${(netherrack / solid).toFixed(3)}`);
  check('nether: lava present below y=32', lavaBelow32 > 0, `lava=${lavaBelow32}`);
  check('nether: glowstone present', glowstone > 0, `glowstone=${glowstone}`);
  check('nether: soul sand patches present', soulSand > 0, `soulSand=${soulSand}`);
  check('nether: bedrock complete at y=0 and y=127', bed0 && bed127);
}

// -------------------------------------------------------------- (h) end
{
  const gen = new TerrainGenerator('verify123', 'end');
  let nearStone = 0;
  for (const [cx, cz] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
    const d = gen.generateChunk(cx, cz);
    for (let i = 0; i < d.length; i++) if (d[i] === BLOCK_ID.end_stone) nearStone++;
  }
  check('end: end_stone island present near origin', nearStone > 1000,
    `end_stone=${nearStone}`);

  let farOK = true;
  const fracs = [];
  for (const [cx, cz] of [[40, 40], [-45, 30], [60, -52]]) {
    const d = gen.generateChunk(cx, cz);
    let nonAir = 0;
    for (let i = 0; i < d.length; i++) if (d[i] !== 0) nonAir++;
    const airFrac = 1 - nonAir / d.length;
    fracs.push(airFrac.toFixed(4));
    if (airFrac < 0.97) farOK = false;
  }
  check('end: near-total air far from origin', farOK, `airFrac=[${fracs.join(', ')}]`);
}

// ------------------------------------------------------ (i) performance
{
  const gen = new TerrainGenerator('perf-bench', 'overworld');
  const t0 = process.hrtime.bigint();
  const N = 30;
  for (let i = 0; i < N; i++) gen.generateChunk(1000 + i * 3, -700 + i * 7);
  const avgMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(`perf: average generateChunk over ${N} fresh chunks = ${avgMs.toFixed(2)} ms`);
  check('perf: average generateChunk < 40ms', avgMs < 40, `${avgMs.toFixed(2)} ms`);
}

// ----------------------------------------------------------- dimensions
{
  const dims = ['overworld', 'nether', 'end'];
  const shapeOK = dims.every((k) => {
    const d = DIMENSIONS[k];
    return d && d.id === k && typeof d.name === 'string' &&
      typeof d.fog === 'number' && ['day', 'nether', 'end'].includes(d.skyType) &&
      d.portalBlock === BLOCK_ID.portal;
  });
  const targetsOK = dims.every((k) => dims.includes(portalTarget(k)) && portalTarget(k) !== k);
  check('dimensions: DIMENSIONS shape + portalTarget mapping', shapeOK && targetsOK,
    dims.map((k) => `${k}->${portalTarget(k)}`).join(' '));
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);
