/**
 * Loomfall UI Kit — <lf-item-slot> + <lf-inventory-grid>
 *
 * Item slot: one inventory cell (icon area, stack count, rarity edge,
 * durability bar). Grid: rows x cols of slots with pointer drag/drop,
 * keyboard pickup/place, roving tabindex, hover fill + tooltip.
 * Light DOM, tokens-only color (procedural icon swatches map to ramp tokens).
 *
 * =========================================================================
 * <lf-item-slot>
 * Usage:
 *   <lf-item-slot item="Warpstone" count="12" rarity="rare"></lf-item-slot>
 *   <lf-item-slot></lf-item-slot>                          (empty slot)
 *
 * @attr {string} item - Display name of the stack. Empty/absent = empty slot
 *   (reflected as [empty] for CSS).
 * @attr {number} count - Stack size. Rendered bottom-right ONLY when > 1.
 * @attr {("common"|"uncommon"|"rare"|"epic")} rarity - Rarity edge along the
 *   slot bottom. Color is paired with a PATTERN cue (solid / dashed /
 *   double-stitch) so rarity is never hue-only. Default "common" (no edge).
 * @attr {string} swatch - Optional ramp-token suffix ("warpwold-4",
 *   "cinderloom-5", "nevermend-3") for the procedural voxel icon. Omitted =
 *   deterministic hash of the item name. Real game art can replace the icon
 *   by setting --lf-slot-swatch or slotting an <img class="lf-item-slot__img">.
 * @attr {number} durability - 0..1; shows a width-coded bar (length cue +
 *   success/warn/error color by thirds — never hue alone). Omit to hide.
 * @attr {boolean} selected - Selection frame: stitched (dashed) knotlight
 *   outline + notch marker — a luminance + shape cue that survives all three
 *   colorblind projections (rubric R6.1), never a hue-only recolor.
 * @attr {boolean} held - Stack is "picked up" (keyboard move / drag source).
 * @attr {boolean} disabled - Locked slot: dim, no hover, skipped by roving nav.
 * @attr {string} label - Explicit accessible name for the inner button
 *   (e.g. "Slot 1: Warpstone"). Default is auto ("Warpstone, 12, rare").
 *
 * @fires lf-select - On pointer click (detail: { value: string|null }).
 *   Containers (grid/hotbar) add index-aware handling on top.
 *
 * Demo states for static galleries: data-demo-hover / data-demo-active.
 *
 * =========================================================================
 * <lf-inventory-grid>
 * Usage:
 *   <lf-inventory-grid columns="9" label="Inventory">
 *     <lf-item-slot item="Warpstone" count="12"></lf-item-slot>
 *     ... (padded with empty slots to fill the last row)
 *   </lf-inventory-grid>
 *
 * @attr {number} columns - Cells per row (default 9).
 * @attr {string} label - Accessible name (default "Inventory").
 *
 * Keyboard (roving tabindex, grid orientation):
 *   Arrows/Home/End move focus; Enter/Space picks UP the focused stack, then
 *   Enter/Space on another cell places/swaps it; Esc cancels a pickup, or
 *   emits lf-close when nothing is held. Announcements go to a polite
 *   live region.
 * Pointer: press + drag a stack to another cell to move/swap (ghost icon
 *   follows the pointer); plain click = pick up / place, mirroring keyboard.
 *
 * @fires lf-move - After a move/swap. detail: { from: number, to: number }.
 * @fires lf-select - Cell activated with nothing held. detail: { index, value }.
 * @fires lf-close - Esc pressed with nothing held (cancelable).
 */
import { LFElement, RovingTabindex, define, emit } from '../lf-core.js';

/** Ramp-token suffixes used for procedural item swatches. */
const SWATCH_RAMPS = [
  'warpwold-2', 'warpwold-3', 'warpwold-4', 'warpwold-5',
  'cinderloom-3', 'cinderloom-4', 'cinderloom-5', 'cinderloom-6',
  'nevermend-3', 'nevermend-4', 'nevermend-5', 'nevermend-6',
];

/** Attributes that travel with a stack when slots swap. */
const STACK_ATTRS = ['item', 'count', 'rarity', 'swatch', 'durability'];

/**
 * Deterministic tiny hash for item-name -> swatch assignment.
 * @param {string} s @returns {number}
 */
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

