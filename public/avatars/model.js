// avatars/model.js
// Builds the feet-origin box-avatar rig (pivot groups) from a resolved SkinSpec.

import * as THREE from "three";

/**
 * Loomfall avatar proportions (metres). Feet-origin: soles at y=0.
 * Distinct silhouette vs. Minecraft Steve: defined neck gap, slightly
 * narrower/longer limbs, a small head tuft and shoulder pauldrons.
 *
 * Vertical stack (world y):
 *   legs   0.00 .. 0.78   (hip pivot @ 0.78)
 *   torso  0.78 .. 1.38   (waist/hip pivot @ 0.78)
 *   neck   1.38 .. 1.44   (head pivot @ 1.38)
 *   head   1.44 .. 1.80   (crown ~1.80)
 *   tuft   1.80 .. 1.88   (decorative accent)
 */
const DIMS = {
  torsoPivotY: 0.78, // waist/hip height (also leg + arm pivot reference)
  head: { w: 0.40, h: 0.36, d: 0.40 },
  neck: { w: 0.14, h: 0.06, d: 0.14 },
  tuft: { w: 0.12, h: 0.08, d: 0.12 },
  torso: { w: 0.44, h: 0.60, d: 0.24 },
  arm: { w: 0.13, h: 0.70, d: 0.15 },
  pauldron: { w: 0.17, h: 0.10, d: 0.19 },
  leg: { w: 0.16, h: 0.78, d: 0.18 },
  legX: 0.11, // half-separation of the two legs
  armX: 0.29, // half-separation of the two shoulder pivots
  headPivotY: 1.38, // world y of the neck joint
  shoulderY: 1.34, // world y of the shoulder joint
};

const HEIGHT = 1.80; // functional height (crown); tuft accent extends slightly above

// Fallback flat colours (Warpwold-mender greens/earth) if the skin cannot
// supply materials — never throw.
const FALLBACK = {
  head: 0x8fae6a,
  torso: 0x3f6b3a,
  armL: 0x35603a,
  armR: 0x35603a,
  legL: 0x2f4a2a,
  legR: 0x2f4a2a,
};

/**
 * Build the animatable avatar model from a SkinSpec.
 *
 * @param {object} skinSpec - result of resolveSkin(); may expose makeMaterials().
 * @returns {{ group: THREE.Group, parts: object, height: number,
 *   textures: THREE.Texture[], dispose: () => void }}
 *   `group` is a feet-origin THREE.Group (min y = 0, crown ~1.8, centred x/z=0).
 *   `parts` = { headPivot, torso, armL, armR, legL, legR } — each a pivot Group.
 */
