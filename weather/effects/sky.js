// weather/effects/sky.js
// SkyController — default export. Owns scene.background, scene.fog and the three
// weather lights (hemisphere, directional "sun", ambient); lerps them toward
// per-(weather x dayNight) palette targets and applies the lightning flash.

import * as THREE from "three";

/** Clamp any value into the 0..1 range; non-finite -> 0. */
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Smoothing time-constant (seconds) for palette lerps; ~1.5s to settle. */
const TAU = 0.5;

/** Bright bluish-white the lightning flash lifts the scene toward at peak. */
const FLASH_TINT = new THREE.Color(0xeaf1ff);

/**
 * Palette table keyed [weather][dayNight]. Each entry is the FULL-INTENSITY
 * target for that combination. setIntensity blends between the matching "clear"
 * entry (at v=0) and the weather entry (at v=1), so low intensity reads closer
 * to clear and rising intensity "deepens" the weather (darker bg, thicker fog,
 * dimmer sun). Fields:
 *   bg         background / sky color (hex)
 *   fog        fog color (hex)
 *   fogDensity FogExp2 density
 *   sun        directional sun/moon color (hex)
 *   sunI       directional intensity
 *   hemiSky    hemisphere light sky color (hex)
 *   hemiGround hemisphere light ground color (hex)
 *   hemiI      hemisphere intensity
 *   ambI       ambient intensity
 */
const PALETTE = {
  clear: {
    day:   { bg: 0x87b7e8, fog: 0xbcd6f0, fogDensity: 0.0025, sun: 0xfff4e0, sunI: 1.40, hemiSky: 0x87b7e8, hemiGround: 0x5a7048, hemiI: 0.90, ambI: 0.25 },
    night: { bg: 0x0a1226, fog: 0x0a1424, fogDensity: 0.0040, sun: 0x9fb4d8, sunI: 0.25, hemiSky: 0x1b2a4a, hemiGround: 0x0a1220, hemiI: 0.15, ambI: 0.08 },
  },
  rain: {
    day:   { bg: 0x8b95a1, fog: 0x8b95a1, fogDensity: 0.0120, sun: 0xb8c0cc, sunI: 0.50, hemiSky: 0x9aa4b0, hemiGround: 0x50565e, hemiI: 0.60, ambI: 0.30 },
    night: { bg: 0x10151f, fog: 0x10151f, fogDensity: 0.0140, sun: 0x7f8ea8, sunI: 0.15, hemiSky: 0x1a222f, hemiGround: 0x0b0f16, hemiI: 0.12, ambI: 0.09 },
  },
  storm: {
    day:   { bg: 0x3a4048, fog: 0x3a4048, fogDensity: 0.0300, sun: 0x6b7480, sunI: 0.25, hemiSky: 0x484f58, hemiGround: 0x24282e, hemiI: 0.40, ambI: 0.22 },
    night: { bg: 0x080a10, fog: 0x080a10, fogDensity: 0.0350, sun: 0x5a6478, sunI: 0.10, hemiSky: 0x12161f, hemiGround: 0x05070b, hemiI: 0.08, ambI: 0.07 },
  },
  snow: {
    day:   { bg: 0xd6e0ea, fog: 0xdfe8f0, fogDensity: 0.0200, sun: 0xf0f4fa, sunI: 1.00, hemiSky: 0xdfe8f2, hemiGround: 0x9aa6b2, hemiI: 1.00, ambI: 0.40 },
    night: { bg: 0x141c2c, fog: 0x18202f, fogDensity: 0.0220, sun: 0xaec0dc, sunI: 0.30, hemiSky: 0x2a3650, hemiGround: 0x121a28, hemiI: 0.25, ambI: 0.14 },
  },
};

/**
 * SkyController manages the whole-scene atmosphere. It creates and owns
 * scene.background (a Color), scene.fog (FogExp2) and three lights, then each
 * frame lerps their values toward the palette target selected by the current
 * weather / intensity / day-night, and additively layers the lightning flash.
 */
