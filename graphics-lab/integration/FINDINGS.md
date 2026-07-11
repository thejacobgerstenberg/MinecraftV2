# Real-worldgen integration — findings

Setup: builder `TerrainGenerator` (vendored byte-exact, see
`builder/PROVENANCE.md`, branch head `98c7ea9`) generating 4x4 chunks of
16x16x128 (`CHUNK_SX/SZ/SY`, a 64x128x64 slice), adapted to the GraphicsStack
facade as a `{ getBlock, size, ids: 'builder' }` volumeProvider, full stack at
quality **high**. Demo: `graphics-lab/integration-demo.html`
(`?preset=day|night|cinderloom|nevermend`). Screenshots 26-29 in
`graphics-lab/screenshots/`. Headless runs: **zero console errors, zero
warnings** on all four presets.

**Status sweep (this branch, commit pending):** graphics-lab-owned rows fixed
via the emissive material path (integrate.js third geometry group +
`emissiveOf` provider option) and the emitter helpers
(`graphics-lab/emitters.js` + `EMITTERS.md`). Re-verified headless against the
same vendored generator, all four presets, zero console errors; lava-view
pixel metrics below are measured at a fixed in-cavern camera
(pos 32,52,8 -> look 32,31,44), warm-bright = pixels with R>=140, R-B>=50,
luminance>=120.

Numbered findings — every mismatch/breakage/friction hit:

1. **Import resolution: clean — no adapters needed.** The generator's whole
   import closure (4 files) is pure ESM with relative paths and no `three`
   dependency. Vendored with the original `public/src/` layout preserved,
   everything resolved untouched; `adapters.js` was never created because no
   API mismatch materialized at the module-loading level.
   *Status: NO ACTION NEEDED (was never a defect).*

2. **Chunk-format friction: column-major index vs (x,y,z) accessor.** Builder
   chunks are `Uint8Array(16*16*128)` indexed `blockIndex(x,y,z) = x + z*16 +
   y*256` per chunk, while the stack meshers want a world-space
   `getBlock(x,y,z)` over the whole slice. The demo copies the 16 chunk arrays
   into one flat 64x128x64 array at load (O(1) reads during meshing; copy cost
   is trivial next to generation). A streaming game should instead route
   `getBlock` through its chunk map — the facade contract allows that.
   *Status: OPEN (builder-owned) — inherent to the builder's chunk layout; the
   facade already accepts a chunk-map-backed `getBlock`, nothing further to
   fix on the lab side.*

3. **Id semantics: builder ids 0-29 pass through cleanly via the stack's own
   `BUILDER_TO_LAB` remap** (`ids: 'builder'` on the provider). Verified
   water(8), leaves(10), sand/beach(5), snow(18/19) all render with correct
   semantics on real overworld terrain. Lossy-but-documented mappings that
   showed up on real data: **lava(28) → lab glowstone(9)**, i.e. the nether
   lava ocean renders as a solid glowstone-textured plane — no emissive lava
   material exists in the lab palette (see 6); glass(12)/portal(29) → air.
   *Status: FIXED (commit pending) — emissive material path: builder blocks
   with `emissive` 1-15 (glowstone 24 / lava 28 / portal 29) now mesh into a
   third geometry group with their NATIVE tiles and a self-lit, UV-scrolling
   material (`integrate.js` buildEmissiveGeometry/createEmissiveChunkMaterial,
   provider `emissiveOf` — on by default for `ids:'builder'`; glass still →
   air, the glowstone remap remains the documented `emissive:false` fallback).
   Evidence: cinderloom lava-view warm-bright fraction 0.013 → 0.877 (mean
   luminance 5.4 → 149.7), lava tile pattern + scroll visible, zero console
   errors.*

4. **The builder palette has NO torch block.** The task's "scan for
   glowstone/torch ids" can only half-apply: the only emissive blocks in
   `blocks.js` are glowstone(24, emissive 15), lava(28, emissive 15) and
   portal(29, emissive 12), and the overworld generator places **none of
   them** — overworld night scenes have zero derived light emitters. Glowstone
   only appears as nether ceiling blobs (322 blocks in our slice), lava only as
   the nether ocean (~8.4k blocks, surface-sampled 1-in-16 for registration),
   the end has no emitters at all. Builders wanting lit overworld nights must
   place torches/glowstone themselves.
   *Status: OPEN (builder-owned: only the builder can add ids to blocks.js) —
   helper shipped: `emitters.js` + `EMITTERS.md`. `makeEmissiveBlockMaterial`
   + `attachTorchVisual` cover the future torch id's visuals, and
   `registerEmitterLights` reads `getBlockDef(id).emissive` so a new torch id
   lights up with zero lab changes. Demo evidence: the night preset drops 12
   demo glowstone blocks on the real overworld slice — they glow, halo and
   light their surroundings (`?preset=night`).*

