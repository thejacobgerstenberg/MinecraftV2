// graphics-lab/src/fog.js
//
// DISTANCE FOG + HAZE.
//
//   class DistanceFog(scene, { color, near, far, density, mode, ... })
//
// Installs a THREE fog on the scene so the distant edges of the chunk dissolve
// into the sky/horizon colour instead of popping in against a hard silhouette.
// Two modes:
//   * 'exp2'   -> THREE.FogExp2(color, density)   density-based atmospheric haze
//                 (the default; fades gracefully with distance, no visible cut-off)
//   * 'linear' -> THREE.Fog(color, near, far)     classic near/far distance fog
//
// The trick that makes pop-in vanish is that every frame the fog colour is eased
// toward the *current* sky/horizon colour, so terrain silhouettes melt into the
// sky exactly where the geometry ends. The sky colour is taken from (in order):
//   1. ctx.skyColor / ctx.fogColor / ctx.horizonColor (a THREE.Color on ctx), or
//   2. a `skyRef` exposing getFogColor() (e.g. DynamicSky), pulled on tod change, or
//   3. the last value handed to setSkyColor(THREE.Color).
//
// Fog density scales up in rain/snow and gets a subtle boost at dawn/dusk/night
// (morning mist), all eased so weather/time changes never snap.
//
// Cooperates with water.js UnderwaterOverlay: that module snapshots scene.fog on
// the way down and restores it on the way up. While `this.suspended` is true (or
// ctx.underwater is set) DistanceFog yields — it never writes scene.fog — so the
// underwater fog wins, and it re-installs itself cleanly on surfacing.
//
// Follows the graphics-lab effect contract (update/setEnabled/enabled/dispose)
// and is allocation-free per frame.

import * as THREE from 'three';

const { clamp, lerp, smoothstep } = THREE.MathUtils;

// Defaults (also reported to the integrator).
const DEFAULT_COLOR = 0xbcd9f2; // sky-horizon light blue; overwritten by sky sync
const DEFAULT_MODE = 'exp2';
const DEFAULT_DENSITY = 0.0065; // FogExp2 density (gentle haze, strong far fade)
const DEFAULT_NEAR = 45; // linear-mode near plane
const DEFAULT_FAR = 140; // linear-mode far plane

export class DistanceFog {
  constructor(scene, {
    color = DEFAULT_COLOR,
    near = DEFAULT_NEAR,
    far = DEFAULT_FAR,
    density = DEFAULT_DENSITY,
    mode = DEFAULT_MODE, // 'exp2' (density haze) | 'linear' (near/far)
    skyRef = null, // optional { getFogColor(): THREE.Color } (e.g. DynamicSky)
    weatherScaling = true, // denser fog in rain/snow
    todScaling = true, // subtle dawn/dusk/night haze
    colorLerp = 4.0, // per-second rate the fog colour eases toward the sky
    rainDensity = 2.0, // haze multiplier in rain
    snowDensity = 2.7, // haze multiplier in snow
  } = {}) {
    this._scene = scene || null;
    this._enabled = true;

    // Public yield flag. Set true (e.g. by water's UnderwaterOverlay, or the
    // demo when submerging) to hand scene.fog to the underwater look; back to
    // false and DistanceFog restores its own fog on the next update.
    this.suspended = false;

    this._mode = mode === 'linear' ? 'linear' : 'exp2';
    this._baseDensity = Math.max(0, density);
    this._near = near;
    this._far = far;
    this._weatherScaling = !!weatherScaling;
    this._todScaling = !!todScaling;
    this._colorLerp = colorLerp;
    this._rainDensity = rainDensity;
    this._snowDensity = snowDensity;
    this._skyRef = (skyRef && typeof skyRef.getFogColor === 'function') ? skyRef : null;

    // Latest desired sky/horizon colour (reused; no per-frame allocation).
    this._skyColor = new THREE.Color(color);
    this._colorInit = false; // has the fog colour been snapped to a target yet?
    this._lastTod = -1; // last time-of-day seen (to throttle skyRef pulls)

    // Smoothed haze multiplier (>= 1), eased toward the weather/tod target.
    this._haze = 1;

    // scene.fog ownership bookkeeping.
    this._priorFog = null; // scene.fog as it was before we first attached
    this._capturedPrior = false; // latch: only snapshot the baseline once, so a
    // transient underwater-overlay fog can never be mistaken for the baseline
    this._lastUnderwater = false; // last ctx.underwater seen (for setEnabled)

    this._fog = this._makeFog(this._skyColor);
  }

