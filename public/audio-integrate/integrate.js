// audio-integrate/integrate.js
//
// AudioStack — the integration facade for the MinecraftV2 audio engine.
//
// ============================================================================
// HEADLINE DELIVERABLE: the `lf-audio-event` CAPTION BRIDGE (net-new).
// ============================================================================
// The audio engine (audio/engine.js) and GameAudio wrapper dispatch NO DOM
// event, so the HudKit / ux-access caption layer has nothing to listen to.
// This file closes that gap (HudKit FINDINGS #1: "no audio→caption signal").
// Every sound routed through this facade — one-shots, ambient loops, music,
// and (in decorator mode) the builder's existing GameAudio — ALSO dispatches a
// single, uniform `lf-audio-event` CustomEvent on `window` that the caption UI
// already knows how to render.
//
// EXACT EVENT SHAPE (must match HudKit / ux-access on the receiving side — the
// same person owns both sides of this contract; captions.json is the
// authoritative category source):
//
//   new CustomEvent('lf-audio-event', { detail: {
//     name:      string,                                // engine key, e.g.
//                                                       // "mob.groaner.hurt"
//                                                       // or "music.<mode>"
//     direction: 'left'|'right'|'behind'|'front'|null,  // relative to listener
//     volume:    number (0..1),                         // 0 is dispatched too;
//                                                       // caption layer skips it
//     loop:      boolean,                               // true on loop/music start
//     ended:     boolean,                               // true on loop/music stop
//     category:  string                                 // advisory bucket (below)
//   }})
//
// Category advisory mapping (captions.json wins; this is a best-effort fallback):
//   step.* / break.* / place.* / door.* / chest.* / eat / drink / splash /
//     portal / ui.click / pop / levelup / achievement            -> 'action'
//   mob.*                                                          -> 'mob'
//   rain / wind / cave                                             -> 'ambient'
//   thunder / thunder.distant / explosion / hurt                  -> 'alert'
//   music.*                                                        -> 'music'
//
// DIRECTION requires a cached listener. Call `setListener(pos, yaw)` (Mode 2)
// or route through `gameAudio.setListener` (Mode 1, decorated) so the stack
// knows where the ears are. Non-positional sounds (ui / music / hurt / rain)
// and any `ended:true` stop dispatch `direction:null`.
//
// ----------------------------------------------------------------------------
// TWO USAGE MODES
// ----------------------------------------------------------------------------
// MODE 1 — decorate the builder's existing GameAudio (PRIMARY, one-line):
//   import { attach } from './audio-integrate/integrate.js';
//   const stack = attach(gameAudio);   // now every sound emits lf-audio-event
//   // ... later: stack.detach();      // restores the original methods
//   Non-invasive: GameAudio is NOT edited; its methods are wrapped in place and
//   restored by detach(). Also wires engine.play (rain + dimension wind/cave
//   beds that bypass GameAudio.play) and engine.startMusic.
//
// MODE 2 — standalone facade over a raw AudioEngine (greenfield):
//   import { AudioStack } from './audio-integrate/integrate.js';
//   const stack = new AudioStack({ ctx });    // builds its own AudioEngine
//   stack.setListener(eye, yaw);
//   stack.blockBreak('stone', pos);           // plays AND emits the bridge
//
// AudioEngine is imported from '../audio/engine.js' (the repo-root engine on
// this branch) for the Mode 2 default. Mode 1 uses the passed gameAudio's
// engine and never constructs one.
// ============================================================================

import AudioEngine from "../audio/engine.js";

/** The 11 block materials the registry knows. */
export const MATERIALS = [
  "stone", "wood", "dirt", "grass", "sand",
  "glass", "leaves", "gravel", "snow", "metal", "wool",
];

/** dimension id -> music mode (matches GameAudio.DIMENSION_AUDIO). */
export const DIMENSION_MODE = {
  overworld: "calm",
  nether: "nether",
  end: "mysterious",
};

/** The exact 66 registry keys the engine exposes. */
export const REGISTRY_KEYS = (() => {
  const keys = [];
  for (const m of MATERIALS) keys.push("break." + m);
  for (const m of MATERIALS) keys.push("place." + m);
  for (const m of MATERIALS) keys.push("step." + m);
  keys.push("ui.click", "hurt", "pop", "splash");
  keys.push("wind", "cave", "portal", "rain", "thunder", "thunder.distant");
  for (const a of ["grazer", "groaner", "exploder", "screecher", "trader"]) {
    keys.push("mob." + a + ".idle", "mob." + a + ".hurt", "mob." + a + ".death");
  }
  keys.push("door.open", "door.close", "chest.open", "eat", "drink");
  keys.push("levelup", "achievement", "explosion");
  return keys;
})();

