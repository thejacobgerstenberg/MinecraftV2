import * as THREE from 'three';
import * as rig from '../anim/rig.js';

// ---------------------------------------------------------------------------
// NEEDLEJACK — a hostile, nocturnal Warpwold prowler.
// Archetype: groaner base. Loomfall lore: a wrong-woven shape the Loom never
// meant to finish — its forearms taper into long needle-blade points, and
// every kill it lands is stitched into its body as another mismatched patch
// of cloth. It is not cruel. It is only wrong-woven. It stands folded and
// statue-still by day, then unbends at nightfall to stalk in a jerky,
// stop-start gait, needle-arms drawn back and ready to snap into a stab.
//
// Silhouette goals: spindly, hunched upright humanoid, ~1.2u tall, tapered
// waist-to-chest torso wrapped in thread-bands, an asymmetric shoulder yoke,
// and a scatter of mismatched stitched-on cloth patches (each kill sewn in).
// A narrow featureless head with a blunt vertical needle-eye slot and a
// bristle of broken needle-pins at the nape. Forearms taper through a
// shoulder+elbow+wrist chain into long, thin, angular needle-blade points,
// bent at wrong angles like a folding ruler. Thin legs terminate in
// needle-tip feet rather than blocky boots. Loose thread wisps trail off the
// shoulders and waist. NOT a Minecraft mob — no rounded proportions, no
// blocky arms/legs like a villager or zombie; everything reads thin, sharp,
// and off-kilter.
// ---------------------------------------------------------------------------

