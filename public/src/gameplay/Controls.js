// Voxelheim — pointer-lock mouse look + keyboard input.
//
// Camera ownership split (see Player.js): Controls owns camera ROTATION —
// yaw/pitch are applied directly to camera.rotation with order 'YXZ'.
// Player owns camera POSITION. Controls never writes camera.position.
//
// Pointer lock: `lock()` requests it, `unlock()` exits. Nothing is
// auto-bound to clicks — the integration layer decides when to call lock().
// Because headless pointer lock is flaky, `_debugSetLocked(true)` is a
// documented TEST HOOK that makes `isLocked` report true (and thus lets
// mouse break/place fire) without real pointer lock.
//
// Key map:
//   WASD             — move (input.forward/back/left/right)
//   Space            — jump; double-tap within 300 ms emits 'toggleFlight'
//   ShiftLeft        — input.sprint (sprint while walking); also folded into
//                      input.sneakOrDescend (descend while flying)
//   KeyC / ControlLeft — input.sneak (sneak while walking: slow + edge-guard
//                      + eye drop — Player decides; also descends in flight
//                      via input.sneakOrDescend)
//   KeyE             — emits 'toggleInventory'
//   KeyT             — emits 'openChat'
//   F3               — emits 'toggleDebug' (preventDefault'ed)
//   Digit1..Digit9   — emits 'selectSlot' with index 0..8
//   Escape / losing pointer lock — emits 'togglePause'
//   wheel            — emits 'scroll' with +1 (down) / -1 (up)
//   mouse left/right — emits 'break' / 'place' (only while isLocked;
//                      contextmenu is prevented)
//
// All key input is IGNORED while document.activeElement is an <input> or
// <textarea> (e.g. the chat box).

const DOUBLE_TAP_MS = 300;
const PITCH_LIMIT = Math.PI / 2 - 0.001;

const EVENT_NAMES = [
  'break', 'place', 'selectSlot', 'scroll', 'toggleInventory',
  'togglePause', 'toggleFlight', 'toggleDebug', 'openChat',
];

export class Controls {
  /**
   * @param {HTMLElement} domElement element pointer lock attaches to and
   *        mouse events are read from (usually the renderer canvas or body)
   * @param {{rotation:{order:string,x:number,y:number}}|null} camera
   *        typically a THREE.PerspectiveCamera; Controls sets rotation only.
   */
  constructor(domElement, camera) {
    this.domElement = domElement;
    this.camera = camera || null;

    /** Mouse-look sensitivity (radians per pixel). Settable. */
    this.sensitivity = 0.002;
    /** Rotation about +Y; yaw 0 faces -Z. */
    this.yaw = 0;
    /** Clamped to ±(π/2 − 0.001). */
    this.pitch = 0;

    /** Live input state polled by Player each frame. mouseDX/mouseDY
     *  accumulate until consumeMouseDelta() resets them.
     *  sneak = KeyC/ControlLeft; sprint = ShiftLeft; sneakOrDescend is the
     *  union (Shift OR sneak keys) read by Player as flight-descend. */
    this.input = {
      forward: false, back: false, left: false, right: false,
      jump: false, sprint: false, sneak: false, sneakOrDescend: false,
      mouseDX: 0, mouseDY: 0,
    };

    this._locked = false;
    this._debugLocked = false;
    this._lastSpaceDown = -Infinity;
    // Physical-key state feeding the derived sneak/sneakOrDescend flags.
    this._shiftDown = false;
    this._sneakKeys = new Set(); // 'KeyC' / 'ControlLeft' currently held
    this._listeners = new Map(); // event name -> Set<cb>

    if (this.camera) {
      this.camera.rotation.order = 'YXZ';
      this._applyCameraRotation();
    }

    // Bound handlers kept for dispose().
    this._onKeyDown = (e) => this._handleKeyDown(e);
    this._onKeyUp = (e) => this._handleKeyUp(e);
    this._onMouseMove = (e) => this._handleMouseMove(e);
    this._onMouseDown = (e) => this._handleMouseDown(e);
    this._onWheel = (e) => this._handleWheel(e);
    this._onContextMenu = (e) => e.preventDefault();
    this._onPointerLockChange = () => this._handlePointerLockChange();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    this.domElement.addEventListener('mousedown', this._onMouseDown);
    this.domElement.addEventListener('wheel', this._onWheel, { passive: true });
    this.domElement.addEventListener('contextmenu', this._onContextMenu);
  }

  // ── events ────────────────────────────────────────────────────────────

  /** Subscribe to one of: break, place, selectSlot(i), scroll(dir),
   *  toggleInventory, togglePause, toggleFlight, toggleDebug, openChat. */
  on(name, cb) {
    if (!this._listeners.has(name)) this._listeners.set(name, new Set());
    this._listeners.get(name).add(cb);
    return this;
  }

  off(name, cb) {
    this._listeners.get(name)?.delete(cb);
    return this;
  }

