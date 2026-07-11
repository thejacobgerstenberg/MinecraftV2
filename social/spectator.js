// social/spectator.js
// Free-fly spectator camera: a detached, noclip-optional fly-cam for observing
// the world independently of the player. Unlike ../avatars-plus/camera.js
// (ThirdPersonCamera), which always anchors to the player's feet and offers no
// free-fly mode, this camera integrates its own position from WASD-style input
// in a yaw-oriented basis and (optionally) ray-marches its intended motion
// against an injected world-solidity test so it does not fly through blocks.
//
// The ray-march collision PATTERN is borrowed from ThirdPersonCamera._marchCollision:
// step along the intended move direction and stop just before the first solid
// cell (minus collisionRadius). The no-allocation / scratch-vector discipline is
// likewise borrowed. This file does NOT modify or depend on avatars-plus.
//
// Two input models are provided:
//   - Manual:  setInput({forward,back,left,right,up,down,boost}) + addLook(dx,dy).
//   - Wired:   attach(domElement, {pointerLock}) wires keydown/keyup + mousemove
//              (pointer-lock) itself; detach() tears it back down.
//
// Never throws. No per-frame allocation in update().

import * as THREE from "three";

/* -------------------------------------------------------------------------- */
/* Local helpers (defensive, never throw)                                      */
/* -------------------------------------------------------------------------- */

/** Finite-or-fallback scalar guard. */
const num = (v, d) => (Number.isFinite(v) ? v : d);

/** Pitch clamp (radians) — just shy of straight up/down to avoid gimbal flip. */
const PITCH_LIMIT = 1.54;

/** Default key -> input-flag map for attach(). */
const DEFAULT_KEYMAP = {
  KeyW: "forward",
  KeyS: "back",
  KeyA: "left",
  KeyD: "right",
  Space: "up",
  ShiftLeft: "boost",
  ShiftRight: "boost",
  ControlLeft: "down",
  ControlRight: "down",
};

/* -------------------------------------------------------------------------- */
/* SpectatorCamera                                                             */
/* -------------------------------------------------------------------------- */

export class SpectatorCamera {
  /**
   * @param {THREE.Camera} camera the camera to drive while enabled.
   * @param {{
   *   isSolid?: (x:number,y:number,z:number)=>boolean,
   *   moveSpeed?: number,
   *   boostMultiplier?: number,
   *   lookSensitivity?: number,
   *   collisionRadius?: number,
   *   collide?: boolean,
   *   step?: number,
   * }} [opts]
   */
  constructor(camera, opts = {}) {
    const o = opts && typeof opts === "object" ? opts : {};
    /** @type {THREE.Camera|null} */
    this._camera = camera || null;

    this.isSolid = typeof o.isSolid === "function" ? o.isSolid : () => false;
    this.moveSpeed = Math.max(0, num(o.moveSpeed, 12)); // m/s
    this.boostMultiplier = Math.max(1, num(o.boostMultiplier, 3));
    this.lookSensitivity = num(o.lookSensitivity, 0.0025);
    this.collisionRadius = Math.max(0, num(o.collisionRadius, 0.25));
    this.collide = o.collide !== false;
    this._step = Math.max(0.02, num(o.step, 0.1)); // ray-march step (m)

    this._enabled = false;

    /** Current orientation (radians). */
    this._yaw = 0;
    this._pitch = 0;

    /** Live input flags. */
    this._input = {
      forward: false,
      back: false,
      left: false,
      right: false,
      up: false,
      down: false,
      boost: false,
    };

    // Preallocated scratch — no per-frame allocation in update().
    this._pos = new THREE.Vector3();
    this._move = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._probe = new THREE.Vector3();

    // attach()/detach() state.
    /** @type {HTMLElement|null} */
    this._dom = null;
    this._pointerLock = false;
    this._onKeyDown = null;
    this._onKeyUp = null;
    this._onMouseMove = null;
    this._onClick = null;
    this._keymap = DEFAULT_KEYMAP;
  }

  /* ------------------------------- state ------------------------------ */

  /** @returns {boolean} */
  get enabled() {
    return this._enabled;
  }

  /**
   * Detach from the player and begin free-flying from the given pose.
   * @param {{x:number,y:number,z:number}|THREE.Vector3} [startPos]
   * @param {number} [startYaw]
   * @param {number} [startPitch]
   */
  enable(startPos, startYaw, startPitch) {
    this._enabled = true;
    try {
      if (startPos && typeof startPos === "object") {
        this._pos.set(num(startPos.x, this._pos.x), num(startPos.y, this._pos.y), num(startPos.z, this._pos.z));
      } else if (this._camera) {
        this._pos.copy(this._camera.position);
      }
      if (Number.isFinite(startYaw)) this._yaw = startYaw;
      if (Number.isFinite(startPitch)) this._pitch = this._clampPitch(startPitch);
      this._applyToCamera();
    } catch (_err) {
      /* no-op */
    }
  }

