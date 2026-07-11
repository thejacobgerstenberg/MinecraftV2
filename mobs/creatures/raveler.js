import * as THREE from 'three';

// ---------------------------------------------------------------------------
// RAVELER — a fast, boneless Nevermend hostile summoned by the Last Needle.
// Archetype: groaner base (reworked into a low, legless drifter). Loomfall
// lore: when a length of the Weaver's yarn slips entirely off the Loom and
// falls into the Nevermend void, it never settles into a shape the Weaver
// intended. It coils on itself instead, knotting its loose end into a single
// dark, glowing void-knot "head" and trailing the rest of itself behind as a
// limbless, undulating ribbon of thread. Ravelers drift low over the void,
// unpicking blocks and items wherever they pass, and surge in fast to strike
// whenever the Last Needle calls them in.
//
// Silhouette goals: NO arms, NO legs — a vertical, tapering chain of loose
// woven segments that undulates like a serpent stood on end, topped by a
// single void-knot head with a faint glowing core, with wispy loose
// thread-ends trailing off the body and tip. ~1.1 units tall overall. Reads
// nothing like a Minecraft mob — a hovering thread-serpent, not a biped.
// ---------------------------------------------------------------------------

const PALETTE = {
  main: 0x2e2440,      // void indigo — head knot + core body mass
  segment: 0x4b3a6e,    // mid violet — chain segments
  highlight: 0x8a76b8,  // pale violet — thread highlights / wisps
  shadow: 0x120d1f,     // near-black — knot-head shadow / underside
  glow: 0xc9bbe8,       // cold glow — emissive core
};

function makeMaterials() {
  return {
    main: new THREE.MeshStandardMaterial({
      color: PALETTE.main,
      roughness: 0.85,
      metalness: 0.05,
    }),
    segment: new THREE.MeshStandardMaterial({
      color: PALETTE.segment,
      roughness: 0.8,
      metalness: 0.05,
    }),
    highlight: new THREE.MeshStandardMaterial({
      color: PALETTE.highlight,
      roughness: 0.6,
      metalness: 0.05,
    }),
    shadow: new THREE.MeshStandardMaterial({
      color: PALETTE.shadow,
      roughness: 0.9,
      metalness: 0.0,
    }),
    glow: new THREE.MeshStandardMaterial({
      color: PALETTE.glow,
      roughness: 0.3,
      metalness: 0.0,
      emissive: new THREE.Color(PALETTE.glow),
      emissiveIntensity: 0.9,
    }),
  };
}

