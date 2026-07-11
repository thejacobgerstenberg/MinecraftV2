/**
 * Loomfall UI Kit — lf-core.js
 *
 * Tiny shared foundation for all lf-* custom elements. Framework-free,
 * evergreen-browser ES module. No dependencies.
 *
 * DESIGN DECISION — light DOM, no shadow DOM:
 * The kit deliberately renders into the light DOM so that (a) the game
 * shell's theme CSS and tokens.css custom properties style components with
 * plain selectors, (b) the UX-review screenshot tooling can locate parts by
 * class, and (c) bitmap-font / image-rendering rules cascade naturally.
 * Collision safety comes from naming discipline instead: every element is
 * `lf-*`, every internal class is `lf-*`, every custom property is `--lf-*`.
 *
 * CONVENTIONS every component must follow:
 *  - Element names: `lf-button`, `lf-slider`, ... (registered via define()).
 *  - State is expressed as reflected ATTRIBUTES on the host, never as
 *    internal classes: `disabled`, `checked`, `selected`, `open`, `error`,
 *    `value`, ... CSS targets `lf-button[disabled]` etc.
 *  - Colors in component CSS come exclusively from `var(--lf-*)` tokens.
 *  - Events are plain CustomEvents emitted via `this.emit(type, detail)`,
 *    named `lf-<verb>` (e.g. `lf-change`, `lf-select`, `lf-dismiss`).
 */

/**
 * Dispatch a namespaced CustomEvent from an element.
 * @param {EventTarget} target - Element to dispatch from.
 * @param {string} type - Event type, e.g. "lf-change".
 * @param {*} [detail] - Payload placed on event.detail.
 * @param {{bubbles?: boolean, cancelable?: boolean}} [opts]
 * @returns {boolean} false if a cancelable event was preventDefault()ed.
 */
export function emit(target, type, detail, opts = {}) {
  return target.dispatchEvent(
    new CustomEvent(type, {
      detail,
      bubbles: opts.bubbles !== false,
      composed: true,
      cancelable: !!opts.cancelable,
    })
  );
}

/**
 * Monotonic unique-id helper for wiring label/description ARIA relations.
 * @param {string} [prefix="lf"]
 * @returns {string} e.g. "lf-7"
 */
let _uid = 0;
export function uid(prefix = 'lf') {
  _uid += 1;
  return `${prefix}-${_uid}`;
}

/**
 * Base class for all Loomfall custom elements.
 *
 * Lifecycle contract for subclasses:
 *  - implement `render()` — build light-DOM children (called once, on first
 *    connect). Idempotence is NOT required; the base guards re-entry.
 *  - implement `update()` — sync DOM with current attribute/property state.
 *    Called after render() and on every observed-attribute change.
 *  - list reactive attributes in `static observedAttributes`.
 *
 * Property/attribute upgrades: properties set on the element *before* it
 * was defined (a common timing hazard) are re-applied through the class
 * setters automatically for every name in `static observedAttributes`.
 */
export class LFElement extends HTMLElement {
  constructor() {
    super();
    /** @type {boolean} whether render() has run */
    this._lfRendered = false;
  }

  connectedCallback() {
    // Upgrade instance properties assigned before definition.
    const observed = /** @type {typeof LFElement} */ (this.constructor).observedAttributes || [];
    for (const attr of observed) {
      const prop = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (Object.prototype.hasOwnProperty.call(this, prop)) {
        const v = /** @type {*} */ (this)[prop];
        delete (/** @type {*} */ (this)[prop]);
        /** @type {*} */ (this)[prop] = v;
      }
    }
    if (!this._lfRendered) {
      this._lfRendered = true;
      this.render();
    }
    this.update();
  }

  /**
   * @param {string} _name @param {string|null} oldV @param {string|null} newV
   */
  attributeChangedCallback(_name, oldV, newV) {
    if (oldV === newV || !this._lfRendered) return;
    this.update();
  }

