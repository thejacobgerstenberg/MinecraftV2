// ============================================================================
// mobs/lootTables.js
//
// Loomfall loot tables for mob archetypes.
//
// NOTE: item ids below are PLACEHOLDER STUBS (plain strings) derived from
// Loomfall canon (content/naming.json) — Warpwold/Cinderloom/Nevermend
// creatures dropping Thrum-touched materials. No content/items.json exists
// yet in this repo; when it lands, these ids must be reconciled against the
// real item registry (renamed/remapped as needed).
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
  grazer: [
    { itemId: 'raw_skein', chance: 0.9, min: 1, max: 2 },
  ],
  trader: [
    { itemId: 'spare_button', chance: 0.1, min: 1, max: 1 },
  ],
  groaner: [
    { itemId: 'tattered_thread', chance: 0.7, min: 1, max: 2 },
    { itemId: 'dawnthread', chance: 0.1, min: 1, max: 1 },
  ],
  exploder: [
    { itemId: 'bindwax', chance: 0.85, min: 1, max: 1 },
  ],
  screecher: [
    { itemId: 'mothdust', chance: 0.75, min: 1, max: 2 },
  ],
  bobbindeer: [
    { itemId: 'thread_sinew', chance: 0.8, min: 1, max: 1 },
    { itemId: 'hide_cloth', chance: 0.4, min: 1, max: 1 },
  ],
  frayedhound: [
    { itemId: 'fray_fang', chance: 0.5, min: 1, max: 1 },
    { itemId: 'raw_skein', chance: 0.3, min: 1, max: 1 },
  ],
  emberspinner: [
    { itemId: 'ember_silk', chance: 0.7, min: 1, max: 2 },
    { itemId: 'cinderthread', chance: 0.3, min: 1, max: 1 },
  ],
  unpicked: [
    { itemId: 'loose_thread', chance: 0.8, min: 1, max: 3 },
    { itemId: 'voidknot', chance: 0.15, min: 1, max: 1 },
  ],
  lastneedle: [
    { itemId: 'everthread', chance: 1.0, min: 3, max: 5 },
    { itemId: 'the_last_stitch', chance: 1.0, min: 1, max: 1 },
  ],
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
