/**
 * ADAPTER — matches Voxelheim docs/PROTOCOL.md v1. This + mock-server.mjs are the
 * only protocol-specific files; transport + harness measurement are generic via CAPS.
 *
 * ---------------------------------------------------------------------------
 * REAL PROTOCOL — "Voxelheim"
 *
 * WIRE: UTF-8 JSON text frames. Every message carries a short string tag under
 * key "t". Client->server encoders return a JSON *string* ready for WSConn.send().
 * Server->client frames are turned by decode() into a normalized {kind, ...}
 * object where `kind` is the friendly name of `t`.
 *
 * HANDSHAKE: open socket -> send {t:"join", worldId, name, dim}
 *            -> receive {t:"welcome", id:"p<N>", world:{...}, peers:[...]}.
 *   worldId must match ^[A-Za-z0-9_-]{1,64}$ (unknown id auto-created).
 *   dim in {"overworld","nether","end"}. Until a valid join, all other frames
 *   are silently ignored by the server.
 *
 * CLIENT->SERVER:
 *   move  {t:"move", x,y,z, yaw, pitch, dim}   floats; NO seq/tick/timestamp field.
 *   edit  {t:"edit", x,y,z, block, dim}        ints; 0<=y<128, 0<=block<=40;
 *                                              block===0 => BREAK, 1..40 => place.
 *   chat  {t:"chat", text}                     trimmed, <=256 chars, empty dropped;
 *                                              echoes to WHOLE room INCLUDING sender.
 *   NO client-side ping. Keepalive is a WS control-frame pong (ws auto-answers a
 *   server ping every 30s); encPing() therefore returns null so callers skip it.
 *
 * SERVER->CLIENT (decode() kinds): welcome | peer-join | peer-leave | move | edit
 *   | chat | error | unknown. error codes: bad_join|already_joined|bad_edit|bad_world.
 *
 * CORRELATION (protocol has NO seq field and NO app ping — smuggle into forwarded
 * fields; see CAPS):
 *   - RTT: chat self-echo. A bot sends chat text "rtt:<botIdx>:<seq>:<sendMs>"; on
 *     receiving a chat whose id === my welcome id AND text decodes to my botIdx,
 *     RTT = now - sendMs. (encRttChat / matchRttEcho)
 *   - PROPAGATION / DROP / OUT-OF-ORDER: a monotonic per-bot moveSeq is smuggled
 *     into the forwarded `pitch` field (finite float, forwarded verbatim, NOT
 *     range-validated). readMoveSeq(move) recovers it as Math.round(pitch).
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
 * Capability descriptor. The generic transport + measurement layers read these
 * flags so the ONLY protocol-specific code lives here and in the mock server.
 */
export const CAPS = {
  appPing: false, // no client-side ping message; keepalive is WS pong
  selfEchoChat: true, // chat echoes to the whole room INCLUDING the sender
  moveSeqCarrier: 'pitch', // per-bot moveSeq is smuggled into the forwarded pitch
  sameDimBroadcast: true, // move/edit broadcast to same-dim recipients only
  dim: 'overworld', // dimension every load-test bot shares so all moves broadcast
  wsPath: '/ws', // literal WS path
  defaultPort: 3000, // default server port (env PORT on the server side)
  worldIdPattern: '^[A-Za-z0-9_-]{1,64}$', // valid worldId regex (unknown -> created)
};

/**
 * Default server URL. ws://127.0.0.1:(GAME_PORT||3000)/ws
 * Path is the literal "/ws" the real server listens on.
 */
