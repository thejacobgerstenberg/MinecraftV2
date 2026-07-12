// social/session-feed.js
// Session event surface: turns PresenceStore join/leave/dim events into
// top-right toasts (via lf-toast-rack) and an optional scrollable, timestamped
// feed panel. Also exposes a generic note(kind,text) so other social modules
// (connection status, whisper notices, ...) can push arbitrary events.
//
// Never throws: if the toast rack is missing it degrades to feed-only and logs
// a single console.debug. All rendering uses textContent + --lf-* tokens.

import { dimDisplayName } from "./presence.js";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Cap on retained feed entries (oldest trimmed). */
const MAX_ENTRIES = 100;

/** Default toast durations (ms) per event kind. duration<=0 disables timing. */
const DEFAULT_DURATIONS = {
  join: 4000,
  leave: 4000,
  dim: 4000,
  info: 5000,
  success: 4000,
  warn: 6000,
  error: 8000,
};

/**
 * Map a feed "kind" to a toast status token variant. Unknown -> "info".
 * @param {string} kind
 * @returns {"info"|"success"|"warn"|"error"}
 */
function kindToStatus(kind) {
  switch (kind) {
    case "join":
    case "success":
      return "success";
    case "leave":
    case "info":
      return "info";
    case "warn":
      return "warn";
    case "error":
      return "error";
    case "dim":
      return "info";
    default:
      return "info";
  }
}

/** Color token per status (feed dot fill). */
const STATUS_TOKEN = {
  success: "var(--lf-color-success, #A3E060)",
  warn: "var(--lf-color-warn, #FFD24A)",
  error: "var(--lf-color-error, #FF8578)",
  info: "var(--lf-color-info, #A9CBF0)",
};

/**
 * Non-hue dot shape per status so the feed is legible without color. A ring,
 * a solid, a diamond and a triangle read distinctly in monochrome.
 * @type {Object<string,string>}
 */
const STATUS_SHAPE = {
  success: "solid", // filled circle
  info: "ring", // hollow circle
  warn: "diamond",
  error: "triangle",
};

const STYLE_ID = "lf-session-feed-styles";

/** CSS injected once into the document head. Tokens-only colors. */
const CSS = `
.lf-feed { display: flex; flex-direction: column; gap: var(--lf-space-1, 4px); }
.lf-feed__line {
  display: grid;
  grid-template-columns: auto auto 1fr;
  align-items: baseline;
  gap: var(--lf-space-2, 8px);
  padding: var(--lf-space-1, 4px) var(--lf-space-2, 8px);
  font-family: var(--lf-font-ui, system-ui, sans-serif);
  font-size: 0.8125rem;
  color: var(--lf-color-text-body, #EDE7DA);
  border-bottom: 1px solid var(--lf-color-border-hem, #6A5F8C);
}
.lf-feed__line:last-child { border-bottom: 0; }
.lf-feed__time {
  font-family: var(--lf-font-mono, monospace);
  font-size: 0.75rem;
  color: var(--lf-color-text-dim, #B4AAC9);
  white-space: nowrap;
}
.lf-feed__dot {
  width: 10px;
  height: 10px;
  align-self: center;
  flex: none;
}
.lf-feed__dot[data-shape="solid"] { border-radius: 999px; background: var(--lf-dot, #A9CBF0); }
.lf-feed__dot[data-shape="ring"] {
  border-radius: 999px;
  background: transparent;
  border: 2px solid var(--lf-dot, #A9CBF0);
}
.lf-feed__dot[data-shape="diamond"] {
  width: 9px; height: 9px;
  transform: rotate(45deg);
  background: var(--lf-dot, #FFD24A);
}
.lf-feed__dot[data-shape="triangle"] {
  width: 0; height: 0;
  background: transparent;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-bottom: 9px solid var(--lf-dot, #FF8578);
}
.lf-feed__text {
  overflow: hidden;
  text-overflow: ellipsis;
}
.lf-feed[data-empty]::after {
  content: "No session events yet";
  color: var(--lf-color-text-dim, #B4AAC9);
  font-style: italic;
  font-size: 0.8125rem;
  padding: var(--lf-space-2, 8px);
}
`;

