/**
 * Loomfall UX — <lf-access-options> (ux/options/access-options.js)
 *
 * Accessibility & game-options panel. Docks into <lf-settings-shell> as a
 * category body:
 *
 *   <lf-settings-shell heading="Options">
 *     <section data-category="Accessibility">
 *       <lf-access-options></lf-access-options>
 *     </section>
 *   </lf-settings-shell>
 *
 * Composes the kit's lf-slider / lf-toggle / lf-dropdown (side-effect
 * imports, never reimplemented). All state lives in the shared
 * OptionsStore (options-store.js): the panel writes commits through
 * store.set() and re-syncs itself from every window "lf-options-change",
 * so several mounted panels (or the game shell) stay coherent.
 *
 * CONTROLS (dot-paths per ux/schemas/options.schema.json)
 *   colorblindMode  lf-dropdown  none | deuteranopia | protanopia | tritanopia
 *   uiScale         lf-slider    0.75..1.5 step 0.05 (lf-input = live preview)
 *   fov             lf-slider    60..110 deg
 *   reducedMotion   lf-dropdown  system | on | off  (tri-state per schema —
 *                                supersedes a plain on/off toggle)
 *   volumes.master  lf-slider    rendered 0..100 %, stored 0..1
 *   volumes.sfx     lf-slider    rendered 0..100 %, stored 0..1
 *   volumes.music   lf-slider    rendered 0..100 %, stored 0..1
 *   subtitles       lf-toggle    boolean
 *   difficulty      lf-dropdown  gentle | standard | unraveling (flavor hint
 *                                below the control, aria-live polite)
 *
 * PUBLIC ATTRIBUTES
 *   (none — state is store-owned, not attribute-owned)
 *
 * PUBLIC PROPERTIES
 * @prop {OptionsStore} store - The store instance the panel edits. Defaults
 *   to the shared getStore() singleton; assignable before insertion for
 *   isolated shells/tests.
 *
 * PUBLIC EVENTS
 * @fires lf-change - Bubbles UNTOUCHED from the composed kit widgets
 *   (detail: { value }) so <lf-settings-shell>'s generic persistence hook
 *   still sees every commit.
 *   The panel itself emits nothing new: committed values surface as the
 *   window-level "lf-options-change" CustomEvent
 *   (detail: { key, value, options }) dispatched by the OptionsStore.
 *
 * KEYBOARD — entirely inherited from the kit widgets: sliders are native
 * <input type=range> (arrows/Home/End/PageUp/PageDown), dropdowns are the
 * listbox pattern (Esc closes without popping the shell), the toggle is a
 * native role="switch" button.
 */
import { LFElement, define, uid } from '../../ui-kit/lf-core.js';
import '../../ui-kit/components/slider.js';
import '../../ui-kit/components/toggle.js';
import '../../ui-kit/components/dropdown.js';
import { getStore } from './options-store.js';

/** Per-mode substitution notes (mirrors cvd.css; shown under the dropdown). */
const CVD_NOTES = {
  none: 'Full palette. Every status cue already pairs color with a shape glyph.',
  deuteranopia: 'Success re-threads to hemstone cyan, errors to cinder orange, info to lavender lift, uncommon rarity to dye indigo.',
  protanopia: 'As deuteranopia, and health pips brighten to cinder orange — deep reds go dim for protan eyes.',
  tritanopia: 'Info re-threads to pale thread, warnings to weld gold, cyan accents (rare rarity, armor) to lavender lift.',
};

/** Difficulty flavor lines (Loomfall IP). */
const DIFFICULTY_FLAVOR = {
  gentle: 'Gentle — mobs hesitate before striking and hunger frays slowly. Unhurried weaving.',
  standard: 'Standard — the weave holds an even tension. The intended Loomfall experience.',
  unraveling: 'Unraveling — the dark pulls at every loose thread. Food is scarce, the unpicked are fierce.',
};

