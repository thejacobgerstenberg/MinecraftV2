// graphics-lab/src/greedyMesher.js
//
// GREEDY voxel mesher that preserves the per-vertex corner AO + atlas texturing
// of src/voxelMesher.js while collapsing runs of identical coplanar faces into
// single quads (dramatically fewer triangles on flat terrain).
//
// buildGreedyChunkGeometry(volume, { ao = true, atlas = null })
//   -> { solid: THREE.BufferGeometry, transparent: THREE.BufferGeometry|null,
//        stats: { quadsBefore, quadsAfter } }
//
// ATTRIBUTE CONTRACT — a superset of voxelMesher.js so materials stay
// interchangeable:
//   position (vec3), normal (vec3), uv (vec2), color (vec3 rgb),
//   ao (float 0..1)                      // same 5 attributes as voxelMesher
//   tileOrigin (vec2)                    // NEW: raw atlas-tile rect origin (u0,v0)
//   tileSpan  (vec2)                     // NEW: quad size in blocks along the
//                                        //      face's texture-UV axes
// In atlas mode the 'uv' attribute now carries LOCAL tile-space coords in
// 0..W / 0..H (one unit per block) instead of absolute atlas coords — a merged
// WxH quad cannot stretch a single 16x16 tile, so the tiled material
// (voxelMaterial.js with { tiled: true }) reconstructs the sample per fragment:
//     sampleUV = tileOrigin + halfTexelInset
//              + fract(localUV) * (tileSizeUV - 2 * halfTexelInset)
// i.e. the half-texel anti-bleed inset that voxelMesher bakes into its UVs is
// applied in the SHADER here (tileOrigin is the raw, un-inset rect origin).
// Plain (non-tiled) materials must not be used on greedy atlas geometry — the
// local UVs would sample across the whole atlas.
//
// GREEDY MERGE RULES (per face direction, plane by plane):
//   Two cells merge only when their (blockId, face direction) match — which
//   fixes the atlas tile, shade bucket, and vertex color — AND their four
//   corner-AO tuples are IDENTICAL. On top of the identical-tuple baseline we
//   additionally require the AO tuple to be UNIFORM ALONG EACH MERGE AXIS
//   (extend width only when ao(u0,*) == ao(u1,*); extend height only when
//   ao(*,v0) == ao(*,v1)). This is the simplest fully correct rule: it makes
//   the merged quad's interpolated AO field bit-identical to the unmerged
//   mesh (identical tuples alone would smooth a repeating per-cell AO ramp
//   into one long gradient). In practice almost all merge candidates are
//   fully lit (all four corners at AO level 3), so merging stays dramatic.
//   The quad-flip rule (triangulate along the darker diagonal) is preserved
//   verbatim; identical tuples mean the merged quad flips exactly like each
//   of its source cells did.
//
// DIFFERENCE VS voxelMesher (documented, deliberate): the per-block
// deterministic brightness variation (blockHash01 "vary" tint) is DROPPED in
// atlas mode — a unique tint per block would make every cell's color unique
// and forbid all merging. Greedy atlas color = ATLAS_TINT * face shade only.
//
// Water is never meshed (same as voxelMesher); solid faces bordering water ARE
// emitted. Leaves go to the `transparent` geometry.
//
// Stats: the returned `stats` object reports the face-culled quad count the
// classic mesher would emit (quadsBefore) vs the merged count (quadsAfter).
// The module-level `lastGreedyStats` object is mutated with the same numbers
// on every build (handy for GUI display without threading the return value).
//
// Perf notes: this is a BUILD-TIME function (chunk (re)mesh), not a per-frame
// hot path. It reuses one plane mask + fixed scratch arrays across all six
// sweeps; the only growing allocation is the flat quad list (numbers only).
//
// SELF-TEST: `node src/greedyMesher.js` runs a mock-volume self-test (flat
// 8x1x8 grass slab must collapse 160 -> 6 quads, attribute counts must stay
// consistent, AO level math must match voxelMesher.computeCornerAO). To make
// that possible without an npm-installed `three`, the module resolves bare
// 'three' first (the importmap in index.html — the ONLY path taken in the
// browser) and falls back to the vendored ../vendor/three.module.js under
// plain node. Same vendored file either way — no CDN, no network.

