// graphics-lab/src/photomode.js
//
// PHOTO MODE — a self-contained "environment phase" module: free-fly camera
// for composing screenshots, cinematic framing overlay, and high-resolution
// still capture. Designed to sit BESIDE the demo without touching demo.js,
// postprocessing.js or any other module.
//
//   class PhotoMode(camera, renderer, {
//     domElement,   // element to listen for mouse drags on (default: renderer.domElement)
//     controls,     // optional OrbitControls (or anything with .enabled /
//                   // .target / .update()) — disabled on enter, state
//                   // (enabled flag + target vector) restored on exit
//     scene,        // optional THREE.Scene — used by captureStill's default path
//     render,       // optional ({width,height}) => void — custom frame renderer
//                   // for captureStill (e.g. the demo's composer pass). When
//                   // provided it wins over the plain scene render.
//     onEnter, onExit,          // optional callbacks
//     moveSpeed, fastMultiplier, lookSpeed, damping,  // optional tuning
//   })
//
//   enter() / exit() / toggle()
//     * enter(): saves the camera transform (position + quaternion + up) and
//       the controls state, disables the controls, and switches to a drag-look
//       free-fly camera. Deliberately NOT pointer-lock — plain left-button
//       drag to look — so it works in iframes, headless captures, and
//       browsers that deny pointer lock. Dispatches window CustomEvent
//       'photomode:enter' (the demo hides GUI/HUD on this; the integrator
//       wires it — this module never touches the demo).
//     * exit(): restores the camera transform EXACTLY (copies the saved
//       vectors back), re-enables the controls and restores their target,
//       dispatches 'photomode:exit'.
//
//   Controls while active:  W/S forward/back, A/D strafe, Q/E up/down (world
//   Y), Shift = fast (x4), left-mouse drag = look (YXZ yaw/pitch, pitch
//   clamped). Movement is velocity-smoothed in update(dt) — call update(dt)
//   from the demo loop every frame (cheap no-op when inactive).
//
//   setFrame({ vignette, letterbox })
//     Cinematic framing via two DOM letterbox bars + a CSS radial-gradient
//     vignette overlaid on the page (pointer-events:none, animated with CSS
//     transitions). Zero GPU cost, zero interaction with the render pipeline.
//     Frame is switched off automatically on exit().
//
//   DoF DECISION — SKIPPED, setFrame() provided instead (the task's fallback
//   option). Rationale: a depth-aware DoF pass needs the scene depth buffer,
//   which lives inside postprocessing.js's render-target chain. Reproducing
//   it here would mean a second scene render into our own RT chain (doubling
//   frame cost) or reaching into postprocessing.js (out of bounds for this
//   module). A depth-less fake (framebuffer copy + radial blur) is fragile:
//   it depends on drawing-buffer timing relative to the demo's composer, which
//   this module cannot control. The letterbox+vignette overlay is the simple,
//   robust option and is what was chosen. setDoF()/setFocus() still exist as
//   safe inert stubs (they record state, warn once, return false) so caller
//   code never crashes if it probes for DoF.
//
//   captureStill({ width=2560, height=1440, render }) -> PNG dataURL
//     Renders ONE frame at the requested resolution by temporarily resizing
//     the renderer's drawing buffer (setSize(..., false) — CSS size is left
//     alone so the page doesn't reflow) at pixelRatio 1, fixing the camera
//     aspect, rendering, and reading toDataURL('image/png') in the same JS
//     task (valid even with preserveDrawingBuffer:false, since no composite
//     happens mid-task). Everything is restored in a try/finally, so a render
//     exception can never leave the renderer resized. Default path is
//     renderer.render(scene, camera) (post-FX bypassed); pass render (here or
//     in the constructor) to capture through the demo's own pipeline.
//
//   triggerDownload(filename, opts) — captureStill + synthetic <a download>.
//   dispose() — exits if active, removes listeners and overlay DOM.
//
// No pointer lock, no requestAnimationFrame of its own, no render targets,
// no per-frame allocations in update() (module-level scratch vectors).

