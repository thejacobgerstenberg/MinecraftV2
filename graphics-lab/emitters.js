// graphics-lab/emitters.js
//
// EMITTER HELPERS — turn a volume's emissive blocks (glowstone / lava /
// portal / a future torch id) into correctly-placed dynamic lights, plus the
// two builder-facing conveniences for a torch block that doesn't exist in the
// builder palette yet (FINDINGS.md 4) .
//
//   registerEmitterLights({ volume, torchManager, emissiveOf, minLevel })
//     -> { count, ids, positions, unregister() }
//   makeEmissiveBlockMaterial({ color, intensity }) -> THREE.MeshStandardMaterial
//   attachTorchVisual(scene, pos) -> THREE.Object3D  (torchlights.makeTorchMesh)
//
// THE ADJACENT-AIR RULE (FINDINGS.md 5 — the "black capture" bug): a pooled
// point light registered at the emitting block's own coordinates sits INSIDE
// an opaque block; every Lambert surface facing away from it receives nothing
// and the first nether shots came out pitch black around 400 registered
// lights. registerEmitterLights therefore registers the best ADJACENT AIR
// cell instead: the cell above the emitter when it is air (top face
// preferred), else one of the four side cells, else the cell below (hanging
// glowstone), and SKIPS fully-enclosed emitters outright — a buried emitter
// is invisible and must not eat a light-budget slot.
//
// Standalone module: imports only src/torchlights.js (+ three). Safe to use
// with or without the GraphicsStack facade.

import * as THREE from 'three';
import { makeTorchMesh } from './src/torchlights.js';

// Builder palette (integration/builder/public/src/blocks/blocks.js) emissive
// defaults, id -> level 0..15. Used when no emissiveOf/map is supplied and by
// GraphicsStack as the default for `ids: 'builder'` volume providers.
// (The builder registry lists portal at emissive 12; the stack's default uses
// 11 per the integration task sheet — pass your own emissiveOf to read the
// registry value exactly, see EMITTERS.md.)
export const DEFAULT_BUILDER_EMISSIVE = Object.freeze({
  24: 15,  // glowstone
  28: 15,  // lava
  29: 11,  // portal
});

// ---------------------------------------------------------------------------
// Volume + emissive-map normalization
// ---------------------------------------------------------------------------

// Accepts either a builder-style provider { getBlock(x,y,z), size:{sx,sy,sz} }
// or a mesher-style volume { get(x,y,z), sx, sy, sz }. Out-of-bounds reads are
// air (matches the integration demo's open-slice convention).
function normalizeVolume(volume) {
  if (!volume) return null;
  if (typeof volume.getBlock === 'function') {
    const size = volume.size || {};
    const sx = size.sx | 0;
    const sy = size.sy | 0;
    const sz = size.sz | 0;
    return {
      sx, sy, sz,
      get: (x, y, z) => (
        x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz
          ? 0 : volume.getBlock(x, y, z) | 0
      ),
    };
  }
  if (typeof volume.get === 'function') {
    const sx = volume.sx | 0;
    const sy = volume.sy | 0;
    const sz = volume.sz | 0;
    return {
      sx, sy, sz,
      get: (x, y, z) => (
        x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz
          ? 0 : volume.get(x, y, z) | 0
      ),
    };
  }
  return null;
}

function normalizeEmissiveOf(emissiveOf) {
  if (typeof emissiveOf === 'function') return emissiveOf;
  if (emissiveOf && typeof emissiveOf === 'object') {
    return (id) => emissiveOf[id] | 0;
  }
  return (id) => DEFAULT_BUILDER_EMISSIVE[id] | 0;
}

// ---------------------------------------------------------------------------
// registerEmitterLights
// ---------------------------------------------------------------------------

/**
 * Scan a volume for emissive blocks and register one pooled dynamic light per
 * emitter in its best ADJACENT AIR cell (see header).
 *
 * @param {object} p
 *   volume        { getBlock, size:{sx,sy,sz} } | { get, sx, sy, sz }
 *   torchManager  src/torchlights.js TorchLightManager (e.g.
 *                 gfx.exposes.torches)
 *   emissiveOf    (id) -> 0..15, e.g. (id) => getBlockDef(id).emissive against
 *                 the builder registry; or a plain { id: level } map.
 *                 Default: DEFAULT_BUILDER_EMISSIVE (builder id space).
 *   minLevel      only levels >= minLevel register (default 8 — skips faint
 *                 decorative glows so they don't drain the light pool).
 *   maxLights     registration budget (default 512). Over-budget candidate
 *                 sets are thinned with an even stride so e.g. a lava ocean
 *                 keeps uniform coverage instead of lighting one corner.
 * @returns {{ count: number, ids: number[], positions: {x,y,z,level}[],
 *             unregister: () => void }}
 *   ids/positions are parallel. unregister() removes every light this call
 *   registered (idempotent).
 */
