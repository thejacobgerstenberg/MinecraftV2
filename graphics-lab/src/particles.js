// graphics-lab/src/particles.js
//
// PARTICLE SYSTEMS — one umbrella class managing several pooled emitters.
//
//   class Particles(scene, { camera } = {})
//
// All emitters are THREE.Points backed by FIXED-CAPACITY typed-array pools that
// are recycled in place — there is ZERO per-frame allocation and no GC churn.
// Every emitter shares one lean point ShaderMaterial variant:
//   * vertex:   world-attenuated gl_PointSize (matches PointsMaterial's model),
//               per-particle colour / size / alpha attributes.
//   * fragment: samples a small procedurally-generated soft sprite, multiplies
//               by the per-particle colour+alpha, discards fully-transparent
//               fragments (clean depth on the normal-blended systems).
//
// Sub-systems (see the class members):
//   - blockBreak : on-demand burst of ~12-20 cube-ish debris points that fly out
//                  with gravity and fade over ~0.8s. Ring-buffer pool.
//   - torchFlame : per-registered-torch warm ADDITIVE flame points (rising +
//                  flickering) + a few faint grey smoke points drifting up and
//                  fading. Continuously respawned in place.
//   - rain       : fast blue-grey streak points falling inside a box that stays
//                  centred on the camera; recycled/wrapped with slight wind.
//   - snow       : slower white flakes with a sinusoidal sway, recycled the same
//                  way. Rain and snow are mutually exclusive (weather state).
//   - splash     : tiny expanding rings at the water surface while raining.
//
// Every material carries a per-emitter SCREEN-SPACE size cap (uMaxSize) so a
// near-camera particle can never balloon into a giant quad: rain <= 24px,
// snow <= 12px, splash <= 20px, debris <= 28px, flame <= 80px (kept larger on
// purpose so bloom picks up the halo at night).
//
// Blending: ADDITIVE for the flame (glow), NORMAL for smoke / rain / snow /
// debris / splash. Total live points are kept well under ~4500 (see the
// capacity table in the constructor). Follows the graphics-lab effect contract:
//   update(dt, ctx) / setEnabled(bool) / get enabled() / dispose() / .object3d.

import * as THREE from 'three';

const { clamp } = THREE.MathUtils;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// GLSL-order smoothstep(edge0, edge1, x). NOTE: THREE.MathUtils.smoothstep
// takes (x, min, max) — using it with GLSL argument order silently returns 0
// and turns every sprite into a hard-edged solid square. Never use it here.
const sstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const rand = Math.random;
const TAU = Math.PI * 2;

// --- Pool capacities ---------------------------------------------------------
// Live-point ceiling ≈ max(RAIN + SPLASH, SNOW) + flame + smoke + debris. With
// a full torch set: 2000 + 200 + 48*12 + 48*5 + 360 ≈ 3376 (< 4500). Typical
// torch counts are far lower, and inactive weather is not drawn
// (Points.visible = false).
const MAX_TORCHES = 48;
const FLAME_PER   = 12;   // flame points per torch
const SMOKE_PER   = 5;    // smoke points per torch
const BB_CAP      = 360;  // block-break debris ring buffer
const RAIN_CAP    = 2000; // streaks at intensity 1
const SNOW_CAP    = 1400; // flakes at intensity 1
const SPLASH_CAP  = 200;  // rain splash rings at the water surface

// --- Shared point shader -----------------------------------------------------
// ShaderMaterial auto-injects `position`, the standard matrices and
// `cameraPosition`, so we only declare our own per-particle attributes.
const VERT = /* glsl */ `
  attribute vec3  aColor;
  attribute float aSize;
  attribute float aAlpha;
  uniform float uScale;          // 0.5 * drawingBufferHeight (px), for attenuation
  uniform float uMaxSize;        // per-emitter screen-space cap (px)
  varying vec3  vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // World-sized attenuation, mirroring three's sizeAttenuation model, but
    // hard-capped per emitter so a near-camera particle can never blow up
    // into a huge screen-filling quad (rain <= 24px, snow <= 12px, ...).
    float sz = aSize * (uScale / max(-mv.z, 0.001));
    gl_PointSize = clamp(sz, 0.0, uMaxSize);
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uRotation;       // rotate the sprite (streak tilt for rain)
  varying vec3  vColor;
  varying float vAlpha;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float s = sin(uRotation);
    float c = cos(uRotation);
    uv = mat2(c, -s, s, c) * uv + 0.5;
    vec4 tex = texture2D(uMap, uv);
    float a = tex.a * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * tex.rgb, a);
  }
`;

