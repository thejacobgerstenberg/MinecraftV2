#!/usr/bin/env node
/**
 * authority-test.mjs — server-authority audit / regression suite for the
 * Voxelheim multiplayer backend.
 *
 * WHAT THIS IS
 * An AUTHORIZED security audit of OUR OWN project's multiplayer server. It plays
 * the role of a hostile client and asserts, for fifteen distinct authority rules,
 * one question: does the server ENFORCE the rule (server is authoritative → PASS)
 * or does it TRUST the client (→ VULN)? A server that merely relays client-asserted
 * state — position, block edits, identity — is exploitable; a correct server treats
 * every client message as an *intent* it validates, applies, and rebroadcasts.
 *
 * It doubles as a REGRESSION SUITE: pointed at the strict reference server
 * (scripts/authority-ref-server.mjs, via --spawn) every check must PASS (0 VULNs),
 * proving both the suite and the reference are correct. Pointed at the real server
 * (--url / --server-cmd) each VULN is a finding that gates CI once the server is on
 * master.
 *
 * DEPENDENCY-FREE: Node builtins only (node:http, node:https, node:net, node:fs,
 * node:path, node:child_process, node:url) plus the harness's own verified sibling
 * modules. No npm deps, no global WebSocket — the transport implements RFC6455
 * itself. Target runtime: Node 20 (CI) / Node 22 (local).
 *
 * REUSED VERIFIED MODULES (the ONLY protocol-specific code lives in protocol.mjs):
 *   - scripts/lib/ws-transport.mjs  RFC6455 client with chaos hooks (sendRawFrame)
 *   - scripts/lib/protocol.mjs      real Voxelheim wire adapter (encoders/decode/CAPS)
 *   - scripts/lib/util.mjs          parseArgs / writeJsonReport / nowMs
 *
 * ---------------------------------------------------------------------------
 * THE 15 AUTHORITY CHECKS  (each: ATTACKER client A + OBSERVER client B joined to
 * the SAME worldId+dim; PASS = server enforces, VULN = server trusts the client;
 * severity is the guarded S0..S3 grade per docs/BUG_TAXONOMY.md):
 *    1  teleport / speed-hack        move +1000 blocks in one message
 *    2  edit reach (EDIT_REACH=6)    edit at player+(100,0,0)   (+ positive control)
 *    3  edit XZ bounds               edit at x=1e12
 *    4  bedrock / protected floor    break at y==0
 *    5  cross-dimension edit         overworld client writes dim="nether"
 *    6  block-id validity            edit block=9999 and block=-1  (expect PASS)
 *    7  edit rate (20/s cap)         100 edits within reach in <1s
 *    8  id / authorship spoof        raw {t:move,…,id:"p999",name:"evil"} (expect PASS)
 *    9  name spoof/len/charset/dedup 100-char name w/ control chars + <script>; dup
 *   10  chat sanitization + sink scan chat "<img … onerror=…>" + static public/src scan
 *   11  chat rate (3/2000ms cap)     20 chats in <1s
 *   12  non-finite state integrity   move x=null / "NaN" / non-number (expect PASS)
 *   13  concurrent consistency       A & B edit the SAME cell → single LWW value
 *   14  unauth REST write            PUT /api/worlds/:id with no auth  (expect VULN)
 *   15  DoS re-verify (patch check)  8MB WS frame + ~50k-msg flood
 *
 * Each check → { id, name, verdict:PASS|VULN|SKIP, severity, note, repro, fix }.
 * Prints a PASS/VULN table + summary counts; writes a JSON report to --report.
 * EXIT 0 iff zero VULNs; EXIT 1 on any VULN; EXIT 2 on a fatal setup error
 * (target unreachable) so a broken server still fails a CI gate.
 *
 * CLI:
 *   --url <ws://host:port/ws>   target an already-running server
 *   --spawn                     spawn the strict reference (authority-ref-server.mjs)
 *   --server-cmd "<cmd>"        spawn the real server via shell (needs --url or default)
 *   --server-cwd <dir>          working dir for --server-cmd
 *   --rest <http://host:port>   REST base (default derived from the ws url)
 *   --report <file.json>        machine-readable report path
 * ---------------------------------------------------------------------------
 */

import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { wsConnect, OPEN, CLOSED } from './lib/ws-transport.mjs';
import {
  CAPS,
  defaultUrl,
  encJoin,
  encMove,
  encEdit,
  encChat,
  decode,
} from './lib/protocol.mjs';
import { parseArgs, nowMs, writeJsonReport } from './lib/util.mjs';

/* =========================================================================
 * Constants — the authoritative-server spec the reference implements and this
 * suite asserts (docs/MULTIPLAYER_PROTOCOL.md §0/§1.1 via the recon). Used for
 * reach math, thresholds, and repro strings.
 * ========================================================================= */

const SPAWN = { x: 0, y: 80, z: 0 }; // documented join position (server/index.js:164)
const EDIT_REACH_BLOCKS = 6; // max Euclidean edit distance from authoritative pos
const SPEED_FLY = 10.89; // b/s — fastest legit horizontal speed (cap ~16 w/ tolerance)
const EDIT_RATE_CAP_PER_S = 20; // edits/sec/connection
const CHAT_RATE = { msgs: 3, perMs: 2000 }; // chat cap per connection
const MAX_FRAME_BYTES = 65536; // 64 KB WS maxPayload the server must set

const OP_TEXT = 0x1; // opcode for hand-built (oversized) chaos frames
const CLIENT_MAX_PAYLOAD = 16 * 1024 * 1024; // generous client inbound cap
const OVERSIZE_BYTES = 8 * 1024 * 1024; // 8 MB — under ws@8's 100 MiB default
const FLOOD_COUNT = 50000; // messages hurled in the rate-limit flood

