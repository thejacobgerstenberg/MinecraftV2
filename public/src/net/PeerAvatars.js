// Loomfall — remote player avatars (integration phase).
//
// Maintains a Map of peer id -> avatar: a THREE.Group with a body box and a
// head box in a color derived from the peer id hash, plus a canvas-texture
// name-tag sprite above the head (sprites always face the camera). Positions
// are smoothed each frame toward the last received network position.
//
// Peer position convention matches Player.position: the MIN corner of the
// 0.6 x 1.8 x 0.6 AABB (feet). The avatar group is centered on the column.
//
// API:
//   const peers = new PeerAvatars(scene);
//   peers.upsert({id, name, x, y, z, yaw, dim})  — add or update a peer
//   peers.move({id, x, y, z, yaw, dim})          — update the lerp target
//   peers.remove(id)                              — remove + dispose one peer
//   peers.setDimension(dim)   — only avatars in `dim` are visible
//   peers.update(dt)          — advance the position/yaw smoothing
//   peers.count / peers.ids   — for HUD/debug/QA
//   peers.dispose()           — remove + dispose everything

import * as THREE from 'three';

/** Deterministic hue (0-359) from a peer id string. */
function hashHue(str) {
  let h = 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

/** Canvas-texture sprite showing the peer's name. */
function makeNameTag(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = '700 30px "Consolas", "Menlo", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = String(name ?? '???').slice(0, 20);
  const w = Math.min(248, ctx.measureText(text).width + 24);
  ctx.fillStyle = 'rgba(6, 10, 16, 0.55)';
  ctx.fillRect(128 - w / 2, 8, w, 48);
  ctx.fillStyle = '#f2f6ff';
  ctx.fillText(text, 128, 34);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.8, 0.45, 1);
  return sprite;
}

export class PeerAvatars {
  constructor(scene) {
    this.scene = scene;
    /** @type {Map<string, object>} id -> entry */
    this._entries = new Map();
    this._dim = 'overworld';
  }

  get count() {
    return this._entries.size;
  }

  get ids() {
    return [...this._entries.keys()];
  }

  /** Add a new peer or update an existing one (peer-join doubles as upsert). */
  upsert({ id, name, x = 0, y = 0, z = 0, yaw = 0, dim = 'overworld' } = {}) {
    if (id == null) return;
    let entry = this._entries.get(id);
    if (entry) {
      entry.dim = dim;
      entry.target.x = x; entry.target.y = y; entry.target.z = z;
      entry.target.yaw = yaw;
      entry.group.visible = dim === this._dim;
      return;
    }

    const hue = hashHue(id);
    const bodyColor = new THREE.Color().setHSL(hue / 360, 0.55, 0.42);
    const headColor = new THREE.Color().setHSL(hue / 360, 0.5, 0.6);

    const group = new THREE.Group();
    group.name = `peer:${id}`;

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 1.2, 0.34),
      new THREE.MeshLambertMaterial({ color: bodyColor }),
    );
    body.position.y = 0.6;
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, 0.52, 0.52),
      new THREE.MeshLambertMaterial({ color: headColor }),
    );
    head.position.y = 1.48;
    const tag = makeNameTag(name);
    tag.position.y = 2.15;
    group.add(body, head, tag);

    // Snap to the first known position (offset to the column center).
    group.position.set(x + 0.3, y, z + 0.3);
    group.rotation.y = yaw;
    group.visible = dim === this._dim;
    this.scene.add(group);

    entry = { id, name, group, body, head, tag, dim, target: { x, y, z, yaw } };
    this._entries.set(id, entry);
  }

  /** Network move: retarget the smoothing (and dim, when it changes). */
  move({ id, x, y, z, yaw, dim } = {}) {
    const entry = this._entries.get(id);
    if (!entry) return;
    if (Number.isFinite(x)) entry.target.x = x;
    if (Number.isFinite(y)) entry.target.y = y;
    if (Number.isFinite(z)) entry.target.z = z;
    if (Number.isFinite(yaw)) entry.target.yaw = yaw;
    if (typeof dim === 'string' && dim) {
      entry.dim = dim;
      entry.group.visible = dim === this._dim;
    }
  }

  remove(id) {
    const entry = this._entries.get(id);
    if (!entry) return;
    this._dispose(entry);
    this._entries.delete(id);
  }

  /** Only peers in the local player's dimension are rendered. */
  setDimension(dim) {
    this._dim = dim;
    for (const entry of this._entries.values()) {
      entry.group.visible = entry.dim === dim;
    }
  }

  /** Ease every avatar toward its last received position/yaw. */
  update(dt) {
    const k = 1 - Math.exp(-12 * Math.max(0, dt));
    for (const entry of this._entries.values()) {
      const g = entry.group;
      const t = entry.target;
      g.position.x += (t.x + 0.3 - g.position.x) * k;
      g.position.y += (t.y - g.position.y) * k;
      g.position.z += (t.z + 0.3 - g.position.z) * k;
      // Shortest-path yaw interpolation.
      let dy = t.yaw - g.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      g.rotation.y += dy * k;
    }
  }

  dispose() {
    for (const entry of this._entries.values()) this._dispose(entry);
    this._entries.clear();
  }

  _dispose(entry) {
    this.scene.remove(entry.group);
    entry.body.geometry.dispose();
    entry.body.material.dispose();
    entry.head.geometry.dispose();
    entry.head.material.dispose();
    entry.tag.material.map.dispose();
    entry.tag.material.dispose();
  }
}
