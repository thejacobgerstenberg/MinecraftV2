// tests-plus/protocol.anticheat.test.mjs
//
// REGRESSION NET for the server-authority / anticheat rules that were found
// VULNERABLE in the authority audit (docs/SECURITY_FINDINGS.md) and are now
// FIXED in the hardened server (origin/feat/voxel-sandbox-game). Every case
// here asserts the FIXED behavior so the anticheat can never silently regress.
//
// APPROACH — SERVER-DRIVEN (per TEST RECON §f):
//   The anticheat validators (validBlockId / handleMove / handleEdit /
//   rejectEdit / handleChat, plus the WS-server maxPayload + per-connection
//   message-rate limiter) are NOT importable pure functions. They live INLINE
//   in server/index.js with NO exports, and importing that module boots an
//   HTTP + WebSocket listener. There is also NO scripts/lib protocol/transport
//   module in the game worktree. So — exactly as recon prescribes — this file
//   drives a REAL spawned server over a raw `ws` socket (the
//   connectClient/sendJson/waitFor helper pattern), sends the offending
//   frames, and asserts the server REJECTS / IGNORES / PERSISTS-NOTHING,
//   confirming non-persistence via GET /api/worlds/:id.
//
//   (If these validators were ever refactored into importable pure functions,
//   the correct move would be direct unit tests — in-reach edit accepted, dist
//   7+ rejected, y=0 rejected, block 9999 rejected, cross-dim rejected. They
//   are not, so we server-drive. This is noted for the maintainer.)
//
// CASES (each a distinct node:test; all server-driven):
//   1.  reach          — in-reach edit ACCEPTED; edit 100 blocks away REJECTED + not persisted
//   2.  edit-rate      — 20/s cap: a 60-edit burst is throttled (excess editReject, few persist)
//   3.  chat-rate      — 3/2000ms cap: burst chats rejected with 'chat_rate', echoes capped
//   4.  bedrock-y0     — break at y=0 REJECTED + not persisted (protected floor)
//   5.  xz-bounds      — edit at |x|>30_000_000 REJECTED + not persisted
//   6.  block-id       — block 9999 and block -1 REJECTED + not persisted (locked-in PASS)
//   7.  cross-dim      — edit tagged for another dim never lands in that dim
//   8.  name-sanitize  — control chars / <> / over-length name never reach the wire raw
//   9.  chat-sanitize  — chat HTML is escaped/stripped server-side; raw <img never on wire
//   10. frame-size     — a frame > MAX_WS_PAYLOAD (65536) closes the socket (1009)
//   11. msg-rate       — a message flood past the burst cap closes the socket (1008)
//
// FEATURE-DETECT / SKIP GUARD:
//   On feature/ci the game tree is absent (no server/index.js; `ws` may be
//   missing). We resolve both up front; if either is missing we register ONE
//   skipped test with a TODO so `node --test tests-plus/` stays green. The
//   real suite runs only in the game worktree where tests-plus/ sits next to
//   server/ and node_modules/ws.
//
// Server constants exercised (server/index.js, per recon §f):
//   MAX_BLOCK_ID 40 · y edit 0<=y<128, y=0 protected · MAX_COORD_XZ 30_000_000
//   MAX_WS_PAYLOAD 65536 (close 1009) · MSG_RATE 60/s burst 120 (close 1008)
//   EDIT_RATE 20/s · CHAT_RATE 3/2000ms (err 'chat_rate') · MAX_REACH 6
//   NAME_MAX 24 · CHAT_MAX 256 · editReject {t,x,y,z,block,dim,reason}.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
// In the game worktree tests-plus/ sits at repo root next to server/.
const ROOT = path.resolve(TEST_DIR, '..');
const SERVER_ENTRY = path.join(ROOT, 'server', 'index.js');

// ---- Feature-detect server presence + the `ws` dependency ------------------
let WebSocket = null;
let loadError = null;

if (!fs.existsSync(SERVER_ENTRY)) {
  loadError = new Error(`server entry not found at ${SERVER_ENTRY}`);
} else {
  try {
    ({ WebSocket } = await import('ws'));
    if (typeof WebSocket !== 'function') throw new Error('ws export not callable');
  } catch (err) {
    loadError = err;
  }
}

