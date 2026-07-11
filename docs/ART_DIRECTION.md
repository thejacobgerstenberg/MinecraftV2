# ART_DIRECTION.md — Procedural Texture System

> **Scope:** every block/liquid texture in this game is **drawn in code** at runtime.
> **ZERO Mojang / Minecraft / third-party image assets.** No PNGs, no atlases shipped.
> Every texel is produced by the recipes in this document against a 16×16 `ImageData`
> buffer. This file is the single source of truth for builder agents implementing the
> texture generator.
>
> **Stack context:** browser client (TypeScript + Three.js/WebGL, greedy-meshed voxel
> chunks), authoritative Node server (WebSockets), shared TS types. Textures are baked
> **once on the client** into a `THREE.DataTexture` / `CanvasTexture` atlas at boot; the
> server never touches pixels. All formulas below are integer-deterministic so a texture
> can be regenerated identically from `(blockId, packId, seed)`.

---

## 0. Architecture — read this first

Every texture in the game is produced by **one pipeline**. Materials and style packs are
just **parameter sets** fed to that pipeline. Do not write per-block bespoke draw code;
write the pipeline once and drive it with data.

```
for each texel (x, y) in 16×16:
    struct = structureField(x, y, blockSpec)   // grayscale scalar ∈ [0,1]   (§4 recipes)
    struct += jitter(x, y, pack)                // micro grit                  (§4.8)
    struct  = clamp(struct, 0, 1)
    idx     = quantize(struct, ramp.length, pack) // banding → pixel-art        (§4.9)
    albedo  = ramp[idx]                          // per-material color LUT      (§2)
    rgb     = applyGlobalLight(albedo, struct, pack) // cohesion multiply       (§1.4)
    write RGBA(rgb, alpha)
```

**The single most important decision:** the *structure field* (grayscale, §4) and the
*color ramp* (LUT, §2) are **decoupled**.

- Re-skin any block → swap the **ramp**.
- Restyle the whole game (default → gritty) → swap the **pack parameter set** (§3).
- The structure recipe (which noise, which pattern) stays identical across all three packs.

> A **pack is a parameter set**, not a new codebase. `default`, `smooth-cartoon`, and
> `gritty` all call the same `structureField` and the same tiling functions; they differ
> only in the numbers listed in §3.

---

## 1. Global rules

### 1.1 Texel density
- **16×16 per block face.** 256 texels total. Non-negotiable — it defines feature budget.
- Feature legibility at 16px:
  - **1px** = grain/noise only. Not a "feature."
  - **2–3px** = smallest *readable* feature (mortar line, ore fleck, plank groove).
  - **4px+** = an intentional shape (brick, knot, leaf cluster).
- **Feature budget per texture: 2–4 distinct features + one noise bed.** More = mush.
- Faces of the same block that differ (grass top vs side, log side vs top) are **separate
  16×16 textures** with separate specs; they share a ramp where noted.

### 1.2 Tileable edges (mandatory)
- Every terrain texture **wraps on both X and Y**. Renderer uses `RepeatWrapping`.
- **All noise must be periodic.** Hash lattice/cell coords through `mod(i, P)` where `P`
  divides 16. Only use frequencies/periods `P ∈ {1,2,4,8,16}` for anything that tiles.
- **No asymmetric bevels or directional borders** on tiling blocks (grass, stone, sand,
  ore). A darkened top-left edge creates a visible grid when repeated. If you want tile
  definition use a **subtle symmetric** darkening or none.
- Bevels/vignettes are allowed **only** on single-object blocks that never tile across a
  surface (crafting table, furnace, chest) — not covered by the 30 core specs here.
- **Validation gate:** render a 2×2 grid of the tile; any visible seam = a non-`mod`-wrapped
  noise or pattern. Builder agents must add a seam test (§6.4) to CI-style self-check.

### 1.3 Palette philosophy
- **Never use pure gray (S=0).** "Neutral" materials carry a **3–8% saturation bias**
  (stone = faint cool-blue ~216°, sand/dirt = warm-tan). Fully desaturated blocks look
  dead beside hue-shifted ones.
- **Value ramps have 4–5 stops** at 16×16 (3 reads flat, 6+ turns to mush).
- Space values **non-linearly** — more resolution in midtones. Default V set (dark→light):
  `0.42, 0.52, 0.62, 0.72, 0.82`.
- Keep albedos in a **mid band 0.25–0.85**. No pure black/white on a block face; reserve
  extremes for tiny accents (ore sparkle, deep crack) covering ≤3 texels.
- **Hue-shift, don't just darken:** as value drops, rotate hue toward the cool/shadow
  anchor (~250°) and hold/raise saturation; as value rises, rotate toward the warm/light
  anchor (~50°) and **lower** saturation. Saturation across a ramp is a **hump** (peaks in
  midtones, drops hardest at the highlight).

### 1.4 Contrast / readability targets
- **Contrast budget** = `max(V) − min(V)` per texture:
  - default ≈ **0.35**, smooth-cartoon ≈ **0.25**, gritty ≈ **0.55**.
- Every block must be **recognizable at a glance while tiled** and hold a readable
  silhouette of its dominant feature. If two adjacent block types are confusable at 1×
  zoom in a 2×2 tile test, increase the *feature* contrast (not global contrast).
- Target a minimum ΔL (OKLab lightness) of **~0.12** between the two ramp stops that form a
  block's primary readable feature (e.g. mortar vs brick).

### 1.5 Ambient-occlusion baking policy
- **Texture-level AO is NOT baked into the 16×16 albedo.** Textures are flat, tileable,
  edge-neutral (§1.2). Baking a dark border into the texture double-darkens once the mesh
  AO runs and creates grid artifacts.
- **Contact / cavity AO is done in the renderer**, per-vertex, by the greedy mesher:
  compute vertex AO from the 3 neighbor voxels at each corner (standard 0–3 occlusion
  level → multiply factor `[1.0, 0.80, 0.62, 0.48]`) and pass it as a vertex attribute the
  fragment shader multiplies against the sampled albedo.
- **Exception — intra-texture form shading** (e.g. the rounded highlight on smooth-cartoon,
  the cell shading inside cobblestone) IS baked, because it is *material* shading, not
  *contact* occlusion. Rule of thumb: shading that would move if the block moved = bake it;
  shading caused by neighbors = renderer.

#### 1.5.1 Directional per-face shade (renderer, NOT baked) — P0
Vanilla multiplies every face's final color by a **fixed constant chosen by the face
normal**, independent of light, AO, or texture. This is THE reason a single-texture solid
block (stone, dirt) still reads as a 3D cube and grass tops look brighter than grass sides.
Without it, all six faces of a solid block render identically flat.
- `shade[6]` by face normal (a plain multiply, in **linear** space per §6.6, applied after
  texture sample and combined with AO §1.5 + light §1.7):

  | face | normal | `shade` |
  |---|---|---|
  | up (top)      | `+Y` | `1.00` |
  | down (bottom) | `−Y` | `0.50` |
  | north / south | `±Z` | `0.80` |
  | east / west   | `±X` | `0.60` |

- It is a **face property, orthogonal to §4.11**. §4.11 bakes a structure-driven warm/cool
  multiply INTO the 16×16 albedo; `shade[6]` is **not** in the texture — it is applied per
  face at mesh/shader time. Both apply: the sampled texel already carries §4.11, and the mesh
  multiplies `shade`.
- Emit `shade` as a per-vertex attribute (all 4 verts of a quad share one value) or branch on
  the quad normal in the fragment shader. Do NOT bake it into the atlas (it must vary by face,
  and the same 16×16 is reused on all six faces of most blocks).

#### 1.5.2 Greedy meshing vs. per-corner AO / variants / rotation — P0 (resolve explicitly)
§0 declares "greedy-meshed", but §1.5 bakes per-vertex AO from 3 neighbor voxels per corner.
**Two faces with differing corner-AO cannot merge into one greedy quad** without the classic
AO-anisotropy artifact, and greedy merging also erases per-face random rotation/variant
(§6.5), directional textures (log axis §5.8, furnace front §6.1), and per-face `shade`.
Vanilla does NOT greedy-mesh — it emits one quad per exposed face. Pick ONE and document it
in the mesher:
- **(A) per-face quads** — vanilla-accurate, simplest correctness. Recommended default.
- **(B) keyed greedy merge** — merge two adjacent faces ONLY when every element of the merge
  key `{textureId, faceShade, cornerAO[0..3], variantIndex, uvRotation, tintSource}` is equal.
  Faces differing on any key stay separate. AO/textured faces rarely merge; large flat
  same-lit runs (e.g. a stone wall interior) still collapse.

Never merge across differing AO/variant/rotation — that is the bug this section forbids.

#### 1.5.3 Render layers + translucency sorting — P0
Every block face is assigned a **render layer** (field `renderLayer` on `BlockSpec`, §6.1):
- `solid` — opaque, depth-write, no blend (stone, dirt, most blocks; also opaque lava).
- `cutout` — `alphaTest` hard edge, no blend, no mip alpha bleed (glass frame, rails, cross
  plants §5.31).
- `cutout_mipped` — `alphaTest` + mipmaps with **alpha-weighted** downsample (§6.4) — leaves.
- `translucent` — alpha-blended and **depth-sorted** (water, ice, stained_glass, slime, honey).

`translucent` faces **cannot be naively greedy-meshed** and MUST be drawn **back-to-front,
per quad, re-sorted every frame by distance to the camera** — otherwise water behind water
disappears from wrong overdraw. Per-chunk draw order: `solid → cutout → cutout_mipped →
translucent (sorted last)`.

### 1.6 Biome tinting approach (grayscale mask + runtime tint)
- Biome-tintable blocks (`grass_top`, `grass_side` overlay, `oak_leaves`, `water`, tall
  grass) are generated **twice-decoupled**:
  1. Generate the texture with a **neutral/grayscale-luma ramp** (a desaturated version of
     the material ramp — keep the value structure, drop hue/sat toward gray) **plus** a
     separate **1-channel tint mask** (`Uint8` alpha, 0 = no tint, 255 = full tint).
  2. At render time multiply `finalRGB = mix(baseRGB, baseRGB * biomeTint, mask/255)`,
     where `biomeTint` is an `RGB` looked up from the biome table by the shader/mesher.
- Only the **masked** texels tint; e.g. `grass_side` tints the top grass fringe but leaves
  the dirt band untouched (mask = 0 on dirt texels).
