/**
 * Loomfall UI Kit — <lf-debug-overlay>
 *
 * F3-style debug overlay: two monospace columns of key/value rows on a
 * translucent void-ink strip. Decorative for assistive tech (the whole
 * overlay is aria-hidden — it is a developer readout toggled by a
 * hardware key, not an interactive surface), so text uses the
 * theme-independent dark HUD pair: light text + void-ink shadow over the
 * screen-dim strip in BOTH themes.
 *
 * Usage:
 *   <lf-debug-overlay open data-fps="72" data-biome="Warpwold Meadow"></lf-debug-overlay>
 *   const dbg = document.querySelector('lf-debug-overlay');
 *   dbg.setData({ fps: 68, pos: 'X: 12.5  Y: 64.0  Z: -7.3' });
 *   dbg.toggle();                       // F3 handler
 *   dbg.toggleSection('sys');           // collapse/expand a section
 *
 * PUBLIC ATTRIBUTES
 * @attr {boolean} open - Present while the overlay is shown (F3 on).
 *   Reflected; also the `open` JS property.
 * @attr {boolean} static - Gallery/demo mode: renders in-flow instead of
 *   pinned to the viewport's top-left. Screenshot-friendly.
 * @attr {string} sections - Space/comma-separated list of visible section
 *   ids among "perf", "loc", "sys". Omit the attribute to show all.
 * @attr {string} data-<key> - Initial value for any row key (fps, pos,
 *   chunk, dim, biome, facing, light, tris, calls, chunks, mem, renderer,
 *   display), so script-free fragments can seed realistic values.
 *
 * PUBLIC METHODS
 *   toggle()             - flip the open state (F3).
 *   setVisible(bool)     - set the open state.
 *   setData(partial)     - merge row values, e.g. { fps: 60, biome: '…' }.
 *   toggleSection(id)    - show/hide one section ("perf" | "loc" | "sys").
 *
 * PUBLIC EVENTS — none (read-only overlay).
 */
import { LFElement, define } from '../lf-core.js';

/** Section model: id, title, column, [key, label] rows. */
const SECTIONS = [
  {
    id: 'perf',
    title: 'Performance',
    col: 'left',
    rows: [
      ['fps', 'FPS'],
      ['tris', 'Tris'],
      ['calls', 'Draw calls'],
      ['chunks', 'Chunks'],
    ],
  },
  {
    id: 'loc',
    title: 'Location',
    col: 'left',
    rows: [
      ['pos', 'XYZ'],
      ['chunk', 'Chunk'],
      ['facing', 'Facing'],
      ['biome', 'Biome'],
      ['dim', 'Dimension'],
      ['light', 'Light'],
    ],
  },
  {
    id: 'sys',
    title: 'System',
    col: 'right',
    rows: [
      ['mem', 'Mem'],
      ['renderer', 'Renderer'],
      ['display', 'Display'],
    ],
  },
];

/** Demo-friendly defaults (overridable via data-* attributes / setData). */
const DEFAULTS = {
  fps: '60 (16.6 ms)',
  tris: '182,404',
  calls: '96',
  chunks: '289 / 361',
  pos: 'X: 12.500  Y: 64.000  Z: -7.250',
  chunk: '0 4 -1 in 0 -1',
  facing: 'north (Towards -Z) (2.4 / -12.0)',
  biome: 'loomfall:warpwold_meadow',
  dim: 'loomfall:warpwold',
  light: '15 (15 sky, 0 block)',
  mem: '412 / 2048 MB',
  renderer: 'WebGL2 — ANGLE',
  display: '1920x1080 (S=4)',
};

export class LFDebugOverlay extends LFElement {
  static observedAttributes = ['open', 'sections'];

  render() {
    this.setAttribute('aria-hidden', 'true');

    /** @type {Record<string, string>} current row values */
    this._data = { ...DEFAULTS };
    // Seed from data-* attributes so fragments can author values.
    for (const key of Object.keys(DEFAULTS)) {
      if (this.dataset[key] !== undefined) this._data[key] = this.dataset[key];
    }

    /** @type {Record<string, HTMLElement>} row value spans by key */
    this._vals = {};
    /** @type {Record<string, HTMLElement>} section wrappers by id */
    this._secs = {};

    const cols = { left: null, right: null };
    for (const side of ['left', 'right']) {
      const col = document.createElement('div');
      col.className = 'lf-debug-overlay__col';
      cols[side] = col;
    }

    const title = document.createElement('div');
    title.className = 'lf-debug-overlay__title';
    title.textContent = 'Loomfall 0.1.0 [debug]';
    cols.left.appendChild(title);

    for (const sec of SECTIONS) {
      const wrap = document.createElement('div');
      wrap.className = 'lf-debug-overlay__section';
      wrap.dataset.section = sec.id;

      const head = document.createElement('div');
      head.className = 'lf-debug-overlay__section-title';
      head.textContent = sec.title;
      wrap.appendChild(head);

      for (const [key, label] of sec.rows) {
        const row = document.createElement('div');
        row.className = 'lf-debug-overlay__row';
        const k = document.createElement('span');
        k.className = 'lf-debug-overlay__key';
        k.textContent = label;
        const v = document.createElement('span');
        v.className = 'lf-debug-overlay__val';
        row.append(k, v);
        wrap.appendChild(row);
        this._vals[key] = v;
      }

      this._secs[sec.id] = wrap;
      cols[sec.col].appendChild(wrap);
    }

    this.append(cols.left, cols.right);
  }

  update() {
    // Row values.
    for (const [key, span] of Object.entries(this._vals)) {
      span.textContent = this._data[key] ?? '';
    }
    // Section visibility from the `sections` attribute (absent = all).
    const attr = this.getAttribute('sections');
    const visible = attr === null ? null : attr.split(/[\s,]+/).filter(Boolean);
    for (const [id, wrap] of Object.entries(this._secs)) {
      wrap.hidden = visible !== null && !visible.includes(id);
    }
  }

  /** @type {boolean} overlay visibility (F3 state). */
  get open() {
    return this.boolAttr('open');
  }
  set open(v) {
    this.reflectBool('open', !!v);
  }

  /** Flip visibility (wire to the F3 key). */
  toggle() {
    this.open = !this.open;
  }

  /** @param {boolean} v */
  setVisible(v) {
    this.open = !!v;
  }

  /**
   * Merge new row values into the readout.
   * @param {Partial<Record<'fps'|'tris'|'calls'|'chunks'|'pos'|'chunk'|'facing'|'biome'|'dim'|'light'|'mem'|'renderer'|'display', string|number>>} partial
   */
  setData(partial) {
    for (const [k, v] of Object.entries(partial || {})) {
      this._data[k] = String(v);
    }
    this.update();
  }

  /**
   * Show/hide one section by id ("perf" | "loc" | "sys").
   * @param {string} id
   */
  toggleSection(id) {
    if (!this._secs[id]) return;
    const attr = this.getAttribute('sections');
    let visible =
      attr === null
        ? SECTIONS.map((s) => s.id)
        : attr.split(/[\s,]+/).filter(Boolean);
    visible = visible.includes(id) ? visible.filter((s) => s !== id) : [...visible, id];
    this.setAttribute('sections', visible.join(' '));
  }
}

define('lf-debug-overlay', LFDebugOverlay);
