// Voxelheim directional-culling tests — plain node script, no framework.
// Run: node tests/dircull.test.mjs   (exit code 0 only if all cases pass)

import { World } from '../public/src/engine/World.js';
import { buildChunkMesh } from '../public/src/engine/ChunkMesher.js';
import {
  buildDirectionalIndexVariants,
  selectDirectionalRange,
} from '../public/src/engine/DirectionalCulling.js';

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

/** Multiset of sorted triangle triples — order-independent equality. */
function triSet(index, from = 0, to = index.length) {
  const tris = [];
  for (let i = from; i < to; i += 3) {
    tris.push([index[i], index[i + 1], index[i + 2]].join('/'));
  }
  return tris.sort().join('|');
}

/** Face normals for each face inside an index range. */
function normalsInRange(index, normals, from, to) {
  const out = [];
  for (let i = from; i < to; i += 6) {
    const v0 = index[i];
    out.push([normals[v0 * 3], normals[v0 * 3 + 1], normals[v0 * 3 + 2]]);
  }
  return out;
}

function buildFor(geom) {
  return buildDirectionalIndexVariants(
    geom.index.array,
    geom.getAttribute('position').array,
    geom.getAttribute('normal').array,
  );
}

// ---- Single block: 6 faces, one per direction --------------------------------
{
  const w = new World(airGen);
  w.setBlock(5, 10, 5, 3);
  const m = buildChunkMesh(w, 0, 0, fakeAtlas);
  const idx = m.opaque.index.array;
  const nrm = m.opaque.getAttribute('normal').array;
  const dir = buildFor(m.opaque);

  check('variants: 4 produced', dir.variants.length === 4);
  const allSame = dir.variants.every((v) => triSet(v.index) === triSet(idx));
  check('variants: triangles preserved in every ordering', allSame);

  // Variant 0 hides +x then +z: segment sizes must be exactly one face each.
  const v0 = dir.variants[0];
  check('variant0: one +x face segment', v0.xEnd === 6, `xEnd=${v0.xEnd}`);
  check('variant0: one +z face segment', v0.xzEnd - v0.xEnd === 6, `xzEnd=${v0.xzEnd}`);
  const hiddenX = normalsInRange(v0.index, nrm, 0, v0.xEnd);
  const hiddenZ = normalsInRange(v0.index, nrm, v0.xEnd, v0.xzEnd);
  check('variant0: X segment is the +x face', hiddenX.length === 1 && hiddenX[0][0] === 1);
  check('variant0: Z segment is the +z face', hiddenZ.length === 1 && hiddenZ[0][2] === 1);
  // The middle segment holds no +x/+z/-y faces.
  const mid = normalsInRange(v0.index, nrm, v0.xzEnd, dir.botStart);
  check('variant0: middle has no +x/+z/-y faces',
    mid.every((n) => n[0] !== 1 && n[2] !== 1 && n[1] !== -1), JSON.stringify(mid));

  // Bottom tail: the single -y face, with its plane height recorded.
  check('tail: one -y face', dir.botYs.length === 1 && idx.length - dir.botStart === 6);
  check('tail: -y plane height is 10', dir.botYs[0] === 10, `got ${dir.botYs[0]}`);
  const tail = normalsInRange(v0.index, nrm, dir.botStart, v0.index.length);
  check('tail: holds the -y face', tail.length === 1 && tail[0][1] === -1);

  // Variant 3 hides -x then -z.
  const v3 = dir.variants[3];
  const hX3 = normalsInRange(v3.index, nrm, 0, v3.xEnd);
  const hZ3 = normalsInRange(v3.index, nrm, v3.xEnd, v3.xzEnd);
  check('variant3: X segment is the -x face', hX3.length === 1 && hX3[0][0] === -1);
  check('variant3: Z segment is the -z face', hZ3.length === 1 && hZ3[0][2] === -1);
}

// ---- Bottom-face tail ordering & eye-height cutoff ----------------------------
{
  const w = new World(airGen);
  // Three floating blocks at different heights -> three -y faces.
  w.setBlock(4, 10, 4, 3);
  w.setBlock(8, 30, 8, 3);
  w.setBlock(12, 50, 12, 3);
  const m = buildChunkMesh(w, 0, 0, fakeAtlas);
  const dir = buildFor(m.opaque);
  check('tail: sorted descending', dir.botYs[0] === 50 && dir.botYs[1] === 30 && dir.botYs[2] === 10,
    Array.from(dir.botYs).join(','));

  const L = m.opaque.index.count;
  // Eye above everything (y=60): all three bottoms hidden.
  let sel = selectDirectionalRange(dir, 8, 60, 8, 0, 16, 0, 16, L);
  check('cutoff: eye above all -> tail fully cut', sel.start + sel.count === dir.botStart,
    JSON.stringify(sel));
  // Eye at y=40: the y=50 bottom stays (visible from below), others cut.
  sel = selectDirectionalRange(dir, 8, 40, 8, 0, 16, 0, 16, L);
  check('cutoff: eye between -> higher bottoms stay',
    sel.start + sel.count === dir.botStart + 6, JSON.stringify(sel));
  // Eye below everything (y=2): all bottoms drawn.
  sel = selectDirectionalRange(dir, 8, 2, 8, 0, 16, 0, 16, L);
  check('cutoff: eye below all -> tail fully drawn', sel.start + sel.count === L);
  // Equality: eye exactly at a face plane -> that face is edge-on, hidden.
  sel = selectDirectionalRange(dir, 8, 50, 8, 0, 16, 0, 16, L);
  check('cutoff: eye exactly at plane hides that face',
    sel.start + sel.count === dir.botStart, JSON.stringify(sel));
}