  /** Stop free-flying. Does not restore any previous camera pose (caller owns that). */
  disable() {
    this._enabled = false;
    this._clearInput();
  }

  /** @returns {THREE.Vector3} live scratch position (do not retain). */
  get position() {
    return this._pos;
  }
  /** @returns {number} */
  get yaw() {
    return this._yaw;
  }
  /** @returns {number} */
  get pitch() {
    return this._pitch;
  }

  /* ------------------------------- input ------------------------------ */

  /**
   * Replace the current movement input. Missing keys are treated as false.
   * @param {{forward?:boolean,back?:boolean,left?:boolean,right?:boolean,up?:boolean,down?:boolean,boost?:boolean}} state
   */
  setInput(state) {
    const s = state && typeof state === "object" ? state : {};
    this._input.forward = !!s.forward;
    this._input.back = !!s.back;
    this._input.left = !!s.left;
    this._input.right = !!s.right;
    this._input.up = !!s.up;
    this._input.down = !!s.down;
    this._input.boost = !!s.boost;
  }

  /**
   * Apply a mouse look delta (pixels). dx -> yaw, dy -> pitch (clamped ±1.54).
   * @param {number} dx
   * @param {number} dy
   */
  addLook(dx, dy) {
    if (Number.isFinite(dx)) this._yaw -= dx * this.lookSensitivity;
    if (Number.isFinite(dy)) this._pitch = this._clampPitch(this._pitch - dy * this.lookSensitivity);
  }

  _clampPitch(p) {
    if (!Number.isFinite(p)) return 0;
    return p > PITCH_LIMIT ? PITCH_LIMIT : p < -PITCH_LIMIT ? -PITCH_LIMIT : p;
  }

  _clearInput() {
    this._input.forward = this._input.back = this._input.left = this._input.right = false;
    this._input.up = this._input.down = this._input.boost = false;
  }

  /* ------------------------------- update ----------------------------- */

  /**
   * Integrate velocity from the current input in the yaw-oriented basis, apply
   * boost, ray-march the intended move against world solidity, then write the
   * camera pose. No per-frame allocation. Never throws.
   * @param {number} dt seconds
   */
  update(dt) {
    if (!this._enabled || !this._camera) return;
    const step = Number.isFinite(dt) ? dt : 0;
    if (step <= 0) {
      this._applyToCamera();
      return;
    }
    try {
      const i = this._input;
      // Forward/right on the horizontal plane from yaw; up/down world-vertical.
      const sinY = Math.sin(this._yaw);
      const cosY = Math.cos(this._yaw);
      // Camera forward (-Z) rotated by yaw about Y: (-sinY, 0, -cosY).
      // Camera right (+X) rotated by yaw about Y: ( cosY, 0, -sinY).
      let mx = 0;
      let my = 0;
      let mz = 0;
      const fwd = (i.forward ? 1 : 0) - (i.back ? 1 : 0);
      const strafe = (i.right ? 1 : 0) - (i.left ? 1 : 0);
      const vert = (i.up ? 1 : 0) - (i.down ? 1 : 0);
      mx += fwd * -sinY + strafe * cosY;
      mz += fwd * -cosY + strafe * -sinY;
      my += vert;

      // Normalize horizontal-plane + vertical combined direction so diagonal
      // movement is not faster than axis-aligned movement.
      const len = Math.sqrt(mx * mx + my * my + mz * mz);
      if (len > 1e-6) {
        mx /= len;
        my /= len;
        mz /= len;
        const speed = this.moveSpeed * (i.boost ? this.boostMultiplier : 1) * step;
        this._move.set(mx * speed, my * speed, mz * speed);
        this._applyMove(this._move);
      }
    } catch (_err) {
      /* defensive: never let a bad frame break the cam */
    }
    this._applyToCamera();
  }

  /**
   * Apply an intended displacement, ray-marched against solidity if collide.
   * @param {THREE.Vector3} move
   * @private
   */
  _applyMove(move) {
    if (!this.collide) {
      this._pos.add(move);
      return;
    }
    const dist = move.length();
    if (dist <= 1e-6) return;
    this._dir.copy(move).multiplyScalar(1 / dist);
    const limited = this._marchCollision(dist);
    this._pos.x += this._dir.x * limited;
    this._pos.y += this._dir.y * limited;
    this._pos.z += this._dir.z * limited;
  }

