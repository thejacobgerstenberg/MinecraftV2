/**
 * Loomfall UX — <lf-keybinds>
 *
 * Key-binding editor panel. Docks into <lf-settings-shell> (author it inside
 * a <section data-category="Controls">) or stands alone. Renders the 27
 * rebindable actions from bindings.default.json grouped by category, with
 * per-row Primary / Alternate / Gamepad bind buttons, capture mode, conflict
 * detection with swap/overwrite resolution, per-row and whole-panel reset,
 * and localStorage persistence in the exact bindings.schema.json shape.
 *
 * Follows the ui-kit conventions (lf-core.js): light DOM, state as reflected
 * attributes, colors via var(--lf-*) tokens only, events via emit().
 *
 * USAGE
 *   <lf-keybinds></lf-keybinds>
 *   <script type="module">
 *     import './keybinds.js';
 *     const el = document.querySelector('lf-keybinds');
 *     el.defaults = await (await fetch('./bindings.default.json')).json();
 *   </script>
 *
 * PUBLIC ATTRIBUTES
 * @attr {string} storage-key - localStorage key for persistence. Defaults to
 *   "loomfall.bindings". The stored value is `{ version: 1, bindings: {...} }`
 *   — the same JSON shape as bindings.default.json (validated on load;
 *   invalid/foreign payloads are ignored and defaults win).
 *
 * PUBLIC PROPERTIES
 * @prop {object} defaults - REQUIRED bootstrap. Assign the parsed
 *   bindings.default.json document (or a bare binding map). Setting it loads
 *   any persisted user map and builds the rows.
 * @prop {object} bindings - Deep copy of the current action->binding map
 *   (read-only snapshot; use importBindings() to replace).
 *
 * PUBLIC METHODS
 *   exportBindings() -> { version: 1, bindings } deep copy, schema-shaped.
 *   importBindings(doc) -> { ok: boolean, errors: string[] }. Structurally
 *     validates against the schema rules (27 actions, slot keys, keyCode
 *     pattern, gamepad 0-16 range) before applying; applies as a full
 *     replacement, persists, and emits lf-bindings-change per changed slot.
 *   resetAll({confirm=true}) - restore factory defaults (confirm modal by
 *     default).
 *
 * PUBLIC EVENTS
 * @fires lf-bindings-change - On every committed change (capture, clear,
 *   swap, overwrite, reset, import), once per changed slot. Bubbles +
 *   composed, so window-level listeners receive it (architecture contract
 *   §4). detail: {
 *     action:  string   — action id, e.g. "moveForward",
 *     slot:    "primary"|"secondary"|"gamepad",
 *     code:    string|number|null — new code for that slot,
 *     bindings: object  — full deep-copied action->binding map
 *   }
 *
 * CAPTURE MODE (keyboard slots)
 *   Click (or focus + Enter/Space) a bind button to start listening. The
 *   next keydown captures KeyboardEvent.code; mousedown captures
 *   Mouse0-Mouse4; wheel captures WheelUp/WheelDown (all schema-legal in
 *   keyboard slots). Escape cancels. Backspace/Delete clears the slot.
 *   Escape and Backspace are therefore reserved and cannot be captured
 *   (import can still bind them). Capture key events are swallowed
 *   (stopPropagation) so the settings shell never sees the Escape.
 *
 * GAMEPAD CAPTURE — STUB
 *   The gamepad column captures via a polling stub: while capturing it
 *   listens for `gamepadconnected` and polls navigator.getGamepads() every
 *   animation frame; the first pressed button index (0-16, Standard Gamepad
 *   mapping) is captured. Escape cancels, Backspace clears. There is no
 *   analog-stick or axis capture (sticks are hard-wired axes per schema) and
 *   no gamepad UI navigation — the real input layer replaces this stub.
 *
 * CONFLICTS
 *   Keyboard pool = primary+secondary across all actions; gamepad pool is
 *   separate. Documented context-share sets are exempt: {place, interact,
 *   eat} and {sneak, sprint}. Assigning a code owned by another action
 *   highlights both rows with a dashed hem + fray-knot glyph (shape cue,
 *   never hue alone), raises a warning toast, and opens a resolution modal
 *   offering Swap (the other action takes this slot's previous code) or
 *   Unbind & assign (overwrite). Rebinding pause away from Escape warns
 *   (does not block): pointer-lock loss still pauses via Escape.
 */
import { LFElement, define, uid } from '../../ui-kit/lf-core.js';
import '../../ui-kit/components/button.js';
import '../../ui-kit/components/modal.js';
import '../../ui-kit/components/toast.js';

const DEFAULT_STORAGE_KEY = 'loomfall.bindings';
const SLOTS = ['primary', 'secondary', 'gamepad'];