  get enabled() {
    return this._enabled;
  }

  // The live THREE.Fog / THREE.FogExp2 instance (for inspection).
  get fog() {
    return this._fog;
  }

  get mode() {
    return this._mode;
  }

  // Build a fog object of the current mode, copying `src` as its colour.
  _makeFog(src) {
    const col = new THREE.Color();
    if (src && src.isColor) col.copy(src);
    else col.set(src);
    const fog = this._mode === 'linear'
      ? new THREE.Fog(col, this._near, this._far)
      : new THREE.FogExp2(col, this._baseDensity);
    fog.name = 'DistanceFog';
    return fog;
  }

  // --- Public setters -------------------------------------------------------

  // Sync target: feed the current sky/horizon colour so fog matches the sky.
  setSkyColor(color) {
    if (!color) return;
    if (color.isColor) this._skyColor.copy(color);
    else this._skyColor.set(color);
    // Snap immediately if we have never initialised the fog colour.
    if (!this._colorInit) {
      this._fog.color.copy(this._skyColor);
      this._colorInit = true;
    }
  }

  setDensity(x) {
    this._baseDensity = Math.max(0, x);
    if (this._mode === 'exp2') this._fog.density = this._baseDensity * this._haze;
  }

  setRange(near, far) {
    if (typeof near === 'number') this._near = near;
    if (typeof far === 'number') this._far = far;
    if (this._mode === 'linear') this._applyLinear();
  }

  // Switch between 'exp2' (density haze) and 'linear' (near/far) at runtime.
  setMode(mode) {
    const m = mode === 'linear' ? 'linear' : 'exp2';
    if (m === this._mode) return;
    this._mode = m;
    const old = this._fog;
    this._fog = this._makeFog(old.color); // carry the current colour across
    if (this._mode === 'exp2') this._fog.density = this._baseDensity * this._haze;
    else this._applyLinear();
    this._colorInit = true;
    // If we currently own scene.fog, swap the new object in seamlessly.
    if (this._scene && this._scene.fog === old) this._scene.fog = this._fog;
  }

  // Explicit yield control (mirrors the public `suspended` field).
  setSuspended(on) {
    this.suspended = !!on;
  }

  // --- Per-frame ------------------------------------------------------------

  // dt seconds, ctx = { camera, renderer, scene, elapsed, timeOfDay, sunDir,
  // weather, underwater }.
  update(dt, ctx) {
    const step = (typeof dt === 'number' && dt > 0) ? dt : 0;

    this._lastUnderwater = !!(ctx && ctx.underwater === true);
    const suspend = this.suspended || this._lastUnderwater;

    if (this._enabled) {
      this._refreshColor(step, ctx);
      this._refreshDensity(step, ctx);
    }

    this._apply(suspend);
  }

