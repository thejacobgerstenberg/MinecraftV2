/**
 * Loomfall UX — Options store (ux/options/options-store.js)
 *
 * The single propagation runtime for accessibility & game options
 * (LOOMFALL UX-ACCESS ARCHITECTURE CONTRACT v1 §5). Every demo/shell
 * imports this module; the <lf-access-options> panel edits through it.
 *
 * On load and on every commit the store applies, IN THIS ORDER:
 *  1. document.documentElement.dataset flags:
 *       data-lf-cvd            = colorblindMode  (removed when "none")
 *       data-lf-reduced-motion = "on" | "off"    (removed when "system")
 *     (data-colorblind / data-reduced-motion are mirrored for shells that
 *      used the older attribute names — data-lf-* is canonical.)
 *     data-theme is never touched (it stays the kit's light/dark switch).
 *  2. CSS custom property --lf-ui-scale on <html> plus
 *     font-size: calc(16px * var(--lf-ui-scale)) so rem-derived sizes scale.
 *  3. window.dispatchEvent(new CustomEvent("lf-options-change", {detail}))
 *     with detail { key, value, options } (key/value null on load/reset).
 *  4. Persists the merged object into localStorage "loomfall.settings" —
 *     volumes are flattened to volumeMaster/volumeSfx/volumeMusic and fov
 *     maps 1:1, matching the builder game's menu.js SETTINGS_SPEC keys.
 *     Unrelated keys already in loomfall.settings (renderDistance,
 *     sensitivity, texturePack, ...) are preserved untouched.
 *
 * Data shape is normative per ux/schemas/options.schema.json.
 * Framework-free ES module; only dependency is ui-kit/lf-core.js.
 */
import { clamp } from '../../ui-kit/lf-core.js';

/** localStorage key shared with the builder game's menu.js. */
export const STORAGE_KEY = 'loomfall.settings';

/** Event type dispatched on window for every commit (contract §4). */
export const CHANGE_EVENT = 'lf-options-change';

/**
 * Schema defaults (ux/schemas/options.schema.json). A valid options object
 * may be {} — consumers must fill these.
 * @type {Readonly<{colorblindMode:string, uiScale:number, reducedMotion:string,
 *   subtitles:boolean, fov:number, volumes:{master:number,sfx:number,music:number},
 *   difficulty:string}>}
 */
export const DEFAULTS = Object.freeze({
  colorblindMode: 'none',
  uiScale: 1,
  reducedMotion: 'system',
  subtitles: false,
  fov: 75,
  volumes: Object.freeze({ master: 1, sfx: 1, music: 0.7 }),
  difficulty: 'standard',
});

/** Enum domains (schema-mirrored). */
const ENUM = {
  colorblindMode: ['none', 'deuteranopia', 'protanopia', 'tritanopia'],
  reducedMotion: ['system', 'on', 'off'],
  difficulty: ['gentle', 'standard', 'unraveling'],
};

/** volumes.<bus> -> flat loomfall.settings key (GameAudio.setVolumes reads these). */
const VOLUME_FLAT = Object.freeze({ master: 'volumeMaster', sfx: 'volumeSfx', music: 'volumeMusic' });

/** Stylesheets this module owns; auto-linked (deduped) unless loadCss:false. */
const OWN_CSS = ['cvd.css', 'motion.css'];

/**
 * Effective reduced-motion state, combining the user's forced choice with
 * the OS preference. THE documented rule for game shake / particles /
 * camera bob: JS-driven motion must consult this before animating —
 *   if (motionReduced()) skip shake/particles; else play them.
 * CSS-driven motion uses the selector pattern documented in motion.css.
 * @param {HTMLElement} [root] - defaults to document.documentElement.
 * @returns {boolean} true when motion should be stilled.
 */
