// graphics-lab/textures/selftest.mjs
//
// Node self-test for the Loomfall texture-pack system.
//
//   node graphics-lab/textures/selftest.mjs            # full run (node + browser)
//   SKIP_BROWSER=1 node graphics-lab/textures/selftest.mjs   # pure-node parts only
//
// Part A (pure node, no three): renders every tile of every pack through a
// tiny software Canvas2D shim and checks:
//   1. TILE_NAMES starts with the builder's exact 33-name prefix (order frozen)
//   2. every TILE_NAME has a painter; unknown names warn once + missing-tile art
//   3. determinism — two full renders are byte-identical
//   4. pack metric rubric (brand packVariants):
//        smooth  mean-sat >= 1.2x default
//        gritty  mean-sat <= 0.7x default,  contrast >= 1.3x default
//        accessible mean contrast >= 1.4x default
//   5. seamless tiling (torus seam gradient vs interior gradient) for all
//      opaque tiles in all packs
//
// Part B (Playwright + chromium/swiftshader): loads test.html, which builds
// real atlases via atlas.js + three and re-runs determinism, genTexture
// consistency, UV fallback, and the 2x2-draw tiling test on real canvases.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TILE_NAMES, PAINTERS, makeRng } from './painters.js';
import { PACK_REGISTRY } from './packs.js';
import { TILE_PX } from './packFormat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAB_ROOT = path.resolve(__dirname, '..');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS  ${msg}`);
  else { failures++; console.error(`  FAIL  ${msg}`); }
};

// ---------------------------------------------------------------------------
// Minimal software Canvas2D shim — exactly the surface painters.js uses:
// fillStyle (rgba string), fillRect, clearRect, getImageData, putImageData.
// ---------------------------------------------------------------------------
function shimCanvas(w, h) {
  const data = new Float64Array(w * h * 4); // premul-free float RGBA 0..255 / alpha 0..1
  const ctx = {
    canvas: { width: w, height: h },
    fillStyle: 'rgba(0,0,0,1)',
    globalAlpha: 1,
    imageSmoothingEnabled: false,
    fillRect(x, y, rw, rh) {
      const [r, g, b, a] = parseColor(this.fillStyle);
      const al = a * this.globalAlpha;
      if (al <= 0) return;
      const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(w, Math.floor(x + rw)), y1 = Math.min(h, Math.floor(y + rh));
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * 4;
          const da = data[i + 3];
          const oa = al + da * (1 - al);
          if (oa <= 0) continue;
          data[i] = (r * al + data[i] * da * (1 - al)) / oa;
          data[i + 1] = (g * al + data[i + 1] * da * (1 - al)) / oa;
          data[i + 2] = (b * al + data[i + 2] * da * (1 - al)) / oa;
          data[i + 3] = oa;
        }
      }
    },
    clearRect(x, y, rw, rh) {
      const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(w, Math.floor(x + rw)), y1 = Math.min(h, Math.floor(y + rh));
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * 4;
          data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
        }
      }
    },
    getImageData(x, y, rw, rh) {
      const out = new Uint8ClampedArray(rw * rh * 4);
      for (let yy = 0; yy < rh; yy++) {
        for (let xx = 0; xx < rw; xx++) {
          const si = ((y + yy) * w + (x + xx)) * 4;
          const di = (yy * rw + xx) * 4;
          out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2];
          out[di + 3] = data[si + 3] * 255;
        }
      }
      return { data: out, width: rw, height: rh };
    },
    putImageData(img, x, y) {
      for (let yy = 0; yy < img.height; yy++) {
        for (let xx = 0; xx < img.width; xx++) {
          const si = (yy * img.width + xx) * 4;
          const di = ((y + yy) * w + (x + xx)) * 4;
          data[di] = img.data[si]; data[di + 1] = img.data[si + 1]; data[di + 2] = img.data[si + 2];
          data[di + 3] = img.data[si + 3] / 255;
        }
      }
    },
  };
  return ctx;
}

