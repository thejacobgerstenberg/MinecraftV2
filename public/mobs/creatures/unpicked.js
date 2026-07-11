import * as THREE from 'three';
import * as rig from '../anim/rig.js';

// ---------------------------------------------------------------------------
// THE UNPICKED — a hostile, half-come-apart void shambler of Nevermend.
// Archetype: groaner (slow, tanky, shambling hostile)
//
// Silhouette goals: an upright humanoid TORSO that is literally UNRAVELLING.
// The lower body does NOT end in legs — instead it dissolves into several
// loose, drifting thread-strand boxes of varying length that hang and sway
// independently, never quite touching the ground plane cleanly. A ragged
// thread-drape trails off the back of the shoulders like a tattered cloak.
// One arm is partly unpicked into floating thread wisps that trail away
// from the shoulder rather than terminating in a hand. A hollow VOID-CORE
// chest cavity glows cold violet at the sternum, orbited by two drifting
// motes of loose thread. The head droops and frays at the crown, with
// hollow recessed eye sockets giving it real depth at a glance. ~1.3 units
// tall. Asymmetric throughout — nothing mirrors cleanly, because the Loom's
// pattern for this Mender was never finished.
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
    // The void-core is built from TWO layered materials rather than one hot
    // flat-emissive quad: a small, bright core (mat.core above) plus a
    // larger, much dimmer, additively-blended halo sitting just behind it.
    // Without a post-process bloom pass, a single emissive box on a flat
    // background photographs as a pasted-on rectangle, not a glow. Splitting
    // it into core + translucent halo fakes the soft-edged gradient falloff
    // a real bloom would give, so it reads as light spilling outward.
    coreHalo: new THREE.MeshStandardMaterial({
      color: PALETTE.core,
      roughness: 1.0,
      metalness: 0.0,
      emissive: new THREE.Color(PALETTE.core),
      emissiveIntensity: 0.35,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    // Rim-light trim: thin core-colored slivers run along leading edges of
    // the otherwise flat-lit dark torso/head/shoulder mass (front-top edges
    // that would catch a backlight). This fakes a cold rim highlight so the
    // silhouette keeps separating from a dark background even when ambient
    // light is low, instead of the whole upper body reading as one flat
    // near-black block.
    rim: new THREE.MeshStandardMaterial({
      color: PALETTE.thread,
      roughness: 0.4,
      metalness: 0.1,
      emissive: new THREE.Color(PALETTE.thread),
      emissiveIntensity: 0.55,
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

// Defensive numeric coercion — animate() must never throw or propagate NaN.
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
  root.name = 'The Unpicked';

  const mat = makeMaterials();
  const parts = {};

  // Waist height — where the solid torso mass ends and the unravelling
  // thread-strand "legs" begin. Strands hang from here down to y=0.
  const WAIST_Y = 0.62;
  const REST_TORSO_X = 0.24; // permanent forward hunch — deepened so the rest
                              // pose itself reads as a committed forward
                              // lurch rather than a neutral idle stance
  const REST_TORSO_Z = 0.05; // permanent asymmetric lean toward the unpicked side
  const REST_HEAD_X = 0.30; // permanent drooped-head pitch
  const REST_ARM_R_X = 0.18; // permanent forward reach bias on the intact arm,
                              // so even at rest it looks mid-grasp, not hanging

  // -------------------------------------------------------------------
  // TORSO — solid void-indigo mass, slightly hunched and asymmetric, sits
  // above the waist line where it comes apart into strands.
  // -------------------------------------------------------------------
  const torsoPivot = new THREE.Group();
  torsoPivot.position.set(0, WAIST_Y, 0);
  torsoPivot.rotation.x = REST_TORSO_X;
  torsoPivot.rotation.z = REST_TORSO_Z;
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

  // A thin rib-seam accent down the front of the chest, off-center — the
  // cheapest possible silhouette upgrade: it breaks the chest's flat front
  // face into two unequal panels, reading as a seam the weave gave out
  // along, and it reads clearly even at thumbnail size.
  const ribSeam = box(0.025, 0.20, 0.03, mat.voidShade);
  ribSeam.position.set(-0.05, 0.30, 0.105);
  torsoPivot.add(ribSeam);

  // Shoulder yoke, asymmetric — one side thick (intact), one side thinned
  // where the arm is unpicking away.
  const shoulderYoke = box(0.34, 0.09, 0.19, mat.voidShade);
  shoulderYoke.position.set(-0.01, 0.48, 0.0);
  shoulderYoke.rotation.z = -0.04;
  torsoPivot.add(shoulderYoke);

  // Small frayed tatters clinging to each end of the shoulder yoke — cheap
  // secondary detail that reads as the weave fraying right at the seam
  // line, and gives the top of the silhouette a raggeder edge than a clean
  // rectangular yoke would.
  const shoulderTatterL = hangingBox(0.02, 0.07, 0.02, mat.thread);
  shoulderTatterL.position.set(0.165, -0.02, 0.06);
  shoulderTatterL.rotation.x = 0.4;
  shoulderYoke.add(shoulderTatterL);

  const shoulderTatterR = hangingBox(0.018, 0.05, 0.018, mat.threadDark);
  shoulderTatterR.position.set(-0.17, -0.02, -0.05);
  shoulderTatterR.rotation.x = -0.3;
  shoulderYoke.add(shoulderTatterR);

  // Cold rim-light trim along the shoulder yoke's top-front edge and the
  // chest's top-front edge — thin core-colored slivers that catch a rim
  // highlight so the dark torso mass keeps separating from a dark backdrop
  // instead of reading as one flat near-black block from the collar up.
  const shoulderRim = box(0.32, 0.018, 0.018, mat.rim);
  shoulderRim.position.set(-0.01, 0.045, 0.095);
  shoulderYoke.add(shoulderRim);

  const chestRim = box(0.26, 0.018, 0.018, mat.rim);
  chestRim.position.set(0.01, 0.46, 0.095);
  torsoPivot.add(chestRim);
  parts.chestRim = chestRim;
  parts.shoulderRim = shoulderRim;

  // -------------------------------------------------------------------
  // VOID-CORE — hollow glowing chest cavity, the creature's signature
  // glow. A dark recessed socket behind a smaller glowing core box gives
  // it a "hollow cavity" read rather than a flat glow patch, and two loose
  // thread motes drift in slow orbit around it.
  // -------------------------------------------------------------------
  const coreSocket = box(0.14, 0.16, 0.05, mat.voidShade);
  coreSocket.position.set(0.01, 0.30, 0.105);
  torsoPivot.add(coreSocket);

  // A larger, dim, additively-blended halo sits just behind the small
  // bright core so the glow has a soft-edged gradient bleeding into the
  // socket around it, instead of reading as a single hard-edged pasted-on
  // rectangle.
  const coreHalo = box(0.20, 0.22, 0.03, mat.coreHalo);
  coreHalo.position.set(0.01, 0.30, 0.125);
  torsoPivot.add(coreHalo);

  const coreGlow = box(0.09, 0.10, 0.04, mat.core);
  coreGlow.position.set(0.01, 0.30, 0.145);
  torsoPivot.add(coreGlow);

  const coreMotePivotA = new THREE.Group();
  coreMotePivotA.position.set(0.01, 0.30, 0.135);
  torsoPivot.add(coreMotePivotA);
  const coreMoteA = box(0.018, 0.018, 0.018, mat.thread);
  coreMoteA.position.set(0.08, 0.015, 0.01);
  coreMotePivotA.add(coreMoteA);

  const coreMotePivotB = new THREE.Group();
  coreMotePivotB.position.set(0.01, 0.30, 0.135);
  torsoPivot.add(coreMotePivotB);
  const coreMoteB = box(0.014, 0.014, 0.014, mat.threadDark);
  coreMoteB.position.set(-0.065, -0.02, 0.02);
  coreMotePivotB.add(coreMoteB);

  parts.torsoPivot = torsoPivot;
  parts.coreGlow = coreGlow;
  parts.coreHalo = coreHalo;
  parts.coreMotePivotA = coreMotePivotA;
  parts.coreMotePivotB = coreMotePivotB;

  // -------------------------------------------------------------------
  // HEAD — drooped, fraying at the crown, hollow cold-glow eyes recessed
  // into dark sockets for a real depth read rather than flat glow flecks.
  // -------------------------------------------------------------------
  const headPivot = new THREE.Group();
  headPivot.position.set(-0.02, 0.50, 0.03);
  headPivot.rotation.x = REST_HEAD_X;
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

  // Cold rim-light trim along the head's top-front edge — carries the same
  // rim highlight up onto the head so it doesn't go flat-dark right where
  // the eyes need the most contrast to pop.
  const headRim = box(0.16, 0.016, 0.016, mat.rim);
  headRim.position.set(0, 0.20, 0.09);
  headPivot.add(headRim);
  parts.headRim = headRim;

  // Recessed dark sockets behind each eye — a small voidShade box just
  // behind and slightly larger than the glowing eye box, giving a hollow
  // cavity read instead of a flat glowing patch on the face.
  const socketL = box(0.045, 0.045, 0.02, mat.voidShade);
  socketL.position.set(-0.055, 0.12, 0.085);
  headPivot.add(socketL);
  const socketR = box(0.04, 0.04, 0.02, mat.voidShade);
  socketR.position.set(0.05, 0.115, 0.085);
  headPivot.add(socketR);

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
  // secondary silhouette read after the strand-legs. The intact arm is
  // also the creature's reaching attack limb.
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
  // BACK-DRAPE — a few longer, looser thread strips trailing off the back
  // of the shoulder yoke like a tattered half-cloak. Reads as a distinct
  // silhouette shape behind the torso (taller and looser than the leg
  // strands) and gives the walk a trailing, dragging read.
  // -------------------------------------------------------------------
  const backDrapeDefs = [
    { x: -0.09, len: 0.30, w: 0.045, mat: mat.threadDark },
    { x: 0.0, len: 0.38, w: 0.05, mat: mat.thread },
    { x: 0.10, len: 0.24, w: 0.04, mat: mat.threadDark },
  ];
  const backDrape = backDrapeDefs.map((d) => {
    const pivot = new THREE.Group();
    pivot.position.set(d.x, -0.045, -0.10);
    pivot.rotation.x = -0.30; // trails backward off the shoulders
    shoulderYoke.add(pivot);
    const mesh = hangingBox(d.w, d.len, d.w, d.mat);
    pivot.add(mesh);
    return pivot;
  });
  parts.backDrape = backDrape;

  // -------------------------------------------------------------------
  // LOWER BODY — the signature read. NO solid legs. Instead, several
  // thin, loose thread-strand boxes of varying length hang from the
  // waist, each on its own pivot so they can drift/sway independently
  // and never form a clean silhouette. Lengths vary so the "hem" reads
  // ragged rather than a skirt.
  // -------------------------------------------------------------------
  // Each strand carries its own baked-in rest tilt (restX/restZ), on top of
  // the independent-phase animated waver below. Without a distinct rest
  // pose, small equal-amplitude sway around a shared zero baseline reads as
  // rigid parallel rods even though each phase differs — a single static
  // frame can't demonstrate the drift. Baking a real fan-out into the rest
  // pose itself makes the "independent drifting strands" read land even in
  // one frame, and it doubles as a captured-mid-lurch trailing silhouette.
  const strandDefs = [
    { x: -0.10, z: 0.03, len: 0.58, w: 0.05, mat: mat.thread, restX: -0.16, restZ: 0.16 },
    { x: -0.05, z: -0.02, len: 0.50, w: 0.04, mat: mat.threadDark, restX: 0.04, restZ: -0.12 },
    { x: 0.0, z: 0.04, len: 0.62, w: 0.045, mat: mat.thread, restX: -0.10, restZ: 0.02 },
    { x: 0.05, z: -0.03, len: 0.44, w: 0.04, mat: mat.threadDark, restX: 0.10, restZ: -0.20 },
    { x: 0.10, z: 0.02, len: 0.56, w: 0.05, mat: mat.thread, restX: -0.02, restZ: 0.18 },
    { x: 0.13, z: -0.01, len: 0.36, w: 0.035, mat: mat.threadDark, restX: 0.14, restZ: -0.06 },
    { x: -0.13, z: 0.0, len: 0.40, w: 0.035, mat: mat.thread, restX: -0.20, restZ: 0.08 },
    { x: -0.17, z: 0.02, len: 0.28, w: 0.03, mat: mat.threadDark, restX: 0.02, restZ: 0.20 },
    { x: 0.17, z: -0.02, len: 0.32, w: 0.03, mat: mat.thread, restX: 0.12, restZ: -0.16 },
  ];
  const strands = strandDefs.map((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(s.x, WAIST_Y, s.z);
    pivot.rotation.x = s.restX;
    pivot.rotation.z = s.restZ;
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
  // ANIMATION — built on mobs/anim/rig.js's procedural-motion helpers.
  // Idle:      rig.breathe drives the torso's slow breathing pulse,
  //            rig.sway drifts the torso/head/strands/wisps independently
  //            so the figure never looks frozen even standing still.
  // Walk:      a slow lurching drift, cadence/amplitude scaled by
  //            state.speed01 via rig.legSwing — the torso rocks and
  //            pitches forward, the intact arm swings as dead weight, and
  //            every thread strand/back-drape strip trails behind the
  //            motion instead of snapping to a discrete leg cycle.
  // Telegraph: rig.windUp pulls the intact right arm up and back and the
  //            void-core motes spin up and pull inward — a reach building.
  // Attack:    rig.strike whips that arm forward and stretches the
  //            forearm taut (thread pulling straight) as it reaches; the
  //            core motes snap outward on release.
  // Hurt:      a sharp, damped flinch scatters the strands/wisps outward
  //            and jolts the torso/head before settling.
  // Death:     rig.dissolve unravels the whole figure — strands stretch
  //            and splay outward, the arms fling apart, the back-drape and
  //            wisps fling loose, the body sinks and shrinks, and the
  //            void-core gutters out. No gore — just threads coming apart.
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
      const idleAmt = 1 - speed01;

      // Lean into turns — damped so the bank never snaps.
      const leanTarget = dying > 0 ? 0 : Math.max(-0.28, Math.min(0.28, -turn * 0.5));
      lean = rig.damp(lean, leanTarget, 7, dt || 0.016);

      // Core pulse — always active, cold void-glow breathing. Quickens
      // through telegraph/attack, dims on hurt.
      const pulseFreq = 1.7 + attack * 3.2 + telegraph * 1.6;
      const corePulse = Math.sin(time * pulseFreq);
      mat.core.emissiveIntensity = Math.max(0, (0.85 + corePulse * 0.35) * (1 - hurt * 0.3) * (1 - dying));
      const coreScale = 1 + corePulse * 0.12 + telegraph * 0.18;
      coreGlow.scale.set(coreScale, coreScale, coreScale);
      // Halo breathes a little wider/dimmer than the core itself so it keeps
      // reading as light spilling outward rather than scaling in lockstep
      // like a single rigid shape.
      mat.coreHalo.emissiveIntensity = Math.max(0, (0.3 + corePulse * 0.15) * (1 - hurt * 0.3) * (1 - dying));
      mat.coreHalo.opacity = Math.max(0, (0.4 + corePulse * 0.12 + telegraph * 0.2) * (1 - dying));
      const haloScale = 1 + corePulse * 0.16 + telegraph * 0.30;
      coreHalo.scale.set(haloScale, haloScale, 1);

      // Void-core motes orbit slowly, spin up and pull inward through the
      // telegraph, then snap back outward as the reach releases.
      const moteRadial = 1 - telegraph * 0.35 + rig.strike(attack) * 0.5;
      coreMotePivotA.rotation.y = time * 1.4 + telegraph * 6;
      coreMotePivotA.scale.set(moteRadial, 1, moteRadial);
      coreMotePivotB.rotation.y = -time * 1.05 - telegraph * 5;
      coreMotePivotB.scale.set(moteRadial, 1, moteRadial);

      if (dying > 0) {
        // --- DEATH: thread-unravel dissolve, no gore ---
        const d = rig.dissolve(dying);
        const sc = Math.max(0.03, d.scale);
        root.scale.set(sc, sc, sc);
        root.position.y = -d.drop * 0.7;

        torsoPivot.rotation.x = REST_TORSO_X + d.spread * 0.30;
        torsoPivot.rotation.z = REST_TORSO_Z + d.spread * 0.20 + lean;
        headPivot.rotation.x = REST_HEAD_X + d.spread * 0.45;
        headPivot.rotation.z = d.spread * 0.4;

        armRPivot.rotation.x = -0.15 - d.spread * 0.7;
        armRPivot.rotation.z = -d.spread * 0.6;
        armRElbow.rotation.x = d.spread * 0.5;
        armRElbow.scale.y = 1 + d.spread * 0.4;
        armLPivot.rotation.x = -0.1 - d.spread * 0.5;
        armLPivot.rotation.z = d.spread * 0.6;

        // Every thread strand stretches taut and splays outward as the
        // weave lets go entirely.
        strands.forEach((pivot, i) => {
          const rest = strandDefs[i];
          const outward = (i % 2 === 0 ? 1 : -1) * d.spread;
          pivot.rotation.x = rest.restX - 0.10 + outward * 0.9;
          pivot.rotation.z = rest.restZ + outward * 0.7;
          pivot.scale.y = 1 + d.spread * 0.5;
        });
        unpickWisps.forEach((wispPivot, i) => {
          const outward = (i % 2 === 0 ? 1 : -1) * d.spread;
          wispPivot.rotation.x = outward * 1.1;
          wispPivot.rotation.z = -outward * 0.8;
          wispPivot.scale.y = 1 + d.spread * 0.6;
        });
        backDrape.forEach((pivot, i) => {
          const outward = (i % 2 === 0 ? 1 : -1) * d.spread;
          pivot.rotation.x = -0.30 - d.spread * 0.6;
          pivot.rotation.z = outward * 0.5;
          pivot.scale.y = 1 + d.spread * 0.4;
        });
        crownFrayA.rotation.z = d.spread * 0.8;
        crownFrayB.rotation.z = -d.spread * 0.9;

        // The void-core gutters out as the last of it comes apart.
        mat.core.emissiveIntensity = Math.max(0, 0.9 * (1 - dying));
        coreGlow.scale.setScalar(Math.max(0.05, 1 - dying * 0.6));
        mat.coreHalo.emissiveIntensity = Math.max(0, 0.35 * (1 - dying));
        mat.coreHalo.opacity = Math.max(0, 0.4 * (1 - dying));
        coreHalo.scale.setScalar(Math.max(0.05, 1 - dying * 0.5));
        return; // death pose overrides everything below
      }

      // Reset root/scale in case a previous frame was mid-dissolve and the
      // mob got revived/recycled (defensive; animate() must never assume
      // ordering with the mob manager's own removal timing).
      if (root.scale.x !== 1) root.scale.set(1, 1, 1);
      if (armRElbow.scale.y !== 1) armRElbow.scale.y = 1;
      strands.forEach((pivot) => { if (pivot.scale.y !== 1) pivot.scale.y = 1; });
      unpickWisps.forEach((wispPivot) => { if (wispPivot.scale.y !== 1) wispPivot.scale.y = 1; });
      backDrape.forEach((pivot) => { if (pivot.scale.y !== 1) pivot.scale.y = 1; });

      // ---- Idle breathing, always active ----
      const breathAmt = rig.breathe(time, 1.3, 0.65);
      torsoPivot.scale.set(1 + breathAmt * 0.7, 1 + breathAmt * 1.3, 1 + breathAmt * 0.7);

      // ---- Slow lurching drift, cadence/amplitude scaled by speed01 ----
      const strideFreq = 0.85; // slow, tanky, dragging cadence
      const cadence = strideFreq * (0.35 + 0.65 * speed01);
      const phase = time * cadence;
      const lurchZ = rig.legSwing(phase, 1) * 0.10 * speed01;
      const lurchX = Math.abs(Math.sin(phase * Math.PI * 2)) * 0.08 * speed01;
      const bob = Math.abs(Math.sin(phase * Math.PI * 2)) * 0.025 * speed01;
      root.position.y = grounded ? bob : bob * 0.4;

      const idleSwayTorso = rig.sway(time, 1, 1, 0) * idleAmt;
      torsoPivot.rotation.z = REST_TORSO_Z + lurchZ + idleSwayTorso * 0.8 + lean;
      torsoPivot.rotation.x = REST_TORSO_X + lurchX + breathAmt * 0.3;
      torsoPivot.rotation.y = lean * 0.4;

      const idleSwayHead = rig.sway(time, 1, 0.8, 1.1) * idleAmt;
      headPivot.rotation.z = Math.sin(phase * Math.PI * 2 + 0.5) * 0.10 * speed01 + idleSwayHead;
      headPivot.rotation.x = REST_HEAD_X - lean * 0.25 - telegraph * 0.12 + attack * 0.05;
      headPivot.rotation.y = lean * 0.5;

      // ---- Intact right arm — limp dead-weight swing, doubling as the
      // reaching attack limb via rig.windUp / rig.strike. ----
      const idleSwayArmR = rig.sway(time, 1, 1.15, 1.9) * idleAmt;
      const armSwingR = Math.sin(phase * Math.PI * 2 + 0.4) * 0.30 * speed01 + idleSwayArmR + REST_ARM_R_X;
      const elbowSwingR = Math.sin(phase * Math.PI * 2 - 0.6) * 0.18 * speed01 + idleSwayArmR * 0.6 + REST_ARM_R_X * 0.65;

      const attackActive = telegraph > 0 || attack > 0;
      if (attackActive) {
        const windAmt = rig.windUp(telegraph); // 0 -> ~-1.1 -> -1
        const strikeAmt = rig.strike(attack); // 0 -> 1, fast release
        const driveX = attack > 0 ? -1 + strikeAmt * 1.9 : windAmt;
        const blend = Math.max(telegraph, attack);
        armRPivot.rotation.x = armSwingR * (1 - blend) + driveX * 0.9;
        armRPivot.rotation.z = attack > 0 ? strikeAmt * 0.25 : -telegraph * 0.20;
        armRElbow.rotation.x = elbowSwingR * (1 - blend) + Math.max(0, driveX) * 0.5;
        // Thread pulls taut as it reaches full extension on the strike.
        armRElbow.scale.y = 1 + strikeAmt * 0.35;
      } else {
        armRPivot.rotation.x = armSwingR;
        armRPivot.rotation.z = 0;
        armRElbow.rotation.x = elbowSwingR;
      }

      // ---- Unpicked stub arm — barely moves at the shoulder, but its
      // wisps stream and drift independently below. ----
      const idleSwayArmL = rig.sway(time, 0.7, 0.7, 0.3) * idleAmt;
      armLPivot.rotation.x = Math.sin(phase * Math.PI * 2) * 0.05 * speed01 + idleSwayArmL;

      // ---- Thread strands: independent waver blended with a backward
      // trail as the creature lurches forward. ----
      strands.forEach((pivot, i) => {
        const rest = strandDefs[i];
        const idleSway = rig.sway(time, 2.3, 0.85, i * 1.15) * idleAmt;
        const trailSway = (-0.14 + Math.sin(phase * Math.PI * 2 * 0.6 + i * 0.9) * 0.16) * speed01;
        pivot.rotation.x = rest.restX + idleSway * 0.6 + trailSway;
        pivot.rotation.z = rest.restZ + Math.sin(time * 1.15 + i * 1.4) * 0.13 * idleAmt + Math.sin(time * 1.3 + i * 1.7) * 0.10 * speed01;
      });

      // ---- Back-drape strips trail heavier behind the lurch, streaming
      // out further the faster the creature moves. ----
      backDrape.forEach((pivot, i) => {
        const drift = rig.sway(time, 1.4, 0.75, i * 1.3) * idleAmt;
        pivot.rotation.x = -0.30 + drift - speed01 * 0.22;
        pivot.rotation.z = Math.sin(time * 1.1 + i * 1.6) * 0.10;
      });

      // Unpicked-arm thread wisps drift/float independently, always
      // active, faster and looser than the leg strands to read as
      // airborne threads. They stream toward the reach during telegraph.
      unpickWisps.forEach((wispPivot, i) => {
        const phaseOff = i * 1.8;
        wispPivot.rotation.x = Math.sin(time * 1.6 + phaseOff) * 0.35 - telegraph * 0.3;
        wispPivot.rotation.z = Math.cos(time * 1.3 + phaseOff * 0.7) * 0.30;
      });

      // Fraying crown threads sway gently, always active.
      crownFrayA.rotation.z = Math.sin(time * 1.8) * 0.25;
      crownFrayB.rotation.z = Math.sin(time * 2.1 + 0.9) * 0.28;

      // Shoulder tatters flutter with the lurch/idle sway.
      shoulderTatterL.rotation.x = 0.4 + Math.sin(time * 2.0 + 0.3) * 0.20;
      shoulderTatterR.rotation.x = -0.3 + Math.sin(time * 2.3 + 1.1) * 0.18;

      // ---- Hurt: sharp, damped flinch — strands/wisps scatter outward
      // and the whole figure jolts, then settles back into its drift. ----
      flinch = rig.damp(flinch, hurt, 16, dt || 0.016);
      if (flinch > 0.001) {
        torsoPivot.rotation.z += flinch * 0.28 * Math.sin(time * 32);
        torsoPivot.rotation.x -= flinch * 0.10;
        headPivot.rotation.x -= flinch * 0.18;
        strands.forEach((pivot, i) => {
          const outward = (i % 2 === 0 ? 1 : -1) * flinch * 0.35;
          pivot.rotation.x += outward;
          pivot.rotation.z += outward * 0.6;
        });
        unpickWisps.forEach((wispPivot, i) => {
          const outward = (i % 2 === 0 ? 1 : -1) * flinch * 0.4;
          wispPivot.rotation.x += outward;
        });
        const flinchScale = 1 + flinch * 0.06;
        torsoPivot.scale.x *= flinchScale;
        torsoPivot.scale.z *= flinchScale;
      }
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
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
    'cavity glowing cold violet at the sternum, orbited by two loose drifting ' +
    'threads. Below the waist it has no legs at all — the weave simply ' +
    'dissolves into a loose cluster of thread-grey-violet strands, trailed by ' +
    'a tattered back-drape, that drift and sway as it drags itself forward. ' +
    'One arm remains intact and doubles as its reaching attack; the other has ' +
    'unpicked itself into a spray of floating thread wisps that trail from ' +
    'the shoulder. Slow but heavy and hard to put down, The Unpicked shambles ' +
    'toward any Mender who strays too near the seams of Nevermend.',
};