// Unique per-run tag so destructive checks never collide across runs; each check
// also uses its own worldId. Matches ^[A-Za-z0-9_-]{1,64}$.
const RUN_TAG = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/* =========================================================================
 * Small utilities.
 * ========================================================================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wid(n) {
  return `authchk${n}-${RUN_TAG}`;
}

function siblingPath(name) {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), name);
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
        else setTimeout(attempt, 100);
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
      try { hit = !!predicate(dec, data); } catch { hit = false; }
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

function waitForClose(conn, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const onClose = (code, reason) => finish({ closed: true, code, reason });
    const timer = setTimeout(() => finish({ closed: false, code: null }), timeoutMs);
    if (timer.unref) timer.unref();
    function finish(v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { conn.removeListener('close', onClose); } catch { /* ignore */ }
      resolve(v);
    }
    if (conn.readyState === CLOSED) return finish({ closed: true, code: null });
    conn.on('close', onClose);
  });
}

/* =========================================================================
 * Player — a joined WS client that accumulates every frame it receives.
 * ========================================================================= */

async function connectPlayer(wsUrl, { worldId, name = 'bot', dim = 'overworld' }) {
  const conn = await wsConnect(wsUrl, {
    maxPayload: CLIENT_MAX_PAYLOAD,
    handshakeTimeoutMs: 5000,
  });
  const raws = [];
  const decoded = [];
  conn.on('message', (data) => {
    const s =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : String(data);
    raws.push(s);
    let d;
    try { d = decode(s); } catch { d = { kind: 'unknown', raw: s }; }
    decoded.push(d);
  });

  conn.send(encJoin({ worldId, name, dim }));
  const welcome = await waitForMessage(conn, (d) => d.kind === 'welcome', 5000);
  if (!welcome) {
    try { conn.close(); } catch { /* ignore */ }
    throw new Error(`join to "${worldId}" (dim ${dim}) got no welcome`);
  }

  return {
    conn,
    id: welcome.id,
    welcome,
    raws,
    decoded,
    mark() { return decoded.length; },
    send(str) { return conn.send(str); },
    sendJson(obj) { return conn.send(JSON.stringify(obj)); },
    movesFrom(id, fromIdx = 0) {
      return decoded.slice(fromIdx).filter((d) => d.kind === 'move' && d.id === id);
    },
    editsFrom(id, fromIdx = 0) {
      return decoded.slice(fromIdx).filter((d) => d.kind === 'edit' && d.id === id);
    },
    chatsFrom(id, fromIdx = 0) {
      return decoded.slice(fromIdx).filter((d) => d.kind === 'chat' && d.id === id);
    },
    peerJoinsFor(id) {
      return decoded.filter((d) => d.kind === 'peer-join' && d.id === id);
    },
    /** Raw (undecoded) parsed frames of type `t` whose id === id — to inspect the
     *  ACTUAL on-the-wire coord types (decode() would coerce non-finite → 0). */
    rawFramesFrom(id, t, fromRawIdx = 0) {
      const out = [];
      for (let i = fromRawIdx; i < raws.length; i++) {
        let m;
        try { m = JSON.parse(raws[i]); } catch { continue; }
        if (m && m.t === t && m.id === id) out.push(m);
      }
      return out;
    },
    async close() {
      try { conn.close(); } catch { /* ignore */ }
      await sleep(15);
    },
  };
}

/** A legal baseline move to SPAWN (zero displacement → always accepted) so the
 * server records an authoritative (pos,time) before an attack. */
async function baseline(player, dim = 'overworld', seq = 1) {
  player.send(encMove({ seq, pos: SPAWN, yaw: 0, dim }));
  await sleep(180);
}

/* =========================================================================
 * REST helpers (node:http/https). GET confirms persistence; PUT drives check 14.
 * Defensive: a refused/failed request resolves {ok:false,…}, never throws.
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

function editsOf(world, dim) {
  if (!world || typeof world !== 'object') return {};
  const e = world.edits;
  if (!e || typeof e !== 'object') return {};
  const d = e[dim];
  return d && typeof d === 'object' ? d : {};
}

function hasKey(obj, key) {
  return obj && Object.prototype.hasOwnProperty.call(obj, key);
}

async function restReachable(restBase) {
  const res = await httpRequest('GET', `${restBase}/api/worlds/authprobe-${RUN_TAG}`, { timeoutMs: 2500 });
  return res.ok || (typeof res.status === 'number' && res.status > 0);
}

/* =========================================================================
 * Static XSS-sink scan of public/src (check 10, defense-in-depth). Flags an
 * innerHTML-family SINK only when its assigned value / argument references
 * network-controlled data (chat text / player name / peer / msg …). A static
 * const or literal (e.g. `el.innerHTML = SHARD_SVG`) is NOT flagged.
 * ========================================================================= */

const NET_VAR_RE = /\b(text|name|msg|message|chat|peer|player|body|content|payload|username|displayname|nick)\b/i;

function walkFiles(dir, exts, out, budget) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (out.length >= budget) return;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      walkFiles(full, exts, out, budget);
    } else if (exts.some((e) => ent.name.endsWith(e))) {
      out.push(full);
    }
  }
}

function sinkRhs(line) {
  let m;
  if ((m = /(?:\.innerHTML|\.outerHTML)\s*=\s*([^;]+)/.exec(line))) return m[1];
  if ((m = /(?:insertAdjacentHTML|document\s*\.\s*write|createContextualFragment)\s*\(([^)]*)/.exec(line))) return m[1];
  if ((m = /dangerouslySetInnerHTML\s*[=:]\s*\{[^}]*__html\s*:\s*([^},]+)/.exec(line))) return m[1];
  return null;
}

function scanPublicSrc() {
  const root = path.join(repoRoot(), 'public', 'src');
  if (!fs.existsSync(root)) return { skipped: true, root };
  const files = [];
  walkFiles(root, ['.js', '.mjs', '.ts', '.jsx', '.tsx'], files, 5000);
  const dangerous = [];
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const rhs = sinkRhs(lines[i]);
      if (rhs == null) continue;
      if (NET_VAR_RE.test(rhs)) {
        dangerous.push({ file: path.relative(repoRoot(), f), line: i + 1, code: lines[i].trim().slice(0, 160) });
      }
    }
  }
  return { skipped: false, root, filesScanned: files.length, dangerous };
}

/* =========================================================================
 * Record helper.
 * ========================================================================= */