export class LFAccessOptions extends LFElement {
  constructor() {
    super();
    /** @type {import('./options-store.js').OptionsStore|null} */
    this._store = null;
    this._onWindowChange = (e) => {
      if (e.detail && e.detail.options) this._sync(e.detail.options);
    };
  }

  /** @type {import('./options-store.js').OptionsStore} */
  get store() {
    if (!this._store) this._store = getStore();
    return this._store;
  }

  set store(s) {
    this._store = s;
    if (this._lfRendered) this._sync(s.options);
  }

  render() {
    /** @type {Map<string, HTMLElement>} dot-path -> control element */
    this._controls = new Map();

    // ---- Vision -------------------------------------------------------
    const vision = this._group('Vision');
    vision.append(
      this._dropdown({
        opt: 'colorblindMode',
        label: 'Colorblind Mode',
        options: [
          ['none', 'None'],
          ['deuteranopia', 'Deuteranopia (green-weak)'],
          ['protanopia', 'Protanopia (red-weak)'],
          ['tritanopia', 'Tritanopia (blue-yellow)'],
        ],
      }),
      (this._cvdHint = this._hint(CVD_NOTES.none, { live: true })),
      this._slider({ opt: 'uiScale', label: 'UI Scale', min: 0.75, max: 1.5, step: 0.05, unit: '×' }),
      this._hint('Scales HUD and menus. Drag for a live preview; release to keep it.'),
      this._slider({ opt: 'fov', label: 'Field of View', min: 60, max: 110, step: 1, unit: '°' })
    );

    // ---- Motion -------------------------------------------------------
    const motion = this._group('Motion');
    motion.append(
      this._dropdown({
        opt: 'reducedMotion',
        label: 'Reduced Motion',
        options: [
          ['system', 'Match system'],
          ['on', 'Reduced (still)'],
          ['off', 'Full motion'],
        ],
      }),
      this._hint('Reduced stills screen shake, particle bursts and UI animation. "Match system" follows your OS setting.')
    );

    // ---- Audio --------------------------------------------------------
    const audio = this._group('Audio');
    audio.append(
      this._slider({ opt: 'volumes.master', label: 'Master Volume', min: 0, max: 100, step: 5, unit: '%', scale: 100 }),
      this._slider({ opt: 'volumes.sfx', label: 'SFX Volume', min: 0, max: 100, step: 5, unit: '%', scale: 100 }),
      this._slider({ opt: 'volumes.music', label: 'Music Volume', min: 0, max: 100, step: 5, unit: '%', scale: 100 }),
      this._toggle({ opt: 'subtitles', label: 'Subtitles' }),
      this._hint('Subtitles caption every sound — footfalls, mob calls, weather — with direction chevrons.')
    );

    // ---- Gameplay -----------------------------------------------------
    const gameplay = this._group('Gameplay');
    gameplay.append(
      this._dropdown({
        opt: 'difficulty',
        label: 'Difficulty',
        options: [
          ['gentle', 'Gentle'],
          ['standard', 'Standard'],
          ['unraveling', 'Unraveling'],
        ],
      }),
      (this._difficultyHint = this._hint(DIFFICULTY_FLAVOR.standard, { live: true }))
    );

    // Commits: every kit widget bubbles lf-change {value}.
    this.addEventListener('lf-change', (e) => this._onChange(e));
    // Live preview while dragging (uiScale only has visual side effects).
    this.addEventListener('lf-input', (e) => this._onInput(e));
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('lf-options-change', this._onWindowChange);
    this._sync(this.store.options);
  }

  disconnectedCallback() {
    window.removeEventListener('lf-options-change', this._onWindowChange);
  }

  update() {
    if (this._store) this._sync(this._store.options);
  }

  /* ---------------- event plumbing ---------------- */

  /** @param {CustomEvent} e bubbling lf-change from a composed widget */
  _onChange(e) {
    const host = e.target instanceof HTMLElement ? e.target.closest('[data-opt]') : null;
    if (!host || !this.contains(host)) return;
    const scale = Number(host.dataset.scale || 1);
    let value = e.detail ? e.detail.value : undefined;
    if (typeof value === 'number' && scale !== 1) value = value / scale;
    this.store.set(host.dataset.opt, value);
    // NOT stopped: lf-settings-shell's generic lf-change hook still fires.
  }

