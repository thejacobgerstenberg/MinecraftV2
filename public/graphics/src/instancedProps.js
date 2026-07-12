// graphics-lab/src/instancedProps.js
//
// InstancedProps — THREE.InstancedMesh helper for repeated scene props
// (torches, rocks, flowers, fence posts...). One InstancedMesh per registered
// type = one draw call per type no matter how many placements.
//
//   const props = new InstancedProps(scene);
//   props.addType('torch', makeTorchMesh(), null, 300);   // Object3D -> merged
//   props.addType('rock', rockGeometry, rockMaterial, 500); // geometry as-is
//   const i = props.place('torch', { x: 12.5, y: 14, z: 20.5 }, { rotationY: 0.4 });
//   props.clear('torch');
//
// API:
//   addType(name, geometryOrObject3D, material = null, maxCount = 256)
//     - BufferGeometry: used directly with `material` (or a vertex-color
//       standard material fallback).
//     - Object3D (e.g. makeTorchMesh()): every child mesh geometry is merged
//       into ONE BufferGeometry with each part's transform baked in and each
//       part's material colour baked into a per-vertex `color` attribute.
//       LIMITATION (single material): an InstancedMesh draws with one
//       material, so per-part materials collapse to one vertex-colored
//       MeshStandardMaterial. Emissive parts (torch coal head) are
//       approximated by baking emissive*intensity into the vertex colour —
//       they read bright but do NOT feed bloom or emit light. Pass an
//       explicit `material` to override the fallback.
//   place(name, position, { rotationY = 0, scale = 1 } = {}) -> index (-1 when full)
//     position: THREE.Vector3 | {x,y,z} | [x,y,z]; scale: number | {x,y,z}.
//   clear(name) / clearAll()                    // reset placements (capacity kept)
//   getCount(name) / capacityOf(name) / stats() // count bookkeeping
//   .object3d                                    // group (auto-added when scene given)
//   update(dt, ctx); setEnabled(on); enabled; dispose()
//
// Per-frame cost is ZERO when static: placements write instance matrices with
// pooled scratch objects (no allocation) and flag the buffer once; update()
// only refreshes an InstancedMesh bounding sphere on frames after placements
// changed (needed so THREE's frustum culling stays correct), otherwise it is
// an empty loop over the type list.
//
// Node self-test (merge + bookkeeping). Bare 'three' resolves to the vendored
// build via an inline loader hook — run from graphics-lab/:
//
//   node --import 'data:text/javascript,import{register}from"node:module";register("data:text/javascript;base64,ZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmUocyxjLG4pe2lmKHM9PT0ndGhyZWUnKXJldHVybnt1cmw6bmV3IFVSTCgnLi4vdmVuZG9yL3RocmVlLm1vZHVsZS5qcycsYy5wYXJlbnRVUkwpLmhyZWYsc2hvcnRDaXJjdWl0OnRydWV9O3JldHVybiBuKHMsYyk7fQ==")' src/instancedProps.js

import * as THREE from 'three';

// Module-level scratch (place() is called in bursts — keep it allocation-free).
const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _v3 = new THREE.Vector3();
const _nrm = new THREE.Matrix3();
const _rel = new THREE.Matrix4();
const _rootInv = new THREE.Matrix4();

function readPosition(p, out) {
  if (Array.isArray(p)) out.set(p[0], p[1], p[2]);
  else out.set(p.x || 0, p.y || 0, p.z || 0);
  return out;
}

// ---------------------------------------------------------------------------
// Object3D -> single merged BufferGeometry (position/normal/color, indexed)
// ---------------------------------------------------------------------------

