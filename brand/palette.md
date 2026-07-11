# Loomfall Color System — *Light Through the Warp*

> Every color in Loomfall behaves like light passing through taut thread: **it enters gold and leaves violet.**

This is the single canonical color reference for the Loomfall brand, UI, and world.
Machine-readable source of truth: [`brand/palette.json`](./palette.json).
Verification: every UI pair below is computationally checked against WCAG 2.1 relative
luminance by `wcag_check.py` (see *Verification* at the end) — ratios are measured, not estimated.

---

## 1. Philosophy

The whole system sits on **one luminous axis**: dawn gold at the bright end — **Everthread
Gold `#F2C14E`**, the First Thread — falling through dusk violet to **Void Ink `#14101F`**
at the dark end. Every surface, screen, and biome sits somewhere on that axis. Three laws
govern it:

1. **Hue-shift, don't darken.** Shadows rotate toward a cool ~250° violet anchor while
   *holding* saturation; highlights rotate toward the warm ~50° gold anchor while
   *shedding* it. Saturation is a hump that peaks in the midtones — the weave is most
   alive where the light is neither full nor gone. "Warm sun / cool shade" is the whole
   game's look.
2. **Nothing is ever gray.** Every neutral carries a 3–8% saturation bias — warm ecru in
   the lights, violet in the darks — because unbleached cloth is never colorless, only
   undyed. Pure `#000000` / `#FFFFFF` are legal only as sub-1% pixel accents.
3. **Realm hues are oaths.** Saturated ember orange (hue 8–42, S > 0.62, V > 0.55) appears
   **only** in the Cinderloom. Saturated cold cyan (hue 165–205, S > 0.30) appears **only**
   in Nevermend. When a player sees ember, they are near the making-fire; when they see
   true cyan, they are past the last selvage. The Warpwold owns green-through-gold, and
   its day-sky blues stay at hue ≥ 208 so they never trespass on Nevermend's cyan.

Grafted from the dyed-thread school (the competing draft's best ideas, taken whole, not
averaged): the **primary CTA is the gold thread itself** — an Everthread-gold fill with a
void-ink label, so the brand primary is literally the button you press to begin; tooltips
stay **dark loom-room cards in both themes**; and **Everthread gold bookends the journey**
— it is the accent of the Unfinished Hem (the first finished stitch on the frontier) while
the Last Selvage stays entropy-cold cyan, because gold is the player's hope and cyan-cold
is entropy's finish.

Accessibility is the same idea restated, not a compliance layer: the UI is a bright thread
on dark cloth (or dark ink on muslin). All text pairs are held ≥ 4.5:1, non-text
indicators ≥ 3:1, and **no state ever relies on hue alone** — warn/error/success/info each
carry a stitch-glyph shape cue (fray-knot triangle / frayed-X / stitch-check / droplet)
plus a ≥ 0.15 luminance edge against their surface, so they survive protanopia,
deuteranopia, and tritanopia.

---

## 2. Brand core

| Token | Hex | Role |
|---|---|---|
| **Everthread Gold** (primary) | `#F2C14E` | Logo stroke, primary CTA, focus rings, knotlight glow. The one warm thing in Nevermend. |
| — glow tint | `#FFDE8A` | Hover states, halos, knotlight core. |
| — pale tint | `#FFF6DF` | Faintest gold wash. |
| — deep ochre | `#6E4E07` | Gold's ink form for light backgrounds (links on muslin). |
| **Duskwarp Violet** (secondary) | `#4A3670` | The cloth at dusk. Secondary buttons, panels, light-theme hover ink. Tints: lift `#A48FD4`, mid `#61539E`, deep `#292050`. |
| **Void Ink** | `#14101F` | Violet-biased near-black. Dark-theme root, hero backgrounds. Never pure black. |
| **Unbleached Muslin** | `#EDE7DA` | Warm off-white. Body text on dark; light root at `#EFE9DB`. Never pure white. |

**Dye accents** (decorative vocabulary, distinct from functional status colors):
warp green `#5F8A46` · dreamdye indigo `#35509E` (hue ~226 — water/info family, never
cyan) · madder `#B03A52` · weld `#D9B93A` · knotlight `#FFDE8A` · hemstone cyan `#9CC8D6`
(Nevermend-exclusive).

---

## 3. UI tokens

Dark theme is the default (the unlit loom-room); light theme is the muslin page. The
primary button is identical in both themes — the gold thread does not change when the
light does.

