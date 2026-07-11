#!/usr/bin/env node
// deploy/smoke.mjs
//
// Dependency-free deployment smoke test for the Loomfall voxel server.
// PROVES the server is deployable end-to-end:
//
//   1. Spawns `node server/index.js` (no shell, tokenized args) on a chosen
//      PORT, capturing its logs, and waits for the TCP port to accept.
//   2. HTTP GET /api/health -> asserts 2xx; if `/` serves the game page,
//      asserts 200 + text/html.
//   3. Opens a real WebSocket to ws://127.0.0.1:PORT/ws, performs the join
//      handshake ({t:"join",...}) and asserts a {t:"welcome"} with an `id`
//      comes back.
//
// Prints PASS/FAIL per step + a summary, exits 0 only if all pass, and
// ALWAYS kills the spawned server.
//
// SELF-CONTAINED: uses only Node builtins (child_process, net, http, crypto).
// The WebSocket client is a tiny inline RFC6455 implementation (handshake +
// one masked text frame out, framed text reads in) so this file ships in
// deploy/ with ZERO repo dependencies — it does not import ws, the game's
// NetClient, or scripts/lib, none of which travel with the game branch.
//
// CLI:
//   --port <n>        listen port          (default 3399)
//   --server-cmd <s>  server command       (default "node server/index.js")
//   --cwd <path>      working directory     (default repo root, i.e. deploy/..)
//
// Usage:  node deploy/smoke.mjs [--port 3399] [--cwd /path/to/repo]

import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = argv[++i];
    else if (a === '--server-cmd') out.serverCmd = argv[++i];
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log('Usage: node deploy/smoke.mjs [--port 3399] [--server-cmd "node server/index.js"] [--cwd <repo root>]');
  process.exit(0);
}

const PORT = String(args.port || process.env.PORT || 3399);
const SERVER_CMD = args.serverCmd || 'node server/index.js';
const CWD = args.cwd ? path.resolve(args.cwd) : REPO_ROOT;
const HOST = '127.0.0.1';

// Tokenize the server command on whitespace (no shell). This keeps the spawn
// shell-free: no globbing, no injection, argv passed literally.
const CMD_TOKENS = SERVER_CMD.trim().split(/\s+/);
const CMD_BIN = CMD_TOKENS[0];
const CMD_ARGS = CMD_TOKENS.slice(1);

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${step}${detail ? ' - ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Step 1 helpers: start server, wait for port
// ---------------------------------------------------------------------------

function waitForPort(host, port, timeoutMs, isDead) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      // Fail fast if the server process already exited.
      const dead = typeof isDead === 'function' ? isDead() : null;
      if (dead) return reject(new Error(dead));
      const sock = net.connect({ host, port: Number(port) });
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        if (ok) return resolve();
        const d2 = typeof isDead === 'function' ? isDead() : null;
        if (d2) return reject(new Error(d2));
        if (Date.now() >= deadline) return reject(new Error(`port ${port} not accepting after ${timeoutMs}ms`));
        setTimeout(attempt, 250);
      };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    };
    attempt();
  });
}

// ---------------------------------------------------------------------------
// Step 2 helper: plain HTTP GET
// ---------------------------------------------------------------------------

function httpGet(pathName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: Number(PORT), path: pathName }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('http timeout')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Step 3: minimal inline RFC6455 WebSocket client
// ---------------------------------------------------------------------------

// Encode a client->server frame. Clients MUST mask (RFC6455 §5.3).
function encodeFrame(opcode, payloadBuf) {
  const len = payloadBuf.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payloadBuf[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

// Pull as many complete frames as are available from `buf`.
// Returns { frames:[{opcode,payload}], rest:Buffer }. Server->client frames
// are unmasked. Assumes each control/text frame we care about is unfragmented
// (true for the welcome JSON frame ws@8 emits).
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      // High 32 bits ignored (payloads here are tiny).
      len = buf.readUInt32BE(p + 4);
      p += 8;
    }
    let maskKey = null;
    if (masked) {
      if (p + 4 > buf.length) break;
      maskKey = buf.subarray(p, p + 4);
      p += 4;
    }
    if (p + len > buf.length) break; // incomplete payload; wait for more
    let payload = buf.subarray(p, p + len);
    if (masked) {
      const un = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) un[i] = payload[i] ^ maskKey[i & 3];
      payload = un;
    }
    frames.push({ opcode, payload: Buffer.from(payload) });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

