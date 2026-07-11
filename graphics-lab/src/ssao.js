// graphics-lab/src/ssao.js
//
// SCREEN-SPACE AMBIENT OCCLUSION — pass pieces for the custom PostFX chain.
//
// This module owns the SSAO render targets + shader materials; postprocessing.js
// wires them into its fullscreen-triangle pipeline (it passes its private
// `_pass(material, target)` runner into render(), so the whole chain keeps a
// single reused fullscreen triangle and zero per-frame allocation).
//
// Technique (half-res by default, full-res at ultra):
//   1. AO pass: reconstruct the view-space position of each pixel from the
//      scene depth texture (camera.projectionMatrixInverse), derive the normal
//      from screen-space derivatives (no G-buffer needed), then take
//      8–12 golden-angle spiral disk samples rotated per-pixel by a tiny
//      repeating 4x4 cos/sin noise texture (generated on a canvas,
//      deterministic). Each sample is re-projected through the depth buffer,
//      contributing cosine-weighted, range-checked occlusion (samples beyond
//      `radius` fall off to zero, so distant silhouettes never bleed AO).
//      A power curve + intensity blend shape the final term. Sky pixels
//      (depth ~ far plane) early-out to 1.0 — the sky dome hugs the far plane
//      at ndc z 0.99995, so the threshold sits just below that.
//   2. Denoise: one 4-tap box blur (corner-offset taps, each a bilinear 2x2
//      average => a 16-texel box for 4 fetches) into a second RT. The
//      composite pass then upsamples bilinearly and MULTIPLIES the AO term
//      into the scene colour before tonemapping.
//
// The default intensity is deliberately modest (0.55): the voxel mesher
// already bakes per-vertex corner AO, and SSAO here only adds contact
// darkening under overhangs/props — it must complement, not double-darken.
//
// Public API:
//   new SSAOPass({ samples, radius, intensity, power, bias, resolutionDiv })
//   setSize(w, h)          // FULL drawing-buffer px; internal div applied
//   setResolutionDiv(d)    // 2 = half-res (default), 1 = full-res (ultra)
//   setSamples(n)          // 1..12; recompiles the AO shader (quality-change
//                          //        time only, never per frame)
//   setRadius(r)           // world-unit occlusion radius (default 0.8)
//   setIntensity(x)        // 0..1 blend toward full AO (default 0.55)
//   setPower(p) / setBias(b)
//   render(pass, depthTexture, camera)  // pass = (material, target) => void
//   get texture()          // blurred AO texture (r channel; 1 = open)
//   dispose()
//
// Requires a readable depth texture => WebGL2 (or WEBGL_depth_texture on
// WebGL1). postprocessing.js performs that capability gate and simply never
// constructs this pass when depth textures are unavailable.

import * as THREE from 'three';

export const SSAO_MAX_SAMPLES = 12;

// Fullscreen-triangle passthrough (identical contract to postprocessing.js).
const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// AO estimation. SAMPLES / KERNEL_MAX are compile-time defines so the loop is
// static (WebGL1-safe) and dead samples cost nothing.
const AO_FRAG = /* glsl */ `
uniform sampler2D tDepth;        // scene depth (non-linear, 0..1)
uniform sampler2D tNoise;        // 4x4 repeating cos/sin rotation noise
uniform mat4 uProj;              // camera projection matrix
uniform mat4 uProjInverse;       // camera projectionMatrixInverse
uniform vec2 uKernel[KERNEL_MAX];// golden-angle spiral unit-disk offsets
uniform float uRadius;           // occlusion radius in view/world units
uniform float uIntensity;        // 0..1 blend toward full AO
uniform float uBias;             // cosine bias against flat self-occlusion
uniform float uPower;            // contrast curve on the AO term
varying vec2 vUv;

// Sky test: the sky dome hugs the far plane at ndc z = 0.99995 (buffer value
// 0.999975), so anything >= this threshold is sky/far and gets no AO.
#define SKY_DEPTH 0.9998

vec3 viewPos(vec2 uv, float depth) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 v = uProjInverse * ndc;
  return v.xyz / v.w;
}

void main() {
  float depth = texture2D(tDepth, vUv).x;
  if (depth >= SKY_DEPTH) { gl_FragColor = vec4(1.0); return; }

  vec3 P = viewPos(vUv, depth);
  // Normal from position derivatives — points toward the camera for
  // front-facing surfaces (screen x right / y up matches view space).
  vec3 N = normalize(cross(dFdx(P), dFdy(P)));

  // Per-pixel kernel rotation from the repeating 4x4 noise tile.
  vec2 cs = texture2D(tNoise, gl_FragCoord.xy / 4.0).rg * 2.0 - 1.0;
  mat2 rot = mat2(cs.x, cs.y, -cs.y, cs.x);

  // World-unit radius projected into UV space at this pixel's depth.
  vec2 radiusUV = uRadius * 0.5 * vec2(uProj[0][0], uProj[1][1]) / -P.z;

  float radius2 = uRadius * uRadius;
  float occ = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    vec2 suv = vUv + (rot * uKernel[i]) * radiusUV;
    float sd = texture2D(tDepth, suv).x;
    if (sd >= SKY_DEPTH) continue;             // sky never occludes
    vec3 SP = viewPos(suv, sd);
    vec3 v = SP - P;
    float vv = dot(v, v);
    // Range check: occluders beyond uRadius contribute nothing, so distant
    // silhouettes can't smear AO across depth discontinuities.
    float falloff = max(0.0, 1.0 - vv / radius2);
    float vn = dot(v, N) * inversesqrt(vv + 1e-6); // cosine term
    occ += falloff * max(0.0, vn - uBias);
  }
  occ *= 2.0 / float(SAMPLES);

  float ao = pow(clamp(1.0 - occ, 0.0, 1.0), uPower);
  ao = mix(1.0, ao, uIntensity);
  gl_FragColor = vec4(vec3(ao), 1.0);
}
`;

