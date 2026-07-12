// ============================================================================
// mobs/spawnRules.js
//
// Day/night + per-dimension spawn tables for the Loomfall archetypes, plus a
// pickSpawn(dimension, isDay, rng, biome) helper MobManager uses to decide
// what to spawn next.
//
// Dimensions (canonical/internal keys used throughout this file):
//   - 'warpwold'   — overworld/surface. Has day/night. Day is peaceful
//                    (grazer, bobbindeer, trader); night brings hostiles
//                    (groaner, frayedhound, occasional screecher).
//   - 'cinderloom' — hellish/molten. Always hostile, no day/night split.
//   - 'nevermend'  — the void/unravelled. Always hostile, no day/night
//                    split.
//
// Dimension reconciliation: the game engine (branch feat/voxel-sandbox-game)
// identifies dimensions by engine id ('overworld' | 'nether' | 'end'), which
// are display-named Warpwold / Cinderloom / Nevermend respectively. Every
// table lookup in this file (getTable / pickSpawn / maxAliveFor) normalizes
// its `dimension` argument via normalizeDimension() first, so callers may
// pass EITHER the engine id ('overworld') OR the display-name key
// ('warpwold') interchangeably.
// ============================================================================

// Archetype -> species name, for reference/logging (matches each creature
// module's `meta.species`). NOTE: "archetype" here is a spawn-table slot
// key (one per distinct spawnable species), not necessarily the same string
// as a creature module's internal `meta.archetype` AI-behaviour tag (e.g.
// bobbindeer/frayedhound/emberspinner/unpicked all reuse an existing AI
// behaviour under the hood, but each still gets its own spawn-table slot so
// it can be weighted/tuned independently).
export const SPECIES_BY_ARCHETYPE = {
  grazer: 'Skeinling',
  groaner: 'Understruck',
  exploder: 'Waxling',
  screecher: 'Slagmoth',
  trader: 'Wickerkin',
  bobbindeer: 'Bobbin-deer',
  frayedhound: 'Frayed Hound',
  emberspinner: 'Emberspinner',
  unpicked: 'The Unpicked',
  lastneedle: 'The Last Needle',
  needlejack: 'Needlejack',
  scaldwarden: 'Scaldwarden',
  raveler: 'Raveler',
  spoolmare: 'Spoolmares',
  silencemoth: 'Silence-Moths',
  selvagewarden: 'Selvage Wardens',
  molthkin: 'Molthkin, the First Bobbin',
};

// Archetype -> canonical snake_case entity id. This is the stable id used
// for persistence/networking/asset lookups (distinct from the human-facing
// SPECIES_BY_ARCHETYPE display name above, and distinct from the archetype
// spawn-table slot key itself). Every key in SPECIES_BY_ARCHETYPE has a
// corresponding entry here.
export const CANONICAL_ID = {
  grazer: 'skeinling',
  bobbindeer: 'bobbin_deer',
  trader: 'wickerkin',
  groaner: 'understruck',
  frayedhound: 'frayed_hound',
  emberspinner: 'emberspinner',
  exploder: 'waxling',
  screecher: 'slagmoth',
  unpicked: 'unpicked',
  lastneedle: 'last_needle',
  needlejack: 'needlejack',
  scaldwarden: 'scaldwarden',
  raveler: 'raveler',
  spoolmare: 'spoolmare',
  silencemoth: 'silence_moth',
  selvagewarden: 'selvage_warden',
  molthkin: 'molthkin',
};

/**
 * canonicalIdFor(archetype) -> snake_case entity id string | null
 * Looks up CANONICAL_ID[archetype]; returns null for unknown archetypes
 * rather than throwing.
 */
export function canonicalIdFor(archetype) {
  return CANONICAL_ID[archetype] ?? null;
}

