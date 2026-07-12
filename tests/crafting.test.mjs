// Loomfall — Crafting recipe-matcher node tests (no framework).
// Run: node tests/crafting.test.mjs
//
// Covers: shaped matching against content/items.json resolved 9-cell grids,
// bounding-box trimming (recipes craft anywhere in a larger grid; 2x2
// recipes work in the 2x2 personal grid), horizontal mirroring, numeric
// engine-block-id normalization (11 planks -> knotwood_plank), shapeless
// recipes, ingredient consumption, and result-to-cursor overflow rules.

import { readFileSync } from 'node:fs';
import {
  Crafting,
  normalizeIngredientId,
  trimGrid,
} from '../public/src/gameplay/Crafting.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const ITEMS = JSON.parse(readFileSync('public/content/items.json', 'utf8')).items;
const book = new Crafting({ items: ITEMS });

/** Build a stack grid from bare ids (null passes through). */
const grid = (...ids) => ids.map((id) => (id == null ? null : { id, count: 1 }));
const KP = 'knotwood_plank';
const NI = 'needle_iron';
const TS = 'threadstone';
const LT = 'loose_thread';

// ── normalization ──────────────────────────────────────────────────────────
check('normalize: numeric block ids -> canonical naming.json ids',
  normalizeIngredientId(11) === 'knotwood_plank' && // planks
  normalizeIngredientId(3) === 'threadstone' &&     // stone
  normalizeIngredientId(14) === 'needle_iron' &&    // iron_ore
  normalizeIngredientId(16) === 'dawnthread' &&     // diamond_ore
  normalizeIngredientId(15) === 'giltspool');       // gold_ore
check('normalize: unmapped engine blocks keep their engine name',
  normalizeIngredientId(4) === 'cobblestone');
check('normalize: string ids pass through, null/unknown -> null',
  normalizeIngredientId('raw_skein') === 'raw_skein' &&
  normalizeIngredientId(null) === null && normalizeIngredientId(999) === null);

// ── registry shape ─────────────────────────────────────────────────────────
{
  const total = book.recipes.length;
  const sourceOnly = ITEMS.filter((i) => i.recipe.shape.every((c) => c == null)).length;
  check(`registry: ${ITEMS.length} items -> 34 craftable recipes (${sourceOnly} source-only skipped)`,
    total === 34 && ITEMS.length === 41 && sourceOnly === 7, `total=${total}`);
  const in2 = book.craftableWithin(2).sort();
  check('registry: exactly 4 recipes are 2x2-craftable',
    JSON.stringify(in2) ===
    JSON.stringify(['loose_thread', 'mothdust_poultice', 'needle_iron_shears', 'woven_cloth']),
    JSON.stringify(in2));
  check('registry: every craftable recipe fits the 3x3 table',
    book.craftableWithin(3).length === 34);
}

// ── shaped matching: exact 3x3 ─────────────────────────────────────────────
check('match: handloom full 3x3 (strings)',
  book.match(grid(KP, 'raw_skein', KP, KP, 'raw_skein', KP, KP, KP, KP))?.id === 'handloom');
check('match: handloom with NUMERIC planks (block id 11)',
  book.match(grid(11, 'raw_skein', 11, 11, 'raw_skein', 11, 11, 11, 11))?.id === 'handloom');
check('match: knotwood_pickaxe',
  book.match(grid(KP, KP, KP, null, KP, null, null, KP, null))?.id === 'knotwood_pickaxe');
check('match: threadstone_blade via numeric stone (3,3) + plank column',
  book.match(grid(null, 3, null, null, 3, null, null, 11, null))?.id === 'threadstone_blade');

// ── trimming: position independence ────────────────────────────────────────
check('trim: woven_cloth 2x2 in the TOP-LEFT of a 3x3 grid',
  book.match(grid(LT, LT, null, LT, LT, null, null, null, null))?.id === 'woven_cloth');
check('trim: woven_cloth 2x2 in the BOTTOM-RIGHT of a 3x3 grid',
  book.match(grid(null, null, null, null, LT, LT, null, LT, LT))?.id === 'woven_cloth');
check('trim: woven_cloth in the 2x2 personal grid',
  book.match(grid(LT, LT, LT, LT))?.id === 'woven_cloth');
check('trim: 1x1 loose_thread from raw_skein anywhere (corner of 2x2)',
  book.match(grid(null, null, null, 'raw_skein'))?.id === 'loose_thread' &&
  book.match(grid(null, null, null, null, null, null, null, null, 'raw_skein'))?.id === 'loose_thread');
check('trim: column recipe matches in any column',
  book.match(grid(TS, null, null, TS, null, null, KP, null, null))?.id === 'threadstone_blade' &&
  book.match(grid(null, null, TS, null, null, TS, null, null, KP))?.id === 'threadstone_blade');
check('trimGrid: all-empty grid trims to null', trimGrid([null, null, null, null], 2, 2) === null);

// ── mirroring ──────────────────────────────────────────────────────────────
check('mirror: knotwood_axe canonical (left column) matches',
  book.match(grid(KP, KP, null, KP, KP, null, null, KP, null))?.id === 'knotwood_axe');
check('mirror: knotwood_axe HORIZONTALLY MIRRORED matches',
  book.match(grid(null, KP, KP, null, KP, KP, null, KP, null))?.id === 'knotwood_axe');
check('mirror: needle_iron_shears mirrored in the 2x2 grid',
  book.match(grid(null, NI, NI, null))?.id === 'needle_iron_shears' &&
  book.match(grid(NI, null, null, NI))?.id === 'needle_iron_shears');

