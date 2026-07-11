/**
 * graphics-lab/settings/settings.js
 *
 * Self-contained GRAPHICS SETTINGS PANEL (right-side drawer + gear button).
 * Pure DOM ES module — no three.js dependency, no network resources.
 * Pair with ./settings.css (must be loaded by the embedding page).
 *
 *   import { createSettingsPanel } from './settings/settings.js';
 *   const panel = createSettingsPanel({ mount: document.body });
 *   window.addEventListener('graphics-settings-change', (e) => {
 *     const { key, value, settings } = e.detail;  // apply to your renderer
 *   });
 *
 * Behaviour contract:
 *  - Every change persists to localStorage under `storageKey` (JSON blob).
 *  - On create, state hydrates as  DEFAULTS <- initial <- storage
 *    (storage wins for keys it already has; `initial` only seeds unstored keys).
 *  - Every non-silent change dispatches CustomEvent 'graphics-settings-change'
 *    on window with detail = { key, value, settings } AND calls the optional
 *    `onChange(detail)` callback.
 *  - Picking a quality preset applies that preset's effect-toggle profile.
 *    Overriding any toggle afterwards flips the preset readout to "Custom"
 *    (and snaps back if the toggles come to match a preset exactly again).
 *
 * See ./README.md for the settings-key -> graphics-lab module hook mapping.
 */

export const EVENT_NAME = 'graphics-settings-change';

/** Factory-default settings. `preset: 'medium'` matches PRESETS.medium below. */
export const DEFAULTS = Object.freeze({
  preset: 'medium',        // 'low' | 'medium' | 'high' | 'ultra' | 'custom'
  renderDistance: 8,       // chunks (2..32); world units = chunks * 16
  fov: 75,                 // degrees (60..110)
  fpsCap: 60,              // 30 | 60 | 120 | 0 (0 = uncapped)
  vsync: true,             // advisory flag (rAF is always vsynced in browsers)
  // --- effect toggles ---
  ao: true,                // per-vertex ambient occlusion (voxel mesher AO)
  ssao: true,              // screen-space AO (post pass; on from medium up)
  shadows: true,
  water: true,             // water surface + underwater effects
  bloom: true,
  godRays: true,           // crepuscular rays (post pass; on from medium up)
  windSway: true,
  particles: true,
  fog: true,
  biomeGrading: true,
  portalFx: true,
});

/** The boolean effect toggles a quality preset drives. */
export const TOGGLE_KEYS = Object.freeze([
  'ao', 'ssao', 'shadows', 'water', 'bloom', 'godRays',
  'windSway', 'particles', 'fog', 'biomeGrading', 'portalFx',
]);

/** Effect-toggle profiles per quality preset.
 *  ssao/godRays mirror the PostFX QUALITY gating (src/postprocessing.js):
 *  OFF at low, ON from medium up — medium/high/ultra then differ in pass
 *  internals (sample counts, resolutions, budgets), not in which toggles run. */
export const PRESETS = Object.freeze({
  low: Object.freeze({
    ao: true,  ssao: false, shadows: false, water: false, bloom: false,
    godRays: false, windSway: false, particles: false, fog: true,
    biomeGrading: false, portalFx: false,
  }),
  medium: Object.freeze({
    ao: true,  ssao: true,  shadows: true,  water: true,  bloom: true,
    godRays: true,  windSway: true,  particles: true,  fog: true,
    biomeGrading: true,  portalFx: true,
  }),
  high: Object.freeze({
    ao: true,  ssao: true,  shadows: true,  water: true,  bloom: true,
    godRays: true,  windSway: true,  particles: true,  fog: true,
    biomeGrading: true,  portalFx: true,
  }),
  ultra: Object.freeze({
    ao: true,  ssao: true,  shadows: true,  water: true,  bloom: true,
    godRays: true,  windSway: true,  particles: true,  fog: true,
    biomeGrading: true,  portalFx: true,
  }),
});

export const PRESET_ORDER = Object.freeze(['low', 'medium', 'high', 'ultra']);
export const FPS_CAPS = Object.freeze([30, 60, 120, 0]); // 0 = uncapped

const RANGES = {
  renderDistance: { min: 2, max: 32, step: 1 },
  fov: { min: 60, max: 110, step: 1 },
};

const EFFECT_META = [
  { key: 'ao',           label: 'Ambient Occlusion', hint: 'vertex' },
  { key: 'ssao',         label: 'SSAO',              hint: 'screen-space' },
  { key: 'shadows',      label: 'Shadows',           hint: 'sun shadow map' },
  { key: 'water',        label: 'Water Effects',     hint: 'waves + underwater' },
  { key: 'bloom',        label: 'Bloom',             hint: 'HDR glow' },
  { key: 'godRays',      label: 'God Rays',          hint: 'light shafts' },
  { key: 'windSway',     label: 'Wind Sway',         hint: 'foliage' },
  { key: 'particles',    label: 'Particles',         hint: 'weather + debris' },
  { key: 'fog',          label: 'Fog',               hint: 'distance haze' },
  { key: 'biomeGrading', label: 'Biome Grading',     hint: 'color grade' },
  { key: 'portalFx',     label: 'Portal FX',         hint: 'gates + motes' },
];

