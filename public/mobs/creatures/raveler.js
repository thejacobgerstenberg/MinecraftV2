import * as THREE from 'three';
import * as rig from '../anim/rig.js';

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
// woven segments that undulates like a serpent stood on end, topped by an
// asymmetric, TWO-LOBED void-knot head (never a plain cube) wound with
// diagonal thread wraps and trailing a single stray loose end, with a faint
// glowing core visible through a seam. A pair of small broken-thread barbs
// poke sideways mid-chain, and the chain itself carries a light baked twist
// so it reads as a wrung, corkscrewed rope even holding still. ~1.1 units
// tall overall. Reads nothing like a Minecraft mob — a hovering, tangled
// thread-serpent, not a biped.
// ---------------------------------------------------------------------------

// Canonical Raveler bestiary palette — all five hexes used as materials.
const PALETTE = {
  main: 0x2e2440,      // void indigo — head knot + core body mass
  segment: 0x4b3a6e,    // mid violet — chain segments + second knot lobe
  highlight: 0x8a76b8,  // pale violet — thread highlights / wraps / wisps
  shadow: 0x120d1f,     // near-black — knot-head shadow, stray thread, barb
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

// Defensive numeric coercion — animate() must never throw or propagate NaN.
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
  root.name = 'Raveler';

  const mat = makeMaterials();
  const parts = {};

  // -------------------------------------------------------------------
  // The Raveler hovers rather than stands, but the contract requires
  // feet-at-y0 for the resting pose; the trailing thread-ends reach down
  // to y=0 and root.position.y bobs above that in animate().
  // -------------------------------------------------------------------
  const HEAD_TOP_Y = 1.10;
  const HOVER_Y = 0.06;

  // -------------------------------------------------------------------
  // VOID-KNOT HEAD — an asymmetric, two-lobed knot of thread wound with
  // diagonal wrap strips, a faint glowing core visible through a seam, and
  // a single stray loose end drooping off to one side (breaking the mirror
  // symmetry the paired wisps would otherwise leave).
  // -------------------------------------------------------------------
  const headPivot = new THREE.Group();
  headPivot.position.set(0, HEAD_TOP_Y, 0);
  root.add(headPivot);

  const knot = hangingBox(0.24, 0.22, 0.22, mat.main);
  headPivot.add(knot);

  // Second, smaller knot lobe overlapping the main knot off to one side —
  // the single biggest silhouette upgrade: breaks the perfect-cube read
  // into an asymmetric tangled knot, reading as "knotted" even at
  // thumbnail size.
  const knotLobe = box(0.15, 0.13, 0.15, mat.segment);
  knotLobe.position.set(0.09, -0.06, 0.03);
  knotLobe.rotation.y = 0.5;
  headPivot.add(knotLobe);

  // Diagonal wrap strips — thin highlight bands crossing the knot like
  // wound yarn, the clearest "this is a knot of thread, not a rock" cue.
  const wrapA = box(0.30, 0.03, 0.03, mat.highlight);
  wrapA.position.set(0, -0.09, 0.0);
  wrapA.rotation.z = 0.55;
  headPivot.add(wrapA);
  const wrapB = box(0.27, 0.025, 0.025, mat.highlight);
  wrapB.position.set(0.01, -0.14, 0.02);
  wrapB.rotation.z = -0.5;
  wrapB.rotation.x = 0.3;
  headPivot.add(wrapB);

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

  // Stray loose thread-end drooping off the side of the knot — a single
  // wisp escaping the tangle, asymmetric against the neat mirrored pair
  // above, pivoted so it can droop and drift independently in animate().
  const strayPivot = new THREE.Group();
  strayPivot.position.set(-0.13, -0.07, -0.02);
  strayPivot.rotation.z = -0.35;
  headPivot.add(strayPivot);
  const strayThread = hangingBox(0.014, 0.15, 0.014, mat.shadow);
  strayPivot.add(strayThread);

  parts.headPivot = headPivot;
  parts.core = core;
  parts.strayPivot = strayPivot;

  // Head anchor for name tags — above the void-knot.
  const headAnchor = new THREE.Object3D();
  headAnchor.position.set(0, HEAD_TOP_Y + 0.18, 0);
  root.add(headAnchor);
  root.userData.headAnchor = headAnchor;

  // -------------------------------------------------------------------
  // BODY CHAIN — a tapering vertical stack of loose woven segments, each
  // parented to a pivot hanging off the previous, so undulation applied to
  // the chain cascades naturally like a suspended serpent. Each pivot
  // carries a small baked alternating twist so the resting chain reads as
  // a lightly wrung, corkscrewed rope rather than a perfectly stacked tube.
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
    pivot.rotation.y = (i % 2 === 0 ? 1 : -1) * (0.16 + i * 0.03);
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
  // BARBS — a pair of small broken-thread nubs poking sideways off
  // alternating segments, asymmetric secondary detail that reads as loose
  // frayed ends caught mid-chain rather than a smooth uniform tube.
  // -------------------------------------------------------------------
  const barbs = [];
  function addBarb(segIndex, side, material, len) {
    const hostPivot = segments[segIndex].pivot;
    const def = segmentDefs[segIndex];
    const pivot = new THREE.Group();
    pivot.position.set(side * def.w * 0.5, -def.h * 0.4, 0);
    pivot.rotation.z = side * 1.3;
    hostPivot.add(pivot);
    const barb = hangingBox(0.014, len, 0.014, material);
    pivot.add(barb);
    barbs.push(pivot);
  }
  addBarb(1, -1, mat.highlight, 0.09);
  addBarb(3, 1, mat.shadow, 0.07);
  parts.barbs = barbs;

  // -------------------------------------------------------------------
  // TRAILING THREAD-ENDS — wispy loose strands hanging off the tail tip,
  // dangling down toward y=0, wavering independently. Mixed materials so
  // the frayed tip reads as several loose colors rather than one flat tone.
  // -------------------------------------------------------------------
  const tailPivot = segments[segments.length - 1].pivot;
  const lastH = segmentDefs[segmentDefs.length - 1].h;
  const threadDefs = [
    { x: -0.03, z: 0.02, h: 0.16, w: 0.015, mat: mat.highlight },
    { x: 0.0, z: -0.01, h: 0.18, w: 0.018, mat: mat.main },
    { x: 0.035, z: 0.015, h: 0.14, w: 0.014, mat: mat.shadow },
    { x: -0.015, z: -0.02, h: 0.11, w: 0.012, mat: mat.highlight },
  ];
  const threads = threadDefs.map(({ x, z, h, w, mat: tm }) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, -lastH, z);
    tailPivot.add(pivot);
    const strand = hangingBox(w, h, w, tm);
    pivot.add(strand);
    return pivot;
  });
  parts.threads = threads;

  // -------------------------------------------------------------------
  // Store all animated sub-parts for animate() to reach.
  // -------------------------------------------------------------------
  root.userData.parts = parts;

  // -------------------------------------------------------------------
  // ANIMATION — a real procedural rig built on mobs/anim/rig.js.
  //
  // Idle:      rig.breathe drives the hover bob, rig.sway adds a lazy
  //            head-lead weave on top of the continuous cadence-driven
  //            undulation so the chain never looks frozen; the stray
  //            thread and barbs waver on their own independent phases.
  // Moving:    the sinuous undulation tightens and quickens with
  //            state.speed01, the head pitches forward, and the whole
  //            chain leans/banks into state.turn.
  // Telegraph/
  // Attack:    rig.windUp rears the void-knot head back and up (and coils
  //            the chain behind it) as state.telegraph rises, then
  //            rig.strike whip-lunges the head forward and down as
  //            state.attack fires — a head-rear-then-lunge strike.
  // Hurt:      a sharp full-chain jolt/flinch, core flares brighter.
  // Death:     rig.dissolve(state.dying) unravels the Raveler: the knot
  //            lolls, the chain and threads fling outward and go limp, the
  //            core dims out, and the whole body sinks and shrinks away —
  //            a thread-unravel, never gore.
  // -------------------------------------------------------------------
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
      const speed01 = clamp01(s.speed01 != null ? s.speed01 : (moving ? 1 : 0));
      const hurt = clamp01(s.hurt);
      const attack = clamp01(s.attack);
      const telegraph = clamp01(s.telegraph);
      const dying = clamp01(s.dying);
      const turn = n(s.turn, 0);

      // Lean/bank the chain into turns, damped so it never snaps.
      const leanTarget = dying > 0 ? 0 : Math.max(-0.5, Math.min(0.5, -turn * 1.2));
      lean = rig.damp(lean, leanTarget, 9, dt || 0.016);

      // ---- DEATH: thread-unravel dissolve, overrides everything else ----
      if (dying > 0) {
        const d = rig.dissolve(dying);
        const sc = Math.max(0.04, d.scale);
        root.scale.set(sc, sc, sc);
        root.position.y = HOVER_Y - d.drop * 0.6;
        root.rotation.z = lean * 0.2;

        headPivot.position.set(0, HEAD_TOP_Y, 0);
        headPivot.rotation.z = d.spread * 0.5;
        headPivot.rotation.x = -d.spread * 0.4; // knot lolls back
        headPivot.scale.setScalar(1);

        segments.forEach(({ pivot }, i) => {
          const side = i % 2 === 0 ? 1 : -1;
          pivot.rotation.z = side * d.spread * (0.7 + i * 0.18);
          pivot.rotation.x = d.spread * (0.4 + i * 0.08);
        });

        threads.forEach((pivot, i) => {
          const side = i % 2 === 0 ? -1 : 1;
          pivot.rotation.z = side * d.spread * 1.4;
          pivot.rotation.x = d.spread * 1.0;
        });

        barbs.forEach((pivot, i) => {
          pivot.rotation.x = (i % 2 === 0 ? 1 : -1) * d.spread * 0.9;
        });

        strayPivot.rotation.z = -0.35 - d.spread * 0.9;
        strayPivot.rotation.x = d.spread * 0.6;

        // The void-knot's core light fails as the thread comes apart.
        core.material.emissiveIntensity = Math.max(0, 0.9 * (1 - dying));
        return;
      }

      // Reset in case a previous frame was mid-dissolve and the mob got
      // revived/recycled (defensive; animate() must never assume ordering
      // with the mob manager's own lifecycle).
      if (root.scale.x !== 1) root.scale.set(1, 1, 1);
      root.rotation.z = 0;

      // ---- Hover bob + breathing — the Raveler never truly rests. ------
      const breatheAmt = rig.breathe(time, 1.3, moving ? 1.6 : 0.9);
      const hoverWave = Math.sin(time * (1.6 + speed01 * 3.2)) * (0.032 - speed01 * 0.01);
      root.position.y = HOVER_Y + breatheAmt + hoverWave;

      // ---- Sinuous undulation cascades down the chain — each segment
      // sways in X and Z with a phase offset from the last, like a hung
      // serpent, tightening and quickening with speed01. ------------------
      const cadence = 1.3 + speed01 * 3.6;
      const amp = 0.15 + speed01 * 0.20;
      segments.forEach(({ pivot }, i) => {
        const phase = i * 0.85;
        pivot.rotation.z =
          Math.sin(time * cadence - phase) * amp * (0.5 + i * 0.12) + lean * (0.25 + i * 0.08);
        pivot.rotation.x = Math.cos(time * cadence * 0.8 - phase) * amp * 0.35;
      });

      // The knot-head leads the undulation (continuous sway), plus a
      // slower lazy idle weave layered on top that fades out with speed.
      const idleAmt = 1 - speed01;
      const headLead = Math.sin(time * cadence) * amp * 0.4;
      const headIdleSway = rig.sway(time, 1.1, 0.6, 0) * idleAmt * 0.5;
      let headZ = headLead + headIdleSway + lean * 0.5;
      let headX = moving ? 0.26 + speed01 * 0.12 : 0.0;

      // Trailing thread-ends waver wider and with more lag than the body.
      const threadSpeed = cadence * 0.85;
      threads.forEach((pivot, i) => {
        const phase = i * 1.3 + 2.0;
        pivot.rotation.z = Math.sin(time * threadSpeed - phase) * (amp * 1.6);
        pivot.rotation.x = Math.cos(time * threadSpeed * 0.75 - phase) * (amp * 1.1);
      });

      // Barbs waver independently, a small fast tremor.
      barbs.forEach((pivot, i) => {
        pivot.rotation.x = Math.sin(time * (4 + i * 1.3) + i) * 0.35;
      });

      // The stray thread droops and drifts on its own lazy phase.
      strayPivot.rotation.x = rig.sway(time, 1.2, 0.5, 1.7);

      // Core pulse — a slow cold-glow heartbeat, quickening under threat.
      const pulseSpeed = 2.0 + hurt * 6.0 + attack * 4.0 + telegraph * 2.0;
      const pulse = 0.55 + Math.sin(time * pulseSpeed) * 0.35;
      core.material.emissiveIntensity = pulse + hurt * 0.6 + attack * 0.4;

      // ---- Telegraph / attack overlay: rear back, then whip-lunge ------
      // rig.windUp returns 0 at telegraph=0, sweeping down to (briefly
      // past) -1 as telegraph->1 — used as a "rear back and coil" pose.
      // rig.strike is a fast-forward 0..1 release used for the lunge.
      if (telegraph > 0 || attack > 0) {
        const wind = rig.windUp(telegraph); // 0 .. ~-1.1 .. -1
        const rear = Math.max(0, -wind); // 0 .. ~1.1
        const strikeAmt = rig.strike(attack); // 0..1, front-loaded

        headPivot.position.z = -rear * 0.14 * (1 - strikeAmt) + strikeAmt * 0.30;
        headPivot.position.y =
          HEAD_TOP_Y + rear * 0.10 * (1 - strikeAmt) - strikeAmt * 0.12;
        headX += -rear * 0.4 * (1 - strikeAmt) + strikeAmt * 0.55;

        // The chain coils tighter just behind the rearing head, then
        // snaps straighter as the strike releases.
        const coil = rear * (1 - strikeAmt);
        segments.forEach(({ pivot }, i) => {
          pivot.rotation.x += coil * 0.25 * (1 - i * 0.15);
        });
      } else {
        headPivot.position.z = rig.damp(headPivot.position.z, 0, 10, dt || 0.016);
        headPivot.position.y = rig.damp(headPivot.position.y, HEAD_TOP_Y, 10, dt || 0.016);
      }

      // ---- Hurt — a sharp full-chain jolt/flinch. -----------------------
      if (hurt > 0) {
        headZ += Math.sin(time * 34) * hurt * 0.3;
        headPivot.scale.setScalar(1 + hurt * 0.12);
        segments.forEach(({ pivot }, i) => {
          pivot.rotation.z += Math.sin(time * 30 - i) * hurt * 0.15;
        });
      } else {
        headPivot.scale.setScalar(1 + (headPivot.scale.x - 1) * 0.7);
      }

      headPivot.rotation.z = headZ;
      headPivot.rotation.x = headX;
    } catch (e) {
      // animate() must never throw and take the whole mob manager down.
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
    'loose woven segments, lightly wrung like a corkscrewed rope, topped ' +
    'by an asymmetric, two-lobed void-knot head wound with diagonal ' +
    'thread wraps and a faint glowing core visible through its seam. A ' +
    'stray loose end droops off the knot and a pair of broken-thread ' +
    'barbs poke sideways mid-chain, wispy thread-ends trailing from its ' +
    'tail. It drifts low over the void, unpicking blocks and items as it ' +
    'passes, rears its knot back before surging in fast whenever the ' +
    'Last Needle summons it to strike.',
};
