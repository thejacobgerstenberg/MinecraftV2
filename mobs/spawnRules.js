// ============================================================================
// mobs/spawnRules.js
//
// Day/night + per-dimension spawn tables for the five Loomfall archetypes,
// plus a pickSpawn(dimension, isDay, rng) helper MobManager uses to decide
// what to spawn next.
//
// Dimensions:
//   - 'warpwold'   — overworld/surface. Has day/night. Day is peaceful
//                    (grazer, trader); night brings hostiles (groaner,
//                    occasional screecher).
//   - 'cinderloom' — hellish/molten. Always hostile, no day/night split.
//   - 'nevermend'  — the void/unravelled. Always hostile, no day/night
//                    split.
// ============================================================================

// Archetype -> species name, for reference/logging (matches each creature
// module's `meta.species`).
export const SPECIES_BY_ARCHETYPE = {
  grazer: 'Skeinling',
  groaner: 'Understruck',
  exploder: 'Waxling',
  screecher: 'Slagmoth',
  trader: 'Wickerkin',
};

// Per-dimension, per-period spawn tables. Each entry is
// { archetype, weight } — weight is relative (not required to sum to any
// particular total); higher weight = more likely to be picked.
export const SPAWN_TABLES = {
  warpwold: {
    day: [
      { archetype: 'grazer', weight: 6 },
      { archetype: 'trader', weight: 2 },
    ],
    night: [
      { archetype: 'groaner', weight: 6 },
      { archetype: 'screecher', weight: 1 }, // occasional stray from Cinderloom
    ],
  },
  cinderloom: {
    // No day/night split — the "day"/"night" tables are identical so
    // pickSpawn works uniformly regardless of isDay.
    day: [
      { archetype: 'exploder', weight: 5 },
      { archetype: 'screecher', weight: 4 },
      { archetype: 'groaner', weight: 2 },
    ],
    night: [
      { archetype: 'exploder', weight: 5 },
      { archetype: 'screecher', weight: 4 },
      { archetype: 'groaner', weight: 2 },
    ],
  },
  nevermend: {
    day: [
      { archetype: 'groaner', weight: 4 },
      { archetype: 'screecher', weight: 4 },
      { archetype: 'exploder', weight: 3 },
    ],
    night: [
      { archetype: 'groaner', weight: 4 },
      { archetype: 'screecher', weight: 4 },
      { archetype: 'exploder', weight: 3 },
    ],
  },
};

// Dimensions that ignore isDay entirely (always "hostile hours").
export const ALWAYS_HOSTILE_DIMENSIONS = new Set(['cinderloom', 'nevermend']);

// Max simultaneously-alive mobs, per dimension. MobManager's own opts.maxMobs
// (if provided) takes precedence; this is the fallback default.
export const MAX_ALIVE_BY_DIMENSION = {
  warpwold: 12,
  cinderloom: 10,
  nevermend: 8,
};

export const DEFAULT_MAX_ALIVE = 10;

/**
 * getTable(dimension, isDay) -> array of { archetype, weight }
 * Falls back to warpwold's day table for unknown dimensions so callers
 * always get something sensible.
 */
export function getTable(dimension, isDay) {
  const dim = SPAWN_TABLES[dimension] || SPAWN_TABLES.warpwold;
  const period = (ALWAYS_HOSTILE_DIMENSIONS.has(dimension) || isDay) ? 'day' : 'night';
  return dim[period] || dim.day || [];
}

/**
 * pickSpawn(dimension, isDay, rng) -> archetype string | null
 * Weighted-random pick from the appropriate spawn table. `rng` should be a
 * zero-argument function returning a float in [0, 1); defaults to
 * Math.random. Returns null if the table is empty.
 */
export function pickSpawn(dimension, isDay, rng) {
  const random = typeof rng === 'function' ? rng : Math.random;
  const table = getTable(dimension, isDay);
  if (!table.length) return null;

  const total = table.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (total <= 0) return null;

  let roll = random() * total;
  for (const entry of table) {
    roll -= Math.max(0, entry.weight);
    if (roll <= 0) return entry.archetype;
  }
  // Floating point fallback: last entry.
  return table[table.length - 1].archetype;
}

/**
 * maxAliveFor(dimension) -> number
 */
export function maxAliveFor(dimension) {
  return MAX_ALIVE_BY_DIMENSION[dimension] ?? DEFAULT_MAX_ALIVE;
}

export default {
  SPECIES_BY_ARCHETYPE,
  SPAWN_TABLES,
  ALWAYS_HOSTILE_DIMENSIONS,
  MAX_ALIVE_BY_DIMENSION,
  DEFAULT_MAX_ALIVE,
  getTable,
  pickSpawn,
  maxAliveFor,
};
