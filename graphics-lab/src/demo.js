// graphics-lab/src/demo.js
//
// INTEGRATED SHOWCASE ENTRY.
//
// Wires the full effect stack together into one voxel vignette:
//   worldgen volume -> AO-meshed chunk (voxelMesher + voxelMaterial) textured
//   from the procedural block atlas (textures.js),
//   DynamicSky (sun/hemi light rig + dome/stars/clouds),
//   ShadowController (soft directional shadows on the shared sun),
//   Water surface + UnderwaterOverlay at WATER_LEVEL,
//   DistanceFog synced to the sky horizon colour,
//   Particles (torch flames at every glowstone + weather + block-break debris),
//   PostFX (HDR bloom + ACES tonemap + vignette + FXAA) as the final pass.
//
// Exposes the window.demo control API from API_CONTRACT.md, builds the GUI, and
// sets window.__demoReady = true after the first successful frame. The whole
// init is wrapped in try/catch so any failure surfaces in a visible #error div
// (and console.error) for verification.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

import { generateDemoChunk } from './worldgen.js';
import { BLOCKS, AIR, WATER, LEAVES, WOOD, GLOWSTONE } from './blocks.js';
import { createBlockAtlas } from './textures.js';
import { buildChunkGeometry } from './voxelMesher.js';
import { createVoxelMaterial } from './voxelMaterial.js';
import { DynamicSky } from './sky.js';
import { ShadowController } from './shadows.js';
import { Water, UnderwaterOverlay } from './water.js';
import { DistanceFog } from './fog.js';
import { PostFX } from './postprocessing.js';
import { Particles } from './particles.js';
import { PortalGate } from './portals.js';
import { BlockCracks } from './blockcrack.js';
import { FirstPersonViewModel } from './viewmodel.js';
import { TorchLightManager, QUALITY_LIGHTS, makeTorchMesh } from './torchlights.js';
import { applyWindSway, getWindController } from './windsway.js';
import { BiomeGrading } from './biomelut.js';
import { createGUI } from './gui.js';

// ---------------------------------------------------------------------------
// Visible error surface (verification hook). Created lazily so a hard failure
// anywhere in init() is always reported both on-page and to the console.
// ---------------------------------------------------------------------------
function showError(err) {
  // eslint-disable-next-line no-console
  console.error('[graphics-lab] init failed:', err);
  let div = document.getElementById('error');
  if (!div) {
    div = document.createElement('div');
    div.id = 'error';
    div.style.cssText = [
      'position:fixed', 'left:12px', 'bottom:12px', 'z-index:1000',
      'max-width:min(90vw,640px)', 'max-height:60vh', 'overflow:auto',
      'padding:12px 14px', 'border-radius:10px',
      'background:rgba(60,12,12,0.92)', 'color:#ffd7d7',
      'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
      'white-space:pre-wrap', 'border:1px solid rgba(255,120,120,0.4)',
      'box-shadow:0 8px 24px rgba(0,0,0,0.5)',
    ].join(';');
    document.body.appendChild(div);
  }
  const msg = (err && (err.stack || err.message)) || String(err);
  div.textContent = 'graphics-lab error:\n' + msg;
}

try {
  init();
} catch (err) {
  showError(err);
}

