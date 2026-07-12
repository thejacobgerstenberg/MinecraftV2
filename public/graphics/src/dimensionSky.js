// graphics-lab/src/dimensionSky.js
//
// DIMENSION SKY theming — re-skins the EXISTING DynamicSky per Loomfall
// dimension without forking it. All colour work goes through the additive
// hooks sky.js exposes (setPaletteTint / addSkyObject / domeRadius), so the
// underlying day/night/sunrise/star/moon machinery is untouched and switching
// back to 'warpwold' (or disposing) restores the natural look exactly.
//
//   warpwold   — the natural baseline + a subtle Duskwarp-violet twilight
//                tint (brand secondary), so overworld sunsets carry the
//                brand's violet undertone.
//   cinderloom — ember atmosphere: warm smoky gradient (CINDERLOOM ramp),
//                dimmer/redder sun (time-of-day aware: ~0.9x with a lighter
//                amber tint at high sun so daylight stays readable, easing
//                to the moody 0.68x ember red toward dusk/night — see
//                CINDER_DAY), a drifting DARK SMOKE cloud deck (own
//                fbm plane parented into the sky rig), faint ash-haze
//                horizon so sky.getFogColor() feeds ash-coloured fog.
//   nevermend  — pale void: desaturated icy gradient (NEVERMEND ramp),
//                boosted star brightness, and an AURORA / void-shimmer — 3
//                slowly undulating translucent ribbon curtains high in the
//                sky (vertex-waved, additive, pale cyan-green: saturated
//                cyan 165-205 deg is Nevermend's by hue oath), visible
//                mainly at night/dusk.
//
// Dimension switches CROSSFADE over ~1s: the class keeps a blended grade
// (colours + scalars) that eases from the previous dimension to the new one
// and re-installs it via sky.setPaletteTint each frame while fading.
// Allocation-free per frame (all Colors/uniform objects prebuilt).
//
// All ramp hexes come from graphics-lab/textures/palettes.js, which embeds
// the canonical brand/palette.json dimension ramps — nothing is invented.
//
// Effect contract: constructor(sky, opts) / update(dt, ctx) /
// setEnabled(bool) / get enabled / dispose(). No .object3d of its own — the
// smoke/aurora meshes are parented into the sky's camera-following visuals
// rig via sky.addSkyObject (they must ride the same infinite-skybox trick).

import * as THREE from 'three';
import { WARPWOLD, CINDERLOOM, NEVERMEND, BRAND } from '../textures/palettes.js';

const { clamp, lerp, smoothstep } = THREE.MathUtils;

// palettes.js colours are [r,g,b] 0..255 authored in sRGB; convert exactly
// like sky.js's `new THREE.Color(hex)` (sRGB -> linear working space).
const col = (a) =>
  new THREE.Color().setRGB(a[0] / 255, a[1] / 255, a[2] / 255, THREE.SRGBColorSpace);

const W = WARPWOLD.map(col);
const C = CINDERLOOM.map(col);
const N = NEVERMEND.map(col);
const VIOLET = col(BRAND.violet);
const VIOLET_LIFT = col(BRAND.violet_lift);
const WHITE = new THREE.Color(1, 1, 1);

export const DIMENSIONS = ['warpwold', 'cinderloom', 'nevermend'];

