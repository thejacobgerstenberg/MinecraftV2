/**
 * Loomfall UX — <lf-captions> sound-caption (subtitle) overlay.
 *
 * A fixed-position caption region that subtitles audio-engine events for
 * deaf/hard-of-hearing players (and anyone playing muted). It consumes the
 * canonical window event from the architecture contract §4:
 *
 *   window event "lf-audio-event"
 *     detail: {
 *       name:      string   — exact engine key ("mob.groaner.hurt") or the
 *                             shell pseudo-key "music.<mode>",
 *       direction?: "left"|"right"|"behind"|"front"|null,
 *       volume?:   number   — 0..1; volume === 0 is skipped entirely,
 *       category?: string   — advisory only; captions.json is authoritative,
 *       loop?:     boolean  — true for loop handles (wind/cave/rain/music):
 *                             the caption stays until the matching
 *                             { name, ended:true } event arrives, then
 *                             lingers durationMs before fading,
 *                       ended?: boolean — loop handle stopped.
 *     }
 *
 * Caption text/priority/category come from a caption table conforming to
 * ux/schemas/captions.schema.json (see ./captions.json). Wildcard patterns
 * ('step.*', 'mob.*.hurt') replace exactly one dot-segment; resolution picks
 * the entry with the most literal segments, ties go to the later array entry.
 * {material} / {mob} placeholders are filled from the matched wildcard
 * segments via the DISPLAY_NAMES map (capitalized fallback).
 *
 * PUBLIC ATTRIBUTES
 * @attr {'bottom-left'|'bottom-right'|'top-left'|'top-right'} corner -
 *   Which viewport corner the region docks to (default "bottom-left").
 * @attr {number} max-lines - Visible line budget (default 3, clamped 1..6).
 *   When full, lower-priority lines are evicted first; equal priority evicts
 *   the oldest. A new caption with lower priority than every visible line is
 *   dropped.
 *
 * PUBLIC PROPERTIES
 * @prop {object|Array} captions - The caption table: either the full
 *   {version, captions:[...]} document or just the array. Assign before (or
 *   after) connect; events arriving with no table loaded are ignored.
 *
 * PUBLIC METHODS
 *   handleAudioEvent(detail) - Feed one lf-audio-event detail directly
 *     (the window listener calls this; exposed for tests/manual driving).
 *   clear() - Remove all visible captions immediately.
 *
 * PUBLIC EVENTS
 * @fires lf-show - A caption line appeared or was refreshed.
 *   detail = { sound, text, category, direction, priority, refreshed }.
 * @fires lf-dismiss - A caption line went away.
 *   detail = { sound, reason: 'timeout'|'evicted'|'api' }.
 *
 * ACCESSIBILITY
 *  - The visible list is aria-hidden; a visually-hidden polite live region
 *    mirrors every caption (with a spoken direction suffix: ", to the left")
 *    so screen readers announce exactly what sighted players read.
 *  - Category is never hue-only: every line carries a category glyph
 *    (ambient=wind-waves, mob=pawprint, action=pick, music=note,
 *    alert=fray-knot triangle) and alert lines add a bold weight + warn hem.
 *  - Direction is shape-carried too: chevrons ◀ ▶ ▼ ▲ plus screen-edge
 *    alignment per ux/captions/DIRECTIONAL.md.
 *  - Fades collapse under prefers-reduced-motion and the forced override
 *    html[data-lf-reduced-motion="on"] (and JS removal follows suit).
 *
 * The overlay is pointer-transparent and renders at the HUD z-layer (below
 * toasts). Per contract §5 the options screen unmounts this element entirely
 * when subtitles=false — the element itself does not read options storage.
 */
import { LFElement, define, clamp } from '../../ui-kit/lf-core.js';

/** Corner attribute values (default first). */
const CORNERS = ['bottom-left', 'bottom-right', 'top-left', 'top-right'];

/**
 * Display names for wildcard-captured segments, used to fill {material} and
 * {mob} placeholders. Materials are the 11 engine material segments; mob
 * segments are the 5 engine voice archetypes plus the reserved boss ids
 * (naming.json canon: "Molthkin, the First Bobbin", "The Last Needle").
 * Anything absent falls back to simple capitalization.
 * @type {Record<string,string>}
 */
export const DISPLAY_NAMES = {
  stone: 'Stone', wood: 'Wood', dirt: 'Dirt', grass: 'Grass', sand: 'Sand',
  glass: 'Glass', leaves: 'Leaves', gravel: 'Gravel', snow: 'Snow',
  metal: 'Metal', wool: 'Wool',
  grazer: 'Grazer', groaner: 'Groaner', exploder: 'Exploder',
  screecher: 'Screecher', trader: 'Trader',
  molthkin: 'Molthkin', lastneedle: 'The Last Needle',
};

