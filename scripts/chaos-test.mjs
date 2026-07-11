#!/usr/bin/env node
/**
 * chaos-test.mjs — malformed / adversarial-input chaos harness for the
 * multiplayer backend. It hurls a battery of hostile packets and connection
 * behaviours at the server and asserts one thing above all: THE SERVER MUST
 * NEVER CRASH, STALL, OR LEAK, and well-behaved clients must keep being served.
 *
 * WHY THIS EXISTS
 * This harness is TARGET-AGNOSTIC and TOLERANT. By default it spawns the bundled
 * reference server (scripts/mock-server.mjs), which faithfully speaks the real
 * "Voxelheim" wire protocol defined in scripts/lib/protocol.mjs on top of the
 * dependency-free WebSocket transport in scripts/lib/ws-transport.mjs, and which
 * ALSO models good-behaviour defences (a sane message-size cap + rate-limit). Point
 * it at the real server with --url / --server-cmd. Against an ARBITRARY server the
 * absence of those defences is treated as a VULNERABILITY / observation (a WARNING),
 * NOT a hard failure — the real Voxelheim server is documented to have no app-level
 * size cap, no rate limiting, and to silently ignore bad/pre-join/unknown frames.
 * Only scripts/lib/protocol.mjs is protocol-specific; the transport + this harness
 * measure generically via the adapter's CAPS.
 *
 * DEPENDENCY-FREE: Node builtins only (node:net, node:crypto, node:fs, node:path,
 * node:child_process, node:url) plus the harness's own sibling modules. No npm
 * deps, no global WebSocket (the transport implements RFC6455 itself). Target
 * runtime: Node 20 (CI) / Node 22 (local).
 *
 * ---------------------------------------------------------------------------
 * THE CANARY
 * Before any attack runs we establish a healthy CANARY client in its OWN world
 * (join, then prove liveness on demand via a WS CONTROL-FRAME PING/PONG — both the
 * reference and the real `ws` server auto-answer a ping with a pong at the protocol
 * layer, so a returned pong proves the socket is still being serviced by the event
 * loop). The pong path BYPASSES every app-level rate limit (chat throttle 3/2s,
 * edit/move buckets), so rapid attack vectors can't starve the probe into a FALSE
 * "unresponsive" flag. Keeping the canary in a dedicated world means only a true
 * server-wide problem (crash / event-loop starvation) can disrupt it — never a
 * legitimate same-room broadcast. It MUST stay responsive through every attack.
 *
 * THE 12 VECTORS (run sequentially, each on a fresh connection unless noted):
 *   1  invalid JSON text                             (Voxelheim silently ignores)
 *   2  oversized frame (CHAOS_OVERSIZE_BYTES, def 8 MB, never 100 MiB)
 *                                                    -> mock closes; real server has NO cap (VULN)
 *   3  type-confusion (valid JSON, wrong field types)
 *   4  unknown message type                          (Voxelheim silently ignores)
 *   5  missing required fields
 *   6  binary frame where text is expected
 *   7  valid fragmented reassembly AND an unfinished fragment + abrupt disconnect
 *   8  raw garbage bytes with NO handshake (node:net)
 *   9  mid-handshake disconnect (partial HTTP upgrade, then destroy)
 *   10 rapid reconnect storm (open+close ~200x fast)
 *   11 SLOW READER (join, stop draining while a co-tenant pushes broadcasts at us)
 *   12 message FLOOD (~thousands msgs/sec for ~3 s)  -> mock rate-limits; real server does NOT (VULN)
 *
 * AFTER EACH VECTOR we assert:
 *   (i)   server still alive           (spawned/--server-pid: pid alive; else: fresh client connects)
 *   (ii)  canary still responsive      (WS ping → pong comes back)
 *   (iii) others unaffected            (a fresh healthy client can connect+join)
 * and record {id,name,serverAlive,canaryOk,othersUnaffected,observation,severity}.
 *
 * SEVERITY: "ok" (safe / defended / documented-and-harmless), "warning" (a
 * VULNERABILITY or observation that is unsafe-but-not-crash on THIS target — e.g.
 * accepted an oversized frame, no rate limit, unbounded buffer growth, silent
 * ignore of bad input) or "critical" (the vector CRASHED the server, disrupted the
 * canary, or caused a DoS to other clients). EXIT 1 ONLY on a critical (crash /
 * canary disruption / DoS to others); otherwise EXIT 0 — warnings are reported but
 * NEVER fail the run against an arbitrary server.
 * ---------------------------------------------------------------------------
 */

import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { wsConnect, OPEN } from './lib/ws-transport.mjs';
import { CAPS, defaultUrl, encJoin, encChat, encMove, decode } from './lib/protocol.mjs';
import {
  parseArgs,
  envNum,
  envStr,
  nowMs,
  printReport,
  writeJsonReport,
} from './lib/util.mjs';

/* =========================================================================
 * Constants / tunables.
 * ========================================================================= */

// WebSocket opcodes (for hand-built chaos frames via WSConn.sendRawFrame).
const OPC = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

// ws@8's default inbound cap when the server sets no maxPayload (the real
// Voxelheim server sets none). We must stay well BELOW this: at/above 100 MiB the
// ws library itself rejects the frame, which would mask whether the *application*
// has a size cap of its own.
const WS_DEFAULT_INBOUND_CAP = 100 * 1024 * 1024; // ws@8 default maxPayload

// Oversized-frame vector size. Default 8 MB (comfortably under the 100 MiB ws cap,
// and NEVER at/above it). Override via CHAOS_OVERSIZE_BYTES. The goal is to prove
// whether the target enforces an APP-LEVEL size cap: the mock closes; the real
// Voxelheim server accepts it (a reported vulnerability), not a crash.
const OVERSIZE_DEFAULT = 8 * 1024 * 1024; // 8 MB
function resolveOversizeBytes() {
  let n = envNum('CHAOS_OVERSIZE_BYTES', OVERSIZE_DEFAULT);
  if (!Number.isFinite(n) || n <= 0) n = OVERSIZE_DEFAULT;
  n = Math.floor(n);
  const ceil = WS_DEFAULT_INBOUND_CAP - (1 << 20); // stay ~1 MiB below 100 MiB
  if (n > ceil) n = ceil;
  return n;
}
const OVERSIZE_BYTES = resolveOversizeBytes();

