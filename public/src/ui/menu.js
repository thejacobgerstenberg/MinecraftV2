// Voxelheim UI — menu system: main menu, world select, settings, pause,
// loading overlay.
//
// Pure DOM module: no three.js import. All DOM access happens inside
// initMenus(), so the module is safe to import under plain node.
//
// API:
//   initMenus({ onPlayWorld, onCreateWorld, onSettingsChange, onResume,
//               onQuitToTitle, getWorlds, packsList }) ->
//     { showMain(), showWorldSelect(), showSettings(), showPause(),
//       hideAll(), setLoading(textOrNull), getSettings() }
//
//   onPlayWorld(world)          — Play clicked on a world row (whole world
//                                 object from getWorlds() is passed back).
//   onCreateWorld({name, seed}) — Create form submitted. name is a non-empty
//                                 trimmed string; seed is a trimmed string or
//                                 null when left blank.
//   onSettingsChange(settings)  — fires live on any settings change with the
//                                 full merged settings object.
//   onResume()                  — Resume clicked (menu hides itself first).
//   onQuitToTitle()             — Save & Quit clicked (main menu is shown
//                                 right after the callback).
//   getWorlds()                 — () -> world[] | Promise<world[]>, each
//                                 { id?, name, seed?, createdAt? }.
//   packsList                   — [{id, name}] for the texture-pack <select>.
//
//   Settings shape (persisted to localStorage "voxelheim.settings"):
//     { renderDistance: 2..12 (6), fov: 60..110 (75),
//       sensitivity: 0.1..2 (1.0), texturePack: packId ('default') }
//
//   The game title <h1 id="game-title"> is defined in index.html and adopted
//   into the main menu; if absent (dev harness), document.title is used.
//   setLoading(text) shows the #loading overlay with a status line;
//   setLoading(null) hides it. hideAll() hides every menu screen but does
//   NOT touch the loading overlay.

const SETTINGS_KEY = 'voxelheim.settings';

const SETTINGS_SPEC = {
  renderDistance: { min: 2, max: 12, def: 6 },
  fov: { min: 60, max: 110, def: 75 },
  sensitivity: { min: 0.1, max: 2, def: 1 },
};

const DEFAULT_SETTINGS = Object.freeze({
  renderDistance: 6,
  fov: 75,
  sensitivity: 1,
  texturePack: 'default',
});

