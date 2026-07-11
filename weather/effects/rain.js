// weather/effects/rain.js
// GPU-driven rain: camera-following volume of falling streaks in one draw call.

import * as THREE from "three";

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

// Maximum number of rain drops allocated at v=1. Visible count scales via draw range.
const MAX_COUNT = 12000;

// Emit volume dimensions (world units), centered on the camera each frame.
const BOX_W = 60; // x
const BOX_H = 40; // y
const BOX_D = 60; // z

/**
 * RainEffect — a single-draw-call rain system rendered as LineSegments.
 * Each drop is 2 vertices (bottom + top) forming a thin vertical streak. Fall,
 * vertical wrap and wind slant are computed entirely in the vertex shader from a
 * time uniform and per-drop attributes, so the CPU never touches positions.
 */
export default class RainEffect {
  /**
   * @param {THREE.Scene} scene scene the rain mesh is added to
   * @param {THREE.Camera} camera camera the emit volume follows
   * @param {{ color?:number, maxCount?:number, streak?:number, fallSpeed?:number,
   *           wind?:{x:number,z:number}, opacity?:number }} [opts] visual tuning
   */
  constructor(scene, camera, opts = {}) {
    this.scene = scene;
    this.camera = camera;
    this._active = false;
    this._intensity = 0;
    this._maxCount = Math.max(1, Math.floor(opts.maxCount ?? MAX_COUNT));
    this._baseOpacity = Number.isFinite(opts.opacity) ? opts.opacity : 0.62;
    this._baseSpeed = Number.isFinite(opts.fallSpeed) ? opts.fallSpeed : 1;

    const color = new THREE.Color(opts.color ?? 0x9fb4c8);
    const wind = opts.wind || { x: 0.18, z: 0.05 };
    const streak = Number.isFinite(opts.streak) ? opts.streak : 1.8;

    // --- geometry: 2 verts per drop, per-drop attributes duplicated to both ends ---
    const n = this._maxCount;
    const base = new Float32Array(n * 2 * 3); // xyz per vertex
    const seed = new Float32Array(n * 2);
    const speed = new Float32Array(n * 2);
    const end = new Float32Array(n * 2); // 0 = bottom vertex, 1 = top (trailing) vertex

    for (let i = 0; i < n; i++) {
      const bx = (Math.random() - 0.5) * BOX_W;
      const by = (Math.random() - 0.5) * BOX_H;
      const bz = (Math.random() - 0.5) * BOX_D;
      const s = Math.random();
      const sp = 8 + Math.random() * 10; // base fall speed spread (units/sec)
      for (let e = 0; e < 2; e++) {
        const vi = i * 2 + e;
        base[vi * 3 + 0] = bx;
        base[vi * 3 + 1] = by;
        base[vi * 3 + 2] = bz;
        seed[vi] = s;
        speed[vi] = sp;
        end[vi] = e;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("aBase", new THREE.BufferAttribute(base, 3));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    geometry.setAttribute("aSpeed", new THREE.BufferAttribute(speed, 1));
    geometry.setAttribute("aEnd", new THREE.BufferAttribute(end, 1));
    // Vertex 0 must exist for the mesh to have a valid position attribute.
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    geometry.setDrawRange(0, 0); // hidden until intensity > 0
    this._geometry = geometry;

    this._material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uTime: { value: 0 },
        uCamera: { value: new THREE.Vector3() },
        uBoxH: { value: BOX_H },
        uSpeed: { value: this._baseSpeed },
        uStreak: { value: streak },
        uWind: { value: new THREE.Vector3(wind.x, -1, wind.z) },
        uColor: { value: color },
        uOpacity: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aBase;
        attribute float aSeed;
        attribute float aSpeed;
        attribute float aEnd;
        uniform float uTime;
        uniform vec3 uCamera;
        uniform float uBoxH;
        uniform float uSpeed;
        uniform float uStreak;
        uniform vec3 uWind;
        void main() {
          float halfH = uBoxH * 0.5;
          float fall = uTime * aSpeed * uSpeed;
          // wrap vertically so drops recycle within the camera-centered box
          float y = mod(aBase.y - fall + halfH + aSeed * uBoxH, uBoxH) - halfH;
          vec3 p = vec3(aBase.x, y, aBase.z);
          // trailing (top) vertex offset opposite the fall direction => wind-slanted streak
          vec3 velDir = normalize(uWind);
          p -= velDir * uStreak * aEnd;
          vec3 world = uCamera + p;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform vec3 uColor;
        uniform float uOpacity;
        void main() {
          gl_FragColor = vec4(uColor, uOpacity);
        }
      `,
    });

    this._mesh = new THREE.LineSegments(this._geometry, this._material);
    this._mesh.frustumCulled = false; // volume is camera-relative; never cull
    this._mesh.renderOrder = 10;
    this._mesh.visible = false;
    this._tmp = new THREE.Vector3();

    try {
      this.scene.add(this._mesh);
    } catch {
      /* tolerate a missing/invalid scene */
    }

    this.setActive(false);
  }

  /**
   * Set absolute rain intensity.
   * @param {number} v 0..1; scales visible drop count (draw range), opacity and fall speed
   * @returns {void}
   */
  setIntensity(v) {
    const c = clamp01(v);
    this._intensity = c;
    const visible = Math.round(c * this._maxCount);
    try {
      this._geometry.setDrawRange(0, visible * 2);
    } catch {
      /* ignore */
    }
    if (this._material && this._material.uniforms) {
      this._material.uniforms.uOpacity.value = this._active ? this._baseOpacity * (0.4 + 0.6 * c) : 0;
      this._material.uniforms.uSpeed.value = this._baseSpeed * (0.85 + 0.4 * c);
    }
  }

  /**
   * Advance the time uniform and re-center the emit volume on the camera.
   * @param {number} dt seconds since last frame
   * @param {number} elapsed total elapsed seconds (unused; time integrates dt)
   * @returns {void}
   */
  update(dt, elapsed) {
    if (!this._active || !this._material || !this._material.uniforms) return;
    const step = Number.isFinite(dt) ? dt : 0;
    this._material.uniforms.uTime.value += step;
    if (this.camera && this.camera.position) {
      this.camera.getWorldPosition
        ? this.camera.getWorldPosition(this._tmp)
        : this._tmp.copy(this.camera.position);
      this._material.uniforms.uCamera.value.copy(this._tmp);
    }
  }

  /**
   * Show or hide the rain and pause its work when inactive.
   * @param {boolean} active true to render, false to hide and skip updates
   * @returns {void}
   */
  setActive(active) {
    this._active = !!active;
    if (this._mesh) this._mesh.visible = this._active;
    if (this._material && this._material.uniforms) {
      this._material.uniforms.uOpacity.value = this._active
        ? this._baseOpacity * (0.4 + 0.6 * this._intensity)
        : 0;
    }
  }

  /**
   * Remove from the scene and release GPU resources. Safe to call multiple times.
   * @returns {void}
   */
  dispose() {
    try {
      if (this._mesh && this.scene) this.scene.remove(this._mesh);
    } catch {
      /* ignore */
    }
    try {
      if (this._geometry) this._geometry.dispose();
    } catch {
      /* ignore */
    }
    try {
      if (this._material) this._material.dispose();
    } catch {
      /* ignore */
    }
    this._mesh = null;
    this._geometry = null;
    this._material = null;
  }
}
