/**
 * Loomfall UI Kit — <lf-toast> and <lf-toast-rack>
 *
 * <lf-toast> — one notification card. Status color is NEVER the only cue:
 * each status carries its required glyph (info=droplet, success=stitch-check,
 * warn=fray-knot triangle, error=frayed-X), inline SVG in currentColor.
 *
 *   <lf-toast status="success" heading="World saved"
 *             message="Warp Meadow written to disk."></lf-toast>
 *
 * PUBLIC ATTRIBUTES (lf-toast)
 * @attr {'info'|'success'|'warn'|'error'} status - Variant (default "info").
 *   Error toasts get role="alert"; others role="status" (polite).
 * @attr {string} heading - Bold first line (optional).
 * @attr {string} message - Body text (or author children instead).
 * @attr {number} duration - Auto-dismiss after N ms. Omit or 0 = sticky.
 *   The countdown pauses while hovered or focused.
 * @attr {boolean} data-demo-hover / data-demo-active - Gallery convention:
 *   forwarded onto the dismiss button to demo its hover/pressed state.
 *
 * PUBLIC METHODS (lf-toast)
 *   dismiss() - fade out, emit lf-dismiss, remove from DOM.
 *
 * PUBLIC EVENTS (lf-toast)
 * @fires lf-dismiss - The toast is going away (timeout or dismiss button).
 *   detail = { reason: 'timeout' | 'user' | 'api' }.
 *
 * <lf-toast-rack> — fixed top-right stack (z toast), max 3 visible;
 * overflow queues until a slot frees. aria-live="polite" role="status"
 * container per contract.
 *
 * PUBLIC ATTRIBUTES (lf-toast-rack)
 * @attr {boolean} static - Gallery/demo mode: renders in-flow instead of
 *   fixed top-right (screenshot-friendly).
 *
 * PUBLIC METHODS (lf-toast-rack)
 *   show({status, heading, message, duration=5000}) -> lf-toast element.
 */
import { LFElement, define, clamp } from '../lf-core.js';

/** Inline SVG glyphs, one per status. Stroke/fill = currentColor only. */
const GLYPHS = {
  /* Droplet — info/water. */
  info:
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">' +
    '<path d="M8 1.6 C8 1.6 3.6 7.1 3.6 10.1 a4.4 4.4 0 0 0 8.8 0 C12.4 7.1 8 1.6 8 1.6 Z"/>' +
    '</svg>',
  /* Stitch-check — success. Dashed stroke reads as running stitches. */
  success:
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M2.5 8.5 L6.5 12.5 L13.5 3.5" stroke-dasharray="3 1.6"/>' +
    '</svg>',
  /* Fray-knot triangle — warning. */
  warn:
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M8 2.2 L14.6 13.4 H1.4 Z"/>' +
    '<path d="M8 2.2 L6.9 0.9 M8 2.2 L9.2 1" stroke-width="1"/>' +
    '<path d="M8 6.2 v3.2" stroke-width="1.8"/>' +
    '<path d="M8 11.6 v0.01" stroke-width="2.2"/>' +
    '</svg>',
  /* Frayed-X — error. */
  error:
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
    '<path d="M4 4 L12 12 M12 4 L4 12"/>' +
    '<path d="M3.2 2.2 L4 4 M12.8 2.2 L12 4 M2.2 12.8 L4 12 M13.8 13.8 L12 12" stroke-width="1.1"/>' +
    '</svg>',
};

const STATUSES = ['info', 'success', 'warn', 'error'];

export class LFToast extends LFElement {
  static observedAttributes = ['status', 'heading', 'message'];

  /** @returns {'info'|'success'|'warn'|'error'} */
  get status() {
    const s = this.getAttribute('status') || 'info';
    return /** @type {*} */ (STATUSES.includes(s) ? s : 'info');
  }