// Box mesh whose origin sits at its TOP center, so segments and threads can
// hang naturally off a joint pivot — used for the entire vertical chain.
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
  root.name = 'Raveler';

  const mat = makeMaterials();
  const parts = {};

  // -------------------------------------------------------------------
  // The Raveler hovers rather than stands, but the contract requires
  // feet-at-y0 for the resting pose; the trailing thread-ends reach
  // down to y=0 and root.position.y bobs above that in animate().
  // -------------------------------------------------------------------
  const HEAD_TOP_Y = 1.10;

  // -------------------------------------------------------------------
  // VOID-KNOT HEAD — a single dense knot of thread with a faint glowing
  // core visible through a seam in the knot.
  // -------------------------------------------------------------------
  const headPivot = new THREE.Group();
  headPivot.position.set(0, HEAD_TOP_Y, 0);
  root.add(headPivot);

  const knot = hangingBox(0.24, 0.22, 0.22, mat.main);
  headPivot.add(knot);

  // Shadowed underside seam of the knot, where the loose end feeds out.
  const knotSeam = box(0.20, 0.05, 0.20, mat.shadow);
  knotSeam.position.set(0, -0.20, 0);
  headPivot.add(knotSeam);

  // Faint glowing core, nested inside the knot, pulses in animate().
  const core = box(0.09, 0.09, 0.09, mat.glow);
  core.position.set(0, -0.11, 0.09);
  headPivot.add(core);

  // Small highlight wisps bristling off the knot itself.
  const knotWispL = hangingBox(0.015, 0.09, 0.015, mat.highlight);
  knotWispL.rotation.z = Math.PI; // point up off the knot
  knotWispL.position.set(-0.10, -0.02, -0.08);
  headPivot.add(knotWispL);
  const knotWispR = hangingBox(0.015, 0.07, 0.015, mat.highlight);
  knotWispR.rotation.z = Math.PI;
  knotWispR.position.set(0.10, -0.02, -0.08);
  headPivot.add(knotWispR);

  parts.headPivot = headPivot;
  parts.core = core;

  // Head anchor for name tags — above the void-knot.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, HEAD_TOP_Y + 0.18, 0);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // BODY CHAIN — a tapering vertical stack of loose woven segments, each
  // parented to a pivot hanging off the previous, so undulation applied
  // to the chain cascades naturally like a suspended serpent.
  // -------------------------------------------------------------------
  const segmentDefs = [
    { w: 0.20, h: 0.16, d: 0.20, mat: mat.segment },
    { w: 0.18, h: 0.15, d: 0.18, mat: mat.main },
    { w: 0.15, h: 0.14, d: 0.15, mat: mat.segment },
    { w: 0.12, h: 0.13, d: 0.12, mat: mat.main },
    { w: 0.09, h: 0.12, d: 0.09, mat: mat.segment },
  ];

  const segments = [];
  let parent = headPivot;
  let cursorY = -0.22; // just below the knot, in the parent's local space
  segmentDefs.forEach((def, i) => {
    const pivot = new THREE.Group();
    pivot.position.set(0, cursorY, 0);
    parent.add(pivot);

    const seg = hangingBox(def.w, def.h, def.d, def.mat);
    pivot.add(seg);

    // A thin pale-violet highlight strip along the front of each segment,
    // reading as loose weave catching the cold glow of the core.
    const stripe = hangingBox(def.w * 0.25, def.h * 0.9, 0.01, mat.highlight);
    stripe.position.set(0, -0.02, def.d / 2 + 0.006);
    pivot.add(stripe);

    segments.push({ pivot, seg });
    parent = pivot;
    cursorY = -def.h;
  });
  parts.segments = segments;

  // -------------------------------------------------------------------
  // TRAILING THREAD-ENDS — wispy loose strands hanging off the tail tip,
  // dangling down toward y=0, wavering independently.
  // -------------------------------------------------------------------
  const tailPivot = segments[segments.length - 1].pivot;
  const threadDefs = [
    { x: -0.03, z: 0.02, h: 0.16, w: 0.015 },
    { x: 0.0, z: -0.01, h: 0.20, w: 0.018 },
    { x: 0.035, z: 0.015, h: 0.14, w: 0.014 },
  ];
  const threads = threadDefs.map(({ x, z, h, w }) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, -segmentDefs[segmentDefs.length - 1].h, z);
    tailPivot.add(pivot);
    const strand = hangingBox(w, h, w, mat.highlight);
    pivot.add(strand);
    return pivot;
  });
  parts.threads = threads;

  // -------------------------------------------------------------------
  // Store all animated sub-parts for animate() to reach.
  // -------------------------------------------------------------------
  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION
  // Idle: continuous sinuous undulation cascades down the segment chain,
  //       trailing threads waver with wider lag, core pulses, whole body
  //       hovers with a slow bob and lazy yaw drift.
  // Walk: faster, tighter undulation, forward lean, quicker hover bob —
  //       reads as a fast low drift toward the target.
  // Attack: head/knot lunges forward and down sharply, then eases back.
  // Hurt: sharp full-body jolt/flinch, core flares brighter.
  // -------------------------------------------------------------------
  root.userData.animate = (t, state) => {
    const s = state || {};
    const moving = !!s.moving;
    const hurt = s.hurt || 0;
    const attack = s.attack || 0;

    const speed = moving ? 6.5 : 2.2;
    const amp = moving ? 0.32 : 0.16;

    // Hover bob + lazy yaw drift — the Raveler never truly rests.
    const bobSpeed = moving ? 5.0 : 1.8;
    root.position.y = 0.06 + Math.sin(t * bobSpeed) * (moving ? 0.02 : 0.035);
    root.rotation.y = Math.sin(t * (moving ? 1.6 : 0.6)) * (moving ? 0.25 : 0.4);

    // Forward lean of the whole chain while closing in on a target.
    const leanTarget = moving ? 0.28 : 0.0;
    root.rotation.x += (leanTarget - root.rotation.x) * 0.08;

    // Sinuous undulation cascades down the chain — each segment sways in
    // X and Z with a phase offset from the last, like a hung serpent.
    segments.forEach(({ pivot }, i) => {
      const phase = i * 0.85;
      pivot.rotation.z = Math.sin(t * speed - phase) * amp * (0.5 + i * 0.12);
      pivot.rotation.x = Math.cos(t * speed * 0.8 - phase) * amp * 0.35;
    });

    // The knot-head itself sways gently, leading the undulation.
    headPivot.rotation.z = Math.sin(t * speed) * amp * 0.4;

    // Trailing thread-ends waver wider and with more lag than the body.
    threads.forEach((pivot, i) => {
      const phase = i * 1.3 + 2.0;
      pivot.rotation.z = Math.sin(t * speed * 0.9 - phase) * (amp * 1.6);
      pivot.rotation.x = Math.cos(t * speed * 0.7 - phase) * (amp * 1.1);
    });

    // Core pulse — a slow cold-glow heartbeat, quickening under threat.
    const pulseSpeed = 2.0 + hurt * 6.0 + attack * 4.0;
    const pulse = 0.55 + Math.sin(t * pulseSpeed) * 0.35;
    core.material.emissiveIntensity = pulse + hurt * 0.6 + attack * 0.4;

    // Attack — the void-knot lunges forward and down sharply, then eases.
    if (attack > 0) {
      const strike = Math.sin(Math.min(attack, 1) * Math.PI);
      headPivot.position.z = strike * 0.22;
      headPivot.position.y = HEAD_TOP_Y - strike * 0.10;
      headPivot.rotation.x = strike * 0.5;
    } else {
      headPivot.position.z += (0 - headPivot.position.z) * 0.25;
      headPivot.position.y += (HEAD_TOP_Y - headPivot.position.y) * 0.25;
      headPivot.rotation.x += (0 - headPivot.rotation.x) * 0.25;
    }

    // Hurt — a sharp full-chain jolt/flinch.
    if (hurt > 0) {
      root.rotation.z = Math.sin(t * 34) * hurt * 0.2;
      headPivot.scale.setScalar(1 + hurt * 0.12);
    } else {
      root.rotation.z *= 0.7;
      headPivot.scale.setScalar(1 + (headPivot.scale.x - 1) * 0.7);
    }
  };

  return root;
}

export const meta = {
  archetype: 'groaner',
  species: 'Raveler',
  canonicalId: 'raveler',
  dimensionDefault: 'nevermend',
  palette: {
    main: '#2E2440',
    segment: '#4B3A6E',
    highlight: '#8A76B8',
    shadow: '#120D1F',
    glow: '#C9BBE8',
  },
  description:
    'A fast, boneless hostile of the Nevermend, knotted from a length of ' +
    'the Weaver\'s yarn that slipped entirely off the Loom and fell into ' +
    'the void. Armless and legless, it is a tapering, undulating chain of ' +
    'loose woven segments topped by a single dark void-knot head with a ' +
    'faint glowing core, wispy thread-ends trailing from its body and tip. ' +
    'It drifts low over the void, unpicking blocks and items as it passes, ' +
    'and surges in fast whenever the Last Needle summons it to strike.',
};
