// Loomfall — survival inventory data model (PURE module: no three.js, no
// DOM — runs under plain node; tests/inventory.test.mjs).
//
// This is the P0 survival inventory: item STACKS `{ id, count }` across a
// 41-slot container (hotbar 9 + main 27 + armor 4 + offhand 1) with the
// cursor-stack click semantics of docs/UX_SPEC.md §6.10 (the slot
// interaction matrix). The old creative `Inventory.js` (9 id-only slots) is
// untouched — creative mode keeps using it; the UI stage wires this model
// into survival screens.
//
// Item ids are either NUMERIC engine block ids (blocks.js, 0..31) or STRING
// item ids from content/items.json (`raw_skein`, `needle_iron_blade`, ...).
// A slot therefore stores `{ id: number|string, count: int >= 1 }`.
//
// Max stack sizes: blocks stack to 64. String items default to 64 unless the
// items.json entry defines `maxStack`/`stackSize`, or the id matches the
// tool/armor pattern (pickaxe/axe/spade/blade/shears/needle/helm/mail/
// leggings/boots/saddle_frame) — those are unstackable (1). Pass the
// items.json `items` array into the constructor (the game hands over
// ContentPack.items(); tests read the JSON via fs) to honor per-item fields.

export const HOTBAR_SIZE = 9;
export const MAIN_SIZE = 27;
export const ARMOR_SIZE = 4;

export const HOTBAR_START = 0; // 0..8
export const MAIN_START = 9; // 9..35
export const ARMOR_START = 36; // 36 head, 37 chest, 38 legs, 39 feet
export const OFFHAND_INDEX = 40;
export const SLOT_COUNT = 41;

/** Armor sub-slot order (index - ARMOR_START). */
export const ARMOR_SLOTS = Object.freeze(['head', 'chest', 'legs', 'feet']);

export const DEFAULT_MAX_STACK = 64;

// String-item ids matching this are unstackable tools/armor/equipment.
const UNSTACKABLE_RE =
  /(pickaxe|axe|spade|blade|shears|needle|helm|mail|leggings|boots)$|^saddle_frame$/;

// Armor typing by canonical id suffix (items.json armor pieces).
const ARMOR_SUFFIX = Object.freeze({
  _helm: 0,
  _mail: 1,
  _leggings: 2,
  _boots: 3,
});

/**
 * Build an id -> item-definition map from an items.json `items` array.
 * Accepts an array, an existing Map, or null.
 * @param {Array<object>|Map<string,object>|null} items
 * @returns {Map<string, object>}
 */
export function createItemsIndex(items) {
  if (items instanceof Map) return items;
  const index = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item && item.id != null) index.set(item.id, item);
  }
  return index;
}

/**
 * Max stack size for an item id. Numbers (engine blocks) stack to 64.
 * Strings honor items.json `maxStack`/`stackSize` when present, else the
 * unstackable tool/armor pattern (-> 1), else 64.
 * @param {number|string} id
 * @param {Map<string, object>} [itemsIndex]
 * @returns {number}
 */
export function maxStackFor(id, itemsIndex) {
  if (typeof id === 'number') return DEFAULT_MAX_STACK;
  const def = itemsIndex ? itemsIndex.get(id) : null;
  if (def) {
    const declared = def.maxStack != null ? def.maxStack : def.stackSize;
    if (Number.isInteger(declared) && declared >= 1) return declared;
  }
  if (UNSTACKABLE_RE.test(String(id))) return 1;
  return DEFAULT_MAX_STACK;
}

/**
 * Armor sub-slot (0 head / 1 chest / 2 legs / 3 feet) an id may equip into,
 * or null. items.json `armorSlot`/`slot` ('head'|'chest'|'legs'|'feet')
 * wins over the id-suffix heuristic.
 * @param {number|string} id
 * @param {Map<string, object>} [itemsIndex]
 * @returns {number|null}
 */
