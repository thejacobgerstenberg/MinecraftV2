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
//       * LIGHT — a PointLight at the portal centre, tinted to the live
//         palette, intensity gently flickering (and surging on bursts), plus a
//         second ground-biased fill light low in front of the gate and an
//         additive radial FLOOR GLOW quad at the base, so the palette-coloured
//         spill pools visibly on the ground 3-5 units in front even on
//         software-rasterised (SwiftShader) night shots.
//
//     Three dimension palettes (exported as PALETTES so the GUI can list them),
//     sampled from the LOOMFALL brand 8-stop dimension ramps (brand/palette.json
//     @ feature/brand d8f96a2 — see PALETTES below for the stop mapping):
//       'warpwold'   — violet-blue understitch base, woven green arms, dawn-gold filaments
//       'cinderloom' — ember orange over charred umber with brick smoke veins
//       'nevermend'  — violet-black breaking to hemstone pale, cold cyan gleam
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
//
// Every colour is a verbatim stop from the LOOMFALL brand dimension ramps
// (brand/palette.json `dimensions.<name>.ramp`, stops indexed 0=darkest ..
// 7=brightest). Mapping per dimension: deep <- a darkest stop, bright <- a
// brightest stop, filament/glow/light <- mid/high stops chosen so the in-scene
// swirl stays vivid and the three realms stay hue-distinct (green-gold vs
// ember orange vs violet-cyan — matching the brand's realm-hue oaths).
// ---------------------------------------------------------------------------
export const PALETTES = {
  warpwold: {
    label: 'Warpwold',
    deep: 0x2c3247,       // W0 — night understitch violet-blue
    bright: 0x87ab4c,     // W4 — saturated woven-canopy green
    filament: 0xe4d68a,   // W6 — dawn-gold filaments
    glow: 0x5f8a46,       // W3 — identity green (brand LUT anchor / sat peak)
    light: 0xb8bc5e,      // W5 — green-gold light spill
  },
  cinderloom: {
    label: 'Cinderloom',
    deep: 0x33221b,       // C1 — spent-skein charred umber
    bright: 0xe8722a,     // C5 — ember orange
    filament: 0x8a3220,   // C3 — brick smoke veins (darker than the arms)
    glow: 0xc24a20,       // C4 — live-ember glow (brand saturation peak)
    light: 0xf7a93e,      // C6 — firelight amber
  },
  nevermend: {
    label: 'Nevermend',
    deep: 0x181330,       // N1 — violet-black past the hem
    bright: 0x9cc8d6,     // N6 — cold cyan threshold gleam (realm-exclusive)
    filament: 0x7f7bc2,   // N5 — violet wisps threading the cyan arms
    glow: 0x9cc8d6,       // N6 — the same cyan gleam feeds core/burst/pool
    light: 0xddf3f0,      // N7 — hemstone pale, the finished rim (light spill)
  },
};

const FADE_DURATION = 0.6;   // seconds — palette crossfade
const BURST_DURATION = 0.8;  // seconds — activate() ring + flash
const MOTES = 70;            // drifting energy particles emitted by the surface
const TWO_PI = Math.PI * 2;

// Deterministic tiny hash for per-instance frame shade variation (no
// Math.random — keeps the frame stable frame-to-frame and run-to-run).
function hash01(i) {
  let h = (i * 2654435761) >>> 0;
  h ^= h >>> 13;
  h = (h * 1103515245 + 12345) >>> 0;
  return (h & 0xffff) / 0xffff;
}

