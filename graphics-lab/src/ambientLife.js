// graphics-lab/src/ambientLife.js
//
// AMBIENT LIFE — dimension-keyed ambient particle fields + optional leaf drift.
//
//   class AmbientLife(scene, { camera } = {})
//
// Three ambient fields, one per dimension, switched with setDimension(name)
// via a ~1s opacity crossfade (per-field uFade uniform — no per-particle work):
//
//   - 'warpwold'   : drifting pollen/dust motes. Sparse warm-gold soft dots,
//                    slow brownian drift, occasional sparkle twinkle, spawn
//                    biased toward the foliage height band. Normal blending
//                    (reads as sunlit dust, not light sources).
//   - 'cinderloom' : floating embers. Small orange-red glowing points rising
//                    with sinusoidal turbulence, per-particle flicker and a few
//                    brighter yellow-white sparks. ADDITIVE blending so bloom
//                    picks up the glow.
//   - 'nevermend'  : falling thread-wisps. Slender pale filaments (procedural
//                    thin soft streak texture) descending in slow spirals with
//                    a faint cyan-white shimmer.
//
// Optional leaf drift (setLeafDrift(bool)): a handful of tiny green square
// sprites tumbling down through the tree-canopy band. The band comes from
// setFoliageBand(yMin, yMax) or the setVolume(volume) heuristic (scan for
// leaf blocks, id 6).
//
// Architecture mirrors src/particles.js exactly: one THREE.Points per field
// backed by a fixed-capacity typed-array pool, zero per-frame allocation, a
// shared lean ShaderMaterial (attenuated + screen-capped gl_PointSize, soft
// procedural sprite, per-particle colour/size/alpha, per-particle rotation for
// the tumbling leaves) and camera-boxed toroidal wrapping (same scheme as the
// rain/snow systems) so every field works anywhere in the world.
//
// Draw calls: 1 Points per field, only drawn while its fade > 0. Steady state
// is 1 draw call (+1 with leaf drift on); during a crossfade, 2 fields overlap
// for ~1s. Live-point ceiling at density 1: max(700, 550, 400) + 64 = 764.
//
// Contract: update(dt, ctx) / setEnabled(bool) / get enabled() / dispose() /
// .object3d. ctx.weather === 'rain' smoothly thins the warpwold motes.

import * as THREE from 'three';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// GLSL-order smoothstep (THREE.MathUtils.smoothstep takes (x, min, max) —
// wrong argument order silently yields hard-edged square sprites).
const sstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const rand = Math.random;
const TAU = Math.PI * 2;
const FADE_SEC = 1.0;        // dimension crossfade time
const LEAF_FADE_SEC = 0.6;   // leaf-drift toggle fade

// --- Pool capacities (at density 1) ------------------------------------------
const MOTE_CAP  = 700;   // warpwold pollen/dust
const EMBER_CAP = 550;   // cinderloom embers
const WISP_CAP  = 400;   // nevermend thread-wisps
const LEAF_CAP  = 64;    // leaf drift ("a handful" — most stay culled by density)

// --- Shared point shader ------------------------------------------------------
// ShaderMaterial injects position/matrices/cameraPosition; we add per-particle
// colour / size / alpha / rotation and per-field fade + screen-size cap.
const VERT = /* glsl */ `
  attribute vec3  aColor;
  attribute float aSize;
  attribute float aAlpha;
  attribute float aRot;
  uniform float uScale;      // 0.5 * drawingBufferHeight (px) for attenuation
  uniform float uMaxSize;    // per-field screen-space cap (px)
  varying vec3  vColor;
  varying float vAlpha;
  varying float vRot;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vRot   = aRot;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float sz = aSize * (uScale / max(-mv.z, 0.001));
    gl_PointSize = clamp(sz, 0.0, uMaxSize);
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uFade;       // per-field crossfade opacity
  varying vec3  vColor;
  varying float vAlpha;
  varying float vRot;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float s = sin(vRot);
    float c = cos(vRot);
    uv = mat2(c, -s, s, c) * uv + 0.5;
    vec4 tex = texture2D(uMap, uv);
    float a = tex.a * vAlpha * uFade;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * tex.rgb, a);
  }
`;

