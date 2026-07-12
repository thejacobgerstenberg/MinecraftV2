// Voxelheim chunk mesher — face-culling mesher with baked lighting.
//
// buildChunkMesh(world, cx, cz, atlas) -> { opaque, transparent, cutout }
//   opaque      : THREE.BufferGeometry | null — fully opaque blocks
//   transparent : THREE.BufferGeometry | null — alpha-BLENDED blocks
//                 (non-solid transparents: water, lava, portal)
//   cutout      : THREE.BufferGeometry | null — EXTRA bucket (documented
//                 deviation, allowed by contract "extra keys"): solid
//                 transparent blocks (leaves, glass) meant for an
//                 alphaTest material so they depth-write cleanly.
//                 Consumers that only know {opaque, transparent} still work;
//                 ChunkRenderer consumes all three.
//
// Rules:
//  - A face is emitted only when the neighbor block is air or transparent.
//  - No face between two blocks of the SAME transparent id (water-water,
//    glass-glass, leaves-leaves).
//  - Per-face tile via tileForFace(def, face) and atlas.tileUV(tileName).
//  - Lighting is baked into a per-vertex `color` attribute:
//      face shade (top 1.0, north/south ±z 0.82, east/west ±x 0.74,
//      bottom 0.6) x per-vertex ambient occlusion using the classic
//      side1/side2/corner rule (occlusion 0..3 -> 1.0/0.85/0.7/0.55).
//    The quad diagonal is flipped based on AO to avoid anisotropy.
//  - Emissive blocks (glowstone, lava, portal) get full-bright (1,1,1)
//    vertex color, ignoring AO and face shade.
//  - Liquid blocks with air directly above are lowered to 0.9 blocks tall
//    (top face and the top edges of side faces) for a water-surface look.
//  - Geometry is indexed, attributes: position/normal/uv/color. Positions
//    are in WORLD space (offset by cx*16, cz*16).

import * as THREE from 'three';
import { CHUNK_SX, CHUNK_SZ, CHUNK_SY, blockIndex } from '../constants.js';
import { getBlockDef, tileForFace } from '../blocks/blocks.js';

const AO_BRIGHTNESS = [1.0, 0.85, 0.7, 0.55];

