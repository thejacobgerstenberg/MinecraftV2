import * as THREE from 'three';
import * as rig from '../anim/rig.js';

// ============================================================================
// MOLTHKIN, THE FIRST BOBBIN — Cinderloom boss, the canonical wellspring of
// Everthread. Loomfall lore: before the Weaver ever set a shuttle moving,
// something in the deep Cinderloom seams had already begun to spin —
// molten ore drawn long and thin, cooling into the very first strand ever
// wound. Molthkin is that strand's spool grown monstrous: a colossal
// half-molten BOBBIN lying on its side, never fully cooled, never finished
// winding. Its two great end-discs sag and drip where centuries of forge-
// heat have never quite let them set; its banded barrel-body still turns
// slow amber thread to raw molten glow at the core; one long thread-arm,
// dragged loose from its own winding, rises off the top and falls in slow
// molten strikes. Menders who get too close report the same thing: it
// isn't hunting them so much as absent-mindedly winding them in — and
// anything caught risks coming out the other side unpicked, unwound,
// unmade, one more strand added to a spool that was never meant to stop.
//
// SILHOUETTE: colossal SPOOL on its side — barrel axis horizontal (local
// X). Two sagging, half-melted flat end-discs bookend a banded, glowing
// molten barrel ringed with fine wound-coil ridge ticks; continuous melt
// drips reach all the way to the floor from both disc rims and the barrel
// belly (real ground contact, not floating puddles); one long thread-arm,
// wound with cinch-bands and trailing a frayed thread tail off its glowing
// tip, rises off the top, wound back and ready to swing. Rivets, etched
// thread-grooves and ember motes carry the read down to thumbnail scale.
// ORIGINAL — a molten industrial spool, nothing here resembles Minecraft.
// ============================================================================

const PALETTE = {
  thread: 0xf2a03d,   // amber — wound thread, dominant barrel/arm color
  molten: 0xd94f1e,   // molten orange — barrel glow bands + drips, emissive
  scorched: 0x7a2a10, // scorched brown — end-disc body
  char: 0x2b0e06,     // near-black char — end-disc rims/shadow, hub mounts
  bright: 0xffe9b8,   // hottest bright — searing cracks + drip/arm tips, emissive
  tallow: 0xe8c87a,   // tallow — secondary barrel band + hub ring + rivets
};

