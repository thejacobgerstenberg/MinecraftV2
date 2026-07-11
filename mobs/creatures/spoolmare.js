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
// Silhouette goals: a slender, ELEGANT EQUINE — long neck, refined head,
// four long legs, ~1.5 units tall. NOT a Minecraft horse: no boxy head, a
// tapered muzzle and fine neck instead. Mane + tail are several thin
// dangling thread-strand boxes that stream in the wind. A small banded box
// on each flank suggests a wound spool. Passive, rideable — exposes a
// rideAnchor object at the saddle point on its back.
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
  // BARREL / TORSO — a slender, elongated body sitting atop the legs.
  // -------------------------------------------------------------------
  const torsoPivot = new THREE.Group();
  torsoPivot.position.set(0, HIP_Y, 0);
  root.add(torsoPivot);

  const barrel = box(0.34, 0.32, 0.62, mat.coat);
  barrel.position.set(0, 0.16, -0.02);
  torsoPivot.add(barrel);

  // Shading strip along the belly.
  const belly = box(0.29, 0.08, 0.58, mat.shadow);
  belly.position.set(0, 0.0, -0.02);
  torsoPivot.add(belly);

  // Withers ridge, slight rise toward the neck.
  const withers = box(0.24, 0.10, 0.18, mat.coat);
  withers.position.set(0, 0.34, 0.22);
  torsoPivot.add(withers);

  // Croup / rump, slight rise toward the tail base.
  const croup = box(0.26, 0.10, 0.16, mat.coat);
  croup.position.set(0, 0.30, -0.30);
  torsoPivot.add(croup);

  parts.torsoPivot = torsoPivot;

  // -------------------------------------------------------------------
  // WOVEN-SPOOL FLANK MOTIF — a small banded box on each flank
  // suggesting a wound bobbin of thread, marking its birth-thread.
  // -------------------------------------------------------------------
  function buildSpoolMark(xSide) {
    const group = new THREE.Group();
    group.position.set(xSide * 0.175, 0.16, -0.06);
    torsoPivot.add(group);

    const core = box(0.03, 0.14, 0.14, mat.mane);
    group.add(core);

    const bandTop = box(0.035, 0.02, 0.15, mat.blaze);
    bandTop.position.set(0, 0.05, 0);
    group.add(bandTop);

    const bandMid = box(0.035, 0.02, 0.15, mat.blaze);
    bandMid.position.set(0, 0, 0);
    group.add(bandMid);

    const bandBottom = box(0.035, 0.02, 0.15, mat.blaze);
    bandBottom.position.set(0, -0.05, 0);
    group.add(bandBottom);

    return group;
  }
  const spoolMarkL = buildSpoolMark(-1);
  const spoolMarkR = buildSpoolMark(1);
  parts.spoolMarkL = spoolMarkL;
  parts.spoolMarkR = spoolMarkR;

  // -------------------------------------------------------------------
  // NECK + HEAD — long, refined neck rising and curving forward into a
  // tapered, elegant equine head (NOT a boxy Mojang-horse head).
  // -------------------------------------------------------------------
  const neckPivot = new THREE.Group();
  neckPivot.position.set(0, 0.38, 0.26);
  neckPivot.rotation.x = -0.55; // neck angles up and forward
  torsoPivot.add(neckPivot);

  const neckLower = box(0.15, 0.18, 0.16, mat.coat);
  neckLower.position.set(0, 0.09, 0);
  neckPivot.add(neckLower);

  const neckUpperPivot = new THREE.Group();
  neckUpperPivot.position.set(0, 0.18, 0);
  neckUpperPivot.rotation.x = 0.35; // neck curves back the other way near the poll
  neckPivot.add(neckUpperPivot);

  const neckUpper = box(0.12, 0.13, 0.13, mat.coat);
  neckUpper.position.set(0, 0.065, 0);
  neckUpperPivot.add(neckUpper);

  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.13, 0.02);
  headPivot.rotation.x = 0.05;
  neckUpperPivot.add(headPivot);

  const skull = box(0.11, 0.14, 0.15, mat.coat);
  skull.position.set(0, 0.06, 0.02);
  headPivot.add(skull);

  // Tapered muzzle, narrowing toward the nose — the "elegant, not boxy" cue.
  const muzzleUpper = box(0.085, 0.09, 0.14, mat.coat);
  muzzleUpper.position.set(0, 0.02, 0.19);
  headPivot.add(muzzleUpper);

  const muzzleTip = box(0.06, 0.06, 0.07, mat.shadow);
  muzzleTip.position.set(0, -0.01, 0.28);
  headPivot.add(muzzleTip);

  // Near-white blaze stripe down the forehead/nose.
  const blazeStripe = box(0.025, 0.16, 0.03, mat.blaze);
  blazeStripe.position.set(0, 0.06, 0.19);
  headPivot.add(blazeStripe);

  // Lower jaw, a slim wedge under the muzzle.
  const jaw = box(0.075, 0.045, 0.13, mat.shadow);
  jaw.position.set(0, -0.03, 0.14);
  headPivot.add(jaw);

  // Eyes.
  const eyeL = box(0.02, 0.02, 0.02, mat.dark);
  eyeL.position.set(-0.055, 0.08, 0.10);
  headPivot.add(eyeL);
  const eyeR = box(0.02, 0.02, 0.02, mat.dark);
  eyeR.position.set(0.055, 0.08, 0.10);
  headPivot.add(eyeR);

  // Two fine, alert ears.
  const earPivotL = new THREE.Group();
  earPivotL.position.set(-0.045, 0.13, -0.03);
  headPivot.add(earPivotL);
  const earL = box(0.025, 0.09, 0.02, mat.mane);
  earL.position.set(0, 0.045, 0);
  earPivotL.add(earL);

  const earPivotR = new THREE.Group();
  earPivotR.position.set(0.045, 0.13, -0.03);
  headPivot.add(earPivotR);
  const earR = box(0.025, 0.09, 0.02, mat.mane);
  earR.position.set(0, 0.045, 0);
  earPivotR.add(earR);

  parts.neckPivot = neckPivot;
  parts.neckUpperPivot = neckUpperPivot;
  parts.headPivot = headPivot;
  parts.earPivotL = earPivotL;
  parts.earPivotR = earPivotR;

  // Head anchor for name tags, above the head.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.copy(new THREE.Vector3(0, 0.22, 0.02));
  headPivot.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // MANE — a chain of thin, loose violet thread-strands running along
  // the crest of the neck, each independently pivoted so they can stream
  // and sway.
  // -------------------------------------------------------------------
  // y offsets are re-tuned to the shorter neck bones above (neckPivot's
  // local chain now spans 0 -> 0.18, neckUpperPivot's 0 -> 0.13) so each
  // strand still roots along the crest instead of floating above the head;
  // strand length h is kept fuller than a strict neck-length rescale would
  // give, so the mane still reads as loose streaming thread.
  const maneDefs = [
    { parent: neckUpperPivot, x: 0, y: 0.135, z: -0.02, h: 0.11 },
    { parent: neckUpperPivot, x: 0, y: 0.095, z: -0.04, h: 0.10 },
    { parent: neckUpperPivot, x: 0, y: 0.04, z: -0.05, h: 0.09 },
    { parent: neckPivot, x: 0, y: 0.15, z: -0.06, h: 0.10 },
    { parent: neckPivot, x: 0, y: 0.09, z: -0.06, h: 0.10 },
    { parent: neckPivot, x: 0, y: 0.03, z: -0.06, h: 0.08 },
  ];
  const mane = maneDefs.map(({ parent, x, y, z, h }) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    parent.add(pivot);
    const strand = hangingBox(0.02, h, 0.02, mat.mane);
    pivot.add(strand);
    return pivot;
  });
  parts.mane = mane;

  // -------------------------------------------------------------------
  // TAIL — a chain of loose violet thread-strands off the rear, longer
  // and fuller than the mane, streaming behind and below the croup.
  // -------------------------------------------------------------------
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.30, -0.38);
  tailPivot.rotation.x = 0.35;
  torsoPivot.add(tailPivot);

  const tailBase = hangingBox(0.05, 0.22, 0.05, mat.mane);
  tailPivot.add(tailBase);

  const tailMid = new THREE.Group();
  tailMid.position.set(0, -0.21, -0.02);
  tailPivot.add(tailMid);
  const tailMidSeg = hangingBox(0.04, 0.20, 0.04, mat.mane);
  tailMid.add(tailMidSeg);

  const tailTip = new THREE.Group();
  tailTip.position.set(0, -0.19, -0.02);
  tailMid.add(tailTip);
  const tailTipSeg = hangingBox(0.03, 0.16, 0.03, mat.mane);
  tailTip.add(tailTipSeg);

  // A couple of extra loose stray strands for a fuller streaming read.
  const tailStrayL = new THREE.Group();
  tailStrayL.position.set(-0.03, -0.02, -0.01);
  tailPivot.add(tailStrayL);
  tailStrayL.add(hangingBox(0.015, 0.30, 0.015, mat.mane));

  const tailStrayR = new THREE.Group();
  tailStrayR.position.set(0.03, -0.02, -0.01);
  tailPivot.add(tailStrayR);
  tailStrayR.add(hangingBox(0.015, 0.28, 0.015, mat.mane));

  parts.tailPivot = tailPivot;
  parts.tailMid = tailMid;
  parts.tailTip = tailTip;
  parts.tailStrayL = tailStrayL;
  parts.tailStrayR = tailStrayR;

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

  // Front legs pivot from a group under the withers.
  const frontLegsGroup = new THREE.Group();
  frontLegsGroup.position.set(0, HIP_Y, 0.20);
  root.add(frontLegsGroup);
  const legFR = buildLeg(-0.11, 0, frontLegsGroup);
  const legFL = buildLeg(0.11, 0, frontLegsGroup);

  // Rear legs pivot from a group under the croup.
  const rearLegsGroup = new THREE.Group();
  rearLegsGroup.position.set(0, HIP_Y, -0.30);
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
      neckPivot.rotation.x = -0.55 - rearAngle * 0.3;

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
      neckPivot.rotation.x = -0.55 + Math.sin(stride) * 0.05;

      // Mane and tail stream out with the gallop.
      mane.forEach((strand, i) => {
        strand.rotation.x = -0.3 + Math.sin(stride * 0.9 + i * 0.5) * 0.25;
        strand.rotation.z = Math.sin(stride * 0.7 + i * 0.8) * 0.15;
      });
      tailPivot.rotation.x = 0.15 + Math.sin(stride * 0.6) * 0.1;
      tailMid.rotation.z = Math.sin(stride * 0.8 + 0.6) * 0.3;
      tailTip.rotation.z = Math.sin(stride * 0.8 + 1.2) * 0.4;
      tailStrayL.rotation.z = Math.sin(stride * 0.9 + 0.3) * 0.3;
      tailStrayR.rotation.z = Math.sin(stride * 0.9 - 0.3) * 0.3;

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
      tailPivot.rotation.x = 0.35 + Math.sin(idle * 0.5) * 0.04;
      tailMid.rotation.z = Math.sin(idle * 0.5 + 0.5) * 0.1 + flick * 0.3;
      tailTip.rotation.z = Math.sin(idle * 0.5 + 1.0) * 0.15 + flick * 0.5;
      tailStrayL.rotation.z = Math.sin(idle * 0.5 + 0.3) * 0.12;
      tailStrayR.rotation.z = Math.sin(idle * 0.5 - 0.3) * 0.12;

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
