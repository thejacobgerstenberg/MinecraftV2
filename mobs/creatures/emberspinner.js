import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Emberspinner — a hostile, fast/fragile fire spider-weaver of the Cinderloom
// forges. Archetype: groaner (fast, low-HP base)
//
// Silhouette goals (per design brief): a round GLOWING ABDOMEN behind a
// smaller cephalothorax, EIGHT thin angular legs (four per side, each a
// three-box jointed limb) splayed wide for a low stance, a small cluster of
// glowing ember eyes, and short ember-web mandibles up front. ~0.6 units
// tall, wide legspan (~1.0 across). This is deliberately NOT a Minecraft
// spider — no fat single-cube body on short stub legs. The abdomen pulses
// with molten Thrum-glow like a coal dragged up from the forge floor, and
// the legs are long, thin, and radiate outward like spokes.
// ---------------------------------------------------------------------------

const PALETTE = {
  carapace: 0x2e211c, // charred carapace — body & legs
  abdomenGlow: 0xff6a1a, // molten abdomen glow (emissive, pulses)
  eye: 0xffd27a, // ember eyes (emissive)
  webThread: 0xc97a3a, // faint web-thread trailing strands
};

function makeMaterials() {
  return {
    carapace: new THREE.MeshStandardMaterial({
      color: PALETTE.carapace,
      roughness: 0.85,
      metalness: 0.15,
    }),
    abdomenGlow: new THREE.MeshStandardMaterial({
      color: PALETTE.abdomenGlow,
      roughness: 0.5,
      metalness: 0.05,
      emissive: new THREE.Color(PALETTE.abdomenGlow),
      emissiveIntensity: 1.1,
    }),
    eye: new THREE.MeshStandardMaterial({
      color: PALETTE.eye,
      roughness: 0.3,
      metalness: 0.0,
      emissive: new THREE.Color(PALETTE.eye),
      emissiveIntensity: 1.4,
    }),
    webThread: new THREE.MeshStandardMaterial({
      color: PALETTE.webThread,
      roughness: 0.9,
      metalness: 0.0,
    }),
  };
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

  const mat = makeMaterials();
  const parts = {};

  // -------------------------------------------------------------------
  // BODY — small cephalothorax up front, larger glowing abdomen behind.
  // -------------------------------------------------------------------
  const HIP_Y = 0.38; // leg attachment height above the ground

  const bodyGroup = new THREE.Group();
  bodyGroup.position.set(0, 0.42, 0);
  root.add(bodyGroup);

  // Cephalothorax — smaller, forward.
  const cephGeo = new THREE.BoxGeometry(0.17, 0.15, 0.18);
  const cephalothorax = new THREE.Mesh(cephGeo, mat.carapace);
  cephalothorax.position.set(0, -0.02, 0.16);
  bodyGroup.add(cephalothorax);

  // Narrow waist/pedicel joining ceph to abdomen.
  const waistGeo = new THREE.BoxGeometry(0.07, 0.07, 0.05);
  const waist = new THREE.Mesh(waistGeo, mat.carapace);
  waist.position.set(0, -0.02, 0.05);
  bodyGroup.add(waist);

  // Abdomen — round glowing mass built as a core plus overlapping chamfer
  // puffs so the silhouette reads bulbous/round rather than a plain box.
  const abdomenCoreGeo = new THREE.BoxGeometry(0.26, 0.22, 0.28);
  const abdomenCore = new THREE.Mesh(abdomenCoreGeo, mat.abdomenGlow);
  abdomenCore.position.set(0, 0.02, -0.16);
  bodyGroup.add(abdomenCore);

  const abdomenPuffDefs = [
    { size: [0.14, 0.16, 0.14], pos: [0.1, 0.04, -0.06] },
    { size: [0.14, 0.16, 0.14], pos: [-0.1, 0.04, -0.06] },
    { size: [0.12, 0.14, 0.12], pos: [0.09, 0.02, -0.27] },
    { size: [0.12, 0.14, 0.12], pos: [-0.09, 0.02, -0.27] },
    { size: [0.2, 0.1, 0.16], pos: [0, 0.12, -0.16] }, // top cap
    { size: [0.2, 0.1, 0.16], pos: [0, -0.09, -0.16] }, // bottom cap
  ];
  const abdomenPuffs = abdomenPuffDefs.map(({ size, pos }) => {
    const m = box(size[0], size[1], size[2], mat.abdomenGlow);
    m.position.set(pos[0], pos[1], pos[2]);
    bodyGroup.add(m);
    return m;
  });

  // Ember eye cluster on the front of the cephalothorax.
  const eyeGeo = new THREE.BoxGeometry(0.025, 0.025, 0.02);
  const eyeOffsets = [
    [0, 0.03, 0.095],
    [0.045, 0.02, 0.09],
    [-0.045, 0.02, 0.09],
    [0.02, -0.01, 0.09],
    [-0.02, -0.01, 0.09],
  ];
  const eyes = eyeOffsets.map(([x, y, z]) => {
    const m = new THREE.Mesh(eyeGeo, mat.eye);
    m.castShadow = true;
    m.receiveShadow = true;
    m.position.set(x, y, z);
    cephalothorax.add(m);
    return m;
  });

  // Short ember-web mandibles — two angled boxes hinged at the front of
  // the cephalothorax, tips tinted with the ember glow material.
  function buildMandible(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.06, -0.04, 0.09);
    pivot.rotation.y = side * 0.35;
    cephalothorax.add(pivot);

    const base = hangingBox(0.03, 0.08, 0.03, mat.carapace);
    base.rotation.x = -0.5;
    pivot.add(base);

    const tip = hangingBox(0.02, 0.04, 0.02, mat.eye);
    tip.position.set(0, -0.075, 0.03);
    tip.rotation.x = -0.3;
    pivot.add(tip);

    return { pivot, base, tip };
  }
  const mandibleL = buildMandible(-1);
  const mandibleR = buildMandible(1);

  // Faint web-thread strands trailing off the rear of the abdomen — flavor
  // for the "weaver" half of the creature's name.
  const threadDefs = [
    { pos: [0.06, -0.02, -0.29], rz: 0.3 },
    { pos: [-0.06, -0.02, -0.29], rz: -0.3 },
  ];
  const webThreads = threadDefs.map(({ pos, rz }) => {
    const t = hangingBox(0.015, 0.18, 0.015, mat.webThread);
    t.position.set(pos[0], pos[1], pos[2]);
    t.rotation.x = 0.9; // trail out behind, roughly horizontal
    t.rotation.z = rz;
    bodyGroup.add(t);
    return t;
  });

  parts.bodyGroup = bodyGroup;
  parts.cephalothorax = cephalothorax;
  parts.abdomenCore = abdomenCore;
  parts.abdomenPuffs = abdomenPuffs;
  parts.eyes = eyes;
  parts.mandibleL = mandibleL;
  parts.mandibleR = mandibleR;
  parts.webThreads = webThreads;

  // Head anchor for name tags — above the abdomen/cephalothorax mass.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, 0.66, 0.1);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // LEGS — eight thin, angular, three-segment limbs (four per side),
  // splayed outward and slightly forward/back for a wide, low stance.
  // Each leg is a chain: hip pivot (splay + yaw) -> upper segment ->
  // knee pivot -> lower segment -> ankle pivot -> foot tip segment.
  // -------------------------------------------------------------------
  const UPPER_LEN = 0.16;
  const LOWER_LEN = 0.24;
  const FOOT_LEN = 0.09;
  const A1 = 1.05; // hip: mostly-outward splay angle from vertical
  const A2_DELTA = -0.55; // knee: bends back toward vertical
  const A3_DELTA = -0.32; // ankle: straightens further to reach the ground

  const LEG_DEFS = [
    { side: 1, z: 0.15, yaw: 0.5, tag: 'FR' },
    { side: 1, z: 0.05, yaw: 0.15, tag: 'MFR' },
    { side: 1, z: -0.05, yaw: -0.15, tag: 'MBR' },
    { side: 1, z: -0.15, yaw: -0.5, tag: 'BR' },
    { side: -1, z: 0.15, yaw: -0.5, tag: 'FL' },
    { side: -1, z: 0.05, yaw: -0.15, tag: 'MFL' },
    { side: -1, z: -0.05, yaw: 0.15, tag: 'MBL' },
    { side: -1, z: -0.15, yaw: 0.5, tag: 'BL' },
  ];

  function buildLeg({ side, z, yaw }) {
    const hipPivot = new THREE.Group();
    hipPivot.position.set(side * 0.1, HIP_Y, z);
    hipPivot.rotation.y = yaw;
    hipPivot.rotation.z = side * A1;
    root.add(hipPivot);

    const upper = hangingBox(0.035, UPPER_LEN, 0.035, mat.carapace);
    hipPivot.add(upper);

    const kneePivot = new THREE.Group();
    kneePivot.position.set(0, -UPPER_LEN, 0);
    kneePivot.rotation.z = side * A2_DELTA;
    hipPivot.add(kneePivot);

    const lower = hangingBox(0.028, LOWER_LEN, 0.028, mat.carapace);
    kneePivot.add(lower);

    const anklePivot = new THREE.Group();
    anklePivot.position.set(0, -LOWER_LEN, 0);
    anklePivot.rotation.z = side * A3_DELTA;
    kneePivot.add(anklePivot);

    const foot = hangingBox(0.02, FOOT_LEN, 0.02, mat.carapace);
    anklePivot.add(foot);

    return { hipPivot, kneePivot, anklePivot, upper, lower, foot, side, z };
  }

  const legs = LEG_DEFS.map(buildLeg);
  parts.legs = legs;

  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION
  // Idle: constant fast 8-leg micro-skitter (small independent per-leg
  //       jitter, never fully still) + abdomen pulse-glow.
  // Walk: alternating-tetrapod skitter — legs split into two sets of
  //       four that swing in opposing phase.
  // Attack/threat: front legs rear up (driven by state.attack if the
  //       host provides it, plus a periodic self-triggered threat rear
  //       so the creature always reads as aggressive and lively).
  // -------------------------------------------------------------------
  root.userData.animate = (t, state) => {
    const s = state || {};
    const moving = !!s.moving;
    const hurt = s.hurt || 0;
    const attackDrive = s.attack || 0;

    // Idle breathing / abdomen bob — always active.
    const breathe = Math.sin(t * 3.2);
    bodyGroup.position.y = 0.42 + breathe * 0.008;
    bodyGroup.rotation.z = Math.sin(t * 1.4) * 0.015;

    // Abdomen pulse-glow — molten forge-coal breathing.
    const pulse = 0.75 + Math.sin(t * 2.2) * 0.45 + Math.max(0, Math.sin(t * 9)) * 0.15;
    mat.abdomenGlow.emissiveIntensity = Math.max(0.3, pulse - hurt * 0.3);
    mat.eye.emissiveIntensity = 1.2 + Math.sin(t * 5.0) * 0.3;

    // Mandible chatter — quick nervous open/close, faster when hurt.
    const mandibleRate = 6.0 + hurt * 8.0;
    const mandibleOpen = (Math.sin(t * mandibleRate) * 0.5 + 0.5) * 0.35;
    mandibleL.pivot.rotation.z = -mandibleOpen;
    mandibleR.pivot.rotation.z = mandibleOpen;

    // Web threads drift lazily behind the abdomen.
    webThreads.forEach((th, i) => {
      th.rotation.x = 0.9 + Math.sin(t * 1.3 + i * 1.7) * 0.12;
    });

    // Periodic self-triggered "threat rear" of the front legs, layered
    // on top of everything else, plus explicit attack-state drive.
    const rearCycle = t % 4.5;
    let rear = rearCycle < 0.5 ? Math.sin((rearCycle / 0.5) * Math.PI) : 0;
    rear = Math.max(rear, attackDrive);

    // Gait speed: fast, fragile skitterer.
    const gaitSpeed = moving ? 14.0 : 0.0;
    const microSpeed = 10.0; // constant fine jitter, even when idle/still

    legs.forEach((leg, i) => {
      // Two alternating sets of four for the tetrapod skitter gait.
      const setPhase = i % 2 === 0 ? 0 : Math.PI;
      const stridePhase = t * gaitSpeed + setPhase;

      const stepLift = moving ? Math.max(0, Math.sin(stridePhase)) * 0.55 : 0;
      const stepReach = moving ? Math.sin(stridePhase) * 0.3 : 0;

      // Constant micro-skitter jitter — small, per-leg-phased, never zero.
      const jitterPhase = i * 0.9;
      const microJitter = Math.sin(t * microSpeed + jitterPhase) * 0.05;

      leg.hipPivot.rotation.x = stepReach + microJitter;
      leg.kneePivot.rotation.x = -stepLift * 0.6;
      leg.anklePivot.rotation.x = stepLift * 0.4;

      // Front two legs (FR, FL) rear up on the threat/attack pulse.
      if (i === 0 || i === 4) {
        leg.hipPivot.rotation.x += -rear * 1.1;
        leg.kneePivot.rotation.x += -rear * 0.6;
      }

      // Hurt flinch — a sharp jittery buckle across all legs.
      if (hurt > 0) {
        leg.kneePivot.rotation.x += Math.sin(t * 40 + i) * 0.08 * hurt;
      }
    });

    // Slight full-body bob while skittering, plus a lower forward-hunched
    // crouch when rearing to threaten.
    if (moving) {
      bodyGroup.position.y += Math.abs(Math.sin(t * gaitSpeed)) * 0.015;
    }
    bodyGroup.rotation.x = -0.05 - rear * 0.22;
    bodyGroup.position.y -= rear * 0.03;
  };

  return root;
}

export const meta = {
  archetype: 'groaner',
  species: 'Emberspinner',
  dimensionDefault: 'cinderloom',
  palette: {
    carapace: '#2E211C',
    abdomenGlow: '#FF6A1A',
    eye: '#FFD27A',
    webThread: '#C97A3A',
  },
  description:
    'A fast, fragile fire spider-weaver bred in the Cinderloom forges. A ' +
    'small charred-carapace cephalothorax rides in front of a round, ' +
    'molten-glowing abdomen that pulses like a dragged forge coal. Eight ' +
    'thin, angular legs splay wide and low from its sides, skittering in ' +
    'an alternating tetrapod gait, while a cluster of ember eyes and a pair ' +
    'of short web-spun mandibles chatter at the front. Faint web-thread ' +
    'strands trail from its abdomen as it moves.',
};
