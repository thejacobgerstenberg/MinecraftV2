export const CHUNK_SX = 16;
export const CHUNK_SZ = 16;
export const CHUNK_SY = 128;
export const SEA_LEVEL = 40;
export const RENDER_DISTANCE_DEFAULT = 6;
export const TILE_PX = 32;
export const ATLAS_COLS = 16;
export function blockIndex(x, y, z) { return x + z * CHUNK_SX + y * CHUNK_SX * CHUNK_SZ; }