/** Mirrors ux/schemas/bindings.schema.json $defs.keyCode pattern. */
export const KEYCODE_RE =
  /^(Key[A-Z]|Digit[0-9]|Numpad[A-Za-z0-9]+|F([1-9]|1[0-9]|2[0-4])|Arrow(Up|Down|Left|Right)|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Meta(Left|Right)|Space|Enter|Escape|Tab|Backspace|Delete|Insert|Home|End|Page(Up|Down)|CapsLock|Backquote|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash|IntlRo|IntlYen|ContextMenu|Mouse[0-4]|Wheel(Up|Down))$/;

/** The 27 action ids, grouped for display (schema-required set). */
export const GROUPS = [
  {
    name: 'Movement',
    actions: [
      'moveForward', 'moveBack', 'moveLeft', 'moveRight',
      'jump', 'sneak', 'sprint', 'toggleFlight',
    ],
  },
  { name: 'Interaction', actions: ['break', 'place', 'interact', 'eat'] },
  {
    name: 'Hotbar',
    actions: [
      'hotbar1', 'hotbar2', 'hotbar3', 'hotbar4', 'hotbar5',
      'hotbar6', 'hotbar7', 'hotbar8', 'hotbar9',
      'hotbarPrev', 'hotbarNext',
    ],
  },
  { name: 'Interface', actions: ['inventory', 'chat', 'pause', 'debug'] },
];

export const ACTIONS = GROUPS.flatMap((g) => g.actions);

const ACTION_LABELS = {
  moveForward: 'Walk Forward',
  moveBack: 'Walk Back',
  moveLeft: 'Strafe Left',
  moveRight: 'Strafe Right',
  jump: 'Jump / Swim Up',
  sneak: 'Sneak',
  sprint: 'Sprint',
  toggleFlight: 'Toggle Flight',
  break: 'Break / Attack',
  place: 'Place Block',
  interact: 'Interact / Use',
  eat: 'Eat / Drink',
  hotbar1: 'Hotbar Slot 1',
  hotbar2: 'Hotbar Slot 2',
  hotbar3: 'Hotbar Slot 3',
  hotbar4: 'Hotbar Slot 4',
  hotbar5: 'Hotbar Slot 5',
  hotbar6: 'Hotbar Slot 6',
  hotbar7: 'Hotbar Slot 7',
  hotbar8: 'Hotbar Slot 8',
  hotbar9: 'Hotbar Slot 9',
  hotbarPrev: 'Hotbar Previous',
  hotbarNext: 'Hotbar Next',
  inventory: 'Inventory',
  chat: 'Chat',
  pause: 'Pause / Back',
  debug: 'Debug Overlay',
};

/** Small dim notes for documented quirks (from the schema descriptions). */
const ACTION_NOTES = {
  jump: 'Double-tap toggles flight (300 ms) while Toggle Flight is unbound.',
  sneak: 'Doubles as flight-descend while flying (canon: Left Shift).',
  place: 'Shares Right Click with Interact and Eat — context decides.',
  pause: 'Escape always pauses via pointer-lock loss, even if rebound.',
  toggleFlight: 'Unbound by default — the double-tap-Jump gesture covers it.',
};

/** Documented context-share sets: duplicates within a set are NOT conflicts. */
const SHARE_SETS = [
  ['place', 'interact', 'eat'],
  ['sneak', 'sprint'],
];

const SLOT_LABELS = {
  primary: 'Primary key',
  secondary: 'Alternate key',
  gamepad: 'Gamepad button',
};

/** Standard Gamepad mapping button names (indices 0-16). */
const PAD_LABELS = [
  'A / Cross', 'B / Circle', 'X / Square', 'Y / Triangle',
  'LB / L1', 'RB / R1', 'LT / L2', 'RT / R2',
  'Back / Select', 'Start', 'L3 (stick)', 'R3 (stick)',
  'D-pad Up', 'D-pad Down', 'D-pad Left', 'D-pad Right', 'Guide',
];

const KEY_LABEL_MAP = {
  Mouse0: 'Left Click', Mouse1: 'Middle Click', Mouse2: 'Right Click',
  Mouse3: 'Mouse 4', Mouse4: 'Mouse 5',
  WheelUp: 'Wheel Up', WheelDown: 'Wheel Down',
  Space: 'Space', Escape: 'Escape', Enter: 'Enter', Tab: 'Tab',
  Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down',
  CapsLock: 'Caps Lock', ContextMenu: 'Menu Key',
  Backquote: '` (Backquote)', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  IntlBackslash: 'Intl \\', IntlRo: 'Ro', IntlYen: 'Yen',
};

