// Loomfall multiplayer server. (Working title in some internal keys: Voxelheim.)
//
// - Serves the static client from public/.
// - REST API for world records (create / list / get), persisted as
//   saves/<id>.json. Writes happen ONLY through validated WebSocket edits —
//   there is deliberately no REST write/PUT endpoint (see docs/PROTOCOL.md §7).
// - WebSocket endpoint at /ws hosting one "room" per world with
//   join / move / respawn / edit / chat traffic. All inbound traffic is validated and
//   rate-limited server-side; the server is authoritative for player
//   position, dimension, names, and world edits. See docs/PROTOCOL.md for the
//   full message reference and the security/limits table.

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

// --- Security limits (documented in docs/PROTOCOL.md §7) --------------------

/** Hard cap on a single WebSocket frame; larger frames close the socket (1009). */
const MAX_WS_PAYLOAD_BYTES = 65536;
/** Global inbound message rate per connection (all message types). */
const MSG_RATE = { perSec: 60, burst: 120, maxStrikes: 3 };
/** Block-edit rate per connection. */
const EDIT_RATE = { perSec: 20, burst: 20 };
/** Chat rate per connection (sliding window). */
const CHAT_RATE = { msgs: 3, perMs: 2000 };
/** Max sustained "controllable" movement speed (horizontal + upward), b/s.
 * Creative sprint-fly is 20 b/s; 25 leaves headroom for jitter. */
const MAX_MOVE_SPEED = 25;
/** Max sustained downward speed, b/s (free fall peaks around 81 b/s). */
const MAX_FALL_SPEED = 90;
/** Movement budgets accrue up to this many seconds of allowance (burst). */
const MOVE_BURST_S = 1;
/** Min interval between dimension-change grace teleports (anti dim-flapping). */
const GRACE_COOLDOWN_MS = 2000;
/** Horizontal radius around the recorded spawn anchor within which an
 * announced-respawn move is accepted (spawn is deterministic; 8 covers
 * throttling drift between the respawn and the next outgoing move). */
