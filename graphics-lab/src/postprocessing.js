// graphics-lab/src/postprocessing.js
//
// LEAN CUSTOM POST-PROCESSING CHAIN.
//
// A self-contained HDR post stack built from raw WebGLRenderTargets and
// fullscreen-triangle ShaderMaterial passes. It deliberately does NOT depend on
// three/examples' EffectComposer / Pass classes so the whole pipeline stays
// vendored, allocation-free and fully controllable.
//
// Pipeline (render(dt)):
//   scene ──▶ sceneRT (HDR, half-float, linear, + attached DepthTexture)
//         ──▶ SSAO (src/ssao.js, half/full-res AO from depth + 4-tap denoise)
//         ──▶ bright-pass (soft-knee threshold)        ▲ bloom branch
//         ──▶ separable gaussian blur (downsampled, N iterations, ping-pong)
//         ──▶ GOD RAYS (src/godrays.js, quarter-res sky mask + 2x radial blur
//                        toward the sun's screen position)
//         ──▶ COMPOSITE  (scene * SSAO, + bloom*strength, + rays*tint,
//                          exposure, ACES filmic tonemap, per-biome colour
//                          grade, vignette, sRGB encode)
//         ──▶ [optional FXAA on the final LDR sRGB image]
//         ──▶ screen
//
// SSAO multiplies the scene colour BEFORE tonemap (and before bloom/rays are
// added — light halos and shafts are unoccluded light). Its default intensity
// is modest (0.55) so it complements the mesher's baked per-vertex corner AO
// with contact darkening instead of double-darkening every crevice. God rays
// reuse the scene colour+depth (no second scene render): sky pixels (depth at
// the far plane) stay bright — the sun disc drives the shafts — and geometry
// masks to black. Both effects need a readable depth texture; on renderers
// without one (WebGL1 sans WEBGL_depth_texture) they are skipped cleanly.
//
// All passes run on an OrthographicCamera over a single reused fullscreen
// triangle. No per-frame allocation: uniform values are mutated in place and
// every render target is reused (only reallocated on resize / quality change).
//
// Colour management: the scene is rendered with renderer.toneMapping =
// NoToneMapping into a LINEAR half-float buffer so emissive/HDR values (sun,
// glowstone) survive for the bright-pass. Tonemapping + sRGB encode happen once
// in the composite shader; FXAA (which reasons in perceptual/gamma space) runs
// on the encoded LDR image. Raw ShaderMaterials get no automatic colour-space
// or tonemapping injection, so the chain owns every conversion explicitly.
//
// Public API:
//   new PostFX(renderer, scene, camera, { quality })
//   render(dt)                 // call INSTEAD of renderer.render(scene, camera)
//   update(dt, ctx)            // OPTIONAL pre-render hook (effects contract):
//                              // auto-derives nightBoost from ctx.sunDir.y /
//                              // ctx.timeOfDay unless setNightBoost was called
//   setSize(w, h)              // resize targets (device px; auto-detected too)
//   setQuality('low'|'medium'|'high'|'ultra')
//   toggle('bloom'|'tonemap'|'vignette'|'fxaa'|'ssao'|'godrays', bool)
//   setExposure(x)             // linear pre-tonemap exposure (default 1.1)
//   setBloomStrength(x)        // bloom additive weight (default 0.8)
//   setBloomThreshold(x)       // bright-pass threshold (default 0.75)
//   setBloomRadius(x)          // gaussian spread multiplier (default 1.3)
//   setNightBoost(f)           // 0..1: raises bloom strength/radius, lowers
//                              // threshold and lifts exposure slightly so
//                              // torch/glowstone halos read at night while the
//                              // day image stays clean. Calling this disables
//                              // the update(dt,ctx) auto-drive (manual wins).
//   setAutoNightBoost(bool)    // re-enable/disable the update() auto-drive
//   setGrade({lift,gain,sat})  // per-biome colour grade target (applied in the
//                              // composite AFTER tonemap, BEFORE vignette:
//                              // c = mix(vec3(luma(c)), c, sat) * gain + lift).
//                              // Live values ease toward the target over
//                              // ~0.5 s. Omitted fields reset to neutral
//                              // (lift [0,0,0], gain [1,1,1], sat 1).
//   setSsaoEnabled(bool)       // convenience for toggle('ssao', bool)
//   setGodRaysEnabled(bool)    // convenience for toggle('godrays', bool)
//   setSsaoIntensity(x)        // 0..1 AO blend (default 0.55 — modest, the
//                              // baked vertex AO already carries the look)
//   setSsaoRadius(r)           // AO world-unit radius (default 0.8)
//   setGodRaysStrength(x)      // ray add weight baseline (default 0.55; the
//                              // per-frame sun fade multiplies on top)
//   .ssao / .godrays           // the pass objects (null when depth textures
//                              // are unsupported) for advanced tuning
//   setEnabled(bool)           // false => straight renderer.render (bypass)
//   get enabled()
//   dispose()

