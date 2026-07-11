// graphics-lab/src/portals.js
//
// PORTAL GATE showpiece — a swirling dimensional gate.
//
//   class PortalGate({ position, width, height, dimension })
//     .object3d contains:
//       * FRAME — a ring of 1-unit near-black purple-tinted voxel cubes (one
//         InstancedMesh, matrices set once, deterministic per-instance shade
//         variation) framing a `width x height` inner opening, obsidian-style.
//         The opening's inner bottom edge sits at local y = 0, so placing the
//         gate at ground level "just works".
//       * SURFACE — a plane filling the opening, drawn with a lean
//         ShaderMaterial: polar-coordinate rotating spiral + fbm noise
//         distortion animated over uTime, an additive-ish glow core, and soft
//         rectangular alpha edges so the swirl melts into the frame.
//         Transparent, depthWrite:false, DoubleSide (walk around it / through it).
//       * LIGHT — a soft PointLight at the portal centre, tinted to the live
//         palette, intensity gently flickering (and surging on bursts).
//
//     Three dimension palettes (exported as PALETTES so the GUI can list them):
//       'warpwold'   — deep violet/magenta swirl with teal filaments
//       'cinderloom' — ember orange/crimson with dark smoke veins
//       'nevermend'  — pale bone-white/ice cyan with faint green wisps
//     Palettes are pure uniform data: setDimension(name) crossfades every
//     palette uniform (and the light colour) over ~0.6 s and fires activate().
//
//     activate() — burst: an expanding bright ring + flash on the surface,
//     shader-uniform driven, ~0.8 s envelope computed on the CPU in update().
//
// Follows the graphics-lab effect contract: update(dt, ctx), setEnabled(bool),
// get enabled, dispose(), .object3d. Allocation-free per frame (all scratch
// colours/objects are prebuilt; update only mutates uniforms in place).

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Dimension palettes (uniform-driven, switchable at runtime).
// Colours are hex so the GUI can display swatches; PortalGate builds
// THREE.Color instances from these internally.
//   deep     — dark base of the swirl
//   bright   — bright arm colour the spiral mixes toward
//   filament — thin vein/wisp colour (mixed in, so dark veins work too)
//   glow     — additive core-glow / burst tint
//   light    — PointLight tint
// ---------------------------------------------------------------------------
export const PALETTES = {
  warpwold: {
    label: 'Warpwold',
    deep: 0x1c0733,       // deep violet
    bright: 0xc72bd6,     // magenta
    filament: 0x2fd6c4,   // teal filaments
    glow: 0xa14dee,
    light: 0xb45cf2,
  },
  cinderloom: {
    label: 'Cinderloom',
    deep: 0x2f0a05,       // charred umber
    bright: 0xff7a1f,     // ember orange
    filament: 0x17100e,   // dark smoke veins
    glow: 0xe0342b,       // crimson glow
    light: 0xff8c3a,
  },
  nevermend: {
    label: 'Nevermend',
    deep: 0x8d989e,       // cold pale grey-bone
    bright: 0xe9ece2,     // bone white
    filament: 0x9dffb4,   // faint green wisps
    glow: 0xa8e9f7,       // ice cyan
    light: 0xbfeef5,
  },
};

const FADE_DURATION = 0.6;   // seconds — palette crossfade
const BURST_DURATION = 0.8;  // seconds — activate() ring + flash

// Deterministic tiny hash for per-instance frame shade variation (no
// Math.random — keeps the frame stable frame-to-frame and run-to-run).
function hash01(i) {
  let h = (i * 2654435761) >>> 0;
  h ^= h >>> 13;
  h = (h * 1103515245 + 12345) >>> 0;
  return (h & 0xffff) / 0xffff;
}