export class LFItemSlot extends LFElement {
  static observedAttributes = [
    'item', 'count', 'rarity', 'swatch', 'durability',
    'selected', 'held', 'disabled', 'label',
  ];

  render() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lf-item-slot__cell';

    const icon = document.createElement('span');
    icon.className = 'lf-item-slot__icon';
    icon.setAttribute('aria-hidden', 'true');

    const rarity = document.createElement('span');
    rarity.className = 'lf-item-slot__rarity';
    rarity.setAttribute('aria-hidden', 'true');

    const dura = document.createElement('span');
    dura.className = 'lf-item-slot__durability';
    dura.setAttribute('aria-hidden', 'true');
    const duraFill = document.createElement('span');
    duraFill.className = 'lf-item-slot__durability-fill';
    dura.appendChild(duraFill);

    const count = document.createElement('span');
    count.className = 'lf-item-slot__count';
    count.setAttribute('aria-hidden', 'true');

    btn.append(icon, rarity, dura, count);
    this.appendChild(btn);

    btn.addEventListener('click', () => {
      if (this.disabled) return;
      this.emit('lf-select', { value: this.item });
    });

    this._btn = btn;
    this._icon = icon;
    this._count = count;
    this._dura = dura;
    this._duraFill = duraFill;
  }

  update() {
    const item = this.item;
    const count = this.count;
    const rarity = this.getAttribute('rarity') || 'common';

    // Empty-state reflection for CSS (icon/count hidden via [empty]).
    this.reflectBool('empty', !item);

    // Procedural swatch: explicit attr wins, else name hash. Tokens only.
    if (item) {
      const swatch =
        this.getAttribute('swatch') ||
        SWATCH_RAMPS[hashStr(item) % SWATCH_RAMPS.length];
      this._icon.style.setProperty('--lf-slot-swatch', `var(--lf-ramp-${swatch})`);
    } else {
      this._icon.style.removeProperty('--lf-slot-swatch');
    }

    this._count.textContent = count > 1 ? String(count) : '';

    // Durability bar (width cue + thirds coloring handled in CSS).
    const d = this.getAttribute('durability');
    if (d !== null && item) {
      const v = Math.max(0, Math.min(1, parseFloat(d) || 0));
      this._dura.hidden = false;
      this._duraFill.style.width = `${Math.round(v * 100)}%`;
      this._duraFill.dataset.level = v > 0.6 ? 'high' : v > 0.25 ? 'mid' : 'low';
    } else {
      this._dura.hidden = true;
    }

    // Accessible name: explicit label attr wins.
    let label = this.getAttribute('label');
    if (!label) {
      if (!item) label = 'Empty slot';
      else {
        label = item;
        if (count > 1) label += `, ${count}`;
        if (rarity !== 'common') label += `, ${rarity}`;
        if (this.held) label += ', picked up';
      }
    }
    this._btn.setAttribute('aria-label', label);
    this._btn.disabled = this.disabled;
  }

  /** @type {string|null} item display name (null when empty). */
  get item() {
    return this.getAttribute('item') || null;
  }
  set item(v) {
    if (v) this.setAttribute('item', v);
    else this.removeAttribute('item');
  }

  /** @type {number} stack size (0 when empty). */
  get count() {
    return this.item ? Math.max(1, parseInt(this.getAttribute('count') || '1', 10) || 1) : 0;
  }
  set count(v) {
    this.setAttribute('count', String(v));
  }

  /** @type {boolean} */
  get selected() {
    return this.boolAttr('selected');
  }
  set selected(v) {
    this.reflectBool('selected', !!v);
  }

  /** @type {boolean} */
  get held() {
    return this.boolAttr('held');
  }
  set held(v) {
    this.reflectBool('held', !!v);
  }

  /** @type {boolean} */
  get disabled() {
    return this.boolAttr('disabled');
  }
  set disabled(v) {
    this.reflectBool('disabled', !!v);
  }

  /**
   * Move this slot's stack attributes onto another slot, swapping contents.
   * @param {LFItemSlot} other
   */
  swapWith(other) {
    for (const attr of STACK_ATTRS) {
      const mine = this.getAttribute(attr);
      const theirs = other.getAttribute(attr);
      if (theirs === null) this.removeAttribute(attr);
      else this.setAttribute(attr, theirs);
      if (mine === null) other.removeAttribute(attr);
      else other.setAttribute(attr, mine);
    }
    this.update();
    other.update();
  }
}