import * as THREE from 'three';
import { SSAOPass } from './ssao.js';
import { GodRaysPass } from './godrays.js';

// ---------------------------------------------------------------------------
// Quality presets.
//   bloom      : bloom branch on/off (still toggleable at runtime).
//   bloomDiv   : bloom-buffer downsample factor (2 = half-res, 1 = full-res).
//   iterations : gaussian H+V ping-pong passes (each widens the bloom).
//   fxaa       : anti-alias the final LDR image.
// Tonemap + vignette live in the single composite pass, so they are ~free and
// stay ON at every tier (still individually toggleable).
// ---------------------------------------------------------------------------
// NOTE: every blur iteration runs on the DOWNSAMPLED bloom buffer (bloomDiv),
// so the extra iteration at medium/high costs a fraction of a full-res pass.
// Iterations also escalate their tap radius (see render()), so each one widens
// the halo more than the last — emissives get a real glow, not a 2px dot.
//   ssao       : SSAO on/off; ssaoSamples 8|12; ssaoDiv 2 = half-res, 1 = full.
//   godrays    : crepuscular rays on/off (always quarter-res internally).
//   godraysTaps/godraysPasses : radial-blur taps per pass / blur iterations —
//                more of both at high+ so the shafts stay smooth as they get
//                longer and higher-contrast (still quarter-res => cheap).
const QUALITY = {
  low:    { bloom: false, bloomDiv: 2, iterations: 1, fxaa: false, ssao: false, ssaoSamples: 8,  ssaoDiv: 2, godrays: false, godraysTaps: 12, godraysPasses: 2 },
  medium: { bloom: true,  bloomDiv: 2, iterations: 2, fxaa: true,  ssao: true,  ssaoSamples: 8,  ssaoDiv: 2, godrays: true,  godraysTaps: 12, godraysPasses: 2 },
  high:   { bloom: true,  bloomDiv: 2, iterations: 3, fxaa: true,  ssao: true,  ssaoSamples: 12, ssaoDiv: 2, godrays: true,  godraysTaps: 16, godraysPasses: 3 },
  ultra:  { bloom: true,  bloomDiv: 1, iterations: 4, fxaa: true,  ssao: true,  ssaoSamples: 12, ssaoDiv: 1, godrays: true,  godraysTaps: 20, godraysPasses: 3 },
};

// Shared vertex shader: a fullscreen triangle whose clip-space positions are
// passed straight through (camera matrices intentionally ignored).
const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Bright-pass: extract pixels above `threshold` with a soft `knee` roll-off so
// the bloom onset is gradual instead of a hard clip. (Unity/COD soft-knee.)
const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float threshold;
uniform float knee;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float br = max(c.r, max(c.g, c.b));
  float soft = br - threshold + knee;
  soft = clamp(soft, 0.0, 2.0 * knee);
  soft = (soft * soft) / (4.0 * knee + 1e-4);
  float contrib = max(soft, br - threshold);
  contrib /= max(br, 1e-4);
  gl_FragColor = vec4(c * contrib, 1.0);
}
`;

// Separable 9-tap gaussian using hardware bilinear taps (5 fetches). `direction`
// carries the per-axis texel step (already in UV units), so the same shader does
// both the horizontal and vertical halves. `radius` scales the tap offsets so
// the spread is tunable (and grows per ping-pong iteration) without extra taps.
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 direction;
uniform float radius;
varying vec2 vUv;
void main() {
  vec2 o1 = direction * (1.3846153846 * radius);
  vec2 o2 = direction * (3.2307692308 * radius);
  vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
  sum += texture2D(tDiffuse, vUv + o1).rgb * 0.3162162162;
  sum += texture2D(tDiffuse, vUv - o1).rgb * 0.3162162162;
  sum += texture2D(tDiffuse, vUv + o2).rgb * 0.0702702703;
  sum += texture2D(tDiffuse, vUv - o2).rgb * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}
`;

// Composite: SSAO multiply, additive bloom + god rays, exposure, ACES filmic
// tonemap, per-biome colour grade (post-tonemap, pre-vignette), vignette,
// sRGB out.
const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;        // HDR linear scene
uniform sampler2D tBloom;        // blurred bloom (linear, low-res, upsampled)
uniform sampler2D tAO;           // SSAO (r, 1 = open; 1x1 white when off)
uniform sampler2D tRays;         // god rays (low-res; 1x1 black when off)
uniform sampler2D tDepth;        // scene depth (near-field ray guard; 1x1
                                 // white => guard neutral when unavailable)
