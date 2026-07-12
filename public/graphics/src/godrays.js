// graphics-lab/src/godrays.js
//
// CREPUSCULAR GOD RAYS — pass pieces for the custom PostFX chain.
//
// Cheap radial-blur light shafts (GPU Gems 3 ch. 13 style), owned by this
// module and wired by postprocessing.js through its fullscreen-triangle pass
// runner. No second scene render: the occlusion pre-pass reuses the main HDR
// colour buffer masked by depth — pixels at the far plane (sky dome, sun disc,
// stars, clouds) keep their colour, geometry goes black. Everything runs at
// QUARTER resolution.
//
// Pipeline (render()):
//   1. Mask pass  (sceneRT colour + depth -> rtA, quarter res):
//        HIGH-CONTRAST occlusion mask. Sky colour (depth >= far threshold) is
//        Reinhard-compressed, then threshold+power shaped so dim sky drops to
//        black and only genuinely bright sky feeds the shafts — geometry is
//        hard black, so occluder silhouettes carve dark wedges into the light
//        (that mask contrast IS the shaft structure). The hard-edged square
//        sun quad is defused by the compression and replaced as the shaft
//        driver by an analytic ROUND gaussian core around the sun's screen
//        position (feathered here, in the mask — the sky module's square sun
//        is untouched). Windowed by distance to the sun so far-away sky
//        doesn't smear across the whole frame.
//   2. Radial blur xN (TAPS taps each, ping-pong rtA <-> rtB): taps march
//        toward the sun's screen-space position with exponential decay
//        (energy-normalised on the CPU). Each iteration blurs the previous
//        result with a longer reach, compounding to TAPS^N effective taps.
//        A per-pixel interleaved-gradient-noise jitter offsets each pixel's
//        tap ladder to hide banding.
//   3. postprocessing.js ADDs the result into the composite before
//        tonemapping: hdr += rays * tint * (strength * fade), luminance-
//        suppressed + near-depth-faded there so the frame keeps colour
//        separation and near terrain keeps texture.
//
// updateSun() runs on the CPU each frame (allocation-free scratch): it
// projects cameraPos + sunDir * 1000 to screen UV, and computes a combined
// fade from (a) sun behind camera (dot(camForward, sunDir)), (b) sun off
// screen (NDC edge falloff), (c) sun altitude — rays are strongest at
// sunrise/sunset, subtle at noon, and off at night — and (d) underwater.
// It also derives the warm sun tint from altitude (horizon orange -> pale
// warm white at noon). When fade == 0 postprocessing.js skips the passes
// entirely, so god rays cost nothing at night.
//
// Public API (backward compatible — all previous members unchanged):
//   new GodRaysPass({ strength, decay, maskRadius, type })
//   setSize(w, h)            // FULL drawing-buffer px; quarter-res inside
//   setStrength(x)           // composite add weight baseline (default 0.55)
//   setDecay(d)              // per-tap decay 0.5..0.999 (default 0.92),
//                            // weight-normalised so energy stays constant
//   setTaps(n)               // taps per radial pass (4..32; default 12).
//                            // Triggers a one-off shader recompile.
//   setPasses(n)             // radial blur iterations (1..3; default 2)
//   updateSun(camera, sunDir, underwater) -> fade 0..1
//   get fadeValue()          // last computed fade
//   get active()             // fade > epsilon (passes worth running)
//   get tint()               // THREE.Color — altitude-derived warm sun tint
//   render(pass, sceneTexture, depthTexture) -> bool (false when faded out)
//   get texture()            // final rays texture (quarter res)
//   dispose()

import * as THREE from 'three';

export const GODRAYS_TAPS = 12;    // default taps per radial pass
const RES_DIV = 4;                 // quarter resolution, all tiers
const SUN_DISTANCE = 1000;         // "at infinity" projection distance

