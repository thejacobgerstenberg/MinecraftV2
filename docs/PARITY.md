# PARITY.md — Vanilla Minecraft Feature-Parity Audit (Master Backlog)

> **Reference:** Minecraft Java Edition, target baseline **1.20.x–1.21.x** ("Caves & Cliffs" density-function worldgen).
> **Stack:** Browser client in **TypeScript + Three.js (WebGL)**, greedy-meshed voxel chunks; **authoritative Node.js server over WebSockets**; shared TS types. **No external game assets — all textures/gradients procedurally generated.**
> **Audience:** Builder agents. Every entry is concrete: names, numbers, formulas, data shapes.
>
> **Priority tiers:**
> - **P0** = core sandbox: walk, place/break blocks, basic worldgen, chunk streaming, minimal block set.
> - **P1** = survival loop: health/hunger, crafting, tools, basic mobs, day/night, basic biomes.
> - **P2** = depth: redstone, enchanting, brewing, structures, villages, Nether.
> - **P3** = stretch: End, advancements, full mob roster, trial chambers, fine-tuned parity.
>
> **Global constants:** `1 game tick (gt) = 50 ms = 1/20 s`. `1 redstone tick (rt) = 2 gt`. `1 day = 24000 gt = 20 min`. Signal strength `SS ∈ [0,15]`. `2 HP = 1 heart`.

---

## Table of Contents
1. World Generation & Terrain
2. Biomes
3. Dimensions
4. Blocks
5. Items
6. Crafting
7. Tools & Armor
8. Mobs
8A. Player Movement & Physics
9. Combat
10. Health & Hunger
11. Status Effects
12. Redstone
13. Enchanting
14. Brewing
15. Progression / XP
16. Structures
17. Villages & Trading
18. Weather & Environment
19. Lighting
20. Fluids
21. Farming & Breeding
22. Game Modes
23. Difficulty
24. Commands
25. World Settings / Gamerules
26. Inventory & Containers
27. UI / HUD
28. Chat
29. Sound & Particles
30. Persistence
31. Multiplayer
32. Milestone Roadmap

---

## 1. World Generation & Terrain

> **Implementation note:** Run worldgen **server-side in a Web Worker pool** (Node `worker_threads`), one job per chunk-column. Model terrain as a **composable density-function graph** (`final_density(x,y,z) > 0 → solid`); caves and aquifers are subtractive/override passes on the same scalar field, not special-cased code. Use a **seeded xoroshiro128++** PRNG plus a `java.util.Random` LCG for legacy sub-systems; lock the positional-fork scheme first (every subsystem derives its seed from it). Sample climate/density at **quart (4-block) resolution** and trilinearly interpolate a **4(XZ)×8(Y) noise cell grid**. Ship the spline knot tables, climate `ParameterList`, and ore configured-feature lists as **data (JSON), not code** — hand-tuning will not reproduce recognizable terrain. Stream finished sections to the client; gate meshing until chunk `Status = full`.

### 1.1 Coordinate system & bounds
- [ ] Overworld build range **y ∈ [-64, 319]** (`min_y=-64`, `height=384`) — **[P0]** — store sections indexed -4..19; `sectionY = (idx-4)*16`.
- [ ] Sea level **y=63** overworld; Nether lava sea **y=31**; End sea **y=0** — **[P0]** — constant per dimension.
- [ ] Chunk = 16×16 columns × full height, subdivided into **16×16×16 sections** (24 in overworld) — **[P0]** — `Section` = 4096 blocks palette-indexed.
- [ ] World border default half-size **29,999,984**; hard block limit ±30,000,000; coord int limit ±2³¹ — **[P2]** — clamp in shared math utils.

### 1.2 Seeds & PRNG
- [ ] World seed = signed 64-bit long; numeric string→parse long; non-numeric→**Java `String.hashCode()`** sign-extended; empty→random — **[P0]** — BigInt-backed long in TS.
- [ ] `minecraft:legacy` = `java.util.Random` LCG (mult `0x5DEECE66D`, add `0xB`, 48-bit mask; scramble `(seed^mult)&mask`) — **[P0]** — reusable class.
- [ ] `minecraft:xoroshiro` = xoroshiro128++ (default for 1.18+ terrain/features) — **[P0]** — `forkPositional` for per-noise seeding.
- [ ] Per-chunk **population seed**: `worldSeed` advanced by `a·⌊x/16⌋ + b·⌊z/16⌋` (`a,b` odd longs from `Random(worldSeed)`) — **[P1]** — each feature adds salt `= popSeed + featureIndex + 10000·decorationStep`.
- [ ] Each climate/density noise seeded by hashing its resource-location string into world seed — **[P1]** — deterministic per-noise fork.
- [ ] Carvers, aquifers, ore veins, structure placement each get independent positional forks — **[P1]** — no cross-correlation.

### 1.3 Climate sampling (multi_noise biome source)
- [ ] 6 climate params at quart resolution: **temperature, humidity, continentalness, erosion, depth, weirdness** + derived **PV** — **[P1]** — Perlin/simplex octave stacks, independent seeds.
- [ ] **PV formula:** `PV = 1 − |(3·|weirdness|) − 2|` (Valleys→Low→Mid→High→Peaks) — **[P1]** — piecewise; `|ridges|` feeds PV.
- [ ] Continentalness zones: `mushroom_fields[-1.2,-1.05) deep_ocean[-1.05,-0.455) ocean[-0.455,-0.19) coast[-0.19,-0.11) near_inland[-0.11,0.03) mid_inland[0.03,0.3) far_inland[0.3,1.0]` — **[P1]** — data table.
- [ ] Temperature 5 levels, humidity 5 levels, erosion 7 levels (E0..E6), weirdness→PV 5 bands — **[P1]** — see §2.1 for exact thresholds.
- [ ] Biome = nearest point in 6D parameter space via k-d/`Climate.ParameterList` search — **[P1]** — ~60+ overworld biomes.

### 1.4 Density-function terrain pipeline
- [ ] Noise cell **4(XZ)×8(Y)** blocks, trilinear interpolation between sampled corners — **[P1]** — `size_horizontal=1, size_vertical=2`.
- [ ] `base_3d_noise` = `old_blended_noise` (`xz_factor=80, y_factor=160, smear_scale_multiplier=8`, xz/y_scale ≈0.25/0.125 ⚠verify) — **[P1]** — 3D wobble.
- [ ] `depth` = vertical gradient + spline offset (density falls ~linearly with height) — **[P1]** — offset shifts surface up/down.
- [ ] `sloped_cheese = 4·(depth + jaggedness·noise)·factor + base_3d_noise` — **[P1]** — combines splines + 3D noise; byproduct cheese caves.
- [ ] **Slides:** force density negative near y≈240→256 (air roof), positive near bottom (solid floor) — **[P1]** — gradient terms.
- [ ] `final_density > 0 → default_block`, else air/aquifer; clamp `initial_density` to [-64,64] — **[P1]** — interpolation stability.
- [ ] World-blending fields (`blend_offset/alpha/density`) for legacy 1.17 borders — **[P3]** — defer; only for upgrade parity.

### 1.5 Terrain-shape splines
- [ ] Three cubic splines map (continentalness, erosion, PV/ridges) → **offset, factor, jaggedness** — **[P1]** — copy knot tables verbatim as JSON.
- [ ] Behavior: oceans low+flat; coasts steep beach; low erosion+high PV→jagged mountains; high erosion→plateaus/plains — **[P1]** — emergent from splines.
- [ ] Rivers carved where `|weirdness|≈0` lowers offset below sea level along winding path — **[P1]** — secondary axis.

### 1.6 Caves — noise caves + carvers
- [ ] **Cheese caves:** large irregular caverns from `sloped_cheese` going negative underground — **[P2]** — biggest open volumes.
- [ ] **Spaghetti caves:** thin winding tunnels via `spaghetti_2d` + thickness/elevation modulators + roughness — **[P2]** — thickness ≈[-0.6,-1.3].
- [ ] **Noodle caves:** very thin worms, `noodle` toggle + thickness ≈[-0.05,-0.025] + ridge_a/b (freq≈2.667), y<~30 — **[P2]** — thin connectors.
- [ ] **Cave pillars** (`pillars` noise, rareness/thickness) & **cave entrances** (surface blend) — **[P3]** — rare columns/daylight openings.
- [ ] Carver `cave`: prob **0.15**/chunk, y bottom→180, radius mult h=1.0/v=1.0, floor_level=-0.7, branching — **[P2]** — sphere-tunnel carve mask.
- [ ] Carver `cave_extra_underground`: prob **0.07**, y bottom→~47 — **[P2]**.
- [ ] Carver `canyon` (ravine): prob **0.01**, y≈10→67, thickness/width_smoothness=3/vertical_rotation/yScale — **[P2]** — deep gashes.
- [ ] Lava fills carved air at **y ≤ -54** without local water aquifer — **[P2]** — see §1.7.

### 1.7 Aquifers
- [ ] `aquifers_enabled` overworld; global fallback: **water y63, lava y-54** — **[P2]** — per empty block below computed local fluid level.
- [ ] Local aquifer grid (~16×12×16) with `aquifer_barrier`, `floodedness`, `spread`, `aquifer_lava` noises — **[P2]** — underground lakes at varied heights, lava pockets deep.
- [ ] Aquifers suppress surface-rule sand/gravel over exposed water — **[P2]**.

### 1.8 Ore & mineral distribution
- [ ] Ore config shape `{ size, targets:[{stone→ore},{deepslate→deepslate_ore}], discard_on_air_exposure }` + placement `{count|rarity, height:uniform|trapezoid}` — **[P1]** — below y0 auto-swap to deepslate variant.
- [ ] **Coal** size 17: upper uniform y136–320 c30; lower trapezoid y0–192 c20 — **[P1]** — peak y≈96.
- [ ] **Iron** size 9/4: upper trapezoid y80–384(peak232) c90; middle y-24–56(peak16) c10; small uniform y-64–72 c10 — **[P1]**.
- [ ] **Copper** size 10/20: trapezoid y-16–112(peak48) c16; large in dripstone_caves — **[P1]**.
- [ ] **Gold** size 9: trapezoid y-64–32(peak-16) c4 discard0.5; badlands extra uniform y32–256 c50 — **[P1]**.
- [ ] **Redstone** size 8: uniform y-64–15 c4; lower trapezoid y-64–-32 c8 — **[P1]** — richest y≈-59.
- [ ] **Diamond** size 4/8/12: combined c7 trapezoid min-144/max16(peak-64); small/medium/large/buried configs — **[P1]** — best y-59…-64.
- [ ] **Lapis** size 7: triangle y-32–32(peak0) c2; buried uniform y-64–64 c4 — **[P1]**.
- [ ] **Emerald** mountain biomes only: per-block scatter c100, trapezoid peak≈232 — **[P2]**.
- [ ] **Infested stone** size 9 uniform y0–63 windswept/mountain — **[P3]**.
- [ ] **Nether Quartz** size 14 c16 uniform y10–117; **Nether Gold** size 10 c10 y10–117 — **[P2]**.
- [ ] **Ancient Debris** large size3 c1 trapezoid y8–24(peak16) buried; small size2 c1 uniform y8–119 — **[P2]** — no air exposure.
- [ ] Stone-variant blobs: dirt s33, gravel s33, granite/diorite/andesite s64 c2, tuff s64 c2 (y<0), clay disks near water — **[P1]**.

### 1.9 Large ore veins
- [ ] Toggled by `vein_toggle` density, shaped by `vein_ridged` + `vein_gap`, gated by `ore_veininess` — **[P3]** — distinct from blobs.
- [ ] **Copper veins** y0→50 filler granite (raw_copper_block + ore); **Iron veins** y-60→-8 filler tuff (raw_iron_block + air gaps) — **[P3]**.

### 1.10 Special underground features
- [ ] **Amethyst geode** ~1/24 chunks, y-58→30: smooth_basalt→calcite→amethyst_block shell, ~⅐ budding_amethyst, clusters, cracks — **[P3]**.
- [ ] **Lush caves** set: moss, azalea, cave_vines+glow_berries, spore_blossom, clay pools, dripleaf — **[P3]**.
- [ ] **Dripstone caves** set: pointed_dripstone up/down, clusters, columns — **[P3]**.
- [ ] **Deep Dark / sculk**: sculk, vein, catalyst, sensor, shrieker (Ancient City) — **[P3]**.
- [ ] **Fossils** (bone structures) + `glow_lichen` on cave walls — **[P3]**.

### 1.11 Bedrock, deepslate, sea/fluids
- [ ] Overworld bedrock floor: `P(bedrock)=1.0@y-64 → 0.0@y-59` (linear noise threshold); no roof; authoritative-only, unbreakable — **[P0]**.
- [ ] Nether bedrock roof y127→122 + floor y0→5; flat_bedrock option → single solid layer — **[P2]**.
- [ ] **Deepslate** replaces stone y≤0 with noisy band y0→-8; tuff blobs mostly below y0 — **[P1]**.
- [ ] Overworld water at/below y63 in open low terrain unless aquifer overrides — **[P0]**.
- [ ] Frozen biomes surface water→ice/packed_ice/blue_ice; icebergs — **[P2]**.
- [ ] Fluid springs (`spring_water`/`spring_lava`) single-source flows on cave walls; rare surface lava/water lakes — **[P2]**.

### 1.12 Surface rules & decoration order
- [ ] Column top cover from heightmap + surface noise: grass_block+dirt over stone; underwater→dirt/gravel/sand — **[P0]** — ordered rule chain, first match wins.
- [ ] Biome specifics: desert→sand/sandstone; badlands→red_sand + terracotta bands f(y); snowy→snow/powder_snow/ice; mushroom→mycelium; taiga→podzol; peaks→stone/calcite/packed_ice; swamp/mangrove→mud — **[P1]**.
- [ ] 11 decoration steps in order: RAW_GENERATION→LAKES→LOCAL_MODIFICATIONS→UNDERGROUND_STRUCTURES→SURFACE_STRUCTURES→STRONGHOLDS→UNDERGROUND_ORES→UNDERGROUND_DECORATION→FLUID_SPRINGS→VEGETAL_DECORATION→TOP_LAYER_MODIFICATION — **[P1]** — each feature its own salted seed.
- [ ] `TOP_LAYER_MODIFICATION` freeze pass: snow layer + ice by height-adjusted temperature — **[P1]**.

