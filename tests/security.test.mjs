// Loomfall server security regression suite.
//
// Spawns the real server (server/index.js) as a child on PORT=3310 and
// exercises every hardening measure from the security audit:
//   S0  DoS: 64 KiB frame cap (close 1009) + global msg rate limit (close 1008)
//   S1  REST lockdown: PUT /api/worlds/:id removed (404)
//   S1  speed/teleport validation (grace on join + dimension change)
//   S1  edit reach cap (7 blocks), edit bounds, cross-dimension binding
//   S1  edit rate cap (20/s token bucket)
//   S2  bedrock floor (no edits at y=0)
//   S2  name sanitization / fallback / dedup
//   S2  chat sanitization + HTML escaping + 3-per-2s rate limit
// plus locked-in behaviors (no id spoofing, non-finite coords dropped,
// last-writer-wins) and a legit end-to-end join/move/edit/chat roundtrip.
//
// Plain node script: prints PASS/FAIL per case, exit code 0 only if all pass.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3310;
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const RUN = `sec${Date.now().toString(36)}`; // unique world-id prefix per run

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Raw ws client helpers
// ---------------------------------------------------------------------------

const openSockets = new Set();

/** Open a socket without joining (for DoS checks). */
function rawConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    openSockets.add(ws);
    const client = { ws, msgs: [], waiters: [], closed: null, closeWaiters: [] };
    ws.on('open', () => resolve(client));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      client.msgs.push(msg);
      client.waiters = client.waiters.filter((w) => !w(msg));
    });
    ws.on('close', (code, reason) => {
      client.closed = { code, reason: reason.toString() };
      for (const w of client.closeWaiters.splice(0)) w(client.closed);
      openSockets.delete(ws);
    });
    ws.on('error', (err) => {
      if (!client.closed && ws.readyState === WebSocket.CONNECTING) reject(err);
      /* post-open errors (e.g. server dropping an oversized frame) are
         followed by 'close', which the tests wait on */
    });
  });
}

/** Open a socket and join a world; resolves after welcome. */
async function connectClient(worldId, name, dim) {
  const client = await rawConnect();
  client.name = name;
  client.ws.send(JSON.stringify({ t: 'join', worldId, name, dim }));
  client.welcome = await waitFor(client, (m) => m.t === 'welcome', 5000);
  client.id = client.welcome.id;
  return client;
}

/** Resolve with the first (buffered or future) message matching pred. */
function waitFor(client, pred, timeoutMs = 3000) {
  const hit = client.msgs.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timeout waiting for message')), timeoutMs);
    client.waiters.push((msg) => {
      if (!pred(msg)) return false;
      clearTimeout(timer);
      resolve(msg);
      return true;
    });
  });
}

function waitForClose(client, timeoutMs = 5000) {
  if (client.closed) return Promise.resolve(client.closed);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timeout waiting for close')), timeoutMs);
    client.closeWaiters.push((closed) => {
      clearTimeout(timer);
      resolve(closed);
    });
  });
}

function sendJson(client, obj) {
  client.ws.send(JSON.stringify(obj));
}

function count(client, pred) {
  return client.msgs.filter(pred).length;
}

/** Poll until at least `min` messages match pred (handles buffered history). */
async function waitForCount(client, pred, min, timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (count(client, pred) >= min) return true;
    await sleep(25);
  }
  return count(client, pred) >= min;
}

function closeClient(client) {
  return new Promise((resolve) => {
    if (client.ws.readyState === WebSocket.CLOSED) return resolve();
    client.ws.on('close', resolve);
    client.ws.close();
  });
}