// Canonical Needlejack bestiary palette — all five hexes used as materials.
const PALETTE = {
  main: 0x4a4e57,       // slate steel — torso, head, legs, upper arms
  recess: 0x2b2e35,     // dark recesses — joints, bands, waist, lower legs
  needle: 0x8a8f9c,     // cold grey — needle-limb bases, wisps, patches
  needlePale: 0xc0c6d4, // pale — needle-blade tips, nape pins, feet
  patch: 0x5e1f1f,      // dull blood-red — stitched patches / eye glow
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
// pivot naturally — used for limb segments, wisps and nape pins.
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

// Defensive numeric coercion — animate() must never throw or propagate NaN,
// even if the caller hands it a missing/undefined/NaN state field.
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
  root.name = 'Needlejack';

  const mat = makeMaterials();
  const parts = {};

  // Leg reach determines hip height so feet land exactly at y=0.
  const UPPER_LEG = 0.30;
  const LOWER_LEG = 0.26;
  const FOOT_DROP = 0.06; // footBase + footPoint
  const HIP_Y = UPPER_LEG + LOWER_LEG + FOOT_DROP; // 0.62

  // -------------------------------------------------------------------
  // TORSO — a narrow, permanently hunched, tapered body (waist ->
  // tapered chest) wrapped in thread-bands, topped with an asymmetric
  // shoulder yoke, and studded with mismatched stitched patches. Loose
  // thread wisps trail off the yoke and waist for secondary motion.
  // -------------------------------------------------------------------
  const torsoPivot = new THREE.Group();
  torsoPivot.position.set(0, HIP_Y, 0);
  torsoPivot.rotation.x = 0.16; // permanent hunch
  root.add(torsoPivot);

  const waist = box(0.15, 0.10, 0.115, mat.recess);
  waist.position.set(0, 0.05, 0.0);
  torsoPivot.add(waist);

  const bandLower = box(0.205, 0.022, 0.145, mat.recess);
  bandLower.position.set(0, 0.105, 0.0);
  torsoPivot.add(bandLower);

  const torsoLower = box(0.195, 0.15, 0.14, mat.main);
  torsoLower.position.set(0, 0.185, 0.0);
  torsoPivot.add(torsoLower);

  const bandUpper = box(0.185, 0.022, 0.135, mat.recess);
  bandUpper.position.set(0, 0.265, 0.0);
  torsoPivot.add(bandUpper);

  const torsoUpper = box(0.165, 0.185, 0.125, mat.main);
  torsoUpper.position.set(0, 0.3625, -0.005);
  torsoPivot.add(torsoUpper);

  // Shoulder yoke — thin, wide, offset asymmetrically so the shoulder
  // line itself reads crooked rather than a clean square silhouette.
  const shoulderYoke = box(0.235, 0.04, 0.14, mat.recess);
  shoulderYoke.position.set(-0.008, 0.45, 0.0);
  shoulderYoke.rotation.z = 0.045;
  torsoPivot.add(shoulderYoke);

  // Mismatched stitched-on cloth patches — small offset boxes of
  // varying tone/size, "kills stitched in", scattered off-center.
  const patchDefs = [
    { x: 0.085, y: 0.20, z: 0.075, w: 0.05, h: 0.06, mat: mat.patch },
    { x: -0.09, y: 0.30, z: 0.07, w: 0.045, h: 0.05, mat: mat.needle },
    { x: 0.07, y: 0.40, z: 0.07, w: 0.04, h: 0.045, mat: mat.recess },
    { x: -0.07, y: 0.14, z: 0.065, w: 0.035, h: 0.04, mat: mat.patch },
    { x: 0.10, y: 0.27, z: 0.02, w: 0.02, h: 0.05, mat: mat.needlePale },
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

  // Loose thread wisps trailing off the shoulder yoke and waist — small
  // secondary shapes that read as fraying cloth even at thumbnail size,
  // and give the death-dissolve something to visibly fling loose.
  const wispShoulderL = hangingBox(0.018, 0.13, 0.018, mat.needle);
  wispShoulderL.position.set(-0.11, -0.02, 0.02);
  wispShoulderL.rotation.z = -0.18;
  shoulderYoke.add(wispShoulderL);

  const wispShoulderR = hangingBox(0.016, 0.10, 0.016, mat.recess);
  wispShoulderR.position.set(0.11, -0.02, -0.01);
  wispShoulderR.rotation.z = 0.16;
  shoulderYoke.add(wispShoulderR);

  const wispWaist = hangingBox(0.02, 0.11, 0.02, mat.needle);
  wispWaist.position.set(0.02, 0.10, -0.075);
  wispWaist.rotation.x = 0.35;
  torsoPivot.add(wispWaist);

  parts.wisps = [wispShoulderL, wispShoulderR, wispWaist];
  parts.torsoPivot = torsoPivot;

  // -------------------------------------------------------------------
  // HEAD — narrow, featureless, a blunt vertical needle-eye slot, with a
  // bristle of broken needle-pins at the nape for a readable, sharp
  // head silhouette.
  // -------------------------------------------------------------------
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.46, 0.0);
  torsoPivot.add(headPivot);

  const skull = box(0.105, 0.15, 0.10, mat.main);
  skull.position.set(0, 0.075, 0.0);
  headPivot.add(skull);

  // Blunt needle-eye — a vertical slot of dull-red glow.
  const eyeSlot = box(0.015, 0.085, 0.015, mat.patch);
  eyeSlot.position.set(0, 0.085, 0.053);
  headPivot.add(eyeSlot);
  parts.eyeSlot = eyeSlot;

  // Nape pins — a small bristle of broken needle stubs at the back of
  // the skull, tilted back like a wrong-woven crown. Each is its own
  // pivot so they can waver independently and fling loose in death.
  const napePins = [];
  const napeDefs = [
    { x: -0.028, z: -0.045, h: 0.05 },
    { x: 0.0, z: -0.053, h: 0.062 },
    { x: 0.028, z: -0.045, h: 0.05 },
  ];
  napeDefs.forEach(({ x, z, h }) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.135, z);
    pivot.rotation.x = -0.3; // tilt back
    headPivot.add(pivot);
    const pin = hangingBox(0.012, h, 0.012, mat.needlePale);
    pin.rotation.x = Math.PI; // flip so it points UP off the top pivot
    pivot.add(pin);
    napePins.push(pivot);
  });
  parts.napePins = napePins;

  parts.headPivot = headPivot;

  // Head anchor for name tags, above the head.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 0.30, 0.02);
  headPivot.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // ARMS — thin arms whose forearms taper into long needle-blade
  // points. Bent at wrong angles like a folding ruler, built as a
  // shoulder + elbow + wrist chain so idle flex, the windUp pull-back
  // and the strike thrust all read believably.
  // -------------------------------------------------------------------
  function buildArm(x, mirror) {
    const shoulderPivot = new THREE.Group();
    shoulderPivot.position.set(x, 0.42, 0.0);
    shoulderPivot.rotation.z = mirror * 0.12;
    torsoPivot.add(shoulderPivot);

    // Small pauldron patch of stitched cloth capping the shoulder joint.
    const shoulderPatch = box(0.058, 0.04, 0.05, mat.patch);
    shoulderPatch.position.set(0, -0.01, 0.02);
    shoulderPatch.rotation.z = mirror * 0.1;
    shoulderPivot.add(shoulderPatch);

    const upperArm = hangingBox(0.045, 0.19, 0.045, mat.main);
    shoulderPivot.add(upperArm);

    const elbowPivot = new THREE.Group();
    elbowPivot.position.set(0, -0.19, 0.0);
    elbowPivot.rotation.x = 0.35; // wrong-angle bend, folding-ruler read
    shoulderPivot.add(elbowPivot);

    // Forearm base — cold grey needle-limb.
    const forearmBase = hangingBox(0.035, 0.12, 0.035, mat.needle);
    elbowPivot.add(forearmBase);

    const wristPivot = new THREE.Group();
    wristPivot.position.set(0, -0.12, 0.0);
    wristPivot.rotation.x = -0.12; // counter-bend, whip shape at rest
    elbowPivot.add(wristPivot);

    // Needle-blade tip — thin angular pale box tapering to a point,
    // built as a mid segment plus a narrower tip segment.
    const bladeGroup = new THREE.Group();
    wristPivot.add(bladeGroup);

    const bladeMid = hangingBox(0.026, 0.13, 0.02, mat.needlePale);
    bladeGroup.add(bladeMid);

    const bladeTip = new THREE.Group();
    bladeTip.position.set(0, -0.13, 0.0);
    bladeGroup.add(bladeTip);
    const bladeTipMesh = hangingBox(0.011, 0.09, 0.009, mat.needlePale);
    bladeTip.add(bladeTipMesh);

    return { shoulderPivot, elbowPivot, wristPivot, bladeGroup, bladeTip };
  }

  const armL = buildArm(-0.135, -1);
  const armR = buildArm(0.135, 1);
  parts.armL = armL;
  parts.armR = armR;

  // -------------------------------------------------------------------
  // LEGS — thin legs, hip+knee+ankle pivots for a jerky stalking gait,
  // terminating in small angular needle-tip feet instead of blocky
  // boots. A thin recess knee-trim band breaks up each upper/lower leg
  // seam.
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

    const kneeTrim = box(0.056, 0.02, 0.056, mat.recess);
    kneeTrim.position.set(0, 0, 0);
    kneePivot.add(kneeTrim);

    const lowerLeg = hangingBox(0.038, LOWER_LEG, 0.038, mat.recess);
    kneePivot.add(lowerLeg);

    const anklePivot = new THREE.Group();
    anklePivot.position.set(0, -LOWER_LEG, 0);
    kneePivot.add(anklePivot);

    // Needle-tip foot — two flush-stacked boxes tapering toward a point
    // instead of a flat blocky boot, so even the feet read "sharp".
    const footBase = hangingBox(0.045, 0.03, 0.09, mat.needle);
    footBase.position.set(0, 0, 0.015);
    anklePivot.add(footBase);

    const footPoint = hangingBox(0.02, 0.03, 0.05, mat.needlePale);
    footPoint.position.set(0, -0.03, 0.03);
    anklePivot.add(footPoint);

    // Short trailing ankle thread wisp — decorative, stays clear of the
    // ground plane.
    const ankleWisp = hangingBox(0.014, 0.045, 0.014, mat.needle);
    ankleWisp.position.set(0, -0.005, -0.02);
    anklePivot.add(ankleWisp);

    return { hipPivot, kneePivot, anklePivot, ankleWisp };
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

  // Feet-at-y0 sanity: legsGroup at y=HIP_Y (0.62); upper 0.30 + lower
  // 0.26 + foot (0.03 + 0.03) = 0.62 reach -> foot bottom at y=0.0.

  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION — a real procedural rig built on mobs/anim/rig.js.
  //
  // Idle:      rig.breathe drives a faint torso breathing scale, rig.sway
  //            drives a slow independent drift of thread wisps and nape
  //            pins so the shape never reads as fully frozen; the eye
  //            slot pulses faintly. Legs/arms damp back to a loose rest
  //            pose (statue-still by day, idle menace by night).
  // Walk:      a jerky, stepped/quantized stalking stride — legs and
  //            torso hold discrete poses and snap between them rather
  //            than smoothly interpolating, driven by rig.legSwing on a
  //            quantized phase and scaled by state.speed01/turn.
  // Telegraph/
  // Attack:    rig.windUp draws one needle-arm back through a straight,
  //            coiled pull-back as state.telegraph rises, torso hunches
  //            lower and the eye flares; rig.strike then snaps that same
  //            arm out fast through shoulder+elbow+wrist into a full
  //            stab as state.attack fires, with the torso lunging behind
  //            it. Which arm leads alternates each new wind-up.
  // Hurt:      a sharp jolt/flinch — torso twist, head snap, patches and
  //            nape pins jitter, eye flares brighter.
  // Death:     rig.dissolve(state.dying) unravels the whole figure —
  //            limbs and needle-blades splay outward, patches and thread
  //            wisps fling loose, nape pins scatter, the body sinks and
  //            shrinks away. No gore — just threads coming undone.
  // Turn:      torso banks into state.turn (signed yaw rate), damped.
  // -------------------------------------------------------------------
  const REST_TORSO_X = 0.16;
  const REST_ELBOW_X = 0.35;
  const REST_WRIST_X = -0.12;

  let prevT = null;
  let lean = 0;
  let leadSign = 1;
  let prevTelegraphActive = false;
  let headBackZ = 0;

  root.userData.animate = (t, state) => {
    try {
      const s = state || {};
      const time = n(t, 0);
      let dt = 0;
      if (prevT !== null) dt = Math.max(0, Math.min(0.12, time - prevT));
      prevT = time;

      const moving = !!s.moving;
      const grounded = s.grounded !== false; // default true if unspecified
      const speed01 = clamp01(s.speed01 != null ? s.speed01 : (moving ? 1 : 0));
      const hurt = clamp01(s.hurt);
      const attack = clamp01(s.attack);
      const telegraph = clamp01(s.telegraph);
      const dying = clamp01(s.dying);
      const turn = n(s.turn, 0);

      // Lean into turns, damped so it never snaps.
      const leanTarget = dying > 0 ? 0 : Math.max(-0.35, Math.min(0.35, -turn * 0.8));
      lean = rig.damp(lean, leanTarget, 9, dt || 0.016);

      // ---- DEATH: thread-unravel dissolve, overrides everything else ----
      if (dying > 0) {
        const d = rig.dissolve(dying);
        const sc = Math.max(0.05, d.scale);
        root.scale.set(sc, sc, sc);
        root.position.y = -d.drop * 0.35;
        root.rotation.z = lean * 0.15;

        torsoPivot.rotation.x = REST_TORSO_X + d.spread * 0.3;
        torsoPivot.rotation.z = d.spread * 0.25;
        headPivot.rotation.x = -d.spread * 0.5; // head lolls back
        headPivot.rotation.z = d.spread * 0.4;

        [legL, legR].forEach((leg, i) => {
          const side = i === 0 ? -1 : 1;
          leg.hipPivot.rotation.x = d.spread * 0.7;
          leg.hipPivot.rotation.z = side * d.spread * 0.6;
          leg.kneePivot.rotation.x = d.spread * 0.5;
          leg.anklePivot.rotation.x = -d.spread * 0.4;
        });

        [armL, armR].forEach((arm, i) => {
          const side = i === 0 ? -1 : 1;
          arm.shoulderPivot.rotation.x = -d.spread * 0.8;
          arm.shoulderPivot.rotation.z = side * d.spread * 1.0;
          arm.elbowPivot.rotation.x = REST_ELBOW_X - d.spread * 0.6;
          arm.wristPivot.rotation.x = REST_WRIST_X - d.spread * 0.5;
        });

        // Patches, thread wisps and nape pins all fling loose as the
        // last stitches let go.
        patches.forEach((patch, i) => {
          patch.rotation.z = (i % 2 === 0 ? 1 : -1) * d.spread * 1.1;
          patch.rotation.x = d.spread * 0.8;
        });
        wispShoulderL.rotation.z = -0.18 - d.spread * 1.1;
        wispShoulderR.rotation.z = 0.16 + d.spread * 1.1;
        wispWaist.rotation.x = 0.35 + d.spread * 0.9;
        napePins.forEach((pivot, i) => {
          pivot.rotation.z = (i % 2 === 0 ? -1 : 1) * d.spread * 0.9;
          pivot.rotation.x = -0.3 + d.spread * 0.6;
        });

        mat.patch.emissiveIntensity = Math.max(0, 0.15 * (1 - dying));
        return; // death pose overrides everything below
      }

      // Reset root/spine transforms in case a previous frame was
      // mid-dissolve and the mob got revived/recycled (defensive;
      // animate() must never assume ordering with the mob manager's own
      // lifecycle).
      if (root.scale.x !== 1) root.scale.set(1, 1, 1);
      root.rotation.z = 0;

      // ---- Idle breathing — always active, subtle. ----------------------
      const breatheAmt = rig.breathe(time, 1, 1.2);
      torsoPivot.scale.set(1 + breatheAmt * 0.5, 1 + breatheAmt, 1 + breatheAmt * 0.5);

      // Eye-slot faint pulse, flares with hurt/telegraph/attack.
      mat.patch.emissiveIntensity =
        0.15 + Math.sin(time * 1.8) * 0.08 + hurt * 0.35 + telegraph * 0.25 + attack * 0.15;

      const idleAmt = 1 - speed01;

      if (hurt > 0) {
        // Sharp jolt/flinch — fast lateral twist, head snap, jittering
        // patches and nape pins.
        torsoPivot.rotation.z = Math.sin(time * 34) * hurt * 0.16 + lean * 0.2;
        torsoPivot.rotation.x = REST_TORSO_X + hurt * 0.08;
        headPivot.rotation.x = Math.sin(time * 34) * hurt * 0.22;
        patches.forEach((patch, i) => {
          patch.rotation.x = Math.sin(time * 40 + i) * hurt * 0.2;
        });
        napePins.forEach((pivot, i) => {
          pivot.rotation.z = Math.sin(time * 36 + i * 1.3) * hurt * 0.3;
        });
      } else {
        torsoPivot.rotation.z = rig.damp(torsoPivot.rotation.z, lean * 0.3, 8, dt || 0.016);
        headPivot.rotation.x = rig.damp(headPivot.rotation.x, 0, 8, dt || 0.016);
      }

      if (moving && hurt <= 0) {
        // --- Jerky, quantized stop-start stalking stride ---
        // rig.legSwing driven off a phase that is quantized into discrete
        // held steps so the motion snaps between poses rather than
        // smoothly sine-ing, matching the "wrong-woven, jerky" read, while
        // still scaling amplitude/cadence with state.speed01 like a real
        // walk cycle.
        const strideFreq = 1.7;
        const cadence = strideFreq * (0.35 + 0.65 * speed01);
        const rawPhase = time * cadence;
        const whole = Math.floor(rawPhase);
        const frac = rawPhase - whole;
        const STEPS = 6;
        const steppedFrac = Math.floor(frac * STEPS) / STEPS;
        const stridePhase = whole + steppedFrac;

        const swingAmp = 0.55 * (0.4 + 0.6 * speed01);
        const hipL = rig.legSwing(stridePhase, swingAmp);
        const hipR = rig.legSwing(stridePhase + 0.5, swingAmp);
        const kneeL = Math.max(0, rig.legSwing(stridePhase - 0.14, 1)) * 0.6 * speed01;
        const kneeR = Math.max(0, rig.legSwing(stridePhase - 0.14 + 0.5, 1)) * 0.6 * speed01;

        legL.hipPivot.rotation.x = hipL;
        legR.hipPivot.rotation.x = hipR;
        legL.kneePivot.rotation.x = kneeL;
        legR.kneePivot.rotation.x = kneeR;
        legL.anklePivot.rotation.x = -kneeL * 0.4;
        legR.anklePivot.rotation.x = -kneeR * 0.4;
        legL.hipPivot.rotation.z = lean * 0.2;
        legR.hipPivot.rotation.z = lean * 0.2;

        // Torso lurches forward with each held step and bobs on the
        // stepped cadence rather than a smooth sine.
        torsoPivot.rotation.x = REST_TORSO_X + Math.sin(stridePhase * Math.PI * 2) * 0.06 * speed01;
        root.position.y = Math.abs(Math.sin(stridePhase * Math.PI * 2)) * 0.022 * speed01 * (grounded ? 1 : 0.4);

        // Arms swing loosely opposite the legs with a stiff wrong-angle
        // elbow flex, unless a telegraph/attack is overriding them below.
        armL.shoulderPivot.rotation.x = hipR * 0.55;
        armR.shoulderPivot.rotation.x = hipL * 0.55;
        armL.elbowPivot.rotation.x = REST_ELBOW_X + Math.sin(stridePhase * Math.PI) * 0.12;
        armR.elbowPivot.rotation.x = REST_ELBOW_X + Math.sin(stridePhase * Math.PI + 1.0) * 0.12;
        armL.wristPivot.rotation.x = REST_WRIST_X;
        armR.wristPivot.rotation.x = REST_WRIST_X;
      } else if (hurt <= 0) {
        // --- Statue-still-by-day / idle menace by night: slow sway plus
        // a slow needle-finger flex at the elbows/blades. ---
        legL.hipPivot.rotation.x = rig.damp(legL.hipPivot.rotation.x, 0, 6, dt || 0.016);
        legR.hipPivot.rotation.x = rig.damp(legR.hipPivot.rotation.x, 0, 6, dt || 0.016);
        legL.kneePivot.rotation.x = rig.damp(legL.kneePivot.rotation.x, 0, 6, dt || 0.016);
        legR.kneePivot.rotation.x = rig.damp(legR.kneePivot.rotation.x, 0, 6, dt || 0.016);
        legL.anklePivot.rotation.x = rig.damp(legL.anklePivot.rotation.x, 0, 6, dt || 0.016);
        legR.anklePivot.rotation.x = rig.damp(legR.anklePivot.rotation.x, 0, 6, dt || 0.016);
        legL.hipPivot.rotation.z = lean * 0.2;
        legR.hipPivot.rotation.z = lean * 0.2;

        torsoPivot.rotation.x = REST_TORSO_X + rig.sway(time, 0.6, 0.9, 0) * idleAmt;
        root.position.y = rig.sway(time, 0.25, 1.1, 0.7) * 0.02;

        armL.shoulderPivot.rotation.x = rig.damp(armL.shoulderPivot.rotation.x, 0, 6, dt || 0.016);
        armR.shoulderPivot.rotation.x = rig.damp(armR.shoulderPivot.rotation.x, 0, 6, dt || 0.016);

        // Slow menacing needle-finger flex: elbow/wrist bend and
        // straighten gently, out of phase left/right.
        armL.elbowPivot.rotation.x = REST_ELBOW_X + rig.sway(time, 1.4, 1.0, 0) * 1.6;
        armR.elbowPivot.rotation.x = REST_ELBOW_X + rig.sway(time, 1.4, 1.0, Math.PI) * 1.6;
        armL.wristPivot.rotation.x = REST_WRIST_X + rig.sway(time, 1.2, 1.0, 0.5) * 1.4;
        armR.wristPivot.rotation.x = REST_WRIST_X + rig.sway(time, 1.2, 1.0, Math.PI + 0.5) * 1.4;
      }

      // ---- Telegraph / attack overlay: needle-arm pull-back + fast
      // stab thrust. Alternates which arm leads on each new wind-up. ----
      const telegraphActive = telegraph > 0.001;
      if (telegraphActive && !prevTelegraphActive) leadSign = -leadSign;
      prevTelegraphActive = telegraphActive;

      if (telegraph > 0 || attack > 0) {
        const wind = rig.windUp(telegraph); // 0 .. ~-1.1 .. -1
        const strikeAmt = rig.strike(attack); // 0 .. 1, front-loaded

        const leadArm = leadSign > 0 ? armR : armL;
        const otherArm = leadSign > 0 ? armL : armR;

        // Straight, coiled pull-back on wind-up, then a fast whip-crack
        // thrust through shoulder+elbow+wrist on the strike.
        const pull = Math.max(0, -wind); // 0 .. ~1.1
        const driveX = -pull * 0.95 + strikeAmt * 1.55;
        leadArm.shoulderPivot.rotation.x = driveX;
        leadArm.elbowPivot.rotation.x = REST_ELBOW_X - pull * 0.32 - strikeAmt * 0.3;
        leadArm.wristPivot.rotation.x = REST_WRIST_X + pull * 0.15 - strikeAmt * 0.35;

        // Off arm counter-pulls back slightly for balance.
        otherArm.shoulderPivot.rotation.x = -pull * 0.28 + strikeAmt * 0.15;
        otherArm.elbowPivot.rotation.x = REST_ELBOW_X + pull * 0.08;

        // Torso hunches lower while coiling, then lunges forward behind
        // the strike; head snaps forward at the moment of impact.
        torsoPivot.rotation.x = REST_TORSO_X + pull * 0.12 + strikeAmt * 0.16;
        headBackZ = rig.damp(headBackZ, strikeAmt * 0.05, 20, dt || 0.016);
        headPivot.position.z = headBackZ;
      } else {
        headBackZ = rig.damp(headBackZ, 0, 10, dt || 0.016);
        headPivot.position.z = headBackZ;
      }

      // ---- Nape pins and thread wisps waver independently at all
      // times so the wrong-woven, frayed read never goes fully still. ---
      napePins.forEach((pivot, i) => {
        if (hurt <= 0) {
          pivot.rotation.z = Math.sin(time * (1.6 + speed01 * 2) + i * 1.1) * 0.08;
        }
      });
      wispShoulderL.rotation.x = Math.sin(time * 1.7 + 0.3) * 0.1 + lean * 0.2;
      wispShoulderR.rotation.x = Math.sin(time * 1.9 + 1.1) * 0.1 - lean * 0.2;
      wispWaist.rotation.z = Math.sin(time * 1.5 + 0.6) * 0.12;

      // Patches flutter very slightly at all times — cheap secondary
      // motion that keeps the stitched-cloth read alive even at idle.
      if (hurt <= 0) {
        patches.forEach((patch, i) => {
          patch.rotation.x = Math.sin(time * 1.3 + i * 0.8) * 0.03;
        });
      }
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
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
    'forearms taper through a shoulder-elbow-wrist chain into long, cold-grey ' +
    'needle-blades bent at wrong angles like a folding ruler, drawn back and ' +
    'coiled straight before they snap into a stab. Its narrow slate-steel ' +
    'body is wrapped in thread-bands beneath a crooked, asymmetric shoulder ' +
    'yoke, studded with mismatched stitched-on cloth patches — every kill it ' +
    'lands sewn into itself — and trailing loose thread wisps from the ' +
    'shoulders and waist. Its head is small and featureless but for a blunt ' +
    'needle-eye slot of dull blood-red where a face should be, and a bristle ' +
    'of broken needle-pins at the nape. Even its feet taper to a point.',
};
