// ============================================================================
// mobs/lootTables.js
//
// Loomfall loot tables for mob archetypes.
//
// Item ids below are the REAL canonical ids from content/items.json /
// content/naming.json (not placeholders). Full set of ids referenced here:
//   raw_skein, thread_sinew, hide_cloth, knot_charm, lore_scroll,
//   loose_thread, scorched_silk, tallowstone, cinderthread, emberskein_ore,
//   needle_iron, voidknot
// (mothdust is a valid item id but is not used by any table below.)
//
// 'unpicked' (The Unpicked) intentionally drops nothing — canonically it
// leaves no corpse. 'lastneedle' (The Last Needle) intentionally drops
// nothing — it is the final boss and is bound, not killed, so it has no
// loot table. Do not add 'the_last_stitch' (does not exist in items.json)
// or 'everthread' (drops from molthkin, an unimplemented Cinderloom boss,
// not from the Last Needle) to either table.
//
// MobManager emits a 'mobDrop' event { mobId, itemId, pos, count } per
// dropped stack when a mob dies — this module only computes *what* drops
// (see rollLoot); wiring the event emission is MobManager's job.
// ============================================================================

// ----------------------------------------------------------------------
// LOOT_TABLES: archetype -> array of { itemId, chance, min, max }
//   chance: 0..1 independent roll probability for this entry
//   min/max: inclusive stack size range rolled uniformly on a hit
// ----------------------------------------------------------------------
export const LOOT_TABLES = {
  // Warpwold
  grazer: [
    { itemId: 'raw_skein', chance: 0.9, min: 1, max: 2 },
  ],
  bobbindeer: [
    { itemId: 'thread_sinew', chance: 0.9, min: 1, max: 1 },
    { itemId: 'hide_cloth', chance: 0.6, min: 1, max: 1 },
  ],
  trader: [
    { itemId: 'knot_charm', chance: 0.4, min: 1, max: 1 },
    { itemId: 'lore_scroll', chance: 0.1, min: 1, max: 1 },
  ],
  groaner: [
    { itemId: 'loose_thread', chance: 0.8, min: 1, max: 2 },
  ],
  frayedhound: [
    { itemId: 'thread_sinew', chance: 0.6, min: 1, max: 1 },
    { itemId: 'hide_cloth', chance: 0.3, min: 1, max: 1 },
  ],
  needlejack: [
    { itemId: 'thread_sinew', chance: 0.7, min: 1, max: 1 },
    { itemId: 'needle_iron', chance: 0.15, min: 1, max: 1 },
  ],

  // Cinderloom
  emberspinner: [
    { itemId: 'scorched_silk', chance: 0.75, min: 1, max: 1 },
  ],
  exploder: [
    { itemId: 'tallowstone', chance: 0.5, min: 1, max: 1 },
  ],
  screecher: [
    { itemId: 'cinderthread', chance: 0.4, min: 1, max: 1 },
  ],
  scaldwarden: [
    { itemId: 'emberskein_ore', chance: 0.6, min: 1, max: 1 },
    { itemId: 'scorched_silk', chance: 0.3, min: 1, max: 1 },
  ],

  // Nevermend
  raveler: [
    { itemId: 'loose_thread', chance: 0.7, min: 1, max: 2 },
    { itemId: 'voidknot', chance: 0.2, min: 1, max: 1 },
  ],

  // No corpse / no loot (canonical)
  unpicked: [],

  // Final boss — bound, not killed; no loot table
  lastneedle: [],
};

// ----------------------------------------------------------------------
// rollLoot(archetype, rng)
//   rng: () => number in [0,1). Defaults to Math.random when omitted.
//   Returns: array of { itemId, count }
//   Defensive: unknown archetype -> [].
// ----------------------------------------------------------------------
export function rollLoot(archetype, rng) {
  const roll = typeof rng === 'function' ? rng : Math.random;
  const table = LOOT_TABLES[archetype];
  if (!table) return [];

  const drops = [];
  for (const entry of table) {
    if (roll() < entry.chance) {
      const { min, max } = entry;
      const count = min >= max ? min : min + Math.floor(roll() * (max - min + 1));
      drops.push({ itemId: entry.itemId, count });
    }
  }
  return drops;
}

export default { LOOT_TABLES, rollLoot };
