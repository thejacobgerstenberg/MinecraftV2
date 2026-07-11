import * as THREE from 'three';

// ---------------------------------------------------------------------------
// The Unpicked — a hostile, half-come-apart void shambler of Nevermend.
// Archetype: groaner (slow, tanky, shambling hostile)
//
// Silhouette goals: an upright humanoid TORSO that is literally UNRAVELLING.
// The lower body does NOT end in legs — instead it dissolves into several
// loose, drifting thread-strand boxes of varying length that hang and sway
// independently, never quite touching the ground plane cleanly. One arm is
// partly unpicked into floating thread wisps that trail away from the
// shoulder rather than terminating in a hand. A hollow VOID-CORE chest
// cavity glows cold violet at the sternum. The head droops and frays at the
// crown. ~1.3 units tall. Asymmetric throughout — nothing mirrors cleanly,
// because the Loom's pattern for this Mender was never finished.
// ---------------------------------------------------------------------------

// Canonical The Unpicked bestiary palette — cold void grey-blue.
const PALETTE = {
  voidMass: 0x525a68,   // void grey-blue — main solid torso/head mass
  voidShade: 0x2b303b,  // darker grey-blue shade — secondary mass / depth read
  thread: 0xb8c0ce,     // unravelled thread grey-blue — dangling strands
  threadDark: 0x7a8494, // darker strand variant for depth
  core: 0xe4e9f2,       // cold void-glow core — chest cavity + eyes
};

function makeMaterials() {
  return {
    voidMass: new THREE.MeshStandardMaterial({
      color: PALETTE.voidMass,
      roughness: 0.9,
      metalness: 0.05,
    }),
    voidShade: new THREE.MeshStandardMaterial({
      color: PALETTE.voidShade,
      roughness: 0.9,
      metalness: 0.05,
    }),
    thread: new THREE.MeshStandardMaterial({
      color: PALETTE.thread,
      roughness: 0.85,
      metalness: 0.0,
    }),
    threadDark: new THREE.MeshStandardMaterial({
      color: PALETTE.threadDark,
      roughness: 0.85,
      metalness: 0.0,
    }),
    core: new THREE.MeshStandardMaterial({
      color: PALETTE.core,
      roughness: 0.35,
      metalness: 0.1,
      emissive: new THREE.Color(PALETTE.core),
      emissiveIntensity: 1.0,
    }),
  };
}

