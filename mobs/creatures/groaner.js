import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Understruck — a hostile, mournful Warpwold wraith of unravelling cloth.
// Archetype: groaner
//
// Silhouette goals (per design brief): TALL (~1.3u), GAUNT, permanently
// HUNCHED — never an upright rectangular box-man. The torso leans forward
// and tapers, the shoulder line is asymmetric, and the head hangs low and
// forward on a drooped neck. Two OVERLONG arms — each built from a stack of
// several thin boxes so they read as limp hanging cloth-wrapped limbs —
// dangle straight down well past the knees and sway independently. Ragged,
// asymmetric bandage/thread strips of varying length trail off the
// shoulders, chest, waist and hip. A faint blue Thrum glow pulses at a
// chest seam — the last thread of warmth the Loom has begun to forget.
// ---------------------------------------------------------------------------

// Palette — dust-grey unravelled cloth, darker frayed seams, faint Thrum glow.
const PALETTE = {
  cloth: 0x8a8577,      // main sagging bandage/thread cloth
  clothShade: 0x716c60, // darker secondary cloth layer (asymmetry / depth read)
  seam: 0x4e4a42,       // frayed seams / stitched trim / thread wisps
  voidEye: 0x201e19,    // hollow stitched eye sockets / mouth seam
  thrum: 0x5fa8b0,      // faint blue Thrum glow at the chest seam
};

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