const RESPAWN_RADIUS = 8;
/** Min interval between move_rejected notices to a violating sender. */
const MOVE_REJECT_NOTICE_MS = 1000;
/** Server-side edit reach cap; client reach is 5, +2 covers eye/latency slack. */
const MAX_REACH = 7;
/** World edit + movement horizontal bound. */
const MAX_COORD_XZ = 30_000_000;
/** Sanity bounds for move y (kill plane is -10; world height 128). */
const MOVE_MIN_Y = -64;
const MOVE_MAX_Y = 512;
/** Player collision height, for the reach check's vertical segment. */
const PLAYER_HEIGHT = 1.8;
const NAME_MAX = 24;
const CHAT_MAX = 256;

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const NAME_STRIP_RE = /[<>&"']/g;
const HTML_ESCAPE_RE = /[&<>"']/g;
const HTML_ESCAPES = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

// ---------------------------------------------------------------------------
// Small helpers: token buckets + sanitizers
// ---------------------------------------------------------------------------

function makeBucket(capacity, refillPerSec) {
  return { tokens: capacity, capacity, refillPerSec, at: Date.now() };
}

function refillBucket(bucket, now = Date.now()) {
  bucket.tokens = Math.min(
    bucket.capacity,
    bucket.tokens + ((now - bucket.at) / 1000) * bucket.refillPerSec,
  );
  bucket.at = now;
  return bucket;
}

/** Refill, then take `n` tokens; false (and no deduction) if not available. */
function takeTokens(bucket, n = 1, now = Date.now()) {
  refillBucket(bucket, now);
  if (bucket.tokens < n) return false;
  bucket.tokens -= n;
  return true;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Escape &<>"' as HTML entities (defense-in-depth for chat/name broadcast). */
function escapeHtml(s) {
  return String(s).replace(HTML_ESCAPE_RE, (c) => HTML_ESCAPES[c]);
}

/** Strip control chars and <>&"', trim, cap at NAME_MAX. May return ''. */
function sanitizeName(raw) {
  return String(raw ?? '')
    .replace(CONTROL_CHARS_RE, '')
    .replace(NAME_STRIP_RE, '')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
}

/** Dedup a display name within a room by appending 2, 3, ... (cap kept). */
function uniqueName(room, base) {
  const taken = new Set([...room.clients.values()].map((p) => p.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const candidate = base.slice(0, NAME_MAX - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// World records + persistence
// ---------------------------------------------------------------------------

/**
 * Rooms keyed by world id. Each room:
 *   { world, clients: Map<clientId, player>, saveTimer, dirty }
 * where player = { id, name, ws, x, y, z, yaw, pitch, dim, ...rate/anticheat }.
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
// Bodies are tiny (POST /api/worlds only takes {name, seed}); keep the cap low.
app.use(express.json({ limit: '64kb' }));

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

// NOTE: there is intentionally NO PUT/PATCH/DELETE on /api/worlds/:id.
// The old unauthenticated `PUT /api/worlds/:id` bulk-write was removed
// (security audit finding S1): world edits are persisted exclusively through
// validated WebSocket `edit` messages. Unknown routes fall through to 404.

app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
// WebSocket rooms
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_WS_PAYLOAD_BYTES, // oversized frames close the socket (1009)
});

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
  // ws.joining guards the await below: two join frames processed in the same
  // tick would otherwise both pass the ws.player check and double-register.
  if (ws.player || ws.joining) {
    return send(ws, { t: 'error', code: 'already_joined', message: 'this socket already joined a world' });
  }
  const worldId = typeof msg.worldId === 'string' ? msg.worldId : '';
  if (!ID_RE.test(worldId)) {
    return send(ws, { t: 'error', code: 'bad_join', message: 'invalid worldId' });
  }
  ws.joining = true;
  let room;
  try {
    // Auto-create on direct join (dev convenience); menu flow uses POST first.
    room = await loadRoom(worldId, { create: true });
  } finally {
    ws.joining = false;
  }
  // Re-check after the await: a concurrent frame may have joined, or the
  // socket may have closed while the world was loading (a player registered
  // now would never be cleaned up by the close handler -> ghost peer).
  if (ws.player) {
    return send(ws, { t: 'error', code: 'already_joined', message: 'this socket already joined a world' });
  }
  if (ws.readyState !== ws.OPEN) {
    unloadRoomIfEmpty(room);
    return;
  }
  // Names: strip control chars + <>&"', cap at 24, fall back to a generated
  // "Wanderer-xxxx", and dedup within the room by appending a numeral.
  const name = uniqueName(room, sanitizeName(msg.name) || `Wanderer-${randomSuffix()}`);
  const dim = DIMENSIONS.includes(msg.dim) ? msg.dim : 'overworld';

  const player = {
    id: `p${nextClientId++}`,
    name,
    ws,
    x: 0, y: 80, z: 0, yaw: 0, pitch: 0,
    dim,
    // Anti-cheat / rate-limit state (server-side only; never serialized —
    // peerSnapshot picks its fields explicitly).
    pendingGrace: true, // the first move after join is a free teleport
    pendingRespawn: false, // set by a `respawn` frame; honored only INTO the anchor
    anchorX: 0, // spawn anchor: join spawn / dimension entry point (see handleMove)
    anchorZ: 0,
    lastTeleportAt: 0,
    lastMoveRejectAt: 0,
    ctrlBudget: makeBucket(MAX_MOVE_SPEED * MOVE_BURST_S, MAX_MOVE_SPEED),
    fallBudget: makeBucket(MAX_FALL_SPEED * MOVE_BURST_S, MAX_FALL_SPEED),
    editBucket: makeBucket(EDIT_RATE.burst, EDIT_RATE.perSec),
    chatTimes: [],
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

/**
 * Movement validation (server-authoritative position):
 *  - non-finite or out-of-world coordinates -> frame silently dropped;
 *  - displacement is charged against two token buckets: "controllable"
 *    (horizontal + upward, 25 b/s sustained, 25-block burst) and "fall"
 *    (downward, 90 b/s — free fall legitimately reaches ~81 b/s);
 *  - a move that exceeds its budget is DROPPED (the server keeps the last
 *    valid position and notifies the sender with `error: move_rejected`,
 *    throttled to 1/s) unless one of the EXPLICIT grace teleports applies:
 *      1. the first move after join (the client computes its own spawn);
 *      2. a dimension change, at most once per GRACE_COOLDOWN_MS (portal
 *         travel remaps coordinates; the cooldown stops dim-flap teleports);
 *      3. an announced respawn (`{t:'respawn'}` frame), honored ONLY into
 *         the recorded spawn anchor (horizontal distance <= RESPAWN_RADIUS).
 *    Grace teleports refill both budgets. There is deliberately NO
 *    unconditional "resync" grace: an over-budget move that matches no rule
 *    above is never accepted or broadcast, no matter how long the sender
 *    waits (security checklist: a 500-block teleport is never seen by peers).
 *
 * The spawn anchor is the last position the player legitimately (re)spawned
 * at: the first move after join, updated by every dimension-change grace
 * (the arrival point is the new spawn column — the client sets
 * `player.spawn` there, see main.js switchDimension).
 */
function handleMove(ws, msg) {
  const { player, room } = ws;
  const x = Number(msg.x), y = Number(msg.y), z = Number(msg.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  if (Math.abs(x) > MAX_COORD_XZ || Math.abs(z) > MAX_COORD_XZ ||
      y < MOVE_MIN_Y || y > MOVE_MAX_Y) return;
  const yaw = Number.isFinite(Number(msg.yaw)) ? Number(msg.yaw) : 0;
  const pitch = Number.isFinite(Number(msg.pitch)) ? Number(msg.pitch) : 0;
  const newDim = DIMENSIONS.includes(msg.dim) ? msg.dim : player.dim;
  const dimChanged = newDim !== player.dim;

  const now = Date.now();
  refillBucket(player.ctrlBudget, now);
  refillBucket(player.fallBudget, now);
  const dxz = Math.hypot(x - player.x, z - player.z);
  const up = Math.max(0, y - player.y);
  const down = Math.max(0, player.y - y);
  const ctrl = Math.hypot(dxz, up);
  const withinBudget =
    ctrl <= player.ctrlBudget.tokens + 1e-6 &&
    down <= player.fallBudget.tokens + 1e-6;

  if (withinBudget && !dimChanged) {
    player.ctrlBudget.tokens = Math.max(0, player.ctrlBudget.tokens - ctrl);
    player.fallBudget.tokens = Math.max(0, player.fallBudget.tokens - down);
  } else {
    // Over budget (or a dimension change, which is always teleport-like).
    // Only the explicit, bounded graces documented above apply.
    let grace = false;
    if (player.pendingGrace) {
      grace = true; // rule 1: first move after join
    } else if (dimChanged) {
      // rule 2: dimension travel, rate-limited against dim-flapping
      grace = now - player.lastTeleportAt >= GRACE_COOLDOWN_MS;
    } else if (player.pendingRespawn &&
               Math.hypot(x - player.anchorX, z - player.anchorZ) <= RESPAWN_RADIUS) {
      // rule 3: announced respawn, and ONLY back into the spawn anchor —
      // useless for teleport cheating (equivalent to legitimately dying),
      // hence no cooldown (denying a real respawn would desync the client).
      grace = true;
      player.pendingRespawn = false;
    }
    if (!grace) {
      // Violation: keep the last authoritative position. Tell the sender
      // (throttled) so a desynced client is observable in its console.
      if (now - player.lastMoveRejectAt >= MOVE_REJECT_NOTICE_MS) {
        player.lastMoveRejectAt = now;
        send(ws, {
          t: 'error',
          code: 'move_rejected',
          message: `move exceeds the speed budget; server keeps `
            + `(${player.x.toFixed(1)}, ${player.y.toFixed(1)}, ${player.z.toFixed(1)})`,
        });
      }
      return;
    }
    if (player.pendingGrace || dimChanged) player.lastTeleportAt = now;
    player.ctrlBudget.tokens = player.ctrlBudget.capacity;
    player.fallBudget.tokens = player.fallBudget.capacity;
  }
  if (player.pendingGrace || dimChanged) {
    // (Re)anchor the respawn point: join spawn or dimension entry point.
    player.anchorX = x;
    player.anchorZ = z;
  }
  player.pendingGrace = false;

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

/**
 * Every rejected edit answers the SENDER with an `editReject` frame so an
 * optimistic client can roll its local world back (audit finding: silent
 * drops left ghost blocks until rejoin). The frame carries the authoritative
 * block for the cell: the stored edit at that key if any, else -1 meaning
 * "generated terrain — restore from your deterministic generator copy".
 * `reason` is one of rate|reach|bounds|protected|dim|invalid.
 * Coordinates are echoed only when integers (never reflect junk), and each
 * inbound edit produces at most one editReject (no amplification).
 */
function rejectEdit(ws, msg, reason) {
  const { player, room } = ws;
  const x = Number.isInteger(msg.x) ? msg.x : null;
  const y = Number.isInteger(msg.y) ? msg.y : null;
  const z = Number.isInteger(msg.z) ? msg.z : null;
  let block = -1;
  if (x !== null && y !== null && z !== null &&
      Math.abs(x) <= MAX_COORD_XZ && Math.abs(z) <= MAX_COORD_XZ &&
      y >= 0 && y < WORLD_HEIGHT) {
    const stored = room.world.edits[player.dim][`${x},${y},${z}`];
    if (Number.isInteger(stored)) block = stored;
  }
  send(ws, { t: 'editReject', x, y, z, block, dim: player.dim, reason });
}

/**
 * Edit validation (server-authoritative world state):
 *  - integer coords, block id 0..40, |x|,|z| <= 30,000,000, 0 <= y < 128;
 *  - y === 0 is the bedrock floor: NO edit (break or place) is accepted there;
 *  - the edit is bound to the sender's server-tracked dimension; a client
 *    `dim` field is accepted for compat but must match (else rejected);
 *  - reach: distance from the player's collision column (server-tracked feet
 *    position, height 1.8) to the block center must be <= 7 (client reach 5);
 *  - rate: 20 edits/s per connection (token bucket); excess edits are dropped.
 * EVERY rejection (including rate) also answers the sender with an
 * `editReject` rollback frame — see rejectEdit above and docs/PROTOCOL.md.
 */
function handleEdit(ws, msg) {
  const { player, room } = ws;
  const { x, y, z, block } = msg;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || !validBlockId(block)) {
    rejectEdit(ws, msg, 'invalid');
    return send(ws, { t: 'error', code: 'bad_edit', message: 'invalid edit (integer coords, block 0..40)' });
  }
  if (Math.abs(x) > MAX_COORD_XZ || Math.abs(z) > MAX_COORD_XZ || y < 0 || y >= WORLD_HEIGHT) {
    rejectEdit(ws, msg, 'bounds');
    return send(ws, { t: 'error', code: 'bad_edit', message: 'edit out of world bounds' });
  }
  if (y === 0) {
    rejectEdit(ws, msg, 'protected');
    return send(ws, { t: 'error', code: 'bad_edit', message: 'y=0 is unbreakable bedrock' });
  }
  if (msg.dim !== undefined && msg.dim !== player.dim) {
    rejectEdit(ws, msg, 'dim');
    return send(ws, { t: 'error', code: 'bad_edit', message: 'edit dim does not match your dimension' });
  }
  const dim = player.dim;
  const cy = y + 0.5 - clamp(y + 0.5, player.y, player.y + PLAYER_HEIGHT);
  const dist = Math.hypot(x + 0.5 - player.x, cy, z + 0.5 - player.z);
  if (dist > MAX_REACH) {
    rejectEdit(ws, msg, 'reach');
    return send(ws, { t: 'error', code: 'bad_edit', message: `edit out of reach (max ${MAX_REACH})` });
  }
  if (!takeTokens(player.editBucket)) {
    // Over 20 edits/s: dropped, but the sender still gets the rollback frame
    // (no error frame — one small editReject per inbound edit, bounded by
    // the global message rate, so this cannot amplify).
    return rejectEdit(ws, msg, 'rate');
  }
  room.world.edits[dim][`${x},${y},${z}`] = block;
  markDirty(room);
  broadcast(room, { t: 'edit', id: player.id, x, y, z, block, dim },
    { dim, except: player.id });
}

/**
 * Respawn announcement: the client declares that its NEXT over-budget move
 * is a respawn teleport. The grace is only honored INTO the recorded spawn
 * anchor (see handleMove rule 3), so the signal cannot be abused to teleport
 * anywhere else — spamming it grants nothing a legitimate death would not.
 * The flag persists until consumed by a matching move (a respawn close to
 * the death spot may produce an ordinary within-budget move instead).
 */
function handleRespawn(ws) {
  ws.player.pendingRespawn = true;
}

/**
 * Chat: control chars stripped, trimmed, capped at 256 chars, then HTML-
 * escaped (&<>"') on broadcast. Rate limited to 3 messages per 2 s per
 * connection; a breach drops the message and warns the sender.
 */
function handleChat(ws, msg) {
  const { player, room } = ws;
  const text = String(msg.text ?? '')
    .replace(CONTROL_CHARS_RE, '')
    .trim()
    .slice(0, CHAT_MAX);
  if (!text) return;
  const now = Date.now();
  player.chatTimes = player.chatTimes.filter((t) => now - t < CHAT_RATE.perMs);
  if (player.chatTimes.length >= CHAT_RATE.msgs) {
    return send(ws, {
      t: 'error',
      code: 'chat_rate',
      message: `chat limited to ${CHAT_RATE.msgs} messages per ${CHAT_RATE.perMs / 1000}s`,
    });
  }
  player.chatTimes.push(now);
  broadcast(room, {
    t: 'chat', id: player.id, name: escapeHtml(player.name), text: escapeHtml(text),
  });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  // Global inbound rate limit: 60 msg/s sustained, burst 120. Each message
  // over the limit is dropped and counts a strike; 3 strikes close the
  // socket with 1008 "rate limit".
  ws.msgBucket = makeBucket(MSG_RATE.burst, MSG_RATE.perSec);
  ws.strikes = 0;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    if (!takeTokens(ws.msgBucket)) {
      ws.strikes += 1;
      if (ws.strikes >= MSG_RATE.maxStrikes) ws.close(1008, 'rate limit');
      return;
    }
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
      case 'respawn': handleRespawn(ws); break;
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
  console.log(`Loomfall server listening on http://localhost:${PORT}`);
  console.log(`  WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
