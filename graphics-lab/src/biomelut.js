// graphics-lab/src/biomelut.js
//
// PER-BIOME COLOUR GRADING LUT + CONTROLLER.
//
// A palette of *subtle* lift/gain/saturation grades — one per biome —
// applied through PostFX.setGrade(), which folds them into the existing
// composite pass (AFTER ACES tonemapping, BEFORE vignette/FXAA):
//
//   c = mix(vec3(luma(c)), c, sat) * gain + lift
//
// PostFX eases the live grade toward each new target over ~0.5 s, so switching
// biomes cross-fades instead of popping. This module costs nothing per frame:
// it only ever calls setGrade() when the biome or enabled state changes, and
// the grade itself is a handful of ALU ops already living in the composite
// shader.
//
// BRAND ALIGNMENT (LOOMFALL "Light Through the Warp", brand/palette.json on
// feature/brand @ d8f96a2): the biome list below is the canonical 16-biome
// brand set, and every grade is DERIVED from its brand colour swatch — not
// hand-picked. Derivation (deriveGrade below, deterministic):
//
//   * mean  — weighted sRGB mean of the swatch (fog + primary terrain carry
//             the ambience, so they weigh 1.5; the accent is a small-area pop
//             colour, so it weighs 0.5).
//   * gain  — 1 + 0.9 * (mean - luma(mean)) per channel: a gentle push toward
//             the swatch's chromatic deviation from neutral grey. Luma-neutral
//             by construction (the deviation is orthogonal to Rec.709 luma).
//   * lift  — ((sky+fog)/2 - 0.6) * 0.045 per channel: pale hazy ambiences
//             get a tiny fog-tinted floor lift, dark realms a gentle crush,
//             tinted by the ambience itself (e.g. deepest in blue underground
//             in the Cinderloom realms).
//   * sat   — 0.86 + 0.45 * meanSat(swatch): drained brand palettes desaturate
//             the frame, dye-soaked ones enrich it.
//
// Value discipline (enforced by clamps in deriveGrade — the scene look is
// owned by the sky / lighting, the grade is seasoning):
//   gain  within ±0.08 of 1.0
//   lift  within ±0.03 of 0.0
//   sat   within 0.85 .. 1.05
//
// The five pre-brand biome names keep working as ALIASES of their nearest
// brand biome (same frozen entry object):
//   plains -> sennmeadows   desert -> bleachlands   tundra -> the_frostlace
//   swamp  -> muslin_fens   cinder -> emberwarp
//
// Public API (unchanged, plus BRAND_VERSION):
//   BIOMES                       // { name: {lift:[r,g,b], gain:[r,g,b], sat,
//                                //          description, brandColors} }
//   BRAND_VERSION                // id of the brand palette the LUT is built from
//   NEUTRAL_GRADE                // identity grade (disabled/disposed state)
//   new BiomeGrading(postFX)     // postFX: a PostFX instance (or any object
//                                //         exposing setGrade({lift,gain,sat}))
//   grading.setBiome(name)       // -> bool (false + warn on unknown name)
//   grading.biome                // getter: current biome name
//   grading.list()               // -> array of biome names (brand + aliases)
//   grading.setEnabled(bool)     // disabled => neutral grade (biome remembered)
//   grading.enabled              // getter
//   grading.update(dt, ctx)      // no-op (PostFX.render does the easing)
//   grading.dispose()            // resets the grade to neutral, drops the ref

// Identity of the canonical colour system this LUT is derived from. The brand
// json carries no numeric version field; its identity is the system name, so
// that plus the source commit is the version string.
export const BRAND_VERSION =
  'LOOMFALL "Light Through the Warp" (brand/palette.json @ feature/brand d8f96a2)';

