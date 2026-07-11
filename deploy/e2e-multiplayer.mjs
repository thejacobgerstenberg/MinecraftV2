#!/usr/bin/env node
// deploy/e2e-multiplayer.mjs
//
// DEFINITIVE 2-client multiplayer proof for the Loomfall voxel server.
//
// Boots the REAL server (`node server/index.js`), launches ONE headless
// Chromium, opens TWO independent browser contexts (A and B) both pointed at
// the same origin so the REAL ES-module client loads. Both clients JOIN the
// SAME world. Client A performs the multiplayer verbs — MOVE, PLACE, BREAK,
// CHAT — and we assert that Client B genuinely OBSERVES every one of them
// through the real client's own state (peer avatars, world blocks, chat DOM).
// Finally we prove PERSISTENCE by disconnecting both clients (the server
// flushes on last-leave) and re-joining fresh: A's placed block is still there.
//
// WHY THIS IS A REAL PROOF (how B observes each thing):
//   * MOVE  — B reads its PeerAvatars registry: window.__game.peers has an
//             entry for A's server-assigned id whose `.target` (the network
//             truth the avatar lerps toward) equals A's moved position. A's
//             move traveled A-client -> server -> broadcast -> B-client ->
//             PeerAvatars.move(), i.e. the entire netcode path.
//   * PLACE — B reads window.__game.world.getBlock(x,y,z): A's edit was
//             applied into B's live engine World by B's own net.onEdit handler.
//   * BREAK — same handler; B sees the block return to air (id 0).
//   * CHAT  — B reads the rendered chat DOM (#chat .chat-log .chat-line): the
//             message arrived via B's net.onChat -> ui.chat.addMessage.
//   * PERSIST — after both leave, GET /api/worlds/:id (served from the on-disk
//             saves/<id>.json the server flushed) AND a fresh client's welcome
//             payload (net.world.edits) both still contain A's placed block.
//
// The client's per-frame loop auto-sends window.__game.player.position, so for
// the MOVE step we neutralize that override in-page (net.sendMove = noop — a
// pure runtime tweak, no repo files touched) and send explicit `move` frames
// through the real NetClient so A lands at a clean, distinct coordinate that B
// can be asserted against unambiguously. Every frame still crosses the real WS.
//
// Runs entirely against the shipped server + client — nothing is stubbed.
//
// CLI:
//   --port <n>     listen port         (default: an ephemeral free port)
//   --report <f>   write JSON report to file (also always printed as a table)
//   --headed       launch a headed browser (default headless)
//   -h|--help
//
// Exit code 0 iff ALL assertions pass. The browser is always closed and the
// server always killed, on every exit path.
//
// playwright-core is resolved from /tmp/pw (or the repo) via createRequire;
// Chromium is the prebuilt binary at
// /opt/pw-browsers/chromium-1194/chrome-linux/chrome (never `playwright install`).

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
  console.log('Usage: node deploy/e2e-multiplayer.mjs [--port <n>] [--report <file>] [--headed]');
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

// Raw WebSocket UPGRADE check: opens ws://HOST:PORT/ws and asserts the server
// answers HTTP/1.1 101 with a valid Sec-WebSocket-Accept. Proves /ws is live
// without pulling in the `ws` dependency.
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

const assertions = [];
function assert(name, ok, detail) {
  assertions.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  return !!ok;
}

const observed = {}; // "OBSERVED BY B" evidence

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
    shell: false,
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
      try { const r = await httpGet(port, '/api/health', 1500); healthOk = r.status === 200 && /"ok"\s*:\s*true/.test(r.body); } catch { /* retry */ }
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

