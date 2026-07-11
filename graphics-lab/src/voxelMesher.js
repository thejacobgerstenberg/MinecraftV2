// graphics-lab/src/voxelMesher.js
//
// Face-culled voxel mesher with classic per-vertex ambient occlusion.
//
// buildChunkGeometry(volume, { ao = true }) -> { solid, transparent }
//   Produces two THREE.BufferGeometry objects:
//     - solid       : all opaque blocks (grass/dirt/stone/sand/wood/plank/
//                     glowstone/snow) merged into one geometry.
//     - transparent : the transparent blocks (leaves) merged into one geometry,
//                     or null when the volume contains none.
//   Water is NEVER meshed here (it is its own module), but faces of solid
//   blocks that border water ARE emitted (water does not occlude).
//
// Each geometry carries: position, normal, uv (0..1 per face), color (Float32
// rgb = BLOCKS face color * face-direction shade), and a custom float attribute
// 'ao' in [0,1] (1 = fully lit, lower = occluded) consumed by voxelMaterial.js.
//
// AO uses the classic "0..3 corner AO" from the 0fps voxel-AO article: for each
// of a face's 4 corners we look, in the voxel plane one step along the face
// normal, at the two edge-adjacent neighbours (side1, side2) and the diagonal
// corner neighbour, then:
//     vertexAO = (side1 && side2) ? 0 : (3 - side1 - side2 - corner)
// and map {0,1,2,3} -> AO_LEVELS. The standard quad-flip is applied so the
// triangulation follows the darker diagonal and avoids AO seam artifacts.

import * as THREE from 'three';
import { AIR, WATER, LEAVES, BLOCKS, faceColor } from './blocks.js';

// AO value per occlusion level (index === classic vertexAO 0..3).
// 0 = most occluded (inner crevice), 3 = fully lit. Tunable.
export const AO_LEVELS = [0.35, 0.55, 0.75, 1.0];

// Classic 0..3 corner AO, mapped to an AO value. `side1`, `side2`, `cornerN`
// are truthy when the corresponding neighbour voxel occludes light. Exported so
// the AO math is unit-testable independent of geometry.
export function computeCornerAO(side1, side2, cornerN, levels = AO_LEVELS) {
  const s1 = side1 ? 1 : 0;
  const s2 = side2 ? 1 : 0;
  const c = cornerN ? 1 : 0;
  // If both edge neighbours are present the corner is fully in shadow (level 0)
  // regardless of the diagonal — this is what removes the classic "light leak".
  const level = s1 && s2 ? 0 : 3 - s1 - s2 - c;
  return levels[level];
}

// --- Precomputed per-face geometry + AO sampling tables ----------------------
//
// Quad corners are listed in an order that yields outward-facing (CCW) winding
// for each face. Order A / B were derived by checking the triangle normal of
// each candidate ordering against the face normal.
const ORDER_A = [[0, 0], [1, 0], [1, 1], [0, 1]];
const ORDER_B = [[0, 0], [0, 1], [1, 1], [1, 0]];

// Shade buckets, matching faceColor()'s 'top'|'side'|'bottom' argument.
const BUCKET_TOP = 0;
const BUCKET_SIDE = 1;
const BUCKET_BOTTOM = 2;
const BUCKET_NAMES = ['top', 'side', 'bottom'];

// d = face normal (also the step into the neighbour plane used for AO),
// U/V = the two in-plane tangent axes, o = the (u=0,v=0) cube corner,
// order = winding-correct corner order, bucket = shade bucket for the color LUT.
const RAW_FACES = [
  { d: [1, 0, 0],  U: [0, 1, 0], V: [0, 0, 1], o: [1, 0, 0], order: ORDER_A, bucket: BUCKET_SIDE },   // +X
  { d: [-1, 0, 0], U: [0, 1, 0], V: [0, 0, 1], o: [0, 0, 0], order: ORDER_B, bucket: BUCKET_SIDE },   // -X
  { d: [0, 1, 0],  U: [1, 0, 0], V: [0, 0, 1], o: [0, 1, 0], order: ORDER_B, bucket: BUCKET_TOP },    // +Y
  { d: [0, -1, 0], U: [1, 0, 0], V: [0, 0, 1], o: [0, 0, 0], order: ORDER_A, bucket: BUCKET_BOTTOM }, // -Y
  { d: [0, 0, 1],  U: [1, 0, 0], V: [0, 1, 0], o: [0, 0, 1], order: ORDER_A, bucket: BUCKET_SIDE },   // +Z
  { d: [0, 0, -1], U: [1, 0, 0], V: [0, 1, 0], o: [0, 0, 0], order: ORDER_B, bucket: BUCKET_SIDE },   // -Z
];

