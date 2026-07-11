#!/usr/bin/env node
/**
 * load-test.mjs — headless multiplayer LOAD harness.
 *
 * Dependency-free (Node builtins only). Target runtime: Node 20 (CI) / Node 22.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES
 * Spins up N headless "bot" clients that speak the assumed game protocol
 * (scripts/lib/protocol.mjs) over the dependency-free WebSocket transport
 * (scripts/lib/ws-transport.mjs), drives realistic traffic against a server,
 * and measures how the server holds up under concurrent load:
 *
 *   (a) RTT              chat self-echo round-trip: a bot sends chat carrying its
 *                        own {botIdx,seq,sendMs}; the server echoes chat to the
 *                        WHOLE room incl. the sender, so RTT = recv - sendMs
 *                        (matchRttEcho, its OWN echo only)         -> p50/p95/p99/max
 *   (b) PROPAGATION      time from a bot sending move#seq (seq smuggled in the
 *                        forwarded `pitch` field) until that move is first
 *                        re-broadcast to ANOTHER same-dim bot      -> p50/p95/p99/max
 *   (c) DROPS / OOO      per receiver, per source (readMoveSeq on forwarded moves):
 *                        skipped seq ranges = drops, decreasing seq =
 *                        out-of-order                              -> %of expected updates
 *   (d) SERVER CPU/MEM   sampled from /proc for a server WE spawned OR an
 *                        externally-started --server-pid; n/a for a bare --url
 *                        with no pid to sample
 *   (e) CONN ERRORS      failed connects, unexpected mid-test closes, socket errors
 *
 * Thresholds gate the process exit code so this doubles as a CI check.
 *
 * TARGET SELECTION (precedence, highest first):
 *   1. --server-cmd "<cmd>"  spawn an arbitrary server via shell (in --server-cwd
 *                            if given), poll its port, sample its pid, then target
 *                            --url|GAME_URL|defaultUrl().
 *   2. --spawn               spawn the bundled reference mock (scripts/mock-server.mjs),
 *                            parse its READY line for the real port, sample its pid.
 *   3. --url ws://host:port  target an already-running external server (no sampling).
 *   4. (nothing)             DEFAULT: same as --spawn (mock) — so the harness runs
 *                            FOR REAL today with zero external setup.
 *
 * CONFIG (CLI flag / env / default):
 *   --players <n>        GAME_BOTS        50    concurrent bot clients
 *   --duration-sec <s>   GAME_DURATION    30    active-load window (after ~2s ramp)
 *   --url <ws-url>       GAME_URL         ""    target an external server
 *   --spawn                               off   spawn+target the bundled mock
 *   --server-cmd "<cmd>" GAME_SERVER_CMD  ""    spawn an arbitrary server
 *   --server-cwd <dir>   GAME_SERVER_CWD  ""    cwd for the spawned --server-cmd
 *   --server-pid <pid>   SERVER_PID       0     sample CPU/mem of an external server
 *                                               (use with --url; we did not spawn it)
 *   --report <path>      GAME_REPORT      ""    also write the JSON report here
 *   (client frame cap)   GAME_MAX_PAYLOAD 1MiB  wsConnect maxPayload
 *
 * THRESHOLDS (env-overridable; DEFAULTS shown). A breach OR a dead server OR any
 * bot failing to connect => exit 1; otherwise exit 0. P95_MS/P99_MS gate the RTT
 * histogram (the cleanest latency signal); propagation p95/p99 are reported too.
 *   P95_MS          150   ms   RTT p95 ceiling
 *   P99_MS          300   ms   RTT p99 ceiling
 *   DROP_PCT        1     %    dropped-update ceiling
 *   OOO_PCT         1     %    out-of-order ceiling
 *   MAX_CONN_ERRORS 0     n    tolerated socket errors + unexpected closes
 *
 * The harness is protocol-agnostic: it only ever calls the encoders / decode /
 * correlation helpers (readMoveSeq, matchRttEcho) and CAPS exported by
 * protocol.mjs, so retargeting the real server is a one-file edit there.
 * ---------------------------------------------------------------------------
 */

