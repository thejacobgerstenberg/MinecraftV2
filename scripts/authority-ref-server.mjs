#!/usr/bin/env node
/**
 * authority-ref-server.mjs — STRICT, fully-authoritative "Voxelheim" reference server.
 *
 * This is the "reference of correct behavior": it speaks the EXACT real Voxelheim
 * wire protocol (docs/PROTOCOL.md v1 — see scripts/lib/protocol.mjs) but, unlike the
 * real server, it ENFORCES every server-authority rule the audit checks for. It is the
 * target of the CI self-test: `node scripts/authority-test.mjs --spawn` must report
 * ZERO vulnerabilities against this server (every one of the 15 authority checks PASSes).
 *
 * It is built on the dependency-free WebSocket transport (scripts/lib/ws-transport.mjs,
 * via wsCreateServer) plus a tiny node:http REST surface (GET/PUT /api/worlds/:id) served
 * on the SAME port, so a client at ws://host:PORT/ws finds REST at http://host:PORT.
 *
 * -------------------------------------------------------------------------------------
 * WIRE PROTOCOL (identical to the real server):
 *   CLIENT -> SERVER (read):
 *     join : {t:"join", worldId, name, dim}
 *     move : {t:"move", x,y,z, yaw, pitch, dim}
 *     edit : {t:"edit", x,y,z, block, dim}   (block 0 = break, 1..40 = place)
 *     chat : {t:"chat", text}
 *   SERVER -> CLIENT (send):
 *     welcome   : {t:"welcome", id:"p<N>", world:{...}, peers:[...]}
 *     peer-join : {t:"peer-join", id, name, x,y,z, yaw, dim}
 *     peer-leave: {t:"peer-leave", id}
 *     move      : {t:"move", id, x,y,z, yaw, pitch, dim}     (same-dim recipients only)
 *     edit      : {t:"edit", id, x,y,z, block, dim}          (same-dim only)
 *     chat      : {t:"chat", id, name, text}                 (whole room INCL. sender)
 *     error     : {t:"error", code, message}
 *   REST:
 *     GET  /api/worlds/:id  -> {id, name, seed, createdAt, edits:{overworld,nether,end}}
 *     PUT  /api/worlds/:id  -> bulk-write edits; REQUIRES header x-auth-token, else 403.
 *     GET  /api/health      -> {ok:true}
 *
 * -------------------------------------------------------------------------------------
 * ENFORCEMENT (the authoritative rules this reference implements):
 *   MOVE   : track each player's last authoritative (pos,time); reject a move whose implied
 *            horizontal speed exceeds the fly cap (SPEED_FLY 10.89, tolerance cap ~16 b/s);
 *            a teleport (+1000 in one msg) is rejected — server keeps the prior pos and does
 *            NOT rebroadcast. Non-finite / non-number x/y/z are dropped (never propagated).
 *   EDIT   : reach<=6 (Euclidean from authoritative pos); 0<=y<128; y==0 is bedrock (rejected);
 *            |x|,|z| <= 30,000,000; dim forced to the player's CURRENT dim (client dim ignored);
 *            block must be an integer 0..40; edit rate capped at 20/s/connection.
 *   CHAT   : length<=256; HTML-escaped (& < > " ') before broadcast; rate 3 / 2000ms/connection.
 *   NAME   : length<=32; control chars and < > stripped; de-duplicated within a room.
 *   ID     : broadcasts ALWAYS carry the server-minted id/name; client id/name fields ignored.
 *   XPORT  : maxPayload 65536 (oversized frames closed 1009); per-connection message-rate
 *            strike closes a flooder with 1008.
 *   REST   : PUT requires an auth token (x-auth-token header) — unauthenticated writes -> 403.
 *   STATE  : concurrent edits to a cell resolve last-writer-wins deterministically (single
 *            threaded object assignment); GET reflects the authoritative converged value.
 *
 * CONFIG (env):
 *   PORT / GAME_PORT   listen port (default 3000; GAME_PORT wins for ephemeral harness use)
 *   GAME_WS_PATH       websocket path (default "/ws")
 *   AUTH_TOKEN         token PUT /api/worlds/:id must present (default "voxel-ref-secret")
 *
 * On listen prints EXACTLY:  AUTH-REF-SERVER READY port=<port> path=/ws
 * Importing this file is side-effect-free; it only boots when run as the main module.
 */