export default class SkyController {
  /**
   * @param {THREE.Scene} scene scene whose background/fog/lights are owned here
   * @param {{ weather?:string, dayNight?:string, intensity?:number,
   *           sunPosition?:{x:number,y:number,z:number} }} [opts]
   */
  constructor(scene, opts = {}) {
    this.scene = scene;

    this._weather = PALETTE[opts.weather] ? opts.weather : "clear";
    this._dayNight = opts.dayNight === "night" ? "night" : "day";
    this._intensity = clamp01(opts.intensity ?? 1);
    this._flash = 0;

    // --- owned scene atmosphere ---
    this._bg = new THREE.Color(0x000000);        // display background (written every frame)
    this._fog = new THREE.FogExp2(0x000000, 0.001);
    this._hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this._sun = new THREE.DirectionalLight(0xffffff, 1);
    this._ambient = new THREE.AmbientLight(0xffffff, 0.2);

    const sp = opts.sunPosition || { x: 60, y: 90, z: 40 };
    this._sun.position.set(sp.x, sp.y, sp.z);

    // Current (lerped palette) state — kept separate from the flash-modulated
    // display values so applyFlash is non-destructive and self-healing.
    this._curBg = new THREE.Color();
    this._curFog = new THREE.Color();
    this._curSun = new THREE.Color();
    this._curHemiSky = new THREE.Color();
    this._curHemiGround = new THREE.Color();
    this._curFogDensity = 0.001;
    this._curSunI = 1;
    this._curHemiI = 1;
    this._curAmbI = 0.2;

    // Scratch target colors (avoids per-frame allocation).
    this._tBg = new THREE.Color();
    this._tFog = new THREE.Color();
    this._tSun = new THREE.Color();
    this._tHemiSky = new THREE.Color();
    this._tHemiGround = new THREE.Color();

    this._recomputeTargets();
    this._snapToTargets(); // start already at the target so frame 0 looks right

    try {
      if (this.scene) {
        this.scene.background = this._bg;
        this.scene.fog = this._fog;
        this.scene.add(this._hemi);
        this.scene.add(this._sun);
        this.scene.add(this._ambient);
      }
    } catch {
      /* tolerate a missing/invalid scene */
    }

    this._write(0);
  }

  /**
   * Select the weather palette. Unknown states are ignored (kept as-is).
   * @param {("clear"|"rain"|"storm"|"snow")} state weather state
   * @returns {void}
   */
  setWeather(state) {
    if (!PALETTE[state]) return;
    this._weather = state;
    this._recomputeTargets();
  }

  /**
   * Set precip intensity; deepens the current weather palette as it rises.
   * @param {number} v intensity 0..1 (v=0 reads like clear, v=1 is full weather)
   * @returns {void}
   */
  setIntensity(v) {
    this._intensity = clamp01(v);
    this._recomputeTargets();
  }

  /**
   * Select the base day/night palette and light levels.
   * @param {("day"|"night")} mode "night" -> dark blue, dim cool moon
   * @returns {void}
   */
  setDayNight(mode) {
    this._dayNight = mode === "night" ? "night" : "day";
    this._recomputeTargets();
  }

  /**
   * Apply the lightning flash for this frame. Non-destructive: recomputes the
   * display from the lerped palette + flash each call, so it self-heals to the
   * palette when flash01 returns to 0. Call every frame AFTER update().
   * @param {number} flash01 flash brightness 0..1 (e.g. lightning.getFlash())
   * @returns {void}
   */
  applyFlash(flash01) {
    this._flash = clamp01(flash01);
    this._write(this._flash);
  }

  /**
   * Smoothly lerp current bg/fog/light values toward the palette targets and
   * write the (unflashed) result onto the THREE objects.
   * @param {number} dt seconds since last frame
   * @returns {void}
   */
  update(dt) {
    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    const a = step > 0 ? 1 - Math.exp(-step / TAU) : 0;

    if (a > 0) {
      this._curBg.lerp(this._tBg, a);
      this._curFog.lerp(this._tFog, a);
      this._curSun.lerp(this._tSun, a);
      this._curHemiSky.lerp(this._tHemiSky, a);
      this._curHemiGround.lerp(this._tHemiGround, a);
      this._curFogDensity += (this._targetFogDensity - this._curFogDensity) * a;
      this._curSunI += (this._targetSunI - this._curSunI) * a;
      this._curHemiI += (this._targetHemiI - this._curHemiI) * a;
      this._curAmbI += (this._targetAmbI - this._curAmbI) * a;
    }

    // Write the base (flash-free) state; applyFlash will overlay if called.
    this._write(0);
  }

