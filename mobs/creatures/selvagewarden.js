import * as THREE from 'three';

// ============================================================================
// SELVAGE WARDEN — Nevermend mini-boss, silent hem-thread guardian of the
// Last Selvage. Loomfall lore: where the great cloth of the world frays out
// into the void, the Loom binds off the raw edge with a warden woven from
// the hem itself — a tall, faceless sentinel of pale bound cloth that never
// speaks and never truly falls. Every wound reopens as a torn seam and is
// visibly RE-STITCHED moments later, the warden self-mending in slow
// shimmering pulses along its bands. It is bone/parchment pale, not dark —
// a keeper, not a horror. Broad squared shoulders, a wrapped hem-seamed
// torso, a smooth featureless cowled head with only a void-dark recess
// where a face would be, two heavy bound-thread arms (the right forearm
// IS a broad flat hem-blade), and a wrapped, banded lower body. ~1.7 units
// tall, bulky and statuesque.
// ============================================================================

// ---- Palette (canonical Selvage Warden bestiary palette) ------------------
const PALETTE = {
  hemCloth: 0xe8dfc8,   // pale hem-cloth — main body mass
  tan: 0xc9b98c,        // tan — secondary cloth wrap
  seam: 0x8c7b52,       // darker seam — hem-seam bands, stitching
  highlight: 0xf7f2e4,  // near-white — re-stitch shimmer / highlights
  voidRecess: 0x3a3220, // deep — cowl interior / recesses
  warm: 0xd4c7a3,       // warm — blade + accent wraps
};

function makeMaterials() {
  return {
    hemCloth: new THREE.MeshStandardMaterial({
      color: PALETTE.hemCloth,
      roughness: 0.85,
      metalness: 0.05,
    }),
    tan: new THREE.MeshStandardMaterial({
      color: PALETTE.tan,
      roughness: 0.8,
      metalness: 0.05,
    }),
    seam: new THREE.MeshStandardMaterial({
      color: PALETTE.seam,
      roughness: 0.75,
      metalness: 0.05,
    }),
    // Mutated live by animate() to sell the periodic "re-stitch" shimmer —
    // base is a soft glow, brief pulses push it brighter along the seams.
    highlight: new THREE.MeshStandardMaterial({
      color: PALETTE.highlight,
      roughness: 0.4,
      metalness: 0.05,
      emissive: new THREE.Color(PALETTE.highlight),
      emissiveIntensity: 0.25,
    }),
    voidRecess: new THREE.MeshStandardMaterial({
      color: PALETTE.voidRecess,
      roughness: 0.9,
      metalness: 0.0,
    }),
    warm: new THREE.MeshStandardMaterial({
      color: PALETTE.warm,
      roughness: 0.5,
      metalness: 0.1,
    }),
  };
}

