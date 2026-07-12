// Loomfall — InventoryModel node tests (no framework).
// Run: node tests/inventory.test.mjs
//
// Covers the P0 survival inventory data layer: stacking/merge/overflow,
// unstackables, the UX_SPEC §6.10 cursor click matrix (LMB/RMB x
// empty/full/same-id/diff-id), half-pick rounding, place-one, shift-click
// routing incl. armor/offhand filters, drops, serialize round-trip, events.

import { readFileSync } from 'node:fs';
import {
  InventoryModel,
  HOTBAR_SIZE,
  MAIN_START,
  MAIN_SIZE,
  ARMOR_START,
  OFFHAND_INDEX,
  SLOT_COUNT,
  maxStackFor,
  armorSlotFor,
  createItemsIndex,
} from '../public/src/gameplay/InventoryModel.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const ITEMS = JSON.parse(readFileSync('public/content/items.json', 'utf8')).items;
const mk = (extra = {}) => new InventoryModel({ items: ITEMS, ...extra });
const DIRT = 2; // numeric engine block id
const STONE = 3;

// ── layout & static helpers ────────────────────────────────────────────────
check('layout: 41 slots (9 hotbar + 27 main + 4 armor + 1 offhand)',
  SLOT_COUNT === 41 && MAIN_START === 9 && ARMOR_START === 36 && OFFHAND_INDEX === 40);

{
  const idx = createItemsIndex(ITEMS);
  check('maxStack: numeric block ids stack to 64', maxStackFor(DIRT, idx) === 64);
  check('maxStack: material string ids stack to 64',
    maxStackFor('loose_thread', idx) === 64 && maxStackFor('raw_skein', idx) === 64);
  check('maxStack: tools/armor/needles are unstackable (1)',
    maxStackFor('knotwood_pickaxe', idx) === 1 &&
    maxStackFor('needle_iron_shears', idx) === 1 &&
    maxStackFor('mending_needle', idx) === 1 &&
    maxStackFor('everthread_mail', idx) === 1 &&
    maxStackFor('saddle_frame', idx) === 1);
  check('armorSlotFor: helm/mail/leggings/boots -> 0..3, others null',
    armorSlotFor('needle_iron_helm', idx) === 0 &&
    armorSlotFor('everthread_mail', idx) === 1 &&
    armorSlotFor('needle_iron_leggings', idx) === 2 &&
    armorSlotFor('everthread_boots', idx) === 3 &&
    armorSlotFor('loose_thread', idx) === null &&
    armorSlotFor(DIRT, idx) === null);
}

// ── add(): partial-first, hotbar-first, leftover ───────────────────────────
{
  const inv = mk();
  inv.setSlot(4, { id: DIRT, count: 60 }); // hotbar partial
  inv.setSlot(MAIN_START + 2, { id: DIRT, count: 10 }); // main partial
  const left = inv.add(DIRT, 20);
  check('add: tops up hotbar partial before main partial',
    inv.getSlot(4).count === 64 && inv.getSlot(MAIN_START + 2).count === 26 && left === 0,
    JSON.stringify([inv.getSlot(4), inv.getSlot(MAIN_START + 2), left]));

  const inv2 = mk();
  inv2.setSlot(0, { id: STONE, count: 64 });
  const left2 = inv2.add(DIRT, 70);
  check('add: fills empty hotbar slots first, splitting at max stack',
    inv2.getSlot(1) && inv2.getSlot(1).id === DIRT && inv2.getSlot(1).count === 64 &&
    inv2.getSlot(2) && inv2.getSlot(2).count === 6 && left2 === 0,
    JSON.stringify([inv2.getSlot(1), inv2.getSlot(2)]));

  const full = mk();
  for (let i = 0; i < MAIN_START + MAIN_SIZE; i++) full.setSlot(i, { id: DIRT, count: 64 });
  check('add: full inventory returns full leftover, armor/offhand untouched',
    full.add(DIRT, 33) === 33 && full.getSlot(ARMOR_START) === null &&
    full.getSlot(OFFHAND_INDEX) === null);

  const partial = mk();
  for (let i = 0; i < MAIN_START + MAIN_SIZE; i++) partial.setSlot(i, { id: DIRT, count: 64 });
  partial.setSlot(20, { id: DIRT, count: 62 });
  check('add: partial leftover when only some fits', partial.add(DIRT, 10) === 8);
}

// ── unstackables never merge ───────────────────────────────────────────────
{
  const inv = mk();
  inv.setSlot(0, { id: 'needle_iron_shears', count: 1 });
  const left = inv.add('needle_iron_shears', 2);
  check('unstackable: add() places 1 per slot, never merges',
    inv.getSlot(0).count === 1 && inv.getSlot(1).count === 1 &&
    inv.getSlot(2).count === 1 && left === 0);
  check('unstackable: setSlot clamps count to 1',
    (inv.setSlot(5, { id: 'knotwood_blade', count: 9 }), inv.getSlot(5).count === 1));
  const r = inv.clickSlot(0, 0, { id: 'needle_iron_shears', count: 1 });
  check('unstackable: LMB same-id on full max-1 slot is a no-op (stays carried)',
    r.cursor && r.cursor.count === 1 && inv.getSlot(0).count === 1);
}