- Biome tint table (multipliers, `RGB` 0–1), consumed at runtime, **not** baked:

  | biome | grass/foliage tint | water tint |
  |---|---|---|
  | plains | `(0.57, 0.74, 0.35)` | `(0.25, 0.46, 0.90)` |
  | forest | `(0.47, 0.67, 0.30)` | `(0.22, 0.44, 0.85)` |
  | desert | `(0.75, 0.72, 0.33)` | `(0.24, 0.50, 0.86)` |
  | taiga  | `(0.45, 0.62, 0.44)` | `(0.20, 0.42, 0.80)` |
  | swamp  | `(0.42, 0.52, 0.30)` | `(0.28, 0.44, 0.36)` |
  | snowy  | `(0.50, 0.66, 0.52)` | `(0.30, 0.50, 0.92)` |

- Blocks **not** in the tintable set generate with their full-color ramp and emit a mask of
  all-zero (skip the tint multiply entirely — mask absent = branch off).

#### 1.6.1 Tint source is a per-block enum, not a single boolean — P1
The one `biomeTint` channel + `tintMask` cannot express fixed-override foliage or non-biome
tint sources. Add `tintSource` to `BlockSpec` (§6.1); the discrete table above only feeds the
`biome-*` sources:
`tintSource: 'biome-grass' | 'biome-foliage' | 'biome-water' | 'fixed' | 'redstone-power' | 'none'`.
- `fixed(color)` — foliage that is **NOT** biome-tinted (overrides the table): spruce_leaves
  `#619961`, birch_leaves `#80A755`, lily_pad `#208030`. (`melon_stem`/`pumpkin_stem` also use
  a fixed→age gradient.)
- `redstone-power` — tint by signal level 0–15: `redstone_wire` lerps `#4B0000` (power 0) →
  `#FC3B00` (power 15).
- **swamp grass/foliage** is a special case even though it is biome-tinted: pick between
  `#4C763C` and `#6A7039` per-column by a **low-frequency Perlin sample** (§4.4), not the flat
  swamp table constant.

#### 1.6.2 Continuous grass/foliage colormap (v2 parity target; keep the table for v1) — P1
The discrete 6-biome table gives hard biome color seams and no altitude variation. Vanilla
samples grass/foliage from a **256×256 triangular gradient** indexed by clamped
`(temperature, downfall)`:
```
x = floor(clamp(1 - temp, 0, 1) * 255)
y = floor(clamp(1 - temp*rain, 0, 1) * 255)   // rain = downfall
// texels above the hypotenuse (x + y > 255) are undefined → clamp to the diagonal
color = gradient[x][y]                          // generate via bilinear over 3 corner colors
```
Then **blend** across a neighborhood — average the per-biome grass color over a `radius`
(vanilla samples the biome at each of an ~11×11 grid around the block and averages the RGB)
for seam-free biome transitions — and **darken by altitude** (subtract a small value as world
`y` rises). Implement `grassColorAt(temp,rain)` / `foliageColorAt(temp,rain)` + a blend pass;
the §1.6 table stays the v1 approximation. `blendRadius` ≈ biome grid corner spacing (target
smooth, not blocky, biome edges).

### 1.7 Block light & skylight (flood-fill lighting model) — P1
`flags.emissive:boolean` collapses a core system: brightness is a **level, not a flag**, and
AO (§1.5) + per-face shade (§1.5.1) presuppose a light result to multiply against. Replace
`emissive` with `lightEmission: 0..15` on `BlockSpec` and add a flood-fill light engine
(recomputed per chunk on the client, or authoritative on the server):
- **Two channels, each 0..15, stored per voxel (packed nibble):** `skyLight`, `blockLight`.
- **Skylight:** any voxel with open sky above = 15; it propagates down at full strength through
  air and sideways at **−1 per block step**, blocked (set 0) by opaque voxels. Day/night scales
  skylight's *contribution*, not its stored value.
- **Blocklight:** each emitter seeds its own cell with `lightEmission`, then a BFS flood-fill
  spreads it outward **−1 per step**, stopping at opaque voxels.
- **Emission table (0..15):** `glowstone 15`, `sea_lantern 15`, `lava(source) 15`,
  `jack_o_lantern 15`, `redstone_lamp(lit) 15`, `torch 14`, `redstone_ore(active) 9`,
  `redstone_torch 7`, `magma 3`, `brewing_stand 1`, everything else `0`.
- **Per-vertex brightness** = `max(skyLight * dayNight, blockLight)` mapped through a curve
  (vanilla ≈ `0.05 + 0.95 * pow(0.8, 15 - level)`), then combined with AO and `shade[6]`.
- **Full compose order (all in linear space, §6.6):**
  `final = texelRGB(sRGB→linear) × shade[6] × aoFactor × lightBrightness`, then linear→sRGB.
- Emitters (lava, glowstone) additionally **skip §4.11 in the texture** (already noted for
  lava) and clamp their minimum brightness to their own emission level so they self-illuminate.

---

## 2. Master palette

### 2.1 Structure of the data
Each material family is a **5-stop ramp**, index `0 = shadow … 4 = highlight`, generated by
the §1.3 hue-shift rule. Hex values below are the **`default` pack**. Packs transform these
per §3.4 (a pack does not store its own hex table — it stores a *transform* applied to the
default ramp, so palettes stay centralized).

Ramps are stored as `RAMP: Record<MaterialFamily, [Hex,Hex,Hex,Hex,Hex]>`.

### 2.2 The ramps (default pack)

| Family | 0 shadow | 1 dark | 2 mid | 3 light | 4 highlight | anchor H° | notes |
|---|---|---|---|---|---|---|---|
| `grass`      | `#32733F` | `#3E8541` | `#569E4F` | `#82B863` | `#ADD179` | 132→85 | H cools in shadow, warms in light; S 56→42 |
| `dirt`       | `#573C2A` | `#704D32` | `#8A623F` | `#A37F55` | `#B89D6E` | 24→38 | warm brown |
| `stone`      | `#64666B` | `#7D7F85` | `#96999E` | `#B0B4B8` | `#D1D0CB` | 216 | cool bias, S≈4–7% |
| `cobble`     | `#54575C` | `#72757A` | `#909499` | `#AAAFB2` | `#CCCAC4` | 215 | darker+higher contrast than stone |
| `sand`       | `#A89562` | `#BDAA71` | `#D1C086` | `#E0D39D` | `#EDE4B9` | 46 | warm straw |
| `gravel`     | `#615C57` | `#807974` | `#909399` | `#AAAEB2` | `#CCC9C0` | 24/216 | mixed warm+cool pebbles |
| `wood_bark`  | `#4C3123` | `#66422D` | `#80593D` | `#997353` | `#AD906C` | 20→33 | log side |
| `wood_planks`| `#7A5E42` | `#94734D` | `#AD8C61` | `#C2A678` | `#D6C396` | 30→42 | lighter, yellower than bark |
| `leaves`     | `#225222` | `#356B30` | `#4D8540` | `#729E55` | `#9DB86E` | 120→82 | deep green, tint mask = full |
| `water`      | `#284A70` | `#37638A` | `#497FA3` | `#62A2BD` | `#85C6D6` | 212→192 | translucent, alpha ~0.78 |
| `lava`       | `#8C1D11` | `#AD330E` | `#D15A0A` | `#EB9413` | `#FAD646` | 6→48 | **emissive**, extremes allowed |
| `coal`       | `#202124` | `#2E3033` | `#424447` | `#5C5E61` | `#7A7D80` | 218 | ore accent, near-black |
| `iron_ore`   | `#806C59` | `#998165` | `#B29A79` | `#CCB997` | `#E0D6B8` | 34 | buff/tan flecks |
| `gold`       | `#99742B` | `#BD952A` | `#E0BC2D` | `#F2D852` | `#FCEE8D` | 40→52 | saturated yellow |
| `diamond`    | `#51A2A8` | `#61BFC2` | `#7BDBDB` | `#9DEDEA` | `#C3FAF6` | 180 | cyan gem accent |
| `bedrock`    | `#2B2C2E` | `#3E4042` | `#57595C` | `#76787A` | `#949799` | 216 | dark, high jitter |
| `snow`       | `#BCC5D1` | `#CED6E0` | `#E1E7ED` | `#F0F4F7` | `#FFFFFC` | 210 | bright, low contrast |
| `ice`        | `#88AEC2` | `#9FC5D6` | `#B8D9E6` | `#D3EBF2` | `#EBF9FC` | 196 | translucent, alpha ~0.72 |
| `clay`       | `#94867F` | `#A8978D` | `#BDACA0` | `#D1C4B8` | `#E3DBD1` | 24 | soft neutral warm |
| `glass`      | `#ABBEC7` | `#BFD1D9` | `#D3E2E8` | `#E6F1F5` | `#F5FBFC` | 196 | mostly transparent, frame only |
| `brick`      | `#703A2F` | `#8A4837` | `#A35B45` | `#B8775C` | `#CC9B7A` | 10→24 | terracotta red |
| `sandstone`  | `#A3946F` | `#B8A881` | `#CCBE97` | `#DED3B1` | `#EDE7CC` | 44 | paler, layered sand |
| `wool_white` | `#CCC9C4` | `#DBD9D5` | `#E1E5E8` | `#F0F3F5` | `#FFFFFC` | 40/210 | base for dyed wool (recolor via ramp swap) |
| `metal_iron` | `#787A80` | `#96999E` | `#B0B4B8` | `#CBCED1` | `#E6E4DF` | 210 | refined metal (iron block) |
| `netherrack` | `#522A29` | `#6B3731` | `#854B40` | `#9E6959` | `#B88E79` | 2→20 | bonus material |
| `grass_dry`  | `#70704A` | `#8A8858` | `#A39F6C` | `#BDB488` | `#D1C7A7` | 60→46 | savanna/dead grass variant |
| `deepslate`  | `#33333A` | `#41414A` | `#4F4F58` | `#626269` | `#7A7A80` | 216 | dark cool gray, **higher contrast than stone**; alt ore base (y<0) |
| `obsidian`   | `#120C22` | `#1B1330` | `#281C44` | `#392A5E` | `#574682` | 265 | violet-black identity block; extremes allowed like `bedrock` |
| `quartz`     | `#D9D4CC` | `#E4E0D9` | `#EDEAE3` | `#F5F3EE` | `#FFFEFA` | 45 | warm white, low contrast (quartz_block / nether_quartz) |
| `nether_brick`| `#241419`| `#2E1A20` | `#3A222A` | `#4A2E38` | `#5E3E4A` | 345 | dark maroon |
| `end_stone`  | `#C4C29A` | `#D2D0A9` | `#DEDCB8` | `#E9E7C8` | `#F4F2DA` | 56 | pale yellow-cream |
| `prismarine` | `#2C6E6A` | `#397F79` | `#499089` | `#63A79E` | `#86C2B6` | 175 | teal; animated shimmer (§5.39) |
| `glowstone`  | `#7A5A1E` | `#A6791F` | `#D0A233` | `#EEC862` | `#FBE79E` | 44 | **emissive** gold (lightEmission 15) |
| `sponge`     | `#9E8E3A` | `#B6A445` | `#CBBB55` | `#DBCE74` | `#E8DE9C` | 50 | mustard, porous |
| `pumpkin`    | `#8A4A16` | `#A65C1B` | `#C67322` | `#DE8E3B` | `#EFAF66` | 28 | orange rind (top/side/front) |
| `melon`      | `#3C6E2A` | `#4C8434` | `#5E9C42` | `#7EB85E` | `#A6D186` | 100 | green rind; flesh drawn from `brick`-red accent in spec |
| `hay`        | `#8E7526` | `#AC8E32` | `#C6A845` | `#DBC06E` | `#E8D69C` | 46 | straw-gold; axis pillar (§5.11) |
| `tnt`        | `#8E2A22` | `#A8362A` | `#C24838` | `#D66A54` | `#E89480` | 6 | red body; white label band in spec |
| `redstone`   | `#5A0E0E` | `#7C1616` | `#A61F1F` | `#D03A2A` | `#F65A42` | 0 | ore accent (redstone_ore); also `redstone-power` tint anchor |
| `lapis`      | `#1E3A7A` | `#26499A` | `#3160BE` | `#4E80D4` | `#79A6E6` | 222 | blue ore accent (lapis_ore) |
| `emerald`    | `#0E6238` | `#14854A` | `#1FA860` | `#4FCB86` | `#86E4B0` | 150 | green gem accent (emerald_ore) |
| `copper`     | `#7E4529` | `#985531` | `#B4693E` | `#CE8354` | `#E2A276` | 22 | bright orange metal — oxidation stage 0 (§5.37) |
| `copper_oxidized`| `#2E6E5E`| `#3C8272`| `#4E9A86` | `#6EB49E` | `#96CCB6` | 165 | teal-green — oxidation stage 3 (interpolate stages 1–2) |

