// graphics-lab/src/blockcrack.js
//
// BLOCK-BREAK CRACK DECALS — progressive Minecraft-style destroy-stage overlay.
//
//   class BlockCracks(scene, opts)
//
// Five 16x16 crack-stage alpha textures are painted procedurally on canvas at
// construction time (seeded rng, deterministic — no Math.random): stage 0 is a
// few hairline cracks radiating from the centre, stage 4 a dense web reaching
// the block edges. Crack texels are dark grey, everything else transparent,
// like vanilla destroy_stage_0..4. NearestFilter, no mipmaps.
//
// The crack web is generated ONCE as a set of random-walk polylines; each stage
// draws a longer prefix of more of them, so later stages strictly extend
// earlier ones (no crack "teleports" between stages).
//
// Decals are pooled: `maxSlots` reusable slots (default 4 — only one or two
// blocks crack at a time in the demo), each slot a Group of 6 unit quads pushed
// 0.001 outward from the voxel faces. No face-culling niceties by default; pass
// `volume` (worldgen Volume) to hide quads against opaque neighbours. Material
// is MeshBasicMaterial with alphaTest and multiply-ish blending (the crack
// darkens whatever is under it, so it reads correctly day and night); pass
// { blend: 'normal' } for plain alpha-cutout grey instead.
//
// API (graphics-lab effect contract + module extras):
//   showCrack(x, y, z, stage)        // stage 0..4; null/undefined removes
//   clearCrack(x, y, z)              // remove the decal at that voxel
//   clearAll()
//   animateBreak(x, y, z, { duration = 1.5, onComplete } = {}) -> { cancel() }
//     // steps stages 0..4 over `duration`, then clears + calls
//     // onComplete(x, y, z) (demo spawns debris / hides the block there)
//   setVolume(volume)                // enable/refresh exposed-face culling
//   update(dt, ctx); setEnabled(on); get enabled; dispose(); .object3d
//
// Zero per-frame allocation: update() only mutates pooled animation entries and
// pooled slots; textures/geometry/materials are built once in the constructor.

import * as THREE from 'three';

const TAU = Math.PI * 2;

export const CRACK_STAGES = 5;   // stage indices 0..4
const TEX_SIZE = 16;             // px, like vanilla destroy_stage_* textures
const FACE_EPS = 0.001;          // outward push off the voxel face
const ANIM_CAP = 4;              // concurrent animateBreak() entries

// Deterministic rng (same generator textures.js uses).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Crack web generation ----------------------------------------------------
// A jittered random walk from (x,y) along `ang`; each step records one pixel
// plus a per-pixel grey shade so a pixel keeps the same tone across stages.
function walkPath(rng, x, y, ang, steps) {
  const pts = [];
  for (let s = 0; s < steps; s++) {
    pts.push({
      x: Math.round(x),
      y: Math.round(y),
      shade: (20 + rng() * 45) | 0, // dark grey 20..65
    });
    ang += (rng() - 0.5) * 0.9;
    x += Math.cos(ang);
    y += Math.sin(ang);
    if (x < -0.5 || y < -0.5 || x > TEX_SIZE - 0.5 || y > TEX_SIZE - 0.5) break;
  }
  return pts;
}

// 8 main cracks radiating from the centre (long enough to reach the edges:
// centre->edge is 8 px, ->corner ~11 px) + 10 shorter branches forking off
// random points of the mains.
function buildCrackWeb(rng) {
  const mains = [];
  const N_MAIN = 8;
  for (let i = 0; i < N_MAIN; i++) {
    const ang = (i / N_MAIN) * TAU + (rng() - 0.5) * 0.9;
    mains.push(walkPath(
      rng,
      7.5 + (rng() - 0.5) * 1.5,
      7.5 + (rng() - 0.5) * 1.5,
      ang,
      9 + ((rng() * 3) | 0)
    ));
  }
  const branches = [];
  const N_BRANCH = 10;
  for (let i = 0; i < N_BRANCH; i++) {
    const src = mains[(rng() * N_MAIN) | 0];
    const p = src[Math.min(src.length - 1, 1 + ((rng() * (src.length - 1)) | 0))];
    branches.push(walkPath(rng, p.x, p.y, rng() * TAU, 3 + ((rng() * 4) | 0)));
  }
  return { mains, branches };
}

