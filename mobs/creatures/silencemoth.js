import * as THREE from 'three';
import * as rig from '../anim/rig.js';

// ============================================================================
// SILENCE-MOTH — a harmless, ambient Warpwold flyer.
// Archetype: light moth base — a small, pale, fuzzy moth drawn to light and
// prone to nibbling at loose cloth.
//
// Loomfall lore: when a scrap of the Weaver's yarn is combed too fine and
// drifts free of the Loom, it can settle into a tiny fluttering shape that
// seeks out any warmth or glow left burning after dusk. Silence-Moths are
// utterly harmless — they only flit toward lanterns, hems, and mended seams,
// quietly unpicking a few loose threads before drifting on. A few of those
// unpicked threads never quite let go, and now trail loose beneath its own
// body like fine tassels — the clearest tell that this creature is itself
// made of stray yarn, not flesh.
//
// Silhouette: a slender two-segment tapered abdomen, a small fuzzy thorax,
// and a pale head (sized to read clearly, not lost in shadow) with two tiny
// glow eyes and two jointed antennae attached directly to its front — FOUR
// broad pale wings per side (a wide-rooted, tapered-tip forewing + smaller
// trailing hindwing, each with a shaded trim edge and a small glowing
// eyespot near the forewing tip — the single clearest thumbnail-read "moth"
// cue), held in a raised tented "M" rather than flat, plus three SHORT
// glow-tipped thread tendrils trailing from its belly that sway
// independently of the flight motion — short and close together so they
// read as loose thread, never as legs. Small, pale, gently self-luminous,
// and unmistakably textile — NOT a Minecraft mob.
// ============================================================================

// Canonical Silence-Moth bestiary palette (all five used below).
const PALETTE = {
  wing: 0xe8e6f0, // near-white, broad rounded wings — brightest, self-glowing
  wingShade: 0xc9c6d9, // pale grey, wing trim / fuzz tufts / head barbs / tendrils
  body: 0x9b97af, // muted lavender-grey, body segments + head
  dim: 0x6a6680, // darkest accent only — antenna stalks, small in area
  glow: 0xf7f6fb, // luminous white, eyes / eyespots / abdomen marks / tendril tips
};

// Every material below carries a self-tinted emissive term, even the
// "dim" one — this is an "ambient luminous moth" per the brief, not a
// matte creature, so no surface should ever read as flat unlit charcoal
// under a dim/night scene light. wing/glow are the brightest (near-white,
// clearly luminous); body/wingShade are the mid-tone pale bulk of the
// silhouette; dim is reserved for small accents only and still gets a
// faint self-glow so it never crushes to near-black.
function makeMaterials() {
  return {
    wing: new THREE.MeshStandardMaterial({
      color: PALETTE.wing,
      roughness: 0.75,
      metalness: 0.0,
      emissive: new THREE.Color(PALETTE.wing),
      emissiveIntensity: 0.16,
    }),
    wingShade: new THREE.MeshStandardMaterial({
      color: PALETTE.wingShade,
      roughness: 0.85,
      metalness: 0.0,
      emissive: new THREE.Color(PALETTE.wingShade),
      emissiveIntensity: 0.12,
    }),
    body: new THREE.MeshStandardMaterial({
      color: PALETTE.body,
      roughness: 0.85,
      metalness: 0.0,
      emissive: new THREE.Color(PALETTE.body),
      emissiveIntensity: 0.09,
    }),
    dim: new THREE.MeshStandardMaterial({
      color: PALETTE.dim,
      roughness: 0.6,
      metalness: 0.0,
      emissive: new THREE.Color(PALETTE.dim),
      emissiveIntensity: 0.06,
    }),
    glow: new THREE.MeshStandardMaterial({
      color: PALETTE.glow,
      roughness: 0.3,
      metalness: 0.0,
      emissive: new THREE.Color(PALETTE.glow),
      emissiveIntensity: 0.7,
    }),
  };
}

// Defensive numeric coercion, mirroring rig.js's own internal guards, for
// the small amount of arithmetic that happens directly in this file.
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

