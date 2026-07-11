// tests-plus/saveload.test.mjs
//
// node:test coverage for the REAL world SAVE/LOAD persistence path.
//
// APPROACH — SERVER-DRIVEN (per TEST RECON §e):
//   Save/load are NOT importable pure functions. They live INLINE in
//   server/index.js (readWorldFromDisk / writeWorldToDisk / saveRoom /
//   loadRoom) with no exports, and importing that module boots an HTTP +
//   WebSocket listener. World writes are reachable ONLY through validated
//   WebSocket `edit` frames (there is deliberately NO REST write/PUT — the
//   old PUT /api/worlds/:id was removed, so it 404s). Therefore this test
//   drives the running server end to end:
//
//     1. spawn `node server/index.js` (child_process) with WORLD_DIR pointing
//        at a throwaway temp dir and a private PORT;
//     2. POST /api/worlds  -> assert the 201 record's canonical SCHEMA
//        { id, name, seed, createdAt, edits:{overworld,nether,end} };
//     3. open three raw `ws` clients, each JOINING a different dimension, and
//        send `edit` frames so the world gains edits in ALL THREE dims;
//     4. close every client -> the server flushes saves/<id>.json on the last
//        leave; read + parse that on-disk JSON (this is the SERIALIZE step);
//     5. assert the on-disk schema + that every edit key matches
//        /^-?\d+,-?\d+,-?\d+$/ and every value is an integer in 0..40;
//     6. RESTART: kill the server, spawn a fresh one on the SAME WORLD_DIR
//        (this is the DESERIALIZE step — the new process loads the file from
//        cold) and read the world back via GET /api/worlds/:id AND via a
//        fresh WS `welcome.world.edits`;
//     7. assert.deepStrictEqual the round-tripped record against the exact
//        object we wrote — serialize -> deserialize -> deep-equal.
//
// FEATURE-DETECT / SKIP GUARD:
//   On the feature/ci branch the game tree is absent: server/index.js does
//   not exist (and `ws` may not be installed). We resolve both up front; if
//   either is missing we register a single skipped test with a TODO instead
//   of crashing, so `node --test tests-plus/` stays green. In the game
//   worktree (origin/feat/voxel-sandbox-game, where tests-plus/ sits next to
//   server/ and node_modules/ws) the real round-trip runs.
//
// Server constants relied on (server/index.js): MAX_BLOCK_ID = 40, y=0 is
// protected bedrock (edits use y in 1..127), MAX_REACH = 6 (edits sit within
// ~1.6 blocks of the (0,80,0) join spawn), DIMENSIONS = overworld/nether/end.

import { test } from 'node:test';
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
// Helpers (server lifecycle + raw ws client — the connectClient/waitFor/
// sendJson pattern from tests/net.test.mjs, per recon §f).
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnServer(port, worldDir) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), WORLD_DIR: worldDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Surface server-side errors during debugging, but don't let them fail the
  // test harness by writing to our own stderr noisily.
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});
  return child;
}

async function waitForHealth(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  return false;
}

function killServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return resolve();
    }
    child.on('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

function connectClient(wsUrl, worldId, name, dim) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const client = { ws, name, welcome: null, msgs: [], waiters: [] };
    const timer = setTimeout(
      () => reject(new Error(`${name}: welcome timeout`)), 5000);
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

/** Poll the on-disk save until it holds edits in all three dims, or time out. */
async function readSaveWithRetry(file, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      const e = parsed.edits || {};
      const ready = ['overworld', 'nether', 'end'].every(
        (d) => e[d] && Object.keys(e[d]).length > 0);
      if (ready) return parsed;
    } catch {
      /* file not written yet / mid-rename */
    }
    await sleep(100);
  }
  throw new Error(`save file never materialized with all dims: ${file}`);
}

const KEY_RE = /^-?\d+,-?\d+,-?\d+$/;

// The exact edits we will apply, per dimension. All keys match KEY_RE, all
// values are integers in 0..40, all cells sit within MAX_REACH (6) of the
// (0,80,0) join spawn and avoid the y=0 bedrock floor. Values include the
// boundaries 0 (air) and 40 (MAX_BLOCK_ID) to exercise the id range edges.
const EXPECTED_EDITS = {
  overworld: { '0,79,0': 1, '1,80,0': 3, '0,80,1': 7 },
  nether: { '0,79,0': 22, '1,80,0': 24, '0,80,1': 23 },
  end: { '0,79,0': 26, '1,80,0': 0, '0,80,1': 40 },
};

// ---------------------------------------------------------------------------

