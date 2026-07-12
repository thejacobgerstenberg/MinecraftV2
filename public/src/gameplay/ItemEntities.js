// Loomfall — dropped-item entities (survival mode).
//
// Small spinning cubes that fall with gravity, rest on the ground, merge
// with nearby same-id drops, despawn after 5 minutes, and are picked up by
// walking within PICKUP_RANGE. Spawn sources: block breaks (numeric engine
// block ids — textured with a crop of the block's atlas side tile), mob
// loot / player Q-drops (string content item ids — rendered as a small
// woven-sack texture tinted by an id hash; documented v1 choice, real item
// art can replace `drawSackIcon`).
//
// MULTIPLAYER NOTE (v1 simplification, docs/PROTOCOL.md): item entities are
// LOCAL-ONLY — each client simulates and picks up its own drops; block-edit
// sync remains the authoritative world state. A server-owned entity channel
// is a documented follow-up.

import * as THREE from 'three';
import { getBlockDef, tileForFace } from '../blocks/blocks.js';

export const PICKUP_RANGE = 1.5;   // blocks, from the player AABB center
export const DESPAWN_S = 300;      // 5 minutes
export const MERGE_RANGE = 0.9;    // same-id drops within this merge
const GRAVITY = 22;                // blocks/s^2 (matches the feel of debris)
const ENTITY_SIZE = 0.3;           // cube edge
const MAX_ENTITIES = 200;          // oldest culled beyond this
const SPIN_SPEED = 1.8;            // rad/s idle spin
const BOB_AMPL = 0.045;            // idle bob amplitude while resting
const FRICTION = 6;                // horizontal damping when resting

/** FNV-1a 32-bit hash for string-item tinting. */
function hashId(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Procedural sack icon for string item ids, tinted by id hash. Exported so
 *  the HUD/inventory UI renders the SAME icon for the same item id. */
export function drawSackIcon(id) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const hue = hashId(id) % 360;
  // Pouch body.
  g.fillStyle = `hsl(${hue}, 45%, 42%)`;
  g.fillRect(6, 10, 20, 18);
  g.fillStyle = `hsl(${hue}, 50%, 55%)`;
  g.fillRect(6, 10, 20, 5);
  g.fillStyle = `hsl(${hue}, 40%, 30%)`;
  g.fillRect(6, 24, 20, 4);
  // Neck + tie.
  g.fillStyle = `hsl(${hue}, 35%, 35%)`;
  g.fillRect(12, 6, 8, 5);
  g.fillStyle = `hsl(${(hue + 40) % 360}, 60%, 65%)`;
  g.fillRect(11, 9, 10, 2);
  // Stitch marks.
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let x = 8; x < 26; x += 4) g.fillRect(x, 17, 2, 1);
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.lineWidth = 1;
  g.strokeRect(6.5, 10.5, 19, 17);
  return c;
}

/**
 * Manager for the local item-entity population. Construct once per game
 * session; `dispose()` on teardown, `clear()` on dimension travel.
 */
export class ItemEntities {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts
   * @param {() => {getBlock:(x,y,z)=>number}} opts.getWorld live world getter
   * @param {object} opts.atlas buildAtlas() result (canvas/tilePx/cols/tileIndex)
   */
  constructor(scene, { getWorld, atlas }) {
    this.scene = scene;
    this.getWorld = getWorld;
    this.atlas = atlas;
    this.group = new THREE.Group();
    this.group.name = 'item-entities';
    scene.add(this.group);
    /** @type {Array<object>} live entities */
    this.entities = [];
    this._geo = new THREE.BoxGeometry(ENTITY_SIZE, ENTITY_SIZE, ENTITY_SIZE);
    this._materials = new Map(); // icon key -> {material, texture}
    this._elapsed = 0;
  }