  /**
   * Remove owned lights from the scene and dispose them. Safe to call twice.
   * @returns {void}
   */
  dispose() {
    for (const obj of [this._hemi, this._sun, this._ambient]) {
      try {
        if (this.scene && obj) this.scene.remove(obj);
      } catch {
        /* ignore */
      }
      try {
        if (obj && obj.dispose) obj.dispose();
      } catch {
        /* ignore */
      }
    }
    try {
      if (this.scene && this.scene.fog === this._fog) this.scene.fog = null;
    } catch {
      /* ignore */
    }
    this._hemi = null;
    this._sun = null;
    this._ambient = null;
  }

  // --- internals ---

  /**
   * Recompute the numeric/color targets by blending the "clear" entry (v=0)
   * with the active weather entry (v=1) for the current day/night.
   * @returns {void}
   * @private
   */
  _recomputeTargets() {
    const dn = this._dayNight;
    const base = PALETTE.clear[dn];
    const wx = (PALETTE[this._weather] || PALETTE.clear)[dn];
    const t = this._intensity;
    const s = this._scratch || (this._scratch = new THREE.Color());

    this._tBg.set(base.bg).lerp(s.set(wx.bg), t);
    this._tFog.set(base.fog).lerp(s.set(wx.fog), t);
    this._tSun.set(base.sun).lerp(s.set(wx.sun), t);
    this._tHemiSky.set(base.hemiSky).lerp(s.set(wx.hemiSky), t);
    this._tHemiGround.set(base.hemiGround).lerp(s.set(wx.hemiGround), t);

    this._targetFogDensity = base.fogDensity + (wx.fogDensity - base.fogDensity) * t;
    this._targetSunI = base.sunI + (wx.sunI - base.sunI) * t;
    this._targetHemiI = base.hemiI + (wx.hemiI - base.hemiI) * t;
    this._targetAmbI = base.ambI + (wx.ambI - base.ambI) * t;
  }

  /**
   * Snap the current lerp state instantly to the targets.
   * @returns {void}
   * @private
   */
  _snapToTargets() {
    this._curBg.copy(this._tBg);
    this._curFog.copy(this._tFog);
    this._curSun.copy(this._tSun);
    this._curHemiSky.copy(this._tHemiSky);
    this._curHemiGround.copy(this._tHemiGround);
    this._curFogDensity = this._targetFogDensity;
    this._curSunI = this._targetSunI;
    this._curHemiI = this._targetHemiI;
    this._curAmbI = this._targetAmbI;
  }

  /**
   * Write the current palette state, modulated by the given flash amount, onto
   * the actual THREE objects. flash brightens bg/fog toward white and boosts
   * light intensities; flash=0 writes the palette exactly.
   * @param {number} flash flash brightness 0..1
   * @returns {void}
   * @private
   */
  _write(flash) {
    const f = clamp01(flash);

    try {
      this._bg.copy(this._curBg);
      if (f > 0) this._bg.lerp(FLASH_TINT, f * 0.88);

      this._fog.color.copy(this._curFog);
      if (f > 0) this._fog.color.lerp(FLASH_TINT, f * 0.55);
      this._fog.density = this._curFogDensity;

      this._sun.color.copy(this._curSun);
      this._sun.intensity = this._curSunI + f * 2.6;

      this._hemi.color.copy(this._curHemiSky);
      this._hemi.groundColor.copy(this._curHemiGround);
      this._hemi.intensity = this._curHemiI + f * 1.5;

      this._ambient.intensity = this._curAmbI + f * 0.9;
    } catch {
      /* objects may be disposed mid-frame; ignore */
    }
  }
}