// Per-dimension, per-period spawn tables. Each entry is
// { archetype, weight } — weight is relative (not required to sum to any
// particular total); higher weight = more likely to be picked.
//
// Boss/structure-bound archetypes (lastneedle, selvagewarden, molthkin) are
// intentionally NEVER listed here — bosses and the structure-bound
// mini-boss are hand-placed/explicitly triggered, not picked by the random
// spawn cadence.
export const SPAWN_TABLES = {
  warpwold: {
    day: [
      { archetype: 'grazer', weight: 6 },
      { archetype: 'bobbindeer', weight: 4 },
      { archetype: 'trader', weight: 2 },
      { archetype: 'spoolmare', weight: 2 }, // uncommon
    ],
    night: [
      { archetype: 'groaner', weight: 4 },
      { archetype: 'frayedhound', weight: 4 },
      { archetype: 'needlejack', weight: 3 },
      { archetype: 'screecher', weight: 1 }, // occasional stray from Cinderloom
      { archetype: 'silencemoth', weight: 3 }, // ambient
    ],
  },
  cinderloom: {
    // No day/night split — the "day"/"night" tables are identical so
    // pickSpawn works uniformly regardless of isDay.
    day: [
      { archetype: 'exploder', weight: 5 },
      { archetype: 'emberspinner', weight: 5 },
      { archetype: 'screecher', weight: 4 },
      { archetype: 'scaldwarden', weight: 2 },
      { archetype: 'groaner', weight: 1 },
    ],
    night: [
      { archetype: 'exploder', weight: 5 },
      { archetype: 'emberspinner', weight: 5 },
      { archetype: 'screecher', weight: 4 },
      { archetype: 'scaldwarden', weight: 2 },
      { archetype: 'groaner', weight: 1 },
    ],
  },
  nevermend: {
    day: [
      { archetype: 'unpicked', weight: 5 },
      { archetype: 'raveler', weight: 4 },
      { archetype: 'screecher', weight: 2 },
      { archetype: 'groaner', weight: 2 },
    ],
    night: [
      { archetype: 'unpicked', weight: 5 },
      { archetype: 'raveler', weight: 4 },
      { archetype: 'screecher', weight: 2 },
      { archetype: 'groaner', weight: 2 },
    ],
  },
};

// Optional per-biome weight tweaks, layered on top of SPAWN_TABLES. Keyed
// dimension -> biome -> archetype -> additive weight delta. Biome names
// match the builder's biome set (plains, forest, desert, mountains, snow,
// ocean). This layer is entirely OPTIONAL: pickSpawn only consults it when
// a `biome` argument is passed AND both the dimension and biome are known
// here; otherwise it silently falls back to the base SPAWN_TABLES entry, so
// old call sites that don't pass a biome keep working unchanged.
//
// Deltas only affect archetypes that already appear in the base table for
// that dimension/period — they never inject a new archetype into a table.
// Resulting weights are clamped to a minimum of 0 (a big enough negative
// delta suppresses an archetype entirely for that biome without risking a
// negative weight breaking the weighted-pick math).
export const BIOME_MODIFIERS = {
  warpwold: {
    plains: {
      grazer: 1,
      trader: 1,
    },
    forest: {
      bobbindeer: 3,
      frayedhound: 2,
      grazer: 1,
    },
    desert: {
      grazer: -2,
      bobbindeer: -2,
      trader: -1,
      groaner: 1,
    },
    mountains: {
      screecher: 2,
      groaner: 1,
      grazer: -1,
    },
    snow: {
      screecher: 2,
      frayedhound: 1,
      grazer: -1,
      bobbindeer: -1,
    },
    ocean: {
      // Suppress grounded mobs near/on open water; screecher flies so it's
      // barely affected.
      grazer: -5,
      bobbindeer: -5,
      trader: -4,
      groaner: -5,
      frayedhound: -5,
      screecher: 1,
    },
  },
  // Cinderloom/Nevermend don't have the overworld-style biome set (they're
  // single-theme dimensions), so no entries are defined here. Passing any
  // biome name for these dimensions is safe -- pickSpawn just falls back to
  // the unmodified base table (see applyBiomeModifiers below).
  cinderloom: {},
  nevermend: {},
};

// Dimensions that ignore isDay entirely (always "hostile hours"). Keyed by
// canonical (post-normalizeDimension) dimension name.
export const ALWAYS_HOSTILE_DIMENSIONS = new Set(['cinderloom', 'nevermend']);

