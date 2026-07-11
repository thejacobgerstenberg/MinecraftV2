/**
 * Loomfall UI Kit — <lf-modal>
 *
 * Modal dialog: role="dialog" aria-modal, focus trap, Escape close,
 * screen-dim backdrop. Renders sensibly from attributes alone (gallery
 * fragments carry no scripts). Author body content as children:
 *
 *   <lf-modal heading="Delete world?" confirm-label="Delete"
 *             cancel-label="Cancel" danger open>
 *     <p>“Warp Meadow” will be gone for good. This cannot be undone.</p>
 *   </lf-modal>
 *
 * PUBLIC ATTRIBUTES
 * @attr {boolean} open - Present while the dialog is shown. Reflected;
 *   also the `open` JS property. Toggle via open()/close() methods.
 * @attr {string} heading - Dialog title (wired to aria-labelledby).
 * @attr {string} confirm-label - If set, renders a primary confirm button
 *   in the footer (Everthread gold face, void-ink label).
 * @attr {string} cancel-label - If set, renders a secondary Cancel button.
 *   Destructive flows MUST provide this (explicit Cancel — no dead ends).
 * @attr {boolean} danger - Styles the confirm button as destructive:
 *   secondary face + error-colored label WITH frayed-X glyph (shape cue,
 *   never hue alone).
 * @attr {boolean} static - Gallery/demo mode: renders in-flow (no fixed
 *   positioning, no focus stealing, no focus trap). Screenshot-friendly.
 * @attr {boolean} data-demo-hover / data-demo-active - Gallery convention:
 *   forwarded onto the confirm button to demo its hover/pressed state.
 *
 * PUBLIC METHODS
 *   open()  - show the dialog, remember the invoker, focus inside.
 *   close() - hide, restore focus to the invoker.
 *
 * PUBLIC EVENTS
 * @fires lf-close - Cancelable. Emitted when the user tries to dismiss
 *   (Escape, backdrop click, Cancel button). preventDefault() vetoes the
 *   close. detail = { reason: 'escape'|'backdrop'|'cancel'|'api' }.
 * @fires lf-action - Footer button pressed.
 *   detail = { action: 'confirm' | 'cancel' }. Confirm closes the dialog
 *   (uncancelably — the host app already accepted the action).
 *
 * KEYBOARD
 *   Escape → cancelable lf-close (pops exactly this one dialog).
 *   Tab / Shift+Tab cycle within the dialog (focus trap).
 *   Focus returns to the invoking element on close.
 */
import { LFElement, define, uid } from '../lf-core.js';

/** Frayed-X glyph (error/destructive shape cue), stroke = currentColor. */
const FRAYED_X_SVG =
  '<svg class="lf-glyph lf-glyph--frayed-x" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
  '<path d="M4 4 L12 12 M12 4 L4 12"/>' +
  '<path d="M3.2 2.2 L4 4 M12.8 2.2 L12 4 M2.2 12.8 L4 12 M13.8 13.8 L12 12" stroke-width="1.1"/>' +
  '</svg>';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export class LFModal extends LFElement {
  static observedAttributes = ['open', 'heading'];

  /** @returns {boolean} */
  get open() {
    return this.boolAttr('open');
  }

  /** @param {boolean} v */
  set open(v) {
    this.reflectBool('open', !!v);
  }

  render() {
    const bodyChildren = Array.from(this.childNodes);
    const titleId = uid('lf-modal-title');

    const backdrop = document.createElement('div');
    backdrop.className = 'lf-modal__backdrop';
    backdrop.addEventListener('click', () => this._requestClose('backdrop'));

    const dialog = document.createElement('div');
    dialog.className = 'lf-modal__dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.setAttribute('tabindex', '-1');

    const header = document.createElement('header');
    header.className = 'lf-modal__header';
    const title = document.createElement('h2');
    title.className = 'lf-modal__title';
    title.id = titleId;
    header.appendChild(title);
    this._title = title;

    const body = document.createElement('div');
    body.className = 'lf-modal__body';
    bodyChildren.forEach((n) => body.appendChild(n));

    dialog.appendChild(header);
    dialog.appendChild(body);

    const confirmLabel = this.getAttribute('confirm-label');
    const cancelLabel = this.getAttribute('cancel-label');
    if (confirmLabel || cancelLabel) {
      const footer = document.createElement('footer');
      footer.className = 'lf-modal__footer';
      if (cancelLabel) {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'lf-modal__button lf-modal__button--cancel';
        cancel.textContent = cancelLabel;
        cancel.addEventListener('click', () => {
          this.emit('lf-action', { action: 'cancel' });
          this._requestClose('cancel');
        });
        footer.appendChild(cancel);
      }
      if (confirmLabel) {
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = this.boolAttr('danger')
          ? 'lf-modal__button lf-modal__button--danger'
          : 'lf-modal__button lf-modal__button--confirm';
        if (this.boolAttr('danger')) confirm.innerHTML = FRAYED_X_SVG;
        confirm.appendChild(document.createTextNode(confirmLabel));
        confirm.addEventListener('click', () => {
          this.emit('lf-action', { action: 'confirm' });
          this._doClose();
        });
        footer.appendChild(confirm);
        // Gallery demo-state forwarding.
        for (const demo of ['data-demo-hover', 'data-demo-active']) {
          if (this.hasAttribute(demo)) confirm.setAttribute(demo, '');
        }
      }
      dialog.appendChild(footer);
    }

    this.appendChild(backdrop);
    this.appendChild(dialog);
    this._dialog = dialog;

    this._onKeydown = (e) => {
      if (!this.open || this.boolAttr('static')) return;
      if (e.key === 'Escape') {
        e.stopPropagation(); // pop exactly this one level
        this._requestClose('escape');
      } else if (e.key === 'Tab') {
        this._trapTab(e);
      }
    };
    this.addEventListener('keydown', this._onKeydown);
  }

  update() {
    if (this._title) this._title.textContent = this.getAttribute('heading') || '';
    if (this.open && !this._wasOpen) this._afterOpen();
    if (!this.open && this._wasOpen) this._afterClose();
    this._wasOpen = this.open;
  }

  /** Show the dialog (remembers invoker, moves focus inside). */
  show() {
    this.open = true;
  }

  /** Hide the dialog without emitting lf-close (programmatic). */
  close() {
    this._doClose();
  }

  _afterOpen() {
    if (this.boolAttr('static')) return;
    this._invoker = /** @type {HTMLElement|null} */ (document.activeElement);
    const first = this._dialog.querySelector(FOCUSABLE);
    (first instanceof HTMLElement ? first : this._dialog).focus();
  }

  _afterClose() {
    if (this._invoker && this._invoker.isConnected) this._invoker.focus();
    this._invoker = null;
  }

  /** Emit cancelable lf-close; close unless vetoed. @param {string} reason */
  _requestClose(reason) {
    const proceed = this.emit('lf-close', { reason }, { cancelable: true });
    if (proceed) this._doClose();
  }

  _doClose() {
    this.open = false;
  }

  /** Cycle Tab within the dialog. @param {KeyboardEvent} e */
  _trapTab(e) {
    const focusables = Array.from(this._dialog.querySelectorAll(FOCUSABLE)).filter(
      (el) => el instanceof HTMLElement && el.offsetParent !== null
    );
    if (focusables.length === 0) {
      e.preventDefault();
      this._dialog.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === this._dialog)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  disconnectedCallback() {
    this.removeEventListener('keydown', this._onKeydown);
  }
}

define('lf-modal', LFModal);
