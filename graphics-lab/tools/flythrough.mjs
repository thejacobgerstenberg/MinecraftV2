// flythrough.mjs — scripted 12-moment showcase flythrough of the lab island
// demo (index.html?nogui=1) across all three dimensions x four times of day,
// with the camera gliding along a smooth path between staged moments.
//
// Usage:
//   node tools/flythrough.mjs [--port=8143] [--out=DIR] [--only=w1,c3,...]
//
// Everything is rAF-paced: under SwiftShader the demo runs ~1 fps and clamps
// dt to 0.05 s, so N rAF frames ~= N*0.05 s of sim time. Each moment glides
// the camera over GLIDE frames, then settles SETTLE frames before capture.
//
// Frames land in --out (default: the session scratchpad) as <id>-<slug>.png,
// 1600x900 each. A summary JSON (moments, per-frame luminance stats, console
// errors) is written next to them as flythrough-result.json.

import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2)
  .map((a) => a.replace(/^--/, '').split('='))
  .map(([k, v]) => [k, v === undefined ? true : v]));

const PORT = args.port || '8143';
const OUT = args.out
  || '/tmp/claude-0/-home-user-MinecraftV2/b9698840-b493-5b79-8ce9-ff36d8dc7c66/scratchpad/shots';
const ONLY = args.only ? String(args.only).split(',') : null;
const URL = `http://127.0.0.1:${PORT}/index.html?nogui=1`;

const GLIDE = 14;   // rAF frames of camera travel between moments
const SETTLE = 20;  // rAF frames to let the staged moment settle pre-capture

fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// The 12 staged moments. Scene geography (from src/demo.js):
//   island volume 0..48, WATER_LEVEL=10, centre ~(24,12,24)
//   waterfall: south face, x=14, z~48.3..48.85, y 10..17 (FlowFalls)
//   lavafall (cinderloom only): north face, x=10.5, z~-0.3..-0.85, y 10..19
//   portal: frame around (22, 16..21, 25.5); cabin near (30, 20, 16)
//   lake bowl: centre (13, 34), r=10 — underwater framing is built into
//   demo.setUnderwater(true) (frameUnderwater()).
// Beauty presets are used as anchors and varied so the 12 shots don't repeat.
// ---------------------------------------------------------------------------
const MOMENTS = [
  // ---- WARPWOLD -----------------------------------------------------------
  { id: 'w1', dimension: 'warpwold', time: 0.25, slug: 'warpwold-dawn-waterfall',
    label: 'WARPWOLD · dawn 0.25 — waterfall closeup',
    pos: [23, 14.5, 61], target: [14, 13.2, 48.3] },
  { id: 'w2', dimension: 'warpwold', time: 0.40, slug: 'warpwold-day-underwater',
    label: 'WARPWOLD · day 0.40 — underwater caustics',
    underwater: true, biolum: true, settle: 26 },
  { id: 'w3', dimension: 'warpwold', time: 0.725, slug: 'warpwold-dusk-diorama',
    label: 'WARPWOLD · dusk 0.73 — golden-hour diorama',
    pos: [-23, 23, 61], target: [22, 13, 23] },
  { id: 'w4', dimension: 'warpwold', time: 0.85, slug: 'warpwold-night-portal',
    label: 'WARPWOLD · night 0.85 — portal gate',
    pos: [19.5, 18.2, 36], target: [22, 18.6, 25.5] },
  // ---- CINDERLOOM ---------------------------------------------------------
  { id: 'c1', dimension: 'cinderloom', time: 0.25, slug: 'cinderloom-dawn-lavafall',
    label: 'CINDERLOOM · dawn 0.25 — lavafall closeup',
    pos: [16, 15, -14], target: [10.5, 13.5, -0.4], settle: 28 },
  { id: 'c2', dimension: 'cinderloom', time: 0.40, slug: 'cinderloom-day-wide',
    label: 'CINDERLOOM · day 0.40 — ember island wide',
    // Re-frame attempt (lower SE camera) lost to this original framing: the
    // cliff face swallowed the frame as pure black. Kept the high east wide.
    pos: [57, 24, 43], target: [20, 13, 20], settle: 30 },
  { id: 'c3', dimension: 'cinderloom', time: 0.78, slug: 'cinderloom-dusk-beauty',
    label: 'CINDERLOOM · dusk 0.78 — ember dusk (beauty)',
    pos: [2, 27, -24], target: [24, 11, 30] },
  { id: 'c4', dimension: 'cinderloom', time: 0.85, slug: 'cinderloom-night-torches',
    label: 'CINDERLOOM · night 0.85 — torch terraces',
    pos: [27.5, 18.5, 22.5], target: [33.5, 16.5, 27.5] },
  // ---- NEVERMEND ----------------------------------------------------------
  { id: 'n1', dimension: 'nevermend', time: 0.25, slug: 'nevermend-dawn-west',
    label: 'NEVERMEND · dawn 0.25 — pale dawn from the west',
    pos: [-22, 17, 32], target: [26, 15, 23], settle: 28 },
  { id: 'n2', dimension: 'nevermend', time: 0.40, slug: 'nevermend-day-snow',
    label: 'NEVERMEND · day 0.40 — snow squall',
    weather: 'snow', pos: [-14, 26, 62], target: [26, 18, 20], settle: 34 },
  { id: 'n3', dimension: 'nevermend', time: 0.75, slug: 'nevermend-dusk-cabin',
    label: 'NEVERMEND · dusk 0.75 — cabin closeup',
    pos: [38, 25, 27], target: [29.5, 20.5, 16.5] },
  { id: 'n4', dimension: 'nevermend', time: 0.85, slug: 'nevermend-night-aurora',
    label: 'NEVERMEND · night 0.85 — aurora curtains (beauty)',
    // Re-frame attempt (tilt +9 target y toward the ribbon band) lost to this
    // original framing: the island shrank to a rim and the frame went empty.
    pos: [12, 20, 70], target: [58, 33, -6], settle: 40 },
];

