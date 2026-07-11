/**
 * Loomfall UI Kit — <lf-tooltip>
 *
 * Tooltip wrapper. Wrap the trigger element; the tip text comes from the
 * `text` attribute. Shows on BOTH hover and keyboard focus (never
 * hover-only information), dismisses on Escape. The bubble is a dark
 * loom-room card in BOTH themes (bg-tooltip / tooltip-text tokens).
 *
 *   <lf-tooltip text="Restores 4 hunger" placement="top">
 *     <button type="button">Warp bread</button>
 *   </lf-tooltip>
 *
 * PUBLIC ATTRIBUTES
 * @attr {string} text - Tooltip content (plain text). Reactive.
 * @attr {'top'|'bottom'|'left'|'right'} placement - Bubble position
 *   relative to the trigger (default "top").
 * @attr {boolean} open - Present while the bubble is visible. Reflected;
 *   set it in markup to demo the bubble in static galleries.
 *
 * PUBLIC EVENTS
 * @fires lf-open - Bubble became visible.
 * @fires lf-close - Bubble hidden (mouse-out, blur, or Escape).
 *
 * A11Y
 *   Bubble has role="tooltip"; the trigger (first element child) gets
 *   aria-describedby pointing at it. Escape hides the bubble without
 *   popping any screen (stopPropagation only when a tooltip was open).
 *   Never place interactive content inside the tip.
 */
import { LFElement, define, uid } from '../lf-core.js';

export class LFTooltip extends LFElement {
  static observedAttributes = ['text', 'placement', 'open'];

  /** @returns {boolean} */
  get open() {
    return this.boolAttr('open');
  }

  /** @param {boolean} v */
  set open(v) {
    this.reflectBool('open', !!v);
  }

  render() {
    const bubble = document.createElement('div');
    bubble.className = 'lf-tooltip__bubble';
    bubble.id = uid('lf-tooltip');
    bubble.setAttribute('role', 'tooltip');
    this.appendChild(bubble);
    this._bubble = bubble;

    const trigger = /** @type {HTMLElement|null} */ (
      Array.from(this.children).find((el) => el !== bubble)
    );
    if (trigger) trigger.setAttribute('aria-describedby', bubble.id);

    // Static-pin convention (matches lf-modal's [static]): an [open] that was
    // AUTHORED in markup — present before any interaction — pins the bubble
    // for screenshot galleries, so hover/focus passes never auto-hide it.
    // Escape still dismisses explicitly (and clears the pin).
    this._pinned = this.open;

    this.addEventListener('mouseenter', () => this._show());
    this.addEventListener('mouseleave', () => this._hide());
    this.addEventListener('focusin', () => this._show());
    this.addEventListener('focusout', () => this._hide());
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) {
        e.stopPropagation(); // dismiss the tip only; do not pop screens
        this._pinned = false;
        this._hide();
      }
    });
  }

  _show() {
    if (!this.open) {
      this.open = true;
      this.emit('lf-open');
    }
  }

  _hide() {
    if (this._pinned) return; // authored-open demo tooltips stay pinned
    if (this.open) {
      this.open = false;
      this.emit('lf-close');
    }
  }

  update() {
    if (!this._bubble) return;
    this._bubble.textContent = this.getAttribute('text') || '';
  }
}

define('lf-tooltip', LFTooltip);
