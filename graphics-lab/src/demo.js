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
import { BLOCKS, AIR, WATER, LEAVES } from './blocks.js';
import { createBlockAtlas } from './textures.js';
import { buildChunkGeometry } from './voxelMesher.js';
import { createVoxelMaterial } from './voxelMaterial.js';
import { DynamicSky } from './sky.js';
import { ShadowController } from './shadows.js';
import { Water, UnderwaterOverlay } from './water.js';
import { DistanceFog } from './fog.js';
import { PostFX } from './postprocessing.js';
import { Particles } from './particles.js';
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

  // A pleasing daytime 3/4 framing on the chunk, plus a submerged lake framing.
  const CENTER = new THREE.Vector3(sx / 2, WATER_LEVEL + 2, sz / 2); // ~(24,12,24)
  const ABOVE_TARGET = CENTER.clone();
  const ABOVE_CAM = new THREE.Vector3(sx * 1.18, sy * 1.55, sz * 1.28); // ~(57,50,61)
  // Lake centre is (13,34) r=10 in worldgen; dip to WATER_LEVEL-2 inside it.
  const UNDER_CAM = new THREE.Vector3(13, WATER_LEVEL - 2, 40);         // ~(13,8,40)
  const UNDER_TARGET = new THREE.Vector3(20, WATER_LEVEL + 1, 26);

  const camera = new THREE.PerspectiveCamera(
    55, window.innerWidth / window.innerHeight, 0.1, 4000,
  );
  camera.position.copy(ABOVE_CAM);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.copy(ABOVE_TARGET);
  controls.minDistance = 10;
  controls.maxDistance = 220;
  controls.maxPolarAngle = Math.PI * 0.495; // stay above the ground plane
  controls.autoRotate = true;               // gentle auto-orbit option
  controls.autoRotateSpeed = 0.45;
  controls.update();

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

  // Warm glowstone/torch point lights at every worldgen light position.
  const torchLights = [];
  for (const l of volume.lights) {
    const pl = new THREE.PointLight(0xffb262, 1.4, 20, 2);
    pl.position.set(l.x + 0.5, l.y + 0.6, l.z + 0.5);
    pl.castShadow = false; // point-light shadows are too costly for the target fps
    scene.add(pl);
    torchLights.push(pl);
  }

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
    size: Math.max(sx, sz) + 24,
    center: { x: sx / 2, z: sz / 2 },
    segments: 64,
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
    density: 0.0055,
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

  // Mark cast/receive flags AFTER every mesh (incl. water) is in the scene.
  shadows.applyToScene(scene);

  // ==========================================================================
  // Shared state + a stable ctx object (mutated in place; no per-frame alloc).
  // ==========================================================================
  const state = {
    effects: { ao: true, sky: true, shadows: true, water: true, post: true, particles: true, fog: true },
    quality: 'medium',
    timeOfDay: 0.35,
    weather: 'clear',
    underwater: false,
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

  // ==========================================================================
  // 7. window.demo control API (EXACTLY per API_CONTRACT.md, plus a debug
  //    spawnBlockBreak helper used by the render loop).
  // ==========================================================================
  function frameAbove() {
    controls.autoRotate = true;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.target.copy(ABOVE_TARGET);
    camera.position.copy(ABOVE_CAM);
    controls.update();
  }
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
      particles.setWeather(mode);          // reseed the weather field
      // DistanceFog scales its density from ctx.weather every frame (rain/snow
      // thicken the haze); nothing else to poke here.
    },

    setUnderwater(on) {
      const b = !!on;
      state.underwater = b;
      ctx.underwater = b;                  // UnderwaterOverlay + fog react to this
      if (b) frameUnderwater();
      else frameAbove();
    },

    setQuality(q) {
      const quality = ['low', 'medium', 'high', 'ultra'].includes(q) ? q : 'medium';
      state.quality = quality;
      post.setQuality(quality);
      shadows.setQuality(quality);
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
        default: break;
      }
    },

    // Debug/demo helper: burst debris off a broken block face.
    spawnBlockBreak(pos, color) {
      particles.spawnBlockBreak(pos, color);
    },
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

    // Gentle torch flicker on the warm point lights.
    for (let i = 0; i < torchLights.length; i++) {
      torchLights[i].intensity = 1.25 + 0.35 * Math.sin(elapsed * 8.5 + i * 2.3);
    }

    controls.update();

    // Effect updates (each module self-gates on its own enabled flag).
    sky.update(dt, ctx);

    // Per-frame sky -> fog/water colour sync: copy the CURRENT horizon colour
    // into the shared ctx.skyColor (allocation-free via the target overload).
    // DistanceFog and Water both read ctx.skyColor every frame, so fog, water
    // body/reflection and sky stay seamless through sunrise/sunset.
    sky.getFogColor(ctxSkyColor);

    shadows.update(dt, ctx);
    water.update(dt, ctx);       // sun/moon intensity+colour auto-derived from
                                 // ctx.sunDir + sunRef (night-correct water)
    underwater.update(dt, ctx);
    fog.update(dt, ctx);
    particles.update(dt, ctx);
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

    // Final render (PostFX self-bypasses to a plain render when disabled).
    post.render(dt);

    if (firstFrame) {
      firstFrame = false;
      window.__demoReady = true;
    }
  }

  animate();
}
