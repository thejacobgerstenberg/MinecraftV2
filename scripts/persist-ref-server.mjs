#!/usr/bin/env node
/**
 * persist-ref-server.mjs — minimal REFERENCE persistent "Voxelheim" server.
 *
 * This is the self-test TARGET for `scripts/persistence-test.mjs --spawn` AND a
 * living document of correct durable-save behavior for the real-server builder
 * (server/index.js). It faithfully reproduces the real server's persistence
 * contract — same on-disk schema, same DEBOUNCED + ATOMIC write, same flush on
 * last-player-leave and on SIGTERM — on top of the dependency-free WebSocket
 * transport in scripts/lib/ws-transport.mjs. No express, no ws: node builtins only.
 *
 * WIRE PROTOCOL (matches docs/PROTOCOL.md v1 / server/index.js exactly):
 *
 *   CLIENT -> SERVER:
 *     join : {t:"join", worldId, name, dim}
 *     move : {t:"move", x,y,z, yaw, pitch, dim}
 *     edit : {t:"edit", x,y,z, block, dim}   ints; 0<=y<128; 0<=block<=40
 *     chat : {t:"chat", text}
 *   SERVER -> CLIENT:
 *     welcome    : {t:"welcome", id:"p<N>", world:{id,name,seed,createdAt,edits}, peers}
 *     peer-join  : {t:"peer-join", id, name, x,y,z, yaw, pitch, dim}  (upsert / dim-change)
 *     peer-leave : {t:"peer-leave", id}
 *     move       : {t:"move", id, x,y,z, yaw, pitch, dim}   (same-dim recipients)
 *     edit       : {t:"edit", id, x,y,z, block, dim}        (same-dim recipients)
 *     chat       : {t:"chat", id, name, text}               (whole room)
 *     error      : {t:"error", code, message}   code ∈ bad_join|already_joined|bad_edit|bad_world
 *
 *   The welcome frame carries the FULL world record INCLUDING `edits`, so a
 *   reconnect after a restart proves the on-disk round-trip (persistence-test P2).
 *
 * REST (same port as the WS endpoint):
 *     GET  /api/health            -> {ok:true}
 *     GET  /api/worlds            -> [ {id,name,seed,createdAt,players}, ... ]
 *     POST /api/worlds            -> create {name[,seed]} -> 201 {id,...,edits,players:0}
 *     GET  /api/worlds/:id        -> {id,name,seed,createdAt,edits,players}
 *     PUT  /api/worlds/:id        -> bulk-merge {edits:{overworld,nether,end}} (unauthenticated)
 *
 * PERSISTENCE CONTRACT (the point of this file):
 *     saves/<id>.json  = {id, name, seed, createdAt,
 *                         edits:{overworld:{"x,y,z":block}, nether:{...}, end:{...}}}
 *   - DEBOUNCED: a dirty room is flushed ~SAVE_DEBOUNCE_MS after the first edit.
 *   - ATOMIC: write <id>.json.tmp then rename() -> a reader NEVER sees partial JSON.
 *     A mid-write SIGKILL therefore leaves the OLD file intact (never a truncated one).
 *   - FLUSHED on the last player leaving a world and on SIGTERM (NOT on SIGKILL).
 *
 * CONFIG (env):
 *   PORT / GAME_PORT   listen port (default 3000; GAME_PORT wins for an ephemeral 0)
 *   GAME_WS_PATH       websocket path (default "/ws")
 *   SAVE_DIR           where saves/<id>.json live (default a fresh os.tmpdir mkdtemp)
 *
 * On listen it prints EXACTLY the line the suite waits for:
 *   PERSIST-REF-SERVER READY port=<port> saveDir=<dir>
 *
 * No module exports — a runnable CLI. Importing it is side-effect-free.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { wsCreateServer, OPEN } from './lib/ws-transport.mjs';

const fsp = fs.promises;

/* =========================================================================
 * Protocol + world constants (must match server/index.js).
 * ========================================================================= */
