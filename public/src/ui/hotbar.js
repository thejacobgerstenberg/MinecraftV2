// Voxelheim UI — hotbar (9 slots, selection highlight, block icons).
//
// Pure DOM module: no three.js import. All DOM access happens inside
// initHotbar(), so the module is safe to import under plain node.
//
// API:
//   initHotbar({ container, iconFor }) -> { setSlots(ids), setSelected(i) }
//     container — optional element to render into (defaults to #hotbar,
//                 created and appended to <body> if missing).
//     iconFor   — optional (blockId) -> HTMLCanvasElement | dataURL string |
//                 HTMLElement | null. When null/absent, a colored swatch is
//                 derived from the block name.
//   setSlots(ids)   — array of up to 9 block ids (0/null/undefined = empty).
//   setSelected(i)  — 0-based slot index; highlights it and briefly shows
//                     the block name above the hotbar.

import { getBlockDef } from '../blocks/blocks.js';

const SLOT_COUNT = 9;

/** "snow_grass" -> "Snow Grass" */
function prettyName(name) {
  return String(name)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Deterministic hue (0-359) from a block name. */
function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

/** Fallback icon: a shaded blocky swatch colored from the block name. */
function fallbackSwatch(name) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const hue = hashHue(name);
  g.fillStyle = `hsl(${hue}, 42%, 46%)`;
  g.fillRect(0, 0, 32, 32);
  g.fillStyle = `hsl(${hue}, 50%, 62%)`; // lit top face
  g.fillRect(0, 0, 32, 10);
  g.fillStyle = `hsl(${hue}, 44%, 30%)`; // shaded bottom edge
  g.fillRect(0, 26, 32, 6);
  g.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, 30, 30);
  return c;
}

/** Normalize any icon result into a fresh <img> (or element) we can append. */
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
    // Copy to an <img> so a shared canvas isn't re-parented between slots.
    const img = document.createElement('img');
    img.src = icon.toDataURL();
    img.alt = '';
    img.draggable = false;
    return img;
  }
  if (icon instanceof HTMLElement) return icon;
  return null;
}

export function initHotbar({ container, iconFor } = {}) {
  let root = container || document.getElementById('hotbar');
  if (!root) {
    root = document.createElement('div');
    root.id = 'hotbar';
    document.body.appendChild(root);
  }
  root.classList.add('hotbar');
  root.textContent = '';

  // Floating "selected block name" label (fixed-positioned, sibling-safe).
  const label = document.createElement('div');
  label.className = 'hotbar-label';
  root.appendChild(label);
  let labelTimer = null;

  const slots = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const slot = document.createElement('div');
    slot.className = 'hb-slot';
    const icon = document.createElement('span');
    icon.className = 'hb-icon';
    const num = document.createElement('span');
    num.className = 'hb-num';
    num.textContent = String(i + 1);
    slot.append(icon, num);
    root.appendChild(slot);
    slots.push({ slot, icon });
  }

  let ids = new Array(SLOT_COUNT).fill(0);
  let selected = 0;

  function renderSlot(i) {
    const { slot, icon } = slots[i];
    const id = ids[i];
    icon.textContent = '';
    slot.removeAttribute('title');
    if (!id) return; // empty (air / unset)
    const def = getBlockDef(id);
    const el = iconElement(iconFor ? iconFor(id) : null) || fallbackSwatch(def.name);
    el.classList.add('hb-icon-img');
    icon.appendChild(el);
    slot.title = prettyName(def.name);
  }

  function setSlots(newIds) {
    ids = new Array(SLOT_COUNT).fill(0);
    if (Array.isArray(newIds)) {
      for (let i = 0; i < Math.min(SLOT_COUNT, newIds.length); i++) {
        ids[i] = newIds[i] || 0;
      }
    }
    for (let i = 0; i < SLOT_COUNT; i++) renderSlot(i);
    setSelected(selected); // refresh label for current selection
  }

  function setSelected(i) {
    selected = Math.max(0, Math.min(SLOT_COUNT - 1, i | 0));
    for (let s = 0; s < SLOT_COUNT; s++) {
      slots[s].slot.classList.toggle('hb-slot--selected', s === selected);
    }
    // Show the block name briefly above the hotbar.
    const id = ids[selected];
    if (id) {
      label.textContent = prettyName(getBlockDef(id).name);
      label.classList.add('hotbar-label--show');
      if (labelTimer) clearTimeout(labelTimer);
      labelTimer = setTimeout(() => label.classList.remove('hotbar-label--show'), 2600);
    } else {
      label.classList.remove('hotbar-label--show');
    }
  }

  setSelected(0);
  return { setSlots, setSelected };
}
