// Loomfall — crafting recipe matcher (PURE module: no three.js, no DOM —
// runs under plain node; tests/crafting.test.mjs).
//
// Matches NxN crafting grids (2x2 personal grid, 3x3 crafting table —
// generalized to any square) against the RESOLVED 9-cell recipe grids in
// content/items.json. Matching is Minecraft-standard shaped matching:
// the recipe's 3x3 shape is trimmed to its bounding box of non-empty
// cells, the input grid is trimmed the same way, and the two trimmed
// patterns must be identical — so a 2x2 recipe crafts anywhere in a 3x3
// grid, and a 3-tall recipe can never fit a 2x2 grid. Horizontal MIRROR
// variants match too (left-handed axes). Recipes flagged `shapeless: true`
// in items.json match as ingredient multisets (none are flagged today,
// but the path is wired and tested).
//
// Grid slots hold InventoryModel stacks `{ id: number|string, count }`.
// NUMERIC engine block ids are normalized to their canonical naming.json
// ids through blocks.js + systems/naming.js CANON_BLOCK_ID (11 planks ->
// 'knotwood_plank', 3 stone -> 'threadstone', 14 iron_ore ->
// 'needle_iron', ...), because items.json recipe cells reference canonical
// ids only. Engine blocks with no canonical counterpart normalize to their
// engine name ('cobblestone').

import { BLOCKS } from '../blocks/blocks.js';
import { CANON_BLOCK_ID } from '../systems/naming.js';
import { createItemsIndex, maxStackFor } from './InventoryModel.js';

/**
 * Normalize a grid-slot id to the canonical ingredient id used by
 * items.json recipe cells. Strings pass through; numeric block ids map to
 * their canonical naming.json id (or the engine block name when unmapped).
 * @param {number|string|null} id
 * @returns {string|null}
 */
export function normalizeIngredientId(id) {
  if (id == null) return null;
  if (typeof id === 'string') return id;
  const block = BLOCKS[id];
  if (!block) return null;
  return CANON_BLOCK_ID[block.name] || block.name;
}

/**
 * Trim a w x h cell grid to the bounding box of its non-null cells.
 * @param {Array<string|null>} cells row-major, length w*h
 * @param {number} w
 * @param {number} h
 * @returns {{w:number, h:number, cells: Array<string|null>}|null} null when
 *   every cell is empty
 */
export function trimGrid(cells, w, h) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (cells[y * w + x] != null) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX === -1) return null;
  const tw = maxX - minX + 1;
  const th = maxY - minY + 1;
  const out = new Array(tw * th);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      out[y * tw + x] = cells[(minY + y) * w + (minX + x)];
    }
  }
  return { w: tw, h: th, cells: out };
}

/** Mirror a trimmed grid horizontally (reverse each row). @private */
function mirrorGrid(trimmed) {
  const { w, h, cells } = trimmed;
  const out = new Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = cells[y * w + (w - 1 - x)];
  }
  return { w, h, cells: out };
}

/** Cell-for-cell equality of two trimmed grids. @private */
function gridsEqual(a, b) {
  if (a.w !== b.w || a.h !== b.h) return false;
  for (let i = 0; i < a.cells.length; i++) if (a.cells[i] !== b.cells[i]) return false;
  return true;
}

/** Sorted non-null ingredient list (shapeless multiset key). @private */
function multiset(cells) {
  return cells.filter((c) => c != null).sort();
}

/**
 * Recipe book over an items.json `items` array. One instance per items
 * table; the game builds it from ContentPack.items().
 */
export class Crafting {
  /**
   * @param {object} options
   * @param {Array<object>|Map<string,object>} options.items items.json
   *   `items` array (each with `{ id, recipe: { shape: (string|null)[9],
   *   shapeless?, count? } }`). Items whose shape is all-null (source-only
   *   drops/trades) are not craftable and are skipped.
   */
  constructor({ items } = {}) {
    this.itemsIndex = createItemsIndex(items);
    /** @type {Array<object>} compiled craftable recipes */
    this.recipes = [];
    for (const item of this.itemsIndex.values()) {
      const shape = item && item.recipe && Array.isArray(item.recipe.shape)
        ? item.recipe.shape
        : null;
      if (!shape || shape.length !== 9) continue;
      const trimmed = trimGrid(shape, 3, 3);
      if (!trimmed) continue; // all-null: source-only item, not crafted
      const count = Number.isInteger(item.recipe.count) && item.recipe.count >= 1
        ? item.recipe.count
        : 1;
      this.recipes.push({
        id: item.id,
        item,
        result: Object.freeze({ id: item.id, count }),
        shapeless: item.recipe.shapeless === true,
        trimmed,
        mirrored: mirrorGrid(trimmed),
        ingredients: multiset(shape),
      });
    }
  }