const MAX_BLOCK_ID = 40;
const WORLD_HEIGHT = 128;
const DIMENSIONS = ['overworld', 'nether', 'end'];
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SAVE_DEBOUNCE_MS = 1000;      // ~1s (real server uses 2s); atomic tmp+rename
const HEARTBEAT_MS = 30000;         // WS keepalive ping cadence
const REST_BODY_LIMIT = 10 * 1024 * 1024; // 10 MiB, matching the real express limit

/* =========================================================================
 * Server state.
 * ========================================================================= */
/**
 * Rooms keyed by world id:
 *   { world, clients:Map<playerId, player>, saveTimer, dirty }
 * `world` is the exact serialized-to-disk record; timer/dirty live OUTSIDE it so
 * they never leak into saves/<id>.json.
 */
const rooms = new Map();
/** Per-connection bookkeeping (GC'd with the connection). */
const connState = new WeakMap();

let server = null;
let heartbeatTimer = null;
let nextClientId = 1;
let SAVE_DIR = '';

/* =========================================================================
 * Env / config resolution (defensive: bad env -> defaults).
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
function resolveSaveDir() {
  const raw = process.env.SAVE_DIR;
  if (typeof raw === 'string' && raw.length) return raw;
  return fs.mkdtempSync(path.join(os.tmpdir(), 'persist-ref-'));
}

/* =========================================================================
 * Small helpers.
 * ========================================================================= */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function validBlockId(block) {
  return Number.isInteger(block) && block >= 0 && block <= MAX_BLOCK_ID;
}
function validEditKey(key) {
  const parts = String(key).split(',');
  if (parts.length !== 3) return false;
  const [x, y, z] = parts.map(Number);
  return (
    Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) &&
    y >= 0 && y < WORLD_HEIGHT
  );
}
/** FNV-1a hash of a string -> positive 32-bit int, for derived seeds. */
function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function slugify(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'world';
}
function randomSuffix() {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

/* =========================================================================
 * World records + persistence.
 * ========================================================================= */
function savePath(id) {
  return path.join(SAVE_DIR, `${id}.json`);
}

/** Ensure a world record has the canonical shape (all dimension buckets). */
function normalizeWorld(world) {
  if (!world.edits || typeof world.edits !== 'object') world.edits = {};
  for (const dim of DIMENSIONS) {
    if (!world.edits[dim] || typeof world.edits[dim] !== 'object') {
      world.edits[dim] = {};
    }
  }
  return world;
}

function makeWorld(id, name, seed) {
  return normalizeWorld({
    id,
    name,
    seed: seed ?? hashSeed(id),
    createdAt: new Date().toISOString(),
    edits: { overworld: {}, nether: {}, end: {} },
  });
}

async function readWorldFromDisk(id) {
  try {
    const raw = await fsp.readFile(savePath(id), 'utf8');
    return normalizeWorld(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Atomic write: tmp file + rename, so readers never observe partial JSON and a
 * mid-write crash leaves the previous file intact (old-or-new, never half).
 */
async function writeWorldToDisk(world) {
  const file = savePath(world.id);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(world, null, 2));
  await fsp.rename(tmp, file);
}

/** Get the loaded room for a world, or load from disk / create a fresh one. */
async function loadRoom(id, { create = false, name = null, seed = null } = {}) {
  let room = rooms.get(id);
  if (room) return room;
  let world = await readWorldFromDisk(id);
  if (!world) {
    if (!create) return null;
    world = makeWorld(id, name ?? id, seed);
    await writeWorldToDisk(world);
  }
  room = { world, clients: new Map(), saveTimer: null, dirty: false };
  rooms.set(id, room);
  return room;
}

/** Mark a room dirty and (re)arm the debounced writer. */
function markDirty(room) {
  room.dirty = true;
  if (room.saveTimer) return;
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null;
    saveRoom(room).catch((err) =>
      console.error(`[save] failed for ${room.world.id}: ${err && err.message}`));
  }, SAVE_DEBOUNCE_MS);
}

/** Flush a room to disk now (if dirty), cancelling any pending debounce. */
async function saveRoom(room) {
  if (room.saveTimer) {
    clearTimeout(room.saveTimer);
    room.saveTimer = null;
  }
  if (!room.dirty) return;
  room.dirty = false;
  await writeWorldToDisk(room.world);
}

/** Last client of a world left: flush to disk and unload the room. */
async function unloadRoomIfEmpty(room) {
  if (room.clients.size > 0) return;
  try {
    await saveRoom(room);
  } catch (err) {
    console.error(`[save] failed for ${room.world.id}: ${err && err.message}`);
  }
  rooms.delete(room.world.id);
}

function playersIn(id) {
  const room = rooms.get(id);
  return room ? room.clients.size : 0;
}
function worldSummary(world) {
  return {
    id: world.id,
    name: world.name,
    seed: world.seed,
    createdAt: world.createdAt,
    players: playersIn(world.id),
  };
}

/* =========================================================================
 * REST — a tiny node:http router. Never throws; always responds.
 * ========================================================================= */
function sendJson(res, code, obj) {
  let body;
  try {
    body = JSON.stringify(obj);
  } catch {
    body = '{"error":"serialization failed"}';
    code = 500;
  }
  try {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'close',
    });
    res.end(body);
  } catch {
    /* client vanished mid-response */
  }
}

