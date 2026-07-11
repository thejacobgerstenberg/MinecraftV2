#!/usr/bin/env node
/**
 * mock-server.mjs — reference authoritative "Voxelheim" multiplayer server.
 *
 * FAITHFUL STAND-IN for the real server (docs/PROTOCOL.md v1 on branch
 * feat/voxel-sandbox-game). It speaks the EXACT real wire protocol so the CI
 * self-test, the protocol adapter (scripts/lib/protocol.mjs) and the load/chaos
 * harness stay valid TODAY, without needing the real game checked out. It runs on
 * top of the dependency-free WebSocket transport in scripts/lib/ws-transport.mjs.
 *
 * REAL PROTOCOL — message shapes match Voxelheim exactly:
 *
 *   CLIENT -> SERVER (this server READS):
 *     join : {t:"join", worldId, name, dim}
 *     move : {t:"move", x,y,z, yaw, pitch, dim}   (floats; non-finite x/y/z dropped)
 *     edit : {t:"edit", x,y,z, block, dim}         (ints; 0<=y<128, 0<=block<=40)
 *     chat : {t:"chat", text}                      (trimmed, <=256, empty dropped)
 *     (there is NO client ping message; keepalive is a WS control-frame pong)
 *
 *   SERVER -> CLIENT (this server SENDS):
 *     welcome   : {t:"welcome", id:"p<N>", world:{...}, peers:[...]}
 *     peer-join : {t:"peer-join", id, name, x,y,z, yaw, dim}  (upsert; also on dim-change)
 *     peer-leave: {t:"peer-leave", id}
 *     move      : {t:"move", id, x,y,z, yaw, pitch, dim}      (same-dim recipients only)
 *     edit      : {t:"edit", id, x,y,z, block, dim}           (same-dim only)
 *     chat      : {t:"chat", id, name, text}                  (whole room INCL. sender)
 *     error     : {t:"error", code, message}   code ∈ bad_join|already_joined|bad_edit|bad_world
 *
 * ROOM MODEL: players are grouped by (worldId). A "room" is a whole world (all
 * dimensions); move/edit forwarding is scoped to same (worldId, dim); chat and
 * peer-join/peer-leave are room-wide (cross-dimension). The move handler forwards
 * the client's `pitch` VERBATIM (it is not range-validated) — the harness smuggles
 * a monotonic per-bot seq into pitch for propagation/drop/out-of-order tracking,
 * and chat echoes to the sender so RTT can be measured off the self-echo.
 *
 * FAITHFUL ROBUSTNESS (mirrors the real server's observed behavior):
 *   - invalid JSON / non-object / missing `t` / pre-join / unknown `t`  ->  SILENTLY
 *     ignored (no error frame, no close). Only bad_join/already_joined/bad_edit/
 *     bad_world produce an {t:"error"} frame; the socket always stays open.
 *   - keepalive is a server-initiated WS ping (~2s here, short so tests are quick);
 *     a connection that misses its pong is terminate()'d (heartbeat failure is the
 *     only disconnect path).
 *
 * REFERENCE-OF-GOOD-BEHAVIOR extras (do NOT change message shapes; the real server
 * lacks these, and the target-agnostic chaos test records their ABSENCE against the
 * real server as a vulnerability rather than a failure):
 *   - a sane per-message size cap via the transport's maxPayload (oversized frames
 *     are closed with 1009 instead of buffered — the real server has a 100 MiB ws
 *     default and no app cap);
 *   - a per-connection flood ceiling that sandbox-closes a single abuser (code 1008)
 *     without ever affecting well-behaved peers (the real server has no rate limit).
 *
 * CONFIG (env):
 *   PORT / GAME_PORT   listen port    (default 3000; GAME_PORT wins so the harness
 *                                      can pin GAME_PORT=0 for an ephemeral port)
 *   GAME_WS_PATH       websocket path (default "/ws")
 *   MOCK_MAX_PAYLOAD   max frame bytes(default 1<<20 = 1 MiB)
 *
 * CLI:
 *   node scripts/mock-server.mjs             start the server
 *   node scripts/mock-server.mjs --selftest  verify every server->client frame shape
 *
 * On listen it prints EXACTLY the line the harnesses wait for (or they poll port):
 *   MOCK-SERVER READY port=<port> path=/ws
 *
 * No module exports — this is a runnable CLI. Importing it is side-effect-free
 * (the server only boots when run as the main module).
 */

