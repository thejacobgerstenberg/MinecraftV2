// weather/effects/lightning.js
// LightningEffect — default export. Flash-envelope state machine (fast attack, decay, optional double-flash) plus an optional jagged bolt mesh.

import * as THREE from "three";

/** Clamp any value into the 0..1 range; non-finite -> 0. */
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Envelope timing (seconds). Fast attack to a bright peak, then a longer decay. */
const ATTACK = 0.04; // ~40ms rise
const HOLD = 0.12; // ~120ms plateau at full brightness — makes the flash unmistakable and screenshot-robust
const PEAK = 0.09; // ~90ms: resolve the strike() promise here (within the plateau, at full brightness)
const DECAY = 0.34; // ~340ms fall to zero after the plateau
const GAP = 0.06; // pause between the two flashes of a double-flash
const SECOND_SCALE = 0.7; // the second flash is dimmer than the first

/** Bolt geometry: a vertical zigzag of this many segments. */
const BOLT_SEGMENTS = 9;
const BOLT_HEIGHT = 90; // world units, tall enough to read against the sky
const BOLT_JITTER = 8; // horizontal wander per segment
const BOLT_DISTANCE = 140; // how far toward the horizon the bolt sits from the camera

/**
 * LightningEffect drives a scene-wide flash brightness (read by the sky
 * controller each frame) and optionally shows a brief jagged bolt for near
 * strikes. All motion is a CPU-light envelope advanced in update(); no
 * per-vertex work per frame.
 */
export default class LightningEffect {
  /**
   * @param {THREE.Scene} scene scene the optional bolt mesh is added to
   * @param {THREE.Camera} camera camera the bolt is positioned relative to
   * @param {{color?:number, maxBrightness?:number}} [opts]
   */
  constructor(scene, camera, opts = {}) {
    this.scene = scene;
    this.camera = camera;

    this._active = false;
    this._flash = 0; // current brightness 0..1
    this._maxBrightness = clamp01(opts.maxBrightness ?? 1) || 1;

    // Flash envelope state. One "flash" is a list of pulses (1 or 2) with a
    // shared clock; _flashTime advances in update().
    this._flashing = false;
    this._flashTime = 0; // seconds since the current flash began
    this._pulses = []; // [{ start, amp }], sorted by start time
    this._flashDuration = 0; // total time until the envelope is done
    this._far = false;

    // Promise plumbing: strike() resolves at the peak of the first pulse.
    this._peakAt = 0; // absolute _flashTime at which to resolve
    this._peakResolved = true;
    this._pendingResolve = null;

    // Bolt fade (0 when hidden). Only used for near strikes.
    this._boltLevel = 0;
    this._boltDir = new THREE.Vector3(); // scratch for camera-forward bolt placement

    // Build the optional bolt mesh. Defensive: if anything fails, the flash
    // alone still satisfies the contract.
    this.bolt = null;
    this.boltGeometry = null;
    this.boltMaterial = null;
    try {
      this._buildBolt(opts.color ?? 0xdfe8ff);
    } catch {
      this.bolt = null;
    }

    this.setActive(false);
  }

  /**
   * Build the jagged bolt LineSegments (a vertical zigzag) and add it hidden.
   * @param {number} color bolt line color
   * @returns {void}
   */
  _buildBolt(color) {
    // LineSegments needs pairs of vertices; build a connected zigzag by
    // duplicating each interior point (end of one segment = start of next).
    const pts = [];
    let x = 0;
    let z = 0;
    for (let i = 0; i <= BOLT_SEGMENTS; i++) {
      const y = BOLT_HEIGHT * (1 - i / BOLT_SEGMENTS); // top -> bottom
      pts.push(new THREE.Vector3(x, y, z));
      x += (Math.random() - 0.5) * BOLT_JITTER;
      z += (Math.random() - 0.5) * BOLT_JITTER;
    }
    const positions = new Float32Array(BOLT_SEGMENTS * 2 * 3);
    for (let i = 0; i < BOLT_SEGMENTS; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const o = i * 6;
      positions[o + 0] = a.x; positions[o + 1] = a.y; positions[o + 2] = a.z;
      positions[o + 3] = b.x; positions[o + 4] = b.y; positions[o + 5] = b.z;
    }

    this.boltGeometry = new THREE.BufferGeometry();
    this.boltGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    this.boltMaterial = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    this.bolt = new THREE.LineSegments(this.boltGeometry, this.boltMaterial);
    this.bolt.frustumCulled = false;
    this.bolt.renderOrder = 5;
    this.bolt.visible = false;
    if (this.scene) this.scene.add(this.bolt);
  }

