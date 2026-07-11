#!/usr/bin/env node
// scripts/integration-smoke.mjs
//
// THE go/no-go integration smoke for the fully-assembled Loomfall game.
// This is the single fast gate the builder runs *before opening the playable
// PR*: "is the assembled game healthy enough to ship?" It is deliberately
// LIGHTER than the exhaustive 2-client proof in deploy/e2e-multiplayer.mjs —
// no persistence round-trip, no break/move-avatar assertions — but it exercises
// the whole real stack (server + ES-module client + WS netcode) end to end and
// answers GO / NO-GO.
//
// WHAT IT PROVES
//   1. The REAL server boots (`node server/index.js`, no shell) and answers
//      GET /api/health AND a raw ws:///ws upgrade.
//   2. A REAL browser client (headless Chromium, the shipped ES-module client)
//      boots + joins a freshly created world with ZERO console errors and ZERO
//      page errors, and the world actually LOADS (window.__game.world present,
//      window.__game.net.connected === true).
//   3. BLOCK ROUND-TRIP on client A: A moves near a reachable coord and places
//      a block (the real place path = world.setBlock + net.sendEdit); A's own
//      engine World reflects the placed id.
//   4. 2ND-CLIENT SYNC: client B joins the SAME world, registers A as a peer,
//      RECEIVES A's block edit (B.__game.world.getBlock === placed id, i.e. the
//      edit crossed A-client -> server -> B-client -> B.net.onEdit), and
//      RECEIVES an A chat message in its rendered chat DOM.
//
// FEATURE-DETECT: if the assembled game is not present (no ./server/index.js or
// no ./public), this prints a skip line and exits 0 — the gate is a no-op until
// the game is assembled into the repo, so it stays GREEN standalone.
//
// Exit code: 0 = GO (every check passed), 1 = NO-GO (any check failed). The
// browser is always closed and the server always killed, on every exit path.
//
// Dependency-free except playwright-core, resolved via createRequire against
// /tmp/pw then the repo. Chromium is the prebuilt binary at
// /opt/pw-browsers/chromium-1194/chrome-linux/chrome (never `playwright install`).
//
// Client API referenced (from the e2e recon):
//   NetClient.sendEdit(x,y,z,blockId) / sendChat(text) / sendMove / _send;
//   window.__game { world.getBlock(x,y,z)->id, net{connected,selfId,_dim},
//   player.position, peers{ids,_entries} }; chat DOM #chat .chat-log .chat-line.
//
// CLI:
//   --port <n>     listen port          (default: an ephemeral free port)
//   --report <f>   write JSON report    (verdict is always printed too)
//   --headed       headed browser        (default headless)
//   -h|--help

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Paths / constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const CHROME_EXEC = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const SERVER_ENTRY = path.join(REPO_ROOT, 'server', 'index.js');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

