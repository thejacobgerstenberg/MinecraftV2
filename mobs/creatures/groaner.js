import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Understruck — a hostile, mournful Warpwold wraith of unravelling cloth.
// Archetype: groaner
//
// Silhouette goals (per design brief): tall (~1.3u), gaunt, HUNCHED — never
// an upright rectangular box-man. Overlong asymmetric arms hang past the
// knees and sway. The head droops forward with a single vertical seam-mouth
// and two hollow stitched eyes. Loose bandage/thread strips trail off the
// shoulders and waist. A faint blue Thrum glow pulses at a chest seam.
// ---------------------------------------------------------------------------

// Palette — dust-grey unravelled cloth, darker frayed seams, faint Thrum glow.
const PALETTE = {
  cloth: 0x8a8577,      // main sagging bandage/thread cloth
  clothShade: 0x716c60, // slightly darker cloth for secondary wraps (asymmetry read)
  seam: 0x4e4a42,       // frayed seams / stitched trim
  voidEye: 0x201e19,    // hollow stitched eye sockets / mouth seam
  thrum: 0x5fa8b0,      // faint blue Thrum glow at the chest seam
};

// Shared materials (kept low-count; reused across meshes where sensible).
function makeMaterials() {
  return {
    cloth: new THREE.MeshStandardMaterial({
      color: PALETTE.cloth,
      roughness: 0.95,
      metalness: 0.0,
    }),
    clothShade: new THREE.MeshStandardMaterial({
      color: PALETTE.clothShade,
      roughness: 0.95,
      metalness: 0.0,
    }),
    seam: new THREE.MeshStandardMaterial({
      color: PALETTE.seam,
      roughness: 1.0,
      metalness: 0.0,
    }),
    voidEye: new THREE.MeshStandardMaterial({
      color: PALETTE.voidEye,
      roughness: 1.0,
      metalness: 0.0,
    }),
    thrum: new THREE.MeshStandardMaterial({
      color: PALETTE.thrum,
      roughness: 0.4,
      metalness: 0.1,
      emissive: new THREE.Color(PALETTE.thrum),
      emissiveIntensity: 0.9,
    }),
  };
}

