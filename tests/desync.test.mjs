// Loomfall edit-rejection desync regression suite.
//
// The audit repro: an optimistic client flooding 35 rapid breaks had only
// ~20 persist server-side (20/s edit token bucket) while the other ~15 stayed
// broken locally until rejoin — silent ghost blocks. The fix: EVERY rejected
// edit (rate, reach, bounds, protected, dim, invalid) answers the sender
// with {t:'editReject', x, y, z, block, dim, reason} where `block` is the
// authoritative block at the cell (stored edit) or -1 ("generated terrain —
// restore from your deterministic local generator").
//
// This suite drives client A through the REAL NetClient (pure module, runs
// under node's global WebSocket) with a stub world recording setBlock calls,
// mirrors main.js's optimistic-edit + rollback logic, floods 35 edits in
// <1s, and asserts:
//   1. A receives editReject frames for every dropped edit (reason 'rate');
//   2. a FRESH client B joining afterwards sees a world whose edit record
//      matches what A now shows locally, cell by cell (no ghost blocks);
//   3. a reject on a cell with a PRIOR stored edit carries that block id
//      (block >= 0 rollback path), and A converges to it.
//
// Plain node script: prints PASS/FAIL per case, exit code 0 only if all pass.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { NetClient } from '../public/src/net/NetClient.js';
import { TerrainGenerator } from '../public/src/world/TerrainGenerator.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3312;
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const WORLD_ID = `desync-${Date.now().toString(36)}`;

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