/** Fray-knot triangle (warn shape cue) — same glyph family as lf-toast. */
const FRAY_KNOT_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M8 2.2 L14.6 13.4 H1.4 Z"/>' +
  '<path d="M8 2.2 L6.9 0.9 M8 2.2 L9.2 1" stroke-width="1"/>' +
  '<path d="M8 6.2 v3.2" stroke-width="1.8"/>' +
  '<path d="M8 11.6 v0.01" stroke-width="2.2"/>' +
  '</svg>';

/** Unpick-loop arrow (reset shape cue). */
const RESET_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M13.5 8 a5.5 5.5 0 1 1 -1.8 -4.05"/>' +
  '<path d="M13.7 1.6 L13.5 4.6 L10.5 4.4"/>' +
  '</svg>';

/**
 * Human label for a keyboard-slot code.
 * @param {string|null} code @returns {string|null} null when unbound
 */
export function prettyKey(code) {
  if (code == null) return null;
  if (KEY_LABEL_MAP[code]) return KEY_LABEL_MAP[code];
  let m;
  if ((m = code.match(/^Key([A-Z])$/))) return m[1];
  if ((m = code.match(/^Digit([0-9])$/))) return m[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if ((m = code.match(/^Arrow(Up|Down|Left|Right)$/))) return `${m[1]} Arrow`;
  if ((m = code.match(/^(Shift|Control|Alt|Meta)(Left|Right)$/))) {
    const base = m[1] === 'Control' ? 'Ctrl' : m[1];
    return `${m[2]} ${base}`;
  }
  if ((m = code.match(/^Numpad(.+)$/))) return `Numpad ${m[1]}`;
  return code;
}

/**
 * Human label for a gamepad button index.
 * @param {number|null} idx @returns {string|null}
 */
export function prettyPad(idx) {
  if (idx == null) return null;
  return PAD_LABELS[idx] || `Button ${idx}`;
}

/** @param {*} v @returns {object} structured deep copy */
function deepCopy(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * Structural validation mirroring ux/schemas/bindings.schema.json.
 * Accepts a full document ({version, bindings}) — the persisted/import shape.
 * @param {*} doc
 * @returns {string[]} empty when valid
 */
export function validateBindingsDoc(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return ['document must be a JSON object'];
  }
  if (doc.version !== 1) errors.push('version must be the integer 1');
  const map = doc.bindings;
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    errors.push('bindings must be an object');
    return errors;
  }
  for (const action of ACTIONS) {
    const b = map[action];
    if (!b || typeof b !== 'object') {
      errors.push(`missing action "${action}"`);
      continue;
    }
    for (const slot of ['primary', 'secondary']) {
      const c = b[slot];
      if (!(c === null || (typeof c === 'string' && KEYCODE_RE.test(c)))) {
        errors.push(`${action}.${slot}: invalid code ${JSON.stringify(c)}`);
      }
    }
    const g = b.gamepad;
    if (!(g === null || (Number.isInteger(g) && g >= 0 && g <= 16))) {
      errors.push(`${action}.gamepad: must be 0-16 or null`);
    }
    for (const k of Object.keys(b)) {
      if (!SLOTS.includes(k)) errors.push(`${action}: unknown slot "${k}"`);
    }
  }
  for (const k of Object.keys(map)) {
    if (!ACTIONS.includes(k)) errors.push(`unknown action "${k}"`);
  }
  return errors;
}

export class LFKeybinds extends LFElement {
  static observedAttributes = ['storage-key'];

  constructor() {
    super();
    /** @type {object|null} action -> {primary, secondary, gamepad} */
    this._defaults = null;
    /** @type {object|null} working map, same shape */
    this._bindings = null;
    /** @type {Map<string, {row: HTMLElement, binds: object, reset: HTMLElement}>} */
    this._rows = new Map();
    /** @type {null|{action: string, slot: string, btn: HTMLButtonElement, mode: 'key'|'pad'}} */
    this._capture = null;
    this._padPoll = 0;
    this._onCaptureKeydown = this._onCaptureKeydown.bind(this);
    this._onCaptureMousedown = this._onCaptureMousedown.bind(this);
    this._onCaptureWheel = this._onCaptureWheel.bind(this);
    this._onCaptureContext = this._onCaptureContext.bind(this);
    this._onCaptureClickSwallow = this._onCaptureClickSwallow.bind(this);
    this._pollGamepads = this._pollGamepads.bind(this);
  }

  /** @returns {string} localStorage key */
  get storageKey() {
    return this.getAttribute('storage-key') || DEFAULT_STORAGE_KEY;
  }

  /**
   * Bootstrap: assign the parsed bindings.default.json document (or a bare
   * binding map). Loads persisted user bindings and (re)builds rows.
   * @param {object} doc
   */
  set defaults(doc) {
    const map = doc && doc.bindings ? doc.bindings : doc;
    const errors = validateBindingsDoc({ version: 1, bindings: map });
    if (errors.length) {
      throw new Error(`lf-keybinds: invalid defaults — ${errors[0]}`);
    }
    this._defaults = deepCopy(map);
    this._bindings = this._loadPersisted() || deepCopy(this._defaults);
    if (this._lfRendered) this._buildRows();
  }