export function registerEmitterLights({
  volume,
  torchManager,
  emissiveOf = null,
  minLevel = 8,
  maxLights = 512,
} = {}) {
  const vol = normalizeVolume(volume);
  if (!vol) throw new Error('[emitters] registerEmitterLights: unrecognised volume');
  if (!torchManager || typeof torchManager.register !== 'function') {
    throw new Error('[emitters] registerEmitterLights: torchManager is required');
  }
  const levelOf = normalizeEmissiveOf(emissiveOf);
  const { sx, sy, sz, get } = vol;
  const isAir = (x, y, z) => get(x, y, z) === 0;

  // Candidate pass: best adjacent air cell per emitter, de-duped (several
  // blocks of one glowstone blob may share the same exposed air cell).
  const taken = new Set();
  const candidates = [];
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const level = levelOf(get(x, y, z)) | 0;
        if (level < minLevel || level <= 0) continue;
        // Top face preferred, then the four sides, then below (hanging
        // glowstone); fully enclosed -> skip (invisible emitter).
        let px = x; let py = y; let pz = z; let found = false;
        if (isAir(x, y + 1, z)) { py = y + 1; found = true; }
        else if (isAir(x + 1, y, z)) { px = x + 1; found = true; }
        else if (isAir(x - 1, y, z)) { px = x - 1; found = true; }
        else if (isAir(x, y, z + 1)) { pz = z + 1; found = true; }
        else if (isAir(x, y, z - 1)) { pz = z - 1; found = true; }
        else if (isAir(x, y - 1, z)) { py = y - 1; found = true; }
        if (!found) continue;
        const key = ((py + 1) * (sz + 2) + (pz + 1)) * (sx + 2) + (px + 1);
        if (taken.has(key)) continue;
        taken.add(key);
        candidates.push({ x: px, y: py, z: pz, level });
      }
    }
  }

  // Budget: even-stride thinning keeps spatial coverage uniform.
  let picked = candidates;
  const budget = Math.max(0, maxLights | 0);
  if (candidates.length > budget) {
    picked = [];
    const stride = candidates.length / budget;
    for (let i = 0; i < budget; i++) picked.push(candidates[Math.floor(i * stride)]);
  }

  const ids = picked.map((c) =>
    torchManager.register(c, { intensity: c.level / 15 }));

  return {
    count: ids.length,
    ids,
    positions: picked,
    unregister() {
      for (const id of ids) torchManager.unregister(id);
      ids.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// makeEmissiveBlockMaterial — for the builder's future torch/lamp block id
// ---------------------------------------------------------------------------

/**
 * A ready-to-use emissive PBR material for a light-source block mesh (the
 * builder palette has no torch id yet — FINDINGS.md 4). The emissive term is
 * bright enough for the stack's PostFX bloom to halo it at night; pair it
 * with registerEmitterLights so the block also CASTS light (materials never
 * light their neighbours on their own).
 * @param {{color?: number|THREE.Color, intensity?: number}} opts
 *   color      emissive glow color (default warm torch orange 0xffa64d)
 *   intensity  emissiveIntensity (default 1.6 — matches the lab torch head)
 */
export function makeEmissiveBlockMaterial({ color = 0xffa64d, intensity = 1.6 } = {}) {
  return new THREE.MeshStandardMaterial({
    color: 0x3a2a18,          // dark base so the glow reads as self-lit
    roughness: 0.9,
    metalness: 0.0,
    emissive: new THREE.Color(color),
    emissiveIntensity: intensity,
  });
}

// ---------------------------------------------------------------------------
// attachTorchVisual — visible torch prop at a block position
// ---------------------------------------------------------------------------

/**
 * Place a torchlights.makeTorchMesh() prop (shared geometry/materials) at a
 * block position and add it to the scene. Integer coords are centred on the
 * block floor (x+0.5, y, z+0.5) so the emissive coal head lands at the torch
 * pool's light height (~y + 0.55).
 * @returns the mesh; remove with scene.remove(mesh) (assets are shared — see
 *   torchlights.disposeTorchMeshAssets for full teardown).
 */
export function attachTorchVisual(scene, pos) {
  const mesh = makeTorchMesh();
  mesh.position.set(
    Number.isInteger(pos.x) ? pos.x + 0.5 : pos.x,
    pos.y,
    Number.isInteger(pos.z) ? pos.z + 0.5 : pos.z,
  );
  if (scene) scene.add(mesh);
  return mesh;
}

export default registerEmitterLights;
