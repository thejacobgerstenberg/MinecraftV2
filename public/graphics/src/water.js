// graphics-lab/src/water.js
//
// WATER effect module + UNDERWATER overlay.
//
//   class Water(scene, { level, size, sunRef, center, segments, ... })
//     A horizontal plane at y = level (WATER_LEVEL from worldgen) sized to cover
//     the lake/chunk, drawn with a lean custom ShaderMaterial:
//       * Vertex: a sum of 3 directional Gerstner-style sine waves gives a gentle
//         rolling surface; the wave height field is differentiated analytically so
//         per-vertex normals stay correct for lighting. A radial alpha falloff
//         (vFade) dissolves the outer ~15% of the plane so the square border and
//         corners melt into the fog instead of ending in a hard line (this also
//         kills the edge-on hard seam seen from underwater).
//       * Fragment: ONE consistent colour source for the whole plane — the
//         deep/shallow body colour is blended with the live sky/horizon colour
//         (uSkyColor) via a Schlick fresnel term, so sunrise tints the entire
//         surface warm with no split zones or colour seams. Everything is scaled
//         by uSunIntensity (derived from ctx.sunDir.y each update, or forced via
//         setSunLight): by day the water is lit normally, at night the body drops
//         to a dark navy and the only highlight is a modest cool moon-specular
//         streak (the glint direction flips to the moon when the sun sets).
//       * ANIMATED FLOW: the whole wave/ripple phase field is translated along a
//         flow vector accumulated on the CPU (uFlowOffset), so the surface reads
//         as a gently drifting body of water. setFlow({dirX, dirZ, speed})
//         steers it at runtime (partial updates OK); the default is a gentle
//         drift roughly matching the old static scroll rate.
//       * REFLECTION-LITE: an optional planar reflection rendered into a small
//         render target (scene re-rendered through a camera mirrored about the
//         water plane, with an oblique near-plane clip at y = level). The RT is
//         sampled projectively in the fragment stage, distorted by the ripple
//         normal, and blended INTO the existing sky-colour fresnel term — so
//         when it is off (or the camera is underwater) the shader degrades to
//         exactly the previous look. Quality gate via setReflectionQuality(q):
//         'off'/'low' = disabled, 'medium' = quarter-res RT, 'high'/'ultra' =
//         half-res RT. The RT pass renders inside update(dt, ctx) via
//         ctx.renderer/scene/camera, hides particles/transparent objects (cost)
//         + the water itself, freezes shadow-map updates for the pass, and
//         restores every bit of renderer/visibility state afterwards. A
//         re-entrancy guard makes recursion impossible.
//     Transparent, depthWrite:false, DoubleSide (visible from below when the
//     camera dips underwater). Exposes .object3d, update(dt, ctx), setEnabled,
//     get enabled, dispose, setSkyReflectionColor(THREE.Color),
//     setSunLight(intensity, color), setFlow({dirX, dirZ, speed}) and
//     setReflectionQuality('off'|'low'|'medium'|'high'|'ultra').
//
//     Sky-colour priority (checked every update, allocation-free):
//       1. ctx.skyColor (live THREE.Color supplied by the demo) — always wins;
//       2. sunRef.getFogColor() pulled on time-of-day changes (unless the host
//          took manual control via setSkyReflectionColor);
//       3. whatever setSkyReflectionColor()/the constructor seeded.
//
//   class UnderwaterOverlay(scene, camera, { level })
//     When the camera drops below `level` (or ctx.underwater is set) it applies an
//     underwater look: a full-screen blue-green tint (a camera-enveloping inward
//     sphere drawn with depthTest off, so it fills the view within the single
//     scene render) plus a dense blue-green fog that cuts visibility. The fog,
//     background and tint follow time of day (darker at night, driven off
//     ctx.sunDir.y / ctx.timeOfDay). The previous scene.fog and scene.background
//     are snapshotted on the way down and restored verbatim on the way up, so it
//     cooperates cleanly with a fog module.
//
// Follows the graphics-lab effect contract (update/setEnabled/enabled/dispose,
// .object3d) and is allocation-free per frame (scratch objects are reused).

import * as THREE from 'three';

// Clamped smoothstep on 0..1 (JS mirror of the GLSL builtin's core).
function smoothstep01(x) {
  x = x < 0 ? 0 : x > 1 ? 1 : x;
  return x * x * (3 - 2 * x);
}

