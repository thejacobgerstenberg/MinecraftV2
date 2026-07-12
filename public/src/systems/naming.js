// Loomfall — canonical naming layer (content/naming.json).
//
// Maps the engine's internal block/biome identifiers onto the canonical
// Loomfall display names from public/content/naming.json. The engine's
// internal ids (blocks.js names, TerrainGenerator biome names) are frozen
// contract values, so this is a pure DISPLAY layer: nothing in worldgen,
// physics, persistence, or networking changes — only what the player reads
// (hotbar/inventory tooltips, the F3 target/biome rows).
//
// The engine's block registry predates the canon registry, so ids do not
// literally match; the table below is the curated 1:1 mapping between the
// engine block and its canonical naming.json counterpart (used both for
// display names and for achievement `collect_count`/`place_block` triggers,
// which are keyed by canonical ids). Engine blocks with no canonical
// counterpart (cobblestone, sand, gravel, ...) keep their prettified engine
// name. `lava` has no naming.json block id but canon mandates the fiction
// never says "lava" (see deathmessages.json's $comment), so it carries a
// fixed display override.
//
// loadNaming() reads naming.json through the shared ContentPack (one load
// per page); every getter degrades gracefully (prettified engine names)
// until/unless it resolves, so this module stays safe to import under
// plain node.

import { pack } from './contentpack.js';

/** engine block name -> canonical naming.json block id. */
export const CANON_BLOCK_ID = Object.freeze({
  grass: 'warpsod',
  dirt: 'loamweft',
  stone: 'threadstone',
  log: 'thrumwood_bole',
  planks: 'knotwood_plank',
  glass: 'loomglass',
  iron_ore: 'needle_iron',
  gold_ore: 'giltspool',
  diamond_ore: 'dawnthread',
  netherrack: 'cinderthread',
  soul_sand: 'tallowstone',
  glowstone: 'mothdust_brick',
  obsidian: 'cinderglass',
  end_stone: 'hemstone',
  purpur: 'voidknot',
  snow_block: 'frostlace',
  torch: 'knotlight', // the kept-flame light; wires place_block/place_count:knotlight
});

// Display-only overrides for engine blocks with no naming.json block id.
// 'lava' is canon-mandated ("the liquid is always the molten skein — no
// in-game string may say 'lava'"); 'portal' uses the canon gate term.
const DISPLAY_OVERRIDES = Object.freeze({
  lava: 'Molten Skein',
  portal: 'Loom-Gate',
});

/** engine biome display name (TerrainGenerator.BIOME_NAMES) -> canonical
 *  naming.json biome id. Curated analogs; display layer only (the weather
 *  machine and QA hooks keep reading the engine names). */
export const CANON_BIOME_ID = Object.freeze({
  Plains: 'sennmeadows',
  Forest: 'thrumwood',
  Desert: 'bleachlands',
  Mountains: 'warpspine_reach',
  Snowcap: 'warpspine_reach',
  Snowfield: 'the_frostlace',
  Beach: 'dyewater_coast',
  Ocean: 'dyewater_coast',
});

let namingData = null; // parsed naming.json (or null until loaded)
let blockDisplayById = null; // canon block id -> displayName
let biomeDisplayById = null; // canon biome id -> display name
let loadPromise = null;

/** "snow_grass" -> "Snow Grass" (fallback prettifier). */
export function prettyName(name) {
  return String(name)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Load + index naming.json via the shared ContentPack. Safe to call
 * repeatedly; degrades gracefully (resolves false, display falls back)
 * when the content is unreachable.
 */
export function loadNaming() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      await pack.load();
      const data = pack.naming();
      if (!data) throw new Error('naming.json not in the content pack');
      blockDisplayById = {};
      for (const b of data.blocks || []) {
        if (b && b.id && b.displayName) blockDisplayById[b.id] = b.displayName;
      }
      biomeDisplayById = {};
      for (const b of data.biomes || []) {
        if (b && b.id && b.name) biomeDisplayById[b.id] = b.name;
      }
      namingData = data;
      return true;
    } catch (err) {
      console.warn('[loomfall] naming.json unavailable — engine names shown:', err && err.message);
      return false;
    }
  })();
  return loadPromise;
}

/** True once naming.json has been fetched and parsed. */
export function namingLoaded() {
  return !!namingData;
}

/** Canonical naming.json block id for an engine block name (or null). */
export function canonBlockIdFor(engineName) {
  return CANON_BLOCK_ID[engineName] || null;
}

/**
 * Player-facing display name for an engine block name:
 * canon displayName when mapped + loaded, else override, else prettified.
 */
export function blockDisplayName(engineName) {
  const canonId = CANON_BLOCK_ID[engineName];
  if (canonId && blockDisplayById && blockDisplayById[canonId]) {
    return blockDisplayById[canonId];
  }
  if (DISPLAY_OVERRIDES[engineName]) return DISPLAY_OVERRIDES[engineName];
  return prettyName(engineName);
}

/**
 * Player-facing display name for an engine biome name ('Forest' ->
 * 'Thrumwood'). Falls back to the engine name (already display-cased).
 */
export function biomeDisplayName(engineBiome) {
  const canonId = CANON_BIOME_ID[engineBiome];
  if (canonId && biomeDisplayById && biomeDisplayById[canonId]) {
    return biomeDisplayById[canonId];
  }
  return engineBiome == null ? null : String(engineBiome);
}
