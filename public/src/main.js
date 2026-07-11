// PLACEHOLDER main — replaced during integration
//
// This minimal bootstrap proves the pipeline boots: Three.js loads via the
// importmap, a WebGLRenderer draws into #game, and a spinning textured cube
// renders in a requestAnimationFrame loop with a sky-blue scene. It must run
// with zero console errors. The integration agent replaces this file wholesale.

import * as THREE from 'three';

const canvas = document.getElementById('game');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb); // sky blue

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);
camera.position.set(0, 0, 3);

// Lights.
const ambient = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(3, 5, 2);
scene.add(sun);

// A simple procedural canvas texture so the cube looks "textured", not flat.
function makePlaceholderTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#4caf50';
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = '#3c8f3c';
  for (let y = 0; y < 32; y += 8) {
    for (let x = 0; x < 32; x += 8) {
      if (((x + y) / 8) % 2 === 0) ctx.fillRect(x, y, 8, 8);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  return tex;
}

const geometry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshLambertMaterial({ map: makePlaceholderTexture() });
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let last = performance.now();
function loop(now) {
  const dt = (now - last) / 1000;
  last = now;
  cube.rotation.x += dt * 0.6;
  cube.rotation.y += dt * 0.9;
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

// Hide the loading splash once the loop is running.
const loading = document.getElementById('loading');
if (loading) loading.classList.remove('visible');

requestAnimationFrame(loop);