export function armorSlotFor(id, itemsIndex) {
  if (typeof id !== 'string') return null;
  const def = itemsIndex ? itemsIndex.get(id) : null;
  if (def) {
    const declared = def.armorSlot != null ? def.armorSlot : def.slot;
    const byName = ARMOR_SLOTS.indexOf(declared);
    if (byName !== -1) return byName;
  }
  for (const suffix of Object.keys(ARMOR_SUFFIX)) {
    if (id.endsWith(suffix)) return ARMOR_SUFFIX[suffix];
  }
  return null;
}

/** Copy of a stack ({id,count}) or null for empty/invalid. @private */
function copyStack(stack) {
  if (!stack || stack.id == null) return null;
  const count = Number.isFinite(stack.count) ? Math.floor(stack.count) : 0;
  if (count <= 0) return null;
  return { id: stack.id, count };
}

/** Same item id (strict — numeric 3 !== string '3'). @private */
function sameId(a, b) {
  return a != null && b != null && a.id === b.id;
}

/**
 * 41-slot survival inventory with cursor-stack semantics (UX_SPEC §6.10).
 *
 * Slot indices: hotbar 0..8, main 9..35, armor 36..39 (head/chest/legs/
 * feet), offhand 40. The CURSOR stack is owned by the UI and passed
 * through `clickSlot()`; the model never retains it.
 */
export class InventoryModel {
  /**
   * @param {object} [options]
   * @param {Array<object>|Map<string,object>} [options.items] items.json
   *   `items` array (or prebuilt index) for maxStack/armor typing.
   * @param {Array<number|string>} [options.offhandIds] ids that shift-click
   *   routes into an empty offhand slot (default none; offhand always
   *   accepts direct placement).
   */
  constructor({ items = null, offhandIds = [] } = {}) {
    this.itemsIndex = createItemsIndex(items);
    this._offhandIds = new Set(offhandIds);
    /** @type {Array<{id:number|string,count:number}|null>} */
    this.slots = new Array(SLOT_COUNT).fill(null);
    /** @type {number} active hotbar index 0..8 */
    this.selected = 0;
    this._listeners = new Set();
  }

  // ---------------------------------------------------------------- events

  /**
   * Subscribe to any state change. Listener receives (model).
   * @param {(model: InventoryModel) => void} fn
   * @returns {() => void} unsubscribe
   */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** @private */
  _emit() {
    for (const fn of this._listeners) {
      try {
        fn(this);
      } catch {
        /* listener errors never corrupt inventory state */
      }
    }
  }

  // ----------------------------------------------------------------- slots

  /** True for a valid slot index. */
  isValidIndex(i) {
    return Number.isInteger(i) && i >= 0 && i < SLOT_COUNT;
  }

  /** Max stack size for an id under this model's items table. */
  maxStack(id) {
    return maxStackFor(id, this.itemsIndex);
  }

  /**
   * May `id` sit in slot `index`? Armor slots are type-filtered; every
   * other slot (incl. offhand) accepts anything.
   */
  canPlace(index, id) {
    if (!this.isValidIndex(index)) return false;
    if (index >= ARMOR_START && index < ARMOR_START + ARMOR_SIZE) {
      return armorSlotFor(id, this.itemsIndex) === index - ARMOR_START;
    }
    return true;
  }

  /** Copy of the stack in slot i, or null. */
  getSlot(i) {
    return this.isValidIndex(i) ? copyStack(this.slots[i]) : null;
  }

  /**
   * Raw setter: put a stack (or null) into slot i. Counts are floored and
   * clamped to the item's max stack; empty/invalid stacks clear the slot.
   * Does NOT apply armor type filters (loaders/tests may place anything).
   */
  setSlot(i, stack) {
    if (!this.isValidIndex(i)) return;
    const copy = copyStack(stack);
    if (copy) copy.count = Math.min(copy.count, this.maxStack(copy.id));
    this.slots[i] = copy;
    this._emit();
  }

  // ------------------------------------------------------------- selection

  /** Select hotbar slot i (0..8). Out-of-range values are ignored. */
  select(i) {
    if (Number.isInteger(i) && i >= 0 && i < HOTBAR_SIZE && i !== this.selected) {
      this.selected = i;
      this._emit();
    }
  }

