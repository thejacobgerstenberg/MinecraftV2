#!/usr/bin/env node
/**
 * soak-test.mjs — long-run LEAK / STABILITY detector for the Voxelheim server.
 *
 * Dependency-free (Node builtins only). Target runtime: Node 20 (CI) / Node 22.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES
 * Holds a steady population of headless "bot" clients against a server for a long
 * window while continuously churning connections, then watches the server process
 * from /proc to decide whether it LEAKS. Three resource signals are sampled on a
 * fixed cadence straight out of /proc/<pid>:
 *
 *   RSS      /proc/<pid>/status  VmRSS (kB -> MB)   resident memory
 *   FD       /proc/<pid>/fd      directory entries  open file descriptors
 *   THREADS  /proc/<pid>/task    directory entries  OS threads
 *
 * The bots do NOT measure latency here (that is load-test.mjs' job). Their only
 * purpose is to keep the server BUSY and to exercise connection/fd/handle churn:
 *   - move  ~10 Hz   (bounded random walk; valid x/z, y in [1,120])
 *   - edit  ~1  /s   (place/break; valid ints, y in [1,120], block 1..40)
 *   - chat  ~0.2/s   (short text, server trims/caps)
 *   - churn ~every 15s a fraction of bots disconnect + reconnect, so sockets, fds
 *           and per-connection handles are constantly created and torn down —
 *           the classic shape that surfaces fd / handle / listener leaks.
 *
 * VERDICT
 * After a warmup (the LARGER of ~first 15% of samples and SOAK_WARMUP_SEC seconds —
 * V8/heap warmup is a roughly fixed wall-clock ramp, so a percentage alone under-drops
 * on short runs — dropped), a least-squares linear
 * regression is fit to RSS vs time over the DRAINED steady-state window. The
 * slope is reported in MB/min. The run is "flat" (healthy, exit 0) iff:
 *     NOT (|RSS slope| >= LEAK_RSS_MB_PER_MIN (default 5) AND the growth that slope
 *          IMPLIES over the sampled window >= LEAK_RSS_MIN_RISE_MB (default 12 MB)) AND
 *     fd_end <= fd_start + 8                                    AND
 *     no monotonic fd growth across the steady window
 * The RSS rise-floor exists because V8's resident set steps up ONCE (a few MB) as the
 * heap reaches its plateau and then holds flat; caught at the tail of a SHORT drained
 * window that one-time step yields a steep MB/min from only a few MB of real growth — a
 * warmup artifact, not a leak. Extrapolating MB/min from a sub-window that grew only a
 * few MB is not trustworthy, so a genuine RSS-leak verdict additionally requires the
 * implied growth to exceed a single heap-expansion step. On the canonical 1200s soak
 * (and any drained window >= ~LEAK_RSS_MIN_RISE_MB/threshold minutes) a real leak clears
 * the floor by a wide margin, so long runs are unaffected; the floor only bites on short
 * self-tests, where fd/thread growth stay the reliable, window-independent leak signals.
 * Otherwise it is "leaking" (exit 1) and the offending signal(s) — RSS, fd, and/or
 * threads — are named with their numbers. A thread count that climbs well past its
 * start also trips the leak verdict (a listener/timer/handle leak often shows there
 * before RSS does). A server that dies mid-run is a hard failure (exit 1).
 *
 * TARGET SELECTION (precedence, highest first):
 *   1. --server-cmd "<cmd>"  spawn an arbitrary server via shell (in --server-cwd),
 *                            poll its port, sample its pid (the REAL server).
 *   2. --spawn               spawn the bundled load/chaos reference mock
 *                            (scripts/mock-server.mjs); parse its READY line for the
 *                            resolved port; sample its pid.
 *   3. --url ws://host:port  target an already-running external server; sample the
 *                            pid given by --server-pid / SERVER_PID (else the leak
 *                            verdict is INCONCLUSIVE — /proc needs a pid).
 *   4. (nothing)             DEFAULT: same as --spawn — runs FOR REAL with no setup.
 *
 * CONFIG (CLI flag / env / default):
 *   --players <n>       SOAK_BOTS        30    concurrent bot clients
 *   --duration-sec <s>  SOAK_DURATION    240   sampling window (after ramp)
 *   --sample-ms <ms>    SOAK_SAMPLE_MS   3000  /proc sampling cadence
 *   (warmup floor)      SOAK_WARMUP_SEC  30    min wall-clock seconds dropped as warmup
 *   --churn / --no-churn SOAK_CHURN      on    reconnect a fraction of bots ~every 15s
 *   --url <ws-url>      GAME_URL         ""     target an external server
 *   --spawn                              off    spawn+target the bundled mock
 *   --server-cmd "<cmd>" GAME_SERVER_CMD ""     spawn an arbitrary server
 *   --server-cwd <dir>  GAME_SERVER_CWD  ""     cwd for the spawned --server-cmd
 *   --server-pid <pid>  SERVER_PID       0      /proc pid to sample (with --url)
 *   --report <path>     GAME_REPORT      ""     also write the JSON report here
 *   (client frame cap)  GAME_MAX_PAYLOAD 1MiB   wsConnect maxPayload
 *
 * THRESHOLDS (env-overridable):
 *   LEAK_RSS_MB_PER_MIN   5   MB/min  RSS regression-slope ceiling
 *   LEAK_RSS_MIN_RISE_MB  12  MB      min slope-IMPLIED growth over the sampled window
 *                                     before an RSS slope counts as a leak (rejects a
 *                                     one-time heap-expansion step on short windows)
 *   LEAK_FD_GROWTH        8   fds     tolerated fd_end - fd_start
 *   LEAK_THREAD_GROWTH    8   threads tolerated threads_end - threads_start
 *
 * DURATION NOTE: the canonical soak target is a 20-minute (1200s) run. This harness
 * NEVER silently caps the duration — whatever --duration-sec / SOAK_DURATION you
 * pass is exactly what runs, and the report states the actual seconds and how they
 * scale against the 1200s reference so a short CI self-test is honest about being short.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { wsConnect, OPEN } from './lib/ws-transport.mjs';
import { CAPS, encJoin, encMove, encEdit, encChat, decode, defaultUrl } from './lib/protocol.mjs';
import { parseArgs, envNum, nowMs, printReport, writeJsonReport, tokenizeCommand } from './lib/util.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MOCK_PATH = path.join(__dirname, 'mock-server.mjs');

/* =========================================================================
 * Behaviour constants (traffic shape — NOT policy; policy lives in thresholds).
 * ========================================================================= */
