// social/whisper.js
// Client-side whisper / direct-message layer on top of the broadcast game chat,
// plus mute/block controls persisted to localStorage.
//
// PROTOCOL REALITY: the server broadcasts chat to the WHOLE room ({t:'chat',
// id, name, text}) and supports no true private messages. So a "whisper" here
// is a client-side convention with an INJECTABLE transport:
//
//   - If opts.send is provided, WhisperController calls send({to, text}); a
//     builder can wire that to a real directed transport IF/WHEN the server
//     ever supports one.
//   - If opts.send is absent, whispers GRACEFULLY DEGRADE: the DM is still
//     rendered locally and tagged as local-only/unsent. True privacy requires
//     server support — this layer cannot hide a message the server would
//     broadcast, so with no directed transport nothing is actually sent.
//
// Mute hides a peer's whispers; block hides whispers AND public chat. Both sets
// are name-keyed (lowercased) — the wire protocol's ids are ephemeral per
// session while names are what players actually type in /w, /mute, /block, so a
// name key is the stable, user-facing choice. Persisted as JSON.
//
// Never throws. All chat rendering goes through textContent (server already
// HTML-escapes name/text, but we never trust that and never use innerHTML).

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_STORAGE_KEY = "loomfall.social";

/** Glyphs for DM lines (kept ASCII-safe-ish; rendered via textContent). */
const GLYPH_OUT = "→︎"; // → outgoing arrow
const GLYPH_IN = "←︎"; // ← incoming arrow
const GLYPH_LOCK = "🔒"; // 🔒 local-only marker

const STYLE_ID = "lf-whisper-styles";

/** CSS injected once: distinct dim/italic styling for DM lines in lf-chat. */
const CSS = `
.lf-chat__line[data-dm] .lf-chat__text,
.lf-chat__line[data-dm] .lf-chat__name {
  font-style: italic;
  color: var(--lf-color-info, #A9CBF0);
}
.lf-chat__line[data-dm] { opacity: 0.92; }
.lf-chat__line[data-dm-local] .lf-chat__text { opacity: 0.75; }
.lf-chat__line[data-dm-error] .lf-chat__text { color: var(--lf-color-error, #FF8578); }
.lf-chat__line[data-dm-status] .lf-chat__text { color: var(--lf-color-warn, #FFD24A); }
`;

