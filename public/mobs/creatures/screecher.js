import * as THREE from 'three';
import * as rig from '../anim/rig.js';

// ============================================================================
// SLAGMOTH — a charred Cinderloom moth that screeches on the wing.
// Archetype: screecher
//
// Silhouette goals (per design brief): a small fuzzy SEGMENTED body (three
// stacked round-ish boxes tapering to a charred tail-cap) topped with a
// jagged ridge of burnt fuzz spines along the spine, a pair of small charred
// mandibles at the jaw, and two LARGE angular TATTERED wings jutting from the
// thorax. Each wing is built from a main panel, a stepped-back tatter panel,
// and a small ragged tip shard — three tiers so the trailing edge reads as
// genuinely torn rather than a smooth Minecraft-bat curve — plus a dark
// underside trim and two crossing glowing ember-vein streaks. Two thin
// feathery antennae (charred stalks, glowing ember tufts) poke up from the
// head above a pair of pale under-eyes, and a thin smoldering cinder-thread
// trails off the tail tip. It NEVER lands in this module's animation — feet
// stay off the ground; it hovers via a constant flap + vertical bob, even at
// a dead standstill (state.moving === false). ORIGINAL silhouette — an
// angular, ember-veined moth-wraith, not a Minecraft creature.
// ============================================================================

// ---- Palette (canonical Slagmoth bestiary palette — all five hexes used) ---
const PALETTE = {
  emberVein: 0xe86a28,   // glowing ember veins streaked across the wings/thread
  eyeGlow: 0xf7b24e,     // pale glowing under-eyes / antenna tufts (emissive)
  fuzz: 0xa83c14,        // scorched fuzz covering the segmented body
  wingMembrane: 0x5c1e0a, // charred, tattered wing membrane
  char: 0x2b0e06,        // near-black char: tail cap, ridge spines, mandibles,
                          // wing underside trim, cinder-thread base
};