// Merge every Mesh under `root` into one geometry, baking each part's
// transform (relative to root) into positions/normals and its material colour
// (+ emissive approximation) into a vertex `color` attribute. Source
// geometries are NEVER mutated (makeTorchMesh shares its geometries across
// all torches). One-time build cost — allocation here is fine.
export function mergeObjectGeometry(root) {
  root.updateMatrixWorld(true);
  _rootInv.copy(root.matrixWorld).invert();

  const parts = [];
  let vTotal = 0;
  let iTotal = 0;
  root.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    const geo = child.geometry;
    const pos = geo.getAttribute('position');
    if (!pos) return;
    const vCount = pos.count;
    const iCount = geo.index ? geo.index.count : vCount;
    parts.push({ child, geo, vCount, iCount });
    vTotal += vCount;
    iTotal += iCount;
  });
  if (parts.length === 0) return new THREE.BufferGeometry();

  const positions = new Float32Array(vTotal * 3);
  const normals = new Float32Array(vTotal * 3);
  const colors = new Float32Array(vTotal * 3);
  const indices = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);

  let vOff = 0;
  let iOff = 0;
  for (let p = 0; p < parts.length; p++) {
    const { child, geo, vCount, iCount } = parts[p];
    _rel.multiplyMatrices(_rootInv, child.matrixWorld); // part transform, root-local
    _nrm.getNormalMatrix(_rel);

    // Single-material limitation: take the first material of a part and bake
    // its colour; emissive is folded in so glowing parts still read bright.
    const mat = Array.isArray(child.material) ? child.material[0] : child.material;
    let r = 1;
    let g = 1;
    let b = 1;
    if (mat && mat.color) { r = mat.color.r; g = mat.color.g; b = mat.color.b; }
    if (mat && mat.emissive && (mat.emissiveIntensity === undefined || mat.emissiveIntensity > 0)) {
      const ei = Math.min(1, mat.emissiveIntensity === undefined ? 1 : mat.emissiveIntensity);
      r = Math.min(1, r + mat.emissive.r * ei);
      g = Math.min(1, g + mat.emissive.g * ei);
      b = Math.min(1, b + mat.emissive.b * ei);
    }

    const srcPos = geo.getAttribute('position');
    const srcNor = geo.getAttribute('normal');
    const srcCol = geo.getAttribute('color');
    for (let i = 0; i < vCount; i++) {
      _v3.fromBufferAttribute(srcPos, i).applyMatrix4(_rel);
      const o = (vOff + i) * 3;
      positions[o] = _v3.x;
      positions[o + 1] = _v3.y;
      positions[o + 2] = _v3.z;
      if (srcNor) {
        _v3.fromBufferAttribute(srcNor, i).applyMatrix3(_nrm).normalize();
        normals[o] = _v3.x;
        normals[o + 1] = _v3.y;
        normals[o + 2] = _v3.z;
      } else {
        normals[o + 1] = 1;
      }
      // Part colour, multiplied by any existing vertex colour.
      if (srcCol) {
        colors[o] = r * srcCol.getX(i);
        colors[o + 1] = g * srcCol.getY(i);
        colors[o + 2] = b * srcCol.getZ(i);
      } else {
        colors[o] = r;
        colors[o + 1] = g;
        colors[o + 2] = b;
      }
    }

    if (geo.index) {
      const src = geo.index;
      for (let i = 0; i < iCount; i++) indices[iOff + i] = src.getX(i) + vOff;
    } else {
      for (let i = 0; i < iCount; i++) indices[iOff + i] = vOff + i;
    }
    vOff += vCount;
    iOff += iCount;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

// ---------------------------------------------------------------------------
// InstancedProps
// ---------------------------------------------------------------------------

export class InstancedProps {
  constructor(scene = null, opts = {}) {
    this._scene = scene;
    this._group = new THREE.Group();
    this._group.name = 'instancedProps';
    if (scene) scene.add(this._group);
    this._types = new Map();  // name -> type record
    this._typeList = [];      // iteration array (update() hot path, no Map iterator)
    this._enabled = true;
    this._disposed = false;
    this._castShadow = opts.castShadow !== false;
    this._receiveShadow = opts.receiveShadow !== false;
  }

  get object3d() { return this._group; }
  get enabled() { return this._enabled; }

  /**
   * Register a prop type backed by one InstancedMesh with capacity maxCount.
   * geometryOrObject3D: BufferGeometry (used as-is) or Object3D (child meshes
   * merged — see header for the single-material limitation).
   * Returns the type record { mesh, geometry, material, count, maxCount }.
   */
  addType(name, geometryOrObject3D, material = null, maxCount = 256) {
    if (this._disposed) return null;
    if (this._types.has(name)) {
      console.warn('InstancedProps.addType: type "' + name + '" already exists — replacing it');
      this.removeType(name);
    }

    let geometry;
    let ownsGeometry;
    if (geometryOrObject3D && geometryOrObject3D.isBufferGeometry) {
      geometry = geometryOrObject3D;
      ownsGeometry = false;
    } else if (geometryOrObject3D && geometryOrObject3D.isObject3D) {
      geometry = mergeObjectGeometry(geometryOrObject3D);
      ownsGeometry = true; // we built it, we dispose it
    } else {
      throw new Error('InstancedProps.addType: BufferGeometry or Object3D required');
    }

    const ownsMaterial = !material;
    const mat = material || new THREE.MeshStandardMaterial({
      vertexColors: !!geometry.getAttribute('color'),
      roughness: 1.0,
      metalness: 0.0,
    });

    const mesh = new THREE.InstancedMesh(geometry, mat, Math.max(1, maxCount | 0));
    mesh.name = 'props_' + name;
    mesh.count = 0;
    // Static usage: instances are placed once and left alone; a placement
    // burst re-uploads the buffer once via needsUpdate, then it sits on the
    // GPU untouched — zero per-frame cost.
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.castShadow = this._castShadow;
    mesh.receiveShadow = this._receiveShadow;
    this._group.add(mesh);

    const type = {
      name,
      mesh,
      geometry,
      material: mat,
      ownsGeometry,
      ownsMaterial,
      count: 0,
      maxCount: Math.max(1, maxCount | 0),
      boundsDirty: false,
      warnedFull: false,
    };
    this._types.set(name, type);
    this._typeList.push(type);
    return type;
  }

  removeType(name) {
    const type = this._types.get(name);
    if (!type) return false;
    this._types.delete(name);
    const i = this._typeList.indexOf(type);
    if (i >= 0) {
      this._typeList[i] = this._typeList[this._typeList.length - 1];
      this._typeList.pop();
    }
    this._group.remove(type.mesh);
    type.mesh.dispose();
    if (type.ownsGeometry) type.geometry.dispose();
    if (type.ownsMaterial) type.material.dispose();
    return true;
  }

  /**
   * Place one instance. Returns its index, or -1 when the type is unknown or
   * at capacity (warned once per type). Allocation-free.
   */
  place(name, position, opts) {
    const type = this._types.get(name);
    if (!type) {
      console.warn('InstancedProps.place: unknown type "' + name + '"');
      return -1;
    }
    if (type.count >= type.maxCount) {
      if (!type.warnedFull) {
        type.warnedFull = true;
        console.warn('InstancedProps.place: type "' + name + '" is full (maxCount ' + type.maxCount + ')');
      }
      return -1;
    }

    const rotationY = (opts && opts.rotationY) || 0;
    const scale = opts && opts.scale !== undefined ? opts.scale : 1;

    readPosition(position, _pos);
    _quat.setFromAxisAngle(_up, rotationY);
    if (typeof scale === 'number') _scl.set(scale, scale, scale);
    else readPosition(scale, _scl);
    _mat4.compose(_pos, _quat, _scl);

    const index = type.count;
    type.mesh.setMatrixAt(index, _mat4);
    type.count = index + 1;
    type.mesh.count = type.count;
    type.mesh.instanceMatrix.needsUpdate = true;
    type.boundsDirty = true;
    return index;
  }

  /** Overwrite an existing instance's transform (e.g. to move a prop). */
  setInstance(name, index, position, opts) {
    const type = this._types.get(name);
    if (!type || index < 0 || index >= type.count) return false;
    const rotationY = (opts && opts.rotationY) || 0;
    const scale = opts && opts.scale !== undefined ? opts.scale : 1;
    readPosition(position, _pos);
    _quat.setFromAxisAngle(_up, rotationY);
    if (typeof scale === 'number') _scl.set(scale, scale, scale);
    else readPosition(scale, _scl);
    _mat4.compose(_pos, _quat, _scl);
    type.mesh.setMatrixAt(index, _mat4);
    type.mesh.instanceMatrix.needsUpdate = true;
    type.boundsDirty = true;
    return true;
  }

  /** Remove all placements of a type (capacity is kept for reuse). */
  clear(name) {
    const type = this._types.get(name);
    if (!type) return false;
    type.count = 0;
    type.mesh.count = 0;
    type.boundsDirty = true;
    type.warnedFull = false;
    return true;
  }

  clearAll() {
    for (let i = 0; i < this._typeList.length; i++) this.clear(this._typeList[i].name);
  }

  getCount(name) {
    const type = this._types.get(name);
    return type ? type.count : 0;
  }

  capacityOf(name) {
    const type = this._types.get(name);
    return type ? type.maxCount : 0;
  }

  /** { types, instances, capacity, drawCalls } */
  stats() {
    let instances = 0;
    let capacity = 0;
    let drawCalls = 0;
    for (let i = 0; i < this._typeList.length; i++) {
      const t = this._typeList[i];
      instances += t.count;
      capacity += t.maxCount;
      if (t.count > 0) drawCalls++;
    }
    return { types: this._typeList.length, instances, capacity, drawCalls };
  }

  /**
   * Effect-contract update. Cost is zero when nothing changed; on the frame
   * after placements changed it recomputes that type's bounding sphere so
   * THREE's whole-set frustum culling stays correct.
   */
  update(dt, ctx) {
    if (!this._enabled || this._disposed) return;
    const list = this._typeList;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t.boundsDirty) {
        t.boundsDirty = false;
        t.mesh.computeBoundingSphere();
      }
    }
  }

  setEnabled(on) {
    this._enabled = !!on;
    this._group.visible = this._enabled;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (let i = 0; i < this._typeList.length; i++) {
      const t = this._typeList[i];
      this._group.remove(t.mesh);
      t.mesh.dispose();
      if (t.ownsGeometry) t.geometry.dispose();
      if (t.ownsMaterial) t.material.dispose();
    }
    this._typeList.length = 0;
    this._types.clear();
    if (this._scene) this._scene.remove(this._group);
  }
}

