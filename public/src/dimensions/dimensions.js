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

// Portal travel forms a cycle so every dimension is reachable:
// overworld (Warpwold) -> nether (Cinderloom) -> end (Nevermend) -> overworld.
const PORTAL_CYCLE = {
  overworld: 'nether',
  nether: 'end',
  end: 'overworld',
};

/**
 * Given the current dimension (id string or dimension object), return the id
 * of the dimension a portal leads to. Unknown input falls back to 'overworld'.
 */
export function portalTarget(current) {
  const id = typeof current === 'string' ? current : current && current.id;
  return PORTAL_CYCLE[id] || 'overworld';
}