export function defaultUrl() {
  const port = process.env.GAME_PORT || CAPS.defaultPort;
  return `ws://127.0.0.1:${port}${CAPS.wsPath}`;
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

/** Coerce to a finite integer, else fall back (default 0). */
function int(v, fallback = 0) {
  return Math.round(num(v, fallback));
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
 * Normalize a position input to finite {x,y,z}. Accepts either a flat object
 * carrying x/y/z, or a nested {pos:{x,y,z}}. Missing components default to 0.
 */
function normPos(p) {
  if (!isObj(p)) return { x: 0, y: 0, z: 0 };
  const src = isObj(p.pos) ? p.pos : p;
  return { x: num(src.x), y: num(src.y), z: num(src.z) };
}

/* =========================================================================
 * CLIENT -> SERVER encoders. Each returns a JSON string (encPing returns null).
 * ========================================================================= */

/**
 * Join request. -> {"t":"join","worldId":..,"name":..,"dim":..}
 * worldId defaults to "loadtest" (matches ^[A-Za-z0-9_-]{1,64}$); dim defaults
 * to "overworld". The server auto-creates an unknown worldId.
 */
export function encJoin({ name, worldId = 'loadtest', dim = 'overworld' } = {}) {
  return JSON.stringify({
    t: 'join',
    worldId: str(worldId, 'loadtest'),
    name: str(name, 'bot'),
    dim: str(dim, 'overworld'),
  });
}

/**
 * Movement update. -> {"t":"move","x":..,"y":..,"z":..,"yaw":..,"pitch":seq,"dim":..}
 * There is NO seq field on the wire: the monotonic per-bot `seq` is smuggled into
 * `pitch` (a finite float the server forwards verbatim without range-validating).
 * The real x,y,z random-walk position and a real yaw heading are preserved.
 */
export function encMove({ seq, pos, yaw = 0, dim = 'overworld' } = {}) {
  const p = normPos(pos);
  return JSON.stringify({
    t: 'move',
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: num(yaw),
    pitch: num(seq), // <- moveSeq carrier
    dim: str(dim, 'overworld'),
  });
}

/**
 * Block place/break. -> {"t":"edit","x":..,"y":..,"z":..,"block":..,"dim":..}
 * Coords are ints; block===0 means BREAK, 1..40 means place. The `action` verb
 * ("break"|"place") maps onto that block id: break -> 0, else the supplied block.
 */
export function encEdit({ action, pos, block = 1, dim = 'overworld' } = {}) {
  const p = normPos(pos);
  const b = action === 'break' ? 0 : int(block, 1);
  return JSON.stringify({
    t: 'edit',
    x: int(p.x),
    y: int(p.y),
    z: int(p.z),
    block: b,
    dim: str(dim, 'overworld'),
  });
}

/** Back-compat alias: existing callers import `encBlock`. */
export const encBlock = encEdit;

/** Chat message. -> {"t":"chat","text":<string>} (server trims + caps at 256). */
export function encChat({ text } = {}) {
  return JSON.stringify({ t: 'chat', text: str(text) });
}

/**
 * Correlation chat for RTT: a chat frame whose text encodes {botIdx, seq, ts}.
 * -> {"t":"chat","text":"rtt:<botIdx>:<seq>:<ts>"}. Because chat self-echoes,
 * the sender receives it back and computes RTT = now - ts. See matchRttEcho().
 */
export function encRttChat({ botIdx, seq, ts } = {}) {
  const text = `rtt:${int(botIdx)}:${int(seq)}:${num(ts)}`;
  return encChat({ text });
}

/**
 * No application-level ping exists in this protocol; keepalive is the WS pong.
 * Returns null so generic callers can detect "no app ping" and skip sending.
 */
export function encPing(_) {
  return null;
}

/* =========================================================================
 * SERVER -> CLIENT decode. Never throws.
 * Returns a normalized {kind, ...} object. Recognized kinds:
 *   welcome | peer-join | peer-leave | move | edit | chat | error | unknown
 * ========================================================================= */

/**
 * Normalize one entity/peer frame's spatial fields onto a flat record plus a
 * convenience `pos`. Surfaces id, name, x,y,z, yaw, pitch, dim when present.
 */
function entity(msg) {
  const p = normPos(msg);
  return {
    id: msg.id,
    name: msg.name === undefined || msg.name === null ? undefined : str(msg.name),
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: num(msg.yaw),
    pitch: num(msg.pitch),
    dim: msg.dim === undefined ? undefined : str(msg.dim),
    pos: p,
  };
}

/** Normalize a welcome.peers array into flat entity records (skips non-objects). */
function normPeers(peers) {
  if (!Array.isArray(peers)) return [];
  const out = [];
  for (const p of peers) {
    if (!isObj(p)) continue;
    out.push(entity(p));
  }
  return out;
}

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
    // Buffer / Uint8Array / other -> best-effort UTF-8 string.
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
    // Valid JSON but not an object (number, string, array, null) -> unknown.
    return { kind: 'unknown', raw: text };
  }

  switch (msg.t) {
    case 'welcome':
      return {
        kind: 'welcome',
        id: msg.id,
        world: msg.world,
        peers: normPeers(msg.peers),
      };

    case 'peer-join':
      // Upsert; also emitted on a peer's dim-change.
      return { kind: 'peer-join', ...entity(msg) };

    case 'peer-leave':
      return { kind: 'peer-leave', id: msg.id };

    case 'move':
      return { kind: 'move', ...entity(msg) };

    case 'edit': {
      const p = normPos(msg);
      return {
        kind: 'edit',
        id: msg.id,
        x: int(p.x),
        y: int(p.y),
        z: int(p.z),
        block: int(msg.block),
        dim: msg.dim === undefined ? undefined : str(msg.dim),
        pos: p,
      };
    }

    case 'chat':
      return {
        kind: 'chat',
        id: msg.id,
        name: msg.name === undefined ? undefined : str(msg.name),
        text: str(msg.text),
      };

    case 'error':
      return {
        kind: 'error',
        code: msg.code,
        message: str(msg.message),
      };

    default:
      // Recognized JSON object but no known `t` tag.
      return { kind: 'unknown', raw: text };
  }
}

