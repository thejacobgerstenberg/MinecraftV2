#!/usr/bin/env node
/**
 * persistence-test.mjs — durability / on-disk round-trip suite for the Voxelheim
 * multiplayer backend.
 *
 * WHAT THIS IS
 * An executable durability harness for OUR OWN project. It drives real WS clients
 * (join/edit) and the REST API against a target server, then asserts that block
 * edits survive: (P1) the in-memory apply + REST read-back, (P2) a full server
 * RESTART loaded from disk, (P3) a well-formed save file on disk, (P4) concurrent
 * multi-world saves without cross-contamination, and (P5) a mid-save SIGKILL crash
 * without corrupting the atomic save file.
 *
 * It doubles as a REGRESSION SUITE: pointed at the reference persistent server
 * (scripts/persist-ref-server.mjs, via --spawn) every applicable check must PASS,
 * proving both the suite and the reference are correct. Pointed at the real server
 * (--server-cmd, which the test owns so it can SIGTERM/SIGKILL/restart it) each
 * FAIL is a data-durability finding (S0 by docs/BUG_TAXONOMY.md — "persisted state
 * … corrupted, lost, or duplicated"). Pointed at a foreign --url server the test
 * did not spawn, the restart/SIGKILL checks SKIP gracefully.
 *
 * DEPENDENCY-FREE: Node builtins only (node:net, node:http, node:https, node:fs,
 * node:path, node:os, node:child_process, node:url) plus the harness's own verified
 * sibling modules. No npm deps, no global WebSocket — transport implements RFC6455
 * itself. Target runtime: Node 20 (CI) / Node 22 (local).
 *
 * REUSED VERIFIED MODULES (the ONLY protocol-specific code lives in protocol.mjs):
 *   - scripts/lib/ws-transport.mjs  RFC6455 client (wsConnect)
 *   - scripts/lib/protocol.mjs      real Voxelheim wire adapter (encJoin/encEdit/decode/CAPS)
 *   - scripts/lib/util.mjs          parseArgs / nowMs / writeJsonReport
 *
 * ---------------------------------------------------------------------------
 * THE 5 DURABILITY CHECKS (each → PASS | FAIL | SKIP with detail):
 *   P1 create+edit+GET       ~150 edits/dim across chunks → REST GET matches exactly
 *   P2 save + reload-from-disk  flush, RESTART process (same port+save-dir), rejoin →
 *                            welcome.world.edits + GET still match the full set
 *   P3 save-file schema      read saves/<id>.json → valid JSON + {id,name,seed,
 *                            createdAt,edits:{overworld,nether,end}} with int 0..40
 *                            values and /^-?\d+,-?\d+,-?\d+$/ keys
 *   P4 concurrent saves      two worlds edited+saved at once → no cross-contamination,
 *                            both files valid + complete
 *   P5 mid-save SIGKILL       (spawned only) churn edits, SIGKILL mid-write, RESTART →
 *                            save file is still VALID JSON (atomic tmp+rename), world
 *                            LOADS, no leftover .tmp blocks reload
 *
 * CLI:
 *   --url <ws://host:port/ws>   target an already-running server (no restart/kill)
 *   --spawn                     spawn the reference persistent server (persist-ref-server.mjs)
 *   --server-cmd "<cmd>"        spawn the REAL server via shell (test owns it → can restart/kill)
 *   --server-cwd <dir>          working dir for --server-cmd
 *   --rest <http://host:port>   REST base (default derived from the ws url)
 *   --save-dir <dir>            where the target writes saves (spawn: a temp dir;
 *                               server-cmd: <cwd>/saves; url: required for P3/P4)
 *   --report <file.json>        machine-readable report path
 *
 * EXIT  0 iff every APPLICABLE check PASSes (SKIPs are fine) · 1 on any FAIL ·
 *       2 on a fatal setup error (target unreachable). Always cleans up spawned
 *       servers and temp save dirs.
 * ---------------------------------------------------------------------------
 */

import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { wsConnect } from './lib/ws-transport.mjs';
import { CAPS, defaultUrl, encJoin, encEdit, decode } from './lib/protocol.mjs';
import { parseArgs, nowMs, writeJsonReport } from './lib/util.mjs';

/* =========================================================================
 * Constants.
 * ========================================================================= */

const DIMENSIONS = ['overworld', 'nether', 'end'];
const MAX_BLOCK_ID = 40; // 0..40 valid; edits here use 1..40 (0 == break/air)
const KEY_RE = /^-?\d+,-?\d+,-?\d+$/; // save-file edit key format "x,y,z"

const CLIENT_MAX_PAYLOAD = 16 * 1024 * 1024; // generous inbound cap for the client
const EDITS_PER_DIM_P1 = 150; // ~150 edits/dim (P1/P2) spread across many chunks
const EDITS_PER_DIM_P4 = 50; // fewer per world for the concurrent check (keeps it quick)

// Unique per-run tag so worlds never collide across runs. Matches ^[A-Za-z0-9_-]{1,64}$.
const RUN_TAG = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/* =========================================================================
 * Small utilities.
 * ========================================================================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function siblingPath(name) {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), name);
}

function wid(tag) {
  return `persist-${tag}-${RUN_TAG}`;
}

function isPidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function getFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => {
      try { srv.close(); } catch { /* ignore */ }
      resolve(0);
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => resolve(p || 0));
    });
  });
}

function waitForPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = nowMs() + timeoutMs;
    const attempt = () => {
      const s = net.connect({ host, port });
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try { s.destroy(); } catch { /* ignore */ }
        if (ok) resolve(true);
        else if (nowMs() >= deadline) resolve(false);
        else setTimeout(attempt, 120);
      };
      s.on('connect', () => finish(true));
      s.on('error', () => finish(false));
    };
    attempt();
  });
}

function waitForMessage(conn, predicate, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const onMsg = (data) => {
      if (done) return;
      let dec;
      try { dec = decode(data); } catch { dec = { kind: 'unknown', raw: data }; }
      let hit = false;
      try { hit = !!predicate(dec); } catch { hit = false; }
      if (hit) finish(dec);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    if (timer.unref) timer.unref();
    function finish(val) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { conn.removeListener('message', onMsg); } catch { /* ignore */ }
      resolve(val);
    }
    conn.on('message', onMsg);
  });
}

/* =========================================================================
 * REST helpers (node:http/https). Defensive: a refused/failed request resolves
 * {ok:false,…}, never throws.
 * ========================================================================= */

function httpRequest(method, urlStr, { headers = {}, body = null, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve({ ok: false, error: 'bad url' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const outHeaders = { ...headers };
    if (body != null && outHeaders['Content-Type'] === undefined) outHeaders['Content-Type'] = 'application/json';
    if (body != null && outHeaders['Content-Length'] === undefined) outHeaders['Content-Length'] = Buffer.byteLength(body);
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: outHeaders,
    };
    let req;
    try {
      req = mod.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json;
          try { json = JSON.parse(data); } catch { json = undefined; }
          const status = res.statusCode || 0;
          resolve({ ok: status >= 200 && status < 300, status, body: data, json });
        });
      });
    } catch (e) {
      return resolve({ ok: false, error: (e && e.message) || 'request error' });
    }
    req.on('error', (e) => resolve({ ok: false, error: (e && e.message) || 'request error' }));
    const timer = setTimeout(() => {
      try { req.destroy(); } catch { /* ignore */ }
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    if (timer.unref) timer.unref();
    req.on('close', () => clearTimeout(timer));
    if (body != null) { try { req.write(body); } catch { /* ignore */ } }
    req.end();
  });
}

async function getWorld(restBase, worldId) {
  const res = await httpRequest('GET', `${restBase}/api/worlds/${encodeURIComponent(worldId)}`);
  if (!res.ok || !res.json || typeof res.json !== 'object') return null;
  return res.json.world && typeof res.json.world === 'object' ? res.json.world : res.json;
}

/** Pull the per-dimension edits object out of a world (from GET or welcome.world). */
function editsOf(world, dim) {
  if (!world || typeof world !== 'object') return {};
  const e = world.edits;
  if (!e || typeof e !== 'object') return {};
  const d = e[dim];
  return d && typeof d === 'object' ? d : {};
}

/* =========================================================================
 * Expected-edit generation + comparison.
 * ========================================================================= */

/**
 * Build a deterministic edit set: `perDim` edits in EACH dimension, spread across
 * many chunks (x and z step by 20 between rows — > the 16-block chunk size), with
 * valid y (1..120) and block (1..40). `blockSeed` shifts block ids so two worlds
 * generated with different seeds get distinguishable block values at the same key.
 *
 * @returns {{expected:{overworld:Object,nether:Object,end:Object}, flat:Array}}
 */
function buildWorldEdits(perDim, blockSeed = 0) {
  const expected = { overworld: {}, nether: {}, end: {} };
  const flat = [];
  for (let di = 0; di < DIMENSIONS.length; di++) {
    const dim = DIMENSIONS[di];
    for (let i = 0; i < perDim; i++) {
      const cx = i % 12;
      const cz = Math.floor(i / 12);
      const x = cx * 20 + (i % 5); // > 16 apart between chunk columns
      const z = cz * 20 + (i % 3); // > 16 apart between chunk rows
      const y = 1 + ((i * 7 + di * 3) % 120); // 1..120
      const block = 1 + ((i * 13 + di * 9 + blockSeed) % MAX_BLOCK_ID); // 1..40
      const key = `${x},${y},${z}`;
      expected[dim][key] = block;
      flat.push({ x, y, z, block, dim });
    }
  }
  return { expected, flat };
}

/** Compare one dimension's expected vs actual edits map. */
function diffDim(expected, actual) {
  const missing = [];
  const wrong = [];
  const extra = [];
  for (const [k, b] of Object.entries(expected)) {
    if (!Object.prototype.hasOwnProperty.call(actual, k)) missing.push(k);
    else if (Number(actual[k]) !== b) wrong.push({ key: k, exp: b, got: actual[k] });
  }
  for (const k of Object.keys(actual)) {
    if (!Object.prototype.hasOwnProperty.call(expected, k)) extra.push(k);
  }
  return { missing, wrong, extra };
}

/** Compare a full expected {dim->edits} against a world object across all dims. */
function diffWorld(expected, world) {
  const perDim = {};
  let missing = 0;
  let wrong = 0;
  let extra = 0;
  for (const dim of DIMENSIONS) {
    const d = diffDim(expected[dim] || {}, editsOf(world, dim));
    perDim[dim] = d;
    missing += d.missing.length;
    wrong += d.wrong.length;
    extra += d.extra.length;
  }
  return { perDim, missing, wrong, extra, ok: missing === 0 && wrong === 0 && extra === 0 };
}

