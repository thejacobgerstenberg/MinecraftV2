// graphics-lab/integration/main.js
//
// PROOF OF COMPOSITION: the builder's REAL worldgen (vendored byte-exact under
// ./builder/, see PROVENANCE.md) feeding the full graphics-lab stack through
// the GraphicsStack facade — no edits to either side.
//
//   builder TerrainGenerator  -> Uint8Array chunks (16x16x128, ids 0-29)
//   -> volumeProvider { getBlock, size }  (GraphicsStack remaps ids itself)
//   -> GraphicsStack init (quality high, everything on)
//
// Presets (?preset=day|night|cinderloom|nevermend) map the builder's three
// dimensions onto the lab's three skies so every screenshot is real builder
// terrain:
//   day / night  -> builder 'overworld'  + lab 'warpwold'
//   cinderloom   -> builder 'nether'     + lab 'cinderloom'  (lava + glowstone)
//   nevermend    -> builder 'end'        + lab 'nevermend'   (night + aurora)

import { GraphicsStack } from '../integrate.js';
import { registerEmitterLights } from '../emitters.js';
import { TerrainGenerator } from './builder/public/src/world/TerrainGenerator.js';
import {
  CHUNK_SX, CHUNK_SZ, CHUNK_SY, SEA_LEVEL, blockIndex,
} from './builder/public/src/constants.js';
import { BLOCK_ID, getBlockDef } from './builder/public/src/blocks/blocks.js';

// ---------------------------------------------------------------------------
// Preset table. Region scouted over the real generator (see FINDINGS.md):
// seed '1337', chunks (0,-2)..(3,1) = 36% water, heights 40-67, 162 tree logs.
// ---------------------------------------------------------------------------
const CHUNKS = 4; // 4x4 chunks -> 64 x 128 x 64 volume
const PRESETS = {
  day: {
    seed: '1337', builderDim: 'overworld', labDim: 'warpwold',
    origin: { cx: 0, cz: -2 }, timeOfDay: 0.42,
    camera: { pos: [63, 66, 52], look: [2, 46, 26] },
  },
  night: {
    seed: '1337', builderDim: 'overworld', labDim: 'warpwold',
    origin: { cx: 0, cz: -2 }, timeOfDay: 0.85,
    camera: { pos: [8, 56, 44], look: [52, 50, 2] },
    // The overworld generator places ZERO emissive blocks (FINDINGS.md 4) —
    // night scenes would have no derived emitters at all. To exercise the
    // emitters helper + emissive path on the overworld, the demo (NOT the
    // generator) drops a few glowstone blocks onto the terrain surface.
    demoGlowstone: [
      [20, 16], [28, 24], [36, 18], [44, 28], [24, 36], [40, 40], [52, 12], [16, 28],
      [12, 20], [32, 8], [48, 20], [56, 24],
    ],
  },
  cinderloom: {
    seed: '1337', builderDim: 'nether', labDim: 'cinderloom',
    origin: { cx: 0, cz: 0 }, timeOfDay: 0.78,
    // Inside the cavern, under a glowstone ceiling blob at (35-37, 91, 34-36);
    // the orange band is the dusk sky through the slice's open sides.
    camera: { pos: [31, 74, 22], look: [36, 91, 36] },
    // The builder's nether has a LAVA ocean (y<=31), not water — the lab's
    // blue water plane would misrepresent it, so water stays off here.
    enable: { water: false, underwater: false, underwaterfx: false },
    waterLevel: 31,
  },
  nevermend: {
    seed: '1337', builderDim: 'end', labDim: 'nevermend',
    origin: { cx: 0, cz: 0 }, timeOfDay: 0.85,
    // South rim of the end island looking north: aurora curtains live in the
    // -Z sky band; the drop at frame right is the island edge over the void.
    camera: { pos: [30, 72, 60], look: [58, 84, -12] },
    // Floating islands over void — no sea in the builder's end dimension.
    enable: { water: false, underwater: false, underwaterfx: false },
    waterLevel: 1,
  },
};

const params = new URLSearchParams(location.search);
const presetName = PRESETS[params.get('preset')] ? params.get('preset') : 'day';
const preset = PRESETS[presetName];

// ---------------------------------------------------------------------------
// 1. Generate the world slice with the builder's REAL generator.
// ---------------------------------------------------------------------------
const SX = CHUNKS * CHUNK_SX;
const SY = CHUNK_SY;
const SZ = CHUNKS * CHUNK_SZ;

const genT0 = performance.now();
const gen = new TerrainGenerator(preset.seed, preset.builderDim);
// Chunk grid laid out row-major; copied into one flat array (builder layout,
// blockIndex(x,y,z) = x + z*16 + y*256) widened to the 64x64 slice for O(1)
// reads during meshing.
const world = new Uint8Array(SX * SY * SZ);
const worldIndex = (x, y, z) => x + z * SX + y * SX * SZ;
for (let i = 0; i < CHUNKS; i++) {
  for (let j = 0; j < CHUNKS; j++) {
    const data = gen.generateChunk(preset.origin.cx + i, preset.origin.cz + j);
    for (let y = 0; y < CHUNK_SY; y++) {
      for (let z = 0; z < CHUNK_SZ; z++) {
        for (let x = 0; x < CHUNK_SX; x++) {
          world[worldIndex(i * CHUNK_SX + x, y, j * CHUNK_SZ + z)] =
            data[blockIndex(x, y, z)];
        }
      }
    }
  }
}
const genMs = performance.now() - genT0;