// ---------------------------------------------------------------------------
// Helpers (server lifecycle + raw ws client — the connectClient/sendJson/
// waitFor pattern reused from tests/net.test.mjs & saveload.test.mjs, per recon).
// ---------------------------------------------------------------------------

const PORT = 3318; // distinct from other tests-plus server suites (saveload=3316)
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, msg) {
  let t;
  const guard = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); });
  return Promise.race([promise, guard]).finally(() => clearTimeout(t));
}

function spawnServer(port, worldDir) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), WORLD_DIR: worldDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});
  return child;
}

async function waitForHealth(base, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return false;
}

function killServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

/** Join a world and resolve once the server's `welcome` arrives. The returned
 *  client records every subsequent server frame in `.msgs` and exposes a
 *  `.closed` promise that resolves with {code, reason} on socket close. */
function connectClient(worldId, name, dim = 'overworld') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const client = { ws, name, welcome: null, msgs: [], closeInfo: null };
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`${name}: welcome timeout`)); }
    }, 6000);
    client.closed = new Promise((res) => {
      ws.on('close', (code, rb) => {
        client.closeInfo = { code, reason: rb ? rb.toString() : '' };
        res(client.closeInfo);
      });
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', worldId, name, dim })));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { msg = { raw: raw.toString() }; }
      if (!client.welcome && msg.t === 'welcome') {
        client.welcome = msg;
        clearTimeout(timer);
        if (!settled) { settled = true; resolve(client); }
        return;
      }
      client.msgs.push(msg);
    });
    ws.on('error', (err) => {
      // Errors after a successful join (e.g. server-initiated close during a
      // rate-limit test) are expected — only reject if we never got welcome.
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    });
  });
}

/** Open a raw socket WITHOUT joining (for pre-join transport-layer checks like
 *  the oversized-frame maxPayload close). Resolves on `open`. */
function rawConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const state = { ws, msgs: [], closeInfo: null };
    state.closed = new Promise((res) => {
      ws.on('close', (code, rb) => {
        state.closeInfo = { code, reason: rb ? rb.toString() : '' };
        res(state.closeInfo);
      });
    });
    ws.on('message', (raw) => {
      try { state.msgs.push(JSON.parse(raw.toString())); } catch { state.msgs.push({ raw: raw.toString() }); }
    });
    ws.on('error', () => {}); // abnormal closes surface via 'close'
    ws.on('open', () => resolve(state));
    setTimeout(() => reject(new Error('open timeout')), 6000);
  });
}

function sendJson(client, obj) { safeSend(client.ws, JSON.stringify(obj)); }

function safeSend(ws, data) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch { /* closing */ }
}

function closeClient(client) {
  return new Promise((resolve) => {
    const ws = client.ws;
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on('close', () => resolve());
    try { ws.close(); } catch { resolve(); }
  });
}

async function createWorld(name = 'AC Test', seed = 42) {
  const res = await fetch(`${BASE}/api/worlds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, seed }),
  });
  assert.equal(res.status, 201, 'POST /api/worlds returns 201');
  return res.json();
}

async function getWorldRetry(worldId, tries = 25) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}/api/worlds/${worldId}`);
      if (res.ok) { last = await res.json(); return last; }
    } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error(`GET /api/worlds/${worldId} never succeeded`);
}

const editsOf = (rec, dim) => (rec && rec.edits && rec.edits[dim]) || {};
const hasEditReject = (msgs, x, y, z) =>
  msgs.some((m) => m.t === 'editReject' && m.x === x && m.y === y && m.z === z);
const frameJsonIncludes = (msgs, substr) =>
  msgs.some((m) => JSON.stringify(m).includes(substr));

// A block-space control edit that saveload.test.mjs already proves is accepted
// at the (~0,80,0) join spawn (well within MAX_REACH=6). Used as a positive
// control so each test proves the edit pipeline RAN and flushed while the
// offending cell was selectively rejected.
const CTRL = { x: 1, y: 80, z: 0, block: 2 };

// ---------------------------------------------------------------------------