function totalExpected(expected) {
  return DIMENSIONS.reduce((n, d) => n + Object.keys(expected[d] || {}).length, 0);
}

/** Send a list of {x,y,z,block,dim} edits over a WS connection, yielding periodically. */
async function sendEdits(conn, edits, { chunk = 40, gapMs = 6 } = {}) {
  let n = 0;
  for (const e of edits) {
    conn.send(encEdit({ pos: { x: e.x, y: e.y, z: e.z }, block: e.block, dim: e.dim }));
    if (++n % chunk === 0) await sleep(gapMs);
  }
}

/* =========================================================================
 * Save-file access + schema validation.
 * ========================================================================= */

function savePath(worldId) {
  return path.join(server.saveDir, `${worldId}.json`);
}

function readSaveFile(worldId) {
  const p = savePath(worldId);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { ok: false, exists: false, path: p, error: (e && e.code) || 'read error' };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, exists: true, path: p, raw, error: `invalid JSON: ${(e && e.message) || e}` };
  }
  return { ok: true, exists: true, path: p, raw, json };
}

/** List any leftover temp files for a world id in the save dir (atomic-write residue). */
function leftoverTmpFiles(worldId) {
  let entries = [];
  try { entries = fs.readdirSync(server.saveDir); } catch { return []; }
  return entries.filter((f) => f.includes('.tmp') && (f.startsWith(worldId) || f.startsWith(`${worldId}.`)));
}

/** Validate a parsed save object against the durable schema. Returns violations[]. */
function validateSchema(worldId, obj) {
  const v = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return ['save is not a JSON object'];
  }
  if (typeof obj.id !== 'string') v.push(`id is not a string (got ${typeof obj.id})`);
  else if (obj.id !== worldId) v.push(`id "${obj.id}" != expected "${worldId}"`);
  if (!('name' in obj)) v.push('missing "name"');
  else if (typeof obj.name !== 'string') v.push(`name is not a string (got ${typeof obj.name})`);
  if (!('seed' in obj)) v.push('missing "seed"');
  if (!('createdAt' in obj)) v.push('missing "createdAt"');

  const e = obj.edits;
  if (!e || typeof e !== 'object' || Array.isArray(e)) {
    v.push('missing/invalid "edits" object');
    return v;
  }
  for (const dim of DIMENSIONS) {
    const bucket = e[dim];
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) {
      v.push(`edits.${dim} missing or not an object`);
      continue;
    }
    for (const [k, val] of Object.entries(bucket)) {
      if (!KEY_RE.test(k)) {
        v.push(`edits.${dim} bad key "${k}"`);
        if (v.length > 40) return v;
      }
      if (!Number.isInteger(val) || val < 0 || val > MAX_BLOCK_ID) {
        v.push(`edits.${dim}["${k}"] = ${JSON.stringify(val)} not an int 0..${MAX_BLOCK_ID}`);
        if (v.length > 40) return v;
      }
    }
  }
  return v;
}

/* =========================================================================
 * WS player.
 * ========================================================================= */

async function connectPlayer(wsUrl, { worldId, name = 'pbot', dim = 'overworld' }) {
  const conn = await wsConnect(wsUrl, { maxPayload: CLIENT_MAX_PAYLOAD, handshakeTimeoutMs: 5000 });
  conn.on('error', () => { /* isolate — never let a socket error throw out */ });
  conn.send(encJoin({ worldId, name, dim }));
  const welcome = await waitForMessage(conn, (d) => d.kind === 'welcome', 6000);
  if (!welcome) {
    try { conn.close(); } catch { /* ignore */ }
    throw new Error(`join to "${worldId}" (dim ${dim}) got no welcome`);
  }
  return {
    conn,
    id: welcome.id,
    welcome,
    world: welcome.world,
    send(str) { return conn.send(str); },
    async close() {
      try { conn.close(); } catch { /* ignore */ }
      await sleep(20);
    },
  };
}

/* =========================================================================
 * Server lifecycle. The suite OWNS the process in --spawn / --server-cmd mode
 * (knows the pid, the port, and the save-dir) so it can SIGTERM/SIGKILL/restart
 * the SAME server (same port + same save-dir) to prove on-disk round-trips.
 * ========================================================================= */

const server = {
  proc: null,
  pid: null,
  spawned: false, // do we own a process we can kill/restart?
  mode: 'url', // 'spawn-ref' | 'server-cmd' | 'url'
  wsUrl: '',
  restBase: '',
  host: '127.0.0.1',
  port: 0,
  saveDir: '',
  ownedTmpDir: null, // a mkdtemp we created and must remove on cleanup
  serverCmd: '',
  serverCwd: '',
  debounceMs: 2000,
  exited: false,
  exitCode: null,
  exitSignal: null,
  stdout: '',
};

function parseHostPort(wsUrl) {
  try {
    const u = new URL(wsUrl);
    server.host = u.hostname || '127.0.0.1';
    server.port = Number(u.port) || (u.protocol === 'wss:' ? 443 : 80);
  } catch {
    server.host = '127.0.0.1';
    server.port = 3000;
  }
}