// --- Procedural sprite textures ---------------------------------------------
// White RGB + shaped alpha (the per-particle colour comes from the shader).
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
        // Round dot with a smooth radial falloff — snow / smoke / flame.
        const r = Math.hypot(nx, ny);
        a = 1 - sstep(0.0, 1.0, r);
        a *= a;                                  // soft round falloff
      } else if (shape === 'square') {
        // Rounded-square chip for block-break debris (still soft-edged).
        const cheb = Math.max(Math.abs(nx), Math.abs(ny));
        a = 1 - sstep(0.55, 1.0, cheb);
      } else if (shape === 'ring') {
        // Soft circle outline — rain splash rings on the water surface.
        const r = Math.hypot(nx, ny);
        a = 1 - sstep(0.0, 0.28, Math.abs(r - 0.62));
        a *= a;
      } else {
        // 'streak' — thin vertical line, ~1:10 core aspect, soft alpha both
        // across the width and toward the ends (velocity-aligned rain).
        const wx = 1 - sstep(0.02, 0.10, Math.abs(nx));   // ~0.12 half-width
        const wy = 1 - sstep(0.55, 0.98, Math.abs(ny));   // long, faded tips
        a = wx * wy;
      }
      const i = (y * size + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = Math.round(255 * clamp(a, 0, 1));
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cvs);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

// --- Arg normalisation -------------------------------------------------------
function readPos(p, out) {
  if (!p) { out.x = out.y = out.z = 0; return out; }
  if (Array.isArray(p)) { out.x = p[0] || 0; out.y = p[1] || 0; out.z = p[2] || 0; return out; }
  out.x = p.x || 0; out.y = p.y || 0; out.z = p.z || 0;
  return out;
}
// Block ids arrive as integer voxel coords → shift to the voxel centre.
const centreAxis = (v) => (Number.isInteger(v) ? v + 0.5 : v);