  /** Move the selection by dir (+1 next / -1 previous), wrapping. */
  cycle(dir) {
    const d = dir > 0 ? 1 : dir < 0 ? -1 : 0;
    if (d === 0) return;
    this.selected = (this.selected + d + HOTBAR_SIZE) % HOTBAR_SIZE;
    this._emit();
  }

  /** Copy of the stack in the selected hotbar slot, or null. */
  get selectedStack() {
    return copyStack(this.slots[this.selected]);
  }

  // ------------------------------------------------------------ bulk ops

  /**
   * Add `count` of `id` (pickup semantics): tops up partial same-id stacks
   * first (hotbar then main), then fills empty slots (hotbar then main).
   * Armor/offhand are never auto-filled.
   * @returns {number} leftover that did not fit
   */
  add(id, count) {
    let remaining = Math.floor(count);
    if (id == null || !Number.isFinite(remaining) || remaining <= 0) return 0;
    const max = this.maxStack(id);
    const general = [];
    for (let i = HOTBAR_START; i < MAIN_START + MAIN_SIZE; i++) general.push(i);

    let changed = false;
    // Pass 1: partial stacks.
    for (const i of general) {
      if (remaining <= 0) break;
      const slot = this.slots[i];
      if (slot && slot.id === id && slot.count < max) {
        const take = Math.min(max - slot.count, remaining);
        slot.count += take;
        remaining -= take;
        changed = true;
      }
    }
    // Pass 2: empty slots.
    for (const i of general) {
      if (remaining <= 0) break;
      if (this.slots[i] == null) {
        const take = Math.min(max, remaining);
        this.slots[i] = { id, count: take };
        remaining -= take;
        changed = true;
      }
    }
    if (changed) this._emit();
    return remaining;
  }

  /**
   * Remove up to `count` of `id` from the general slots (hotbar then main).
   * @returns {number} how many were actually removed
   */
  remove(id, count) {
    let remaining = Math.floor(count);
    if (id == null || !Number.isFinite(remaining) || remaining <= 0) return 0;
    let removed = 0;
    for (let i = HOTBAR_START; i < MAIN_START + MAIN_SIZE && remaining > 0; i++) {
      const slot = this.slots[i];
      if (slot && slot.id === id) {
        const take = Math.min(slot.count, remaining);
        slot.count -= take;
        remaining -= take;
        removed += take;
        if (slot.count <= 0) this.slots[i] = null;
      }
    }
    if (removed > 0) this._emit();
    return removed;
  }

  /** Total count of `id` across ALL slots (incl. armor/offhand). */
  count(id) {
    let total = 0;
    for (const slot of this.slots) if (slot && slot.id === id) total += slot.count;
    return total;
  }

  /**
   * Consume `n` from the selected hotbar stack (block placement, eating).
   * @returns {boolean} false (and no change) when fewer than n available
   */
  consumeSelected(n = 1) {
    const slot = this.slots[this.selected];
    const need = Math.floor(n);
    if (!slot || !Number.isFinite(need) || need <= 0 || slot.count < need) return false;
    slot.count -= need;
    if (slot.count <= 0) this.slots[this.selected] = null;
    this._emit();
    return true;
  }

  // --------------------------------------------------- cursor click matrix