// Max simultaneously-alive mobs, per dimension. MobManager's own opts.maxMobs
// (if provided) takes precedence; this is the fallback default.
export const MAX_ALIVE_BY_DIMENSION = {
  warpwold: 14,
  cinderloom: 12,
  nevermend: 10,
};

export const DEFAULT_MAX_ALIVE = 10;

// ----------------------------------------------------------------------
// Dimension reconciliation
// ----------------------------------------------------------------------

// Engine dimension ids ('overworld'|'nether'|'end') -> our canonical
// display-name keys, plus identity entries for the display names
// themselves so normalizeDimension() accepts either form uniformly.
export const DIMENSION_ALIASES = {
  overworld: 'warpwold',
  nether: 'cinderloom',
  end: 'nevermend',
  warpwold: 'warpwold',
  cinderloom: 'cinderloom',
  nevermend: 'nevermend',
};

/**
 * normalizeDimension(id) -> 'warpwold' | 'cinderloom' | 'nevermend'
 * Accepts either an engine dimension id ('overworld'/'nether'/'end') or one
 * of our display-name keys ('warpwold'/'cinderloom'/'nevermend'), case
 * -insensitively. Unknown/missing/non-string input defaults to 'warpwold'
 * so callers always get a valid table.
 */
export function normalizeDimension(id) {
  if (typeof id !== 'string' || !id) return 'warpwold';
  const key = id.toLowerCase();
  return DIMENSION_ALIASES[key] || 'warpwold';
}

/**
 * applyBiomeModifiers(table, dimension, biome) -> array of { archetype, weight }
 * Internal helper. `dimension` must already be normalized. Returns `table`
 * unchanged (same reference) if there's nothing to apply; otherwise returns
 * a new array with adjusted weights, never mutating the input.
 */
function applyBiomeModifiers(table, dimension, biome) {
  if (!biome || !Array.isArray(table) || !table.length) return table;
  const dimMods = BIOME_MODIFIERS[dimension];
  if (!dimMods) return table;
  const mods = dimMods[biome];
  if (!mods) return table;

  return table.map((entry) => {
    const delta = mods[entry.archetype];
    if (!Number.isFinite(delta) || delta === 0) return entry;
    return { archetype: entry.archetype, weight: Math.max(0, entry.weight + delta) };
  });
}

/**
 * getTable(dimension, isDay) -> array of { archetype, weight }
 * `dimension` may be an engine id or display-name key (see
 * normalizeDimension). Falls back to warpwold's day table for unknown
 * dimensions/periods so callers always get something sensible.
 */
export function getTable(dimension, isDay) {
  const dim = normalizeDimension(dimension);
  const table = SPAWN_TABLES[dim] || SPAWN_TABLES.warpwold;
  const period = (ALWAYS_HOSTILE_DIMENSIONS.has(dim) || isDay) ? 'day' : 'night';
  return table[period] || table.day || [];
}

/**
 * pickSpawn(dimension, isDay, rng, biome) -> archetype string | null
 * Weighted-random pick from the appropriate spawn table. `rng` should be a
 * zero-argument function returning a float in [0, 1); defaults to
 * Math.random. `biome` is OPTIONAL: if provided and the dimension/biome
 * pair is known in BIOME_MODIFIERS, per-archetype weight tweaks are applied
 * on top of the base table; otherwise the base table is used as-is. Returns
 * null if the resulting table is empty or all weights are non-positive.
 */
