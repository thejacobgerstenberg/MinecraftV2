// graphics-lab/src/torchlights.js
//
// TORCH LIGHT MANAGER — hundreds of registered torches, a fixed budget of
// real THREE.PointLight objects.
//
//   class TorchLightManager(scene, { maxLights = 6 })
//
// Real dynamic point lights are expensive (every lit material pays per light),
// so a voxel world with 300 torches cannot give each one a light. Instead this
// manager keeps a small POOL of warm point lights (the budget) and, every
// frame, snaps them onto the N registered torches nearest the camera:
//
//   * register(pos, { intensity }) -> id / unregister(id): positions live in
//     plain parallel arrays (px/py/pz) — hundreds of registrations are just
//     array pushes. The optional per-torch `intensity` (default 1) scales the
//     pooled light while that torch owns it (e.g. emissive level 0-15 mapped
//     to level/15 by emitters.js registerEmitterLights).
//   * Nearest-N selection is an allocation-free top-K insertion scan
//     (O(count * K), K <= 14, count <= ~500 -> trivial; no per-frame sort of
//     the whole set, no comparator closures, no scratch object churn).
//   * When the winning set changes, lights CROSS-FADE over ~0.25 s instead of
//     teleporting at full brightness (no popping as the camera moves).
//   * Each active light flickers organically: two octaves of SMOOTHED value
//     noise seeded by the torch id (deterministic per torch, C1-smooth in
//     time — never raw Math.random per frame) drive intensity around a ~1.1
//     base, plus a subtle +-0.03 position jitter so the light dances like a
//     real flame.
//
// Quality mapping for the demo's quality dropdown (exported):
//   QUALITY_LIGHTS = { low: 2, medium: 6, high: 10, ultra: 14 }
//   -> manager.setMaxLights(QUALITY_LIGHTS[q])
//
// Also exports makeTorchMesh(): a tiny stick+coal voxel mesh (shared
// geometry/materials across all instances) the demo can place at each torch
// position so the pooled lights have a visible source; the coal head is
// emissive so PostFX bloom picks it up even when the torch loses the light
// budget lottery.
//
// Follows the graphics-lab effect contract: update(dt, ctx), setEnabled(bool),
// get enabled, dispose(). No .object3d — the pool lights are added directly to
// the scene (refs kept for dispose). Zero per-frame allocation.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const QUALITY_LIGHTS = { low: 2, medium: 6, high: 10, ultra: 14 };

const LIGHT_COLOR = 0xffa64d;    // warm torch orange
const LIGHT_DISTANCE = 14;       // world units of falloff (was 9 — barely lit
                                 // the adjacent block; 14 paints a readable
                                 // warm pool over nearby terrain)
const LIGHT_DECAY = 1.8;         // slightly sub-inverse-square so the ground
                                 // bounce reaches a couple of blocks out
const BASE_INTENSITY = 3.0;      // flicker oscillates around this (was 1.1 —
                                 // torches read as dim specks in night shots)
const FADE_TIME = 0.25;          // seconds to fade in/out on reassignment
const JITTER = 0.03;             // +- position wobble, world units

// Flicker shaping: intensity = BASE * (FLICK_LO + FLICK_SPAN * noise01).
// noise01 has mean ~0.5, so the light breathes ~0.86x..1.28x of base.
const FLICK_LO = 0.78;
const FLICK_SPAN = 0.5;
const FLICK_FREQ_A = 6.3;        // slow wander (Hz-ish)
const FLICK_FREQ_B = 15.7;       // fast sputter
const JITTER_FREQ = 3.1;

// ---------------------------------------------------------------------------
// Deterministic smoothed noise (no Math.random anywhere)
// ---------------------------------------------------------------------------

// Integer hash -> [0, 1). Good avalanche, cheap.
function hash01(n) {
  n |= 0;
  n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
  n = Math.imul(n ^ (n >>> 12), 0x297a2d39);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}

// 1-D value noise: hash values at integer lattice points of t, smoothstep
// blend between them. C1-continuous — this is what makes the flicker read as
// a flame instead of white-noise strobing.
function smoothNoise(seed, t) {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = hash01(seed + Math.imul(i, 0x9e3779b1));
  const b = hash01(seed + Math.imul(i + 1, 0x9e3779b1));
  return a + (b - a) * u;
}

