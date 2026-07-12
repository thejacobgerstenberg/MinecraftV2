// Voxelheim UI — inventory screen (E).
//
// Two modes, switched per game session via setSession():
//
//   CREATIVE — the original centered block palette ("Blocks" tab: click a
//   block to put it in your hand), plus an "Inventory" tab showing the nine
//   creative hotbar slots (click to select). Behavior of the palette is
//   unchanged from the pre-survival build.
//
//   SURVIVAL — the full stack inventory over InventoryModel: hotbar row +
//   27-slot main grid + 4 armor slots + offhand + 2x2 personal crafting grid
//   with a live result preview. A cursor stack follows the pointer; clicks
//   use the UX_SPEC §6.10 matrix (LMB pick/place/merge/swap, RMB pick-half/
//   place-one, Shift-click quick-move, double-LMB gather, Q / Ctrl+Q drop
//   the hovered stack, 1-9 hover-swap with the hotbar). The palette is NOT
//   reachable in survival.
//
// The ui-kit <lf-inventory-grid> was evaluated for this screen and NOT
// adopted: its interaction model is attribute-swap moves on a single flat
// grid (whole-stack pick/place/swap), which cannot express the cursor-stack
// split/merge semantics (RMB half/one, merge-to-max with remainder carried),
// typed armor/offhand slots, or the crafting result flow that InventoryModel
// implements — bridging it would mean fighting its internal held-state
// machine. This screen builds on the existing inv-panel styling instead.
//
// Pure DOM module: no three.js import. All DOM access happens inside
// initInventory(), so the module is safe to import under plain node.
//
// API:
//   initInventory({ onPick, iconFor, nameFor }) ->
//     { toggle(), open(), close(), isOpen(), setBlocks(ids), setSession(s) }
//   setBlocks(ids) — creative palette block ids.
//   setSession(session|null) — per game session:
//     creative: { mode:'creative', getSlots(), getSelected(), onSelectSlot(i) }
//     survival: { mode:'survival', model, crafting, onDropStack(stack),
//                 onCraft(result), onSound(kind) }
//   iconFor(id) -> canvas | dataURL | element | null (numeric block ids AND
//   string content item ids); nameFor(id) -> display name.

import { getBlockDef } from '../blocks/blocks.js';
// Canonical Loomfall display names (content/naming.json) — falls back to
// prettified engine names until naming data loads (see systems/naming.js).
import { blockDisplayName, prettyName } from '../systems/naming.js';
import {
  HOTBAR_SIZE, MAIN_START, MAIN_SIZE, ARMOR_START, ARMOR_SIZE, OFFHAND_INDEX,
} from '../gameplay/InventoryModel.js';

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

/** Same-id check (strict — numeric 3 !== '3'). */
function sameId(a, b) {
  return a != null && b != null && a.id === b.id;
}