  // Ease the fog colour toward the current sky/horizon colour.
  _refreshColor(dt, ctx) {
    let src = null;
    if (ctx) {
      if (ctx.skyColor && ctx.skyColor.isColor) src = ctx.skyColor;
      else if (ctx.fogColor && ctx.fogColor.isColor) src = ctx.fogColor;
      else if (ctx.horizonColor && ctx.horizonColor.isColor) src = ctx.horizonColor;
    }

    if (src) {
      this._skyColor.copy(src);
    } else if (this._skyRef) {
      // getFogColor() clones, so only pull when time of day actually changed.
      const tod = (ctx && typeof ctx.timeOfDay === 'number') ? ctx.timeOfDay : this._lastTod;
      if (tod !== this._lastTod) {
        const c = this._skyRef.getFogColor();
        if (c && c.isColor) this._skyColor.copy(c);
      }
      this._lastTod = tod;
    }

    if (!this._colorInit) {
      this._fog.color.copy(this._skyColor);
      this._colorInit = true;
    } else {
      const a = this._colorLerp > 0 ? clamp(dt * this._colorLerp, 0, 1) : 1;
      this._fog.color.lerp(this._skyColor, a);
    }
  }

  // Ease the haze multiplier toward its weather + time-of-day target and apply.
  _refreshDensity(dt, ctx) {
    let target = 1;
    if (this._weatherScaling && ctx && ctx.weather) {
      if (ctx.weather === 'rain') target *= this._rainDensity;
      else if (ctx.weather === 'snow') target *= this._snowDensity;
    }
    if (this._todScaling && ctx && typeof ctx.timeOfDay === 'number') {
      target *= this._todHaze(ctx.timeOfDay);
    }

    this._haze = dt > 0 ? lerp(this._haze, target, clamp(dt * 2.5, 0, 1)) : target;

    if (this._mode === 'exp2') this._fog.density = this._baseDensity * this._haze;
    else this._applyLinear();
  }

  // Subtle extra haze at twilight (morning/evening mist) and deep night.
  _todHaze(t) {
    const dTwilight = Math.min(Math.abs(t - 0.25), Math.abs(t - 0.75));
    const mist = 1 - smoothstep(dTwilight, 0.0, 0.12); // 1 at dawn/dusk -> 0
    const night = 1 - smoothstep(Math.min(t, 1 - t), 0.0, 0.20); // 1 at midnight
    return 1 + 0.30 * mist + 0.15 * night;
  }

  // Apply the current haze to a linear fog's near/far (far pulls in as haze rises).
  _applyLinear() {
    const far = this._far / Math.max(this._haze, 1e-4);
    this._fog.far = far;
    this._fog.near = Math.min(this._near, far * 0.6);
  }

  // Reconcile scene.fog ownership. This is the single source of truth for
  // attach/detach so it cooperates cleanly with the underwater overlay:
  //   * want (enabled & not suspended) -> ensure scene.fog === our fog.
  //   * disabled & not suspended       -> detach if we own it, restoring prior.
  //   * suspended                      -> leave scene.fog alone (overlay owns it).
  _apply(suspend) {
    const scene = this._scene;
    if (!scene) return;

    const want = this._enabled && !suspend;

    if (want) {
      if (scene.fog !== this._fog) {
        // Snapshot the baseline once; never overwrite it with a fog we merely
        // displaced later (e.g. the underwater overlay's fog on a surfacing frame).
        if (!this._capturedPrior) {
          this._priorFog = scene.fog || null;
          this._capturedPrior = true;
        }
        scene.fog = this._fog;
      }
    } else if (!suspend) {
      // Only ever remove our own fog; never clobber another owner's.
      if (scene.fog === this._fog) scene.fog = this._priorFog || null;
    }
    // suspended: no-op — the underwater overlay is the sole scene.fog owner.
  }

  setEnabled(on) {
    const was = this._enabled;
    this._enabled = !!on;
    if (this._enabled === was) return;
    // Reconcile immediately for responsiveness, honouring the last-known yield
    // state so we never attach over the underwater fog.
    this._apply(this.suspended || this._lastUnderwater);
  }

  dispose() {
    if (this._scene && this._scene.fog === this._fog) {
      this._scene.fog = this._priorFog || null;
    }
    this._priorFog = null;
    this._fog = null;
    this._scene = null;
  }
}

export default DistanceFog;
