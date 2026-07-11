// avatars-plus/camera.js
// Third-person / first-person view controller with ray-marched world collision pull-in.

import * as THREE from "three";

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Hard pitch clamp shared with the rig (rig PITCH_LIMIT = 1.2 rad). */
const PITCH_LIMIT = 1.2;

/** Finite-or-fallback scalar guard. */
const num = (v, d) => (Number.isFinite(v) ? v : d);

/** Ordered view cycle. */
const MODES = ["first", "third-back", "third-front"];

/**
 * ThirdPersonCamera drives a THREE.PerspectiveCamera between first-person and two
 * third-person framings (behind / in front of the avatar). Third-person modes
 * ray-march from the eye toward the desired boom position against an injected world
 * solidity test and pull the camera in before the first solid cell, then smooth the
 * boom length so the pull-in/release is not jarring. Never throws; no per-frame allocs.
 */
export class ThirdPersonCamera {
  /**
   * @param {THREE.Camera} camera - the perspective camera to drive.
   * @param {{ isSolid?: (x:number,y:number,z:number)=>boolean, eyeHeight?: number,
   *          backDistance?: number, frontDistance?: number, collisionRadius?: number,
   *          minDistance?: number, smoothRate?: number, step?: number }} [opts]
   */
  constructor(camera, opts = {}) {
    this.camera = camera || null;
    const o = opts || {};

    /** @type {(x:number,y:number,z:number)=>boolean} injected world solidity. */
    this.isSolid =
      typeof o.isSolid === "function" ? o.isSolid : () => false;

    this.eyeHeight = num(o.eyeHeight, 1.62);
    this.backDistance = Math.max(0, num(o.backDistance, 3.2));
    this.frontDistance = Math.max(0, num(o.frontDistance, 2.4));
    this.collisionRadius = Math.max(0, num(o.collisionRadius, 0.25));
    this.minDistance = Math.max(0, num(o.minDistance, 0.4));
    this._smoothRate = Math.max(0, num(o.smoothRate, 12));
    this._step = Math.max(0.02, num(o.step, 0.1)); // ray-march step (m)

    /** @type {"first"|"third-back"|"third-front"} */
    this._mode = "third-back";

    // Smoothed collision-limited boom length (per third-person mode target).
    this._dist = this.backDistance;

    if (this.camera && this.camera.rotation) this.camera.rotation.order = "YXZ";

    // --- preallocated scratch (no per-frame allocation) ---
    this._eye = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._marchDir = new THREE.Vector3();
    this._probe = new THREE.Vector3();
  }

  /** Current view mode. @returns {"first"|"third-back"|"third-front"} */
  get viewMode() {
    return this._mode;
  }

  /**
   * Set the view mode. Unknown values are ignored (never throws).
   * @param {"first"|"third-back"|"third-front"} mode
   */
  setViewMode(mode) {
    if (MODES.indexOf(mode) !== -1) this._mode = mode;
  }

  /** Advance first -> third-back -> third-front -> first. */
  cycleViewMode() {
    const i = MODES.indexOf(this._mode);
    this._mode = MODES[(i + 1) % MODES.length];
  }

  /**
   * Whether the local player's own avatar should be rendered (hidden in first-person
   * so the body does not occlude the view).
   * @returns {boolean}
   */
  shouldShowLocalAvatar() {
    return this._mode !== "first";
  }

  /**
   * Per-frame update. Positions and orients the camera for the active mode.
   * @param {number} dt - seconds since last update.
   * @param {{x:number,y:number,z:number}} playerFeet - avatar feet-origin position.
   * @param {number} yaw - body yaw (rad); yaw=0 faces -Z.
   * @param {number} pitch - view pitch (rad); clamped to +-PITCH_LIMIT.
   */
  update(dt, playerFeet, yaw, pitch) {
    if (!this.camera) return;
    const fdt = num(dt, 0);
    const feet = playerFeet || { x: 0, y: 0, z: 0 };
    const fx = num(feet.x, 0);
    const fy = num(feet.y, 0);
    const fz = num(feet.z, 0);
    const y = num(yaw, 0);
    let p = num(pitch, 0);
    if (p > PITCH_LIMIT) p = PITCH_LIMIT;
    else if (p < -PITCH_LIMIT) p = -PITCH_LIMIT;

    // Eye anchor: +0.3 horizontal centering (avatar is column-centered at +0.3),
    // eyeHeight above the feet plane.
    this._eye.set(fx + 0.3, fy + this.eyeHeight, fz + 0.3);

    // Forward look direction for YXZ (yaw=0 -> -Z; +pitch -> up). Unit length.
    const cp = Math.cos(p);
    this._look.set(-Math.sin(y) * cp, Math.sin(p), -Math.cos(y) * cp);

    if (this._mode === "first") {
      this.camera.position.copy(this._eye);
      this.camera.rotation.set(p, y, 0); // order YXZ set in ctor
      // keep smoothed boom sane for a later switch to third-person
      this._dist = this.backDistance;
      return;
    }

    // --- third-person: choose boom direction & target length ---
    const front = this._mode === "third-front";
    // third-back: camera sits opposite the look dir (behind); front: along look dir.
    if (front) this._marchDir.copy(this._look);
    else this._marchDir.copy(this._look).multiplyScalar(-1);
    const maxDist = front ? this.frontDistance : this.backDistance;

    // Ray-march from the eye toward the desired boom position; stop just before the
    // first solid cell (minus collisionRadius) so the camera does not clip through walls.
    const limited = this._marchCollision(maxDist);

    // Smooth the boom length. Pull IN immediately (avoid a frame of wall clipping);
    // ease OUT when space reopens.
    if (limited < this._dist) {
      this._dist = limited;
    } else {
      const k = clamp01(1 - Math.exp(-this._smoothRate * fdt));
      this._dist += (limited - this._dist) * k;
    }

    this.camera.position.set(
      this._eye.x + this._marchDir.x * this._dist,
      this._eye.y + this._marchDir.y * this._dist,
      this._eye.z + this._marchDir.z * this._dist
    );
    // Both third modes look back at the eye (avatar stays centered); lookAt uses
    // THREE's internal temporaries, so no allocation here.
    this.camera.lookAt(this._eye);
  }

  /**
   * March from the eye along this._marchDir up to maxDist, sampling world solidity.
   * @param {number} maxDist
   * @returns {number} collision-limited boom length (>= minDistance).
   * @private
   */
  _marchCollision(maxDist) {
    const step = this._step;
    let t = step;
    while (t <= maxDist) {
      this._probe.set(
        this._eye.x + this._marchDir.x * t,
        this._eye.y + this._marchDir.y * t,
        this._eye.z + this._marchDir.z * t
      );
      let solid = false;
      try {
        solid = !!this.isSolid(this._probe.x, this._probe.y, this._probe.z);
      } catch (_e) {
        solid = false; // defensive: a throwing solidity test must not break the camera
      }
      if (solid) {
        const hit = t - this.collisionRadius;
        return hit < this.minDistance ? this.minDistance : hit;
      }
      t += step;
    }
    return maxDist < this.minDistance ? this.minDistance : maxDist;
  }
}