// ---- selectDirectionalRange side semantics -----------------------------------
{
  const w = new World(airGen);
  w.setBlock(5, 10, 5, 3);
  w.setBlock(9, 12, 9, 3);
  const m = buildChunkMesh(w, 0, 0, fakeAtlas);
  const nrm = m.opaque.getAttribute('normal').array;
  const dir = buildFor(m.opaque);
  const L = m.opaque.index.count;
  const eyeY = 5; // below both blocks: bottom tail fully visible

  // Eye far west + far north of the chunk (x<=0, z<=0): +x and +z faces of
  // chunk [0..16) can never be seen.
  let sel = selectDirectionalRange(dir, -20, eyeY, -20, 0, 16, 0, 16, L);
  check('select: NW eye hides +x/+z segments',
    sel.variant === 0 && sel.start === dir.variants[0].xzEnd, JSON.stringify(sel));
  {
    const drawn = normalsInRange(dir.variants[sel.variant].index, nrm, sel.start, sel.start + sel.count);
    check('select: NW drawn set has no +x/+z faces',
      drawn.every((n) => n[0] !== 1 && n[2] !== 1));
    check('select: NW drawn face count', drawn.length === 8, `drawn=${drawn.length}`);
  }

  // Eye east of the chunk, inside its z-slab: only -x faces hidden.
  sel = selectDirectionalRange(dir, 40, eyeY, 8, 0, 16, 0, 16, L);
  {
    const v = dir.variants[sel.variant];
    check('select: E eye skips only the X segment', sel.start === v.xEnd, JSON.stringify(sel));
    const drawn = normalsInRange(v.index, nrm, sel.start, sel.start + sel.count);
    check('select: E drawn set has no -x faces', drawn.every((n) => n[0] !== -1));
    check('select: E drawn set keeps both z directions',
      drawn.some((n) => n[2] === 1) && drawn.some((n) => n[2] === -1));
  }

  // Eye inside the chunk: everything drawn (bottoms below eye still cut).
  sel = selectDirectionalRange(dir, 8, eyeY, 8, 0, 16, 0, 16, L);
  check('select: inside eye draws everything', sel.start === 0 && sel.count === L);

  // Eye exactly on the west edge: +x faces at x=0..16 all have eye.x <= faceX.
  sel = selectDirectionalRange(dir, 0, eyeY, 8, 0, 16, 0, 16, L);
  {
    const v = dir.variants[sel.variant];
    const drawn = normalsInRange(v.index, nrm, sel.start, sel.start + sel.count);
    check('select: west-edge eye hides +x faces', drawn.every((n) => n[0] !== 1));
  }
}

// ---- Drawn-set equivalence with GPU backface culling --------------------------
{
  // For a bumpy terrain slab with an overhang, verify from several eyes:
  // every face EXCLUDED by the selected range is backfacing (the GPU would
  // discard it), and every front-facing face is INCLUDED.
  const gen = {
    generateChunk: () => {
      const data = new Uint8Array(16 * 16 * 128);
      for (let z = 0; z < 16; z++)
        for (let x = 0; x < 16; x++) {
          const h = 8 + ((x * 7 + z * 13) % 5);
          for (let y = 0; y <= h; y++) data[x + z * 16 + y * 256] = 3;
        }
      // Floating shelf -> bottom faces at y=20.
      for (let x = 3; x <= 6; x++) data[x + 5 * 16 + 20 * 256] = 3;
      return data;
    },
  };
  const w = new World(gen);
  const m = buildChunkMesh(w, 0, 0, fakeAtlas);
  const idx = m.opaque.index.array;
  const pos = m.opaque.getAttribute('position').array;
  const nrm = m.opaque.getAttribute('normal').array;
  const dir = buildFor(m.opaque);
  const eyes = [[-30, 5, -30], [50, 20, 8], [8, 100, 90], [-10, 12, 40], [8, 15, 8], [4, 19, 5]];
  let ok = true;
  let msg = '';
  for (const [ex, ey, ez] of eyes) {
    const sel = selectDirectionalRange(dir, ex, ey, ez, 0, 16, 0, 16, idx.length);
    const v = dir.variants[sel.variant];
    const included = new Set();
    for (let i = sel.start; i < sel.start + sel.count; i += 6) included.add(triSet(v.index, i, i + 6));
    for (let i = 0; i < idx.length; i += 6) {
      const key = triSet(idx, i, i + 6);
      const v0 = idx[i];
      const n = [nrm[v0 * 3], nrm[v0 * 3 + 1], nrm[v0 * 3 + 2]];
      const p = [pos[v0 * 3], pos[v0 * 3 + 1], pos[v0 * 3 + 2]];
      // Front-facing test for an axis-aligned face: eye on the normal side.
      const d = (ex - p[0]) * n[0] + (ey - p[1]) * n[1] + (ez - p[2]) * n[2];
      const frontFacing = d > 0;
      if (frontFacing && !included.has(key)) {
        ok = false;
        msg = `eye ${ex},${ey},${ez} missing front face n=${n} p=${p}`;
        break;
      }
    }
    if (!ok) break;
  }
  check('equivalence: every front-facing face is always drawn', ok, msg);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
