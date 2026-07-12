import * as THREE from 'three';
import * as rig from '../anim/rig.js';

// ============================================================================
// SKEINLING — a passive Warpwold "livestock" creature.
// Loomfall lore: born of stray Thrum caught in loose wool, a Skeinling is a
// living ball of yarn that grazes the fields of Warpwold. It is built from a
// cluster of small overlapping "puff" boxes (never a single cube) so its
// silhouette chamfers into a plump, round, fluffy skein rather than a blocky
// staircase. Two shading puffs (a darker oatmeal tone) sit low and to the
// sides so the ball reads as genuinely round-shaded, not flat-lit wool, and
// small wool/woolShade "wisp" knuckles knot onto the corner puffs plus thin
// woolShade AO slivers tuck into the core/corner seams so the surface breaks
// up into real fluff texture with crevice shading instead of flat panels.
// Two small ear-tufts and a pair of stray loose-thread nubs on the flanks
// add silhouette/secondary detail that still reads at thumbnail size. Four
// short stubby dun legs (each capped with a tiny dark hoof-nub) peek out
// from underneath, a tiny tucked head with two big flat charcoal button-eyes
// and a small dark muzzle bar pokes out the front (a real resting face, not
// just two dots), and one loose dyed-red thread — sized up to actually read
// at a glance — trails and sways clearly behind the body. ORIGINAL
// silhouette — a squat wool sphere-cluster, not a boxy Minecraft-sheep
// stack.
// ============================================================================