import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { wsConnect, OPEN } from './lib/ws-transport.mjs';
import {
  CAPS,
  encJoin,
  encMove,
  encBlock,
  encRttChat,
  decode,
  readMoveSeq,
  matchRttEcho,
  defaultUrl,
} from './lib/protocol.mjs';
import {
  parseArgs,
  envNum,
  Stats,
  startProcSampler,
  nowMs,
  printReport,
  writeJsonReport,
} from './lib/util.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MOCK_PATH = path.join(__dirname, 'mock-server.mjs');

/* =========================================================================
 * Tunable constants (behaviour, not policy — policy lives in the thresholds).
 * ========================================================================= */
const RAMP_MS = 2000; // stagger connects across ~2s to avoid a thundering herd
const MOVE_INTERVAL_MS = Math.round(1000 / 15); // ~15 Hz movement (pitch carries seq)
const BLOCK_INTERVAL_MS = 2000; // a block edit every ~2s
const RTT_CHAT_INTERVAL_MS = 1000; // one RTT self-echo chat every ~1s
const HANDSHAKE_TIMEOUT_MS = 5000; // ws opening-handshake budget
const WELCOME_TIMEOUT_MS = 5000; // join -> welcome budget
const SERVER_START_TIMEOUT_MS = 15000; // spawn -> READY / port-open budget
const CLOSE_GRACE_MS = 400; // let close frames flush before we compute the report
const BACKPRESSURE_LIMIT = 256 * 1024; // skip a move if the socket is this backed up
const WORLD_HALF = 128; // x,z random walk stays within [-128,128] (well inside [-256,256])
const SEA_LEVEL = 40; // Voxelheim SEA_LEVEL (public/src/constants.js)
const Y_MIN = SEA_LEVEL - 5; // keep the vertical walk in a sane band ...
const Y_MAX = SEA_LEVEL + 30; // ... [35, 70], comfortably within 0 <= y < 128
const WORLD_HEIGHT = 128; // Voxelheim WORLD_HEIGHT; edits require 0 <= y < 128
const MAX_BLOCK_ID = 40; // Voxelheim MAX_BLOCK_ID; a place uses block in 1..40
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
 * Spawn the bundled reference mock server and resolve once it prints its READY
 * line. We inject GAME_PORT=0 (unless the caller pinned one) so the OS assigns an
 * ephemeral port — avoiding collisions when several runs share a host — and read
 * the *resolved* port straight out of the READY line.
 * @returns {Promise<{child:import('node:child_process').ChildProcess, url:string}>}
 */
function spawnMock() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (!env.GAME_PORT) env.GAME_PORT = '0'; // ephemeral unless pinned by the caller
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
      const s = d.toString();
      buf += s;
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
 * Spawn an arbitrary server command through a shell and wait for its port to open.
 * We cannot know its ready-line format, so we poll the target port instead.
 * @param {string} cmd  shell command line to run
 * @param {string} url  ws url whose port we poll for readiness
 * @param {string} [cwd] working directory to launch the command in (--server-cwd)
 * @returns {Promise<{child:import('node:child_process').ChildProcess, url:string}>}
 */