> **Ore accent families** (`coal`, `iron_ore`, `gold`, `diamond`, `redstone`, `lapis`,
> `emerald`) are used **only** as the speckle overlay ramp inside stone/deepslate blocks (§5).
> Their stops 3–4 provide the sparkle.
> **Reuse, don't duplicate:** `mossy_cobblestone` = `cobble` + green moss overlay;
> `bookshelf` = `wood_planks` sides/top + a book-row band; `note_block`/`jukebox` =
> `wood_planks` + dark face; `end_stone` also serves `end_stone_bricks`. Add a ramp row only
> when no existing family is within a hue-shift of the target.

### 2.3 Anchor hue wheel (derive new materials from these)
| Family group | Hue° | Sat guidance |
|---|---|---|
| foliage / grass | 95–135 | warm→yellow-green in light |
| wood / dirt | 22–38 | 40–56% |
| sand / straw | 42–52 | 22–42% |
| stone / gravel | 216 (cool) or 30 (warm-tan) | **3–8%** — never 0 |
| water / ice | 195–215 | 20–64% |
| ore red / brick | 6–16 | 40–60% |
| ore gem/blue | 175–195 (cyan) or 260–280 (violet) | accents only |
| light anchor (highlights shift toward) | ~50 | lower S |
| shadow anchor (shadows shift toward) | ~250 | hold/raise S |

### 2.4 Value & saturation ramp template (per material)
Generator inputs per material: `{ hBase, hShadowShift(+ toward 250), hLightShift(+ toward 50),
sMid, sDropShadow, sDropLight, vStops:[…5], contrast }`. Default `vStops = [42,52,62,72,82]`.
Saturation follows the hump: `S(i) = sMid − |i−2| * (i<2 ? sDropShadow : sDropLight) * 0.5`.

### 2.5 Optional master-palette snap
After generation, optionally snap every color to a fixed **32–64 color master palette**
(nearest in **OKLab**, not RGB) to guarantee inter-block harmony and enable one-edit
global retune. Per pack: cartoon → 24–40 (punchy), default → 40–56, gritty → 48–64 (muddy
mids). Snap is a post-pass on the atlas; keep it toggleable (`config.paletteSnap`).

### 2.6 Dye palette (16 colors) — the recolor source for §5.25
§5 #25 says "dyed variants = ramp swap only" but never supplies the table. Vanilla has
**exactly 16 dye colors**, reused across wool, carpet, concrete, concrete_powder, terracotta,
stained_glass, stained_glass_pane, beds, candles, shulker_boxes. Store the 16 base hues and
**derive each material's 5-stop ramp from a dye hue** via the §2.4 template (feed `hBase`,
`sMid`, and a `vStops` band appropriate to the material — wool is high-V/soft, concrete is
flatter/higher-sat, terracotta desaturates and warms).

```ts
type DyeColor =
  | 'white' | 'orange' | 'magenta' | 'light_blue' | 'yellow' | 'lime' | 'pink' | 'gray'
  | 'light_gray' | 'cyan' | 'purple' | 'blue' | 'brown' | 'green' | 'red' | 'black';
// HSV: h∈[0,360), s,v∈[0,1]. Note §1.3 — 'white'/grays keep a 2–5% warm/cool bias, never S=0.
const DYE: Record<DyeColor, { h: number; s: number; v: number }> = {
  white:      { h: 40,  s: 0.03, v: 0.95 },
  orange:     { h: 26,  s: 0.85, v: 0.86 },
  magenta:    { h: 300, s: 0.55, v: 0.76 },
  light_blue: { h: 205, s: 0.55, v: 0.82 },
  yellow:     { h: 52,  s: 0.85, v: 0.90 },
  lime:       { h: 90,  s: 0.75, v: 0.76 },
  pink:       { h: 340, s: 0.45, v: 0.90 },
  gray:       { h: 216, s: 0.04, v: 0.40 },
  light_gray: { h: 216, s: 0.03, v: 0.62 },
  cyan:       { h: 185, s: 0.65, v: 0.60 },
  purple:     { h: 275, s: 0.60, v: 0.55 },
  blue:       { h: 225, s: 0.80, v: 0.55 },
  brown:      { h: 25,  s: 0.55, v: 0.35 },
  green:      { h: 92,  s: 0.75, v: 0.45 },
  red:        { h: 2,   s: 0.80, v: 0.60 },
  black:      { h: 216, s: 0.06, v: 0.14 },
};
// wool_<dye> ramp = rampFromHue(DYE[dye], material='wool'); structure identical to §5.25.
```

---

## 3. The three texture packs

A pack = a **parameter set** applied to the shared pipeline. Same `structureField`, same
tiling code, same per-block specs — only these numbers change.

### 3.1 Identity statements
- **`default`** — *"Clean, readable, original voxel look: crisp clustered detail, warm sun /
  cool shade, recognizable at a glance while tiled."*
- **`smooth-cartoon`** — *"Soft rounded gumdrops: high saturation, few clean bands, one big
  soft highlight per block, almost no visible noise."*
- **`gritty`** — *"Desaturated, high-contrast, weathered: deep cool shadows, heavy stipple
  grain, scratch/grime overlay and chipped corners."*

### 3.2 Pack parameter table
| Parameter | `default` | `smooth-cartoon` | `gritty` |
|---|---|---|---|
| Ramp saturation (mid) | 40–60% | 65–85% | 15–35% |
| Contrast budget (Vmax−Vmin) | ~0.35 | ~0.25 | ~0.55 |
| Ramp steps `N` | 4–5 | 3–4 | 5–6 |
| Hue swing across ramp | 20–40° | 15–25° | 10–20° |
| `lightRGB` (global) | `(1.05,1.00,0.88)` | `(1.08,1.04,0.95)` | `(0.95,0.92,0.85)` |
| `shadowRGB` (global) | `(0.58,0.63,0.82)` | `(0.75,0.78,0.90)` | `(0.34,0.38,0.50)` |
| Tint strength | moderate | gentle (bright shadows) | strong (deep cool shadows) |
| Noise amplitude in `struct` | 0.15–0.30 | 0.05–0.15 | 0.30–0.50 |
| fBm `GAIN` | 0.50 | 0.40 | 0.60–0.65 |
| fBm `OCT` | 4 | 3 | 5 |
| Interp fade | smoothstep | quintic (softest) | smoothstep + hard stipple |
| `JITTER` | 0.05–0.12 | 0.02–0.06 | 0.15–0.30 |
| Dithering | Bayer4, sparse, transition zones only | ≈ none (clean bands) | noise-threshold stipple everywhere |
| Edge treatment | none / subtle symmetric | soft rounded radial highlight | dark vignette + chipped corners |
| Palette snap count | 40–56 | 24–40 (punchy) | 48–64 (muddy mids) |
| Signature move | crisp clustered detail | 1 big soft highlight + cool rim | overlaid scratch/grime multiply pass |

### 3.3 Signature-move implementations
- **default:** legible clustered detail; nothing muddy. No extra pass.
- **smooth-cartoon:** after base fill, blend a **radial highlight** `hi = smoothstep(1.0, 0.2,
  length(uv-7.5)/8)` and raise `struct` by `0.12*hi`; add a 1px cool **rim** on the two
  brightest edges via `struct -= 0.06` where `min(dist to any edge) < 1.5` — but only a
  *symmetric* rim (all four edges) to preserve tiling. High-freq noise amplitude forced to
  the low end.
- **gritty:** after base fill, apply a **multiply grime pass**:
  `grime = 1.0 - 0.35*pow(fbm(uv*1.5, 16), 2.0)` (biases dark streaks), then
  `struct *= grime`. Add **edge chipping**: darken to ramp[0] where `worley(uv*2,2).x <
  0.14` **and** within 2px of a corner (symmetric across all four corners). Replace ordered
  dither with `t = hash21(uv)` stipple everywhere.