const colorCache = new Map();
function parseColor(s) {
  let c = colorCache.get(s);
  if (c) return c;
  const m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (!m) throw new Error(`shim: unsupported fillStyle "${s}"`);
  const p = m[1].split(',').map(Number);
  c = [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  colorCache.set(s, c);
  return c;
}

function renderTile(pack, name, seed = 0) {
  const ctx = shimCanvas(TILE_PX, TILE_PX);
  pack.drawTile(ctx, name, TILE_PX, makeRng(`${pack.id}:${name}:${seed}`));
  return ctx.getImageData(0, 0, TILE_PX, TILE_PX);
}

// ---------------------------------------------------------------------------
// Metrics.
// ---------------------------------------------------------------------------
const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

function packMetrics(pack) {
  let satSum = 0, satN = 0, stdSum = 0, stdN = 0;
  for (const name of TILE_NAMES) {
    const img = renderTile(pack, name);
    const d = img.data;
    let lSum = 0, lSq = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 10) continue;
      const mx = Math.max(d[i], d[i + 1], d[i + 2]);
      const mn = Math.min(d[i], d[i + 1], d[i + 2]);
      satSum += mx > 0 ? (mx - mn) / mx : 0;
      satN++;
      const l = luma(d, i);
      lSum += l; lSq += l * l; n++;
    }
    if (n > 0) {
      const mean = lSum / n;
      stdSum += Math.sqrt(Math.max(0, lSq / n - mean * mean));
      stdN++;
    }
  }
  return { meanSat: satSum / satN, contrast: stdSum / stdN };
}

// Seam analysis on the tile torus, per axis. A seam is OK if the gradient
// across the wrap is no stronger than (a) 2.5x the mean interior gradient
// (+6 luma floor for near-flat tiles), or (b) 1.35x the STRONGEST legitimate
// interior edge in the same direction — blocky patterns (bricks, planks,
// weave) put a real pattern edge on the wrap line, and that edge is only a
// seam if it is louder than the pattern's own interior edges.
// (Equivalent to drawing the tile 2x2 and inspecting the boundary rows/cols —
// the browser test in test.html does it literally that way.)
function seamStats(img) {
  const { data: d, width: W, height: H } = img;
  const L = (x, y) => luma(d, (y * W + x) * 4);
  // horizontal wrap (left-right continuation)
  let bH = 0, iSumH = 0, colMax = 0;
  for (let x = 0; x < W; x++) {
    let col = 0;
    const x2 = (x + 1) % W;
    for (let y = 0; y < H; y++) col += Math.abs(L(x, y) - L(x2, y));
    col /= H;
    if (x === W - 1) bH = col;
    else { iSumH += col; colMax = Math.max(colMax, col); }
  }
  const iAvgH = iSumH / (W - 1);
  // vertical wrap (top-bottom continuation)
  let bV = 0, iSumV = 0, rowMax = 0;
  for (let y = 0; y < H; y++) {
    let row = 0;
    const y2 = (y + 1) % H;
    for (let x = 0; x < W; x++) row += Math.abs(L(x, y) - L(x, y2));
    row /= W;
    if (y === H - 1) bV = row;
    else { iSumV += row; rowMax = Math.max(rowMax, row); }
  }
  const iAvgV = iSumV / (H - 1);
  const okH = bH <= Math.max(colMax * 1.35, iAvgH * 2.5 + 6);
  const okV = bV <= Math.max(rowMax * 1.35, iAvgV * 2.5 + 6);
  return { okH, okV, bH, bV, iAvgH, iAvgV };
}

function isOpaque(img) {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return false;
  return true;
}

// Tiles allowed to skip the seam check, with reasons (reported).
const TILING_EXEMPT = {
  water: 'liquid overlay tile with alpha ripple',
  lava: 'liquid tile (painted with torus noise anyway; checked if opaque)',
  glass: 'mostly-transparent pane art',
  leaves: 'alpha holes by design',
  torch: 'sprite-style art on transparent background',
  portal: 'semi-transparent swirl art',
  door_upper: 'door art — never terrain-tiled',
  door_lower: 'door art — never terrain-tiled',
};

// Banded side-art tiles: horizontal wrap must still pass; the vertical wrap
// is exempt because the tile is a hard top-band-over-base composition and the
// block never stacks against itself vertically as terrain.
const VERTICAL_EXEMPT = {
  snow_side: 'snow cap band over dirt — bright band edge, never self-stacked',
};

// ---------------------------------------------------------------------------
// Part A.
// ---------------------------------------------------------------------------
console.log('== Part A: pure-node checks ==');