  /**
   * Re-randomize the bolt's zigzag so every near strike looks different.
   * @returns {void}
   */
  _regenBolt() {
    if (!this.boltGeometry) return;
    try {
      const attr = this.boltGeometry.getAttribute("position");
      const arr = attr.array;
      const pts = [];
      let x = 0;
      let z = 0;
      for (let i = 0; i <= BOLT_SEGMENTS; i++) {
        const y = BOLT_HEIGHT * (1 - i / BOLT_SEGMENTS);
        pts.push([x, y, z]);
        x += (Math.random() - 0.5) * BOLT_JITTER;
        z += (Math.random() - 0.5) * BOLT_JITTER;
      }
      for (let i = 0; i < BOLT_SEGMENTS; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const o = i * 6;
        arr[o + 0] = a[0]; arr[o + 1] = a[1]; arr[o + 2] = a[2];
        arr[o + 3] = b[0]; arr[o + 4] = b[1]; arr[o + 5] = b[2];
      }
      attr.needsUpdate = true;
    } catch { /* ignore */ }
  }

  /**
   * Position the bolt off toward the horizon relative to the camera, on a
   * randomized bearing, so it reads as distant sky lightning.
   * @returns {void}
   */
  _placeBolt() {
    if (!this.bolt) return;
    try {
      const cam = this.camera && this.camera.position ? this.camera.position : { x: 0, y: 0, z: 0 };
      // Bias the bearing toward the camera's forward direction (projected onto the
      // horizontal plane) so a near strike lands in view rather than behind us.
      let fx = 0, fz = -1;
      if (this.camera && this.camera.getWorldDirection) {
        const d = this.camera.getWorldDirection(this._boltDir);
        if (d && d.x * d.x + d.z * d.z > 1e-6) {
          const inv = 1 / Math.sqrt(d.x * d.x + d.z * d.z);
          fx = d.x * inv; fz = d.z * inv;
        }
      }
      // Rotate the forward bearing by a random spread (±~35°) around the Y axis so
      // every strike differs but stays within the visible cone.
      const spread = (Math.random() - 0.5) * (Math.PI * 70 / 180);
      const cs = Math.cos(spread), sn = Math.sin(spread);
      const rx = fx * cs - fz * sn;
      const rz = fx * sn + fz * cs;
      this.bolt.position.set(
        cam.x + rx * BOLT_DISTANCE,
        cam.y - BOLT_HEIGHT * 0.35,
        cam.z + rz * BOLT_DISTANCE,
      );
    } catch { /* ignore */ }
  }

  /**
   * Begin a flash. Fast attack, bright peak, decay — often a quick double
   * flash. Shows the bolt briefly for near strikes. Retriggers cleanly if a
   * flash is already in progress. Never throws.
   * @param {{far?:boolean}} [opts] far strikes are dimmer and skip the bolt
   * @returns {Promise<{far:boolean}>} resolves at the flash PEAK (~90ms in)
   */
  strike(opts = {}) {
    const far = !!(opts && opts.far);
    try {
      if (!this._active) {
        // Inactive: honor the contract's return shape without any visuals.
        return Promise.resolve({ far });
      }

      // If a previous strike's peak never resolved (rapid retrigger), settle it
      // now so no promise is left dangling.
      if (!this._peakResolved && this._pendingResolve) {
        const r = this._pendingResolve;
        this._pendingResolve = null;
        this._peakResolved = true;
        try { r({ far: this._far }); } catch { /* ignore */ }
      }

      this._far = far;
      this._flashing = true;
      this._flashTime = 0;

      // Base amplitude: near strikes are full-bright, far strikes softer.
      const base = (far ? 0.55 : 1.0) * this._maxBrightness;

      // Decide on a double-flash (~55% of the time) — a second, dimmer pulse.
      const doubled = Math.random() < 0.55;
      this._pulses = [{ start: 0, amp: base }];
      if (doubled) {
        const secondStart = ATTACK + HOLD + DECAY + GAP;
        this._pulses.push({ start: secondStart, amp: base * SECOND_SCALE });
      }
      const last = this._pulses[this._pulses.length - 1];
      this._flashDuration = last.start + ATTACK + HOLD + DECAY;

      // Peak of the FIRST pulse is where we resolve the promise.
      this._peakAt = PEAK;
      this._peakResolved = false;

      // Near strikes get a visible bolt; far strikes skip it (or keep it faint).
      if (this.bolt) {
        if (far) {
          this._boltLevel = 0;
          this.bolt.visible = false;
        } else {
          this._regenBolt();
          this._placeBolt();
          this._boltLevel = 1;
          this.bolt.visible = true;
        }
      }

      return new Promise((resolve) => {
        this._pendingResolve = resolve;
      });
    } catch {
      // Never throw: fall back to an immediately-resolved promise.
      return Promise.resolve({ far });
    }
  }

