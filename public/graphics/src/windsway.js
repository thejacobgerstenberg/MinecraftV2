// graphics-lab/src/windsway.js
//
// Foliage wind sway as a MATERIAL PATCHER — no geometry rebuild, no new meshes.
//
//   applyWindSway(material, { mode = 'leaves' } = {}) -> material
//     Hooks material.onBeforeCompile (COMPOSING with any existing hook — the
//     voxel material already injects AO there; the previous hook runs first,
//     then the sway patch is applied on top) to displace vertices in the
//     vertex stage:
//       - phase hashed from the vertex WORLD position (continuous hash, so
//         vertices shared by neighbouring leaf blocks get identical phase and
//         the alpha-cutout canopy never tears open),
//       - two summed sines at different frequencies (gusty, non-repeating feel),
//       - amplitude = uWindStrength * per-vertex mask. For mode 'leaves' every
//         vertex moves slightly and upper vertices move more via the
//         fract(worldPos.y) + 0.5 heuristic. NOTE: the voxel mesher emits cube
//         corners at integer y, where fract() == 0, so on the demo chunk the
//         mask lands at a uniform 0.5 baseline (whole-canopy sway, crack-free)
//         plus a gentle continuous with-height boost; any future geometry with
//         fractional heights (crossed-quad plants, offset meshes) automatically
//         gets the "upper fraction sways more" behaviour.
//       - max displacement ~0.08 world units at strength 1 — deliberately subtle.
//
//   WindController (+ getWindController() default singleton)
//     Owns the two shared uniforms (uWindTime, uWindStrength) that every
//     patched material links against, so update() writes exactly two numbers
//     per frame no matter how many materials sway — zero per-frame allocation.
//     update(dt, ctx) advances time and eases strength toward the ctx.weather
//     target: clear 0.35, rain 1.0, snow 0.6. setStrength(x) manually overrides
//     the weather target (setStrength(null) hands control back). setEnabled(false)
//     eases strength to 0 so the geometry glides back to rest.
//
// Interactions with the rest of the stack:
//   - AO: composes AFTER the voxel material's AO hook; the AO injection targets
//     "#include <begin_vertex>" / fragment chunks and both patches survive
//     side by side (the include marker remains in the source after each
//     replace, so ordering is stable).
//   - Shadows / fog / lighting: the material stays a MeshStandardMaterial and
//     the displacement is applied to `transformed` before project_vertex, so
//     RECEIVED shadows, fog depth and lighting all use the displaced position.
//     KNOWN LIMITATION (accepted): the shadow map is rendered with the mesh's
//     depth material, which this patch does not touch — the CAST shadow of the
//     foliage does not sway. At <= 0.08 units of travel the mismatch is
//     invisible in practice and the depth pass stays maximally cheap.
//   - Program cache: customProgramCacheKey is extended so a swayed material
//     never shares a compiled program with an unswayed one.

import * as THREE from 'three';

// -- Tuning -------------------------------------------------------------------

// Weather -> target wind strength.
const WEATHER_STRENGTH = { clear: 0.35, rain: 1.0, snow: 0.6 };
const DEFAULT_STRENGTH = WEATHER_STRENGTH.clear;

// Exponential-ease rate for strength changes (per second).
const EASE_RATE = 1.8;

// Base time advance rate; strong wind also gusts slightly faster.
const TIME_RATE_BASE = 0.9;
const TIME_RATE_PER_STRENGTH = 0.5;

// Wrap uWindTime at the common period of the two shader sine frequencies
// (1.6 and 2.73 rad/s scaled — 20*PI keeps both continuous across the wrap)
// so the float never grows unbounded over long sessions.
const TIME_WRAP = 20 * Math.PI;

// Amplitude coefficient: peak mask (1.5 * 1.25 height boost) * peak sway (1.0)
// * WS_AMP == ~0.08 world units at uWindStrength = 1.
const WS_AMP = '0.0427';

// -- GLSL ----------------------------------------------------------------------

const VERT_DECL = /* glsl */ `
uniform float uWindTime;
uniform float uWindStrength;
`;

// Per-mode vertical mask expressions (input: vec3 wsWorld).
// 'leaves': fract(y) + 0.5 heuristic (see header) plus a mild continuous
// with-height boost so higher canopy sways a touch more without tearing.
const MODE_MASK = {
  leaves: /* glsl */ `
	float wsMask = clamp( fract( wsWorld.y ) + 0.5, 0.0, 1.5 );
	wsMask *= clamp( 0.75 + wsWorld.y * 0.02, 0.75, 1.25 );
`,
};

function buildSwayChunk(mode) {
  const mask = MODE_MASK[mode] || MODE_MASK.leaves;
  // Injected right after #include <begin_vertex>: `transformed` is the
  // object-space position, still ahead of displacementmap/project_vertex, so
  // everything downstream (projection, worldPosition, shadow-receive coords,
  // fog depth) sees the swayed vertex.
  return /* glsl */ `
{
	vec4 wsW = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
	wsW = instanceMatrix * wsW;
#endif
	wsW = modelMatrix * wsW;
	vec3 wsWorld = wsW.xyz;
${mask}
	// Continuous world-position hash for the phase: identical at shared
	// vertices of adjacent blocks (no canopy cracks), decorrelated across the
	// canopy by the cheap sin() scramble.
	float wsPhase = wsWorld.x * 0.9 + wsWorld.z * 0.72 + wsWorld.y * 0.31
		+ sin( dot( wsWorld.xz, vec2( 0.734, 0.523 ) ) ) * 1.7;
	// Two summed sines at different frequencies -> gusty, non-metronomic sway.
	float wsS1 = sin( uWindTime * 1.6 + wsPhase );
	float wsS2 = sin( uWindTime * 2.73 + wsPhase * 1.37 + 1.618 );
	float wsAmp = uWindStrength * ${WS_AMP} * wsMask;
	transformed.x += ( wsS1 * 0.6 + wsS2 * 0.4 ) * wsAmp;
	transformed.z += ( wsS1 * 0.45 - wsS2 * 0.55 ) * wsAmp * 0.85;
	transformed.y += wsS2 * wsAmp * 0.12;
}
`;
}