function deriveRest(wsUrl) {
  try {
    const u = new URL(wsUrl);
    const proto = u.protocol === 'wss:' ? 'https:' : 'http:';
    const port = u.port || (u.protocol === 'wss:' ? '443' : '80');
    return `${proto}//${u.hostname}:${port}`;
  } catch {
    return 'http://127.0.0.1:3000';
  }
}

function wireServerProcess(proc) {
  server.exited = false;
  server.exitCode = null;
  server.exitSignal = null;
  try {
    if (proc.stdout) proc.stdout.on('data', (d) => {
      server.stdout += String(d);
      process.stdout.write(`[srv] ${d}`);
    });
    if (proc.stderr) proc.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));
  } catch { /* ignore */ }
  proc.on('exit', (code, signal) => {
    server.exited = true;
    server.exitCode = code;
    server.exitSignal = signal;
  });
  proc.on('error', (err) => {
    process.stderr.write(`[srv-spawn-error] ${err && err.message}\n`);
    server.exited = true;
  });
}

/** (Re)spawn the owned server process on server.port with server.saveDir. */
function spawnServerProcess() {
  server.stdout = '';
  let proc;
  if (server.mode === 'spawn-ref') {
    proc = spawn(process.execPath, [siblingPath('persist-ref-server.mjs')], {
      detached: true,
      env: {
        ...process.env,
        PORT: String(server.port),
        GAME_PORT: String(server.port),
        SAVE_DIR: server.saveDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    proc = spawn(server.serverCmd, {
      shell: true,
      detached: true,
      cwd: server.serverCwd || undefined,
      env: {
        ...process.env,
        PORT: String(server.port),
        GAME_PORT: String(server.port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  server.proc = proc;
  server.pid = proc.pid;
  wireServerProcess(proc);
}

async function waitForReady(timeoutMs) {
  const portOk = await waitForPort(server.host, server.port, timeoutMs);
  if (!portOk) return false;
  const deadline = nowMs() + Math.min(timeoutMs, 8000);
  while (nowMs() < deadline) {
    const res = await httpRequest('GET', `${server.restBase}/api/health`, { timeoutMs: 1500 });
    if (res.ok || (typeof res.status === 'number' && res.status > 0)) return true;
    await sleep(150);
  }
  return true; // port is open even if /api/health is unknown
}

function parseReadySaveDir(stdout) {
  const m = /PERSIST-REF-SERVER READY[^\n]*\bsaveDir=(\S+)/i.exec(stdout || '');
  return m ? m[1] : null;
}

async function startServer(opts) {
  if (opts.spawn) server.mode = 'spawn-ref';
  else if (opts.serverCmd) server.mode = 'server-cmd';
  else server.mode = 'url';

  // ---- URL mode: own no process --------------------------------------------
  if (server.mode === 'url') {
    if (!opts.url) throw new Error('no target: pass --url, --spawn, or --server-cmd');
    server.spawned = false;
    server.wsUrl = opts.url;
    parseHostPort(server.wsUrl);
    server.restBase = opts.rest || deriveRest(server.wsUrl);
    server.saveDir = opts.saveDir || '';
    const ok = await waitForReady(6000);
    if (!ok) throw new Error(`cannot reach target server at ${server.wsUrl}`);
    return;
  }

  // ---- spawn the reference persistent server -------------------------------
  if (server.mode === 'spawn-ref') {
    let port = await getFreePort();
    if (!port) port = 8130;
    server.spawned = true;
    server.host = '127.0.0.1';
    server.port = port;
    server.wsUrl = `ws://127.0.0.1:${port}${CAPS.wsPath}`;
    server.restBase = opts.rest || `http://127.0.0.1:${port}`;
    server.debounceMs = 1000;
    if (opts.saveDir) {
      server.saveDir = opts.saveDir;
      server.ownedTmpDir = null;
    } else {
      server.saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-ref-'));
      server.ownedTmpDir = server.saveDir;
    }
    spawnServerProcess();
  } else {
    // ---- spawn the REAL server via shell (we own it) -----------------------
    server.spawned = true;
    server.serverCmd = opts.serverCmd;
    server.serverCwd = opts.serverCwd || '';
    server.debounceMs = 2000;
    if (opts.url) {
      server.wsUrl = opts.url;
      parseHostPort(server.wsUrl);
    } else {
      let port = await getFreePort();
      if (!port) port = 3000;
      server.host = '127.0.0.1';
      server.port = port;
      server.wsUrl = `ws://127.0.0.1:${port}${CAPS.wsPath}`;
    }
    server.restBase = opts.rest || deriveRest(server.wsUrl);
    server.saveDir = opts.saveDir || (server.serverCwd ? path.join(server.serverCwd, 'saves') : path.join(process.cwd(), 'saves'));
    server.ownedTmpDir = null;
    spawnServerProcess();
  }

  const ready = await waitForReady(15000);
  if (!ready) {
    if (server.exited) {
      throw new Error(`server exited before ready (code=${server.exitCode}, signal=${server.exitSignal})`);
    }
    throw new Error(`server did not open ${server.host}:${server.port} within 15s`);
  }

  // Reconcile the save dir from the reference server's READY line, if present.
  if (server.mode === 'spawn-ref') {
    const readyDir = parseReadySaveDir(server.stdout);
    if (readyDir && readyDir !== server.saveDir) {
      // The ref used a different dir than we asked for; read from where it wrote.
      if (server.ownedTmpDir === server.saveDir) server.ownedTmpDir = null;
      server.saveDir = readyDir;
    }
  }
}

function killServer(signal) {
  if (!server.spawned || !server.proc) return;
  const pid = server.pid;
  try { if (pid) process.kill(-pid, signal); } catch { /* group gone */ }
  try { server.proc.kill(signal); } catch { /* ignore */ }
}

async function waitExit(timeoutMs) {
  const deadline = nowMs() + timeoutMs;
  while (nowMs() < deadline) {
    if (server.exited || !isPidAlive(server.pid)) return true;
    await sleep(60);
  }
  return server.exited || !isPidAlive(server.pid);
}

/**
 * Kill the owned server with `signal`, wait for it to die, then relaunch it on the
 * SAME port + save-dir and wait until it is ready again. Used by P2 (SIGTERM) and
 * P5 (SIGKILL). Throws if the server does not come back up.
 */
async function restartServer(signal = 'SIGTERM') {
  killServer(signal);
  await waitExit(6000);
  if (isPidAlive(server.pid)) {
    killServer('SIGKILL');
    await waitExit(3000);
  }
  spawnServerProcess();
  const ok = await waitForReady(15000);
  if (!ok) {
    if (server.exited) {
      throw new Error(`server did not restart (code=${server.exitCode}, signal=${server.exitSignal})`);
    }
    throw new Error('server did not become ready after restart');
  }
  await sleep(200);
}

async function cleanupServer() {
  if (server.spawned) {
    killServer('SIGTERM');
    for (let i = 0; i < 20 && isPidAlive(server.pid); i++) await sleep(75);
    if (isPidAlive(server.pid)) killServer('SIGKILL');
  }
  if (server.ownedTmpDir) {
    try { fs.rmSync(server.ownedTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    server.ownedTmpDir = null;
  }
}

/* =========================================================================
 * Record + verdict helpers.
 * ========================================================================= */

function record(id, name, verdict, detail, extra = {}) {
  return { id, name, verdict, detail: String(detail).slice(0, 260), ...extra };
}
const pass = (id, name, detail, extra) => record(id, name, 'PASS', detail, extra);
const fail = (id, name, detail, extra) => record(id, name, 'FAIL', detail, extra);
const skip = (id, name, detail, extra) => record(id, name, 'SKIP', detail, extra);

/** Flush a world to disk: disconnect all its players (last-leave flush) + settle. */
async function flushWorld(players, { waitDebounce = false } = {}) {
  if (waitDebounce) await sleep(server.debounceMs + 400);
  else await sleep(300); // let the last edits apply in-memory
  for (const p of players) { try { await p.close(); } catch { /* ignore */ } }
  await sleep(700); // let the last-leave flush write hit disk
}

/* =========================================================================
 * THE 5 CHECKS. Each owns its own worldId(s) + connections. A thrown error is
 * converted to a FAIL (a durability suite treats "could not verify" as a failure).
 * ========================================================================= */

// -- P1: create + edit + REST GET --------------------------------------------
async function checkP1(ctx) {
  const world = wid('p1');
  const { expected, flat } = buildWorldEdits(EDITS_PER_DIM_P1, 0);
  const player = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'p1writer' });
  try {
    await sendEdits(player.conn, flat);
    await sleep(600); // let every edit apply in-memory before the GET
    const w = await getWorld(ctx.restBase, world);
    if (!w) return fail('P1', 'create+edit+GET', `GET /api/worlds/${world} returned no world`);
    const d = diffWorld(expected, w);
    const detail = `${totalExpected(expected)} edits/3 dims: missing=${d.missing} wrong=${d.wrong} extra=${d.extra}`;
    if (d.ok) return pass('P1', 'create+edit+GET', detail, { worldId: world });
    return fail('P1', 'create+edit+GET', detail, {
      worldId: world,
      sample: sampleDiff(d),
    });
  } finally {
    try { await player.close(); } catch { /* ignore */ }
  }
}

// -- P2: save + reload-from-disk (RESTART) -----------------------------------
async function checkP2(ctx) {
  if (!server.spawned) {
    return skip('P2', 'save+reload-from-disk', 'requires a test-owned server (use --spawn or --server-cmd) to restart');
  }
  const world = wid('p2');
  const { expected, flat } = buildWorldEdits(EDITS_PER_DIM_P1, 3);
  const writer = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'p2writer' });
  await sendEdits(writer.conn, flat);
  // Trigger a save: wait past the debounce, then disconnect to force a last-leave flush.
  await flushWorld([writer], { waitDebounce: true });

  // RESTART the server (same port + save-dir) — proves the on-DISK round-trip.
  await restartServer('SIGTERM');

  // Rejoin and read back from disk via welcome.world.edits AND REST GET.
  const reader = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'p2reader' });
  try {
    const dWelcome = diffWorld(expected, reader.world);
    const gw = await getWorld(ctx.restBase, world);
    const dGet = gw ? diffWorld(expected, gw) : null;
    const total = totalExpected(expected);
    const welcomeMsg = `welcome: missing=${dWelcome.missing} wrong=${dWelcome.wrong} extra=${dWelcome.extra}`;
    const getMsg = dGet ? `GET: missing=${dGet.missing} wrong=${dGet.wrong} extra=${dGet.extra}` : 'GET: no world';
    const detail = `after restart, ${total} edits — ${welcomeMsg}; ${getMsg}`;
    const welcomeOk = dWelcome.ok;
    const getOk = dGet ? dGet.ok : false;
    if (welcomeOk && getOk) return pass('P2', 'save+reload-from-disk', detail, { worldId: world });
    return fail('P2', 'save+reload-from-disk', detail, {
      worldId: world,
      sample: sampleDiff(welcomeOk ? dGet : dWelcome),
    });
  } finally {
    try { await reader.close(); } catch { /* ignore */ }
  }
}

// -- P3: save-file schema -----------------------------------------------------
async function checkP3(ctx) {
  if (!server.saveDir) {
    return skip('P3', 'save-file schema', 'no --save-dir known (pass --save-dir for a --url target)');
  }
  const world = wid('p3');
  const { flat } = buildWorldEdits(40, 7);
  const writer = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'p3writer' });
  await sendEdits(writer.conn, flat);
  await flushWorld([writer], { waitDebounce: true });

  const sf = readSaveFile(world);
  if (!sf.exists) return fail('P3', 'save-file schema', `save file not written: ${sf.path} (${sf.error})`, { worldId: world });
  if (!sf.ok) return fail('P3', 'save-file schema', `${sf.error}`, { worldId: world, path: sf.path });
  const violations = validateSchema(world, sf.json);
  if (violations.length === 0) {
    return pass('P3', 'save-file schema', `valid JSON + schema OK (${sf.path})`, { worldId: world });
  }
  return fail('P3', 'save-file schema', `${violations.length} schema violation(s): ${violations.slice(0, 4).join(' | ')}`, {
    worldId: world,
    violations: violations.slice(0, 20),
  });
}

// -- P4: concurrent saves — no cross-contamination ---------------------------
async function checkP4(ctx) {
  if (!server.saveDir) {
    return skip('P4', 'concurrent saves', 'no --save-dir known (pass --save-dir for a --url target)');
  }
  const worldA = wid('p4a');
  const worldB = wid('p4b');
  // Same key layout, DIFFERENT block seeds — so any cross-world leak shows up as a
  // wrong block value, and completeness is exact-match.
  const A = buildWorldEdits(EDITS_PER_DIM_P4, 0);
  const B = buildWorldEdits(EDITS_PER_DIM_P4, 17);
  const pa = await connectPlayer(ctx.wsUrl, { worldId: worldA, name: 'p4a' });
  const pb = await connectPlayer(ctx.wsUrl, { worldId: worldB, name: 'p4b' });

  // Drive both worlds simultaneously (interleaved sends).
  const n = Math.max(A.flat.length, B.flat.length);
  for (let i = 0; i < n; i++) {
    if (i < A.flat.length) { const e = A.flat[i]; pa.conn.send(encEdit({ pos: { x: e.x, y: e.y, z: e.z }, block: e.block, dim: e.dim })); }
    if (i < B.flat.length) { const e = B.flat[i]; pb.conn.send(encEdit({ pos: { x: e.x, y: e.y, z: e.z }, block: e.block, dim: e.dim })); }
    if (i % 40 === 0) await sleep(6);
  }
  await flushWorld([pa, pb], { waitDebounce: true });

  const sfA = readSaveFile(worldA);
  const sfB = readSaveFile(worldB);
  if (!sfA.ok || !sfB.ok) {
    return fail('P4', 'concurrent saves', `save unreadable A=${sfA.ok ? 'ok' : sfA.error} B=${sfB.ok ? 'ok' : sfB.error}`, {
      worldA, worldB,
    });
  }
  const dA = diffWorld(A.expected, sfA.json);
  const dB = diffWorld(B.expected, sfB.json);
  // Explicit cross-contamination: A's file carrying B's block value (or vice versa).
  const contamAB = crossContamination(A.expected, B.expected, sfA.json);
  const contamBA = crossContamination(B.expected, A.expected, sfB.json);
  const completeOk = dA.ok && dB.ok;
  const contamCount = contamAB.length + contamBA.length;
  const detail =
    `A: miss=${dA.missing} wrong=${dA.wrong} extra=${dA.extra}; ` +
    `B: miss=${dB.missing} wrong=${dB.wrong} extra=${dB.extra}; contamination=${contamCount}`;
  if (completeOk && contamCount === 0) {
    return pass('P4', 'concurrent saves', detail, { worldA, worldB });
  }
  return fail('P4', 'concurrent saves', detail, {
    worldA, worldB,
    contamination: [...contamAB, ...contamBA].slice(0, 10),
    sampleA: sampleDiff(dA),
    sampleB: sampleDiff(dB),
  });
}

/** Keys in `own` world's file whose value matches the OTHER world's expected block. */
function crossContamination(ownExpected, otherExpected, world) {
  const hits = [];
  for (const dim of DIMENSIONS) {
    const actual = editsOf(world, dim);
    const other = otherExpected[dim] || {};
    const mine = ownExpected[dim] || {};
    for (const [k, val] of Object.entries(actual)) {
      if (Object.prototype.hasOwnProperty.call(other, k) &&
          Number(val) === other[k] &&
          (!Object.prototype.hasOwnProperty.call(mine, k) || mine[k] !== other[k])) {
        hits.push(`${dim}:${k}=${val}(other)`);
        if (hits.length > 20) return hits;
      }
    }
  }
  return hits;
}

// -- P5: mid-save crash recovery (SIGKILL) -----------------------------------
async function checkP5(ctx) {
  if (!server.spawned) {
    return skip('P5', 'mid-save SIGKILL recovery', 'requires a test-owned server (use --spawn or --server-cmd) to SIGKILL');
  }
  const world = wid('p5');
  const writer = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'p5writer' });

  // 1) Write an initial batch and let the FIRST debounced flush complete so a valid
  //    file is guaranteed on disk before we crash mid-write.
  const batch1 = [];
  for (let i = 0; i < 60; i++) {
    batch1.push({ x: (i % 8) * 20, y: 1 + (i % 120), z: Math.floor(i / 8) * 20, block: 1 + (i % 40), dim: DIMENSIONS[i % 3] });
  }
  await sendEdits(writer.conn, batch1, { chunk: 20, gapMs: 5 });
  await sleep(server.debounceMs + 800); // first atomic write lands

  // 2) Churn: keep the debounced writer busy so a write is likely in-flight at kill.
  let churning = true;
  const churn = (async () => {
    let s = 0;
    while (churning) {
      const x = (s % 8) * 20;
      const z = (Math.floor(s / 8) % 8) * 20;
      writer.conn.send(encEdit({
        pos: { x, y: 1 + (s % 120), z },
        block: 1 + (s % 40),
        dim: DIMENSIONS[s % 3],
      }));
      s++;
      if (s % 25 === 0) await sleep(4);
    }
    return s;
  })();

  // 3) SIGKILL mid-churn (no SIGTERM flush — tests atomic tmp+rename durability).
  await sleep(450);
  churning = false;
  killServer('SIGKILL');
  await churn.catch(() => {});
  try { await writer.close(); } catch { /* ignore */ }
  await waitExit(4000);

  // 4) Restart with the SAME save-dir and verify.
  spawnServerProcess();
  const ready = await waitForReady(15000);
  if (!ready) return fail('P5', 'mid-save SIGKILL recovery', 'server did not restart after SIGKILL');

  // 4a) The save file must be present and VALID JSON (never a truncated partial).
  const sf = readSaveFile(world);
  if (!sf.exists) {
    return fail('P5', 'mid-save SIGKILL recovery', `save file lost after crash: ${sf.path}`, { worldId: world });
  }
  if (!sf.ok) {
    return fail('P5', 'mid-save SIGKILL recovery', `CORRUPT save file after crash (data loss S0): ${sf.error}`, {
      worldId: world, path: sf.path,
    });
  }
  const violations = validateSchema(world, sf.json);
  const persisted = DIMENSIONS.reduce((n, d) => n + Object.keys(editsOf(sf.json, d)).length, 0);

  // 4b) No leftover .tmp file should be present that blocks reload.
  const tmps = leftoverTmpFiles(world);

  // 4c) The world must LOAD without crashing the server (rejoin → welcome).
  let loaded = false;
  let loadErr = '';
  try {
    const reader = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'p5reader' });
    loaded = !!reader.welcome;
    try { await reader.close(); } catch { /* ignore */ }
  } catch (e) {
    loadErr = (e && e.message) || String(e);
  }
  const alive = isPidAlive(server.pid) && !server.exited;

  if (violations.length > 0) {
    return fail('P5', 'mid-save SIGKILL recovery', `save parsed but schema-invalid after crash: ${violations.slice(0, 3).join(' | ')}`, {
      worldId: world, violations: violations.slice(0, 10),
    });
  }
  if (!loaded || !alive) {
    return fail('P5', 'mid-save SIGKILL recovery', `world did not load after crash (loaded=${loaded} alive=${alive}) ${loadErr}`, {
      worldId: world,
    });
  }
  // .tmp residue is harmless (atomic rename) as long as reload succeeded; note it.
  const detail = `valid JSON after SIGKILL (${persisted} edits persisted, possibly stale=OK); loaded=ok; leftover .tmp=${tmps.length}`;
  return pass('P5', 'mid-save SIGKILL recovery', detail, { worldId: world, leftoverTmp: tmps });
}