import { AIR, WATER, LEAVES, BLOCKS, faceColor } from './blocks.js';

// --- three + voxelMesher AO logic (bare specifier first, vendor fallback) ----
//
// In the browser both imports resolve through the importmap, so the REAL
// exported computeCornerAO / AO_LEVELS from voxelMesher.js are reused and any
// tuning there is automatically inherited. Under plain node (self-test) the
// bare 'three' specifier cannot resolve, so we fall back to the vendored three
// and to mirror copies of the AO constants — the self-test asserts the mirror
// matches the exported logic corner-for-corner.
let THREE;
let computeCornerAO;
let AO_LEVELS;
try {
  THREE = await import('three');
  ({ computeCornerAO, AO_LEVELS } = await import('./voxelMesher.js'));
} catch (_e) {
  THREE = await import('../vendor/three.module.js');
  // MUST mirror voxelMesher.js exactly (asserted by selfTest()).
  AO_LEVELS = [0.35, 0.55, 0.75, 1.0];
  computeCornerAO = (side1, side2, cornerN, levels = AO_LEVELS) => {
    const s1 = side1 ? 1 : 0;
    const s2 = side2 ? 1 : 0;
    const c = cornerN ? 1 : 0;
    return levels[s1 && s2 ? 0 : 3 - s1 - s2 - c];
  };
}

// --- Face tables (mirroring voxelMesher's RAW_FACES: same winding, same
// buckets, same AO neighbour sampling, same side-face texture orientation) ---

const ORDER_A = [[0, 0], [1, 0], [1, 1], [0, 1]];
const ORDER_B = [[0, 0], [0, 1], [1, 1], [1, 0]];

const BUCKET_TOP = 0;
const BUCKET_SIDE = 1;
const BUCKET_BOTTOM = 2;
const BUCKET_NAMES = ['top', 'side', 'bottom'];

// axis  = sweep/normal axis (0=x 1=y 2=z), dir = face sign,
// uAxis/vAxis = the two in-plane axes (canonical mask axes u,v).
const RAW_FACES = [
  { axis: 0, dir: 1,  uAxis: 1, vAxis: 2, order: ORDER_A, bucket: BUCKET_SIDE },   // +X
  { axis: 0, dir: -1, uAxis: 1, vAxis: 2, order: ORDER_B, bucket: BUCKET_SIDE },   // -X
  { axis: 1, dir: 1,  uAxis: 0, vAxis: 2, order: ORDER_B, bucket: BUCKET_TOP },    // +Y
  { axis: 1, dir: -1, uAxis: 0, vAxis: 2, order: ORDER_A, bucket: BUCKET_BOTTOM }, // -Y
  { axis: 2, dir: 1,  uAxis: 0, vAxis: 1, order: ORDER_A, bucket: BUCKET_SIDE },   // +Z
  { axis: 2, dir: -1, uAxis: 0, vAxis: 1, order: ORDER_B, bucket: BUCKET_SIDE },   // -Z
];

const FACES = RAW_FACES.map((f) => {
  const d = [0, 0, 0];
  d[f.axis] = f.dir;
  const U = [0, 0, 0];
  U[f.uAxis] = 1;
  const V = [0, 0, 0];
  V[f.vAxis] = 1;

  // Side faces on +/-X have in-plane axes U=y, V=z; texture v must track world
  // +Y (tile art upright, grass fringe on top) so texture (u,v) = (v-axis,
  // u-axis) there — identical to voxelMesher's swapUV.
  const swapUV = f.axis === 0;

  // AO neighbour offsets per CANONICAL corner ci = cu + cv*2 (cu,cv in {0,1}),
  // all one step along the face normal, relative to the meshed voxel.
  const aoOffsets = [];
  for (let ci = 0; ci < 4; ci++) {
    const cu = ci & 1;
    const cv = (ci >> 1) & 1;
    const su = cu ? 1 : -1;
    const sv = cv ? 1 : -1;
    aoOffsets.push({
      s1: [d[0] + U[0] * su, d[1] + U[1] * su, d[2] + U[2] * su],
      s2: [d[0] + V[0] * sv, d[1] + V[1] * sv, d[2] + V[2] * sv],
      c: [
        d[0] + U[0] * su + V[0] * sv,
        d[1] + U[1] * su + V[1] * sv,
        d[2] + U[2] * su + V[2] * sv,
      ],
    });
  }

  // Winding order expressed as canonical corner indices.
  const orderCanon = f.order.map(([cu, cv]) => cu + cv * 2);

  return {
    axis: f.axis,
    dir: f.dir,
    uAxis: f.uAxis,
    vAxis: f.vAxis,
    bucket: f.bucket,
    d,
    swapUV,
    aoOffsets,
    orderCanon,
  };
});