if (loadError) {
  test('saveload: server not available — skipped (TODO)', { skip: true }, () => {
    // TODO: runs for real only in the game worktree
    // (origin/feat/voxel-sandbox-game) where server/index.js and the `ws`
    // dependency are present. On feature/ci they are absent, so this file
    // self-skips. Detect error was: ${loadError && loadError.message}
  });
} else {
  test('save/load round-trip: edits across all three dims serialize, deserialize, deep-equal', async () => {
    const port = 3316;
    const base = `http://localhost:${port}`;
    const wsUrl = `ws://localhost:${port}/ws`;
    const worldDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'loomfall-saveload-'));

    let child = spawnServer(port, worldDir);
    let restarted = null;
    try {
      assert.equal(await waitForHealth(base), true, 'server boots and /api/health responds');

      // --- 1. POST creates a world with the canonical schema ---------------
      const seed = 1234567;
      const name = 'Roundtrip World';
      const postRes = await fetch(`${base}/api/worlds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, seed }),
      });
      assert.equal(postRes.status, 201, 'POST /api/worlds returns 201 Created');
      const created = await postRes.json();

      // Canonical schema { id, name, seed, createdAt, edits:{overworld,nether,end} }.
      assert.equal(typeof created.id, 'string', 'record has a string id');
      assert.match(created.id, /-[a-z0-9]{4}$/, 'id is slug-<4char>');
      assert.equal(created.name, name, 'name is echoed back');
      assert.equal(created.seed, seed, 'seed is preserved');
      assert.equal(typeof created.createdAt, 'string', 'createdAt is a string');
      assert.equal(
        created.createdAt, new Date(created.createdAt).toISOString(),
        'createdAt is a valid ISO-8601 timestamp');
      assert.deepStrictEqual(
        created.edits, { overworld: {}, nether: {}, end: {} },
        'a fresh world has empty edit buckets for exactly the three dims');

      const worldId = created.id;
      const savePath = path.join(worldDir, `${worldId}.json`);

      // The record we EXPECT to see on disk after all edits (players is a
      // live-only field, never serialized).
      const expectedRecord = {
        id: created.id,
        name: created.name,
        seed: created.seed,
        createdAt: created.createdAt,
        edits: EXPECTED_EDITS,
      };

      // --- 2. Apply edits in ALL THREE dimensions via WS -------------------
      // One client per dimension, each JOINING directly into that dim so the
      // player spawns at (0,80,0) with no move/grace/cooldown needed.
      for (const dim of ['overworld', 'nether', 'end']) {
        const client = await connectClient(wsUrl, worldId, `editor-${dim}`, dim);
        assert.equal(client.welcome.world.id, worldId, `${dim}: welcome for the right world`);
        for (const [key, block] of Object.entries(EXPECTED_EDITS[dim])) {
          const [x, y, z] = key.split(',').map(Number);
          sendJson(client, { t: 'edit', x, y, z, block, dim });
        }
        // Messages on a single socket are processed in order; give the server
        // a beat, then assert none of our edits was rejected.
        await sleep(150);
        const reject = client.msgs.find((m) => m.t === 'editReject');
        assert.equal(reject, undefined,
          `${dim}: no edit was rejected` + (reject ? ` (${reject.reason})` : ''));
        await closeClient(client);
      }

      // --- 3. Read the SERIALIZED world from disk --------------------------
      const onDisk = await readSaveWithRetry(savePath);

      // On-disk schema: exactly the five canonical keys, edits exactly the
      // three dimension buckets (no live-only `players`).
      assert.deepStrictEqual(
        Object.keys(onDisk).sort(),
        ['createdAt', 'edits', 'id', 'name', 'seed'],
        'on-disk record has exactly the canonical top-level keys');
      assert.deepStrictEqual(
        Object.keys(onDisk.edits).sort(),
        ['end', 'nether', 'overworld'],
        'edits has exactly the three dimension buckets');

      // Every edit key/value obeys the wire contract.
      for (const dim of ['overworld', 'nether', 'end']) {
        for (const [key, value] of Object.entries(onDisk.edits[dim])) {
          assert.match(key, KEY_RE, `${dim} key "${key}" is "x,y,z"`);
          assert.equal(Number.isInteger(value), true, `${dim} value at ${key} is an integer`);
          assert.ok(value >= 0 && value <= 40, `${dim} value at ${key} in 0..40 (got ${value})`);
        }
      }

      // The whole serialized record must deep-equal what we wrote.
      assert.deepStrictEqual(onDisk, expectedRecord,
        'on-disk record deep-equals the exact world we built');

      // --- 4. RESTART: fresh process DESERIALIZES from cold ----------------
      await killServer(child);
      child = null;
      restarted = spawnServer(port, worldDir);
      assert.equal(await waitForHealth(base), true, 'restarted server responds to /api/health');

      // 4a. GET the world back over REST.
      const getRes = await fetch(`${base}/api/worlds/${worldId}`);
      assert.equal(getRes.status, 200, 'GET /api/worlds/:id after restart is 200');
      const reloaded = await getRes.json();
      const { players, ...reloadedRecord } = reloaded; // strip live-only field
      assert.equal(players, 0, 'no players connected to the freshly loaded world');
      assert.deepStrictEqual(reloadedRecord, expectedRecord,
        'REST-reloaded record round-trips exactly (serialize -> deserialize -> deep-equal)');

      // 4b. Re-join over WS: welcome.world.edits must carry every edit.
      const rejoin = await connectClient(wsUrl, worldId, 'reader', 'overworld');
      try {
        assert.deepStrictEqual(rejoin.welcome.world.edits, EXPECTED_EDITS,
          'WS welcome after restart replays all three dimensions of edits');
        assert.equal(rejoin.welcome.world.id, worldId);
        assert.equal(rejoin.welcome.world.seed, seed);
        assert.equal(rejoin.welcome.world.createdAt, created.createdAt,
          'createdAt is stable across the save/load cycle');
      } finally {
        await closeClient(rejoin);
      }
    } finally {
      await killServer(child);
      await killServer(restarted);
      await fsp.rm(worldDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}
