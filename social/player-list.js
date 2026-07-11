// social/player-list.js
// <lf-player-list>: the hold-Tab roster overlay listing every player with a
// swatch chip, name, dimension badge, ping meter, and optional team dot.

import { LFElement, define } from "./vendor/ui-kit/lf-core.js";
import { dimDisplayName } from "./presence.js";

/* -------------------------------------------------------------------------- */
/* Local helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Nameplate/team colors, kept in sync with the shared design context. */
const TEAM_COLORS = {
  self: "#F2C14E", // brand gold
  a: "#5F8A46",
  b: "#B03A52",
  neutral: "#6A5F8C",
};

/**
 * Classify a ping (ms) into a color ramp bucket.
 * @param {number|null} ping
 * @returns {"good"|"ok"|"bad"|"none"}
 */
function pingBucket(ping) {
  if (!Number.isFinite(ping)) return "none";
  if (ping < 80) return "good";
  if (ping < 160) return "ok";
  return "bad";
}

/** How many of the 3 meter bars are lit for a bucket. */
const BUCKET_BARS = { good: 3, ok: 2, bad: 1, none: 0 };
/** Status token per bucket. */
const BUCKET_TOKEN = {
  good: "var(--lf-color-success)",
  ok: "var(--lf-color-warn)",
  bad: "var(--lf-color-error)",
  none: "var(--lf-color-text-disabled)",
};

const STYLE_ID = "lf-player-list-styles";

/** CSS injected once into the document head (single-file component). */
const CSS = `
lf-player-list {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: var(--lf-z-screen, 20);
  min-width: 380px;
  max-width: min(560px, 92vw);
  max-height: 80vh;
  overflow: hidden auto;
  display: none;
  flex-direction: column;
  background: var(--lf-color-bg-panel, #221B33);
  color: var(--lf-color-text-body, #EDE7DA);
  border: var(--lf-border-hem, 1px solid var(--lf-color-border-hem, #6A5F8C));
  border-radius: var(--lf-radius-lg, 8px);
  box-shadow: 0 8px 32px rgba(0,0,0,0.45);
  font-family: var(--lf-font-ui, system-ui, sans-serif);
  padding: 0;
}
lf-player-list[open] { display: flex; }
lf-player-list .lf-plist__header {
  padding: var(--lf-space-3, 12px) var(--lf-space-4, 16px);
  font-family: var(--lf-font-display, inherit);
  font-weight: 700;
  font-size: 1.05rem;
  color: var(--lf-color-text-heading, #F7F2E4);
  border-bottom: var(--lf-border-hem, 1px solid var(--lf-color-border-hem, #6A5F8C));
}
lf-player-list .lf-plist__rows { display: flex; flex-direction: column; }
lf-player-list .lf-plist__row {
  display: grid;
  grid-template-columns: auto 1fr auto auto auto;
  align-items: center;
  gap: var(--lf-space-3, 12px);
  padding: var(--lf-space-2, 8px) var(--lf-space-4, 16px);
  border-bottom: 1px solid var(--lf-color-border-hem, #6A5F8C);
}
lf-player-list .lf-plist__row:last-child { border-bottom: 0; }
lf-player-list .lf-plist__row[data-empty] {
  grid-template-columns: 1fr;
  color: var(--lf-color-text-dim, #B4AAC9);
  font-style: italic;
  justify-items: center;
}
lf-player-list .lf-plist__chip {
  position: relative;
  width: 20px;
  height: 20px;
  border-radius: var(--lf-radius-sm, 2px);
  border: 1px solid rgba(0,0,0,0.35);
  flex: none;
}
lf-player-list .lf-plist__chip-pip {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 9px;
  height: 9px;
  border-radius: var(--lf-radius-sm, 2px);
  border: 1px solid var(--lf-color-bg-panel, #221B33);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 7px;
  line-height: 1;
  color: #1B1528;
  font-weight: 700;
}
lf-player-list .lf-plist__chip-pip[data-shape="you"] { border-radius: var(--lf-radius-pill, 999px); }
lf-player-list .lf-plist__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
lf-player-list .lf-plist__name[data-self] {
  font-weight: 700;
  color: #F2C14E;
}
lf-player-list .lf-plist__badge {
  font-size: 0.75rem;
  padding: 2px var(--lf-space-2, 8px);
  border-radius: var(--lf-radius-pill, 999px);
  border: 1px solid var(--lf-color-border-hem, #6A5F8C);
  color: var(--lf-color-text-dim, #B4AAC9);
  white-space: nowrap;
}
lf-player-list .lf-plist__ping {
  display: inline-flex;
  align-items: center;
  gap: var(--lf-space-2, 8px);
  justify-content: flex-end;
}
lf-player-list .lf-plist__meter {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 14px;
}
lf-player-list .lf-plist__bar {
  width: 4px;
  background: var(--lf-color-text-disabled, #6E6584);
  border-radius: 1px;
}
lf-player-list .lf-plist__bar:nth-child(1) { height: 6px; }
lf-player-list .lf-plist__bar:nth-child(2) { height: 10px; }
lf-player-list .lf-plist__bar:nth-child(3) { height: 14px; }
lf-player-list .lf-plist__ping-text {
  font-family: var(--lf-font-mono, monospace);
  font-size: 0.75rem;
  color: var(--lf-color-text-dim, #B4AAC9);
  min-width: 52px;
  text-align: right;
}
lf-player-list .lf-plist__team-dot {
  width: 10px;
  height: 10px;
  border-radius: var(--lf-radius-pill, 999px);
  border: 1px solid rgba(0,0,0,0.35);
  flex: none;
}
`;

