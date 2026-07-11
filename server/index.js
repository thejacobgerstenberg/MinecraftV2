// Voxelheim multiplayer server.
//
// - Serves the static client from public/.
// - REST API for world records (create / list / get / merge-save edits),
//   persisted as saves/<id>.json.
// - WebSocket endpoint at /ws hosting one "room" per world with
//   join / move / edit / chat traffic. See docs/PROTOCOL.md for the full
//   message reference.

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SAVES_DIR = path.join(__dirname, '..', 'saves');
const PORT = process.env.PORT || 3000;

// Validation constants. Block ids are validated conservatively against the
// contract-reserved range 0..40 (the registry may grow past 29 this phase).
const MAX_BLOCK_ID = 40;
const WORLD_HEIGHT = 128;
const DIMENSIONS = ['overworld', 'nether', 'end'];
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SAVE_DEBOUNCE_MS = 2000;
const HEARTBEAT_MS = 30000;

// ---------------------------------------------------------------------------
// World records + persistence
// ---------------------------------------------------------------------------

/**
 * Rooms keyed by world id. Each room:
 *   { world, clients: Map<clientId, player>, saveTimer, dirty }
 * where player = { id, name, ws, x, y, z, yaw, pitch, dim }.
 * A room exists while the world is loaded (any client connected, or a REST
 * call touched it recently); it is unloaded when its last client leaves.
 */
const rooms = new Map();

let nextClientId = 1;

function savePath(id) {
  return path.join(SAVES_DIR, `${id}.json`);
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
    const raw = await fs.readFile(savePath(id), 'utf8');
    return normalizeWorld(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Atomic-ish write: tmp file + rename, so readers never see partial JSON. */
async function writeWorldToDisk(world) {
  const file = savePath(world.id);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(world, null, 2));
  await fs.rename(tmp, file);
}

/** Get the loaded room for a world, or load/create one. */
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

function markDirty(room) {
  room.dirty = true;
  if (room.saveTimer) return;
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null;
    saveRoom(room).catch((err) =>
      console.error(`[save] failed for ${room.world.id}:`, err.message));
  }, SAVE_DEBOUNCE_MS);
}

async function saveRoom(room) {
  if (room.saveTimer) {
    clearTimeout(room.saveTimer);
    room.saveTimer = null;
  }
  if (!room.dirty) return;
  room.dirty = false;
  await writeWorldToDisk(room.world);
}

/** Called when a room's last client leaves: flush to disk and unload. */
async function unloadRoomIfEmpty(room) {
  if (room.clients.size > 0) return;
  await saveRoom(room).catch((err) =>
    console.error(`[save] failed for ${room.world.id}:`, err.message));
  rooms.delete(room.world.id);
}

// ---------------------------------------------------------------------------
// Express app (REST + statics)
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

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

app.get('/api/worlds', async (req, res) => {
  let files = [];
  try {
    files = await fs.readdir(SAVES_DIR);
  } catch {
    /* saves dir missing -> empty list */
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    // Prefer the live in-memory copy when the world is loaded.
    const room = rooms.get(id);
    const world = room ? room.world : await readWorldFromDisk(id);
    if (world) out.push(worldSummary(world));
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json(out);
});

app.post('/api/worlds', async (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 64) : '';
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  const seedOk = typeof body.seed === 'number' || typeof body.seed === 'string';
  // Slug + short random suffix; retry on the (unlikely) collision.
  let id;
  do {
    id = `${slugify(name)}-${randomSuffix()}`;
  } while (rooms.has(id) || (await readWorldFromDisk(id)));
  const world = makeWorld(id, name, seedOk ? body.seed : null);
  try {
    await writeWorldToDisk(world);
  } catch (err) {
    return res.status(500).json({ error: `failed to persist world: ${err.message}` });
  }
  res.status(201).json({ ...world, players: 0 });
});

app.get('/api/worlds/:id', async (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid world id' });
  const room = rooms.get(id);
  const world = room ? room.world : await readWorldFromDisk(id);
  if (!world) return res.status(404).json({ error: 'world not found' });
  res.json({ ...world, players: playersIn(id) });
});

app.put('/api/worlds/:id', async (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid world id' });
  const room = rooms.get(id);
  const world = room ? room.world : await readWorldFromDisk(id);
  if (!world) return res.status(404).json({ error: 'world not found' });

  const incoming = req.body && req.body.edits;
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
    return res.status(500).json({ error: `failed to persist world: ${err.message}` });
  }
  if (room) room.dirty = false; // in-memory copy just hit disk
  res.json({ ...world, players: playersIn(id) });
});

app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
// WebSocket rooms
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function validEditKey(key) {
  const parts = String(key).split(',');
  if (parts.length !== 3) return false;
  const [x, y, z] = parts.map(Number);
  return (
    Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) &&
    y >= 0 && y < WORLD_HEIGHT
  );
}

