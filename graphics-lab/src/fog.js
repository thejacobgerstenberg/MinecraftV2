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
// TUNING PHILOSOPHY (v2 — the v1 fog washed the whole island out):
//   * The demo camera orbits ~40-80 units from the terrain. At that range the
//     fog contribution must be near zero so AO, cast shadows and block texture
//     keep FULL contrast; only the far edges of the chunk (~120+ units) soften.
//     Defaults are retuned ~60% down from v1 accordingly.
//   * Readability caps: the base density is clamped (maxBaseDensity) and the
//     final effective density is clamped again after weather/time scaling
//     (maxDensity), so no configuration — including legacy callers passing the
//     old, hot v1 densities — can ever reduce the island to a milky lump.
//   * Weather may thicken the haze, but the combined weather x time multiplier
//     is hard-capped at maxHaze (~2x base). Rain/snow read as mood, not soup.
//   * Time-of-day adds only a whisper of valley haze at dawn/dusk (+6%) and
//     night (+10%). Sunrise stays crisp with long shadows.
//
// COLOUR: the fog colour tracks the CURRENT sky/horizon colour EXACTLY every
// frame — no easing lag — so at sunrise the fog is the same warm orange as the
// sky (never a white/grey band against an orange horizon) and at night it is
// the sky's near-black navy. The sky colour is taken from (in order):
//   1. ctx.skyColor / ctx.fogColor / ctx.horizonColor (a THREE.Color on ctx), or
//   2. a `skyRef` exposing getFogColor() (e.g. DynamicSky), pulled on tod change, or
//   3. the last value handed to setSkyColor(THREE.Color)  (snaps immediately).
// (Pass colorLerp > 0 to opt back in to eased colour, e.g. for slow-mo cameras.)
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
// v1 was 0.0065 and drowned the scene; ~60% cut. At 0.0026 the exp2 factor is
// ~2% at 60u, ~4% at 80u (full terrain contrast), ~16% at the 150u far corner.
const DEFAULT_DENSITY = 0.0026;
const DEFAULT_NEAR = 90; // linear-mode near plane (was 45 — fog started on-island)
const DEFAULT_FAR = 260; // linear-mode far plane  (was 140 — far corner was 100% fogged)

// Readability guards (see TUNING PHILOSOPHY above). Overridable per-instance.
const MAX_BASE_DENSITY = 0.0035; // clamp for the exp2 base (tames legacy v1 configs)
const MAX_FOG_DENSITY = 0.0060; // absolute cap AFTER weather/tod scaling
const MAX_HAZE = 2.0; // combined weather x time-of-day multiplier ceiling