  /**
   * UX_SPEC §6.10 cursor-stack click on a slot.
   *   LMB (button 0): pick all / place all (merge to max, remainder stays
   *     carried) / swap when ids differ.
   *   RMB (button 2): pick half (ceil to cursor) / place one.
   * Armor type filters veto placement AND swap (invalid clicks no-op).
   * @param {number} index slot index
   * @param {number} button DOM button: 0 = LMB, 2 = RMB
   * @param {{id:number|string,count:number}|null} cursor carried stack
   * @returns {{cursor: {id:number|string,count:number}|null}}
   */
  clickSlot(index, button, cursor) {
    let carried = copyStack(cursor);
    if (!this.isValidIndex(index)) return { cursor: carried };
    const slot = this.slots[index];
    let changed = false;

    if (button === 0) {
      if (!carried) {
        if (slot) {
          carried = slot;
          this.slots[index] = null;
          changed = true;
        }
      } else if (!this.canPlace(index, carried.id)) {
        // invalid target: no-op (no place, no swap)
      } else if (!slot) {
        this.slots[index] = carried;
        carried = null;
        changed = true;
      } else if (sameId(slot, carried)) {
        const max = this.maxStack(slot.id);
        const take = Math.min(max - slot.count, carried.count);
        if (take > 0) {
          slot.count += take;
          carried.count -= take;
          if (carried.count <= 0) carried = null;
          changed = true;
        }
      } else {
        this.slots[index] = carried;
        carried = slot;
        changed = true;
      }
    } else if (button === 2) {
      if (!carried) {
        if (slot) {
          const half = Math.ceil(slot.count / 2);
          carried = { id: slot.id, count: half };
          slot.count -= half;
          if (slot.count <= 0) this.slots[index] = null;
          changed = true;
        }
      } else if (this.canPlace(index, carried.id)) {
        if (!slot) {
          this.slots[index] = { id: carried.id, count: 1 };
          carried.count -= 1;
          if (carried.count <= 0) carried = null;
          changed = true;
        } else if (sameId(slot, carried) && slot.count < this.maxStack(slot.id)) {
          slot.count += 1;
          carried.count -= 1;
          if (carried.count <= 0) carried = null;
          changed = true;
        }
        // different id under RMB: no-op (spec: place-one only into
        // empty/same-item slots)
      }
    }

    if (changed) this._emit();
    return { cursor: carried };
  }

  /**
   * Swap two slots (number-key 1-9 hover swap, `F` offhand swap). Both
   * directions must satisfy the slot filters; otherwise no-op.
   * @returns {boolean} true when swapped
   */
  swapSlots(a, b) {
    if (!this.isValidIndex(a) || !this.isValidIndex(b) || a === b) return false;
    const sa = this.slots[a];
    const sb = this.slots[b];
    if (sa && !this.canPlace(b, sa.id)) return false;
    if (sb && !this.canPlace(a, sb.id)) return false;
    if (!sa && !sb) return false;
    this.slots[a] = sb;
    this.slots[b] = sa;
    this._emit();
    return true;
  }

  /**
   * Quick-move (shift-click) the stack at `index`:
   *   - armor/offhand source -> main, then hotbar;
   *   - hotbar/main source: equips into its EMPTY armor slot when
   *     armor-typed; routes into an empty offhand when the id is in
   *     `offhandIds`; else moves to the other section (hotbar <-> main),
   *     merging into same-id partial stacks first, then empty slots.
   * Leftover that does not fit stays in the source slot.
   * @returns {boolean} true when anything moved
   */
  shiftClick(index) {
    if (!this.isValidIndex(index)) return false;
    const stack = this.slots[index];
    if (!stack) return false;

    const inHotbar = index < MAIN_START;
    const inMain = index >= MAIN_START && index < MAIN_START + MAIN_SIZE;
    /** @type {number[]} destination slot order */
    let dest;

    if (inHotbar || inMain) {
      const armorIdx = armorSlotFor(stack.id, this.itemsIndex);
      if (armorIdx != null && this.slots[ARMOR_START + armorIdx] == null) {
        this.slots[ARMOR_START + armorIdx] = stack;
        this.slots[index] = null;
        this._emit();
        return true;
      }
      if (this._offhandIds.has(stack.id) && this.slots[OFFHAND_INDEX] == null) {
        this.slots[OFFHAND_INDEX] = stack;
        this.slots[index] = null;
        this._emit();
        return true;
      }
      dest = [];
      const [start, size] = inHotbar ? [MAIN_START, MAIN_SIZE] : [HOTBAR_START, HOTBAR_SIZE];
      for (let i = start; i < start + size; i++) dest.push(i);
    } else {
      // armor / offhand -> main first, then hotbar
      dest = [];
      for (let i = MAIN_START; i < MAIN_START + MAIN_SIZE; i++) dest.push(i);
      for (let i = HOTBAR_START; i < HOTBAR_START + HOTBAR_SIZE; i++) dest.push(i);
    }

    const max = this.maxStack(stack.id);
    let moved = false;
    // Merge into partial stacks first.
    for (const i of dest) {
      if (stack.count <= 0) break;
      const s = this.slots[i];
      if (s && s.id === stack.id && s.count < max) {
        const take = Math.min(max - s.count, stack.count);
        s.count += take;
        stack.count -= take;
        moved = true;
      }
    }
    // Then empty slots.
    for (const i of dest) {
      if (stack.count <= 0) break;
      if (this.slots[i] == null) {
        const take = Math.min(max, stack.count);
        this.slots[i] = { id: stack.id, count: take };
        stack.count -= take;
        moved = true;
      }
    }
    if (stack.count <= 0) this.slots[index] = null;
    if (moved) this._emit();
    return moved;
  }