/** Registry keys whose voices loop forever (duration: Infinity). */
export const LOOP_KEYS = new Set(["wind", "cave", "rain"]);

/** Valid generative music modes. */
export const MUSIC_MODES = ["calm", "nether", "upbeat", "melancholy", "mysterious"];

// ----------------------------------------------------------------------------
// Category resolution (advisory; captions.json is authoritative downstream).
// ----------------------------------------------------------------------------
function defaultCategoryFor(name) {
  if (typeof name !== "string") return "action";
  if (name.startsWith("music.")) return "music";
  if (name.startsWith("mob.")) return "mob";
  if (name === "rain" || name === "wind" || name === "cave") return "ambient";
  if (
    name === "thunder" ||
    name === "thunder.distant" ||
    name === "explosion" ||
    name === "hurt"
  ) {
    return "alert";
  }
  // everything else (step.* / break.* / place.* / door.* / chest.* / eat /
  // drink / splash / portal / ui.click / pop / levelup / achievement)
  return "action";
}

// ----------------------------------------------------------------------------
// Direction math from a cached listener + a world position.
// forward f = (-sin yaw, -cos yaw)  (matches GameAudio.setListener)
// right   r = (-cos yaw,  sin yaw)
// ----------------------------------------------------------------------------
function computeDirection(listener, pos) {
  if (!listener || !listener.eye || !pos) return null;
  const eye = listener.eye;
  const yaw = +listener.yaw || 0;
  let rx = (+pos.x || 0) - (+eye.x || 0);
  let rz = (+pos.z || 0) - (+eye.z || 0);
  const len = Math.hypot(rx, rz);
  if (len < 0.5) return null; // on top of the listener
  rx /= len;
  rz /= len;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rgtx = -Math.cos(yaw);
  const rgtz = Math.sin(yaw);
  const fwd = rx * fx + rz * fz;
  const rgt = rx * rgtx + rz * rgtz;
  const absR = Math.abs(rgt);
  if (fwd >= absR) return "front";
  if (-fwd >= absR) return "behind";
  return rgt > 0 ? "right" : "left";
}

/** Normalize a material name / block id to one of the 11; unknown -> 'stone'. */
function normalizeMaterial(mat, resolver) {
  if (typeof resolver === "function") {
    try {
      const r = resolver(mat);
      if (typeof r === "string" && MATERIALS.includes(r)) return r;
    } catch (_e) { /* fall through */ }
  }
  if (typeof mat === "string" && MATERIALS.includes(mat)) return mat;
  return "stone";
}

/**
 * AudioStack — facade + caption bridge. See file header for the full contract.
 */
export class AudioStack {
  /**
   * @param {object} [opts]
   * @param {EventTarget} [opts.target=window] where lf-audio-event is dispatched
   * @param {(name:string)=>string} [opts.categoryFor] override category mapping
   * @param {boolean} [opts.gapFill=true] expose additive gap-fill helpers (Mode 1)
   * @param {AudioEngine} [opts.engine] existing engine (Mode 2)
   * @param {BaseAudioContext} [opts.ctx] context for a new engine (Mode 2)
   * @param {(mat:any)=>string} [opts.materialResolver] material normalizer (Mode 2)
   */
  constructor(opts = {}) {
    this.target = opts.target || (typeof window !== "undefined" ? window : null);
    this.categoryFor =
      typeof opts.categoryFor === "function" ? opts.categoryFor : defaultCategoryFor;
    this.gapFill = opts.gapFill !== false;
    this._materialResolver = opts.materialResolver || null;

    /** cached listener for direction: { eye:{x,y,z}, yaw:number } | null */
    this.listener = null;

    /** Mode 1 decorator bookkeeping. */
    this.gameAudio = null;
    this._detach = null;
    this.skipped = [];

    /** reentrancy flag so the engine.play wrap no-ops during gameAudio.play. */
    this._inGamePlay = false;

    /** Mode 2 engine + internal rain loop handle. */
    this.engine = opts.engine || null;
    this._ctxOpt = opts.ctx || null;
    this._rainHandle = null;
    this._ownEngine = false;
  }

