#!/usr/bin/env node
// scripts/verify-audio.mjs
//
// Headless-Chromium verification suite for the procedural audio engine
// (audio/sfx/index.js registry + audio/engine.js music/positional engine).
//
// Renders every registered sound (and each music mode) through an
// OfflineAudioContext inside real Chromium and checks peak/RMS bounds, so CI
// and humans run the exact same thing:
//
//   node scripts/verify-audio.mjs
//
// Environment surface (all optional):
//   PW_DIR        Directory whose node_modules contains playwright(-core),
//                 e.g. "$RUNNER_TEMP/pw" in CI. Checked first, then /tmp/pw,
//                 then process.cwd(). The repo itself has NO package.json.
//   CHROMIUM_PATH Explicit Chromium executable. If unset, a chrome binary is
//                 looked up under /opt/pw-browsers (local dev containers);
//                 if that also misses, Playwright resolves its own installed
//                 browser (the CI path after `npx playwright install chromium`).
//   AUDIO_PORT    Port for the static server (default: 8123 + random 0..500
//                 to dodge collisions between concurrent runs).
//   AUDIO_REPORT  Path to write the full JSON report to.
//
// Exit codes: 0 = no FAILs (SKIPs are fine) or no audio/ dir at all; 1 = any
// FAIL or infrastructure error.
//
// Plain Node ESM. No repo package.json. Only node builtins plus a dynamically
// resolved playwright.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// 0. Pass bounds — the single source of truth, forwarded into the page.
//    These match the verified suite on feature/audio-engine.
// ---------------------------------------------------------------------------
const BOUNDS = {
  sfxPeakMin: 0.05,      // every one-shot / loop must peak within...
  sfxPeakMax: 0.99,      // ...this window (audible but not clipping)
  musicPeakMin: 0.02,    // music mode peak window
  musicPeakMax: 0.9,
  musicRmsMin: 0.0008,   // music must have sustained energy, not one blip
  posPeakMin: 0.02,      // positional test: sound must be audible...
  panImbalanceMin: 0.1,  // ...and L/R RMS must differ by >=10% (panning alive)
};
const SAMPLE_RATE = 44100;
const SEED = 42; // deterministic renders via mulberry32(SEED)

// ---------------------------------------------------------------------------
// 1. Graceful skip when the audio engine has not landed on this branch yet.
//    (feature/ci must be green standalone; audio/ arrives when PR #1 merges.)
// ---------------------------------------------------------------------------
const audioDir = path.join(process.cwd(), 'audio');
if (!fs.existsSync(audioDir)) {
  console.log('no audio/ directory — skipping audio verification');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Resolve playwright WITHOUT a repo package.json.
//    createRequire() anchored at candidate dirs lets us load a package from
//    <dir>/node_modules (or any ancestor) as if a module there required it.
// ---------------------------------------------------------------------------
function resolvePlaywright() {
  const candidateDirs = [];
  if (process.env.PW_DIR) candidateDirs.push(process.env.PW_DIR);
  candidateDirs.push('/tmp/pw', process.cwd());

  const attempts = [];
  for (const dir of candidateDirs) {
    // The anchor file does not need to exist; it only sets the resolution root.
    const req = createRequire(path.join(dir, '__resolve_anchor__.js'));
    for (const pkg of ['playwright-core', 'playwright']) {
      try {
        return { pw: req(pkg), resolvedFrom: `${pkg} via ${dir}` };
      } catch (err) {
        attempts.push(`  ${pkg} via ${dir}: ${err.code || err.message}`);
      }
    }
  }
  throw new Error(
    'Could not resolve playwright. Attempts:\n' + attempts.join('\n') +
    '\nHint: set PW_DIR to a directory containing node_modules/playwright-core' +
    ' (e.g. mkdir -p "$RUNNER_TEMP/pw" && npm --prefix "$RUNNER_TEMP/pw" install playwright).'
  );
}

// ---------------------------------------------------------------------------
// 3. Locate a Chromium executable.
//    Priority: CHROMIUM_PATH env > /opt/pw-browsers glob (dev containers) >
//    undefined (playwright falls back to its own installed browser — CI).
// ---------------------------------------------------------------------------
function findChromiumExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;

  const root = '/opt/pw-browsers';
  if (!fs.existsSync(root)) return undefined;

  // Glob chromium*/chrome-linux/chrome. The existence check on the binary
  // filters out non-browser siblings like chromium_headless_shell-*.
  let entries = [];
  try {
    entries = fs.readdirSync(root).filter((e) => e.startsWith('chromium')).sort();
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const bin = path.join(root, entry, 'chrome-linux', 'chrome');
    if (fs.existsSync(bin)) return bin;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 4. Embedded static file server (node:http, zero dependencies).
//    Serves process.cwd() so ANY checkout location works: git worktrees,
//    /home/runner/work/<repo>/<repo> on GitHub-hosted runners, local clones.
//    We deliberately do NOT spawn audio/server.mjs — it hardcodes its serve
//    root to one developer-machine path, which 404s every request from any
//    other checkout (and audio/ is owned by another branch, so it cannot be
//    fixed from here).
// ---------------------------------------------------------------------------
const MIME_TYPES = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
};

function createStaticServer(rootDir) {
  const root = path.resolve(rootDir);
  return http.createServer((req, res) => {
    const baseHeaders = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    const fail = (status, msg) => {
      res.writeHead(status, { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(msg);
    };

    let filePath;
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      filePath = path.normalize(path.join(root, pathname));
    } catch {
      return fail(400, 'bad request');
    }
    // Path-traversal guard: the resolved target must stay inside the root.
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      return fail(403, 'forbidden');
    }

    try {
      if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
      const body = fs.readFileSync(filePath);
      res.writeHead(200, {
        ...baseHeaders,
        'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      });
      res.end(body);
    } catch (err) {
      const notFound = err && err.code === 'ENOENT';
      return fail(notFound ? 404 : 500, notFound ? 'not found' : 'server error');
    }
  });
}

// Bind the server; on EADDRINUSE retry with a fresh random port unless the
// port was pinned via AUDIO_PORT.
async function startServer() {
  const pinned = Number(process.env.AUDIO_PORT) || 0;
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = pinned || 8123 + Math.floor(Math.random() * 501);
    const server = createStaticServer(process.cwd());
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, resolve);
      });
      return { server, port };
    } catch (err) {
      lastErr = err;
      try { server.close(); } catch { /* never listened */ }
      if (pinned || !err || err.code !== 'EADDRINUSE') break;
    }
  }
  throw new Error(`could not bind static server: ${lastErr}`);
}

