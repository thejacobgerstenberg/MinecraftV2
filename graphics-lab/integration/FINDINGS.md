# Real-worldgen integration — findings

Setup: builder `TerrainGenerator` (vendored byte-exact, see
`builder/PROVENANCE.md`, branch head `98c7ea9`) generating 4x4 chunks of
16x16x128 (`CHUNK_SX/SZ/SY`, a 64x128x64 slice), adapted to the GraphicsStack
facade as a `{ getBlock, size, ids: 'builder' }` volumeProvider, full stack at
quality **high**. Demo: `graphics-lab/integration-demo.html`
(`?preset=day|night|cinderloom|nevermend`). Screenshots 26-29 in
`graphics-lab/screenshots/`. Headless runs: **zero console errors, zero
warnings** on all four presets.

Numbered findings — every mismatch/breakage/friction hit:

1. **Import resolution: clean — no adapters needed.** The generator's whole
   import closure (4 files) is pure ESM with relative paths and no `three`
   dependency. Vendored with the original `public/src/` layout preserved,
   everything resolved untouched; `adapters.js` was never created because no
   API mismatch materialized at the module-loading level.

2. **Chunk-format friction: column-major index vs (x,y,z) accessor.** Builder
   chunks are `Uint8Array(16*16*128)` indexed `blockIndex(x,y,z) = x + z*16 +
   y*256` per chunk, while the stack meshers want a world-space
   `getBlock(x,y,z)` over the whole slice. The demo copies the 16 chunk arrays
   into one flat 64x128x64 array at load (O(1) reads during meshing; copy cost
   is trivial next to generation). A streaming game should instead route
   `getBlock` through its chunk map — the facade contract allows that.

3. **Id semantics: builder ids 0-29 pass through cleanly via the stack's own
   `BUILDER_TO_LAB` remap** (`ids: 'builder'` on the provider). Verified
   water(8), leaves(10), sand/beach(5), snow(18/19) all render with correct
   semantics on real overworld terrain. Lossy-but-documented mappings that
   showed up on real data: **lava(28) → lab glowstone(9)**, i.e. the nether
   lava ocean renders as a solid glowstone-textured plane — no emissive lava
   material exists in the lab palette (see 6); glass(12)/portal(29) → air.

4. **The builder palette has NO torch block.** The task's "scan for
   glowstone/torch ids" can only half-apply: the only emissive blocks in
   `blocks.js` are glowstone(24, emissive 15), lava(28, emissive 15) and
   portal(29, emissive 12), and the overworld generator places **none of
   them** — overworld night scenes have zero derived light emitters. Glowstone
   only appears as nether ceiling blobs (322 blocks in our slice), lava only as
   the nether ocean (~8.4k blocks, surface-sampled 1-in-16 for registration),
   the end has no emitters at all. Builders wanting lit overworld nights must
   place torches/glowstone themselves.

5. **Light registration convention: register the ADJACENT AIR cell, not the
   emissive block.** `TorchLightManager.register()` centres the point light
   inside the given cell (+0.55 y for integer coords); registering the emitting
   block's own coords puts the light INSIDE an opaque block, and Lambert
   surfaces facing away from it receive nothing — our first nether shots were
   pitch black around 400 registered lights. Fixed by registering the exposed
   air neighbour (above for lava, below for hanging glowstone). Worth one line
   in the facade's API docs.

6. **Point-light falloff is torch-scale, not lava-lake-scale.** LIGHT_DISTANCE
   14 / decay 1.8 / max 10 pooled lights at high: a 3000-block lava ocean gets
   10 pools of ~4-block glow. Reads fine up close (screenshot 28) but a real
   nether needs an emissive material path for lava/glowstone (map builder
   `emissive` 0-15 into the voxel material), not more point lights.

7. **Slice edges are open.** Out-of-bounds reads return air, so the 64x64 slice
   renders as an island with cut walls (overworld) and the nether cavern's
   sliced sides open onto the skydome — the orange band in screenshot 28 is sky
   through the open sides, not lava glow. Cosmetic for a demo (framed around
   it), but a builder integrating for real should either mesh with neighbour
   chunks or clamp boundary reads to the boundary column so side walls cull.

8. **Sunlight penetrates the nether interior.** The stack has no per-block
   sky-light occlusion; the sun/hemisphere rig and shadow map light any face
   they reach, so at noon the cavern floor shows a sunlit strip through the
   open sides and the roof shadows the rest (verified during framing). Real
   cave/nether rendering needs the game's own light values fed into the mesher
   (the lab's AO term is geometry-only).

9. **Perf at 4x4 chunks (64x128x64), quality high, 1600x900 swiftshader:**
   - worldgen: overworld 89-92 ms, nether 32-36 ms, end 48 ms (16 chunks, one
     thread) — ~5.6 ms/chunk overworld.
   - greedy mesh of the whole slice: overworld 150 ms / 58,154 tris,
     nether 141 ms / 8,112 tris (35,118 quads pre-merge → 4,056 after, ~8.7x
     merge), end 114 ms / 6,964 tris. Meshing the slice as ONE volume is fine
     for a demo but a game should mesh per-chunk (16 x ~10 ms) to amortize
     edits.
   - composed frame at high: **34 draw calls / 197,773 triangles** (day
     overworld; night 33/194,837, cinderloom 24/17,203, nevermend 26/18,361).
     Draw calls are dominated by the stack's fixed passes (sky dome, water,
     reflection RT, post chain, SSAO, torch pool), not by world geometry — the
     whole 16-chunk world is 2 draw calls (solid + leaves). Headroom for a
     6-chunk render distance is therefore in mesh count, not in stack overhead.
   - `gfx.init()` end-to-end: 300-360 ms including atlas build and first mesh.

10. **Facade ergonomics: `waterLevel` must come from `SEA_LEVEL` (40), not the
    lab default (10).** Both the provider (`waterLevel`) and `init`
    (`waterLevel`) accept it — set at least one; forgetting both floods
    nothing but strands the water plane 30 blocks under the beach. For
    nether/end presets the water/underwater features are disabled instead:
    the builder's nether "sea" is lava at y=31 (a blue water plane would
    misrepresent it — see 3/6) and the end floats over void.
