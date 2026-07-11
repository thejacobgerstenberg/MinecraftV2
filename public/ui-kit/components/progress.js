/**
 * Loomfall UI Kit — <lf-progress>
 *
 * Progress bar: determinate (value/max) or indeterminate loading shuttle.
 * Reduced-motion aware: the indeterminate animation collapses to a calm
 * static state under prefers-reduced-motion (CSS-side).
 *
 *   <lf-progress label="Weaving chunks" value="62" max="100" show-value></lf-progress>
 *   <lf-progress label="Connecting" indeterminate></lf-progress>
 *
 * PUBLIC ATTRIBUTES
 * @attr {number} value - Current value (clamped to 0..max). Reactive;
 *   also the `value` JS property.
 * @attr {number} max - Upper bound (default 100, must be > 0).
 * @attr {string} label - Accessible name (aria-label) and, when present,
 *   a visible label line above the track.
 * @attr {boolean} show-value - Also print the percentage next to the label.
 * @attr {boolean} indeterminate - Loading shuttle; omits aria-valuenow
 *   per the progressbar pattern.
 *
 * PUBLIC EVENTS
 *   (none — lf-progress is output-only)
 *
 * A11Y
 *   Track carries role="progressbar" + aria-valuemin/aria-valuemax and,
 *   when determinate, aria-valuenow. aria-label comes from `label`
 *   (fallback "Progress").
 */
import { LFElement, define, clamp } from '../lf-core.js';

export class LFProgress extends LFElement {
  static observedAttributes = ['value', 'max', 'label', 'indeterminate', 'show-value'];

  /** @returns {number} */
  get value() {
    return clamp(parseFloat(this.getAttribute('value') || '0') || 0, 0, this.max);
  }

  /** @param {number} v */
  set value(v) {
    this.setAttribute('value', String(v));
  }

  /** @returns {number} */
  get max() {
    const m = parseFloat(this.getAttribute('max') || '100');
    return Number.isFinite(m) && m > 0 ? m : 100;
  }

  /** @param {number} m */
  set max(m) {
    this.setAttribute('max', String(m));
  }

  /** @returns {boolean} */
  get indeterminate() {
    return this.boolAttr('indeterminate');
  }

  /** @param {boolean} v */
  set indeterminate(v) {
    this.reflectBool('indeterminate', !!v);
  }

  render() {
    const labelRow = document.createElement('div');
    labelRow.className = 'lf-progress__labelrow';
    const label = document.createElement('span');
    label.className = 'lf-progress__label';
    const valueText = document.createElement('span');
    valueText.className = 'lf-progress__value';
    labelRow.appendChild(label);
    labelRow.appendChild(valueText);

    const track = document.createElement('div');
    track.className = 'lf-progress__track';
    track.setAttribute('role', 'progressbar');
    const fill = document.createElement('div');
    fill.className = 'lf-progress__fill';
    track.appendChild(fill);

    this.appendChild(labelRow);
    this.appendChild(track);
    this._labelRow = labelRow;
    this._label = label;
    this._valueText = valueText;
    this._track = track;
    this._fill = fill;
  }

  update() {
    if (!this._track) return;
    const label = this.getAttribute('label') || '';
    this._label.textContent = label;
    this._labelRow.hidden = !label;
    this._track.setAttribute('aria-label', label || 'Progress');
    this._track.setAttribute('aria-valuemin', '0');
    this._track.setAttribute('aria-valuemax', String(this.max));

    if (this.indeterminate) {
      this._track.removeAttribute('aria-valuenow');
      this._valueText.hidden = true;
      this._fill.style.width = '';
    } else {
      const pct = Math.round((this.value / this.max) * 100);
      this._track.setAttribute('aria-valuenow', String(this.value));
      this._fill.style.width = `${pct}%`;
      this._valueText.hidden = !this.boolAttr('show-value');
      this._valueText.textContent = `${pct}%`;
    }
  }
}

define('lf-progress', LFProgress);