// Two octaves of smoothed noise -> 0..1 flame flicker signal.
function flickerNoise(seed, t) {
  return 0.62 * smoothNoise(seed, t * FLICK_FREQ_A)
       + 0.38 * smoothNoise(seed ^ 0x5bd1e9, t * FLICK_FREQ_B);
}

// Integer block coords are centred (+0.5), matching particles.js addTorch so
// the light sits inside the flame, not on the block corner. Integer y sits at
// flame height (+0.55) — same offset particles.js uses.
function centreAxis(v) {
  return Number.isInteger(v) ? v + 0.5 : v;
}

// ---------------------------------------------------------------------------
// TorchLightManager
// ---------------------------------------------------------------------------

export class TorchLightManager {
  constructor(scene, {
    maxLights = 6,
    color = LIGHT_COLOR,
    distance = LIGHT_DISTANCE,
    decay = LIGHT_DECAY,
    baseIntensity = BASE_INTENSITY,
    fadeTime = FADE_TIME,
  } = {}) {
    this._scene = scene;
    this._color = color;
    this._distance = distance;
    this._decay = decay;
    this._base = baseIntensity;
    this._fadeTime = Math.max(fadeTime, 1e-3);
    this._enabled = true;
    this._time = 0;

    // Registered torches: plain parallel arrays + id -> index map.
    // Swap-remove keeps unregister O(1); the map absorbs the index shuffle.
    this._ids = [];
    this._px = [];
    this._py = [];
    this._pz = [];
    this._sc = [];   // per-torch intensity scale (default 1)
    this._idToIndex = new Map();
    this._nextId = 1;

    // Light pool + selection scratch (rebuilt only by setMaxLights).
    this._slots = [];
    this._bestD = [];
    this._bestI = [];
    this._wantId = [];
    this._wantTaken = [];
    this._buildPool(Math.max(0, maxLights | 0));
  }

  get enabled() { return this._enabled; }
  get maxLights() { return this._slots.length; }
  get count() { return this._ids.length; }

  // -- registration ---------------------------------------------------------

  // pos: THREE.Vector3 or {x,y,z}. Returns an id for unregister().
  // opts.intensity (optional, default 1): per-torch multiplier on the pooled
  // light's flickering intensity — lets emissive-level-derived emitters glow
  // proportionally without a second pool.
  register(pos, { intensity = 1 } = {}) {
    const id = this._nextId++;
    const i = this._ids.length;
    this._ids.push(id);
    this._px.push(centreAxis(pos.x));
    this._py.push(Number.isInteger(pos.y) ? pos.y + 0.55 : pos.y);
    this._pz.push(centreAxis(pos.z));
    this._sc.push(Number.isFinite(intensity) && intensity > 0 ? intensity : 1);
    this._idToIndex.set(id, i);
    return id;
  }

  unregister(id) {
    const i = this._idToIndex.get(id);
    if (i === undefined) return false;
    const last = this._ids.length - 1;
    if (i !== last) {
      const movedId = this._ids[last];
      this._ids[i] = movedId;
      this._px[i] = this._px[last];
      this._py[i] = this._py[last];
      this._pz[i] = this._pz[last];
      this._sc[i] = this._sc[last];
      this._idToIndex.set(movedId, i);
    }
    this._ids.pop();
    this._px.pop();
    this._py.pop();
    this._pz.pop();
    this._sc.pop();
    this._idToIndex.delete(id);
    // Any slot holding this torch fades out naturally in update() (its id no
    // longer resolves in the map).
    return true;
  }

  // -- pool management ------------------------------------------------------

  _makeSlot() {
    const light = new THREE.PointLight(this._color, 0, this._distance, this._decay);
    light.castShadow = false;             // budget lights never cast shadows
    light.visible = false;
    light.userData.noShadow = true;       // shadows.js applyToScene skip flag
    if (this._scene) this._scene.add(light);
    return {
      light,
      id: -1,        // torch id currently owned (-1 = free)
      seed: 0,       // hash seed derived from id at assignment
      scale: 1,      // per-torch intensity scale captured at assignment
      x: 0, y: 0, z: 0,
      alpha: 0,      // current fade level 0..1
      target: 0,     // fade destination
    };
  }

