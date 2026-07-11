// graphics-lab/src/chunkManager.js
//
// ChunkManager — splits a large voxel world into per-chunk meshes so THREE's
// built-in per-mesh frustum culling applies, with distance-based LOD swapping
// and an optional render-distance cutoff.
//
//   new ChunkManager(scene, {
//     chunkSize = 16,
//     mesher = buildChunkGeometry,   // (volume, opts) -> { solid, transparent } |
//                                    //   a single BufferGeometry. Works with
//                                    //   buildChunkGeometry AND buildGreedyChunkGeometry.
//     material,                      // solid material (e.g. createVoxelMaterial())
//     transparentMaterial,           // leaves material (falls back to `material`)
//     lod = [ { dist: 0, ao: true }, { dist: 96, ao: false } ],
//                                    // ascending by dist; everything except `dist`
//                                    //   is passed to the mesher as its opts
//     mesherOpts = {},               // shared opts merged into EVERY lod level
//                                    //   (e.g. { atlas } from createBlockAtlas())
//     maxDistance = Infinity,        // render distance in world units (see
//                                    //   setRenderDistance)
//     hysteresis = 4,                // units of slack around each LOD boundary
//     maxBuildsPerFrame = 2,         // lazy-LOD build budget per update()
//   })
//
//   cm.addChunk(cx, cz, volumeSlice)   // volumeSlice: sliceVolume() result (or any
//                                      //   Volume). Builds LOD 0 immediately.
//   cm.removeChunk(cx, cz) / cm.rebuildChunk(cx, cz, newSlice?)   // edits
//   cm.update(dt, ctx)                 // per frame: distance per chunk vs
//                                      //   ctx.camera, LOD swap (lazy build,
//                                      //   both LODs cached), render-distance hide
//   cm.setRenderDistance(units)        // null / <=0 / Infinity = unlimited
//   cm.stats() -> { chunks, visibleEstimate, trianglesTotal }
//   cm.object3d; cm.setEnabled(on); cm.enabled; cm.dispose();
//
// sliceVolume(world, cx, cz, chunkSize) wraps a big Volume into a chunk-local
// one whose accessors read ACROSS chunk borders from the parent world, so faces
// on chunk seams cull correctly (a solid neighbour in the next chunk occludes).
//
// Per-frame cost: one clamped-AABB distance + a compare per chunk, zero
// allocations. Geometry builds only happen when a chunk crosses an unbuilt LOD
// boundary, capped at maxBuildsPerFrame; once both LODs are cached a swap is a
// `mesh.geometry` pointer assignment.
//
// Node self-test (seam culling + LOD/manager smoke test). Bare 'three' is
// resolved to the vendored build via an inline loader hook — run from
// graphics-lab/:
//
//   node --import 'data:text/javascript,import{register}from"node:module";register("data:text/javascript;base64,ZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmUocyxjLG4pe2lmKHM9PT0ndGhyZWUnKXJldHVybnt1cmw6bmV3IFVSTCgnLi4vdmVuZG9yL3RocmVlLm1vZHVsZS5qcycsYy5wYXJlbnRVUkwpLmhyZWYsc2hvcnRDaXJjdWl0OnRydWV9O3JldHVybiBuKHMsYyk7fQ==")' src/chunkManager.js
//
// (plain `node --check src/chunkManager.js` validates syntax only)

import * as THREE from 'three';
import { buildChunkGeometry } from './voxelMesher.js';

// ---------------------------------------------------------------------------
// sliceVolume — chunk-local window over a big world volume
// ---------------------------------------------------------------------------

/**
 * Wrap a big volume { sx, sy, sz, get, isSolid, isOpaque, WATER_LEVEL } into a
 * chunk-local volume. Local (x, y, z) maps to world (x + cx*chunkSize, y,
 * z + cz*chunkSize) — WITHOUT clamping to the slice bounds, so out-of-slice
 * reads (x = -1 or x = sx) land in the neighbouring chunk of the parent world.
 * That is exactly what makes the mesher cull faces on chunk seams: the
 * neighbour test `isOpaque(sx, y, z)` sees the real adjacent block instead of
 * a fake air border. The world's own accessors keep handling true
 * out-of-world coordinates (they must return 0 / false there).
 *
 * The returned accessors are plain closures (no `this`), safe for meshers
 * that hoist them as bare function refs.
 */
