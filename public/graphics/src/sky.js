// graphics-lab/src/sky.js
//
// DYNAMIC SKY effect module.
//
// Provides a full day/night sky for the voxel demo:
//   - an inward-facing sky DOME with a time-of-day gradient (horizon -> zenith),
//     a sun-side warm twilight band, and a VISIBLE sun disc + soft halo and a
//     moon halo baked into the shader,
//   - a THREE.Points STAR field (additive, 1.5-3 px, subtle twinkle) that ramps
//     to ~0.9 opacity when the sun is well below the horizon,
//   - a procedural SUN sprite (soft radial glow, grows warm + large at the
//     horizon) and a pale cratered MOON sprite opposite-ish the sun,
//   - soft drifting fbm CLOUDS on TWO stacked horizontal planes (a low deck +
//     a higher, larger, slower veil drifting the opposite way for parallax),
//     tinted by the sun colour (white day / pink-orange twilight / faintly lit
//     night) and weather-reactive (clear = sparse white, rain = thicker/darker/
//     faster, snow = pale dense). setCloudiness(0..1) overrides coverage,
//   - a key DirectionalLight (this.sun) + HemisphereLight fill (this.hemi).
//     Night is NEVER pitch black: cool blue moonlight (~0.21-0.28) plus a hemi
//     floor keep terrain faintly readable.
//
// Robustness: all sky visuals are camera-centred and FAR-PLANE PROOF. The
// dome / stars / clouds hug the far plane in clip space (z = w * k) so they can
// never be frustum-culled away, and the whole visuals group additionally
// rescales to fit inside camera.far so the sun/moon sprites survive short far
// planes too. (A clipped dome is exactly how a sky turns into a flat colour
// fill in screenshots.)
//
// getFogColor() always returns the CURRENT true horizon colour (light
// blue-grey by day, warm orange at sunrise/sunset, very dark navy at night) so
// the fog module can match the sky seamlessly. Pass an optional target Color
// to avoid the per-call allocation.
//
// ADDITIVE dimension-theming hooks (used by dimensionSky.js — all optional,
// no-ops when unused, so the baseline demo look is unchanged):
//   setPaletteTint(tint|null)  re-gradeable colour tint applied LAST in
//                              setTimeOfDay (fields documented on the method);
//                              getFogColor() reflects the tinted horizon.
//   setCloudiness(v|null)      0..1 manual cloud-cover override (null = auto).
//   addSkyObject(obj) / removeSkyObject(obj)   parent custom meshes (auroras,
//                              smoke decks) into the camera-following,
//                              far-plane-fitted visuals rig.
//   get domeRadius             sizing reference for such custom meshes.
//
// Follows the graphics-lab effect contract:
//   constructor(renderer, opts) / update(dt, ctx) / setEnabled(bool) /
//   get enabled() / dispose() and exposes .object3d.
//
// Everything is allocation-free per frame (scratch objects are reused) and the
// shaders are kept lean for software-WebGL 60fps at 'medium'.

import * as THREE from 'three';

const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;
const { clamp, smoothstep, lerp } = THREE.MathUtils;

// ---------------------------------------------------------------------------
// Anchor colours. Authored as sRGB hex; THREE (colour-managed) converts them to
// the linear working space, so all shader maths below is linear and the final
// fragments run through <colorspace_fragment> to match the Lambert geometry.
// ---------------------------------------------------------------------------
const c = (hex) => new THREE.Color(hex);

const DAY_ZENITH    = c(0x1d68e6); // rich saturated sky blue straight up
const DAY_HORIZON   = c(0xb4d0ec); // light blue-grey at the horizon (fog match)
const DUSK_ZENITH   = c(0x2e4f9e); // twilight zenith stays BLUISH, never orange
const DUSK_HORIZON  = c(0xff7a30); // warm orange band at the horizon
const DUSK_GLOW     = c(0xff8c3a); // extra sun-side horizon glow band
const NIGHT_ZENITH  = c(0x090f24); // deep navy, NOT black
const NIGHT_HORIZON = c(0x16234a); // dark navy horizon (night fog colour)

const SUN_GLOW_WARM = c(0xffb25e); // dome/sprite sun tint near horizon
const SUN_GLOW_NOON = c(0xfff6e4); // dome/sprite sun tint high in the sky
const MOON_GLOW     = c(0xb8c6e6); // cool moon halo

const SUN_LIGHT_WARM = c(0xff9a45); // directional light at sunrise/sunset
const SUN_LIGHT_NOON = c(0xfff4e6); // directional light at noon
const MOON_LIGHT     = c(0x93a7d8); // cool blue moonlight (never black)

const HEMI_GROUND    = c(0x3a2f22); // warm bounce fill from the ground
const HEMI_NIGHT_SKY = c(0x33415f); // hemi sky colour floor at night (readable)

const CLOUD_LIT_DAY      = c(0xffffff);
const CLOUD_SHADOW_DAY   = c(0x9fb0c4);
const CLOUD_LIT_DUSK     = c(0xffc09a); // pink-orange sunrise clouds
const CLOUD_SHADOW_DUSK  = c(0x8a5f74);
const CLOUD_LIT_NIGHT    = c(0x39456b); // faintly moonlit
const CLOUD_SHADOW_NIGHT = c(0x1c2440);

// Overcast (rain/snow) grade targets. Scaled by day amount before use so a
// rainy NIGHT stays dark instead of lightening toward these day-grey values.
const RAIN_HORIZON      = c(0x8f98a2); // desaturated grey horizon
const RAIN_ZENITH       = c(0x49525c); // darker grey zenith
const RAIN_CLOUD_LIT    = c(0x99a3ae);
const RAIN_CLOUD_SHADOW = c(0x4c565f);
const RAIN_HEMI         = c(0x9aa4af);