/** Raw ws observer client (join + collect welcome), like the other suites. */
function connectRaw(worldId, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const client = { ws, welcome: null };
    const timer = setTimeout(() => reject(new Error(`${name}: welcome timeout`)), 5000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', worldId, name })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'welcome' && !client.welcome) {
        client.welcome = msg;
        clearTimeout(timer);
        resolve(client);
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function closeRaw(client) {
  return new Promise((resolve) => {
    if (client.ws.readyState === WebSocket.CLOSED) return resolve();
    client.ws.on('close', resolve);
    client.ws.close();
  });
}

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

/** Poll until fn() stops growing (stable for `settleMs`). */
async function settle(fn, settleMs = 500, timeoutMs = 4000) {
  const t0 = Date.now();
  let last = fn();
  let lastChange = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(50);
    const cur = fn();
    if (cur !== last) { last = cur; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= settleMs) return cur;
  }
  return fn();
}

let child = null;

async function main() {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`));
  check('server boots and /api/health responds', await waitForServer());

  // --- Client A: real NetClient + stub world mirroring main.js -------------
  const A = new NetClient();
  const welcome = await A.connect(BASE, WORLD_ID, 'Flooder');
  check('A joins via real NetClient (welcome carries seed)',
    Number.isInteger(welcome.world.seed) || typeof welcome.world.seed === 'string');

  // Same deterministic generator the browser client builds from the seed.
  const gen = new TerrainGenerator(welcome.world.seed, 'overworld');

  // Stub world: overrides on top of generated terrain; records setBlock.
  const overrides = new Map();
  const setBlockCalls = [];
  const world = {
    setBlock(x, y, z, id) {
      setBlockCalls.push([x, y, z, id]);
      overrides.set(`${x},${y},${z}`, id);
    },
    getBlock(x, y, z) {
      const k = `${x},${y},${z}`;
      return overrides.has(k) ? overrides.get(k) : gen.blockAt(x, y, z);
    },
  };
  const localEdits = {}; // mirror of main.js S.editsByDim.overworld

  // Rollback handler — the same logic main.js wires to onEditReject.
  const rejects = [];
  A.onEditReject((msg) => {
    rejects.push(msg);
    const { x, y, z } = msg;
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return;
    const key = `${x},${y},${z}`;
    if (Number.isInteger(msg.block) && msg.block >= 0) {
      localEdits[key] = msg.block;
      world.setBlock(x, y, z, msg.block);
    } else {
      delete localEdits[key];
      world.setBlock(x, y, z, gen.blockAt(x, y, z));
    }
  });

  // Anchor A near the edit site (first move after join = grace teleport).
  A.sendMove({ x: 2, y: 80, z: 2 });
  await sleep(200);

  // --- Phase 1: flood 35 breaks in <1 s (optimistic, production-style) -----
  const coords = [];
  for (let x = 0; x <= 4; x++) {
    for (let z = 0; z <= 6; z++) coords.push([x, 79, z]); // 35 cells, all in reach
  }
  for (const [x, y, z] of coords) {
    // Exactly what main.js onBreak does: local setBlock + record + sendEdit.
    world.setBlock(x, y, z, 0);
    localEdits[`${x},${y},${z}`] = 0;
    A.sendEdit(x, y, z, 0);
  }

  const rejectCount = await settle(() => rejects.length);
  check('flood: some edits were rate-rejected (bucket is 20/s, sent 35)',
    rejectCount >= 10 && rejectCount < 35, `rejects=${rejectCount}`);
  check('flood: every reject carries reason "rate"',
    rejects.every((r) => r.reason === 'rate'),
    JSON.stringify([...new Set(rejects.map((r) => r.reason))]));
  check('flood: rejects on never-edited cells carry block=-1 (restore generated)',
    rejects.every((r) => r.block === -1),
    JSON.stringify(rejects.slice(0, 3)));
  check('flood: rejects echo integer coords + dim',
    rejects.every((r) => Number.isInteger(r.x) && Number.isInteger(r.y) &&
      Number.isInteger(r.z) && r.dim === 'overworld'));
  check('flood: rollback called setBlock for every rejected cell',
    rejects.every((r) => setBlockCalls.some(
      ([x, y, z]) => x === r.x && y === r.y && z === r.z &&
        setBlockCalls.filter(([a, b, c]) => a === x && b === y && c === z).length >= 2)));

  // --- Key assertion: fresh client B sees exactly what A shows locally -----
  const B = await connectRaw(WORLD_ID, 'Verifier');
  const serverEdits = B.welcome.world.edits.overworld;
  const acceptedCount = coords.filter(([x, y, z]) => serverEdits[`${x},${y},${z}`] === 0).length;
  check('server accepted the complement of the rejected edits',
    acceptedCount === coords.length - rejectCount,
    `accepted=${acceptedCount} rejects=${rejectCount}`);

  let mismatches = 0;
  for (const [x, y, z] of coords) {
    const key = `${x},${y},${z}`;
    const serverView = key in serverEdits ? serverEdits[key] : gen.blockAt(x, y, z);
    if (world.getBlock(x, y, z) !== serverView) mismatches++;
    if ((key in serverEdits) !== (key in localEdits)) mismatches++;
    else if (key in serverEdits && serverEdits[key] !== localEdits[key]) mismatches++;
  }
  check('NO GHOST BLOCKS: fresh client B\'s world state matches A\'s local world '
    + 'for all 35 flooded cells (blocks AND edit records)',
    mismatches === 0, `${mismatches} mismatching cells`);
  await closeRaw(B);

  // --- Phase 2: reject on a cell with a stored edit carries block >= 0 -----
  await sleep(1200); // refill the edit bucket
  A.sendEdit(1, 78, 1, 4); // accepted: server stores 4 at this cell
  await sleep(300);
  // Drain the bucket with fillers, then hit the stored cell again: rejected,
  // and the reject must carry the authoritative stored block (4).
  let fi = 0;
  for (let x = 0; x <= 4 && fi < 30; x++) {
    for (let z = 0; z <= 5 && fi < 30; z++, fi++) A.sendEdit(x, 77, z, 3);
  }
  world.setBlock(1, 78, 1, 7); // optimistic local change that will be rejected
  localEdits['1,78,1'] = 7;
  A.sendEdit(1, 78, 1, 7);

  await settle(() => rejects.length);
  const storedReject = rejects.find((r) => r.x === 1 && r.y === 78 && r.z === 1);
  check('phase2: reject on a stored-edit cell carries the stored block (4)',
    !!storedReject && storedReject.block === 4, JSON.stringify(storedReject));
  check('phase2: rollback restored the stored block locally',
    world.getBlock(1, 78, 1) === 4 && localEdits['1,78,1'] === 4,
    `local=${world.getBlock(1, 78, 1)} record=${localEdits['1,78,1']}`);

  const C = await connectRaw(WORLD_ID, 'Verifier2');
  check('phase2: fresh client agrees the cell holds the stored block',
    C.welcome.world.edits.overworld['1,78,1'] === 4,
    String(C.welcome.world.edits.overworld['1,78,1']));
  await closeRaw(C);

  A.close();
}

async function cleanup() {
  await fs.rm(path.join(ROOT, 'saves', `${WORLD_ID}.json`), { force: true }).catch(() => {});
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
