// Voxelheim sky — day/night cycle: gradient background color, sun + moon,
// directional/hemisphere/ambient lights, drifting clouds and night stars.
//
// timeOfDay convention: 0.0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk.
// update(timeOfDay, playerPos?) — playerPos (THREE.Vector3 or {x,y,z}) keeps
// the celestial bodies, stars and cloud field centered on the player.

import * as THREE from 'three';

// Sky background keyframes across a full day (t wraps at 1).
const SKY_KEYFRAMES = [
  { t: 0.0, c: new THREE.Color(0.012, 0.022, 0.075) }, // midnight deep navy
  { t: 0.19, c: new THREE.Color(0.02, 0.04, 0.12) },
  { t: 0.25, c: new THREE.Color(0.95, 0.52, 0.38) }, // dawn orange-pink
  { t: 0.32, c: new THREE.Color(0.55, 0.72, 0.93) },
  { t: 0.5, c: new THREE.Color(0.52, 0.8, 0.95) }, // noon sky blue
  { t: 0.68, c: new THREE.Color(0.56, 0.68, 0.9) },
  { t: 0.75, c: new THREE.Color(0.96, 0.45, 0.26) }, // dusk orange
  { t: 0.81, c: new THREE.Color(0.045, 0.055, 0.15) },
  { t: 1.0, c: new THREE.Color(0.012, 0.022, 0.075) }, // wrap to midnight
];

const CLOUD_COUNT = 40;
const CLOUD_SPAN = 360; // clouds wrap within a SPAN x SPAN field around the player
const STAR_COUNT = 700;
const SKY_RADIUS = 440; // stars
const ORBIT_RADIUS = 380; // sun/moon discs