import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { wsCreateServer, OPEN } from './lib/ws-transport.mjs';

/* =========================================================================
 * Protocol + world constants (Voxelheim; see public/src/constants.js).
 * ========================================================================= */
const PROTOCOL_VERSION = 1;
const CHUNK = 16;              // chunk footprint (16x16)
const WORLD_HEIGHT = 128;      // vertical block range [0,128)
const SEA_LEVEL = 40;          // spawn reference height
const MAX_BLOCK_ID = 40;       // 0 = break, 1..40 = place
const DIMENSIONS = new Set(['overworld', 'nether', 'end']);
const WORLD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* =========================================================================
 * Tunables. The reference-of-good-behavior extras are deliberately generous so
 * normal traffic (15 Hz move + ~1 chat/s + edit/2s per bot) never trips them.
 * ========================================================================= */
const HEARTBEAT_MS = 2000;          // server-initiated WS ping cadence (short for tests)
const FLOOD_MSGS_PER_SEC = 200;     // per-conn message-rate ceiling -> sandbox close
const MAX_NAME_LEN = 32;            // join name length cap
const MAX_CHAT_LEN = 256;           // chat text length cap (real protocol: <=256)
const SLOW_READER_LIMIT = 1 << 20;  // >1 MiB queued -> DROP broadcasts to that conn
const HARD_SEND_LIMIT = 8 << 20;    // never buffer even control replies past 8 MiB

/* =========================================================================
 * Server state.
 * ========================================================================= */
/**
 * @typedef {{id:string, name:string, worldId:string, dim:string,
 *            x:number, y:number, z:number, yaw:number, pitch:number,
 *            conn:import('./lib/ws-transport.mjs').WSConn}} Player
 */
/** @type {Map<string, Player>} keyed by player id ("p<N>"). */
const players = new Map();
/** Per-connection bookkeeping, keyed weakly so it is GC'd with the connection. */
const connState = new WeakMap();

let server = null;      // the WSServer (set in main)
let heartbeatTimer = null;
let nextId = 1;         // monotonically increasing player-id counter

const nowMs = () => performance.now();

/* =========================================================================
 * Env / config resolution (defensive: bad env falls back to defaults).
 * ========================================================================= */
function resolvePort() {
  // GAME_PORT wins (the harness pins GAME_PORT=0 for an ephemeral port); then the
  // real-server PORT convention; then the Voxelheim default of 3000.
  for (const raw of [process.env.GAME_PORT, process.env.PORT]) {
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
  }
  return 3000;
}
function resolvePath() {
  let p = process.env.GAME_WS_PATH;
  if (typeof p !== 'string' || p.length === 0) p = '/ws';
  if (p[0] !== '/') p = '/' + p;
  return p;
}
function resolveMaxPayload() {
  const raw = process.env.MOCK_MAX_PAYLOAD;
  const n = raw === undefined || raw === '' ? 1 << 20 : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1 << 20;
}

/* =========================================================================
 * Small validation helpers.
 * ========================================================================= */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function finiteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
/** Read a valid dimension from a message field, falling back to `def`. */
function readDim(v, def) {
  return typeof v === 'string' && DIMENSIONS.has(v) ? v : def;
}
/** Public snapshot of a world's constants, embedded in the welcome frame. */
function worldInfo(worldId) {
  return {
    id: worldId,
    dims: ['overworld', 'nether', 'end'],
    chunk: CHUNK,
    height: WORLD_HEIGHT,
    seaLevel: SEA_LEVEL,
    maxBlockId: MAX_BLOCK_ID,
  };
}
/** Deterministic, sane-bounded spawn: x,z ∈ [-256,256], y near sea level. */
function spawnFor(id) {
  const n = Number(String(id).slice(1)) || 0;
  return {
    x: ((n * 7) % 512) - 256,
    z: ((n * 13) % 512) - 256,
    y: SEA_LEVEL,
  };
}
/** Wire shape of a peer entry (welcome.peers[] and peer-join upserts). */
function peerOf(p) {
  return { id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, dim: p.dim };
}