  _buildPool(n) {
    // Shrink: drop surplus slots (dispose their lights).
    while (this._slots.length > n) {
      const s = this._slots.pop();
      if (this._scene) this._scene.remove(s.light);
      s.light.dispose();
    }
    // Grow: add fresh dark slots (they fade in on first assignment).
    while (this._slots.length < n) this._slots.push(this._makeSlot());
    // Selection scratch sized to the pool.
    this._bestD.length = n;
    this._bestI.length = n;
    this._wantId.length = n;
    this._wantTaken.length = n;
  }

  // Re-pool to a new budget. Kept slots keep their assignment and brightness
  // (no popping); surplus slots are removed outright.
  setMaxLights(n) {
    n = Math.max(0, n | 0);
    if (n === this._slots.length) return;
    this._buildPool(n);
  }

  setEnabled(on) {
    on = !!on;
    if (on === this._enabled) return;
    this._enabled = on;
    const slots = this._slots;
    for (let k = 0; k < slots.length; k++) {
      const s = slots[k];
      if (!on) {
        s.light.intensity = 0;
        s.light.visible = false;
        s.alpha = 0;                      // re-enable fades back in smoothly
      }
    }
  }

  // -- per-frame ------------------------------------------------------------

  update(dt, ctx) {
    if (!this._enabled) return;
    const t = (ctx && typeof ctx.elapsed === 'number' && isFinite(ctx.elapsed))
      ? ctx.elapsed
      : (this._time += dt);
    this._time = t;

    const slots = this._slots;
    const K = slots.length;
    if (K === 0) return;

    const n = this._ids.length;
    const cam = ctx && ctx.camera;
    const bestD = this._bestD;
    const bestI = this._bestI;
    const wantId = this._wantId;
    const wantTaken = this._wantTaken;

    // 1. Top-K nearest torches to the camera (allocation-free insertion scan).
    let m = 0;
    if (cam && n > 0) {
      const cp = cam.position;
      const cx = cp.x, cy = cp.y, cz = cp.z;
      for (let k = 0; k < K; k++) { bestD[k] = Infinity; bestI[k] = -1; }
      const px = this._px, py = this._py, pz = this._pz;
      for (let i = 0; i < n; i++) {
        const dx = px[i] - cx, dy = py[i] - cy, dz = pz[i] - cz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d >= bestD[K - 1]) continue;
        let j = K - 1;
        while (j > 0 && bestD[j - 1] > d) {
          bestD[j] = bestD[j - 1];
          bestI[j] = bestI[j - 1];
          j--;
        }
        bestD[j] = d;
        bestI[j] = i;
      }
      for (let k = 0; k < K; k++) {
        if (bestI[k] >= 0) { wantId[m] = this._ids[bestI[k]]; m++; }
      }
    }

    // 2. Reconcile pool slots against the desired set.
    //    Kept torches stay lit; losers fade out; winners take freed slots and
    //    fade in. All scans are over <= K (14) entries — negligible.
    for (let k = 0; k < m; k++) wantTaken[k] = false;
    for (let s = 0; s < K; s++) {
      const slot = slots[s];
      if (slot.id < 0) continue;
      let keep = false;
      for (let k = 0; k < m; k++) {
        if (wantId[k] === slot.id) { keep = true; wantTaken[k] = true; break; }
      }
      // Torch fell out of the top-K (or was unregistered): fade out.
      slot.target = (keep && this._idToIndex.has(slot.id)) ? 1 : 0;
    }
    for (let k = 0; k < m; k++) {
      if (wantTaken[k]) continue;
      const id = wantId[k];
      const idx = this._idToIndex.get(id);
      if (idx === undefined) continue;
      // Claim a fully dark free slot (fading-out slots free up in <= 0.25 s).
      for (let s = 0; s < K; s++) {
        const slot = slots[s];
        if (slot.id >= 0 || slot.alpha > 0.001) continue;
        slot.id = id;
        slot.seed = Math.imul(id, 0x9e3779b1) | 0;
        slot.scale = this._sc[idx];
        slot.x = this._px[idx];
        slot.y = this._py[idx];
        slot.z = this._pz[idx];
        slot.alpha = 0;
        slot.target = 1;
        break;
      }
    }

