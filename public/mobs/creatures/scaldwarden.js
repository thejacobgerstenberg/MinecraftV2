import * as THREE from 'three';
import * as rig from '../anim/rig.js';

// ---------------------------------------------------------------------------
// SCALDWARDEN — a neutral Cinderloom forge-guardian.
// Archetype: forge-keeper (tall robed sentinel) — bound in an unfinished
// order, still patrolling the ember-spindles for a Weaver who never came
// back to release it. Loomfall lore: Scaldwardens ignore Menders entirely,
// murmuring low ceaseless reports to empty niches, unless a thief steals
// from the forges — then the deep hood's ember eyes flare and every warden
// within earshot answers as one. Passive by default; this module renders
// the idle/guardian silhouette plus a full provoked/attack/death rig.
//
// Silhouette goals: TALL, BROAD, HOODED robed figure, imposing and wider
// at the base like a heavy floor-length robe (no visible feet/legs). A
// deep, mostly-empty hood with a faint ember glow and a stepped crown
// silhouette (not a plain box hood). A cinched waist rope marks the join
// between torso and skirt. Two asymmetric cape drapes fall from the
// shoulders. A small ember charm swings at the collar. Molten crack-seams
// glow down the front and sides of the robe, and glow again faintly under
// the hem where embers leak onto the floor. Two heavy, mitt-like hands
// with glowing knuckle studs rest forward at the hem, holding nothing here
// (the spindle-stave is a combat prop, out of scope for this base model).
// ~1.7 units tall overall. NOT a Minecraft villager/piglin — broader,
// seam-cracked, caped, hood entirely dark but for pinpoint ember eyes.
// ---------------------------------------------------------------------------

const PALETTE = {
  robe: 0x8c1f1f,     // deep forge-red robe, main cloth
  fold: 0x5e1212,     // dark fold / hood-interior edge / cape
  seam: 0xd9803c,     // molten crack-seam, emissive
  shadow: 0x2e0a0a,   // near-black deep shadow / hood void
  ember: 0xf2c066,    // ember glow, emissive hood-light & seam highlights
};

function makeMaterials() {
  return {
    robe: new THREE.MeshStandardMaterial({
      color: PALETTE.robe,
      roughness: 0.85,
      metalness: 0.05,
    }),
    fold: new THREE.MeshStandardMaterial({
      color: PALETTE.fold,
      roughness: 0.9,
      metalness: 0.05,
    }),
    seam: new THREE.MeshStandardMaterial({
      color: PALETTE.seam,
      roughness: 0.4,
      metalness: 0.1,
      emissive: new THREE.Color(PALETTE.seam),
      emissiveIntensity: 0.85,
    }),
    shadow: new THREE.MeshStandardMaterial({
      color: PALETTE.shadow,
      roughness: 0.95,
      metalness: 0.0,
    }),
    ember: new THREE.MeshStandardMaterial({
      color: PALETTE.ember,
      roughness: 0.3,
      metalness: 0.05,
      emissive: new THREE.Color(PALETTE.ember),
      emissiveIntensity: 1.0,
    }),
  };
}

