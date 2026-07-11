import * as THREE from 'three';
import * as rig from '../anim/rig.js';

// ============================================================================
// THE LAST NEEDLE — final boss of Nevermend, the Ravelling given form.
// Loomfall lore: when the Weaver's Loom frays past mending, the last stitch
// pulls itself free and rises as a colossal floating needle-entity — the
// Ravelling wearing the shape of the tool that made it. It has no legs; it
// never touches ground, hanging instead inside a slow void-grey aura. A tall
// PALE SILVER needle-spire (never dark iron) tapers to a glinting killing
// point below, flared at the shoulders into an asymmetric crossguard,
// stitch-barbed down its length, wrapped at its waist in a band of grey-blue
// thread, and crowned above by a clear radiating ring of 8 writhing,
// red-barbed thread-tendrils around a single searing eye-of-thread — the
// great rectangular needle-eye slot, threaded with a dark strand out front
// and a second slack thread unraveling loose off the back of the crown. As
// the fight escalates through its three phases the eye burns from a bright
// searing white toward a dull blood-red, the aura swells, and the
// tendril-crown spins and lashes faster. It is bound, not killed: when
// beaten it does not shatter or bleed — it stills, dims, and withdraws back
// into the dark it came from.
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
  // 0-0.2 band for exactly this reason; kept low here so the actual
  // pale-silver/grey-blue hex values read as lit diffuse color instead of
  // being swallowed by unlit metallic falloff.
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
  // Static blood-red accent: sits behind/around the eye lens, on one
  // stitch-barb low on the shaft, and on every tendril's needle-tip barb —
  // so the brief's "blood-red accent" is a real, always-visible structural
  // color scattered through the whole silhouette (not something that only
  // appears once animate() has driven the eye's emissive lerp deep into its
  // hot phase). The eye lens itself still phase-shifts white->red via
  // eyeMat above.
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

  // Defensive numeric coercion — mirrors rig.js's own internal guards, for
  // arithmetic that happens directly in this file (rig's own exports
  // already self-guard their own inputs).
  function n(v, fallback = 0) {
    const x = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(x) ? x : fallback;
  }
  function clamp01(v) {
    const x = n(v, 0);
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

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

  // ---- Shoulder crossguard flares -----------------------------------------
  // Two outward-canted wing-flares at the shoulder line, asymmetric (left
  // canted higher than right) so the read isn't a perfectly mirrored,
  // generic spike. This is the single biggest silhouette upgrade available:
  // it turns the shoulder box from "wide taper" into a real crossguard,
  // reading as a weapon/entity rather than a plain sharpened pole even at
  // thumbnail scale.
  const flareGeo = new THREE.BoxGeometry(0.34, 0.14, 0.26);
  const flareL = new THREE.Mesh(flareGeo, ironMidMat);
  flareL.position.set(-0.46, 3.6, 0);
  flareL.rotation.z = 0.24;
  spireGroup.add(flareL);
  const flareR = new THREE.Mesh(flareGeo, ironMidMat);
  flareR.position.set(0.46, 3.52, 0);
  flareR.rotation.z = -0.15;
  spireGroup.add(flareR);

  // ---- Stitch-barbs --------------------------------------------------------
  // Small alternating tabs punched into the mid-shaft, reading as
  // stitch-holes/hooked barbs at thumbnail scale — the clearest possible
  // secondary-detail cue that this silhouette is a sewing needle, not a
  // spike or a Minecraft blaze rod. The lowest barb, nearest the point, uses
  // the blood-red accent material so the palette's red pops as a real
  // structural read scattered down the body, not just at the eye — "the
  // last stitch," made literal right above the killing point.
  const barbGeo = new THREE.BoxGeometry(0.14, 0.045, 0.045);
  const barbDefs = [
    [0.27, 2.4, 0.1, ironShadowMat],
    [-0.19, 1.4, -0.08, ironShadowMat],
    [0.15, 0.92, 0.12, ironShadowMat],
    [-0.115, 0.48, -0.1, bloodRimMat],
  ];
  const barbs = barbDefs.map(([x, y, rotZ, m]) => {
    const barb = new THREE.Mesh(barbGeo, m);
    barb.position.set(x, y, 0);
    barb.rotation.z = rotZ;
    spireGroup.add(barb);
    return barb;
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

  // ---- Trailing unravel-thread ---------------------------------------------
  // The "last stitch pulling free" made literal a second time — a separate,
  // slack thread trailing off the BACK of the collar (independent of the
  // front eye-slot thread), built as a two-joint hanging chain so it can
  // drift on its own idle sway and go limp/still during the death withdraw.
  const unravelPivot = new THREE.Group();
  unravelPivot.position.set(-0.12, 0.02, -0.22);
  crownGroup.add(unravelPivot);
  const unravelSeg1 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.22), slotMat);
  unravelSeg1.position.set(0, 0, -0.11);
  unravelSeg1.rotation.x = 0.3;
  unravelPivot.add(unravelSeg1);
  const unravelTipPivot = new THREE.Group();
  unravelTipPivot.position.set(0, -0.06, -0.22);
  unravelPivot.add(unravelTipPivot);
  const unravelSeg2 = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.024, 0.16), slotMat);
  unravelSeg2.position.set(0, 0, -0.08);
  unravelSeg2.rotation.x = 0.5;
  unravelTipPivot.add(unravelSeg2);

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
  // joint, plus a small blood-red needle-barb capping every tip. Root reads
  // as mid grey-blue thread, tip fades to dark shadow so the whole ring
  // stays legible against both bright sky and dark spire, and the red
  // tip-barbs scatter the palette's accent color around the whole crown
  // silhouette instead of leaving it pooled only at the eye. Tip lengths
  // vary slightly per-tendril (every third one a touch shorter) so the
  // ring reads as organically writhing rather than a mechanically uniform
  // fan even before any animation runs.
  const tendrilCount = 8;
  const tendrils = [];
  for (let i = 0; i < tendrilCount; i++) {
    const ang = (i / tendrilCount) * Math.PI * 2;
    const radius = 0.4;
    const lenScale = i % 3 === 0 ? 0.82 : 1;

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

    const tipLen = 0.3 * lenScale;
    const tipGeo = new THREE.BoxGeometry(0.06, 0.06, tipLen);
    const tipSeg = new THREE.Mesh(tipGeo, ironShadowMat);
    tipSeg.position.set(0, 0, tipLen / 2);
    tipSeg.rotation.x = -0.5;
    tipPivot.add(tipSeg);

    // Needle-barb cap at the very end of the tip — the blood-red accent,
    // scattered eight times around the crown's outer rim.
    const tipBarbGeo = new THREE.BoxGeometry(0.055, 0.055, 0.055);
    const tipBarb = new THREE.Mesh(tipBarbGeo, bloodRimMat);
    tipBarb.position.set(0, 0, tipLen);
    tipPivot.add(tipBarb);

    tendrils.push({ pivot: tendrilPivot, tip: tipPivot, barb: tipBarb, phase: i * 0.9 });
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
    flareL,
    flareR,
    barbs,
    wrapGroup,
    wrapRings,
    crownGroup,
    collar,
    needleSlot,
    threadStrand,
    threadDripL,
    threadDripR,
    unravelPivot,
    unravelTipPivot,
    eyeCore,
    eyeRing,
    eyeMat,
    bloodRim,
    tendrils,
    auraGroup,
    auraMotes,
    auraMat,
  };

  // ---- Animation -------------------------------------------------------
  // Built on mobs/anim/rig.js's procedural-motion helpers.
  // Idle:      rig.sway layers two independent-frequency drifts into the
  //            hover-bob/yaw-sway (the boss never sits dead still) and
  //            rig.breathe pulses a faint living scale through the spire
  //            segments; the crown spins and the tendrils writhe on their
  //            own per-tendril phase offsets.
  // Glide:     no legs, so state.speed01/moving drive a rig.walkPhase-based
  //            hover-lurch (small positional drift + extra tendril lag)
  //            instead of a leg cycle, scaled by speed01 like every other
  //            creature's walk.
  // Telegraph: rig.windUp draws the whole spire UP and BACK (a stab
  //            wind-up) while the tendril-crown coils inward and the eye
  //            flares — a real anticipation pose, not an instant strike.
  // Attack:    rig.strike snaps the spire down into a fast plunging stab
  //            with a squash/stretch impact, the tendrils lash outward,
  //            and the eye flashes at its brightest.
  // Phase:     phase 0->2 warms the eye from searing white toward dull
  //            blood-red, speeds the crown spin, and swells the void aura.
  // Hurt:      rig.damp drives a sharp, fast-decaying lateral jolt.
  // Turn:      rig.damp/lerpAngle bank + yaw the whole boss into
  //            state.turn (signed yaw rate), damped so it never snaps.
  // Death:     bound-not-killed — rig.dissolve's scale/drop/spread still
  //            drive the pose, but aimed inward: tendrils fold DOWN against
  //            the shaft instead of flinging outward, the eye and aura dim
  //            to near-dark, all writhe/spin/pulse motion damps to stillness,
  //            and the whole boss sinks and shrinks — a slow stilling
  //            withdrawal back into the dark it came from, no gore.
  // -------------------------------------------------------------------
  let prevT = null;
  let lean = 0;
  let yawOffset = 0;
  let flinch = 0;
  let crownRot = 0;   // accumulated crown-spin angle, integrated frame to
                       // frame so it can be damped smoothly to a stop on
                       // death instead of freezing/cutting off dead
  let crownSpeed = 0.25;

  root.userData.animate = (t, state) => {
    try {
      const s = state || {};
      const parts = root.userData.parts;
      const time = n(t, 0);
      let dt = 0;
      if (prevT !== null) dt = Math.max(0, Math.min(0.12, time - prevT));
      prevT = time;

      const moving = !!s.moving;
      const speed01 = clamp01(s.speed01 != null ? s.speed01 : (moving ? 1 : 0));
      const hurt = clamp01(s.hurt);
      const attack = clamp01(s.attack);
      const telegraph = clamp01(s.telegraph);
      const dying = clamp01(s.dying);
      const turn = n(s.turn, 0);
      const phase = Math.max(0, Math.min(2, n(s.phase, 0))); // 0..2
      const phaseT = phase / 2; // 0..1 normalized escalation

      // Turn lean/yaw: bank and nose the boss into its yaw rate, damped so
      // it never snaps from frame to frame.
      const leanTarget = dying > 0 ? 0 : Math.max(-1, Math.min(1, -turn)) * 0.14;
      lean = rig.damp(lean, leanTarget, 6, dt || 0.016);
      const yawTarget = dying > 0 ? yawOffset : Math.max(-1, Math.min(1, turn)) * 0.3;
      yawOffset = rig.lerpAngle(yawOffset, yawTarget, Math.min(1, (dt || 0.016) * 5));

      if (dying > 0) {
        // --- DEATH: bound, not killed — slow stilling withdrawal, no gore ---
        const d = rig.dissolve(dying);
        // Shrinks, but never to nothing — it withdraws into the dark, it
        // doesn't get destroyed.
        const sc = 1 - d.scale * 0.82;
        parts.hoverGroup.scale.setScalar(Math.max(0.16, sc));
        parts.hoverGroup.position.y = -d.drop * 1.1 + Math.sin(time * 0.4) * 0.03 * (1 - dying);
        parts.hoverGroup.rotation.z = lean * (1 - dying);
        parts.hoverGroup.rotation.y = yawOffset;

        parts.spireGroup.position.set(0, 0, 0);
        parts.spireGroup.rotation.set(0, 0, 0);
        parts.spireGroup.scale.set(1, 1, 1);

        // Tendrils fold DOWN and IN against the shaft — withdrawing, not
        // flinging apart — and stop lashing sideways as the boss goes limp.
        parts.tendrils.forEach(({ pivot, tip }) => {
          pivot.rotation.x = -0.1 - d.spread * 0.5;
          pivot.rotation.z *= (1 - dying);
          tip.rotation.x = d.spread * 0.25;
        });
        // Crown spin winds down to a stop rather than cutting off dead —
        // damp the angular RATE toward 0 and keep integrating the angle
        // from that decaying rate, so it visibly decelerates.
        crownSpeed = rig.damp(crownSpeed, 0, 1.5, dt || 0.016);
        crownRot += crownSpeed * (dt || 0.016);
        parts.crownGroup.rotation.y = crownRot;

        // The unravel-thread and eye-slot thread go slack and still.
        parts.unravelPivot.rotation.x *= (1 - dying);
        parts.unravelTipPivot.rotation.x *= (1 - dying);

        // The light goes out of it — no gore, just dimming — and the void
        // aura contracts and fades as it closes back up around the boss.
        const dim = 1 - dying;
        parts.eyeMat.emissiveIntensity = Math.max(0.15, 1.8 * dim);
        parts.eyeCore.scale.set(1 - dying * 0.35, 1 - dying * 0.35, 1);
        parts.auraMat.opacity = Math.max(0.02, 0.32 * dim);
        parts.auraMat.emissiveIntensity = Math.max(0.03, 0.3 * dim);
        parts.auraMotes.forEach(({ mesh }) => {
          mesh.scale.setScalar(Math.max(0.08, dim));
        });
        return; // death pose overrides everything below
      }

      // Reset any death-mutated transforms in case a previous frame was
      // mid-withdrawal and the boss got revived/recycled (defensive;
      // animate() must never assume ordering with the manager's own
      // removal/respawn timing).
      if (parts.hoverGroup.scale.x !== 1) parts.hoverGroup.scale.set(1, 1, 1);

      // ---- Idle hover-writhe: two independent-frequency sways layered for
      // a big, heavy, unhurried bob that never repeats exactly. ----
      const bob = rig.sway(time, 2.3, 1.3, 0) + rig.sway(time, 0.85, 0.53, 0.6);
      parts.hoverGroup.position.y = bob;

      // Slow overall yaw/roll so the spire never sits dead still, plus a
      // little more restlessness as phase climbs, plus the turn-lean/yaw.
      const yawAmpMul = (0.06 + phaseT * 0.05) / 0.06;
      const yawFreqMul = (0.35 + phaseT * 0.25) / 0.7;
      parts.hoverGroup.rotation.y = rig.sway(time, yawAmpMul, yawFreqMul, 0) + yawOffset;
      parts.hoverGroup.rotation.z = rig.sway(time, 0.42, 0.71, 1.1) + lean;

      // Hover-lurch: no legs to walk on, so state.speed01 drives a subtle
      // rig.walkPhase-based repositioning drift instead of a leg cycle —
      // amplitude/cadence both scale with speed01 exactly like a real walk
      // cycle would, so the boss never "slides on rails" while moving and
      // never lurches at full amplitude while holding still.
      const wp = rig.walkPhase(time, speed01, 0.6);
      // Assign (not accumulate) — these are absolute offsets derived from
      // the current instant, so += here would drift the boss away from
      // origin forever instead of oscillating around it.
      parts.hoverGroup.position.x = (wp.FR - wp.FL) * 0.02;
      parts.hoverGroup.position.z = Math.sin(time * 1.1) * 0.012 * speed01;

      // ---- Telegraph / attack: rig.windUp draws the spire up and back in
      // anticipation, rig.strike snaps it down into the plunge. ----
      const attackActive = telegraph > 0 || attack > 0;
      const blend = Math.max(telegraph, attack);
      if (attackActive) {
        const windAmt = rig.windUp(telegraph); // 0 -> ~-1.1 -> -1 (pull-back)
        const strikeAmt = rig.strike(attack); // 0 -> 1, fast release
        const rise = -windAmt; // 0 .. ~1.1 .. 1 (positive = rearing up/back)

        // Rear up and back through the wind-up, then plunge down fast
        // through the strike, easing out like a struck spring at impact.
        const plunge = Math.sin(strikeAmt * Math.PI) * strikeAmt;
        parts.spireGroup.position.y = rise * 0.3 * (1 - strikeAmt) - plunge * 0.55;
        parts.spireGroup.rotation.x = -rise * 0.14 * (1 - strikeAmt) + plunge * 0.2;
        const sq = 1 - plunge * 0.05;
        parts.spireGroup.scale.set(sq, 1 + plunge * 0.09, sq);

        // Tendril-crown coils inward through the wind-up (anticipation),
        // then lashes outward hard on the strike (release).
        parts.tendrils.forEach(({ pivot, tip, phase: ph }) => {
          pivot.rotation.x = -0.1 - rise * 0.25 * (1 - strikeAmt) + plunge * 0.35 + Math.sin(time * 2 + ph) * 0.06;
          pivot.rotation.z = Math.sin(time * 2 + ph * 1.3) * 0.1 + plunge * Math.sin(ph) * 0.2;
          tip.rotation.x = plunge * 0.6 + Math.sin(time * 2.6 + ph) * 0.15;
        });

        // Eye flares sharply through the wind-up and flashes hottest at
        // the strike's impact.
        parts.eyeMat.emissiveIntensity = 1.8 + blend * 2.2 + plunge * 1.6;
        const eyeScale = 1 + blend * 0.18 + plunge * 0.2;
        parts.eyeCore.scale.set(eyeScale, eyeScale, 1);
      } else {
        parts.spireGroup.position.y = 0;
        parts.spireGroup.rotation.x = 0;
        parts.spireGroup.scale.set(1, 1, 1);

        // Tendrils writhe: each on its own sine phase so the crown reads
        // alive rather than mechanically uniform; speeds up with phase.
        const writheSpeed = 1.6 + phaseT * 1.8;
        parts.tendrils.forEach(({ pivot, tip, phase: ph }) => {
          pivot.rotation.x = -0.1 + Math.sin(time * writheSpeed + ph) * (0.22 + phaseT * 0.12);
          pivot.rotation.z = Math.sin(time * writheSpeed * 0.7 + ph * 1.3) * 0.12;
          tip.rotation.x = Math.sin(time * writheSpeed * 1.4 + ph + 0.6) * 0.4;
        });
      }

      // Hurt jolt: a sharp lateral snap, damped so it decays smoothly
      // regardless of how long state.hurt is held.
      flinch = rig.damp(flinch, hurt, 20, dt || 0.016);
      if (flinch > 0.001) {
        parts.spireGroup.position.x = Math.sin(time * 40) * 0.06 * flinch;
        parts.spireGroup.rotation.z = Math.sin(time * 33) * 0.05 * flinch;
      } else {
        parts.spireGroup.position.x = 0;
        parts.spireGroup.rotation.z = 0;
      }

      // Crown rotation: slow constant spin of the tendril-crown+eye,
      // speeding up noticeably at higher phases and further under attack.
      // Rate is damped (not snapped) toward its target and the angle is
      // integrated from that rate so death can decelerate it smoothly
      // instead of cutting the spin off dead.
      const crownSpeedTarget = 0.25 + phaseT * 0.55 + blend * 0.35;
      crownSpeed = rig.damp(crownSpeed, crownSpeedTarget, 4, dt || 0.016);
      crownRot += crownSpeed * (dt || 0.016);
      parts.crownGroup.rotation.y = crownRot;

      // Eye pulse (idle/non-attack baseline): strong, always-searing base
      // glow so the eye never reads as weak, plus a color shift from
      // bright searing white (#F2F5FA) at phase 0 toward a dull burning
      // blood-red (#5E1F1F) at phase 2.
      if (!attackActive) {
        const pulseSpeed = 2.2 + phaseT * 2.0;
        const pulse = 0.5 + 0.5 * Math.sin(time * pulseSpeed);
        parts.eyeMat.emissiveIntensity = 1.8 + pulse * (1.3 + phaseT * 1.4);
        const eyeScale = 1 + pulse * 0.12;
        parts.eyeCore.scale.set(eyeScale, eyeScale, 1);
      }
      const eyeColdColor = 0xf2f5fa;
      const eyeHotColor = 0x5e1f1f;
      const lerpT = Math.min(phaseT + blend * 0.5, 1);
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

      // Void aura: motes drift on slow independent orbits, and both their
      // orbit radius and glow swell as phase climbs — the aura "grows".
      const auraGrow = 1 + phaseT * 0.6 + blend * 0.25;
      parts.auraMotes.forEach(({ mesh, phase: ph, baseR, baseY }) => {
        const orbitSpeed = 0.4 + phaseT * 0.3;
        const r = baseR * auraGrow;
        mesh.position.x = Math.cos(time * orbitSpeed + ph) * r;
        mesh.position.z = Math.sin(time * orbitSpeed + ph) * r;
        mesh.position.y = baseY + Math.sin(time * 0.8 + ph) * 0.15;
        mesh.scale.setScalar(auraGrow);
      });
      parts.auraMat.opacity = 0.28 + phaseT * 0.22 + blend * 0.15;
      parts.auraMat.emissiveIntensity = 0.3 + phaseT * 0.5 + blend * 0.4;

      // Thread-wrap band: slow independent counter-rotation of alternating
      // rings so the midsection reads as "wound" thread, not a static cuff.
      parts.wrapRings.forEach((ring, i) => {
        ring.rotation.y = time * (i % 2 === 0 ? 0.4 : -0.4) + i;
      });

      // Idle-breathe on the spire segments — always running, subtle, gives
      // the iron mass a faint living pulse even when nothing else is
      // active. Driven by rig.breathe so its cadence stays consistent with
      // every other creature's idle breath.
      const breatheAmt = rig.breathe(time, 0.6, 0.5);
      parts.spireSegs.forEach((seg, i) => {
        const k = 1 + breatheAmt * (0.4 + (i / parts.spireSegs.length) * 0.6);
        seg.scale.set(k, 1, k);
      });

      // Trailing unravel-thread: an independent slow sway so it drifts on
      // its own, distinct from the tendrils and the front eye-thread.
      parts.unravelPivot.rotation.x = 0.15 + rig.sway(time, 0.8, 0.5, 2.4);
      parts.unravelPivot.rotation.z = rig.sway(time, 0.6, 0.4, 0.7);
      parts.unravelTipPivot.rotation.x = rig.sway(time, 1, 0.65, 1.3) * 0.6;
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
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
    'iron — flares at the shoulders into an asymmetric crossguard, tapers ' +
    'through stitch-barbed shaft segments to a glinting killing point ' +
    'below with no legs to touch the ground, wrapped at the waist in ' +
    'grey-blue thread, and crowned above by a clear ring of 8 writhing, ' +
    'red-barbed thread-tendrils around a searing eye-of-thread set within ' +
    'the great rectangular needle-eye slot, threaded with a dark strand in ' +
    'front and a second loose thread unraveling off the back of the ' +
    'crown. As the fight escalates through three phases the eye burns from ' +
    'a bright searing white toward a dull blood-red, the void aura swells, ' +
    'and the crown spins and lashes faster. It is bound, not killed: when ' +
    'defeated it does not shatter or bleed — it stills, dims, and slowly ' +
    'withdraws back into the dark it came from.',
};
