// graphics-lab/src/shadows.js
//
// SOFT DIRECTIONAL SHADOWS tuned for a voxel scene.
//
// ShadowController wraps an existing THREE.DirectionalLight (the sun — typically
// the one owned by the sky module) and turns it into a crisp, shimmer-free
// shadow caster for the demo chunk:
//
//   - enables renderer.shadowMap with PCFSoftShadowMap + a soft PCF radius,
//   - configures the sun's ORTHOGRAPHIC shadow camera to tightly frame the chunk
//     (~60 world units) with a per-quality frustum + map resolution,
//   - tunes shadow.bias / shadow.normalBias for voxel faces so acne and
//     peter-panning are both killed (normalBias ~half a voxel is the key knob),
//   - RE-CENTERS the shadow frustum on the camera's look target every frame so
//     shadows stay high-resolution as the camera orbits, and TEXEL-SNAPS that
//     center in the light's image plane so the shadow edges don't crawl/swim
//     while the view moves (the classic cascaded-shadow stabilisation trick,
//     applied to a single follow-the-view frustum).
//
// Contract shape (constructor differs — it takes the shared sun):
//   constructor(renderer, sun, { quality } = {})
//   update(dt, ctx)            // ctx = { camera, renderer, scene, sunDir, ... }
//   setEnabled(bool) / get enabled()
//   setQuality('low'|'medium'|'high'|'ultra')
//   applyToScene(scene)        // mark meshes cast/receive (re-callable)
//   dispose()
//
// Everything in update() is allocation-free (scratch vectors are reused).

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Per-quality shadow tuning.
//   mapSize : shadow map resolution (square).
//   frustum : full side length (world units) of the orthographic shadow box.
//             The demo chunk is 48 wide, so ~60-80 covers it with margin; ultra
//             uses a TIGHTER box (more texels per voxel) for the crispest edges.
//   radius  : PCF softness (sample spread in texels).
// ---------------------------------------------------------------------------
const QUALITY = {
  low:    { mapSize: 1024, frustum: 80, radius: 2.0 },
  medium: { mapSize: 2048, frustum: 70, radius: 3.0 },
  high:   { mapSize: 4096, frustum: 64, radius: 3.5 },
  ultra:  { mapSize: 4096, frustum: 52, radius: 4.0 }, // tighter frustum => crisper
};

// Voxel-tuned depth biases. normalBias is in WORLD units: ~half a voxel pushes
// the shadow lookup off flat faces enough to remove acne without the shadow
// visibly detaching (peter-panning) from thin geometry.
const SHADOW_BIAS = -0.0005;
const SHADOW_NORMAL_BIAS = 0.5;

const UP = new THREE.Vector3(0, 1, 0);
const ALT_UP = new THREE.Vector3(0, 0, 1); // used when the sun is near-vertical

export class ShadowController {
  constructor(renderer, sun, { quality = 'medium', groundY = 14, center = null, lightDistance = 140 } = {}) {
    if (!sun || !sun.isDirectionalLight) {
      throw new Error('ShadowController: second argument must be a THREE.DirectionalLight');
    }

    this._renderer = renderer || null;
    this.sun = sun;
    this._enabled = true;
    this._scene = null; // cached from update(), used when toggling enabled

    // Follow-the-view focus tuning.
    this._groundY = groundY;                 // plane the look-ray is projected onto
    this._center = center ? center.clone() : new THREE.Vector3(24, groundY, 24);
    this._lightDist = lightDistance;         // sun distance from the framed focus
    this._focusFallbackDist = 55;            // used if the look-ray misses the plane
    this._maxFocusDist = 260;
    this._maxFocusRadius = 10;               // focus never strays further than this
                                             // from the chunk center (see update)

    // Reused scratch (no per-frame allocation).
    this._sunDir = new THREE.Vector3(0, 1, 0.2).normalize(); // toward the sun
    this._focus = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._upv = new THREE.Vector3();

    // Current quality-derived numbers (filled by setQuality).
    this._quality = 'medium';
    this._mapSize = 2048;
    this._frustum = 70;
    this._radius = 3.0;

    // --- Renderer shadow map -------------------------------------------------
    if (this._renderer) {
      this._renderer.shadowMap.enabled = true;
      this._renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this._renderer.shadowMap.autoUpdate = true;
    }

    // --- Sun / shadow camera baseline ---------------------------------------
    sun.castShadow = true;
    sun.shadow.bias = SHADOW_BIAS;
    sun.shadow.normalBias = SHADOW_NORMAL_BIAS;

    // Apply the quality tier (mapSize + orthographic frustum + PCF radius).
    this.setQuality(quality);

    // Seed the shadow-camera pose once so shadows are correct before the first
    // update() (e.g. if the host renders a frame before ticking effects).
    this._reposition(this._center.clone());
  }

