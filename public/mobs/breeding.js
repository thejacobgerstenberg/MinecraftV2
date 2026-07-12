// ============================================================================
// mobs/breeding.js
//
// STUB — lightweight breeding / spawn-egg data module for Loomfall passive
// mobs. This does NOT implement a breeding loop (no feeding state machine,
// no love-mode cooldowns, no baby growth timers actually ticking down). It
// only exports the *data and small helpers* that MobManager (or whoever
// wires up creative-mode spawn eggs and breeding) should lean on:
//
//   - MobManager.spawnEgg(archetype, pos) is expected to look up
//     SPAWN_EGGS[archetype] (via spawnEggId()) to know what item this
//     creature corresponds to in a creative inventory / egg-throw flow.
//   - MobManager.breed(mobA, mobB) is expected to call canBreed() +
//     breedItemFor() to decide whether two mobs of the same archetype,
//     both recently fed the right item, should produce a baby described
//     by describeBaby().
//
// Full breeding (tracking "in love" state, consuming the item from
// inventory, cooldowns, baby -> adult growth over growSeconds, etc.) is
// left for the builder / a future phase. Everything here is intentionally
// tunable — treat BREED_ITEM's item ids as canon-ish placeholders, not
// gospel.
//
// Lore note (Loomfall, no gore): breeding text/UI should stay in-world —
// e.g. a bred baby is "rewoven", never "born" in a clinical sense, and a
// creature that fails to breed/thrive is "unpicked", not "killed".
// ============================================================================

// ----------------------------------------------------------------------------
// BREEDABLE — the passive archetypes that support breeding at all.
// Only true passives get bred; the trader (Wickerkin) is an NPC-ish vendor,
// not livestock, so it is deliberately excluded here.
// ----------------------------------------------------------------------------
export const BREEDABLE = new Set(['grazer', 'bobbindeer', 'spoolmare']);

// ----------------------------------------------------------------------------
// BREED_ITEM — archetype -> item id that triggers breeding ("love mode")
// when fed to two adults of the same archetype. Tunable; these are
// canon-ish picks based on content/items.json (raw_skein, hedgerow_berries).
// ----------------------------------------------------------------------------
export const BREED_ITEM = {
  grazer: 'raw_skein',
  bobbindeer: 'hedgerow_berries',
  spoolmare: 'hedgerow_berries',
};

/**
 * canBreed(archetype) -> boolean
 * True if this archetype is a passive that supports breeding.
 */
export function canBreed(archetype) {
  return BREEDABLE.has(archetype);
}

/**
 * breedItemFor(archetype) -> string | null
 * The item id that triggers breeding for this archetype, or null if the
 * archetype isn't breedable (or has no configured item).
 */
export function breedItemFor(archetype) {
  if (!canBreed(archetype)) return null;
  return BREED_ITEM[archetype] || null;
}

// ----------------------------------------------------------------------------
// SPAWN_EGGS — archetype -> spawn-egg item id, for every known Loomfall
// creature archetype (not just breedables) so the builder can register a
// full set of creative-mode spawn eggs in one pass. Stub: ids follow the
// 'spawn_egg_<archetype>' convention and are not yet wired into an actual
// items/creative registry.
// ----------------------------------------------------------------------------
const ARCHETYPES = [
  'grazer',        // Skeinling
  'bobbindeer',    // Bobbin-deer
  'spoolmare',     // passive
  'trader',        // Wickerkin
  'groaner',       // Understruck
  'exploder',       // Waxling
  'screecher',      // Slagmoth
  'frayedhound',    // Frayed Hound
  'emberspinner',   // Emberspinner
  'unpicked',       // The Unpicked
  'needlejack',     // Needlejack
  'scaldwarden',    // Scaldwarden
  'raveler',        // Raveler
  'silencemoth',    // Silencemoth
  'selvagewarden',  // Selvage Warden
  'lastneedle',     // The Last Needle (boss)
  'molthkin',       // Cinderloom boss, canonical everthread source
];

export const SPAWN_EGGS = ARCHETYPES.reduce((map, archetype) => {
  map[archetype] = `spawn_egg_${archetype}`;
  return map;
}, {});

/**
 * spawnEggId(archetype) -> string | null
 * Looks up the spawn-egg item id for an archetype, or null if unknown.
 */
export function spawnEggId(archetype) {
  return SPAWN_EGGS[archetype] || null;
}

/**
 * describeBaby(archetype) -> descriptor object
 * A stub descriptor MobManager can use to spawn a scaled-down baby version
 * of a bred creature. MobManager may or may not consume growSeconds yet —
 * actual aging-into-adult ticking is left for the builder.
 */
export function describeBaby(archetype) {
  return {
    archetype,
    scale: 0.6,
    isBaby: true,
    growSeconds: 1200, // ~20 real-time minutes, Minecraft-style baby->adult
  };
}

export default {
  BREEDABLE,
  BREED_ITEM,
  SPAWN_EGGS,
  canBreed,
  breedItemFor,
  spawnEggId,
  describeBaby,
};