  /** Material for an item id (cached; block tile crop or tinted sack). */
  _materialFor(id) {
    const key = typeof id === 'number' ? `b:${id}` : `i:${id}`;
    const hit = this._materials.get(key);
    if (hit) return hit.material;
    let canvas;
    if (typeof id === 'number') {
      const def = getBlockDef(id);
      const tile = tileForFace(def, 'side') ?? tileForFace(def, 'top');
      canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      try {
        const i = this.atlas.tileIndex(tile);
        const px = this.atlas.tilePx;
        ctx.drawImage(this.atlas.canvas,
          (i % this.atlas.cols) * px, Math.floor(i / this.atlas.cols) * px,
          px, px, 0, 0, 32, 32);
      } catch {
        ctx.fillStyle = '#888';
        ctx.fillRect(0, 0, 32, 32);
      }
    } else {
      canvas = drawSackIcon(id);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    const material = new THREE.MeshBasicMaterial({ map: texture });
    this._materials.set(key, { material, texture });
    return material;
  }

  /**
   * Spawn a drop. `pos` is the entity CENTER; `vel` optional initial
   * velocity (Q-toss); `pickupDelay` seconds before walk-over pickup.
   * @returns {object} the entity record
   */
  spawn(id, count, pos, { vel = null, pickupDelay = 0.5 } = {}) {
    const n = Math.max(1, Math.floor(count) || 1);
    // Merge into an existing resting same-id entity nearby.
    for (const e of this.entities) {
      if (e.id === id &&
          Math.hypot(e.pos.x - pos.x, e.pos.y - pos.y, e.pos.z - pos.z) <= MERGE_RANGE) {
        e.count += n;
        e.age = 0; // merging refreshes the despawn clock
        return e;
      }
    }
    const mesh = new THREE.Mesh(this._geo, this._materialFor(id));
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    this.group.add(mesh);
    const e = {
      id,
      count: n,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      vel: vel
        ? { x: vel.x, y: vel.y, z: vel.z }
        : { x: (Math.random() - 0.5) * 1.4, y: 2.4, z: (Math.random() - 0.5) * 1.4 },
      age: 0,
      pickupDelay,
      resting: false,
      mesh,
    };
    this.entities.push(e);
    // Population cap: cull the oldest.
    if (this.entities.length > MAX_ENTITIES) {
      this._remove(this.entities.reduce((a, b) => (a.age >= b.age ? a : b)));
    }
    return e;
  }

  _remove(e) {
    const i = this.entities.indexOf(e);
    if (i !== -1) this.entities.splice(i, 1);
    this.group.remove(e.mesh);
  }

  /** True when the block cell is solid ground for a drop. */
  _solidAt(x, y, z) {
    const world = this.getWorld();
    const def = getBlockDef(world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
    return def.solid && !def.liquid;
  }

  /**
   * Per-frame simulation + walk-over pickup.
   * @param {number} dt seconds
   * @param {{x:number,y:number,z:number}|null} playerCenter player AABB
   *   center (feet + size/2 horizontally, mid-height vertically)
   * @param {(id: number|string, count: number) => number} [tryPickup]
   *   returns how many were actually taken (inventory may be full)
   */
  update(dt, playerCenter, tryPickup) {
    const half = ENTITY_SIZE / 2;
    this._elapsed += dt;
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      e.age += dt;
      if (e.pickupDelay > 0) e.pickupDelay -= dt;
      if (e.age >= DESPAWN_S || e.pos.y < -12) { this._remove(e); continue; }

      // Physics: gravity + ground rest (block below the cube's bottom).
      e.vel.y -= GRAVITY * dt;
      let nx = e.pos.x + e.vel.x * dt;
      let ny = e.pos.y + e.vel.y * dt;
      let nz = e.pos.z + e.vel.z * dt;
      if (e.vel.y <= 0 && this._solidAt(nx, ny - half, nz)) {
        ny = Math.floor(ny - half) + 1 + half;
        e.vel.y = 0;
        e.resting = true;
        // Ground friction on the toss velocity.
        const f = Math.max(0, 1 - FRICTION * dt);
        e.vel.x *= f;
        e.vel.z *= f;
      } else if (e.vel.y > 0.01 || !this._solidAt(e.pos.x, e.pos.y - half - 0.05, e.pos.z)) {
        e.resting = false;
      }
      // Sideways block collision: simply stop horizontal motion.
      if ((e.vel.x || e.vel.z) && this._solidAt(nx, ny, nz)) {
        nx = e.pos.x;
        nz = e.pos.z;
        e.vel.x = 0;
        e.vel.z = 0;
      }
      e.pos.x = nx; e.pos.y = ny; e.pos.z = nz;

      // Pickup.
      if (tryPickup && playerCenter && e.pickupDelay <= 0) {
        const d = Math.hypot(
          e.pos.x - playerCenter.x, e.pos.y - playerCenter.y, e.pos.z - playerCenter.z);
        if (d <= PICKUP_RANGE) {
          const taken = tryPickup(e.id, e.count) | 0;
          if (taken >= e.count) { this._remove(e); continue; }
          if (taken > 0) e.count -= taken;
          // Inventory full: the entity stays on the ground.
        }
      }

      // Visuals: spin + rest bob.
      e.mesh.position.set(
        e.pos.x,
        e.pos.y + (e.resting ? BOB_AMPL * (1 + Math.sin(this._elapsed * 2.2 + e.mesh.rotation.y)) : 0),
        e.pos.z);
      e.mesh.rotation.y += SPIN_SPEED * dt;
    }
  }

  /** QA snapshot: [{id, count, x, y, z, age, resting}]. */
  list() {
    return this.entities.map((e) => ({
      id: e.id, count: e.count, x: e.pos.x, y: e.pos.y, z: e.pos.z,
      age: e.age, resting: e.resting,
    }));
  }

  /** Remove every entity (dimension travel — the world is replaced). */
  clear() {
    for (const e of this.entities.splice(0)) this.group.remove(e.mesh);
  }

  dispose() {
    this.clear();
    this.scene.remove(this.group);
    this._geo.dispose();
    for (const { material, texture } of this._materials.values()) {
      texture.dispose();
      material.dispose();
    }
    this._materials.clear();
  }
}

export default ItemEntities;
