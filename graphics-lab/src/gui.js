// graphics-lab/src/gui.js
//
// Tiny, dependency-free control panel. No external libraries, no imports.
// createGUI(demo, state) injects its own CSS, builds a semi-transparent panel
// in the top-right (#gui), and wires every control to the window.demo API from
// API_CONTRACT.md:
//
//   demo.toggle(name, bool)  name in ao|sky|shadows|water|post|particles|fog
//   demo.setQuality('low'|'medium'|'high'|'ultra')
//   demo.setTimeOfDay(0..1)
//   demo.setWeather('clear'|'rain'|'snow')
//   demo.setUnderwater(bool)
//
// `state` supplies initial values (all optional):
//   { effects:{ao,sky,shadows,water,post,particles,fog}, quality, timeOfDay,
//     weather, underwater }
//
// Returns { root, dispose() }. A live FPS counter is driven internally.

const STYLE_ID = 'graphics-lab-gui-style';

const CSS = `
#gui .glab-panel {
  width: 232px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 12px;
  color: #e6edf3;
  background: rgba(18, 22, 30, 0.72);
  backdrop-filter: blur(10px) saturate(1.1);
  -webkit-backdrop-filter: blur(10px) saturate(1.1);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  padding: 12px 14px 14px;
  user-select: none;
}
#gui .glab-header {
  display: flex; align-items: baseline; justify-content: space-between;
  margin-bottom: 10px;
}
#gui .glab-title {
  font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase;
  color: #9fb2c8;
}
#gui .glab-fps {
  font-variant-numeric: tabular-nums;
  font-size: 11px; color: #6ea8fe; font-weight: 600;
}
#gui .glab-section {
  margin-top: 12px; padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
#gui .glab-section:first-of-type { margin-top: 0; padding-top: 0; border-top: none; }
#gui .glab-label {
  display: block; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: #7d8896; margin-bottom: 6px;
}
#gui .glab-toggles {
  display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px;
}
#gui .glab-check {
  display: flex; align-items: center; gap: 7px; cursor: pointer; padding: 2px 0;
  line-height: 1.2;
}
#gui .glab-check input { accent-color: #6ea8fe; width: 14px; height: 14px; cursor: pointer; }
#gui .glab-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
#gui select, #gui input[type="range"] {
  width: 100%;
  accent-color: #6ea8fe;
}
#gui select {
  background: rgba(10, 14, 20, 0.9);
  color: #e6edf3;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 7px;
  padding: 5px 7px;
  font-size: 12px;
  cursor: pointer;
}
#gui input[type="range"] { margin-top: 2px; height: 18px; cursor: pointer; }
#gui .glab-time-val { font-variant-numeric: tabular-nums; color: #9fb2c8; font-size: 11px; }
`;

const EFFECTS = ['ao', 'sky', 'shadows', 'water', 'post', 'particles', 'fog'];
const QUALITIES = ['low', 'medium', 'high', 'ultra'];
const WEATHERS = ['clear', 'rain', 'snow'];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