  /** @returns {object|null} deep copy of the defaults map */
  get defaults() {
    return this._defaults ? deepCopy(this._defaults) : null;
  }

  /** @returns {object|null} deep copy of the current action->binding map */
  get bindings() {
    return this._bindings ? deepCopy(this._bindings) : null;
  }

  /** @returns {{version: 1, bindings: object}} schema-shaped snapshot */
  exportBindings() {
    return { version: 1, bindings: deepCopy(this._bindings || {}) };
  }

  /**
   * Validate and apply a full bindings document.
   * @param {*} doc - parsed JSON, { version: 1, bindings: {...} }
   * @returns {{ok: boolean, errors: string[]}}
   */
  importBindings(doc) {
    const errors = validateBindingsDoc(doc);
    if (errors.length) {
      this._toast('error', 'Import failed', errors[0]);
      return { ok: false, errors };
    }
    const changes = [];
    for (const action of ACTIONS) {
      for (const slot of SLOTS) {
        if (this._bindings[action][slot] !== doc.bindings[action][slot]) {
          changes.push({ action, slot, code: doc.bindings[action][slot] });
        }
      }
    }
    if (changes.length === 0) {
      this._toast('info', 'Import', 'No changes — bindings already match.');
      return { ok: true, errors: [] };
    }
    this._commit(changes);
    this._toast('success', 'Bindings imported', `${changes.length} slot(s) updated.`);
    return { ok: true, errors: [] };
  }

