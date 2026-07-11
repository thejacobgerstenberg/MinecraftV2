// ============================================================================
// blocksAdapter.js
//
// DEFENSIVE SHIM for the builder's (not-yet-existing) public/src/blocks/
// blocks.js module. That module is expected to eventually export a
// `getBlockDef(id)` function returning richer block metadata (name, solid,
// texture info, etc). Until it lands, this file provides a small local
// fallback table so AI/physics code (mobs/ai.js, mobs/MobManager.js) can be
// developed and tested in isolation.
//
// IMPORTANT — once the builder ships public/src/blocks/blocks.js exporting a
// real getBlockDef, callers (MobManager, demos) should import THAT and pass
// it in via `opts.getBlockDef`. This file's getBlockDef is only ever used as
// the fallback when no getBlockDef is injected. Do not hard-wire the rest of
// the mob code to import from here directly — always go through the
// opts.getBlockDef injection point (see MobManager.js).
// ============================================================================

// Small default table of known block ids. Loomfall-flavored ground/solid
// blocks get a few plausible entries; unknown/unlisted ids fall back to
// solid:true (see getBlockDef below) since treating an unrecognized id as
// solid is the safer failure mode for collision (a mob "standing" on a
// mystery block is far less broken than a mob falling through the world).
const BLOCK_TABLE = {
  0: { id: 0, name: 'air', solid: false },
  'air': { id: 'air', name: 'air', solid: false },

  // A handful of plausible solid ground/terrain ids so the StubWorld /
  // demos have something concrete to reference. These are placeholders —
  // the real block ids/names come from the builder's blocks.js once it
  // exists.
  1: { id: 1, name: 'threadstone', solid: true },
  'threadstone': { id: 'threadstone', name: 'threadstone', solid: true },

  2: { id: 2, name: 'warpgrass', solid: true },
  'warpgrass': { id: 'warpgrass', name: 'warpgrass', solid: true },

  3: { id: 3, name: 'cinderrock', solid: true },
  'cinderrock': { id: 'cinderrock', name: 'cinderrock', solid: true },

  4: { id: 4, name: 'looseweave', solid: true },
  'looseweave': { id: 'looseweave', name: 'looseweave', solid: true },

  5: { id: 5, name: 'water', solid: false },
  'water': { id: 'water', name: 'water', solid: false },

  6: { id: 6, name: 'void', solid: false },
  'void': { id: 'void', name: 'void', solid: false },
};

/**
 * getBlockDef(id) -> { id, solid, name }
 *
 * Fallback-only lookup. Unknown ids (anything not in BLOCK_TABLE, including
 * null/undefined) are treated as solid:true — the safer default for
 * collision purposes, so mobs don't fall through unrecognized terrain.
 * Explicitly-air-like ids (0, 'air', undefined block at out-of-range coords
 * handled upstream by callers) are non-solid.
 */
export function getBlockDef(id) {
  if (id === null || id === undefined) {
    // No block data at all (e.g. out-of-range sample) — callers generally
    // want this treated as air/non-solid rather than solid, so they should
    // guard this case themselves before calling getBlockDef. If they don't,
    // we still return a usable, clearly-labeled def.
    return { id: id, solid: false, name: 'unknown-empty' };
  }

  const found = BLOCK_TABLE[id];
  if (found) {
    return found;
  }

  // Unknown/unlisted id: assume solid (see doc comment above).
  return { id: id, solid: true, name: 'unknown' };
}

export default { getBlockDef };