import * as THREE from 'three';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _targetVel = new THREE.Vector3();
const _size = new THREE.Vector2();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

const MAX_PITCH = Math.PI / 2 - 0.001;

export class PhotoMode {
  constructor(camera, renderer, opts = {}) {
    this.camera = camera;
    this.renderer = renderer;
    this.domElement = opts.domElement || renderer.domElement;
    this.controls = opts.controls || null;
    this.scene = opts.scene || null;
    this.renderFrame = opts.render || null;
    this.onEnter = opts.onEnter || null;
    this.onExit = opts.onExit || null;

    this.moveSpeed = opts.moveSpeed ?? 8;          // units/sec
    this.fastMultiplier = opts.fastMultiplier ?? 4;
    this.lookSpeed = opts.lookSpeed ?? 0.0035;     // radians per pixel
    this.damping = opts.damping ?? 12;             // velocity smoothing rate

    this.active = false;

    this._saved = null;
    this._yaw = 0;
    this._pitch = 0;
    this._velocity = new THREE.Vector3();
    this._keys = { forward: false, back: false, left: false, right: false, up: false, down: false, fast: false };
    this._dragging = false;
    this._dragId = -1;
    this._lastX = 0;
    this._lastY = 0;

    this._frameState = { vignette: false, letterbox: false };
    this._frameDom = null; // { root, barTop, barBottom, vignette }
    this._dofWarned = false;
    this._dof = { enabled: false, focus: 0.5 };

    // Bound handlers (added on enter, removed on exit).
    this._onKeyDown = (e) => this._key(e, true);
    this._onKeyUp = (e) => this._key(e, false);
    this._onPointerDown = (e) => {
      if (e.button !== 0) return;
      this._dragging = true;
      this._dragId = e.pointerId;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      if (this.domElement.setPointerCapture) {
        try { this.domElement.setPointerCapture(e.pointerId); } catch (_) { /* detached element */ }
      }
      e.preventDefault();
    };
    this._onPointerMove = (e) => {
      if (!this._dragging || e.pointerId !== this._dragId) return;
      const dx = e.clientX - this._lastX;
      const dy = e.clientY - this._lastY;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      this._applyLook(dx, dy);
    };
    this._onPointerUp = (e) => {
      if (e.pointerId !== this._dragId) return;
      this._dragging = false;
      this._dragId = -1;
    };
    this._onBlur = () => {
      // Never leave keys stuck when the tab loses focus mid-flight.
      const k = this._keys;
      k.forward = k.back = k.left = k.right = k.up = k.down = k.fast = false;
      this._dragging = false;
    };
  }

  // ------------------------------------------------------------------ mode

  enter() {
    if (this.active) return;
    this.active = true;

    const c = this.camera;
    this._saved = {
      position: c.position.clone(),
      quaternion: c.quaternion.clone(),
      up: c.up.clone(),
      controlsEnabled: this.controls ? this.controls.enabled : null,
      controlsTarget: (this.controls && this.controls.target && this.controls.target.isVector3)
        ? this.controls.target.clone() : null,
    };
    if (this.controls) this.controls.enabled = false;

    // Seed yaw/pitch from the camera's current orientation so there is no
    // snap when the first drag happens.
    _euler.setFromQuaternion(c.quaternion, 'YXZ');
    this._yaw = _euler.y;
    this._pitch = _euler.x;
    this._applyLook(0, 0); // normalises roll to 0 (YXZ has no roll term)

    this._velocity.set(0, 0, 0);
    this._onBlur(); // clear key state

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    this.domElement.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);

