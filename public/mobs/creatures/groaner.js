import * as THREE from 'three';
import * as rig from '../anim/rig.js';

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

// Palette (canonical Understruck bestiary palette) — desaturated grey-teal
// unravelled cloth, darker frayed seams, pale Thrum glow.
const PALETTE = {
  cloth: 0x8fa39d,      // main sagging bandage/thread cloth
  clothShade: 0x5e6e6a, // darker secondary cloth layer (asymmetry / depth read)
  seam: 0x3c4a47,       // frayed seams / stitched trim / thread wisps
  voidEye: 0x232c2a,    // hollow stitched eye sockets / mouth seam
  thrum: 0xc4d4cf,      // faint pale Thrum glow at the chest seam
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
    // Chest Thrum glow is built from TWO layered materials rather than one
    // hot flat-emissive box: a small, moderately-bright core plus a larger,
    // much dimmer, additively-blended halo behind/around it. Without a
    // post-process bloom pass, a single high-emissiveIntensity box on a
    // pale/near-white color (#C4D4CF) blows out to flat overexposed white
    // under standard PBR lighting. Splitting it into a soft-edged core +
    // translucent halo fakes the gradient/falloff a real bloom would give,
    // so it reads as a faint moody pulse rather than a bright white patch.
    thrumCore: new THREE.MeshStandardMaterial({
      color: PALETTE.thrum,
      roughness: 0.7,
      metalness: 0.0,
      emissive: new THREE.Color(PALETTE.thrum),
      emissiveIntensity: 0.5,
    }),
    thrumHalo: new THREE.MeshStandardMaterial({
      color: PALETTE.thrum,
      roughness: 1.0,
      metalness: 0.0,
      emissive: new THREE.Color(PALETTE.thrum),
      emissiveIntensity: 0.2,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
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

// Defensive numeric coercion — never let a missing/NaN state field poison a
// transform. Mirrors rig.js's internal `num()` for the arithmetic that
// happens directly in this file (rig's own exports already self-guard).
function n(v, fallback = 0) {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : fallback;
}
function clamp01(v) {
  const x = n(v, 0);
  return x < 0 ? 0 : x > 1 ? 1 : x;
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
  torsoPivot.rotation.x = 0.36; // permanent forward hunch (deepened for silhouette read)
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

  // Chest seam — faint blue Thrum glow, recessed into the front of the
  // chest. A larger, dimmer, additively-blended halo sits just behind the
  // small bright core so the glow reads with a soft gradient falloff
  // bleeding into the surrounding cloth, instead of a single hard-edged
  // overexposed patch.
  const chestGlow = box(0.13, 0.28, 0.02, mat.thrumHalo);
  chestGlow.position.set(0.03, 0.32, 0.105);
  torsoPivot.add(chestGlow);

  const chestSeam = box(0.06, 0.17, 0.025, mat.thrumCore);
  chestSeam.position.set(0.03, 0.32, 0.115);
  torsoPivot.add(chestSeam);

  // Small stitched patch on the shoulder yoke — a dark fleck of contrast
  // that reads clearly at thumbnail size and breaks up the pale cloth.
  const shoulderPatch = box(0.05, 0.035, 0.02, mat.voidEye);
  shoulderPatch.position.set(0.10, -0.005, 0.095);
  shoulderYoke.add(shoulderPatch);

  parts.torsoPivot = torsoPivot;
  parts.chestSeam = chestSeam;
  parts.chestGlow = chestGlow;
  parts.shoulderPatch = shoulderPatch;

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
  headPivot.rotation.x = 0.37; // additional forward droop beyond the torso hunch
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
  function buildArm({ shoulderX, shoulderY, upperLen, foreLen, wispLen, wispSide }) {
    const shoulderPivot = new THREE.Group();
    shoulderPivot.position.set(shoulderX, shoulderY, 0.0);
    torsoPivot.add(shoulderPivot);

    // Loose thread bundle draped over the shoulder joint — always the
    // darker clothShade tone (regardless of the per-arm `shade` flag) so
    // the joint itself reads as a visible seam/socket cutting the arm's
    // silhouette away from the lighter torso, instead of blending into it.
    const shoulderWrap = box(0.11, 0.09, 0.14, mat.clothShade);
    shoulderWrap.position.set(0, -0.02, 0.0);
    shoulderPivot.add(shoulderWrap);

    // Upper arm — two stacked, tapering segments. Both segments use
    // darker cloth/seam tones than the torso's main cloth color: the whole
    // arm silhouette then reads as a clearly distinct, separately-shaded
    // limb dangling off the body rather than merging into the torso's
    // silhouette when they overlap in a flat/front-on view. Segments are
    // also a touch thicker than before so the limb stays legible as a
    // discrete shape at a distance instead of thinning into a hairline.
    const upperA = hangingBox(0.088, upperLen * 0.55, 0.088, mat.clothShade);
    shoulderPivot.add(upperA);
    const upperB = hangingBox(0.074, upperLen * 0.45, 0.074, mat.seam);
    upperB.position.set(0, -upperLen * 0.55, 0);
    shoulderPivot.add(upperB);

    // Forearm pivots from the elbow (bottom of the upper arm) for a
    // second joint of independent sway, and is itself two stacked,
    // tapering segments reaching well past the knee.
    const elbowPivot = new THREE.Group();
    elbowPivot.position.set(0, -upperLen, 0);
    shoulderPivot.add(elbowPivot);

    const foreA = hangingBox(0.066, foreLen * 0.5, 0.066, mat.clothShade);
    elbowPivot.add(foreA);
    const foreB = hangingBox(0.053, foreLen * 0.5, 0.053, mat.seam);
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

  // A single thin trailing ankle-thread on the right leg (in place of the
  // left leg's blocky hem) keeps the pair asymmetric while still giving
  // the right leg its own bit of secondary silhouette detail.
  const ankleWispR = hangingBox(0.015, 0.09, 0.015, mat.seam);
  ankleWispR.position.set(0.02, -0.20, 0.02);
  legR.kneePivot.add(ankleWispR);
  legR.ankleWisp = ankleWispR;

  parts.legL = legL;
  parts.legR = legR;

  // Store all animated sub-parts for animate() to reach.
  root.userData.parts = parts;

  // Baked rest rotations (the permanent hunch set at build time above) —
  // animate() re-derives from these every frame rather than accumulating,
  // so state can never drift/compound across frames.
  const REST_TORSO_X = 0.36;
  const REST_TORSO_Z = -0.05;
  const REST_HEAD_X = 0.37;

  // -------------------------------------------------------------------
  // ANIMATION — built on mobs/anim/rig.js's procedural-motion helpers.
  // Idle:      rig.breathe drives the torso's breathing scale, rig.sway
  //            drifts torso/head/arms independently so the figure never
  //            reads as frozen even standing still.
  // Walk:      a slumped two-beat shamble — rig.legSwing drives each leg's
  //            hip/knee a half-cycle apart, contralateral arm sway (each
  //            overlong arm swings opposite its matching leg, elbow
  //            lagging the shoulder), amplitude/cadence scaled by
  //            state.speed01 so it never marches in place at a standstill.
  // Telegraph: rig.windUp pulls the right arm up and back through
  //            state.telegraph — a wound-back claw about to reach out.
  // Attack:    rig.strike whips that same arm forward past rest into an
  //            overlong reaching claw as state.attack fires.
  // Hurt:      a sharp, fast-decaying jolt keyed to state.hurt.
  // Death:     rig.dissolve unravels the whole figure — arms and legs
  //            splay outward, every ragged thread flings loose, the body
  //            sinks and shrinks, and the chest Thrum glow gutters out.
  //            No gore — just threads coming apart.
  // Turn:      torso/head bank into state.turn (signed yaw rate), damped.
  // -------------------------------------------------------------------
  let prevT = null;
  let lean = 0;
  let flinch = 0;

  root.userData.animate = (t, state) => {
    try {
      const s = state || {};
      const time = n(t, 0);
      let dt = 0;
      if (prevT !== null) dt = Math.max(0, Math.min(0.12, time - prevT));
      prevT = time;

      const moving = !!s.moving;
      const grounded = s.grounded !== false; // default true if unspecified
      const hurt = clamp01(s.hurt);
      const dying = clamp01(s.dying);
      const telegraph = clamp01(s.telegraph);
      const attack = clamp01(s.attack);
      const turn = n(s.turn, 0);
      const speed01 = clamp01(s.speed01 != null ? s.speed01 : (moving ? 1 : 0));

      // Idle breathing, always active (subtler while dissolving).
      const breathAmt = rig.breathe(time, 1.1, 0.85) * (1 - dying);
      torsoPivot.scale.set(1 + breathAmt * 0.6, 1 + breathAmt * 1.2, 1 + breathAmt * 0.6);

      // Lean into turns — damped so the bank never snaps.
      const leanTarget = dying > 0 ? 0 : Math.max(-0.3, Math.min(0.3, -turn * 0.16));
      lean = rig.damp(lean, leanTarget, 7, dt);

      if (dying > 0) {
        // --- DEATH: thread-unravel dissolve, no gore ---
        const d = rig.dissolve(dying);
        const sc = Math.max(0.03, d.scale);
        root.scale.set(sc, sc, sc);
        root.position.y = -d.drop * 0.85;

        torsoPivot.rotation.x = REST_TORSO_X + d.spread * 0.25;
        torsoPivot.rotation.z = REST_TORSO_Z + lean;
        headPivot.rotation.x = REST_HEAD_X + d.spread * 0.4;
        headPivot.rotation.z = d.spread * 0.5;

        armL.shoulderPivot.rotation.x = -0.2 - d.spread * 0.7;
        armL.shoulderPivot.rotation.z = -d.spread * 0.9;
        armR.shoulderPivot.rotation.x = -0.2 - d.spread * 0.6;
        armR.shoulderPivot.rotation.z = d.spread * 0.9;
        armL.elbowPivot.rotation.x = d.spread * 0.8;
        armR.elbowPivot.rotation.x = d.spread * 0.8;

        legL.hipPivot.rotation.x = -d.spread * 0.4;
        legL.hipPivot.rotation.z = -d.spread * 0.5;
        legR.hipPivot.rotation.x = -d.spread * 0.35;
        legR.hipPivot.rotation.z = d.spread * 0.5;
        legL.kneePivot.rotation.x = d.spread * 0.5;
        legR.kneePivot.rotation.x = d.spread * 0.5;

        // Every ragged thread flings loose as the last stitches let go.
        chestStrip.rotation.x = 0.05 + d.spread * 0.9;
        chestStrip.rotation.z = -0.06 - d.spread * 0.7;
        backStrip.rotation.x = -0.08 - d.spread * 0.8;
        hipFray.rotation.z = 0.12 + d.spread * 1.1;
        yokeWisp.rotation.z = -0.10 - d.spread * 1.2;
        waistThread.rotation.x = d.spread * 0.6;
        waistThread.rotation.z = d.spread * 0.9;
        hoodFlap.rotation.x = -0.15 - d.spread * 0.7;
        armL.wisp.rotation.x = d.spread * 1.3;
        armR.wisp.rotation.x = -d.spread * 1.3;
        ankleWispR.rotation.x = d.spread * 1.0;

        // The last thread of warmth gutters out.
        mat.thrumCore.emissiveIntensity = Math.max(0, 0.5 * (1 - dying));
        mat.thrumHalo.emissiveIntensity = Math.max(0, 0.2 * (1 - dying));
        mat.thrumHalo.opacity = Math.max(0, 0.4 * (1 - dying));
        return; // death pose overrides everything below
      }

      // Reset root scale in case a previous frame was mid-dissolve and the
      // mob got revived/recycled (defensive; animate() must never assume
      // ordering with the manager's own removal timing).
      if (root.scale.x !== 1) root.scale.set(1, 1, 1);

      // ---- Two-beat shambling walk cycle, scaled by state.speed01 ----
      const strideFreq = 1.05; // slow, dragging shamble cadence
      const cadence = strideFreq * (0.35 + 0.65 * speed01);
      const phase = time * cadence; // cycles elapsed
      const legAmp = 0.46 * speed01;
      const idleAmt = 1 - speed01;

      const hipL = rig.legSwing(phase, legAmp);
      const hipR = rig.legSwing(phase + 0.5, legAmp);
      const kneeL = Math.max(0, rig.legSwing(phase + 0.22, 1)) * 0.55 * speed01;
      const kneeR = Math.max(0, rig.legSwing(phase + 0.72, 1)) * 0.55 * speed01;
      const bob = Math.abs(Math.sin(phase * Math.PI * 2)) * 0.032 * speed01;

      legL.hipPivot.rotation.x = hipL;
      legR.hipPivot.rotation.x = hipR;
      legL.kneePivot.rotation.x = kneeL;
      legR.kneePivot.rotation.x = kneeR;
      root.position.y = grounded ? bob : bob * 0.4;

      // Overlong arms swing opposite the matching leg, as limp dangling
      // weight — a lagged elbow keeps them reading as loose cloth, not
      // rigid pendulums. Idle-blends into a slow independent sway as
      // speed01 falls to 0.
      const idleSwayL = rig.sway(time, 1, 1, 0.4);
      const idleSwayR = rig.sway(time, 1, 1.15, 1.9);
      const armSwingL = -hipR * 0.55 + idleSwayL * idleAmt + 0.05;
      const armSwingR = -hipL * 0.5 + idleSwayR * idleAmt + 0.04;
      const elbowSwingL = Math.max(-0.05, rig.legSwing(phase + 0.28, 1)) * 0.22 * speed01
        + rig.sway(time, 0.6, 1, 1.1) * idleAmt + 0.09;
      const elbowSwingR = Math.max(-0.05, rig.legSwing(phase + 0.78, 1)) * 0.22 * speed01
        + rig.sway(time, 0.6, 1.1, 2.4) * idleAmt + 0.09;

      armL.shoulderPivot.rotation.x = armSwingL;
      armL.shoulderPivot.rotation.z = 0;
      armL.elbowPivot.rotation.x = elbowSwingL;

      // ---- Telegraph / attack overlay on the right (striking) arm ----
      // rig.windUp pulls the arm up+back through the telegraph window;
      // once the strike fires, rig.strike whips it forward past rest into
      // a reaching claw before releasing back to the walk/idle pose.
      const attackActive = telegraph > 0 || attack > 0;
      if (attackActive) {
        const windAmt = rig.windUp(telegraph); // 0 -> ~-1.1 -> -1
        const strikeAmt = rig.strike(attack); // 0 -> 1, fast release
        const driveX = attack > 0 ? -1 + strikeAmt * 1.8 : windAmt;
        const blend = Math.max(telegraph, attack);
        armR.shoulderPivot.rotation.x = armSwingR * (1 - blend) + driveX * 0.85;
        armR.shoulderPivot.rotation.z = attack > 0 ? strikeAmt * 0.3 : -telegraph * 0.22;
        armR.elbowPivot.rotation.x = elbowSwingR * (1 - blend) + Math.max(0, driveX) * 0.55;
      } else {
        armR.shoulderPivot.rotation.x = armSwingR;
        armR.shoulderPivot.rotation.z = 0;
        armR.elbowPivot.rotation.x = elbowSwingR;
      }

      // ---- Torso / head: permanent hunch + lurch roll/pitch + turn lean ----
      const lurchZ = Math.sin(phase * Math.PI * 2) * 0.09 * speed01;
      const lurchX = Math.cos(phase * Math.PI * 2) * 0.045 * speed01;
      const idleSwayTorso = rig.sway(time, 1, 1, 0) * idleAmt;
      torsoPivot.rotation.z = REST_TORSO_Z + lurchZ + idleSwayTorso * 0.7 + lean;
      torsoPivot.rotation.x = REST_TORSO_X + lurchX + breathAmt * 0.3;
      torsoPivot.rotation.y = lean * 0.5;

      headPivot.rotation.z = Math.sin(phase * Math.PI * 2 + 0.6) * 0.13 * speed01
        + rig.sway(time, 1, 0.8, 1.1) * idleAmt;
      headPivot.rotation.x = REST_HEAD_X - lean * 0.3 - attack * 0.05;
      headPivot.rotation.y = lean * 0.6 + attack * 0.1;

      // ---- Ragged strips: independent slow drift, always alive ----
      chestStrip.rotation.x = 0.05 + Math.sin(time * 1.3 + 0.2) * 0.12;
      chestStrip.rotation.z = -0.06 + Math.sin(time * 1.9 + 0.9) * 0.08;
      backStrip.rotation.x = -0.08 + Math.sin(time * 1.1 + 1.6) * 0.10;
      hipFray.rotation.z = 0.12 + Math.sin(time * 1.5 + 0.4) * 0.10 + hipL * 0.15;
      yokeWisp.rotation.z = -0.10 + Math.sin(time * 2.2 + 1.0) * 0.14;
      waistThread.rotation.x = Math.sin(time * 1.1 + 0.2) * 0.15;
      waistThread.rotation.z = Math.sin(time * 1.7 + 0.4) * 0.08;
      hoodFlap.rotation.x = -0.15 + Math.sin(time * 1.4 + 0.7) * 0.08 + lurchX * 0.5;
      armL.wisp.rotation.x = Math.sin(time * 2.1) * 0.22 + armSwingL * 0.3;
      armR.wisp.rotation.x = Math.sin(time * 2.4 + 0.8) * 0.22 + armSwingR * 0.3;
      ankleWispR.rotation.x = Math.sin(time * 1.8 + 0.3) * 0.16 + hipR * 0.35;

      // ---- Chest Thrum glow — pulses, dims on hurt, quickens on attack ----
      // Core and halo pulse together (halo trailing slightly dimmer) so the
      // glow keeps its soft gradient falloff at every phase of the pulse
      // rather than flashing to a single flat brightness.
      const pulseFreq = 2.0 + attack * 4 + telegraph * 2;
      const pulse = (0.6 + Math.sin(time * pulseFreq) * 0.2) * (1 - hurt * 0.4);
      mat.thrumCore.emissiveIntensity = pulse * 0.85;
      mat.thrumHalo.emissiveIntensity = pulse * 0.35;
      mat.thrumHalo.opacity = 0.3 + pulse * 0.15;

      // ---- Hurt flinch: sharp asymmetric jolt that snaps back ----
      flinch = rig.damp(flinch, hurt, 16, dt);
      if (flinch > 0.001) {
        torsoPivot.rotation.z += flinch * 0.3 * Math.sin(time * 30);
        torsoPivot.rotation.x -= flinch * 0.10;
        headPivot.rotation.x -= flinch * 0.2;
        headPivot.rotation.z += flinch * 0.18 * Math.sin(time * 26 + 1);
      }
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
    }
  };

  return root;
}

export const meta = {
  archetype: 'groaner',
  species: 'Understruck',
  canonicalId: 'understruck',
  dimensionDefault: 'warpwold',
  palette: {
    cloth: '#8FA39D',
    clothShade: '#5E6E6A',
    seam: '#3C4A47',
    voidEye: '#232C2A',
    thrum: '#C4D4CF',
  },
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
