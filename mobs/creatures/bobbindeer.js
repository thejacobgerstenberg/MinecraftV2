import * as THREE from 'three';

// ============================================================================
// BOBBIN-DEER — a passive Warpwold "grazer" creature.
// Loomfall lore: a skittish antlered thread-deer of the Sennmeadows, woven
// thin and tall so it can outrun trouble. Its antlers are not bone but wound
// spindles of dark thread — small stepped boxes stacked and forked like
// bobbins left spinning on the Loom. Four tall thin legs hold a slender fawn
// body high off the ground; a raised alert neck and big ears keep it ever
// watchful; a short bobtail flicks at the rear. It bolts at the first sign
// of danger, crouching low before springing away in a startled leap.
// ============================================================================

export function build() {
  const root = new THREE.Group();
  root.name = 'Bobbin-deer';

  // ---- Palette ---------------------------------------------------------
  const palette = {
    hide: 0xc7a67a,    // fawn thread-hide, main coat
    cream: 0xe9dcc4,   // cream underbelly/rump
    antler: 0x6b4e2e,  // dark spindle antlers
    eye: 0x1a1a1a,     // black eyes
  };

  // ---- Materials (shared per color) -------------------------------------
  const hideMat = new THREE.MeshStandardMaterial({
    color: palette.hide,
    roughness: 0.85,
    metalness: 0.0,
  });
  const creamMat = new THREE.MeshStandardMaterial({
    color: palette.cream,
    roughness: 0.85,
    metalness: 0.0,
  });
  const antlerMat = new THREE.MeshStandardMaterial({
    color: palette.antler,
    roughness: 0.6,
    metalness: 0.05,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: palette.eye,
    roughness: 0.3,
    metalness: 0.1,
    emissive: palette.eye,
    emissiveIntensity: 0.05,
  });

  // ---- Body: slender torso, held high on tall legs -----------------------
  const bodyGroup = new THREE.Group();
  bodyGroup.position.set(0, 0.72, 0); // torso center, high off the ground
  root.add(bodyGroup);

  const torsoGeo = new THREE.BoxGeometry(0.28, 0.26, 0.56);
  const torso = new THREE.Mesh(torsoGeo, hideMat);
  bodyGroup.add(torso);

  // Cream underbelly slab. Sized close to the torso's own width/length and
  // sunk well up into the torso volume (only ~0.02 pokes below the torso's
  // bottom face) so it reads as a contrasting belly *band* along the torso,
  // not a disconnected floating bar underneath it.
  const bellyGeo = new THREE.BoxGeometry(0.26, 0.1, 0.48);
  const belly = new THREE.Mesh(bellyGeo, creamMat);
  belly.position.set(0, -0.1, 0);
  bodyGroup.add(belly);

  // Cream rump patch at the rear. Matches the torso's cross-section closely
  // (width/height) and is pushed back so roughly a fifth of it protrudes
  // past the torso's rear face, guaranteeing a clearly visible cream cap
  // instead of being swallowed inside the tan torso box.
  const rumpGeo = new THREE.BoxGeometry(0.27, 0.24, 0.16);
  const rump = new THREE.Mesh(rumpGeo, creamMat);
  rump.position.set(0, 0.0, -0.24);
  bodyGroup.add(rump);

  // ---- Neck + head: raised, alert -----------------------------------------
  // Kept short enough that the head lands right around the ~1.1 unit design
  // height (torso top 0.85 + neck/head rise ~0.29 = head-top ~1.135); the
  // antler rack is what's allowed to rise further above that reference, the
  // way real antlers extend past an animal's nominal body height.
  const neckPivot = new THREE.Group();
  neckPivot.position.set(0, 0.12, 0.24); // pivot at base of neck, front of torso
  bodyGroup.add(neckPivot);

  const neckGeo = new THREE.BoxGeometry(0.14, 0.24, 0.16);
  const neck = new THREE.Mesh(neckGeo, hideMat);
  neck.position.set(0, 0.12, 0.05);
  neck.rotation.x = -0.35; // angled up and forward
  neckPivot.add(neck);

  const headGroup = new THREE.Group();
  headGroup.position.set(0, 0.22, 0.14);
  neckPivot.add(headGroup);

  const headGeo = new THREE.BoxGeometry(0.16, 0.15, 0.22);
  const head = new THREE.Mesh(headGeo, hideMat);
  headGroup.add(head);

  // Muzzle, slightly narrower and cream-toned at the very tip.
  const muzzleGeo = new THREE.BoxGeometry(0.1, 0.08, 0.08);
  const muzzle = new THREE.Mesh(muzzleGeo, creamMat);
  muzzle.position.set(0, -0.03, 0.14);
  headGroup.add(muzzle);

  // Eyes, black, on either side of the head.
  const eyeGeo = new THREE.BoxGeometry(0.02, 0.05, 0.05);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(0.08, 0.03, 0.06);
  headGroup.add(eyeL);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeR.position.set(-0.08, 0.03, 0.06);
  headGroup.add(eyeR);

  // Large alert ears, pivoted so they can flick independently.
  const earGeo = new THREE.BoxGeometry(0.03, 0.13, 0.09);
  const earPivotL = new THREE.Group();
  earPivotL.position.set(0.08, 0.08, -0.02);
  headGroup.add(earPivotL);
  const earL = new THREE.Mesh(earGeo, hideMat);
  earL.position.set(0.04, 0.05, 0);
  earL.rotation.z = 0.3;
  earPivotL.add(earL);

  const earPivotR = new THREE.Group();
  earPivotR.position.set(-0.08, 0.08, -0.02);
  headGroup.add(earPivotR);
  const earR = new THREE.Mesh(earGeo, hideMat);
  earR.position.set(-0.04, 0.05, 0);
  earR.rotation.z = -0.3;
  earPivotR.add(earR);

  // ---- Antlers: stepped spindle/bobbin boxes forming forked tines --------
  // Each antler is a chained stack of shrinking boxes (the "wound bobbin"
  // shaft) with two smaller tine boxes forking off partway up, built from
  // the same dark antler material throughout.
  // Base is planted back on the crown (z = -0.13, well behind the ear
  // pivots at z = -0.02, leaving a clear gap) and pulled in narrower
  // (x = ±0.04 vs the ears' ±0.08) so the antler rack reads as its own
  // separate feature instead of sitting on top of / behind the ears and
  // blending into a single stub.
  function buildAntler(side) {
    const basePivot = new THREE.Group();
    basePivot.position.set(side * 0.04, 0.1, -0.13);
    headGroup.add(basePivot);

    // Stepped spindle shaft — three stacked boxes, each slightly narrower,
    // reading as a wound bobbin standing on end.
    const shaftDefs = [
      { size: [0.05, 0.06, 0.05], y: 0.03 },
      { size: [0.04, 0.05, 0.04], y: 0.08 },
      { size: [0.03, 0.045, 0.03], y: 0.125 },
    ];
    const shaftMeshes = shaftDefs.map(({ size, y }) => {
      const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
      const m = new THREE.Mesh(geo, antlerMat);
      m.position.set(0, y, 0);
      basePivot.add(m);
      return m;
    });

    // Forked tines — two small boxes branching outward/upward from the
    // midpoint of the shaft, plus one topping the tip, like spindle arms.
    const tineGeo = new THREE.BoxGeometry(0.05, 0.032, 0.032);
    const tineA = new THREE.Mesh(tineGeo, antlerMat);
    tineA.position.set(side * 0.035, 0.09, -0.01);
    tineA.rotation.z = side * 0.4;
    basePivot.add(tineA);

    const tineB = new THREE.Mesh(tineGeo, antlerMat);
    tineB.position.set(side * 0.03, 0.135, -0.03);
    tineB.rotation.z = side * 0.5;
    basePivot.add(tineB);

    const tipGeo = new THREE.BoxGeometry(0.025, 0.035, 0.025);
    const tip = new THREE.Mesh(tipGeo, antlerMat);
    tip.position.set(0, 0.165, 0);
    basePivot.add(tip);

    return { basePivot, shaftMeshes, tineA, tineB, tip };
  }
  const antlerL = buildAntler(1);
  const antlerR = buildAntler(-1);

  // Head anchor for name tags — just above the antlers.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 0.33, 0.14);
  headGroup.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // ---- Legs: four tall thin legs, hip/shoulder-pivoted for a prance ------
  // Pivot at hip/shoulder height (0.6). Leg + hoof stack spans pivot down
  // to y=0: legMesh occupies [0.06, 0.6], hoof occupies [0, 0.06].
  const legGeo = new THREE.BoxGeometry(0.07, 0.54, 0.07);
  const hoofGeo = new THREE.BoxGeometry(0.08, 0.06, 0.08);
  const legPositions = [
    [0.1, 0.6, 0.22],   // front-right
    [-0.1, 0.6, 0.22],  // front-left
    [0.1, 0.6, -0.22],  // back-right
    [-0.1, 0.6, -0.22], // back-left
  ];
  const legs = legPositions.map(([x, y, z]) => {
    const legPivot = new THREE.Group();
    legPivot.position.set(x, y, z); // pivot at hip/shoulder height
    root.add(legPivot);

    const legMesh = new THREE.Mesh(legGeo, hideMat);
    legMesh.position.set(0, -0.27, 0); // hangs below the pivot
    legPivot.add(legMesh);

    const hoof = new THREE.Mesh(hoofGeo, antlerMat);
    hoof.position.set(0, -0.57, 0); // feet reach y=0
    legPivot.add(hoof);

    return legPivot;
  });

  // ---- Tail: short bobtail, cream-tipped -----------------------------------
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.78, -0.29);
  root.add(tailPivot);

  const tailGeo = new THREE.BoxGeometry(0.07, 0.09, 0.07);
  const tail = new THREE.Mesh(tailGeo, creamMat);
  tail.position.set(0, -0.03, -0.02);
  tailPivot.add(tail);

  // ---- Store references for animation --------------------------------------
  root.userData.parts = {
    bodyGroup,
    neckPivot,
    headGroup,
    earPivotL,
    earPivotR,
    antlerL,
    antlerR,
    legs, // [FR, FL, BR, BL]
    tailPivot,
  };

  // ---- Animation -----------------------------------------------------------
  // t = seconds elapsed, state = { moving, grounded, fuse, hurt, dimension }
  root.userData.animate = (t, state) => {
    const parts = root.userData.parts;
    const hurt = Math.min(state.hurt || 0, 1);

    // Idle breathing: gentle scale pulse on the torso, always running.
    const breathe = Math.sin(t * 2.2) * 0.025;
    parts.bodyGroup.scale.set(1 + breathe * 0.4, 1 + breathe, 1 + breathe * 0.4);

    // Alert head-up idle: neck sways slightly, head tracks a slow scan.
    const alertSway = Math.sin(t * 0.7) * 0.06;
    parts.neckPivot.rotation.y = alertSway * (1 - hurt);
    parts.headGroup.rotation.x = Math.sin(t * 1.3) * 0.04;

    // Ear flick: a quick discrete twitch every few seconds, alternating.
    const flickCycle = t % 3.2;
    let flick = 0;
    if (flickCycle < 0.25) {
      flick = Math.sin((flickCycle / 0.25) * Math.PI) * 0.5;
    }
    parts.earPivotL.rotation.z = flick * 0.6;
    const flickCycle2 = (t + 1.6) % 3.2;
    let flick2 = 0;
    if (flickCycle2 < 0.25) {
      flick2 = Math.sin((flickCycle2 / 0.25) * Math.PI) * 0.5;
    }
    parts.earPivotR.rotation.z = -flick2 * 0.6;

    // Antler micro-glint sway, ties the whole rack together subtly.
    const antlerSway = Math.sin(t * 1.6) * 0.03;
    parts.antlerL.basePivot.rotation.z = antlerSway;
    parts.antlerR.basePivot.rotation.z = -antlerSway;

    // Bobtail flick, faster and more nervous than the ears.
    parts.tailPivot.rotation.x = Math.sin(t * 6.0) * 0.25 + 0.1;

    let bodyY = 0;
    let bodyLift = 0;

    if (hurt > 0) {
      // Startle/bolt: quick crouch (legs bend, body drops) then an explosive
      // upward-forward spring, driven by the hurt pulse itself (0..1 rising
      // then falling as the effect decays upstream).
      const crouch = Math.sin(hurt * Math.PI * 0.5); // 0 -> 1 over first half
      const spring = Math.pow(hurt, 2) * Math.sin(hurt * Math.PI); // pop
      bodyY = -crouch * 0.12 + spring * 0.3;
      bodyLift = spring;
      parts.neckPivot.rotation.x = -crouch * 0.5 + spring * 0.6;
      parts.bodyGroup.scale.y *= 1 - crouch * 0.2 + spring * 0.1;
      parts.legs.forEach((legPivot, i) => {
        const dir = i < 2 ? 1 : -1;
        legPivot.rotation.x = -crouch * 0.4 + spring * dir * 0.9;
      });
    } else {
      // Prancing high-step trot: opposite-corner legs swing together with
      // a pronounced lift, faster and higher than a plain walk cycle so it
      // reads as a skittish prance rather than a plod.
      const trotSpeed = 11.0;
      const trotAmount = state.moving ? 0.75 : 0.0;
      const lerp = state.moving ? 1 : 0.15;

      const targets = [
        Math.sin(t * trotSpeed) * trotAmount,        // FR
        -Math.sin(t * trotSpeed) * trotAmount,       // FL
        -Math.sin(t * trotSpeed) * trotAmount,       // BR
        Math.sin(t * trotSpeed) * trotAmount,        // BL
      ];
      parts.legs.forEach((legPivot, i) => {
        legPivot.rotation.x += (targets[i] - legPivot.rotation.x) * lerp;
      });

      if (state.moving) {
        bodyLift = Math.abs(Math.sin(t * trotSpeed)) * 0.05;
        parts.neckPivot.rotation.x = Math.sin(t * trotSpeed * 2) * 0.05;
      }
    }

    root.position.y = bodyY + bodyLift + Math.sin(t * 2.2) * 0.008;
  };

  // Feet-at-y0 sanity: leg pivot at y=0.6; legMesh (height 0.54) centered at
  // -0.27 spans [0.06, 0.6]; hoof (height 0.06) centered at -0.57 spans
  // [0.0, 0.06] -> hoof bottom = 0.0. Feet at ground level.
  //
  // Height sanity: torso top = bodyGroup.y(0.72) + halfHeight(0.13) = 0.85.
  // Head top = torso.y(0.72) + neckPivot.y(0.12) + headGroup.y(0.22)
  // + headHalfHeight(0.075) = 1.135 -> matches the ~1.1 unit design target
  // for the body/head silhouette. The antler rack is allowed to rise above
  // that reference (base at head-local y=0.1, tip topping out at local
  // y=0.1825) the way real antlers extend past an animal's nominal body
  // height, putting the antler tip around world y=1.34.

  return root;
}

export const meta = {
  archetype: 'grazer',
  species: 'Bobbin-deer',
  dimensionDefault: 'warpwold',
  palette: {
    hide: '#C7A67A',
    cream: '#E9DCC4',
    antler: '#6B4E2E',
    eye: '#1A1A1A',
  },
  description:
    'A skittish antlered thread-deer of the Sennmeadows, woven tall and thin ' +
    'to outrun danger. Its branching antlers are wound spindles of dark ' +
    'thread rather than bone, and its fawn thread-hide coat pales to cream ' +
    'along the belly and rump. Ever alert, ears flicking and neck raised, ' +
    'it prances on tall thin legs and bolts in a startled spring at the ' +
    'first sign of a threat.',
};