// ---------------------------------------------------------------------------
// value sanitation
// ---------------------------------------------------------------------------

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeValue(key, value) {
  switch (key) {
    case 'preset':
      return (value === 'custom' || Object.prototype.hasOwnProperty.call(PRESETS, value))
        ? value : DEFAULTS.preset;
    case 'renderDistance':
      return clampInt(value, RANGES.renderDistance.min, RANGES.renderDistance.max, DEFAULTS.renderDistance);
    case 'fov':
      return clampInt(value, RANGES.fov.min, RANGES.fov.max, DEFAULTS.fov);
    case 'fpsCap': {
      const n = Math.round(Number(value));
      return FPS_CAPS.includes(n) ? n : DEFAULTS.fpsCap;
    }
    default:
      return !!value; // vsync + all effect toggles are booleans
  }
}

function sanitizeAll(raw) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = sanitizeValue(key, raw[key]);
  return out;
}

/** Return the preset name whose profile exactly matches the toggles, or null. */
function matchPreset(settings) {
  outer: for (const name of PRESET_ORDER) {
    const profile = PRESETS[name];
    for (const key of TOGGLE_KEYS) {
      if (settings[key] !== profile[key]) continue outer;
    }
    return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// tiny DOM helpers
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const GEAR_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M10.3 2h3.4l.5 2.4c.6.2 1.2.5 1.7 1l2.3-.8 1.7 2.9-1.8 1.6c.1.3.1.6.1.9s0 .6-.1.9l1.8 1.6-1.7 2.9-2.3-.8c-.5.4-1.1.7-1.7 1L13.7 18h-3.4l-.5-2.4c-.6-.2-1.2-.5-1.7-1l-2.3.8-1.7-2.9 1.8-1.6c-.1-.3-.1-.6-.1-.9s0-.6.1-.9L4.1 7.5l1.7-2.9 2.3.8c.5-.4 1.1-.7 1.7-1L10.3 2Zm1.7 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" transform="translate(0 2)"/>' +
  '</svg>';

const CLOSE_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M5 3.6 12 10.6 19 3.6 20.4 5 13.4 12 20.4 19 19 20.4 12 13.4 5 20.4 3.6 19 10.6 12 3.6 5Z"/>' +
  '</svg>';

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * Create and mount the graphics settings panel.
 *
 * @param {object}   [opts]
 * @param {Element|string} [opts.mount=document.body]  element (or selector) to append into
 * @param {object}   [opts.initial={}]                 seed values for keys not yet in storage
 * @param {string}   [opts.storageKey='mc2.graphics']  localStorage key (JSON)
 * @param {function} [opts.onChange]                   called with { key, value, settings } per change
 * @param {boolean}  [opts.startOpen=false]            open the drawer immediately
 * @returns {{ element: HTMLElement, get(): object,
 *             set(patch: object, opts?: { silent?: boolean }): void,
 *             open(): void, close(): void, toggle(): void, destroy(): void }}
 */
export function createSettingsPanel({
  mount = (typeof document !== 'undefined' ? document.body : null),
  initial = {},
  storageKey = 'mc2.graphics',
  onChange = null,
  startOpen = false,
} = {}) {
  const mountEl = typeof mount === 'string' ? document.querySelector(mount) : mount;
  if (!mountEl) throw new Error('[settings] mount element not found');

  // --- state -----------------------------------------------------------
  let stored = null;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) stored = JSON.parse(raw);
  } catch (_) { /* private mode / quota / corrupt JSON -> ignore */ }
  if (!stored || typeof stored !== 'object') stored = {};

  // storage wins over `initial`; `initial` only seeds keys not yet stored
  const merged = { ...DEFAULTS, ...initial };
  for (const key of Object.keys(DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(stored, key)) merged[key] = stored[key];
  }
  const settings = sanitizeAll(merged);

  let destroyed = false;
  const syncFns = []; // UI refreshers, run after every state change

  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch (_) { /* ignore */ }
  }

  function get() {
    return { ...settings };
  }

  function emit(key) {
    const detail = { key, value: settings[key], settings: get() };
    try {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
    } catch (_) { /* non-browser env */ }
    if (typeof onChange === 'function') {
      try { onChange(detail); } catch (err) { console.error('[settings] onChange threw', err); }
    }
  }

  function refreshUI() {
    for (let i = 0; i < syncFns.length; i++) syncFns[i]();
  }

  /**
   * Apply a patch. If the patch names a real preset, that preset's toggle
   * profile is expanded underneath it (explicit patch keys still win).
   * After any toggle-only change the preset readout re-derives itself
   * (exact profile match -> that preset name, otherwise 'custom').
   */
  function set(patch, opts = {}) {
    if (destroyed || !patch || typeof patch !== 'object') return;
    const silent = !!opts.silent;

    let expanded = patch;
    if (typeof patch.preset === 'string' && PRESETS[patch.preset]) {
      expanded = { ...PRESETS[patch.preset], ...patch };
    }

    const changed = [];
    for (const key of Object.keys(expanded)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
      const value = sanitizeValue(key, expanded[key]);
      if (settings[key] !== value) {
        settings[key] = value;
        changed.push(key);
      }
    }
    if (changed.length === 0) return;

    // Re-derive the preset readout when toggles moved without an explicit preset.
    if (!('preset' in expanded)) {
      let touchedToggles = false;
      for (let i = 0; i < changed.length; i++) {
        if (TOGGLE_KEYS.includes(changed[i])) { touchedToggles = true; break; }
      }
      if (touchedToggles) {
        const derived = matchPreset(settings) || 'custom';
        if (settings.preset !== derived) {
          settings.preset = derived;
          changed.push('preset');
        }
      }
    }

    persist();
    refreshUI();
    if (!silent) {
      for (let i = 0; i < changed.length; i++) emit(changed[i]);
    }
  }

  // --- DOM -------------------------------------------------------------
  const root = el('div', 'mc2gs');
  root.setAttribute('data-mc2gs', '');

  // gear launcher
  const gearBtn = el('button', 'mc2gs-gear');
  gearBtn.type = 'button';
  gearBtn.title = 'Graphics settings';
  gearBtn.setAttribute('aria-label', 'Open graphics settings');
  gearBtn.setAttribute('aria-expanded', 'false');
  gearBtn.innerHTML = GEAR_SVG;
  root.appendChild(gearBtn);

  // drawer
  const drawer = el('aside', 'mc2gs-drawer');
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-label', 'Graphics settings');
  drawer.setAttribute('aria-hidden', 'true');
  root.appendChild(drawer);

  const header = el('header', 'mc2gs-header');
  const titleWrap = el('div', 'mc2gs-title-wrap');
  titleWrap.appendChild(el('span', 'mc2gs-title-cube'));
  const titleText = el('div', 'mc2gs-title-text');
  titleText.appendChild(el('h2', 'mc2gs-title', 'Graphics'));
  titleText.appendChild(el('p', 'mc2gs-subtitle', 'MinecraftV2 render settings'));
  titleWrap.appendChild(titleText);
  header.appendChild(titleWrap);
  const closeBtn = el('button', 'mc2gs-close');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close graphics settings');
  closeBtn.innerHTML = CLOSE_SVG;
  header.appendChild(closeBtn);
  drawer.appendChild(header);

  const body = el('div', 'mc2gs-body');
  drawer.appendChild(body);

  function section(title) {
    const sec = el('section', 'mc2gs-section');
    const head = el('div', 'mc2gs-section-head');
    head.appendChild(el('h3', 'mc2gs-section-title', title));
    sec.appendChild(head);
    body.appendChild(sec);
    return { sec, head };
  }

  // -- Quality section ---------------------------------------------------
  const quality = section('Quality');
  const customBadge = el('span', 'mc2gs-badge', 'Custom');
  customBadge.hidden = true;
  quality.head.appendChild(customBadge);

  const presetRow = el('div', 'mc2gs-presets');
  presetRow.setAttribute('role', 'group');
  presetRow.setAttribute('aria-label', 'Quality preset');
  const presetButtons = {};
  for (const name of PRESET_ORDER) {
    const btn = el('button', 'mc2gs-preset', name[0].toUpperCase() + name.slice(1));
    btn.type = 'button';
    btn.dataset.preset = name;
    btn.addEventListener('click', () => set({ preset: name }));
    presetButtons[name] = btn;
    presetRow.appendChild(btn);
  }
  quality.sec.appendChild(presetRow);
  syncFns.push(() => {
    for (const name of PRESET_ORDER) {
      const active = settings.preset === name;
      presetButtons[name].classList.toggle('is-active', active);
      presetButtons[name].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    customBadge.hidden = settings.preset !== 'custom';
  });

  // -- Display section ----------------------------------------------------
  const display = section('Display');

  function sliderRow(parent, key, label, unit) {
    const { min, max, step } = RANGES[key];
    const row = el('div', 'mc2gs-row mc2gs-row--slider');
    const top = el('div', 'mc2gs-row-top');
    const id = `mc2gs-${key}-${Math.random().toString(36).slice(2, 8)}`;
    const lab = el('label', 'mc2gs-label', label);
    lab.htmlFor = id;
    const val = el('output', 'mc2gs-value');
    top.appendChild(lab);
    top.appendChild(val);
    row.appendChild(top);
    const input = el('input', 'mc2gs-slider');
    input.type = 'range';
    input.id = id;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.addEventListener('input', () => set({ [key]: input.value }));
    row.appendChild(input);
    parent.appendChild(row);
    syncFns.push(() => {
      const v = settings[key];
      if (Number(input.value) !== v) input.value = String(v);
      val.textContent = unit ? `${v}${unit}` : String(v);
      const pct = ((v - min) / (max - min)) * 100;
      input.style.setProperty('--fill', `${pct}%`);
    });
    return input;
  }

  sliderRow(display.sec, 'renderDistance', 'Render Distance', ' ch');
  sliderRow(display.sec, 'fov', 'Field of View', '°');

  // FPS cap select
  {
    const row = el('div', 'mc2gs-row mc2gs-row--inline');
    const lab = el('label', 'mc2gs-label', 'FPS Cap');
    const id = 'mc2gs-fpscap';
    lab.htmlFor = id;
    row.appendChild(lab);
    const selWrap = el('span', 'mc2gs-select-wrap');
    const sel = el('select', 'mc2gs-select');
    sel.id = id;
    for (const cap of FPS_CAPS) {
      const opt = el('option', null, cap === 0 ? 'Uncapped' : `${cap} fps`);
      opt.value = String(cap);
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => set({ fpsCap: sel.value }));
    selWrap.appendChild(sel);
    row.appendChild(selWrap);
    display.sec.appendChild(row);
    syncFns.push(() => { sel.value = String(settings.fpsCap); });
  }

  function toggleRow(parent, key, label, hint) {
    const lab = el('label', 'mc2gs-toggle');
    const input = el('input', 'mc2gs-toggle-input');
    input.type = 'checkbox';
    input.addEventListener('change', () => set({ [key]: input.checked }));
    const track = el('span', 'mc2gs-toggle-track');
    track.appendChild(el('span', 'mc2gs-toggle-thumb'));
    const text = el('span', 'mc2gs-toggle-text');
    text.appendChild(el('span', 'mc2gs-toggle-label', label));
    if (hint) text.appendChild(el('span', 'mc2gs-toggle-hint', hint));
    lab.appendChild(input);
    lab.appendChild(track);
    lab.appendChild(text);
    parent.appendChild(lab);
    syncFns.push(() => { input.checked = !!settings[key]; });
    return input;
  }

  toggleRow(display.sec, 'vsync', 'VSync', 'advisory flag');

  // -- Effects section -----------------------------------------------------
  const effects = section('Effects');
  const effectsGrid = el('div', 'mc2gs-effects');
  effects.sec.appendChild(effectsGrid);
  for (const meta of EFFECT_META) toggleRow(effectsGrid, meta.key, meta.label, meta.hint);

  // -- footer ---------------------------------------------------------------
  const footer = el('footer', 'mc2gs-footer');
  const resetBtn = el('button', 'mc2gs-reset', 'Reset to defaults');
  resetBtn.type = 'button';
  resetBtn.addEventListener('click', () => set({ ...DEFAULTS }));
  footer.appendChild(resetBtn);
  const storageNote = el('p', 'mc2gs-note');
  storageNote.textContent = `Saved to localStorage · ${storageKey}`;
  footer.appendChild(storageNote);
  drawer.appendChild(footer);

  // --- open / close ---------------------------------------------------------
  let isOpen = false;

  function applyOpenState() {
    root.classList.toggle('is-open', isOpen);
    drawer.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    gearBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    gearBtn.setAttribute('aria-label', isOpen ? 'Close graphics settings' : 'Open graphics settings');
  }

  function open() {
    if (destroyed || isOpen) return;
    isOpen = true;
    applyOpenState();
    closeBtn.focus({ preventScroll: true });
  }

  function close() {
    if (destroyed || !isOpen) return;
    isOpen = false;
    applyOpenState();
    gearBtn.focus({ preventScroll: true });
  }

  function toggle() { isOpen ? close() : open(); }

  gearBtn.addEventListener('click', toggle);
  closeBtn.addEventListener('click', close);

  function onKeydown(e) {
    if (e.key === 'Escape' && isOpen) close();
  }
  window.addEventListener('keydown', onKeydown);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    window.removeEventListener('keydown', onKeydown);
    root.remove();
    syncFns.length = 0;
  }

  // --- boot -------------------------------------------------------------------
  refreshUI();
  persist(); // write the merged+sanitized state back so future loads are stable
  mountEl.appendChild(root);
  if (startOpen) {
    isOpen = true;
    applyOpenState();
  }

  return { element: root, get, set, open, close, toggle, destroy };
}

export default createSettingsPanel;