// ---------------------------------------------------------------------------
// Per-dimension grade targets. Same field set everywhere so crossfading is a
// plain field-wise lerp. Colours are lerp TARGETS; the *A amounts are how far
// the natural sky colour is pulled toward them (kept moderate so time-of-day
// and weather still read through the tint).
// ---------------------------------------------------------------------------
const GRADES = {
  warpwold: {
    horizonC: VIOLET_LIFT, horizonA: 0.05,
    zenithC: VIOLET, zenithA: 0.10,
    glowC: VIOLET_LIFT, glowA: 0.28,   // subtle violet twilight band
    sunC: WHITE, sunA: 0, sunI: 1,
    hemiC: WHITE, hemiA: 0, hemiI: 1,
    cloudLitC: WHITE, cloudShadowC: WHITE, cloudA: 0,
    starBoost: 1, smoke: 0, aurora: 0,
  },
  cinderloom: {
    horizonC: C[3].clone().lerp(C[1], 0.30), horizonA: 0.75, // ash-ember haze
    zenithC: C[1], zenithA: 0.80,
    glowC: C[5], glowA: 0.90,
    sunC: C[4], sunA: 0.80, sunI: 0.68,   // dimmer, redder sun
    hemiC: C[2], hemiA: 0.50, hemiI: 0.95,
    cloudLitC: C[2].clone().lerp(C[3], 0.35), cloudShadowC: C[0], cloudA: 0.92,
    starBoost: 0.5, smoke: 1, aurora: 0,
  },
  nevermend: {
    horizonC: N[6].clone().lerp(N[7], 0.5), horizonA: 0.45, // pale icy void
    zenithC: N[1], zenithA: 0.62,   // darker up top so the aurora pops
    glowC: N[5], glowA: 0.60,
    sunC: N[7], sunA: 0.40, sunI: 0.92,
    hemiC: N[5], hemiA: 0.30, hemiI: 1,
    cloudLitC: N[7], cloudShadowC: N[3], cloudA: 0.50,
    starBoost: 1.5, smoke: 0, aurora: 1,  // denser star feel + aurora
  },
};

// ---------------------------------------------------------------------------
// Cinderloom DAYLIGHT relief (time-of-day aware). The moody GRADES.cinderloom
// key light (0.68x sun pulled 0.80 toward C4 ember red, fill pulled 0.50
// toward near-black C2) is tuned for dusk/night; at high sun it crushed the
// day beat into black silhouettes. So while the sun is HIGH the sun/fill
// grade eases toward these lighter values (~0.9x sun, lighter amber ember
// tint, gentler fill pull) and eases back to the moody grade as the sun
// drops. The relief is zero at/below sun altitude 0.12, which keeps dawn
// (ToD 0.25, alt ~0.04), dusk (0.78) and night (0.85) bit-identical to the
// shipped look; it is fully in by altitude 0.50 (ToD ~0.31-0.69).
// ---------------------------------------------------------------------------
const CINDER_DAY = {
  sunC: C[6].clone().lerp(C[7], 0.35), // golden ember (F7A93E toward FFDF96):
                                       // the ramp's red stops have ~zero green
                                       // and starve foliage into silhouettes
  sunA: 0.45,                          // shallower pull: keep some natural sun
  sunI: 0.90,                          // ~0.9x at midday (was 0.68x all day)
  hemiC: C[6],                         // light-amber fill, same reasoning
  hemiA: 0.22,
  hemiI: 1.15,                         // gentle fill boost: shadow sides must
                                       // survive the emberwarp grade's crush
};
const CINDER_DAY_LO = 0.12; // sun altitude where the relief starts
const CINDER_DAY_HI = 0.50; // sun altitude where the relief is fully in

// Aurora colours: hemstone cyan (NEVERMEND N6) saturated into the oath band
// (cyan-green ~176 deg) for the bright lower edge, fading to hem-pale with a
// violet whisper up top.
const AURORA_EDGE = N[6].clone().offsetHSL(-0.055, 0.62, -0.13);
const AURORA_TOP = N[6].clone().lerp(N[5], 0.45); // cyan fading violet, not white

// Smoke deck colours (Cinderloom low ramp stops).
const SMOKE_LIT = C[2].clone().lerp(C[3], 0.25);
const SMOKE_SHADOW = C[0];

// ---------------------------------------------------------------------------
// Shared GLSL (same far-plane hug + value-noise fbm as sky.js — duplicated to
// keep sky.js's exports minimal).
// ---------------------------------------------------------------------------
const FAR_HUG_GLSL = /* glsl */ `
  vec4 skyProject(vec3 p) {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    clip.z = clip.w * 0.99995;
    return clip;
  }
`;

const FBM_GLSL = /* glsl */ `
  float hash21(vec2 p){
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p){
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float cc = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(cc, d, f.x), f.y);
  }
  float fbm(vec2 p){
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++){
      v += amp * vnoise(p);
      p = p * 2.02 + 7.13;
      amp *= 0.5;
    }
    return v;
  }
`;