// Box mesh whose origin sits at its TOP center, so it can be parented to a
// joint pivot and "hang" downward naturally — used for every limp cloth
// strip and limb segment so the whole figure reads as sagging, not rigid.
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
  root.name = 'Understruck';

  const mat = makeMaterials();
  const parts = {};

  // Hip height above the ground (y=0); legs are built to exactly this
  // length so the feet rest on the ground plane.
  const HIP_Y = 0.48;

  // -------------------------------------------------------------------
  // TORSO — a tapered, forward-hunched cloth column (NOT one rigid box).
  // A permanent forward pitch (rotation.x) plus a small permanent side
  // roll (rotation.z) breaks the upright-rectangle read immediately.
  // -------------------------------------------------------------------
  const torsoPivot = new THREE.Group();
  torsoPivot.position.set(0, HIP_Y, 0.01);
  torsoPivot.rotation.x = 0.32; // permanent forward hunch
  torsoPivot.rotation.z = -0.05; // permanent asymmetric side lean
  root.add(torsoPivot);

  // Waist — narrow.
  const waist = box(0.19, 0.20, 0.14, mat.cloth);
  waist.position.set(0, 0.10, 0);
  torsoPivot.add(waist);

  // Chest — wider, gaunt taper up from the waist.
  const chest = box(0.28, 0.26, 0.18, mat.cloth);
  chest.position.set(0.005, 0.33, -0.005);
  torsoPivot.add(chest);

  // Shoulder yoke — thin, wide, offset asymmetrically to one side so the
  // shoulder line itself reads crooked rather than square.
  const shoulderYoke = box(0.34, 0.08, 0.19, mat.clothShade);
  shoulderYoke.position.set(-0.02, 0.50, 0.0);
  shoulderYoke.rotation.z = 0.05;
  torsoPivot.add(shoulderYoke);

  // Secondary sagging wrap slumped off one side of the chest — breaks the
  // silhouette further and gives somewhere for the waist thread to drape.
  const torsoWrap = box(0.14, 0.30, 0.20, mat.clothShade);
  torsoWrap.position.set(-0.15, 0.24, 0.02);
  torsoWrap.rotation.z = 0.16;
  torsoPivot.add(torsoWrap);

  // Chest seam — faint blue Thrum glow, recessed into the front of the chest.
  const chestSeam = box(0.07, 0.20, 0.03, mat.thrum);
  chestSeam.position.set(0.03, 0.32, 0.11);
  torsoPivot.add(chestSeam);

  parts.torsoPivot = torsoPivot;
  parts.chestSeam = chestSeam;

  // -------------------------------------------------------------------
  // RAGGED CLOTH STRIPS — several thin boxes of varying length/offset
  // hanging off the shoulders, chest, waist and hip, all with slightly
  // different rotations so nothing reads as a clean rigid edge.
  // -------------------------------------------------------------------
  const strips = [];
  function addStrip(parent, w, h, d, material, x, y, z, rx, rz) {
    const s = hangingBox(w, h, d, material);
    s.position.set(x, y, z);
    s.rotation.x = rx || 0;
    s.rotation.z = rz || 0;
    parent.add(s);
    strips.push(s);
    return s;
  }

  const chestStrip = addStrip(chest, 0.035, 0.30, 0.03, mat.cloth, 0.06, -0.13, 0.10, 0.05, -0.06);
  const backStrip = addStrip(chest, 0.05, 0.22, 0.03, mat.clothShade, -0.02, -0.13, -0.10, -0.08, 0.10);
  const hipFray = addStrip(torsoPivot, 0.03, 0.34, 0.025, mat.seam, 0.14, 0.14, 0.02, 0.10, 0.12);
  const yokeWisp = addStrip(shoulderYoke, 0.02, 0.14, 0.02, mat.seam, 0.15, -0.04, 0.03, -0.05, -0.10);
  const waistThread = addStrip(torsoWrap, 0.025, 0.20, 0.025, mat.seam, -0.02, -0.14, 0.02, 0.0, 0.0);

  parts.chestStrip = chestStrip;
  parts.backStrip = backStrip;
  parts.hipFray = hipFray;
  parts.yokeWisp = yokeWisp;
  parts.waistThread = waistThread;

  // -------------------------------------------------------------------
  // HEAD — hangs low and forward off the drooped neckline, off-center,
  // featureless but for a vertical seam-mouth and two hollow stitched
  // eyes. A ragged hood-flap of cloth drapes off the back of it.
  // -------------------------------------------------------------------
  const headPivot = new THREE.Group();
  headPivot.position.set(-0.03, 0.50, 0.06);
  headPivot.rotation.x = 0.34; // additional forward droop beyond the torso hunch
  torsoPivot.add(headPivot);

  const head = box(0.19, 0.20, 0.17, mat.cloth);
  head.position.set(0, 0.10, 0);
  headPivot.add(head);

  // Gaunt jaw taper beneath the head.
  const jaw = box(0.13, 0.06, 0.14, mat.clothShade);
  jaw.position.set(0, -0.02, 0.0);
  headPivot.add(jaw);

  // Ragged hood-flap draping off the back of the head.
  const hoodFlap = hangingBox(0.20, 0.16, 0.03, mat.clothShade);
  hoodFlap.position.set(0, 0.20, -0.08);
  hoodFlap.rotation.x = -0.15;
  headPivot.add(hoodFlap);

  // Vertical seam-mouth.
  const mouth = box(0.025, 0.11, 0.02, mat.voidEye);
  mouth.position.set(0, 0.06, 0.09);
  headPivot.add(mouth);

  // Two hollow stitched eyes (small, sunken, asymmetric spacing/size).
  const eyeL = box(0.032, 0.032, 0.02, mat.voidEye);
  eyeL.position.set(-0.055, 0.135, 0.09);
  headPivot.add(eyeL);

  const eyeR = box(0.028, 0.028, 0.02, mat.voidEye);
  eyeR.position.set(0.05, 0.13, 0.09);
  headPivot.add(eyeR);

  parts.headPivot = headPivot;
  parts.hoodFlap = hoodFlap;

  // Head anchor for name tags — above the drooped head.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 1.30, 0.05);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // SHOULDERS + OVERLONG ARMS — each arm is a vertical stack of several
  // thin, slightly tapering boxes (not one stiff prism) so it reads as a
  // limp hanging bandage-wrapped limb. Both arms dangle straight down
  // well past the knees, with asymmetric lengths and a frayed thread
  // wisp trailing off each end.
  // -------------------------------------------------------------------
  function buildArm({ shoulderX, shoulderY, upperLen, foreLen, wispLen, shade, wispSide }) {
    const shoulderPivot = new THREE.Group();
    shoulderPivot.position.set(shoulderX, shoulderY, 0.0);
    torsoPivot.add(shoulderPivot);

    // Loose thread bundle draped over the shoulder joint.
    const shoulderWrap = box(0.11, 0.09, 0.14, shade ? mat.clothShade : mat.cloth);
    shoulderWrap.position.set(0, -0.02, 0.0);
    shoulderPivot.add(shoulderWrap);

    // Upper arm — two stacked, slightly tapering segments.
    const upperA = hangingBox(0.075, upperLen * 0.55, 0.075, mat.cloth);
    shoulderPivot.add(upperA);
    const upperB = hangingBox(0.062, upperLen * 0.45, 0.062, mat.clothShade);
    upperB.position.set(0, -upperLen * 0.55, 0);
    shoulderPivot.add(upperB);

    // Forearm pivots from the elbow (bottom of the upper arm) for a
    // second joint of independent sway, and is itself two stacked,
    // tapering segments reaching well past the knee.
    const elbowPivot = new THREE.Group();
    elbowPivot.position.set(0, -upperLen, 0);
    shoulderPivot.add(elbowPivot);

    const foreA = hangingBox(0.055, foreLen * 0.5, 0.055, mat.cloth);
    elbowPivot.add(foreA);
    const foreB = hangingBox(0.044, foreLen * 0.5, 0.044, mat.clothShade);
    foreB.position.set(0, -foreLen * 0.5, 0);
    elbowPivot.add(foreB);

    // Frayed thread wisp trailing off the arm's end — present on both
    // arms but with different lengths, keeping the silhouette asymmetric.
    const wisp = hangingBox(0.018, wispLen, 0.018, mat.seam);
    wisp.position.set(wispSide * 0.01, -foreLen, 0);
    elbowPivot.add(wisp);

    return { shoulderPivot, elbowPivot, upperA, upperB, foreA, foreB, wisp };
  }

  // Left arm: longer, heavier — dangles nearly to the ankle.
  const armL = buildArm({
    shoulderX: -0.20,
    shoulderY: 0.49,
    upperLen: 0.30,
    foreLen: 0.40,
    wispLen: 0.14,
    shade: false,
    wispSide: -1,
  });

  // Right arm: shorter, thinner, but still overlong past the knee —
  // keeps the pair asymmetric.
  const armR = buildArm({
    shoulderX: 0.18,
    shoulderY: 0.47,
    upperLen: 0.26,
    foreLen: 0.34,
    wispLen: 0.08,
    shade: true,
    wispSide: 1,
  });

  parts.armL = armL;
  parts.armR = armR;

  // -------------------------------------------------------------------
  // LEGS — hip-to-knee and knee-to-ankle segments (loosely wrapped, not
  // solid pillars) reaching exactly from the hip (HIP_Y) to the ground.
  // Shorter reach than the arms so the overlong arms clearly read as
  // dangling past the knees. Only the left leg carries a frayed hem
  // stub, keeping the silhouette asymmetric.
  // -------------------------------------------------------------------
  function buildLeg(x, upperLen, lowerLen, withHem) {
    const hipPivot = new THREE.Group();
    hipPivot.position.set(x, HIP_Y, 0);
    root.add(hipPivot);

    const upperLeg = hangingBox(0.10, upperLen, 0.11, mat.cloth);
    hipPivot.add(upperLeg);

    const kneePivot = new THREE.Group();
    kneePivot.position.set(0, -upperLen, 0);
    hipPivot.add(kneePivot);

    const lowerLeg = hangingBox(0.085, lowerLen, 0.095, mat.clothShade);
    kneePivot.add(lowerLeg);

    let hem = null;
    if (withHem) {
      hem = box(0.10, 0.05, 0.11, mat.seam);
      hem.position.set(0, -lowerLen + 0.025, 0.01);
      kneePivot.add(hem);
    }

    return { hipPivot, kneePivot, upperLeg, lowerLeg, hem };
  }

  const legL = buildLeg(-0.09, 0.26, 0.22, true);
  const legR = buildLeg(0.09, 0.26, 0.22, false);
  parts.legL = legL;
  parts.legR = legR;

  // Store all animated sub-parts for animate() to reach.
  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION
  // Idle: slumped breathing + slow independent drift of every ragged
  //       strip, so the figure never looks frozen/rigid.
  // Walk: shambling lurch — legs step short and heavy from hip+knee,
  //       arms swing as limp dangling weight (shoulder + lagged elbow),
  //       torso rocks and bobs like it is dragging itself forward.
  // -------------------------------------------------------------------
  root.userData.animate = (t, state) => {
    const moving = !!(state && state.moving);
    const hurt = (state && state.hurt) || 0;

    // Idle breathing (always active, subtle).
    const breathe = Math.sin(t * 1.6);
    torsoPivot.scale.set(
      1 + breathe * 0.015,
      1 + breathe * 0.03,
      1 + breathe * 0.015
    );

    if (moving) {
      // --- Shambling lurch ---
      const stride = t * 4.0; // gait speed
      const legSwing = Math.sin(stride) * 0.42;

      legL.hipPivot.rotation.x = legSwing;
      legR.hipPivot.rotation.x = -legSwing;
      legL.kneePivot.rotation.x = Math.max(0, Math.sin(stride + 0.5)) * 0.5;
      legR.kneePivot.rotation.x = Math.max(0, Math.sin(stride + 0.5 + Math.PI)) * 0.5;

      // Overlong arms swing as limp dangling weight — modest shoulder
      // arcs with a phase-lagged elbow so they read as swaying cloth,
      // not windmilling.
      const armSwing = Math.sin(stride + Math.PI * 0.15) * 0.22;
      armL.shoulderPivot.rotation.x = -armSwing + 0.06;
      armR.shoulderPivot.rotation.x = armSwing * 0.8 + 0.05;
      armL.elbowPivot.rotation.x = Math.sin(stride - 1.1) * 0.16 + 0.10;
      armR.elbowPivot.rotation.x = Math.sin(stride - 1.1 + Math.PI) * 0.16 + 0.10;

      // Body rolls side-to-side and bobs, dragging with each heavy step.
      root.position.y = Math.abs(Math.sin(stride)) * 0.03;
      torsoPivot.rotation.z = -0.05 + Math.sin(stride) * 0.09;
      torsoPivot.rotation.x = 0.32 + Math.cos(stride) * 0.04;

      // Head lolls with the lurch.
      headPivot.rotation.z = Math.sin(stride + 0.6) * 0.13;
    } else {
      // --- Slow idle sway ---
      const sway = t * 0.8;
      torsoPivot.rotation.z = -0.05 + Math.sin(sway) * 0.045;
      torsoPivot.rotation.x = 0.32 + Math.sin(sway * 0.5) * 0.02;
      headPivot.rotation.z = Math.sin(sway * 0.7 + 1.1) * 0.05;

      armL.shoulderPivot.rotation.x = Math.sin(sway * 0.6) * 0.06 + 0.03;
      armR.shoulderPivot.rotation.x = Math.sin(sway * 0.6 + 1.4) * 0.06;
      armL.elbowPivot.rotation.x = Math.sin(sway * 0.6 + 0.5) * 0.07 + 0.08;
      armR.elbowPivot.rotation.x = Math.sin(sway * 0.6 + 1.9) * 0.07 + 0.08;

      legL.hipPivot.rotation.x = 0;
      legR.hipPivot.rotation.x = 0;
      legL.kneePivot.rotation.x = 0;
      legR.kneePivot.rotation.x = 0;
      root.position.y = 0;
    }

    // Every ragged strip drifts on its own slow, independent phase, so
    // the figure reads as loose unravelling cloth even standing still.
    chestStrip.rotation.x = 0.05 + Math.sin(t * 1.3 + 0.2) * 0.12;
    chestStrip.rotation.z = -0.06 + Math.sin(t * 1.9 + 0.9) * 0.08;
    backStrip.rotation.x = -0.08 + Math.sin(t * 1.1 + 1.6) * 0.10;
    hipFray.rotation.z = 0.12 + Math.sin(t * 1.5 + 0.4) * 0.10;
    yokeWisp.rotation.z = -0.10 + Math.sin(t * 2.2 + 1.0) * 0.14;
    waistThread.rotation.x = Math.sin(t * 1.1 + 0.2) * 0.15;
    waistThread.rotation.z = Math.sin(t * 1.7 + 0.4) * 0.08;
    hoodFlap.rotation.x = -0.15 + Math.sin(t * 1.4 + 0.7) * 0.08;
    armL.wisp.rotation.x = Math.sin(t * 2.1) * 0.22;
    armR.wisp.rotation.x = Math.sin(t * 2.4 + 0.8) * 0.22;

    // Chest Thrum glow gently pulses.
    mat.thrum.emissiveIntensity = 0.7 + Math.sin(t * 2.0) * 0.25;

    // Hurt flinch — a sharp asymmetric jolt that decays into the normal pose.
    if (hurt > 0) {
      torsoPivot.rotation.z += hurt * 0.3 * Math.sin(t * 30);
      headPivot.rotation.x -= hurt * 0.2;
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
    'Tall, gaunt, and permanently hunched forward, the Understruck drags ' +
    'overlong, asymmetric arms — each a limp stack of loosely wrapped cloth ' +
    'segments — that sway well past its knees as it shambles. Ragged thread ' +
    'and hood-flap strips trail from its shoulders, chest, and hip. Its ' +
    'featureless, drooping head bears only a stitched vertical seam-mouth and ' +
    'two hollow eyes, while a faint blue Thrum glow pulses at a seam over its ' +
    'chest — the last thread of warmth left in a creature the Loom has begun ' +
    'to forget.',
};