// 1. Builder 33-name prefix, frozen order.
const BUILDER_33 = [
  'grass_top', 'grass_side', 'dirt', 'stone', 'sand', 'water',
  'log_top', 'log_side', 'leaves', 'planks', 'glass', 'cobblestone',
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'bedrock', 'snow',
  'snow_side', 'cactus_top', 'cactus_side', 'gravel', 'netherrack',
  'soul_sand', 'glowstone', 'obsidian', 'end_stone', 'purpur', 'red_sand',
  'sandstone', 'sandstone_top', 'lava', 'portal',
];
ok(
  BUILDER_33.every((n, i) => TILE_NAMES[i] === n),
  'TILE_NAMES starts with the builder\'s exact 33-name prefix in order',
);
ok(TILE_NAMES.length === 55, `TILE_NAMES has 55 entries (got ${TILE_NAMES.length})`);
ok(new Set(TILE_NAMES).size === TILE_NAMES.length, 'TILE_NAMES has no duplicates');

// 2. Painter coverage.
const missingPainters = TILE_NAMES.filter((n) => !PAINTERS[n]);
ok(missingPainters.length === 0, `every tile has a painter${missingPainters.length ? ' (missing: ' + missingPainters.join(', ') + ')' : ''}`);
ok(Object.keys(PACK_REGISTRY).length === 5, `5 packs registered (${Object.keys(PACK_REGISTRY).join(', ')})`);

// 3. Determinism: two full renders identical; different seeds differ.
{
  let identical = true, seedDiffers = false;
  for (const pack of Object.values(PACK_REGISTRY)) {
    for (const name of TILE_NAMES) {
      const a = renderTile(pack, name, 0);
      const b = renderTile(pack, name, 0);
      if (Buffer.compare(Buffer.from(a.data.buffer), Buffer.from(b.data.buffer)) !== 0) {
        identical = false;
        console.error(`    non-deterministic: ${pack.id}/${name}`);
      }
    }
  }
  const s0 = renderTile(PACK_REGISTRY.default, 'stone', 0);
  const s1 = renderTile(PACK_REGISTRY.default, 'stone', 1);
  seedDiffers = Buffer.compare(Buffer.from(s0.data.buffer), Buffer.from(s1.data.buffer)) !== 0;
  ok(identical, 'determinism: two renders of all 275 (pack,tile) pairs are byte-identical');
  ok(seedDiffers, 'seed sensitivity: seed=1 produces different pixels than seed=0');
}

// 4. Pack metric rubric.
{
  const m = {};
  for (const id of Object.keys(PACK_REGISTRY)) m[id] = packMetrics(PACK_REGISTRY[id]);
  const d = m.default;
  console.log('  pack metrics (mean HSV saturation / mean per-tile luma stddev):');
  for (const [id, v] of Object.entries(m)) {
    console.log(`    ${id.padEnd(10)} sat=${v.meanSat.toFixed(4)} (${(v.meanSat / d.meanSat).toFixed(3)}x)  contrast=${v.contrast.toFixed(2)} (${(v.contrast / d.contrast).toFixed(3)}x)`);
  }
  ok(m.smooth.meanSat >= 1.2 * d.meanSat, `smooth mean-sat >= 1.2x default (${(m.smooth.meanSat / d.meanSat).toFixed(3)}x)`);
  ok(m.gritty.meanSat <= 0.7 * d.meanSat, `gritty mean-sat <= 0.7x default (${(m.gritty.meanSat / d.meanSat).toFixed(3)}x)`);
  ok(m.gritty.contrast >= 1.3 * d.contrast, `gritty contrast >= 1.3x default (${(m.gritty.contrast / d.contrast).toFixed(3)}x)`);
  ok(m.accessible.contrast >= 1.4 * d.contrast, `accessible (Loudstone) contrast >= 1.4x default (${(m.accessible.contrast / d.contrast).toFixed(3)}x)`);
}