/** Buffer a request body up to REST_BODY_LIMIT; resolves null on overflow/error. */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > REST_BODY_LIMIT) {
        finish(null);
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish(chunks.length ? Buffer.concat(chunks).toString('utf8') : ''));
    req.on('error', () => finish(null));
  });
}

async function parseJsonBody(req) {
  const text = await readBody(req);
  if (text === null) return { error: 'body too large' };
  if (text === '') return { body: {} };
  try {
    const body = JSON.parse(text);
    return { body: isPlainObject(body) ? body : {} };
  } catch {
    return { error: 'invalid JSON' };
  }
}

async function handleRest(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    return sendJson(res, 400, { error: 'bad request' });
  }
  const method = req.method || 'GET';
  const pathname = url.pathname;

  // GET /api/health
  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/worlds  |  POST /api/worlds
  if (pathname === '/api/worlds') {
    if (method === 'GET') {
      let files = [];
      try {
        files = await fsp.readdir(SAVE_DIR);
      } catch {
        /* saves dir missing -> empty list */
      }
      const out = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const id = f.slice(0, -5);
        const room = rooms.get(id);
        const world = room ? room.world : await readWorldFromDisk(id);
        if (world) out.push(worldSummary(world));
      }
      out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return sendJson(res, 200, out);
    }
    if (method === 'POST') {
      const parsed = await parseJsonBody(req);
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      const body = parsed.body;
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 64) : '';
      if (!name) return sendJson(res, 400, { error: 'name is required' });
      const seedOk = typeof body.seed === 'number' || typeof body.seed === 'string';
      let id;
      do {
        id = `${slugify(name)}-${randomSuffix()}`;
      } while (rooms.has(id) || (await readWorldFromDisk(id)));
      const world = makeWorld(id, name, seedOk ? body.seed : null);
      try {
        await writeWorldToDisk(world);
      } catch (err) {
        return sendJson(res, 500, { error: `failed to persist world: ${err && err.message}` });
      }
      return sendJson(res, 201, { ...world, players: 0 });
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  // GET /api/worlds/:id  |  PUT /api/worlds/:id
  if (pathname.startsWith('/api/worlds/')) {
    const id = decodeURIComponent(pathname.slice('/api/worlds/'.length));
    if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'invalid world id' });

    if (method === 'GET') {
      const room = rooms.get(id);
      const world = room ? room.world : await readWorldFromDisk(id);
      if (!world) return sendJson(res, 404, { error: 'world not found' });
      return sendJson(res, 200, { ...world, players: playersIn(id) });
    }

    if (method === 'PUT') {
      const parsed = await parseJsonBody(req);
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      // Load (or create in memory) so a PUT to an unopened world still persists.
      const room = rooms.get(id);
      let world = room ? room.world : await readWorldFromDisk(id);
      if (!world) return sendJson(res, 404, { error: 'world not found' });
      world = normalizeWorld(world);

      const incoming = parsed.body.edits;
      if (incoming && typeof incoming === 'object') {
        for (const dim of DIMENSIONS) {
          const bucket = incoming[dim];
          if (!bucket || typeof bucket !== 'object') continue;
          for (const [key, block] of Object.entries(bucket)) {
            if (!validEditKey(key) || !validBlockId(block)) continue;
            world.edits[dim][key] = block;
          }
        }
      }
      try {
        await writeWorldToDisk(world);
      } catch (err) {
        return sendJson(res, 500, { error: `failed to persist world: ${err && err.message}` });
      }
      if (room) room.dirty = false; // the in-memory copy just hit disk
      return sendJson(res, 200, { ...world, players: playersIn(id) });
    }

    return sendJson(res, 405, { error: 'method not allowed' });
  }

  return sendJson(res, 404, { error: 'not found' });
}