// ===========================================================================
export class Particles {
  constructor(scene, { camera = null, waterLevel = 10 } = {}) {
    this._scene = scene || null;
    this._camera = camera || null;
    this._enabled = true;
    this._elapsed = 0;

    // Water surface height for rain splash rings (worldgen WATER_LEVEL = 10).
    this._waterLevel = (typeof waterLevel === 'number') ? waterLevel : 10;

    // Weather state (driven by setWeather / synced from ctx.weather).
    this._weather = 'clear';
    this._intensity = 0.7;
    this._rainSeeded = false;
    this._snowSeeded = false;

    // Wind (also drives the rain streak tilt).
    this._windX = 5.0;
    this._windZ = 1.5;

    // Scratch objects — reused every frame, never reallocated.
    this._v2 = new THREE.Vector2();
    this._camPos = new THREE.Vector3();
    this._tmp = { x: 0, y: 0, z: 0 };

    this.object3d = new THREE.Group();
    this.object3d.name = 'Particles';

    // --- Textures (soft procedural sprites; white RGB + shaped alpha) ---
    this._texDot    = makeSpriteTexture(64, 'dot');
    this._texSquare = makeSpriteTexture(48, 'square');
    this._texStreak = makeSpriteTexture(64, 'streak');
    this._texRing   = makeSpriteTexture(64, 'ring');
    this._textures = [this._texDot, this._texSquare, this._texStreak, this._texRing];

    // --- Materials (one per emitter; shared shader; per-emitter px cap) ---
    this._mats = [];
    const mat = (map, blending, maxSize) => {
      const m = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: map },
          uScale: { value: 400 },
          uRotation: { value: 0 },
          uMaxSize: { value: maxSize },
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
    // Screen-space caps: weather sprites stay small even right at the camera;
    // the flame cap is generous on purpose so its additive halo feeds bloom.
    this._flameMat  = mat(this._texDot,    THREE.AdditiveBlending, 80);
    this._smokeMat  = mat(this._texDot,    THREE.NormalBlending,   56);
    this._bbMat     = mat(this._texSquare, THREE.NormalBlending,   28);
    this._rainMat   = mat(this._texStreak, THREE.NormalBlending,   24);
    this._snowMat   = mat(this._texDot,    THREE.NormalBlending,   12);
    this._splashMat = mat(this._texRing,   THREE.NormalBlending,   20);
    // Lean the rain streaks into the wind.
    this._rainMat.uniforms.uRotation.value = Math.atan2(this._windX, 30) * 0.7;

    // --- Emitter pools ---
    this._flame  = this._makePool(MAX_TORCHES * FLAME_PER, this._flameMat, 'FlameParticles');
    this._smoke  = this._makePool(MAX_TORCHES * SMOKE_PER, this._smokeMat, 'SmokeParticles');
    this._bb     = this._makePool(BB_CAP, this._bbMat, 'BlockBreakParticles');
    this._rain   = this._makePool(RAIN_CAP, this._rainMat, 'RainParticles');
    this._snow   = this._makePool(SNOW_CAP, this._snowMat, 'SnowParticles');
    this._splash = this._makePool(SPLASH_CAP, this._splashMat, 'SplashParticles');

    // Per-particle simulation state (velocity / life / sway). Kept out of the
    // GPU attribute buffers so uploads stay minimal.
    this._flameVel = this._vel(MAX_TORCHES * FLAME_PER);
    this._smokeVel = this._vel(MAX_TORCHES * SMOKE_PER);
    this._bbVel    = this._vel(BB_CAP);

    // Rain: per-particle fall speed. Snow: fall speed + sway params.
    this._rainFall = new Float32Array(RAIN_CAP);
    this._snowFall = new Float32Array(SNOW_CAP);
    this._snowAmp  = new Float32Array(SNOW_CAP);
    this._snowFreq = new Float32Array(SNOW_CAP);
    this._snowPhase = new Float32Array(SNOW_CAP);
    // Splash rings: life / max-life ring buffer (dead => alpha 0).
    this._splashLife = new Float32Array(SPLASH_CAP);
    this._splashMax  = new Float32Array(SPLASH_CAP);
    this._splashCursor = 0;
    this._splashAccum = 0;      // fractional spawns carried between frames
    this._splashWasLive = false;
    this._initWeatherParams();

    // Torch registry.
    this._torches = [];        // { x, y, z } emit origins (already centred)
    this._activeTorches = 0;

    // Block-break ring cursor.
    this._bbCursor = 0;

    // Box half-extents around the camera for the weather systems.
    this._rainBox = { hx: 26, hy: 22, hz: 26 };
    this._snowBox = { hx: 24, hy: 20, hz: 24 };

    // Debris starts fully idle (all dead → alpha/size 0, drawn but discarded).
    this._bb.geo.setDrawRange(0, BB_CAP);
    this._bb.aa.needsUpdate = true;
    this._bb.sa.needsUpdate = true;

    // Splash rings draw their whole ring buffer; dead entries are alpha 0.
    this._splash.geo.setDrawRange(0, SPLASH_CAP);
    this._splash.aa.needsUpdate = true;
    this._splash.sa.needsUpdate = true;

    // Weather begins hidden (weather 'clear'). Flame/smoke are always live.
    this._rain.pts.visible = false;
    this._snow.pts.visible = false;
    this._splash.pts.visible = false;
    this._setWeatherActive();

    // Assemble the group (order is cosmetic; all depth-tested, no depth write).
    this.object3d.add(this._flame.pts, this._smoke.pts, this._bb.pts,
                      this._rain.pts, this._snow.pts, this._splash.pts);
    if (this._scene) this._scene.add(this.object3d);
  }