### Behavioral rules (rubric-normative)

- **Hover:** background brightens one surface step **and** the label shifts (≥ 5% pixel
  diff). Disabled surfaces (`#282239` dark / `#C9C2B2` light) must **not** respond.
- **Focus:** 2px Everthread ring + 1px void gap, drawn as a running-stitch dashed ring
  (shape cue); verified ≥ 3:1 against root and panel in both themes.
- **Links:** underline (the thread) always on — hue is never the sole link cue.
- **HUD over uncontrolled world backgrounds:** contrast is carried by a 1px `#14101F`
  outline / (+1px,+1px) drop shadow; bitmap text scales nearest-neighbor only
  (`image-rendering: pixelated`).
- **Screen dim:** `#14101F` at 0.55 alpha (dark) / 0.45 (light) — warm-violet black,
  never neutral black.
- **Disabled text** (`#6E6584` / `#8A8270`) is intentionally muted (WCAG-exempt) and
  rendered without shadow so it visibly recedes.

### WCAG pair table (all measured, all passing)

| Pair id | fg | bg | Ratio | Min |
|---|---|---|---:|---:|
| dark_text_body | `#EDE7DA` | `#221B33` | 13.39 | 4.5 |
| dark_text_body_root | `#EDE7DA` | `#14101F` | 15.17 | 4.5 |
| dark_text_heading | `#F7F2E4` | `#14101F` | 16.71 | 4.5 |
| dark_text_dim | `#B4AAC9` | `#221B33` | 7.49 | 4.5 |
| dark_link | `#F2C14E` | `#221B33` | 9.83 | 4.5 |
| dark_link_hover | `#FFDE8A` | `#221B33` | 12.63 | 4.5 |
| dark_button_primary | `#1B1528` | `#F2C14E` | 10.56 | 4.5 |
| dark_button_primary_hover | `#14101F` | `#FFDE8A` | 14.30 | 4.5 |
| dark_button_secondary | `#F4EFE3` | `#3B3158` | 10.36 | 4.5 |
| dark_warn | `#FFD24A` | `#221B33` | 11.45 | 4.5 |
| dark_error | `#FF8578` | `#221B33` | 6.98 | 4.5 |
| dark_success | `#A3E060` | `#221B33` | 10.52 | 4.5 |
| dark_info | `#A9CBF0` | `#221B33` | 9.81 | 4.5 |
| dark_hud | `#F7F2E4` | `#14101F` | 16.71 | 4.5 |
| dark_input | `#EDE7DA` | `#1A1430` | 14.36 | 4.5 |
| dark_placeholder | `#8E84A8` | `#1A1430` | 5.07 | 4.5 |
| dark_tooltip | `#EDE7DA` | `#100C1B` | 15.63 | 4.5 |
| dark_focus_ring | `#FFD24A` | `#14101F` | 12.97 | 3.0 |
| dark_icon | `#CFC6E0` | `#221B33` | 10.06 | 3.0 |
| light_text_body | `#2A2338` | `#E4DCC7` | 11.00 | 4.5 |
| light_text_body_root | `#2A2338` | `#EFE9DB` | 12.43 | 4.5 |
| light_text_heading | `#1B1528` | `#EFE9DB` | 14.65 | 4.5 |
| light_text_dim | `#5B5370` | `#E4DCC7` | 5.27 | 4.5 |
| light_link | `#6E4E07` | `#EFE9DB` | 6.30 | 4.5 |
| light_link_hover | `#4A3670` | `#EFE9DB` | 8.45 | 4.5 |
| light_button_primary | `#1B1528` | `#F2C14E` | 10.56 | 4.5 |
| light_button_secondary | `#F4EFE3` | `#463668` | 9.21 | 4.5 |
| light_warn | `#7A4E00` | `#E4DCC7` | 5.27 | 4.5 |
| light_error | `#9C2A1D` | `#E4DCC7` | 5.56 | 4.5 |
| light_success | `#38601A` | `#E4DCC7` | 5.38 | 4.5 |
| light_info | `#2C517E` | `#E4DCC7` | 5.94 | 4.5 |
| light_hud | `#1B1528` | `#EFE9DB` | 14.65 | 4.5 |
| light_input | `#2A2338` | `#FBF7ED` | 14.06 | 4.5 |
| light_placeholder | `#6E6683` | `#FBF7ED` | 5.04 | 4.5 |
| light_tooltip | `#F4EFE3` | `#2A2338` | 13.11 | 4.5 |
| light_focus_ring | `#463668` | `#EFE9DB` | 8.73 | 3.0 |
| light_icon | `#4E4566` | `#E4DCC7` | 6.49 | 3.0 |