  // ------------------------------------------------------------------
  // CORE: the caption bridge dispatcher. Guarded; never throws.
  // ------------------------------------------------------------------
  _emit(name, info = {}) {
    try {
      const ended = !!info.ended;
      const loop = !!info.loop;
      const volume = info.volume != null ? +info.volume : 1;
      const direction =
        ended || !info.pos ? null : computeDirection(this.listener, info.pos);
      const detail = {
        name,
        direction,
        volume,
        loop,
        ended,
        category: this.categoryFor(name),
      };
      AudioStack.emit(this.target, detail);
    } catch (_e) {
      /* the bridge must never break audio */
    }
  }

  /** Static manual dispatch helper. Guarded; never throws. */
  static emit(target, detail) {
    try {
      const t = target || (typeof window !== "undefined" ? window : null);
      if (!t || typeof t.dispatchEvent !== "function") return;
      const Ctor =
        typeof CustomEvent === "function"
          ? CustomEvent
          : typeof globalThis !== "undefined" && globalThis.CustomEvent;
      if (!Ctor) return;
      t.dispatchEvent(new Ctor("lf-audio-event", { detail }));
    } catch (_e) {
      /* ignore */
    }
  }

  /** Cache the listener used for direction. */
  _cacheListener(pos, yaw) {
    if (pos) this.listener = { eye: { x: pos.x, y: pos.y, z: pos.z }, yaw: +yaw || 0 };
  }

  // ==================================================================
  // MODE 1 — decorate an existing GameAudio (non-invasive).
  // ==================================================================
  /**
   * Wrap gameAudio's methods so every sound also dispatches lf-audio-event.
   * @param {object} gameAudio the builder's GameAudio instance
   * @returns {this}
   */
  attach(gameAudio) {
    if (!gameAudio) {
      this.skipped.push("gameAudio(null)");
      return this;
    }
    this.gameAudio = gameAudio;
    const restores = [];
    const self = this;

    // --- setListener(pos, yaw): cache then call through ---
    if (typeof gameAudio.setListener === "function") {
      const orig = gameAudio.setListener.bind(gameAudio);
      gameAudio.setListener = function (pos, yaw) {
        self._cacheListener(pos, yaw);
        return orig(pos, yaw);
      };
      restores.push(() => { gameAudio.setListener = orig; });
    } else {
      this.skipped.push("setListener");
    }

    // --- play(name, opts): call through AND emit; loop stop emits ended ---
    if (typeof gameAudio.play === "function") {
      const orig = gameAudio.play.bind(gameAudio);
      gameAudio.play = function (name, opts) {
        const prev = self._inGamePlay;
        self._inGamePlay = true; // suppress the inner engine.play wrap
        let handle;
        try {
          handle = orig(name, opts);
        } finally {
          self._inGamePlay = prev;
        }
        const loop = LOOP_KEYS.has(name);
        self._emit(name, {
          pos: opts && opts.pos,
          volume: opts && opts.volume,
          loop,
        });
        if (loop && handle && typeof handle.stop === "function") {
          self._wrapLoopStop(handle, name);
        }
        return handle;
      };
      restores.push(() => { gameAudio.play = orig; });
    } else {
      this.skipped.push("play");
    }

    // --- engine.play: covers rain + dimension wind/cave beds that bypass
    //     gameAudio.play. When inside gameAudio.play, the wrap no-ops (that
    //     call already dispatched). Standalone calls DO dispatch. ---
    const engine = gameAudio.engine;
    if (engine && typeof engine.play === "function") {
      const orig = engine.play.bind(engine);
      engine.play = function (name, opts) {
        const handle = orig(name, opts);
        if (!self._inGamePlay) {
          const loop = LOOP_KEYS.has(name);
          self._emit(name, {
            pos: opts && opts.pos,
            volume: opts && opts.volume,
            loop,
          });
          if (loop && handle && typeof handle.stop === "function") {
            self._wrapLoopStop(handle, name);
          }
        }
        return handle;
      };
      restores.push(() => { engine.play = orig; });
    } else {
      this.skipped.push("engine.play");
    }

    // --- engine.startMusic(mode, opts): emit music.<mode>; wrap stop ---
    if (engine && typeof engine.startMusic === "function") {
      const orig = engine.startMusic.bind(engine);
      engine.startMusic = function (mode, opts) {
        const controller = orig(mode, opts);
        const key = "music." + (mode || "calm");
        self._emit(key, { loop: true });
        if (controller && typeof controller.stop === "function") {
          const cstop = controller.stop.bind(controller);
          controller.stop = function (fade) {
            self._emit(key, { ended: true });
            return cstop(fade);
          };
        }
        return controller;
      };
      restores.push(() => { engine.startMusic = orig; });
    } else {
      this.skipped.push("engine.startMusic");
    }

    this._detach = () => {
      for (const r of restores) {
        try { r(); } catch (_e) { /* ignore */ }
      }
      this._detach = null;
      this.gameAudio = null;
    };
    return this;
  }

