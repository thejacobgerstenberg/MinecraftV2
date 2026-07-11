# textures/ — Loomfall texture pack system

A contract-exact, deterministic texture-pack system for the builder session:
`buildAtlas(packId, seed)` produces a drop-in replacement for the atlas built
by `origin/feat/voxel-sandbox-game:public/src/textures/TextureAtlas.js` — same
32px tiles, 16-column layout, `NearestFilter` / no mipmaps / sRGB
`THREE.CanvasTexture`, same `tileUV(name)` half-texel-inset UV convention
(`flipY=true`, v bottom-up, art top at `v1`).

The tile list (`TILE_NAMES` in `painters.js`) is **55 names**: the builder's
exact **33-name prefix, order frozen** (replicating
`feat/voxel-sandbox-game:public/src/textures/texturePacks.js` — do not touch),
plus **22 appended tiles** (birch/spruce wood sets, bricks, doors, torch,
gem/everthread ores, thread/weave/loom blocks, six wools, portal_frame). The
list is **append-only**: indices are part of the atlas layout contract, and
`selftest.mjs` fails the build if the prefix drifts.

Every render is deterministic: tiles are seeded per `(packId, tileName, seed)`
via `makeRng()` (xmur3 + mulberry32), so the same triple always yields
byte-identical pixels — verified 275/275 in the selftest.

## Files

| File | What it is |
|---|---|
| `painters.js` | Pure. 55 per-tile painters + `TILE_NAMES` + `makeRng` + overlay passes. No `three`, no DOM — draws through 5 Canvas2D calls only, so it runs under node. |
| `palettes.js` | Pure. Brand tile palette, every value derived from `brand/palette.json` @ `d8f96a2` (hue oaths respected — ember orange and cold cyan only where the brand allows). |
| `packFormat.js` | Pure. `definePack()` schema + knob validation + `PACK_REGISTRY`. |
| `packs.js` | Pure. The five pack definitions (knob transforms over the shared painters). |
| `atlas.js` | Browser. `buildAtlas(packId, seed)`, `genTexture(blockId, packId, seed)`, `BLOCK_TILES`, `tileForFace`. Imports `three`. |
| `labAdapter.js` | Browser. `createPackAtlas(packId, seed)` — bridges pack atlases into the lab demo's `createBlockAtlas()` contract. |
| `browser/` | In-game pack browser drawer (`packBrowser.js/.css`) + vendored ui-kit tokens. |
| `gallery.html` | Visual gallery of every tile in every pack + 2x2 tiling strips. |
| `test.html` + `selftest.mjs` | Self-tests (node shim + real-browser via Playwright). |

## The five packs

| id | Name | Style | Judge | Measured (selftest, ratios vs `default`) |
|---|---|---|---|---|
| `default` | Loomfall Classic | Clean 32px pixel art, brand palette as-is — the reference look | 8/10 | 1.00x by definition |
| `smooth` | Softstone | Cel-ish: gradients instead of grain, ramp ends merged | 7/10 | **1.39x sat** (rubric ≥ 1.2x) |
| `gritty` | Gritstone | Weathered: heavy grain, cracks, chipped edges | 8/10 | **0.57x sat, 1.34x contrast** (rubric ≤ 0.7x / ≥ 1.3x) |
| `woven` | Threadbare | Lore-native: warp/weft weave, cross-stitch dither, frayed edges, thread sheen | 9/10 | 0.97x sat, 1.19x contrast (style pack — no rubric gate) |
| `accessible` | Loudstone | High-contrast + 2px outlines + colorblind-safe ore *shapes* | 8/10 | **1.66x contrast** (rubric ≥ 1.4x) |

Judge verdict: **ship** (no broken tiles across all 275 pack-tile renders).
Known nits: `smooth` flattens netherrack/gravel more than ideal, and `woven`'s
lava reads slightly symmetric under the weave overlay.