// Grade deep-copy helpers (blend/from own their Colors; GRADES stay frozen).
function cloneGrade(g) {
  return {
    horizonC: g.horizonC.clone(), horizonA: g.horizonA,
    zenithC: g.zenithC.clone(), zenithA: g.zenithA,
    glowC: g.glowC.clone(), glowA: g.glowA,
    sunC: g.sunC.clone(), sunA: g.sunA, sunI: g.sunI,
    hemiC: g.hemiC.clone(), hemiA: g.hemiA, hemiI: g.hemiI,
    cloudLitC: g.cloudLitC.clone(), cloudShadowC: g.cloudShadowC.clone(),
    cloudA: g.cloudA,
    starBoost: g.starBoost, smoke: g.smoke, aurora: g.aurora,
  };
}

function copyGrade(dst, src) {
  dst.horizonC.copy(src.horizonC); dst.horizonA = src.horizonA;
  dst.zenithC.copy(src.zenithC); dst.zenithA = src.zenithA;
  dst.glowC.copy(src.glowC); dst.glowA = src.glowA;
  dst.sunC.copy(src.sunC); dst.sunA = src.sunA; dst.sunI = src.sunI;
  dst.hemiC.copy(src.hemiC); dst.hemiA = src.hemiA; dst.hemiI = src.hemiI;
  dst.cloudLitC.copy(src.cloudLitC); dst.cloudShadowC.copy(src.cloudShadowC);
  dst.cloudA = src.cloudA;
  dst.starBoost = src.starBoost; dst.smoke = src.smoke; dst.aurora = src.aurora;
}

function lerpGrade(dst, a, b, f) {
  dst.horizonC.copy(a.horizonC).lerp(b.horizonC, f);
  dst.horizonA = lerp(a.horizonA, b.horizonA, f);
  dst.zenithC.copy(a.zenithC).lerp(b.zenithC, f);
  dst.zenithA = lerp(a.zenithA, b.zenithA, f);
  dst.glowC.copy(a.glowC).lerp(b.glowC, f);
  dst.glowA = lerp(a.glowA, b.glowA, f);
  dst.sunC.copy(a.sunC).lerp(b.sunC, f);
  dst.sunA = lerp(a.sunA, b.sunA, f);
  dst.sunI = lerp(a.sunI, b.sunI, f);
  dst.hemiC.copy(a.hemiC).lerp(b.hemiC, f);
  dst.hemiA = lerp(a.hemiA, b.hemiA, f);
  dst.hemiI = lerp(a.hemiI, b.hemiI, f);
  dst.cloudLitC.copy(a.cloudLitC).lerp(b.cloudLitC, f);
  dst.cloudShadowC.copy(a.cloudShadowC).lerp(b.cloudShadowC, f);
  dst.cloudA = lerp(a.cloudA, b.cloudA, f);
  dst.starBoost = lerp(a.starBoost, b.starBoost, f);
  dst.smoke = lerp(a.smoke, b.smoke, f);
  dst.aurora = lerp(a.aurora, b.aurora, f);
}