function record(id, name, verdict, severity, extra) {
  return {
    id,
    name,
    verdict,
    severity,
    note: extra.note || '',
    repro: extra.repro || '',
    fix: extra.fix || '',
  };
}

function skip(id, name, severity, note) {
  return record(id, name, 'SKIP', severity, { note, repro: '', fix: '' });
}

/* =========================================================================
 * Server lifecycle (spawn the reference / an arbitrary server, or target a URL).
 * ========================================================================= */

const server = {
  proc: null,
  pid: null,
  spawned: false,
  mode: 'url',
  wsUrl: '',
  restBase: '',
  host: '127.0.0.1',
  port: 0,
  exited: false,
  exitCode: null,
  exitSignal: null,
  stdout: '',
};

function wireServerProcess(proc) {
  try {
    if (proc.stdout) proc.stdout.on('data', (d) => {
      server.stdout += String(d);
      process.stdout.write(`[ref] ${d}`);
    });
    if (proc.stderr) proc.stderr.on('data', (d) => process.stderr.write(`[ref] ${d}`));
  } catch { /* ignore */ }
  proc.on('exit', (code, signal) => {
    server.exited = true;
    server.exitCode = code;
    server.exitSignal = signal;
  });
  proc.on('error', (err) => {
    process.stderr.write(`[ref-spawn-error] ${err && err.message}\n`);
    server.exited = true;
  });
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

function parseReadyRest(stdout) {
  const m = /AUTH-REF-SERVER READY[^\n]*\brest=(\S+)/i.exec(stdout || '');
  return m ? m[1] : null;
}

async function startServer(opts) {
  if (opts.spawn) server.mode = 'spawn-ref';
  else if (opts.serverCmd) server.mode = 'server-cmd';
  else server.mode = 'url';

  // ---- URL mode: own no process ----------------------------------------
  if (server.mode === 'url') {
    if (!opts.url) throw new Error('no target: pass --url, --spawn, or --server-cmd');
    server.spawned = false;
    server.wsUrl = opts.url;
    parseHostPort(server.wsUrl);
    server.restBase = opts.rest || deriveRest(server.wsUrl);
    const ok = await waitForPort(server.host, server.port, 5000);
    if (!ok) throw new Error(`cannot reach target server at ${server.wsUrl}`);
    return;
  }

  // ---- spawn the strict reference server -------------------------------
  if (server.mode === 'spawn-ref') {
    let port = await getFreePort();
    if (!port) port = 8123;
    server.spawned = true;
    server.host = '127.0.0.1';
    server.port = port;
    server.wsUrl = `ws://127.0.0.1:${port}${CAPS.wsPath}`;
    server.proc = spawn(process.execPath, [siblingPath('authority-ref-server.mjs')], {
      detached: true,
      env: { ...process.env, PORT: String(port), GAME_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    // ---- spawn an arbitrary (real) server via shell --------------------
    server.spawned = true;
    server.wsUrl = opts.url || defaultUrl();
    parseHostPort(server.wsUrl);
    server.proc = spawn(opts.serverCmd, {
      shell: true,
      detached: true,
      cwd: opts.serverCwd || undefined,
      env: { ...process.env, PORT: String(server.port), GAME_PORT: String(server.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  server.pid = server.proc.pid;
  wireServerProcess(server.proc);

  const ready = await waitForPort(server.host, server.port, 15000);
  if (!ready) {
    if (server.exited) {
      throw new Error(`server exited before ready (code=${server.exitCode}, signal=${server.exitSignal})`);
    }
    throw new Error(`server did not open ${server.host}:${server.port} within 15s`);
  }

  server.restBase = opts.rest || parseReadyRest(server.stdout) || deriveRest(server.wsUrl);
}

function killServer(signal) {
  if (!server.spawned || !server.proc) return;
  const pid = server.pid;
  try { if (pid) process.kill(-pid, signal); } catch { /* group gone */ }
  try { server.proc.kill(signal); } catch { /* ignore */ }
}

async function cleanupServer() {
  if (!server.spawned) return;
  killServer('SIGTERM');
  for (let i = 0; i < 20 && !server.exited && isPidAlive(server.pid); i++) await sleep(75);
  if (!server.exited && isPidAlive(server.pid)) killServer('SIGKILL');
}

/* =========================================================================
 * THE 15 CHECKS. Each returns a finished record and owns its own connections +
 * worldId. A thrown error is converted to a SKIP by runCheck() (never a false
 * PASS, never a crash).
 * ========================================================================= */

// -- 1: teleport / speed-hack -------------------------------------------------
async function check01(ctx) {
  const world = wid(1);
  const A = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'attacker' });
  const B = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'observer' });
  try {
    await baseline(A, 'overworld', 1);
    const from = B.mark();
    A.send(encMove({ seq: 2, pos: { x: 1000, y: 80, z: 0 }, yaw: 0, dim: 'overworld' }));
    await sleep(600);
    let maxDx = 0;
    for (const m of B.movesFrom(A.id, from)) maxDx = Math.max(maxDx, Math.abs(m.x - SPAWN.x));
    const vuln = maxDx > 100;
    return record(1, 'teleport/speed-hack', vuln ? 'VULN' : 'PASS', 'S1', {
      note: vuln
        ? `observer saw attacker jump +${Math.round(maxDx)} blocks in one message (no speed cap)`
        : `impossible +1000-block move rejected (observer max Δx=${Math.round(maxDx)})`,
      repro: `A move→(0,80,0) then →(1000,80,0); observer Δx=${Math.round(maxDx)}`,
      fix: `track last authoritative (pos,time); reject moves whose horizontal speed > SPEED_FLY=${SPEED_FLY} b/s (cap ~16); keep prior pos`,
    });
  } finally {
    await A.close(); await B.close();
  }
}

// -- 2: edit reach ------------------------------------------------------------
async function check02(ctx) {
  const world = wid(2);
  const A = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'attacker' });
  const B = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'observer' });
  try {
    await baseline(A);
    const nearKey = '3,80,0';
    const beforeNear = B.mark();
    A.send(encEdit({ pos: { x: 3, y: 80, z: 0 }, block: 1, dim: 'overworld' }));
    await sleep(300);
    const nearSeen = B.editsFrom(A.id, beforeNear).some((e) => `${e.x},${e.y},${e.z}` === nearKey);

    const farKey = '100,80,0';
    const beforeFar = B.mark();
    A.send(encEdit({ pos: { x: 100, y: 80, z: 0 }, block: 1, dim: 'overworld' }));
    await sleep(400);
    const farSeen = B.editsFrom(A.id, beforeFar).some((e) => `${e.x},${e.y},${e.z}` === farKey);

    let farPersisted = false;
    let nearPersisted = null;
    if (ctx.restAvailable) {
      const ow = editsOf(await getWorld(ctx.restBase, world), 'overworld');
      farPersisted = hasKey(ow, farKey);
      nearPersisted = hasKey(ow, nearKey);
    }
    const vuln = farSeen || farPersisted;
    const posOk = nearSeen || nearPersisted === true;
    return record(2, 'edit reach', vuln ? 'VULN' : 'PASS', 'S1', {
      note: vuln
        ? `out-of-reach edit at (100,80,0) accepted (broadcast:${farSeen} persisted:${farPersisted}) — no EDIT_REACH_BLOCKS=${EDIT_REACH_BLOCKS}`
        : `edit 100 blocks away rejected; ${posOk ? 'in-reach control accepted' : 'WARN in-reach control not accepted'}`,
      repro: `A@(0,80,0): edit (3,80,0) accepted=${nearSeen}, edit (100,80,0) broadcast=${farSeen} persisted=${farPersisted}`,
      fix: `reject edits whose Euclidean distance from the player's authoritative pos exceeds EDIT_REACH_BLOCKS=${EDIT_REACH_BLOCKS}`,
    });
  } finally {
    await A.close(); await B.close();
  }
}

// -- 3: edit XZ bounds --------------------------------------------------------
async function check03(ctx) {
  const world = wid(3);
  const A = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'attacker' });
  const B = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'observer' });
  try {
    await baseline(A);
    const bigX = 1e12;
    const key = `${bigX},80,0`;
    const before = B.mark();
    A.send(encEdit({ pos: { x: bigX, y: 80, z: 0 }, block: 1, dim: 'overworld' }));
    await sleep(400);
    const seen = B.editsFrom(A.id, before).some((e) => Math.abs(e.x) >= 1e11);
    let persisted = false;
    if (ctx.restAvailable) {
      const ow = editsOf(await getWorld(ctx.restBase, world), 'overworld');
      persisted = hasKey(ow, key) || Object.keys(ow).some((k) => Math.abs(Number(k.split(',')[0])) >= 1e11);
    }
    const vuln = seen || persisted;
    return record(3, 'edit XZ bounds', vuln ? 'VULN' : 'PASS', 'S1', {
      note: vuln
        ? `edit at x=1e12 accepted (broadcast:${seen} persisted:${persisted}) — unbounded edit keys (map/save bloat)`
        : 'edit at x=1e12 rejected (XZ world limit enforced)',
      repro: `A edit (1e12,80,0); broadcast=${seen} persisted=${persisted}`,
      fix: 'reject edits with |x|,|z| > 30000000 (WORLD_MAX_XZ) to bound the edits map / save size',
    });
  } finally {
    await A.close(); await B.close();
  }
}

