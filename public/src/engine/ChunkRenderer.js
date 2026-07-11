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
// With fastLighting (constructor opt or setFastLighting) the same three
// buckets use UNLIT MeshBasicMaterial instead — baked vertex AO/face shade
// plus a setLightLevel(0..1) day/night tint replace scene lighting. Used by
// AutoQuality on software rasterizers (SwiftShader etc).
//
// update(playerPos, renderDistance, eyePos):
//   - unloads + disposes meshes beyond Chebyshev distance renderDistance+1
//   - immediately rebuilds chunks listed in world.dirtyChunks (clears the set)
//   - builds missing chunks within renderDistance, nearest first, at most
//     BUILD_BUDGET (2) new chunk meshes per call
//   - applies exact culling: chunks entirely beyond the fog wall are hidden,
//     and (fast mode) provably backfacing face segments are skipped via
//     drawRange — see DirectionalCulling.js
// Before meshing a chunk its full 3x3 chunk neighborhood is ensured so border
// culling and AO always see real data (no stale faces on chunk seams).

import * as THREE from 'three';
import { CHUNK_SX, CHUNK_SZ, RENDER_DISTANCE_DEFAULT } from '../constants.js';
import { chunkKey } from './Chunk.js';
import { buildChunkMesh } from './ChunkMesher.js';
import {
  buildDirectionalIndexVariants,
  selectDirectionalRange,
} from './DirectionalCulling.js';

const BUILD_BUDGET = 2; // new chunk meshes per update() call
// Pad past the fog wall before hiding a fully-fogged chunk (see _applyCulling).
const FOG_HIDE_PAD = 4;