// Reflection quality -> drawing-buffer divisor (0 = reflection disabled).
const REFL_DIVISOR = {
  off: 0,
  low: 0,        // low quality tier: fall back to the analytic sky fresnel
  medium: 4,     // quarter-res RT
  high: 2,       // half-res RT
  ultra: 2,      // half-res RT
};

// ---------------------------------------------------------------------------
// Shared GLSL: a tiny value-noise for the surface ripples (kept to a single
// octave; the big shapes come from the analytic waves in the vertex stage).
// ---------------------------------------------------------------------------
const NOISE_GLSL = /* glsl */ `
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
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
`;

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------
export class Water {
  constructor(scene, {
    level = 10,
    size = 64,
    sunRef = null,
    center = null,            // {x,z} centre in world space; defaults to size/2
    segments = 64,            // plane tessellation (wave resolution)
    waveHeight = 1.0,         // master amplitude scale
    deepColor = 0x0a2634,     // dark body colour (looking straight down)
    shallowColor = 0x1f6f70,  // lighter tint at grazing angles
    skyColor = 0x9fc4e8,      // reflection colour (auto-follows ctx.skyColor / sky)
    sunColor = 0xfff2d0,      // specular glint tint (day)
    moonColor = 0xbfd3ee,     // specular glint tint (night — cool moon streak)
    opacity = 0.75,
    fadeStart = 0.85,         // radial alpha falloff begins at 85% of half-size
    flow = null,              // { dirX, dirZ, speed } initial flow (see setFlow)
    reflectionQuality = 'medium',  // 'off'|'low'(=off)|'medium'(1/4)|'high'|'ultra'(1/2)
    reflectionStrength = 0.85,     // RT vs analytic sky-fresnel blend when active
  } = {}) {
    this._scene = scene || null;
    this._enabled = true;
    this._sunRef = sunRef;
    this._elapsed = 0;
    this._manualReflect = false;   // true once setSkyReflectionColor() is called
    this._lastTod = -1;

    // --- Animated flow state (uFlowOffset accumulated per update, CPU-side so
    //     speed changes never jump the phase). Default: a gentle drift. -------
    this._flowDir = new THREE.Vector2(1, 0.35).normalize();  // (x, z)
    this._flowSpeed = 0.25;                                  // world units / s

    // --- Reflection-lite state. The RT + mirror camera are created lazily on
    //     the first update that actually wants a reflection. ------------------
    this._reflQuality = 'off';
    this._reflDiv = 0;             // drawing-buffer divisor (0 = disabled)
    this._reflStrength = Math.max(0, Math.min(1, reflectionStrength));
    this._reflRT = null;
    this._mirrorCam = new THREE.PerspectiveCamera();
    this._inRefl = false;          // re-entrancy guard for the RT pass
    this._hidden = [];             // objects hidden for the current RT pass
    this._dbSize = new THREE.Vector2();
    this._camPos = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._q1 = new THREE.Quaternion();
    this._plane = new THREE.Plane();
    this._clip4 = new THREE.Vector4();
    this._qc = new THREE.Vector4();
    // Prebound traversal callback (no per-frame closure allocation). Hides
    // particles (Points/Sprites) and transparent meshes — EXCEPT sky visuals,
    // which all draw at negative renderOrder and must stay in the reflection.
    this._hideCb = (obj) => {
      if (!obj.visible || obj === this.object3d) return;
      let hide = obj.userData && obj.userData.noReflection === true;
      if (!hide && obj.renderOrder >= 0 && (obj.isPoints || obj.isSprite)) hide = true;
      if (!hide && obj.renderOrder >= 0 && obj.isMesh) {
        const m = obj.material;
        if (Array.isArray(m)) {
          for (let i = 0; i < m.length; i++) if (m[i] && m[i].transparent) { hide = true; break; }
        } else if (m && m.transparent === true) hide = true;
      }
      if (hide) { obj.visible = false; this._hidden.push(obj); }
    };

    // Manual sun override (setSunLight). When inactive, uSunIntensity is derived
    // from the live sun direction every update.
    this._manualSun = false;
    this._manualSunIntensity = 1;
    this._manualSunHasColor = false;
    this._manualSunColor = new THREE.Color(1, 1, 1);

    this._sunBaseColor = new THREE.Color(sunColor);  // warm day glints
    this._moonColor = new THREE.Color(moonColor);    // cool night glints

    const cx = center && typeof center.x === 'number' ? center.x : size / 2;
    const cz = center && typeof center.z === 'number' ? center.z : size / 2;

    // Plane authored directly in the XZ plane (normal = +Y) so the vertex shader
    // can displace position.y and read x/z straight from the attribute.
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);
    this._geo = geo;