Distinctness is enforced *numerically*, not by eye: the rubric ratios above
come from the brand `packVariants` spec (`brand/palette.json` @ `d8f96a2`) and
are asserted by `selftest.mjs` on every run. Seamless tiling is also asserted:
**250/250** opaque `(pack, tile)` pairs pass the torus seam check (25
alpha/art tiles exempt with stated reasons — water, glass, leaves, torch,
portal, doors…).

## Atlas API

```js
import { buildAtlas, genTexture, BLOCK_TILES, tileForFace } from './textures/atlas.js';

const atlas = buildAtlas('gritty', 0);
// -> { canvas, texture, tileUV(name), tileIndex(name), cols: 16, tilePx: 32 }

atlas.tileUV('grass_side');
// -> { u0, v0, u1, v1 } in GL UV space, u0<u1, v0<v1, half-texel inset baked
//    in on every edge (no bleeding under NearestFilter). Unknown names warn
//    once and fall back to index 0.
```

### `genTexture(blockId, packId, seed)` + `BLOCK_TILES`

`BLOCK_TILES` replicates the builder's `blocks.js` block-id table — **ids 0–29
frozen** (`feat/voxel-sandbox-game:public/src/blocks/blocks.js`): 0 air …
1 grass, 2 dirt, 3 stone … 28 lava, 29 portal — including its `tileForFace`
fallback semantics (`{all}` or `{top,bottom,side}`, resolving
side → top → bottom).

`genTexture(blockId, packId, seed)` returns a single 32×32 canvas for the
block's *side* tile, pixel-identical to the same tile inside
`buildAtlas(packId, seed)` (asserted by the browser selftest). Air/unknown ids
return a transparent canvas.

## Pack format (`definePack`)

A pack is a set of **knobs** applied over the shared painter library, plus
optional per-tile **overrides**:

```js
definePack({
  id: 'myPack',            // registry key — required
  name: 'My Pack',         // display name — required
  description: '…',
  knobs: { /* subset of KNOB_DEFAULTS; unknown keys THROW */ },
  overrides: { tileName: (ctx, px, rng, knobs, PALETTE) => { … } },
})
```

Knob schema (`KNOB_DEFAULTS` in `packFormat.js`; every knob has a default,
typos fail loudly):

| Knob | Default | Meaning |
|---|---|---|
| `sat` | 1.0 | HSV saturation multiplier |
| `light` | 1.0 | brightness multiplier |
| `contrast` | 1.0 | value contrast about mid-gray |
| `grain` | 1.0 | per-pixel noise amplitude |
| `gradients` | false | soft large-scale shading instead of grain |
| `rampMerge` | false | soft-clamp value extremes (smooth) |
| `wear` | 0 | 0..1 extra cracks/scratches inside painters |
| `edge` | 0 | 0..1 weathered-edge pixels post-pass |
| `outline` | 0 | darkened tile border width in px (accessible) |
| `weave` / `dither` / `sheen` / `fray` | 0 | Threadbare's stitched-cloth overlays |
| `patterns` | false | colorblind-safe ore shape stamps |
| `accentKeep` | 0.5 | how much accent colors resist a pack's desaturation |

### Adding a 6th pack (~20 lines)

Append to `packs.js` — no other file needs to change; the registry, atlas
builder, lab adapter, pack browser, gallery and selftests all iterate
`PACK_REGISTRY`:

```js
import { css } from './painters.js';

export const duskPack = definePack({
  id: 'dusk',
  name: 'Duskloom',
  description: 'Moody violet-hour grade with a hand-inked stone.',
  knobs: {
    sat: 0.8,        // muted…
    light: 0.9,      // …and darker
    contrast: 1.15,
    grain: 1.3,
    accentKeep: 0.7, // but ores/lava keep most of their color
  },
  overrides: {
    // Full control when knobs aren't enough: repaint one tile from scratch.
    // (Colors are [r,g,b] arrays from palettes.js; css() makes rgba strings.)
    stone(ctx, px, rng, knobs, PALETTE) {
      ctx.fillStyle = css(PALETTE.stone);
      ctx.fillRect(0, 0, px, px);
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = css(PALETTE.stone_dark, 0.5);
        ctx.fillRect((rng() * px) | 0, (rng() * px) | 0, 2, 1);
      }
    },
  },
});
```

