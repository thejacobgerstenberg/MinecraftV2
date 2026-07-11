// graphics-lab/src/waterfx.js
//
// FLOWFALLS — waterfall + lavafall showcase pieces.
//
//   class FlowFalls(scene, { atlas? })
//     addFall({ type: 'water'|'lava', from: Vector3-like, to: Vector3-like,
//               width = 3 }) -> handle { id, type, remove() }
//       Builds an animated falling sheet between `from` (top) and `to` (base):
//         * SHEET: a strip mesh whose fragment shader scrolls stretched
//           value-noise streaks down the fall (no textures, no UV animation on
//           the CPU). The bottom of the SAME sheet carries the foam fringe
//           (water: churning white band) / ember fringe (lava: hot glow band),
//           so the fringe costs zero extra draw calls. The vertex stage adds a
//           gentle billow so the sheet does not read as a flat card. Lava is
//           emissive (values > 1 feed the HDR bloom chain) and near-opaque.
//         * MIST: one soft horizontal quad at the base (radial alpha falloff,
//           slow pulse). Water mist is pale + normal-blended; lava mist is a
//           hot additive glow.
//         * SPLASH/EMBERS: spawned from ONE shared fixed-capacity particle
//           pool for ALL falls (a single THREE.Points draw call). Water spits
//           short-lived spray droplets; lava lofts slow glowing embers.
//     update(dt, ctx), setEnabled(bool), get enabled, dispose(), .object3d —
//     the standard graphics-lab effect contract.
//
//   Perf design (60fps@medium):
//     * Per fall: exactly 2 draw calls (sheet + mist). All water sheets share
//       ONE material, all lava sheets share ONE material (per-fall length and
//       width travel in an `aInfo` vertex attribute, not uniforms), and mist
//       quads share one material per type — no per-fall shader programs.
//     * One shared Points pool (capacity 320) for every fall's splash/embers:
//       fixed typed arrays recycled in place via swap-with-last, zero per-frame
//       allocation, one draw call total (hidden when nothing is alive).
//     * update() mutates prebuilt uniforms/typed arrays only.
//
//   The `atlas` option is accepted for forward compatibility with the block
//   texture atlas (per the constructor contract) but the current visuals are
//   fully procedural and do not sample it.
//
// Deterministic: particle randomness comes from a seeded LCG, no Math.random.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Shared GLSL value noise (single octave; matches the water module's flavour).
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