// Box mesh whose origin sits at its TOP center, so it can be parented to a
// pivot and hang downward from that joint — used for the trailing thread
// tendrils so each one reads as a loose dangling strand.
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
  root.name = 'Silence-Moths';

  const mat = makeMaterials();
  const parts = {};

  // Silence-Moths hover rather than stand, but the module contract still
  // requires feet-at-y0 in rest pose; the animate loop lifts the whole
  // bodyPivot up into its hover height, so the lowest point of the rest
  // pose — the trailing thread tendrils, not a literal foot — sits close
  // to y=0 before animation begins.
  const HOVER_Y = 0.26;
  const GROUNDED_HOVER = 0.05;

  // -------------------------------------------------------------------
  // BODY PIVOT — carries the abdomen, thorax, head, antennae, wings and
  // thread tendrils as one animated unit.
  // -------------------------------------------------------------------
  const bodyPivot = new THREE.Group();
  bodyPivot.position.set(0, HOVER_Y, 0);
  root.add(bodyPivot);

  // ---- Abdomen — two tapered segments for a slender silhouette -------
  const abdomenFore = box(0.075, 0.075, 0.09, mat.body);
  abdomenFore.position.set(0, -0.005, -0.03);
  bodyPivot.add(abdomenFore);

  const abdomenRear = box(0.05, 0.05, 0.07, mat.body);
  abdomenRear.position.set(0, -0.01, -0.1);
  bodyPivot.add(abdomenRear);

  // A single dorsal fuzz ridge at the segment seam — two nubs that sit
  // flush along the spine (not scattered to the sides) so they read as
  // texture on a continuous body mass rather than loose floating blocks.
  const tuftDefs = [
    [0, 0.036, -0.055],
    [0, 0.022, -0.09],
  ];
  const abdomenTufts = tuftDefs.map(([x, y, z]) => {
    const m = box(0.05, 0.016, 0.02, mat.wingShade);
    m.position.set(x, y, z);
    bodyPivot.add(m);
    return m;
  });

  // Small glow-fleck marking on the abdomen — a soft chevron of three
  // dots, a moth-eyespot echo that reads clearly even tiny.
  const markDefs = [
    [0, 0.032, -0.03, 0.018, 0.01, 0.012],
    [-0.022, 0.02, -0.068, 0.014, 0.009, 0.01],
    [0.022, 0.02, -0.068, 0.014, 0.009, 0.01],
  ];
  const abdomenMarks = markDefs.map(([x, y, z, w, h, d]) => {
    const m = box(w, h, d, mat.glow);
    m.position.set(x, y, z);
    bodyPivot.add(m);
    return m;
  });

  // ---- Thorax --------------------------------------------------------
  const thorax = box(0.065, 0.065, 0.075, mat.body);
  thorax.position.set(0, 0.005, 0.03);
  bodyPivot.add(thorax);

  // ---- Head + eyes ------------------------------------------------------
  // Sized up and given the pale "body" material (not the dark "dim"
  // accent) so it reads as a clearly visible mass in its own right —
  // previously a small dim-colored head all but vanished against a dark
  // scene, leaving the antennae/eyes hung on it looking like they were
  // floating disconnected from anything.
  const head = box(0.05, 0.048, 0.044, mat.body);
  head.position.set(0, 0.014, 0.078);
  bodyPivot.add(head);

  const eyeL = box(0.013, 0.013, 0.009, mat.glow);
  eyeL.position.set(-0.015, 0.017, 0.099);
  head.add(eyeL);
  const eyeR = box(0.013, 0.013, 0.009, mat.glow);
  eyeR.position.set(0.015, 0.017, 0.099);
  head.add(eyeR);

  parts.bodyPivot = bodyPivot;

  // -------------------------------------------------------------------
  // ANTENNAE — two jointed, feathery stalks pivoted at the head, each
  // combed with small side barbs for a "feathery" silhouette read, plus
  // a soft-curling tip joint.
  // -------------------------------------------------------------------
  function buildAntenna(side) {
    const pivot = new THREE.Group();
    // Positioned relative to the HEAD's own local origin (pivot is a
    // child of `head`, not `bodyPivot`) so the antenna base sits right at
    // the head's top-front surface instead of floating far out in front
    // of it — previously this used bodyPivot-scale offsets by mistake,
    // leaving a visible gap between the head and its own antennae.
    pivot.position.set(side * 0.016, 0.018, 0.016);
    pivot.rotation.x = -0.55;
    pivot.rotation.z = side * 0.3;
    head.add(pivot);

    const base = box(0.007, 0.035, 0.007, mat.dim);
    base.position.set(0, 0.0175, 0);
    pivot.add(base);

    const barbDefs = [0.012, 0.022, 0.032];
    const barbs = barbDefs.map((y, i) => {
      const b = box(0.018, 0.005, 0.005, mat.wingShade);
      b.position.set(side * 0.011, y, 0);
      b.rotation.z = side * 0.9;
      pivot.add(b);
      return b;
    });

    const tipPivot = new THREE.Group();
    tipPivot.position.set(0, 0.035, 0);
    pivot.add(tipPivot);

    const tip = box(0.006, 0.022, 0.006, mat.dim);
    tip.position.set(0, 0.011, 0);
    tipPivot.add(tip);

    return { pivot, base, barbs, tipPivot, tip, side };
  }

  const antennaL = buildAntenna(-1);
  const antennaR = buildAntenna(1);
  parts.antennaL = antennaL;
  parts.antennaR = antennaR;
  // Back-compat aliases for the original pivot names.
  parts.antennaPivotL = antennaL.pivot;
  parts.antennaPivotR = antennaR.pivot;

  // Head anchor for name tags — small creature, low anchor.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, HOVER_Y + 0.15, 0.03);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // WINGS — a broad forewing plus a smaller trailing hindwing per side,
  // each with a shaded trim edge; the forewing carries a small glowing
  // eyespot near the tip. Each wing is built from a wide ROOT panel plus
  // a narrower, swept TIP panel (the same two-segment taper trick used
  // for the abdomen) instead of one big near-square flat box — a single
  // slab-shaped box read as a flat "tabletop" rather than a wing, no
  // matter how it was angled. animate() adds a raised rest tilt on top
  // of the flutter (see ANIMATION below) so the wings hold a shallow
  // tented "M" shape rather than passing flat-horizontal through most of
  // the flap cycle.
  // -------------------------------------------------------------------
  function buildWing(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.018, 0.02, 0.02);
    bodyPivot.add(pivot);

    const forewingRoot = box(0.095, 0.014, 0.105, mat.wing);
    forewingRoot.position.set(side * 0.05, 0, -0.015);
    pivot.add(forewingRoot);

    const forewingTip = box(0.085, 0.011, 0.065, mat.wing);
    forewingTip.position.set(side * 0.125, 0.006, -0.045);
    forewingTip.rotation.z = side * 0.16;
    pivot.add(forewingTip);

    const forewingTrim = box(0.075, 0.008, 0.05, mat.wingShade);
    forewingTrim.position.set(side * 0.115, -0.008, -0.05);
    pivot.add(forewingTrim);

    const forewingSpot = box(0.018, 0.013, 0.013, mat.glow);
    forewingSpot.position.set(side * 0.155, 0.007, -0.03);
    pivot.add(forewingSpot);

    const hindwingPivot = new THREE.Group();
    hindwingPivot.position.set(side * 0.02, -0.01, -0.055);
    pivot.add(hindwingPivot);

    const hindwingMain = box(0.068, 0.01, 0.058, mat.wing);
    hindwingMain.position.set(side * 0.035, 0, -0.012);
    hindwingPivot.add(hindwingMain);

    const hindwingTip = box(0.05, 0.008, 0.038, mat.wing);
    hindwingTip.position.set(side * 0.075, -0.004, -0.032);
    hindwingTip.rotation.z = side * 0.14;
    hindwingPivot.add(hindwingTip);

    const hindwingTrim = box(0.045, 0.007, 0.032, mat.wingShade);
    hindwingTrim.position.set(side * 0.065, -0.011, -0.03);
    hindwingPivot.add(hindwingTrim);

    return {
      pivot,
      forewingRoot,
      forewingTip,
      forewingTrim,
      forewingSpot,
      hindwingPivot,
      hindwingMain,
      hindwingTip,
      hindwingTrim,
      side,
    };
  }

  const wingL = buildWing(-1);
  const wingR = buildWing(1);
  parts.wingL = wingL;
  parts.wingR = wingR;

  // -------------------------------------------------------------------
  // THREAD TENDRILS — three short loose thread-strands trailing beneath
  // the belly, swaying independently of the flight motion. Lore payoff:
  // the moth is itself made of stray yarn, and a few strands never quite
  // let go. Kept SHORT, THIN, and close together (not splayed wide at an
  // angle) and tipped with a tiny glow bead so they read as dangling
  // luminous thread — previously these were long and splayed wide enough
  // to visually double as a pair of stilt legs propping up the body.
  // -------------------------------------------------------------------
  const tendrilDefs = [
    { x: -0.016, y: -0.028, z: -0.05, rx: 0.06, rz: -0.14, len: 0.11 },
    { x: 0, y: -0.032, z: -0.078, rx: 0.03, rz: 0, len: 0.13 },
    { x: 0.016, y: -0.028, z: -0.05, rx: 0.06, rz: 0.14, len: 0.11 },
  ];
  const tendrils = tendrilDefs.map(({ x, y, z, rx, rz, len }) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    pivot.rotation.x = rx;
    pivot.rotation.z = rz;
    bodyPivot.add(pivot);
    const thread = hangingBox(0.008, len, 0.008, mat.wingShade);
    pivot.add(thread);
    const tip = box(0.013, 0.013, 0.013, mat.glow);
    tip.position.set(0, -len - 0.005, 0);
    pivot.add(tip);
    return { pivot, thread, tip, restX: rx, restZ: rz };
  });
  parts.tendrils = tendrils;

  parts.abdomenFore = abdomenFore;
  parts.abdomenRear = abdomenRear;
  parts.abdomenTufts = abdomenTufts;
  parts.abdomenMarks = abdomenMarks;
  parts.thorax = thorax;
  parts.head = head;
  parts.eyeL = eyeL;
  parts.eyeR = eyeR;
  parts.mat = mat;

  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION — built on mobs/anim/rig.js's procedural-motion helpers.
  // This is a purely ambient, non-combat flyer: telegraph/attack/phase
  // are still read defensively (clamped, never left undefined) so the
  // rig never throws if a caller feeds it combat-shaped state, but a
  // Silence-Moth has no strike of its own to perform with them.
  //
  // Idle/flight: rig.flap drives a fast forewing flutter with a slightly
  //   lagging, softer hindwing flutter behind it; rig.sway/rig.breathe
  //   layer a gentle wandering hover-bob, drift, and yaw wander so it
  //   never looks like it is standing still; rig.sway also drives the
  //   antenna comb quiver and the three thread tendrils, each swaying on
  //   its own independent phase so they read as loose and unweighted.
  //   speed01 raises flutter cadence and drift amplitude when "moving".
  // Turn:   state.turn banks the whole body into the turn (rig.damp
  //   smoothed, so it never snaps).
  // Hurt:   a sharp, fast-decaying startle jolt (rig.damp) shivers the
  //   body and flares the wings outward briefly.
  // Fuse:   an unmaking/fuse state dims the glow and gently shrinks the
  //   moth toward stillness rather than any violent effect.
  // Death:  rig.dissolve — the moth shrinks, sinks, its wings fan open
  //   and its antennae and thread tendrils fling outward as every glow
  //   gutters dark: a soft thread-unravel poof, never gore.
  // -------------------------------------------------------------------
  let prevT = null;
  let lean = 0;
  let flinch = 0;
  let hoverY = HOVER_Y;
  let wingFlinchY = 0;

  root.userData.animate = (t, state) => {
    try {
      const s = state || {};
      const time = n(t, 0);
      let dt = 0;
      if (prevT !== null) dt = Math.max(0, Math.min(0.12, time - prevT));
      prevT = time;

      const moving = !!s.moving;
      const grounded = !!s.grounded;
      const speed01 = clamp01(s.speed01 != null ? s.speed01 : moving ? 1 : 0);
      const hurt = clamp01(s.hurt);
      const fuse = clamp01(s.fuse);
      const dying = clamp01(s.dying);
      const turn = n(s.turn, 0);
      // Read-but-unused combat fields, kept defensive per the module
      // contract even though this ambient creature never attacks.
      void clamp01(s.telegraph);
      void clamp01(s.attack);
      void n(s.phase, 0);

      const safeDt = dt || 0.016;

      // Lean into turns, damped so banking never snaps.
      const leanTarget = dying > 0 ? 0 : Math.max(-0.5, Math.min(0.5, -turn * 0.8));
      lean = rig.damp(lean, leanTarget, 8, safeDt);

      // ---- DEATH: soft thread-unravel poof -------------------------------
      if (dying > 0) {
        const d = rig.dissolve(dying);
        const sc = Math.max(0.05, d.scale);
        bodyPivot.scale.set(sc, sc, sc);
        const restHover = grounded ? GROUNDED_HOVER : HOVER_Y;
        hoverY = rig.damp(hoverY, restHover - d.drop * 0.28, 6, safeDt);
        bodyPivot.position.y = hoverY;
        bodyPivot.rotation.z = lean * 0.15 + d.spread * 0.2;

        // Wings fan open wide, like a pinned specimen coming loose.
        wingL.pivot.rotation.z = 0.7 + d.spread * 0.7;
        wingR.pivot.rotation.z = -0.7 - d.spread * 0.7;
        wingL.hindwingPivot.rotation.z = 0.3 + d.spread * 0.5;
        wingR.hindwingPivot.rotation.z = -0.3 - d.spread * 0.5;

        // Antennae and thread tendrils fling outward — loose yarn coming
        // apart rather than a body breaking.
        antennaL.pivot.rotation.z = antennaL.side * (0.3 + d.spread * 0.8);
        antennaR.pivot.rotation.z = antennaR.side * (0.3 + d.spread * 0.8);
        tendrils.forEach((td, i) => {
          td.pivot.rotation.x = td.restX + d.spread * (0.6 + i * 0.15);
          td.pivot.rotation.z = td.restZ * (1 + d.spread * 1.4);
        });

        // Every glow gutters dark as the thread comes fully undone.
        mat.glow.emissiveIntensity = Math.max(0, 0.6 * (1 - dying));
        mat.wing.emissiveIntensity = Math.max(0, 0.05 * (1 - dying));

        return; // death pose overrides everything below
      }

      // Reset any leftover dissolve transform in case a previous frame
      // was mid-death and the mob got revived/recycled (defensive; must
      // never assume ordering with the mob manager's own lifecycle).
      if (bodyPivot.scale.x !== 1) bodyPivot.scale.set(1, 1, 1);

      // ---- Flight: layered hover-bob + drift + yaw wander ---------------
      const hoverTarget = grounded ? GROUNDED_HOVER : HOVER_Y;
      const bobSpeed = 1.6 + speed01 * 1.4;
      const bobY =
        Math.sin(time * bobSpeed) * 0.03 +
        Math.sin(time * bobSpeed * 0.37 + 1.3) * 0.015 +
        rig.breathe(time, 1.0, 0.9) * 0.5;
      hoverY = rig.damp(hoverY, hoverTarget + bobY, 6, safeDt);
      bodyPivot.position.y = hoverY;
      bodyPivot.position.x = rig.sway(time, 1.2, 0.5, 0) * (0.6 + speed01 * 0.4) + lean * 0.05;
      bodyPivot.position.z = rig.sway(time, 0.8, 0.4, 1.4) * 0.5;

      bodyPivot.rotation.y = rig.sway(time, 1.0, 0.35, 0) * 0.9 + lean * 0.6;
      bodyPivot.rotation.z = rig.sway(time, 0.5, 0.9, 0.6) * 0.3 + lean * 0.4;

      // ---- Wings: fast forewing flutter + softer, lagging hindwing ------
      // REST_WING_RAISE/REST_HIND_RAISE hold the wings in a shallow
      // tented "M" above the body at all times; the flutter oscillates
      // around that raised baseline rather than swinging symmetrically
      // through flat-horizontal, so the wing pair never idles into a
      // flat "tabletop" silhouette mid-beat.
      const REST_WING_RAISE = 0.34;
      const REST_HIND_RAISE = 0.2;
      const flutterFreq = 9.0 + speed01 * 5.0 + hurt * 3.0;
      const flapMain = rig.flap(time, flutterFreq, 0.68);
      wingL.pivot.rotation.z = REST_WING_RAISE + flapMain + wingFlinchY;
      wingR.pivot.rotation.z = -REST_WING_RAISE - flapMain - wingFlinchY;
      wingL.pivot.rotation.x = -0.1 + rig.flap(time + 0.05, flutterFreq * 0.5, 0.1);
      wingR.pivot.rotation.x = -0.1 - rig.flap(time + 0.05, flutterFreq * 0.5, 0.1);

      const flapHind = rig.flap(time - 0.035, flutterFreq, 0.5);
      wingL.hindwingPivot.rotation.z = REST_HIND_RAISE + flapHind * 0.85;
      wingR.hindwingPivot.rotation.z = -REST_HIND_RAISE - flapHind * 0.85;

      // ---- Antennae: comb quiver + lazy sway + tip curl ------------------
      const quiver = Math.sin(time * 14.0) * 0.06 + rig.sway(time, 0.4, 2.2, 0) * 0.05;
      antennaL.pivot.rotation.x = -0.55 + quiver + hurt * 0.15;
      antennaR.pivot.rotation.x = -0.55 - quiver + hurt * 0.15;
      antennaL.pivot.rotation.z = antennaL.side * (0.3 + Math.abs(rig.sway(time, 0.3, 1.7, 0.5)) * 0.25);
      antennaR.pivot.rotation.z = antennaR.side * (0.3 + Math.abs(rig.sway(time, 0.3, 1.7, 0.9)) * 0.25);
      antennaL.tipPivot.rotation.x = Math.sin(time * 10.0 + 0.4) * 0.15;
      antennaR.tipPivot.rotation.x = Math.sin(time * 10.0 + 0.9) * 0.15;

      // ---- Thread tendrils: independent lazy sway, own phase each -------
      tendrils.forEach((td, i) => {
        td.pivot.rotation.x = td.restX + rig.sway(time, 0.6, 0.8, i * 1.7) * 0.5;
        td.pivot.rotation.z = td.restZ + rig.sway(time, 0.5, 0.6, i * 2.3 + 0.5) * 0.4;
      });

      // ---- Hurt: sharp startle jolt, quickly settling --------------------
      flinch = rig.damp(flinch, hurt, 18, safeDt);
      wingFlinchY = rig.damp(wingFlinchY, flinch * 0.35, 15, safeDt);
      if (flinch > 0.001) {
        bodyPivot.rotation.x = Math.sin(time * 34) * 0.18 * flinch;
        bodyPivot.position.y += Math.abs(Math.sin(time * 40)) * -0.015 * flinch;
      } else {
        bodyPivot.rotation.x = rig.damp(bodyPivot.rotation.x, 0, 12, safeDt);
      }

      // ---- Glow: soft breathing luminescence, flares a little on hurt ---
      const pulse = 0.5 + Math.sin(time * 1.8) * 0.25 + rig.breathe(time, 1, 1.4) * 2;
      const hurtFlare = hurt > 0 ? Math.abs(Math.sin(time * 30)) * 0.5 * hurt : 0;
      mat.glow.emissiveIntensity = Math.min(1.4, 0.4 + pulse * 0.3 + hurtFlare + fuse * 0.3);
      // Keep this near (and above) the material's build-time baseline
      // (0.16) rather than stomping it down to a near-invisible value —
      // the whole point of an "ambient luminous moth" is that its pale
      // wings read as gently glowing even at rest, not just its eyes.
      mat.wing.emissiveIntensity = 0.14 + Math.max(0, pulse) * 0.08;

      // ---- Fuse (unmaking): dim and shrink toward stillness -------------
      if (fuse > 0) {
        const fade = 1 - Math.min(fuse, 1);
        bodyPivot.scale.setScalar(0.65 + fade * 0.35);
      } else {
        bodyPivot.scale.setScalar(1);
      }
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
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
    'hem, or mended seam still warm with light. A slender, tapered, fuzzy ' +
    'lavender-grey body carries four broad near-white wings per side — a ' +
    'large forewing marked with a small glowing eyespot, trailing a softer ' +
    'hindwing — that beat in a near-constant blur, two feathery antennae ' +
    'combed with fine side barbs, and three loose thread tendrils trailing ' +
    'from its belly that sway on their own as it wanders. Silence-Moths ' +
    'pose no threat to a Mender — at most they unpick a few loose threads ' +
    'from a hanging cloth before drifting on, their soft luminous markings ' +
    'pulsing gently in the dark.',
};
