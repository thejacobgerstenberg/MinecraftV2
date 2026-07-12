// graphics-lab/textures/packs.js
//
// The five Loomfall texture packs, defined as knob transforms over the shared
// painter library (painters.js) via the pack schema (packFormat.js).
//
// Distinctness is enforced NUMERICALLY by selftest.mjs per the brand
// packVariants rubric (brand/palette.json @ d8f96a2):
//   * smooth mean-saturation >= 1.2x default
//   * gritty mean-saturation <= 0.7x default AND contrast >= 1.3x default
//   * accessible mean-contrast >= 1.4x default
//
// PURE module: no `three`, no DOM.

import { definePack, PACK_REGISTRY } from './packFormat.js';

export const defaultPack = definePack({
  id: 'default',
  name: 'Loomfall Classic',
  description: 'Clean 32px pixel art, the brand palette as-is. The reference look every other pack is measured against.',
  knobs: {}, // all defaults
});

export const smoothPack = definePack({
  id: 'smooth',
  name: 'Softstone',
  description: 'Cel-ish and gentle: saturation up ~1.3x, ramp ends merged, grain nearly gone, rounded gradient shading.',
  knobs: {
    sat: 1.42,
    light: 1.04,
    contrast: 0.86,
    grain: 0.12,
    gradients: true,
    rampMerge: true,
    accentKeep: 0.5,
  },
});

export const grittyPack = definePack({
  id: 'gritty',
  name: 'Gritstone',
  description: 'Weathered and worn: saturation down to ~0.6x, value contrast up ~1.35x, heavy grain, cracks, chipped edges.',
  knobs: {
    sat: 0.55,
    light: 0.94,
    contrast: 1.5,
    grain: 1.9,
    wear: 1,
    edge: 1,
    accentKeep: 0.45,
  },
});

export const wovenPack = definePack({
  id: 'woven',
  name: 'Threadbare',
  description: 'Lore-native: every tile rendered as if stitched from thread — warp/weft weave underlay, cross-stitch dither, frayed edges, thread-sheen highlights.',
  knobs: {
    sat: 0.95,
    light: 1.0,
    contrast: 1.0,
    grain: 0.45,
    weave: 1,
    dither: 0.8,
    sheen: 1,
    fray: 1,
    accentKeep: 0.6,
  },
});

export const accessiblePack = definePack({
  id: 'accessible',
  name: 'Loudstone',
  description: 'High-contrast accessibility pack: bold 2px darker outlines, boosted value separation, and colorblind-safe ore SHAPES (dots / stripes / diamonds / crosses / rings / zigzag) so nothing is distinguished by hue alone.',
  knobs: {
    sat: 1.05,
    light: 1.02,
    contrast: 1.3,
    grain: 1.1,
    outline: 2,
    patterns: true,
    accentKeep: 0.8,
  },
});

export { PACK_REGISTRY };
export const PACKS = PACK_REGISTRY; // builder-contract-style alias
