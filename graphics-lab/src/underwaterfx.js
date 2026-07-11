// graphics-lab/src/underwaterfx.js
//
// UNDERWATER ENVIRONMENT FX — caustics, light shafts, bioluminescence.
//
//   class UnderwaterFX(scene, { waterLevel, bounds })
//
//     1. CAUSTICS — animated warm-white light dapples on submerged surfaces.
//        setVolume(volume) scans the demo volume for underwater TOP faces
//        (solid block with WATER directly above) and lays one additive,
//        depth-tested quad 3cm above each face. All quads are merged into ONE
//        static BufferGeometry (single draw call). The dapple pattern is a
//        procedurally generated cellular/voronoi "bright web" canvas texture,
//        sampled twice at different scales/scroll directions and min()-combined
//        (the classic caustic trick), plus a gentle time-based UV warp — so the
//        web continuously folds and shimmers with zero per-frame JS work.
//        Per-vertex attenuation dims dapples with depth (strongest in the
//        shallows). Master strength is a uniform (setCausticIntensity).
//
//     2. LIGHT SHAFTS — 4..8 slanted translucent quads hanging from the water
//        surface, aligned to the live sun direction (ctx.sunDir in update()),
//        additive with soft edge/length falloff, gently swaying. They fade out
//        at night (sun altitude) and when the camera is above the surface —
//        unless it is looking steeply down at the water (partial visibility).
//        Primarily an underwater view effect (full strength when
//        ctx.underwater, or camera.y < waterLevel). One draw call: every shaft
//        is 4 verts in a shared geometry; the slant basis, rotation about the
//        shaft axis, widening-with-depth and sway are all computed in the
//        vertex shader from static per-vertex attributes + 2 uniforms.
//
//     3. BIOLUMINESCENCE (setBiolum(bool), default OFF) — a sparse field of
//        small cyan-green pulsing motes plus a few larger soft glow spots
//        pinned near the lake floor. Placed (deterministically) only in
//        submerged water cells, weighted toward the DEEP/dark part of the
//        basin, and their strength scales with (1 - sun contribution) — i.e.
//        strongest at night, invisible in full day. One THREE.Points draw.
//
//   Contract: update(dt, ctx), setEnabled(on), get enabled, dispose(),
//   .object3d. Everything is pooled/static: geometry is built once (or on an
//   explicit setVolume() call), per-frame work is uniform writes only — zero
//   per-frame allocation (scratch vectors are reused; getWorldDirection writes
//   into a preallocated target).
//
//   Draw calls: 3 total (caustic mesh + shaft mesh + mote points), each
//   skipped automatically (visible=false) while its eased level is ~0.

import * as THREE from 'three';
import { AIR, WATER } from './blocks.js';

// Clamped smoothstep on 0..1 (JS mirror of the GLSL builtin's core).
function smoothstep01(x) {
  x = x < 0 ? 0 : x > 1 ? 1 : x;
  return x * x * (3 - 2 * x);
}

// Tiny deterministic PRNG (mulberry32) — no Math.random anywhere.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Procedural caustic texture: a tiling cellular/voronoi "bright web".
// Thin bright lines along cell borders (F2-F1 ~ 0) over a faint broad glow.
// ---------------------------------------------------------------------------
function makeCausticTexture(size = 256, cells = 22, seed = 9107) {
  const rand = mulberry32(seed);
  // Feature points, replicated in a 3x3 torus so the texture tiles seamlessly.
  const px = [];
  const py = [];
  for (let i = 0; i < cells; i++) {
    const x = rand() * size;
    const y = rand() * size;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        px.push(x + ox * size);
        py.push(y + oy * size);
      }
    }
  }
  const n = px.length;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  const img = g.createImageData(size, size);
  const data = img.data;

  const edgeW = size * 0.034;   // web line width
  const glowR = size * 0.170;   // broad cell-center glow radius
  let o = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let f1 = Infinity;
      let f2 = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = px[i] - x;
        const dy = py[i] - y;
        const d = dx * dx + dy * dy;
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
      }
      f1 = Math.sqrt(f1);
      f2 = Math.sqrt(f2);
      // Bright web along borders where the two nearest cells meet.
      let web = 1 - Math.min(1, (f2 - f1) / edgeW);
      web = web * web;
      web *= web;                // web^4: crisp bright filaments
      // Faint broad fill so cells are not pure black (keeps dapples soft).
      const broad = 1 - Math.min(1, f1 / glowR);
      let v = web + broad * broad * 0.12;
      v = v > 1 ? 1 : v;
      const b = (v * 255) | 0;
      data[o++] = b; data[o++] = b; data[o++] = b; data[o++] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