// Boot the real client in a fresh context and join `worldName` via the menu.
async function bootClient(browser, port, playerName, worldName) {
  const ctx = await browser.newContext();
  // Deterministic player name (read by getPlayerName() at join).
  await ctx.addInitScript((n) => { try { localStorage.setItem('loomfall.name', n); } catch { /* ignore */ } }, playerName);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(`http://${HOST}:${port}/`, { waitUntil: 'domcontentloaded' });
  // Main menu -> Play -> the world row for our world -> its small Play button.
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.locator('.world-row', { hasText: worldName }).locator('.vx-btn--small').click();
  await page.waitForFunction(() => !!window.__game && !!window.__game.net && window.__game.net.connected === true, { timeout: 15000 });
  const selfId = await page.evaluate(() => window.__game.net.selfId);
  return { ctx, page, selfId, errors };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Loomfall 2-client multiplayer E2E ===\n');

  const pwmod = resolvePlaywright();
  if (!pwmod) {
    assert('resolve playwright-core', false, 'not found in /tmp/pw or repo (run the installer)');
    return finish();
  }
  const { chromium } = pwmod.pw;
  if (!fs.existsSync(CHROME_EXEC)) {
    assert('chromium binary present', false, CHROME_EXEC);
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
    assert('server up (GET /api/health + ws /ws upgrade)', true, `http://${HOST}:${PORT}`);
  } catch (e) {
    assert('server up (GET /api/health + ws /ws upgrade)', false, e.message);
    return finish();
  }

  // --- 2. Create the shared world ----------------------------------------
  const worldName = `e2e-${NONCE}`;
  let worldId = null;
  try {
    const r = await httpPostJson(PORT, '/api/worlds', { name: worldName });
    const w = JSON.parse(r.body);
    worldId = w.id;
    assert('create shared world (POST /api/worlds)', r.status === 201 && !!worldId, `id=${worldId}`);
  } catch (e) {
    assert('create shared world (POST /api/worlds)', false, e.message);
    return finish();
  }
  if (!worldId) return finish();

  // --- Launch browser + two independent clients --------------------------
  let browser = null;
  try {
    browser = await chromium.launch({ headless: !args.headed, executablePath: CHROME_EXEC, args: ['--no-sandbox'] });

    let A = null, B = null;
    try {
      A = await bootClient(browser, PORT, `Alice-${NONCE}`, worldName);
      assert('client A joined world (welcome id)', !!A.selfId, `A.selfId=${A.selfId}`);
      B = await bootClient(browser, PORT, `Bob-${NONCE}`, worldName);
      assert('client B joined SAME world (welcome id)', !!B.selfId, `B.selfId=${B.selfId}`);
    } catch (e) {
      assert('both clients join world', false, e.message);
      return finish(browser);
    }
    // Confirm B sees A as a peer (join propagated).
    const bSeesAPeer = await B.page.waitForFunction((id) => window.__game.peers.ids.includes(id), A.selfId, { timeout: 8000 })
      .then(() => true).catch(() => false);
    assert('B registered A as a peer (peer-join)', bSeesAPeer, `A.id=${A.selfId} in B.peers.ids`);

    // ================= CLIENT A ACTIONS + CLIENT B ASSERTIONS ============

    // --- (4a/8) MOVE: A teleports to a distinct spot; B's avatar target tracks it.
    // Neutralize the render loop's per-frame position auto-send (runtime tweak),
    // then push explicit `move` frames through the real NetClient. Destination
    // is a few blocks from A's live spawn so it stays within the server speed
    // budget (cap 25 b/s).
    const start = await A.page.evaluate(() => {
      const p = window.__game.player.position;
      window.__game.net.sendMove = function () {}; // stop loop overrides
      return { x: p.x, y: p.y, z: p.z };
    });
    const movePos = { x: Math.round(start.x) - 6, y: Math.round(start.y), z: Math.round(start.z) - 4 };
    await A.page.evaluate(async (t) => {
      const net = window.__game.net; const dim = net._dim;
      for (let i = 0; i < 6; i++) { // several MOVE updates, latest-wins
        net._send({ t: 'move', x: t.x, y: t.y, z: t.z, yaw: 0, pitch: 0, dim });
        await new Promise((r) => setTimeout(r, 120));
      }
    }, movePos);
    const moveSeen = await B.page.waitForFunction(
      ({ id, t }) => {
        const e = window.__game.peers._entries.get(id);
        return !!e && Math.abs(e.target.x - t.x) < 1.5 && Math.abs(e.target.z - t.z) < 1.5;
      },
      { id: A.selfId, t: movePos }, { timeout: 8000 },
    ).then(() => true).catch(() => false);
    const bAvatarPos = await B.page.evaluate((id) => {
      const e = window.__game.peers._entries.get(id);
      return e ? { x: +e.target.x.toFixed(2), y: +e.target.y.toFixed(2), z: +e.target.z.toFixed(2) } : null;
    }, A.selfId);
    observed.avatarMove = { sent: movePos, bObserved: bAvatarPos };
    assert('B SEES A avatar MOVE (peers registry target)', moveSeen,
      `A sent ${JSON.stringify(movePos)}; B avatar at ${JSON.stringify(bAvatarPos)}`);

    // --- (4b/5b) PLACE: A places a block near its moved position; B applies it.
    const placeCoord = { x: movePos.x + 1, y: movePos.y, z: movePos.z };
    const placeBlock = 5;
    await A.page.evaluate(({ x, y, z, b }) => window.__game.net.sendEdit(x, y, z, b),
      { ...placeCoord, b: placeBlock });
    const placeSeen = await B.page.waitForFunction(
      ({ c, b }) => window.__game.world.getBlock(c.x, c.y, c.z) === b,
      { c: placeCoord, b: placeBlock }, { timeout: 8000 },
    ).then(() => true).catch(() => false);
    const bPlaceVal = await B.page.evaluate((c) => window.__game.world.getBlock(c.x, c.y, c.z), placeCoord);
    observed.place = { coord: placeCoord, block: placeBlock, bObserved: bPlaceVal };
    assert('B RECEIVED A PLACE (world.getBlock)', placeSeen,
      `coord ${JSON.stringify(placeCoord)} expected ${placeBlock}, B has ${bPlaceVal}`);

    // --- (4b/5b) BREAK: place then break a DIFFERENT block; B sees it clear to air.
    const breakCoord = { x: movePos.x + 2, y: movePos.y, z: movePos.z };
    await A.page.evaluate(({ x, y, z }) => window.__game.net.sendEdit(x, y, z, 7), breakCoord);
    const filled = await B.page.waitForFunction(
      (c) => window.__game.world.getBlock(c.x, c.y, c.z) === 7,
      breakCoord, { timeout: 8000 },
    ).then(() => true).catch(() => false);
    await A.page.evaluate(({ x, y, z }) => window.__game.net.sendEdit(x, y, z, 0), breakCoord); // break -> air
    const breakSeen = await B.page.waitForFunction(
      (c) => window.__game.world.getBlock(c.x, c.y, c.z) === 0,
      breakCoord, { timeout: 8000 },
    ).then(() => true).catch(() => false);
    const bBreakVal = await B.page.evaluate((c) => window.__game.world.getBlock(c.x, c.y, c.z), breakCoord);
    observed.break = { coord: breakCoord, filledFirst: filled, bObservedAir: bBreakVal };
    assert('B RECEIVED A BREAK (block 7 -> air 0)', filled && breakSeen,
      `coord ${JSON.stringify(breakCoord)}: filled=${filled}, now B has ${bBreakVal}`);

    // --- (4c/5a) CHAT: A sends a unique message; B sees it in the chat DOM.
    const chatText = `e2e-hello-${NONCE}`;
    await A.page.evaluate((t) => window.__game.net.sendChat(t), chatText);
    const chatSeen = await B.page.waitForFunction(
      (t) => [...document.querySelectorAll('#chat .chat-log .chat-line')].some((l) => l.textContent.includes(t)),
      chatText, { timeout: 8000 },
    ).then(() => true).catch(() => false);
    const bChatLine = await B.page.evaluate((t) => {
      const l = [...document.querySelectorAll('#chat .chat-log .chat-line')].find((n) => n.textContent.includes(t));
      return l ? l.textContent.trim() : null;
    }, chatText);
    observed.chat = { sent: chatText, bObserved: bChatLine };
    assert('B RECEIVED A CHAT (chat DOM)', chatSeen, `"${chatText}" -> B line: ${bChatLine ? '"' + bChatLine + '"' : 'none'}`);

    // ================= PERSISTENCE ======================================
    // Disconnect both clients; the server flushes the room to disk on last-leave.
    await A.page.evaluate(() => window.__game.net.close());
    await B.page.evaluate(() => window.__game.net.close());
    await A.ctx.close();
    await B.ctx.close();
    A = null; B = null;
    await sleep(1200); // let the last-leave flush land

    // (6a) REST: the on-disk world (GET /api/worlds/:id) still has A's placed block.
    let restHasBlock = false, restVal = null;
    try {
      const r = await httpGet(PORT, `/api/worlds/${worldId}`);
      const w = JSON.parse(r.body);
      const key = `${placeCoord.x},${placeCoord.y},${placeCoord.z}`;
      restVal = w?.edits?.overworld?.[key];
      restHasBlock = restVal === placeBlock;
    } catch (e) { restVal = `err:${e.message}`; }
    observed.persistRest = { key: `${placeCoord.x},${placeCoord.y},${placeCoord.z}`, value: restVal };
    assert('PERSIST: block survives in GET /api/worlds/:id after rejoin', restHasBlock,
      `edits[overworld]["${placeCoord.x},${placeCoord.y},${placeCoord.z}"]=${restVal} (want ${placeBlock})`);

    // (6b) Fresh client: welcome.world.edits (net.world.edits) still has the block.
    let welcomeHasBlock = false, welcomeVal = null;
    try {
      const C = await bootClient(browser, PORT, `Carol-${NONCE}`, worldName);
      const key = `${placeCoord.x},${placeCoord.y},${placeCoord.z}`;
      welcomeVal = await C.page.evaluate((k) => {
        const w = window.__game.net.world;
        return w && w.edits && w.edits.overworld ? w.edits.overworld[k] : undefined;
      }, key);
      welcomeHasBlock = welcomeVal === placeBlock;
      await C.ctx.close();
    } catch (e) { welcomeVal = `err:${e.message}`; }
    observed.persistWelcome = { value: welcomeVal };
    assert('PERSIST: block present in fresh client welcome.world.edits', welcomeHasBlock,
      `welcome edit value=${welcomeVal} (want ${placeBlock})`);

    // Supplementary evidence: the raw save file on disk.
    const savePath = path.join(REPO_ROOT, 'saves', `${worldId}.json`);
    try {
      const saved = JSON.parse(fs.readFileSync(savePath, 'utf8'));
      const key = `${placeCoord.x},${placeCoord.y},${placeCoord.z}`;
      observed.saveFile = { path: savePath, value: saved?.edits?.overworld?.[key] };
    } catch (e) { observed.saveFile = { path: savePath, error: e.message }; }

  } finally {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  }

  return finish();
}

