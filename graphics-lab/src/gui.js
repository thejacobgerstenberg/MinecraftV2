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
// The same `state` object is treated as LIVE: demo.js mutates it in place when
// window.demo.* is called, and the panel polls it (every 250ms) so readouts
// stay in sync even when the demo is driven programmatically.
//
// Returns { root, refresh(state?), hide(), show(), dispose(), fps }.
//  - refresh(state?)  re-reads the (optionally new) state object and syncs
//                     every control immediately.
//  - hide()/show()    toggle the whole panel (also exposed as window.__gui
//                     for screenshot scripts).
//
// Beauty-shot mode: if the URL contains ?nogui=1 the panel is built but never
// mounted, so nothing renders; window.__gui.show() can still bring it back.
// The FPS counter keeps measuring in that mode (read it via gui.fps).

const STYLE_ID = 'graphics-lab-gui-style';
const POLL_MS = 250; // light self-sync cadence

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
#gui .glab-caret {
  background: none; border: none; color: #9fb2c8; cursor: pointer;
  font-size: 10px; line-height: 1; padding: 0 6px 0 0; margin: 0;
}
#gui .glab-caret:hover { color: #e6edf3; }
#gui .glab-titlerow { display: flex; align-items: baseline; cursor: pointer; }
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
#gui button.glab-btn {
  width: 100%;
  background: rgba(110, 168, 254, 0.16);
  color: #cfe2ff;
  border: 1px solid rgba(110, 168, 254, 0.35);
  border-radius: 7px;
  padding: 6px 8px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