export default InstancedProps;

// ---------------------------------------------------------------------------
// Node self-test (run command in the header). Browser never executes this:
// `process` is undefined there, so the guarded block short-circuits.
// ---------------------------------------------------------------------------

if (typeof process !== 'undefined' && process.versions && process.versions.node && process.argv[1]) {
  const { pathToFileURL } = await import('node:url');
  if (pathToFileURL(process.argv[1]).href === import.meta.url) {
    let failures = 0;
    const check = (name, cond) => {
      if (cond) console.log('PASS  ' + name);
      else { failures++; console.error('FAIL  ' + name); }
    };

    // Torch-like prop: two boxes, one offset + emissive (like makeTorchMesh).
    const stickGeo = new THREE.BoxGeometry(0.12, 0.5, 0.12); // 24 verts, 36 idx
    const coalGeo = new THREE.BoxGeometry(0.16, 0.14, 0.16);
    const stick = new THREE.Mesh(stickGeo, new THREE.MeshStandardMaterial({ color: 0x6b4a26 }));
    const coal = new THREE.Mesh(coalGeo, new THREE.MeshStandardMaterial({
      color: 0x2a1c10, emissive: 0xff9a33, emissiveIntensity: 1.6,
    }));
    coal.position.y = 0.55;
    const prop = new THREE.Group();
    prop.add(stick);
    prop.add(coal);

    const merged = mergeObjectGeometry(prop);
    check('merge vertex count = sum of parts',
      merged.getAttribute('position').count ===
        stickGeo.getAttribute('position').count + coalGeo.getAttribute('position').count);
    check('merge index count = sum of parts',
      merged.getIndex().count === stickGeo.getIndex().count + coalGeo.getIndex().count);
    check('merge has vertex colors', !!merged.getAttribute('color'));
    // The coal part's transform must be baked in: some vertex sits above 0.55.
    let maxY = -Infinity;
    const mp = merged.getAttribute('position');
    for (let i = 0; i < mp.count; i++) maxY = Math.max(maxY, mp.getY(i));
    check('child transform baked (coal head offset)', maxY > 0.55);
    // Emissive baked into colour: some vertex colour is brighter than either base colour.
    let maxR = 0;
    const mc = merged.getAttribute('color');
    for (let i = 0; i < mc.count; i++) maxR = Math.max(maxR, mc.getX(i));
    check('emissive baked into vertex colour', maxR > 0.9);
    // Sources untouched (shared geometries must never be mutated).
    check('source geometry not mutated', stickGeo.getAttribute('position').count === 24 && !stickGeo.getAttribute('color'));

    // Bookkeeping.
    const scene = new THREE.Scene();
    const props = new InstancedProps(scene);
    props.addType('torch', prop, null, 3);
    check('type registered', props.capacityOf('torch') === 3 && props.getCount('torch') === 0);

    const i0 = props.place('torch', { x: 1, y: 2, z: 3 });
    const i1 = props.place('torch', [4, 5, 6], { rotationY: Math.PI / 2, scale: 2 });
    const i2 = props.place('torch', new THREE.Vector3(7, 8, 9), { scale: { x: 1, y: 2, z: 1 } });
    check('place returns sequential indices', i0 === 0 && i1 === 1 && i2 === 2);
    check('count bookkeeping', props.getCount('torch') === 3);
    check('mesh.count tracks placements', props._types.get('torch').mesh.count === 3);
    check('overflow returns -1', props.place('torch', [0, 0, 0]) === -1);

    const m = new THREE.Matrix4();
    props._types.get('torch').mesh.getMatrixAt(1, m);
    const e = m.elements;
    check('instance matrix position baked', e[12] === 4 && e[13] === 5 && e[14] === 6);

    props.update(0.016, {}); // bounding-sphere refresh path
    check('bounds refreshed after placements', props._types.get('torch').boundsDirty === false);

    const st = props.stats();
    check('stats', st.types === 1 && st.instances === 3 && st.capacity === 3 && st.drawCalls === 1);

    check('clear resets count', props.clear('torch') === true && props.getCount('torch') === 0);
    check('place after clear reuses slots', props.place('torch', [0, 0, 0]) === 0);
    check('unknown type place is -1', props.place('nope', [0, 0, 0]) === -1);

    props.dispose();
    check('dispose empties scene', scene.children.length === 0);

    if (failures > 0) {
      console.error(failures + ' failure(s)');
      process.exit(1);
    }
    console.log('instancedProps self-test: all checks passed');
  }
}