// ---------------------------------------------------------------------------
// Small deterministic PRNG so the star field is stable across reloads.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Procedural sprite textures. Minecraft-style SQUARE sun and moon quads (a
// crisp square core carries the disc; a soft radial gradient stays underneath
// purely as the glow/bloom feed — round discs read as generic, not Minecraft).
// ---------------------------------------------------------------------------
function makeSunTexture() {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  // Soft radial glow (kept for the bloom halo; core alpha is low so the
  // square silhouette below stays crisp).
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgba(255,244,214,0.55)');
  g.addColorStop(0.30, 'rgba(255,224,160,0.28)');
  g.addColorStop(0.60, 'rgba(255,196,124,0.10)');
  g.addColorStop(1.0, 'rgba(255,170,100,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  // Square white-yellow sun: warm rim quad + bright core quad.
  const half = s / 2;
  const q = Math.round(s * 0.19); // core half-side (~24px)
  const rim = 5;
  ctx.fillStyle = 'rgba(255,208,120,0.92)';
  ctx.fillRect(half - q - rim, half - q - rim, (q + rim) * 2, (q + rim) * 2);
  ctx.fillStyle = 'rgba(255,250,224,1.0)';
  ctx.fillRect(half - q, half - q, q * 2, q * 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeMoonTexture() {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  // Faint, tight outer glow only — the old broad 0.40-alpha gradient fed the
  // bloom pass a huge halo that swallowed the square disc (it read as a
  // rounded blob). The crisp square quad below is the moon.
  const glow = ctx.createRadialGradient(s / 2, s / 2, s * 0.26, s / 2, s / 2, s * 0.44);
  glow.addColorStop(0.0, 'rgba(214,226,248,0.14)');
  glow.addColorStop(0.6, 'rgba(210,222,245,0.04)');
  glow.addColorStop(1.0, 'rgba(210,222,245,0.0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, s, s);
  // Square pale moon quad with a few darker pixel-block "maria".
  const half = s / 2;
  const q = Math.round(s * 0.21); // half-side (~27px) — bigger crisp square
  ctx.fillStyle = 'rgba(228,236,250,1.0)';
  ctx.fillRect(half - q, half - q, q * 2, q * 2);
  ctx.fillStyle = 'rgba(198,210,234,1.0)';
  const px = Math.round(q * 0.55); // chunky pixel blocks
  ctx.fillRect(half - q + 3, half - q + 3, px, px);              // top-left
  ctx.fillRect(half + q - px - 4, half - 2, px, px);             // mid-right
  ctx.fillRect(half - px + 2, half + q - px - 3, px, px - 3);    // bottom
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Shared GLSL.
// ---------------------------------------------------------------------------
// Clip-space far-plane hug: the vertex lands just inside the far plane no
// matter how big the sky geometry is, so a short camera.far can never clip the
// dome/stars/clouds into a flat void. Depth is irrelevant (depthTest false).
const FAR_HUG_GLSL = /* glsl */ `
  vec4 skyProject(vec3 p) {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    clip.z = clip.w * 0.99995;
    return clip;
  }
`;

// Cheap value-noise fbm for the clouds.
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

export class DynamicSky {
  constructor(renderer, { size = 4000, stars = 2200 } = {}) {
    this._renderer = renderer || null;
    this._enabled = true;
    this._timeOfDay = 0.3;
    this._weather = 'clear'; // 'clear' | 'rain' | 'snow' (storm mood grade)
    this._elapsed = 0;
    this._disposables = [];
    this._cloudiness = null;  // setCloudiness override (null = weather-driven)
    this._paletteTint = null; // setPaletteTint grade (null = natural)
    this._windMul = 1;        // weather wind-speed multiplier (rain = faster)

    const domeRadius = size * 0.5;
    const starRadius = domeRadius * 0.92;
    const spriteR = domeRadius * 0.82;
    const cloudHeight = size * 0.055;
    const cloudSize = size * 1.1;
    this._domeRadius = domeRadius;
    this._spriteR = spriteR;
    this._sunScaleBase = domeRadius * 0.13;
    this._moonScaleBase = domeRadius * 0.085; // slightly tighter than the sun
    // (the old 0.10 sprite + broad baked glow bloomed into an oversized halo)
    this._lightDist = 120;
    this._lastFar = -1;

    // Direction vectors (owned by this module; shared into uniforms by
    // reference so mutating them updates the shaders for free). sunDir points
    // *toward* the sun; moonDir is opposite-ish (mirrored + slight tilt).
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.moonDir = new THREE.Vector3(0, -1, 0);
    this._sunDirFlat = new THREE.Vector3(1, 0, 0);
    this._keyDir = new THREE.Vector3();

    // Reused scratch colours (no per-call allocation in setTimeOfDay).
    this._horizonColor = new THREE.Color();
    this._zenithColor = new THREE.Color();
    this._sunGlowColor = new THREE.Color();
    this._sunLightColor = new THREE.Color();
    this._cloudLit = new THREE.Color();
    this._cloudShadow = new THREE.Color();
    this._scratchColor = new THREE.Color();
    this._scratch2 = new THREE.Color();

    // -----------------------------------------------------------------------
    // Root group. `object3d` is added to the scene once and never moved; the
    // visual sky lives in a child group that follows the camera each frame so
    // the dome behaves like an infinite skybox. The lights are siblings of that
    // sub-group (world space) so toggling the visuals never disables lighting.
    // -----------------------------------------------------------------------
    this.object3d = new THREE.Group();
    this.object3d.name = 'DynamicSky';
    this._visuals = new THREE.Group();
    this._visuals.name = 'DynamicSky.visuals';
    this.object3d.add(this._visuals);

    // -----------------------------------------------------------------------
    // Sky dome: vertical gradient + sun-side twilight band + sun disc/halo +
    // moon halo, all in one lean shader.
    // -----------------------------------------------------------------------
    const domeGeo = new THREE.SphereGeometry(domeRadius, 32, 16);
    this._disposables.push(domeGeo);
    this._domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uHorizonColor: { value: this._horizonColor },
        uZenithColor: { value: this._zenithColor },
        uGlowColor: { value: DUSK_GLOW.clone() },
        uGlowStrength: { value: 0 },
        uSunDir: { value: this.sunDir },
        uSunDirFlat: { value: this._sunDirFlat },
        uMoonDir: { value: this.moonDir },
        uSunColor: { value: this._sunGlowColor },
        uMoonColor: { value: MOON_GLOW.clone() },
        uSunGlow: { value: 0 },
        uMoonGlow: { value: 0 },
        uSunDiscCos: { value: Math.cos(3 * DEG) },
        uSunDiscSoft: { value: 0.0012 },
        uSunDiscIntensity: { value: 0 },
        uGradPow: { value: 0.40 },
      },
      vertexShader: /* glsl */ `
        ${FAR_HUG_GLSL}
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = skyProject(position);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uHorizonColor;
        uniform vec3 uZenithColor;
        uniform vec3 uGlowColor;
        uniform float uGlowStrength;
        uniform vec3 uSunDir;
        uniform vec3 uSunDirFlat;
        uniform vec3 uMoonDir;
        uniform vec3 uSunColor;
        uniform vec3 uMoonColor;
        uniform float uSunGlow;
        uniform float uMoonGlow;
        uniform float uSunDiscCos;
        uniform float uSunDiscSoft;
        uniform float uSunDiscIntensity;
        uniform float uGradPow;
        varying vec3 vDir;
        void main() {
          vec3 dir = normalize(vDir);
          float up = clamp(dir.y, 0.0, 1.0);

          // Base vertical gradient: horizon colour low, zenith colour high.
          // uGradPow steepens at twilight so the zenith stays dark/blue while
          // only the horizon band burns warm.
          vec3 col = mix(uHorizonColor, uZenithColor, pow(up, uGradPow));

          // Twilight band: warm glow hugging the horizon, strongest toward
          // the sun's azimuth so the opposite sky stays bluish (never a flat
          // orange fill).
          float sunSide = 0.55 + 0.45 * dot(dir, uSunDirFlat);
          col = mix(col, uGlowColor, uGlowStrength * pow(1.0 - up, 3.0) * sunSide);

          // Sun: bright soft-edged disc + a TIGHT warm halo (a broad pow2/pow8
          // halo used to wash the whole sun-side sky — incl. the zenith —
          // warm at sunrise).
          float sd = dot(dir, uSunDir);
          float sdp = max(sd, 0.0);
          float halo = pow(sdp, 14.0) * 0.55 + pow(sdp, 3.0) * 0.05;
          float disc = smoothstep(uSunDiscCos - uSunDiscSoft,
                                  uSunDiscCos + uSunDiscSoft * 0.5, sd);
          col += uSunColor * (halo * uSunGlow + disc * uSunDiscIntensity);

          // Moon: tighter, cooler, subtler glow (the sprite draws the disc).
          float md = max(dot(dir, uMoonDir), 0.0);
          float mHalo = pow(md, 24.0) * 0.45 + pow(md, 6.0) * 0.05;
          col += uMoonColor * mHalo * uMoonGlow;

          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this._disposables.push(this._domeMat);
    this._dome = new THREE.Mesh(domeGeo, this._domeMat);
    this._dome.renderOrder = -1000;
    this._dome.frustumCulled = false;
    this._visuals.add(this._dome);

    // -----------------------------------------------------------------------
    // Stars: guaranteed 1.5-3 px points, additive, twinkle in brightness (not
    // size, so no star ever shrinks below visibility).
    // -----------------------------------------------------------------------
    const rng = mulberry32(0x5eed);
    const starPos = new Float32Array(stars * 3);
    const starSize = new Float32Array(stars);
    const starPhase = new Float32Array(stars);
    for (let i = 0; i < stars; i++) {
      // Bias toward the upper hemisphere so most stars sit above the horizon.
      let y = rng() * 1.12 - 0.12;
      y = Math.max(-1, Math.min(1, y));
      const theta = rng() * TWO_PI;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      starPos[i * 3 + 0] = Math.cos(theta) * r * starRadius;
      starPos[i * 3 + 1] = y * starRadius;
      starPos[i * 3 + 2] = Math.sin(theta) * r * starRadius;
      starSize[i] = 2.5 + rng() * 1.8; // 2.5 .. 4.3 px — survives FXAA + tonemap
      starPhase[i] = rng();
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(starSize, 1));
    starGeo.setAttribute('aPhase', new THREE.BufferAttribute(starPhase, 1));
    this._disposables.push(starGeo);
    this._starMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // depthTest ON: stars hug the far plane (depth ~1.0) so open sky shows
      // them, while terrain (nearer depth) correctly occludes — with
      // depthTest:false stars would paint OVER the island silhouette.
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uStarBoost: { value: 1 }, // brightness multiplier (dimension theming)
        uPixelRatio: { value: renderer ? renderer.getPixelRatio() : 1 },
      },
      vertexShader: /* glsl */ `
        ${FAR_HUG_GLSL}
        attribute float aSize;
        attribute float aPhase;
        uniform float uTime;
        uniform float uPixelRatio;
        varying float vTw;
        void main() {
          gl_Position = skyProject(position);
          // Subtle twinkle: brightness only; size stays fully visible.
          vTw = 0.72 + 0.28 * sin(uTime * 2.4 + aPhase * 6.2831853);
          gl_PointSize = aSize * uPixelRatio;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        uniform float uStarBoost;
        varying float vTw;
        void main() {
          vec2 pc = gl_PointCoord - 0.5;
          float d = length(pc);
          float a = smoothstep(0.5, 0.08, d);
          vec3 col = vec3(0.97, 0.98, 1.0) * 1.4 * uStarBoost; // near-white HDR pop
          gl_FragColor = vec4(col, a * uOpacity * vTw);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this._disposables.push(this._starMat);
    this._stars = new THREE.Points(starGeo, this._starMat);
    this._stars.renderOrder = -995;
    this._stars.frustumCulled = false;
    this._visuals.add(this._stars);

    // -----------------------------------------------------------------------
    // Sun + moon sprites (glow layers over the dome's disc/halo).
    // -----------------------------------------------------------------------
    this._sunTex = makeSunTexture();
    this._moonTex = makeMoonTexture();
    this._disposables.push(this._sunTex, this._moonTex);

    this._sunSpriteMat = new THREE.SpriteMaterial({
      map: this._sunTex,
      color: SUN_GLOW_NOON.clone(),
      transparent: true,
      depthWrite: false,
      depthTest: true, // terrain must occlude the sun, not vice versa
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this._disposables.push(this._sunSpriteMat);
    this._sunSprite = new THREE.Sprite(this._sunSpriteMat);
    this._sunSprite.scale.set(this._sunScaleBase, this._sunScaleBase, 1);
    // Sprites draw AFTER the cloud plane (-985) so the sun/moon discs stay
    // crisp instead of being hazed out by the cloud alpha; terrain still
    // occludes them via depthTest.
    this._sunSprite.renderOrder = -980;
    this._sunSprite.frustumCulled = false;
    this._visuals.add(this._sunSprite);

    this._moonSpriteMat = new THREE.SpriteMaterial({
      map: this._moonTex,
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      depthTest: true, // terrain must occlude the moon, not vice versa
      fog: false,
    });
    this._disposables.push(this._moonSpriteMat);
    this._moonSprite = new THREE.Sprite(this._moonSpriteMat);
    this._moonSprite.scale.set(this._moonScaleBase, this._moonScaleBase, 1);
    this._moonSprite.renderOrder = -980; // after clouds — see sun sprite note
    this._moonSprite.frustumCulled = false;
    this._visuals.add(this._moonSprite);

    // -----------------------------------------------------------------------
    // Clouds: TWO stacked horizontal fbm planes for a parallax feel.
    //   layer 0 — the original low deck (same freq/coverage/opacity/drift as
    //             the single-layer version, so the baseline look is preserved),
    //   layer 1 — a higher, larger, lower-frequency veil drifting the OPPOSITE
    //             way at a different speed (counter-drift = obvious parallax).
    // Wind phase is integrated on the CPU (phase += wind * windMul * dt) so
    // weather speed changes (rain blows the deck along faster) never cause a
    // pattern jump the way rescaling uTime would.
    // -----------------------------------------------------------------------
    this._cloudLayers = [];
    const makeCloudLayer = (planeSize, height, freq, windX, windY,
                            baseCoverage, baseOpacity, order, seedOfs) => {
      const geo = new THREE.PlaneGeometry(planeSize, planeSize, 1, 1);
      this._disposables.push(geo);
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true, // far-hugged: sky shows clouds, terrain occludes them
        side: THREE.DoubleSide,
        fog: false,
        uniforms: {
          uPhase: { value: new THREE.Vector2(seedOfs, seedOfs * 0.37) },
          uFreq: { value: freq },
          uCloudLit: { value: this._cloudLit },
          uCloudShadow: { value: this._cloudShadow },
          uCoverage: { value: baseCoverage },
          uOpacity: { value: baseOpacity },
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
          uniform float uFreq;
          uniform vec3 uCloudLit;
          uniform vec3 uCloudShadow;
          uniform float uCoverage;
          uniform float uOpacity;
          varying vec2 vUv;
          ${FBM_GLSL}
          void main() {
            vec2 uvc = vUv - 0.5;
            float edge = smoothstep(0.5, 0.20, length(uvc));
            // Noise frequency x8 (deck) so several distinct puffs sit in the
            // visible sky band above the island instead of one faint smear;
            // the high veil runs at x5 for larger, softer shapes.
            vec2 p = vUv * uFreq + uPhase;
            float n = fbm(p);
            float density = smoothstep(uCoverage, uCoverage + 0.16, n);
            float shade = smoothstep(0.25, 0.85, n);
            vec3 col = mix(uCloudShadow, uCloudLit, shade);
            float alpha = density * edge * uOpacity;
            if (alpha < 0.003) discard;
            gl_FragColor = vec4(col, alpha);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      });
      this._disposables.push(mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = height;
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      this._visuals.add(mesh);
      this._cloudLayers.push({
        mesh, mat,
        baseWind: new THREE.Vector2(windX, windY),
        baseCoverage, baseOpacity,
      });
      return mat;
    };
    // Layer 0: the classic low deck (identical parameters to the old single
    // plane). Layer 1: higher/larger veil, ~35% opacity weight, counter-drift.
    // The veil draws FIRST (-986) so the nearer deck blends over it.
    this._cloudMat = makeCloudLayer(
      cloudSize, cloudHeight, 8.0, 0.007, 0.0026, 0.46, 0.94, -985, 0);
    makeCloudLayer(
      size * 1.35, size * 0.085, 5.0, -0.0045, -0.0016, 0.55, 0.42, -986, 3.7);
    this._clouds = this._cloudLayers[0].mesh;

    // -----------------------------------------------------------------------
    // Lights (world space; NOT children of _visuals, so setEnabled(false) only
    // hides the dome/stars/clouds and never kills the lighting).
    // -----------------------------------------------------------------------
    this.sun = new THREE.DirectionalLight(0xffffff, 1.0);
    this.sun.position.set(0, this._lightDist, 0);
    this.sun.target.position.set(0, 0, 0);
    this.object3d.add(this.sun);
    this.object3d.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbfd8ff, HEMI_GROUND.clone(), 0.6);
    this.object3d.add(this.hemi);

    // Initialise all time-of-day-driven state.
    this.setTimeOfDay(this._timeOfDay);
  }

  get enabled() {
    return this._enabled;
  }

  // True horizon colour for the current time of day, so the fog module can
  // tint to the sky and hide distance pop-in: light blue-grey by day, warm
  // orange at sunrise/sunset, very dark navy at night.
  // Pass a THREE.Color `target` to avoid allocating; without one a fresh
  // Color is returned (backward compatible).
  getFogColor(target) {
    if (target && target.isColor) return target.copy(this._horizonColor);
    return this._horizonColor.clone();
  }

  // Weather grade: 'rain' (and, lighter, 'snow') desaturates the sky toward
  // storm grey, dims the sun light ~45%, flattens the twilight band and hides
  // sun disc/stars behind the overcast. Fog follows automatically because
  // getFogColor() returns the graded horizon colour.
  setWeather(w) {
    const mode = (w === 'rain' || w === 'snow') ? w : 'clear';
    if (mode === this._weather) return;
    this._weather = mode;
    this.setTimeOfDay(this._timeOfDay); // re-grade every colour/intensity
  }

  get weather() {
    return this._weather;
  }

  // t in [0,1): 0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset.
  // Recomputes sun/moon directions, sky/sun/moon/cloud colours, light rig, and
  // the star/sun/moon opacities.
  setTimeOfDay(t) {
    this._timeOfDay = t;

    // ---- Sun direction: rises in the east (+X), arcs through a slightly
    // tilted zenith, sets in the west (-X). theta=0 at sunrise, PI/2 at noon.
    // A small +y bias floats the disc just above the horizon at t=0.25/0.75 so
    // the rising/setting sun is actually visible (and the shadow rig never has
    // to cope with a perfectly horizontal light).
    const theta = (t - 0.25) * TWO_PI;
    const sinTheta = Math.sin(theta);
    this.sunDir.set(Math.cos(theta), sinTheta + 0.045, 0.2).normalize();
    // Moon: opposite azimuth, but on a deliberately LOW arc (~6-17 deg) on the
    // -Z side so the default 'hero' framing catches it through the whole
    // 0.8-0.9 night window instead of it sailing out over the frame top.
    this.moonDir.set(
      -this.sunDir.x,
      0.05 + 0.18 * Math.max(0, -sinTheta),
      -0.35,
    ).normalize();
    // Horizontal sun direction for the shader's sun-side twilight band.
    this._sunDirFlat.set(this.sunDir.x, 0, this.sunDir.z);
    if (this._sunDirFlat.lengthSq() < 1e-6) this._sunDirFlat.set(1, 0, 0);
    else this._sunDirFlat.normalize();

    const a = this.sunDir.y; // sun altitude, -1..1

    // ---- Blend weights.
    const dayAmt = smoothstep(a, -0.08, 0.25); // 0 night -> 1 day
    let tw = clamp(1 - Math.abs(a) / 0.33, 0, 1); // twilight bell at the horizon
    tw = tw * tw * (3 - 2 * tw);

    // ---- Sky gradient. The horizon warms up at twilight while the zenith
    // stays bluish, so sunrise/sunset reads as a vertical gradient, never a
    // flat orange fill.
    this._horizonColor.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, dayAmt);
    this._horizonColor.lerp(DUSK_HORIZON, tw * 0.75);
    this._zenithColor.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, dayAmt);
    this._zenithColor.lerp(DUSK_ZENITH, tw * 0.4);
    this._domeMat.uniforms.uGlowStrength.value = tw * 0.85;
    // Day baseline 0.40 pulls the rich zenith blue well down toward the
    // horizon (the old 0.55 left the upper sky a featureless pale haze);
    // steeper still at twilight so the warm band hugs the horizon.
    this._domeMat.uniforms.uGradPow.value = lerp(0.40, 0.34, tw);

    // ---- Sun glow (dome shader). The dome's ROUND disc is disabled (kept in
    // the shader for API stability): the sun disc is now the Minecraft-style
    // SQUARE sprite quad; a round dome disc behind it would spoil the square
    // silhouette. The tight dome halo still carries the horizon glow.
    const sunHi = smoothstep(a, 0.05, 0.45); // 0 at horizon -> 1 high sun
    this._sunGlowColor.copy(SUN_GLOW_WARM).lerp(SUN_GLOW_NOON, sunHi);
    this._domeMat.uniforms.uSunGlow.value = Math.max(dayAmt * 0.85, tw);
    const discAng = lerp(4.4, 2.4, sunHi) * DEG;
    this._domeMat.uniforms.uSunDiscCos.value = Math.cos(discAng);
    this._domeMat.uniforms.uSunDiscSoft.value = lerp(0.0018, 0.0008, sunHi);
    this._domeMat.uniforms.uSunDiscIntensity.value = 0.0;

    // ---- Moon glow (dome).
    const nightF = 1 - dayAmt;
    const moonUp = smoothstep(this.moonDir.y, -0.05, 0.2);
    this._domeMat.uniforms.uMoonGlow.value = nightF * moonUp * 0.55;

    // ---- Star opacity: full 1.0 once the sun is well below the horizon so
    // 2.5-4px stars survive bloom averaging + ACES at 1600x900.
    this._starMat.uniforms.uOpacity.value =
      1.0 * (1 - smoothstep(a, -0.18, -0.02));

    // ---- Sun sprite: warm + oversized at the horizon, tighter at noon.
    this._sunSprite.position.copy(this.sunDir).multiplyScalar(this._spriteR);
    this._sunSpriteMat.color.copy(this._sunGlowColor);
    this._sunSpriteMat.opacity = smoothstep(a, -0.08, 0.0);
    const ss = this._sunScaleBase * (1 + 0.7 * (1 - sunHi));
    this._sunSprite.scale.set(ss, ss, 1);
    this._sunSprite.visible = this._sunSpriteMat.opacity > 0.001;

    // ---- Moon sprite (up at night on its low -Z arc). Scaled by nightF with
    // NO daytime floor: the old 0.12 floor left a faint pale disc hanging in
    // the day sky (it read as a phantom second sun / bloom ghost in shots).
    this._moonSprite.position.copy(this.moonDir).multiplyScalar(this._spriteR);
    this._moonSpriteMat.opacity =
      smoothstep(this.moonDir.y, -0.03, 0.06) * nightF;
    this._moonSprite.visible = this._moonSpriteMat.opacity > 0.001;

    // ---- Cloud colours (sun-tinted; both layers share these Color refs).
    // Coverage/opacity for the two layers is applied in _applyCloudState().
    this._cloudLit.copy(CLOUD_LIT_NIGHT).lerp(CLOUD_LIT_DAY, dayAmt);
    this._cloudLit.lerp(CLOUD_LIT_DUSK, tw * 0.75);
    this._cloudShadow.copy(CLOUD_SHADOW_NIGHT).lerp(CLOUD_SHADOW_DAY, dayAmt);
    this._cloudShadow.lerp(CLOUD_SHADOW_DUSK, tw * 0.6);

    // ---- Directional key light: sun while it is up, moon (opposite, high at
    // midnight) while it is down. Warm-low, white-noon; at night a cool blue
    // ~0.14-0.20 moonlight — never pitch black.
    if (a >= 0.0) {
      this._keyDir.copy(this.sunDir);
      this._sunLightColor.copy(SUN_LIGHT_WARM)
        .lerp(SUN_LIGHT_NOON, smoothstep(a, 0.02, 0.42));
      this.sun.color.copy(this._sunLightColor);
      // Golden-hour boost: at sunrise/sunset the altitude term is ~0, which
      // used to leave the terrain a black silhouette. The +tw term keeps a
      // strong warm key light (=> long readable shadows) through twilight.
      this.sun.intensity = 0.15 + 1.15 * smoothstep(a, 0.0, 0.42) + 0.85 * tw;
    } else {
      this._keyDir.copy(this.moonDir);
      this.sun.color.copy(MOON_LIGHT);
      // Slightly stronger moonlight (was 0.14 base): night terrain and tree
      // canopies keep readable form instead of crushing to pure black.
      this.sun.intensity = 0.21 + 0.07 * clamp(this.moonDir.y, 0, 1);
    }
    this.sun.position.copy(this._keyDir).multiplyScalar(this._lightDist);

    // ---- Hemisphere fill. The night floor uses a NON-dark sky colour (a
    // near-black hemi colour would contribute nothing and leave terrain a
    // silhouette) and a minimum intensity so night terrain stays readable.
    this._scratchColor.copy(this._horizonColor).lerp(this._zenithColor, 0.35);
    this.hemi.color.copy(HEMI_NIGHT_SKY).lerp(this._scratchColor, dayAmt);
    // The +tw golden-hour lift keeps sunrise/sunset terrain readable instead
    // of a pure backlit silhouette. Night floor raised 0.25 -> 0.33 (foliage
    // and foreground terrain used to crush to pure black); day total ~0.85
    // unchanged.
    this.hemi.intensity = 0.33 + 0.52 * dayAmt + 0.8 * tw;

    // ---- Overcast weather grade (rain full, snow lighter). Applied LAST so
    // it re-grades the clear-sky values above; every value is recomputed from
    // scratch on each call, so switching back to 'clear' fully restores.
    const wf = this._weather === 'rain' ? 1 : (this._weather === 'snow' ? 0.55 : 0);
    if (wf > 0) {
      // Grey the sky. Grade targets are scaled by dayAmt so rainy nights stay
      // dark navy-grey instead of jumping to a luminous day-grey.
      const greyScale = 0.16 + 0.84 * dayAmt;
      this._scratch2.copy(RAIN_HORIZON).multiplyScalar(greyScale);
      this._horizonColor.lerp(this._scratch2, 0.75 * wf);
      this._scratch2.copy(RAIN_ZENITH).multiplyScalar(greyScale);
      this._zenithColor.lerp(this._scratch2, 0.75 * wf);

      // Overcast hides the twilight band, sun glow/disc and most stars.
      this._domeMat.uniforms.uGlowStrength.value *= (1 - 0.85 * wf);
      this._domeMat.uniforms.uSunGlow.value *= (1 - 0.75 * wf);
      this._domeMat.uniforms.uSunDiscIntensity.value *= (1 - 0.9 * wf);
      this._domeMat.uniforms.uMoonGlow.value *= (1 - 0.7 * wf);
      this._sunSpriteMat.opacity *= (1 - 0.85 * wf);
      this._sunSprite.visible = this._sunSpriteMat.opacity > 0.001;
      this._moonSpriteMat.opacity *= (1 - 0.7 * wf);
      this._moonSprite.visible = this._moonSpriteMat.opacity > 0.001;
      this._starMat.uniforms.uOpacity.value *= (1 - 0.85 * wf);

      // Heavier, greyer cloud deck (density/opacity in _applyCloudState).
      this._scratch2.copy(RAIN_CLOUD_LIT).multiplyScalar(greyScale);
      this._cloudLit.lerp(this._scratch2, 0.8 * wf);
      this._scratch2.copy(RAIN_CLOUD_SHADOW).multiplyScalar(greyScale);
      this._cloudShadow.lerp(this._scratch2, 0.8 * wf);

      // Dim + desaturate the light rig: sun -45% in rain, hemi greyer/dimmer.
      this.sun.intensity *= (1 - 0.45 * wf);
      this._scratch2.copy(RAIN_HEMI).multiplyScalar(greyScale);
      this.sun.color.lerp(this._scratch2, 0.35 * wf);
      this.hemi.intensity *= (1 - 0.2 * wf);
      this.hemi.color.lerp(this._scratch2, 0.5 * wf);

      // Snow-specific COOL grade (subtler than the rain grey): pull the sky
      // and light rig toward a clearly blue steel tone so snowfall reads cold
      // and desaturated at a glance — measurably cooler (higher blue-vs-red)
      // than the clear-day frame, not merely dimmer.
      if (this._weather === 'snow') {
        this._scratch2.setHex(0x93b9f0).multiplyScalar(greyScale);
        this._horizonColor.lerp(this._scratch2, 0.60);
        this._zenithColor.lerp(this._scratch2, 0.45);
        this.hemi.color.lerp(this._scratch2, 0.60);
        this.sun.color.lerp(this._scratch2, 0.45);
        this._cloudLit.lerp(this._scratch2, 0.45);
        this._cloudShadow.lerp(this._scratch2, 0.30);
      }
    }
    this._applyCloudState(dayAmt, wf);
    this._applyPaletteTint();
  }

  // Per-layer cloud coverage/opacity: weather-driven by default (clear =
  // sparse white, rain = thicker + darker + faster, snow = pale dense), or
  // pinned by the setCloudiness(0..1) override.
  _applyCloudState(dayAmt, wf) {
    const dayFactor = 0.35 + 0.65 * dayAmt;
    // Rain blows the deck along ~2.6x faster; snow drifts a touch quicker.
    this._windMul =
      this._weather === 'rain' ? 2.6 : this._weather === 'snow' ? 1.45 : 1.0;
    const v = this._cloudiness;
    for (let i = 0; i < this._cloudLayers.length; i++) {
      const L = this._cloudLayers[i];
      let coverage, opacity;
      if (v === null) {
        coverage = L.baseCoverage - 0.2 * wf;
        opacity = L.baseOpacity * dayFactor;
        // Overcast thickens the deck (layer 0 formula identical to the old
        // single-layer version; the veil thickens a little less).
        if (wf > 0) {
          opacity = Math.min(1, opacity + 0.4 * wf * (i === 0 ? 1 : 0.6));
        }
      } else {
        // Manual override: 0 = a few thin wisps, 1 = heavy unbroken deck.
        coverage = lerp(0.68, 0.18, v) + (i === 1 ? 0.05 : 0);
        opacity = L.baseOpacity * dayFactor * Math.min(1, 0.25 + 0.9 * v);
      }
      L.mat.uniforms.uCoverage.value = coverage;
      L.mat.uniforms.uOpacity.value = opacity;
    }
  }

  // Dimension palette tint — applied LAST in setTimeOfDay so it re-grades the
  // weather-graded colours; recomputed from scratch on every call so passing
  // null fully restores the natural look. All fields optional:
  //   { horizon, horizonAmt, zenith, zenithAmt,   // sky gradient lerp targets
  //     glow, glowAmt,                            // twilight band tint
  //     sun, sunAmt, sunIntensity,                // key light + sun glow/sprite
  //     hemi, hemiAmt, hemiIntensity,             // fill light
  //     cloudLit, cloudShadow, cloudAmt,          // cloud deck tint
  //     starBoost }                               // star brightness multiplier
  // Colours may be THREE.Color, hex number, or CSS string. Amounts are 0..1.
  _applyPaletteTint() {
    const glowU = this._domeMat.uniforms.uGlowColor.value;
    glowU.copy(DUSK_GLOW);
    this._starMat.uniforms.uStarBoost.value = 1;
    const g = this._paletteTint;
    if (!g) return;
    const s = this._scratch2;
    if (g.horizon !== undefined) {
      this._horizonColor.lerp(s.set(g.horizon), g.horizonAmt ?? 1);
    }
    if (g.zenith !== undefined) {
      this._zenithColor.lerp(s.set(g.zenith), g.zenithAmt ?? 1);
    }
    if (g.glow !== undefined) glowU.lerp(s.set(g.glow), g.glowAmt ?? 1);
    if (g.sun !== undefined) {
      const amt = g.sunAmt ?? 1;
      this._sunGlowColor.lerp(s.set(g.sun), amt);
      this._sunSpriteMat.color.copy(this._sunGlowColor);
      this.sun.color.lerp(s.set(g.sun), amt);
    }
    if (typeof g.sunIntensity === 'number') this.sun.intensity *= g.sunIntensity;
    if (g.hemi !== undefined) this.hemi.color.lerp(s.set(g.hemi), g.hemiAmt ?? 1);
    if (typeof g.hemiIntensity === 'number') {
      this.hemi.intensity *= g.hemiIntensity;
    }
    const cAmt = g.cloudAmt ?? 1;
    if (g.cloudLit !== undefined) this._cloudLit.lerp(s.set(g.cloudLit), cAmt);
    if (g.cloudShadow !== undefined) {
      this._cloudShadow.lerp(s.set(g.cloudShadow), cAmt);
    }
    if (typeof g.starBoost === 'number') {
      this._starMat.uniforms.uStarBoost.value = g.starBoost;
    }
  }

  // Manual cloud-cover override, 0 (clear) .. 1 (overcast). Pass null (or
  // undefined) to return to automatic weather-driven coverage.
  setCloudiness(v) {
    this._cloudiness = (v === null || v === undefined) ? null : clamp(v, 0, 1);
    this.setTimeOfDay(this._timeOfDay); // re-grade with the override applied
  }

  get cloudiness() {
    return this._cloudiness;
  }

  // Install (or clear, with null) a dimension palette tint. The tint object is
  // held by REFERENCE and re-applied on every setTimeOfDay, so a caller may
  // mutate its fields and call setPaletteTint(sameObject) again to crossfade.
  // See _applyPaletteTint for the field list.
  setPaletteTint(tint) {
    this._paletteTint = tint || null;
    this.setTimeOfDay(this._timeOfDay); // re-grade immediately
  }

  get paletteTint() {
    return this._paletteTint;
  }

  // Parent a custom mesh/group (aurora ribbons, smoke decks, ...) into the sky
  // visuals rig: it follows the camera and rescales with camera.far exactly
  // like the dome/stars/clouds. Size such objects relative to .domeRadius.
  // Note: the rig is hidden by setEnabled(false) along with the rest of the
  // sky visuals; the caller keeps ownership (dispose your own geometry).
  addSkyObject(obj) {
    if (obj) this._visuals.add(obj);
    return obj;
  }

  removeSkyObject(obj) {
    if (obj && obj.parent === this._visuals) this._visuals.remove(obj);
    return obj;
  }

  get domeRadius() {
    return this._domeRadius;
  }

  // dt seconds, ctx = { camera, renderer, elapsed, timeOfDay, ... }.
  update(dt, ctx) {
    this._elapsed = ctx && typeof ctx.elapsed === 'number'
      ? ctx.elapsed
      : this._elapsed + (dt || 0);

    // Re-evaluate the day/night cycle when the host drives time of day
    // (accept either a number or a getter function per the contract), and
    // re-grade when the weather changes.
    if (ctx) {
      if (typeof ctx.weather === 'string') this.setWeather(ctx.weather);
      let t = ctx.timeOfDay;
      if (typeof t === 'function') t = t.call(ctx);
      if (typeof t === 'number' && t !== this._timeOfDay) this.setTimeOfDay(t);
    }

    // Animated uniforms (twinkle + cloud drift). Cloud wind phase is
    // integrated (not uTime-scaled) so weather speed changes never jump the
    // pattern; each layer drifts along its own wind vector for parallax.
    this._starMat.uniforms.uTime.value = this._elapsed;
    const step =
      (typeof dt === 'number' && dt > 0 ? dt : 0.016) * this._windMul;
    for (let i = 0; i < this._cloudLayers.length; i++) {
      const L = this._cloudLayers[i];
      L.mat.uniforms.uPhase.value.addScaledVector(L.baseWind, step);
    }

    // Keep the pixel ratio current (quality changes rescale points).
    const r = (ctx && ctx.renderer) || this._renderer;
    if (r) this._starMat.uniforms.uPixelRatio.value = r.getPixelRatio();

    // Infinite-skybox behaviour: keep the visuals centred on the camera, and
    // shrink the whole rig to fit inside the camera's far plane so the
    // sun/moon sprites (which cannot use the clip-space far hug) are never
    // frustum-clipped into invisibility.
    const cam = ctx && ctx.camera;
    if (cam) {
      this._visuals.position.copy(cam.position);
      const far = cam.far;
      if (typeof far === 'number' && far > 0 && far !== this._lastFar) {
        this._lastFar = far;
        const s = Math.min(1, (far * 0.9) / this._domeRadius);
        this._visuals.scale.setScalar(s);
      }
    }
  }

  // Toggle only the visual sky. this.sun / this.hemi keep lighting the scene so
  // the shadows module can rely on this.sun regardless of dome visibility.
  setEnabled(on) {
    this._enabled = !!on;
    this._visuals.visible = this._enabled;
  }

  dispose() {
    if (this.object3d.parent) this.object3d.parent.remove(this.object3d);
    for (const d of this._disposables) {
      if (d && typeof d.dispose === 'function') d.dispose();
    }
    this._disposables.length = 0;
  }
}

export default DynamicSky;
