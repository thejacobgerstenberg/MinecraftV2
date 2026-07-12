import * as THREE from 'three';
import * as rig from '../anim/rig.js';

// ---------------------------------------------------------------------------
// FRAYED HOUND — a hostile, nocturnal Warpwold pack-predator.
// Archetype: groaner base (reworked low & fast) — a mangy, thread-ridged
// canid that hunts in packs after dark. Loomfall lore: when a stray length
// of the Weaver's yarn is dragged loose from the Loom and left ungathered
// too long in the dark fields, it can knot itself into a hungry shape — a
// Frayed Hound. Its fur is not fur at all but thousands of trailing loose
// threads, mangy and thin, bristling into a ragged ridge along the spine,
// mottled with lighter frayed patches where the thread has worn thin and
// pale scar-plates where old knots have hardened into a shell.
//
// Silhouette goals: LOW, CROUCHED, four-legged canid, clearly longer than
// tall (~0.47u tall at the shoulder ridge — deliberately lower than the
// bestiary's other quadruped, whose HIP_Y=0.18 is a normal standing
// posture, not a crouch). An elongated snout with a visibly stitched jaw
// seam (including a rust-red stitched thread along it, visible even mouth
// closed) and a pair of enlarged hooked fangs. A ragged spine ridge built
// from TUFTS (paired strands, not lone rods) running from the base of the
// neck down the spine, alternating dark/pale/rust-red so it reads as a
// mangy, textured stripe rather than a fan of antennae even at thumbnail
// size. Raised shoulder blades and hardened flank + haunch scar-plates
// break up the torso volume with the palette's pale accent. Small frayed
// claw-tufts at each paw. A ragged, drooping tail. Taut, coiled-looking
// legs (never straight rigid pillars) built from hip+knee joints so the
// crouch and gait both read believably. NOT a Minecraft wolf — mangier,
// lower, meaner.
// ---------------------------------------------------------------------------

// Canonical Frayed Hound bestiary palette — all five hexes used as materials.
const PALETTE = {
  fur: 0x4a3f38,       // charcoal-brown thread-fur, main coat
  underside: 0x2e2620, // darker underside/belly/jaw/ear trim
  furShade: 0x6e6055,  // pale worn-thread accent — scar plates, claws, ridge, brow
  maw: 0xb3453a,       // sinew-red maw / inner mouth / fangs
  eye: 0x8c7d6e,        // pale stitched eyes, faint emissive
};

function makeMaterials() {
  return {
    fur: new THREE.MeshStandardMaterial({
      color: PALETTE.fur,
      roughness: 0.95,
      metalness: 0.0,
    }),
    underside: new THREE.MeshStandardMaterial({
      color: PALETTE.underside,
      roughness: 0.95,
      metalness: 0.0,
    }),
    furShade: new THREE.MeshStandardMaterial({
      color: PALETTE.furShade,
      roughness: 0.8,
      metalness: 0.0,
    }),
    maw: new THREE.MeshStandardMaterial({
      color: PALETTE.maw,
      roughness: 0.6,
      metalness: 0.0,
    }),
    eye: new THREE.MeshStandardMaterial({
      color: PALETTE.eye,
      roughness: 0.35,
      metalness: 0.05,
      emissive: new THREE.Color(PALETTE.eye),
      emissiveIntensity: 0.4,
    }),
  };
}