// Console-error noise we treat as benign for the boot cleanliness check. Kept
// intentionally tiny; anything not matched here counts as a real error and
// flips the gate to NO-GO. Raw (unfiltered) lists are always kept in the report.
const BENIGN_CONSOLE = [
  /favicon\.ico/i,               // browser auto-fetches /favicon.ico
  /ResizeObserver loop/i,        // benign layout-thrash warning some engines emit
  /Failed to load resource.*favicon/i,
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = argv[++i];
    else if (a === '--report') out.report = argv[++i];
    else if (a === '--headed') out.headed = true;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: node scripts/integration-smoke.mjs [--port <n>] [--report <file>] [--headed]');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// FEATURE DETECT — no assembled game => skip (GREEN no-op).
// ---------------------------------------------------------------------------

if (!fs.existsSync(SERVER_ENTRY) || !fs.existsSync(PUBLIC_DIR)) {
  console.log('assembled game not present (no server/ or public/) — skipping integration smoke');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// playwright-core resolution (reuse /tmp/pw, fall back to repo)
// ---------------------------------------------------------------------------

function resolvePlaywright() {
  const candidates = ['/tmp/pw/noop.js', path.join(REPO_ROOT, 'noop.js')];
  for (const base of candidates) {
    try {
      const req = createRequire(base);
      const pw = req('playwright-core');
      return { pw, from: base };
    } catch { /* try next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small HTTP helpers (Node builtins only)
// ---------------------------------------------------------------------------

function httpGet(port, pathName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: Number(port), path: pathName }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('http GET timeout')));
    req.on('error', reject);
  });
}

function httpPostJson(port, pathName, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      { host: HOST, port: Number(port), path: pathName, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('http POST timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Raw WebSocket UPGRADE check: opens ws://HOST:PORT/ws and asserts HTTP/1.1 101
// with a valid Sec-WebSocket-Accept. Proves /ws is live without the ws dep.
function wsUpgradeOk(port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const expect = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const sock = net.connect({ host: HOST, port: Number(port) });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (ok) => {
      if (done) return; done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('error', () => { clearTimeout(timer); finish(false); });
    sock.on('connect', () => {
      sock.write([
        'GET /ws HTTP/1.1', `Host: ${HOST}:${port}`,
        'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', '',
      ].join('\r\n'));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf('\r\n\r\n');
      if (sep === -1) return;
      const head = buf.subarray(0, sep).toString('utf8');
      const statusOk = /^HTTP\/1\.1 101/i.test(head.split('\r\n')[0] || '');
      const m = head.match(/sec-websocket-accept:\s*(.+)\r?/i);
      clearTimeout(timer);
      finish(statusOk && !!m && m[1].trim() === expect);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, HOST, () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  return !!ok;
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let child = null;
const serverLog = [];

function killServer() {
  if (child && !child.killed) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => { if (child && !child.killed) { try { child.kill('SIGKILL'); } catch { /* ignore */ } } }, 1500).unref?.();
  }
}
process.on('exit', killServer);
process.on('SIGINT', () => { killServer(); process.exit(130); });
process.on('SIGTERM', () => { killServer(); process.exit(143); });

async function startServer(port) {
  child = spawn('node', ['server/index.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false, // tokenized argv, no shell
  });
  let exitedEarly = null;
  child.on('error', (e) => serverLog.push(`[spawn error] ${e.message}\n`));
  child.on('exit', (code, sig) => { exitedEarly = `server exited early (code=${code} sig=${sig})`; });
  child.stdout.on('data', (d) => serverLog.push(d.toString()));
  child.stderr.on('data', (d) => serverLog.push(d.toString()));

  // Wait (~20s) until BOTH GET /api/health and the ws:///ws upgrade respond.
  const deadline = Date.now() + 20000;
  let healthOk = false, wsOk = false;
  while (Date.now() < deadline) {
    if (exitedEarly) throw new Error(exitedEarly);
    if (!healthOk) {
      try { const r = await httpGet(port, '/api/health', 1500); healthOk = r.status === 200; } catch { /* retry */ }
    }
    if (healthOk && !wsOk) wsOk = await wsUpgradeOk(port);
    if (healthOk && wsOk) return;
    await sleep(250);
  }
  throw new Error(`server not ready within 20s (health=${healthOk} ws=${wsOk})`);
}

// ---------------------------------------------------------------------------
// Browser driving
// ---------------------------------------------------------------------------

const NONCE = crypto.randomBytes(4).toString('hex');

// Boot the real client in a fresh context, join `worldName` via the menu, and
// wait for the world to actually load. Captures console errors + page errors.
async function bootClient(browser, port, playerName, worldName) {
  const ctx = await browser.newContext();
  await ctx.addInitScript((n) => { try { localStorage.setItem('loomfall.name', n); } catch { /* ignore */ } }, playerName);
  const page = await ctx.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));

  await page.goto(`http://${HOST}:${port}/`, { waitUntil: 'domcontentloaded' });
  // Main menu -> Play -> the world row for our world -> its small Play button.
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.locator('.world-row', { hasText: worldName }).locator('.vx-btn--small').click();
  await page.waitForFunction(
    () => !!window.__game && !!window.__game.net && window.__game.net.connected === true,
    { timeout: 15000 },
  );
  const info = await page.evaluate(() => ({
    selfId: window.__game.net.selfId,
    connected: window.__game.net.connected === true,
    worldLoaded: !!window.__game.world && typeof window.__game.world.getBlock === 'function',
  }));
  return { ctx, page, consoleErrors, pageErrors, ...info };
}