/* =========================================================================
 * Harness correlation helpers.
 * ========================================================================= */

/**
 * Recover the smuggled monotonic moveSeq from a decoded move frame. The seq was
 * placed in `pitch` on send; read it back as a rounded integer. Non-finite -> 0.
 * @param {object} decodedMove
 * @returns {number} integer sequence
 */
export function readMoveSeq(decodedMove) {
  if (!isObj(decodedMove)) return 0;
  return int(decodedMove.pitch, 0);
}

/**
 * If a decoded chat frame is this bot's own RTT self-echo, return its payload.
 * Only matches when decodedChat.id === myId AND text is "rtt:<botIdx>:<seq>:<ts>".
 * @param {object} decodedChat  a decode()'d chat frame
 * @param {*} myId              this bot's welcome id (e.g. "p7")
 * @returns {{botIdx:number, seq:number, ts:number}|null}
 */
export function matchRttEcho(decodedChat, myId) {
  if (!isObj(decodedChat)) return null;
  if (decodedChat.kind !== undefined && decodedChat.kind !== 'chat') return null;
  if (decodedChat.id !== myId) return null;
  const text = str(decodedChat.text);
  const m = /^rtt:(-?\d+):(-?\d+):(-?\d+(?:\.\d+)?)$/.exec(text);
  if (!m) return null;
  return { botIdx: Number(m[1]), seq: Number(m[2]), ts: Number(m[3]) };
}

/**
 * Extract per-player {id, seq, pos} for drop / out-of-order / propagation
 * tracking. Accepts either a decoded welcome (uses welcome.peers; seq unknown so
 * 0) or a decoded move (single entry, seq = readMoveSeq). Also tolerates a raw
 * JSON string or raw parsed frame by running it through decode(). Anything
 * without usable player data -> [].
 *
 * @param {object|string} welcomeOrMove
 * @returns {Array<{id:any, seq:number, pos:{x:number,y:number,z:number}}>}
 */
export function extractPlayerSeqs(welcomeOrMove) {
  let obj = welcomeOrMove;

  // Accept a JSON string or a raw (undecoded) server frame.
  if (typeof obj === 'string') {
    obj = decode(obj);
  } else if (isObj(obj) && obj.kind === undefined && 't' in obj) {
    obj = decode(JSON.stringify(obj));
  }
  if (!isObj(obj)) return [];

  // A single move frame -> one player entry with the smuggled seq.
  if (obj.kind === 'move') {
    return [{ id: obj.id, seq: readMoveSeq(obj), pos: normPos(obj) }];
  }

  // A welcome (or anything carrying a peers array) -> one entry per peer.
  if (Array.isArray(obj.peers)) {
    const out = [];
    for (const p of obj.peers) {
      if (!isObj(p)) continue;
      out.push({ id: p.id, seq: 0, pos: normPos(p) }); // welcome carries no seq
    }
    return out;
  }

  return [];
}

/* ---------------------------------------------------------------------------
 * SELF-CHECK (informal — no test framework, dependency-free):
 *   decode('nonsense')                  -> {kind:"unknown", raw:"nonsense"}
 *   decode('123')                       -> {kind:"unknown", ...} (not an object)
 *   decode('{"t":"welcome","id":"p1","peers":[{"id":"p2","x":1,"y":2,"z":3}]}')
 *                                       -> {kind:"welcome", id:"p1", peers:[...]}
 *   decode('{"t":"move","id":"p2","x":1,"y":2,"z":3,"yaw":90,"pitch":7,"dim":"overworld"}')
 *                                       -> {kind:"move", id:"p2", pitch:7, ...}
 *   readMoveSeq(decode('{"t":"move","pitch":7.4}'))                 -> 7
 *   matchRttEcho(decode('{"t":"chat","id":"p1","text":"rtt:3:9:1000"}'), "p1")
 *                                       -> {botIdx:3, seq:9, ts:1000}
 *   encMove({seq:5,pos:{x:1,y:2,z:3},yaw:90}) ->
 *     '{"t":"move","x":1,"y":2,"z":3,"yaw":90,"pitch":5,"dim":"overworld"}'
 *   encEdit({action:"break",pos:{x:1,y:2,z:3}}) ->
 *     '{"t":"edit","x":1,"y":2,"z":3,"block":0,"dim":"overworld"}'
 *   encPing()                           -> null
 * All encoders round-trip through JSON.stringify without throwing on junk input.
 * ------------------------------------------------------------------------- */