  /**
   * Double-LMB gather: pull same-id items from every general slot into the
   * carried stack, smallest stacks first, up to the id's max stack.
   * @param {{id:number|string,count:number}} cursor non-empty carried stack
   * @returns {{cursor: {id:number|string,count:number}|null}}
   */
  gatherToCursor(cursor) {
    const carried = copyStack(cursor);
    if (!carried) return { cursor: null };
    const max = this.maxStack(carried.id);
    const sources = [];
    for (let i = HOTBAR_START; i < MAIN_START + MAIN_SIZE; i++) {
      const s = this.slots[i];
      if (s && s.id === carried.id) sources.push(i);
    }
    sources.sort((a, b) => this.slots[a].count - this.slots[b].count);
    let changed = false;
    for (const i of sources) {
      if (carried.count >= max) break;
      const s = this.slots[i];
      const take = Math.min(max - carried.count, s.count);
      carried.count += take;
      s.count -= take;
      if (s.count <= 0) this.slots[i] = null;
      changed = true;
    }
    if (changed) this._emit();
    return { cursor: carried };
  }

  // ------------------------------------------------------------------ drop

  /**
   * Drop from slot `index` (Q / Ctrl+Q while hovering): one item, or the
   * whole stack when `all`.
   * @returns {{id:number|string,count:number}|null} the dropped stack
   */
  dropSlot(index, all = false) {
    if (!this.isValidIndex(index)) return null;
    const slot = this.slots[index];
    if (!slot) return null;
    const count = all ? slot.count : 1;
    slot.count -= count;
    if (slot.count <= 0) this.slots[index] = null;
    this._emit();
    return { id: slot.id, count };
  }

  /**
   * Drop from the selected hotbar slot (Q / Ctrl+Q in-world).
   * @returns {{id:number|string,count:number}|null}
   */
  dropSelected(all = false) {
    return this.dropSlot(this.selected, all);
  }

  // ----------------------------------------------------------- persistence

  /** JSON-safe snapshot: `{ version, selected, slots }`. */
  serialize() {
    return {
      version: 1,
      selected: this.selected,
      slots: this.slots.map((s) => (s ? { id: s.id, count: s.count } : null)),
    };
  }

  /**
   * Restore a `serialize()` snapshot (unknown fields ignored; oversized
   * counts clamped; malformed slots dropped). Emits one change event.
   * @returns {this}
   */
  deserialize(data) {
    const next = new Array(SLOT_COUNT).fill(null);
    const src = data && Array.isArray(data.slots) ? data.slots : [];
    for (let i = 0; i < SLOT_COUNT && i < src.length; i++) {
      const copy = copyStack(src[i]);
      if (copy) copy.count = Math.min(copy.count, this.maxStack(copy.id));
      next[i] = copy;
    }
    this.slots = next;
    const sel = data ? data.selected : 0;
    this.selected = Number.isInteger(sel) && sel >= 0 && sel < HOTBAR_SIZE ? sel : 0;
    this._emit();
    return this;
  }

  /** Build a model from a snapshot. Options as the constructor. */
  static deserialize(data, options) {
    return new InventoryModel(options).deserialize(data);
  }
}

export default InventoryModel;