/* =========================================================================
 * Bounded, exception-proof sending.
 *   `limit`: skip the send if the socket already has more than this many bytes
 *   queued. Broadcasts use SLOW_READER_LIMIT (drop early to a slow reader so a
 *   non-reading client can't grow server memory); control replies use
 *   HARD_SEND_LIMIT (send unless truly runaway).
 * ========================================================================= */
function safeSend(conn, str, limit = SLOW_READER_LIMIT) {
  try {
    if (!conn || conn.readyState !== OPEN) return false;
    if (limit != null && conn.bufferedAmount > limit) return false;
    return conn.send(str);
  } catch {
    return false;
  }
}

function sendError(conn, code, message) {
  safeSend(conn, JSON.stringify({ t: 'error', code, message: String(message || '') }), HARD_SEND_LIMIT);
}

/** Sandbox (isolate) a single misbehaving connection — never affects others. */
function sandbox(conn, reason) {
  const st = connState.get(conn);
  if (st) {
    if (st.sandboxed) return;
    st.sandboxed = true;
  }
  try {
    conn.close(1008, String(reason || 'policy').slice(0, 120));
  } catch {
    /* best-effort */
  }
}

/* =========================================================================
 * Room-scoped fan-out. Every send is bounded + exception-proof.
 * ========================================================================= */
/** Broadcast to every joined, healthy client in `worldId` (all dims). */
function broadcastToWorld(worldId, str, exceptConn = null) {
  if (!server) return;
  for (const conn of server.clients) {
    if (conn === exceptConn) continue;
    const st = connState.get(conn);
    if (!st || !st.joined || st.sandboxed || st.worldId !== worldId) continue;
    safeSend(conn, str, SLOW_READER_LIMIT);
  }
}
/** Broadcast to every joined, healthy client in the same (worldId, dim). */
function broadcastToDim(worldId, dim, str, exceptConn = null) {
  if (!server) return;
  for (const conn of server.clients) {
    if (conn === exceptConn) continue;
    const st = connState.get(conn);
    if (!st || !st.joined || st.sandboxed) continue;
    if (st.worldId !== worldId || st.dim !== dim) continue;
    safeSend(conn, str, SLOW_READER_LIMIT);
  }
}
/** Peers currently in `worldId` (all dims), excluding `exceptId`. */
function roomPeers(worldId, exceptId) {
  const out = [];
  for (const p of players.values()) {
    if (p.worldId !== worldId || p.id === exceptId) continue;
    out.push(peerOf(p));
  }
  return out;
}

/* =========================================================================
 * Per-message handlers. Each validates every field and never throws.
 * ========================================================================= */

function handleJoin(conn, st, msg) {
  if (st.joined) {
    // A second join on an already-joined socket is a protocol error (no new id).
    sendError(conn, 'already_joined', 'this connection has already joined');
    return;
  }

  // worldId — must match the public pattern; unknown ids are auto-created.
  const worldId = msg.worldId;
  if (typeof worldId !== 'string' || !WORLD_ID_RE.test(worldId)) {
    sendError(conn, 'bad_world', 'worldId must match ^[A-Za-z0-9_-]{1,64}$');
    return;
  }

  // dim — optional (defaults to overworld); if present it must be valid.
  let dim = 'overworld';
  if (msg.dim !== undefined && msg.dim !== null) {
    if (typeof msg.dim !== 'string' || !DIMENSIONS.has(msg.dim)) {
      sendError(conn, 'bad_join', 'dim must be one of overworld|nether|end');
      return;
    }
    dim = msg.dim;
  }

  // name — lenient: use it when it's a non-empty string, else a default.
  let name = 'anon';
  if (typeof msg.name === 'string' && msg.name.trim().length) {
    name = msg.name.slice(0, MAX_NAME_LEN);
  }

  const id = 'p' + nextId++;
  const spawn = spawnFor(id);
  /** @type {Player} */
  const player = {
    id, name, worldId, dim,
    x: spawn.x, y: spawn.y, z: spawn.z, yaw: 0, pitch: 0, conn,
  };

  // Snapshot existing room BEFORE adding self, so welcome.peers excludes us.
  const peers = roomPeers(worldId, null);
  players.set(id, player);
  st.joined = true;
  st.id = id;
  st.worldId = worldId;
  st.dim = dim;
  st.player = player;

  safeSend(
    conn,
    JSON.stringify({ t: 'welcome', id, world: worldInfo(worldId), peers }),
    HARD_SEND_LIMIT,
  );

  // Tell the rest of the room a peer joined (upsert on the client side).
  broadcastToWorld(
    worldId,
    JSON.stringify({ t: 'peer-join', id, name, x: player.x, y: player.y, z: player.z, yaw: player.yaw, dim }),
    conn,
  );
}