// ── negatives ──────────────────────────────────────────────────────────────
check('negative: empty grid matches nothing',
  book.match(grid(null, null, null, null)) === null &&
  book.match([]) === null && book.match(null) === null);
check('negative: non-square grid rejected',
  book.match(grid(LT, LT, LT, LT, LT)) === null);
check('negative: wrong ingredient (stone instead of plank)',
  book.match(grid(TS, TS, TS, null, TS, null, null, TS, null)) === null);
check('negative: extra item outside the pattern breaks the match',
  book.match(grid(LT, LT, null, LT, LT, null, null, null, 'raw_skein')) === null);
check('negative: right shape, extra stray in a recipe hole',
  book.match(grid(KP, KP, KP, null, KP, KP, null, KP, null)) === null);
check('negative: vertical mirror does NOT match (pickaxe upside down)',
  book.match(grid(null, KP, null, null, KP, null, KP, KP, KP)) === null);
check('negative: 3-tall recipe ingredients jammed into the 2x2 grid',
  book.match(grid(TS, null, TS, KP)) === null);
check('negative: zero-count stacks are empty cells',
  book.match([{ id: LT, count: 0 }, { id: LT, count: 1 }, { id: LT, count: 1 }, { id: LT, count: 1 }]) === null);

// ── preview ────────────────────────────────────────────────────────────────
{
  const p = book.preview(grid(LT, LT, LT, LT));
  check('preview: returns the result stack copy', p && p.id === 'woven_cloth' && p.count === 1);
  check('preview: null when nothing matches', book.preview(grid(null, LT, LT, LT)) === null);
}

// ── takeResult: consumption ────────────────────────────────────────────────
{
  const g = [
    { id: LT, count: 3 }, { id: LT, count: 2 },
    { id: LT, count: 2 }, { id: LT, count: 1 },
  ];
  const r = book.takeResult(g, null);
  check('takeResult: crafts and consumes ONE of each ingredient',
    r.crafted === true && r.cursor.id === 'woven_cloth' && r.cursor.count === 1 &&
    r.grid[0].count === 2 && r.grid[1].count === 1 &&
    r.grid[2].count === 1 && r.grid[3] === null,
    JSON.stringify(r.grid));
  check('takeResult: input grid array is NOT mutated',
    g[3].count === 1 && g[0].count === 3);
  check('takeResult: emptied cell breaks the shape (no repeat match)',
    book.match(r.grid) === null && r.grid[3] === null);
  const g2 = grid(LT, LT, LT, LT).map((s) => ({ ...s, count: 2 }));
  const first = book.takeResult(g2, null);
  const again = book.takeResult(first.grid, first.cursor);
  check('takeResult: repeat craft merges into same-id cursor (1 -> 2)',
    again.crafted === true && again.cursor.count === 2 && again.grid.every((c) => c === null));
}

// ── takeResult: cursor rules ───────────────────────────────────────────────
{
  const g = grid(LT, LT, LT, LT);
  let r = book.takeResult(g, { id: 'knot_charm', count: 1 });
  check('takeResult: DIFFERENT-id cursor refuses (nothing consumed)',
    r.crafted === false && r.cursor.id === 'knot_charm' && r.grid[0].count === 1);
  r = book.takeResult(g, { id: 'woven_cloth', count: 64 });
  check('takeResult: cursor at max stack refuses (overflow rule)',
    r.crafted === false && r.cursor.count === 64 && r.grid[0].count === 1);
  r = book.takeResult(g, { id: 'woven_cloth', count: 63 });
  check('takeResult: cursor just under max merges to exactly 64',
    r.crafted === true && r.cursor.count === 64);

  // unstackable result: shears (max 1)
  const shears = grid(null, NI, NI, null);
  r = book.takeResult(shears, null);
  check('takeResult: unstackable result to empty cursor',
    r.crafted === true && r.cursor.id === 'needle_iron_shears' && r.cursor.count === 1);
  r = book.takeResult(shears, { id: 'needle_iron_shears', count: 1 });
  check('takeResult: unstackable result refused onto a held one (max 1)',
    r.crafted === false && r.cursor.count === 1);
  r = book.takeResult(grid(null, null, null, null), null);
  check('takeResult: no match -> crafted:false, result:null',
    r.crafted === false && r.result === null && r.cursor === null);
}

// ── shapeless (injected table; items.json defines none today) ──────────────
{
  const custom = new Crafting({
    items: [
      ...ITEMS,
      { id: 'thread_wad', displayName: 'Thread Wad', tier: 0,
        recipe: { shape: [LT, 'raw_skein', null, null, null, null, null, null, null],
                  shapeless: true, count: 2 } },
    ],
  });
  check('shapeless: matches in any arrangement',
    custom.match(grid('raw_skein', null, null, LT))?.id === 'thread_wad' &&
    custom.match(grid(null, LT, null, null, null, null, null, null, 'raw_skein'))?.id === 'thread_wad');
  check('shapeless: exact multiset required (extra/missing ingredient fails)',
    custom.match(grid(LT, LT, 'raw_skein', null)) === null &&
    custom.match(grid(LT, null, null, null)) === null);
  const r = custom.takeResult(grid('raw_skein', LT, null, null), null);
  check('shapeless: recipe.count honored in the result stack',
    r.crafted === true && r.cursor.id === 'thread_wad' && r.cursor.count === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
