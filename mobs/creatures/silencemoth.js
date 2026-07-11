import * as THREE from 'three';

// ---------------------------------------------------------------------------
// SILENCE-MOTH — a harmless, ambient Warpwold flyer.
// Archetype: light moth base — a small, pale, fuzzy moth drawn to light and
// prone to nibbling at loose cloth. Loomfall lore: when a scrap of the
// Weaver's yarn is combed too fine and drifts free of the Loom, it can
// settle into a tiny fluttering shape that seeks out any warmth or glow
// left burning after dusk. Silence-Moths are utterly harmless — they only
// flit toward lanterns, hems, and mended seams, quietly unpicking a few
// loose threads before drifting on.
//
// Silhouette goals: SMALL (~0.4u), soft FUZZY body made of two tiny
// round-ish segments, two BROAD PALE rounded wings (thin flat boxes) that
// flutter rapidly, two short feathery antennae, faint luminous glow.
// Delicate and small — noticeably smaller and paler than the Slagmoth.
// NOT a Minecraft mob.
// ---------------------------------------------------------------------------

// Canonical Silence-Moth bestiary palette.
const PALETTE = {
  wing: 0xe8e6f0,   // near-white, broad rounded wings
  wingShade: 0xc9c6d9, // pale grey, wing underside/shading trim
  body: 0x9b97af,   // muted lavender-grey, fuzzy body segments
  dim: 0x6a6680,    // dim body shadow / eyes
  glow: 0xf7f6fb,   // luminous white, faint emissive glow spots
};

