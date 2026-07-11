// Voxelheim chunk — one 16x16x128 column of block ids.
//
// PURE module: no three.js import, safe to run under plain node.
// Storage is a Uint8Array indexed x + z*16 + y*16*16 (see constants.blockIndex).

import { CHUNK_SX, CHUNK_SZ, CHUNK_SY, blockIndex } from '../constants.js';

/** Canonical Map key for a chunk coordinate pair, e.g. chunkKey(-1, 3) === "-1,3". */
export function chunkKey(cx, cz) {
  return `${cx},${cz}`;
}

export class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.key = chunkKey(cx, cz);
    this.data = new Uint8Array(CHUNK_SX * CHUNK_SZ * CHUNK_SY);
  }

  /** Get block id at LOCAL coords (x,z in 0..15, y in 0..127). No bounds checks. */
  get(x, y, z) {
    return this.data[blockIndex(x, y, z)];
  }

  /** Set block id at LOCAL coords (x,z in 0..15, y in 0..127). No bounds checks. */
  set(x, y, z, id) {
    this.data[blockIndex(x, y, z)] = id;
  }
}
