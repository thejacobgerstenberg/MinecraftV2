// Voxelheim world store — a sparse Map of chunks plus world-coordinate access.
//
// PURE module: no three.js import, safe to run under plain node.
//
// Out-of-range y convention:
//   y <  0        -> bedrock (id 17), so bottom faces of the lowest layer cull.
//   y >= CHUNK_SY -> air (id 0).
// Blocks in chunks that have not been generated yet read as air (id 0).
//
// setBlock marks the containing chunk dirty (key added to `dirtyChunks`, a Set
// of chunkKey strings) and ALSO the neighboring chunk key(s) when x or z sits
// on a chunk border, so adjacent meshes re-cull their shared faces.

import { CHUNK_SX, CHUNK_SZ, CHUNK_SY } from '../constants.js';
import { Chunk, chunkKey } from './Chunk.js';

const BEDROCK_ID = 17;
const AIR_ID = 0;

export class World {
  /**
   * @param {{generateChunk?:(cx:number,cz:number)=>Uint8Array}|null} generator
   *   Anything with generateChunk(cx,cz) -> Uint8Array(16*16*128). May be null
   *   (chunks then start empty), which tests use for an all-air world.
   */
  constructor(generator = null) {
    this.generator = generator;
    /** @type {Map<string, Chunk>} keyed by chunkKey(cx,cz) */
    this.chunks = new Map();
    /** @type {Set<string>} chunk keys whose meshes need rebuilding */
    this.dirtyChunks = new Set();
  }

  /** True if the chunk at (cx,cz) has been generated/created. */
  hasChunk(cx, cz) {
    return this.chunks.has(chunkKey(cx, cz));
  }

  /** The chunk at (cx,cz), or null if not present. Does NOT generate. */
  getChunk(cx, cz) {
    return this.chunks.get(chunkKey(cx, cz)) || null;
  }

  /**
   * Return the chunk at (cx,cz), generating it via generator.generateChunk
   * if missing.
   */
  ensureChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = new Chunk(cx, cz);
      if (this.generator && typeof this.generator.generateChunk === 'function') {
        const data = this.generator.generateChunk(cx, cz);
        if (data) chunk.data.set(data);
      }
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  /** Block id at WORLD coords. See out-of-range conventions above. */
  getBlock(x, y, z) {
    if (y < 0) return BEDROCK_ID;
    if (y >= CHUNK_SY) return AIR_ID;
    const cx = Math.floor(x / CHUNK_SX);
    const cz = Math.floor(z / CHUNK_SZ);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk) return AIR_ID;
    return chunk.get(x - cx * CHUNK_SX, y, z - cz * CHUNK_SZ);
  }

  /**
   * Set block id at WORLD coords (no-op outside 0 <= y < CHUNK_SY).
   * Generates the containing chunk if needed, marks it dirty, and marks
   * border-adjacent neighbor chunks dirty too.
   */
  setBlock(x, y, z, id) {
    if (y < 0 || y >= CHUNK_SY) return;
    const cx = Math.floor(x / CHUNK_SX);
    const cz = Math.floor(z / CHUNK_SZ);
    const chunk = this.ensureChunk(cx, cz);
    const lx = x - cx * CHUNK_SX;
    const lz = z - cz * CHUNK_SZ;
    chunk.set(lx, y, lz, id);
    this.dirtyChunks.add(chunk.key);
    if (lx === 0) this.dirtyChunks.add(chunkKey(cx - 1, cz));
    if (lx === CHUNK_SX - 1) this.dirtyChunks.add(chunkKey(cx + 1, cz));
    if (lz === 0) this.dirtyChunks.add(chunkKey(cx, cz - 1));
    if (lz === CHUNK_SZ - 1) this.dirtyChunks.add(chunkKey(cx, cz + 1));
  }
}