// ---------------------------------------------------------------------------
// Brand swatches — verbatim hexes from palette.json `biomes` (sky, fog,
// terrain_primary, terrain_secondary, foliage_or_feature, accent). These are
// the derivation INPUT and are exposed on each BIOMES entry as .brandColors.
// ---------------------------------------------------------------------------
const BRAND_BIOMES = {
  sennmeadows: {
    colors: {
      sky: '#9FC1E8', fog: '#DAE4EC', terrain_primary: '#699247',
      terrain_secondary: '#8A6B3F', foliage_or_feature: '#93B04E', accent: '#C7598C',
    },
    description:
      'Warm starting country: meadow-green push under a pale woven haze.',
  },
  thrumwood: {
    colors: {
      sky: '#8FB2D9', fog: '#B7C4B4', terrain_primary: '#49703F',
      terrain_secondary: '#5E4630', foliage_or_feature: '#39592F', accent: '#C9A648',
    },
    description:
      'Forest under a green-cast fog: greens up, red/blue eased off.',
  },
  muslin_fens: {
    colors: {
      sky: '#C2CBD3', fog: '#E5E3DA', terrain_primary: '#788462',
      terrain_secondary: '#6B6250', foliage_or_feature: '#9AA378', accent: '#E9E4F4',
    },
    description:
      'Dense pale gauze: desaturated, gently green, a milky floor lift.',
  },
  understitch_downs: {
    colors: {
      sky: '#A9B4D4', fog: '#CBC5DE', terrain_primary: '#7C9152',
      terrain_secondary: '#8F8AA8', foliage_or_feature: '#A3B268', accent: '#B7A8E0',
    },
    description:
      'Ghost terrain: violet-shifted haze over green downs, slightly drained.',
  },
  warpspine_reach: {
    colors: {
      sky: '#7FA3CC', fog: '#C2CEDD', terrain_primary: '#697080',
      terrain_secondary: '#F0EDE3', foliage_or_feature: '#55704A', accent: '#E4BD52',
    },
    description:
      'High cold stone: cool cast with raw-cotton snow keeping it airy.',
  },
  the_frostlace: {
    colors: {
      sky: '#B8CBE2', fog: '#DEE6EF', terrain_primary: '#CBD5E4',
      terrain_secondary: '#93A7BE', foliage_or_feature: '#EBF0F7', accent: '#B9C3E8',
    },
    description:
      'Brittle blue-violet frost: blues lifted, colour drained — lethally quiet.',
  },
  bleachlands: {
    colors: {
      sky: '#C6C3BA', fog: '#DBD7CC', terrain_primary: '#B5AFA0',
      terrain_secondary: '#948D7D', foliage_or_feature: '#A19C8E', accent: '#8C7FA0',
    },
    description:
      'The drained page: warm-dry ecru push with bleached saturation.',
  },
  dyewater_coast: {
    colors: {
      sky: '#9FBBDE', fog: '#D3DBE0', terrain_primary: '#E0CE96',
      terrain_secondary: '#C4AD72', foliage_or_feature: '#7FA050', accent: '#35509E',
    },
    description:
      'Sunlit sand and dye-bands: green-gold richness, blues pulled down.',
  },
  unfinished_hem: {
    colors: {
      sky: '#B6BCC6', fog: '#E7E4DB', terrain_primary: '#9AA285',
      terrain_secondary: '#CAC5B4', foliage_or_feature: '#ADB394', accent: '#F2C14E',
    },
    description:
      'Blank-page frontier: raw-canvas warmth, detail thinned toward sketch.',
  },
  emberwarp: {
    colors: {
      sky: '#221410', fog: '#7E2F18', terrain_primary: '#241B18',
      terrain_secondary: '#4A2B22', foliage_or_feature: '#E85B26', accent: '#FFC44E',
    },
    description:
      'Ember-warm dark: reds up, blue crushed, shadows pulled down — the ' +
      'glowing warp-lines burn hot against black ash.',
  },
  ashskein_wastes: {
    colors: {
      sky: '#241A16', fog: '#5C4A42', terrain_primary: '#6E5F57',
      terrain_secondary: '#40352F', foliage_or_feature: '#332B33', accent: '#F2A63C',
    },
    description:
      'Spent-yarn dunes: warm ash cast, gentle crush, ember-glint accents.',
  },
  tallow_vaults: {
    colors: {
      sky: '#1C1512', fog: '#3A2E24', terrain_primary: '#C9B27E',
      terrain_secondary: '#8A6F4A', foliage_or_feature: '#E6D3A0', accent: '#5A5378',
    },
    description:
      'Wax-cream cathedrals: warm tallow gain in a dark vault, blue crushed.',
  },
  cinderspindle_forges: {
    colors: {
      sky: '#16100E', fog: '#6E2C16', terrain_primary: '#2B211D',
      terrain_secondary: '#5C332A', foliage_or_feature: '#EE7A28', accent: '#FFF3C4',
    },
    description:
      'Hottest palette in the game: hard ember push, deepest shadow crush.',
  },
  the_fraying: {
    colors: {
      sky: '#131022', fog: '#2E2846', terrain_primary: '#4B3E72',
      terrain_secondary: '#7B6FA6', foliage_or_feature: '#7E9384', accent: '#8FD3DC',
    },
    description:
      'Half-unravelled islands: violet-blue gain, shadows sinking into void.',
  },
  loosened_dark: {
    colors: {
      sky: '#0A0812', fog: '#171327', terrain_primary: '#2A2344',
      terrain_secondary: '#171230', foliage_or_feature: '#5E54A0', accent: '#74E0E8',
    },
    description:
      'Genuine unspun nothing: deep violet cast, the strongest dark crush.',
  },
  last_selvage: {
    colors: {
      sky: '#201B38', fog: '#3C355C', terrain_primary: '#C6C1D6',
      terrain_secondary: '#8E87AC', foliage_or_feature: '#E4E0EE', accent: '#9FE0E4',
    },
    description:
      'The shining finished rim: pale violet gain under the darkest sky.',
  },
};