// -- Controller -----------------------------------------------------------------

export class WindController {
  constructor() {
    // Shared uniform objects: every patched material's compiled program links
    // these exact references, so per-frame work is two scalar writes total.
    this.uniforms = {
      uWindTime: { value: 0.0 },
      uWindStrength: { value: DEFAULT_STRENGTH },
    };
    this._materials = new Set();
    this._enabled = true;
    this._manual = null; // non-null => setStrength() override wins over weather
    this._disposed = false;
  }

  // Track a patched material (applyWindSway calls this automatically). The
  // uniforms are shared singletons, so tracking is only needed for bookkeeping
  // (dispose/debug) — registering twice is a no-op.
  registerMaterial(material) {
    if (!this._disposed && material) this._materials.add(material);
    return material;
  }

  unregisterMaterial(material) {
    this._materials.delete(material);
  }

  update(dt, ctx) {
    if (this._disposed) return;
    const step = dt > 0 ? Math.min(dt, 0.1) : 0;

    // Resolve the strength target: disabled -> 0 (geometry eases to rest),
    // manual override next, else the weather table (unknown weather -> clear).
    let target = 0;
    if (this._enabled) {
      if (this._manual !== null) {
        target = this._manual;
      } else {
        const w = ctx && ctx.weather;
        target = WEATHER_STRENGTH[w] !== undefined ? WEATHER_STRENGTH[w] : DEFAULT_STRENGTH;
      }
    }

    // Exponential ease toward the target (frame-rate independent).
    const uS = this.uniforms.uWindStrength;
    uS.value += (target - uS.value) * (1 - Math.exp(-step * EASE_RATE));
    if (Math.abs(uS.value - target) < 1e-4) uS.value = target;

    // Advance time; once disabled AND settled at 0, stop advancing so the
    // geometry truly rests (and the GPU-side result is bit-stable).
    if (this._enabled || uS.value > 1e-3) {
      const uT = this.uniforms.uWindTime;
      uT.value += step * (TIME_RATE_BASE + uS.value * TIME_RATE_PER_STRENGTH);
      if (uT.value >= TIME_WRAP) uT.value -= TIME_WRAP; // sine-continuous wrap
    }
  }

  // Manual strength override (pins the target; the ease still smooths the
  // transition). Pass null/undefined to return control to ctx.weather.
  setStrength(x) {
    this._manual = x === null || x === undefined ? null : Math.max(0, Number(x) || 0);
  }

  setEnabled(on) {
    this._enabled = !!on;
  }

  get enabled() {
    return this._enabled;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._materials.clear();
    this.uniforms.uWindStrength.value = 0; // rest pose on the next frame
    if (_singleton === this) _singleton = null; // fresh getWindController() works after
  }
}

// -- Default singleton ------------------------------------------------------------

let _singleton = null;

export function getWindController() {
  if (!_singleton) _singleton = new WindController();
  return _singleton;
}

// -- Material patcher ---------------------------------------------------------------

/**
 * Patch a material (typically the leaves' voxel material) with vertex-stage
 * wind sway. Composes with any existing onBeforeCompile (previous hook runs
 * first — e.g. the voxel material's AO injection), registers the material with
 * the wind controller, and returns the same material.
 *
 * opts.mode        'leaves' (default; unknown modes fall back to it)
 * opts.controller  a specific WindController (default: getWindController())
 */
export function applyWindSway(material, { mode = 'leaves', controller = null } = {}) {
  if (!material) return material;
  if (material.userData && material.userData.windSway) return material; // idempotent

  const ctrl = controller || getWindController();
  const uniforms = ctrl.uniforms;
  const swayChunk = buildSwayChunk(mode);

  // Compose with the existing hook (THREE.Material always has one — the
  // prototype default is a no-op). Previous hook FIRST (AO etc.), sway second.
  const prevHook = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (typeof prevHook === 'function') prevHook.call(this, shader, renderer);

    // Link the controller's SHARED uniform objects into this program.
    shader.uniforms.uWindTime = uniforms.uWindTime;
    shader.uniforms.uWindStrength = uniforms.uWindStrength;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_DECL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + swayChunk);
  };

  // Extend the program cache key so a swayed material never shares a compiled
  // program with an unswayed sibling. The default Material.customProgramCacheKey
  // stringifies this.onBeforeCompile — which would now be our wrapper (whose
  // source is identical regardless of the closed-over prev hook), so the key
  // must identify the PREVIOUS hook explicitly. A user-supplied custom key is
  // respected instead when present.
  const hadOwnCacheKey =
    material.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey;
  const prevCacheKey = hadOwnCacheKey ? material.customProgramCacheKey.bind(material) : null;
  material.customProgramCacheKey = function () {
    const base = prevCacheKey
      ? prevCacheKey()
      : typeof prevHook === 'function'
        ? prevHook.toString()
        : 'none';
    return base + '|windsway:' + mode;
  };

  material.userData.windSway = { mode, uniforms };
  ctrl.registerMaterial(material);

  // Untrack on material dispose so the controller never holds dead refs.
  material.addEventListener('dispose', function onDispose() {
    material.removeEventListener('dispose', onDispose);
    ctrl.unregisterMaterial(material);
  });

  material.needsUpdate = true; // (re)compile with the sway chunk
  return material;
}

export default applyWindSway;