    window.dispatchEvent(new CustomEvent('photomode:enter', { detail: { photoMode: this } }));
    if (this.onEnter) this.onEnter(this);
  }

  exit() {
    if (!this.active) return;
    this.active = false;

    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.domElement.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    this._dragging = false;
    this._dragId = -1;

    const s = this._saved;
    if (s) {
      this.camera.position.copy(s.position);
      this.camera.quaternion.copy(s.quaternion);
      this.camera.up.copy(s.up);
      if (this.controls) {
        if (s.controlsTarget) this.controls.target.copy(s.controlsTarget);
        this.controls.enabled = s.controlsEnabled;
        if (typeof this.controls.update === 'function') this.controls.update();
        // controls.update() may re-derive orientation from target; re-assert
        // the exact saved transform so restoration is bit-for-bit.
        this.camera.position.copy(s.position);
        this.camera.quaternion.copy(s.quaternion);
      }
    }
    this._saved = null;

    // Framing is a photo-mode affordance; drop it when leaving.
    this.setFrame({ vignette: false, letterbox: false });

    window.dispatchEvent(new CustomEvent('photomode:exit', { detail: { photoMode: this } }));
    if (this.onExit) this.onExit(this);
  }

  toggle() { this.active ? this.exit() : this.enter(); }

  // ------------------------------------------------------------ fly camera

  _key(e, down) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const k = this._keys;
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': k.forward = down; break;
      case 'KeyS': case 'ArrowDown': k.back = down; break;
      case 'KeyA': case 'ArrowLeft': k.left = down; break;
      case 'KeyD': case 'ArrowRight': k.right = down; break;
      case 'KeyQ': k.up = down; break;
      case 'KeyE': k.down = down; break;
      case 'ShiftLeft': case 'ShiftRight': k.fast = down; return; // no preventDefault
      default: return;
    }
    if (e.preventDefault) e.preventDefault();
  }

  _applyLook(dx, dy) {
    this._yaw -= dx * this.lookSpeed;
    this._pitch -= dy * this.lookSpeed;
    this._pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this._pitch));
    _euler.set(this._pitch, this._yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(_euler);
  }

  /** Call every frame from the demo loop. dt in seconds. */
  update(dt) {
    if (!this.active) return;
    dt = Math.min(Math.max(dt || 0.016, 0), 0.1); // clamp stalls

    const k = this._keys;
    const c = this.camera;

    _fwd.set(0, 0, -1).applyQuaternion(c.quaternion);
    _right.set(1, 0, 0).applyQuaternion(c.quaternion);

    _targetVel.set(0, 0, 0)
      .addScaledVector(_fwd, (k.forward ? 1 : 0) - (k.back ? 1 : 0))
      .addScaledVector(_right, (k.right ? 1 : 0) - (k.left ? 1 : 0));
    _targetVel.y += (k.up ? 1 : 0) - (k.down ? 1 : 0); // Q/E along world Y
    if (_targetVel.lengthSq() > 1) _targetVel.normalize();
    _targetVel.multiplyScalar(this.moveSpeed * (k.fast ? this.fastMultiplier : 1));

    // Exponential velocity smoothing (framerate-independent).
    const a = 1 - Math.exp(-this.damping * dt);
    this._velocity.lerp(_targetVel, a);
    c.position.addScaledVector(this._velocity, dt);
  }

  // ------------------------------------------------------- framing overlay

  /**
   * Cinematic framing: letterbox bars + vignette as DOM/CSS overlays.
   * Accepts partial updates: setFrame({ letterbox: true }) leaves the
   * vignette flag untouched. Returns the current frame state.
   */
  setFrame(opts = {}) {
    if (typeof opts.vignette === 'boolean') this._frameState.vignette = opts.vignette;
    if (typeof opts.letterbox === 'boolean') this._frameState.letterbox = opts.letterbox;

    const st = this._frameState;
    const anyOn = st.vignette || st.letterbox;
    if (!this._frameDom && !anyOn) return { ...st }; // never built, nothing to hide

    if (!this._frameDom) this._buildFrameDom();
    const f = this._frameDom;
    const barH = st.letterbox ? '11vh' : '0px';
    f.barTop.style.height = barH;
    f.barBottom.style.height = barH;
    f.vignette.style.opacity = st.vignette ? '1' : '0';
    return { ...st };
  }

  _buildFrameDom() {
    const doc = this.domElement.ownerDocument || document;
    const root = doc.createElement('div');
    root.setAttribute('data-photomode-frame', '');
    root.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:9998;overflow:hidden;';

    const bar = () => {
      const d = doc.createElement('div');
      d.style.cssText =
        'position:absolute;left:0;right:0;height:0;background:#000;' +
        'transition:height 0.35s ease;';
      root.appendChild(d);
      return d;
    };
    const barTop = bar(); barTop.style.top = '0';
    const barBottom = bar(); barBottom.style.bottom = '0';

    const vignette = doc.createElement('div');
    vignette.style.cssText =
      'position:absolute;inset:0;opacity:0;transition:opacity 0.35s ease;' +
      'background:radial-gradient(ellipse at center,' +
      'rgba(0,0,0,0) 55%,rgba(0,0,0,0.45) 100%);';
    root.appendChild(vignette);

    (doc.body || doc.documentElement).appendChild(root);
    this._frameDom = { root, barTop, barBottom, vignette };
  }

  // ----------------------------------------------------------- DoF (stubs)

  /**
   * Depth of field is intentionally NOT implemented (see header: it cannot be
   * done robustly without reaching into postprocessing.js's depth/RT chain).
   * These stubs record intent, warn once, and return false so callers can
   * feature-detect: `if (!photoMode.setDoF(true)) photoMode.setFrame(...)`.
   */
  setDoF(enabled) {
    this._dof.enabled = !!enabled;
    if (!this._dofWarned) {
      this._dofWarned = true;
      console.warn('[PhotoMode] DoF not supported (skipped by design — use setFrame({vignette,letterbox}) instead).');
    }
    return false;
  }

  /** distance: 0..1 normalized. Stored only; no-op (see setDoF). */
  setFocus(distance) {
    this._dof.focus = Math.max(0, Math.min(1, +distance || 0));
    return false;
  }

  // ---------------------------------------------------------- still capture

  /**
   * Render one frame at high resolution and return a PNG dataURL.
   * Restores renderer size, pixel ratio and camera aspect in a finally block.
   */
  captureStill({ width = 2560, height = 1440, render } = {}) {
    const r = this.renderer;
    const cam = this.camera;
    const prevPixelRatio = r.getPixelRatio();
    r.getSize(_size);
    const prevW = _size.x, prevH = _size.y;
    const prevAspect = cam.aspect;

    try {
      r.setPixelRatio(1);
      r.setSize(width, height, false); // false: don't touch CSS size
      if (typeof cam.aspect === 'number') {
        cam.aspect = width / height;
        cam.updateProjectionMatrix();
      }

      const renderFn = render || this.renderFrame;
      if (renderFn) {
        renderFn({ width, height, camera: cam, renderer: r });
      } else if (this.scene) {
        r.render(this.scene, cam);
      } else {
        throw new Error('[PhotoMode] captureStill needs a scene (constructor opt) or a render callback.');
      }
      // Same-task read: valid without preserveDrawingBuffer.
      return r.domElement.toDataURL('image/png');
    } finally {
      r.setPixelRatio(prevPixelRatio);
      r.setSize(prevW, prevH, false);
      if (typeof cam.aspect === 'number') {
        cam.aspect = prevAspect;
        cam.updateProjectionMatrix();
      }
    }
  }

  /** captureStill + synthetic download link. Returns the dataURL. */
  triggerDownload(filename, opts) {
    const name = filename || `photo-${Date.now()}.png`;
    const dataURL = this.captureStill(opts);
    const doc = this.domElement.ownerDocument || document;
    const a = doc.createElement('a');
    a.href = dataURL;
    a.download = name;
    doc.body.appendChild(a); // Firefox requires in-DOM anchors
    a.click();
    a.remove();
    return dataURL;
  }

  // ---------------------------------------------------------------- cleanup

  dispose() {
    if (this.active) this.exit(); // also removes listeners + hides frame
    if (this._frameDom) {
      this._frameDom.root.remove();
      this._frameDom = null;
    }
    this.controls = null;
    this.scene = null;
    this.renderFrame = null;
    this.onEnter = null;
    this.onExit = null;
  }
}

export default PhotoMode;
