import * as THREE from 'three';

// ---------------------------------------------------------------------------
// SCALDWARDEN — a neutral Cinderloom forge-guardian.
// Archetype: forge-keeper (tall robed sentinel) — bound in an unfinished
// order, still patrolling the ember-spindles for a Weaver who never came
// back to release it. Loomfall lore: Scaldwardens ignore Menders entirely,
// murmuring low ceaseless reports to empty niches, unless a thief steals
// from the forges — then the deep hood's ember eyes flare and every warden
// within earshot answers as one. Passive by default; this module renders
// only the idle/guardian silhouette and its slow, patient animation.
//
// Silhouette goals: TALL, BROAD, HOODED robed figure, imposing and wider
// at the base like a heavy floor-length robe (no visible feet/legs). A
// deep, mostly-empty hood with a faint ember glow inside. Molten
// crack-seams glowing down the front and sides of the robe. Two heavy,
// mitt-like hands resting forward at the hem, holding nothing here (the
// spindle-stave is a combat prop, out of scope for this passive base
// model). ~1.5 units tall overall. NOT a Minecraft villager/piglin —
// broader, seam-cracked, hood entirely dark but for pinpoint ember eyes.
// ---------------------------------------------------------------------------

const PALETTE = {
  robe: 0x8c1f1f,     // deep forge-red robe, main cloth
  fold: 0x5e1212,     // dark fold / hood-interior edge
  seam: 0xd9803c,     // molten crack-seam, emissive
  shadow: 0x2e0a0a,   // near-black deep shadow / hood void
  ember: 0xf2c066,    // ember glow, emissive hood-light & seam highlights
};

