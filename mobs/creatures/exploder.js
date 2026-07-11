import * as THREE from 'three';
import * as rig from '../anim/rig.js';

// ============================================================================
// WAXLING — a hostile Cinderloom candle-creature that fuses then bursts.
// Archetype: exploder
//
// Silhouette goals (per design brief): SQUAT and BLOBBY, wider than tall —
// never a tall tower, never a stack of flat tiers. The body is built from
// overlapping CHAMFERED PUFF CLUSTERS (a core mass plus diagonal corner
// puffs, twisted off-axis and sized/offset unevenly) the same way the
// Loomfall bestiary's other "soft creature" bodies round off their edges —
// so from every angle the outline reads as a lumpy, wobbly ball of tallow
// wax instead of a stepped pyramid of boxes. Two short, fat, rounded
// drip-stump LEGS (each a stubby shin plus a wider rounded foot puff) sell
// "hops to move" at a glance; smaller asymmetric drip nubs around the base
// read as dripping wax rather than placeholder greeble. A single blackened
// braided WICK pokes straight up out of the crown, tapering through three
// twisted segments and capped with a small ember-colored tip nub that
// carries a permanent low ember glow (even unlit/at rest) so the wick never
// reads as a flat, dead cylinder — that glow then ramps hard as state.fuse
// climbs. A dashed candle-mold SEAM ring runs around the equator and a
// small pressed ember-SEAL badge sits on the chest below two glowing sunken
// eyes — original textile-adjacent "stitched/stamped" secondary detail that
// reads at thumbnail size and ties it to the wider Loomfall bestiary without
// resembling anything Minecraft/Mojang. As state.fuse climbs toward 1 the
// wick catches — brightening to ember-orange — the seal badge glows
// brighter (a countdown rune), the whole body swells, and its seams glow
// warm, looking about to pop. On state.dying it doesn't shatter — it MELTS:
// sinks, spreads, and its wick guts out.
//
// Palette: the warm gold/amber tones (tallowShade + amberDrip) are the
// DOMINANT surface colors across the body, corner puffs, and legs; the
// palest tallow tone is reserved for a small crown highlight and the seam
// ring so it reads as an accent, not a washed-out majority tone.
// ============================================================================

// ---- Palette (canonical Waxling bestiary palette — all five used) --------
const PALETTE = {
  tallow: 0xf7e7b8,      // pale tallow wax — crown highlight + seam accent only
  tallowShade: 0xe8c87a, // warm shaded wax — DOMINANT body tone (core/undercrown/legs)
  amberDrip: 0xd4a94f,   // amber wax — DOMINANT corner-puff/drip/leg tone
  ember: 0xb37e2e,       // ember-orange — eyes, chest-seal, wick-catch target
  wick: 0x7a4e1c,        // blackened braided wick (unlit)
};

