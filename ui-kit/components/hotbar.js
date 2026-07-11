/**
 * Loomfall UI Kit — <lf-hotbar>
 *
 * 9-slot game hotbar (role="toolbar") built from <lf-item-slot> cells.
 * Selection is a stitched knotlight border + notch marker on the selected
 * slot — a luminance + shape cue that survives deuteranopia/protanopia/
 * tritanopia projections (rubric R6.1), never a hue-only recolor.
 *
 * Usage:
 *   <lf-hotbar selected="0">
 *     <lf-item-slot item="Warpstone" count="12"></lf-item-slot>
 *     ... (padded to 9 slots with empties)
 *   </lf-hotbar>
 *
 * Selection inputs:
 *   - Click / Enter / Space on a slot (roving tabindex, Arrow keys move).
 *   - Number keys 1..9 while focus is inside the hotbar; add [global-keys]
 *     to also listen window-wide (ignored while typing in a text field).
 *   - Mouse wheel over the bar cycles selection (wraps).
 *
 * @attr {number} selected - Selected slot index 0..8 (reflected).
 * @attr {boolean} global-keys - Listen for Digit1..Digit9 on window (game
 *   mode). Off by default so galleries/docs don't hijack typing.
 * @attr {boolean} show-label - Keep the item-name popup visible (for static
 *   demos). Normally it appears on selection change and fades after ~2.6s.
 * @attr {string} label - Accessible toolbar name (default "Hotbar").
 *
 * @fires lf-select - Selection changed. detail: { index: number,
 *   value: string|null } (value = item name of the newly selected slot).
 *
 * Slot states (hover/disabled/rarity/count/durability) come from
 * <lf-item-slot>; see inventory.js.
 */
import { LFElement, RovingTabindex, define } from '../lf-core.js';
import './inventory.js'; // registers <lf-item-slot>

const SLOT_COUNT = 9;
const LABEL_MS = 2600;

export class LFHotbar extends LFElement {
  static observedAttributes = ['selected', 'label', 'show-label'];

