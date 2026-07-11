import * as THREE from 'three';

// ============================================================================
// THE LAST NEEDLE — final boss of Nevermend, the Ravelling given form.
// Loomfall lore: when the Weaver's Loom frays past mending, the last stitch
// pulls itself free and rises as a colossal floating needle-entity — the
// Ravelling wearing the shape of the tool that made it. It has no legs; it
// never touches ground, hanging instead inside a slow void-grey aura. A tall
// PALE SILVER needle-spire (never dark iron) tapers to a glinting killing
// point below, wrapped at its waist in a band of grey-blue thread, and
// crowned above by a clear radiating ring of 8 writhing thread-tendrils
// around a single searing eye-of-thread — the great rectangular needle-eye
// slot, threaded with a dark strand, pierced through the crown just behind
// it. As the fight escalates through its three phases the eye burns from a
// bright searing white toward a dull blood-red, the aura swells, and the
// tendril-crown spins and lashes faster.
// ============================================================================

export function build() {
  const root = new THREE.Group();
  root.name = 'The Last Needle';

  // ---- Palette (canonical Last Needle bestiary palette) -------------------
  // A PALE SILVER needle, never dark iron: bright silver main, a mid
  // grey-blue for shading/thread-wrap, a dark grey-blue shadow tone,
  // near-black for punched-through voids, a bright near-white highlight for
  // glinting metal, and a single dull blood-red accent reserved for the
  // eye-of-thread and its dark thread strand.
  const palette = {
    ironSpire: 0xd8dee8,   // pale silver needle — spire main
    ironMid: 0x8a93a8,     // mid grey-blue — spire shading + thread-wrap
    ironShadow: 0x3b4152,  // dark grey-blue — spire shadow + tendril tips
    voidAccent: 0x0b0d14,  // near-black — punched-through slot / dark thread
    highlight: 0xf2f5fa,   // bright near-white — glinting edges, cool eye state
    accent: 0x5e1f1f,      // dull blood-red — eye/thread accent, hot eye state
  };

  // ---- Materials (shared per color so the box count stays lean) --------
  // NOTE on metalness: this scene has no environment map, so
  // MeshStandardMaterial's metallic response (which sources its color from
  // specular/reflection, not diffuse) starves out to near-black across most
  // of the surface with only bright import at direct specular highlights.
  // Every other creature file in this package keeps metalness in the
  // 0-0.2 band for exactly this reason; the Last Needle previously ran
  // 0.5-0.75 here, which is why the pale-silver #D8DEE8 spire was rendering
  // as dark slate-gray/near-black instead of its intended base color. Kept
  // low so the actual pale-silver/grey-blue hex values read as lit diffuse
  // color instead of being swallowed by unlit metallic falloff.
  const ironMat = new THREE.MeshStandardMaterial({
    color: palette.ironSpire,
    roughness: 0.3,
    metalness: 0.2,
  });
  const ironMidMat = new THREE.MeshStandardMaterial({
    color: palette.ironMid,
    roughness: 0.4,
    metalness: 0.15,
  });
  const ironShadowMat = new THREE.MeshStandardMaterial({
    color: palette.ironShadow,
    roughness: 0.5,
    metalness: 0.1,
  });
  const highlightMat = new THREE.MeshStandardMaterial({
    color: palette.highlight,
    roughness: 0.15,
    metalness: 0.15,
    emissive: new THREE.Color(palette.highlight),
    emissiveIntensity: 0.4,
  });
  const threadMat = new THREE.MeshStandardMaterial({
    color: palette.ironMid,
    roughness: 0.8,
    metalness: 0.1,
  });
  // Eye material's emissive color/intensity is mutated live by animate() to
  // sell the phase shift from a bright searing white toward a dull burning
  // blood-red, and to always read as strongly, searingly bright.
  const eyeMat = new THREE.MeshStandardMaterial({
    color: palette.highlight,
    roughness: 0.2,
    metalness: 0.15,
    emissive: new THREE.Color(palette.highlight),
    emissiveIntensity: 2.0,
  });
  // Needle-eye slot: a near-black punched-through hole beneath the crown.
  const slotMat = new THREE.MeshStandardMaterial({
    color: palette.voidAccent,
    roughness: 0.7,
    metalness: 0.15,
  });
  // Static blood-red accent ring: sits behind/around the eye lens so the
  // brief's "blood-red eye accent" is a real, always-visible structural
  // color (not something that only appears once animate() has driven the
  // eye's emissive lerp deep into its hot phase). The lens itself still
  // phase-shifts white->red via eyeMat above.
  const bloodRimMat = new THREE.MeshStandardMaterial({
    color: palette.accent,
    roughness: 0.5,
    metalness: 0.1,
    emissive: new THREE.Color(palette.accent),
    emissiveIntensity: 0.6,
  });
  const auraMat = new THREE.MeshStandardMaterial({
    color: palette.ironMid,
    roughness: 1.0,
    metalness: 0.0,
    emissive: new THREE.Color(palette.ironMid),
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
    [0.62, 0.7, 0.62, 3.55],   // shoulders, just under the neck/crown
    [0.5, 0.6, 0.5, 2.95],
    [0.4, 0.55, 0.4, 2.4],
    [0.32, 0.5, 0.32, 1.9],    // waist — thread band wraps here (below)
    [0.24, 0.5, 0.24, 1.4],
    [0.16, 0.5, 0.16, 0.92],
    [0.09, 0.45, 0.09, 0.48],  // shaft narrowing to the tip
    [0.045, 0.26, 0.045, 0.13], // needle point, lowest box, bottom ~= y0
    [0.5, 0.28, 0.5, 4.02],    // neck — bridges the shoulders up to the crown
  ];
  // Pale silver is the DOMINANT tone across the shaft (per brief: "never
  // dark iron") — shoulders, neck, upper-mid and lower-mid shaft all read
  // pale-silver — with only two thin mid grey-blue accent bands (at the
  // waist thread-wrap and just below it) and a single dark grey-blue
  // shadow segment right above the tip for grounding, then a bright
  // glinting highlight at the needle's point. This keeps the silhouette
  // reading pale-silver even when a camera/viewport crop clips the topmost
  // shoulders/neck/crown, instead of concentrating all the bright material
  // in the very top segments where it's most likely to be cropped out.
  const spireMatFor = (i) => {
    if (i === 8) return ironMat;        // neck, just under the crown — bright
    if (i <= 2) return ironMat;         // shoulders/upper shaft — pale silver
    if (i === 3) return ironMidMat;     // waist — mid grey-blue thread-wrap accent
    if (i === 4) return ironMat;        // lower-mid shaft — back to pale silver
    if (i === 5) return ironMidMat;     // brief mid-tone transition band
    if (i === 6) return ironShadowMat;  // just above the tip — dark shadow accent
    return highlightMat;                // needle point — bright glint
  };
  const spireSegs = spireSegDefs.map(([w, h, d, cy], i) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(geo, spireMatFor(i));
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

  // ---- Crown group: sits clear ABOVE the spire's shoulder mass so the
  // tendril ring and needle-eye read as their own silhouette instead of
  // being swallowed into the wide shoulder box beneath them.
  const crownGroup = new THREE.Group();
  crownGroup.position.set(0, 4.15, 0);
  spireGroup.add(crownGroup);

  // Crown collar — a squat wide box the tendrils and eye mount to.
  const collarGeo = new THREE.BoxGeometry(0.5, 0.22, 0.5);
  const collar = new THREE.Mesh(collarGeo, ironMat);
  collar.position.set(0, 0, 0);
  crownGroup.add(collar);

  // Great needle-eye slot — a CLEAR rectangular hole through the top of a
  // real needle, punched through the collar and facing +Z so it reads
  // unmistakably from the front as a slot, not a sliver.
  const slotGeo = new THREE.BoxGeometry(0.16, 0.28, 0.52);
  const needleSlot = new THREE.Mesh(slotGeo, slotMat);
  needleSlot.position.set(0, -0.01, 0);
  crownGroup.add(needleSlot);

  // A dark thread strand physically threaded through the eye-slot, laid
  // across the front opening and trailing out past both edges — the "last
  // stitch" made literal.
  const threadStrand = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.035, 0.035),
    slotMat
  );
  threadStrand.position.set(0, -0.03, 0.31);
  crownGroup.add(threadStrand);
  const threadDripGeo = new THREE.BoxGeometry(0.035, 0.09, 0.035);
  const threadDripL = new THREE.Mesh(threadDripGeo, slotMat);
  threadDripL.position.set(-0.17, -0.08, 0.31);
  threadDripL.rotation.z = 0.2;
  crownGroup.add(threadDripL);
  const threadDripR = new THREE.Mesh(threadDripGeo, slotMat);
  threadDripR.position.set(0.17, -0.08, 0.31);
  threadDripR.rotation.z = -0.2;
  crownGroup.add(threadDripR);

  // Eye-of-thread — a glowing lens mounted right inside the slot opening,
  // framed by a bright metal ring, so the eye visibly burns through the
  // needle-eye hole rather than floating apart from it. A static blood-red
  // rim sits just behind the bright ring — the brief's "blood-red eye
  // accent" made a permanent structural feature so it reads in any single
  // frame, not only once the phase-driven emissive lerp has gone hot.
  const bloodRimGeo = new THREE.BoxGeometry(0.27, 0.39, 0.04);
  const bloodRim = new THREE.Mesh(bloodRimGeo, bloodRimMat);
  bloodRim.position.set(0, -0.01, 0.24);
  crownGroup.add(bloodRim);
  const eyeRingGeo = new THREE.BoxGeometry(0.22, 0.34, 0.05);
  const eyeRing = new THREE.Mesh(eyeRingGeo, highlightMat);
  eyeRing.position.set(0, -0.01, 0.27);
  crownGroup.add(eyeRing);
  const eyeCoreGeo = new THREE.BoxGeometry(0.13, 0.22, 0.08);
  const eyeCore = new THREE.Mesh(eyeCoreGeo, eyeMat);
  eyeCore.position.set(0, -0.01, 0.29);
  crownGroup.add(eyeCore);

  // Tendril-crown: a CLEAR RING of 8 thin box arms radiating up and outward
  // around the collar/eye, each built from two angled segments (root + tip
  // pivot) so the writhe animation can bend them independently at the
  // joint. Root reads as mid grey-blue thread, tip fades to dark shadow so
  // the whole ring stays legible against both bright sky and dark spire.
  const tendrilCount = 8;
  const tendrils = [];
  for (let i = 0; i < tendrilCount; i++) {
    const ang = (i / tendrilCount) * Math.PI * 2;
    const radius = 0.4;

    const tendrilPivot = new THREE.Group();
    tendrilPivot.position.set(
      Math.cos(ang) * radius,
      0.1,
      Math.sin(ang) * radius
    );
    tendrilPivot.rotation.y = -ang; // face outward from center
    crownGroup.add(tendrilPivot);

    const rootGeo = new THREE.BoxGeometry(0.08, 0.08, 0.36);
    const rootSeg = new THREE.Mesh(rootGeo, threadMat);
    rootSeg.position.set(0, 0, 0.18);
    rootSeg.rotation.x = -0.4; // angled up and out
    tendrilPivot.add(rootSeg);

    const tipPivot = new THREE.Group();
    tipPivot.position.set(0, 0.15, 0.34);
    tendrilPivot.add(tipPivot);

    const tipGeo = new THREE.BoxGeometry(0.06, 0.06, 0.3);
    const tipSeg = new THREE.Mesh(tipGeo, ironShadowMat);
    tipSeg.position.set(0, 0, 0.15);
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
  headAnchor.position.set(0, 4.65, 0);
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
    threadStrand,
    threadDripL,
    threadDripR,
    eyeCore,
    eyeRing,
    eyeMat,
    bloodRim,
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

    // Eye pulse: strong, always-searing base glow so the eye never reads as
    // weak, plus a color shift from bright searing white (#F2F5FA) at phase
    // 0 toward a dull burning blood-red (#5E1F1F) at phase 2, plus
    // brighter/faster pulsing under attack.
    const pulseSpeed = 2.2 + phaseT * 2.0 + attack * 3.0;
    const pulse = 0.5 + 0.5 * Math.sin(t * pulseSpeed);
    parts.eyeMat.emissiveIntensity = 1.8 + pulse * (1.3 + phaseT * 1.4) + attack * 1.8;
    const eyeColdColor = 0xf2f5fa;
    const eyeHotColor = 0x5e1f1f;
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
  canonicalId: 'last_needle',
  dimensionDefault: 'nevermend',
  palette: {
    ironSpire: '#D8DEE8',
    ironMid: '#8A93A8',
    ironShadow: '#3B4152',
    voidAccent: '#0B0D14',
    highlight: '#F2F5FA',
    accent: '#5E1F1F',
  },
  description:
    'The final boss of Nevermend: the Ravelling given form as a colossal ' +
    'floating needle-entity. A tall, PALE SILVER needle-spire — never dark ' +
    'iron — tapers to a glinting killing point below with no legs to touch ' +
    'the ground, wrapped at the waist in grey-blue thread, and crowned ' +
    'above by a clear ring of 8 writhing thread-tendrils around a searing ' +
    'eye-of-thread set within the great rectangular needle-eye slot, ' +
    'threaded with a dark strand. As the fight escalates through three ' +
    'phases the eye burns from a bright searing white toward a dull ' +
    'blood-red, the void aura swells, and the crown spins and lashes faster.',
};