### 1.13 Chunk pipeline, ticking & storage
- [ ] ChunkStatus stages: `empty→structure_starts→structure_references→biomes→noise→surface→carvers→features→initialize_light→light→spawn→full` — **[P1]** — staged async generator; `features` needs 8-neighborhood.
- [ ] Game tick **50 ms (20 tps)** — **[P0]** — fixed server tick loop.
- [ ] **Random ticks:** `randomTickSpeed` (default 3) positions per section per tick; expected 3/4096 per block — **[P1]** — only within simulation distance.
- [ ] **Scheduled block ticks** (delay+priority queue): fluid flow, redstone, dispenser, TNT, piston, rail, portal — **[P1]** — separate `block_ticks` list.
- [ ] **Fluid ticks** serialized separately (`fluid_ticks`) with same priority/delay model — **[P2]**.
- [ ] Chunk ticket/load levels: 31=border, ≤32 block-ticking, ≤31 entity-ticking; sim distance gates ticking — **[P1]**.
- [ ] Anvil/NBT chunk storage: `sections[]` with `block_states{palette,data}` bit-packed `max(4,ceil(log2(len)))` no straddling, `biomes` at 4×4×4, `Heightmaps` 9-bit, `BlockLight/SkyLight` 2048B — **[P2]** — region files 32×32 chunks, 4 KiB sectors (see §30).
- [ ] **Heightmap types** stored per chunk (9-bit column values): **WORLD_SURFACE, OCEAN_FLOOR, MOTION_BLOCKING, MOTION_BLOCKING_NO_LEAVES**; `MOTION_BLOCKING` drives mob-spawn eligibility (§8.7), feature placement, and the rain/snow surface — **[P2]**.
- [ ] Shared TS `Section = { y; blocks:Uint16Array(4096); palette:BlockState[]; biomes:Uint8Array(64); skyLight?; blockLight? }` — **[P0]** — greedy-mesh from palette indices.

### 1.14 World types / presets
- [ ] **Default** (`minecraft:normal`) — **[P0]**.
- [ ] **Superflat** (`flat`): `{layers:[{block,height}], biome, structures}`, default 1 bedrock+2 dirt+1 grass — **[P1]** — no noise terrain.
- [ ] **Large Biomes** (×4 climate scale), **Amplified** (density amplified), **Single Biome** — **[P2]**.
- [ ] **Debug** (`debug_all_block_states`) grid at y70, barrier plane — **[P3]** — dev only.
- [ ] Custom datapack noise_settings/world_preset/dimension override — **[P3]**.

---

## 2. Biomes

> **Implementation note:** Store biome per **(x, y÷4, z)** cell (4×4×4 resolution) — biome is 3D so cave biomes work. Bake grass/foliage/water tint as **per-vertex color** in the greedy mesh, sampling biome colors in a small radius and averaging to avoid hard chunk-seam popping (matches vanilla color smoothing). **Procedurally generate** the 256×256 grass & foliage gradient LUTs from the §2.4 formulas (no assets). Fog/sky are per-dimension shader profiles keyed off the camera's biome cell.

### 2.1 Climate parameter bands (exact thresholds)
- [ ] Temperature 5 levels: `0:[-1.0,-0.45) 1:[-0.45,-0.15) 2:[-0.15,0.2) 3:[0.2,0.55) 4:[0.55,1.0]` — **[P1]** — data table.
- [ ] Humidity 5 levels: `0:[-1.0,-0.35) 1:[-0.35,-0.1) 2:[-0.1,0.1) 3:[0.1,0.3) 4:[0.3,1.0]` — **[P1]**.
- [ ] Erosion 7 levels: `0:[-1,-0.78) 1:[-0.78,-0.375) 2:[-0.375,-0.2225) 3:[-0.2225,0.05) 4:[0.05,0.45) 5:[0.45,0.55) 6:[0.55,1]` — **[P1]**.
- [ ] PV bands: `valleys[-1,-0.85) low[-0.85,-0.6) mid[-0.6,0.2) high[0.2,0.7) peaks[0.7,1]` — **[P1]** — weirdness sign selects normal vs weird/shattered variants.
- [ ] Depth axis selects cave biomes (depth>0) independent of surface — **[P2]**.

### 2.2 Biome data shape
- [ ] `Biome = { temperature, downfall, has_precipitation, temperature_modifier, effects{colors,particle,sounds,music}, spawners, spawn_costs, carvers, features[][] }` — **[P1]** — shared TS type.

### 2.3 Biome roster (Overworld + Nether + End; tag core set per tier)
- [ ] **Core P1 set (~12):** plains, forest, birch_forest, taiga, snowy_plains, desert, savanna, beach, river, ocean, swamp, windswept_hills — **[P1]** — minimal recognizable world.
- [ ] Temperate/lush: sunflower_plains, flower_forest, old_growth_birch_forest, dark_forest (grass_modifier), mangrove_swamp, jungle, sparse_jungle, bamboo_jungle, cherry_grove, meadow, mushroom_fields — **[P2]**.
- [ ] Cold/mountain: snowy_taiga, old_growth_pine_taiga (podzol), old_growth_spruce_taiga, windswept_gravelly_hills, windswept_forest, windswept_savanna, grove, snowy_slopes, frozen_peaks, jagged_peaks, stony_peaks, ice_spikes, snowy_beach, stony_shore — **[P2]**.
- [ ] Warm/dry: savanna_plateau, badlands, eroded_badlands, wooded_badlands — **[P2]**.
- [ ] Rivers/beaches: frozen_river — **[P2]**.
- [ ] Oceans (9): ocean, deep_ocean, warm_ocean(0x43D5EE), lukewarm_ocean(0x45ADF2), deep_lukewarm_ocean, cold_ocean(0x3D57D6), deep_cold_ocean, frozen_ocean(0x3938C9), deep_frozen_ocean — **[P2]** — water_color drives fish.
- [ ] Cave biomes: dripstone_caves, lush_caves, deep_dark (sculk, no natural mobs, ancient_city) — **[P3]**.
- [ ] **Nether biomes:** nether_wastes, soul_sand_valley, crimson_forest, warped_forest, basalt_deltas — each drives its own mob spawn list, fog color, and ambient particles (ash / warped_spore / soul_speed) — **[P2]** — feeds §3 Nether DimensionType.
- [ ] **End biomes:** the_end (central island), end_highlands, end_midlands, end_barrens, small_end_islands (outer ring) — **[P3]** — feeds §3 End DimensionType.

### 2.4 Computed colors (procedural, no assets)
- [ ] Constants `fog=0xC0D8FF water=0x3F76E4 water_fog=0x050533` — **[P1]** — defaults.
- [ ] Sky color `HSVtoRGB(0.62222 − clamp(temp/3,-1,1)·0.05, 0.5 + clamp(temp/3,-1,1)·0.1, 1.0)` — **[P1]**.
- [ ] Grass/foliage LUT index `x=(1−temp')·255, y=(1−downfall'·temp')·255` (clamp 0..1); warm-dry→~0xBFB755, cold-wet→~0x4C7F3D — **[P1]** — generate 256×256 gradients.
- [ ] grass_color_modifier: dark_forest `(c&0xFEFEFE + 0x28340A)>>1`; swamp perlin picks 0x4C763C/0x6A7039 — **[P2]**.
- [ ] temperature_modifier "frozen": low-freq noise → ice-vs-water patches — **[P2]**.

### 2.5 Gameplay biome tags
- [ ] Terrain/dimension tags (`#is_overworld #is_forest #is_ocean #is_mountain …`) drive mob spawns & mechanics — **[P2]** — build as tag sets.
- [ ] Behavior tags: `#spawns_warm/cold_variant_frogs`, `#has_closer_water_fog`, `#snow_golem_melts`, `#allow_surface_slime_spawns`, `#stronghold_biased_to`, `#without_zombie_sieges` — **[P3]**.

---

## 3. Dimensions

> **Implementation note:** Model each dimension as a shared **`DimensionType`** record and drive engine behavior (skylight, bed explosion, ultrawarm lava, spawn light) from its fields — do not hard-code per-dimension branches. Portal linking is an **authoritative server op**: search loaded/generated target chunks within radius, else force-place an obsidian platform. Keep a persisted **DragonFight state machine** per world.

### 3.1 Dimension registry
- [ ] `DimensionType = { min_y, height, logical_height, coordinate_scale, ambient_light, has_skylight, has_ceiling, ultrawarm, natural, bed_works, respawn_anchor_works, piglin_safe, has_raids, fixed_time?, monster_spawn_light_level, infiniburn, effects }` — **[P0]** — shared TS type.
- [ ] **Overworld:** min_y-64/h384, scale1.0, skylight yes/ceiling no, natural, bed_works, has_raids, day cycle, spawn light uniform 0–7 — **[P0]**.
- [ ] **Nether:** min_y0/h256/logical128, scale8.0, ambient0.1, no skylight/ceiling yes, ultrawarm, respawn_anchor_works, fixed_time18000, spawn light const 7, lava sea y31, bedrock floor 0–4 roof 123–127 — **[P2]**.
- [ ] **End:** min_y0/h256, scale1.0, ambient0, no skylight/no ceiling, bed&anchor explode, has_raids, fixed_time6000, spawn light uniform 0–7 — **[P3]**.

### 3.2 Dimension mechanics
- [ ] Nether ultrawarm: water buckets evaporate on placement; lava flows 8 blocks & faster — **[P2]**.
- [ ] Nether beds explode (power 5, set fire); respawn anchor valid — **[P2]**.
- [ ] Nether compass/clock spin; no skylight → hostiles spawn any time; ceiling caps travel — **[P2]**.
- [ ] Nether portals spawn zombified piglins occasionally — **[P3]**.
- [ ] End: beds & anchors explode; custom void starfield sky; void y<0 = instant fall-out — **[P3]**.

### 3.3 Portals
- [ ] **Nether Portal:** obsidian frame interior 2×3→21×21 (corners optional, min 10 obsidian); fill `nether_portal` light11, `axis`; ignite by any fire — **[P2]**.
- [ ] Traversal: 80 gt (4s) charge survival, instant creative; entity cooldown 300 gt — **[P2]**.
- [ ] Linking: target=source×scale (÷8 to nether, ×8 to over), Y clamped; search existing within **128-block** radius; else build in 16-radius; else force platform — **[P2]** — emergent, no link table.
- [ ] **End Portal:** 12 `end_portal_frame` in 3×3 ring facing inward, each 10% pre-eye; all eyes→9 `end_portal`; teleport to (100,48–50,0) 5×5 obsidian platform — **[P3]**.
- [ ] **Exit Portal:** bedrock frame + end_portal at (0,~64,0), dragon egg first-kill; standing→overworld spawn + credits — **[P3]**.
- [ ] **End Gateway:** bedrock frame + 1 `end_gateway`, magenta beam, up to 20 (ring r≈96), teleports ~1000 blocks out in linked pairs — **[P3]**.

### 3.4 Ender Dragon fight
- [ ] 10 obsidian pillars r≈43, heights 76–103, each topped end_crystal on bedrock; tallest have iron cages — **[P3]**.
- [ ] Dragon 200 HP; phases circling/strafing (dragon-fireball→lingering acid)/perch(melee-vulnerable head only)/charging — **[P3]**.
- [ ] Crystals heal dragon +2 HP/s when near; crystal explosion damages charging dragon ~10 HP — **[P3]**.
- [ ] On death: ~12000 XP (first)/500 (later); exit portal opens; 1 gateway/kill; boss bar — **[P3]**.
- [ ] Respawn: place 4 end_crystals on exit-portal edges → resets pillars/crystals — **[P3]**.

---

## 4. Blocks

> **Implementation note:** Drive all block behavior from a shared **`BlockDef`** scalar-field table (below) — one data record per block type. Block breaking is **server-authoritative**: client predicts, server validates via the canonical break-time formula. Textures are procedurally generated per material (noise + palette). ~1050 blocks / ~28k blockstates in vanilla — implement the **property registry and systems exhaustively**, but only the representative content set per tier. Non-cube blocks (stairs/slabs/fences/panes/walls) need voxel AABB collision/outline shapes.

### 4.1 BlockDef property model (implement first — drives everything)
- [ ] `BlockDef = { id, hardness, blastResistance, toolClass, requiresCorrectTool, harvestTier:0-4, luminance:0-15, opacity:0-15, mapColor, soundType, friction, jumpVelocityMult, velocityMult, flammable, fireSpreadEncouragement, flammability, gravity, replaceable, fluidState, waterloggable, collisionShape, outlineShape, pushReaction, emitsRedstone, hasBlockEntity }` — **[P0]** — shared TS type.
- [ ] **Break-time formula:** `speed = effective?tool.miningSpeed:1.0`; `×(1+0.2·haste)`; `+= effective&&eff>0 ? eff²+1 : 0`; `×0.3^fatigue`; `/5 if inWater&&!aquaAffinity`; `/5 if !onGround`; `damagePerTick = speed/hardness/(canHarvest?30:100)`; breaks when accumulated ≥1 — **[P0]**.
- [ ] `canHarvest = !requiresCorrectTool || (toolClass matches && tier≥harvestTier)`; wrong tool = 5× slower + no drop — **[P0]**.
- [ ] `hardness==0` → instant break (flowers, torches, TNT, sapling, dust) — **[P0]**.
- [ ] Representative hardness/blast/tool/tier table (dirt 0.5 shovel0, stone 1.5 pick1, deepslate 3.0, ores 3.0 pick1-3, deepslate ore 4.5, obsidian 50/1200 pick4, ancient_debris 30/1200, glass 0.3, leaves 0.2, bedrock -1) — **[P0]** — ship as JSON.
- [ ] Gravity blocks: sand, red_sand, gravel, concrete_powder×16, anvil×3, dragon_egg, scaffolding, pointed_dripstone, suspicious_sand/gravel — **[P1]** — spawn FallingBlockEntity.
- [ ] Light emitters (luminance): glowstone/sea_lantern/lava/jack_o_lantern/froglight/lantern 15; torch/end_rod 14/7; lit_furnace/redstone_lamp 13/15; magma 3; candle 3–12 — **[P1]** — see §19.
- [ ] `friction` (ice 0.98, packed/blue_ice 0.989, slime 0.8, default 0.6), `velocityMult` (soul_sand 0.4, honey), `jumpVelocityMult` (honey/soul_sand) — **[P1]**.

