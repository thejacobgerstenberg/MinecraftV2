// graphics-lab/textures/browser/packBrowser.js
//
// In-game PACK BROWSER drawer for the Loomfall texture packs.
//
//   createPackBrowser({ demo = window.demo, mount = document.body })
//     -> { root, button, open(), close(), toggle(), setVisible(bool), dispose() }
//
// One card per PACK_REGISTRY pack (5): pack name, description and a LIVE
// thumbnail strip (grass_top / stone / planks / iron_ore / thread_block,
// blitted at 2x straight off that pack's buildAtlas() canvas — real pixels,
// not mockups). Clicking a card calls demo.setTexturePack(id), which persists
// the choice ('mc2.texturePack') and emits 'pack:switched'; the browser
// listens for that event to move the current-pack highlight (so programmatic
// switches highlight correctly too).
//
// Launcher: a fixed button NEXT TO the settings gear (gear sits bottom-right
// 16px in index.html; the launcher sits 12px to its left). gui.js also opens
// the drawer via demo.openPackBrowser().
//
// Styling follows the ui-kit conventions from origin/feature/ui-kit: lf-*
// class naming + var(--lf-*) custom props only. The needed tokens are
// VENDORED in ./vendored-tokens.css (linked from index.html together with
// ./packBrowser.css) — nothing imports cross-branch at runtime.
//
// Hidden under ?nogui=1 (returns an inert stub, nothing mounts) and by
// demo.setScenicMode(true) (demo.js calls setVisible(false)).
//
// Pack atlases for the thumbnails are built lazily on first open() and cached
// (buildAtlas is deterministic, so once is enough).

import { buildAtlas, PACK_REGISTRY } from '../atlas.js';

// Thumbnail strip: tile names + 2x scale (32px tiles -> 64px swatches).
const THUMB_TILES = ['grass_top', 'stone', 'planks', 'iron_ore', 'thread_block'];
const THUMB_SCALE = 2;

const LAB_PACK_ID = 'lab-classic';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function noGuiRequested() {
  try {
    return new URLSearchParams(window.location.search).get('nogui') === '1';
  } catch (e) {
    return false;
  }
}

// Swatch-grid launcher icon (2x2 "texture tiles"), stroke/fill from
// currentColor so the lf token colors flow through.
const LAUNCHER_SVG = `
<svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
  <rect x="2.5"  y="2.5"  width="7" height="7" rx="1.2" fill="currentColor" opacity="0.9"/>
  <rect x="12.5" y="2.5"  width="7" height="7" rx="1.2" stroke="currentColor" stroke-width="1.6"/>
  <rect x="2.5"  y="12.5" width="7" height="7" rx="1.2" stroke="currentColor" stroke-width="1.6"/>
  <rect x="12.5" y="12.5" width="7" height="7" rx="1.2" fill="currentColor" opacity="0.55"/>
</svg>`;

/** Blit the pack's thumbnail tiles at 2x from its atlas canvas. */
function drawThumbStrip(canvas, packAtlas) {
  const tilePx = packAtlas.tilePx;
  const size = tilePx * THUMB_SCALE;
  canvas.width = THUMB_TILES.length * size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false; // crisp 2x pixels
  for (let i = 0; i < THUMB_TILES.length; i++) {
    const idx = packAtlas.tileIndex(THUMB_TILES[i]);
    const sx = (idx % packAtlas.cols) * tilePx;
    const sy = Math.floor(idx / packAtlas.cols) * tilePx;
    ctx.drawImage(packAtlas.canvas, sx, sy, tilePx, tilePx, i * size, 0, size, size);
  }
}

