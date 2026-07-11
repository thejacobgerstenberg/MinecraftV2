import * as THREE from 'three';
import * as rig from '../anim/rig.js';

// ============================================================================
// SELVAGE WARDEN — Nevermend mini-boss, silent hem-thread guardian of the
// Last Selvage. Loomfall lore: where the great cloth of the world frays out
// into the void, the Loom binds off the raw edge with a warden woven from
// the hem itself — a tall, faceless sentinel of pale bound cloth that never
// speaks and never truly falls. Every wound reopens as a torn seam and is
// visibly RE-STITCHED moments later, the warden self-mending in slow
// shimmering pulses along its bands. It is bone/parchment pale, not dark —
// a keeper, not a horror. Broad squared shoulders draped in a short mantle,
// a wrapped hem-seamed torso banded with visible stitching, a smooth
// featureless cowled head peaked behind like a folded hood, two heavy
// bound-thread arms (the right forearm IS a broad flat hem-blade wound with
// a hilt-wrap), a wound thread-spool charm at the belt, a trailing hem
// drape at the back, and a wrapped, banded lower body finished in heavy
// thread-bound boots. Bulky and statuesque — a keeper of the edge, not a
// horror.
// ============================================================================

// ---- Palette (canonical Selvage Warden bestiary palette) ------------------
const PALETTE = {
  hemCloth: 0xe8dfc8,   // pale hem-cloth — main body mass
  tan: 0xc9b98c,        // tan — secondary cloth wrap
  seam: 0x8c7b52,       // darker seam — hem-seam bands, stitching, wraps
  highlight: 0xf7f2e4,  // near-white — re-stitch shimmer / highlights
  voidRecess: 0x3a3220, // deep — cowl interior / recesses
  warm: 0xd4c7a3,       // warm — blade + accent wraps + charms
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
    // base is a soft glow (raised from a flat 0.25 so the self-mending rim
    // cue reads even on a static/off-cycle frame, not only mid-pulse),
    // with brief pulses pushing it brighter along the seams.
    highlight: new THREE.MeshStandardMaterial({
      color: PALETTE.highlight,
      roughness: 0.35,
      metalness: 0.05,
      emissive: new THREE.Color(PALETTE.highlight),
      emissiveIntensity: 0.4,
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

// Plain centered box mesh.
function box(w, h, d, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Box mesh whose origin sits at its TOP center, for hanging off joint pivots
// (drapes, tassels, wraps, blade shaft).
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
  root.name = 'Selvage Wardens';

  const mat = makeMaterials();
  const parts = {};

  // Leg reach determines hip height so feet land exactly at y=0 — the
  // lower-leg hangingBox always bottoms out at kneePivot's LOWER_LEG-length
  // travel regardless of the exact leg lengths chosen, and the boot's
  // centered box is offset identically, so both stay pinned to the ground
  // plane even as the warden's stance is tuned taller/heavier.
  const UPPER_LEG = 0.45;
  const LOWER_LEG = 0.43;
  const HIP_Y = UPPER_LEG + LOWER_LEG; // 0.88

  // ---- Legs: heavy wrapped-cloth boots and thread-bound shins -------------
  function buildLeg(x, mirror) {
    const hipPivot = new THREE.Group();
    hipPivot.position.set(x, 0, 0);
    root.add(hipPivot);

    const upperLeg = hangingBox(0.25, UPPER_LEG, 0.23, mat.hemCloth);
    hipPivot.add(upperLeg);

    const kneePivot = new THREE.Group();
    kneePivot.position.set(0, -UPPER_LEG, 0);
    hipPivot.add(kneePivot);

    const lowerLeg = hangingBox(0.21, LOWER_LEG, 0.2, mat.tan);
    kneePivot.add(lowerLeg);

    // Thread-wrap band cinched mid-shin — secondary detail that also sells
    // the "bound hem-thread" read at a glance.
    const shinWrap = box(0.23, 0.045, 0.21, mat.seam);
    shinWrap.position.set(0, -LOWER_LEG * 0.5, 0);
    kneePivot.add(shinWrap);

    const boot = box(0.24, 0.12, 0.28, mat.seam);
    boot.position.set(0, -LOWER_LEG + 0.02, 0.03);
    kneePivot.add(boot);

    // Bound wrap-cuff at the boot top — a distinct band with its own small
    // stitch mark, so the boot reads as thread-bound cloth wound around the
    // shin rather than a molded plate-armor boot in a second flat color.
    const bootCuff = box(0.255, 0.055, 0.29, mat.tan);
    bootCuff.position.set(0, -LOWER_LEG + 0.075, 0.03);
    kneePivot.add(bootCuff);
    const bootCuffStitch = box(0.02, 0.05, 0.015, mat.warm);
    bootCuffStitch.position.set(mirror * -0.09, -LOWER_LEG + 0.075, 0.175);
    bootCuffStitch.rotation.z = mirror * 0.5;
    kneePivot.add(bootCuffStitch);

    // Toe cap — a separate lighter block breaking the boot into two
    // readable masses (cap + heel) instead of one flat slab, angled down
    // slightly like a worn cloth-wrapped toe.
    const toeCap = box(0.2, 0.09, 0.1, mat.tan);
    toeCap.position.set(0, -LOWER_LEG - 0.01, 0.16);
    toeCap.rotation.x = 0.12;
    kneePivot.add(toeCap);

    // Frayed cuff fringe — two short loose threads off the cuff, plus the
    // heel tail, so every boot carries visible frayed-hem geometry, not
    // just the heel.
    const cuffFrayA = hangingBox(0.02, 0.06, 0.02, mat.warm);
    cuffFrayA.position.set(-0.09, -LOWER_LEG + 0.05, 0.16);
    kneePivot.add(cuffFrayA);
    const cuffFrayB = hangingBox(0.02, 0.08, 0.02, mat.seam);
    cuffFrayB.position.set(0.08, -LOWER_LEG + 0.05, 0.16);
    kneePivot.add(cuffFrayB);

    // Short frayed thread tail off the heel — small, reads at thumbnail
    // scale as loose hem-fringe without ever dipping below y=0.
    const heelFray = box(0.03, 0.07, 0.03, mat.warm);
    heelFray.position.set(mirror * 0.02, -LOWER_LEG + 0.01, -0.14);
    kneePivot.add(heelFray);

    // Re-stitch shimmer strip over the shin wrap — own clone of
    // mat.highlight (never the shared instance) so animate() can pulse it
    // independently, extending the self-mend shimmer network down onto the
    // legs instead of leaving it confined to the torso.
    const legShimmer = box(0.235, 0.014, 0.205, mat.highlight.clone());
    legShimmer.position.set(0, -LOWER_LEG * 0.5 + 0.026, 0);
    kneePivot.add(legShimmer);

    return {
      hipPivot, kneePivot, upperLeg, lowerLeg, shinWrap, boot, heelFray,
      bootCuff, bootCuffStitch, toeCap, cuffFrayA, cuffFrayB, legShimmer,
    };
  }

  const legsGroup = new THREE.Group();
  legsGroup.position.set(0, HIP_Y, 0);
  root.add(legsGroup);
  const legL = buildLeg(-0.2, -1);
  const legR = buildLeg(0.2, 1);
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

  // Bound thread-spool charm at the belt — a small wound-thread spool
  // hanging a short loose tail, a distinctly textile secondary detail.
  const spoolPivot = new THREE.Group();
  spoolPivot.position.set(-0.24, 0.13, 0.16);
  torsoPivot.add(spoolPivot);
  const spoolCore = box(0.05, 0.08, 0.05, mat.tan);
  spoolPivot.add(spoolCore);
  const spoolBandTop = box(0.065, 0.018, 0.065, mat.seam);
  spoolBandTop.position.set(0, 0.035, 0);
  spoolPivot.add(spoolBandTop);
  const spoolBandBottom = box(0.065, 0.018, 0.065, mat.seam);
  spoolBandBottom.position.set(0, -0.035, 0);
  spoolPivot.add(spoolBandBottom);
  const spoolThread = hangingBox(0.012, 0.09, 0.012, mat.warm);
  spoolThread.position.set(0, -0.044, 0);
  spoolPivot.add(spoolThread);
  parts.spoolPivot = spoolPivot;
  parts.spoolThread = spoolThread;

  // Frayed waist tassels — three loose hem-threads of varied length hanging
  // just below the waist seam, a small silhouette-breaking detail that also
  // gives the sway animation somewhere lively to live.
  const tasselDefs = [
    { x: -0.09, len: 0.2, mat: mat.seam },
    { x: 0.04, len: 0.27, mat: mat.warm },
    { x: 0.15, len: 0.16, mat: mat.seam },
  ];
  const tassels = tasselDefs.map((td) => {
    const t = hangingBox(0.02, td.len, 0.02, td.mat);
    t.position.set(td.x, 0.02, 0.15);
    torsoPivot.add(t);
    return t;
  });
  parts.tassels = tassels;

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

  // Stitched cross-seam accent over the chest — two thin diagonal stitches
  // forming a small X, a bit of hand-mended character that reads clearly
  // even at thumbnail scale.
  const stitchA = box(0.03, 0.22, 0.02, mat.warm);
  stitchA.position.set(0, 0.72, 0.165);
  stitchA.rotation.z = 0.55;
  torsoPivot.add(stitchA);
  const stitchB = box(0.03, 0.22, 0.02, mat.warm);
  stitchB.position.set(0, 0.72, 0.165);
  stitchB.rotation.z = -0.55;
  torsoPivot.add(stitchB);
  parts.chestStitch = [stitchA, stitchB];

  // Re-stitch shimmer strips — thin near-white bands laid over the main
  // hem-seams; animate() pulses their emissive intensity to read as
  // periodic self-mending flashes traveling up the body.
  const restitchDefs = [
    { y: 0.19, w: 0.2, h: 0.02, d: 0.3 },
    { y: 0.55, w: 0.24, h: 0.02, d: 0.32 },
    { y: 0.88, w: 0.28, h: 0.02, d: 0.34 },
  ];
  // Each strip gets its OWN clone of mat.highlight (not the shared
  // instance) so animate() can pulse them independently for a genuinely
  // staggered shimmer — sharing one material here would make every strip
  // (and anything else built from it) flash in lockstep instead.
  // `let` (not `const`): the head/leg shimmer strips built later get
  // concatenated in below so the whole body shares one pulsing network.
  let restitchStrips = restitchDefs.map((r) => {
    const strip = box(r.w, r.h, r.d, mat.highlight.clone());
    strip.position.set(0, r.y + 0.005, 0);
    torsoPivot.add(strip);
    return strip;
  });

  // Trailing hem drape off the back — a short hanging cloth train that
  // breaks up the torso's boxy rear silhouette and gives idle/walk sway
  // somewhere textile-specific to read from behind.
  const backDrape = hangingBox(0.3, 0.32, 0.06, mat.hemCloth);
  backDrape.position.set(0, 0.56, -0.17);
  backDrape.rotation.x = -0.08;
  torsoPivot.add(backDrape);
  const backDrapeHem = box(0.31, 0.03, 0.07, mat.seam);
  backDrapeHem.position.set(0, 0.24, -0.19);
  torsoPivot.add(backDrapeHem);
  parts.backDrape = backDrape;
  parts.backDrapeHem = backDrapeHem;

  // Broad squared shoulders — pauldron-like blocks with a thin highlight
  // trim edge and a short mantle drape falling off the back of each.
  const shoulderL = box(0.22, 0.19, 0.32, mat.hemCloth);
  shoulderL.position.set(-0.33, 0.92, 0);
  torsoPivot.add(shoulderL);
  const shoulderR = box(0.22, 0.19, 0.32, mat.hemCloth);
  shoulderR.position.set(0.33, 0.92, 0);
  torsoPivot.add(shoulderR);

  const trimL = box(0.22, 0.02, 0.32, mat.highlight);
  trimL.position.set(-0.33, 1.025, 0);
  torsoPivot.add(trimL);
  const trimR = box(0.22, 0.02, 0.32, mat.highlight);
  trimR.position.set(0.33, 1.025, 0);
  torsoPivot.add(trimR);
  parts.shoulderTrim = [trimL, trimR];

  // Wrapped seam line across each shoulder block's face — turns the block
  // from a flat plate-armor read into a bound cloth mass with a visible
  // binding seam, matching the waist/mid/chest banding language.
  const shoulderSeamL = box(0.225, 0.03, 0.325, mat.seam);
  shoulderSeamL.position.set(-0.33, 0.875, 0);
  torsoPivot.add(shoulderSeamL);
  const shoulderSeamR = box(0.225, 0.03, 0.325, mat.seam);
  shoulderSeamR.position.set(0.33, 0.875, 0);
  torsoPivot.add(shoulderSeamR);
  parts.shoulderSeam = [shoulderSeamL, shoulderSeamR];

  const mantleL = hangingBox(0.17, 0.22, 0.06, mat.tan);
  mantleL.position.set(-0.33, 0.95, -0.15);
  mantleL.rotation.x = -0.14;
  torsoPivot.add(mantleL);
  const mantleR = hangingBox(0.17, 0.22, 0.06, mat.tan);
  mantleR.position.set(0.33, 0.95, -0.15);
  mantleR.rotation.x = -0.14;
  torsoPivot.add(mantleR);
  parts.mantleL = mantleL;
  parts.mantleR = mantleR;

  // Layered frayed cloth flap off the FRONT of each shoulder — 2-3 uneven
  // hanging strips, distinct from the back mantle, so every shoulder reads
  // as draped/frayed fabric bulk from the front too instead of a bare
  // block. This is the single biggest silhouette break available on the
  // pauldrons, breaking their boxy top/bottom edge with irregular strips.
  function buildShoulderFlap(x, mirror) {
    const flapDefs = [
      { dx: -0.06, len: 0.16, w: 0.055, mat: mat.tan },
      { dx: 0.015, len: 0.22, w: 0.06, mat: mat.hemCloth },
      { dx: 0.08, len: 0.13, w: 0.05, mat: mat.seam },
    ];
    return flapDefs.map((f) => {
      const strip = hangingBox(f.w, f.len, 0.045, f.mat);
      strip.position.set(x + mirror * f.dx, 0.865, 0.145);
      strip.rotation.x = 0.1;
      torsoPivot.add(strip);
      return strip;
    });
  }
  const shoulderFlapL = buildShoulderFlap(-0.33, -1);
  const shoulderFlapR = buildShoulderFlap(0.33, 1);
  parts.shoulderFlapL = shoulderFlapL;
  parts.shoulderFlapR = shoulderFlapR;

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

  // Folded hood point rising behind the crown — breaks the plain-box cowl
  // read and adds a small distinctive silhouette peak.
  const cowlPoint = box(0.14, 0.11, 0.13, mat.hemCloth);
  cowlPoint.position.set(0, 0.4, -0.05);
  headPivot.add(cowlPoint);
  const cowlPointTrim = box(0.14, 0.02, 0.13, mat.seam);
  cowlPointTrim.position.set(0, 0.345, -0.05);
  headPivot.add(cowlPointTrim);

  // Re-stitch shimmer band at the base of the cowl point — own clone of
  // mat.highlight so it joins the same pulsing self-mend network as the
  // torso/leg strips, carrying the shimmer cue all the way up to the head
  // instead of leaving it stop at the shoulders.
  const headShimmer = box(0.29, 0.014, 0.285, mat.highlight.clone());
  headShimmer.position.set(0, 0.055, 0);
  headPivot.add(headShimmer);

  // Void recess — the featureless "face": a shallow dark inset, mostly
  // HIDDEN behind wound cloth wraps rather than presented as a bare flat
  // panel. Deliberately smaller/shallower than a visor slot so what reads
  // is "wrapped cloth head with a sliver of void showing through the
  // wind," not "robot eye-socket."
  const faceRecess = box(0.16, 0.13, 0.02, mat.voidRecess);
  faceRecess.position.set(0, 0.205, 0.145);
  headPivot.add(faceRecess);

  // Wound face-wraps — three overlapping cloth bands crossing the recess
  // at different heights/angles like hand-wound bandaging, each thick
  // enough to sit proud of the recess and break its edges into an
  // irregular cloth-wrapped silhouette instead of a clean rectangle.
  const faceWrapDefs = [
    { y: 0.155, z: 0.155, rot: 0.08, h: 0.05, mat: mat.tan },
    { y: 0.225, z: 0.157, rot: -0.11, h: 0.055, mat: mat.hemCloth },
    { y: 0.28, z: 0.153, rot: 0.05, h: 0.04, mat: mat.tan },
  ];
  const faceWraps = faceWrapDefs.map((f) => {
    const wrap = box(0.21, f.h, 0.035, f.mat);
    wrap.position.set(0, f.y, f.z);
    wrap.rotation.z = f.rot;
    headPivot.add(wrap);
    return wrap;
  });
  parts.faceWraps = faceWraps;

  // A single loose wrap-end thread trailing off the wraps by the temple —
  // small frayed-hem detail right at the face, echoing the boot/waist
  // fringe so the "faceless" read is unmistakably cloth, not metal.
  const faceWrapFray = hangingBox(0.018, 0.09, 0.018, mat.warm);
  faceWrapFray.position.set(-0.1, 0.245, 0.14);
  faceWrapFray.rotation.z = -0.3;
  headPivot.add(faceWrapFray);
  parts.faceWrapFray = faceWrapFray;

  // Thin brow seam riding above the wraps — keeps a hint of stitched
  // structure at the top of the cowl opening.
  const browTrim = box(0.2, 0.02, 0.02, mat.seam);
  browTrim.position.set(0, 0.305, 0.145);
  headPivot.add(browTrim);

  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 0.46, 0);
  headPivot.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // ---- Arms: heavy bound-thread arms; right forearm IS the hem-blade -----
  function buildArm(x, mirror, isBlade) {
    const shoulderPivot = new THREE.Group();
    shoulderPivot.position.set(x, 0.92, 0);
    // The blade arm rests canted further out than the plain arm so the
    // hem-blade hangs clear of the hip/torso silhouette instead of lying
    // flush against it (previously read as a stray panel merged into the
    // body outline).
    const restZ = mirror * (isBlade ? 0.16 : 0.06);
    shoulderPivot.rotation.z = restZ;
    torsoPivot.add(shoulderPivot);

    const upperArm = hangingBox(0.16, 0.34, 0.16, mat.hemCloth);
    shoulderPivot.add(upperArm);

    const elbowPivot = new THREE.Group();
    elbowPivot.position.set(0, -0.34, 0);
    shoulderPivot.add(elbowPivot);

    let forearm;
    let bladeTip = null;
    if (isBlade) {
      // Broad flat hem-blade forming the forearm itself, wound with a
      // hilt-wrap band where it meets the arm and a trailing cloth strip
      // for a little extra movement flair.
      const bladeBase = hangingBox(0.14, 0.3, 0.1, mat.tan);
      elbowPivot.add(bladeBase);

      const hiltWrap = box(0.15, 0.035, 0.11, mat.seam);
      hiltWrap.position.set(0, -0.12, 0);
      elbowPivot.add(hiltWrap);

      const hiltStreamer = hangingBox(0.03, 0.15, 0.02, mat.tan);
      hiltStreamer.position.set(-0.07, -0.28, 0.02);
      hiltStreamer.rotation.z = 0.25;
      elbowPivot.add(hiltStreamer);

      const bladeGroup = new THREE.Group();
      bladeGroup.position.set(0.05, -0.3, 0);
      elbowPivot.add(bladeGroup);

      // Tapered blade stack: wide guard flare at the hilt narrowing in
      // clear steps to a bound point — the same "stacked taper" language
      // used for readable blade/spire silhouettes elsewhere in this
      // bestiary, so this reads unmistakably as a weapon rather than a
      // single flat rectangular panel.
      const bladeSegDefs = [
        // [w, h, d, centerY, material]
        [0.17, 0.06, 0.05, -0.03, mat.seam],   // guard flare — wider than the shaft
        [0.12, 0.14, 0.045, -0.13, mat.warm],  // upper blade
        [0.09, 0.14, 0.04, -0.27, mat.warm],   // mid blade, tapering
        [0.05, 0.12, 0.032, -0.4, mat.warm],   // bound point
      ];
      const bladeSegs = bladeSegDefs.map(([w, h, d, cy, m]) => {
        const seg = box(w, h, d, m);
        seg.position.set(0, cy, 0);
        bladeGroup.add(seg);
        return seg;
      });
      const [bladeGuard, bladeUpper, bladeMid, bladeTipSeg] = bladeSegs;

      // Own clone of mat.highlight (not the shared instance) so the
      // impact-flash pulse in animate() never bleeds into the re-stitch
      // shimmer strips or shoulder trim, which also derive from it. Runs
      // the full tapered length as a glinting front edge, brightest cue
      // right where a real blade edge would catch light.
      const bladeEdge = hangingBox(0.018, 0.34, 0.03, mat.highlight.clone());
      bladeEdge.position.set(0.075, -0.06, 0.02);
      bladeGroup.add(bladeEdge);

      // Two bound-cloth wrap bands crossing the blade face — reads as a
      // folded hem woven into a blade shape (layered fabric strips) rather
      // than serration notches on a metal edge.
      const wrapBandA = box(0.13, 0.04, 0.055, mat.seam);
      wrapBandA.position.set(0, -0.19, 0);
      bladeGroup.add(wrapBandA);
      const wrapBandB = box(0.1, 0.035, 0.045, mat.seam);
      wrapBandB.position.set(0, -0.33, 0);
      bladeGroup.add(wrapBandB);

      forearm = {
        bladeBase, hiltWrap, hiltStreamer, bladeGroup,
        bladeGuard, bladeUpper, bladeMid, bladeTipSeg, bladeEdge,
        wrapBandA, wrapBandB,
      };
      bladeTip = bladeGroup;
    } else {
      const forearmBox = hangingBox(0.14, 0.32, 0.14, mat.hemCloth);
      elbowPivot.add(forearmBox);

      const wristWrap = box(0.16, 0.035, 0.16, mat.seam);
      wristWrap.position.set(0, -0.27, 0);
      elbowPivot.add(wristWrap);

      const fistBlock = hangingBox(0.16, 0.12, 0.16, mat.tan);
      fistBlock.position.set(0, -0.31, 0);
      elbowPivot.add(fistBlock);

      const knuckleStud = box(0.05, 0.03, 0.05, mat.warm);
      knuckleStud.position.set(0, -0.31, 0.09);
      elbowPivot.add(knuckleStud);

      forearm = { forearmBox, wristWrap, fistBlock, knuckleStud };
    }

    return { shoulderPivot, elbowPivot, forearm, bladeTip, restZ };
  }

  const armL = buildArm(-0.44, -1, false);
  const armR = buildArm(0.44, 1, true);
  parts.armL = armL;
  parts.armR = armR;

  // One pulsing self-mend network spanning head, torso, and both legs —
  // previously the shimmer was confined to three torso bands, which read
  // as a minor local flourish rather than the whole warden's mending
  // gimmick. Concatenated here once every strip exists.
  restitchStrips = restitchStrips.concat([headShimmer, legL.legShimmer, legR.legShimmer]);
  parts.restitchStrips = restitchStrips;

  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION — built on mobs/anim/rig.js's procedural-motion helpers.
  // Idle:      rig.breathe drives a slow, heavy sentinel breathing scale;
  //            rig.sway independently drifts the mantles, back drape,
  //            waist tassels and spool charm so the figure never reads
  //            frozen even standing perfectly still. A periodic re-stitch
  //            shimmer travels up the seam bands (self-mending, always
  //            running, brighter/faster with phase/hurt).
  // Walk:      heavy, deliberate per-limb stride driven by rig.walkPhase,
  //            amplitude/cadence scaled by state.speed01; a weighted
  //            footfall stomp bob and a knee lift phase-shifted off the
  //            hip swing for a believable plant-and-drag gait.
  // Telegraph: rig.windUp draws the hem-blade arm back and up across the
  //            body into a broad wind-up pose as state.telegraph builds.
  // Attack:    rig.strike releases the wind-up into a wide horizontal
  //            hem-blade sweep as state.attack fires, torso rotating
  //            through with it and the blade edge flashing at impact.
  // Hurt:      a sharp lateral jolt that decays with state.hurt, plus a
  //            flare on the re-stitch shimmer — the wound reopens as a
  //            torn seam and is visibly mended in the same beat.
  // Death:     rig.dissolve unravels the whole figure — limbs splay wide,
  //            the body sinks and shrinks, every thread (tassels, mantle,
  //            back drape, hilt streamer) flings outward, and the
  //            re-stitch shimmer fades to nothing as the self-mending
  //            finally stops. No gore — just threads coming undone.
  // Turn:      torso banks into state.turn (signed yaw rate), damped.
  // -------------------------------------------------------------------
  const REST_MANTLE_X = -0.14;
  const REST_BACK_DRAPE_X = -0.08;
  const REST_ELBOW_L_X = 0;

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
      const phase = Math.min(Math.max(n(s.phase, 0), 0), 2);
      const phaseT = phase / 2; // 0..1 normalized boss escalation
      const speed01 = clamp01(s.speed01 != null ? s.speed01 : (moving ? 1 : 0));

      // ---- DEATH: slow thread-unravel dissolve, no gore ----
      if (dying > 0) {
        const d = rig.dissolve(dying);
        const sc = Math.max(0.04, d.scale);
        root.scale.set(sc, sc, sc);
        root.position.y = -d.drop * 0.55;
        root.position.x = 0;

        torsoPivot.rotation.z = lean;
        torsoPivot.rotation.x = d.spread * 0.14;
        headPivot.rotation.x = -d.spread * 0.35;
        headPivot.rotation.z = d.spread * 0.2;

        legL.hipPivot.rotation.x = -d.spread * 0.4;
        legL.hipPivot.rotation.z = -d.spread * 0.5;
        legR.hipPivot.rotation.x = -d.spread * 0.4;
        legR.hipPivot.rotation.z = d.spread * 0.5;
        legL.kneePivot.rotation.x = d.spread * 0.5;
        legR.kneePivot.rotation.x = d.spread * 0.5;

        armL.shoulderPivot.rotation.z = armL.restZ - d.spread * 1.1;
        armL.shoulderPivot.rotation.x = -d.spread * 0.9;
        armR.shoulderPivot.rotation.z = armR.restZ + d.spread * 1.1;
        armR.shoulderPivot.rotation.x = -d.spread * 0.9;
        armR.shoulderPivot.rotation.y = d.spread * 0.6;
        armL.elbowPivot.rotation.x = d.spread * 0.5;
        armR.elbowPivot.rotation.x = d.spread * 0.4;

        mantleL.rotation.x = REST_MANTLE_X - d.spread * 1.0;
        mantleR.rotation.x = REST_MANTLE_X - d.spread * 1.0;
        backDrape.rotation.x = REST_BACK_DRAPE_X - d.spread * 0.9;
        tassels.forEach((tsl, i) => {
          tsl.rotation.x = d.spread * (0.8 + i * 0.2);
          tsl.rotation.z = (i % 2 === 0 ? -1 : 1) * d.spread * 0.6;
        });
        spoolPivot.rotation.x = d.spread * 0.7;

        // The self-mending finally stops — shimmer gutters out as the
        // warden comes undone.
        const dim = Math.max(0, 1 - dying);
        restitchStrips.forEach((strip) => {
          strip.material.emissiveIntensity = 0.4 * dim;
          strip.scale.set(1, 1, 1);
        });
        armR.forearm.bladeEdge.material.emissiveIntensity = 0.4 * dim;
        return; // death pose overrides everything below
      }

      // Defensive reset in case a previous frame was mid-dissolve and the
      // mob got revived/recycled — animate() must never assume ordering
      // with the manager's own removal timing.
      if (root.scale.x !== 1) root.scale.set(1, 1, 1);
      if (root.position.x !== 0) root.position.x = 0;

      // ---- Idle: slow, heavy sentinel breathing + independent drift ----
      const breathAmt = rig.breathe(time, 1.2, 0.45 + phaseT * 0.15);
      torsoPivot.scale.set(1 + breathAmt * 0.4, 1 + breathAmt * 0.9, 1 + breathAmt * 0.4);

      // Heavy, deliberate stride cadence — shared by the legs (below), the
      // knee-lift phase, and the trailing cloth (mantle/drape/tassels), so
      // everything on the body reads as one consistent gait rather than
      // independently-timed parts.
      const strideFreq = 0.85;
      const wp = rig.walkPhase(time, speed01, strideFreq);
      const idleAmt = 1 - speed01;

      // Idle drift fades out (but never fully to zero) as the stride takes
      // over driving these same parts, and a touch of leg-swing trailing
      // lag is mixed in so the cloth visibly follows the body in motion.
      mantleL.rotation.x = REST_MANTLE_X + rig.sway(time, 0.8, 0.6, 0.4) * (0.35 + idleAmt * 0.65) - wp.FL * 0.14;
      mantleR.rotation.x = REST_MANTLE_X + rig.sway(time, 0.8, 0.65, 2.6) * (0.35 + idleAmt * 0.65) - wp.FR * 0.14;
      backDrape.rotation.x = REST_BACK_DRAPE_X + rig.sway(time, 0.7, 0.5, 1.1) * (0.4 + idleAmt * 0.6) + wp.lift * 0.1;
      backDrape.rotation.z = rig.sway(time, 0.5, 0.45, 0.2) * 0.3 * idleAmt;
      tassels.forEach((tsl, i) => {
        tsl.rotation.x = rig.sway(time, 0.9, 0.8, i * 1.1) * (0.4 + idleAmt * 0.4) + wp.lift * 0.12;
        tsl.rotation.z = rig.sway(time, 0.6, 0.7, i * 1.9 + 0.5) * 0.3 * idleAmt;
      });
      spoolPivot.rotation.z = rig.sway(time, 0.6, 0.9, 0.7) * 0.25 * (0.5 + idleAmt * 0.5);

      // Lean into turns — damped so the bank never snaps.
      const leanTarget = Math.max(-0.24, Math.min(0.24, -turn * 0.16));
      lean = rig.damp(lean, leanTarget, 6, dt);

      // Periodic re-stitch shimmer: each seam strip flashes brighter in a
      // staggered pulse traveling up the body, selling continuous
      // self-mend — faster/brighter as phase escalates or the warden is
      // freshly wounded.
      const shimmerRate = 0.55 + phaseT * 0.35;
      restitchStrips.forEach((strip, i) => {
        const cycle = (time * shimmerRate + i * 0.35) % 3;
        const flash = cycle < 0.4 ? 1 - cycle / 0.4 : 0;
        strip.material.emissiveIntensity = 0.4 + flash * 1.6 + hurt * 0.7;
        const k = 1 + flash * 0.15;
        strip.scale.set(k, 1, k);
      });

      if (moving) {
        // Heavy deliberate stride — per-limb, scaled by speed01. A second
        // walkPhase call, phase-shifted, drives knee lift so the flex
        // times to the leg's forward recovery rather than its plant.
        const kneeWp = rig.walkPhase(time + 0.09, speed01, strideFreq);
        const swingAmp = 1.35; // heavier stride than rig's default swing feel

        legL.hipPivot.rotation.x = wp.FL * swingAmp;
        legR.hipPivot.rotation.x = wp.FR * swingAmp;
        legL.kneePivot.rotation.x = Math.max(0, kneeWp.FL) * 1.1;
        legR.kneePivot.rotation.x = Math.max(0, kneeWp.FR) * 1.1;

        // Weighted footfall bob — dips heavier on each plant.
        root.position.y = (grounded ? wp.lift * 0.05 : 0);

        torsoPivot.rotation.x = 0.03 + wp.lift * 0.02;
        torsoPivot.rotation.z = lean + (wp.FR - wp.FL) * 0.02;

        // Left arm swings opposite the legs; the blade arm stays mostly
        // guarded near the body unless it's telegraphing/striking below.
        armL.shoulderPivot.rotation.x = wp.FR * 0.65;
        if (telegraph <= 0 && attack <= 0) {
          armR.shoulderPivot.rotation.x = wp.FL * 0.4;
        }
      } else {
        torsoPivot.rotation.x = rig.damp(torsoPivot.rotation.x, 0.015, 6, dt);
        torsoPivot.rotation.z = lean;
        legL.hipPivot.rotation.x = rig.damp(legL.hipPivot.rotation.x, 0, 8, dt);
        legR.hipPivot.rotation.x = rig.damp(legR.hipPivot.rotation.x, 0, 8, dt);
        legL.kneePivot.rotation.x = rig.damp(legL.kneePivot.rotation.x, 0, 8, dt);
        legR.kneePivot.rotation.x = rig.damp(legR.kneePivot.rotation.x, 0, 8, dt);
        armL.shoulderPivot.rotation.x = rig.damp(armL.shoulderPivot.rotation.x, 0, 8, dt);
        if (telegraph <= 0 && attack <= 0) {
          armR.shoulderPivot.rotation.x = rig.damp(armR.shoulderPivot.rotation.x, 0, 8, dt);
        }
        root.position.y = rig.damp(root.position.y, 0, 10, dt);
      }
      armL.elbowPivot.rotation.x = rig.damp(armL.elbowPivot.rotation.x, REST_ELBOW_L_X, 10, dt);

      // ---- Telegraph + attack: broad hem-blade sweep ----
      // rig.windUp pulls the blade back/up across the body as state.telegraph
      // builds toward the strike; rig.strike releases it into a fast
      // horizontal sweep, the torso rotating through with the blow.
      const attackActive = telegraph > 0 || attack > 0;
      if (attackActive) {
        const windAmt = rig.windUp(telegraph); // 0 -> ~-1.1 -> -1
        const strikeAmt = rig.strike(attack); // 0 -> 1, fast release
        const blend = Math.max(telegraph, attack);

        // Wind-up: shoulder rotates back/up across the body (negative Y),
        // blade raised. Strike: sweeps forward through and past neutral.
        const sweepY = attack > 0 ? -1.0 + strikeAmt * 2.2 : windAmt * 1.0;
        const raise = attack > 0 ? -0.32 + strikeAmt * 0.5 : windAmt * 0.32;

        armR.shoulderPivot.rotation.y = sweepY;
        armR.shoulderPivot.rotation.x = raise;
        armR.shoulderPivot.rotation.z = armR.restZ - blend * 0.15;
        armR.elbowPivot.rotation.x = -0.12 - blend * 0.1;

        torsoPivot.rotation.y = rig.sway(time, 0.4, 0.4) + (sweepY * 0.16);

        // Blade edge flashes brightest right at the peak of the strike.
        const impactFlash = attack > 0 ? Math.pow(strikeAmt, 3) : 0;
        armR.forearm.bladeEdge.material.emissiveIntensity = 0.4 + impactFlash * 2.2 + blend * 0.4;
      } else {
        armR.shoulderPivot.rotation.y = rig.damp(armR.shoulderPivot.rotation.y, 0, 8, dt);
        armR.shoulderPivot.rotation.x = rig.damp(armR.shoulderPivot.rotation.x, 0, 8, dt);
        armR.shoulderPivot.rotation.z = rig.damp(armR.shoulderPivot.rotation.z, armR.restZ, 8, dt);
        armR.elbowPivot.rotation.x = rig.damp(armR.elbowPivot.rotation.x, 0, 8, dt);
        torsoPivot.rotation.y = rig.damp(torsoPivot.rotation.y, rig.sway(time, 0.4, 0.4), 6, dt) + lean * 0.4;
        armR.forearm.bladeEdge.material.emissiveIntensity = rig.damp(
          armR.forearm.bladeEdge.material.emissiveIntensity, 0.4, 6, dt,
        );
      }

      // ---- Hurt flinch: sharp lateral jolt that decays with state.hurt --
      flinch = rig.damp(flinch, hurt, 18, dt);
      if (flinch > 0.001) {
        torsoPivot.position.x = Math.sin(time * 34) * 0.035 * flinch;
        headPivot.rotation.z = Math.sin(time * 28) * 0.09 * flinch;
      } else {
        torsoPivot.position.x = 0;
        headPivot.rotation.z *= 0.8;
      }
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
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
    'bone/parchment pale, not dark — with broad squared shoulders wound ' +
    'in a seam band and hung with layered frayed cloth flaps front and ' +
    'back, a torso wrapped in visible horizontal hem-seams that look ' +
    'freshly re-stitched, a stitched cross-seam over the chest, a wound ' +
    'thread-spool charm and frayed tassels at its belt, a trailing hem ' +
    'drape at its back, and a smooth featureless cowl — peaked behind ' +
    'like a folded hood — its face lost behind overlapping wound cloth ' +
    'wraps with only a sliver of void-dark showing through the wind. Its ' +
    'heavy bound-thread arms end one in a plain wrapped fist, the other ' +
    'in a tapered hem-blade grown from the forearm itself: a wide bound ' +
    'guard flare narrowing in seam-wrapped steps to a bound point, wound ' +
    'at the hilt with a loose streamer. Its heavy thread-bound boots wrap ' +
    'each shin in a cuffed band with a frayed fringe over a distinct toe ' +
    'cap. Every wound reopens as a torn seam and is visibly mended ' +
    'moments later in a slow shimmering pulse that runs the length of its ' +
    'body, head to boots — it does not bleed, it re-stitches. It is a ' +
    'keeper of the edge, not a horror: unhurried, unspeaking, and almost ' +
    'impossible to truly unmake — until its threads finally give out and ' +
    'unravel for good.',
};