export class DimensionSky {
  // sky: a DynamicSky instance (kept, never forked). fadeTime: crossfade secs.
  constructor(sky, { fadeTime = 1.0 } = {}) {
    if (!sky || typeof sky.setPaletteTint !== 'function') {
      throw new Error('DimensionSky requires a DynamicSky with setPaletteTint');
    }
    this._sky = sky;
    this._enabled = true;
    this._fadeTime = Math.max(0.05, fadeTime);
    this._dimension = 'warpwold';
    this._time = 0;
    this._disposables = [];

    // Crossfade state: _from (snapshot) -> _to (target ref), eased by _fade.
    this._from = cloneGrade(GRADES.warpwold);
    this._to = GRADES.warpwold;
    this._fade = 1;
    this._blend = cloneGrade(GRADES.warpwold);

    // Cinderloom daylight-relief weight (cinderloom blend weight x how high
    // the sun is). 0 leaves the blend grade untouched (dusk/night/dawn and
    // every other dimension); tracked so the tint is only re-installed when
    // it actually moves.
    this._cinderDay = 0;

    // The tint object handed to sky.setPaletteTint — sky-gradient colour
    // fields reference the blend's Colors permanently; sun/hemi go through
    // scratch Colors so the cinderloom daylight relief can retint them
    // per-frame without ever mutating the blend/crossfade state.
    this._tintSunC = this._blend.sunC.clone();
    this._tintHemiC = this._blend.hemiC.clone();
    this._tint = {
      horizon: this._blend.horizonC, horizonAmt: 0,
      zenith: this._blend.zenithC, zenithAmt: 0,
      glow: this._blend.glowC, glowAmt: 0,
      sun: this._tintSunC, sunAmt: 0, sunIntensity: 1,
      hemi: this._tintHemiC, hemiAmt: 0, hemiIntensity: 1,
      cloudLit: this._blend.cloudLitC, cloudShadow: this._blend.cloudShadowC,
      cloudAmt: 0,
      starBoost: 1,
    };

    const R = typeof sky.domeRadius === 'number' ? sky.domeRadius : 2000;

    // Group parented into the sky's camera-following, far-fitted visuals rig.
    this._group = new THREE.Group();
    this._group.name = 'DimensionSky';

    this._buildSmoke(R);
    this._buildAurora(R);

    sky.addSkyObject(this._group);

    // Install the (currently neutral warpwold) grade.
    this._syncTint();
    this._sky.setPaletteTint(this._tint);
  }