import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { wsCreateServer, OPEN } from './lib/ws-transport.mjs';

/* =========================================================================
 * Protocol + world constants.
 * ========================================================================= */
const PROTOCOL_VERSION = 1;
const CHUNK = 16;
const WORLD_HEIGHT = 128;            // vertical block range [0,128)
const SEA_LEVEL = 40;
const MAX_BLOCK_ID = 40;             // 0 = break, 1..40 = place
const DIMENSIONS = ['overworld', 'nether', 'end'];
const DIM_SET = new Set(DIMENSIONS);
const WORLD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SPAWN = { x: 0, y: 80, z: 0 }; // matches the real server's fixed spawn

/* =========================================================================
 * Authority tunables (the numbers the tests assert against).
 * ========================================================================= */
const XZ_LIMIT = 30000000;           // |x|,|z| world limit (3e7)
const EDIT_REACH_BLOCKS = 6;         // max Euclidean edit distance from the player
const REACH_EPSILON = 1e-6;          // float tolerance so exactly-6 is inclusive
const EDIT_RATE_CAP_PER_S = 20;      // edits/sec/connection
const CHAT_MAX_CHARS = 256;          // chat length cap
const CHAT_RATE_MAX = 3;             // chat messages ...
const CHAT_RATE_WINDOW_MS = 2000;    // ... per this window / connection
const NAME_MAX_LEN = 32;             // display-name length cap

// Movement: SPEED_FLY = 10.89 b/s is the fastest legal mode; allow tolerance up to ~16 b/s.
// The per-message displacement budget floors dt at 1s so rapid bursts of small legal moves
// are never rejected, while a +1000-block teleport is far beyond any budget and is rejected.
const SPEED_CAP_BPS = 16;
const MOVE_MARGIN_BLOCKS = 8;        // fixed jitter/first-sync allowance
const MOVE_MIN_DT_SEC = 1.0;         // dt floor: rapid moves still get a full 1s budget
const MOVE_MAX_DT_SEC = 10.0;        // dt ceiling: cannot "bank" time to justify a jump

// Transport / flood protection.
const MAX_PAYLOAD = 65536;           // 64 KiB per-frame cap -> oversized closed 1009
const MSG_RATE_CAP_PER_S = 2000;     // per-connection message ceiling before a strike
const MSG_RATE_STRIKES = 1;          // strikes tolerated before a 1008 close

const AUTH_TOKEN = process.env.AUTH_TOKEN || 'voxel-ref-secret';

const nowMs = () => performance.now();

/* =========================================================================
 * Server state.
 * ========================================================================= */
/** @type {Map<string, object>} player id -> Player */
const players = new Map();
/** @type {Map<string, object>} worldId -> {id,name,seed,createdAt,edits:{overworld,nether,end}} */
const worlds = new Map();
/** @type {WeakMap<object, object>} conn -> per-connection state */
const connState = new WeakMap();

let server = null;
let nextId = 1;

/* =========================================================================
 * Small helpers.
 * ========================================================================= */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function finiteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function readDim(v, def) {
  return typeof v === 'string' && DIM_SET.has(v) ? v : def;
}

/** HTML-escape for chat (defense-in-depth against stored XSS). */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Sanitize a display name: strip control chars + angle brackets, trim, cap length. */
function sanitizeName(raw) {
  let s = typeof raw === 'string' ? raw : '';
  s = s.replace(/[\u0000-\u001F\u007F<>]/g, ''); // control chars + < >
  s = s.trim();
  if (s.length > NAME_MAX_LEN) s = s.slice(0, NAME_MAX_LEN);
  if (s.length === 0) s = 'player';
  return s;
}

/** Ensure a display name is unique within a room; append a numeric suffix if taken. */
function dedupName(worldId, base) {
  const taken = new Set();
  for (const p of players.values()) {
    if (p.worldId === worldId) taken.add(p.name);
  }
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100000; i++) {
    const suffix = '#' + i;
    let candidate = base;
    if (candidate.length + suffix.length > NAME_MAX_LEN) {
      candidate = candidate.slice(0, Math.max(0, NAME_MAX_LEN - suffix.length));
    }
    candidate += suffix;
    if (!taken.has(candidate)) return candidate;
  }
  return base + '#' + Math.floor(Math.random() * 1e9);
}

