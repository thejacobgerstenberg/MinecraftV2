// avatars-plus/peer-avatars-plus.js
// PeerAvatarsPlus: a superset drop-in of the rig PeerAvatars — manages remote
// player avatars with per-peer descriptors, health/status nameplates, dimension
// filtering, and received-emote playback. Manager-side smoothing, never throws.

import * as THREE from "three";
import createAvatarPlus from "./avatar-plus.js";

/** Clamp any value into [0,1]; non-finite -> 0. */
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Column-centering offset applied to peer X/Z targets (matches eye offset). */
const COLUMN_CENTER = 0.3;

/** Finite guard with fallback. */
function fnum(n, fallback) {
  return Number.isFinite(n) ? n : fallback;
}

/** Shortest signed angular delta from a to b (radians), in (-PI, PI]. */
function shortestAngle(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/* -------------------------------------------------------------------------- */
/* PeerAvatarsPlus                                                             */
/* -------------------------------------------------------------------------- */

export class PeerAvatarsPlus {
  /**
   * @param {THREE.Scene} scene - scene the peer groups are added to.
   * @param {object} [opts]
   * @param {number} [opts.maxDistance] - nameplate fade distance for peers.
   * @param {*} [opts.dim] - initial active dimension (visibility filter).
   */
  constructor(scene, opts = {}) {
    this.scene = scene || null;
    this.opts = opts && typeof opts === "object" ? opts : {};
    /** @type {Map<string, object>} id -> peer record */
    this._peers = new Map();
    this._dim = this.opts.dim != null ? this.opts.dim : null;
  }

  /* ------------------------- lifecycle / mutation ------------------------- */

  /**
   * Insert a new peer or update an existing one. Unknown ids build a fresh
   * avatar (descriptor if supplied, else deterministically seeded off the id).
   * @param {object} p
   * @param {string} p.id
   * @param {string} [p.name]
   * @param {number} [p.x] @param {number} [p.y] @param {number} [p.z]
   * @param {number} [p.yaw]
   * @param {*} [p.dim]
   * @param {object} [p.descriptor]
   * @param {"a"|"b"|null} [p.team]
   * @param {number} [p.health] @param {number} [p.maxHealth]
   * @param {string} [p.status]
   */
  upsert(p) {
    if (!p || p.id == null || !this.scene) return;
    const id = String(p.id);
    const tx = fnum(p.x, 0) + COLUMN_CENTER;
    const ty = fnum(p.y, 0);
    const tz = fnum(p.z, 0) + COLUMN_CENTER;
    const tyaw = fnum(p.yaw, 0);

    let rec = this._peers.get(id);
    if (!rec) {
      let handle;
      try {
        handle = createAvatarPlus({
          name: p.name,
          descriptor: p.descriptor && typeof p.descriptor === "object" ? p.descriptor : undefined,
          skinSeed: id,
          team: p.team != null ? p.team : null,
          self: false,
          maxDistance: this.opts.maxDistance,
        });
      } catch (_e) {
        return; // never throw — skip a peer we could not build
      }
      handle.group.name = `peer:${id}`;
      rec = {
        handle,
        cx: tx,
        cy: ty,
        cz: tz,
        cyaw: tyaw,
        tx,
        ty,
        tz,
        tyaw,
        dim: p.dim != null ? p.dim : null,
      };
      this._peers.set(id, rec);
      this.scene.add(handle.group);
      // Snap current -> target on first sight (no smoothing pop-in).
      handle.setPosition(tx, ty, tz);
      handle.setLook(tyaw, 0);
      this._applyVisibility(rec);
    } else {
      // Known id -> retarget and apply live changes.
      rec.tx = tx;
      rec.ty = ty;
      rec.tz = tz;
      rec.tyaw = tyaw;
      if (p.dim !== undefined) {
        rec.dim = p.dim != null ? p.dim : null;
        this._applyVisibility(rec);
      }
      if (p.descriptor && typeof p.descriptor === "object") {
        rec.handle.setDescriptor(p.descriptor);
      }
    }

    // Name / health / status apply on both create and update.
    if (p.name != null) rec.handle.setName(p.name);
    if (p.health !== undefined) {
      rec.handle.setHealth(fnum(p.health, 0), fnum(p.maxHealth, 100));
    }
    if (p.status !== undefined) rec.handle.setStatus(p.status);
  }

  /**
   * Retarget an existing peer's position/orientation (finite-checked).
   * @param {object} p
   * @param {string} p.id
   * @param {number} [p.x] @param {number} [p.y] @param {number} [p.z]
   * @param {number} [p.yaw]
   * @param {*} [p.dim]
   * @param {number} [p.health] @param {number} [p.maxHealth]
   * @param {string} [p.status]
   */
  move(p) {
    if (!p || p.id == null) return;
    const rec = this._peers.get(String(p.id));
    if (!rec) return;
    if (Number.isFinite(p.x)) rec.tx = p.x + COLUMN_CENTER;
    if (Number.isFinite(p.y)) rec.ty = p.y;
    if (Number.isFinite(p.z)) rec.tz = p.z + COLUMN_CENTER;
    if (Number.isFinite(p.yaw)) rec.tyaw = p.yaw;
    if (p.dim !== undefined) {
      rec.dim = p.dim != null ? p.dim : null;
      this._applyVisibility(rec);
    }
    if (p.health !== undefined) {
      rec.handle.setHealth(fnum(p.health, 0), fnum(p.maxHealth, 100));
    }
    if (p.status !== undefined) rec.handle.setStatus(p.status);
  }

  /**
   * Remove and dispose a peer.
   * @param {string} id
   */
  remove(id) {
    if (id == null) return;
    const key = String(id);
    const rec = this._peers.get(key);
    if (!rec) return;
    try {
      if (this.scene && rec.handle.group) this.scene.remove(rec.handle.group);
      rec.handle.dispose();
    } catch (_e) {
      /* never throw */
    }
    this._peers.delete(key);
  }

  /**
   * Set the active dimension; peers whose dim differs are hidden.
   * @param {*} dim
   */
  setDimension(dim) {
    this._dim = dim != null ? dim : null;
    this._peers.forEach((rec) => this._applyVisibility(rec));
  }

  /**
   * Play a peer-originated emote on that peer's avatar.
   * @param {string} id - peer id.
   * @param {string} emoteId - one of the EMOTES ids.
   * @returns {Promise<string>|void}
   */
  receiveEmote(id, emoteId) {
    if (id == null) return;
    const rec = this._peers.get(String(id));
    if (!rec) return;
    try {
      return rec.handle.emote(emoteId);
    } catch (_e) {
      /* never throw */
    }
  }

  /* ------------------------------ per-frame ------------------------------- */

  /**
   * Smooth all peers toward their targets and advance their avatars. Derives a
   * per-peer velocity from the smoothed delta so walk cycles read correctly.
   * @param {number} dt - seconds since last frame.
   * @param {THREE.Vector3|{x:number,y:number,z:number}} [cameraPos]
   */
  update(dt, cameraPos) {
    const d = Number.isFinite(dt) && dt > 0 ? Math.min(0.1, dt) : 0;
    const k = d > 0 ? 1 - Math.exp(-12 * d) : 0;

    this._peers.forEach((rec) => {
      const h = rec.handle;

      const nx = rec.cx + (rec.tx - rec.cx) * k;
      const ny = rec.cy + (rec.ty - rec.cy) * k;
      const nz = rec.cz + (rec.tz - rec.cz) * k;
      const nyaw = rec.cyaw + shortestAngle(rec.cyaw, rec.tyaw) * k;

      // Velocity from the smoothed delta (before we commit the new position).
      let vx = 0;
      let vy = 0;
      let vz = 0;
      if (d > 0) {
        vx = (nx - rec.cx) / d;
        vy = (ny - rec.cy) / d;
        vz = (nz - rec.cz) / d;
      }

      rec.cx = nx;
      rec.cy = ny;
      rec.cz = nz;
      rec.cyaw = nyaw;

      h.setPosition(nx, ny, nz);
      h.setLook(nyaw, 0);
      h.setVelocity(vx, vy, vz);
      h.update(d, cameraPos);
    });
  }

  /* -------------------------------- misc ---------------------------------- */

  /** @returns {number} number of tracked peers. */
  get count() {
    return this._peers.size;
  }

  /** @returns {string[]} ids of all tracked peers. */
  get ids() {
    return Array.from(this._peers.keys());
  }

  /** Dispose all peers and clear the manager. */
  dispose() {
    this._peers.forEach((rec) => {
      try {
        if (this.scene && rec.handle.group) this.scene.remove(rec.handle.group);
        rec.handle.dispose();
      } catch (_e) {
        /* never throw */
      }
    });
    this._peers.clear();
  }

  /* ------------------------------ internals ------------------------------- */

  /**
   * Apply the dimension visibility filter to one peer.
   * @param {object} rec
   * @private
   */
  _applyVisibility(rec) {
    if (!rec || !rec.handle || !rec.handle.group) return;
    const visible = this._dim == null || rec.dim == null || rec.dim === this._dim;
    rec.handle.group.visible = visible;
  }
}

// Touch THREE so the shared bare-specifier import is exercised (types/scene).
void THREE;

export default PeerAvatarsPlus;