// Open ws://HOST:PORT/ws, send join, resolve with the first {t:"welcome"}.
function wsJoin(pathName, joinMsg, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const expectAccept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    const sock = net.connect({ host: HOST, port: Number(PORT) });
    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    let finished = false;

    const timer = setTimeout(() => finish(new Error('ws timeout waiting for welcome')), timeoutMs);

    function finish(err, val) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        // polite close frame (opcode 0x8), then destroy
        sock.write(encodeFrame(0x8, Buffer.alloc(0)));
      } catch { /* ignore */ }
      sock.destroy();
      if (err) reject(err);
      else resolve(val);
    }

    sock.on('error', (e) => finish(e));
    sock.on('close', () => {
      if (!finished) finish(new Error('ws socket closed before welcome'));
    });

    sock.on('connect', () => {
      const reqLines = [
        `GET ${pathName} HTTP/1.1`,
        `Host: ${HOST}:${PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ];
      sock.write(reqLines.join('\r\n'));
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (!handshakeDone) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep === -1) return; // wait for full headers
        const head = buf.subarray(0, sep).toString('utf8');
        buf = buf.subarray(sep + 4);
        const statusLine = head.split('\r\n')[0] || '';
        if (!/HTTP\/1\.1 101/i.test(statusLine)) {
          return finish(new Error(`ws upgrade failed: "${statusLine}"`));
        }
        const acceptMatch = head.match(/sec-websocket-accept:\s*(.+)\r?/i);
        if (!acceptMatch || acceptMatch[1].trim() !== expectAccept) {
          return finish(new Error('ws upgrade: bad Sec-WebSocket-Accept'));
        }
        handshakeDone = true;
        // Send join frame.
        sock.write(encodeFrame(0x1, Buffer.from(JSON.stringify(joinMsg), 'utf8')));
      }

      if (!handshakeDone) return;
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        if (f.opcode === 0x8) return finish(new Error('server sent close before welcome'));
        if (f.opcode === 0x9) {
          // ping -> pong (echo payload)
          try { sock.write(encodeFrame(0xa, f.payload)); } catch { /* ignore */ }
          continue;
        }
        if (f.opcode === 0x1) {
          let msg;
          try {
            msg = JSON.parse(f.payload.toString('utf8'));
          } catch {
            continue; // ignore non-JSON text
          }
          if (msg && msg.t === 'welcome') {
            if (typeof msg.id === 'string' && msg.id.length > 0) {
              return finish(null, msg);
            }
            return finish(new Error('welcome frame missing string id'));
          }
          if (msg && msg.t === 'error') {
            return finish(new Error(`server error frame: ${msg.code || ''} ${msg.message || ''}`));
          }
          // ignore other frames (peer-join etc.) until welcome arrives
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let child = null;
const serverLogs = [];

function killServer() {
  if (child && !child.killed) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    // Escalate if it lingers.
    setTimeout(() => {
      if (child && !child.killed) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, 2000).unref?.();
  }
}

// Ensure the server dies even on unexpected exit paths.
process.on('exit', killServer);
process.on('SIGINT', () => { killServer(); process.exit(130); });
process.on('SIGTERM', () => { killServer(); process.exit(143); });

async function main() {
  console.log('=== Loomfall deploy smoke test ===');
  console.log(`cwd:        ${CWD}`);
  console.log(`server-cmd: ${CMD_BIN} ${CMD_ARGS.join(' ')}`);
  console.log(`port:       ${PORT}`);
  console.log('');

  // --- Step 1: start server + wait for port ---------------------------------
  try {
    child = spawn(CMD_BIN, CMD_ARGS, {
      cwd: CWD,
      env: { ...process.env, PORT },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    child.on('error', (e) => {
      serverLogs.push(`[spawn error] ${e.message}`);
    });
    child.stdout.on('data', (d) => serverLogs.push(d.toString()));
    child.stderr.on('data', (d) => serverLogs.push(d.toString()));

    // If the process exits early, surface it (and let waitForPort fail fast).
    let exitedEarly = null;
    child.on('exit', (code, sig) => {
      exitedEarly = `server exited early (code=${code} sig=${sig})`;
    });

    await waitForPort(HOST, PORT, 15000, () => exitedEarly);
    record('start server (port accepting)', true, `${HOST}:${PORT}`);
  } catch (e) {
    record('start server (port accepting)', false, e.message);
    // Nothing else can run without a server.
    return finishAll();
  }

  // --- Step 2a: GET /api/health --------------------------------------------
  try {
    const res = await httpGet('/api/health');
    const ok2xx = res.status >= 200 && res.status < 300;
    if (!ok2xx) throw new Error(`status ${res.status}`);
    record('GET /api/health (2xx)', true, `status ${res.status}, body ${res.body.slice(0, 60)}`);
  } catch (e) {
    record('GET /api/health (2xx)', false, e.message);
  }

  // --- Step 2b: GET / (game page, optional but expected) --------------------
  try {
    const res = await httpGet('/');
    const ctype = String(res.headers['content-type'] || '');
    if (res.status === 200 && /text\/html/i.test(ctype)) {
      record('GET / (game page 200 text/html)', true, `content-type ${ctype}`);
    } else {
      // Not fatal: server may be API-only in some deploys.
      record('GET / (game page 200 text/html)', false, `status ${res.status}, content-type "${ctype}" (non-fatal if API-only)`);
    }
  } catch (e) {
    record('GET / (game page 200 text/html)', false, e.message + ' (non-fatal if API-only)');
  }

  // --- Step 3: WS join handshake -------------------------------------------
  try {
    const welcome = await wsJoin('/ws', { t: 'join', worldId: 'smoke', name: 'smoke', dim: 'overworld' });
    record('WS /ws join -> welcome', true, `id ${welcome.id}`);
  } catch (e) {
    record('WS /ws join -> welcome', false, e.message);
  }

  return finishAll();
}

function finishAll() {
  killServer();

  const required = results.filter((r) => r.step !== 'GET / (game page 200 text/html)');
  const passed = results.filter((r) => r.ok).length;
  const allRequiredOk = required.every((r) => r.ok);

  console.log('');
  console.log('=== Summary ===');
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.step}`);
  console.log(`  ${passed}/${results.length} checks passed`);

  if (!allRequiredOk && serverLogs.length) {
    console.log('');
    console.log('--- server logs (tail) ---');
    console.log(serverLogs.join('').split('\n').slice(-30).join('\n'));
  }

  const overall = allRequiredOk;
  console.log('');
  console.log(overall ? 'RESULT: PASS' : 'RESULT: FAIL');

  // Give SIGTERM a moment to reach the child, then exit with the real code.
  // (Not unref'd: this timer MUST fire so the exit code is honored.)
  setTimeout(() => process.exit(overall ? 0 : 1), 300);
}

main().catch((e) => {
  record('unexpected error', false, e && e.message ? e.message : String(e));
  finishAll();
});