// ── cursor click matrix: LMB ───────────────────────────────────────────────
{
  const inv = mk();
  inv.setSlot(0, { id: DIRT, count: 40 });

  let r = inv.clickSlot(0, 0, null);
  check('LMB empty-cursor on stack: picks up ALL',
    r.cursor.id === DIRT && r.cursor.count === 40 && inv.getSlot(0) === null);

  r = inv.clickSlot(3, 0, r.cursor);
  check('LMB cursor on empty slot: places ALL',
    r.cursor === null && inv.getSlot(3).count === 40);

  r = inv.clickSlot(9, 0, null);
  check('LMB empty-cursor on empty slot: no-op', r.cursor === null && inv.getSlot(9) === null);

  inv.setSlot(3, { id: DIRT, count: 60 });
  r = inv.clickSlot(3, 0, { id: DIRT, count: 10 });
  check('LMB same-id merge to max: remainder stays carried',
    inv.getSlot(3).count === 64 && r.cursor.count === 6);

  inv.setSlot(4, { id: STONE, count: 7 });
  r = inv.clickSlot(4, 0, { id: DIRT, count: 5 });
  check('LMB different-id: swap carried <-> slot',
    r.cursor.id === STONE && r.cursor.count === 7 &&
    inv.getSlot(4).id === DIRT && inv.getSlot(4).count === 5);

  r = inv.clickSlot(99, 0, { id: DIRT, count: 5 });
  check('clickSlot: out-of-range index leaves cursor unchanged',
    r.cursor.id === DIRT && r.cursor.count === 5);
}

// ── cursor click matrix: RMB ───────────────────────────────────────────────
{
  const inv = mk();
  inv.setSlot(0, { id: DIRT, count: 5 });
  let r = inv.clickSlot(0, 2, null);
  check('RMB empty-cursor: picks HALF, ceil to cursor (5 -> 3/2)',
    r.cursor.count === 3 && inv.getSlot(0).count === 2);

  inv.setSlot(1, { id: DIRT, count: 1 });
  r = inv.clickSlot(1, 2, null);
  check('RMB half-pick of a single item empties the slot',
    r.cursor.count === 1 && inv.getSlot(1) === null);

  r = inv.clickSlot(2, 2, { id: STONE, count: 4 });
  check('RMB on empty slot: places exactly one',
    inv.getSlot(2).id === STONE && inv.getSlot(2).count === 1 && r.cursor.count === 3);

  r = inv.clickSlot(2, 2, r.cursor);
  check('RMB same-id with room: places one more',
    inv.getSlot(2).count === 2 && r.cursor.count === 2);

  r = inv.clickSlot(0, 2, { id: STONE, count: 2 });
  check('RMB different-id: no-op (no swap, nothing placed)',
    r.cursor.count === 2 && inv.getSlot(0).id === DIRT && inv.getSlot(0).count === 2);

  inv.setSlot(5, { id: DIRT, count: 64 });
  r = inv.clickSlot(5, 2, { id: DIRT, count: 3 });
  check('RMB same-id at max stack: no-op',
    r.cursor.count === 3 && inv.getSlot(5).count === 64);

  r = inv.clickSlot(6, 2, { id: STONE, count: 1 });
  check('RMB placing the last carried item empties the cursor',
    r.cursor === null && inv.getSlot(6).count === 1);
}

// ── armor / offhand filters ────────────────────────────────────────────────
{
  const inv = mk();
  let r = inv.clickSlot(ARMOR_START, 0, { id: 'needle_iron_helm', count: 1 });
  check('armor: helm places into head slot',
    r.cursor === null && inv.getSlot(ARMOR_START).id === 'needle_iron_helm');

  r = inv.clickSlot(ARMOR_START + 1, 0, { id: 'needle_iron_helm', count: 1 });
  check('armor: helm REFUSED by chest slot (LMB no-op)',
    r.cursor.id === 'needle_iron_helm' && inv.getSlot(ARMOR_START + 1) === null);

  r = inv.clickSlot(ARMOR_START, 0, { id: 'everthread_boots', count: 1 });
  check('armor: invalid item cannot swap into an occupied armor slot',
    r.cursor.id === 'everthread_boots' && inv.getSlot(ARMOR_START).id === 'needle_iron_helm');

  r = inv.clickSlot(ARMOR_START + 3, 2, { id: DIRT, count: 8 });
  check('armor: RMB place-one refused for non-armor item',
    r.cursor.count === 8 && inv.getSlot(ARMOR_START + 3) === null);

  r = inv.clickSlot(ARMOR_START, 0, null);
  check('armor: pickup from armor slot always allowed',
    r.cursor.id === 'needle_iron_helm' && inv.getSlot(ARMOR_START) === null);

  r = inv.clickSlot(OFFHAND_INDEX, 0, { id: DIRT, count: 12 });
  check('offhand: accepts any item via direct click',
    r.cursor === null && inv.getSlot(OFFHAND_INDEX).count === 12);
}

