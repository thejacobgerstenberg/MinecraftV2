import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Particles — a small, self-contained, POOLED particle system for mob VFX
// (death poofs, spawn shimmers, boss bursts, exploder sparks).
//
// Loomfall lore: Warpwold creatures don't bleed or gore when they die — they
// UNRAVEL. A dying creature's body comes apart into loose strands of its own
// thread-color, spiraling outward and drifting down like a spool coming
// undone. This module only renders that unraveling; it holds no gameplay
// logic and can be swapped for the graphics team's real particle system
// later without touching any caller — just keep the same public API
// (constructor(scene, opts), emitUnravel/emitShimmer/emitBurst/emitSparks,
// update(dt), dispose()).
//
// Implementation notes:
//  - Pool of plain Mesh(BoxGeometry, MeshBasicMaterial) particles (a fixed
//    THREE class combo guaranteed to exist in mobs/vendor/three.module.js
//    and to render under headless SwiftShader WebGL). THREE.Points was
//    considered, but a mesh pool gives independent per-particle scale/
//    rotation/opacity, which reads much better for "threads unraveling"
//    than uniform screen-space points, at this particle count (<=400).
//  - Every particle uses its OWN MeshBasicMaterial instance (transparent:
//    true) so opacity can be faded per-particle without materials bleeding
//    into each other; geometry is a single shared unit BoxGeometry scaled
//    per-instance via mesh.scale, so no per-emit geometry allocation.
//  - The pool is preallocated once (default 400 meshes), added to the scene
//    up front, and hidden (visible = false) until claimed by an emit call.
//  - Dead/finished particles are recycled back into the free pool in
//    update(dt); if the pool is exhausted, new emits are simply skipped
//    (cheap, no dynamic growth, no leaks).
// ---------------------------------------------------------------------------

const DEFAULT_POOL_SIZE = 400;

// Per-particle behavior kinds.
const KIND_UNRAVEL = 'unravel';
const KIND_SHIMMER = 'shimmer';
const KIND_BURST = 'burst';
const KIND_SPARK = 'spark';