// Format the 0..1 time-of-day as a friendly clock string.
function timeLabel(t) {
  const totalMin = Math.round(t * 24 * 60) % (24 * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  const suffix =
    t < 0.2 ? ' night' : t < 0.3 ? ' dawn' : t < 0.72 ? ' day' : t < 0.82 ? ' dusk' : ' night';
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}${suffix}`;
}

export function createGUI(demo, state = {}) {
  ensureStyle();

  const mount = document.getElementById('gui') || document.body;
  const effects = Object.assign(
    { ao: true, sky: true, shadows: true, water: true, post: true, particles: true, fog: true },
    state.effects || {},
  );
  const quality0 = state.quality || 'medium';
  const time0 = state.timeOfDay != null ? state.timeOfDay : 0.35;
  const weather0 = state.weather || 'clear';
  const underwater0 = !!state.underwater;

  const call = (method, ...args) => {
    const d = window.demo || demo;
    if (d && typeof d[method] === 'function') {
      try { d[method](...args); } catch (e) { /* keep the panel alive */ }
    }
  };

  const panel = el('div', 'glab-panel');

  // Header + FPS.
  const header = el('div', 'glab-header');
  header.appendChild(el('div', 'glab-title', 'graphics-lab'));
  const fpsEl = el('div', 'glab-fps', '– fps');
  header.appendChild(fpsEl);
  panel.appendChild(header);

  // --- Effects toggles -------------------------------------------------------
  const fxSection = el('div', 'glab-section');
  fxSection.appendChild(el('span', 'glab-label', 'Effects'));
  const grid = el('div', 'glab-toggles');
  for (const name of EFFECTS) {
    const label = el('label', 'glab-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = !!effects[name];
    box.addEventListener('change', () => call('toggle', name, box.checked));
    label.appendChild(box);
    label.appendChild(el('span', null, name));
    grid.appendChild(label);
  }
  fxSection.appendChild(grid);
  panel.appendChild(fxSection);

  // --- Quality ---------------------------------------------------------------
  const qSection = el('div', 'glab-section');
  qSection.appendChild(el('span', 'glab-label', 'Quality'));
  const qSel = el('select');
  for (const q of QUALITIES) {
    const opt = el('option', null, q);
    opt.value = q;
    if (q === quality0) opt.selected = true;
    qSel.appendChild(opt);
  }
  qSel.addEventListener('change', () => call('setQuality', qSel.value));
  qSection.appendChild(qSel);
  panel.appendChild(qSection);

  // --- Time of day -----------------------------------------------------------
  const tSection = el('div', 'glab-section');
  const tHead = el('div', 'glab-row');
  tHead.appendChild(el('span', 'glab-label', 'Time of day'));
  const tVal = el('span', 'glab-time-val', timeLabel(time0));
  tHead.appendChild(tVal);
  tSection.appendChild(tHead);
  const tSlider = el('input');
  tSlider.type = 'range';
  tSlider.min = '0';
  tSlider.max = '1';
  tSlider.step = '0.005';
  tSlider.value = String(time0);
  tSlider.addEventListener('input', () => {
    const v = parseFloat(tSlider.value);
    tVal.textContent = timeLabel(v);
    call('setTimeOfDay', v);
  });
  tSection.appendChild(tSlider);
  panel.appendChild(tSection);

  // --- Weather ---------------------------------------------------------------
  const wSection = el('div', 'glab-section');
  wSection.appendChild(el('span', 'glab-label', 'Weather'));
  const wSel = el('select');
  for (const w of WEATHERS) {
    const opt = el('option', null, w);
    opt.value = w;
    if (w === weather0) opt.selected = true;
    wSel.appendChild(opt);
  }
  wSel.addEventListener('change', () => call('setWeather', wSel.value));
  wSection.appendChild(wSel);
  panel.appendChild(wSection);

  // --- Underwater ------------------------------------------------------------
  const uSection = el('div', 'glab-section');
  const uLabel = el('label', 'glab-check');
  const uBox = el('input');
  uBox.type = 'checkbox';
  uBox.checked = underwater0;
  uBox.addEventListener('change', () => call('setUnderwater', uBox.checked));
  uLabel.appendChild(uBox);
  uLabel.appendChild(el('span', null, 'underwater'));
  uSection.appendChild(uLabel);
  panel.appendChild(uSection);

  mount.appendChild(panel);

  // --- Live FPS counter ------------------------------------------------------
  let frames = 0;
  let last = performance.now();
  let raf = 0;
  let running = true;
  const tick = (now) => {
    if (!running) return;
    frames++;
    if (now - last >= 500) {
      const fps = Math.round((frames * 1000) / (now - last));
      fpsEl.textContent = `${fps} fps`;
      frames = 0;
      last = now;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    root: panel,
    dispose() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    },
  };
}

export default createGUI;