5. **Light registration convention: register the ADJACENT AIR cell, not the
   emissive block.** `TorchLightManager.register()` centres the point light
   inside the given cell (+0.55 y for integer coords); registering the emitting
   block's own coords puts the light INSIDE an opaque block, and Lambert
   surfaces facing away from it receive nothing — our first nether shots were
   pitch black around 400 registered lights. Fixed by registering the exposed
   air neighbour (above for lava, below for hanging glowstone). Worth one line
   in the facade's API docs.
   *Status: FIXED (commit pending) — the rule is now CODE, not lore:
   `emitters.js registerEmitterLights` always picks the best adjacent air
   cell (top face preferred, then sides, then below) and skips fully-enclosed
   emitters; documented for the builder in `EMITTERS.md`. The integration
   demo now uses the helper instead of its hand-rolled scan. Evidence:
   cinderloom re-run registers 400 lights with lit surroundings, glowstone
   demo blocks light the night beach.*

6. **Point-light falloff is torch-scale, not lava-lake-scale.** LIGHT_DISTANCE
   14 / decay 1.8 / max 10 pooled lights at high: a 3000-block lava ocean gets
   10 pools of ~4-block glow. Reads fine up close (screenshot 28) but a real
   nether needs an emissive material path for lava/glowstone (map builder
   `emissive` 0-15 into the voxel material), not more point lights.
   *Status: FIXED (commit pending) — exactly that emissive material path now
   exists (see 3): the whole lava ocean self-illuminates per fragment
   (level/15 into the emissive term, bloom halo at night) independent of the
   10-light pool; the pool is now only for surroundings-lighting, with
   per-emitter intensity scaling (`register(pos, { intensity })`). Evidence:
   lava-view warm-bright 0.877 vs 0.013 before, whole-ocean glow instead of
   10 pools; emissive group = 2,162 tris in the cinderloom slice.*

7. **Slice edges are open.** Out-of-bounds reads return air, so the 64x64 slice
   renders as an island with cut walls (overworld) and the nether cavern's
   sliced sides open onto the skydome — the orange band in screenshot 28 is sky
   through the open sides, not lava glow. Cosmetic for a demo (framed around
   it), but a builder integrating for real should either mesh with neighbour
   chunks or clamp boundary reads to the boundary column so side walls cull.
   *Status: OPEN (builder-owned) — a demo-slice artifact, not a stack defect:
   the fix (neighbour-chunk reads or boundary clamping in `getBlock`) lives in
   the game's chunk streaming, which only the builder has. Cosmetic here, so
   deliberately left as documented guidance.*

8. **Sunlight penetrates the nether interior.** The stack has no per-block
   sky-light occlusion; the sun/hemisphere rig and shadow map light any face
   they reach, so at noon the cavern floor shows a sunlit strip through the
   open sides and the roof shadows the rest (verified during framing). Real
   cave/nether rendering needs the game's own light values fed into the mesher
   (the lab's AO term is geometry-only).
   *Status: OPEN — requires per-block sky-light values that only the game
   simulates (flood-fill light propagation is game state, not rendering); the
   mesher's attribute path (`ao`, now `emissiveParams`) is the natural place
   to feed them in once the builder computes them. Out of scope for this
   pass.*

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
   *Status: NO ACTION NEEDED (informational). Post-fix note: the emissive path
   adds one greedy sweep per distinct emissive id present (nether: lava +
   glowstone → slice re-mesh ~270-320 ms total vs ~140 ms before, still
   build-time only; overworld day is unaffected — 0 emissive ids). Frame-rate
   cost is one extra draw call for the emissive group (2,162 tris in the
   nether slice).*

10. **Facade ergonomics: `waterLevel` must come from `SEA_LEVEL` (40), not the
    lab default (10).** Both the provider (`waterLevel`) and `init`
    (`waterLevel`) accept it — set at least one; forgetting both floods
    nothing but strands the water plane 30 blocks under the beach. For
    nether/end presets the water/underwater features are disabled instead:
    the builder's nether "sea" is lava at y=31 (a blue water plane would
    misrepresent it — see 3/6) and the end floats over void.
    *Status: NO ACTION NEEDED (ergonomics note; already documented in
    INTEGRATION.md and honoured by the demo). The nether lava "sea" itself is
    no longer a misrepresentation risk — it now renders as actual glowing
    lava (see 3).*