// How much of the web each stage reveals. `thicken` doubles up pixels for the
// heavy late-stage look.
const STAGE_PLAN = [
  { mains: 3, mainFrac: 0.35, branches: 0,  branchFrac: 0.0,  thicken: false },
  { mains: 5, mainFrac: 0.55, branches: 2,  branchFrac: 0.6,  thicken: false },
  { mains: 6, mainFrac: 0.75, branches: 5,  branchFrac: 0.75, thicken: false },
  { mains: 8, mainFrac: 0.9,  branches: 8,  branchFrac: 0.9,  thicken: true  },
  { mains: 8, mainFrac: 1.0,  branches: 10, branchFrac: 1.0,  thicken: true  },
];

function drawPathPrefix(data, pts, frac, alpha, thicken) {
  const n = Math.max(1, Math.ceil(pts.length * frac));
  for (let i = 0; i < n && i < pts.length; i++) {
    const p = pts[i];
    putPx(data, p.x, p.y, p.shade, alpha);
    if (thicken && (i & 1) === 0) {
      putPx(data, p.x + 1, p.y, Math.min(90, p.shade + 25), 235);
    }
  }
}

function putPx(data, x, y, shade, alpha) {
  if (x < 0 || y < 0 || x >= TEX_SIZE || y >= TEX_SIZE) return;
  const k = (y * TEX_SIZE + x) * 4;
  // Keep the darker of overlapping crack pixels.
  if (data[k + 3] > 0 && data[k] <= shade) return;
  data[k] = shade;
  data[k + 1] = shade;
  data[k + 2] = shade;
  data[k + 3] = alpha;
}

// Paints all CRACK_STAGES textures. Returns nulls in non-DOM (lint/parse)
// environments — never hit in the browser.
function buildStageTextures(seed) {
  const textures = new Array(CRACK_STAGES).fill(null);
  if (typeof document === 'undefined') return textures;
  const web = buildCrackWeb(mulberry32(seed));
  for (let s = 0; s < CRACK_STAGES; s++) {
    const plan = STAGE_PLAN[s];
    const cvs = document.createElement('canvas');
    cvs.width = cvs.height = TEX_SIZE;
    const g = cvs.getContext('2d');
    const img = g.createImageData(TEX_SIZE, TEX_SIZE);
    const d = img.data;
    for (let m = 0; m < plan.mains; m++) {
      drawPathPrefix(d, web.mains[m], plan.mainFrac, 255, plan.thicken);
    }
    for (let b = 0; b < plan.branches; b++) {
      drawPathPrefix(d, web.branches[b], plan.branchFrac, 245, false);
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cvs);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    textures[s] = tex;
  }
  return textures;
}

// Face table: outward normal + plane rotation (PlaneGeometry faces +Z).
const FACES = [
  { n: [1, 0, 0],  rot: [0, Math.PI / 2, 0] },
  { n: [-1, 0, 0], rot: [0, -Math.PI / 2, 0] },
  { n: [0, 1, 0],  rot: [-Math.PI / 2, 0, 0] },
  { n: [0, -1, 0], rot: [Math.PI / 2, 0, 0] },
  { n: [0, 0, 1],  rot: [0, 0, 0] },
  { n: [0, 0, -1], rot: [0, Math.PI, 0] },
];

