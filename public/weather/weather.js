// weather/weather.js
// WeatherSystem orchestrator: drives sky + rain/snow/lightning effects and emits weather events.

import * as THREE from "three";
import RainEffect from "./effects/rain.js";
import SnowEffect from "./effects/snow.js";
import LightningEffect from "./effects/lightning.js";
import SkyController from "./effects/sky.js";

/** Clamp a value into 0..1, treating non-finite input as 0. */
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Valid weather states this system understands. */
const STATES = new Set(["clear", "rain", "storm", "snow"]);

/**
 * WeatherSystem — the imperative orchestrator that mirrors the audio engine API.
 *
 * It owns a {@link SkyController} plus {@link RainEffect}, {@link SnowEffect} and
 * {@link LightningEffect}, activates the right effects per weather state, ramps a
 * single 0..1 intensity into whichever precip effect is live, drives storm
 * auto-lightning, and re-broadcasts effect activity as DOM CustomEvents.
 *
 * Extends EventTarget; dispatches:
 *  - "weatherChange" CustomEvent detail {from:string, to:string}
 *  - "lightningStrike" CustomEvent detail {far:boolean}
 */
export class WeatherSystem extends EventTarget {
  /**
   * @param {THREE.Scene} scene scene the sky + effects are added to
   * @param {THREE.Camera} camera camera the precip volumes follow
   * @param {{ intensity?:number, ramp?:number }} [opts] optional initial tuning
   */
  constructor(scene, camera, opts = {}) {
    super();
    this.scene = scene;
    this.camera = camera;

    // Sub-systems. SkyController owns background/fog/lights; the precip effects
    // start hidden (their constructors call setActive(false)).
    this._sky = new SkyController(scene, opts.sky || {});
    this._rain = new RainEffect(scene, camera, opts.rain || {});
    this._snow = new SnowEffect(scene, camera, opts.snow || {});
    this._lightning = new LightningEffect(scene, camera, opts.lightning || {});

    // State. Intensity has a target (set by callers) and a current (ramped in update()).
    this._weather = "clear";
    this._targetIntensity = clamp01(opts.intensity ?? 1);
    this._currentIntensity = this._targetIntensity;
    this._ramp = Number.isFinite(opts.ramp) ? Math.max(0, opts.ramp) : 1.5;

    // Monotonic clock advanced by update(); drives storm scheduling.
    this._elapsed = 0;
    this._nextStrikeAt = Infinity; // scheduled only while state === "storm"

    // Sky starts on a clear-day palette.
    this._sky.setWeather("clear");
    this._sky.setIntensity(this._currentIntensity);

    this._disposed = false;
  }

  /** @returns {SkyController} the sky/lights controller (read-only). */
  get sky() { return this._sky; }
  /** @returns {RainEffect} the rain effect (read-only). */
  get rain() { return this._rain; }
  /** @returns {SnowEffect} the snow effect (read-only). */
  get snow() { return this._snow; }
  /** @returns {LightningEffect} the lightning effect (read-only). */
  get lightning() { return this._lightning; }

  /**
   * Switch weather state and activate the matching effects. Idempotent for the
   * same state. Tells the sky to retarget its palette and emits "weatherChange".
   *
   * @param {"clear"|"rain"|"storm"|"snow"} state target weather
   * @param {{ ramp?:number }} [opts] optional; opts.ramp overrides the intensity ramp
   * @returns {void}
   */
  setWeather(state, opts = {}) {
    if (this._disposed) return;
    if (!STATES.has(state)) return;
    if (Number.isFinite(opts.ramp)) this._ramp = Math.max(0, opts.ramp);
    if (state === this._weather) return; // idempotent

    const from = this._weather;
    this._weather = state;

    const rainOn = state === "rain" || state === "storm";
    const snowOn = state === "snow";

    // Toggle precip effects. setActive tolerates being called repeatedly.
    this._rain.setActive(rainOn);
    this._snow.setActive(snowOn);

    // Lightning is always "active" (armed) but only auto-fires during storms.
    // Keep it active so manual strike() works in any weather; it self-idles.
    this._lightning.setActive(true);

    if (state === "storm") {
      this._scheduleNextStrike();
    } else {
      this._nextStrikeAt = Infinity;
    }

    // Push the sky toward the new palette and re-apply current intensity.
    this._sky.setWeather(state);
    this._sky.setIntensity(this._currentIntensity);

    // Feed the current intensity into whichever precip effect is now live.
    if (rainOn) this._rain.setIntensity(this._currentIntensity);
    if (snowOn) this._snow.setIntensity(this._currentIntensity);

    this.dispatchEvent(new CustomEvent("weatherChange", { detail: { from, to: state } }));
  }

  /**
   * Set the TARGET intensity. update() ramps the CURRENT intensity toward it over
   * ~ramp seconds and pushes it into the active precip effect + the sky.
   *
   * @param {number} v target intensity, clamped to 0..1
   * @param {number} [ramp=1.5] seconds to ease from current to target
   * @returns {void}
   */
  setIntensity(v, ramp = 1.5) {
    if (this._disposed) return;
    this._targetIntensity = clamp01(v);
    this._ramp = Number.isFinite(ramp) ? Math.max(0, ramp) : 1.5;
  }

