/**
 * Loomfall UI Kit — <lf-main-menu>
 *
 * Title screen: LOOMFALL wordmark band over a subtle woven backdrop,
 * splash line, primary button stack (Singleplayer / Multiplayer), a
 * secondary half-row (Settings / Quit), an Accessibility icon button, and
 * the version string in the bottom-left corner. Composes <lf-button>.
 *
 * The wordmark is the saved brand asset (logo/wordmark-dark.svg) inlined
 * with its fills/strokes moved to CSS classes so every color still comes
 * from tokens. The backdrop is brand-anchored (void ink / duskwarp weave)
 * in BOTH themes — the title screen is always a loom-room night scene.
 *
 * Usage:
 *   <lf-main-menu version="0.1.0" splash="Every thread returns!"></lf-main-menu>
 *   menu.addEventListener('lf-action', e => route(e.detail.action));
 *
 * PUBLIC ATTRIBUTES
 * @attr {string} version - Version string for the bottom-left corner.
 *   Default "0.1.0".
 * @attr {string} splash - Optional gold splash line under the wordmark.
 *   Hidden when absent/empty.
 * @attr {boolean} multiplayer-disabled - Renders the Multiplayer button
 *   disabled (dim face, no hover, skipped by Tab).
 * @attr {boolean} static - Gallery/demo mode: renders as a contained
 *   in-flow block instead of pinned full-viewport.
 * @attr {boolean} data-demo-hover / data-demo-active - Gallery convention:
 *   forwarded onto the primary Singleplayer button.
 *
 * PUBLIC EVENTS
 * @fires lf-action - A menu button was pressed (bubbles from lf-button).
 *   detail: { action: 'singleplayer'|'multiplayer'|'settings'|'quit'|'accessibility' }.
 *
 * KEYBOARD — native Tab order through the buttons; each shows the token
 * focus ring via :focus-visible. The title screen is the stack root, so
 * Escape is a no-op here (nothing to pop — no dead ends either way).
 */
import { LFElement, define, uid } from '../lf-core.js';
import '../components/button.js';

/**
 * Saved brand wordmark (uikit-src/logo/wordmark-dark.svg) with color
 * presentation attributes replaced by lf-main-menu__wm-* classes; the
 * actual colors are assigned in main-menu.css from brand tokens.
 */
const WORDMARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 740 240" role="img" aria-label="LOOMFALL" class="lf-main-menu__wm-svg">' +
  '<g class="lf-main-menu__wm-key" fill="none" stroke-linecap="round">' +
  '<circle cx="14" cy="80" r="6" stroke-width="8.75"/>' +
  '<path stroke-width="8.75" d="M17.5 84.3 C22 87 26 88 33 88 H638 C649 88 652.5 97 652 110 C650.5 130 644 146 645.5 168"/>' +
  '<path stroke-width="6.8" d="M645.5 168 C643 184 633 198 621 208"/>' +
  '<path stroke-width="6.8" d="M645.5 168 C646.5 188 645.5 202 641 217"/>' +
  '<path stroke-width="6.8" d="M645.5 168 C650 183 659.5 193.5 669 200"/>' +
  '</g>' +
  '<g class="lf-main-menu__wm-thread" fill="none" stroke-linecap="round">' +
  '<circle cx="14" cy="80" r="6" stroke-width="6.75"/>' +
  '<path stroke-width="6.75" d="M17.5 84.3 C22 87 26 88 33 88 H638 C649 88 652.5 97 652 110 C650.5 130 644 146 645.5 168"/>' +
  '<path stroke-width="4.8" d="M645.5 168 C643 184 633 198 621 208"/>' +
  '<path stroke-width="4.8" d="M645.5 168 C646.5 188 645.5 202 641 217"/>' +
  '<path stroke-width="4.8" d="M645.5 168 C650 183 659.5 193.5 669 200"/>' +
  '</g>' +
  '<g class="lf-main-menu__wm-glyph">' +
  '<path fill-rule="evenodd" d="M24 40 h18 v78 h46 v18 h-64 Z M24 82 h18 v12 h-18 Z"/>' +
  '<path fill-rule="evenodd" d="M98 40 h64 v96 h-64 Z M110 88 L130 60 L150 88 L130 116 Z"/>' +
  '<path fill-rule="evenodd" d="M176 40 h64 v96 h-64 Z M188 88 L208 60 L228 88 L208 116 Z"/>' +
  '<rect x="254" y="40" width="18" height="96"/><rect x="300" y="40" width="18" height="96"/>' +
  '<rect x="254" y="40" width="64" height="18"/><rect x="280" y="40" width="12" height="60"/>' +
  '<rect x="330" y="40" width="18" height="96"/><rect x="330" y="40" width="64" height="18"/>' +
  '<rect x="330" y="80" width="56" height="18"/>' +
  '<rect x="408" y="40" width="18" height="96"/><rect x="454" y="40" width="18" height="96"/>' +
  '<rect x="408" y="40" width="64" height="18"/><rect x="408" y="102" width="64" height="18"/>' +
  '<path fill-rule="evenodd" d="M486 40 h18 v78 h46 v18 h-64 Z M486 82 h18 v12 h-18 Z"/>' +
  '<path d="M564 40 h18 v78 h46 v18 h-64 Z"/>' +
  '</g>' +
  '<path class="lf-main-menu__wm-key" d="M98 88 H162" fill="none" stroke-width="8.75" stroke-linecap="butt"/>' +
  '<path class="lf-main-menu__wm-thread" d="M98 88 H162" fill="none" stroke-width="6.75" stroke-linecap="butt"/>' +
  '<path class="lf-main-menu__wm-glyph" d="M188 88 L195 78.2 L195 97.8 Z M228 88 L221 78.2 L221 97.8 Z"/>' +
  '</svg>';