  /** Wrap a loop handle's stop() to emit {ended:true} once. */
  _wrapLoopStop(handle, name) {
    if (handle.__lfWrapped) return;
    handle.__lfWrapped = true;
    const orig = handle.stop.bind(handle);
    const self = this;
    handle.stop = function (at) {
      self._emit(name, { ended: true });
      return orig(at);
    };
  }

  /** Restore every wrapped method. Safe to call more than once. */
  detach() {
    if (typeof this._detach === "function") this._detach();
    return this;
  }

  // ------------------------------------------------------------------
  // GAP-FILL helpers (Mode 1) — additive keys the builder hasn't wired.
  // Each routes through gameAudio.play (so the bridge fires) if present,
  // otherwise falls back to the engine, and always dispatches.
  // ------------------------------------------------------------------
  _gapPlay(name, opts) {
    const ga = this.gameAudio;
    if (ga && typeof ga.play === "function") return ga.play(name, opts);
    if (ga && ga.engine && typeof ga.engine.play === "function") {
      const h = ga.engine.play(name, opts);
      this._emit(name, { pos: opts && opts.pos, volume: opts && opts.volume });
      return h;
    }
    if (this.engine && typeof this.engine.play === "function") {
      const h = this.engine.play(name, opts);
      this._emit(name, { pos: opts && opts.pos, volume: opts && opts.volume });
      return h;
    }
    this._emit(name, { pos: opts && opts.pos, volume: opts && opts.volume });
    return { stop() {} };
  }

  pop(pos) { return this._gapPlay("pop", { pos }); }
  pickup(pos) { return this._gapPlay("pop", { pos }); }
  door(open, pos) { return this._gapPlay(open ? "door.open" : "door.close", { pos }); }
  chest(pos) { return this._gapPlay("chest.open", { pos }); }
  eat() { return this._gapPlay("eat", {}); }
  drink() { return this._gapPlay("drink", {}); }

  // ==================================================================
  // MODE 2 — standalone facade over a raw AudioEngine.
  // Each method plays via the engine AND dispatches the caption bridge.
  // ==================================================================
  /** Lazily obtain the engine (Mode 2), building one from ctx if needed. */
  _engine() {
    if (!this.engine) {
      this.engine = new AudioEngine(this._ctxOpt ? { ctx: this._ctxOpt } : {});
      this._ownEngine = true;
    }
    return this.engine;
  }

  /** Play a raw key through the engine + emit. Internal Mode 2 primitive. */
  _play(name, opts = {}) {
    let handle = { stop() {} };
    try {
      handle = this._engine().play(name, opts) || handle;
    } catch (_e) { /* ignore */ }
    this._emit(name, {
      pos: opts.pos,
      volume: opts.volume,
      loop: LOOP_KEYS.has(name),
    });
    return handle;
  }

  resume() {
    try { this._engine().resume(); } catch (_e) { /* ignore */ }
    return this;
  }

  setListener(pos, yaw) {
    this._cacheListener(pos, yaw);
    try {
      const y = +yaw || 0;
      this._engine().setListener(pos, { x: -Math.sin(y), z: -Math.cos(y) });
    } catch (_e) { /* ignore */ }
    return this;
  }

  setVolumes(v = {}) {
    try {
      const e = this._engine();
      if (v.volumeMaster != null) e.setMasterVolume(v.volumeMaster);
      if (v.volumeSfx != null) e.setSfxVolume(v.volumeSfx);
      if (v.volumeMusic != null) e.setMusicVolume(v.volumeMusic);
    } catch (_e) { /* ignore */ }
    return this;
  }

  blockBreak(matOrBlockId, pos) {
    return this._play("break." + normalizeMaterial(matOrBlockId, this._materialResolver), { pos });
  }

  blockPlace(matOrBlockId, pos) {
    return this._play("place." + normalizeMaterial(matOrBlockId, this._materialResolver), { pos });
  }

  step(matOrBlockId, pos, velocity = 0.7) {
    return this._play("step." + normalizeMaterial(matOrBlockId, this._materialResolver), { pos, velocity });
  }

  mob(archetype, variant, pos, volume) {
    const name = "mob." + archetype + "." + variant;
    return this._play(name, { pos, volume });
  }