export function sliceVolume(world, cx, cz, chunkSize = 16) {
  const ox = cx * chunkSize;
  const oz = cz * chunkSize;
  // Edge chunks of a non-multiple world get a smaller footprint.
  const sx = Math.max(0, Math.min(chunkSize, world.sx - ox));
  const sz = Math.max(0, Math.min(chunkSize, world.sz - oz));

  const wGet = world.get;
  const wOpaque = world.isOpaque || world.isSolid || (() => false);
  const wSolid = world.isSolid || world.isOpaque || (() => false);

  return {
    sx,
    sy: world.sy,
    sz,
    get: (x, y, z) => wGet(x + ox, y, z + oz),
    isSolid: (x, y, z) => wSolid(x + ox, y, z + oz),
    isOpaque: (x, y, z) => wOpaque(x + ox, y, z + oz),
    WATER_LEVEL: world.WATER_LEVEL,
    // Metadata for placement/debugging.
    cx,
    cz,
    chunkSize,
    origin: { x: ox, y: 0, z: oz },
  };
}

// ---------------------------------------------------------------------------
// ChunkManager
// ---------------------------------------------------------------------------

// Normalize a mesher result to { solid, transparent } (a bare BufferGeometry
// is treated as the solid pass) — keeps both chunk-pipeline meshers plug-in.
function normalizeMeshed(res) {
  if (res && res.isBufferGeometry) return { solid: res, transparent: null };
  return { solid: (res && res.solid) || null, transparent: (res && res.transparent) || null };
}

function geometryTris(g) {
  if (!g) return 0;
  const idx = g.getIndex();
  if (idx) return (idx.count / 3) | 0;
  const pos = g.getAttribute('position');
  return pos ? (pos.count / 3) | 0 : 0;
}

export class ChunkManager {
  constructor(scene = null, {
    chunkSize = 16,
    mesher = buildChunkGeometry,
    material = null,
    transparentMaterial = null,
    lod = [{ dist: 0, ao: true }, { dist: 96, ao: false }],
    mesherOpts = {},
    maxDistance = Infinity,
    hysteresis = 4,
    maxBuildsPerFrame = 2,
  } = {}) {
    this._scene = scene;
    this._chunkSize = chunkSize;
    this._mesher = mesher;
    this._hysteresis = Math.max(0, hysteresis);
    this._maxBuildsPerFrame = Math.max(1, maxBuildsPerFrame | 0);
    this._maxDistance = (maxDistance == null || maxDistance <= 0) ? Infinity : maxDistance;

    // LOD levels sorted ascending by dist; per-level mesher opts precomputed
    // once (shared opts + level opts minus `dist`) so builds never assemble
    // option objects.
    const sorted = lod.slice().sort((a, b) => (a.dist || 0) - (b.dist || 0));
    this._lods = sorted.map((l) => ({ dist: l.dist || 0 }));
    this._lodOpts = sorted.map((l) => {
      const o = Object.assign({}, mesherOpts, l);
      delete o.dist;
      return o;
    });

    this._ownsMaterial = !material;
    this._material = material || new THREE.MeshStandardMaterial({ vertexColors: true });
    this._transparentMaterial = transparentMaterial || this._material;

    this._group = new THREE.Group();
    this._group.name = 'chunkManager';
    if (scene) scene.add(this._group);

    this._map = new Map();   // "cx,cz" -> chunk record
    this._list = [];         // iteration array (hot path — no Map iterator allocs)
    this._enabled = true;
    this._disposed = false;
    this._lastCamera = null;

    // stats() scratch (stats is not per-frame, but stay allocation-tidy anyway)
    this._projScreen = new THREE.Matrix4();
    this._frustum = new THREE.Frustum();
    this._sphere = new THREE.Sphere();
  }

  get object3d() { return this._group; }
  get enabled() { return this._enabled; }
  get chunkSize() { return this._chunkSize; }

  static key(cx, cz) { return cx + ',' + cz; }

