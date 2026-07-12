// Loomfall game-mode tests (survival-inventory stage).
//
// Spawns the real server (server/index.js) on PORT=3315 and verifies the
// per-world `mode` field: REST create with mode, default creative, invalid
// mode rejection-to-default, welcome payload passthrough, and legacy-save
// normalization (a world file without `mode` reads back as creative).
//
// Plain node script: prints PASS/FAIL per case, exit code 0 only if all pass.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3315;
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const SAVES_DIR = path.join(ROOT, 'saves');

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

function welcomeFor(worldId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error('welcome timeout')), 5000);
    ws.on('open', () => ws.send(JSON.stringify({
      t: 'join', worldId, name: 'ModeTester', dim: 'overworld',
    })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'welcome') {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function createWorld(body) {
  const res = await fetch(`${BASE}/api/worlds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, world: await res.json() };
}

let child = null;
const cleanupIds = [];

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
  check('server boots', await waitForServer());

  // --- create with explicit modes ----------------------------------------
  const survival = await createWorld({ name: 'Mode Survival', mode: 'survival' });
  cleanupIds.push(survival.world.id);
  check('POST mode=survival -> 201 with mode survival',
    survival.status === 201 && survival.world.mode === 'survival',
    JSON.stringify(survival.world.mode));

  const creative = await createWorld({ name: 'Mode Creative', mode: 'creative' });
  cleanupIds.push(creative.world.id);
  check('POST mode=creative -> mode creative', creative.world.mode === 'creative');

  const defaulted = await createWorld({ name: 'Mode Default' });
  cleanupIds.push(defaulted.world.id);
  check('POST without mode -> defaults to creative', defaulted.world.mode === 'creative');

  const junk = await createWorld({ name: 'Mode Junk', mode: 'hardcore<script>' });
  cleanupIds.push(junk.world.id);
  check('POST with unknown mode -> normalized to creative', junk.world.mode === 'creative');

  // --- REST reads carry mode ----------------------------------------------
  const got = await (await fetch(`${BASE}/api/worlds/${survival.world.id}`)).json();
  check('GET /api/worlds/:id carries mode', got.mode === 'survival');
  const list = await (await fetch(`${BASE}/api/worlds`)).json();
  const row = list.find((w) => w.id === survival.world.id);
  check('GET /api/worlds summary carries mode', !!row && row.mode === 'survival');

  // --- welcome payload carries mode ---------------------------------------
  const w1 = await welcomeFor(survival.world.id);
  check('welcome.world.mode === survival for a survival world',
    w1.world && w1.world.mode === 'survival');
  const w2 = await welcomeFor(creative.world.id);
  check('welcome.world.mode === creative for a creative world',
    w2.world && w2.world.mode === 'creative');

  // --- legacy saves (no mode field) normalize to creative ------------------
  const legacyId = `legacy-mode-${Math.random().toString(36).slice(2, 8)}`;
  cleanupIds.push(legacyId);
  await fs.writeFile(path.join(SAVES_DIR, `${legacyId}.json`), JSON.stringify({
    id: legacyId,
    name: 'Legacy Save',
    seed: 12345,
    createdAt: new Date().toISOString(),
    edits: { overworld: {}, nether: {}, end: {} },
  }, null, 2));
  const legacy = await (await fetch(`${BASE}/api/worlds/${legacyId}`)).json();
  check('legacy save without mode reads back as creative', legacy.mode === 'creative');
  const w3 = await welcomeFor(legacyId);
  check('legacy welcome.world.mode === creative', w3.world && w3.world.mode === 'creative');
}

main()
  .catch((err) => {
    failed++;
    console.error('FAIL (unhandled)', err);
  })
  .finally(async () => {
    if (child) child.kill('SIGKILL');
    await sleep(150);
    for (const id of cleanupIds) {
      await fs.unlink(path.join(SAVES_DIR, `${id}.json`)).catch(() => {});
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  });