### 4.2 Block taxonomy (categories + tier core sets)
- [ ] **Terrain/natural (~120):** stone, deepslate, granite/diorite/andesite/tuff/calcite, dirt/coarse/rooted, grass_block, podzol, mycelium, sand/red_sand, gravel, clay, mud, bedrock, obsidian, ores+deepslate variants, netherrack, soul_sand/soil, magma, glowstone, basalt, blackstone, end_stone, ice family, snow, powder_snow, dripstone, moss, amethyst, prismarine, coral, sponge — **[P0]** core: stone, dirt, grass_block, sand, gravel, water, log — **[P1]** ores/deepslate.
- [ ] **Building (~500):** wood sets ×11 (log/stripped/wood/planks/stairs/slab/fence/gate/door/trapdoor/plate/button/sign/hanging_sign), stone families, concrete×16, concrete_powder×16, terracotta+glazed×16, wool×16, carpet×16, glass+stained×16+tinted+panes, copper oxidation stages+waxed+cut, all slab/stair/wall variants — **[P1]** core planks/cobblestone/glass/wool — **[P2]** full palette.
- [ ] **Functional block entities (~60):** crafting_table, furnace/blast/smoker, chest/trapped/ender/barrel, shulker_box×16, hopper/dropper/dispenser, brewing_stand, enchanting_table, anvil×3, grindstone, stonecutter, cartography/fletching/smithing_table, loom, composter, cauldron, bell, beacon, conduit, lodestone, respawn_anchor, lectern, jukebox, note_block, bed×16, campfire/soul, beehive, decorated_pot, crafter, sign, banner×16, skull×6, flower_pot, item_frame, armor_stand, spawner, trial_spawner+vault, end_portal_frame, dragon_egg — **[P1]** crafting_table/furnace/chest — **[P2]** most — **[P3]** trial/vault.
- [ ] **Redstone (~40):** dust, torch, block, lamp, lever, button, plates×4, tripwire+hook, target, daylight_detector, observer, repeater, comparator, piston+sticky, slime/honey, dispenser/dropper/hopper, rails×4, TNT, note_block, lightning_rod, sculk sensor/shrieker/catalyst, copper_bulb, crafter, big_dripleaf — **[P2]** — see §12.
- [ ] **Plants/vegetation (~130):** saplings, flowers (all), 2-tall plants, grass/fern, dead_bush, seagrass/kelp, sea_pickle, vines, glow_lichen, lily_pad, bamboo, sugar_cane, cactus, crops (wheat/carrot/potato/beetroot/nether_wart/berries/cocoa/stems/torchflower/pitcher/glow_berries), mushrooms+fungi, moss, azalea, dripleaf, spore_blossom, mangrove_propagule, chorus, leaves — **[P1]** core wheat/sapling/grass/flower — **[P2]** full.
- [ ] **Fluids:** water (source+levels 1–7), lava (source+flow), waterlogging — **[P0]** — see §20.

### 4.3 Blockstate & property system
- [ ] `blockstate = { block:string, props:Record<string, string|number|boolean> }`; property types bool/int-range/enum — **[P0]** — property registry, not per-block.
- [ ] Common props: `facing/horizontal_facing, axis, half, part, hinge, open, powered, lit, waterlogged, snowy, persistent+distance, shape (stairs/rails), age, level, layers, bites, candles/pickles/eggs, power, delay, mode, note+instrument, rotation, moisture, in_wall, eye, triggered, extended, attachment+face` — **[P1]**.
- [ ] Wall connections `up + north/east/south/west (none/low/tall)`; fence/pane/dust/glass bool connections — **[P1]** — drives greedy-mesh shape selection.
- [ ] Block entities carry extra NBT beyond blockstate (chest inventory, sign text, spawner data, etc.) — **[P1]** — separate store keyed by BlockPos.

### 4.4 Interactive block behaviors
- [ ] **Cauldron:** water / lava / powder_snow variants, level **0–3**; fills slowly from rain or a pointed_dripstone above lava/water; washes dye off leather armor & patterns off banners/shulker_box; dyes water for leather-armor coloring; extinguishes a burning entity standing in it (−1 level); comparator reads level (0/1/2/3 → SS 0/1/2/3); lava cauldron ignites/damages entities inside — **[P2]**.
- [ ] **Campfire:** cooks **4** raw foods in **30s** with no fuel and no XP; deals **1 dmg/tick** to entities on top; emits a smoke particle column (taller if a hay_bale is beneath = signal fire); lit/extinguished by water, shovel, or waterlogging; `soul_campfire` (blue, **2 dmg/tick**, taller smoke, repels piglins within radius); calms bees within 5 blocks during honey harvest — **[P2]**.

---

## 5. Items

> **Implementation note:** `ItemStack = { id, count, components }` (1.20.5+ data components replace flat NBT). Stack sizes drive inventory math. Item textures procedurally generated. Represent tools/armor/food via optional sub-records on `ItemDef`. Server owns authoritative inventory; client mirrors.

- [ ] `ItemDef = { id, maxStack:1|16|64, maxDurability?, toolTier?, attackDamage?, attackSpeed?, food?, armor? }` — **[P0]** — shared TS type.
- [ ] Stack sizes: default 64; 16 (snowball, egg, ender_pearl, sign, honey_bottle, armor_stand, bucket-of-fish); 1 (tools, armor, potions, filled buckets, boats, minecarts, saddle, cake) — **[P0]**.
- [ ] `components`: `custom_name, item_name, lore, damage, max_damage, enchantments, stored_enchantments, unbreakable, attribute_modifiers, can_break, can_place_on, potion_contents, food, container, dyed_color, trim` — **[P2]**.
- [ ] Creative-tab taxonomy: Building/Colored/Natural/Functional/Redstone Blocks, Tools&Utilities, Combat, Food&Drinks, Ingredients, Spawn Eggs, Operator Utilities — **[P1]** — item registry grouping + search.
- [ ] Non-block item classes: ingots/nuggets/raw metals/gems, sticks, coal/charcoal, food, seeds, dyes×16, potions/splash/lingering, tipped_arrows, music_discs, banners/patterns, maps, books, smithing_templates, pottery_sherds, buckets (empty/water/lava/milk/powder_snow/fish×4/axolotl/tadpole), boats/chest_boats, minecarts×5, end_crystal, firework_rocket+stars, experience_bottle — **[P1]** core — **[P2]** full.
- [ ] **Maps:** `empty_map` → `filled_map` on first use; scale **1:1 → 1:16** via 4 cartography_table zoom levels (0–4); renders terrain map-colors + player/other markers (arrows); banner markers; item-frame display (glow_item_frame locks a static snapshot); map cloning; explorer maps point to structures; **updates only while held** (frozen when placed in a frame) — **[P2]**.
- [ ] **Books & lecterns:** `writable_book` (book & quill) up to **100 pages**, ~**1024 chars/page**, editable; sign → `written_book` with author + generation copy tiers (original → copy → copy-of-copy → un-copyable); `lectern` holds one book (comparator outputs current page, right-click turns pages broadcast to nearby readers); `chiseled_bookshelf` 6 slots + per-slot comparator — **[P2]**.
- [ ] **Item-use cooldown (`ItemCooldowns`):** per-item-type cooldown with a HUD radial-sweep overlay (§27); ender_pearl ~**20gt**, chorus_fruit **20gt**, goat_horn **140gt**, shield **100gt** after an axe-disable, mace attack — **[P2]** — server-authoritative, blocks spam re-use.
- [ ] **1.17–1.21 items:** `bundle` (holds 64 "weight" of mixed items, right-click to cycle contents, 1.21), `spyglass` (zoom + scope overlay), `goat_horn` (8 variants, 140gt cooldown), `recovery_compass` (points to last death location, spins if in another dimension), `brush` (archaeology, §21), `ominous_bottle`/`trial_key`/`ominous_trial_key`, `mace` (1.21; smash-attack damage scales with fall distance + Density/Breach/Wind Burst) — **[P2]** / **[P3]**.
- [ ] **Fireworks:** `firework_rocket` = paper + 1–3 gunpowder → `flight_duration` 1–3; used from hand launches / boosts an elytra glide (~10gt forward thrust); crossbow-fired rockets deal **5–18** explosion damage per star (exploding stars also hurt a gliding flier); `firework_star` = gunpowder + dye(s) + optional shape (small_ball default / large_ball=fire_charge / star=gold_nugget / creeper=mob head / burst=feather) + fade dyes + trail(diamond) + twinkle/flicker(glowstone_dust) — **[P2]**.

---

## 6. Crafting

> **Implementation note:** Store recipes as **JSON data** (one shape per type) matching vanilla schema; resolve ingredients against **item tags** (`#minecraft:planks`). Recipe matching is server-authoritative; client shows preview + recipe book. Shaped recipes are position-relative and horizontally mirrorable.

- [ ] 2×2 (inventory) & 3×3 (table) grids + output slot + recipe book (unlock/filter) — **[P1]**.
- [ ] **Shaped** `{ pattern, key, result }` — position-relative, mirrorable — **[P1]**.
- [ ] **Shapeless** `{ ingredients[≤9], result }` — any arrangement — **[P1]**.
- [ ] **Smelting family:** smelting (furnace 200gt/10s), blasting (100gt/5s ores), smoking (100gt/5s food), campfire_cooking (600gt/30s, no fuel, 4 slots, no XP) `{ ingredient, result, experience, cookingtime }` — **[P1]**.
- [ ] **Smithing:** smithing_transform (netherite upgrade, keeps enchants/durability%), smithing_trim (18 patterns × ~10 materials, cosmetic) — **[P2]**.
- [ ] **Stonecutting** 1→1 (variable count) single-ingredient — **[P2]**.
- [ ] Special hardcoded recipes: armor dyeing, firework rockets/stars, banner patterns, book/map cloning, tipped arrows (8 around lingering), shulker dyeing, suspicious stew — **[P2]**.
- [ ] Smelting XP (on collect, accumulated): iron 0.7, gold 1.0, food ~0.35, cactus 1.0, sand→glass 0.1, ancient_debris 2.0 — **[P1]**.
- [ ] Fuel burn times (items): lava_bucket 100 (returns bucket), coal/charcoal 8, coal_block 80, blaze_rod 12, dried_kelp_block 20, planks/logs/wooden 1.5, stick/sapling 0.5, bamboo 0.25 — **[P1]**.

---

## 7. Tools & Armor

> **Implementation note:** Tool/armor stats live on `ItemDef`. Attack cooldown & damage scaling, armor reduction, and durability are server-authoritative. Model the 6 tier materials + 5 tool classes as data. Enchantments modify computed values via §13.

### 7.1 Tool tiers
- [ ] Material table `{ durability, miningSpeed, atkDmgBonus, enchantability, harvestTier }`: Wood 59/2.0/+0/15/1, Stone 131/4.0/+1/5/2, Iron 250/6.0/+2/14/3, Gold 32/12.0/+0/22/1, Diamond 1561/8.0/+3/10/4, Netherite 2031/9.0/+4/15/4(fire-immune) — **[P1]**.
- [ ] Tool classes & effective blocks: pickaxe (stone/ore/metal), axe (wood; strips/scrapes/wax-off), shovel (dirt/sand; path), hoe (leaves/hay/sculk; till), shears (wool/leaves/web), sword (bamboo/web 15×) — **[P1]**.
- [ ] Attack damage table (incl base 1) & speed: Sword 4–8 @1.6, Axe 7–10 @0.8–1.0, Pickaxe 2–6 @1.2, Shovel 2.5–6.5 @1.0, Hoe 1 @tier — **[P1]**.
- [ ] Durability consumption: mine/hit 1, sword block-break 2, armor 1 per 4 dmg absorbed; Unbreaking `1/(L+1)` (armor `0.6+0.4/(L+1)`); Mending 2 durability/XP — **[P1]**.

### 7.2 Ranged weapons
- [ ] Bow: draw ≤20gt; arrow velocity 0→3/tick; full-charge dmg 6–10; Power +25%/L; Punch/Flame/Infinity — **[P2]**.
- [ ] Crossbow: load 1.25s, holds charge; dmg 6–11; Multishot 3 (±10°); Piercing; fireworks 5–18; Quick Charge — **[P2]**.
- [ ] Trident: melee 9/ranged 8 @1.1; Loyalty, Riptide, Channeling, Impaling — **[P3]**.
- [ ] Shield: blocks frontal within cone, activates 5gt after raise; disabled by axe (~25%+5%/Efficiency, 5s lockout); warden bypasses — **[P2]**.

### 7.3 Armor
- [ ] Per-piece armor points & toughness: Leather 1/3/2/1(7), Gold 2/5/3/1(11), Chain 2/5/4/1(12), Iron 2/6/5/2(15), Diamond 3/8/6/3(20,T2), Netherite 3/8/6/3(20,T3,KBres0.1) — **[P1]**.
- [ ] Durability = baseSlot(helm11/chest16/legs15/boots13) × materialMult (leather5/gold7/chain15/iron15/diamond33/turtle25/netherite37) — **[P1]**.
- [ ] Damage reduction: `damage·(1 − clamp(max(def/5, def−dmg/(2+tough/4)),0,20)/25)` then EPF `×(1−min(EPF,20)/25)` — **[P1]** — see §9.2.
- [ ] Turtle helmet → Water Breathing when worn; leather armor → freeze immunity — **[P2]**.
- [ ] Armor trims: 18 patterns × 10 materials via smithing_trim (cosmetic overlay) — **[P3]**.

### 7.4 Elytra
- [ ] Elytra: worn in the **chestplate slot**; pitch-based glide (look down → gain speed, up → climb then stall; momentum-conserving velocity integration each tick — horizontal + vertical vector coupling) — **[P3]**.
- [ ] `firework_rocket` (starless) boosts forward while gliding (~10gt thrust); kinetic damage on wall impact ∝ speed; durability **432**, becomes **unusable at 1** (not 0); repaired with `phantom_membrane` on an anvil — **[P3]**.

---

## 8. Mobs

> **Implementation note:** Server-authoritative AI. Each mob = **goal selector + target selector** (priority-ordered) + **A\* pathfinding** over a block-node graph with per-mob node evaluators (water/lava/fire/cactus malus, door/fence handling). Client only interpolates transmitted positions + plays animations. Spawn attempts are chunk-tick-driven within simulation distance, gated by mob-cap formula. Represent stats via `EntityAttributes`.

### 8.1 Health & attributes
- [ ] Entity attributes: `max_health, movement_speed, attack_damage, attack_speed, armor, armor_toughness, knockback_resistance, follow_range, jump_strength` + 1.20.5 additions (scale, gravity, step_height, block/entity_interaction_range, safe_fall_distance, max_absorption) — **[P1]**.
- [ ] Modifier ops: `add_value`, `add_multiplied_base` (×base), `add_multiplied_total` (compounding final) — **[P2]** — order: base→add→mult_base→mult_total.

### 8.1a Base Entity model (shared by ALL entities)
- [ ] `Entity` base fields carried by every entity (mob, player, item, projectile, falling block, painting, …): `UUID, Pos, Motion(velocity), Rotation(yaw,pitch), onGround, fireTicks, air(300 default), portalCooldown, invulnerableTime(10gt i-frames), noGravity, Glowing, freezeTicks/ticksFrozen, fallDistance, passengers[]/vehicle (riding stack), Tags[], CustomName?` — **[P1]** — shared TS `Entity` interface; `EntityAttributes` (§8.1) is a mob/player sub-record layered on top.
- [ ] Physics (gravity, drag, AABB collision, fluid buoyancy) apply to **all** entities via per-entity-type constants (see §8A + §8.9–8.11), not just players/mobs — **[P1]**.

