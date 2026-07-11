import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/home/user/MinecraftV2/graphics-lab/screenshots';
fs.mkdirSync(OUT, { recursive: true });
const URL = 'http://localhost:8099/index.html';

const consoleErrors = [];
const screenshots = [];
const notes = [];

function variance(file) {
  try {
    const buf = fs.readFileSync(file);
    const png = PNG.sync.read(buf);
    const { data, width, height } = png;
    // sample luminance
    let n = 0, sum = 0, sumSq = 0;
    const step = 4 * 7; // sample every 7th pixel
    for (let i = 0; i < data.length; i += step) {
      const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += l; sumSq += l * l; n++;
    }
    const mean = sum / n;
    const varr = sumSq / n - mean * mean;
    return { mean: +mean.toFixed(2), std: +Math.sqrt(Math.max(0, varr)).toFixed(2), width, height };
  } catch (e) {
    return { error: String(e) };
  }
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
});

const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();

page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push('[console] ' + msg.text()); });
page.on('pageerror', (err) => { consoleErrors.push('[pageerror] ' + (err && err.stack ? err.stack : String(err))); });

let ready = false;
try {
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
} catch (e) {
  notes.push('goto failed: ' + String(e));
}

// poll for __demoReady
const start = Date.now();
while (Date.now() - start < 30000) {
  try { ready = await page.evaluate(() => window.__demoReady === true); } catch {}
  if (ready) break;
  await page.waitForTimeout(250);
}

async function shot(name) {
  const p = path.join(OUT, name);
  await page.screenshot({ path: p });
  screenshots.push(p);
  const v = variance(p);
  notes.push(`${name}: ${JSON.stringify(v)}`);
  return v;
}

if (!ready) {
  notes.push('window.__demoReady never became true within 30s');
  await shot('00-notready.png');
} else {
  notes.push('demoReady=true after ' + (Date.now() - start) + 'ms');
  // check demo api exists
  const api = await page.evaluate(() => ({
    hasDemo: !!window.demo,
    keys: window.demo ? Object.keys(window.demo) : [],
  }));
  notes.push('demo API keys: ' + api.keys.join(','));

  // a) day
  await page.evaluate(() => window.demo.setTimeOfDay(0.35));
  await page.waitForTimeout(1200);
  await shot('01-day.png');

  // b) night
  await page.evaluate(() => window.demo.setTimeOfDay(0.85));
  await page.waitForTimeout(1200);
  await shot('02-night.png');

  // c) rain (back to day)
  await page.evaluate(() => window.demo.setTimeOfDay(0.35));
  await page.evaluate(() => window.demo.setWeather('rain'));
  await page.waitForTimeout(1500);
  await shot('03-rain.png');

  // d) underwater
  await page.evaluate(() => window.demo.setUnderwater(true));
  await page.waitForTimeout(1200);
  await shot('04-underwater.png');
  await page.evaluate(() => { window.demo.setUnderwater(false); window.demo.setWeather('clear'); });
  await page.waitForTimeout(300);

  // e) snow
  await page.evaluate(() => { window.demo.setWeather('snow'); window.demo.setTimeOfDay(0.5); });
  await page.waitForTimeout(1500);
  await shot('05-snow.png');
  await page.evaluate(() => window.demo.setWeather('clear'));
  await page.waitForTimeout(300);

  // f) sunrise
  await page.evaluate(() => window.demo.setTimeOfDay(0.25));
  await page.waitForTimeout(1000);
  await shot('06-sunrise.png');

  // FPS measurement helper
  async function measureFps(quality) {
    if (quality) {
      try { await page.evaluate((q) => window.demo.setQuality(q), quality); } catch (e) { notes.push('setQuality(' + quality + ') threw: ' + String(e)); }
      await page.waitForTimeout(600);
    }
    return await page.evaluate(() => new Promise((resolve) => {
      let frames = 0;
      const t0 = performance.now();
      function loop() {
        frames++;
        if (performance.now() - t0 >= 2000) { resolve(frames / ((performance.now() - t0) / 1000)); return; }
        requestAnimationFrame(loop);
      }
      requestAnimationFrame(loop);
    }));
  }

  const fpsMedium = await measureFps('medium');
  const fpsUltra = await measureFps('ultra');
  const fpsLow = await measureFps('low');
  notes.push(`fps medium=${fpsMedium.toFixed(1)} ultra=${fpsUltra.toFixed(1)} low=${fpsLow.toFixed(1)}`);

  global.__RESULT = { ready, fpsMedium, fpsByQuality: { low: fpsLow, medium: fpsMedium, ultra: fpsUltra } };
}

const result = {
  ready,
  consoleErrors: [...new Set(consoleErrors)],
  screenshots,
  fpsMedium: (global.__RESULT && global.__RESULT.fpsMedium) || 0,
  fpsByQuality: (global.__RESULT && global.__RESULT.fpsByQuality) || {},
  notes: notes.join('\n'),
};

fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
console.log('RESULT_JSON_START');
console.log(JSON.stringify(result));
console.log('RESULT_JSON_END');

await browser.close();