async function getWorld(id) {
  const res = await fetch(`${BASE}/api/worlds/${id}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function testDosOversizedFrame() {
  const c = await rawConnect();
  c.ws.send('x'.repeat(70000)); // > 65536 maxPayload
  const closed = await waitForClose(c);
  check('S0 oversized frame (70000 B) closes the connection', !!closed);
  check('S0 oversized frame close code is 1009', closed.code === 1009, `code=${closed.code}`);
}

async function testDosFlood() {
  const c = await rawConnect();
  for (let i = 0; i < 400; i++) c.ws.send('{"t":"nop"}');
  const closed = await waitForClose(c);
  check('S0 400-message flood closes the connection', !!closed);
  check('S0 flood close is 1008 "rate limit"',
    closed.code === 1008 && closed.reason === 'rate limit',
    `code=${closed.code} reason="${closed.reason}"`);
}

async function testDosNormalRateSurvives() {
  // 40 msg/s for 1.5s is well under the 60/s sustained cap: must stay open.
  const worldId = `${RUN}-rate`;
  const c = await connectClient(worldId, 'Steady');
  for (let i = 0; i < 60; i++) {
    sendJson(c, { t: 'move', x: i * 0.2, y: 80, z: 0 });
    await sleep(25);
  }
  check('S0 legit message rate (40/s) does not trip the limiter',
    c.ws.readyState === WebSocket.OPEN && !c.closed);
  await closeClient(c);
}

async function testRestPutRemoved() {
  const createRes = await fetch(`${BASE}/api/worlds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${RUN} put probe` }),
  });
  const created = await createRes.json();
  check('S1 REST world create still works (201)', createRes.status === 201, `status ${createRes.status}`);

  const putRes = await fetch(`${BASE}/api/worlds/${created.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ edits: { overworld: { '5,10,5': 40 } } }),
  });
  check('S1 PUT /api/worlds/:id is gone (404)', putRes.status === 404, `status ${putRes.status}`);

  const after = await getWorld(created.id);
  check('S1 PUT payload did not persist',
    after.edits && Object.keys(after.edits.overworld).length === 0,
    JSON.stringify(after.edits));
  await fs.rm(path.join(ROOT, 'saves', `${created.id}.json`), { force: true }).catch(() => {});
}

async function testSpeedHack() {
  const worldId = `${RUN}-speed`;
  const A = await connectClient(worldId, 'Speedy');
  const B = await connectClient(worldId, 'Watcher');

  // Grace: the first move after join is accepted even if far from spawn.
  sendJson(A, { t: 'move', x: 450, y: 80, z: 450 });
  const first = await waitFor(B, (m) => m.t === 'move' && m.id === A.id);
  check('S1 first move after join is a grace teleport (accepted)', first.x === 450 && first.z === 450);

  // Teleport: +1000 blocks in one frame must be rejected...
  sendJson(A, { t: 'move', x: 1450, y: 80, z: 450 });
  // ...while a normal follow-up move passes. Ordered socket => if the small
  // move arrived and the teleport never did, the teleport was rejected.
  sendJson(A, { t: 'move', x: 451, y: 80, z: 451 });
  const small = await waitFor(B, (m) => m.t === 'move' && m.id === A.id && m.x === 451);
  check('S1 normal movement still passes validation', small.z === 451);
  check('S1 +1000-block teleport move is rejected (never broadcast)',
    !B.msgs.some((m) => m.t === 'move' && m.x === 1450));

  // Sustained speed: a burst of moves adding up to far more than 25 b/s
  // must be clamped to roughly the budget.
  for (let i = 1; i <= 20; i++) {
    sendJson(A, { t: 'move', x: 451 + i * 5, y: 80, z: 451 }); // 5 blocks per frame
  }
  await sleep(500);
  const accepted = B.msgs.filter((m) => m.t === 'move' && m.id === A.id && m.x > 451);
  const maxX = Math.max(...accepted.map((m) => m.x), 451);
  check('S1 sustained speed is capped near the 25 b/s budget (burst <= ~30 blocks)',
    maxX - 451 <= 30, `advanced ${maxX - 451} blocks in ~0.1s`);

  return { A, B, worldId };
}

