// Voxelheim UI — hotbar (9 slots, selection highlight, block icons).
//
// Pure DOM module: no three.js import. All DOM access happens inside
// initHotbar(), so the module is safe to import under plain node.
//
// API:
//   initHotbar({ container, iconFor, nameFor }) ->
//     { setSlots(entries), setSelected(i), flash(i), showPickup(text) }
//     container — optional element to render into (defaults to #hotbar,
//                 created and appended to <body> if missing).
//     iconFor   — optional (id) -> HTMLCanvasElement | dataURL string |
//                 HTMLElement | null. When null/absent, a colored swatch is
//                 derived from the item name. `id` may be a numeric block id
//                 or a string content item id (survival stacks).
//     nameFor   — optional (id) -> display name. Defaults to the canonical
//                 block display name for numeric ids / a prettified string.
//   setSlots(entries) — array of up to 9 entries; each entry is a numeric
//                 block id (creative — no counts shown), a survival stack
//                 {id, count}, or 0/null/undefined for empty.
//   setSelected(i)  — 0-based slot index; highlights it and briefly shows
//                     the item name above the hotbar.
//   flash(i)        — brief pickup flash on slot i (survival pickup cue).
//   showPickup(text) — brief "+N Item" toast above the hotbar.

import { getBlockDef } from '../blocks/blocks.js';
// Canonical Loomfall display names (content/naming.json) — falls back to
// prettified engine names until naming data loads (see systems/naming.js).
import { blockDisplayName, prettyName } from '../systems/naming.js';

const SLOT_COUNT = 9;

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

/** Normalize a setSlots entry to {id, count}|null. */
function normalizeEntry(entry) {
  if (entry == null || entry === 0) return null;
  if (typeof entry === 'object') {
    if (entry.id == null || entry.id === 0 || !(entry.count > 0)) return null;
    return { id: entry.id, count: Math.floor(entry.count) };
  }
  return { id: entry, count: 0 }; // bare id (creative): no count badge
}

export function initHotbar({ container, iconFor, nameFor } = {}) {
  let root = container || document.getElementById('hotbar');
  if (!root) {
    root = document.createElement('div');
    root.id = 'hotbar';
    document.body.appendChild(root);
  }
  root.classList.add('hotbar');
  root.textContent = '';

  const displayName = (id) => {
    if (typeof nameFor === 'function') {
      const n = nameFor(id);
      if (n) return n;
    }
    return typeof id === 'number'
      ? blockDisplayName(getBlockDef(id).name)
      : prettyName(String(id));
  };

  // Floating "selected block name" label (fixed-positioned, sibling-safe).
  const label = document.createElement('div');
  label.className = 'hotbar-label';
  root.appendChild(label);
  let labelTimer = null;

  // Pickup toast ("+3 Loose Thread"), above the label position.
  const pickupEl = document.createElement('div');
  pickupEl.className = 'hotbar-pickup';
  root.appendChild(pickupEl);
  let pickupTimer = null;

  const slots = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const slot = document.createElement('div');
    slot.className = 'hb-slot';
    const icon = document.createElement('span');
    icon.className = 'hb-icon';
    const num = document.createElement('span');
    num.className = 'hb-num';
    num.textContent = String(i + 1);
    const count = document.createElement('span');
    count.className = 'hb-count';
    slot.append(icon, num, count);
    root.appendChild(slot);
    slots.push({ slot, icon, count, flashTimer: null });
  }

  let entries = new Array(SLOT_COUNT).fill(null);
  let selected = 0;

  function renderSlot(i) {
    const { slot, icon, count } = slots[i];
    const entry = entries[i];
    icon.textContent = '';
    count.textContent = '';
    slot.removeAttribute('title');
    if (!entry) return; // empty (air / unset)
    const el = iconElement(iconFor ? iconFor(entry.id) : null)
      || fallbackSwatch(typeof entry.id === 'number' ? getBlockDef(entry.id).name : String(entry.id));
    el.classList.add('hb-icon-img');
    icon.appendChild(el);
    if (entry.count > 1) count.textContent = String(entry.count);
    slot.title = displayName(entry.id);
  }

  function setSlots(newEntries) {
    entries = new Array(SLOT_COUNT).fill(null);
    if (Array.isArray(newEntries)) {
      for (let i = 0; i < Math.min(SLOT_COUNT, newEntries.length); i++) {
        entries[i] = normalizeEntry(newEntries[i]);
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
    // Show the item name briefly above the hotbar.
    const entry = entries[selected];
    if (entry) {
      label.textContent = displayName(entry.id);
      label.classList.add('hotbar-label--show');
      if (labelTimer) clearTimeout(labelTimer);
      labelTimer = setTimeout(() => label.classList.remove('hotbar-label--show'), 2600);
    } else {
      label.classList.remove('hotbar-label--show');
    }
  }

  /** Brief white pickup flash on slot i. */
  function flash(i) {
    const s = slots[Math.max(0, Math.min(SLOT_COUNT - 1, i | 0))];
    s.slot.classList.remove('hb-slot--flash');
    // Force restart of the animation.
    void s.slot.offsetWidth; // eslint-disable-line no-void
    s.slot.classList.add('hb-slot--flash');
    if (s.flashTimer) clearTimeout(s.flashTimer);
    s.flashTimer = setTimeout(() => s.slot.classList.remove('hb-slot--flash'), 500);
  }

  /** Brief "+N Item" toast above the hotbar. */
  function showPickup(text) {
    pickupEl.textContent = String(text);
    pickupEl.classList.add('hotbar-pickup--show');
    if (pickupTimer) clearTimeout(pickupTimer);
    pickupTimer = setTimeout(() => pickupEl.classList.remove('hotbar-pickup--show'), 1600);
  }

  setSelected(0);
  return { setSlots, setSelected, flash, showPickup };
}
