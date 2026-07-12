import * as THREE from 'three';
import * as rig from '../anim/rig.js';

// ============================================================================
// WICKERKIN — a friendly, neutral Warpwold trader woven of wicker/basketwork.
// Archetype: trader
//
// Loomfall lore: a Wickerkin is a basketwork golem given a quiet, contented
// mind by a spool of Thrum wound too tight to ever fully unspool. It walks
// the roads of Warpwold trading thread, buttons and small woven goods, never
// hostile, humming to itself as it waddles.
//
// Silhouette goals (per design brief): an upright hourglass/barrel WOVEN
// torso (alternating light/dark box strips read as a basket weave, plus
// crossed diagonal weave accents so the pattern still reads at thumbnail
// size), a wide asymmetric-brimmed WOVEN HAT with a hanging cord + tassel,
// a diagonal cloth strap crossing to a small satchel bag slung at one hip
// (asymmetric secondary silhouette, distinctly not a symmetrical robe-block),
// small beady eyes, two short two-bone arms — one holding a little
// wound-thread spool — and short stubby legs finished with dark woven-
// sandal feet. Never hostile: idle is a gentle bob + slow humming head-sway,
// walk is a small waddle. Deliberately NOT a Minecraft villager — no big
// flat nose, no robe-block silhouette, no cylindrical hat. This is a
// basket-woven person wearing a hat. Boxes only.
// ============================================================================

// ---- Palette (canonical Wickerkin bestiary palette, all five used) --------
const PALETTE = {
  wicker: 0xe8d9b5, // warm wicker cream — main weave material
  weaveDark: 0x7c6136, // darker weave lines — alternating basket strips, hat
  sash: 0xa5854e, // woven tan cloth sash / satchel strap / hat cord
  spool: 0xc9a86a, // wicker-tan spool/satchel accent / buttons / tassel
  eye: 0x3e2f1c, // small beady eyes / hands / sandal feet
};