export function motionReduced(root = document.documentElement) {
  const forced = root.dataset.lfReducedMotion;
  if (forced === 'on') return true;
  if (forced === 'off') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Options store. Usually accessed through the shared singleton:
 *   import { getStore } from './options-store.js';
 *   const store = getStore();
 *   store.set('volumes.music', 0.5);
 *
 * Valid dot-paths: colorblindMode, uiScale, reducedMotion, subtitles, fov,
 * difficulty, volumes.master, volumes.sfx, volumes.music.
 */
export class OptionsStore {
  /**
   * @param {{storageKey?: string, root?: HTMLElement, loadCss?: boolean}} [opts]
   *   storageKey - localStorage key (default "loomfall.settings").
   *   root       - element receiving dataset/scale (default <html>).
   *   loadCss    - auto-<link> cvd.css + motion.css next to this module
   *                (deduped against already-present links). Default true.
   */
  constructor({ storageKey = STORAGE_KEY, root = document.documentElement, loadCss = true } = {}) {
    this.storageKey = storageKey;
    this.root = root;
    this._options = this._load();
    if (loadCss) this._ensureCss();
    this.apply();
    this._dispatch(null, null);
  }

  /** @returns {object} deep copy of the current options (schema shape). */
  get options() {
    return structuredClone(this._options);
  }

  /**
   * Read one option by dot-path.
   * @param {string} path @returns {*}
   */
  get(path) {
    if (path.startsWith('volumes.')) return this._options.volumes[path.slice(8)];
    return this._options[path];
  }

  /**
   * Commit one option: sanitize -> mutate -> apply -> persist -> dispatch.
   * Unknown paths warn and are ignored; out-of-range values are clamped.
   * @param {string} path - dot-path, e.g. "volumes.music".
   * @param {*} value
   * @returns {*} the sanitized value actually stored.
   */
  set(path, value) {
    const v = this._sanitize(path, value);
    if (v === undefined) {
      console.warn(`[options-store] unknown option "${path}" ignored`);
      return undefined;
    }
    if (path.startsWith('volumes.')) this._options.volumes[path.slice(8)] = v;
    else this._options[path] = v;
    this.apply();
    this._persist();
    this._dispatch(path, v);
    return v;
  }

  /**
   * Live preview (e.g. lf-input while dragging the UI-scale slider):
   * applies the visual side effects (dataset flags + --lf-ui-scale) of a
   * candidate value WITHOUT mutating state, persisting or dispatching.
   * A following set() commits or a plain apply() reverts.
   * @param {string} path @param {*} value
   */
  preview(path, value) {
    const v = this._sanitize(path, value);
    if (v === undefined) return;
    const merged = this.options;
    if (path.startsWith('volumes.')) merged.volumes[path.slice(8)] = v;
    else merged[path] = v;
    this._applyTo(merged);
  }

  /** Reset every option to schema defaults (persists + dispatches key:null). */
  reset() {
    this._options = structuredClone(DEFAULTS);
    this.apply();
    this._persist();
    this._dispatch(null, null);
  }

  /** Re-apply the current state to the root element (contract §5 steps 1-2). */
  apply() {
    this._applyTo(this._options);
  }

  /* ---------------- internals ---------------- */

  /** @param {string} path @param {*} value @returns {*|undefined} sanitized */
  _sanitize(path, value) {
    switch (path) {
      case 'colorblindMode':
      case 'reducedMotion':
      case 'difficulty':
        return ENUM[path].includes(value) ? value : DEFAULTS[path];
      case 'subtitles':
        return !!value;
      case 'uiScale': {
        const n = Number(value);
        // step 0.05 — round on a x20 integer grid to dodge float dust.
        return Number.isFinite(n) ? clamp(Math.round(n * 20) / 20, 0.75, 1.5) : DEFAULTS.uiScale;
      }
      case 'fov': {
        const n = Math.round(Number(value));
        return Number.isFinite(n) ? clamp(n, 60, 110) : DEFAULTS.fov;
      }
      case 'volumes.master':
      case 'volumes.sfx':
      case 'volumes.music': {
        const n = Number(value);
        return Number.isFinite(n) ? clamp(Math.round(n * 100) / 100, 0, 1) : DEFAULTS.volumes[path.slice(8)];
      }
      default:
        return undefined;
    }
  }

  /** Load state from localStorage (flat volume keys), defaults filled. */
  _load() {
    const o = structuredClone(DEFAULTS);
    const raw = this._readRaw();
    for (const key of ['colorblindMode', 'uiScale', 'reducedMotion', 'subtitles', 'fov', 'difficulty']) {
      if (raw[key] !== undefined) o[key] = this._sanitize(key, raw[key]);
    }
    for (const [bus, flat] of Object.entries(VOLUME_FLAT)) {
      if (raw[flat] !== undefined) o.volumes[bus] = this._sanitize(`volumes.${bus}`, raw[flat]);
    }
    return o;
  }

  /** @returns {object} parsed loomfall.settings or {} (never throws). */
  _readRaw() {
    try {
      const parsed = JSON.parse(localStorage.getItem(this.storageKey) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Merge into loomfall.settings, preserving keys owned by other systems. */
  _persist() {
    const raw = this._readRaw();
    const o = this._options;
    Object.assign(raw, {
      colorblindMode: o.colorblindMode,
      uiScale: o.uiScale,
      reducedMotion: o.reducedMotion,
      subtitles: o.subtitles,
      fov: o.fov,
      difficulty: o.difficulty,
      volumeMaster: o.volumes.master,
      volumeSfx: o.volumes.sfx,
      volumeMusic: o.volumes.music,
    });
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(raw));
    } catch {
      /* storage full/blocked: options still apply for this session */
    }
  }

  /** Contract §5 steps 1-2 against an arbitrary options object. */
  _applyTo(o) {
    const ds = this.root.dataset;
    if (o.colorblindMode !== 'none') {
      ds.lfCvd = o.colorblindMode;
      ds.colorblind = o.colorblindMode; // legacy mirror
    } else {
      delete ds.lfCvd;
      delete ds.colorblind;
    }
    if (o.reducedMotion !== 'system') {
      ds.lfReducedMotion = o.reducedMotion;
      ds.reducedMotion = o.reducedMotion; // legacy mirror
    } else {
      delete ds.lfReducedMotion;
      delete ds.reducedMotion;
    }
    this.root.style.setProperty('--lf-ui-scale', String(o.uiScale));
    this.root.style.fontSize = 'calc(16px * var(--lf-ui-scale))';
  }

  /** Contract §4 event. @param {string|null} key @param {*} value */
  _dispatch(key, value) {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { key, value, options: this.options } }));
  }

  /** Link cvd.css + motion.css (resolved against this module, deduped). */
  _ensureCss() {
    if (typeof document === 'undefined') return;
    for (const file of OWN_CSS) {
      const href = new URL(`./${file}`, import.meta.url).href;
      const present = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((l) => l.href === href);
      if (!present) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.appendChild(link);
      }
    }
  }
}

let sharedStore = null;

/**
 * Shared singleton accessor — panel, demos and the game shell all use the
 * same instance so state, dataset flags and events stay coherent.
 * @param {ConstructorParameters<typeof OptionsStore>[0]} [opts] - honored
 *   only on first call (when the instance is created).
 * @returns {OptionsStore}
 */
export function getStore(opts) {
  if (!sharedStore) sharedStore = new OptionsStore(opts);
  return sharedStore;
}