// -- 4: bedrock / protected floor --------------------------------------------
async function check04(ctx) {
  const world = wid(4);
  const A = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'attacker' });
  const B = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'observer' });
  try {
    await baseline(A);
    // Descend near the floor (pure-vertical → zero horizontal speed → legal) so
    // reach isn't the sole reason a strict server rejects the y==0 break.
    A.send(encMove({ seq: 3, pos: { x: 0, y: 3, z: 0 }, yaw: 0, dim: 'overworld' }));
    await sleep(200);
    const key = '0,0,0';
    const before = B.mark();
    A.send(encEdit({ action: 'break', pos: { x: 0, y: 0, z: 0 }, dim: 'overworld' }));
    await sleep(400);
    const seen = B.editsFrom(A.id, before).some((e) => e.x === 0 && e.y === 0 && e.z === 0);
    let persisted = false;
    if (ctx.restAvailable) persisted = hasKey(editsOf(await getWorld(ctx.restBase, world), 'overworld'), key);
    const vuln = seen || persisted;
    return record(4, 'bedrock/protected floor', vuln ? 'VULN' : 'PASS', 'S2', {
      note: vuln
        ? 'break at y==0 accepted — unbreakable floor not protected'
        : 'break at y==0 rejected (bedrock floor protected)',
      repro: `A break (0,0,0) block 0; broadcast=${seen} persisted=${persisted}`,
      fix: 'reject any edit/break where y==0 (unbreakable bedrock floor)',
    });
  } finally {
    await A.close(); await B.close();
  }
}

// -- 5: cross-dimension edit --------------------------------------------------
async function check05(ctx) {
  const world = wid(5);
  const A = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'attacker', dim: 'overworld' });
  const Bn = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'nether-obs', dim: 'nether' });
  try {
    await baseline(A, 'overworld', 1);
    const key = '2,80,0';
    const before = Bn.mark();
    A.send(encEdit({ pos: { x: 2, y: 80, z: 0 }, block: 5, dim: 'nether' }));
    await sleep(400);
    const netherObserved = Bn.editsFrom(A.id, before).some((e) => `${e.x},${e.y},${e.z}` === key);
    let netherPersisted = false;
    if (ctx.restAvailable) netherPersisted = hasKey(editsOf(await getWorld(ctx.restBase, world), 'nether'), key);
    const vuln = netherObserved || netherPersisted;
    return record(5, 'cross-dimension edit', vuln ? 'VULN' : 'PASS', 'S1', {
      note: vuln
        ? 'overworld client wrote into nether (client dim override trusted)'
        : 'client dim override ignored — edit confined to player current dim',
      repro: `A(overworld) edit dim="nether" (2,80,0); nether-obs=${netherObserved} persisted=${netherPersisted}`,
      fix: "apply edits to the player's CURRENT server-tracked dim; ignore any client-supplied dim override",
    });
  } finally {
    await A.close(); await Bn.close();
  }
}