  /**
   * Trigger a lightning flash (works in any weather, including manual strikes in
   * clear). Emits "lightningStrike" at flash start and returns the effect's
   * promise, which resolves AT THE FLASH PEAK with { far } so a caller can time
   * thunder audio to land right after the visible flash. Never throws.
   *
   * @param {{ far?:boolean }} [opts] far strikes are dimmer and skip the bolt
   * @returns {Promise<{far:boolean}>} resolves at the flash peak (~90ms)
   */
  strike(opts = {}) {
    if (this._disposed) return Promise.resolve({ far: !!opts.far });
    const far = !!opts.far;
    // Announce at flash START so listeners can react immediately.
    this.dispatchEvent(new CustomEvent("lightningStrike", { detail: { far } }));
    try {
      const p = this._lightning.strike(opts);
      return p && typeof p.then === "function" ? p : Promise.resolve({ far });
    } catch {
      return Promise.resolve({ far });
    }
  }

  /**
   * Advance the whole system by one frame: ramp intensity, update effects, pulse
   * the sky with the lightning flash, and auto-trigger storm strikes.
   *
   * @param {number} dt seconds since last frame (clamped to <= 0.1)
   * @returns {void}
   */
  update(dt) {
    if (this._disposed) return;
    const step = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0, 0.1));
    this._elapsed += step;

    // Ease current intensity toward the target over ~_ramp seconds.
    if (this._currentIntensity !== this._targetIntensity) {
      if (this._ramp <= 0) {
        this._currentIntensity = this._targetIntensity;
      } else {
        const k = Math.min(1, step / this._ramp);
        this._currentIntensity += (this._targetIntensity - this._currentIntensity) * k;
        if (Math.abs(this._targetIntensity - this._currentIntensity) < 1e-4) {
          this._currentIntensity = this._targetIntensity;
        }
      }
    }
    const intensity = clamp01(this._currentIntensity);

    // Feed intensity into the live precip effect + sky palette depth.
    if (this._weather === "rain" || this._weather === "storm") {
      this._rain.setIntensity(intensity);
    } else if (this._weather === "snow") {
      this._snow.setIntensity(intensity);
    }
    this._sky.setIntensity(intensity);

    // Storm auto-lightning: fire at randomized intervals, more often at higher
    // intensity. Scheduling is driven off the elapsed clock.
    if (this._weather === "storm" && this._elapsed >= this._nextStrikeAt) {
      const far = Math.random() < 0.45; // roughly half the strikes are distant
      // Fire and swallow; strike() already emits the event + never throws.
      this.strike({ far });
      this._scheduleNextStrike();
    }

    // Advance effects.
    this._rain.update(step, this._elapsed);
    this._snow.update(step, this._elapsed);
    this._lightning.update(step, this._elapsed);

    // Lerp the sky toward its palette targets first (its update() writes the
    // flash-free base state), THEN overlay this frame's lightning flash so the
    // whitening actually survives into the rendered frame. applyFlash() is
    // documented to run after update(); calling it before lets update()'s
    // trailing base-write erase the flash.
    this._sky.update(step);
    const flash = this._lightning.getFlash();
    this._sky.applyFlash(flash);
  }

  /**
   * Schedule the next auto storm strike ~4-12s out, biased shorter at higher
   * intensity. Internal.
   * @returns {void}
   */
  _scheduleNextStrike() {
    const i = clamp01(this._currentIntensity);
    // At i=1: ~2.5..7s. At i=0: ~6..12s.
    const min = 6 - 3.5 * i;
    const max = 12 - 5 * i;
    const wait = min + Math.random() * (max - min);
    this._nextStrikeAt = this._elapsed + wait;
  }

  /**
   * Subscribe to an event. Sugar over addEventListener.
   * @param {"weatherChange"|"lightningStrike"} type event name
   * @param {(e:CustomEvent)=>void} handler listener
   * @returns {() => void} an off() function that removes this handler
   */
  on(type, handler) {
    this.addEventListener(type, handler);
    return () => this.off(type, handler);
  }

  /**
   * Unsubscribe a previously registered handler.
   * @param {"weatherChange"|"lightningStrike"} type event name
   * @param {(e:CustomEvent)=>void} handler listener
   * @returns {void}
   */
  off(type, handler) {
    this.removeEventListener(type, handler);
  }

  /**
   * @returns {{ weather:string, intensity:number }} current state snapshot
   */
  getState() {
    return { weather: this._weather, intensity: clamp01(this._currentIntensity) };
  }

  /**
   * Dispose all effects + sky and stop scheduling. Safe to call once; wrapped in
   * try/catch so a failing sub-dispose never blocks the others.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._nextStrikeAt = Infinity;
    for (const sub of [this._rain, this._snow, this._lightning, this._sky]) {
      try { sub && sub.dispose && sub.dispose(); } catch { /* ignore */ }
    }
  }
}

export default WeatherSystem;