  /** Build initial light-DOM children. Subclasses override. */
  render() {}

  /** Sync DOM to state. Subclasses override. */
  update() {}

  /**
   * Emit a namespaced CustomEvent from this element.
   * @param {string} type @param {*} [detail] @param {{bubbles?: boolean, cancelable?: boolean}} [opts]
   * @returns {boolean}
   */
  emit(type, detail, opts) {
    return emit(this, type, detail, opts);
  }

  /**
   * Reflect a boolean state to an attribute (presence = true).
   * @param {string} name @param {boolean} value
   */
  reflectBool(name, value) {
    if (value) this.setAttribute(name, '');
    else this.removeAttribute(name);
  }

  /**
   * Read a boolean attribute.
   * @param {string} name @returns {boolean}
   */
  boolAttr(name) {
    return this.hasAttribute(name);
  }

  /**
   * Query a single descendant. @param {string} sel @returns {HTMLElement|null}
   */
  $(sel) {
    return this.querySelector(sel);
  }

  /**
   * Query all descendants. @param {string} sel @returns {HTMLElement[]}
   */
  $$(sel) {
    return Array.from(this.querySelectorAll(sel));
  }
}

/**
 * Roving-tabindex keyboard navigation for composite widgets (toolbars,
 * listboxes, radiogroups, tab lists, grids, hotbars).
 *
 * Exactly one item keeps tabindex="0"; Arrow keys move focus; Home/End jump.
 * With `grid` set, Up/Down move by row. Wraps by default.
 *
 * Usage:
 *   const rove = new RovingTabindex(container, {
 *     selector: '.lf-slot', orientation: 'horizontal', wrap: true,
 *     onActivate: (item, index) => {...},   // Enter/Space
 *     onFocusChange: (item, index) => {...}
 *   });
 *   rove.refresh();      // after items change
 *   rove.setActive(3);   // programmatic
 *   rove.destroy();      // teardown
 */
export class RovingTabindex {
  /**
   * @param {HTMLElement} container
   * @param {{
   *   selector: string,
   *   orientation?: 'horizontal'|'vertical'|'both',
   *   wrap?: boolean,
   *   grid?: {columns: number}|null,
   *   onActivate?: (item: HTMLElement, index: number) => void,
   *   onFocusChange?: (item: HTMLElement, index: number) => void,
   * }} opts
   */
  constructor(container, opts) {
    this.container = container;
    this.selector = opts.selector;
    this.orientation = opts.orientation || 'both';
    this.wrap = opts.wrap !== false;
    this.grid = opts.grid || null;
    this.onActivate = opts.onActivate || null;
    this.onFocusChange = opts.onFocusChange || null;
    this.activeIndex = 0;
    this._onKeydown = this._handleKeydown.bind(this);
    this._onFocusin = this._handleFocusin.bind(this);
    container.addEventListener('keydown', this._onKeydown);
    container.addEventListener('focusin', this._onFocusin);
    this.refresh();
  }

  /** @returns {HTMLElement[]} ALL items in DOM order, including disabled. */
  allItems() {
    return Array.from(this.container.querySelectorAll(this.selector));
  }

