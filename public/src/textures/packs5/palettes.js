// graphics-lab/textures/palettes.js
//
// Loomfall tile palette — every color here is extracted from (or derived by
// mixing colors extracted from) the canonical brand color system:
//
//   source: origin/feature/brand : brand/palette.json
//   commit: d8f96a28c2b96fe1f6e8d79531d50cd218670a0f
//
// The hex values are hardcoded (this module must be pure + dependency-free so
// node selftests can load it), with the brand key noted next to each value.
//
// HUE OATHS (brand.forbidden — respected throughout painters.js):
//   * saturated ember orange (hue 8-42 at S>0.62, V>0.55) appears ONLY in
//     Cinderloom-flavored tiles: lava, netherrack veins, glowstone embers,
//     torch flame, soul_sand ember flecks.
//   * saturated cold cyan (hue 165-205 at S>0.30) appears ONLY in
//     Nevermend-flavored tiles: portal_frame glints (and nothing else; the
//     brand hemstone cyan #9CC8D6 itself sits at S~0.27, under the gate).
//   * no pure grays/black/white — every "neutral" below carries the brand's
//     3-8% saturation bias (warm ecru in the lights, violet in the darks).
//
// PURE module: no three, no DOM. Colors are [r, g, b] arrays in 0..255.

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const rgb = hexToRgb;
const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

// ---------------------------------------------------------------------------
// Raw brand values (verbatim from brand/palette.json @ d8f96a2).
// ---------------------------------------------------------------------------
export const BRAND = {
  gold: rgb('#F2C14E'),          // brand.primary Everthread Gold
  gold_glow: rgb('#FFDE8A'),     // primary.tints.glow / accents.knotlight
  gold_pale: rgb('#FFF6DF'),     // primary.tints.pale
  ochre: rgb('#6E4E07'),         // primary.tints.deep_ochre
  violet: rgb('#4A3670'),        // brand.secondary Duskwarp Violet
  violet_lift: rgb('#A48FD4'),   // secondary.tints.lift
  violet_mid: rgb('#61539E'),    // secondary.tints.mid
  violet_deep: rgb('#292050'),   // secondary.tints.deep
  void_ink: rgb('#14101F'),      // brand.void
  muslin: rgb('#EDE7DA'),        // brand.muslin
  warp_green: rgb('#5F8A46'),    // accents.warp_green
  dye_indigo: rgb('#35509E'),    // accents.dye_indigo
  madder: rgb('#B03A52'),        // accents.madder
  weld: rgb('#D9B93A'),          // accents.weld
  hemstone: rgb('#9CC8D6'),      // accents.hemstone_cyan (S~0.27: under oath gate)
  hemstone_pale: rgb('#DDF3F0'), // hemstone family pale (dimensions.nevermend N7)
  border_hem: rgb('#B9AE94'),    // ui.light.border_hem (warm ecru line)
};

// Dimension ramps (dimensions.*.ramp, verbatim).
export const WARPWOLD = ['#2C3247', '#355040', '#436844', '#5F8A46', '#87AB4C', '#B8BC5E', '#E4D68A', '#F6ECC8'].map(rgb);
export const CINDERLOOM = ['#191210', '#33221B', '#55291E', '#8A3220', '#C24A20', '#E8722A', '#F7A93E', '#FFDF96'].map(rgb);
export const NEVERMEND = ['#0C0A16', '#181330', '#292050', '#453672', '#61539E', '#7F7BC2', '#9CC8D6', '#DDF3F0'].map(rgb);

// Biome extracts used directly by tiles (biomes.*, verbatim).
const BIOME = {
  dirt: rgb('#8A6B3F'),          // sennmeadows.terrain_secondary
  bark: rgb('#5E4630'),          // thrumwood.terrain_secondary (braided-cord bark)
  forest_dark: rgb('#39592F'),   // thrumwood.foliage_or_feature
  stone: rgb('#697080'),         // warpspine_reach.terrain_primary (hue 216, S~7%)
  cotton_snow: rgb('#F0EDE3'),   // warpspine_reach.terrain_secondary (raw cotton snow)
  frost: rgb('#CBD5E4'),         // the_frostlace.terrain_primary
  frost_deep: rgb('#93A7BE'),    // the_frostlace.terrain_secondary
  frost_lace: rgb('#EBF0F7'),    // the_frostlace.foliage_or_feature
  bleach: rgb('#B5AFA0'),        // bleachlands.terrain_primary (ecru gray, S floor)
  bleach_deep: rgb('#948D7D'),   // bleachlands.terrain_secondary
  sand: rgb('#E0CE96'),          // dyewater_coast.terrain_primary (canon hue 46)
  sand_deep: rgb('#C4AD72'),     // dyewater_coast.terrain_secondary
  ember_feature: rgb('#E85B26'), // emberwarp.foliage_or_feature (Cinderloom only)
  ember_soil: rgb('#4A2B22'),    // emberwarp.terrain_secondary
  ash: rgb('#6E5F57'),           // ashskein_wastes.terrain_primary
  ash_deep: rgb('#40352F'),      // ashskein_wastes.terrain_secondary
  ash_violet: rgb('#332B33'),    // ashskein_wastes.foliage_or_feature
  tallow: rgb('#C9B27E'),        // tallow_vaults.terrain_primary
  tallow_deep: rgb('#8A6F4A'),   // tallow_vaults.terrain_secondary
  tallow_pale: rgb('#E6D3A0'),   // tallow_vaults.foliage_or_feature
  sky_day: rgb('#9FC1E8'),       // sennmeadows.sky (hue ~215, never cyan)
  info_blue: rgb('#A9CBF0'),     // ui.dark.info (hue ~213, "not cyan" per pairs)
  ghost_violet: rgb('#B7A8E0'),  // understitch_downs.accent
  pale_rim: rgb('#E4E0EE'),      // last_selvage.foliage_or_feature
};