### 3.4 How a pack transforms the master ramp
A pack never stores hex. It stores a transform applied to the `default` HSV ramp before
`hsvToHex`:

```ts
// pseudo: applied per stop i of a default ramp expressed in HSV
function packRamp(defaultHSV: HSV[], pack: PackParams): Hex[] {
  return defaultHSV.map((c, i) => {
    const t = i / (defaultHSV.length - 1);              // 0..1 shadow→highlight
    const s = clamp(c.s * pack.satScale, 0, 1);          // cartoon >1, gritty <1
    const vCenter = 0.62;
    const v = clamp(vCenter + (c.v - vCenter) * pack.contrastScale, 0.20, 0.95);
    const h = c.h + pack.hueSwingScale * (c.h - defaultHSV[2].h); // widen/narrow swing
    return hsvToHex(h, s, v);
  });
}
// default: {satScale:1.0, contrastScale:1.0, hueSwingScale:0}
// smooth-cartoon: {satScale:1.45, contrastScale:0.72, hueSwingScale:-0.35}
// gritty: {satScale:0.55, contrastScale:1.55, hueSwingScale:-0.45}
```

Because all three derive from the same `default` HSV table + a transform, editing one master
color re-tunes every pack.

---

## 4. Procedural recipes (implement directly against 16×16 `ImageData`)

All recipes are integer-deterministic and **tileable** via `mod(coord, P)`. `uv` below is in
**pixel space** `[0,16)`; convert from texel index with `uv = (x + 0.5, y + 0.5)` if you want
texel-centered evaluation. Everything returns scalars in `[0,1]` unless noted.

### 4.0 Shared hash (2D → [0,1))
```js
function hash21(px, py) {                 // deterministic, no allocation
  let x = px * 123.34, y = py * 456.21;
  x = x - Math.floor(x); y = y - Math.floor(y);   // fract
  const d = x * (x + 45.32) + y * (y + 45.32);
  x += d; y += d;
  const r = (x * y);
  return r - Math.floor(r);              // ∈ [0,1)
}
// TILE IT: before hashing a lattice/cell coord, wrap it:  ix = ((ix % P) + P) % P
// SEED A MATERIAL: add a per-material constant to inputs:  hash21(x + seed, y + seed*1.7)
```

### 4.1 Value noise (grain, dirt bed, base texture)
```js
function vnoise(px, py, P) {             // P = period in cells; use 2,4,8,16 (must divide 16)
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  const ux = fx*fx*(3-2*fx), uy = fy*fy*(3-2*fy);   // smoothstep (quintic for cartoon, §4.7)
  const w = (X,Y) => hash21(((X%P)+P)%P, ((Y%P)+P)%P);
  const a = w(ix, iy),   b = w(ix+1, iy);
  const c = w(ix, iy+1), d = w(ix+1, iy+1);
  return lerp(lerp(a,b,ux), lerp(c,d,ux), uy);       // ∈ [0,1]
}
```
- Cell size: `p = uv * (FREQ/16)` so FREQ ∈ **{2,4,8}** divides the tile. FREQ=4 → 4px cells → good dirt.
- Amplitude when added into `struct`: **0.15–0.45** (see pack row).

### 4.2 fBm (fractal detail — dirt, stone, clouds)
```js
function fbm(px, py, P, OCT, LAC, GAIN) {   // OCT 3–5, LAC 2.0 (integer→tiling holds), GAIN 0.4–0.65
  let v = 0, amp = 0.5, f = 1;
  for (let o = 0; o < OCT; o++) {
    v += amp * vnoise(px*f, py*f, P*f);
    f *= LAC; amp *= GAIN;
  }
  return v;                                 // ≈ [0,1], weighted
}
```
- Base FREQ 2–4, `OCT` 4 typical (3 cartoon / 5 gritty), `LAC = 2.0`, `GAIN` per pack (§3.2).

### 4.3 Cellular / Worley (stone bumps, cobble, ore speckle, cracks)
```js
function worley(px, py, P) {               // returns {f1, f2}; tileable over P cells
  const ipx = Math.floor(px), ipy = Math.floor(py);
  const fpx = px - ipx, fpy = py - ipy;
  let f1 = 9, f2 = 9;
  for (let j = -1; j <= 1; j++)
  for (let i = -1; i <= 1; i++) {
    const cx = ipx + i, cy = ipy + j;
    const ox = hash21(((cx%P)+P)%P,        ((cy%P)+P)%P);
    const oy = hash21(((cx%P)+P)%P + 17,   ((cy%P)+P)%P + 17);
    const dx = i + ox - fpx, dy = j + oy - fpy;
    const dist = dx*dx + dy*dy;            // squared is fine for comparison
    if (dist < f1) { f2 = f1; f1 = dist; } else if (dist < f2) { f2 = dist; }
  }
  return { f1: Math.sqrt(f1), f2: Math.sqrt(f2) };
}
```
Uses:
- **Bumpy stone / scales:** `struct = f1` (or `1 - f1` for raised bumps).
- **Cracks / mortar / cell borders:** `edge = f2 - f1`; `isCrack = edge < 0.06–0.12`.
- **Cobblestone:** per-cell id `cid = hash21(nearestCellX, nearestCellY)`; each stone brightness
  `= base + (cid-0.5)*0.12`; darken border where `edge < 0.10` (mortar → ramp[0..1]).
- **Ore speckle:** sparse feature points → wherever `f1 < 0.18` around a seeded point, paint
  the ore-accent ramp (§5); density controlled by cell count `P`.
- Cell density `P ∈ {2,3,4}` (2–3 features across a 16px tile reads best).

### 4.4 Perlin (smoother swirls — marble, cartoon clouds; optional, costlier)
```js
function perlin(px, py, P) {
  const ix = Math.floor(px), iy = Math.floor(py), fx = px-ix, fy = py-iy;
  const ux = fx*fx*(3-2*fx), uy = fy*fy*(3-2*fy);
  const g = (X,Y,dx,dy) => { const a = hash21(((X%P)+P)%P, ((Y%P)+P)%P)*6.2831853;
                             return Math.cos(a)*dx + Math.sin(a)*dy; };
  const a=g(ix,iy,fx,fy),     b=g(ix+1,iy,fx-1,fy);
  const c=g(ix,iy+1,fx,fy-1), d=g(ix+1,iy+1,fx-1,fy-1);
  return lerp(lerp(a,b,ux), lerp(c,d,ux), uy)*0.5 + 0.5;   // [-1,1]→[0,1]
}
// marble: m = sin((uv.x + perlin(...)*W) * freq);  W≈4, freq≈0.6
```
Use for smooth-cartoon soft shading / marble only; value noise is enough at 16px otherwise.

### 4.5 Brick tiling (running bond, seamless)
```js
function brick(uvx, uvy, cfg) {            // cfg: {brickW, brickH, mortarW, brickV, mortarV}
  const row  = Math.floor(uvy / cfg.brickH);
  const xoff = (row % 2) * (cfg.brickW * 0.5);          // half-brick stagger
  const bx   = ((uvx + xoff) % cfg.brickW + cfg.brickW) % cfg.brickW;
  const by   = uvy % cfg.brickH;
  const mortar = (bx < cfg.mortarW) || (by < cfg.mortarW);
  const bId  = hash21(Math.floor((uvx+xoff)/cfg.brickW), row);
  return mortar ? cfg.mortarV : (cfg.brickV + (bId-0.5)*0.14);   // scalar struct
}
```
- **Seamless requires** `brickW` and `2*brickH` divide 16 → `brickW ∈ {8,16}`, `brickH ∈ {2,4}`,
  `mortarW = 1`. Add fBm bed (amp 0.06–0.12) on brick faces; keep mortar cleaner.

### 4.6 Plank tiling (grain + grooves + knots)
```js
function planks(uvx, uvy, cfg) {           // cfg: {plankH, grooveV, plankV}
  const pid    = Math.floor(uvy / cfg.plankH);            // plankH 3–5 (use 4 → 4 planks)
  const groove = (uvy % cfg.plankH) < 1.0;                // 1px dark groove
  const baseJit= (hash21(pid, 0) - 0.5) * 0.16;           // per-plank tone
  const grain  = vnoise(uvx*0.5, uvy*4.0, 16);            // anisotropic ~8:1 along length
  let s = groove ? cfg.grooveV : (cfg.plankV + baseJit + (grain-0.5)*0.10);
  // knots: 1–2 seeded Worley points; near one, s -= 0.20*smoothstep(2.0,0.0,distToKnot)
  return s;
}
```
- Groove width **1px**, plank width **3–5px**, grain anisotropy ≈ **8:1** (freq across ÷ along),
  1–2 knots max.

### 4.7 Interpolation fade (per pack)
```js
const fade = {
  smoothstep: f => f*f*(3 - 2*f),                 // default, gritty
  quintic:    f => f*f*f*(f*(f*6 - 15) + 10),     // smooth-cartoon (softest)
};
```
Swap the fade used inside `vnoise`/`perlin` by pack.

### 4.8 Per-pixel jitter (life / grit) — add BEFORE ramp lookup
```js
struct += (hash21(uvx, uvy) - 0.5) * JITTER;      // default 0.05–0.12, cartoon 0.02–0.06, gritty 0.15–0.30
// alt (chunkier, controlled): occasionally bump the ramp index ±1 instead of struct
```

### 4.9 Gradient ramp mapping + LUT (crisp pixel-art bands)
```js
function rampIndex(struct, N) {                    // N = ramp length
  return Math.min(N-1, Math.max(0, Math.round(clamp(struct,0,1) * (N-1))));  // nearest → hard bands
}
// vertical gradient fill (sky, sand, smooth fills):
function gradientFill(uvy, N) {
  let g = uvy / 16;
  g += (vnoise(uvy, uvy, 8) - 0.5) * 0.06;         // perturb band edges so they don't look ruled
  return rampIndex(g, N);
}
// radial (ore glow / orb): g = 1 - dist(uv,(8,8))/8
albedo = hexToRGB(RAMP[material][ rampIndex(struct, RAMP[material].length) ]);
```

### 4.10 Ordered dither (Bayer) — soften ONE transition without a 3rd color
```js
const BAYER4 = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]]; // /16
function ditheredIndex(struct, N, x, y) {
  const s = clamp(struct,0,1) * (N-1);
  const k = Math.floor(s), frac = s - k;
  const t = (BAYER4[x&3][y&3]) / 16;
  return Math.min(N-1, k + (frac > t ? 1 : 0));
}
```
- At 16×16 dithering reads busy fast. **default:** apply only in the 1–2 transition zones.
  **cartoon:** don't use (clean bands). **gritty:** replace Bayer with `t = hash21(x,y)` stipple.