/* =========================================================================
 * WebSocket rooms. Every send is bounded + exception-proof.
 * ========================================================================= */
function safeSend(conn, obj) {
  try {
    if (!conn || conn.readyState !== OPEN) return false;
    return conn.send(JSON.stringify(obj));
  } catch {
    return false;
  }
}
function sendError(conn, code, message) {
  safeSend(conn, { t: 'error', code, message: String(message || '') });
}
function peerSnapshot(player) {
  const { id, name, x, y, z, yaw, pitch, dim } = player;
  return { id, name, x, y, z, yaw, pitch, dim };
}
/**
 * Broadcast to a room's clients.
 *   - dim: only clients whose current dim matches (null = all dims)
 *   - except: player id to skip (usually the sender)
 */
function broadcast(room, obj, { dim = null, except = null } = {}) {
  const raw = JSON.stringify(obj);
  for (const player of room.clients.values()) {
    if (player.id === except) continue;
    if (dim !== null && player.dim !== dim) continue;
    const c = player.conn;
    try {
      if (c && c.readyState === OPEN) c.send(raw);
    } catch { /* ignore one bad peer */ }
  }
}

async function handleJoin(conn, st, msg) {
  if (st.player || st.joining) {
    return sendError(conn, 'already_joined', 'this socket already joined a world');
  }
  const worldId = typeof msg.worldId === 'string' ? msg.worldId : '';
  if (!ID_RE.test(worldId)) {
    return sendError(conn, 'bad_join', 'invalid worldId');
  }
  st.joining = true;
  let room;
  try {
    room = await loadRoom(worldId, { create: true });
  } finally {
    st.joining = false;
  }
  // Re-check after the await: a concurrent frame may have joined, or the socket
  // may have closed while the world loaded (a player registered now would never
  // be cleaned up -> ghost peer + a room that never unloads/flushes).
  if (st.player) {
    return sendError(conn, 'already_joined', 'this socket already joined a world');
  }
  if (conn.readyState !== OPEN) {
    await unloadRoomIfEmpty(room).catch(() => {});
    return;
  }

  const name = (typeof msg.name === 'string' ? msg.name.trim().slice(0, 24) : '') || 'player';
  const dim = DIMENSIONS.includes(msg.dim) ? msg.dim : 'overworld';
  const player = {
    id: `p${nextClientId++}`,
    name, conn,
    x: 0, y: 80, z: 0, yaw: 0, pitch: 0,
    dim,
  };
  st.player = player;
  st.room = room;

  const peers = [...room.clients.values()].map(peerSnapshot);
  room.clients.set(player.id, player);

  safeSend(conn, {
    t: 'welcome',
    id: player.id,
    world: {
      id: room.world.id,
      name: room.world.name,
      seed: room.world.seed,
      createdAt: room.world.createdAt,
      edits: room.world.edits,
    },
    peers,
  });
  broadcast(room, { t: 'peer-join', ...peerSnapshot(player) }, { except: player.id });
  console.log(`[ws] ${player.id} "${name}" joined ${worldId} (${dim})`);
}

