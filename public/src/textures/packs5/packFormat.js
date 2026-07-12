// graphics-lab/textures/packFormat.js
//
// Texture-pack definition schema + registry for the Loomfall pack system.
//
// A pack is:
//   {
//     id: string,            // registry key ('default', 'smooth', ...)
//     name: string,          // display name ('Loomfall Classic', ...)
//     description: string,
//     knobs: { ...KNOB_DEFAULTS overridden },   // style parameters
//     overrides: { [tileName]: drawFn },        // optional per-tile painters
//     drawTile(ctx, name, px, rng),             // atlas entry point
//   }
//
// drawTile clears the tile rect, runs the tile's painter (override first,
// then the shared library, then the magenta/black missing painter) with the
// pack knobs + brand palette, then applies the pack's post overlays
// (weave / fray / edge wear / outline).
//
// PURE module: no `three`, no DOM.

import { getPainter, applyOverlays } from './painters.js';
import { PALETTE } from './palettes.js';

// Atlas geometry constants (contract: 32px tiles, 16 columns).
export const TILE_PX = 32;
export const ATLAS_COLS = 16;

// ---------------------------------------------------------------------------
// Knob schema. Every knob has a default; definePack rejects unknown keys so
// typos fail loudly instead of silently painting the default look.
// ---------------------------------------------------------------------------
export const KNOB_DEFAULTS = {
  sat: 1.0,        // saturation multiplier (about luma)
  light: 1.0,      // brightness multiplier
  contrast: 1.0,   // value contrast about mid-gray
  grain: 1.0,      // per-pixel noise amplitude multiplier
  gradients: false, // soft large-scale shading instead of grain (smooth/cel)
  rampMerge: false, // merge ramp ends: soft-clamp value extremes (smooth)
  wear: 0,         // 0..1 extra cracks/scratches inside painters (gritty)
  edge: 0,         // 0..1 weathered edge pixels post-pass (gritty)
  outline: 0,      // outline width in px, darkened tile border (accessible)
  weave: 0,        // 0..1 warp/weft weave overlay on all tiles (Threadbare)
  dither: 0,       // 0..1 cross-stitch checker dither (Threadbare)
  sheen: 0,        // 0..1 diagonal thread-sheen highlights (Threadbare)
  fray: 0,         // 0..1 frayed edge pixels (Threadbare)
  patterns: false, // colorblind-safe ore SHAPE stamps (accessible)
  accentKeep: 0.5, // how much of a pack's desaturation accents resist (0..1)
};

export const PACK_REGISTRY = {};

/** Validate + normalize a pack spec, build drawTile, register, return pack. */
export function definePack(spec) {
  if (!spec || typeof spec.id !== 'string' || !spec.id) {
    throw new Error('definePack: spec.id (string) is required');
  }
  if (typeof spec.name !== 'string' || !spec.name) {
    throw new Error(`definePack(${spec.id}): spec.name (string) is required`);
  }
  const knobs = { ...KNOB_DEFAULTS };
  for (const k of Object.keys(spec.knobs || {})) {
    if (!(k in KNOB_DEFAULTS)) {
      throw new Error(`definePack(${spec.id}): unknown knob "${k}"`);
    }
    knobs[k] = spec.knobs[k];
  }
  const overrides = { ...(spec.overrides || {}) };
  for (const [tile, fn] of Object.entries(overrides)) {
    if (typeof fn !== 'function') {
      throw new Error(`definePack(${spec.id}): override for "${tile}" is not a function`);
    }
  }

  const pack = {
    id: spec.id,
    name: spec.name,
    description: spec.description || '',
    knobs,
    overrides,
    /** Render one tile at (0,0)..(px,px). rng comes from makeRng(). */
    drawTile(ctx, name, px, rng) {
      ctx.clearRect(0, 0, px, px);
      const fn = overrides[name] || getPainter(name);
      fn(ctx, px, rng, knobs, PALETTE);
      applyOverlays(ctx, px, rng, knobs);
    },
  };

  PACK_REGISTRY[pack.id] = pack;
  return pack;
}

export function listPacks() {
  return Object.values(PACK_REGISTRY);
}