### 8.2 Passive mobs (~35)
- [ ] Core P1 set: chicken(4), pig(10), cow(10), sheep(8, wool+dye), rabbit(3) — **[P1]** — breeding/drops/AI.
- [ ] Additional: mooshroom, cat, ocelot, squid(10), glow_squid, fox, dolphin, frog, bee, axolotl(14), sniffer, horse/donkey/mule, llama, villager(20), wandering_trader, panda, strider, allay, turtle(30), camel(32), armadillo, bat, parrot, fish(cod/salmon/tropical/pufferfish) — **[P2]**.
- [ ] Utility golems: snow_golem(4), iron_golem(100, 7–21 melee) — **[P2]**.

### 8.3 Neutral mobs (~8)
- [ ] wolf(8/20 tame, 3–4), spider(16, climbs, light≥12 passive), cave_spider(12, poison), piglin(16, barter), zombified_piglin(20, group aggro), goat(10, ram-KB), polar_bear(30), enderman(40, teleport, aggro on eye-look ≤64, water hurts) — **[P2]** — retaliate-on-hit target selector.

### 8.4 Hostile mobs (~30)
- [ ] Core P1 set: zombie(20, day-burn, →Drowned 30s), skeleton(20, strafe+bow, day-burn), creeper(20, 1.5s fuse r≈3), spider(16) — **[P1]**.
- [ ] Additional: husk, drowned, stray, wither_skeleton(+Wither), bogged, silverfish, endermite, slime(16/4/1 split), magma_cube, ghast(fireball), blaze(3-fireball), phantom(insomnia≥3days), witch(potions), guardian(30, laser), elder_guardian(80, Mining Fatigue III), shulker(30, Levitation bullet), vex, evoker, vindicator, pillager, ravager(100), hoglin(40)/zoglin, piglin_brute(50), breeze(30, wind charge), warden(500, 30 melee/10 sonic bypass) — **[P2]** core Nether/raid — **[P3]** breeze/warden/bogged.

### 8.5 Bosses
- [ ] **Ender Dragon** 200 HP, healed by crystals, head-only damage, drops 12000/500 XP + egg + portal, boss bar — **[P3]**.
- [ ] **Wither** 300 HP, built 4 soul_sand(T)+3 skulls, phase 2 <50% (arrow-immune/flies/heals), wither skulls, drops nether_star, boss bar — **[P3]**.

### 8.6 AI systems
- [ ] Goal selector goals: Float, Panic, Tempt, Breed, FollowParent, MeleeAttack, RangedAttack, AvoidEntity, RandomStroll, LookAtPlayer, OpenDoor, RestrictSun/FleeSun — **[P1]**.
- [ ] Target selectors: NearestAttackableTarget, HurtByTarget, DefendVillage, ResetUniversalAnger — **[P1]**.
- [ ] Pathfinding A* with malus per block type, cliff avoidance (fall>safe height), path range = follow_range (default 16, zombie 35) — **[P1]**.
- [ ] Senses: line-of-sight vision; Warden uses `game_event` vibration + smell; shrieker warning 1→3 summons Warden — **[P3]**.

### 8.7 Spawning
- [ ] Spawn attempts each tick per player: random chunks in 17×17 area, pack 1–4 of one type from biome weighted list — **[P1]**.
- [ ] Valid spawn: opaque solid top, ≥2 air space, light/biome/dim/Y conditions, difficulty≠Peaceful for hostiles, not within radius of player/spawn — **[P1]**.
- [ ] Hostile light rule (1.18+): **block light == 0** (pre-1.18 ≤7); passives sky ≥9 + grass — **[P1]**.
- [ ] Mob cap per category `cap × spawnableChunks/289`: Monster 70, Creature 10, Ambient 15, Water_creature 5, Water_ambient 20, Axolotl 5, Underground_water 5 — **[P1]**.
- [ ] Slimes: slime-chunks Y<40 or swamp Y50–70 night/moon; mob spawner blocks (≤16 blocks, 1–4 every 200–800gt, cap 6) — **[P2]**.
- [ ] Regional/local difficulty (0–6.75, from world day + inhabited time + moon) scales gear/enchant/reinforcement/baby-chance — **[P2]**.
- [ ] Trial Spawner (1.21): waves scale with player count; ominous variant — **[P3]**.

### 8.8 Despawning & drops
- [ ] Despawn: >128 instant; 32–128 → 1/800 per tick; ≤32 none; persistent = named/picked-up/leashed/tamed/bred — **[P1]**.
- [ ] XP orbs (only if `lastHurtByPlayer`): passive 1–3, most hostiles 5, blaze/elder_guardian 10, wither 50, dragon 12000/500, slime/magma by size — **[P1]**.
- [ ] Drops: common table 0–2 (+1/Looting L), equipment 8.5%+Looting (damaged), fire kill→cooked, charged-creeper→mob head, wither kill→wither_rose, skeleton-kills-creeper→music disc — **[P2]**.

### 8.9 Item entities (dropped items)
- [ ] `ItemEntity = { stack:ItemStack, pickupDelay=10gt, age, despawnAge=6000gt (5 min) }` — spawned on every block break, mob death, and Q-drop; cornerstone of the survival loop — **[P0]**.
- [ ] Behavior: gravity 0.04 b/t² + drag 0.98 (bobs on ground); **merges** with nearby identical stacks (within ~0.5 blocks, sum ≤ maxStack); floats & drifts along flowing water; burns in fire/lava; destroyed by explosions & cactus; **vacuumed** by hoppers (§12.5); picked up into inventory when `pickupDelay==0` and space exists — **[P1]**.
- [ ] Q-drop tosses one with forward velocity; Ctrl+Q / drag-outside drops the whole stack — **[P1]**.

### 8.10 Projectile entities
- [ ] Each projectile is a moving entity: launch from shooter eye + velocity, integrate own gravity then own drag each tick; raycast for block/entity impact — **[P1]**.
- [ ] `arrow`: gravity **0.05 b/t²**, drag **0.99** air / **0.6** water; sticks in blocks (pickup in survival); crit dmg on full-charge; `tipped_arrow` (applies potion) / `spectral_arrow` (Glowing 10s) — **[P1]**.
- [ ] `snowball`, `egg` (1/8 spawns chick), `ender_pearl` (teleport shooter to impact + **5 fall dmg**, ~**20gt** cooldown, ~5% spawns endermite), `experience_bottle` — **[P2]**.
- [ ] `splash_potion` / `lingering_potion` → spawn `area_effect_cloud` entity (radius shrinks over ~30s, ~¼ effect per exposure) — **[P2]**.
- [ ] `trident` (Loyalty returns / Riptide launches player), `fireball` & `small_fireball` (deflectable on hit), `wither_skull` (blue = homing), `dragon_fireball`, `wind_charge`, `fishing_bobber` (§21), `firework_rocket` (§5) — **[P2]** / **[P3]**.

### 8.11 Falling & primed entities
- [ ] `FallingBlockEntity` (spawned by §4.1 gravity blocks): on landing **places its block**, or **drops as item** if the target cell is occupied/unsupported; anvil & pointed_dripstone deal fall damage scaling with fall distance to entities directly below; concrete_powder → concrete on contact with water mid-fall — **[P1]**.
- [ ] `PrimedTnt`: **80gt** fuse, launched with small upward velocity (~0.2 b/t), explosion **power 4** (§9.3), chain-ignites other TNT caught in the blast — **[P1]**.

### 8.12 Riding & mounts
- [ ] Horse: tame by repeated mounting (temper/chance); spawn-rolled attributes — `jump_strength` **0.4–1.0** → **1.1–5.2** block jump, `movement_speed` **0.1125–0.3375**, `max_health` **15–30**; breeding averages parents' stats + random; needs **saddle** to steer, optional horse_armor slot — **[P2]**.
- [ ] Donkey/mule (+chest = 15-slot storage); llama (caravans, spit attack, decor + strength 3–15 slots, no direct steering) — **[P2]**.
- [ ] Pig & strider ridden with saddle + steered by `carrot_on_a_stick` / `warped_fungus_on_a_stick` (right-click = speed boost, consumes durability) — **[P2]**.
- [ ] boat (2 passengers), camel (2 riders + dash), skeleton_horse (trap spawns on thunderstorm strike) — **[P2]**.

### 8.13 Painting
- [ ] `painting` entity: placed on a wall face; auto-selects the **largest art variant that fits** the free space (1.21 lets you cycle variants by size on place); occupies an N×M block grid; drops as item on break or when its support is removed — **[P2]**.

### 8.14 Item frame & armor stand
- [ ] `item_frame`: holds one ItemStack; **8 rotation** states (right-click rotates 45°); comparator output = `rotation·1` (0–7); holds maps (locked display); invisible-frame option; `glow_item_frame` variant — **[P2]**.
- [ ] `armor_stand`: no-AI entity; NBT pose rotations per part (head/body/left+right arm/legs); toggles arms / base-plate / small / no-gravity / invisible / marker; equips armor + held items; common redstone/display prop — **[P2]**.

### 8.15 Signature per-mob behaviors
- [ ] Zombie: breaks doors on Hard (`mobGriefing`), reinforcement summons when hurt (regional-difficulty gated), baby chicken-jockey, → Drowned after 30s underwater — **[P2]**.
- [ ] Skeleton → Stray in powder_snow; spider jockey (skeleton rides spider) — **[P2]**.
- [ ] Enderman: carries & places a fixed block list, teleports, takes damage in water/rain, aggro on eye-contact (crosshair on head) ≤64 — **[P2]**.
- [ ] Piglin: zombifies after **15s** in Overworld/End, pacified by worn gold armor, hunts hoglins, admires/barters gold — **[P2]**.
- [ ] Hoglin: flees warped_fungus & nether portals; Strider: shivers/slows on land, fast in lava — **[P2]**.
- [ ] Fox: sleeps in daytime, steals & holds items in mouth; Sheep: eats grass_block to regrow shorn wool (**[P1]**) — **[P2]**.
- [ ] Allay: picks up matching items & delivers to note_block/player; **duplicates** when given an amethyst_shard near a playing jukebox — **[P2]**.
- [ ] Goat: rams for knockback, drops `goat_horn` on ramming into a wall; Frog: eats small slime/magma_cube → drops `froglight` colored by frog variant — **[P2]**.

---

## 8A. Player Movement & Physics

> **Implementation note:** Locomotion lives in **shared physics code** (`shared/physics/`) invoked identically by client prediction and server authority (MULTIPLAYER_PROTOCOL §6.3). Integrate per game tick in order: **input accel → horizontal friction/drag → gravity → collision resolution (swept AABB) → commit position**. Units are blocks & ticks (`b/t` = blocks/tick; ×20 = blocks/s). Player physics is a special case of §8.1a base-entity physics.

### 8A.1 Locomotion constants (implement first)
- [ ] Gravity: subtract **0.08 b/t²** from vy each tick, THEN vertical drag **×0.98** (order matters); terminal velocity ≈ **3.92 b/t** (~78.4 b/s) — **[P0]**.
- [ ] Jump: set vy = **0.42 b/t** (peak ≈ **1.252 blocks**); +Jump Boost `0.1·(L+1)`; **sprint-jump** adds a **+0.2** horizontal forward impulse (the main sprint-travel speedup) — **[P0]**.
- [ ] Horizontal move: `vel = (vel + accel)·slipperiness·0.91`; **ground accel ≈ 0.1**, **air accel ≈ 0.02** (accel magnitude = movementSpeed·factor, direction from WASD) — **[P0]**.
- [ ] `slipperiness` = friction of the block underfoot (default **0.6**, ice **0.98**, packed/blue_ice **0.989**, slime **0.8**); ground accel scaled by `(0.6/slip)³`; airborne uses slip = 1.0 with air accel — **[P0]**.
- [ ] Resulting horizontal speeds (blocks/s): walk **4.317**, sprint **5.612**, sneak **1.295**, creative/spectator fly **10.89** (sprint-fly ≈ 21.78) — **[P0]**.
- [ ] Auto step-up: climb ledges ≤ **0.6 blocks** (`step_height`) without jumping — **[P0]**.
- [ ] FOV widens with horizontal speed (sprint / Speed effect); visual-only, scaled by UX `fovEffects` (§27) — **[P1]**.

### 8A.2 Player hitbox & pose
- [ ] Collision AABB (width×height blocks) + eye height by pose: standing **0.6×1.8** eye **1.62**; sneaking **0.6×1.5** eye **1.27**; swimming/crawling/fall_flying **0.6×0.6** eye **0.4**; sleeping **0.2×0.2**; dying — **[P0]** — hitbox is a centered vertical column.
- [ ] `Pose` enum `{ standing, crouching, swimming, fall_flying, sleeping, spin_attack, long_jumping, dying, sitting }` drives hitbox size, camera/eye height, and animation; **server-authoritative** (client predicts) — **[P0]**.

### 8A.3 Swimming, climbing & special-block movement
- [ ] Swimming: enter swim pose when submerged + moving; sprint-swim ≈ **2.2 m/s**; crawl (swim pose on land) fits through **1-block-high** gaps; buoyancy floats in water, sinks in lava — **[P1]**.
- [ ] Climbing: ladder/vine/scaffolding climb ≈ **2.35 m/s** up; hold sneak to cling (halt) on a ladder; scaffolding descends while holding sneak — **[P1]**.
- [ ] Slime block: bounce — retain (reflected) vertical velocity on landing unless sneaking (sneak cancels the bounce) — **[P1]**.
- [ ] Honey block: horizontal move **×0.4**, reduced jump height, slow slide down walls, prevents fall-through, exiting costs sneak — **[P1]**.
- [ ] Cobweb: move **×0.25** and cancel gravity accumulation (slow descent) — **[P1]**.
- [ ] soul_sand top: move **×0.4** (Soul Speed enchant negates/boosts); powder_snow: sink in unless wearing leather boots (walk on top) — **[P1]**.
- [ ] Bubble columns: soul_sand pushes up, magma pushes down (see §20) — **[P2]**.
- [ ] Sneaking prevents walking off block edges (ledge-stop) — **[P1]**.

---

## 9. Combat

> **Implementation note:** Server-authoritative hit resolution: validate attacker cooldown, reach, and line-of-sight; apply the reduction chain in order; broadcast resulting HP + knockback. Client shows attack-cooldown indicator, crit/sweep particles, damage tilt. 10-tick iframes deduped server-side.