export function pickSpawn(dimension, isDay, rng, biome) {
  const random = typeof rng === 'function' ? rng : Math.random;
  const dim = normalizeDimension(dimension);
  const baseTable = getTable(dim, isDay);
  const table = applyBiomeModifiers(baseTable, dim, biome);
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
 * `dimension` may be an engine id or display-name key.
 */
export function maxAliveFor(dimension) {
  const dim = normalizeDimension(dimension);
  return MAX_ALIVE_BY_DIMENSION[dim] ?? DEFAULT_MAX_ALIVE;
}

// ----------------------------------------------------------------------
// Despawn rules
// ----------------------------------------------------------------------

// Default despawn tuning. `radius` is a horizontal (XZ-plane) distance in
// blocks from the player; mobs beyond it (and old enough) are eligible for
// despawn. `exemptArchetypes` lists spawn-table archetype keys that should
// never be despawned by distance/age (traders are persistent NPCs; the boss
// is hand-managed by the encounter, not the ambient despawn sweep; scaldwarden
// is a stationary guardian tied to its Cinderloom post, so it's exempted too
// -- letting the ambient despawn sweep clear it would let players wander far
// away and have the guardian vanish instead of remaining on watch).
// `bossExempt` is a belt-and-suspenders flag: even if a boss mob's
// archetype key isn't literally 'lastneedle' (e.g. a future second boss, or
// a mob object that flags itself with `isBoss`/`archetype === 'boss'`),
// shouldDespawn() still exempts it.
// Phase 3 note: 'silencemoth' uses normal (non-exempt) despawn behavior,
// same as any other ambient wild spawn. 'spoolmare' is also left as a
// normal wild despawn here -- a tamed spoolmare should be exempted, but
// that's a per-instance ("is this specific mob tamed?") condition, not an
// archetype-wide exemption, so it isn't added to exemptArchetypes; callers
// managing tamed mobs should pass an `opts` override (or otherwise skip the
// despawn check) for tamed instances.
export const DESPAWN_CONFIG = {
  radius: 48,
  minAgeSeconds: 12,
  exemptArchetypes: ['trader', 'lastneedle', 'scaldwarden'],
  bossExempt: true,
};

/**
 * shouldDespawn(mob, playerPos, opts) -> boolean
 *
 * Defensive horizontal-distance + minimum-age despawn check.
 *   - `mob` is expected to look like { archetype, position:{x,y,z},
 *     ageSeconds? }. Anything missing/malformed is treated conservatively
 *     (i.e. "don't despawn") rather than thrown.
 *   - `playerPos` is expected to look like {x,y,z}; if missing/invalid,
 *     distance can't be computed and this returns false.
 *   - `opts` optionally overrides any DESPAWN_CONFIG field for this call
 *     (radius/minAgeSeconds/exemptArchetypes/bossExempt).
 *
 * Age is read from `mob.ageSeconds` if present; if it's missing or not a
 * finite number, the mob is treated as "not old enough yet" (never
 * despawned) rather than guessing -- callers that want age-based despawn
 * must stamp ageSeconds onto their mob objects themselves.
 */
export function shouldDespawn(mob, playerPos, opts) {
  if (!mob || typeof mob !== 'object') return false;

  const config = {
    ...DESPAWN_CONFIG,
    ...(opts && typeof opts === 'object' ? opts : {}),
  };

  const archetype = mob.archetype;
  const exemptList = Array.isArray(config.exemptArchetypes)
    ? config.exemptArchetypes
    : DESPAWN_CONFIG.exemptArchetypes;
  if (archetype && exemptList.includes(archetype)) return false;
  if (config.bossExempt && (archetype === 'boss' || mob.isBoss === true)) return false;

  if (!Number.isFinite(mob.ageSeconds) || mob.ageSeconds < config.minAgeSeconds) {
    return false;
  }

  const pos = mob.position;
  if (!pos || typeof pos !== 'object') return false;
  if (!playerPos || typeof playerPos !== 'object') return false;

  const dx = (Number.isFinite(pos.x) ? pos.x : 0) - (Number.isFinite(playerPos.x) ? playerPos.x : 0);
  const dz = (Number.isFinite(pos.z) ? pos.z : 0) - (Number.isFinite(playerPos.z) ? playerPos.z : 0);
  const dist = Math.hypot(dx, dz);
  if (!Number.isFinite(dist)) return false;

  const radius = Number.isFinite(config.radius) ? config.radius : DESPAWN_CONFIG.radius;
  return dist >= radius;
}

export default {
  SPECIES_BY_ARCHETYPE,
  CANONICAL_ID,
  canonicalIdFor,
  SPAWN_TABLES,
  BIOME_MODIFIERS,
  ALWAYS_HOSTILE_DIMENSIONS,
  MAX_ALIVE_BY_DIMENSION,
  DEFAULT_MAX_ALIVE,
  DIMENSION_ALIASES,
  DESPAWN_CONFIG,
  normalizeDimension,
  getTable,
  pickSpawn,
  maxAliveFor,
  shouldDespawn,
};