  /** @param {CustomEvent} e bubbling lf-input (live) from a slider */
  _onInput(e) {
    const host = e.target instanceof HTMLElement ? e.target.closest('[data-opt]') : null;
    if (!host || !this.contains(host)) return;
    if (host.dataset.opt === 'uiScale') this.store.preview('uiScale', e.detail.value);
  }

  /** Push store state into the controls + hints. @param {object} o */
  _sync(o) {
    if (!this._controls) return;
    for (const [opt, el] of this._controls) {
      const value = opt.startsWith('volumes.') ? o.volumes[opt.slice(8)] : o[opt];
      const scale = Number(el.dataset.scale || 1);
      if (el.tagName === 'LF-TOGGLE') {
        el.checked = !!value;
      } else if (el.tagName === 'LF-SLIDER') {
        el.setAttribute('value', String(Math.round(value * scale * 100) / 100));
      } else {
        el.setAttribute('value', String(value));
      }
    }
    this._setHint(this._cvdHint, CVD_NOTES[o.colorblindMode] || CVD_NOTES.none);
    this._setHint(this._difficultyHint, DIFFICULTY_FLAVOR[o.difficulty] || DIFFICULTY_FLAVOR.standard);
  }

  /* ---------------- element factories ---------------- */

  /**
   * Group container with an id-linked heading.
   * @param {string} title @returns {HTMLElement} body to append controls to
   */
  _group(title) {
    const section = document.createElement('div');
    section.className = 'lf-access-options__group';
    section.setAttribute('role', 'group');
    const h = document.createElement('h3');
    h.className = 'lf-access-options__title';
    h.id = uid('lf-access-group');
    h.textContent = title;
    section.setAttribute('aria-labelledby', h.id);
    section.appendChild(h);
    this.appendChild(section);
    return section;
  }

  /**
   * @param {{opt:string,label:string,min:number,max:number,step:number,unit?:string,scale?:number}} cfg
   * @returns {HTMLElement}
   */
  _slider({ opt, label, min, max, step, unit = '', scale = 1 }) {
    const el = document.createElement('lf-slider');
    el.setAttribute('label', label);
    el.setAttribute('min', String(min));
    el.setAttribute('max', String(max));
    el.setAttribute('step', String(step));
    if (unit) el.setAttribute('unit', unit);
    el.dataset.opt = opt;
    if (scale !== 1) el.dataset.scale = String(scale);
    this._controls.set(opt, el);
    return el;
  }

  /** @param {{opt:string,label:string}} cfg @returns {HTMLElement} */
  _toggle({ opt, label }) {
    const el = document.createElement('lf-toggle');
    el.setAttribute('label', label);
    el.dataset.opt = opt;
    this._controls.set(opt, el);
    return el;
  }

  /**
   * @param {{opt:string,label:string,options:[string,string][]}} cfg
   * @returns {HTMLElement}
   */
  _dropdown({ opt, label, options }) {
    const el = document.createElement('lf-dropdown');
    el.setAttribute('label', label);
    for (const [value, text] of options) {
      const o = document.createElement('option');
      o.setAttribute('value', value);
      o.textContent = text;
      el.appendChild(o);
    }
    el.dataset.opt = opt;
    this._controls.set(opt, el);
    return el;
  }

  /**
   * Dim helper line under a control.
   * @param {string} text @param {{live?: boolean}} [opts] live=announce changes
   * @returns {HTMLParagraphElement}
   */
  _hint(text, { live = false } = {}) {
    const p = document.createElement('p');
    p.className = 'lf-access-options__hint';
    p.textContent = text;
    if (live) p.setAttribute('aria-live', 'polite');
    return p;
  }

  /** @param {HTMLElement} hint @param {string} text */
  _setHint(hint, text) {
    if (hint && hint.textContent !== text) hint.textContent = text;
  }
}

define('lf-access-options', LFAccessOptions);
