// avatars/peer-avatars.js
// Scene-owning remote-player manager: a drop-in replacement for the game's
// public/src/net/PeerAvatars.js, layered over the createAvatar factory.

import * as THREE from "three";
import { createAvatar } from "./avatars.js";

/**
 * Column-centering offset (metres). Incoming peer coords are block/feet coords
 * whose column AABB is 0.6 wide; the host centres the avatar in that column by
 * adding +0.3 to X and Z. Y is the feet height and is used as-is.
 */
const COLUMN_CENTER = 0.3;

/** Manager-side smoothing rate (1/s) for the exponential ease toward targets. */
const SMOOTH_RATE = 12;

/** Coerce to a finite number or return the fallback. */
function num(v, fallback) {
  v = Number(v);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Manages every remote-player avatar in a scene: creates one deterministic
 * avatar per network peer, eases each toward its latest target transform, and
 * derives the walk animation from the smoothed motion. Owns the scene handle
 * and a Map<id, entry>. Never throws.
 *
 * Public surface (matches the host's PeerAvatars manager exactly):
 *   upsert({id, name, x, y, z, yaw, dim})  add or retarget
 *   move({id, x, y, z, yaw, dim})          retarget the lerp target
 *   remove(id)                             dispose + detach one peer
 *   setDimension(dim)                      show only peers in `dim`
 *   update(dt)                             manager-side smoothing + animation
 *   get count / get ids                    peer count / id list
 *   dispose()                              remove + dispose every peer
 */
export class PeerAvatars {
  /**
   * @param {THREE.Scene} scene - the scene this manager adds avatar groups to.
   */
  constructor(scene) {
    this.scene = scene || null;
    /** @type {Map<string, {handle:object, group:THREE.Group, dim:string,
     *   curX:number, curY:number, curZ:number, curYaw:number,
     *   tgtX:number, tgtY:number, tgtZ:number, tgtYaw:number}>} */
    this.peers = new Map();
    /** Local player's current dimension; only peers in it are visible. */
    this.localDim = "overworld";
  }

  /**
   * Add a new peer or retarget an existing one. Unknown id -> createAvatar
   * (skin seeded off the network `id` so every client renders the peer
   * identically), group named `peer:${id}`, added to the scene, and snapped to
   * the target on first insert. Known id -> retarget only. Null/undefined id is
   * a no-op. Extra fields (e.g. pitch) are tolerated. Never throws.
   * @param {{id:string, name?:string, x?:number, y?:number, z?:number,
   *   yaw?:number, dim?:string}} data
   */
  upsert(data) {
    const d = data && typeof data === "object" ? data : {};
    const id = d.id;
    if (id == null) return; // ignore null/undefined id

    const x = num(d.x, 0);
    const y = num(d.y, 0);
    const z = num(d.z, 0);
    const yaw = num(d.yaw, 0);
    const dim = typeof d.dim === "string" && d.dim ? d.dim : "overworld";

    const tgtX = x + COLUMN_CENTER;
    const tgtZ = z + COLUMN_CENTER;

    let entry = this.peers.get(id);
    if (!entry) {
      let handle = null;
      try {
        // Seed the skin off the network id (NOT a skinSeed field) — deterministic
        // per peer, so every client draws this peer the same way.
        handle = createAvatar({ name: d.name, skinSeed: String(id) });
      } catch (_e) {
        handle = null;
      }
      if (!handle) return;

      const group = handle.group;
      try {
        group.name = `peer:${id}`;
      } catch (_e) {
        /* ignore */
      }

      entry = {
        handle,
        group,
        dim,
        // Snap current == target on first insert (no lerp-in from origin).
        curX: tgtX,
        curY: y,
        curZ: tgtZ,
        curYaw: yaw,
        tgtX,
        tgtY: y,
        tgtZ,
        tgtYaw: yaw,
      };
      this.peers.set(id, entry);

      try {
        handle.setPosition(entry.curX, entry.curY, entry.curZ);
      } catch (_e) {
        /* ignore */
      }
      try {
        handle.setLook(entry.curYaw, 0);
      } catch (_e) {
        /* ignore */
      }
      try {
        group.visible = entry.dim === this.localDim;
      } catch (_e) {
        /* ignore */
      }
      try {
        if (this.scene && this.scene.add) this.scene.add(group);
      } catch (_e) {
        /* ignore */
      }
    } else {
      // Known peer: retarget only (smoothing eases current -> target).
      entry.tgtX = tgtX;
      entry.tgtY = y;
      entry.tgtZ = tgtZ;
      entry.tgtYaw = yaw;
      entry.dim = dim;
      try {
        entry.group.visible = entry.dim === this.localDim;
      } catch (_e) {
        /* ignore */
      }
    }
  }

  /**
   * Retarget the lerp target for a known peer. Each of x/y/z/yaw is applied only
   * if Number.isFinite; dim is applied only if a non-empty string. No-op if the
   * id is unknown. Never throws.
   * @param {{id:string, x?:number, y?:number, z?:number, yaw?:number,
   *   dim?:string}} data
   */
  move(data) {
    const d = data && typeof data === "object" ? data : {};
    const entry = this.peers.get(d.id);
    if (!entry) return; // no-op for unknown id

    if (Number.isFinite(d.x)) entry.tgtX = d.x + COLUMN_CENTER;
    if (Number.isFinite(d.y)) entry.tgtY = d.y;
    if (Number.isFinite(d.z)) entry.tgtZ = d.z + COLUMN_CENTER;
    if (Number.isFinite(d.yaw)) entry.tgtYaw = d.yaw;
    if (typeof d.dim === "string" && d.dim) {
      entry.dim = d.dim;
      try {
        entry.group.visible = entry.dim === this.localDim;
      } catch (_e) {
        /* ignore */
      }
    }
  }

  /**
   * Dispose a peer's avatar (frees geometry/materials/textures via the handle),
   * detach its group from the scene, and forget it. Never throws.
   * @param {string} id
   */
  remove(id) {
    const entry = this.peers.get(id);
    if (!entry) return;
    try {
      if (entry.handle && entry.handle.dispose) entry.handle.dispose();
    } catch (_e) {
      /* ignore */
    }
    try {
      if (this.scene && this.scene.remove) this.scene.remove(entry.group);
    } catch (_e) {
      /* ignore */
    }
    this.peers.delete(id);
  }

  /**
   * Store the local dimension and toggle each avatar's visibility so only peers
   * in the same dimension render. Never throws.
   * @param {string} dim
   */
  setDimension(dim) {
    this.localDim = dim;
    for (const entry of this.peers.values()) {
      try {
        entry.group.visible = entry.dim === dim;
      } catch (_e) {
        /* ignore */
      }
    }
  }

  /**
   * Advance every peer by dt seconds: ease current -> target (exponential,
   * k = 1 - e^(-12*dt); yaw via shortest angular path), push the smoothed
   * position/look to the handle, derive velocity from the position delta so the
   * walk cycle reflects real motion, and advance the animation. Peers send no
   * pitch, so look pitch is always 0. Zero per-frame allocations. Never throws.
   * @param {number} dt - elapsed seconds.
   */
  update(dt) {
    const step = num(dt, 0);
    const safeStep = step > 0 ? step : 0;
    const k = 1 - Math.exp(-SMOOTH_RATE * safeStep);

    for (const entry of this.peers.values()) {
      const prevX = entry.curX;
      const prevY = entry.curY;
      const prevZ = entry.curZ;

      // Ease position toward target.
      entry.curX += (entry.tgtX - entry.curX) * k;
      entry.curY += (entry.tgtY - entry.curY) * k;
      entry.curZ += (entry.tgtZ - entry.curZ) * k;

      // Ease yaw along the shortest angular path.
      const dyaw = entry.tgtYaw - entry.curYaw;
      const wrapped = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      entry.curYaw += wrapped * k;

      const h = entry.handle;
      try {
        h.setPosition(entry.curX, entry.curY, entry.curZ);
      } catch (_e) {
        /* ignore */
      }

      // Derive velocity from the smoothed motion (guard dt > 0).
      let vx = 0;
      let vy = 0;
      let vz = 0;
      if (step > 0) {
        vx = (entry.curX - prevX) / step;
        vy = (entry.curY - prevY) / step;
        vz = (entry.curZ - prevZ) / step;
      }
      try {
        h.setVelocity(vx, vy, vz);
      } catch (_e) {
        /* ignore */
      }
      try {
        h.setLook(entry.curYaw, 0); // peers send no pitch
      } catch (_e) {
        /* ignore */
      }
      try {
        h.update(step);
      } catch (_e) {
        /* ignore */
      }
    }
  }

  /** @returns {number} number of tracked peers. */
  get count() {
    return this.peers.size;
  }

  /** @returns {string[]} the tracked peer ids. */
  get ids() {
    return Array.from(this.peers.keys());
  }

  /** Remove and dispose every peer, then clear the Map. Never throws. */
  dispose() {
    for (const id of Array.from(this.peers.keys())) {
      this.remove(id);
    }
    this.peers.clear();
  }
}

export default PeerAvatars;