// ── swapSlots (number-key / F hover swap) ──────────────────────────────────
{
  const inv = mk();
  inv.setSlot(MAIN_START, { id: STONE, count: 9 });
  inv.setSlot(2, { id: DIRT, count: 4 });
  check('swapSlots: swaps hovered main slot with hotbar slot',
    inv.swapSlots(MAIN_START, 2) === true &&
    inv.getSlot(MAIN_START).id === DIRT && inv.getSlot(2).id === STONE);
  inv.setSlot(ARMOR_START, null);
  check('swapSlots: refuses moving a non-armor item into an armor slot',
    inv.swapSlots(2, ARMOR_START) === false && inv.getSlot(2).id === STONE);
  check('swapSlots: two empty slots is a no-op', inv.swapSlots(7, 8) === false);
}

// ── shiftClick routing ─────────────────────────────────────────────────────
{
  const inv = mk();
  inv.setSlot(0, { id: DIRT, count: 30 });
  inv.setSlot(MAIN_START + 1, { id: DIRT, count: 60 });
  check('shiftClick: hotbar -> main merges into partials then empties',
    inv.shiftClick(0) === true && inv.getSlot(0) === null &&
    inv.getSlot(MAIN_START + 1).count === 64 && inv.getSlot(MAIN_START).count === 26,
    JSON.stringify([inv.getSlot(MAIN_START), inv.getSlot(MAIN_START + 1)]));

  check('shiftClick: main -> hotbar',
    inv.shiftClick(MAIN_START) === true && inv.getSlot(MAIN_START) === null &&
    inv.getSlot(0) && inv.getSlot(0).count === 26);

  inv.setSlot(5, { id: 'everthread_boots', count: 1 });
  check('shiftClick: armor-typed item equips into its EMPTY armor slot',
    inv.shiftClick(5) === true && inv.getSlot(ARMOR_START + 3).id === 'everthread_boots' &&
    inv.getSlot(5) === null);

  inv.setSlot(5, { id: 'needle_iron_boots', count: 1 });
  inv.shiftClick(5);
  check('shiftClick: occupied armor slot -> falls back to section move',
    inv.getSlot(ARMOR_START + 3).id === 'everthread_boots' &&
    inv.getSlot(5) === null && inv.count('needle_iron_boots') === 1);

  check('shiftClick: from armor slot -> back into main/hotbar',
    inv.shiftClick(ARMOR_START + 3) === true && inv.getSlot(ARMOR_START + 3) === null &&
    inv.count('everthread_boots') === 1);

  check('shiftClick: empty slot returns false', inv.shiftClick(8) === false);

  // full destination: nothing moves
  const jam = mk();
  for (let i = MAIN_START; i < MAIN_START + MAIN_SIZE; i++) jam.setSlot(i, { id: STONE, count: 64 });
  jam.setSlot(0, { id: DIRT, count: 10 });
  check('shiftClick: full destination leaves the stack in place',
    jam.shiftClick(0) === false && jam.getSlot(0).count === 10);

  // partial move: leftover stays in source
  const part = mk();
  for (let i = MAIN_START; i < MAIN_START + MAIN_SIZE; i++) part.setSlot(i, { id: DIRT, count: 64 });
  part.setSlot(MAIN_START + 4, { id: DIRT, count: 50 });
  part.setSlot(0, { id: DIRT, count: 40 });
  check('shiftClick: partial fit moves what fits, leftover stays',
    part.shiftClick(0) === true && part.getSlot(MAIN_START + 4).count === 64 &&
    part.getSlot(0).count === 26);

  const off = mk({ offhandIds: ['knot_charm'] });
  off.setSlot(3, { id: 'knot_charm', count: 2 });
  check('shiftClick: offhandIds route into an empty offhand',
    off.shiftClick(3) === true && off.getSlot(OFFHAND_INDEX).id === 'knot_charm' &&
    off.getSlot(3) === null);
}

