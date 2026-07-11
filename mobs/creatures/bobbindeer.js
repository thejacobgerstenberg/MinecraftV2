import * as THREE from 'three';
import * as rig from '../anim/rig.js';

// ============================================================================
// BOBBIN-DEER — a passive Warpwold "grazer" creature.
// Loomfall lore: a skittish antlered thread-deer of the Sennmeadows, woven
// thin and tall so it can outrun trouble. Its antlers are not bone but wound
// spindles of dark thread — small stepped boxes stacked and forked like
// bobbins left spinning on the Loom, each rack cinched with a pale
// thread-wrap band where the spindle was bound off. Four tall thin legs hold
// a slender, leaned-forward body high off the ground, each leg cinched with
// a matching pale thread "sock" band above the hoof. A raised alert neck,
// big flicking ears and a pale forehead tuft keep it ever watchful; a short
// bobtail with a single loose thread wisp flicks nervously at the rear. It
// bolts at the first sign of danger, crouching low before springing away in
// a startled leap. ORIGINAL silhouette — a lean, big-eared, thread-wrapped
// prey animal, not a boxy Minecraft mob.
// ============================================================================

export function build() {
  const root = new THREE.Group();
  root.name = 'Bobbin-deer';

  // ---- Palette (canonical Bobbin-deer bestiary palette — all five used) ----
  const palette = {
    hide: 0xa5764a,      // fawn thread-hide, main coat
    hideLight: 0xd9b98c, // pale thread-wrap accents (antler bands, leg socks, tuft)
    cream: 0xe0c9a8,     // cream underbelly/rump/chest/tail-tip
    antler: 0x7c5432,    // dark spindle antlers / hooves
    eye: 0x52371e,       // dark eyes
  };

  // ---- Materials (shared per color so the box count stays lean) ------------
  const hideMat = new THREE.MeshStandardMaterial({
    color: palette.hide,
    roughness: 0.85,
    metalness: 0.0,
  });
  const hideLightMat = new THREE.MeshStandardMaterial({
    color: palette.hideLight,
    roughness: 0.75,
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

  // ---- Body: slender torso, held high on tall legs --------------------------
  const bodyGroup = new THREE.Group();
  bodyGroup.position.set(0, 0.72, 0); // torso center, high off the ground
  root.add(bodyGroup);

  const torsoGeo = new THREE.BoxGeometry(0.26, 0.24, 0.54);
  const torso = new THREE.Mesh(torsoGeo, hideMat);
  bodyGroup.add(torso);

  // Shoulder + haunch ridges — two small raised boxes riding the top of the
  // torso, front and rear. This is the single cheapest silhouette upgrade
  // available: a flat torso box reads as a plank, but a slightly raised
  // shoulder hump and a bigger raised haunch hump instantly read as "lean
  // animal with a powerful spring in its hindquarters" even at thumbnail
  // size, without adding a single extra pivot to animate.
  const shoulderGeo = new THREE.BoxGeometry(0.2, 0.07, 0.14);
  const shoulderRidge = new THREE.Mesh(shoulderGeo, hideMat);
  shoulderRidge.position.set(0, 0.145, 0.13);
  bodyGroup.add(shoulderRidge);

  const haunchGeo = new THREE.BoxGeometry(0.22, 0.08, 0.17);
  const haunchRidge = new THREE.Mesh(haunchGeo, hideMat);
  haunchRidge.position.set(0, 0.15, -0.15);
  bodyGroup.add(haunchRidge);

  // Cream underbelly band, sunk up into the torso volume so it reads as a
  // contrasting belly stripe along the torso, not a disconnected floating bar.
  const bellyGeo = new THREE.BoxGeometry(0.24, 0.09, 0.46);
  const belly = new THREE.Mesh(bellyGeo, creamMat);
  belly.position.set(0, -0.095, 0);
  bodyGroup.add(belly);

  // Cream rump patch at the rear, pushed back so a clear cap of it protrudes
  // past the torso's rear face.
  const rumpGeo = new THREE.BoxGeometry(0.25, 0.22, 0.15);
  const rump = new THREE.Mesh(rumpGeo, creamMat);
  rump.position.set(0, 0.0, -0.235);
  bodyGroup.add(rump);

  // Cream chest blaze — a small proud patch on the front of the torso. Reads
  // clearly from the +Z (facing) direction and balances the rump patch so
  // the cream accent frames the whole silhouette front-to-back.
  const chestGeo = new THREE.BoxGeometry(0.14, 0.09, 0.04);
  const chestBlaze = new THREE.Mesh(chestGeo, creamMat);
  chestBlaze.position.set(0, 0.02, 0.285);
  bodyGroup.add(chestBlaze);

  // ---- Neck + head: raised, alert -------------------------------------------
  const neckPivot = new THREE.Group();
  neckPivot.position.set(0, 0.13, 0.23); // pivot at base of neck, front of torso
  bodyGroup.add(neckPivot);

  const neckGeo = new THREE.BoxGeometry(0.13, 0.22, 0.15);
  const neck = new THREE.Mesh(neckGeo, hideMat);
  neck.position.set(0, 0.11, 0.05);
  neck.rotation.x = -0.35; // angled up and forward
  neckPivot.add(neck);

  const headGroup = new THREE.Group();
  headGroup.position.set(0, 0.2, 0.13);
  neckPivot.add(headGroup);

  const headGeo = new THREE.BoxGeometry(0.15, 0.14, 0.21);
  const head = new THREE.Mesh(headGeo, hideMat);
  headGroup.add(head);

  // Muzzle, slightly narrower and cream-toned at the very tip.
  const muzzleGeo = new THREE.BoxGeometry(0.09, 0.07, 0.07);
  const muzzle = new THREE.Mesh(muzzleGeo, creamMat);
  muzzle.position.set(0, -0.03, 0.13);
  headGroup.add(muzzle);

  // Eyes, black, on either side of the head.
  const eyeGeo = new THREE.BoxGeometry(0.02, 0.045, 0.045);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(0.075, 0.025, 0.055);
  headGroup.add(eyeL);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeR.position.set(-0.075, 0.025, 0.055);
  headGroup.add(eyeR);

  // Pale forehead tuft — a small thread-wrap accent between the ears and the
  // antler bases. Cheap secondary detail that pops the light accent color
  // right at the top of the silhouette, where the eye lands first.
  const tuftGeo = new THREE.BoxGeometry(0.06, 0.035, 0.05);
  const foreheadTuft = new THREE.Mesh(tuftGeo, hideLightMat);
  foreheadTuft.position.set(0, 0.09, -0.05);
  headGroup.add(foreheadTuft);

  // Large alert ears, pivoted so they can flick independently.
  const earGeo = new THREE.BoxGeometry(0.03, 0.12, 0.085);
  const earPivotL = new THREE.Group();
  earPivotL.position.set(0.075, 0.075, -0.02);
  headGroup.add(earPivotL);
  const earL = new THREE.Mesh(earGeo, hideMat);
  earL.position.set(0.035, 0.045, 0);
  earL.rotation.z = 0.3;
  earPivotL.add(earL);

  const earPivotR = new THREE.Group();
  earPivotR.position.set(-0.075, 0.075, -0.02);
  headGroup.add(earPivotR);
  const earR = new THREE.Mesh(earGeo, hideMat);
  earR.position.set(-0.035, 0.045, 0);
  earR.rotation.z = -0.3;
  earPivotR.add(earR);

  // ---- Antlers: stepped spindle/bobbin boxes forking into tines, each rack
  // cinched with a pale thread-wrap band -------------------------------------
  // Each antler is a chained stack of shrinking boxes (the "wound bobbin"
  // shaft) with two smaller tine boxes forking off partway up, plus a
  // thin hideLight band wrapped at the first joint — the antler equivalent
  // of the leg socks below, and the clearest "this is thread, not bone"
  // silhouette cue on the whole model.
  function buildAntler(side) {
    const basePivot = new THREE.Group();
    basePivot.position.set(side * 0.045, 0.095, -0.13);
    headGroup.add(basePivot);

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

    // Thread-wrap band, cinched at the joint between the first and second
    // shaft segments — a wound spindle's binding, not antler bone.
    const bandGeo = new THREE.BoxGeometry(0.052, 0.018, 0.052);
    const band = new THREE.Mesh(bandGeo, hideLightMat);
    band.position.set(0, 0.058, 0);
    basePivot.add(band);

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

    return { basePivot, shaftMeshes, band, tineA, tineB, tip };
  }
  const antlerL = buildAntler(1);
  const antlerR = buildAntler(-1);

  // Head anchor for name tags — just above the antlers.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 0.32, 0.13);
  headGroup.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // ---- Legs: four tall thin legs, each cinched with a pale thread "sock"
  // band above the hoof --------------------------------------------------------
  // Pivot at hip/shoulder height (0.6). Leg + sock + hoof stack spans pivot
  // down to y=0: legMesh occupies [0.06, 0.6], sock occupies [0.10, 0.16]
  // (a purely cosmetic overlay riding the lower leg), hoof occupies
  // [0, 0.06].
  const legGeo = new THREE.BoxGeometry(0.065, 0.54, 0.065);
  const sockGeo = new THREE.BoxGeometry(0.085, 0.06, 0.085);
  const hoofGeo = new THREE.BoxGeometry(0.075, 0.06, 0.075);
  const legPositions = [
    [0.095, 0.6, 0.21],   // front-right
    [-0.095, 0.6, 0.21],  // front-left
    [0.095, 0.6, -0.21],  // back-right
    [-0.095, 0.6, -0.21], // back-left
  ];
  const legs = legPositions.map(([x, y, z]) => {
    const legPivot = new THREE.Group();
    legPivot.position.set(x, y, z); // pivot at hip/shoulder height
    root.add(legPivot);

    const legMesh = new THREE.Mesh(legGeo, hideMat);
    legMesh.position.set(0, -0.27, 0); // hangs below the pivot
    legPivot.add(legMesh);

    const sock = new THREE.Mesh(sockGeo, hideLightMat);
    sock.position.set(0, -0.47, 0); // cinched band above the hoof
    legPivot.add(sock);

    const hoof = new THREE.Mesh(hoofGeo, antlerMat);
    hoof.position.set(0, -0.57, 0); // feet reach y=0
    legPivot.add(hoof);

    return legPivot;
  });

  // ---- Tail: short bobtail, cream-tipped, with one loose thread wisp -------
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.76, -0.27);
  root.add(tailPivot);

  const tailGeo = new THREE.BoxGeometry(0.065, 0.085, 0.065);
  const tail = new THREE.Mesh(tailGeo, creamMat);
  tail.position.set(0, -0.03, -0.02);
  tailPivot.add(tail);

  // A single loose thread wisp trailing off the tail tip — small, but it is
  // the detail that most directly says "this animal is made of thread" at a
  // glance, echoing the antler bands and leg socks.
  const wispGeo = new THREE.BoxGeometry(0.018, 0.07, 0.018);
  const tailWisp = new THREE.Mesh(wispGeo, hideLightMat);
  tailWisp.position.set(0, -0.09, -0.035);
  tailWisp.rotation.x = 0.3;
  tailPivot.add(tailWisp);

  // ---- Store references for animation ---------------------------------------
  root.userData.parts = {
    bodyGroup,
    torso,
    shoulderRidge,
    haunchRidge,
    belly,
    rump,
    chestBlaze,
    neckPivot,
    headGroup,
    muzzle,
    foreheadTuft,
    earPivotL,
    earPivotR,
    antlerL,
    antlerR,
    legs, // [FR, FL, BR, BL]
    tailPivot,
    tailWisp,
  };

  // ---------------------------------------------------------------------------
  // ANIMATION
  //
  // Idle:      rig.breathe drives the torso's breathing pulse, rig.sway drives
  //            an alert head-scan and antler/tuft drift, and a short discrete
  //            twitch flicks each ear independently every few seconds.
  // Walk:      rig.walkPhase drives a real diagonal-pair 4-leg trot, boosted
  //            into a high, snappy "prance" (extra amplitude + a per-stride
  //            hop) scaled by state.speed01, leaning into turns via
  //            state.turn.
  // Telegraph/
  // Attack:    a Bobbin-deer has no offense — this reads as a defensive
  //            forehoof stamp/bluff: rig.windUp rears the forequarters and
  //            pulls the head back, rig.strike snaps a stamp down and the
  //            antlers dip forward in warning.
  // Hurt:      bolt/startle — a quick crouch followed by an explosive
  //            spring-leap, ears pinned, neck thrown up.
  // Death:     rig.dissolve(state.dying) unravels the deer: legs splay,
  //            antlers fan outward at their bands, ears droop, the tail
  //            wisp unspools further, and the body sinks and shrinks away —
  //            a thread-unravel, not gore.
  // ---------------------------------------------------------------------------
  function n(v, fallback = 0) {
    const x = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(x) ? x : fallback;
  }
  function clamp01(v) {
    const x = n(v, 0);
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  let lean = 0;
  let prevT = null;

  root.userData.animate = (t, state) => {
    try {
      const s = state || {};
      const time = n(t, 0);
      let dt = 0;
      if (prevT !== null) dt = Math.max(0, Math.min(0.12, time - prevT));
      prevT = time;

      const moving = !!s.moving;
      const hurt = clamp01(s.hurt);
      const dying = clamp01(s.dying);
      const telegraph = clamp01(s.telegraph);
      const attack = clamp01(s.attack);
      const turn = n(s.turn, 0);
      const speed01 = clamp01(s.speed01 != null ? s.speed01 : (moving ? 1 : 0));

      // Lean into turns, damped so it never snaps.
      const leanTarget = dying > 0 ? 0 : Math.max(-0.35, Math.min(0.35, -turn * 0.6));
      lean = rig.damp(lean, leanTarget, 9, dt || 0.016);

      // ---- DEATH: thread-unravel dissolve ---------------------------------
      if (dying > 0) {
        const d = rig.dissolve(dying);
        const sc = Math.max(0.04, d.scale);
        root.scale.set(sc, sc, sc);
        root.position.y = -d.drop * 0.55;
        root.rotation.z = lean * 0.2;

        legs.forEach((legPivot, i) => {
          const sideX = i % 2 === 0 ? 1 : -1; // FR/BR = +x, FL/BL = -x
          const sideZ = i < 2 ? 1 : -1; // front/back
          legPivot.rotation.x = sideZ * d.spread * 1.0;
          legPivot.rotation.z = sideX * d.spread * 0.7;
        });

        // Antlers fan outward from their thread-wrap bands, as if the wound
        // spindle itself is coming unbound.
        antlerL.basePivot.rotation.z = d.spread * 0.6;
        antlerL.basePivot.rotation.x = -d.spread * 0.3;
        antlerR.basePivot.rotation.z = -d.spread * 0.6;
        antlerR.basePivot.rotation.x = -d.spread * 0.3;

        earPivotL.rotation.z = 0.3 + d.spread * 0.6;
        earPivotR.rotation.z = -0.3 - d.spread * 0.6;
        earPivotL.rotation.x = d.spread * 0.4;
        earPivotR.rotation.x = d.spread * 0.4;

        neckPivot.rotation.x = d.spread * 0.5; // neck droops forward
        headGroup.rotation.x = d.spread * 0.3;

        tailPivot.rotation.x = -d.spread * 0.6;
        tailWisp.rotation.x = 0.3 + d.spread * 1.2; // unspools further

        bodyGroup.scale.set(1, 1, 1); // keep the spread readable, not squashed
        return; // death pose overrides everything else below
      }

      // Reset root transforms in case a previous frame was mid-dissolve and
      // the mob got revived/recycled (defensive; animate() must never
      // assume ordering with the mob manager's own lifecycle).
      if (root.scale.x !== 1) root.scale.set(1, 1, 1);
      root.rotation.z = 0;

      // ---- Idle: breathing torso + alert head-scan + drift ----------------
      const breatheAmt = rig.breathe(time, 1, 1);
      bodyGroup.scale.set(1 + breatheAmt * 0.4, 1 + breatheAmt, 1 + breatheAmt * 0.4);
      const idleBob = breatheAmt * 0.4;

      const idleAmt = 1 - speed01;
      const alertSway = rig.sway(time, 1.0, 0.85, 0) * idleAmt;
      neckPivot.rotation.y = alertSway + lean * 0.3;
      headGroup.rotation.x = rig.sway(time, 0.7, 1.3, 0.6) * idleAmt;
      foreheadTuft.rotation.z = rig.sway(time, 0.6, 1.6, 0.2);

      // Antler micro-sway, ties the whole rack to the head's alert scan.
      const antlerSway = rig.sway(time, 0.5, 1.3, 1.1);
      antlerL.basePivot.rotation.z = antlerSway;
      antlerR.basePivot.rotation.z = -antlerSway;

      // Ear flick: a quick discrete twitch every few seconds, alternating
      // independently left/right for a lively, watchful feel.
      const flickCycle = time % 3.2;
      let flick = 0;
      if (flickCycle < 0.25) flick = Math.sin((flickCycle / 0.25) * Math.PI) * 0.5;
      earPivotL.rotation.z = flick * 0.6;
      const flickCycle2 = (time + 1.6) % 3.2;
      let flick2 = 0;
      if (flickCycle2 < 0.25) flick2 = Math.sin((flickCycle2 / 0.25) * Math.PI) * 0.5;
      earPivotR.rotation.z = -flick2 * 0.6;

      // Nervous bobtail flick, faster than the ears; streams back a little
      // with speed and turn.
      const stream = speed01 * 0.2 + Math.abs(turn) * 0.15;
      tailPivot.rotation.x = Math.sin(time * 6.0) * 0.25 + 0.1 + stream;
      tailWisp.rotation.x = 0.3 + Math.sin(time * 7.5 + 0.4) * 0.3;
      tailPivot.rotation.z = lean * 0.4;

      let bodyY = idleBob;

      if (hurt > 0) {
        // Bolt/startle: quick crouch (legs bend, body drops) then an
        // explosive upward-forward spring, driven by the hurt pulse itself
        // (0..1 rising then falling as the effect decays upstream).
        const crouch = rig.ease(Math.min(hurt * 2, 1));
        const spring = Math.pow(hurt, 2) * Math.sin(hurt * Math.PI);
        bodyY += -crouch * 0.14 + spring * 0.32;
        neckPivot.rotation.x = -crouch * 0.5 + spring * 0.65;
        bodyGroup.scale.y *= 1 - crouch * 0.2 + spring * 0.1;
        earPivotL.rotation.x = -0.4 * hurt;
        earPivotR.rotation.x = -0.4 * hurt;
        legs.forEach((legPivot, i) => {
          const dir = i < 2 ? 1 : -1;
          legPivot.rotation.x = -crouch * 0.45 + spring * dir * 0.95;
          legPivot.rotation.z = 0;
        });
      } else {
        // Prancing high-step trot: diagonal-pair gait via rig.walkPhase,
        // boosted in amplitude/cadence beyond a plain walk so it reads as a
        // skittish, high-kneed prance rather than a plod.
        const walk = rig.walkPhase(time, speed01, 3.2);
        const prance = 1.5; // extra step height/snap beyond a plain trot
        legs.forEach((legPivot, i) => {
          const key = i === 0 ? walk.FR : i === 1 ? walk.FL : i === 2 ? walk.BR : walk.BL;
          legPivot.rotation.x = key * prance;
          legPivot.rotation.z = lean * 0.18 * (i % 2 === 0 ? 1 : -1);
        });
        bodyY += walk.lift * 0.09;
        neckPivot.rotation.x = Math.sin(time * 3.2 * (0.35 + 0.65 * speed01) * 2) * 0.05 * speed01;
        bodyGroup.rotation.x = -Math.abs(walk.lift) * 0.03 * speed01;
        bodyGroup.rotation.z = lean * 0.5;
        haunchRidge.rotation.x = walk.lift * -0.15 * speed01; // haunch "load" cue
      }

      // ---- Telegraph / attack overlay: defensive forehoof stamp/bluff ----
      // A Bobbin-deer has no true attack; this reads as a startled rear-up
      // and warning stamp rather than aggression.
      if (telegraph > 0 || attack > 0) {
        const wind = rig.windUp(telegraph);
        const strikeAmt = rig.strike(attack);
        neckPivot.rotation.x += -wind * 0.3 + strikeAmt * 0.15;
        antlerL.basePivot.rotation.x = -wind * 0.2 + strikeAmt * 0.35;
        antlerR.basePivot.rotation.x = -wind * 0.2 + strikeAmt * 0.35;
        // Front legs rear back on wind-up, then stamp down on the strike.
        [legs[0], legs[1]].forEach((legPivot) => {
          legPivot.rotation.x += wind * 0.5 - strikeAmt * 0.7;
        });
      }

      root.position.y = bodyY;
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
    }
  };

  // Feet-at-y0 sanity: leg pivot at y=0.6; legMesh (height 0.54) centered at
  // -0.27 spans [0.06, 0.6]; sock (height 0.06) centered at -0.47 spans
  // [0.10, 0.16] (a cosmetic overlay on the lower leg, not part of the
  // vertical stack); hoof (height 0.06) centered at -0.57 spans [0.0, 0.06]
  // -> hoof bottom = 0.0. Feet at ground level.
  //
  // Height sanity: torso top = bodyGroup.y(0.72) + halfHeight(0.12) = 0.84.
  // Head top = torso.y(0.72) + neckPivot.y(0.13) + headGroup.y(0.2)
  // + headHalfHeight(0.07) = 1.12, matching the ~1.1 unit design target for
  // the body/head silhouette. The antler rack rises further above that
  // reference (base at head-local y=0.095, tip topping out at local
  // y=0.1775) the way real antlers extend past an animal's nominal body
  // height, putting the antler tip around world y=1.33.

  return root;
}

export const meta = {
  archetype: 'grazer',
  species: 'Bobbin-deer',
  canonicalId: 'bobbin_deer',
  dimensionDefault: 'warpwold',
  palette: {
    hide: '#A5764A',
    hideLight: '#D9B98C',
    cream: '#E0C9A8',
    antler: '#7C5432',
    eye: '#52371E',
  },
  description:
    'A skittish antlered thread-deer of the Sennmeadows, woven tall and thin ' +
    'to outrun danger. Its branching antlers are wound spindles of dark ' +
    'thread rather than bone, each rack cinched with a pale thread-wrap band, ' +
    'and its tall thin legs carry matching pale thread socks above each ' +
    'hoof. Its fawn thread-hide coat pales to cream along the belly, chest ' +
    'and rump. Ever alert, ears flicking and neck raised, it prances on a ' +
    'high, snapping trot and bolts in a startled spring at the first sign ' +
    'of a threat.',
};