  /**
   * Add (or replace) the chunk at grid coords (cx, cz). `volumeSlice` is
   * typically sliceVolume(world, cx, cz, chunkSize) — any Volume-shaped object
   * works. Builds LOD 0 immediately so the chunk renders on the next frame;
   * coarser LODs are built lazily on demand by update().
   */
  addChunk(cx, cz, volumeSlice) {
    if (this._disposed) return null;
    if (!volumeSlice || typeof volumeSlice.get !== 'function') {
      throw new Error('ChunkManager.addChunk: volumeSlice with get()/isOpaque() required (see sliceVolume)');
    }
    const key = ChunkManager.key(cx, cz);
    if (this._map.has(key)) this.removeChunk(cx, cz);

    const x0 = cx * this._chunkSize;
    const z0 = cz * this._chunkSize;
    const sx = volumeSlice.sx;
    const sy = volumeSlice.sy;
    const sz = volumeSlice.sz;

    const chunk = {
      cx, cz, key,
      volume: volumeSlice,
      x0, z0,
      centerX: x0 + sx * 0.5,
      centerY: sy * 0.5,
      centerZ: z0 + sz * 0.5,
      halfX: sx * 0.5,
      halfY: sy * 0.5,
      halfZ: sz * 0.5,
      radius: 0.5 * Math.sqrt(sx * sx + sy * sy + sz * sz),
      lodGeoms: new Array(this._lods.length).fill(null),  // lazy LOD cache
      triCounts: new Array(this._lods.length).fill(0),
      lodIndex: -1,
      solidMesh: null,
      transMesh: null,
      transActive: false,
      distHidden: false,
    };

    this._buildLod(chunk, 0);
    chunk.solidMesh = new THREE.Mesh(chunk.lodGeoms[0].solid, this._material);
    chunk.solidMesh.name = 'chunk_' + key;
    chunk.solidMesh.position.set(x0, 0, z0);
    chunk.solidMesh.castShadow = true;
    chunk.solidMesh.receiveShadow = true;
    this._group.add(chunk.solidMesh);
    this._applyLod(chunk, 0);

    this._map.set(key, chunk);
    this._list.push(chunk);
    return chunk;
  }

  removeChunk(cx, cz) {
    const chunk = this._map.get(ChunkManager.key(cx, cz));
    if (!chunk) return false;
    this._map.delete(chunk.key);
    const i = this._list.indexOf(chunk);
    if (i >= 0) {
      // O(1) swap-remove; iteration order does not matter.
      this._list[i] = this._list[this._list.length - 1];
      this._list.pop();
    }
    if (chunk.solidMesh) this._group.remove(chunk.solidMesh);
    if (chunk.transMesh) this._group.remove(chunk.transMesh);
    this._disposeChunkGeoms(chunk);
    return true;
  }

  /**
   * Re-mesh a chunk after an edit. Drops every cached LOD, rebuilds the LOD
   * the chunk is currently showing synchronously (instant feedback), and lets
   * the other levels rebuild lazily.
   */
  rebuildChunk(cx, cz, newVolumeSlice = null) {
    const chunk = this._map.get(ChunkManager.key(cx, cz));
    if (!chunk) return false;
    if (newVolumeSlice) chunk.volume = newVolumeSlice;
    const keep = Math.max(0, chunk.lodIndex);
    this._disposeChunkGeoms(chunk);
    chunk.lodGeoms.fill(null);
    chunk.triCounts.fill(0);
    chunk.lodIndex = -1;
    this._buildLod(chunk, keep);
    this._applyLod(chunk, keep);
    return true;
  }

  getChunk(cx, cz) { return this._map.get(ChunkManager.key(cx, cz)) || null; }

  /** Render distance in world units. null / <= 0 / Infinity = unlimited. */
  setRenderDistance(units) {
    this._maxDistance = (units == null || units <= 0 || units === Infinity) ? Infinity : units;
  }

  get renderDistance() { return this._maxDistance; }