// Pre-brand names -> brand biome (same entry object, so old callers keep
// getting a valid grade and GUI swatch code sees identical data).
const ALIASES = {
  plains: 'sennmeadows',
  desert: 'bleachlands',
  tundra: 'the_frostlace',
  swamp: 'muslin_fens',
  cinder: 'emberwarp',
};

// ---------------------------------------------------------------------------
// Grade derivation (see the header for the rationale of each term).
// ---------------------------------------------------------------------------
const SWATCH_WEIGHTS = {
  sky: 1.0, fog: 1.5, terrain_primary: 1.5,
  terrain_secondary: 1.0, foliage_or_feature: 1.0, accent: 0.5,
};

function hexToRgb01(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function round4(v) {
  return Math.round(v * 1e4) / 1e4;
}

function deriveGrade(colors) {
  let wSum = 0;
  let meanSat = 0;
  const mean = [0, 0, 0];
  for (const key of Object.keys(SWATCH_WEIGHTS)) {
    const w = SWATCH_WEIGHTS[key];
    const c = hexToRgb01(colors[key]);
    const mx = Math.max(c[0], c[1], c[2]);
    const mn = Math.min(c[0], c[1], c[2]);
    meanSat += (mx > 0 ? (mx - mn) / mx : 0) * w;
    mean[0] += c[0] * w;
    mean[1] += c[1] * w;
    mean[2] += c[2] * w;
    wSum += w;
  }
  mean[0] /= wSum; mean[1] /= wSum; mean[2] /= wSum;
  meanSat /= wSum;

  // Gain: push toward the swatch's chromatic deviation from neutral grey.
  const luma = 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2];
  const gain = mean.map((m) => round4(1 + clamp(0.9 * (m - luma), -0.08, 0.08)));

  // Lift: ambience (sky+fog) brightness/tint sets the shadow floor.
  const sky = hexToRgb01(colors.sky);
  const fog = hexToRgb01(colors.fog);
  const lift = sky.map((s, i) =>
    round4(clamp((0.5 * (s + fog[i]) - 0.6) * 0.045, -0.03, 0.03)));

  // Saturation follows how dye-soaked the brand swatch is.
  const sat = round4(clamp(0.86 + 0.45 * meanSat, 0.85, 1.05));

  return { lift, gain, sat };
}