export function build() {
  const root = new THREE.Group();
  root.name = 'Skeinling';

  // ---- Palette (canonical Skeinling bestiary palette — all five used) ------
  const palette = {
    wool: 0xf2ead8,      // cream/oatmeal main coat (dominant material)
    woolShade: 0xdccdb0, // shaded/underside oatmeal — sells the round puff
    dun: 0xb8a47e,       // soft dun legs
    eye: 0x8a7350,       // dark button eyes / hoof-nubs
    thread: 0xc9938a,    // dusty-red trailing thread tail / loose thread nubs
  };

  // ---- Materials (shared per color so the box count stays lean) ------------
  const woolMat = new THREE.MeshStandardMaterial({
    color: palette.wool,
    roughness: 0.95,
    metalness: 0.0,
  });
  const woolShadeMat = new THREE.MeshStandardMaterial({
    color: palette.woolShade,
    roughness: 0.95,
    metalness: 0.0,
  });
  const legMat = new THREE.MeshStandardMaterial({
    color: palette.dun,
    roughness: 0.9,
    metalness: 0.0,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: palette.eye,
    roughness: 0.4,
    metalness: 0.1,
    emissive: palette.eye,
    emissiveIntensity: 0.05, // faint sheen, not a glow creature
  });
  const threadMat = new THREE.MeshStandardMaterial({
    color: palette.thread,
    roughness: 0.7,
    metalness: 0.0,
  });

  // ---- Body: chamfered cluster of overlapping puff boxes ---------------------
  // A core box plus eight smaller "puff" boxes (four diagonal corners, two
  // sides, a top cap, a bottom cap) overlap the core just enough that the
  // silhouette rounds off at every edge instead of showing sharp 90-degree
  // corners — this is what reads as a fluffy ball of yarn rather than a
  // rock pile. Positions are hand-varied (not a uniform grid) for a looser,
  // hand-spun look. The side + bottom puffs use the darker woolShade tone so
  // the ball reads as round-shaded from every angle, not flatly lit.
  const bodyGroup = new THREE.Group();
  bodyGroup.position.set(0, 0.4, 0); // body center height off the ground
  root.add(bodyGroup);

  // Core box — the main mass of the skein.
  const coreGeo = new THREE.BoxGeometry(0.46, 0.34, 0.52);
  const core = new THREE.Mesh(coreGeo, woolMat);
  bodyGroup.add(core);

  // Four diagonal corner "chamfer" puffs — smaller, offset to the four
  // horizontal corners and slightly twisted so the silhouette rounds off
  // instead of showing sharp box edges. Sizes/offsets are lightly varied.
  const cornerDefs = [
    { size: [0.2, 0.26, 0.22], pos: [0.24, -0.01, 0.22], twist: 1 },   // front-right
    { size: [0.22, 0.24, 0.2], pos: [-0.23, 0.01, 0.23], twist: -1 }, // front-left
    { size: [0.21, 0.25, 0.21], pos: [0.23, 0.02, -0.22], twist: 1 }, // back-right
    { size: [0.2, 0.23, 0.22], pos: [-0.24, -0.02, -0.21], twist: -1 }, // back-left
  ];
  const corners = cornerDefs.map(({ size, pos, twist }) => {
    const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const m = new THREE.Mesh(geo, woolMat);
    m.position.set(pos[0], pos[1], pos[2]);
    m.rotation.y = twist * 0.42; // slight twist, fluffy not square
    bodyGroup.add(m);
    return m;
  });

  // Left/right side puffs — round out the flanks so the ball reads wide
  // and round from the front, not a flat-sided box. Shaded tone (woolShade)
  // gives the ball a believable "underlit" round-shading cue.
  const sideGeo = new THREE.BoxGeometry(0.14, 0.22, 0.3);
  const sideR = new THREE.Mesh(sideGeo, woolShadeMat);
  sideR.position.set(0.27, -0.02, 0.0);
  bodyGroup.add(sideR);
  const sideL = new THREE.Mesh(sideGeo, woolShadeMat);
  sideL.position.set(-0.27, -0.01, 0.02);
  bodyGroup.add(sideL);

  // Top puff cap — rounds the crown of the wool ball.
  const topGeo = new THREE.BoxGeometry(0.3, 0.16, 0.36);
  const topPuff = new THREE.Mesh(topGeo, woolMat);
  topPuff.position.set(0, 0.17, -0.02);
  bodyGroup.add(topPuff);

  // Bottom puff — rounds the underside so legs look tucked into wool.
  // Shaded tone: the underside is the darkest-shaded part of the ball.
  const bottomGeo = new THREE.BoxGeometry(0.32, 0.12, 0.38);
  const bottomPuff = new THREE.Mesh(bottomGeo, woolShadeMat);
  bottomPuff.position.set(0, -0.2, 0);
  bodyGroup.add(bottomPuff);

  // Stray loose-thread nubs — two tiny thread-colored tufts poking from the
  // flanks, distinct from the tail. Secondary detail: reads as "this ball of
  // yarn is fraying a little" even at thumbnail size, and gives the palette
  // an extra pop of red against the cream/dun body. Sized up slightly from
  // the original pass so the red actually registers as a color note rather
  // than disappearing at a glance.
  const threadNubGeo = new THREE.BoxGeometry(0.065, 0.065, 0.11);
  const threadNubL = new THREE.Mesh(threadNubGeo, threadMat);
  threadNubL.position.set(-0.32, 0.06, 0.08);
  threadNubL.rotation.y = -0.5;
  bodyGroup.add(threadNubL);
  const threadNubR = new THREE.Mesh(threadNubGeo.clone(), threadMat);
  threadNubR.position.set(0.31, -0.05, -0.1);
  threadNubR.rotation.y = 0.6;
  bodyGroup.add(threadNubR);

  // Wisp texture nubs — small alternating wool/woolShade knuckles parented
  // directly onto the four corner puffs (so they inherit the corner's own
  // death-dissolve motion for free, no extra rest-position bookkeeping).
  // This is what breaks the "flat hard-edged box" read: from any angle at
  // least one lumpy little knot of yarn is catching the light differently
  // from the panel behind it, which sells fluff/texture without a texture
  // map. Sizes/positions are hand-varied, not a grid.
  const wispDefs = [
    { size: [0.09, 0.08, 0.08], pos: [0.07, 0.1, 0.06], mat: woolShadeMat },
    { size: [0.07, 0.07, 0.09], pos: [-0.06, -0.08, 0.05], mat: woolMat },
    { size: [0.08, 0.09, 0.07], pos: [0.05, -0.07, -0.07], mat: woolShadeMat },
    { size: [0.07, 0.08, 0.08], pos: [-0.07, 0.09, -0.05], mat: woolMat },
  ];
  const wisps = corners.map((corner, i) => {
    const { size, pos, mat } = wispDefs[i];
    const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const w = new THREE.Mesh(geo, mat);
    w.position.set(pos[0], pos[1], pos[2]);
    w.rotation.y = (i % 2 === 0 ? 1 : -1) * 0.5;
    w.rotation.x = (i % 2 === 0 ? -1 : 1) * 0.2;
    corner.add(w);
    return w;
  });

  // Crevice AO slivers — thin woolShade slats tucked into the seams where
  // the core box meets each corner puff, faking contact-shadow/ambient
  // occlusion in the crevices so the puff cluster reads with real gradation
  // instead of uniformly flat per-face lighting. Parented to the (static)
  // core so they never need their own rest-pose tracking.
  const aoGeo = new THREE.BoxGeometry(0.05, 0.3, 0.05);
  const aoDefs = [
    { pos: [0.22, -0.01, 0.24], rotY: 0.78 },
    { pos: [-0.22, 0.0, 0.24], rotY: -0.78 },
    { pos: [0.21, 0.0, -0.24], rotY: 0.78 },
    { pos: [-0.22, -0.01, -0.24], rotY: -0.78 },
  ];
  const aoSlivers = aoDefs.map(({ pos, rotY }) => {
    const a = new THREE.Mesh(aoGeo, woolShadeMat);
    a.position.set(pos[0], pos[1], pos[2]);
    a.rotation.y = rotY;
    core.add(a);
    return a;
  });

  // Seam stitches — three small thread-colored dashes along the top crown,
  // evoking a hand-stitched seam where the skein was bound off. Reads as a
  // clean textile motif from above/three-quarter view without adding bulk
  // to the silhouette.
  const stitchGeo = new THREE.BoxGeometry(0.035, 0.03, 0.07);
  const stitchOffsets = [-0.1, 0, 0.1];
  const stitches = stitchOffsets.map((zOff) => {
    const s = new THREE.Mesh(stitchGeo, threadMat);
    s.position.set(0, 0.255, zOff - 0.02);
    bodyGroup.add(s);
    return s;
  });

  // ---- Head: small, low, tucked at the front ---------------------------------
  const headGroup = new THREE.Group();
  headGroup.position.set(0, 0.32, 0.32); // low & forward, tucked under the fluff
  root.add(headGroup);

  const headGeo = new THREE.BoxGeometry(0.24, 0.2, 0.22);
  const head = new THREE.Mesh(headGeo, woolMat);
  headGroup.add(head);

  // Big flat button-eyes, both on the front (+Z) face of the head so they
  // are clearly visible head-on.
  const eyeGeo = new THREE.BoxGeometry(0.07, 0.07, 0.02);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(0.065, 0.02, 0.12);
  headGroup.add(eyeL);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeR.position.set(-0.065, 0.02, 0.12);
  headGroup.add(eyeR);

  // Small dark muzzle bar under the eyes — a grazer's mouth, low on the
  // face where a grass-cropping mouth belongs. Tiny, but it is the piece
  // that turns "two dots on a box" into an actual resting-face read rather
  // than an ambiguous pair of buttons.
  const muzzleGeo = new THREE.BoxGeometry(0.08, 0.03, 0.02);
  const muzzle = new THREE.Mesh(muzzleGeo, eyeMat);
  muzzle.position.set(0, -0.05, 0.12);
  headGroup.add(muzzle);

  // Ear-tufts — two small shaded-wool puffs on top of the head, pitched
  // slightly back and out. A cheap, high-value silhouette read: without
  // them the head is a plain box; with them it instantly reads as a small
  // fuzzy creature's head from any angle, including thumbnail size.
  const earGeo = new THREE.BoxGeometry(0.07, 0.06, 0.06);
  const earPivotL = new THREE.Group();
  earPivotL.position.set(0.08, 0.12, -0.02);
  earPivotL.rotation.z = 0.3;
  headGroup.add(earPivotL);
  const earL = new THREE.Mesh(earGeo, woolShadeMat);
  earL.position.set(0, 0.02, 0);
  earPivotL.add(earL);
  const earPivotR = new THREE.Group();
  earPivotR.position.set(-0.08, 0.12, -0.02);
  earPivotR.rotation.z = -0.3;
  headGroup.add(earPivotR);
  const earR = new THREE.Mesh(earGeo.clone(), woolShadeMat);
  earR.position.set(0, 0.02, 0);
  earPivotR.add(earR);

  // Head anchor for name tags — just above the head (and ears).
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 0.48, 0.32);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // ---- Legs: four short stubby, distinctly dun-colored boxes with a tiny
  // dark hoof-nub tip. The hoof-nub is what "grounds" a very woolly, mostly
  // spherical creature — without it the legs disappear visually into shadow
  // against the ground plane. Feet are guaranteed to land exactly at y=0:
  // pivot at HIP_Y = LEG_H + HOOF_H, leg centered box top = pivot (0 overlap
  // gap with hip), hoof centered box bottom = pivot - LEG_H - HOOF_H = 0.
  const LEG_H = 0.14;
  const HOOF_H = 0.04;
  const HIP_Y = LEG_H + HOOF_H; // 0.18
  const legGeo = new THREE.BoxGeometry(0.09, LEG_H, 0.09);
  const hoofGeo = new THREE.BoxGeometry(0.1, HOOF_H, 0.1);
  const legPositions = [
    [0.17, HIP_Y, 0.19],   // front-right
    [-0.17, HIP_Y, 0.19],  // front-left
    [0.17, HIP_Y, -0.19],  // back-right
    [-0.17, HIP_Y, -0.19], // back-left
  ];
  const legs = legPositions.map(([x, y, z]) => {
    const legPivot = new THREE.Group();
    legPivot.position.set(x, y, z); // pivot at hip height
    const legMesh = new THREE.Mesh(legGeo, legMat);
    legMesh.position.set(0, -LEG_H / 2, 0); // hang below the pivot
    legPivot.add(legMesh);
    const hoof = new THREE.Mesh(hoofGeo, eyeMat);
    hoof.position.set(0, -(LEG_H + HOOF_H / 2), 0); // feet reach y=0
    legPivot.add(hoof);
    root.add(legPivot);
    return legPivot;
  });

  // ---- Tail: one loose trailing thread, chained from the rear ----------------
  // Three shrinking red boxes chained through nested pivots so the whole
  // thread can sway as a unit while the tip also gets its own extra flick —
  // this is the single most important silhouette read after the eyes (the
  // brief's headline identifying feature), so it is placed clearly *behind*
  // the rearmost wool puff (not buried inside it) and sized up from the
  // original thin-peg pass so it unmistakably reads as a trailing thread
  // rather than a hard-to-spot nub at normal viewing distance.
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.3, -0.4); // clearly past the rear-most body puff
  root.add(tailPivot);

  const tailSeg1Geo = new THREE.BoxGeometry(0.075, 0.17, 0.075);
  const tailSeg1 = new THREE.Mesh(tailSeg1Geo, threadMat);
  tailSeg1.position.set(0, -0.07, -0.04);
  tailPivot.add(tailSeg1);

  const tailMid = new THREE.Group();
  tailMid.position.set(0, -0.16, -0.08);
  tailPivot.add(tailMid);

  const tailSeg2Geo = new THREE.BoxGeometry(0.06, 0.14, 0.06);
  const tailSeg2 = new THREE.Mesh(tailSeg2Geo, threadMat);
  tailSeg2.position.set(0, -0.06, -0.04);
  tailMid.add(tailSeg2);

  const tailTip = new THREE.Group();
  tailTip.position.set(0, -0.12, -0.07);
  tailMid.add(tailTip);

  const tailSeg3Geo = new THREE.BoxGeometry(0.045, 0.12, 0.045);
  const tailSeg3 = new THREE.Mesh(tailSeg3Geo, threadMat);
  tailSeg3.position.set(0, -0.05, -0.03);
  tailTip.add(tailSeg3);

  // ---- Store references for animation ----------------------------------------
  root.userData.parts = {
    bodyGroup,
    headGroup,
    legs,        // array of 4 pivots: [FR, FL, BR, BL]
    tailPivot,
    tailMid,
    tailTip,
    corners,
    sideL,
    sideR,
    earPivotL,
    earPivotR,
    threadNubL,
    threadNubR,
    stitches,
    eyeL,
    eyeR,
    muzzle,
    wisps,
    aoSlivers,
  };

  // ---------------------------------------------------------------------------
  // ANIMATION
  //
  // Idle:   rig.breathe drives a wool "jiggle" scale pulse on the body mass,
  //         rig.sway drifts the head/ears/thread-nubs independently so the
  //         skein never looks frozen; an occasional twitch flicks the head
  //         and tail for character.
  // Walk:   rig.walkPhase drives a real diagonal-pair 4-leg trot scaled by
  //         state.speed01, with a small footfall bounce (lift) and a lean
  //         into turns from state.turn.
  // Telegraph/
  // Attack: rig.windUp/rig.strike give a small head/body anticipation-then-
  //         snap (harmless no-op unless something upstream ever drives a
  //         Skeinling headbutt).
  // Hurt:   a quick decaying flinch hop + squash, ears pin back.
  // Death:  rig.dissolve(state.dying) unravels the skein: the body shrinks
  //         and sinks while the puff-boxes, legs and thread all fling
  //         outward — since this body is already built from discrete puffs,
  //         spreading them apart reads directly as "the yarn ball is coming
  //         undone" rather than needing a separate death rig.
  // ---------------------------------------------------------------------------
  function n(v, fallback = 0) {
    const x = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(x) ? x : fallback;
  }
  function clamp01(v) {
    const x = n(v, 0);
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  // Rest-pose offsets captured once so death/hurt poses can spread relative
  // to where each puff/leg/nub actually started, not an assumed origin.
  const cornerRest = corners.map((m) => m.position.clone());
  const nubRest = {
    L: threadNubL.position.clone(),
    R: threadNubR.position.clone(),
  };
  const sideRest = { L: sideL.position.clone(), R: sideR.position.clone() };

  let lean = 0;
  let prevT = null;

  root.userData.animate = (t, state) => {
    try {
      const s = state || {};
      const time = n(t, 0);
      let dt = 0;
      if (prevT !== null) dt = Math.max(0, Math.min(0.12, time - prevT));
      prevT = time;

      const moving = !!s.moving;
      const hurt = clamp01(s.hurt);
      const dying = clamp01(s.dying);
      const telegraph = clamp01(s.telegraph);
      const attack = clamp01(s.attack);
      const turn = n(s.turn, 0);
      const speed01 = clamp01(s.speed01 != null ? s.speed01 : (moving ? 1 : 0));

      // Lean into turns (damped so it never snaps).
      const leanTarget = dying > 0 ? 0 : Math.max(-0.3, Math.min(0.3, -turn * 0.5));
      lean = rig.damp(lean, leanTarget, 8, dt || 0.016);

      // ---- DEATH: thread-unravel dissolve -------------------------------
      if (dying > 0) {
        const d = rig.dissolve(dying);
        const sc = Math.max(0.04, d.scale);
        root.scale.set(sc, sc, sc);
        root.position.y = -d.drop * 0.35;
        root.rotation.z = lean * 0.3;

        // The puff-cluster body IS the unraveling skein: fling each puff
        // outward from its own rest position along its own direction.
        corners.forEach((m, i) => {
          const rest = cornerRest[i];
          const dir = rest.clone().normalize();
          m.position.set(
            rest.x + dir.x * d.spread * 0.4,
            rest.y + dir.y * d.spread * 0.25,
            rest.z + dir.z * d.spread * 0.4
          );
          m.rotation.y += d.spread * 0.02;
        });
        sideL.position.set(sideRest.L.x - d.spread * 0.18, sideRest.L.y, sideRest.L.z);
        sideR.position.set(sideRest.R.x + d.spread * 0.18, sideRest.R.y, sideRest.R.z);
        threadNubL.position.set(
          nubRest.L.x - d.spread * 0.12,
          nubRest.L.y + d.spread * 0.08,
          nubRest.L.z
        );
        threadNubR.position.set(
          nubRest.R.x + d.spread * 0.12,
          nubRest.R.y - d.spread * 0.08,
          nubRest.R.z
        );

        // Legs splay outward and go limp.
        legs.forEach((legPivot, i) => {
          const sideX = i % 2 === 0 ? 1 : -1; // FR/BR=+x, FL/BL=-x
          const sideZ = i < 2 ? 1 : -1; // front/back
          legPivot.rotation.x = sideZ * d.spread * 0.9;
          legPivot.rotation.z = sideX * d.spread * 0.6;
        });

        // Thread tail unspools further and further as the skein comes apart.
        tailPivot.rotation.z = d.spread * 0.5;
        tailPivot.rotation.x = -d.spread * 0.3;
        tailMid.rotation.z = d.spread * 0.8;
        tailTip.rotation.z = d.spread * 1.1;

        headGroup.rotation.x = d.spread * 0.4;
        earPivotL.rotation.z = 0.3 + d.spread * 0.5;
        earPivotR.rotation.z = -0.3 - d.spread * 0.5;

        bodyGroup.scale.set(1, 1, 1); // keep puff spread readable, not squashed
        return; // death pose overrides everything else below
      }

      // Reset root/body scale in case a previous frame was mid-dissolve and
      // the mob got revived/recycled (defensive; animate() must never
      // assume ordering with the mob manager's own lifecycle).
      if (root.scale.x !== 1) root.scale.set(1, 1, 1);
      if (corners[0] && !corners[0].position.equals(cornerRest[0])) {
        corners.forEach((m, i) => m.position.copy(cornerRest[i]));
      }
      if (!sideL.position.equals(sideRest.L)) sideL.position.copy(sideRest.L);
      if (!sideR.position.equals(sideRest.R)) sideR.position.copy(sideRest.R);
      if (!threadNubL.position.equals(nubRest.L)) threadNubL.position.copy(nubRest.L);
      if (!threadNubR.position.equals(nubRest.R)) threadNubR.position.copy(nubRest.R);
      root.rotation.z = 0;

      // ---- Idle: wool jiggle breathe + independent drift -----------------
      const breatheAmt = rig.breathe(time, 1.2, 1);
      bodyGroup.scale.set(1 + breatheAmt * 0.5, 1 + breatheAmt, 1 + breatheAmt * 0.5);
      const idleBob = breatheAmt * 0.5;

      const idleAmt = 1 - speed01;
      headGroup.rotation.z = rig.sway(time, 0.6, 1, 0) * idleAmt;
      headGroup.position.y = 0.32 + rig.sway(time, 0.3, 1.3, 0.5) * idleAmt * 0.02;
      earPivotL.rotation.x = rig.sway(time, 0.8, 1.4, 0.2) * idleAmt;
      earPivotR.rotation.x = rig.sway(time, 0.8, 1.4, 1.1) * idleAmt;
      threadNubL.rotation.z = rig.sway(time, 1, 1.1, 0.8);
      threadNubR.rotation.z = rig.sway(time, 1, 1.1, 2.1);

      // Occasional head/thread twitch — a short flick every few seconds,
      // driven by a sawtooth-ish pulse so it reads as a discrete twitch
      // rather than a continuous wobble.
      const twitchCycle = time % 4.0; // repeats every 4 seconds
      let twitch = 0;
      if (twitchCycle < 0.3) {
        twitch = Math.sin((twitchCycle / 0.3) * Math.PI) * 0.35;
      }
      headGroup.rotation.y = twitch * 0.5 + lean * 0.4;

      // Thread tail sway: a lazy pendulum on the whole chain plus a lagged,
      // larger-amplitude wave down through the mid/tip segments so it reads
      // as a loose dangling thread rather than a rigid stick, with the
      // periodic twitch above giving it an extra little flick. Streams back
      // a little further as speed rises.
      const stream = speed01 * 0.25;
      tailPivot.rotation.z = Math.sin(time * 1.1) * 0.14 + twitch * 0.5;
      tailPivot.rotation.x = Math.cos(time * 0.9) * 0.05 + stream * 0.3;
      tailMid.rotation.z = Math.sin(time * 1.1 + 0.6) * 0.22 + twitch * 0.7;
      tailTip.rotation.z = Math.sin(time * 1.1 + 1.2) * 0.3 + twitch * 0.9 + stream * 0.4;

      // ---- Hop/flinch on hurt: a quick upward pop that decays, plus a
      // body squash for impact feedback. ----
      const hop = Math.sin(Math.min(hurt, 1) * Math.PI) * 0.18;
      const squash = 1 - hurt * 0.15;

      root.position.y = hop + idleBob * (1 - hurt);
      if (hurt > 0) {
        bodyGroup.scale.y *= squash;
        bodyGroup.scale.x *= 1 + hurt * 0.08;
        bodyGroup.scale.z *= 1 + hurt * 0.08;
        earPivotL.rotation.x -= 0.35 * hurt;
        earPivotR.rotation.x -= 0.35 * hurt;
        headGroup.rotation.x = -0.2 * hurt;
      }

      // ---- Walk cycle: real diagonal-pair 4-leg trot via rig.walkPhase,
      // scaled by state.speed01, plus a small footfall bounce. ----
      const walk = rig.walkPhase(time, speed01, 2.4);
      const idleShuffle = idleAmt * 0.04;
      legs.forEach((legPivot, i) => {
        const key = i === 0 ? walk.FR : i === 1 ? walk.FL : i === 2 ? walk.BR : walk.BL;
        const idleDrift = Math.sin(time * 1.3 + i * 1.7) * idleShuffle;
        legPivot.rotation.x = key + idleDrift;
        legPivot.rotation.z = lean * 0.15 * (i % 2 === 0 ? 1 : -1);
      });
      root.position.y += walk.lift * 0.05;
      bodyGroup.rotation.z = lean * 0.5;
      bodyGroup.rotation.x = Math.sin(time * 2.4 * (0.35 + 0.65 * speed01)) * 0.02 * speed01;

      // ---- Telegraph / attack anticipation overlay (a Skeinling is
      // passive and normally never drives this, but the rig must still
      // handle it gracefully): a small headbutt-style wind-up + snap. ----
      if (telegraph > 0 || attack > 0) {
        const wind = rig.windUp(telegraph);
        const strikeAmt = rig.strike(attack);
        headGroup.rotation.x += wind * 0.18 + strikeAmt * 0.3;
        headGroup.position.z = 0.32 + strikeAmt * 0.06;
        tailTip.rotation.x = -wind * 0.2;
      } else {
        headGroup.position.z = 0.32;
      }
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
    }
  };

  // Feet-at-y0 sanity: leg pivot at y=HIP_Y=LEG_H+HOOF_H=0.18. Leg mesh is
  // centered at -LEG_H/2 with half-height LEG_H/2, so its bottom is
  // HIP_Y - LEG_H = 0.04. Hoof is centered at -(LEG_H+HOOF_H/2) with
  // half-height HOOF_H/2, so its bottom is HIP_Y - LEG_H - HOOF_H = 0.0
  // (and its top at 0.04 meets the leg mesh's bottom with no gap).

  return root;
}

export const meta = {
  archetype: 'grazer',
  species: 'Skeinling',
  canonicalId: 'skeinling',
  dimensionDefault: 'warpwold',
  palette: {
    wool: '#F2EAD8',
    woolShade: '#DCCDB0',
    dun: '#B8A47E',
    eye: '#8A7350',
    thread: '#C9938A',
  },
  description:
    'A plump, round ball of living wool that grazes the fields of Warpwold. ' +
    'Its cream-oatmeal fleece is stray Thrum caught in loose thread, shaded ' +
    'to a deeper oatmeal along its flanks and underside, with two small ' +
    'ear-tufts and stray thread-ends fraying from its sides. It trots on ' +
    'four short stubby dun legs tipped with tiny dark hoof-nubs, tucks a ' +
    'small button-eyed, dark-muzzled head under its fluff, and trails one ' +
    'loose dyed-red thread as a swaying tail.',
};