const MOVE_INTERVAL_MS = 100; // ~10 Hz movement
const EDIT_INTERVAL_MS = 1000; // ~1 edit/s
const CHAT_INTERVAL_MS = 5000; // ~0.2 chat/s
const CHURN_INTERVAL_MS = 15000; // reconnect a slice of bots ~every 15s
const CHURN_FRACTION = 0.25; // fraction of live bots recycled each churn tick
const RECONNECT_DELAY_MS = 250; // pause between churn-close and reconnect

const REFERENCE_SOAK_SEC = 1200; // canonical 20-minute soak target (for scaling note)
const WARMUP_FRACTION = 0.15; // drop this leading fraction of samples as warmup
const WARMUP_MIN_SEC_DEFAULT = 30; // ALSO drop at least this many wall-clock seconds (V8/heap warmup)
const MIN_STEADY_SAMPLES = 4; // never warmup-drop below this many samples for the regression

const HANDSHAKE_TIMEOUT_MS = 5000;
const WELCOME_TIMEOUT_MS = 5000;
const SERVER_START_TIMEOUT_MS = 15000;
const CLOSE_GRACE_MS = 400;

const WORLD_HALF = 128; // x,z random walk stays within [-128,128]
const Y_MIN = 10; // keep the vertical walk within a valid 1..120 band
const Y_MAX = 110;
const MAX_BLOCK_ID = 40; // Voxelheim MAX_BLOCK_ID; place uses 1..40
const V_MAX = 1.5; // per-axis velocity clamp for a smooth walk

/* =========================================================================
 * Small infrastructure helpers (pure; no shared state).
 * ========================================================================= */

/** Promise-based sleep. */
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Clamp v into [lo, hi]. */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Parse host/port out of a ws://|wss:// url (for TCP port polling). */
function wsHostPort(url) {
  const u = new URL(url);
  const secure = u.protocol === 'wss:';
  const host = u.hostname || '127.0.0.1';
  const port = u.port ? Number(u.port) : secure ? 443 : 80;
  return { host, port };
}

/** Echo a child's output to our stderr, one prefixed line at a time. */
function echoChild(tag, chunk) {
  let text;
  try {
    text = chunk.toString();
  } catch {
    return;
  }
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  for (const line of trimmed.split('\n')) {
    try {
      process.stderr.write(`${tag}${line}\n`);
    } catch {
      /* ignore console failures */
    }
  }
}

/** Resolve true once a TCP connect to host:port succeeds within `ms`, else false. */
function tryTcpConnect(host, port, ms) {
  return new Promise((resolve) => {
    let done = false;
    const sock = net.connect({ host, port });
    const to = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(false);
    }, ms);
    if (to.unref) to.unref();
    sock.once('connect', () => {
      if (done) return;
      done = true;
      clearTimeout(to);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(true);
    });
    sock.once('error', () => {
      if (done) return;
      done = true;
      clearTimeout(to);
      resolve(false);
    });
  });
}

/** Poll a TCP port until it accepts a connection or the deadline passes. */
async function waitForPort(url, timeoutMs) {
  let hp;
  try {
    hp = wsHostPort(url);
  } catch {
    return false;
  }
  const deadline = nowMs() + timeoutMs;
  while (nowMs() < deadline) {
    if (await tryTcpConnect(hp.host, hp.port, 500)) return true;
    await delay(200);
  }
  return false;
}

/**
 * Spawn the bundled reference mock server and resolve once it prints READY. We
 * inject GAME_PORT=0 (unless pinned) so the OS assigns an ephemeral port, and read
 * the resolved port out of the READY line.
 * @returns {Promise<{child:import('node:child_process').ChildProcess, url:string}>}
 */
function spawnMock() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (!env.GAME_PORT) env.GAME_PORT = '0';
    const child = spawn(process.execPath, [MOCK_PATH], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let buf = '';
    const to = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('mock server did not print READY in time'));
    }, SERVER_START_TIMEOUT_MS);
    if (to.unref) to.unref();

    child.stdout.on('data', (d) => {
      buf += d.toString();
      echoChild('[mock] ', d);
      const m = /MOCK-SERVER READY port=(\d+) path=(\S+)/.exec(buf);
      if (m && !settled) {
        settled = true;
        clearTimeout(to);
        const port = Number(m[1]);
        let p = m[2] || '/';
        if (p[0] !== '/') p = '/' + p;
        resolve({ child, url: `ws://127.0.0.1:${port}${p}` });
      }
    });
    child.stderr.on('data', (d) => echoChild('[mock:err] ', d));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      reject(err);
    });
    child.on('exit', (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      reject(new Error(`mock server exited before READY (code=${code} sig=${sig})`));
    });
  });
}