### 9.1 Attack mechanics (1.9+ system)
- [ ] Attack cooldown = `1/attack_speed`; charge `t` 0→1; damage `×(0.2 + t²·0.8)` — **[P1]**.
- [ ] Full-charge threshold (`t>0.9`) enables crit/sweep — **[P1]**.
- [ ] Critical hit ×1.5: full charge + falling + not on-ground/ladder/water + not sprinting + no Blindness/Levitation — **[P1]**.
- [ ] Sweep (sword): full charge + on ground + not sprinting → AoE 1 HP + Sweeping Edge to secondaries — **[P2]**.
- [ ] Knockback: base impulse; sprint-attack bonus; Knockback ench +~0.5/L; reduced by `knockback_resistance` — **[P1]**.
- [ ] Reach (1.20.5+ attributes): `block_interaction_range` base **4.5** (creative +0.5 = **5.0**); `entity_interaction_range` base **3.0** (creative +2.0 = **5.0**). Creative reach is **5.0 for both** (not 6.0) — **[P0]** — single source of truth for §22.
- [ ] Axe disables shield; Thorns 15%·L reflects 1–4 HP — **[P2]**.

### 9.2 Damage reduction chain
- [ ] Order: armor+toughness → Resistance → EPF → Absorption soaks remainder — **[P1]**.
- [ ] Armor `damage·(1 − clamp(max(armor/5, armor−dmg/(2+tough/4)),0,20)/25)` (cap 80%) — **[P1]**.
- [ ] EPF per level: Protection 1, Fire/Blast/Projectile Prot 2, Feather Falling 3; `reduction = min(EPF,20)·0.04` — **[P1]**.
- [ ] Resistance −20%/level (multiplicative); Netherite KB resist 0.1/pc — **[P1]**.
- [ ] 10-tick iframes: new hit only applies `(new−last)` if greater; some types bypass — **[P1]**.

### 9.3 Damage types
- [ ] Type flags (armor-reducible?): melee/arrow yes+KB, fall no (Feather Falling), fire_tick no (1HP/0.5s), lava yes (4HP/0.5s), drown no (2HP/s), suffocation no, cactus/berry yes+bypass-iframes, magic no, wither no, poison no (floor 1), explosion yes+KB, freeze no (leather immune), sonic_boom no (bypass armor+shield), void/kill no — **[P1]**.
- [ ] Fall damage `max(0, floor(fallDistance)−3)`; −1/level Jump Boost. **Fully negated** by: water, cobweb, slime_block (unless sneaking), sweet_berry_bush, powder_snow, Slow Falling. **Reduced, not negated**: hay_bale **×0.2** (80% off), honey_block (~20% taken). Bed **bounces** (retain 2/3 fall velocity) with small residual damage — **[P1]**.
- [ ] Freezing: accrue to 140gt then 1HP/40gt; any leather piece immune — **[P2]**.
- [ ] Air supply 300gt (15s); Respiration +15s/L; then 2HP/s drown; turtle shell +10s — **[P1]**.
- [ ] Explosion: falloff by distance & exposure; block destruction by blast resistance; TNT power 4, creeper 3/6, wither_skull 1, end_crystal/bed-in-nether 5–6 — **[P2]**.
- [ ] Explosion algorithm (ray-cast model): fire **16×16×16 rays** from center toward the cube's surface; each ray steps **0.3 blocks**, intensity starts `power·(0.7 + rand·0.6)` and loses `(blastResistance + 0.3)·0.3` per block; a block is removed if ray intensity stays > 0 through it, then dropped with probability **1/power** (`blockExplosionDropDecay`) — **[P2]** ⚠verify constants.
- [ ] Explosion entity damage `= (1 − dist/(2R))·exposureFraction·(7R + 1)` where R = explosion power (blocks) and `exposureFraction` = fraction of rays from the entity AABB unobstructed to center; knockback along the blast vector scaled by the same falloff; charged_creeper / ghast / end_crystal set fire — **[P2]** ⚠verify coefficient.
- [ ] Totem of Undying: lethal hit → HP 1, Regen II 40s, Fire Res 40s, Absorption II 5s; consumed from hand/offhand — **[P2]**.

---

## 10. Health & Hunger

> **Implementation note:** Server owns health/hunger/saturation/exhaustion; ticks each game tick. Client renders hearts/drumsticks/absorption/air with the correct animated states. Never trust client HP.

- [ ] Player max health 20 HP (`max_health` base 20, range 0–1024); Health Boost +4/L; Absorption extra HP (no regen) — **[P1]**.
- [ ] Natural regen (difficulty≥Easy): food==20 & sat>0 → +1HP/10gt (cost 6.0 exhaustion); food≥18 → +1HP/80gt; Peaceful → +1HP/10gt regardless — **[P1]**.
- [ ] Starvation (food==0): 1HP/80gt; floor Easy 10 / Normal 1 / Hard 0(death) — **[P1]**.
- [ ] Hunger meter 0–20; saturation hidden 0–20 (capped at food); exhaustion 0–4.0 → at 4.0 subtract 1 sat (or food) — **[P1]**.
- [ ] Exhaustion costs: sprint 0.1/m, swim 0.01/m, jump 0.05, sprint-jump 0.2, attack 0.1, take damage 0.1, break block 0.005, regen 6.0, hunger effect +0.005·L/tick — **[P1]**.
- [ ] Eating: 32gt hold (dried_kelp ~17gt); only food<20 (golden apple/stew/milk/honey always) — **[P1]**.
- [ ] Sprinting requires food>6; disabled by Blindness — **[P1]**.
- [ ] Food table `(hunger, saturation)` — full data table: golden_carrot 6/14.4, cooked_beef/pork 8/12.8, rabbit_stew 10/12.0, cooked_mutton/salmon 6/9.6, cooked_chicken 6/7.2, bread 5/6.0, baked_potato 5/6.0, pumpkin_pie 8/4.8, carrot 3/3.6, apple 4/2.4, melon_slice 2/1.2, sweet_berries 2/0.4, cookie 2/0.4, beetroot 1/1.2, dried_kelp 1/0.6, stews 6/7.2, cake 7 slices ×2, honey_bottle 6/1.2 (clears poison), raw meats, rotten_flesh 4/0.8 (80% hunger), spider_eye 2/3.2 (poison), pufferfish 1/0.2 (poison II/hunger III/nausea), chorus_fruit 4/2.4 (teleport), poisonous_potato 2/1.2 — **[P1]**.
- [ ] Golden Apple 4/9.6 → Absorption I 2:00 + Regen II 5s; Enchanted Golden Apple → Absorption IV 2:00, Regen II 20s, Fire Res + Resistance 5:00 — **[P2]**.
- [ ] Milk Bucket clears all effects (bucket returned) — **[P1]**.
- [ ] **World spawn** chosen by spiral search from (0,0) for a valid non-ocean surface column (solid top + air above) at/near sea level; `spawnRadius` (default 10) scatters actual spawn — **[P1]**.
- [ ] **Respawn point:** personal spawn set by sleeping in a bed (§18) or a charged `respawn_anchor` (Nether; **4 glowstone charges**, consumes 1 per respawn, explodes if used in Overworld/End); obstructed/missing bed or uncharged/exploded anchor → default world spawn + message "You have no home bed or charged respawn anchor, or it was obstructed" — **[P1]**.
- [ ] **Respawn flow:** death → respawn screen (`Respawn` / `Title`); XP/inventory drop unless `keepInventory`; `doImmediateRespawn` gamerule skips the screen — **[P1]**.

---

## 11. Status Effects

> **Implementation note:** `EffectInstance = { id, amplifier:0-255, durationTicks, ambient, showParticles, showIcon }`. Server applies effect logic each tick and modifies attributes/damage; client renders HUD icons + timers + particle color. Instant effects ignore duration. Amplifier 0 = level I.

- [ ] Speed +20%/L, Slowness −15%/L (L6+ immobile), Haste +mining/attack ~+10%/L, Mining Fatigue ×0.3^L — **[P1]**.
- [ ] Strength +3HP melee/L, Weakness −4HP/L — **[P1]**.
- [ ] Instant Health heal `4·2^(L-1)` (harms undead), Instant Damage `6·2^(L-1)` (heals undead) — **[P2]**.
- [ ] Regeneration +1HP/`50>>(L-1)`gt, Poison −1HP/`25>>(L-1)`gt (floor 1), Wither −1HP/`40>>(L-1)`gt (can kill) — **[P2]**.
- [ ] Jump Boost +~0.5/L, Nausea (screen warp), Resistance −20%/L, Fire Resistance, Water Breathing, Invisibility, Blindness, Night Vision (brightness 15) — **[P2]**.
- [ ] Health Boost +4 max/L, Absorption +4/L, Saturation +1 food&sat/L/tick, Hunger +exhaustion, Glowing, Levitation (rise 0.9·L/s) — **[P2]**.
- [ ] Slow Falling, Luck/Bad Luck (loot quality), Conduit Power, Dolphin's Grace, Darkness — **[P2]**.
- [ ] Bad Omen (I–V), Hero of the Village (discounts), + 1.21 Trial Omen, Raid Omen, Wind Charged, Weaving, Oozing, Infested — **[P3]**.

---

## 12. Redstone

> **Implementation note:** Redstone runs **server-side** on the scheduled-tick queue. Model per-block `{ ss:0-15, strongPowered, weakPowered }`. Propagation is BFS with strong/weak power distinction and conductivity rules. Ship update-order + quasi-connectivity as opt-in parity flags. Pistons/blocks-in-motion are moving-block entities animated client-side over ~3gt.

### 12.1 Signal model
- [ ] Dust carries SS, −1/block (max reach 15), auto-forms cross/line/corner/T; strongly powers block beneath, weakly powers pointed-into blocks — **[P2]**.
- [ ] Strong vs weak power; opaque full blocks conduct, transparent don't; components accept input from specific sides only — **[P2]**.
- [ ] Power sources: redstone_block 15, torch 15 (inverts), lever 15, stone_button 15/10gt, wood_button 15/15gt, pressure_plate 15, weighted plates (gold 1/item, iron 1/10 items), tripwire 15, daylight_detector f(sky), target 0–15 (proximity), trapped_chest (player count), observer 15/2gt, sculk_sensor 1–15 (range 8, 40gt+1gt), calibrated_sculk_sensor (filtered), lightning_rod 15/8gt — **[P2]**.
- [ ] Redstone torch burnout: ≥8 flips in 60gt → off until update — **[P3]**.

### 12.2 Logic components
- [ ] Repeater: 1-directional, out 15, delay 1–4rt (2/4/6/8gt), lock via side input — **[P2]**.
- [ ] Comparator: delay 1rt; compare mode `out=rear if rear≥max(side) else 0`; subtract `max(0, rear−max(side))`; container read `floor(1 + (Σ(count/maxStack)/slots)·14)` — **[P2]**.
- [ ] Comparator special readouts: cauldron/composter/lectern/jukebox/item_frame/beehive/end_portal_frame/respawn_anchor/brewing_stand/farmland/chiseled_bookshelf/sculk_shrieker — **[P3]**.
- [ ] Observer: detects faced block-state change, 15/2gt pulse from back; push reaction NORMAL — **[P2]**.

### 12.3 Actuators
- [ ] Redstone lamp (4gt off-delay), note_block (25 pitches, instrument = block beneath), doors/trapdoors/gates, bell, dispenser (9 slots, item-specific behavior + QC), dropper (9 slots), TNT (fuse 80gt, power 4.0), crafter (rising-edge auto-craft), copper_bulb (toggle on rising edge), big_dripleaf (tilt) — **[P2]**.
- [ ] **Dispenser item-specific behavior table** (~25 entries): shoots arrow / snowball / egg / splash_potion / firework_rocket / fire_charge (as small_fireball); places or scoops fluid with a bucket (water/lava/powder_snow/fish); shears sheep; equips armor/elytra/carved_pumpkin/skull onto an adjacent entity; bonemeals crops (dye→bonemeal); ignites TNT & lights via flint_and_steel; places boat/minecart on a rail; fills glass_bottle from water; dyes sheep; feeds/breeds mobs; **else ejects** the item as an ItemEntity. **Dropper** never actuates — it only ejects. QC (quasi-connectivity) applies to both — **[P2]**.
- [ ] Quasi-connectivity (piston/dispenser activate from block diagonally above), block-update ordering, 0-tick pulses — **[P3]** — parity flags.

### 12.4 Pistons
- [ ] Piston + sticky_piston, head separate state, ~3gt animation, push limit **12 blocks** — **[P2]**.
- [ ] Push reactions: NORMAL (moves), DESTROY (breaks — torch/dust/plants/rail), BLOCK (immovable — obsidian/bedrock/reinforced_deepslate/end_portal_frame + block entities), PUSH_ONLY, IGNORE — **[P2]**.
- [ ] Slime block sticks to all adjacent movable except honey; honey sticks to all except slime; combined 12-limit — **[P3]**.

### 12.5 Hoppers, rails, minecarts
- [ ] Hopper: 5 slots, 1 item/8gt pull+push (independent cooldown), vacuums items above, locked when powered, comparator fullness — **[P2]**.
- [ ] Rails: rail (curves/slopes), powered (accelerate/brake), detector (SS15 + comparator fullness), activator — **[P2]**.
- [ ] Minecarts: empty, chest (27), hopper (pickup), furnace (pusher, coal fuel), TNT (explodes on activator), command_block, spawner; max 8 m/s flat — **[P2]**.

---

## 13. Enchanting

> **Implementation note:** Enchant selection is a **seeded RNG** process (persist `XpSeed` per player). Implement the level-roll, mod-roll, and weighted-pick exactly. Enchantments are data records with cost windows. Anvil combine cost + prior-work-penalty logic is server-authoritative.

- [ ] Table: item + 1–3 lapis + XP; bookshelves boost (1-block air gap, 5×5×2 ring, **15 shelves = L30**); 3 offers each showing required level + hint + glyphs — **[P2]**.
- [ ] Cost per slot: consumes `slot` XP levels + `slot` lapis (1/2/3) — **[P2]**.
- [ ] Level roll: `base = rand(1..8)+floor(b/2)+rand(0..b)`; slot1 `max(floor(base/3),1)`, slot2 `floor(base·2/3)+1`, slot3 `max(base, b·2)` — **[P2]**.
- [ ] Enchant selection: `mod = L + 2·rand(0..floor(E/4))`, `mod·=(1+(randf+randf−1)·0.15)`; filter by cost window+applicable+non-conflicting; weighted-random by rarity (Common10/Uncommon5/Rare2/VeryRare1); extra-enchant loop halving mod — **[P2]**.
- [ ] Enchantability values (wood15/stone5/iron14/diamond10/gold22/netherite15; armor leather15/iron9/chain12/gold25/diamond10; book/bow/rod/trident/crossbow/mace 1) — **[P2]**.
- [ ] `Enchant = { id, maxLevel, weight, applies[], treasure, curse, tradeable, discoverable, minCost(l), maxCost(l), conflicts[] }` — **[P2]** — full table (Protection/Fire/Blast/Projectile/Feather Falling, Respiration, Aqua Affinity, Thorns, Depth Strider, Frost Walker, Soul Speed, Swift Sneak, Sharpness/Smite/Bane, Knockback, Fire Aspect, Looting, Sweeping Edge, Efficiency, Silk Touch, Unbreaking, Fortune, Power/Punch/Flame/Infinity, Luck of Sea/Lure, Loyalty/Impaling/Riptide/Channeling, Multishot/Quick Charge/Piercing, Mending, Curse of Binding/Vanishing, Density/Breach/Wind Burst).
- [ ] Treasure-only (loot/trade/fishing, not table): Mending, Frost Walker, Soul Speed, Swift Sneak, curses, Wind Burst — **[P2]**.

