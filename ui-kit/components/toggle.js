/**
 * Loomfall UI Kit — <lf-toggle>
 *
 * On/off switch. Wraps a native <button role="switch" aria-checked> so
 * Enter/Space toggle natively. Checked state carries THREE non-hue cues:
 * visible "ON"/"OFF" text, knob position, and track brightness.
 *
 * Usage:
 *   <lf-toggle label="Menu Blur" checked></lf-toggle>
 *   <lf-toggle label="Toggle Sneak"></lf-toggle>
 *
 * @attr {string} label - Visible widget label ("Name: ON/OFF" pattern).
 *   Falls back to authored text content.
 * @attr {boolean} checked - Switch state (reflected; el.checked mirrors it).
 * @attr {boolean} disabled - Dim face/text, no hover, not focusable.
 *
 * @fires lf-change - After user toggle. detail: { value: boolean }.
 *
 * Demo states for static galleries: data-demo-hover / data-demo-active.
 */
import { LFElement, define } from '../lf-core.js';

export class LFToggle extends LFElement {
  static observedAttributes = ['checked', 'disabled', 'label'];

  render() {
    const fallback = (this.textContent || '').trim();
    this.textContent = '';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lf-toggle__face';
    btn.setAttribute('role', 'switch');

    const label = document.createElement('span');
    label.className = 'lf-toggle__label';

    const track = document.createElement('span');
    track.className = 'lf-toggle__track';
    track.setAttribute('aria-hidden', 'true');
    const knob = document.createElement('span');
    knob.className = 'lf-toggle__knob';
    track.appendChild(knob);

    const state = document.createElement('span');
    state.className = 'lf-toggle__state';
    state.setAttribute('aria-hidden', 'true'); // aria-checked announces state

    btn.append(label, track, state);
    this.appendChild(btn);

    btn.addEventListener('click', () => {
      if (this.disabled) return;
      this.checked = !this.checked;
      this.emit('lf-change', { value: this.checked });
    });

    this._btn = btn;
    this._label = label;
    this._state = state;
    this._fallbackLabel = fallback;
  }

  update() {
    const text = this.getAttribute('label') || this._fallbackLabel || 'Toggle';
    this._label.textContent = text;
    this._state.textContent = this.checked ? 'ON' : 'OFF';
    this._btn.setAttribute('aria-checked', this.checked ? 'true' : 'false');
    this._btn.disabled = this.disabled;
  }

  /** @type {boolean} */
  get checked() {
    return this.boolAttr('checked');
  }
  set checked(v) {
    this.reflectBool('checked', !!v);
  }

  /** @type {boolean} */
  get disabled() {
    return this.boolAttr('disabled');
  }
  set disabled(v) {
    this.reflectBool('disabled', !!v);
  }

  /** @type {string} */
  get label() {
    return this.getAttribute('label') || this._fallbackLabel || '';
  }
  set label(v) {
    this.setAttribute('label', v);
  }
}

define('lf-toggle', LFToggle);