// ---------------------------------------------------------------------------
// UnderwaterFX
// ---------------------------------------------------------------------------
const MAX_MOTES = 140;   // total points (includes the glow spots)
const GLOW_SPOTS = 5;    // large soft floor glows among the motes

export class UnderwaterFX {
  constructor(scene, {
    waterLevel = 10,
    bounds = null,          // optional { minX, maxX, minZ, maxZ } clamp region
    shafts = 7,             // 4..8 light shafts
    causticIntensity = 1.0, // master caustic strength (uniform)
  } = {}) {
    this._scene = scene || null;
    this._level = waterLevel;
    this._bounds = bounds || null;
    this._enabled = true;
    this._biolum = false;         // default OFF per spec
    this._time = 0;
    this._causticIntensity = causticIntensity;

    // Eased visibility levels (day/night + camera driven; no pops).
    this._causticLevel = 0;
    this._shaftLevel = 0;
    this._biolumLevel = 0;

    this._shaftCount = Math.max(4, Math.min(8, shafts | 0));
    this._shaftsPlaced = false;
    this._causticQuads = 0;
    this._moteCount = 0;

    // Scratch objects (reused every frame — zero per-frame allocation).
    this._scratchDir = new THREE.Vector3();

    this.object3d = new THREE.Group();
    this.object3d.name = 'UnderwaterFX';

    // ------------------------------------------------------------------ 1.
    // CAUSTICS: one merged mesh of additive quads; geometry filled by
    // setVolume(). World-space UVs are derived from position in the shader,
    // so the web is continuous across every quad.
    // ------------------------------------------------------------------
    this._causticTex = makeCausticTexture();
    this._causticMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uTex: { value: this._causticTex },
        uIntensity: { value: 0 },
        uScale: { value: 0.115 },                       // world xz -> uv
        uColor: { value: new THREE.Color(1.0, 0.96, 0.86) }, // warm white
      },
      vertexShader: /* glsl */ `
        attribute float aAtten;
        varying vec2 vXZ;
        varying float vAtten;
        void main() {
          vXZ = position.xz;         // geometry is authored in world space
          vAtten = aAtten;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform sampler2D uTex;
        uniform float uIntensity;
        uniform float uScale;
        uniform vec3 uColor;
        varying vec2 vXZ;
        varying float vAtten;
        void main() {
          vec2 base = vXZ * uScale;
          // Gentle time-based UV warp so the web folds instead of just sliding.
          vec2 warp = 0.045 * vec2(
            sin(uTime * 0.61 + base.y * 9.0),
            cos(uTime * 0.53 + base.x * 8.0));
          vec2 uv1 = base * 1.00 + warp + vec2(uTime * 0.022,  uTime * 0.016);
          vec2 uv2 = base * 1.27 - warp + vec2(-uTime * 0.017, uTime * 0.026);
          float a = texture2D(uTex, uv1).r;
          float b = texture2D(uTex, uv2).r;
          float c = min(a, b);                 // classic dual-sheet caustic
          c = pow(c * 2.3, 1.5);
          vec3 col = uColor * (c * uIntensity * vAtten);
          gl_FragColor = vec4(col, 1.0);       // additive: rgb is the light
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this._causticGeo = new THREE.BufferGeometry();
    this._causticMesh = new THREE.Mesh(this._causticGeo, this._causticMat);
    this._causticMesh.name = 'UnderwaterCaustics';
    this._causticMesh.renderOrder = 2;      // under the water plane (order 5)
    this._causticMesh.frustumCulled = false;
    this._causticMesh.visible = false;
    this.object3d.add(this._causticMesh);

    // ------------------------------------------------------------------ 2.
    // LIGHT SHAFTS: N quads in one geometry. position = the surface anchor
    // (same for all 4 verts of a shaft); aParam = (across in -1..1, down in
    // 0..1); aRand = per-shaft seed (rotation about the axis + sway phase).
    // The slanted basis is built in the vertex shader from uAxis (= -sunDir).
    // ------------------------------------------------------------------
    {
      const N = this._shaftCount;
      const pos = new Float32Array(N * 4 * 3);
      const par = new Float32Array(N * 4 * 2);
      const rnd = new Float32Array(N * 4);
      const idx = new Uint16Array(N * 6);
      const rand = mulberry32(4241);
      for (let i = 0; i < N; i++) {
        const r = rand();
        const v0 = i * 4;
        // (u, v) corners: (-1,0) (1,0) (-1,1) (1,1)
        par[v0 * 2 + 0] = -1; par[v0 * 2 + 1] = 0;
        par[v0 * 2 + 2] = 1; par[v0 * 2 + 3] = 0;
        par[v0 * 2 + 4] = -1; par[v0 * 2 + 5] = 1;
        par[v0 * 2 + 6] = 1; par[v0 * 2 + 7] = 1;
        rnd[v0] = r; rnd[v0 + 1] = r; rnd[v0 + 2] = r; rnd[v0 + 3] = r;
        const t0 = i * 6;
        idx[t0 + 0] = v0; idx[t0 + 1] = v0 + 2; idx[t0 + 2] = v0 + 1;
        idx[t0 + 3] = v0 + 1; idx[t0 + 4] = v0 + 2; idx[t0 + 5] = v0 + 3;
      }
      this._shaftGeo = new THREE.BufferGeometry();
      this._shaftGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this._shaftGeo.setAttribute('aParam', new THREE.BufferAttribute(par, 2));
      this._shaftGeo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
      this._shaftGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    this._shaftMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uAxis: { value: new THREE.Vector3(0.3, -0.85, 0.2).normalize() },
        uOpacity: { value: 0 },
        uLength: { value: 9 },
        uWidth: { value: 1.8 },
        uColor: { value: new THREE.Color(0.85, 0.95, 1.0) }, // pale water-lit
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uAxis;      // normalized, points DOWN along the light
        uniform float uLength;
        uniform float uWidth;
        attribute vec2 aParam;   // x: across -1..1, y: down 0..1
        attribute float aRand;
        varying vec2 vParam;
        varying float vRand;
        void main() {
          vParam = aParam;
          vRand = aRand;
          // Orthonormal basis around the shaft axis; each shaft is rotated
          // about the axis by its own angle so some face every viewpoint.
          vec3 t1 = normalize(cross(uAxis, vec3(0.31, 0.05, 0.95)));
          vec3 t2 = normalize(cross(uAxis, t1));
          float ang = aRand * 6.28318;
          vec3 side = t1 * cos(ang) + t2 * sin(ang);
          float halfW = uWidth * (0.55 + 0.45 * fract(aRand * 7.31))
                      * (1.0 + aParam.y * 0.9);       // widens with depth
          // Gentle sway, growing with depth (the top stays pinned).
          vec3 sway = vec3(
            sin(uTime * 0.55 + aRand * 21.0),
            0.0,
            cos(uTime * 0.42 + aRand * 13.0)) * (0.55 * aParam.y);
          vec3 wp = position
                  + uAxis * (aParam.y * uLength)
                  + side * (aParam.x * halfW)
                  + sway;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uOpacity;
        uniform vec3 uColor;
        varying vec2 vParam;
        varying float vRand;
        void main() {
          float across = 1.0 - vParam.x * vParam.x;     // soft side edges
          across *= across;
          float down = 1.0 - vParam.y;                  // fade toward the tip
          down = down * down * (0.35 + 0.65 * smoothstep(0.0, 0.12, vParam.y));
          // Slow per-shaft brightness breathing.
          float breathe = 0.75 + 0.25 * sin(uTime * 0.8 + vRand * 40.0);
          float a = uOpacity * across * down * breathe;
          gl_FragColor = vec4(uColor * a, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this._shaftMesh = new THREE.Mesh(this._shaftGeo, this._shaftMat);
    this._shaftMesh.name = 'UnderwaterLightShafts';
    this._shaftMesh.renderOrder = 6;
    this._shaftMesh.frustumCulled = false;
    this._shaftMesh.visible = false;
    this.object3d.add(this._shaftMesh);

    // ------------------------------------------------------------------ 3.
    // BIOLUMINESCENT MOTES: one THREE.Points pool. Filled by setVolume();
    // drawRange stays 0 until then. First GLOW_SPOTS entries are the large
    // soft floor glows, the rest are small drifting-in-place pulse motes.
    // ------------------------------------------------------------------
    {
      const pos = new Float32Array(MAX_MOTES * 3);
      const seedA = new Float32Array(MAX_MOTES);
      const sizeA = new Float32Array(MAX_MOTES);
      const tintA = new Float32Array(MAX_MOTES);
      this._moteGeo = new THREE.BufferGeometry();
      this._moteGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this._moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(seedA, 1));
      this._moteGeo.setAttribute('aSize', new THREE.BufferAttribute(sizeA, 1));
      this._moteGeo.setAttribute('aTint', new THREE.BufferAttribute(tintA, 1));
      this._moteGeo.setDrawRange(0, 0);
    }
    this._moteMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uStrength: { value: 0 },
        uHeight: { value: 900 },   // drawing-buffer height (point sizing)
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uHeight;
        attribute float aSeed;
        attribute float aSize;
        attribute float aTint;
        varying float vPulse;
        varying float vTint;
        varying float vGlow;
        void main() {
          vTint = aTint;
          vGlow = step(1.2, aSize);   // large points are the soft glow spots
          float ph = aSeed * 43.0;
          vPulse = 0.62 + 0.38 * sin(uTime * (0.9 + aSeed * 1.3) + ph);
          // Tiny in-place bob so the field feels alive (no attribute writes).
          vec3 p = position;
          p.y += sin(uTime * 0.6 + ph) * 0.12;
          p.x += sin(uTime * 0.37 + ph * 1.7) * 0.08;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float sz = aSize * (0.8 + 0.2 * vPulse);
          gl_PointSize = sz * uHeight * 0.5 * projectionMatrix[1][1] / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uStrength;
        varying float vPulse;
        varying float vTint;
        varying float vGlow;
        void main() {
          vec2 q = gl_PointCoord * 2.0 - 1.0;
          float d = dot(q, q);
          if (d > 1.0) discard;
          float fall = 1.0 - d;
          fall = mix(fall * fall * fall, fall * fall, vGlow); // glows softer
          vec3 cyan = vec3(0.15, 0.95, 0.85);
          vec3 green = vec3(0.35, 1.00, 0.45);
          vec3 col = mix(cyan, green, vTint);
          float amp = mix(1.6, 0.5, vGlow);   // motes punchy, glows soft
          vec3 rgb = col * (fall * vPulse * uStrength * amp);
          gl_FragColor = vec4(rgb, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this._motes = new THREE.Points(this._moteGeo, this._moteMat);
    this._motes.name = 'UnderwaterBiolum';
    this._motes.renderOrder = 7;
    this._motes.frustumCulled = false;
    this._motes.visible = false;
    this.object3d.add(this._motes);

    if (this._scene) this._scene.add(this.object3d);
  }

  get enabled() {
    return this._enabled;
  }

  // -------------------------------------------------------------------------
  // setVolume(volume): sample the demo volume ({ sx, sy, sz, get, WATER_LEVEL })
  // to (re)build the caustic quad pool, anchor the light shafts over the
  // deepest water, and scatter the bioluminescent motes. Called once at setup
  // (or again if the world changes) — never per frame.
  // -------------------------------------------------------------------------
  setVolume(volume) {
    if (!volume || typeof volume.get !== 'function') return;
    const level = typeof volume.WATER_LEVEL === 'number' ? volume.WATER_LEVEL : this._level;
    this._level = level;

    const b = this._bounds || {};
    const x0 = Math.max(0, b.minX != null ? b.minX | 0 : 0);
    const z0 = Math.max(0, b.minZ != null ? b.minZ | 0 : 0);
    const x1 = Math.min(volume.sx, b.maxX != null ? (b.maxX | 0) + 1 : volume.sx);
    const z1 = Math.min(volume.sz, b.maxZ != null ? (b.maxZ | 0) + 1 : volume.sz);

    // --- Scan for submerged top faces + collect water columns. --------------
    const positions = [];
    const attens = [];
    const indices = [];
    const cols = [];      // water columns: { x, z, topY (face y), depth }
    let floorMin = level;

    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        // Walk down from the water level to the first non-air, non-water block.
        for (let y = Math.min(level, volume.sy - 1); y >= 0; y--) {
          const id = volume.get(x, y, z);
          if (id === AIR || id === WATER) continue;
          // Submerged top face: water directly above the solid top.
          if (volume.get(x, y + 1, z) !== WATER) break;
          const fy = y + 1 + 0.03;              // 3cm above the face (no z-fight)
          const base = positions.length / 3;
          positions.push(
            x, fy, z, x + 1, fy, z,
            x, fy, z + 1, x + 1, fy, z + 1,
          );
          // Depth attenuation: brightest dapples in the shallows.
          const depth = level + 1 - fy;
          let at = Math.exp(-0.09 * depth);
          if (at < 0.45) at = 0.45;
          attens.push(at, at, at, at);
          indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
          const d = level - y;
          cols.push({ x, z, topY: y + 1, depth: d });
          if (y + 1 < floorMin) floorMin = y + 1;
          break;
        }
      }
    }

    // --- Caustic geometry (static, one draw). --------------------------------
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('aAtten', new THREE.BufferAttribute(new Float32Array(attens), 1));
    geo.setIndex(indices.length > 65535
      ? new THREE.BufferAttribute(new Uint32Array(indices), 1)
      : new THREE.BufferAttribute(new Uint16Array(indices), 1));
    geo.computeBoundingSphere();
    this._causticMesh.geometry = geo;
    this._causticGeo.dispose();
    this._causticGeo = geo;
    this._causticQuads = positions.length / 12;

    // --- Shaft anchors over the deeper water (evenly strided pick). ---------
    const deep = [];
    for (let i = 0; i < cols.length; i++) {
      if (cols[i].depth >= 3) deep.push(cols[i]);
    }
    const pool = deep.length >= this._shaftCount ? deep : cols;
    if (pool.length > 0) {
      const posAttr = this._shaftGeo.getAttribute('position');
      const arr = posAttr.array;
      const stride = pool.length / this._shaftCount;
      for (let i = 0; i < this._shaftCount; i++) {
        const c = pool[Math.min(pool.length - 1, (i * stride + stride * 0.5) | 0)];
        const ax = c.x + 0.5;
        const ay = level + 0.15;    // just above the resting surface
        const az = c.z + 0.5;
        for (let v = 0; v < 4; v++) {
          const o = (i * 4 + v) * 3;
          arr[o] = ax; arr[o + 1] = ay; arr[o + 2] = az;
        }
      }
      posAttr.needsUpdate = true;
      this._shaftMat.uniforms.uLength.value = (level - floorMin) + 2.5;
      this._shaftsPlaced = true;
    }

    // --- Bioluminescent motes: deep/dark cells only, deterministic. ---------
    if (pool.length > 0) {
      const rand = mulberry32(7331);
      const pos = this._moteGeo.getAttribute('position').array;
      const seedA = this._moteGeo.getAttribute('aSeed').array;
      const sizeA = this._moteGeo.getAttribute('aSize').array;
      const tintA = this._moteGeo.getAttribute('aTint').array;
      let count = 0;

      // A few large soft glow spots hugging the deepest floor.
      const gStride = pool.length / GLOW_SPOTS;
      for (let i = 0; i < GLOW_SPOTS && count < MAX_MOTES; i++) {
        const c = pool[Math.min(pool.length - 1, (i * gStride + gStride * 0.35) | 0)];
        const o = count * 3;
        pos[o] = c.x + 0.5;
        pos[o + 1] = c.topY + 0.45;
        pos[o + 2] = c.z + 0.5;
        seedA[count] = rand();
        sizeA[count] = 1.7 + rand() * 1.1;       // >= 1.2 -> soft glow branch
        tintA[count] = rand() * 0.5;             // stay cyan-ish
        count++;
      }
      // Sparse small motes, weighted toward deeper (darker) water.
      for (let tries = 0; tries < 4000 && count < MAX_MOTES; tries++) {
        const c = pool[(rand() * pool.length) | 0];
        if (rand() > c.depth / 6) continue;      // prefer the dark deep bowl
        const span = level - 0.6 - (c.topY + 0.4);
        if (span <= 0) continue;
        const o = count * 3;
        pos[o] = c.x + rand();
        pos[o + 1] = c.topY + 0.4 + rand() * span;
        pos[o + 2] = c.z + rand();
        seedA[count] = rand();
        sizeA[count] = 0.05 + rand() * 0.09;     // small world-space motes
        tintA[count] = rand();
        count++;
      }
      this._moteGeo.getAttribute('position').needsUpdate = true;
      this._moteGeo.getAttribute('aSeed').needsUpdate = true;
      this._moteGeo.getAttribute('aSize').needsUpdate = true;
      this._moteGeo.getAttribute('aTint').needsUpdate = true;
      this._moteGeo.setDrawRange(0, count);
      this._moteGeo.computeBoundingSphere();
      this._moteCount = count;
    }
  }

  // Bioluminescence master switch (default off). Strength still follows
  // darkness: it eases in as the sun's contribution drops (strongest at night).
  setBiolum(on) {
    this._biolum = !!on;
  }

  get biolum() {
    return this._biolum;
  }

  // Master caustic strength (drives the shader intensity uniform).
  setCausticIntensity(v) {
    v = Number(v);
    this._causticIntensity = Number.isFinite(v) ? Math.max(0, v) : 1;
  }

  // ---------------------------------------------------------------------------
  // update(dt, ctx) — uniform writes only; zero allocation.
  // ctx: { camera, sunDir, underwater, renderer?, ... } (demo.js ctx contract).
  // ---------------------------------------------------------------------------
  update(dt, ctx) {
    if (!this._enabled) return;
    const step = Math.min(Math.max(dt || 0, 0), 0.1);
    this._time += step;
    const t = this._time;

    // --- Sun/day factors from the live sun direction. -----------------------
    const sd = ctx && ctx.sunDir;
    const sunY = sd && typeof sd.y === 'number' ? sd.y : 0.6;
    const day = smoothstep01((sunY + 0.02) / 0.30);

    // Shaft axis = light travel direction (opposite the to-sun vector), kept
    // at least 25% downward so shafts never go horizontal at sunset.
    if (sd) {
      const ax = this._shaftMat.uniforms.uAxis.value;
      ax.set(-sd.x, Math.min(-sd.y, -0.25), -sd.z).normalize();
    }

    // --- Underwater / looking-down visibility. -------------------------------
    const cam = ctx && ctx.camera;
    const under = (ctx && ctx.underwater === true) ||
      !!(cam && cam.position.y < this._level);
    let vis = 0;
    if (under) {
      vis = 1;
    } else if (cam) {
      cam.getWorldDirection(this._scratchDir);   // writes into scratch (no alloc)
      const downLook = -this._scratchDir.y;
      if (downLook > 0.25) vis = 0.45 * smoothstep01((downLook - 0.25) / 0.45);
    }

    // --- Eased levels (frame-rate independent). ------------------------------
    const ease = 1 - Math.exp(-step * 4);
    this._causticLevel += (day - this._causticLevel) * ease;
    this._shaftLevel += (day * vis - this._shaftLevel) * ease;
    const bioTarget = this._biolum ? (1 - day) : 0;
    this._biolumLevel += (bioTarget - this._biolumLevel) * ease;

    // --- Push uniforms. -------------------------------------------------------
    const cu = this._causticMat.uniforms;
    cu.uTime.value = t;
    cu.uIntensity.value = this._causticIntensity * this._causticLevel
      * (under ? 1.0 : 0.55);   // subtler when seen from above the surface
    this._causticMesh.visible = this._causticQuads > 0 && cu.uIntensity.value > 0.004;

    const su = this._shaftMat.uniforms;
    su.uTime.value = t;
    su.uOpacity.value = 0.22 * this._shaftLevel;
    this._shaftMesh.visible = this._shaftsPlaced && this._shaftLevel > 0.01;

    const mu = this._moteMat.uniforms;
    mu.uTime.value = t;
    mu.uStrength.value = this._biolumLevel * (under ? 1.0 : 0.6);
    if (ctx && ctx.renderer && ctx.renderer.domElement) {
      mu.uHeight.value = ctx.renderer.domElement.height || mu.uHeight.value;
    }
    this._motes.visible = this._moteCount > 0 && this._biolumLevel > 0.01;
  }

  setEnabled(on) {
    this._enabled = !!on;
    this.object3d.visible = this._enabled;
  }

  dispose() {
    if (this.object3d.parent) this.object3d.parent.remove(this.object3d);
    this._causticGeo.dispose();
    this._shaftGeo.dispose();
    this._moteGeo.dispose();
    this._causticMat.dispose();
    this._shaftMat.dispose();
    this._moteMat.dispose();
    this._causticTex.dispose();
  }
}

export default UnderwaterFX;