/** Direction glyph + spoken suffix per contract direction values. */
const DIRECTIONS = {
  left: { glyph: '◀', spoken: 'to the left' },      /* ◀ */
  right: { glyph: '▶', spoken: 'to the right' },    /* ▶ */
  behind: { glyph: '▼', spoken: 'behind you' },     /* ▼ */
  front: { glyph: '▲', spoken: 'ahead' },           /* ▲ */
};

/**
 * Category glyphs — inline SVG, currentColor only, one distinct SHAPE per
 * category so color is never the only cue. alert reuses the kit's fray-knot
 * triangle (same shape lf-toast uses for warn).
 * @type {Record<string,string>}
 */
const CATEGORY_GLYPHS = {
  /* Wind-waves — ambient beds (wind, cave, rain, splash). */
  ambient:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
    '<path d="M2 4.6 q2 -2 4 0 t4 0 t4 0"/>' +
    '<path d="M2 8.4 q2 -2 4 0 t4 0 t4 0"/>' +
    '<path d="M2 12.2 q2 -2 4 0 t4 0"/>' +
    '</svg>',
  /* Pawprint — creature voices. */
  mob:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">' +
    '<circle cx="3.9" cy="6.1" r="1.5"/><circle cx="8" cy="4.4" r="1.5"/><circle cx="12.1" cy="6.1" r="1.5"/>' +
    '<path d="M8 7.6 c-2.7 0 -4.5 1.9 -4.5 3.8 c0 1.2 0.9 2 2.1 2 c0.9 0 1.5 -0.6 2.4 -0.6 c0.9 0 1.5 0.6 2.4 0.6 c1.2 0 2.1 -0.8 2.1 -2 C12.5 9.5 10.7 7.6 8 7.6 Z"/>' +
    '</svg>',
  /* Pick — player-caused actions (break/place/step/ui/doors/eat...). */
  action:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
    '<path d="M3 13 L9.6 6.4"/>' +
    '<path d="M6.2 2.6 a8 8 0 0 1 7.2 7.2"/>' +
    '<path d="M8.4 5.2 L10.8 7.6"/>' +
    '</svg>',
  /* Eighth-note — music.<mode> pseudo-keys. */
  music:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor" stroke="none">' +
    '<path d="M6.1 12.4 V3.6 L12.5 2.2 V10.9 H11.1 V4.9 L7.5 5.7 V12.4 Z"/>' +
    '<ellipse cx="5" cy="12.4" rx="1.9" ry="1.5"/><ellipse cx="11.4" cy="10.9" rx="1.9" ry="1.5"/>' +
    '</svg>',
  /* Fray-knot triangle — danger-relevant (thunder, explosion, hurt...). */
  alert:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M8 2.2 L14.6 13.4 H1.4 Z"/>' +
    '<path d="M8 2.2 L6.9 0.9 M8 2.2 L9.2 1" stroke-width="1"/>' +
    '<path d="M8 6.2 v3.2" stroke-width="1.8"/>' +
    '<path d="M8 11.6 v0.01" stroke-width="2.2"/>' +
    '</svg>',
};

/** Schema defaults (captions.schema.json). */
const DEFAULT_PRIORITY = 5;
const DEFAULT_DURATION_MS = 3000;

/**
 * Match a sound name against a caption table (schema resolution rules:
 * '*' replaces exactly one dot-segment; most literal segments wins; on a
 * tie the LATER array entry wins). Exported for tests.
 * @param {string} name - engine key, e.g. "mob.exploder.idle".
 * @param {Array<{sound:string}>} table - caption entries in author order.
 * @returns {{entry: object, captured: string[]}|null} the winning entry and
 *   the name segments each '*' captured (in order), or null when uncaptioned.
 */
export function matchCaption(name, table) {
  if (!name || !Array.isArray(table)) return null;
  const segs = String(name).split('.');
  let best = null;
  for (let i = 0; i < table.length; i++) {
    const pat = String(table[i].sound).split('.');
    if (pat.length !== segs.length) continue;
    let literals = 0;
    let ok = true;
    const captured = [];
    for (let s = 0; s < pat.length; s++) {
      if (pat[s] === '*') captured.push(segs[s]);
      else if (pat[s] === segs[s]) literals++;
      else { ok = false; break; }
    }
    if (!ok) continue;
    if (!best || literals >= best.literals) best = { literals, entry: table[i], captured };
  }
  return best ? { entry: best.entry, captured: best.captured } : null;
}