if (loadError) {
  test('anticheat: server/ws not available — skipped (TODO)', { skip: true }, () => {
    // TODO: runs for real only in the game worktree
    // (origin/feat/voxel-sandbox-game) where server/index.js and the `ws`
    // dependency are present. On feature/ci they are absent, so this file
    // self-skips. Detected: ${loadError && loadError.message}
  });
} else {
  let child = null;
  let worldDir = null;

  before(async () => {
    worldDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'loomfall-anticheat-'));
    child = spawnServer(PORT, worldDir);
    const ok = await waitForHealth(BASE);
    assert.equal(ok, true, 'server boots and /api/health responds');
  });

  after(async () => {
    await killServer(child);
    if (worldDir) await fsp.rm(worldDir, { recursive: true, force: true }).catch(() => {});
  });

  // --- 1. REACH -------------------------------------------------------------
  test('reach: in-reach edit accepted, edit 100 blocks away rejected and not persisted', async () => {
    const w = await createWorld('reach');
    const c = await connectClient(w.id, 'reacher');
    try {
      sendJson(c, { t: 'edit', ...CTRL, dim: 'overworld' });        // in-reach -> accept
      sendJson(c, { t: 'edit', x: 100, y: 80, z: 0, block: 1, dim: 'overworld' }); // far -> reject
      await sleep(250);
      assert.equal(hasEditReject(c.msgs, 100, 80, 0), true,
        'server sends editReject for the out-of-reach edit');
    } finally {
      await closeClient(c);
    }
    const rec = await getWorldRetry(w.id);
    const ow = editsOf(rec, 'overworld');
    assert.equal(ow['1,80,0'], CTRL.block, 'in-reach edit persisted');
    assert.equal('100,80,0' in ow, false, 'out-of-reach edit was NOT persisted');
  });

  // --- 2. EDIT RATE ---------------------------------------------------------
  test('edit-rate: a 60-edit burst is throttled to the 20/s cap (excess rejected, not all persist)', async () => {
    const w = await createWorld('editrate');
    const c = await connectClient(w.id, 'spammer');
    // 60 DISTINCT in-reach cells so persisted-count == accepted-count.
    const px = 0, py = 80, pz = 0;
    const reach = (x, y, z) => {
      const cy = (y + 0.5) - Math.min(Math.max(y + 0.5, py), py + 1.8);
      return Math.hypot(x + 0.5 - px, cy, z + 0.5 - pz);
    };
    const cells = [];
    for (const y of [79, 80, 81]) {
      for (let x = -5; x <= 5 && cells.length < 60; x++) {
        for (let z = -5; z <= 5 && cells.length < 60; z++) {
          if (reach(x, y, z) <= 5.8 && !(x === 0 && z === 0 && y === 80)) cells.push([x, y, z]);
        }
      }
    }
    assert.equal(cells.length, 60, 'have 60 distinct in-reach cells for the burst');
    try {
      for (const [x, y, z] of cells) sendJson(c, { t: 'edit', x, y, z, block: 1, dim: 'overworld' });
      await sleep(500);
    } finally {
      await closeClient(c);
    }
    const rejects = c.msgs.filter((m) => m.t === 'editReject').length;
    const rec = await getWorldRetry(w.id);
    const ow = editsOf(rec, 'overworld');
    const persisted = cells.filter(([x, y, z]) => `${x},${y},${z}` in ow).length;
    assert.ok(persisted >= 1, `at least some in-reach edits applied (persisted=${persisted})`);
    assert.ok(persisted <= 45, `edit-rate cap throttled the burst (persisted=${persisted} of 60)`);
    assert.ok(rejects >= 10, `excess edits were rejected (editReject count=${rejects})`);
  });

  // --- 3. CHAT RATE ---------------------------------------------------------
  test("chat-rate: burst past 3/2000ms is rejected with 'chat_rate' and echoes are capped", async () => {
    const w = await createWorld('chatrate');
    const c = await connectClient(w.id, 'chatter');
    const N = 10;
    try {
      for (let i = 0; i < N; i++) sendJson(c, { t: 'chat', text: `rate-probe-${i}` });
      await sleep(400);
    } finally {
      await closeClient(c);
    }
    const echoes = c.msgs.filter((m) => m.t === 'chat' && typeof m.text === 'string' && m.text.startsWith('rate-probe-')).length;
    const rateErrs = c.msgs.filter((m) => JSON.stringify(m).includes('chat_rate')).length;
    assert.ok(echoes <= 4, `chat echoes capped near the 3/2000ms limit (echoes=${echoes})`);
    assert.ok(rateErrs >= 3, `over-cap chats rejected with chat_rate (count=${rateErrs})`);
  });

  // --- 4. BEDROCK / y=0 -----------------------------------------------------
  test('bedrock-y0: break at y=0 is rejected and never persisted (protected floor)', async () => {
    const w = await createWorld('bedrock');
    const c = await connectClient(w.id, 'digger');
    try {
      sendJson(c, { t: 'edit', ...CTRL, dim: 'overworld' });                // control
      sendJson(c, { t: 'edit', x: 0, y: 0, z: 0, block: 0, dim: 'overworld' }); // break bedrock
      await sleep(250);
      assert.equal(hasEditReject(c.msgs, 0, 0, 0), true, 'server sends editReject for the y=0 break');
    } finally {
      await closeClient(c);
    }
    const ow = editsOf(await getWorldRetry(w.id), 'overworld');
    assert.equal(ow['1,80,0'], CTRL.block, 'control edit persisted (pipeline ran)');
    assert.equal('0,0,0' in ow, false, 'y=0 bedrock cell was NOT overwritten');
  });

  // --- 5. XZ BOUNDS ---------------------------------------------------------
  test('xz-bounds: edit at |x| > 30_000_000 is rejected and not persisted', async () => {
    const w = await createWorld('xzbounds');
    const c = await connectClient(w.id, 'farflung');
    const X = 40_000_000;
    try {
      sendJson(c, { t: 'edit', ...CTRL, dim: 'overworld' });               // control
      sendJson(c, { t: 'edit', x: X, y: 80, z: 0, block: 1, dim: 'overworld' });
      await sleep(250);
      assert.equal(hasEditReject(c.msgs, X, 80, 0), true, 'server sends editReject for the OOB edit');
    } finally {
      await closeClient(c);
    }
    const ow = editsOf(await getWorldRetry(w.id), 'overworld');
    assert.equal(ow['1,80,0'], CTRL.block, 'control edit persisted');
    assert.equal(`${X},80,0` in ow, false, 'out-of-bounds XZ edit was NOT persisted (no map bloat)');
  });

  // --- 6. BLOCK ID ----------------------------------------------------------
  test('block-id: block 9999 and block -1 are rejected and not persisted', async () => {
    const w = await createWorld('blockid');
    const c = await connectClient(w.id, 'iddler');
    try {
      sendJson(c, { t: 'edit', ...CTRL, dim: 'overworld' });                 // control
      sendJson(c, { t: 'edit', x: 2, y: 80, z: 0, block: 9999, dim: 'overworld' }); // > MAX_BLOCK_ID
      sendJson(c, { t: 'edit', x: 2, y: 81, z: 0, block: -1, dim: 'overworld' });   // negative
      await sleep(250);
      assert.equal(hasEditReject(c.msgs, 2, 80, 0), true, 'editReject for block 9999');
      assert.equal(hasEditReject(c.msgs, 2, 81, 0), true, 'editReject for block -1');
    } finally {
      await closeClient(c);
    }
    const ow = editsOf(await getWorldRetry(w.id), 'overworld');
    assert.equal(ow['1,80,0'], CTRL.block, 'control edit persisted');
    assert.equal('2,80,0' in ow, false, 'block 9999 edit was NOT persisted');
    assert.equal('2,81,0' in ow, false, 'block -1 edit was NOT persisted');
  });

  // --- 7. CROSS-DIMENSION ---------------------------------------------------
  test('cross-dim: an edit tagged for another dimension never lands in that dimension', async () => {
    const w = await createWorld('crossdim');
    // Attacker joined in overworld; tries to write into nether via msg.dim.
    const c = await connectClient(w.id, 'dimhopper', 'overworld');
    try {
      sendJson(c, { t: 'edit', ...CTRL, dim: 'overworld' });                        // control (own dim)
      sendJson(c, { t: 'edit', x: 2, y: 80, z: 0, block: 5, dim: 'nether' });       // cross-dim write
      await sleep(250);
    } finally {
      await closeClient(c);
    }
    const rec = await getWorldRetry(w.id);
    // Security invariant regardless of whether the server rejects the frame or
    // rebinds it to the player's own dim: the FOREIGN dim must not receive it.
    assert.equal('2,80,0' in editsOf(rec, 'nether'), false,
      'cross-dimension edit did NOT land in the nether dimension');
    assert.equal(editsOf(rec, 'overworld')['1,80,0'], CTRL.block,
      'control edit in the player\'s own dimension persisted');
  });

  // --- 8. NAME SANITIZATION -------------------------------------------------
  test('name-sanitize: control chars, <> and over-length names never reach the wire raw', async () => {
    const w = await createWorld('namesan');
    const observer = await connectClient(w.id, 'observer');
    // Malicious display name: <>, a NUL and a BEL control char, 150 chars long.
    const NUL = String.fromCharCode(0);
    const BEL = String.fromCharCode(7);
    const evil = '<script>' + NUL + BEL + 'x'.repeat(150);
    const attacker = await connectClient(w.id, evil);
    try {
      await sleep(400);
      const frames = [attacker.welcome, ...attacker.msgs, ...observer.msgs];
      // Nothing raw or dangerous may appear anywhere on the wire.
      assert.equal(frameJsonIncludes(frames, '<script>'), false, 'raw <script> is never broadcast');
      assert.equal(frameJsonIncludes(frames, NUL), false, 'NUL control char is stripped');
      assert.equal(frameJsonIncludes(frames, BEL), false, 'BEL control char is stripped');
      // Length cap: NAME_MAX=24, so no 30-char run of the padding survives.
      assert.equal(frameJsonIncludes(frames, 'x'.repeat(30)), false,
        'over-length name was truncated to <= NAME_MAX (no 30-char run survives)');
    } finally {
      await closeClient(attacker);
      await closeClient(observer);
    }
  });

  // --- 9. CHAT SANITIZATION -------------------------------------------------
  test('chat-sanitize: chat HTML is escaped/stripped server-side (raw <img never on wire)', async () => {
    const w = await createWorld('chatsan');
    const c = await connectClient(w.id, 'xsser');
    try {
      sendJson(c, { t: 'chat', text: '<img src=x onerror=alert(1)>' });
      await sleep(400);
    } finally {
      await closeClient(c);
    }
    const frames = c.msgs;
    // The raw HTML tag must never be broadcast verbatim...
    assert.equal(frameJsonIncludes(frames, '<img'), false,
      'raw <img tag is never broadcast (escaped or stripped server-side)');
    // ...but the message WAS delivered (echoed to the room), just neutralized.
    assert.equal(frameJsonIncludes(frames, 'onerror=alert(1)'), true,
      'the chat text was still delivered (payload text present, only < > neutralized)');
  });

  // --- 10. FRAME SIZE (transport) ------------------------------------------
  test('frame-size: a frame larger than MAX_WS_PAYLOAD (65536) closes the socket (1009)', async () => {
    const s = await rawConnect();
    // 100 KB > 65536 -> ws server maxPayload closes with 1009 before app logic.
    const huge = JSON.stringify({ t: 'chat', text: 'A'.repeat(100_000) });
    safeSend(s.ws, huge);
    const info = await withTimeout(s.closed, 6000,
      'oversized frame was NOT closed (maxPayload cap regressed)');
    assert.equal(info.code, 1009, `oversized frame closed with 1009 (got ${info.code})`);
  });

  // --- 11. MESSAGE RATE (transport) ----------------------------------------
  test('msg-rate: a message flood past the burst cap closes the socket (1008)', async () => {
    const w = await createWorld('msgrate');
    const c = await connectClient(w.id, 'flooder');
    // Blast well past MSG_RATE burst (120) -> server strikes and closes 1008.
    for (let i = 0; i < 400; i++) {
      safeSend(c.ws, JSON.stringify({ t: 'move', x: 0, y: 80, z: 0, yaw: 0, pitch: 0, dim: 'overworld' }));
    }
    const info = await withTimeout(c.closed, 6000,
      'message flood was NOT closed (rate limiter regressed)');
    assert.equal(info.code, 1008, `flood closed with 1008 (got ${info.code}, reason="${info.reason}")`);
  });
}
