import * as THREE from 'three';

// ============================================================================
// SLAGMOTH — a Cinderloom moth that screeches on the wing.
// Archetype: screecher
//
// Silhouette goals (per design brief): a small fuzzy SEGMENTED body (three
// stacked round-ish boxes, tapering toward the tail) with two LARGE angular
// TATTERED wings jutting from the thorax. Each wing is built from a main
// panel plus a smaller stepped-back panel to suggest a torn/notched edge —
// no smooth Minecraft-bat curve, just charred angular tatters. Two thin
// feathery antennae poke up from the head, and a pair of pale under-eyes
// glow faintly beneath the brow. It NEVER lands in this module's animation —
// feet stay off the ground; it hovers via a constant flap + vertical bob,
// even at a dead standstill (state.moving === false).
// ============================================================================

// ---- Palette (canonical Slagmoth bestiary palette) --------------------------
const PALETTE = {
  wingMembrane: 0x5c1e0a, // charred, tattered wing membrane
  emberVein: 0xe86a28,    // glowing ember veins streaked across the wings
  fuzz: 0xa83c14,         // scorched fuzz covering the segmented body
  eyeGlow: 0xf7b24e,      // pale glowing under-eyes (emissive)
};

// Plain centered box mesh.
function box(w, h, d, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function build() {
  const root = new THREE.Group();
  root.name = 'Slagmoth';

  // ---- Materials ---------------------------------------------------------
  const fuzzMat = new THREE.MeshStandardMaterial({
    color: PALETTE.fuzz,
    roughness: 0.85,
    metalness: 0.0,
  });
  const wingMat = new THREE.MeshStandardMaterial({
    color: PALETTE.wingMembrane,
    roughness: 0.6,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.emberVein),
    emissiveIntensity: 0.0,
  });
  const veinMat = new THREE.MeshStandardMaterial({
    color: PALETTE.emberVein,
    roughness: 0.4,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.emberVein),
    emissiveIntensity: 0.7,
  });
  const antennaMat = new THREE.MeshStandardMaterial({
    color: PALETTE.fuzz,
    roughness: 0.9,
    metalness: 0.0,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: PALETTE.eyeGlow,
    roughness: 0.3,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.eyeGlow),
    emissiveIntensity: 1.4,
  });

  // ---- bodyGroup: everything that hovers/bobs/breathes together ----------
  // Base hover height keeps feet well clear of y=0 at all times.
  const HOVER_BASE = 0.62;
  const bodyGroup = new THREE.Group();
  bodyGroup.position.y = HOVER_BASE;
  root.add(bodyGroup);

  // ---- Segmented body: three stacked round-ish boxes, tapering to tail --
  // Head segment (frontmost, faces +Z).
  const headSeg = box(0.18, 0.16, 0.16, fuzzMat);
  headSeg.position.set(0, 0.02, 0.16);
  bodyGroup.add(headSeg);

  // Thorax segment — the largest, wings mount here.
  const thoraxSeg = box(0.22, 0.20, 0.20, fuzzMat);
  thoraxSeg.position.set(0, 0, 0);
  bodyGroup.add(thoraxSeg);

  // Abdomen segment — tapered tail end.
  const abdomenSeg = box(0.16, 0.15, 0.20, fuzzMat);
  abdomenSeg.position.set(0, -0.02, -0.20);
  bodyGroup.add(abdomenSeg);

  // Small tail tip to finish the taper.
  const tailTip = box(0.10, 0.10, 0.10, fuzzMat);
  tailTip.position.set(0, -0.03, -0.32);
  bodyGroup.add(tailTip);

  // ---- Under-eyes: pale glow beneath the brow of the head segment -------
  const eyeL = box(0.045, 0.045, 0.02, eyeMat);
  eyeL.position.set(-0.055, -0.02, 0.245);
  bodyGroup.add(eyeL);

  const eyeR = box(0.045, 0.045, 0.02, eyeMat);
  eyeR.position.set(0.055, -0.02, 0.245);
  bodyGroup.add(eyeR);

  // ---- Antennae: thin feathery stalks pivoting from the head for quiver -
  function makeAntenna(sideSign) {
    const pivot = new THREE.Object3D();
    pivot.position.set(sideSign * 0.06, 0.10, 0.20);
    pivot.rotation.z = sideSign * 0.35;
    bodyGroup.add(pivot);

    const stalk = box(0.02, 0.16, 0.02, antennaMat);
    stalk.position.set(0, 0.08, 0); // grows upward from pivot
    pivot.add(stalk);

    const tuft = box(0.05, 0.04, 0.05, antennaMat);
    tuft.position.set(0, 0.16, 0);
    pivot.add(tuft);

    return { pivot, stalk, tuft };
  }
  const antennaL = makeAntenna(-1);
  const antennaR = makeAntenna(1);

  // ---- Wings: large angular tattered panels mounted on shoulder pivots --
  // Each wing pivots about a shoulder near the thorax so it can rotate
  // about the body's forward (Z) axis to flap. Wing geometry is offset so
  // its inner edge sits at the pivot origin, letting rotation read as a
  // true flap rather than a swing around empty space.
  function makeWing(sideSign) {
    const shoulderPivot = new THREE.Object3D();
    shoulderPivot.position.set(sideSign * 0.11, 0.06, 0.0);
    bodyGroup.add(shoulderPivot);

    // Main wing panel — large, angular, offset outward from the pivot.
    const mainGeo = new THREE.BoxGeometry(0.34, 0.02, 0.30);
    mainGeo.translate(sideSign * 0.17, 0, 0); // inner edge at pivot
    const mainPanel = new THREE.Mesh(mainGeo, wingMat);
    mainPanel.castShadow = true;
    mainPanel.receiveShadow = true;
    shoulderPivot.add(mainPanel);

    // Stepped-back panel — smaller, offset further out and slightly back,
    // suggesting a torn/notched trailing edge (tattered silhouette).
    const notchGeo = new THREE.BoxGeometry(0.16, 0.018, 0.20);
    notchGeo.translate(sideSign * 0.13, 0, 0);
    const notchPanel = new THREE.Mesh(notchGeo, wingMat);
    notchPanel.position.set(sideSign * 0.32, -0.01, -0.09);
    notchPanel.castShadow = true;
    notchPanel.receiveShadow = true;
    shoulderPivot.add(notchPanel);

    // Ember vein streak — a thin glowing strip laid across the main panel.
    const veinGeo = new THREE.BoxGeometry(0.30, 0.008, 0.05);
    veinGeo.translate(sideSign * 0.17, 0, 0);
    const vein = new THREE.Mesh(veinGeo, veinMat);
    vein.position.set(0, 0.014, 0.05);
    shoulderPivot.add(vein);

    return { shoulderPivot, mainPanel, notchPanel, vein };
  }
  const wingL = makeWing(-1);
  const wingR = makeWing(1);

  // ---- Head anchor (for name tags) ---------------------------------------
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, HOVER_BASE + 0.22, 0);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // ---- Store animated parts on userData -----------------------------------
  root.userData.parts = {
    bodyGroup,
    headSeg,
    thoraxSeg,
    abdomenSeg,
    tailTip,
    antennaL,
    antennaR,
    wingL,
    wingR,
    wingMat,
    veinMat,
    eyeMat,
  };

  // -------------------------------------------------------------------
  // ANIMATION
  // The Slagmoth always hovers: continuous wing flap + vertical bob run
  // regardless of state.moving, since it never touches ground. Forward
  // motion pitches the body slightly and quickens the flap; antennae
  // quiver constantly, faster when hurt. Screeching pulses the eye/vein
  // glow.
  // -------------------------------------------------------------------
  root.userData.animate = (t, state) => {
    const parts = root.userData.parts;
    const moving = !!(state && state.moving);
    const hurt = (state && state.hurt) || 0;

    // Flap speed/amplitude: constant baseline hover-flap, faster & wider
    // when moving (fleeing/chasing reads as urgent wingbeats).
    const flapSpeed = moving ? 13.0 : 8.0;
    const flapAmp = moving ? 0.95 : 0.62;
    const flap = Math.sin(t * flapSpeed);

    // Wings rotate about the body's forward (Z) axis, mirrored L/R so they
    // beat like a real moth rather than both swinging the same way.
    parts.wingL.shoulderPivot.rotation.z = flap * flapAmp + 0.12;
    parts.wingR.shoulderPivot.rotation.z = -flap * flapAmp - 0.12;
    // Slight lead-lag on X gives the tattered tips a fluttery trailing feel.
    parts.wingL.shoulderPivot.rotation.x = Math.sin(t * flapSpeed + 0.6) * 0.08;
    parts.wingR.shoulderPivot.rotation.x = Math.sin(t * flapSpeed + 0.6) * 0.08;

    // Hover bob: vertical sine, always active (this creature never lands).
    const hoverBobSpeed = moving ? 5.0 : 3.2;
    const hoverBobAmp = moving ? 0.03 : 0.05;
    const hoverBob = Math.sin(t * hoverBobSpeed) * hoverBobAmp;

    // Idle-breathe: subtle body scale pulse layered under the hover bob.
    const breathe = 1 + Math.sin(t * 2.2) * 0.02;
    parts.bodyGroup.scale.set(breathe, breathe, breathe);

    // Forward pitch while moving — nose-down like a moth diving forward.
    const targetPitch = moving ? -0.18 : 0;
    parts.bodyGroup.rotation.x += (targetPitch - parts.bodyGroup.rotation.x) * 0.15;

    // Slight body roll synced to the flap for extra liveliness.
    parts.bodyGroup.rotation.z = flap * 0.05;

    parts.bodyGroup.position.y = 0.62 + hoverBob;

    // Antennae quiver constantly; faster/sharper when hurt.
    const quiverSpeed = 9.0 + hurt * 20.0;
    const quiverAmp = 0.10 + hurt * 0.25;
    parts.antennaL.pivot.rotation.x = Math.sin(t * quiverSpeed) * quiverAmp;
    parts.antennaR.pivot.rotation.x = Math.sin(t * quiverSpeed + 1.1) * quiverAmp;

    // Screech pulse: eyes and ember veins throb in a slow breathing glow,
    // with a sharp flare layered in when hurt (a startled shriek).
    const glowPulse = 0.55 + Math.sin(t * 3.0) * 0.35;
    const hurtFlare = hurt > 0 ? Math.sin(t * 30) * 0.8 * hurt : 0;
    parts.eyeMat.emissiveIntensity = 1.2 + glowPulse * 0.6 + hurtFlare;
    parts.veinMat.emissiveIntensity = 0.5 + glowPulse * 0.5 + Math.max(0, hurtFlare);
    parts.wingMat.emissiveIntensity = 0.05 + glowPulse * 0.08;
  };

  return root;
}

export const meta = {
  archetype: 'screecher',
  species: 'Slagmoth',
  canonicalId: 'slagmoth',
  dimensionDefault: 'cinderloom',
  palette: {
    wingMembrane: '#5C1E0A',
    wingShadow: '#2B0E06',
    emberVein: '#E86A28',
    fuzz: '#A83C14',
    eyeGlow: '#F7B24E',
  },
  description:
    'A small Cinderloom moth with a fuzzy, segmented dusty-grey body and ' +
    'two large angular wings of charred, tattered membrane streaked with ' +
    'glowing ember veins. Feathery antennae quiver above pale under-eyes ' +
    'that glow with a soft, unsettling light. It never lands — the Slagmoth ' +
    'hovers on ceaselessly beating wings, and when startled lets out a ' +
    'screech that flares its eyes and vein-streaks bright before fading ' +
    'back to a slow ember pulse.',
};
