/**
 * Loomfall UI Kit — <lf-dropdown>
 *
 * Select widget on the WAI-ARIA listbox pattern:
 * <button aria-haspopup="listbox" aria-expanded> + <ul role="listbox"> of
 * role="option" items. Options are authored declaratively as native
 * <option> children (consumed on connect):
 *
 *   <lf-dropdown label="Colorblind Mode" value="none">
 *     <option value="none">None</option>
 *     <option value="protanopia">Protanopia</option>
 *     <option value="deuteranopia" disabled>Deuteranopia</option>
 *   </lf-dropdown>
 *
 * The selected option shows a stitch-check glyph (shape cue, never color
 * alone). Keyboard: Enter/Space/ArrowDown/ArrowUp on the trigger opens and
 * focuses the selected option; arrows rove (RovingTabindex, vertical, skips
 * disabled options); Enter/Space selects; Esc closes and returns focus to
 * the trigger; outside pointerdown closes.
 *
 * @attr {string} label - Visible name prefix on the trigger ("Label: Value")
 *   and the listbox's aria-label.
 * @attr {string} value - Selected option value (reflected; el.value mirrors).
 * @attr {boolean} open - Popup visibility (reflected; can be authored for
 *   static gallery demos — attribute-driven open does not steal focus).
 * @attr {boolean} disabled - Disables the trigger entirely.
 * @attr {boolean|string} data-demo-hover - Gallery-only hover demo on the
 *   trigger; an authored <option data-demo-hover> forwards to its row.
 *
 * @fires lf-open - When the popup opens.
 * @fires lf-close - When the popup closes.
 * @fires lf-select - On option choice. detail: { value: string, index: number }.
 * @fires lf-change - On committed value change. detail: { value: string }.
 */
import { LFElement, define, uid, RovingTabindex } from '../lf-core.js';

const CHEVRON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">' +
  '<path d="M3.5 6 L8 10.5 L12.5 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

const STITCH_CHECK =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">' +
  '<path d="M2.5 8.5 L6.5 12.5 L13.5 4" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="3 1.6"/>' +
  '</svg>';

export class LFDropdown extends LFElement {
  static observedAttributes = ['value', 'open', 'disabled', 'label'];

  constructor() {
    super();
    this._onDocPointerDown = (e) => {
      if (this.open && !this.contains(e.target)) this._close(false);
    };
  }

  render() {
    // Consume authored <option> children.
    this._options = Array.from(this.querySelectorAll('option')).map((o) => ({
      value: o.getAttribute('value') ?? o.textContent.trim(),
      label: o.textContent.trim(),
      disabled: o.hasAttribute('disabled'),
      demoHover: o.hasAttribute('data-demo-hover'),
    }));
    this.textContent = '';

    const listId = uid('lf-dropdown-list');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'lf-dropdown__trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', listId);

    const tLabel = document.createElement('span');
    tLabel.className = 'lf-dropdown__triggerlabel';
    const tValue = document.createElement('span');
    tValue.className = 'lf-dropdown__triggervalue';
    const caret = document.createElement('span');
    caret.className = 'lf-dropdown__caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.innerHTML = CHEVRON;
    trigger.append(tLabel, tValue, caret);

    const list = document.createElement('ul');
    list.className = 'lf-dropdown__list';
    list.id = listId;
    list.setAttribute('role', 'listbox');

    this._optionEls = this._options.map((opt, i) => {
      const li = document.createElement('li');
      li.className = 'lf-dropdown__option';
      li.setAttribute('role', 'option');
      li.dataset.value = opt.value;
      li.tabIndex = -1;
      if (opt.disabled) li.setAttribute('aria-disabled', 'true');
      if (opt.demoHover) li.setAttribute('data-demo-hover', '');
      const check = document.createElement('span');
      check.className = 'lf-dropdown__check';
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = STITCH_CHECK;
      const text = document.createElement('span');
      text.className = 'lf-dropdown__optionlabel';
      text.textContent = opt.label;
      li.append(check, text);
      li.addEventListener('click', () => {
        if (!opt.disabled) this._select(i);
      });
      list.appendChild(li);
      return li;
    });

    this.append(trigger, list);

    this._rove = new RovingTabindex(list, {
      selector: '.lf-dropdown__option',
      orientation: 'vertical',
      wrap: true,
      onActivate: (item) => {
        const idx = this._optionEls.indexOf(item);
        if (idx !== -1) this._select(idx);
      },
    });

    trigger.addEventListener('click', () => {
      if (this.disabled) return;
      if (this.open) this._close(true);
      else this._openPopup();
    });
    trigger.addEventListener('keydown', (e) => {
      if (this.disabled) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this._openPopup();
      }
    });
    list.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this._close(true);
      } else if (e.key === 'Tab') {
        this._close(false);
      }
    });

    this._trigger = trigger;
    this._tLabel = tLabel;
    this._tValue = tValue;
    this._list = list;
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('pointerdown', this._onDocPointerDown);
  }

  disconnectedCallback() {
    document.removeEventListener('pointerdown', this._onDocPointerDown);
  }

  update() {
    const label = this.getAttribute('label') || '';
    const selIdx = this._selectedIndex();
    const selLabel = selIdx !== -1 ? this._options[selIdx].label : '—';

    this._tLabel.textContent = label ? `${label}:` : '';
    this._tLabel.hidden = !label;
    this._tValue.textContent = selLabel;
    this._trigger.disabled = this.disabled;
    this._trigger.setAttribute('aria-expanded', this.open ? 'true' : 'false');
    this._list.setAttribute('aria-label', label || 'Options');

    this._optionEls.forEach((li, i) => {
      li.setAttribute('aria-selected', i === selIdx ? 'true' : 'false');
    });
  }

  _selectedIndex() {
    const v = this.getAttribute('value');
    return this._options.findIndex((o) => o.value === v);
  }

  _openPopup() {
    if (this.open) return;
    this.reflectBool('open', true);
    this.emit('lf-open');
    const sel = this._selectedIndex();
    const items = this._rove.items();
    const target = sel !== -1 ? items.indexOf(this._optionEls[sel]) : 0;
    this._rove.setActive(Math.max(0, target));
  }

  /**
   * @param {boolean} refocus - return focus to the trigger (keyboard path).
   */
  _close(refocus) {
    if (!this.open) return;
    this.reflectBool('open', false);
    this.emit('lf-close');
    if (refocus) this._trigger.focus();
  }

  /** @param {number} index */
  _select(index) {
    const opt = this._options[index];
    const changed = this.getAttribute('value') !== opt.value;
    this.setAttribute('value', opt.value);
    this.emit('lf-select', { value: opt.value, index });
    if (changed) this.emit('lf-change', { value: opt.value });
    this._close(true);
  }

  /** @type {string|null} */
  get value() {
    return this.getAttribute('value');
  }
  set value(v) {
    this.setAttribute('value', String(v));
  }

  /** @type {boolean} */
  get open() {
    return this.boolAttr('open');
  }
  set open(v) {
    if (v) this._openPopup();
    else this._close(false);
  }

  /** @type {boolean} */
  get disabled() {
    return this.boolAttr('disabled');
  }
  set disabled(v) {
    this.reflectBool('disabled', !!v);
  }
}

define('lf-dropdown', LFDropdown);