// Defensive numeric coercion — mirrors rig.js's internal num()/clamp01 so the
// arithmetic done directly in this file never gets poisoned by a missing or
// NaN upstream state field.
function n(v, fallback = 0) {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : fallback;
}
function clamp01(v) {
  const x = n(v, 0);
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Plain centered box mesh.
function box(w, h, d, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Box mesh with its origin shifted to the TOP center of the geometry, so it
// can be parented to a shoulder pivot and hang/swing downward naturally.
function hangingBox(w, h, d, material) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(0, -h / 2, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// A single "chamfer puff": a box offset from the body center and twisted
// off-axis, meant to overlap a larger core box just enough that the combined
// silhouette rounds off instead of showing the core's sharp corners. This is
// the building block that turns a stack of flat-sided boxes into a lumpy,
// rounded wax-blob read.
function puff(w, h, d, material, x, y, z, twistY = 0, twistX = 0) {
  const mesh = box(w, h, d, material);
  mesh.position.set(x, y, z);
  mesh.rotation.y = twistY;
  mesh.rotation.x = twistX;
  return mesh;
}

export function build() {
  const root = new THREE.Group();
  root.name = 'Waxling';

  // ---- Materials ---------------------------------------------------------
  // tallowMat / tallowShadeMat / amberDripMat all carry a warm emissive that
  // we ramp up with fuse so the whole body's seams "glow warmer" as it
  // nears bursting.
  const tallowMat = new THREE.MeshStandardMaterial({
    color: PALETTE.tallow,
    roughness: 0.5,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.ember),
    emissiveIntensity: 0.0,
  });
  const tallowShadeMat = new THREE.MeshStandardMaterial({
    color: PALETTE.tallowShade,
    roughness: 0.48,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.ember),
    emissiveIntensity: 0.0,
  });
  const amberDripMat = new THREE.MeshStandardMaterial({
    color: PALETTE.amberDrip,
    roughness: 0.38,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.ember),
    emissiveIntensity: 0.05,
  });
  const emberMat = new THREE.MeshStandardMaterial({
    color: PALETTE.ember,
    roughness: 0.35,
    metalness: 0.05,
    emissive: new THREE.Color(PALETTE.ember),
    emissiveIntensity: 0.25,
  });
  const wickMat = new THREE.MeshStandardMaterial({
    color: PALETTE.wick,
    roughness: 0.85,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.ember),
    emissiveIntensity: 0.18,
  });

  // ---- bodyGroup: everything that wobbles/swells/hops together -----------
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  // ---- Core wax mass — squat, wide, DOMINANT warm-shaded tone. ------------
  const core = box(0.56, 0.28, 0.52, tallowShadeMat);
  core.position.set(0, 0.27, 0);
  bodyGroup.add(core);

  // ---- Four diagonal corner puffs — amber, twisted off-axis, sized/offset
  // unevenly and overlapping the core generously. This is what kills the
  // "flat-sided crate" read: there is no single hard edge left uninterrupted
  // by an overlapping puff, so the silhouette rounds off into a lumpy blob
  // from every viewing angle instead of showing a stepped-tier outline.
  const cornerFR = puff(0.27, 0.25, 0.25, amberDripMat, 0.27, 0.25, 0.20, -0.42);
  const cornerFL = puff(0.25, 0.23, 0.26, amberDripMat, -0.28, 0.28, 0.19, 0.38);
  const cornerBR = puff(0.26, 0.24, 0.23, amberDripMat, 0.26, 0.23, -0.19, -0.35);
  const cornerBL = puff(0.24, 0.26, 0.24, amberDripMat, -0.27, 0.26, -0.20, 0.4);
  bodyGroup.add(cornerFR, cornerFL, cornerBR, cornerBL);

  // Flank side puffs — fill the concave gap between each pair of corner
  // puffs so the flanks read as a continuous curve rather than a visible
  // notch between two lumps.
  const sideL = puff(0.13, 0.22, 0.34, tallowShadeMat, -0.34, 0.27, 0.0, 0.06);
  const sideR = puff(0.13, 0.22, 0.34, tallowShadeMat, 0.34, 0.27, 0.0, -0.06);
  bodyGroup.add(sideL, sideR);

  // ---- Under-crown — a smaller tapering puff cluster that transitions the
  // wide core up toward the crown WITHOUT a hard single-step ledge (the
  // previous flat topCap-on-core stack is what read as an "architectural
  // stepped pyramid"). Rounded the same core+corner-puff way, just smaller.
  const underCrown = box(0.38, 0.15, 0.35, tallowShadeMat);
  underCrown.position.set(0, 0.44, -0.01);
  bodyGroup.add(underCrown);
  const underCrownFR = puff(0.15, 0.13, 0.14, amberDripMat, 0.16, 0.43, 0.13, -0.4);
  const underCrownFL = puff(0.14, 0.14, 0.13, amberDripMat, -0.16, 0.44, 0.12, 0.36);
  const underCrownBR = puff(0.13, 0.12, 0.14, amberDripMat, 0.15, 0.42, -0.12, -0.3);
  const underCrownBL = puff(0.14, 0.13, 0.13, amberDripMat, -0.15, 0.43, -0.13, 0.33);
  bodyGroup.add(underCrownFR, underCrownFL, underCrownBR, underCrownBL);

  // ---- Crown cap — the palest tallow tone, used ONLY here plus the seam
  // ring, so it reads as a highlight accent rather than a washed-out
  // majority tone. Small rounded dome tapering toward the wick base.
  const crown = box(0.24, 0.12, 0.22, tallowMat);
  crown.position.set(0, 0.54, -0.02);
  bodyGroup.add(crown);
  const crownFR = puff(0.1, 0.09, 0.1, tallowMat, 0.09, 0.54, 0.08, -0.4);
  const crownFL = puff(0.09, 0.1, 0.09, tallowMat, -0.09, 0.54, 0.07, 0.4);
  bodyGroup.add(crownFR, crownFL);

  // ---- Bottom puff — rounds the underside above the legs, amber-dominant
  // so the palette pop continues all the way to the ground instead of
  // stopping at a few accent cubes.
  const bottomPuff = box(0.5, 0.16, 0.46, amberDripMat);
  bottomPuff.position.set(0, 0.15, 0);
  bodyGroup.add(bottomPuff);
  const bottomFR = puff(0.16, 0.11, 0.15, tallowShadeMat, 0.2, 0.12, 0.16, -0.3);
  const bottomFL = puff(0.15, 0.1, 0.16, tallowShadeMat, -0.2, 0.13, 0.15, 0.3);
  bodyGroup.add(bottomFR, bottomFL);

  // ---- Legs — two short, FAT, rounded drip-stump legs (shin + wider foot
  // puff each) that plant flush at y=0. Deliberately chunky and symmetric so
  // "hop locomotion" reads immediately, instead of the old thin peg nubs.
  function buildLeg(x) {
    const shin = box(0.2, 0.16, 0.2, amberDripMat);
    shin.position.set(x, 0.09, 0.08);
    bodyGroup.add(shin);
    const foot = box(0.17, 0.09, 0.18, tallowShadeMat);
    foot.position.set(x, 0.045, 0.09);
    bodyGroup.add(foot);
    return { shin, foot };
  }
  const legL = buildLeg(-0.23);
  const legR = buildLeg(0.23);

  // Smaller asymmetric drip nubs — irregular sizes/offsets so they read as
  // dripping wax caught mid-melt rather than tidy placeholder greeble.
  const dripBackL = box(0.11, 0.11, 0.1, amberDripMat);
  dripBackL.position.set(-0.17, 0.08, -0.21);
  bodyGroup.add(dripBackL);
  const dripBackR = box(0.09, 0.13, 0.1, amberDripMat);
  dripBackR.position.set(0.16, 0.07, -0.2);
  bodyGroup.add(dripBackR);

  // The "money" drip — a larger amber drip hanging off the front center,
  // overlapping the bottom puff so it never looks like it's floating free.
  const dripFrontCenter = box(0.15, 0.16, 0.14, amberDripMat);
  dripFrontCenter.position.set(0, 0.11, 0.28);
  bodyGroup.add(dripFrontCenter);

  const drips = [legL.shin, legL.foot, legR.shin, legR.foot, dripBackL, dripBackR, dripFrontCenter];

  // ---- Dashed seam ring — a candle-mold seam stitched around the equator.
  // Uses the palest tallow tone so it pops against the amber corner puffs
  // as a distinct highlight ring instead of blending into the body mass.
  const seamDashes = [];
  const SEAM_COUNT = 10;
  const SEAM_RADIUS = 0.36;
  for (let i = 0; i < SEAM_COUNT; i++) {
    const ang = (i / SEAM_COUNT) * Math.PI * 2;
    const dash = box(0.06, 0.03, 0.03, tallowMat);
    dash.position.set(Math.sin(ang) * SEAM_RADIUS, 0.27, Math.cos(ang) * SEAM_RADIUS);
    dash.rotation.y = ang;
    bodyGroup.add(dash);
    seamDashes.push(dash);
  }

  // ---- Chest wax-seal badge — two crossed ember diamonds pressed into the
  // lower front of the wax like a stamped seal, set BELOW the eyes (was
  // co-planar/overlapping before, reading as a cluster of stray notches).
  // Strong, glowing, thumbnail-readable palette pop that doubles as a
  // "countdown rune": its emissive brightens with fuse right alongside the
  // wick.
  const sealA = box(0.09, 0.09, 0.02, emberMat);
  sealA.position.set(0, 0.18, 0.27);
  sealA.rotation.z = Math.PI / 4;
  bodyGroup.add(sealA);
  const sealB = box(0.05, 0.05, 0.03, emberMat);
  sealB.position.set(0, 0.18, 0.28);
  sealB.rotation.z = Math.PI / 4;
  bodyGroup.add(sealB);

  // Two sunken glowing eyes pressed into the front of the wax, sitting flush
  // on the core's own front face (not floating past it) and clearly above
  // the seal so the front reads as face-then-badge, not a jumble.
  const eyeL = box(0.06, 0.06, 0.02, emberMat);
  eyeL.position.set(-0.13, 0.3, 0.27);
  bodyGroup.add(eyeL);

  const eyeR = box(0.06, 0.06, 0.02, emberMat);
  eyeR.position.set(0.13, 0.3, 0.27);
  bodyGroup.add(eyeR);

  // ---- Wick — braided, pokes straight up out of the crown. Three tapering
  // segments alternate a small twist so it reads as twisted/braided instead
  // of a plain cylinder-of-cubes, capped with a small dedicated ember-tip
  // nub that carries a permanent low glow (see animate()) so the wick never
  // reads as flat/unlit even at rest.
  const wickBase = box(0.09, 0.12, 0.09, wickMat);
  wickBase.position.set(0, 0.62, -0.02);
  wickBase.rotation.y = 0.2;
  bodyGroup.add(wickBase);
  const wickMid = box(0.07, 0.11, 0.07, wickMat);
  wickMid.position.set(0.01, 0.72, -0.02);
  wickMid.rotation.y = -0.28;
  bodyGroup.add(wickMid);
  const wickTip = box(0.05, 0.1, 0.05, wickMat);
  wickTip.position.set(0.005, 0.81, -0.02);
  wickTip.rotation.y = 0.32;
  bodyGroup.add(wickTip);
  const wickEmber = box(0.045, 0.05, 0.045, emberMat);
  wickEmber.position.set(0, 0.885, -0.02);
  bodyGroup.add(wickEmber);

  // Head anchor for name tags — fixed above the wick's maximum (fully
  // fused/swollen) height so the tag never dips below the flame tip.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 1.16, 0);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // ---- Tiny stubby arms — echo the drip-lobe "feet" motif with a small
  // amber drip-cuff, adding a pop of accent color to the arm silhouette.
  function buildArm(x) {
    const shoulderPivot = new THREE.Group();
    shoulderPivot.position.set(x, 0.28, 0.03);
    bodyGroup.add(shoulderPivot);

    const armMesh = hangingBox(0.09, 0.15, 0.09, tallowShadeMat);
    shoulderPivot.add(armMesh);

    const cuff = box(0.1, 0.05, 0.1, amberDripMat);
    cuff.position.set(0, -0.155, 0);
    shoulderPivot.add(cuff);

    return { shoulderPivot, armMesh, cuff };
  }

  const armL = buildArm(-0.36);
  const armR = buildArm(0.36);

  // ---- Store references for animate() ------------------------------------
  root.userData.parts = {
    bodyGroup,
    wickBase,
    wickMid,
    wickTip,
    wickEmber,
    wickMat,
    tallowMat,
    tallowShadeMat,
    amberDripMat,
    emberMat,
    eyeL,
    eyeR,
    sealA,
    sealB,
    seamDashes,
    drips,
    armL,
    armR,
  };

  // -------------------------------------------------------------------
  // ANIMATION
  //
  // Idle:     rig.breathe drives the wax-wobble breathing pulse; rig.sway
  //           drifts the arms independently so the blob never looks frozen.
  // Hop:      rig.walkPhase's FR/FL pair (a clean half-cycle-offset
  //           oscillator pair) drives the two stubby arms flailing for
  //           balance in opposition, while its `lift` drives the hop height
  //           and a landing squash-and-stretch, all scaled by state.speed01.
  // Fuse:     wick brightens/shifts toward ember-orange, the chest seal
  //           glows like a countdown rune, the body swells, and near 1 it
  //           jitters faster — about to pop. The wick-tip ember carries a
  //           low base glow even at fuse=0 so it never reads unlit.
  // Telegraph/
  // Attack:   rig.windUp coils the body inward/down (an inhale before the
  //           pop), rig.strike snaps it into an explosive outward burst —
  //           arms flung wide, seal/eyes flashing white-hot.
  // Hurt:     a quick decaying upward flinch + squash, eyes flare.
  // Death:    NOT a shatter — a MELT. rig.dissolve(state.dying) drives the
  //           body sinking/shrinking while the legs, drip-lobes and arms
  //           spread outward at ground level (a puddle forming) and the
  //           wick guts out, rather than limbs flying apart.
  // -------------------------------------------------------------------
  const wickTargetColor = new THREE.Color(PALETTE.ember);
  const wickBaseColor = new THREE.Color(PALETTE.wick);

  // Rest-pose offsets captured once so death/attack poses can spread/coil
  // relative to where each part actually started, not an assumed origin.
  const dripRest = drips.map((d) => d.position.clone());
  const armRestL = armL.shoulderPivot.position.clone();
  const armRestR = armR.shoulderPivot.position.clone();

  let prevT = null;
  let lean = 0;

  root.userData.animate = (t, state) => {
    try {
      const s = state || {};
      const time = n(t, 0);
      let dt = 0;
      if (prevT !== null) dt = Math.max(0, Math.min(0.12, time - prevT));
      prevT = time;

      const parts = root.userData.parts;
      const moving = !!s.moving;
      const fuse = clamp01(s.fuse);
      const hurt = clamp01(s.hurt);
      const dying = clamp01(s.dying);
      const telegraph = clamp01(s.telegraph);
      const attack = clamp01(s.attack);
      const phase = Math.max(0, n(s.phase, 0));
      const turn = n(s.turn, 0);
      const speed01 = clamp01(s.speed01 != null ? s.speed01 : (moving ? 1 : 0));

      // Lean into turns — a small hop-wobble tilt toward the turn direction,
      // damped so it never snaps.
      const leanTarget = dying > 0 ? 0 : Math.max(-0.28, Math.min(0.28, -turn * 0.4));
      lean = rig.damp(lean, leanTarget, 8, dt || 0.016);

      // ---- DEATH: melt, don't shatter -----------------------------------
      if (dying > 0) {
        const d = rig.dissolve(dying);
        const sc = Math.max(0.05, d.scale);
        // Melts flatter than it shrinks — squash Y harder than X/Z so the
        // body reads as sinking into a puddle rather than uniformly
        // vanishing.
        bodyGroup.scale.set(
          sc * (1 + d.spread * 0.35),
          Math.max(0.04, sc * (1 - dying * 0.55)),
          sc * (1 + d.spread * 0.35)
        );
        root.position.y = -d.drop * 0.22;

        // Legs and drip-lobes spread outward along the ground — a puddle
        // forming — instead of flinging into the air.
        drips.forEach((drip, i) => {
          const rest = dripRest[i];
          const dir = new THREE.Vector3(rest.x, 0, rest.z);
          if (dir.lengthSq() < 1e-6) dir.set(i % 2 === 0 ? 1 : -1, 0, 0);
          dir.normalize();
          drip.position.set(
            rest.x + dir.x * d.spread * 0.22,
            rest.y * (1 - dying * 0.6),
            rest.z + dir.z * d.spread * 0.22
          );
        });

        // Arms droop and splay limp, as if softening.
        armL.shoulderPivot.rotation.z = 0.3 + d.spread * 0.5;
        armR.shoulderPivot.rotation.z = -0.3 - d.spread * 0.5;
        armL.shoulderPivot.rotation.x = d.spread * 0.3;
        armR.shoulderPivot.rotation.x = d.spread * 0.3;

        // The wick guts out — leans over and fades to black.
        wickBase.rotation.z = d.spread * 0.9;
        wickMid.rotation.z = d.spread * 1.1;
        wickTip.rotation.z = d.spread * 1.3;
        parts.wickMat.color.copy(wickBaseColor);
        parts.wickMat.emissiveIntensity = Math.max(0, (1 - dying) * 0.5);
        parts.emberMat.emissiveIntensity = 0.25 * (1 - dying);

        // Seal/eyes/seams all fade out as the last of the heat dies.
        const fade = 1 - dying;
        parts.amberDripMat.emissiveIntensity = 0.05 * fade;
        parts.tallowMat.emissiveIntensity = 0;
        parts.tallowShadeMat.emissiveIntensity = 0;

        return; // death pose overrides everything else below
      }

      // Reset transforms in case a previous frame was mid-death and the mob
      // got revived/recycled (defensive; animate() must never assume
      // ordering with the mob manager's own lifecycle).
      if (bodyGroup.scale.x !== 1 || bodyGroup.scale.y !== 1 || bodyGroup.scale.z !== 1) {
        bodyGroup.scale.set(1, 1, 1);
      }
      if (drips[0] && !drips[0].position.equals(dripRest[0])) {
        drips.forEach((drip, i) => drip.position.copy(dripRest[i]));
      }
      wickBase.rotation.z = 0;
      wickMid.rotation.z = 0;
      wickTip.rotation.z = 0;

      // ---- Idle breathing — always active, gets jittery near burst ------
      const jitterFreq = 1 + fuse * 3.2;
      const breatheAmt = rig.breathe(time, 1, jitterFreq) + rig.breathe(time, fuse * 0.8, jitterFreq * 2.7);

      // Fuse swell — the body inflates as it approaches bursting.
      const swell = 1 + fuse * 0.2;

      let scaleX = swell + breatheAmt * 0.6;
      let scaleY = swell + breatheAmt;
      let scaleZ = swell + breatheAmt * 0.6;

      // ---- Hop cycle — rig.walkPhase's FR/FL pair drives the two arms
      // flailing in opposition, `lift` drives hop height + a landing
      // squash-and-stretch. Cadence quickens with fuse (nervous,
      // about-to-pop hopping) as well as speed01.
      const hopFreq = 2.6 + fuse * 1.8;
      const hop = rig.walkPhase(time, moving ? speed01 : 0, hopFreq);
      const idleAmt = 1 - (moving ? speed01 : 0);

      const hopHeight = 0.16;
      let hopY = hop.lift * hopHeight * (moving ? 1 : 0);

      // Squash on the ground (lift≈0), stretch mid-air (lift≈1).
      scaleY *= 0.92 + hop.lift * 0.12 * (moving ? 1 : 0);
      scaleX *= 1.04 - hop.lift * 0.06 * (moving ? 1 : 0);
      scaleZ *= 1.04 - hop.lift * 0.06 * (moving ? 1 : 0);

      if (moving) {
        armL.shoulderPivot.rotation.z = hop.FR * 0.9 + 0.15;
        armR.shoulderPivot.rotation.z = -hop.FL * 0.9 - 0.15;
        armL.shoulderPivot.rotation.x = hop.FL * 0.4;
        armR.shoulderPivot.rotation.x = -hop.FR * 0.4;
      } else {
        // Idle: gentle independent arm drift + a very small idle bob.
        armL.shoulderPivot.rotation.z = 0.1 + rig.sway(time, 1, 1.4, 0) * 0.4;
        armR.shoulderPivot.rotation.z = -0.1 - rig.sway(time, 1, 1.4, 1.6) * 0.4;
        armL.shoulderPivot.rotation.x = 0;
        armR.shoulderPivot.rotation.x = 0;
        hopY += rig.sway(time, 0.4, 1.1, 0) * 0.02;
      }

      // Hurt flinch — a quick decaying upward jolt + squash.
      if (hurt > 0) {
        hopY += Math.sin(Math.min(hurt, 1) * Math.PI) * 0.1;
        scaleY *= 1 - hurt * 0.12;
        scaleX *= 1 + hurt * 0.06;
        scaleZ *= 1 + hurt * 0.06;
      }

      // ---- Telegraph / attack: wind-up coil then explosive strike -------
      let attackScaleMul = 1;
      if (telegraph > 0 || attack > 0) {
        const wind = rig.windUp(telegraph); // 0 -> briefly past -1 -> -1
        const strikeAmt = rig.strike(attack); // fast release 0..1

        // Wind-up: coils inward/down, like drawing a breath before the pop.
        attackScaleMul *= 1 + wind * 0.1;
        hopY += wind * 0.05;
        armL.shoulderPivot.rotation.z -= wind * 0.3;
        armR.shoulderPivot.rotation.z += wind * 0.3;

        // Strike: explosive outward burst — arms fling wide, body spikes.
        attackScaleMul *= 1 + strikeAmt * 0.55;
        armL.shoulderPivot.rotation.z -= strikeAmt * 0.9;
        armR.shoulderPivot.rotation.z += strikeAmt * 0.9;
        armL.shoulderPivot.rotation.x -= strikeAmt * 0.5;
        armR.shoulderPivot.rotation.x -= strikeAmt * 0.5;

        parts.emberMat.emissiveIntensity = 0.25 + strikeAmt * 3.0;
      }

      bodyGroup.scale.set(scaleX * attackScaleMul, scaleY * attackScaleMul, scaleZ * attackScaleMul);
      bodyGroup.rotation.z = lean;
      root.position.y = hopY;

      // ---- Wick: color lerps from blackened toward ember-orange, and its
      // emissive intensity carries a low BASE glow (so the shaft never reads
      // flat/unlit at rest) then ramps up sharply as fuse climbs; near full
      // fuse it flickers rapidly, like it's about to catch and burst. A
      // boss `phase` (if this mob is ever driven as one) nudges the glow up
      // a further notch per phase. The dedicated ember-tip nub (wickEmber)
      // shares emberMat with the eyes/seal, so it carries that material's
      // own always-on baseline glow (set below) without needing its own
      // formula — the very top of the wick visibly glows warm even when the
      // braided shaft itself is still dark.
      parts.wickMat.color.copy(wickBaseColor).lerp(wickTargetColor, fuse);
      const flicker = fuse > 0.8 ? Math.sin(time * 40) * 0.6 : 0;
      const wickGlow = 0.22 + fuse * 3.2 + flicker + phase * 0.3;
      parts.wickMat.emissiveIntensity = wickGlow;
      wickBase.scale.set(1 + fuse * 0.25, 1 + fuse * 0.1, 1 + fuse * 0.25);
      wickMid.scale.set(1 + fuse * 0.28, 1 + fuse * 0.12, 1 + fuse * 0.28);
      wickTip.scale.set(1 + fuse * 0.3, 1 + fuse * 0.15, 1 + fuse * 0.3);

      // Seams (shaded wax + amber drips + main wax) and the chest seal glow
      // warmer as the fuse rises — the seal doubles as a countdown rune.
      parts.tallowShadeMat.emissiveIntensity = fuse * 0.4;
      parts.amberDripMat.emissiveIntensity = 0.05 + fuse * 0.9;
      parts.tallowMat.emissiveIntensity = fuse * 0.35;
      if (!(telegraph > 0 || attack > 0)) {
        parts.emberMat.emissiveIntensity = 0.25 + fuse * 1.6 + (hurt > 0 ? hurt * 1.5 : 0);
      }
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
    }
  };

  return root;
}