// Plain centered box mesh.
function box(w, h, d, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Box mesh whose origin sits at its TOP center, so it can hang off a joint
// pivot naturally — used for the robe skirt panels, sleeves, cape drapes,
// hood flaps and the ember charm chain.
function hangingBox(w, h, d, material) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(0, -h / 2, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Defensive numeric coercion — never let a missing/NaN state field poison a
// transform. Mirrors rig.js's internal guards for arithmetic that happens
// directly in this file (rig's own exports already self-guard).
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
  root.name = 'Scaldwarden';

  const mat = makeMaterials();
  const parts = {};

  // -------------------------------------------------------------------
  // BODY PIVOT — the whole figure sways from here for the slow, heavy
  // breathing idle and ponderous glide walk.
  // -------------------------------------------------------------------
  const bodyPivot = new THREE.Group();
  bodyPivot.position.set(0, 0, 0);
  root.add(bodyPivot);
  parts.bodyPivot = bodyPivot;

  // -------------------------------------------------------------------
  // ROBE SKIRT — a broad, floor-length, tiered skirt so no feet show and
  // the base reads wider than the shoulders. Five stacked, progressively
  // wider hanging tiers from hip height down to the floor, a glowing
  // ember vent leaking beneath the hem, and three asymmetric frayed
  // thread tips trailing off the bottom edge.
  // -------------------------------------------------------------------
  const skirtPivot = new THREE.Group();
  skirtPivot.position.set(0, 0.62, 0);
  bodyPivot.add(skirtPivot);

  const skirtTiers = [];
  const tierDefs = [
    { w: 0.58, h: 0.14, d: 0.40, y: 0.0, mat: mat.robe },
    { w: 0.66, h: 0.14, d: 0.46, y: -0.14, mat: mat.fold },
    { w: 0.74, h: 0.14, d: 0.52, y: -0.28, mat: mat.robe },
    { w: 0.82, h: 0.12, d: 0.58, y: -0.42, mat: mat.fold },
    { w: 0.90, h: 0.08, d: 0.64, y: -0.54, mat: mat.robe },
  ];
  tierDefs.forEach(({ w, h, d, y, mat: m }) => {
    const tier = box(w, h, d, m);
    tier.position.set(0, y - h / 2, 0);
    skirtPivot.add(tier);
    skirtTiers.push(tier);
  });
  parts.skirtTiers = skirtTiers;

  // Molten seam-cracks running down the front of the skirt (asymmetric
  // lengths/offsets so the crack pattern reads as organic, not tiled).
  const skirtSeamL = hangingBox(0.03, 0.60, 0.02, mat.seam);
  skirtSeamL.position.set(-0.14, 0.0, 0.24);
  skirtPivot.add(skirtSeamL);
  const skirtSeamR = hangingBox(0.03, 0.50, 0.02, mat.seam);
  skirtSeamR.position.set(0.17, -0.06, 0.25);
  skirtPivot.add(skirtSeamR);
  const skirtSeamC = hangingBox(0.02, 0.22, 0.02, mat.seam);
  skirtSeamC.position.set(0.02, -0.30, 0.30);
  skirtPivot.add(skirtSeamC);
  parts.skirtSeams = [skirtSeamL, skirtSeamR, skirtSeamC];

  // Glowing ember vent leaking out from beneath the hem, near the floor —
  // a small bright accent that pops the palette and reads at thumbnail.
  const hemVent = box(0.42, 0.02, 0.02, mat.ember);
  hemVent.position.set(0.02, -0.61, 0.32);
  skirtPivot.add(hemVent);
  parts.hemVent = hemVent;

  // Frayed thread tips notched into the bottom hem edge, asymmetric
  // lengths/offsets. Built as centered boxes flush with the hem's own
  // bottom face (never hanging past it) so the robe's lowest point stays
  // exactly at the ground plane (feet-at-y=0), reading as ragged fringe
  // rather than a clipping dangle.
  const threadA = box(0.02, 0.05, 0.02, mat.seam);
  threadA.position.set(-0.24, -0.595, 0.30);
  skirtPivot.add(threadA);
  const threadB = box(0.018, 0.03, 0.018, mat.seam);
  threadB.position.set(0.06, -0.605, 0.31);
  skirtPivot.add(threadB);
  const threadC = box(0.02, 0.07, 0.02, mat.seam);
  threadC.position.set(0.32, -0.585, 0.28);
  skirtPivot.add(threadC);
  parts.hemThreads = [threadA, threadB, threadC];

  // Beveled hem corners — 45°-rotated wedge blocks at the front corners
  // of the two widest (lowest) tiers. Every prior edge in the skirt was
  // axis-aligned, so the hem read as crisp rectangular steps rather than
  // a cut/draped robe edge; these diagonal corners break that without
  // touching the tiers' own grounded, non-tilting geometry.
  const hemBevelDefs = [
    { w: 0.16, y: -0.48, xOff: 0.35, zOff: 0.23 },
    { w: 0.18, y: -0.58, xOff: 0.39, zOff: 0.26 },
  ];
  const hemBevels = [];
  hemBevelDefs.forEach(({ w, y, xOff, zOff }) => {
    [-1, 1].forEach((side) => {
      const bevel = box(w, 0.10, w, mat.fold);
      bevel.position.set(side * xOff, y, zOff);
      bevel.rotation.y = Math.PI / 4;
      skirtPivot.add(bevel);
      hemBevels.push(bevel);
    });
  });
  parts.hemBevels = hemBevels;

  // -------------------------------------------------------------------
  // WAIST CINCH — a rope-like band marking the join between torso and
  // skirt, with an off-center knot for a hand-tied, asymmetric read.
  // -------------------------------------------------------------------
  const waistCinch = box(0.54, 0.05, 0.38, mat.seam);
  waistCinch.position.set(0, 0.60, 0);
  bodyPivot.add(waistCinch);
  const waistKnot = box(0.07, 0.07, 0.07, mat.seam);
  waistKnot.position.set(0.17, 0.60, 0.20);
  bodyPivot.add(waistKnot);
  parts.waistCinch = waistCinch;
  parts.waistKnot = waistKnot;

  // -------------------------------------------------------------------
  // TORSO — a heavy, broad-shouldered mass above the waist cinch,
  // sloping outward slightly at the base to blend into the robe's bulk.
  // -------------------------------------------------------------------
  const torsoPivot = new THREE.Group();
  torsoPivot.position.set(0, 0.62, 0);
  bodyPivot.add(torsoPivot);

  const torsoLower = box(0.52, 0.26, 0.36, mat.robe);
  torsoLower.position.set(0, 0.13, 0);
  torsoPivot.add(torsoLower);

  const torsoUpper = box(0.46, 0.24, 0.32, mat.robe);
  torsoUpper.position.set(0, 0.36, 0);
  torsoPivot.add(torsoUpper);

  const chestSeam = box(0.045, 0.42, 0.02, mat.seam);
  chestSeam.position.set(0, 0.26, 0.185);
  torsoPivot.add(chestSeam);

  // A second, shorter branching crack breaks the strict-vertical read of
  // the main chest seam and adds molten-crack texture.
  const chestSeamBranch = box(0.03, 0.20, 0.02, mat.seam);
  chestSeamBranch.position.set(-0.13, 0.30, 0.165);
  chestSeamBranch.rotation.z = 0.4;
  torsoPivot.add(chestSeamBranch);

  const shoulderYoke = box(0.58, 0.10, 0.34, mat.fold);
  shoulderYoke.position.set(0, 0.49, 0);
  torsoPivot.add(shoulderYoke);

  // Pauldrons — angled shoulder caps that jut past the sleeve width on
  // BOTH sides, symmetrically. Previously the only silhouette protrusion
  // was the single off-center waist knot, so the figure read as a plain
  // tapering stack from most angles; these give the shoulder line its own
  // clear, two-sided bump, and the 0.18rad cant on each keeps their edges
  // off-axis instead of adding more purely rectilinear blocks.
  const pauldronL = box(0.22, 0.09, 0.24, mat.fold);
  pauldronL.position.set(-0.34, 0.505, 0.01);
  pauldronL.rotation.z = 0.18;
  torsoPivot.add(pauldronL);
  const pauldronR = box(0.22, 0.09, 0.24, mat.fold);
  pauldronR.position.set(0.34, 0.505, 0.01);
  pauldronR.rotation.z = -0.18;
  torsoPivot.add(pauldronR);

  // Ember pauldron studs — small glowing rivets on top of each pauldron,
  // a bright thumbnail-scale accent that pops the palette.
  const studL = box(0.06, 0.05, 0.06, mat.ember);
  studL.position.set(-0.34, 0.555, 0.03);
  torsoPivot.add(studL);
  const studR = box(0.06, 0.05, 0.06, mat.ember);
  studR.position.set(0.34, 0.555, 0.03);
  torsoPivot.add(studR);

  parts.torsoPivot = torsoPivot;
  parts.chestSeam = chestSeam;
  parts.chestSeamBranch = chestSeamBranch;
  parts.pauldrons = [pauldronL, pauldronR];
  parts.shoulderStuds = [studL, studR];

  // -------------------------------------------------------------------
  // EMBER CHARM — a small chain + glowing bead swinging at the collar,
  // a distinctly Loomfall/textile detail (a spindle-charm, not a medal).
  // -------------------------------------------------------------------
  const charmPivot = new THREE.Group();
  charmPivot.position.set(0, 0.50, 0.20);
  torsoPivot.add(charmPivot);
  const charmChain = hangingBox(0.02, 0.11, 0.02, mat.seam);
  charmPivot.add(charmChain);
  const charmBead = box(0.05, 0.05, 0.05, mat.ember);
  charmBead.position.set(0, -0.13, 0);
  charmPivot.add(charmBead);
  parts.charmPivot = charmPivot;
  parts.charmBead = charmBead;

  // -------------------------------------------------------------------
  // CAPE DRAPES — two asymmetric panels falling from the back of the
  // shoulder yoke, adding height/depth to the silhouette from every
  // angle and reading distinctly non-Minecraft (villagers have no cape).
  // -------------------------------------------------------------------
  const capeL = hangingBox(0.16, 0.48, 0.05, mat.fold);
  capeL.position.set(-0.17, 0.49, -0.17);
  capeL.rotation.x = -0.08;
  capeL.rotation.z = 0.05;
  torsoPivot.add(capeL);
  const capeR = hangingBox(0.16, 0.38, 0.05, mat.robe);
  capeR.position.set(0.17, 0.49, -0.17);
  capeR.rotation.x = -0.06;
  capeR.rotation.z = -0.04;
  torsoPivot.add(capeR);
  parts.capeL = capeL;
  parts.capeR = capeR;

  // -------------------------------------------------------------------
  // HOOD/HEAD — a deep, mostly-empty hood, dark inside but for a faint
  // ember glow and two pinpoint eyes, topped with a stepped crown
  // silhouette instead of a plain peaked box, plus drooping side flaps.
  // -------------------------------------------------------------------
  // Neck gap — a narrow, recessed shadow band between the shoulder yoke
  // and the hood. Without it the hood was just the next, slightly-smaller
  // box in an unbroken taper; this visible undercut (narrower than both
  // the yoke below and the hood above) reads as an actual joint, so the
  // hood registers as its own floating volume instead of the top of the
  // torso column.
  const neckGap = box(0.20, 0.06, 0.18, mat.shadow);
  neckGap.position.set(0, 0.545, -0.01);
  torsoPivot.add(neckGap);
  parts.neckGap = neckGap;

  const hoodPivot = new THREE.Group();
  hoodPivot.position.set(0, 0.56, 0.0);
  torsoPivot.add(hoodPivot);

  // Cowl collar — a flared lip at the hood's base, WIDER than the hood
  // box that sits above it. This gives the hood a proper cowl taper
  // (flare-then-narrow) rather than just narrowing monotonically with
  // everything below it, and its own material tone keeps it from reading
  // as one continuous poured shape with the hood box above.
  const hoodCollar = box(0.48, 0.08, 0.36, mat.fold);
  hoodCollar.position.set(0, 0.02, -0.02);
  hoodPivot.add(hoodCollar);
  parts.hoodCollar = hoodCollar;

  const hoodOuter = box(0.40, 0.36, 0.38, mat.fold);
  hoodOuter.position.set(0, 0.18, -0.02);
  hoodPivot.add(hoodOuter);

  // Hood void — deep near-black interior, inset so the outer hood reads
  // as an overhanging cowl.
  const hoodVoid = box(0.29, 0.27, 0.20, mat.shadow);
  hoodVoid.position.set(0, 0.16, 0.11);
  hoodPivot.add(hoodVoid);

  // Faint ember glow deep in the hood.
  const hoodGlow = box(0.15, 0.10, 0.04, mat.ember);
  hoodGlow.position.set(0, 0.15, 0.19);
  hoodPivot.add(hoodGlow);

  // Two pinpoint ember eyes.
  const eyeL = box(0.035, 0.035, 0.02, mat.ember);
  eyeL.position.set(-0.07, 0.17, 0.20);
  hoodPivot.add(eyeL);
  const eyeR = box(0.035, 0.035, 0.02, mat.ember);
  eyeR.position.set(0.07, 0.17, 0.20);
  hoodPivot.add(eyeR);

  // Brow ridge — a dark bar carved into the void just above the eyes, so
  // the hood interior reads as a socketed face rather than a flat panel
  // with two glow-dots floating on it.
  const browRidge = box(0.24, 0.035, 0.05, mat.shadow);
  browRidge.position.set(0, 0.205, 0.205);
  hoodPivot.add(browRidge);
  parts.browRidge = browRidge;

  // Stepped crown, rising behind the hood in two tiers — a distinct,
  // non-Minecraft silhouette read from every angle.
  const hoodPeak = box(0.20, 0.10, 0.16, mat.fold);
  hoodPeak.position.set(0, 0.37, -0.05);
  hoodPivot.add(hoodPeak);
  const hoodRidge = box(0.10, 0.10, 0.09, mat.shadow);
  hoodRidge.position.set(0, 0.46, -0.07);
  hoodPivot.add(hoodRidge);

  // Drooping hood side-flaps down past the shoulder line, breaking the
  // boxy hood read and giving the sway animation somewhere to live.
  const hoodFlapL = hangingBox(0.05, 0.22, 0.17, mat.fold);
  hoodFlapL.position.set(-0.20, 0.28, 0.0);
  hoodPivot.add(hoodFlapL);
  const hoodFlapR = hangingBox(0.05, 0.22, 0.17, mat.fold);
  hoodFlapR.position.set(0.20, 0.28, 0.0);
  hoodPivot.add(hoodFlapR);

  parts.hoodPivot = hoodPivot;
  parts.hoodGlow = hoodGlow;
  parts.eyes = [eyeL, eyeR];
  parts.hoodFlaps = [hoodFlapL, hoodFlapR];

  // Head anchor for name tags — above the stepped crown's top.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 1.72, 0.0);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // ARMS/SLEEVES — heavy, wide sleeves hanging from the shoulders, each
  // ending in a mitt-like hand resting forward at the hem, with a seam
  // cuff trim and a glowing knuckle stud for secondary detail.
  // -------------------------------------------------------------------
  function buildArm(x, parent) {
    const shoulderPivot = new THREE.Group();
    shoulderPivot.position.set(x, 0.47, 0);
    parent.add(shoulderPivot);

    const sleeveUpper = hangingBox(0.17, 0.28, 0.19, mat.robe);
    shoulderPivot.add(sleeveUpper);

    const elbowPivot = new THREE.Group();
    elbowPivot.position.set(0, -0.28, 0.02);
    shoulderPivot.add(elbowPivot);

    const sleeveLower = hangingBox(0.16, 0.24, 0.18, mat.fold);
    elbowPivot.add(sleeveLower);
    // rotate forward slightly so the sleeve reaches toward the front hem
    elbowPivot.rotation.x = 0.32;

    const cuff = box(0.17, 0.04, 0.19, mat.seam);
    cuff.position.set(0, -0.24, 0.02);
    elbowPivot.add(cuff);

    const mitt = box(0.17, 0.12, 0.17, mat.shadow);
    mitt.position.set(0, -0.29, 0.05);
    elbowPivot.add(mitt);

    const mittSeam = box(0.03, 0.03, 0.15, mat.seam);
    mittSeam.position.set(0, -0.23, 0.05);
    elbowPivot.add(mittSeam);

    const knuckleStud = box(0.05, 0.035, 0.05, mat.ember);
    knuckleStud.position.set(0, -0.235, 0.10);
    elbowPivot.add(knuckleStud);

    return {
      shoulderPivot, elbowPivot, sleeveUpper, sleeveLower, cuff, mitt, mittSeam, knuckleStud,
      side: x < 0 ? -1 : 1,
    };
  }

  const armL = buildArm(-0.32, torsoPivot);
  const armR = buildArm(0.32, torsoPivot);
  parts.armL = armL;
  parts.armR = armR;

  // -------------------------------------------------------------------
  // Store all animated sub-parts for animate() to reach.
  // -------------------------------------------------------------------
  root.userData.parts = parts;

  // Baked rest rotations (permanent rest poses set at build time above) —
  // animate() re-derives from these every frame rather than accumulating,
  // so state can never drift/compound across frames.
  const REST_ELBOW_X = 0.32;
  const REST_CAPE_L = { x: -0.08, z: 0.05 };
  const REST_CAPE_R = { x: -0.06, z: -0.04 };
  // Static outward cant on both sleeves — a symmetric diagonal break in
  // what was otherwise two parallel vertical columns flanking the torso,
  // so the arm silhouette bulges on BOTH sides at every camera angle
  // rather than only whichever arm happens to catch the light/pose.
  const REST_SHOULDER_Z = 0.09;
  // Static forward cowl tilt — keeps the hood's top edge off-axis from
  // the torso's verticals instead of stacking as a perfectly plumb box.
  const REST_HOOD_TILT = 0.09;

  // -------------------------------------------------------------------
  // ANIMATION — built on mobs/anim/rig.js's procedural-motion helpers.
  // Idle:      rig.breathe drives a slow, heavy breathing scale on the
  //            torso and a matching hood bob; rig.sway independently
  //            drifts the cape drapes, hood flaps and ember charm so the
  //            figure never reads as frozen even standing still.
  // Walk:      a ponderous glide — no legs, no visible feet ever. The
  //            whole robe sways side-to-side and bobs on footfall-less
  //            "steps"; rig.walkPhase (repurposed limb-less, driving the
  //            two sleeves as its per-limb channels) and the hem tiers
  //            lag behind the sway for a heavy-cloth read, amplitude and
  //            cadence scaled by state.speed01 so it never sways at full
  //            amplitude while standing still.
  // Telegraph: rig.windUp pulls both mitts up and back into a raised
  //            guardian warning pose as state.telegraph builds; the hood
  //            glow and eyes flare brighter in anticipation.
  // Attack:    rig.strike whips both arms down/forward into a slam as
  //            state.attack fires, with a bright seam/ember flash timed
  //            to the impact.
  // Hurt:      a stiff robed flinch (torso/hood jolt) with a brief,
  //            fast-decaying seam flare — this is also the moment a
  //            Scaldwarden becomes provoked in the wider game logic.
  // Death:     rig.dissolve unravels the whole figure — skirt tiers,
  //            cape, hood flaps, charm and sleeves splay outward while
  //            the body sinks and shrinks and every ember gutters dark.
  //            No gore — just a forge going cold and its threads coming
  //            apart.
  // Turn:      body banks into state.turn (signed yaw rate), damped.
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

      // Slow, heavy breathing — always active (subtler while dissolving).
      const breathAmt = rig.breathe(time, 1.3, 0.5) * (1 - dying);
      torsoPivot.scale.set(1 + breathAmt * 0.5, 1 + breathAmt * 1.0, 1 + breathAmt * 0.5);
      hoodPivot.position.y = 0.56 + breathAmt * 0.12;

      // Base seam / ember glow pulse — a slow forge-heartbeat.
      const pulse = 0.5 + Math.sin(time * 1.6) * 0.5; // 0..1
      let seamIntensity = 0.55 + pulse * 0.45;
      let emberIntensity = 0.75 + pulse * 0.45;

      // Lean into turns — damped so the bank never snaps.
      const leanTarget = dying > 0 ? 0 : Math.max(-0.22, Math.min(0.22, -turn * 0.14));
      lean = rig.damp(lean, leanTarget, 6, dt);

      if (dying > 0) {
        // --- DEATH: thread-unravel dissolve, no gore ---
        const d = rig.dissolve(dying);
        const sc = Math.max(0.03, d.scale);
        root.scale.set(sc, sc, sc);
        root.position.y = -d.drop * 0.7;

        bodyPivot.rotation.z = lean;

        skirtTiers.forEach((tier, i) => {
          const sign = i % 2 === 0 ? 1 : -1;
          tier.rotation.z = sign * d.spread * (0.25 + i * 0.05);
          tier.rotation.x = d.spread * 0.12;
        });

        torsoPivot.rotation.x = d.spread * 0.18;
        hoodPivot.rotation.x = -d.spread * 0.3;
        hoodPivot.rotation.z = d.spread * 0.2;
        hoodFlapL.rotation.x = -d.spread * 0.9;
        hoodFlapR.rotation.x = -d.spread * 0.9;

        capeL.rotation.x = REST_CAPE_L.x - d.spread * 1.0;
        capeL.rotation.z = REST_CAPE_L.z - d.spread * 0.7;
        capeR.rotation.x = REST_CAPE_R.x - d.spread * 0.9;
        capeR.rotation.z = REST_CAPE_R.z + d.spread * 0.7;

        charmPivot.rotation.x = d.spread * 1.1;
        charmPivot.rotation.z = d.spread * 0.6;

        armL.shoulderPivot.rotation.x = -0.2 - d.spread * 0.8;
        armL.shoulderPivot.rotation.z = -REST_SHOULDER_Z - d.spread * 0.8;
        armR.shoulderPivot.rotation.x = -0.2 - d.spread * 0.8;
        armR.shoulderPivot.rotation.z = REST_SHOULDER_Z + d.spread * 0.8;
        armL.elbowPivot.rotation.x = REST_ELBOW_X + d.spread * 0.6;
        armR.elbowPivot.rotation.x = REST_ELBOW_X + d.spread * 0.6;

        // Every ember gutters dark as the forge goes cold.
        const dim = Math.max(0, 1 - dying);
        mat.seam.emissiveIntensity = 0.85 * dim;
        mat.ember.emissiveIntensity = 1.0 * dim;
        return; // death pose overrides everything below
      }

      // Reset root scale/position in case a previous frame was mid-dissolve
      // and the mob got revived/recycled (defensive; animate() must never
      // assume ordering with the manager's own removal timing).
      if (root.scale.x !== 1) root.scale.set(1, 1, 1);
      if (root.position.y !== 0) root.position.y = 0;

      // ---- Ponderous glide, driven by rig.walkPhase (no legs — its
      // per-limb channels drive the two sleeves instead) ----
      const wp = rig.walkPhase(time, speed01, 0.5);
      const idleAmt = 1 - speed01;
      const glide = time * 0.9;

      // bodyPivot itself only ever translates (small footfall-less bob and
      // drift) — the grounded, floor-length hem must never tilt/lift off
      // the ground plane, so all glide/lean ROTATION is carried by
      // torsoPivot instead, well above the skirt.
      bodyPivot.position.y = wp.lift * 0.028 * (grounded ? 1 : 0.3) + Math.sin(time * 0.9) * 0.006 * idleAmt;
      bodyPivot.position.x = Math.sin(glide) * 0.014 * speed01;
      const glideSway = Math.sin(glide) * 0.06 * speed01;

      // Hem tiers lag behind the sway for a heavy-cloth feel, drifting
      // gently even at a standstill.
      skirtTiers.forEach((tier, i) => {
        tier.rotation.z = Math.sin(glide * 1.8 - i * 0.5) * 0.045 * speed01
          + rig.sway(time, 0.35, 0.6, i * 0.8) * idleAmt;
      });
      hemVent.material.emissiveIntensity = emberIntensity * 0.8;

      // Cape drapes and hood flaps drift independently, always alive.
      capeL.rotation.x = REST_CAPE_L.x + rig.sway(time, 1, 0.7, 0.2) * 0.6
        - wp.FL * 0.12;
      capeL.rotation.z = REST_CAPE_L.z + rig.sway(time, 0.6, 0.9, 1.4) * 0.5;
      capeR.rotation.x = REST_CAPE_R.x + rig.sway(time, 1, 0.75, 2.1) * 0.6
        - wp.FR * 0.12;
      capeR.rotation.z = REST_CAPE_R.z + rig.sway(time, 0.6, 0.85, 3.0) * 0.5;
      hoodFlapL.rotation.x = rig.sway(time, 0.8, 0.6, 0.5) * 0.4;
      hoodFlapR.rotation.x = rig.sway(time, 0.8, 0.65, 2.7) * 0.4;

      // Ember charm swings like a pendulum, quickening slightly with pace.
      charmPivot.rotation.x = rig.sway(time, 1, 1.1 + speed01 * 0.6, 0.9) * 0.9;
      charmPivot.rotation.z = rig.sway(time, 0.7, 0.9 + speed01 * 0.4, 2.2) * 0.7;

      // ---- Sleeve swing (per-limb, scaled by speed01) with telegraph /
      // strike overlay ----
      const idleSwayL = rig.sway(time, 1, 1, 0.3);
      const idleSwayR = rig.sway(time, 1, 1.1, 2.1);
      const armSwingL = wp.FL * 0.55 + idleSwayL * idleAmt * 0.6;
      const armSwingR = wp.FR * 0.55 + idleSwayR * idleAmt * 0.6;

      const attackActive = telegraph > 0 || attack > 0;
      if (attackActive) {
        const windAmt = rig.windUp(telegraph); // 0 -> ~-1.1 -> -1
        const strikeAmt = rig.strike(attack); // 0 -> 1, fast release
        const blend = Math.max(telegraph, attack);
        // Wind-up raises both mitts in warning; the strike slams them
        // forward/down together as a guardian's warning becomes a blow.
        const driveX = attack > 0 ? -0.55 + strikeAmt * 1.35 : windAmt * 0.9;
        armL.shoulderPivot.rotation.x = armSwingL * (1 - blend) + driveX;
        armR.shoulderPivot.rotation.x = armSwingR * (1 - blend) + driveX;
        armL.shoulderPivot.rotation.z = -REST_SHOULDER_Z * (1 - blend) - blend * 0.12;
        armR.shoulderPivot.rotation.z = REST_SHOULDER_Z * (1 - blend) + blend * 0.12;
        armL.elbowPivot.rotation.x = REST_ELBOW_X * (1 - blend * 0.4)
          + Math.max(0, driveX) * 0.5;
        armR.elbowPivot.rotation.x = REST_ELBOW_X * (1 - blend * 0.4)
          + Math.max(0, driveX) * 0.5;

        // Warning flare — hood glow, eyes and knuckle studs brighten.
        hoodGlow.material.emissiveIntensity = 1.0 + blend * 1.1;
        seamIntensity += blend * 0.5;
        emberIntensity += blend * 0.7;
      } else {
        armL.shoulderPivot.rotation.x = armSwingL;
        armR.shoulderPivot.rotation.x = armSwingR;
        armL.shoulderPivot.rotation.z = -REST_SHOULDER_Z;
        armR.shoulderPivot.rotation.z = REST_SHOULDER_Z;
        armL.elbowPivot.rotation.x = REST_ELBOW_X;
        armR.elbowPivot.rotation.x = REST_ELBOW_X;
        hoodGlow.material.emissiveIntensity = emberIntensity;
      }

      // ---- Torso / hood: ponderous glide sway + breathing nod + turn
      // lean, all carried above the grounded, non-tilting skirt ----
      torsoPivot.rotation.z = glideSway + lean * 0.6;
      torsoPivot.rotation.y = lean * 0.7;
      hoodPivot.rotation.x = REST_HOOD_TILT + breathAmt * 0.4;
      hoodPivot.rotation.y = lean * 0.5;

      // ---- Hurt flinch: sharp, fast-decaying jolt with a seam flare ----
      flinch = rig.damp(flinch, hurt, 18, dt);
      if (flinch > 0.001) {
        torsoPivot.rotation.z += flinch * 0.16 * Math.sin(time * 30);
        torsoPivot.rotation.x = -flinch * 0.08;
        hoodPivot.rotation.x -= flinch * 0.14;
        seamIntensity += flinch * 0.9;
        emberIntensity += flinch * 0.6;
      } else {
        torsoPivot.rotation.x = 0;
      }

      mat.seam.emissiveIntensity = seamIntensity;
      mat.ember.emissiveIntensity = emberIntensity;
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
    }
  };

  return root;
}