uniform float uSsao;             // 0/1
uniform vec3 uRaysTint;          // altitude-derived warm sun tint
uniform float uRaysStrength;     // strength x sun fade (0 disables)
uniform float uRaysDepthFade;    // 0/1: near-field ray attenuation available
uniform float uCamNear;          // camera near/far for depth linearisation
uniform float uCamFar;
uniform float exposure;
uniform float bloomStrength;
uniform float uBloom;            // 0/1
uniform float uTonemap;          // 0/1
uniform float uVignette;         // 0/1
uniform float vigRadius;
uniform float vigSoftness;
uniform float vigDarkness;
uniform vec3 uGradeLift;         // per-biome grade: additive lift (neutral 0)
uniform vec3 uGradeGain;         // per-biome grade: channel gain (neutral 1)
uniform float uGradeSat;         // per-biome grade: saturation (neutral 1)
varying vec2 vUv;

// Narkowicz ACES filmic approximation (standard).
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 linearToSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, step(c, vec3(0.0031308)));
}
void main() {
  vec3 hdr = texture2D(tScene, vUv).rgb;
  // SSAO multiplies the scene BEFORE bloom/rays are added: halos and light
  // shafts are unoccluded light and must not be AO-darkened.
  hdr *= mix(1.0, texture2D(tAO, vUv).r, uSsao);
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  hdr += bloom * bloomStrength * uBloom;

  // God rays: additive, but CAPPED so a sunset frame keeps colour separation
  // instead of washing to monochrome. Three guards:
  //   1. soft max on the rays themselves (Reinhard on ray luminance) — peaks
  //      near the sun stay bright but can't blow past the tonemap shoulder;
  //   2. scene-luminance suppression — where the sky is already bright the
  //      add is scaled down (the dark wedges keep the full add => contrast);
  //   3. near-depth fade — geometry within ~15 blocks keeps its texture
  //      (haze there is fog's job); ramps in over ~4..18 world units.
  vec3 rays = texture2D(tRays, vUv).rgb * uRaysTint * uRaysStrength;
  const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
  rays *= 1.0 / (1.0 + 0.30 * dot(rays, LW));
  rays *= 1.0 / (1.0 + 0.55 * dot(hdr, LW));
  float dRaw = texture2D(tDepth, vUv).x;
  float zNdc = dRaw * 2.0 - 1.0;
  float viewDist = (2.0 * uCamNear * uCamFar)
    / max(uCamFar + uCamNear - zNdc * (uCamFar - uCamNear), 1e-4);
  float nearFade = mix(1.0, smoothstep(4.0, 18.0, viewDist), uRaysDepthFade);
  hdr += rays * nearFade;
  hdr *= exposure;

  vec3 color = mix(hdr, aces(hdr), uTonemap);
  color = clamp(color, 0.0, 1.0);

  // Per-biome colour grade — AFTER tonemap, BEFORE vignette. Neutral values
  // (lift 0, gain 1, sat 1) reproduce the ungraded image exactly.
  float gradeLuma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(gradeLuma), color, uGradeSat) * uGradeGain + uGradeLift;
  color = clamp(color, 0.0, 1.0);

  float dist = distance(vUv, vec2(0.5));
  float vig = smoothstep(vigRadius, vigRadius - vigSoftness, dist);
  color *= mix(1.0, mix(1.0 - vigDarkness, 1.0, vig), uVignette);

  // Subtle screen-space dither (interleaved gradient noise, +/- 0.5 LSB on
  // the ENCODED output) — hides banding in the smooth halo/shaft gradients.
  float dn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  gl_FragColor = vec4(linearToSRGB(color) + (dn - 0.5) * (1.0 / 255.0), 1.0);
}
`;

// FXAA 3.11 (compact console variant) — operates on the perceptual/sRGB image.
const FXAA_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 resolution;         // 1.0 / vec2(width, height)
varying vec2 vUv;

#define FXAA_REDUCE_MIN (1.0 / 128.0)
#define FXAA_REDUCE_MUL (1.0 / 8.0)
#define FXAA_SPAN_MAX 8.0

void main() {
  vec2 inv = resolution;
  vec3 rgbNW = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * inv).rgb;
  vec3 rgbNE = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * inv).rgb;
  vec3 rgbSW = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * inv).rgb;
  vec3 rgbSE = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * inv).rgb;
  vec3 rgbM  = texture2D(tDiffuse, vUv).rgb;
  vec3 luma = vec3(0.299, 0.587, 0.114);
  float lNW = dot(rgbNW, luma);
  float lNE = dot(rgbNE, luma);
  float lSW = dot(rgbSW, luma);
  float lSE = dot(rgbSE, luma);
  float lM  = dot(rgbM,  luma);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  vec2 dir;
  dir.x = -((lNW + lNE) - (lSW + lSE));
  dir.y =  ((lNW + lSW) - (lNE + lSE));

  float reduce = max((lNW + lNE + lSW + lSE) * (0.25 * FXAA_REDUCE_MUL), FXAA_REDUCE_MIN);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, -FXAA_SPAN_MAX, FXAA_SPAN_MAX) * inv;

  vec3 rgbA = 0.5 * (
    texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
    texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture2D(tDiffuse, vUv + dir * -0.5).rgb +
    texture2D(tDiffuse, vUv + dir *  0.5).rgb);

  float lB = dot(rgbB, luma);
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}
`;