// 5. Seamless tiling (node-side; the browser re-checks with real canvases).
{
  let tested = 0, passed = 0;
  const skipped = [];
  const fails = [];
  for (const pack of Object.values(PACK_REGISTRY)) {
    for (const name of TILE_NAMES) {
      const img = renderTile(pack, name);
      if (TILING_EXEMPT[name] && !isOpaque(img)) {
        skipped.push(`${pack.id}/${name}`);
        continue;
      }
      if (!isOpaque(img)) { skipped.push(`${pack.id}/${name} (non-opaque)`); continue; }
      tested++;
      const s = seamStats(img);
      const vOk = s.okV || !!VERTICAL_EXEMPT[name];
      if (s.okH && vOk) passed++;
      else fails.push(`${pack.id}/${name} bH=${s.bH.toFixed(2)}/${s.iAvgH.toFixed(2)}${s.okH ? '' : ' H!'} bV=${s.bV.toFixed(2)}/${s.iAvgV.toFixed(2)}${s.okV ? '' : ' V!'}`);
    }
  }
  console.log(`  tiling: ${passed}/${tested} opaque (pack,tile) pairs seam-clean; ${skipped.length} exempt (alpha/art tiles)`);
  if (fails.length) for (const f of fails) console.error(`    seam FAIL ${f}`);
  ok(fails.length === 0, 'all opaque tiles wrap seamlessly on the torus (node shim)');
}

// 6. Missing-tile fallback (warn once, magenta/black art).
{
  const pack = PACK_REGISTRY.default;
  const ctx = shimCanvas(TILE_PX, TILE_PX);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  pack.drawTile(ctx, '__bogus_tile__', TILE_PX, makeRng('default:__bogus_tile__:0'));
  pack.drawTile(ctx, '__bogus_tile__', TILE_PX, makeRng('default:__bogus_tile__:0'));
  console.warn = origWarn;
  const img = ctx.getImageData(0, 0, TILE_PX, TILE_PX);
  // paintMissing: 8px checker, (0,0) cell dark, (8,0) cell magenta.
  const darkAt0 = img.data[0] < 60 && img.data[2] < 60;
  const i8 = 8 * 4;
  const magentaAt8 = img.data[i8] > 200 && img.data[i8 + 1] < 60 && img.data[i8 + 2] > 200;
  ok(warnings.length === 1, `unknown tile warns exactly once (got ${warnings.length})`);
  ok(darkAt0 && magentaAt8, 'unknown tile renders the magenta/black missing pattern');
}

// ---------------------------------------------------------------------------
// Part B: browser checks via Playwright (test.html).
// ---------------------------------------------------------------------------
if (process.env.SKIP_BROWSER) {
  console.log('== Part B skipped (SKIP_BROWSER set) ==');
  finish();
} else {
  console.log('== Part B: browser checks (Playwright/chromium) ==');
  const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(LAB_ROOT, path.normalize(urlPath).replace(/^([/\\])+/, ''));
    if (!file.startsWith(LAB_ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });

  await new Promise((r) => server.listen(8123, '127.0.0.1', r));
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({
      executablePath: '/opt/pw-browsers/chromium',
      args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push('[console] ' + msg.text()); });
    await page.goto('http://127.0.0.1:8123/textures/test.html', { waitUntil: 'load', timeout: 30000 });
    const start = Date.now();
    let results = null;
    while (Date.now() - start < 60000) {
      results = await page.evaluate(() => (window.__testDone ? window.__testResults : null));
      if (results) break;
      await page.waitForTimeout(250);
    }
    await browser.close();

    ok(!!results, 'browser test page completed');
    if (results) {
      ok(pageErrors.length === 0, `no page errors (${pageErrors.length ? pageErrors.join(' | ') : 'clean'})`);
      ok(results.deterministic, 'browser: two buildAtlas() runs produce identical canvases');
      ok(results.genTextureMatches, 'browser: genTexture(3) pixels == atlas stone tile pixels');
      ok(results.uvFallback, 'browser: unknown tile name falls back to tile index 0 UVs');
      ok(results.uvContract, 'browser: tileUV half-texel inset + GL-space orientation contract');
      console.log(`  browser tiling (2x2 draw): ${results.tiling.passed}/${results.tiling.tested} pass, ${results.tiling.skipped} exempt`);
      if (results.tiling.fails.length) for (const f of results.tiling.fails) console.error(`    seam FAIL ${f}`);
      ok(results.tiling.fails.length === 0, 'browser: all opaque tiles tile 2x2 without seam lines');
    }
  } catch (e) {
    failures++;
    console.error('  FAIL  browser part errored: ' + (e && e.stack ? e.stack : e));
  } finally {
    server.close();
  }
  finish();
}

function finish() {
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