// Sanity probe before launching Chromium: the entry module must serve as 200.
async function checkServer(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`static server unreachable at ${url}: ${err}`);
  }
  if (res.status !== 200) {
    throw new Error(
      `static server answered HTTP ${res.status} for ${url} — is audio/sfx/index.js present under ${process.cwd()}?`
    );
  }
}

// ---------------------------------------------------------------------------
// 5. The in-browser suite. Runs inside page.evaluate — browser APIs only.
//    Returns { fatal } or { results: [{name, kind, peak, rms, status, reason}] }.
// ---------------------------------------------------------------------------
async function browserSuite(cfg) {
  const { bounds, sampleRate, seed } = cfg;
  const results = [];
  const push = (name, kind, status, { peak = null, rms = null, reason = '' } = {}) =>
    results.push({ name, kind, status, peak, rms, reason });

  // --- load the modules under test (same-origin absolute paths) ------------
  const registry = (await import('/audio/sfx/index.js')).default;
  const { mulberry32 } = await import('/audio/dsp.js');

  const names = Object.keys(registry || {});
  if (names.length === 0) return { fatal: 'sfx registry is empty' };

  // --- helpers --------------------------------------------------------------
  const makeCtx = (seconds) =>
    new OfflineAudioContext(2, Math.ceil(sampleRate * seconds), sampleRate);

  function stats(buffer) {
    let peak = 0;
    let sumSq = 0;
    let n = 0;
    const perChannelRms = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      let chSumSq = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        chSumSq += v * v;
      }
      perChannelRms.push(Math.sqrt(chSumSq / data.length));
      sumSq += chSumSq;
      n += data.length;
    }
    return { peak, rms: Math.sqrt(sumSq / n), perChannelRms };
  }

  // Known ambient loops and long one-shot duration hints (seconds).
  const KNOWN_LOOPS = new Set(['wind', 'cave', 'rain']);
  const DURATION_HINTS = {
    thunder: 4,
    'thunder.distant': 4,
    explosion: 3,
    achievement: 2.5,
  };
  const LOOP_RENDER_S = 2.5; // loops render 2.5s with stop(2.0) to hear the fade
  const LOOP_STOP_AT = 2.0;

  function hintedSeconds(name) {
    if (name in DURATION_HINTS) return DURATION_HINTS[name];
    if (/^mob\..+\.death$/.test(name)) return 2; // mob.*.death ~1.5-2s tails
    return 1.5; // default one-shot window
  }

  // Render one registry entry. If the synth reports duration === Infinity we
  // treat it as a loop (render 2.5s + stop(2.0)) even when it is not in the
  // known set — future-proof against new ambient loops.
  async function renderSfx(name, extraOpts = {}) {
    const synth = registry[name];
    let asLoop = KNOWN_LOOPS.has(name);
    let seconds = asLoop ? LOOP_RENDER_S : hintedSeconds(name);

    for (let attempt = 0; attempt < 2; attempt++) {
      const ctx = makeCtx(seconds);
      const handle =
        synth(ctx, ctx.destination, 0, { rng: mulberry32(seed), velocity: 1, ...extraOpts }) || {};
      if (!asLoop && handle.duration === Infinity) {
        // Undeclared loop: throw this context away and re-render loop-style.
        asLoop = true;
        seconds = LOOP_RENDER_S;
        continue;
      }
      if (asLoop && typeof handle.stop === 'function') handle.stop(LOOP_STOP_AT);
      return stats(await ctx.startRendering());
    }
  }

  // --- 5a. every registered sound: peak must land in [sfxPeakMin, sfxPeakMax]
  for (const name of names) {
    try {
      const { peak, rms } = await renderSfx(name);
      const ok = peak >= bounds.sfxPeakMin && peak <= bounds.sfxPeakMax;
      push(name, 'sfx', ok ? 'PASS' : 'FAIL', {
        peak,
        rms,
        reason: ok ? '' : `peak ${peak.toFixed(4)} outside [${bounds.sfxPeakMin}, ${bounds.sfxPeakMax}]`,
      });
    } catch (err) {
      push(name, 'sfx', 'FAIL', { reason: `threw: ${err && err.message}` });
    }
  }

  // --- 5b. rain intensity scaling: rms@1.0 must exceed rms@0.15 -------------
  if ('rain' in registry) {
    try {
      const hi = await renderSfx('rain', { intensity: 1.0 });
      const lo = await renderSfx('rain', { intensity: 0.15 });
      const ok = hi.rms > lo.rms;
      push('rain.intensity-scaling', 'check', ok ? 'PASS' : 'FAIL', {
        peak: hi.peak,
        rms: hi.rms,
        reason: `rms@1.0=${hi.rms.toFixed(5)} vs rms@0.15=${lo.rms.toFixed(5)}`,
      });
    } catch (err) {
      push('rain.intensity-scaling', 'check', 'FAIL', { reason: `threw: ${err && err.message}` });
    }
  }

  // --- 5c. music modes: 6s offline render per mode ---------------------------
  let AudioEngine = null;
  try {
    AudioEngine = (await import('/audio/engine.js')).default;
  } catch (err) {
    push('music', 'music', 'FAIL', { reason: `failed to import /audio/engine.js: ${err && err.message}` });
  }

  if (AudioEngine) {
    const modes = Array.isArray(AudioEngine.MUSIC_MODES)
      ? AudioEngine.MUSIC_MODES
      : ['calm', 'nether', 'upbeat', 'melancholy', 'mysterious'];

    for (const mode of modes) {
      const label = `music:${mode}`;
      try {
        const ctx = makeCtx(6);
        const engine = new AudioEngine({ ctx }); // buses built immediately
        let ret;
        try {
          ret = engine.startMusic(mode, { seed }); // first ~6-8s scheduled synchronously
        } catch (err) {
          if (/unknown mode/i.test(String(err && err.message))) {
            push(label, 'music', 'SKIP', { reason: `unknown mode: ${err.message}` });
            continue;
          }
          throw err;
        }
        if (!ret) {
          push(label, 'music', 'SKIP', { reason: 'startMusic returned falsy (mode unsupported)' });
          continue;
        }
        const { peak, rms } = stats(await ctx.startRendering());
        const ok =
          peak >= bounds.musicPeakMin && peak <= bounds.musicPeakMax && rms > bounds.musicRmsMin;
        push(label, 'music', ok ? 'PASS' : 'FAIL', {
          peak,
          rms,
          reason: ok
            ? ''
            : `need peak in [${bounds.musicPeakMin}, ${bounds.musicPeakMax}] and rms > ${bounds.musicRmsMin}`,
        });
      } catch (err) {
        push(label, 'music', 'FAIL', { reason: `threw: ${err && err.message}` });
      }
    }

    // --- 5d. positional audio: source at x=5, listener at origin -------------
    if ('break.stone' in registry) {
      const label = 'positional:break.stone';
      try {
        const ctx = makeCtx(1.5); // fresh offline ctx; listener defaults to origin
        const engine = new AudioEngine({ ctx });
        engine.play('break.stone', { pos: { x: 5, y: 0, z: 0 } });
        const { peak, perChannelRms } = stats(await ctx.startRendering());
        const [l = 0, r = 0] = perChannelRms;
        const imbalance = Math.abs(l - r) / (Math.max(l, r) || 1);
        const ok = peak > bounds.posPeakMin && imbalance >= bounds.panImbalanceMin;
        push(label, 'positional', ok ? 'PASS' : 'FAIL', {
          peak,
          rms: Math.max(l, r),
          reason:
            `L rms=${l.toFixed(5)} R rms=${r.toFixed(5)} imbalance=${(imbalance * 100).toFixed(1)}%` +
            (ok ? '' : ` (need peak > ${bounds.posPeakMin} and imbalance >= ${bounds.panImbalanceMin * 100}%)`),
        });
      } catch (err) {
        push(label, 'positional', 'FAIL', { reason: `threw: ${err && err.message}` });
      }
    } else {
      push('positional:break.stone', 'positional', 'SKIP', { reason: 'break.stone not in registry' });
    }
  }

  return { results };
}

