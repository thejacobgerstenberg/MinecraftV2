// graphics-lab/src/demo.js
//
// PLACEHOLDER demo entry. The integrator will replace this with the full
// effect-driven renderer, but it must already render something: it builds the
// worldgen volume as plain colored cubes, frames an OrbitControls camera on the
// chunk, runs a render loop, wires a minimal window.demo API + the GUI, and
// sets window.__demoReady = true after the first frame.
//
// Everything here is deliberately simple — no AO / post / particles yet.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { generateDemoChunk } from './worldgen.js';
import { BLOCKS, AIR, WATER, LEAVES } from './blocks.js';
import { createGUI } from './gui.js';

const canvasHost = document.getElementById('app') || document.body;

// --- Renderer ----------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
canvasHost.appendChild(renderer.domElement);

// --- Scene & camera ----------------------------------------------------------

const scene = new THREE.Scene();
const SKY_DAY = new THREE.Color(0x8fc0ea);
const SKY_UNDERWATER = new THREE.Color(0x123048);
scene.background = SKY_DAY.clone();
scene.fog = new THREE.Fog(SKY_DAY.clone(), 60, 140);

const volume = generateDemoChunk();
const cx = volume.sx / 2;
const cz = volume.sz / 2;
const cy = volume.WATER_LEVEL + 4;
const center = new THREE.Vector3(cx, cy, cz);

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  500,
);
camera.position.set(cx + volume.sx * 0.85, cy + volume.sy * 1.15, cz + volume.sz * 0.9);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.copy(center);
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 12;
controls.maxDistance = 180;
controls.update();

// --- Lighting ----------------------------------------------------------------

const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x54432f, 0.85);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2d6, 1.15);
sun.position.set(cx + 40, 90, cz + 25);
scene.add(sun);

const ambient = new THREE.AmbientLight(0xffffff, 0.25);
scene.add(ambient);

// Glowstone/torch point lights.
const torchLights = [];
for (const l of volume.lights) {
  const pl = new THREE.PointLight(0xffb35c, 1.4, 18, 2);
  pl.position.set(l.x + 0.5, l.y + 0.7, l.z + 0.5);
  scene.add(pl);
  torchLights.push(pl);
}

// --- Voxel mesh (instanced, only exposed faces) ------------------------------

const isTransparentId = (id) => id === WATER || id === LEAVES;

function isExposed(x, y, z, id) {
  const dirs = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];
  for (const [dx, dy, dz] of dirs) {
    const n = volume.get(x + dx, y + dy, z + dz);
    if (n === AIR) return true;
    if (isTransparentId(n) && n !== id) return true;
  }
  return false;
}

// Group visible blocks by id.
const visibleById = new Map();
for (const b of volume.blocks) {
  if (!isExposed(b.x, b.y, b.z, b.id)) continue;
  let arr = visibleById.get(b.id);
  if (!arr) { arr = []; visibleById.set(b.id, arr); }
  arr.push(b);
}

const cubeGeo = new THREE.BoxGeometry(1, 1, 1);
const dummy = new THREE.Object3D();
const meshesById = new Map();
let waterMesh = null;

for (const [id, list] of visibleById) {
  const desc = BLOCKS[id] || BLOCKS[0];
  const transparent = !!desc.transparent;
  const mat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    transparent,
    opacity: transparent ? (desc.opacity ?? 0.75) : 1,
    depthWrite: !transparent,
  });
  if (desc.emissive) {
    mat.emissive = new THREE.Color(desc.emissive[0], desc.emissive[1], desc.emissive[2]);
    mat.emissiveIntensity = 0.9;
  }

  const mesh = new THREE.InstancedMesh(cubeGeo, mat, list.length);
  const col = new THREE.Color();
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    dummy.position.set(b.x + 0.5, b.y + 0.5, b.z + 0.5);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    const c = desc.color;
    // Slight deterministic per-cube tint variation for a natural look.
    const jitter = 0.92 + 0.16 * (((b.x * 7 + b.y * 13 + b.z * 5) % 5) / 5);
    col.setRGB(c[0] * jitter, c[1] * jitter, c[2] * jitter);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.renderOrder = transparent ? 1 : 0;
  scene.add(mesh);
  meshesById.set(id, mesh);
  if (id === WATER) waterMesh = mesh;
}

// --- Minimal window.demo API (placeholder behaviour) -------------------------

const state = {
  effects: { ao: true, sky: true, shadows: true, water: true, post: true, particles: true, fog: true },
  quality: 'medium',
  timeOfDay: 0.35,
  weather: 'clear',
  underwater: false,
};

function applyUnderwater(on) {
  state.underwater = on;
  if (on) {
    scene.background = SKY_UNDERWATER.clone();
    if (scene.fog) { scene.fog.color.copy(SKY_UNDERWATER); scene.fog.near = 2; scene.fog.far = 34; }
    controls.target.set(cx, volume.WATER_LEVEL - 2, cz);
    camera.position.set(cx + 6, volume.WATER_LEVEL - 1.2, cz + 8);
  } else {
    scene.background = SKY_DAY.clone();
    if (scene.fog) { scene.fog.color.copy(SKY_DAY); scene.fog.near = 60; scene.fog.far = 140; }
    controls.target.copy(center);
    camera.position.set(cx + volume.sx * 0.85, cy + volume.sy * 1.15, cz + volume.sz * 0.9);
  }
  controls.update();
}

window.demo = {
  setTimeOfDay(t) {
    state.timeOfDay = t;
    // Simple day arc: move + tint the sun, dim at night.
    const ang = (t - 0.25) * Math.PI * 2;
    sun.position.set(cx + Math.cos(ang) * 70, Math.sin(ang) * 90 + 8, cz + 25);
    const day = Math.max(0, Math.sin(t * Math.PI));
    sun.intensity = 0.15 + day * 1.1;
    hemi.intensity = 0.25 + day * 0.7;
    if (!state.underwater) {
      scene.background.copy(SKY_DAY).multiplyScalar(0.25 + day * 0.75);
      if (scene.fog) scene.fog.color.copy(scene.background);
    }
  },
  setWeather(w) { state.weather = w; /* full weather lives in the real demo */ },
  setUnderwater(on) { applyUnderwater(!!on); },
  setQuality(q) {
    state.quality = q;
    const map = { low: 0.75, medium: 1.0, high: 1.35, ultra: 2.0 };
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, map[q] ?? 1));
  },
  toggle(name, on) {
    state.effects[name] = !!on;
    if (name === 'water' && waterMesh) waterMesh.visible = !!on;
    if (name === 'fog') scene.fog = on ? new THREE.Fog(scene.background.clone(), 60, 140) : null;
    // ao/sky/shadows/post/particles are no-ops in the placeholder.
  },
};

// Initialise from state and build the GUI.
window.demo.setTimeOfDay(state.timeOfDay);
createGUI(window.demo, state);

// --- Resize & render loop ----------------------------------------------------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
let firstFrame = true;

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  // Gentle torch flicker.
  const t = clock.elapsedTime;
  for (let i = 0; i < torchLights.length; i++) {
    torchLights[i].intensity = 1.2 + 0.35 * Math.sin(t * 9 + i * 2.1);
  }
  controls.update();
  renderer.render(scene, camera);
  if (firstFrame) {
    firstFrame = false;
    window.__demoReady = true;
  }
}
animate();