function validBlockId(block) {
  return Number.isInteger(block) && block >= 0 && block <= MAX_BLOCK_ID;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/**
 * Broadcast to clients in a room.
 *  - dim: only clients whose current dimension matches (null = all dims)
 *  - except: client id to skip (usually the sender)
 */
function broadcast(room, msg, { dim = null, except = null } = {}) {
  const raw = JSON.stringify(msg);
  for (const player of room.clients.values()) {
    if (player.id === except) continue;
    if (dim !== null && player.dim !== dim) continue;
    if (player.ws.readyState === player.ws.OPEN) player.ws.send(raw);
  }
}

function peerSnapshot(player) {
  const { id, name, x, y, z, yaw, pitch, dim } = player;
  return { id, name, x, y, z, yaw, pitch, dim };
}

async function handleJoin(ws, msg) {
  if (ws.player) {
    return send(ws, { t: 'error', code: 'already_joined', message: 'this socket already joined a world' });
  }
  const worldId = typeof msg.worldId === 'string' ? msg.worldId : '';
  if (!ID_RE.test(worldId)) {
    return send(ws, { t: 'error', code: 'bad_join', message: 'invalid worldId' });
  }
  // Auto-create on direct join (dev convenience); menu flow uses POST first.
  const room = await loadRoom(worldId, { create: true });
  const name = (typeof msg.name === 'string' ? msg.name.trim().slice(0, 24) : '') || 'player';
  const dim = DIMENSIONS.includes(msg.dim) ? msg.dim : 'overworld';

  const player = {
    id: `p${nextClientId++}`,
    name,
    ws,
    x: 0, y: 80, z: 0, yaw: 0, pitch: 0,
    dim,
  };
  ws.player = player;
  ws.room = room;

  const peers = [...room.clients.values()].map(peerSnapshot);
  room.clients.set(player.id, player);

  send(ws, {
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

function handleMove(ws, msg) {
  const { player, room } = ws;
  const x = Number(msg.x), y = Number(msg.y), z = Number(msg.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  const yaw = Number.isFinite(Number(msg.yaw)) ? Number(msg.yaw) : 0;
  const pitch = Number.isFinite(Number(msg.pitch)) ? Number(msg.pitch) : 0;
  const newDim = DIMENSIONS.includes(msg.dim) ? msg.dim : player.dim;

  const dimChanged = newDim !== player.dim;
  Object.assign(player, { x, y, z, yaw, pitch, dim: newDim });

  if (dimChanged) {
    // Dimension switch: announce as an upsert peer-join to the WHOLE room
    // (clients update the peer's dim and filter visibility locally).
    broadcast(room, { t: 'peer-join', ...peerSnapshot(player) }, { except: player.id });
  } else {
    broadcast(room, { t: 'move', id: player.id, x, y, z, yaw, pitch, dim: newDim },
      { dim: newDim, except: player.id });
  }
}

function handleEdit(ws, msg) {
  const { player, room } = ws;
  const { x, y, z, block } = msg;
  const dim = msg.dim === undefined ? player.dim : msg.dim;
  if (
    !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) ||
    y < 0 || y >= WORLD_HEIGHT || !validBlockId(block) || !DIMENSIONS.includes(dim)
  ) {
    return send(ws, { t: 'error', code: 'bad_edit', message: 'invalid edit (ints, 0<=y<128, block 0..40, valid dim)' });
  }
  room.world.edits[dim][`${x},${y},${z}`] = block;
  markDirty(room);
  broadcast(room, { t: 'edit', id: player.id, x, y, z, block, dim },
    { dim, except: player.id });
}

function handleChat(ws, msg) {
  const { player, room } = ws;
  const text = String(msg.text ?? '').trim().slice(0, 256);
  if (!text) return;
  broadcast(room, { t: 'chat', id: player.id, name: player.name, text });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'join') {
      handleJoin(ws, msg).catch((err) => {
        console.error('[ws] join failed:', err.message);
        send(ws, { t: 'error', code: 'bad_world', message: 'failed to load world' });
      });
      return;
    }
    if (!ws.player) return; // everything else requires a completed join

    switch (msg.t) {
      case 'move': handleMove(ws, msg); break;
      case 'edit': handleEdit(ws, msg); break;
      case 'chat': handleChat(ws, msg); break;
      default: break; // unknown types ignored
    }
  });

  ws.on('close', () => {
    const { player, room } = ws;
    if (!player || !room) return;
    room.clients.delete(player.id);
    broadcast(room, { t: 'peer-leave', id: player.id });
    console.log(`[ws] ${player.id} "${player.name}" left ${room.world.id}`);
    // Persist immediately when the last client of a world leaves.
    unloadRoomIfEmpty(room);
  });

  ws.on('error', (err) => {
    console.warn('[ws] socket error:', err.message);
  });
});

// Heartbeat: ping every 30 s, terminate sockets that missed the last pong.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

// ---------------------------------------------------------------------------
// Boot + shutdown
// ---------------------------------------------------------------------------

async function flushAllRooms() {
  await Promise.all([...rooms.values()].map((room) => saveRoom(room).catch(() => {})));
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, flushing worlds...`);
  await flushAllRooms();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await fs.mkdir(SAVES_DIR, { recursive: true });

server.listen(PORT, () => {
  console.log(`Voxelheim server listening on http://localhost:${PORT}`);
  console.log(`  WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