function handleMove(conn, st, msg) {
  const p = st.player;
  if (!p) return; // pre-join: silently ignored upstream, but guard anyway
  // Non-finite x/y/z are silently dropped (no error frame).
  if (!finiteNum(msg.x) || !finiteNum(msg.y) || !finiteNum(msg.z)) return;

  p.x = msg.x;
  p.y = msg.y;
  p.z = msg.z;
  if (finiteNum(msg.yaw)) p.yaw = msg.yaw;
  // pitch carries a smuggled seq — forward VERBATIM, no range validation.
  const pitch = finiteNum(msg.pitch) ? msg.pitch : 0;
  p.pitch = pitch;

  // A move may carry a dim change; if so, upsert the peer to the whole room.
  const dim = readDim(msg.dim, p.dim);
  if (dim !== p.dim) {
    p.dim = dim;
    st.dim = dim;
    broadcastToWorld(
      p.worldId,
      JSON.stringify({ t: 'peer-join', id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, dim }),
      conn,
    );
  }

  // Forward to SAME-dim recipients only (excluding the sender).
  broadcastToDim(
    p.worldId,
    p.dim,
    JSON.stringify({ t: 'move', id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch, dim: p.dim }),
    conn,
  );
}

function handleEdit(conn, st, msg) {
  const p = st.player;
  if (!p) return;
  // ints; require finite coords + 0<=y<128 and 0<=block<=40, else bad_edit.
  if (!finiteNum(msg.x) || !finiteNum(msg.y) || !finiteNum(msg.z) || !finiteNum(msg.block)) {
    sendError(conn, 'bad_edit', 'x,y,z,block must be finite numbers');
    return;
  }
  if (!(msg.y >= 0 && msg.y < WORLD_HEIGHT) || !(msg.block >= 0 && msg.block <= MAX_BLOCK_ID)) {
    sendError(conn, 'bad_edit', 'require 0<=y<128 and 0<=block<=40');
    return;
  }
  const x = Math.trunc(msg.x);
  const y = Math.trunc(msg.y);
  const z = Math.trunc(msg.z);
  const block = Math.trunc(msg.block); // 0 = break, 1..40 = place
  const dim = readDim(msg.dim, p.dim);

  // Forward to SAME-dim recipients only (excluding the sender).
  broadcastToDim(
    p.worldId,
    dim,
    JSON.stringify({ t: 'edit', id: p.id, x, y, z, block, dim }),
    conn,
  );
}

function handleChat(conn, st, msg) {
  const p = st.player;
  if (!p) return;
  if (typeof msg.text !== 'string') return; // not a chat -> silently dropped
  const text = msg.text.trim().slice(0, MAX_CHAT_LEN);
  if (text.length === 0) return;            // empty -> dropped

  // Whole room, INCLUDING the sender (RTT self-echo), crossing dimensions.
  broadcastToWorld(
    p.worldId,
    JSON.stringify({ t: 'chat', id: p.id, name: p.name, text }),
    null,
  );
}

/* =========================================================================
 * Inbound message dispatch — the outermost defensive shell.
 * ========================================================================= */