// Per-pass density (march reach as a fraction of pixel->sun distance).
// Short reach first, longest last: the compounding keeps fine wedge detail
// near silhouettes while still stretching the streaks all the way out.
const PASS_DENSITIES = {
  1: [1.0],
  2: [0.35, 1.0],
  3: [0.22, 0.5, 1.0],
};

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// HIGH-CONTRAST occlusion mask. Geometry (depth below the far threshold) is
// hard black; sky keeps its colour but is Reinhard-compressed then shaped by
// a luminance threshold + power curve, so dim sky contributes nothing and the
// bright band around the sun contributes strongly — after the radial blur,
// occluder silhouettes read as crisp dark wedges instead of uniform haze.
// The square HDR sun quad is compressed flat and superseded by an analytic
// round gaussian core (uSunSigma feather) so the shaft/halo source has no
// hard edge. Windowed around the sun's screen position so far-away sky
// doesn't smear across the whole frame.
const MASK_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uSunUV;
uniform float uAspect;
uniform float uMaskRadius;
uniform float uThreshold;   // luminance floor AFTER Reinhard compression
uniform float uPower;       // contrast exponent (>1 => carve harder)
uniform float uSkyGain;     // shaped-sky amplitude (the wedge signal)
uniform float uSunSigma;    // analytic round sun core radius (aspect-corr UV)
uniform float uSunGain;     // analytic sun core brightness
varying vec2 vUv;

#define SKY_DEPTH 0.9998

void main() {
  float depth = texture2D(tDepth, vUv).x;
  float sky = step(SKY_DEPTH, depth);

  // Reinhard-compress the HDR scene colour: the clipped square sun quad
  // (values >> 1) flattens toward the surrounding halo, so its hard edge
  // can't survive into the blurred shafts.
  vec3 c = texture2D(tScene, vUv).rgb;
  c = c / (1.0 + c);

  // Threshold + power shaping (hue-preserving): output luminance becomes
  // pow(clamp((lum - t) / (1 - t)), power) — dim sky -> black, bright sky
  // boosted. This is the contrast that makes the wedges read.
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float shaped = pow(clamp((lum - uThreshold) / max(1.0 - uThreshold, 1e-3), 0.0, 1.0), uPower);
  vec3 col = c * (shaped * uSkyGain / max(lum, 1e-4));

  vec2 d = vUv - uSunUV;
  d.x *= uAspect;
  float r = length(d);

  // Analytic ROUND feathered sun core (gaussian => no edge at all). This —
  // not the square quad — is what the radial blur streaks outward.
  float core = exp(-(r * r) / max(uSunSigma * uSunSigma, 1e-6));

  // Radial window: only sky near the sun feeds the shafts.
  float w = 1.0 - smoothstep(uMaskRadius * 0.2, uMaskRadius, r);
  gl_FragColor = vec4((col + vec3(core) * uSunGain) * sky * w, 1.0);
}
`;

// Radial blur toward the sun. TAPS is a compile-time define => static loop.
// uWeight is pre-normalised on the CPU (1 / sum(decay^i)) so overall energy
// stays constant regardless of decay. The tap ladder start is jittered per
// pixel with interleaved gradient noise (0..1 tap) to hide banding.
const RADIAL_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uSunUV;
uniform float uDensity;
uniform float uDecay;
uniform float uWeight;
varying vec2 vUv;
void main() {
  vec2 delta = (uSunUV - vUv) * (uDensity / float(TAPS));
  // Interleaved gradient noise start-offset: de-bands the tap ladder without
  // extra taps (each pixel starts 0..1 tap along the march).
  float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec2 uv = vUv + delta * j;
  float w = uWeight;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < TAPS; i++) {
    uv += delta;
    sum += texture2D(tDiffuse, uv).rgb * w;
    w *= uDecay;
  }
  gl_FragColor = vec4(sum, 1.0);
}
`;