async function testReachAndBounds(ctx) {
  const { A, B } = ctx;
  // Re-anchor A deterministically (its position after the speed test depends
  // on where the budget ran out): wait out the grace cooldown, teleport-resync.
  await sleep(2100);
  sendJson(A, { t: 'move', x: 3, y: 80, z: 3 });
  await waitFor(B, (m) => m.t === 'move' && m.id === A.id && m.x === 3);

  const editsBefore = count(B, (m) => m.t === 'edit');

  // Near edit (~1.6 blocks) passes.
  sendJson(A, { t: 'edit', x: 4, y: 80, z: 3, block: 1, dim: 'overworld' });
  const near = await waitFor(B, (m) => m.t === 'edit' && m.x === 4);
  check('S1 in-reach edit is accepted and broadcast', near.block === 1 && near.id === A.id);

  // Far edit (~57 blocks) rejected with an error.
  const errsBefore = count(A, (m) => m.t === 'error');
  sendJson(A, { t: 'edit', x: 60, y: 80, z: 3, block: 1, dim: 'overworld' });
  check('S1 out-of-reach edit (57 blocks) is rejected with an error',
    await waitForCount(A, (m) => m.t === 'error', errsBefore + 1));

  // Bounds: absurd coords, y out of range, non-integers -> all rejected.
  sendJson(A, { t: 'edit', x: 40000000, y: 80, z: 3, block: 1 });
  sendJson(A, { t: 'edit', x: 1000000000000, y: 80, z: 3, block: 1 });
  sendJson(A, { t: 'edit', x: 3, y: 200, z: 3, block: 1 });
  sendJson(A, { t: 'edit', x: 3, y: -5, z: 3, block: 1 });
  sendJson(A, { t: 'edit', x: 3.5, y: 80, z: 3, block: 1 });
  // Sync: a valid edit after the invalid batch.
  sendJson(A, { t: 'edit', x: 3, y: 79, z: 4, block: 2, dim: 'overworld' });
  await waitFor(B, (m) => m.t === 'edit' && m.block === 2);
  const editsAfter = count(B, (m) => m.t === 'edit');
  check('S1 absurd/out-of-bounds/non-integer edits are never broadcast',
    editsAfter === editsBefore + 2, `observer saw ${editsAfter - editsBefore} edits, expected 2`);

  const world = await getWorld(ctx.worldId);
  check('S1 no out-of-bounds key persisted',
    !Object.keys(world.edits.overworld).some((k) => Math.abs(Number(k.split(',')[0])) > 30000000),
    JSON.stringify(Object.keys(world.edits.overworld)));
}

async function testCrossDimension(ctx) {
  const { A, worldId } = ctx;
  const N = await connectClient(worldId, 'NetherWatch', 'nether');

  // A is in the overworld; a client-supplied dim of "nether" must be rejected.
  const errsBefore = count(A, (m) => m.t === 'error');
  sendJson(A, { t: 'edit', x: 4, y: 79, z: 3, block: 5, dim: 'nether' });
  check('S1 cross-dimension edit is rejected with an error',
    await waitForCount(A, (m) => m.t === 'error', errsBefore + 1));
  await sleep(300);
  check('S1 cross-dimension edit is not delivered to nether players',
    count(N, (m) => m.t === 'edit') === 0);
  const world = await getWorld(worldId);
  check('S1 cross-dimension edit did not persist into the nether bucket',
    world.edits.nether['4,79,3'] === undefined, JSON.stringify(world.edits.nether));

  // Dimension-change move = grace teleport; edits then bind to the new dim.
  await sleep(2100); // grace cooldown
  sendJson(A, { t: 'move', x: 8, y: 64, z: 8, dim: 'nether' });
  const upsert = await waitFor(N, (m) => m.t === 'peer-join' && m.id === A.id);
  check('S1 dimension change is accepted as a grace teleport (peer-join upsert)',
    upsert.dim === 'nether' && upsert.x === 8);
  sendJson(A, { t: 'edit', x: 9, y: 63, z: 8, block: 3, dim: 'nether' });
  const nEdit = await waitFor(N, (m) => m.t === 'edit' && m.x === 9);
  check('S1 after dimension change edits apply to the server-tracked dim', nEdit.dim === 'nether');

  await closeClient(N);
}

async function testEditRateCap() {
  const worldId = `${RUN}-editrate`;
  const D = await connectClient(worldId, 'Digger');
  const E = await connectClient(worldId, 'Observer');
  sendJson(D, { t: 'move', x: 1, y: 80, z: 1 });
  await waitFor(E, (m) => m.t === 'move' && m.id === D.id);

  for (let i = 0; i < 60; i++) {
    sendJson(D, { t: 'edit', x: i % 4, y: 79, z: (i >> 2) % 4, block: 1, dim: 'overworld' });
  }
  await sleep(800);
  const got = count(E, (m) => m.t === 'edit');
  check('S1 edit flood of 60 is capped near 20/s (observer saw 15..30)',
    got >= 15 && got <= 30, `observer saw ${got}`);
  await closeClient(D);
  await closeClient(E);
}

