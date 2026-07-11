// storyboard.mjs — composites the 12 flythrough stills into the two showcase
// contact sheets via the in-browser canvas compositor (tools/storyboard.html).
//
//   30-storyboard-1.png  warpwold 2x2 + cinderloom 2x2
//   31-storyboard-2.png  nevermend 2x2 + "best of" 2x2
//
// Usage: node tools/storyboard.mjs [--port=8143] [--shots=DIR]
// Sheets are written to graphics-lab/screenshots/.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2)
  .map((a) => a.replace(/^--/, '').split('='))
  .map(([k, v]) => [k, v === undefined ? true : v]));

const PORT = args.port || '8143';
const SHOTS = args.shots
  || '/tmp/claude-0/-home-user-MinecraftV2/b9698840-b493-5b79-8ce9-ff36d8dc7c66/scratchpad/shots';
const OUT = '/home/user/MinecraftV2/graphics-lab/screenshots';

const dataUrl = (name) => 'data:image/png;base64,'
  + fs.readFileSync(path.join(SHOTS, name)).toString('base64');

// Cell labels: TIME chip + framing note (kept short so they stay legible at
// thumbnail scale on the sheet).
const F = {
  w1: { src: 'w1-warpwold-dawn-waterfall.png', label: 'DAWN 0.25', sub: 'waterfall closeup' },
  w2: { src: 'w2-warpwold-day-underwater.png', label: 'DAY 0.40', sub: 'underwater caustics' },
  w3: { src: 'w3-warpwold-dusk-diorama.png', label: 'DUSK 0.73', sub: 'island diorama + falls' },
  w4: { src: 'w4-warpwold-night-portal.png', label: 'NIGHT 0.85', sub: 'portal gate' },
  c1: { src: 'c1-cinderloom-dawn-lavafall.png', label: 'DAWN 0.25', sub: 'lavafall closeup' },
  c2: { src: 'c2-cinderloom-day-wide.png', label: 'DAY 0.40', sub: 'ember island wide' },
  c3: { src: 'c3-cinderloom-dusk-beauty.png', label: 'DUSK 0.78', sub: 'ember dusk beauty' },
  c4: { src: 'c4-cinderloom-night-torches.png', label: 'NIGHT 0.85', sub: 'torch terraces' },
  n1: { src: 'n1-nevermend-dawn-west.png', label: 'DAWN 0.25', sub: 'pale dawn silhouette' },
  n2: { src: 'n2-nevermend-day-snow.png', label: 'DAY 0.40', sub: 'snow squall' },
  n3: { src: 'n3-nevermend-dusk-cabin.png', label: 'DUSK 0.75', sub: 'cabin closeup' },
  n4: { src: 'n4-nevermend-night-aurora.png', label: 'NIGHT 0.85', sub: 'aurora + moon' },
};
const cell = (id, over) => ({ src: dataUrl(F[id].src), label: over?.label || F[id].label, sub: over?.sub || F[id].sub });

const ACCENT = { warpwold: '#a98bff', cinderloom: '#ff8c3a', nevermend: '#8fd8e8', best: '#ffd75e' };

const SHEETS = [
  {
    out: '30-storyboard-1.png',
    title: 'graphics-lab showcase storyboard — 1 / 2',
    subtitle: 'scripted flythrough · 1600x900 stills · quality high, everything on',
    segments: [
      { header: 'WARPWOLD', accent: ACCENT.warpwold,
        cells: [cell('w1'), cell('w2'), cell('w3'), cell('w4')] },
      { header: 'CINDERLOOM', accent: ACCENT.cinderloom,
        cells: [cell('c1'), cell('c2'), cell('c3'), cell('c4')] },
    ],
  },
  {
    out: '31-storyboard-2.png',
    title: 'graphics-lab showcase storyboard — 2 / 2',
    subtitle: 'nevermend arc + the four strongest frames',
    segments: [
      { header: 'NEVERMEND', accent: ACCENT.nevermend,
        cells: [cell('n1'), cell('n2'), cell('n3'), cell('n4')] },
      { header: 'BEST OF', accent: ACCENT.best,
        cells: [
          cell('c3', { label: 'CINDERLOOM 0.78', sub: 'ember dusk beauty' }),
          cell('w4', { label: 'WARPWOLD 0.85', sub: 'portal gate at night' }),
          cell('w3', { label: 'WARPWOLD 0.73', sub: 'island diorama + falls' }),
          cell('n1', { label: 'NEVERMEND 0.25', sub: 'pale dawn silhouette' }),
        ] },
    ],
  },
];

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${PORT}/tools/storyboard.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__compositorReady === true);

for (const sheet of SHEETS) {
  const url = await page.evaluate((spec) => window.composite(spec), sheet);
  const file = path.join(OUT, sheet.out);
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  console.log('wrote', file);
}
console.log('console errors:', errors.length);
for (const e of errors) console.log('  ' + e);
await browser.close();
