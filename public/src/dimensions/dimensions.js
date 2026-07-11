// Voxelheim dimension registry (dimensions phase).
//
// PURE module: no three.js import — must run under plain node.
//
// Original dimension names (no third-party trademarks):
//   overworld -> "Warpwold"    (the surface world — settled, not safe)
//   nether    -> "Cinderloom"  (a sealed magma cavern-world)
//   end       -> "Nevermend"   (pale islands adrift in the void)

import { BLOCK_ID } from '../blocks/blocks.js';

export const DIMENSIONS = {
  overworld: {
    id: 'overworld',
    name: 'Warpwold',
    fog: 0xaad4ff,
    skyType: 'day',
    portalBlock: BLOCK_ID.portal,
  },
  nether: {
    id: 'nether',
    name: 'Cinderloom',
    fog: 0x3d0f08,
    skyType: 'nether',
    portalBlock: BLOCK_ID.portal,
  },
  end: {
    id: 'end',
    name: 'Nevermend',
    fog: 0x140d21,
    skyType: 'end',
    portalBlock: BLOCK_ID.portal,
  },
};

// Portal travel (portals phase): the FRAME MATERIAL picks the destination
// when leaving the overworld — an OBSIDIAN (id 25) frame leads to Cinderloom
// ('nether'), an END_STONE (id 26) frame to Nevermend ('end') — and from any
// non-overworld dimension every portal returns to the overworld. Every
// dimension therefore stays reachable: out via a material, home via any
// portal. (See public/src/gameplay/portals.js for frame rules.)
const DEFAULT_TARGET = {
  overworld: 'nether', // default when the frame material is unknown
  nether: 'overworld',
  end: 'overworld',
};

/**
 * Given the current dimension (id string or dimension object) and optionally
 * the portal frame's block id, return the id of the dimension the portal
 * leads to. From the overworld the frame material decides (obsidian ->
 * 'nether', end_stone -> 'end'); from anywhere else portals lead back to
 * 'overworld'. Unknown input falls back to 'overworld'.
 */
export function portalTarget(current, frameBlockId = null) {
  const id = typeof current === 'string' ? current : current && current.id;
  if (id === 'overworld' && frameBlockId === BLOCK_ID.end_stone) return 'end';
  return DEFAULT_TARGET[id] || 'overworld';
}