// ---- small input-sanitising helpers (module-private, allocation-free) ------
function _num(v, fallback) {
  v = +v;
  return Number.isFinite(v) ? v : fallback;
}

// Fill `out` (THREE.Vector3) from an [r,g,b] array, an {x,y,z}/Vector3-like,
// or null/undefined (=> the per-channel defaults). Never allocates.
function _readVec3(out, src, dx, dy, dz) {
  if (src == null) {
    out.set(dx, dy, dz);
  } else if (typeof src.x === 'number') {
    out.set(_num(src.x, dx), _num(src.y, dy), _num(src.z, dz));
  } else {
    out.set(_num(src[0], dx), _num(src[1], dy), _num(src[2], dz));
  }
  return out;
}

export class PostFX {
  constructor(renderer, scene, camera, { quality = 'medium' } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this._enabled = true;
    this._w = 1;
    this._h = 1;
    this._bw = 1;
    this._bh = 1;
    this._dbSize = new THREE.Vector2();

    // Tunable look (public — safe to poke from the integrator/GUI).
    // exposure 1.1 gives a punchier day image; ACES' shoulder keeps the sky
    // gradient from clipping. Threshold 0.75 (down from 0.85) lets glowstone /
    // torches / water speculars feed the bloom without the day sky blooming
    // wholesale (the soft knee ramps contribution in gradually).
    this.exposure = 1.1;
    this.bloomStrength = 0.8;
    this.bloomThreshold = 0.75;
    this.bloomKnee = 0.45;
    this.bloomRadius = 1.3;          // gaussian tap-offset multiplier
    this.vignetteRadius = 0.75;
    this.vignetteSoftness = 0.45;
    this.vignetteDarkness = 0.5;

    // Night boost (0 = day look untouched, 1 = full night). Raises bloom
    // strength + radius, lowers the bright-pass threshold and lifts exposure
    // slightly so emissive halos read clearly in the dark. Driven manually via
    // setNightBoost() (e.g. from sun altitude in the demo) or auto-derived in
    // update(dt, ctx) from ctx.sunDir / ctx.timeOfDay.
    this.nightBoost = 0;
    this._autoNight = true;          // update() drives nightBoost until
                                     // setNightBoost() takes manual control

    // Per-biome colour grade (composite pass, post-tonemap / pre-vignette).
    // The *live* lift/gain vectors double as the composite uniform values —
    // render() eases them toward the *target* set by setGrade() with an
    // exponential smoothing whose time constant gives ~95% settle in ~0.5 s.
    // Neutral defaults => output identical to the pre-grade chain.
    this._gradeLift = new THREE.Vector3(0, 0, 0);       // live (== uniform)
    this._gradeGain = new THREE.Vector3(1, 1, 1);       // live (== uniform)
    this._gradeSat = 1;                                 // live
    this._gradeLiftTarget = new THREE.Vector3(0, 0, 0);
    this._gradeGainTarget = new THREE.Vector3(1, 1, 1);
    this._gradeSatTarget = 1;
    this._gradeTau = 0.5 / 3;        // ~0.5 s to reach ~95% of the target

    // Feature flags (live state). setQuality resets them; toggle() mutates one.
    this.features = {
      bloom: true, tonemap: true, vignette: true, fxaa: true,
      ssao: true, godrays: true,
    };
    this._bloomDiv = 2;
    this._iterations = 1;

    // Sun state for god rays — captured from ctx in update(dt, ctx). Until the
    // first update() with a ctx.sunDir arrives, god rays stay dormant.
    this._sunDir = new THREE.Vector3(0, 1, 0);
    this._hasSun = false;
    this._underwater = false;

    // HDR half-float where available (WebGL2 makes RGBA16F renderable AND
    // filterable); byte fallback on WebGL1 (bloom still works, no HDR headroom).
    const hdrType = renderer.capabilities.isWebGL2
      ? THREE.HalfFloatType
      : THREE.UnsignedByteType;

    const rtCommon = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      format: THREE.RGBAFormat,
      stencilBuffer: false,
      depthBuffer: false,
    };

