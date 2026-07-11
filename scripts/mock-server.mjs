#!/usr/bin/env node
/**
 * mock-server.mjs — reference authoritative multiplayer server for the harness.
 *
 * WHY THIS EXISTS
 * The builder has not shipped a real multiplayer server yet, so the load/chaos
 * harness needs something real to run against TODAY. This process implements the
 * exact wire protocol defined in scripts/lib/protocol.mjs, on top of the
 * dependency-free WebSocket transport in scripts/lib/ws-transport.mjs. It is the
 * reference the real server should match: it is authoritative (assigns ids,
 * tracks player state, broadcasts world state at ~20 Hz) and — critically — it is
 * hardened so that NO malformed / oversized / type-confused / flooding client can
 * crash it or degrade service for well-behaved clients.
 *
 * It SENDS the server->client shapes that protocol.decode() expects
 *   welcome | state | block | chat | pong | error
 * and READS the client->server shapes the encoders produce
 *   join | move | block | chat | ping
 * building outgoing frames as plain JSON objects matching the decode contract.
 *
 * ROBUSTNESS MODEL (this is also the spec the builder's server must satisfy):
 *   - Every inbound message is validated field-by-field inside try/catch; a handler
 *     bug can never throw out of the server.
 *   - Bad input -> a small {"t":"error"} reply + a per-connection strike; after
 *     MAX_STRIKES strikes the offending connection is sandbox-closed (code 1008).
 *   - A per-connection flood (> FLOOD_MSGS_PER_SEC msgs/sec) is sandbox-closed too.
 *   - Sandboxing is strictly per-connection: other clients are never affected.
 *   - Sends are bounded: broadcasts/state are DROPPED to a backpressured (slow /
 *     non-reading) socket rather than buffered unbounded, so a slow reader cannot
 *     grow the server's memory without limit.
 *
 * CONFIG (env):
 *   GAME_PORT         listen port          (default 8080)
 *   GAME_WS_PATH      websocket path       (default "/")
 *   GAME_MAX_PAYLOAD  max frame bytes      (default 1<<20 = 1 MiB)
 *
 * CLI:
 *   node scripts/mock-server.mjs            start the server
 *   node scripts/mock-server.mjs --selftest verify outgoing frames decode() cleanly
 *
 * On listen it prints exactly one line the harnesses wait for (or they poll port):
 *   MOCK-SERVER READY port=<port> path=<path>
 *
 * No module exports — this is a runnable CLI. Importing it is side-effect-free
 * (the server only boots when run as the main module).
 */

import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { wsCreateServer, OPEN } from './lib/ws-transport.mjs';
import { PROTOCOL_VERSION, decode } from './lib/protocol.mjs';

/* =========================================================================
 * Tunables (all conservative; documented above where env-driven).
 * ========================================================================= */
const TICK_MS = 50;                 // ~20 Hz world-state broadcast
const MAX_STRIKES = 10;             // protocol violations before sandbox close
const FLOOD_MSGS_PER_SEC = 200;     // per-conn message rate ceiling -> sandbox
const MAX_MSG_BYTES = 64 * 1024;    // app-level per-message text cap (well under maxPayload)
const MAX_NAME_LEN = 32;            // join name length cap
const MAX_CHAT_LEN = 512;           // chat text length cap
const MAX_BLOCK_STR = 64;           // block-id string length cap
const WORLD_BOUND = 1e7;            // clamp positions into a sane finite range
const SLOW_READER_LIMIT = 1 << 20;  // >1 MiB queued -> DROP broadcasts/state to that conn
const HARD_SEND_LIMIT = 8 << 20;    // never buffer even control replies past 8 MiB

/* =========================================================================
 * Server state.
 * ========================================================================= */
/** @type {Map<number, {id:number,name:string,pos:{x:number,y:number,z:number},yaw:number,pitch:number,seq:number}>} */
const players = new Map();
/** Per-connection bookkeeping, keyed weakly so it is GC'd with the connection. */
const connState = new WeakMap();

let server = null;      // the WSServer (set in main)
let tickTimer = null;   // the 20 Hz broadcast interval
let nextId = 1;         // monotonically increasing player id
let tick = 0;           // world tick counter (advances each broadcast)

