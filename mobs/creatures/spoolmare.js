import * as THREE from 'three';

// ---------------------------------------------------------------------------
// SPOOLMARE — a wild, passive Warpwold thread-horse, rideable as a mount.
// Loomfall lore: when a long, well-kept length of yarn slips its spool and
// runs loose across the open fields of Warpwold, it can gather itself into
// a slender, galloping shape — a Spoolmare. Its coat is smooth dusk-lavender
// thread, its mane and tail loose strands of deep-purple yarn that stream
// and sway as it moves, and a banded, spool-like motif marks each flank
// where the last of its birth-thread was never fully unwound.
//
// Silhouette goals: a slender, ELEGANT EQUINE — a long, S-curved three-bone
// neck, tapered head, tapered five-segment torso (chest -> rump), and four
// long legs, ~1.5 units tall. NOT a Minecraft horse: no boxy uniform torso,
// no boxy head. Mane is 12 independent thin dangling thread-strand boxes
// cascading down the neck's crest; tail is 7 independent two-segment
// thread-strands fanned out behind the rump, both swaying/streaming in the
// wind. A protruding 3D wound-thread BOBBIN (two flanges + a banded barrel,
// not a flat medallion) on each flank suggests a wound spool. Passive,
// rideable — exposes a rideAnchor object at the saddle point on its back.
// ---------------------------------------------------------------------------

// Canonical Spoolmare bestiary palette.
const PALETTE = {
  coat: 0xc8b7e0,    // dusk-lavender coat, main
  shadow: 0x9e86c2,  // violet shadow / underside / shading
  mane: 0x6b5694,    // deep purple mane, tail, spool bands
  blaze: 0xf0eaf7,   // near-white blaze / socks
  dark: 0x3a2e52,    // hooves / eyes
};

function makeMaterials() {
  return {
    coat: new THREE.MeshStandardMaterial({
      color: PALETTE.coat,
      roughness: 0.75,
      metalness: 0.02,
    }),
    shadow: new THREE.MeshStandardMaterial({
      color: PALETTE.shadow,
      roughness: 0.8,
      metalness: 0.02,
    }),
    mane: new THREE.MeshStandardMaterial({
      color: PALETTE.mane,
      roughness: 0.6,
      metalness: 0.0,
    }),
    blaze: new THREE.MeshStandardMaterial({
      color: PALETTE.blaze,
      roughness: 0.5,
      metalness: 0.0,
      emissive: new THREE.Color(PALETTE.blaze),
      emissiveIntensity: 0.06,
    }),
    dark: new THREE.MeshStandardMaterial({
      color: PALETTE.dark,
      roughness: 0.4,
      metalness: 0.05,
      emissive: new THREE.Color(PALETTE.dark),
      emissiveIntensity: 0.15,
    }),
  };
}