// Face table. `corners` are cube-corner offsets ordered [bottom-left,
// bottom-right, top-right, top-left] as seen from OUTSIDE the face, matching
// the atlas UV convention (u0,v0)=BL .. (u1,v1)=TR. Winding is CCW from
// outside so the face normal points along `dir`.
const FACES = [
  { dir: [0, 1, 0], face: 'top', shade: 1.0, corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { dir: [0, -1, 0], face: 'bottom', shade: 0.6, corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { dir: [1, 0, 0], face: 'side', shade: 0.74, corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { dir: [-1, 0, 0], face: 'side', shade: 0.74, corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { dir: [0, 0, 1], face: 'side', shade: 0.82, corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { dir: [0, 0, -1], face: 'side', shade: 0.82, corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];

// Precompute, per face and per corner, the two tangent-axis offsets used by
// the AO rule. For corner c the tangent sign on a non-normal axis a is +1 if
// c[a] === 1 else -1.
for (const f of FACES) {
  const nAxis = f.dir[0] !== 0 ? 0 : f.dir[1] !== 0 ? 1 : 2;
  const tAxes = [0, 1, 2].filter((a) => a !== nAxis);
  f.aoDirs = f.corners.map((c) => {
    const s1 = [0, 0, 0];
    const s2 = [0, 0, 0];
    s1[tAxes[0]] = c[tAxes[0]] === 1 ? 1 : -1;
    s2[tAxes[1]] = c[tAxes[1]] === 1 ? 1 : -1;
    return [s1, s2];
  });
}

function makeBucket() {
  return { positions: [], normals: [], uvs: [], colors: [], indices: [], vertCount: 0 };
}

function bucketToGeometry(b) {
  if (b.vertCount === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.colors, 3));
  g.setIndex(new THREE.Uint32BufferAttribute(b.indices, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * Build render geometry for the chunk at (cx,cz).
 * @param {import('./World.js').World} world
 * @param {number} cx chunk x
 * @param {number} cz chunk z
 * @param {{texture:any, tileUV:(name:string)=>{u0:number,v0:number,u1:number,v1:number}}} atlas
 * @returns {{opaque: THREE.BufferGeometry|null, transparent: THREE.BufferGeometry|null, cutout: THREE.BufferGeometry|null}}
 */
export function buildChunkMesh(world, cx, cz, atlas) {
  const chunk = world.ensureChunk(cx, cz);
  const data = chunk.data;
  const ox = cx * CHUNK_SX;
  const oz = cz * CHUNK_SZ;

  // Block id at LOCAL coords, spilling into the world for out-of-chunk reads.
  const sample = (lx, y, lz) => {
    if (y < 0) return 17; // bedrock below the world -> culls bottom faces
    if (y >= CHUNK_SY) return 0;
    if (lx >= 0 && lx < CHUNK_SX && lz >= 0 && lz < CHUNK_SZ) {
      return data[blockIndex(lx, y, lz)];
    }
    return world.getBlock(ox + lx, y, oz + lz);
  };

  // True if the block id occludes light for the AO rule (solid + opaque).
  const occludes = (id) => {
    if (id === 0) return false;
    const d = getBlockDef(id);
    return d.solid && !d.transparent;
  };

  const opaque = makeBucket();
  const transparent = makeBucket();
  const cutout = makeBucket();
  const uvCache = new Map(); // tileName -> uv rect (atlas.tileUV may be costly)
  const tileUV = (name) => {
    let uv = uvCache.get(name);
    if (!uv) { uv = atlas.tileUV(name); uvCache.set(name, uv); }
    return uv;
  };

  for (let y = 0; y < CHUNK_SY; y++) {
    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let lx = 0; lx < CHUNK_SX; lx++) {
        const id = data[blockIndex(lx, y, lz)];
        if (id === 0) continue;
        const def = getBlockDef(id);
        const isEmissive = def.emissive > 0;
        let bucket;
        if (!def.transparent) bucket = opaque;
        else if (def.solid) bucket = cutout; // leaves, glass
        else bucket = transparent; // water, lava, portal

        // Liquid with air above renders 0.9 blocks tall (lowered surface).
        const lowered = def.liquid && sample(lx, y + 1, lz) === 0;

        for (const f of FACES) {
          const nid = sample(lx + f.dir[0], y + f.dir[1], lz + f.dir[2]);
          const ndef = getBlockDef(nid);
          // Emit only against air/transparent neighbors...
          if (!ndef.transparent) continue;
          // ...but never between two blocks of the same transparent id.
          if (def.transparent && nid === id) continue;

          const uv = tileUV(tileForFace(def, f.face));
          const base = bucket.vertCount;

          // Per-corner brightness (face shade x AO), or full-bright.
          const bright = [1, 1, 1, 1];
          if (!isEmissive) {
            for (let i = 0; i < 4; i++) {
              const [s1d, s2d] = f.aoDirs[i];
              const bx = lx + f.dir[0];
              const by = y + f.dir[1];
              const bz = lz + f.dir[2];
              const side1 = occludes(sample(bx + s1d[0], by + s1d[1], bz + s1d[2]));
              const side2 = occludes(sample(bx + s2d[0], by + s2d[1], bz + s2d[2]));
              const corner = occludes(sample(bx + s1d[0] + s2d[0], by + s1d[1] + s2d[1], bz + s1d[2] + s2d[2]));
              const ao = side1 && side2 ? 3 : (side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0);
              bright[i] = f.shade * AO_BRIGHTNESS[ao];
            }
          }

          const uvQuad = [[uv.u0, uv.v0], [uv.u1, uv.v0], [uv.u1, uv.v1], [uv.u0, uv.v1]];
          for (let i = 0; i < 4; i++) {
            const c = f.corners[i];
            const cy = c[1] === 1 && lowered ? 0.9 : c[1];
            bucket.positions.push(ox + lx + c[0], y + cy, oz + lz + c[2]);
            bucket.normals.push(f.dir[0], f.dir[1], f.dir[2]);
            bucket.uvs.push(uvQuad[i][0], uvQuad[i][1]);
            bucket.colors.push(bright[i], bright[i], bright[i]);
          }

          // Flip the quad diagonal so interpolation follows the AO gradient.
          if (bright[0] + bright[2] < bright[1] + bright[3]) {
            bucket.indices.push(base + 1, base + 2, base + 3, base + 1, base + 3, base + 0);
          } else {
            bucket.indices.push(base + 0, base + 1, base + 2, base + 0, base + 2, base + 3);
          }
          bucket.vertCount += 4;
        }
      }
    }
  }

  return {
    opaque: bucketToGeometry(opaque),
    transparent: bucketToGeometry(transparent),
    cutout: bucketToGeometry(cutout),
  };
}