function onMessage(conn, data) {
  const st = connState.get(conn);
  if (!st || st.sandboxed) return; // already isolated: drop everything

  try {
    // --- per-connection flood ceiling (sliding 1s window) --------------------
    const t = nowMs();
    if (t - st.winStart >= 1000) {
      st.winStart = t;
      st.winCount = 0;
    }
    st.winCount++;
    if (st.winCount > FLOOD_MSGS_PER_SEC) {
      sandbox(conn, 'message rate limit exceeded');
      return;
    }

    // --- parse (faithful: anything unparseable is SILENTLY ignored) ----------
    let text;
    if (typeof data === 'string') text = data;
    else if (Buffer.isBuffer(data)) text = data.toString('utf8');
    else return; // unexpected frame type -> ignore

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // invalid JSON -> silently ignored
    }
    if (!isPlainObject(msg)) return;        // non-object -> ignored
    if (typeof msg.t !== 'string') return;  // missing/!string `t` -> ignored

    // --- pre-join gate: until a valid join, ALL other frames are ignored ------
    if (!st.joined) {
      if (msg.t === 'join') handleJoin(conn, st, msg);
      return;
    }

    // --- dispatch ------------------------------------------------------------
    switch (msg.t) {
      case 'join':
        // already joined -> the only join-time error path
        sendError(conn, 'already_joined', 'this connection has already joined');
        break;
      case 'move':
        handleMove(conn, st, msg);
        break;
      case 'edit':
        handleEdit(conn, st, msg);
        break;
      case 'chat':
        handleChat(conn, st, msg);
        break;
      default:
        // unknown `t` -> silently ignored (faithful to the real server)
        break;
    }
  } catch {
    // Absolute backstop: a handler bug must never crash the server or a peer.
  }
}

/* =========================================================================
 * Server-initiated WS heartbeat (~2s). A connection that fails to answer the
 * previous ping with a pong is terminate()'d — the ONLY disconnect path,
 * mirroring the real server's HEARTBEAT_MS keepalive (30s there, short here).
 * ========================================================================= */