  rainSet(intensity, ramp = 2) {
    if (this._rainHandle && typeof this._rainHandle.setIntensity === "function") {
      try { this._rainHandle.setIntensity(intensity, ramp); } catch (_e) { /* ignore */ }
      // Re-emit at the new volume so captions reflect the change.
      this._emit("rain", { volume: intensity, loop: true });
      return this._rainHandle;
    }
    this._rainHandle = this._play("rain", { intensity, volume: intensity });
    return this._rainHandle;
  }

  rainStop() {
    if (this._rainHandle) {
      try {
        if (typeof this._rainHandle.stop === "function") this._rainHandle.stop();
      } catch (_e) { /* ignore */ }
      this._emit("rain", { ended: true });
      this._rainHandle = null;
    }
    return this;
  }

  thunder(far, pos) {
    return this._play(far ? "thunder.distant" : "thunder", { pos });
  }

  splash(pos) { return this._play("splash", { pos }); }
  portal(pos) { return this._play("portal", { pos }); }
  ui() { return this._play("ui.click", {}); }
  hurt() { return this._play("hurt", {}); }
  pop(pos) { return this._play("pop", { pos }); }
  pickup(pos) { return this._play("pop", { pos }); }
  door(open, pos) { return this._play(open ? "door.open" : "door.close", { pos }); }
  chest(pos) { return this._play("chest.open", { pos }); }
  eat() { return this._play("eat", {}); }
  drink() { return this._play("drink", {}); }
  levelup() { return this._play("levelup", {}); }
  achievement() { return this._play("achievement", {}); }
  explosion(pos) { return this._play("explosion", { pos }); }

  /**
   * Start music. Accepts a dimension id (mapped via DIMENSION_MODE) or a raw
   * mode name. Emits music.<mode> + wraps the controller stop to emit ended.
   */
  music(dimensionOrMode, opts = {}) {
    const mode = DIMENSION_MODE[dimensionOrMode] || dimensionOrMode || "calm";
    let controller = { stop() {} };
    try {
      controller = this._engine().startMusic(mode, opts) || controller;
    } catch (_e) { /* ignore */ }
    const key = "music." + mode;
    this._emit(key, { loop: true });
    if (controller && typeof controller.stop === "function") {
      const self = this;
      const cstop = controller.stop.bind(controller);
      controller.stop = function (fade) {
        self._emit(key, { ended: true });
        return cstop(fade);
      };
    }
    this._music = controller;
    return controller;
  }

  stopMusic() {
    if (this._music && typeof this._music.stop === "function") {
      try { this._music.stop(); } catch (_e) { /* ignore */ }
      this._music = null;
    } else {
      try { this._engine().stopMusic(); } catch (_e) { /* ignore */ }
    }
    return this;
  }

  stopAll() {
    try { this._engine().stopAll(); } catch (_e) { /* ignore */ }
    this._rainHandle = null;
    this._music = null;
    return this;
  }

  dispose() {
    this.detach();
    this.stopAll();
    this.listener = null;
    return this;
  }

  // ==================================================================
  // Audio-widget dock: mount the <volume-settings> element into a settings
  // shell section (e.g. lf-settings-shell <section data-category="Audio">).
  // ==================================================================
  /**
   * Dynamically import and mount the <volume-settings> custom element.
   * @param {HTMLElement} sectionEl target container
   * @param {object} [opts]
   * @param {AudioEngine} [opts.engine] engine to bind (defaults to this.engine)
   * @param {string} [opts.importPath='../audio/volume-settings.js']
   * @returns {Promise<HTMLElement|null>} the created element (or null on failure)
   */
  async mountVolumeSettings(sectionEl, opts = {}) {
    try {
      if (!sectionEl) return null;
      const importPath = opts.importPath || "../audio/volume-settings.js";
      await import(importPath);
      const doc = sectionEl.ownerDocument || (typeof document !== "undefined" ? document : null);
      if (!doc) return null;
      const el = doc.createElement("volume-settings");
      el.engine = opts.engine || this.engine || (this.gameAudio && this.gameAudio.engine) || null;
      sectionEl.appendChild(el);
      return el;
    } catch (_e) {
      return null;
    }
  }
}

/**
 * Convenience wrapper: `new AudioStack(opts).attach(gameAudio)`.
 * @param {object} gameAudio the builder's GameAudio instance
 * @param {object} [opts] AudioStack options
 * @returns {AudioStack}
 */
export function attach(gameAudio, opts) {
  return new AudioStack(opts).attach(gameAudio);
}

export default AudioStack;