export class Particles {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts]
   * @param {number} [opts.poolSize=400] max simultaneously-live particles
   * @param {number} [opts.particleSize=0.06] base edge length of a particle cube
   */
  constructor(scene, opts = {}) {
    this.scene = scene || null;
    this.poolSize = Math.max(1, opts.poolSize | 0 || DEFAULT_POOL_SIZE);
    this.particleSize = opts.particleSize || 0.06;

    // Shared unit geometry (edge length 1); per-particle size comes from
    // mesh.scale, so we never allocate new geometry per emit.
    this._geometry = new THREE.BoxGeometry(1, 1, 1);

    this._group = new THREE.Group();
    this._group.name = 'Particles.pool';

    this._pool = new Array(this.poolSize);
    this._free = []; // indices into _pool that are currently unused
    for (let i = 0; i < this.poolSize; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this._geometry, material);
      mesh.visible = false;
      mesh.matrixAutoUpdate = true;
      this._group.add(mesh);

      this._pool[i] = {
        mesh,
        material,
        alive: false,
        kind: null,
        age: 0,
        life: 0,
        vel: new THREE.Vector3(),
        gravity: 0,
        spin: 0,
        baseScale: this.particleSize,
        growth: 1, // scale multiplier over lifetime end vs start
        angle: 0, // for spiral motion
        angularVel: 0,
        radius: 0,
        radiusGrowth: 0,
        center: new THREE.Vector3(),
        startOpacity: 1,
      };
      this._free.push(i);
    }

    if (this.scene) {
      this.scene.add(this._group);
    }

    this._live = new Set(); // indices into _pool currently animating
  }

  // -- internal: claim a pooled particle, or null if the pool is exhausted.
  _claim() {
    if (this._free.length === 0) return null;
    const idx = this._free.pop();
    this._live.add(idx);
    return this._pool[idx];
  }

  // -- internal: return a particle to the free pool.
  _release(idx) {
    const p = this._pool[idx];
    p.alive = false;
    p.mesh.visible = false;
    this._live.delete(idx);
    this._free.push(idx);
  }

  // -- internal: shared setup for a single emitted particle.
  _spawn({ pos, color, kind, life, vel, gravity = 0, spin = 0, baseScale,
    growth = 1, angularVel = 0, radius = 0, radiusGrowth = 0, startOpacity = 1 }) {
    const p = this._claim();
    if (!p) return; // pool exhausted; skip silently (cheap, no growth)

    p.alive = true;
    p.kind = kind;
    p.age = 0;
    p.life = Math.max(0.0001, life);
    p.vel.copy(vel);
    p.gravity = gravity;
    p.spin = spin;
    p.baseScale = baseScale;
    p.growth = growth;
    p.angle = Math.random() * Math.PI * 2;
    p.angularVel = angularVel;
    p.radius = radius;
    p.radiusGrowth = radiusGrowth;
    p.center.copy(pos);
    p.startOpacity = startOpacity;

    p.mesh.position.copy(pos);
    p.mesh.rotation.set(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2
    );
    p.mesh.scale.setScalar(baseScale);
    p.mesh.visible = true;
    p.material.color.set(color);
    p.material.opacity = startOpacity;
  }

  /**
   * "Thread-unravel poof" — a dying creature comes apart into loose thread.
   * Particles spiral outward, drift down, and fade. Lifetime ~0.8s.
   * @param {THREE.Vector3|{x,y,z}} pos world-space origin
   * @param {number|THREE.Color} color species palette color
   * @param {number} [count=24]
   */
  emitUnravel(pos, color, count = 24) {
    if (!this.scene || !pos) return;
    const life = 0.8;
    for (let i = 0; i < count; i++) {
      const outward = 0.6 + Math.random() * 1.1;
      const vel = new THREE.Vector3(0, 0.35 + Math.random() * 0.5, 0);
      this._spawn({
        pos,
        color,
        kind: KIND_UNRAVEL,
        life: life * (0.75 + Math.random() * 0.5),
        vel,
        gravity: -1.1,
        spin: (Math.random() - 0.5) * 6,
        baseScale: this.particleSize * (0.7 + Math.random() * 0.7),
        growth: 0.35, // shrinks toward end of life
        angularVel: (Math.random() < 0.5 ? -1 : 1) * (2.2 + Math.random() * 2.5),
        radius: 0.02,
        radiusGrowth: outward,
        startOpacity: 0.95,
      });
    }
  }

  /**
   * Soft spawn shimmer — particles rise gently and fade. Lifetime ~0.5s.
   * @param {THREE.Vector3|{x,y,z}} pos
   * @param {number|THREE.Color} color
   * @param {number} [count=12]
   */
  emitShimmer(pos, color, count = 12) {
    if (!this.scene || !pos) return;
    const life = 0.5;
    for (let i = 0; i < count; i++) {
      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 0.3,
        0.5 + Math.random() * 0.4,
        (Math.random() - 0.5) * 0.3
      );
      this._spawn({
        pos,
        color,
        kind: KIND_SHIMMER,
        life: life * (0.8 + Math.random() * 0.4),
        vel,
        gravity: 0.15, // gentle upward buoyancy relative to unravel's fall
        spin: (Math.random() - 0.5) * 3,
        baseScale: this.particleSize * (0.5 + Math.random() * 0.4),
        growth: 1.4, // gently grows as it rises
        angularVel: 0,
        radius: 0,
        radiusGrowth: 0,
        startOpacity: 0.85,
      });
    }
  }

  /**
   * Boss phase-transition burst — fast radial explosion.
   * @param {THREE.Vector3|{x,y,z}} pos
   * @param {number|THREE.Color} color
   * @param {number} [count=40]
   */
  emitBurst(pos, color, count = 40) {
    if (!this.scene || !pos) return;
    const life = 0.6;
    for (let i = 0; i < count; i++) {
      // Roughly uniform spherical direction.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = 2.5 + Math.random() * 2.5;
      const vel = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta) * speed,
        Math.cos(phi) * speed * 0.5 + 0.5,
        Math.sin(phi) * Math.sin(theta) * speed
      );
      this._spawn({
        pos,
        color,
        kind: KIND_BURST,
        life: life * (0.7 + Math.random() * 0.5),
        vel,
        gravity: -2.5,
        spin: (Math.random() - 0.5) * 10,
        baseScale: this.particleSize * (0.8 + Math.random() * 0.8),
        growth: 0.4,
        angularVel: 0,
        radius: 0,
        radiusGrowth: 0,
        startOpacity: 1,
      });
    }
  }

  /**
   * Small hot sparks (exploder fuse) — short-lived, quick, sharp.
   * @param {THREE.Vector3|{x,y,z}} pos
   * @param {number|THREE.Color} color
   * @param {number} [count=8]
   */
  emitSparks(pos, color, count = 8) {
    if (!this.scene || !pos) return;
    const life = 0.25;
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const speed = 1.2 + Math.random() * 1.8;
      const vel = new THREE.Vector3(
        Math.cos(theta) * speed,
        0.8 + Math.random() * 1.2,
        Math.sin(theta) * speed
      );
      this._spawn({
        pos,
        color,
        kind: KIND_SPARK,
        life: life * (0.6 + Math.random() * 0.6),
        vel,
        gravity: -3.5,
        spin: (Math.random() - 0.5) * 14,
        baseScale: this.particleSize * (0.35 + Math.random() * 0.35),
        growth: 0.5,
        angularVel: 0,
        radius: 0,
        radiusGrowth: 0,
        startOpacity: 1,
      });
    }
  }

  /**
   * Advance all live particles by dt seconds: move, fade, shrink/grow,
   * recycle when their lifetime elapses. Cheap — a single pass over the
   * currently-live set only (dead/free particles cost nothing).
   * @param {number} dt seconds elapsed since last update
   */
  update(dt) {
    if (!dt || dt <= 0 || this._live.size === 0) return;

    for (const idx of this._live) {
      const p = this._pool[idx];
      p.age += dt;

      if (p.age >= p.life) {
        this._release(idx);
        continue;
      }

      const t = p.age / p.life; // 0..1 lifetime progress

      // Integrate simple ballistic motion: vel += gravity*dt, pos += vel*dt.
      p.vel.y += p.gravity * dt;
      p.center.x += p.vel.x * dt;
      p.center.y += p.vel.y * dt;
      p.center.z += p.vel.z * dt;

      // Spiral component (unravel / decorative twist around travel path).
      let x = p.center.x;
      let z = p.center.z;
      if (p.angularVel !== 0 || p.radiusGrowth !== 0) {
        p.angle += p.angularVel * dt;
        p.radius += p.radiusGrowth * dt;
        x += Math.cos(p.angle) * p.radius;
        z += Math.sin(p.angle) * p.radius;
      }

      p.mesh.position.set(x, p.center.y, z);

      if (p.spin) {
        p.mesh.rotation.x += p.spin * dt;
        p.mesh.rotation.y += p.spin * dt * 0.7;
      }

      // Fade opacity out over lifetime; scale shrinks or grows via growth.
      const scale = p.baseScale * (1 + (p.growth - 1) * t);
      p.mesh.scale.setScalar(Math.max(0.0001, scale));
      p.material.opacity = p.startOpacity * (1 - t);
    }
  }

  /** Remove the pool from the scene and free all geometry/materials. */
  dispose() {
    if (this.scene && this._group) {
      this.scene.remove(this._group);
    }
    for (const p of this._pool) {
      p.material.dispose();
    }
    if (this._geometry) {
      this._geometry.dispose();
    }
    this._pool.length = 0;
    this._free.length = 0;
    this._live.clear();
    this.scene = null;
  }
}
