// ============================================================================
// StubWorld.js
//
// A minimal demo/test world implementing the same getBlock(x,y,z) surface
// the real game world is expected to expose. This is ONLY for local demos
// and unit tests of mobs/ai.js + mobs/MobManager.js — real integration will
// pass in the game's actual world object (whatever it is) as long as it
// exposes getBlock(x,y,z).
//
// Terrain:
//   - y < 1  -> solid ground, block id 'threadstone'
//   - y >= 1 -> 'air'
//   - A few scattered single-block pillars poking up out of the ground at
//     y === 1, so collision/step-up behavior has something to bump into
//     during manual testing.
// ============================================================================

// A short, fixed list of pillar coordinates (x, z) that get one extra solid
// block at y === 1 (i.e. a 1-block-tall bump standing on the ground).
const PILLARS = [
  { x: 3, z: 2 },
  { x: -4, z: 5 },
  { x: 6, z: -3 },
  { x: -2, z: -6 },
];

export class StubWorld {
  constructor() {
    this.pillars = new Set(PILLARS.map((p) => `${p.x},${p.z}`));
  }

  /**
   * getBlock(x, y, z) -> block id (string)
   * Coordinates are treated as block-grid coordinates; fractional inputs
   * are floored, matching typical voxel-world semantics.
   */
  getBlock(x, y, z) {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);

    if (by < 0) {
      // Deep bedrock-like solid floor well below the surface, just in case
      // something probes far below y=0.
      return 'threadstone';
    }
    if (by < 1) {
      return 'threadstone';
    }
    if (by === 1 && this.pillars.has(`${bx},${bz}`)) {
      return 'threadstone';
    }
    return 'air';
  }
}

export default StubWorld;