/**
 * Inject the whisper stylesheet once per document. Never throws.
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

/** Lowercased, trimmed name key. Non-strings -> "". */
function nameKey(name) {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

/* -------------------------------------------------------------------------- */
/* WhisperController                                                           */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {{type:'chat', text:string}} ChatResult a normal public message
 * @typedef {{type:'whisper', to:string, text:string, sent:boolean}} WhisperResult
 * @typedef {{type:'reply', to:string, text:string, sent:boolean}} ReplyResult
 * @typedef {{type:'mute'|'unmute'|'block'|'unblock', name:string}} ModResult
 * @typedef {{type:'error', text:string}} ErrorResult
 * @typedef {{type:'noop'}} NoopResult
 */

/**
 * Parses chat input for whisper/moderation commands and layers DM behavior on
 * a broadcast chat element.
 *
 * COMMANDS
 *   /w <name> <message>     directed whisper (alias /msg)
 *   /msg <name> <message>   directed whisper
 *   /r <message>            reply to the last person who whispered you
 *   /mute <name>            hide that player's whispers
 *   /unmute <name>
 *   /block <name>           hide that player's whispers AND public chat
 *   /unblock <name>
 *   (anything else)         normal public chat -> {type:'chat', text}
 *
 * USAGE
 *   const w = new WhisperController({ presence, chat, send });
 *   chat.addEventListener('lf-send', (e) => {
 *     const r = w.handleInput(e.detail.text);
 *     if (r.type === 'chat') gameSendChat(r.text); // caller sends public chat
 *   });
 *   // when a directed message arrives (builder/demo):
 *   w.receiveWhisper({ from: 'Ada', text: 'hi' });
 *   // filter incoming public chat:
 *   if (w.filterPublicChat(msg)) chat.addMessage(...);
 *
 * Never throws.
 */
export class WhisperController {
  /**
   * @param {{
   *   presence?: {players?: any[], get?: Function},
   *   chat?: (Element & {addMessage?:Function}),
   *   send?: (payload:{to:string, text:string}) => void,
   *   storageKey?: string,
   *   feed?: {note?: Function},
   * }} [opts]
   */
  constructor(opts = {}) {
    const o = opts && typeof opts === "object" ? opts : {};
    this._presence = o.presence || null;
    /** @type {(Element & {addMessage?:Function})|null} */
    this._chat = o.chat || null;
    this._send = typeof o.send === "function" ? o.send : null;
    this._storageKey = typeof o.storageKey === "string" && o.storageKey ? o.storageKey : DEFAULT_STORAGE_KEY;
    this._feed = o.feed || null;

    /** @type {Set<string>} lowercased names whose whispers are hidden. */
    this._muted = new Set();
    /** @type {Set<string>} lowercased names hidden from whispers AND public chat. */
    this._blocked = new Set();

    /** @type {string|null} name of the last person to whisper us (for /r). */
    this.lastWhisperer = null;

    ensureStyles();
    this._load();
  }

  /* --------------------------- persistence ---------------------------- */

  /** Load muted/blocked sets from localStorage. Never throws. */
  _load() {
    try {
      if (typeof localStorage === "undefined") return;
      const raw = localStorage.getItem(this._storageKey);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        if (Array.isArray(data.muted)) {
          for (const n of data.muted) {
            const k = nameKey(n);
            if (k) this._muted.add(k);
          }
        }
        if (Array.isArray(data.blocked)) {
          for (const n of data.blocked) {
            const k = nameKey(n);
            if (k) this._blocked.add(k);
          }
        }
      }
    } catch (_err) {
      /* corrupt/absent storage — start empty */
    }
  }

  /** Persist muted/blocked sets to localStorage. Never throws. */
  _save() {
    try {
      if (typeof localStorage === "undefined") return;
      const payload = JSON.stringify({
        muted: Array.from(this._muted),
        blocked: Array.from(this._blocked),
      });
      localStorage.setItem(this._storageKey, payload);
    } catch (_err) {
      /* storage full/blocked (private mode) — in-memory state still works */
    }
  }

  /* ---------------------------- parsing ------------------------------- */

  /**
   * Parse input text into a structured command without side effects. Exposed
   * for callers that want to inspect before acting; handleInput() drives the
   * actual behavior.
   * @param {string} text
   * @returns {{type:string, name?:string, text?:string}}
   */
  parse(text) {
    const raw = typeof text === "string" ? text : "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed[0] !== "/") {
      return { type: "chat", text: raw };
    }
    // Split into command + remainder.
    const m = /^\/(\w+)\s*([\s\S]*)$/.exec(trimmed);
    if (!m) return { type: "chat", text: raw };
    const cmd = m[1].toLowerCase();
    const rest = m[2];

    switch (cmd) {
      case "w":
      case "msg": {
        const parsed = this._splitNameAndMessage(rest);
        if (!parsed) return { type: "error", text: "Usage: /w <name> <message>" };
        return { type: "whisper", name: parsed.name, text: parsed.text };
      }
      case "r": {
        const msg = rest.trim();
        if (!msg) return { type: "error", text: "Usage: /r <message>" };
        return { type: "reply", text: msg };
      }
      case "mute":
      case "unmute":
      case "block":
      case "unblock": {
        const name = rest.trim();
        if (!name) return { type: "error", text: `Usage: /${cmd} <name>` };
        return { type: cmd, name };
      }
      default:
        // Unknown slash command — treat as public chat so nothing is swallowed.
        return { type: "chat", text: raw };
    }
  }

  /**
   * Split "<name> <message...>" honoring an optional "quoted name". Returns
   * null if a message is missing.
   * @param {string} rest
   * @returns {{name:string, text:string}|null}
   */
  _splitNameAndMessage(rest) {
    const s = typeof rest === "string" ? rest.trim() : "";
    if (!s) return null;
    let name;
    let text;
    if (s[0] === '"') {
      const end = s.indexOf('"', 1);
      if (end === -1) return null;
      name = s.slice(1, end).trim();
      text = s.slice(end + 1).trim();
    } else {
      const sp = s.search(/\s/);
      if (sp === -1) return null; // name but no message
      name = s.slice(0, sp).trim();
      text = s.slice(sp + 1).trim();
    }
    if (!name || !text) return null;
    return { name, text };
  }

  /* --------------------------- main entry ----------------------------- */

  /**
   * Main entry from the chat send event. Executes the parsed command and
   * returns a result. When the result is {type:'chat'} the CALLER is
   * responsible for sending text over the public game chat.
   * @param {string} text
   * @returns {{type:string, [k:string]:any}}
   */
  handleInput(text) {
    try {
      const cmd = this.parse(text);
      switch (cmd.type) {
        case "chat":
          return { type: "chat", text: cmd.text };
        case "whisper":
          return this._doWhisper(cmd.name, cmd.text);
        case "reply": {
          if (!this.lastWhisperer) {
            this._systemLine("No one has whispered you yet", "error");
            return { type: "error", text: "no reply target" };
          }
          return this._doWhisper(this.lastWhisperer, cmd.text);
        }
        case "mute":
          return this._modResult("mute", this.mute(cmd.name));
        case "unmute":
          return this._modResult("unmute", this.unmute(cmd.name));
        case "block":
          return this._modResult("block", this.block(cmd.name));
        case "unblock":
          return this._modResult("unblock", this.unblock(cmd.name));
        case "error":
          this._systemLine(cmd.text, "error");
          return cmd;
        default:
          return { type: "noop" };
      }
    } catch (_err) {
      return { type: "noop" };
    }
  }

  /** Wrap a mod op's canonical name into a ModResult. */
  _modResult(type, name) {
    return { type, name: name || "" };
  }

  /* --------------------------- whispering ----------------------------- */

  /**
   * Resolve a peer by name (case-insensitive), render the outgoing DM line, and
   * dispatch it via the injected transport (or degrade to local-only).
   * @param {string} name
   * @param {string} text
   * @returns {{type:'whisper', to:string, text:string, sent:boolean}|{type:'error',text:string}}
   */
  _doWhisper(name, text) {
    const peer = this._resolvePeer(name);
    if (!peer) {
      this._systemLine(`No player named ${name}`, "error");
      return { type: "error", text: `no player named ${name}` };
    }
    const to = peer.name;
    let sent = false;
    if (this._send) {
      try {
        this._send({ to, text });
        sent = true;
      } catch (_err) {
        sent = false;
      }
    }
    this._renderOutgoing(to, text, sent);
    return { type: "whisper", to, text, sent };
  }

  /**
   * Find a player by case-insensitive name via presence. Returns a
   * {id,name}-ish record or null.
   * @param {string} name
   * @returns {{id?:string, name:string}|null}
   */
  _resolvePeer(name) {
    const key = nameKey(name);
    if (!key || !this._presence) return null;
    try {
      const list = this._presence.players;
      if (Array.isArray(list)) {
        for (const p of list) {
          if (p && nameKey(p.name) === key) return p;
        }
      }
    } catch (_err) {
      /* no-op */
    }
    return null;
  }

  /* --------------------------- receiving ------------------------------ */

  /**
   * Handle an inbound directed message (builder wires this to the real
   * transport; the demo simulates it). Muted/blocked senders are dropped
   * silently. Otherwise renders the DM, notes the feed, and arms /r.
   * @param {{from:string, text:string}} msg
   */
  receiveWhisper(msg) {
    try {
      const from = msg && typeof msg.from === "string" ? msg.from : "";
      const text = msg && typeof msg.text === "string" ? msg.text : "";
      if (!from) return;
      const key = nameKey(from);
      if (this._muted.has(key) || this._blocked.has(key)) return; // drop silently
      this._renderIncoming(from, text);
      this.lastWhisperer = from;
      this._note("info", `${from} whispered you`);
    } catch (_err) {
      /* no-op */
    }
  }

  /* ------------------------- public chat filter ----------------------- */

  /**
   * Decide whether an inbound public chat message should be shown. Blocked
   * senders (by name) are hidden; everyone else passes.
   * @param {{id?:string, name?:string, text?:string}} msg
   * @returns {boolean} true = show
   */
  filterPublicChat(msg) {
    try {
      if (!msg) return true;
      return !this._blocked.has(nameKey(msg.name));
    } catch (_err) {
      return true;
    }
  }

  /* ---------------------------- mute/block ---------------------------- */

  /**
   * @param {string} name @returns {string} canonical (lowercased) key acted on
   */
  mute(name) {
    const key = nameKey(name);
    if (!key) return "";
    this._muted.add(key);
    this._save();
    this._systemLine(`Muted ${name} (whispers hidden)`, "status");
    return key;
  }

  /** @param {string} name @returns {string} */
  unmute(name) {
    const key = nameKey(name);
    if (!key) return "";
    this._muted.delete(key);
    this._save();
    this._systemLine(`Unmuted ${name}`, "status");
    return key;
  }

  /** @param {string} name @returns {string} */
  block(name) {
    const key = nameKey(name);
    if (!key) return "";
    this._blocked.add(key);
    this._save();
    this._systemLine(`Blocked ${name} (whispers and chat hidden)`, "status");
    return key;
  }

  /** @param {string} name @returns {string} */
  unblock(name) {
    const key = nameKey(name);
    if (!key) return "";
    this._blocked.delete(key);
    this._save();
    this._systemLine(`Unblocked ${name}`, "status");
    return key;
  }

  /** @param {string} name @returns {boolean} */
  isMuted(name) {
    return this._muted.has(nameKey(name));
  }

  /** @param {string} name @returns {boolean} */
  isBlocked(name) {
    return this._blocked.has(nameKey(name));
  }

  /** @returns {string[]} lowercased muted names. */
  getMuted() {
    return Array.from(this._muted);
  }

  /** @returns {string[]} lowercased blocked names. */
  getBlocked() {
    return Array.from(this._blocked);
  }

  /* --------------------------- rendering ------------------------------ */

  /**
   * Render an outgoing DM line: "[you {arrow} <name>] <text>" (+ lock glyph and
   * a local-only note when no transport actually sent it).
   * @param {string} to @param {string} text @param {boolean} sent
   */
  _renderOutgoing(to, text, sent) {
    const label = `[you ${GLYPH_OUT} ${to}]`;
    const suffix = sent ? "" : ` ${GLYPH_LOCK} (local only, unsent)`;
    const line = this._addChat({ name: null, text: `${label} ${text}${suffix}`, system: true });
    if (line) {
      line.setAttribute("data-dm", "");
      if (!sent) line.setAttribute("data-dm-local", "");
    }
  }

  /**
   * Render an incoming DM line: "[<from> {arrow} you] <text>".
   * @param {string} from @param {string} text
   */
  _renderIncoming(from, text) {
    const label = `[${from} ${GLYPH_IN} you]`;
    const line = this._addChat({ name: null, text: `${label} ${text}`, system: true });
    if (line) line.setAttribute("data-dm", "");
  }

  /**
   * Render a whisper-system status/error line into chat.
   * @param {string} text
   * @param {"status"|"error"} [kind]
   */
  _systemLine(text, kind = "status") {
    const line = this._addChat({ name: null, text, system: true });
    if (line) line.setAttribute(kind === "error" ? "data-dm-error" : "data-dm-status", "");
  }

  /**
   * Safe wrapper over chat.addMessage — returns the created line element or
   * null. Never throws.
   * @param {{name:?string, text:string, system?:boolean}} msg
   * @returns {HTMLElement|null}
   */
  _addChat(msg) {
    try {
      if (this._chat && typeof this._chat.addMessage === "function") {
        const el = this._chat.addMessage(msg);
        return el instanceof HTMLElement ? el : null;
      }
    } catch (_err) {
      /* no-op */
    }
    return null;
  }

  /** Safe feed.note wrapper. */
  _note(kind, text) {
    try {
      if (this._feed && typeof this._feed.note === "function") this._feed.note(kind, text);
    } catch (_err) {
      /* no-op */
    }
  }

  /* --------------------------- lifecycle ------------------------------ */

  /** Drop references (state is already persisted on each change). */
  dispose() {
    this._presence = null;
    this._chat = null;
    this._send = null;
    this._feed = null;
  }
}

export default WhisperController;