function handleMove(st, msg) {
  const { player, room } = st;
  if (!player || !room) return;
  const x = Number(msg.x), y = Number(msg.y), z = Number(msg.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  const yaw = Number.isFinite(Number(msg.yaw)) ? Number(msg.yaw) : 0;
  const pitch = Number.isFinite(Number(msg.pitch)) ? Number(msg.pitch) : 0;
  const newDim = DIMENSIONS.includes(msg.dim) ? msg.dim : player.dim;

  const dimChanged = newDim !== player.dim;
  Object.assign(player, { x, y, z, yaw, pitch, dim: newDim });

  if (dimChanged) {
    // Dim switch: upsert peer-join to the WHOLE room (clients filter locally).
    broadcast(room, { t: 'peer-join', ...peerSnapshot(player) }, { except: player.id });
  } else {
    broadcast(
      room,
      { t: 'move', id: player.id, x, y, z, yaw, pitch, dim: newDim },
      { dim: newDim, except: player.id },
    );
  }
}

function handleEdit(conn, st, msg) {
  const { player, room } = st;
  if (!player || !room) return;
  const { x, y, z, block } = msg;
  // Apply to msg.dim||player.dim so a connection can seed edits into any dim
  // (matches the real server; the persistence suite relies on per-dim seeding).
  const dim = msg.dim === undefined ? player.dim : msg.dim;
  if (
    !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) ||
    y < 0 || y >= WORLD_HEIGHT || !validBlockId(block) || !DIMENSIONS.includes(dim)
  ) {
    return sendError(conn, 'bad_edit', 'invalid edit (ints, 0<=y<128, block 0..40, valid dim)');
  }
  room.world.edits[dim][`${x},${y},${z}`] = block;
  markDirty(room);
  broadcast(
    room,
    { t: 'edit', id: player.id, x, y, z, block, dim },
    { dim, except: player.id },
  );
}

function handleChat(st, msg) {
  const { player, room } = st;
  if (!player || !room) return;
  const text = String(msg.text ?? '').trim().slice(0, 256);
  if (!text) return;
  broadcast(room, { t: 'chat', id: player.id, name: player.name, text });
}

function onMessage(conn, data) {
  const st = connState.get(conn);
  if (!st) return;
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
  if (!isPlainObject(msg) || typeof msg.t !== 'string') return;

  if (msg.t === 'join') {
    handleJoin(conn, st, msg).catch((err) => {
      console.error(`[ws] join failed: ${err && err.message}`);
      sendError(conn, 'bad_world', 'failed to load world');
    });
    return;
  }
  if (!st.player) return; // everything else requires a completed join

  try {
    switch (msg.t) {
      case 'move': handleMove(st, msg); break;
      case 'edit': handleEdit(conn, st, msg); break;
      case 'chat': handleChat(st, msg); break;
      default: break; // unknown types ignored
    }
  } catch {
    /* a handler bug must never crash the server or a peer */
  }
}

function onConnection(conn) {
  try {
    connState.set(conn, { player: null, room: null, joined: false, joining: false, isAlive: true });
    conn.on('message', (data) => onMessage(conn, data));
    conn.on('pong', () => {
      const st = connState.get(conn);
      if (st) st.isAlive = true;
    });
    conn.on('error', () => {});
    conn.on('close', () => {
      const st = connState.get(conn);
      connState.delete(conn);
      if (!st || !st.player || !st.room) return;
      const { player, room } = st;
      room.clients.delete(player.id);
      broadcast(room, { t: 'peer-leave', id: player.id });
      console.log(`[ws] ${player.id} "${player.name}" left ${room.world.id}`);
      // Flush + unload when the last client of a world leaves.
      unloadRoomIfEmpty(room).catch(() => {});
    });
  } catch {
    try { conn.terminate(); } catch { /* ignore */ }
  }
}

