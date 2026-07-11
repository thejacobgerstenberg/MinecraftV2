import * as THREE from 'three';

// ---------------------------------------------------------------------------
// FRAYED HOUND — a hostile, nocturnal Warpwold pack-predator.
// Archetype: groaner base (reworked low & fast) — a mangy, thread-ridged
// canid that hunts in packs after dark. Loomfall lore: when a stray length
// of the Weaver's yarn is dragged loose from the Loom and left ungathered
// too long in the dark fields, it can knot itself into a hungry shape — a
// Frayed Hound. Its fur is not fur at all but thousands of trailing loose
// threads, mangy and thin, bristling into a ragged ridge along the spine.
//
// Silhouette goals: LOW, CROUCHED, four-legged canid, clearly longer than
// tall (~0.8u tall). An elongated snout with a visibly stitched jaw seam. A
// raised ridge of frayed thread strands running from the base of the neck
// down the spine. A ragged, drooping tail. Taut, coiled-looking legs (never
// straight rigid pillars) built from hip+knee joints so the crouch and gait
// both read believably. NOT a Minecraft wolf — mangier, lower, meaner.
// ---------------------------------------------------------------------------

const PALETTE = {
  fur: 0x3a3630,     // charcoal thread-fur, main coat
  underside: 0x26231f, // darker underside/belly
  maw: 0x7a2e2e,      // sinew-red maw / inner mouth
  eye: 0xc9b98a,      // pale stitched eyes, faint emissive
};

function makeMaterials() {
  return {
    fur: new THREE.MeshStandardMaterial({
      color: PALETTE.fur,
      roughness: 0.95,
      metalness: 0.0,
    }),
    underside: new THREE.MeshStandardMaterial({
      color: PALETTE.underside,
      roughness: 0.95,
      metalness: 0.0,
    }),
    maw: new THREE.MeshStandardMaterial({
      color: PALETTE.maw,
      roughness: 0.7,
      metalness: 0.0,
    }),
    eye: new THREE.MeshStandardMaterial({
      color: PALETTE.eye,
      roughness: 0.35,
      metalness: 0.05,
      emissive: new THREE.Color(PALETTE.eye),
      emissiveIntensity: 0.35,
    }),
  };
}