export class Sky {
  constructor(scene) {
    this.scene = scene;
    this._bg = new THREE.Color();
    scene.background = this._bg;

    this.group = new THREE.Group();
    this.group.name = 'sky';
    scene.add(this.group);

    // ---- lights -------------------------------------------------------------
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 1.0);
    this.group.add(this.sunLight);
    this.group.add(this.sunLight.target);
    this.hemiLight = new THREE.HemisphereLight(0xbfd8ff, 0x6e5a41, 0.7);
    this.group.add(this.hemiLight);
    // Small ambient floor so night stays dim but visible.
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.18);
    this.group.add(this.ambientLight);

    // ---- sun & moon discs ---------------------------------------------------
    this.sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(16, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xffdf70, fog: false })
    );
    this.moonMesh = new THREE.Mesh(
      new THREE.SphereGeometry(11, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xe3eaf8, fog: false })
    );
    this.sunMesh.renderOrder = -1;
    this.moonMesh.renderOrder = -1;
    this.group.add(this.sunMesh, this.moonMesh);

    // ---- stars ----------------------------------------------------------------
    const starPos = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      // Uniform-ish points on a sphere via normalized gaussians.
      let x = 0;
      let y = 0;
      let z = 0;
      let len = 0;
      while (len < 1e-4) {
        x = Math.random() * 2 - 1;
        y = Math.random() * 2 - 1;
        z = Math.random() * 2 - 1;
        len = Math.hypot(x, y, z);
      }
      starPos[i * 3] = (x / len) * SKY_RADIUS;
      starPos[i * 3 + 1] = (y / len) * SKY_RADIUS;
      starPos[i * 3 + 2] = (z / len) * SKY_RADIUS;
    }
    const starGeom = new THREE.BufferGeometry();
    starGeom.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.starMaterial = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    this.stars = new THREE.Points(starGeom, this.starMaterial);
    this.stars.renderOrder = -2;
    this.stars.visible = false;
    this.group.add(this.stars);

    // ---- clouds ---------------------------------------------------------------
    this.cloudMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      fog: false,
    });
    const cloudGeom = new THREE.BoxGeometry(1, 1, 1);
    this.clouds = [];
    this.cloudGroup = new THREE.Group();
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const mesh = new THREE.Mesh(cloudGeom, this.cloudMaterial);
      mesh.scale.set(14 + Math.random() * 24, 2.5 + Math.random() * 2, 10 + Math.random() * 22);
      const cloud = {
        mesh,
        baseX: Math.random() * CLOUD_SPAN,
        baseZ: Math.random() * CLOUD_SPAN,
        y: 98 + Math.random() * 8,
        speed: 0.6 + Math.random() * 0.9, // blocks per second, slow drift
      };
      this.clouds.push(cloud);
      this.cloudGroup.add(mesh);
    }
    this.group.add(this.cloudGroup);

    this._drift = 0;
    this._lastNow = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._player = new THREE.Vector3();
    this._sunDir = new THREE.Vector3();
    this._lightDir = new THREE.Vector3();
    this._hemiSky = new THREE.Color(0xbfd8ff);
  }

  /**
   * @param {number} timeOfDay 0..1 (0 midnight, 0.25 dawn, 0.5 noon, 0.75 dusk)
   * @param {THREE.Vector3|{x:number,y:number,z:number}} [playerPos]
   */
  update(timeOfDay, playerPos) {
    const t = ((timeOfDay % 1) + 1) % 1;
    const p = this._player;
    if (playerPos) p.set(playerPos.x, playerPos.y, playerPos.z);
    else p.set(0, 0, 0);

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const dt = Math.min(0.1, (now - this._lastNow) / 1000);
    this._lastNow = now;
    this._drift += dt;

    // Sun orbits in a tilted vertical circle; moon sits exactly opposite.
    const ang = (t - 0.25) * Math.PI * 2;
    const sunDir = this._sunDir.set(Math.cos(ang), Math.sin(ang), 0.28).normalize();
    const daylight = THREE.MathUtils.smoothstep(sunDir.y, -0.06, 0.24); // 0 night .. 1 day
    const night = 1 - THREE.MathUtils.smoothstep(sunDir.y, -0.16, 0.04);

    // Background color through keyframes.
    let k = 0;
    while (k < SKY_KEYFRAMES.length - 2 && SKY_KEYFRAMES[k + 1].t < t) k++;
    const a = SKY_KEYFRAMES[k];
    const b = SKY_KEYFRAMES[k + 1];
    const f = THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1);
    this._bg.copy(a.c).lerp(b.c, f);
    // Keep the scene.background reference intact even if something replaced it.
    if (this.scene.background !== this._bg) this.scene.background = this._bg;

    // Sun & moon discs.
    this.sunMesh.position.copy(p).addScaledVector(sunDir, ORBIT_RADIUS);
    this.moonMesh.position.copy(p).addScaledVector(sunDir, -ORBIT_RADIUS);

    // Directional light follows the sun by day, the moon by night.
    const lightDir = this._lightDir.copy(sunDir);
    if (sunDir.y < -0.04) lightDir.negate();
    this.sunLight.position.copy(p).addScaledVector(lightDir, 300);
    this.sunLight.target.position.copy(p);
    this.sunLight.intensity = 0.12 + 1.05 * daylight;
    this.sunLight.color.setRGB(1, 0.86 + 0.14 * daylight, 0.7 + 0.3 * daylight);

    // Ambient floor: dim but visible at night.
    this.hemiLight.intensity = 0.14 + 0.6 * daylight;
    this.hemiLight.color.copy(this._bg).lerp(this._hemiSky, 0.5);
    this.ambientLight.intensity = 0.1 + 0.15 * daylight;

    // Stars fade in at night.
    this.starMaterial.opacity = night;
    this.stars.visible = night > 0.02;
    this.stars.position.copy(p);

    // Clouds drift slowly along +x and wrap around the player.
    const half = CLOUD_SPAN / 2;
    for (const c of this.clouds) {
      const relX =
        ((((c.baseX + this._drift * c.speed - p.x + half) % CLOUD_SPAN) + CLOUD_SPAN) % CLOUD_SPAN) - half;
      const relZ = ((((c.baseZ - p.z + half) % CLOUD_SPAN) + CLOUD_SPAN) % CLOUD_SPAN) - half;
      c.mesh.position.set(p.x + relX, c.y, p.z + relZ);
    }
    // Clouds darken toward night.
    const cl = 0.25 + 0.75 * daylight;
    this.cloudMaterial.color.setRGB(cl, cl, cl + 0.02 * night);
  }
}
