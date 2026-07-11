import * as THREE from 'three';

// ============================================================================
// WICKERKIN — a friendly, neutral Warpwold trader woven of wicker/basketwork.
// Archetype: trader
//
// Silhouette goals (per design brief): an upright hourglass/barrel WOVEN
// torso (alternating light/dark box strips suggest a basket weave), a wide-
// brimmed WOVEN HAT on top, small beady eyes, two short arms — one holding a
// little spool/satchel — and short stubby legs. ~1.1 units tall overall.
// Never hostile: idle is a gentle bob + slow humming head-sway, walk is a
// small waddle. Deliberately NOT a Minecraft villager — no big flat nose,
// no robe-block silhouette. This is a basket-woven person wearing a hat.
// ============================================================================

// ---- Palette (canonical Wickerkin bestiary palette) -------------------------
const PALETTE = {
  wicker: 0xe8d9b5, // warm wicker cream — main weave material
  weaveDark: 0x7c6136, // darker weave lines — alternating basket strips
  sash: 0xa5854e, // woven tan cloth sash
  spool: 0xc9a86a, // wicker-tan spool/satchel accent
  eye: 0x3e2f1c, // small beady eyes
};

// Plain centered box mesh.
function box(w, h, d, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Box mesh with its origin shifted to the TOP center of the geometry, so it
// can be parented to a hip/shoulder pivot and swing naturally from that
// pivot point rather than from its own center.
function hangingBox(w, h, d, material) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(0, -h / 2, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function build() {
  const root = new THREE.Group();
  root.name = 'Wickerkin';

  // ---- Materials -----------------------------------------------------
  const wickerMat = new THREE.MeshStandardMaterial({
    color: PALETTE.wicker,
    roughness: 0.85,
    metalness: 0.0,
  });
  const weaveDarkMat = new THREE.MeshStandardMaterial({
    color: PALETTE.weaveDark,
    roughness: 0.85,
    metalness: 0.0,
  });
  const hatMat = new THREE.MeshStandardMaterial({
    color: PALETTE.weaveDark,
    roughness: 0.8,
    metalness: 0.0,
  });
  const sashMat = new THREE.MeshStandardMaterial({
    color: PALETTE.sash,
    roughness: 0.7,
    metalness: 0.0,
  });
  const spoolMat = new THREE.MeshStandardMaterial({
    color: PALETTE.spool,
    roughness: 0.55,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.spool),
    emissiveIntensity: 0.08,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: PALETTE.eye,
    roughness: 0.9,
    metalness: 0.0,
  });

  // ---- bodyGroup: everything that bobs/breathes together ----------------
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  // ---- Legs — short stubby legs, feet resting at y=0 ---------------------
  function buildLeg(x) {
    const hipPivot = new THREE.Group();
    hipPivot.position.set(x, 0.20, 0);
    bodyGroup.add(hipPivot);

    const legMesh = hangingBox(0.14, 0.20, 0.14, weaveDarkMat);
    hipPivot.add(legMesh);

    return { hipPivot, legMesh };
  }
  const legL = buildLeg(-0.13);
  const legR = buildLeg(0.13);

  // ---- Torso — hourglass/barrel WOVEN silhouette --------------------------
  // Built from stacked strip-boxes narrowing at the waist, alternating
  // light/dark to suggest a basket weave.
  const torsoLower = box(0.46, 0.16, 0.40, wickerMat);
  torsoLower.position.set(0, 0.30, 0);
  bodyGroup.add(torsoLower);

  const torsoLowerStripe = box(0.47, 0.05, 0.41, weaveDarkMat);
  torsoLowerStripe.position.set(0, 0.24, 0);
  bodyGroup.add(torsoLowerStripe);

  const torsoWaist = box(0.34, 0.16, 0.30, weaveDarkMat);
  torsoWaist.position.set(0, 0.46, 0);
  bodyGroup.add(torsoWaist);

  const torsoWaistStripe = box(0.35, 0.05, 0.31, wickerMat);
  torsoWaistStripe.position.set(0, 0.40, 0);
  bodyGroup.add(torsoWaistStripe);

  const torsoUpper = box(0.44, 0.20, 0.38, wickerMat);
  torsoUpper.position.set(0, 0.65, 0);
  bodyGroup.add(torsoUpper);

  const torsoUpperStripe = box(0.45, 0.05, 0.39, weaveDarkMat);
  torsoUpperStripe.position.set(0, 0.57, 0);
  bodyGroup.add(torsoUpperStripe);

  // Green cloth sash, worn diagonally-ish across the waist (kept axis-
  // aligned as a simple wrap band for the voxel style).
  const sash = box(0.36, 0.07, 0.32, sashMat);
  sash.position.set(0, 0.46, 0);
  sash.rotation.y = Math.PI / 10;
  bodyGroup.add(sash);

  // ---- Head — small, sits atop the torso ---------------------------------
  const head = box(0.30, 0.24, 0.28, wickerMat);
  head.position.set(0, 0.90, 0);
  bodyGroup.add(head);

  // Small beady eyes.
  const eyeL = box(0.045, 0.045, 0.02, eyeMat);
  eyeL.position.set(-0.08, 0.92, 0.145);
  bodyGroup.add(eyeL);

  const eyeR = box(0.045, 0.045, 0.02, eyeMat);
  eyeR.position.set(0.08, 0.92, 0.145);
  bodyGroup.add(eyeR);

  // ---- Wide-brimmed woven hat ---------------------------------------------
  const hatBrim = box(0.56, 0.05, 0.56, hatMat);
  hatBrim.position.set(0, 1.03, 0);
  bodyGroup.add(hatBrim);

  const hatCrownLower = box(0.30, 0.10, 0.30, hatMat);
  hatCrownLower.position.set(0, 1.10, 0);
  bodyGroup.add(hatCrownLower);

  const hatCrownTop = box(0.20, 0.08, 0.20, wickerMat);
  hatCrownTop.position.set(0, 1.18, 0);
  bodyGroup.add(hatCrownTop);

  // Head anchor for name tags — fixed just above the hat's peak.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 1.32, 0);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // ---- Arms — short arms; right hand holds a little spool/satchel --------
  function buildArm(x, withSpool) {
    const shoulderPivot = new THREE.Group();
    shoulderPivot.position.set(x, 0.66, 0);
    bodyGroup.add(shoulderPivot);

    const armMesh = hangingBox(0.10, 0.20, 0.10, wickerMat);
    shoulderPivot.add(armMesh);

    let spoolMesh = null;
    if (withSpool) {
      spoolMesh = box(0.11, 0.11, 0.09, spoolMat);
      spoolMesh.position.set(x > 0 ? 0.02 : -0.02, -0.24, 0.05);
      shoulderPivot.add(spoolMesh);
    }

    return { shoulderPivot, armMesh, spoolMesh };
  }

  const armL = buildArm(-0.27, false);
  const armR = buildArm(0.27, true); // holds the little spool/satchel

  // ---- Store references for animate() ------------------------------------
  root.userData.parts = {
    bodyGroup,
    head,
    legL,
    legR,
    armL,
    armR,
  };

  // -------------------------------------------------------------------
  // ANIMATION
  // Idle: gentle overall bob (breathing) + a slow "humming" head sway,
  //       always active — this creature is calm and never hostile.
  // Moving: a small waddle — legs step with a side-to-side hip roll and
  //       arms swing lightly, spool-arm swaying its little satchel.
  // -------------------------------------------------------------------
  root.userData.animate = (t, state) => {
    const parts = root.userData.parts;
    const moving = !!(state && state.moving);
    const hurt = (state && state.hurt) || 0;

    // Breathing — subtle scale pulse, always active.
    const breathe = Math.sin(t * 1.8) * 0.02;
    bodyGroupScale(parts.bodyGroup, 1 + breathe * 0.5, 1 + breathe, 1 + breathe * 0.5);

    // Slow "humming" head sway — a gentle side-to-side + slight nod, always
    // active so the Wickerkin reads as content and alert even at rest.
    parts.head.rotation.y = Math.sin(t * 1.1) * 0.12;
    parts.head.rotation.z = Math.sin(t * 0.7 + 1.0) * 0.03;

    let bobY = Math.sin(t * 1.8) * 0.015; // idle bob baseline

    if (moving) {
      // Small waddle: legs step out of phase, hips roll side to side,
      // arms swing gently for balance (spool sways with the arm).
      const waddleCycle = t * 5.0;
      const stepSwing = Math.sin(waddleCycle);

      parts.legL.hipPivot.rotation.x = stepSwing * 0.5;
      parts.legR.hipPivot.rotation.x = -stepSwing * 0.5;

      // Hip/body roll gives the characteristic waddle sway.
      parts.bodyGroup.rotation.z = Math.sin(waddleCycle) * 0.06;

      parts.armL.shoulderPivot.rotation.x = -stepSwing * 0.35;
      parts.armR.shoulderPivot.rotation.x = stepSwing * 0.35;

      // Waddle adds an extra low-frequency step bob on top of breathing.
      bobY += Math.abs(Math.sin(waddleCycle)) * 0.05;
    } else {
      // At rest, legs and arms settle; body roll relaxes toward neutral.
      parts.legL.hipPivot.rotation.x = 0;
      parts.legR.hipPivot.rotation.x = 0;
      parts.bodyGroup.rotation.z = Math.sin(t * 1.1) * 0.015;

      // Idle arm sway — the spool-hand gives a tiny extra swing, as if
      // gently jostling its satchel while humming.
      parts.armL.shoulderPivot.rotation.x = Math.sin(t * 1.4) * 0.05;
      parts.armR.shoulderPivot.rotation.x = Math.sin(t * 1.4 + 0.6) * 0.08;
    }

    // Friendly flinch on hurt — a quick, small decaying dip+tilt rather
    // than an aggressive reaction, since Wickerkin is never hostile.
    if (hurt > 0) {
      const h = Math.min(hurt, 1);
      bobY -= Math.sin(h * Math.PI) * 0.05;
      parts.bodyGroup.rotation.x = Math.sin(h * Math.PI) * 0.08;
    } else {
      parts.bodyGroup.rotation.x = 0;
    }

    root.position.y = bobY;
  };

  return root;
}

// Helper to set bodyGroup scale (kept as a named helper for readability at
// the animate() call site).
function bodyGroupScale(group, x, y, z) {
  group.scale.set(x, y, z);
}

export const meta = {
  archetype: 'trader',
  species: 'Wickerkin',
  canonicalId: 'wickerkin',
  dimensionDefault: 'warpwold',
  palette: {
    wicker: '#E8D9B5',
    weaveDark: '#7C6136',
    sash: '#A5854E',
    spool: '#C9A86A',
    eye: '#3E2F1C',
  },
  description:
    'A friendly, neutral Warpwold trader woven entirely of wicker and ' +
    'basketwork: a barrel-shaped woven torso banded with alternating tan ' +
    'and dark weave strips, a wide-brimmed woven hat, small beady eyes, a ' +
    'green cloth sash, and a little red spool of thread held in one hand. ' +
    'Hums gently and waddles when it walks; never hostile.',
};
