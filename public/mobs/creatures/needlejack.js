import * as THREE from 'three';

// ---------------------------------------------------------------------------
// NEEDLEJACK — a hostile, nocturnal Warpwold prowler.
// Archetype: gaunt upright humanoid, folded and statue-still by day, that
// unbends at nightfall to hunt. Loomfall lore: a wrong-woven shape the Loom
// never meant to finish — its forearms taper into long needle-blade points,
// and every kill it lands is stitched into its body as another mismatched
// patch of cloth. It is not cruel. It is only wrong-woven.
//
// Silhouette goals: spindly, slightly hunched humanoid, ~1.2u tall. A
// narrow featureless head (a blunt vertical needle-eye slot). A torso
// studded with small offset stitched-on cloth patches of varying tone.
// Forearms taper into long thin angular needle-blades. Thin legs. NOT a
// Minecraft mob — no rounded proportions, no blocky arms/legs like a
// villager or zombie; everything reads thin, sharp, and off-kilter.
// ---------------------------------------------------------------------------

const PALETTE = {
  main: 0x4a4e57,     // slate steel — torso, head, legs
  recess: 0x2b2e35,   // dark recesses — joints, waist, eye slot
  needle: 0x8a8f9c,   // cold grey — needle-limb bases
  needlePale: 0xc0c6d4, // pale — needle-blade tips
  patch: 0x5e1f1f,    // dull blood-red — stitched patches / eye glow
};

function makeMaterials() {
  return {
    main: new THREE.MeshStandardMaterial({
      color: PALETTE.main,
      roughness: 0.85,
      metalness: 0.1,
    }),
    recess: new THREE.MeshStandardMaterial({
      color: PALETTE.recess,
      roughness: 0.9,
      metalness: 0.05,
    }),
    needle: new THREE.MeshStandardMaterial({
      color: PALETTE.needle,
      roughness: 0.4,
      metalness: 0.4,
    }),
    needlePale: new THREE.MeshStandardMaterial({
      color: PALETTE.needlePale,
      roughness: 0.25,
      metalness: 0.5,
    }),
    patch: new THREE.MeshStandardMaterial({
      color: PALETTE.patch,
      roughness: 0.8,
      metalness: 0.0,
      emissive: new THREE.Color(PALETTE.patch),
      emissiveIntensity: 0.15,
    }),
  };
}

