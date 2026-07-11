// avatars-plus/skin-descriptor.js
// Deterministic wire format + SkinSpec builder for custom Loomfall avatar skins.
import * as THREE from "three";

/* -------------------------------------------------------------------------- */
/* Local helpers (defensive, no external deps, never throw)                    */
/* -------------------------------------------------------------------------- */

/** Clamp v into [0,1]; non-finite -> 0. */
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Clamp n into [lo,hi]; non-finite -> lo. */
function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/** Coerce to an integer wrapped into [0, mod) (handles negatives/non-finite). */
function wrapInt(n, mod) {
  const i = Number.isFinite(n) ? Math.round(n) : 0;
  const r = ((i % mod) + mod) % mod;
  return r;
}

/**
 * Deterministic 32-bit integer mixer — used to derive a stable grain seed from
 * the descriptor fields (no Math.random anywhere on the appearance path).
 * @param {number} x uint32-ish input
 * @returns {number} mixed uint32
 */
function mix32(x) {
  let h = x >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
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
 * Apply a deterministic HSL nudge to a base color and return a NEW THREE.Color.
 * Accepts a hex number (0xRRGGBB) or an existing THREE.Color.
 * @param {number|THREE.Color} hex base color
 * @param {number} dHue hue delta in [0,1] hue units (fraction of the wheel)
 * @param {number} dSat saturation delta
 * @param {number} dLight lightness delta
 * @returns {THREE.Color}
 */
function shiftColor(hex, dHue, dSat, dLight) {
  const c = hex instanceof THREE.Color ? hex.clone() : new THREE.Color(hex);
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
/* Theme + weave tables                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The 6 rig theme ids, in canonical order. threadHue rotates the theme's base
 * cloth hue; each theme still supplies limb/head anchors + optional emissive.
 * @typedef {Object} ThemeDef
 * @property {string} id
 * @property {string} name
 * @property {number} base torso/cloth anchor hex
 * @property {number} limb arm/leg anchor hex
 * @property {number} head head anchor hex
 * @property {number} [emissive]
 * @property {number} [emissiveIntensity]
 */

/** @type {ThemeDef[]} */
const THEMES = [
  {
    id: "warpwold-mender",
    name: "Warpwold Mender",
    base: 0x347a41,
    limb: 0x5e4a30,
    head: 0xadd179,
  },
  {
    id: "cinderloom-scaldwarden",
    name: "Cinderloom Scaldwarden",
    base: 0x8c1d11,
    limb: 0x241c18,
    head: 0xc43a16,
    emissive: 0xfa6a1e,
    emissiveIntensity: 0.55,
  },
  {
    id: "nevermend-selvage-warden",
    name: "Nevermend Selvage-Warden",
    base: 0x6a4a94,
    limb: 0x4a4258,
    head: 0xc9c3d6,
  },
  {
    id: "everthread-forged",
    name: "Everthread Forged",
    base: 0xb98a2e,
    limb: 0x4a3a1e,
    head: 0xfcee8d,
    emissive: 0xc9821e,
    emissiveIntensity: 0.4,
  },
  {
    id: "frostlace-snowline",
    name: "Frostlace Snowline",
    base: 0x5bbcd2,
    limb: 0x3f8f9e,
    head: 0xf2f4f2,
  },
  {
    id: "understitch-unpicked",
    name: "Understitch Unpicked",
    base: 0x8a8278,
    limb: 0x6e675e,
    head: 0xb4ada2,
  },
];

/** Canonical ordered theme ids (index == wire themeIndex). @type {string[]} */
export const THEME_IDS = THEMES.map((t) => t.id);

/**
 * Weave motif labels (index == wire `weave` value 0..5). Each motif maps to a
 * deterministic weave cell size (gap px) + phase (patOffset) for the texture.
 * @type {string[]}
 */
export const WEAVE_MOTIFS = [
  "Plain",
  "Twill",
  "Basket",
  "Herringbone",
  "Houndstooth",
  "Ripstop",
];

/** Per-motif weave geometry: cell size (px) + phase offset. @type {{gap:number,patOffset:number}[]} */
const WEAVE_CELLS = [
  { gap: 4, patOffset: 0 }, // Plain
  { gap: 4, patOffset: 1 }, // Twill
  { gap: 6, patOffset: 0 }, // Basket
  { gap: 5, patOffset: 2 }, // Herringbone
  { gap: 8, patOffset: 1 }, // Houndstooth
  { gap: 3, patOffset: 3 }, // Ripstop
];

/* -------------------------------------------------------------------------- */
/* Descriptor: defaults / normalize / encode / decode                          */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} Descriptor
 * @property {string} theme one of THEME_IDS
 * @property {number} threadHue int 0..359 — rotates the theme base cloth hue
 * @property {number} weave int 0..5 — WEAVE_MOTIFS index (cell size/phase)
 * @property {number} accent int 0..359 — hue of the dark/light weave threads
 * @property {number} accentStrength number 0..1 — how vivid the weave threads read
 */

/** Sensible per-theme default hue seeds (degrees) so each theme's default looks distinct. */
const THEME_DEFAULT_HUE = [120, 12, 268, 42, 190, 34];

/**
 * Build a full Descriptor with sensible defaults for a theme id.
 * @param {string} themeId one of THEME_IDS (falls back to the first theme)
 * @returns {Descriptor}
 */
export function defaultDescriptor(themeId) {
  let idx = THEME_IDS.indexOf(themeId);
  if (idx < 0) idx = 0;
  return {
    theme: THEME_IDS[idx],
    threadHue: THEME_DEFAULT_HUE[idx] | 0,
    weave: 0,
    accent: (THEME_DEFAULT_HUE[idx] + 180) % 360,
    accentStrength: 0.5,
  };
}

/**
 * Clamp/validate an arbitrary object into a full Descriptor. Never throws; any
 * missing/invalid field is filled from the theme's defaults.
 * @param {Partial<Descriptor>|null|undefined} d
 * @returns {Descriptor}
 */
export function normalizeDescriptor(d) {
  const src = d && typeof d === "object" ? d : {};
  let idx = THEME_IDS.indexOf(src.theme);
  if (idx < 0) idx = 0;
  const def = defaultDescriptor(THEME_IDS[idx]);
  return {
    theme: THEME_IDS[idx],
    threadHue: wrapInt(src.threadHue == null ? def.threadHue : src.threadHue, 360),
    weave: clamp(
      Number.isFinite(src.weave) ? Math.round(src.weave) : def.weave,
      0,
      WEAVE_MOTIFS.length - 1
    ),
    accent: wrapInt(src.accent == null ? def.accent : src.accent, 360),
    accentStrength: clamp01(src.accentStrength == null ? def.accentStrength : src.accentStrength),
  };
}

/**
 * Encode a Descriptor to a compact deterministic string.
 *
 * GRAMMAR — five dotted base36 fields, no separators inside a field:
 *   "<themeIndex>.<threadHue>.<weave>.<accent>.<accentPct>"
 *   themeIndex : 0..5          (index into THEME_IDS)
 *   threadHue  : 0..359        (degrees)
 *   weave      : 0..5          (index into WEAVE_MOTIFS)
 *   accent     : 0..359        (degrees)
 *   accentPct  : 0..100        (round(accentStrength * 100))
 * All five integers are written in base36. Example: "0.3c.0.a8.32".
 * @param {Descriptor} d
 * @returns {string}
 */
export function encodeDescriptor(d) {
  const n = normalizeDescriptor(d);
  const ti = THEME_IDS.indexOf(n.theme);
  const parts = [
    (ti < 0 ? 0 : ti).toString(36),
    n.threadHue.toString(36),
    n.weave.toString(36),
    n.accent.toString(36),
    Math.round(clamp01(n.accentStrength) * 100).toString(36),
  ];
  return parts.join(".");
}

/**
 * Decode a compact string back into a normalized Descriptor. Never throws;
 * malformed input yields the default descriptor. Round-trips with encodeDescriptor.
 * @param {string} str
 * @returns {Descriptor}
 */
export function decodeDescriptor(str) {
  if (typeof str !== "string") return defaultDescriptor(THEME_IDS[0]);
  const p = str.split(".");
  const ti = parseInt(p[0], 36);
  const th = parseInt(p[1], 36);
  const w = parseInt(p[2], 36);
  const ac = parseInt(p[3], 36);
  const as = parseInt(p[4], 36);
  const idx = Number.isFinite(ti) ? clamp(ti, 0, THEME_IDS.length - 1) : 0;
  return normalizeDescriptor({
    theme: THEME_IDS[idx],
    threadHue: th,
    weave: w,
    accent: ac,
    accentStrength: Number.isFinite(as) ? as / 100 : undefined,
  });
}

/* -------------------------------------------------------------------------- */
/* Woven warp/weft texture generation (deterministic, offscreen, once)         */
/* -------------------------------------------------------------------------- */

/**
 * Build a 64x64 woven warp/weft CanvasTexture keyed deterministically by seed.
 * Returns null (never throws) when no DOM canvas is available — callers then
 * fall back to flat-color materials. Replicates the rig weave technique.
 * @param {number} seed uint32 driving the grain PRNG
 * @param {THREE.Color} main body/thread base color
 * @param {THREE.Color} dark weft (over-thread) color
 * @param {THREE.Color} light warp (under-thread) color
 * @param {number} gapPx weave cell size in pixels
 * @param {number} patOffset deterministic phase offset for the grain
 * @returns {THREE.CanvasTexture|null}
 */
function makeWeaveTexture(seed, main, dark, light, gapPx, patOffset) {
  try {
    if (typeof document === "undefined" || !document.createElement) return null;
    const SIZE = 64;
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const rnd = mulberry32((seed ^ Math.imul(patOffset + 1, 0x9e3779b1)) >>> 0);
    const g = Math.max(2, gapPx | 0);
    const off = patOffset | 0;

    // Base cloth fill.
    ctx.fillStyle = "#" + main.getHexString();
    ctx.fillRect(0, 0, SIZE, SIZE);

    const darkHex = "#" + dark.getHexString();
    const lightHex = "#" + light.getHexString();

    // Warp (vertical) + weft (horizontal) interleaved over/under per cell.
    for (let y = 0; y < SIZE; y += g) {
      for (let x = 0; x < SIZE; x += g) {
        const cx = ((x / g) | 0) + off;
        const cy = (y / g) | 0;
        const over = ((cx + cy) & 1) === 0;
        // Deterministic thread-value jitter so the cloth isn't a flat grid.
        const jitter = rnd() * 0.16 - 0.08;
        ctx.globalAlpha = clamp(0.32 + jitter, 0.1, 0.5);
        ctx.fillStyle = over ? lightHex : darkHex;
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
/* buildSkinFromDescriptor — descriptor -> SkinSpec                            */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} SkinSpec
 * @property {string} id theme id
 * @property {string} name display name
 * @property {Object<string,string>} palette hex-string colors used
 * @property {() => {head:THREE.Material,torso:THREE.Material,armL:THREE.Material,armR:THREE.Material,legL:THREE.Material,legR:THREE.Material}} makeMaterials
 * @property {THREE.Texture[]} textures every texture created (for disposal)
 */

/**
 * Build a full SkinSpec from a (possibly partial) Descriptor. Deterministic:
 * the SAME descriptor renders byte-identical textures/materials on every client.
 * Textures (head/torso/limb) are created ONCE and closed over by makeMaterials().
 * Never throws.
 * @param {Partial<Descriptor>} descriptor
 * @returns {SkinSpec}
 */
export function buildSkinFromDescriptor(descriptor) {
  const d = normalizeDescriptor(descriptor);
  const idx = THEME_IDS.indexOf(d.theme);
  const theme = THEMES[idx < 0 ? 0 : idx];

  // Deterministic grain seed from all descriptor fields.
  const seed = mix32(
    (idx << 24) ^
      Math.imul(d.threadHue, 0x9e3779b1) ^
      Math.imul(d.weave + 1, 0x85ebca6b) ^
      Math.imul(d.accent + 1, 0xc2b2ae35) ^
      Math.imul(Math.round(d.accentStrength * 100) + 1, 0x27d4eb2f)
  );

  const cell = WEAVE_CELLS[d.weave] || WEAVE_CELLS[0];
  const gap = cell.gap;
  const patOffset = cell.patOffset;

  // Base cloth: rotate the theme's part anchors by threadHue (absolute degrees).
  const dHue = d.threadHue / 360;
  const cHead = shiftColor(theme.head, dHue, 0, 0);
  const cTorso = shiftColor(theme.base, dHue, 0, 0);
  const cLimb = shiftColor(theme.limb, dHue, 0, 0);

  // Weave threads: hue from `accent`, vividness/darkness spread from accentStrength.
  const accHue = d.accent / 360;
  const strength = clamp01(d.accentStrength);
  const accSat = 0.15 + 0.6 * strength;
  const spread = 0.12 + 0.28 * strength; // how far dark/light diverge from mid
  const cDark = new THREE.Color().setHSL(accHue, accSat, clamp(0.42 - spread, 0.05, 0.95));
  const cLight = new THREE.Color().setHSL(accHue, accSat, clamp(0.58 + spread, 0.05, 0.98));

  // Build the three weave textures ONCE.
  const headTex = makeWeaveTexture(seed ^ 0x11, cHead, cDark, cLight, gap, patOffset);
  const torsoTex = makeWeaveTexture(seed ^ 0x22, cTorso, cDark, cLight, gap, patOffset);
  const limbTex = makeWeaveTexture(seed ^ 0x33, cLimb, cDark, cLight, gap, patOffset);

  const textures = [headTex, torsoTex, limbTex].filter((t) => t != null);

  const emissive = theme.emissive;
  const emissiveIntensity = theme.emissiveIntensity || 0;

  /**
   * Build one fresh MeshLambertMaterial for a part. When a weave map is present
   * the baked texture carries the tint, so material.color stays white.
   * @param {THREE.Color} color part base color (used when no map)
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
        if (map) mat.emissiveMap = map;
      }
      return mat;
    } catch (_err) {
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

export default buildSkinFromDescriptor;