  get enabled() {
    return this._enabled;
  }

  // -------------------------------------------------------------------------
  // Quality: reconfigure map resolution + orthographic frustum at runtime.
  // Disposing the existing shadow map forces the renderer to reallocate at the
  // new resolution on the next shadow pass.
  // -------------------------------------------------------------------------
  setQuality(q) {
    const cfg = QUALITY[q] || QUALITY.medium;
    this._quality = QUALITY[q] ? q : 'medium';
    this._mapSize = cfg.mapSize;
    this._frustum = cfg.frustum;
    this._radius = cfg.radius;

    const shadow = this.sun.shadow;

    // Resolution — free the old map so the renderer rebuilds it at the new size.
    if (shadow.mapSize.x !== cfg.mapSize || shadow.mapSize.y !== cfg.mapSize) {
      shadow.mapSize.set(cfg.mapSize, cfg.mapSize);
      if (shadow.map) {
        shadow.map.dispose();
        shadow.map = null;
      }
    }

    // Orthographic frustum: a box of side `frustum`, deep enough along the light
    // axis to bracket the chunk from either the near or far side.
    const half = cfg.frustum * 0.5;
    const cam = shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = Math.max(0.5, this._lightDist - cfg.frustum);
    cam.far = this._lightDist + cfg.frustum;
    cam.updateProjectionMatrix();

    // PCF softness.
    shadow.radius = cfg.radius;
    shadow.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Enable / disable cleanly: toggles both the sun's caster flag and the
  // renderer's global shadow map. Toggling shadowMap.enabled changes which
  // shader chunks materials compile, so any cached scene materials are flagged
  // for a one-time recompile.
  // -------------------------------------------------------------------------
  setEnabled(on) {
    on = !!on;
    if (on === this._enabled && this._renderer &&
        this._renderer.shadowMap.enabled === on) {
      // still keep the caster flag coherent
      this.sun.castShadow = on;
      this._enabled = on;
      return;
    }
    this._enabled = on;
    this.sun.castShadow = on;
    if (this._renderer) {
      this._renderer.shadowMap.enabled = on;
      this._renderer.shadowMap.needsUpdate = true;
    }
    this._recompileMaterials();
  }

  // -------------------------------------------------------------------------
  // Per-frame: keep the light direction = ctx.sunDir and re-center the shadow
  // frustum on where the camera is looking, texel-snapped for stability.
  // -------------------------------------------------------------------------
  update(dt, ctx) {
    if (!ctx) return;
    if (ctx.scene) this._scene = ctx.scene;

    // Make sure the light target participates in the scene graph so its world
    // matrix (and therefore the shadow camera's look-at) updates.
    if (ctx.scene && this.sun.target && !this.sun.target.parent) {
      ctx.scene.add(this.sun.target);
    }

    if (!this._enabled) return;

    // 1) Light direction from the shared sun vector (points toward the sun).
    if (ctx.sunDir && ctx.sunDir.isVector3) {
      this._sunDir.copy(ctx.sunDir);
      if (this._sunDir.lengthSq() < 1e-8) this._sunDir.set(0, 1, 0.2);
      this._sunDir.normalize();
    }

    // 2) Where is the camera looking? Project its view ray onto the ground plane
    //    (OrbitControls always points the camera straight at its target, so this
    //    recovers the orbit target); fall back to a fixed distance / the chunk
    //    center if the ray does not hit the plane.
    if (ctx.camera) {
      this._computeFocus(ctx.camera, this._focus);
    } else {
      this._focus.copy(this._center);
    }

    // 2b) CLAMP the focus to a small radius around the authored chunk center.
    //     A shallow-pitched camera (the 'hero' view looks down only ~8 deg)
    //     lands its ground-ray far BEYOND the island, which used to drag the
    //     whole +-35u shadow frustum off the terrain — no visible shadows at
    //     all. The island is only 48 wide, so the frustum must stay centred
    //     on it; the follow-the-view offset is capped at maxFocusRadius.
    {
      const ox = this._focus.x - this._center.x;
      const oz = this._focus.z - this._center.z;
      const od = Math.sqrt(ox * ox + oz * oz);
      if (od > this._maxFocusRadius) {
        const s = this._maxFocusRadius / od;
        this._focus.x = this._center.x + ox * s;
        this._focus.z = this._center.z + oz * s;
      }
    }

    // 3) Texel-snap the focus in the light's image plane to stop edge crawl.
    this._snapFocus(this._focus);

    // 4) Drive the light + shadow camera pose.
    this._reposition(this._focus);
  }

  // --- internal helpers ----------------------------------------------------

  _computeFocus(camera, out) {
    camera.getWorldPosition(this._camPos);
    camera.getWorldDirection(this._forward); // normalized look direction

    const fy = this._forward.y;
    let t = NaN;
    if (Math.abs(fy) > 1e-4) {
      t = (this._groundY - this._camPos.y) / fy;
    }
    if (!(t > 0) || t > this._maxFocusDist) {
      // Ray misses the plane (looking up / parallel): use a fixed distance ahead.
      t = this._focusFallbackDist;
      out.copy(this._forward).multiplyScalar(t).add(this._camPos);
      // Nudge toward the known chunk center so we never frame empty sky.
      out.lerp(this._center, 0.5);
      return out;
    }
    out.copy(this._forward).multiplyScalar(t).add(this._camPos);
    return out;
  }

  // Snap `focus` to shadow-map texel increments within the plane perpendicular
  // to the light direction (depth along the light is left untouched). This is
  // what keeps a moving frustum's shadows from swimming.
  _snapFocus(focus) {
    const dir = this._sunDir;
    const up = Math.abs(dir.y) > 0.99 ? ALT_UP : UP;
    this._right.crossVectors(up, dir).normalize();
    this._upv.crossVectors(dir, this._right).normalize();

    const texel = this._frustum / this._mapSize; // world units per shadow texel
    let sx = focus.dot(this._right);
    let sy = focus.dot(this._upv);
    const sd = focus.dot(dir);
    sx = Math.round(sx / texel) * texel;
    sy = Math.round(sy / texel) * texel;

    focus.set(0, 0, 0)
      .addScaledVector(this._right, sx)
      .addScaledVector(this._upv, sy)
      .addScaledVector(dir, sd);
  }

  // Place the sun at `focus + sunDir * dist`, aim it at `focus`, and refresh the
  // world matrices the shadow camera reads from.
  _reposition(focus) {
    this.sun.position.copy(focus).addScaledVector(this._sunDir, this._lightDist);
    if (this.sun.target) {
      this.sun.target.position.copy(focus);
      this.sun.target.updateMatrixWorld();
    }
    this.sun.updateMatrixWorld();
  }

  // Flag cached scene materials for recompile after shadowMap.enabled flips.
  _recompileMaterials() {
    const scene = this._scene;
    if (!scene) return;
    scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const m = o.material;
      if (Array.isArray(m)) {
        for (const mm of m) if (mm) mm.needsUpdate = true;
      } else {
        m.needsUpdate = true;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Mark scene meshes as shadow casters / receivers. RE-CALLABLE: safe to run
  // again after new meshes (e.g. water) are added.
  //   - terrain / props : cast + receive
  //   - water           : receive only (translucent water casting a hard shadow
  //                       looks wrong; it still catches shadows from above)
  //   - sky dome / stars / clouds / sprites : skipped entirely
  // -------------------------------------------------------------------------
  applyToScene(scene) {
    if (!scene) return;
    scene.traverse((child) => {
      if (!child.isMesh) return;               // Points/Sprites/Lines never shadow
      if (this._isExcluded(child)) return;     // skip the sky rig

      if (this._looksLikeWater(child)) {
        child.castShadow = false;
        child.receiveShadow = true;
      } else {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    if (this._renderer) this._renderer.shadowMap.needsUpdate = true;
  }

  _isExcluded(child) {
    if (child.userData && (child.userData.noShadow || child.userData.excludeFromShadows)) {
      return true;
    }
    // Walk ancestors: skip anything under the sky group (dome/stars/clouds).
    let n = child;
    while (n) {
      const name = n.name || '';
      if (/sky|cloud|dome|star/i.test(name)) return true;
      n = n.parent;
    }
    return false;
  }

  _looksLikeWater(child) {
    if (child.userData && (child.userData.water === true || child.userData.isWater === true)) {
      return true;
    }
    if (/water/i.test(child.name || '')) return true;
    const m = child.material;
    if (m && !Array.isArray(m) && /water/i.test(m.name || '')) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  dispose() {
    const shadow = this.sun && this.sun.shadow;
    if (shadow && shadow.map) {
      shadow.map.dispose();
      shadow.map = null;
    }
    if (this.sun) this.sun.castShadow = false;
    this._scene = null;
  }
}

export default ShadowController;