    this._sunDir = new THREE.Vector3(0.4, 0.85, 0.3).normalize(); // raw sun dir
    this._specDir = this._sunDir.clone();  // active glint dir (sun or moon) — bound to uSunDir

    this._material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uWaveHeight: { value: waveHeight },
        uSunDir: { value: this._specDir },        // active glint direction
        uSunColor: { value: new THREE.Color(sunColor) },
        uSunIntensity: { value: 1.0 },            // 0 night .. 1 full day
        uSpecBoost: { value: 1.0 },               // glint strength (JS-computed)
        uDeepColor: { value: new THREE.Color(deepColor) },
        uShallowColor: { value: new THREE.Color(shallowColor) },
        uSkyColor: { value: new THREE.Color(skyColor) },
        uOpacity: { value: opacity },
        uF0: { value: 0.02 },                     // water base reflectance (Schlick F0)
        uFadeStart: { value: fadeStart },         // normalised radius where fade begins
        uInvHalf: { value: 2 / size },            // 1 / (size/2)
        uFlowOffset: { value: new THREE.Vector2(0, 0) },  // accumulated flow (x, z)
        uReflMap: { value: null },                // planar reflection RT (may be null)
        uReflMatrix: { value: new THREE.Matrix4() },
        uReflMix: { value: 0 },                   // 0 = pure analytic sky fresnel
        uReflDistort: { value: 0.6 },             // ripple-normal distortion (world u)
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uWaveHeight;
        uniform float uFadeStart;
        uniform float uInvHalf;
        uniform vec2 uFlowOffset;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vFade;

        // One directional sine wave: accumulates height + its x/z derivatives so
        // the surface normal can be reconstructed analytically (no faceting).
        void addWave(vec2 pos, vec2 dir, float k, float amp, float speed,
                     float t, inout float h, inout float dhdx, inout float dhdz) {
          float ph = dot(dir, pos) * k + t * speed;
          float s = sin(ph);
          float c = cos(ph);
          h    += amp * s;
          dhdx += amp * k * dir.x * c;
          dhdz += amp * k * dir.y * c;
        }

