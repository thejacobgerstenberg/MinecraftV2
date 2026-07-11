// tests-plus/meshing.test.mjs
//
// node:test coverage for the REAL chunk mesher (per TEST RECON):
//   public/src/engine/ChunkMesher.js  -> { buildChunkMesh }
//   public/src/engine/World.js        -> { World }
//   public/src/engine/Chunk.js        -> { chunkKey }
//
// buildChunkMesh(world, cx, cz, atlas) -> { opaque, transparent, cutout }
// where each entry is a THREE.BufferGeometry | null (imports `three`, node-safe).
//
// FEATURE-DETECT / SKIP GUARD:
//   On the feature/ci branch the game tree (public/src/...) and `three` are
//   absent, so we dynamic-import inside try/catch. If any import fails (module
//   missing OR three not installed) we register a single skipped test with a
//   clear TODO instead of crashing the file. In the game worktree
//   (origin/feat/voxel-sandbox-game, where tests-plus/ sits next to public/)
//   the real assertions run.
//
// Block ids used (from public/src/blocks/blocks.js):
//   3 = stone (solid, opaque), 8 = water (liquid, transparent, non-solid),
//   12 = glass (solid, transparent -> cutout), 24 = glowstone (emissive).
//
// NOTE on GREEDY MESH: the recon shows this mesher does NOT merge coplanar
// faces (it is a plain face-culling mesher — one quad per exposed face). The
// greedy-equivalence test below is written to hold for BOTH a naive and a
// hypothetical future greedy mesher: it asserts (merged quad count) <= naive
// AND that the emitted quads cover exactly the same surface area.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- Feature-detect the real mesher ----------------------------------------
let World = null;
let chunkKey = null;
let buildChunkMesh = null;
let loadError = null;

try {
  const [worldMod, chunkMod, mesherMod] = await Promise.all([
    import('../public/src/engine/World.js'),
    import('../public/src/engine/Chunk.js'),
    import('../public/src/engine/ChunkMesher.js'),
  ]);
  World = worldMod.World;
  chunkKey = chunkMod.chunkKey;
  buildChunkMesh = mesherMod.buildChunkMesh;
  if (typeof buildChunkMesh !== 'function' || typeof World !== 'function') {
    throw new Error('mesher/World exports not callable');
  }
} catch (err) {
  loadError = err;
}

// All-air generator + a fake atlas: unit UV rect for every tile.
const airGen = { generateChunk: () => new Uint8Array(16 * 16 * 128) };
const fakeAtlas = { texture: null, tileUV: () => ({ u0: 0, v0: 0, u1: 1, v1: 1 }) };

// Geometry helpers.
const verts = (g) => (g ? g.getAttribute('position').count : 0);
const inds = (g) => (g ? g.index.count : 0);
const faces = (g) => verts(g) / 4; // 4 verts per quad face

// Collect the per-face quads (groups of 4 consecutive verts, since the mesher
// appends exactly 4 verts per emitted face) whose normal matches `dir`.
function quadsWithNormal(g, [nx, ny, nz]) {
  if (!g) return [];
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const c = g.getAttribute('color');
  const out = [];
  for (let i = 0; i < p.count; i += 4) {
    if (n.getX(i) !== nx || n.getY(i) !== ny || n.getZ(i) !== nz) continue;
    const q = [];
    for (let k = 0; k < 4; k++) {
      q.push({
        x: p.getX(i + k),
        y: p.getY(i + k),
        z: p.getZ(i + k),
        color: c.getX(i + k),
      });
    }
    out.push(q);
  }
  return out;
}