function startHeartbeat() {
  const timer = setInterval(() => {
    if (!server) return;
    for (const conn of server.clients) {
      const st = connState.get(conn);
      if (!st) continue;
      if (st.isAlive === false) {
        try {
          conn.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      st.isAlive = false;
      try {
        conn.ping();
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_MS);
  if (timer.unref) timer.unref(); // don't keep the process alive solely for pings
  return timer;
}

/* =========================================================================
 * Connection lifecycle.
 * ========================================================================= */
function onConnection(conn /*, req */) {
  try {
    connState.set(conn, {
      id: null,
      player: null,
      joined: false,
      worldId: null,
      dim: null,
      sandboxed: false,
      isAlive: true,        // reset each heartbeat; set true on pong
      winStart: nowMs(),
      winCount: 0,
    });
    conn.on('message', (data) => onMessage(conn, data));
    // The transport auto-answers server pings with a pong on the client side; we
    // observe those pongs here to keep the connection marked alive.
    conn.on('pong', () => {
      const st = connState.get(conn);
      if (st) st.isAlive = true;
    });
    // Attach an error listener so the transport never treats errors as unhandled;
    // the socket 'close' that follows drives cleanup below.
    conn.on('error', () => {});
    conn.on('close', () => {
      const st = connState.get(conn);
      if (st && st.id != null) {
        players.delete(st.id);
        // Tell the rest of the room this peer left.
        if (st.worldId != null) {
          broadcastToWorld(st.worldId, JSON.stringify({ t: 'peer-leave', id: st.id }), conn);
        }
      }
      connState.delete(conn);
    });
  } catch {
    // Never let connection setup throw out of the server.
    try {
      conn.terminate();
    } catch {
      /* ignore */
    }
  }
}

/* =========================================================================
 * Clean shutdown.
 * ========================================================================= */
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  } catch {
    /* ignore */
  }
  try {
    if (server) server.close(() => process.exit(code));
    else process.exit(code);
  } catch {
    process.exit(code);
  }
  // Failsafe: force-exit if close() hangs on a stuck socket.
  const t = setTimeout(() => process.exit(code), 1500);
  if (t.unref) t.unref();
}

/* =========================================================================
 * Boot.
 * ========================================================================= */
function main() {
  const PORT = resolvePort();
  const HOST = '127.0.0.1';
  const WS_PATH = resolvePath();
  const MAX_PAYLOAD = resolveMaxPayload();

  server = wsCreateServer({ port: PORT, host: HOST, path: WS_PATH, maxPayload: MAX_PAYLOAD });

  server.on('connection', onConnection);
  server.on('error', (err) => {
    const code = err && err.code;
    try {
      console.error(`MOCK-SERVER ERROR: ${(err && err.message) || err}`);
    } catch {
      /* ignore */
    }
    // A failure to bind the port is fatal; everything else is logged and survived.
    if (code === 'EADDRINUSE' || code === 'EACCES') shutdown(1);
  });
  server.on('listening', () => {
    heartbeatTimer = startHeartbeat();
    // The harnesses wait for EXACTLY this line (or poll the port).
    console.log(`MOCK-SERVER READY port=${server.port} path=${WS_PATH}`);
  });

  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  // Last-resort guards: a stray async error must not crash the chaos target.
  process.on('uncaughtException', (err) => {
    try {
      console.error(`MOCK-SERVER uncaught: ${(err && err.message) || err}`);
    } catch {
      /* ignore */
    }
  });
  process.on('unhandledRejection', (err) => {
    try {
      console.error(`MOCK-SERVER unhandledRejection: ${(err && err.message) || err}`);
    } catch {
      /* ignore */
    }
  });
}

/* =========================================================================
 * --selftest: prove every server->client frame this file builds has the exact
 * real-protocol shape (right `t` tag + required fields). Self-contained: it does
 * NOT import the adapter, so it stays valid regardless of protocol.mjs's state.
 * ========================================================================= */
function runSelfCheck() {
  const P = SEA_LEVEL;
  const frames = [
    ['welcome', { t: 'welcome', id: 'p1', world: worldInfo('loadtest'), peers: [peerOf({ id: 'p2', name: 'x', worldId: 'loadtest', dim: 'overworld', x: 0, y: P, z: 0, yaw: 0 })] }],
    ['peer-join', { t: 'peer-join', id: 'p2', name: 'x', x: 0, y: P, z: 0, yaw: 0, dim: 'overworld' }],
    ['peer-leave', { t: 'peer-leave', id: 'p2' }],
    ['move', { t: 'move', id: 'p2', x: 1, y: P, z: 2, yaw: 90, pitch: 1234, dim: 'overworld' }],
    ['edit', { t: 'edit', id: 'p2', x: 1, y: 41, z: 2, block: 3, dim: 'overworld' }],
    ['chat', { t: 'chat', id: 'p2', name: 'x', text: 'hello' }],
    ['error', { t: 'error', code: 'bad_edit', message: 'nope' }],
  ];
  // Required keys per kind (a faithful decoder must find these present).
  const required = {
    welcome: ['id', 'world', 'peers'],
    'peer-join': ['id', 'x', 'y', 'z', 'dim'],
    'peer-leave': ['id'],
    move: ['id', 'x', 'y', 'z', 'yaw', 'pitch', 'dim'],
    edit: ['id', 'x', 'y', 'z', 'block', 'dim'],
    chat: ['id', 'name', 'text'],
    error: ['code', 'message'],
  };
  for (const [kind, obj] of frames) {
    let round;
    try {
      round = JSON.parse(JSON.stringify(obj));
    } catch {
      console.error(`SELFTEST FAIL: ${kind} frame did not serialize`);
      process.exit(1);
    }
    if (round.t !== kind) {
      console.error(`SELFTEST FAIL: ${kind} frame has t=${round.t}`);
      process.exit(1);
    }
    for (const key of required[kind]) {
      if (!(key in round)) {
        console.error(`SELFTEST FAIL: ${kind} frame missing "${key}"`);
        process.exit(1);
      }
    }
  }
  // pitch must survive as an arbitrary (non-range-validated) float carrier.
  const mv = JSON.parse(JSON.stringify(frames[3][1]));
  if (mv.pitch !== 1234) {
    console.error(`SELFTEST FAIL: move pitch carrier not preserved (got ${mv.pitch})`);
    process.exit(1);
  }
  console.log(`MOCK-SERVER SELFTEST OK (protocol v${PROTOCOL_VERSION})`);
  process.exit(0);
}

/* Run only when invoked directly (import stays side-effect-free). */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (process.argv.includes('--selftest')) runSelfCheck();
  else main();
}