function box(w, h, d, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Box mesh whose origin sits at its TOP center, for hanging off joint pivots.
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
  root.name = 'Selvage Wardens';

  const mat = makeMaterials();
  const parts = {};

  // Leg reach determines hip height so feet land exactly at y=0.
  const UPPER_LEG = 0.42;
  const LOWER_LEG = 0.40;
  const HIP_Y = UPPER_LEG + LOWER_LEG; // 0.82

  // ---- Legs: heavy wrapped-cloth boots and shins --------------------------
  function buildLeg(x) {
    const hipPivot = new THREE.Group();
    hipPivot.position.set(x, 0, 0);
    root.add(hipPivot);

    const upperLeg = hangingBox(0.24, UPPER_LEG, 0.22, mat.hemCloth);
    hipPivot.add(upperLeg);

    const kneePivot = new THREE.Group();
    kneePivot.position.set(0, -UPPER_LEG, 0);
    hipPivot.add(kneePivot);

    const lowerLeg = hangingBox(0.2, LOWER_LEG, 0.19, mat.tan);
    kneePivot.add(lowerLeg);

    const boot = box(0.24, 0.12, 0.28, mat.seam);
    boot.position.set(0, -LOWER_LEG + 0.02, 0.03);
    kneePivot.add(boot);

    return { hipPivot, kneePivot };
  }

  const legsGroup = new THREE.Group();
  legsGroup.position.set(0, HIP_Y, 0);
  root.add(legsGroup);
  const legL = buildLeg(-0.19);
  const legR = buildLeg(0.19);
  legsGroup.add(legL.hipPivot);
  legsGroup.add(legR.hipPivot);
  parts.legL = legL;
  parts.legR = legR;

  // ---- Torso: wrapped hem-seamed body mass, broad squared shoulders ------
  const torsoPivot = new THREE.Group();
  torsoPivot.position.set(0, HIP_Y, 0);
  root.add(torsoPivot);
  parts.torsoPivot = torsoPivot;

  const waist = box(0.34, 0.16, 0.28, mat.tan);
  waist.position.set(0, 0.1, 0);
  torsoPivot.add(waist);

  const waistSeam = box(0.35, 0.05, 0.29, mat.seam);
  waistSeam.position.set(0, 0.19, 0);
  torsoPivot.add(waistSeam);

  const lowerTorso = box(0.4, 0.28, 0.3, mat.hemCloth);
  lowerTorso.position.set(0, 0.4, 0);
  torsoPivot.add(lowerTorso);

  const midSeam = box(0.41, 0.05, 0.31, mat.seam);
  midSeam.position.set(0, 0.55, 0);
  torsoPivot.add(midSeam);

  const upperTorso = box(0.46, 0.3, 0.32, mat.hemCloth);
  upperTorso.position.set(0, 0.72, 0);
  torsoPivot.add(upperTorso);

  const chestSeam = box(0.47, 0.05, 0.33, mat.seam);
  chestSeam.position.set(0, 0.88, 0);
  torsoPivot.add(chestSeam);

  // Re-stitch shimmer strips — thin near-white bands laid over the main
  // hem-seams; animate() pulses their emissive intensity to read as
  // periodic self-mending flashes along the body.
  const restitchDefs = [
    { y: 0.19, w: 0.2, h: 0.02, d: 0.3 },
    { y: 0.55, w: 0.24, h: 0.02, d: 0.32 },
    { y: 0.88, w: 0.28, h: 0.02, d: 0.34 },
  ];
  const restitchStrips = restitchDefs.map((r) => {
    const strip = box(r.w, r.h, r.d, mat.highlight);
    strip.position.set(0, r.y + 0.005, 0);
    torsoPivot.add(strip);
    return strip;
  });
  parts.restitchStrips = restitchStrips;

  // Broad squared shoulders — pauldron-like blocks.
  const shoulderL = box(0.2, 0.18, 0.3, mat.hemCloth);
  shoulderL.position.set(-0.32, 0.92, 0);
  torsoPivot.add(shoulderL);
  const shoulderR = box(0.2, 0.18, 0.3, mat.hemCloth);
  shoulderR.position.set(0.32, 0.92, 0);
  torsoPivot.add(shoulderR);

  // ---- Head/cowl: smooth featureless cowl, void recess for a face --------
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 1.06, 0);
  torsoPivot.add(headPivot);
  parts.headPivot = headPivot;

  const neck = box(0.14, 0.06, 0.14, mat.tan);
  neck.position.set(0, 0.02, 0);
  headPivot.add(neck);

  const cowl = box(0.28, 0.3, 0.28, mat.hemCloth);
  cowl.position.set(0, 0.2, 0);
  headPivot.add(cowl);

  // Void recess — the featureless "face", a deep dark inset panel.
  const faceRecess = box(0.18, 0.16, 0.03, mat.voidRecess);
  faceRecess.position.set(0, 0.21, 0.14);
  headPivot.add(faceRecess);

  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 0.4, 0);
  headPivot.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // ---- Arms: heavy bound-thread arms; right forearm IS the hem-blade -----
  function buildArm(x, mirror, isBlade) {
    const shoulderPivot = new THREE.Group();
    shoulderPivot.position.set(x, 0.92, 0);
    shoulderPivot.rotation.z = mirror * 0.06;
    torsoPivot.add(shoulderPivot);

    const upperArm = hangingBox(0.16, 0.34, 0.16, mat.hemCloth);
    shoulderPivot.add(upperArm);

    const elbowPivot = new THREE.Group();
    elbowPivot.position.set(0, -0.34, 0);
    shoulderPivot.add(elbowPivot);

    let forearm;
    let bladeTip = null;
    if (isBlade) {
      // Broad flat hem-blade forming the forearm itself.
      const bladeBase = hangingBox(0.14, 0.3, 0.1, mat.tan);
      elbowPivot.add(bladeBase);

      const bladeGroup = new THREE.Group();
      bladeGroup.position.set(0, -0.3, 0);
      elbowPivot.add(bladeGroup);

      const bladeFlat = hangingBox(0.06, 0.34, 0.32, mat.warm);
      bladeGroup.add(bladeFlat);

      const bladeEdge = hangingBox(0.02, 0.34, 0.34, mat.highlight);
      bladeEdge.position.set(0.03, 0, 0);
      bladeGroup.add(bladeEdge);

      forearm = { bladeBase, bladeGroup, bladeFlat, bladeEdge };
      bladeTip = bladeGroup;
    } else {
      const forearmBox = hangingBox(0.14, 0.32, 0.14, mat.hemCloth);
      elbowPivot.add(forearmBox);

      const fistBlock = hangingBox(0.16, 0.12, 0.16, mat.tan);
      fistBlock.position.set(0, -0.31, 0);
      elbowPivot.add(fistBlock);

      forearm = { forearmBox, fistBlock };
    }

    return { shoulderPivot, elbowPivot, forearm, bladeTip };
  }

  const armL = buildArm(-0.44, -1, false);
  const armR = buildArm(0.44, 1, true);
  parts.armL = armL;
  parts.armR = armR;

  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION
  // Idle: slow sentinel sway + a periodic "re-stitch" shimmer pulse along
  //       the hem-seam bands (self-mending).
  // Walk (state.moving): heavy deliberate stride, big weighted footfalls.
  // Attack (state.attack): broad hem-blade sweep with the right arm.
  // -------------------------------------------------------------------
  root.userData.animate = (t, state) => {
    const s = state || {};
    const moving = !!s.moving;
    const hurt = Math.min(Math.max(s.hurt || 0, 0), 1);
    const attack = Math.min(Math.max(s.attack || 0, 0), 1);

    // Slow, heavy sentinel sway — always active, statuesque.
    const sway = Math.sin(t * 0.55) * 0.03;
    torsoPivot.rotation.z = sway;
    torsoPivot.rotation.y = Math.sin(t * 0.4) * 0.02;
    torsoPivot.scale.set(1, 1 + Math.sin(t * 0.9) * 0.008, 1);

    // Periodic re-stitch shimmer: each seam strip flashes brighter in a
    // staggered pulse traveling up the body, selling continuous self-mend.
    parts.restitchStrips.forEach((strip, i) => {
      const cycle = (t * 0.6 + i * 0.35) % 3;
      const flash = cycle < 0.4 ? (1 - cycle / 0.4) : 0;
      strip.material.emissiveIntensity = 0.25 + flash * 1.6 + hurt * 0.6;
      const k = 1 + flash * 0.15;
      strip.scale.set(k, 1, k);
    });

    if (moving) {
      // Heavy deliberate stride — slower, weighted, with a strong stomp.
      const strideSpeed = 1.4;
      const stride = t * strideSpeed;
      const swing = 0.45;

      legL.hipPivot.rotation.x = Math.sin(stride) * swing;
      legR.hipPivot.rotation.x = Math.sin(stride + Math.PI) * swing;
      legL.kneePivot.rotation.x = Math.max(0, -Math.sin(stride)) * 0.5;
      legR.kneePivot.rotation.x = Math.max(0, -Math.sin(stride + Math.PI)) * 0.5;

      // Weighted footfall bob — dips heavier on each plant.
      const stomp = Math.abs(Math.sin(stride * 1.0));
      root.position.y = stomp * 0.015;

      torsoPivot.rotation.x = 0.03 + Math.sin(stride) * 0.03;

      // Arms swing opposite the legs, heavy and slow.
      armL.shoulderPivot.rotation.x = Math.sin(stride + Math.PI) * 0.22;
      armR.shoulderPivot.rotation.x = Math.sin(stride) * 0.15;
    } else {
      torsoPivot.rotation.x += (0.02 - torsoPivot.rotation.x) * 0.06;
      legL.hipPivot.rotation.x += (0 - legL.hipPivot.rotation.x) * 0.08;
      legR.hipPivot.rotation.x += (0 - legR.hipPivot.rotation.x) * 0.08;
      legL.kneePivot.rotation.x += (0 - legL.kneePivot.rotation.x) * 0.08;
      legR.kneePivot.rotation.x += (0 - legR.kneePivot.rotation.x) * 0.08;
      armL.shoulderPivot.rotation.x += (0 - armL.shoulderPivot.rotation.x) * 0.08;
      if (attack <= 0) {
        armR.shoulderPivot.rotation.x += (0 - armR.shoulderPivot.rotation.x) * 0.08;
        armR.elbowPivot.rotation.x += (0 - armR.elbowPivot.rotation.x) * 0.08;
      }
      root.position.y += (0 - root.position.y) * 0.1;
    }

    // Broad hem-blade sweep on attack: the right arm winds back then
    // sweeps a wide horizontal arc, torso rotating through with it.
    if (attack > 0) {
      const a = Math.min(attack, 1);
      const windup = Math.min(a * 2.5, 1);
      const sweep = a < 0.35 ? -windup * 0.5 : Math.min((a - 0.35) / 0.65, 1);
      const easedSweep = Math.sin(sweep * Math.PI * 0.5);

      armR.shoulderPivot.rotation.y = -0.9 + easedSweep * 1.9;
      armR.shoulderPivot.rotation.x = -0.25 + easedSweep * 0.35;
      armR.elbowPivot.rotation.x = -0.15;

      torsoPivot.rotation.y = Math.sin(t * 0.4) * 0.02 + (easedSweep - 0.5) * 0.3;
    } else {
      armR.shoulderPivot.rotation.y += (0 - armR.shoulderPivot.rotation.y) * 0.15;
      armR.shoulderPivot.rotation.z += (0 - armR.shoulderPivot.rotation.z) * 0.15;
    }

    // Hurt jolt: sharp lateral snap that decays with the hurt value.
    if (hurt > 0) {
      torsoPivot.position.x = Math.sin(t * 36) * 0.03 * hurt;
      headPivot.rotation.z = Math.sin(t * 30) * 0.08 * hurt;
    } else {
      torsoPivot.position.x = 0;
      headPivot.rotation.z *= 0.8;
    }
  };

  return root;
}