  // -------------------------------------------------------------------------
  // Cinderloom smoke deck: one dark fbm plane between the sky's two cloud
  // layers, drifting noticeably faster than the weather clouds.
  // -------------------------------------------------------------------------
  _buildSmoke(R) {
    const geo = new THREE.PlaneGeometry(R * 2.6, R * 2.6, 1, 1);
    this._disposables.push(geo);
    this._smokeMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        uPhase: { value: new THREE.Vector2(11.3, 4.7) },
        uOpacity: { value: 0 },
        uLit: { value: SMOKE_LIT },
        uShadow: { value: SMOKE_SHADOW },
      },
      vertexShader: /* glsl */ `
        ${FAR_HUG_GLSL}
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = skyProject(position);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec2 uPhase;
        uniform float uOpacity;
        uniform vec3 uLit;
        uniform vec3 uShadow;
        varying vec2 vUv;
        ${FBM_GLSL}
        void main() {
          vec2 uvc = vUv - 0.5;
          float edge = smoothstep(0.5, 0.18, length(uvc));
          // Two counter-scrolling octet fields = roiling, not sliding.
          float n = fbm(vUv * 6.0 + uPhase);
          float n2 = fbm(vUv * 11.0 - uPhase * 1.7 + 3.1);
          n = n * 0.72 + n2 * 0.28;
          float density = smoothstep(0.34, 0.62, n);
          vec3 colr = mix(uShadow, uLit, smoothstep(0.30, 0.85, n));
          float alpha = density * edge * uOpacity;
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(colr, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this._disposables.push(this._smokeMat);
    this._smoke = new THREE.Mesh(geo, this._smokeMat);
    this._smoke.rotation.x = -Math.PI / 2;
    this._smoke.position.y = R * 0.15; // between the deck (0.11R) and veil (0.17R)
    this._smoke.renderOrder = -986;    // with the far veil, under the low deck
    this._smoke.frustumCulled = false;
    this._smoke.visible = false;
    this._smokeWind = new THREE.Vector2(0.021, 0.008); // ~3x cloud deck speed
    this._group.add(this._smoke);
  }

  // -------------------------------------------------------------------------
  // Nevermend aurora: 3 vertical ribbon curtains, vertex-waved, additive,
  // bright cyan-green lower edge fading to pale/violet up top.
  // -------------------------------------------------------------------------
  _buildAurora(R) {
    this._ribbons = [];
    // Placed in the 25-50 degree elevation band on the -Z side (the same sky
    // band the low moon arc uses) so a horizon-framed camera catches them.
    const specs = [
      // len,     hgt,      x,        y,        z,        rotY,  amp,      base
      [R * 1.50, R * 0.24, 0, R * 0.42, -R * 0.45, 0.12, R * 0.050, 1.00],
      [R * 1.25, R * 0.17, R * 0.10, R * 0.52, -R * 0.50, -0.35, R * 0.038, 0.80],
      [R * 1.05, R * 0.14, -R * 0.15, R * 0.34, -R * 0.58, 0.55, R * 0.030, 0.65],
    ];
    for (let i = 0; i < specs.length; i++) {
      const [len, hgt, x, y, z, rotY, amp, base] = specs[i];
      const geo = new THREE.PlaneGeometry(len, hgt, 96, 6);
      this._disposables.push(geo);
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
        uniforms: {
          uTime: { value: 0 },
          uOpacity: { value: 0 },
          uAmp: { value: amp },
          uBow: { value: len * 0.10 },
          uSeed: { value: i * 2.39 },
          uColA: { value: AURORA_EDGE },
          uColB: { value: AURORA_TOP },
        },
        vertexShader: /* glsl */ `
          ${FAR_HUG_GLSL}
          uniform float uTime;
          uniform float uAmp;
          uniform float uBow;
          uniform float uSeed;
          varying vec2 vUv;
          void main() {
            vUv = uv;
            vec3 p = position;
            float x = uv.x;
            // Static bow + two slow travelling waves = undulating curtain.
            p.z += sin(x * 3.1416) * uBow;
            p.z += sin(x * 12.566 + uTime * 0.33 + uSeed) * uAmp
                 + sin(x * 23.0 - uTime * 0.19 + uSeed * 1.7) * uAmp * 0.45;
            p.y += sin(x * 9.4 + uTime * 0.46 + uSeed) * uAmp * 0.30;
            gl_Position = skyProject(p);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform float uOpacity;
          uniform float uSeed;
          uniform vec3 uColA;
          uniform vec3 uColB;
          varying vec2 vUv;
          ${FBM_GLSL}
          void main() {
            // Bright lower edge, long fade upward; soft ends.
            float vfade = smoothstep(0.0, 0.06, vUv.y) * pow(1.0 - vUv.y, 1.6);
            float xfade = smoothstep(0.0, 0.09, vUv.x)
                        * smoothstep(1.0, 0.91, vUv.x);
            // Slow curtain-shape drift + fine vertical "search-light" rays.
            float curtain = fbm(vec2(vUv.x * 7.0 + uTime * 0.030 + uSeed,
                                     vUv.y * 1.5 - uTime * 0.018));
            float rays = 0.60 + 0.40 * sin(vUv.x * 90.0 + curtain * 7.0
                                           + uTime * 0.35 + uSeed);
            // Hold the saturated cyan-green through the lower 40% so the
            // bright edge keeps its hue instead of averaging to white.
            vec3 colr = mix(uColA, uColB,
                clamp(vUv.y * 1.6 - 0.25 + (curtain - 0.5) * 0.5, 0.0, 1.0));
            float a = vfade * xfade * (0.35 + 0.65 * curtain) * rays
                    * uOpacity * 0.8;
            if (a < 0.004) discard;
            gl_FragColor = vec4(colr * 1.45, a);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      });
      this._disposables.push(mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.rotation.y = rotY;
      mesh.renderOrder = -984; // over the cloud layers, under the sun/moon
      mesh.frustumCulled = false;
      mesh.visible = false;
      this._group.add(mesh);
      this._ribbons.push({ mesh, mat, base });
    }
  }

  get dimension() {
    return this._dimension;
  }

  get enabled() {
    return this._enabled;
  }

  // 'warpwold' | 'cinderloom' | 'nevermend' — ~1s crossfade; re-selecting the
  // current dimension is a no-op; unknown names warn + no-op (returns false).
  setDimension(name) {
    if (!GRADES[name]) {
      console.warn(`DimensionSky: unknown dimension "${name}"`);
      return false;
    }
    if (name === this._dimension) return true;
    copyGrade(this._from, this._blend); // fade FROM the current mid-blend state
    this._to = GRADES[name];
    this._fade = 0;
    this._dimension = name;
    return true;
  }

  _syncTint() {
    const b = this._blend;
    const t = this._tint;
    const day = this._cinderDay; // 0 => exactly the blend grade (dusk/night)
    t.horizonAmt = b.horizonA;
    t.zenithAmt = b.zenithA;
    t.glowAmt = b.glowA;
    this._tintSunC.copy(b.sunC).lerp(CINDER_DAY.sunC, day);
    t.sunAmt = lerp(b.sunA, CINDER_DAY.sunA, day);
    t.sunIntensity = lerp(b.sunI, CINDER_DAY.sunI, day);
    this._tintHemiC.copy(b.hemiC).lerp(CINDER_DAY.hemiC, day);
    t.hemiAmt = lerp(b.hemiA, CINDER_DAY.hemiA, day);
    t.hemiIntensity = lerp(b.hemiI, CINDER_DAY.hemiI, day);
    t.cloudAmt = b.cloudA;
    t.starBoost = b.starBoost;
  }

  update(dt, ctx) {
    const d = typeof dt === 'number' && dt > 0 ? dt : 0.016;
    this._time += d;

    // Live sun altitude: gates the aurora (night) and the cinderloom
    // daylight relief (high sun).
    const a = this._sky.sunDir ? this._sky.sunDir.y : 0;

    // Crossfade toward the target dimension grade.
    let dirty = false;
    if (this._fade < 1) {
      this._fade = Math.min(1, this._fade + d / this._fadeTime);
      const f = this._fade * this._fade * (3 - 2 * this._fade); // ease
      lerpGrade(this._blend, this._from, this._to, f);
      dirty = true;
    }

    // Cinderloom daylight relief: cinderloom blend weight (the smoke field is
    // 1 only in the cinderloom grade) x how high the sun is. Re-grades only
    // when the weight actually moves, so static dusk/night frames re-install
    // nothing.
    const cinderDay =
      this._blend.smoke * smoothstep(a, CINDER_DAY_LO, CINDER_DAY_HI);
    if (Math.abs(cinderDay - this._cinderDay) > 1e-3) {
      this._cinderDay = cinderDay;
      dirty = true;
    }
    if (dirty) {
      this._syncTint();
      if (this._enabled) this._sky.setPaletteTint(this._tint); // re-grade
    }

    // Aurora visibility: mainly night/dusk (driven by the live sun altitude),
    // scaled by the nevermend blend weight.
    const night = 1 - smoothstep(a, -0.10, 0.12);
    const aur = this._enabled ? this._blend.aurora * night : 0;
    for (let i = 0; i < this._ribbons.length; i++) {
      const r = this._ribbons[i];
      const o = aur * r.base;
      r.mat.uniforms.uTime.value = this._time;
      r.mat.uniforms.uOpacity.value = o;
      r.mesh.visible = o > 0.004;
    }

    // Smoke deck drift + strength (cinderloom blend weight).
    const smoke = this._enabled ? this._blend.smoke : 0;
    this._smokeMat.uniforms.uPhase.value.addScaledVector(this._smokeWind, d);
    this._smokeMat.uniforms.uOpacity.value = smoke * 0.72;
    this._smoke.visible = smoke > 0.004;
  }

  // Toggle the theming cleanly: off = natural sky (tint removed, smoke/aurora
  // hidden); on = current dimension grade re-installed. Dimension + fade
  // state are remembered across toggles.
  setEnabled(on) {
    this._enabled = !!on;
    this._group.visible = this._enabled;
    this._sky.setPaletteTint(this._enabled ? this._tint : null);
  }

  dispose() {
    if (this._sky) {
      this._sky.setPaletteTint(null); // restore the natural sky
      if (typeof this._sky.removeSkyObject === 'function') {
        this._sky.removeSkyObject(this._group);
      }
    }
    for (const dd of this._disposables) {
      if (dd && typeof dd.dispose === 'function') dd.dispose();
    }
    this._disposables.length = 0;
    this._ribbons.length = 0;
  }
}

export default DimensionSky;
