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
//        sky-only colour (depth >= far threshold), clamped so an HDR sun disc
//        can't blow out, weighted by distance to the sun's screen position so
//        only the sky around the sun feeds the shafts.
//   2. Radial blur x2 (12 taps each, ping-pong rtA -> rtB -> rtA): taps march
//        toward the sun's screen-space position with exponential decay. The
//        second iteration blurs the already-blurred image with a longer reach,
//        compounding to ~144 effective taps.
//   3. postprocessing.js ADDs the result into the composite before
//        tonemapping: hdr += rays * tint * (strength * fade).
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
// Public API:
//   new GodRaysPass({ strength, decay, maskRadius, type })
//   setSize(w, h)            // FULL drawing-buffer px; quarter-res inside
//   setStrength(x)           // composite add weight baseline (default 0.55)
//   updateSun(camera, sunDir, underwater) -> fade 0..1
//   get fadeValue()          // last computed fade
//   get active()             // fade > epsilon (passes worth running)
//   get tint()               // THREE.Color — altitude-derived warm sun tint
//   render(pass, sceneTexture, depthTexture) -> bool (false when faded out)
//   get texture()            // final rays texture (quarter res)
//   dispose()

import * as THREE from 'three';

export const GODRAYS_TAPS = 12;
const RES_DIV = 4;                 // quarter resolution, all tiers
const SUN_DISTANCE = 1000;         // "at infinity" projection distance

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Occlusion mask: sky pixels (depth at/near the far plane — the sky dome hugs
// ndc z 0.99995) keep their scene colour, geometry occludes (black). Clamped
// so an HDR sun disc can't nuke the blur, and windowed around the sun's
// screen position so far-away sky doesn't smear across the whole frame.
const MASK_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uSunUV;
uniform float uAspect;
uniform float uMaskRadius;
varying vec2 vUv;

#define SKY_DEPTH 0.9998

void main() {
  float depth = texture2D(tDepth, vUv).x;
  float sky = step(SKY_DEPTH, depth);
  vec3 c = min(texture2D(tScene, vUv).rgb, vec3(3.0)) * sky;
  vec2 d = vUv - uSunUV;
  d.x *= uAspect;
  float w = 1.0 - smoothstep(uMaskRadius * 0.2, uMaskRadius, length(d));
  gl_FragColor = vec4(c * w, 1.0);
}
`;

// Radial blur toward the sun. TAPS is a compile-time define => static loop.
// uWeight is pre-normalised on the CPU (1 / sum(decay^i)) so overall energy
// stays constant regardless of decay.
const RADIAL_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uSunUV;
uniform float uDensity;
uniform float uDecay;
uniform float uWeight;
varying vec2 vUv;
void main() {
  vec2 delta = (uSunUV - vUv) * (uDensity / float(TAPS));
  vec2 uv = vUv;
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
    decay = 0.93,
    maskRadius = 0.9,
    type = THREE.HalfFloatType,
  } = {}) {
    this.strength = Math.max(0, +strength || 0);

    this._fw = 1;                  // full drawing-buffer size
    this._fh = 1;
    this._w = 1;                   // quarter-res buffer size
    this._h = 1;

    this._fade = 0;
    this._tint = new THREE.Color(1, 0.8, 0.6);

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
      uMaskRadius: { value: Math.max(0.1, +maskRadius || 0.9) },
    });

    this.radialMat = mk(RADIAL_FRAG, {
      tDiffuse: { value: null },
      uSunUV: { value: this._sunUV },
      uDensity: { value: 1.0 },
      uDecay: { value: 0.93 },
      uWeight: { value: 1.0 },
    }, { TAPS: GODRAYS_TAPS });
    this._setDecay(decay);
  }

  get texture() {
    return this._rtA.texture;
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

  _setDecay(d) {
    d = Math.min(0.999, Math.max(0.5, +d || 0.93));
    // Normalise total weight: sum of decay^i over TAPS taps.
    let sum = 0;
    let w = 1;
    for (let i = 0; i < GODRAYS_TAPS; i++) { sum += w; w *= d; }
    this.radialMat.uniforms.uDecay.value = d;
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
      // deliberately subtle at noon.
      const rise = _smoothstep(-0.04, 0.07, alt);
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

    // 1) Quarter-res occlusion mask.
    const mu = this.maskMat.uniforms;
    mu.tScene.value = sceneTexture;
    mu.tDepth.value = depthTexture;
    pass(this.maskMat, this._rtA);

    // 2) Two compounding radial blurs (short reach, then long).
    const ru = this.radialMat.uniforms;
    ru.tDiffuse.value = this._rtA.texture;
    ru.uDensity.value = 0.35;
    pass(this.radialMat, this._rtB);

    ru.tDiffuse.value = this._rtB.texture;
    ru.uDensity.value = 1.0;
    pass(this.radialMat, this._rtA);

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