/**
 * Inject the component stylesheet once per document. Never throws.
 */
function ensureStyles() {
  try {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  } catch (_err) {
    /* no-op */
  }
}

/**
 * <lf-player-list> — hold-Tab overlay listing the roster.
 *
 * USAGE
 *   const list = document.createElement("lf-player-list");
 *   document.body.appendChild(list);
 *   list.setStore(presenceStore);
 *   // on Tab keydown: list.show();  on Tab keyup: list.hide();
 *
 * PUBLIC METHODS
 *   setStore(store) — subscribe to change/join/leave/update and render now
 *   show() / hide() / toggle() — visibility (reflected "open" attribute)
 *
 * The overlay is display-only (no focus trap). Never throws; tolerant of no
 * store being set. Rows are rebuilt on store change events, not per frame.
 */
export class LFPlayerList extends LFElement {
  static observedAttributes = ["open"];

  constructor() {
    super();
    /** @type {EventTarget|null} */
    this._store = null;
    this._onChange = () => this._renderRows();
  }

  /** @returns {boolean} */
  get open() {
    return this.boolAttr("open");
  }

  /** @param {boolean} v */
  set open(v) {
    this.reflectBool("open", !!v);
  }

  render() {
    ensureStyles();
    this.innerHTML = "";
    const header = document.createElement("div");
    header.className = "lf-plist__header";
    header.setAttribute("data-role", "header");
    const rows = document.createElement("div");
    rows.className = "lf-plist__rows";
    rows.setAttribute("data-role", "rows");
    this.appendChild(header);
    this.appendChild(rows);
    this._renderRows();
  }

  /**
   * Attach a PresenceStore-like EventTarget. Re-subscribes cleanly if called
   * again; renders immediately. Safe to pass null to detach.
   * @param {EventTarget|null} store
   */
  setStore(store) {
    try {
      if (this._store) {
        for (const t of ["change", "join", "leave", "update"]) {
          this._store.removeEventListener(t, this._onChange);
        }
      }
      this._store = store || null;
      if (this._store) {
        for (const t of ["change", "join", "leave", "update"]) {
          this._store.addEventListener(t, this._onChange);
        }
      }
      this._renderRows();
    } catch (_err) {
      /* no-op */
    }
  }

  /** Show the overlay. */
  show() {
    this.open = true;
  }

  /** Hide the overlay. */
  hide() {
    this.open = false;
  }