    // Full-res HDR scene target (needs a depth buffer for scene rendering).
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      ...rtCommon,
      type: hdrType,
      depthBuffer: true,
    });
    this.sceneRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.sceneRT.texture.generateMipmaps = false;

    // Attach a depth TEXTURE to the scene target so SSAO + god rays can read
    // scene depth for free (the depth buffer is written anyway; three keeps
    // the texture sized to the RT automatically). WebGL2 always supports
    // this; WebGL1 needs WEBGL_depth_texture — without it both effects are
    // skipped and the rest of the chain is untouched.
    const depthOK = renderer.capabilities.isWebGL2 ||
      (renderer.extensions && renderer.extensions.has &&
       renderer.extensions.has('WEBGL_depth_texture'));
    if (depthOK) {
      this._depthTexture = new THREE.DepthTexture(1, 1);
      this.sceneRT.depthTexture = this._depthTexture;
      this.ssao = new SSAOPass({
        samples: 8, radius: 0.8, intensity: 0.55, resolutionDiv: 2,
      });
      this.godrays = new GodRaysPass({ strength: 0.55, type: hdrType });
    } else {
      this._depthTexture = null;
      this.ssao = null;
      this.godrays = null;
    }

    // Bloom ping-pong (downsampled HDR).
    this.bloomA = new THREE.WebGLRenderTarget(1, 1, { ...rtCommon, type: hdrType });
    this.bloomB = new THREE.WebGLRenderTarget(1, 1, { ...rtCommon, type: hdrType });
    this.bloomA.texture.generateMipmaps = false;
    this.bloomB.texture.generateMipmaps = false;

    // Final LDR sRGB target (only used when FXAA is enabled).
    this.ldrRT = new THREE.WebGLRenderTarget(1, 1, {
      ...rtCommon,
      type: THREE.UnsignedByteType,
    });
    this.ldrRT.texture.generateMipmaps = false;

    // 1x1 black texture bound to tBloom when bloom is off (no allocation churn).
    this._blackTex = new THREE.DataTexture(
      new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat,
    );
    this._blackTex.needsUpdate = true;

    // 1x1 white texture bound to tAO when SSAO is off (ao = 1 => no darkening).
    this._whiteTex = new THREE.DataTexture(
      new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat,
    );
    this._whiteTex.needsUpdate = true;

    // Fullscreen triangle + ortho camera (reused by every pass).
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(
      new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this._geo = geo;
    this._quad = new THREE.Mesh(geo, null);
    this._quad.frustumCulled = false;
    this._fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Pass materials (built once, uniform values mutated in place).
    const mk = (frag, uniforms) => new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.brightMat = mk(BRIGHT_FRAG, {
      tDiffuse: { value: null },
      threshold: { value: this.bloomThreshold },
      knee: { value: this.bloomKnee },
    });
    this.blurMat = mk(BLUR_FRAG, {
      tDiffuse: { value: null },
      direction: { value: new THREE.Vector2() },
      radius: { value: this.bloomRadius },
    });
    this.compositeMat = mk(COMPOSITE_FRAG, {
      tScene: { value: null },
      tBloom: { value: null },
      tAO: { value: this._whiteTex },
      tRays: { value: this._blackTex },
      tDepth: { value: this._whiteTex },
      uSsao: { value: 0 },
      uRaysTint: { value: new THREE.Color(1, 0.8, 0.6) },
      uRaysStrength: { value: 0 },
      uRaysDepthFade: { value: 0 },
      uCamNear: { value: 0.1 },
      uCamFar: { value: 1000 },
      exposure: { value: this.exposure },
      bloomStrength: { value: this.bloomStrength },
      uBloom: { value: 1 },
      uTonemap: { value: 1 },
      uVignette: { value: 1 },
      vigRadius: { value: this.vignetteRadius },
      vigSoftness: { value: this.vignetteSoftness },
      vigDarkness: { value: this.vignetteDarkness },
      // Grade uniforms share the live vectors — lerped in place, never realloc.
      uGradeLift: { value: this._gradeLift },
      uGradeGain: { value: this._gradeGain },
      uGradeSat: { value: this._gradeSat },
    });
    this.fxaaMat = mk(FXAA_FRAG, {
      tDiffuse: { value: null },
      resolution: { value: new THREE.Vector2() },
    });

    // Bound pass runner handed to the SSAO / god-rays pass objects (built
    // once — no per-frame closure allocation).
    this._passFn = (material, target) => this._pass(material, target);

    this.setQuality(quality);
    this.setSize(); // auto-detect from renderer drawing buffer
  }

  get enabled() {
    return this._enabled;
  }

  setEnabled(on) {
    this._enabled = !!on;
  }

  // Individually override a feature.
  // Names: 'bloom','tonemap','vignette','fxaa','ssao','godrays'.
  toggle(name, on) {
    if (name in this.features) this.features[name] = !!on;
  }

  // Convenience wrappers over toggle() for the two depth-based effects.
  setSsaoEnabled(on) {
    this.toggle('ssao', on);
  }

  setGodRaysEnabled(on) {
    this.toggle('godrays', on);
  }

  // ---- Runtime look setters (all values are the DAY baseline; nightBoost
  // ---- modulates them per-frame in render() without mutating these). --------

  setExposure(x) {
    this.exposure = Math.max(0, +x || 0);
  }

  setBloomStrength(x) {
    this.bloomStrength = Math.max(0, +x || 0);
  }

  setBloomThreshold(x) {
    this.bloomThreshold = Math.max(0, +x || 0);
  }

  setBloomRadius(x) {
    this.bloomRadius = Math.max(0.1, +x || 0.1);
  }

  // SSAO blend, 0..1 (default 0.55 — modest on purpose: the baked per-vertex
  // corner AO already carries the look, SSAO only adds contact darkening).
  setSsaoIntensity(x) {
    if (this.ssao) this.ssao.setIntensity(x);
  }

  // SSAO occlusion radius in world units (default 0.8 ≈ one voxel).
  setSsaoRadius(r) {
    if (this.ssao) this.ssao.setRadius(r);
  }

  // God-ray additive weight baseline (default 0.55). The per-frame sun fade
  // (altitude / behind-camera / screen-edge) multiplies on top of this.
  setGodRaysStrength(x) {
    if (this.godrays) this.godrays.setStrength(x);
  }

  // f in 0..1. 0 = clean day grade; 1 = full night: bloom strength ×2.2,
  // threshold ×0.5, radius ×1.45, exposure ×1.25 (a slight lift so the night
  // terrain isn't a pure silhouette while torch halos bloom wide).
  // Taking manual control here disables the update(dt, ctx) auto-drive.
  setNightBoost(f) {
    this.nightBoost = Math.min(1, Math.max(0, +f || 0));
    this._autoNight = false;
  }

  // Re-enable (or disable) auto-deriving nightBoost inside update(dt, ctx).
  setAutoNightBoost(on) {
    this._autoNight = !!on;
  }

  // Per-biome colour grade TARGET. Applied in the composite pass AFTER
  // tonemapping and BEFORE vignette/FXAA:
  //   c = mix(vec3(luma(c)), c, sat) * gain + lift
  // The live values ease toward this target inside render() (~0.5 s), so
  // biome transitions cross-fade instead of popping. `lift`/`gain` accept
  // [r,g,b] arrays or {x,y,z}/Vector3-likes; omitted fields reset to neutral
  // (lift [0,0,0], gain [1,1,1], sat 1) — setGrade() alone returns to neutral.
  setGrade({ lift, gain, sat } = {}) {
    _readVec3(this._gradeLiftTarget, lift, 0, 0, 0);
    _readVec3(this._gradeGainTarget, gain, 1, 1, 1);
    this._gradeSatTarget = _num(sat, 1);
  }

  // Effects-contract hook (optional — render() alone still works, though god
  // rays stay dormant until a ctx.sunDir has been seen here). Captures the
  // sun direction + underwater flag for the god-ray pass, then — when auto
  // night boost is active — derives nightBoost from the sun altitude:
  // 0 while the sun is above ~0.12, ramping to 1 once it dips below ~-0.15.
  update(dt, ctx) {
    if (!ctx) return;

    // Sun capture for god rays (works even when night boost is manual).
    if (ctx.sunDir && typeof ctx.sunDir.y === 'number') {
      this._sunDir.set(ctx.sunDir.x, ctx.sunDir.y, ctx.sunDir.z);
      this._hasSun = true;
    }
    this._underwater = !!ctx.underwater;

    if (!this._autoNight) return;
    let alt = null;
    if (ctx.sunDir && typeof ctx.sunDir.y === 'number') {
      alt = ctx.sunDir.y; // sunDir points toward the sun => y is sun altitude
    } else if (typeof ctx.timeOfDay === 'number') {
      // 0 = midnight, 0.25 = sunrise, 0.5 = noon.
      alt = Math.sin((ctx.timeOfDay - 0.25) * Math.PI * 2);
    }
    if (alt === null) return;
    // smoothstep from alt=0.12 (day, boost 0) down to alt=-0.15 (night, boost 1)
    const t = Math.min(1, Math.max(0, (0.12 - alt) / 0.27));
    this.nightBoost = t * t * (3 - 2 * t);
  }

  setQuality(q) {
    const preset = QUALITY[q] || QUALITY.medium;
    this.quality = QUALITY[q] ? q : 'medium';
    this._iterations = preset.iterations;
    // Tonemap + vignette are cheap and stay on across tiers.
    this.features = {
      bloom: preset.bloom,
      tonemap: true,
      vignette: true,
      fxaa: preset.fxaa,
      ssao: preset.ssao && !!this.ssao,
      godrays: preset.godrays && !!this.godrays,
    };
    // Resize the bloom buffers if the downsample factor changed.
    if (preset.bloomDiv !== this._bloomDiv) {
      this._bloomDiv = preset.bloomDiv;
      if (this._w > 1) this._resizeBloom();
    }
    // SSAO tier config: 8 samples at medium, 12 at high/ultra; full-res only
    // at ultra. (Recompile happens only when the sample define changes.)
    if (this.ssao) {
      this.ssao.setSamples(preset.ssaoSamples);
      this.ssao.setResolutionDiv(preset.ssaoDiv);
    }
    // God-ray tier config: more taps + a third compounding blur at high/ultra
    // so the longer, higher-contrast shafts stay smooth (still quarter-res).
    if (this.godrays) {
      this.godrays.setTaps(preset.godraysTaps);
      this.godrays.setPasses(preset.godraysPasses);
    }
  }

  // Resize targets. Args are device (drawing-buffer) pixels; omit to auto-detect.
  setSize(w, h) {
    if (w == null || h == null) {
      const s = this.renderer.getDrawingBufferSize(this._dbSize);
      w = s.x; h = s.y;
    }
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (w === this._w && h === this._h) return;
    this._w = w;
    this._h = h;
    this.sceneRT.setSize(w, h);
    this.ldrRT.setSize(w, h);
    this.fxaaMat.uniforms.resolution.value.set(1 / w, 1 / h);
    this._resizeBloom();
    if (this.ssao) this.ssao.setSize(w, h);
    if (this.godrays) this.godrays.setSize(w, h);
  }

  _resizeBloom() {
    const div = this._bloomDiv;
    const bw = Math.max(1, Math.floor(this._w / div));
    const bh = Math.max(1, Math.floor(this._h / div));
    this._bw = bw;
    this._bh = bh;
    this.bloomA.setSize(bw, bh);
    this.bloomB.setSize(bw, bh);
  }

  // Render `material` (with its uniforms already set) into `target` (null=screen).
  _pass(material, target) {
    this._quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this._quad, this._fsCamera);
  }

  render(dt) {
    const r = this.renderer;

    // Bypass: straight scene render, no chain.
    if (!this._enabled) {
      r.setRenderTarget(null);
      r.render(this.scene, this.camera);
      return;
    }

    // Keep targets in sync with the drawing buffer (handles resizes for free).
    const s = r.getDrawingBufferSize(this._dbSize);
    if (s.x !== this._w || s.y !== this._h) this.setSize(s.x, s.y);

    const prevTarget = r.getRenderTarget();
    const prevToneMapping = r.toneMapping;
    // Scene must land in the HDR buffer un-tonemapped and linear.
    r.toneMapping = THREE.NoToneMapping;

    // 1) Scene -> HDR linear buffer (+ depth texture when supported).
    r.setRenderTarget(this.sceneRT);
    r.render(this.scene, this.camera);

    // 1b) SSAO: half-res (full-res at ultra) AO from the depth texture +
    // one 4-tap denoise blur. Skipped entirely when off — zero cost.
    const ssaoOn = !!(this.features.ssao && this.ssao);
    if (ssaoOn) {
      this.ssao.render(this._passFn, this._depthTexture, this.camera);
    }

    // 1c) God rays: CPU sun bookkeeping now (camera matrices are current
    // after the scene render), passes deferred to after the bloom branch.
    // raysActive => the quarter-res mask + 2 radial blurs are worth running.
    const raysOn = !!(this.features.godrays && this.godrays && this._hasSun);
    const raysActive = raysOn &&
      this.godrays.updateSun(this.camera, this._sunDir, this._underwater) > 0.002;

    // Night-boosted effective grade (baselines untouched; nb=0 => exact day
    // look). Wider + stronger + lower-threshold bloom and a slight exposure
    // lift as the sun goes down, so torch/glowstone halos read in the dark.
    const nb = this.nightBoost;
    const effThreshold = this.bloomThreshold * (1 - 0.5 * nb);
    const effStrength = this.bloomStrength * (1 + 1.2 * nb);
    const effRadius = this.bloomRadius * (1 + 0.45 * nb);
    const effExposure = this.exposure * (1 + 0.25 * nb);

    // 2) Bloom branch.
    const bloomOn = this.features.bloom;
    if (bloomOn) {
      // Bright-pass extracts highlights straight into the (downsampled) bloomA.
      this.brightMat.uniforms.tDiffuse.value = this.sceneRT.texture;
      this.brightMat.uniforms.threshold.value = effThreshold;
      this.brightMat.uniforms.knee.value = this.bloomKnee;
      this._pass(this.brightMat, this.bloomA);

      // Separable gaussian ping-pong. Each iteration's tap radius escalates
      // (×1, ×2, ×3, …) so the accumulated kernel spreads far wider than
      // repeated same-width blurs — a broad soft halo from the same tap count.
      // All iterations run on the downsampled buffer, so this stays cheap.
      const dir = this.blurMat.uniforms.direction.value;
      const tx = 1 / this._bw;
      const ty = 1 / this._bh;
      for (let i = 0; i < this._iterations; i++) {
        const rad = effRadius * (i + 1);
        this.blurMat.uniforms.radius.value = rad;
        // Horizontal: bloomA -> bloomB
        this.blurMat.uniforms.tDiffuse.value = this.bloomA.texture;
        dir.set(tx, 0);
        this._pass(this.blurMat, this.bloomB);
        // Vertical: bloomB -> bloomA
        this.blurMat.uniforms.tDiffuse.value = this.bloomB.texture;
        dir.set(0, ty);
        this._pass(this.blurMat, this.bloomA);
      }
    }

    // 2b) God rays: quarter-res sky mask + two 12-tap radial blurs toward the
    // sun. Only runs while the sun fade is non-zero (day, sun on/near screen),
    // so night frames pay nothing.
    if (raysActive) {
      this.godrays.render(this._passFn, this.sceneRT.texture, this._depthTexture);
    }

    // Ease the live per-biome grade toward its setGrade() target. Exponential
    // smoothing (frame-rate independent) with tau = ~0.5s/3, so a new target
    // is ~95% reached in about half a second. Lerps mutate the shared uniform
    // vectors in place — zero allocation.
    const gdt = (typeof dt === 'number' && dt > 0) ? Math.min(dt, 0.25) : 1 / 60;
    const gk = 1 - Math.exp(-gdt / this._gradeTau);
    this._gradeLift.lerp(this._gradeLiftTarget, gk);
    this._gradeGain.lerp(this._gradeGainTarget, gk);
    this._gradeSat += (this._gradeSatTarget - this._gradeSat) * gk;

    // 3) Composite (scene * AO + bloom + rays, exposure, ACES, grade,
    // vignette, sRGB).
    const cu = this.compositeMat.uniforms;
    cu.tScene.value = this.sceneRT.texture;
    cu.tBloom.value = bloomOn ? this.bloomA.texture : this._blackTex;
    cu.tAO.value = ssaoOn ? this.ssao.texture : this._whiteTex;
    cu.uSsao.value = ssaoOn ? 1 : 0;
    if (raysActive) {
      cu.tRays.value = this.godrays.texture;
      cu.uRaysStrength.value = this.godrays.strength * this.godrays.fadeValue;
      cu.uRaysTint.value.copy(this.godrays.tint);
      // Near-field ray guard needs linearised scene depth (guard is neutral
      // when the depth texture is unavailable: white tex + uRaysDepthFade 0).
      cu.tDepth.value = this._depthTexture || this._whiteTex;
      cu.uRaysDepthFade.value = this._depthTexture ? 1 : 0;
      cu.uCamNear.value = this.camera.near || 0.1;
      cu.uCamFar.value = this.camera.far || 1000;
    } else {
      cu.tRays.value = this._blackTex;
      cu.uRaysStrength.value = 0;
      cu.tDepth.value = this._whiteTex;
      cu.uRaysDepthFade.value = 0;
    }
    cu.exposure.value = effExposure;
    cu.bloomStrength.value = effStrength;
    cu.uBloom.value = bloomOn ? 1 : 0;
    cu.uTonemap.value = this.features.tonemap ? 1 : 0;
    cu.uVignette.value = this.features.vignette ? 1 : 0;
    cu.vigRadius.value = this.vignetteRadius;
    cu.vigSoftness.value = this.vignetteSoftness;
    cu.vigDarkness.value = this.vignetteDarkness;
    cu.uGradeSat.value = this._gradeSat; // lift/gain uniforms share the vectors

    if (this.features.fxaa) {
      // Composite -> LDR sRGB buffer, then FXAA -> screen.
      this._pass(this.compositeMat, this.ldrRT);
      this.fxaaMat.uniforms.tDiffuse.value = this.ldrRT.texture;
      this._pass(this.fxaaMat, null);
    } else {
      // Composite straight to screen.
      this._pass(this.compositeMat, null);
    }

    // Restore renderer state.
    r.toneMapping = prevToneMapping;
    r.setRenderTarget(prevTarget);
  }

  dispose() {
    this.sceneRT.dispose();
    this.bloomA.dispose();
    this.bloomB.dispose();
    this.ldrRT.dispose();
    this._blackTex.dispose();
    this._whiteTex.dispose();
    this._geo.dispose();
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this.fxaaMat.dispose();
    if (this._depthTexture) this._depthTexture.dispose();
    if (this.ssao) this.ssao.dispose();
    if (this.godrays) this.godrays.dispose();
  }
}

export default PostFX;