export function initInventory({ onPick, iconFor, nameFor } = {}) {
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
  root.appendChild(panel);
  panel.addEventListener('contextmenu', (e) => e.preventDefault());

  // Cursor stack element (survival): follows the pointer while carrying.
  const cursorEl = document.createElement('div');
  cursorEl.className = 'inv-cursor';
  cursorEl.style.display = 'none';
  root.appendChild(cursorEl);
  root.addEventListener('pointermove', (e) => {
    cursorEl.style.left = `${e.clientX}px`;
    cursorEl.style.top = `${e.clientY}px`;
  });

  const displayName = (id) => {
    if (typeof nameFor === 'function') {
      const n = nameFor(id);
      if (n) return n;
    }
    return typeof id === 'number'
      ? blockDisplayName(getBlockDef(id).name)
      : prettyName(String(id));
  };

  let openState = false;
  let session = null; // setSession() — null on the title screen
  let paletteIds = []; // setBlocks()

  // Survival screen state (UI-owned, per open/close lifetime).
  let cursor = null; // carried stack {id, count} | null
  let craftGrid = [null, null, null, null]; // 2x2 personal grid (row-major)
  let hoverKey = null; // 'm<idx>' | 'c<idx>' | 'result' | null
  let activeTab = 'blocks'; // creative tabs

  // ------------------------------------------------------------------ render

  /** Fill a slot element with a stack (or empty). */
  function renderStackInto(slotEl, stack) {
    slotEl.textContent = '';
    slotEl.removeAttribute('data-name');
    if (!stack) return;
    const name = typeof stack.id === 'number'
      ? getBlockDef(stack.id).name
      : String(stack.id);
    const el = iconElement(iconFor ? iconFor(stack.id) : null) || fallbackSwatch(name);
    el.classList.add('inv-icon');
    slotEl.appendChild(el);
    if (stack.count > 1) {
      const c = document.createElement('span');
      c.className = 'inv-count';
      c.textContent = String(stack.count);
      slotEl.appendChild(c);
    }
    slotEl.dataset.name = displayName(stack.id);
    slotEl.setAttribute('aria-label',
      `${slotEl.dataset.name}${stack.count > 1 ? ` x${stack.count}` : ''}`);
  }

  function renderCursor() {
    if (!cursor) {
      cursorEl.style.display = 'none';
      cursorEl.textContent = '';
      root.classList.remove('inv-overlay--carrying');
      return;
    }
    cursorEl.style.display = '';
    root.classList.add('inv-overlay--carrying');
    renderStackInto(cursorEl, cursor);
  }

  /** Slot factory. `key` identifies the slot for hover/keys. */
  function makeSlot(key, extraClass = '') {
    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = `inv-slot inv-stack-slot${extraClass ? ` ${extraClass}` : ''}`;
    slot.dataset.slotKey = key;
    slot.addEventListener('pointerenter', () => { hoverKey = key; });
    slot.addEventListener('pointerleave', () => { if (hoverKey === key) hoverKey = null; });
    return slot;
  }

  // Survival DOM (built once per setSession).
  let sv = null; // { slotEls: Map<key, el>, resultEl }

  function buildSurvival() {
    panel.textContent = '';
    sv = { slotEls: new Map(), resultEl: null };

    const title = document.createElement('h2');
    title.className = 'menu-h2';
    title.textContent = 'Inventory';
    panel.appendChild(title);

    const hint = document.createElement('p');
    hint.className = 'inv-hint';
    hint.textContent =
      'LMB move · RMB split/one · Shift quick-move · Q drop · 1-9 swap';
    panel.appendChild(hint);

    // Top band: armor + offhand | 2x2 craft -> result.
    const top = document.createElement('div');
    top.className = 'inv-top';

    const gear = document.createElement('div');
    gear.className = 'inv-gear';
    const gearLabel = document.createElement('div');
    gearLabel.className = 'inv-section-label';
    gearLabel.textContent = 'Gear';
    gear.appendChild(gearLabel);
    const gearRow = document.createElement('div');
    gearRow.className = 'inv-gear-row';
    const armorNames = ['Head', 'Chest', 'Legs', 'Feet'];
    for (let a = 0; a < ARMOR_SIZE; a++) {
      const slot = makeSlot(`m${ARMOR_START + a}`, 'inv-slot--armor');
      slot.dataset.placeholder = armorNames[a];
      gearRow.appendChild(slot);
      sv.slotEls.set(`m${ARMOR_START + a}`, slot);
    }
    const off = makeSlot(`m${OFFHAND_INDEX}`, 'inv-slot--offhand');
    off.dataset.placeholder = 'Off';
    gearRow.appendChild(off);
    sv.slotEls.set(`m${OFFHAND_INDEX}`, off);
    gear.appendChild(gearRow);

    const craft = document.createElement('div');
    craft.className = 'inv-craft';
    const craftLabel = document.createElement('div');
    craftLabel.className = 'inv-section-label';
    craftLabel.textContent = 'Craft';
    craft.appendChild(craftLabel);
    const craftRow = document.createElement('div');
    craftRow.className = 'inv-craft-row';
    const grid2 = document.createElement('div');
    grid2.className = 'inv-craft-grid';
    for (let i = 0; i < 4; i++) {
      const slot = makeSlot(`c${i}`);
      grid2.appendChild(slot);
      sv.slotEls.set(`c${i}`, slot);
    }
    const arrow = document.createElement('div');
    arrow.className = 'inv-craft-arrow';
    arrow.textContent = '→';
    const result = makeSlot('result', 'inv-slot--result');
    sv.resultEl = result;
    sv.slotEls.set('result', result);
    craftRow.append(grid2, arrow, result);
    craft.appendChild(craftRow);

    top.append(gear, craft);
    panel.appendChild(top);

    // Main 27-slot grid.
    const main = document.createElement('div');
    main.className = 'inv-grid inv-grid--main';
    for (let i = 0; i < MAIN_SIZE; i++) {
      const slot = makeSlot(`m${MAIN_START + i}`);
      main.appendChild(slot);
      sv.slotEls.set(`m${MAIN_START + i}`, slot);
    }
    panel.appendChild(main);

    // Hotbar row.
    const hotbar = document.createElement('div');
    hotbar.className = 'inv-grid inv-grid--hotbar';
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = makeSlot(`m${i}`, 'inv-slot--hotbar');
      hotbar.appendChild(slot);
      sv.slotEls.set(`m${i}`, slot);
    }
    panel.appendChild(hotbar);
  }

  function renderSurvival() {
    if (!sv || !session || session.mode !== 'survival') return;
    const model = session.model;
    for (let i = 0; i < 41; i++) {
      const el = sv.slotEls.get(`m${i}`);
      if (el) renderStackInto(el, model.getSlot(i));
    }
    for (let i = 0; i < 4; i++) {
      renderStackInto(sv.slotEls.get(`c${i}`), craftGrid[i]);
    }
    // Live result preview.
    const preview = session.crafting ? session.crafting.preview(craftGrid) : null;
    renderStackInto(sv.resultEl, preview);
    sv.resultEl.classList.toggle('inv-slot--result-ready', !!preview);
    renderCursor();
  }

  // ------------------------------------------------------- survival actions

  /** Cursor-click semantics for the UI-owned 2x2 craft slots (mirrors
   *  InventoryModel.clickSlot; the model owns only its 41 slots). */
  function clickCraftSlot(i, button) {
    const model = session.model;
    const slot = craftGrid[i];
    if (button === 0) {
      if (!cursor) {
        if (slot) { cursor = slot; craftGrid[i] = null; }
      } else if (!slot) {
        craftGrid[i] = cursor;
        cursor = null;
      } else if (sameId(slot, cursor)) {
        const max = model.maxStack(slot.id);
        const take = Math.min(max - slot.count, cursor.count);
        if (take > 0) {
          slot.count += take;
          cursor.count -= take;
          if (cursor.count <= 0) cursor = null;
        }
      } else {
        craftGrid[i] = cursor;
        cursor = slot;
      }
    } else if (button === 2) {
      if (!cursor) {
        if (slot) {
          const half = Math.ceil(slot.count / 2);
          cursor = { id: slot.id, count: half };
          slot.count -= half;
          if (slot.count <= 0) craftGrid[i] = null;
        }
      } else if (!slot) {
        craftGrid[i] = { id: cursor.id, count: 1 };
        cursor.count -= 1;
        if (cursor.count <= 0) cursor = null;
      } else if (sameId(slot, cursor) && slot.count < model.maxStack(slot.id)) {
        slot.count += 1;
        cursor.count -= 1;
        if (cursor.count <= 0) cursor = null;
      }
    }
  }

  /** Take the crafting result once (click) or craft-all (shift-click). */
  function takeCraftResult(shift) {
    const { crafting, model, onCraft, onDropStack } = session;
    if (!crafting) return;
    if (!shift) {
      const res = crafting.takeResult(craftGrid, cursor);
      if (!res.crafted) return;
      cursor = res.cursor;
      craftGrid = res.grid;
      if (typeof onCraft === 'function') onCraft(res.result);
      return;
    }
    // Shift-click: craft repeatedly into the inventory.
    for (let guard = 0; guard < 64; guard++) {
      const res = crafting.takeResult(craftGrid, null);
      if (!res.crafted) break;
      craftGrid = res.grid;
      if (typeof onCraft === 'function') onCraft(res.result);
      const leftover = model.add(res.result.id, res.result.count);
      if (leftover > 0) {
        if (typeof onDropStack === 'function') {
          onDropStack({ id: res.result.id, count: leftover });
        }
        break; // inventory full — stop crafting
      }
    }
  }

  function onSurvivalPointerDown(e) {
    if (!session || session.mode !== 'survival') return;
    const slotEl = e.target && e.target.closest ? e.target.closest('.inv-stack-slot') : null;
    if (!slotEl) return;
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    const key = slotEl.dataset.slotKey;
    const model = session.model;
    if (key === 'result') {
      if (e.button === 0) takeCraftResult(e.shiftKey);
    } else if (key.startsWith('c')) {
      const i = Number(key.slice(1));
      if (e.shiftKey && e.button === 0) {
        // Quick-move back into the inventory.
        const stack = craftGrid[i];
        if (stack) {
          const leftover = model.add(stack.id, stack.count);
          craftGrid[i] = leftover > 0 ? { id: stack.id, count: leftover } : null;
        }
      } else {
        clickCraftSlot(i, e.button);
      }
    } else if (key.startsWith('m')) {
      const idx = Number(key.slice(1));
      if (e.shiftKey && e.button === 0) {
        model.shiftClick(idx);
      } else {
        const res = model.clickSlot(idx, e.button, cursor);
        cursor = res.cursor;
      }
    }
    if (typeof session.onSound === 'function') session.onSound('click');
    renderSurvival();
  }

  function onSurvivalDblClick(e) {
    if (!session || session.mode !== 'survival' || !cursor) return;
    const slotEl = e.target && e.target.closest ? e.target.closest('.inv-stack-slot') : null;
    if (!slotEl) return;
    // Double-LMB gather: pull same-id stacks into the carried stack.
    const res = session.model.gatherToCursor(cursor);
    cursor = res.cursor;
    renderSurvival();
  }

  /** Q / Ctrl+Q drop of the hovered stack; 1-9 hover-swap. */
  function onSurvivalKeyDown(e) {
    if (!openState || !session || session.mode !== 'survival') return;
    const model = session.model;
    if (e.code === 'KeyQ' && hoverKey) {
      let dropped = null;
      if (hoverKey.startsWith('m')) {
        dropped = model.dropSlot(Number(hoverKey.slice(1)), !!e.ctrlKey);
      } else if (hoverKey.startsWith('c')) {
        const i = Number(hoverKey.slice(1));
        const slot = craftGrid[i];
        if (slot) {
          const count = e.ctrlKey ? slot.count : 1;
          slot.count -= count;
          if (slot.count <= 0) craftGrid[i] = null;
          dropped = { id: slot.id, count };
        }
      }
      if (dropped && typeof session.onDropStack === 'function') {
        session.onDropStack(dropped);
      }
      renderSurvival();
    } else if (/^Digit[1-9]$/.test(e.code) && hoverKey && hoverKey.startsWith('m')) {
      const hotbarIdx = e.code.charCodeAt(5) - 49; // '1' -> 0
      model.swapSlots(Number(hoverKey.slice(1)), hotbarIdx);
      renderSurvival();
    }
  }
  window.addEventListener('keydown', onSurvivalKeyDown);
  // One delegated pointerdown/dblclick pair handles every survival slot
  // (registered once — the handlers no-op outside survival sessions).
  panel.addEventListener('pointerdown', onSurvivalPointerDown);
  panel.addEventListener('dblclick', onSurvivalDblClick);

  /** Return the cursor + craft grid to the inventory (or drop overflow). */
  function stashLooseStacks() {
    if (!session || session.mode !== 'survival') return;
    const model = session.model;
    const give = (stack) => {
      if (!stack) return;
      const leftover = model.add(stack.id, stack.count);
      if (leftover > 0 && typeof session.onDropStack === 'function') {
        session.onDropStack({ id: stack.id, count: leftover });
      }
    };
    give(cursor);
    cursor = null;
    for (let i = 0; i < 4; i++) {
      give(craftGrid[i]);
      craftGrid[i] = null;
    }
    renderCursor();
  }

  // ------------------------------------------------------------- creative

  let creativeEls = null; // { grid, tabButtons, hotbarRow }

  function buildCreative() {
    panel.textContent = '';
    creativeEls = { tabButtons: {}, grid: null, hotbarRow: null };

    const title = document.createElement('h2');
    title.className = 'menu-h2';
    title.textContent = 'Blocks';
    panel.appendChild(title);

    // Tab bar (creative only): Blocks palette / creative hotbar view.
    const tabs = document.createElement('div');
    tabs.className = 'inv-tabs';
    for (const [id, label] of [['blocks', 'Blocks'], ['inventory', 'Inventory']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vx-btn vx-btn--small inv-tab';
      b.dataset.tab = id;
      b.textContent = label;
      b.addEventListener('click', () => {
        activeTab = id;
        renderCreative();
      });
      tabs.appendChild(b);
      creativeEls.tabButtons[id] = b;
    }
    panel.appendChild(tabs);

    const hint = document.createElement('p');
    hint.className = 'inv-hint';
    panel.appendChild(hint);
    creativeEls.hint = hint;

    const grid = document.createElement('div');
    grid.className = 'inv-grid';
    panel.appendChild(grid);
    creativeEls.grid = grid;
  }

  function renderCreative() {
    if (!creativeEls) return;
    const tab = activeTab === 'inventory' ? 'inventory' : 'blocks';
    for (const [id, b] of Object.entries(creativeEls.tabButtons)) {
      b.classList.toggle('vx-btn--primary', id === tab);
    }
    const grid = creativeEls.grid;
    grid.textContent = '';
    if (tab === 'blocks') {
      creativeEls.hint.textContent = 'Click a block to put it in your hand';
      for (const id of paletteIds) {
        const def = getBlockDef(id);
        const slot = document.createElement('button');
        slot.type = 'button';
        slot.className = 'inv-slot';
        slot.dataset.name = displayName(id);
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
    } else {
      creativeEls.hint.textContent = 'Your hotbar — click a slot to select it';
      const slots = session && typeof session.getSlots === 'function' ? session.getSlots() : [];
      const selected = session && typeof session.getSelected === 'function'
        ? session.getSelected() : -1;
      for (let i = 0; i < HOTBAR_SIZE; i++) {
        const id = slots[i] || 0;
        const slot = document.createElement('button');
        slot.type = 'button';
        slot.className = `inv-slot${i === selected ? ' inv-slot--selected' : ''}`;
        if (id) {
          slot.dataset.name = displayName(id);
          slot.setAttribute('aria-label', slot.dataset.name);
          const el = iconElement(iconFor ? iconFor(id) : null)
            || fallbackSwatch(getBlockDef(id).name);
          el.classList.add('inv-icon');
          slot.appendChild(el);
        }
        slot.addEventListener('click', () => {
          if (session && typeof session.onSelectSlot === 'function') session.onSelectSlot(i);
          renderCreative();
        });
        grid.appendChild(slot);
      }
    }
  }

  // ------------------------------------------------------------- public API

  let unsubscribeModel = null;

  function setSession(next) {
    // Leaving a survival session: return anything loose first.
    if (openState) close();
    if (unsubscribeModel) { unsubscribeModel(); unsubscribeModel = null; }
    session = next || null;
    cursor = null;
    craftGrid = [null, null, null, null];
    hoverKey = null;
    activeTab = 'blocks';
    sv = null;
    creativeEls = null;
    panel.textContent = '';
    if (!session) return;
    if (session.mode === 'survival') {
      buildSurvival();
      renderSurvival();
      unsubscribeModel = session.model.onChange(() => {
        if (openState) renderSurvival();
      });
    } else {
      buildCreative();
      renderCreative();
    }
  }

  function setBlocks(ids) {
    paletteIds = Array.isArray(ids) ? [...ids] : [];
    if (creativeEls) renderCreative();
  }

  function open() {
    openState = true;
    root.classList.add('visible');
    if (session && session.mode === 'survival') renderSurvival();
    else if (creativeEls) renderCreative();
  }

  function close() {
    if (openState && session && session.mode === 'survival') stashLooseStacks();
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

  return { toggle, open, close, isOpen, setBlocks, setSession };
}
