/**
 * Loomfall UI Kit — <lf-input>
 *
 * Labeled text field built on a native <label>/<input> pair (uid-linked).
 * Supports a dim hint line and an error state: error border + message line
 * with a frayed-X glyph (shape cue — never color alone), aria-invalid and
 * aria-describedby wiring.
 *
 * Usage:
 *   <lf-input label="World Name" placeholder="New World"></lf-input>
 *   <lf-input label="Seed" hint="Leave blank for a random seed"></lf-input>
 *   <lf-input label="World Name" value="" error="A name is required"></lf-input>
 *
 * @attr {string} label - Visible field label (native <label for>).
 * @attr {string} value - Current text (reflected; el.value mirrors it).
 * @attr {string} placeholder - Placeholder text (token-colored).
 * @attr {string} type - Input type (default "text").
 * @attr {string} maxlength - Forwarded to the native input.
 * @attr {string} hint - Dim helper line under the field (aria-describedby).
 * @attr {string} error - Error MESSAGE; its presence switches the field into
 *   the error state (error border, frayed-X glyph line, aria-invalid="true",
 *   aria-describedby → message id).
 * @attr {boolean} disabled - Dim field/text, not editable.
 *
 * @fires lf-input - Live on each keystroke. detail: { value: string }.
 * @fires lf-change - On commit (native change/blur). detail: { value: string }.
 */
import { LFElement, define, uid } from '../lf-core.js';

const FRAYED_X =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">' +
  '<path d="M4 4 L12 12 M12 4 L4 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>' +
  '<path d="M2.6 1.8 L4 4 M13.4 1.8 L12 4 M2.6 14.2 L4 12 M13.4 14.2 L12 12" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" fill="none"/>' +
  '</svg>';

export class LFInput extends LFElement {
  static observedAttributes = [
    'label',
    'value',
    'placeholder',
    'type',
    'maxlength',
    'hint',
    'error',
    'disabled',
  ];

  render() {
    const inputId = uid('lf-input');
    const hintId = uid('lf-input-hint');
    const errId = uid('lf-input-err');

    const label = document.createElement('label');
    label.className = 'lf-input__label';
    label.htmlFor = inputId;

    const input = document.createElement('input');
    input.className = 'lf-input__field';
    input.id = inputId;

    const hint = document.createElement('p');
    hint.className = 'lf-input__msg lf-input__hint';
    hint.id = hintId;
    hint.hidden = true;

    const err = document.createElement('p');
    err.className = 'lf-input__msg lf-input__error';
    err.id = errId;
    err.hidden = true;
    const errGlyph = document.createElement('span');
    errGlyph.className = 'lf-input__error-glyph';
    errGlyph.setAttribute('aria-hidden', 'true');
    errGlyph.innerHTML = FRAYED_X;
    const errText = document.createElement('span');
    errText.className = 'lf-input__error-text';
    err.append(errGlyph, errText);

    this.append(label, input, hint, err);

    input.addEventListener('input', () => {
      // Reflect silently; update() skips value sync while focused.
      this.setAttribute('value', input.value);
      this.emit('lf-input', { value: input.value });
    });
    input.addEventListener('change', () => {
      this.emit('lf-change', { value: input.value });
    });

    this._input = input;
    this._labelEl = label;
    this._hint = hint;
    this._err = err;
    this._errText = errText;
  }

  update() {
    this._labelEl.textContent = this.getAttribute('label') || 'Field';
    this._input.type = this.getAttribute('type') || 'text';
    this._input.placeholder = this.getAttribute('placeholder') || '';
    if (this.hasAttribute('maxlength')) {
      this._input.setAttribute('maxlength', this.getAttribute('maxlength'));
    } else {
      this._input.removeAttribute('maxlength');
    }
    this._input.disabled = this.disabled;

    // Don't clobber the caret while the user is typing.
    const v = this.getAttribute('value') || '';
    if (document.activeElement !== this._input && this._input.value !== v) {
      this._input.value = v;
    }

    const hintText = this.getAttribute('hint');
    this._hint.hidden = !hintText;
    if (hintText) this._hint.textContent = hintText;

    const errText = this.getAttribute('error');
    this._err.hidden = errText === null;
    this._errText.textContent = errText || '';
    if (errText !== null) {
      this._input.setAttribute('aria-invalid', 'true');
    } else {
      this._input.removeAttribute('aria-invalid');
    }

    const describedBy = [];
    if (hintText) describedBy.push(this._hint.id);
    if (errText !== null) describedBy.push(this._err.id);
    if (describedBy.length) {
      this._input.setAttribute('aria-describedby', describedBy.join(' '));
    } else {
      this._input.removeAttribute('aria-describedby');
    }
  }

  /** @type {string} */
  get value() {
    return this._input ? this._input.value : this.getAttribute('value') || '';
  }
  set value(v) {
    this.setAttribute('value', String(v));
    if (this._input) this._input.value = String(v);
  }

  /** @type {boolean} */
  get disabled() {
    return this.boolAttr('disabled');
  }
  set disabled(v) {
    this.reflectBool('disabled', !!v);
  }

  /** @type {string|null} Error message, or null when valid. */
  get error() {
    return this.getAttribute('error');
  }
  set error(v) {
    if (v === null || v === undefined || v === false) this.removeAttribute('error');
    else this.setAttribute('error', String(v));
  }
}

define('lf-input', LFInput);