/** Person icon for the Accessibility entry point (currentColor). */
const PERSON_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="currentColor">' +
  '<circle cx="8" cy="3.6" r="2.2"/>' +
  '<path d="M8 6.6 C5 6.6 3.2 7.6 3.2 8.8 L6.4 9.4 L5.6 14.2 A0.9 0.9 0 0 0 7.3 14.7 L8 11.4 L8.7 14.7 A0.9 0.9 0 0 0 10.4 14.2 L9.6 9.4 L12.8 8.8 C12.8 7.6 11 6.6 8 6.6 Z"/>' +
  '</svg>';

export class LFMainMenu extends LFElement {
  static observedAttributes = ['version', 'splash', 'multiplayer-disabled'];

  render() {
    const titleId = uid('lf-main-menu-title');
    this.setAttribute('role', 'region');
    this.setAttribute('aria-labelledby', titleId);

    const backdrop = document.createElement('div');
    backdrop.className = 'lf-main-menu__backdrop';
    backdrop.setAttribute('aria-hidden', 'true');

    const col = document.createElement('div');
    col.className = 'lf-main-menu__col';

    // Accessible name for the region (the SVG wordmark is decorative here).
    const srTitle = document.createElement('h1');
    srTitle.className = 'lf-visually-hidden';
    srTitle.id = titleId;
    srTitle.textContent = 'Loomfall — Main Menu';

    const band = document.createElement('div');
    band.className = 'lf-main-menu__wordmark';
    band.innerHTML = WORDMARK;
    band.querySelector('svg').setAttribute('aria-hidden', 'true');

    const splash = document.createElement('div');
    splash.className = 'lf-main-menu__splash';
    splash.setAttribute('aria-hidden', 'true');
    this._splash = splash;

    const stack = document.createElement('div');
    stack.className = 'lf-main-menu__stack';

    const single = document.createElement('lf-button');
    single.setAttribute('variant', 'primary');
    single.setAttribute('action', 'singleplayer');
    single.textContent = 'Singleplayer';
    if (this.hasAttribute('data-demo-hover')) single.setAttribute('data-demo-hover', '');
    if (this.hasAttribute('data-demo-active')) single.setAttribute('data-demo-active', '');

    const multi = document.createElement('lf-button');
    multi.setAttribute('variant', 'secondary');
    multi.setAttribute('action', 'multiplayer');
    multi.textContent = 'Multiplayer';
    this._multi = multi;

    const half = document.createElement('div');
    half.className = 'lf-main-menu__row';
    const settings = document.createElement('lf-button');
    settings.setAttribute('variant', 'secondary');
    settings.setAttribute('action', 'settings');
    settings.textContent = 'Settings…';
    const quit = document.createElement('lf-button');
    quit.setAttribute('variant', 'secondary');
    quit.setAttribute('action', 'quit');
    quit.textContent = 'Quit';
    const a11y = document.createElement('lf-button');
    a11y.setAttribute('variant', 'secondary');
    a11y.setAttribute('size', 'icon');
    a11y.setAttribute('action', 'accessibility');
    a11y.setAttribute('aria-label', 'Accessibility settings');
    a11y.innerHTML = PERSON_ICON;
    half.append(settings, quit, a11y);

    stack.append(single, multi, half);

    const version = document.createElement('div');
    version.className = 'lf-main-menu__version lf-text-xs';
    this._version = version;

    col.append(srTitle, band, splash, stack);
    this.append(backdrop, col, version);
  }

  update() {
    const splashText = this.getAttribute('splash') || '';
    this._splash.textContent = splashText;
    this._splash.hidden = splashText === '';
    this._version.textContent = `Loomfall ${this.getAttribute('version') || '0.1.0'}`;
    if (this.hasAttribute('multiplayer-disabled')) this._multi.setAttribute('disabled', '');
    else this._multi.removeAttribute('disabled');
  }
}

define('lf-main-menu', LFMainMenu);