#gui button.glab-btn:hover { background: rgba(110, 168, 254, 0.28); }
#gui button.glab-btn:active { background: rgba(110, 168, 254, 0.4); }
`;

const EFFECTS = [
  'ao', 'sky', 'shadows', 'water', 'post', 'particles', 'fog',
  'portal', 'crack', 'viewmodel', 'torchlights', 'wind', 'biome',
  // Phase 3: post-chain SSAO / god rays / bloom + greedy-mesher A-B switch.
  'ssao', 'godrays', 'bloom', 'greedy',
  // Environment phase: waterfalls/lavafall, underwater caustics+shafts,
  // bioluminescence (default OFF), ambient life fields, water reflections.
  'falls', 'underwaterfx', 'biolum', 'ambient', 'reflections',
];
const QUALITIES = ['low', 'medium', 'high', 'ultra'];
const WEATHERS = ['clear', 'rain', 'snow'];
const DIMENSIONS = [
  ['warpwold', 'Warpwold'],
  ['cinderloom', 'Cinderloom'],
  ['nevermend', 'Nevermend'],
];
const HELD_ITEMS = [
  ['block:1', 'grass block'],
  ['block:3', 'stone block'],
  ['tool:pickaxe', 'pickaxe'],
  ['', 'none'],
];
const BIOME_NAMES = ['plains', 'desert', 'tundra', 'swamp', 'cinder'];

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

// True when the page was loaded with ?nogui=1 (clean beauty screenshots).
function noGuiRequested() {
  try {
    return new URLSearchParams(window.location.search).get('nogui') === '1';
  } catch (e) {
    return false;
  }
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
  const noGui = noGuiRequested();

  // Live state reference: demo.js mutates this object in place, so re-reading
  // it later (refresh / polling) picks up programmatic changes for free.
  let liveState = state && typeof state === 'object' ? state : {};

  const effects = Object.assign(
    {
      ao: true, sky: true, shadows: true, water: true, post: true,
      particles: true, fog: true,
      portal: true, crack: true, viewmodel: true, torchlights: true,
      wind: true, biome: true,
    },
    liveState.effects || {},
  );
  const quality0 = liveState.quality || 'medium';
  const time0 = liveState.timeOfDay != null ? liveState.timeOfDay : 0.35;
  const weather0 = liveState.weather || 'clear';
  const underwater0 = !!liveState.underwater;
  const dimension0 = liveState.dimension || 'warpwold';
  const held0 = liveState.heldItem != null ? liveState.heldItem : 'block:1';
  const biome0 = liveState.biome || 'plains';

  const call = (method, ...args) => {
    const d = window.demo || demo;
    if (d && typeof d[method] === 'function') {
      try { d[method](...args); } catch (e) { /* keep the panel alive */ }
    }
  };

  const panel = el('div', 'glab-panel');

  // Header + FPS + collapse caret. The panel boots COLLAPSED (header only) so
  // the dev controls don't fight the graphics settings drawer for attention;
  // clicking the title row (or caret) expands it.
  const header = el('div', 'glab-header');
  const titleRow = el('div', 'glab-titlerow');
  const caret = el('button', 'glab-caret', '▸');
  caret.type = 'button';
  caret.title = 'expand/collapse dev controls';
  titleRow.appendChild(caret);
  titleRow.appendChild(el('div', 'glab-title', 'graphics-lab'));
  header.appendChild(titleRow);
  const fpsEl = el('div', 'glab-fps', '– fps');
  header.appendChild(fpsEl);
  panel.appendChild(header);

  // Collapsible body: every section lands here instead of the panel root.
  const bodyEl = el('div', 'glab-body');
  panel.appendChild(bodyEl);

  let collapsed = true;
  function setCollapsed(c) {
    collapsed = !!c;
    bodyEl.style.display = collapsed ? 'none' : '';
    caret.textContent = collapsed ? '▸' : '▾';
  }
  setCollapsed(true);
  titleRow.addEventListener('click', () => setCollapsed(!collapsed));

  // --- Effects toggles -------------------------------------------------------
  const fxBoxes = {}; // name -> checkbox input, for refresh()
  const fxSection = el('div', 'glab-section');
  fxSection.appendChild(el('span', 'glab-label', 'Effects'));
  const grid = el('div', 'glab-toggles');
  for (const name of EFFECTS) {
    const label = el('label', 'glab-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = !!effects[name];
    box.addEventListener('change', () => call('toggle', name, box.checked));
    fxBoxes[name] = box;
    label.appendChild(box);
    label.appendChild(el('span', null, name));
    grid.appendChild(label);
  }
  fxSection.appendChild(grid);
  bodyEl.appendChild(fxSection);

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
  bodyEl.appendChild(qSection);

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
  // While the user drags, the poll must not fight the thumb.
  let tDragging = false;
  tSlider.addEventListener('pointerdown', () => { tDragging = true; });
  tSlider.addEventListener('pointerup', () => { tDragging = false; });
  tSlider.addEventListener('pointercancel', () => { tDragging = false; });
  tSlider.addEventListener('input', () => {
    const v = parseFloat(tSlider.value);
    tVal.textContent = timeLabel(v);
    call('setTimeOfDay', v);
  });
  tSection.appendChild(tSlider);
  bodyEl.appendChild(tSection);

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
  bodyEl.appendChild(wSection);

  // --- Dimension (MASTER: sky grade + ambient life + portal + biome + falls) --
  const pSection = el('div', 'glab-section');
  pSection.appendChild(el('span', 'glab-label', 'Dimension'));
  const pSel = el('select');
  for (const [value, label] of DIMENSIONS) {
    const opt = el('option', null, label);
    opt.value = value;
    if (value === dimension0) opt.selected = true;
    pSel.appendChild(opt);
  }
  pSel.addEventListener('change', () => call('setDimension', pSel.value));
  pSection.appendChild(pSel);
  bodyEl.appendChild(pSection);

  // --- Held item -----------------------------------------------------------------
  const hSection = el('div', 'glab-section');
  hSection.appendChild(el('span', 'glab-label', 'Held item'));
  const hSel = el('select');
  for (const [value, label] of HELD_ITEMS) {
    const opt = el('option', null, label);
    opt.value = value;
    if (value === held0) opt.selected = true;
    hSel.appendChild(opt);
  }
  hSel.addEventListener('change', () => call('setHeldItem', hSel.value));
  hSection.appendChild(hSel);
  bodyEl.appendChild(hSection);

  // --- Biome grade -----------------------------------------------------------------
  const bSection = el('div', 'glab-section');
  bSection.appendChild(el('span', 'glab-label', 'Biome'));
  const bSel = el('select');
  for (const b of BIOME_NAMES) {
    const opt = el('option', null, b);
    opt.value = b;
    if (b === biome0) opt.selected = true;
    bSel.appendChild(opt);
  }
  bSel.addEventListener('change', () => call('setBiome', bSel.value));
  bSection.appendChild(bSel);
  bodyEl.appendChild(bSection);

  // --- Texture pack ------------------------------------------------------------------
  // Opens the pack browser drawer (textures/browser/packBrowser.js via
  // demo.openPackBrowser). The value readout mirrors state.texturePack.
  const tpSection = el('div', 'glab-section');
  const tpHead = el('div', 'glab-row');
  tpHead.appendChild(el('span', 'glab-label', 'Texture pack'));
  const tpVal = el('span', 'glab-time-val', liveState.texturePack || 'lab-classic');
  tpHead.appendChild(tpVal);
  tpSection.appendChild(tpHead);
  const tpBtn = el('button', 'glab-btn', 'browse packs…');
  tpBtn.type = 'button';
  tpBtn.addEventListener('click', () => call('openPackBrowser'));
  tpSection.appendChild(tpBtn);
  bodyEl.appendChild(tpSection);

  // --- Break block button ------------------------------------------------------------
  const brSection = el('div', 'glab-section');
  const brBtn = el('button', 'glab-btn', 'break a block');
  brBtn.type = 'button';
  brBtn.addEventListener('click', () => call('triggerBreak'));
  brSection.appendChild(brBtn);
  bodyEl.appendChild(brSection);

  // --- Photo mode button ('P' also toggles it) -----------------------------------
  const phSection = el('div', 'glab-section');
  const phBtn = el('button', 'glab-btn', 'photo mode (P)');
  phBtn.type = 'button';
  phBtn.addEventListener('click', () => call('togglePhotoMode'));
  phSection.appendChild(phBtn);
  bodyEl.appendChild(phSection);

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
  bodyEl.appendChild(uSection);

  // In ?nogui=1 mode the panel is never mounted (nothing renders); otherwise
  // attach it now. show() can mount it later either way.
  if (!noGui) mount.appendChild(panel);

  // --- refresh: sync every control from the state object ---------------------
  // Cheap and idempotent: only touches the DOM when a value actually changed,
  // so the 250ms poll costs nothing when the state is stable.
  function refresh(next) {
    if (next && typeof next === 'object') liveState = next; // adopt new state ref
    const s = liveState;
    if (!s || typeof s !== 'object') return;

    // Effect checkboxes.
    const fx = s.effects;
    if (fx && typeof fx === 'object') {
      for (const name of EFFECTS) {
        if (fx[name] == null) continue;
        const b = !!fx[name];
        if (fxBoxes[name].checked !== b) fxBoxes[name].checked = b;
      }
    }

    // Quality dropdown.
    if (s.quality != null && QUALITIES.indexOf(s.quality) !== -1 && qSel.value !== s.quality) {
      qSel.value = s.quality;
    }

    // Time-of-day slider + clock label (skipped mid-drag so the thumb is stable).
    if (s.timeOfDay != null && !tDragging) {
      const t = Math.max(0, Math.min(1, Number(s.timeOfDay)));
      if (!Number.isNaN(t) && Math.abs(parseFloat(tSlider.value) - t) > 1e-4) {
        tSlider.value = String(t);
        tVal.textContent = timeLabel(t);
      }
    }

    // Weather dropdown.
    if (s.weather != null && WEATHERS.indexOf(s.weather) !== -1 && wSel.value !== s.weather) {
      wSel.value = s.weather;
    }

    // Portal dimension dropdown.
    if (s.dimension != null && DIMENSIONS.some((d) => d[0] === s.dimension) &&
        pSel.value !== s.dimension) {
      pSel.value = s.dimension;
    }

    // Held-item dropdown ('' == none is a valid value).
    if (s.heldItem != null && HELD_ITEMS.some((h) => h[0] === s.heldItem) &&
        hSel.value !== s.heldItem) {
      hSel.value = s.heldItem;
    }

    // Biome dropdown.
    if (s.biome != null && BIOME_NAMES.indexOf(s.biome) !== -1 && bSel.value !== s.biome) {
      bSel.value = s.biome;
    }

    // Texture-pack readout.
    if (s.texturePack != null && tpVal.textContent !== s.texturePack) {
      tpVal.textContent = s.texturePack;
    }

    // Underwater checkbox.
    if (s.underwater != null) {
      const b = !!s.underwater;
      if (uBox.checked !== b) uBox.checked = b;
    }
  }

  // Light polling so the panel self-syncs when window.demo.* mutates the state
  // object directly (no demo.js changes needed).
  const pollId = setInterval(refresh, POLL_MS);

  // --- hide / show ------------------------------------------------------------
  function hide() {
    panel.style.display = 'none';
  }
  function show() {
    if (!panel.parentNode) mount.appendChild(panel); // first show() in nogui mode
    panel.style.display = '';
    refresh();
  }

  // --- Live FPS counter ------------------------------------------------------
  // Keeps measuring even in nogui mode (panel unmounted): the number stays
  // available via gui.fps / window.__gui.fps, it just isn't rendered.
  let frames = 0;
  let last = performance.now();
  let raf = 0;
  let running = true;
  let lastFps = 0;
  const tick = (now) => {
    if (!running) return;
    frames++;
    if (now - last >= 500) {
      lastFps = Math.round((frames * 1000) / (now - last));
      fpsEl.textContent = `${lastFps} fps`;
      frames = 0;
      last = now;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  const gui = {
    root: panel,
    refresh,
    hide,
    show,
    get fps() { return lastFps; },
    dispose() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      clearInterval(pollId);
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      if (window.__gui === guiGlobal) {
        try { delete window.__gui; } catch (e) { window.__gui = undefined; }
      }
    },
  };

  // Global handle for screenshot / automation scripts.
  const guiGlobal = {
    hide,
    show,
    refresh,
    get fps() { return lastFps; },
  };
  window.__gui = guiGlobal;

  return gui;
}

export default createGUI;