// Plain centered box mesh.
function box(w, h, d, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Box mesh with its origin shifted to the TOP center of the geometry, so it
// can be parented to a hip/shoulder/elbow pivot and swing naturally from
// that pivot point rather than from its own center.
function hangingBox(w, h, d, material) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(0, -h / 2, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Defensive numeric coercion — never let a missing/NaN state field poison a
// transform. Mirrors rig.js's internal guards for the arithmetic that
// happens directly in this file.
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
  root.name = 'Wickerkin';

  // ---- Materials (all five palette colors used) --------------------------
  const wickerMat = new THREE.MeshStandardMaterial({
    color: PALETTE.wicker,
    roughness: 0.85,
    metalness: 0.0,
  });
  const weaveDarkMat = new THREE.MeshStandardMaterial({
    color: PALETTE.weaveDark,
    roughness: 0.85,
    metalness: 0.0,
  });
  const hatMat = new THREE.MeshStandardMaterial({
    color: PALETTE.weaveDark,
    roughness: 0.8,
    metalness: 0.0,
  });
  const sashMat = new THREE.MeshStandardMaterial({
    color: PALETTE.sash,
    roughness: 0.7,
    metalness: 0.0,
  });
  const spoolMat = new THREE.MeshStandardMaterial({
    color: PALETTE.spool,
    roughness: 0.55,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.spool),
    emissiveIntensity: 0.08,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: PALETTE.eye,
    roughness: 0.9,
    metalness: 0.0,
  });

  // ---- bodyGroup: everything that bobs/breathes together ------------------
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  // ---- Legs — short stubby legs capped with a small dark woven-sandal
  // foot. Pivot at HIP_Y = LEG_H + FOOT_H so feet always land at y=0. -------
  const LEG_H = 0.16;
  const FOOT_H = 0.05;
  const HIP_Y = LEG_H + FOOT_H; // 0.21
  function buildLeg(x) {
    const hipPivot = new THREE.Group();
    hipPivot.position.set(x, HIP_Y, 0);
    bodyGroup.add(hipPivot);

    const legMesh = hangingBox(0.13, LEG_H, 0.13, weaveDarkMat);
    hipPivot.add(legMesh);

    // Small dark sandal foot — a touch wider/deeper than the leg so a very
    // simple stubby limb still "grounds" visually against the floor plane.
    const footMesh = box(0.15, FOOT_H, 0.17, eyeMat);
    footMesh.position.set(0, -(LEG_H + FOOT_H / 2), 0.02);
    hipPivot.add(footMesh);

    return { hipPivot, legMesh, footMesh };
  }
  const legL = buildLeg(-0.13);
  const legR = buildLeg(0.13);

  // ---- Torso — hourglass/barrel WOVEN silhouette --------------------------
  // Built from stacked strip-boxes narrowing at the waist. The wicker-BROWN
  // tones (sash tan / weave dark) are the dominant fill on every band, with
  // the pale wicker cream reserved for the thin accent stripes only — so the
  // body reads as woven basketwork first and "pale robe" never.
  const torsoLower = box(0.46, 0.16, 0.40, sashMat);
  torsoLower.position.set(0, 0.30, 0);
  bodyGroup.add(torsoLower);

  const torsoLowerStripe = box(0.47, 0.05, 0.41, wickerMat);
  torsoLowerStripe.position.set(0, 0.24, 0);
  bodyGroup.add(torsoLowerStripe);

  const torsoWaist = box(0.34, 0.16, 0.30, weaveDarkMat);
  torsoWaist.position.set(0, 0.46, 0);
  bodyGroup.add(torsoWaist);

  const torsoWaistStripe = box(0.35, 0.05, 0.31, spoolMat);
  torsoWaistStripe.position.set(0, 0.40, 0);
  bodyGroup.add(torsoWaistStripe);

  const torsoUpper = box(0.44, 0.20, 0.38, sashMat);
  torsoUpper.position.set(0, 0.65, 0);
  bodyGroup.add(torsoUpper);

  const torsoUpperStripe = box(0.45, 0.05, 0.39, wickerMat);
  torsoUpperStripe.position.set(0, 0.57, 0);
  bodyGroup.add(torsoUpperStripe);

  // Crossed diagonal weave accents, doubled up side-by-side per zone (and
  // added on the waist too) so the over-under basket lattice reads as a
  // repeating grid across the whole chest instead of one thin X — this is
  // the actual "wicker" texture cue the silhouette was missing.
  function buildWeaveCross(y, z, span, material, xOffsets) {
    const rotDefs = [0.55, -0.55];
    const strips = [];
    xOffsets.forEach((x) => {
      rotDefs.forEach((rot) => {
        const strip = box(0.032, span, 0.02, material);
        strip.position.set(x, y, z);
        strip.rotation.z = rot;
        bodyGroup.add(strip);
        strips.push(strip);
      });
    });
    return strips;
  }
  const weaveCrossLower = buildWeaveCross(0.30, 0.19, 0.24, weaveDarkMat, [-0.11, 0.11]);
  const weaveCrossWaist = buildWeaveCross(0.46, 0.155, 0.14, wickerMat, [0]);
  const weaveCrossUpper = buildWeaveCross(0.65, 0.18, 0.22, weaveDarkMat, [-0.10, 0.10]);

  // Woven cloth sash, worn diagonally-ish across the waist (kept axis-
  // aligned as a simple wrap band for the voxel style), with three small
  // spool-tan buttons spread HORIZONTALLY along its front — deliberately not
  // a vertical column, so they read as sash decoration rather than beads
  // dangling off a rod.
  const sash = box(0.36, 0.07, 0.32, sashMat);
  sash.position.set(0, 0.46, 0);
  sash.rotation.y = Math.PI / 10;
  bodyGroup.add(sash);

  const buttonGeo = () => box(0.035, 0.035, 0.03, spoolMat);
  const buttons = [-0.09, 0, 0.09].map((x) => {
    const btn = buttonGeo();
    btn.position.set(x, 0.46, 0.205);
    bodyGroup.add(btn);
    return btn;
  });

  // Diagonal satchel strap crossing the UPPER chest/shoulder only (short,
  // kept well clear of the sash/buttons band below it) to a small bag slung
  // at the left hip — an asymmetric secondary silhouette element so the
  // Wickerkin doesn't read as a perfectly symmetric robe-block, and no
  // longer overlaps the buttons into a "held rod with dangling beads" read.
  const strap = box(0.05, 0.32, 0.045, sashMat);
  strap.position.set(0.15, 0.64, 0.19);
  strap.rotation.z = 0.55;
  bodyGroup.add(strap);

  const bagGroup = new THREE.Group();
  bagGroup.position.set(-0.28, 0.40, 0.02);
  bodyGroup.add(bagGroup);
  const bag = box(0.16, 0.18, 0.13, weaveDarkMat);
  bagGroup.add(bag);
  const bagStripe = box(0.17, 0.05, 0.14, spoolMat);
  bagStripe.position.set(0, 0.01, 0);
  bagGroup.add(bagStripe);

  // ---- Head — small, sits atop the torso on its own sway pivot -----------
  // Everything that should visually "belong" to the head (face, eyes, hat,
  // hat cord) is parented under headPivot so a head-sway rotation carries
  // the whole face+hat together instead of the eyes/hat staying locked in
  // world space while only the head box itself turns.
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.90, 0);
  bodyGroup.add(headPivot);

  const head = box(0.30, 0.24, 0.28, sashMat);
  headPivot.add(head);

  // A thin cream weave band across the brow — keeps the same basket-strip
  // texture cue going onto the face instead of leaving it a flat panel.
  const headWeaveBand = box(0.305, 0.035, 0.02, wickerMat);
  headWeaveBand.position.set(0, 0.085, 0.145);
  headPivot.add(headWeaveBand);

  // Small beady eyes.
  const eyeL = box(0.045, 0.045, 0.02, eyeMat);
  eyeL.position.set(-0.08, 0.02, 0.145);
  headPivot.add(eyeL);

  const eyeR = box(0.045, 0.045, 0.02, eyeMat);
  eyeR.position.set(0.08, 0.02, 0.145);
  headPivot.add(eyeR);

  // ---- Wide-brimmed woven hat, with hand-woven scalloped corners so the
  // brim edge reads as organic basketwork rather than a flat cylinder/disc.
  // The brim is deliberately off-centered/rotated and the scallops sized
  // unevenly — a lopsided, hand-woven brim rather than the perfectly
  // symmetric conical hat silhouette that recalls the Wandering Trader.
  const hatBrim = box(0.58, 0.05, 0.54, hatMat);
  hatBrim.position.set(0.025, 0.13, -0.015);
  hatBrim.rotation.y = 0.14;
  headPivot.add(hatBrim);

  const scallopDefs = [
    { x: 0.25, z: 0.23, size: 0.10, tilt: 0.20 },
    { x: -0.23, z: 0.25, size: 0.065, tilt: -0.13 },
    { x: 0.22, z: -0.26, size: 0.11, tilt: 0.22 },
    { x: -0.26, z: -0.21, size: 0.075, tilt: -0.15 },
  ];
  const hatScallops = scallopDefs.map(({ x, z, size, tilt }) => {
    const tab = box(size, 0.03, size, hatMat);
    tab.position.set(x, 0.12, z);
    tab.rotation.y = Math.PI / 4;
    tab.rotation.x = tilt;
    headPivot.add(tab);
    return tab;
  });
  // Baked rest tilt for each scallop, captured so the death dissolve below
  // can offset from the true rest pose every frame (an absolute assignment)
  // instead of drifting further and further from it on every tick.
  const scallopBaseRotX = hatScallops.map((tab) => tab.rotation.x);

  const hatCrownLower = box(0.30, 0.10, 0.30, hatMat);
  hatCrownLower.position.set(0, 0.20, 0);
  headPivot.add(hatCrownLower);

  const hatCrownTop = box(0.20, 0.08, 0.20, spoolMat);
  hatCrownTop.position.set(0, 0.28, 0);
  headPivot.add(hatCrownTop);

  // A small hanging hat cord with a spool-tan tassel bead — dangles by the
  // cheek, giving the hat weight/character and something extra to sway in
  // animate().
  const hatCord = hangingBox(0.02, 0.20, 0.02, sashMat);
  hatCord.position.set(0.22, 0.13, 0.18);
  hatCord.rotation.z = -0.18;
  headPivot.add(hatCord);

  const hatTassel = box(0.045, 0.045, 0.045, spoolMat);
  hatTassel.position.set(0, -0.21, 0);
  hatCord.add(hatTassel);

  // Head anchor for name tags — attached directly to root (not headPivot)
  // so it bobs gently with the whole body but never jitters with the head
  // sway/hat sway animation, fixed just above the hat's peak.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 1.32, 0);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // A distinct wound-thread spool prop — bottom flange / bulging thread
  // core / top flange, an unmistakable bobbin silhouette (not a plain cube)
  // so it never reads as an ambiguous bead or berry.
  function buildSpool() {
    const g = new THREE.Group();
    const flangeBottom = box(0.13, 0.025, 0.13, weaveDarkMat);
    flangeBottom.position.set(0, -0.05, 0);
    g.add(flangeBottom);
    const threadCore = box(0.095, 0.08, 0.095, spoolMat);
    threadCore.position.set(0, 0, 0);
    g.add(threadCore);
    const flangeTop = box(0.13, 0.025, 0.13, weaveDarkMat);
    flangeTop.position.set(0, 0.05, 0);
    g.add(flangeTop);
    return g;
  }

  // ---- Arms — short two-bone arms (shoulder + elbow) so the swing reads
  // as a real limb rather than a single rigid stick. Arms are woven in the
  // SASH tan (not pale wicker cream) so they read as distinct woven limbs
  // rather than blending into the torso; right hand holds a little wound
  // spool, held out clear of the body silhouette so the prop reads as a
  // held object rather than melting into the torso/strap. -----------------
  function buildArm(x, withSpool) {
    const shoulderPivot = new THREE.Group();
    shoulderPivot.position.set(x, 0.66, 0);
    bodyGroup.add(shoulderPivot);

    const upperArm = hangingBox(0.10, 0.11, 0.10, sashMat);
    shoulderPivot.add(upperArm);

    const elbowPivot = new THREE.Group();
    elbowPivot.position.set(0, -0.11, 0);
    shoulderPivot.add(elbowPivot);

    const forearm = hangingBox(0.085, 0.10, 0.085, sashMat);
    elbowPivot.add(forearm);

    const handCap = box(0.09, 0.05, 0.09, weaveDarkMat);
    handCap.position.set(0, -0.125, 0);
    elbowPivot.add(handCap);

    let spoolMesh = null;
    if (withSpool) {
      spoolMesh = buildSpool();
      spoolMesh.position.set(x > 0 ? 0.10 : -0.10, -0.20, 0.07);
      spoolMesh.rotation.z = x > 0 ? 0.18 : -0.18;
      elbowPivot.add(spoolMesh);
    }

    return { shoulderPivot, upperArm, elbowPivot, forearm, handCap, spoolMesh };
  }

  const armL = buildArm(-0.27, false);
  const armR = buildArm(0.27, true); // holds the little spool/satchel

  // ---- Store references for animate() -------------------------------------
  root.userData.parts = {
    bodyGroup,
    headPivot,
    head,
    legL,
    legR,
    armL,
    armR,
    bagGroup,
    strap,
    hatCord,
    hatTassel,
    hatScallops,
    weaveCrossLower,
    weaveCrossWaist,
    weaveCrossUpper,
  };

  // Rest positions captured once so the death dissolve can spread parts
  // outward relative to where they actually started, and so a revived/
  // recycled instance can be reset cleanly instead of drifting.
  const restSpoolPos = armR.spoolMesh ? armR.spoolMesh.position.clone() : null;
  const restBagPos = bagGroup.position.clone();
  const weaveAll = [...weaveCrossLower, ...weaveCrossWaist, ...weaveCrossUpper];
  const restWeavePos = weaveAll.map((m) => m.position.clone());

  // -------------------------------------------------------------------
  // ANIMATION
  //
  // Idle:    rig.breathe drives a gentle "humming" body bob/scale pulse,
  //          rig.sway independently drifts the head (carrying the hat +
  //          cord + tassel + eyes with it since they're all parented under
  //          headPivot) so the Wickerkin never looks frozen at rest.
  // Walk:    rig.walkPhase drives a small anti-phase two-leg waddle scaled
  //          by state.speed01, with a hip roll, counter-swinging two-bone
  //          arms, and the satchel bag pendulum-swinging off the stride.
  // Turn:    state.turn banks the body gently into turns (rig.damp smoothed).
  // Hurt:    a quick, small decaying dip + backward tilt — a friendly flinch,
  //          not an aggressive reaction, since Wickerkin is never hostile.
  // Attack:  Wickerkin never attacks, but the rig still answers
  //          state.telegraph/state.attack gracefully with a harmless
  //          "clutches its spool protectively" defensive flinch via
  //          rig.windUp/rig.strike, so it never looks broken if something
  //          upstream ever drives those fields.
  // Death:   rig.dissolve(state.dying) unravels the weave: limbs splay
  //          outward and go limp, the torso weave-cross accents peel off
  //          the body, the satchel strap comes loose and the bag swings
  //          away, the spool tumbles free, and the whole body sinks and
  //          shrinks away — a thread-unravel, not gore.
  // -------------------------------------------------------------------
  let prevT = null;
  let lean = 0;

  root.userData.animate = (t, state) => {
    try {
      const parts = root.userData.parts;
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

      // Lean gently into turns, damped so it never snaps.
      const leanTarget = dying > 0 ? 0 : Math.max(-0.22, Math.min(0.22, -turn * 0.35));
      lean = rig.damp(lean, leanTarget, 8, dt || 0.016);

      // ---- DEATH: thread-unravel dissolve --------------------------------
      if (dying > 0) {
        const d = rig.dissolve(dying);
        const sc = Math.max(0.05, d.scale);
        root.scale.set(sc, sc, sc);
        root.position.y = -d.drop * 0.35;
        root.rotation.z = lean * 0.3;

        bodyGroup.rotation.x = d.spread * 0.25; // slumps forward as it comes apart
        bodyGroup.scale.set(1, 1, 1); // keep the spread readable, not squashed

        legL.hipPivot.rotation.z = -d.spread * 0.8;
        legL.hipPivot.rotation.x = d.spread * 0.4;
        legR.hipPivot.rotation.z = d.spread * 0.8;
        legR.hipPivot.rotation.x = d.spread * 0.4;

        armL.shoulderPivot.rotation.z = -d.spread * 1.0;
        armL.shoulderPivot.rotation.x = -d.spread * 0.5;
        armL.elbowPivot.rotation.x = d.spread * 0.7;
        armR.shoulderPivot.rotation.z = d.spread * 1.0;
        armR.shoulderPivot.rotation.x = -d.spread * 0.5;
        armR.elbowPivot.rotation.x = d.spread * 0.7;

        if (armR.spoolMesh && restSpoolPos) {
          armR.spoolMesh.position.set(
            restSpoolPos.x + d.spread * 0.10,
            restSpoolPos.y - d.spread * 0.06,
            restSpoolPos.z + d.spread * 0.08
          );
          armR.spoolMesh.rotation.x = d.spread * 3.2;
        }

        headPivot.rotation.x = -d.spread * 0.35; // head lolls back/loose
        hatCord.rotation.x = d.spread * 0.6;
        hatScallops.forEach((tab, i) => {
          tab.rotation.x = scallopBaseRotX[i] + (i % 2 === 0 ? 1 : -1) * d.spread * 0.5;
        });

        // Satchel strap slips loose and the bag swings away from the hip.
        strap.rotation.x = d.spread * 0.4;
        bagGroup.position.set(
          restBagPos.x - d.spread * 0.12,
          restBagPos.y - d.spread * 0.14,
          restBagPos.z
        );
        bagGroup.rotation.z = d.spread * 0.7;

        // The basket-weave cross accents peel outward off the torso — the
        // weave itself coming undone.
        weaveAll.forEach((strip, i) => {
          const rest = restWeavePos[i];
          const side = i % 2 === 0 ? 1 : -1;
          strip.position.set(rest.x + side * d.spread * 0.10, rest.y, rest.z + d.spread * 0.12);
        });

        return; // death pose overrides everything else below
      }

      // Reset in case a previous frame was mid-dissolve and the mob got
      // revived/recycled (defensive; animate() must never assume ordering
      // with the mob manager's own lifecycle).
      if (root.scale.x !== 1) root.scale.set(1, 1, 1);
      if (bagGroup.position.x !== restBagPos.x) bagGroup.position.copy(restBagPos);
      if (armR.spoolMesh && restSpoolPos && armR.spoolMesh.position.x !== restSpoolPos.x) {
        armR.spoolMesh.position.copy(restSpoolPos);
        armR.spoolMesh.rotation.set(0, 0, 0);
      }
      weaveAll.forEach((strip, i) => {
        const rest = restWeavePos[i];
        if (strip.position.z !== rest.z) strip.position.copy(rest);
      });
      root.rotation.z = 0;
      strap.rotation.x = 0;

      // ---- Idle: gentle humming bob + independent head/hat sway ---------
      const breatheAmt = rig.breathe(time, 1.1, 1);
      bodyGroup.scale.set(1 + breatheAmt * 0.5, 1 + breatheAmt, 1 + breatheAmt * 0.5);
      let bobY = breatheAmt * 0.5;

      const swayAmt = 1 - speed01 * 0.4; // still hums a little while walking
      headPivot.rotation.y = rig.sway(time, 1.4, 1, 0) * swayAmt + lean * 0.5;
      headPivot.rotation.z = rig.sway(time, 0.5, 0.75, 1.0) * swayAmt;
      hatCord.rotation.z = -0.18 + rig.sway(time, 0.9, 1.4, 0.4) * swayAmt;
      hatTassel.rotation.x = rig.sway(time, 1.2, 1.6, 0.8) * swayAmt;

      // ---- Waddle walk: rig.walkPhase's FR/FL pair is already a clean
      // anti-phase two-beat cycle, reused here directly for a two-legged
      // waddle. Amplitude and cadence both fade to ~0 as speed01 -> 0, so
      // there is no separate moving/idle branch needed for the legs. -------
      const walk = rig.walkPhase(time, speed01, 2.1);
      legL.hipPivot.rotation.x = walk.FL;
      legR.hipPivot.rotation.x = walk.FR;

      const hipRoll = (walk.FR - walk.FL) * 0.14;
      bodyGroup.rotation.z = hipRoll + lean;

      // Arms counter-swing the legs for balance; the spool-hand sways its
      // little satchel along with the motion.
      armL.shoulderPivot.rotation.x = -walk.FL * 0.55;
      armR.shoulderPivot.rotation.x = -walk.FR * 0.55;
      armL.elbowPivot.rotation.x = Math.max(0, -walk.FL) * 0.4;
      armR.elbowPivot.rotation.x = Math.max(0, -walk.FR) * 0.4;

      // The satchel bag pendulum-swings off the stride while moving and
      // settles into a slow idle drift while standing still.
      const idleAmt = 1 - speed01;
      bagGroup.rotation.z = Math.sin(time * 2.1 * (0.35 + 0.65 * speed01) + 1.2) * 0.10 * speed01
        + rig.sway(time, 0.5, 1.1, 2.0) * idleAmt * 0.5;

      bobY += walk.lift * 0.045;

      // ---- Friendly flinch on hurt — a quick, small decaying dip + tilt
      // rather than an aggressive reaction, since Wickerkin is never
      // hostile. `headTiltX` accumulates as a local this frame only, then
      // is assigned once at the end — never incremented directly onto
      // headPivot.rotation.x across frames, which would drift unbounded
      // over a sustained multi-frame hurt/telegraph window. ----
      let headTiltX = 0;
      if (hurt > 0) {
        const h = Math.min(hurt, 1);
        bobY -= Math.sin(h * Math.PI) * 0.05;
        bodyGroup.rotation.x = Math.sin(h * Math.PI) * 0.10;
        headTiltX -= 0.18 * h;
      } else {
        bodyGroup.rotation.x = 0;
      }

      // ---- Telegraph / attack overlay — Wickerkin never attacks, but the
      // rig must still answer these fields gracefully: it clutches its
      // spool protectively during a telegraph and eases back afterward. ----
      if (telegraph > 0 || attack > 0) {
        const wind = rig.windUp(telegraph);
        const strikeAmt = rig.strike(attack);
        armR.shoulderPivot.rotation.x += wind * 0.18 - strikeAmt * 0.08;
        armR.elbowPivot.rotation.x += -wind * 0.22;
        headTiltX += wind * 0.10;
      }
      headPivot.rotation.x = headTiltX;

      root.position.y = bobY;
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
    }
  };

  return root;
}

export const meta = {
  archetype: 'trader',
  species: 'Wickerkin',
  canonicalId: 'wickerkin',
  dimensionDefault: 'warpwold',
  palette: {
    wicker: '#E8D9B5',
    weaveDark: '#7C6136',
    sash: '#A5854E',
    spool: '#C9A86A',
    eye: '#3E2F1C',
  },
  description:
    'A friendly, neutral Warpwold trader woven entirely of wicker and ' +
    'basketwork: a barrel-shaped woven torso banded with alternating tan ' +
    'and dark weave strips crossed with diagonal weave accents, a wide ' +
    'scalloped-brim woven hat with a dangling cord and tassel, small beady ' +
    'eyes, a tan cloth sash with wound-thread buttons, a satchel strap and ' +
    'bag slung at one hip, and a little wound spool of thread held in one ' +
    'hand. Hums gently and waddles when it walks; never hostile.',
};
