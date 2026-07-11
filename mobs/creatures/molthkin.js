import * as THREE from 'three';

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
// molten barrel; continuous drip lobes hang beneath the barrel; one long
// thread-arm rises off the top, wound back and ready to swing.
// ============================================================================

const PALETTE = {
  thread: 0xf2a03d,   // amber — wound thread, dominant barrel/arm color
  molten: 0xd94f1e,   // molten orange — barrel glow bands + drips, emissive
  scorched: 0x7a2a10, // scorched brown — end-disc body
  char: 0x2b0e06,     // near-black char — end-disc rims/shadow, hub mounts
  bright: 0xffe9b8,   // hottest bright — searing cracks + drip/arm tips, emissive
  tallow: 0xe8c87a,   // tallow — secondary barrel band + hub ring accent
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

export function build() {
  const root = new THREE.Group();
  root.name = 'Molthkin, the First Bobbin';

  const mat = makeMaterials();
  const parts = {};

  // -------------------------------------------------------------------
  // Layout constants — spool axis runs along local X (lying on its
  // side); Y/Z form the circular cross-section. "Front" (+Z) is where
  // the eyes sit and where the thread-arm swings down toward.
  // -------------------------------------------------------------------
  const discCenterY = 1.5;      // shared vertical center of the whole spool
  const discRadius = 1.35;      // end-disc fake-circle radius
  const discThickness = 0.4;    // end-disc thickness along X
  const barrelHalfExtent = 0.82; // barrel cross-section half-height/depth
  const barrelLength = 2.8;     // barrel span along X between disc faces
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
  // its Y/Z corners round out the silhouette), a glowing spindle hub,
  // a tallow hub-ring accent, and a drooping melt-lobe hanging below so
  // each disc reads as sagging/half-melted rather than a clean wheel.
  function buildDisc(x, side) {
    const discGroup = new THREE.Group();
    discGroup.position.set(x, discCenterY, 0);
    bodyPivot.add(discGroup);

    const discMain = box(discThickness, discRadius * 2, discRadius * 1.4, mat.scorched);
    discGroup.add(discMain);

    const discCross = box(discThickness, discRadius * 1.4, discRadius * 2, mat.char);
    discGroup.add(discCross);

    const discCornerFill = box(discThickness * 0.92, discRadius * 1.5, discRadius * 1.5, mat.char);
    discCornerFill.rotation.x = Math.PI / 4;
    discGroup.add(discCornerFill);

    const hub = box(discThickness * 1.2, 0.34, 0.34, mat.bright);
    discGroup.add(hub);

    const hubRing = box(discThickness * 1.05, 0.55, 0.55, mat.tallow);
    hubRing.position.set(0, 0, 0);
    discGroup.add(hubRing);
    // Hub must stay visually on top of the ring — nudge ring thickness
    // down so it reads as a flat washer, not an occluding box.
    hubRing.scale.set(0.34, 1, 1);

    // Melt-droop: an asymmetric lobe sagging below the disc's own rim.
    const droop = box(discThickness * 0.75, 0.5, 0.62, mat.molten);
    droop.position.set(0, -discRadius - 0.68, discRadius * 0.1);
    discGroup.add(droop);

    return { discGroup, discMain, discCross, discCornerFill, hub, hubRing, droop, side };
  }

  const discL = buildDisc(-discX, -1);
  const discR = buildDisc(discX, 1);
  parts.discs = [discL, discR];

  // -------------------------------------------------------------------
  // BARREL — horizontal banded body between the discs: wound amber
  // thread shading into molten-orange glow bands, rounded with a single
  // long corner-fill box, striped with two bright searing crack seams.
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
    const bx = -barrelLength / 2 + bandWidth * (i + 0.5);
    const band = box(
      bandWidth - 0.05,
      barrelHalfExtent * 2,
      barrelHalfExtent * 1.7,
      bandMats[i]
    );
    band.position.set(bx, 0, 0);
    barrelGroup.add(band);
    bands.push(band);
  }
  parts.bands = bands;

  const crackTop = box(barrelLength * 0.92, 0.06, 0.06, mat.bright);
  crackTop.position.set(0, barrelHalfExtent * 0.92, barrelHalfExtent * 0.5);
  barrelGroup.add(crackTop);

  const crackSide = box(barrelLength * 0.55, 0.05, 0.05, mat.bright);
  crackSide.position.set(-barrelLength * 0.1, barrelHalfExtent * 0.3, barrelHalfExtent * 0.98);
  barrelGroup.add(crackSide);
  parts.cracks = [crackTop, crackSide];

  // Continuous glowing drip lobes hanging beneath the barrel.
  const dripDefs = [
    [-0.9, 0.5, 0],
    [0.05, 0.68, 0.35],
    [0.95, 0.56, 0.7],
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
  // wound back overhead, ready to swing down toward +Z on attack.
  // -------------------------------------------------------------------
  const armMountX = -0.4;
  const armTopY = discCenterY + barrelHalfExtent;

  const shoulderMount = box(0.32, 0.3, 0.32, mat.char);
  shoulderMount.position.set(armMountX, armTopY, 0);
  bodyPivot.add(shoulderMount);

  const shoulderPivot = new THREE.Group();
  shoulderPivot.position.set(armMountX, armTopY, 0);
  bodyPivot.add(shoulderPivot);

  const upperArmLen = 1.05;
  const upperArm = box(0.28, upperArmLen, 0.28, mat.thread);
  upperArm.position.set(0, upperArmLen / 2, 0);
  shoulderPivot.add(upperArm);

  const elbowPivot = new THREE.Group();
  elbowPivot.position.set(0, upperArmLen, 0);
  shoulderPivot.add(elbowPivot);

  const forearmLen = 0.85;
  const forearm = box(0.22, forearmLen, 0.22, mat.molten);
  forearm.position.set(0, forearmLen / 2, 0);
  elbowPivot.add(forearm);

  const tipGlow = box(0.32, 0.24, 0.32, mat.bright);
  tipGlow.position.set(0, forearmLen + 0.14, 0);
  elbowPivot.add(tipGlow);

  shoulderPivot.rotation.x = -0.9; // idle wound-back pose

  parts.arm = { shoulderMount, shoulderPivot, upperArm, elbowPivot, forearm, tipGlow };

  // -------------------------------------------------------------------
  // Head anchor for name tags — fixed above the whole colossal mass,
  // a direct child of root so it never gets caught in the body's roll,
  // creak, or hurt-jolt animation.
  // -------------------------------------------------------------------
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 3.35, 0);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION
  // Idle: slow molten pulse-glow along the barrel bands/cracks, drip
  //       lobes wobble, end-discs creak independently on their own axis.
  // Moving: the whole spool rolls forward about its own barrel axis.
  // Phase 1 (enraged, <50% hp): hotter/faster pulse, arm winds up tighter.
  // Attack: the thread-arm swings down toward +Z.
  // Hurt: a sharp jolt shake that decays with hurt.
  // -------------------------------------------------------------------
  root.userData.animate = (t, state) => {
    const s = state || {};
    const moving = !!s.moving;
    const hurt = Math.min(Math.max(s.hurt || 0, 0), 1);
    const phaseT = Math.min(Math.max(s.phase || 0, 0), 1); // 0..1, 1 = enraged
    const attack = Math.min(Math.max(s.attack || 0, 0), 1); // 0..1

    // --- Overall body: slow breathing bob + creak/roll ------------------
    const breathe = Math.sin(t * 0.7) * 0.03;
    bodyPivot.position.y = breathe;

    if (moving) {
      // Lumbers forward by rolling about its own barrel (X) axis.
      const rollSpeed = 1.1 + phaseT * 0.4;
      bodyPivot.rotation.x = t * rollSpeed;
    } else {
      // Slow idle rock, faster/wider once enraged.
      const rockSpeed = 0.4 + phaseT * 0.3;
      bodyPivot.rotation.x = Math.sin(t * rockSpeed) * (0.05 + phaseT * 0.04);
    }

    // Hurt jolt: sharp decaying lateral snap, layered on top.
    if (hurt > 0) {
      bodyPivot.position.x = Math.sin(t * 42) * 0.08 * hurt;
      bodyPivot.rotation.z = Math.sin(t * 35) * 0.06 * hurt;
    } else {
      bodyPivot.position.x = 0;
      bodyPivot.rotation.z *= 0.8;
    }

    // --- Barrel: molten band pulse + bright crack glow -------------------
    const pulseSpeed = 1.2 + phaseT * 1.4 + attack * 1.5;
    const pulse = 0.5 + 0.5 * Math.sin(t * pulseSpeed);
    mat.molten.emissiveIntensity = 0.7 + pulse * (0.6 + phaseT * 0.6) + attack * 0.5;
    mat.bright.emissiveIntensity = 1.3 + pulse * (0.8 + phaseT * 0.9) + attack * 1.0;

    // Barrel bands ripple slightly, like the wound thread is still turning.
    bands.forEach((band, i) => {
      const k = 1 + Math.sin(t * 1.5 + i * 0.7) * (0.02 + phaseT * 0.015);
      band.scale.set(1, k, k);
    });

    // Drip lobes wobble/stretch as if slowly dripping.
    drips.forEach(({ mesh, baseLen, phase }) => {
      const stretch = 1 + Math.sin(t * 1.6 + phase) * 0.1 + phaseT * 0.05;
      mesh.scale.set(1, stretch, 1);
      mesh.position.y = -barrelHalfExtent - (baseLen * stretch) / 2;
    });

    // --- End discs: independent slow creak, layered on top of any roll ---
    // (roll already moves the whole bodyPivot; discs only add a small
    // extra local shudder here to sell "still settling", out of sync
    // with each other via the per-disc index offset and side sign.)
    parts.discs.forEach(({ discGroup, side }, i) => {
      const creakSpeed = 0.35 + phaseT * 0.35;
      discGroup.rotation.z =
        Math.sin(t * creakSpeed + i * 2.1) * (0.025 + phaseT * 0.02) * side;
    });

    // --- Thread-arm: idle wind-back, enraged wind-up, attack swing -------
    const idleWobble = Math.sin(t * 0.6) * 0.05;
    const woundBack = -0.9 - phaseT * 0.35 + idleWobble;
    const swingTarget = 2.05;
    const ease = attack * attack; // heavy, accelerating downswing
    shoulderPivot.rotation.x = woundBack + ease * (swingTarget - woundBack);
    shoulderPivot.rotation.z = Math.sin(t * 0.5) * 0.04 * (1 - attack);

    // Forearm whip: snaps slightly behind the shoulder's motion for a
    // heavier, trailing-mass feel on the swing.
    const whip = Math.sin(Math.min(attack * 1.3, 1) * Math.PI) * 0.5;
    elbowPivot.rotation.x = -0.15 + whip + Math.sin(t * 1.3) * 0.03 * (1 - attack);

    // --- Eyes: faint ember pulse, flare on attack -------------------------
    const eyeGlow = 1.2 + pulse * 0.4 + attack * 0.8;
    eyeL.material.emissiveIntensity = eyeGlow;
    eyeR.material.emissiveIntensity = eyeGlow;
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
    'drip, never quite cooled; its banded barrel-body turns slow wound ' +
    'amber thread into raw molten glow at the core; one long molten ' +
    'thread-arm, dragged loose from its own winding, rises off the top ' +
    'and falls in slow, heavy strikes. It does not hunt so much as wind — ' +
    'and anything caught risks coming out the other side unpicked, ' +
    'unwound, unmade, one more strand added to a spool that was never ' +
    'meant to stop.',
};