  /** Toggle visibility. */
  toggle() {
    this.open = !this.open;
  }

  /** Read the roster array from the store defensively. @returns {Array} */
  _players() {
    try {
      const p = this._store && this._store.players;
      return Array.isArray(p) ? p : [];
    } catch (_err) {
      return [];
    }
  }

  /** Rebuild header + rows from the current store state. Never throws. */
  _renderRows() {
    try {
      if (!this._lfRendered) return;
      const header = this.querySelector('[data-role="header"]');
      const rows = this.querySelector('[data-role="rows"]');
      if (!header || !rows) return;
      const players = this._players();
      header.textContent = `Players (${players.length})`;
      rows.innerHTML = "";

      if (players.length === 0) {
        const empty = document.createElement("div");
        empty.className = "lf-plist__row";
        empty.setAttribute("data-empty", "");
        empty.textContent = "No players online";
        rows.appendChild(empty);
        return;
      }

      for (const p of players) {
        rows.appendChild(this._buildRow(p));
      }
    } catch (_err) {
      /* no-op */
    }
  }

  /**
   * Build one roster row element for a player.
   * @param {Object} p Player record from the store
   * @returns {HTMLElement}
   */
  _buildRow(p) {
    const row = document.createElement("div");
    row.className = "lf-plist__row";

    // Swatch chip + non-hue pip (shape + text so it isn't hue-only).
    const chip = document.createElement("div");
    chip.className = "lf-plist__chip";
    chip.style.background = typeof p.swatch === "string" ? p.swatch : "#6A5F8C";
    const pip = document.createElement("span");
    pip.className = "lf-plist__chip-pip";
    if (p.self) {
      pip.setAttribute("data-shape", "you");
      pip.style.background = TEAM_COLORS.self;
      pip.textContent = "★"; // star glyph for "you"
      pip.title = "You";
    } else if (p.team === "a" || p.team === "b") {
      pip.setAttribute("data-shape", "team");
      pip.style.background = TEAM_COLORS[p.team];
      pip.textContent = p.team.toUpperCase();
      pip.title = `Team ${p.team.toUpperCase()}`;
    } else {
      pip.style.display = "none";
    }
    chip.appendChild(pip);
    row.appendChild(chip);

    // Name.
    const name = document.createElement("div");
    name.className = "lf-plist__name";
    if (p.self) name.setAttribute("data-self", "");
    name.textContent = String(p.name == null ? "" : p.name);
    name.title = name.textContent;
    row.appendChild(name);

    // Dimension badge.
    const badge = document.createElement("span");
    badge.className = "lf-plist__badge";
    badge.textContent = dimDisplayName(p.dim);
    row.appendChild(badge);

    // Ping meter + text.
    const ping = document.createElement("div");
    ping.className = "lf-plist__ping";
    const meter = document.createElement("span");
    meter.className = "lf-plist__meter";
    const bucket = pingBucket(p.ping);
    const lit = BUCKET_BARS[bucket];
    const token = BUCKET_TOKEN[bucket];
    for (let i = 0; i < 3; i++) {
      const bar = document.createElement("span");
      bar.className = "lf-plist__bar";
      if (i < lit) bar.style.background = token;
      meter.appendChild(bar);
    }
    const ptext = document.createElement("span");
    ptext.className = "lf-plist__ping-text";
    ptext.textContent = Number.isFinite(p.ping) ? `${Math.round(p.ping)} ms` : "—";
    ping.appendChild(meter);
    ping.appendChild(ptext);
    row.appendChild(ping);

    // Team dot (only when a team is set).
    const dot = document.createElement("span");
    dot.className = "lf-plist__team-dot";
    if (p.team === "a" || p.team === "b") {
      dot.style.background = TEAM_COLORS[p.team];
      dot.title = `Team ${p.team.toUpperCase()}`;
    } else {
      dot.style.visibility = "hidden";
    }
    row.appendChild(dot);

    return row;
  }
}

define("lf-player-list", LFPlayerList);

export default LFPlayerList;