  /**
   * Normalize a grid of stacks into trimmed canonical-id cells.
   * @param {Array<{id:number|string,count:number}|null>} gridSlots length
   *   n*n (4 / 9 / 16 / ...)
   * @returns {{w:number,h:number,cells:Array<string|null>, all:Array<string|null>}|null}
   *   null for an empty or non-square grid
   * @private
   */
  _normalizeGrid(gridSlots) {
    if (!Array.isArray(gridSlots)) return null;
    const n = Math.round(Math.sqrt(gridSlots.length));
    if (n * n !== gridSlots.length || n < 1) return null;
    const cells = gridSlots.map((s) =>
      s && s.id != null && s.count > 0 ? normalizeIngredientId(s.id) : null
    );
    const trimmed = trimGrid(cells, n, n);
    if (!trimmed) return null;
    trimmed.all = cells;
    return trimmed;
  }

  /**
   * Match a crafting grid against the recipe book.
   * @param {Array<{id:number|string,count:number}|null>} gridSlots square
   *   grid, row-major (length 4 for the 2x2 personal grid, 9 for a table).
   * @returns {{id:string, item:object, result:{id:string,count:number},
   *   shapeless:boolean}|null} the matched recipe, or null
   */
  match(gridSlots) {
    const grid = this._normalizeGrid(gridSlots);
    if (!grid) return null;
    const gridSet = multiset(grid.all);
    for (const recipe of this.recipes) {
      if (recipe.shapeless) {
        if (
          gridSet.length === recipe.ingredients.length &&
          gridSet.every((c, i) => c === recipe.ingredients[i])
        ) {
          return recipe;
        }
        continue;
      }
      if (gridsEqual(grid, recipe.trimmed) || gridsEqual(grid, recipe.mirrored)) {
        return recipe;
      }
    }
    return null;
  }

  /**
   * Result-stack preview for the current grid ({id,count} copy, or null).
   */
  preview(gridSlots) {
    const recipe = this.match(gridSlots);
    return recipe ? { id: recipe.result.id, count: recipe.result.count } : null;
  }

  /**
   * Take the crafting result once (a click on the result slot): consume ONE
   * of each non-empty grid ingredient and merge the result into the cursor.
   * Refused (crafted:false, nothing consumed) when the grid matches no
   * recipe, or the cursor holds a different item, or merging would exceed
   * the result's max stack.
   * @param {Array<{id:number|string,count:number}|null>} gridSlots
   * @param {{id:number|string,count:number}|null} cursor carried stack
   * @returns {{crafted:boolean, cursor:object|null, grid:Array<object|null>,
   *   result:{id:string,count:number}|null}} new cursor + new grid (copies;
   *   inputs are not mutated)
   */
  takeResult(gridSlots, cursor) {
    const copyGrid = () =>
      gridSlots.map((s) => (s && s.count > 0 ? { id: s.id, count: s.count } : null));
    const carried = cursor && cursor.count > 0 ? { id: cursor.id, count: cursor.count } : null;
    const recipe = this.match(gridSlots);
    if (!recipe) {
      return { crafted: false, cursor: carried, grid: copyGrid(), result: null };
    }
    const result = { id: recipe.result.id, count: recipe.result.count };
    if (carried) {
      const max = maxStackFor(result.id, this.itemsIndex);
      if (carried.id !== result.id || carried.count + result.count > max) {
        return { crafted: false, cursor: carried, grid: copyGrid(), result };
      }
    }
    const grid = copyGrid().map((s) => {
      if (!s) return null;
      const next = { id: s.id, count: s.count - 1 };
      return next.count > 0 ? next : null;
    });
    const nextCursor = carried
      ? { id: carried.id, count: carried.count + result.count }
      : result;
    return { crafted: true, cursor: nextCursor, grid, result: { ...recipe.result } };
  }

  /**
   * Recipes whose trimmed shape fits an n x n grid (shapeless recipes fit
   * when their ingredient count does).
   * @param {number} n grid edge (2 = personal grid, 3 = crafting table)
   * @returns {string[]} craftable item ids
   */
  craftableWithin(n) {
    return this.recipes
      .filter((r) =>
        r.shapeless ? r.ingredients.length <= n * n : r.trimmed.w <= n && r.trimmed.h <= n
      )
      .map((r) => r.id);
  }
}

export default Crafting;