/**
 * Spawn an arbitrary server command and wait for its port to open. The command is
 * tokenized into argv and spawned WITHOUT a shell, so child.pid is the real program
 * (e.g. the `node` process) rather than a `/bin/sh -c` wrapper — the /proc sampler
 * then reads the server's true RSS/fd/threads instead of the ~1-2 MB shell stub.
 * @returns {Promise<{child:import('node:child_process').ChildProcess, url:string}>}
 */
async function spawnServerCmd(cmd, url, cwd = '') {
  const argv = tokenizeCommand(cmd);
  if (argv.length === 0) throw new Error(`empty --server-cmd: ${JSON.stringify(cmd)}`);
  const child = spawn(argv[0], argv.slice(1), {
    cwd: cwd || undefined,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => echoChild('[server] ', d));
  child.stderr.on('data', (d) => echoChild('[server:err] ', d));

  let died = null;
  child.on('exit', (code, sig) => {
    died = `server-cmd exited before its port opened (code=${code} sig=${sig})`;
  });

  const ready = await waitForPort(url, SERVER_START_TIMEOUT_MS);
  if (died) throw new Error(died);
  if (!ready) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    throw new Error(`server-cmd port never opened: ${url}`);
  }
  return { child, url };
}

/* =========================================================================
 * /proc samplers (Linux). Each returns a number or null (never throws).
 * ========================================================================= */

/** Resident set size in MB from /proc/<pid>/status VmRSS, or null. */
function readRssMB(pid) {
  try {
    const data = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = data.match(/VmRSS:\s+(\d+)\s*kB/i);
    if (!m) return null;
    const kb = Number(m[1]);
    return Number.isFinite(kb) ? kb / 1024 : null;
  } catch {
    return null;
  }
}

/** Count of open file descriptors from /proc/<pid>/fd, or null. */
function countFds(pid) {
  try {
    return fs.readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    return null;
  }
}

/** Count of OS threads from /proc/<pid>/task, or null. */
function countThreads(pid) {
  try {
    return fs.readdirSync(`/proc/${pid}/task`).length;
  } catch {
    return null;
  }
}

/* =========================================================================
 * Numeric helpers for the verdict.
 * ========================================================================= */

/**
 * Least-squares linear regression over [{x,y}]. Returns {slope, intercept}. A
 * degenerate x-spread (all-equal x, or <2 points) yields slope 0.
 */
function linreg(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: n ? points[0].y : 0 };
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
    sxy += p.x * p.y;
    sxx += p.x * p.x;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

function minOf(arr) {
  let m = Infinity;
  for (const v of arr) if (v < m) m = v;
  return m === Infinity ? null : m;
}
function maxOf(arr) {
  let m = -Infinity;
  for (const v of arr) if (v > m) m = v;
  return m === -Infinity ? null : m;
}
function meanOf(arr) {
  if (!arr.length) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}