function init() {
  const canvasHost = document.getElementById('app') || document.body;

  // ==========================================================================
  // 1. Renderer.  AA off (FXAA in PostFX), high-performance, colour-managed,
  //    NoToneMapping so PostFX owns ACES.
  // ==========================================================================
  THREE.ColorManagement.enabled = true;

  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping; // PostFX does ACES on the HDR buffer
  canvasHost.appendChild(renderer.domElement);

  // ==========================================================================
  // 2. Scene, camera, controls.
  // ==========================================================================
  const scene = new THREE.Scene();

  const volume = generateDemoChunk();
  const { sx, sy, sz, WATER_LEVEL } = volume;

  const CENTER = new THREE.Vector3(sx / 2, WATER_LEVEL + 2, sz / 2); // ~(24,12,24)

  // ---- Camera view presets (window.demo.setView) ---------------------------
  // 'hero'    3/4 view from the SW, pitched only ~8 deg down so the top ~40% of
  //           the frame is SKY (the old top-down framing never showed the sky
  //           above the horizon — that is why stars/moon/clouds "vanished").
  //           Faces +X/-Z: the low night moon arc (sky.js) rises on this side.
  // 'sunrise' LOW camera (y ~ WATER_LEVEL+6) west of the island looking EAST
  //           along the sun azimuth (~11 deg) so the rising sun disc, horizon
  //           gradient and long shadows are all in frame.
  // 'closeup' by the cabin's glowstone lights: texture + AO detail.
  const VIEWS = {
    hero:    { pos: [-14, 26, 62], target: [26, 18, 20], maxPolar: 0.495 },
    sunrise: { pos: [-26, WATER_LEVEL + 6, 47], target: [54, WATER_LEVEL + 4, 63], maxPolar: 0.55 },
    closeup: { pos: [38, 25, 27], target: [29.5, 20.5, 16.5], maxPolar: 0.52 },
    // Feature-shot framings (phase-2 fix round):
    // 'firstperson'  closeup variant panned right so the portal frame is not
    //                clipped at the left edge behind the held-item viewmodel.
    // 'portal'       ground-level, square on the portal gate so the swirl,
    //                obsidian frame and the light it throws fill the frame.
    // 'torches'      ground-level inside the scatter-torch cluster east of
    //                the cabin: warm falloff pools on the terraces are the
    //                subject.
    firstperson: { pos: [38.5, 24.5, 28.5], target: [31.5, 20.5, 14.5], maxPolar: 0.52 },
    portal:      { pos: [20, 18.5, 37], target: [22, 18.6, 25.5], maxPolar: 0.55 },
    torches:     { pos: [27.5, 18.5, 22.5], target: [33.5, 16.5, 27.5], maxPolar: 0.55 },
  };
  // Underwater framing: FULLY submerged inside the lake bowl (centre (13,34),
  // r=10, floor ~5, surface at WATER_LEVEL=10 with ~0.6u waves — so the camera
  // sits at y=7.6, safely below every wave trough, never straddling the
  // surface). It looks up-slope at the submerged sand rim to the NE so the
  // frame is filled with underwater terrain, with a slice of the water
  // surface visible overhead.
  const UNDER_CAM = new THREE.Vector3(13, WATER_LEVEL - 2.4, 35.5);
  const UNDER_TARGET = new THREE.Vector3(21, WATER_LEVEL + 0.2, 26.5);

  const camera = new THREE.PerspectiveCamera(
    55, window.innerWidth / window.innerHeight, 0.1, 4000,
  );
  camera.position.fromArray(VIEWS.hero.pos);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.fromArray(VIEWS.hero.target);
  controls.minDistance = 8;
  controls.maxDistance = 220;
  controls.maxPolarAngle = Math.PI * VIEWS.hero.maxPolar;
  controls.autoRotate = true;               // gentle showcase drift on boot;
  controls.autoRotateSpeed = 0.45;          // any explicit setView() stops it
  controls.update();

  let currentView = 'hero';
  function applyView(name) {
    const v = VIEWS[name] || VIEWS.hero;
    currentView = VIEWS[name] ? name : 'hero';
    controls.autoRotate = false;            // deterministic framing
    controls.maxPolarAngle = Math.PI * v.maxPolar;
    controls.target.fromArray(v.target);
    camera.position.fromArray(v.pos);
    controls.update();
  }

  // ==========================================================================
  // 3. Voxel chunk: AO-meshed solid + transparent(leaves) geometry, textured
  //    from the procedural 16x16 block atlas (textures.js). The mesher writes
  //    atlas UVs + neutral tints; the material multiplies map * tint * AO.
  // ==========================================================================
  const atlas = createBlockAtlas();
  const geom = buildChunkGeometry(volume, { ao: true, atlas });

  const solidMat = createVoxelMaterial({ transparent: false, map: atlas.texture });
  // With a map, transparent:true switches to alpha-cutout foliage (leaf holes).
  const leavesMat = createVoxelMaterial({ transparent: true, map: atlas.texture });

  const solidMesh = new THREE.Mesh(geom.solid, solidMat);
  solidMesh.name = 'ChunkSolid';
  scene.add(solidMesh);

  let leavesMesh = null;
  if (geom.transparent) {
    leavesMesh = new THREE.Mesh(geom.transparent, leavesMat);
    leavesMesh.name = 'ChunkLeaves';
    leavesMesh.renderOrder = 1;
    scene.add(leavesMesh);
  }

  // Torch/glowstone lighting is handled by the pooled TorchLightManager below
  // (replaces the old always-on per-torch PointLights). Glowstone blocks keep
  // their emissive material look regardless of the light budget.

  // ==========================================================================
  // 4. Sky (owns the sun + hemi lights), shadows, water, fog, particles.
  // ==========================================================================
  const sky = new DynamicSky(renderer, { size: 4000, stars: 2200 });
  scene.add(sky.object3d);           // brings sky.sun + sky.hemi into the scene
  sky.setTimeOfDay(0.35);

  const shadows = new ShadowController(renderer, sky.sun, {
    quality: 'medium',
    center: CENTER,
    groundY: WATER_LEVEL + 3,
    lightDistance: 140,
  });

  const water = new Water(scene, {
    level: WATER_LEVEL,
    size: 260,                       // wide "ocean" apron: the sea stays visible
    // far past the island so the horizon line reads (72 ended at the fog wall)
    center: { x: sx / 2, z: sz / 2 },
    segments: 96,
    sunRef: sky,                     // pulls sun colour/dir + reflection colour
  });
  water.setSkyReflectionColor(sky.getFogColor());

  const underwater = new UnderwaterOverlay(scene, camera, { level: WATER_LEVEL });
  // Keep the camera-enveloping tint sphere out of the shadow pass.
  underwater.object3d.userData.noShadow = true;
  underwater.object3d.castShadow = false;
  underwater.object3d.receiveShadow = false;

  const fog = new DistanceFog(scene, {
    mode: 'exp2',
    density: 0.0016,                 // pulled way back (was 0.0055-clamped-to-
    // 0.0035): ~5% haze at 150u, so the ocean + horizon stay readable while
    // only the farthest water softens into the sky
    skyRef: sky,                     // auto-tints toward the sky horizon colour
  });
  fog.setSkyColor(sky.getFogColor());

  const particles = new Particles(scene, { camera });
  for (const l of volume.lights) particles.addTorch(l);
  particles.setWeather('clear');

  // ==========================================================================
  // 5. PostFX — the final render step (replaces renderer.render).
  // ==========================================================================
  const post = new PostFX(renderer, scene, camera, { quality: 'medium' });

  // ==========================================================================
  // 6. Phase-2 effects: portal gate, block cracks, first-person view model,
  //    pooled torch lights, foliage wind sway, biome colour grading.
  // ==========================================================================

  // ---- Portal gate. The grass shelf at x 19..25, z 24..26 south of the cabin
  // is dead flat (surface block y = 15 across the span — read from worldgen)
  // and faces the 'hero' camera, which looks from (-14,26,62) toward the cabin.
  // Gate y = 16 = the shelf's top face, so the frame base sits on the grass.
  const portal = new PortalGate({
    position: new THREE.Vector3(22, 16, 25.5),
    width: 4,
    height: 5,
    dimension: 'warpwold',
  });
  scene.add(portal.object3d);
  portal.activate(); // boot burst so early screenshots catch the flare

  // ---- Progressive block-crack decals (volume-aware face culling).
  const cracks = new BlockCracks(scene, { volume });

  // ---- First-person view model. Camera children only render when the camera
  // itself is in the scene graph.
  if (!camera.parent) scene.add(camera);
  const viewmodel = new FirstPersonViewModel(camera, {
    atlas,
    atlasTexture: atlas.texture,
  });
  viewmodel.setItem('block:1'); // default: grass block in hand

  // ---- Pooled torch lights: register every worldgen light position, then
  // scatter ~36 extra visible torches across the island surface. Positions are
  // deterministic (golden-angle spiral + volume surface sampling — no
  // Math.random), so the layout is identical every run.
  const torchMgr = new TorchLightManager(scene, {
    maxLights: QUALITY_LIGHTS.medium,
  });
  for (const l of volume.lights) torchMgr.register(l);

  // Top-most non-air/non-water block of a column (or null for open water).
  function surfaceTop(x, z) {
    for (let y = sy - 1; y >= 0; y--) {
      const id = volume.get(x, y, z);
      if (id !== AIR && id !== WATER) return { y, id };
    }
    return null;
  }

  const torchMeshes = new THREE.Group();
  torchMeshes.name = 'scatterTorches';
  scene.add(torchMeshes);
  {
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    const taken = new Set();
    let placed = 0;
    for (let i = 0; i < 120 && placed < 36; i++) {
      const r = 6 + 16 * ((i % 60) / 60);
      const a = i * GOLDEN;
      const x = Math.round(sx / 2 + Math.cos(a) * r);
      const z = Math.round(sz / 2 + Math.sin(a) * r);
      if (x < 1 || z < 1 || x >= sx - 1 || z >= sz - 1) continue;
      const key = x + z * 1024;
      if (taken.has(key)) continue;
      if (x >= 24 && x <= 34 && z >= 10 && z <= 20) continue; // cabin + yard
      if (x >= 18 && x <= 26 && z >= 23 && z <= 28) continue; // portal shelf
      const t = surfaceTop(x, z);
      if (!t || t.y < WATER_LEVEL + 1) continue;              // dry land only
      if (t.id === LEAVES || t.id === WOOD || t.id === GLOWSTONE) continue;
      taken.add(key);
      const mesh = makeTorchMesh();
      mesh.position.set(x + 0.5, t.y + 1, z + 0.5); // base on the block top
      torchMeshes.add(mesh);
      torchMgr.register({ x, y: t.y + 1, z });      // flame ~0.55 above base
      placed++;
    }
  }

  // Synthetic stress-test registrations (window.demo.setTorchCount).
  const syntheticTorchIds = [];

  // ---- Foliage wind sway on the transparent (leaves) material instance.
  applyWindSway(leavesMat, { mode: 'leaves' });
  const wind = getWindController();

  // ---- Per-biome colour grading through PostFX.setGrade (eased in-post).
  const biomes = new BiomeGrading(post);

  // Mark cast/receive flags AFTER every mesh (incl. water) is in the scene.
  shadows.applyToScene(scene);

  // ==========================================================================
  // Shared state + a stable ctx object (mutated in place; no per-frame alloc).
  // ==========================================================================
  const state = {
    effects: {
      ao: true, sky: true, shadows: true, water: true, post: true,
      particles: true, fog: true,
      portal: true, crack: true, viewmodel: true, torchlights: true,
      wind: true, biome: true,
    },
    quality: 'medium',
    timeOfDay: 0.35,
    weather: 'clear',
    underwater: false,
    dimension: 'warpwold',
    heldItem: 'block:1',
    biome: 'plains',
  };

  const ctxSkyColor = new THREE.Color().copy(sky.getFogColor());
  const ctx = {
    camera,
    renderer,
    scene,
    elapsed: 0,
    timeOfDay: state.timeOfDay,
    sunDir: sky.sunDir,              // live vector, re-aimed by sky.setTimeOfDay
    weather: state.weather,
    underwater: state.underwater,
    skyColor: ctxSkyColor,           // DistanceFog eases toward this every frame
  };

  // ==========================================================================
  // Pre-collect exposed top surfaces so the periodic block-break debris always
  // erupts off a visible face (grass/sand/snow/stone/plank tops, air above).
  // ==========================================================================
  const surfaces = [];
  for (const b of volume.blocks) {
    if (b.id === WATER || b.id === LEAVES) continue;
    if (volume.get(b.x, b.y + 1, b.z) !== AIR) continue;
    const desc = BLOCKS[b.id];
    if (!desc || desc.air || desc.emissive) continue; // skip air-ish + glowstone
    surfaces.push(b);
  }

  // Crack-animation targets: visible top surfaces in the cabin's front yard
  // (framed by the 'hero' view), clear of the portal shelf.
  const breakSpots = surfaces.filter((b) =>
    b.x >= 16 && b.x <= 38 && b.z >= 19 && b.z <= 30 &&
    b.y >= WATER_LEVEL + 2 &&
    !(b.x >= 18 && b.x <= 26 && b.z >= 23 && b.z <= 28));

  let breakIdx = 0;
  let breakTimer = 0;
  function triggerBreakImpl() {
    if (breakSpots.length === 0) return;
    const b = breakSpots[breakIdx % breakSpots.length];
    breakIdx += 5; // stride so consecutive breaks hop around the yard
    breakTimer = 0;
    viewmodel.swing(); // the hand swings whenever a break starts
    cracks.animateBreak(b.x, b.y, b.z, {
      duration: 1.5,
      onComplete: (x, y, z) => {
        // Existing debris system: burst voxel shards off the broken block.
        particles.spawnBlockBreak({ x, y, z }, BLOCKS[b.id] && BLOCKS[b.id].color);
      },
    });
  }

  // ==========================================================================
  // 7. window.demo control API (EXACTLY per API_CONTRACT.md, plus a debug
  //    spawnBlockBreak helper used by the render loop).
  // ==========================================================================
  function frameUnderwater() {
    controls.autoRotate = false;
    controls.maxPolarAngle = Math.PI * 0.9; // allow looking up at the surface
    controls.target.copy(UNDER_TARGET);
    camera.position.copy(UNDER_CAM);
    controls.update();
  }

  window.demo = {
    setTimeOfDay(t) {
      const v = Math.max(0, Math.min(1, Number(t)));
      state.timeOfDay = v;
      ctx.timeOfDay = v;
      sky.setTimeOfDay(v);
      ctxSkyColor.copy(sky.getFogColor()); // feed the new horizon to fog + water
    },

    setWeather(w) {
      const mode = (w === 'rain' || w === 'snow') ? w : 'clear';
      state.weather = mode;
      ctx.weather = mode;
      // Snow runs at higher intensity: flakes fall slowly, so a heavier field
      // is needed for the frame to read as snowfall at a glance.
      particles.setWeather(mode, mode === 'snow' ? 0.9 : 0.7);
      sky.setWeather(mode);                // storm mood: grey sky, sun -45%
      ctxSkyColor.copy(sky.getFogColor()); // fog snaps to the graded horizon
      // DistanceFog additionally scales density from ctx.weather every frame.
    },

    setUnderwater(on) {
      const b = !!on;
      state.underwater = b;
      ctx.underwater = b;                  // UnderwaterOverlay + fog react to this
      // Submerged, the bright sky dome must never leak through the murk (it
      // used to read as a white void past the fog), so the sky visuals are
      // hidden and restored on surfacing (honouring the GUI's sky toggle).
      sky.setEnabled(b ? false : state.effects.sky);
      if (b) frameUnderwater();
      else applyView(currentView);
    },

    // Camera view presets: 'hero' | 'sunrise' | 'closeup'.
    setView(name) {
      applyView(name);
    },

    setQuality(q) {
      const quality = ['low', 'medium', 'high', 'ultra'].includes(q) ? q : 'medium';
      state.quality = quality;
      post.setQuality(quality);
      shadows.setQuality(quality);
      torchMgr.setMaxLights(QUALITY_LIGHTS[quality] || QUALITY_LIGHTS.medium);
    },

    // Portal: crossfade to another dimension palette (+ activation burst).
    setPortalDimension(name) {
      portal.setDimension(name);
      state.dimension = portal.dimension;
    },

    // Crack + break a visible block near the cabin (debris on completion).
    triggerBreak() {
      triggerBreakImpl();
    },

    // First-person held item: 'block:<id|name>' | 'tool:pickaxe' | null/''.
    setHeldItem(spec) {
      viewmodel.setItem(spec || null);
      state.heldItem = spec ? String(spec) : '';
    },

    swing() {
      viewmodel.swing();
    },

    // Biome colour grade: 'plains'|'desert'|'tundra'|'swamp'|'cinder'.
    setBiome(name) {
      if (biomes.setBiome(name)) state.biome = name;
    },

    // Stress hook: register n synthetic torch positions in a ring around the
    // island (replaces the previous synthetic set; scenery torches untouched).
    setTorchCount(n) {
      n = Math.max(0, Math.min(500, n | 0));
      while (syntheticTorchIds.length) torchMgr.unregister(syntheticTorchIds.pop());
      for (let i = 0; i < n; i++) {
        const a = (i / Math.max(1, n)) * Math.PI * 2;
        syntheticTorchIds.push(torchMgr.register({
          x: sx / 2 + Math.cos(a) * 18,
          y: WATER_LEVEL + 7.5,
          z: sz / 2 + Math.sin(a) * 18,
        }));
      }
    },

    toggle(name, on) {
      const b = !!on;
      if (name in state.effects) state.effects[name] = b;
      switch (name) {
        case 'ao':
          solidMat.userData.setAoEnabled(b);
          leavesMat.userData.setAoEnabled(b);
          break;
        case 'sky': sky.setEnabled(b); break;
        case 'shadows': shadows.setEnabled(b); break;
        case 'water': water.setEnabled(b); break;
        case 'post': post.setEnabled(b); break;
        case 'particles': particles.setEnabled(b); break;
        case 'fog': fog.setEnabled(b); break;
        case 'portal': portal.setEnabled(b); break;
        case 'crack': cracks.setEnabled(b); break;
        case 'viewmodel': viewmodel.setEnabled(b); break;
        case 'torchlights':
          torchMgr.setEnabled(b);
          torchMeshes.visible = b; // hide the prop meshes with their lights
          break;
        case 'wind': wind.setEnabled(b); break;
        case 'biome': biomes.setEnabled(b); break;
        default: break;
      }
    },

    // Debug/demo helper: burst debris off a broken block face.
    spawnBlockBreak(pos, color) {
      particles.spawnBlockBreak(pos, color);
    },

    // Exposed for stats/verification tooling.
    renderer,
    camera,
    scene,
    sky,
    controls,
  };

  // ==========================================================================
  // 8. GUI + resize.
  // ==========================================================================
  createGUI(window.demo, state);

  function onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    post.setSize(); // auto-detects the new drawing-buffer size
  }
  window.addEventListener('resize', onResize);

  // ==========================================================================
  // 9. Render loop.
  // ==========================================================================
  const clock = new THREE.Clock();
  let firstFrame = true;
  let bbTimer = 0;
  let bbIndex = 0;

  function animate() {
    requestAnimationFrame(animate);

    const dt = Math.min(clock.getDelta(), 0.05);
    const elapsed = clock.elapsedTime;

    // Refresh the shared ctx (mutated in place).
    ctx.elapsed = elapsed;
    ctx.timeOfDay = state.timeOfDay;
    ctx.weather = state.weather;
    ctx.underwater = state.underwater;

    controls.update();

    // Effect updates (each module self-gates on its own enabled flag).
    sky.update(dt, ctx);

    // Per-frame sky -> fog/water colour sync: copy the CURRENT horizon colour
    // into the shared ctx.skyColor (allocation-free via the target overload).
    // DistanceFog and Water both read ctx.skyColor every frame, so fog, water
    // body/reflection and sky stay seamless through sunrise/sunset.
    sky.getFogColor(ctxSkyColor);
    // Submerged, the shared colour becomes the underwater murk colour instead,
    // so the water surface seen from below tints deep teal — the sky-bright
    // reflection colour used to bleach the surface plane into a white sheet.
    if (state.underwater) underwater.getFogColor(ctxSkyColor);

    shadows.update(dt, ctx);
    water.update(dt, ctx);       // sun/moon intensity+colour auto-derived from
                                 // ctx.sunDir + sunRef (night-correct water)
    underwater.update(dt, ctx);
    fog.update(dt, ctx);
    particles.update(dt, ctx);
    portal.update(dt, ctx);      // swirl time + palette fade + burst envelope
    cracks.update(dt, ctx);      // break-stage animations (fires onComplete)
    viewmodel.update(dt, ctx);   // idle bob + swing arc + night fill
    torchMgr.update(dt, ctx);    // nearest-N light pooling + flame flicker
    wind.update(dt, ctx);        // weather-driven sway strength (2 uniforms)
    biomes.update(dt, ctx);      // no-op (PostFX eases the grade internally)
    post.update(dt, ctx);        // auto night boost from sun altitude
                                 // (wider/stronger bloom as the sun sets)

    // Periodic block-break debris so shots always show flying voxels.
    bbTimer += dt;
    if (bbTimer >= 1.5 && surfaces.length > 0) {
      bbTimer = 0;
      const b = surfaces[bbIndex % surfaces.length];
      bbIndex += 7; // stride to spread bursts across the terrain
      window.demo.spawnBlockBreak(b, BLOCKS[b.id] && BLOCKS[b.id].color);
    }

    // Auto crack-break near the cabin every ~6 s (view-model swing included)
    // so screenshots can catch the full crack -> debris sequence. Gated on
    // the crack toggle: with cracks disabled the whole break demo pauses
    // (no invisible decals, and no surprise view-model swings that can yank
    // the held item out of frame mid-capture).
    breakTimer += dt;
    if (breakTimer >= 6 && state.effects.crack) triggerBreakImpl();

    // Final render (PostFX self-bypasses to a plain render when disabled).
    post.render(dt);

    if (firstFrame) {
      firstFrame = false;
      window.__demoReady = true;
    }
  }

  animate();
}
