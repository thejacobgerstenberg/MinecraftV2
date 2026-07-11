/**
 * Loomfall UI Kit — <lf-settings-shell>
 *
 * Settings screen frame: a vertical category rail (WAI-ARIA vertical
 * tablist) on the left and a content pane on the right that authored
 * panels dock into. Panels are declared as children; each becomes a
 * role="tabpanel" reachable from its rail tab:
 *
 *   <lf-settings-shell heading="Settings" active="graphics">
 *     <section data-category="Graphics">
 *       <lf-slider label="Render Distance" min="2" max="12" value="6"></lf-slider>
 *       <lf-toggle label="Menu Blur" checked></lf-toggle>
 *       <lf-dropdown label="Quality" value="fancy">…</lf-dropdown>
 *     </section>
 *     <section data-category="Audio">…</section>
 *   </lf-settings-shell>
 *
 * Composes builder A's lf-slider / lf-toggle / lf-dropdown / lf-button
 * (imported for side-effect registration — never reimplemented), so
 * script-free fragments render fully wired panels.
 *
 * PUBLIC ATTRIBUTES
 * @attr {string} heading - Screen title. Default "Settings".
 * @attr {string} active - Slug of the active category (lowercased
 *   data-category, spaces → "-", e.g. "graphics"). Defaults to the first
 *   panel. Reflected; also the `active` JS property.
 *
 * AUTHORED CHILDREN
 *   <section data-category="Name"> — one per category. Contents are the
 *   panel body (typically a stack of builder-A widgets, each carrying its
 *   own visible label).
 *
 * PUBLIC EVENTS
 * @fires lf-select - Category changed. detail: { value: slug, index }.
 * @fires lf-change - Bubbles up untouched from the composed widgets
 *   (detail: { value }) so a host app can persist settings generically.
 * @fires lf-back - Done button or Escape: pop exactly ONE screen level
 *   (returns to whichever screen pushed Settings — Title or Pause).
 *
 * KEYBOARD
 *   Rail: ArrowUp/ArrowDown rove (manual activation), Home/End jump,
 *   Enter/Space activates the focused category. Escape emits lf-back
 *   (open dropdowns swallow their own Escape first). Selected tab shows
 *   a 2px gold edge marker (shape cue, not color-only).
 */
import { LFElement, define, uid, RovingTabindex } from '../lf-core.js';
import '../components/button.js';
import '../components/slider.js';
import '../components/toggle.js';
import '../components/dropdown.js';

/** @param {string} s @returns {string} slug for ids/attrs */
function slugify(s) {
  return s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

export class LFSettingsShell extends LFElement {
  static observedAttributes = ['heading', 'active'];

  render() {
    const headingId = uid('lf-settings-heading');
    this.setAttribute('role', 'region');
    this.setAttribute('aria-labelledby', headingId);

    // Consume authored category panels.
    const sections = this.$$(':scope > section[data-category]');

    const frame = document.createElement('div');
    frame.className = 'lf-settings-shell__frame';

    const heading = document.createElement('h2');
    heading.className = 'lf-settings-shell__heading lf-h2';
    heading.id = headingId;
    this._heading = heading;

    const body = document.createElement('div');
    body.className = 'lf-settings-shell__body';

    const rail = document.createElement('div');
    rail.className = 'lf-settings-shell__rail';
    rail.setAttribute('role', 'tablist');
    rail.setAttribute('aria-orientation', 'vertical');
    rail.setAttribute('aria-label', 'Settings categories');

    const pane = document.createElement('div');
    pane.className = 'lf-settings-shell__pane lf-scroll-y';

    /** @type {{slug: string, tab: HTMLButtonElement, panel: HTMLElement}[]} */
    this._cats = [];
    for (const section of sections) {
      const name = section.dataset.category;
      const slug = slugify(name);
      const tabId = uid('lf-settings-tab');
      const panelId = uid('lf-settings-panel');

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'lf-settings-shell__tab';
      tab.id = tabId;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panelId);
      tab.dataset.slug = slug;
      tab.textContent = name;
      tab.addEventListener('click', () => this._activate(slug));
      rail.appendChild(tab);

      section.className = 'lf-settings-shell__panel';
      section.id = panelId;
      section.setAttribute('role', 'tabpanel');
      section.setAttribute('aria-labelledby', tabId);
      section.setAttribute('tabindex', '0');
      pane.appendChild(section);

      this._cats.push({ slug, tab, panel: section });
    }

    const footer = document.createElement('div');
    footer.className = 'lf-settings-shell__footer';
    const done = document.createElement('lf-button');
    done.setAttribute('variant', 'primary');
    done.setAttribute('action', 'done');
    done.textContent = 'Done';
    done.addEventListener('lf-action', (e) => {
      e.stopPropagation();
      this.emit('lf-back', { from: 'settings-shell' });
    });
    footer.appendChild(done);

    body.append(rail, pane);
    frame.append(heading, body, footer);
    this.appendChild(frame);

    this._rove = new RovingTabindex(rail, {
      selector: '.lf-settings-shell__tab',
      orientation: 'vertical',
      wrap: true,
      onActivate: (tab) => this._activate(tab.dataset.slug),
    });

    // Escape pops exactly one level (open dropdowns/modals stopPropagation
    // their own Escape before it reaches us).
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.emit('lf-back', { from: 'settings-shell' });
      }
    });
  }

  update() {
    this._heading.textContent = this.getAttribute('heading') || 'Settings';
    if (this._cats.length === 0) return;
    const want = this.getAttribute('active');
    const idx = Math.max(0, this._cats.findIndex((c) => c.slug === want));
    this._cats.forEach((c, i) => {
      const on = i === idx;
      c.tab.setAttribute('aria-selected', on ? 'true' : 'false');
      c.panel.hidden = !on;
    });
  }

  /** @type {string} slug of the active category. */
  get active() {
    return this.getAttribute('active') || (this._cats[0] ? this._cats[0].slug : '');
  }
  set active(v) {
    this.setAttribute('active', v);
  }

  /** Activate a category by slug (user action → lf-select). */
  _activate(slug) {
    if (this.active === slug) return;
    this.active = slug;
    const index = this._cats.findIndex((c) => c.slug === slug);
    this.emit('lf-select', { value: slug, index });
  }
}

define('lf-settings-shell', LFSettingsShell);
