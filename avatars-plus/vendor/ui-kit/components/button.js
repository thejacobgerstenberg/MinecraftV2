/**
 * Loomfall UI Kit — <lf-button>
 *
 * Push button wrapping a native <button> (class="lf-button__face") so focus,
 * Enter/Space activation and [disabled] semantics come for free. Light DOM.
 *
 * Usage:
 *   <lf-button variant="primary">Create World</lf-button>
 *   <lf-button variant="danger" action="delete">Delete World</lf-button>
 *   <lf-button size="icon" aria-label="Accessibility settings">+</lf-button>
 *
 * @attr {("primary"|"secondary"|"danger")} variant - Visual style. Defaults
 *   to "secondary". "primary" is the Everthread-gold CTA (gold fill +
 *   void-ink label in both themes). "danger" keeps the secondary face but
 *   uses the error label color PAIRED with a frayed-X glyph (never hue-only).
 * @attr {("md"|"sm"|"icon")} size - Sizing. "icon" is a 32x32 square and
 *   REQUIRES an aria-label (forwarded to the inner native button).
 * @attr {boolean} disabled - Disabled state: dim face/text, no hover/active
 *   response, not focusable (native disabled).
 * @attr {boolean} loading - Busy state: shows a spinner glyph, blocks
 *   activation (aria-disabled, click guard) but keeps focus/colors.
 * @attr {string} action - Optional action id included in the lf-action detail.
 * @attr {string} aria-label - Accessible name; moved onto the native button.
 *
 * @fires lf-action - On activation (click / Enter / Space) when not
 *   disabled/loading. detail: { action: string|null }.
 *
 * Demo states for static galleries: data-demo-hover / data-demo-active.
 */
import { LFElement, define } from '../lf-core.js';

const FRAYED_X =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path d="M4 4 L12 12 M12 4 L4 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>' +
  '<path d="M2.6 1.8 L4 4 M13.4 1.8 L12 4 M2.6 14.2 L4 12 M13.4 14.2 L12 12" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" fill="none"/>' +
  '</svg>';

const SPINNER =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-dasharray="26 12"/>' +
  '</svg>';

export class LFButton extends LFElement {
  static observedAttributes = ['variant', 'size', 'disabled', 'loading'];

  render() {
    // Move authored children into the label span.
    const kids = Array.from(this.childNodes);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lf-button__face';

    const spinner = document.createElement('span');
    spinner.className = 'lf-button__spinner';
    spinner.setAttribute('aria-hidden', 'true');
    spinner.innerHTML = SPINNER;

    const glyph = document.createElement('span');
    glyph.className = 'lf-button__glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.hidden = true;
    glyph.innerHTML = FRAYED_X;

    const label = document.createElement('span');
    label.className = 'lf-button__label';
    for (const k of kids) label.appendChild(k);

    btn.append(spinner, glyph, label);
    this.appendChild(btn);

    // Icon-only accessible name: forward aria-label to the focusable button.
    if (this.hasAttribute('aria-label')) {
      btn.setAttribute('aria-label', this.getAttribute('aria-label'));
      this.removeAttribute('aria-label');
    }

    btn.addEventListener('click', (e) => {
      if (this.loading || this.disabled) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      this.emit('lf-action', { action: this.getAttribute('action') || null });
    });

    this._btn = btn;
    this._glyph = glyph;
  }

  update() {
    const variant = this.getAttribute('variant') || 'secondary';
    this._glyph.hidden = variant !== 'danger';
    this._btn.disabled = this.disabled;
    if (this.loading) {
      this._btn.setAttribute('aria-disabled', 'true');
      this._btn.setAttribute('aria-busy', 'true');
    } else {
      this._btn.removeAttribute('aria-disabled');
      this._btn.removeAttribute('aria-busy');
    }
  }

  /** @type {boolean} */
  get disabled() {
    return this.boolAttr('disabled');
  }
  set disabled(v) {
    this.reflectBool('disabled', !!v);
  }

  /** @type {boolean} */
  get loading() {
    return this.boolAttr('loading');
  }
  set loading(v) {
    this.reflectBool('loading', !!v);
  }

  /** @type {string} */
  get variant() {
    return this.getAttribute('variant') || 'secondary';
  }
  set variant(v) {
    this.setAttribute('variant', v);
  }
}

define('lf-button', LFButton);