/** Segments whose display names are proper nouns (never lowercased). */
const PROPER_SEGMENTS = new Set(['molthkin', 'lastneedle']);

/**
 * Fill {material}/{mob} placeholders from captured wildcard segments (each
 * placeholder consumes the next captured segment, in order). Sentence-initial
 * placeholders are capitalized ("Stone breaks"); mid-sentence ones lowercase
 * unless the display name is a proper noun ("Footsteps on grass", but
 * "…The Last Needle…"). Exported for tests.
 * @param {string} text @param {string[]} captured @returns {string}
 */
export function fillPlaceholders(text, captured) {
  let i = 0;
  return text.replace(/\{(material|mob)\}/g, (_m, _kind, offset) => {
    const seg = captured[i++];
    if (!seg) return '';
    let name = DISPLAY_NAMES[seg] || seg.charAt(0).toUpperCase() + seg.slice(1);
    if (offset > 0 && !PROPER_SEGMENTS.has(seg)) {
      name = name.charAt(0).toLowerCase() + name.slice(1);
    }
    return name;
  });
}

export class LFCaptions extends LFElement {
  static observedAttributes = ['corner', 'max-lines'];

  constructor() {
    super();
    /** @type {Array<object>} caption table (schema entries). */
    this._table = null;
    /** @type {Map<string, object>} sound name -> live line record. */
    this._lines = new Map();
    this._onAudioEvent = (e) => this.handleAudioEvent(e.detail);
  }

  /** @returns {'bottom-left'|'bottom-right'|'top-left'|'top-right'} */
  get corner() {
    const c = this.getAttribute('corner');
    return /** @type {*} */ (CORNERS.includes(c) ? c : CORNERS[0]);
  }

  /** @returns {number} visible line budget (1..6, default 3). */
  get maxLines() {
    const n = parseInt(this.getAttribute('max-lines') || '3', 10);
    return clamp(Number.isFinite(n) ? n : 3, 1, 6);
  }

  /** @param {object|Array} doc - {version,captions:[...]} or the array. */
  set captions(doc) {
    this._table = Array.isArray(doc) ? doc : (doc && Array.isArray(doc.captions) ? doc.captions : null);
  }

  /** @returns {Array|null} the active caption table (entry array). */
  get captions() {
    return this._table;
  }

  render() {
    this.setAttribute('aria-hidden', 'false');
    const list = document.createElement('ol');
    list.className = 'lf-captions__list';
    list.setAttribute('aria-hidden', 'true'); // mirrored by the live region
    this._list = list;

    const live = document.createElement('div');
    live.className = 'lf-visually-hidden lf-captions__live';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-label', 'Sound captions');
    this._live = live;

    this.appendChild(list);
    this.appendChild(live);
  }

  update() {
    // Corner is CSS-driven via the attribute; normalize an invalid value.
    if (this.hasAttribute('corner') && !CORNERS.includes(this.getAttribute('corner'))) {
      this.setAttribute('corner', CORNERS[0]);
    }
    this._enforceBudget(null);
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('lf-audio-event', this._onAudioEvent);
  }

  disconnectedCallback() {
    window.removeEventListener('lf-audio-event', this._onAudioEvent);
    this.clear();
  }