// Box mesh whose origin sits at its TOP center, so it can hang off a joint
// pivot naturally — used for limb segments.
function hangingBox(w, h, d, material) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(0, -h / 2, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Plain centered box mesh.
function box(w, h, d, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function build() {
  const root = new THREE.Group();
  root.name = 'Needlejack';

  const mat = makeMaterials();
  const parts = {};

  // Leg reach determines hip height so feet land exactly at y=0.
  const UPPER_LEG = 0.32;
  const LOWER_LEG = 0.30;
  const HIP_Y = UPPER_LEG + LOWER_LEG; // 0.62

  // -------------------------------------------------------------------
  // TORSO — a narrow, slightly hunched upright body wrapped in
  // horizontal thread-bands, studded with small offset stitched patches.
  // -------------------------------------------------------------------
  const torsoPivot = new THREE.Group();
  torsoPivot.position.set(0, HIP_Y, 0);
  torsoPivot.rotation.x = 0.14; // permanent hunch
  root.add(torsoPivot);

  const waist = box(0.14, 0.10, 0.10, mat.recess);
  waist.position.set(0, 0.05, 0.0);
  torsoPivot.add(waist);

  const torso = box(0.18, 0.34, 0.13, mat.main);
  torso.position.set(0, 0.27, 0.0);
  torsoPivot.add(torso);

  // Thread-band trim across the chest/torso.
  const bandLower = box(0.185, 0.03, 0.135, mat.recess);
  bandLower.position.set(0, 0.16, 0.0);
  torsoPivot.add(bandLower);
  const bandUpper = box(0.185, 0.03, 0.135, mat.recess);
  bandUpper.position.set(0, 0.38, 0.0);
  torsoPivot.add(bandUpper);

  // Mismatched stitched-on cloth patches — small offset boxes of
  // varying tone, "kills stitched in".
  const patchDefs = [
    { x: 0.075, y: 0.20, z: 0.06, w: 0.05, h: 0.06, mat: mat.patch },
    { x: -0.08, y: 0.30, z: 0.055, w: 0.045, h: 0.04, mat: mat.needle },
    { x: 0.06, y: 0.38, z: 0.06, w: 0.04, h: 0.05, mat: mat.recess },
    { x: -0.06, y: 0.14, z: 0.06, w: 0.035, h: 0.035, mat: mat.patch },
  ];
  const patches = [];
  patchDefs.forEach((p) => {
    const patch = box(p.w, p.h, 0.015, p.mat);
    patch.position.set(p.x, p.y, p.z);
    patch.rotation.z = (Math.random() - 0.5) * 0.3;
    torsoPivot.add(patch);
    patches.push(patch);
  });
  parts.patches = patches;

  parts.torsoPivot = torsoPivot;

  // -------------------------------------------------------------------
  // HEAD — narrow, featureless, a blunt vertical needle-eye slot.
  // -------------------------------------------------------------------
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.46, 0.0);
  torsoPivot.add(headPivot);

  const skull = box(0.11, 0.16, 0.11, mat.main);
  skull.position.set(0, 0.08, 0.0);
  headPivot.add(skull);

  // Blunt needle-eye — a vertical slot of dark/glow color.
  const eyeSlot = box(0.015, 0.09, 0.015, mat.patch);
  eyeSlot.position.set(0, 0.09, 0.056);
  headPivot.add(eyeSlot);
  parts.eyeSlot = eyeSlot;

  parts.headPivot = headPivot;

  // Head anchor for name tags, above the head.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 0.62, 0.0);
  headPivot.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // ARMS — thin arms whose forearms taper into long needle-blade points.
  // Bent at wrong angles like a folding ruler, built shoulder+elbow so
  // both the idle flex and the attack stab read believably.
  // -------------------------------------------------------------------
  function buildArm(x, mirror) {
    const shoulderPivot = new THREE.Group();
    shoulderPivot.position.set(x, 0.40, 0.0);
    shoulderPivot.rotation.z = mirror * 0.12;
    torsoPivot.add(shoulderPivot);

    const upperArm = hangingBox(0.045, 0.20, 0.045, mat.main);
    shoulderPivot.add(upperArm);

    const elbowPivot = new THREE.Group();
    elbowPivot.position.set(0, -0.20, 0.0);
    elbowPivot.rotation.x = 0.35; // wrong-angle bend, folding-ruler read
    shoulderPivot.add(elbowPivot);

    // Forearm base — cold grey needle-limb.
    const forearmBase = hangingBox(0.035, 0.14, 0.035, mat.needle);
    elbowPivot.add(forearmBase);

    // Needle-blade tip — thin angular pale box tapering to a point,
    // achieved with a narrow tapering pair of stacked boxes.
    const bladeGroup = new THREE.Group();
    bladeGroup.position.set(0, -0.14, 0.0);
    elbowPivot.add(bladeGroup);

    const bladeMid = hangingBox(0.028, 0.14, 0.022, mat.needlePale);
    bladeGroup.add(bladeMid);

    const bladeTip = new THREE.Group();
    bladeTip.position.set(0, -0.14, 0.0);
    bladeGroup.add(bladeTip);
    const bladeTipMesh = hangingBox(0.012, 0.10, 0.010, mat.needlePale);
    bladeTip.add(bladeTipMesh);

    return { shoulderPivot, elbowPivot, bladeGroup, bladeTip };
  }

  const armL = buildArm(-0.135, -1);
  const armR = buildArm(0.135, 1);
  parts.armL = armL;
  parts.armR = armR;

  // -------------------------------------------------------------------
  // LEGS — thin legs, hip+knee pivots for a jerky stalking gait.
  // -------------------------------------------------------------------
  function buildLeg(x) {
    const hipPivot = new THREE.Group();
    hipPivot.position.set(x, 0, 0);
    root.add(hipPivot);

    const upperLeg = hangingBox(0.05, UPPER_LEG, 0.05, mat.main);
    hipPivot.add(upperLeg);

    const kneePivot = new THREE.Group();
    kneePivot.position.set(0, -UPPER_LEG, 0);
    hipPivot.add(kneePivot);

    const lowerLeg = hangingBox(0.04, LOWER_LEG, 0.04, mat.recess);
    kneePivot.add(lowerLeg);

    return { hipPivot, kneePivot };
  }

  const legsGroup = new THREE.Group();
  legsGroup.position.set(0, HIP_Y, 0);
  root.add(legsGroup);
  const legL = buildLeg(-0.06);
  const legR = buildLeg(0.06);
  legsGroup.add(legL.hipPivot);
  legsGroup.add(legR.hipPivot);
  parts.legL = legL;
  parts.legR = legR;

  // Feet-at-y0 sanity: legsGroup at y=HIP_Y (0.62), upper 0.32 + lower
  // 0.30 = 0.62 reach -> foot bottom at 0.0.

  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION
  // Idle: slow menacing needle-finger flex (elbow/blade sway) + faint
  //       body sway, eye-slot pulses faintly.
  // Walk: jerky stop-start stalking stride — legs and torso move in
  //       discrete held poses rather than a smooth sine, per the lore's
  //       "jerky stop-start gait".
  // Attack: fast needle-arm stab thrust, alternating limb lunges forward.
  // -------------------------------------------------------------------
  root.userData.animate = (t, state) => {
    const s = state || {};
    const moving = !!s.moving;
    const hurt = s.hurt || 0;
    const attack = s.attack || 0;

    // Idle breathing — always active, subtle sway.
    const breathe = Math.sin(t * 1.3);
    torsoPivot.scale.set(1 + breathe * 0.01, 1 + breathe * 0.02, 1 + breathe * 0.01);
    torsoPivot.rotation.z = Math.sin(t * 0.7) * 0.03;

    // Eye-slot faint pulse.
    if (mat.patch) {
      mat.patch.emissiveIntensity = 0.15 + Math.sin(t * 1.8) * 0.08 + hurt * 0.3;
    }

    if (moving) {
      // --- Jerky stop-start stalking stride ---
      // Build a stepped (quantized) phase so motion holds then snaps,
      // rather than smoothly interpolating like a normal walk cycle.
      const rawPhase = (t * 1.8) % 1;
      const steps = 6;
      const stepped = Math.floor(rawPhase * steps) / steps;
      const stride = stepped * Math.PI * 2;
      const swing = 0.5;

      legL.hipPivot.rotation.x = Math.sin(stride) * swing;
      legR.hipPivot.rotation.x = Math.sin(stride + Math.PI) * swing;
      legL.kneePivot.rotation.x = Math.max(0, Math.sin(stride - 0.5)) * 0.6;
      legR.kneePivot.rotation.x = Math.max(0, Math.sin(stride - 0.5 + Math.PI)) * 0.6;

      // Torso lurches forward with each held step.
      torsoPivot.rotation.x = 0.14 + Math.sin(stride) * 0.05;
      root.position.y = Math.abs(Math.sin(stride)) * 0.02;

      // Arms swing loosely, opposite the legs, with a stiff wrong-angle
      // flex at the elbow.
      armL.shoulderPivot.rotation.x = Math.sin(stride + Math.PI) * 0.3;
      armR.shoulderPivot.rotation.x = Math.sin(stride) * 0.3;
      armL.elbowPivot.rotation.x = 0.35 + Math.sin(stride * 0.5) * 0.15;
      armR.elbowPivot.rotation.x = 0.35 + Math.sin(stride * 0.5 + 1.0) * 0.15;
    } else {
      // --- Statue-still-by-day / idle menace by night: slow sway plus
      // a slow needle-finger flex at the elbows/blades. ---
      const sway = t * 0.9;
      torsoPivot.rotation.x = 0.14 + Math.sin(sway) * 0.015;
      root.position.y = Math.sin(sway * 1.1) * 0.005;

      legL.hipPivot.rotation.x += (0 - legL.hipPivot.rotation.x) * 0.08;
      legR.hipPivot.rotation.x += (0 - legR.hipPivot.rotation.x) * 0.08;
      legL.kneePivot.rotation.x += (0 - legL.kneePivot.rotation.x) * 0.08;
      legR.kneePivot.rotation.x += (0 - legR.kneePivot.rotation.x) * 0.08;

      armL.shoulderPivot.rotation.x += (0 - armL.shoulderPivot.rotation.x) * 0.08;
      armR.shoulderPivot.rotation.x += (0 - armR.shoulderPivot.rotation.x) * 0.08;

      // Slow menacing needle-finger flex: the blade-bearing elbow/tip
      // bends and straightens gently, out of phase left/right.
      armL.elbowPivot.rotation.x = 0.35 + Math.sin(sway * 1.4) * 0.10;
      armR.elbowPivot.rotation.x = 0.35 + Math.sin(sway * 1.4 + Math.PI) * 0.10;
      armL.bladeTip.rotation.x = Math.sin(sway * 1.4 + 0.4) * 0.12;
      armR.bladeTip.rotation.x = Math.sin(sway * 1.4 + Math.PI + 0.4) * 0.12;
    }

    // Fast needle-arm STAB thrust on attack — alternating limb lunge.
    if (attack > 0) {
      const a = Math.min(attack, 1);
      const stab = Math.sin(a * Math.PI); // ease out to full extension and back
      // Alternate which arm leads based on a coarse time bucket so
      // consecutive attacks visibly alternate limbs.
      const lead = Math.floor(t * 2) % 2 === 0;
      const leadArm = lead ? armR : armL;
      const otherArm = lead ? armL : armR;

      leadArm.shoulderPivot.rotation.x = -stab * 1.1;
      leadArm.elbowPivot.rotation.x = 0.1 - stab * 0.25;
      otherArm.shoulderPivot.rotation.x = -stab * 0.3;

      torsoPivot.rotation.x = 0.14 + stab * 0.18;
      headPivot.position.z = stab * 0.05;
    } else {
      headPivot.position.z += (0 - headPivot.position.z) * 0.3;
    }

    // Hurt flinch — sharp jolt, torso twists, eye flares (handled above).
    if (hurt > 0) {
      torsoPivot.rotation.z += Math.sin(t * 34) * hurt * 0.15;
      headPivot.rotation.x = Math.sin(t * 34) * hurt * 0.2;
    } else {
      headPivot.rotation.x *= 0.7;
    }
  };

  return root;
}

export const meta = {
  archetype: 'groaner',
  species: 'Needlejack',
  canonicalId: 'needlejack',
  dimensionDefault: 'warpwold',
  palette: {
    main: '#4A4E57',
    recess: '#2B2E35',
    needle: '#8A8F9C',
    needlePale: '#C0C6D4',
    patch: '#5E1F1F',
  },
  description:
    'A gaunt, hunched Warpwold prowler, wrong-woven by the Loom and never ' +
    'allowed to be anything else. It stands folded and statue-still through ' +
    'the day, then unbends at nightfall to stalk the dark in a jerky, ' +
    'stop-start gait, groaning like thread dragged through tight cloth. Its ' +
    'forearms taper into long, cold-grey needle-blades bent at wrong angles ' +
    'like a folding ruler, and its narrow slate-steel body is wrapped in ' +
    'thread-bands and studded with mismatched stitched-on cloth patches — ' +
    'every kill it lands sewn into itself. Its head is small and featureless ' +
    'but for a blunt needle-eye slot of dull blood-red where a face should ' +
    'be.',
};