export class BlockCracks {
  constructor(scene = null, {
    seed = 20117,
    maxSlots = 4,
    volume = null,       // optional worldgen Volume for exposed-face culling
    blend = 'multiply',  // 'multiply' (darkens the block, MC-like) | 'normal'
  } = {}) {
    this._enabled = true;
    this.volume = volume;
    this._blend = blend === 'normal' ? THREE.NormalBlending : THREE.MultiplyBlending;

    this.root = new THREE.Group();
    this.root.name = 'blockCracks';
    this.root.userData.noShadow = true; // ShadowController skips this subtree

    this.textures = buildStageTextures(seed);
    this._planeGeo = new THREE.PlaneGeometry(1, 1);

    this._slots = [];
    for (let i = 0; i < Math.max(1, maxSlots); i++) this._slots.push(this._makeSlot());

    // Fixed animation pool — entries recycled in place.
    this._anims = [];
    for (let i = 0; i < ANIM_CAP; i++) {
      this._anims.push({
        active: false, x: 0, y: 0, z: 0,
        t: 0, duration: 1.5, lastStage: -1,
        onComplete: null, order: 0,
      });
    }
    this._animCounter = 0;

    if (scene) scene.add(this.root);
  }

  get object3d() { return this.root; }
  get enabled() { return this._enabled; }

  _makeSlot() {
    const mat = new THREE.MeshBasicMaterial({
      map: this.textures[0] || null,
      transparent: true,
      alphaTest: 0.5,
      blending: this._blend,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      fog: true, // cracks dissolve with distance like the surface under them
    });
    const group = new THREE.Group();
    group.visible = false;
    const meshes = [];
    for (let i = 0; i < FACES.length; i++) {
      const f = FACES[i];
      const mesh = new THREE.Mesh(this._planeGeo, mat);
      mesh.position.set(
        f.n[0] * (0.5 + FACE_EPS),
        f.n[1] * (0.5 + FACE_EPS),
        f.n[2] * (0.5 + FACE_EPS)
      );
      mesh.rotation.set(f.rot[0], f.rot[1], f.rot[2]);
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false; // static within the group; group moves
      mesh.renderOrder = 2;          // after solid chunk + leaves
      mesh.userData.noShadow = true;
      group.add(mesh);
      meshes.push(mesh);
    }
    this.root.add(group);
    const slot = { group, mat, meshes, inUse: false, bx: 0, by: 0, bz: 0, stage: -1 };
    return slot;
  }

