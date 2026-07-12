# Emitters — drop-in light sources for the builder

One page covering your two integration findings: **the palette has no torch
block** (FINDINGS.md 4) and **the adjacent-air light rule** (FINDINGS.md 5).
Everything here is `graphics-lab/emitters.js` + the GraphicsStack emissive
path; snippets are written against your real `World.getBlock(x,y,z)` and
`public/src/blocks/blocks.js` registry.

## 1. Derive dynamic lights from your emissive blocks

```js
import { registerEmitterLights } from './graphics-lab/emitters.js';
import { getBlockDef } from './src/blocks/blocks.js';

// After gfx.init(...) — gfx.exposes.torches is the pooled light manager.
const emitters = registerEmitterLights({
  volume: {                                   // your chunk map, world-space
    getBlock: (x, y, z) => world.getBlock(x, y, z),
    size: { sx: SX, sy: SY, sz: SZ },
  },
  torchManager: gfx.exposes.torches,
  emissiveOf: (id) => getBlockDef(id).emissive, // YOUR registry: 0..15
  minLevel: 8,                                  // ignore faint glows
  maxLights: 400,                               // even-stride thinned over budget
});
// emitters -> { count, ids, positions, unregister() }
emitters.unregister();                          // e.g. on chunk unload
```

**The adjacent-air rule (why your first nether shots were black):**
`TorchLightManager.register()` centres a point light inside the given cell. If
you pass the emitting block's own coordinates, the light sits INSIDE an opaque
block and every surface facing away from it gets nothing. The helper always
registers the best **adjacent air cell** instead — above the emitter first
(lava surface), then the four sides, then below (hanging glowstone) — and
**skips fully-enclosed emitters** so buried blocks never waste a pooled-light
slot. Light intensity is scaled by `emissive / 15`, so a level-11 portal glows
dimmer than level-15 glowstone.

## 2. When you add a torch id to blocks.js

Add the block with an `emissive` level, exactly like glowstone:

```js
// blocks.js — ids >= 30 are yours to append
def(30, 'torch', { all: 'torch', solid: false, transparent: true,
                   emissive: 14, hardness: 0, tool: 'none' }),
```

`registerEmitterLights` picks it up with zero extra code (it reads
`emissiveOf`, i.e. your registry). For the visuals:

```js
import { makeEmissiveBlockMaterial, attachTorchVisual } from './graphics-lab/emitters.js';

// a) A glowing material for your own torch/lamp mesh (bloom-friendly):
const torchMat = makeEmissiveBlockMaterial({ color: 0xffa64d, intensity: 1.6 });

// b) Or the lab's ready-made stick+coal torch prop (shared geometry/materials,
//    ~free per instance). Placed on the block floor; the coal head lands at
//    the pooled light height (y + 0.55):
const prop = attachTorchVisual(gfx.scene, { x, y, z });  // -> Object3D
// remove with gfx.scene.remove(prop)
```

Materials never light their neighbours — pair the visual with
`registerEmitterLights` (or one `gfx.exposes.torches.register(...)`) so the
torch actually casts light.

## 3. Emissive BLOCKS (lava / glowstone / portal) — no per-light cost

Point lights are torch-scale, not lava-lake-scale (FINDINGS.md 6). The stack
now meshes emissive blocks into a third geometry group with a self-lit
material (lava additionally gets an animated UV-scrolled warm glow, and PostFX
bloom halos it at night). This is automatic for `ids: 'builder'` providers;
pass your registry for exact levels:

```js
await gfx.init({
  domElement: document.body,
  volumeProvider: {
    getBlock: (x, y, z) => world.getBlock(x, y, z),
    size: { sx: SX, sy: SY, sz: SZ },
    ids: 'builder',
    emissiveOf: (id) => getBlockDef(id).emissive,  // optional but recommended
  },
});
// Streaming your own chunks? meshChunk now returns a third geometry:
const { solid, transparent, emissive } = gfx.meshChunk(chunkVolume);
// render `emissive` with gfx.materials.emissive
```

Rule of thumb: **blocks glow via the emissive mesh group; the pooled lights
make them light up their SURROUNDINGS.** Use both (the integration demo does).
Opt out with `emissive: false` on the provider to restore the old
lava-renders-as-glowstone remap.
