# Loomfall — Brand Usage Guide

**Loomfall** is a voxel survival game set in a woven cosmology: a lush cloth
surface (the **Warpwold**), an ember-and-ash making-below (the **Cinderloom**),
and a frayed void past the last selvage (**Nevermend**). The identity merges
two grids — voxel and weave. Its visual voice is *one continuous thread*: the
Everthread, a single gold line that knots, weaves over-and-under, and frays at
its end, drawn through violet-biased darkness. Tagline: *"The cloth that
dreams it is a world."* Look: warm sun / cool shade, saturated midtones, never
pure gray, lyrical but eerie. Loomfall is an original IP — nothing in the
brand may echo Minecraft/Mojang (see Don'ts).

---

## Logo files (`brand/logo/`)

| File | What it is | Use when |
|---|---|---|
| `wordmark-dark.svg` | LOOMFALL wordmark, muslin glyphs + gold thread (740x240) | Default. Any dark or mid ground (Void Ink `#14101F`, panels, hero art, screenshots). |
| `wordmark-light.svg` | Wordmark with glyphs in Duskwarp Violet | Light grounds (muslin `#EFE9DB`, paper, docs). |
| `icon.svg` | Square hemmed plate: loom-eye + thread (64x64) | App icon, avatars, social tiles, anywhere ≥ 32px where the wordmark won't fit. |
| `favicon.svg` | Simplified icon: heavier thread, bigger eye | Browser tabs and any use **below 32px**. Never shrink `icon.svg` for this. |
| `knot.svg` | The loop-knot anchor glyph (32x32) | Secondary system mark: bullets, waypoints, respawn/anchor iconography, list accents. Not a logo substitute. |

All marks are hand-drawn SVG paths — the wordmark is **not a font** and must
never be re-typeset. The gold thread always sits on its Void Ink keyline;
that keyline is what keeps the mark legible on any background. Do not remove it.

**Clear space:** keep a margin equal to the knot's diameter (the circle at the
wordmark's west end) on all sides of the wordmark; for icon/favicon/knot, keep
25% of the mark's width clear.

**Minimum sizes:** wordmark 120px wide; icon 32px; favicon 16px; knot 14px.
Below those, detail (the fray, the over/under weave) breaks — use the next
simpler mark instead.

### Don'ts

- No recoloring outside the palette. Thread = Everthread Gold `#F2C14E`,
  keyline = Void Ink `#14101F`, glyphs = Muslin `#EDE7DA` (dark variant) or
  Duskwarp Violet `#4A3670` (light variant). Nothing else.
- No stretching, skewing, rotating, or redrawing the thread path.
- No drop shadows, glows, bevels, or outlines added on top — the built-in
  keyline already carries contrast.
- Don't separate the knot or the fray from the wordmark; the thread is one
  continuous line and that's the point.
- Don't place the mark on busy grounds without the keyline variant, and don't
  place it on saturated ember orange or cold cyan fields (those hues are
  realm-exclusive; see palette).
- **Nothing Minecraft-adjacent:** no blocky green creature faces, no
  dirt-block motifs, no chunky beveled/extruded logo lettering, no pixel-font
  pastiche of the Minecraft logotype.

---

## Color system

Canonical source of truth: [`palette.json`](./palette.json) (machine-readable)
and [`palette.md`](./palette.md) (the full spec with measured WCAG tables).
Pull hex values from there — don't eyeball or invent tints.

The system is one luminous axis — **Everthread Gold `#F2C14E`** down through
dusk violet to **Void Ink `#14101F`** — governed by three laws:

1. **Hue-shift, don't darken** — shadows rotate cool/violet holding
   saturation; highlights rotate warm/gold shedding it.
2. **Nothing is ever gray** — every neutral carries a 3–8% saturation bias
   (warm ecru in lights, violet in darks). Pure `#000`/`#FFF` only as tiny accents.
3. **Realm hues are oaths** — saturated ember orange belongs to the Cinderloom
   only; saturated cold cyan to Nevermend only; the Warpwold owns green-through-gold.

**UI pair rules (summary):** dark theme is default; every text pair in
`palette.json → ui.pairs` is computationally verified ≥ 4.5:1 (non-text ≥ 3:1)
— if you change a color, re-run the check and keep it green. The primary CTA
is always Everthread gold with a void-ink label, in both themes. Links are
always underlined. Warn/error/success/info each pair a color with a stitch-glyph
shape cue — never signal state by hue alone. Hover brightens one step (≥ 5%
visible change); disabled surfaces never respond.

**Per-dimension ramps** (8 stops each, dark → light, in `palette.json → dimensions`):

- **Warpwold** — violet-blue shadow through grass greens into dawn gold;
  identity midtone **W3 `#5F8A46`**.
- **Cinderloom** — black ash to red ember to amber fire; saturation peak
  **C4 `#C24A20`**; all the game's saturated orange lives here.
- **Nevermend** — violet-black breaking into cold cyan only at the top;
  terrain anchor **N3 `#453672`**; gold appears only as the player's thread.

Per-biome six-slot tables (sky/fog/terrain/feature/accent) are in both palette files.

---

## Typography

No licensed fonts anywhere — system/web-safe stacks only. The wordmark is SVG
paths and covers all "display type" needs; never approximate it with a font.

```css
/* UI & body */
font-family: system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
/* Code, coordinates, seeds */
font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace;
```

Headings: the same sans stack, bold, tight leading, slight letter-spacing for
all-caps labels. Body text uses the palette's text tokens (muslin on dark,
ink on light) — never pure white/black. In-game bitmap text scales
nearest-neighbor only (`image-rendering: pixelated`), 8gp line height minimum.

---

## Landing page (`brand/landing/`)

Fully self-contained: no CDN links, no web fonts, no remote images — all CSS
in `style.css`, all art inline SVG or local files under `landing/assets/`
(which are copies of `brand/logo/` — if a logo changes, re-copy it there).

**Preview:** open `brand/landing/index.html` in any browser. Headless
screenshot if needed:

```
chrome --headless=new --screenshot=out.png --window-size=1280,800 \
  file:///home/user/MinecraftV2/brand/landing/index.html
```

The page is the reference implementation of the brand: dark Void Ink theme,
gold primary CTA, underlined links, realm-ramp section accents, and the
inline-SVG wordmark in the hero. When in doubt about how a token should be
used, look at how the landing page uses it.