### 4.11 Global-light cohesion multiply (§1.4) — the unifier
```js
function applyGlobalLight(albedoRGB, struct, pack) {
  const t = clamp(struct, 0, 1);
  const tint = [
    lerp(pack.shadowRGB[0], pack.lightRGB[0], t),
    lerp(pack.shadowRGB[1], pack.lightRGB[1], t),
    lerp(pack.shadowRGB[2], pack.lightRGB[2], t),
  ];
  return [ albedoRGB[0]*tint[0], albedoRGB[1]*tint[1], albedoRGB[2]*tint[2] ];
}
```
Because every material is lit by the same warm/cool pair, unrelated blocks read as one world.

### 4.12 HSV→RGB helper (ramp generation)
```js
function hsvToRgb(h, s, v) {                        // h∈[0,360), s,v∈[0,1]
  const c = v*s, x = c*(1 - Math.abs((h/60)%2 - 1)), m = v-c;
  let r,g,b;
  if (h<60)      [r,g,b]=[c,x,0]; else if (h<120) [r,g,b]=[x,c,0];
  else if (h<180)[r,g,b]=[0,c,x]; else if (h<240) [r,g,b]=[0,x,c];
  else if (h<300)[r,g,b]=[x,0,c]; else            [r,g,b]=[c,0,x];
  return [Math.round((r+m)*255), Math.round((g+m)*255), Math.round((b+m)*255)];
}
```

---

## 5. Per-block texture specs (core set)

Format per entry: **ramp** · **noise** (type + params) · **pattern** · **overlay/accent** ·
**per-pack delta** · **alpha/flags**. All use the §4 recipes. FREQ/period values are already
tile-safe. Faces not listed reuse the closest listed face.

Notation: `vnoise(FREQ)` = `vnoise(uv*FREQ/16, …, FREQ)`; `fbm(FREQ)` uses pack OCT/GAIN.

1. **grass_top** — ramp `grass` (grayscale-luma variant for tint, §1.6). noise `fbm(4)` amp 0.22.
   pattern: none (flat mottle). overlay: 6–10 sparse 1px brighter blades via `hash21>0.86 → +1
   ramp step`. tint mask = **255 all texels**. per-pack: cartoon amp 0.10 + radial highlight;
   gritty amp 0.40 + grime multiply. alpha 1.
