#!/usr/bin/env node
// verify-integration.mjs — post-integration acceptance gate for GraphicsStack.
//
// Run AFTER wiring graphics-lab's GraphicsStack into the real game
// (feat/voxel-sandbox-game) per INTEGRATION.md. Boots the game headless the
// way the builder repo says (node server/index.js serving public/), enters a
// world through the real menu UI, then asserts the stack is GENUINELY live:
// not "files copied", but rendering the frame.
//
// Named-global convention (the gate's contract): INTEGRATION.md Step 1
// statement 7 — `window.gfx = gfx` — is REQUIRED for this gate (it is marked
// "optional debug hook" there; this harness promotes it to the verification
// convention). Every stack check probes through `window.gfx`.
//
// Usage:
//   node graphics-lab/verify-integration.mjs                  # temp clone of this repo @ feat/voxel-sandbox-game
//   node graphics-lab/verify-integration.mjs --game-dir /path # already-checked-out game repo
//   node graphics-lab/verify-integration.mjs --url http://localhost:3000   # already-running server
//   flags: --branch <name> --port <n> --json --keep --shots-dir <dir>
//
// Exit 0 only when every non-advisory check PASSes. See VERIFY-INTEGRATION.md.

import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(name);

const OPT = {
  url: opt('--url', null),              // already-running game server
  gameDir: opt('--game-dir', null),     // already-checked-out game repo
  branch: opt('--branch', 'feat/voxel-sandbox-game'),
  port: Number(opt('--port', 3199)),
  json: has('--json'),
  keep: has('--keep'),                  // keep temp clone + server logs
  shotsDir: opt('--shots-dir', path.join(os.tmpdir(), 'verify-integration-shots')),
};

fs.mkdirSync(OPT.shotsDir, { recursive: true });

const color = process.stdout.isTTY && !OPT.json;
const C = {
  red: (s) => (color ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (color ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (color ? `\x1b[33m${s}\x1b[0m` : s),
  dim: (s) => (color ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (color ? `\x1b[1m${s}\x1b[0m` : s),
};
const log = (...a) => { if (!OPT.json) console.log(...a); };

// ---------------------------------------------------------------------------
// Result collection
// ---------------------------------------------------------------------------
const boot = { method: null, gameDir: null, url: null, serverPid: null, notes: [] };
const checks = []; // { id, name, status: PASS|FAIL|SKIP|INFO, evidence, hint }
const add = (id, name, status, evidence, hint = '') =>
  checks.push({ id, name, status, evidence, hint });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

async function waitHttp(url, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status > 0) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** % of pixels (max-channel delta > 12) that differ between two PNG buffers,
 *  restricted to a fractional region [fx0,fy0,fx1,fy1] of the frame. */
function diffRegion(bufA, bufB, fx0, fy0, fx1, fy1) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const x0 = Math.floor(w * fx0), x1 = Math.floor(w * fx1);
  const y0 = Math.floor(h * fy0), y1 = Math.floor(h * fy1);
  let changed = 0, total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      const d = Math.max(
        Math.abs(a.data[i] - b.data[j]),
        Math.abs(a.data[i + 1] - b.data[j + 1]),
        Math.abs(a.data[i + 2] - b.data[j + 2]),
      );
      if (d > 12) changed++;
      total++;
    }
  }
  return { changed, total, pct: total ? (100 * changed) / total : 0 };
}

// ---------------------------------------------------------------------------
// 1. Obtain a game checkout (unless --url)
// ---------------------------------------------------------------------------
let tmpClone = null;
let tmpSaves = null;
let serverProc = null;
let browser = null;