// 4-tap box denoise. Taps sit on texel CORNERS (±0.5 texel), so each fetch is
// a hardware bilinear 2x2 average — 16 texels smoothed for 4 fetches, which
// flattens the 4x4 rotation-noise pattern nicely at half res.
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uTexel;             // 1 / aoBufferSize
varying vec2 vUv;
void main() {
  vec2 o = uTexel * 0.5;
  float a = texture2D(tDiffuse, vUv + vec2(-o.x, -o.y)).r;
  a += texture2D(tDiffuse, vUv + vec2( o.x, -o.y)).r;
  a += texture2D(tDiffuse, vUv + vec2(-o.x,  o.y)).r;
  a += texture2D(tDiffuse, vUv + vec2( o.x,  o.y)).r;
  gl_FragColor = vec4(vec3(a * 0.25), 1.0);
}
`;

// Deterministic tiny PRNG (same family as textures.js — no Math.random).
function _mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 4x4 repeating rotation-noise texture: r/g encode cos/sin of a random angle.
// Painted on a canvas per the pipeline convention (procedural, deterministic);
// falls back to a DataTexture where no DOM exists (tests).
function makeRotationNoiseTexture(seed = 0x51533A0) {
  const size = 4;
  const rand = _mulberry32(seed);
  const px = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = rand() * Math.PI * 2;
    px[i * 4 + 0] = Math.round((Math.cos(a) * 0.5 + 0.5) * 255);
    px[i * 4 + 1] = Math.round((Math.sin(a) * 0.5 + 0.5) * 255);
    px[i * 4 + 2] = 0;
    px[i * 4 + 3] = 255;
  }
  let tex;
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx2d = canvas.getContext('2d');
    const img = ctx2d.createImageData(size, size);
    img.data.set(px);
    ctx2d.putImageData(img, 0, 0);
    tex = new THREE.CanvasTexture(canvas);
  } else {
    tex = new THREE.DataTexture(new Uint8Array(px), size, size, THREE.RGBAFormat);
  }
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Golden-angle spiral over the unit disk: even area coverage, no clumping,
// and per-pixel rotation decorrelates neighbours.
function buildSpiralKernel(count) {
  const GOLDEN = 2.399963229728653;
  const kernel = [];
  for (let i = 0; i < count; i++) {
    const angle = i * GOLDEN;
    const r = Math.sqrt((i + 0.5) / count);
    kernel.push(new THREE.Vector2(Math.cos(angle) * r, Math.sin(angle) * r));
  }
  return kernel;
}

function _clampNum(v, lo, hi, fallback) {
  v = +v;
  if (!Number.isFinite(v)) v = fallback;
  return Math.min(hi, Math.max(lo, v));
}

export class SSAOPass {
  constructor({
    samples = 12,
    radius = 0.8,
    intensity = 0.55,
    power = 1.5,
    bias = 0.12,
    resolutionDiv = 2,
  } = {}) {
    this._fw = 1;               // full drawing-buffer size (device px)
    this._fh = 1;
    this._div = Math.max(1, Math.round(resolutionDiv) || 2);
    this._w = 1;                // AO buffer size (= full / div)
    this._h = 1;
    this._samples = Math.min(SSAO_MAX_SAMPLES, Math.max(1, Math.round(samples) || 8));

    this.radius = radius;
    this.intensity = intensity;

    this._noiseTex = makeRotationNoiseTexture();

    // AO + blur targets. AO is a scalar in [0,1] — byte RGBA is plenty, and
    // linear filtering gives a free smooth upsample in the composite.
    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this._rtA = new THREE.WebGLRenderTarget(1, 1, rtOpts); // raw AO
    this._rtB = new THREE.WebGLRenderTarget(1, 1, rtOpts); // blurred AO
    this._rtA.texture.generateMipmaps = false;
    this._rtB.texture.generateMipmaps = false;

    this.aoMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: AO_FRAG,
      defines: { SAMPLES: this._samples, KERNEL_MAX: SSAO_MAX_SAMPLES },
      uniforms: {
        tDepth: { value: null },
        tNoise: { value: this._noiseTex },
        uProj: { value: new THREE.Matrix4() },
        uProjInverse: { value: new THREE.Matrix4() },
        uKernel: { value: buildSpiralKernel(SSAO_MAX_SAMPLES) },
        uRadius: { value: radius },
        uIntensity: { value: intensity },
        uBias: { value: bias },
        uPower: { value: power },
      },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    // Needed for dFdx/dFdy on WebGL1 (no-op on WebGL2).
    this.aoMat.extensions.derivatives = true;

    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2(1, 1) },
      },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
  }

  // Denoised AO texture (r channel, 1 = fully open) for the composite pass.
  get texture() {
    return this._rtB.texture;
  }

  get samples() {
    return this._samples;
  }

  // w/h are FULL drawing-buffer pixels; the internal div downsamples.
  setSize(w, h) {
    w = Math.max(1, Math.round(w) || 1);
    h = Math.max(1, Math.round(h) || 1);
    if (w === this._fw && h === this._fh) return;
    this._fw = w;
    this._fh = h;
    this._resize();
  }

  // 2 = half-res (medium/high), 1 = full-res (ultra).
  setResolutionDiv(d) {
    d = Math.max(1, Math.round(d) || 2);
    if (d === this._div) return;
    this._div = d;
    if (this._fw > 1 || this._fh > 1) this._resize();
  }

  _resize() {
    const w = Math.max(1, Math.floor(this._fw / this._div));
    const h = Math.max(1, Math.floor(this._fh / this._div));
    if (w === this._w && h === this._h) return;
    this._w = w;
    this._h = h;
    this._rtA.setSize(w, h);
    this._rtB.setSize(w, h);
    this.blurMat.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  // Sample count (8 medium / 12 high+ultra). Changing it edits a define and
  // recompiles the AO shader — quality-change time only, never per frame.
  setSamples(n) {
    n = Math.min(SSAO_MAX_SAMPLES, Math.max(1, Math.round(n) || 1));
    if (n === this._samples) return;
    this._samples = n;
    this.aoMat.defines.SAMPLES = n;
    this.aoMat.needsUpdate = true;
  }

  setRadius(r) {
    this.radius = _clampNum(r, 0.05, 20, 0.8);
    this.aoMat.uniforms.uRadius.value = this.radius;
  }

  setIntensity(x) {
    this.intensity = _clampNum(x, 0, 1, 0.55);
    this.aoMat.uniforms.uIntensity.value = this.intensity;
  }

  setPower(p) {
    this.aoMat.uniforms.uPower.value = _clampNum(p, 0.1, 8, 1.5);
  }

  setBias(b) {
    this.aoMat.uniforms.uBias.value = _clampNum(b, 0, 1, 0.12);
  }

  // pass = (material, target) => void   (postprocessing.js' fullscreen runner)
  // depthTexture = the scene RT's THREE.DepthTexture; camera = scene camera.
  // Zero allocation: uniforms are mutated / reference-assigned in place.
  render(pass, depthTexture, camera) {
    const u = this.aoMat.uniforms;
    u.tDepth.value = depthTexture;
    u.uProj.value = camera.projectionMatrix;               // reference, no copy
    u.uProjInverse.value = camera.projectionMatrixInverse; // reference, no copy
    pass(this.aoMat, this._rtA);

    this.blurMat.uniforms.tDiffuse.value = this._rtA.texture;
    pass(this.blurMat, this._rtB);
  }

  dispose() {
    this._rtA.dispose();
    this._rtB.dispose();
    this.aoMat.dispose();
    this.blurMat.dispose();
    this._noiseTex.dispose();
  }
}

export default SSAOPass;