// Plain centered box mesh.
function box(w, h, d, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Defensive numeric coercion — mirrors rig.js's internal guard for the
// arithmetic that happens directly in this file (rig's own exports already
// self-guard their inputs).
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
  root.name = 'Slagmoth';

  // ---- Materials (one per canonical hex, every one used below) -----------
  const fuzzMat = new THREE.MeshStandardMaterial({
    color: PALETTE.fuzz,
    roughness: 0.85,
    metalness: 0.0,
  });
  const charMat = new THREE.MeshStandardMaterial({
    color: PALETTE.char,
    roughness: 0.95,
    metalness: 0.0,
  });
  const wingMat = new THREE.MeshStandardMaterial({
    color: PALETTE.wingMembrane,
    roughness: 0.6,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.emberVein),
    emissiveIntensity: 0.16, // baseline ember bleed through the membrane, even idle
  });
  // Outer tatter/tip tiers read as a harder-charred fringe — near-black,
  // barely any ember bleed — so the wing reads as a gradient from glowing
  // root to burnt-out edge rather than one flat color.
  const wingFringeMat = new THREE.MeshStandardMaterial({
    color: PALETTE.char,
    roughness: 0.9,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.emberVein),
    emissiveIntensity: 0.03,
  });
  // Thin, semi-translucent under-layer laid just beneath the main wing
  // panel so ember-glow visibly "bleeds" through the membrane (a cheap
  // stand-in for real subsurface translucency).
  const wingGlowMat = new THREE.MeshStandardMaterial({
    color: PALETTE.emberVein,
    roughness: 0.5,
    metalness: 0.0,
    transparent: true,
    opacity: 0.35,
    emissive: new THREE.Color(PALETTE.emberVein),
    emissiveIntensity: 0.5,
    depthWrite: false,
  });
  const veinMat = new THREE.MeshStandardMaterial({
    color: PALETTE.emberVein,
    roughness: 0.4,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.emberVein),
    emissiveIntensity: 0.7,
  });
  // Rim-light trim: a thin eye-glow-colored sliver run along leading edges
  // (wing fore-edge, thorax ridge) to fake a warm backlit rim on an
  // otherwise flat-shaded low-poly silhouette.
  const rimMat = new THREE.MeshStandardMaterial({
    color: PALETTE.eyeGlow,
    roughness: 0.35,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.eyeGlow),
    emissiveIntensity: 0.55,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: PALETTE.eyeGlow,
    roughness: 0.3,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.eyeGlow),
    emissiveIntensity: 1.4,
  });

  // ---- bodyGroup: everything that hovers/bobs/breathes/pitches together --
  // Base hover height keeps the whole silhouette well clear of y=0 at all
  // times (this creature never lands — see animate() below).
  const HOVER_BASE = 0.62;
  const bodyGroup = new THREE.Group();
  bodyGroup.position.y = HOVER_BASE;
  root.add(bodyGroup);

  // ---- Segmented body: three stacked round-ish boxes tapering to a
  // charred tail cap ---------------------------------------------------------
  const headSeg = box(0.18, 0.16, 0.16, fuzzMat);
  headSeg.position.set(0, 0.02, 0.16);
  bodyGroup.add(headSeg);

  const thoraxSeg = box(0.22, 0.20, 0.20, fuzzMat); // largest — wings mount here
  thoraxSeg.position.set(0, 0, 0);
  bodyGroup.add(thoraxSeg);

  const abdomenSeg = box(0.16, 0.15, 0.20, fuzzMat);
  abdomenSeg.position.set(0, -0.02, -0.20);
  bodyGroup.add(abdomenSeg);

  const tailTip = box(0.10, 0.10, 0.10, charMat); // charred cap finishes the taper
  tailTip.position.set(0, -0.03, -0.32);
  bodyGroup.add(tailTip);

  // ---- Fuzz nubs: small 45°-twisted corner blocks studding the thorax and
  // head so the silhouette reads as a fuzzy moth thorax rather than a plain
  // blocky cube — cheap "furry" edge-break at thumbnail size without adding
  // real geometry cost.
  const fuzzNubSpecs = [
    [-0.115, 0.06, 0.06, 0.05],
    [0.115, 0.06, 0.06, 0.05],
    [-0.11, -0.05, -0.02, 0.045],
    [0.11, -0.05, -0.02, 0.045],
    [-0.095, 0.05, 0.19, 0.04],
    [0.095, 0.05, 0.19, 0.04],
    [0, 0.10, 0.02, 0.05],
  ];
  const fuzzNubs = fuzzNubSpecs.map(([x, y, z, s], i) => {
    const nub = box(s, s, s, fuzzMat);
    nub.position.set(x, y, z);
    nub.rotation.set(0.5, 0.785 + i * 0.3, 0.3);
    bodyGroup.add(nub);
    return nub;
  });

  // ---- Rim trim: a thin eye-glow sliver along the thorax's top-front edge
  // — fakes a warm backlit rim highlight on the flat-shaded body.
  const bodyRim = box(0.20, 0.02, 0.02, rimMat);
  bodyRim.position.set(0, 0.10, 0.11);
  bodyGroup.add(bodyRim);

  // ---- Ridge spines: jagged burnt-fuzz mohawk along the spine — secondary
  // detail that instantly breaks up the "three stacked boxes" read and sells
  // "charred" at thumbnail size. Alternating twist keeps it jagged, not neat.
  const ridgeFront = box(0.05, 0.045, 0.05, charMat);
  ridgeFront.position.set(0, 0.115, 0.10);
  ridgeFront.rotation.y = 0.30;
  bodyGroup.add(ridgeFront);
  const ridgeMid = box(0.06, 0.05, 0.055, charMat);
  ridgeMid.position.set(0, 0.125, -0.03);
  ridgeMid.rotation.y = -0.25;
  bodyGroup.add(ridgeMid);
  const ridgeBack = box(0.045, 0.04, 0.045, charMat);
  ridgeBack.position.set(0, 0.10, -0.17);
  ridgeBack.rotation.y = 0.35;
  bodyGroup.add(ridgeBack);
  const ridgeSpines = [ridgeFront, ridgeMid, ridgeBack];

  // ---- Mandibles: two small charred wedges at the jaw for character -----
  const mandibleL = box(0.03, 0.025, 0.08, charMat);
  mandibleL.position.set(-0.055, -0.035, 0.235);
  mandibleL.rotation.y = 0.35;
  bodyGroup.add(mandibleL);
  const mandibleR = box(0.03, 0.025, 0.08, charMat);
  mandibleR.position.set(0.055, -0.035, 0.235);
  mandibleR.rotation.y = -0.35;
  bodyGroup.add(mandibleR);

  // ---- Under-eyes: pale glow beneath the brow of the head segment -------
  const eyeL = box(0.045, 0.045, 0.02, eyeMat);
  eyeL.position.set(-0.055, -0.02, 0.245);
  bodyGroup.add(eyeL);
  const eyeR = box(0.045, 0.045, 0.02, eyeMat);
  eyeR.position.set(0.055, -0.02, 0.245);
  bodyGroup.add(eyeR);

  // ---- Antennae: thin charred stalks pivoting from the head, tipped with
  // a glowing ember tuft (secondary color pop, ties to the ember-veined
  // wings) for quiver.
  function makeAntenna(sideSign) {
    const pivot = new THREE.Object3D();
    pivot.position.set(sideSign * 0.06, 0.10, 0.20);
    pivot.rotation.z = sideSign * 0.35;
    bodyGroup.add(pivot);

    const stalk = box(0.02, 0.16, 0.02, charMat);
    stalk.position.set(0, 0.08, 0); // grows upward from pivot
    pivot.add(stalk);

    const tuft = box(0.05, 0.045, 0.05, eyeMat); // glowing ember tuft tip
    tuft.position.set(0, 0.16, 0);
    pivot.add(tuft);

    return { pivot, stalk, tuft };
  }
  const antennaL = makeAntenna(-1);
  const antennaR = makeAntenna(1);

  // ---- Wings: large angular tattered panels mounted on shoulder pivots --
  // Each wing pivots about a shoulder near the thorax so it can rotate
  // about the body's forward (Z) axis to flap. Four tiers of panel (glow
  // underlay + main + stepped-back tatter + a scatter of ragged tip shards)
  // sell a genuinely torn, gradient-lit trailing edge instead of one flat
  // color: the main panel carries a soft ember bleed, the outer tiers are
  // switched to a near-black charred fringe material so the wing reads as
  // glowing-root-to-burnt-edge, and a loose scatter of tatter bits (varied
  // size/rotation, not just two symmetric notches) breaks the trapezoid
  // outline into a raggedy, burnt silhouette. A fixed dihedral + camber
  // curl on the pivot/tiers means the wing already reads as swept and
  // curved in the static bind pose, before any flap animation runs.
  const WING_REST_SWEEP = 0.42; // static raised/back sweep (dihedral)
  const WING_REST_CAMBER = -0.16; // static forward droop for wing curvature
  function makeWing(sideSign) {
    const shoulderPivot = new THREE.Object3D();
    shoulderPivot.position.set(sideSign * 0.11, 0.06, 0.0);
    // Static rest pose: swept up/back and cambered forward so the wing
    // never reads as a flat horizontal plane, even before animate() runs.
    shoulderPivot.rotation.z = sideSign * WING_REST_SWEEP;
    shoulderPivot.rotation.x = WING_REST_CAMBER;
    bodyGroup.add(shoulderPivot);

    // Glow underlay — a slightly inset, translucent ember-colored panel
    // sitting just beneath the main panel so light visibly bleeds through
    // the membrane (cheap stand-in for real wing translucency).
    const glowGeo = new THREE.BoxGeometry(0.30, 0.014, 0.26);
    glowGeo.translate(sideSign * 0.17, 0, 0);
    const glowUnderlay = new THREE.Mesh(glowGeo, wingGlowMat);
    glowUnderlay.position.set(0, -0.006, 0.01);
    shoulderPivot.add(glowUnderlay);

    // Main wing panel — large, angular, offset outward from the pivot.
    // Slight camber curl vs. the outer tiers gives the panel stack a
    // genuinely curved (not flat) cross-section.
    const mainGeo = new THREE.BoxGeometry(0.34, 0.02, 0.30);
    mainGeo.translate(sideSign * 0.17, 0, 0); // inner edge at pivot
    const mainPanel = new THREE.Mesh(mainGeo, wingMat);
    mainPanel.castShadow = true;
    mainPanel.receiveShadow = true;
    shoulderPivot.add(mainPanel);

    // Dark underside trim — a thin charred strip along the trailing edge,
    // giving the wing a shaded, weathered underside read.
    const trimGeo = new THREE.BoxGeometry(0.30, 0.012, 0.06);
    trimGeo.translate(sideSign * 0.15, 0, 0);
    const shadowTrim = new THREE.Mesh(trimGeo, charMat);
    shadowTrim.position.set(0, -0.014, -0.11);
    shadowTrim.castShadow = true;
    shoulderPivot.add(shadowTrim);

    // Stepped-back tatter panel — offset further out and back, curling
    // further forward than the main panel (camber) and switched to the
    // charred fringe material so the wing visibly darkens toward its edge.
    const notchGeo = new THREE.BoxGeometry(0.16, 0.018, 0.20);
    notchGeo.translate(sideSign * 0.13, 0, 0);
    const notchPanel = new THREE.Mesh(notchGeo, wingFringeMat);
    notchPanel.position.set(sideSign * 0.32, -0.01, -0.09);
    notchPanel.rotation.x = -0.14;
    notchPanel.rotation.z = sideSign * 0.06;
    notchPanel.castShadow = true;
    notchPanel.receiveShadow = true;
    shoulderPivot.add(notchPanel);

    // Ragged tip shards — a loose scatter of small, irregularly angled
    // fringe-material chips along the outer/trailing edge, so the
    // silhouette reads as genuinely burnt and tattered rather than a
    // clean panel with a couple of symmetric notches.
    const shardSpecs = [
      { w: 0.09, h: 0.015, d: 0.10, x: 0.46, y: -0.02, z: -0.14, rx: -0.10, ry: 0.12, rz: 0.05 },
      { w: 0.06, h: 0.013, d: 0.07, x: 0.40, y: -0.03, z: -0.24, rx: -0.22, ry: -0.18, rz: 0.16 },
      { w: 0.05, h: 0.012, d: 0.05, x: 0.24, y: -0.03, z: -0.26, rx: -0.30, ry: 0.30, rz: -0.10 },
      { w: 0.045, h: 0.011, d: 0.06, x: 0.50, y: -0.015, z: -0.04, rx: 0.08, ry: -0.35, rz: 0.20 },
    ];
    const tatterBits = shardSpecs.map((sp) => {
      const geo = new THREE.BoxGeometry(sp.w, sp.h, sp.d);
      geo.translate(sideSign * sp.x * 0.2, 0, 0);
      const bit = new THREE.Mesh(geo, wingFringeMat);
      bit.position.set(sideSign * sp.x, sp.y, sp.z);
      bit.rotation.set(sp.rx, sideSign * sp.ry, sideSign * sp.rz);
      bit.castShadow = true;
      shoulderPivot.add(bit);
      return bit;
    });
    const tipShard = tatterBits[0]; // primary tip shard, kept for animation refs

    // Ember vein network — three glowing strips of varied width/angle laid
    // across the main panel (was two parallel stripes) so the wing reads
    // as genuinely veined rather than a couple of flat stripes.
    const veinGeo = new THREE.BoxGeometry(0.30, 0.008, 0.05);
    veinGeo.translate(sideSign * 0.17, 0, 0);
    const vein = new THREE.Mesh(veinGeo, veinMat);
    vein.position.set(0, 0.014, 0.05);
    shoulderPivot.add(vein);

    const veinDiagGeo = new THREE.BoxGeometry(0.22, 0.007, 0.04);
    veinDiagGeo.translate(sideSign * 0.12, 0, 0);
    const veinDiag = new THREE.Mesh(veinDiagGeo, veinMat);
    veinDiag.position.set(sideSign * 0.05, 0.012, -0.05);
    veinDiag.rotation.z = sideSign * 0.3;
    shoulderPivot.add(veinDiag);

    // Third, shorter vein branch running out toward the tatter tiers —
    // completes a fork/network read instead of a plain "X".
    const veinBranchGeo = new THREE.BoxGeometry(0.14, 0.006, 0.03);
    veinBranchGeo.translate(sideSign * 0.06, 0, 0);
    const veinBranch = new THREE.Mesh(veinBranchGeo, veinMat);
    veinBranch.position.set(sideSign * 0.28, 0.006, -0.13);
    veinBranch.rotation.z = sideSign * -0.4;
    shoulderPivot.add(veinBranch);

    return {
      shoulderPivot,
      glowUnderlay,
      mainPanel,
      shadowTrim,
      notchPanel,
      tipShard,
      tatterBits,
      vein,
      veinDiag,
      veinBranch,
      restSweep: WING_REST_SWEEP * sideSign,
      restCamber: WING_REST_CAMBER,
    };
  }
  const wingL = makeWing(-1);
  const wingR = makeWing(1);

  // ---- Cinder-thread: a thin smoldering thread trailing off the tail cap,
  // charred near the body and glowing ember at the tip — a textile motif
  // (Loomfall creatures trail loose thread) plus a doubles-up as the death
  // dissolve's most dramatic unraveling element. Three progressively
  // thinner, progressively drooping segments (not one rigid straight rod)
  // so it reads unambiguously as a loose dangling thread rather than a
  // stiff blade/antenna/tail spike: it hangs DOWN off the tail cap and
  // curls back, tapering to a fine glowing wisp, instead of projecting
  // straight out to the side.
  const threadPivot = new THREE.Object3D();
  threadPivot.position.set(0, -0.02, -0.36);
  threadPivot.rotation.x = -0.55; // static droop: hangs down/back, not a straight spike
  bodyGroup.add(threadPivot);
  const threadSeg1 = box(0.026, 0.10, 0.026, charMat);
  threadSeg1.position.set(0, -0.05, 0);
  threadPivot.add(threadSeg1);

  const threadMid = new THREE.Object3D();
  threadMid.position.set(0, -0.10, 0);
  threadMid.rotation.x = -0.4; // curls further as it hangs, unlike a stiff rod
  threadPivot.add(threadMid);
  const threadSeg2 = box(0.018, 0.08, 0.018, charMat);
  threadSeg2.position.set(0, -0.04, 0);
  threadMid.add(threadSeg2);

  const threadTip = new THREE.Object3D();
  threadTip.position.set(0, -0.08, 0);
  threadTip.rotation.x = -0.35;
  threadMid.add(threadTip);
  const threadSeg3 = box(0.012, 0.06, 0.012, veinMat); // fine glowing ember wisp
  threadSeg3.position.set(0, -0.03, 0);
  threadTip.add(threadSeg3);

  // ---- Head anchor (for name tags) ---------------------------------------
  // Raised slightly above the antenna tufts so the floating name label
  // clears the eye-glow spots below it instead of grazing one.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, HOVER_BASE + 0.30, 0);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // ---- Store animated parts on userData -----------------------------------
  root.userData.parts = {
    bodyGroup,
    headSeg,
    thoraxSeg,
    abdomenSeg,
    tailTip,
    fuzzNubs,
    bodyRim,
    ridgeSpines,
    mandibleL,
    mandibleR,
    eyeL,
    eyeR,
    antennaL,
    antennaR,
    wingL,
    wingR,
    threadPivot,
    threadMid,
    threadTip,
    threadSeg1,
    threadSeg2,
    threadSeg3,
    fuzzMat,
    charMat,
    wingMat,
    wingFringeMat,
    wingGlowMat,
    rimMat,
    veinMat,
    eyeMat,
  };

  // -------------------------------------------------------------------
  // ANIMATION — built on mobs/anim/rig.js's procedural-motion helpers.
  // Idle:      rig.flap drives a continuous baseline wingbeat + rig.breathe/
  //            rig.sway a gentle hover bob and body drift, even at a dead
  //            standstill — this creature never lands, so "idle" still
  //            means airborne and alive.
  // Move:      speed01 quickens & widens the flap and hover bob, and pitches
  //            the body nose-down like a moth diving forward; rig.damp
  //            smooths every transition so nothing snaps.
  // Telegraph: rig.windUp rears the body back (nose up) and sweeps the
  //            wings up/back into a coiled glide as state.telegraph builds
  //            — the dive wind-up.
  // Attack:    rig.strike snaps the body into a steep nose-down dive with
  //            the wings swept tight, a fast whip-crack release out of the
  //            wind-up.
  // Hurt:      a sharp, fast-decaying jolt (rig.damp) plus a startled flare
  //            of the eye/vein glow and a spike in antennae quiver.
  // Death:     rig.dissolve unravels the Slagmoth mid-air: wings splay limp
  //            and asymmetric, the cinder-thread and antennae fling loose,
  //            ridge spines scatter, the body shrinks and sinks as it
  //            stops flying, and every glow gutters out. No gore — just
  //            embers going dark and threads coming apart.
  // Turn:      body banks (roll) into state.turn, damped.
  // -------------------------------------------------------------------
  const ridgeRest = ridgeSpines.map((r) => r.position.clone());
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
      const grounded = !!s.grounded; // perched, not truly landed — still hovers/flutters
      const speed01 = clamp01(s.speed01 != null ? s.speed01 : (moving ? 1 : 0));
      const hurt = clamp01(s.hurt);
      const dying = clamp01(s.dying);
      const telegraph = clamp01(s.telegraph);
      const attack = clamp01(s.attack);
      const fuse = clamp01(s.fuse);
      const phase = n(s.phase, 0);
      const turn = n(s.turn, 0);

      // Lean (roll) into turns, damped so the bank never snaps.
      const leanTarget = dying > 0 ? 0 : Math.max(-0.4, Math.min(0.4, -turn * 0.6));
      lean = rig.damp(lean, leanTarget, 9, dt || 0.016);

      // ---- DEATH: mid-air thread-unravel dissolve --------------------
      if (dying > 0) {
        const d = rig.dissolve(dying);
        const sc = Math.max(0.04, d.scale);
        root.scale.set(sc, sc, sc);
        root.position.y = -d.drop * 0.9; // stops flying, sinks out of the air
        root.rotation.z = lean * 0.3 + d.spread * 0.25;
        root.rotation.x = d.spread * 0.5; // tips forward as the wings give out

        wingL.shoulderPivot.rotation.z = wingL.restSweep + d.spread * 1.3;
        wingR.shoulderPivot.rotation.z = wingR.restSweep - d.spread * 1.1;
        wingL.shoulderPivot.rotation.x = wingL.restCamber + d.spread * 0.7;
        wingR.shoulderPivot.rotation.x = wingR.restCamber - d.spread * 0.55;

        antennaL.pivot.rotation.x = d.spread * 0.8;
        antennaR.pivot.rotation.x = -d.spread * 0.7;
        mandibleL.rotation.x = d.spread * 0.4;
        mandibleR.rotation.x = -d.spread * 0.4;

        threadPivot.rotation.z = d.spread * 1.0;
        threadPivot.rotation.x = -0.55 - d.spread * 0.4;
        threadMid.rotation.z = d.spread * 1.4;
        threadTip.rotation.z = -d.spread * 1.6;

        ridgeSpines.forEach((rSeg, i) => {
          const rest = ridgeRest[i];
          const dir = i % 2 === 0 ? 1 : -1;
          rSeg.position.set(rest.x + dir * d.spread * 0.10, rest.y + d.spread * 0.06, rest.z);
        });

        // Every glow gutters out as the embers go dark.
        eyeMat.emissiveIntensity = Math.max(0, 1.4 * (1 - dying));
        veinMat.emissiveIntensity = Math.max(0, 0.7 * (1 - dying));
        wingMat.emissiveIntensity = Math.max(0, 0.16 * (1 - dying));
        wingGlowMat.opacity = Math.max(0, 0.35 * (1 - dying));
        wingGlowMat.emissiveIntensity = Math.max(0, 0.5 * (1 - dying));
        wingFringeMat.emissiveIntensity = Math.max(0, 0.03 * (1 - dying));
        rimMat.emissiveIntensity = Math.max(0, 0.55 * (1 - dying));
        return; // death pose overrides everything below
      }

      // Reset root scale in case a previous frame was mid-dissolve and the
      // mob got revived/recycled (defensive; animate() must never assume
      // ordering with the mob manager's own lifecycle).
      if (root.scale.x !== 1) root.scale.set(1, 1, 1);
      root.rotation.z = 0;
      root.rotation.x = 0;
      root.position.y = 0;

      // ---- Wing flap: continuous baseline hover-flap, quickened & widened
      // by speed/phase/fuse, always active (never lands). ----
      const restFactor = grounded ? 0.6 : 1.0; // perched = lighter flutter
      const flapFreq = (6.5 + speed01 * 6.0 + phase * 1.2 + fuse * 3.0) * restFactor + (1 - restFactor) * 4;
      const flapAmp = (0.55 + speed01 * 0.35) * (0.75 + restFactor * 0.25);
      const flapVal = rig.flap(time, flapFreq, flapAmp);

      // ---- Telegraph (dive wind-up) / attack (dive strike) overlay ----
      const wind = rig.windUp(telegraph); // 0 -> ~-1.1 -> -1 as telegraph builds
      const strikeAmt = rig.strike(attack); // 0 -> 1, fast whip-crack release
      const windWingPull = wind * 0.55; // pulls wings up/back before the dive
      const strikeWingSweep = strikeAmt * 0.85; // snaps wings tight into the dive

      // Baselines are the static rest sweep/camber baked in at build time
      // (wingL.restSweep/restCamber), so even a single idle frame at
      // flapVal≈0 still shows a swept, cambered wing rather than a flat
      // horizontal trapezoid.
      wingL.shoulderPivot.rotation.z = wingL.restSweep + flapVal - windWingPull + strikeWingSweep * 0.3;
      wingR.shoulderPivot.rotation.z = wingR.restSweep - flapVal + windWingPull - strikeWingSweep * 0.3;
      wingL.shoulderPivot.rotation.x =
        wingL.restCamber + Math.sin(time * flapFreq + 0.6) * 0.08 - wind * 0.30 + strikeAmt * 0.5;
      wingR.shoulderPivot.rotation.x =
        wingR.restCamber + Math.sin(time * flapFreq + 0.6) * 0.08 - wind * 0.30 + strikeAmt * 0.5;

      // ---- Hover bob: vertical drift, always active. ----
      const hoverBobAmp = (grounded ? 0.02 : 0.05 - speed01 * 0.02) + rig.sway(time, 1, 0.5, 0) * 0.006;
      const hoverBobSpeed = 3.0 + speed01 * 2.5;
      const hoverBob = Math.sin(time * hoverBobSpeed) * hoverBobAmp;

      // ---- Idle-breathe: subtle body scale pulse layered under the bob. ----
      const breatheAmt = rig.breathe(time, 1.1, 1);
      bodyGroup.scale.set(1 + breatheAmt * 0.5, 1 + breatheAmt, 1 + breatheAmt * 0.5);

      // ---- Body pitch: nose-down while moving, rears back on telegraph,
      // snaps into a steep nose-down dive on strike — smoothed with rig.damp
      // so the transitions never pop. ----
      let targetPitch = moving ? -0.18 : 0;
      targetPitch += -wind * 0.40; // wind-up: rear the nose up before diving
      targetPitch += -strikeAmt * 0.55; // strike: steep nose-down dive
      bodyGroup.rotation.x = rig.damp(bodyGroup.rotation.x, targetPitch, 10, dt || 0.016);

      // Body roll: flap-synced wobble plus turn-bank lean.
      bodyGroup.rotation.z = flapVal * 0.05 + lean;
      bodyGroup.rotation.y = rig.lerpAngle(bodyGroup.rotation.y, lean * 0.4, 0.15);

      bodyGroup.position.y = HOVER_BASE + hoverBob - (grounded ? 0.10 : 0);

      // ---- Antennae quiver: constant, sharper on hurt/telegraph/fuse. ----
      const quiverSpeed = 9.0 + hurt * 20.0 + fuse * 10.0;
      const quiverAmp = 0.10 + hurt * 0.25 + telegraph * 0.15;
      antennaL.pivot.rotation.x = Math.sin(time * quiverSpeed) * quiverAmp;
      antennaR.pivot.rotation.x = Math.sin(time * quiverSpeed + 1.1) * quiverAmp;

      // ---- Mandibles: small idle chatter, clenching on hurt. ----
      mandibleL.rotation.x = Math.sin(time * 6.0) * 0.03 + hurt * 0.15;
      mandibleR.rotation.x = Math.sin(time * 6.0 + 0.5) * 0.03 + hurt * 0.15;

      // ---- Cinder-thread: lazy pendulum sway off its static downward
      // droop (baked in at build time so it always reads as a hanging
      // thread, never a rigid straight blade), streams back with speed and
      // flares out a little more during the attack dive. ----
      const stream = speed01 * 0.3 + attack * 0.4;
      threadPivot.rotation.z = Math.sin(time * 1.3) * 0.18 + stream * 0.3;
      threadPivot.rotation.x = -0.55 + Math.cos(time * 1.0) * 0.06;
      threadMid.rotation.z = Math.sin(time * 1.3 + 0.7) * 0.26 + stream * 0.5;
      threadMid.rotation.x = -0.4 + Math.cos(time * 1.1 + 0.4) * 0.08;
      threadTip.rotation.z = Math.sin(time * 1.3 + 1.4) * 0.30 + stream * 0.6;

      // ---- Hurt flinch: sharp, fast-decaying jolt. ----
      flinch = rig.damp(flinch, hurt, 18, dt || 0.016);
      if (flinch > 0.001) {
        bodyGroup.rotation.z += Math.sin(time * 30) * 0.15 * flinch;
        bodyGroup.position.y += Math.sin(time * 40) * 0.02 * flinch;
      }

      // ---- Screech pulse: eyes and ember veins throb in a slow breathing
      // glow, flaring sharper on hurt/telegraph/attack/fuse. The wing
      // membrane's own bleed-through glow (main panel + translucent
      // underlay) pulses along with it so the wings never sit at a single
      // flat, static shade; the charred fringe tiers stay mostly dark to
      // preserve the glowing-root-to-burnt-edge gradient.
      const glowPulse = 0.55 + Math.sin(time * 3.0) * 0.35;
      const hurtFlare = hurt > 0 ? Math.sin(time * 30) * 0.8 * hurt : 0;
      eyeMat.emissiveIntensity =
        1.2 + glowPulse * 0.6 + hurtFlare + fuse * 0.7 + telegraph * 0.3;
      veinMat.emissiveIntensity =
        0.5 + glowPulse * 0.5 + Math.max(0, hurtFlare) + fuse * 0.8 + attack * 0.6;
      wingMat.emissiveIntensity = 0.16 + glowPulse * 0.14 + fuse * 0.08;
      wingGlowMat.emissiveIntensity = 0.4 + glowPulse * 0.25 + fuse * 0.15;
      wingGlowMat.opacity = 0.3 + glowPulse * 0.12;
      wingFringeMat.emissiveIntensity = 0.03 + glowPulse * 0.02;
      rimMat.emissiveIntensity = 0.45 + glowPulse * 0.2 + Math.max(0, hurtFlare) * 0.3;
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
    }
  };

  return root;
}

export const meta = {
  archetype: 'screecher',
  species: 'Slagmoth',
  canonicalId: 'slagmoth',
  dimensionDefault: 'cinderloom',
  palette: {
    emberVein: '#E86A28',
    eyeGlow: '#F7B24E',
    fuzz: '#A83C14',
    wingMembrane: '#5C1E0A',
    char: '#2B0E06',
  },
  description:
    'A small Cinderloom moth with a fuzzy, scorched-orange segmented body ' +
    'capped in char-black, a jagged ridge of burnt fuzz spines along its ' +
    'spine, and two large angular wings of charred, tattered membrane laced ' +
    'with crossing, glowing ember-vein streaks. Small charred mandibles ' +
    'click beneath a pair of pale under-eyes, feathery antennae tipped in ' +
    'glowing embers quiver above them, and a thin smoldering cinder-thread ' +
    'trails from its tail. It never lands — the Slagmoth hovers on ' +
    'ceaselessly beating wings, rears back to wind up before folding into a ' +
    'steep diving strike, and when startled lets out a screech that flares ' +
    'its eyes and vein-streaks bright before fading back to a slow ember ' +
    'pulse.',
};