export const meta = {
  archetype: 'exploder',
  species: 'Waxling',
  canonicalId: 'waxling',
  dimensionDefault: 'cinderloom',
  palette: {
    tallow: '#F7E7B8',
    tallowShade: '#E8C87A',
    amberDrip: '#D4A94F',
    ember: '#B37E2E',
    wick: '#7A4E1C',
  },
  description:
    'A hostile Cinderloom candle-creature: a squat, blobby mass of dripping ' +
    'tallow wax, its rounded body built from lumpy overlapping wax puffs in ' +
    'warm amber and gold. Two short, fat, rounded drip-stump legs plant it ' +
    'and power its hop, with smaller asymmetric drip nubs melting off its ' +
    'underside, a dashed candle-mold seam stitched around its equator, and a ' +
    'small pressed ember seal on its chest below two glowing sunken eyes. It ' +
    'flails two drip-cuffed stubby arms for balance as it hops. A single ' +
    'blackened braided wick pokes straight up from its crown, its tip ' +
    'carrying a faint ember glow even at rest — as the Thrum fuses within it, ' +
    'the wick catches and blazes toward ember-orange, the chest seal glows ' +
    'like a countdown rune, and the whole body swells and its seams glow ' +
    'warmer until it bursts. In death it does not shatter — it melts, ' +
    'sinking and spreading into a cooling puddle as its wick guts out.',
};