// ---------------------------------------------------------------------------
// 6. Reporting.
// ---------------------------------------------------------------------------
function printTable(results) {
  const nameW = Math.max(4, ...results.map((r) => r.name.length));
  console.log(`${'NAME'.padEnd(nameW)}  ${'PEAK'.padEnd(8)}  ${'RMS'.padEnd(9)}  STATUS`);
  for (const r of results) {
    const peak = r.peak == null ? '-'.padEnd(8) : r.peak.toFixed(4).padEnd(8);
    const rms = r.rms == null ? '-'.padEnd(9) : r.rms.toFixed(5).padEnd(9);
    const tail = r.reason ? `  ${r.reason}` : '';
    console.log(`${r.name.padEnd(nameW)}  ${peak}  ${rms}  ${r.status}${tail}`);
  }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main() {
  const { pw, resolvedFrom } = resolvePlaywright();
  console.log(`playwright: ${resolvedFrom}`);

  const executablePath = findChromiumExecutable();
  console.log(`chromium: ${executablePath || '(playwright-managed browser)'}`);

  let browser = null;
  let server = null;
  try {
    const started = await startServer();
    server = started.server;
    const port = started.port;
    const base = `http://localhost:${port}`;
    await checkServer(`${base}/audio/sfx/index.js`);
    console.log(`static server: ${base} (embedded node:http, serving ${process.cwd()})`);

    browser = await pw.chromium.launch({
      headless: true,
      executablePath, // undefined => playwright resolves its own install
      args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(180_000); // ~70 offline renders; give them room
    page.on('pageerror', (err) => console.error(`[pageerror] ${err.message}`));

    // Navigating to a same-origin page (even a 404) gives the page the server
    // origin, so the suite's dynamic import('/audio/...') calls resolve there.
    await page.goto(`${base}/audio/demo.html`, { waitUntil: 'domcontentloaded' });

    const outcome = await page.evaluate(browserSuite, {
      bounds: BOUNDS,
      sampleRate: SAMPLE_RATE,
      seed: SEED,
    });

    if (outcome.fatal) {
      console.error(`FATAL: ${outcome.fatal}`);
      process.exitCode = 1;
      return;
    }

    const results = outcome.results;
    printTable(results);

    const passed = results.filter((r) => r.status === 'PASS').length;
    const failed = results.filter((r) => r.status === 'FAIL').length;
    const skipped = results.filter((r) => r.status === 'SKIP').length;
    console.log(
      `\naudio verification: ${passed} passed, ${failed} failed, ${skipped} skipped (${results.length} checks)`
    );

    if (process.env.AUDIO_REPORT) {
      const report = {
        startedAt: new Date().toISOString(),
        cwd: process.cwd(),
        port,
        chromium: executablePath || null,
        playwright: resolvedFrom,
        bounds: BOUNDS,
        summary: { total: results.length, passed, failed, skipped },
        results,
      };
      fs.mkdirSync(path.dirname(path.resolve(process.env.AUDIO_REPORT)), { recursive: true });
      fs.writeFileSync(process.env.AUDIO_REPORT, JSON.stringify(report, null, 2));
      console.log(`report written to ${process.env.AUDIO_REPORT}`);
    }

    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