---

## 4. Realm ramps

Each realm has one 8-stop master ramp (dark → light). **Texture-atlas consumers:**
per-texture ramps sample 4–5 *adjacent* stops (e.g. grass = W1–W5), keeping value spread
≈ 0.35 (the ART_DIRECTION contrast budget) and albedo inside the 0.25–0.85 band. The full
8-stop spread is reserved for environment lighting, sky gradients, and hero art. Ramp
banding is hard (no smooth gradients inside a texture) — that banding *is* the pixel-art
identity.

### Warpwold — the lush woven surface
`#2C3247 → #355040 → #436844 → #5F8A46 → #87AB4C → #B8BC5E → #E4D68A → #F6ECC8`

Hue path 227→144→122→98→83→63→51→47: cool violet-blue understitch shadow rotating through
the canon grass greens (132→85) into dawn gold ~50. **W3 `#5F8A46`** is the identity
midtone and saturation peak (default grass albedo, foliage LUT anchor). W0 = night
ambient and cave mouths; W7 = tiny sky-facing highlights only.
Sky `#9FC1E8` (hue ~215 — never cyan), lerping toward W6 at dawn/dusk and `#2C3247` at
night; base fog `#DAE4EC`. Lighting: warm sun multiply **(1.05, 1.00, 0.88)** vs cool
shade multiply **(0.58, 0.63, 0.82)**.

### Cinderloom — the ember and ash making-below
`#191210 → #33221B → #55291E → #8A3220 → #C24A20 → #E8722A → #F7A93E → #FFDF96`

Hue path 13→17→12→10→16→23→35→42 (the canon lava path 6→48: red heart to amber heat).
**C4 `#C24A20`** is the saturation peak (live ember, glowing warp-lines). C0–C1 = ash
vault and spent skein; C7 = fire cores and sparks only. No sky, no night: the ceiling is
`#191210` darkness lit from below. Fog `#7E2F18` ember haze near fire, `#3A2E24` cool
tallow haze in the vaults. Lighting inverts: ember **uplight** multiply
**(1.10, 0.74, 0.46)** on downward faces; upward faces fall to C0–C1.
**Oath:** every saturated orange in the game lives in this ramp.

### Nevermend — the frayed void past the last selvage
`#0C0A16 → #181330 → #292050 → #453672 → #61539E → #7F7BC2 → #9CC8D6 → #DDF3F0`

Hue path 250→250→251→255→251→243→194→172: violet-black holding at the cool anchor,
breaking into cold cyan gleam only at the top. **N3 `#453672`** is the main frayed-island
terrain. N0 is the one legal near-black — it is absence, not surface. N6 `#9CC8D6` is the
cyan threshold; N7 is hemstone pale, the finished rim. Sky `#0A0812`–`#131022`, starless;
fog `#171327` deep / `#2E2846` among frays / `#3C355C` at the selvage. Lighting: flat cold
hemstone key multiply **(0.72, 0.86, 0.90)** from nowhere in particular. The player's
Everthread gold `#F2C14E` is the only warm thing in the realm — that contrast is the
emotional design. **Oath:** every saturated cold cyan lives here.

---

## 5. Biome tables (LUT / atlas consumers)

Each biome ships six slots: `sky`, `fog`, `terrain_primary`, `terrain_secondary`,
`foliage_or_feature`, `accent`. Consumers: sky/fog → per-biome gradient LUTs;
terrain_primary/secondary → block tint LUTs over the realm ramp; foliage_or_feature →
foliage colormap or the biome's signature feature; accent → particles, glints, and
set-dressing pops. Terrain slots sit inside the 0.25–0.85 albedo band; the listed
near-blacks are void/cavern skies (absence, not surface) and near-whites are tiny
emissive/creature accents. Biome accents never carry gameplay meaning by hue alone.

### Warpwold

