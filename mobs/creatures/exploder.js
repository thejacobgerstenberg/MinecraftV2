import * as THREE from 'three';

// ============================================================================
// WAXLING — a hostile Cinderloom candle-creature that fuses then bursts.
// Archetype: exploder
//
// Silhouette goals (per design brief): SQUAT and BLOBBY, wider than tall —
// never a tall tower. A bulbous body of dripping tallow wax with several
// drip-lobes hanging off the bottom edge (its "feet" are these drip tips
// resting at y=0), two tiny stubby arms, NO legs (it hops to move), and a
// single blackened WICK poking straight up out of the top of its head. As
// state.fuse climbs toward 1 the wick catches — brightening to ember-orange —
// while the whole body swells and its seams glow warm, looking about to pop.
// ============================================================================

// ---- Palette ---------------------------------------------------------------
const PALETTE = {
  tallow: 0xe8d8a0,   // pale tallow wax — main body mass
  amberDrip: 0xd9a441, // amber wax drips — accent lobes
  wick: 0x2a241c,      // blackened wick (unlit)
  ember: 0xff7a2a,     // ember-orange the wick/seams glow toward as fuse rises
};

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

export function build() {
  const root = new THREE.Group();
  root.name = 'Waxling';

  // ---- Materials -------------------------------------------------------
  // tallowMat / amberDripMat carry a warm emissive that we ramp up with
  // fuse so the whole body's seams "glow warmer" as it nears bursting.
  const tallowMat = new THREE.MeshStandardMaterial({
    color: PALETTE.tallow,
    roughness: 0.55,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.ember),
    emissiveIntensity: 0.0,
  });
  const amberDripMat = new THREE.MeshStandardMaterial({
    color: PALETTE.amberDrip,
    roughness: 0.4,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.ember),
    emissiveIntensity: 0.05,
  });
  const wickMat = new THREE.MeshStandardMaterial({
    color: PALETTE.wick,
    roughness: 0.85,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.wick),
    emissiveIntensity: 0.0,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: PALETTE.wick,
    roughness: 0.9,
    metalness: 0.0,
  });

  // ---- bodyGroup: everything that wobbles/swells together ---------------
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  // Core wax mass — squat and noticeably WIDER than tall.
  const core = box(0.70, 0.32, 0.64, tallowMat);
  core.position.set(0, 0.30, 0);
  bodyGroup.add(core);

  // Rounded top cap — softens the top of the blob before the wick.
  const topCap = box(0.50, 0.14, 0.46, tallowMat);
  topCap.position.set(0, 0.50, -0.02);
  bodyGroup.add(topCap);

  // Rounded bottom puff — softens the underside above the drip-lobes.
  const bottomPuff = box(0.58, 0.12, 0.52, tallowMat);
  bottomPuff.position.set(0, 0.10, 0);
  bodyGroup.add(bottomPuff);

  // Drip-lobes hanging off the bottom edge — these are the Waxling's only
  // "feet"; each one's bottom face touches y=0. Sizes are irregular so the
  // silhouette reads as dripping wax rather than a symmetrical base.
  const dripFL = box(0.12, 0.16, 0.12, tallowMat);
  dripFL.position.set(-0.26, 0.08, 0.18);
  bodyGroup.add(dripFL);

  const dripBL = box(0.11, 0.12, 0.11, tallowMat);
  dripBL.position.set(-0.24, 0.06, -0.20);
  bodyGroup.add(dripBL);

  const dripFR = box(0.12, 0.14, 0.12, amberDripMat);
  dripFR.position.set(0.26, 0.07, 0.18);
  bodyGroup.add(dripFR);

  const dripBR = box(0.10, 0.10, 0.10, amberDripMat);
  dripBR.position.set(0.24, 0.05, -0.20);
  bodyGroup.add(dripBR);

  // A larger amber drip hanging off the front center — the "money" drip.
  const dripFrontCenter = box(0.16, 0.20, 0.14, amberDripMat);
  dripFrontCenter.position.set(0, 0.10, 0.34);
  bodyGroup.add(dripFrontCenter);

  // Two small sunken eyes pressed into the front of the wax.
  const eyeL = box(0.05, 0.05, 0.02, eyeMat);
  eyeL.position.set(-0.15, 0.32, 0.33);
  bodyGroup.add(eyeL);

  const eyeR = box(0.05, 0.05, 0.02, eyeMat);
  eyeR.position.set(0.15, 0.32, 0.33);
  bodyGroup.add(eyeR);

  // ---- Wick — pokes straight up out of the top of the head --------------
  const wickMesh = box(0.07, 0.22, 0.07, wickMat);
  wickMesh.position.set(0, 0.68, -0.02);
  bodyGroup.add(wickMesh);

  // Head anchor for name tags — fixed above the wick's maximum (fully
  // fused/swollen) height so the tag never dips below the flame tip.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 1.10, 0);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // ---- Tiny stubby arms — no legs; the Waxling hops to move --------------
  function buildArm(x) {
    const shoulderPivot = new THREE.Group();
    shoulderPivot.position.set(x, 0.30, 0.02);
    bodyGroup.add(shoulderPivot);

    const armMesh = hangingBox(0.09, 0.16, 0.09, tallowMat);
    shoulderPivot.add(armMesh);

    return { shoulderPivot, armMesh };
  }

  const armL = buildArm(-0.39);
  const armR = buildArm(0.39);

  // ---- Store references for animate() ------------------------------------
  root.userData.parts = {
    bodyGroup,
    wickMesh,
    wickMat,
    tallowMat,
    amberDripMat,
    armL,
    armR,
  };

  // -------------------------------------------------------------------
  // ANIMATION
  // Idle: soft wax-wobble breathing (always).
  // Moving: no legs, so it HOPS — whole body bounces with a landing squash
  //         and the stubby arms flail for balance.
  // Fuse (0->1): wick brightens/shifts toward ember-orange, body swells,
  //         seams glow warmer, and near 1 everything jitters faster —
  //         about to burst.
  // -------------------------------------------------------------------
  const wickTargetColor = new THREE.Color(PALETTE.ember);
  const wickBaseColor = new THREE.Color(PALETTE.wick);

  root.userData.animate = (t, state) => {
    const parts = root.userData.parts;
    const fuse = Math.max(0, Math.min(1, (state && state.fuse) || 0));
    const moving = !!(state && state.moving);
    const hurt = (state && state.hurt) || 0;

    // Soft wax-wobble breathing — always active; gets jittery near burst.
    const wobbleSpeed = 1.6 + fuse * 6.5;
    const wobbleAmt = 0.025 + fuse * 0.05;
    const wobble = Math.sin(t * wobbleSpeed) * wobbleAmt;

    // Fuse swell — the body inflates as it approaches bursting.
    const swell = 1 + fuse * 0.18;

    parts.bodyGroup.scale.set(
      swell + wobble * 0.6,
      swell + wobble,
      swell + wobble * 0.6
    );

    // Movement: hop cycle (no legs). Whole body bounces with a landing
    // squash-and-stretch; stubby arms flail outward for balance.
    let hopY = 0;
    if (moving) {
      const hopCycle = t * 6.0;
      const hopPhase = Math.abs(Math.sin(hopCycle));
      hopY = hopPhase * 0.14;

      const landSquash = 1 - hopPhase * 0.08;
      parts.bodyGroup.scale.y *= landSquash;
      parts.bodyGroup.scale.x *= 1 + (1 - landSquash) * 0.5;
      parts.bodyGroup.scale.z *= 1 + (1 - landSquash) * 0.5;

      parts.armL.shoulderPivot.rotation.z = Math.sin(hopCycle) * 0.5 + 0.15;
      parts.armR.shoulderPivot.rotation.z = -Math.sin(hopCycle) * 0.5 - 0.15;
      parts.armL.shoulderPivot.rotation.x = Math.cos(hopCycle) * 0.25;
      parts.armR.shoulderPivot.rotation.x = -Math.cos(hopCycle) * 0.25;
    } else {
      // Idle: tiny arm sway + a very small idle bob.
      parts.armL.shoulderPivot.rotation.z = 0.1 + Math.sin(t * 1.4) * 0.06;
      parts.armR.shoulderPivot.rotation.z = -0.1 - Math.sin(t * 1.4 + 0.5) * 0.06;
      parts.armL.shoulderPivot.rotation.x = 0;
      parts.armR.shoulderPivot.rotation.x = 0;
      hopY = Math.sin(t * 1.6) * 0.01;
    }

    // Hurt flinch — a quick decaying upward jolt.
    if (hurt > 0) {
      hopY += Math.sin(Math.min(hurt, 1) * Math.PI) * 0.1;
    }

    root.position.y = hopY;

    // Wick: color lerps from blackened toward ember-orange and its
    // emissive intensity ramps up sharply as fuse climbs; near full fuse
    // it flickers rapidly, like it's about to catch and burst.
    parts.wickMat.color.copy(wickBaseColor).lerp(wickTargetColor, fuse);
    const flicker = fuse > 0.8 ? Math.sin(t * 40) * 0.6 : 0;
    parts.wickMat.emissiveIntensity = fuse * 3.2 + flicker;
    parts.wickMesh.scale.set(1 + fuse * 0.3, 1 + fuse * 0.12, 1 + fuse * 0.3);

    // Seams (amber drips + main wax) glow warmer as the fuse rises.
    parts.amberDripMat.emissiveIntensity = 0.05 + fuse * 0.9;
    parts.tallowMat.emissiveIntensity = fuse * 0.35;
  };

  return root;
}

export const meta = {
  archetype: 'exploder',
  species: 'Waxling',
  dimensionDefault: 'cinderloom',
  palette: {
    tallow: '#E8D8A0',
    amberDrip: '#D9A441',
    wick: '#2A241C',
    ember: '#FF7A2A',
  },
  description:
    'A hostile Cinderloom candle-creature: a squat, blobby mass of dripping ' +
    'tallow wax with amber drip-lobes hanging off its underside for feet. ' +
    'It has no legs and hops to move, flailing two tiny stubby arms for ' +
    'balance. A single blackened wick pokes straight up from its head — as ' +
    'the Thrum fuses within it, the wick catches and brightens to ember-' +
    'orange, the whole body swelling and its seams glowing warmer until it ' +
    'bursts.',
};