// ── gather (double-LMB) ────────────────────────────────────────────────────
{
  const inv = mk();
  inv.setSlot(0, { id: DIRT, count: 10 });
  inv.setSlot(MAIN_START, { id: DIRT, count: 60 });
  inv.setSlot(MAIN_START + 1, { id: STONE, count: 5 });
  const r = inv.gatherToCursor({ id: DIRT, count: 2 });
  check('gather: pulls matching stacks (smallest first) up to max stack',
    r.cursor.count === 64 && inv.getSlot(0) === null &&
    inv.getSlot(MAIN_START).count === 8 && inv.getSlot(MAIN_START + 1).count === 5,
    JSON.stringify([r.cursor, inv.getSlot(MAIN_START)]));
}

// ── drops ──────────────────────────────────────────────────────────────────
{
  const inv = mk();
  inv.setSlot(2, { id: DIRT, count: 5 });
  inv.select(2);
  let d = inv.dropSelected(false);
  check('dropSelected: Q drops exactly one and removes it',
    d.id === DIRT && d.count === 1 && inv.getSlot(2).count === 4);
  d = inv.dropSelected(true);
  check('dropSelected: Ctrl+Q drops the whole stack, slot empties',
    d.count === 4 && inv.getSlot(2) === null);
  check('dropSelected: empty slot returns null', inv.dropSelected() === null);
  inv.setSlot(MAIN_START + 3, { id: STONE, count: 1 });
  d = inv.dropSlot(MAIN_START + 3, false);
  check('dropSlot: dropping the last item empties the slot',
    d.count === 1 && inv.getSlot(MAIN_START + 3) === null);
}

// ── selection / count / remove / consume ───────────────────────────────────
{
  const inv = mk();
  inv.setSlot(1, { id: DIRT, count: 3 });
  inv.select(1);
  check('select + selectedStack', inv.selectedStack.id === DIRT);
  inv.select(99);
  check('select: out-of-range ignored', inv.selected === 1);
  inv.cycle(-1);
  check('cycle wraps', inv.selected === 0);
  inv.cycle(1);
  check('cycle forward', inv.selected === 1);

  inv.setSlot(OFFHAND_INDEX, { id: DIRT, count: 7 });
  inv.setSlot(MAIN_START, { id: DIRT, count: 10 });
  check('count: sums across hotbar/main/offhand, ids strict', inv.count(DIRT) === 20 && inv.count('2') === 0);
  check('remove: takes hotbar first, reports removed',
    inv.remove(DIRT, 5) === 5 && inv.getSlot(1) === null && inv.getSlot(MAIN_START).count === 8);
  check('remove: never touches offhand/armor',
    inv.remove(DIRT, 99) === 8 && inv.getSlot(OFFHAND_INDEX).count === 7);

  inv.setSlot(1, { id: STONE, count: 2 });
  check('consumeSelected: takes n from selected slot',
    inv.consumeSelected(1) === true && inv.getSlot(1).count === 1);
  check('consumeSelected: refuses when short (no change)',
    inv.consumeSelected(2) === false && inv.getSlot(1).count === 1);
  check('consumeSelected: emptying clears the slot',
    inv.consumeSelected(1) === true && inv.getSlot(1) === null);
}

// ── serialize round-trip ───────────────────────────────────────────────────
{
  const inv = mk();
  inv.setSlot(0, { id: DIRT, count: 12 });
  inv.setSlot(MAIN_START + 5, { id: 'loose_thread', count: 33 });
  inv.setSlot(ARMOR_START + 1, { id: 'needle_iron_mail', count: 1 });
  inv.setSlot(OFFHAND_INDEX, { id: 'knot_charm', count: 4 });
  inv.select(6);
  const json = JSON.stringify(inv.serialize());
  const back = InventoryModel.deserialize(JSON.parse(json), { items: ITEMS });
  check('serialize: JSON round-trip preserves all slots + selection',
    JSON.stringify(back.serialize()) === json && back.selected === 6 &&
    back.getSlot(ARMOR_START + 1).id === 'needle_iron_mail');
  const dirty = InventoryModel.deserialize(
    { version: 1, selected: 42, slots: [{ id: DIRT, count: 999 }, { id: null, count: 3 }, 'junk'] },
    { items: ITEMS });
  check('deserialize: clamps oversized counts, drops malformed slots, resets bad selection',
    dirty.getSlot(0).count === 64 && dirty.getSlot(1) === null && dirty.getSlot(2) === null &&
    dirty.selected === 0);
}

// ── events ─────────────────────────────────────────────────────────────────
{
  const inv = mk();
  let events = 0;
  const off = inv.onChange(() => events++);
  inv.setSlot(0, { id: DIRT, count: 1 });
  inv.add(DIRT, 5);
  inv.clickSlot(0, 0, null);
  const before = events;
  inv.clickSlot(1, 0, null); // no-op click: empty cursor on empty slot
  check('events: mutations emit onChange, no-op clicks do not',
    before === 3 && events === 3, `events=${events}`);
  off();
  inv.setSlot(0, { id: DIRT, count: 1 });
  check('events: unsubscribe stops delivery', events === 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
