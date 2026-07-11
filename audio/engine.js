// audio/engine.js
// AudioEngine — default export. Dependency-free browser Web Audio engine.

import registry from "./sfx/index.js";
import { startCalm, startNether } from "./music.js";

/**
 * AudioEngine manages the master/sfx/music bus graph, a positional listener,
 * one-shot SFX playback, and generative music tracks.
 */
export default class AudioEngine {
  /**
   * @param {{ctx?: BaseAudioContext}} [opts]
   */
  constructor(opts = {}) {
    this.ctx = null;
    this.master = null;
    this.sfx = null;
    this.music = null;

    /** @type {Set<{stop?: Function}>} */
    this._voices = new Set();
    /** current music controller, if any */
    this._music = null;

    this.registry = registry;

    if (opts.ctx) {
      this.ctx = opts.ctx;
      this._buildBuses();
    }
  }

  /**
   * Build master -> destination and sfx/music -> master bus graph on this.ctx.
   * @private
   */
  _buildBuses() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(ctx.destination);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = 1;
    this.sfx.connect(this.master);

    this.music = ctx.createGain();
    this.music.gain.value = 1;
    this.music.connect(this.master);
  }

  /**
   * Lazily create a live AudioContext (browser only) and build buses.
   * No-op if a ctx already exists.
   */
  ensure() {
    if (this.ctx) return this.ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) {
      throw new Error("AudioEngine: no AudioContext available in this environment");
    }
    this.ctx = new AC();
    this._buildBuses();
    return this.ctx;
  }

  /**
   * Resume the live AudioContext (call from a user gesture). Safe for offline.
   * @returns {Promise<void>}
   */
  async resume() {
    this.ensure();
    if (this.ctx && typeof this.ctx.resume === "function" && this.ctx.state !== "closed") {
      try {
        await this.ctx.resume();
      } catch (_e) {
        // offline contexts / already-running contexts may reject; ignore.
      }
    }
  }

  setMasterVolume(v) {
    if (this.master) this.master.gain.value = clamp01(v);
  }

  setSfxVolume(v) {
    if (this.sfx) this.sfx.gain.value = clamp01(v);
  }

  setMusicVolume(v) {
    if (this.music) this.music.gain.value = clamp01(v);
  }

  /**
   * Set the AudioListener position (and orientation if a forward vector given).
   * Handles both the newer AudioParam (positionX...) API and the legacy
   * setPosition()/setOrientation() API defensively.
   * @param {{x:number,y:number,z:number}} pos
   * @param {{x:number,z:number}} [forward]
   */
  setListener(pos, forward) {
    if (!this.ctx || !this.ctx.listener) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;

    if (l.positionX) {
      // Modern AudioParam-based API.
      l.positionX.setValueAtTime(pos.x, t);
      l.positionY.setValueAtTime(pos.y, t);
      l.positionZ.setValueAtTime(pos.z, t);
    } else if (typeof l.setPosition === "function") {
      // Legacy API.
      l.setPosition(pos.x, pos.y, pos.z);
    }

    if (forward) {
      const fx = forward.x, fz = forward.z;
      // up vector = (0, 1, 0)
      if (l.forwardX) {
        l.forwardX.setValueAtTime(fx, t);
        l.forwardY.setValueAtTime(0, t);
        l.forwardZ.setValueAtTime(fz, t);
        l.upX.setValueAtTime(0, t);
        l.upY.setValueAtTime(1, t);
        l.upZ.setValueAtTime(0, t);
      } else if (typeof l.setOrientation === "function") {
        l.setOrientation(fx, 0, fz, 0, 1, 0);
      }
    }
  }

  /**
   * Play a one-shot (or looping) SFX voice by registry key.
   * @param {string} name registry key
   * @param {{pos?:{x:number,y:number,z:number}, volume?:number, velocity?:number, rng?:()=>number}} [opts]
   * @returns {{stop:(at?:number)=>void}} handle
   */
  play(name, opts = {}) {
    this.ensure();
    const ctx = this.ctx;
    const synth = this.registry ? this.registry[name] : null;
    if (typeof synth !== "function") {
      // Unknown sound — return a no-op handle so callers never crash.
      return { stop() {} };
    }

    const volume = opts.volume != null ? opts.volume : 1;
    const velocity = opts.velocity != null ? opts.velocity : 1;

    const voiceGain = ctx.createGain();
    voiceGain.gain.value = clamp01(volume);

    let inputNode = voiceGain; // node the synth connects its output into

    if (opts.pos) {
      const panner = ctx.createPanner();
      panner.panningModel = "equalpower";
      panner.distanceModel = "inverse";
      panner.refDistance = 4;
      panner.maxDistance = 48;
      panner.rolloffFactor = 1;
      if (panner.positionX) {
        const t = ctx.currentTime;
        panner.positionX.setValueAtTime(opts.pos.x, t);
        panner.positionY.setValueAtTime(opts.pos.y, t);
        panner.positionZ.setValueAtTime(opts.pos.z, t);
      } else if (typeof panner.setPosition === "function") {
        panner.setPosition(opts.pos.x, opts.pos.y, opts.pos.z);
      }
      // chain: synth -> panner -> voiceGain -> sfx
      panner.connect(voiceGain);
      inputNode = panner;
    }

    voiceGain.connect(this.sfx);

    const handle = synth(ctx, inputNode, ctx.currentTime, {
      rng: opts.rng,
      velocity,
    }) || {};

    const voice = {
      stop: (at) => {
        try {
          if (typeof handle.stop === "function") handle.stop(at);
        } catch (_e) { /* ignore */ }
      },
    };
    this._voices.add(voice);

    // Auto-remove finished one-shots after their reported duration + tail.
    const dur = typeof handle.duration === "number" ? handle.duration : 2;
    if (typeof setTimeout === "function" && isFinite(dur)) {
      setTimeout(() => this._voices.delete(voice), (dur + 1) * 1000);
    }

    return voice;
  }

  /**
   * Start a generative music track, stopping any current one first.
   * @param {'calm'|'nether'} [mode]
   * @param {object} [opts]
   * @returns {{stop:(fade?:number)=>void}} controller
   */
  startMusic(mode = "calm", opts = {}) {
    this.ensure();
    this.stopMusic({ fade: opts.fade != null ? opts.fade : 0.5 });
    const starter = mode === "nether" ? startNether : startCalm;
    this._music = starter(this, opts) || { stop() {} };
    return this._music;
  }

  /**
   * Stop the current music track with a fade.
   * @param {{fade?:number}} [opts]
   */
  stopMusic(opts = {}) {
    const fade = opts.fade != null ? opts.fade : 2;
    if (this._music) {
      try {
        if (typeof this._music.stop === "function") this._music.stop(fade);
      } catch (_e) { /* ignore */ }
      this._music = null;
    }
  }

  /**
   * Stop all music and every tracked voice.
   */
  stopAll() {
    this.stopMusic({ fade: 0.2 });
    const at = this.ctx ? this.ctx.currentTime : 0;
    for (const voice of this._voices) {
      try {
        if (typeof voice.stop === "function") voice.stop(at);
      } catch (_e) { /* ignore */ }
    }
    this._voices.clear();
  }
}

function clamp01(v) {
  v = +v;
  if (!isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