// Reference-server (spawned mock) message-size cap — the mock's "good behaviour"
// defence. Only wired into the spawned mock's env; an arbitrary --url target is
// judged by what it actually does, not by this number.
const MOCK_MAX_PAYLOAD = envNum('GAME_MAX_PAYLOAD', 1 << 20);

// Generous client-side inbound cap so nothing on OUR side rejects a server frame
// (server->client frames are tiny; this only matters if a server misbehaves). Kept
// comfortably above the oversized payload we send so a hypothetical echo can't trip
// our own guard.
const CLIENT_MAX_PAYLOAD = Math.max(8 << 20, OVERSIZE_BYTES + (1 << 20));

// Slow-reader RSS growth beyond this (needs a sampleable pid: spawned server or
// --server-pid, Linux only) is flagged as a possible unbounded-buffering vuln.
const SLOW_READER_MAX_GROWTH_MB = 150;

// Dedicated worlds keep the canary isolated from attack-room broadcast fan-out, so
// only a true server-wide problem can disrupt it. All match ^[A-Za-z0-9_-]{1,64}$.
const CANARY_WORLD = 'chaoscanary';
const ATTACK_WORLD = 'chaosattack';
const SLOW_WORLD = 'chaosslow';

/* =========================================================================
 * Tiny helpers.
 * ========================================================================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve absolute path to a sibling script regardless of CWD. */
function siblingPath(name) {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), name);
}

/** Is a pid still alive? Signal 0 probes without actually signalling. */
function isPidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM => exists but not ours (shouldn't happen for a child); ESRCH => gone.
    return e && e.code === 'EPERM';
  }
}

/** Read a spawned process's resident memory in MB (Linux only), else null. */
function readRssMB(pid) {
  if (!pid || process.platform !== 'linux') return null;
  try {
    const data = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = data.match(/VmRSS:\s+(\d+)\s*kB/i);
    if (!m) return null;
    const mb = Number(m[1]) / 1024;
    return Number.isFinite(mb) ? mb : null;
  } catch {
    return null;
  }
}

/** Grab a free ephemeral TCP port (best-effort; 0 => let the child default). */
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

/** Poll a TCP port until it accepts a connection or the timeout elapses. */
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

/**
 * Resolve once a message satisfying `predicate` arrives on `conn`, or null on
 * timeout. Cleans up its own listener so it never leaks under attack traffic.
 */
