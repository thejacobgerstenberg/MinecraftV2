// graphics-lab/src/water.js
//
// WATER effect module + UNDERWATER overlay.
//
//   class Water(scene, { level, size, sunRef, center, segments, ... })
//     A horizontal plane at y = level (WATER_LEVEL from worldgen) sized to cover
//     the lake/chunk, drawn with a lean custom ShaderMaterial:
//       * Vertex: a sum of 3 directional Gerstner-style sine waves gives a gentle
//         rolling surface; the wave height field is differentiated analytically so
//         per-vertex normals stay correct for lighting.
//       * Fragment: a Schlick FRESNEL term blends a (depth-faked) deep-water body
//         colour with a sky-reflection colour (reflected view ray tinted from
//         sky.getFogColor()); animated value-noise ripples perturb the normal for
//         normal-map style sparkle; a Blinn specular lobe on ctx.sunDir adds sun
//         glints; alpha ~0.75 with grazing-angle opacity and a view-angle depth
//         darkening.
//     Transparent, depthWrite:false, DoubleSide (visible from below when the
//     camera dips underwater). Exposes .object3d, update(dt, ctx), setEnabled,
//     get enabled, dispose, and setSkyReflectionColor(THREE.Color).
//
//   class UnderwaterOverlay(scene, camera, { level })
//     When the camera drops below `level` (or ctx.underwater is set) it applies an
//     underwater look: a full-screen blue-green tint (a camera-enveloping inward
//     sphere drawn with depthTest off, so it fills the view within the single
//     scene render) plus a dense blue-green fog that cuts visibility. The previous
//     scene.fog and scene.background are snapshotted on the way down and restored
//     verbatim on the way up, so it cooperates cleanly with a fog module.
//
// Follows the graphics-lab effect contract (update/setEnabled/enabled/dispose,
// .object3d) and is allocation-free per frame (scratch objects are reused).

import * as THREE from 'three';

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
    skyColor = 0x9fc4e8,      // reflection colour (overridden from sky.getFogColor)
    sunColor = 0xfff2d0,      // specular glint tint
    opacity = 0.75,
  } = {}) {
    this._scene = scene || null;
    this._enabled = true;
    this._sunRef = sunRef;
    this._elapsed = 0;
    this._manualReflect = false;   // true once setSkyReflectionColor() is called
    this._lastTod = -1;

    const cx = center && typeof center.x === 'number' ? center.x : size / 2;
    const cz = center && typeof center.z === 'number' ? center.z : size / 2;

    // Plane authored directly in the XZ plane (normal = +Y) so the vertex shader
    // can displace position.y and read x/z straight from the attribute.
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);
    this._geo = geo;

    this._sunDir = new THREE.Vector3(0.4, 0.85, 0.3).normalize();

    this._material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uWaveHeight: { value: waveHeight },
        uSunDir: { value: this._sunDir },
        uSunColor: { value: new THREE.Color(sunColor) },
        uDeepColor: { value: new THREE.Color(deepColor) },
        uShallowColor: { value: new THREE.Color(shallowColor) },
        uSkyColor: { value: new THREE.Color(skyColor) },
        uOpacity: { value: opacity },
        uF0: { value: 0.02 },          // water base reflectance (Schlick F0)
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uWaveHeight;
        varying vec3 vWorldPos;
        varying vec3 vNormal;

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

          vec4 wp = modelMatrix * vec4(p, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3  uSunDir;
        uniform vec3  uSunColor;
        uniform vec3  uDeepColor;
        uniform vec3  uShallowColor;
        uniform vec3  uSkyColor;
        uniform float uOpacity;
        uniform float uF0;
        varying vec3 vWorldPos;
        varying vec3 vNormal;

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

          // --- Sky reflection: tint the flat sky colour by the reflected ray so
          //     it reads as a subtle gradient rather than a flat wash. ----------
          vec3 R = reflect(-V, N);
          float reflGrad = mix(1.18, 0.78, clamp(R.y * 0.5 + 0.5, 0.0, 1.0));
          vec3 reflColor = uSkyColor * reflGrad;

          // --- Water body: depth faked by view angle. Straight down (facing~1)
          //     sees deep/dark water; grazing sees the lighter shallow tint. -----
          vec3 body = mix(uShallowColor, uDeepColor, facing);

          vec3 col = mix(body, reflColor, fres);

          // --- Sun glints: tight Blinn-Phong lobe + a broad softer sheen. ------
          vec3 H = normalize(uSunDir + V);
          float ndh = max(dot(N, H), 0.0);
          float sunUp = clamp(uSunDir.y * 4.0, 0.0, 1.0);
          float spec = pow(ndh, 200.0) * 1.1 + pow(ndh, 32.0) * 0.15;
          col += uSunColor * spec * sunUp;

          // --- Alpha: base transparency, but more opaque where deep or grazing. -
          float alpha = clamp(mix(uOpacity, 1.0, facing * 0.35 + fres * 0.5), 0.0, 1.0);

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

  // Set the reflected-sky colour (e.g. from sky.getFogColor()). Marks the colour
  // as manually driven so update() stops auto-pulling it from sunRef.
  setSkyReflectionColor(color) {
    if (!color) return;
    this._manualReflect = true;
    this._material.uniforms.uSkyColor.value.copy(color);
  }

  // dt seconds, ctx = { camera, elapsed, timeOfDay, sunDir, ... }.
  update(dt, ctx) {
    if (!this._enabled) return;

    this._elapsed = ctx && typeof ctx.elapsed === 'number'
      ? ctx.elapsed
      : this._elapsed + (dt || 0);
    this._material.uniforms.uTime.value = this._elapsed;

    // Sun direction: prefer the shared ctx vector, fall back to a sunRef.
    const cd = ctx && ctx.sunDir;
    if (cd) {
      this._sunDir.copy(cd).normalize();
    } else if (this._sunRef && this._sunRef.sunDir) {
      this._sunDir.copy(this._sunRef.sunDir).normalize();
    }

    // Sun glint colour from the light rig, if the sunRef exposes one.
    const sun = this._sunRef && (this._sunRef.sun || (this._sunRef.isLight ? this._sunRef : null));
    if (sun && sun.color) this._material.uniforms.uSunColor.value.copy(sun.color);

    // Auto-pull the reflection colour from the sky on time-of-day changes,
    // unless the host has taken manual control via setSkyReflectionColor().
    const tod = ctx && typeof ctx.timeOfDay === 'number' ? ctx.timeOfDay : this._lastTod;
    if (!this._manualReflect && this._sunRef &&
        typeof this._sunRef.getFogColor === 'function' && tod !== this._lastTod) {
      this._material.uniforms.uSkyColor.value.copy(this._sunRef.getFogColor());
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
  }

  get enabled() {
    return this._enabled;
  }

  isUnderwater() {
    return this._active;
  }

  update(dt, ctx) {
    if (!this._enabled) {
      if (this._active) this._deactivate();
      return;
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
    // Only override a colour background (leave textures/cube-maps untouched).
    if (this._scene.background && this._scene.background.isColor) {
      this._scene.background = this._underwaterBg;
    }
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