/**
 * Inject the feed stylesheet once per document. Never throws.
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

/** Format a Date as HH:MM. Never throws. */
function hhmm(d) {
  try {
    const dt = d instanceof Date ? d : new Date();
    const h = String(dt.getHours()).padStart(2, "0");
    const m = String(dt.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  } catch (_err) {
    return "--:--";
  }
}

/**
 * @typedef {Object} FeedEntry
 * @property {number} time epoch ms
 * @property {string} kind join|leave|dim|info|success|warn|error
 * @property {string} text rendered message (already plain text)
 */

/* -------------------------------------------------------------------------- */
/* SessionFeed                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Bridges a PresenceStore to user-facing session notifications.
 *
 * USAGE
 *   const feed = new SessionFeed({ presence, rack: 'lf-toast-rack', feedMount });
 *   feed.start();
 *   // elsewhere: feed.note('info', 'Connected');
 *   feed.stop(); // or feed.dispose();
 *
 * Self join/leave/dim events are suppressed from toasts (you don't get toasted
 * about yourself) but are still recorded in the feed. If no rack is available
 * the feed degrades to feed-only and logs one console.debug.
 */
export class SessionFeed {
  /**
   * @param {{
   *   presence?: EventTarget,
   *   rack?: (Element & {show?:Function})|string,
   *   feedMount?: HTMLElement,
   *   toastDurations?: Object<string,number>,
   * }} [opts]
   */
  constructor(opts = {}) {
    const o = opts && typeof opts === "object" ? opts : {};
    /** @type {EventTarget|null} */
    this._presence = o.presence || null;
    /** @type {HTMLElement|null} */
    this._feedMount = o.feedMount instanceof HTMLElement ? o.feedMount : null;
    this._durations = Object.assign({}, DEFAULT_DURATIONS, o.toastDurations || {});
    /** @type {FeedEntry[]} */
    this._entries = [];
    this._started = false;
    this._rackWarned = false;
    /** @type {(Element & {show?:Function})|string|null} */
    this._rackOpt = o.rack != null ? o.rack : null;

    // Bound handlers so add/remove pair up.
    this._onJoin = (e) => this._handleJoin(e);
    this._onLeave = (e) => this._handleLeave(e);
    this._onDim = (e) => this._handleDim(e);

    ensureStyles();
    if (this._feedMount) this.renderFeedInto(this._feedMount);
  }

  /* --------------------------- lifecycle ------------------------------ */

  /** Subscribe to presence events. Idempotent. */
  start() {
    if (this._started || !this._presence) return;
    try {
      this._presence.addEventListener("join", this._onJoin);
      this._presence.addEventListener("leave", this._onLeave);
      this._presence.addEventListener("dim", this._onDim);
      this._started = true;
    } catch (_err) {
      /* no-op */
    }
  }

  /** Unsubscribe from presence events. Idempotent. */
  stop() {
    if (!this._started || !this._presence) return;
    try {
      this._presence.removeEventListener("join", this._onJoin);
      this._presence.removeEventListener("leave", this._onLeave);
      this._presence.removeEventListener("dim", this._onDim);
    } catch (_err) {
      /* no-op */
    }
    this._started = false;
  }

  /** Stop and drop references. */
  dispose() {
    this.stop();
    this._presence = null;
    this._feedMount = null;
  }

  /**
   * Point the feed at (or detach from, with null) a scrollable panel element
   * and render into it immediately.
   * @param {HTMLElement|null} el
   */
  setFeedMount(el) {
    this._feedMount = el instanceof HTMLElement ? el : null;
    if (this._feedMount) this.renderFeedInto(this._feedMount);
  }

  /** @returns {FeedEntry[]} a shallow copy of the recent feed entries. */
  events() {
    return this._entries.slice();
  }

  /* ------------------------- presence handlers ------------------------ */

  /** @param {Event} e */
  _handleJoin(e) {
    const p = e && e.detail && e.detail.player;
    if (!p) return;
    const name = this._nameOf(p);
    this._record("join", `${name} joined`, !!p.self);
  }

  /** @param {Event} e */
  _handleLeave(e) {
    const p = e && e.detail && e.detail.player;
    const name = p ? this._nameOf(p) : "A player";
    this._record("leave", `${name} left`, !!(p && p.self));
  }

  /** @param {Event} e */
  _handleDim(e) {
    const d = e && e.detail;
    const p = d && d.player;
    if (!p) return;
    const name = this._nameOf(p);
    this._record("dim", `${name} went to ${dimDisplayName(d.to)}`, !!p.self);
  }

  /** Safe player name read. */
  _nameOf(p) {
    const n = p && p.name;
    return typeof n === "string" && n ? n : "A player";
  }

  /* ----------------------------- notes -------------------------------- */

  /**
   * Push an arbitrary session event (toast + feed line). Used by other modules
   * for connection status, whisper notices, etc.
   * @param {string} kind info|success|warn|error (or join/leave/dim)
   * @param {string} text
   */
  note(kind, text) {
    this._record(String(kind || "info"), String(text == null ? "" : text), false);
  }

  /**
   * Record an event: append to the capped feed, render its line, and (unless
   * suppressed) push a toast. Never throws.
   * @param {string} kind
   * @param {string} text
   * @param {boolean} isSelf suppress the toast (feed still records it)
   */
  _record(kind, text, isSelf) {
    try {
      const entry = { time: Date.now(), kind, text };
      this._entries.push(entry);
      if (this._entries.length > MAX_ENTRIES) {
        this._entries.splice(0, this._entries.length - MAX_ENTRIES);
      }
      this._appendLine(entry);
      if (!isSelf) this._toast(kind, text);
    } catch (_err) {
      /* no-op */
    }
  }

  /* ------------------------------ toast ------------------------------- */

  /**
   * Resolve the rack lazily: an element, a selector, or (fallback) the first
   * lf-toast-rack in the document. Returns null if none is available.
   * @returns {(Element & {show?:Function})|null}
   */
  _rack() {
    try {
      const opt = this._rackOpt;
      if (opt && typeof opt === "object" && typeof opt.show === "function") return opt;
      if (typeof document === "undefined") return null;
      if (typeof opt === "string" && opt) {
        const found = document.querySelector(opt);
        if (found) return found;
      }
      return document.querySelector("lf-toast-rack");
    } catch (_err) {
      return null;
    }
  }

  /**
   * Push a toast, degrading to feed-only (with a one-time debug) if no rack.
   * @param {string} kind
   * @param {string} text
   */
  _toast(kind, text) {
    const rack = this._rack();
    if (!rack || typeof rack.show !== "function") {
      if (!this._rackWarned) {
        this._rackWarned = true;
        try {
          console.debug("[SessionFeed] no lf-toast-rack found; feed-only mode");
        } catch (_err) {
          /* no-op */
        }
      }
      return;
    }
    try {
      const status = kindToStatus(kind);
      const duration = this._durations[kind] != null ? this._durations[kind] : this._durations.info;
      rack.show({ status, heading: text, duration });
    } catch (_err) {
      /* no-op */
    }
  }

  /* ------------------------------ feed -------------------------------- */

  /**
   * (Re)build the entire feed list inside el from the retained entries. Safe to
   * call with the same or a different mount.
   * @param {HTMLElement} el
   */
  renderFeedInto(el) {
    if (!(el instanceof HTMLElement)) return;
    try {
      ensureStyles();
      el.classList.add("lf-feed");
      el.innerHTML = "";
      for (const entry of this._entries) el.appendChild(this._buildLine(entry));
      this._reflectEmpty(el);
    } catch (_err) {
      /* no-op */
    }
  }

  /** Append a single line to the current mount and keep it scrolled to end. */
  _appendLine(entry) {
    const el = this._feedMount;
    if (!(el instanceof HTMLElement)) return;
    try {
      el.classList.add("lf-feed");
      el.appendChild(this._buildLine(entry));
      // Trim rendered lines to match the entry cap.
      while (el.children.length > MAX_ENTRIES && el.firstChild) el.firstChild.remove();
      this._reflectEmpty(el);
      el.scrollTop = el.scrollHeight;
    } catch (_err) {
      /* no-op */
    }
  }

  /** Toggle the data-empty attribute used for the placeholder text. */
  _reflectEmpty(el) {
    if (this._entries.length === 0) el.setAttribute("data-empty", "");
    else el.removeAttribute("data-empty");
  }

  /**
   * Build one feed line element (timestamp + colored/shaped kind dot + text).
   * Rendering uses textContent only.
   * @param {FeedEntry} entry
   * @returns {HTMLElement}
   */
  _buildLine(entry) {
    const line = document.createElement("div");
    line.className = "lf-feed__line";

    const time = document.createElement("span");
    time.className = "lf-feed__time";
    time.textContent = hhmm(new Date(entry.time));
    line.appendChild(time);

    const status = kindToStatus(entry.kind);
    const dot = document.createElement("span");
    dot.className = "lf-feed__dot";
    dot.setAttribute("data-shape", STATUS_SHAPE[status] || "solid");
    dot.style.setProperty("--lf-dot", STATUS_TOKEN[status] || STATUS_TOKEN.info);
    dot.setAttribute("aria-hidden", "true");
    dot.title = status;
    line.appendChild(dot);

    const text = document.createElement("span");
    text.className = "lf-feed__text";
    text.textContent = String(entry.text == null ? "" : entry.text);
    line.appendChild(text);

    return line;
  }
}

export default SessionFeed;