// Box mesh whose origin sits at its TOP center, so it can hang/droop off a
// joint pivot naturally — used for the tail chain, ridge threads and legs.
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
  root.name = 'Frayed Hound';

  const mat = makeMaterials();
  const parts = {};

  // Hip height above the ground for a low, crouched stance. Deliberately
  // lower than the pack's other quadruped (grazer's HIP_Y=0.18 at a normal
  // standing posture) so the hound reads as hunched-low even before any
  // animation is applied — a tall stance here was the #1 silhouette
  // failure flagged in review, so these two numbers are the load-bearing
  // fix: short legs, torso translated down with them.
  const HIP_Y = 0.21;
  const SHOULDER_Y = 0.24;

  // -------------------------------------------------------------------
  // SPINE/TORSO — a low, elongated, permanently crouched body. Built as
  // a pivot with a pronounced forward pitch so the whole silhouette reads
  // coiled/prowling rather than a flat rectangular box on stilts.
  // -------------------------------------------------------------------
  const spinePivot = new THREE.Group();
  spinePivot.position.set(0, SHOULDER_Y, 0);
  spinePivot.rotation.x = 0.11; // pronounced permanent forward hunch/crouch
  root.add(spinePivot);

  // Ribcage/chest — front mass, slightly raised toward the shoulders.
  // Shallower and a touch longer than before so the torso reads as a low,
  // elongated wedge rather than a tall box.
  const chest = box(0.22, 0.16, 0.32, mat.fur);
  chest.position.set(0, 0.02, 0.23);
  spinePivot.add(chest);

  // Shoulder blades — a small raised hump riding the top-front of the
  // chest. Cheapest possible silhouette upgrade: breaks the chest's flat
  // top edge and instantly reads as "coiled, muscled predator" even at
  // thumbnail size, with zero extra pivots to animate.
  const shoulderBlade = box(0.19, 0.06, 0.16, mat.fur);
  shoulderBlade.position.set(0, 0.105, 0.21);
  spinePivot.add(shoulderBlade);

  // Hindquarters — rear mass, coiled/bunched for a pouncing read. Kept
  // low and tucked in line with the chest (not raised above it) so it
  // reads as a continuous crouched haunch, not a separate stacked block.
  const haunches = box(0.24, 0.18, 0.29, mat.fur);
  haunches.position.set(0, -0.02, -0.23);
  spinePivot.add(haunches);

  // Waist — narrow connector between chest and haunches, tucked belly.
  const waist = box(0.16, 0.11, 0.21, mat.fur);
  waist.position.set(0, -0.03, 0.0);
  spinePivot.add(waist);

  // Belly/underside strip — darker, visible from beneath the tucked waist.
  const belly = box(0.15, 0.05, 0.46, mat.underside);
  belly.position.set(0, -0.095, 0.0);
  spinePivot.add(belly);

  // Flank scar-plates — a pair of small hardened furShade patches sticking
  // just past the chest's flanks, as if an old knot has hardened into a
  // shell there. Secondary detail + the palette's pale accent breaking up
  // an otherwise dark torso.
  const scarPlateL = box(0.02, 0.06, 0.09, mat.furShade);
  scarPlateL.position.set(-0.12, 0.0, 0.19);
  spinePivot.add(scarPlateL);
  const scarPlateR = box(0.02, 0.06, 0.09, mat.furShade);
  scarPlateR.position.set(0.12, 0.0, 0.19);
  spinePivot.add(scarPlateR);

  // Haunch mottling — a matching pair of pale worn-thread patches on the
  // rear mass so the mangy, frayed-fur read continues across the whole
  // torso instead of stopping at the front flanks. This is the main fix
  // for "flat single-tone brown" — a second, larger pale block visible
  // from the side and rear silhouette.
  const haunchPatchL = box(0.02, 0.08, 0.10, mat.furShade);
  haunchPatchL.position.set(-0.13, 0.0, -0.21);
  spinePivot.add(haunchPatchL);
  const haunchPatchR = box(0.02, 0.08, 0.10, mat.furShade);
  haunchPatchR.position.set(0.13, 0.0, -0.21);
  spinePivot.add(haunchPatchR);

  parts.spinePivot = spinePivot;

  // -------------------------------------------------------------------
  // SPINE RIDGE — a ragged line of frayed-thread TUFTS running from the
  // base of the neck down to the lower back (kept clear of the skull so
  // it reads as a spine ridge, not head spikes). Each cluster is TWO
  // strands of different width/height/material with a left-right jitter,
  // not one lone thin rod — a single row of isolated thin sticks is what
  // read as "antennae" in review, so the fix is volume + irregularity per
  // cluster rather than a wider gap-toothed fan. One cluster carries the
  // rust-red maw thread color so the palette's signature accent is woven
  // into the silhouette itself, visible from every angle and pose.
  // -------------------------------------------------------------------
  const ridge = [];
  const ridgeDefs = [
    { z: 0.26, h: 0.09, mat: mat.underside },  // neck base, set back from the skull
    { z: 0.17, h: 0.12, mat: mat.furShade },
    { z: 0.07, h: 0.14, mat: mat.underside },  // tallest, over the shoulders
    { z: -0.03, h: 0.13, mat: mat.maw },       // rust-red thread accent, mid-ridge
    { z: -0.13, h: 0.11, mat: mat.furShade },
    { z: -0.22, h: 0.09, mat: mat.underside },
    { z: -0.31, h: 0.06, mat: mat.furShade },  // lower back, tapering off
  ];
  ridgeDefs.forEach(({ z, h, mat: strandMat }, i) => {
    const pivot = new THREE.Group();
    pivot.position.set(0, 0.085, z);
    spinePivot.add(pivot);

    const jitter = i % 2 === 0 ? 1 : -1;

    // Primary strand of the tuft.
    const strandA = hangingBox(0.025, h, 0.022, strandMat);
    strandA.rotation.x = Math.PI; // flip so it points UP off the top pivot
    strandA.rotation.z = jitter * 0.14;
    pivot.add(strandA);

    // Secondary, shorter/thinner strand offset to the side — the pair
    // reads as a mangy tuft rather than a single isolated spike.
    const strandBMat = strandMat === mat.maw ? mat.maw : (i % 2 === 0 ? mat.furShade : mat.underside);
    const strandB = hangingBox(0.017, h * 0.7, 0.016, strandBMat);
    strandB.position.set(jitter * 0.03, 0, -0.012);
    strandB.rotation.x = Math.PI;
    strandB.rotation.z = -jitter * 0.24;
    pivot.add(strandB);

    ridge.push(pivot);
  });
  parts.ridge = ridge;

  // -------------------------------------------------------------------
  // HEAD — elongated snout on a low, forward-jutting neck.
  // -------------------------------------------------------------------
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.06, 0.34);
  headPivot.rotation.x = -0.06; // muzzle tips slightly down, prowling
  spinePivot.add(headPivot);

  const skull = box(0.13, 0.12, 0.16, mat.fur);
  skull.position.set(0, 0.06, 0.0);
  headPivot.add(skull);

  // Pale, worn brow ridge — a thin furShade band across the forehead,
  // the single detail that most reads as "this animal is frayed thread"
  // right where the eye lands first.
  const browRidge = box(0.12, 0.02, 0.03, mat.furShade);
  browRidge.position.set(0, 0.115, 0.05);
  headPivot.add(browRidge);

  // Elongated, leaner snout, tapering forward.
  const snout = box(0.095, 0.085, 0.20, mat.fur);
  snout.position.set(0, 0.03, 0.16);
  headPivot.add(snout);

  // Lower jaw — separate piece pivoted at the hinge so it can snap open.
  const jawPivot = new THREE.Group();
  jawPivot.position.set(0, 0.0, 0.10);
  headPivot.add(jawPivot);
  const jaw = box(0.085, 0.042, 0.18, mat.underside);
  jaw.position.set(0, -0.02, 0.07);
  jawPivot.add(jaw);

  // Sinew-red inner mouth, visible at the seam between snout and jaw.
  const maw = box(0.075, 0.032, 0.035, mat.maw);
  maw.position.set(0, -0.005, 0.0);
  jawPivot.add(maw);

  // A pair of hooked fangs at the front corners of the jaw — enlarged so
  // the rust-red palette accent reads clearly even at a distance, not
  // just a "this is hostile" cue up close.
  const fangGeo = { w: 0.022, h: 0.038, d: 0.022 };
  const fangL = box(fangGeo.w, fangGeo.h, fangGeo.d, mat.maw);
  fangL.position.set(-0.032, 0.005, 0.145);
  headPivot.add(fangL);
  const fangR = box(fangGeo.w, fangGeo.h, fangGeo.d, mat.maw);
  fangR.position.set(0.032, 0.005, 0.145);
  headPivot.add(fangR);

  // Stitched jaw seam trim, small dark strip along the muzzle underside.
  const jawSeam = box(0.09, 0.014, 0.19, mat.underside);
  jawSeam.position.set(0, 0.01, 0.16);
  headPivot.add(jawSeam);

  // Rust-red stitched seam thread laid right along the jaw seam — reads
  // as a thin red stitch-line the whole time the mouth is closed, so the
  // maw color isn't only visible during the (rare) wide-open bite frames.
  const jawSeamThread = box(0.092, 0.006, 0.20, mat.maw);
  jawSeamThread.position.set(0, 0.019, 0.16);
  headPivot.add(jawSeamThread);

  // Two pale stitched eyes, faint emissive glow.
  const eyeGeo = { w: 0.025, h: 0.025, d: 0.02 };
  const eyeL = box(eyeGeo.w, eyeGeo.h, eyeGeo.d, mat.eye);
  eyeL.position.set(-0.055, 0.08, 0.08);
  headPivot.add(eyeL);
  const eyeR = box(eyeGeo.w, eyeGeo.h, eyeGeo.d, mat.eye);
  eyeR.position.set(0.055, 0.08, 0.08);
  headPivot.add(eyeR);

  // Two low, back-swept ears — mangy triangular-ish stumps (boxes).
  const earPivotL = new THREE.Group();
  earPivotL.position.set(-0.05, 0.12, -0.03);
  headPivot.add(earPivotL);
  const earL = box(0.03, 0.08, 0.02, mat.underside);
  earL.position.set(0, 0.03, 0.0);
  earPivotL.add(earL);

  const earPivotR = new THREE.Group();
  earPivotR.position.set(0.05, 0.12, -0.03);
  headPivot.add(earPivotR);
  const earR = box(0.03, 0.08, 0.02, mat.underside);
  earR.position.set(0, 0.03, 0.0);
  earPivotR.add(earR);

  parts.headPivot = headPivot;
  parts.jawPivot = jawPivot;
  parts.earPivotL = earPivotL;
  parts.earPivotR = earPivotR;

  // Head anchor for name tags — above the head, low since the hound is low.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 0.46, 0.34);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // TAIL — a ragged, drooping chain of shrinking boxes off the rear.
  // Thickened slightly and anchored further back (matching the new,
  // longer haunch) so it reads clearly in silhouette instead of hiding
  // behind the rear mass.
  // -------------------------------------------------------------------
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.05, -0.36);
  tailPivot.rotation.x = 0.6; // droops down and back
  spinePivot.add(tailPivot);

  const tailBase = hangingBox(0.065, 0.19, 0.065, mat.fur);
  tailPivot.add(tailBase);

  const tailMid = new THREE.Group();
  tailMid.position.set(0, -0.17, -0.02);
  tailPivot.add(tailMid);
  const tailMidSeg = hangingBox(0.05, 0.15, 0.05, mat.underside);
  tailMid.add(tailMidSeg);

  const tailTip = new THREE.Group();
  tailTip.position.set(0, -0.14, -0.02);
  tailMid.add(tailTip);
  const tailTipSeg = hangingBox(0.035, 0.12, 0.035, mat.furShade);
  tailTip.add(tailTipSeg);

  parts.tailPivot = tailPivot;
  parts.tailMid = tailMid;
  parts.tailTip = tailTip;

  // -------------------------------------------------------------------
  // LEGS — taut, coiled quadruped legs built from hip/shoulder + knee
  // pivots so the crouch, idle prowl and fast gallop all read believably.
  // Front legs hang from the chest area, rear from the haunches. Each paw
  // carries a small frayed claw-tuft for secondary detail at the ground.
  // -------------------------------------------------------------------
  function buildLeg(x, z, upperLen, lowerLen, parentGroup) {
    const upperPivot = new THREE.Group();
    upperPivot.position.set(x, 0, z);
    parentGroup.add(upperPivot);

    const upperLeg = hangingBox(0.06, upperLen, 0.065, mat.fur);
    upperPivot.add(upperLeg);

    const kneePivot = new THREE.Group();
    kneePivot.position.set(0, -upperLen, 0);
    upperPivot.add(kneePivot);

    const lowerLeg = hangingBox(0.05, lowerLen, 0.055, mat.underside);
    kneePivot.add(lowerLeg);

    // Small frayed claw-tuft at the paw, furShade accent, bottom flush
    // with the foot so it reads as claws without breaking feet-at-y0.
    const claw = box(0.05, 0.025, 0.035, mat.furShade);
    claw.position.set(0, -lowerLen + 0.0125, 0.032);
    kneePivot.add(claw);

    return { upperPivot, kneePivot, upperLeg, lowerLeg, claw };
  }

  // Front legs pivot from a group at shoulder height under the chest.
  const frontLegsGroup = new THREE.Group();
  frontLegsGroup.position.set(0, SHOULDER_Y, 0.20);
  root.add(frontLegsGroup);
  const legFR = buildLeg(-0.09, 0, 0.11, 0.13, frontLegsGroup);
  const legFL = buildLeg(0.09, 0, 0.11, 0.13, frontLegsGroup);

  // Rear legs pivot from a group at hip height under the haunches.
  const rearLegsGroup = new THREE.Group();
  rearLegsGroup.position.set(0, HIP_Y, -0.23);
  root.add(rearLegsGroup);
  const legBR = buildLeg(-0.10, 0, 0.105, 0.105, rearLegsGroup);
  const legBL = buildLeg(0.10, 0, 0.105, 0.105, rearLegsGroup);

  // legs array in [FR, FL, BR, BL] order, matching rig.walkPhase's naming.
  const legs = [legFR, legFL, legBR, legBL];
  parts.legs = legs;
  parts.frontLegsGroup = frontLegsGroup;
  parts.rearLegsGroup = rearLegsGroup;

  // Feet-at-y0 sanity: frontLegsGroup at y=0.24, upper 0.11 + lower 0.13
  // = 0.24 reach -> foot bottom at 0.0. rearLegsGroup at y=0.21, upper
  // 0.105 + lower 0.105 = 0.21 reach -> foot bottom at 0.0. Claw center at
  // -lowerLen+0.0125 with half-height 0.0125 -> claw bottom also at
  // -lowerLen, flush with the foot.

  // -------------------------------------------------------------------
  // Store all animated sub-parts for animate() to reach.
  // -------------------------------------------------------------------
  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION — a real procedural rig built on mobs/anim/rig.js.
  //
  // Idle:      rig.breathe drives a low prowl bob on the spine, rig.sway
  //            drives a slow head-scan; spine-ridge threads waver
  //            independently at all times so the mangy read never goes
  //            fully still; ears occasionally pin back in a discrete
  //            twitch; tail droops with a slow ragged flick.
  // Walk:      rig.walkPhase drives a fast diagonal-pair gallop (FR+BL,
  //            FL+BR), stretched into a LONGER stride via extra reach
  //            amplitude that grows with state.speed01, with knee bend
  //            timed off a phase-shifted second walkPhase call so the
  //            lifted leg visibly folds instead of scissoring rigid. The
  //            spine pitches and surges with each stride pair and the
  //            whole body leans into state.turn.
  // Telegraph/
  // Attack:    rig.windUp pulls the head back and coils the hindquarters
  //            low (jaw-snap anticipation/growl) as state.telegraph rises,
  //            then rig.strike snaps the jaw wide and lunges the whole
  //            body forward off the coiled hind legs as state.attack fires.
  // Hurt:      a sharp jolt/flinch — spine twist, ears pinned, jaw bared.
  // Death:     rig.dissolve(state.dying) unravels the hound: legs splay
  //            outward, the spine ridge threads fling loose, the tail and
  //            ears go slack, the jaw sags open and the whole body sinks
  //            and shrinks away — a thread-unravel, never gore.
  // -------------------------------------------------------------------
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
      const speed01 = clamp01(s.speed01 != null ? s.speed01 : (moving ? 1 : 0));
      const hurt = clamp01(s.hurt);
      const attack = clamp01(s.attack);
      const telegraph = clamp01(s.telegraph);
      const dying = clamp01(s.dying);
      const turn = n(s.turn, 0);

      // Lean into turns, damped so it never snaps.
      const leanTarget = dying > 0 ? 0 : Math.max(-0.4, Math.min(0.4, -turn * 0.9));
      lean = rig.damp(lean, leanTarget, 10, dt || 0.016);

      // ---- DEATH: thread-unravel dissolve, overrides everything else ----
      if (dying > 0) {
        const d = rig.dissolve(dying);
        const sc = Math.max(0.05, d.scale);
        root.scale.set(sc, sc, sc);
        root.position.y = -d.drop * 0.3;
        root.rotation.z = lean * 0.15;

        legs.forEach((leg, i) => {
          const sideX = i % 2 === 0 ? -1 : 1; // FR/BR = -x, FL/BL = +x
          const sideZ = i < 2 ? 1 : -1; // front/back
          leg.upperPivot.rotation.x = sideZ * d.spread * 0.9;
          leg.upperPivot.rotation.z = sideX * d.spread * 0.8;
          leg.kneePivot.rotation.x = d.spread * 0.6;
        });

        // Spine-ridge threads fling loose in every direction.
        ridge.forEach((strandPivot, i) => {
          strandPivot.rotation.z = (i % 2 === 0 ? 1 : -1) * d.spread * 0.9;
          strandPivot.rotation.x = d.spread * 0.6;
        });

        earPivotL.rotation.x = -d.spread * 0.7;
        earPivotR.rotation.x = -d.spread * 0.7;
        headPivot.rotation.x = -0.06 + d.spread * 0.5; // head lolls back
        jawPivot.rotation.x = d.spread * 0.5; // jaw sags open

        tailPivot.rotation.x = 0.6 + d.spread * 0.5;
        tailMid.rotation.z = d.spread * 0.7;
        tailTip.rotation.z = -d.spread * 0.9;

        spinePivot.scale.set(1, 1, 1); // keep the spread readable, not squashed
        return;
      }

      // Reset root/spine transforms in case a previous frame was
      // mid-dissolve and the mob got revived/recycled (defensive; animate()
      // must never assume ordering with the mob manager's own lifecycle).
      if (root.scale.x !== 1) root.scale.set(1, 1, 1);
      root.rotation.z = 0;

      // ---- Idle breathing — always active, subtle low prowl bob. -------
      const breatheAmt = rig.breathe(time, 1, 1.1);
      spinePivot.scale.set(1 + breatheAmt * 0.6, 1 + breatheAmt, 1 + breatheAmt * 0.5);

      const idleAmt = 1 - speed01;
      const headScan = rig.sway(time, 0.8, 0.8, 0) * idleAmt;

      let bodyY = 0;
      let spineTiltX = 0.11;
      let spineZ = 0;

      if (hurt > 0) {
        // Sharp jolt/flinch — a fast lateral twist plus a startled crouch.
        spinePivot.rotation.z = Math.sin(time * 32) * hurt * 0.18;
        spineTiltX = 0.11 + hurt * 0.1;
        earPivotL.rotation.x = -0.55;
        earPivotR.rotation.x = -0.55;
        jawPivot.rotation.x = Math.max(0, jawPivot.rotation.x, hurt * 0.35);
        legs.forEach((leg) => {
          leg.kneePivot.rotation.x = 0.14 + hurt * 0.12;
        });
      } else {
        spinePivot.rotation.z = rig.damp(spinePivot.rotation.z, 0, 8, dt || 0.016);

        // --- Fast diagonal-pair gallop, stretched into a longer stride ---
        const strideFreq = 4.4;
        const walk = rig.walkPhase(time, speed01, strideFreq);
        // A second, phase-shifted sample drives knee flex so the lifted
        // leg visibly folds during its forward swing instead of scissoring
        // as two rigid rods — cheap, cadence-matched knee timing without
        // duplicating rig's internal stride math.
        const kneeWalk = rig.walkPhase(time + 0.055, speed01, strideFreq);
        const reach = 1.25 + speed01 * 0.55; // longer stride the faster it runs
        const kneeAmp = 1.0;
        const CROUCH_KNEE = 0.14;

        legFR.upperPivot.rotation.x = walk.FR * reach;
        legFL.upperPivot.rotation.x = walk.FL * reach;
        legBR.upperPivot.rotation.x = walk.BR * reach;
        legBL.upperPivot.rotation.x = walk.BL * reach;

        legFR.kneePivot.rotation.x = CROUCH_KNEE + Math.max(0, kneeWalk.FR) * kneeAmp;
        legFL.kneePivot.rotation.x = CROUCH_KNEE + Math.max(0, kneeWalk.FL) * kneeAmp;
        legBR.kneePivot.rotation.x = CROUCH_KNEE + Math.max(0, kneeWalk.BR) * kneeAmp;
        legBL.kneePivot.rotation.x = CROUCH_KNEE + Math.max(0, kneeWalk.BL) * kneeAmp;

        legs.forEach((leg, i) => {
          const sideX = i % 2 === 0 ? -1 : 1; // FR/BR = -x, FL/BL = +x
          leg.upperPivot.rotation.z = lean * 0.15 * sideX;
        });

        // Spine surges/pitches with each stride pair and crouches lower
        // overall while running, plus a small vertical lift-driven bob.
        spineTiltX = 0.11 + walk.FR * 0.09;
        bodyY = walk.lift * 0.05;
        spineZ = walk.lift * 0.01 - 0.005;

        // Ears pin flat back the faster it runs.
        const earPin = -0.5 * speed01;
        earPivotL.rotation.x = earPin;
        earPivotR.rotation.x = earPin;

        // Tail streams out behind, flatter and whipping faster with speed.
        tailPivot.rotation.x = 0.6 - speed01 * 0.4 + Math.sin(time * (3 + speed01 * 5)) * 0.06;
        tailMid.rotation.z = Math.sin(time * (4 + speed01 * 6) + 0.6) * (0.12 + speed01 * 0.18);
        tailTip.rotation.z = Math.sin(time * (4 + speed01 * 6) + 1.2) * (0.18 + speed01 * 0.24);
      }

      spinePivot.rotation.x = spineTiltX;
      spinePivot.position.z = spineZ;
      headPivot.rotation.y = headScan + lean * 0.3;

      if (hurt <= 0) {
        // Idle-only bits (ear twitch, low prowl bob) — faded out by
        // idleAmt so they vanish smoothly once the hound is at full speed.
        if (idleAmt > 0.01) {
          const prowl = time * 1.4;
          bodyY += Math.sin(prowl * 1.3) * 0.008 * idleAmt;

          const earCycle = time % 3.5;
          let earPin = 0;
          if (earCycle < 0.6) earPin = Math.sin((earCycle / 0.6) * Math.PI) * 0.55;
          earPivotL.rotation.x += -earPin * idleAmt;
          earPivotR.rotation.x += -earPin * idleAmt;
        }
      }

      // Spine-ridge threads waver independently at all times — the mangy,
      // frayed read of the creature never goes fully still.
      const ridgeSpeed = 1.6 + speed01 * 3.6;
      ridge.forEach((strand, i) => {
        strand.rotation.z = Math.sin(time * ridgeSpeed + i * 0.9) * (0.12 + speed01 * 0.12);
        strand.rotation.x = Math.cos(time * ridgeSpeed * 0.8 + i * 1.2) * 0.08;
      });

      // ---- Telegraph / attack overlay: jaw-snap wind-up + lunge --------
      // rig.windUp returns 0 at telegraph=0, sweeping down to (briefly past)
      // -1 as telegraph->1 — used directly as a "pull back and coil" pose.
      // rig.strike is a fast-forward 0..1 release used for the snap/lunge.
      if (telegraph > 0 || attack > 0) {
        const wind = rig.windUp(telegraph); // 0 .. ~-1.1 .. -1
        const strikeAmt = rig.strike(attack); // 0 .. 1, front-loaded

        // Head pulls back on wind-up, then lunges forward past rest on the
        // strike.
        headPivot.position.z = 0.34 + wind * 0.06 * (1 - strikeAmt) + strikeAmt * 0.12;
        // Jaw cracks part-open in a growl during wind-up, then snaps wide.
        jawPivot.rotation.x = Math.max(0, -wind) * 0.25 + strikeAmt * 0.55;

        // Hindquarters coil deeper (more knee bend) while winding up, then
        // drive the whole body forward in a lunge on the strike.
        const coil = Math.max(0, -wind);
        legBR.kneePivot.rotation.x += coil * 0.35;
        legBL.kneePivot.rotation.x += coil * 0.35;
        spinePivot.position.z += -coil * 0.02 + strikeAmt * 0.1;
        spinePivot.rotation.x += coil * 0.08;

        earPivotL.rotation.x = -0.55;
        earPivotR.rotation.x = -0.55;
      } else {
        headPivot.position.z = rig.damp(headPivot.position.z, 0.34, 12, dt || 0.016);
      }

      root.position.y = bodyY;
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
    }
  };

  return root;
}

export const meta = {
  archetype: 'groaner',
  species: 'Frayed Hound',
  canonicalId: 'frayed_hound',
  dimensionDefault: 'warpwold',
  palette: {
    fur: '#4A3F38',
    underside: '#2E2620',
    furShade: '#6E6055',
    maw: '#B3453A',
    eye: '#8C7D6E',
  },
  description:
    'A lean, hostile nocturnal pack-predator of Warpwold, knotted from a ' +
    'length of the Weaver\'s yarn dragged loose from the Loom and left ' +
    'ungathered too long in the dark fields. Its charcoal coat is not fur ' +
    'but thousands of trailing loose threads, mottled with pale worn ' +
    'patches and hardened scar-plates along its flanks, and bristling into ' +
    'a ragged, mangy-mottled ridge along its spine and neck. It crouches ' +
    'low on taut, coiled, claw-tufted legs, its elongated snout stitched ' +
    'shut but for a sinew-red maw and a pair of hooked fangs, its stitched ' +
    'eyes a faint pale glow in the night, and a ragged thread tail dragging ' +
    'behind as it coils low with a jaw-snap growl before lunging down prey ' +
    'in a long-strided, fast diagonal-pair gallop.',
};
