// graphics-lab/src/sky.js
//
// DYNAMIC SKY effect module.
//
// Provides a full day/night sky for the voxel demo:
//   - an inward-facing sky DOME with a time-of-day gradient (horizon -> zenith)
//     plus soft sun-disc and moon glows baked into the shader,
//   - a THREE.Points STAR field that fades in at night and twinkles,
//   - a procedural SUN sprite and MOON sprite that track sun/moon direction,
//   - soft, drifting fbm CLOUDS on a large horizontal plane lit by the sun,
//   - a key DirectionalLight (this.sun) + HemisphereLight fill (this.hemi)
//     whose colours/intensity animate warm-low / white-noon / dim-cool-night.
//
// Follows the graphics-lab effect contract:
//   constructor(renderer, opts) / update(dt, ctx) / setEnabled(bool) /
//   get enabled() / dispose() and exposes .object3d.
//
// Everything is allocation-free per frame (scratch objects are reused) and the
// shaders are kept lean for software-WebGL 60fps at 'medium'.

import * as THREE from 'three';

const TWO_PI = Math.PI * 2;
const { clamp, smoothstep } = THREE.MathUtils;

// ---------------------------------------------------------------------------
// Anchor colours. Authored as sRGB hex; THREE (colour-managed) converts them to
// the linear working space, so all shader maths below is linear and the final
// fragments run through <colorspace_fragment> to match the Lambert geometry.
// ---------------------------------------------------------------------------
const c = (hex) => new THREE.Color(hex);

const DAY_ZENITH    = c(0x2b6fd6);
const DAY_HORIZON   = c(0xbcd9f2);
const DUSK_ZENITH   = c(0x3a3c74);
const DUSK_HORIZON  = c(0xff7a30);
const NIGHT_ZENITH  = c(0x05070f);
const NIGHT_HORIZON = c(0x121d38);

const SUN_GLOW_WARM = c(0xffc27a); // dome/sprite sun tint near horizon
const SUN_GLOW_NOON = c(0xfff6ea); // dome/sprite sun tint high in the sky
const MOON_GLOW     = c(0xaebede); // cool moon halo

const SUN_LIGHT_WARM = c(0xff9a45); // directional light at sunrise/sunset
const SUN_LIGHT_NOON = c(0xfff4e6); // directional light at noon
const MOON_LIGHT     = c(0x5f6fa8); // directional light at night (never black)

const HEMI_GROUND = c(0x3a2f22); // warm bounce fill from the ground