/* =========================================================================
 * Heartbeat: ping every HEARTBEAT_MS, terminate sockets that missed the pong.
 * ========================================================================= */
function startHeartbeat() {
  const timer = setInterval(() => {
    if (!server) return;
    for (const conn of server.clients) {
      const st = connState.get(conn);
      if (!st) continue;
      if (st.isAlive === false) {
        try { conn.terminate(); } catch { /* ignore */ }
        continue;
      }
      st.isAlive = false;
      try { conn.ping(); } catch { /* ignore */ }
    }
  }, HEARTBEAT_MS);
  if (timer.unref) timer.unref();
  return timer;
}

/* =========================================================================
 * Clean shutdown: flush every dirty world before exiting (SIGTERM/SIGINT).
 * A SIGKILL cannot run this — the atomic tmp+rename is what protects the file.
 * ========================================================================= */
let shuttingDown = false;
async function flushAllRooms() {
  await Promise.all([...rooms.values()].map((room) => saveRoom(room).catch(() => {})));
}
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { console.log(`[server] ${signal} received, flushing worlds...`); } catch { /* ignore */ }
  try { if (heartbeatTimer) clearInterval(heartbeatTimer); } catch { /* ignore */ }
  // Failsafe: force-exit if a flush or socket close wedges.
  const t = setTimeout(() => process.exit(0), 2000);
  if (t.unref) t.unref();
  try {
    await flushAllRooms();
  } catch { /* best-effort */ }
  try {
    if (server) server.close(() => process.exit(0));
    else process.exit(0);
  } catch {
    process.exit(0);
  }
}

/* =========================================================================
 * Boot.
 * ========================================================================= */
function main() {
  const PORT = resolvePort();
  const HOST = '127.0.0.1';
  const WS_PATH = resolvePath();
  SAVE_DIR = resolveSaveDir();

  try {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
  } catch (err) {
    console.error(`PERSIST-REF-SERVER ERROR: cannot create saveDir ${SAVE_DIR}: ${err && err.message}`);
    process.exit(1);
  }

  // wsCreateServer owns the HTTP server (upgrade handling + WS framing). We take
  // over ONLY its plain-HTTP request path to serve REST on the same port, leaving
  // its 'upgrade' listener (the WS handshake) untouched.
  server = wsCreateServer({ port: PORT, host: HOST, path: WS_PATH });
  const httpServer = server._http;
  if (httpServer && typeof httpServer.removeAllListeners === 'function') {
    httpServer.removeAllListeners('request');
    httpServer.on('request', (req, res) => {
      handleRest(req, res).catch(() => sendJson(res, 500, { error: 'internal error' }));
    });
  }

  server.on('connection', onConnection);
  server.on('error', (err) => {
    const code = err && err.code;
    try {
      console.error(`PERSIST-REF-SERVER ERROR: ${(err && err.message) || err}`);
    } catch { /* ignore */ }
    if (code === 'EADDRINUSE' || code === 'EACCES') process.exit(1);
  });
  server.on('listening', () => {
    heartbeatTimer = startHeartbeat();
    // The suite waits for EXACTLY this line.
    console.log(`PERSIST-REF-SERVER READY port=${server.port} saveDir=${SAVE_DIR}`);
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    try { console.error(`PERSIST-REF-SERVER uncaught: ${(err && err.message) || err}`); } catch { /* ignore */ }
  });
  process.on('unhandledRejection', (err) => {
    try { console.error(`PERSIST-REF-SERVER unhandledRejection: ${(err && err.message) || err}`); } catch { /* ignore */ }
  });
}

/* Run only when invoked directly (import stays side-effect-free). */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