  /** @returns {HTMLElement[]} current focusable items (disabled excluded). */
  items() {
    return this.allItems().filter(
      (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true'
    );
  }

  /** Re-scan items and normalize tabindex (call after DOM changes). */
  refresh() {
    const items = this.items();
    if (items.length === 0) return;
    if (this.activeIndex >= items.length) this.activeIndex = items.length - 1;
    items.forEach((el, i) => {
      el.setAttribute('tabindex', i === this.activeIndex ? '0' : '-1');
    });
  }

  /**
   * Make index the roving target; optionally move focus to it.
   * @param {number} index @param {{focus?: boolean}} [opts]
   */
  setActive(index, opts = {}) {
    const items = this.items();
    if (items.length === 0) return;
    const clamped = Math.max(0, Math.min(index, items.length - 1));
    this.activeIndex = clamped;
    items.forEach((el, i) => el.setAttribute('tabindex', i === clamped ? '0' : '-1'));
    if (opts.focus !== false) items[clamped].focus();
    if (this.onFocusChange) this.onFocusChange(items[clamped], clamped);
  }

  /** @param {FocusEvent} e */
  _handleFocusin(e) {
    const items = this.items();
    const idx = items.indexOf(/** @type {HTMLElement} */ (e.target));
    if (idx !== -1 && idx !== this.activeIndex) {
      this.activeIndex = idx;
      items.forEach((el, i) => el.setAttribute('tabindex', i === idx ? '0' : '-1'));
      if (this.onFocusChange) this.onFocusChange(items[idx], idx);
    }
  }

  /** @param {KeyboardEvent} e */
  _handleKeydown(e) {
    const items = this.items();
    if (items.length === 0) return;
    const cols = this.grid ? this.grid.columns : 0;
    const horiz = this.orientation !== 'vertical';
    const vert = this.orientation !== 'horizontal';
    let next = -1;

    switch (e.key) {
      case 'ArrowRight':
        if (horiz) next = this._step(items.length, +1);
        break;
      case 'ArrowLeft':
        if (horiz) next = this._step(items.length, -1);
        break;
      case 'ArrowDown':
        if (cols) next = this._gridStep(items, +1);
        else if (vert) next = this._step(items.length, +1);
        break;
      case 'ArrowUp':
        if (cols) next = this._gridStep(items, -1);
        else if (vert) next = this._step(items.length, -1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      case 'Enter':
      case ' ':
        if (this.onActivate) {
          e.preventDefault();
          this.onActivate(items[this.activeIndex], this.activeIndex);
        }
        return;
      default:
        return;
    }

    if (next !== -1) {
      e.preventDefault();
      this.setActive(next);
    }
  }

  /**
   * Grid vertical step: row/column geometry is computed over the FULL
   * (unfiltered) item list so a disabled cell doesn't shift the column.
   * If the cell one row up/down is disabled, keep stepping rows in the same
   * direction/column; if none is enabled, stay put (clamp).
   * @param {HTMLElement[]} items filtered (focusable) items
   * @param {1|-1} dir row direction
   * @returns {number} next index into the FILTERED list
   */
  _gridStep(items, dir) {
    const all = this.allItems();
    const cols = this.grid.columns;
    const cur = all.indexOf(items[this.activeIndex]);
    if (cur === -1) return this.activeIndex;
    for (let t = cur + dir * cols; t >= 0 && t < all.length; t += dir * cols) {
      const el = all[t];
      if (!el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true') {
        return items.indexOf(el);
      }
    }
    return this.activeIndex;
  }

  /**
   * Compute next index with wrap/clamp semantics.
   * @param {number} len @param {number} delta @returns {number}
   */
  _step(len, delta) {
    let next = this.activeIndex + delta;
    if (this.wrap && Math.abs(delta) === 1) {
      next = (next + len) % len;
    } else {
      next = Math.max(0, Math.min(next, len - 1));
    }
    return next;
  }

  /** Remove listeners. */
  destroy() {
    this.container.removeEventListener('keydown', this._onKeydown);
    this.container.removeEventListener('focusin', this._onFocusin);
  }
}

/**
 * Register a custom element once (idempotent — safe under HMR/duplicate
 * imports across dev harness pages).
 * @param {string} name - e.g. "lf-button" (must start with "lf-").
 * @param {CustomElementConstructor} ctor
 */
export function define(name, ctor) {
  if (!name.startsWith('lf-')) {
    throw new Error(`Loomfall kit elements must be namespaced "lf-*", got "${name}"`);
  }
  if (!customElements.get(name)) {
    customElements.define(name, ctor);
  }
}

/**
 * Clamp helper shared by sliders/progress.
 * @param {number} v @param {number} min @param {number} max @returns {number}
 */
export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