function makeMaterials() {
  return {
    thread: new THREE.MeshStandardMaterial({
      color: PALETTE.thread,
      roughness: 0.6,
      metalness: 0.05,
    }),
    molten: new THREE.MeshStandardMaterial({
      color: PALETTE.molten,
      roughness: 0.4,
      metalness: 0.05,
      emissive: new THREE.Color(PALETTE.molten),
      emissiveIntensity: 0.9,
    }),
    scorched: new THREE.MeshStandardMaterial({
      color: PALETTE.scorched,
      roughness: 0.92,
      metalness: 0.02,
    }),
    char: new THREE.MeshStandardMaterial({
      color: PALETTE.char,
      roughness: 0.85,
      metalness: 0.05,
    }),
    bright: new THREE.MeshStandardMaterial({
      color: PALETTE.bright,
      roughness: 0.25,
      metalness: 0.05,
      emissive: new THREE.Color(PALETTE.bright),
      emissiveIntensity: 1.6,
    }),
    tallow: new THREE.MeshStandardMaterial({
      color: PALETTE.tallow,
      roughness: 0.7,
      metalness: 0.03,
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

// Defensive numeric coercion, mirroring rig.js's own internal guards, for
// the arithmetic that happens directly in this file (rig's own exports
// already self-guard, but locally-derived values need the same safety net).
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
  root.name = 'Molthkin, the First Bobbin';

  const mat = makeMaterials();
  const parts = {};

  // -------------------------------------------------------------------
  // Layout constants — spool axis runs along local X (lying on its
  // side); Y/Z form the circular cross-section. "Front" (+Z) is where
  // the eyes sit and where the thread-arm swings down toward. Ground
  // contact is real: both disc melt-drips and the center barrel drip
  // are sized so their tips sit exactly at y=0 at rest.
  // -------------------------------------------------------------------
  const discCenterY = 1.55;      // shared vertical center of the whole spool
  const discRadius = 1.35;       // end-disc fake-circle radius
  const discThickness = 0.4;     // end-disc thickness along X
  const barrelHalfExtent = 0.82; // barrel cross-section half-height/depth
  const barrelLength = 2.8;      // barrel span along X between disc faces
  const discX = barrelLength / 2 + discThickness / 2; // +/- disc center X

  // -------------------------------------------------------------------
  // BODY PIVOT — everything animated (creak, roll, hurt jolt) hangs off
  // this so headAnchor (a direct child of root) stays put for nametags.
  // -------------------------------------------------------------------
  const bodyPivot = new THREE.Group();
  bodyPivot.position.set(0, 0, 0);
  root.add(bodyPivot);
  parts.bodyPivot = bodyPivot;

  // -------------------------------------------------------------------
  // END DISCS — big flat "cylinders" faked from two crossed boxes plus a
  // 45-degree corner-fill box (rotated about the spool's own X axis, so
  // its Y/Z corners round out the silhouette), etched thread-groove scars,
  // a glowing spindle hub with a tallow washer ring and rivet studs, and
  // a three-part melt-drip that sags from the rim all the way to the
  // floor — real ground contact instead of a floating blob.
  function buildDisc(x, side) {
    const discGroup = new THREE.Group();
    discGroup.position.set(x, discCenterY, 0);
    bodyPivot.add(discGroup);

    const discMain = box(discThickness, discRadius * 2, discRadius * 1.4, mat.scorched);
    discGroup.add(discMain);

    const discCross = box(discThickness, discRadius * 1.4, discRadius * 2, mat.char);
    discGroup.add(discCross);

    // Flange rim — the 45-degree corner-fill box that rounds the octagon
    // silhouette is deliberately the LIGHT tallow tone (not char, which
    // reads as just another dark box against the scorched/char body) so
    // the circular flange edge is legible as a distinct bright ring at a
    // glance, instead of blending into a jumble of same-toned prisms.
    const discCornerFill = box(discThickness * 0.92, discRadius * 1.5, discRadius * 1.5, mat.tallow);
    discCornerFill.rotation.x = Math.PI / 4;
    discGroup.add(discCornerFill);

    // Axle stub — pokes straight out past the outer disc face along the
    // spool's spin axis with a bright end-cap, the single clearest "this
    // is a mounted cylindrical spool, not loose boxes" cue at thumbnail
    // scale.
    const axleLen = 0.55;
    const axleStub = box(axleLen, 0.22, 0.22, mat.char);
    axleStub.position.set((discThickness / 2 + axleLen / 2) * side, 0, 0);
    discGroup.add(axleStub);
    const axleCap = box(0.12, 0.3, 0.3, mat.tallow);
    axleCap.position.set((discThickness / 2 + axleLen) * side, 0, 0);
    discGroup.add(axleCap);

    // Etched thread-groove scars — two thin dark bars crossing the face at
    // shallow angles, reading as centuries of wound thread cutting grooves
    // into the rim. Cheap secondary detail, distinctly non-Minecraft.
    const grooveA = box(discThickness * 0.95, 0.05, discRadius * 1.75, mat.char);
    grooveA.rotation.x = 0.55 * side;
    discGroup.add(grooveA);
    const grooveB = box(discThickness * 0.95, 0.05, discRadius * 1.6, mat.char);
    grooveB.rotation.x = -0.35 * side;
    discGroup.add(grooveB);

    const hub = box(discThickness * 1.2, 0.34, 0.34, mat.bright);
    discGroup.add(hub);

    const hubRing = box(discThickness * 1.05, 0.6, 0.6, mat.tallow);
    discGroup.add(hubRing);
    // Hub must stay visually on top of the ring — nudge ring thickness
    // down so it reads as a flat washer, not an occluding box.
    hubRing.scale.set(0.34, 1, 1);

    // Rivet studs ringing the hub — small tallow bolts that break up the
    // flat hub face and sell "bobbin hardware" at thumbnail scale.
    const rivets = [0, 1, 2, 3].map((i) => {
      const a = (i / 4) * Math.PI * 2 + side * 0.4;
      const rr = 0.42;
      const rivet = box(discThickness * 0.55, 0.08, 0.08, mat.tallow);
      rivet.position.set(0, Math.sin(a) * rr, Math.cos(a) * rr);
      discGroup.add(rivet);
      return rivet;
    });

    // Melt-drip — three tapering segments flush with the disc's rounded
    // rim, sagging all the way down to the ground plane (world y=0) with
    // no gap, so the boss visibly rests its weight on its own melt.
    const rimY = -discRadius * 0.62;
    const floorY = -discCenterY;
    const totalH = rimY - floorY;
    const h1 = totalH * 0.5;
    const h2 = totalH * 0.3;
    const h3 = totalH * 0.2;
    const c1 = rimY - h1 / 2;
    const c2 = rimY - h1 - h2 / 2;
    const c3 = rimY - h1 - h2 - h3 / 2;
    const dripZ = discRadius * 0.15 + side * 0.04;

    const dripUpper = box(discThickness * 0.75, h1, 0.5, mat.molten);
    dripUpper.position.set(0, c1, dripZ);
    discGroup.add(dripUpper);
    const dripMid = box(discThickness * 0.6, h2, 0.34, mat.molten);
    dripMid.position.set(0, c2, dripZ);
    discGroup.add(dripMid);
    const dripTip = box(discThickness * 0.45, h3, 0.2, mat.bright);
    dripTip.position.set(0, c3, dripZ);
    discGroup.add(dripTip);

    // Loose thread wisp trailing off the upper rim — a stray, unwound
    // strand for the textile motif, independent of the ground-drips.
    const wisp = box(discThickness * 0.4, 0.4, 0.04, mat.thread);
    wisp.position.set(0, discRadius * 0.78, discRadius * 0.55);
    wisp.rotation.x = 0.5 * side;
    discGroup.add(wisp);

    const drip = { upper: dripUpper, mid: dripMid, tip: dripTip, baseH: [h1, h2, h3], baseC: [c1, c2, c3] };
    return {
      discGroup, discMain, discCross, discCornerFill, hub, hubRing, rivets,
      axleStub, axleCap, drip, wisp, side,
    };
  }

  const discL = buildDisc(-discX, -1);
  const discR = buildDisc(discX, 1);
  parts.discs = [discL, discR];

  // -------------------------------------------------------------------
  // BARREL — horizontal banded body between the discs: wound amber
  // thread shading into molten-orange glow bands, rounded with a single
  // long corner-fill box, fine wound-coil ridge ticks simulating
  // individual wraps, striped with searing crack seams, dotted with
  // ember motes, and hung with drip lobes (the center one grounded).
  // -------------------------------------------------------------------
  const barrelGroup = new THREE.Group();
  barrelGroup.position.set(0, discCenterY, 0);
  bodyPivot.add(barrelGroup);

  const barrelCornerFill = box(
    barrelLength * 0.98,
    barrelHalfExtent * 1.5,
    barrelHalfExtent * 1.5,
    mat.scorched
  );
  barrelCornerFill.rotation.x = Math.PI / 4;
  barrelGroup.add(barrelCornerFill);

  const bandCount = 5;
  const bandWidth = barrelLength / bandCount;
  const bandMats = [mat.thread, mat.molten, mat.tallow, mat.molten, mat.thread];
  const bands = [];
  for (let i = 0; i < bandCount; i++) {
    // Slightly irregular widths so the winding reads as organic, not a
    // machine-tiled repeat.
    const jitter = Math.sin(i * 2.4) * 0.06;
    const bx = -barrelLength / 2 + bandWidth * (i + 0.5);
    const band = box(
      bandWidth - 0.05 + jitter,
      barrelHalfExtent * 2,
      barrelHalfExtent * 1.7,
      bandMats[i]
    );
    band.position.set(bx, 0, 0);
    barrelGroup.add(band);
    bands.push(band);
  }
  parts.bands = bands;

  // Wound-coil ridge ticks — small raised marks along the top of the
  // barrel simulating individual thread wraps; a fine detail that reads
  // as texture at thumbnail scale without adding real geometric cost.
  const coilTicks = [];
  const tickCount = 7;
  for (let i = 0; i < tickCount; i++) {
    const tx = -barrelLength / 2 + (barrelLength / (tickCount - 1)) * i;
    const tick = box(0.05, 0.07, barrelHalfExtent * 1.75, i % 2 === 0 ? mat.tallow : mat.bright);
    tick.position.set(tx, barrelHalfExtent * 0.96, 0);
    barrelGroup.add(tick);
    coilTicks.push(tick);
  }
  parts.coilTicks = coilTicks;

  const crackTop = box(barrelLength * 0.92, 0.06, 0.06, mat.bright);
  crackTop.position.set(0, barrelHalfExtent * 0.92, barrelHalfExtent * 0.5);
  barrelGroup.add(crackTop);

  const crackSide = box(barrelLength * 0.55, 0.05, 0.05, mat.bright);
  crackSide.position.set(-barrelLength * 0.1, barrelHalfExtent * 0.3, barrelHalfExtent * 0.98);
  barrelGroup.add(crackSide);

  const crackLow = box(barrelLength * 0.4, 0.045, 0.045, mat.bright);
  crackLow.position.set(barrelLength * 0.22, -barrelHalfExtent * 0.35, barrelHalfExtent * 0.95);
  crackLow.rotation.z = 0.08;
  barrelGroup.add(crackLow);
  parts.cracks = [crackTop, crackSide, crackLow];

  // Ember motes — tiny bright flecks hovering just off the front face,
  // reading as sparks at thumbnail scale; positions loosely track the
  // cracks so they look like they're being thrown off the seams.
  const moteDefs = [
    [-0.75, barrelHalfExtent * 0.55, barrelHalfExtent * 1.05, 0.4],
    [0.5, barrelHalfExtent * 0.05, barrelHalfExtent * 1.1, 1.9],
    [1.1, -barrelHalfExtent * 0.4, barrelHalfExtent * 1.02, 3.3],
  ];
  const motes = moteDefs.map(([mx, my, mz, ph]) => {
    const mote = box(0.05, 0.05, 0.05, mat.bright);
    mote.position.set(mx, my, mz);
    barrelGroup.add(mote);
    return { mesh: mote, baseY: my, phase: ph };
  });
  parts.motes = motes;

  // Melt lobes hanging beneath the barrel — the center one is sized so
  // its tip grazes the floor at rest, matching the disc drips' ground
  // contact; the outer two hang shorter, mid-air.
  const dripDefs = [
    [-0.95, 0.45, 0],
    [0.0, discCenterY - barrelHalfExtent, 0.35],
    [0.95, 0.5, 1.6],
  ];
  const drips = dripDefs.map(([dx, len, ph]) => {
    const d = box(0.26, len, 0.3, mat.molten);
    d.position.set(dx, -barrelHalfExtent - len / 2, 0.15);
    barrelGroup.add(d);
    return { mesh: d, baseLen: len, phase: ph };
  });
  parts.drips = drips;

  // Twin ember-bright eyes on the front (+Z) face — the only hint of a
  // face on an otherwise inanimate-looking spool, so it still reads as
  // a creature and not just scenery.
  const eyeL = box(0.12, 0.1, 0.06, mat.bright);
  eyeL.position.set(-0.45, barrelHalfExtent * 0.35, barrelHalfExtent * 0.9);
  barrelGroup.add(eyeL);
  const eyeR = box(0.12, 0.1, 0.06, mat.bright);
  eyeR.position.set(0.45, barrelHalfExtent * 0.35, barrelHalfExtent * 0.9);
  barrelGroup.add(eyeR);
  parts.eyes = [eyeL, eyeR];

  // -------------------------------------------------------------------
  // THREAD-ARM — one long molten arm mounted off the top of the barrel,
  // wound back overhead, ready to swing down toward +Z on attack. Wrap-
  // ridge bands texture the upper arm, an elbow melt-drip and a frayed
  // thread tail off the tip complete the textile-industrial read.
  // -------------------------------------------------------------------
  const armMountX = -0.4;
  const armTopY = discCenterY + barrelHalfExtent;

  const shoulderMount = box(0.32, 0.3, 0.32, mat.char);
  shoulderMount.position.set(armMountX, armTopY, 0);
  bodyPivot.add(shoulderMount);

  const mountBoltL = box(0.06, 0.06, 0.06, mat.tallow);
  mountBoltL.position.set(armMountX - 0.12, armTopY, 0.12);
  bodyPivot.add(mountBoltL);
  const mountBoltR = box(0.06, 0.06, 0.06, mat.tallow);
  mountBoltR.position.set(armMountX + 0.12, armTopY, -0.12);
  bodyPivot.add(mountBoltR);

  const shoulderPivot = new THREE.Group();
  shoulderPivot.position.set(armMountX, armTopY, 0);
  bodyPivot.add(shoulderPivot);

  const upperArmLen = 1.05;
  const upperArm = box(0.28, upperArmLen, 0.28, mat.thread);
  upperArm.position.set(0, upperArmLen / 2, 0);
  shoulderPivot.add(upperArm);

  // Wrap-cinch ridge bands, simulating thread wound tightly around the arm.
  const wrapA = box(0.33, 0.06, 0.33, mat.tallow);
  wrapA.position.set(0, upperArmLen * 0.35, 0);
  shoulderPivot.add(wrapA);
  const wrapB = box(0.33, 0.06, 0.33, mat.tallow);
  wrapB.position.set(0, upperArmLen * 0.75, 0);
  shoulderPivot.add(wrapB);

  const elbowPivot = new THREE.Group();
  elbowPivot.position.set(0, upperArmLen, 0);
  shoulderPivot.add(elbowPivot);

  // Forearm — split into two segments that step down in width toward the
  // tip (0.22 -> 0.15), so the limb visibly tapers like a candle of molten
  // metal instead of reading as a constant-width stick.
  const forearmLen = 0.85;
  const forearmUpper = box(0.22, forearmLen * 0.55, 0.22, mat.molten);
  forearmUpper.position.set(0, (forearmLen * 0.55) / 2, 0);
  elbowPivot.add(forearmUpper);
  const forearmLower = box(0.15, forearmLen * 0.45, 0.15, mat.molten);
  forearmLower.position.set(0, forearmLen * 0.55 + (forearmLen * 0.45) / 2, 0);
  elbowPivot.add(forearmLower);
  const forearm = forearmUpper; // kept for external part-name compatibility

  // Small melt-drip hanging off the elbow joint, echoing the body's
  // continuous dripping motif on the limb itself.
  const elbowDrip = box(0.1, 0.16, 0.1, mat.molten);
  elbowDrip.position.set(0, -0.06, 0.16);
  elbowPivot.add(elbowDrip);

  // Molten drip-tip — a wide, dim halo behind a brighter core behind a
  // narrow drip point, layered largest-to-smallest so the glow visibly
  // falls off toward the very end and the tip reads as a bead of molten
  // metal about to drop, not a single flat capped rod end.
  const tipHalo = box(0.4, 0.28, 0.4, mat.molten);
  tipHalo.position.set(0, forearmLen + 0.1, 0);
  elbowPivot.add(tipHalo);
  const tipGlow = box(0.26, 0.2, 0.26, mat.bright);
  tipGlow.position.set(0, forearmLen + 0.2, 0);
  elbowPivot.add(tipGlow);
  const tipPoint = box(0.09, 0.2, 0.09, mat.bright);
  tipPoint.position.set(0, forearmLen + 0.36, 0);
  elbowPivot.add(tipPoint);

  // Frayed thread tail trailing loose off the glowing tip — two thin
  // strands, asymmetric lengths, the arm's own "unraveling" detail.
  const tailA = box(0.03, 0.26, 0.03, mat.thread);
  tailA.position.set(-0.1, forearmLen + 0.14, 0.04);
  tailA.rotation.z = 0.3;
  elbowPivot.add(tailA);
  const tailB = box(0.025, 0.18, 0.025, mat.thread);
  tailB.position.set(0.11, forearmLen + 0.16, -0.05);
  tailB.rotation.z = -0.24;
  elbowPivot.add(tailB);

  shoulderPivot.rotation.x = -0.9; // idle wound-back pose

  parts.arm = {
    shoulderMount,
    shoulderPivot,
    upperArm,
    elbowPivot,
    forearm,
    forearmUpper,
    forearmLower,
    elbowDrip,
    tipHalo,
    tipGlow,
    tipPoint,
    tail: [tailA, tailB],
  };

  // -------------------------------------------------------------------
  // Head anchor for name tags — fixed above the whole colossal mass,
  // a direct child of root so it never gets caught in the body's roll,
  // creak, or hurt-jolt animation.
  // -------------------------------------------------------------------
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 3.5, 0);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // Baked rest poses — animate() re-derives every property from these
  // every frame rather than accumulating with "+=", so state can never
  // drift/compound across frames regardless of call ordering.
  // -------------------------------------------------------------------
  const REST_ARM_X = -0.9;
  const REST_ELBOW_X = -0.15;

  // -------------------------------------------------------------------
  // ANIMATION — built on mobs/anim/rig.js's procedural-motion helpers.
  // Idle:      rig.breathe drives a slow overall mass "swell" tied to the
  //            core heat; rig.sway independently drifts the thread-arm,
  //            disc creak, thread wisps and frayed tail so nothing ever
  //            reads as frozen even standing still. Molten bands/cracks
  //            pulse-glow and drip lobes wobble continuously.
  // Walk:      the spool rocks/churns about its own barrel (X) axis — a
  //            bounded back-and-forth heave (cadence/amplitude scaled by
  //            state.speed01), not a literal unbounded spin, so a mass
  //            this colossal always reads as composed/level-ish at any
  //            sampled instant (portraits, screenshots) rather than an
  //            accumulating roll that could land at an arbitrary,
  //            camera-unfriendly angle. rig.walkPhase is repurposed
  //            leg-less: its FR/FL channels drive the two end-discs'
  //            alternating "footfall" creak as they touch down in turn,
  //            its lift drives a body bob timed to the churn.
  // Enrage:    state.phase (0..2) normalizes to 0..1 and drives hotter,
  //            faster pulse-glow, a tighter arm wind-back and quicker roll.
  // Telegraph: rig.windUp pulls the thread-arm back into a tighter coil
  //            as state.telegraph builds, cracks/eyes flaring in warning.
  // Attack:    rig.strike whips the arm down/forward into a heavy swing
  //            toward +Z as state.attack fires, forearm trailing behind
  //            the shoulder for a heavier, whip-cracking downswing.
  // Hurt:      a sharp, fast-decaying jolt shake with a bright seam flare.
  // Death:     rig.dissolve unravels the whole spool — bands twist loose,
  //            discs splay outward, drips stretch and lengthen, the arm
  //            flings wide, and every ember gutters dark as the body
  //            sinks and shrinks. No gore — a forge going cold.
  // Turn:      the whole spool banks into state.turn (signed yaw rate).
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
      const speed01 = clamp01(s.speed01 != null ? s.speed01 : (moving ? 1 : 0));
      const hurt = clamp01(s.hurt);
      const attack = clamp01(s.attack);
      const telegraph = clamp01(s.telegraph);
      const dying = clamp01(s.dying);
      const turn = n(s.turn, 0);
      const phaseNorm = clamp01(n(s.phase, 0) / 2); // 0..2 -> 0..1 enrage

      // Lean into turns — damped so the bank never snaps.
      const leanTarget = dying > 0 ? 0 : Math.max(-0.24, Math.min(0.24, -turn * 0.16));
      lean = rig.damp(lean, leanTarget, 6, dt);

      // ---- DEATH: thread-unravel dissolve, no gore — overrides all ----
      if (dying > 0) {
        const d = rig.dissolve(dying);
        const sc = Math.max(0.04, d.scale);
        root.scale.set(sc, sc, sc);
        root.position.y = -d.drop * 1.2;

        // Position/roll freeze wherever they were the instant dying began
        // (rotation.x is simply left untouched) — the spool stops turning
        // and settles rather than spinning forever while it unravels.
        bodyPivot.position.x = 0;
        bodyPivot.position.y = 0;
        bodyPivot.rotation.z = lean + d.spread * 0.3;

        parts.discs.forEach(({ discGroup, side }) => {
          discGroup.rotation.z = side * d.spread * 0.65;
          discGroup.rotation.y = side * d.spread * 0.35;
        });

        bands.forEach((band, i) => {
          const sign = i % 2 === 0 ? 1 : -1;
          band.rotation.z = sign * d.spread * 0.5;
          const stretch = 1 + d.spread * 0.6;
          band.scale.set(stretch, 1, 1);
        });

        drips.forEach(({ mesh, baseLen }) => {
          const stretch = 1 + d.spread * 1.4;
          mesh.scale.set(1, stretch, 1);
          mesh.position.y = -barrelHalfExtent - (baseLen * stretch) / 2;
        });

        parts.discs.forEach(({ drip }) => {
          const stretch = 1 + d.spread * 1.1;
          [drip.upper, drip.mid, drip.tip].forEach((seg) => {
            seg.scale.set(1, stretch, 1);
          });
        });

        shoulderPivot.rotation.x = REST_ARM_X - d.spread * 1.3;
        shoulderPivot.rotation.z = d.spread * 0.5;
        elbowPivot.rotation.x = REST_ELBOW_X + d.spread * 1.0;

        // Every ember gutters dark as the forge goes cold.
        const cool = Math.max(0, 1 - dying);
        mat.molten.emissiveIntensity = 0.6 * cool;
        mat.bright.emissiveIntensity = 0.9 * cool;
        return; // death pose overrides everything below
      }

      // Reset root/body transforms in case a previous frame was mid-
      // dissolve and the mob got revived/recycled (defensive; animate()
      // must never assume ordering with the manager's own removal timing).
      if (root.scale.x !== 1) root.scale.set(1, 1, 1);
      if (root.position.y !== 0) root.position.y = 0;

      // ---- Overall body: slow breathing swell + roll/rock -------------
      const breathAmt = rig.breathe(time, 1 + phaseNorm * 0.6, 0.5 + phaseNorm * 0.3);
      bodyPivot.scale.set(1 + breathAmt * 0.4, 1 + breathAmt, 1 + breathAmt * 0.4);
      bodyPivot.position.y = Math.sin(time * 0.7) * 0.03 * (1 - speed01 * 0.5);

      // Rolling locomotion, repurposing rig.walkPhase's channels: lift
      // drives a footfall-timed body bob, FR/FL alternate the two discs'
      // creak so they read as touching down in turn as the spool churns.
      //
      // Deliberately a BOUNDED back-and-forth rock (sin wave), not an
      // unbounded "time * speed" spin — a colossal half-molten mass this
      // heavy heaves/creaks rather than free-wheeling, and bounding the
      // swing guarantees the silhouette stays composed/near-level at ANY
      // sampled instant (a screenshot/portrait can land on any elapsed
      // time, including while state.moving is true) instead of an
      // ever-growing roll that could freeze the render at an arbitrary,
      // camera-unfriendly angle. Cadence and amplitude both scale up with
      // speed/enrage/attack so it still visibly reads as "rolling forward"
      // once in motion.
      const wp = rig.walkPhase(time, speed01, 0.9);
      const rollCadence = 0.5 + speed01 * 1.5 + phaseNorm * 0.6 + attack * 0.4;
      const rollAmp = 0.1 + speed01 * 0.22 + phaseNorm * 0.05;
      bodyPivot.rotation.x = Math.sin(time * rollCadence) * rollAmp;
      bodyPivot.position.y += wp.lift * 0.03 * (grounded ? 1 : 0.3);

      // Hurt jolt: sharp decaying jolt shake, layered on top.
      flinch = rig.damp(flinch, hurt, 18, dt);
      if (flinch > 0.001) {
        bodyPivot.position.x = Math.sin(time * 42) * 0.08 * flinch;
        bodyPivot.rotation.z = lean + Math.sin(time * 35) * 0.06 * flinch;
      } else {
        bodyPivot.position.x = 0;
        bodyPivot.rotation.z = lean;
      }

      // --- Barrel: molten band pulse + bright crack glow -----------------
      const pulseSpeed = 1.2 + phaseNorm * 1.6 + attack * 1.5;
      const pulse = 0.5 + 0.5 * Math.sin(time * pulseSpeed);
      let moltenGlow = 0.7 + pulse * (0.6 + phaseNorm * 0.7) + attack * 0.5;
      let brightGlow = 1.3 + pulse * (0.8 + phaseNorm * 1.0) + attack * 1.0;

      // Barrel bands ripple slightly, like the wound thread is still
      // turning; FR/FL from the walk phase nudge alternating bands so the
      // ripple reads as travelling along the barrel while rolling.
      bands.forEach((band, i) => {
        const k = 1 + Math.sin(time * 1.5 + i * 0.7) * (0.02 + phaseNorm * 0.018)
          + (i % 2 === 0 ? wp.FR : wp.FL) * 0.01;
        band.scale.set(1, k, k);
        band.rotation.z = 0;
      });

      // Ember motes bob and flicker independently, like sparks thrown off
      // the seams.
      motes.forEach(({ mesh, baseY, phase }) => {
        mesh.position.y = baseY + Math.sin(time * 3.2 + phase) * 0.05;
        mesh.scale.setScalar(0.7 + 0.3 * Math.sin(time * 6 + phase));
      });

      // Drip lobes wobble/stretch as if slowly dripping, clamped so no
      // lobe ever visibly dips below the ground plane.
      drips.forEach(({ mesh, baseLen, phase }) => {
        const stretch = 1 + Math.sin(time * 1.6 + phase) * 0.1 + phaseNorm * 0.06;
        const len = baseLen * stretch;
        let y = -barrelHalfExtent - len / 2;
        const worldBottom = discCenterY + y - len / 2;
        if (worldBottom < 0) y -= worldBottom; // clamp: never pierce the floor
        mesh.scale.set(1, stretch, 1);
        mesh.position.y = y;
      });

      // --- End discs: independent slow creak + ground-drip wobble --------
      parts.discs.forEach(({ discGroup, drip, side }, i) => {
        const creakSpeed = 0.35 + phaseNorm * 0.4;
        const footfall = i === 0 ? wp.FR : wp.FL;
        discGroup.rotation.z =
          Math.sin(time * creakSpeed + i * 2.1) * (0.025 + phaseNorm * 0.02) * side
          + footfall * 0.015;

        const wobble = 1 + Math.sin(time * 1.8 + i * 1.3) * 0.06 + phaseNorm * 0.03;
        drip.upper.scale.set(1, wobble, 1);
        drip.mid.scale.set(1, 1 + (wobble - 1) * 0.7, 1);
      });

      // Thread wisps and frayed tail drift on rig.sway, independent of
      // everything else, so the model never reads as frozen.
      discL.wisp.rotation.z = rig.sway(time, 1, 0.8, 0.3);
      discR.wisp.rotation.z = rig.sway(time, 1, 0.85, 2.6);

      // --- Thread-arm: idle wind-back, enraged wind-up, attack swing -----
      const idleWobble = rig.sway(time, 1, 0.9, 0) * 0.06;
      const woundBack = REST_ARM_X - phaseNorm * 0.35 + idleWobble;

      const attackActive = telegraph > 0 || attack > 0;
      if (attackActive) {
        const windAmt = rig.windUp(telegraph); // 0 -> ~-1.1 -> -1
        const strikeAmt = rig.strike(attack); // 0 -> 1, fast release
        const blend = Math.max(telegraph, attack);
        const swingTarget = 2.05;
        const driveX = attack > 0
          ? woundBack + windAmt * 0.3 + strikeAmt * (swingTarget - woundBack)
          : woundBack + windAmt * 0.5;
        shoulderPivot.rotation.x = driveX;
        shoulderPivot.rotation.z = blend * 0.08 * Math.sin(time * 3);

        // Forearm whip: snaps slightly behind the shoulder's motion for a
        // heavier, trailing-mass feel on the swing.
        const whip = Math.sin(Math.min(attack * 1.3, 1) * Math.PI) * 0.5;
        elbowPivot.rotation.x = REST_ELBOW_X + whip - windAmt * 0.15;

        moltenGlow += blend * 0.4;
        brightGlow += blend * 0.8;
      } else {
        shoulderPivot.rotation.x = woundBack;
        shoulderPivot.rotation.z = Math.sin(time * 0.5) * 0.04;
        elbowPivot.rotation.x = REST_ELBOW_X + Math.sin(time * 1.3) * 0.03;
      }

      const tailSway = rig.sway(time, 1, 1.4, 0.5) * (1 - Math.max(telegraph, attack) * 0.6);
      tailA.rotation.x = tailSway * 0.8;
      tailB.rotation.x = -tailSway * 0.7;
      elbowDrip.scale.set(1, 1 + Math.sin(time * 2.1) * 0.15, 1);

      // Tip drip wobble — the halo/core/point cluster stretches and drifts
      // sideways out of phase with each other, like a bead of molten metal
      // swelling right before it drops, instead of sitting as a rigid cap.
      const dripPulse = 0.5 + 0.5 * Math.sin(time * 1.8);
      tipHalo.scale.set(1, 1 + dripPulse * 0.12, 1);
      tipGlow.scale.set(1, 1 + dripPulse * 0.18, 1);
      tipGlow.position.x = Math.sin(time * 1.1) * 0.02;
      tipPoint.scale.set(1, 1 + Math.sin(time * 1.8 + 0.6) * 0.25 + 0.15, 1);
      tipPoint.position.x = Math.sin(time * 1.1 + 0.6) * 0.03;

      // --- Hurt flare layered on top of everything ------------------------
      if (flinch > 0.001) {
        moltenGlow += flinch * 0.7;
        brightGlow += flinch * 1.1;
      }

      mat.molten.emissiveIntensity = moltenGlow;
      mat.bright.emissiveIntensity = brightGlow;

      // --- Eyes: faint ember pulse, flare on attack ------------------------
      const eyeGlow = 1.2 + pulse * 0.4 + attack * 0.8 + flinch * 0.6;
      eyeL.material.emissiveIntensity = eyeGlow;
      eyeR.material.emissiveIntensity = eyeGlow;
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
    }
  };

  return root;
}

export const meta = {
  archetype: 'boss',
  species: 'Molthkin, the First Bobbin',
  canonicalId: 'molthkin',
  dimensionDefault: 'cinderloom',
  palette: {
    thread: '#F2A03D',
    molten: '#D94F1E',
    scorched: '#7A2A10',
    char: '#2B0E06',
    bright: '#FFE9B8',
    tallow: '#E8C87A',
  },
  description:
    'The canonical wellspring of Everthread: a colossal half-molten spool ' +
    'lying on its side deep in Cinderloom, spinning since before the ' +
    'Weaver ever set a shuttle moving. Its two great end-discs sag and ' +
    'drip, never quite cooled, melt reaching all the way to the forge ' +
    'floor; its banded barrel-body turns slow wound amber thread into raw ' +
    'molten glow at the core, ringed with fine coil-ridge ticks and thrown ' +
    'sparks. One long molten thread-arm, wound with cinch-bands and ' +
    'dragging a frayed thread tail off its glowing tip, rises off the top ' +
    'and falls in slow, heavy strikes. It does not hunt so much as wind — ' +
    'and anything caught risks coming out the other side unpicked, ' +
    'unwound, unmade, one more strand added to a spool that was never ' +
    'meant to stop.',
};