  _findSlot(x, y, z) {
    const slots = this._slots;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s.inUse && s.bx === x && s.by === y && s.bz === z) return s;
    }
    return null;
  }

  _acquireSlot() {
    const slots = this._slots;
    for (let i = 0; i < slots.length; i++) if (!slots[i].inUse) return slots[i];
    return slots[0]; // pool exhausted: steal the first (never hit in the demo)
  }

  setVolume(volume) { this.volume = volume; }

  // Overlay the stage decal on the voxel at integer coords. stage null/undefined
  // (or < 0) removes it. Stage is clamped to 0..CRACK_STAGES-1.
  showCrack(x, y, z, stage) {
    if (stage === null || stage === undefined || stage < 0) {
      this.clearCrack(x, y, z);
      return;
    }
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const s = Math.min(CRACK_STAGES - 1, Math.floor(stage));
    let slot = this._findSlot(xi, yi, zi);
    if (!slot) {
      slot = this._acquireSlot();
      slot.inUse = true;
      slot.bx = xi; slot.by = yi; slot.bz = zi;
      slot.stage = -1;
      slot.group.position.set(xi + 0.5, yi + 0.5, zi + 0.5);
      // Exposed-face pick: with a volume, hide quads buried against opaque
      // neighbours; without one, show all 6 (per spec, culling is optional).
      const vol = this.volume;
      for (let i = 0; i < FACES.length; i++) {
        const n = FACES[i].n;
        slot.meshes[i].visible =
          !vol || !vol.isOpaque(xi + n[0], yi + n[1], zi + n[2]);
      }
    }
    if (slot.stage !== s) {
      slot.stage = s;
      if (this.textures[s]) slot.mat.map = this.textures[s];
    }
    slot.group.visible = true;
  }

  clearCrack(x, y, z) {
    const slot = this._findSlot(Math.floor(x), Math.floor(y), Math.floor(z));
    if (!slot) return;
    slot.inUse = false;
    slot.stage = -1;
    slot.group.visible = false;
  }

  clearAll() {
    for (let i = 0; i < this._slots.length; i++) {
      const s = this._slots[i];
      s.inUse = false;
      s.stage = -1;
      s.group.visible = false;
    }
    for (let i = 0; i < this._anims.length; i++) {
      this._anims[i].active = false;
      this._anims[i].onComplete = null;
    }
  }

  // Step stages 0..4 over `duration` seconds, then clear the decal and call
  // onComplete(x, y, z). Re-calling on the same block restarts the animation.
  // Returns { cancel() } — cancel removes the decal without firing onComplete.
  animateBreak(x, y, z, { duration = 1.5, onComplete = null } = {}) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let a = null;
    for (let i = 0; i < this._anims.length; i++) {
      const e = this._anims[i];
      if (e.active && e.x === xi && e.y === yi && e.z === zi) { a = e; break; }
    }
    if (!a) {
      for (let i = 0; i < this._anims.length; i++) {
        if (!this._anims[i].active) { a = this._anims[i]; break; }
      }
    }
    if (!a) {
      // Pool exhausted: force-finish the oldest so its game logic still runs.
      a = this._anims[0];
      for (let i = 1; i < this._anims.length; i++) {
        if (this._anims[i].order < a.order) a = this._anims[i];
      }
      this._finishAnim(a);
    }
    a.active = true;
    a.x = xi; a.y = yi; a.z = zi;
    a.t = 0;
    a.duration = Math.max(0.05, duration);
    a.lastStage = 0;
    a.onComplete = onComplete;
    a.order = this._animCounter++;
    this.showCrack(xi, yi, zi, 0);
    return {
      cancel: () => {
        if (!a.active || a.x !== xi || a.y !== yi || a.z !== zi) return;
        a.active = false;
        a.onComplete = null;
        this.clearCrack(xi, yi, zi);
      },
    };
  }

  _finishAnim(a) {
    if (!a.active) return;
    a.active = false;
    this.clearCrack(a.x, a.y, a.z);
    const cb = a.onComplete;
    a.onComplete = null;
    if (cb) cb(a.x, a.y, a.z);
  }

  // Advances break animations. ctx unused (kept for the shared contract).
  update(dt, ctx) { // eslint-disable-line no-unused-vars
    if (!(dt > 0)) return;
    const anims = this._anims;
    for (let i = 0; i < anims.length; i++) {
      const a = anims[i];
      if (!a.active) continue;
      a.t += dt;
      if (a.t >= a.duration) {
        this._finishAnim(a); // clears decal + fires onComplete
        continue;
      }
      const stage = Math.min(
        CRACK_STAGES - 1,
        ((a.t / a.duration) * CRACK_STAGES) | 0
      );
      if (stage !== a.lastStage) {
        a.lastStage = stage;
        this.showCrack(a.x, a.y, a.z, stage);
      }
    }
  }

  // Hides the decals; animations keep ticking so onComplete still fires and
  // game logic (block removal, debris) stays consistent.
  setEnabled(on) {
    this._enabled = !!on;
    this.root.visible = this._enabled;
  }

  dispose() {
    for (let i = 0; i < this._anims.length; i++) {
      this._anims[i].active = false;
      this._anims[i].onComplete = null;
    }
    for (let i = 0; i < this._slots.length; i++) this._slots[i].mat.dispose();
    this._slots.length = 0;
    this._planeGeo.dispose();
    for (let i = 0; i < this.textures.length; i++) {
      if (this.textures[i]) this.textures[i].dispose();
    }
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}

export default BlockCracks;