  _emit(name, ...args) {
    const set = this._listeners.get(name);
    if (set) for (const cb of set) cb(...args);
  }

  /** Valid event names (for harnesses/UI wiring). */
  static get EVENTS() { return EVENT_NAMES.slice(); }

  // ── pointer lock ──────────────────────────────────────────────────────

  /** True when really pointer-locked OR debug-locked (test hook). */
  get isLocked() {
    return this._locked || this._debugLocked;
  }

  /** TEST HOOK: force isLocked without real pointer lock (headless
   *  pointer lock is flaky). Mouse break/place then fire normally. */
  _debugSetLocked(v) {
    this._debugLocked = !!v;
  }

  lock() {
    this.domElement.requestPointerLock?.();
  }

  unlock() {
    document.exitPointerLock?.();
  }

  _handlePointerLockChange() {
    const nowLocked = document.pointerLockElement === this.domElement;
    // Exiting pointer lock (Escape) means "pause".
    if (this._locked && !nowLocked) this._emit('togglePause');
    this._locked = nowLocked;
  }

  // ── keyboard ──────────────────────────────────────────────────────────

  _isTyping() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA';
  }

  _handleKeyDown(e) {
    if (this._isTyping()) return;
    switch (e.code) {
      case 'KeyW': this.input.forward = true; return;
      case 'KeyS': this.input.back = true; return;
      case 'KeyA': this.input.left = true; return;
      case 'KeyD': this.input.right = true; return;
      case 'ShiftLeft':
        this._shiftDown = true;
        this._refreshSneakFlags();
        return;
      case 'KeyC':
      case 'ControlLeft':
        this._sneakKeys.add(e.code);
        this._refreshSneakFlags();
        return;
      case 'Space': {
        e.preventDefault();
        this.input.jump = true;
        if (!e.repeat) {
          const now = (typeof performance !== 'undefined' ? performance : Date).now();
          if (now - this._lastSpaceDown < DOUBLE_TAP_MS) {
            this._lastSpaceDown = -Infinity; // avoid triple-tap double fire
            this._emit('toggleFlight');
          } else {
            this._lastSpaceDown = now;
          }
        }
        return;
      }
      case 'KeyE': if (!e.repeat) this._emit('toggleInventory'); return;
      case 'KeyT': if (!e.repeat) this._emit('openChat'); return;
      case 'F3':
        e.preventDefault();
        if (!e.repeat) this._emit('toggleDebug');
        return;
      default: {
        // Digit1..Digit9 -> selectSlot(0..8)
        if (!e.repeat && e.code.startsWith('Digit')) {
          const n = e.code.charCodeAt(5) - 48; // '1'..'9'
          if (n >= 1 && n <= 9) this._emit('selectSlot', n - 1);
        }
      }
    }
  }

  _handleKeyUp(e) {
    if (this._isTyping()) return;
    switch (e.code) {
      case 'KeyW': this.input.forward = false; break;
      case 'KeyS': this.input.back = false; break;
      case 'KeyA': this.input.left = false; break;
      case 'KeyD': this.input.right = false; break;
      case 'Space': this.input.jump = false; break;
      case 'ShiftLeft':
        this._shiftDown = false;
        this._refreshSneakFlags();
        break;
      case 'KeyC':
      case 'ControlLeft':
        this._sneakKeys.delete(e.code);
        this._refreshSneakFlags();
        break;
    }
  }

  /** Derive input.sprint/sneak/sneakOrDescend from the held physical keys:
   *  Shift sprints (and descends in flight); KeyC/ControlLeft sneak (and
   *  also descend in flight). */
  _refreshSneakFlags() {
    this.input.sprint = this._shiftDown;
    this.input.sneak = this._sneakKeys.size > 0;
    this.input.sneakOrDescend = this._shiftDown || this.input.sneak;
  }

  // ── mouse ─────────────────────────────────────────────────────────────

  _handleMouseMove(e) {
    if (!this.isLocked) return;
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    this.input.mouseDX += dx;
    this.input.mouseDY += dy;
    this.yaw -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
    this._applyCameraRotation();
  }

  _applyCameraRotation() {
    if (!this.camera) return;
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }

  _handleMouseDown(e) {
    if (!this.isLocked) return;
    if (e.button === 0) this._emit('break');
    else if (e.button === 2) this._emit('place');
  }

  _handleWheel(e) {
    if (e.deltaY === 0) return;
    this._emit('scroll', e.deltaY > 0 ? 1 : -1);
  }

  /** Read-and-reset the accumulated mouse deltas. */
  consumeMouseDelta() {
    const d = { dx: this.input.mouseDX, dy: this.input.mouseDY };
    this.input.mouseDX = 0;
    this.input.mouseDY = 0;
    return d;
  }

  /** Remove every DOM listener. */
  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    this.domElement.removeEventListener('mousedown', this._onMouseDown);
    this.domElement.removeEventListener('wheel', this._onWheel);
    this.domElement.removeEventListener('contextmenu', this._onContextMenu);
    this._listeners.clear();
  }
}