// ---------------------------------------------------------------------------
// 2. Demo-only glowstone drops (night preset): the overworld generator places
//    no emissive blocks, so a handful of glowstone blocks are set onto the
//    terrain surface to exercise the emissive mesh group + emitters helper.
//    Clearly demo-injected — everything else in `world` is raw generator
//    output.
// ---------------------------------------------------------------------------
let emitterSpot = null;
if (preset.demoGlowstone) {
  for (const [x, z] of preset.demoGlowstone) {
    for (let y = SY - 2; y >= 0; y--) {
      const id = world[worldIndex(x, y, z)];
      if (id === BLOCK_ID.air) continue;
      // Solid ground only — water columns would leave glowstone afloat.
      if (id !== BLOCK_ID.water && world[worldIndex(x, y + 1, z)] === BLOCK_ID.air) {
        world[worldIndex(x, y + 1, z)] = BLOCK_ID.glowstone;
        // Expose the HIGHEST placed block for inspection tooling (a camera
        // above a hilltop spot has clear line of sight over the terrain).
        if (!emitterSpot || y + 1 > emitterSpot.y) emitterSpot = { x, y: y + 1, z };
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Adapt builder chunk storage -> volumeProvider. Builder ids 0-29 pass
//    through untouched; GraphicsStack's BUILDER_TO_LAB remap handles them,
//    and `emissiveOf` reads the REAL block registry so glowstone/lava/portal
//    take the stack's emissive material path (FINDINGS.md 3/6).
// ---------------------------------------------------------------------------
const volumeProvider = {
  getBlock: (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return 0;
    return world[worldIndex(x, y, z)];
  },
  size: { sx: SX, sy: SY, sz: SZ },
  ids: 'builder',
  waterLevel: preset.waterLevel ?? SEA_LEVEL,
  emissiveOf: (id) => getBlockDef(id).emissive,
};

// ---------------------------------------------------------------------------
// 4. Full stack, quality high, dimension per preset.
// ---------------------------------------------------------------------------
const gfx = new GraphicsStack({
  quality: 'high',
  texturePack: 'default',
  dimension: preset.labDim,
  seed: 1337,
  enable: preset.enable || {},
});

const initT0 = performance.now();
await gfx.init({
  domElement: document.body,
  volumeProvider,
  waterLevel: preset.waterLevel ?? SEA_LEVEL,
});
const initMs = performance.now() - initT0;

gfx.setTimeOfDay(preset.timeOfDay);
const cam = preset.camera;
gfx.camera.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
gfx.camera.lookAt(cam.look[0], cam.look[1], cam.look[2]);
gfx.start();

// ---------------------------------------------------------------------------
// 4b. Dynamic lights from the REAL generated emissive blocks, via the
//     emitters helper (graphics-lab/emitters.js): one pooled light per
//     emitter, registered in the best ADJACENT AIR cell (top face preferred),
//     intensity scaled by the registry's emissive level, buried emitters
//     skipped. Flame particles reuse the same positions.
// ---------------------------------------------------------------------------
let emitters = { count: 0, ids: [], positions: [] };
if (gfx.exposes.torches) {
  emitters = registerEmitterLights({
    volume: volumeProvider,
    torchManager: gfx.exposes.torches,
    emissiveOf: (id) => getBlockDef(id).emissive, // REAL registry read
    minLevel: 8,
    maxLights: 400,
  });
}
if (gfx.exposes.particles) {
  for (const p of emitters.positions) gfx.exposes.particles.addTorch(p);
}
window.__emitters = { count: emitters.count };
window.__emitterSpot = emitterSpot;

// Isolated re-mesh timing (same volume + atlas, output disposed) so the number
// is honest and separable from the rest of init.
const meshT0 = performance.now();
const timed = gfx.meshChunk(volumeProvider);
const meshMs = performance.now() - meshT0;
let triangles = 0;
let emissiveTriangles = 0;
for (const g of [timed.solid, timed.transparent, timed.emissive]) {
  if (!g) continue;
  const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
  triangles += tris;
  if (g === timed.emissive) emissiveTriangles = tris;
  g.dispose();
}

window.gfx = gfx;
window.__preset = presetName;
window.__stats = {
  preset: presetName,
  builderDim: preset.builderDim,
  labDim: preset.labDim,
  worldSize: { sx: SX, sy: SY, sz: SZ },
  chunks: CHUNKS * CHUNKS,
  genMs: +genMs.toFixed(1),
  initMs: +initMs.toFixed(1),
  meshMs: +meshMs.toFixed(1),
  meshTriangles: Math.round(triangles),
  emissiveTriangles: Math.round(emissiveTriangles),
  lights: emitters.count,
};
requestAnimationFrame(() => requestAnimationFrame(() => {
  // Post-frame renderer numbers (draw calls / tris for the composed frame).
  window.__stats.render = {
    calls: gfx.renderer.info.render.calls,
    triangles: gfx.renderer.info.render.triangles,
  };
  window.__ready = true;
}));