function clampNum(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function el(tag, className, parent, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

function button(label, className, parent, onClick) {
  const b = el('button', className, parent, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function fmtDate(v) {
  if (v == null) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function initMenus(opts = {}) {
  const {
    onPlayWorld,
    onCreateWorld,
    onSettingsChange,
    onResume,
    onQuitToTitle,
    getWorlds,
    packsList = [],
  } = opts;

  // --- Root + backdrop -------------------------------------------------------
  let root = document.getElementById('menu-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'menu-root';
    document.body.appendChild(root);
  }
  root.classList.add('menu-root');

  // Adopt the game title from index.html before clearing the root.
  let titleEl = document.getElementById('game-title');
  if (titleEl) titleEl.remove();
  root.textContent = '';
  if (!titleEl) {
    titleEl = document.createElement('h1');
    titleEl.id = 'game-title';
    titleEl.textContent = (document.title || 'VOXELHEIM').toUpperCase();
  }
  titleEl.hidden = false;
  titleEl.classList.add('game-title');

  const backdrop = el('div', 'menu-backdrop', root);
  el('div', 'bd-stars', backdrop);
  el('div', 'bd-hill bd-hill--far', backdrop);
  el('div', 'bd-hill bd-hill--grass', backdrop);
  el('div', 'bd-hill bd-hill--dirt', backdrop);
  el('div', 'bd-vignette', backdrop);

  const screens = {};
  for (const name of ['main', 'worlds', 'settings', 'pause']) {
    screens[name] = el('section', `menu-screen menu-screen--${name}`, root);
  }

  // --- Settings state --------------------------------------------------------
  function sanitizeSettings(raw) {
    const s = { ...DEFAULT_SETTINGS };
    if (raw && typeof raw === 'object') {
      for (const key of Object.keys(SETTINGS_SPEC)) {
        const spec = SETTINGS_SPEC[key];
        if (raw[key] != null) s[key] = clampNum(raw[key], spec.min, spec.max, spec.def);
      }
      if (typeof raw.texturePack === 'string') s.texturePack = raw.texturePack;
    }
    return s;
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return sanitizeSettings(JSON.parse(raw));
    } catch (_) { /* corrupted or unavailable storage -> defaults */ }
    return { ...DEFAULT_SETTINGS };
  }

  const settings = loadSettings();

  function persistSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (_) { /* storage unavailable — settings stay in-memory */ }
  }

  function settingChanged() {
    persistSettings();
    if (typeof onSettingsChange === 'function') onSettingsChange({ ...settings });
  }

  // --- Screen switching ------------------------------------------------------
  let current = null;
  let settingsReturn = 'main'; // which screen Done returns to

  function show(name) {
    current = name;
    for (const key of Object.keys(screens)) {
      screens[key].classList.toggle('visible', key === name);
    }
    const titleContext = name === 'main' || name === 'worlds'
      || (name === 'settings' && settingsReturn === 'main');
    backdrop.classList.toggle('menu-backdrop--show', !!name && titleContext);
    if (name === 'worlds') refreshWorlds();
    if (name === 'settings') syncSettingsControls();
  }

  function hideAll() {
    current = null;
    for (const key of Object.keys(screens)) screens[key].classList.remove('visible');
    backdrop.classList.remove('menu-backdrop--show');
  }

  // --- Main menu -------------------------------------------------------------
  {
    const wrap = el('div', 'menu-main-wrap', screens.main);
    wrap.appendChild(titleEl);
    el('p', 'menu-tagline', wrap, 'An open-world voxel sandbox');
    const buttons = el('div', 'menu-buttons', wrap);
    button('Play', 'vx-btn vx-btn--primary vx-btn--big', buttons, () => show('worlds'));
    button('Settings', 'vx-btn vx-btn--big', buttons, () => {
      settingsReturn = 'main';
      show('settings');
    });
    el('div', 'menu-footer menu-footer--left', screens.main, 'v0.1.0');
    el('div', 'menu-footer menu-footer--right', screens.main,
      'An original game — all textures procedural · built with three.js');
  }

  // --- World select ----------------------------------------------------------
  let worldList;
  {
    const panel = el('div', 'vx-panel menu-panel menu-panel--worlds', screens.worlds);
    el('h2', 'menu-h2', panel, 'Select World');
    worldList = el('div', 'world-list', panel);

    const create = el('div', 'world-create', panel);
    el('h3', 'world-create-h', create, 'Create New World');
    const row = el('div', 'world-create-row', create);
    const nameInput = el('input', 'vx-input world-name-input', row);
    nameInput.type = 'text';
    nameInput.placeholder = 'World name';
    nameInput.maxLength = 32;
    const seedInput = el('input', 'vx-input world-seed-input', row);
    seedInput.type = 'text';
    seedInput.placeholder = 'Seed (optional)';
    seedInput.maxLength = 32;
    const createBtn = button('Create', 'vx-btn vx-btn--primary', row, () => {
      const name = nameInput.value.trim();
      if (!name) {
        errorEl.textContent = 'Enter a world name first.';
        errorEl.classList.add('world-error--show');
        nameInput.classList.add('vx-input--error');
        nameInput.focus();
        return;
      }
      errorEl.classList.remove('world-error--show');
      nameInput.classList.remove('vx-input--error');
      const seed = seedInput.value.trim() || null;
      nameInput.value = '';
      seedInput.value = '';
      if (typeof onCreateWorld === 'function') onCreateWorld({ name, seed });
    });
    createBtn.classList.add('world-create-btn');
    nameInput.addEventListener('input', () => {
      errorEl.classList.remove('world-error--show');
      nameInput.classList.remove('vx-input--error');
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createBtn.click();
    });
    seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createBtn.click();
    });
    const errorEl = el('div', 'world-error', create);

    const nav = el('div', 'menu-buttons menu-buttons--row', panel);
    button('Back', 'vx-btn', nav, () => show('main'));
  }

  function refreshWorlds() {
    worldList.textContent = '';
    el('div', 'world-note', worldList, 'Loading worlds…');
    Promise.resolve()
      .then(() => (typeof getWorlds === 'function' ? getWorlds() : []))
      .then((worlds) => {
        worldList.textContent = '';
        if (!Array.isArray(worlds) || worlds.length === 0) {
          el('div', 'world-note', worldList, 'No worlds yet — create one below.');
          return;
        }
        for (const world of worlds) {
          const row = el('div', 'world-row', worldList);
          const info = el('div', 'world-info', row);
          el('div', 'world-name', info, world.name ?? 'Unnamed world');
          const bits = [];
          if (world.seed != null && world.seed !== '') bits.push(`Seed: ${world.seed}`);
          const date = fmtDate(world.createdAt);
          if (date) bits.push(date);
          el('div', 'world-meta', info, bits.join('  ·  '));
          button('Play', 'vx-btn vx-btn--primary vx-btn--small', row, () => {
            if (typeof onPlayWorld === 'function') onPlayWorld(world);
          });
        }
      })
      .catch(() => {
        worldList.textContent = '';
        el('div', 'world-note world-note--error', worldList, 'Could not load worlds.');
      });
  }

  // --- Settings ---------------------------------------------------------------
  const settingControls = {}; // key -> { input, valueEl, fmt }
  {
    const panel = el('div', 'vx-panel menu-panel menu-panel--settings', screens.settings);
    el('h2', 'menu-h2', panel, 'Settings');
    const body = el('div', 'settings-body', panel);

    function sliderRow(key, label, min, max, step, fmt) {
      const row = el('div', 'set-row', body);
      el('span', 'set-label', row, label);
      const input = el('input', 'vx-range', row);
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(settings[key]);
      const valueEl = el('span', 'set-value', row, fmt(settings[key]));
      input.addEventListener('input', () => {
        settings[key] = Number(input.value);
        valueEl.textContent = fmt(settings[key]);
        settingChanged();
      });
      settingControls[key] = { input, valueEl, fmt };
    }

    sliderRow('renderDistance', 'Render Distance', 2, 12, 1, (v) => `${v} chunks`);
    sliderRow('fov', 'Field of View', 60, 110, 1, (v) => `${v}°`);
    sliderRow('sensitivity', 'Mouse Sensitivity', 0.1, 2, 0.05, (v) => `${Math.round(v * 100)}%`);

    // Texture pack select
    {
      const row = el('div', 'set-row', body);
      el('span', 'set-label', row, 'Texture Pack');
      const select = el('select', 'vx-select', row);
      for (const pack of packsList) {
        const opt = el('option', null, select, pack.name ?? pack.id);
        opt.value = pack.id;
      }
      if ([...select.options].some((o) => o.value === settings.texturePack)) {
        select.value = settings.texturePack;
      } else if (select.options.length > 0) {
        settings.texturePack = select.options[0].value;
        select.value = settings.texturePack;
      }
      const valueEl = el('span', 'set-value set-value--pack', row, '');
      select.addEventListener('change', () => {
        settings.texturePack = select.value;
        settingChanged();
      });
      settingControls.texturePack = {
        input: select,
        valueEl,
        fmt: () => '',
      };
    }

    const nav = el('div', 'menu-buttons menu-buttons--row', panel);
    button('Done', 'vx-btn vx-btn--primary', nav, () => {
      persistSettings();
      show(settingsReturn);
    });
  }

  function syncSettingsControls() {
    for (const key of Object.keys(settingControls)) {
      const c = settingControls[key];
      c.input.value = String(settings[key]);
      c.valueEl.textContent = c.fmt(settings[key]);
    }
  }

  // --- Pause -------------------------------------------------------------------
  {
    const panel = el('div', 'vx-panel menu-panel menu-panel--pause', screens.pause);
    el('h2', 'menu-h2', panel, 'Game Paused');
    const buttons = el('div', 'menu-buttons', panel);
    button('Resume', 'vx-btn vx-btn--primary', buttons, () => {
      hideAll();
      if (typeof onResume === 'function') onResume();
    });
    button('Settings', 'vx-btn', buttons, () => {
      settingsReturn = 'pause';
      show('settings');
    });
    button('Save & Quit to Title', 'vx-btn', buttons, () => {
      if (typeof onQuitToTitle === 'function') onQuitToTitle();
      show('main');
    });
  }

  // --- Loading overlay -----------------------------------------------------------
  let loadingEl = document.getElementById('loading');
  let loadingText;
  if (loadingEl) {
    loadingText = loadingEl.querySelector('.loading-text');
  }
  if (!loadingEl) {
    loadingEl = document.createElement('div');
    loadingEl.id = 'loading';
    loadingEl.className = 'overlay loading';
    const inner = el('div', 'loading-inner', loadingEl);
    const cube = el('div', 'loading-cube', inner);
    el('i', null, cube);
    el('i', null, cube);
    el('i', null, cube);
    loadingText = el('div', 'loading-text', inner, 'Loading…');
    document.body.appendChild(loadingEl);
  } else if (!loadingText) {
    loadingText = el('div', 'loading-text', loadingEl);
  }

  function setLoading(textOrNull) {
    if (textOrNull == null) {
      loadingEl.classList.remove('visible');
    } else {
      loadingText.textContent = String(textOrNull);
      loadingEl.classList.add('visible');
    }
  }

  // --- Public API ------------------------------------------------------------------
  return {
    showMain: () => show('main'),
    showWorldSelect: () => show('worlds'),
    showSettings: () => {
      settingsReturn = current === 'pause' ? 'pause' : 'main';
      show('settings');
    },
    showPause: () => show('pause'),
    hideAll,
    setLoading,
    getSettings: () => ({ ...settings }),
  };
}
