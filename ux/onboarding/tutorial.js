/**
 * Loomfall UX — <lf-tutorial>
 *
 * Coach-mark overlay for the 22-beat first-ten-minutes onboarding flow
 * (ux/onboarding/tutorial.json, compiled from content/onboarding.md +
 * dialogue.json). Event-driven: the overlay waits silently; when the game
 * shell dispatches window CustomEvent "lf-game-event" whose detail.type
 * matches a beat's gateEvent, that beat's coach mark is shown. Each later
 * gateEvent replaces the mark with the next beat's. Forward jumps are
 * allowed (the player did things out of order); events for beats already
 * shown/passed are ignored — once per save.
 *
 * Anchoring (architecture contract §3): coach marks locate their target
 * ONLY via document.querySelector('[data-lf-anchor="<id>"]'). The overlay
 * draws its own stitched-outline spotlight (dashed Everthread hem) in a
 * position:fixed layer and dims everything EXCEPT the anchored element
 * (box-shadow cutout); the anchored element itself is never restyled.
 * A missing/hidden anchor degrades to a lower-center toast-style card —
 * never throws, never blocks the flow. anchor:null = center-screen modal
 * card over a full dim; the final beat (minute_10_wrapup) renders as a
 * vellum "journal" page dismissed with any key.
 *
 * Keybind tokens [MOVE]/[BREAK]/[PLACE]/[INVENTORY]/[INTERACT]/[EAT] in
 * coach-mark bodies are substituted at render time from the ACTIVE
 * bindings: localStorage "loomfall.bindings" -> fetch of
 * ux/keybinds/bindings.default.json -> hard fallback. The overlay listens
 * for "lf-bindings-change" (§4) and re-renders tokens live.
 *
 * PUBLIC ATTRIBUTES
 * @attr {string} src - URL of the flow JSON (tutorial.json shape). Read on
 *   connect. Alternatively assign the parsed object to the `flow` property.
 * @attr {boolean} autostart - Call start() once the flow is loaded (no-op
 *   when the don't-show-again flag is persisted).
 * @attr {boolean} active - Reflected while the tutorial is running. Managed
 *   by start()/stop()/completion — treat as read-only.
 *
 * PUBLIC PROPERTIES
 *   flow      - {version, beats:[...]} flow object (get/set).
 *   bindings  - active bindings map (get/set; action -> {primary,...}).
 *   stepIndex - index of the beat currently shown, -1 when none (get).
 *
 * PUBLIC METHODS
 *   start({force}) - arm the overlay. Returns false (and stays off) when
 *     the persisted don't-show-again flag is set, unless force:true.
 *   stop()      - disarm silently (no event).
 *   skipStep()  - dismiss the current coach mark (Escape does the same);
 *     on the final beat this completes the tutorial.
 *   reset()     - clear the persisted flag and re-arm from the beginning.
 *
 * PUBLIC EVENTS
 * @fires lf-tutorial-step - A beat's coach mark was shown.
 *   detail: { index: number, id: string }.
 * @fires lf-tutorial-done - The tutorial ended.
 *   detail: { reason: 'completed'|'skipped', dontShowAgain: boolean }.
 *
 * KEYBOARD
 *   Tab reaches the card's buttons (Skip step / Skip tutorial / Finish).
 *   Escape = skip the current step (an open confirm dialog swallows its
 *   own Escape first). On the final journal page, any key closes.
 *
 * PERSISTENCE
 *   localStorage "loomfall.tutorial.dismissed" = "1" — set on natural
 *   completion or when the user checks "Don't show the tutorial again"
 *   in the skip-confirm dialog; cleared by reset().
 */
import { LFElement, define, clamp } from '../../ui-kit/lf-core.js';
import '../../ui-kit/components/button.js';
import '../../ui-kit/components/modal.js';
import '../../ui-kit/components/toggle.js';

const STORAGE_FLAG = 'loomfall.tutorial.dismissed';
const BINDINGS_KEY = 'loomfall.bindings';

/** Keybind token -> bindings.json action ids (MOVE shows all four). */
const TOKEN_ACTIONS = {
  MOVE: ['moveForward', 'moveLeft', 'moveBack', 'moveRight'],
  BREAK: ['break'],
  PLACE: ['place'],
  INVENTORY: ['inventory'],
  INTERACT: ['interact'],
  EAT: ['eat'],
};

const TOKEN_RE = /\[(MOVE|BREAK|PLACE|INVENTORY|INTERACT|EAT)\]/;