| Biome | sky | fog | terrain 1 | terrain 2 | foliage/feature | accent |
|---|---|---|---|---|---|---|
| sennmeadows | `#9FC1E8` | `#DAE4EC` | `#699247` | `#8A6B3F` | `#93B04E` | `#C7598C` flower-knots |
| thrumwood | `#8FB2D9` | `#B7C4B4` | `#49703F` | `#5E4630` bark | `#39592F` | `#C9A648` dyed light |
| muslin_fens | `#C2CBD3` | `#E5E3DA` | `#788462` | `#6B6250` | `#9AA378` | `#E9E4F4` silence-moths |
| understitch_downs | `#A9B4D4` | `#CBC5DE` | `#7C9152` | `#8F8AA8` phantom | `#A3B268` | `#B7A8E0` echoes @30–40% |
| warpspine_reach | `#7FA3CC` | `#C2CEDD` | `#697080` stone | `#F0EDE3` snow | `#55704A` | `#E4BD52` ore seams |
| the_frostlace | `#B8CBE2` | `#DEE6EF` | `#CBD5E4` | `#93A7BE` | `#EBF0F7` lace | `#B9C3E8` (blue, NOT cyan) |
| bleachlands | `#C6C3BA` | `#DBD7CC` | `#B5AFA0` | `#948D7D` | `#A19C8E` | `#8C7FA0` last dye-stain |
| dyewater_coast | `#9FBBDE` | `#D3DBE0` | `#E0CE96` sand | `#C4AD72` | `#7FA050` | `#35509E` indigo band |
| unfinished_hem | `#B6BCC6` | `#E7E4DB` | `#9AA285` | `#CAC5B4` canvas | `#ADB394` | `#F2C14E` the first stitch |

Dyewater's sea renders in unmixed hard-edged bands — indigo `#35509E` / madder `#B03A52`
/ weld `#D9B93A` — separated by value steps as well as hue. Unfinished Hem terrain
alpha-fades toward fog at the frontier edge.

### Cinderloom

| Biome | sky | fog | terrain 1 | terrain 2 | foliage/feature | accent |
|---|---|---|---|---|---|---|
| emberwarp | `#221410` | `#7E2F18` glowing | `#241B18` | `#4A2B22` | `#E85B26` warp-lines | `#FFC44E` thread-rivers |
| ashskein_wastes | `#241A16` | `#5C4A42` | `#6E5F57` | `#40352F` | `#332B33` ash-glass | `#F2A63C` slagmoth glints |
| tallow_vaults | `#1C1512` | `#3A2E24` | `#C9B27E` tallowstone | `#8A6F4A` | `#E6D3A0` | `#5A5378` cool shadows (the realm's only) |
| cinderspindle_forges | `#16100E` | `#6E2C16` | `#2B211D` | `#5C332A` | `#EE7A28` spindles | `#FFF3C4` white-fire cores |

### Nevermend

| Biome | sky | fog | terrain 1 | terrain 2 | foliage/feature | accent |
|---|---|---|---|---|---|---|
| the_fraying | `#131022` | `#2E2846` | `#4B3E72` | `#7B6FA6` | `#7E9384` ghost-meadow | `#8FD3DC` fray-edges |
| loosened_dark | `#0A0812` | `#171327` | `#2A2344` | `#171230` | `#5E54A0` | `#74E0E8` stitch-light (max chroma cyan) |
| last_selvage | `#201B38` | `#3C355C` | `#C6C1D6` hemstone | `#8E87AC` | `#E4E0EE` | `#9FE0E4` the Needle's gleam |

---

## 6. Pack variants

This document specifies the **default** pack. The other two procedural packs derive from
the same hue anchors so realm identity survives a hot-swap:

- **smooth-cartoon:** saturation ×1.25; ramp stops 0–1 and 6–7 merged (fewer, softer
  bands). Must measure mean-S ≥ 1.2× default (rubric).
- **gritty:** saturation ×0.65; value contrast stretched ×1.3 on the same anchors. Must
  measure mean-S ≤ 0.7× default and contrast ≥ 1.3× (rubric).

---

## 7. Verification

Run:

```
python3 <scratchpad>/wcag_check.py
```

The script parses `brand/palette.json`, recomputes WCAG 2.1 contrast for every entry in
`ui.pairs` against its declared `minRatio` (4.5 body text, 3.0 non-text/large), asserts
all 16 canonical biome ids (per `naming.json`'s `$biomeIdRule`) are present with all six
color slots, and asserts every color in the file matches `^#[0-9A-Fa-f]{6}$`. Any edit to
this palette must keep that script green.