// --- Procedural sprite textures ----------------------------------------------
// White RGB + shaped alpha (colour comes from the per-particle attribute).
// Same canvas technique as src/particles.js.
function makeSpriteTexture(size, shape) {
  const cvs = (typeof document !== 'undefined')
    ? document.createElement('canvas')
    : null;
  // Guard for non-DOM (parse/lint) environments — never hit in the browser.
  if (!cvs) return null;
  cvs.width = cvs.height = size;
  const g = cvs.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const h = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x - h) / h;   // -1..1
      const ny = (y - h) / h;
      let a = 0;
      if (shape === 'dot') {
        // Soft round dot — pollen motes and ember cores.
        const r = Math.hypot(nx, ny);
        a = 1 - sstep(0.0, 1.0, r);
        a *= a;
      } else if (shape === 'glow') {
        // Hot round core + wide faint halo — additive embers feed bloom.
        const r = Math.hypot(nx, ny);
        const core = 1 - sstep(0.0, 0.42, r);
        const halo = (1 - sstep(0.1, 1.0, r)) * 0.35;
        a = Math.min(1, core + halo * halo * 4.0);
      } else if (shape === 'filament') {
        // Slender vertical thread — soft across its width, long tapered body
        // with a faint mid-thread brightness pulse so it reads as a strand.
        const wx = 1 - sstep(0.015, 0.09, Math.abs(nx));  // very thin core
        const wy = 1 - sstep(0.60, 0.99, Math.abs(ny));   // long, faded tips
        const pulse = 0.8 + 0.2 * Math.cos(ny * Math.PI); // brighter middle
        a = wx * wy * pulse;
      } else {
        // 'chip' — tiny rounded square, soft-edged (tumbling leaves).
        const cheb = Math.max(Math.abs(nx), Math.abs(ny));
        a = 1 - sstep(0.52, 0.95, cheb);
      }
      const i = (y * size + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = Math.round(255 * clamp01(a));
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cvs);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

const FIELD_NAMES = ['warpwold', 'cinderloom', 'nevermend'];