async function testBedrock() {
  const worldId = `${RUN}-bedrock`;
  const F = await connectClient(worldId, 'Miner');
  const G = await connectClient(worldId, 'Watcher');
  sendJson(F, { t: 'move', x: 1, y: 1, z: 1 }); // grace move down to the floor
  await waitFor(G, (m) => m.t === 'move' && m.id === F.id);

  const errsBefore = count(F, (m) => m.t === 'error');
  sendJson(F, { t: 'edit', x: 1, y: 0, z: 1, block: 0, dim: 'overworld' }); // break bedrock
  sendJson(F, { t: 'edit', x: 2, y: 0, z: 1, block: 5, dim: 'overworld' }); // place at y=0
  sendJson(F, { t: 'edit', x: 2, y: 1, z: 2, block: 1, dim: 'overworld' }); // legal, y=1
  const legal = await waitFor(G, (m) => m.t === 'edit' && m.y === 1);
  check('S2 edits at y=1 still work', legal.block === 1);
  check('S2 breaking/placing at y=0 (bedrock) is rejected with errors',
    await waitForCount(F, (m) => m.t === 'error', errsBefore + 2),
    `errors=${count(F, (m) => m.t === 'error')}`);
  check('S2 no y=0 edit was broadcast', !G.msgs.some((m) => m.t === 'edit' && m.y === 0));
  const world = await getWorld(worldId);
  check('S2 no y=0 edit persisted',
    world.edits.overworld['1,0,1'] === undefined && world.edits.overworld['2,0,1'] === undefined,
    JSON.stringify(world.edits.overworld));
  await closeClient(F);
  await closeClient(G);
}

