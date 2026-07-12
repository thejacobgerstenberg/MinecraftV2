// Loomfall texture packs — thin wrapper over the 5-pack system in ./packs5/.
//
// PURE module surface preserved from the original 3-pack implementation so
// existing imports keep working:
//   PACKS       — registry keyed by pack id; each { id, name, drawTile(ctx, name, px, rng) }
//   makeRng     — deterministic string-seeded PRNG (xmur3 -> mulberry32)
//   TILE_NAMES  — canonical ordered tile list (33-name frozen prefix + 22
//                 appended tiles = 55; re-exported by TextureAtlas.js)
//
// The five packs (see packs5/README.md):
//   default    Loomfall Classic — reference pixel-art look (brand palette)
//   smooth     Softstone        — cel-ish gradients, merged ramps
//   gritty     Gritstone        — weathered, desaturated, high contrast
//   woven      Threadbare       — warp/weft weave, cross-stitch dither
//   accessible Loudstone        — high contrast + colorblind-safe ore shapes
//
// Persisted pack ids from the old 3-pack system ('default', 'smooth',
// 'gritty') resolve unchanged — the new registry reuses the same ids.

export { TILE_NAMES, makeRng } from './packs5/painters.js';
export { PACK_REGISTRY as PACKS } from './packs5/packs.js';