/** Compact a diffWorld result into a small human sample for the report. */
function sampleDiff(d) {
  if (!d || !d.perDim) return {};
  const out = {};
  for (const dim of DIMENSIONS) {
    const p = d.perDim[dim];
    if (!p) continue;
    const bits = {};
    if (p.missing.length) bits.missing = p.missing.slice(0, 3);
    if (p.wrong.length) bits.wrong = p.wrong.slice(0, 3);
    if (p.extra.length) bits.extra = p.extra.slice(0, 3);
    if (Object.keys(bits).length) out[dim] = bits;
  }
  return out;
}

/* =========================================================================
 * Runner.
 * ========================================================================= */

const CHECKS = [checkP1, checkP2, checkP3, checkP4, checkP5];

async function runCheck(fn, ctx) {
  try {
    return await fn(ctx);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    const n = (/checkP(\d)/.exec(fn.name) || [])[1] || '?';
    return fail(`P${n}`, `check P${n}`, `error: ${msg}`);
  }
}

/* =========================================================================
 * Reporting.
 * ========================================================================= */

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function printTable(records) {
  const cols = { id: 4, name: 26, verdict: 7, detail: 78 };
  const bar = '-'.repeat(cols.id + cols.name + cols.verdict + cols.detail + 4);
  console.log('');
  console.log('PERSISTENCE / DURABILITY — PASS/FAIL TABLE');
  console.log(bar);
  console.log(`${pad('#', cols.id)} ${pad('check', cols.name)} ${pad('verdict', cols.verdict)} detail`);
  console.log(bar);
  for (const r of records) {
    console.log(`${pad(r.id, cols.id)} ${pad(r.name, cols.name)} ${pad(r.verdict, cols.verdict)} ${String(r.detail).slice(0, cols.detail)}`);
  }
  console.log(bar);
}