// 2-D smoothed value noise on the integer lattice (deterministic).
function vnoise2(seed, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const h = (ix, iy) => hash01(seed ^ (ix * 374761393 + iy * 668265263));
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Procedural OBSIDIAN texture for the frame blocks: near-black violet base
// with conchoidal mottling, lighter lavender veins and a few glassy flecks
// that catch the portal light's specular. 64x64, NearestFilter — reads as
// chunky voxel texture, not a smooth gradient. Returns null without a DOM
// (node-side parse/lint runs) — never hit in the browser.
function makeObsidianTexture(seed = 0xb51d) {
  if (typeof document === 'undefined') return null;
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n =
        0.55 * vnoise2(seed, x / 9.3, y / 9.3) +
        0.30 * vnoise2(seed ^ 0x1234, x / 4.4, y / 4.4) +
        0.15 * vnoise2(seed ^ 0x777, x / 2.1, y / 2.1);
      // Violet-black ramp with a slight banding snap (blocky facets).
      const q = Math.floor(n * 6) / 6;
      let r = 16 + q * 34;
      let gr = 11 + q * 22;
      let b = 30 + q * 62;
      // Lighter lavender vein where the mid-frequency noise crests.
      const vein = vnoise2(seed ^ 0xbeef, x / 6.2, y / 6.2);
      if (vein > 0.78) { r += 46; gr += 34; b += 64; }
      // Rare bright glassy fleck.
      if (hash01(seed ^ (x * 731 + y * 197)) > 0.988) { r += 90; gr += 78; b += 110; }
      const k = (y * S + x) * 4;
      d[k] = Math.min(255, r);
      d[k + 1] = Math.min(255, gr);
      d[k + 2] = Math.min(255, b);
      d[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Soft radial gradient for the ground-pool quad at the portal base. Additive
// blending: black rim = zero contribution, so the disc melts into the ground.
function makeGroundGlowTexture() {
  if (typeof document === 'undefined') return null;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.42)');
  grad.addColorStop(0.65, 'rgba(255,255,255,0.13)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Soft round dot for the mote particles (additive glow points).
function makeMoteTexture() {
  if (typeof document === 'undefined') return null;
  const S = 32;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Portal surface shaders
// ---------------------------------------------------------------------------
const PORTAL_VERT = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vVdTs; // tangent-space view vector (for parallax depth layers)
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
    // View vector in the plane's tangent frame: deeper swirl layers are
    // offset along this in the fragment shader, which is what gives the
    // portal parallax depth instead of a flat sticker look.
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vec3 vd = wp.xyz - cameraPosition;
    vVdTs = vec3(
      dot(vd, normalize(modelMatrix[0].xyz)),
      dot(vd, normalize(modelMatrix[1].xyz)),
      dot(vd, normalize(modelMatrix[2].xyz)));
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
  varying vec3 vVdTs;

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
    vec2 p0 = vUv * 2.0 - 1.0;
    p0.x *= uAspect;

    // Parallax direction: deeper layers slide against the view direction, so
    // the swirl reads as a volume behind the frame, not a flat decal.
    vec2 vdir = vVdTs.xy / max(abs(vVdTs.z), 0.35);
    vdir = clamp(vdir, vec2(-1.5), vec2(1.5));

    vec3 col = vec3(0.0);
    float coreSum = 0.0;
    float swTop = 0.0;

    // Three depth layers: nearest brightest/fastest, deeper dimmer/slower and
    // parallax-shifted. Each layer is an fbm-warped rotating spiral with soft
    // wide filaments (the old single layer used razor-crisp streak edges).
    for (int L = 0; L < 3; L++) {
      float fl = float(L);
      vec2 p = p0 + vdir * (fl * 0.17);
      float r = length(p);
      float ang = atan(p.y, p.x);
      float n = fbm(p * 2.6
                    + vec2(uTime * (0.17 + 0.05 * fl), -uTime * 0.12)
                    + fl * 3.7);
      float spiral = sin(ang * 3.0 + r * 6.5
                         - uTime * (1.8 - 0.35 * fl) + n * 3.6 + fl * 2.1);
      float sw = 0.5 + 0.5 * spiral;
      sw = sw * sw * (3.0 - 2.0 * sw);
      if (L == 0) swTop = sw;

      float w = 1.0 - 0.30 * fl;                    // deeper = dimmer
      vec3 lcol = mix(uColDeep, uColBright, sw) * w;

      // Soft, wide filaments tinted toward the glow colour: volumetric
      // energy wisps instead of crisp vector streaks.
      float fil = sin(ang * 7.0 - r * 12.0 + uTime * 2.4 + n * 5.0 + fl * 1.3);
      fil = smoothstep(0.45, 0.95, fil);
      lcol = mix(lcol, mix(uColFilament, uColGlow, 0.4) * w,
                 fil * (0.25 + 0.30 * n));

      col += lcol * (L == 0 ? 0.62 : 0.19);
      coreSum += exp(-r * r * 2.6) * w * 0.42; // ~0.9 max across all layers
    }

    float r0 = length(p0);
    float n0 = fbm(p0 * 2.2 - vec2(0.0, uTime * 0.21));

    // Centre-weighted emissive core (feeds bloom), gently pulsing. Kept
    // below ~0.6*glow so the centre blooms without clipping to a white blob.
    col += uColGlow * coreSum * (0.38 + 0.08 * sin(uTime * 2.1) + 0.12 * n0);

    // Burst: expanding bright ring + flash.
    float dr = (r0 - uBurstRadius) * 6.0;
    float ring = exp(-dr * dr);
    col += (uColGlow + vec3(0.55)) * ring * uBurstRing;
    col += (uColGlow * 0.7 + vec3(0.45)) * uBurstFlash;

    // Soft rectangular alpha edges so the swirl blends into the frame.
    float ex = smoothstep(0.0, 0.14, vUv.x) * smoothstep(1.0, 0.86, vUv.x);
    float ey = smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.88, vUv.y);
    float edge = ex * ey;

    float alpha = edge * (0.72 + 0.28 * swTop + coreSum * 0.12);
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
    this._frameTex = makeObsidianTexture();
    this._frameMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,        // shaded via per-instance colour below
      map: this._frameTex,    // mottled obsidian: veins + glassy flecks
      roughness: 0.38,        // glassy — catches the portal light's specular
      metalness: 0.22,
      emissive: 0x14092a,     // faint violet inner sheen
      emissiveIntensity: 0.55,
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
      // Per-block brightness variation over the obsidian map so the frame
      // reads as individual voxels (the map itself carries the texture; the
      // old near-black tints crushed it to a featureless silhouette).
      const t = hash01(idx);
      c.setRGB(
        0.4 + 0.36 * t,
        0.38 + 0.32 * t,
        0.46 + 0.4 * t,
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

    // ---- LIGHT: palette-tinted point light at the portal centre. Strong
    // enough (8.5, decay 1.6) to paint a clearly visible colour pool on the
    // ground 3-5 units in front at night — the previous 5.0/decay-1.8 spill
    // read faint on SwiftShader shots.
    this._lightBase = 8.5;
    this._light = new THREE.PointLight(
      0xffffff, this._lightBase, Math.max(width, height) * 7, 1.6);
    this._light.position.set(0, height / 2, 1.1); // nudged out the front face
    this._light.castShadow = false;       // deliberate — perf
    this.object3d.add(this._light);

    // Second, ground-biased soft fill: sits low in front of the gate so the
    // ground plane gets a favourable N.L and the colour pool reads even when
    // the centre light grazes it. Same palette tint, gentler falloff.
    this._groundLightBase = 4.0;
    this._groundLight = new THREE.PointLight(
      0xffffff, this._groundLightBase, Math.max(width, height) * 4, 1.6);
    this._groundLight.position.set(0, 0.9, 2.2); // low + in front of the face
    this._groundLight.castShadow = false; // deliberate — perf
    this.object3d.add(this._groundLight);

    // ---- FLOOR GLOW: subtle additive gradient disc lying on the ground at
    // the portal base, biased toward the front. Guarantees the palette pool
    // is visible in headless/software shots where point-light shading alone
    // can render too dim. Tinted to the live glow colour every frame.
    this._glowTex = makeGroundGlowTexture();
    this._glowGeo = new THREE.PlaneGeometry(width * 3.0, width * 2.2);
    this._glowBaseOpacity = 0.38;
    this._glowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,                    // tinted to the live glow palette
      map: this._glowTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: this._glowBaseOpacity,
      fog: false,                         // additive: fog would tint the black rim
    });
    const floorGlow = new THREE.Mesh(this._glowGeo, this._glowMat);
    floorGlow.name = 'portalFloorGlow';
    floorGlow.rotation.x = -Math.PI / 2;  // flat on the ground
    floorGlow.position.set(0, 0.045, 1.3); // just above grade, pooled in front
    floorGlow.renderOrder = 1;            // after opaques/water, under the swirl
    floorGlow.userData.noShadow = true;
    this._floorGlow = floorGlow;
    this.object3d.add(floorGlow);

    // ---- MOTES: additive glow particles drifting out of the surface.
    this._moteTex = makeMoteTexture();
    this._moteGeo = new THREE.BufferGeometry();
    this._motePos = new Float32Array(MOTES * 3);
    this._moteGeo.setAttribute(
      'position', new THREE.BufferAttribute(this._motePos, 3));
    this._moteMat = new THREE.PointsMaterial({
      color: 0xffffff,                    // tinted to the live glow palette
      size: 0.2,
      sizeAttenuation: true,
      map: this._moteTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.8,
    });
    this._motes = new THREE.Points(this._moteGeo, this._moteMat);
    this._motes.name = 'portalMotes';
    this._motes.renderOrder = 3;          // after the portal surface
    this._motes.frustumCulled = false;
    this._motes.userData.noShadow = true;
    this.object3d.add(this._motes);

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
    this._groundLight.color.copy(this._toLight);
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
      this._groundLight.color.copy(this._light.color);
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

    // Lights: slight pulse/flicker + burst surge. The ground fill and the
    // floor-glow quad share the same pulse so the whole spill breathes as one.
    const t = this._time;
    const pulse = 0.86 + 0.09 * Math.sin(t * 5.3) + 0.05 * Math.sin(t * 13.7 + 1.7);
    this._light.intensity = this._lightBase * pulse + burstRing * 4.0;
    this._groundLight.intensity = this._groundLightBase * pulse + burstRing * 2.5;

    // Floor glow: live palette tint, pulsing opacity, flare on bursts.
    this._glowMat.color.copy(u.uColGlow.value);
    const glowOp = this._glowBaseOpacity * pulse
      + burstRing * 0.25 + u.uBurstFlash.value * 0.2;
    this._glowMat.opacity = glowOp > 1 ? 1 : glowOp;

    // Motes: deterministic per-index orbits. Each mote loops a life cycle
    // that carries it through the plane (z -0.9 -> +0.9) while slowly
    // orbiting the portal centre; tinted to the live glow colour.
    this._moteMat.color.copy(u.uColGlow.value);
    const w2 = this._width * 0.42;
    const h2 = this._height * 0.42;
    const cy = this._height / 2;
    const pos = this._motePos;
    for (let i = 0; i < MOTES; i++) {
      const s0 = hash01(i * 3 + 1);
      const s1 = hash01(i * 5 + 2);
      const s2 = hash01(i * 7 + 3);
      const speed = 0.08 + 0.14 * s2;
      const cyc = (t * speed + s0 * 7.31) % 1;
      const ang = s1 * TWO_PI + t * (0.22 + 0.3 * s2) * (s0 > 0.5 ? 1 : -1);
      const rad = 0.2 + 0.8 * s0 * (0.6 + 0.4 * cyc);
      const j = i * 3;
      pos[j] = Math.cos(ang) * rad * w2;
      pos[j + 1] = cy + Math.sin(ang) * rad * h2;
      pos[j + 2] = (cyc - 0.5) * 1.8 * (s1 > 0.5 ? 1 : -1);
    }
    this._moteGeo.attributes.position.needsUpdate = true;
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
    if (this._frameTex) this._frameTex.dispose();
    this._surfGeo.dispose();
    this._surfMat.dispose();
    this._moteGeo.dispose();
    this._moteMat.dispose();
    if (this._moteTex) this._moteTex.dispose();
    this._glowGeo.dispose();
    this._glowMat.dispose();
    if (this._glowTex) this._glowTex.dispose();
    this._light.dispose();
    this._groundLight.dispose();
    this.object3d.clear();
  }
}