export const meta = {
  archetype: 'boss',
  species: 'Selvage Wardens',
  canonicalId: 'selvage_warden',
  dimensionDefault: 'nevermend',
  palette: {
    hemCloth: '#E8DFC8',
    tan: '#C9B98C',
    seam: '#8C7B52',
    highlight: '#F7F2E4',
    voidRecess: '#3A3220',
    warm: '#D4C7A3',
  },
  description:
    'A Nevermend mini-boss: the silent hem-thread guardian of the Last ' +
    'Selvage, where the great cloth of the world frays out into the void. ' +
    'A tall, imposing, faceless sentinel woven from bound hem-cloth — ' +
    'bone/parchment pale, not dark — with broad squared shoulders, a torso ' +
    'wrapped in visible horizontal hem-seams that look freshly re-stitched, ' +
    'and a smooth featureless cowl hiding only a deep void-dark recess ' +
    'where a face would be. Its heavy bound-thread arms end one in a plain ' +
    'wrapped fist, the other in a broad flat hem-blade grown from the ' +
    'forearm itself. Every wound reopens as a torn seam and is visibly ' +
    'mended moments later in a slow shimmering pulse along its bands — it ' +
    'does not bleed, it re-stitches. It is a keeper of the edge, not a ' +
    'horror: unhurried, unspeaking, and almost impossible to truly unmake.',
};