// ---------------------------------------------------------------------------
// PALETTE — per-tile-family working colors. Derived values are mixes of the
// brand values above (never new hues), keeping the "nothing is ever gray" law.
// ---------------------------------------------------------------------------
export const PALETTE = {
  ...BRAND,
  W: WARPWOLD,
  C: CINDERLOOM,
  N: NEVERMEND,

  // Grass / foliage (Warpwold greens W2-W5; W3 is the identity midtone).
  grass: WARPWOLD[3],
  grass_light: WARPWOLD[4],
  grass_dark: WARPWOLD[2],
  grass_fringe: WARPWOLD[5],
  leaf: BIOME.forest_dark,
  leaf_light: mix(BIOME.forest_dark, WARPWOLD[4], 0.45),
  leaf_dark: mix(BIOME.forest_dark, WARPWOLD[1], 0.5),

  // Soils.
  dirt: BIOME.dirt,
  dirt_light: mix(BIOME.dirt, BIOME.sand, 0.3),
  dirt_dark: mix(BIOME.dirt, BIOME.bark, 0.6),
  gravel: BIOME.bleach,
  gravel_deep: BIOME.bleach_deep,
  gravel_dark: mix(BIOME.bleach_deep, BRAND.void_ink, 0.35),

  // Stone family (warm-violet tinted, never pure gray).
  stone: BIOME.stone,
  stone_light: mix(BIOME.stone, BIOME.frost, 0.35),
  stone_dark: mix(BIOME.stone, BRAND.void_ink, 0.42),
  bedrock: mix(BRAND.void_ink, BIOME.stone, 0.28),
  bedrock_dark: BRAND.void_ink,

  // Sand / sandstone / red sand (dyewater hue-46 family; red_sand kept at
  // S<=0.62 so it never trespasses on the Cinderloom ember oath).
  sand: BIOME.sand,
  sand_deep: BIOME.sand_deep,
  red_sand: rgb('#9C5A40'),      // madder x bark mix, hue ~17 at S~0.59 (< oath gate 0.62)
  red_sand_deep: rgb('#7A4634'),

  // Snow / frost.
  snow: BIOME.cotton_snow,
  snow_shade: BIOME.frost,
  snow_deep: BIOME.frost_deep,
  snow_sparkle: BIOME.frost_lace,

  // Wood: oak (thrumwood bark), birch (muslin-pale), spruce (dark).
  oak_bark: BIOME.bark,
  oak_bark_light: mix(BIOME.bark, BIOME.sand, 0.35),
  oak_bark_dark: mix(BIOME.bark, BRAND.void_ink, 0.45),
  oak_plank: mix(BIOME.bark, BIOME.sand, 0.52),
  oak_plank_dark: mix(BIOME.bark, BIOME.sand, 0.24),
  oak_heart: mix(BIOME.bark, BIOME.sand, 0.42),
  birch_bark: mix(BRAND.muslin, BIOME.sand, 0.3),
  birch_bark_dark: mix(BIOME.bark, BRAND.void_ink, 0.3),
  birch_plank: mix(BRAND.muslin, BIOME.sand, 0.55),
  birch_plank_dark: mix(BIOME.sand_deep, BIOME.bark, 0.3),
  spruce_bark: mix(BIOME.bark, BRAND.void_ink, 0.42),
  spruce_bark_light: mix(BIOME.bark, BIOME.sand, 0.12),
  spruce_plank: mix(BIOME.bark, BIOME.sand, 0.2),
  spruce_plank_dark: mix(BIOME.bark, BRAND.void_ink, 0.35),

  // Cactus.
  cactus: mix(WARPWOLD[3], BIOME.forest_dark, 0.35),
  cactus_light: mix(WARPWOLD[4], BIOME.forest_dark, 0.25),
  cactus_dark: mix(BIOME.forest_dark, WARPWOLD[1], 0.35),

  // Water (dye-indigo family — hue ~226, never Nevermend cyan).
  water: BRAND.dye_indigo,
  water_light: mix(BRAND.dye_indigo, BIOME.sky_day, 0.45),
  water_deep: mix(BRAND.dye_indigo, BRAND.void_ink, 0.4),

  // Glass (day-sky blue family, hue >= 208).
  glass_edge: BIOME.frost_deep,
  glass_tint: BIOME.sky_day,
  glass_sparkle: BIOME.frost_lace,

  // Ores. Each ore = distinct hue family + (Loudstone) distinct stamp shape.
  coal: mix(BRAND.void_ink, BIOME.stone, 0.15),
  coal_glint: mix(BIOME.stone, BRAND.void_ink, 0.35),
  iron: rgb('#B98A5A'),          // tallow x ochre metal tan, S~0.51 (< oath gate)
  iron_dark: mix(rgb('#B98A5A'), BIOME.bark, 0.5),
  iron_glint: mix(rgb('#B98A5A'), BRAND.muslin, 0.55),
  gold_dark: BRAND.ochre,
  diamond: BIOME.info_blue,      // hue ~213 — blue, NOT Nevermend cyan
  diamond_dark: BRAND.dye_indigo,
  diamond_glint: BIOME.frost_lace,
  gem: BIOME.ghost_violet,
  gem_dark: BRAND.violet_mid,
  gem_glint: BIOME.pale_rim,

  // Nether / Cinderloom set (the only home of saturated ember).
  netherrack: BIOME.ember_soil,
  netherrack_dark: mix(BIOME.ember_soil, CINDERLOOM[0], 0.5),
  ember: CINDERLOOM[4],          // #C24A20 saturation peak
  ember_hot: CINDERLOOM[5],
  ember_flare: CINDERLOOM[6],
  ember_core: CINDERLOOM[7],
  soul_sand: mix(BIOME.ash_deep, BIOME.bark, 0.3),
  soul_dark: mix(BIOME.ash_deep, BRAND.void_ink, 0.55),
  glowstone_base: mix(BRAND.ochre, CINDERLOOM[2], 0.35),

  // End / Nevermend set.
  obsidian: mix(BRAND.void_ink, NEVERMEND[2], 0.3),
  obsidian_sheen: NEVERMEND[3],
  obsidian_edge: NEVERMEND[1],
  end_stone: BIOME.tallow,
  end_stone_deep: BIOME.tallow_deep,
  end_stone_pale: BIOME.tallow_pale,
  purpur: mix(BRAND.violet, BRAND.violet_mid, 0.5),
  purpur_light: mix(BRAND.violet_lift, BRAND.violet_mid, 0.4),
  purpur_dark: BRAND.violet_deep,
  portal_a: NEVERMEND[3],
  portal_b: NEVERMEND[5],
  portal_glow: BRAND.violet_lift,

  // Loomfall craft set.
  thread_base: mix(BRAND.muslin, BIOME.sand_deep, 0.35),
  thread_shadow: BRAND.border_hem,
  thread_deep: mix(BRAND.border_hem, BIOME.bark, 0.45),
  weave_warp: mix(BRAND.weld, BIOME.sand, 0.4),
  weave_warp_dark: mix(BRAND.weld, BIOME.bark, 0.45),
  weave_weft: mix(BRAND.violet_lift, BRAND.violet_mid, 0.45),
  weave_weft_dark: mix(BRAND.violet_mid, BRAND.violet_deep, 0.5),
  loom_frame: mix(BIOME.bark, BRAND.void_ink, 0.25),
  loom_frame_light: mix(BIOME.bark, BIOME.sand, 0.28),
  loom_bed: mix(BRAND.violet_deep, BRAND.void_ink, 0.45),

  // Wools — dyed fiber (brand dye-band colors; black is violet-biased).
  wool: {
    white: { base: BRAND.muslin, dark: mix(BRAND.border_hem, BRAND.muslin, 0.35), light: rgb('#F7F2E4') },
    red: { base: BRAND.madder, dark: mix(BRAND.madder, BRAND.void_ink, 0.4), light: mix(BRAND.madder, BRAND.muslin, 0.3) },
    blue: { base: BRAND.dye_indigo, dark: mix(BRAND.dye_indigo, BRAND.void_ink, 0.4), light: mix(BRAND.dye_indigo, BIOME.sky_day, 0.35) },
    green: { base: BRAND.warp_green, dark: WARPWOLD[2], light: WARPWOLD[4] },
    yellow: { base: BRAND.weld, dark: mix(BRAND.weld, BIOME.bark, 0.4), light: mix(BRAND.weld, BRAND.gold_pale, 0.4) },
    black: { base: rgb('#2E2645'), dark: BRAND.void_ink, light: mix(rgb('#2E2645'), BRAND.violet_mid, 0.35) },
  },
};

export default PALETTE;
