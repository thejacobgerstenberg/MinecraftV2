// avatars/skins.js — deterministic Loomfall-themed procedural avatar skins.
// Hashes skinSeed (FNV-1a) to pick a lore theme + per-avatar variation, then
// builds fresh THREE.Material sets carrying a small woven warp/weft CanvasTexture.
import * as THREE from "three";

/* -------------------------------------------------------------------------- */
/* Local helpers (defensive, no external deps)                                 */
/* -------------------------------------------------------------------------- */

/** Clamp n into [lo, hi]. */
function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * FNV-1a 32-bit hash of a string. Deterministic across engines/clients.
 * @param {string} str
 * @returns {number} unsigned 32-bit hash
 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    // 32-bit FNV prime multiply via shifts (stays in uint32 with >>> 0)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic integer mixer — derives an independent sub-hash from a base
 * hash and a small tag, so several variation streams come from one seed.
 * @param {number} h base uint32
 * @param {number} tag small integer selector
 * @returns {number} mixed uint32
 */
function mix(h, tag) {
  let x = (h ^ (Math.imul(tag + 1, 0x9e3779b1) >>> 0)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * mulberry32 PRNG factory — deterministic float stream seeded by a uint32.
 * Used only for offscreen texture grain (never per animation frame).
 * @param {number} seed uint32
 * @returns {() => number} generator returning floats in [0,1)
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Apply a deterministic HSL nudge to a hex color and return a new THREE.Color.
 * @param {number} hex base color (0xRRGGBB)
 * @param {number} dHue hue delta in [0,1] hue units
 * @param {number} dSat saturation delta
 * @param {number} dLight lightness delta
 * @returns {THREE.Color}
 */
function shiftColor(hex, dHue, dSat, dLight) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  let h = (hsl.h + dHue) % 1;
  if (h < 0) h += 1;
  const s = clamp(hsl.s + dSat, 0, 1);
  const l = clamp(hsl.l + dLight, 0, 1);
  c.setHSL(h, s, l);
  return c;
}

/* -------------------------------------------------------------------------- */
/* Themes (Loomfall cosmology — reality is woven cloth on a great Loom)         */
/* Palette anchors drawn from the art bible.                                   */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} ThemeDef
 * @property {string} id
 * @property {string} name
 * @property {string} blurb
 * @property {"lambert"|"standard"} style
 * @property {number} base   torso hex
 * @property {number} limb   arm/leg hex
 * @property {number} head   head hex
 * @property {number} dark   weft (dark thread) hex
 * @property {number} light  warp (light thread) hex
 * @property {number} [emissive]
 * @property {number} [emissiveIntensity]
 * @property {number} [gap]  weave cell size in px (density of the grain)
 */

/** @type {ThemeDef[]} */
const THEMES = [
  {
    id: "warpwold-mender",
    name: "Warpwold Mender",
    blurb:
      "A thread come loose from the overworld weave — embroidered greens over warm dawn-earth leathers. The player's own kind.",
    style: "lambert",
    base: 0x347a41, // grass warp green
    limb: 0x5e4a30, // dawn-earth leather
    head: 0xadd179, // pale grass highlight
    dark: 0x245230,
    light: 0xadd179,
    gap: 4,
  },
  {
    id: "cinderloom-scaldwarden",
    name: "Cinderloom Scaldwarden",
    blurb:
      "Furnace-realm warden clad in molten red and ash-black, seams still smouldering with faint embers.",
    style: "standard",
    base: 0x8c1d11, // lava deep
    limb: 0x241c18, // ash black
    head: 0xc43a16, // hot ember
    dark: 0x3a140c,
    light: 0xfad646, // lava spark
    emissive: 0xfa6a1e,
    emissiveIntensity: 0.55,
    gap: 4,
  },
  {
    id: "nevermend-selvage-warden",
    name: "Nevermend Selvage-Warden",
    blurb:
      "Keeper of the half-unravelled tapestry at the world's edge — cold violet and ghost-pale, lit by nothing.",
    style: "lambert",
    base: 0x6a4a94, // void violet (saturated enough to read as violet, not grey)
    limb: 0x4a4258, // cold grey-violet
    head: 0xc9c3d6, // ghost pale
    dark: 0x2e2a38,
    light: 0xb7aec9,
    gap: 5,
  },
  {
    id: "everthread-forged",
    name: "Everthread Forged",
    blurb:
      "Bearer of the oldest molten-forged thread, unbreakable and brilliant gold-orange — it glows even in the dark.",
    style: "standard",
    base: 0xb98a2e, // gold body
    limb: 0x4a3a1e, // dark forge
    head: 0xfcee8d, // bright gold crown
    dark: 0x5a3f16,
    light: 0xfcee8d,
    emissive: 0xc9821e,
    emissiveIntensity: 0.4,
    gap: 4,
  },
  {
    id: "frostlace-snowline",
    name: "Frostlace Snowline",
    blurb:
      "Woven from brittle icelace along the snowline — white-blue threads that crack cold light.",
    style: "lambert",
    base: 0x5bbcd2, // icy blue cloth (deeper/saturated so it reads blue, not white-grey)
    limb: 0x3f8f9e, // deeper glacial
    head: 0xf2f4f2, // wool white
    dark: 0x51a2a8, // diamond deep
    light: 0xc3faf6, // diamond bright
    gap: 4,
  },
  {
    id: "understitch-unpicked",
    name: "Understitch Unpicked",
    blurb:
      "A figure being quietly unpicked from the pattern — desaturated tan-grey with a doubled, fraying weave.",
    style: "lambert",
    base: 0x8a8278, // desaturated tan
    limb: 0x6e675e, // worn grey
    head: 0xb4ada2, // faded wool
    dark: 0x55504a,
    light: 0xccc9c4, // wool white soft
    gap: 3, // denser doubled weave
  },
];