export function createPackBrowser({ demo = null, mount = document.body } = {}) {
  // ?nogui=1: inert stub, nothing rendered (mirror of gui.js / settings).
  if (noGuiRequested()) {
    const noop = () => {};
    return {
      root: null, button: null,
      open: noop, close: noop, toggle: noop, setVisible: noop, dispose: noop,
    };
  }

  const getDemo = () => demo || window.demo || null;
  const packs = Object.values(PACK_REGISTRY);
  const atlasCache = new Map(); // packId -> buildAtlas() result
  let thumbsBuilt = false;
  let isOpen = false;

  // --- DOM -------------------------------------------------------------------
  const root = el('div', 'lf-packs');

  const button = el('button', 'lf-packs-launcher');
  button.type = 'button';
  button.title = 'Texture packs';
  button.setAttribute('aria-label', 'Open texture pack browser');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = LAUNCHER_SVG;
  root.appendChild(button);

  const drawer = el('aside', 'lf-packs-drawer');
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-label', 'Texture pack browser');
  drawer.setAttribute('aria-hidden', 'true');
  root.appendChild(drawer);

  const header = el('header', 'lf-packs-header');
  const titleWrap = el('div', 'lf-packs-title-wrap');
  titleWrap.appendChild(el('h2', 'lf-packs-title', 'Pack Browser'));
  titleWrap.appendChild(el('p', 'lf-packs-subtitle', 'Loomfall texture packs'));
  header.appendChild(titleWrap);
  const closeBtn = el('button', 'lf-packs-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close pack browser');
  header.appendChild(closeBtn);
  drawer.appendChild(header);

  const list = el('div', 'lf-packs-list');
  drawer.appendChild(list);

  const cards = new Map(); // packId -> { card, badge, canvas }
  for (const pack of packs) {
    const card = el('button', 'lf-pack-card');
    card.type = 'button';
    card.dataset.pack = pack.id;

    const head = el('div', 'lf-pack-card-head');
    head.appendChild(el('span', 'lf-pack-name', pack.name));
    const badge = el('span', 'lf-pack-badge', 'ACTIVE');
    head.appendChild(badge);
    card.appendChild(head);

    const thumbWrap = el('div', 'lf-pack-thumbs-wrap');
    const canvas = el('canvas', 'lf-pack-thumbs');
    canvas.setAttribute('aria-hidden', 'true');
    thumbWrap.appendChild(canvas);
    card.appendChild(thumbWrap);

    card.appendChild(el('p', 'lf-pack-desc', pack.description));

    card.addEventListener('click', () => {
      const d = getDemo();
      if (d && typeof d.setTexturePack === 'function') d.setTexturePack(pack.id);
      // Highlight moves via the 'pack:switched' event (single source of truth).
    });

    cards.set(pack.id, { card, badge, canvas });
    list.appendChild(card);
  }

  const footer = el('footer', 'lf-packs-footer');
  const resetBtn = el('button', 'lf-packs-reset', 'Restore lab-classic atlas');
  resetBtn.type = 'button';
  footer.appendChild(resetBtn);
  drawer.appendChild(footer);

  resetBtn.addEventListener('click', () => {
    const d = getDemo();
    if (d && typeof d.setTexturePack === 'function') d.setTexturePack(LAB_PACK_ID);
  });

  // --- Highlight sync ----------------------------------------------------------
  function currentPackId() {
    const d = getDemo();
    if (d && typeof d.getTexturePack === 'function') return d.getTexturePack();
    try { return localStorage.getItem('mc2.texturePack') || LAB_PACK_ID; } catch (e) {
      return LAB_PACK_ID;
    }
  }

  function syncActive(packId) {
    for (const [id, c] of cards) {
      const on = id === packId;
      c.card.classList.toggle('is-active', on);
      c.card.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    resetBtn.classList.toggle('is-active', packId === LAB_PACK_ID);
  }

  const onSwitched = (ev) => {
    syncActive((ev && ev.detail && ev.detail.packId) || currentPackId());
  };
  window.addEventListener('pack:switched', onSwitched);

  // --- Thumbnails (lazy: first open builds all 5 pack atlases, then cached) ----
  function buildThumbs() {
    if (thumbsBuilt) return;
    thumbsBuilt = true;
    for (const pack of packs) {
      let a = atlasCache.get(pack.id);
      if (!a) {
        a = buildAtlas(pack.id);
        atlasCache.set(pack.id, a);
      }
      drawThumbStrip(cards.get(pack.id).canvas, a);
    }
  }

  // --- Open / close --------------------------------------------------------------
  const onKeyDown = (ev) => {
    if (ev.key === 'Escape' && isOpen) close();
  };

  function open() {
    buildThumbs();
    syncActive(currentPackId());
    isOpen = true;
    root.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    button.setAttribute('aria-expanded', 'true');
  }

  function close() {
    isOpen = false;
    root.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    button.setAttribute('aria-expanded', 'false');
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  // Scenic-mode hook (demo.setScenicMode): hide launcher + drawer entirely.
  function setVisible(v) {
    if (!v) close();
    root.style.display = v ? '' : 'none';
  }

  button.addEventListener('click', toggle);
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKeyDown);

  mount.appendChild(root);

  return {
    root,
    button,
    open,
    close,
    toggle,
    setVisible,
    dispose() {
      close();
      window.removeEventListener('pack:switched', onSwitched);
      document.removeEventListener('keydown', onKeyDown);
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}

export default createPackBrowser;
