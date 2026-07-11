/**
 * Loomfall UI Kit — <lf-tabs>
 *
 * Accessible tabbed panels (WAI-ARIA Tabs pattern, manual activation).
 * Light DOM. Author panels as direct children carrying `data-tab-label`:
 *
 *   <lf-tabs selected="0" label="World options">
 *     <section data-tab-label="Game">…</section>
 *     <section data-tab-label="World">…</section>
 *     <section data-tab-label="More" data-tab-disabled>…</section>
 *   </lf-tabs>
 *
 * PUBLIC ATTRIBUTES
 * @attr {number} selected - Index of the active tab (0-based). Reflected;
 *   also available as the `selected` JS property.
 * @attr {string} label - Accessible name for the tablist
 *   (aria-label; defaults to "Tabs").
 * @attr {boolean} data-demo-hover - Gallery convention: forwards a
 *   [data-demo-hover] attribute onto the first non-selected enabled tab so
 *   static screenshots can demo the hover state.
 * @attr {boolean} data-demo-active - Same, for the pressed state.
 *
 * Per-panel author attributes (on the child panels, not the host):
 *   data-tab-label     (required) tab button text
 *   data-tab-disabled  (optional) renders the tab disabled / skipped by
 *                      keyboard navigation
 *
 * PUBLIC EVENTS
 * @fires lf-select - When the user activates a tab (click or Enter/Space).
 *   detail = { value: <tab label string>, index: <number> }. Bubbles.
 *
 * KEYBOARD
 *   Left/Right arrows move focus between tabs (roving tabindex, wraps);
 *   Home/End jump; Enter/Space activates the focused tab (manual
 *   activation). The visible panel has tabindex="0" so Tab reaches content.
 *
 * Selection is never hue-only: the active tab carries a 2px Everthread-gold
 * edge marker (shape/position cue) in addition to the heading color shift.
 */
import { LFElement, define, uid, RovingTabindex } from '../lf-core.js';

export class LFTabs extends LFElement {
  static observedAttributes = ['selected', 'label'];

  /** @returns {number} index of the active tab */
  get selected() {
    const n = parseInt(this.getAttribute('selected') || '0', 10);
    return Number.isFinite(n) ? n : 0;
  }

  /** @param {number} i */
  set selected(i) {
    this.setAttribute('selected', String(i));
  }

  render() {
    const panels = Array.from(this.children).filter(
      (el) => el instanceof HTMLElement && el.hasAttribute('data-tab-label')
    );
    /** @type {HTMLElement[]} */
    this._panels = panels;

    const list = document.createElement('div');
    list.className = 'lf-tabs__list';
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', this.getAttribute('label') || 'Tabs');

    /** @type {HTMLButtonElement[]} */
    this._tabs = panels.map((panel, i) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'lf-tabs__tab';
      tab.id = uid('lf-tab');
      tab.setAttribute('role', 'tab');
      tab.dataset.index = String(i);
      tab.textContent = panel.getAttribute('data-tab-label') || `Tab ${i + 1}`;
      if (panel.hasAttribute('data-tab-disabled')) {
        tab.disabled = true;
        tab.setAttribute('aria-disabled', 'true');
      }
      tab.addEventListener('click', () => this._activate(i));
      list.appendChild(tab);

      panel.classList.add('lf-tabs__panel');
      panel.setAttribute('role', 'tabpanel');
      if (!panel.id) panel.id = uid('lf-tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panel.setAttribute('tabindex', '0');
      tab.setAttribute('aria-controls', panel.id);
      return tab;
    });

    const panelsWrap = document.createElement('div');
    panelsWrap.className = 'lf-tabs__panels';
    panels.forEach((p) => panelsWrap.appendChild(p));
    this.prepend(list);
    this.appendChild(panelsWrap);

    this._rove = new RovingTabindex(list, {
      selector: '.lf-tabs__tab',
      orientation: 'horizontal',
      wrap: true,
      onActivate: (item) => this._activate(parseInt(item.dataset.index || '0', 10)),
    });

    // Gallery demo-state forwarding (static screenshots, no scripts).
    for (const demo of ['data-demo-hover', 'data-demo-active']) {
      if (this.hasAttribute(demo)) {
        const target = this._tabs.find((t, i) => !t.disabled && i !== this.selected);
        if (target) target.setAttribute(demo, '');
      }
    }
  }

  /** Activate a tab as a user action (emits lf-select). @param {number} i */
  _activate(i) {
    const tab = this._tabs[i];
    if (!tab || tab.disabled) return;
    if (i !== this.selected) {
      this.selected = i;
      this.emit('lf-select', { value: tab.textContent, index: i });
    }
  }

  update() {
    if (!this._tabs) return;
    const sel = this.selected;
    this._tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', i === sel ? 'true' : 'false');
    });
    this._panels.forEach((panel, i) => {
      panel.hidden = i !== sel;
    });
    // Keep the roving target on the selected tab (unless focus is inside).
    if (this._rove && !this.contains(document.activeElement)) {
      const items = this._rove.items();
      const idx = items.indexOf(this._tabs[sel]);
      if (idx !== -1) this._rove.setActive(idx, { focus: false });
    }
  }

  disconnectedCallback() {
    if (this._rove) this._rove.destroy();
  }
}

define('lf-tabs', LFTabs);