/** Public, lore-facing list for the demo gallery. @type {{id:string,name:string,blurb:string}[]} */
export const SKIN_THEMES = THEMES.map((t) => ({
  id: t.id,
  name: t.name,
  blurb: t.blurb,
}));

/* -------------------------------------------------------------------------- */
/* Woven warp/weft texture generation (deterministic, offscreen, once)         */
/* -------------------------------------------------------------------------- */

/**
 * Build a small woven warp/weft CanvasTexture keyed deterministically by seed.
 * Returns null (never throws) if no DOM canvas is available or drawing fails —
 * callers then fall back to flat-color materials.
 * @param {number} seed uint32 driving the grain PRNG
 * @param {THREE.Color} main body/thread base color
 * @param {THREE.Color} dark weft (over-thread) color
 * @param {THREE.Color} light warp (under-thread) color
 * @param {number} gap weave cell size in pixels
 * @param {number} patOffset deterministic phase offset for the grain
 * @returns {THREE.CanvasTexture|null}
 */
function makeWeaveTexture(seed, main, dark, light, gap, patOffset) {
  try {
    if (typeof document === "undefined" || !document.createElement) return null;
    const SIZE = 64;
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const rnd = mulberry32((seed ^ (patOffset * 0x9e3779b1)) >>> 0);
    const g = Math.max(2, gap | 0);

    // Base cloth fill.
    ctx.fillStyle = "#" + main.getHexString();
    ctx.fillRect(0, 0, SIZE, SIZE);

    const darkHex = "#" + dark.getHexString();
    const lightHex = "#" + light.getHexString();

    // Warp (vertical foundation threads) + weft (horizontal cross-threads),
    // interleaved over/under per cell to read as a subtle plaid grain.
    for (let y = 0; y < SIZE; y += g) {
      for (let x = 0; x < SIZE; x += g) {
        const cx = ((x / g) | 0) + patOffset;
        const cy = (y / g) | 0;
        const over = ((cx + cy) & 1) === 0;
        // Slight deterministic thread-value jitter so the cloth isn't a flat grid.
        const jitter = rnd() * 0.16 - 0.08;
        // Lower mean/ceiling so the tinted base hue survives the overlay and the
        // saturated (red/blue/violet) themes don't desaturate to grey in a batch.
        ctx.globalAlpha = clamp(0.32 + jitter, 0.10, 0.5);
        // over-cells show the light warp, under-cells the dark weft.
        ctx.fillStyle = over ? lightHex : darkHex;
        // Thread runs the length of the cell in its dominant direction.
        if (over) {
          ctx.fillRect(x, y, Math.max(1, g - 1), g); // vertical warp segment
        } else {
          ctx.fillRect(x, y, g, Math.max(1, g - 1)); // horizontal weft segment
        }
      }
    }
    ctx.globalAlpha = 1;

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    // Crisp pixel-art look that matches the game's block textures: nearest on
    // both mag and min, no mipmaps (avoids blurring the 64px weave at distance).
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  } catch (_err) {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* resolveSkin — the deterministic public entry point                          */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} SkinSpec
 * @property {string} id theme id
 * @property {string} name theme display name
 * @property {Object<string,string>} palette hex-string colors used
 * @property {() => {head:THREE.Material,torso:THREE.Material,armL:THREE.Material,armR:THREE.Material,legL:THREE.Material,legR:THREE.Material}} makeMaterials
 * @property {THREE.Texture[]} textures every texture created (for disposal)
 */

/**
 * Deterministically resolve a skinSeed to a full SkinSpec. The same seed
 * (string or number) always yields byte-identical materials/textures on every
 * client: the seed is FNV-1a hashed, the hash selects a theme and drives all
 * per-avatar variation, and texture grain uses a hash-seeded PRNG — no
 * Math.random anywhere on the appearance path. Never throws.
 * @param {string|number} skinSeed
 * @returns {SkinSpec}
 */
export function resolveSkin(skinSeed) {
  const seedStr = String(skinSeed == null ? "anon" : skinSeed);
  const h = fnv1a(seedStr);

  const theme = THEMES[h % THEMES.length] || THEMES[0];

  // Per-avatar variation, all derived from independent mixes of the one hash.
  const dHue = (((mix(h, 1) % 41) - 20) / 360); // +/- ~20 deg
  const dSat = (((mix(h, 2) % 25) - 12) / 200); // +/- ~0.06
  const dLight = (((mix(h, 3) % 21) - 10) / 200); // +/- ~0.05
  const patOffset = mix(h, 4) % 8;
  const grainSeed = mix(h, 5);

  // Tinted per-part colors (deterministic).
  const cHead = shiftColor(theme.head, dHue, dSat, dLight);
  const cTorso = shiftColor(theme.base, dHue, dSat, dLight);
  const cLimb = shiftColor(theme.limb, dHue, dSat, dLight);
  const cDark = shiftColor(theme.dark, dHue, dSat, dLight);
  const cLight = shiftColor(theme.light, dHue, dSat, dLight);

  // Textures are created ONCE here (never per frame). Shared per color group.
  const gap = theme.gap || 4;
  const headTex = makeWeaveTexture(grainSeed ^ 0x11, cHead, cDark, cLight, gap, patOffset);
  const torsoTex = makeWeaveTexture(grainSeed ^ 0x22, cTorso, cDark, cLight, gap, patOffset);
  const limbTex = makeWeaveTexture(grainSeed ^ 0x33, cLimb, cDark, cLight, gap, patOffset);

  const textures = [headTex, torsoTex, limbTex].filter((t) => t != null);

  const emissive = theme.emissive;
  const emissiveIntensity = theme.emissiveIntensity || 0;

  /**
   * Build one fresh material for a part. Always MeshLambertMaterial to match the
   * game's lit box look. When a weave map is present the baked texture already
   * carries the tinted color, so material.color stays white; otherwise the flat
   * tinted color is used directly. Emissive themes still glow — MeshLambert
   * supports emissive + emissiveMap.
   * @param {THREE.Color} color part base color
   * @param {THREE.Texture|null} map weave texture (may be null)
   * @returns {THREE.Material}
   */
  function buildMaterial(color, map) {
    try {
      const opts = { color: map ? 0xffffff : color.clone() };
      if (map) opts.map = map;
      const mat = new THREE.MeshLambertMaterial(opts);
      if (emissive != null) {
        mat.emissive = new THREE.Color(emissive);
        mat.emissiveIntensity = emissiveIntensity;
        if (map) mat.emissiveMap = map; // glow follows the weave
      }
      return mat;
    } catch (_err) {
      // Absolute fallback — a flat lambert never fails.
      return new THREE.MeshLambertMaterial({ color: color.clone() });
    }
  }

  /**
   * Produce a fresh set of the six part materials. Called once per avatar by
   * model.js; safe to call again (returns new Material instances each time).
   * @returns {{head:THREE.Material,torso:THREE.Material,armL:THREE.Material,armR:THREE.Material,legL:THREE.Material,legR:THREE.Material}}
   */
  function makeMaterials() {
    return {
      head: buildMaterial(cHead, headTex),
      torso: buildMaterial(cTorso, torsoTex),
      armL: buildMaterial(cLimb, limbTex),
      armR: buildMaterial(cLimb, limbTex),
      legL: buildMaterial(cLimb, limbTex),
      legR: buildMaterial(cLimb, limbTex),
    };
  }

  const palette = {
    head: "#" + cHead.getHexString(),
    torso: "#" + cTorso.getHexString(),
    limb: "#" + cLimb.getHexString(),
    dark: "#" + cDark.getHexString(),
    light: "#" + cLight.getHexString(),
  };
  if (emissive != null) palette.emissive = "#" + new THREE.Color(emissive).getHexString();

  return {
    id: theme.id,
    name: theme.name,
    palette,
    makeMaterials,
    textures,
  };
}

export default resolveSkin;