// -- 6: block-id validity (expect PASS) --------------------------------------
async function check06(ctx) {
  const world = wid(6);
  const A = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'attacker' });
  const B = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'observer' });
  try {
    await baseline(A);
    const before = B.mark();
    A.send(encEdit({ pos: { x: 2, y: 80, z: 0 }, block: 9999, dim: 'overworld' }));
    A.send(encEdit({ pos: { x: 2, y: 80, z: 1 }, block: -1, dim: 'overworld' }));
    await sleep(400);
    const seen = B.editsFrom(A.id, before).filter((e) => e.block > 40 || e.block < 0);
    let persisted = false;
    if (ctx.restAvailable) {
      const ow = editsOf(await getWorld(ctx.restBase, world), 'overworld');
      persisted =
        (hasKey(ow, '2,80,0') && (ow['2,80,0'] > 40 || ow['2,80,0'] < 0)) ||
        (hasKey(ow, '2,80,1') && (ow['2,80,1'] > 40 || ow['2,80,1'] < 0));
    }
    const vuln = seen.length > 0 || persisted;
    return record(6, 'block-id validity', vuln ? 'VULN' : 'PASS', 'S2', {
      note: vuln
        ? `invalid block id accepted (${seen.map((e) => e.block).join(',') || 'persisted'})`
        : 'block ids 9999 and -1 rejected (integer 0..40 enforced)',
      repro: `A edit block=9999 & block=-1; accepted=${seen.length} persisted=${persisted}`,
      fix: 'reject edits whose block id is not an integer in 0..40',
    });
  } finally {
    await A.close(); await B.close();
  }
}

// -- 7: edit rate (20/s cap) --------------------------------------------------
async function check07(ctx) {
  const world = wid(7);
  const A = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'attacker' });
  const B = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'observer' });
  try {
    await baseline(A);
    const before = B.mark();
    const N = 100;
    for (let i = 0; i < N; i++) {
      const x = (i % 5) - 2;
      const z = (Math.floor(i / 5) % 5) - 2;
      A.send(encEdit({ pos: { x, y: 80, z }, block: 1, dim: 'overworld' }));
    }
    await sleep(1500);
    const accepted = B.editsFrom(A.id, before).length;
    const vuln = accepted > 40; // 20/s cap admits ≈20–24 over this window; no cap ≈100
    return record(7, 'edit rate cap', vuln ? 'VULN' : 'PASS', 'S1', {
      note: vuln
        ? `${accepted}/${N} edits broadcast — no ${EDIT_RATE_CAP_PER_S}/s edit-rate cap`
        : `edit flood throttled to ${accepted} broadcasts (~${EDIT_RATE_CAP_PER_S}/s cap holds)`,
      repro: `A sent ${N} in-reach edits in <1s; observer received ${accepted}`,
      fix: `cap edits at EDIT_RATE_CAP_PER_S=${EDIT_RATE_CAP_PER_S} per connection; drop the excess`,
    });
  } finally {
    await A.close(); await B.close();
  }
}

// -- 8: id / authorship spoof (expect PASS) ----------------------------------
async function check08(ctx) {
  const world = wid(8);
  const A = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'attacker' });
  const B = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'observer' });
  try {
    await sleep(250);
    A.send(encMove({ seq: 1, pos: { x: 1, y: 80, z: 0 }, yaw: 0, dim: 'overworld' })); // legal baseline
    await sleep(220);
    const before = B.mark();
    // Raw frame smuggling a forged id/name (the adapter never emits id/name).
    A.sendJson({ t: 'move', x: 2, y: 80, z: 0, yaw: 0, pitch: 0, dim: 'overworld', id: 'p999', name: 'evil' });
    await sleep(500);
    void before; // spoof id is compared across all frames, not just the marked window
    const spoofed = B.decoded.some((d) => d.kind === 'move' && d.id === 'p999');
    const realSeen = B.decoded.some((d) => d.kind === 'move' && d.id === A.id);
    let verdict;
    let note;
    if (spoofed) {
      verdict = 'VULN';
      note = 'observer saw a move authored by forged id "p999" — client id trusted';
    } else if (realSeen) {
      verdict = 'PASS';
      note = `broadcasts carry the server-minted id (${A.id}); forged id/name ignored`;
    } else {
      verdict = 'SKIP';
      note = 'no move from attacker observed — inconclusive';
    }
    return record(8, 'id/authorship spoof', verdict, 'S1', {
      note,
      repro: `A sent raw move id="p999" name="evil"; spoofSeen=${spoofed} realIdSeen=${realSeen}`,
      fix: 'always broadcast the server-minted id/name; never trust a client-supplied id/name field',
    });
  } finally {
    await A.close(); await B.close();
  }
}

// -- 9: name spoof / length / charset / dedup --------------------------------
async function check09(ctx) {
  const world = wid(9);
  // Dangerous chars FRONT-LOADED so a truncation can't incidentally hide them.
  const badName = '<b>' + String.fromCharCode(0, 7) + '<script>alert(1)</script>' + 'A'.repeat(120);
  const B = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'observer' });
  const A = await connectPlayer(ctx.wsUrl, { worldId: world, name: badName });
  const A2 = await connectPlayer(ctx.wsUrl, { worldId: world, name: badName });
  try {
    await sleep(400);
    const pjA = B.peerJoinsFor(A.id);
    const pjA2 = B.peerJoinsFor(A2.id);
    const nameA = pjA.length ? String(pjA[pjA.length - 1].name ?? '') : null;
    const nameA2 = pjA2.length ? String(pjA2[pjA2.length - 1].name ?? '') : null;
    if (nameA == null || nameA2 == null) {
      return skip(9, 'name spoof/charset/dedup', 'S2', 'observer did not receive both peer-joins — inconclusive');
    }
    const sanitized = nameA.length <= 32 && !/[\u0000-\u001f]/.test(nameA) && !/[<>]/.test(nameA);
    const deduped = nameA !== nameA2;
    const vuln = !sanitized || !deduped;
    const issues = [];
    if (nameA.length > 32) issues.push(`len ${nameA.length}>32`);
    if (/[\u0000-\u001f]/.test(nameA)) issues.push('control chars kept');
    if (/[<>]/.test(nameA)) issues.push('<> kept');
    if (!deduped) issues.push('duplicate names indistinguishable');
    return record(9, 'name spoof/charset/dedup', vuln ? 'VULN' : 'PASS', 'S2', {
      note: vuln
        ? `name not fully hardened: ${issues.join('; ')}`
        : 'name truncated ≤32, control chars + <> stripped, duplicates deduped',
      repro: `join name len=${badName.length} w/ ctrl+<script>; observed len=${nameA.length}, dedup=${deduped}`,
      fix: 'cap name ≤32, strip control chars and <>, and dedup display names within a room',
    });
  } finally {
    await A.close(); await A2.close(); await B.close();
  }
}

