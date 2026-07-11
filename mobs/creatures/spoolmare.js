import * as THREE from 'three';
import { breathe, sway, walkPhase, damp, windUp, strike, dissolve } from '../anim/rig.js';

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
// long thin legs, ~1.5 units tall. NOT a Minecraft horse: no boxy uniform
// torso, no boxy head.
//
// MANE (the part 4 prior passes flagged as illegible/too-spiky): FOURTEEN
// independent, chunky, TWO-BONE thread strands (root segment + a bent tip
// segment, exactly like the tail's own two-bone chain), rooted with real
// standoff clearance BEHIND the neck's crest, cascading continuously from
// the poll forelock all the way down to the withers. The two-bone chain is
// the key legibility fix over the previous single-rigid-box strands: a
// lone straight box reads as a comb tooth / stegosaurus plate no matter how
// it's tilted, but a root segment feeding into a BENT, TAPERED tip segment
// reads as a strand of hair drooping under its own weight. Baked tilt is
// kept gentle (a soft fan, not a wide splay) so neighboring strands overlap
// into a dense cascade rather than separating into visible individual
// teeth; the baked backward "bend" at each strand's knee pivot is what
// sells the drape/stream direction (the strand curls back along the neck)
// instead of poking straight out to the side like an ear/spike. From the
// front this still reads as a wide, textured ridge (the x-offsets still
// exceed each neck bone's own half-width); from the side/3-4 it reads as a
// long, softly curving cascade instead of a jagged edge.
//
// TAIL: SEVEN independent two-segment thread-strands, each baked with a
// static fan angle (a real horizontal spread, not just a few millimeters of
// offset) so the tail reads as a genuinely fanned bundle at rest, then
// streams/sways further in animate(). Widened/thickened and fanned further
// out than prior passes, with the root pivot pulled back and slightly
// raised so more strands clear the rump's own silhouette from directly
// behind/above instead of being swallowed by the body.
//
// A protruding 3D wound-thread BOBBIN (two flanges + a banded barrel, not a
// flat medallion) on each flank suggests a wound spool. Passive, rideable —
// exposes a rideAnchor object at the saddle point on its back, plus a
// procedural gait (rig.walkPhase-driven diagonal-pair trot/gallop that
// blends with state.speed01) with a distinct springy "mount gait" bounce.
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
// joint pivot naturally — used for the mane, tail and leg chains.
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