/** Last-resort bindings if neither localStorage nor the default file load. */
const FALLBACK_BINDINGS = {
  moveForward: { primary: 'KeyW' },
  moveLeft: { primary: 'KeyA' },
  moveBack: { primary: 'KeyS' },
  moveRight: { primary: 'KeyD' },
  break: { primary: 'Mouse0' },
  place: { primary: 'Mouse2' },
  interact: { primary: 'Mouse2', secondary: 'KeyF' },
  inventory: { primary: 'KeyE' },
  eat: { primary: 'Mouse2' },
};

/** Human labels for non-obvious codes (same vocabulary as ux/keybinds). */
const KEY_LABELS = {
  Mouse0: 'Left Click', Mouse1: 'Middle Click', Mouse2: 'Right Click',
  Mouse3: 'Mouse 4', Mouse4: 'Mouse 5',
  WheelUp: 'Wheel Up', WheelDown: 'Wheel Down',
  Space: 'Space', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab',
  ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
  ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt', AltRight: 'Right Alt',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};

/**
 * Human label for a binding code. @param {string|null|undefined} code
 * @returns {string|null} null when unbound
 */
function prettyCode(code) {
  if (code === null || code === undefined) return null;
  const s = String(code);
  if (KEY_LABELS[s]) return KEY_LABELS[s];
  let m;
  if ((m = /^Key([A-Z])$/.exec(s))) return m[1];
  if ((m = /^Digit([0-9])$/.exec(s))) return m[1];
  if ((m = /^Numpad(.+)$/.exec(s))) return `Num ${m[1]}`;
  return s;
}

const SPOT_PAD = 6;   // px halo around the anchored element
const GAP = 12;       // px between spotlight and card
const MARGIN = 8;     // px viewport safety margin
const ANY_KEY_IGNORE = new Set([
  'Tab', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock',
]);

export class LFTutorial extends LFElement {
  static observedAttributes = ['src'];

  constructor() {
    super();
    /** @type {{version:number, beats:Array}|null} */
    this._flow = null;
    this._bindings = FALLBACK_BINDINGS;
    this._index = -1;      // beat currently shown / last passed
    this._cardShown = false;
    this._running = false;
    this._dontShowAgain = false;
    this._onGameEvent = (e) => this._handleGameEvent(e);
    this._onBindingsChange = (e) => {
      if (e.detail && e.detail.bindings) {
        this._bindings = e.detail.bindings;
        if (this._cardShown) this._renderBody();
      }
    };
    this._onKeydown = (e) => this._handleKeydown(e);
    this._onReflow = () => {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        if (this._cardShown) this._position();
      });
    };
  }

  /** @returns {{version:number, beats:Array}|null} */
  get flow() {
    return this._flow;
  }

  /** @param {{version:number, beats:Array}} v */
  set flow(v) {
    this._flow = v && Array.isArray(v.beats) ? v : null;
    this._buildDots();
    if (this._flow && this.boolAttr('autostart') && !this._running) this.start();
  }

  /** @returns {Object} active bindings map (action -> slots). */
  get bindings() {
    return this._bindings;
  }

  /** @param {Object} v */
  set bindings(v) {
    if (v && typeof v === 'object') {
      this._bindings = v.bindings || v;
      if (this._cardShown) this._renderBody();
    }
  }

  /** @returns {number} index of the beat currently shown, -1 when none. */
  get stepIndex() {
    return this._cardShown ? this._index : -1;
  }

  render() {
    this.setAttribute('aria-label', 'Tutorial');

    // Full-screen dim used by center-modal beats (anchor: null).
    const dim = document.createElement('div');
    dim.className = 'lf-tutorial__dim';
    dim.hidden = true;

    // Stitched-outline spotlight; its box-shadow dims everything else.
    const spot = document.createElement('div');
    spot.className = 'lf-tutorial__spot';
    spot.setAttribute('aria-hidden', 'true');
    spot.hidden = true;

    // Coach-mark card.
    const card = document.createElement('div');
    card.className = 'lf-tutorial__card';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');
    card.hidden = true;

    const arrow = document.createElement('span');
    arrow.className = 'lf-tutorial__arrow';
    arrow.setAttribute('aria-hidden', 'true');

    const step = document.createElement('p');
    step.className = 'lf-tutorial__step';

    const title = document.createElement('h2');
    title.className = 'lf-tutorial__title';

    const body = document.createElement('p');
    body.className = 'lf-tutorial__body';

    const dots = document.createElement('div');
    dots.className = 'lf-tutorial__dots';
    dots.setAttribute('role', 'img');

    const hint = document.createElement('p');
    hint.className = 'lf-tutorial__hint';
    hint.textContent = 'Press any key to close.';
    hint.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'lf-tutorial__actions';

    const skipStepBtn = document.createElement('lf-button');
    skipStepBtn.setAttribute('size', 'sm');
    skipStepBtn.setAttribute('action', 'skip-step');
    skipStepBtn.textContent = 'Skip step';

    const skipAllBtn = document.createElement('lf-button');
    skipAllBtn.setAttribute('size', 'sm');
    skipAllBtn.setAttribute('action', 'skip-all');
    skipAllBtn.textContent = 'Skip tutorial';

    const finishBtn = document.createElement('lf-button');
    finishBtn.setAttribute('size', 'sm');
    finishBtn.setAttribute('variant', 'primary');
    finishBtn.setAttribute('action', 'finish');
    finishBtn.textContent = 'Finish';
    finishBtn.hidden = true;

    actions.append(skipStepBtn, skipAllBtn, finishBtn);
    card.append(arrow, step, title, body, dots, hint, actions);

    card.addEventListener('lf-action', (e) => {
      const action = e.detail && e.detail.action;
      if (action === 'skip-step') this.skipStep();
      else if (action === 'skip-all') this._confirmSkip();
      else if (action === 'finish') this._complete('completed');
    });

    // Skip-tutorial confirm dialog with don't-show-again toggle.
    const modal = document.createElement('lf-modal');
    modal.setAttribute('heading', 'Skip the tutorial?');
    modal.setAttribute('confirm-label', 'Skip tutorial');
    modal.setAttribute('cancel-label', 'Keep going');
    modal.setAttribute('danger', '');
    const modalText = document.createElement('p');
    modalText.textContent =
      'The remaining first-steps guidance will not be shown for this world.';
    const toggle = document.createElement('lf-toggle');
    toggle.setAttribute('label', "Don't show the tutorial again");
    modal.append(modalText, toggle);
    modal.addEventListener('lf-action', (e) => {
      if (e.detail && e.detail.action === 'confirm') {
        this._dontShowAgain = toggle.hasAttribute('checked');
        this._complete('skipped');
      }
    });

    this.append(dim, spot, card, modal);
    this._dim = dim;
    this._spot = spot;
    this._card = card;
    this._arrow = arrow;
    this._stepEl = step;
    this._titleEl = title;
    this._bodyEl = body;
    this._dotsEl = dots;
    this._hintEl = hint;
    this._skipStepBtn = skipStepBtn;
    this._skipAllBtn = skipAllBtn;
    this._finishBtn = finishBtn;
    this._modal = modal;
    this._toggle = toggle;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('lf-game-event', this._onGameEvent);
    window.addEventListener('lf-bindings-change', this._onBindingsChange);
    window.addEventListener('keydown', this._onKeydown);
    window.addEventListener('resize', this._onReflow);
    window.addEventListener('scroll', this._onReflow, { capture: true, passive: true });
    if (!this._flow && this.getAttribute('src')) this._loadFlow(this.getAttribute('src'));
    this._loadBindings();
  }

  disconnectedCallback() {
    window.removeEventListener('lf-game-event', this._onGameEvent);
    window.removeEventListener('lf-bindings-change', this._onBindingsChange);
    window.removeEventListener('keydown', this._onKeydown);
    window.removeEventListener('resize', this._onReflow);
    window.removeEventListener('scroll', this._onReflow, { capture: true });
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  /* ---------------------------------------------------------- lifecycle */

  /**
   * Arm the overlay (it then waits for the first gateEvent).
   * @param {{force?: boolean}} [opts]
   * @returns {boolean} whether the tutorial armed
   */
  start(opts = {}) {
    if (!opts.force && this._flagSet()) return false;
    this._running = true;
    this._index = -1;
    this._dontShowAgain = false;
    this.reflectBool('active', true);
    this._hideCard();
    return true;
  }

  /** Disarm silently (no lf-tutorial-done). */
  stop() {
    this._running = false;
    this.reflectBool('active', false);
    this._hideCard();
  }

  /** Clear the persisted flag and re-arm from the beginning. */
  reset() {
    try {
      localStorage.removeItem(STORAGE_FLAG);
    } catch (_) { /* storage unavailable */ }
    if (this._toggle) this._toggle.removeAttribute('checked');
    this.start({ force: true });
  }

  /** Dismiss the current coach mark; completes the flow on the last beat. */
  skipStep() {
    if (!this._running || !this._cardShown) return;
    if (this._flow && this._index === this._flow.beats.length - 1) {
      this._complete('completed');
      return;
    }
    this._hideCard();
  }

  /* ------------------------------------------------------------ loading */

  /** @param {string} url */
  _loadFlow(url) {
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        this.flow = data;
      })
      .catch(() => {
        // Missing flow file: stay silently disarmed (never throw).
        this._flow = null;
      });
  }

  /** localStorage bindings -> default bindings file -> hard fallback. */
  _loadBindings() {
    try {
      const stored = localStorage.getItem(BINDINGS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && parsed.bindings) {
          this._bindings = parsed.bindings;
          return;
        }
      }
    } catch (_) { /* fall through to file */ }
    fetch(new URL('../keybinds/bindings.default.json', import.meta.url))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (data && data.bindings) {
          this._bindings = data.bindings;
          if (this._cardShown) this._renderBody();
        }
      })
      .catch(() => { /* keep FALLBACK_BINDINGS */ });
  }

  /** @returns {boolean} */
  _flagSet() {
    try {
      return localStorage.getItem(STORAGE_FLAG) === '1';
    } catch (_) {
      return false;
    }
  }

  /* ------------------------------------------------------------- events */

  /** @param {CustomEvent} e */
  _handleGameEvent(e) {
    if (!this._running || !this._flow) return;
    const type = e.detail && e.detail.type;
    if (!type) return;
    const i = this._flow.beats.findIndex((b) => b.gateEvent === type || b.id === type);
    if (i === -1 || i <= this._index) return; // unknown or already passed
    this._show(i);
  }

  /** @param {KeyboardEvent} e */
  _handleKeydown(e) {
    if (!this._running || !this._cardShown) return;
    if (this._modal && this._modal.open) return; // dialog swallows its keys
    const last = this._flow && this._index === this._flow.beats.length - 1;
    if (last) {
      // Journal page: any key closes (modifiers/Tab keep keyboard nav free).
      if (ANY_KEY_IGNORE.has(e.key)) return;
      this._complete('completed');
    } else if (e.key === 'Escape') {
      this.skipStep();
    }
  }

  /* ------------------------------------------------------------ display */

  /** @param {number} i */
  _show(i) {
    this._index = i;
    const beats = this._flow.beats;
    const beat = beats[i];
    const last = i === beats.length - 1;

    this._stepEl.textContent = `Step ${i + 1} of ${beats.length}`;
    this._titleEl.textContent = beat.coachMark.title || '';
    this._renderBody();
    this._updateDots();

    this._card.classList.toggle('lf-tutorial__card--journal', last);
    this._card.dataset.beat = beat.id;
    this._skipStepBtn.hidden = last;
    this._skipAllBtn.hidden = last;
    this._finishBtn.hidden = !last;
    this._hintEl.hidden = !last;

    this._card.hidden = false;
    this._cardShown = true;
    this._position();
    this.emit('lf-tutorial-step', { index: i, id: beat.id });
  }

  _hideCard() {
    this._cardShown = false;
    if (this._card) this._card.hidden = true;
    if (this._spot) this._spot.hidden = true;
    if (this._dim) this._dim.hidden = true;
  }

  /** Substitute [TOKEN]s in the current beat's body into kbd chips. */
  _renderBody() {
    const beat = this._flow && this._flow.beats[this._index];
    if (!beat) return;
    const el = this._bodyEl;
    el.textContent = '';
    const parts = String(beat.coachMark.body || '').split(TOKEN_RE);
    parts.forEach((part, idx) => {
      if (idx % 2 === 0) {
        if (part) el.appendChild(document.createTextNode(part));
        return;
      }
      const group = document.createElement('span');
      group.className = 'lf-tutorial__keys';
      (TOKEN_ACTIONS[part] || []).forEach((action) => {
        const slots = this._bindings[action] || {};
        const label = prettyCode(slots.primary) || prettyCode(slots.secondary) || 'Unbound';
        const kbd = document.createElement('kbd');
        kbd.className = 'lf-tutorial__kbd';
        kbd.textContent = label;
        group.appendChild(kbd);
      });
      el.appendChild(group);
    });
  }

  _buildDots() {
    if (!this._dotsEl) return;
    this._dotsEl.textContent = '';
    if (!this._flow) return;
    for (let i = 0; i < this._flow.beats.length; i++) {
      const dot = document.createElement('span');
      dot.className = 'lf-tutorial__dot';
      dot.dataset.state = 'todo';
      this._dotsEl.appendChild(dot);
    }
  }

  _updateDots() {
    const n = this._flow.beats.length;
    if (this._dotsEl.children.length !== n) this._buildDots();
    this._dotsEl.setAttribute('aria-label', `Step ${this._index + 1} of ${n}`);
    Array.from(this._dotsEl.children).forEach((dot, i) => {
      dot.dataset.state = i < this._index ? 'done' : i === this._index ? 'current' : 'todo';
    });
  }

  /* --------------------------------------------------------- completion */

  /** Open the skip-tutorial confirm dialog. */
  _confirmSkip() {
    if (this._modal) this._modal.show();
  }

  /** @param {'completed'|'skipped'} reason */
  _complete(reason) {
    if (!this._running) return;
    this._running = false;
    const dontShowAgain = reason === 'completed' || this._dontShowAgain;
    if (dontShowAgain) {
      try {
        localStorage.setItem(STORAGE_FLAG, '1');
      } catch (_) { /* storage unavailable */ }
    }
    if (this._modal && this._modal.open) this._modal.close();
    this.reflectBool('active', false);
    this._hideCard();
    this.emit('lf-tutorial-done', { reason, dontShowAgain });
  }

  /* -------------------------------------------------------- positioning */

  _position() {
    const beat = this._flow && this._flow.beats[this._index];
    if (!beat || !this._cardShown) return;
    const card = this._card;
    const anchorId = beat.coachMark.anchor;

    card.classList.remove('lf-tutorial__card--center', 'lf-tutorial__card--toast');
    card.removeAttribute('data-placement');
    card.style.left = '';
    card.style.top = '';

    if (anchorId === null || anchorId === undefined) {
      // Deliberate center-screen modal card over a full dim.
      card.classList.add('lf-tutorial__card--center');
      this._dim.hidden = false;
      this._spot.hidden = true;
      return;
    }

    const target = document.querySelector(`[data-lf-anchor="${anchorId}"]`);
    const rect = target ? target.getBoundingClientRect() : null;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      // Contract §3: missing anchor degrades to a lower-center toast card.
      card.classList.add('lf-tutorial__card--toast');
      this._dim.hidden = true;
      this._spot.hidden = true;
      return;
    }

    // Spotlight: dashed hem + box-shadow dim cutout around the anchor.
    const sx = rect.left - SPOT_PAD;
    const sy = rect.top - SPOT_PAD;
    const sw = rect.width + SPOT_PAD * 2;
    const sh = rect.height + SPOT_PAD * 2;
    this._dim.hidden = true;
    this._spot.hidden = false;
    this._spot.style.left = `${sx}px`;
    this._spot.style.top = `${sy}px`;
    this._spot.style.width = `${sw}px`;
    this._spot.style.height = `${sh}px`;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    let placement = beat.coachMark.placement || 'bottom';

    // Flip when the preferred side has no room.
    if (placement === 'top' && sy - GAP - ch < MARGIN) placement = 'bottom';
    else if (placement === 'bottom' && sy + sh + GAP + ch > vh - MARGIN) placement = 'top';
    else if (placement === 'left' && sx - GAP - cw < MARGIN) placement = 'right';
    else if (placement === 'right' && sx + sw + GAP + cw > vw - MARGIN) placement = 'left';

    let left;
    let top;
    if (placement === 'top' || placement === 'bottom') {
      top = placement === 'top' ? sy - GAP - ch : sy + sh + GAP;
      left = clamp(sx + sw / 2 - cw / 2, MARGIN, Math.max(MARGIN, vw - cw - MARGIN));
      const ax = clamp(sx + sw / 2 - left, 16, cw - 16);
      card.style.setProperty('--lf-tut-arrow-x', `${ax}px`);
    } else {
      left = placement === 'left' ? sx - GAP - cw : sx + sw + GAP;
      top = clamp(sy + sh / 2 - ch / 2, MARGIN, Math.max(MARGIN, vh - ch - MARGIN));
      const ay = clamp(sy + sh / 2 - top, 16, ch - 16);
      card.style.setProperty('--lf-tut-arrow-y', `${ay}px`);
    }
    top = clamp(top, MARGIN, Math.max(MARGIN, vh - ch - MARGIN));
    card.dataset.placement = placement;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }
}

define('lf-tutorial', LFTutorial);
