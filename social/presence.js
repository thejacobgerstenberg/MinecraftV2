// social/presence.js
// Multiplayer presence data layer: a DOM-free store of the roster (self + peers)
// built from the minimal wire protocol, with local-only ping/team/skin overlays.

import { buildSkinFromDescriptor } from "../avatars-plus/skin-descriptor.js";

/* -------------------------------------------------------------------------- */
/* Local helpers (defensive, never throw)                                      */
/* -------------------------------------------------------------------------- */

/** Clamp v into [0,1]; non-finite -> 0. */
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Coerce v to a finite number or fall back. */
function num(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

/** Canonical wire dim values. */
const WIRE_DIMS = ["overworld", "nether", "end"];

/** Map wire dim -> lore display name. */
const DIM_DISPLAY = {
  overworld: "Warpwold",
  nether: "Cinderloom",
  end: "Nevermend",
};

/**
 * Theme base-color fallback map (theme id -> torso hex) — a convenience for
 * consumers that know a peer's theme id but not a full descriptor. Exported
 * for reuse; the store itself derives swatches from full descriptors or hash.
 * @type {Object<string,string>}
 */
export const THEME_BASE_COLORS = {
  "warpwold-mender": "#347a41",
  "cinderloom-scaldwarden": "#8c1d11",
  "nevermend-selvage-warden": "#6a4a94",
  "everthread-forged": "#b98a2e",
  "frostlace-snowline": "#5bbcd2",
  "understitch-unpicked": "#8a8278",
};

/**
 * Normalize an arbitrary dim value to a canonical wire dim; unknown -> "overworld".
 * @param {*} dim
 * @returns {"overworld"|"nether"|"end"}
 */
function normDim(dim) {
  return WIRE_DIMS.includes(dim) ? dim : "overworld";
}

/**
 * Lore display name for a wire dim value. Unknown values are returned as-is.
 * @param {string} dim wire value: overworld|nether|end
 * @returns {string} Warpwold|Cinderloom|Nevermend or the passed value
 */
export function dimDisplayName(dim) {
  return DIM_DISPLAY[dim] || dim;
}

/**
 * Deterministic hex swatch derived from an id via FNV-1a -> HSL. Stable across
 * clients so a peer with no known skin still reads with a consistent color.
 * @param {*} id
 * @returns {string} "#rrggbb"
 */
export function hashHueHex(id) {
  const s = String(id == null ? "" : id);
  let h = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  const hue = ((h >>> 0) % 360);
  return hslHex(hue, 0.5, 0.55);
}

/**
 * Convert HSL (h in degrees, s/l in 0..1) to a "#rrggbb" string. Never throws.
 * @param {number} h @param {number} s @param {number} l @returns {string}
 */
function hslHex(h, s, l) {
  const hh = ((num(h) % 360) + 360) % 360 / 360;
  const ss = clamp01(s);
  const ll = clamp01(l);
  let r, g, b;
  if (ss === 0) {
    r = g = b = ll;
  } else {
    const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
    const p = 2 * ll - q;
    r = hue2rgb(p, q, hh + 1 / 3);
    g = hue2rgb(p, q, hh);
    b = hue2rgb(p, q, hh - 1 / 3);
  }
  return "#" + toHex(r) + toHex(g) + toHex(b);
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function toHex(c) {
  const v = Math.round(clamp01(c) * 255);
  return v.toString(16).padStart(2, "0");
}

/**
 * Derive a torso swatch hex for a player: from a known descriptor if present,
 * else a deterministic hash-of-id hue. Never throws.
 * @param {*} id
 * @param {*} skin descriptor or null
 * @returns {string} "#rrggbb"
 */
function deriveSwatch(id, skin) {
  if (skin) {
    try {
      const spec = buildSkinFromDescriptor(skin);
      if (spec && spec.palette && spec.palette.torso) return spec.palette.torso;
    } catch (_err) {
      /* fall through to hash */
    }
  }
  return hashHueHex(id);
}

/**
 * @typedef {Object} Player
 * @property {string} id
 * @property {string} name
 * @property {"overworld"|"nether"|"end"} dim
 * @property {number|null} ping local-only; null when unknown (UI shows "—")
 * @property {"a"|"b"|null} team local-only
 * @property {boolean} self
 * @property {*} skin locally-known descriptor or null
 * @property {string} swatch "#rrggbb"
 * @property {number} x @property {number} y @property {number} z
 * @property {number} yaw @property {number} pitch
 */

/* -------------------------------------------------------------------------- */
/* PresenceStore                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Roster store for the multiplayer social layer. Ingests the minimal wire
 * protocol ({id,name,x,y,z,yaw,pitch,dim} per peer) and layers on local-only
 * concepts (ping, team, skin descriptors). Emits DOM-style events on change:
 *
 *   'change'  — any mutation (coarse; UI re-renders on this)
 *   'join'    {player}        — a new peer appeared
 *   'leave'   {id, player}    — a peer was removed
 *   'update'  {player}        — an existing player's fields changed
 *   'dim'     {player, from, to} — a player changed dimension
 *
 * Never throws on bad input.
 */
export class PresenceStore extends EventTarget {
  /**
   * @param {{selfName?:string, localSkin?:*|null, selfTeam?:('a'|'b'|null)}} [opts]
   */
  constructor(opts = {}) {
    super();
    const o = opts && typeof opts === "object" ? opts : {};
    /** @type {Map<string,Player>} */
    this._players = new Map();
    /** @type {string|null} */
    this._selfId = null;
    this._selfName = typeof o.selfName === "string" ? o.selfName : "You";
    this._localSkin = o.localSkin != null ? o.localSkin : null;
    this._selfTeam = o.selfTeam === "a" || o.selfTeam === "b" ? o.selfTeam : null;
  }

  /** @returns {string|null} the local player's id (set by ingestWelcome). */
  get selfId() {
    return this._selfId;
  }

  /**
   * Players as an array, sorted SELF first then by name (case-insensitive).
   * @returns {Player[]}
   */
  get players() {
    const arr = Array.from(this._players.values());
    arr.sort((a, b) => {
      if (a.self !== b.self) return a.self ? -1 : 1;
      return String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());
    });
    return arr;
  }

  /**
   * Look up one player by id.
   * @param {*} id @returns {Player|undefined}
   */
  get(id) {
    return this._players.get(String(id));
  }

  /**
   * Build a fresh Player record from raw fields. Local overlays (ping/team) are
   * carried over from any existing record for the same id.
   * @param {Object} raw
   * @param {boolean} self
   * @returns {Player}
   */
  _makePlayer(raw, self) {
    const id = String(raw && raw.id != null ? raw.id : "");
    const prev = this._players.get(id);
    const skin = raw && "skin" in raw ? raw.skin : prev ? prev.skin : null;
    return {
      id,
      name: typeof (raw && raw.name) === "string" && raw.name ? raw.name : prev ? prev.name : id,
      dim: normDim(raw && raw.dim != null ? raw.dim : prev ? prev.dim : "overworld"),
      ping: prev ? prev.ping : null,
      team: prev ? prev.team : self ? this._selfTeam : null,
      self: !!self,
      skin: skin != null ? skin : null,
      swatch: deriveSwatch(id, skin != null ? skin : null),
      x: num(raw && raw.x, prev ? prev.x : 0),
      y: num(raw && raw.y, prev ? prev.y : 0),
      z: num(raw && raw.z, prev ? prev.z : 0),
      yaw: num(raw && raw.yaw, prev ? prev.yaw : 0),
      pitch: num(raw && raw.pitch, prev ? prev.pitch : 0),
    };
  }

  /** Emit a plain CustomEvent; never throws. */
  _emit(type, detail) {
    try {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    } catch (_err) {
      /* no-op */
    }
  }

  /**
   * Ingest the server welcome: sets selfId, creates the SELF player plus one
   * player per listed peer, then emits 'change'.
   * @param {{id:*, peers?:Array}} welcome
   */
  ingestWelcome(welcome) {
    if (!welcome || typeof welcome !== "object") return;
    this._players.clear();
    this._selfId = welcome.id != null ? String(welcome.id) : null;
    const peers = Array.isArray(welcome.peers) ? welcome.peers : [];
    const firstDim = peers.length && peers[0] ? normDim(peers[0].dim) : "overworld";

    if (this._selfId != null) {
      const selfPlayer = this._makePlayer(
        {
          id: this._selfId,
          name: this._selfName,
          dim: firstDim,
          skin: this._localSkin,
        },
        true
      );
      this._players.set(selfPlayer.id, selfPlayer);
    }

    for (const peer of peers) {
      if (!peer || peer.id == null) continue;
      if (String(peer.id) === this._selfId) continue;
      const p = this._makePlayer(peer, false);
      this._players.set(p.id, p);
    }
    this._emit("change", { store: this });
  }

  /**
   * Add or update a peer from a peer-join message. Emits 'join' for a new peer
   * or 'update' for an existing one, plus 'change'.
   * @param {{id:*,name?:string,x?:number,y?:number,z?:number,yaw?:number,pitch?:number,dim?:string}} msg
   */
  upsertPeer(msg) {
    if (!msg || msg.id == null) return;
    const id = String(msg.id);
    const isNew = !this._players.has(id);
    const self = id === this._selfId;
    const p = this._makePlayer(msg, self);
    this._players.set(id, p);
    this._emit(isNew ? "join" : "update", { player: p });
    this._emit("change", { store: this });
  }

  /**
   * Apply a movement update: position + dim. Emits 'dim' when the dimension
   * changed, then 'update' and 'change'.
   * @param {{id:*,x?:number,y?:number,z?:number,yaw?:number,pitch?:number,dim?:string}} msg
   */
  updateMove(msg) {
    if (!msg || msg.id == null) return;
    const id = String(msg.id);
    const prev = this._players.get(id);
    if (!prev) {
      // Unknown mover — treat as a lightweight upsert so we don't lose them.
      this.upsertPeer(msg);
      return;
    }
    const from = prev.dim;
    const to = normDim(msg.dim != null ? msg.dim : prev.dim);
    prev.x = num(msg.x, prev.x);
    prev.y = num(msg.y, prev.y);
    prev.z = num(msg.z, prev.z);
    prev.yaw = num(msg.yaw, prev.yaw);
    prev.pitch = num(msg.pitch, prev.pitch);
    prev.dim = to;
    if (from !== to) this._emit("dim", { player: prev, from, to });
    this._emit("update", { player: prev });
    this._emit("change", { store: this });
  }

  /**
   * Remove a peer. Emits 'leave' {id, player} then 'change'.
   * @param {*} id
   */
  removePeer(id) {
    const key = String(id);
    const player = this._players.get(key);
    if (!player) return;
    this._players.delete(key);
    this._emit("leave", { id: key, player });
    this._emit("change", { store: this });
  }

  /**
   * Set a player's ping (local-only). null clears it (UI shows "—").
   * @param {*} id @param {number|null} ms
   */
  setPing(id, ms) {
    const p = this._players.get(String(id));
    if (!p) return;
    p.ping = Number.isFinite(ms) ? Math.max(0, ms) : null;
    this._emit("update", { player: p });
    this._emit("change", { store: this });
  }

  /**
   * Set a player's team (local concept). Only 'a'|'b'|null are accepted.
   * @param {*} id @param {"a"|"b"|null} team
   */
  setTeam(id, team) {
    const p = this._players.get(String(id));
    if (!p) return;
    p.team = team === "a" || team === "b" ? team : null;
    if (p.self) this._selfTeam = p.team;
    this._emit("update", { player: p });
    this._emit("change", { store: this });
  }

  /**
   * Set the local player's skin descriptor and recompute its swatch.
   * @param {*} descriptor
   */
  setLocalSkin(descriptor) {
    this._localSkin = descriptor != null ? descriptor : null;
    if (this._selfId != null) this.setSkin(this._selfId, descriptor);
  }

  /**
   * Set a player's skin descriptor (locally known) and recompute its swatch.
   * @param {*} id @param {*} descriptor
   */
  setSkin(id, descriptor) {
    const p = this._players.get(String(id));
    if (!p) return;
    p.skin = descriptor != null ? descriptor : null;
    p.swatch = deriveSwatch(p.id, p.skin);
    this._emit("update", { player: p });
    this._emit("change", { store: this });
  }

  /**
   * Update the self player's dimension.
   * @param {string} dim wire value overworld|nether|end
   */
  setSelfDim(dim) {
    if (this._selfId == null) return;
    this.updateMove({ id: this._selfId, dim });
  }
}

export default PresenceStore;