// ---------------------------------------------------------------------------
// The biome grade table (built from the brand swatches at module load — a few
// hundred arithmetic ops, once). Each entry:
//   { lift:[r,g,b], gain:[r,g,b], sat, description, brandColors }
// Alias keys reference the SAME frozen entry as their brand biome.
// ---------------------------------------------------------------------------
export const BIOMES = (() => {
  const table = {};
  for (const name of Object.keys(BRAND_BIOMES)) {
    const { colors, description } = BRAND_BIOMES[name];
    const g = deriveGrade(colors);
    table[name] = Object.freeze({
      lift: Object.freeze(g.lift),
      gain: Object.freeze(g.gain),
      sat: g.sat,
      description,
      brandColors: Object.freeze({ ...colors }),
    });
  }
  for (const alias of Object.keys(ALIASES)) table[alias] = table[ALIASES[alias]];
  return Object.freeze(table);
})();

// Neutral grade used for disabled / disposed states.
export const NEUTRAL_GRADE = Object.freeze({
  lift: Object.freeze([0, 0, 0]),
  gain: Object.freeze([1, 1, 1]),
  sat: 1.0,
});

// Prebuilt name list (list() hands out copies so callers can't mutate it).
const BIOME_NAMES = Object.freeze(Object.keys(BIOMES));

// ---------------------------------------------------------------------------
// BiomeGrading — thin controller that drives PostFX.setGrade from the table.
// Follows the effects contract (update/setEnabled/enabled/dispose); it adds
// no scene content, so there is no .object3d.
// ---------------------------------------------------------------------------
export class BiomeGrading {
  constructor(postFX) {
    this._post = postFX || null;
    this._biome = 'plains';
    this._enabled = true;
    this._apply(); // plains (sennmeadows) grade — a near-neutral meadow grade
  }

  get biome() {
    return this._biome;
  }

  get enabled() {
    return this._enabled;
  }

  // All known biome names (fresh array — safe for callers to sort/mutate).
  list() {
    return BIOME_NAMES.slice();
  }

  // Switch the active biome grade. Unknown names are rejected (returns false)
  // so a typo can never silently reset the look. The change cross-fades over
  // ~0.5 s inside PostFX.render(). While disabled, the biome is remembered
  // and applied on the next setEnabled(true).
  setBiome(name) {
    if (!Object.prototype.hasOwnProperty.call(BIOMES, name)) {
      console.warn(`BiomeGrading: unknown biome "${name}" (known: ${BIOME_NAMES.join(', ')})`);
      return false;
    }
    this._biome = name;
    this._apply();
    return true;
  }

  // Disabled => ease back to the neutral grade (biome selection is kept).
  setEnabled(on) {
    on = !!on;
    if (on === this._enabled) return;
    this._enabled = on;
    this._apply();
  }

  // Effects-contract hook. Intentionally a no-op: the smooth interpolation
  // lives inside PostFX.render(), and grades only change on setBiome /
  // setEnabled — nothing to do per frame (and nothing allocated).
  update(/* dt, ctx */) {}

  _apply() {
    const post = this._post;
    if (!post || typeof post.setGrade !== 'function') return;
    const g = this._enabled ? BIOMES[this._biome] : NEUTRAL_GRADE;
    post.setGrade({ lift: g.lift, gain: g.gain, sat: g.sat });
  }

  dispose() {
    const post = this._post;
    if (post && typeof post.setGrade === 'function') {
      post.setGrade(NEUTRAL_GRADE); // leave the chain exactly as we found it
    }
    this._post = null;
  }
}

export default BiomeGrading;