function getOrCreateWorld(worldId) {
  let w = worlds.get(worldId);
  if (!w) {
    w = {
      id: worldId,
      name: worldId,
      seed: 0,
      createdAt: Date.now(),
      edits: { overworld: {}, nether: {}, end: {} },
    };
    worlds.set(worldId, w);
  }
  return w;
}

function worldInfo(worldId) {
  return {
    id: worldId,
    dims: DIMENSIONS.slice(),
    chunk: CHUNK,
    height: WORLD_HEIGHT,
    seaLevel: SEA_LEVEL,
    maxBlockId: MAX_BLOCK_ID,
  };
}

function peerOf(p) {
  return { id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, dim: p.dim };
}

/* =========================================================================
 * Exception-proof sending + room fan-out.
 * ========================================================================= */
function safeSend(conn, str) {
  try {
    if (!conn || conn.readyState !== OPEN) return false;
    return conn.send(str);
  } catch {
    return false;
  }
}

/** Broadcast to every joined, non-sandboxed client in `worldId` (all dims). */
function broadcastToWorld(worldId, str, exceptConn = null) {
  if (!server) return;
  for (const conn of server.clients) {
    if (conn === exceptConn) continue;
    const st = connState.get(conn);
    if (!st || !st.joined || st.sandboxed || st.worldId !== worldId) continue;
    safeSend(conn, str);
  }
}

/** Broadcast to every joined, non-sandboxed client in the same (worldId, dim). */
function broadcastToDim(worldId, dim, str, exceptConn = null) {
  if (!server) return;
  for (const conn of server.clients) {
    if (conn === exceptConn) continue;
    const st = connState.get(conn);
    if (!st || !st.joined || st.sandboxed) continue;
    if (st.worldId !== worldId || st.dim !== dim) continue;
    safeSend(conn, str);
  }
}

function roomPeers(worldId, exceptId) {
  const out = [];
  for (const p of players.values()) {
    if (p.worldId !== worldId || p.id === exceptId) continue;
    out.push(peerOf(p));
  }
  return out;
}

function sendError(conn, code, message) {
  safeSend(conn, JSON.stringify({ t: 'error', code, message: String(message || '') }));
}

/** Sandbox (isolate then close 1008) a single flooding connection; never affects peers. */
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
 * Handlers.
 * ========================================================================= */
function handleJoin(conn, st, msg) {
  if (st.joined) {
    sendError(conn, 'already_joined', 'this connection has already joined');
    return;
  }

  const worldId = msg.worldId;
  if (typeof worldId !== 'string' || !WORLD_ID_RE.test(worldId)) {
    sendError(conn, 'bad_world', 'worldId must match ^[A-Za-z0-9_-]{1,64}$');
    return;
  }

  let dim = 'overworld';
  if (msg.dim !== undefined && msg.dim !== null) {
    if (typeof msg.dim !== 'string' || !DIM_SET.has(msg.dim)) {
      sendError(conn, 'bad_join', 'dim must be one of overworld|nether|end');
      return;
    }
    dim = msg.dim;
  }

  // NAME: sanitize (strip control + < >, cap 32) then de-duplicate within the room.
  const base = sanitizeName(msg.name);
  const name = dedupName(worldId, base);

  getOrCreateWorld(worldId);

  // id is minted server-side and can NEVER be set by the client.
  const id = 'p' + nextId++;
  const player = {
    id,
    name,
    worldId,
    dim,
    x: SPAWN.x,
    y: SPAWN.y,
    z: SPAWN.z,
    yaw: 0,
    pitch: 0,
    conn,
  };

  const peers = roomPeers(worldId, null); // snapshot before adding self
  players.set(id, player);
  st.joined = true;
  st.id = id;
  st.worldId = worldId;
  st.dim = dim;
  st.player = player;
  // Seed authoritative movement baseline at spawn (first move establishes real pos).
  st.lastX = player.x;
  st.lastY = player.y;
  st.lastZ = player.z;
  st.lastMoveMs = nowMs();
  st.moveEstablished = false;

  safeSend(conn, JSON.stringify({ t: 'welcome', id, world: worldInfo(worldId), peers }));
  broadcastToWorld(
    worldId,
    JSON.stringify({ t: 'peer-join', id, name, x: player.x, y: player.y, z: player.z, yaw: player.yaw, dim }),
    conn,
  );
}

