/**
 * protocol.mjs — the ASSUMED multiplayer wire protocol, isolated as an adapter.
 *
 * ADAPTER — when the real server protocol is known, edit ONLY this file to match
 * it; the transport and harnesses are protocol-agnostic.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * The builder has not shipped a multiplayer server yet, so there is no real
 * protocol document to code against. We therefore DEFINE a plausible protocol
 * here and back it with a bundled reference mock server that speaks exactly this
 * wire format. Every other module in the harness (ws-transport, mock-server,
 * load-test, chaos-test, util) is protocol-agnostic: it only ever calls the
 * encoders / decode / helpers exported below. When the real server lands, the
 * ONLY code that must change to retarget the harness is this single module.
 *
 * WIRE FORMAT: UTF-8 JSON text frames. Every message carries a short string tag
 * under the key "t". Client→server encoders return a JSON *string* ready to hand
 * to WSConn.send(). Server→client frames are turned by decode() into a normalized
 * object of shape {kind, ...} where `kind` is the friendly name of `t`.
 *
 * DEFENSIVE CONTRACT: decode() MUST NEVER throw. Anything unparseable, non-object,
 * or of an unrecognized type normalizes to {kind:"unknown", raw}. Encoders coerce
 * their inputs to safe primitives so a caller can never produce a frame that
 * crashes JSON.stringify.
 * ---------------------------------------------------------------------------
 */

/** Protocol revision this adapter implements. Bump when the wire format changes. */
export const PROTOCOL_VERSION = 1;

/**
 * Default server URL, derived from env with sane fallbacks.
 * ws://127.0.0.1:(GAME_PORT||8080)(GAME_WS_PATH||"/")
 * Path is normalized to always begin with "/" so a bare "game" still yields a
 * valid ws:// URL (the mock server derives its path from the same env var).
 */
export function defaultUrl() {
  const port = process.env.GAME_PORT || 8080;
  let path = process.env.GAME_WS_PATH || '/';
  if (typeof path !== 'string' || path.length === 0) path = '/';
  if (path[0] !== '/') path = '/' + path;
  return `ws://127.0.0.1:${port}${path}`;
}

/* =========================================================================
 * Small defensive coercion helpers (kept private to this module).
 * They guarantee encoders emit well-typed JSON and decode() emits stable
 * normalized shapes regardless of how weird the input is.
 * ========================================================================= */

/** Coerce to a finite number, else fall back (default 0). */
function num(v, fallback = 0) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce to a string, else fall back (default ""). Never returns non-string. */
function str(v, fallback = '') {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return fallback;
  try {
    return String(v);
  } catch {
    return fallback;
  }
}

/** Is a plain-ish object (not null, not array)? */
function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Normalize a position to {x,y,z} finite numbers. Accepts an object with
 * x/y/z, tolerating missing components (default 0). Non-objects → {0,0,0}.
 */
function normPos(p) {
  if (!isObj(p)) return { x: 0, y: 0, z: 0 };
  return { x: num(p.x), y: num(p.y), z: num(p.z) };
}

/**
 * On DECODE we want to faithfully surface whatever the server sent (it may be
 * malformed — chaos tests rely on that). This is a *pass-through* position
 * reader: return an {x,y,z} view when it looks like a vector, otherwise return
 * the raw value untouched so callers can inspect/flag it.
 */
function readPos(p) {
  if (isObj(p) && ('x' in p || 'y' in p || 'z' in p)) {
    return { x: num(p.x), y: num(p.y), z: num(p.z) };
  }
  return p; // leave odd shapes (string, array, null) as-is for inspection
}

/* =========================================================================
 * CLIENT → SERVER encoders. Each returns a JSON string.
 * ========================================================================= */

/** Join request. -> {"t":"join","name":<string>,"v":1} */
export function encJoin({ name } = {}) {
  return JSON.stringify({ t: 'join', name: str(name, 'bot'), v: PROTOCOL_VERSION });
}

/**
 * Movement update. -> {"t":"move","seq":n,"pos":{x,y,z},"yaw":..,"pitch":..[,"vel":..]}
 * `seq` is a monotonic per-bot counter (used by the server + harness for drop /
 * out-of-order / propagation tracking). `vel` is optional and only included when
 * the caller supplies a value, so the wire stays minimal for servers that ignore it.
 */
export function encMove({ seq, pos, yaw, pitch, vel } = {}) {
  const msg = {
    t: 'move',
    seq: num(seq),
    pos: normPos(pos),
    yaw: num(yaw),
    pitch: num(pitch),
  };
  if (vel !== undefined) msg.vel = vel; // pass through velocity when provided
  return JSON.stringify(msg);
}

/**
 * Block place/break. -> {"t":"block","action":"place"|"break","pos":{x,y,z},"block":<any>}
 * `action` is coerced to one of the two known verbs (defaults to "place").
 */
export function encBlock({ action, pos, block } = {}) {
  const a = action === 'break' ? 'break' : 'place';
  return JSON.stringify({ t: 'block', action: a, pos: normPos(pos), block: block ?? null });
}

/** Chat message. -> {"t":"chat","text":<string>} */
export function encChat({ text } = {}) {
  return JSON.stringify({ t: 'chat', text: str(text) });
}