if (loadError) {
  test('meshing: real mesher not importable — skipped (TODO)', { skip: true }, () => {
    // TODO: runs for real only in the game worktree (origin/feat/voxel-sandbox-game)
    // where public/src/engine/ChunkMesher.js and `three` are present. On
    // feature/ci the game tree is absent, so this file self-skips.
    // Import error was: ${loadError && loadError.message}
  });
} else {
  // =========================================================================
  // FACE CULLING
  // =========================================================================

  test('cull: isolated solid block emits exactly 6 visible faces', () => {
    const w = new World(airGen);
    w.setBlock(5, 10, 5, 3); // one stone in a void
    const m = buildChunkMesh(w, 0, 0, fakeAtlas);
    assert.equal(faces(m.opaque), 6, 'a lone block shows all 6 faces');
    assert.equal(verts(m.opaque), 24);
    assert.equal(inds(m.opaque), 36); // 6 faces * 6 indices
    assert.equal(m.transparent, null);
    assert.equal(m.cutout, null);
  });

  test('cull: a solid block fully surrounded by solids emits 0 visible faces', () => {
    const w = new World(airGen);
    const cx = 5, cy = 10, cz = 5;
    w.setBlock(cx, cy, cz, 3); // center
    // Wrap it on all six sides.
    const neighbors = [
      [cx + 1, cy, cz], [cx - 1, cy, cz],
      [cx, cy + 1, cz], [cx, cy - 1, cz],
      [cx, cy, cz + 1], [cx, cy, cz - 1],
    ];
    for (const [x, y, z] of neighbors) w.setBlock(x, y, z, 3);

    const m = buildChunkMesh(w, 0, 0, fakeAtlas);
    // Total faces = 6 neighbors * 6 - 6 hidden (one per neighbor toward the
    // center) = 30. The center itself contributes 0 — if it emitted anything
    // the total would exceed 30. This is the direct "fully surrounded -> 0".
    assert.equal(faces(m.opaque), 30, 'buried center contributes zero faces');

    // Prove no face lies inside the 1x1x1 center cell (5..6, 10..11, 5..6):
    // every emitted quad must sit on the OUTER shell, never strictly interior.
    const p = m.opaque.getAttribute('position');
    let interiorFaceVerts = 0;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      if (x > 5 && x < 6 && y > 10 && y < 11 && z > 5 && z < 6) interiorFaceVerts++;
    }
    assert.equal(interiorFaceVerts, 0, 'no geometry strictly inside the buried cell');
  });

  test('cull: a flat surface culls internal (shared) faces', () => {
    const w = new World(airGen);
    const K = 8; // 8x8 one-thick stone slab, kept off chunk borders (2..9)
    for (let lx = 2; lx < 2 + K; lx++)
      for (let lz = 2; lz < 2 + K; lz++) w.setBlock(lx, 10, lz, 3);

    const m = buildChunkMesh(w, 0, 0, fakeAtlas);
    // With culling: top K^2 + bottom K^2 + sides (perimeter) = 4K.
    const expected = K * K + K * K + 4 * K; // 64 + 64 + 32 = 160 faces
    assert.equal(faces(m.opaque), expected, `slab should cull internal faces`);
    // Sanity: this is far below the un-culled 6*K^2 = 384 faces.
    assert.ok(faces(m.opaque) < 6 * K * K, 'internal faces were culled');
  });

  // =========================================================================
  // GREEDY-MESH EQUIVALENCE (holds for naive AND greedy mesher)
  // =========================================================================

  test('greedy-equiv: top faces cover the full surface area with <= naive quad count', () => {
    const w = new World(airGen);
    const K = 8;
    const cells = K * K;
    for (let lx = 2; lx < 2 + K; lx++)
      for (let lz = 2; lz < 2 + K; lz++) w.setBlock(lx, 10, lz, 3);

    const m = buildChunkMesh(w, 0, 0, fakeAtlas);
    const topQuads = quadsWithNormal(m.opaque, [0, 1, 0]);

    // (1) Merged quad count is never worse than the naive one-quad-per-cell.
    assert.ok(topQuads.length <= cells, `top quads ${topQuads.length} <= naive ${cells}`);
    assert.ok(topQuads.length >= 1, 'at least one top quad emitted');

    // (2) The quads cover exactly the same xz surface area (union == cells).
    // Axis-aligned coplanar quads at the same y do not overlap, so summing
    // per-quad footprint area equals the covered area for both naive & greedy.
    let area = 0;
    for (const q of topQuads) {
      const xs = q.map((v) => v.x);
      const zs = q.map((v) => v.z);
      area += (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
      // Each top quad sits on the slab's top plane (y = 11).
      for (const v of q) assert.equal(v.y, 11, 'top quad on the slab surface plane');
    }
    assert.equal(area, cells, `covered area ${area} must equal ${cells} cells`);
  });

  // =========================================================================
  // AMBIENT OCCLUSION (baked into the per-vertex color attribute)
  // AO_BRIGHTNESS = [1.0, 0.85, 0.7, 0.55]; top-face shade = 1.0.
  // =========================================================================

  // For a top-face corner of block (5,10,5), the three AO samples for the
  // +x/+z corner (world vertex 6,11,6) are the blocks at:
  //   side1 -> (6,11,5), side2 -> (5,11,6), corner -> (6,11,6).
  // occlusion count: side1&&side2 -> 3, else (side1)+(side2)+(corner).
  function topFaceColorAt(m, wx, wy, wz) {
    const quads = quadsWithNormal(m.opaque, [0, 1, 0]);
    for (const q of quads) {
      for (const v of q) {
        if (v.x === wx && v.y === wy && v.z === wz) return v.color;
      }
    }
    return null;
  }

  test('AO: open corner (0 neighbors) is full-bright 1.0', () => {
    const w = new World(airGen);
    w.setBlock(5, 10, 5, 3);
    const m = buildChunkMesh(w, 0, 0, fakeAtlas);
    const open = topFaceColorAt(m, 5, 11, 5); // -x/-z corner, nothing around
    assert.notEqual(open, null, 'found the open top corner vertex');
    assert.ok(Math.abs(open - 1.0) < 1e-6, `open corner = 1.0, got ${open}`);
  });

  test('AO: corner with 1 side neighbor -> occlusion 1 -> 0.85', () => {
    const w = new World(airGen);
    w.setBlock(5, 10, 5, 3);
    w.setBlock(6, 11, 5, 3); // side1 only (side2 & corner empty)
    const m = buildChunkMesh(w, 0, 0, fakeAtlas);
    const occ = topFaceColorAt(m, 6, 11, 6); // +x/+z corner
    assert.notEqual(occ, null, 'found the occluded top corner vertex');
    assert.ok(Math.abs(occ - 0.85) < 1e-6, `occlusion 1 -> 0.85, got ${occ}`);
  });

  test('AO: corner with 2 neighbors (side + diagonal, not both sides) -> occlusion 2 -> 0.7', () => {
    const w = new World(airGen);
    w.setBlock(5, 10, 5, 3);
    // side1 at (6,11,5) and corner at (6,11,6); leave side2 (5,11,6) empty.
    // -> ao = side1(1) + side2(0) + corner(1) = 2 (NOT the side1&&side2 case).
    w.setBlock(6, 11, 5, 3);
    w.setBlock(6, 11, 6, 3);
    const m = buildChunkMesh(w, 0, 0, fakeAtlas);
    const occ = topFaceColorAt(m, 6, 11, 6);
    assert.notEqual(occ, null, 'found the 2-neighbor top corner vertex');
    assert.ok(Math.abs(occ - 0.7) < 1e-6, `occlusion 2 -> 0.7, got ${occ}`);
  });

  test('AO: corner enclosed by both side neighbors -> occlusion 3 -> 0.55', () => {
    const w = new World(airGen);
    w.setBlock(5, 10, 5, 3);
    // Both sides present forces the classic side1&&side2 -> occlusion 3 rule.
    w.setBlock(6, 11, 5, 3); // side1
    w.setBlock(5, 11, 6, 3); // side2
    const m = buildChunkMesh(w, 0, 0, fakeAtlas);
    const occ = topFaceColorAt(m, 6, 11, 6);
    assert.notEqual(occ, null, 'found the fully-occluded top corner vertex');
    assert.ok(Math.abs(occ - 0.55) < 1e-6, `occlusion 3 -> 0.55, got ${occ}`);
  });

  test('AO: an occluded corner is strictly darker than an open corner', () => {
    const w = new World(airGen);
    w.setBlock(5, 10, 5, 3);
    w.setBlock(6, 11, 5, 3); // occluder beside the +x edge of the top face
    const m = buildChunkMesh(w, 0, 0, fakeAtlas);
    const occluded = topFaceColorAt(m, 6, 11, 6);
    const open = topFaceColorAt(m, 5, 11, 5);
    assert.notEqual(occluded, null);
    assert.notEqual(open, null);
    assert.ok(occluded < open, `occluded ${occluded} < open ${open}`);
  });

  // =========================================================================
  // BUCKETING & TRANSPARENT-vs-TRANSPARENT CULLING (supporting behavior)
  // =========================================================================

  test('bucket: solid-transparent (glass) never hides an adjacent opaque face', () => {
    const w = new World(airGen);
    w.setBlock(5, 10, 5, 3);  // stone
    w.setBlock(6, 10, 5, 12); // glass beside it
    const m = buildChunkMesh(w, 0, 0, fakeAtlas);
    // Stone keeps all 6 faces (glass is transparent -> does not cull opaque).
    assert.equal(faces(m.opaque), 6, 'stone emits all 6 faces next to glass');
    // Glass hides only its shared face with the stone: 5 faces in cutout.
    assert.equal(faces(m.cutout), 5, 'glass culls its face against the stone');
  });

  test('cull: two blocks of the same transparent id cull their shared face', () => {
    const w = new World(airGen);
    w.setBlock(5, 10, 5, 8); // water
    w.setBlock(6, 10, 5, 8); // water
    const m = buildChunkMesh(w, 0, 0, fakeAtlas);
    // 2 * 6 - 2 shared = 10 faces, all in the transparent (blended) bucket.
    assert.equal(faces(m.transparent), 10, 'same-id transparent shared face culled');
    assert.equal(m.opaque, null);
  });
}