function handleMove(conn, st, msg) {
  const p = st.player;
  if (!p) return;

  // Drop non-finite / non-number coords — never propagate NaN/Infinity/null.
  if (!finiteNum(msg.x) || !finiteNum(msg.y) || !finiteNum(msg.z)) return;

  const x = msg.x;
  const y = msg.y;
  const z = msg.z;
  const t = nowMs();

  // Speed / teleport authority. The first move after join establishes the baseline;
  // every subsequent move must fit the horizontal displacement budget or it is rejected
  // (the server keeps the prior authoritative pos and does NOT rebroadcast the jump).
  if (st.moveEstablished) {
    const dist = Math.hypot(x - st.lastX, z - st.lastZ);
    let dtSec = (t - st.lastMoveMs) / 1000;
    if (!(dtSec > 0)) dtSec = 0;
    const budgetSec = Math.min(MOVE_MAX_DT_SEC, Math.max(MOVE_MIN_DT_SEC, dtSec));
    const maxDist = SPEED_CAP_BPS * budgetSec + MOVE_MARGIN_BLOCKS;
    if (dist > maxDist) return; // reject: impossible speed / teleport
  }

  // Accept: update the authoritative position.
  p.x = x;
  p.y = y;
  p.z = z;
  if (finiteNum(msg.yaw)) p.yaw = msg.yaw;
  const pitch = finiteNum(msg.pitch) ? msg.pitch : 0; // carrier field, forwarded verbatim
  p.pitch = pitch;
  st.lastX = x;
  st.lastY = y;
  st.lastZ = z;
  st.lastMoveMs = t;
  st.moveEstablished = true;

  // A move may legitimately carry a dimension change.
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

  // EDIT RATE: cap 20 edits/sec/connection (rolling window). Excess is dropped.
  const t = nowMs();
  const win = st.editTimes;
  while (win.length && t - win[0] >= 1000) win.shift();
  if (win.length >= EDIT_RATE_CAP_PER_S) return; // throttled
  // (push only once the edit is otherwise valid — invalid edits should not consume budget)

  // Coords + block must be finite numbers.
  if (!finiteNum(msg.x) || !finiteNum(msg.y) || !finiteNum(msg.z) || !finiteNum(msg.block)) {
    sendError(conn, 'bad_edit', 'x,y,z,block must be finite numbers');
    return;
  }
  const x = Math.trunc(msg.x);
  const y = Math.trunc(msg.y);
  const z = Math.trunc(msg.z);
  const block = msg.block;

  // BLOCK VALIDITY: integer 0..40 only (reject 9999, -1, non-int).
  if (!Number.isInteger(block) || block < 0 || block > MAX_BLOCK_ID) {
    sendError(conn, 'bad_edit', 'block must be an integer 0..40');
    return;
  }
  // Y BOUNDS + BEDROCK: 0<=y<128, and y==0 is an unbreakable floor.
  if (!(y >= 0 && y < WORLD_HEIGHT)) {
    sendError(conn, 'bad_edit', 'require 0<=y<128');
    return;
  }
  if (y === 0) {
    sendError(conn, 'protected', 'y==0 is bedrock (protected)');
    return;
  }
  // XZ BOUNDS: |x|,|z| <= 30,000,000.
  if (Math.abs(x) > XZ_LIMIT || Math.abs(z) > XZ_LIMIT) {
    sendError(conn, 'bad_edit', 'x,z out of world bounds');
    return;
  }

  // DIM: forced to the player's CURRENT dim — a client dim override is ignored.
  const dim = p.dim;

  // REACH: target must be within EDIT_REACH_BLOCKS of the authoritative position.
  const dx = x - p.x;
  const dy = y - p.y;
  const dz = z - p.z;
  const reach = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (reach > EDIT_REACH_BLOCKS + REACH_EPSILON) {
    sendError(conn, 'out_of_reach', `edit target beyond reach (${EDIT_REACH_BLOCKS})`);
    return;
  }

  // Accepted: consume rate budget, persist (last-writer-wins), broadcast same-dim.
  win.push(t);
  const world = getOrCreateWorld(p.worldId);
  world.edits[dim][`${x},${y},${z}`] = block;
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
  if (typeof msg.text !== 'string') return;

  // CHAT RATE: 3 messages / 2000ms / connection (rolling window). Excess dropped.
  const t = nowMs();
  const win = st.chatTimes;
  while (win.length && t - win[0] >= CHAT_RATE_WINDOW_MS) win.shift();
  if (win.length >= CHAT_RATE_MAX) return;

  // LENGTH cap then server-side HTML escape (defense-in-depth) BEFORE broadcast.
  let text = msg.text.trim().slice(0, CHAT_MAX_CHARS);
  if (text.length === 0) return;
  text = escapeHtml(text);

  win.push(t);
  // Whole room, INCLUDING the sender (self-echo), crossing dimensions.
  broadcastToWorld(p.worldId, JSON.stringify({ t: 'chat', id: p.id, name: p.name, text }), null);
}

