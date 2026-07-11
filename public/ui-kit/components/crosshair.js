/**
 * Loomfall UI Kit — <lf-crosshair>
 *
 * Pure-SVG crosshair set. Decorative (aria-hidden); uses
 * mix-blend-mode: difference so it stays visible over any world pixel.
 *
 * Usage:
 *   <lf-crosshair variant="cross"></lf-crosshair>
 *   <lf-crosshair variant="dot" fixed></lf-crosshair>   (game mode: centered)
 *   <lf-crosshair variant="circle" hidden></lf-crosshair> (GUI open / F1)
 *
 * @attr {("cross"|"dot"|"circle"|"tee"|"chevron")} variant - Shape.
 *   Default "cross".
 *     cross   — classic 4-arm reticle
 *     dot     — center point only (minimal)
 *     circle  — ring + center dot
 *     tee     — inverted-T (bottom-weighted, for bows/throwables)
 *     chevron — upward chevron with center gap
 * @attr {boolean} fixed - Position fixed at exact viewport center at the HUD
 *   z-layer (game mode). Without it the element flows inline (galleries).
 * @attr {boolean} hidden - Native hidden; the shell sets it while any GUI
 *   screen is open, in spectator mode, or when F1 hides the HUD.
 *
 * @fires (none) - Display-only component; never interactive, never focusable.
 */
import { LFElement, define } from '../lf-core.js';

/** viewBox 0 0 24 24, stroke currentColor, crisp 2px arms. */
const VARIANTS = {
  cross:
    '<path d="M12 3 V9 M12 15 V21 M3 12 H9 M15 12 H21" stroke-width="2"/>',
  dot:
    '<circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>',
  circle:
    '<circle cx="12" cy="12" r="7" stroke-width="2" fill="none"/>' +
    '<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  tee:
    '<path d="M12 12 V21 M3 12 H9 M15 12 H21" stroke-width="2"/>',
  chevron:
    '<path d="M5 16 L12 9 L19 16" stroke-width="2" fill="none"/>' +
    '<circle cx="12" cy="13.5" r="1.2" fill="currentColor" stroke="none"/>',
};

export class LFCrosshair extends LFElement {
  static observedAttributes = ['variant'];

  render() {
    this.setAttribute('aria-hidden', 'true');
    this._svgHost = document.createElement('span');
    this._svgHost.className = 'lf-crosshair__glyph';
    this.appendChild(this._svgHost);
  }

  update() {
    const variant = this.variant;
    this._svgHost.innerHTML =
      '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" ' +
      'stroke="currentColor" stroke-linecap="butt">' +
      (VARIANTS[variant] || VARIANTS.cross) +
      '</svg>';
  }

  /** @type {string} */
  get variant() {
    const v = this.getAttribute('variant');
    return v && VARIANTS[v] ? v : 'cross';
  }
  set variant(v) {
    this.setAttribute('variant', v);
  }
}

define('lf-crosshair', LFCrosshair);
