/**
 * Loomfall UI Kit — <lf-pause-menu>
 *
 * In-world pause screen: a centered button stack on a dimmed backdrop
 * (the world keeps rendering behind it — UX_SPEC screen stack). Composes
 * <lf-button> from builder A. Renders sensibly from attributes alone so
 * script-free gallery fragments work.
 *
 * Usage:
 *   <lf-pause-menu open></lf-pause-menu>
 *   pm.addEventListener('lf-action', e => e.detail.action === 'resume' && pm.close());
 *   pm.addEventListener('lf-back', () => screenStack.pop());
 *
 * PUBLIC ATTRIBUTES
 * @attr {boolean} open - Present while the screen is shown. Reflected;
 *   also the `open` JS property. Toggle via show()/close().
 * @attr {string} heading - Screen title. Default "Game Paused".
 * @attr {boolean} static - Gallery/demo mode: renders in-flow over a
 *   placeholder "world" gradient instead of pinned full-viewport.
 * @attr {boolean} data-demo-hover / data-demo-active - Gallery convention:
 *   forwarded onto the primary "Back to Game" button.
 *
 * PUBLIC METHODS
 *   show()  - show the screen, focus the primary button.
 *   close() - hide the screen.
 *
 * PUBLIC EVENTS
 * @fires lf-action - A menu button was pressed (bubbles up from lf-button).
 *   detail: { action: 'resume'|'advancements'|'statistics'|'settings'|'quit' }.
 * @fires lf-back - Escape pressed: pop exactly ONE screen level (the host
 *   app resumes gameplay and re-acquires pointer lock).
 *
 * KEYBOARD
 *   Escape → lf-back. Tab/Shift+Tab move through the native buttons.
 */
import { LFElement, define, uid } from '../lf-core.js';
import '../components/button.js';

const BUTTONS = [
  { action: 'resume', label: 'Back to Game', variant: 'primary', row: 0 },
  { action: 'advancements', label: 'Advancements', variant: 'secondary', row: 1 },
  { action: 'statistics', label: 'Statistics', variant: 'secondary', row: 1 },
  { action: 'settings', label: 'Settings…', variant: 'secondary', row: 2 },
  { action: 'quit', label: 'Save & Quit to Title', variant: 'secondary', row: 3 },
];

export class LFPauseMenu extends LFElement {
  static observedAttributes = ['open', 'heading'];

  constructor() {
    super();
    this._onKeydown = (e) => {
      if (e.key !== 'Escape' || !this.open) return;
      e.stopPropagation();
      this.emit('lf-back', { from: 'pause-menu' });
    };
  }

  render() {
    const titleId = uid('lf-pause-title');

    const backdrop = document.createElement('div');
    backdrop.className = 'lf-pause-menu__backdrop';
    backdrop.setAttribute('aria-hidden', 'true');

    const panel = document.createElement('section');
    panel.className = 'lf-pause-menu__panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', titleId);

    const title = document.createElement('h2');
    title.className = 'lf-pause-menu__title lf-h2';
    title.id = titleId;

    const stack = document.createElement('div');
    stack.className = 'lf-pause-menu__stack';

    /** @type {Map<number, HTMLElement>} row index -> row container */
    const rows = new Map();
    for (const spec of BUTTONS) {
      const btn = document.createElement('lf-button');
      btn.setAttribute('variant', spec.variant);
      btn.setAttribute('action', spec.action);
      btn.textContent = spec.label;
      if (spec.action === 'resume') {
        this._primaryBtn = btn;
        if (this.hasAttribute('data-demo-hover')) btn.setAttribute('data-demo-hover', '');
        if (this.hasAttribute('data-demo-active')) btn.setAttribute('data-demo-active', '');
      }
      if (!rows.has(spec.row)) {
        const row = document.createElement('div');
        row.className = 'lf-pause-menu__row';
        rows.set(spec.row, row);
        stack.appendChild(row);
      }
      rows.get(spec.row).appendChild(btn);
    }

    panel.append(title, stack);
    this.append(backdrop, panel);
    this._title = title;

    this.addEventListener('keydown', this._onKeydown);
  }

  update() {
    this._title.textContent = this.getAttribute('heading') || 'Game Paused';
  }

  /** @type {boolean} */
  get open() {
    return this.boolAttr('open');
  }
  set open(v) {
    this.reflectBool('open', !!v);
  }

  /** Show the screen and move focus to the primary button. */
  show() {
    this.open = true;
    if (!this.boolAttr('static')) {
      const face = this._primaryBtn && this._primaryBtn.querySelector('button');
      if (face) face.focus();
    }
  }

  /** Hide the screen (host app re-acquires pointer lock). */
  close() {
    this.open = false;
  }
}

define('lf-pause-menu', LFPauseMenu);