    // 3. Fade + flicker + jitter.
    const fadeStep = dt / this._fadeTime;
    for (let s = 0; s < K; s++) {
      const slot = slots[s];
      const light = slot.light;
      if (slot.id < 0 && slot.alpha <= 0) {
        if (light.visible) { light.visible = false; light.intensity = 0; }
        continue;
      }
      // Linear fade toward target (~fadeTime seconds full swing).
      if (slot.alpha < slot.target) {
        slot.alpha = Math.min(slot.target, slot.alpha + fadeStep);
      } else if (slot.alpha > slot.target) {
        slot.alpha = Math.max(slot.target, slot.alpha - fadeStep);
        if (slot.alpha <= 0 && slot.target === 0) slot.id = -1; // slot freed
      }
      if (slot.alpha <= 0) {
        light.visible = false;
        light.intensity = 0;
        continue;
      }
      const seed = slot.seed;
      light.intensity = this._base * slot.scale
        * (FLICK_LO + FLICK_SPAN * flickerNoise(seed, t)) * slot.alpha;
      light.position.set(
        slot.x + (smoothNoise(seed + 11, t * JITTER_FREQ) - 0.5) * (2 * JITTER),
        slot.y + (smoothNoise(seed + 23, t * JITTER_FREQ) - 0.5) * (2 * JITTER),
        slot.z + (smoothNoise(seed + 47, t * JITTER_FREQ) - 0.5) * (2 * JITTER),
      );
      light.visible = true;
    }
  }

  dispose() {
    for (let s = 0; s < this._slots.length; s++) {
      const slot = this._slots[s];
      if (this._scene) this._scene.remove(slot.light);
      slot.light.dispose();
    }
    this._slots.length = 0;
    this._ids.length = 0;
    this._px.length = 0;
    this._py.length = 0;
    this._pz.length = 0;
    this._sc.length = 0;
    this._idToIndex.clear();
    this._scene = null;
  }
}

// ---------------------------------------------------------------------------
// makeTorchMesh — visible torch prop (stick + emissive coal head)
// ---------------------------------------------------------------------------

// Geometry/materials are lazily created ONCE and shared by every torch mesh —
// 300 torches cost 300 tiny Object3Ds, not 300 materials. Origin is at the
// base of the stick: place the group on the block floor (e.g. x+0.5, y, z+0.5
// for integer block coords) and the coal head lands at the manager's light
// height (~y + 0.55).
let _torchAssets = null;

function getTorchAssets() {
  if (_torchAssets) return _torchAssets;
  const stickGeo = new THREE.BoxGeometry(0.12, 0.5, 0.12);
  stickGeo.translate(0, 0.25, 0);        // base at y = 0
  const coalGeo = new THREE.BoxGeometry(0.16, 0.14, 0.16);
  coalGeo.translate(0, 0.55, 0);         // sits on top of the stick
  const stickMat = new THREE.MeshStandardMaterial({
    color: 0x6b4a26, roughness: 1.0, metalness: 0.0,
  });
  const coalMat = new THREE.MeshStandardMaterial({
    color: 0x2a1c10, roughness: 0.9, metalness: 0.0,
    emissive: 0xff9a33, emissiveIntensity: 1.6, // reads through bloom at night
  });
  _torchAssets = { stickGeo, coalGeo, stickMat, coalMat };
  return _torchAssets;
}

// -> THREE.Object3D (Group of 2 meshes). Shared assets; see note above.
export function makeTorchMesh() {
  const a = getTorchAssets();
  const group = new THREE.Group();
  group.name = 'torch';
  const stick = new THREE.Mesh(a.stickGeo, a.stickMat);
  const coal = new THREE.Mesh(a.coalGeo, a.coalMat);
  coal.userData.noShadow = true;         // glowing head shouldn't self-shadow
  group.add(stick);
  group.add(coal);
  group.userData.isTorch = true;
  return group;
}

// Frees the shared torch geometry/materials (call once, after removing every
// torch mesh — e.g. on full demo teardown).
export function disposeTorchMeshAssets() {
  if (!_torchAssets) return;
  _torchAssets.stickGeo.dispose();
  _torchAssets.coalGeo.dispose();
  _torchAssets.stickMat.dispose();
  _torchAssets.coalMat.dispose();
  _torchAssets = null;
}
