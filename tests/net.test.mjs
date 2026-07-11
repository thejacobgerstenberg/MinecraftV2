// Voxelheim multiplayer server + protocol tests.
//
// Spawns the real server (server/index.js) as a child process on PORT=3105,
// exercises the REST world API and the /ws JSON protocol with raw `ws`
// clients, verifies dimension scoping and persistence, then cleans up.
//
// Plain node script: prints PASS/FAIL per case, exit code 0 only if all pass.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3105;
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;

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
// Raw ws client helper
// ---------------------------------------------------------------------------

function connectClient(worldId, name, dim) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const client = { ws, name, welcome: null, msgs: [], waiters: [] };
    const timer = setTimeout(() => reject(new Error(`${name}: welcome timeout`)), 5000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', worldId, name, dim })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'welcome' && !client.welcome) {
        client.welcome = msg;
        clearTimeout(timer);
        resolve(client);
        return;
      }
      client.msgs.push(msg);
      client.waiters = client.waiters.filter((w) => !w(msg));
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Resolve with the first (buffered or future) message matching pred. */
function waitFor(client, pred, timeoutMs = 3000) {
  const hit = client.msgs.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${client.name}: timeout waiting for message`)), timeoutMs);
    client.waiters.push((msg) => {
      if (!pred(msg)) return false;
      clearTimeout(timer);
      resolve(msg);
      return true; // remove this waiter
    });
  });
}

function sendJson(client, obj) {
  client.ws.send(JSON.stringify(obj));
}

function closeClient(client) {
  return new Promise((resolve) => {
    if (client.ws.readyState === WebSocket.CLOSED) return resolve();
    client.ws.on('close', resolve);
    client.ws.close();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let child = null;
let worldId = null;

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
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`));

  check('server boots and /api/health responds', await waitForServer());
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check('health payload is {ok:true}', health.ok === true, JSON.stringify(health));

  // --- REST: create / list / get -----------------------------------------
  const createRes = await fetch(`${BASE}/api/worlds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Net Test World', seed: 424242 }),
  });
  const created = await createRes.json();
  worldId = created.id;
  check('POST /api/worlds returns 201', createRes.status === 201, `status ${createRes.status}`);
  check('created world has slugged id + suffix', /^net-test-world-[a-z0-9]{4}$/.test(created.id || ''), created.id);
  check('created world keeps given seed', created.seed === 424242, String(created.seed));
  check('created world has createdAt + 3 dim edit buckets',
    typeof created.createdAt === 'string' &&
    created.edits && typeof created.edits.overworld === 'object' &&
    typeof created.edits.nether === 'object' && typeof created.edits.end === 'object');

  const list = await (await fetch(`${BASE}/api/worlds`)).json();
  const listed = Array.isArray(list) ? list.find((w) => w.id === worldId) : null;
  check('GET /api/worlds lists the new world with players count',
    !!listed && listed.name === 'Net Test World' && listed.players === 0,
    JSON.stringify(listed));

  const got = await (await fetch(`${BASE}/api/worlds/${worldId}`)).json();
  check('GET /api/worlds/:id returns the record', got.id === worldId && got.seed === 424242);

  const missing = await fetch(`${BASE}/api/worlds/does-not-exist-0000`);
  check('GET unknown world returns 404', missing.status === 404, `status ${missing.status}`);

  // --- WS: join, peers, peer-join ------------------------------------------
  const A = await connectClient(worldId, 'Alice');
  check('A gets welcome with self id + world meta',
    typeof A.welcome.id === 'string' && A.welcome.world.id === worldId &&
    A.welcome.world.seed === 424242 && Array.isArray(A.welcome.peers) &&
    A.welcome.peers.length === 0);

  const B = await connectClient(worldId, 'Bob');
  const bSeesA = B.welcome.peers.some((p) => p.id === A.welcome.id && p.name === 'Alice' && p.dim === 'overworld');
  check('B sees A in welcome.peers (with dim)', bSeesA, JSON.stringify(B.welcome.peers));
  const aJoinMsg = await waitFor(A, (m) => m.t === 'peer-join' && m.id === B.welcome.id);
  check('A receives peer-join for B', aJoinMsg.name === 'Bob' && aJoinMsg.dim === 'overworld');

  // --- WS: move -------------------------------------------------------------
  sendJson(A, { t: 'move', x: 1.5, y: 70, z: -3.25, yaw: 1.25, pitch: -0.5, dim: 'overworld' });
  const bMove = await waitFor(B, (m) => m.t === 'move' && m.id === A.welcome.id);
  check('B receives A\'s move with matching coords',
    bMove.x === 1.5 && bMove.y === 70 && bMove.z === -3.25 &&
    bMove.yaw === 1.25 && bMove.pitch === -0.5 && bMove.dim === 'overworld',
    JSON.stringify(bMove));
  check('A does not receive its own move back', !A.msgs.some((m) => m.t === 'move' && m.id === A.welcome.id));

  // --- WS: edit -------------------------------------------------------------
  sendJson(A, { t: 'edit', x: 5, y: 64, z: -2, block: 3, dim: 'overworld' });
  const bEdit = await waitFor(B, (m) => m.t === 'edit');
  check('B receives A\'s edit with id + coords + block',
    bEdit.id === A.welcome.id && bEdit.x === 5 && bEdit.y === 64 &&
    bEdit.z === -2 && bEdit.block === 3 && bEdit.dim === 'overworld',
    JSON.stringify(bEdit));

  // Invalid edits must be rejected (error to sender, no broadcast).
  sendJson(A, { t: 'edit', x: 1, y: 999, z: 1, block: 3, dim: 'overworld' });
  sendJson(A, { t: 'edit', x: 1, y: 60, z: 1, block: 99, dim: 'overworld' });
  sendJson(A, { t: 'edit', x: 1.5, y: 60, z: 1, block: 3, dim: 'overworld' });
  const errCount = (await waitFor(A, (m) => m.t === 'error'), A.msgs.filter((m) => m.t === 'error').length);
  check('invalid edits produce error frames to sender', errCount >= 1, `errors=${errCount}`);
  await sleep(200);
  check('invalid edits are not broadcast', B.msgs.filter((m) => m.t === 'edit').length === 1);

  // --- WS: dimension scoping ------------------------------------------------
  const C = await connectClient(worldId, 'Cara', 'nether');
  await waitFor(A, (m) => m.t === 'peer-join' && m.id === C.welcome.id);
  check('C joins nether; A gets peer-join carrying dim',
    A.msgs.some((m) => m.t === 'peer-join' && m.id === C.welcome.id && m.dim === 'nether'));

  const cMovesBefore = C.msgs.filter((m) => m.t === 'move').length;
  sendJson(A, { t: 'move', x: 9, y: 70, z: 9, yaw: 0, pitch: 0, dim: 'overworld' });
  await waitFor(B, (m) => m.t === 'move' && m.x === 9); // B (same dim) does get it
  await sleep(300);
  check('A\'s move is NOT delivered to C (other dim)',
    C.msgs.filter((m) => m.t === 'move').length === cMovesBefore);

  const abEditsBefore = A.msgs.filter((m) => m.t === 'edit').length + B.msgs.filter((m) => m.t === 'edit').length;
  sendJson(C, { t: 'edit', x: 1, y: 50, z: 1, block: 22, dim: 'nether' });
  await sleep(300);
  check('C\'s nether edit is NOT delivered to A or B',
    A.msgs.filter((m) => m.t === 'edit').length + B.msgs.filter((m) => m.t === 'edit').length === abEditsBefore);

  sendJson(C, { t: 'chat', text: '  hello from the nether  ' });
  const aChat = await waitFor(A, (m) => m.t === 'chat');
  const bChat = await waitFor(B, (m) => m.t === 'chat');
  const cChat = await waitFor(C, (m) => m.t === 'chat');
  check('C\'s chat reaches A and B across dimensions (trimmed)',
    aChat.text === 'hello from the nether' && bChat.text === 'hello from the nether' &&
    aChat.id === C.welcome.id && aChat.name === 'Cara');
  check('chat echoes back to sender', cChat.text === 'hello from the nether');

  // --- REST: PUT merge -------------------------------------------------------
  const putRes = await fetch(`${BASE}/api/worlds/${worldId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ edits: { end: { '0,10,0': 26 } } }),
  });
  const putWorld = await putRes.json();
  check('PUT /api/worlds/:id merges edits without clobbering other dims',
    putRes.status === 200 && putWorld.edits.end['0,10,0'] === 26 &&
    putWorld.edits.overworld['5,64,-2'] === 3 && putWorld.edits.nether['1,50,1'] === 22,
    JSON.stringify(putWorld.edits));

  // --- peer-leave + persistence on last disconnect ---------------------------
  const leavePromise = waitFor(B, (m) => m.t === 'peer-leave' && m.id === A.welcome.id);
  await closeClient(A);
  await leavePromise;
  check('B receives peer-leave when A disconnects', true);

  await closeClient(B);
  await closeClient(C);
  await sleep(500); // last-leave save is immediate, give the fs write a beat

  const saveFile = path.join(ROOT, 'saves', `${worldId}.json`);
  const saved = JSON.parse(await fs.readFile(saveFile, 'utf8'));
  check('saves/<id>.json persists overworld edit under the right dim',
    saved.edits.overworld['5,64,-2'] === 3, JSON.stringify(saved.edits.overworld));
  check('saves/<id>.json persists nether edit under the right dim',
    saved.edits.nether['1,50,1'] === 22, JSON.stringify(saved.edits.nether));

  // --- rejoin sees prior edits ------------------------------------------------
  const A2 = await connectClient(worldId, 'Alice');
  check('rejoin welcome.world.edits contains the prior edits',
    A2.welcome.world.edits.overworld['5,64,-2'] === 3 &&
    A2.welcome.world.edits.nether['1,50,1'] === 22 &&
    A2.welcome.world.edits.end['0,10,0'] === 26);
  await closeClient(A2);
}

async function cleanup() {
  if (worldId) {
    await fs.rm(path.join(ROOT, 'saves', `${worldId}.json`), { force: true }).catch(() => {});
  }
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