  /** True when fades should be skipped (forced override wins over media). */
  _reducedMotion() {
    const forced = document.documentElement.getAttribute('data-lf-reduced-motion');
    if (forced === 'on') return true;
    if (forced === 'off') return false;
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /**
   * Feed one lf-audio-event detail (see module JSDoc for the shape).
   * @param {{name:string, direction?:string|null, volume?:number,
   *          loop?:boolean, ended?:boolean}} detail
   */
  handleAudioEvent(detail) {
    if (!detail || !detail.name || !this._table) return;
    if (detail.volume === 0) return; // silent play — nothing to caption

    const name = String(detail.name);

    // Loop handle stopped: begin the linger countdown on its sticky line.
    if (detail.ended) {
      const rec = this._lines.get(name);
      if (rec) {
        rec.loop = false;
        this._armTimer(rec);
      }
      return;
    }

    const match = matchCaption(name, this._table);
    if (!match) return; // uncaptioned sounds are silently ignored (schema)

    const entry = match.entry;
    const text = fillPlaceholders(entry.text, match.captured);
    const priority = entry.priority === undefined ? DEFAULT_PRIORITY : entry.priority;
    const durationMs = entry.durationMs === undefined ? DEFAULT_DURATION_MS : entry.durationMs;
    const direction = entry.directional && detail.direction && DIRECTIONS[detail.direction]
      ? detail.direction : null;

    // Same sound already visible: refresh in place (re-arm timer, update
    // direction/text) instead of stacking duplicate lines.
    const existing = this._lines.get(name);
    if (existing) {
      existing.priority = priority;
      existing.durationMs = durationMs;
      existing.loop = !!detail.loop;
      this._renderLine(existing, text, entry.category, direction);
      this._armTimer(existing);
      this._announce(text, direction);
      this.emit('lf-show', { sound: name, text, category: entry.category, direction, priority, refreshed: true });
      return;
    }

    // Line budget: evict the lowest-priority (oldest among equals) line if
    // the newcomer outranks or matches it; otherwise drop the newcomer.
    if (!this._enforceBudget(priority)) return;

    const li = document.createElement('li');
    li.className = 'lf-captions__line';
    const rec = {
      sound: name, el: li, priority, durationMs,
      loop: !!detail.loop, timer: 0, shownAt: Date.now(),
    };
    this._lines.set(name, rec);
    this._renderLine(rec, text, entry.category, direction);
    this._list.appendChild(li);
    this._armTimer(rec);
    this._announce(text, direction);
    this.emit('lf-show', { sound: name, text, category: entry.category, direction, priority, refreshed: false });
  }

  /** Remove all captions immediately. */
  clear() {
    for (const rec of this._lines.values()) {
      if (rec.timer) clearTimeout(rec.timer);
      rec.el.remove();
    }
    const had = this._lines.size > 0;
    this._lines.clear();
    if (had) this.emit('lf-dismiss', { sound: null, reason: 'api' });
  }

  /**
   * Make room for a new caption of the given priority (or just trim overflow
   * when priority is null). @returns {boolean} whether the newcomer may show.
   */
  _enforceBudget(priority) {
    const max = this.maxLines;
    while (this._lines.size >= (priority === null ? max + 1 : max)) {
      let lowest = null;
      for (const rec of this._lines.values()) {
        if (!lowest || rec.priority < lowest.priority ||
            (rec.priority === lowest.priority && rec.shownAt < lowest.shownAt)) {
          lowest = rec;
        }
      }
      if (!lowest) return true;
      if (priority !== null && lowest.priority > priority) return false; // newcomer loses
      this._removeLine(lowest, 'evicted');
    }
    return true;
  }

  /** Build/refresh a line's DOM: glyph + edge chevrons + text. */
  _renderLine(rec, text, category, direction) {
    const el = rec.el;
    el.dataset.category = category;
    if (direction) el.dataset.direction = direction;
    else delete el.dataset.direction;
    const chevron = direction ? DIRECTIONS[direction].glyph : '';
    // Behind/front wrap the line in chevrons on both edges (DIRECTIONAL.md);
    // left leads, right trails.
    const lead = direction === 'left' || direction === 'behind' || direction === 'front' ? chevron : '';
    const trail = direction === 'right' || direction === 'behind' || direction === 'front' ? chevron : '';
    el.innerHTML = '';
    const icon = document.createElement('span');
    icon.className = 'lf-captions__icon';
    icon.innerHTML = CATEGORY_GLYPHS[category] || CATEGORY_GLYPHS.action;
    const mkDir = (g, side) => {
      const s = document.createElement('span');
      s.className = `lf-captions__dir lf-captions__dir--${side}`;
      s.setAttribute('aria-hidden', 'true');
      s.textContent = g;
      return s;
    };
    const body = document.createElement('span');
    body.className = 'lf-captions__text';
    body.textContent = text;
    el.appendChild(icon);
    if (lead) el.appendChild(mkDir(lead, 'lead'));
    el.appendChild(body);
    if (trail) el.appendChild(mkDir(trail, 'trail'));
  }

  /** (Re)start a line's expiry countdown; loops stay sticky until ended. */
  _armTimer(rec) {
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = 0; }
    if (rec.loop) return; // sticky while the loop handle is alive
    rec.timer = setTimeout(() => this._removeLine(rec, 'timeout'), rec.durationMs);
  }

  /** Fade out and remove one line record. */
  _removeLine(rec, reason) {
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = 0; }
    if (!this._lines.delete(rec.sound)) return;
    this.emit('lf-dismiss', { sound: rec.sound, reason });
    const el = rec.el;
    const remove = () => el.remove();
    if (this._reducedMotion()) { remove(); return; }
    el.setAttribute('leaving', '');
    el.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, 400); // fallback if the transition never fires
  }

  /** Mirror a caption into the polite live region for screen readers. */
  _announce(text, direction) {
    const suffix = direction ? `, ${DIRECTIONS[direction].spoken}` : '';
    // Replacing textContent re-announces in polite live regions.
    this._live.textContent = `${text}${suffix}`;
  }
}

define('lf-captions', LFCaptions);