/* =========================================================================
 * CLI.
 * ========================================================================= */

function parseConfig(argv) {
  const { opts } = parseArgs(argv, {
    url: { default: '', env: 'GAME_URL', type: 'string' },
    spawn: { default: false, type: 'boolean' },
    'server-cmd': { default: '', env: 'SERVER_CMD', type: 'string' },
    'server-cwd': { default: '', env: 'SERVER_CWD', type: 'string' },
    rest: { default: '', env: 'REST_URL', type: 'string' },
    'save-dir': { default: '', env: 'SAVE_DIR', type: 'string' },
    report: { default: '', env: 'PERSIST_REPORT', type: 'string' },
    help: { default: false, type: 'boolean' },
  });
  return opts;
}

function printHelp() {
  console.log(`persistence-test.mjs — 5-check durability / on-disk round-trip suite

USAGE
  node scripts/persistence-test.mjs [--spawn | --url <ws://…/ws> | --server-cmd "<cmd>"]

TARGET (precedence: --spawn > --server-cmd > --url)
  --spawn                 Spawn the reference persistent server (scripts/persist-ref-server.mjs)
                          into a temp save dir; every applicable check MUST PASS (self-test).
  --server-cmd "<cmd>"    Spawn the REAL server via shell so the suite OWNS it (can
                          SIGTERM/SIGKILL/restart). save-dir defaults to <server-cwd>/saves.
  --server-cwd <dir>      Working directory for --server-cmd (env SERVER_CWD).
  --url <ws://host:port/ws>   Target an already-running server (env GAME_URL). The
                          restart/SIGKILL checks (P2, P5) SKIP; pass --save-dir for P3/P4.
  --rest <http://host:port>   REST base (default derived from the ws url). Env REST_URL.
  --save-dir <dir>        Directory the target writes saves to (env SAVE_DIR).
  --report <file.json>    Write the machine-readable report (env PERSIST_REPORT).

EXIT  0 iff every applicable check PASSes (SKIPs OK) · 1 on any FAIL · 2 on fatal setup error.`);
}

