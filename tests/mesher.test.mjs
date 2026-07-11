// Voxelheim mesher tests — plain node script, no framework.
// Run: node tests/mesher.test.mjs   (exit code 0 only if all cases pass)

import { World } from '../public/src/engine/World.js';
import { chunkKey } from '../public/src/engine/Chunk.js';
import { buildChunkMesh } from '../public/src/engine/ChunkMesher.js';

const airGen = { generateChunk: () => new Uint8Array(16 * 16 * 128) };
const fakeAtlas = { texture: null, tileUV: () => ({ u0: 0, v0: 0, u1: 1, v1: 1 }) };

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`PASS ${name}`);
    pass++;
  } else {
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ''}`);
    fail++;
  }
}

const verts = (g) => (g ? g.getAttribute('position').count : 0);
const inds = (g) => (g ? g.index.count : 0);

// ---- World sanity -----------------------------------------------------------
{
  const w = new World(airGen);
  check('world: y<0 reads bedrock (17)', w.getBlock(3, -1, 3) === 17);
  check('world: y>=128 reads air (0)', w.getBlock(3, 128, 3) === 0);
  w.setBlock(0, 10, 5, 3); // x on the -x border of chunk (0,0)
  check(
    'world: border setBlock dirties both chunks',
    w.dirtyChunks.has(chunkKey(0, 0)) && w.dirtyChunks.has(chunkKey(-1, 0)),
    `dirty=${[...w.dirtyChunks].join(' ')}`
  );
}

// ---- Case 1: single stone block -> exactly 6 faces --------------------------
{
  const w = new World(airGen);
  w.setBlock(5, 10, 5, 3);
  const m = buildChunkMesh(w, 0, 0, fakeAtlas);
  check('single stone: opaque 24 verts', verts(m.opaque) === 24, `got ${verts(m.opaque)}`);
  check('single stone: opaque 36 indices', inds(m.opaque) === 36, `got ${inds(m.opaque)}`);
  check('single stone: transparent is null', m.transparent === null);
  check('single stone: cutout is null', m.cutout === null);
}

// ---- Case 2: two adjacent stones -> 10 faces --------------------------------
{
  const w = new World(airGen);
  w.setBlock(5, 10, 5, 3);
  w.setBlock(6, 10, 5, 3);
  const m = buildChunkMesh(w, 0, 0, fakeAtlas);
  check('two stones: 40 verts (10 faces)', verts(m.opaque) === 40, `got ${verts(m.opaque)}`);
  check('two stones: 60 indices', inds(m.opaque) === 60, `got ${inds(m.opaque)}`);
}

// ---- Case 3: buried block contributes 0 faces -------------------------------
{
  const w = new World(airGen);
  for (let x = 4; x <= 6; x++)
    for (let y = 9; y <= 11; y++)
      for (let z = 4; z <= 6; z++) w.setBlock(x, y, z, 3);
  const m = buildChunkMesh(w, 0, 0, fakeAtlas);
  // 3x3x3 solid cube: only the 54 surface faces (9 per side), center culled.
  check('3x3x3 cube: 216 verts (54 faces, buried center culled)', verts(m.opaque) === 216, `got ${verts(m.opaque)}`);
  check('3x3x3 cube: 324 indices', inds(m.opaque) === 324, `got ${inds(m.opaque)}`);
}

// ---- Case 4: water goes in the transparent bucket, lowered top --------------
{
  const w = new World(airGen);
  w.setBlock(5, 10, 5, 8); // water
  const m = buildChunkMesh(w, 0, 0, fakeAtlas);
  check('water: opaque is null', m.opaque === null);
  check('water: transparent has 24 verts', verts(m.transparent) === 24, `got ${verts(m.transparent)}`);
  let maxY = -Infinity;
  if (m.transparent) {
    const p = m.transparent.getAttribute('position');
    for (let i = 0; i < p.count; i++) maxY = Math.max(maxY, p.getY(i));
  }
  check('water: top surface lowered to y=10.9', Math.abs(maxY - 10.9) < 1e-6, `maxY=${maxY}`);
}

// ---- Case 5: stone next to glass -> stone face IS emitted -------------------
{
  const w = new World(airGen);
  w.setBlock(5, 10, 5, 3); // stone
  w.setBlock(6, 10, 5, 12); // glass
  const m = buildChunkMesh(w, 0, 0, fakeAtlas);
  check('stone|glass: stone emits all 6 faces', verts(m.opaque) === 24, `got ${verts(m.opaque)}`);
  // Specifically: an opaque +x face on the x=6 plane must exist.
  let plusXFaceAt6 = 0;
  const p = m.opaque.getAttribute('position');
  const n = m.opaque.getAttribute('normal');
  for (let i = 0; i < p.count; i++) {
    if (n.getX(i) === 1 && p.getX(i) === 6) plusXFaceAt6++;
  }
  check('stone|glass: +x stone face on x=6 plane', plusXFaceAt6 === 4, `got ${plusXFaceAt6} verts`);
  // Glass hides its face against the stone: 5 faces in the cutout bucket.
  check('stone|glass: glass has 5 faces (cutout bucket)', verts(m.cutout) === 20, `got ${verts(m.cutout)}`);
}

// ---- Case 6: same transparent id faces are culled ---------------------------
{
  const w = new World(airGen);
  w.setBlock(5, 10, 5, 8);
  w.setBlock(6, 10, 5, 8); // water next to water
  const m = buildChunkMesh(w, 0, 0, fakeAtlas);
  check('water|water: shared faces culled (10 faces)', verts(m.transparent) === 40, `got ${verts(m.transparent)}`);
}

// ---- Case 7: AO — occluded corner darker than open corner -------------------
{
  const w = new World(airGen);
  w.setBlock(5, 10, 5, 3); // target block
  w.setBlock(6, 11, 5, 3); // occluder sitting beside the target's top face
  const m = buildChunkMesh(w, 0, 0, fakeAtlas);
  const p = m.opaque.getAttribute('position');
  const n = m.opaque.getAttribute('normal');
  const c = m.opaque.getAttribute('color');
  let occludedColor = null;
  let openColor = null;
  for (let i = 0; i < p.count; i++) {
    // Top-face verts of the target block: normal +y, y=11, x in [5,6], z in [5,6].
    if (n.getY(i) !== 1 || p.getY(i) !== 11) continue;
    const x = p.getX(i);
    const z = p.getZ(i);
    if (x < 5 || x > 6 || z < 5 || z > 6) continue;
    if (x === 6) occludedColor = c.getX(i);
    if (x === 5) openColor = c.getX(i);
  }
  check(
    'AO: corner next to occluder darker than open corner',
    occludedColor !== null && openColor !== null && occludedColor < openColor,
    `occluded=${occludedColor} open=${openColor}`
  );
  check('AO: occluded corner = 0.85 (occlusion 1)', Math.abs(occludedColor - 0.85) < 1e-6, `got ${occludedColor}`);
  check('AO: open corner = 1.0 (occlusion 0)', Math.abs(openColor - 1.0) < 1e-6, `got ${openColor}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
