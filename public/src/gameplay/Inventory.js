// Voxelheim — creative hotbar / inventory model (PURE module: no three.js,
// no DOM — runs under plain node).

import { BLOCK_ID, CREATIVE_BLOCKS } from '../blocks/blocks.js';

// Re-export so UI code can import the palette from the inventory module.
export { CREATIVE_BLOCKS } from '../blocks/blocks.js';

const HOTBAR_SIZE = 9;

/**
 * Nine-slot hotbar of block ids plus the creative palette.
 *
 *   slots[9]      — block ids in the hotbar
 *   selected      — active slot index 0..8
 *   creativeBlocks — placeable ids for the creative picker (copy of
 *                    CREATIVE_BLOCKS)
 */
export class Inventory {
  constructor() {
    /** @type {number[]} block ids, length 9 */
    this.slots = [
      BLOCK_ID.grass,
      BLOCK_ID.dirt,
      BLOCK_ID.stone,
      BLOCK_ID.cobblestone,
      BLOCK_ID.planks,
      BLOCK_ID.log,
      BLOCK_ID.glass,
      BLOCK_ID.sand,
      BLOCK_ID.glowstone,
    ];
    /** @type {number} active slot index */
    this.selected = 0;
    /** @type {number[]} creative palette (block ids) */
    this.creativeBlocks = [...CREATIVE_BLOCKS];
  }

  /** Select slot i (0..8). Out-of-range values are ignored. */
  select(i) {
    if (Number.isInteger(i) && i >= 0 && i < HOTBAR_SIZE) this.selected = i;
  }

  /** Move the selection by dir (+1 next / -1 previous), wrapping around. */
  cycle(dir) {
    const d = dir > 0 ? 1 : dir < 0 ? -1 : 0;
    this.selected = (this.selected + d + HOTBAR_SIZE) % HOTBAR_SIZE;
  }

  /** Block id in the currently selected slot. */
  get selectedBlock() {
    return this.slots[this.selected];
  }

  /** Put block id into slot i (0..8). Out-of-range slots are ignored. */
  setSlot(i, id) {
    if (Number.isInteger(i) && i >= 0 && i < HOTBAR_SIZE) this.slots[i] = id;
  }
}