---

## 14. Brewing

> **Implementation note:** Brewing is **hardcoded** (not datapack in vanilla) — implement as an ingredient→result state machine on the brewing_stand block entity. Brews all 3 bottles simultaneously; server-authoritative.

- [ ] Brewing stand: 3 bottle + ingredient + fuel; blaze_powder = 20 ops; brew 400gt (20s) — **[P2]**.
- [ ] Base chain: water_bottle + nether_wart → **Awkward** (base for effect potions); glowstone→Thick, redstone→Mundane — **[P2]**.
- [ ] Awkward + ingredient → potion: sugar→Swiftness, rabbit_foot→Leaping, blaze_powder→Strength, glistering_melon→Healing, ghast_tear→Regen, magma_cream→Fire Res, pufferfish→Water Breathing, golden_carrot→Night Vision, spider_eye→Poison, phantom_membrane→Slow Falling, turtle_shell→Turtle Master — **[P2]**.
- [ ] Modifiers: redstone→extend duration, glowstone→amplify II (shorter), fermented_spider_eye→corrupt (NightVision→Invis, Healing→Harming, Swiftness→Slowness), gunpowder→Splash, dragon_breath→Lingering — **[P2]**.
- [ ] Durations base/+redstone/+glowstone (Speed 3:00/8:00/1:30·II, Regen 0:45/1:30/0:22·II); instant effects no duration — **[P2]**.
- [ ] Lingering + 8 arrows → tipped arrows (1/8 duration); splash ~0.75× duration; lingering cloud 30s applies ~¼ per exposure — **[P2]**.
- [ ] 1.21 potions: Wind Charged (breeze_rod), Weaving (cobweb), Oozing (slime), Infested — **[P3]**.

---

## 15. Progression / XP

> **Implementation note:** XP is server-authoritative. Persist `XpLevel, XpP, XpTotal, XpSeed`. XP orbs are entities merged/attracted within ~6–8 blocks. Advancements are data-driven JSON with a trigger event bus.

- [ ] XP-to-next-level: `L∈[0,15]:2L+7`, `[16,30]:5L−38`, `≥31:9L−158` — **[P1]**.
- [ ] Total XP: `[0,16]:L²+6L`, `[17,31]:2.5L²−40.5L+360`, `≥32:4.5L²−162.5L+2220` — **[P1]**.
- [ ] XP sources: ore mining (coal 0–2, diamond/emerald 3–7, lapis 2–5, quartz 2–5, redstone 1–5; iron/gold/copper 0→on smelt), smelting (fractional accumulated), mob kills, breeding 1–7, fishing 1–6, trading 3–6, bottle o' enchanting 3–11, grindstone disenchant partial — **[P1]**.
- [ ] XP sinks: enchanting, anvil, Mending (2 durability/XP before bar) — **[P1]**.
- [ ] Death: drops `min(7·L, 100)` XP; resets to 0 unless `keepInventory` — **[P1]**.
- [ ] Anvil: unit repair 25%×4, combine +12% bonus, enchant merge rules, rename +1L, PWP `2n+1` (`cost=2^workCount−1`), cap 40 ("Too Expensive"), 12% degrade/use (3 stages) — **[P2]**.
- [ ] Grindstone: disenchant (partial XP), combine +5%, resets PWP, keeps curses — **[P2]**.
- [ ] Advancements: `{ parent?, display{icon,title,description,frame(task|goal|challenge),show_toast,announce_to_chat,hidden,background}, criteria{name:{trigger,conditions}}, requirements[][], rewards{experience,loot,recipes,function} }` — **[P3]**.
- [ ] 5 tabs (~120 total): Story, Nether, End, Adventure, Husbandry; ~40 trigger types (inventory_changed, location, player_killed_entity, bred_animals, changed_dimension, nether_travel, used_ender_eye, villager_trade, cured_zombie_villager, slept_in_bed, placed_block, tick, …) — **[P3]**.

---

## 16. Structures

> **Implementation note:** Placement = **spacing/separation grid + salt** per region (deterministic offset, min gap), evaluated server-side during the structure_starts stage. Jigsaw structures assemble from **template pools** (start pool → recursive depth-limited expansion). Store schematic pieces as compact JSON block arrays; loot tables as data. Strongholds use a special ring algorithm.

- [ ] `StructureDef = { id, biomeTags[], spacing, separation, salt, placement, terrainAdaptation, lootTables[], forcedSpawns[] }` — **[P2]** — shared TS type.
- [ ] Spacing/separation grid + jigsaw template-pool assembler — **[P2]**.
- [ ] Village (34/8, 5 biome types), pillager_outpost (32/8, avoids villages) — **[P2]**.
- [ ] Desert pyramid (32/8, TNT trap + 4 chests), jungle_temple (tripwire/lever puzzle), swamp_hut (witch+cat), igloo (32/8, ~50% basement) — **[P2]**.
- [ ] Mineshaft (per-chunk ~0.004, rails+chest minecart+cave_spider spawner; badlands variant) — **[P2]**.
- [ ] Shipwreck (24/4, 3 chests + treasure map), buried_treasure (per-chunk, Heart of the Sea), ocean_ruins (20/8 warm/cold), ruined_portal (40/15, 7 variants) — **[P2]**.
- [ ] Stronghold: **128 total** in rings (counts 3/6/10/15/21/28/36/9), radii from ~1280; portal room (12 frames, silverfish spawner, lava), library, located by eyes of ender — **[P2]**.
- [ ] Ocean monument (32/5, guardians+3 elder, Mining Fatigue III, 8 gold blocks, sponge rooms) — **[P3]**.
- [ ] Woodland mansion (80/20, evokers/vindicators/allays, totem, explorer map) — **[P3]**.
- [ ] Nether fortress (27/4, blaze spawners, wither skeletons, nether wart), bastion_remnant (27/4, 4 subtypes, piglins/brutes/hoglins, netherite template) — **[P2]**.
- [ ] Nether fossil (2/1 soul_sand_valley), desert well, dungeon (cobble room + spawner + chests), amethyst geode, fossils — **[P3]**.
- [ ] End city + end ship (20/11, shulkers, elytra) — **[P3]**.
- [ ] Trial chamber (~34/12, trial spawners, breeze/bogged, vaults + trial keys, heavy core), ancient_city (24/8, sculk+warden, reinforced deepslate, swift sneak book) — **[P3]**.
- [ ] Trail ruins (34/8, taiga/meadow, sniffer archaeology) — **[P3]**.

---

## 17. Villages & Trading

> **Implementation note:** Villagers use a **Brain (memory + schedule + sensors)** driving POI claiming (bed/job/meeting via a POI store), plus the gossip/reputation system. Trades are data with dynamic pricing. Raids are a per-village wave state machine with a boss bar. All server-authoritative.

- [ ] Village generation: 5 biome variants (plains/desert/savanna/taiga/snowy), jigsaw from meeting point (well/bell)→houses/farms/job-sites/paths, spawns cats + iron golems — **[P2]**.
- [ ] 15 professions ↔ POI job blocks (armorer→blast_furnace, cleric→brewing_stand, farmer→composter, librarian→lectern, toolsmith→smithing_table, weaponsmith→grindstone, etc.) + nitwit + unemployed — **[P2]**.
- [ ] Villager schedule: wander→work(day, job site)→meet(midday, bell)→sleep(night, bed); panic runs home — **[P2]**.
- [ ] Conversions: villager→zombie_villager on zombie-kill (Easy0%/Normal50%/Hard100%); villager→witch on lightning — **[P2]**.
- [ ] Trading tiers: Novice/Apprentice(10)/Journeyman(70)/Expert(150)/Master(250) XP; offer `{ buy[], sell, uses, maxUses, xp, priceMultiplier, demand, specialPrice }` — **[P2]**.
- [ ] Restock: return to job site, ≤2×/day resets uses; demand raises emerald cost, decays — **[P2]**.
- [ ] Discounts: Hero of the Village ~30%+; cure zombie villager (major_positive gossip, permanent, gossip-shared) — **[P2]**.
- [ ] Gossip/reputation: types (trading +2 cap25, major_positive +20 cap20, minor_negative +25, major_negative on kill cap100), shared+decays; iron golems hostile at very low rep — **[P2]**.
- [ ] Breeding: willingness (bread≥3 or carrot/potato/beetroot≥12) + unclaimed bed; baby→adult 24000gt; pop cap = beds — **[P2]**.
- [ ] Iron golem natural spawn: ≥3 villagers + gossip/panic threshold near meeting point; player-built 4 iron blocks(T)+pumpkin — **[P2]**.
- [ ] Wandering trader: timed spawn, 2 trader llamas, despawns ~48000gt — **[P2]**.
- [ ] Raids: Bad Omen (pre-1.20.5) / Ominous Bottle→Raid Omen (1.21) on village entry; captains carry ominous banner; waves Easy3/Normal5/Hard7 +bonus; roster pillager/vindicator/evoker/witch/ravager+vex; bell highlights raiders; victory→Hero of the Village 48000gt — **[P3]**.

---

## 18. Weather & Environment

> **Implementation note:** Weather is a per-dimension server state machine (`WeatherState`) broadcast to clients for rain/snow particles, sky darkening, and fog. Time is two counters: `gameTime` (never resets, drives ticks) and `dayTime` (settable, drives sun). Lightning strikes are server-chosen and replicated.

- [ ] Day = 24000gt; anchors 0 sunrise, 6000 noon, 12000 sunset, 13000 night(hostiles), 18000 midnight, 23000 sunrise-begin — **[P1]**.
- [ ] `gameTime` vs `dayTime` split; `doDaylightCycle` freezes dayTime only — **[P1]**.
- [ ] Sky brightness→spawn light: skyDarken 0(day)→11(night); night sky light ≈4; hostile check uses block light only (1.18+) — **[P1]**.
- [ ] Moon: 8 phases `(dayTime/24000)%8`; full moon → more slimes/armored mobs — **[P2]**.
- [ ] Insomnia: `timeSinceRest≥72000gt` + open sky + night/thunder → phantoms 1–4 (~1/min) — **[P2]**.
- [ ] Weather state machine: clear 12000–180000gt, rain 12000–24000, thunder 3600–15600; `doWeatherCycle`; `/weather` — **[P1]**.
- [ ] Rain: no precip in desert/savanna/badlands/nether/end; extinguishes fire, fills cauldrons, hydrates farmland to 7, Endermen/Blazes take damage — **[P1]**.
- [ ] Thunderstorm: sky light −10 → daytime hostile spawns; lightning (fire+5 dmg AoE), transforms pig→zombified_piglin/villager→witch/creeper→charged/mooshroom red→brown; skeleton horse trap (0.75–1.5%); lightning_rod diverts (~128 blocks, 15 pulse) — **[P2]**.
- [ ] Snow/freeze: snowfall in cold biomes (height-adjusted temp <0.15), snow layers 1–8 accumulate (sky access + block light<10), ice forms on still water, cauldrons fill powder_snow, powder snow freeze (140gt→1dmg/2s, leather immune) — **[P2]**.
- [ ] Height-adjusted temp: `if y>80: temp_eff = temp − (noise(x/8,z/8)·8 + (y−80))·0.00125` — **[P2]**.
- [ ] **Sleeping & beds:** right-click a bed sets **personal spawn** (near the bed); sleep only accepted within the night window **12541–23458gt** or during a thunderstorm; sets `occupied` blockstate — **[P1]**.
- [ ] Sleep blocked if monsters are within **8 blocks** ("You may not rest now; there are monsters nearby") — **[P1]**.
- [ ] On success: `dayTime` → 0 (morning; wake ~12010 or skip to next dawn), clears rain/thunder, resets phantom insomnia (`timeSinceRest`) — **[P1]**.
- [ ] Multiplayer: night skips only when `playersSleepingPercentage` (default 100) of players are asleep — **[P2]**.
- [ ] Bed explodes (**power 5** + fire) if used where `bed_works=false` (Nether/End) — **[P2]** — see §3.2.

---

## 19. Lighting

> **Implementation note:** Two independent 0–15 channels per block (**sky** + **block**), stored as nibble arrays per section. Compute via **queue-based BFS** — incremental increase (add light) and decrease (removal + re-propagation) on block change. Skylight recomputed on heightmap change; propagate across chunk boundaries. Client renders `max(blockLight, skyLight·timeFactor)` with smooth-lighting AO in the mesher.

- [ ] Two channels sky+block 0–15; rendered brightness `max(block, sky·timeFactor)` + gamma curve — **[P0]**.
- [ ] Flood-fill 6-neighbor (no diagonal); step `light − max(1, opacity(target))` — **[P0]**.
- [ ] Opacity: air/glass 0, opaque 15, water/ice 1 (extra attenuation); slabs/stairs position-dependent — **[P1]**.
- [ ] Skylight 15 straight down through transparent columns (no attenuation to first opaque); horizontal attenuates normally — **[P0]**.
- [ ] Block-light emitter table (15 lava/glowstone/sea_lantern/froglight/lantern/beacon/conduit/campfire; 14 torch; 13 nether_portal/lit_furnace; 10 crying_obsidian/soul_torch/soul_fire; 7 redstone_torch/redstone_ore/enchanting_table/ender_chest; sea_pickle 6/9/12/15; candle 3/6/9/12; amethyst cluster 5) — **[P1]**.
- [ ] Incremental light updates on place/break/state-change; skylight on heightmap change; smooth-lighting AO — **[P0]**.

---

## 20. Fluids

> **Implementation note:** Fluids on the scheduled-tick queue (`FluidState = { type, level:0-8, falling }`). Water/lava spread + source formation + lava↔water block generation are server-authoritative. Waterlogging is a per-block bool. Client renders animated flowing quads with height ∝ level and applies buoyancy/current visuals.