// ---------------------------------------------------------------------------
// Portal surface shaders
// ---------------------------------------------------------------------------
const PORTAL_VERT = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 p = position;
    // Subtle breathing wobble along the plane normal; damped at the borders
    // so the surface stays seated in the frame.
    float ex = smoothstep(0.0, 0.2, uv.x) * smoothstep(1.0, 0.8, uv.x);
    float ey = smoothstep(0.0, 0.2, uv.y) * smoothstep(1.0, 0.8, uv.y);
    p.z += 0.09 * ex * ey
         * sin(uv.x * 9.0 + uTime * 1.9)
         * sin(uv.y * 7.0 - uTime * 1.5);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const PORTAL_FRAG = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform float uAspect;        // width / height, to keep the swirl circular
  uniform vec3  uColDeep;
  uniform vec3  uColBright;
  uniform vec3  uColFilament;
  uniform vec3  uColGlow;
  uniform float uBurstRadius;   // expanding ring radius (polar units)
  uniform float uBurstRing;     // ring intensity envelope
  uniform float uBurstFlash;    // full-surface flash envelope
  varying vec2 vUv;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * vnoise(p);
      p = p * 2.03 + vec2(17.13, 9.77);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    // Centred, aspect-corrected polar coordinates.
    vec2 p = vUv * 2.0 - 1.0;
    p.x *= uAspect;
    float r = length(p);
    float ang = atan(p.y, p.x);

    // fbm distortion field, drifting over time.
    float n = fbm(p * 2.6 + vec2(uTime * 0.17, -uTime * 0.12));

    // Rotating spiral: arms twist with radius, spin with time, warped by fbm.
    float spiral = sin(ang * 3.0 + r * 6.5 - uTime * 1.8 + n * 3.6);
    float sw = 0.5 + 0.5 * spiral;
    sw = sw * sw * (3.0 - 2.0 * sw);

    vec3 col = mix(uColDeep, uColBright, sw);

    // Thin counter-rotating filaments / veins (mixed, not added, so dark
    // smoke veins work as well as bright teal filaments).
    float fil = sin(ang * 7.0 - r * 12.0 + uTime * 2.4 + n * 5.0);
    fil = smoothstep(0.82, 0.98, fil);
    col = mix(col, uColFilament, fil * (0.35 + 0.45 * n));

    // Additive-ish glow core (feeds bloom), gently pulsing.
    float core = exp(-r * r * 3.2);
    col += uColGlow * core * (0.9 + 0.25 * sin(uTime * 2.1) + 0.35 * n);

    // Burst: expanding bright ring + flash.
    float dr = (r - uBurstRadius) * 6.0;
    float ring = exp(-dr * dr);
    col += (uColGlow + vec3(0.55)) * ring * uBurstRing;
    col += (uColGlow * 0.7 + vec3(0.45)) * uBurstFlash;

    // Soft rectangular alpha edges so the swirl blends into the frame.
    float ex = smoothstep(0.0, 0.14, vUv.x) * smoothstep(1.0, 0.86, vUv.x);
    float ey = smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.88, vUv.y);
    float edge = ex * ey;

    float alpha = edge * (0.72 + 0.28 * sw + core * 0.25);
    alpha += edge * (ring * uBurstRing + uBurstFlash) * 0.5;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`;

// ---------------------------------------------------------------------------
// PortalGate
// ---------------------------------------------------------------------------
export class PortalGate {
  constructor({
    position = new THREE.Vector3(),
    width = 4,
    height = 5,
    dimension = 'warpwold',
  } = {}) {
    this._enabled = true;
    this._time = 0;
    this._width = width;
    this._height = height;

    this.object3d = new THREE.Group();
    this.object3d.name = 'portalGate';
    this.object3d.position.copy(position);

    // ---- FRAME: one InstancedMesh of 1-unit cubes ring around the opening.
    // Opening cells: x in [-w/2, w/2], y in [0, h]. Frame ring is one cell
    // thick, corners included (2*(h+2) + 2*w cubes).
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const count = 2 * (h + 2) + 2 * w;

    this._frameGeo = new THREE.BoxGeometry(1, 1, 1);
    this._frameMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,        // shaded via per-instance colour below
      roughness: 0.82,
      metalness: 0.18,
      emissive: 0x0b0514,     // faint violet inner sheen
      emissiveIntensity: 0.5,
    });
    const frame = new THREE.InstancedMesh(this._frameGeo, this._frameMat, count);
    frame.name = 'portalFrame';
    frame.castShadow = true;
    frame.receiveShadow = true;

    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    const halfW = w / 2;
    let idx = 0;
    const place = (x, y) => {
      m.makeTranslation(x, y, 0);
      frame.setMatrixAt(idx, m);
      // Near-black purple, deterministic shade variation per block so the
      // frame reads as individual obsidian-style voxels.
      const t = hash01(idx);
      c.setRGB(
        0.045 + 0.045 * t,
        0.026 + 0.024 * t,
        0.075 + 0.065 * t,
      );
      frame.setColorAt(idx, c);
      idx++;
    };
    // Side columns (full height incl. corner rows: y centres -0.5 .. h+0.5).
    for (let j = -1; j <= h; j++) {
      place(-halfW - 0.5, j + 0.5);
      place(halfW + 0.5, j + 0.5);
    }
    // Top and bottom rows across the opening.
    for (let i = 0; i < w; i++) {
      const x = -halfW + 0.5 + i;
      place(x, -0.5);
      place(x, h + 0.5);
    }
    frame.instanceMatrix.needsUpdate = true;
    if (frame.instanceColor) frame.instanceColor.needsUpdate = true;
    this._frame = frame;
    this.object3d.add(frame);

    // ---- SURFACE: swirl shader plane filling the opening.
    this._surfGeo = new THREE.PlaneGeometry(width, height, 24, 30);
    this._surfMat = new THREE.ShaderMaterial({
      vertexShader: PORTAL_VERT,
      fragmentShader: PORTAL_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAspect: { value: width / height },
        uColDeep: { value: new THREE.Color() },
        uColBright: { value: new THREE.Color() },
        uColFilament: { value: new THREE.Color() },
        uColGlow: { value: new THREE.Color() },
        uBurstRadius: { value: 0 },
        uBurstRing: { value: 0 },
        uBurstFlash: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const surface = new THREE.Mesh(this._surfGeo, this._surfMat);
    surface.name = 'portalSurface';
    surface.position.set(0, height / 2, 0);
    surface.renderOrder = 2;              // after water/other transparents
    surface.userData.noShadow = true;     // keep out of the shadow pass
    this._surface = surface;
    this.object3d.add(surface);

    // ---- LIGHT: soft palette-tinted point light at the portal centre.
    this._lightBase = 1.6;
    this._light = new THREE.PointLight(
      0xffffff, this._lightBase, Math.max(width, height) * 4.5, 2);
    this._light.position.set(0, height / 2, 0);
    this._light.castShadow = false;       // deliberate — perf
    this.object3d.add(this._light);

    // ---- Palette crossfade state (all scratch objects prebuilt).
    this._fromDeep = new THREE.Color();
    this._fromBright = new THREE.Color();
    this._fromFilament = new THREE.Color();
    this._fromGlow = new THREE.Color();
    this._fromLight = new THREE.Color();
    this._toDeep = new THREE.Color();
    this._toBright = new THREE.Color();
    this._toFilament = new THREE.Color();
    this._toGlow = new THREE.Color();
    this._toLight = new THREE.Color();
    this._fadeT = FADE_DURATION;          // done
    this._fading = false;

    // ---- Burst state.
    this._burstT = 0;
    this._burstActive = false;

    // Seed the initial palette instantly (no fade, no burst).
    this._dimension = null;
    const start = PALETTES[dimension] ? dimension : 'warpwold';
    this._applyPaletteTargets(start);
    const u = this._surfMat.uniforms;
    u.uColDeep.value.copy(this._toDeep);
    u.uColBright.value.copy(this._toBright);
    u.uColFilament.value.copy(this._toFilament);
    u.uColGlow.value.copy(this._toGlow);
    this._light.color.copy(this._toLight);
    this._dimension = start;
  }

  get dimension() { return this._dimension; }
  get enabled() { return this._enabled; }

  // Copy a named palette into the _to* scratch colours.
  _applyPaletteTargets(name) {
    const p = PALETTES[name];
    this._toDeep.setHex(p.deep);
    this._toBright.setHex(p.bright);
    this._toFilament.setHex(p.filament);
    this._toGlow.setHex(p.glow);
    this._toLight.setHex(p.light);
  }

  // Crossfade to another dimension palette over ~0.6 s (+ burst).
  setDimension(name) {
    if (!PALETTES[name]) {
      console.warn(`PortalGate.setDimension: unknown dimension "${name}"`);
      return;
    }
    if (name === this._dimension && !this._fading) {
      this.activate();                    // re-selecting still pulses
      return;
    }
    const u = this._surfMat.uniforms;
    // Fade FROM whatever is currently on screen (mid-fade safe).
    this._fromDeep.copy(u.uColDeep.value);
    this._fromBright.copy(u.uColBright.value);
    this._fromFilament.copy(u.uColFilament.value);
    this._fromGlow.copy(u.uColGlow.value);
    this._fromLight.copy(this._light.color);
    this._applyPaletteTargets(name);
    this._fadeT = 0;
    this._fading = true;
    this._dimension = name;
    this.activate();
  }

  // Burst: expanding bright ring + flash, ~0.8 s (uniform-driven).
  activate() {
    this._burstT = 0;
    this._burstActive = true;
  }

  update(dt, ctx) { // eslint-disable-line no-unused-vars
    if (!this._enabled) return;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    this._time += dt;

    const u = this._surfMat.uniforms;
    u.uTime.value = this._time;

    // Palette crossfade.
    if (this._fading) {
      this._fadeT += dt;
      let k = this._fadeT / FADE_DURATION;
      if (k >= 1) { k = 1; this._fading = false; }
      k = k * k * (3 - 2 * k); // smoothstep
      u.uColDeep.value.lerpColors(this._fromDeep, this._toDeep, k);
      u.uColBright.value.lerpColors(this._fromBright, this._toBright, k);
      u.uColFilament.value.lerpColors(this._fromFilament, this._toFilament, k);
      u.uColGlow.value.lerpColors(this._fromGlow, this._toGlow, k);
      this._light.color.lerpColors(this._fromLight, this._toLight, k);
    }

    // Burst envelope.
    let burstRing = 0;
    if (this._burstActive) {
      this._burstT += dt;
      const b = this._burstT / BURST_DURATION;
      if (b >= 1) {
        this._burstActive = false;
        u.uBurstRadius.value = 0;
        u.uBurstRing.value = 0;
        u.uBurstFlash.value = 0;
      } else {
        u.uBurstRadius.value = b * 1.35;               // expand past the rim
        burstRing = (1 - b) * (1 - b) * 1.4;           // ring fades out
        u.uBurstRing.value = burstRing;
        u.uBurstFlash.value = Math.exp(-b * 9.0) * 0.9; // sharp initial flash
      }
    }

    // Light: slight pulse/flicker + burst surge.
    const t = this._time;
    this._light.intensity = this._lightBase
      * (0.86 + 0.09 * Math.sin(t * 5.3) + 0.05 * Math.sin(t * 13.7 + 1.7))
      + burstRing * 2.4;
  }

  setEnabled(on) {
    this._enabled = !!on;
    this.object3d.visible = this._enabled;
  }

  dispose() {
    if (this.object3d.parent) this.object3d.parent.remove(this.object3d);
    this._frame.dispose();          // frees instance buffers
    this._frameGeo.dispose();
    this._frameMat.dispose();
    this._surfGeo.dispose();
    this._surfMat.dispose();
    this._light.dispose();
    this.object3d.clear();
  }
}