// Box mesh whose origin sits at its TOP center, so it can hang/droop off a
// joint pivot naturally — used for the mane and tail thread-strand chains.
function hangingBox(w, h, d, material) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(0, -h / 2, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
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
  root.name = 'Spoolmares';

  const mat = makeMaterials();
  const parts = {};

  // Leg reach (upper + lower) sets the hip/shoulder pivot height so all
  // four hooves land exactly at y = 0. Sized, together with the neck/head
  // chain below, so the whole mob's resting height comes out to ~1.5 units
  // — matching the brief and MobManager's ARCHETYPE_CONFIG.spoolmare
  // (halfWidth 0.3, height 1.5) hitbox, so the visible mesh actually fills
  // its own collision box instead of poking out the top of it.
  const UPPER_LEN = 0.34;
  const LOWER_LEN = 0.27;
  const HOOF_H = 0.04;
  const LEG_REACH = UPPER_LEN + LOWER_LEN + HOOF_H; // 0.65
  const HIP_Y = LEG_REACH;

  // -------------------------------------------------------------------
  // BARREL / TORSO — a slender, elongated, TAPERED body sitting atop the
  // legs. Built from five graduated segments (chest -> forebarrel ->
  // midbarrel -> rearbarrel -> rump) instead of one uniform crate, so the
  // silhouette narrows toward both the chest and the rump like a real
  // equine ribcage rather than reading as a rectangular box on legs.
  // -------------------------------------------------------------------
  const torsoPivot = new THREE.Group();
  torsoPivot.position.set(0, HIP_Y, 0);
  root.add(torsoPivot);

  const chest = box(0.19, 0.21, 0.13, mat.coat);
  chest.position.set(0, 0.19, 0.27);
  torsoPivot.add(chest);

  const foreBarrel = box(0.28, 0.27, 0.17, mat.coat);
  foreBarrel.position.set(0, 0.175, 0.15);
  torsoPivot.add(foreBarrel);

  const midBarrel = box(0.31, 0.29, 0.19, mat.coat);
  midBarrel.position.set(0, 0.17, -0.02);
  torsoPivot.add(midBarrel);

  const rearBarrel = box(0.26, 0.25, 0.17, mat.coat);
  rearBarrel.position.set(0, 0.165, -0.19);
  torsoPivot.add(rearBarrel);

  const rump = box(0.19, 0.20, 0.13, mat.coat);
  rump.position.set(0, 0.16, -0.32);
  torsoPivot.add(rump);

  // Shading strip along the belly, following the tapered underline.
  const belly = box(0.27, 0.07, 0.56, mat.shadow);
  belly.position.set(0, 0.015, -0.03);
  torsoPivot.add(belly);

  // Withers ridge, slight rise toward the neck.
  const withers = box(0.19, 0.09, 0.15, mat.coat);
  withers.position.set(0, 0.33, 0.21);
  torsoPivot.add(withers);

  // Croup / rump, slight rise toward the tail base.
  const croup = box(0.21, 0.08, 0.13, mat.coat);
  croup.position.set(0, 0.31, -0.33);
  torsoPivot.add(croup);

  parts.torsoPivot = torsoPivot;

  // -------------------------------------------------------------------
  // WOVEN-SPOOL FLANK MOTIF — a small wound-thread BOBBIN protruding from
  // each flank: two wide mane-colored flanges (the flat ends of a real
  // thread spool) joined by a narrower barrel wrapped in 2-3 alternating
  // winding-thread bands, capped with a small dark axle nub, marking where
  // the birth-thread was never fully unwound. Built with real depth along
  // local X (not a flush flat disc) so it reads as an actual 3D spool
  // rather than a coin/medallion glyph even at a distance.
  // -------------------------------------------------------------------
  function ringMesh(geo, material) {
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  function buildSpoolMark(xSide) {
    const group = new THREE.Group();
    group.position.set(xSide * 0.185, 0.18, -0.03);
    torsoPivot.add(group);

    // CylinderGeometry's native axis is Y; TorusGeometry's native hole-axis
    // is Z -- they need DIFFERENT single-axis rotations to both end up
    // pointing along local X (out of the flank), so each primitive below
    // sets its own rotation rather than sharing one parent rotation.
    const AXIS_OUT_CYL = Math.PI / 2; // Y -> X
    const AXIS_OUT_TORUS = Math.PI / 2; // Z -> X

    // A genuine 3D BOBBIN, not a flat medallion: two wide flanges (the flat
    // ends of a real thread spool) joined by a narrower barrel, with 2-3
    // winding-thread bands wrapped around the barrel between them. The
    // whole stack protrudes out from the flank along local X so, unlike a
    // flush disc, it reads with real depth/silhouette from a 3/4 angle
    // instead of misreading as a flat coin/glyph at a distance.
    const innerFlange = ringMesh(new THREE.CylinderGeometry(0.072, 0.072, 0.015, 16), mat.mane);
    innerFlange.rotation.z = AXIS_OUT_CYL;
    innerFlange.position.x = xSide * 0.012;
    group.add(innerFlange);

    const barrel = ringMesh(new THREE.CylinderGeometry(0.044, 0.044, 0.075, 14), mat.shadow);
    barrel.rotation.z = AXIS_OUT_CYL;
    barrel.position.x = xSide * 0.05;
    group.add(barrel);

    const outerFlange = ringMesh(new THREE.CylinderGeometry(0.072, 0.072, 0.015, 16), mat.mane);
    outerFlange.rotation.z = AXIS_OUT_CYL;
    outerFlange.position.x = xSide * 0.088;
    group.add(outerFlange);

    // Winding-thread bands, alternating light/dark, wrapped around the
    // barrel between the two flanges like coiled yarn on a real bobbin.
    const bandDefs = [
      { x: 0.03, mat: mat.blaze },
      { x: 0.05, mat: mat.dark },
      { x: 0.07, mat: mat.blaze },
    ];
    bandDefs.forEach(({ x, mat: bandMat }) => {
      const band = ringMesh(new THREE.TorusGeometry(0.046, 0.009, 6, 16), bandMat);
      band.rotation.y = AXIS_OUT_TORUS;
      band.position.x = xSide * x;
      group.add(band);
    });

    // Small protruding axle nub past the outer flange, capping the spool.
    const hub = ringMesh(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 8), mat.dark);
    hub.rotation.z = AXIS_OUT_CYL;
    hub.position.x = xSide * 0.105;
    group.add(hub);

    return group;
  }
  const spoolMarkL = buildSpoolMark(-1);
  const spoolMarkR = buildSpoolMark(1);
  parts.spoolMarkL = spoolMarkL;
  parts.spoolMarkR = spoolMarkR;

  // -------------------------------------------------------------------
  // NECK + HEAD — a long, S-curved, THREE-segment neck (base -> mid ->
  // upper) that arches up and forward from the withers into a refined,
  // elongated, tapered equine head (NOT a boxy Mojang-horse head). Three
  // bones (instead of two short ones) give the neck an actual visible
  // curve/length rather than reading as one stiff diagonal strut.
  // -------------------------------------------------------------------
  const NECK_BASE_LEN = 0.16;
  const NECK_MID_LEN = 0.145;
  const NECK_UPPER_LEN = 0.12;

  const neckPivot = new THREE.Group();
  neckPivot.position.set(0, 0.35, 0.30);
  neckPivot.rotation.x = -0.72; // neck springs up and forward from the withers
  torsoPivot.add(neckPivot);

  const neckBase = box(0.145, NECK_BASE_LEN, 0.13, mat.coat);
  neckBase.position.set(0, NECK_BASE_LEN / 2, 0);
  neckPivot.add(neckBase);

  const neckMidPivot = new THREE.Group();
  neckMidPivot.position.set(0, NECK_BASE_LEN, 0);
  neckMidPivot.rotation.x = 0.26; // arch begins curving back toward vertical
  neckPivot.add(neckMidPivot);

  const neckMid = box(0.12, NECK_MID_LEN, 0.115, mat.coat);
  neckMid.position.set(0, NECK_MID_LEN / 2, 0);
  neckMidPivot.add(neckMid);

  const neckUpperPivot = new THREE.Group();
  neckUpperPivot.position.set(0, NECK_MID_LEN, 0);
  neckUpperPivot.rotation.x = 0.20; // crest continues arching toward the poll
  neckMidPivot.add(neckUpperPivot);

  const neckUpper = box(0.095, NECK_UPPER_LEN, 0.095, mat.coat);
  neckUpper.position.set(0, NECK_UPPER_LEN / 2, 0);
  neckUpperPivot.add(neckUpper);

  const headPivot = new THREE.Group();
  headPivot.position.set(0, NECK_UPPER_LEN, 0.015);
  headPivot.rotation.x = 0.10;
  neckUpperPivot.add(headPivot);

  // Elongated, narrow skull (longer front-to-back than it is wide) —
  // the "refined, not boxy" cue continues all the way up from the neck.
  const skull = box(0.095, 0.115, 0.19, mat.coat);
  skull.position.set(0, 0.055, 0.05);
  headPivot.add(skull);

  // Tapered muzzle bridge + tip, narrowing toward the nose in two steps.
  const muzzleBridge = box(0.075, 0.08, 0.13, mat.coat);
  muzzleBridge.position.set(0, 0.015, 0.185);
  headPivot.add(muzzleBridge);

  const muzzleTip = box(0.055, 0.055, 0.07, mat.shadow);
  muzzleTip.position.set(0, -0.015, 0.275);
  headPivot.add(muzzleTip);

  // Near-white blaze stripe down the forehead/nose. Kept shorter than the
  // skull is tall so it stays flush against the face instead of poking
  // up above the head/ear line like a horn.
  const blazeStripe = box(0.02, 0.11, 0.026, mat.blaze);
  blazeStripe.position.set(0, 0.025, 0.185);
  headPivot.add(blazeStripe);

  // Lower jaw, a slim wedge under the muzzle.
  const jaw = box(0.065, 0.04, 0.15, mat.shadow);
  jaw.position.set(0, -0.04, 0.13);
  headPivot.add(jaw);

  // Eyes.
  const eyeL = box(0.018, 0.018, 0.018, mat.dark);
  eyeL.position.set(-0.05, 0.075, 0.13);
  headPivot.add(eyeL);
  const eyeR = box(0.018, 0.018, 0.018, mat.dark);
  eyeR.position.set(0.05, 0.075, 0.13);
  headPivot.add(eyeR);

  // Two small, fine, forward-swept ears — deliberately kept close together
  // and angled inward/forward (not straight upright rods) so they read as
  // alert equine ears rather than horns; the poll forelock tuft (mane
  // array, below) sits right behind them to break up the silhouette.
  const earPivotL = new THREE.Group();
  earPivotL.position.set(-0.032, 0.105, 0.02);
  earPivotL.rotation.z = 0.12;
  earPivotL.rotation.x = -0.18;
  headPivot.add(earPivotL);
  const earL = box(0.02, 0.065, 0.018, mat.mane);
  earL.position.set(0, 0.032, 0);
  earPivotL.add(earL);

  const earPivotR = new THREE.Group();
  earPivotR.position.set(0.032, 0.105, 0.02);
  earPivotR.rotation.z = -0.12;
  earPivotR.rotation.x = -0.18;
  headPivot.add(earPivotR);
  const earR = box(0.02, 0.065, 0.018, mat.mane);
  earR.position.set(0, 0.032, 0);
  earPivotR.add(earR);

  parts.neckPivot = neckPivot;
  parts.neckMidPivot = neckMidPivot;
  parts.neckUpperPivot = neckUpperPivot;
  parts.headPivot = headPivot;
  parts.earPivotL = earPivotL;
  parts.earPivotR = earPivotR;

  // Head anchor for name tags, above the head.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.copy(new THREE.Vector3(0, 0.2, 0.05));
  headPivot.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // MANE — a full chain of loose violet thread-strands flowing along the
  // crest of the now much longer neck, plus a poll forelock tuft between
  // the ears, each independently pivoted so they can stream and sway.
  // Deliberately more numerous and considerably longer than a single
  // "spike" so it reads as a flowing mane rather than a couple of horns.
  // -------------------------------------------------------------------
  const maneDefs = [
    // Poll forelock, right behind the ears.
    { parent: headPivot, x: 0, y: 0.11, z: -0.03, h: 0.10 },
    { parent: headPivot, x: -0.025, y: 0.10, z: -0.02, h: 0.08 },
    { parent: headPivot, x: 0.025, y: 0.10, z: -0.02, h: 0.08 },
    // Upper neck (nearest the poll) — shorter strands. y offsets are
    // fractions of NECK_UPPER_LEN (0.12) so they root along the crest.
    { parent: neckUpperPivot, x: 0, y: 0.105, z: -0.05, h: 0.13 },
    { parent: neckUpperPivot, x: 0.012, y: 0.065, z: -0.06, h: 0.14 },
    { parent: neckUpperPivot, x: -0.012, y: 0.025, z: -0.065, h: 0.14 },
    // Mid neck — fuller, longer strands. Fractions of NECK_MID_LEN (0.145).
    { parent: neckMidPivot, x: 0, y: 0.128, z: -0.07, h: 0.17 },
    { parent: neckMidPivot, x: 0.012, y: 0.077, z: -0.075, h: 0.18 },
    { parent: neckMidPivot, x: -0.012, y: 0.026, z: -0.075, h: 0.17 },
    // Base of the neck, at the withers — the longest, fullest strands.
    // Fractions of NECK_BASE_LEN (0.16).
    { parent: neckPivot, x: 0, y: 0.135, z: -0.075, h: 0.20 },
    { parent: neckPivot, x: 0.013, y: 0.075, z: -0.08, h: 0.21 },
    { parent: neckPivot, x: -0.013, y: 0.025, z: -0.08, h: 0.19 },
  ];
  const mane = maneDefs.map(({ parent, x, y, z, h }) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    parent.add(pivot);
    const strand = hangingBox(0.028, h, 0.024, mat.mane);
    pivot.add(strand);
    return pivot;
  });
  parts.mane = mane;

  // -------------------------------------------------------------------
  // TAIL — SEVEN independent, two-segment loose violet thread-strands
  // fanned out off the rear, each rooted directly at the tail base and
  // swaying on its own phase, so the tail reads unmistakably as a bundle
  // of several separate trailing threads rather than one solid ribbon.
  // -------------------------------------------------------------------
  // Rooted well clear of the rump's back face (rump spans to z ~ -0.385)
  // and tipped back at a steeper angle so the tail visibly trails behind
  // the body's silhouette instead of hugging it.
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.29, -0.44);
  tailPivot.rotation.x = 0.48;
  torsoPivot.add(tailPivot);

  // Each strand: a root pivot fanned out from center, an upper segment,
  // a knee pivot, and a tapered lower segment -- built the same way as a
  // leg, but hanging loose off the tail root instead of reaching the
  // ground, so every strand can independently sway/stream in animate().
  function buildTailStrand({ x, z, upperLen, lowerLen, upperW, lowerW }) {
    const rootPivot = new THREE.Group();
    rootPivot.position.set(x, -0.02, z);
    tailPivot.add(rootPivot);

    const upperSeg = hangingBox(upperW, upperLen, upperW, mat.mane);
    rootPivot.add(upperSeg);

    const kneePivot = new THREE.Group();
    kneePivot.position.set(0, -upperLen, 0);
    rootPivot.add(kneePivot);

    const lowerSeg = hangingBox(lowerW, lowerLen, lowerW, mat.mane);
    kneePivot.add(lowerSeg);

    return { rootPivot, kneePivot };
  }

  const tailStrandDefs = [
    { x: 0, z: 0, upperLen: 0.27, lowerLen: 0.24, upperW: 0.05, lowerW: 0.036 },
    { x: -0.03, z: -0.01, upperLen: 0.25, lowerLen: 0.23, upperW: 0.04, lowerW: 0.03 },
    { x: 0.03, z: -0.01, upperLen: 0.25, lowerLen: 0.23, upperW: 0.04, lowerW: 0.03 },
    { x: -0.055, z: -0.02, upperLen: 0.21, lowerLen: 0.20, upperW: 0.032, lowerW: 0.024 },
    { x: 0.055, z: -0.02, upperLen: 0.21, lowerLen: 0.20, upperW: 0.032, lowerW: 0.024 },
    { x: -0.075, z: -0.035, upperLen: 0.16, lowerLen: 0.16, upperW: 0.026, lowerW: 0.02 },
    { x: 0.075, z: -0.035, upperLen: 0.16, lowerLen: 0.16, upperW: 0.026, lowerW: 0.02 },
  ];
  const tailStrands = tailStrandDefs.map(buildTailStrand);

  parts.tailPivot = tailPivot;
  parts.tailStrands = tailStrands;

  // -------------------------------------------------------------------
  // LEGS — four long, slender legs built from hip/shoulder + knee
  // pivots, each ending in a dark hoof, with near-white "sock" shading
  // on the lower leg.
  // -------------------------------------------------------------------
  function buildLeg(x, z, parentGroup) {
    const upperPivot = new THREE.Group();
    upperPivot.position.set(x, 0, z);
    parentGroup.add(upperPivot);

    const upperLeg = hangingBox(0.075, UPPER_LEN, 0.08, mat.coat);
    upperPivot.add(upperLeg);

    const kneePivot = new THREE.Group();
    kneePivot.position.set(0, -UPPER_LEN, 0);
    upperPivot.add(kneePivot);

    const lowerLeg = hangingBox(0.06, LOWER_LEN, 0.065, mat.blaze);
    kneePivot.add(lowerLeg);

    const hoof = hangingBox(0.07, HOOF_H, 0.08, mat.dark);
    hoof.position.set(0, -LOWER_LEN, 0);
    kneePivot.add(hoof);

    return { upperPivot, kneePivot, upperLeg, lowerLeg, hoof };
  }

  // Front legs pivot from a group under the withers/chest.
  const frontLegsGroup = new THREE.Group();
  frontLegsGroup.position.set(0, HIP_Y, 0.21);
  root.add(frontLegsGroup);
  const legFR = buildLeg(-0.11, 0, frontLegsGroup);
  const legFL = buildLeg(0.11, 0, frontLegsGroup);

  // Rear legs pivot from a group under the croup/rump.
  const rearLegsGroup = new THREE.Group();
  rearLegsGroup.position.set(0, HIP_Y, -0.32);
  root.add(rearLegsGroup);
  const legBR = buildLeg(-0.12, 0, rearLegsGroup);
  const legBL = buildLeg(0.12, 0, rearLegsGroup);

  // legs array in [FR, FL, BR, BL] order, matching the diagonal-pair gait.
  const legs = [legFR, legFL, legBR, legBL];
  parts.legs = legs;

  // -------------------------------------------------------------------
  // RIDE ANCHOR — the saddle point on the back of the barrel, where a
  // rider is seated. Exposed on root.userData for the mount system.
  // -------------------------------------------------------------------
  const SADDLE_Y = HIP_Y + 0.32; // top of the barrel, just behind the withers
  const rideAnchor = new THREE.Object3D();
  rideAnchor.name = 'rideAnchor';
  rideAnchor.position.set(0, SADDLE_Y, 0.02);
  root.add(rideAnchor);
  root.userData.rideAnchor = rideAnchor;
  root.userData.saddleY = SADDLE_Y;

  // -------------------------------------------------------------------
  // Store all animated sub-parts for animate() to reach.
  // -------------------------------------------------------------------
  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION
  // Idle: weight-shift sway + mane/tail thread sway + occasional tail
  //       flick + ear swivel.
  // Walk: springy 4-leg gallop, diagonal pairs (FR+BL, FL+BR), body
  //       surges with each stride, mane/tail stream out, plus a brief
  //       "fray-stitching" shimmer pass across the coat.
  // Hurt: rears up on the hind legs, then bolts forward.
  // -------------------------------------------------------------------
  root.userData.animate = (t, state) => {
    const s = state || {};
    const moving = !!s.moving;
    const hurt = s.hurt || 0;

    // Gentle idle breathing, always active.
    const breathe = Math.sin(t * 1.8);
    torsoPivot.scale.set(1 + breathe * 0.01, 1 + breathe * 0.02, 1 + breathe * 0.008);

    if (hurt > 0) {
      // --- Rear up and bolt ---
      const rear = Math.min(hurt, 1);
      const rearAngle = Math.sin(rear * Math.PI * 0.5) * 0.6;
      torsoPivot.rotation.x = -rearAngle * 0.5;
      root.position.y = rearAngle * 0.18;
      neckPivot.rotation.x = -0.72 - rearAngle * 0.3;

      legFR.upperPivot.rotation.x = -rearAngle * 1.1;
      legFL.upperPivot.rotation.x = -rearAngle * 1.1;
      legBR.upperPivot.rotation.x = rearAngle * 0.5;
      legBL.upperPivot.rotation.x = rearAngle * 0.5;
      legFR.kneePivot.rotation.x = rearAngle * 0.6;
      legFL.kneePivot.rotation.x = rearAngle * 0.6;

      const boltShake = Math.sin(t * 40) * hurt * 0.05;
      torsoPivot.rotation.z = boltShake;
      earPivotL.rotation.x = -0.5;
      earPivotR.rotation.x = -0.5;
    } else if (moving) {
      // --- Springy diagonal-pair gallop ---
      const stride = t * 11.0;
      const swing = 0.65;

      legFR.upperPivot.rotation.x = Math.sin(stride) * swing;
      legBL.upperPivot.rotation.x = Math.sin(stride) * swing;
      legFL.upperPivot.rotation.x = Math.sin(stride + Math.PI) * swing;
      legBR.upperPivot.rotation.x = Math.sin(stride + Math.PI) * swing;

      legFR.kneePivot.rotation.x = Math.max(0, Math.sin(stride - 0.5)) * 0.75;
      legBL.kneePivot.rotation.x = Math.max(0, Math.sin(stride - 0.5)) * 0.75;
      legFL.kneePivot.rotation.x = Math.max(0, Math.sin(stride - 0.5 + Math.PI)) * 0.75;
      legBR.kneePivot.rotation.x = Math.max(0, Math.sin(stride - 0.5 + Math.PI)) * 0.75;

      // Springy vertical surge and slight pitch with each stride.
      root.position.y = Math.abs(Math.sin(stride)) * 0.06;
      torsoPivot.rotation.x = Math.sin(stride) * 0.05;
      neckPivot.rotation.x = -0.72 + Math.sin(stride) * 0.05;

      // Mane and tail stream out with the gallop.
      mane.forEach((strand, i) => {
        strand.rotation.x = -0.35 + Math.sin(stride * 0.9 + i * 0.5) * 0.25;
        strand.rotation.z = Math.sin(stride * 0.7 + i * 0.8) * 0.15;
      });
      tailPivot.rotation.x = 0.2 + Math.sin(stride * 0.6) * 0.1;
      tailStrands.forEach(({ rootPivot, kneePivot }, i) => {
        rootPivot.rotation.z = Math.sin(stride * 0.85 + i * 0.7) * 0.3;
        rootPivot.rotation.x = Math.sin(stride * 0.7 + i * 0.5) * 0.12;
        kneePivot.rotation.z = Math.sin(stride * 0.8 + i * 0.7 + 0.9) * 0.4;
      });

      earPivotL.rotation.x = -0.2;
      earPivotR.rotation.x = -0.2;

      // Brief "fray-stitching" shimmer — a fast pulsing emissive tick on
      // the blaze/sock trim, evoking loose thread catching the light as
      // it gallops.
      const shimmer = 0.06 + Math.max(0, Math.sin(stride * 3.0)) * 0.35;
      mat.blaze.emissiveIntensity = shimmer;
    } else {
      // --- Idle weight-shift + thread sway ---
      const idle = t * 1.1;
      torsoPivot.rotation.z = Math.sin(idle * 0.5) * 0.015;
      root.position.y = Math.sin(idle * 0.7) * 0.006;

      legs.forEach((leg, i) => {
        const drift = Math.sin(idle * 0.6 + i * 1.9) * 0.015;
        leg.upperPivot.rotation.x += (drift - leg.upperPivot.rotation.x) * 0.08;
        leg.kneePivot.rotation.x += (0.02 - leg.kneePivot.rotation.x) * 0.08;
      });

      mane.forEach((strand, i) => {
        strand.rotation.x = Math.sin(idle * 0.8 + i * 0.6) * 0.1 - 0.02;
        strand.rotation.z = Math.sin(idle * 0.6 + i * 0.9) * 0.08;
      });

      // Tail sway with an occasional sharper flick every few seconds.
      const flickCycle = t % 4.0;
      let flick = 0;
      if (flickCycle < 0.5) {
        flick = Math.sin((flickCycle / 0.5) * Math.PI) * 0.5;
      }
      tailPivot.rotation.x = 0.48 + Math.sin(idle * 0.5) * 0.04;
      tailStrands.forEach(({ rootPivot, kneePivot }, i) => {
        rootPivot.rotation.z = Math.sin(idle * 0.5 + i * 0.6) * 0.12 + flick * (0.2 + i * 0.03);
        kneePivot.rotation.z = Math.sin(idle * 0.5 + i * 0.6 + 0.9) * 0.16 + flick * (0.3 + i * 0.04);
      });

      // Ears swivel gently, tracking idle attentiveness.
      earPivotL.rotation.x = Math.sin(idle * 0.9) * 0.1;
      earPivotR.rotation.x = Math.sin(idle * 0.9 + 0.4) * 0.1;
      earPivotL.rotation.z = Math.sin(idle * 0.7) * 0.08;
      earPivotR.rotation.z = -Math.sin(idle * 0.7) * 0.08;

      mat.blaze.emissiveIntensity = 0.06;
    }

    // Spool-mark flanks give a faint independent thread-tremor at all
    // times, echoing the birth-thread never fully unwound.
    const spoolTremor = Math.sin(t * 2.4) * 0.01;
    spoolMarkL.rotation.y = spoolTremor;
    spoolMarkR.rotation.y = -spoolTremor;
  };

  return root;
}

export const meta = {
  archetype: 'quadruped',
  species: 'Spoolmares',
  canonicalId: 'spoolmare',
  dimensionDefault: 'warpwold',
  palette: {
    coat: '#C8B7E0',
    shadow: '#9E86C2',
    mane: '#6B5694',
    blaze: '#F0EAF7',
    dark: '#3A2E52',
  },
  description:
    'A wild, passive thread-horse that gathers itself when a long, well-kept ' +
    'length of yarn slips its spool and runs loose across the open fields ' +
    'of Warpwold. Slender and elegant, with a long neck, refined tapered ' +
    'head, and four long legs in dusk-lavender coat shading to violet at ' +
    'the belly and muzzle. Its mane and tail are loose strands of deep-' +
    'purple thread that stream and flick as it moves, and a small banded ' +
    'spool mark on each flank shows where the last of its birth-thread was ' +
    'never fully unwound. Menders who approach calmly may gain its trust ' +
    'and ride it, seated at the woven saddle-point along its back.',
};
