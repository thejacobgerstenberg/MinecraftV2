import * as THREE from 'three';

// ============================================================================
// SKEINLING — a passive Warpwold "livestock" creature.
// Loomfall lore: born of stray Thrum caught in loose wool, a Skeinling is a
// living ball of yarn that grazes the fields of Warpwold. It is built from a
// cluster of small chamfered-corner boxes (never a single cube) so its
// silhouette reads as a plump, fluffy skein rather than a blocky sheep.
// ============================================================================

export function build() {
  const root = new THREE.Group();
  root.name = 'Skeinling';

  // ---- Palette -------------------------------------------------------------
  const palette = {
    wool: 0xede3cf,   // cream/oatmeal main coat
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

  // ---- Body: chamfered-corner cluster of small boxes ------------------------
  // Rather than one big cube, we cluster 7 smaller boxes: a core box plus
  // four diagonal "corner" boxes (slightly smaller, pulled outward) plus a
  // top and bottom cap. This reads as a puffy round wool-ball, not a sheep.
  const bodyGroup = new THREE.Group();
  bodyGroup.position.set(0, 0.42, 0); // body center height off the ground
  root.add(bodyGroup);

  // Core box (the main mass of the skein).
  const coreGeo = new THREE.BoxGeometry(0.5, 0.4, 0.56);
  const core = new THREE.Mesh(coreGeo, woolMat);
  bodyGroup.add(core);

  // Four diagonal corner "chamfer" boxes — smaller, offset to the four
  // horizontal corners so the silhouette rounds off instead of showing
  // sharp 90-degree edges.
  const cornerGeo = new THREE.BoxGeometry(0.22, 0.3, 0.24);
  const cornerOffsets = [
    [0.28, 0, 0.24],   // front-right
    [-0.28, 0, 0.24],  // front-left
    [0.28, 0, -0.24],  // back-right
    [-0.28, 0, -0.24], // back-left
  ];
  const corners = cornerOffsets.map(([x, y, z]) => {
    const m = new THREE.Mesh(cornerGeo, woolMat);
    m.position.set(x, y, z);
    m.rotation.y = Math.atan2(x, z) * 0.5; // slight twist, fluffy not square
    bodyGroup.add(m);
    return m;
  });

  // Top puff cap — rounds the back/top of the wool ball.
  const topGeo = new THREE.BoxGeometry(0.34, 0.2, 0.4);
  const topPuff = new THREE.Mesh(topGeo, woolMat);
  topPuff.position.set(0, 0.26, -0.02);
  bodyGroup.add(topPuff);

  // Bottom puff — rounds the underside so legs look tucked into wool.
  const bottomGeo = new THREE.BoxGeometry(0.36, 0.14, 0.42);
  const bottomPuff = new THREE.Mesh(bottomGeo, woolMat);
  bottomPuff.position.set(0, -0.22, 0);
  bodyGroup.add(bottomPuff);

  // ---- Head: small, low-slung, tucked at the front --------------------------
  const headGroup = new THREE.Group();
  headGroup.position.set(0, 0.28, 0.42); // low & forward, "grazing" posture
  root.add(headGroup);

  const headGeo = new THREE.BoxGeometry(0.26, 0.22, 0.24);
  const head = new THREE.Mesh(headGeo, woolMat);
  headGroup.add(head);

  // Big flat button-eyes on the front face of the head.
  const eyeGeo = new THREE.BoxGeometry(0.08, 0.08, 0.02);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(0.08, 0.02, 0.13);
  headGroup.add(eyeL);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeR.position.set(-0.08, 0.02, 0.13);
  headGroup.add(eyeR);

  // Head anchor for name tags — just above the head.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 0.44, 0.42);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // ---- Legs: four short stubby boxes -----------------------------------------
  const legGeo = new THREE.BoxGeometry(0.1, 0.22, 0.1);
  const legPositions = [
    [0.16, 0.11, 0.18],  // front-right
    [-0.16, 0.11, 0.18], // front-left
    [0.16, 0.11, -0.18], // back-right
    [-0.16, 0.11, -0.18],// back-left
  ];
  const legs = legPositions.map(([x, y, z]) => {
    const legPivot = new THREE.Group();
    legPivot.position.set(x, y + 0.11, z); // pivot at hip height
    const legMesh = new THREE.Mesh(legGeo, legMat);
    legMesh.position.set(0, -0.11, 0); // hang below the pivot
    legPivot.add(legMesh);
    root.add(legPivot);
    return legPivot;
  });

  // ---- Tail: one loose trailing thread, dangling from the rear ---------------
  // Built as a short chain of thin boxes hung from a pivot so it can sway.
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.34, -0.3);
  root.add(tailPivot);

  const tailSeg1Geo = new THREE.BoxGeometry(0.05, 0.16, 0.05);
  const tailSeg1 = new THREE.Mesh(tailSeg1Geo, threadMat);
  tailSeg1.position.set(0, -0.08, 0);
  tailPivot.add(tailSeg1);

  const tailSeg2Geo = new THREE.BoxGeometry(0.04, 0.14, 0.04);
  const tailSeg2 = new THREE.Mesh(tailSeg2Geo, threadMat);
  tailSeg2.position.set(0, -0.14, -0.02); // slight curl outward at the tip
  tailPivot.add(tailSeg2);

  // ---- Store references for animation ----------------------------------------
  root.userData.parts = {
    bodyGroup,
    headGroup,
    legs,        // array of 4 pivots: [FR, FL, BR, BL]
    tailPivot,
    corners,
    eyeL,
    eyeR,
  };

  // ---- Animation ---------------------------------------------------------
  // t = seconds elapsed, state = { moving, grounded, fuse, hurt, dimension }
  root.userData.animate = (t, state) => {
    const parts = root.userData.parts;

    // Idle breathing: gentle scale pulse + slight bob, always running.
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
    parts.tailPivot.rotation.z = Math.sin(t * 1.1) * 0.12 + twitch * 0.6;
    parts.tailPivot.rotation.x = Math.cos(t * 0.9) * 0.06;

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

  // Feet-at-y0 sanity: legs bottom sits at y = (0.11+0.11) - 0.11 - 0.11 = 0
  // (pivot at 0.22, leg mesh hangs 0.11 further down -> bottom at 0.0).

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
    'A plump, passive ball of living wool that grazes the fields of Warpwold. ' +
    'Its fleece is stray Thrum caught in loose thread; it trots on four short ' +
    'stubby legs and trails one loose dyed-red thread as a tail.',
};