/* =========================================================================
 * Inbound dispatch — outermost defensive shell + per-connection flood ceiling.
 * ========================================================================= */
function onMessage(conn, data) {
  const st = connState.get(conn);
  if (!st || st.sandboxed) return;

  try {
    // Per-connection message-rate strike-close (sliding 1s window -> 1008).
    const t = nowMs();
    if (t - st.winStart >= 1000) {
      st.winStart = t;
      st.winCount = 0;
    }
    st.winCount++;
    if (st.winCount > MSG_RATE_CAP_PER_S) {
      st.strikes = (st.strikes || 0) + 1;
      if (st.strikes >= MSG_RATE_STRIKES) {
        sandbox(conn, 'message rate limit exceeded');
        return;
      }
    }

    let text;
    if (typeof data === 'string') text = data;
    else if (Buffer.isBuffer(data)) text = data.toString('utf8');
    else return;

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // invalid JSON -> silently ignored
    }
    if (!isPlainObject(msg)) return;
    if (typeof msg.t !== 'string') return;

    if (!st.joined) {
      if (msg.t === 'join') handleJoin(conn, st, msg);
      return; // pre-join: everything else ignored
    }

    switch (msg.t) {
      case 'join':
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
        break; // unknown t -> ignored
    }
  } catch {
    // A handler bug must never crash the server or another connection.
  }
}

function onConnection(conn) {
  try {
    connState.set(conn, {
      id: null,
      player: null,
      joined: false,
      worldId: null,
      dim: null,
      sandboxed: false,
      isAlive: true,
      winStart: nowMs(),
      winCount: 0,
      strikes: 0,
      editTimes: [], // rolling edit timestamps (edit-rate cap)
      chatTimes: [], // rolling chat timestamps (chat-rate cap)
      lastX: SPAWN.x,
      lastY: SPAWN.y,
      lastZ: SPAWN.z,
      lastMoveMs: nowMs(),
      moveEstablished: false,
    });
    conn.on('message', (d) => onMessage(conn, d));
    conn.on('pong', () => {
      const st = connState.get(conn);
      if (st) st.isAlive = true;
    });
    conn.on('error', () => {});
    conn.on('close', () => {
      const st = connState.get(conn);
      if (st && st.id != null) {
        players.delete(st.id);
        if (st.worldId != null) {
          broadcastToWorld(st.worldId, JSON.stringify({ t: 'peer-leave', id: st.id }), conn);
        }
      }
      connState.delete(conn);
    });
  } catch {
    try {
      conn.terminate();
    } catch {
      /* ignore */
    }
  }
}

/* =========================================================================
 * REST surface (node:http) on the SAME port as the WS server.
 * ========================================================================= */
function sendJson(res, status, obj) {
  try {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  } catch {
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  }
}

function worldPublic(w) {
  return {
    id: w.id,
    name: w.name,
    seed: w.seed,
    createdAt: w.createdAt,
    edits: {
      overworld: { ...w.edits.overworld },
      nether: { ...w.edits.nether },
      end: { ...w.edits.end },
    },
  };
}

function applyBulkEdits(world, body) {
  let count = 0;
  if (!isPlainObject(body)) return 0;
  const edits = body.edits;
  if (!isPlainObject(edits)) return 0;
  for (const dim of DIMENSIONS) {
    const dimEdits = edits[dim];
    if (!isPlainObject(dimEdits)) continue;
    for (const key of Object.keys(dimEdits)) {
      const m = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(key);
      if (!m) continue;
      const x = Number(m[1]);
      const y = Number(m[2]);
      const z = Number(m[3]);
      const block = dimEdits[key];
      if (!Number.isInteger(block) || block < 0 || block > MAX_BLOCK_ID) continue;
      if (!(y >= 0 && y < WORLD_HEIGHT)) continue;
      if (Math.abs(x) > XZ_LIMIT || Math.abs(z) > XZ_LIMIT) continue;
      world.edits[dim][`${x},${y},${z}`] = block;
      count++;
    }
  }
  return count;
}