// Expand each face into 4 corner records with baked position offsets, uv, and
// the three AO neighbour offsets (relative to the voxel being meshed).
const FACES = RAW_FACES.map((f) => {
  const corners = f.order.map(([cu, cv]) => {
    const su = cu ? 1 : -1;
    const sv = cv ? 1 : -1;
    return {
      // vertex position offset from the voxel's minimum corner
      pos: [
        f.o[0] + f.U[0] * cu + f.V[0] * cv,
        f.o[1] + f.U[1] * cu + f.V[1] * cv,
        f.o[2] + f.U[2] * cu + f.V[2] * cv,
      ],
      uv: [cu, cv],
      // AO neighbour offsets, all in the plane one step along the normal
      side1: [f.d[0] + f.U[0] * su, f.d[1] + f.U[1] * su, f.d[2] + f.U[2] * su],
      side2: [f.d[0] + f.V[0] * sv, f.d[1] + f.V[1] * sv, f.d[2] + f.V[2] * sv],
      corner: [
        f.d[0] + f.U[0] * su + f.V[0] * sv,
        f.d[1] + f.U[1] * su + f.V[1] * sv,
        f.d[2] + f.U[2] * su + f.V[2] * sv,
      ],
    };
  });
  return { d: f.d, n: f.d, bucket: f.bucket, corners };
});

// Precomputed color lookup: COLOR_LUT[id][bucket] = [r,g,b] already multiplied
// by the face-direction shade. Built once so the mesh loop never allocates a
// color per face.
const COLOR_LUT = BLOCKS.map((_, id) =>
  BUCKET_NAMES.map((name) => faceColor(id, name))
);

// --- Output accumulators (exact-sized typed arrays, filled in one pass) -------

function allocBuffers(nFaces) {
  const v = nFaces * 4; // vertices
  return {
    pos: new Float32Array(v * 3),
    nor: new Float32Array(v * 3),
    uv: new Float32Array(v * 2),
    col: new Float32Array(v * 3),
    ao: new Float32Array(v),
    // Index type follows the vertex count so we never overflow Uint16.
    idx: v > 65535 ? new Uint32Array(nFaces * 6) : new Uint16Array(nFaces * 6),
    vcount: 0, // vertices written so far
    ii: 0,     // index-array write cursor
  };
}

