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
//   scene ──▶ sceneRT (HDR, half-float, linear)
//         ──▶ bright-pass (soft-knee threshold)        ▲ bloom branch
//         ──▶ separable gaussian blur (downsampled, N iterations, ping-pong)
//         ──▶ COMPOSITE  (scene + bloom*strength, exposure, ACES filmic
//                          tonemap, vignette, sRGB encode)
//         ──▶ [optional FXAA on the final LDR sRGB image]
//         ──▶ screen
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
//   setSize(w, h)              // resize targets (device px; auto-detected too)
//   setQuality('low'|'medium'|'high'|'ultra')
//   toggle('bloom'|'tonemap'|'vignette'|'fxaa', bool)
//   setEnabled(bool)           // false => straight renderer.render (bypass)
//   get enabled()
//   dispose()

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Quality presets.
//   bloom      : bloom branch on/off (still toggleable at runtime).
//   bloomDiv   : bloom-buffer downsample factor (2 = half-res, 1 = full-res).
//   iterations : gaussian H+V ping-pong passes (each widens the bloom).
//   fxaa       : anti-alias the final LDR image.
// Tonemap + vignette live in the single composite pass, so they are ~free and
// stay ON at every tier (still individually toggleable).
// ---------------------------------------------------------------------------
const QUALITY = {
  low:    { bloom: false, bloomDiv: 2, iterations: 1, fxaa: false },
  medium: { bloom: true,  bloomDiv: 2, iterations: 1, fxaa: true  },
  high:   { bloom: true,  bloomDiv: 2, iterations: 2, fxaa: true  },
  ultra:  { bloom: true,  bloomDiv: 1, iterations: 3, fxaa: true  },
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
// both the horizontal and vertical halves.
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 direction;
varying vec2 vUv;
void main() {
  vec2 o1 = direction * 1.3846153846;
  vec2 o2 = direction * 3.2307692308;
  vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
  sum += texture2D(tDiffuse, vUv + o1).rgb * 0.3162162162;
  sum += texture2D(tDiffuse, vUv - o1).rgb * 0.3162162162;
  sum += texture2D(tDiffuse, vUv + o2).rgb * 0.0702702703;
  sum += texture2D(tDiffuse, vUv - o2).rgb * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}
`;

// Composite: additive bloom, exposure, ACES filmic tonemap, vignette, sRGB out.
const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;        // HDR linear scene
uniform sampler2D tBloom;        // blurred bloom (linear, low-res, upsampled)
uniform float exposure;
uniform float bloomStrength;
uniform float uBloom;            // 0/1
uniform float uTonemap;          // 0/1
uniform float uVignette;         // 0/1
uniform float vigRadius;
uniform float vigSoftness;
uniform float vigDarkness;
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
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  hdr += bloom * bloomStrength * uBloom;
  hdr *= exposure;

  vec3 color = mix(hdr, aces(hdr), uTonemap);
  color = clamp(color, 0.0, 1.0);

  float dist = distance(vUv, vec2(0.5));
  float vig = smoothstep(vigRadius, vigRadius - vigSoftness, dist);
  color *= mix(1.0, mix(1.0 - vigDarkness, 1.0, vig), uVignette);

  gl_FragColor = vec4(linearToSRGB(color), 1.0);
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
    this.exposure = 1.0;
    this.bloomStrength = 0.85;
    this.bloomThreshold = 0.85;
    this.bloomKnee = 0.4;
    this.vignetteRadius = 0.75;
    this.vignetteSoftness = 0.45;
    this.vignetteDarkness = 0.5;

    // Feature flags (live state). setQuality resets them; toggle() mutates one.
    this.features = { bloom: true, tonemap: true, vignette: true, fxaa: true };
    this._bloomDiv = 2;
    this._iterations = 1;

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
    });
    this.compositeMat = mk(COMPOSITE_FRAG, {
      tScene: { value: null },
      tBloom: { value: null },
      exposure: { value: this.exposure },
      bloomStrength: { value: this.bloomStrength },
      uBloom: { value: 1 },
      uTonemap: { value: 1 },
      uVignette: { value: 1 },
      vigRadius: { value: this.vignetteRadius },
      vigSoftness: { value: this.vignetteSoftness },
      vigDarkness: { value: this.vignetteDarkness },
    });
    this.fxaaMat = mk(FXAA_FRAG, {
      tDiffuse: { value: null },
      resolution: { value: new THREE.Vector2() },
    });

    this.setQuality(quality);
    this.setSize(); // auto-detect from renderer drawing buffer
  }

  get enabled() {
    return this._enabled;
  }

  setEnabled(on) {
    this._enabled = !!on;
  }

  // Individually override a feature. Names: 'bloom','tonemap','vignette','fxaa'.
  toggle(name, on) {
    if (name in this.features) this.features[name] = !!on;
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
    };
    // Resize the bloom buffers if the downsample factor changed.
    if (preset.bloomDiv !== this._bloomDiv) {
      this._bloomDiv = preset.bloomDiv;
      if (this._w > 1) this._resizeBloom();
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

  render(/* dt */) {
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

    // 1) Scene -> HDR linear buffer.
    r.setRenderTarget(this.sceneRT);
    r.render(this.scene, this.camera);

    // 2) Bloom branch.
    const bloomOn = this.features.bloom;
    if (bloomOn) {
      // Bright-pass extracts highlights straight into the (downsampled) bloomA.
      this.brightMat.uniforms.tDiffuse.value = this.sceneRT.texture;
      this.brightMat.uniforms.threshold.value = this.bloomThreshold;
      this.brightMat.uniforms.knee.value = this.bloomKnee;
      this._pass(this.brightMat, this.bloomA);

      // Separable gaussian ping-pong; each iteration widens the glow.
      const dir = this.blurMat.uniforms.direction.value;
      const tx = 1 / this._bw;
      const ty = 1 / this._bh;
      for (let i = 0; i < this._iterations; i++) {
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

    // 3) Composite (scene + bloom, exposure, ACES, vignette, sRGB).
    const cu = this.compositeMat.uniforms;
    cu.tScene.value = this.sceneRT.texture;
    cu.tBloom.value = bloomOn ? this.bloomA.texture : this._blackTex;
    cu.exposure.value = this.exposure;
    cu.bloomStrength.value = this.bloomStrength;
    cu.uBloom.value = bloomOn ? 1 : 0;
    cu.uTonemap.value = this.features.tonemap ? 1 : 0;
    cu.uVignette.value = this.features.vignette ? 1 : 0;
    cu.vigRadius.value = this.vignetteRadius;
    cu.vigSoftness.value = this.vignetteSoftness;
    cu.vigDarkness.value = this.vignetteDarkness;

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
    this._geo.dispose();
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this.fxaaMat.dispose();
  }
}

export default PostFX;
