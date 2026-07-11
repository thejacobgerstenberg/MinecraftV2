/**
 * Loomfall UI Kit — <lf-slider>
 *
 * Range slider built on a native <input type="range"> (arrow keys, Home/End,
 * PageUp/PageDown all native). Renders the spec "Name: <value>" label row,
 * a token-filled track (gold fill up to the current value) and a value
 * bubble that appears on hover / keyboard focus / drag.
 *
 * Usage:
 *   <lf-slider label="Render Distance" min="2" max="12" step="1" value="6"></lf-slider>
 *   <lf-slider label="FOV" min="60" max="110" value="75" unit="°"></lf-slider>
 *
 * @attr {string} label - Visible name for the "Name: value" row (also the
 *   native input's <label>).
 * @attr {number} min - Minimum value (default 0).
 * @attr {number} max - Maximum value (default 100).
 * @attr {number} step - Step increment (default 1).
 * @attr {number} value - Current value (reflected; el.value mirrors it).
 * @attr {string} unit - Optional suffix rendered after the value ("%", "°").
 * @attr {boolean} disabled - Dim track/knob/text, no interaction.
 *
 * @fires lf-input - Live while dragging / arrowing. detail: { value: number }.
 * @fires lf-change - On commit (pointer release / key settle). detail: { value: number }.
 *
 * Demo states for static galleries: data-demo-hover shows the value bubble.
 */
import { LFElement, define, uid, clamp } from '../lf-core.js';

export class LFSlider extends LFElement {
  static observedAttributes = ['label', 'min', 'max', 'step', 'value', 'unit', 'disabled'];

  render() {
    const inputId = uid('lf-slider');

    const row = document.createElement('div');
    row.className = 'lf-slider__labelrow';

    const label = document.createElement('label');
    label.className = 'lf-slider__label';
    label.htmlFor = inputId;

    const valueOut = document.createElement('span');
    valueOut.className = 'lf-slider__value';

    row.append(label, valueOut);

    const wrap = document.createElement('div');
    wrap.className = 'lf-slider__wrap';

    const input = document.createElement('input');
    input.type = 'range';
    input.id = inputId;
    input.className = 'lf-slider__range';

    const bubble = document.createElement('output');
    bubble.className = 'lf-slider__bubble';
    bubble.setAttribute('aria-hidden', 'true'); // value already announced natively

    wrap.append(input, bubble);
    this.append(row, wrap);

    input.addEventListener('input', () => {
      this.setAttribute('value', input.value);
      this.emit('lf-input', { value: Number(input.value) });
    });
    input.addEventListener('change', () => {
      this.emit('lf-change', { value: Number(input.value) });
    });

    this._input = input;
    this._label = label;
    this._valueOut = valueOut;
    this._bubble = bubble;
    this._wrap = wrap;
  }

  update() {
    const min = Number(this.getAttribute('min') ?? 0);
    const max = Number(this.getAttribute('max') ?? 100);
    const step = this.getAttribute('step') ?? '1';
    const raw = Number(this.getAttribute('value') ?? min);
    const value = clamp(Number.isFinite(raw) ? raw : min, min, max);
    const unit = this.getAttribute('unit') || '';

    this._input.min = String(min);
    this._input.max = String(max);
    this._input.step = String(step);
    if (this._input.value !== String(value)) this._input.value = String(value);
    this._input.disabled = this.disabled;

    this._label.textContent = `${this.getAttribute('label') || 'Value'}:`;
    this._valueOut.textContent = `${value}${unit}`;
    this._bubble.textContent = `${value}${unit}`;

    const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
    this._wrap.style.setProperty('--lf-slider-fill', `${pct}%`);
  }

  /** @type {number} */
  get value() {
    return Number(this.getAttribute('value') ?? this.getAttribute('min') ?? 0);
  }
  set value(v) {
    this.setAttribute('value', String(v));
  }

  /** @type {boolean} */
  get disabled() {
    return this.boolAttr('disabled');
  }
  set disabled(v) {
    this.reflectBool('disabled', !!v);
  }
}

define('lf-slider', LFSlider);
