import * as THREE from 'three';
import * as rig from '../anim/rig.js';

// ============================================================================
// EMBERSPINNER — a hostile fire spider-weaver of the Cinderloom forges.
// Archetype: groaner (fast, low-HP base)
//
// Loomfall lore: a coal dragged up from the forge floor and given eight
// legs. A small charred-carapace cephalothorax with a raised brow-plate and
// hooked chelicerae rides in front of a round, bulbous abdomen that pulses
// molten orange from within like a breathing ember — a jagged spine of
// darker ember-shade spikes runs its ridge, and a cluster of loose spinneret
// nubs at the tail trails three pale web-threads. Eight thin, angular legs
// (four per side, three-segment + thread-wrap knee cinch) splay wide and low
// from the sides, skittering in a true alternating-tetrapod gait — a
// criss-crossed diagonal quartet of legs swings together while the other
// four stay planted, and vice versa, so the creature never loses a stable
// four-point stance even at full sprint. It rears its front pair of legs to
// telegraph a strike, snaps them down in a whip-crack lunge, and curls its
// legs tight beneath it before unraveling into loose thread and embers when
// it dies. ORIGINAL silhouette — a bulbous glowing ember-spider woven from
// coal and thread, not a Minecraft creature.
// ============================================================================

// ---- Palette (canonical Emberspinner bestiary palette — all five used) ----
const PALETTE = {
  carapace: 0x3a1108, // charred carapace — body & legs
  abdomenGlow: 0xd94f1e, // molten abdomen glow (emissive, pulses)
  abdomenShade: 0x8c2b12, // darker ember shade — ridge spikes, underside, joints
  eye: 0xf2a03d, // ember eyes / fang tips (emissive)
  webThread: 0xffd98c, // pale web-thread strands & thread-wrap cinches
};

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
// joint pivot and hang/reach downward from that joint — used for every leg
// segment so each limb reads as a jointed, angular rod rather than a rigid
// floating prism.
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
  root.name = 'Emberspinner';

  // ---- Materials (one per canonical hex, every one used below) ----------
  const carapaceMat = new THREE.MeshStandardMaterial({
    color: PALETTE.carapace,
    roughness: 0.85,
    metalness: 0.15,
  });
  const glowMat = new THREE.MeshStandardMaterial({
    color: PALETTE.abdomenGlow,
    roughness: 0.5,
    metalness: 0.05,
    emissive: new THREE.Color(PALETTE.abdomenGlow),
    emissiveIntensity: 1.1,
  });
  const shadeMat = new THREE.MeshStandardMaterial({
    color: PALETTE.abdomenShade,
    roughness: 0.7,
    metalness: 0.05,
    emissive: new THREE.Color(PALETTE.abdomenShade),
    emissiveIntensity: 0.35,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: PALETTE.eye,
    roughness: 0.3,
    metalness: 0.0,
    emissive: new THREE.Color(PALETTE.eye),
    emissiveIntensity: 1.4,
  });
  const threadMat = new THREE.MeshStandardMaterial({
    color: PALETTE.webThread,
    roughness: 0.9,
    metalness: 0.0,
  });

  const mat = { carapace: carapaceMat, glow: glowMat, shade: shadeMat, eye: eyeMat, thread: threadMat };

  // -------------------------------------------------------------------
  // BODY — small cephalothorax up front, larger glowing abdomen behind.
  // -------------------------------------------------------------------
  const HIP_Y = 0.4; // leg attachment height above the ground

  const bodyGroup = new THREE.Group();
  bodyGroup.position.set(0, 0.44, 0);
  root.add(bodyGroup);

  // Cephalothorax — smaller, forward.
  const cephalothorax = box(0.19, 0.16, 0.2, carapaceMat);
  cephalothorax.position.set(0, -0.01, 0.17);
  bodyGroup.add(cephalothorax);

  // Brow-plate — a raised carapace ridge above the eyes. Cheap silhouette
  // win: without it the head is a plain box; with it the head reads as
  // "armored and glaring" even at thumbnail size.
  const browPlate = box(0.15, 0.05, 0.07, shadeMat);
  browPlate.position.set(0, 0.09, 0.19);
  bodyGroup.add(browPlate);

  // Narrow waist/pedicel joining ceph to abdomen.
  const waist = box(0.07, 0.07, 0.05, carapaceMat);
  waist.position.set(0, -0.02, 0.055);
  bodyGroup.add(waist);

  // Abdomen — round glowing mass built as a core plus overlapping chamfer
  // puffs so the silhouette reads bulbous/round rather than a plain box.
  const abdomenCore = box(0.28, 0.24, 0.3, glowMat);
  abdomenCore.position.set(0, 0.02, -0.18);
  bodyGroup.add(abdomenCore);

  const abdomenPuffDefs = [
    { size: [0.15, 0.17, 0.15], pos: [0.11, 0.04, -0.07] },
    { size: [0.15, 0.17, 0.15], pos: [-0.11, 0.04, -0.07] },
    { size: [0.13, 0.15, 0.13], pos: [0.1, 0.02, -0.29] },
    { size: [0.13, 0.15, 0.13], pos: [-0.1, 0.02, -0.29] },
    { size: [0.21, 0.1, 0.17], pos: [0, 0.13, -0.18] }, // top cap
  ];
  const abdomenPuffs = abdomenPuffDefs.map(({ size, pos }) => {
    const m = box(size[0], size[1], size[2], glowMat);
    m.position.set(pos[0], pos[1], pos[2]);
    bodyGroup.add(m);
    return m;
  });

  // Underside shade plate — a darker ember-shade belly, so the glow reads
  // as coming from WITHIN a solid mass rather than the whole abdomen being
  // a flat-lit blob. Secondary detail that sells volume at a glance.
  const abdomenUnderside = box(0.22, 0.07, 0.25, shadeMat);
  abdomenUnderside.position.set(0, -0.13, -0.18);
  bodyGroup.add(abdomenUnderside);

  // Ridge spikes — a jagged spine of darker ember-shade spikes along the
  // abdomen's top, alternating twist so it reads as jagged/organic rather
  // than a neat row. The single clearest "coal ember, not a bug" cue.
  const ridgeSpikeDefs = [
    { pos: [0, 0.17, -0.06], rot: 0.3 },
    { pos: [0, 0.185, -0.19], rot: -0.32 },
    { pos: [0, 0.155, -0.31], rot: 0.28 },
  ];
  const ridgeSpikes = ridgeSpikeDefs.map(({ pos, rot }) => {
    const m = box(0.05, 0.07, 0.05, shadeMat);
    m.position.set(pos[0], pos[1], pos[2]);
    m.rotation.y = rot;
    bodyGroup.add(m);
    return m;
  });

  // Spinneret cluster at the tail tip, with three pale web-threads trailing
  // off — flavor for the "weaver" half of the creature's name, and the
  // showpiece of the death-unravel.
  const spinneretCluster = new THREE.Group();
  spinneretCluster.position.set(0, -0.03, -0.34);
  bodyGroup.add(spinneretCluster);
  const spinneretNubDefs = [
    [0, 0, 0],
    [0.035, -0.015, 0.02],
    [-0.035, -0.015, 0.02],
  ];
  const spinneretNubs = spinneretNubDefs.map(([x, y, z]) => {
    const m = box(0.03, 0.03, 0.03, threadMat);
    m.position.set(x, y, z);
    spinneretCluster.add(m);
    return m;
  });

  const threadDefs = [
    { rz: 0, len: 0.2 },
    { rz: 0.35, len: 0.16 },
    { rz: -0.35, len: 0.16 },
  ];
  const webThreads = threadDefs.map(({ rz, len }) => {
    const t = hangingBox(0.014, len, 0.014, threadMat);
    t.rotation.x = 0.95; // trail out behind, roughly horizontal
    t.rotation.z = rz;
    spinneretCluster.add(t);
    return t;
  });

  // Ember eye cluster on the front of the cephalothorax.
  const eyeGeo = new THREE.BoxGeometry(0.026, 0.026, 0.02);
  const eyeOffsets = [
    [0, 0.035, 0.105],
    [0.05, 0.02, 0.1],
    [-0.05, 0.02, 0.1],
    [0.024, -0.015, 0.1],
    [-0.024, -0.015, 0.1],
  ];
  const eyes = eyeOffsets.map(([x, y, z]) => {
    const m = new THREE.Mesh(eyeGeo, eyeMat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.position.set(x, y, z);
    cephalothorax.add(m);
    return m;
  });

  // Chelicerae — two hinged, hooked fangs at the front of the cephalothorax,
  // each a carapace base + curved ember-glow tip. Redesigned from a simple
  // mandible into a two-segment hook so it reads as a genuine strike weapon.
  function buildChelicera(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.065, -0.045, 0.1);
    pivot.rotation.y = side * 0.32;
    cephalothorax.add(pivot);

    const base = hangingBox(0.032, 0.09, 0.032, carapaceMat);
    base.rotation.x = -0.45;
    pivot.add(base);

    const hookPivot = new THREE.Group();
    hookPivot.position.set(0, -0.085, 0.035);
    pivot.add(hookPivot);

    const tip = hangingBox(0.022, 0.055, 0.022, eyeMat);
    tip.rotation.x = 0.5; // curls inward/down, a hooked fang
    hookPivot.add(tip);

    return { pivot, base, hookPivot, tip };
  }
  const cheliceraL = buildChelicera(-1);
  const cheliceraR = buildChelicera(1);

  const parts = {
    bodyGroup,
    cephalothorax,
    browPlate,
    waist,
    abdomenCore,
    abdomenPuffs,
    abdomenUnderside,
    ridgeSpikes,
    spinneretCluster,
    spinneretNubs,
    webThreads,
    eyes,
    cheliceraL,
    cheliceraR,
    mat,
  };

  // Head anchor for name tags — above the abdomen/cephalothorax mass.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 0.68, 0.1);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // LEGS — eight thin, angular, three-segment limbs (four per side),
  // splayed outward and slightly forward/back for a wide, low stance.
  // Each leg is a chain: hip pivot (splay + yaw) -> upper segment ->
  // knee pivot (thread-wrap cinch) -> lower segment -> ankle pivot ->
  // foot tip segment. Feet land essentially at y=0 (verified via a
  // standalone THREE.js matrix-world check against these exact numbers).
  //
  // Legs are grouped into a true alternating-tetrapod gait: a criss-
  // crossed diagonal quartet ("group 0") swings together while the
  // opposite quartet ("group 1") stays planted, then they swap — so the
  // Emberspinner always keeps a stable four-point stance, even sprinting.
  // -------------------------------------------------------------------
  const UPPER_LEN = 0.17;
  const LOWER_LEN = 0.26;
  const FOOT_LEN = 0.09;
  const A1 = 1.05; // hip: mostly-outward splay angle from vertical
  const A2_DELTA = -0.55; // knee: bends back toward vertical
  const A3_DELTA = -0.32; // ankle: straightens further to reach the ground

  const BASE_YAW = [0.5, 0.15, -0.15, -0.5]; // front -> back, per side
  const LEG_TAGS = ['FR', 'MFR', 'MBR', 'BR', 'FL', 'MFL', 'MBL', 'BL'];
  const LEG_Z = [0.15, 0.05, -0.05, -0.15];

  const LEG_DEFS = [];
  [1, -1].forEach((side) => {
    for (let pairIndex = 0; pairIndex < 4; pairIndex++) {
      const evenPair = pairIndex % 2 === 0;
      // Criss-crossed diagonal grouping: alternates both front-to-back and
      // side-to-side so each active quartet forms a stable support diamond.
      const group = side > 0 ? (evenPair ? 0 : 1) : evenPair ? 1 : 0;
      LEG_DEFS.push({
        side,
        z: LEG_Z[pairIndex],
        yaw: side * BASE_YAW[pairIndex],
        pairIndex,
        group,
        tag: LEG_TAGS[LEG_DEFS.length],
      });
    }
  });

  function buildLeg({ side, z, yaw, pairIndex, group, tag }) {
    const hipPivot = new THREE.Group();
    hipPivot.position.set(side * 0.1, HIP_Y, z);
    hipPivot.rotation.y = yaw;
    hipPivot.rotation.z = side * A1;
    root.add(hipPivot);

    const upper = hangingBox(0.035, UPPER_LEN, 0.035, carapaceMat);
    hipPivot.add(upper);

    const kneePivot = new THREE.Group();
    kneePivot.position.set(0, -UPPER_LEN, 0);
    kneePivot.rotation.z = side * A2_DELTA;
    hipPivot.add(kneePivot);

    // Thread-wrap cinch at the knee — a thin pale band, the leg's echo of
    // the abdomen's spinneret threads. Ties the "weaver" motif into every
    // limb and pops the light accent color at eight evenly spaced points
    // around the silhouette.
    const threadBand = box(0.045, 0.016, 0.045, threadMat);
    threadBand.position.set(0, -0.01, 0);
    kneePivot.add(threadBand);

    const lower = hangingBox(0.028, LOWER_LEN, 0.028, carapaceMat);
    kneePivot.add(lower);

    const anklePivot = new THREE.Group();
    anklePivot.position.set(0, -LOWER_LEN, 0);
    anklePivot.rotation.z = side * A3_DELTA;
    kneePivot.add(anklePivot);

    const foot = hangingBox(0.02, FOOT_LEN, 0.02, carapaceMat);
    anklePivot.add(foot);

    return { hipPivot, kneePivot, threadBand, anklePivot, lower, upper, foot, side, z, pairIndex, group, tag };
  }

  const legs = LEG_DEFS.map(buildLeg);
  parts.legs = legs;

  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION — built on mobs/anim/rig.js's procedural-motion helpers.
  // Idle:      rig.breathe pulses the abdomen glow/scale, rig.sway drives a
  //            slow cephalothorax scan and lazy web-thread drift, plus a
  //            constant fine per-leg micro-skitter jitter so it never looks
  //            frozen.
  // Walk:      rig.walkPhase drives a true 8-leg alternating-tetrapod gait —
  //            each leg's diagonal group takes rig.walkPhase's FR or FL
  //            value (already an antiphase pair), scaled by state.speed01,
  //            with knee/ankle lift derived from the forward-swing sign so
  //            each foot visibly picks up during its forward reach and
  //            drags flat during its planted stroke. Leans into turns via
  //            state.turn.
  // Telegraph: rig.windUp rears BOTH front legs (FR/FL) up and back while
  //            the chelicerae flare open, building to the strike.
  // Attack:    rig.strike snaps the reared front legs down/forward in a
  //            fast whip-crack lunge as the chelicerae snap shut.
  // Hurt:      a sharp full-body jolt/flinch plus a bright flare of the
  //            abdomen and eye glow.
  // Death:     legs curl in tight beneath the body first (a dying spider's
  //            seize), then rig.dissolve's outward spread takes over and
  //            flings them apart as loose thread while the body sinks,
  //            shrinks, and every ember glow gutters dark — a thread-
  //            unravel, never gore.
  // -------------------------------------------------------------------
  const puffRest = abdomenPuffs.map((p) => p.position.clone());
  const spikeRest = ridgeSpikes.map((s) => s.position.clone());
  let prevT = null;
  let lean = 0;
  let flinch = 0;

  root.userData.animate = (t, state) => {
    try {
      const s = state || {};
      const time = n(t, 0);
      let dt = 0;
      if (prevT !== null) dt = Math.max(0, Math.min(0.12, time - prevT));
      prevT = time;

      const moving = !!s.moving;
      const grounded = s.grounded == null ? true : !!s.grounded;
      const speed01 = clamp01(s.speed01 != null ? s.speed01 : moving ? 1 : 0);
      const hurt = clamp01(s.hurt);
      const attack = clamp01(s.attack);
      const telegraph = clamp01(s.telegraph);
      const dying = clamp01(s.dying);
      const fuse = clamp01(s.fuse);
      const phase = n(s.phase, 0);
      const turn = n(s.turn, 0);

      // Lean into turns, damped so it never snaps.
      const leanTarget = dying > 0 ? 0 : Math.max(-0.4, Math.min(0.4, -turn * 0.7));
      lean = rig.damp(lean, leanTarget, 10, dt || 0.016);

      // ---- DEATH: curl-then-unravel dissolve -----------------------------
      if (dying > 0) {
        const d = rig.dissolve(dying);
        const sc = Math.max(0.04, d.scale);
        root.scale.set(sc, sc, sc);
        root.position.y = -d.drop * 0.5;
        root.rotation.z = lean * 0.15;

        // A dying spider curls its legs in first (a hump that peaks mid-
        // death), then rig.dissolve's outward "spread" overtakes it and
        // flings the legs apart into loose, unraveling thread.
        const curl = Math.sin(clamp01(dying) * Math.PI); // 0 -> 1 -> 0 hump
        legs.forEach((leg) => {
          leg.hipPivot.rotation.x = -curl * 0.35;
          leg.hipPivot.rotation.z = leg.side * A1 + leg.side * d.spread * 0.45;
          leg.kneePivot.rotation.x = -curl * 1.1 + d.spread * 0.3;
          leg.anklePivot.rotation.x = -curl * 0.8 + d.spread * 0.5;
        });

        cheliceraL.pivot.rotation.z = d.spread * 0.6;
        cheliceraR.pivot.rotation.z = -d.spread * 0.6;
        cheliceraL.hookPivot.rotation.x = -curl * 0.5;
        cheliceraR.hookPivot.rotation.x = -curl * 0.5;

        spinneretCluster.rotation.x = d.spread * 0.6;
        webThreads.forEach((th, i) => {
          th.rotation.x = 0.95 + d.spread * (0.8 + i * 0.2);
          th.rotation.z = threadDefs[i].rz * (1 + d.spread);
        });

        ridgeSpikes.forEach((sp, i) => {
          const rest = spikeRest[i];
          sp.position.set(rest.x + (i % 2 === 0 ? 1 : -1) * d.spread * 0.06, rest.y + d.spread * 0.04, rest.z);
        });

        bodyGroup.rotation.x = curl * 0.15;

        // Every ember glow gutters dark as the coal goes cold.
        glowMat.emissiveIntensity = Math.max(0, 1.1 * (1 - dying));
        shadeMat.emissiveIntensity = Math.max(0, 0.35 * (1 - dying));
        eyeMat.emissiveIntensity = Math.max(0, 1.4 * (1 - dying));
        return; // death pose overrides everything below
      }

      // Reset root transforms in case a previous frame was mid-dissolve and
      // the mob got revived/recycled (defensive; animate() must never
      // assume ordering with the mob manager's own lifecycle).
      if (root.scale.x !== 1) root.scale.set(1, 1, 1);
      root.rotation.z = 0;
      root.rotation.x = 0;
      root.position.y = 0;

      // ---- Idle: abdomen breathing pulse + cephalothorax scan -----------
      const breatheAmt = rig.breathe(time, 1.2, 1.3);
      bodyGroup.scale.set(1 + breatheAmt * 0.5, 1 + breatheAmt, 1 + breatheAmt * 0.5);
      abdomenUnderside.scale.set(1 / (1 + breatheAmt * 0.5), 1, 1 / (1 + breatheAmt * 0.5));

      const idleAmt = 1 - speed01;
      const scan = rig.sway(time, 1.0, 0.6, 0) * idleAmt;
      cephalothorax.rotation.y = scan * 0.5 + lean * 0.2;
      browPlate.rotation.x = rig.sway(time, 0.6, 1.4, 0.4) * idleAmt * 0.3;

      // Abdomen pulse-glow — molten forge-coal breathing, flaring brighter
      // with telegraph/attack/fuse and spiking sharply on hurt.
      const pulse = 0.7 + Math.sin(time * 2.4) * 0.4 + Math.max(0, Math.sin(time * 9.5)) * 0.15;
      const hurtFlare = hurt > 0 ? Math.abs(Math.sin(time * 32)) * 0.9 * hurt : 0;
      glowMat.emissiveIntensity = Math.max(0.35, pulse + hurtFlare + telegraph * 0.5 + attack * 0.6 + fuse * 0.6);
      shadeMat.emissiveIntensity = 0.3 + pulse * 0.15 + hurtFlare * 0.3;
      eyeMat.emissiveIntensity = 1.2 + Math.sin(time * 5.2) * 0.3 + hurtFlare * 0.6 + telegraph * 0.3;

      // Ridge spikes ride the breathing pulse subtly, like coals shifting.
      ridgeSpikes.forEach((sp, i) => {
        const rest = spikeRest[i];
        sp.position.y = rest.y + breatheAmt * 0.15;
      });
      abdomenPuffs.forEach((p, i) => {
        const rest = puffRest[i];
        p.position.y = rest.y + breatheAmt * 0.3;
      });

      // Chelicerae idle chatter — quick nervous open/close, faster/wider
      // when hurt or fused-up, always at least a little restless.
      const chatterRate = 6.0 + hurt * 8.0 + fuse * 4.0;
      const chatterOpen = (Math.sin(time * chatterRate) * 0.5 + 0.5) * 0.3;
      cheliceraL.pivot.rotation.z = -chatterOpen - 0.05;
      cheliceraR.pivot.rotation.z = chatterOpen + 0.05;

      // Web threads drift lazily behind the abdomen, streaming back a
      // little more with speed.
      const stream = speed01 * 0.25;
      webThreads.forEach((th, i) => {
        th.rotation.x = 0.95 + Math.sin(time * 1.3 + i * 1.7) * 0.14 + stream;
        th.rotation.z = threadDefs[i].rz + Math.sin(time * 1.1 + i) * 0.06;
      });

      // ---- Locomotion: true 8-leg alternating-tetrapod skitter ----------
      // rig.walkPhase's FR/FL are already an antiphase diagonal pair — used
      // directly as the two criss-crossed leg groups (see LEG_DEFS.group).
      const strideFreq = 3.2 + fuse * 1.5 + phase * 0.6;
      const walk = rig.walkPhase(time, speed01, strideFreq);
      const groupVal = [walk.FR, walk.FL];

      const microSpeed = 9.0; // constant fine jitter, even fully idle/still

      legs.forEach((leg, i) => {
        const reach = groupVal[leg.group];
        const microJitter = Math.sin(time * microSpeed + i * 0.9) * 0.04 * (0.4 + idleAmt * 0.6);

        // Foot lifts during its forward reach (positive swing), drags flat
        // and low during its planted backward stroke (negative swing).
        const liftRaw = Math.max(0, reach);

        leg.hipPivot.rotation.x = reach + microJitter;
        leg.kneePivot.rotation.x = -liftRaw * 1.0;
        leg.anklePivot.rotation.x = liftRaw * 0.65;

        // Lean into turns: outer-side legs (relative to turn direction)
        // splay a touch wider for a believable weight shift.
        leg.hipPivot.rotation.z = leg.side * A1 - lean * leg.side * 0.12;
      });

      // Slight full-body bob timed to footfalls, plus forward hunch scaled
      // with speed for a scuttling, predatory read.
      let bodyY = breatheAmt * 0.5;
      bodyY += walk.lift * 0.05;
      bodyGroup.rotation.x = -0.04 - speed01 * 0.05;
      bodyGroup.rotation.z = lean * 0.5;

      // ---- Telegraph (rear front legs) / attack (whip-crack lunge) ------
      const wind = rig.windUp(telegraph); // 0 -> ~-1.1 -> -1
      const strikeAmt = rig.strike(attack); // 0 -> 1, fast release

      legs.forEach((leg) => {
        if (leg.pairIndex !== 0) return; // only the front pair (FR/FL) rears
        leg.hipPivot.rotation.x += wind * 0.9 - strikeAmt * 1.15;
        leg.kneePivot.rotation.x += -wind * 0.5 + strikeAmt * 0.55;
      });
      cheliceraL.pivot.rotation.x = -wind * 0.35 + strikeAmt * 0.5;
      cheliceraR.pivot.rotation.x = -wind * 0.35 + strikeAmt * 0.5;
      cheliceraL.hookPivot.rotation.x = -wind * 0.3 + strikeAmt * 0.9;
      cheliceraR.hookPivot.rotation.x = -wind * 0.3 + strikeAmt * 0.9;
      cephalothorax.rotation.x = -wind * 0.15 + strikeAmt * 0.25;
      bodyGroup.rotation.x += -wind * 0.1 + strikeAmt * 0.18;

      // ---- Hurt flinch: sharp, fast-decaying jolt across the body -------
      flinch = rig.damp(flinch, hurt, 20, dt || 0.016);
      if (flinch > 0.001) {
        bodyGroup.rotation.z += Math.sin(time * 42) * 0.16 * flinch;
        bodyY += Math.abs(Math.sin(time * 55)) * -0.03 * flinch;
        legs.forEach((leg, i) => {
          leg.kneePivot.rotation.x += Math.sin(time * 40 + i) * 0.09 * flinch;
        });
      }

      bodyGroup.position.y = 0.44 + bodyY;
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
    }
  };

  // Feet-at-y0 sanity: verified via a standalone THREE.js world-matrix
  // check with these exact HIP_Y/UPPER_LEN/LOWER_LEN/FOOT_LEN/A1/A2_DELTA/
  // A3_DELTA constants — every foot tip lands within ~0.001 units of y=0
  // across all four yaw values, so it is not re-derived by hand here.

  return root;
}

export const meta = {
  archetype: 'groaner',
  species: 'Emberspinner',
  canonicalId: 'emberspinner',
  dimensionDefault: 'cinderloom',
  palette: {
    carapace: '#3A1108',
    abdomenGlow: '#D94F1E',
    abdomenShade: '#8C2B12',
    eye: '#F2A03D',
    webThread: '#FFD98C',
  },
  description:
    'A fast, fragile fire spider-weaver bred in the Cinderloom forges — a ' +
    'coal dragged up from the forge floor and given eight legs. A small ' +
    'charred-carapace cephalothorax with a raised brow-plate and hooked ' +
    'chelicerae rides in front of a bulbous, molten-glowing abdomen ridged ' +
    'with darker ember-shade spikes and trailing pale web-threads from a ' +
    'spinneret cluster at the tail. Eight thin, angular legs, each cinched ' +
    'at the knee with a pale thread-wrap band, splay wide and low from its ' +
    'sides and skitter in a true alternating-tetrapod gait — four legs ' +
    'always planted while the opposite diagonal quartet swings forward. It ' +
    'rears its front legs to telegraph a strike before snapping them down ' +
    'in a whip-crack lunge, and when killed curls tight before unraveling ' +
    'into loose thread and cooling embers.',
};