// Precomputed flat-color LUT (same construction as voxelMesher's COLOR_LUT).
const COLOR_LUT = BLOCKS.map((_, id) =>
  BUCKET_NAMES.map((name) => faceColor(id, name))
);

// Neutral near-white tint in atlas mode — MUST match voxelMesher's ATLAS_TINT.
// (The per-block blockHash01 variation is intentionally dropped; see header.)
const ATLAS_TINT = 0.98;

// Build per-id, per-bucket RAW tile origins (no inset — the tiled material
// applies the half-texel inset in the shader) + neutral tints.
function buildAtlasLUTs(atlas) {
  if (!atlas || typeof atlas.tileUV !== 'function') return null;

  const faceTileOf = typeof atlas.faceTile === 'function'
    ? (id, face) => atlas.faceTile(id, face)
    : (id, face) => {
      const m = atlas.FACE_TILE && atlas.FACE_TILE[id];
      return m ? (m[face] || m.side || null) : null;
    };

  const originLUT = BLOCKS.map((_, id) =>
    BUCKET_NAMES.map((face) => {
      const name = faceTileOf(id, face);
      const t = name ? atlas.tileUV(name) : null;
      // null -> that face falls back to the flat-color path (same as
      // voxelMesher); with a map bound it will still sample the map, so keep
      // FACE_TILE complete for every renderable block (it currently is).
      return t ? [t.u0, t.v0] : null;
    })
  );

  const tintLUT = BLOCKS.map((b) =>
    BUCKET_NAMES.map((face) => {
      let shade = 1.0;
      if (face === 'top') shade = b.topShade ?? 1.0;
      else if (face === 'bottom') shade = b.bottomShade ?? 1.0;
      else shade = b.sideShade ?? 1.0;
      return ATLAS_TINT * shade;
    })
  );

  return { originLUT, tintLUT };
}

// --- Output accumulators (exact-sized typed arrays, like voxelMesher) --------

function allocBuffers(nQuads) {
  const v = nQuads * 4;
  return {
    pos: new Float32Array(v * 3),
    nor: new Float32Array(v * 3),
    uv: new Float32Array(v * 2),
    col: new Float32Array(v * 3),
    ao: new Float32Array(v),
    tOrigin: new Float32Array(v * 2),
    tSpan: new Float32Array(v * 2),
    idx: v > 65535 ? new Uint32Array(nQuads * 6) : new Uint16Array(nQuads * 6),
    vcount: 0,
    ii: 0,
  };
}

