// Shim: the graphics-lab textures/atlas.js is vendored (byte-identical) at
// public/src/textures/packs5/atlas.js — re-export it so integrate.js /
// labAdapter.js resolve ONE copy (single source of truth for tile art).
export * from '../../src/textures/packs5/atlas.js';
