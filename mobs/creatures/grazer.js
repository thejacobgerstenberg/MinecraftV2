import * as THREE from 'three';

// ============================================================================
// SKEINLING — a passive Warpwold "livestock" creature.
// Loomfall lore: born of stray Thrum caught in loose wool, a Skeinling is a
// living ball of yarn that grazes the fields of Warpwold. It is built from a
// cluster of small overlapping "puff" boxes (never a single cube) so its
// silhouette chamfers into a plump, round, fluffy skein rather than a blocky
// staircase. Four short stubby dun legs peek out from underneath, a tiny
// tucked head with two big flat charcoal button-eyes pokes out the front,
// and one loose dyed-red thread trails and sways from the rear.
// ============================================================================

export function build() {
  const root = new THREE.Group();
  root.name = 'Skeinling';

  // ---- Palette -------------------------------------------------------------
  const palette = {
    wool: 0xede3cf,   // cream/oatmeal main coat (dominant material)
    dun: 0xb49a78,    // soft dun legs
    eye: 0x2b2b2b,    // charcoal button eyes
    thread: 0xc96a6a, // dyed-red trailing thread tail
  };

  // ---- Materials (shared per color so the box count stays lean) ------------
  const woolMat = new THREE.MeshStandardMaterial({
    color: palette.wool,
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
  // hand-spun look.
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
  // and round from the front, not a flat-sided box.
  const sideGeo = new THREE.BoxGeometry(0.14, 0.22, 0.3);
  const sideR = new THREE.Mesh(sideGeo, woolMat);
  sideR.position.set(0.27, -0.02, 0.0);
  bodyGroup.add(sideR);
  const sideL = new THREE.Mesh(sideGeo, woolMat);
  sideL.position.set(-0.27, -0.01, 0.02);
  bodyGroup.add(sideL);

  // Top puff cap — rounds the crown of the wool ball.
  const topGeo = new THREE.BoxGeometry(0.3, 0.16, 0.36);
  const topPuff = new THREE.Mesh(topGeo, woolMat);
  topPuff.position.set(0, 0.17, -0.02);
  bodyGroup.add(topPuff);

  // Bottom puff — rounds the underside so legs look tucked into wool.
  const bottomGeo = new THREE.BoxGeometry(0.32, 0.12, 0.38);
  const bottomPuff = new THREE.Mesh(bottomGeo, woolMat);
  bottomPuff.position.set(0, -0.2, 0);
  bodyGroup.add(bottomPuff);

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

  // Head anchor for name tags — just above the head.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 0.46, 0.32);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // ---- Legs: four short stubby, distinctly dun-colored boxes -----------------
  const legGeo = new THREE.BoxGeometry(0.09, 0.16, 0.09);
  const legPositions = [
    [0.16, 0.16, 0.19],   // front-right
    [-0.16, 0.16, 0.19],  // front-left
    [0.16, 0.16, -0.19],  // back-right
    [-0.16, 0.16, -0.19], // back-left
  ];
  const legs = legPositions.map(([x, y, z]) => {
    const legPivot = new THREE.Group();
    legPivot.position.set(x, y, z); // pivot at hip height
    const legMesh = new THREE.Mesh(legGeo, legMat);
    legMesh.position.set(0, -0.08, 0); // hang below the pivot, feet reach y=0
    legPivot.add(legMesh);
    root.add(legPivot);
    return legPivot;
  });

  // ---- Tail: one loose trailing thread, chained from the rear ----------------
  // Three shrinking red boxes chained through nested pivots so the whole
  // thread can sway as a unit while the tip also gets its own extra flick —
  // this is the single most important silhouette read after the eyes, so it
  // is placed clearly *behind* the rearmost wool puff (not buried inside it).
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.3, -0.36); // just behind the rear-most body puff
  root.add(tailPivot);

  const tailSeg1Geo = new THREE.BoxGeometry(0.055, 0.14, 0.055);
  const tailSeg1 = new THREE.Mesh(tailSeg1Geo, threadMat);
  tailSeg1.position.set(0, -0.06, -0.03);
  tailPivot.add(tailSeg1);

  const tailMid = new THREE.Group();
  tailMid.position.set(0, -0.13, -0.07);
  tailPivot.add(tailMid);

  const tailSeg2Geo = new THREE.BoxGeometry(0.045, 0.12, 0.045);
  const tailSeg2 = new THREE.Mesh(tailSeg2Geo, threadMat);
  tailSeg2.position.set(0, -0.05, -0.03);
  tailMid.add(tailSeg2);

  const tailTip = new THREE.Group();
  tailTip.position.set(0, -0.1, -0.06);
  tailMid.add(tailTip);

  const tailSeg3Geo = new THREE.BoxGeometry(0.035, 0.1, 0.035);
  const tailSeg3 = new THREE.Mesh(tailSeg3Geo, threadMat);
  tailSeg3.position.set(0, -0.04, -0.02);
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
    eyeL,
    eyeR,
  };

  // ---- Animation ---------------------------------------------------------
  // t = seconds elapsed, state = { moving, grounded, fuse, hurt, dimension }
  root.userData.animate = (t, state) => {
    const parts = root.userData.parts;

    // Idle breathing: gentle scale pulse on the fluffy body mass, always
    // running so the skein never looks static.
    const breathe = Math.sin(t * 1.8) * 0.03;
    parts.bodyGroup.scale.set(1 + breathe * 0.5, 1 + breathe, 1 + breathe * 0.5);
    const idleBob = Math.sin(t * 1.8) * 0.015;

    // Occasional head/thread twitch — a short flick every few seconds,
    // driven by a sawtooth-ish pulse so it reads as a discrete twitch
    // rather than a continuous wobble.
    const twitchCycle = t % 4.0; // repeats every 4 seconds
    let twitch = 0;
    if (twitchCycle < 0.3) {
      twitch = Math.sin((twitchCycle / 0.3) * Math.PI) * 0.35;
    }
    parts.headGroup.rotation.y = twitch * 0.5;

    // Thread tail sway: a lazy pendulum on the whole chain plus a lagged,
    // larger-amplitude wave down through the mid/tip segments so it reads
    // as a loose dangling thread rather than a rigid stick, with the
    // periodic twitch above giving it an extra little flick.
    parts.tailPivot.rotation.z = Math.sin(t * 1.1) * 0.14 + twitch * 0.5;
    parts.tailPivot.rotation.x = Math.cos(t * 0.9) * 0.05;
    parts.tailMid.rotation.z = Math.sin(t * 1.1 + 0.6) * 0.22 + twitch * 0.7;
    parts.tailTip.rotation.z = Math.sin(t * 1.1 + 1.2) * 0.3 + twitch * 0.9;

    // Hop/flinch on hurt: a quick upward pop that decays, plus a body
    // squash for impact feedback.
    const hurt = state.hurt || 0;
    const hop = Math.sin(Math.min(hurt, 1) * Math.PI) * 0.18;
    const squash = 1 - hurt * 0.15;

    root.position.y = hop + idleBob * (1 - hurt);
    if (hurt > 0) {
      parts.bodyGroup.scale.y *= squash;
      parts.bodyGroup.scale.x *= 1 + hurt * 0.08;
      parts.bodyGroup.scale.z *= 1 + hurt * 0.08;
    }

    // Walk cycle: opposite-corner legs swing together (like a real trot),
    // only animated while moving; otherwise legs settle to rest.
    const legSwingSpeed = 9.0;
    const legSwingAmount = state.moving ? 0.5 : 0.0;
    const swingLerp = state.moving ? 1 : 0.15; // ease legs back to rest when stopping

    const targets = [
      Math.sin(t * legSwingSpeed) * legSwingAmount,        // FR
      -Math.sin(t * legSwingSpeed) * legSwingAmount,       // FL
      -Math.sin(t * legSwingSpeed) * legSwingAmount,       // BR
      Math.sin(t * legSwingSpeed) * legSwingAmount,        // BL
    ];
    parts.legs.forEach((legPivot, i) => {
      legPivot.rotation.x += (targets[i] - legPivot.rotation.x) * swingLerp;
    });

    // Slight full-body bounce while trotting, on top of idle bob.
    if (state.moving) {
      root.position.y += Math.abs(Math.sin(t * legSwingSpeed)) * 0.02;
    }
  };

  // Feet-at-y0 sanity: leg pivot at y=0.16, leg mesh offset -0.08 with
  // half-height 0.08 -> mesh bottom = 0.16 - 0.08 - 0.08 = 0.0.

  return root;
}

export const meta = {
  archetype: 'grazer',
  species: 'Skeinling',
  dimensionDefault: 'warpwold',
  palette: {
    wool: '#EDE3CF',
    dun: '#B49A78',
    eye: '#2B2B2B',
    thread: '#C96A6A',
  },
  description:
    'A plump, round ball of living wool that grazes the fields of Warpwold. ' +
    'Its cream-oatmeal fleece is stray Thrum caught in loose thread; it trots ' +
    'on four short stubby dun legs, tucks a small button-eyed head under its ' +
    'fluff, and trails one loose dyed-red thread as a swaying tail.',
};