/* =========================================================================
 * Main.
 * ========================================================================= */

async function main() {
  const opts = parseConfig(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const onSignal = () => { cleanupServer().finally(() => process.exit(130)); };

  try {
    await startServer(opts);
  } catch (err) {
    console.error(`\nFATAL: ${(err && err.message) || err}`);
    await cleanupServer();
    process.exit(2);
  }

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  console.log(`[persistence] target ws=${server.wsUrl}  rest=${server.restBase}  mode=${server.mode}`);
  console.log(`[persistence] saveDir=${server.saveDir || '(unknown)'}  spawned=${server.spawned}`);

  // Preflight: one client must connect + join, else the whole suite is fatal.
  try {
    const probe = await connectPlayer(server.wsUrl, { worldId: `preflight-${RUN_TAG}`, name: 'preflight' });
    await probe.close();
  } catch (err) {
    console.error(`\nFATAL: preflight join failed: ${(err && err.message) || err}`);
    await cleanupServer();
    process.exit(2);
  }

  const ctx = { wsUrl: server.wsUrl, restBase: server.restBase };

  const records = [];
  for (const fn of CHECKS) {
    const rec = await runCheck(fn, ctx);
    records.push(rec);
    console.log(`  [${rec.verdict}] ${rec.id} ${rec.name} — ${rec.detail}`);
  }

  const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const r of records) counts[r.verdict] = (counts[r.verdict] || 0) + 1;

  printTable(records);
  console.log(`SUMMARY  PASS=${counts.PASS}  FAIL=${counts.FAIL}  SKIP=${counts.SKIP}  (of ${records.length})`);
  const fails = records.filter((r) => r.verdict === 'FAIL');
  if (fails.length) {
    console.log('\nFAILURES (durability / data-loss — S0):');
    for (const r of fails) console.log(`  ${r.id} ${r.name}: ${r.detail}`);
  }

  const report = {
    tool: 'persistence-test',
    generatedAt: new Date().toISOString(),
    target: { wsUrl: server.wsUrl, restBase: server.restBase, mode: server.mode, saveDir: server.saveDir, spawned: server.spawned },
    summary: { ...counts, total: records.length, failed: counts.FAIL > 0 },
    checks: records,
  };
  if (opts.report) {
    const ok = writeJsonReport(opts.report, report);
    console.log(`\n[persistence] report ${ok ? 'written to' : 'FAILED to write'} ${opts.report}`);
  }

  await cleanupServer();
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);

  process.exit(counts.FAIL > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`\nFATAL (uncaught): ${(err && err.stack) || err}`);
  await cleanupServer();
  process.exit(2);
});
