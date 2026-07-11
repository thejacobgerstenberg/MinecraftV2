// Voxelheim chunk streaming renderer — loads/builds/unloads chunk meshes
// around the player and keeps dirty chunks rebuilt.
//
// Materials (shared across all chunks):
//   opaque : MeshLambertMaterial({ map: atlas.texture, vertexColors: true })
//   cutout : same + alphaTest (leaves/glass) so they depth-write cleanly.
//            (Internal quality split allowed by contract; consumes the extra
//            `cutout` bucket returned by buildChunkMesh.)
//   liquid : MeshLambertMaterial({ map, vertexColors: true, transparent: true,
//            opacity, depthWrite: false, DoubleSide }) for the alpha-blended
//            `transparent` bucket (water/lava/portal).
//
// update(playerPos, renderDistance):
//   - unloads + disposes meshes beyond Chebyshev distance renderDistance+1
//   - immediately rebuilds chunks listed in world.dirtyChunks (clears the set)
//   - builds missing chunks within renderDistance, nearest first, at most
//     BUILD_BUDGET (2) new chunk meshes per call
// Before meshing a chunk its full 3x3 chunk neighborhood is ensured so border
// culling and AO always see real data (no stale faces on chunk seams).

import * as THREE from 'three';
import { CHUNK_SX, CHUNK_SZ, RENDER_DISTANCE_DEFAULT } from '../constants.js';
import { chunkKey } from './Chunk.js';
import { buildChunkMesh } from './ChunkMesher.js';

const BUILD_BUDGET = 2; // new chunk meshes per update() call

export class ChunkRenderer {
  constructor(scene, world, atlas) {
    this.scene = scene;
    this.world = world;
    this.atlas = atlas;

    this.materials = {
      opaque: new THREE.MeshLambertMaterial({ map: atlas.texture, vertexColors: true }),
      cutout: new THREE.MeshLambertMaterial({
        map: atlas.texture,
        vertexColors: true,
        alphaTest: 0.4,
      }),
      liquid: new THREE.MeshLambertMaterial({
        map: atlas.texture,
        vertexColors: true,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    };

    /** @type {Map<string, {cx:number, cz:number, meshes:THREE.Mesh[]}>} */
    this._entries = new Map();
    this._lastQueueLength = 0;
  }

  /** {chunksLoaded, queueLength} — queueLength as of the last update() call. */
  get stats() {
    return { chunksLoaded: this._entries.size, queueLength: this._lastQueueLength };
  }

  /**
   * Stream chunks around playerPos ({x,z} or THREE.Vector3, world units).
   */
  update(playerPos, renderDistance = RENDER_DISTANCE_DEFAULT) {
    const pcx = Math.floor(playerPos.x / CHUNK_SX);
    const pcz = Math.floor(playerPos.z / CHUNK_SZ);

    // 1) Unload meshes beyond renderDistance+1 (Chebyshev).
    for (const [key, entry] of this._entries) {
      const d = Math.max(Math.abs(entry.cx - pcx), Math.abs(entry.cz - pcz));
      if (d > renderDistance + 1) this._unload(key);
    }

    // 2) Rebuild dirty chunks that currently have meshes (edits show up the
    //    same frame; not counted against the build budget). Chunks without a
    //    mesh yet get current data when first built, so their key can drop.
    if (this.world.dirtyChunks.size > 0) {
      for (const key of this.world.dirtyChunks) {
        const entry = this._entries.get(key);
        if (entry) this.rebuild(entry.cx, entry.cz);
      }
      this.world.dirtyChunks.clear();
    }

    // 3) Build missing chunks within renderDistance, nearest first, budgeted.
    const pending = [];
    for (let dz = -renderDistance; dz <= renderDistance; dz++) {
      for (let dx = -renderDistance; dx <= renderDistance; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        if (!this._entries.has(chunkKey(cx, cz))) pending.push([cx, cz, dx * dx + dz * dz]);
      }
    }
    pending.sort((a, b) => a[2] - b[2]);
    const n = Math.min(BUILD_BUDGET, pending.length);
    for (let i = 0; i < n; i++) this._build(pending[i][0], pending[i][1]);
    this._lastQueueLength = pending.length - n;
  }

  /** Dispose and rebuild the mesh set for one chunk. */
  rebuild(cx, cz) {
    this._unload(chunkKey(cx, cz));
    this._build(cx, cz);
  }

  /** Remove all chunk meshes and dispose geometries + shared materials. */
  dispose() {
    for (const key of [...this._entries.keys()]) this._unload(key);
    for (const m of Object.values(this.materials)) m.dispose();
    this._lastQueueLength = 0;
  }

  // ---- internals ------------------------------------------------------------

  _build(cx, cz) {
    // Ensure the 3x3 neighborhood exists so culling/AO see real blocks.
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) this.world.ensureChunk(cx + dx, cz + dz);
    }
    const built = buildChunkMesh(this.world, cx, cz, this.atlas);
    const meshes = [];
    const add = (geom, material, renderOrder) => {
      if (!geom) return;
      const mesh = new THREE.Mesh(geom, material);
      mesh.frustumCulled = true;
      mesh.renderOrder = renderOrder;
      mesh.matrixAutoUpdate = false; // positions are baked in world space
      this.scene.add(mesh);
      meshes.push(mesh);
    };
    add(built.opaque, this.materials.opaque, 0);
    add(built.cutout, this.materials.cutout, 1);
    add(built.transparent, this.materials.liquid, 10);
    this._entries.set(chunkKey(cx, cz), { cx, cz, meshes });
  }

  _unload(key) {
    const entry = this._entries.get(key);
    if (!entry) return;
    for (const mesh of entry.meshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this._entries.delete(key);
  }
}