// ===========================================================================
export class AmbientLife {
  constructor(scene, { camera = null } = {}) {
    this._scene = scene || null;
    this._camera = camera || null;
    this._enabled = true;
    this._elapsed = 0;
    this._density = 1;

    // Foliage/canopy band (world Y) — mote bias + leaf spawn heights.
    // Default matches the demo chunk's tree canopies (hills top out ~y14-20).
    this._bandMin = 13;
    this._bandMax = 21;

    // Rain smoothly thins the warpwold motes (ctx.weather driven).
    this._rainMul = 1;

    // Scratch objects — reused, never reallocated.
    this._v2 = new THREE.Vector2();
    this._camPos = new THREE.Vector3();

    this.object3d = new THREE.Group();
    this.object3d.name = 'AmbientLife';

    // --- Textures ---
    this._texDot      = makeSpriteTexture(64, 'dot');
    this._texGlow     = makeSpriteTexture(64, 'glow');
    this._texFilament = makeSpriteTexture(64, 'filament');
    this._texChip     = makeSpriteTexture(32, 'chip');
    this._textures = [this._texDot, this._texGlow, this._texFilament, this._texChip];

    // --- Materials (one per field; shared shader; per-field caps/blending) ---
    this._mats = [];
    const mat = (map, blending, maxSize) => {
      const m = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: map },
          uScale: { value: 400 },
          uMaxSize: { value: maxSize },
          uFade: { value: 0 },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        blending,
        fog: false,
      });
      this._mats.push(m);
      return m;
    };
    this._moteMat  = mat(this._texDot,      THREE.NormalBlending,   14);
    this._emberMat = mat(this._texGlow,     THREE.AdditiveBlending, 30);
    this._wispMat  = mat(this._texFilament, THREE.NormalBlending,   52);
    this._leafMat  = mat(this._texChip,     THREE.NormalBlending,   12);

    // --- Pools -------------------------------------------------------------
    this._mote  = this._makePool(MOTE_CAP,  this._moteMat,  'WarpwoldMotes');
    this._ember = this._makePool(EMBER_CAP, this._emberMat, 'CinderloomEmbers');
    this._wisp  = this._makePool(WISP_CAP,  this._wispMat,  'NevermendWisps');
    this._leaf  = this._makePool(LEAF_CAP,  this._leafMat,  'LeafDrift');

    // Per-particle simulation state (kept off the GPU buffers).
    // Motes: brownian velocity + twinkle phase/frequency + base alpha/size.
    this._moteVX = new Float32Array(MOTE_CAP);
    this._moteVY = new Float32Array(MOTE_CAP);
    this._moteVZ = new Float32Array(MOTE_CAP);
    this._motePh = new Float32Array(MOTE_CAP);
    this._moteTf = new Float32Array(MOTE_CAP);
    this._moteA0 = new Float32Array(MOTE_CAP);
    this._moteS0 = new Float32Array(MOTE_CAP);
    // Embers: rise speed, turbulence phase/freq/amp, flicker freq, spark flag.
    this._emberVY = new Float32Array(EMBER_CAP);
    this._emberPh = new Float32Array(EMBER_CAP);
    this._emberTf = new Float32Array(EMBER_CAP);
    this._emberTa = new Float32Array(EMBER_CAP);
    this._emberFf = new Float32Array(EMBER_CAP);
    this._emberSp = new Uint8Array(EMBER_CAP);      // 1 = bright spark
    // Wisps: fall speed, spiral phase/freq/radius-speed, shimmer phase/freq.
    this._wispVY = new Float32Array(WISP_CAP);
    this._wispPh = new Float32Array(WISP_CAP);
    this._wispRf = new Float32Array(WISP_CAP);
    this._wispRs = new Float32Array(WISP_CAP);
    this._wispSh = new Float32Array(WISP_CAP);
    this._wispSf = new Float32Array(WISP_CAP);
    // Leaves: fall speed, sway phase/freq/amp, spin rate.
    this._leafVY = new Float32Array(LEAF_CAP);
    this._leafPh = new Float32Array(LEAF_CAP);
    this._leafSf = new Float32Array(LEAF_CAP);
    this._leafSa = new Float32Array(LEAF_CAP);
    this._leafRv = new Float32Array(LEAF_CAP);

    this._initStatic();

    // Camera-centred wrap boxes (same scheme as the rain/snow systems).
    this._moteBox  = { hx: 22, hy: 13, hz: 22 };
    this._emberBox = { hx: 20, hy: 14, hz: 20 };
    this._wispBox  = { hx: 20, hy: 15, hz: 20 };
    this._leafBox  = { hx: 16, hy: 12, hz: 16 };   // hy unused for leaf Y (band)

    // Field bookkeeping: fade 0..1, fade target, first-seed flag.
    this._fields = {
      warpwold:   { pool: this._mote,  mat: this._moteMat,  box: this._moteBox,  fade: 0, target: 0, seeded: false, cap: MOTE_CAP },
      cinderloom: { pool: this._ember, mat: this._emberMat, box: this._emberBox, fade: 0, target: 0, seeded: false, cap: EMBER_CAP },
      nevermend:  { pool: this._wisp,  mat: this._wispMat,  box: this._wispBox,  fade: 0, target: 0, seeded: false, cap: WISP_CAP },
    };
    this._dimension = null;

    this._leafOn = false;
    this._leafFade = 0;
    this._leafSeeded = false;

    // Everything starts hidden until setDimension()/setLeafDrift() enable it.
    this._mote.pts.visible = false;
    this._ember.pts.visible = false;
    this._wisp.pts.visible = false;
    this._leaf.pts.visible = false;

    this.object3d.add(this._mote.pts, this._ember.pts, this._wisp.pts, this._leaf.pts);
    if (this._scene) this._scene.add(this.object3d);
  }

  // ---- pool allocation (identical layout to src/particles.js) --------------
  _makePool(cap, material, name) {
    const geo = new THREE.BufferGeometry();
    const pos   = new Float32Array(cap * 3);
    const color = new Float32Array(cap * 3);
    const size  = new Float32Array(cap);
    const alpha = new Float32Array(cap);
    const rot   = new Float32Array(cap);
    const pa = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const ca = new THREE.BufferAttribute(color, 3).setUsage(THREE.DynamicDrawUsage);
    const sa = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
    const aa = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
    const ra = new THREE.BufferAttribute(rot, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pa);
    geo.setAttribute('aColor', ca);
    geo.setAttribute('aSize', sa);
    geo.setAttribute('aAlpha', aa);
    geo.setAttribute('aRot', ra);
    geo.setDrawRange(0, 0);
    const pts = new THREE.Points(geo, material);
    pts.name = name;
    pts.frustumCulled = false;     // pools recentre on the camera
    pts.renderOrder = 19;          // just before Particles (20), after terrain
    return { geo, pts, pos, color, size, alpha, rot, pa, ca, sa, aa, ra, cap };
  }

  // Static per-particle parameters + colours (positions seed on activation).
  _initStatic() {
    const m = this._mote;
    for (let i = 0; i < MOTE_CAP; i++) {
      const i3 = i * 3;
      // Warm gold with slight per-particle variation.
      const j = 0.85 + rand() * 0.15;
      m.color[i3]     = 1.00 * j;
      m.color[i3 + 1] = (0.82 + rand() * 0.08) * j;
      m.color[i3 + 2] = (0.45 + rand() * 0.15) * j;
      this._moteS0[i] = 0.22 + rand() * 0.20;
      this._moteA0[i] = 0.38 + rand() * 0.28;
      m.size[i]  = this._moteS0[i];
      m.alpha[i] = this._moteA0[i];
      this._moteVX[i] = (rand() - 0.5) * 0.3;
      this._moteVY[i] = (rand() - 0.5) * 0.2;
      this._moteVZ[i] = (rand() - 0.5) * 0.3;
      this._motePh[i] = rand() * TAU;
      this._moteTf[i] = 0.25 + rand() * 0.5;    // sparkles every few seconds
    }

    const e = this._ember;
    for (let i = 0; i < EMBER_CAP; i++) {
      const i3 = i * 3;
      const spark = rand() < 0.08 ? 1 : 0;
      this._emberSp[i] = spark;
      if (spark) {
        // Occasional brighter yellow-white spark.
        e.color[i3] = 1.0; e.color[i3 + 1] = 0.78; e.color[i3 + 2] = 0.38;
        e.size[i] = 0.42 + rand() * 0.18;
      } else {
        // Orange-red ember body (additive — bloom catches these).
        const t = rand();
        e.color[i3]     = 0.95 + t * 0.05;
        e.color[i3 + 1] = 0.22 + t * 0.24;
        e.color[i3 + 2] = 0.03 + t * 0.06;
        e.size[i] = 0.24 + rand() * 0.18;
      }
      e.alpha[i] = 0.8;
      this._emberVY[i] = 0.7 + rand() * 1.3;
      this._emberPh[i] = rand() * TAU;
      this._emberTf[i] = 0.4 + rand() * 1.1;    // turbulence frequency
      this._emberTa[i] = 0.25 + rand() * 0.65;  // turbulence amplitude
      this._emberFf[i] = 5.0 + rand() * 7.0;    // flicker frequency
    }

    const w = this._wisp;
    for (let i = 0; i < WISP_CAP; i++) {
      const i3 = i * 3;
      // Pale cyan-white filament.
      const t = rand() * 0.15;
      w.color[i3]     = 0.72 + t;
      w.color[i3 + 1] = 0.88 + t * 0.6;
      w.color[i3 + 2] = 0.95 + t * 0.3;
      w.size[i]  = 1.5 + rand() * 1.3;          // filament length (world units)
      w.alpha[i] = 0.45;
      this._wispVY[i] = 0.45 + rand() * 0.55;   // slow descent
      this._wispPh[i] = rand() * TAU;
      this._wispRf[i] = 0.35 + rand() * 0.55;   // spiral angular frequency
      this._wispRs[i] = 0.5 + rand() * 0.9;     // spiral tangential speed
      this._wispSh[i] = rand() * TAU;
      this._wispSf[i] = 0.8 + rand() * 1.6;     // shimmer frequency
    }

    const l = this._leaf;
    for (let i = 0; i < LEAF_CAP; i++) {
      const i3 = i * 3;
      // Green leaf shades (matches the leaves block palette family).
      const t = rand();
      l.color[i3]     = 0.16 + t * 0.14;
      l.color[i3 + 1] = 0.42 + t * 0.25;
      l.color[i3 + 2] = 0.10 + t * 0.10;
      l.size[i]  = 0.16 + rand() * 0.12;
      l.alpha[i] = 0.95;
      l.rot[i]   = rand() * TAU;
      this._leafVY[i] = 0.5 + rand() * 0.6;
      this._leafPh[i] = rand() * TAU;
      this._leafSf[i] = 0.7 + rand() * 1.2;
      this._leafSa[i] = 0.5 + rand() * 0.8;
      this._leafRv[i] = (rand() - 0.5) * 7.0;   // tumble rate (rad/s)
    }

    for (const p of [this._mote, this._ember, this._wisp, this._leaf]) {
      p.ca.needsUpdate = p.sa.needsUpdate = p.aa.needsUpdate = p.ra.needsUpdate = true;
    }
  }

  get enabled() { return this._enabled; }

  // ==== Public API ==========================================================

  // Switch the ambient field with a ~1s crossfade. Unknown names fade all out.
  setDimension(name) {
    if (name === this._dimension) return;
    this._dimension = FIELD_NAMES.includes(name) ? name : null;
    for (const key of FIELD_NAMES) {
      const f = this._fields[key];
      f.target = (key === this._dimension) ? 1 : 0;
      // (Re)seed a field that was fully invisible so it appears around the
      // camera's *current* position rather than wherever it last wrapped.
      if (f.target === 1 && f.fade === 0) f.seeded = false;
    }
  }

  // Toggle the tumbling-leaf sprinkles near canopy height.
  setLeafDrift(on) {
    on = !!on;
    if (on === this._leafOn) return;
    this._leafOn = on;
    if (on && this._leafFade === 0) this._leafSeeded = false;
  }

  // Explicit canopy band (world Y). Motes densify here; leaves fall through it.
  setFoliageBand(yMin, yMax) {
    if (typeof yMin === 'number' && typeof yMax === 'number' && yMax > yMin) {
      this._bandMin = yMin;
      this._bandMax = yMax;
    }
  }

  // Heuristic band from a worldgen Volume: min/max Y of leaf blocks (id 6),
  // padded by a block either side. Falls back to the default band.
  setVolume(volume) {
    if (!volume) return;
    let lo = Infinity, hi = -Infinity;
    if (Array.isArray(volume.blocks)) {
      for (const b of volume.blocks) {
        if (b.id === 6) { if (b.y < lo) lo = b.y; if (b.y > hi) hi = b.y; }
      }
    } else if (typeof volume.get === 'function' && volume.sx) {
      for (let y = 0; y < volume.sy; y++) {
        for (let z = 0; z < volume.sz; z++) {
          for (let x = 0; x < volume.sx; x++) {
            if (volume.get(x, y, z) === 6) { if (y < lo) lo = y; if (y > hi) hi = y; }
          }
        }
      }
    }
    if (hi >= lo) this.setFoliageBand(lo - 1, hi + 1.5);
  }

  // Quality-driven particle budget, 0..1 (demo maps its presets onto this).
  setDensity(d) {
    this._density = clamp01(typeof d === 'number' ? d : 1);
  }

  setEnabled(on) {
    this._enabled = !!on;
    this.object3d.visible = this._enabled;
  }

  update(dt, ctx) {
    if (!this._enabled) return;
    dt = Math.min(dt || 0, 0.05);
    const elapsed = (ctx && typeof ctx.elapsed === 'number')
      ? ctx.elapsed : (this._elapsed + dt);
    this._elapsed = elapsed;

    // Attenuation scale from the live framebuffer height.
    if (ctx && ctx.renderer && ctx.renderer.getDrawingBufferSize) {
      ctx.renderer.getDrawingBufferSize(this._v2);
      const s = 0.5 * this._v2.y;
      if (s > 0) for (let i = 0; i < this._mats.length; i++) {
        this._mats[i].uniforms.uScale.value = s;
      }
    }

    const cam = this._resolveCamPos((ctx && ctx.camera) || this._camera);

    // Rain thins the pollen motes (smoothly, ~1.5s ramp).
    const raining = !!(ctx && ctx.weather === 'rain');
    const rainTarget = raining ? 0.25 : 1;
    const k = Math.min(1, dt / 1.5);
    this._rainMul += (rainTarget - this._rainMul) * k;
    if (Math.abs(this._rainMul - rainTarget) < 0.01) this._rainMul = rainTarget;

    // Crossfade bookkeeping + visibility.
    const step = dt / FADE_SEC;
    for (const key of FIELD_NAMES) {
      const f = this._fields[key];
      if (f.fade < f.target) f.fade = Math.min(f.target, f.fade + step);
      else if (f.fade > f.target) f.fade = Math.max(f.target, f.fade - step);
      f.mat.uniforms.uFade.value = f.fade;
      f.pool.pts.visible = f.fade > 0;
    }
    const lstep = dt / LEAF_FADE_SEC;
    const ltarget = this._leafOn ? 1 : 0;
    if (this._leafFade < ltarget) this._leafFade = Math.min(ltarget, this._leafFade + lstep);
    else if (this._leafFade > ltarget) this._leafFade = Math.max(ltarget, this._leafFade - lstep);
    this._leafMat.uniforms.uFade.value = this._leafFade;
    this._leaf.pts.visible = this._leafFade > 0;

    if (!cam) return;   // no camera yet — nothing sensible to simulate

    if (this._fields.warpwold.fade > 0)   this._updateMotes(dt, elapsed, cam);
    if (this._fields.cinderloom.fade > 0) this._updateEmbers(dt, elapsed, cam);
    if (this._fields.nevermend.fade > 0)  this._updateWisps(dt, elapsed, cam);
    if (this._leafFade > 0)               this._updateLeaves(dt, elapsed, cam);
  }

  dispose() {
    if (this.object3d.parent) this.object3d.parent.remove(this.object3d);
    for (const p of [this._mote, this._ember, this._wisp, this._leaf]) p.geo.dispose();
    for (const m of this._mats) m.dispose();
    for (const t of this._textures) if (t) t.dispose();
  }

  // ==== Internals ===========================================================

  _resolveCamPos(cam) {
    if (!cam) return null;
    const out = this._camPos;
    if (typeof cam.getWorldPosition === 'function') { cam.getWorldPosition(out); return out; }
    const src = cam.position || cam;
    if (typeof src.x !== 'number') return null;
    out.set(src.x, src.y, src.z);
    return out;
  }

  // Spawn Y for a mote: bias ~55% of respawns into the foliage band when it
  // overlaps the camera box, otherwise uniform in the box.
  _moteY(cam, box) {
    const lo = cam.y - box.hy, hi = cam.y + box.hy;
    const bLo = Math.max(lo, this._bandMin), bHi = Math.min(hi, this._bandMax);
    if (bHi > bLo && rand() < 0.55) return bLo + rand() * (bHi - bLo);
    return lo + rand() * (hi - lo);
  }

  _seed(pool, n, box, cam, yFn) {
    for (let i = 0; i < pool.cap; i++) {
      const i3 = i * 3;
      pool.pos[i3]     = cam.x + (rand() * 2 - 1) * box.hx;
      pool.pos[i3 + 1] = yFn ? yFn(cam, box) : cam.y + (rand() * 2 - 1) * box.hy;
      pool.pos[i3 + 2] = cam.z + (rand() * 2 - 1) * box.hz;
    }
    pool.pa.needsUpdate = true;
  }

  // Toroidal X/Z wrap into the camera box (same as the rain/snow systems).
  _wrapXZ(pos, i3, cam, box) {
    const dx = pos[i3] - cam.x;
    if (dx > box.hx) pos[i3] -= box.hx * 2;
    else if (dx < -box.hx) pos[i3] += box.hx * 2;
    const dz = pos[i3 + 2] - cam.z;
    if (dz > box.hz) pos[i3 + 2] -= box.hz * 2;
    else if (dz < -box.hz) pos[i3 + 2] += box.hz * 2;
  }

  // --- warpwold: pollen/dust motes -----------------------------------------
  _updateMotes(dt, elapsed, cam) {
    const p = this._mote, box = this._moteBox;
    const f = this._fields.warpwold;
    if (!f.seeded) { this._seed(p, MOTE_CAP, box, cam, (c, b) => this._moteY(c, b)); f.seeded = true; }
    const active = Math.round(MOTE_CAP * this._density * this._rainMul);
    p.geo.setDrawRange(0, active);
    if (active === 0) return;
    const jolt = 0.55 * dt;   // brownian acceleration
    const damp = Math.max(0, 1 - 0.4 * dt);
    for (let i = 0; i < active; i++) {
      const i3 = i * 3;
      // Brownian random walk, damped, with a whisper of upward lift so the
      // cloud hovers instead of settling.
      this._moteVX[i] = this._moteVX[i] * damp + (rand() - 0.5) * jolt;
      this._moteVY[i] = this._moteVY[i] * damp + (rand() - 0.5) * jolt + 0.01 * dt;
      this._moteVZ[i] = this._moteVZ[i] * damp + (rand() - 0.5) * jolt;
      p.pos[i3]     += this._moteVX[i] * dt;
      p.pos[i3 + 1] += this._moteVY[i] * dt;
      p.pos[i3 + 2] += this._moteVZ[i] * dt;
      this._wrapXZ(p.pos, i3, cam, box);
      const dy = p.pos[i3 + 1] - cam.y;
      if (dy > box.hy || dy < -box.hy) {
        p.pos[i3]     = cam.x + (rand() * 2 - 1) * box.hx;
        p.pos[i3 + 1] = this._moteY(cam, box);
        p.pos[i3 + 2] = cam.z + (rand() * 2 - 1) * box.hz;
      }
      // Occasional sparkle twinkle: sharp spike on a slow per-particle sine.
      const tw = Math.sin(elapsed * this._moteTf[i] * TAU * 0.25 + this._motePh[i]);
      let spike = tw > 0.92 ? (tw - 0.92) / 0.08 : 0;
      spike *= spike;
      p.alpha[i] = Math.min(1, this._moteA0[i] * (0.8 + 0.2 * tw) + spike * 0.85);
      p.size[i]  = this._moteS0[i] * (1 + spike * 0.9);
    }
    p.pa.needsUpdate = p.aa.needsUpdate = p.sa.needsUpdate = true;
  }

  // --- cinderloom: rising embers --------------------------------------------
  _updateEmbers(dt, elapsed, cam) {
    const p = this._ember, box = this._emberBox;
    const f = this._fields.cinderloom;
    if (!f.seeded) { this._seed(p, EMBER_CAP, box, cam); f.seeded = true; }
    const active = Math.round(EMBER_CAP * this._density);
    p.geo.setDrawRange(0, active);
    if (active === 0) return;
    for (let i = 0; i < active; i++) {
      const i3 = i * 3;
      const ph = elapsed * this._emberTf[i] + this._emberPh[i];
      // Rise with meandering turbulence.
      p.pos[i3]     += Math.sin(ph) * this._emberTa[i] * dt;
      p.pos[i3 + 1] += this._emberVY[i] * dt;
      p.pos[i3 + 2] += Math.cos(ph * 0.83) * this._emberTa[i] * 0.8 * dt;
      this._wrapXZ(p.pos, i3, cam, box);
      const dy = p.pos[i3 + 1] - cam.y;
      if (dy > box.hy) {
        // Recycle risen embers to the bottom of the box at a fresh column.
        p.pos[i3]     = cam.x + (rand() * 2 - 1) * box.hx;
        p.pos[i3 + 1] = cam.y - box.hy + rand() * 2.0;
        p.pos[i3 + 2] = cam.z + (rand() * 2 - 1) * box.hz;
      } else if (dy < -box.hy) {
        p.pos[i3 + 1] += box.hy * 2;
      }
      // Flicker (sparks flicker harder and brighter).
      const fl = Math.sin(elapsed * this._emberFf[i] + this._emberPh[i] * 3.0);
      p.alpha[i] = this._emberSp[i]
        ? clamp01(0.85 + 0.15 * fl)
        : clamp01(0.65 + 0.3 * fl);
    }
    p.pa.needsUpdate = p.aa.needsUpdate = true;
  }

  // --- nevermend: falling thread-wisps ---------------------------------------
  _updateWisps(dt, elapsed, cam) {
    const p = this._wisp, box = this._wispBox;
    const f = this._fields.nevermend;
    if (!f.seeded) { this._seed(p, WISP_CAP, box, cam); f.seeded = true; }
    const active = Math.round(WISP_CAP * this._density);
    p.geo.setDrawRange(0, active);
    if (active === 0) return;
    for (let i = 0; i < active; i++) {
      const i3 = i * 3;
      const ph = elapsed * this._wispRf[i] * TAU * 0.25 + this._wispPh[i];
      // Slow spiral descent: tangential drift orbits while Y sinks.
      p.pos[i3]     += Math.cos(ph) * this._wispRs[i] * dt;
      p.pos[i3 + 1] -= this._wispVY[i] * dt;
      p.pos[i3 + 2] += Math.sin(ph) * this._wispRs[i] * dt;
      this._wrapXZ(p.pos, i3, cam, box);
      const dy = p.pos[i3 + 1] - cam.y;
      if (dy < -box.hy) {
        p.pos[i3]     = cam.x + (rand() * 2 - 1) * box.hx;
        p.pos[i3 + 1] = cam.y + box.hy - rand() * 2.0;
        p.pos[i3 + 2] = cam.z + (rand() * 2 - 1) * box.hz;
      } else if (dy > box.hy) {
        p.pos[i3 + 1] -= box.hy * 2;
      }
      // Faint shimmer.
      const sh = Math.sin(elapsed * this._wispSf[i] + this._wispSh[i]);
      p.alpha[i] = 0.34 + 0.20 * sh;
    }
    p.pa.needsUpdate = p.aa.needsUpdate = true;
  }

  // --- leaf drift -------------------------------------------------------------
  _updateLeaves(dt, elapsed, cam) {
    const p = this._leaf, box = this._leafBox;
    const bandLo = this._bandMin - 4;   // fall a little below the canopy
    const bandHi = this._bandMax;
    if (!this._leafSeeded) {
      for (let i = 0; i < LEAF_CAP; i++) {
        const i3 = i * 3;
        p.pos[i3]     = cam.x + (rand() * 2 - 1) * box.hx;
        p.pos[i3 + 1] = bandLo + rand() * (bandHi - bandLo);
        p.pos[i3 + 2] = cam.z + (rand() * 2 - 1) * box.hz;
      }
      p.pa.needsUpdate = true;
      this._leafSeeded = true;
    }
    // "A handful": 12 at low density up to the full 64.
    const active = Math.max(12, Math.round(LEAF_CAP * this._density));
    p.geo.setDrawRange(0, active);
    for (let i = 0; i < active; i++) {
      const i3 = i * 3;
      const ph = elapsed * this._leafSf[i] + this._leafPh[i];
      // Falling-leaf sway + tumble.
      p.pos[i3]     += Math.sin(ph) * this._leafSa[i] * dt;
      p.pos[i3 + 1] -= this._leafVY[i] * (0.8 + 0.25 * Math.cos(ph * 1.7)) * dt;
      p.pos[i3 + 2] += Math.cos(ph * 0.9) * this._leafSa[i] * 0.7 * dt;
      p.rot[i] += this._leafRv[i] * dt;
      this._wrapXZ(p.pos, i3, cam, box);
      if (p.pos[i3 + 1] < bandLo) {
        // Respawn at canopy height, fresh column.
        p.pos[i3]     = cam.x + (rand() * 2 - 1) * box.hx;
        p.pos[i3 + 1] = bandHi - rand() * 1.5;
        p.pos[i3 + 2] = cam.z + (rand() * 2 - 1) * box.hz;
      }
    }
    p.pa.needsUpdate = p.ra.needsUpdate = true;
  }
}

export default AmbientLife;
