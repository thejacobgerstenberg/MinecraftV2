// graphics-lab/src/blocks.js
//
// Block palette for the voxel demo.
//
// Block ids (index into BLOCKS): 0 air, 1 grass, 2 dirt, 3 stone, 4 sand,
// 5 wood, 6 leaves, 7 water, 8 plank, 9 glowstone, 10 snow.
//
// Each block descriptor:
//   {
//     name,
//     color:[r,g,b] 0..1,          // base albedo
//     top?:[r,g,b], side?:[r,g,b], bottom?:[r,g,b],  // per-face color overrides
//     topShade?, sideShade?, bottomShade?,           // per-face brightness multipliers
//     transparent?:bool,           // participates in transparency (water, leaves)
//     opacity?:0..1,               // alpha when transparent
//     emissive?:[r,g,b],           // self-illumination (glowstone)
//   }
//
// Colors are authored in linear-ish 0..1 space; the renderer can convert as
// needed. Face shade multipliers give cheap directional lighting even before
// any real AO / shadow pass runs (top brighter, sides mid, bottom darker).

export const AIR = 0;
export const GRASS = 1;
export const DIRT = 2;
export const STONE = 3;
export const SAND = 4;
export const WOOD = 5;
export const LEAVES = 6;
export const WATER = 7;
export const PLANK = 8;
export const GLOWSTONE = 9;
export const SNOW = 10;

// Default per-face brightness. Top faces catch the most light, bottom the least.
const TOP_SHADE = 1.0;
const SIDE_SHADE = 0.82;
const BOTTOM_SHADE = 0.62;

export const BLOCKS = [
  // 0 - air (never rendered; present so id === index)
  {
    name: 'air',
    color: [0, 0, 0],
    transparent: true,
    opacity: 0,
    air: true,
  },

  // 1 - grass: vivid green top, dirt-brown sides with a green fringe, dirt bottom
  {
    name: 'grass',
    color: [0.35, 0.62, 0.22],
    top: [0.35, 0.62, 0.22],
    side: [0.42, 0.48, 0.24],
    bottom: [0.45, 0.32, 0.20],
    topShade: TOP_SHADE,
    sideShade: SIDE_SHADE,
    bottomShade: BOTTOM_SHADE,
  },

  // 2 - dirt
  {
    name: 'dirt',
    color: [0.45, 0.32, 0.20],
    topShade: TOP_SHADE,
    sideShade: SIDE_SHADE,
    bottomShade: BOTTOM_SHADE,
  },

  // 3 - stone
  {
    name: 'stone',
    color: [0.50, 0.50, 0.53],
    topShade: TOP_SHADE,
    sideShade: SIDE_SHADE,
    bottomShade: BOTTOM_SHADE,
  },

  // 4 - sand
  {
    name: 'sand',
    color: [0.83, 0.78, 0.55],
    topShade: TOP_SHADE,
    sideShade: 0.88,
    bottomShade: 0.70,
  },

  // 5 - wood (log): darker bark sides, lighter cut-ring top/bottom
  {
    name: 'wood',
    color: [0.40, 0.28, 0.16],
    top: [0.55, 0.42, 0.26],
    side: [0.36, 0.25, 0.15],
    bottom: [0.55, 0.42, 0.26],
    topShade: TOP_SHADE,
    sideShade: SIDE_SHADE,
    bottomShade: BOTTOM_SHADE,
  },

  // 6 - leaves: transparent, deep saturated green
  {
    name: 'leaves',
    color: [0.22, 0.45, 0.16],
    top: [0.26, 0.52, 0.18],
    side: [0.20, 0.42, 0.15],
    bottom: [0.15, 0.32, 0.12],
    transparent: true,
    opacity: 0.85,
    topShade: TOP_SHADE,
    sideShade: SIDE_SHADE,
    bottomShade: BOTTOM_SHADE,
  },

  // 7 - water: transparent blue
  {
    name: 'water',
    color: [0.15, 0.35, 0.55],
    transparent: true,
    opacity: 0.72,
    topShade: 1.0,
    sideShade: 0.90,
    bottomShade: 0.80,
  },

  // 8 - plank (cabin walls/roof): warm sawn-wood brown
  {
    name: 'plank',
    color: [0.62, 0.45, 0.26],
    top: [0.66, 0.49, 0.29],
    side: [0.60, 0.43, 0.25],
    bottom: [0.52, 0.37, 0.21],
    topShade: TOP_SHADE,
    sideShade: SIDE_SHADE,
    bottomShade: BOTTOM_SHADE,
  },

  // 9 - glowstone: bright, emissive
  {
    name: 'glowstone',
    color: [0.95, 0.85, 0.55],
    emissive: [1.0, 0.85, 0.5],
    topShade: 1.0,
    sideShade: 1.0,
    bottomShade: 1.0,
  },

  // 10 - snow
  {
    name: 'snow',
    color: [0.95, 0.96, 1.0],
    topShade: 1.0,
    sideShade: 0.92,
    bottomShade: 0.80,
  },
];

// Convenience lookups ----------------------------------------------------------

export function getBlock(id) {
  return BLOCKS[id] || BLOCKS[0];
}

export function isAir(id) {
  return id === AIR;
}

export function isTransparent(id) {
  const b = BLOCKS[id];
  return !!(b && b.transparent);
}

// Solid = occludes neighbours for meshing purposes. Air and water do not.
export function isSolidId(id) {
  return id !== AIR && id !== WATER;
}

// Opaque = solid AND fully blocks light (not water, not leaves).
export function isOpaqueId(id) {
  return id !== AIR && id !== WATER && id !== LEAVES;
}

// Return the color for a given face ('top'|'side'|'bottom') as [r,g,b],
// pre-multiplied by the face shade. Falls back to base color.
export function faceColor(id, face) {
  const b = getBlock(id);
  const base = b[face] || b.color;
  let shade = 1.0;
  if (face === 'top') shade = b.topShade ?? 1.0;
  else if (face === 'bottom') shade = b.bottomShade ?? 1.0;
  else shade = b.sideShade ?? 1.0;
  return [base[0] * shade, base[1] * shade, base[2] * shade];
}

export default BLOCKS;