export class DistanceFog {
  constructor(scene, {
    color = DEFAULT_COLOR,
    near = DEFAULT_NEAR,
    far = DEFAULT_FAR,
    density = DEFAULT_DENSITY,
    mode = DEFAULT_MODE, // 'exp2' (density haze) | 'linear' (near/far)
    skyRef = null, // optional { getFogColor(): THREE.Color } (e.g. DynamicSky)
    weatherScaling = true, // denser fog in rain/snow (capped, see maxHaze)
    todScaling = true, // whisper of dawn/dusk/night haze (capped)
    colorLerp = 0, // 0 = track the sky colour EXACTLY every frame (default);
    // > 0 = per-second ease rate toward the sky colour (legacy behaviour)
    rainDensity = 1.6, // haze multiplier in rain  (v1: 2.0)
    snowDensity = 1.8, // haze multiplier in snow  (v1: 2.7 — the pastel-mush culprit)
    maxHaze = MAX_HAZE, // hard cap on the combined haze multiplier
    maxBaseDensity = MAX_BASE_DENSITY, // clamp applied to the exp2 base density
    maxDensity = MAX_FOG_DENSITY, // clamp applied to the final exp2 density
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
    this._maxHaze = Math.max(1, maxHaze);
    this._maxBaseDensity = Math.max(0, maxBaseDensity);
    this._maxDensity = Math.max(0, maxDensity);
    this._rainDensity = clamp(rainDensity, 1, this._maxHaze);
    this._snowDensity = clamp(snowDensity, 1, this._maxHaze);
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

  // Effective exp2 density: readability-clamped base x haze, capped again so
  // no weather/time combination can wash the island out.
  _effectiveDensity() {
    const base = Math.min(this._baseDensity, this._maxBaseDensity);
    return Math.min(base * this._haze, this._maxDensity);
  }

  // Build a fog object of the current mode, copying `src` as its colour.
  _makeFog(src) {
    const col = new THREE.Color();
    if (src && src.isColor) col.copy(src);
    else col.set(src);
    const fog = this._mode === 'linear'
      ? new THREE.Fog(col, this._near, this._far)
      : new THREE.FogExp2(col, this._effectiveDensity());
    fog.name = 'DistanceFog';
    return fog;
  }

  // --- Public setters -------------------------------------------------------

  // Sync target: feed the current sky/horizon colour so fog matches the sky.
  // Snaps the live fog colour immediately — the fog must never lag the sky
  // (a white fog band against an orange sunrise sky was v1's worst artefact).
  setSkyColor(color) {
    if (!color) return;
    if (color.isColor) this._skyColor.copy(color);
    else this._skyColor.set(color);
    if (this._fog) this._fog.color.copy(this._skyColor);
    this._colorInit = true;
  }

  setDensity(x) {
    this._baseDensity = Math.max(0, x);
    if (this._mode === 'exp2') this._fog.density = this._effectiveDensity();
  }

  setRange(near, far) {
    if (typeof near === 'number') this._near = near;
    if (typeof far === 'number') this._far = far;
    if (this._mode === 'linear') this._applyLinear();
  }

  // Adjust the readability guards at runtime (added in v2).
  setMaxHaze(x) {
    this._maxHaze = Math.max(1, x);
    this._rainDensity = Math.min(this._rainDensity, this._maxHaze);
    this._snowDensity = Math.min(this._snowDensity, this._maxHaze);
  }

  setDensityCaps(maxBase, maxEffective) {
    if (typeof maxBase === 'number') this._maxBaseDensity = Math.max(0, maxBase);
    if (typeof maxEffective === 'number') this._maxDensity = Math.max(0, maxEffective);
    if (this._mode === 'exp2') this._fog.density = this._effectiveDensity();
  }

  // Switch between 'exp2' (density haze) and 'linear' (near/far) at runtime.
  setMode(mode) {
    const m = mode === 'linear' ? 'linear' : 'exp2';
    if (m === this._mode) return;
    this._mode = m;
    const old = this._fog;
    this._fog = this._makeFog(old.color); // carry the current colour across
    if (this._mode === 'exp2') this._fog.density = this._effectiveDensity();
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

  // Match the fog colour to the current sky/horizon colour. Default is an
  // EXACT per-frame copy (colorLerp === 0): warm orange at sunrise, light
  // blue-grey by day, near-black navy at night — always identical to the sky.
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

    if (!this._colorInit || !(this._colorLerp > 0)) {
      this._fog.color.copy(this._skyColor); // exact track — zero lag
      this._colorInit = true;
    } else {
      const a = clamp(dt * this._colorLerp, 0, 1);
      this._fog.color.lerp(this._skyColor, a);
    }
  }

  // Ease the haze multiplier toward its weather + time-of-day target and apply.
  // The target is hard-capped at maxHaze so the island always stays readable.
  _refreshDensity(dt, ctx) {
    let target = 1;
    if (this._weatherScaling && ctx && ctx.weather) {
      if (ctx.weather === 'rain') target *= this._rainDensity;
      else if (ctx.weather === 'snow') target *= this._snowDensity;
    }
    if (this._todScaling && ctx && typeof ctx.timeOfDay === 'number') {
      target *= this._todHaze(ctx.timeOfDay);
    }
    target = Math.min(target, this._maxHaze);

    this._haze = dt > 0 ? lerp(this._haze, target, clamp(dt * 3.0, 0, 1)) : target;

    if (this._mode === 'exp2') this._fog.density = this._effectiveDensity();
    else this._applyLinear();
  }

  // Whisper of extra haze at twilight and deep night. v1 added +30% at dawn
  // (the sunrise milk); v2 keeps sunrise crisp — just a hint of valley haze.
  _todHaze(t) {
    const dTwilight = Math.min(Math.abs(t - 0.25), Math.abs(t - 0.75));
    const mist = 1 - smoothstep(dTwilight, 0.0, 0.10); // 1 at dawn/dusk -> 0
    const night = 1 - smoothstep(Math.min(t, 1 - t), 0.0, 0.18); // 1 at midnight
    return 1 + 0.06 * mist + 0.10 * night;
  }

  // Apply the current haze to a linear fog's near/far (far pulls in as haze
  // rises; haze is already capped at maxHaze so far never collapses onto the
  // island).
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