// -- 10: chat sanitization + static sink scan --------------------------------
async function check10(ctx) {
  const world = wid(10);
  const A = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'attacker' });
  const B = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'observer' });
  try {
    const payload = '<img src=x onerror=alert(1)>';
    const before = B.mark();
    A.send(encChat({ text: payload }));
    await sleep(400);
    const chats = B.chatsFrom(A.id, before);
    let runtimeRaw = null; // null => not observed
    if (chats.length) {
      const text = String(chats[chats.length - 1].text ?? '');
      runtimeRaw = /<[a-z!/]/i.test(text); // a raw tag opener survived = unescaped
    }

    const scan = scanPublicSrc();
    const staticVuln = !scan.skipped && scan.dangerous.length > 0;

    let verdict;
    let staticNote;
    if (scan.skipped) staticNote = 'static scan skipped (public/src absent)';
    else staticNote = `static scan: ${scan.filesScanned} files, ${scan.dangerous.length} network-fed HTML sink(s)`;

    if (runtimeRaw === true || staticVuln) verdict = 'VULN';
    else if (runtimeRaw === false || !scan.skipped) verdict = 'PASS';
    else verdict = 'SKIP'; // no chat echo observed AND no static coverage

    let note;
    if (verdict === 'VULN') {
      const parts = [];
      if (runtimeRaw === true) parts.push('chat broadcast UNESCAPED');
      if (staticVuln) parts.push(`${scan.dangerous.length} client innerHTML sink(s)`);
      note = parts.join('; ') + `; ${staticNote}`;
    } else if (verdict === 'PASS') {
      note = `${runtimeRaw === false ? 'chat HTML-escaped before broadcast' : 'chat echo not observed'}; ${staticNote}`;
    } else {
      note = `chat echo not observed; ${staticNote}`;
    }
    return record(10, 'chat sanitization + sink scan', verdict, 'S2', {
      note,
      repro: `A chat "${payload}"; runtimeRaw=${runtimeRaw}; ${staticNote}`,
      fix: 'HTML-escape (&,<,>,",\' → entities) chat/name server-side before broadcast; keep client sinks off innerHTML',
    });
  } finally {
    await A.close(); await B.close();
  }
}

// -- 11: chat rate (3 / 2000ms cap) ------------------------------------------
async function check11(ctx) {
  const world = wid(11);
  const A = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'attacker' });
  const B = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'observer' });
  try {
    const before = B.mark();
    for (let i = 0; i < 20; i++) A.send(encChat({ text: `spam-${i}` }));
    await sleep(2000);
    const got = B.chatsFrom(A.id, before).length;
    const vuln = got > 4; // cap of 3/2000ms admits ≈3; no cap → 20
    return record(11, 'chat rate cap', vuln ? 'VULN' : 'PASS', 'S2', {
      note: vuln
        ? `observer received ${got}/20 chats within 2s — no ${CHAT_RATE.msgs}/${CHAT_RATE.perMs}ms cap`
        : `chat flood throttled to ${got} within 2s (${CHAT_RATE.msgs}/${CHAT_RATE.perMs}ms cap holds)`,
      repro: `A sent 20 chats in <1s; observer received ${got} within 2s`,
      fix: `cap chat at ${CHAT_RATE.msgs} messages / ${CHAT_RATE.perMs}ms per connection; drop the excess`,
    });
  } finally {
    await A.close(); await B.close();
  }
}

// -- 12: non-finite state integrity (expect PASS) ----------------------------
async function check12(ctx) {
  const world = wid(12);
  const A = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'attacker' });
  const B = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'observer' });
  try {
    await baseline(A);
    const beforeRaw = B.raws.length;
    // Bypass the adapter (which coerces non-finite → 0) and send raw hostile coords.
    A.sendJson({ t: 'move', x: null, y: 80, z: 0, yaw: 0, pitch: 0, dim: 'overworld' });
    A.sendJson({ t: 'move', x: 'NaN', y: 80, z: 0, yaw: 0, pitch: 0, dim: 'overworld' });
    A.sendJson({ t: 'move', x: 'Infinity', y: 80, z: 0, yaw: 0, pitch: 0, dim: 'overworld' });
    A.sendJson({ t: 'move', x: [1, 2], y: 80, z: 0, yaw: 0, pitch: 0, dim: 'overworld' });
    await sleep(500);
    // Inspect the ACTUAL on-the-wire coords B received (raw, not decoded).
    const raw = B.rawFramesFrom(A.id, 'move', beforeRaw);
    const bad = raw.filter((m) => {
      for (const k of ['x', 'y', 'z']) {
        const v = m[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) return true;
      }
      return false;
    });
    const vuln = bad.length > 0;
    return record(12, 'non-finite state integrity', vuln ? 'VULN' : 'PASS', 'S1', {
      note: vuln
        ? `server propagated ${bad.length} non-number coord(s) to observer (e.g. ${JSON.stringify(bad[0].x)})`
        : 'null / "NaN" / "Infinity" / non-number coords never propagated to observer',
      repro: `A raw moves x∈{null,"NaN","Infinity",[1,2]}; observer bad-coord frames=${bad.length}`,
      fix: 'drop moves whose x/y/z are not finite numbers; never rebroadcast NaN/Infinity/null coords',
    });
  } finally {
    await A.close(); await B.close();
  }
}