        void main() {
          vec3 p = position;              // y ~ 0 on the authored plane
          // Flow: translate the wave phase field along the accumulated flow
          // offset so the whole surface drifts (vFade below still uses the
          // untranslated p.xz — the edge dissolve must NOT drift).
          vec2 xz = p.xz - uFlowOffset;
          float t = uTime;

          float h = 0.0, dhdx = 0.0, dhdz = 0.0;
          // 3 waves: long swell -> short chop. k = 2*PI / wavelength.
          addWave(xz, normalize(vec2( 1.0,  0.0)), 0.4488, 0.35, 0.9, t, h, dhdx, dhdz); // ~14
          addWave(xz, normalize(vec2( 0.6,  0.8)), 0.7854, 0.18, 1.3, t, h, dhdx, dhdz); // ~8
          addWave(xz, normalize(vec2(-0.7,  0.5)), 1.2566, 0.10, 1.8, t, h, dhdx, dhdz); // ~5

          p.y += h * uWaveHeight;

          vec3 n = normalize(vec3(-dhdx * uWaveHeight, 1.0, -dhdz * uWaveHeight));
          vNormal = normalize(mat3(modelMatrix) * n);   // plane has no rotation/scale

          // Radial edge dissolve: 0 at/beyond the border, 1 inside uFadeStart.
          // Euclidean radius (normalised by half-size) also rounds the corners
          // away, so no square silhouette survives.
          vFade = 1.0 - smoothstep(uFadeStart, 1.0, length(p.xz) * uInvHalf);

          vec4 wp = modelMatrix * vec4(p, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3  uSunDir;
        uniform vec3  uSunColor;
        uniform float uSunIntensity;
        uniform float uSpecBoost;
        uniform vec3  uDeepColor;
        uniform vec3  uShallowColor;
        uniform vec3  uSkyColor;
        uniform float uOpacity;
        uniform float uF0;
        uniform vec2  uFlowOffset;
        uniform sampler2D uReflMap;
        uniform mat4  uReflMatrix;
        uniform float uReflMix;
        uniform float uReflDistort;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vFade;

        ${NOISE_GLSL}

        void main() {
          vec3 N = normalize(vNormal);
          if (!gl_FrontFacing) N = -N;   // seen from below when underwater
          vec3 V = normalize(cameraPosition - vWorldPos);

          // --- Normal-map style ripples from a scrolling value-noise gradient.
          //     The primary scroll follows the flow vector (uFlowOffset); a
          //     small residual counter-scroll keeps the surface shimmering even
          //     when the flow speed is 0. -------------------------------------
          vec2 rp = (vWorldPos.xz - uFlowOffset * 1.6) * 1.35
                    + vec2(uTime * 0.10, uTime * -0.08);
          float e = 0.35;
          float n0 = vnoise(rp);
          float nx = vnoise(rp + vec2(e, 0.0));
          float nz = vnoise(rp + vec2(0.0, e));
          vec2 grad = vec2(nx - n0, nz - n0) / e;
          N = normalize(N + vec3(-grad.x, 0.0, -grad.y) * 0.18);

          float facing = clamp(dot(N, V), 0.0, 1.0);

          // --- Fresnel (Schlick): more reflective at grazing angles. -----------
          float fres = uF0 + (1.0 - uF0) * pow(1.0 - facing, 5.0);

          float day = clamp(uSunIntensity, 0.0, 1.0);

          // --- ONE colour source for the whole plane: the deep/shallow body is
          //     pulled toward the live sky colour, then fresnel blends toward a
          //     sky reflection built from the SAME uSkyColor. Sunrise therefore
          //     tints every fragment warm together — no split zones, no seams. --
          vec3 body = mix(uShallowColor, uDeepColor, facing);
          body = mix(body, uSkyColor, 0.22);
          // Night: collapse the body to a dark navy (dim overall, keep blue).
          body *= mix(vec3(0.20, 0.26, 0.52), vec3(1.0), day);

          vec3 R = reflect(-V, N);
          float reflGrad = mix(1.12, 0.86, clamp(R.y * 0.5 + 0.5, 0.0, 1.0));
          vec3 reflColor = uSkyColor * reflGrad * mix(0.35, 1.0, day);

          // --- Reflection-lite: projective sample of the mirrored-scene RT,
          //     distorted by the ripple normal, blended into the analytic sky
          //     reflection. uReflMix = 0 (off/underwater/low quality) restores
          //     the exact legacy fresnel look. --------------------------------
          if (uReflMix > 0.001) {
            vec4 rc = uReflMatrix
                    * vec4(vWorldPos + vec3(N.x, 0.0, N.z) * uReflDistort, 1.0);
            if (rc.w > 0.0) {
              vec3 rrgb = texture2DProj(uReflMap, rc).rgb;
              reflColor = mix(reflColor, rrgb, uReflMix);
            }
          }

          vec3 col = mix(body, reflColor, fres);

          // --- Key-light glints: tight Blinn-Phong lobe + a broad softer sheen.
          //     uSunDir/uSunColor/uSpecBoost are steered from JS — warm sun by
          //     day, a modest cool moon streak at night. -----------------------
          vec3 H = normalize(uSunDir + V);
          float ndh = max(dot(N, H), 0.0);
          float spec = pow(ndh, 200.0) * 1.1 + pow(ndh, 32.0) * 0.15;
          col += uSunColor * spec * uSpecBoost;

          // --- Alpha: base transparency, more opaque where deep or grazing,
          //     then the radial edge dissolve so the border melts into fog. ----
          float alpha = clamp(mix(uOpacity, 1.0, facing * 0.35 + fres * 0.5), 0.0, 1.0);
          alpha *= vFade;
          if (alpha < 0.004) discard;

          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    this.object3d = new THREE.Mesh(this._geo, this._material);
    this.object3d.name = 'Water';
    this.object3d.position.set(cx, level, cz);
    this.object3d.renderOrder = 5;        // after opaque terrain, before overlays
    this.object3d.frustumCulled = false;  // waves push verts past the flat bounds

    if (this._scene) this._scene.add(this.object3d);

    if (flow) this.setFlow(flow);
    this.setReflectionQuality(reflectionQuality);
  }

  get enabled() {
    return this._enabled;
  }

  // --- Animated flow --------------------------------------------------------
  // setFlow({ dirX, dirZ, speed }): steer the drift of the wave/ripple field.
  // Partial updates are fine (omitted fields keep their current value); a
  // zero-length direction is ignored; speed is clamped to >= 0 (0 = still
  // water with only the residual shimmer). Never jumps phase: the offset is
  // accumulated, so direction/speed changes glide.
  setFlow(opts) {
    if (!opts) return;
    const { dirX, dirZ, speed } = opts;
    if (typeof dirX === 'number' || typeof dirZ === 'number') {
      const x = typeof dirX === 'number' ? dirX : this._flowDir.x;
      const z = typeof dirZ === 'number' ? dirZ : this._flowDir.y;
      const len = Math.hypot(x, z);
      if (len > 1e-6) this._flowDir.set(x / len, z / len);
    }
    if (typeof speed === 'number' && isFinite(speed)) {
      this._flowSpeed = Math.max(0, speed);
    }
  }

  // Current flow as a plain object (allocates — not for per-frame use).
  getFlow() {
    return { dirX: this._flowDir.x, dirZ: this._flowDir.y, speed: this._flowSpeed };
  }

  // --- Reflection-lite ------------------------------------------------------
  // 'off'/'low' (or false/null/0) = disabled (pure analytic sky fresnel),
  // 'medium' = quarter-res RT, 'high'/'ultra' = half-res RT.
  setReflectionQuality(q) {
    let key = q;
    if (q === false || q === null || q === undefined || q === 0) key = 'off';
    const div = REFL_DIVISOR[key];
    if (div === undefined) {
      console.warn('Water.setReflectionQuality: unknown quality "' + q + '"');
      return;
    }
    this._reflQuality = key;
    this._reflDiv = div;
  }

  get reflectionQuality() {
    return this._reflQuality;
  }

  // Seed/override the reflected-sky colour (e.g. from sky.getFogColor()).
  // NOTE: if the host feeds a live ctx.skyColor through update(), that keeps
  // winning every frame (it is the true horizon colour and must match the fog to
  // avoid seams). This call only pins the colour for hosts without ctx.skyColor:
  // it stops the sunRef.getFogColor() auto-pull.
  setSkyReflectionColor(color) {
    if (!color) return;
    this._manualReflect = true;
    this._material.uniforms.uSkyColor.value.copy(color);
  }

  // Manually drive the water's light response instead of deriving it from
  // ctx.sunDir.y. intensity: 0 (night) .. 1 (full day); color (optional): glint
  // tint. Call setSunLight(null) to return to automatic sun-driven mode.
  setSunLight(intensity, color) {
    if (intensity === null || intensity === undefined) {
      this._manualSun = false;
      this._manualSunHasColor = false;
      return;
    }
    this._manualSun = true;
    this._manualSunIntensity = Math.max(0, Math.min(1, Number(intensity) || 0));
    if (color) {
      this._manualSunHasColor = true;
      this._manualSunColor.copy(color);
    }
  }

  // dt seconds, ctx = { camera, renderer, scene, elapsed, timeOfDay, sunDir,
  // skyColor?, ... }. renderer/scene/camera are only needed for reflection-lite.
  update(dt, ctx) {
    if (!this._enabled) return;

    const u = this._material.uniforms;

    this._elapsed = ctx && typeof ctx.elapsed === 'number'
      ? ctx.elapsed
      : this._elapsed + (dt || 0);
    u.uTime.value = this._elapsed;

    // --- Animated flow: accumulate the phase-field offset. ------------------
    const dtEff = Math.max(0, Math.min(0.1, typeof dt === 'number' ? dt : 0.016));
    const fo = u.uFlowOffset.value;
    fo.x += this._flowDir.x * this._flowSpeed * dtEff;
    fo.y += this._flowDir.y * this._flowSpeed * dtEff;

    // Sun direction: prefer the shared ctx vector, fall back to a sunRef.
    const cd = ctx && ctx.sunDir;
    if (cd) {
      this._sunDir.copy(cd).normalize();
    } else if (this._sunRef && this._sunRef.sunDir) {
      this._sunDir.copy(this._sunRef.sunDir).normalize();
    }

    // --- Day/night factors from sun altitude. -----------------------------
    const sy = this._sunDir.y;
    const dayAmt = smoothstep01((sy + 0.02) / 0.32);   // 0 below horizon -> 1 by ~0.30
    const nightAmt = smoothstep01((-sy - 0.03) / 0.27);
    u.uSunIntensity.value = this._manualSun ? this._manualSunIntensity : dayAmt;

    // --- Glint direction: the sun by day, the moon (mirrored sun) at night. --
    if (sy > -0.02) {
      this._specDir.copy(this._sunDir);
    } else {
      const md = this._sunRef && this._sunRef.moonDir;
      if (md) this._specDir.copy(md).normalize();
      else this._specDir.set(-this._sunDir.x, -this._sunDir.y, 0.35).normalize();
    }

    // --- Glint strength: full sun sparkle by day, a modest moon streak at
    //     night; both fade through twilight so there is no pop. Underwater
    //     the glints are nearly killed: bright speculars on the surface seen
    //     from below would punch white holes in the murk. -------------------
    u.uSpecBoost.value = this._manualSun
      ? this._manualSunIntensity
      : dayAmt + nightAmt * 0.35;
    if (ctx && ctx.underwater === true) u.uSpecBoost.value *= 0.15;

    // --- Glint colour: manual > light rig (sky sets a cool moon colour on its
    //     key light at night) > warm/cool blend fallback. --------------------
    const sun = this._sunRef && (this._sunRef.sun || (this._sunRef.isLight ? this._sunRef : null));
    if (this._manualSun && this._manualSunHasColor) {
      u.uSunColor.value.copy(this._manualSunColor);
    } else if (sun && sun.color) {
      u.uSunColor.value.copy(sun.color);
    } else {
      u.uSunColor.value.copy(this._sunBaseColor).lerp(this._moonColor, nightAmt);
    }

    // --- Sky/horizon colour driving BOTH the body tint and the reflection. --
    // Priority: live ctx.skyColor (matches the fog exactly, updates every
    // frame) > sunRef.getFogColor() on tod change > pinned manual colour.
    const tod = ctx && typeof ctx.timeOfDay === 'number' ? ctx.timeOfDay : this._lastTod;
    const liveSky = ctx && ctx.skyColor && ctx.skyColor.isColor ? ctx.skyColor : null;
    if (liveSky) {
      u.uSkyColor.value.copy(liveSky);
    } else if (!this._manualReflect && this._sunRef &&
        typeof this._sunRef.getFogColor === 'function' && tod !== this._lastTod) {
      // getFogColor() clones, so only pull when time of day actually changed.
      u.uSkyColor.value.copy(this._sunRef.getFogColor());
    }
    this._lastTod = tod;

    // --- Reflection-lite: render the mirrored scene into the small RT and
    //     ease uReflMix toward its target (0 when off/underwater — graceful
    //     degrade back to the analytic sky fresnel). -------------------------
    let mixTarget = 0;
    if (this._reflDiv > 0 && !this._inRefl &&
        ctx && ctx.renderer && ctx.scene && ctx.camera &&
        ctx.underwater !== true) {
      ctx.camera.updateMatrixWorld();
      this._camPos.setFromMatrixPosition(ctx.camera.matrixWorld);
      if (this._camPos.y > this.object3d.position.y + 0.05) {
        mixTarget = this._reflStrength;
        this._renderReflection(ctx);
      }
    }
    const mixNow = u.uReflMix.value;
    u.uReflMix.value = mixNow + (mixTarget - mixNow) * Math.min(1, dtEff * 6);
    if (mixTarget === 0 && u.uReflMix.value < 0.004) {
      u.uReflMix.value = 0;
      // Fully faded out AND quality says off: free the RT (idempotent).
      if (this._reflDiv === 0 && this._reflRT) {
        u.uReflMap.value = null;
        this._reflRT.dispose();
        this._reflRT = null;
      }
    }
  }

  // Render the scene mirrored about the water plane into the reflection RT.
  // Allocation-free: every scratch object is preallocated in the constructor.
  _renderReflection(ctx) {
    const renderer = ctx.renderer;
    const scene = ctx.scene;
    const cam = ctx.camera;
    const u = this._material.uniforms;
    const level = this.object3d.position.y;

    this._inRefl = true;
    try {
      // --- RT sizing (tracks the drawing buffer / quality divisor). --------
      renderer.getDrawingBufferSize(this._dbSize);
      const w = Math.max(16, Math.floor(this._dbSize.x / this._reflDiv));
      const h = Math.max(16, Math.floor(this._dbSize.y / this._reflDiv));
      if (!this._reflRT) {
        this._reflRT = new THREE.WebGLRenderTarget(w, h, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          depthBuffer: true,
          stencilBuffer: false,
        });
        this._reflRT.texture.name = 'Water.reflection';
      } else if (this._reflRT.width !== w || this._reflRT.height !== h) {
        this._reflRT.setSize(w, h);
      }
      u.uReflMap.value = this._reflRT.texture;

      // --- Mirror camera: reflect position/target/up about y = level. ------
      const mc = this._mirrorCam;
      cam.getWorldDirection(this._v1);                       // forward
      this._v2.copy(this._camPos).add(this._v1);             // look target
      this._v2.y = 2 * level - this._v2.y;                   // reflected target
      this._v3.set(this._camPos.x, 2 * level - this._camPos.y, this._camPos.z);
      cam.getWorldQuaternion(this._q1);
      this._v1.set(0, 1, 0).applyQuaternion(this._q1);       // camera world up
      this._v1.y = -this._v1.y;                              // reflected up
      mc.position.copy(this._v3);
      mc.up.copy(this._v1);
      mc.lookAt(this._v2);
      mc.updateMatrixWorld();
      mc.projectionMatrix.copy(cam.projectionMatrix);

      // --- Projective texture matrix (built BEFORE the oblique clip below —
      //     only x/y/w rows matter for the uv, matching THREE.Reflector). ----
      const tm = u.uReflMatrix.value;
      tm.set(
        0.5, 0.0, 0.0, 0.5,
        0.0, 0.5, 0.0, 0.5,
        0.0, 0.0, 0.5, 0.5,
        0.0, 0.0, 0.0, 1.0,
      );
      tm.multiply(mc.projectionMatrix);
      tm.multiply(mc.matrixWorldInverse);

      // --- Oblique near-plane clip at the water plane, so geometry BELOW the
      //     surface (lake bed, fish-eye junk) never leaks into the mirror. ---
      this._v1.set(0, 1, 0);
      this._v2.set(0, level, 0);
      this._plane.setFromNormalAndCoplanarPoint(this._v1, this._v2);
      this._plane.applyMatrix4(mc.matrixWorldInverse);
      const cp = this._clip4.set(
        this._plane.normal.x, this._plane.normal.y,
        this._plane.normal.z, this._plane.constant,
      );
      const pe = mc.projectionMatrix.elements;
      const q = this._qc;
      q.x = (Math.sign(cp.x) + pe[8]) / pe[0];
      q.y = (Math.sign(cp.y) + pe[9]) / pe[5];
      q.z = -1.0;
      q.w = (1.0 + pe[10]) / pe[14];
      cp.multiplyScalar(2.0 / cp.dot(q));
      pe[2] = cp.x;
      pe[6] = cp.y;
      pe[10] = cp.z + 1.0 - 0.003;   // tiny bias against surface-edge shimmer
      pe[14] = cp.w;

      // --- Hide the water itself + particles/transparent objects (cost). ---
      const waterWasVisible = this.object3d.visible;
      this.object3d.visible = false;
      this._hidden.length = 0;
      scene.traverse(this._hideCb);

      // --- Render with full state save/restore. Shadow-map auto-update is
      //     frozen so the pass reuses this frame's existing shadow maps. -----
      const prevRT = renderer.getRenderTarget();
      const prevXr = renderer.xr.enabled;
      const prevShadowAuto = renderer.shadowMap.autoUpdate;
      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(this._reflRT);
      if (renderer.state && renderer.state.buffers && renderer.state.buffers.depth) {
        renderer.state.buffers.depth.setMask(true);  // ensure depth clear works
      }
      if (renderer.autoClear === false) renderer.clear();
      renderer.render(scene, mc);
      renderer.xr.enabled = prevXr;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.setRenderTarget(prevRT);

      // --- Restore visibility. ----------------------------------------------
      for (let i = 0; i < this._hidden.length; i++) this._hidden[i].visible = true;
      this._hidden.length = 0;
      this.object3d.visible = waterWasVisible;
    } finally {
      this._inRefl = false;
    }
  }

  setEnabled(on) {
    this._enabled = !!on;
    this.object3d.visible = this._enabled;
  }

  dispose() {
    if (this.object3d.parent) this.object3d.parent.remove(this.object3d);
    this._geo.dispose();
    this._material.dispose();
    if (this._reflRT) {
      this._reflRT.dispose();
      this._reflRT = null;
    }
  }
}

// ---------------------------------------------------------------------------
// UnderwaterOverlay
// ---------------------------------------------------------------------------
export class UnderwaterOverlay {
  constructor(scene, camera, {
    level = 10,
    tintColor = 0x0f4f5e,     // blue-green screen tint
    tintOpacity = 0.42,
    fogColor = 0x0e4653,      // dense blue-green fog
    fogNear = 1.0,
    fogFar = 30.0,
  } = {}) {
    this._scene = scene || null;
    this._camera = camera || null;
    this._level = level;
    this._enabled = true;     // master toggle
    this._active = false;     // currently rendering the underwater look
    this._saved = null;       // snapshot of fog/background taken on the way down

    // Full-screen tint: an inward-facing sphere centred on the camera, drawn with
    // depthTest off and a huge renderOrder so it fills the view during the normal
    // scene render (no second pass needed, works even though the camera is not a
    // child of the scene graph).
    this._geo = new THREE.SphereGeometry(8, 16, 12);
    this._material = new THREE.MeshBasicMaterial({
      color: tintColor,
      transparent: true,
      opacity: tintOpacity,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    this.object3d = new THREE.Mesh(this._geo, this._material);
    this.object3d.name = 'UnderwaterTint';
    this.object3d.renderOrder = 10000;
    this.object3d.frustumCulled = false;
    this.object3d.visible = false;
    if (this._scene) this._scene.add(this.object3d);

    // Preallocated underwater fog + background (reused; never per-frame alloc).
    this._underwaterFog = new THREE.Fog(new THREE.Color(fogColor), fogNear, fogFar);
    this._underwaterBg = new THREE.Color(fogColor);

    // Base (full-day) colours; the live colours above are re-derived from these
    // as the time of day changes so the underwater murk darkens at night.
    this._fogBase = new THREE.Color(fogColor);
    this._tintBase = new THREE.Color(tintColor);
    this._dayAmt = -1;        // force the first update to apply the scales
  }

  get enabled() {
    return this._enabled;
  }

  isUnderwater() {
    return this._active;
  }

  // Current underwater fog colour (already day/night graded). Hosts use this
  // to tint other systems to the murk — e.g. the demo feeds it to ctx.skyColor
  // while submerged so the water surface seen from below matches the fog.
  // Pass a THREE.Color target to avoid the allocation.
  getFogColor(target) {
    if (target && target.isColor) return target.copy(this._underwaterFog.color);
    return this._underwaterFog.color.clone();
  }

  update(dt, ctx) {
    if (!this._enabled) {
      if (this._active) this._deactivate();
      return;
    }

    // --- Follow time of day: darker murk at night. Driven off the live sun
    //     altitude (ctx.sunDir.y) with a timeOfDay fallback. Colours are only
    //     re-derived when the factor actually changes (allocation-free). ------
    const sd = ctx && ctx.sunDir;
    let alt;
    if (sd && typeof sd.y === 'number') alt = sd.y;
    else if (ctx && typeof ctx.timeOfDay === 'number') alt = Math.sin((ctx.timeOfDay - 0.25) * Math.PI * 2);
    else alt = 1;
    const day = smoothstep01((alt + 0.05) / 0.40);
    if (day !== this._dayAmt) {
      this._dayAmt = day;
      const fogScale = 0.30 + 0.70 * day;   // night fog: deep dark blue-green
      const tintScale = 0.45 + 0.55 * day;  // keep a hint of tint so it reads
      this._underwaterFog.color.copy(this._fogBase).multiplyScalar(fogScale);
      this._underwaterBg.copy(this._fogBase).multiplyScalar(fogScale);
      this._material.color.copy(this._tintBase).multiplyScalar(tintScale);
    }

    const camY = this._camera ? this._camera.position.y : Infinity;
    const want = (ctx && ctx.underwater === true) || camY < this._level;

    if (want && !this._active) this._activate();
    else if (!want && this._active) this._deactivate();

    // Keep the tint sphere centred on the camera so it always envelops the view.
    if (this._active && this._camera) {
      this.object3d.position.copy(this._camera.position);
    }
  }

  _activate() {
    if (!this._scene) { this._active = true; return; }
    // Snapshot the exact fog + background so we restore them verbatim on surface.
    this._saved = {
      fog: this._scene.fog || null,
      background: this._scene.background || null,
    };
    this._scene.fog = this._underwaterFog;
    // ALWAYS take over the background (the snapshot restores it verbatim,
    // including null). The demo scene has a null background: leaving it in
    // place let the renderer clear / bright sky read through the murk as a
    // white void wherever no geometry covered the frame.
    this._scene.background = this._underwaterBg;
    this.object3d.visible = true;
    this._active = true;
  }

  _deactivate() {
    if (this._scene && this._saved) {
      this._scene.fog = this._saved.fog;
      // Restore the background only if we were the one who swapped it in.
      if (this._scene.background === this._underwaterBg) {
        this._scene.background = this._saved.background;
      }
    }
    this._saved = null;
    this.object3d.visible = false;
    this._active = false;
  }

  setEnabled(on) {
    this._enabled = !!on;
    if (!this._enabled && this._active) this._deactivate();
  }

  dispose() {
    if (this._active) this._deactivate();
    if (this.object3d.parent) this.object3d.parent.remove(this.object3d);
    this._geo.dispose();
    this._material.dispose();
  }
}

export default Water;