- [ ] Water: source (level 0/8) + flowing 1–7; horizontal spread ≤7 (−1/block); flows down infinitely; re-sources below; update every 5 ticks; flow biases toward nearest downward hole (≤5) — **[P0]**.
- [ ] Infinite source: flowing cell with ≥2 orthogonal source neighbors → source — **[P0]**.
- [ ] Waterlogging: stairs/slabs/fences/signs/etc. carry `waterlogged` bool — **[P1]**.
- [ ] Buoyancy/current: flowing water pushes entities along flow vector; bubble columns (soul_sand up / magma down) — **[P2]**.
- [ ] Lava: overworld spread ≤3 (update 30gt), nether ≤7 (update 10gt); contact 4 HP + ignite — **[P1]**.
- [ ] Lava↔water: lava_source+water→obsidian; flowing_lava+water→cobblestone; flowing_lava down onto water→stone; lava+soul_soil+blue_ice→basalt — **[P1]**.
- [ ] Fire: `age` 0–15, spreads to flammable (±1y, up to +4 above) by encouragement+flammability; burns out; `doFireTick`; eternal on netherrack/magma; soul_fire ~2× dmg; entity fireTicks 1HP/s — **[P1]**.
- [ ] **Sponge:** a dry `sponge` on placement (or when water touches it) absorbs water in a **7-block taxicab radius** (up to **65** source+flowing blocks removed) and becomes `wet_sponge`; `wet_sponge` drips, and dries back to `sponge` in a furnace or instantly when placed in the Nether — **[P2]** — ocean-monument reward mechanic.

---

## 21. Farming & Breeding

> **Implementation note:** Growth is **random-tick driven** (`randomTickSpeed/4096` per block). Farmland moisture, crop growth points, spread, and breeding cooldowns are server-authoritative. Bee pollination and honey levels tracked on the beehive block entity.

- [ ] Tilled crops (wheat/carrot/potato/beetroot) on farmland, need block light ≥9 — **[P1]**.
- [ ] Farmland hydration moisture 0–7 (→7 if water within 4 blocks h + same/−1 y, or rain; else decrements→dirt); trampling reverts on fall — **[P1]**.
- [ ] Growth points/random-tick: base 1; farmland below +3 hydrated/+1 dry; each of 8 neighbors +0.75/+0.25; N×M same-crop penalty halves; `chance = 1/(floor(25/points)+1)` — **[P1]**.
- [ ] Crop stages: wheat 0–7, carrot/potato 0–7, beetroot 0–3; bonemeal +2–5 stages — **[P1]**.
- [ ] Stem plants: melon/pumpkin stem age 0–7 → fruit on adjacent air over valid soil, stem bends — **[P1]**.
- [ ] age 0–15 growers: sugar_cane (max 3, water-adjacent), cactus (max 3, on sand, damages), bamboo (12–16), chorus (End branching) — **[P1]**.
- [ ] Cocoa (0–2 on jungle log), nether_wart (0–3 soul sand, no light/bonemeal), sweet_berry_bush (0–3, dmg on walk), kelp (≤26), glow_berries/cave_vines (glow 14) — **[P2]**.
- [ ] Trees: sapling stage 0→1→tree (space+light, bonemeal); types oak/spruce/birch/jungle/acacia/dark_oak(2×2)/mangrove/cherry; leaves distance 1–7, decay if >6 & !persistent — **[P1]**.
- [ ] Grass/mycelium spread (source + light≥4 → adjacent dirt); grass→dirt if covered/dark; mushroom spread (light≤12, <5 in 9×3×9); bonemeal→giant mushroom — **[P1]**.
- [ ] Composter: 7 levels, per-item % chance (seeds ~30%, crops ~65%, pie 100%), level 7→8 = bonemeal — **[P2]**.
- [ ] Bee pollination: visit flower → pollen → hive raises honey_level 0–5; harvest (bottle/comb) at 5, anger without campfire — **[P2]**.
- [ ] Animal breeding: feed 2 adults → baby + hearts, cooldown 6000gt, baby→adult 24000gt (−10%/feed) — **[P1]**.
- [ ] Breeding foods table (cow/sheep→wheat, pig→carrot/potato/beetroot, chicken→seeds, horse→golden apple/carrot, llama→hay, wolf→meat, cat→raw fish, fox→berries, panda→bamboo, bee→flower, turtle→seagrass, frog→slimeball, axolotl→tropical fish bucket, strider→warped fungus, hoglin→crimson fungus, camel→cactus, sniffer→torchflower seeds, armadillo→spider eye) — **[P1]**.
- [ ] Taming: wolf (bones), cat/parrot (fish/seeds), horse/donkey (mounting temper), llama (mounting), strider (saddle+warped fungus stick) — **[P2]**.
- [ ] Production: chicken egg 6000–12000gt (thrown 1/8 chick), cow milk, mooshroom shear→cow, sheep eat grass→regrow wool (16 dyes, breeding mixes), suspicious stew from brown mooshroom+flower — **[P2]**.

### 21.1 Fishing
- [ ] Cast `fishing_rod` → `fishing_bobber` entity; wait **5–30s** (Lure −5s/level) then bite (approaching-bubble trail + splash) → reel to catch — **[P2]**.
- [ ] Three loot tables: **fish 85% / junk 10% / treasure 5%**; treasure (enchanted book/bow, name_tag, saddle, nautilus_shell) requires **open water** — a 5×4×5 box around the bobber clear of blocks/foliage; Luck of the Sea shifts quality (more treasure, less junk) — **[P2]**.
- [ ] Can hook & pull entities/players toward you; rod durability **−1** per catch, **−5** when hooking an entity — **[P2]**.

### 21.2 Archaeology
- [ ] Hold right-click **~4s** with a `brush` on suspicious_sand / suspicious_gravel (per-state brushing progress 0→3) to extract one loot item (pottery_sherd / archaeology artifact / other), then the block reverts to sand/gravel — **[P3]**.
- [ ] Suspicious blocks generate in trail_ruins, desert pyramids/wells, and warm/cold ocean_ruins (§16); 4 pottery_sherds craft a `decorated_pot` — **[P3]**.

---

## 22. Game Modes

> **Implementation note:** `GameMode` enum stored in player NBT; server enforces capabilities (reach, instabuild, invuln, flight, can_break/can_place_on). Spectator noclip/camera-attach is a client mode with server position sync. Hardcore is a `level.dat` flag, not a mode.

