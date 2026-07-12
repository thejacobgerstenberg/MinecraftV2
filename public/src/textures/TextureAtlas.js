// Loomfall procedural texture atlas — thin wrapper over ./packs5/atlas.js.
//
// buildAtlas(packName, seed=0) draws every tile in TILE_NAMES into one canvas
// using the requested texture pack (see texturePacks.js) and wraps it in a
// THREE.CanvasTexture ready for chunk materials. Contract unchanged from the
// original implementation (verified byte-exact prefix + identical tileUV
// semantics by packs5/selftest.mjs):
//
// ============================== UV CONVENTION ==============================
// The texture is a THREE.CanvasTexture with the three.js DEFAULT flipY=true.
// Canvas row 0 (the TOP of the canvas, atlas row 0) uploads to GL v=1.
//
// tileUV(name) returns {u0, v0, u1, v1} in [0,1] where (u0,v0) is the
// BOTTOM-LEFT and (u1,v1) the TOP-RIGHT of the tile in GL UV space, so
// u0 < u1 and v0 < v1 always. Canvas-space TOP of the tile art maps to v1;
// painters draw "block top" detail (grass fringe, snow cap) at canvas y=0.
//
// A HALF-TEXEL INSET (0.5px per edge) is baked into the returned UVs so
// neighboring atlas tiles never bleed under NearestFilter.
// ===========================================================================
//
// Returns { canvas, texture, tileUV(name), tileIndex(name), cols, tilePx }.
// Unknown tile names warn once and fall back to index 0.

export { buildAtlas, TILE_NAMES } from './packs5/atlas.js';