  // ---- pool / state allocation helpers -------------------------------------
  _makePool(cap, material, name) {
    const geo = new THREE.BufferGeometry();
    const pos   = new Float32Array(cap * 3);
    const color = new Float32Array(cap * 3);
    const size  = new Float32Array(cap);
    const alpha = new Float32Array(cap);
    const pa = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const ca = new THREE.BufferAttribute(color, 3).setUsage(THREE.DynamicDrawUsage);
    const sa = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
    const aa = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pa);
    geo.setAttribute('aColor', ca);
    geo.setAttribute('aSize', sa);
    geo.setAttribute('aAlpha', aa);
    geo.setDrawRange(0, 0);
    const pts = new THREE.Points(geo, material);
    pts.name = name;
    pts.frustumCulled = false;   // pools recentre on the camera / span the chunk
    pts.renderOrder = 20;        // after opaque terrain + water
    return { geo, pts, pos, color, size, alpha, pa, ca, sa, aa, cap };
  }

  _vel(cap) {
    return {
      x: new Float32Array(cap),
      y: new Float32Array(cap),
      z: new Float32Array(cap),
      life: new Float32Array(cap),
      max: new Float32Array(cap),
    };
  }

  _initWeatherParams() {
    for (let i = 0; i < RAIN_CAP; i++) this._rainFall[i] = 28 + rand() * 16;
    for (let i = 0; i < SNOW_CAP; i++) {
      this._snowFall[i]  = 0.8 + rand() * 1.3;
      this._snowAmp[i]   = 0.3 + rand() * 0.6;
      this._snowFreq[i]  = 0.5 + rand() * 1.2;
      this._snowPhase[i] = rand() * TAU;
    }
    // Static per-particle colour / size / alpha for the weather sprites.
    // (Screen size is additionally capped by uMaxSize: rain 24px, snow 12px.)
    const r = this._rain, s = this._snow;
    for (let i = 0; i < RAIN_CAP; i++) {
      const i3 = i * 3;
      // Slight blue-grey tint, translucent.
      r.color[i3] = 0.64; r.color[i3 + 1] = 0.70; r.color[i3 + 2] = 0.84;
      r.size[i] = 0.7 + rand() * 0.6;   // streak length (world units)
      r.alpha[i] = 0.5;
    }
    for (let i = 0; i < SNOW_CAP; i++) {
      const i3 = i * 3;
      s.color[i3] = 1.0; s.color[i3 + 1] = 1.0; s.color[i3 + 2] = 1.0;
      s.size[i] = 0.2 + rand() * 0.18;
      s.alpha[i] = 0.85;
    }
    r.ca.needsUpdate = r.sa.needsUpdate = r.aa.needsUpdate = true;
    s.ca.needsUpdate = s.sa.needsUpdate = s.aa.needsUpdate = true;
  }

  get enabled() { return this._enabled; }

  // ==== Public API ==========================================================

  // Register a torch/glowstone light; grows the flame + smoke draw ranges.
  addTorch(pos) {
    if (this._torches.length >= MAX_TORCHES) return;
    const p = readPos(pos, {});
    const t = { x: centreAxis(p.x), y: centreAxis(p.y), z: centreAxis(p.z) };
    // Sit a touch above the block face, matching the demo's point-light offset.
    if (Number.isInteger(p.y)) t.y = p.y + 0.55;
    const ti = this._torches.length;
    this._torches.push(t);
    this._activeTorches = this._torches.length;

    // Prime this torch's particles with staggered ages so it lights up smoothly.
    for (let k = 0; k < FLAME_PER; k++) this._spawnFlame(ti * FLAME_PER + k, rand());
    for (let k = 0; k < SMOKE_PER; k++) this._spawnSmoke(ti * SMOKE_PER + k, rand());

    this._flame.geo.setDrawRange(0, this._activeTorches * FLAME_PER);
    this._smoke.geo.setDrawRange(0, this._activeTorches * SMOKE_PER);
  }

  // On-demand debris burst from a broken block. `color` is [r,g,b] in 0..1.
  spawnBlockBreak(pos, color) {
    const p = readPos(pos, this._tmp);
    const bx = centreAxis(p.x), by = centreAxis(p.y), bz = centreAxis(p.z);
    const cr = (color && color[0] != null) ? color[0] : 0.55;
    const cg = (color && color[1] != null) ? color[1] : 0.5;
    const cb = (color && color[2] != null) ? color[2] : 0.42;
    const n = 12 + (rand() * 9 | 0);     // 12-20 chips
    const bb = this._bb, v = this._bbVel;
    for (let k = 0; k < n; k++) {
      const i = this._bbCursor;
      this._bbCursor = (this._bbCursor + 1) % BB_CAP;
      const i3 = i * 3;
      bb.pos[i3]     = bx + (rand() - 0.5) * 0.5;
      bb.pos[i3 + 1] = by + (rand() - 0.5) * 0.5;
      bb.pos[i3 + 2] = bz + (rand() - 0.5) * 0.5;
      // Outward + upward spray.
      const ang = rand() * TAU;
      const spd = 1.8 + rand() * 3.4;
      v.x[i] = Math.cos(ang) * spd;
      v.y[i] = 2.2 + rand() * 3.2;
      v.z[i] = Math.sin(ang) * spd;
      const life = 0.6 + rand() * 0.3;   // ~0.8s
      v.life[i] = life; v.max[i] = life;
      const j = 0.75 + rand() * 0.4;     // brightness jitter
      bb.color[i3]     = clamp01(cr * j);
      bb.color[i3 + 1] = clamp01(cg * j);
      bb.color[i3 + 2] = clamp01(cb * j);
      bb.size[i]  = 0.1 + rand() * 0.08;
      bb.alpha[i] = 1.0;
    }
    bb.ca.needsUpdate = true;   // colours/sizes only change on spawn
    bb.sa.needsUpdate = true;
  }

  // 'clear' | 'rain' | 'snow', intensity 0..1.
  setWeather(mode, intensity = 0.7) {
    if (mode !== 'rain' && mode !== 'snow') mode = 'clear';
    this._weather = mode;
    this._intensity = clamp01(intensity);
    this._rainSeeded = false;   // reseed the active field around the camera
    this._snowSeeded = false;
    this._setWeatherActive();
  }

  // Height of the water surface (rain splash rings spawn just above it).
  // Pass null/undefined to disable splashes entirely.
  setWaterLevel(y) {
    this._waterLevel = (typeof y === 'number' && Number.isFinite(y)) ? y : null;
  }

  update(dt, ctx) {
    if (!this._enabled) return;
    dt = Math.min(dt || 0, 0.05);           // clamp after tab-out / hitches
    const elapsed = (ctx && typeof ctx.elapsed === 'number')
      ? ctx.elapsed : (this._elapsed + dt);
    this._elapsed = elapsed;

    // Sync weather from the shared ctx if the host drives it that way.
    if (ctx && typeof ctx.weather === 'string' && ctx.weather !== this._weather) {
      this.setWeather(ctx.weather, this._intensity);
    }

    // Point-size attenuation scale from the live framebuffer height.
    if (ctx && ctx.renderer && ctx.renderer.getDrawingBufferSize) {
      ctx.renderer.getDrawingBufferSize(this._v2);
      const s = 0.5 * this._v2.y;
      if (s > 0) for (let i = 0; i < this._mats.length; i++) {
        this._mats[i].uniforms.uScale.value = s;
      }
    }

    const camObj = (ctx && ctx.camera) || this._camera || null;
    const cam = this._resolveCamPos(camObj);

    this._updateBlockBreak(dt);
    this._updateFlame(dt, elapsed);
    this._updateSmoke(dt);
    if (this._weather === 'rain') {
      this._updateRain(dt, cam);
      this._updateSplash(dt, cam);
    } else if (this._weather === 'snow') {
      this._updateSnow(dt, elapsed, cam);
    }
  }

  setEnabled(on) {
    this._enabled = !!on;
    this.object3d.visible = this._enabled;
    if (this._enabled) this._setWeatherActive();
  }

  dispose() {
    if (this.object3d.parent) this.object3d.parent.remove(this.object3d);
    const pools = [this._flame, this._smoke, this._bb, this._rain, this._snow,
                   this._splash];
    for (const p of pools) p.geo.dispose();
    for (const m of this._mats) m.dispose();
    for (const t of this._textures) if (t) t.dispose();
  }

  // ==== Sub-system simulation ==============================================

  // Resolve a camera (THREE.Camera, possibly nested) — or a bare {x,y,z} — to a
  // world-space position in the reused scratch vector. Returns null if unusable.
  _resolveCamPos(cam) {
    if (!cam) return null;
    const out = this._camPos;
    if (typeof cam.getWorldPosition === 'function') { cam.getWorldPosition(out); return out; }
    const src = cam.position || cam;
    if (typeof src.x !== 'number') return null;
    out.set(src.x, src.y, src.z);
    return out;
  }

  _setWeatherActive() {
    const on = this._enabled;
    const rainOn = on && this._weather === 'rain';
    const snowOn = on && this._weather === 'snow';
    this._rain.pts.visible = rainOn;
    this._snow.pts.visible = snowOn;
    this._splash.pts.visible = rainOn && this._waterLevel != null;
    const rainN = Math.round(this._intensity * RAIN_CAP);
    const snowN = Math.round(this._intensity * SNOW_CAP);
    this._rainActive = rainOn ? rainN : 0;
    this._snowActive = snowOn ? snowN : 0;
    this._rain.geo.setDrawRange(0, this._rainActive);
    this._snow.geo.setDrawRange(0, this._snowActive);
  }

  // --- Block break ---
  _updateBlockBreak(dt) {
    const bb = this._bb, v = this._bbVel;
    let live = 0;
    for (let i = 0; i < BB_CAP; i++) {
      if (v.life[i] <= 0) { if (bb.alpha[i] !== 0) bb.alpha[i] = 0; continue; }
      live++;
      v.life[i] -= dt;
      v.y[i] -= 16.0 * dt;                 // gravity
      const i3 = i * 3;
      bb.pos[i3]     += v.x[i] * dt;
      bb.pos[i3 + 1] += v.y[i] * dt;
      bb.pos[i3 + 2] += v.z[i] * dt;
      const f = v.life[i] / v.max[i];      // 1 → 0
      bb.alpha[i] = f <= 0 ? 0 : Math.min(1, f * 1.6);   // hold then fade out
    }
    // Positions/alpha always move; only re-upload when anything is alive (or
    // on the frame a burst just zeroed out the tail — handled by spawn dirties).
    if (live > 0) {
      bb.pa.needsUpdate = true;
      bb.aa.needsUpdate = true;
    } else if (this._bbWasLive) {
      bb.aa.needsUpdate = true;            // final frame: flush the fade-out
    }
    this._bbWasLive = live > 0;
  }

  // --- Flame ---
  _spawnFlame(i, startFrac) {
    const ti = (i / FLAME_PER) | 0;
    const t = this._torches[ti];
    if (!t) return;
    const i3 = i * 3;
    const ang = rand() * TAU;
    const r = rand() * 0.1;
    const f = this._flame, v = this._flameVel;
    f.pos[i3]     = t.x + Math.cos(ang) * r;
    f.pos[i3 + 1] = t.y + rand() * 0.06;
    f.pos[i3 + 2] = t.z + Math.sin(ang) * r;
    v.x[i] = (rand() - 0.5) * 0.3;
    v.y[i] = 0.9 + rand() * 1.0;
    v.z[i] = (rand() - 0.5) * 0.3;
    const max = 0.35 + rand() * 0.35;
    v.max[i]  = max;
    v.life[i] = max * (startFrac == null ? 1 : startFrac);
  }

  _updateFlame(dt, elapsed) {
    const count = this._activeTorches * FLAME_PER;
    if (count === 0) return;
    const f = this._flame, v = this._flameVel;
    for (let i = 0; i < count; i++) {
      v.life[i] -= dt;
      if (v.life[i] <= 0) this._spawnFlame(i, 1);
      const i3 = i * 3;
      v.y[i] += 0.6 * dt;                  // slight buoyant accel
      v.x[i] += Math.sin(elapsed * 7.0 + i * 1.3) * 0.4 * dt;  // curl
      f.pos[i3]     += v.x[i] * dt;
      f.pos[i3 + 1] += v.y[i] * dt;
      f.pos[i3 + 2] += v.z[i] * dt;
      const lf = v.life[i] / v.max[i];     // 1 (base) → 0 (top)
      const age = 1 - lf;
      const ti = (i / FLAME_PER) | 0;
      const flick = 0.75 + 0.25 * Math.sin(elapsed * 18.0 + ti * 2.1 + i * 0.7);
      // Warm white/yellow at the base → orange/red at the tip. Slightly
      // oversized (soft round sprite + additive) so bloom catches the halo.
      f.color[i3]     = 1.0;
      f.color[i3 + 1] = 0.82 - age * 0.55;
      f.color[i3 + 2] = 0.42 - age * 0.38;
      f.size[i]  = (0.20 + 0.42 * lf) * flick;
      f.alpha[i] = clamp01(lf * flick);
    }
    f.pa.needsUpdate = f.ca.needsUpdate = f.sa.needsUpdate = f.aa.needsUpdate = true;
  }

  // --- Smoke ---
  _spawnSmoke(i, startFrac) {
    const ti = (i / SMOKE_PER) | 0;
    const t = this._torches[ti];
    if (!t) return;
    const i3 = i * 3;
    const s = this._smoke, v = this._smokeVel;
    s.pos[i3]     = t.x + (rand() - 0.5) * 0.16;
    s.pos[i3 + 1] = t.y + 0.5 + rand() * 0.3;
    s.pos[i3 + 2] = t.z + (rand() - 0.5) * 0.16;
    v.x[i] = (rand() - 0.5) * 0.18;
    v.y[i] = 0.35 + rand() * 0.3;
    v.z[i] = (rand() - 0.5) * 0.18;
    const max = 1.2 + rand() * 1.0;
    v.max[i]  = max;
    v.life[i] = max * (startFrac == null ? 1 : startFrac);
  }

  _updateSmoke(dt) {
    const count = this._activeTorches * SMOKE_PER;
    if (count === 0) return;
    const s = this._smoke, v = this._smokeVel;
    for (let i = 0; i < count; i++) {
      v.life[i] -= dt;
      if (v.life[i] <= 0) this._spawnSmoke(i, 1);
      const i3 = i * 3;
      v.y[i] += 0.15 * dt;                 // keeps rising, slowly
      s.pos[i3]     += v.x[i] * dt;
      s.pos[i3 + 1] += v.y[i] * dt;
      s.pos[i3 + 2] += v.z[i] * dt;
      const lf = v.life[i] / v.max[i];
      const age = 1 - lf;
      const g = 0.30 - age * 0.06;         // grey, darkening a touch as it thins
      s.color[i3] = g; s.color[i3 + 1] = g; s.color[i3 + 2] = g + 0.02;
      s.size[i]  = 0.18 + age * 0.55;      // expands
      s.alpha[i] = 0.22 * Math.sin(Math.PI * lf);   // fade in then out (faint)
    }
    s.pa.needsUpdate = s.ca.needsUpdate = s.sa.needsUpdate = s.aa.needsUpdate = true;
  }

  // --- Rain ---
  _seedBox(pool, active, box, cam) {
    for (let i = 0; i < active; i++) {
      const i3 = i * 3;
      pool.pos[i3]     = cam.x + (rand() * 2 - 1) * box.hx;
      pool.pos[i3 + 1] = cam.y + (rand() * 2 - 1) * box.hy;
      pool.pos[i3 + 2] = cam.z + (rand() * 2 - 1) * box.hz;
    }
    pool.pa.needsUpdate = true;
  }

  _updateRain(dt, cam) {
    if (!cam) return;
    const r = this._rain, box = this._rainBox, active = this._rainActive;
    if (active === 0) return;
    if (!this._rainSeeded) { this._seedBox(r, active, box, cam); this._rainSeeded = true; }
    const wx = this._windX * dt, wz = this._windZ * dt;
    for (let i = 0; i < active; i++) {
      const i3 = i * 3;
      r.pos[i3]     += wx;
      r.pos[i3 + 1] -= this._rainFall[i] * dt;
      r.pos[i3 + 2] += wz;
      this._wrap(r.pos, i3, cam, box);
    }
    r.pa.needsUpdate = true;
  }

  // --- Snow ---
  _updateSnow(dt, elapsed, cam) {
    if (!cam) return;
    const s = this._snow, box = this._snowBox, active = this._snowActive;
    if (active === 0) return;
    if (!this._snowSeeded) { this._seedBox(s, active, box, cam); this._snowSeeded = true; }
    for (let i = 0; i < active; i++) {
      const i3 = i * 3;
      const ph = elapsed * this._snowFreq[i] + this._snowPhase[i];
      s.pos[i3]     += (Math.sin(ph) * this._snowAmp[i] + this._windX * 0.15) * dt;
      s.pos[i3 + 1] -= this._snowFall[i] * dt;
      s.pos[i3 + 2] += Math.cos(ph * 0.7) * this._snowAmp[i] * 0.5 * dt;
      this._wrap(s.pos, i3, cam, box);
    }
    s.pa.needsUpdate = true;
  }

  // --- Rain splashes (soft expanding rings at the water surface) ---
  _updateSplash(dt, cam) {
    if (this._waterLevel == null) return;
    const sp = this._splash;
    if (!sp.pts.visible) sp.pts.visible = this._enabled;   // rain just started

    // Spawn: a steady trickle scaled by intensity, carried across frames.
    if (cam) {
      this._splashAccum += (20 + 100 * this._intensity) * dt;
      const box = this._rainBox;
      let n = this._splashAccum | 0;
      this._splashAccum -= n;
      const spawned = n > 0;
      while (n-- > 0) {
        const i = this._splashCursor;
        this._splashCursor = (this._splashCursor + 1) % SPLASH_CAP;
        const i3 = i * 3;
        // Random column in the rain box; rings inside terrain are simply
        // occluded by the depth test, so no water lookup is needed.
        sp.pos[i3]     = cam.x + (rand() * 2 - 1) * box.hx;
        sp.pos[i3 + 1] = this._waterLevel + 0.06;
        sp.pos[i3 + 2] = cam.z + (rand() * 2 - 1) * box.hz;
        sp.color[i3] = 0.72; sp.color[i3 + 1] = 0.79; sp.color[i3 + 2] = 0.88;
        const life = 0.35 + rand() * 0.25;
        this._splashLife[i] = life;
        this._splashMax[i]  = life;
      }
      if (spawned) {
        sp.pa.needsUpdate = true;
        sp.ca.needsUpdate = true;
      }
    }

    // Age: rings expand and fade out.
    let live = 0;
    for (let i = 0; i < SPLASH_CAP; i++) {
      if (this._splashLife[i] <= 0) { if (sp.alpha[i] !== 0) sp.alpha[i] = 0; continue; }
      live++;
      this._splashLife[i] -= dt;
      const age = 1 - Math.max(this._splashLife[i], 0) / this._splashMax[i];
      sp.size[i]  = 0.10 + age * 0.45;
      sp.alpha[i] = 0.5 * (1 - age) * (1 - age);
    }
    if (live > 0 || this._splashWasLive) {
      sp.sa.needsUpdate = true;
      sp.aa.needsUpdate = true;
    }
    this._splashWasLive = live > 0;
  }

  // Toroidal wrap of one particle back into the camera-centred box. Falling
  // below the floor recycles to the ceiling at a fresh x/z (no visible columns).
  _wrap(pos, i3, cam, box) {
    let dx = pos[i3] - cam.x;
    if (dx > box.hx) pos[i3] -= box.hx * 2;
    else if (dx < -box.hx) pos[i3] += box.hx * 2;
    let dz = pos[i3 + 2] - cam.z;
    if (dz > box.hz) pos[i3 + 2] -= box.hz * 2;
    else if (dz < -box.hz) pos[i3 + 2] += box.hz * 2;
    const dy = pos[i3 + 1] - cam.y;
    if (dy < -box.hy) {
      pos[i3]     = cam.x + (rand() * 2 - 1) * box.hx;
      pos[i3 + 1] = cam.y + box.hy - rand() * 1.5;
      pos[i3 + 2] = cam.z + (rand() * 2 - 1) * box.hz;
    } else if (dy > box.hy) {
      pos[i3 + 1] -= box.hy * 2;
    }
  }
}

export default Particles;