async function testNamesAndChat() {
  const worldId = `${RUN}-names`;
  const I = await connectClient(worldId, 'Iris');

  // XSS/control-char name arrives sanitized.
  const H = await connectClient(worldId, '  <script>alert("x")</script>\u0007Bob  ');
  const hJoin = await waitFor(I, (m) => m.t === 'peer-join' && m.id === H.id);
  check('S2 name is stripped of <>&\'" and control chars, capped at 24',
    !/[<>&"'\u0000-\u001f\u007f-\u009f]/.test(hJoin.name) && hJoin.name.length <= 24 &&
    hJoin.name.includes('Bob'),
    JSON.stringify(hJoin.name));

  // Empty-after-sanitization name falls back to Wanderer-xxxx.
  const J = await connectClient(worldId, '\u0001 \u0002');
  const jJoin = await waitFor(I, (m) => m.t === 'peer-join' && m.id === J.id);
  check('S2 empty name falls back to Wanderer+suffix', /^Wanderer-/.test(jJoin.name), jJoin.name);

  // Duplicate names are deduped with a numeral.
  const K = await connectClient(worldId, 'Twin');
  const L = await connectClient(worldId, 'Twin');
  const kJoin = await waitFor(I, (m) => m.t === 'peer-join' && m.id === K.id);
  const lJoin = await waitFor(I, (m) => m.t === 'peer-join' && m.id === L.id);
  check('S2 duplicate name deduped within the room',
    kJoin.name === 'Twin' && lJoin.name === 'Twin2',
    `${kJoin.name} / ${lJoin.name}`);

  // Chat XSS: broadcast arrives HTML-escaped.
  sendJson(H, { t: 'chat', text: '<img src=x onerror=alert(1)>&co\u0007ntrol' });
  const chat = await waitFor(I, (m) => m.t === 'chat' && m.id === H.id);
  check('S2 chat text is HTML-escaped and control-stripped on broadcast',
    chat.text === '&lt;img src=x onerror=alert(1)&gt;&amp;control', JSON.stringify(chat.text));
  check('S2 chat sender name is escaped/sanitized too', !/[<>]/.test(chat.name), chat.name);

  // Chat rate: 3 per 2s; the 4th+5th are dropped with a warn to the sender.
  const chatsBefore = count(I, (m) => m.t === 'chat');
  for (let i = 1; i <= 5; i++) sendJson(J, { t: 'chat', text: `spam${i}` });
  await waitFor(J, (m) => m.t === 'error' && m.code === 'chat_rate', 3000);
  check('S2 chat flood warns the sender (chat_rate error)', true);
  await sleep(300);
  check('S2 only 3 of 5 rapid chats are delivered',
    count(I, (m) => m.t === 'chat') === chatsBefore + 3,
    `delivered ${count(I, (m) => m.t === 'chat') - chatsBefore}`);
  await sleep(2100); // window expires -> chatting works again
  sendJson(J, { t: 'chat', text: 'after cooldown' });
  const later = await waitFor(I, (m) => m.t === 'chat' && m.text === 'after cooldown');
  check('S2 chat works again after the rate window', !!later);

  for (const c of [I, H, J, K, L]) await closeClient(c);
}

async function testLockedBehaviorsAndRoundtrip() {
  const worldId = `${RUN}-lock`;
  const M = await connectClient(worldId, 'Mallory');
  const N = await connectClient(worldId, 'Nancy');

  // Id/name spoofing: server stamps its own identity.
  sendJson(M, { t: 'move', x: 1, y: 80, z: 1, id: 'p999', name: 'evil' });
  const mv = await waitFor(N, (m) => m.t === 'move' && m.x === 1);
  check('LOCK move broadcast carries the server-assigned id (no spoofing)',
    mv.id === M.id && !N.msgs.some((m) => m.id === 'p999'), JSON.stringify(mv));

  // Non-finite coords never propagate.
  sendJson(M, { t: 'move', x: 'NaN', y: 80, z: 1 });
  sendJson(M, { t: 'move', x: 'Infinity', y: 80, z: 1 });
  sendJson(M, { t: 'move', x: 1.5, y: 80, z: 1 }); // sync frame
  await waitFor(N, (m) => m.t === 'move' && m.x === 1.5);
  check('LOCK non-finite coordinates are dropped',
    !N.msgs.some((m) => m.t === 'move' && (typeof m.x !== 'number' || !Number.isFinite(m.x))));

  // Last-writer-wins on the same cell.
  sendJson(M, { t: 'edit', x: 1, y: 79, z: 1, block: 7, dim: 'overworld' });
  sendJson(M, { t: 'edit', x: 1, y: 79, z: 1, block: 9, dim: 'overworld' });
  await waitFor(N, (m) => m.t === 'edit' && m.block === 9);
  const world = await getWorld(worldId);
  check('LOCK same-cell edits resolve last-writer-wins',
    world.edits.overworld['1,79,1'] === 9, JSON.stringify(world.edits.overworld));

  // Legit end-to-end roundtrip through every middleware layer.
  const O = await connectClient(worldId, 'Newcomer');
  check('E2E welcome carries prior validated edits',
    O.welcome.world.edits.overworld['1,79,1'] === 9);
  sendJson(O, { t: 'move', x: 2, y: 80, z: 2 });
  const oMove = await waitFor(N, (m) => m.t === 'move' && m.id === O.id);
  check('E2E join/move roundtrip works', oMove.x === 2);
  sendJson(O, { t: 'edit', x: 2, y: 79, z: 2, block: 4, dim: 'overworld' });
  const oEdit = await waitFor(N, (m) => m.t === 'edit' && m.id === O.id);
  check('E2E edit roundtrip works', oEdit.block === 4);
  sendJson(O, { t: 'chat', text: 'hello world' });
  const oChatN = await waitFor(N, (m) => m.t === 'chat' && m.id === O.id);
  const oChatSelf = await waitFor(O, (m) => m.t === 'chat' && m.id === O.id);
  check('E2E chat roundtrip works (peer + self echo, benign text untouched)',
    oChatN.text === 'hello world' && oChatSelf.text === 'hello world');

  for (const c of [M, N, O]) await closeClient(c);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let child = null;

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return false;
}

async function main() {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`));

  check('server boots and /api/health responds', await waitForServer());

  await testDosOversizedFrame();
  await testDosFlood();
  await testDosNormalRateSurvives();
  await testRestPutRemoved();
  const ctx = await testSpeedHack();
  await testReachAndBounds(ctx);
  await testCrossDimension(ctx);
  await closeClient(ctx.A);
  await closeClient(ctx.B);
  await testEditRateCap();
  await testBedrock();
  await testNamesAndChat();
  await testLockedBehaviorsAndRoundtrip();
}

async function cleanup() {
  for (const ws of [...openSockets]) {
    try { ws.terminate(); } catch { /* already gone */ }
  }
  // Remove every world this run created (all ids start with the RUN prefix,
  // and REST-created ones slugify to the same prefix).
  try {
    const files = await fs.readdir(path.join(ROOT, 'saves'));
    for (const f of files) {
      if (f.startsWith(RUN)) {
        await fs.rm(path.join(ROOT, 'saves', f), { force: true }).catch(() => {});
      }
    }
  } catch { /* saves dir missing */ }
  if (child && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
  }
}

try {
  await main();
} catch (err) {
  failed++;
  console.log(`FAIL unexpected error — ${err.stack || err}`);
} finally {
  await cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