export class ChunkRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./World.js').World} world
   * @param {{texture: THREE.Texture}} atlas
   * @param {{fastLighting?: boolean}} [opts] — fastLighting uses UNLIT
   *   materials (MeshBasicMaterial): the mesher's baked AO/face shading plus
   *   a scalar day/night tint (setLightLevel) stand in for scene lights.
   *   Dramatically cheaper on software rasterizers (no per-fragment lights).
   */
  constructor(scene, world, atlas, opts = {}) {
    this.scene = scene;
    this.world = world;
    this.atlas = atlas;

    this._fastLighting = !!opts.fastLighting;
    this._lightLevel = 1;
    this.materials = this._makeMaterials(this._fastLighting);

    /** @type {Map<string, {cx:number, cz:number, meshes:THREE.Mesh[]}>} */
    this._entries = new Map();
    this._lastQueueLength = 0;

    // Directional face culling + fog-distance chunk hiding (both are exact:
    // they only skip geometry the GPU would discard or fog fully hides).
    // Index variants cost ~4x index memory, so they are built only in fast
    // mode, where the vertex-work savings matter (software rasterizers).
    this.directionalCulling = opts.directionalCulling ?? this._fastLighting;
  }

  get fastLighting() {
    return this._fastLighting;
  }

  /**
   * Swap between lit (Lambert) and unlit-fast (Basic) chunk materials.
   * Existing chunk meshes are re-pointed in place — no re-mesh needed.
   */
  setFastLighting(enabled) {
    enabled = !!enabled;
    if (enabled === this._fastLighting) return;
    const old = this.materials;
    this._fastLighting = enabled;
    this.materials = this._makeMaterials(enabled);
    for (const entry of this._entries.values()) {
      for (const mesh of entry.meshes) {
        mesh.material = this.materials[mesh.userData.bucket] || this.materials.opaque;
      }
    }
    for (const m of Object.values(old)) m.dispose();
  }

  /**
   * Overall light level 0..1 (day/night tint). Only visible with
   * fastLighting — lit materials get brightness from the scene lights.
   */
  setLightLevel(level) {
    this._lightLevel = Math.min(1, Math.max(0, Number(level) || 0));
    if (this._fastLighting) this._applyLightLevel();
  }

  _applyLightLevel() {
    // Keep a floor so night stays visible (matches the lit ambient floor).
    const l = this._fastLighting ? 0.15 + 0.85 * this._lightLevel : 1;
    for (const m of Object.values(this.materials)) m.color.setScalar(l);
  }

  _makeMaterials(fast) {
    const { texture } = this.atlas;
    const Mat = fast ? THREE.MeshBasicMaterial : THREE.MeshLambertMaterial;
    const materials = {
      opaque: new Mat({ map: texture, vertexColors: true }),
      cutout: new Mat({
        map: texture,
        vertexColors: true,
        alphaTest: 0.4,
      }),
      liquid: new Mat({
        map: texture,
        vertexColors: true,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    };
    if (fast) {
      const l = 0.15 + 0.85 * this._lightLevel;
      for (const m of Object.values(materials)) m.color.setScalar(l);
    }
    return materials;
  }

  /** {chunksLoaded, queueLength} — queueLength as of the last update() call. */
  get stats() {
    return { chunksLoaded: this._entries.size, queueLength: this._lastQueueLength };
  }

  /**
   * Stream chunks around playerPos ({x,z} or THREE.Vector3, world units).
   * @param {{x:number,y?:number,z:number}} playerPos player feet position
   * @param {number} [renderDistance]
   * @param {{x:number,y:number,z:number}} [eyePos] camera eye position —
   *   drives directional/fog culling (defaults to playerPos).
   */
  update(playerPos, renderDistance = RENDER_DISTANCE_DEFAULT, eyePos = playerPos) {
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

    // 4) Exact culling: hide fully-fogged chunks, skip backfacing segments.
    this._applyCulling(eyePos, renderDistance);
  }

  /** Dispose and rebuild the mesh set for one chunk. */
  rebuild(cx, cz) {
    this._unload(chunkKey(cx, cz));
    this._build(cx, cz);
  }

  /**
   * Per-frame exact culling:
   *  - a chunk whose nearest point (horizontally) sits beyond the fog wall
   *    renders as pure fog color, so it is hidden outright;
   *  - axis-aligned faces provably backfacing from the eye are skipped via
   *    the pre-built directional index variants (fast mode only).
   */
  _applyCulling(eyePos, renderDistance) {
    // Keep in sync with main.js updateFog(): far = max(48, (rd + 0.5) * 16).
    const fogFar = Math.max(48, (renderDistance + 0.5) * CHUNK_SX) + FOG_HIDE_PAD;
    const fogFarSq = fogFar * fogFar;
    for (const entry of this._entries.values()) {
      const minX = entry.cx * CHUNK_SX;
      const minZ = entry.cz * CHUNK_SZ;
      // Horizontal distance from the eye to the chunk's nearest column —
      // a lower bound on the 3D fog distance of anything in the chunk.
      const dx = Math.max(0, Math.max(minX - eyePos.x, eyePos.x - (minX + CHUNK_SX)));
      const dz = Math.max(0, Math.max(minZ - eyePos.z, eyePos.z - (minZ + CHUNK_SZ)));
      const fogged = dx * dx + dz * dz > fogFarSq;
      for (const mesh of entry.meshes) {
        mesh.visible = !fogged;
        if (fogged) continue;
        const dir = mesh.userData.dirVariants;
        if (!dir) continue;
        const sel = selectDirectionalRange(
          dir, eyePos.x, eyePos.y, eyePos.z,
          minX, minX + CHUNK_SX, minZ, minZ + CHUNK_SZ, dir.indexLength);
        const variant = dir.geometries[sel.variant];
        if (mesh.geometry !== variant) mesh.geometry = variant;
        variant.setDrawRange(sel.start, sel.count);
      }
    }
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
    const add = (geom, bucket, renderOrder) => {
      if (!geom) return;
      const mesh = new THREE.Mesh(geom, this.materials[bucket]);
      mesh.frustumCulled = true;
      mesh.renderOrder = renderOrder;
      mesh.matrixAutoUpdate = false; // positions are baked in world space
      mesh.userData.bucket = bucket; // so setFastLighting can re-point it
      // Directional backface segments (never for the double-sided liquid
      // bucket — its faces are visible from both sides).
      if (this.directionalCulling && bucket !== 'liquid') {
        mesh.userData.dirVariants = this._makeDirVariants(geom);
        mesh.geometry = mesh.userData.dirVariants.geometries[0];
      }
      this.scene.add(mesh);
      meshes.push(mesh);
    };
    add(built.opaque, 'opaque', 0);
    add(built.cutout, 'cutout', 1);
    add(built.transparent, 'liquid', 10);
    this._entries.set(chunkKey(cx, cz), { cx, cz, meshes });
  }

  // Build the 4 quadrant-ordered index variants for a chunk geometry. The
  // variants share every vertex attribute (uploaded once); only the index
  // buffers differ. Variant 0 reuses the source geometry object.
  //
  // Attribute formats stay exactly as the mesher produced them (Float32
  // attributes, Uint32 index): measured on SwiftShader, "compressed"
  // formats (Uint16 index, Uint8-normalized colors, half-float
  // positions/uvs) all rendered SLOWER — its fast vertex paths want plain
  // float/uint32 data, and conversions in the fetch stage dominate any
  // bandwidth saved.
  _makeDirVariants(geom) {
    const dir = buildDirectionalIndexVariants(
      geom.index.array,
      geom.getAttribute('position').array,
      geom.getAttribute('normal').array,
    );
    dir.indexLength = geom.index.count;
    dir.geometries = dir.variants.map((v, i) => {
      let g;
      if (i === 0) {
        g = geom;
      } else {
        g = new THREE.BufferGeometry();
        for (const [name, attr] of Object.entries(geom.attributes)) {
          g.setAttribute(name, attr);
        }
        g.boundingSphere = geom.boundingSphere;
      }
      g.setIndex(new THREE.BufferAttribute(v.index, 1));
      return g;
    });
    return dir;
  }

  _unload(key) {
    const entry = this._entries.get(key);
    if (!entry) return;
    for (const mesh of entry.meshes) {
      this.scene.remove(mesh);
      const dir = mesh.userData.dirVariants;
      if (dir) for (const g of dir.geometries) g.dispose();
      else mesh.geometry.dispose();
    }
    this._entries.delete(key);
  }
}