- [ ] `SURVIVAL=0`: all damage, hunger, tool-gated breaking, drops+XP, hostile-targeted, no flight; reach 4.5 block/3.0 entity — **[P0]**.
- [ ] `CREATIVE=1`: invuln (except void/kill), instant break (except unbreakable), double-tap flight (0.05), no hunger, infinite blocks, creative inventory+search+tabs+toolbar save/load, MMB pick block, reach **5.0 block / 5.0 entity** (creative bonus over survival's 4.5/3.0; see §9.1) — **[P0]**.
- [ ] `ADVENTURE=2`: no break unless `can_break`, no place unless `can_place_on`; can use functional blocks/attack/trade/eat — **[P2]**.
- [ ] `SPECTATOR=3`: noclip/fly, no collision, invisible (translucent head to spectators), no interact, camera-attach to entity, menu-teleport — **[P3]**.
- [ ] Hardcore: `level.dat` flag, locks Hard difficulty, hardcore heart skin, death→spectator/delete — **[P2]**.
- [ ] `/gamemode`, `defaultgamemode` setting, `force-gamemode`, player NBT `playerGameType`/`previousPlayerGameType` — **[P1]**.

---

## 23. Difficulty

> **Implementation note:** `Difficulty` enum + `DifficultyLocked` in `level.dat`. Regional/local difficulty computed server-side each tick from world age + chunk InhabitedTime + moon phase; feeds mob gear/enchant/reinforcement/conversion rolls.

- [ ] `PEACEFUL=0/EASY=1/NORMAL=2/HARD=3`; `/difficulty`, server `difficulty`, `DifficultyLocked` — **[P1]**.
- [ ] Peaceful: no hostile spawns, continuous regen, no starvation, poison/wither can't damage — **[P1]**.
- [ ] Easy/Normal/Hard: starvation floor 10/1/0; zombie reinforcements rare/chance/common; Hard zombies break doors + potion spiders — **[P1]**.
- [ ] Regional difficulty 0–6.75 (difficulty + world time + InhabitedTime cap ~50h + moon); clamped local `(regional−2)/2` 0–1 → armor/weapon/enchant/baby(~5%)/reinforcement chances — **[P2]**.

---

## 24. Commands

> **Implementation note:** Build a **Brigadier-style typed command tree** (argument parsers, tab-complete, `~`/`^` coords, block/item predicates, NBT paths). Permission levels 0–4. `/execute` is the composable core — implement its subcommand chain and target-selector engine early; many systems (loot, data, scoreboard) hang off it.

- [ ] Permission levels 0–4 (`op-permission-level`=4, `function-permission-level`=2); `/op`/`/deop`→ops.json — **[P2]**.
- [ ] Core P1 command subset: `/gamemode, /tp/teleport, /give, /time, /weather, /kill, /setblock, /fill, /say, /help, /seed, /difficulty, /gamerule, /spawnpoint` — **[P1]**.
- [ ] Full set: advancement, attribute, ban/pardon, bossbar, clear, clone, damage, data, datapack, debug, effect, enchant, execute, experience/xp, fillbiome, forceload, function, item, kick, list, locate, loot, me, msg/tell/w, particle, place, playsound/stopsound, publish, random, recipe, reload, return, ride, rotate, save-*, scoreboard, setidletimeout, setworldspawn, spectate, spreadplayers, stop, summon, tag, team, tellraw, tick, title, transfer, trigger, whitelist, worldborder — **[P2]**.
- [ ] `/execute` subcommands: align, anchored, as, at, facing, in, on, positioned, rotated, store (result|success), if|unless (block/blocks/data/entity/predicate/score/biome/dimension/loaded), run — **[P2]**.
- [ ] Target selectors `@p @a @r @s @e @n` + args (distance, scores, tag, team, name, type, nbt, level, gamemode, limit, sort) + ranges `a..b` — **[P2]**.
- [ ] Command blocks (impulse/chain/repeat, conditional, SuccessCount, `maxCommandChainLength`=65536), command-block minecart — **[P3]**.
- [ ] Datapack/function commands + macros `$(var)`, `/schedule`, `/return`, `/loot` — **[P3]**.

---

## 25. World Settings / Gamerules

> **Implementation note:** Typed `Gamerules` record persisted in `level.dat`; each read at the relevant tick. `randomTickSpeed`, `doMobSpawning`, `keepInventory`, `mobGriefing`, `doDaylightCycle` gate core loops — wire these first.

- [ ] `Gamerules` typed record `{ rule, type:'bool'|'int', value }` + `/gamerule` — **[P1]**.
- [ ] Boolean gamerules (default): doDaylightCycle(t), doWeatherCycle(t), doFireTick(t), mobGriefing(t), doMobSpawning(t), doMobLoot(t), doTileDrops(t), doEntityDrops(t), keepInventory(f), naturalRegeneration(t), doInsomnia(t), doImmediateRespawn(f), fallDamage(t), fireDamage(t), drowningDamage(t), freezeDamage(t), showDeathMessages(t), announceAdvancements(t), commandBlockOutput(t), sendCommandFeedback(t), doPatrolSpawning(t), doTraderSpawning(t), disableRaids(f), doWardenSpawning(t), doVinesSpread(t), doLimitedCrafting(f), reducedDebugInfo(f), spectatorsGenerateChunks(t), universalAnger(f), forgiveDeadPlayers(t), waterSourceConversion(t), lavaSourceConversion(f), enderPearlsVanishOnDeath(t), projectilesCanBreakBlocks(t), globalSoundEvents(t), blockExplosionDropDecay(t), mobExplosionDropDecay(t), tntExplosionDropDecay(f), disableElytraMovementCheck(f), logAdminCommands(t) — **[P1]** bools core / **[P2]** rest.
- [ ] Integer gamerules (default): randomTickSpeed(3), maxEntityCramming(24), spawnRadius(10), spawnChunkRadius(2), playersSleepingPercentage(100), snowAccumulationHeight(1), minecartMaxSpeed(8), maxCommandChainLength(65536), maxCommandForkCount(65536), commandModificationBlockLimit(32768), playersNetherPortalDefaultDelay(80), playersNetherPortalCreativeDelay(0) — **[P1]**.

---

## 26. Inventory & Containers

> **Implementation note:** Inventory is **server-authoritative**; client sends slot-click intents, server validates and returns slot updates. Model containers as slot arrays with type-specific transfer rules. Represent all interactions (shift-click, drag-distribute, hotbar-swap) as normalized slot ops.

- [ ] Player inventory: 36 main (hotbar 0–8, storage 9–35), 4 armor (100–103), offhand (−106), 2×2 crafting, ender_chest 27 (`EnderItems`); `SelectedItemSlot` — **[P0]**.
- [ ] Interactions: LMB pick/place, RMB half/one, shift-click quick-move, double-click gather, drag-distribute (even/one-each/creative-fill), number keys 1–9, Q/Ctrl+Q drop, F offhand, MMB creative copy — **[P0]**.
- [ ] Containers (slots): chest 27 (double 54), trapped_chest, barrel 27, shulker_box 27 (keeps NBT, no nesting), ender_chest 27, hopper 5, dropper/dispenser 9, furnace/blast/smoker 3, brewing_stand 5, crafting_table 3×3, anvil 3, grindstone 3, enchanting_table 2, loom/cartography/stonecutter/smithing 2–3, beacon 1, lectern 1, composter, chiseled_bookshelf 6, crafter 3×3, villager 3, horse/llama saddle+armor(+chest) — **[P1]** chest/furnace/crafting core / **[P2]** rest.
- [ ] **Beacon:** pyramid of iron/gold/emerald/diamond/netherite blocks, tiers 1–4 = **9/34/83/164** blocks; needs a clear sky column above; activation payment = 1 mineral ingot/gem — **[P3]**.
- [ ] Beacon effects by tier: primary selectable — Speed/Haste (t1), Resistance/Jump Boost (t2), Strength (t3); tier-4 secondary = Regeneration **or** upgrade primary to level II; range **20/30/40/50** blocks (+level II at t4); reapplies every ~**80gt** with a 9s duration buffer; beam color set by stained_glass placed in the beam — **[P3]**.
- [ ] **Conduit:** prismarine/sea_lantern frame — **16** blocks activate, up to **42** for max range; grants **Conduit Power** (water breathing + night vision + haste + underwater vision) within range **32–96** blocks; attacks a hostile mob within 8 blocks every ~5gt; must be water-submerged; open/animated "eye" state when active — **[P3]**.
- [ ] Container transfer/slot rules (furnace fuel/input/output, brewing bottle slots, hopper filters) — **[P2]**.

---

## 27. UI / HUD

> **Implementation note:** HUD is a Three.js orthographic overlay (or DOM layer). Render procedurally-drawn hearts/hunger/armor/XP/air with correct animated states (absorption gold, poison green, wither, frozen blue, hardcore skin, regen wobble, low-hunger shake). Build the debug (F3) overlay early — it's the primary dev tool. Menus/screens are client-only.

- [ ] Hotbar (9 + selection highlight + item tooltip), crosshair + attack-cooldown indicator, offhand slot — **[P0]**.
- [ ] **Block-break feedback:** 10-stage destroy overlay `destroy_stage_0..9` advancing with the §4.2 break-time accumulator, drawn on the targeted block's faces (in-world); black wireframe **block-outline** on the targeted block/AABB (matches non-cube collision/outline shape) + hit-face highlight — **[P1]**.
- [ ] **Item-use cooldown overlay:** radial/sweep darkening across the hotbar slot icon while an `ItemCooldowns` timer (§5) is active — **[P2]**.
- [ ] **First-person hand & use animations:** held-item bob (view bobbing) + swing on attack/place; use-animations — eating/drinking hold **32gt** (particles + sound), bow/crossbow pull, shield raise (5gt), throw wind-up, spyglass scope overlay + zoom, block-place arm swing — **[P1]**.
- [ ] **Perspective/HUD toggles:** `F5` cycles first / third-back / third-front; `F1` hides the HUD (see keybinds) — **[P1]**.
- [ ] Health 10 hearts (½ increments, state overlays), hunger 10 drumsticks (shake/green), armor 10 icons, XP bar + level, air bubbles 10 (`Air` 300gt), mount health/jump — **[P1]**.
- [ ] Status-effect icons top-right + timers; vignette/pumpkin/portal overlays; sleep/insomnia overlay — **[P2]**.
- [ ] Debug F3 overlay: XYZ, chunk-relative, facing/yaw/pitch, biome, light (block/sky), day, FPS, chunk/entity counts, memory, seed, targeted block/fluid/entity state — **[P0]**.
- [ ] F3 combos: F3+B hitboxes, F3+G chunk borders, F3+A reload chunks, F3+H advanced tooltips — **[P2]**.
- [ ] Menus/screens: title, world select, create-world (name/mode/difficulty/seed/structures/cheats/type/datapacks), server list, pause, options — **[P1]**.
- [ ] Video options: render distance 2–32, sim distance, FOV 30–110, GUI scale, brightness, graphics fast/fancy/fabulous, smooth lighting, clouds, particles, mipmap, biome blend, vsync, max framerate — **[P1]**.
- [ ] Boss bars (`/bossbar`, mob dragon/wither): name, color, style (progress/notched 6/10/12/20), value/max, players — **[P3]**.
- [ ] World border: `/worldborder` set/add/center/damage(0.2/blk/s)/buffer(5)/warning; red/blue wall + screen tint — **[P2]**.
- [ ] Toasts: advancement, recipe unlocked, tutorial, system — **[P2]**.
- [ ] Accessibility/skin: narrator, high contrast, damage tilt, skin part toggles, main hand L/R — **[P3]**.
- [ ] Keybinds (rebindable, conflict detection): move WASD, jump Space, sneak LShift, sprint LCtrl, attack LMB, use RMB, pick MMB, inventory E, drop Q, offhand F, hotbar 1–9, chat T, tab, F5 perspective, F1 HUD, F3 debug — **[P0]**.

---

## 28. Chat

> **Implementation note:** Server relays chat + system messages as **JSON text components** (recursive tree). Implement the component renderer (styles, color, click/hover events) — it's reused by tellraw, titles, signs, books, item names, boss bars. Plaintext transport is fine; secure-chat signing is optional.

- [ ] Send: T chat, / command; `/say`, `/msg|tell|w`, `/me`, `/teammsg|tm` — **[P1]**.
- [ ] JSON text component `{ text|translate|score|selector|keybind|nbt, color, bold, italic, underlined, strikethrough, obfuscated, font, insertion, clickEvent{action,value}, hoverEvent{action,contents}, extra[] }` — **[P1]**.
- [ ] clickEvent (open_url, run_command, suggest_command, change_page, copy_to_clipboard), hoverEvent (show_text, show_item, show_entity) — **[P2]**.
- [ ] Legacy § codes §0–§f colors + §k–§r formatting; 16 named colors + `#RRGGBB` — **[P2]**.
- [ ] `/tellraw`, `/title` (title/subtitle/actionbar/times default 10/70/20gt) — **[P2]**.
- [ ] Client chat settings: mode (shown/commands/hidden), colors, links+prompt, scale, width, opacity, command suggestions — **[P2]**.
- [ ] Tab player list: header/footer, ping bars, gamemode, custom name — **[P2]**.
- [ ] Secure chat (Ed25519 per-message signatures, 1.19+) — **[P3]** — optional.

### Scoreboards & Statistics
- [ ] Scoreboard objectives (dummy/trigger/deathCount/health/xp + stat criteria), display slots (list/sidebar/below_name), scores set/add/operation (min/max/swap), teams (color/friendlyFire/nametagVisibility/collisionRule/prefix/suffix), `/trigger` — **[P3]**.
- [ ] Statistics `stats/<uuid>.json`: categories custom/mined/broken/crafted/used/picked_up/dropped/killed/killed_by; distances in cm, times in ticks; 3-tab stats screen — **[P3]**.

---

## 29. Sound & Particles

> **Implementation note:** Sounds are **procedurally synthesized** (Web Audio API — oscillators/noise/envelopes per material group) since no assets ship; positional attenuation + random pitch/volume variance. Particles are GPU-instanced billboards (Three.js `Points`/instanced quads) driven by a typed particle registry. Both are client-side, triggered by server events (`/playsound`, `/particle`, block/entity events).

- [ ] Sound categories (volume sliders): master, music, record, weather, block, hostile, neutral, player, ambient, voice — **[P1]**.
- [ ] Sound events namespaced (`entity.zombie.ambient`, `block.stone.break/step/place/hit/fall`); each block has a sound group — **[P1]**.
- [ ] 3D positional attenuation (audible ~16 blocks), pitch 0.5–2.0, random variance; `/playsound`, `/stopsound`; subtitles toggle — **[P1]**.
- [ ] Music: menu/creative/biome/credits; music_discs (~15) in jukebox → record category + toast — **[P2]**.
- [ ] Note block: instrument = block beneath (harp/bass/snare/hat/basedrum/bell/flute/chime/guitar/xylophone/…), 25 pitches, `pitch = 2^((note−12)/12)` — **[P2]**.
- [ ] `/particle` + settings (All/Decreased/Minimal); ~95 types (flame, smoke, explosion, poof, crit, enchanted_hit, sweep_attack, dragon_breath, dripping_*, splash, bubble, rain, ash, spore, angry/happy_villager, heart, note, portal, enchant, witch, effect(RGB), totem, item/block, dust(r,g,b,scale), dust_color_transition, vibration, shriek, sculk_charge, sonic_boom, snowflake, cherry_leaves, gust, trial_spawner_detection, vault_connection) — **[P1]** core (flame/smoke/crit/heart/break) / **[P2]** full.
- [ ] Parametric particle payloads: dust `{r,g,b,scale}`, block/item `{state|item}`, dust_color_transition, vibration, shriek — **[P2]**.

---

## 30. Persistence

> **Implementation note:** Mirror the **Anvil/NBT** format so worlds are portable and deterministic. Implement an NBT (tag types 0–12) + region-file (`.mca`) reader/writer in shared TS. Periodic autosave + `/save-all`; chunk ticket system keeps spawn chunks loaded. Use LZ4/zlib for chunk payloads. `DataVersion` gates migration.

- [ ] `level.dat` (gzip NBT): seed, spawn XYZ+angle, Time/DayTime, gamerules, worldborder, Difficulty+lock, hardcore, GameType, DataVersion, raining/thundering+times, WanderingTraderId, DataPacks, WorldGenSettings, LevelName, Version, single-player Player{} — **[P1]** + `level.dat_old` backup + `session.lock` — **[P2]**.
- [ ] `region/r.<x>.<z>.mca`: 32×32 chunks/file, 4 KiB sectors, 8 KiB header (location table + timestamps), payload zlib/gzip/LZ4 — **[P1]**.
- [ ] `entities/r.*.mca` (separate since 1.17), `poi/r.*.mca` (villager/portal POI) — **[P2]**.
- [ ] Chunk NBT: sections[] `{Y, block_states{palette,data bits=max(4,ceil(log2(len)))}, biomes, BlockLight[2048], SkyLight[2048]}`, Heightmaps, block_entities[], block_ticks[], fluid_ticks[], structures, Status, InhabitedTime, isLightOn — **[P1]**.
- [ ] `playerdata/<uuid>.dat`: Pos/Motion/Rotation, Health, foodLevel/saturation/exhaustion, Xp*, Inventory[], EnderItems[], SelectedItemSlot, abilities, Attributes[], active_effects[], Dimension, playerGameType, Spawn*, Air(300), Brain — **[P1]**.
- [ ] `data/`: scoreboard.dat, raids.dat, map_<n>.dat, idcounts.dat, random_sequences.dat; `stats/`, `advancements/`, `datapacks/` — **[P3]**.
- [ ] NBT tag types 0 End–12 LongArray — **[P1]**.
- [ ] Save mechanics: autosave, `/save-all [flush]`/`/save-off`/`/save-on`, chunk tickets, spawn chunks (`spawnChunkRadius`), `/forceload`, DataVersion migration — **[P2]**.

---

## 31. Multiplayer

> **Implementation note:** **Authoritative Node.js server over WebSockets** — the client never simulates block edits, damage, inventory, or mob AI; it sends intents and renders replicated state. Implement a packet protocol with phases, keep-alive, and per-entity tracking ranges. Tick at 20 TPS with a fixed accumulator; decouple render (view distance) from simulation (simulation distance).

- [ ] Server tick loop 20 TPS (50 ms), MSPT metric, `/tick freeze|rate|step|sprint|query` — **[P0]**.
- [ ] WebSocket packet protocol, phases handshake→status→login→configuration→play, keep-alive, compression — **[P0]**.
- [ ] `server.properties` mirror: level-name/seed/type, gamemode, difficulty, pvp, spawn-protection(16), max-players(20), view-distance(10), simulation-distance(10), online-mode, white-list, allow-nether, allow-flight, motd, op/function-permission-level, spawn-monsters, generate-structures, max-world-size, network-compression-threshold, entity-broadcast-range-percentage — **[P1]** core subset / **[P2]** full.
- [ ] Access files: whitelist.json, ops.json, banned-players.json, banned-ips.json; `/whitelist`, `/ban`, `/pardon`, `/kick`, `/list`, `/transfer` — **[P2]**.
- [ ] View distance (render chunks) vs simulation distance (ticked); per-entity client tracking range (players ~48, mobs ~48/80, items ~32) scaled by broadcast % — **[P0]**.
- [ ] Player abilities packet `{ invulnerable, flying, allowFlying, creativeMode, flySpeed(0.05), walkSpeed(0.1) }` — **[P1]**.
- [ ] Spawn protection radius blocks build ≤ radius for perm-level <2 — **[P2]**.
- [ ] LAN "Open to LAN" / `/publish [port] [gamemode] [allowCommands]` — **[P3]**.
- [ ] Chunk streaming: send/unload sections by view distance around each player; delta block updates; entity spawn/move/despawn packets — **[P0]**.

---

## 32. Milestone Roadmap

> Maps priority tiers to playable milestones. Each milestone is shippable and demoable on the Three.js + Node WS stack.

### Milestone M0 — "Sandbox" (all P0)
- [ ] **Goal:** Walk around an infinite procedural world, place/break blocks, see it stream in, multiplayer with 2+ players.
- [ ] Deliverables: seeded density-function worldgen (basic terrain + caves + water at y63), greedy-meshed chunk rendering with sky/block lighting + smooth AO, first-person controller (walk/sprint/jump/sneak, gravity, collision), authoritative WS server with chunk streaming + delta block edits, minimal block set (stone/dirt/grass/sand/gravel/water/log/planks/glass), inventory + hotbar + creative reach, F3 debug HUD, `level.dat`/region persistence.
- [ ] Exit criteria: two clients see each other's edits in real time; world reloads deterministically from disk.

### Milestone M1 — "Survival" (P0 + P1)
- [ ] **Goal:** The core survival loop is playable start-to-first-night.
- [ ] Deliverables: health/hunger/saturation/exhaustion + regen + damage chain, day/night cycle + weather, crafting (2×2/3×3 + furnace smelting), tool tiers + break-time formula + durability, armor + reduction, ~12 core biomes with procedural biome tint, ore distribution, farming (wheat/crops + farmland) + animal breeding, core mob roster (zombie/skeleton/creeper/spider + cow/pig/sheep/chicken) with AI + spawning + mob cap, XP + basic status effects, difficulty modes, containers (chest/furnace/crafting), sounds + core particles, gamerules that gate loops.
- [ ] Exit criteria: a player can gather wood→stone→iron, farm/eat, survive a mob night, and store items.

### Milestone M2 — "Depth" (P0–P1 + P2)
- [ ] **Goal:** Automation, magic, and the Nether.
- [ ] Deliverables: full redstone (dust/repeater/comparator/piston/observer/hopper/rails/minecarts), enchanting (table + anvil + full enchant table) + brewing, structures (village/temple/mineshaft/stronghold/fortress/bastion/ruined portal), villages + trading + gossip + iron golems, Nether dimension + portals + Nether biomes/mobs, weather transforms + lightning, full block/item palettes, beacons, world border, most commands + `/execute`, secure-ish chat + tellraw/titles.
- [ ] Exit criteria: a player can trade, automate item transport, enchant/brew gear, and travel to the Nether via a linked portal.

### Milestone M3 — "Parity" (P0–P3)
- [ ] **Goal:** Full-roster, fine-tuned duplicate.
- [ ] Deliverables: The End + Ender Dragon fight + End cities/elytra, full mob roster (illagers/raids, warden/deep dark, breeze/trial chambers, bosses), advancements (5 tabs) + scoreboards + statistics, ocean monuments/woodland mansions, amethyst geodes + sculk, complete status-effect/potion set, spectator mode + hardcore, command blocks + datapacks + full command tree, all particles/sounds, quasi-connectivity + redstone edge cases, world-blending + all world-type presets.
- [ ] Exit criteria: side-by-side behavior matches vanilla for the audited systems; a full progression run (wood → dragon → elytra) is completable.