function waitForMessage(conn, predicate, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const onMsg = (data, isBinary) => {
      if (done) return;
      let dec;
      try { dec = decode(data); } catch { dec = { kind: 'unknown', raw: data }; }
      let hit = false;
      try { hit = !!predicate(dec, data, isBinary); } catch { hit = false; }
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
 * CLI / config.
 * ========================================================================= */

function parseConfig(argv) {
  const { opts } = parseArgs(argv, {
    url: { default: '', env: 'GAME_URL', type: 'string' },
    spawn: { default: false, type: 'boolean' },
    'server-cmd': { default: '', env: 'SERVER_CMD', type: 'string' },
    'server-pid': { default: 0, env: 'SERVER_PID', type: 'number' },
    report: { default: '', env: 'CHAOS_REPORT', type: 'string' },
    help: { default: false, type: 'boolean' },
  });
  return opts;
}

function printHelp() {
  console.log(`chaos-test.mjs — TARGET-AGNOSTIC, TOLERANT adversarial chaos harness (Voxelheim)

USAGE
  node scripts/chaos-test.mjs [--spawn | --url <ws://…> | --server-cmd "<cmd>"]
                              [--server-pid <pid>] [--report <path>]

TARGET SELECTION (precedence: --server-cmd > --spawn > --url > default)
  --spawn                 Spawn the bundled reference mock (scripts/mock-server.mjs)
                          and attack it. This is the DEFAULT when nothing else is given.
  --url <ws://host:port/ws>  Attack an already-running server (env: GAME_URL). Not spawned,
                          so "server alive" is judged by a fresh client still connecting
                          (or by --server-pid if given). Default: ${defaultUrl()}
  --server-cmd "<cmd>"    Spawn an arbitrary server via shell, wait for its port
                          (from GAME_URL / GAME_PORT), then attack it (env: SERVER_CMD).
  --server-pid <pid>      PID of an externally-started server we did NOT spawn (env:
                          SERVER_PID). Enables crash detection + slow-reader RSS
                          sampling against a --url target.
  --report <path>         Write a JSON report (env: CHAOS_REPORT).
  --help                  Show this help.

ENV
  GAME_PORT (spawned mock port; a free port is chosen when unset)
  GAME_WS_PATH (default "${CAPS.wsPath}")   GAME_MAX_PAYLOAD (spawned mock's size cap; default 1048576)
  CHAOS_OVERSIZE_BYTES (oversized-frame size; default 8388608 = 8 MB, never >= 100 MiB)

TOLERANCE MODEL
  Against an arbitrary server, MISSING sandboxing is a VULNERABILITY (a WARNING),
  not a failure. Only a crash, a disrupted canary, or a DoS to other clients fails.

EXIT CODES
  0  no crash, canary stayed responsive, no DoS (vulnerability WARNINGS may still be reported)
  1  server crashed, canary was disrupted, or a vector caused a denial of service`);
}

/* =========================================================================
 * Server lifecycle (spawn the mock / an arbitrary server, or just target a URL).
 * ========================================================================= */

const server = {
  proc: null, // ChildProcess (null in --url mode)
  pid: null,
  externalPid: null, // pid of a server we did NOT spawn (--server-pid), for sampling
  exited: false,
  exitCode: null,
  exitSignal: null,
  spawned: false, // true when we own the process
  mode: 'spawn-mock',
  url: '',
  host: '127.0.0.1',
  port: 0,
};

async function startServer(opts) {
  // --- decide the mode ---------------------------------------------------
  if (opts.serverCmd) server.mode = 'server-cmd';
  else if (opts.spawn) server.mode = 'spawn-mock';
  else if (opts.url) server.mode = 'url';
  else server.mode = 'spawn-mock';

  // A caller-supplied pid for an externally-started server (URL mode). Enables
  // crash detection + slow-reader RSS sampling without us owning the process.
  const extPid = Number(opts.serverPid);
  server.externalPid = Number.isInteger(extPid) && extPid > 0 ? extPid : null;

  const wsPath = normalizePath(envStr('GAME_WS_PATH', CAPS.wsPath));

  if (server.mode === 'url') {
    // Targeting an external server: verify reachability, own no process.
    server.spawned = false;
    server.url = opts.url;
    parseHostPort(server.url);
    const ok = await waitForPort(server.host, server.port, 5000);
    if (!ok) throw new Error(`cannot reach target server at ${server.url}`);
    return;
  }

  server.spawned = true;

  if (server.mode === 'server-cmd') {
    // Spawn an arbitrary server; target GAME_URL (or the protocol default).
    server.url = opts.url || defaultUrl();
    parseHostPort(server.url);
    // detached: put the child in its own process group so we can later signal
    // the WHOLE group — a `shell: true` command runs the real server as a
    // grandchild, and killing only the shell would orphan it.
    server.proc = spawn(opts.serverCmd, {
      shell: true,
      detached: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    // Spawn the bundled reference mock on a chosen (free) port.
    let port = envNum('GAME_PORT', 0);
    if (!port) port = await getFreePort();
    if (!port) port = 8080; // last-resort default if free-port probing failed
    server.host = '127.0.0.1';
    server.port = port;
    server.url = `ws://127.0.0.1:${port}${wsPath}`;
    server.proc = spawn(process.execPath, [siblingPath('mock-server.mjs')], {
      detached: true, // own process group -> group-kill on cleanup (see killServer)
      env: {
        ...process.env,
        // Pass both PORT (real-server convention) and GAME_PORT (harness convention)
        // so the mock binds where we expect regardless of which it reads.
        PORT: String(port),
        GAME_PORT: String(port),
        GAME_WS_PATH: wsPath,
        GAME_MAX_PAYLOAD: String(MOCK_MAX_PAYLOAD),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  server.pid = server.proc.pid;
  wireServerProcess(server.proc);

  // Wait until the port accepts connections (works for mock + arbitrary servers).
  const ready = await waitForPort(server.host, server.port, 15000);
  if (!ready) {
    if (server.exited) {
      throw new Error(
        `server process exited before it was ready (code=${server.exitCode}, signal=${server.exitSignal})`,
      );
    }
    throw new Error(`server did not open ${server.host}:${server.port} within 15s`);
  }
}

/** Mirror the child's output (prefixed) and track its exit for liveness checks. */
function wireServerProcess(proc) {
  try {
    if (proc.stdout) proc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
    if (proc.stderr) proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  } catch { /* ignore */ }
  proc.on('exit', (code, signal) => {
    server.exited = true;
    server.exitCode = code;
    server.exitSignal = signal;
  });
  proc.on('error', (err) => {
    process.stderr.write(`[server-spawn-error] ${err && err.message}\n`);
    server.exited = true;
  });
}

function normalizePath(p) {
  let s = typeof p === 'string' && p.length ? p : '/';
  if (s[0] !== '/') s = '/' + s;
  return s;
}

function parseHostPort(url) {
  try {
    const u = new URL(url);
    server.host = u.hostname || '127.0.0.1';
    server.port = Number(u.port) || (u.protocol === 'wss:' ? 443 : 80);
  } catch {
    server.host = '127.0.0.1';
    server.port = 80;
  }
}

/**
 * OS-level liveness of the server process, when we can observe it:
 *   - spawned:            true/false from our child's exit + pid probe
 *   - --server-pid given: true/false from probing that external pid
 *   - otherwise:          null (unknown -> liveness is judged by a fresh client)
 */
function serverProcessAlive() {
  if (server.spawned) return !server.exited && isPidAlive(server.pid);
  if (server.externalPid) return isPidAlive(server.externalPid);
  return null;
}

/** The pid we can sample /proc for (spawned child or --server-pid), else null. */
function samplingPid() {
  if (server.spawned) return server.pid;
  if (server.externalPid) return server.externalPid;
  return null;
}

/* =========================================================================
 * The canary — a healthy client that must stay responsive throughout.
 * ========================================================================= */

const canary = {
  conn: null,
  id: null, // our welcome id ("p<N>")
  pongCount: 0, // WS control-frame pongs received (transport-level liveness signal)
  closed: false,
  closeCode: null,
};

let canaryPingSeq = 0;

async function startCanary() {
  const conn = await wsConnect(server.url, {
    maxPayload: CLIENT_MAX_PAYLOAD,
    handshakeTimeoutMs: 5000,
  });
  canary.conn = conn;
  conn.on('error', () => {});
  conn.on('close', (code) => {
    canary.closed = true;
    canary.closeCode = code;
  });
  // Liveness = WS control-frame ping/pong. Both our reference server and the real
  // `ws` server auto-answer a ping with a pong at the protocol layer, BYPASSING
  // every app-level rate limit (chat throttle, edit/move buckets). That makes the
  // pong a rate-limit-immune "is the socket still being serviced?" probe — unlike
  // chat self-echo, which the hardened server throttles to 3 msgs/2s and would
  // falsely flag as "canary unresponsive" under rapid attack vectors.
  conn.on('pong', () => { canary.pongCount++; });

  // Dedicated world so attack-room broadcasts can never reach the canary.
  conn.send(encJoin({ name: 'canary', worldId: CANARY_WORLD }));
  const welcome = await waitForMessage(conn, (d) => d.kind === 'welcome', 3000);
  if (!welcome) throw new Error('canary never received a welcome — cannot establish a baseline');
  canary.id = welcome.id;

  // Prove the baseline: a ping must come back as a pong.
  const ok = await canaryResponsive(3000);
  if (!ok) throw new Error('canary never received a pong to its ping — cannot establish a baseline');
}

/**
 * Actively probe the canary: send a WS control-frame ping and confirm a NEW pong
 * comes back. The server auto-answers pings at the protocol layer, so this stays
 * responsive even while application messages are being rate-limited/throttled —
 * canary = connected + joined + still receiving pongs within the timeout.
 */
async function canaryResponsive(timeoutMs = 3000) {
  if (canary.closed || !canary.conn || canary.conn.readyState !== OPEN || canary.id == null) return false;
  const before = canary.pongCount;
  try { canary.conn.ping(`canary-alive-${++canaryPingSeq}`); } catch { /* ignore */ }
  return pollUntil(() => canary.pongCount > before, timeoutMs);
}

/** Poll `cond` every 25 ms until true or timeout. */
async function pollUntil(cond, timeoutMs) {
  const start = nowMs();
  while (nowMs() - start < timeoutMs) {
    let ok = false;
    try { ok = !!cond(); } catch { ok = false; }
    if (ok) return true;
    await sleep(25);
  }
  return false;
}

/**
 * Can a brand-new healthy client connect and JOIN (receive a welcome)? Voxelheim
 * has no app ping, so a welcome is the proof the server accepted and served a new
 * client. This doubles as the "server alive" test when the pid is unknown and as
 * the "others unaffected" test always. Probes join the isolated canary world.
 */
async function freshClientOk(timeoutMs = 3000) {
  let c;
  try {
    c = await wsConnect(server.url, {
      maxPayload: CLIENT_MAX_PAYLOAD,
      handshakeTimeoutMs: timeoutMs,
    });
  } catch {
    return false;
  }
  try {
    c.on('error', () => {});
    c.send(encJoin({ name: 'probe', worldId: CANARY_WORLD }));
    const welcome = await waitForMessage(c, (d) => d.kind === 'welcome', timeoutMs);
    return !!welcome;
  } catch {
    return false;
  } finally {
    try { c.terminate(); } catch { /* ignore */ }
  }
}

/* =========================================================================
 * Shared attack-connection helper.
 * ========================================================================= */

/**
 * Open an attacking client. Records error/welcome counts (Voxelheim has no app
 * pong). Optionally joins first (some vectors need a joined session to reach
 * field-level validation — pre-join frames are otherwise silently ignored).
 * Attackers live in a dedicated world, isolated from the canary.
 */
async function openAttacker({ join = false } = {}) {
  const conn = await wsConnect(server.url, {
    maxPayload: CLIENT_MAX_PAYLOAD,
    handshakeTimeoutMs: 4000,
  });
  const state = { errors: 0, welcomes: 0, closed: false, closeCode: null };
  conn.on('error', () => {});
  conn.on('close', (code) => {
    state.closed = true;
    state.closeCode = code;
  });
  conn.on('message', (data) => {
    let d;
    try { d = decode(data); } catch { return; }
    if (d.kind === 'error') state.errors++;
    else if (d.kind === 'welcome') state.welcomes++;
  });
  if (join) {
    conn.send(encJoin({ name: 'chaos', worldId: ATTACK_WORLD }));
    await waitForMessage(conn, (d) => d.kind === 'welcome', 2000);
  }
  return { conn, state };
}

/** Track raw (non-WS) sockets so cleanup can guarantee they are destroyed. */
const rawSockets = new Set();
function trackRaw(sock) {
  rawSockets.add(sock);
  sock.on('close', () => rawSockets.delete(sock));
  sock.on('error', () => {});
  return sock;
}

/* =========================================================================
 * The 12 vectors. Each returns a record {name, observation, severity}; the
 * runner then fills serverAlive/canaryOk/othersUnaffected/failed via
 * assertHealthy(). Every vector is defensive: a throw inside one becomes a
 * recorded observation, never an aborted run.
 * ========================================================================= */

// 1) Invalid JSON text.
async function vecInvalidJson() {
  const v = { name: 'invalid-json', observation: '', severity: 'ok' };
  let p;
  try { p = await openAttacker(); } catch (e) {
    v.observation = `connect failed: ${e && e.message}`;
    v.severity = 'warning';
    return v;
  }
  const { conn, state } = p;
  const junk = [
    'this is not json at all',
    '{"t":"join", oops no quotes}',
    '}{',
    '[[[[[',
    '{"t":',
    '  binary-ish garbage',
    '{"t":"join","name":"x"', // truncated
  ];
  for (const j of junk) { try { conn.send(j); } catch { /* ignore */ } }
  await sleep(300);
  const open = conn.readyState === OPEN;
  // Voxelheim SILENTLY IGNORES invalid JSON (no error frame, no close) — crash-
  // resistant and documented, so this is an OBSERVATION at severity ok. The mock
  // may reply with {t:"error"}; either shape is safe.
  v.observation = `sent ${junk.length} malformed text frames; ${state.errors} {t:"error"} replies; connection ${open ? 'stayed open (silently ignored — documented Voxelheim behaviour)' : 'was closed'}`;
  try { conn.terminate(); } catch { /* ignore */ }
  return v;
}

// 2) Oversized frame (CHAOS_OVERSIZE_BYTES, default 8 MB, never 100 MiB).
// The mock enforces an app-level cap and closes; the real Voxelheim server sets no
// maxPayload (ws default 100 MiB) and no app cap, so it ACCEPTS the frame — that is
// a reported VULNERABILITY, not a crash. Either way: must never OOM.
async function vecOversized() {
  const v = { name: 'oversized-frame', observation: '', severity: 'ok' };
  let conn;
  try {
    conn = await wsConnect(server.url, {
      maxPayload: CLIENT_MAX_PAYLOAD,
      handshakeTimeoutMs: 4000,
    });
  } catch (e) {
    v.observation = `connect failed: ${e && e.message}`;
    v.severity = 'warning';
    return v;
  }
  let closed = false;
  let closeCode = null;
  conn.on('error', () => {});
  conn.on('close', (code) => { closed = true; closeCode = code; });

  const mb = (OVERSIZE_BYTES / (1024 * 1024)).toFixed(1);
  // Hand-built oversized TEXT frame (bypasses our own send() maxPayload guard).
  const big = Buffer.allocUnsafe(OVERSIZE_BYTES);
  big.fill(0x61); // 'a'
  try {
    conn.sendRawFrame({ opcode: OPC.TEXT, payload: big, masked: true });
  } catch (e) {
    v.observation = `failed to write oversized frame: ${e && e.message}`;
    v.severity = 'warning';
    try { conn.terminate(); } catch { /* ignore */ }
    return v;
  }

  await pollUntil(() => closed, 4000);
  if (closed) {
    v.observation = `server enforced an app-level size cap: closed the connection (code ${closeCode}) on a ${mb} MB frame`;
    if (closeCode !== 1009) v.observation += ' (expected 1009, but any close is safe)';
  } else {
    v.observation = `no app-level message-size cap (accepted ${mb} MB; ws 100MiB default) — the server took an oversized payload without closing; unbounded-buffer / OOM risk`;
    v.severity = 'warning';
  }
  try { conn.terminate(); } catch { /* ignore */ }
  return v;
}

// 3) Type-confusion: valid JSON, wrong field types.
async function vecTypeConfusion() {
  const v = { name: 'type-confusion', observation: '', severity: 'ok' };
  let p;
  try { p = await openAttacker({ join: true }); } catch (e) {
    v.observation = `connect failed: ${e && e.message}`;
    v.severity = 'warning';
    return v;
  }
  const { conn, state } = p;
  // Wrong TYPES for the real Voxelheim fields (move x/y/z/yaw/pitch/dim,
  // edit x/y/z/block/dim, chat text, join worldId/name/dim).
  const frames = [
    JSON.stringify({ t: 123 }), // t as number
    JSON.stringify({ t: ['a', 'b'] }), // t as array
    JSON.stringify({ t: 'move', x: 'a', y: 2, z: 3, yaw: 0, pitch: 0, dim: 'overworld' }), // x string
    JSON.stringify({ t: 'move', x: {}, y: [1], z: 3, yaw: 'n', pitch: null, dim: 5 }), // x object, dim number
    JSON.stringify({ t: 'chat', text: 42 }), // text as number
    JSON.stringify({ t: 'edit', x: 1, y: 1, z: 1, block: { evil: true }, dim: 'overworld' }), // block object
    JSON.stringify({ t: 'join', worldId: 999, name: [], dim: true }), // join wrong types
  ];
  for (const f of frames) { try { conn.send(f); } catch { /* ignore */ } }
  await sleep(300);
  const open = conn.readyState === OPEN;
  // Bad values are dropped/ignored (or a {t:"error",code:"bad_edit"} for a bad
  // edit); no crash. Silent ignore is documented Voxelheim behaviour -> severity ok.
  v.observation = `sent ${frames.length} type-confused frames (real fields, wrong types); ${state.errors} error replies; connection ${open ? 'stayed open (bad values dropped/ignored)' : 'sandbox-closed'}`;
  try { conn.terminate(); } catch { /* ignore */ }
  return v;
}

// 4) Unknown message type. Voxelheim silently ignores unknown `t`.
async function vecUnknownType() {
  const v = { name: 'unknown-type', observation: '', severity: 'ok' };
  let p;
  try { p = await openAttacker(); } catch (e) {
    v.observation = `connect failed: ${e && e.message}`;
    v.severity = 'warning';
    return v;
  }
  const { conn, state } = p;
  const frames = [
    JSON.stringify({ t: 'frobnicate', x: 1 }),
    JSON.stringify({ t: '__proto__', polluted: true }),
    JSON.stringify({ t: 'constructor' }),
    JSON.stringify({ t: '' }),
    JSON.stringify({ t: 'MOVE' }), // wrong case
    JSON.stringify({ t: 'Chat', text: 'nope' }), // wrong case
  ];
  for (const f of frames) { try { conn.send(f); } catch { /* ignore */ } }
  await sleep(300);
  const open = conn.readyState === OPEN;
  v.observation = `sent ${frames.length} unknown-type frames; ${state.errors} error replies; connection ${open ? 'stayed open (silently ignored — documented Voxelheim behaviour)' : 'closed'}`;
  try { conn.terminate(); } catch { /* ignore */ }
  return v;
}

// 5) Missing required fields.
async function vecMissingFields() {
  const v = { name: 'missing-fields', observation: '', severity: 'ok' };
  let p;
  try { p = await openAttacker({ join: true }); } catch (e) {
    v.observation = `connect failed: ${e && e.message}`;
    v.severity = 'warning';
    return v;
  }
  const { conn, state } = p;
  const frames = [
    JSON.stringify({ t: 'move' }), // no coords
    JSON.stringify({ t: 'move', x: 1 }), // partial coords, no y/z/dim
    JSON.stringify({ t: 'edit' }), // no coords / block
    JSON.stringify({ t: 'edit', x: 1, y: 1, z: 1 }), // no block
    JSON.stringify({ t: 'chat' }), // no text
    JSON.stringify({}), // no t at all
    JSON.stringify({ t: 'join' }), // no worldId / name / dim
  ];
  for (const f of frames) { try { conn.send(f); } catch { /* ignore */ } }
  await sleep(300);
  const open = conn.readyState === OPEN;
  v.observation = `sent ${frames.length} field-starved frames; ${state.errors} error replies; connection ${open ? 'stayed open (missing fields dropped/ignored)' : 'closed'}`;
  try { conn.terminate(); } catch { /* ignore */ }
  return v;
}

// 6) Binary frame where a text frame is expected.
async function vecBinaryFrame() {
  const v = { name: 'binary-frame', observation: '', severity: 'ok' };
  let p;
  try { p = await openAttacker(); } catch (e) {
    v.observation = `connect failed: ${e && e.message}`;
    v.severity = 'warning';
    return v;
  }
  const { conn, state } = p;
  try {
    // A binary frame carrying an otherwise-valid join, plus a raw binary blob.
    conn.sendRawFrame({ opcode: OPC.BIN, payload: Buffer.from(encJoin({ name: 'bin', worldId: ATTACK_WORLD }), 'utf8'), masked: true });
    conn.sendRawFrame({ opcode: OPC.BIN, payload: Buffer.from([0, 1, 2, 3, 255, 254, 253]), masked: true });
  } catch { /* ignore */ }
  await sleep(300);
  const open = conn.readyState === OPEN;
  v.observation = `sent 2 binary frames (protocol is JSON text); ${state.errors} error replies; ${state.welcomes} welcomes (binary must NOT join); connection ${open ? 'stayed open' : 'closed'}`;
  try { conn.terminate(); } catch { /* ignore */ }
  return v;
}

// 7) Valid fragmented reassembly AND an unfinished fragment + abrupt disconnect.
async function vecFragmented() {
  const v = { name: 'fragmented-and-partial', observation: '', severity: 'ok' };

  // Part A: a valid join split across TEXT + CONT frames must reassemble.
  let reassembled = false;
  let a;
  try {
    a = await wsConnect(server.url, { maxPayload: CLIENT_MAX_PAYLOAD, handshakeTimeoutMs: 4000 });
    a.on('error', () => {});
    const join = encJoin({ name: 'frag', worldId: ATTACK_WORLD });
    const mid = Math.max(1, Math.floor(join.length / 2));
    const p1 = Buffer.from(join.slice(0, mid), 'utf8');
    const p2 = Buffer.from(join.slice(mid), 'utf8');
    a.sendRawFrame({ opcode: OPC.TEXT, payload: p1, fin: false, masked: true });
    a.sendRawFrame({ opcode: OPC.CONT, payload: p2, fin: true, masked: true });
    const w = await waitForMessage(a, (d) => d.kind === 'welcome', 2500);
    reassembled = !!w;
  } catch { /* recorded below */ }
  try { if (a) a.terminate(); } catch { /* ignore */ }

  // Part B: send an UNFINISHED fragment then abruptly destroy the socket.
  let abruptHandled = false;
  try {
    const b = await wsConnect(server.url, { maxPayload: CLIENT_MAX_PAYLOAD, handshakeTimeoutMs: 4000 });
    b.on('error', () => {});
    b.sendRawFrame({ opcode: OPC.TEXT, payload: Buffer.from('{"t":"jo', 'utf8'), fin: false, masked: true });
    await sleep(50);
    b.terminate(); // yank the socket mid-message
    abruptHandled = true;
  } catch { /* recorded below */ }
  await sleep(150);

  v.observation = `fragment reassembly ${reassembled ? 'OK (welcome received)' : 'FAILED (no welcome)'}; mid-fragment abrupt disconnect ${abruptHandled ? 'issued cleanly' : 'errored'}`;
  if (!reassembled) v.severity = 'warning';
  return v;
}

// 8) Raw garbage bytes with NO WebSocket handshake.
async function vecRawGarbage() {
  const v = { name: 'raw-garbage-no-handshake', observation: '', severity: 'ok' };
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    let sock;
    try {
      sock = trackRaw(net.connect({ host: server.host, port: server.port }));
    } catch (e) {
      v.observation = `raw connect failed: ${e && e.message}`;
      done();
      return;
    }
    sock.on('connect', () => {
      try {
        // Non-HTTP junk with embedded CRLFs so the HTTP parser reacts (400/reset).
        const junk = Buffer.concat([
          Buffer.from('\xff\xfe NOT-A-REQUEST \r\nGarbage: \x00\x01\x02\r\n\r\n', 'latin1'),
          crypto.randomBytes(256),
        ]);
        sock.write(junk);
      } catch { /* ignore */ }
      setTimeout(() => { try { sock.destroy(); } catch { /* ignore */ } done(); }, 250);
    });
    sock.on('error', () => done());
    sock.on('close', () => done());
    setTimeout(done, 1500); // absolute backstop
  });
  v.observation = 'wrote non-HTTP garbage to the listen port with no WebSocket handshake; server must 400/reset without throwing';
  return v;
}

// 9) Mid-handshake disconnect (partial HTTP upgrade headers, then destroy).
async function vecMidHandshake() {
  const v = { name: 'mid-handshake-disconnect', observation: '', severity: 'ok' };
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    let sock;
    try {
      sock = trackRaw(net.connect({ host: server.host, port: server.port }));
    } catch (e) {
      v.observation = `raw connect failed: ${e && e.message}`;
      done();
      return;
    }
    let rawPath = '/';
    try { rawPath = new URL(server.url).pathname || '/'; } catch { /* keep '/' */ }
    sock.on('connect', () => {
      try {
        // A partial WebSocket upgrade: no Sec-WebSocket-Key, no terminating blank line.
        sock.write(
          `GET ${rawPath} HTTP/1.1\r\n` +
          `Host: ${server.host}:${server.port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Version: 13\r\n',
        );
      } catch { /* ignore */ }
      setTimeout(() => { try { sock.destroy(); } catch { /* ignore */ } done(); }, 250);
    });
    sock.on('error', () => done());
    sock.on('close', () => done());
    setTimeout(done, 1500);
  });
  v.observation = 'sent partial HTTP upgrade headers then destroyed the socket mid-handshake; server must not throw or leak';
  return v;
}

// 10) Rapid reconnect storm (open+close ~200x fast).
async function vecReconnectStorm() {
  const v = { name: 'reconnect-storm', observation: '', severity: 'ok' };
  const TOTAL = 200;
  const CONCURRENCY = 20;
  let opened = 0;
  let failed = 0;
  for (let i = 0; i < TOTAL; i += CONCURRENCY) {
    const batch = [];
    for (let j = 0; j < CONCURRENCY && i + j < TOTAL; j++) {
      batch.push(
        wsConnect(server.url, { maxPayload: CLIENT_MAX_PAYLOAD, handshakeTimeoutMs: 3000 })
          .then((c) => { opened++; try { c.terminate(); } catch { /* ignore */ } })
          .catch(() => { failed++; }),
      );
    }
    await Promise.all(batch);
  }
  // Let the server evict the churned connections.
  await sleep(200);
  v.observation = `opened+terminated ${opened}/${TOTAL} connections in a storm (${failed} handshake failures under load); server must survive the churn without leaking`;
  return v;
}

// 11) Slow reader: join, then stop draining while a co-tenant PUSHES broadcasts at
// us. A bounded server must not queue those bytes to the stalled socket without
// limit. RSS is sampled via samplingPid() (spawned child or --server-pid); with no
// sampleable pid we can only note best-effort and rely on the canary/fresh probes.
async function vecSlowReader() {
  const v = { name: 'slow-reader', observation: '', severity: 'ok' };
  const windowMs = 3000;
  const pid = samplingPid();

  // The slow reader itself.
  let conn;
  try {
    conn = await wsConnect(server.url, { maxPayload: CLIENT_MAX_PAYLOAD, handshakeTimeoutMs: 4000 });
  } catch (e) {
    v.observation = `connect failed: ${e && e.message}`;
    v.severity = 'warning';
    return v;
  }
  conn.on('error', () => {});
  conn.send(encJoin({ name: 'slow', worldId: SLOW_WORLD }));
  await waitForMessage(conn, (d) => d.kind === 'welcome', 2000);

  // A co-tenant PUSHER in the same room+dim. Its chats echo to the whole room, so
  // the server must deliver them to the paused slow reader — creating the
  // server->client backlog this vector probes. If the server rate-limits/closes the
  // pusher, that is itself good behaviour; we simply generate less backlog.
  let pusher = null;
  let pusherClosed = false;
  try {
    pusher = await wsConnect(server.url, { maxPayload: CLIENT_MAX_PAYLOAD, handshakeTimeoutMs: 4000 });
    pusher.on('error', () => {});
    pusher.on('close', () => { pusherClosed = true; });
    pusher.send(encJoin({ name: 'pusher', worldId: SLOW_WORLD }));
    await waitForMessage(pusher, (d) => d.kind === 'welcome', 2000);
  } catch { pusher = null; }

  await sleep(150); // let both joins register

  const rssBefore = readRssMB(pid);

  // Stop consuming: pause the underlying socket so server->client bytes back up.
  try { conn.raw.pause(); } catch { /* ignore */ }

  const bigText = 'x'.repeat(240); // near the 256-char chat cap to maximise bytes/frame
  let pushed = 0;
  let rssPeak = rssBefore;
  const start = nowMs();
  while (nowMs() - start < windowMs) {
    if (pusher && !pusherClosed && pusher.readyState === OPEN) {
      for (let k = 0; k < 40 && !pusherClosed; k++) {
        let ok;
        try { ok = pusher.send(encChat({ text: `${bigText}-${pushed}` })); } catch { ok = false; }
        pushed++;
        if (ok === false) break; // backpressured/closing — yield below
      }
    }
    const r = readRssMB(pid);
    if (r != null && (rssPeak == null || r > rssPeak)) rssPeak = r;
    await sleep(50);
  }

  try { conn.raw.resume(); } catch { /* ignore */ }
  try { conn.terminate(); } catch { /* ignore */ }
  try { if (pusher) pusher.terminate(); } catch { /* ignore */ }

  const pushNote = pusher
    ? `${pushed} broadcast chats pushed at the paused reader${pusherClosed ? ' (pusher closed early — a rate-limit/sandbox defence)' : ''}`
    : 'no co-tenant pusher (could not open a second connection)';

  if (rssBefore != null && rssPeak != null) {
    const growth = rssPeak - rssBefore;
    v.observation = `held a joined connection without reading for ${windowMs}ms while ${pushNote}; server RSS ${rssBefore.toFixed(1)}→${rssPeak.toFixed(1)} MB (Δ${growth.toFixed(1)} MB)`;
    if (growth > SLOW_READER_MAX_GROWTH_MB) {
      v.severity = 'warning';
      v.observation += ` — exceeds ${SLOW_READER_MAX_GROWTH_MB} MB; possible unbounded buffering to a slow reader`;
    }
  } else {
    const why = pid ? 'server RSS unreadable (non-Linux /proc?)' : 'no --server-pid and not spawned, so server RSS is n/a';
    v.observation = `held a joined connection without reading for ${windowMs}ms while ${pushNote}; best-effort only: ${why} — liveness still asserted via canary + fresh client`;
  }
  return v;
}

// 12) Message flood: one client blasts thousands of msgs/sec for ~3 s. The mock
// rate-limits/sandbox-closes the flooder; the real Voxelheim server has NO rate
// limiting anywhere, so it keeps accepting — a reported VULNERABILITY, not a crash.
async function vecFlood() {
  const v = { name: 'message-flood', observation: '', severity: 'ok' };
  let conn;
  try {
    conn = await wsConnect(server.url, { maxPayload: CLIENT_MAX_PAYLOAD, handshakeTimeoutMs: 4000 });
  } catch (e) {
    v.observation = `connect failed: ${e && e.message}`;
    v.severity = 'warning';
    return v;
  }
  let closed = false;
  let closeCode = null;
  conn.on('error', () => {});
  conn.on('close', (code) => { closed = true; closeCode = code; });
  // Join (Voxelheim ignores pre-join frames), alone in the attack world so the
  // flood's fan-out never reaches the canary — only genuine server-wide starvation
  // could. Flood with valid `move` frames (there is no app ping in this protocol).
  conn.send(encJoin({ name: 'flooder', worldId: ATTACK_WORLD }));
  await waitForMessage(conn, (d) => d.kind === 'welcome', 2000);

  let sent = 0;
  const durationMs = 3000;
  const start = nowMs();
  // Burst-send with yields so the event loop can deliver the server's close frame.
  while (nowMs() - start < durationMs && !closed) {
    for (let k = 0; k < 200 && !closed; k++) {
      let ok;
      try {
        ok = conn.send(encMove({ seq: sent, pos: { x: 0, y: 40, z: 0 }, yaw: 0, dim: 'overworld' }));
      } catch { ok = false; }
      sent++;
      if (ok === false) break; // backpressured or already closing — yield below
    }
    await sleep(0); // yield to the event loop
  }
  // Give the server a moment to sandbox-close if it is going to.
  await pollUntil(() => closed, 1500);

  if (closed) {
    v.observation = `server rate-limited/sandbox-closed the flooder after ~${sent} messages (close code ${closeCode})`;
    if (closeCode !== 1008) v.observation += ' (expected 1008 policy/sandbox, but any close is safe)';
  } else {
    v.observation = `no server-side rate limiting (accepted ~${sent} messages in ${durationMs}ms with no close) — flood/DoS vector`;
    v.severity = 'warning';
  }
  try { conn.terminate(); } catch { /* ignore */ }
  return v;
}

const VECTORS = [
  vecInvalidJson,
  vecOversized,
  vecTypeConfusion,
  vecUnknownType,
  vecMissingFields,
  vecBinaryFrame,
  vecFragmented,
  vecRawGarbage,
  vecMidHandshake,
  vecReconnectStorm,
  vecSlowReader,
  vecFlood,
];

/* =========================================================================
 * Post-vector health assertion.
 * ========================================================================= */

async function assertHealthy(rec) {
  const pidAlive = serverProcessAlive(); // true | false | null (unknown)
  const canaryOk = await canaryResponsive(3000);
  const freshOk = await freshClientOk(3000);

  // A definitive crash requires an observable pid (spawned or --server-pid). With
  // no pid, a dead server surfaces as "fresh client can't connect" -> DoS below.
  const crashed = pidAlive === false;
  const dos = !freshOk; // server not serving new clients => denial of service
  const canaryDisrupted = !canaryOk; // per-connection abuse leaked into the canary

  rec.serverAlive = pidAlive === null ? freshOk : !!pidAlive;
  rec.canaryOk = canaryOk;
  rec.othersUnaffected = freshOk && canaryOk;
  rec.failed = !!(crashed || dos || canaryDisrupted);

  if (rec.failed) {
    const reasons = [];
    if (crashed) reasons.push('server process died');
    if (dos) reasons.push('a fresh client could not connect/join (DoS to others)');
    if (canaryDisrupted) reasons.push('canary ping/pong stopped (unresponsive)');
    rec.severity = 'critical';
    rec.observation = `${rec.observation} | FAILURE: ${reasons.join('; ')}`;
  }
  return rec;
}

/* =========================================================================
 * Cleanup — always kill a spawned server and tear down our own sockets.
 * ========================================================================= */

/**
 * Signal the spawned server. We spawn detached, so `server.pid` is a process
 * GROUP leader; `process.kill(-pid, …)` reaches the whole group — including a
 * real server that runs as a grandchild under `shell: true` — so nothing is
 * orphaned. The direct-child kill is a belt-and-suspenders fallback.
 */
function killServer(signal) {
  if (!server.proc) return;
  const pid = server.pid;
  try { if (pid) process.kill(-pid, signal); } catch { /* group may already be gone */ }
  try { server.proc.kill(signal); } catch { /* ignore */ }
}

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { if (canary.conn) canary.conn.terminate(); } catch { /* ignore */ }
  for (const s of rawSockets) { try { s.destroy(); } catch { /* ignore */ } }
  if (server.proc && !server.exited) {
    // Group SIGTERM reaches the real server directly (mock handles it and exits).
    killServer('SIGTERM');
    // Escalate if it ignores SIGTERM (only fires while our loop is still alive).
    const t = setTimeout(() => { if (!server.exited) killServer('SIGKILL'); }, 1500);
    if (t.unref) t.unref();
  }
}

/* =========================================================================
 * Main.
 * ========================================================================= */

async function main() {
  const opts = parseConfig(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }

  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
  process.on('exit', cleanup);
  // A chaos harness pokes sockets in intentionally weird ways; a stray async
  // error must be logged, not allowed to abort the run.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[chaos-uncaught] ${(err && err.stack) || err}\n`);
  });
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`[chaos-unhandledRejection] ${(err && err.message) || err}\n`);
  });

  console.log('[chaos] starting server / target …');
  await startServer(opts);
  const pidNote = server.spawned ? `, pid=${server.pid}` : server.externalPid ? `, server-pid=${server.externalPid}` : '';
  console.log(`[chaos] target: ${server.url}  (mode=${server.mode}, spawned=${server.spawned}${pidNote})`);

  console.log('[chaos] establishing canary …');
  await startCanary();
  console.log(`[chaos] canary connected and responsive via WS ping/pong (id=${canary.id}, pongs=${canary.pongCount})`);

  const results = [];
  let idx = 0;
  for (const fn of VECTORS) {
    idx++;
    let rec;
    try {
      rec = await fn();
    } catch (e) {
      rec = { name: fn.name.replace(/^vec/, '').toLowerCase(), observation: `vector threw: ${e && e.message}`, severity: 'warning' };
    }
    rec.id = idx;
    if (!rec.name) rec.name = `vector-${idx}`;
    if (!rec.severity) rec.severity = 'ok';
    await assertHealthy(rec);
    results.push(rec);

    const tag = rec.failed ? 'FAIL' : rec.severity === 'warning' ? 'WARN' : 'ok';
    console.log(`[chaos] ${String(idx).padStart(2, '0')} ${rec.name}: ${tag} — ${rec.observation}`);
    await sleep(150); // let the server settle between vectors
  }

  // Final liveness: canary responsive + server still up.
  const canaryFinalOk = await canaryResponsive(3000);
  const finalPid = serverProcessAlive(); // true | false | null
  const serverFinalAlive = finalPid === null ? await freshClientOk(3000) : !!finalPid;

  // ---- report ------------------------------------------------------------
  const failures = results.filter((r) => r.failed);
  const warnings = results.filter((r) => !r.failed && r.severity === 'warning');
  const passed = results.filter((r) => !r.failed && r.severity !== 'warning');

  const exitCode = failures.length > 0 || !canaryFinalOk || !serverFinalAlive ? 1 : 0;

  const report = {
    title: 'chaos-test',
    timestamp: new Date().toISOString(),
    target: {
      url: server.url,
      mode: server.mode,
      spawned: server.spawned,
      pid: server.spawned ? server.pid : server.externalPid || null,
      pidSource: server.spawned ? 'spawned' : server.externalPid ? 'server-pid' : 'none',
      mockMaxPayload: server.spawned ? MOCK_MAX_PAYLOAD : null,
      oversizeFrameBytes: OVERSIZE_BYTES,
    },
    canary: {
      finalResponsive: canaryFinalOk,
      pongsReceived: canary.pongCount,
      everClosed: canary.closed,
      closeCode: canary.closeCode,
    },
    serverFinalAlive,
    summary: {
      vectors: results.length,
      passed: passed.length,
      warnings: warnings.length,
      failures: failures.length,
      result: exitCode === 0 ? 'PASS' : 'FAIL',
    },
    vectors: results.map((r) => ({
      id: r.id,
      name: r.name,
      serverAlive: r.serverAlive,
      canaryOk: r.canaryOk,
      othersUnaffected: r.othersUnaffected,
      severity: r.severity,
      observation: r.observation,
    })),
  };

  printReport('CHAOS TEST', report);

  if (warnings.length) {
    console.log(`\n[chaos] ${warnings.length} VULNERABILITY warning(s) (unsafe-but-not-crash):`);
    for (const w of warnings) console.log(`  - ${w.name}: ${w.observation}`);
  }
  if (failures.length) {
    console.log(`\n[chaos] ${failures.length} CRITICAL failure(s):`);
    for (const f of failures) console.log(`  - ${f.name}: ${f.observation}`);
  }

  if (opts.report) {
    const ok = writeJsonReport(opts.report, report);
    console.log(`[chaos] report ${ok ? 'written to' : 'FAILED to write'} ${opts.report}`);
  }

  console.log(
    `\n[chaos] ${report.summary.result}: ${passed.length} ok, ${warnings.length} warning(s), ${failures.length} failure(s); ` +
    `canary ${canaryFinalOk ? 'stayed responsive' : 'was DISRUPTED'}; server ${serverFinalAlive ? 'alive' : 'DOWN'}.`,
  );

  return exitCode;
}

main()
  .then((code) => {
    cleanup();
    process.exit(code);
  })
  .catch((err) => {
    process.stderr.write(`[chaos] FATAL: ${(err && err.stack) || err}\n`);
    cleanup();
    process.exit(1);
  });