async function spawnServerCmd(cmd, url, cwd = '') {
  const child = spawn(cmd, {
    shell: true,
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
 * MAIN
 * ========================================================================= */
export async function main(argv = process.argv.slice(2)) {
  /* ---- config ------------------------------------------------------------ */
  const { opts } = parseArgs(argv, {
    players: { default: 50, env: 'GAME_BOTS', type: 'number' },
    'duration-sec': { default: 30, env: 'GAME_DURATION', type: 'number' },
    url: { default: '', env: 'GAME_URL', type: 'string' },
    spawn: { default: false, type: 'boolean' },
    'server-cmd': { default: '', env: 'GAME_SERVER_CMD', type: 'string' },
    'server-cwd': { default: '', env: 'GAME_SERVER_CWD', type: 'string' },
    'server-pid': { default: 0, env: 'SERVER_PID', type: 'number' },
    report: { default: '', env: 'GAME_REPORT', type: 'string' },
  });

  const players = Math.max(1, Math.floor(opts.players) || 1);
  const durationMs = Math.max(1, Math.floor(opts.durationSec) || 1) * 1000;
  const urlOpt = String(opts.url || '').trim();
  const serverCmd = String(opts.serverCmd || '').trim();
  const serverCwd = String(opts.serverCwd || '').trim();
  const serverPid = Math.max(0, Math.floor(Number(opts.serverPid) || 0));
  const spawnFlag = !!opts.spawn;
  const reportPath = String(opts.report || '').trim();
  const clientMaxPayload = envNum('GAME_MAX_PAYLOAD', 1 << 20);

  const thresholds = {
    P95_MS: envNum('P95_MS', 150),
    P99_MS: envNum('P99_MS', 300),
    DROP_PCT: envNum('DROP_PCT', 1),
    OOO_PCT: envNum('OOO_PCT', 1),
    MAX_CONN_ERRORS: envNum('MAX_CONN_ERRORS', 0),
  };

  // Resolve target mode (precedence documented in the header).
  let mode; // 'server-cmd' | 'spawn-mock' | 'url'
  if (serverCmd) mode = 'server-cmd';
  else if (spawnFlag) mode = 'spawn-mock';
  else if (urlOpt) mode = 'url';
  else mode = 'spawn-mock';

  /* ---- shared metric state ---------------------------------------------- */
  const rttStats = new Stats();
  const propStats = new Stats();
  const bots = []; // {i, conn, serverId, key, seq, pos, vel, yaw, seen, rttSeq, rttOutstanding, timers, welcomed, hadError, active}
  // Server-assigned id ("p<N>") -> the botIdx that owns it. Each bot registers its
  // OWN welcome id; since every move source is a bot in this process, self-
  // registration alone yields a complete id->botIdx map for propagation lookups.
  const idToBotIdx = new Map();
  // sendTimes: botIdx -> Map<moveSeq, sendMs>. A move's seq is smuggled into the
  // forwarded `pitch`; the first same-dim receiver to observe (source, seq) records
  // propagation, then prunes the entry so it is counted exactly once.
  const sendTimes = new Map();

  const counters = {
    movesSent: 0,
    editsSent: 0,
    rttChatsSent: 0,
    welcomesReceived: 0,
    peerJoinsReceived: 0,
    peerLeavesReceived: 0,
    movesReceived: 0,
    editsReceived: 0,
    chatsReceived: 0,
    rttEchoesMatched: 0,
    errorsReceived: 0,
    unknownReceived: 0,
  };
  let connected = 0; // bots that received a welcome
  let connectFailures = 0; // bots that never reached welcome (connect reject/timeout/early close)
  let socketErrors = 0; // 'error' events on live connections
  let unexpectedCloses = 0; // mid-test closes we did not initiate
  let drops = 0; // aggregate skipped-seq count
  let ooo = 0; // aggregate decreasing-seq count

  let stopping = false; // set once teardown begins (suppresses error/close accounting)
  let serverDied = false; // spawned server exited before we intended
  let intentionalKill = false; // we asked the child to die (don't flag serverDied)

  /* ---- bring the target server up --------------------------------------- */
  let child = null; // spawned server process (null in 'url' mode)
  let targetUrl = urlOpt || defaultUrl();
  let sampler = null;
  let samplePid = null; // pid we sample CPU/mem for (a spawned child OR --server-pid)
  let sampledExternal = false; // true when sampling a pid we did NOT spawn

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
      // 'url' mode: nothing to spawn. Best-effort reachability probe (non-fatal —
      // per-bot connect failures are the authoritative signal).
      targetUrl = urlOpt;
      const up = await waitForPort(targetUrl, 3000);
      if (!up) {
        process.stderr.write(
          `[load] warning: ${targetUrl} not reachable yet; bots will attempt anyway\n`
        );
      }
    }
  } catch (err) {
    process.stderr.write(`[load] failed to start target server: ${err && err.message}\n`);
    // Nothing to sample/kill meaningfully; emit a failed report and exit 1.
    const report = {
      mode,
      url: targetUrl,
      error: `server-start-failed: ${err && err.message}`,
      results: { pass: false, breaches: ['server failed to start'] },
    };
    printReport('LOAD TEST — FAILED TO START', report);
    if (reportPath) writeJsonReport(reportPath, report);
    process.exit(1);
    return; // unreachable, keeps linters happy
  }

  // Watch a spawned server for premature death.
  if (child) {
    child.on('exit', (code, sig) => {
      if (intentionalKill || stopping) return;
      serverDied = true;
      process.stderr.write(`[load] server process died mid-test (code=${code} sig=${sig})\n`);
      finish('server-died');
    });
  }

  // CPU/mem sampling target: a process we spawned, else an externally-started
  // --server-pid (SERVER_PID). A bare --url with no pid samples nothing (n/a).
  if (child) {
    samplePid = child.pid;
  } else if (serverPid > 0) {
    samplePid = serverPid;
    sampledExternal = true;
  }
  if (samplePid && samplePid > 0) {
    // On non-Linux / a bad pid this samples nothing and stop() returns nulls (never throws).
    sampler = startProcSampler(samplePid, 500);
  }

  process.stderr.write(
    `[load] target=${targetUrl} mode=${mode} players=${players} duration=${durationMs / 1000}s\n`
  );

  /* ---- server-side message handling per bot ----------------------------- */

  function onMessage(bot, data) {
    let msg;
    try {
      msg = decode(data); // decode never throws, but stay defensive
    } catch {
      return;
    }
    switch (msg.kind) {
      case 'welcome':
        onWelcome(bot, msg);
        break;
      case 'peer-join':
        onPeerJoin(bot, msg);
        break;
      case 'peer-leave':
        counters.peerLeavesReceived++;
        break;
      case 'move':
        onMove(bot, msg);
        break;
      case 'edit':
        counters.editsReceived++;
        break;
      case 'chat':
        onChat(bot, msg);
        break;
      case 'error':
        counters.errorsReceived++;
        break;
      default:
        counters.unknownReceived++;
    }
  }

  function onWelcome(bot, msg) {
    if (bot.welcomed) return; // ignore duplicate welcomes
    bot.welcomed = true;
    bot.serverId = msg.id;
    bot.key = msg.id === undefined || msg.id === null ? null : String(msg.id);
    counters.welcomesReceived++;
    // Register this bot's server id -> its index. Every move source is a bot in
    // this process, so self-registration builds a complete id->botIdx map.
    if (bot.key !== null) idToBotIdx.set(bot.key, bot.i);
    // NOTE: we deliberately do NOT seed drop/ooo tracking from welcome.peers — a
    // welcome carries no move seq, so seeding would either be a no-op or (for a
    // peer already mid-stream) fabricate a spurious initial drop burst. Each
    // (receiver, source) span initializes lazily on the first move observed.
    if (typeof bot._welcomeResolve === 'function') {
      const r = bot._welcomeResolve;
      bot._welcomeResolve = null;
      r(true);
    }
  }

  function onPeerJoin(bot, msg) {
    counters.peerJoinsReceived++;
    // A peer-join (also emitted on a peer's dim-change) confirms a peer id but
    // carries no move seq: id->botIdx is built from each bot's own welcome, and
    // drop/ooo spans initialize on the first forwarded move. Nothing to seed.
    void bot;
    void msg;
  }

  function onMove(bot, msg) {
    counters.movesReceived++;
    if (msg.id === undefined || msg.id === null) return;
    const sid = String(msg.id);
    if (sid === bot.key) return; // ignore our own move if the server ever reflects it
    const seq = readMoveSeq(msg); // moveSeq was smuggled into `pitch`

    // --- propagation: first same-dim receiver to observe (source, seq) ---------
    const srcIdx = idToBotIdx.get(sid);
    if (srcIdx !== undefined) {
      const inner = sendTimes.get(srcIdx);
      if (inner && inner.has(seq)) {
        const sentAt = inner.get(seq);
        const dt = nowMs() - sentAt;
        if (dt >= 0 && dt < 120000) propStats.add(dt);
        // Prune this and every earlier seq for that source so propagation for a
        // given (source, seq) is recorded exactly ONCE across all receivers.
        pruneUpTo(inner, seq);
      }
    }

    // --- drops / out-of-order, tracked per (receiver bot, source id) -----------
    const e = bot.seen.get(sid);
    if (!e) {
      bot.seen.set(sid, { first: seq, high: seq });
    } else if (seq > e.high) {
      const gap = seq - e.high - 1;
      if (gap > 0) drops += gap; // skipped updates never seen by this receiver
      e.high = seq;
    } else if (seq < e.high) {
      ooo += 1; // a seq that went backwards
    }
    // seq === e.high => duplicate rebroadcast of the latest seq; expected, ignore.
  }

  function onChat(bot, msg) {
    counters.chatsReceived++;
    // RTT via chat self-echo: only OUR OWN echo (id === our welcome id) whose text
    // decodes to our botIdx counts. matchRttEcho enforces id===myId + text format.
    const echo = matchRttEcho(msg, bot.serverId);
    if (!echo) return;
    if (echo.botIdx !== bot.i) return; // defensive: the payload must be ours
    if (!bot.rttOutstanding.has(echo.seq)) return; // ignore duplicate/unknown echoes
    bot.rttOutstanding.delete(echo.seq);
    const rtt = nowMs() - echo.ts;
    if (rtt >= 0 && rtt < 120000) rttStats.add(rtt);
    counters.rttEchoesMatched++;
  }

  /** Delete every entry with key <= seq from an in-flight sendTimes map. */
  function pruneUpTo(inner, seq) {
    for (const k of inner.keys()) {
      if (k <= seq) inner.delete(k);
    }
    // Pathological safety valve: if a server never echoes seqs, bound the map.
    if (inner.size > 5000) {
      let toDrop = inner.size - 4000;
      for (const k of inner.keys()) {
        if (toDrop-- <= 0) break;
        inner.delete(k);
      }
    }
  }

  /* ---- per-bot traffic generators --------------------------------------- */

  function stepWalk(bot) {
    // Smooth bounded random walk: jitter velocity, integrate, bounce at walls.
    // x,z stay within [-WORLD_HALF, WORLD_HALF]; y stays in a sane vertical band
    // around sea level. `pitch` is NOT a heading here — it carries the moveSeq.
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
    // Don't pile writes onto a saturated socket — that would inflate our own
    // memory and fabricate drops. Model a client that simply can't keep up.
    if (conn.bufferedAmount > BACKPRESSURE_LIMIT) return;

    bot.seq += 1;
    stepWalk(bot);

    // Record the send time under this bot's index (the moveSeq carrier). Any
    // same-dim receiver resolves the source id back to this index to time it.
    let inner = sendTimes.get(bot.i);
    if (!inner) {
      inner = new Map();
      sendTimes.set(bot.i, inner);
    }
    inner.set(bot.seq, nowMs());

    // The adapter smuggles seq into `pitch`; x,y,z + yaw stay the real walk.
    const ok = conn.send(encMove({ seq: bot.seq, pos: bot.pos, yaw: bot.yaw, dim: CAPS.dim }));
    if (ok !== false) counters.movesSent++;
  }

  function sendEdit(bot) {
    const conn = bot.conn;
    if (!conn || conn.readyState !== OPEN) return;
    const action = Math.random() < 0.5 ? 'place' : 'break';
    const pos = {
      x: Math.round(bot.pos.x),
      y: clamp(Math.round(bot.pos.y), 0, WORLD_HEIGHT - 1), // require 0 <= y < 128
      z: Math.round(bot.pos.z),
    };
    // place uses a valid block id in 1..MAX_BLOCK_ID; break maps to 0 in the adapter.
    const block = 1 + Math.floor(Math.random() * MAX_BLOCK_ID);
    const ok = conn.send(encBlock({ action, pos, block, dim: CAPS.dim }));
    if (ok !== false) counters.editsSent++;
  }

  function sendRttChat(bot) {
    const conn = bot.conn;
    if (!conn || conn.readyState !== OPEN) return;
    bot.rttSeq += 1;
    bot.rttOutstanding.add(bot.rttSeq);
    // Bound the outstanding set if a server never echoes (drop the oldest half).
    if (bot.rttOutstanding.size > 1000) {
      let toDrop = bot.rttOutstanding.size - 500;
      for (const s of bot.rttOutstanding) {
        if (toDrop-- <= 0) break;
        bot.rttOutstanding.delete(s);
      }
    }
    const ok = conn.send(encRttChat({ botIdx: bot.i, seq: bot.rttSeq, ts: nowMs() }));
    if (ok !== false) counters.rttChatsSent++;
  }

  function startBotLoops(bot) {
    bot.active = true;
    bot.timers.push(setInterval(() => sendMove(bot), MOVE_INTERVAL_MS));
    bot.timers.push(setInterval(() => sendEdit(bot), BLOCK_INTERVAL_MS));
    bot.timers.push(setInterval(() => sendRttChat(bot), RTT_CHAT_INTERVAL_MS));
    // Fire one RTT chat immediately so short runs still capture RTT samples.
    sendRttChat(bot);
  }

  /* ---- bot lifecycle ----------------------------------------------------- */

  function makeBot(i) {
    return {
      i,
      conn: null,
      serverId: undefined,
      key: null,
      seq: 0, // monotonic moveSeq (smuggled into `pitch`)
      pos: {
        x: (Math.random() - 0.5) * 32,
        y: SEA_LEVEL, // start at sea level; the walk keeps y in [Y_MIN, Y_MAX]
        z: (Math.random() - 0.5) * 32,
      },
      vel: { x: 0, y: 0, z: 0 },
      yaw: Math.random() * 360,
      seen: new Map(), // sourceId -> {first, high}
      rttSeq: 0, // monotonic RTT-chat sequence
      rttOutstanding: new Set(), // rttSeqs awaiting their self-echo
      timers: [],
      welcomed: false,
      hadError: false,
      active: false,
      _welcomeResolve: null,
    };
  }

  async function runBot(i) {
    const bot = makeBot(i);
    bots.push(bot);

    // Ramp: stagger connect start across ~RAMP_MS.
    const offset = Math.floor((i / players) * RAMP_MS);
    await delay(offset);
    if (stopping) return;

    let conn;
    try {
      conn = await wsConnect(targetUrl, {
        maxPayload: clientMaxPayload,
        handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      });
    } catch {
      connectFailures++;
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
      if (stopping || !bot.active) return;
      bot.hadError = true;
      socketErrors++;
    });
    conn.on('close', () => {
      // A close during the active window that we did not initiate is a failure.
      if (stopping) return;
      if (bot.active && !bot.hadError) unexpectedCloses++;
      bot.active = false;
      for (const t of bot.timers) clearInterval(t);
      bot.timers = [];
    });

    // join -> await welcome (bounded).
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
      // All bots share the default worldId ("loadtest") in the same dim so every
      // move broadcasts to all other bots (required for propagation/drop/ooo).
      conn.send(encJoin({ name: `bot${i}`, dim: CAPS.dim }));
    } catch {
      connectFailures++;
      try {
        conn.close(1000);
      } catch {
        /* ignore */
      }
      return;
    }

    const ok = await welcome;
    if (!ok || stopping) {
      if (!ok) connectFailures++;
      try {
        conn.close(1000);
      } catch {
        /* ignore */
      }
      return;
    }

    connected++;
    startBotLoops(bot);
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

    // Stop all bot traffic.
    for (const b of bots) {
      for (const t of b.timers) clearInterval(t);
      b.timers = [];
      b.active = false;
    }

    // Freeze server resource metrics.
    const serverMetrics = sampler ? sampler.stop() : null;

    // Gracefully close bot connections, then let close frames flush.
    for (const b of bots) {
      if (b.conn) {
        try {
          b.conn.close(1000);
        } catch {
          /* ignore */
        }
      }
    }
    await delay(CLOSE_GRACE_MS);

    // ---- derive drop/ooo denominators from per-receiver spans -------------
    let expectedUpdates = 0;
    for (const b of bots) {
      for (const e of b.seen.values()) {
        const span = e.high - e.first;
        if (span > 0) expectedUpdates += span;
      }
    }
    const dropPct = expectedUpdates > 0 ? (drops / expectedUpdates) * 100 : 0;
    const oooPct = expectedUpdates > 0 ? (ooo / expectedUpdates) * 100 : 0;
    const connErrors = socketErrors + unexpectedCloses;

    // ---- threshold gating -------------------------------------------------
    const breaches = [];
    if (serverDied) breaches.push('server process died during the test');
    if (reason === 'signal') breaches.push('interrupted before completion');
    if (connected < players) {
      breaches.push(`${players - connected}/${players} bots failed to connect`);
    }
    if (connErrors > thresholds.MAX_CONN_ERRORS) {
      breaches.push(
        `connection errors ${connErrors} > MAX_CONN_ERRORS ${thresholds.MAX_CONN_ERRORS}`
      );
    }
    if (connected > 0 && rttStats.count === 0) {
      breaches.push('no RTT chat self-echoes received (server not echoing chat / unresponsive)');
    }
    if (rttStats.count > 0) {
      if (rttStats.p95 > thresholds.P95_MS) {
        breaches.push(`RTT p95 ${rttStats.p95.toFixed(1)}ms > P95_MS ${thresholds.P95_MS}ms`);
      }
      if (rttStats.p99 > thresholds.P99_MS) {
        breaches.push(`RTT p99 ${rttStats.p99.toFixed(1)}ms > P99_MS ${thresholds.P99_MS}ms`);
      }
    }
    if (dropPct > thresholds.DROP_PCT) {
      breaches.push(`drop ${dropPct.toFixed(3)}% > DROP_PCT ${thresholds.DROP_PCT}%`);
    }
    if (oooPct > thresholds.OOO_PCT) {
      breaches.push(`out-of-order ${oooPct.toFixed(3)}% > OOO_PCT ${thresholds.OOO_PCT}%`);
    }
    const pass = breaches.length === 0;
    exitCode = pass ? 0 : 1;

    // ---- assemble the report ---------------------------------------------
    const statBlock = (s) => ({
      count: s.count,
      p50: round2(s.p50),
      p95: round2(s.p95),
      p99: round2(s.p99),
      max: round2(s.max),
      mean: round2(s.mean),
    });

    const serverSection =
      sampler && samplePid
        ? {
            mode,
            spawned: !!child,
            external: sampledExternal, // true => sampling a --server-pid we did not spawn
            pid: samplePid,
            cpuAvgPct: round2(serverMetrics ? serverMetrics.cpuAvgPct : null),
            cpuPeakPct: round2(serverMetrics ? serverMetrics.cpuPeakPct : null),
            rssAvgMB: round2(serverMetrics ? serverMetrics.rssAvgMB : null),
            rssPeakMB: round2(serverMetrics ? serverMetrics.rssPeakMB : null),
            samples: serverMetrics ? serverMetrics.samples : 0,
            died: serverDied,
          }
        : {
            mode,
            spawned: false,
            external: false,
            pid: null,
            sampling:
              'n/a — no server pid sampled (external --url without --server-pid); CPU/mem not sampled',
            died: false,
          };

    const report = {
      config: {
        mode,
        url: targetUrl,
        players,
        durationSec: durationMs / 1000,
        clientMaxPayload,
        serverCwd: serverCwd || null,
        serverPid: samplePid || null,
      },
      thresholds,
      connections: {
        attempted: players,
        connected,
        connectFailures,
        socketErrors,
        unexpectedCloses,
        connErrors,
      },
      rtt: statBlock(rttStats),
      propagation: statBlock(propStats),
      drops: {
        droppedUpdates: drops,
        expectedUpdates,
        dropPct: round3(dropPct),
      },
      outOfOrder: {
        events: ooo,
        oooPct: round3(oooPct),
      },
      traffic: { ...counters },
      server: serverSection,
      results: {
        pass,
        breaches,
        exitCode,
        reason,
      },
    };

    printReport(pass ? 'LOAD TEST — PASS' : 'LOAD TEST — FAIL', report);
    if (reportPath) {
      const wrote = writeJsonReport(reportPath, report);
      process.stderr.write(
        `[load] JSON report ${wrote ? 'written to' : 'FAILED to write'}: ${reportPath}\n`
      );
    }

    // Kill the server we spawned (mock / server-cmd). No-op in url mode.
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
    // Hard-kill guarantee if it ignores SIGTERM.
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
    process.stderr.write(`[load] received ${sig}; shutting down\n`);
    finish('signal').then(() => process.exit(exitCode || 1));
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[load] uncaughtException: ${err && err.stack ? err.stack : err}\n`);
    killChild();
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`[load] unhandledRejection: ${err}\n`);
  });
  // Last-ditch guarantee the child never outlives us.
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
  // Kick off every bot (each self-schedules its ramp delay). runBot never
  // rejects, so we don't need to await the whole set to keep the loop clean.
  for (let i = 0; i < players; i++) {
    runBot(i).catch(() => {
      /* runBot is already defensive; swallow just in case */
    });
  }

  // End the active-load window after ramp + duration.
  finishTimer = setTimeout(() => finish('duration-elapsed'), RAMP_MS + durationMs);

  await finished;
  process.exit(exitCode);
}

/* =========================================================================
 * Rounding helpers for the report (keep JSON tidy; preserve nulls).
 * ========================================================================= */
function round2(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function round3(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

/* =========================================================================
 * Entry point (only when run directly, so importing for tests is side-effect free).
 * ========================================================================= */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[load] fatal: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}

/* ---------------------------------------------------------------------------
 * SELF-CHECK (informal — no test framework, dependency-free):
 *   node scripts/load-test.mjs --spawn --players 20 --duration-sec 6 \
 *        --report /tmp/load.json                # spawns the mock, runs, exits 0
 *   node scripts/load-test.mjs --url ws://127.0.0.1:3000/ws --server-pid 12345
 *                                              # target an external server + sample its pid
 *   node scripts/load-test.mjs --server-cmd "node server/index.js" \
 *        --server-cwd /path/to/voxelheim --url ws://127.0.0.1:3000/ws
 *   P95_MS=1 node scripts/load-test.mjs --spawn --players 5 --duration-sec 3
 *                                              # forces an RTT breach -> exit 1
 * Correlation (CAPS-based): RTT from chat self-echo (matchRttEcho on our own id);
 * propagation + drop + out-of-order from the moveSeq smuggled in `pitch`
 * (readMoveSeq), with server id -> botIdx resolved from each bot's welcome.
 * Invariants: always kills a spawned server (SIGTERM + SIGKILL guarantees on
 * exit); records propagation ONCE per (source,seq) via prune-on-match; drop/ooo
 * are measured per (receiver, source); a dead server or any failed connect -> exit 1.
 * ------------------------------------------------------------------------- */