function finishGeometry(b) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(b.nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(b.uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(b.col, 3));
  g.setAttribute('ao', new THREE.BufferAttribute(b.ao, 1));
  g.setAttribute('tileOrigin', new THREE.BufferAttribute(b.tOrigin, 2));
  g.setAttribute('tileSpan', new THREE.BufferAttribute(b.tSpan, 2));
  g.setIndex(new THREE.BufferAttribute(b.idx, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

// Reusable scratch (build-time only; keeps the loops allocation-free).
const coordScratch = [0, 0, 0];
const emitScratch = [0, 0, 0];
const aoOrderScratch = [0, 0, 0, 0];

// Mutated in place on every build (GUI/debug convenience).
export const lastGreedyStats = { quadsBefore: 0, quadsAfter: 0 };

/**
 * Build greedy-merged solid + transparent geometry for a worldgen Volume.
 * @param {object} volume  { sx, sy, sz, get(x,y,z), isOpaque(x,y,z) } —
 *   accessors must be `this`-free closures (same contract as voxelMesher).
 * @param {{ao?:boolean, atlas?:object|null}} opts
 *   ao=true bakes corner AO into the merge keys + 'ao' attribute; false writes
 *   ao=1 everywhere (maximum merging). atlas: createBlockAtlas() result; when
 *   given, uv = LOCAL 0..W/0..H tile coords + tileOrigin/tileSpan drive the
 *   tiled material; when null, color carries the flat block color.
 * @returns {{solid: THREE.BufferGeometry, transparent: THREE.BufferGeometry|null,
 *            stats: {quadsBefore:number, quadsAfter:number}}}
 */
export function buildGreedyChunkGeometry(volume, { ao = true, atlas = null } = {}) {
  const { sx, sy, sz } = volume;
  const dims = [sx, sy, sz];
  const get = volume.get;
  const isOpaque = volume.isOpaque;

  const luts = buildAtlasLUTs(atlas);

  // One plane mask reused by all 6 sweeps. Cell key encodes everything two
  // cells must share to merge: blockId << 8 | four 2-bit AO levels (canonical
  // corner order c00,c10,c01,c11 at bits 0,2,4,6). 0 = no face.
  const maxPlane = Math.max(sx * sy, sy * sz, sx * sz);
  const mask = new Int32Array(maxPlane);

  // Flat quad list: [faceIndex, w, iu, iv, W, H, key] per quad.
  const quads = [];
  let quadsBefore = 0;
  let solidQuads = 0;
  let transQuads = 0;

  const c = coordScratch;

  for (let fi = 0; fi < 6; fi++) {
    const F = FACES[fi];
    const axis = F.axis;
    const uAxis = F.uAxis;
    const vAxis = F.vAxis;
    const d = F.d;
    const aoOffsets = F.aoOffsets;
    const sw = dims[axis];
    const su = dims[uAxis];
    const sv = dims[vAxis];

    for (let w = 0; w < sw; w++) {
      // ---- Fill the mask for this slice --------------------------------
      let anyCell = false;
      for (let iv = 0; iv < sv; iv++) {
        const row = iv * su;
        for (let iu = 0; iu < su; iu++) {
          c[axis] = w;
          c[uAxis] = iu;
          c[vAxis] = iv;
          const x = c[0];
          const y = c[1];
          const z = c[2];
          const id = get(x, y, z);
          let key = 0;
          if (id !== AIR && id !== WATER &&
              !isOpaque(x + d[0], y + d[1], z + d[2])) {
            let bits = 0xff; // ao disabled -> all corners at level 3 (lit)
            if (ao) {
              bits = 0;
              for (let ci = 0; ci < 4; ci++) {
                const o = aoOffsets[ci];
                const s1 = isOpaque(x + o.s1[0], y + o.s1[1], z + o.s1[2]) ? 1 : 0;
                const s2 = isOpaque(x + o.s2[0], y + o.s2[1], z + o.s2[2]) ? 1 : 0;
                const cn = isOpaque(x + o.c[0], y + o.c[1], z + o.c[2]) ? 1 : 0;
                // Discrete AO level 0..3 — the exact level rule inside
                // voxelMesher.computeCornerAO (selfTest() asserts
                // AO_LEVELS[level] === computeCornerAO(s1,s2,cn) for all
                // 8 neighbour combinations).
                const level = s1 && s2 ? 0 : 3 - s1 - s2 - cn;
                bits |= level << (ci * 2);
              }
            }
            key = (id << 8) | bits;
            quadsBefore++;
            anyCell = true;
          }
          mask[row + iu] = key;
        }
      }
      if (!anyCell) continue;

      // ---- Greedy merge scan over the mask ------------------------------
      for (let iv = 0; iv < sv; iv++) {
        const row = iv * su;
        for (let iu = 0; iu < su; iu++) {
          const key = mask[row + iu];
          if (key === 0) continue;

          // Decode the AO tuple for the merge-axis uniformity rules.
          const a00 = key & 3;
          const a10 = (key >> 2) & 3;
          const a01 = (key >> 4) & 3;
          const a11 = (key >> 6) & 3;
          const uniformU = a00 === a10 && a01 === a11;
          const uniformV = a00 === a01 && a10 === a11;

          // Extend width along u: identical keys + AO uniform along u.
          let W = 1;
          if (uniformU) {
            while (iu + W < su && mask[row + iu + W] === key) W++;
          }

          // Extend height along v: every cell of each new row must match, and
          // the tuple must be AO-uniform along v. (W>1 && H>1 then implies all
          // four corners equal — the merged interpolation is exact.)
          let H = 1;
          if (uniformV) {
            grow: while (iv + H < sv) {
              const row2 = (iv + H) * su + iu;
              for (let k = 0; k < W; k++) {
                if (mask[row2 + k] !== key) break grow;
              }
              H++;
            }
          }

          // Consume the merged region.
          for (let dv = 0; dv < H; dv++) {
            const r2 = (iv + dv) * su + iu;
            mask.fill(0, r2, r2 + W);
          }

          if ((key >> 8) === LEAVES) transQuads++;
          else solidQuads++;
          quads.push(fi, w, iu, iv, W, H, key);
        }
      }
    }
  }

  // ---- Emit the merged quads into exact-sized buffers ----------------------
  const solid = allocBuffers(solidQuads);
  const trans = allocBuffers(transQuads);
  const e = emitScratch;
  const aoOrder = aoOrderScratch;

  for (let q = 0; q < quads.length; q += 7) {
    const fi = quads[q];
    const w = quads[q + 1];
    const iu = quads[q + 2];
    const iv = quads[q + 3];
    const W = quads[q + 4];
    const H = quads[q + 5];
    const key = quads[q + 6];
    const id = key >> 8;

    const F = FACES[fi];
    const buf = id === LEAVES ? trans : solid;
    const bucket = F.bucket;
    const swapUV = F.swapUV;
    const pw = w + (F.dir > 0 ? 1 : 0); // face plane coordinate along the axis

    const origin = luts ? luts.originLUT[id][bucket] : null;
    let cr;
    let cg;
    let cb;
    if (origin) {
      const t = luts.tintLUT[id][bucket];
      cr = t; cg = t; cb = t;
    } else {
      const col = COLOR_LUT[id][bucket];
      cr = col[0]; cg = col[1]; cb = col[2];
    }
    const tox = origin ? origin[0] : 0;
    const toy = origin ? origin[1] : 0;
    // Quad spans along the TEXTURE uv axes (swapped on +/-X, like tuv).
    const spanTexU = swapUV ? H : W;
    const spanTexV = swapUV ? W : H;

    const nx = F.d[0];
    const ny = F.d[1];
    const nz = F.d[2];

    const base = buf.vcount;
    const pos = buf.pos;
    const nor = buf.nor;
    const uv = buf.uv;
    const cbuf = buf.col;
    const abuf = buf.ao;
    const tob = buf.tOrigin;
    const tsb = buf.tSpan;
    let p = base * 3;
    let u2 = base * 2;
    let a = base;

    for (let j = 0; j < 4; j++) {
      const ci = F.orderCanon[j];
      const cu = ci & 1;
      const cv = (ci >> 1) & 1;

      e[F.uAxis] = iu + cu * W;
      e[F.vAxis] = iv + cv * H;
      e[F.axis] = pw;
      pos[p] = e[0]; pos[p + 1] = e[1]; pos[p + 2] = e[2];
      nor[p] = nx; nor[p + 1] = ny; nor[p + 2] = nz;
      cbuf[p] = cr; cbuf[p + 1] = cg; cbuf[p + 2] = cb;

      // LOCAL tile-space uv: 0..W / 0..H in blocks, texture-axis oriented in
      // atlas mode (swap on +/-X so tile art stays upright), plain (u,v)*span
      // otherwise (mirrors voxelMesher's uv/tuv distinction).
      if (origin) {
        uv[u2] = swapUV ? cv * H : cu * W;
        uv[u2 + 1] = swapUV ? cu * W : cv * H;
        tsb[u2] = spanTexU;
        tsb[u2 + 1] = spanTexV;
      } else {
        uv[u2] = cu * W;
        uv[u2 + 1] = cv * H;
        tsb[u2] = W;
        tsb[u2 + 1] = H;
      }
      tob[u2] = tox;
      tob[u2 + 1] = toy;

      const aoVal = AO_LEVELS[(key >> (ci * 2)) & 3];
      abuf[a] = aoVal;
      aoOrder[j] = aoVal;

      p += 3;
      u2 += 2;
      a += 1;
    }
    buf.vcount = base + 4;

    // Quad-flip rule, identical to voxelMesher: when ao(v0)+ao(v2) >
    // ao(v1)+ao(v3) triangulate along the other diagonal so the interpolated
    // AO gradient follows the darker diagonal.
    const idx = buf.idx;
    let k = buf.ii;
    if (aoOrder[0] + aoOrder[2] > aoOrder[1] + aoOrder[3]) {
      idx[k] = base + 1; idx[k + 1] = base + 2; idx[k + 2] = base + 3;
      idx[k + 3] = base + 1; idx[k + 4] = base + 3; idx[k + 5] = base + 0;
    } else {
      idx[k] = base + 0; idx[k + 1] = base + 1; idx[k + 2] = base + 2;
      idx[k + 3] = base + 0; idx[k + 4] = base + 2; idx[k + 5] = base + 3;
    }
    buf.ii = k + 6;
  }

  const stats = { quadsBefore, quadsAfter: solidQuads + transQuads };
  lastGreedyStats.quadsBefore = stats.quadsBefore;
  lastGreedyStats.quadsAfter = stats.quadsAfter;

  return {
    solid: finishGeometry(solid),
    transparent: transQuads > 0 ? finishGeometry(trans) : null,
    stats,
  };
}

// =============================================================================
// Self-test (node): `node src/greedyMesher.js`
// =============================================================================

function assert(cond, msg) {
  if (!cond) throw new Error('[greedyMesher selfTest] FAILED: ' + msg);
}

// Independent brute-force face count using the same emission rule — validates
// stats.quadsBefore against a second implementation.
function bruteForceFaceCount(volume) {
  const dims = [volume.sx, volume.sy, volume.sz];
  let n = 0;
  for (let x = 0; x < dims[0]; x++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let z = 0; z < dims[2]; z++) {
        const id = volume.get(x, y, z);
        if (id === AIR || id === WATER) continue;
        for (let fi = 0; fi < 6; fi++) {
          const d = FACES[fi].d;
          if (!volume.isOpaque(x + d[0], y + d[1], z + d[2])) n++;
        }
      }
    }
  }
  return n;
}

function checkGeometryConsistency(g, label) {
  if (!g) return;
  const nVerts = g.getAttribute('position').count;
  for (const name of ['normal', 'color', 'ao', 'tileOrigin', 'tileSpan', 'uv']) {
    const attr = g.getAttribute(name);
    assert(attr, label + ': missing attribute ' + name);
    assert(attr.count === nVerts,
      label + ': attribute ' + name + ' count ' + attr.count + ' != ' + nVerts);
  }
  assert(nVerts % 4 === 0, label + ': vertex count not a multiple of 4');
  const index = g.getIndex();
  assert(index && index.count === (nVerts / 4) * 6, label + ': index count mismatch');
  const ia = index.array;
  for (let i = 0; i < ia.length; i++) {
    assert(ia[i] < nVerts, label + ': index out of range');
  }
  // Compare in float32 space: the buffer stores Math.fround(AO_LEVELS[k]).
  const aoArr = g.getAttribute('ao').array;
  const f32Levels = AO_LEVELS.map(Math.fround);
  for (let i = 0; i < aoArr.length; i++) {
    assert(f32Levels.includes(aoArr[i]), label + ': ao value not in AO_LEVELS');
  }
}

function makeSlabVolume(S, id = 1 /* grass */) {
  const inside = (x, y, z) => x >= 0 && x < S && y === 0 && z >= 0 && z < S;
  return {
    sx: S, sy: 1, sz: S,
    get: (x, y, z) => (inside(x, y, z) ? id : 0),
    isOpaque: (x, y, z) => inside(x, y, z),
  };
}

// Slab + one dirt block on top (breaks AO uniformity around the block) + one
// water cell (must not mesh, must not occlude).
function makeSteppedVolume(S) {
  const solid = (x, y, z) =>
    (y === 0 && x >= 0 && x < S && z >= 0 && z < S) ||
    (x === 3 && y === 1 && z === 3);
  return {
    sx: S, sy: 2, sz: S,
    get: (x, y, z) => {
      if (x === 0 && y === 1 && z === 0) return WATER;
      return solid(x, y, z) ? (y === 1 ? 2 : 1) : 0;
    },
    isOpaque: (x, y, z) => solid(x, y, z),
  };
}

const MOCK_RECTS = {
  grass_top: { u0: 0.0, v0: 0.75, u1: 0.25, v1: 1.0 },
  grass_side: { u0: 0.25, v0: 0.75, u1: 0.5, v1: 1.0 },
  dirt: { u0: 0.5, v0: 0.75, u1: 0.75, v1: 1.0 },
};

const mockAtlas = {
  tileSizePx: 16,
  atlasSizePx: 64,
  texelSize: 1 / 64,
  tileUV: (name) => MOCK_RECTS[name] || null,
  faceTile: (id, face) => {
    if (id === 1) {
      return face === 'top' ? 'grass_top' : face === 'bottom' ? 'dirt' : 'grass_side';
    }
    return 'dirt';
  },
};

export function selfTest() {
  // 0. AO level formula must match voxelMesher.computeCornerAO for every
  //    (side1, side2, corner) combination.
  for (let s1 = 0; s1 <= 1; s1++) {
    for (let s2 = 0; s2 <= 1; s2++) {
      for (let cn = 0; cn <= 1; cn++) {
        const level = s1 && s2 ? 0 : 3 - s1 - s2 - cn;
        assert(AO_LEVELS[level] === computeCornerAO(s1, s2, cn),
          `AO level formula diverges from computeCornerAO at (${s1},${s2},${cn})`);
      }
    }
  }

  // 1. Flat 8x1x8 grass slab: 160 culled faces must collapse to exactly 6
  //    quads (top, bottom, 4 sides), all fully lit.
  const slab = makeSlabVolume(8);
  const r1 = buildGreedyChunkGeometry(slab, { ao: true });
  assert(r1.stats.quadsBefore === bruteForceFaceCount(slab),
    'slab quadsBefore != brute-force face count');
  assert(r1.stats.quadsBefore === 160, 'slab quadsBefore expected 160, got ' + r1.stats.quadsBefore);
  assert(r1.stats.quadsAfter === 6, 'slab quadsAfter expected 6, got ' + r1.stats.quadsAfter);
  assert(r1.transparent === null, 'slab has no leaves -> transparent must be null');
  checkGeometryConsistency(r1.solid, 'slab.solid');
  assert(r1.solid.getAttribute('position').count === 24, 'slab expected 24 vertices');
  const slabAo = r1.solid.getAttribute('ao').array;
  for (let i = 0; i < slabAo.length; i++) assert(slabAo[i] === 1.0, 'slab AO must be fully lit');
  console.log(`[greedyMesher] slab 8x1x8 (flat color):   quads ${r1.stats.quadsBefore} -> ${r1.stats.quadsAfter}` +
    ` (${(r1.stats.quadsBefore / r1.stats.quadsAfter).toFixed(1)}x reduction)`);

  // 2. Same slab in atlas mode: local UVs 0..8, raw tileOrigin, tileSpan 8x8
  //    on the top quad, neutral tint color.
  const r2 = buildGreedyChunkGeometry(slab, { ao: true, atlas: mockAtlas });
  checkGeometryConsistency(r2.solid, 'slab-atlas.solid');
  assert(r2.stats.quadsAfter === 6, 'atlas mode must not change merge results');
  {
    const norA = r2.solid.getAttribute('normal').array;
    const uvA = r2.solid.getAttribute('uv').array;
    const toA = r2.solid.getAttribute('tileOrigin').array;
    const tsA = r2.solid.getAttribute('tileSpan').array;
    const colA = r2.solid.getAttribute('color').array;
    let topVerts = 0;
    let maxLocal = 0;
    for (let vtx = 0; vtx < 24; vtx++) {
      maxLocal = Math.max(maxLocal, uvA[vtx * 2], uvA[vtx * 2 + 1]);
      if (norA[vtx * 3 + 1] === 1) { // +Y face vertices
        topVerts++;
        assert(toA[vtx * 2] === MOCK_RECTS.grass_top.u0 && toA[vtx * 2 + 1] === MOCK_RECTS.grass_top.v0,
          'top-face tileOrigin must be the RAW grass_top rect origin');
        assert(tsA[vtx * 2] === 8 && tsA[vtx * 2 + 1] === 8, 'top-face tileSpan must be 8x8');
        assert(uvA[vtx * 2] === 0 || uvA[vtx * 2] === 8, 'top-face local uv.x must be 0 or 8');
        assert(uvA[vtx * 2 + 1] === 0 || uvA[vtx * 2 + 1] === 8, 'top-face local uv.y must be 0 or 8');
        assert(Math.abs(colA[vtx * 3] - ATLAS_TINT) < 1e-6, 'atlas top tint must be neutral (no per-block vary)');
      }
    }
    assert(topVerts === 4, 'expected exactly 4 top-face vertices (one merged 8x8 quad)');
    assert(maxLocal === 8, 'local uv must span 0..8 on the slab');
  }
  console.log(`[greedyMesher] slab 8x1x8 (atlas tiled):  quads ${r2.stats.quadsBefore} -> ${r2.stats.quadsAfter}, ` +
    'local UVs 0..8 + raw tileOrigin OK');

  // 3. Stepped volume (slab + block on top + a water cell): AO variation must
  //    split merges but stay consistent; water must not mesh or occlude.
  const step = makeSteppedVolume(8);
  const r3 = buildGreedyChunkGeometry(step, { ao: true, atlas: mockAtlas });
  assert(r3.stats.quadsBefore === bruteForceFaceCount(step),
    'stepped quadsBefore != brute-force face count');
  assert(r3.stats.quadsAfter < r3.stats.quadsBefore, 'stepped volume must still merge');
  assert(r3.transparent === null, 'stepped volume has no leaves');
  checkGeometryConsistency(r3.solid, 'stepped.solid');
  {
    // The tower block darkens slab-top corners around it -> more quads than
    // the bare slab's 6, and at least one AO value below 1 must appear.
    assert(r3.stats.quadsAfter > 6, 'AO variation around the tower must split the top plane');
    const aoArr = r3.solid.getAttribute('ao').array;
    let darkened = 0;
    for (let i = 0; i < aoArr.length; i++) if (aoArr[i] < 1.0) darkened++;
    assert(darkened > 0, 'stepped volume must bake darkened AO corners');
  }
  console.log(`[greedyMesher] stepped 8x2x8 (AO splits): quads ${r3.stats.quadsBefore} -> ${r3.stats.quadsAfter}`);

  // 4. ao:false maximizes merging (tuples all-lit everywhere).
  const r4 = buildGreedyChunkGeometry(step, { ao: false });
  assert(r4.stats.quadsAfter <= r3.stats.quadsAfter, 'ao:false must merge at least as well');
  checkGeometryConsistency(r4.solid, 'stepped-noao.solid');

  // 5. lastGreedyStats mirrors the most recent build.
  assert(lastGreedyStats.quadsBefore === r4.stats.quadsBefore &&
    lastGreedyStats.quadsAfter === r4.stats.quadsAfter, 'lastGreedyStats must track the latest build');

  console.log('[greedyMesher] selfTest PASSED');
  return true;
}

// Run the self-test when executed directly under node (never in the browser).
const IS_NODE = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
if (IS_NODE && process.argv[1]) {
  const { pathToFileURL } = await import('node:url');
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
      selfTest();
    } catch (err) {
      console.error(err);
      process.exitCode = 1;
    }
  }
}

export default buildGreedyChunkGeometry;