  /**
   * March from the current position along this._dir up to maxDist; stop just
   * before the first solid cell (minus collisionRadius). Borrows the pattern
   * from ThirdPersonCamera._marchCollision.
   * @param {number} maxDist
   * @returns {number} collision-limited move length (>= 0).
   * @private
   */
  _marchCollision(maxDist) {
    const step = this._step;
    let t = step;
    while (t <= maxDist) {
      this._probe.set(
        this._pos.x + this._dir.x * t,
        this._pos.y + this._dir.y * t,
        this._pos.z + this._dir.z * t
      );
      let solid = false;
      try {
        solid = !!this.isSolid(this._probe.x, this._probe.y, this._probe.z);
      } catch (_e) {
        solid = false; // a throwing solidity test must not break the cam
      }
      if (solid) {
        const hit = t - this.collisionRadius;
        return hit < 0 ? 0 : hit;
      }
      t += step;
    }
    return maxDist;
  }

  /**
   * Write position + rotation (order 'YXZ': yaw then pitch) to the camera.
   * @private
   */
  _applyToCamera() {
    if (!this._camera) return;
    try {
      this._camera.position.set(this._pos.x, this._pos.y, this._pos.z);
      this._camera.rotation.order = "YXZ";
      this._camera.rotation.set(this._pitch, this._yaw, 0);
    } catch (_err) {
      /* no-op */
    }
  }

  /* --------------------------- attach / detach ------------------------ */

  /**
   * Wire keydown/keyup (movement) + mousemove (pointer-locked look) on the given
   * element. Idempotent-ish: a second attach() detaches the first. Never throws.
   * @param {HTMLElement} domElement
   * @param {{pointerLock?:boolean}} [opts]
   */
  attach(domElement, opts = {}) {
    if (!domElement || typeof domElement.addEventListener !== "function") return;
    if (this._dom) this.detach();
    const o = opts && typeof opts === "object" ? opts : {};
    this._dom = domElement;
    this._pointerLock = o.pointerLock !== false; // default true

    this._onKeyDown = (e) => this._handleKey(e, true);
    this._onKeyUp = (e) => this._handleKey(e, false);
    this._onMouseMove = (e) => {
      if (!this._enabled) return;
      // Only consume movement when pointer-locked (if pointer lock requested).
      if (this._pointerLock) {
        try {
          const el = typeof document !== "undefined" ? document.pointerLockElement : null;
          if (el && el !== this._dom) return;
          if (!el) return;
        } catch (_err) {
          /* fall through and apply */
        }
      }
      this.addLook(num(e.movementX, 0), num(e.movementY, 0));
    };
    this._onClick = () => {
      if (!this._enabled || !this._pointerLock) return;
      try {
        if (this._dom && typeof this._dom.requestPointerLock === "function") this._dom.requestPointerLock();
      } catch (_err) {
        /* no-op */
      }
    };

    try {
      // Key events on window so they fire regardless of focus target.
      const keyTarget = typeof window !== "undefined" ? window : this._dom;
      keyTarget.addEventListener("keydown", this._onKeyDown);
      keyTarget.addEventListener("keyup", this._onKeyUp);
      this._keyTarget = keyTarget;
      this._dom.addEventListener("mousemove", this._onMouseMove);
      if (this._pointerLock) this._dom.addEventListener("click", this._onClick);
    } catch (_err) {
      /* no-op */
    }
  }

  /** Remove everything attach() wired. Idempotent. Never throws. */
  detach() {
    try {
      const keyTarget = this._keyTarget || (typeof window !== "undefined" ? window : this._dom);
      if (this._onKeyDown && keyTarget) keyTarget.removeEventListener("keydown", this._onKeyDown);
      if (this._onKeyUp && keyTarget) keyTarget.removeEventListener("keyup", this._onKeyUp);
      if (this._dom && this._onMouseMove) this._dom.removeEventListener("mousemove", this._onMouseMove);
      if (this._dom && this._onClick) this._dom.removeEventListener("click", this._onClick);
    } catch (_err) {
      /* no-op */
    }
    this._dom = null;
    this._keyTarget = null;
    this._onKeyDown = this._onKeyUp = this._onMouseMove = this._onClick = null;
    this._clearInput();
  }

  /**
   * Map a keyboard event onto an input flag.
   * @param {KeyboardEvent} e
   * @param {boolean} down
   * @private
   */
  _handleKey(e, down) {
    if (!this._enabled || !e) return;
    const flag = this._keymap[e.code];
    if (!flag) return;
    this._input[flag] = down;
    try {
      if (typeof e.preventDefault === "function") e.preventDefault();
    } catch (_err) {
      /* no-op */
    }
  }

  /** Release listeners + input. Alias-ish of detach() for uniform teardown. */
  dispose() {
    this.disable();
    this.detach();
    this._camera = null;
  }
}

export default SpectatorCamera;