  render() {
    const extraChildren = Array.from(this.childNodes);

    const glyph = document.createElement('span');
    glyph.className = 'lf-toast__glyph';
    this._glyph = glyph;

    const content = document.createElement('div');
    content.className = 'lf-toast__content';
    const heading = document.createElement('p');
    heading.className = 'lf-toast__heading';
    const message = document.createElement('p');
    message.className = 'lf-toast__message';
    content.appendChild(heading);
    content.appendChild(message);
    extraChildren.forEach((n) => content.appendChild(n));
    this._heading = heading;
    this._message = message;

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'lf-toast__dismiss';
    dismissBtn.setAttribute('aria-label', 'Dismiss');
    dismissBtn.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<path d="M4 4 L12 12 M12 4 L4 12"/></svg>';
    dismissBtn.addEventListener('click', () => this.dismiss('user'));

    this.appendChild(glyph);
    this.appendChild(content);
    this.appendChild(dismissBtn);

    // Gallery demo-state forwarding onto the dismiss button.
    for (const demo of ['data-demo-hover', 'data-demo-active']) {
      if (this.hasAttribute(demo)) dismissBtn.setAttribute(demo, '');
    }

    // Auto-dismiss countdown, paused while hovered or focused.
    this._remaining = parseInt(this.getAttribute('duration') || '0', 10) || 0;
    this._timer = 0;
    this.addEventListener('mouseenter', () => this._pause());
    this.addEventListener('focusin', () => this._pause());
    this.addEventListener('mouseleave', () => this._resume());
    this.addEventListener('focusout', () => this._resume());
  }

  connectedCallback() {
    super.connectedCallback();
    this._resume();
  }

  update() {
    const s = this.status;
    this.setAttribute('role', s === 'error' ? 'alert' : 'status');
    if (this._glyph) this._glyph.innerHTML = GLYPHS[s];
    if (this._heading) {
      this._heading.textContent = this.getAttribute('heading') || '';
      this._heading.hidden = !this.getAttribute('heading');
    }
    if (this._message) {
      this._message.textContent = this.getAttribute('message') || '';
      this._message.hidden = !this.getAttribute('message');
    }
  }

  _pause() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = 0;
      this._remaining = clamp(this._deadline - Date.now(), 0, this._remaining);
    }
  }

  _resume() {
    if (this._remaining > 0 && !this._timer && this.isConnected && !this.hidden) {
      this._deadline = Date.now() + this._remaining;
      this._timer = setTimeout(() => this.dismiss('timeout'), this._remaining);
    }
  }

  /**
   * Fade out, emit lf-dismiss, remove from DOM.
   * @param {'timeout'|'user'|'api'} [reason]
   */
  dismiss(reason = 'api') {
    if (this._dismissed) return;
    this._dismissed = true;
    if (this._timer) clearTimeout(this._timer);
    this.emit('lf-dismiss', { reason });
    this.setAttribute('leaving', '');
    const remove = () => this.remove();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) remove();
    else {
      this.addEventListener('transitionend', remove, { once: true });
      setTimeout(remove, 400); // fallback if transition never fires
    }
  }
}

export class LFToastRack extends LFElement {
  static MAX_VISIBLE = 3;

  render() {
    // Contract: container role="status" aria-live="polite"; error cards
    // individually escalate themselves to role="alert".
    this.setAttribute('role', 'status');
    this.setAttribute('aria-live', 'polite');
    if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', 'Notifications');
    this.addEventListener('lf-dismiss', () => {
      // Promote a queued toast once the leaving one is out of the DOM.
      setTimeout(() => this._layout(), 0);
    });
  }

  /**
   * Spawn a toast into the rack.
   * @param {{status?: string, heading?: string, message?: string, duration?: number}} opts
   * @returns {LFToast}
   */
  show(opts = {}) {
    const toast = /** @type {LFToast} */ (document.createElement('lf-toast'));
    if (opts.status) toast.setAttribute('status', opts.status);
    if (opts.heading) toast.setAttribute('heading', opts.heading);
    if (opts.message) toast.setAttribute('message', opts.message);
    const dur = opts.duration === undefined ? 5000 : opts.duration;
    if (dur > 0) toast.setAttribute('duration', String(dur));
    this.appendChild(toast);
    this._layout();
    return toast;
  }

  /** Show at most MAX_VISIBLE toasts; queue the rest (hidden). */
  _layout() {
    const toasts = /** @type {LFToast[]} */ (this.$$('lf-toast:not([leaving])'));
    toasts.forEach((t, i) => {
      const wasHidden = t.hidden;
      t.hidden = i >= LFToastRack.MAX_VISIBLE;
      // A queued toast's countdown starts only once it becomes visible.
      if (wasHidden && !t.hidden && typeof t._resume === 'function') t._resume();
    });
  }
}

define('lf-toast', LFToast);
define('lf-toast-rack', LFToastRack);