const nowMs = () => performance.now();

/* =========================================================================
 * Env / config resolution (defensive: bad env falls back to defaults).
 * ========================================================================= */
function resolvePort() {
  const raw = process.env.GAME_PORT;
  const n = raw === undefined || raw === '' ? 8080 : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 8080;
}
function resolvePath() {
  let p = process.env.GAME_WS_PATH;
  if (typeof p !== 'string' || p.length === 0) p = '/';
  if (p[0] !== '/') p = '/' + p;
  return p;
}
function resolveMaxPayload() {
  const raw = process.env.GAME_MAX_PAYLOAD;
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
function clampNum(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}
/** Require an {x,y,z} object of finite numbers; returns a clamped copy or null. */
function readVec(p) {
  if (!isPlainObject(p)) return null;
  if (!finiteNum(p.x) || !finiteNum(p.y) || !finiteNum(p.z)) return null;
  return {
    x: clampNum(p.x, -WORLD_BOUND, WORLD_BOUND),
    y: clampNum(p.y, -WORLD_BOUND, WORLD_BOUND),
    z: clampNum(p.z, -WORLD_BOUND, WORLD_BOUND),
  };
}
/** Deterministic, slightly-spread spawn so players don't all overlap at origin. */
function spawnFor(id) {
  return { x: (id % 16) * 2, y: 64, z: (Math.floor(id / 16) % 16) * 2 };
}

/* =========================================================================
 * Bounded, exception-proof sending.
 *   - `limit`: skip the send if the socket already has more than this many bytes
 *     queued (backpressure). State/broadcasts use SLOW_READER_LIMIT (drop early);
 *     control replies use HARD_SEND_LIMIT (send unless truly runaway).
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

function sendError(conn, code, msg) {
  // Control reply: send unless the socket is truly runaway (never buffer unbounded).
  safeSend(conn, JSON.stringify({ t: 'error', code, msg }), HARD_SEND_LIMIT);
}

/** Record a protocol violation; sandbox the connection once it exhausts strikes. */
function strike(conn, code, msg) {
  const st = connState.get(conn);
  if (!st || st.sandboxed) return;
  st.strikes++;
  sendError(conn, code, msg);
  if (st.strikes >= MAX_STRIKES) sandbox(conn, 'too many protocol violations');
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

/** Broadcast a prebuilt JSON string to every joined, healthy client. */
function broadcast(str, exceptConn = null) {
  if (!server) return;
  for (const conn of server.clients) {
    if (conn === exceptConn) continue;
    const st = connState.get(conn);
    if (!st || !st.joined || st.sandboxed) continue;
    safeSend(conn, str, SLOW_READER_LIMIT); // drop to backpressured clients
  }
}

/** Snapshot the current players array in the server->client `state` shape. */
function playersSnapshot(excludeId) {
  const out = [];
  for (const p of players.values()) {
    if (p.id === excludeId) continue;
    out.push({ id: p.id, pos: p.pos, yaw: p.yaw, seq: p.seq });
  }
  return out;
}

/* =========================================================================
 * Per-message handlers. Each validates every field and never throws.
 * ========================================================================= */

function handleJoin(conn, st, msg) {
  // Idempotent: a duplicate join just re-sends the current welcome, no new id.
  if (st.joined) {
    safeSend(
      conn,
      JSON.stringify({
        t: 'welcome',
        v: PROTOCOL_VERSION,
        id: st.id,
        tick,
        spawn: spawnFor(st.id),
        players: playersSnapshot(st.id),
      }),
      HARD_SEND_LIMIT,
    );
    return;
  }

  let name = 'anon';
  if (msg.name !== undefined) {
    if (typeof msg.name !== 'string') {
      strike(conn, 'bad_field', 'name must be a string');
      return;
    }
    name = msg.name.slice(0, MAX_NAME_LEN);
  }
  // Protocol version is advisory here — the mock is lenient and accepts mismatches.

  const id = nextId++;
  const spawn = spawnFor(id);
  const player = { id, name, pos: { ...spawn }, yaw: 0, pitch: 0, seq: -1 };

  const others = playersSnapshot(); // snapshot BEFORE adding self
  players.set(id, player);
  st.joined = true;
  st.id = id;
  st.player = player;

  safeSend(
    conn,
    JSON.stringify({ t: 'welcome', v: PROTOCOL_VERSION, id, tick, spawn, players: others }),
    HARD_SEND_LIMIT,
  );
}

function handleMove(conn, st, msg) {
  if (!st.joined || !st.player) {
    sendError(conn, 'not_joined', 'join before moving');
    return;
  }
  if (!finiteNum(msg.seq)) {
    strike(conn, 'bad_field', 'seq must be a finite number');
    return;
  }
  const pos = readVec(msg.pos);
  if (!pos) {
    strike(conn, 'bad_field', 'pos must be {x,y,z} finite numbers');
    return;
  }
  const p = st.player;
  // Monotonic guard: silently ignore stale / duplicate updates (normal in flow).
  if (msg.seq <= p.seq) return;

  p.pos = pos;
  p.seq = msg.seq;
  if (finiteNum(msg.yaw)) p.yaw = clampNum(msg.yaw, -1e5, 1e5);
  if (finiteNum(msg.pitch)) p.pitch = clampNum(msg.pitch, -90, 90);
}

function handleBlock(conn, st, msg) {
  if (!st.joined || !st.player) {
    sendError(conn, 'not_joined', 'join before editing blocks');
    return;
  }
  if (msg.action !== 'place' && msg.action !== 'break') {
    strike(conn, 'bad_field', 'action must be "place" or "break"');
    return;
  }
  const pos = readVec(msg.pos);
  if (!pos) {
    strike(conn, 'bad_field', 'pos must be {x,y,z} finite numbers');
    return;
  }
  // Accept only small primitive block ids; reject/normalize anything heavy.
  let block = msg.block;
  if (block === undefined || block === null) {
    block = null;
  } else if (typeof block === 'string') {
    if (block.length > MAX_BLOCK_STR) block = block.slice(0, MAX_BLOCK_STR);
  } else if (typeof block === 'number' || typeof block === 'boolean') {
    /* ok as-is */
  } else {
    block = null; // objects/arrays are not valid block ids
  }

  broadcast(
    JSON.stringify({ t: 'block', by: st.id, action: msg.action, pos, block, seq: st.player.seq }),
  );
}

function handleChat(conn, st, msg) {
  if (!st.joined) {
    sendError(conn, 'not_joined', 'join before chatting');
    return;
  }
  if (typeof msg.text !== 'string') {
    strike(conn, 'bad_field', 'text must be a string');
    return;
  }
  broadcast(JSON.stringify({ t: 'chat', from: st.id, text: msg.text.slice(0, MAX_CHAT_LEN) }));
}

function handlePing(conn, st, msg) {
  // Reply IMMEDIATELY, echoing the client's ts for RTT. Works even before join
  // so a latency canary stays responsive. Not skipped on mild backpressure.
  const ts = finiteNum(msg.ts) ? msg.ts : 0;
  safeSend(conn, JSON.stringify({ t: 'pong', ts }), HARD_SEND_LIMIT);
}

/* =========================================================================
 * Inbound message dispatch — the outermost defensive shell.
 * ========================================================================= */
function onMessage(conn, data, isBinary) {
  const st = connState.get(conn);
  if (!st || st.sandboxed) return; // already isolated: drop everything

  try {
    // --- per-connection rate limiting (sliding 1s window) --------------------
    const t = nowMs();
    if (t - st.winStart >= 1000) {
      st.winStart = t;
      st.winCount = 0;
    }
    st.winCount++;
    st.msgTotal++;
    if (st.winCount > FLOOD_MSGS_PER_SEC) {
      sandbox(conn, 'message rate limit exceeded');
      return;
    }

    // --- frame/type gating ---------------------------------------------------
    if (isBinary) {
      strike(conn, 'bad_frame', 'binary frames are not supported (protocol is JSON text)');
      return;
    }
    if (typeof data !== 'string') {
      strike(conn, 'bad_frame', 'expected a text frame');
      return;
    }
    if (data.length > MAX_MSG_BYTES) {
      strike(conn, 'too_large', 'message exceeds size limit');
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      strike(conn, 'bad_json', 'message is not valid JSON');
      return;
    }
    if (!isPlainObject(msg)) {
      strike(conn, 'bad_shape', 'message must be a JSON object');
      return;
    }
    if (typeof msg.t !== 'string') {
      strike(conn, 'bad_type', 'field "t" must be a string');
      return;
    }

    // --- dispatch ------------------------------------------------------------
    switch (msg.t) {
      case 'join':
        handleJoin(conn, st, msg);
        break;
      case 'move':
        handleMove(conn, st, msg);
        break;
      case 'block':
        handleBlock(conn, st, msg);
        break;
      case 'chat':
        handleChat(conn, st, msg);
        break;
      case 'ping':
        handlePing(conn, st, msg);
        break;
      default:
        strike(conn, 'unknown_type', `unknown message type: ${msg.t}`);
    }
  } catch {
    // Absolute backstop: a handler bug must never crash the server or a peer.
    try {
      sendError(conn, 'internal', 'internal server error');
    } catch {
      /* ignore */
    }
  }
}

/* =========================================================================
 * 20 Hz world-state broadcast. Builds the payload ONCE per tick and fans it
 * out; drops to any backpressured (slow) reader so memory stays bounded.
 * ========================================================================= */
function startTick() {
  const timer = setInterval(() => {
    try {
      tick++;
      const arr = [];
      for (const p of players.values()) {
        arr.push({ id: p.id, pos: p.pos, yaw: p.yaw, seq: p.seq });
      }
      const str = JSON.stringify({ t: 'state', tick, players: arr });
      if (!server) return;
      for (const conn of server.clients) {
        const st = connState.get(conn);
        if (!st || !st.joined || st.sandboxed) continue;
        safeSend(conn, str, SLOW_READER_LIMIT);
      }
    } catch {
      /* the tick loop must never throw */
    }
  }, TICK_MS);
  if (timer.unref) timer.unref(); // don't keep the process alive solely for ticks
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
      sandboxed: false,
      strikes: 0,
      winStart: nowMs(),
      winCount: 0,
      msgTotal: 0,
    });
    conn.on('message', (data, isBinary) => onMessage(conn, data, isBinary));
    // Attach an error listener so the transport never treats errors as unhandled;
    // the socket 'close' that follows drives cleanup below.
    conn.on('error', () => {});
    conn.on('close', () => {
      const st = connState.get(conn);
      if (st && st.id != null) players.delete(st.id);
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
    if (tickTimer) clearInterval(tickTimer);
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
    tickTimer = startTick();
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
 * --selftest: prove every server->client frame this file builds is recognized
 * by protocol.decode() (i.e. we speak the exact wire contract the clients read).
 * ========================================================================= */
function runSelfCheck() {
  const cases = [
    [JSON.stringify({ t: 'welcome', v: PROTOCOL_VERSION, id: 1, tick: 0, spawn: { x: 0, y: 64, z: 0 }, players: [] }), 'welcome'],
    [JSON.stringify({ t: 'state', tick: 1, players: [{ id: 1, pos: { x: 0, y: 0, z: 0 }, yaw: 0, seq: 0 }] }), 'state'],
    [JSON.stringify({ t: 'block', by: 1, action: 'place', pos: { x: 0, y: 0, z: 0 }, block: 'stone', seq: 2 }), 'block'],
    [JSON.stringify({ t: 'chat', from: 1, text: 'hi' }), 'chat'],
    [JSON.stringify({ t: 'pong', ts: 42 }), 'pong'],
    [JSON.stringify({ t: 'error', code: 'x', msg: 'y' }), 'error'],
  ];
  for (const [wire, expected] of cases) {
    const d = decode(wire);
    if (!d || d.kind !== expected) {
      console.error(`SELFTEST FAIL: ${wire} -> kind=${d && d.kind}, expected ${expected}`);
      process.exit(1);
    }
  }
  console.log('MOCK-SERVER SELFTEST OK');
  process.exit(0);
}

/* Run only when invoked directly (import stays side-effect-free). */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (process.argv.includes('--selftest')) runSelfCheck();
  else main();
}