// Defensive numeric coercion — never let a missing/NaN state field poison a
// transform. Mirrors rig.js's internal `num()` for the arithmetic that
// happens directly in this file (rig's own exports already self-guard).
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

  // Two small, flat, strongly forward-swept ears — shortened and pitched
  // much further forward/outward than earlier passes so they lie low
  // against the skull instead of standing up as vertical "crown prongs"
  // (the llama-ear failure mode judges flagged). Tapered (wider base than
  // tip, via two stacked box sizes) rather than a uniform rod, and kept
  // close together so the poll forelock tuft (mane array, below) reads as
  // continuous with them instead of a separate spike further back.
  const earPivotL = new THREE.Group();
  earPivotL.position.set(-0.03, 0.098, 0.03);
  earPivotL.rotation.z = 0.22;
  earPivotL.rotation.x = -0.45;
  headPivot.add(earPivotL);
  const earBaseL = box(0.024, 0.032, 0.02, mat.mane);
  earBaseL.position.set(0, 0.016, 0);
  earPivotL.add(earBaseL);
  const earTipL = box(0.014, 0.022, 0.014, mat.mane);
  earTipL.position.set(0, 0.042, 0.004);
  earPivotL.add(earTipL);

  const earPivotR = new THREE.Group();
  earPivotR.position.set(0.03, 0.098, 0.03);
  earPivotR.rotation.z = -0.22;
  earPivotR.rotation.x = -0.45;
  headPivot.add(earPivotR);
  const earBaseR = box(0.024, 0.032, 0.02, mat.mane);
  earBaseR.position.set(0, 0.016, 0);
  earPivotR.add(earBaseR);
  const earTipR = box(0.014, 0.022, 0.014, mat.mane);
  earTipR.position.set(0, 0.042, 0.004);
  earPivotR.add(earTipR);

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
  // MANE — FOURTEEN independent, chunky, TWO-BONE violet thread strands
  // running the FULL dorsal line of the neck, poll to withers. Legibility
  // fixes vs. earlier (still-too-spiky) passes:
  //   1. TWO-BONE CHAIN, not one rigid box: a root segment feeds into a
  //      bent, TAPERED tip segment (mirrors the tail's own knee-jointed
  //      strands). A single straight box reads as a comb tooth / stegosaur
  //      plate at every angle no matter how it's tilted; a bent, tapered
  //      two-segment chain reads as a drooping strand of hair instead.
  //   2. GENTLE baked fan tilt (kept small) so neighboring strands overlap
  //      into one dense cascade rather than visibly separating into teeth,
  //      while a baked backward BEND at each strand's knee pivot sells the
  //      "drape/stream backward along the neck" direction instead of
  //      "poke straight out sideways like an ear/spike".
  //   3. Each segment is noticeably wider/deeper than a hairline sliver so
  //      it doesn't disappear at thumbnail size, tapering from a chunky
  //      root width down to a narrower (but still thick) tip width.
  // -------------------------------------------------------------------
  // Flanking (non-center) strands' |x| deliberately EXCEEDS the local neck
  // bone's own half-width at that height (skull ~0.0475, neck-upper
  // ~0.0475, neck-mid ~0.0575, neck-base/withers ~0.0725) -- e.g. 0.06 vs a
  // 0.0475 skull half-width, 0.085 vs a 0.0725 base-neck half-width -- so a
  // genuine strand WIDTH, not just a foreshortened tip, silhouettes past
  // both sides of the neck even from a straight-on front view, while the z
  // standoff plus the two-bone bend read as a full soft cascade from the
  // side/3-4.
  const maneDefs = [
    // Poll forelock, right behind the ears.
    { parent: headPivot, x: 0, y: 0.115, z: -0.05, uLen: 0.065, lLen: 0.065, uW: 0.056, lW: 0.038, tilt: 0.0, droop: -0.14, bend: -0.34 },
    { parent: headPivot, x: -0.06, y: 0.10, z: -0.04, uLen: 0.058, lLen: 0.058, uW: 0.05, lW: 0.034, tilt: -0.14, droop: -0.08, bend: -0.3 },
    { parent: headPivot, x: 0.06, y: 0.10, z: -0.04, uLen: 0.058, lLen: 0.058, uW: 0.05, lW: 0.034, tilt: 0.14, droop: -0.08, bend: -0.3 },
    // Upper neck (nearest the poll). y offsets are fractions of
    // NECK_UPPER_LEN (0.12) so they root along the crest; z pushes each
    // strand's root clearly behind the neck bone's own back face.
    { parent: neckUpperPivot, x: 0, y: 0.11, z: -0.085, uLen: 0.095, lLen: 0.09, uW: 0.058, lW: 0.038, tilt: 0.02, droop: -0.1, bend: -0.36 },
    { parent: neckUpperPivot, x: 0.064, y: 0.075, z: -0.09, uLen: 0.10, lLen: 0.095, uW: 0.056, lW: 0.036, tilt: 0.16, droop: -0.08, bend: -0.32 },
    { parent: neckUpperPivot, x: -0.064, y: 0.04, z: -0.095, uLen: 0.10, lLen: 0.095, uW: 0.056, lW: 0.036, tilt: -0.16, droop: -0.08, bend: -0.32 },
    // Mid neck -- fuller, longer strands. Fractions of NECK_MID_LEN (0.145).
    { parent: neckMidPivot, x: 0, y: 0.13, z: -0.10, uLen: 0.115, lLen: 0.11, uW: 0.062, lW: 0.04, tilt: -0.02, droop: -0.08, bend: -0.34 },
    { parent: neckMidPivot, x: 0.078, y: 0.088, z: -0.105, uLen: 0.12, lLen: 0.115, uW: 0.06, lW: 0.038, tilt: 0.18, droop: -0.06, bend: -0.3 },
    { parent: neckMidPivot, x: -0.078, y: 0.045, z: -0.11, uLen: 0.115, lLen: 0.11, uW: 0.06, lW: 0.038, tilt: -0.18, droop: -0.06, bend: -0.3 },
    { parent: neckMidPivot, x: 0.02, y: 0.01, z: -0.115, uLen: 0.105, lLen: 0.10, uW: 0.054, lW: 0.035, tilt: 0.08, droop: -0.04, bend: -0.26 },
    // Base of the neck, at the withers -- the longest, fullest strands.
    // Fractions of NECK_BASE_LEN (0.16).
    { parent: neckPivot, x: 0, y: 0.14, z: -0.115, uLen: 0.135, lLen: 0.13, uW: 0.066, lW: 0.042, tilt: 0.03, droop: -0.06, bend: -0.32 },
    { parent: neckPivot, x: 0.088, y: 0.09, z: -0.12, uLen: 0.14, lLen: 0.135, uW: 0.062, lW: 0.04, tilt: 0.2, droop: -0.04, bend: -0.28 },
    { parent: neckPivot, x: -0.088, y: 0.045, z: -0.125, uLen: 0.135, lLen: 0.13, uW: 0.062, lW: 0.04, tilt: -0.2, droop: -0.04, bend: -0.28 },
    { parent: neckPivot, x: 0, y: 0.005, z: -0.12, uLen: 0.125, lLen: 0.12, uW: 0.056, lW: 0.036, tilt: 0.0, droop: -0.02, bend: -0.24 },
  ];
  function buildManeStrand({ parent, x, y, z, uLen, lLen, uW, lW, tilt, droop, bend }, i) {
    const rootPivot = new THREE.Group();
    rootPivot.position.set(x, y, z);
    rootPivot.rotation.z = tilt;
    rootPivot.rotation.x = droop;
    parent.add(rootPivot);

    const upperSeg = hangingBox(uW, uLen, uW * 0.7, mat.mane);
    rootPivot.add(upperSeg);

    const kneePivot = new THREE.Group();
    kneePivot.position.set(0, -uLen, 0);
    kneePivot.rotation.x = bend;
    rootPivot.add(kneePivot);

    // Tapered tip segment (narrower than the root segment) so each strand
    // comes to a soft point like a real hank of thread, not a blunt box end.
    const lowerSeg = hangingBox(lW, lLen, lW * 0.7, mat.mane);
    kneePivot.add(lowerSeg);

    return { rootPivot, kneePivot, baseTilt: tilt, baseDroop: droop, baseBend: bend, phase: i * 0.85 };
  }
  const mane = maneDefs.map(buildManeStrand);
  parts.mane = mane;

  // -------------------------------------------------------------------
  // TAIL — SEVEN independent, two-segment loose violet thread-strands
  // fanned out off the rear. Each strand's root pivot carries a BAKED
  // static fan angle (`tilt`, up to ~+-0.62rad / ~35 degrees) so the tail
  // is already visibly spread into distinct trailing threads at rest, not
  // just a narrow near-vertical clump waiting on animation to separate it.
  // -------------------------------------------------------------------
  // Rooted well clear of the rump's back face (rump spans to z ~ -0.385)
  // and tipped back at a steeper angle so the tail visibly trails behind
  // the body's silhouette instead of hugging it.
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.30, -0.46);
  tailPivot.rotation.x = 0.40; // less steeply-down than before, so more of
  // the fan clears the rump's own silhouette and stays readable from
  // directly behind/above (the one angle prior passes lost strand count on).
  torsoPivot.add(tailPivot);

  // Each strand: a root pivot fanned out from center (baked tilt + small
  // x/z offset), an upper segment, a knee pivot, and a tapered lower
  // segment -- built the same way as a leg, but hanging loose off the tail
  // root instead of reaching the ground, so every strand can independently
  // sway/stream in animate() on top of its own baked fan pose.
  function buildTailStrand({ x, z, tilt, upperLen, lowerLen, upperW, lowerW }, i) {
    const rootPivot = new THREE.Group();
    rootPivot.position.set(x, -0.02, z);
    rootPivot.rotation.z = tilt;
    tailPivot.add(rootPivot);

    const upperSeg = hangingBox(upperW, upperLen, upperW * 0.85, mat.mane);
    rootPivot.add(upperSeg);

    const kneePivot = new THREE.Group();
    kneePivot.position.set(0, -upperLen, 0);
    rootPivot.add(kneePivot);

    const lowerSeg = hangingBox(lowerW, lowerLen, lowerW * 0.85, mat.mane);
    kneePivot.add(lowerSeg);

    return { rootPivot, kneePivot, baseTilt: tilt, phase: i * 0.97 };
  }

  // Widened/thickened and fanned further out than earlier passes (both the
  // tilt spread and the x/z root offsets are larger), and rooted a touch
  // further back/higher (tailPivot, above) so more of the seven strands
  // silhouette clear of the hip/rump when viewed from directly behind or
  // above, instead of being hidden behind the body.
  const tailStrandDefs = [
    { tilt: 0.0, x: 0, z: 0, upperLen: 0.32, lowerLen: 0.28, upperW: 0.07, lowerW: 0.05 },
    { tilt: -0.28, x: -0.03, z: -0.008, upperLen: 0.29, lowerLen: 0.26, upperW: 0.062, lowerW: 0.045 },
    { tilt: 0.28, x: 0.03, z: -0.008, upperLen: 0.29, lowerLen: 0.26, upperW: 0.062, lowerW: 0.045 },
    { tilt: -0.50, x: -0.06, z: -0.02, upperLen: 0.255, lowerLen: 0.23, upperW: 0.054, lowerW: 0.038 },
    { tilt: 0.50, x: 0.06, z: -0.02, upperLen: 0.255, lowerLen: 0.23, upperW: 0.054, lowerW: 0.038 },
    { tilt: -0.68, x: -0.085, z: -0.034, upperLen: 0.21, lowerLen: 0.20, upperW: 0.046, lowerW: 0.032 },
    { tilt: 0.68, x: 0.085, z: -0.034, upperLen: 0.21, lowerLen: 0.20, upperW: 0.046, lowerW: 0.032 },
  ];
  const tailStrands = tailStrandDefs.map(buildTailStrand);

  parts.tailPivot = tailPivot;
  parts.tailStrands = tailStrands;

  // -------------------------------------------------------------------
  // LEGS — four long, slender legs built from hip/shoulder + knee
  // pivots, each ending in a dark hoof. The lower leg is shaded with the
  // violet `shadow` tone (NOT the near-white `blaze` tone) deliberately:
  // an off-white lower-leg "sock" against a body-colored upper leg is the
  // exact two-tone marking vanilla Minecraft horses use, and was flagged
  // by every review pass as the clearest remaining Mojang-resemblance risk
  // even though the mane/tail/spool are original. Using the tonal violet
  // shadow color instead keeps a readable leg segment break without the
  // white-on-body sock contrast.
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

    const lowerLeg = hangingBox(0.06, LOWER_LEN, 0.065, mat.shadow);
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
  //
  // Idle:   weight-shift sway + breathing + independent mane/tail strand
  //         sway (each strand its own phase, layered on its baked rest
  //         tilt so it never looks like it "snaps flat" between frames).
  // Walk/
  // Gallop: rig.walkPhase() drives a diagonal-pair leg cycle (FR+BL,
  //         FL+BR) blended by state.speed01, plus a springy "mount gait"
  //         vertical bounce/pitch, neck bob, and mane/tail streaming back
  //         proportional to speed.
  // Hurt:   rears up on the hind legs, then bolts, decaying with state.hurt.
  // Death:  rig.dissolve(state.dying) shrinks/sinks the body and flings
  //         legs + mane/tail strands outward as the thread unravels.
  // Lean:   state.turn banks the torso into turns, damped for smoothness.
  // Telegraph/attack: subtle ears-back + head pull anticipation using
  //         rig.windUp()/rig.strike(), harmless if never driven.
  // -------------------------------------------------------------------
  let prevT = null;
  let lean = 0;

  root.userData.animate = (t, state) => {
    try {
      const s = state || {};
      const time = n(t, 0);
      let dt = 0;
      if (prevT !== null) dt = Math.max(0, Math.min(0.12, time - prevT));
      prevT = time;

      const moving = !!s.moving;
      const grounded = s.grounded !== false; // default true if unspecified
      const hurt = clamp01(s.hurt);
      const dying = clamp01(s.dying);
      const telegraph = clamp01(s.telegraph);
      const attack = clamp01(s.attack);
      const turn = n(s.turn, 0);
      const speed01 = clamp01(s.speed01 != null ? s.speed01 : (moving ? 1 : 0));

      // Gentle idle breathing, always active (subtler once dissolving).
      const breatheAmt = breathe(time, 1, 1) * (1 - dying);
      torsoPivot.scale.set(1 + breatheAmt * 0.4, 1 + breatheAmt * 0.8, 1 + breatheAmt * 0.32);

      // ---- Lean into turns (damped, applied everywhere but death) ----
      const leanTarget = dying > 0 ? 0 : Math.max(-0.32, Math.min(0.32, -turn * 0.14));
      lean = damp(lean, leanTarget, 7, dt);

      if (dying > 0) {
        // --- DEATH: thread-unravel dissolve ---
        const d = dissolve(dying);
        const sc = Math.max(0.03, d.scale);
        root.scale.set(sc, sc, sc);
        root.position.y = -d.drop * 0.9;

        torsoPivot.rotation.x = -d.spread * 0.35;
        torsoPivot.rotation.z = lean;
        neckPivot.rotation.x = -0.72 - d.spread * 0.5;

        legs.forEach((leg, i) => {
          const side = i % 2 === 0 ? -1 : 1; // FR/BR = -1(ish), FL/BL = 1
          const front = i < 2 ? -1 : 1;
          leg.upperPivot.rotation.z = side * d.spread * 0.9;
          leg.upperPivot.rotation.x = front * d.spread * 0.4;
          leg.kneePivot.rotation.x = d.spread * 0.7;
        });

        mane.forEach(({ rootPivot, kneePivot, baseTilt, baseDroop, baseBend }, i) => {
          const side = i % 2 === 0 ? -1 : 1;
          rootPivot.rotation.z = baseTilt + side * d.spread * 1.1;
          rootPivot.rotation.x = baseDroop - d.spread * 0.7;
          kneePivot.rotation.x = baseBend - d.spread * 0.9;
          kneePivot.rotation.z = side * d.spread * 0.6;
        });
        tailStrands.forEach(({ rootPivot, kneePivot, baseTilt }, i) => {
          const side = i % 2 === 0 ? -1 : 1;
          rootPivot.rotation.z = baseTilt + side * d.spread * 0.8;
          kneePivot.rotation.z = side * d.spread * 0.9;
        });

        earPivotL.rotation.x = -0.4;
        earPivotR.rotation.x = -0.4;
        mat.blaze.emissiveIntensity = Math.max(0, 0.06 * (1 - dying));
        return; // death pose overrides everything else below
      }

      // Reset root scale in case a previous frame was mid-dissolve and the
      // mob got revived/recycled (defensive; MobManager normally removes
      // dead mobs, but animate() must never assume that ordering).
      if (root.scale.x !== 1) root.scale.set(1, 1, 1);

      if (hurt > 0) {
        // --- Rear up and bolt ---
        const rearAngle = Math.sin(Math.min(hurt, 1) * Math.PI * 0.5) * 0.6;
        torsoPivot.rotation.x = -rearAngle * 0.5;
        torsoPivot.rotation.z = Math.sin(time * 40) * hurt * 0.05 + lean;
        root.position.y = rearAngle * 0.18;
        neckPivot.rotation.x = -0.72 - rearAngle * 0.3;

        legFR.upperPivot.rotation.x = -rearAngle * 1.1;
        legFL.upperPivot.rotation.x = -rearAngle * 1.1;
        legBR.upperPivot.rotation.x = rearAngle * 0.5;
        legBL.upperPivot.rotation.x = rearAngle * 0.5;
        legFR.kneePivot.rotation.x = rearAngle * 0.6;
        legFL.kneePivot.rotation.x = rearAngle * 0.6;

        mane.forEach(({ rootPivot, kneePivot, baseTilt, baseDroop, baseBend }, i) => {
          rootPivot.rotation.x = baseDroop - rearAngle * 0.5;
          rootPivot.rotation.z = baseTilt + Math.sin(time * 9 + i) * 0.12 * hurt;
          kneePivot.rotation.x = baseBend - rearAngle * 0.3;
          kneePivot.rotation.z = Math.sin(time * 9 + i + 0.5) * 0.15 * hurt;
        });
        tailStrands.forEach(({ rootPivot, baseTilt }, i) => {
          rootPivot.rotation.z = baseTilt + Math.sin(time * 8 + i) * 0.2 * hurt;
        });

        earPivotL.rotation.x = -0.5;
        earPivotR.rotation.x = -0.5;
      } else {
        // Stride cadence kept in one place so leg swing, body pitch/bounce
        // and mane/tail streaming all stay phase-locked to the same
        // footfalls. Mirrors rig.walkPhase's own internal cadence formula.
        const strideFreq = 2.6; // brisk, springy "mount gait" trot
        const cadence = strideFreq * (0.35 + 0.65 * speed01);
        const stride = time * cadence;

        const walk = walkPhase(time, speed01, strideFreq);
        legFR.upperPivot.rotation.x = walk.FR;
        legBL.upperPivot.rotation.x = walk.BL;
        legFL.upperPivot.rotation.x = walk.FL;
        legBR.upperPivot.rotation.x = walk.BR;
        legFR.kneePivot.rotation.x = Math.max(0, walk.FR) * 1.05;
        legBL.kneePivot.rotation.x = Math.max(0, walk.BL) * 1.05;
        legFL.kneePivot.rotation.x = Math.max(0, walk.FL) * 1.05;
        legBR.kneePivot.rotation.x = Math.max(0, walk.BR) * 1.05;

        // Idle-blend the remaining slack (speed01 -> 0) with a slow weight
        // shift so the mare is never a frozen statue between strides.
        const idleAmt = 1 - speed01;
        legs.forEach((leg, i) => {
          const drift = sway(time, 0.25, 1, i * 1.9) * idleAmt;
          leg.upperPivot.rotation.x += drift;
        });

        // Springy vertical bounce + pitch, timed to footfalls -- the
        // "mount gait" spring the brief calls for, distinct from a flat
        // idle bob.
        root.position.y = walk.lift * 0.09 + (grounded ? 0 : 0.05);
        torsoPivot.rotation.x = (walk.lift - 0.5) * 0.10 * speed01;
        torsoPivot.rotation.z = Math.sin(time * 0.5) * 0.015 * idleAmt + lean;
        neckPivot.rotation.x = -0.72 + Math.sin(stride) * 0.05 * speed01
          + sway(time, 0.5, 0.9, 0.3) * idleAmt;

        // Mane and tail: idle sway blends into a swept-back stream as
        // speed01 rises, each strand layered on its own baked rest tilt
        // and its own phase so no two strands move in lockstep.
        mane.forEach(({ rootPivot, kneePivot, baseTilt, baseDroop, baseBend, phase }) => {
          const idleSwayX = sway(time, 1, 1, phase) * idleAmt;
          const idleSwayZ = sway(time, 0.8, 1.3, phase + 1.7) * idleAmt;
          const streamDroop = -0.55 * speed01;
          const streamFlutter = Math.sin(stride * 1.4 + phase) * 0.16 * speed01;
          rootPivot.rotation.x = baseDroop + streamDroop + idleSwayX + streamFlutter * 0.4;
          rootPivot.rotation.z = baseTilt + idleSwayZ + Math.sin(stride * 1.1 + phase * 1.3) * 0.1 * speed01;
          // Tip segment bends further back as speed rises (extra stream on
          // top of the baked bend) and gets its own gentle idle sway so the
          // strand's two bones never move in perfect lockstep.
          const kneeIdleSway = sway(time, 1.1, 1, phase + 2.4) * idleAmt;
          kneePivot.rotation.x = baseBend - streamDroop * 0.6 + kneeIdleSway * 0.5;
          kneePivot.rotation.z = Math.sin(stride * 1.2 + phase * 1.1) * 0.08 * speed01;
        });

        tailPivot.rotation.x = 0.48 + Math.sin(stride * 0.6) * 0.06 * speed01
          + sway(time, 0.4, 0.6, 0) * idleAmt;
        tailStrands.forEach(({ rootPivot, kneePivot, baseTilt, phase }) => {
          const idleSway = sway(time, 1, 1, phase) * idleAmt;
          const stream = Math.sin(stride * 0.85 + phase) * 0.28 * speed01;
          rootPivot.rotation.z = baseTilt + idleSway + stream;
          rootPivot.rotation.x = sway(time, 0.5, 0.8, phase + 0.6) * idleAmt
            + speed01 * 0.1;
          kneePivot.rotation.z = Math.sin(stride * 0.8 + phase + 0.9) * (0.2 + 0.3 * speed01)
            + idleSway * 0.6;
        });

        // Occasional idle tail flick when standing still.
        if (idleAmt > 0.5) {
          const flickCycle = time % 4.0;
          if (flickCycle < 0.5) {
            const flick = Math.sin((flickCycle / 0.5) * Math.PI) * 0.5 * idleAmt;
            tailStrands.forEach(({ rootPivot, kneePivot }, i) => {
              rootPivot.rotation.z += flick * (0.2 + i * 0.03);
              kneePivot.rotation.z += flick * (0.3 + i * 0.04);
            });
          }
        }

        earPivotL.rotation.x = -0.2 * speed01 + Math.sin(time * 0.9) * 0.1 * idleAmt;
        earPivotR.rotation.x = -0.2 * speed01 + Math.sin(time * 0.9 + 0.4) * 0.1 * idleAmt;
        earPivotL.rotation.z = Math.sin(time * 0.7) * 0.08 * idleAmt;
        earPivotR.rotation.z = -Math.sin(time * 0.7) * 0.08 * idleAmt;

        // Brief "fray-stitching" shimmer while moving -- a fast pulsing
        // emissive tick on the blaze/sock trim, evoking loose thread
        // catching the light as it gallops.
        mat.blaze.emissiveIntensity = 0.06 + Math.max(0, Math.sin(stride * 3.0)) * 0.35 * speed01;
      }

      // ---- Telegraph / attack anticipation overlay (harmless no-op for a
      // passive mount unless something upstream ever drives it) ----
      if (telegraph > 0 || attack > 0) {
        const wind = windUp(telegraph);
        const strikeAmt = strike(attack);
        headPivot.rotation.x = 0.10 + wind * 0.12 + strikeAmt * 0.22;
        earPivotL.rotation.x -= 0.3 * telegraph;
        earPivotR.rotation.x -= 0.3 * telegraph;
      } else {
        headPivot.rotation.x = 0.10;
      }

      // Spool-mark flanks give a faint independent thread-tremor at all
      // times, echoing the birth-thread never fully unwound.
      const spoolTremor = Math.sin(time * 2.4) * 0.01;
      spoolMarkL.rotation.y = spoolTremor;
      spoolMarkR.rotation.y = -spoolTremor;
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
    }
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
