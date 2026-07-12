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

function connectClient(worldId, name, dim, skin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const client = { ws, name, welcome: null, msgs: [], waiters: [] };
    const timer = setTimeout(() => reject(new Error(`${name}: welcome timeout`)), 5000);
    ws.on('open', () => ws.send(JSON.stringify({
      t: 'join', worldId, name, dim, ...(skin !== undefined ? { skin } : {}),
    })));
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
    // Deploy env coverage: MOTD passthrough + MAX_PLAYERS connection cap.
    env: {
      ...process.env,
      PORT: String(PORT),
      MOTD: '  Welcome to the Loomfall test loom!  ',
      MAX_PLAYERS: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`));

  check('server boots and /api/health responds', await waitForServer());
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check('health payload is {ok:true}', health.ok === true, JSON.stringify(health));
  const healthz = await fetch(`${BASE}/healthz`);
  const healthzBody = await healthz.json();
  check('GET /healthz alias responds 200 {ok:true}',
    healthz.status === 200 && healthzBody.ok === true, JSON.stringify(healthzBody));

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
  check('welcome carries the MOTD env passthrough (trimmed)',
    A.welcome.motd === 'Welcome to the Loomfall test loom!',
    JSON.stringify(A.welcome.motd));

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
  // (3,68,-2) is ~3 blocks from A's server-tracked position (1.5,70,-3.25):
  // inside the server's 6-block reach cap.
  sendJson(A, { t: 'edit', x: 3, y: 68, z: -2, block: 3, dim: 'overworld' });
  const bEdit = await waitFor(B, (m) => m.t === 'edit');
  check('B receives A\'s edit with id + coords + block',
    bEdit.id === A.welcome.id && bEdit.x === 3 && bEdit.y === 68 &&
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
  // Move C near the edit site first (first move after join = grace teleport).
  sendJson(C, { t: 'move', x: 1, y: 51, z: 1, dim: 'nether' });
  await sleep(150);
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

  // --- REST: PUT is removed (security hardening) -----------------------------
  const putRes = await fetch(`${BASE}/api/worlds/${worldId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ edits: { end: { '0,10,0': 26 } } }),
  });
  check('PUT /api/worlds/:id is removed (404) — WS edits are the only write path',
    putRes.status === 404, `status ${putRes.status}`);

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
    saved.edits.overworld['3,68,-2'] === 3, JSON.stringify(saved.edits.overworld));
  check('saves/<id>.json persists nether edit under the right dim',
    saved.edits.nether['1,50,1'] === 22, JSON.stringify(saved.edits.nether));

  // --- rejoin sees prior edits ------------------------------------------------
  const A2 = await connectClient(worldId, 'Alice');
  check('rejoin welcome.world.edits contains the prior edits',
    A2.welcome.world.edits.overworld['3,68,-2'] === 3 &&
    A2.welcome.world.edits.nether['1,50,1'] === 22);
  await closeClient(A2);

  // --- Social wire additions: skin echo / presence / emote / whisper ---------
  // (docs/PROTOCOL.md §4-5; adopted by PlayerStack client-side.)
  {
    const SKIN = '0.3c.0.a8.32'; // valid encoded descriptor (dotted base36)
    const D1 = await connectClient(worldId, 'Dara', 'overworld', SKIN);
    const D2 = await connectClient(worldId, 'Ravi', 'overworld', 'x'.repeat(200));
    const D3 = await connectClient(worldId, 'Noor', 'nether', 'abc<script>');

    // Skin echo: D2/D3 see D1's skin in welcome.peers; peer-join carries it too.
    const d2SeesD1 = D2.welcome.peers.find((p) => p.id === D1.welcome.id);
    check('valid join skin is echoed in welcome.peers', !!d2SeesD1 && d2SeesD1.skin === SKIN,
      JSON.stringify(d2SeesD1));
    const d1JoinD2 = await waitFor(D1, (m) => m.t === 'peer-join' && m.id === D2.welcome.id);
    check('oversized skin (200 chars) is rejected — peer-join has no skin field',
      !('skin' in d1JoinD2), JSON.stringify(d1JoinD2));
    const d3SeenByD1 = await waitFor(D1, (m) => m.t === 'peer-join' && m.id === D3.welcome.id);
    check('off-charset skin is rejected — peer-join has no skin field',
      !('skin' in d3SeenByD1), JSON.stringify(d3SeenByD1));

    // Presence roster: D3's join broadcast a {t:'presence'} snapshot to all.
    const d1Presence = await waitFor(D1,
      (m) => m.t === 'presence' && Array.isArray(m.players) && m.players.length === 3);
    const pNames = d1Presence.players.map((p) => p.name).sort();
    const pNoor = d1Presence.players.find((p) => p.name === 'Noor');
    check('presence roster lists all three players with dims',
      pNames.join(',') === 'Dara,Noor,Ravi' && pNoor.dim === 'nether' && 'ping' in pNoor,
      JSON.stringify(d1Presence.players));

    // Emote: same-dim broadcast, sender excluded, cross-dim excluded.
    sendJson(D1, { t: 'emote', emote: 'wave' });
    const d2Emote = await waitFor(D2, (m) => m.t === 'emote');
    check('emote reaches same-dim peer with sender id',
      d2Emote.id === D1.welcome.id && d2Emote.emote === 'wave', JSON.stringify(d2Emote));
    await sleep(250);
    check('emote is NOT delivered cross-dimension', !D3.msgs.some((m) => m.t === 'emote'));
    check('sender does not receive its own emote', !D1.msgs.some((m) => m.t === 'emote'));

    // Emote rate cap: bucket is 2/s burst 2 — a burst of 6 delivers at most 3
    // (2 tokens + fractional refill during the delivery window).
    const emotesBefore = D2.msgs.filter((m) => m.t === 'emote').length;
    for (let i = 0; i < 6; i++) sendJson(D1, { t: 'emote', emote: 'dance' });
    await sleep(400);
    const emotesDelivered = D2.msgs.filter((m) => m.t === 'emote').length - emotesBefore;
    check('emote rate cap (2/s bucket): burst of 6 delivers at most 3',
      emotesDelivered >= 1 && emotesDelivered <= 3, `delivered=${emotesDelivered}`);

    // Malformed emote ids are dropped.
    const emotesBefore2 = D2.msgs.filter((m) => m.t === 'emote').length;
    await sleep(1200); // refill the bucket so a VALID id would pass
    sendJson(D1, { t: 'emote', emote: 'WAVE!!<>' });
    await sleep(250);
    check('malformed emote id is dropped',
      D2.msgs.filter((m) => m.t === 'emote').length === emotesBefore2);

    // Whisper: target-only delivery + sender echo; third client never sees it.
    sendJson(D1, { t: 'whisper', to: 'Ravi', text: '  secret path behind the falls  ' });
    const d2Whisper = await waitFor(D2, (m) => m.t === 'whisper');
    check('whisper reaches the target (sanitized, from = sender name)',
      d2Whisper.from === 'Dara' && d2Whisper.text === 'secret path behind the falls' &&
      !d2Whisper.echo, JSON.stringify(d2Whisper));
    const d1Echo = await waitFor(D1, (m) => m.t === 'whisper');
    check('sender receives the echo:true confirmation copy',
      d1Echo.echo === true && d1Echo.to === 'Ravi' &&
      d1Echo.text === 'secret path behind the falls', JSON.stringify(d1Echo));
    await sleep(300);
    check('whisper privacy: third client NEVER receives the frame',
      !D3.msgs.some((m) => m.t === 'whisper'));

    // Unknown whisper target answers the sender only.
    sendJson(D1, { t: 'whisper', to: 'Nobody', text: 'hello?' });
    const wErr = await waitFor(D1, (m) => m.t === 'error' && m.code === 'whisper_unknown');
    check('whisper to unknown target answers error: whisper_unknown', !!wErr);

    // Whisper shares the chat rate window (3 per 2 s combined).
    await sleep(2100); // clear the window (1 whisper + 1 unknown attempt used it)
    sendJson(D2, { t: 'whisper', to: 'Dara', text: 'one' });
    sendJson(D2, { t: 'chat', text: 'two' });
    sendJson(D2, { t: 'whisper', to: 'Dara', text: 'three' });
    sendJson(D2, { t: 'whisper', to: 'Dara', text: 'four — over the limit' });
    const rateErr = await waitFor(D2, (m) => m.t === 'error' && m.code === 'chat_rate');
    check('whispers share the chat rate window (4th message in 2s -> chat_rate)', !!rateErr);
    await sleep(300);
    check('over-limit whisper is not delivered',
      D1.msgs.filter((m) => m.t === 'whisper' && !m.echo).length === 2,
      JSON.stringify(D1.msgs.filter((m) => m.t === 'whisper')));

    // Presence on leave: a FRESH roster snapshot (D2's join already produced
    // an earlier 2-player frame, so count frames rather than match shapes).
    const presBefore = D1.msgs.filter((m) => m.t === 'presence').length;
    await closeClient(D3);
    await waitFor(D1, () => D1.msgs.filter((m) => m.t === 'presence').length > presBefore);
    const leavePresence = D1.msgs.filter((m) => m.t === 'presence').pop();
    check('presence roster is re-broadcast on leave (without the leaver)',
      leavePresence.players.length === 2 &&
      leavePresence.players.every((p) => p.name !== 'Noor'),
      JSON.stringify(leavePresence.players));

    await closeClient(D1);
    await closeClient(D2);
    await sleep(300);
  }

  // --- MAX_PLAYERS connection cap (spawned with MAX_PLAYERS=4) ----------------
  {
    const open = (name) => new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      const sock = { ws, name, msgs: [], closed: null };
      ws.on('open', () => resolve(sock));
      ws.on('message', (raw) => { try { sock.msgs.push(JSON.parse(raw.toString())); } catch { /* */ } });
      ws.on('close', (code, reason) => { sock.closed = { code, reason: reason.toString() }; });
      ws.on('error', reject);
    });
    const four = [];
    for (let i = 0; i < 4; i++) four.push(await open(`filler${i}`));
    await sleep(200);
    check('MAX_PLAYERS: 4 concurrent sockets are allowed (cap = 4)',
      four.every((s) => s.ws.readyState === WebSocket.OPEN && !s.closed));
    const fifth = await open('overflow');
    await sleep(400);
    const fullErr = fifth.msgs.find((m) => m.t === 'error' && m.code === 'server_full');
    check('MAX_PLAYERS: 5th socket gets a friendly server_full error',
      !!fullErr && /full/.test(fullErr.message), JSON.stringify(fifth.msgs));
    check('MAX_PLAYERS: 5th socket is closed with 1013 "server full"',
      !!fifth.closed && fifth.closed.code === 1013,
      JSON.stringify(fifth.closed));
    for (const s of four) {
      await new Promise((r) => { if (s.closed) return r(); s.ws.on('close', r); s.ws.close(); });
    }
  }
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