2. **grass_side** — bottom 10px = `dirt` (spec #3), top 6px = `grass` fringe with a **1–3px ragged
   overhang** (per-column top height = `4 + round(hash21(x,seed)*2)`). overlay: grass texels get
   tint mask 255, dirt texels mask 0. noise: dirt bed `fbm(4)` amp 0.18 + grass mottle `vnoise(4)`
   amp 0.15. per-pack: gritty deepens dirt shadow. alpha 1.
3. **dirt** — ramp `dirt`. noise `fbm(4)` amp 0.28, OCT 4. pattern: none. overlay: 3–5 tiny dark
   pebbles `worley(4)` where `f1<0.14 → ramp[0]`. per-pack: cartoon amp 0.12, fewer pebbles;
   gritty amp 0.45 + stipple. alpha 1.
4. **stone** — ramp `stone`. noise `fbm(4)` amp 0.16 (low). pattern: faint `worley(3)` bumps,
   `struct = mix(fbm, 1-f1, 0.35)`. overlay: 1–2 hairline cracks where `edge=f2-f1 < 0.07 →
   ramp[1]`. **symmetric only**, no border. per-pack: gritty adds chipped corners + amp 0.30.
   alpha 1.
5. **cobblestone** — ramp `cobble`. pattern: `worley(3)` cells → per-cell brightness
   `base + (cellId-0.5)*0.12`; **mortar** where `edge<0.11 → ramp[0]` darkened. noise: per-cell
   fBm bed amp 0.10. overlay: none. per-pack: cartoon rounds cells (raise f1 highlight); gritty
   deepens mortar + grime. alpha 1.
6. **sand** — ramp `sand`. noise `vnoise(8)` amp 0.10 fine grain + `fbm(4)` amp 0.08 low dunes.
   pattern: none. overlay: sparse 1px bright specks `hash21>0.92 → +1 step`. per-pack: cartoon
   near-flat (amp 0.05); gritty amp 0.22 + darker troughs. alpha 1.
7. **gravel** — ramp `gravel` (mixed warm/cool). pattern: `worley(4)` small pebbles, per-cell
   brightness jitter ±0.14, **and** per-cell hue pick (even cell → warm stops, odd → cool stops).
   overlay: dark interstitial where `edge<0.09`. per-pack: gritty amp up + chips. alpha 1.
8. **oak_log_side** (`wood_bark`) — pattern: **vertical grain**, `vnoise(uvx*2, uvy*0.5, 16)` (grain
   runs along Y). noise amp 0.14. overlay: 3–4 vertical darker streaks (`ramp[1]`) at seeded x
   columns; 1 knot (Worley point, dark radial ring). per-pack: cartoon softens streaks; gritty
   adds cracks. alpha 1.
   - **Axis state (P2):** logs/pillars (`oak_log`, `quartz_pillar`, `hay_bale`, `bone_block`,
     `basalt`, `deepslate` pillar forms) carry `axis: 'x'|'y'|'z'` in `BlockSpec` (§6.1). The
     **end** texture (`oak_log_top`, #9) appears on the two faces **along** the axis; the
     **side** bark texture (#8) is on the four perpendicular faces and is **rotated 90°** on
     the pair whose face runs across the grain so the grain always points along the axis. The
     face resolver maps `(faceNormal, axis)` → `{textureId, uvRotation∈{0,90,180,270}}`. Do
     NOT bake per-axis textures; rotate at mesh time (`uvRotation`, §6.5).
9. **oak_log_top** (`wood_bark` + `wood_planks` mix) — pattern: **concentric rings**,
   `r = length(uv-(8,8))`; `struct = 0.5 + 0.5*sin(r*2.4 + vnoise*1.5)`; center pith darker.
   ramp: bark for rings, planks tone between. overlay: none. per-pack: cartoon fewer rings
   (freq 1.8); gritty adds radial cracks. alpha 1. Selected on the two along-axis faces (see #8).
10. **oak_planks** (`wood_planks`) — pattern: `planks(cfg{plankH:4,plankV:.60,grooveV:.32})` (§4.6),
    horizontal grain, 1px grooves at y=0,4,8,12. overlay: 1 knot. noise: grain amp 0.10. per-pack:
    cartoon widens/cleans grooves; gritty darkens grooves + scratches. alpha 1.
11. **oak_leaves** (`leaves`) — noise `fbm(4)` amp 0.30 clumpy. pattern: cellular clumps
    `worley(4)` → brighten `f1` centers. overlay: **cutout holes** — where `hash21(x,y) > 0.80`
    set alpha 0 (foliage gaps). `renderLayer: 'cutout_mipped'`, `alphaTest 0.5`, `tintSource:
    'biome-foliage'` (mask 255). per-pack: cartoon fewer/larger clumps, no holes (or 1px);
    gritty more holes + darker. alpha 0/1. **Fixed-color exceptions** (§1.6.1) use the same
    structure but `tintSource:'fixed'`: spruce_leaves `#619961`, birch_leaves `#80A755`.
12. **water_still** (`water`) — pattern: horizontal ripple `struct = 0.5 + 0.2*sin((uvx +
    vnoise*3)*0.9) + 0.15*vnoise(8)`. `renderLayer: 'translucent'`, `tintSource:'biome-water'`,
    **alpha ~0.78**. **Frame animation (§5.32 shape), NOT a single scroll:** generate a vertical
    strip of `frames:32` distinct 16×16 tiles by advancing the ripple phase per frame
    (`phase = f/32 * 2π`), `frametimeTicks:2`, `interpolate:true`. A separate **`water_flow`**
    spec (directional strip, `frames:32`) scrolls **along the fluid's flow vector** — the
    renderer rotates its UVs by the flow direction (`uvRotation` from flow angle) and offsets V
    by frame; still vs flow is chosen by fluid state (§5.38). per-pack: cartoon 2 clean bands;
    gritty murkier + foam specks. `lightEmission 0`.
13. **lava_still** (`lava`) — pattern: cellular crust `worley(3)` → bright cracks
    `edge<0.14 → ramp[3..4]`, cell interiors dark `ramp[0..1]`. `renderLayer: 'solid'` (opaque),
    **emissive** `lightEmission 15` (skip §4.11; renderer clamps min brightness — §1.7).
    **Frame animation:** `frames:20`, `frametimeTicks:2`, `interpolate:true` (advance crust
    phase per frame). Separate **`lava_flow`** spec (`frames:20`) scrolls along the flow vector
    as with water. per-pack: cartoon big smooth cells; gritty fine crackle. alpha 1.
14. **coal_ore** — base = **stone** (spec #4) exactly, then overlay `coal` speckle: seed 4–6 Worley
    points `P=3`; where `f1 < 0.20` paint `coal` ramp by depth (`f1→ramp idx`). clusters, not
    single pixels. per-pack: gritty larger/darker veins. alpha 1.
15. **iron_ore** — stone base + `iron_ore` speckle (buff/tan), 4–5 points `P=3`, `f1<0.18`. accent
    stops 3–4 give metallic fleck. per-pack as coal. alpha 1.
16. **gold_ore** — stone base + `gold` speckle, 3–4 points `P=4` (rarer), `f1<0.16`; add 1px
    highlight `ramp[4]` at each point center (sparkle). per-pack: cartoon bigger softer nuggets.
    alpha 1.
17. **diamond_ore** — stone base + `diamond` speckle, 3–4 points `P=4`, `f1<0.16`; sparkle = single
    `#C3FAF6` texel at center + `ramp[3]` ring. per-pack: gritty tighter gems. alpha 1.
18. **bedrock** (`bedrock`) — noise `fbm(4)` amp 0.40 (chaotic) + heavy `JITTER` 0.20. pattern:
    random dark blotches `worley(3) f1<0.30 → ramp[0]`. no order → "unbreakable/ancient" read.
    per-pack: gritty max jitter; cartoon still noisy (identity block, keep amp≥0.25). alpha 1.
19. **snow** (`snow`) — noise `vnoise(8)` amp 0.06 (very subtle sparkle) + rare `hash21>0.95 →
    ramp[4]` glint. pattern: none. contrast forced low. per-pack: cartoon flat white + 1 soft
    highlight; gritty adds grey-blue dirty patches. alpha 1.
20. **ice** (`ice`) — pattern: `perlin(4)` cracked sheets → `struct = 0.6 + 0.4*perlin`; sharp
    `edge` cracks `worley(3) edge<0.06 → ramp[4]` (bright fracture). **alpha ~0.72**, `transparent`.
    per-pack: cartoon fewer cracks, glassy; gritty frosted stipple. alpha 0.72.
21. **clay** (`clay`) — noise `vnoise(8)` amp 0.08 smooth. pattern: none (matte, uniform). overlay:
    none. per-pack: cartoon perfectly smooth; gritty faint crack `edge<0.08`. alpha 1.
22. **glass** — mostly **transparent interior** (alpha 0) with a **1px frame** on all four edges
    using `glass` ramp[3], plus a 2px diagonal **highlight streak** (alpha ~0.35, `ramp[4]`).
    tileable frame reads as pane grid. per-pack: cartoon thicker rounded frame; gritty cracked/
    dirty streaks. alpha: frame 1, streak ~0.35, interior 0. `transparent`, `alphaTest` off.
23. **brick** (`brick`) — pattern: `brick(cfg{brickW:8,brickH:4,mortarW:1,brickV:.60,mortarV:.30})`
    running bond. noise: fBm bed amp 0.08 on brick faces, mortar clean. overlay: per-brick tone
    jitter ±0.14 (§4.5). per-pack: cartoon clean mortar + rounded; gritty chipped bricks + stains.
    alpha 1.
24. **sandstone** (`sandstone`) — pattern: **horizontal strata** — `band = floor(uvy/4)`, each 4px
    band a slightly different tone (`+ (hash21(band,0)-0.5)*0.10`); 1px darker line between bands.
    noise `vnoise(8)` amp 0.06. per-pack: cartoon crisper bands; gritty weathered + pitting.
    alpha 1.
25. **wool** (`wool_white` base) — noise `vnoise(4)` amp 0.10 soft fuzz + fine `vnoise(8)` amp 0.05.
    pattern: none (woven mottle). **dyed variants = ramp swap only** (generate `wool_red`,
    `wool_blue`, … by feeding a recolored ramp; structure identical). per-pack: cartoon flatter,
    higher sat; gritty matted + darker. alpha 1.
26. **iron_block** (`metal_iron`) — noise `vnoise(8)` amp 0.05 (near-flat brushed). pattern: subtle
    1px symmetric panel inset lines at 25%/75% (`struct -= 0.06`, symmetric to keep tiling).
    overlay: 2px diagonal `ramp[4]` sheen. per-pack: cartoon shinier single highlight; gritty
    rusty `dirt`-tinted streaks via secondary ramp blend. alpha 1.
27. **netherrack** (`netherrack`) — noise `fbm(4)` amp 0.30 + `worley(3)` porous holes
    `f1<0.16 → ramp[0]`. pattern: veiny. per-pack: gritty max grime; cartoon smoother. alpha 1.
28. **gravel_path / coarse_dirt** — `dirt` ramp + denser `worley(4)` pebbles (`f1<0.20`), lower
    fBm amp 0.14 (packed). per-pack as dirt. alpha 1.
29. **dry_grass_top** (`grass_dry`) — same recipe as grass_top with `grass_dry` ramp; tint mask 255
    (savanna biome tint). per-pack matches grass_top. alpha 1.
30. **stone_bricks** — `stone` ramp + `brick(cfg{brickW:8,brickH:8,mortarW:1,brickV:.58,
    mortarV:.34})` **stacked bond** (no half-stagger: `xoff=0`), per-brick jitter ±0.10, plus a few
    `worley` cracks. per-pack: gritty crumbled mortar + chipped blocks; cartoon crisp. alpha 1.

31. **Cross-geometry plants** (category `cross`) — P2. Vanilla's ubiquitous non-cube plants:
    dandelion, poppy + all flowers, oak/spruce/… saplings, wheat/carrot/potato **crop stages**,
    tall_grass, fern, dead_bush, sugar_cane, cobweb. **Geometry:** two intersecting vertical
    quads forming an X across the cell diagonals (`#cross` model), **no AO**, no per-face shade,
    `renderLayer: 'cutout'`, `alphaTest 0.5`. **Texture:** 16×16, transparent background (alpha
    0), the plant shape drawn in the opaque texels. Optional `tintSource` (`biome-grass` for
    tall_grass/fern; `fixed`/`none` for flowers). Minimum specs:
    - `tall_grass` — `grass` ramp (luma variant), 3–5 vertical blades of varying height per
      quad via `hash21(col)`, taper to 1px tips, `tintSource:'biome-grass'`.
    - `dandelion` — green stem column + a 3×3 yellow (`#F0C000`) bloom cluster near top, `none`.
    - `poppy` — green stem + red (`#D02020`) 4px bloom, `none`.
    - `oak_sapling` — small trunk + a rounded `leaves`-ramp canopy, `tintSource:'biome-foliage'`.
    - `wheat_stage0..7` — 8 specs, rising blade height + head fill by stage (state-driven, §6.1).
32. **Animated textures** (`animation` shape, §6.1) — P1. Multi-frame sprite strips advanced on
    a fixed tick cadence, NOT a single noise scroll. Data: `animation: { frames, frametimeTicks,
    interpolate }`; the generator emits `frames` stacked 16×16 tiles (a `16 × 16*frames` strip)
    and the renderer offsets V by `floor(tick/frametimeTicks) % frames` (cross-fades adjacent
    frames when `interpolate`). Specs beyond water/lava (#12/#13): `fire_0` + `fire_1` (**two
    stacked animated layers**, `frames:32`, cutout, cross-like on-block, `lightEmission 15`),
    `nether_portal` (`frames:32`, translucent purple swirl `perlin` §4.4), `sea_lantern`
    (`frames:5`, emissive 15), `magma` (`frames:… `, emissive 3, glowing cracks), `prismarine`
    (`frames:… `, slow teal shimmer), `kelp`/`seagrass` (cross + gentle sway offset). Static
    blocks omit `animation` entirely.
33. **destroy_stage_0..9** (universal break overlay) — P1. A **single grayscale crack set** the
    generator must produce once and the renderer composites over ANY block being mined, indexed
    by mining progress `stage = floor(progress * 10)`. `genDestroyOverlay(stage: 0..9)` returns a
    **tileable** 16×16 grayscale+alpha where cracks branch and thicken with `stage` (stage 0 = a
    few 1px hairlines from center, stage 9 = dense shattered network). Build cracks from
    `worley(3)` edges (`edge < threshold(stage)`) growing outward from a seeded center;
    `alpha = crackStrength`, RGB dark (`~0.15`). **Render pass:** draw the targeted block's face
    a second time with this overlay as a `map`, blend mode multiply/`alpha`, slightly polygon-
    offset toward camera to avoid z-fight. Not a `BlockSpec` entry — a standalone generated
    texture in the atlas the render loop samples.
34. **Missing full-cube blocks** (add ramps in §2.2 + one spec row each) — P2:
    - `obsidian` — `obsidian` ramp, `perlin(4)` swirl amp 0.10, 2–3 tiny violet sparkle texels
      `ramp[4]`. `lightEmission 0`. alpha 1.
    - `glowstone` — `glowstone` ramp, `worley(3)` bright nodules (`f1<0.20 → ramp[4]`),
      **emissive** `lightEmission 15` (skip §4.11). alpha 1.
    - `quartz_block` — `quartz` ramp, near-flat `vnoise(8)` amp 0.05; `quartz_pillar` = axis
      variant (§5.8) with a fine vertical striation side + smooth top.
    - `nether_bricks` — `nether_brick` ramp + `brick(cfg{brickW:8,brickH:4,mortarW:1})` (§4.5).
    - `end_stone` — `end_stone` ramp, `worley(4)` mottled cells amp 0.12; `end_stone_bricks` adds
      stacked-bond `brick`.
    - `redstone_ore` — stone base + `redstone` speckle (like #14); **state** `active` (§6.1) →
      brighter dots + `lightEmission 9`.
    - `lapis_ore` — stone base + `lapis` speckle (5–7 pts, `P=3`).
    - `emerald_ore` — stone base + `emerald` speckle (1–2 large gems, rare).
    - `copper_ore` — stone base + `copper` speckle.
    - `mossy_cobblestone` — `cobble` (#5) + green moss overlay: where `fbm(4) > 0.6` blend toward
      `leaves[2]` (shadow-biased), mortar stays.
    - `sponge` — `sponge` ramp, dense `worley(3)` pores (`f1<0.22 → ramp[0]`).
    - `bookshelf` — top/bottom = `oak_planks` (#10); sides = `wood_planks` frame + a middle band
      of vertical multi-colored book spines (`hash21(col)` picks `DYE` hue, §2.6). 6-face (§6.1).
    - `pumpkin` / `jack_o_lantern` — `pumpkin` ramp, vertical rib grooves (`uvx%3<1 → −0.10`);
      **front face** distinct carved face (jack_o_lantern front is emissive `lightEmission 15`).
      Uses the 6-face + `facing` model (§6.1).
    - `melon` — `melon` ramp rind, top = concentric rind rings; stripes via `sin(uvx*…)`.
    - `tnt` — `tnt` ramp body + a white/`quartz` label band across the middle side rows; top/
      bottom distinct (6-face). 
    - `note_block` / `jukebox` — `wood_planks` frame + dark center panel; jukebox top has an
      inset. `hay_bale` — `hay` ramp, axis pillar (§5.8), bound-twine lines on side.
    - `prismarine` — `prismarine` ramp, `worley(4)` brick-ish cells, slow animated shimmer (§5.32).
35. **Deepslate tier** (modern-parity **scope decision** — classic-only vs 1.18+) — P2. If
    targeting current vanilla, the y<0 world needs: `deepslate` (`deepslate` ramp, `worley(3)`
    cobble-ish + vertical faint striation; axis pillar), `polished_deepslate`,
    `deepslate_tiles`, `deepslate_bricks` (`brick` §4.5 over `deepslate`), and all
    `deepslate_<ore>` variants = **`deepslate` base + the same ore speckle as the stone ore**
    (reuse #14–17, #34 speckles, swap base ramp). Also foundational: `tuff` (`deepslate`-ish
    muted), `calcite` (pale near-`quartz` grain), `dripstone`, `amethyst`, `moss_block`
    (`leaves` mottle). Flag in `BLOCK_SPECS` whether the build is `classic` or `modern`.
36. **Terrain / surface variants** (dirt family; some are **non-full-cube heights** — a mesh
    concern the texture set must feed) — P2:
    - `farmland` — top = `dirt` darkened + a central wet square; **state** `moisture 0..7`
      (§6.1): dry (`#6B4B2E`-ish) vs moist (darker/bluer top); block is **15/16 height** (a 1px
      lip below full). side = `dirt` (#3).
    - `dirt_path` (grass_path) — distinct top (compacted `dirt`, slightly grassy edge) at **15/16
      height**; side = a `dirt`+`grass` fringe strip.
    - `podzol` — top = reddish-brown speckled (`dirt` shadow + orange fleck); side = `dirt` with a
      thin podzol fringe. `mycelium` — top = grey-purple mottle (`#6E5F6B`), side = `dirt`+fringe.
    - `coarse_dirt` — **already covered by #28** (denser pebbles, no grass spread); keep as-is.
    - `grass_block` **snowy side** — **state** `snowy=true` (§6.1) swaps `grass_side` for a
      `snow`-topped side (white fringe replacing the green fringe). Ties into `grass_side` (#2).
37. **Stained & tinted glass** (16 colors) — P3. `stained_glass_<dye>` = `glass` structure (#22)
    recolored from `DYE` (§2.6), **`renderLayer: 'translucent'`** (colored + alpha-blended,
    NOT cutout like plain glass), alpha ~0.55, `tintSource:'none'` (color is baked into the
    ramp). `tinted_glass` = near-opaque dark tint that **blocks light** (`lightEmission 0`, and
    treated as opaque by the flood-fill §1.7) yet renders transparent. `glass_pane` / 16 stained
    panes = **thin connecting geometry** (a model/mesh concern: pane width 2/16, connects to
    neighbors) reusing the same textures — note it, don't try to bake connection into the tile.
38. **Copper oxidation family** (state-driven multi-texture) — P3. If copper is in scope: 4
    progressive **weathering stages** as an oxidation state axis (ties into §6.1 `states`):
    `unaffected`→`exposed`→`weathered`→`oxidized`, each a distinct tint interpolated
    `copper` → `copper_oxidized` (bright orange → teal-green; stages 1–2 = 0.33/0.66 lerp of the
    two ramps) with increasing green blotch coverage (`worley` patches). **`waxed_*` variants
    freeze the stage** (identical texture, different blockId; no random tick progression). Same
    for cut/exposed/… block forms (reuse structure, swap only the oxidation lerp `t`).
39. **Liquid level geometry** (still-top vs side + variable surface height) — P3. Beyond texture,
    water/lava render at **variable surface heights** driven by fluid **level state** (source +
    flow 0–7 + falling): a source top face sits at ~**14/16**, sloping down toward lower-level
    neighbors; falling fluid fills the full cell. The **still-top** texture (#12/#13
    `*_still`) differs from and animates independently of the **side/flow** texture (`*_flow`,
    scrolls along the flow vector). The texture set must therefore supply, per liquid,
    `{ still, flow }` (top uses `still`, sides use `flow` rotated to the flow direction §5.32).
    Surface-height slope + corner-height averaging is a renderer/mesher concern; the art system's
    job is to provide the two animated tiles and the flow-rotation hook.
40. **Sky & environment textures** (`§4.2` lists clouds as an fBm use; no sky spec existed) — P3.
    If the game has a sky, generate (all procedural, no assets):
    - `clouds` — a **256×256** tiling cloud sheet (`fbm` §4.2, thresholded to soft white blobs +
      alpha), scrolled at a fixed world speed, rendered as a flat layer at `y≈192`.
    - `sun` — a bright warm quad (radial `gradientFill`, `ramp` white→gold), billboarded on the
      day arc.
    - `moon_phases` — **8 phase frames** in a 4×2 grid (`moon_phases`, 128×64 → 8×32×32 or 16px
      cells); phase = `(dayCount) % 8`, render the matching cell.
    - `stars` — a sparse point field (`hash21 > 0.997 → white texel`) on the night dome, fading
      by `dayNight`.
    - `rain` / `snow` — vertical streak / drifting-flake particle sheets (small tiling strips).
    - **Fog & sky color tables** (per biome, **separate from the §1.6 water tint table**):
      `skyColor`, `fogColor` `RGB` per biome, lerped by time-of-day and blended across biomes
      like §1.6.2. Underwater/nether/end use their own fog constants.

> **Adding a block later:** pick the nearest spec above, choose/derive a ramp (§2.4), set the
> noise/pattern/overlay fields, and add one row to the `BLOCK_SPECS` table (§6.2). No new
> draw code.

---

## 6. Texture generator API sketch

### 6.1 Data shapes (shared TS types)
```ts
type Hex = string;                         // "#RRGGBB"
type RGB = [number, number, number];       // 0–255
type Ramp5 = [Hex, Hex, Hex, Hex, Hex];
type MaterialFamily =
  | 'grass' | 'dirt' | 'stone' | 'cobble' | 'sand' | 'gravel'
  | 'wood_bark' | 'wood_planks' | 'leaves' | 'water' | 'lava'
  | 'coal' | 'iron_ore' | 'gold' | 'diamond' | 'bedrock'
  | 'snow' | 'ice' | 'clay' | 'glass' | 'brick' | 'sandstone'
  | 'wool_white' | 'metal_iron' | 'netherrack' | 'grass_dry'
  // §2.2 additions:
  | 'deepslate' | 'obsidian' | 'quartz' | 'nether_brick' | 'end_stone'
  | 'prismarine' | 'glowstone' | 'sponge' | 'pumpkin' | 'melon' | 'hay' | 'tnt'
  | 'redstone' | 'lapis' | 'emerald' | 'copper' | 'copper_oxidized';

type PackId = 'default' | 'smooth-cartoon' | 'gritty';

// §1.5.3 render layer + §1.6.1 tint source + §5 geometry category.
type RenderLayer = 'solid' | 'cutout' | 'cutout_mipped' | 'translucent';
type TintSource  = 'biome-grass' | 'biome-foliage' | 'biome-water'
                 | 'fixed' | 'redstone-power' | 'none';
type Geometry    = 'cube' | 'cross' | 'liquid' | 'slab' | 'pane'; // §5.31/§5.39
// The 6 cube faces resolved against the block's facing/axis state (§5.8, §6.1 facing).
type Face6 = 'north' | 'south' | 'east' | 'west' | 'up' | 'down';

interface PackParams {                     // §3.2 numbers, one object per pack
  satScale: number; contrastScale: number; hueSwingScale: number;
  lightRGB: RGB01; shadowRGB: RGB01;       // RGB01 = 0..1 triplet
  noiseAmp: [number, number];              // [min,max] used by specs
  fbmOct: number; fbmGain: number;
  jitter: number; rampSteps: number;
  fade: 'smoothstep' | 'quintic';
  dither: 'bayer' | 'none' | 'stipple';
  edge: 'none' | 'radial-hi' | 'vignette-chip';
  paletteSnap: number;                     // 0 = off, else color count
}

type NoiseKind = 'vnoise' | 'fbm' | 'worley' | 'perlin' | 'none';
type PatternKind = 'none' | 'brick' | 'planks' | 'rings' | 'strata' | 'gradient';

interface BlockSpec {
  id: string;                              // 'grass_top', ...
  geometry: Geometry;                      // §5.31 'cross', §5.39 'liquid'; default 'cube'
  // 6-FACE model (§5.34 furnace/chest/pumpkin/TNT/bookshelf need a distinct FRONT).
  // Keys are cube faces; the face RESOLVER maps them through `facing`/`axis` state at mesh
  // time. Any omitted face falls back to `side` then `all`.
  faces?: Partial<Record<Face6 | 'side' | 'top' | 'bottom' | 'front' | 'all', string>>;
  facing?: boolean;                        // block has a facing state → `front` sub-spec used
  axis?: 'x' | 'y' | 'z';                  // log/pillar axis (§5.8); default 'y'
  ramp: MaterialFamily;                    // primary LUT
  overlayRamp?: MaterialFamily;            // ore speckle / grass fringe
  noise: { kind: NoiseKind; freq: number; amp: number };
  pattern: { kind: PatternKind; cfg?: Record<string, number> };
  overlay?: { kind: 'speckle'|'cracks'|'pebbles'|'holes'|'blades'|'knot';
              count?: number; threshold?: number; period?: number };
  tintSource: TintSource;                  // §1.6.1 (replaces the old tintMask boolean idea)
  tintMask: 'none' | 'full' | 'grass-fringe'; // WHICH texels tint (§1.6); source is above
  fixedTint?: Hex;                         // required when tintSource === 'fixed' (§1.6.1)
  renderLayer: RenderLayer;                // §1.5.3 — REQUIRED; drives blend/sort/mip mode
  alpha: number;                           // 1 opaque; <1 → transparent material
  lightEmission: number;                   // §1.7 — 0..15 (was `flags.emissive`); 0 = dark
  // §5.32 sprite-sheet animation (still/flow liquids, fire, portal…). Absent = static.
  animation?: { frames: number; frametimeTicks: number; interpolate: boolean };
  // §6.1 BLOCK-STATE variants: furnace lit/unlit, redstone_ore active, farmland moisture,
  // grass snowy, door open, copper oxidation (§5.38). Key = "stateName=value"; the value
  // deep-merges over the base spec to produce that state's immutable look.
  states?: Record<string, Partial<BlockSpec>>;
  flags?: { alphaTest?: number };          // alphaTest threshold for cutout layers
}
```

> **`flags.emissive` and `flags.animated` are removed.** Emission is the 0–15 level
> `lightEmission` (§1.7); animation is the `animation` object (§5.32). A boolean cannot drive
> the flood-fill light engine or a frame cadence. **Every `BlockSpec` must set `geometry`,
> `renderLayer`, `tintSource`, and `lightEmission`.**

### 6.2 The registry (data, not code)
```ts
const RAMPS: Record<MaterialFamily, Ramp5> = { /* §2.2 hex table */ };
const PACKS: Record<PackId, PackParams> = { /* §3.2 + §3.4 transforms */ };
const BLOCK_SPECS: Record<string, BlockSpec> = { /* §5, one entry per block */ };
```

### 6.3 Core functions
```ts
// Deterministic PRNG seeded per (block, pack) so regen is byte-identical.
function makeRng(seed: number): () => number;   // e.g. mulberry32

// THE ENTRY POINT the atlas builder calls per block face.
// Returns a 16*16*4 RGBA buffer ready for putImageData / DataTexture upload.
function genTexture(blockId: string, packId: PackId, seed = 0): Uint8ClampedArray {
  const spec = BLOCK_SPECS[blockId];
  const pack = PACKS[packId];
  const ramp = resolveRamp(spec.ramp, pack);       // §3.4 pack transform of §2.2 hex
  const out  = new Uint8ClampedArray(16 * 16 * 4);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      let s  = structureField(x + 0.5, y + 0.5, spec, pack); // §4.1–4.6 dispatch on spec
      s     += (hash21(x + seed, y + seed) - 0.5) * pack.jitter;
      s      = clamp(s, 0, 1);
      const idx = pickIndex(s, ramp.length, x, y, pack);     // §4.9/§4.10 (dither by pack)
      let rgb   = spec.lightEmission > 0 ? hexToRgb(ramp[idx]) // emitters (lava/glowstone): skip §4.11
                : applyGlobalLight(hexToRgb(ramp[idx]), s, pack); // §4.11
      rgb = applyOverlay(rgb, x, y, spec, ramp, pack);       // ore speckle / cracks / edge move
      const i = (y * 16 + x) * 4;
      out[i]=rgb[0]; out[i+1]=rgb[1]; out[i+2]=rgb[2];
      out[i+3]= alphaAt(x, y, spec);                         // holes/glass/water → per-texel A
    }
  return out;
}

// Companion for biome tint (§1.6): 1-channel mask, same seed → aligned with genTexture.
function genTintMask(blockId: string, seed = 0): Uint8ClampedArray; // 16*16 bytes

// structureField dispatches on spec.noise.kind + spec.pattern.kind, combining per §0.
function structureField(x: number, y: number, spec: BlockSpec, pack: PackParams): number;
```

### 6.4 Atlas assembly + validation (client boot)
```ts
// Build every block into one atlas texture at startup.
// PAD is MANDATORY: mipmaps over a tightly-packed 16px-tile atlas bleed neighbouring tiles
// into each other at mip>0 (seams/wrong colors at distance). Reserve a gutter per tile and
// EDGE-EXTRUDE (clamp-fill) the border texels into it. PAD ≥ 2^(mipLevels) texels; PAD=8
// (one full extra tile worth, power-of-two) is safe for 16px tiles down to a 1px mip.
const PAD = 8;                                        // gutter texels around each 16px tile
const CELL = 16 + 2 * PAD;                            // packed cell size
function buildAtlas(packId: PackId): { texture: THREE.Texture; uv: Record<string, UVRect> } {
  const ids = Object.keys(BLOCK_SPECS);
  const cols = Math.ceil(Math.sqrt(ids.length));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = cols * CELL;
  const ctx = canvas.getContext('2d')!;
  const uv: Record<string, UVRect> = {};
  ids.forEach((id, k) => {
    const data = genTexture(id, packId);              // 16*16*4 RGBA
    const img  = new ImageData(data, 16, 16);
    const px = (k % cols) * CELL + PAD, py = Math.floor(k / cols) * CELL + PAD;
    ctx.putImageData(img, px, py);
    edgeExtrude(ctx, px, py, 16, 16, PAD);            // replicate border texels into the gutter
    // UV rect points at the inner 16×16 (never into the gutter):
    const W = canvas.width, H = canvas.height;
    uv[id] = { u0: px/W, v0: py/H, u1:(px+16)/W, v1:(py+16)/H };
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;          // §6.6 — decode atlas as sRGB
  texture.magFilter = THREE.NearestFilter;            // never smooth pixel art (magnify)
  texture.minFilter = THREE.NearestMipmapLinearFilter;// mip transitions; NEAREST within a mip
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping; // tiling is per-block UV, not atlas
  texture.generateMipmaps = false;                    // build them ourselves — see below
  texture.mipmaps = buildAlphaWeightedMips(canvas, cols, CELL, PAD); // §6.4 note
  texture.needsUpdate = true;
  return { texture, uv };
}
```

**Mipmap rules (P0 — do not skip):**
- **(a) Padding / edge-extrusion** — every tile gets a `PAD`-texel gutter filled by clamping
  (repeating) its border texels outward, so mip downsampling never averages a neighbour tile.
  (Blocks that visually tile across a surface still `RepeatWrapping` **per-block UV**, not
  across the atlas — the atlas itself is `ClampToEdge`.)
- **(b) Alpha-weighted (premultiplied) downsample for `cutout`/`cutout_mipped`** — naive RGB
  mip averaging pulls fully-transparent **black** texels into leaves/glass and produces dark
  halos. `buildAlphaWeightedMips` must downsample **per sprite** with
  `rgb = Σ(rgb_i * a_i) / Σ(a_i)` (ignore `a_i==0` texels), `a = mean(a_i)`, then optionally
  re-threshold alpha at the block's `alphaTest`. `NearestFilter` mag still keeps texels crisp.
- The old `generateMipmaps=true` + tight packing is the bug this replaces.

```ts
// SEAM TEST (must pass before ship): a tiling texture equals itself shifted by 16px.
function assertTileable(blockId: string, packId: PackId): boolean {
  const a = genTexture(blockId, packId);
  // compare column x=15 vs x=0 continuity and row y=15 vs y=0 via a 2×2 render diff.
  // fail if edge-neighbor luma delta > threshold on a spec whose tintMask≠'none'/pattern tiles.
  return maxEdgeSeamDelta(a) < 0.06;                 // §1.2 gate
}

// DESTROY OVERLAY (§5.33): universal crack set, generated once, overlaid by the render loop.
function genDestroyOverlay(stage: 0|1|2|3|4|5|6|7|8|9): Uint8ClampedArray; // 16*16*4, tileable
```

### 6.5 How packs plug in
- One registry, three `PackParams` objects. Switching packs = `buildAtlas('gritty')` — **no
  block code changes**. `resolveRamp` applies the §3.4 transform so hex lives only in §2.2.
- Runtime pack switch: rebuild the atlas once and rebind the material's `map`; UV rects are
  identical across packs (same block order), so meshes need no re-UV.
- Determinism contract: `genTexture(id, pack, seed)` is a **pure function**; same inputs →
  identical bytes on client and (if ever needed) server-side preview. Seed defaults to 0;
  vary per-block only if you want texture variants (e.g. 3 dirt variants → seeds 0/1/2).
- **Per-instance variant + UV rotation, chosen by WORLD POSITION (P1).** Seamless tiles
  (§1.2) still show an obvious grid across large stone/dirt/cobble/netherrack/sand/gravel
  expanses unless each placed block picks a variant/rotation from its coordinates. The MESHER
  does this at emit time (it is NOT baked into the atlas):
  ```ts
  // deterministic per-block, matches vanilla's model random-rotation behaviour
  const h = hash3(x, y, z);                       // integer hash of world XYZ
  const variantIndex = h % spec.variantCount;     // picks among seeds 0..n-1 tiles in atlas
  const uvRotation   = spec.randomRotate ? (h >> 8) % 4 * 90 : 0;  // 0/90/180/270
  const mirror       = spec.randomMirror ? ((h >> 16) & 1) : 0;    // optional flip
  ```
  Apply `uvRotation`/`mirror` to that face's UVs when writing the quad. Add `variantCount`,
  `randomRotate`, `randomMirror` to blocks that need it (stone, dirt, cobblestone, netherrack,
  sand, gravel, deepslate). These keys are also part of the greedy-merge key (§1.5.2) — two
  faces with different `variantIndex`/`uvRotation` must NOT merge.

### 6.6 Implementation guardrails (agents)
- Canvas2D: write bytes into `ctx.createImageData(16,16)`, `putImageData`, upscale via CSS
  `image-rendering: pixelated`. Never let the browser bilinear-smooth a 16px texture.
- Shader path (optional): run the same math in a fragment shader to a 16×16 render target
  once, sample with `NEAREST`, quantize `uv` to texel centers `(floor(uv*16)+0.5)/16` so
  noise is per-texel under magnification.
- Do HSV→RGB and any palette-nearest snap in **OKLab** for perceptually even ramps (plain
  HSV per §4.12 is acceptable to ship v1).
- Every material seeds its hash with a **per-material constant** so blocks stay distinct and
  regen is stable.
- **Color space (P1) — decode sRGB, light in linear, encode sRGB.** Ramp hex in §2.2 is
  authored as **sRGB**. Set `atlasTexture.colorSpace = THREE.SRGBColorSpace` (done in §6.4)
  **and** `renderer.outputColorSpace = THREE.SRGBColorSpace`. All multiplies — per-face
  `shade[6]` (§1.5.1), AO (§1.5), light brightness (§1.7), and the biome tint (§1.6) — happen
  on the **linear** value the sampler returns; Three.js then encodes the framebuffer back to
  sRGB. Skipping this renders washed-out/dark and puts §4.11 in the wrong space. If you
  deliberately commit to gamma-space instead, say so and pre-adjust every ramp — do not leave
  it unspecified.
- **The whole system = one scalar-field builder (§4) + one ramp LUT (§2) + one global-light
  tint (§4.11), with three packs being three constant sets (§3).** Do not special-case.

### 6.7 Renderer affordances that consume the atlas (P3)
Direct downstream consumers of `genTexture` output the renderer must wire up:
- **Break / step / landing particles** — sample **random texels** of the broken block's tile
  and use the (roughly averaged) color to tint the particle. `genTexture` output must stay
  **sample-able per-texel** (keep the per-block tiles addressable in the atlas via the §6.4 UV
  rects; a particle picks `k = floor(rng()*256)` texels and averages).
- **Block selection outline** — draw a **~2px black outline** around the targeted block as a
  slightly inflated wireframe AABB (expand by ~0.002 to avoid z-fight), independent of the
  atlas; render after the world, depth-test on.
- **Destroy overlay pass** — composite `genDestroyOverlay(stage)` (§5.33 / §6.4) over the
  targeted block's faces (multiply/alpha blend, polygon-offset toward camera).
