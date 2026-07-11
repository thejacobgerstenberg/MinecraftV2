// weather/effects/snow.js
// SnowEffect — default export. GPU-driven snow: soft round flakes drifting and swaying via a vertex/fragment ShaderMaterial.

import * as THREE from "three";

/** Clamp any value into the 0..1 range; non-finite -> 0. */
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Maximum flakes allocated (visible count scales with intensity via draw range). */
const MAX_COUNT = 9000;

/** Camera-following emit volume (world units). Flakes wrap within this box. */
const BOX_W = 60;
const BOX_H = 40;
const BOX_D = 60;

const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uHeight;   // vertical span of the wrap volume
  uniform float uFall;     // fall speed (units/sec)
  uniform float uSize;     // base point size
  uniform float uPixel;    // pixel scale for size attenuation

  attribute float aSeed;   // per-flake random phase 0..1
  attribute float aSpeed;  // per-flake fall multiplier ~0.6..1.4
  attribute float aScale;  // per-flake size multiplier ~0.6..1.4

  varying float vSeed;

  void main() {
    vSeed = aSeed;

    vec3 p = position;

    // Slow fall, wrapped into [0, uHeight) then centered around the volume origin.
    float phase = aSeed * 6.2831853;
    float fallen = uTime * uFall * aSpeed + aSeed * uHeight;
    p.y = mod(position.y - fallen, uHeight) - uHeight * 0.5;

    // Gentle horizontal sway (two out-of-phase sines) so flakes flutter.
    float t = uTime + phase;
    p.x += sin(t * 0.7) * 1.4 + sin(t * 1.9 + aSeed) * 0.5;
    p.z += cos(t * 0.6 + aSeed) * 1.4;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    // Size attenuation: shrink with distance from the camera. Clamp the near
    // distance and cap the final size so a very-near flake can't balloon into a
    // large soft-focus disc (bokeh smudge) directly in front of the camera.
    float ps = uSize * aScale * uPixel / max(-mv.z, 4.0);
    gl_PointSize = min(ps, 40.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  precision mediump float;
  uniform float uOpacity;
  varying float vSeed;

  void main() {
    // Radial soft flake: alpha falls off from center, no texture needed.
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float alpha = smoothstep(0.5, 0.15, d);
    if (alpha <= 0.001) discard;
    // Slight per-flake brightness variance keeps the field from looking flat.
    float b = 0.9 + 0.1 * vSeed;
    gl_FragColor = vec4(vec3(b), alpha * uOpacity);
  }
`;

/**
 * SnowEffect renders a single-draw-call Points system of soft flakes that
 * slowly fall and sway inside a camera-following volume. Motion is computed
 * entirely in the vertex shader from a time uniform.
 */
export default class SnowEffect {
  /**
   * @param {THREE.Scene} scene scene to add the flake system to
   * @param {THREE.Camera} camera camera the emit volume follows
   * @param {{color?:number, fall?:number, size?:number}} [opts]
   */
  constructor(scene, camera, opts = {}) {
    this.scene = scene;
    this.camera = camera;

    this._active = false;
    this._intensity = 0;
    this._maxCount = MAX_COUNT;

    const positions = new Float32Array(this._maxCount * 3);
    const seeds = new Float32Array(this._maxCount);
    const speeds = new Float32Array(this._maxCount);
    const scales = new Float32Array(this._maxCount);

    for (let i = 0; i < this._maxCount; i++) {
      positions[i * 3 + 0] = (Math.random() - 0.5) * BOX_W;
      positions[i * 3 + 1] = Math.random() * BOX_H;
      positions[i * 3 + 2] = (Math.random() - 0.5) * BOX_D;
      seeds[i] = Math.random();
      speeds[i] = 0.6 + Math.random() * 0.8;
      scales[i] = 0.6 + Math.random() * 0.8;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    geom.setAttribute("aSpeed", new THREE.BufferAttribute(speeds, 1));
    geom.setAttribute("aScale", new THREE.BufferAttribute(scales, 1));
    geom.setDrawRange(0, 0); // start with nothing visible
    this.geometry = geom;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uHeight: { value: BOX_H },
        uFall: { value: opts.fall ?? 2.2 },
        uSize: { value: opts.size ?? 90 },
        uPixel: { value: 1 },
        uOpacity: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(geom, this.material);
    this.points.frustumCulled = false; // volume follows the camera
    this.points.renderOrder = 2;

    if (this.scene) this.scene.add(this.points);

    this.setActive(false);
  }

  /**
   * Set absolute intensity. Scales visible flake count (draw range) and opacity.
   * @param {number} v intensity 0..1
   * @returns {void}
   */
  setIntensity(v) {
    this._intensity = clamp01(v);
    const count = Math.round(this._intensity * this._maxCount);
    try {
      this.geometry.setDrawRange(0, count);
    } catch { /* geometry may be disposed; ignore */ }
    // Ease opacity up quickly so light snow is still visible.
    this.material.uniforms.uOpacity.value = this._active
      ? 0.35 + this._intensity * 0.55
      : 0;
  }

  /**
   * Advance the time uniform and keep the emit volume centered on the camera.
   * @param {number} dt seconds since last frame
   * @param {number} elapsed total elapsed seconds
   * @returns {void}
   */
  update(dt, elapsed) {
    if (!this._active) return;
    const u = this.material.uniforms;
    u.uTime.value = Number.isFinite(elapsed) ? elapsed : u.uTime.value + (dt || 0);
    if (this.camera && this.camera.position) {
      this.points.position.copy(this.camera.position);
    }
  }

  /**
   * Show or hide the flake system. When inactive, opacity is zeroed and
   * per-frame work is skipped.
   * @param {boolean} active
   * @returns {void}
   */
  setActive(active) {
    this._active = !!active;
    this.points.visible = this._active;
    this.material.uniforms.uOpacity.value = this._active
      ? 0.35 + this._intensity * 0.55
      : 0;
  }

  /**
   * Remove from the scene and dispose GPU resources. Safe to call repeatedly.
   * @returns {void}
   */
  dispose() {
    try {
      if (this.scene && this.points) this.scene.remove(this.points);
    } catch { /* ignore */ }
    try {
      if (this.geometry) this.geometry.dispose();
    } catch { /* ignore */ }
    try {
      if (this.material) this.material.dispose();
    } catch { /* ignore */ }
    this._active = false;
  }
}
