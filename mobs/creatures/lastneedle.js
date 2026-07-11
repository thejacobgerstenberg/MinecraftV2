import * as THREE from 'three';

// ============================================================================
// THE LAST NEEDLE — final boss of Nevermend, the Ravelling given form.
// Loomfall lore: when the Weaver's Loom frays past mending, the last stitch
// pulls itself free and rises as a colossal floating needle-entity — the
// Ravelling wearing the shape of the tool that made it. It has no legs; it
// never touches ground, hanging instead inside a slow void-purple aura. A
// tall tarnished-iron spire tapers to a killing point below, wrapped at its
// waist in a band of grey-violet thread, and crowned above by a radiating
// halo of writhing thread-tendrils around a single searing eye-of-thread —
// the great needle-eye slot pierced through the crown just beneath it. As
// the fight escalates through its three phases the eye reddens, the aura
// swells, and the tendril-crown spins and lashes faster.
// ============================================================================

export function build() {
  const root = new THREE.Group();
  root.name = 'The Last Needle';

  // ---- Palette ---------------------------------------------------------
  const palette = {
    ironSpire: 0x4a4658,   // tarnished needle-iron — the spire core
    threadWrap: 0x7a6e8c,  // thread-wrap — midsection band + tendrils
    eye: 0xe0d24a,         // searing thread-eye — emissive, phase 1
    eyeHot: 0xff5a5a,      // searing thread-eye — emissive, phase 3 target
    aura: 0x8e6adf,        // void aura — faint emissive halo/motes
  };

  // ---- Materials (shared per color so the box count stays lean) --------
  const ironMat = new THREE.MeshStandardMaterial({
    color: palette.ironSpire,
    roughness: 0.55,
    metalness: 0.65,
  });
  const threadMat = new THREE.MeshStandardMaterial({
    color: palette.threadWrap,
    roughness: 0.8,
    metalness: 0.1,
  });
  // Eye material's emissive color/intensity is mutated live by animate() to
  // sell the phase shift from yellow-gold toward burning red.
  const eyeMat = new THREE.MeshStandardMaterial({
    color: palette.eye,
    roughness: 0.25,
    metalness: 0.2,
    emissive: new THREE.Color(palette.eye),
    emissiveIntensity: 1.4,
  });
  // Needle-eye slot: a darker punched-through hole beneath the crown.
  const slotMat = new THREE.MeshStandardMaterial({
    color: 0x1c1a24,
    roughness: 0.6,
    metalness: 0.3,
  });
  const auraMat = new THREE.MeshStandardMaterial({
    color: palette.aura,
    roughness: 1.0,
    metalness: 0.0,
    emissive: new THREE.Color(palette.aura),
    emissiveIntensity: 0.35,
    transparent: true,
    opacity: 0.35,
  });

  // ---- Root hover rig ----------------------------------------------------
  // Everything hangs off hoverGroup so animate() can bob/rotate/lunge the
  // whole boss as one unit without fighting individual part transforms.
  const hoverGroup = new THREE.Group();
  hoverGroup.position.set(0, 0, 0);
  root.add(hoverGroup);

  // ---- Spire: tapering stack of boxes, wide at top, sharp point below ---
  // Feet-at-y0 contract: the boss floats, so "feet" is the needle tip,
  // which we still pin to local y=0 as the lowest geometry.
  const spireGroup = new THREE.Group();
  hoverGroup.add(spireGroup);

  const spireSegDefs = [
    // [w, h, d, centerY]
    [0.62, 0.7, 0.62, 3.55],  // shoulders, just under the crown
    [0.5, 0.6, 0.5, 2.95],
    [0.4, 0.55, 0.4, 2.4],
    [0.32, 0.5, 0.32, 1.9],   // waist — thread band wraps here (below)
    [0.24, 0.5, 0.24, 1.4],
    [0.16, 0.5, 0.16, 0.92],
    [0.09, 0.45, 0.09, 0.48], // shaft narrowing to the tip
    [0.045, 0.26, 0.045, 0.13], // needle point, lowest box, bottom ~= y0
  ];
  const spireSegs = spireSegDefs.map(([w, h, d, cy]) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(geo, ironMat);
    m.position.set(0, cy, 0);
    spireGroup.add(m);
    return m;
  });

  // ---- Midsection thread-wrap band: overlapping rings just below waist --
  const wrapGroup = new THREE.Group();
  wrapGroup.position.set(0, 1.9, 0);
  spireGroup.add(wrapGroup);
  const wrapRingDefs = [
    [0.4, 0.1, 0.4, 0.16, 0],
    [0.38, 0.09, 0.38, 0.02, 0.5],
    [0.4, 0.1, 0.4, -0.12, 0],
    [0.38, 0.09, 0.38, -0.26, 0.5],
  ];
  const wrapRings = wrapRingDefs.map(([w, h, d, cy, rot]) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(geo, threadMat);
    m.position.set(0, cy, 0);
    m.rotation.y = rot;
    wrapGroup.add(m);
    return m;
  });

  // ---- Crown group: sits atop the spire, rotates independently ----------
  const crownGroup = new THREE.Group();
  crownGroup.position.set(0, 3.72, 0);
  spireGroup.add(crownGroup);

  // Crown collar — a squat wide box the tendrils and eye mount to.
  const collarGeo = new THREE.BoxGeometry(0.5, 0.22, 0.5);
  const collar = new THREE.Mesh(collarGeo, ironMat);
  collar.position.set(0, 0, 0);
  crownGroup.add(collar);

  // Great needle-eye slot — the hole through the top of a real needle,
  // suggested as a dark rectangular slot punched through the collar,
  // facing +Z so it reads clearly from the front.
  const slotGeo = new THREE.BoxGeometry(0.08, 0.14, 0.54);
  const needleSlot = new THREE.Mesh(slotGeo, slotMat);
  needleSlot.position.set(0, 0.02, 0);
  crownGroup.add(needleSlot);

  // Eye-of-thread — a glowing lens/knot mounted just below/front of the
  // collar, the focal point of the whole design.
  const eyeCoreGeo = new THREE.BoxGeometry(0.22, 0.22, 0.1);
  const eyeCore = new THREE.Mesh(eyeCoreGeo, eyeMat);
  eyeCore.position.set(0, -0.2, 0.3);
  crownGroup.add(eyeCore);
  const eyeRingGeo = new THREE.BoxGeometry(0.3, 0.3, 0.05);
  const eyeRing = new THREE.Mesh(eyeRingGeo, threadMat);
  eyeRing.position.set(0, -0.2, 0.25);
  crownGroup.add(eyeRing);

  // Tendril-crown: 6 thin curved-suggesting box arms radiating around the
  // collar, each built from two angled segments (root + tip pivot) so the
  // writhe animation can bend them independently at the joint.
  const tendrilCount = 6;
  const tendrils = [];
  for (let i = 0; i < tendrilCount; i++) {
    const ang = (i / tendrilCount) * Math.PI * 2;
    const radius = 0.32;

    const tendrilPivot = new THREE.Group();
    tendrilPivot.position.set(
      Math.cos(ang) * radius,
      0.06,
      Math.sin(ang) * radius
    );
    tendrilPivot.rotation.y = -ang; // face outward from center
    crownGroup.add(tendrilPivot);

    const rootGeo = new THREE.BoxGeometry(0.07, 0.07, 0.34);
    const rootSeg = new THREE.Mesh(rootGeo, threadMat);
    rootSeg.position.set(0, 0, 0.17);
    rootSeg.rotation.x = -0.35; // angled up and out
    tendrilPivot.add(rootSeg);

    const tipPivot = new THREE.Group();
    tipPivot.position.set(0, 0.13, 0.32);
    tendrilPivot.add(tipPivot);

    const tipGeo = new THREE.BoxGeometry(0.05, 0.05, 0.28);
    const tipSeg = new THREE.Mesh(tipGeo, threadMat);
    tipSeg.position.set(0, 0, 0.14);
    tipSeg.rotation.x = -0.5;
    tipPivot.add(tipSeg);

    tendrils.push({ pivot: tendrilPivot, tip: tipPivot, phase: i * 0.9 });
  }

  // ---- Void aura: faint translucent motes drifting around the spire -----
  // Four small emissive boxes on independent orbits, scaled up by phase.
  const auraGroup = new THREE.Group();
  hoverGroup.add(auraGroup);
  const auraDefs = [
    [0.9, 2.6, 0.0, 0],
    [-0.9, 1.6, 0.2, 1.4],
    [0.2, 3.0, -0.9, 2.8],
    [-0.3, 1.0, 0.9, 4.2],
  ];
  const auraMotes = auraDefs.map(([x, y, z, ph]) => {
    const geo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
    const m = new THREE.Mesh(geo, auraMat);
    m.position.set(x, y, z);
    auraGroup.add(m);
    return { mesh: m, phase: ph, baseR: Math.hypot(x, z), baseY: y };
  });

  // ---- Head anchor (name-tag) above the crown ----------------------------
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 4.05, 0);
  hoverGroup.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // ---- Store references for animation -------------------------------------
  root.userData.parts = {
    hoverGroup,
    spireGroup,
    spireSegs,
    wrapGroup,
    wrapRings,
    crownGroup,
    collar,
    needleSlot,
    eyeCore,
    eyeRing,
    eyeMat,
    tendrils,
    auraGroup,
    auraMotes,
    auraMat,
  };

  // ---- Animation -----------------------------------------------------------
  // t = seconds elapsed. state = { moving, grounded, fuse, hurt, dimension }
  // and MAY carry boss-only extras { phase:0..2, attack:0..1 } — both are
  // treated as 0/undefined-safe so the module never throws if they're absent.
  root.userData.animate = (t, state) => {
    const s = state || {};
    const parts = root.userData.parts;
    const hurt = Math.min(Math.max(s.hurt || 0, 0), 1);
    const phase = Math.min(Math.max(s.phase || 0, 0), 2); // 0..2
    const attack = Math.min(Math.max(s.attack || 0, 0), 1); // 0..1
    const phaseT = phase / 2; // 0..1 normalized escalation

    // Slow menacing hover-bob for the whole boss — big, heavy, unhurried.
    const bob = Math.sin(t * 0.9) * 0.14 + Math.sin(t * 0.37) * 0.05;
    parts.hoverGroup.position.y = bob;

    // Slow overall sway/rotation so the spire never sits dead still, plus a
    // little more restlessness as phase climbs.
    const swaySpeed = 0.35 + phaseT * 0.25;
    parts.hoverGroup.rotation.y = Math.sin(t * swaySpeed) * (0.06 + phaseT * 0.05);
    parts.hoverGroup.rotation.z = Math.sin(t * 0.5 + 1.1) * 0.025;

    // Downward stab lunge driven by state.attack: the whole spire plunges
    // and snaps back, easing out like a struck spring.
    const stab = Math.sin(attack * Math.PI) * attack;
    parts.spireGroup.position.y = -stab * 0.55;
    parts.spireGroup.rotation.x = stab * 0.18;
    parts.spireGroup.scale.set(1 - stab * 0.04, 1 + stab * 0.08, 1 - stab * 0.04);

    // Hurt jolt: a sharp lateral snap that decays with the hurt value.
    if (hurt > 0) {
      parts.spireGroup.position.x = Math.sin(t * 40) * 0.06 * hurt;
      parts.spireGroup.rotation.z = Math.sin(t * 33) * 0.05 * hurt;
    } else {
      parts.spireGroup.position.x = 0;
    }

    // Crown rotation: slow constant spin of the tendril-crown+eye, speeding
    // up noticeably at higher phases to read as escalating menace.
    const crownSpeed = 0.25 + phaseT * 0.55 + attack * 0.3;
    parts.crownGroup.rotation.y = t * crownSpeed;

    // Eye pulse: base idle pulse, plus color shift from gold (#E0D24A) at
    // phase 0 toward hot red (#FF5A5A) at phase 2, plus brighter/faster
    // pulsing under attack.
    const pulseSpeed = 2.2 + phaseT * 2.0 + attack * 3.0;
    const pulse = 0.5 + 0.5 * Math.sin(t * pulseSpeed);
    parts.eyeMat.emissiveIntensity = 1.1 + pulse * (1.1 + phaseT * 1.2) + attack * 1.5;
    const eyeColdColor = 0xe0d24a;
    const eyeHotColor = 0xff5a5a;
    const lerpT = Math.min(phaseT + attack * 0.5, 1);
    const cCold = ((eyeColdColor >> 16) & 255) / 255;
    const cCold2 = ((eyeColdColor >> 8) & 255) / 255;
    const cCold3 = (eyeColdColor & 255) / 255;
    const cHot = ((eyeHotColor >> 16) & 255) / 255;
    const cHot2 = ((eyeHotColor >> 8) & 255) / 255;
    const cHot3 = (eyeHotColor & 255) / 255;
    parts.eyeMat.emissive.setRGB(
      cCold + (cHot - cCold) * lerpT,
      cCold2 + (cHot2 - cCold2) * lerpT,
      cCold3 + (cHot3 - cCold3) * lerpT
    );
    const eyeScale = 1 + pulse * 0.12 + attack * 0.15;
    parts.eyeCore.scale.set(eyeScale, eyeScale, 1);

    // Tendrils writhe: each on its own sine phase so the crown reads alive
    // rather than mechanically uniform; writhing speeds up with phase and
    // spikes further on attack (lashing out).
    const writheSpeed = 1.6 + phaseT * 1.8 + attack * 2.5;
    parts.tendrils.forEach(({ pivot, tip, phase: ph }) => {
      pivot.rotation.x = -0.1 + Math.sin(t * writheSpeed + ph) * (0.22 + phaseT * 0.12);
      pivot.rotation.z = Math.sin(t * writheSpeed * 0.7 + ph * 1.3) * 0.12;
      tip.rotation.x = Math.sin(t * writheSpeed * 1.4 + ph + 0.6) * (0.4 + attack * 0.3);
    });

    // Void aura: motes drift on slow independent orbits, and both their
    // orbit radius and glow swell as phase climbs — the aura "grows".
    const auraGrow = 1 + phaseT * 0.6 + attack * 0.25;
    parts.auraMotes.forEach(({ mesh, phase: ph, baseR, baseY }) => {
      const orbitSpeed = 0.4 + phaseT * 0.3;
      const r = baseR * auraGrow;
      mesh.position.x = Math.cos(t * orbitSpeed + ph) * r;
      mesh.position.z = Math.sin(t * orbitSpeed + ph) * r;
      mesh.position.y = baseY + Math.sin(t * 0.8 + ph) * 0.15;
      mesh.scale.setScalar(auraGrow);
    });
    parts.auraMat.opacity = 0.28 + phaseT * 0.22 + attack * 0.15;
    parts.auraMat.emissiveIntensity = 0.3 + phaseT * 0.5 + attack * 0.4;

    // Thread-wrap band: slow independent counter-rotation of alternating
    // rings so the midsection reads as "wound" thread, not a static cuff.
    parts.wrapRings.forEach((ring, i) => {
      ring.rotation.y = t * (i % 2 === 0 ? 0.4 : -0.4) + i;
    });

    // Idle-breathe on the spire segments — always running, subtle, gives
    // the iron mass a faint living pulse even when nothing else is active.
    const breathe = Math.sin(t * 1.1) * 0.015;
    parts.spireSegs.forEach((seg, i) => {
      const k = 1 + breathe * (0.4 + (i / parts.spireSegs.length) * 0.6);
      seg.scale.set(k, 1, k);
    });

    // Slight extra drift while "moving" (boss repositioning between
    // attacks) so it doesn't look like it's sliding on rails.
    if (s.moving) {
      parts.hoverGroup.position.x += Math.sin(t * 1.3) * 0.01;
      parts.hoverGroup.position.z += Math.cos(t * 1.1) * 0.01;
    }
  };

  return root;
}

export const meta = {
  archetype: 'boss',
  species: 'The Last Needle',
  dimensionDefault: 'nevermend',
  palette: {
    ironSpire: '#4A4658',
    threadWrap: '#7A6E8C',
    eye: '#E0D24A',
    eyeHot: '#FF5A5A',
    aura: '#8E6ADF',
  },
  description:
    'The final boss of Nevermend: the Ravelling given form as a colossal ' +
    'floating needle-entity. A tarnished-iron spire tapers to a killing ' +
    'point below with no legs to touch the ground, wrapped at the waist in ' +
    'thread, and crowned above by a writhing halo of thread-tendrils around ' +
    'a searing eye-of-thread and the great needle-eye slot. As the fight ' +
    'escalates through three phases the eye burns from gold toward red, the ' +
    'void aura swells, and the crown spins and lashes faster.',
};
