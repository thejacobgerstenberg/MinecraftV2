// graphics-lab/src/biomelut.js
//
// PER-BIOME COLOUR GRADING LUT + CONTROLLER.
//
// A tiny palette of *subtle* lift/gain/saturation grades — one per biome —
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
// Value discipline (keep grades SUBTLE — the scene look is owned by the sky /
// lighting, the grade is seasoning):
//   gain  within ±0.08 of 1.0
//   lift  within ±0.03 of 0.0
//   sat   within 0.85 .. 1.05
//
// Public API:
//   BIOMES                       // { name: {lift:[r,g,b], gain:[r,g,b], sat, description} }
//   NEUTRAL_GRADE                // plains-equivalent neutral grade
//   new BiomeGrading(postFX)     // postFX: a PostFX instance (or any object
//                                //         exposing setGrade({lift,gain,sat}))
//   grading.setBiome(name)       // -> bool (false + warn on unknown name)
//   grading.biome                // getter: current biome name
//   grading.list()               // -> array of biome names
//   grading.setEnabled(bool)     // disabled => neutral grade (biome remembered)
//   grading.enabled              // getter
//   grading.update(dt, ctx)      // no-op (PostFX.render does the easing)
//   grading.dispose()            // resets the grade to neutral, drops the ref

// ---------------------------------------------------------------------------
// The biome grade table. Each entry: { lift:[r,g,b], gain:[r,g,b], sat,
// description }. All values deliberately inside the subtlety envelope above.
// ---------------------------------------------------------------------------
export const BIOMES = Object.freeze({
  plains: Object.freeze({
    lift: Object.freeze([0, 0, 0]),
    gain: Object.freeze([1, 1, 1]),
    sat: 1.0,
    description:
      'Neutral baseline — the ungraded PostFX image, byte-for-byte.',
  }),
  desert: Object.freeze({
    lift: Object.freeze([0.014, 0.009, 0.003]),
    gain: Object.freeze([1.055, 1.015, 0.955]),
    sat: 0.95,
    description:
      'Warm and dry: reds pushed up, blues pulled down, a tiny sandy lift ' +
      'in the shadows and slightly bleached saturation — sun-baked haze.',
  }),
  tundra: Object.freeze({
    lift: Object.freeze([0, 0, 0]),
    gain: Object.freeze([0.965, 0.995, 1.06]),
    sat: 0.85,
    description:
      'Cool and desaturated: blues lifted, reds eased off, colour drained ' +
      'toward grey — thin arctic light over snowfields.',
  }),
  swamp: Object.freeze({
    lift: Object.freeze([0.007, 0.013, 0.005]),
    gain: Object.freeze([0.97, 1.055, 0.955]),
    sat: 0.9,
    description:
      'Green-tinted and moody: green gain up, red/blue down, a slight murky ' +
      'lift so shadows never go pure black — stagnant, humid air.',
  }),
  cinder: Object.freeze({
    lift: Object.freeze([-0.016, -0.022, -0.028]),
    gain: Object.freeze([1.06, 1.02, 0.945]),
    sat: 1.02,
    description:
      'Ember-warm dark: red/green gain up with blue crushed, shadows pulled ' +
      'down (deepest in blue) so embers and torches burn hot against the dark.',
  }),
});

// Neutral grade used for disabled / disposed states (identical to plains).
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
    this._apply(); // plains == neutral, so this is a no-op visually
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