const SHEET_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uScroll;
  attribute vec2 aInfo;          // (fall length, fall width) in world units
  varying vec2 vUv;
  varying vec2 vInfo;

  void main() {
    vUv = uv;
    vInfo = aInfo;
    vec3 p = position;
    float len = aInfo.x;
    float dTop = (1.0 - uv.y) * len;       // world units fallen from the lip
    // Gentle billow: the sheet bellies out as it falls (no flat-card look).
    float sway = sin(dTop * 0.9 - uTime * max(uScroll * 0.55, 0.8) + p.x * 1.7);
    p.z += sway * 0.10 * smoothstep(0.0, 2.0, dTop);
    // Slight flare toward the base (water spreads as it lands).
    p.x *= 1.0 + 0.16 * smoothstep(0.35, 1.0, dTop / max(len, 0.001));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const SHEET_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uScroll;         // downward pattern speed, world units / s
  uniform vec3  uColDeep;        // sheet body colour
  uniform vec3  uColBright;      // streak highlight colour (may be > 1 = HDR)
  uniform vec3  uColFringe;      // base fringe colour (foam / ember glow)
  uniform float uBaseAlpha;
  uniform float uFringeH;        // base fringe height, world units
  varying vec2 vUv;
  varying vec2 vInfo;

  ${NOISE_GLSL}

  void main() {
    float len = vInfo.x;
    float wid = vInfo.y;
    float dTop = (1.0 - vUv.y) * len;      // distance fallen from the lip
    float dBot = vUv.y * len;              // distance up from the base

    // Streaks: value noise stretched along the fall, translating downward.
    float v = dTop - uTime * uScroll;
    vec2 sc = vec2(vUv.x * wid * 1.1, v * 0.28);
    float streak = vnoise(sc) * 0.62 + vnoise(sc * vec2(2.3, 2.0) + 17.1) * 0.38;
    float hi = smoothstep(0.48, 0.85, streak);

    vec3 col = mix(uColDeep, uColBright, hi);
    float alpha = uBaseAlpha + 0.42 * hi;

    // Base fringe: churning foam (water) / hot ember band (lava), animated
    // faster than the sheet so the landing zone reads as agitated.
    float fringe = smoothstep(uFringeH, 0.0, dBot);
    float fn = vnoise(vec2(vUv.x * wid * 3.1, dBot * 1.9 - uTime * 3.2));
    col = mix(col, uColFringe, fringe * (0.45 + 0.55 * fn));
    alpha = max(alpha, fringe * (0.55 + 0.45 * fn));

    // Fades: sheer-in at the lip, soft vertical side edges.
    alpha *= smoothstep(0.0, 1.1, dTop);
    alpha *= smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
    if (alpha < 0.01) discard;

    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const MIST_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const MIST_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3  uColor;
  uniform float uAlpha;
  varying vec2 vUv;

  void main() {
    vec2 d = vUv - 0.5;
    float r = length(d) * 2.0;
    float pulse = 0.8 + 0.2 * sin(uTime * 1.6 + vUv.x * 6.28318);
    float a = (1.0 - smoothstep(0.25, 1.0, r)) * uAlpha * pulse;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const POINTS_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aLife;         // 1 fresh -> 0 dead
  varying vec3 vColor;
  varying float vLife;
  void main() {
    vColor = aColor;
    vLife = aLife;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float ps = aSize * (140.0 / max(-mv.z, 1.0));
    gl_PointSize = clamp(ps, 1.0, 24.0);   // hard cap: no giant near-cam quads
    gl_Position = projectionMatrix * mv;
  }
`;

const POINTS_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vLife;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = smoothstep(0.5, 0.12, length(d)) * vLife;
    if (a < 0.02) discard;
    gl_FragColor = vec4(vColor, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const POOL_CAPACITY = 320;

// ---------------------------------------------------------------------------
// FlowFalls
// ---------------------------------------------------------------------------
export class FlowFalls {
  constructor(scene, { atlas = null } = {}) {
    this._scene = scene || null;
    this._atlas = atlas;           // reserved (visuals are procedural for now)
    this._enabled = true;
    this._falls = [];
    this._nextId = 1;
    this._rngState = 0x9e3779b9 >>> 0;   // seeded LCG (deterministic)

    this.object3d = new THREE.Group();
    this.object3d.name = 'FlowFalls';

    // Shared time uniform object — every material references the same slot.
    this._uTime = { value: 0 };

    // Lazily-created shared materials (per type), shared by ALL falls.
    this._sheetMats = { water: null, lava: null };
    this._mistMats = { water: null, lava: null };

    // ---- Shared splash/ember pool: one Points, fixed typed arrays. --------
    const C = POOL_CAPACITY;
    this._cap = C;
    this._alive = 0;
    this._pos = new Float32Array(C * 3);
    this._col = new Float32Array(C * 3);
    this._size = new Float32Array(C);
    this._lifeAttr = new Float32Array(C);
    this._vel = new Float32Array(C * 3);
    this._age = new Float32Array(C);
    this._maxAge = new Float32Array(C);
    this._grav = new Float32Array(C);
    this._poolDirty = false;       // aColor/aSize need re-upload (spawn/kill)

    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
    pg.setAttribute('aColor', new THREE.BufferAttribute(this._col, 3));
    pg.setAttribute('aSize', new THREE.BufferAttribute(this._size, 1));
    pg.setAttribute('aLife', new THREE.BufferAttribute(this._lifeAttr, 1));
    pg.setDrawRange(0, 0);
    this._pointsGeo = pg;
    this._pointsMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this._uTime },
      vertexShader: POINTS_VERT,
      fragmentShader: POINTS_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this._points = new THREE.Points(pg, this._pointsMat);
    this._points.name = 'FlowFalls.pool';
    this._points.frustumCulled = false;
    this._points.renderOrder = 8;
    this._points.visible = false;
    this._points.userData.noShadow = true;
    this.object3d.add(this._points);

    // Scratch (reused, never per-frame allocated).
    this._sFrom = new THREE.Vector3();
    this._sTo = new THREE.Vector3();
    this._sDir = new THREE.Vector3();
    this._sSide = new THREE.Vector3();
    this._sQuat = new THREE.Quaternion();
    this._DOWN = new THREE.Vector3(0, -1, 0);

    if (this._scene) this._scene.add(this.object3d);
  }

  get enabled() {
    return this._enabled;
  }

  // Deterministic 0..1 random.
  _rand() {
    this._rngState = (this._rngState * 1664525 + 1013904223) >>> 0;
    return this._rngState / 4294967296;
  }

  _sheetMaterial(type) {
    if (this._sheetMats[type]) return this._sheetMats[type];
    const water = type === 'water';
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this._uTime,
        uScroll: { value: water ? 7.0 : 1.4 },
        uColDeep: { value: water
          ? new THREE.Color(0.30, 0.55, 0.66)
          : new THREE.Color(0.20, 0.045, 0.02) },
        uColBright: { value: water
          ? new THREE.Color(0.85, 0.95, 1.00)
          : new THREE.Color(1.70, 0.60, 0.12) },   // HDR: feeds bloom
        uColFringe: { value: water
          ? new THREE.Color(1.00, 1.00, 1.00)
          : new THREE.Color(2.30, 0.95, 0.22) },   // ember glow band
        uBaseAlpha: { value: water ? 0.40 : 0.97 },
        uFringeH: { value: water ? 1.7 : 1.4 },
      },
      vertexShader: SHEET_VERT,
      fragmentShader: SHEET_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this._sheetMats[type] = mat;
    return mat;
  }

  _mistMaterial(type) {
    if (this._mistMats[type]) return this._mistMats[type];
    const water = type === 'water';
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this._uTime,
        uColor: { value: water
          ? new THREE.Color(0.82, 0.92, 0.98)
          : new THREE.Color(1.60, 0.55, 0.15) },
        uAlpha: { value: water ? 0.30 : 0.38 },
      },
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: water ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    this._mistMats[type] = mat;
    return mat;
  }

  // addFall({ type, from, to, width }) -> handle. `from` is the lip (top),
  // `to` the landing point (base); both Vector3-like {x,y,z}. The sheet spans
  // from->to, the mist quad + splash emitter sit at `to`.
  addFall({ type = 'water', from, to, width = 3 } = {}) {
    if (type !== 'water' && type !== 'lava') {
      console.warn('FlowFalls.addFall: unknown type "' + type + '"');
      return null;
    }
    if (!from || !to) {
      console.warn('FlowFalls.addFall: from/to are required');
      return null;
    }
    this._sFrom.set(from.x, from.y, from.z);
    this._sTo.set(to.x, to.y, to.z);
    this._sDir.subVectors(this._sTo, this._sFrom);
    const len = this._sDir.length();
    if (len < 0.01) {
      console.warn('FlowFalls.addFall: from and to coincide');
      return null;
    }
    this._sDir.multiplyScalar(1 / len);
    width = Math.max(0.25, Number(width) || 3);

    // Sheet: plane in local XY (v=1 at the lip), local -Y aligned to from->to.
    const hSegs = Math.max(4, Math.min(24, Math.round(len)));
    const geo = new THREE.PlaneGeometry(width, len, 1, hSegs);
    const nVerts = geo.attributes.position.count;
    const info = new Float32Array(nVerts * 2);
    for (let i = 0; i < nVerts; i++) { info[i * 2] = len; info[i * 2 + 1] = width; }
    geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 2));

    this._sQuat.setFromUnitVectors(this._DOWN, this._sDir);
    const sheet = new THREE.Mesh(geo, this._sheetMaterial(type));
    sheet.name = 'FlowFalls.sheet.' + type;
    sheet.position.copy(this._sFrom).add(this._sTo).multiplyScalar(0.5);
    sheet.quaternion.copy(this._sQuat);
    sheet.renderOrder = 6;                 // after the lake surface (5)
    sheet.frustumCulled = false;           // vertex billow exceeds flat bounds
    sheet.userData.noShadow = true;
    this.object3d.add(sheet);

    // Mist: one soft horizontal quad hovering just above the landing point.
    const mistGeo = new THREE.PlaneGeometry(width * 1.9, width * 1.15);
    mistGeo.rotateX(-Math.PI / 2);
    const mist = new THREE.Mesh(mistGeo, this._mistMaterial(type));
    mist.name = 'FlowFalls.mist.' + type;
    mist.position.copy(this._sTo);
    mist.position.y += 0.22;
    mist.renderOrder = 7;
    mist.frustumCulled = false;
    mist.userData.noShadow = true;
    this.object3d.add(mist);

    // World-space side axis of the sheet (splash emitter spreads along it).
    this._sSide.set(1, 0, 0).applyQuaternion(this._sQuat);

    const fall = {
      id: this._nextId++,
      type,
      width,
      baseX: this._sTo.x, baseY: this._sTo.y, baseZ: this._sTo.z,
      sideX: this._sSide.x, sideY: this._sSide.y, sideZ: this._sSide.z,
      rate: type === 'water' ? 26 : 10,    // particles / second
      emitAcc: 0,
      sheet, mist,
      geo, mistGeo,
      removed: false,
    };
    this._falls.push(fall);

    const self = this;
    return {
      id: fall.id,
      type,
      remove() {
        if (fall.removed) return;
        fall.removed = true;
        self.object3d.remove(sheet);
        self.object3d.remove(mist);
        geo.dispose();
        mistGeo.dispose();
        const i = self._falls.indexOf(fall);
        if (i !== -1) self._falls.splice(i, 1);
      },
    };
  }

  _spawn(fall) {
    if (this._alive >= this._cap) return;
    const i = this._alive++;
    const i3 = i * 3;
    const r0 = this._rand(), r1 = this._rand(), r2 = this._rand();
    const r3 = this._rand(), r4 = this._rand();
    const spread = (r0 - 0.5) * fall.width;
    this._pos[i3] = fall.baseX + fall.sideX * spread;
    this._pos[i3 + 1] = fall.baseY + fall.sideY * spread + 0.08;
    this._pos[i3 + 2] = fall.baseZ + fall.sideZ * spread;
    if (fall.type === 'water') {
      this._vel[i3] = (r1 - 0.5) * 1.8;
      this._vel[i3 + 1] = 1.4 + r2 * 2.2;        // spray kicks up
      this._vel[i3 + 2] = (r3 - 0.5) * 1.8;
      this._grav[i] = -9.5;
      this._maxAge[i] = 0.35 + r4 * 0.45;
      this._size[i] = 4.0 + r2 * 4.0;
      this._col[i3] = 0.72; this._col[i3 + 1] = 0.88; this._col[i3 + 2] = 1.0;
    } else {
      this._vel[i3] = (r1 - 0.5) * 1.0;
      this._vel[i3 + 1] = 0.7 + r2 * 1.9;        // embers loft slowly
      this._vel[i3 + 2] = (r3 - 0.5) * 1.0;
      this._grav[i] = -1.1;
      this._maxAge[i] = 0.9 + r4 * 1.0;
      this._size[i] = 2.6 + r2 * 3.0;
      this._col[i3] = 1.8; this._col[i3 + 1] = 0.62 + r1 * 0.3; this._col[i3 + 2] = 0.12;
    }
    this._age[i] = 0;
    this._lifeAttr[i] = 1;
    this._poolDirty = true;
  }

  _kill(i) {
    const last = --this._alive;
    if (i !== last) {
      const i3 = i * 3, l3 = last * 3;
      this._pos[i3] = this._pos[l3];
      this._pos[i3 + 1] = this._pos[l3 + 1];
      this._pos[i3 + 2] = this._pos[l3 + 2];
      this._vel[i3] = this._vel[l3];
      this._vel[i3 + 1] = this._vel[l3 + 1];
      this._vel[i3 + 2] = this._vel[l3 + 2];
      this._col[i3] = this._col[l3];
      this._col[i3 + 1] = this._col[l3 + 1];
      this._col[i3 + 2] = this._col[l3 + 2];
      this._size[i] = this._size[last];
      this._age[i] = this._age[last];
      this._maxAge[i] = this._maxAge[last];
      this._grav[i] = this._grav[last];
      this._lifeAttr[i] = this._lifeAttr[last];
    }
    this._poolDirty = true;
  }

  update(dt, ctx) {
    if (!this._enabled) return;
    const step = Math.max(0, Math.min(0.1, typeof dt === 'number' ? dt : 0.016));
    this._uTime.value += step;

    // Emit from every fall (accumulator per fall; pool-capacity capped).
    for (let f = 0; f < this._falls.length; f++) {
      const fall = this._falls[f];
      fall.emitAcc += fall.rate * step;
      while (fall.emitAcc >= 1) {
        fall.emitAcc -= 1;
        this._spawn(fall);
      }
    }

    // Integrate the pool (typed arrays only; kills swap-with-last in place).
    let i = 0;
    while (i < this._alive) {
      this._age[i] += step;
      if (this._age[i] >= this._maxAge[i]) {
        this._kill(i);
        continue;                          // slot i now holds the swapped-in tail
      }
      const i3 = i * 3;
      this._vel[i3 + 1] += this._grav[i] * step;
      this._pos[i3] += this._vel[i3] * step;
      this._pos[i3 + 1] += this._vel[i3 + 1] * step;
      this._pos[i3 + 2] += this._vel[i3 + 2] * step;
      this._lifeAttr[i] = 1 - this._age[i] / this._maxAge[i];
      i++;
    }

    // Upload: position/life every frame there is activity; colour/size only
    // after spawns or kills reordered the arrays.
    const g = this._pointsGeo;
    if (this._alive > 0 || this._poolDirty) {
      g.attributes.position.needsUpdate = true;
      g.attributes.aLife.needsUpdate = true;
      if (this._poolDirty) {
        g.attributes.aColor.needsUpdate = true;
        g.attributes.aSize.needsUpdate = true;
        this._poolDirty = false;
      }
    }
    g.setDrawRange(0, this._alive);
    this._points.visible = this._alive > 0;
  }

  setEnabled(on) {
    this._enabled = !!on;
    this.object3d.visible = this._enabled;
  }

  dispose() {
    if (this.object3d.parent) this.object3d.parent.remove(this.object3d);
    for (let i = 0; i < this._falls.length; i++) {
      const fall = this._falls[i];
      fall.geo.dispose();
      fall.mistGeo.dispose();
    }
    this._falls.length = 0;
    for (const key of ['water', 'lava']) {
      if (this._sheetMats[key]) { this._sheetMats[key].dispose(); this._sheetMats[key] = null; }
      if (this._mistMats[key]) { this._mistMats[key].dispose(); this._mistMats[key] = null; }
    }
    this._pointsGeo.dispose();
    this._pointsMat.dispose();
    this._alive = 0;
  }
}

export default FlowFalls;