/** Latency probe. -> {"t":"ping","ts":<number>}  (ts is the client clock for RTT) */
export function encPing({ ts } = {}) {
  return JSON.stringify({ t: 'ping', ts: num(ts) });
}

/* =========================================================================
 * SERVER → CLIENT decode. Never throws.
 * Returns a normalized {kind, ...} object. Recognized kinds:
 *   welcome | state | block | chat | pong | error | unknown
 * ========================================================================= */

/**
 * Decode one server frame into a normalized object.
 * @param {string|Buffer} raw  the frame payload (JSON text; Buffer is stringified)
 * @returns {{kind:string, [k:string]:any}}
 */
export function decode(raw) {
  // Preserve a string view for the {kind:"unknown", raw} escape hatch.
  let text;
  if (typeof raw === 'string') {
    text = raw;
  } else if (raw && typeof raw === 'object' && typeof raw.toString === 'function') {
    // Buffer / Uint8Array / other → best-effort UTF-8 string.
    try {
      text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    } catch {
      return { kind: 'unknown', raw };
    }
  } else {
    return { kind: 'unknown', raw };
  }

  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return { kind: 'unknown', raw: text };
  }

  if (!isObj(msg)) {
    // Valid JSON but not an object (number, string, array, null) → unknown.
    return { kind: 'unknown', raw: text };
  }

  switch (msg.t) {
    case 'welcome':
      return {
        kind: 'welcome',
        id: msg.id,
        tick: num(msg.tick),
        spawn: normPos(msg.spawn),
        players: normPlayers(msg.players),
      };

    case 'state':
      return {
        kind: 'state',
        tick: num(msg.tick),
        players: normPlayers(msg.players),
      };

    case 'block':
      return {
        kind: 'block',
        by: msg.by,
        action: str(msg.action),
        pos: readPos(msg.pos),
        block: msg.block ?? null,
        seq: msg.seq === undefined ? undefined : num(msg.seq),
      };

    case 'chat':
      return {
        kind: 'chat',
        from: msg.from,
        text: str(msg.text),
      };

    case 'pong':
      return {
        kind: 'pong',
        ts: num(msg.ts),
      };

    case 'error':
      return {
        kind: 'error',
        code: msg.code,
        msg: str(msg.msg),
      };

    default:
      // Recognized JSON object but no known `t` tag.
      return { kind: 'unknown', raw: text };
  }
}

/**
 * Normalize a players array from a welcome/state frame into a stable shape:
 *   [{id, pos, yaw, seq}]
 * Tolerates a missing / non-array `players` (→ []) and skips non-object entries.
 * `pos` uses the pass-through reader so odd server data stays inspectable.
 */
function normPlayers(players) {
  if (!Array.isArray(players)) return [];
  const out = [];
  for (const p of players) {
    if (!isObj(p)) continue;
    out.push({
      id: p.id,
      pos: readPos(p.pos),
      yaw: num(p.yaw),
      seq: p.seq === undefined ? undefined : num(p.seq),
    });
  }
  return out;
}

/* =========================================================================
 * Harness helper: extract per-player latest sequence numbers for drop /
 * out-of-order / propagation tracking.
 * ========================================================================= */

/**
 * Given a decoded (or raw) welcome/state object, return [{id, seq, pos}] for
 * every player it carries. Defensive: accepts a normalized object, a raw parsed
 * object, or even a JSON string; anything without a usable players list → [].
 *
 * @param {object|string} stateOrWelcome
 * @returns {Array<{id:any, seq:number|undefined, pos:any}>}
 */
export function extractPlayerSeqs(stateOrWelcome) {
  let obj = stateOrWelcome;

  // Accept a JSON string or a raw server frame by running it through decode.
  if (typeof obj === 'string') {
    obj = decode(obj);
  }
  if (!isObj(obj)) return [];

  const players = Array.isArray(obj.players) ? obj.players : null;
  if (!players) return [];

  const out = [];
  for (const p of players) {
    if (!isObj(p)) continue;
    out.push({
      id: p.id,
      seq: p.seq === undefined ? undefined : num(p.seq),
      pos: readPos(p.pos),
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * SELF-CHECK (informal — no test framework, dependency-free):
 *   decode('nonsense')                       -> {kind:"unknown", raw:"nonsense"}
 *   decode('123')                            -> {kind:"unknown", ...} (not an object)
 *   decode('{"t":"pong","ts":42}')           -> {kind:"pong", ts:42}
 *   decode(Buffer.from('{"t":"chat","from":1,"text":"hi"}'))
 *                                            -> {kind:"chat", from:1, text:"hi"}
 *   encMove({seq:5,pos:{x:1,y:2,z:3},yaw:90}) -> '{"t":"move","seq":5,"pos":{"x":1,"y":2,"z":3},"yaw":90,"pitch":0}'
 *   extractPlayerSeqs(decode('{"t":"state","players":[{"id":1,"seq":7}]}'))
 *                                            -> [{id:1, seq:7, pos:{x:0,y:0,z:0}}]
 * All encoders round-trip through JSON.stringify without throwing on junk input.
 * ------------------------------------------------------------------------- */