function makeMaterials() {
  return {
    robe: new THREE.MeshStandardMaterial({
      color: PALETTE.robe,
      roughness: 0.85,
      metalness: 0.05,
    }),
    fold: new THREE.MeshStandardMaterial({
      color: PALETTE.fold,
      roughness: 0.9,
      metalness: 0.05,
    }),
    seam: new THREE.MeshStandardMaterial({
      color: PALETTE.seam,
      roughness: 0.4,
      metalness: 0.1,
      emissive: new THREE.Color(PALETTE.seam),
      emissiveIntensity: 0.85,
    }),
    shadow: new THREE.MeshStandardMaterial({
      color: PALETTE.shadow,
      roughness: 0.95,
      metalness: 0.0,
    }),
    ember: new THREE.MeshStandardMaterial({
      color: PALETTE.ember,
      roughness: 0.3,
      metalness: 0.05,
      emissive: new THREE.Color(PALETTE.ember),
      emissiveIntensity: 1.0,
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

// Box mesh whose origin sits at its TOP center, so it can hang off a joint
// pivot naturally — used for the robe skirt panels and sleeves.
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
  root.name = 'Scaldwarden';

  const mat = makeMaterials();
  const parts = {};

  // -------------------------------------------------------------------
  // BODY PIVOT — the whole figure sways from here for the slow, heavy
  // breathing idle and ponderous glide walk.
  // -------------------------------------------------------------------
  const bodyPivot = new THREE.Group();
  bodyPivot.position.set(0, 0, 0);
  root.add(bodyPivot);
  parts.bodyPivot = bodyPivot;

  // -------------------------------------------------------------------
  // ROBE SKIRT — a broad, floor-length, tiered skirt so no feet show and
  // the base reads wider than the shoulders. Built as four stacked,
  // progressively wider hanging tiers from hip height down to the floor.
  // -------------------------------------------------------------------
  const skirtPivot = new THREE.Group();
  skirtPivot.position.set(0, 0.62, 0);
  bodyPivot.add(skirtPivot);

  const skirtTiers = [];
  const tierDefs = [
    { w: 0.62, h: 0.16, d: 0.42, y: 0.0, mat: mat.robe },
    { w: 0.70, h: 0.16, d: 0.48, y: -0.16, mat: mat.fold },
    { w: 0.78, h: 0.16, d: 0.54, y: -0.32, mat: mat.robe },
    { w: 0.86, h: 0.14, d: 0.60, y: -0.48, mat: mat.fold },
  ];
  tierDefs.forEach(({ w, h, d, y, mat: m }) => {
    const tier = box(w, h, d, m);
    tier.position.set(0, y - h / 2, 0);
    skirtPivot.add(tier);
    skirtTiers.push(tier);
  });
  parts.skirtTiers = skirtTiers;

  // Molten seam-cracks running down the front of the skirt.
  const skirtSeamL = hangingBox(0.03, 0.60, 0.02, mat.seam);
  skirtSeamL.position.set(-0.12, 0.0, 0.22);
  skirtPivot.add(skirtSeamL);
  const skirtSeamR = hangingBox(0.03, 0.52, 0.02, mat.seam);
  skirtSeamR.position.set(0.14, -0.04, 0.23);
  skirtPivot.add(skirtSeamR);
  parts.skirtSeams = [skirtSeamL, skirtSeamR];

  // -------------------------------------------------------------------
  // TORSO — a heavy, broad-shouldered mass above the skirt, sloping
  // outward slightly at the base to blend into the robe's bulk.
  // -------------------------------------------------------------------
  const torsoPivot = new THREE.Group();
  torsoPivot.position.set(0, 0.62, 0);
  bodyPivot.add(torsoPivot);

  const torsoLower = box(0.50, 0.24, 0.34, mat.robe);
  torsoLower.position.set(0, 0.12, 0);
  torsoPivot.add(torsoLower);

  const torsoUpper = box(0.44, 0.22, 0.30, mat.robe);
  torsoUpper.position.set(0, 0.34, 0);
  torsoPivot.add(torsoUpper);

  const chestSeam = box(0.04, 0.40, 0.02, mat.seam);
  chestSeam.position.set(0, 0.24, 0.17);
  torsoPivot.add(chestSeam);

  const shoulderYoke = box(0.54, 0.10, 0.32, mat.fold);
  shoulderYoke.position.set(0, 0.46, 0);
  torsoPivot.add(shoulderYoke);

  parts.torsoPivot = torsoPivot;
  parts.chestSeam = chestSeam;

  // -------------------------------------------------------------------
  // HOOD/HEAD — a deep, mostly-empty hood, dark inside but for a faint
  // ember glow and two pinpoint eyes.
  // -------------------------------------------------------------------
  const hoodPivot = new THREE.Group();
  hoodPivot.position.set(0, 0.90, 0.0);
  torsoPivot.add(hoodPivot);

  const hoodOuter = box(0.38, 0.34, 0.36, mat.fold);
  hoodOuter.position.set(0, 0.17, -0.02);
  hoodPivot.add(hoodOuter);

  // Hood void — deep near-black interior, inset so the outer hood reads
  // as an overhanging cowl.
  const hoodVoid = box(0.28, 0.26, 0.20, mat.shadow);
  hoodVoid.position.set(0, 0.15, 0.10);
  hoodPivot.add(hoodVoid);

  // Faint ember glow deep in the hood.
  const hoodGlow = box(0.14, 0.10, 0.04, mat.ember);
  hoodGlow.position.set(0, 0.14, 0.18);
  hoodPivot.add(hoodGlow);

  // Two pinpoint ember eyes.
  const eyeL = box(0.035, 0.035, 0.02, mat.ember);
  eyeL.position.set(-0.065, 0.16, 0.195);
  hoodPivot.add(eyeL);
  const eyeR = box(0.035, 0.035, 0.02, mat.ember);
  eyeR.position.set(0.065, 0.16, 0.195);
  hoodPivot.add(eyeR);

  // Hood peak, rising behind the crown.
  const hoodPeak = box(0.18, 0.14, 0.14, mat.fold);
  hoodPeak.position.set(0, 0.36, -0.06);
  hoodPivot.add(hoodPeak);

  parts.hoodPivot = hoodPivot;
  parts.hoodGlow = hoodGlow;
  parts.eyes = [eyeL, eyeR];

  // Head anchor for name tags — above the hood peak.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 0.90 + 0.46, 0.0);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // ARMS/SLEEVES — heavy, wide sleeves hanging from the shoulders, each
  // ending in a mitt-like hand resting forward at the hem.
  // -------------------------------------------------------------------
  function buildArm(x, parent) {
    const shoulderPivot = new THREE.Group();
    shoulderPivot.position.set(x, 0.44, 0);
    parent.add(shoulderPivot);

    const sleeveUpper = hangingBox(0.16, 0.26, 0.18, mat.robe);
    shoulderPivot.add(sleeveUpper);

    const elbowPivot = new THREE.Group();
    elbowPivot.position.set(0, -0.26, 0.02);
    shoulderPivot.add(elbowPivot);

    const sleeveLower = hangingBox(0.15, 0.22, 0.17, mat.fold);
    elbowPivot.add(sleeveLower);
    // rotate forward slightly so the sleeve reaches toward the front hem
    elbowPivot.rotation.x = 0.35;

    const mitt = box(0.16, 0.11, 0.16, mat.shadow);
    mitt.position.set(0, -0.24, 0.05);
    elbowPivot.add(mitt);

    const mittSeam = box(0.03, 0.03, 0.14, mat.seam);
    mittSeam.position.set(0, -0.19, 0.05);
    elbowPivot.add(mittSeam);

    return { shoulderPivot, elbowPivot, sleeveUpper, sleeveLower, mitt };
  }

  const armL = buildArm(-0.30, torsoPivot);
  const armR = buildArm(0.30, torsoPivot);
  parts.armL = armL;
  parts.armR = armR;

  // -------------------------------------------------------------------
  // Store all animated sub-parts for animate() to reach.
  // -------------------------------------------------------------------
  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION
  // Idle: slow heavy breathing sway (torso + hood + skirt) and a slow
  //       ember/seam glow pulse.
  // Walk: ponderous glide — the whole robe sways side-to-side and bobs
  //       gently, hem tiers lag slightly for a heavy-cloth read, no
  //       visible legs stepping (feet never show).
  // Guardian: never initiates attack unprovoked; if state.attack is set
  //       (e.g. after being provoked) the arms raise slightly and the
  //       hood eyes flare brighter as a warning tell.
  // Hurt: a stiff robed flinch, seams flare briefly.
  // -------------------------------------------------------------------
  root.userData.animate = (t, state) => {
    const s = state || {};
    const moving = !!s.moving;
    const hurt = s.hurt || 0;
    const attack = s.attack || 0;

    // Slow heavy breathing sway — always active.
    const breathe = Math.sin(t * 0.9);
    torsoPivot.scale.set(1 + breathe * 0.012, 1 + breathe * 0.02, 1 + breathe * 0.012);
    hoodPivot.position.y = 0.90 + breathe * 0.008;

    // Seam / ember glow pulse.
    const pulse = 0.75 + Math.sin(t * 1.6) * 0.25;
    mat.seam.emissiveIntensity = 0.6 + pulse * 0.5;
    mat.ember.emissiveIntensity = 0.8 + pulse * 0.5;

    if (moving) {
      // --- Ponderous glide ---
      const glide = t * 1.6;
      const sway = Math.sin(glide) * 0.06;
      bodyPivot.rotation.z = sway;
      bodyPivot.position.y = Math.abs(Math.sin(glide * 2)) * 0.02;
      bodyPivot.position.x = Math.sin(glide) * 0.015;

      // Hem tiers lag behind the sway for a heavy-cloth feel.
      skirtTiers.forEach((tier, i) => {
        tier.rotation.z = Math.sin(glide - i * 0.5) * 0.04;
      });

      // Sleeves swing gently as the figure glides forward.
      armL.shoulderPivot.rotation.x = Math.sin(glide + Math.PI) * 0.08;
      armR.shoulderPivot.rotation.x = Math.sin(glide) * 0.08;
    } else {
      // --- Idle patrol-stand ---
      bodyPivot.rotation.z += (0 - bodyPivot.rotation.z) * 0.05;
      bodyPivot.position.x += (0 - bodyPivot.position.x) * 0.05;
      bodyPivot.position.y = Math.sin(t * 0.9) * 0.006;

      skirtTiers.forEach((tier, i) => {
        tier.rotation.z = Math.sin(t * 0.7 + i * 0.6) * 0.015;
      });

      armL.shoulderPivot.rotation.x += (0 - armL.shoulderPivot.rotation.x) * 0.08;
      armR.shoulderPivot.rotation.x += (0 - armR.shoulderPivot.rotation.x) * 0.08;
    }

    // Guardian warning tell — only when actively provoked/attacking,
    // never unprovoked. Arms lift slightly, hood eyes flare.
    if (attack > 0) {
      const a = Math.min(attack, 1);
      armL.elbowPivot.rotation.x = 0.35 - a * 0.5;
      armR.elbowPivot.rotation.x = 0.35 - a * 0.5;
      hoodGlow.material.emissiveIntensity = 1.0 + a * 1.0;
      mat.ember.emissiveIntensity = 1.0 + a * 1.0;
    } else {
      armL.elbowPivot.rotation.x += (0.35 - armL.elbowPivot.rotation.x) * 0.1;
      armR.elbowPivot.rotation.x += (0.35 - armR.elbowPivot.rotation.x) * 0.1;
    }

    // Hurt flinch — a stiff, robed jolt with a brief seam flare.
    if (hurt > 0) {
      torsoPivot.rotation.z = Math.sin(t * 26) * hurt * 0.1;
      hoodPivot.rotation.x = -hurt * 0.12;
      mat.seam.emissiveIntensity = 1.2 + hurt * 0.6;
    } else {
      torsoPivot.rotation.z *= 0.75;
      hoodPivot.rotation.x *= 0.8;
    }
  };

  return root;
}

export const meta = {
  archetype: 'forge-keeper',
  species: 'Scaldwarden',
  canonicalId: 'scaldwarden',
  dimensionDefault: 'cinderloom',
  palette: {
    robe: '#8C1F1F',
    fold: '#5E1212',
    seam: '#D9803C',
    shadow: '#2E0A0A',
    ember: '#F2C066',
  },
  description:
    'A tall, broad, hooded forge-keeper bound to patrol the ember-spindles ' +
    'of Cinderloom for a Weaver who never came back to release it. Its ' +
    'floor-length forge-red robe flares wide at the base so no feet ever ' +
    'show, molten crack-seams glowing like stitching down its front and ' +
    'sleeves. The deep hood is almost entirely dark, but for a faint ' +
    'ember glow and two pinpoint eyes watching the niches it murmurs ' +
    'reports to. It ignores Menders entirely and never attacks unprovoked ' +
    '- until something is taken from its forge, at which point its glow ' +
    'flares and its heavy mitt-like hands rise in warning. Its ceaseless, ' +
    'purposeless diligence is the most heartbreaking sight in the ' +
    'underworld.',
};