  /**
   * Per frame: distance from ctx.camera to each chunk's AABB (clamped, so a
   * camera inside a chunk reads distance 0), render-distance hiding, and LOD
   * swaps with hysteresis. Unbuilt LOD geometry is built lazily, at most
   * maxBuildsPerFrame per call; both LODs stay cached after that so later
   * swaps are pointer assignments. Zero allocations.
   */
  update(dt, ctx) {
    if (!this._enabled || this._disposed) return;
    const cam = ctx && ctx.camera;
    if (!cam) return;
    this._lastCamera = cam;

    const cp = cam.position;
    const lods = this._lods;
    const nLods = lods.length;
    const maxDist = this._maxDistance;
    const hys = this._hysteresis;
    const list = this._list;
    let builds = 0;

    for (let i = 0; i < list.length; i++) {
      const c = list[i];

      let dx = Math.abs(cp.x - c.centerX) - c.halfX; if (dx < 0) dx = 0;
      let dy = Math.abs(cp.y - c.centerY) - c.halfY; if (dy < 0) dy = 0;
      let dz = Math.abs(cp.z - c.centerZ) - c.halfZ; if (dz < 0) dz = 0;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Render-distance cutoff (frustum culling is per-mesh, done by THREE).
      const hidden = d > maxDist;
      if (hidden !== c.distHidden) this._setChunkHidden(c, hidden);
      if (hidden) continue; // never spend LOD builds on hidden chunks

      // Target LOD for this distance (levels ascend by dist).
      let target = 0;
      for (let li = nLods - 1; li >= 1; li--) {
        if (d >= lods[li].dist) { target = li; break; }
      }
      if (target === c.lodIndex) continue;

      // Hysteresis: ignore switches while hovering right at the boundary
      // being crossed, so a camera orbiting on a threshold doesn't flap.
      const boundary = lods[Math.max(target, c.lodIndex)].dist;
      if (c.lodIndex >= 0 && Math.abs(d - boundary) < hys) continue;

      if (!c.lodGeoms[target]) {
        if (builds >= this._maxBuildsPerFrame) continue; // retry next frame
        this._buildLod(c, target);
        builds++;
      }
      this._applyLod(c, target);
    }
  }

  /**
   * { chunks, visibleEstimate, trianglesTotal }
   * - chunks: chunks managed.
   * - visibleEstimate: chunks inside render distance whose bounding sphere
   *   intersects the last update()'s camera frustum (all non-hidden chunks
   *   when no camera has been seen yet).
   * - trianglesTotal: triangles across the ACTIVE LOD of every non-hidden
   *   chunk (solid + transparent) — what the GPU is actually asked to draw
   *   before frustum culling.
   */
  stats() {
    const list = this._list;
    let visible = 0;
    let tris = 0;

    const cam = this._lastCamera;
    let useFrustum = false;
    if (cam && cam.projectionMatrix && cam.matrixWorldInverse) {
      this._projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this._frustum.setFromProjectionMatrix(this._projScreen);
      useFrustum = true;
    }

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.distHidden) continue;
      if (c.lodIndex >= 0) tris += c.triCounts[c.lodIndex];
      if (useFrustum) {
        this._sphere.center.set(c.centerX, c.centerY, c.centerZ);
        this._sphere.radius = c.radius;
        if (this._frustum.intersectsSphere(this._sphere)) visible++;
      } else {
        visible++;
      }
    }
    return { chunks: list.length, visibleEstimate: visible, trianglesTotal: tris };
  }

  setEnabled(on) {
    this._enabled = !!on;
    this._group.visible = this._enabled;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (let i = 0; i < this._list.length; i++) {
      const c = this._list[i];
      if (c.solidMesh) this._group.remove(c.solidMesh);
      if (c.transMesh) this._group.remove(c.transMesh);
      this._disposeChunkGeoms(c);
    }
    this._list.length = 0;
    this._map.clear();
    if (this._scene) this._scene.remove(this._group);
    if (this._ownsMaterial) this._material.dispose();
    this._lastCamera = null;
  }

  // --- internals -----------------------------------------------------------

  _buildLod(chunk, li) {
    const res = normalizeMeshed(this._mesher(chunk.volume, this._lodOpts[li]));
    if (!res.solid) res.solid = new THREE.BufferGeometry();
    if (!res.solid.boundingSphere) res.solid.computeBoundingSphere();
    if (res.transparent && !res.transparent.boundingSphere) res.transparent.computeBoundingSphere();
    chunk.lodGeoms[li] = res;
    chunk.triCounts[li] = geometryTris(res.solid) + geometryTris(res.transparent);
  }

  _applyLod(chunk, li) {
    const geoms = chunk.lodGeoms[li];
    if (!geoms) return;
    chunk.lodIndex = li;
    chunk.solidMesh.geometry = geoms.solid;

    if (geoms.transparent) {
      if (!chunk.transMesh) {
        chunk.transMesh = new THREE.Mesh(geoms.transparent, this._transparentMaterial);
        chunk.transMesh.name = 'chunk_' + chunk.key + '_transparent';
        chunk.transMesh.position.set(chunk.x0, 0, chunk.z0);
        chunk.transMesh.renderOrder = 1; // after solids (matches leaves convention)
        chunk.transMesh.castShadow = true;
        chunk.transMesh.receiveShadow = true;
        this._group.add(chunk.transMesh);
      } else {
        chunk.transMesh.geometry = geoms.transparent;
      }
      chunk.transActive = true;
      chunk.transMesh.visible = !chunk.distHidden;
    } else {
      chunk.transActive = false;
      if (chunk.transMesh) chunk.transMesh.visible = false;
    }
  }

  _setChunkHidden(chunk, hidden) {
    chunk.distHidden = hidden;
    if (chunk.solidMesh) chunk.solidMesh.visible = !hidden;
    if (chunk.transMesh) chunk.transMesh.visible = !hidden && chunk.transActive;
  }

  _disposeChunkGeoms(chunk) {
    for (let li = 0; li < chunk.lodGeoms.length; li++) {
      const g = chunk.lodGeoms[li];
      if (!g) continue;
      if (g.solid) g.solid.dispose();
      if (g.transparent) g.transparent.dispose();
      chunk.lodGeoms[li] = null;
    }
  }
}