export function buildAvatarModel(skinSpec) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();

  // --- resolve materials (defensive; never throw) ---
  let mats = null;
  try {
    if (skinSpec && typeof skinSpec.makeMaterials === "function") {
      mats = skinSpec.makeMaterials();
    }
  } catch (_e) {
    mats = null;
  }
  if (!mats || typeof mats !== "object") mats = {};

  /** Get a usable material for a slot, or synthesise a flat fallback. */
  function mat(slot) {
    const m = mats[slot];
    if (m && m.isMaterial) {
      materials.add(m);
      // collect any generated maps for disposal
      if (m.map && m.map.isTexture) textures.add(m.map);
      if (m.emissiveMap && m.emissiveMap.isTexture) textures.add(m.emissiveMap);
      return m;
    }
    const fb = new THREE.MeshLambertMaterial({ color: FALLBACK[slot] });
    materials.add(fb);
    return fb;
  }

  /** Create a box mesh at a local position and register its geometry. */
  function box(dim, material, x, y, z) {
    const geo = new THREE.BoxGeometry(dim.w, dim.h, dim.d);
    geometries.add(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    return mesh;
  }

  const group = new THREE.Group();
  group.name = "loomfall-avatar";

  const D = DIMS;

  // Resolve materials once (fresh instances from the skin).
  const mHead = mat("head");
  const mTorso = mat("torso");
  const mArmL = mat("armL");
  const mArmR = mat("armR");
  const mLegL = mat("legL");
  const mLegR = mat("legR");

  // ---------- Legs (children of the root group; pivot at the hips) ----------
  const legMeshCenter = -(D.leg.h / 2); // mesh hangs down from the hip pivot
  const legL = new THREE.Group();
  legL.name = "legL";
  legL.position.set(+D.legX, D.torsoPivotY, 0);
  legL.add(box(D.leg, mLegL, 0, legMeshCenter, 0));

  const legR = new THREE.Group();
  legR.name = "legR";
  legR.position.set(-D.legX, D.torsoPivotY, 0);
  legR.add(box(D.leg, mLegR, 0, legMeshCenter, 0));

  // ---------- Torso (pivot at the waist/hips) ----------
  const torso = new THREE.Group();
  torso.name = "torso";
  torso.position.set(0, D.torsoPivotY, 0);
  // torso mesh centre relative to hip pivot
  const torsoCenterRel = D.torso.h / 2; // 0.30 -> world 1.08
  torso.add(box(D.torso, mTorso, 0, torsoCenterRel, 0));

  // ---------- Head pivot (child of torso; rotates about the neck) ----------
  const headPivot = new THREE.Group();
  headPivot.name = "headPivot";
  headPivot.position.set(0, D.headPivotY - D.torsoPivotY, 0); // local 0.60 -> world 1.38
  // neck (thin, sits just above the pivot -> the defined neck gap)
  headPivot.add(box(D.neck, mHead, 0, D.neck.h / 2, 0));
  // head (bottom at world 1.44 -> centre world 1.62 -> rel to pivot 0.24)
  const headCenterRel = D.neck.h + D.head.h / 2; // 0.06 + 0.18 = 0.24
  headPivot.add(box(D.head, mHead, 0, headCenterRel, 0));
  // tuft accent on the crown
  const tuftCenterRel = D.neck.h + D.head.h + D.tuft.h / 2; // 0.06+0.36+0.04 = 0.46
  headPivot.add(box(D.tuft, mHead, 0, tuftCenterRel, 0));
  torso.add(headPivot);

  // ---------- Arms (children of torso; pivot at the shoulder) ----------
  const armMeshCenter = -(D.arm.h / 2); // arm hangs down from shoulder
  const shoulderRel = D.shoulderY - D.torsoPivotY; // 0.56

  const armL = new THREE.Group();
  armL.name = "armL";
  armL.position.set(+D.armX, shoulderRel, 0);
  armL.add(box(D.arm, mArmL, 0, armMeshCenter, 0));
  // pauldron shoulder detail (near the pivot top)
  armL.add(box(D.pauldron, mTorso, 0, D.pauldron.h / 2, 0));

  const armR = new THREE.Group();
  armR.name = "armR";
  armR.position.set(-D.armX, shoulderRel, 0);
  armR.add(box(D.arm, mArmR, 0, armMeshCenter, 0));
  armR.add(box(D.pauldron, mTorso, 0, D.pauldron.h / 2, 0));

  torso.add(armL);
  torso.add(armR);

  // Assemble root (feet-origin).
  group.add(legL);
  group.add(legR);
  group.add(torso);

  const parts = { headPivot, torso, armL, armR, legL, legR };

  let disposed = false;
  /** Free every geometry, material and texture this model created/owns. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (group.parent) {
      try {
        group.parent.remove(group);
      } catch (_e) {
        /* ignore */
      }
    }
    for (const g of geometries) {
      try {
        g.dispose();
      } catch (_e) {
        /* ignore */
      }
    }
    for (const m of materials) {
      try {
        m.dispose();
      } catch (_e) {
        /* ignore */
      }
    }
    for (const t of textures) {
      try {
        t.dispose();
      } catch (_e) {
        /* ignore */
      }
    }
    geometries.clear();
    materials.clear();
    textures.clear();
  }

  return {
    group,
    parts,
    height: HEIGHT,
    textures: Array.from(textures),
    dispose,
  };
}

export default buildAvatarModel;