function round2(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/* =========================================================================
 * MAIN
 * ========================================================================= */
export async function main(argv = process.argv.slice(2)) {
  /* ---- config ------------------------------------------------------------ */
  const { opts } = parseArgs(argv, {
    players: { default: 30, env: 'SOAK_BOTS', type: 'number' },
    'duration-sec': { default: 240, env: 'SOAK_DURATION', type: 'number' },
    'sample-ms': { default: 3000, env: 'SOAK_SAMPLE_MS', type: 'number' },
    churn: { default: true, env: 'SOAK_CHURN', type: 'boolean' },
    url: { default: '', env: 'GAME_URL', type: 'string' },
    spawn: { default: false, type: 'boolean' },
    'server-cmd': { default: '', env: 'GAME_SERVER_CMD', type: 'string' },
    'server-cwd': { default: '', env: 'GAME_SERVER_CWD', type: 'string' },
    'server-pid': { default: 0, env: 'SERVER_PID', type: 'number' },
    report: { default: '', env: 'GAME_REPORT', type: 'string' },
  });

  const players = Math.max(1, Math.floor(opts.players) || 1);
  const durationSec = Math.max(1, Math.floor(opts.durationSec) || 1);
  const durationMs = durationSec * 1000;
  const sampleMs = Math.max(250, Math.floor(opts.sampleMs) || 3000);
  const churnEnabled = !!opts.churn;
  const urlOpt = String(opts.url || '').trim();
  const serverCmd = String(opts.serverCmd || '').trim();
  const serverCwd = String(opts.serverCwd || '').trim();
  const serverPidOpt = Math.max(0, Math.floor(Number(opts.serverPid) || 0));
  const spawnFlag = !!opts.spawn;
  const reportPath = String(opts.report || '').trim();
  const clientMaxPayload = envNum('GAME_MAX_PAYLOAD', 1 << 20);

  const thresholds = {
    LEAK_RSS_MB_PER_MIN: envNum('LEAK_RSS_MB_PER_MIN', 5),
    LEAK_RSS_MIN_RISE_MB: envNum('LEAK_RSS_MIN_RISE_MB', 12),
    LEAK_FD_GROWTH: envNum('LEAK_FD_GROWTH', 8),
    LEAK_THREAD_GROWTH: envNum('LEAK_THREAD_GROWTH', 8),
  };

  // Absolute warmup floor (seconds). V8/heap warmup is a roughly fixed wall-clock
  // ramp to a plateau, so the percentage warmup alone under-drops on short runs.
  const warmupMinSec = Math.max(0, envNum('SOAK_WARMUP_SEC', WARMUP_MIN_SEC_DEFAULT));

  // Ramp: stagger connects across up to ~5s so we don't thundering-herd the server.
  const rampMs = Math.min(5000, players * 50);

  // Resolve target mode (precedence documented in the header).
  let mode; // 'server-cmd' | 'spawn-mock' | 'url'
  if (serverCmd) mode = 'server-cmd';
  else if (spawnFlag) mode = 'spawn-mock';
  else if (urlOpt) mode = 'url';
  else mode = 'spawn-mock';

  /* ---- bring the target server up --------------------------------------- */
  let child = null;
  let targetUrl = urlOpt || defaultUrl();
  let samplePid = null;

  try {
    if (mode === 'spawn-mock') {
      const r = await spawnMock();
      child = r.child;
      targetUrl = r.url;
    } else if (mode === 'server-cmd') {
      const r = await spawnServerCmd(serverCmd, urlOpt || defaultUrl(), serverCwd);
      child = r.child;
      targetUrl = r.url;
    } else {
      targetUrl = urlOpt;
      const up = await waitForPort(targetUrl, 3000);
      if (!up) {
        process.stderr.write(
          `[soak] warning: ${targetUrl} not reachable yet; bots will attempt anyway\n`
        );
      }
    }
  } catch (err) {
    process.stderr.write(`[soak] failed to start target server: ${err && err.message}\n`);
    const report = {
      mode,
      url: targetUrl,
      error: `server-start-failed: ${err && err.message}`,
      verdict: { verdict: 'error', pass: false, reasons: ['server failed to start'] },
    };
    printReport('SOAK TEST — FAILED TO START', report);
    if (reportPath) writeJsonReport(reportPath, report);
    process.exit(1);
    return;
  }

  // pid to sample: a process we spawned, else --server-pid / SERVER_PID for --url.
  if (child) samplePid = child.pid;
  else if (serverPidOpt > 0) samplePid = serverPidOpt;

  /* ---- shared state ------------------------------------------------------ */
  const bots = [];
  let stopping = false;
  let serverDied = false;
  let intentionalKill = false;

  const counters = {
    connectAttempts: 0,
    connectFailures: 0,
    welcomes: 0,
    reconnects: 0,
    socketErrors: 0,
    unexpectedCloses: 0,
    movesSent: 0,
    editsSent: 0,
    chatsSent: 0,
    messagesReceived: 0,
    errorsReceived: 0,
  };

  // /proc time series (samples with a readable RSS).
  const series = []; // {tMs, rss, fd, threads}
  const t0 = nowMs();

  // Watch a spawned server for premature death.
  if (child) {
    child.on('exit', (code, sig) => {
      if (intentionalKill || stopping) return;
      serverDied = true;
      process.stderr.write(`[soak] server process died mid-test (code=${code} sig=${sig})\n`);
      finish('server-died');
    });
  }

  process.stderr.write(
    `[soak] target=${targetUrl} mode=${mode} players=${players} duration=${durationSec}s ` +
      `sample=${sampleMs}ms churn=${churnEnabled ? 'on' : 'off'} pid=${samplePid || 'n/a'}\n`
  );

  /* ---- per-bot traffic generators --------------------------------------- */

  function stepWalk(bot) {
    bot.vel.x = clamp(bot.vel.x + (Math.random() - 0.5) * 0.6, -V_MAX, V_MAX);
    bot.vel.y = clamp(bot.vel.y + (Math.random() - 0.5) * 0.3, -V_MAX, V_MAX);
    bot.vel.z = clamp(bot.vel.z + (Math.random() - 0.5) * 0.6, -V_MAX, V_MAX);
    for (const axis of ['x', 'z']) {
      let np = bot.pos[axis] + bot.vel[axis];
      if (np > WORLD_HALF) {
        np = WORLD_HALF;
        bot.vel[axis] = -bot.vel[axis];
      } else if (np < -WORLD_HALF) {
        np = -WORLD_HALF;
        bot.vel[axis] = -bot.vel[axis];
      }
      bot.pos[axis] = np;
    }
    let ny = bot.pos.y + bot.vel.y;
    if (ny > Y_MAX) {
      ny = Y_MAX;
      bot.vel.y = -bot.vel.y;
    } else if (ny < Y_MIN) {
      ny = Y_MIN;
      bot.vel.y = -bot.vel.y;
    }
    bot.pos.y = ny;
    bot.yaw = (bot.yaw + (Math.random() - 0.5) * 10 + 360) % 360;
  }

  function sendMove(bot) {
    const conn = bot.conn;
    if (!conn || conn.readyState !== OPEN) return;
    bot.seq += 1;
    stepWalk(bot);
    const ok = conn.send(encMove({ seq: bot.seq, pos: bot.pos, yaw: bot.yaw, dim: CAPS.dim }));
    if (ok !== false) counters.movesSent++;
  }

  function sendEdit(bot) {
    const conn = bot.conn;
    if (!conn || conn.readyState !== OPEN) return;
    const action = Math.random() < 0.5 ? 'place' : 'break';
    const pos = {
      x: Math.round(bot.pos.x),
      y: clamp(Math.round(bot.pos.y), 1, 120), // valid range 1..120
      z: Math.round(bot.pos.z),
    };
    const block = 1 + Math.floor(Math.random() * MAX_BLOCK_ID); // 1..40 (place)
    const ok = conn.send(encEdit({ action, pos, block, dim: CAPS.dim }));
    if (ok !== false) counters.editsSent++;
  }

  function sendChat(bot) {
    const conn = bot.conn;
    if (!conn || conn.readyState !== OPEN) return;
    bot.chatSeq += 1;
    const ok = conn.send(encChat({ text: `soak ${bot.i}:${bot.chatSeq}` }));
    if (ok !== false) counters.chatsSent++;
  }

  function startBotLoops(bot) {
    bot.timers.push(setInterval(() => sendMove(bot), MOVE_INTERVAL_MS));
    bot.timers.push(setInterval(() => sendEdit(bot), EDIT_INTERVAL_MS));
    bot.timers.push(setInterval(() => sendChat(bot), CHAT_INTERVAL_MS));
  }

  function clearBotTimers(bot) {
    for (const t of bot.timers) clearInterval(t);
    bot.timers = [];
  }

  /* ---- bot lifecycle ----------------------------------------------------- */

  function makeBot(i) {
    return {
      i,
      conn: null,
      serverId: undefined,
      key: null,
      seq: 0,
      chatSeq: 0,
      pos: {
        x: (Math.random() - 0.5) * 32,
        y: (Y_MIN + Y_MAX) / 2,
        z: (Math.random() - 0.5) * 32,
      },
      vel: { x: 0, y: 0, z: 0 },
      yaw: Math.random() * 360,
      timers: [],
      welcomed: false,
      active: false, // true between welcome and (intentional or unexpected) close
      churning: false, // set true across an intentional churn close+reconnect
      _welcomeResolve: null,
    };
  }

  function onMessage(bot, data) {
    counters.messagesReceived++;
    let msg;
    try {
      msg = decode(data);
    } catch {
      return;
    }
    if (msg.kind === 'welcome') {
      if (bot.welcomed) return;
      bot.welcomed = true;
      bot.serverId = msg.id;
      bot.key = msg.id === undefined || msg.id === null ? null : String(msg.id);
      counters.welcomes++;
      if (typeof bot._welcomeResolve === 'function') {
        const r = bot._welcomeResolve;
        bot._welcomeResolve = null;
        r(true);
      }
    } else if (msg.kind === 'error') {
      counters.errorsReceived++;
    }
  }

  /** Open a connection for `bot`, join, and start its traffic loops. Never throws. */
  async function connectBot(bot) {
    if (stopping) return;
    counters.connectAttempts++;
    bot.welcomed = false;
    bot.serverId = undefined;
    bot.key = null;

    let conn;
    try {
      conn = await wsConnect(targetUrl, {
        maxPayload: clientMaxPayload,
        handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      });
    } catch {
      counters.connectFailures++;
      return;
    }
    if (stopping) {
      try {
        conn.close(1000);
      } catch {
        /* ignore */
      }
      return;
    }

    bot.conn = conn;
    conn.on('message', (data) => onMessage(bot, data));
    conn.on('error', () => {
      if (stopping || bot.churning || !bot.active) return;
      counters.socketErrors++;
    });
    conn.on('close', () => {
      clearBotTimers(bot);
      const wasActive = bot.active;
      bot.active = false;
      bot.conn = null;
      // A close we did NOT initiate (not churn, not teardown) is a stability signal.
      if (!stopping && !bot.churning && wasActive) counters.unexpectedCloses++;
    });

    const welcome = new Promise((resolve) => {
      bot._welcomeResolve = resolve;
      const to = setTimeout(() => {
        if (bot._welcomeResolve) {
          bot._welcomeResolve = null;
          resolve(false);
        }
      }, WELCOME_TIMEOUT_MS);
      if (to.unref) to.unref();
    });

    try {
      conn.send(encJoin({ name: `soak${bot.i}`, dim: CAPS.dim }));
    } catch {
      counters.connectFailures++;
      try {
        conn.close(1000);
      } catch {
        /* ignore */
      }
      return;
    }

    const ok = await welcome;
    if (!ok || stopping) {
      if (!ok) counters.connectFailures++;
      try {
        conn.close(1000);
      } catch {
        /* ignore */
      }
      return;
    }

    bot.active = true;
    startBotLoops(bot);
  }

  /** Intentionally recycle one bot's connection (drives fd / handle churn). */
  async function recycleBot(bot) {
    if (stopping) return;
    bot.churning = true;
    clearBotTimers(bot);
    if (bot.conn) {
      try {
        bot.conn.close(1000);
      } catch {
        /* ignore */
      }
    }
    bot.conn = null;
    bot.active = false;
    await delay(RECONNECT_DELAY_MS);
    if (stopping) {
      bot.churning = false;
      return;
    }
    counters.reconnects++;
    await connectBot(bot);
    bot.churning = false;
  }

  async function runBot(i) {
    const bot = makeBot(i);
    bots.push(bot);
    const offset = Math.floor((i / players) * rampMs);
    await delay(offset);
    if (stopping) return;
    await connectBot(bot);
  }

  /* ---- churn driver ------------------------------------------------------ */
  let churnTimer = null;
  function startChurn() {
    if (!churnEnabled) return;
    churnTimer = setInterval(() => {
      if (stopping) return;
      const live = bots.filter((b) => b.active && !b.churning);
      if (!live.length) return;
      const k = Math.max(1, Math.round(live.length * CHURN_FRACTION));
      // Shuffle-pick k distinct live bots.
      for (let n = live.length - 1; n > 0; n--) {
        const j = Math.floor(Math.random() * (n + 1));
        const tmp = live[n];
        live[n] = live[j];
        live[j] = tmp;
      }
      for (let n = 0; n < k; n++) {
        recycleBot(live[n]).catch(() => {
          /* recycleBot is defensive */
        });
      }
    }, CHURN_INTERVAL_MS);
    if (churnTimer.unref) churnTimer.unref();
  }

  /* ---- /proc sampler ----------------------------------------------------- */
  let sampleTimer = null;
  function takeSample() {
    if (!samplePid) return;
    const rss = readRssMB(samplePid);
    if (rss === null) return; // pid gone / non-Linux / unreadable — skip this tick
    series.push({
      tMs: nowMs() - t0,
      rss,
      fd: countFds(samplePid),
      threads: countThreads(samplePid),
    });
  }
  function startSampling() {
    if (!samplePid) return;
    takeSample(); // prime with an immediate sample
    sampleTimer = setInterval(takeSample, sampleMs);
    if (sampleTimer.unref) sampleTimer.unref();
  }

  /* ---- verdict ----------------------------------------------------------- */
  function computeVerdict() {
    const samplingAvailable = !!samplePid;
    const total = series.length;

    // Not enough signal to judge -> inconclusive (not a failure).
    if (!samplingAvailable || total < 4) {
      return {
        verdict: 'inconclusive',
        pass: true,
        reasons: [
          !samplingAvailable
            ? 'no server pid to sample (external --url without --server-pid/SERVER_PID); /proc leak verdict unavailable'
            : `too few /proc samples (${total}); need >= 4 for a regression — run longer or lower --sample-ms`,
        ],
        samples: { total, steady: 0 },
      };
    }

    // Drop the leading warmup ramp, then regress over the drained steady window.
    // A percentage alone is wrong for SHORT runs: V8/heap warmup is a roughly FIXED
    // wall-clock ramp (tens of seconds) to a plateau, so on a short run 15% is only a
    // few seconds and leaves the ramp inside the "steady" window, reading as a false
    // positive RSS slope. Drop the LARGER of the fraction and an absolute
    // warmup-seconds floor — but never so much that fewer than MIN_STEADY_SAMPLES
    // remain to fit a meaningful regression. On the canonical 1200s soak the fraction
    // (180s) dominates, so long-run behaviour is unchanged; the floor only bites on
    // short CI self-tests, exactly where the ramp would otherwise dominate.
    const warmupByFraction = Math.floor(total * WARMUP_FRACTION);
    const warmupBySeconds = Math.ceil((warmupMinSec * 1000) / sampleMs);
    const warmupCap = Math.max(0, total - MIN_STEADY_SAMPLES);
    const warmup = Math.min(Math.max(warmupByFraction, warmupBySeconds), warmupCap);
    const steady = series.slice(warmup);
    const rssArr = steady.map((s) => s.rss);
    const fdArr = steady.map((s) => s.fd).filter((v) => v !== null && v !== undefined);
    const thrArr = steady.map((s) => s.threads).filter((v) => v !== null && v !== undefined);

    // RSS regression: x in MINUTES relative to the steady window start.
    const baseMs = steady[0].tMs;
    const slope = linreg(steady.map((s) => ({ x: (s.tMs - baseMs) / 60000, y: s.rss }))).slope; // MB/min

    // Wall-clock span of the drained window (minutes) and the absolute RSS growth
    // the slope IMPLIES across it. A steep MB/min extrapolated from a tiny observed
    // growth is not trustworthy — see the rss-rise gate below.
    const steadyWindowMin =
      steady.length >= 2 ? (steady[steady.length - 1].tMs - steady[0].tMs) / 60000 : 0;
    const impliedRiseMB = Math.abs(slope) * steadyWindowMin;

    const rssStart = rssArr[0];
    const rssEnd = rssArr[rssArr.length - 1];
    const rssPeak = maxOf(series.map((s) => s.rss)); // peak over the WHOLE run
    const rssMean = meanOf(rssArr);

    const fdStart = fdArr.length ? fdArr[0] : null;
    const fdEnd = fdArr.length ? fdArr[fdArr.length - 1] : null;
    const fdPeak = fdArr.length ? maxOf(series.map((s) => s.fd).filter((v) => v != null)) : null;

    const thrStart = thrArr.length ? thrArr[0] : null;
    const thrEnd = thrArr.length ? thrArr[thrArr.length - 1] : null;

    // Monotonic fd growth: fds never step DOWN across the steady window AND end up
    // higher than they started — the shape of a genuine fd/handle leak.
    let fdDecreases = 0;
    let fdIncreases = 0;
    for (let n = 1; n < fdArr.length; n++) {
      if (fdArr[n] > fdArr[n - 1]) fdIncreases++;
      else if (fdArr[n] < fdArr[n - 1]) fdDecreases++;
    }
    const monotonicFdGrowth = fdArr.length >= 3 && fdDecreases === 0 && fdEnd > fdStart;

    // ---- signal evaluation ------------------------------------------------
    const reasons = [];
    const signals = [];

    // RSS-leak criterion. The slope alone is not enough on SHORT windows: V8's
    // resident set steps up ONCE (a few MB) as the heap reaches its working-set
    // plateau, then holds flat. Caught at the tail of a short drained window that
    // one-time expansion produces a steep MB/min from only a few MB of real growth —
    // a warmup artifact, not a sustained leak. So require the growth the slope
    // IMPLIES over the sampled window to clear an absolute floor (larger than a single
    // heap-expansion step) before trusting an RSS-leak verdict. On the canonical 1200s
    // soak — or any drained window >= ~LEAK_RSS_MIN_RISE_MB/threshold minutes — a real
    // leak clears the floor by a wide margin, so long runs are unchanged; the floor only
    // suppresses the short-self-test false positive, where fd/thread growth remain the
    // reliable, window-length-independent leak signals.
    const rssSlopeExceeds = Math.abs(slope) >= thresholds.LEAK_RSS_MB_PER_MIN;
    const rssRiseMeaningful = impliedRiseMB >= thresholds.LEAK_RSS_MIN_RISE_MB;
    const rssLeak = rssSlopeExceeds && rssRiseMeaningful;
    if (rssLeak) {
      signals.push('RSS');
      reasons.push(
        `RSS slope ${slope.toFixed(2)} MB/min over ${steadyWindowMin.toFixed(2)} min ` +
          `=> ${impliedRiseMB.toFixed(1)} MB implied growth ` +
          `(|slope| >= LEAK_RSS_MB_PER_MIN ${thresholds.LEAK_RSS_MB_PER_MIN} AND ` +
          `rise >= LEAK_RSS_MIN_RISE_MB ${thresholds.LEAK_RSS_MIN_RISE_MB})`
      );
    } else if (rssSlopeExceeds) {
      reasons.push(
        `RSS slope ${slope.toFixed(2)} MB/min exceeds ${thresholds.LEAK_RSS_MB_PER_MIN} but implies only ` +
          `${impliedRiseMB.toFixed(1)} MB growth over ${steadyWindowMin.toFixed(2)} min ` +
          `(< LEAK_RSS_MIN_RISE_MB ${thresholds.LEAK_RSS_MIN_RISE_MB}): one-time heap-expansion / ` +
          `short-window artifact, not a sustained leak — RSS signal inconclusive, using fd/thread`
      );
    }

    const fdGrew = fdStart !== null && fdEnd !== null && fdEnd > fdStart + thresholds.LEAK_FD_GROWTH;
    const fdLeak = fdGrew || monotonicFdGrowth;
    if (fdLeak) {
      signals.push('fd');
      if (fdGrew) {
        reasons.push(
          `fd grew ${fdStart} -> ${fdEnd} (> start + LEAK_FD_GROWTH ${thresholds.LEAK_FD_GROWTH})`
        );
      }
      if (monotonicFdGrowth) {
        reasons.push(`fd count grew monotonically (${fdStart} -> ${fdEnd}, no reclaim)`);
      }
    }

    const thrLeak =
      thrStart !== null && thrEnd !== null && thrEnd > thrStart + thresholds.LEAK_THREAD_GROWTH;
    if (thrLeak) {
      signals.push('threads');
      reasons.push(
        `threads grew ${thrStart} -> ${thrEnd} (> start + LEAK_THREAD_GROWTH ${thresholds.LEAK_THREAD_GROWTH})`
      );
    }

    const leaking = rssLeak || fdLeak || thrLeak;
    if (!leaking) {
      const rssNote = rssSlopeExceeds
        ? `RSS slope ${slope.toFixed(2)} MB/min but only ${impliedRiseMB.toFixed(1)} MB implied growth ` +
          `over ${steadyWindowMin.toFixed(2)} min (< LEAK_RSS_MIN_RISE_MB ${thresholds.LEAK_RSS_MIN_RISE_MB})`
        : `RSS slope ${slope.toFixed(2)} MB/min within +/-${thresholds.LEAK_RSS_MB_PER_MIN}`;
      reasons.push(`${rssNote}; fd ${fdStart} -> ${fdEnd}; threads ${thrStart} -> ${thrEnd}`);
    }

    return {
      verdict: leaking ? 'leaking' : 'flat',
      pass: !leaking,
      signals,
      reasons,
      slopeMbPerMin: round2(slope),
      impliedRiseMB: round2(impliedRiseMB),
      steadyWindowMin: round2(steadyWindowMin),
      rssRiseFloorMB: thresholds.LEAK_RSS_MIN_RISE_MB,
      rss: {
        startMB: round2(rssStart),
        endMB: round2(rssEnd),
        peakMB: round2(rssPeak),
        meanMB: round2(rssMean),
      },
      fd: {
        start: fdStart,
        end: fdEnd,
        peak: fdPeak,
        monotonicGrowth: monotonicFdGrowth,
        increases: fdIncreases,
        decreases: fdDecreases,
      },
      threads: { start: thrStart, end: thrEnd },
      samples: { total, warmupDropped: warmup, steady: steady.length },
    };
  }

  /* ---- teardown + report ------------------------------------------------- */
  let finishing = false;
  let finishResolve;
  const finished = new Promise((res) => {
    finishResolve = res;
  });
  let exitCode = 0;
  let finishTimer = null;

  async function finish(reason) {
    if (finishing) return;
    finishing = true;
    stopping = true;
    if (finishTimer) clearTimeout(finishTimer);
    if (churnTimer) clearInterval(churnTimer);
    if (sampleTimer) clearInterval(sampleTimer);

    // Take one last sample before we tear anything down (best-effort).
    takeSample();

    // Stop all bot traffic + close connections.
    for (const b of bots) {
      clearBotTimers(b);
      b.active = false;
      if (b.conn) {
        try {
          b.conn.close(1000);
        } catch {
          /* ignore */
        }
      }
    }
    await delay(CLOSE_GRACE_MS);

    const verdict = computeVerdict();

    // A dead server or an interrupt is a hard failure regardless of the leak math.
    const hardFail = [];
    if (serverDied) hardFail.push('server process died during the soak (crash / S0)');
    if (reason === 'signal') hardFail.push('interrupted before completion');

    const pass = hardFail.length === 0 && verdict.pass;
    exitCode = pass ? 0 : 1;

    const scaleNote =
      `duration ${durationSec}s = ${((durationSec / REFERENCE_SOAK_SEC) * 100).toFixed(1)}% of the ` +
      `${REFERENCE_SOAK_SEC}s (20-min) soak reference; the requested seconds run in full — no silent cap`;

    const report = {
      config: {
        mode,
        url: targetUrl,
        players,
        durationSec,
        referenceSoakSec: REFERENCE_SOAK_SEC,
        durationNote: scaleNote,
        sampleMs,
        churn: churnEnabled,
        serverCwd: serverCwd || null,
        pid: samplePid || null,
      },
      thresholds,
      connections: {
        attempts: counters.connectAttempts,
        welcomes: counters.welcomes,
        connectFailures: counters.connectFailures,
        reconnects: counters.reconnects,
        socketErrors: counters.socketErrors,
        unexpectedCloses: counters.unexpectedCloses,
      },
      traffic: {
        movesSent: counters.movesSent,
        editsSent: counters.editsSent,
        chatsSent: counters.chatsSent,
        messagesReceived: counters.messagesReceived,
        errorsReceived: counters.errorsReceived,
      },
      leak: verdict,
      results: {
        pass,
        exitCode,
        reason,
        verdict: verdict.verdict,
        hardFail,
      },
    };

    printReport(pass ? 'SOAK TEST — FLAT (PASS)' : 'SOAK TEST — FAIL', report);
    process.stderr.write(`[soak] ${scaleNote}\n`);
    if (reportPath) {
      const wrote = writeJsonReport(reportPath, report);
      process.stderr.write(
        `[soak] JSON report ${wrote ? 'written to' : 'FAILED to write'}: ${reportPath}\n`
      );
    }

    killChild();
    finishResolve();
  }

  function killChild() {
    if (!child) return;
    intentionalKill = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    const hard = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 2000);
    if (hard.unref) hard.unref();
  }

  /* ---- signal / crash safety nets --------------------------------------- */
  const onSignal = (sig) => {
    process.stderr.write(`[soak] received ${sig}; shutting down\n`);
    finish('signal').then(() => process.exit(exitCode || 1));
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[soak] uncaughtException: ${err && err.stack ? err.stack : err}\n`);
    killChild();
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`[soak] unhandledRejection: ${err}\n`);
  });
  process.on('exit', () => {
    if (child) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  });

  /* ---- run --------------------------------------------------------------- */
  for (let i = 0; i < players; i++) {
    runBot(i).catch(() => {
      /* runBot is already defensive */
    });
  }
  startSampling();
  startChurn();

  // End the sampling window after ramp + duration.
  finishTimer = setTimeout(() => finish('duration-elapsed'), rampMs + durationMs);

  await finished;
  process.exit(exitCode);
}

/* =========================================================================
 * Entry point (only when run directly, so importing for tests is side-effect free).
 * ========================================================================= */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[soak] fatal: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}

/* ---------------------------------------------------------------------------
 * SELF-CHECK (informal — no test framework, dependency-free):
 *   node scripts/soak-test.mjs --spawn --duration-sec 45 --sample-ms 1500
 *        # spawns the mock, 30 bots churn+move+edit+chat, samples /proc,
 *        # fits RSS-vs-time regression -> "flat" -> exit 0
 *   node scripts/soak-test.mjs --spawn --players 10 --duration-sec 20 --no-churn
 *        # same, without connection churn
 *   LEAK_RSS_MB_PER_MIN=0 LEAK_RSS_MIN_RISE_MB=0 node scripts/soak-test.mjs --spawn --duration-sec 20
 *        # drops BOTH RSS gates so any positive slope reads as "leaking" -> exit 1
 *        # (verdict test; the rise floor must be 0 too or a few-MB warmup step is ignored)
 *   node scripts/soak-test.mjs --url ws://127.0.0.1:3000/ws --server-pid 12345
 *        # soak an external server, sampling its /proc pid
 *   node scripts/soak-test.mjs --server-cmd "node server/index.js" \
 *        --server-cwd /path/to/voxelheim --url ws://127.0.0.1:3000/ws
 * VERDICT: least-squares slope of RSS vs time (MB/min) over the drained steady
 * window (warmup = max(first ~15%, SOAK_WARMUP_SEC seconds) dropped); "flat" iff
 * NOT (|slope| >= LEAK_RSS_MB_PER_MIN AND slope-implied growth over the window >=
 * LEAK_RSS_MIN_RISE_MB — the floor rejects a one-time heap-expansion step on short
 * windows) AND fd_end <= fd_start + LEAK_FD_GROWTH AND no monotonic fd growth; else
 * "leaking", naming RSS/fd/threads. Duration is never silently capped (scaled vs 1200s).
 * Always kills a spawned server (SIGTERM + SIGKILL guarantees on exit).
 * ------------------------------------------------------------------------- */