function makeMaterials() {
  return {
    wing: new THREE.MeshStandardMaterial({
      color: PALETTE.wing,
      roughness: 0.85,
      metalness: 0.0,
      emissive: new THREE.Color(PALETTE.wing),
      emissiveIntensity: 0.05,
    }),
    wingShade: new THREE.MeshStandardMaterial({
      color: PALETTE.wingShade,
      roughness: 0.9,
      metalness: 0.0,
    }),
    body: new THREE.MeshStandardMaterial({
      color: PALETTE.body,
      roughness: 0.9,
      metalness: 0.0,
    }),
    dim: new THREE.MeshStandardMaterial({
      color: PALETTE.dim,
      roughness: 0.6,
      metalness: 0.0,
    }),
    glow: new THREE.MeshStandardMaterial({
      color: PALETTE.glow,
      roughness: 0.3,
      metalness: 0.0,
      emissive: new THREE.Color(PALETTE.glow),
      emissiveIntensity: 0.6,
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
  root.name = 'Silence-Moths';

  const mat = makeMaterials();
  const parts = {};

  // Silence-Moths hover rather than stand, but the module contract still
  // requires feet-at-y0 in rest pose; the animate loop lifts the whole
  // root up into its hover height, so the base body sits with its lowest
  // point (the belly segment) right at y=0 before animation begins.
  const HOVER_Y = 0.24;

  // -------------------------------------------------------------------
  // BODY PIVOT — carries the two fuzzy segments, head, and antennae.
  // -------------------------------------------------------------------
  const bodyPivot = new THREE.Group();
  bodyPivot.position.set(0, HOVER_Y, 0);
  root.add(bodyPivot);

  // Rear/abdomen segment — small, rounded-read fuzzy box.
  const abdomen = box(0.07, 0.07, 0.10, mat.body);
  abdomen.position.set(0, -0.01, -0.06);
  bodyPivot.add(abdomen);

  // Thorax segment — slightly smaller, forward of the abdomen.
  const thorax = box(0.06, 0.06, 0.07, mat.body);
  thorax.position.set(0, 0.005, 0.02);
  bodyPivot.add(thorax);

  // Tiny dim head nub at the front.
  const head = box(0.04, 0.04, 0.035, mat.dim);
  head.position.set(0, 0.01, 0.065);
  bodyPivot.add(head);

  // Two faint glow flecks on the abdomen — the moth's soft luminous marks.
  const glowL = box(0.015, 0.015, 0.01, mat.glow);
  glowL.position.set(-0.02, 0.005, -0.04);
  bodyPivot.add(glowL);
  const glowR = box(0.015, 0.015, 0.01, mat.glow);
  glowR.position.set(0.02, 0.005, -0.04);
  bodyPivot.add(glowR);

  parts.bodyPivot = bodyPivot;

  // -------------------------------------------------------------------
  // ANTENNAE — two short feathery stalks pivoted at the head, quivering.
  // -------------------------------------------------------------------
  const antennaPivotL = new THREE.Group();
  antennaPivotL.position.set(-0.015, 0.03, 0.075);
  antennaPivotL.rotation.x = -0.5;
  antennaPivotL.rotation.z = 0.25;
  head.add(antennaPivotL);
  const antennaL = box(0.008, 0.05, 0.008, mat.dim);
  antennaL.position.set(0, 0.025, 0);
  antennaPivotL.add(antennaL);

  const antennaPivotR = new THREE.Group();
  antennaPivotR.position.set(0.015, 0.03, 0.075);
  antennaPivotR.rotation.x = -0.5;
  antennaPivotR.rotation.z = -0.25;
  head.add(antennaPivotR);
  const antennaR = box(0.008, 0.05, 0.008, mat.dim);
  antennaR.position.set(0, 0.025, 0);
  antennaPivotR.add(antennaR);

  parts.antennaPivotL = antennaPivotL;
  parts.antennaPivotR = antennaPivotR;

  // Head anchor for name tags — small creature, low anchor.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, HOVER_Y + 0.14, 0.02);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // WINGS — two broad, pale, rounded wings (thin flat boxes) hinged at
  // the thorax, fluttering rapidly. Each wing is built from a pivot at
  // the body seam plus a shading trim strip for a rounded, layered read.
  // -------------------------------------------------------------------
  function buildWing(sign) {
    const pivot = new THREE.Group();
    pivot.position.set(sign * 0.015, 0.015, 0.02);
    bodyPivot.add(pivot);

    const wingMain = box(0.14, 0.01, 0.11, mat.wing);
    wingMain.position.set(sign * 0.075, 0, -0.01);
    pivot.add(wingMain);

    const wingTrim = box(0.10, 0.008, 0.06, mat.wingShade);
    wingTrim.position.set(sign * 0.075, -0.008, -0.03);
    pivot.add(wingTrim);

    return { pivot, wingMain, wingTrim };
  }

  const wingL = buildWing(-1);
  const wingR = buildWing(1);
  parts.wingL = wingL;
  parts.wingR = wingR;

  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION
  // Always-on: rapid wing flutter, gentle drifting hover-bob (figure-ish
  // wandering lift), quivering antennae. Ambient creature — no real
  // combat state, but hurt/fuse are honored with a small startled twitch
  // and moving/grounded gently modulate flutter speed and hover height.
  // -------------------------------------------------------------------
  root.userData.animate = (t, state) => {
    const s = state || {};
    const moving = !!s.moving;
    const grounded = !!s.grounded;
    const hurt = s.hurt || 0;
    const fuse = s.fuse || 0;

    // Gentle drifting hover-bob — slow vertical and lateral wander so the
    // moth never looks like it's standing still, even when "grounded".
    const bobSpeed = moving ? 2.6 : 1.6;
    const hoverLift = grounded ? 0.04 : HOVER_Y;
    const bobY = Math.sin(t * bobSpeed) * 0.03 + Math.sin(t * bobSpeed * 0.37) * 0.015;
    bodyPivot.position.y += (hoverLift + bobY - bodyPivot.position.y) * 0.15;
    bodyPivot.position.x = Math.sin(t * 0.8) * 0.03;
    bodyPivot.position.z = Math.sin(t * 0.55 + 1.1) * 0.02;

    // Slight roll/yaw drift as it wanders, like a real moth's wobble.
    bodyPivot.rotation.y = Math.sin(t * 0.6) * 0.25;
    bodyPivot.rotation.z = Math.sin(t * 1.3) * 0.06;

    // Rapid wing flutter — always active, the moth's defining motion.
    const flutterSpeed = moving ? 26.0 : 20.0;
    const flutterAmount = 0.9;
    const flap = Math.sin(t * flutterSpeed) * flutterAmount;
    wingL.pivot.rotation.z = flap;
    wingR.pivot.rotation.z = -flap;
    wingL.pivot.rotation.x = Math.sin(t * flutterSpeed * 0.5) * 0.1;
    wingR.pivot.rotation.x = Math.sin(t * flutterSpeed * 0.5 + 0.3) * 0.1;

    // Antennae quiver constantly, a small fast tremor.
    const quiver = Math.sin(t * 12.0) * 0.06;
    antennaPivotL.rotation.x = -0.5 + quiver;
    antennaPivotR.rotation.x = -0.5 - quiver;
    antennaPivotL.rotation.z = 0.25 + Math.sin(t * 9.0 + 0.5) * 0.05;
    antennaPivotR.rotation.z = -0.25 - Math.sin(t * 9.0 + 0.5) * 0.05;

    // Faint pulsing glow flecks — soft, unhurried breathing light.
    const pulse = 0.5 + Math.sin(t * 1.8) * 0.25;
    glowL.material.emissiveIntensity = 0.4 + pulse * 0.3;
    glowR.material.emissiveIntensity = 0.4 + pulse * 0.3;

    // Startled twitch on hurt — a sharp little flinch, quickly settling.
    if (hurt > 0) {
      bodyPivot.rotation.x = Math.sin(t * 30) * hurt * 0.2;
      wingL.pivot.rotation.y = hurt * 0.4;
      wingR.pivot.rotation.y = -hurt * 0.4;
    } else {
      bodyPivot.rotation.x *= 0.8;
      wingL.pivot.rotation.y *= 0.8;
      wingR.pivot.rotation.y *= 0.8;
    }

    // If a fuse/unmaking state is present, the moth dims and its flutter
    // slows toward stillness rather than any violent effect.
    if (fuse > 0) {
      const fade = 1 - Math.min(fuse, 1);
      bodyPivot.scale.setScalar(0.7 + fade * 0.3);
    } else {
      bodyPivot.scale.setScalar(1);
    }
  };

  return root;
}

export const meta = {
  archetype: 'light moth',
  species: 'Silence-Moths',
  canonicalId: 'silence_moth',
  dimensionDefault: 'warpwold',
  palette: {
    wing: '#E8E6F0',
    wingShade: '#C9C6D9',
    body: '#9B97AF',
    dim: '#6A6680',
    glow: '#F7F6FB',
  },
  description:
    'A tiny, harmless flutter of combed-fine yarn that never made it back ' +
    'to the Loom, drifting through Warpwold after dusk toward any lantern, ' +
    'hem, or mended seam still warm with light. Its two fuzzy pale-grey ' +
    'body segments carry a pair of broad, near-white rounded wings that ' +
    'beat in a near-constant blur, and two short feathery antennae quiver ' +
    'as it hovers and wanders. Silence-Moths pose no threat to a Mender — ' +
    'at most they unpick a few loose threads from a hanging cloth before ' +
    'drifting on, their faint luminous markings pulsing softly in the dark.',
};