  /**
   * @returns {number} current flash brightness 0..1 (0 when idle/inactive)
   */
  getFlash() {
    return this._active ? clamp01(this._flash) : 0;
  }

  /**
   * Advance the flash envelope and bolt fade.
   * @param {number} dt seconds since last frame
   * @param {number} elapsed total elapsed seconds (unused; envelope is dt-driven)
   * @returns {void}
   */
  update(dt, elapsed) {
    if (!this._active) {
      this._flash = 0;
      return;
    }
    if (!this._flashing) {
      this._flash = 0;
      return;
    }

    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this._flashTime += step;

    // Resolve the strike() promise at the first-pulse peak.
    if (!this._peakResolved && this._flashTime >= this._peakAt) {
      this._peakResolved = true;
      const r = this._pendingResolve;
      this._pendingResolve = null;
      if (r) { try { r({ far: this._far }); } catch { /* ignore */ } }
    }

    // Sum each pulse's contribution (they don't overlap, but summing is safe).
    let level = 0;
    for (let i = 0; i < this._pulses.length; i++) {
      const p = this._pulses[i];
      const t = this._flashTime - p.start;
      if (t < 0) continue;
      if (t < ATTACK) {
        level += p.amp * (t / ATTACK); // linear rise
      } else if (t < ATTACK + HOLD) {
        level += p.amp; // plateau: hold at full brightness so the flash clearly lands
      } else if (t < ATTACK + HOLD + DECAY) {
        const d = (t - ATTACK - HOLD) / DECAY;
        // Ease-out decay: quick initial drop, gentle tail.
        level += p.amp * (1 - d) * (1 - d);
      }
    }
    this._flash = clamp01(level);

    // Bolt tracks a fast fade after being shown.
    if (this.bolt && this._boltLevel > 0) {
      this._boltLevel = Math.max(0, this._boltLevel - step / 0.35);
      this.boltMaterial.opacity = this._boltLevel * (this._far ? 0.15 : 1.0);
      if (this._boltLevel <= 0) this.bolt.visible = false;
    }

    // End of envelope: settle to idle.
    if (this._flashTime >= this._flashDuration) {
      this._flashing = false;
      this._flash = 0;
      if (!this._peakResolved && this._pendingResolve) {
        // Extremely short envelope edge case — resolve now.
        this._peakResolved = true;
        const r = this._pendingResolve;
        this._pendingResolve = null;
        try { r({ far: this._far }); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Show or hide the effect. When inactive, any in-progress flash is cancelled,
   * the bolt is hidden, and getFlash() returns 0.
   * @param {boolean} active
   * @returns {void}
   */
  setActive(active) {
    this._active = !!active;
    if (!this._active) {
      this._flashing = false;
      this._flash = 0;
      this._boltLevel = 0;
      this._pulses = [];
      if (this.bolt) {
        this.bolt.visible = false;
        if (this.boltMaterial) this.boltMaterial.opacity = 0;
      }
      // Settle any dangling peak promise so callers never hang.
      if (!this._peakResolved && this._pendingResolve) {
        this._peakResolved = true;
        const r = this._pendingResolve;
        this._pendingResolve = null;
        try { r({ far: this._far }); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Remove the bolt from the scene and dispose GPU resources. Safe to call
   * repeatedly.
   * @returns {void}
   */
  dispose() {
    try {
      if (this.scene && this.bolt) this.scene.remove(this.bolt);
    } catch { /* ignore */ }
    try {
      if (this.boltGeometry) this.boltGeometry.dispose();
    } catch { /* ignore */ }
    try {
      if (this.boltMaterial) this.boltMaterial.dispose();
    } catch { /* ignore */ }
    // Resolve any pending promise so nothing hangs after disposal.
    try {
      if (!this._peakResolved && this._pendingResolve) {
        this._peakResolved = true;
        const r = this._pendingResolve;
        this._pendingResolve = null;
        r({ far: this._far });
      }
    } catch { /* ignore */ }
    this._active = false;
    this._flashing = false;
    this._flash = 0;
  }
}
