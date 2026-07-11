// avatars-plus/avatar-plus.js
// createAvatarPlus: composes the reused ../avatars rig (model + Animator) with a
// descriptor-driven skin, an emote controller, and a nameplate into one handle.

import * as THREE from "three";
import buildAvatarModel from "../avatars/model.js";
import Animator from "../avatars/animation.js";
import {
  buildSkinFromDescriptor,
  normalizeDescriptor,
  defaultDescriptor,
  THEME_IDS,
} from "./skin-descriptor.js";
import { EmoteController } from "./emotes.js";
import { makeNameplate } from "./nameplate.js";

/** Clamp any value into [0,1]; non-finite -> 0. */
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Nameplate sits this far above the crown (metres). */
const NAMEPLATE_LIFT = 0.4;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Cheap deterministic 32-bit string hash (FNV-1a style) — same seed on every
 * client yields the same descriptor, so unnamed peers still look consistent.
 * @param {string} str
 * @returns {number} unsigned 32-bit integer
 */
function hashString(str) {
  const s = typeof str === "string" && str.length ? str : "loomfall";
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Derive a full, valid Descriptor from an arbitrary seed string (id or name).
 * @param {string} seed
 * @returns {object} normalized Descriptor
 */
function descriptorFromSeed(seed) {
  const h = hashString(seed);
  const themeId = THEME_IDS[h % THEME_IDS.length];
  const base = defaultDescriptor(themeId);
  return normalizeDescriptor({
    ...base,
    threadHue: h % 360,
    weave: (h >>> 4) % 6,
    accent: (h >>> 8) % 360,
    accentStrength: clamp01(((h >>> 16) & 0xff) / 255),
  });
}

/**
 * Resolve the incoming opts into a concrete, normalized Descriptor.
 * @param {object} opts
 * @returns {object} normalized Descriptor
 */
function resolveDescriptor(opts) {
  if (opts && opts.descriptor && typeof opts.descriptor === "object") {
    return normalizeDescriptor(opts.descriptor);
  }
  const seed =
    (opts && (opts.skinSeed != null ? String(opts.skinSeed) : opts.name)) || "";
  return descriptorFromSeed(seed);
}

/** Collect the unique Material instances currently used across a group. */
function collectMaterials(group, out) {
  out.clear();
  if (!group || typeof group.traverse !== "function") return out;
  group.traverse((o) => {
    if (o && o.isMesh && o.material && o.material.isMaterial) out.add(o.material);
  });
  return out;
}

/** Dispose a set of materials plus their bound texture maps (idempotent-safe). */
function disposeMaterials(matSet, texList) {
  if (matSet) {
    matSet.forEach((m) => {
      try {
        if (m && typeof m.dispose === "function") m.dispose();
      } catch (_e) {
        /* never throw */
      }
    });
  }
  if (Array.isArray(texList)) {
    for (const t of texList) {
      try {
        if (t && typeof t.dispose === "function") t.dispose();
      } catch (_e) {
        /* never throw */
      }
    }
  }
}

/**
 * Reassign fresh slot materials onto the rig meshes, mirroring model.js layout:
 * head slot -> headPivot meshes; torso slot -> torso mesh + arm pauldrons;
 * armL/armR -> the arm boxes (child index 0); legL/legR -> leg boxes.
 * @param {object} parts
 * @param {{head:THREE.Material,torso:THREE.Material,armL:THREE.Material,armR:THREE.Material,legL:THREE.Material,legR:THREE.Material}} mats
 */
function applyMaterials(parts, mats) {
  if (!parts || !mats) return;
  const meshesOf = (grp) =>
    grp && Array.isArray(grp.children)
      ? grp.children.filter((c) => c && c.isMesh)
      : [];

  for (const m of meshesOf(parts.headPivot)) if (mats.head) m.material = mats.head;
  for (const m of meshesOf(parts.torso)) if (mats.torso) m.material = mats.torso;

  const armPlan = (grp, primary) => {
    const meshes = meshesOf(grp);
    meshes.forEach((mesh, i) => {
      // index 0 = arm box (limb slot); later meshes = pauldron (torso slot)
      const target = i === 0 ? primary : mats.torso;
      if (target) mesh.material = target;
    });
  };
  armPlan(parts.armL, mats.armL);
  armPlan(parts.armR, mats.armR);

  for (const m of meshesOf(parts.legL)) if (mats.legL) m.material = mats.legL;
  for (const m of meshesOf(parts.legR)) if (mats.legR) m.material = mats.legR;
}

/* -------------------------------------------------------------------------- */
/* createAvatarPlus                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Build a full player-identity avatar handle: descriptor skin -> rig model ->
 * nameplate -> Animator -> EmoteController.
 *
 * @param {object} [opts]
 * @param {string} [opts.name] - display name (nameplate + seed fallback).
 * @param {object} [opts.descriptor] - a skin Descriptor; falls back to a
 *   deterministic descriptor derived from opts.skinSeed or opts.name.
 * @param {string|number} [opts.skinSeed] - seed used when no descriptor given.
 * @param {"a"|"b"|null} [opts.team] - team tint for the nameplate.
 * @param {boolean} [opts.self] - true for the local player (self tint).
 * @param {(foot:0|1)=>void} [opts.onStep] - footfall hook forwarded to Animator.
 * @param {number} [opts.maxDistance] - nameplate fade distance (metres).
 * @returns {object} avatar handle (see fields below).
 */
export function createAvatarPlus(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};

  let descriptor = resolveDescriptor(o);

  // --- skin -> model ---
  let spec = buildSkinFromDescriptor(descriptor);
  const model = buildAvatarModel(spec);
  const group = model.group;
  const parts = model.parts;
  const height = Number.isFinite(model.height) ? model.height : 1.8;

  // Track live materials/textures so setDescriptor + dispose free the right ones.
  const liveMaterials = new Set();
  collectMaterials(group, liveMaterials);
  let liveTextures = Array.isArray(model.textures) ? model.textures.slice() : [];

  // --- nameplate (child of the group so it rides along) ---
  let nameplate = null;
  try {
    nameplate = makeNameplate({
      name: o.name,
      team: o.team != null ? o.team : null,
      self: !!o.self,
      maxDistance: Number.isFinite(o.maxDistance) ? o.maxDistance : undefined,
    });
    if (nameplate && nameplate.sprite) {
      nameplate.sprite.position.set(0, height + NAMEPLATE_LIFT, 0);
      group.add(nameplate.sprite);
    }
  } catch (_e) {
    nameplate = null; // never throw — avatar still works without a nameplate
  }

  // --- animation + emotes ---
  const animator = new Animator(group, parts, {
    onStep: typeof o.onStep === "function" ? o.onStep : undefined,
  });
  const emotes = new EmoteController(parts, group);

  // Preallocated scratch — no per-frame allocation in update().
  const anchorScratch = new THREE.Vector3();

  let disposed = false;

  /* ---- mutation helpers ---- */

  /** @param {number} x @param {number} y @param {number} z */
  function setPosition(x, y, z) {
    if (disposed) return;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      group.position.set(x, y, z);
    }
  }

  /** @param {number} yaw @param {number} pitch */
  function setLook(yaw, pitch) {
    if (disposed) return;
    animator.setLook(finite(yaw), finite(pitch));
  }

  /** @param {number} vx @param {number} vy @param {number} vz */
  function setVelocity(vx, vy, vz) {
    if (disposed) return;
    animator.setVelocity(finite(vx), finite(vy), finite(vz));
  }

  /** Trigger a one-shot arm swing (attack/interact). */
  function swing() {
    if (!disposed) animator.swing();
  }

  /**
   * Play an emote by id (see EMOTES). Resolves when a one-shot ends / a loop
   * is stopped.
   * @param {string} id
   * @returns {Promise<string>}
   */
  function emote(id) {
    if (disposed) return Promise.resolve(id);
    try {
      return emotes.play(id);
    } catch (_e) {
      return Promise.resolve(id);
    }
  }

  /** Ease the active emote out. */
  function stopEmote() {
    if (!disposed) {
      try {
        emotes.stop();
      } catch (_e) {
        /* never throw */
      }
    }
  }

  /** @returns {boolean} */
  function isEmoting() {
    return !disposed && emotes.isActive();
  }

  /** @returns {string|null} */
  function currentEmote() {
    return disposed ? null : emotes.current();
  }

  /**
   * Rebuild the skin from a new Descriptor: swap materials on the meshes and
   * dispose the previous materials/textures. The rig geometry is untouched.
   * @param {object} newDescriptor
   */
  function setDescriptor(newDescriptor) {
    if (disposed) return;
    let nextSpec;
    let nextDesc;
    try {
      nextDesc = normalizeDescriptor(newDescriptor);
      nextSpec = buildSkinFromDescriptor(nextDesc);
      const mats = nextSpec.makeMaterials();
      // Snapshot the outgoing GPU resources before we drop references.
      const oldMats = new Set(liveMaterials);
      const oldTex = liveTextures;

      applyMaterials(parts, mats);

      // Refresh tracking to the freshly-applied resources.
      collectMaterials(group, liveMaterials);
      liveTextures = Array.isArray(nextSpec.textures)
        ? nextSpec.textures.slice()
        : [];

      // Free the old materials + textures (new ones are never in these sets).
      disposeMaterials(oldMats, oldTex);

      spec = nextSpec;
      descriptor = nextDesc;
      handle.descriptor = descriptor;
    } catch (_e) {
      /* leave the current skin in place — never throw */
    }
  }

  /** @param {string} name */
  function setName(name) {
    if (disposed) return;
    handle.name = typeof name === "string" ? name : handle.name;
    if (nameplate && typeof nameplate.setName === "function") {
      try {
        nameplate.setName(name);
      } catch (_e) {
        /* never throw */
      }
    }
  }

  /** @param {number} cur @param {number} max */
  function setHealth(cur, max) {
    if (disposed || !nameplate || typeof nameplate.setHealth !== "function")
      return;
    try {
      nameplate.setHealth(cur, max);
    } catch (_e) {
      /* never throw */
    }
  }

  /** @param {string} text */
  function setStatus(text) {
    if (disposed || !nameplate || typeof nameplate.setStatus !== "function")
      return;
    try {
      nameplate.setStatus(text);
    } catch (_e) {
      /* never throw */
    }
  }

  /** @param {boolean} visible */
  function setNameVisible(visible) {
    if (nameplate && nameplate.sprite) nameplate.sprite.visible = !!visible;
  }

  /**
   * Advance a frame. ORDER IS CRITICAL: the Animator writes the base walk/idle
   * pose first, then the EmoteController blends emote targets on top, then the
   * nameplate updates its distance fade.
   * @param {number} dt - seconds since last frame.
   * @param {THREE.Vector3|{x:number,y:number,z:number}} [cameraPos]
   */
  function update(dt, cameraPos) {
    if (disposed) return;
    animator.update(dt); // 1) base pose
    emotes.update(dt); // 2) emote blend on top (reads post-Animator rotations)

    if (nameplate && typeof nameplate.update === "function") {
      // world anchor = feet position + crown lift (group.position IS feet).
      anchorScratch.set(
        group.position.x,
        group.position.y + height + NAMEPLATE_LIFT,
        group.position.z
      );
      try {
        nameplate.update(dt, cameraPos, anchorScratch);
      } catch (_e) {
        /* never throw */
      }
    }
  }

  /** Free all GPU resources owned by this avatar. Safe to call once. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      animator.dispose && animator.dispose();
    } catch (_e) {
      /* ignore */
    }
    try {
      emotes.stop && emotes.stop();
    } catch (_e) {
      /* ignore */
    }
    if (nameplate) {
      try {
        if (nameplate.sprite && nameplate.sprite.parent)
          nameplate.sprite.parent.remove(nameplate.sprite);
        nameplate.dispose && nameplate.dispose();
      } catch (_e) {
        /* ignore */
      }
    }
    // Dispose current skin resources, then hand geometry disposal to the model.
    disposeMaterials(liveMaterials, liveTextures);
    liveMaterials.clear();
    liveTextures = [];
    try {
      model.dispose && model.dispose();
    } catch (_e) {
      /* ignore */
    }
  }

  const handle = {
    group,
    parts,
    setPosition,
    setLook,
    setVelocity,
    swing,
    emote,
    stopEmote,
    isEmoting,
    currentEmote,
    setDescriptor,
    setName,
    setHealth,
    setStatus,
    setNameVisible,
    update,
    dispose,
    name: typeof o.name === "string" ? o.name : "",
    descriptor,
  };
  return handle;
}

/** Finite guard used by the setters above. */
function finite(n) {
  return Number.isFinite(n) ? n : 0;
}

export default createAvatarPlus;