export default ChunkManager;

// ---------------------------------------------------------------------------
// Node self-test (run command in the header). Browser never executes this:
// `process` is undefined there, so the guarded block short-circuits.
// ---------------------------------------------------------------------------

if (typeof process !== 'undefined' && process.versions && process.versions.node && process.argv[1]) {
  const { pathToFileURL } = await import('node:url');
  if (pathToFileURL(process.argv[1]).href === import.meta.url) {
    const STONE = 3;
    let failures = 0;
    const check = (name, cond) => {
      if (cond) console.log('PASS  ' + name);
      else { failures++; console.error('FAIL  ' + name); }
    };

    // A 32x8x16 world: two 16-chunks along x, solid stone slab for y < 4.
    const W = { sx: 32, sy: 8, sz: 16 };
    const inWorld = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < W.sx && y < W.sy && z < W.sz;
    const world = {
      sx: W.sx, sy: W.sy, sz: W.sz,
      get: (x, y, z) => (inWorld(x, y, z) && y < 4 ? STONE : 0),
      isSolid: (x, y, z) => inWorld(x, y, z) && y < 4,
      isOpaque: (x, y, z) => inWorld(x, y, z) && y < 4,
      WATER_LEVEL: 2,
    };

    // --- sliceVolume accessor correctness across the seam -------------------
    const s0 = sliceVolume(world, 0, 0, 16);
    const s1 = sliceVolume(world, 1, 0, 16);
    check('slice dims', s0.sx === 16 && s0.sy === 8 && s0.sz === 16 && s1.sx === 16);
    check('slice origin', s1.origin.x === 16 && s1.origin.z === 0);
    check('in-chunk read', s0.get(3, 0, 3) === STONE && s0.get(3, 7, 3) === 0);
    check('cross-border read +x (chunk0 sees chunk1)', s0.get(16, 0, 0) === STONE && s0.isOpaque(16, 2, 5) === true);
    check('cross-border read -x (chunk1 sees chunk0)', s1.get(-1, 0, 0) === STONE && s1.isOpaque(-1, 3, 2) === true);
    check('world edge stays air', s0.get(-1, 0, 0) === 0 && s1.get(16, 0, 0) === 0 && s0.isOpaque(0, -1, 0) === false);
    check('WATER_LEVEL passthrough', s0.WATER_LEVEL === 2);

    // --- seam culling through the real mesher -------------------------------
    // Count quads facing +/-X exactly on a given local x-plane.
    const countXFaces = (geo, sign, plane) => {
      const pos = geo.getAttribute('position');
      const nor = geo.getAttribute('normal');
      let verts = 0;
      for (let i = 0; i < nor.count; i++) {
        if (nor.getX(i) === sign && Math.abs(pos.getX(i) - plane) < 1e-6) verts++;
      }
      return verts / 4; // 4 verts per quad
    };

    const meshed0 = buildChunkGeometry(s0, { ao: true });
    const meshed1 = buildChunkGeometry(s1, { ao: true });
    check('chunk0 seam faces (+x @ x=16) culled', countXFaces(meshed0.solid, 1, 16) === 0);
    check('chunk1 seam faces (-x @ x=0) culled', countXFaces(meshed1.solid, -1, 0) === 0);
    check('chunk0 world-edge wall (-x @ x=0) kept', countXFaces(meshed0.solid, -1, 0) === 16 * 4);
    check('chunk1 world-edge wall (+x @ x=16) kept', countXFaces(meshed1.solid, 1, 16) === 16 * 4);

    // Naive slice (out-of-slice = air, i.e. NOT reading the parent world):
    // the seam wall must appear — proves the detector sees it, and that the
    // 64-quad delta below is exactly the seam.
    const naive0 = {
      sx: 16, sy: 8, sz: 16,
      get: (x, y, z) => (x >= 0 && x < 16 && z >= 0 && z < 16 && y >= 0 && y < 4 ? STONE : 0),
      isOpaque: (x, y, z) => x >= 0 && x < 16 && z >= 0 && z < 16 && y >= 0 && y < 4,
    };
    const meshedNaive = buildChunkGeometry(naive0, { ao: true });
    check('naive slice EMITS the seam wall', countXFaces(meshedNaive.solid, 1, 16) === 16 * 4);
    const trisOf = (g) => g.getIndex().count / 3;
    check('sliced chunk = naive - 64 seam quads',
      trisOf(meshedNaive.solid) - trisOf(meshed0.solid) === 16 * 4 * 2);

    // --- ChunkManager smoke test (LOD swap, render distance, stats) ---------
    const scene = new THREE.Scene();
    const cm = new ChunkManager(scene, {
      chunkSize: 16,
      lod: [{ dist: 0, ao: true }, { dist: 10, ao: false }],
      hysteresis: 0,
      maxBuildsPerFrame: 8,
    });
    cm.addChunk(0, 0, sliceVolume(world, 0, 0, 16));
    cm.addChunk(1, 0, sliceVolume(world, 1, 0, 16));
    check('meshes per chunk in group', cm.object3d.children.length === 2);

    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
    camera.position.set(4, 6, 8);           // inside chunk (0,0)
    camera.lookAt(24, 2, 8);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    const ctx = { camera };
    cm.update(0.016, ctx);
    const c0 = cm.getChunk(0, 0);
    const c1 = cm.getChunk(1, 0);
    check('near chunk keeps LOD 0', c0.lodIndex === 0);
    // camera->chunk1 AABB distance = 12 (16 - 4) >= 10 -> LOD 1, built lazily
    check('far chunk swapped to LOD 1 (lazy build)', c1.lodIndex === 1 && !!c1.lodGeoms[1]);
    check('both LODs cached on far chunk', !!c1.lodGeoms[0] && !!c1.lodGeoms[1]);
    check('LOD1 (ao off) geometry is on the mesh', c1.solidMesh.geometry === c1.lodGeoms[1].solid);

    let st = cm.stats();
    check('stats shape', st.chunks === 2 && st.trianglesTotal > 0 && st.visibleEstimate >= 1 && st.visibleEstimate <= 2);

    cm.setRenderDistance(5);
    cm.update(0.016, ctx);
    check('render distance hides far chunk', c1.distHidden === true && c1.solidMesh.visible === false);
    check('near chunk still visible', c0.distHidden === false && c0.solidMesh.visible === true);
    st = cm.stats();
    check('stats exclude hidden chunk tris', st.trianglesTotal === c0.triCounts[c0.lodIndex]);

    cm.setRenderDistance(null);
    cm.update(0.016, ctx);
    check('unlimited render distance unhides', c1.distHidden === false && c1.solidMesh.visible === true);

    check('rebuildChunk works', cm.rebuildChunk(1, 0) === true && c1.lodGeoms[c1.lodIndex] !== null);
    check('removeChunk works', cm.removeChunk(0, 0) === true && cm.stats().chunks === 1);
    cm.dispose();
    check('dispose empties scene group', scene.children.length === 0);

    if (failures > 0) {
      console.error(failures + ' failure(s)');
      process.exit(1);
    }
    console.log('chunkManager self-test: all checks passed');
  }
}
