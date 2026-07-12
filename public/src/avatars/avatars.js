// avatars/avatars.js
// Public factory: assembles skin + model + name-tag + animator into one avatar handle.

import { buildAvatarModel } from "./model.js";
import { resolveSkin } from "./skins.js";
import { makeNameTag } from "./nametag.js";
import { Animator } from "./animation.js";

// Re-export the skin surface so demos/hosts can build a gallery without a
// second import.
export { resolveSkin, SKIN_THEMES } from "./skins.js";

/** Coerce to a finite number, or fall back. */
function num(v, fallback) {
  v = Number(v);
  return Number.isFinite(v) ? v : fallback;
}

// How far above the crown the name tag floats (metres). The caller of
// makeNameTag anchors it; here that caller is us.
const NAME_TAG_LIFT = 0.4;

/**
 * @typedef {Object} AvatarHandle
 * @property {import("three").Group} group  Feet-origin group (soles at y=0, crown ~1.8, centred x/z=0). `scene.add(handle.group)`.
 * @property {(x:number,y:number,z:number)=>void} setPosition  Set group.position DIRECTLY to feet coords (no smoothing — the builder interpolates).
 * @property {(yaw:number,pitch:number)=>void} setLook  Body yaws to `yaw`; head pitches to `pitch` (clamped by the animator).
 * @property {(vx:number,vy:number,vz:number)=>void} setVelocity  Store velocity; drives the walk<->idle blend. Does NOT move the avatar.
 * @property {()=>void} swing  One-shot arm swing (block break/place); retriggerable.
 * @property {(dt:number)=>void} update  Advance animation + apply look. No per-frame allocations.
 * @property {(visible:boolean)=>void} setNameVisible  Toggle the name-tag sprite.
 * @property {()=>void} dispose  Remove group from parent; free all geo/mat/textures. Idempotent.
 * @property {string} name  Display name.
 * @property {string} skinId  Resolved skin theme id.
 */

/**
 * Create a standalone Loomfall player-avatar.
 *
 * Pipeline: resolveSkin(seed) -> buildAvatarModel(spec) -> makeNameTag(name)
 * (anchored above the crown, added to the group) -> new Animator(group, parts).
 * Every geometry/material/texture is created once here; `update(dt)` never
 * allocates. Defensive throughout — construction never throws.
 *
 * @param {Object} [opts]
 * @param {string} [opts.name]  Display name (also the default skin seed).
 * @param {string|number} [opts.skinSeed]  Deterministic skin seed; same seed -> identical skin on every client. Defaults to `name` then `"anon"`.
 * @param {(foot:0|1)=>void} [opts.onStep]  Footstep hook fired each foot-plant while walking (audio pairing: engine.play("step.<material>", ...)).
 * @returns {AvatarHandle}
 */
export function createAvatar(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const name = o.name == null ? "" : String(o.name);
  const seed = o.skinSeed != null ? o.skinSeed : name || "anon";
  const onStep = typeof o.onStep === "function" ? o.onStep : null;

  // --- skin (deterministic) ---
  const skinSpec = resolveSkin(seed);

  // --- model (feet-origin rig with pivot groups) ---
  const model = buildAvatarModel(skinSpec);
  const group = model.group;
  const parts = model.parts || {};
  const height = num(model.height, 1.8);

  // --- name tag: sprite anchored ~0.4 above the crown, parented to the group
  // so it tracks the avatar automatically ---
  let tag = null;
  try {
    tag = makeNameTag(name || "?");
    tag.position.set(0, height + NAME_TAG_LIFT, 0);
    group.add(tag);
  } catch (_e) {
    tag = null;
  }

  // --- animator (owns all per-frame scalar math; zero allocations) ---
  let animator = null;
  try {
    animator = new Animator(group, parts, onStep ? { onStep } : {});
  } catch (_e) {
    animator = null;
  }

  let disposed = false;

  /** Set the group directly to feet position — no internal smoothing. */
  function setPosition(x, y, z) {
    if (disposed) return;
    group.position.set(num(x, group.position.x), num(y, group.position.y), num(z, group.position.z));
  }

  /** Yaw the body and pitch the head toward the given look angles (radians). */
  function setLook(yaw, pitch) {
    if (disposed || !animator) return;
    try {
      animator.setLook(num(yaw, 0), num(pitch, 0));
    } catch (_e) {
      /* ignore */
    }
  }

  /** Store the velocity that drives the walk<->idle blend. Does not move. */
  function setVelocity(vx, vy, vz) {
    if (disposed || !animator) return;
    try {
      animator.setVelocity(num(vx, 0), num(vy, 0), num(vz, 0));
    } catch (_e) {
      /* ignore */
    }
  }

  /** Trigger a one-shot arm swing (retriggerable). */
  function swing() {
    if (disposed || !animator) return;
    try {
      animator.swing();
    } catch (_e) {
      /* ignore */
    }
  }

  /** Advance the animation and apply the eased look for this frame. */
  function update(dt) {
    if (disposed || !animator) return;
    try {
      animator.update(num(dt, 0));
    } catch (_e) {
      /* ignore */
    }
  }

  /** Show or hide the name-tag sprite. */
  function setNameVisible(visible) {
    if (disposed || !tag) return;
    tag.visible = !!visible;
  }

  /** Remove the group from its parent and free everything this avatar created. Idempotent. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    // Animator holds no GPU resources but may reset transforms.
    if (animator) {
      try {
        animator.dispose();
      } catch (_e) {
        /* ignore */
      }
    }
    // Name tag: free its canvas texture + sprite material, detach from group.
    if (tag) {
      try {
        if (tag.parent) tag.parent.remove(tag);
      } catch (_e) {
        /* ignore */
      }
      try {
        if (tag.userData && typeof tag.userData.dispose === "function") tag.userData.dispose();
      } catch (_e) {
        /* ignore */
      }
    }
    // Model: disposes all geometry/materials/textures AND removes group from parent.
    try {
      model.dispose();
    } catch (_e) {
      /* ignore */
    }
    // Belt-and-braces: ensure the group is detached even if model.dispose changed.
    try {
      if (group.parent) group.parent.remove(group);
    } catch (_e) {
      /* ignore */
    }
  }

  return {
    group,
    setPosition,
    setLook,
    setVelocity,
    swing,
    update,
    setNameVisible,
    dispose,
    name,
    skinId: skinSpec && skinSpec.id ? skinSpec.id : "",
  };
}

export default createAvatar;
