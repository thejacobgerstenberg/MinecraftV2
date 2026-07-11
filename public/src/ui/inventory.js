// Voxelheim UI — inventory screen (E): centered creative block palette.
//
// Pure DOM module: no three.js import. All DOM access happens inside
// initInventory(), so the module is safe to import under plain node.
//
// API:
//   initInventory({ onPick, iconFor }) ->
//     { toggle(), open(), close(), isOpen(), setBlocks(ids) }
//   setBlocks(ids) — array of block ids to show in the grid.
//   Hovering a slot shows the block name; clicking calls onPick(id)
//   (the screen stays open — the caller decides when to close).
//   iconFor(id) -> canvas | dataURL | element | null (null falls back to a
//   colored swatch derived from the block name).

import { getBlockDef } from '../blocks/blocks.js';

/** "snow_grass" -> "Snow Grass" */
function prettyName(name) {
  return String(name)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

function fallbackSwatch(name) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const hue = hashHue(name);
  g.fillStyle = `hsl(${hue}, 42%, 46%)`;
  g.fillRect(0, 0, 32, 32);
  g.fillStyle = `hsl(${hue}, 50%, 62%)`;
  g.fillRect(0, 0, 32, 10);
  g.fillStyle = `hsl(${hue}, 44%, 30%)`;
  g.fillRect(0, 26, 32, 6);
  g.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, 30, 30);
  return c;
}

function iconElement(icon) {
  if (icon == null) return null;
  if (typeof icon === 'string') {
    const img = document.createElement('img');
    img.src = icon;
    img.alt = '';
    img.draggable = false;
    return img;
  }
  if (typeof HTMLCanvasElement !== 'undefined' && icon instanceof HTMLCanvasElement) {
    const img = document.createElement('img');
    img.src = icon.toDataURL();
    img.alt = '';
    img.draggable = false;
    return img;
  }
  if (icon instanceof HTMLElement) return icon;
  return null;
}

export function initInventory({ onPick, iconFor } = {}) {
  let root = document.getElementById('inventory');
  if (!root) {
    root = document.createElement('div');
    root.id = 'inventory';
    document.body.appendChild(root);
  }
  root.classList.add('overlay', 'inv-overlay');
  root.textContent = '';

  const panel = document.createElement('div');
  panel.className = 'vx-panel inv-panel';
  const title = document.createElement('h2');
  title.className = 'menu-h2';
  title.textContent = 'Blocks';
  const hint = document.createElement('p');
  hint.className = 'inv-hint';
  hint.textContent = 'Click a block to put it in your hand';
  const grid = document.createElement('div');
  grid.className = 'inv-grid';
  panel.append(title, hint, grid);
  root.appendChild(panel);

  let openState = false;

  function setBlocks(ids) {
    grid.textContent = '';
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      const def = getBlockDef(id);
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = 'inv-slot';
      slot.dataset.name = prettyName(def.name);
      slot.dataset.blockId = String(id);
      slot.setAttribute('aria-label', slot.dataset.name);
      const el = iconElement(iconFor ? iconFor(id) : null) || fallbackSwatch(def.name);
      el.classList.add('inv-icon');
      slot.appendChild(el);
      slot.addEventListener('click', () => {
        if (typeof onPick === 'function') onPick(id);
      });
      grid.appendChild(slot);
    }
  }

  function open() {
    openState = true;
    root.classList.add('visible');
  }

  function close() {
    openState = false;
    root.classList.remove('visible');
  }

  function toggle() {
    if (openState) close();
    else open();
  }

  function isOpen() {
    return openState;
  }

  return { toggle, open, close, isOpen, setBlocks };
}