  render() {
    // Adopt authored slots, pad to 9.
    const slots = Array.from(this.querySelectorAll('lf-item-slot')).slice(0, SLOT_COUNT);
    while (slots.length < SLOT_COUNT) slots.push(document.createElement('lf-item-slot'));

    this.textContent = '';
    this.setAttribute('role', 'toolbar');

    const bar = document.createElement('div');
    bar.className = 'lf-hotbar__bar';
    for (let i = 0; i < SLOT_COUNT; i++) {
      slots[i].dataset.index = String(i);
      bar.appendChild(slots[i]);
    }

    // Item-name popup (rarity-agnostic name readout above the bar).
    const popup = document.createElement('div');
    popup.className = 'lf-hotbar__label';
    popup.setAttribute('aria-hidden', 'true');

    this.append(popup, bar);
    this._bar = bar;
    this._popup = popup;
    this._labelTimer = 0;
    this._firstUpdate = true;

    this._rove = new RovingTabindex(bar, {
      selector: '.lf-item-slot__cell',
      orientation: 'horizontal',
      wrap: true,
      onActivate: (cell) => {
        const slot = cell.closest('lf-item-slot');
        if (slot) this.select(parseInt(slot.dataset.index, 10));
      },
    });

    bar.addEventListener('click', (e) => {
      const slot = /** @type {Element} */ (e.target).closest('lf-item-slot');
      if (slot && !slot.hasAttribute('disabled')) {
        this.select(parseInt(slot.dataset.index, 10));
      }
    });

    // Wheel over the bar cycles selection (wraps both directions).
    this.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const dir = e.deltaY > 0 ? 1 : -1;
        this.select((this.selected + dir + SLOT_COUNT) % SLOT_COUNT);
      },
      { passive: false }
    );

    // Number keys inside the hotbar always work.
    this.addEventListener('keydown', (e) => this._digitKey(e));

    // Optional window-wide digits (game mode).
    this._onWindowKey = (e) => {
      if (!this.hasAttribute('global-keys')) return;
      const t = /** @type {Element} */ (e.target);
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
      this._digitKey(e);
    };
    window.addEventListener('keydown', this._onWindowKey);

    // Define-order proofing: if <lf-item-slot> upgrades AFTER this render
    // (e.g. a bundler inlined inventory.js later in the module graph), the
    // cells don't exist yet — re-run roving-tabindex + state sync once the
    // slot class is registered and children have upgraded. The re-sync is
    // not a user selection change, so suppress the popup flash.
    customElements.whenDefined('lf-item-slot').then(() => {
      if (this.isConnected) {
        this._rove.refresh();
        this._suppressFlash = true;
        this.update();
        this._suppressFlash = false;
      }
    });
  }

  disconnectedCallback() {
    window.removeEventListener('keydown', this._onWindowKey);
  }

  update() {
    const sel = this.selected;
    const slots = this.slots;
    slots.forEach((slot, i) => {
      slot.selected = i === sel;
      const cell = slot.querySelector('.lf-item-slot__cell');
      if (cell) {
        cell.setAttribute('aria-pressed', i === sel ? 'true' : 'false');
        cell.setAttribute('aria-keyshortcuts', String(i + 1));
        slot.setAttribute('label', `Slot ${i + 1}: ${slot.item || 'empty'}`);
      }
    });
    this.setAttribute('aria-label', this.getAttribute('label') || 'Hotbar');

    // Item-name popup: show on selection change (skip initial paint unless
    // pinned by [show-label]). Rarity-colored (R7.6) — copy the selected
    // slot's rarity onto the popup and append the rarity word (non-hue cue).
    const selSlot = slots[sel];
    const name = selSlot ? selSlot.item : null;
    const rarity = (selSlot && selSlot.getAttribute('rarity')) || 'common';
    const pinned = this.boolAttr('show-label');
    if (pinned) {
      this._popup.textContent = name ? this._popupText(name, rarity) : '';
      this._popup.dataset.rarity = rarity;
      this._popup.dataset.show = name ? 'true' : 'false';
    } else if (!this._firstUpdate && !this._suppressFlash && name) {
      this._flashLabel(name, rarity);
    }
    this._firstUpdate = false;
  }

  /**
   * @param {string} name
   * @param {string} rarity
   */
  _popupText(name, rarity) {
    return rarity && rarity !== 'common' ? `${name} (${rarity})` : name;
  }

  /**
   * @param {string} name
   * @param {string} rarity
   */
  _flashLabel(name, rarity) {
    this._popup.textContent = this._popupText(name, rarity);
    this._popup.dataset.rarity = rarity || 'common';
    this._popup.dataset.show = 'true';
    clearTimeout(this._labelTimer);
    this._labelTimer = setTimeout(() => {
      this._popup.dataset.show = 'false';
    }, LABEL_MS);
  }

  /** @param {KeyboardEvent} e */
  _digitKey(e) {
    const m = /^Digit([1-9])$/.exec(e.code);
    if (!m || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    this.select(parseInt(m[1], 10) - 1);
  }

  /**
   * Select a slot by index and emit lf-select.
   * @param {number} index 0..8
   */
  select(index) {
    const i = Math.max(0, Math.min(SLOT_COUNT - 1, index | 0));
    const changed = i !== this.selected;
    this.selected = i; // reflect -> update()
    if (changed) {
      const slot = this.slots[i];
      this.emit('lf-select', { index: i, value: slot ? slot.item : null });
    }
  }

  /** @type {number} selected slot index (0..8). */
  get selected() {
    const v = parseInt(this.getAttribute('selected') || '0', 10);
    return Number.isFinite(v) ? Math.max(0, Math.min(SLOT_COUNT - 1, v)) : 0;
  }
  set selected(v) {
    this.setAttribute('selected', String(v));
  }

  /** @returns {import('./inventory.js').LFItemSlot[]} the 9 slots. */
  get slots() {
    return /** @type {*} */ (Array.from(this.querySelectorAll('lf-item-slot')));
  }
}

define('lf-hotbar', LFHotbar);