// Box mesh whose origin sits at its TOP center, so it can hang/droop off a
// joint pivot naturally — used for the tail chain and ridge threads.
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
  root.name = 'Frayed Hound';

  const mat = makeMaterials();
  const parts = {};

  // Hip height above the ground for a low, crouched stance.
  const HIP_Y = 0.30;
  const SHOULDER_Y = 0.34;

  // -------------------------------------------------------------------
  // SPINE/TORSO — a low, elongated, permanently crouched body. Built as
  // a pivot with a slight forward pitch so the whole silhouette reads
  // coiled/prowling rather than a flat rectangular box on stilts.
  // -------------------------------------------------------------------
  const spinePivot = new THREE.Group();
  spinePivot.position.set(0, SHOULDER_Y, 0);
  spinePivot.rotation.x = 0.05; // slight permanent forward crouch
  root.add(spinePivot);

  // Ribcage/chest — front mass, slightly raised toward the shoulders.
  const chest = box(0.22, 0.20, 0.30, mat.fur);
  chest.position.set(0, 0.02, 0.22);
  spinePivot.add(chest);

  // Hindquarters — rear mass, coiled/bunched for a pouncing read.
  const haunches = box(0.24, 0.22, 0.26, mat.fur);
  haunches.position.set(0, -0.01, -0.22);
  spinePivot.add(haunches);

  // Waist — narrow connector between chest and haunches, tucked belly.
  const waist = box(0.16, 0.14, 0.20, mat.fur);
  waist.position.set(0, -0.04, 0.0);
  spinePivot.add(waist);

  // Belly/underside strip — darker, visible from beneath the tucked waist.
  const belly = box(0.15, 0.06, 0.44, mat.underside);
  belly.position.set(0, -0.11, 0.0);
  spinePivot.add(belly);

  parts.spinePivot = spinePivot;

  // -------------------------------------------------------------------
  // SPINE RIDGE — a row of raised frayed thread strands along the
  // neck/spine, each a thin hanging box pivoted so it can bristle and
  // waver independently. Tallest near the neck, tapering toward the tail.
  // -------------------------------------------------------------------
  const ridge = [];
  const ridgeDefs = [
    { x: 0.0, z: 0.32, h: 0.10 }, // neck base
    { x: 0.0, z: 0.22, h: 0.13 },
    { x: 0.0, z: 0.10, h: 0.15 }, // tallest, over the shoulders
    { x: 0.0, z: -0.02, h: 0.13 },
    { x: 0.0, z: -0.14, h: 0.11 },
    { x: 0.0, z: -0.26, h: 0.08 }, // lower back, tapering off
  ];
  ridgeDefs.forEach(({ x, z, h }, i) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.11, z);
    spinePivot.add(pivot);
    const strand = hangingBox(0.02, h, 0.02, mat.underside);
    strand.rotation.x = Math.PI; // flip so it points UP off the top pivot
    pivot.add(strand);
    ridge.push(pivot);
  });
  parts.ridge = ridge;

  // -------------------------------------------------------------------
  // HEAD — elongated snout on a low, forward-jutting neck.
  // -------------------------------------------------------------------
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.06, 0.34);
  headPivot.rotation.x = -0.06; // muzzle tips slightly down, prowling
  spinePivot.add(headPivot);

  const skull = box(0.14, 0.13, 0.15, mat.fur);
  skull.position.set(0, 0.06, 0.0);
  headPivot.add(skull);

  // Elongated snout, tapering forward.
  const snout = box(0.10, 0.09, 0.18, mat.fur);
  snout.position.set(0, 0.03, 0.15);
  headPivot.add(snout);

  // Lower jaw — separate piece pivoted at the hinge so it can snap open.
  const jawPivot = new THREE.Group();
  jawPivot.position.set(0, 0.0, 0.10);
  headPivot.add(jawPivot);
  const jaw = box(0.09, 0.045, 0.16, mat.underside);
  jaw.position.set(0, -0.02, 0.06);
  jawPivot.add(jaw);

  // Sinew-red inner mouth, visible at the seam between snout and jaw.
  const maw = box(0.08, 0.03, 0.03, mat.maw);
  maw.position.set(0, -0.005, 0.0);
  jawPivot.add(maw);

  // Stitched jaw seam trim, small dark strip along the muzzle underside.
  const jawSeam = box(0.095, 0.015, 0.17, mat.underside);
  jawSeam.position.set(0, 0.01, 0.15);
  headPivot.add(jawSeam);

  // Two pale stitched eyes, faint emissive glow.
  const eyeGeo = { w: 0.025, h: 0.025, d: 0.02 };
  const eyeL = box(eyeGeo.w, eyeGeo.h, eyeGeo.d, mat.eye);
  eyeL.position.set(-0.055, 0.08, 0.075);
  headPivot.add(eyeL);
  const eyeR = box(eyeGeo.w, eyeGeo.h, eyeGeo.d, mat.eye);
  eyeR.position.set(0.055, 0.08, 0.075);
  headPivot.add(eyeR);

  // Two low, back-swept ears — mangy triangular-ish stumps (boxes).
  const earPivotL = new THREE.Group();
  earPivotL.position.set(-0.05, 0.12, -0.03);
  headPivot.add(earPivotL);
  const earL = box(0.03, 0.08, 0.02, mat.underside);
  earL.position.set(0, 0.03, 0.0);
  earPivotL.add(earL);

  const earPivotR = new THREE.Group();
  earPivotR.position.set(0.05, 0.12, -0.03);
  headPivot.add(earPivotR);
  const earR = box(0.03, 0.08, 0.02, mat.underside);
  earR.position.set(0, 0.03, 0.0);
  earPivotR.add(earR);

  parts.headPivot = headPivot;
  parts.jawPivot = jawPivot;
  parts.earPivotL = earPivotL;
  parts.earPivotR = earPivotR;

  // Head anchor for name tags — above the head, low since the hound is low.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 0.62, 0.34);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // TAIL — a ragged, drooping chain of shrinking boxes off the rear.
  // -------------------------------------------------------------------
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.08, -0.34);
  tailPivot.rotation.x = 0.55; // droops down and back
  spinePivot.add(tailPivot);

  const tailBase = hangingBox(0.055, 0.16, 0.055, mat.fur);
  tailPivot.add(tailBase);

  const tailMid = new THREE.Group();
  tailMid.position.set(0, -0.15, -0.02);
  tailPivot.add(tailMid);
  const tailMidSeg = hangingBox(0.045, 0.13, 0.045, mat.underside);
  tailMid.add(tailMidSeg);

  const tailTip = new THREE.Group();
  tailTip.position.set(0, -0.12, -0.02);
  tailMid.add(tailTip);
  const tailTipSeg = hangingBox(0.03, 0.10, 0.03, mat.fur);
  tailTip.add(tailTipSeg);

  parts.tailPivot = tailPivot;
  parts.tailMid = tailMid;
  parts.tailTip = tailTip;

  // -------------------------------------------------------------------
  // LEGS — taut, coiled quadruped legs built from hip/shoulder + knee
  // pivots so the crouch, idle prowl and fast gallop all read believably.
  // Front legs hang from the chest area, rear from the haunches.
  // -------------------------------------------------------------------
  function buildLeg(x, z, upperLen, lowerLen, parentGroup) {
    const upperPivot = new THREE.Group();
    upperPivot.position.set(x, 0, z);
    parentGroup.add(upperPivot);

    const upperLeg = hangingBox(0.06, upperLen, 0.065, mat.fur);
    upperPivot.add(upperLeg);

    const kneePivot = new THREE.Group();
    kneePivot.position.set(0, -upperLen, 0);
    upperPivot.add(kneePivot);

    const lowerLeg = hangingBox(0.05, lowerLen, 0.055, mat.underside);
    kneePivot.add(lowerLeg);

    return { upperPivot, kneePivot, upperLeg, lowerLeg };
  }

  // Front legs pivot from a group at shoulder height under the chest.
  const frontLegsGroup = new THREE.Group();
  frontLegsGroup.position.set(0, SHOULDER_Y, 0.20);
  root.add(frontLegsGroup);
  const legFR = buildLeg(-0.09, 0, 0.16, 0.18, frontLegsGroup);
  const legFL = buildLeg(0.09, 0, 0.16, 0.18, frontLegsGroup);

  // Rear legs pivot from a group at hip height under the haunches.
  const rearLegsGroup = new THREE.Group();
  rearLegsGroup.position.set(0, HIP_Y, -0.22);
  root.add(rearLegsGroup);
  const legBR = buildLeg(-0.10, 0, 0.15, 0.15, rearLegsGroup);
  const legBL = buildLeg(0.10, 0, 0.15, 0.15, rearLegsGroup);

  // legs array in [FR, FL, BR, BL] order, matching the diagonal-pair gait.
  const legs = [legFR, legFL, legBR, legBL];
  parts.legs = legs;

  // Feet-at-y0 sanity: frontLegsGroup at y=0.34, upper 0.16 + lower 0.18
  // = 0.34 reach -> foot bottom at 0.0. rearLegsGroup at y=0.30, upper
  // 0.15 + lower 0.15 = 0.30 reach -> foot bottom at 0.0.

  // -------------------------------------------------------------------
  // Store all animated sub-parts for animate() to reach.
  // -------------------------------------------------------------------
  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION
  // Idle: low prowl sway + spine-ridge threads waver + ears pin back
  //       occasionally + tail droops and flicks.
  // Walk: fast diagonal-pair quadruped gallop/lope (FR+BL together,
  //       FL+BR together), body surges forward/down with each stride,
  //       spine ridge bristles more with speed.
  // Hurt/attack: jaw snap open, head lunge forward, sharp flinch jolt.
  // -------------------------------------------------------------------
  root.userData.animate = (t, state) => {
    const s = state || {};
    const moving = !!s.moving;
    const hurt = s.hurt || 0;
    const attack = s.attack || 0;

    // Idle breathing — always active, subtle low prowl bob.
    const breathe = Math.sin(t * 2.2);
    spinePivot.scale.set(1 + breathe * 0.015, 1 + breathe * 0.025, 1 + breathe * 0.012);

    if (moving) {
      // --- Fast diagonal-pair gallop/lope ---
      const stride = t * 13.0; // quick, fast gait speed
      const swing = 0.6;

      legFR.upperPivot.rotation.x = Math.sin(stride) * swing;
      legBL.upperPivot.rotation.x = Math.sin(stride) * swing;
      legFL.upperPivot.rotation.x = Math.sin(stride + Math.PI) * swing;
      legBR.upperPivot.rotation.x = Math.sin(stride + Math.PI) * swing;

      legFR.kneePivot.rotation.x = Math.max(0, Math.sin(stride - 0.6)) * 0.7;
      legBL.kneePivot.rotation.x = Math.max(0, Math.sin(stride - 0.6)) * 0.7;
      legFL.kneePivot.rotation.x = Math.max(0, Math.sin(stride - 0.6 + Math.PI)) * 0.7;
      legBR.kneePivot.rotation.x = Math.max(0, Math.sin(stride - 0.6 + Math.PI)) * 0.7;

      // Spine surges forward/up-down with each stride pair for a
      // galloping-canid read, and crouches lower overall while running.
      spinePivot.rotation.x = 0.05 + Math.sin(stride) * 0.06;
      root.position.y = Math.abs(Math.sin(stride)) * 0.035;
      spinePivot.position.z = Math.sin(stride * 2) * 0.01;

      // Ears pin flat back while running.
      earPivotL.rotation.x = -0.5;
      earPivotR.rotation.x = -0.5;

      // Tail streams out behind, flatter, with a fast whip.
      tailPivot.rotation.x = 0.15 + Math.sin(stride * 0.5) * 0.06;
      tailMid.rotation.z = Math.sin(stride * 0.7 + 0.6) * 0.25;
      tailTip.rotation.z = Math.sin(stride * 0.7 + 1.2) * 0.35;
    } else {
      // --- Low idle prowl ---
      const prowl = t * 1.4;
      spinePivot.rotation.x = 0.05 + Math.sin(prowl) * 0.02;
      root.position.y = Math.sin(prowl * 1.3) * 0.008;

      // Legs settle to a taut, slightly bent crouch stance.
      legs.forEach((leg, i) => {
        const drift = Math.sin(prowl + i * 1.7) * 0.02;
        leg.upperPivot.rotation.x += (drift - leg.upperPivot.rotation.x) * 0.1;
        leg.kneePivot.rotation.x += (0.12 - leg.kneePivot.rotation.x) * 0.1;
      });

      // Ears occasionally pin back — a discrete twitch every few seconds.
      const earCycle = t % 3.5;
      let earPin = 0;
      if (earCycle < 0.6) {
        earPin = Math.sin((earCycle / 0.6) * Math.PI) * 0.55;
      }
      earPivotL.rotation.x = -earPin;
      earPivotR.rotation.x = -earPin;

      // Tail droops and gives a slow ragged flick.
      tailPivot.rotation.x = 0.55 + Math.sin(prowl * 0.6) * 0.05;
      tailMid.rotation.z = Math.sin(prowl * 0.8 + 0.5) * 0.12;
      tailTip.rotation.z = Math.sin(prowl * 0.8 + 1.0) * 0.18;
    }

    // Spine-ridge threads waver independently at all times — the mangy,
    // frayed read of the creature never goes fully still.
    const ridgeSpeed = moving ? 5.0 : 1.6;
    ridge.forEach((strand, i) => {
      strand.rotation.z = Math.sin(t * ridgeSpeed + i * 0.9) * (moving ? 0.22 : 0.12);
      strand.rotation.x = Math.cos(t * ridgeSpeed * 0.8 + i * 1.2) * 0.08;
    });

    // Jaw snap + lunge on attack — opens sharply then eases back.
    if (attack > 0) {
      jawPivot.rotation.x = Math.sin(Math.min(attack, 1) * Math.PI) * 0.55;
      headPivot.position.z = 0.34 + Math.sin(Math.min(attack, 1) * Math.PI) * 0.08;
    } else {
      jawPivot.rotation.x *= 0.8;
      headPivot.position.z += (0.34 - headPivot.position.z) * 0.3;
    }

    // Hurt flinch — a sharp jolt plus a startled ear-pin and bared maw.
    if (hurt > 0) {
      spinePivot.rotation.z = Math.sin(t * 32) * hurt * 0.18;
      headPivot.rotation.x = -0.06 - hurt * 0.15;
      earPivotL.rotation.x = -0.55;
      earPivotR.rotation.x = -0.55;
      jawPivot.rotation.x = Math.max(jawPivot.rotation.x, hurt * 0.35);
    } else {
      spinePivot.rotation.z *= 0.7;
    }
  };

  return root;
}

export const meta = {
  archetype: 'groaner',
  species: 'Frayed Hound',
  dimensionDefault: 'warpwold',
  palette: {
    fur: '#3A3630',
    underside: '#26231F',
    maw: '#7A2E2E',
    eye: '#C9B98A',
  },
  description:
    'A lean, hostile nocturnal pack-predator of Warpwold, knotted from a ' +
    'length of the Weaver\'s yarn dragged loose from the Loom and left ' +
    'ungathered too long in the dark fields. Its charcoal coat is not fur ' +
    'but thousands of trailing loose threads, bristling into a ragged ridge ' +
    'along its spine and neck. It crouches low on taut, coiled legs, its ' +
    'elongated snout stitched shut but for a sinew-red maw, its stitched ' +
    'eyes a faint pale glow in the night, and a ragged thread tail dragging ' +
    'behind as it lopes down prey in a fast diagonal-pair gallop.',
};