function finishGeometry(b) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(b.nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(b.uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(b.col, 3));
  // Custom per-vertex AO, read by voxelMaterial.js as `attribute float ao;`.
  g.setAttribute('ao', new THREE.BufferAttribute(b.ao, 1));
  g.setIndex(new THREE.BufferAttribute(b.idx, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

// Reusable per-face scratch for the four corner AO values (no per-face alloc).
const aoScratch = [0, 0, 0, 0];

/**
 * Build face-culled solid + transparent geometry for a worldgen Volume.
 * @param {object} volume  as produced by generateDemoChunk()
 * @param {{ao?:boolean}} opts  ao=true bakes corner AO; false writes ao=1 (lit)
 * @returns {{solid: THREE.BufferGeometry, transparent: THREE.BufferGeometry|null}}
 */
export function buildChunkGeometry(volume, { ao = true } = {}) {
  const { sx, sy, sz } = volume;
  // Local refs: these are plain closures in worldgen (no `this`), safe to hoist.
  const get = volume.get;
  const isOpaque = volume.isOpaque;

  // --- Pass 1: count emitted faces so buffers can be sized exactly ----------
  let solidFaces = 0;
  let transFaces = 0;
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const id = get(x, y, z);
        if (id === AIR || id === WATER) continue; // water is its own module
        const isLeaf = id === LEAVES;
        for (let fi = 0; fi < 6; fi++) {
          const d = FACES[fi].d;
          // Emit only where the neighbour across the face is NOT opaque.
          if (isOpaque(x + d[0], y + d[1], z + d[2])) continue;
          if (isLeaf) transFaces++;
          else solidFaces++;
        }
      }
    }
  }

  const solid = allocBuffers(solidFaces);
  const trans = allocBuffers(transFaces);

  // --- Pass 2: emit geometry + AO into the pre-sized buffers -----------------
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const id = get(x, y, z);
        if (id === AIR || id === WATER) continue;

        const buf = id === LEAVES ? trans : solid;
        const lut = COLOR_LUT[id];

        for (let fi = 0; fi < 6; fi++) {
          const F = FACES[fi];
          const d = F.d;
          if (isOpaque(x + d[0], y + d[1], z + d[2])) continue;

          const cs = F.corners;

          // Per-corner AO (or fully lit when disabled).
          if (ao) {
            for (let i = 0; i < 4; i++) {
              const c = cs[i];
              const s1 = isOpaque(x + c.side1[0], y + c.side1[1], z + c.side1[2]);
              const s2 = isOpaque(x + c.side2[0], y + c.side2[1], z + c.side2[2]);
              const cn = isOpaque(x + c.corner[0], y + c.corner[1], z + c.corner[2]);
              aoScratch[i] = computeCornerAO(s1, s2, cn);
            }
          } else {
            aoScratch[0] = aoScratch[1] = aoScratch[2] = aoScratch[3] = 1.0;
          }

          const col = lut[F.bucket];
          const cr = col[0];
          const cg = col[1];
          const cb = col[2];
          const nx = F.n[0];
          const ny = F.n[1];
          const nz = F.n[2];

          const base = buf.vcount;
          const pos = buf.pos;
          const nor = buf.nor;
          const uv = buf.uv;
          const cbuf = buf.col;
          const abuf = buf.ao;
          let p = base * 3;
          let u = base * 2;
          let a = base;
          for (let i = 0; i < 4; i++) {
            const c = cs[i];
            const cp = c.pos;
            pos[p] = x + cp[0];     pos[p + 1] = y + cp[1]; pos[p + 2] = z + cp[2];
            nor[p] = nx;            nor[p + 1] = ny;        nor[p + 2] = nz;
            cbuf[p] = cr;           cbuf[p + 1] = cg;       cbuf[p + 2] = cb;
            uv[u] = c.uv[0];        uv[u + 1] = c.uv[1];
            abuf[a] = aoScratch[i];
            p += 3;
            u += 2;
            a += 1;
          }
          buf.vcount = base + 4;

          // Quad-flip: when ao(v0)+ao(v2) > ao(v1)+ao(v3), triangulate along the
          // other diagonal so the interpolated AO gradient stays smooth.
          const idx = buf.idx;
          let k = buf.ii;
          if (aoScratch[0] + aoScratch[2] > aoScratch[1] + aoScratch[3]) {
            idx[k] = base + 1; idx[k + 1] = base + 2; idx[k + 2] = base + 3;
            idx[k + 3] = base + 1; idx[k + 4] = base + 3; idx[k + 5] = base + 0;
          } else {
            idx[k] = base + 0; idx[k + 1] = base + 1; idx[k + 2] = base + 2;
            idx[k + 3] = base + 0; idx[k + 4] = base + 2; idx[k + 5] = base + 3;
          }
          buf.ii = k + 6;
        }
      }
    }
  }

  return {
    solid: finishGeometry(solid),
    transparent: transFaces > 0 ? finishGeometry(trans) : null,
  };
}

export default buildChunkGeometry;