const CLOUD_LIT_DAY    = c(0xffffff);
const CLOUD_SHADOW_DAY = c(0x9fb0c4);
const CLOUD_LIT_DUSK   = c(0xffce9c);
const CLOUD_SHADOW_DUSK= c(0x6b5f78);
const CLOUD_LIT_NIGHT  = c(0x2a3350);
const CLOUD_SHADOW_NIGHT = c(0x141a2e);

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
// Procedural sprite textures (soft radial sun, cratered moon).
// ---------------------------------------------------------------------------
function makeSunTexture() {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
  g.addColorStop(0.16, 'rgba(255,246,222,0.95)');
  g.addColorStop(0.40, 'rgba(255,210,140,0.45)');
  g.addColorStop(0.75, 'rgba(255,180,110,0.10)');
  g.addColorStop(1.0, 'rgba(255,170,100,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeMoonTexture() {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  // faint outer glow
  const glow = ctx.createRadialGradient(s / 2, s / 2, s * 0.28, s / 2, s / 2, s / 2);
  glow.addColorStop(0.0, 'rgba(210,222,245,0.35)');
  glow.addColorStop(1.0, 'rgba(210,222,245,0.0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, s, s);
  // solid disc with a soft limb
  const disc = ctx.createRadialGradient(
    s * 0.44, s * 0.44, s * 0.05,
    s / 2, s / 2, s * 0.30,
  );
  disc.addColorStop(0.0, 'rgba(244,247,255,1.0)');
  disc.addColorStop(0.80, 'rgba(214,224,244,1.0)');
  disc.addColorStop(1.0, 'rgba(190,202,226,0.0)');
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s * 0.30, 0, TWO_PI);
  ctx.fillStyle = disc;
  ctx.fill();
  // subtle craters (clipped to the disc)
  ctx.save();
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s * 0.30, 0, TWO_PI);
  ctx.clip();
  ctx.fillStyle = 'rgba(150,164,190,0.35)';
  const craters = [
    [0.42, 0.40, 0.055], [0.58, 0.52, 0.075], [0.50, 0.63, 0.045],
    [0.62, 0.38, 0.035], [0.40, 0.56, 0.040],
  ];
  for (const [cx, cy, cr] of craters) {
    ctx.beginPath();
    ctx.arc(s * cx, s * cy, s * cr, 0, TWO_PI);
    ctx.fill();
  }
  ctx.restore();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Shared GLSL: cheap value-noise fbm for the clouds.
// ---------------------------------------------------------------------------
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
  constructor(renderer, { size = 4000, stars = 2500 } = {}) {
    this._renderer = renderer || null;
    this._enabled = true;
    this._timeOfDay = 0.3;
    this._elapsed = 0;
    this._disposables = [];

    const domeRadius = size * 0.5;
    const starRadius = domeRadius * 0.92;
    const spriteR = domeRadius * 0.85;
    const cloudHeight = size * 0.06;
    const cloudSize = size * 1.1;
    this._spriteR = spriteR;
    this._lightDist = 120;

    // Direction vectors (owned by this module; shared into uniforms by reference
    // so mutating them updates the shaders for free). sunDir points *toward* the
    // sun; moonDir is the antipode.
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.moonDir = new THREE.Vector3(0, -1, 0);
    this._keyDir = new THREE.Vector3();

    // Reused scratch colours (no per-call allocation in setTimeOfDay).
    this._horizonColor = new THREE.Color();
    this._zenithColor = new THREE.Color();
    this._sunGlowColor = new THREE.Color();
    this._sunLightColor = new THREE.Color();
    this._cloudLit = new THREE.Color();
    this._cloudShadow = new THREE.Color();
    this._scratchColor = new THREE.Color();

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
    // Sky dome.
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
        uSunDir: { value: this.sunDir },
        uMoonDir: { value: this.moonDir },
        uSunColor: { value: this._sunGlowColor },
        uMoonColor: { value: MOON_GLOW.clone() },
        uSunGlow: { value: 0 },
        uMoonGlow: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uHorizonColor;
        uniform vec3 uZenithColor;
        uniform vec3 uSunDir;
        uniform vec3 uMoonDir;
        uniform vec3 uSunColor;
        uniform vec3 uMoonColor;
        uniform float uSunGlow;
        uniform float uMoonGlow;
        varying vec3 vDir;
        void main() {
          vec3 dir = normalize(vDir);
          float up = clamp(dir.y, 0.0, 1.0);
          float g = pow(up, 0.45);
          vec3 col = mix(uHorizonColor, uZenithColor, g);

          // Sun: broad warm halo + a soft bright core.
          float sd = max(dot(dir, uSunDir), 0.0);
          float sHalo = pow(sd, 6.0) * 0.55 + pow(sd, 2.0) * 0.12;
          float sDisc = smoothstep(0.9965, 0.9992, sd) * 0.9;
          col += uSunColor * (sHalo + sDisc) * uSunGlow;

          // Moon: tighter, cooler, subtler glow.
          float md = max(dot(dir, uMoonDir), 0.0);
          float mHalo = pow(md, 42.0) * 0.5 + pow(md, 8.0) * 0.06;
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
    // Stars.
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
      const x = Math.cos(theta) * r;
      const z = Math.sin(theta) * r;
      starPos[i * 3 + 0] = x * starRadius;
      starPos[i * 3 + 1] = y * starRadius;
      starPos[i * 3 + 2] = z * starRadius;
      starSize[i] = 1.0 + rng() * 2.2;
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
      depthTest: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uPixelRatio: { value: renderer ? renderer.getPixelRatio() : 1 },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aPhase;
        uniform float uTime;
        uniform float uPixelRatio;
        varying float vTw;
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          float tw = 0.55 + 0.45 * sin(uTime * 3.0 + aPhase * 6.2831853);
          vTw = tw;
          gl_PointSize = aSize * (0.6 + 0.4 * tw) * uPixelRatio;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        varying float vTw;
        void main() {
          vec2 pc = gl_PointCoord - 0.5;
          float d = length(pc);
          float a = smoothstep(0.5, 0.05, d);
          vec3 col = vec3(0.95, 0.97, 1.0);
          gl_FragColor = vec4(col, a * uOpacity * (0.5 + 0.5 * vTw));
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
    // Sun + moon sprites.
    // -----------------------------------------------------------------------
    this._sunTex = makeSunTexture();
    this._moonTex = makeMoonTexture();
    this._disposables.push(this._sunTex, this._moonTex);

    this._sunSpriteMat = new THREE.SpriteMaterial({
      map: this._sunTex,
      color: SUN_GLOW_NOON.clone(),
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this._disposables.push(this._sunSpriteMat);
    this._sunSprite = new THREE.Sprite(this._sunSpriteMat);
    const sunScale = domeRadius * 0.14;
    this._sunSprite.scale.set(sunScale, sunScale, 1);
    this._sunSprite.renderOrder = -990;
    this._sunSprite.frustumCulled = false;
    this._visuals.add(this._sunSprite);

    this._moonSpriteMat = new THREE.SpriteMaterial({
      map: this._moonTex,
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this._disposables.push(this._moonSpriteMat);
    this._moonSprite = new THREE.Sprite(this._moonSpriteMat);
    const moonScale = domeRadius * 0.11;
    this._moonSprite.scale.set(moonScale, moonScale, 1);
    this._moonSprite.renderOrder = -990;
    this._moonSprite.frustumCulled = false;
    this._visuals.add(this._moonSprite);

    // -----------------------------------------------------------------------
    // Clouds: a big horizontal plane with a scrolling fbm shader.
    // -----------------------------------------------------------------------
    const cloudGeo = new THREE.PlaneGeometry(cloudSize, cloudSize, 1, 1);
    this._disposables.push(cloudGeo);
    this._cloudMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uWind: { value: new THREE.Vector2(0.006, 0.0022) },
        uCloudLit: { value: this._cloudLit },
        uCloudShadow: { value: this._cloudShadow },
        uCoverage: { value: 0.48 },
        uOpacity: { value: 0.9 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec2 uWind;
        uniform vec3 uCloudLit;
        uniform vec3 uCloudShadow;
        uniform float uCoverage;
        uniform float uOpacity;
        varying vec2 vUv;
        ${FBM_GLSL}
        void main() {
          vec2 uvc = vUv - 0.5;
          float edge = smoothstep(0.5, 0.28, length(uvc));
          vec2 p = vUv * 5.0 + uWind * uTime;
          float n = fbm(p);
          float density = smoothstep(uCoverage, uCoverage + 0.28, n);
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
    this._disposables.push(this._cloudMat);
    this._clouds = new THREE.Mesh(cloudGeo, this._cloudMat);
    this._clouds.rotation.x = -Math.PI / 2;
    this._clouds.position.y = cloudHeight;
    this._clouds.renderOrder = -985;
    this._clouds.frustumCulled = false;
    this._visuals.add(this._clouds);

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

  // Horizon colour for the current time of day (so the fog module can tint to
  // the sky and hide distance pop-in). Returns a fresh Color the caller owns.
  getFogColor() {
    return this._horizonColor.clone();
  }

  // t in [0,1): 0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset.
  // Recomputes sun/moon directions, sky/sun/moon/cloud colours, light rig, and
  // the star/sun/moon opacities.
  setTimeOfDay(t) {
    this._timeOfDay = t;

    // ---- Sun direction: rises in the east (+X), arcs through a slightly
    // tilted zenith, sets in the west (-X). theta=0 at sunrise, PI/2 at noon.
    const theta = (t - 0.25) * TWO_PI;
    this.sunDir.set(Math.cos(theta), Math.sin(theta), 0.2).normalize();
    this.moonDir.copy(this.sunDir).negate();

    const a = this.sunDir.y; // sun altitude, -1..1

    // ---- Blend weights.
    const dayAmt = smoothstep(a, -0.10, 0.22); // 0 night -> 1 day
    let tw = clamp(1 - Math.abs(a) / 0.24, 0, 1); // twilight bell at the horizon
    tw = tw * tw * (3 - 2 * tw);

    // ---- Sky gradient.
    this._horizonColor.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, dayAmt);
    this._horizonColor.lerp(DUSK_HORIZON, tw * 0.8);
    this._zenithColor.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, dayAmt);
    this._zenithColor.lerp(DUSK_ZENITH, tw * 0.35);

    // ---- Sun glow (dome + sprite tint).
    const sunHi = smoothstep(a, 0.04, 0.4);
    this._sunGlowColor.copy(SUN_GLOW_WARM).lerp(SUN_GLOW_NOON, sunHi);
    const sunGlow = clamp(Math.max(dayAmt, tw * 0.9), 0, 1);
    this._domeMat.uniforms.uSunGlow.value = sunGlow;

    // ---- Moon glow (dome).
    const nightF = 1 - dayAmt;
    const moonUp = smoothstep(this.moonDir.y, -0.05, 0.2);
    this._domeMat.uniforms.uMoonGlow.value = nightF * moonUp * 0.9;

    // ---- Star opacity: fade in as the sun drops below the horizon.
    this._starMat.uniforms.uOpacity.value = 1 - smoothstep(a, -0.12, 0.06);

    // ---- Sun sprite.
    this._sunSprite.position.copy(this.sunDir).multiplyScalar(this._spriteR);
    this._sunSpriteMat.color.copy(this._sunGlowColor);
    this._sunSpriteMat.opacity = smoothstep(a, -0.05, 0.06);
    this._sunSprite.visible = this._sunSpriteMat.opacity > 0.001;

    // ---- Moon sprite (only up at night, since moonDir = -sunDir).
    this._moonSprite.position.copy(this.moonDir).multiplyScalar(this._spriteR);
    this._moonSpriteMat.opacity = smoothstep(this.moonDir.y, -0.04, 0.08) * 0.95;
    this._moonSprite.visible = this._moonSpriteMat.opacity > 0.001;

    // ---- Cloud colours + opacity.
    this._cloudLit.copy(CLOUD_LIT_NIGHT).lerp(CLOUD_LIT_DAY, dayAmt);
    this._cloudLit.lerp(CLOUD_LIT_DUSK, tw * 0.7);
    this._cloudShadow.copy(CLOUD_SHADOW_NIGHT).lerp(CLOUD_SHADOW_DAY, dayAmt);
    this._cloudShadow.lerp(CLOUD_SHADOW_DUSK, tw * 0.6);
    this._cloudMat.uniforms.uOpacity.value = 0.9 * clamp(0.32 + 0.68 * dayAmt, 0, 1);

    // ---- Directional key light: sun while it is up, moon (opposite, high at
    // midnight) while it is down. Colour/intensity: warm-low, white-noon,
    // dim-cool-night — never fully black.
    if (a >= 0.0) {
      this._keyDir.copy(this.sunDir);
      this._sunLightColor.copy(SUN_LIGHT_WARM).lerp(SUN_LIGHT_NOON, smoothstep(a, 0.02, 0.42));
      this.sun.color.copy(this._sunLightColor);
      this.sun.intensity = 0.15 + 1.15 * smoothstep(a, 0.0, 0.42);
    } else {
      this._keyDir.copy(this.moonDir);
      this.sun.color.copy(MOON_LIGHT);
      this.sun.intensity = 0.10 + 0.06 * clamp(this.moonDir.y, 0, 1);
    }
    this.sun.position.copy(this._keyDir).multiplyScalar(this._lightDist);

    // ---- Hemisphere fill: sky-tinted, warm ground bounce, dim (never 0) night.
    this.hemi.color.copy(this._horizonColor).lerp(this._zenithColor, 0.35);
    this.hemi.intensity = 0.2 + 0.7 * dayAmt;
  }

  // dt seconds, ctx = { camera, renderer, elapsed, timeOfDay, ... }.
  update(dt, ctx) {
    this._elapsed = ctx && typeof ctx.elapsed === 'number'
      ? ctx.elapsed
      : this._elapsed + (dt || 0);

    // Re-evaluate the day/night cycle when the host drives time of day.
    if (ctx && typeof ctx.timeOfDay === 'number' && ctx.timeOfDay !== this._timeOfDay) {
      this.setTimeOfDay(ctx.timeOfDay);
    }

    // Animated uniforms (twinkle + cloud drift).
    this._starMat.uniforms.uTime.value = this._elapsed;
    this._cloudMat.uniforms.uTime.value = this._elapsed;

    // Keep the pixel ratio current (quality changes rescale points).
    const r = (ctx && ctx.renderer) || this._renderer;
    if (r) this._starMat.uniforms.uPixelRatio.value = r.getPixelRatio();

    // Infinite-skybox behaviour: keep the visuals centred on the camera. The
    // lights stay in world space so shadows/lighting are unaffected.
    if (ctx && ctx.camera) this._visuals.position.copy(ctx.camera.position);
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