function _clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function _smoothstep(e0, e1, x) {
  const t = _clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export class GodRaysPass {
  constructor({
    strength = 0.55,
    decay = 0.92,
    maskRadius = 0.6,
    type = THREE.HalfFloatType,
  } = {}) {
    this.strength = Math.max(0, +strength || 0);

    this._fw = 1;                  // full drawing-buffer size
    this._fh = 1;
    this._w = 1;                   // quarter-res buffer size
    this._h = 1;

    this._fade = 0;
    this._tint = new THREE.Color(1, 0.8, 0.6);
    this._taps = GODRAYS_TAPS;
    this._passes = 2;
    this._decay = 0.93;

    // Allocation-free scratch for updateSun().
    this._fwd = new THREE.Vector3();
    this._sunWorld = new THREE.Vector3();
    this._ndc = new THREE.Vector3();
    // Shared by the mask + radial materials (single Vector2, mutated in place).
    this._sunUV = new THREE.Vector2(0.5, 0.5);

    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      format: THREE.RGBAFormat,
      type,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this._rtA = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    this._rtB = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    this._rtA.texture.generateMipmaps = false;
    this._rtB.texture.generateMipmaps = false;
    this._final = this._rtA;       // last ping-pong target (see render())

    const mk = (frag, uniforms, defines) => new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: frag,
      uniforms,
      defines: defines || {},
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.maskMat = mk(MASK_FRAG, {
      tScene: { value: null },
      tDepth: { value: null },
      uSunUV: { value: this._sunUV },
      uAspect: { value: 1 },
      uMaskRadius: { value: Math.max(0.1, +maskRadius || 0.6) },
      uThreshold: { value: 0.30 },
      uPower: { value: 1.8 },
      uSkyGain: { value: 2.0 },
      // Small sigma matters: the core must stay near-POINT-like so occluder
      // shadows have narrow penumbrae — a fat source washes the wedges out.
      uSunSigma: { value: 0.025 },
      uSunGain: { value: 2.6 },
    });

    this.radialMat = mk(RADIAL_FRAG, {
      tDiffuse: { value: null },
      uSunUV: { value: this._sunUV },
      uDensity: { value: 1.0 },
      uDecay: { value: 0.93 },
      uWeight: { value: 1.0 },
    }, { TAPS: this._taps });
    this.setDecay(decay);
  }

  get texture() {
    return this._final.texture;
  }

  get fadeValue() {
    return this._fade;
  }

  get active() {
    return this._fade > 0.002;
  }

  get tint() {
    return this._tint;
  }

  setStrength(x) {
    this.strength = Math.max(0, +x || 0);
  }

  // Per-tap exponential decay (0.5..0.999). Lower = punchier, shorter streaks;
  // the total energy is re-normalised so brightness doesn't drift.
  setDecay(d) {
    this._decay = Math.min(0.999, Math.max(0.5, +d || 0.93));
    this._renormalise();
  }

  // Taps per radial pass (4..32). Changing it swaps the compile-time TAPS
  // define => one-off shader recompile, then re-normalises the tap weights.
  setTaps(n) {
    n = Math.min(32, Math.max(4, Math.round(+n) || GODRAYS_TAPS));
    if (n === this._taps) return;
    this._taps = n;
    this.radialMat.defines.TAPS = n;
    this.radialMat.needsUpdate = true;
    this._renormalise();
  }

  // Radial blur iterations (1..3), each compounding on the previous result.
  setPasses(n) {
    n = Math.min(3, Math.max(1, Math.round(+n) || 2));
    this._passes = n;
  }

  _renormalise() {
    // Normalise total weight: sum of decay^i over the CURRENT tap count.
    let sum = 0;
    let w = 1;
    for (let i = 0; i < this._taps; i++) { sum += w; w *= this._decay; }
    this.radialMat.uniforms.uDecay.value = this._decay;
    this.radialMat.uniforms.uWeight.value = 1 / sum;
  }

  // w/h are FULL drawing-buffer pixels; buffers run at quarter res.
  setSize(w, h) {
    w = Math.max(1, Math.round(w) || 1);
    h = Math.max(1, Math.round(h) || 1);
    if (w === this._fw && h === this._fh) return;
    this._fw = w;
    this._fh = h;
    this.maskMat.uniforms.uAspect.value = w / h;
    const bw = Math.max(1, Math.floor(w / RES_DIV));
    const bh = Math.max(1, Math.floor(h / RES_DIV));
    if (bw === this._w && bh === this._h) return;
    this._w = bw;
    this._h = bh;
    this._rtA.setSize(bw, bh);
    this._rtB.setSize(bw, bh);
  }

  // CPU-side sun bookkeeping — call once per frame AFTER the scene render so
  // camera matrices are current. Returns the combined fade (0 => skip render).
  updateSun(camera, sunDir, underwater = false) {
    const alt = sunDir.y;               // unit vector toward the sun

    // Warm tint from altitude: horizon orange -> pale warm white when high.
    const warmT = _smoothstep(0.05, 0.5, alt);
    this._tint.setRGB(
      1.0,
      0.55 + (0.93 - 0.55) * warmT,
      0.30 + (0.85 - 0.30) * warmT,
    );

    let fade = 0;
    camera.getWorldDirection(this._fwd);
    const facing = this._fwd.dot(sunDir);
    if (!underwater && facing > 0.02 && alt > -0.06) {
      // Project the sun "at infinity" to screen space.
      camera.getWorldPosition(this._sunWorld).addScaledVector(sunDir, SUN_DISTANCE);
      this._ndc.copy(this._sunWorld).project(camera);

      // Screen-edge falloff: full inside the frame, gone past ~1.6 NDC.
      const extent = Math.max(Math.abs(this._ndc.x), Math.abs(this._ndc.y));
      const edge = _clamp01(1 - (extent - 1.0) / 0.6);
      // Behind-camera falloff (facing 0 -> 0.25 ramps in).
      const face = _smoothstep(0.02, 0.25, facing);
      // Altitude: off below the horizon, strongest at sunrise/sunset,
      // deliberately subtle at noon. The ramp tops out just past alt 0 so
      // the ToD 0.25/0.75 golden-hour frames get the full effect.
      const rise = _smoothstep(-0.045, 0.015, alt);
      const noon = 1 - 0.7 * _smoothstep(0.35, 0.85, alt);
      fade = edge * face * rise * noon;

      if (fade > 0) {
        this._sunUV.set(this._ndc.x * 0.5 + 0.5, this._ndc.y * 0.5 + 0.5);
      }
    }
    this._fade = fade;
    return fade;
  }

  // pass = (material, target) => void; sceneTexture/depthTexture come from the
  // PostFX scene RT. Returns false (and renders nothing) when faded out.
  render(pass, sceneTexture, depthTexture) {
    if (this._fade <= 0.002) return false;

    // 1) Quarter-res high-contrast occlusion mask.
    const mu = this.maskMat.uniforms;
    mu.tScene.value = sceneTexture;
    mu.tDepth.value = depthTexture;
    pass(this.maskMat, this._rtA);

    // 2) Compounding radial blurs (short reach first, longest last),
    // ping-ponging rtA <-> rtB. `texture` tracks the last target written.
    const ru = this.radialMat.uniforms;
    const densities = PASS_DENSITIES[this._passes] || PASS_DENSITIES[2];
    let src = this._rtA;
    let dst = this._rtB;
    for (let i = 0; i < densities.length; i++) {
      ru.tDiffuse.value = src.texture;
      ru.uDensity.value = densities[i];
      pass(this.radialMat, dst);
      const t = src; src = dst; dst = t;
    }
    this._final = src;             // last written target

    return true;
  }

  dispose() {
    this._rtA.dispose();
    this._rtB.dispose();
    this.maskMat.dispose();
    this.radialMat.dispose();
  }
}

export default GodRaysPass;