// ---------------------------------------------------------------------------
// Reporting / teardown
// ---------------------------------------------------------------------------

function finish(browserToClose) {
  if (browserToClose) { try { browserToClose.close(); } catch { /* ignore */ } }
  killServer();

  const passed = assertions.filter((a) => a.ok).length;
  const allOk = assertions.length > 0 && assertions.every((a) => a.ok);

  console.log('\n=== ASSERTION TABLE ===');
  for (const a of assertions) console.log(`  ${a.ok ? 'PASS' : 'FAIL'}  ${a.name}`);
  console.log(`  ${passed}/${assertions.length} assertions passed`);

  console.log('\n=== OBSERVED BY B ===');
  if (observed.chat) console.log(`  chat        : sent "${observed.chat.sent}"  |  B saw ${observed.chat.bObserved ? '"' + observed.chat.bObserved + '"' : 'NONE'}`);
  if (observed.place) console.log(`  place       : block ${observed.place.block} @ ${JSON.stringify(observed.place.coord)}  |  B world.getBlock=${observed.place.bObserved}`);
  if (observed.break) console.log(`  break       : @ ${JSON.stringify(observed.break.coord)} filled(7)=${observed.break.filledFirst}  |  B now air=${observed.break.bObservedAir}`);
  if (observed.avatarMove) console.log(`  avatar move : A sent ${JSON.stringify(observed.avatarMove.sent)}  |  B peer target ${JSON.stringify(observed.avatarMove.bObserved)}`);
  if (observed.persistRest) console.log(`  persist REST: edits["${observed.persistRest.key}"]=${observed.persistRest.value}`);
  if (observed.persistWelcome) console.log(`  persist welc: welcome edit value=${observed.persistWelcome.value}`);
  if (observed.saveFile) console.log(`  save file   : ${observed.saveFile.path} value=${observed.saveFile.value ?? observed.saveFile.error}`);

  if (!allOk && serverLog.length) {
    console.log('\n--- server log (tail) ---');
    console.log(serverLog.join('').split('\n').slice(-25).join('\n'));
  }

  const report = {
    ok: allOk,
    passed,
    total: assertions.length,
    assertions,
    observedByB: observed,
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

  console.log(`\nRESULT: ${allOk ? 'PASS' : 'FAIL'}`);
  setTimeout(() => process.exit(allOk ? 0 : 1), 300);
}

main().catch((e) => {
  assert('unexpected error', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
  finish();
});