// Small helper: box mesh with an origin at its TOP center, so it can be
// parented to a joint pivot and "hang" downward naturally (like cloth/limbs).
function hangingBox(w, h, d, material) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(0, -h / 2, 0); // shift geometry so pivot origin = top face center
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
  root.name = 'Understruck';

  const mat = makeMaterials();
  const parts = {};

  // Hip height above the ground (y=0). Legs are built to exactly this
  // length so the feet rest on the ground plane, and the torso/hip pivot
  // sits at this same height so everything lines up.
  const HIP_Y = 0.50;

  // -------------------------------------------------------------------
  // TORSO — tall, gaunt, hunched forward. Tilting the whole torso group
  // forward (rotation.x) plus dropping the shoulder line reads as a
  // "hunch" rather than an upright box-man silhouette.
  // -------------------------------------------------------------------
  const torsoPivot = new THREE.Group();
  torsoPivot.position.set(0, HIP_Y, 0.02); // base of spine, slightly forward
  torsoPivot.rotation.x = 0.22; // permanent forward hunch
  root.add(torsoPivot);

  const torso = box(0.34, 0.62, 0.24, mat.cloth);
  torso.position.set(0, 0.31, 0); // grows upward from the pivot (hip) point
  torsoPivot.add(torso);

  // Asymmetric secondary wrap slumping off one side of the torso — breaks
  // the rectangular-box-man read.
  const torsoWrap = box(0.16, 0.4, 0.26, mat.clothShade);
  torsoWrap.position.set(-0.16, 0.2, 0.02);
  torsoWrap.rotation.z = 0.18;
  torsoPivot.add(torsoWrap);

  // Chest seam — faint blue Thrum glow.
  const chestSeam = box(0.08, 0.22, 0.03, mat.thrum);
  chestSeam.position.set(0.03, 0.34, 0.14);
  torsoPivot.add(chestSeam);

  parts.torsoPivot = torsoPivot;
  parts.chestSeam = chestSeam;

  // -------------------------------------------------------------------
  // HEAD — drooping forward off the hunched neckline, off-center.
  // -------------------------------------------------------------------
  const headPivot = new THREE.Group();
  headPivot.position.set(-0.02, 0.60, 0.05); // sits atop torsoPivot's local space
  headPivot.rotation.x = 0.30; // extra forward droop beyond the torso hunch
  torsoPivot.add(headPivot);

  const head = box(0.22, 0.24, 0.20, mat.cloth);
  head.position.set(0, 0.12, 0);
  headPivot.add(head);

  // Vertical seam-mouth.
  const mouth = box(0.03, 0.14, 0.02, mat.voidEye);
  mouth.position.set(0, 0.09, 0.105);
  headPivot.add(mouth);

  // Two hollow stitched eyes (small, sunken, asymmetric spacing).
  const eyeL = box(0.035, 0.035, 0.02, mat.voidEye);
  eyeL.position.set(-0.06, 0.16, 0.105);
  headPivot.add(eyeL);

  const eyeR = box(0.035, 0.035, 0.02, mat.voidEye);
  eyeR.position.set(0.055, 0.155, 0.105);
  headPivot.add(eyeR);

  parts.headPivot = headPivot;

  // Head anchor for name tags — just above the drooped head.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 1.38, 0.02);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // SHOULDERS + OVERLONG ARMS — asymmetric bundles of wrapped thread at
  // the shoulders, with long dangling arms that hang past the knees.
  // -------------------------------------------------------------------
  function buildArm({ side, shoulderY, shoulderX, upperLen, foreLen, shade, withTrailing }) {
    const shoulderPivot = new THREE.Group();
    shoulderPivot.position.set(shoulderX, shoulderY, 0.0);
    torsoPivot.add(shoulderPivot);

    // Loose thread bundle draped over the shoulder.
    const shoulderWrap = box(0.11, 0.10, 0.14, shade ? mat.clothShade : mat.cloth);
    shoulderWrap.position.set(side * 0.02, -0.02, 0.0);
    shoulderPivot.add(shoulderWrap);

    // Upper arm hangs from the shoulder pivot (this pivot is what swings).
    const upperArm = hangingBox(0.07, upperLen, 0.07, mat.cloth);
    shoulderPivot.add(upperArm);

    // Forearm pivots from the elbow (bottom of the upper arm) for a second
    // joint of sway, and dangles further — reaching past the knee.
    const elbowPivot = new THREE.Group();
    elbowPivot.position.set(0, -upperLen, 0);
    shoulderPivot.add(elbowPivot);

    const forearm = hangingBox(0.055, foreLen, 0.055, mat.clothShade);
    elbowPivot.add(forearm);

    // A frayed thread trailing off the forearm's end — only on the longer
    // (left) arm, keeping the silhouette asymmetric.
    let trailing = null;
    if (withTrailing) {
      trailing = hangingBox(0.02, 0.12, 0.02, mat.seam);
      trailing.position.set(0, -foreLen, 0);
      elbowPivot.add(trailing);
    }

    return { shoulderPivot, elbowPivot, upperArm, forearm, trailing };
  }

  // Left arm: longer, heavier bundle — overlong enough to dangle well past
  // the knee (asymmetric with the right arm).
  const armL = buildArm({
    side: -1,
    shoulderY: 0.58,
    shoulderX: -0.19,
    upperLen: 0.36,
    foreLen: 0.54,
    shade: false,
    withTrailing: true,
  });

  // Right arm: shorter, thinner bundle, but still overlong past the knee
  // (asymmetric).
  const armR = buildArm({
    side: 1,
    shoulderY: 0.55,
    shoulderX: 0.18,
    upperLen: 0.30,
    foreLen: 0.50,
    shade: true,
    withTrailing: false,
  });

  parts.armL = armL;
  parts.armR = armR;

  // -------------------------------------------------------------------
  // LEGS — loosely wrapped, reaching exactly from the hip (HIP_Y) down to
  // the ground (y=0) so the feet rest on the floor. Shorter in reach than
  // the arms so the overlong arms read clearly as dangling past the knees.
  // Only the left leg gets a frayed hem stub, keeping the silhouette
  // asymmetric.
  // -------------------------------------------------------------------
  const LEG_LEN = HIP_Y; // leg spans the full hip-to-ground distance

  function buildLeg(x, withHem) {
    const hipPivot = new THREE.Group();
    hipPivot.position.set(x, HIP_Y, 0); // world-space hip height (root-relative)
    root.add(hipPivot);

    const leg = hangingBox(0.09, LEG_LEN, 0.10, mat.cloth);
    hipPivot.add(leg);

    let hem = null;
    if (withHem) {
      // Frayed hem / foot stub sitting at the base of the leg wrap.
      hem = box(0.11, 0.06, 0.12, mat.seam);
      hem.position.set(0, -LEG_LEN + 0.03, 0.01);
      hipPivot.add(hem);
    }

    return { hipPivot, leg, hem };
  }

  const legL = buildLeg(-0.09, true);
  const legR = buildLeg(0.09, false);
  parts.legL = legL;
  parts.legR = legR;

  // A single loose thread trailing from the torso's frayed hem, reinforcing
  // the "unravelling cloth" read and the asymmetric silhouette. Parented to
  // torsoWrap so it drapes off the sagging secondary cloth layer.
  const waistThread = hangingBox(0.025, 0.20, 0.025, mat.seam);
  waistThread.position.set(-0.02, -0.16, 0.02);
  torsoWrap.add(waistThread);

  parts.waistThread = waistThread;

  // Store all animated sub-parts for animate() to reach.
  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION
  // Idle: slumped breathing sway (always).
  // Walk: shambling lurch — arms swing wide, legs stride short and heavy,
  //       torso rolls side to side like it's dragging itself forward.
  // -------------------------------------------------------------------
  root.userData.animate = (t, state) => {
    const moving = !!(state && state.moving);
    const hurt = (state && state.hurt) || 0;

    // Idle breathing (always active, subtle).
    const breathe = Math.sin(t * 1.6);
    parts.torsoPivot.scale.set(
      1 + breathe * 0.015,
      1 + breathe * 0.03,
      1 + breathe * 0.015
    );

    if (moving) {
      // --- Shambling lurch ---
      const stride = t * 4.2; // gait speed
      const legSwing = Math.sin(stride) * 0.55;

      legL.hipPivot.rotation.x = legSwing;
      legR.hipPivot.rotation.x = -legSwing;

      // Overlong arms swing wide and slightly out of phase with the legs,
      // as if being dragged by their own weight.
      const armSwing = Math.sin(stride + Math.PI * 0.15) * 0.5;
      armL.shoulderPivot.rotation.x = -armSwing + 0.15;
      armR.shoulderPivot.rotation.x = armSwing * 0.85 + 0.1;

      // Elbows trail behind with a phase lag for loose, floppy cloth motion.
      armL.elbowPivot.rotation.x = Math.sin(stride - 0.9) * 0.4 + 0.25;
      armR.elbowPivot.rotation.x = Math.sin(stride - 0.9 + Math.PI) * 0.4 + 0.25;

      // Body rolls side-to-side and bobs, dragging with each heavy step.
      root.position.y = Math.abs(Math.sin(stride)) * 0.035;
      parts.torsoPivot.rotation.z = Math.sin(stride) * 0.12;
      parts.torsoPivot.rotation.x = 0.22 + Math.cos(stride) * 0.05;

      // Head lolls with the lurch.
      parts.headPivot.rotation.z = Math.sin(stride + 0.6) * 0.15;
    } else {
      // --- Slow idle sway ---
      const sway = t * 0.8;
      parts.torsoPivot.rotation.z = Math.sin(sway) * 0.05;
      parts.torsoPivot.rotation.x = 0.22 + Math.sin(sway * 0.5) * 0.02;
      parts.headPivot.rotation.z = Math.sin(sway * 0.7 + 1.1) * 0.06;

      armL.shoulderPivot.rotation.x = Math.sin(sway * 0.6) * 0.08 + 0.05;
      armR.shoulderPivot.rotation.x = Math.sin(sway * 0.6 + 1.4) * 0.08;
      armL.elbowPivot.rotation.x = Math.sin(sway * 0.6 + 0.5) * 0.1 + 0.2;
      armR.elbowPivot.rotation.x = Math.sin(sway * 0.6 + 1.9) * 0.1 + 0.2;

      legL.hipPivot.rotation.x = 0;
      legR.hipPivot.rotation.x = 0;
      root.position.y = 0;
    }

    // Trailing threads drift independently for a light, unravelling feel.
    parts.waistThread.rotation.x = Math.sin(t * 1.1 + 0.2) * 0.15;
    parts.waistThread.rotation.z = Math.sin(t * 1.7 + 0.4) * 0.08;
    armL.trailing.rotation.x = Math.sin(t * 2.1) * 0.2;

    // Chest Thrum glow gently pulses.
    mat.thrum.emissiveIntensity = 0.7 + Math.sin(t * 2.0) * 0.25;

    // Hurt flinch — a sharp asymmetric jolt that decays into the normal pose.
    if (hurt > 0) {
      parts.torsoPivot.rotation.z += hurt * 0.3 * Math.sin(t * 30);
      parts.headPivot.rotation.x -= hurt * 0.2;
    }
  };

  return root;
}

export const meta = {
  archetype: 'groaner',
  species: 'Understruck',
  dimensionDefault: 'warpwold',
  palette: PALETTE,
  description:
    'A hostile, mournful Warpwold wraith woven from unravelling bandage-cloth. ' +
    'Tall, gaunt, and permanently hunched, the Understruck drags overlong, ' +
    'asymmetric arms that sway past its knees as it shambles. Its featureless, ' +
    'drooping head bears only a stitched vertical seam-mouth and two hollow ' +
    'eyes, while a faint blue Thrum glow pulses at a seam over its chest — ' +
    'the last thread of warmth left in a creature the Loom has begun to forget.',
};