// ---------------------------------------------------------------------------

function lumStats(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const { data } = png;
  let n = 0, sum = 0, sumSq = 0;
  for (let i = 0; i < data.length; i += 4 * 7) {
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += l; sumSq += l * l; n++;
  }
  const mean = sum / n;
  return {
    mean: +mean.toFixed(1),
    std: +Math.sqrt(Math.max(0, sumSq / n - mean * mean)).toFixed(1),
    width: png.width, height: png.height,
  };
}

const consoleErrors = [];
const captured = [];

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1,
});
const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push('[console] ' + m.text());
});
page.on('pageerror', (e) => {
  consoleErrors.push('[pageerror] ' + (e && e.stack ? e.stack : String(e)));
});

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__demoReady === true, null, {
  timeout: 90000, polling: 500,
});
console.log('demo ready');

// Wait n rAF frames inside the page.
const raf = (n) => page.evaluate((frames) => new Promise((resolve) => {
  let i = 0;
  const step = () => { if (++i >= frames) resolve(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), n);

// Smooth (smoothstep-eased) camera path from the current pose to pos/target.
const glide = (pos, target, frames) => page.evaluate(({ pos, target, frames }) =>
  new Promise((resolve) => {
    const d = window.demo;
    d.controls.autoRotate = false;
    const p0 = { x: d.camera.position.x, y: d.camera.position.y, z: d.camera.position.z };
    const t0 = { x: d.controls.target.x, y: d.controls.target.y, z: d.controls.target.z };
    let i = 0;
    const step = () => {
      i++;
      const k = Math.min(1, i / frames);
      const s = k * k * (3 - 2 * k); // smoothstep
      d.camera.position.set(
        p0.x + (pos[0] - p0.x) * s, p0.y + (pos[1] - p0.y) * s, p0.z + (pos[2] - p0.z) * s);
      d.controls.target.set(
        t0.x + (target[0] - t0.x) * s, t0.y + (target[1] - t0.y) * s, t0.z + (target[2] - t0.z) * s);
      if (i >= frames) resolve(); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), { pos, target, frames });

// One-time staging: quality high, everything on, scenic mode for clean frames.
await page.evaluate(() => {
  const d = window.demo;
  d.setQuality('high');
  d.setScenicMode(true);
  for (const t of ['ao', 'sky', 'shadows', 'water', 'post', 'particles', 'fog',
    'portal', 'crack', 'torchlights', 'wind', 'biome', 'ssao', 'godrays',
    'bloom', 'greedy', 'falls', 'underwaterfx', 'ambient', 'reflections']) {
    d.toggle(t, true);
  }
  d.setWeather('clear');
});
await raf(6);

for (const m of MOMENTS) {
  if (ONLY && !ONLY.includes(m.id)) continue;
  const t0 = Date.now();

  await page.evaluate(({ dimension, time, weather, biolum, underwater }) => {
    const d = window.demo;
    if (d._flyDim !== dimension) { d.setDimension(dimension); d._flyDim = dimension; }
    d.setTimeOfDay(time);
    d.setWeather(weather || 'clear');
    d.toggle('biolum', !!biolum);
    if (!underwater) d.setUnderwater(false);
  }, m);

  if (m.underwater) {
    // frameUnderwater() stages the tested submerged framing for us.
    await page.evaluate(() => window.demo.setUnderwater(true));
  } else {
    await glide(m.pos, m.target, GLIDE);
  }
  await raf(m.settle || SETTLE);

  const file = path.join(OUT, `${m.id}-${m.slug}.png`);
  await page.screenshot({ path: file });
  const stats = lumStats(file);
  captured.push({ ...m, file, stats });
  console.log(`${m.id} ${m.slug} ${JSON.stringify(stats)} ${(Date.now() - t0) / 1000}s`);

  if (m.underwater) await page.evaluate(() => {
    window.demo.setUnderwater(false);
    window.demo.toggle('biolum', false);
  });
}

const result = { url: URL, consoleErrors: [...new Set(consoleErrors)], captured };
fs.writeFileSync(path.join(OUT, 'flythrough-result.json'), JSON.stringify(result, null, 2));
console.log('console errors:', result.consoleErrors.length);
for (const e of result.consoleErrors) console.log('  ' + e);

await browser.close();