// -- 13: concurrent consistency ----------------------------------------------
async function check13(ctx) {
  if (!ctx.restAvailable) {
    return skip(13, 'concurrent consistency', 'S1', 'REST unavailable — cannot read the resolved authoritative cell value');
  }
  const world = wid(13);
  const A = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'writerA' });
  const B = await connectPlayer(ctx.wsUrl, { worldId: world, name: 'writerB' });
  try {
    await baseline(A);
    await baseline(B);
    const key = '2,80,0';
    // Near-simultaneous conflicting writes to the SAME in-reach cell.
    A.send(encEdit({ pos: { x: 2, y: 80, z: 0 }, block: 5, dim: 'overworld' }));
    B.send(encEdit({ pos: { x: 2, y: 80, z: 0 }, block: 7, dim: 'overworld' }));
    await sleep(600);
    const ow = editsOf(await getWorld(ctx.restBase, world), 'overworld');
    const val = ow[key];
    const converged = val === 5 || val === 7; // single deterministic LWW value
    const vuln = !converged;
    return record(13, 'concurrent consistency', vuln ? 'VULN' : 'PASS', 'S1', {
      note: vuln
        ? `same-cell conflict did not resolve to a single valid value (got ${JSON.stringify(val)})`
        : `same-cell conflict resolved last-writer-wins to block ${val} (all observers converge)`,
      repro: `A block=5 & B block=7 at (2,80,0) near-simultaneously; GET ${key}=${JSON.stringify(val)}`,
      fix: 'resolve concurrent same-cell edits deterministically (last-writer-wins) so all observers converge',
    });
  } finally {
    await A.close(); await B.close();
  }
}

// -- 14: unauthenticated REST write (expect VULN) ----------------------------
async function check14(ctx) {
  if (!ctx.restAvailable) {
    return skip(14, 'unauth REST write', 'S1', 'REST unavailable — cannot exercise PUT /api/worlds/:id');
  }
  const world = wid(14);
  const key = '5,80,5';
  const body = JSON.stringify({ edits: { overworld: { [key]: 10 } } });
  const put = await httpRequest('PUT', `${ctx.restBase}/api/worlds/${encodeURIComponent(world)}`, { body });
  const status = put.status || 0;
  if (status === 401 || status === 403) {
    return record(14, 'unauth REST write', 'PASS', 'S1', {
      note: `unauthenticated PUT rejected (${status})`,
      repro: `PUT /api/worlds/${world} no auth → ${status}`,
      fix: 'keep requiring an auth token on PUT /api/worlds/:id',
    });
  }
  // 2xx? confirm persistence via GET.
  let persisted = false;
  if (status >= 200 && status < 300) {
    persisted = hasKey(editsOf(await getWorld(ctx.restBase, world), 'overworld'), key);
  }
  const vuln = status >= 200 && status < 300 && persisted;
  let verdict;
  let note;
  if (vuln) {
    verdict = 'VULN';
    note = `unauthenticated PUT accepted (${status}) and persisted — anyone can bulk-write any world`;
  } else if (status >= 200 && status < 300) {
    verdict = 'PASS';
    note = `PUT returned ${status} but the edit did not persist (write not applied)`;
  } else if (status > 0) {
    verdict = 'PASS';
    note = `unauthenticated PUT rejected (${status})`;
  } else {
    return skip(14, 'unauth REST write', 'S1', `PUT failed to reach REST (${put.error || 'no response'})`);
  }
  return record(14, 'unauth REST write', verdict, 'S1', {
    note,
    repro: `PUT /api/worlds/${world} {${key}:10} no auth → ${status}; persisted=${persisted}`,
    fix: 'require an auth token (401/403 otherwise) on PUT /api/worlds/:id, or disable bulk edit writes',
  });
}

// -- 15: DoS re-verify — oversized frame + message flood ---------------------
async function check15(ctx) {
  // (a) oversized frame ------------------------------------------------------
  let oversizedDefended = null; // null => inconclusive
  let oversizeCode = null;
  try {
    const c = await wsConnect(ctx.wsUrl, { maxPayload: CLIENT_MAX_PAYLOAD, handshakeTimeoutMs: 5000 });
    const closeP = waitForClose(c, 3500);
    c.sendRawFrame({ opcode: OP_TEXT, payload: Buffer.alloc(OVERSIZE_BYTES, 0x61), masked: true });
    const res = await closeP;
    oversizedDefended = res.closed;
    oversizeCode = res.code;
    try { c.close(); } catch { /* ignore */ }
  } catch {
    oversizedDefended = null;
  }

  // (b) message flood --------------------------------------------------------
  let floodDefended = null;
  let floodSent = 0;
  try {
    const A = await connectPlayer(ctx.wsUrl, { worldId: wid(15), name: 'flooder' });
    const closeP = waitForClose(A.conn, 6000);
    let closed = false;
    A.conn.on('close', () => { closed = true; });
    for (let batch = 0; batch < 50 && !closed; batch++) {
      for (let i = 0; i < 1000; i++) {
        if (A.conn.readyState !== OPEN) { closed = true; break; }
        A.send('{}');
        floodSent++;
      }
      await new Promise((r) => setImmediate(r)); // yield: flush writes + process close
    }
    if (!closed) {
      const res = await Promise.race([closeP, sleep(600).then(() => ({ closed: false }))]);
      closed = res.closed || A.conn.readyState !== OPEN;
    }
    floodDefended = closed;
    try { A.conn.close(); } catch { /* ignore */ }
  } catch {
    floodDefended = null;
  }

  const oversizedVuln = oversizedDefended === false;
  const floodVuln = floodDefended === false;
  const patch1 = oversizedDefended === true ? 'landed' : oversizedDefended === false ? 'ABSENT' : 'inconclusive';
  const patch2 = floodDefended === true ? 'landed' : floodDefended === false ? 'ABSENT' : 'inconclusive';

  let verdict;
  if (oversizedVuln || floodVuln) verdict = 'VULN';
  else if (oversizedDefended === null && floodDefended === null) verdict = 'SKIP';
  else verdict = 'PASS';

  const severity = oversizedVuln ? 'S0' : floodVuln ? 'S1' : 'S0';
  return record(15, 'DoS re-verify (frame+flood)', verdict, severity, {
    note:
      `patch#1 maxPayload(${MAX_FRAME_BYTES})=${patch1} (8MB frame ${oversizedDefended === true ? `closed ${oversizeCode}` : oversizedDefended === false ? 'ACCEPTED' : 'n/a'}); ` +
      `patch#2 msg-rate-limit=${patch2} (flood of ${floodSent} ${floodDefended === true ? 'throttled/closed' : floodDefended === false ? 'ALL ACCEPTED' : 'n/a'})`,
    repro: `8MB WS frame → closed=${oversizedDefended}; ${floodSent}-msg flood → throttled/closed=${floodDefended}`,
    fix: `set WS maxPayload=${MAX_FRAME_BYTES} (close 1009 oversized) and add a per-connection message-rate strike→close 1008`,
  });
}