// Box mesh whose origin sits at its TOP center, so it can be parented to a
// joint pivot and hang/dangle naturally — used for every drifting thread
// strand and unpicked limb segment.
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
  root.name = 'The Unpicked';

  const mat = makeMaterials();
  const parts = {};

  // Waist height — where the solid torso mass ends and the unravelling
  // thread-strand "legs" begin. Strands hang from here down to y=0.
  const WAIST_Y = 0.62;

  // -------------------------------------------------------------------
  // TORSO — solid void-indigo mass, slightly hunched and asymmetric, sits
  // above the waist line where it comes apart into strands.
  // -------------------------------------------------------------------
  const torsoPivot = new THREE.Group();
  torsoPivot.position.set(0, WAIST_Y, 0);
  torsoPivot.rotation.x = 0.14; // slight forward hunch
  torsoPivot.rotation.z = 0.05; // asymmetric lean toward the unpicked side
  root.add(torsoPivot);

  const waist = box(0.22, 0.16, 0.16, mat.voidMass);
  waist.position.set(0, 0.08, 0);
  torsoPivot.add(waist);

  const chest = box(0.30, 0.28, 0.20, mat.voidMass);
  chest.position.set(0.01, 0.32, -0.01);
  torsoPivot.add(chest);

  // A secondary shade-mass slumped off one side, breaking the silhouette.
  const chestWrap = box(0.13, 0.22, 0.18, mat.voidShade);
  chestWrap.position.set(0.19, 0.28, 0.0);
  chestWrap.rotation.z = -0.12;
  torsoPivot.add(chestWrap);

  // Shoulder yoke, asymmetric — one side thick (intact), one side thinned
  // where the arm is unpicking away.
  const shoulderYoke = box(0.34, 0.09, 0.19, mat.voidShade);
  shoulderYoke.position.set(-0.01, 0.48, 0.0);
  shoulderYoke.rotation.z = -0.04;
  torsoPivot.add(shoulderYoke);

  // -------------------------------------------------------------------
  // VOID-CORE — hollow glowing chest cavity, the creature's signature
  // glow. A dark recessed socket behind a smaller glowing core box gives
  // it a "hollow cavity" read rather than a flat glow patch.
  // -------------------------------------------------------------------
  const coreSocket = box(0.14, 0.16, 0.05, mat.voidShade);
  coreSocket.position.set(0.01, 0.30, 0.105);
  torsoPivot.add(coreSocket);

  const coreGlow = box(0.09, 0.10, 0.04, mat.core);
  coreGlow.position.set(0.01, 0.30, 0.135);
  torsoPivot.add(coreGlow);

  parts.torsoPivot = torsoPivot;
  parts.coreGlow = coreGlow;

  // -------------------------------------------------------------------
  // HEAD — drooped, fraying at the crown, hollow cold-glow eyes.
  // -------------------------------------------------------------------
  const headPivot = new THREE.Group();
  headPivot.position.set(-0.02, 0.50, 0.03);
  headPivot.rotation.x = 0.30; // drooped forward
  torsoPivot.add(headPivot);

  const head = box(0.20, 0.20, 0.18, mat.voidMass);
  head.position.set(0, 0.10, 0);
  headPivot.add(head);

  // Fraying crown — a couple of short thread stubs poking up from the
  // top of the head where the weave is coming undone.
  const crownFrayA = hangingBox(0.03, 0.10, 0.03, mat.thread);
  crownFrayA.position.set(-0.06, 0.20, -0.02);
  crownFrayA.rotation.x = Math.PI; // point upward (hangingBox origin is at top)
  headPivot.add(crownFrayA);

  const crownFrayB = hangingBox(0.025, 0.07, 0.025, mat.threadDark);
  crownFrayB.position.set(0.05, 0.20, 0.02);
  crownFrayB.rotation.x = Math.PI;
  headPivot.add(crownFrayB);

  // Hollow cold-glow eyes, asymmetric.
  const eyeL = box(0.03, 0.03, 0.02, mat.core);
  eyeL.position.set(-0.055, 0.12, 0.09);
  headPivot.add(eyeL);

  const eyeR = box(0.026, 0.026, 0.02, mat.core);
  eyeR.position.set(0.05, 0.115, 0.09);
  headPivot.add(eyeR);

  parts.headPivot = headPivot;
  parts.eyeL = eyeL;
  parts.eyeR = eyeR;

  // Head anchor for name tags, above the drooped head.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 1.30, 0.04);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // ARMS — one intact (mostly solid, unravelling only at the wrist), one
  // partly unpicked into a spray of floating thread wisps that trail off
  // the shoulder instead of ending in a hand. This asymmetry is the
  // secondary silhouette read after the strand-legs.
  // -------------------------------------------------------------------

  // Right arm — intact, solid, hangs down normally with a frayed cuff.
  const armRPivot = new THREE.Group();
  armRPivot.position.set(0.18, 0.47, 0.0);
  torsoPivot.add(armRPivot);

  const armRUpper = hangingBox(0.075, 0.20, 0.075, mat.voidMass);
  armRPivot.add(armRUpper);

  const armRElbow = new THREE.Group();
  armRElbow.position.set(0, -0.20, 0);
  armRPivot.add(armRElbow);

  const armRFore = hangingBox(0.06, 0.22, 0.06, mat.voidShade);
  armRElbow.add(armRFore);

  const armRCuff = hangingBox(0.02, 0.10, 0.02, mat.thread);
  armRCuff.position.set(0, -0.22, 0);
  armRElbow.add(armRCuff);

  parts.armR = { armRPivot, armRElbow, armRCuff };

  // Left arm — partly unpicked. A short stub of solid upper-arm remains at
  // the shoulder, then it dissolves into a spray of independent floating
  // thread-wisp pivots rather than a continuous limb.
  const armLPivot = new THREE.Group();
  armLPivot.position.set(-0.19, 0.47, 0.0);
  torsoPivot.add(armLPivot);

  const armLStub = hangingBox(0.07, 0.11, 0.07, mat.voidMass);
  armLPivot.add(armLStub);

  const unpickWisps = [];
  const wispDefs = [
    { len: 0.18, x: -0.03, z: 0.02, mat: mat.thread },
    { len: 0.24, x: 0.02, z: -0.02, mat: mat.threadDark },
    { len: 0.14, x: -0.06, z: -0.03, mat: mat.thread },
    { len: 0.20, x: 0.05, z: 0.03, mat: mat.threadDark },
    { len: 0.10, x: 0.0, z: 0.0, mat: mat.thread },
  ];
  wispDefs.forEach((w) => {
    const wispPivot = new THREE.Group();
    wispPivot.position.set(w.x, -0.10, w.z);
    armLPivot.add(wispPivot);
    const wispMesh = hangingBox(0.018, w.len, 0.018, w.mat);
    wispPivot.add(wispMesh);
    unpickWisps.push(wispPivot);
  });

  parts.armLPivot = armLPivot;
  parts.unpickWisps = unpickWisps;

  // -------------------------------------------------------------------
  // LOWER BODY — the signature read. NO solid legs. Instead, several
  // thin, loose thread-strand boxes of varying length hang from the
  // waist, each on its own pivot so they can drift/sway independently
  // and never form a clean silhouette. Lengths vary so the "hem" reads
  // ragged rather than a skirt.
  // -------------------------------------------------------------------
  const strandDefs = [
    { x: -0.10, z: 0.03, len: 0.58, w: 0.05, mat: mat.thread },
    { x: -0.05, z: -0.02, len: 0.50, w: 0.04, mat: mat.threadDark },
    { x: 0.0, z: 0.04, len: 0.62, w: 0.045, mat: mat.thread },
    { x: 0.05, z: -0.03, len: 0.44, w: 0.04, mat: mat.threadDark },
    { x: 0.10, z: 0.02, len: 0.56, w: 0.05, mat: mat.thread },
    { x: 0.13, z: -0.01, len: 0.36, w: 0.035, mat: mat.threadDark },
    { x: -0.13, z: 0.0, len: 0.40, w: 0.035, mat: mat.thread },
  ];
  const strands = strandDefs.map((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(s.x, WAIST_Y, s.z);
    root.add(pivot);
    const mesh = hangingBox(s.w, s.len, s.w, s.mat);
    pivot.add(mesh);
    return pivot;
  });
  parts.strands = strands;

  // A faded, translucent-feeling "ghost hem" box just under the waist to
  // keep the top of the strand cluster from reading as a bare gap between
  // the solid torso and the loose threads.
  const hemFray = box(0.26, 0.05, 0.16, mat.voidShade);
  hemFray.position.set(0, WAIST_Y - 0.02, 0);
  root.add(hemFray);
  parts.hemFray = hemFray;

  // Store all animated sub-parts for animate() to reach.
  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION
  // Idle: slow drifting shamble sway on the torso, every strand wavers on
  //       its own independent phase, core pulses, unpicked wisps drift.
  // Walk: slow lurching drift — strands trail behind the motion, torso
  //       rocks forward, intact arm swings as dead weight, wisps stream.
  // Hurt: strands scatter outward and the head/torso flinch sharply.
  // -------------------------------------------------------------------
  root.userData.animate = (t, state) => {
    const s = state || {};
    const moving = !!s.moving;
    const hurt = s.hurt || 0;

    // Core pulse — always active, cold void-glow breathing.
    mat.core.emissiveIntensity = 0.75 + Math.sin(t * 1.7) * 0.35;
    const coreScale = 1 + Math.sin(t * 1.7) * 0.12;
    coreGlow.scale.set(coreScale, coreScale, coreScale);

    // Idle breathing / drifting shamble sway on the torso — always on.
    const drift = t * 0.7;
    const breathe = Math.sin(t * 1.4);
    torsoPivot.scale.set(1 + breathe * 0.02, 1 + breathe * 0.035, 1 + breathe * 0.02);

    if (moving) {
      // --- Slow lurching drift ---
      const stride = t * 2.6; // slow, tanky gait
      root.position.y = Math.abs(Math.sin(stride)) * 0.025;
      torsoPivot.rotation.z = 0.05 + Math.sin(stride * 0.5) * 0.10;
      torsoPivot.rotation.x = 0.14 + Math.abs(Math.sin(stride)) * 0.08;
      headPivot.rotation.z = Math.sin(stride * 0.5 + 0.5) * 0.10;

      // Intact right arm swings as limp dead weight.
      armRPivot.rotation.x = Math.sin(stride + 0.4) * 0.30 + 0.10;
      armRElbow.rotation.x = Math.sin(stride - 0.6) * 0.18 + 0.08;

      // Unpicked stub arm barely moves at the shoulder, but its wisps
      // stream backward from the lurch.
      armLPivot.rotation.x = Math.sin(stride * 0.5) * 0.06;

      // Strands trail behind the motion — a lagged sway biased backward.
      strands.forEach((pivot, i) => {
        const phase = i * 0.9;
        pivot.rotation.x = -0.14 + Math.sin(stride * 0.6 + phase) * 0.16;
        pivot.rotation.z = Math.sin(t * 1.3 + phase * 1.7) * 0.12;
      });
    } else {
      // --- Idle: slow drifting shamble sway, no directed travel ---
      torsoPivot.rotation.z = 0.05 + Math.sin(drift) * 0.06;
      torsoPivot.rotation.x = 0.14 + Math.sin(drift * 0.6) * 0.03;
      headPivot.rotation.z = Math.sin(drift * 0.5 + 0.8) * 0.06;
      headPivot.rotation.x = 0.30 + Math.sin(drift * 0.4 + 1.2) * 0.02;

      armRPivot.rotation.x = Math.sin(t * 0.9) * 0.07 + 0.04;
      armRElbow.rotation.x = Math.sin(t * 0.9 + 0.6) * 0.06 + 0.06;
      armLPivot.rotation.x = Math.sin(t * 0.7 + 0.3) * 0.04;

      root.position.y = 0;

      // Every thread strand wavers on its own independent phase so the
      // lower body reads as loose, floating, and never static.
      strands.forEach((pivot, i) => {
        const phase = i * 1.15;
        pivot.rotation.x = Math.sin(t * 0.9 + phase) * 0.14;
        pivot.rotation.z = Math.sin(t * 1.15 + phase * 1.4) * 0.13;
      });
    }

    // Unpicked-arm thread wisps drift/float independently, always active,
    // faster and looser than the leg strands to read as airborne threads.
    unpickWisps.forEach((wispPivot, i) => {
      const phase = i * 1.8;
      wispPivot.rotation.x = Math.sin(t * 1.6 + phase) * 0.35;
      wispPivot.rotation.z = Math.cos(t * 1.3 + phase * 0.7) * 0.30;
    });

    // Fraying crown threads sway gently, always active.
    crownFrayA.rotation.z = Math.sin(t * 1.8) * 0.25;
    crownFrayB.rotation.z = Math.sin(t * 2.1 + 0.9) * 0.28;

    // Hurt — strands scatter outward and the whole figure flinches
    // sharply, then settles back into its normal drift.
    if (hurt > 0) {
      torsoPivot.rotation.z += hurt * 0.28 * Math.sin(t * 32);
      headPivot.rotation.x -= hurt * 0.18;
      strands.forEach((pivot, i) => {
        const outward = (i % 2 === 0 ? 1 : -1) * hurt * 0.35;
        pivot.rotation.x += outward;
        pivot.rotation.z += outward * 0.6;
      });
      unpickWisps.forEach((wispPivot, i) => {
        const outward = (i % 2 === 0 ? 1 : -1) * hurt * 0.4;
        wispPivot.rotation.x += outward;
      });
      const flinchScale = 1 + hurt * 0.06;
      torsoPivot.scale.x *= flinchScale;
      torsoPivot.scale.z *= flinchScale;
    }
  };

  return root;
}

export const meta = {
  archetype: 'groaner',
  species: 'The Unpicked',
  canonicalId: 'unpicked',
  dimensionDefault: 'nevermend',
  palette: {
    voidMass: '#525A68',
    voidShade: '#2B303B',
    thread: '#B8C0CE',
    threadDark: '#7A8494',
    core: '#E4E9F2',
  },
  description:
    'A hostile, slow, tanky void shambler that drifted loose from Nevermend, ' +
    'where the Loom\'s pattern for it was never finished. Its upper body is a ' +
    'solid void-indigo torso, hunched and asymmetric, with a hollow core ' +
    'cavity glowing cold violet at the sternum. Below the waist it has no ' +
    'legs at all — the weave simply dissolves into a loose cluster of ' +
    'thread-grey-violet strands that drift and sway as it drags itself ' +
    'forward. One arm remains intact; the other has unpicked itself into a ' +
    'spray of floating thread wisps that trail from the shoulder. Slow but ' +
    'heavy and hard to put down, The Unpicked shambles toward any Mender who ' +
    'strays too near the seams of Nevermend.',
};