export const meta = {
  archetype: 'forge-keeper',
  species: 'Scaldwarden',
  canonicalId: 'scaldwarden',
  dimensionDefault: 'cinderloom',
  palette: {
    robe: '#8C1F1F',
    fold: '#5E1212',
    seam: '#D9803C',
    shadow: '#2E0A0A',
    ember: '#F2C066',
  },
  description:
    'A tall, broad, hooded forge-keeper bound to patrol the ember-spindles ' +
    'of Cinderloom for a Weaver who never came back to release it. Its ' +
    'floor-length forge-red robe flares wide at the base so no feet ever ' +
    'show, cinched at the waist by a rough-tied rope, with molten ' +
    'crack-seams glowing like stitching down its front and sleeves and ' +
    'leaking faint ember-light beneath its hem. A small ember charm swings ' +
    'at its collar and two asymmetric cape drapes fall from its shoulders. ' +
    'The deep hood is almost entirely dark, but for a faint ember glow and ' +
    'two pinpoint eyes watching the niches it murmurs reports to. It ' +
    'ignores Menders entirely and never attacks unprovoked — until ' +
    'something is taken from its forge, at which point its glow flares and ' +
    'its heavy mitt-like hands rise in warning before slamming down. Its ' +
    'ceaseless, purposeless diligence is the most heartbreaking sight in ' +
    'the underworld.',
};