function filterErrors(list) {
  return list.filter((t) => !BENIGN_CONSOLE.some((re) => re.test(t)));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const evidence = {};

async function main() {
  console.log('=== Loomfall integration smoke (GO / NO-GO gate) ===\n');

  const pwmod = resolvePlaywright();
  if (!pwmod) {
    check('resolve playwright-core', false, 'not found in /tmp/pw or repo');
    return finish();
  }
  const { chromium } = pwmod.pw;
  if (!fs.existsSync(CHROME_EXEC)) {
    check('chromium binary present', false, CHROME_EXEC);
    return finish();
  }
  console.log(`playwright-core: ${pwmod.from}`);
  console.log(`chromium:        ${CHROME_EXEC}`);

  const PORT = args.port ? Number(args.port) : await freePort();
  console.log(`port:            ${PORT}`);
  console.log(`nonce:           ${NONCE}\n`);

  // --- 1. Start the real server ------------------------------------------
  try {
    await startServer(PORT);
    check('server up (GET /api/health + ws /ws upgrade)', true, `http://${HOST}:${PORT}`);
  } catch (e) {
    check('server up (GET /api/health + ws /ws upgrade)', false, e.message);
    return finish();
  }

  // --- 2. Create the shared world ----------------------------------------
  const worldName = `smoke-${NONCE}`;
  let worldId = null;
  try {
    const r = await httpPostJson(PORT, '/api/worlds', { name: worldName });
    const w = JSON.parse(r.body);
    worldId = w.id;
    check('create world (POST /api/worlds -> 201)', r.status === 201 && !!worldId, `id=${worldId}`);
  } catch (e) {
    check('create world (POST /api/worlds -> 201)', false, e.message);
    return finish();
  }
  if (!worldId) return finish();

  let browser = null;
  try {
    browser = await chromium.launch({ headless: !args.headed, executablePath: CHROME_EXEC, args: ['--no-sandbox'] });

    // --- 3. Client A: boot + join, clean, world loaded -------------------
    let A = null;
    try {
      A = await bootClient(browser, PORT, `Alice-${NONCE}`, worldName);
    } catch (e) {
      check('client A boots + joins world', false, e.message);
      return finish(browser);
    }
    check('client A boots + joins world', !!A.selfId, `A.selfId=${A.selfId}`);

    const aConsole = filterErrors(A.consoleErrors);
    const aPage = filterErrors(A.pageErrors);
    evidence.aConsoleErrors = A.consoleErrors;
    evidence.aPageErrors = A.pageErrors;
    check('A boot+join has NO console/page errors', aConsole.length === 0 && aPage.length === 0,
      `console=${aConsole.length} page=${aPage.length}` +
      (aConsole.length || aPage.length ? ` first="${(aConsole[0] || aPage[0] || '').slice(0, 120)}"` : ''));

    check('A world LOADED (__game.world + net.connected)', A.worldLoaded && A.connected,
      `worldLoaded=${A.worldLoaded} connected=${A.connected}`);

    // --- 4. BLOCK ROUND-TRIP on A ----------------------------------------
    // Move A near a reachable coord so the server accepts the edit (reach<=7),
    // then place a block the way the real client does: world.setBlock locally
    // (the sender gets no self-echo) + net.sendEdit to broadcast. Assert A's own
    // engine World reflects the placed id.
    const start = await A.page.evaluate(() => {
      const p = window.__game.player.position;
      window.__game.net.sendMove = function () {}; // stop per-frame loop overrides
      return { x: p.x, y: p.y, z: p.z };
    });
    // Destination a few blocks away (first move is a grace teleport, later ones
    // stay within the server speed budget); place one block over from it.
    const dest = { x: Math.round(start.x) - 5, y: Math.round(start.y), z: Math.round(start.z) - 3 };
    await A.page.evaluate(async (t) => {
      const net = window.__game.net; const dim = net._dim;
      for (let i = 0; i < 5; i++) {
        net._send({ t: 'move', x: t.x, y: t.y, z: t.z, yaw: 0, pitch: 0, dim });
        await new Promise((r) => setTimeout(r, 100));
      }
    }, dest);

    const placeCoord = { x: dest.x + 1, y: dest.y, z: dest.z };
    const placeBlock = 5;
    await A.page.evaluate(({ x, y, z, b }) => {
      window.__game.world.setBlock(x, y, z, b); // local apply (real place path)
      window.__game.net.sendEdit(x, y, z, b);   // broadcast to peers
    }, { ...placeCoord, b: placeBlock });

    const aBlock = await A.page.evaluate((c) => window.__game.world.getBlock(c.x, c.y, c.z), placeCoord);
    evidence.blockRoundTrip = { coord: placeCoord, block: placeBlock, aObserved: aBlock };
    check('A block round-trip (world.getBlock reflects place)', aBlock === placeBlock,
      `@${JSON.stringify(placeCoord)} expected ${placeBlock}, A has ${aBlock}`);

    // --- 5. 2nd client sync ----------------------------------------------
    let B = null;
    try {
      B = await bootClient(browser, PORT, `Bob-${NONCE}`, worldName);
    } catch (e) {
      check('client B boots + joins SAME world', false, e.message);
      return finish(browser);
    }
    check('client B boots + joins SAME world', !!B.selfId, `B.selfId=${B.selfId}`);

    const bSeesAPeer = await B.page.waitForFunction(
      (id) => window.__game.peers.ids.includes(id), A.selfId, { timeout: 8000 },
    ).then(() => true).catch(() => false);
    check('B registers A as a peer (peer-join)', bSeesAPeer, `A.id=${A.selfId} in B.peers.ids`);

    // B RECEIVES A's placed block through the netcode (B applies it via onEdit).
    const bGotEdit = await B.page.waitForFunction(
      ({ c, b }) => window.__game.world.getBlock(c.x, c.y, c.z) === b,
      { c: placeCoord, b: placeBlock }, { timeout: 8000 },
    ).then(() => true).catch(() => false);
    const bBlock = await B.page.evaluate((c) => window.__game.world.getBlock(c.x, c.y, c.z), placeCoord);
    evidence.bEdit = { coord: placeCoord, expected: placeBlock, bObserved: bBlock };
    check('B receives A block edit (world.getBlock sync)', bGotEdit,
      `@${JSON.stringify(placeCoord)} expected ${placeBlock}, B has ${bBlock}`);

    // B RECEIVES an A chat message in the rendered chat DOM.
    const chatText = `smoke-hello-${NONCE}`;
    await A.page.evaluate((t) => window.__game.net.sendChat(t), chatText);
    const bGotChat = await B.page.waitForFunction(
      (t) => [...document.querySelectorAll('#chat .chat-log .chat-line')].some((l) => l.textContent.includes(t)),
      chatText, { timeout: 8000 },
    ).then(() => true).catch(() => false);
    const bChatLine = await B.page.evaluate((t) => {
      const l = [...document.querySelectorAll('#chat .chat-log .chat-line')].find((n) => n.textContent.includes(t));
      return l ? l.textContent.trim() : null;
    }, chatText);
    evidence.bChat = { sent: chatText, bObserved: bChatLine };
    check('B receives A chat message (chat DOM)', bGotChat, `"${chatText}" -> B line: ${bChatLine ? '"' + bChatLine + '"' : 'none'}`);

  } finally {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  }

  return finish();
}

// ---------------------------------------------------------------------------
// Verdict / teardown
// ---------------------------------------------------------------------------

function finish(browserToClose) {
  if (browserToClose) { try { browserToClose.close(); } catch { /* ignore */ } }
  killServer();

  const passed = checks.filter((c) => c.ok).length;
  const go = checks.length > 0 && checks.every((c) => c.ok);

  console.log('\n=== CHECKS ===');
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`  ${passed}/${checks.length} checks passed`);

  if (!go && serverLog.length) {
    console.log('\n--- server log (tail) ---');
    console.log(serverLog.join('').split('\n').slice(-20).join('\n'));
  }

  const report = {
    verdict: go ? 'GO' : 'NO-GO',
    ok: go,
    passed,
    total: checks.length,
    checks,
    evidence,
    generatedAt: new Date().toISOString(),
  };
  if (args.report) {
    try {
      fs.writeFileSync(args.report, JSON.stringify(report, null, 2));
      console.log(`\nJSON report written to ${path.resolve(args.report)}`);
    } catch (e) {
      console.log(`\nfailed to write report: ${e.message}`);
    }
  }

  console.log(`\nVERDICT: ${go ? 'GO' : 'NO-GO'} (${passed}/${checks.length})`);
  setTimeout(() => process.exit(go ? 0 : 1), 300);
}

main().catch((e) => {
  check('unexpected error', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
  finish();
});