Then run `node graphics-lab/textures/selftest.mjs` — determinism and seam
checks apply to the new pack automatically (only the three rubric-gated packs
have metric assertions). Add the id to the `@param` docs in `labAdapter.js` if
you're feeling thorough.

## `labAdapter.js` — driving the graphics-lab demo

`createPackAtlas(packId, seed)` returns an object with **exactly** the shape
of the lab's `src/textures.js` `createBlockAtlas()`, so `voxelMesher`,
`greedyMesher`, `voxelMaterial` and the first-person viewmodel consume pack
atlases unchanged. Two deliberate transforms (full derivation in the file
header):

1. **Raw-rect `tileUV`** — the pack atlas bakes a half-texel inset into its
   UVs, but every lab consumer *adds its own* half-texel inset on top of raw
   rects (mesher LUTs, the tiled greedy shader, the viewmodel UV remap).
   Passing pre-inset rects through would double-inset (visible zoom/crop on
   every tile), so the adapter recomputes **raw, un-inset** rects from the
   tile index.
2. **Square re-blit** — the pack canvas is 16 cols × 4 rows = 512×128,
   non-square; the lab's tiled material uses *scalar* uniforms
   (`uTileSizeUV`, `uTileInset`) applied to both u and v, which is only
   correct on a square atlas. The adapter re-blits all 55 tiles 1:1 (no
   scaling, smoothing off) into an 8-column 256×256 square canvas, so
   `tileSizePx: 32 / atlasSizePx: 256 / texelSize: 1/256` are consistent on
   both axes. No flip is needed — both atlases share the flipY UV convention.

In the demo: `demo.setTexturePack(id)` swaps the live atlas
(`'lab-classic'` = the original `createBlockAtlas()`, or any registry id),
re-meshes through the existing rebuild path, rebuilds the held-item
viewmodel, persists to `localStorage['mc2.texturePack']` and emits a
`'pack:switched'` CustomEvent on `window`.

## `browser/` — in-game pack browser

`createPackBrowser({ demo })` mounts a drawer with one card per pack (live
thumbnail strips blitted straight off each pack's real atlas) and a launcher
button next to the settings gear; clicking a card calls
`demo.setTexturePack(id)`. Hidden under `?nogui=1` and in scenic mode.

Styling follows the `origin/feature/ui-kit` conventions (`lf-*` classes,
`var(--lf-*)` custom props only). The needed tokens are **vendored** in
`browser/vendored-tokens.css` — copied verbatim from
`ui-kit/tokens.css` @ `origin/feature/ui-kit` (commit `4584b34`) so
graphics-lab never imports cross-branch at runtime. To re-vendor:

```bash
git show origin/feature/ui-kit:ui-kit/tokens.css > graphics-lab/textures/browser/vendored-tokens.css
# then restore the provenance header at the top of the file
```

Both stylesheets are linked from `graphics-lab/index.html`.

## Running the gallery and selftests

```bash
# Gallery: every tile of every pack + 2x2 seam-check strips.
cd graphics-lab
python3 -m http.server 8099
# open http://localhost:8099/textures/gallery.html         (all packs)
# open http://localhost:8099/textures/gallery.html?pack=woven   (one pack)

# Selftests. Part A is pure node (software Canvas2D shim): frozen 33-prefix,
# painter coverage, byte-identical determinism, pack metric rubric, torus
# seam checks, missing-tile fallback. Part B launches headless chromium
# against test.html: real-canvas determinism, genTexture == atlas pixels,
# UV fallback + inset contract, literal 2x2-draw tiling.
node graphics-lab/textures/selftest.mjs               # full run
SKIP_BROWSER=1 node graphics-lab/textures/selftest.mjs  # node-only parts
```