function handleRest(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch {
    sendJson(res, 400, { error: 'bad_request' });
    return;
  }
  const pathname = url.pathname;
  const method = (req.method || 'GET').toUpperCase();

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true, protocol: PROTOCOL_VERSION });
    return;
  }

  const m = /^\/api\/worlds\/([^/]+)\/?$/.exec(pathname);
  if (!m) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  let worldId;
  try {
    worldId = decodeURIComponent(m[1]);
  } catch {
    worldId = m[1];
  }
  if (!WORLD_ID_RE.test(worldId)) {
    sendJson(res, 400, { error: 'bad_world', message: 'worldId must match ^[A-Za-z0-9_-]{1,64}$' });
    return;
  }

  if (method === 'GET') {
    const w = getOrCreateWorld(worldId);
    sendJson(res, 200, worldPublic(w));
    return;
  }

  if (method === 'PUT') {
    // REST WRITE AUTH: unauthenticated bulk edit writes are rejected with 403.
    const token = req.headers['x-auth-token'];
    if (typeof token !== 'string' || token.length === 0 || token !== AUTH_TOKEN) {
      sendJson(res, 403, { error: 'forbidden', message: 'PUT /api/worlds/:id requires a valid x-auth-token' });
      return;
    }
    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > 1 << 20) {
        aborted = true;
        sendJson(res, 413, { error: 'payload_too_large' });
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        sendJson(res, 400, { error: 'bad_json' });
        return;
      }
      const world = getOrCreateWorld(worldId);
      const written = applyBulkEdits(world, body);
      sendJson(res, 200, { ok: true, id: worldId, written });
    });
    req.on('error', () => {
      if (!aborted) {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      }
    });
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
}

/* =========================================================================
 * Boot / shutdown.
 * ========================================================================= */
function resolvePort() {
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

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (server) server.close(() => process.exit(code));
    else process.exit(code);
  } catch {
    process.exit(code);
  }
  const t = setTimeout(() => process.exit(code), 1500);
  if (t.unref) t.unref();
}

function main() {
  const PORT = resolvePort();
  const HOST = '127.0.0.1';
  const WS_PATH = resolvePath();

  server = wsCreateServer({ port: PORT, host: HOST, path: WS_PATH, maxPayload: MAX_PAYLOAD });

  // Attach the REST surface to the SAME underlying http server that carries the WS upgrade,
  // so ws://host:PORT/ws and http://host:PORT/api/... share one port. WS traffic flows through
  // the 'upgrade' event (untouched); we only replace the default 426 'request' handler.
  const httpServer = server._http;
  if (httpServer && typeof httpServer.on === 'function') {
    httpServer.removeAllListeners('request');
    httpServer.on('request', (req, res) => {
      try {
        handleRest(req, res);
      } catch {
        try {
          sendJson(res, 500, { error: 'internal' });
        } catch {
          /* ignore */
        }
      }
    });
  }

  server.on('connection', onConnection);
  server.on('error', (err) => {
    const code = err && err.code;
    try {
      console.error(`AUTH-REF-SERVER ERROR: ${(err && err.message) || err}`);
    } catch {
      /* ignore */
    }
    if (code === 'EADDRINUSE' || code === 'EACCES') shutdown(1);
  });
  server.on('listening', () => {
    console.log(`AUTH-REF-SERVER READY port=${server.port} path=${WS_PATH}`);
  });

  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('uncaughtException', (err) => {
    try {
      console.error(`AUTH-REF-SERVER uncaught: ${(err && err.message) || err}`);
    } catch {
      /* ignore */
    }
  });
  process.on('unhandledRejection', (err) => {
    try {
      console.error(`AUTH-REF-SERVER unhandledRejection: ${(err && err.message) || err}`);
    } catch {
      /* ignore */
    }
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}

export {
  escapeHtml,
  sanitizeName,
  dedupName,
  applyBulkEdits,
  worldPublic,
  EDIT_REACH_BLOCKS,
  EDIT_RATE_CAP_PER_S,
  XZ_LIMIT,
  CHAT_MAX_CHARS,
  NAME_MAX_LEN,
  MAX_PAYLOAD,
};
