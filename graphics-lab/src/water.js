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
//     Transparent, depthWrite:false, DoubleSide (visible from below when the
//     camera dips underwater). Exposes .object3d, update(dt, ctx), setEnabled,
//     get enabled, dispose, setSkyReflectionColor(THREE.Color) and
//     setSunLight(intensity, color).
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
  } = {}) {
    this._scene = scene || null;
    this._enabled = true;
    this._sunRef = sunRef;
    this._elapsed = 0;
    this._manualReflect = false;   // true once setSkyReflectionColor() is called
    this._lastTod = -1;

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
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uWaveHeight;
        uniform float uFadeStart;
        uniform float uInvHalf;
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
          vec2 xz = p.xz;
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
          vFade = 1.0 - smoothstep(uFadeStart, 1.0, length(xz) * uInvHalf);

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
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vFade;

        ${NOISE_GLSL}

        void main() {
          vec3 N = normalize(vNormal);
          if (!gl_FrontFacing) N = -N;   // seen from below when underwater
          vec3 V = normalize(cameraPosition - vWorldPos);

          // --- Normal-map style ripples from a scrolling value-noise gradient. --
          vec2 rp = vWorldPos.xz * 1.35 + vec2(uTime * 0.35, uTime * -0.27);
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
  }

  get enabled() {
    return this._enabled;
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

  // dt seconds, ctx = { camera, elapsed, timeOfDay, sunDir, skyColor?, ... }.
  update(dt, ctx) {
    if (!this._enabled) return;

    const u = this._material.uniforms;

    this._elapsed = ctx && typeof ctx.elapsed === 'number'
      ? ctx.elapsed
      : this._elapsed + (dt || 0);
    u.uTime.value = this._elapsed;

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
  }

  setEnabled(on) {
    this._enabled = !!on;
    this.object3d.visible = this._enabled;
  }

  dispose() {
    if (this.object3d.parent) this.object3d.parent.remove(this.object3d);
    this._geo.dispose();
    this._material.dispose();
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