  /**
   * Restore every action to factory defaults.
   * @param {{confirm?: boolean}} [opts] - confirm=false skips the modal.
   */
  resetAll(opts = {}) {
    if (opts.confirm === false) {
      this._applyResetAll();
      return;
    }
    this._openModal({
      heading: 'Reset all bindings?',
      body: 'Every action returns to its factory default. Your current layout will be lost.',
      confirmLabel: 'Reset All',
      cancelLabel: 'Cancel',
      danger: true,
      onAction: (action, modal) => {
        if (action === 'confirm') this._applyResetAll();
        if (action !== 'cancel') this._removeModal(modal);
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  render() {
    this.setAttribute('role', 'group');
    const headingId = uid('lf-keybinds-heading');
    this.setAttribute('aria-labelledby', headingId);

    const heading = document.createElement('h3');
    heading.className = 'lf-keybinds__heading';
    heading.id = headingId;
    heading.textContent = 'Key Bindings';

    const help = document.createElement('p');
    help.className = 'lf-keybinds__help';
    help.textContent =
      'Select a binding, then press the new key or button. Escape cancels, Backspace clears.';

    const scroller = document.createElement('div');
    scroller.className = 'lf-keybinds__scroller';
    const groups = document.createElement('div');
    groups.className = 'lf-keybinds__groups';
    this._groupsEl = groups;
    scroller.appendChild(groups);

    const empty = document.createElement('p');
    empty.className = 'lf-keybinds__empty';
    empty.textContent = 'Loading default bindings…';
    this._emptyEl = empty;
    groups.appendChild(empty);

    const footer = document.createElement('div');
    footer.className = 'lf-keybinds__footer';
    const resetAll = document.createElement('lf-button');
    resetAll.setAttribute('variant', 'danger');
    resetAll.setAttribute('action', 'reset-all');
    resetAll.textContent = 'Reset All to Defaults';
    resetAll.addEventListener('lf-action', (e) => {
      e.stopPropagation();
      this.resetAll();
    });
    footer.appendChild(resetAll);

    const live = document.createElement('div');
    live.className = 'lf-visually-hidden';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    this._live = live;

    this.append(heading, help, scroller, footer, live);
    if (this._bindings) this._buildRows();
  }

  update() {
    if (this._rows.size) this._syncAll();
  }

  _buildRows() {
    this._groupsEl.textContent = '';
    this._rows.clear();

    for (const group of GROUPS) {
      const section = document.createElement('section');
      section.className = 'lf-keybinds__group';
      const h = document.createElement('h4');
      h.className = 'lf-keybinds__group-name';
      h.textContent = group.name;
      section.appendChild(h);

      // Visible column headers; buttons self-describe via aria-label.
      const head = document.createElement('div');
      head.className = 'lf-keybinds__row lf-keybinds__row--head';
      head.setAttribute('aria-hidden', 'true');
      for (const text of ['Action', 'Primary', 'Alternate', 'Gamepad', '']) {
        const c = document.createElement('span');
        c.textContent = text;
        head.appendChild(c);
      }
      section.appendChild(head);

      for (const action of group.actions) {
        section.appendChild(this._buildRow(action));
      }
      this._groupsEl.appendChild(section);
    }
    this._syncAll();
  }

  /** @param {string} action @returns {HTMLElement} */
  _buildRow(action) {
    const row = document.createElement('div');
    row.className = 'lf-keybinds__row';
    row.dataset.action = action;

    const name = document.createElement('div');
    name.className = 'lf-keybinds__name';
    const nameLine = document.createElement('span');
    nameLine.className = 'lf-keybinds__name-line';
    const glyph = document.createElement('span');
    glyph.className = 'lf-keybinds__conflict-glyph';
    glyph.innerHTML = FRAY_KNOT_SVG;
    const label = document.createElement('span');
    label.textContent = ACTION_LABELS[action] || action;
    nameLine.append(glyph, label);
    name.appendChild(nameLine);
    if (ACTION_NOTES[action]) {
      const note = document.createElement('span');
      note.className = 'lf-keybinds__note';
      note.textContent = ACTION_NOTES[action];
      name.appendChild(note);
    }
    row.appendChild(name);

    const binds = {};
    for (const slot of SLOTS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lf-keybinds__bind';
      btn.dataset.slot = slot;
      const span = document.createElement('span');
      span.className = 'lf-keybinds__bind-label';
      btn.appendChild(span);
      btn.addEventListener('click', () => {
        // A mouse-capture commit swallows its own click; reaching here
        // means this is a genuine activation.
        if (this._capture && this._capture.btn === btn) return;
        this._startCapture(action, slot, btn);
      });
      binds[slot] = btn;
      row.appendChild(btn);
    }

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'lf-keybinds__reset';
    reset.innerHTML = RESET_SVG;
    reset.setAttribute(
      'aria-label',
      `Reset ${ACTION_LABELS[action] || action} to default`
    );
    reset.title = 'Reset to default';
    reset.addEventListener('click', () => this._resetRow(action));
    row.appendChild(reset);

    this._rows.set(action, { row, binds, reset });
    return row;
  }

  _syncAll() {
    if (!this._bindings) return;
    if (this._emptyEl) {
      this._emptyEl.remove();
      this._emptyEl = null;
    }
    for (const action of this._rows.keys()) this._syncRow(action);
  }

  /** @param {string} action */
  _syncRow(action) {
    const refs = this._rows.get(action);
    if (!refs || !this._bindings) return;
    const b = this._bindings[action];
    const label = ACTION_LABELS[action] || action;
    for (const slot of SLOTS) {
      const btn = refs.binds[slot];
      if (this._capture && this._capture.btn === btn) continue;
      const pretty = slot === 'gamepad' ? prettyPad(b[slot]) : prettyKey(b[slot]);
      btn.querySelector('.lf-keybinds__bind-label').textContent =
        pretty == null ? 'Not bound' : pretty;
      this._reflect(btn, 'unbound', pretty == null);
      btn.setAttribute(
        'aria-label',
        `${SLOT_LABELS[slot]} for ${label}: ${pretty == null ? 'not bound' : pretty}. ` +
          'Press Enter to rebind, then Escape cancels and Backspace clears.'
      );
    }
    const d = this._defaults[action];
    const atDefault = SLOTS.every((s) => b[s] === d[s]);
    refs.reset.disabled = atDefault;
  }

  /** Presence-toggle a state attribute on any element. */
  _reflect(el, name, on) {
    if (on) el.setAttribute(name, '');
    else el.removeAttribute(name);
  }

  /* ------------------------------------------------------------------ */
  /* Capture                                                             */
  /* ------------------------------------------------------------------ */

  _startCapture(action, slot, btn) {
    if (this._capture) this._cancelCapture();
    const mode = slot === 'gamepad' ? 'pad' : 'key';
    this._capture = { action, slot, btn, mode };
    btn.setAttribute('capturing', '');
    btn.querySelector('.lf-keybinds__bind-label').textContent =
      mode === 'pad' ? 'Press a pad button…' : 'Press a key…';
    const label = ACTION_LABELS[action] || action;
    this._announce(
      `Listening for a new ${SLOT_LABELS[slot].toLowerCase()} for ${label}. ` +
        'Escape cancels, Backspace clears.'
    );
    window.addEventListener('keydown', this._onCaptureKeydown, true);
    if (mode === 'key') {
      window.addEventListener('mousedown', this._onCaptureMousedown, true);
      window.addEventListener('wheel', this._onCaptureWheel, {
        capture: true,
        passive: false,
      });
      window.addEventListener('contextmenu', this._onCaptureContext, true);
    } else {
      // Gamepad capture STUB: poll the Gamepad API each frame while capturing.
      window.addEventListener('gamepadconnected', this._pollGamepads);
      this._padPoll = requestAnimationFrame(this._pollGamepads);
      const pads = (navigator.getGamepads ? navigator.getGamepads() : []) || [];
      if (![...pads].some(Boolean)) {
        this._toast(
          'info',
          'No controller detected',
          'Connect a controller and press a button, or press Escape to cancel.'
        );
      }
    }
  }

  /** Tear down capture listeners; restore the button face. */
  _stopCapture() {
    const cap = this._capture;
    if (!cap) return;
    this._capture = null;
    window.removeEventListener('keydown', this._onCaptureKeydown, true);
    window.removeEventListener('mousedown', this._onCaptureMousedown, true);
    window.removeEventListener('wheel', this._onCaptureWheel, { capture: true });
    window.removeEventListener('contextmenu', this._onCaptureContext, true);
    window.removeEventListener('gamepadconnected', this._pollGamepads);
    if (this._padPoll) cancelAnimationFrame(this._padPoll);
    this._padPoll = 0;
    cap.btn.removeAttribute('capturing');
    this._syncRow(cap.action);
  }

  _cancelCapture() {
    this._stopCapture();
    this._announce('Binding cancelled.');
  }

  /** @param {KeyboardEvent} e */
  _onCaptureKeydown(e) {
    const cap = this._capture;
    if (!cap) return;
    e.preventDefault();
    e.stopPropagation(); // the settings shell must not see this Escape
    if (e.key === 'Escape') {
      this._cancelCapture();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      this._stopCapture();
      this._commit([{ action: cap.action, slot: cap.slot, code: null }]);
      this._announce(`${ACTION_LABELS[cap.action]} ${cap.slot} cleared.`);
      return;
    }
    if (cap.mode !== 'key') return; // pad capture ignores other keys
    if (!KEYCODE_RE.test(e.code)) {
      this._stopCapture();
      this._toast('warn', 'Key not bindable', `"${e.key}" cannot be bound.`);
      return;
    }
    this._stopCapture();
    this._assign(cap.action, cap.slot, e.code);
  }

  /** @param {MouseEvent} e */
  _onCaptureMousedown(e) {
    const cap = this._capture;
    if (!cap || cap.mode !== 'key') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.button >= 0 && e.button <= 4) {
      // Swallow the click this mousedown would produce; the swallow listener
      // is removed right after the press ends (click fires before the
      // timeout queued from mouseup), so it can never eat a later click.
      window.addEventListener('click', this._onCaptureClickSwallow, true);
      window.addEventListener(
        'mouseup',
        () =>
          setTimeout(
            () => window.removeEventListener('click', this._onCaptureClickSwallow, true),
            0
          ),
        { once: true, capture: true }
      );
      this._stopCapture();
      this._assign(cap.action, cap.slot, `Mouse${e.button}`);
    }
  }

  /** One-shot: eat the click generated by a mouse-capture commit. */
  _onCaptureClickSwallow(e) {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('click', this._onCaptureClickSwallow, true);
  }

  /** @param {WheelEvent} e */
  _onCaptureWheel(e) {
    const cap = this._capture;
    if (!cap || cap.mode !== 'key') return;
    e.preventDefault();
    e.stopPropagation();
    this._stopCapture();
    this._assign(cap.action, cap.slot, e.deltaY < 0 ? 'WheelUp' : 'WheelDown');
  }

  /** @param {Event} e */
  _onCaptureContext(e) {
    if (this._capture) e.preventDefault();
  }

  /** Gamepad polling stub (also serves as the gamepadconnected handler). */
  _pollGamepads() {
    const cap = this._capture;
    if (!cap || cap.mode !== 'pad') return;
    const pads = (navigator.getGamepads ? navigator.getGamepads() : []) || [];
    for (const pad of pads) {
      if (!pad) continue;
      for (let i = 0; i < Math.min(pad.buttons.length, 17); i += 1) {
        if (pad.buttons[i] && pad.buttons[i].pressed) {
          this._stopCapture();
          this._assign(cap.action, cap.slot, i);
          return;
        }
      }
    }
    this._padPoll = requestAnimationFrame(this._pollGamepads);
  }

  /* ------------------------------------------------------------------ */
  /* Assignment, conflicts, commit                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Assign a captured code, running conflict detection first.
   * @param {string} action @param {string} slot @param {string|number} code
   */
  _assign(action, slot, code) {
    if (this._bindings[action][slot] === code) {
      this._announce('Binding unchanged.');
      return;
    }
    const changes = [{ action, slot, code }];
    // Moving a code between this action's own keyboard slots is not a
    // conflict — clear the other slot instead.
    if (slot !== 'gamepad') {
      const other = slot === 'primary' ? 'secondary' : 'primary';
      if (this._bindings[action][other] === code) {
        changes.push({ action, slot: other, code: null });
      }
    }
    const conflicts = this._findConflicts(action, slot, code);
    if (conflicts.length === 0) {
      this._commit(changes);
      const pretty = slot === 'gamepad' ? prettyPad(code) : prettyKey(code);
      this._announce(`${ACTION_LABELS[action]} ${slot} set to ${pretty}.`);
      return;
    }
    this._resolveConflict(action, slot, code, changes, conflicts);
  }

  /**
   * Find other actions holding `code` in the same device pool.
   * Keyboard pool = primary+secondary across actions; gamepad separate.
   * Context-share sets are exempt.
   * @returns {{action: string, slot: string}[]}
   */
  _findConflicts(action, slot, code) {
    const pool = slot === 'gamepad' ? ['gamepad'] : ['primary', 'secondary'];
    const out = [];
    for (const other of ACTIONS) {
      if (other === action) continue;
      if (this._sharesContext(action, other)) continue;
      for (const s of pool) {
        if (this._bindings[other][s] === code) out.push({ action: other, slot: s });
      }
    }
    return out;
  }

  /** @returns {boolean} true when a and b are in one documented share set */
  _sharesContext(a, b) {
    return SHARE_SETS.some((set) => set.includes(a) && set.includes(b));
  }

  /**
   * Conflict flow: highlight both rows (dashed hem + fray-knot glyph),
   * warn via toast, and open a modal offering Swap / Unbind & assign.
   */
  _resolveConflict(action, slot, code, changes, conflicts) {
    const pretty = slot === 'gamepad' ? prettyPad(code) : prettyKey(code);
    const prevCode = this._bindings[action][slot];
    const first = conflicts[0];
    const owners = conflicts
      .map((c) => `${ACTION_LABELS[c.action]} (${c.slot})`)
      .join(', ');

    const marked = [action, ...conflicts.map((c) => c.action)];
    for (const a of marked) {
      const refs = this._rows.get(a);
      if (refs) refs.row.setAttribute('conflict', '');
    }
    const unmark = () => {
      for (const a of marked) {
        const refs = this._rows.get(a);
        if (refs) refs.row.removeAttribute('conflict');
      }
    };

    this._toast(
      'warn',
      'Key already in use',
      `${pretty} is bound to ${owners}.`
    );

    const prevPretty =
      prevCode == null
        ? 'nothing'
        : slot === 'gamepad'
          ? prettyPad(prevCode)
          : prettyKey(prevCode);
    this._openModal({
      heading: `${pretty} is already in use`,
      body:
        `${pretty} is currently bound to ${owners}. ` +
        `Swap gives ${ACTION_LABELS[first.action]} your previous binding (${prevPretty}); ` +
        'Unbind & Assign leaves it unbound.',
      confirmLabel: 'Swap',
      cancelLabel: 'Cancel',
      extra: { label: 'Unbind & Assign', action: 'overwrite' },
      onAction: (act, modal) => {
        if (act === 'confirm') {
          // Swap: first conflicting owner takes this slot's previous code;
          // any further owners are unbound.
          const resolved = [...changes, { action: first.action, slot: first.slot, code: prevCode }];
          for (const c of conflicts.slice(1)) {
            resolved.push({ action: c.action, slot: c.slot, code: null });
          }
          this._commit(resolved);
          this._announce(
            `Swapped: ${ACTION_LABELS[action]} is now ${pretty}, ` +
              `${ACTION_LABELS[first.action]} is now ${prevPretty}.`
          );
        } else if (act === 'overwrite') {
          const resolved = [...changes];
          for (const c of conflicts) {
            resolved.push({ action: c.action, slot: c.slot, code: null });
          }
          this._commit(resolved);
          this._announce(
            `${ACTION_LABELS[action]} is now ${pretty}; ${owners} unbound.`
          );
        } else {
          this._announce('Binding cancelled.');
        }
        unmark();
        if (act !== 'cancel') this._removeModal(modal);
      },
      onDismiss: unmark,
    });
  }

  /** Restore one action to defaults, unbinding any usurpers of its codes. */
  _resetRow(action) {
    const def = this._defaults[action];
    const changes = [];
    const freed = [];
    for (const slot of SLOTS) {
      const code = def[slot];
      if (this._bindings[action][slot] !== code) changes.push({ action, slot, code });
      if (code != null) {
        for (const c of this._findConflicts(action, slot, code)) {
          changes.push({ action: c.action, slot: c.slot, code: null });
          freed.push(ACTION_LABELS[c.action]);
        }
      }
    }
    if (changes.length === 0) return;
    this._commit(changes);
    const label = ACTION_LABELS[action] || action;
    if (freed.length) {
      this._toast(
        'info',
        `${label} reset`,
        `Default restored; unbound from ${[...new Set(freed)].join(', ')}.`
      );
    }
    this._announce(`${label} restored to default.`);
  }

  _applyResetAll() {
    const changes = [];
    for (const action of ACTIONS) {
      for (const slot of SLOTS) {
        if (this._bindings[action][slot] !== this._defaults[action][slot]) {
          changes.push({ action, slot, code: this._defaults[action][slot] });
        }
      }
    }
    if (changes.length === 0) {
      this._toast('info', 'Nothing to reset', 'All bindings already match the defaults.');
      return;
    }
    this._commit(changes);
    this._toast('success', 'Bindings reset', 'All actions restored to factory defaults.');
    this._announce('All bindings restored to defaults.');
  }

  /**
   * Apply changes to the working map, persist, sync rows, and emit one
   * lf-bindings-change per changed slot (full map snapshot in each).
   * @param {{action: string, slot: string, code: string|number|null}[]} changes
   */
  _commit(changes) {
    const applied = [];
    for (const ch of changes) {
      if (this._bindings[ch.action][ch.slot] === ch.code) continue;
      this._bindings[ch.action][ch.slot] = ch.code;
      applied.push(ch);
    }
    if (applied.length === 0) return;
    this._persist();
    this._syncAll();
    for (const ch of applied) {
      this.emit('lf-bindings-change', {
        action: ch.action,
        slot: ch.slot,
        code: ch.code,
        bindings: deepCopy(this._bindings),
      });
    }
    // Warn (never block) when pause leaves Escape: pointer-lock loss still
    // fires pause via Escape, so the player may be surprised.
    if (applied.some((ch) => ch.action === 'pause' && ch.slot !== 'gamepad')) {
      const p = this._bindings.pause;
      if (p.primary !== 'Escape' && p.secondary !== 'Escape') {
        this._toast(
          'warn',
          'Pause moved off Escape',
          'Escape still pauses when the mouse pointer is released (pointer-lock loss).'
        );
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  _persist() {
    try {
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({ version: 1, bindings: this._bindings })
      );
    } catch {
      /* storage may be unavailable (private mode) — stay in-memory */
    }
  }

  /** @returns {object|null} persisted map when present and valid */
  _loadPersisted() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return null;
      const doc = JSON.parse(raw);
      if (validateBindingsDoc(doc).length) return null;
      return doc.bindings;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Modal / toast / live-region plumbing                                */
  /* ------------------------------------------------------------------ */

  /**
   * Build and show an lf-modal. `extra` renders an additional lf-button in
   * the body (lf-modal footers are confirm/cancel only).
   * onAction(actionId, modal) fires for 'confirm' | 'cancel' | extra.action.
   */
  _openModal({ heading, body, confirmLabel, cancelLabel, danger, extra, onAction, onDismiss }) {
    const modal = document.createElement('lf-modal');
    modal.setAttribute('heading', heading);
    if (confirmLabel) modal.setAttribute('confirm-label', confirmLabel);
    modal.setAttribute('cancel-label', cancelLabel || 'Cancel');
    if (danger) modal.setAttribute('danger', '');
    const p = document.createElement('p');
    p.textContent = body;
    modal.appendChild(p);
    if (extra) {
      const wrap = document.createElement('p');
      wrap.className = 'lf-keybinds__modal-extra';
      const btn = document.createElement('lf-button');
      btn.setAttribute('action', extra.action);
      btn.textContent = extra.label;
      wrap.appendChild(btn);
      modal.appendChild(wrap);
    }
    let settled = false;
    modal.addEventListener('lf-action', (e) => {
      e.stopPropagation();
      if (settled) return;
      settled = true;
      if (onAction) onAction(e.detail.action, modal);
    });
    modal.addEventListener('lf-close', () => {
      // escape/backdrop dismissal (cancel also lands here after lf-action)
      if (!settled) {
        settled = true;
        if (onDismiss) onDismiss();
      }
      this._removeModal(modal);
    });
    this.appendChild(modal);
    modal.show();
    return modal;
  }

  /** Close (if open) and remove a modal after its focus restore settles. */
  _removeModal(modal) {
    if (modal.open) modal.close();
    setTimeout(() => modal.remove(), 0);
  }

  /** Route notifications through a shared lf-toast-rack (created lazily). */
  _toast(status, heading, message) {
    let rack = document.querySelector('lf-toast-rack');
    if (!rack) {
      rack = document.createElement('lf-toast-rack');
      document.body.appendChild(rack);
    }
    rack.show({ status, heading, message, duration: 6000 });
  }

  /** @param {string} text polite screen-reader announcement */
  _announce(text) {
    if (this._live) this._live.textContent = text;
  }

  disconnectedCallback() {
    if (this._capture) this._stopCapture();
  }
}

define('lf-keybinds', LFKeybinds);