async function cleanup() {
  if (browser) { try { await browser.close(); } catch {} browser = null; }
  if (serverProc && serverProc.exitCode === null) {
    try { serverProc.kill('SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    if (serverProc.exitCode === null) { try { serverProc.kill('SIGKILL'); } catch {} }
  }
  serverProc = null;
  if (tmpClone && !OPT.keep) { try { fs.rmSync(tmpClone, { recursive: true, force: true }); } catch {} }
  if (tmpSaves && !OPT.keep) { try { fs.rmSync(tmpSaves, { recursive: true, force: true }); } catch {} }
}
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

let gameUrl = OPT.url;

try {
  if (!gameUrl) {
    let gameDir = OPT.gameDir ? path.resolve(OPT.gameDir) : null;

    if (!gameDir) {
      // Default: disposable local clone -> checkout the builder branch there.
      // (Never touches the working tree of the source repo.)
      tmpClone = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-game-'));
      log(C.dim(`[boot] cloning ${REPO_ROOT} -> ${tmpClone}`));
      sh('git', ['clone', '--quiet', REPO_ROOT, tmpClone]);
      // The builder branch usually exists in the source repo only as the
      // remote-tracking ref origin/<branch>; fetch it from the source clone.
      try {
        sh('git', ['-C', tmpClone, 'checkout', '--quiet', OPT.branch]);
      } catch {
        sh('git', ['-C', tmpClone, 'fetch', '--quiet', 'origin',
          `refs/remotes/origin/${OPT.branch}:refs/heads/${OPT.branch}`]);
        sh('git', ['-C', tmpClone, 'checkout', '--quiet', OPT.branch]);
      }
      gameDir = tmpClone;
      boot.method = `temp clone @ ${OPT.branch} (${sh('git', ['-C', gameDir, 'rev-parse', '--short', 'HEAD']).trim()})`;
    } else {
      boot.method = `--game-dir ${gameDir}`;
    }
    boot.gameDir = gameDir;

    if (!fs.existsSync(path.join(gameDir, 'server', 'index.js'))) {
      throw new Error(`no server/index.js in ${gameDir} — is this the builder repo?`);
    }

    // npm ci (server needs express + ws; --omit=dev skips playwright).
    if (!fs.existsSync(path.join(gameDir, 'node_modules', 'express'))) {
      log(C.dim('[boot] npm ci --omit=dev (express/ws for the server)'));
      sh('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: gameDir, timeout: 300000 });
      boot.notes.push('ran npm ci --omit=dev');
    }

    // Start their server exactly as package.json "start" does.
    const savesDir = tmpSaves = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-saves-'));
    log(C.dim(`[boot] node server/index.js  PORT=${OPT.port} WORLD_DIR=${savesDir}`));
    const serverLog = path.join(OPT.shotsDir, 'server.log');
    const logFd = fs.openSync(serverLog, 'w');
    serverProc = spawn(process.execPath, ['server/index.js'], {
      cwd: gameDir,
      env: { ...process.env, PORT: String(OPT.port), WORLD_DIR: savesDir },
      stdio: ['ignore', logFd, logFd],
    });
    boot.serverPid = serverProc.pid;
    gameUrl = `http://127.0.0.1:${OPT.port}`;
    if (!(await waitHttp(gameUrl + '/', 20000))) {
      throw new Error(`server never answered on ${gameUrl} — see ${serverLog}`);
    }
  } else {
    boot.method = `--url ${gameUrl} (externally managed server)`;
  }
  boot.url = gameUrl;

  // -------------------------------------------------------------------------
  // 2. Boot the game headless, enter a world through the real menu UI
  // -------------------------------------------------------------------------
  const consoleErrors = [];
  browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await (await browser.newContext({
    viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
  })).newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[console] ' + m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('[pageerror] ' + (e?.message || String(e))));

  await page.goto(gameUrl, { waitUntil: 'load', timeout: 30000 });

  // Menu-first boot (public/src/main.js): main menu -> Play -> Create world.
  let inWorld = false;
  try {
    await page.getByRole('button', { name: 'Play', exact: true }).click({ timeout: 15000 });
    await page.fill('.world-name-input', 'verify-' + Date.now().toString(36), { timeout: 10000 });
    await page.click('.world-create-btn', { timeout: 10000 });
    // DEV.md recipe: session live once spawn chunks are meshed.
    await page.waitForFunction(
      () => window.__game && window.__game.chunkRenderer
            && window.__game.chunkRenderer.stats.chunksLoaded >= 9,
      null, { timeout: 90000, polling: 500 },
    );
    inWorld = true;
    boot.notes.push('entered world via menu (Play -> Create); spawn chunks meshed');
  } catch (e) {
    boot.notes.push('FAILED to enter a world through the menu: ' + (e?.message || e).split('\n')[0]);
  }
  await page.waitForTimeout(2500); // settle: let late boot errors surface

  const shot = async (name) => {
    const file = path.join(OPT.shotsDir, name + '.png');
    const buf = await page.screenshot({ path: file });
    return { file, buf };
  };
  await shot('boot');

  // -------------------------------------------------------------------------
  // 3. Checks
  // -------------------------------------------------------------------------

  // (a) zero console/page errors on boot ------------------------------------
  if (consoleErrors.length === 0 && inWorld) {
    add('console', 'console clean', 'PASS', 'zero console/page errors from load through world entry');
  } else if (!inWorld) {
    add('console', 'console clean', 'FAIL',
      `never entered a world; ${consoleErrors.length} error(s)` +
      (consoleErrors[0] ? ` — first: ${consoleErrors[0].slice(0, 160)}` : ''),
      'game must boot to a live session before the stack can be verified');
  } else {
    add('console', 'console clean', 'FAIL',
      `${consoleErrors.length} error(s) — first: ${consoleErrors[0].slice(0, 160)}`,
      'INTEGRATION.md Step 0 sanity check: module graph must resolve with zero errors');
  }

  // (b) GraphicsStack present via the named global ---------------------------
  const gfxProbe = await page.evaluate(() => {
    const g = window.gfx;
    if (!g) return { present: false };
    const stackLike = typeof g.setTimeOfDay === 'function' && typeof g.meshChunk === 'function'
      && typeof g.render === 'function' && typeof g.setTexturePack === 'function';
    let inited = false, ctorName = g.constructor && g.constructor.name;
    try { inited = stackLike && !!g.exposes && !!g.exposes.ctx; } catch {}
    return { present: true, stackLike, inited, ctorName };
  });
  const gfxLive = gfxProbe.present && gfxProbe.stackLike && gfxProbe.inited;
  if (gfxLive) {
    add('gfx-global', 'GraphicsStack live (window.gfx)', 'PASS',
      `window.gfx is a ${gfxProbe.ctorName} with a live ctx (init() completed)`);
  } else if (!gfxProbe.present) {
    add('gfx-global', 'GraphicsStack live (window.gfx)', 'FAIL',
      'window.gfx is undefined',
      'INTEGRATION.md Step 1 statement 7: `window.gfx = gfx` — required by this gate');
  } else {
    add('gfx-global', 'GraphicsStack live (window.gfx)', 'FAIL',
      `window.gfx exists but ${!gfxProbe.stackLike ? 'is not a GraphicsStack facade' : 'has no live ctx — init() never ran'} (ctor: ${gfxProbe.ctorName})`,
      'INTEGRATION.md Step 1: construct GraphicsStack and await gfx.init({...})');
  }

  // (c) chunk geometry carries the 'ao' attribute ----------------------------
  const aoProbe = await page.evaluate(() => {
    const scenes = [];
    if (window.gfx && window.gfx.scene) scenes.push(window.gfx.scene);
    const cr = window.__game && window.__game.chunkRenderer;
    if (cr && cr.scene && !scenes.includes(cr.scene)) scenes.push(cr.scene);
    let meshes = 0, withAo = 0, aoVerts = 0;
    for (const s of scenes) {
      try {
        s.traverse((o) => {
          if (!o.isMesh || !o.geometry || !o.geometry.getAttribute) return;
          const pos = o.geometry.getAttribute('position');
          if (!pos || pos.count === 0) return;
          meshes++;
          const ao = o.geometry.getAttribute('ao');
          if (ao && ao.count > 0) { withAo++; aoVerts += ao.count; }
        });
      } catch {}
    }
    return { scenes: scenes.length, meshes, withAo, aoVerts };
  });
  if (aoProbe.withAo > 0) {
    add('ao-attr', "chunk geometry has 'ao'", 'PASS',
      `${aoProbe.withAo}/${aoProbe.meshes} scene meshes carry an 'ao' attribute (${aoProbe.aoVerts} verts)`);
  } else {
    add('ao-attr', "chunk geometry has 'ao'", 'FAIL',
      `0 of ${aoProbe.meshes} meshes (in ${aoProbe.scenes} scene(s)) have geometry.attributes.ao`,
      "INTEGRATION.md Step 2: mesh chunks via gfx.meshChunk (greedy path bakes the 'ao' attribute)");
  }

  // (d) DynamicSky active: fog colour tracks a time-of-day change ------------
  if (!gfxLive) {
    add('sky', 'DynamicSky drives fog colour', 'FAIL', 'no live window.gfx to probe',
      'fix gfx-global first (Step 1), keep enable.sky on (Step 3a)');
  } else {
    const skyProbe = await page.evaluate(async () => {
      const g = window.gfx;
      const ex = g.exposes;
      if (!ex.sky) return { module: false };
      const grab = () => {
        const c = ex.ctx.skyColor;
        return [c.r, c.g, c.b].map((v) => +v.toFixed(3));
      };
      const t0 = ex.ctx.timeOfDay;
      g.setTimeOfDay(0.35); // day
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const day = grab();
      g.setTimeOfDay(0.0); // midnight
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const night = grab();
      g.setTimeOfDay(t0);   // restore
      const delta = day.reduce((s, v, i) => s + Math.abs(v - night[i]), 0);
      return { module: true, day, night, delta: +delta.toFixed(3) };
    });
    if (!skyProbe.module) {
      add('sky', 'DynamicSky drives fog colour', 'FAIL', 'gfx.exposes.sky is null (sky module not initialised)',
        'INTEGRATION.md Step 3a: keys sky/dimensionSky/fog must be on');
    } else if (skyProbe.delta > 0.05) {
      add('sky', 'DynamicSky drives fog colour', 'PASS',
        `fog rgb day=[${skyProbe.day}] vs midnight=[${skyProbe.night}] (Δ=${skyProbe.delta})`);
    } else {
      add('sky', 'DynamicSky drives fog colour', 'FAIL',
        `fog colour did not track setTimeOfDay (Δ=${skyProbe.delta})`,
        'sky module present but inert — is gfx.update(dt) in the game loop? (Step 1b)');
    }
  }

  // (e) PostFX in the chain ---------------------------------------------------
  if (!gfxLive) {
    add('postfx', 'PostFX in the render chain', 'FAIL', 'no live window.gfx to probe',
      'fix gfx-global first (Step 1), then Step 3b (delete post:false)');
  } else {
    const postProbe = await page.evaluate(async () => {
      const g = window.gfx;
      const post = g.exposes.post;
      if (!post) return { module: false };
      const enabled = post.enabled !== false;
      // Instrument: while PostFX is live, frames render into offscreen RTs
      // before hitting the canvas. Count non-null setRenderTarget calls
      // across ~15 frames on the stack's renderer.
      let rtWrites = 0;
      const r = g.renderer;
      let orig = null;
      if (r && typeof r.setRenderTarget === 'function') {
        orig = r.setRenderTarget.bind(r);
        r.setRenderTarget = (t, ...a) => { if (t) rtWrites++; return orig(t, ...a); };
        await new Promise((res) => setTimeout(res, 300));
        r.setRenderTarget = orig;
      }
      return { module: true, enabled, rtWrites, instrumented: !!orig };
    });
    if (!postProbe.module) {
      add('postfx', 'PostFX in the render chain', 'FAIL', 'gfx.exposes.post is null (post module not initialised)',
        'INTEGRATION.md Step 3b: delete post:false (and biome:false) from enable');
    } else if (postProbe.enabled && postProbe.rtWrites > 0) {
      add('postfx', 'PostFX in the render chain', 'PASS',
        `post.enabled=true; ${postProbe.rtWrites} offscreen render-target writes observed in ~300ms`);
    } else if (postProbe.enabled) {
      add('postfx', 'PostFX in the render chain', 'FAIL',
        `post module enabled but zero offscreen render-target writes${postProbe.instrumented ? '' : ' (renderer not instrumentable)'}`,
        'gfx.render() is not the frame\'s final render call (Step 1b: replace renderer.render with gfx.update+gfx.render)');
    } else {
      add('postfx', 'PostFX in the render chain', 'FAIL', 'post module present but disabled (self-bypassing)',
        'enable it: gfx.toggle(\'bloom\'|... ) or remove post:false (Step 3b)');
    }
  }

  // (f) water animated ---------------------------------------------------------
  if (!gfxLive) {
    add('water', 'water animated', 'FAIL', 'no live window.gfx to probe',
      'fix gfx-global first (Step 1), then Step 3c (water keys + waterLevel: SEA_LEVEL)');
  } else {
    const w1 = await page.evaluate(() => {
      const w = window.gfx.exposes.water;
      if (!w) return { module: false };
      const u = w._material && w._material.uniforms && w._material.uniforms.uTime;
      return { module: true, uTime: u ? u.value : null };
    });
    if (!w1.module) {
      add('water', 'water animated', 'SKIP', 'gfx.exposes.water is null (water module off — legitimate for nether/end)',
        'for overworld: INTEGRATION.md Step 3c — delete water/underwater/underwaterfx:false, pass waterLevel: SEA_LEVEL (40)');
    } else {
      const shotW1 = await shot('water-1');
      await page.waitForTimeout(450);
      const shotW2 = await shot('water-2');
      const w2 = await page.evaluate(() => {
        const u = window.gfx.exposes.water._material?.uniforms?.uTime;
        return { uTime: u ? u.value : null };
      });
      const uAdvanced = w1.uTime !== null && w2.uTime !== null && w2.uTime > w1.uTime;
      const d = diffRegion(shotW1.buf, shotW2.buf, 0, 0.5, 1, 1); // lower half
      if (uAdvanced && d.pct > 0.05) {
        add('water', 'water animated', 'PASS',
          `uTime ${w1.uTime?.toFixed(2)}->${w2.uTime?.toFixed(2)}; ${d.pct.toFixed(2)}% of lower-half pixels changed across 2 frames`);
      } else if (uAdvanced) {
        add('water', 'water animated', 'SKIP',
          `water uniforms animate (uTime ${w1.uTime?.toFixed(2)}->${w2.uTime?.toFixed(2)}) but only ${d.pct.toFixed(3)}% pixels changed — no water in view at spawn`,
          'advisory: aim the camera at a water surface (SEA_LEVEL=40) and re-run to confirm visually');
      } else {
        add('water', 'water animated', 'FAIL',
          `water module present but uTime not advancing (${w1.uTime} -> ${w2.uTime})`,
          'gfx.update(dt) is not being called every frame (Step 1b)');
      }
    }
  }

  // (g) texture-pack swap -------------------------------------------------------
  if (!gfxLive) {
    add('texture-pack', "setTexturePack('gritty') changes terrain", 'FAIL', 'no live window.gfx to probe',
      'fix gfx-global first (Step 1), then Step 3e');
  } else {
    const before = await shot('pack-before');
    const packProbe = await page.evaluate(async () => {
      const g = window.gfx;
      const hash = () => {
        try {
          const img = g.exposes.atlas && g.exposes.atlas.texture && g.exposes.atlas.texture.image;
          if (!img || !img.toDataURL) return null;
          const s = img.toDataURL();
          let h = 0;
          for (let i = 0; i < s.length; i += 7) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
          return h;
        } catch { return null; }
      };
      const h1 = hash();
      g.setTexturePack('gritty');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const h2 = hash();
      return { h1, h2, atlasChanged: h1 !== null && h2 !== null && h1 !== h2 };
    });
    await page.waitForTimeout(400);
    const after = await shot('pack-after');
    await page.evaluate(() => window.gfx.setTexturePack('default')); // restore
    const d = diffRegion(before.buf, after.buf, 0.2, 0.4, 0.8, 0.9); // centre terrain band
    if (packProbe.atlasChanged && d.pct > 1.0) {
      add('texture-pack', "setTexturePack('gritty') changes terrain", 'PASS',
        `atlas canvas hash changed (${packProbe.h1} -> ${packProbe.h2}); ${d.pct.toFixed(1)}% of centre-frame pixels changed on screen`);
    } else if (packProbe.atlasChanged) {
      add('texture-pack', "setTexturePack('gritty') changes terrain", 'FAIL',
        `atlas swapped (hash ${packProbe.h1} -> ${packProbe.h2}) but on-screen terrain barely changed (${d.pct.toFixed(2)}%)`,
        'chunk meshes are not using gfx.materials — INTEGRATION.md Step 2 (greedy output pairs ONLY with gfx.materials)');
    } else {
      add('texture-pack', "setTexturePack('gritty') changes terrain", 'FAIL',
        `atlas canvas did not change (hash ${packProbe.h1} -> ${packProbe.h2})`,
        "INTEGRATION.md Step 3e: gfx.setTexturePack must rebuild + swap the atlas ('gritty' is a registry pack)");
    }
  }

  // (h) fps budget (ADVISORY — never fails the gate) ------------------------------
  const perf = await page.evaluate(async () => {
    const t0 = performance.now();
    let frames = 0;
    await new Promise((resolve) => {
      const tick = () => {
        frames++;
        if (performance.now() - t0 >= 5000) resolve(); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const secs = (performance.now() - t0) / 1000;
    let calls = null, tris = null;
    const r = (window.gfx && window.gfx.renderer)
      || (window.__game && window.__game.fx && window.__game.fx.post && window.__game.fx.post.renderer)
      || null;
    if (r && r.info && r.info.render) {
      // info auto-resets per render pass; accumulate a whole composed frame
      // (all passes) by disabling autoReset for exactly one rAF interval.
      const wasAuto = r.info.autoReset;
      // Bracket exactly one composed frame: our rAF callbacks run after the
      // game loop's (registration order), so reset lands after frame N's
      // passes and the read lands after frame N+1's.
      await new Promise((res) => requestAnimationFrame(() => {
        r.info.autoReset = false;
        r.info.reset();
        requestAnimationFrame(() => {
          calls = r.info.render.calls;
          tris = r.info.render.triangles;
          r.info.autoReset = wasAuto;
          r.info.reset();
          res();
        });
      }));
    }
    return { fps: +(frames / secs).toFixed(1), calls, tris };
  });
  add('fps', 'fps budget (advisory)', 'INFO',
    `${perf.fps} fps over 5s rAF sample` +
    (perf.calls !== null ? `; ${perf.calls} draw calls, ${perf.tris} tris/frame` : '; renderer.info unavailable') +
    ' — SwiftShader (software GL): absolute fps is NOT representative of real GPUs; advisory only, never gates');

  await shot('final');
} catch (err) {
  boot.notes.push('HARNESS ERROR: ' + (err?.stack || String(err)));
  if (checks.length === 0) {
    add('boot', 'game boots headless', 'FAIL', String(err?.message || err).slice(0, 300),
      'fix the boot before anything else — see server.log in ' + OPT.shotsDir);
  }
} finally {
  await cleanup();
}

// ---------------------------------------------------------------------------
// 4. Report
// ---------------------------------------------------------------------------
const gate = checks.filter((c) => c.status !== 'INFO' && c.status !== 'SKIP');
const failed = gate.filter((c) => c.status === 'FAIL');
const ok = failed.length === 0 && gate.length > 0;

if (OPT.json) {
  console.log(JSON.stringify({ ok, boot, checks, shotsDir: OPT.shotsDir }, null, 2));
} else {
  log('');
  log(C.bold('verify-integration — GraphicsStack acceptance gate'));
  log(C.dim(`boot: ${boot.method || 'n/a'}  url: ${boot.url || 'n/a'}`));
  for (const n of boot.notes) log(C.dim('  note: ' + n));
  log('');
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    const tag = c.status === 'PASS' ? C.green('PASS') : c.status === 'FAIL' ? C.red('FAIL')
      : c.status === 'SKIP' ? C.yellow('SKIP') : C.dim('INFO');
    log(`  ${tag}  ${c.name.padEnd(width)}  ${c.evidence}`);
    if (c.hint && c.status !== 'PASS') log(`        ${''.padEnd(width)}  ${C.yellow('-> ' + c.hint)}`);
  }
  log('');
  log(ok ? C.green(C.bold('GATE: PASS — GraphicsStack is live in the game.')) :
    C.red(C.bold(`GATE: FAIL — ${failed.length} of ${gate.length} required checks red.`)));
  log(C.dim(`screenshots + server.log: ${OPT.shotsDir}`));
}

process.exit(ok ? 0 : 1);