export class LFInventoryGrid extends LFElement {
  static observedAttributes = ['columns', 'label'];

  render() {
    const columns = this.columns;

    // Adopt authored slots; pad the last row with empty slots.
    const slots = Array.from(this.querySelectorAll('lf-item-slot'));
    const total = Math.max(columns, Math.ceil(Math.max(slots.length, 1) / columns) * columns);
    while (slots.length < total) slots.push(document.createElement('lf-item-slot'));

    this.textContent = '';
    this.setAttribute('role', 'grid');

    const body = document.createElement('div');
    body.className = 'lf-inventory-grid__body';
    for (let r = 0; r < slots.length / columns; r++) {
      const row = document.createElement('div');
      row.className = 'lf-inventory-grid__row';
      row.setAttribute('role', 'row');
      for (let c = 0; c < columns; c++) {
        const slot = slots[r * columns + c];
        slot.setAttribute('role', 'gridcell');
        row.appendChild(slot);
      }
      body.appendChild(row);
    }

    // Tooltip card (dark loom-room card in both themes). Info it carries is
    // duplicated in each cell's aria-label, so it stays aria-hidden.
    const tip = document.createElement('div');
    tip.className = 'lf-inventory-grid__tip';
    tip.setAttribute('aria-hidden', 'true');
    tip.hidden = true;

    // Polite live region for keyboard pickup/place announcements.
    const live = document.createElement('div');
    live.className = 'lf-visually-hidden';
    live.setAttribute('aria-live', 'polite');

    this.append(body, tip, live);
    this._body = body;
    this._tip = tip;
    this._live = live;
    /** @type {LFItemSlot|null} slot whose stack is currently picked up */
    this._heldSlot = null;
    this._suppressClick = false;

    this._rove = new RovingTabindex(body, {
      selector: '.lf-item-slot__cell',
      orientation: 'both',
      wrap: false,
      grid: { columns },
      onActivate: (cell) => this._activate(cell.closest('lf-item-slot')),
    });

    // Pointer interactions -------------------------------------------------
    body.addEventListener('click', (e) => {
      if (this._suppressClick) {
        this._suppressClick = false;
        return;
      }
      const slot = /** @type {LFItemSlot|null} */ (
        /** @type {Element} */ (e.target).closest('lf-item-slot')
      );
      if (slot && !slot.disabled) this._activate(slot);
    });

    body.addEventListener('pointerdown', (e) => this._dragStart(e));

    // Hover fill is CSS; tooltip follows hover + keyboard focus.
    body.addEventListener('pointerover', (e) => {
      const slot = /** @type {Element} */ (e.target).closest('lf-item-slot');
      if (slot) this._showTip(/** @type {LFItemSlot} */ (slot));
    });
    body.addEventListener('pointerout', (e) => {
      const slot = /** @type {Element} */ (e.target).closest('lf-item-slot');
      const to = e.relatedTarget && /** @type {Element} */ (e.relatedTarget).closest?.('lf-item-slot');
      if (slot && slot !== to) this._hideTip();
    });
    body.addEventListener('focusin', (e) => {
      const slot = /** @type {Element} */ (e.target).closest('lf-item-slot');
      if (slot) this._showTip(/** @type {LFItemSlot} */ (slot));
    });
    body.addEventListener('focusout', () => this._hideTip());

    // Esc: cancel pickup first; otherwise ask to close (screen pops 1 level).
    this.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this._heldSlot) {
        e.stopPropagation();
        this._cancelHold();
      } else {
        this.emit('lf-close', {}, { cancelable: true });
      }
    });

    // Define-order proofing (same as lf-hotbar): if <lf-item-slot> upgrades
    // after this render, the .lf-item-slot__cell buttons don't exist yet —
    // re-run roving tabindex + state sync once the slot class registers.
    customElements.whenDefined('lf-item-slot').then(() => {
      if (this.isConnected) {
        this._rove.refresh();
        this.update();
      }
    });
  }

  update() {
    this.setAttribute('aria-label', this.getAttribute('label') || 'Inventory');
  }

  /** @type {number} cells per row. */
  get columns() {
    return Math.max(1, parseInt(this.getAttribute('columns') || '9', 10) || 9);
  }

  /** @returns {LFItemSlot[]} all slots in visual order. */
  get slots() {
    return /** @type {LFItemSlot[]} */ (Array.from(this.querySelectorAll('lf-item-slot')));
  }

  /**
   * Pick-up / place / swap state machine shared by click + Enter/Space.
   * @param {LFItemSlot|null} slot
   */
  _activate(slot) {
    if (!slot || slot.disabled) return;
    const idx = this.slots.indexOf(slot);
    if (!this._heldSlot) {
      if (!slot.item) {
        this.emit('lf-select', { index: idx, value: null });
        return;
      }
      this._heldSlot = slot;
      slot.held = true;
      this._announce(
        `Picked up ${slot.item}. Move with arrow keys, Enter to place, Escape to cancel.`
      );
      this.emit('lf-select', { index: idx, value: slot.item });
    } else if (this._heldSlot === slot) {
      this._cancelHold();
    } else {
      const from = this.slots.indexOf(this._heldSlot);
      const moved = this._heldSlot.item;
      this._heldSlot.held = false;
      this._heldSlot.swapWith(slot);
      this._heldSlot = null;
      this._announce(`Placed ${moved} in slot ${idx + 1}.`);
      this.emit('lf-move', { from, to: idx });
    }
  }

  _cancelHold() {
    if (!this._heldSlot) return;
    this._heldSlot.held = false;
    this._heldSlot = null;
    this._announce('Pickup cancelled.');
  }

  /** @param {string} msg */
  _announce(msg) {
    this._live.textContent = msg;
  }

  /** @param {PointerEvent} e */
  _dragStart(e) {
    if (e.button !== 0) return;
    const source = /** @type {LFItemSlot|null} */ (
      /** @type {Element} */ (e.target).closest('lf-item-slot')
    );
    if (!source || source.disabled || !source.item) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let ghost = null;
    const cell = source.querySelector('.lf-item-slot__cell');
    cell.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        ghost = document.createElement('div');
        ghost.className = 'lf-inventory-grid__ghost';
        ghost.setAttribute('aria-hidden', 'true');
        const icon = source.querySelector('.lf-item-slot__icon');
        ghost.appendChild(icon.cloneNode(true));
        document.body.appendChild(ghost);
        source.held = true;
        this._hideTip();
      }
      ghost.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px)`;
    };

    const onUp = (ev) => {
      cell.removeEventListener('pointermove', onMove);
      cell.removeEventListener('pointerup', onUp);
      cell.removeEventListener('pointercancel', onUp);
      if (!ghost) return; // plain click — let the click handler run
      ghost.remove();
      source.held = false;
      this._suppressClick = true;
      if (ev.type === 'pointercancel') return;
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = under && /** @type {Element} */ (under).closest('lf-item-slot');
      if (target && target !== source && !target.disabled && this.contains(target)) {
        const from = this.slots.indexOf(source);
        const to = this.slots.indexOf(/** @type {LFItemSlot} */ (target));
        source.swapWith(/** @type {LFItemSlot} */ (target));
        this.emit('lf-move', { from, to });
      }
    };

    cell.addEventListener('pointermove', onMove);
    cell.addEventListener('pointerup', onUp);
    cell.addEventListener('pointercancel', onUp);
  }

  /** @param {LFItemSlot} slot */
  _showTip(slot) {
    if (!slot.item) {
      this._hideTip();
      return;
    }
    const rarity = slot.getAttribute('rarity') || 'common';
    this._tip.textContent = '';
    const name = document.createElement('span');
    name.className = 'lf-inventory-grid__tip-name';
    name.textContent = slot.item;
    this._tip.appendChild(name);
    if (rarity !== 'common') {
      const r = document.createElement('span');
      r.className = 'lf-inventory-grid__tip-rarity';
      r.dataset.rarity = rarity;
      r.textContent = rarity;
      this._tip.appendChild(r);
    }
    const host = this.getBoundingClientRect();
    const rect = slot.getBoundingClientRect();
    this._tip.hidden = false;
    this._tip.style.left = `${rect.left - host.left + rect.width / 2}px`;
    this._tip.style.top = `${rect.top - host.top}px`;
  }

  _hideTip() {
    this._tip.hidden = true;
  }
}

define('lf-item-slot', LFItemSlot);
define('lf-inventory-grid', LFInventoryGrid);