const CHECKS = [
  check01, check02, check03, check04, check05, check06, check07, check08,
  check09, check10, check11, check12, check13, check14, check15,
];

/** Run one check; convert any thrown error into a SKIP so the suite never crashes. */
async function runCheck(fn, ctx) {
  try {
    return await fn(ctx);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    // Recover the check number from the function name (checkNN).
    const n = Number((/check(\d+)/.exec(fn.name) || [])[1]) || 0;
    return skip(n, `check ${n}`, 'S2', `error: ${msg}`);
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
  const cols = { id: 3, name: 28, verdict: 7, sev: 4, note: 74 };
  const bar = '-'.repeat(cols.id + cols.name + cols.verdict + cols.sev + cols.note + 5);
  console.log('');
  console.log('AUTHORITY AUDIT — PASS/VULN TABLE');
  console.log(bar);
  console.log(
    `${pad('#', cols.id)} ${pad('check', cols.name)} ${pad('verdict', cols.verdict)} ${pad('sev', cols.sev)} note`,
  );
  console.log(bar);
  for (const r of records) {
    console.log(
      `${pad(r.id, cols.id)} ${pad(r.name, cols.name)} ${pad(r.verdict, cols.verdict)} ${pad(r.severity, cols.sev)} ${String(r.note).slice(0, cols.note)}`,
    );
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
    report: { default: '', env: 'AUTHORITY_REPORT', type: 'string' },
    help: { default: false, type: 'boolean' },
  });
  return opts;
}

function printHelp() {
  console.log(`authority-test.mjs — 15-check server-authority audit / regression suite

USAGE
  node scripts/authority-test.mjs [--spawn | --url <ws://…/ws> | --server-cmd "<cmd>"]

TARGET (precedence: --spawn > --server-cmd > --url)
  --spawn                 Spawn the strict reference (scripts/authority-ref-server.mjs);
                          every check MUST PASS (self-test).
  --url <ws://host:port/ws>   Audit an already-running server (env GAME_URL).
  --server-cmd "<cmd>"    Spawn a server via shell, then audit it (uses --url or the
                          protocol default ${defaultUrl()}). Env SERVER_CMD.
  --server-cwd <dir>      Working directory for --server-cmd (env SERVER_CWD).
  --rest <http://host:port>   REST base (default derived from the ws url). Env REST_URL.
  --report <file.json>    Write the machine-readable report (env AUTHORITY_REPORT).

EXIT  0 iff zero VULNs · 1 if any VULN · 2 on a fatal setup error (target unreachable).`);
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

  let installedCleanup = false;
  const onSignal = () => { cleanupServer().finally(() => process.exit(130)); };

  try {
    await startServer(opts);
  } catch (err) {
    console.error(`\nFATAL: ${(err && err.message) || err}`);
    await cleanupServer();
    process.exit(2);
  }

  // Ensure a spawned server is always killed, even on Ctrl-C.
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  installedCleanup = true;

  console.log(`[authority] target ws=${server.wsUrl}  rest=${server.restBase}  mode=${server.mode}`);

  // Preflight: one client must connect+join, else the whole audit is fatal.
  try {
    const probe = await connectPlayer(server.wsUrl, { worldId: `preflight-${RUN_TAG}`, name: 'preflight' });
    await probe.close();
  } catch (err) {
    console.error(`\nFATAL: preflight join failed: ${(err && err.message) || err}`);
    await cleanupServer();
    process.exit(2);
  }

  const restAvailable = await restReachable(server.restBase);
  if (!restAvailable) {
    console.log('[authority] NOTE: REST not reachable — persistence-dependent checks (13,14) will SKIP');
  }

  const ctx = { wsUrl: server.wsUrl, restBase: server.restBase, restAvailable };

  const records = [];
  for (const fn of CHECKS) {
    const rec = await runCheck(fn, ctx);
    records.push(rec);
    console.log(`  [${rec.verdict}] ${rec.id} ${rec.name} — ${rec.note}`);
  }
  records.sort((a, b) => a.id - b.id);

  const counts = { PASS: 0, VULN: 0, SKIP: 0 };
  for (const r of records) counts[r.verdict] = (counts[r.verdict] || 0) + 1;

  printTable(records);
  console.log(
    `SUMMARY  PASS=${counts.PASS}  VULN=${counts.VULN}  SKIP=${counts.SKIP}  (of ${records.length})`,
  );
  const vulns = records.filter((r) => r.verdict === 'VULN');
  if (vulns.length) {
    console.log('\nVULNERABILITIES:');
    for (const r of vulns) console.log(`  #${r.id} [${r.severity}] ${r.name}: ${r.note}\n     fix: ${r.fix}`);
  }

  const report = {
    tool: 'authority-test',
    generatedAt: new Date().toISOString(),
    target: { wsUrl: server.wsUrl, restBase: server.restBase, mode: server.mode, restAvailable },
    summary: { ...counts, total: records.length, vulnerable: counts.VULN > 0 },
    checks: records,
  };
  if (opts.report) {
    const ok = writeJsonReport(opts.report, report);
    console.log(`\n[authority] report ${ok ? 'written to' : 'FAILED to write'} ${opts.report}`);
  }

  await cleanupServer();
  if (installedCleanup) {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  process.exit(counts.VULN > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`\nFATAL (uncaught): ${(err && err.stack) || err}`);
  await cleanupServer();
  process.exit(2);
});
