# UX_REVIEW_RUBRIC.md — Screenshot-Based UX / UI / Coloring Review Rubric

**Project:** MinecraftV2 — browser voxel game (TypeScript + Three.js client, HTML/CSS HUD overlay, authoritative Node.js WebSocket server, 100% procedural textures).
**Audience:** the QA-adversary agent driving a real Chromium browser via Playwright.
**Scope:** this rubric scores **screenshots** (plus the DOM HUD overlay and F3 debug overlay used to *locate and verify* what the screenshots show). It is the visual/UX companion to the functional QA plan.
**Ground truth:** [`docs/UX_SPEC.md`](./UX_SPEC.md) (screens, HUD anchors, keybindings, pointer-lock), [`docs/ART_DIRECTION.md`](./ART_DIRECTION.md) (ramps, packs, tinting), [`docs/PARITY.md`](./PARITY.md) (P0 HUD/keybind items), [`docs/MULTIPLAYER_PROTOCOL.md`](./MULTIPLAYER_PROTOCOL.md) (join flow states shown on screen). Numbers in this rubric come in **two marked classes**:
- **[spec]** — copied verbatim from those docs, always next to its § citation. If the build disagrees with a [spec] value, the build is wrong, not the rubric.
- **[rubric-normative]** — measurement thresholds and tolerances this rubric itself defines (the 4.5:1 contrast bar, ΔL/ΔE cutoffs, ±20° hue tolerance, pack-identity ratios, temporal-diff budgets, px tolerances, cap-height floor). These appear in **no** spec doc by design; they are review policy, §6.5's spec-wins rule does **not** apply to them, and a builder cannot dismiss them as "not in spec" — changing one requires editing this rubric.

A number quoted next to a § citation is [spec] unless tagged otherwise; a bare threshold inside a method step is [rubric-normative].
**Companion docs:** scenario ids `S1..S11` refer to the QA_PLAN screenshot set (`docs/QA_PLAN.md`; S11 is defined by this rubric — mirror it into QA_PLAN); bugs are filed per `docs/BUG_TAXONOMY.md`.

---

## 1. How to Apply This Rubric

### 1.1 Screenshot set (QA_PLAN scenario ids, `qa/S1..S11`)

Score the following screenshots, produced by the QA_PLAN scenarios. File naming is `qa/S<id>-<slug>[-<variant>].png`. If QA_PLAN renames a slug, the **scenario id is the stable key**. Files marked **gated** depend on a feature/command shipping at a later milestone — if the gate is unmet, the sub-checks fed by that file are **not scored** (§1.3), never failed.

| Scenario | Files (minimum) | Capture state | Feeds criteria |
|---|---|---|---|
| **S1** Title & menus | `qa/S1-title.png`, `qa/S1-settings.png`, `qa/S1-worldselect.png`, `qa/S1-accessibility.png`, `qa/S1-hover-off.png`, `qa/S1-hover-on.png` | Fresh load; then `Options...`; then `Singleplayer`; then Title person-icon button → `settings.accessibility` (§2.1 UX_SPEC); hover pair = title screen with cursor parked at viewport corner `(10,10)` vs centered on the `Singleplayer` button (200×20 gp, center column §2.1) | R1 R3 R6 R7 |
| **S2** Create world → spawn | `qa/S2-createworld.png`, `qa/S2-spawn-day.png` | Create-world form; then in-world first frame after pointer lock, daytime | R1 R2 R4 R5 |
| **S3** HUD baseline × GUI scales | `qa/S3-hud-gs1.png` … `qa/S3-hud-gs4.png`, `qa/S3-chat-gs1.png`, `qa/S3-tooltip-gs1.png`, `qa/S3-itemname.png` | Survival, full health/hunger, some XP, 9 hotbar items, **an item in the offhand slot** (open inventory `KeyE`, hover a hotbar stack, press `KeyF` = swap-to-offhand, §6.10 UX_SPEC — required so the offhand frame renders, §5.2), `guiScale` set to 1,2,3,4 (§4.2 UX_SPEC). At gs1 additionally capture: chat open with ≥1 line (`KeyT`), and an inventory tooltip hover. `S3-itemname` = any gs, shot ≤ 1 s after pressing `Digit2` (item-name popup, §5.13) | R1 R2 R6 R7 |
| **S4** HUD stress | `qa/S4-hurt-burst-00.png` … `-09.png` (10 frames @ ~100 ms), `qa/S4-underwater.png`, `qa/S4-lowfood.png`, `qa/S4-attack-arc-pre.png`, `qa/S4-attack-arc-post.png`, `qa/S4-subtitle.png`, **gated:** `qa/S4-effects-none.png`, `qa/S4-effects-deuteranopia.png` | Take fall/fire damage during burst; submerge for air bubbles; food ≤ 6. Attack-arc pair: `attackIndicator: Crosshair` (§4.2), frame immediately before `Mouse0` attack on a mob/block and ≤ 2 frames after. Subtitle: enable `showSubtitles` (§4.4), break one block, shoot within 3 s. Effects pair (**gated on the `/effect` command, PARITY P2 command set; cheats ON**): apply ≥ 2 status effects, 1 beneficial + 1 harmful (e.g. speed + poison), shoot once with `colorblindMode: none` and once with `deuteranopia` (§4.5) | R2 R6 R7 |
| **S5** Inventory & tooltips | `qa/S5-inventory.png`, `qa/S5-tooltip.png`, `qa/S5-creative.png` | `KeyE` inventory; hover a named item; creative tabs | R1 R3 R7 |
| **S6** Containers | `qa/S6-chest.png`, `qa/S6-craftingtable.png`, `qa/S6-furnace.png` | Open each container (`Mouse2` use on block) | R1 R2 R7 |
| **S7** Targeting & mining | `qa/S7-outline.png`, `qa/S7-break-stage.png`, `qa/S7-break-stage-late.png` | Crosshair on a stone block (selection outline; **doubles as the pre-mining reference frame** — same pose as the break shots); mid-mining ~50% break progress (~3.7 s bare-hand, PARITY §4.1 formula); late-stage ~85% (~6.4 s) | R5 R7 |
| **S8** Lighting & stability | `qa/S8-torch-tunnel.png`, `qa/S8-night-surface.png`, `qa/S8-static-a.png`, `qa/S8-static-b.png` | 1-torch tunnel at night; night surface; two frames, identical pose, ≥500 ms apart. **Before the static pair:** freeze licit motion — `gameRules.doDaylightCycle = false` (set at world create §2.3.3 UX_SPEC, or `/gamerule doDaylightCycle false`, PARITY P1 commands, cheats ON), `renderClouds: Off`, `particles: Minimal` (§4.2 UX_SPEC), camera pitched ≥ 10° below horizontal | R5 |
| **S9** Texture packs & lineup | `qa/S9-default.png`, `qa/S9-cartoon.png`, `qa/S9-gritty.png` (same seed+pose per pack, `F1` hide-GUI on), `qa/S9-packswitcher.png`, `qa/S9-packswitcher-hover.png`, `qa/S9-lineup-<pack>.png` ×3 | Pack switcher screen, then re-shot with the cursor hovering a **non-selected** pack card (live-preview canvas, §7 UX_SPEC); identical in-world pose re-shot after each hot-swap (§7 UX_SPEC); a built 3×3-per-material test wall (stone \| cobblestone \| gravel columns) shot from **10 blocks** away (verify distance via F3 `XYZ`) | R3 R4 R5 |
| **S10** Chat, pause, death | `qa/S10-chat.png`, `qa/S10-pause.png`, `qa/S10-death.png` | `KeyT` chat with ≥3 lines; `Escape` pause; die once (death screen) | R1 R3 R6 R7 |
| **S11** Multiplayer tab list | **gated:** `qa/S11-tablist.png` | Connect to a local dev server (`Multiplayer` → `Direct Connection`, §9.3 UX_SPEC, `ws://localhost:25565`), hold `Tab` (§5.17 UX_SPEC). **Gated on a runnable server build** — if none exists yet, R6.1's ping-bar sub-check is not scored | R6 |

No S1–S11 scenario spawns a **boss bar** or a **toast**; those R2 rows are gate-annotated and scored only if their event happens to be live (see R2 step 5 skip semantics).

### 1.2 Capture protocol (mandatory, so measurements are reproducible)

- **Viewport:** Playwright `viewport: {width:1920, height:1080}`, `deviceScaleFactor: 1`. All expected-pixel math below assumes this; at dpr 1 and default `guiScale: Auto`, `computeGuiScale` (UX_SPEC §0.2) yields `S = 4` (1920/4 ≥ 320, 1080/4 ≥ 240; /5 fails height 216 < 240). For S3, set `guiScale` explicitly per variant.
- **Screenshots:** `page.screenshot()` (viewport, not fullPage) — captures the WebGL canvas composited with the DOM HUD (`#hud-root`), overlays (`#overlay-root`), screens (`#screen-root`) and toasts (`#toast-root`) per UX_SPEC §0.1.
- **Input:** keys by `KeyboardEvent.code` exactly as in the UX_SPEC §11 table (`KeyW/KeyA/KeyS/KeyD`, `Space`, `ShiftLeft`, `ControlLeft`, `KeyE`, `KeyQ`, `KeyF`, `Digit1..Digit9`, `KeyT`, `Slash`, `Tab`, `F1`, `F3`, `F5`, `Escape`); mouse `Mouse0`=attack, `Mouse2`=use, `Mouse1`=pick. Pointer lock: click the canvas center first (`page.mouse.click(960, 540)`), then drive look via synthesized `mousemove` `movementX/Y`. `Escape` releases pointer lock and opens `pause` (§10.1/§10.3) — take in-world screenshots **before** pressing Escape.
- **Pixel access:** decode PNG (pngjs/sharp); all coordinates below are physical pixels. GUI-pixel (`gp`) coordinates from UX_SPEC §5 convert as `px = gp * S`; virtual viewport `guiVW = 1920/S`, `guiVH = 1080/S`.
- **DOM cross-check:** where a HUD widget is a DOM node, `element.getBoundingClientRect()` (× dpr) gives its rect — use it to *locate* the sample region; the **score is computed from screenshot pixels**, never from CSS alone.
- **Determinism:** fixed world seed (record it from `world_info.seed`, MULTIPLAYER_PROTOCOL §4.3), fixed time of day (F3 shows day/time; PARITY: day = 24000 gt), pack `default` unless the criterion says otherwise, `F1` (hide GUI) for world-only shots, `F3` on where debug values are needed. Exclude animated regions (water/lava, §5.32 ART_DIRECTION) from any pixel-diff test.
- **Licit world motion (any pixel-diff/static test):** the sky is never static — sun/moon/stars/sky gradient track the day cycle and clouds scroll at a fixed world speed (ART §5 #40) even with the player frozen. For the S8 static pair (and any other identical-pose diff): set `gameRules.doDaylightCycle = false` (§2.3.3 UX_SPEC; or `/gamerule`, PARITY P1 commands), `renderClouds: Off`, `particles: Minimal` (§4.2 UX_SPEC), and mask the sky region out of the diff (everything above the horizon — simplest: pitch the camera ≥ 10° down and diff only the bottom ⅔ of the frame).

### 1.3 Scoring scale (anchored, integers only)

| Score | Meaning |
|---|---|
| **5** | Meets the "5" anchor on **every** sub-check of the criterion. Spec-conformant, no visible defects. |
| **4** | Between 5 and 3: all sub-checks pass their pass-thresholds, but with minor cosmetic deviations (≤ tolerance ×2) on ≤2 sub-checks. |
| **3** | Meets the "3" anchor: functional and usable, measurable deviations from spec that a player would notice but can work around. |
| **2** | Between 3 and 1: at least one sub-check lands in the "1" band OR ≥3 sub-checks in the "3" band. Player-hostile. |
| **1** | Meets the "1" anchor on any sub-check: broken, illegible, misleading, or missing entirely. |

A criterion's score is governed by its **worst sub-check** (worst-of, not average) — a single illegible HUD element is user-visible regardless of how good the rest is.

**Band precedence (bands are disjoint):** where a criterion states a numeric tolerance, a deviation ≤ tolerance×2 scores under the generic **4**-band, and every per-criterion 3-anchor range starts **strictly above** tolerance×2 (R2's 3-anchor reads `> 4 px (≤ 8 px)` accordingly — tolerance 2 px, ×2 = 4 px). If any anchor phrase can still be read to overlap the 4-band, the 4-band wins. Two reviewers measuring the same value must land in the same band.

**Gated sub-checks (not scored ≠ fail):** if a sub-check's required state cannot be produced because its feature/command is gated behind a later milestone (rows marked **gated** in §1.1), the sub-check is **not scored** — it neither passes nor fails, is excluded from worst-of, and the criterion's `note` must list it as `gated:<sub-check id>`. Likewise a conditional HUD widget whose §2 gate condition is unmet in the capture state is *not visible = not scored*, never "missing".

### 1.4 Overall weighted score

Weights (sum = 100):

| Id | Criterion | Weight |
|---|---|---|
| R1 | Text readability | 20 |
| R2 | HUD layout conformance | 15 |
| R3 | Menu flow friction | 10 |
| R4 | Color-palette cohesion | 15 |
| R5 | Readability of the world | 15 |
| R6 | Accessibility | 15 |
| R7 | Feedback & affordance | 10 |

```
overall = Σ(weight_i × score_i) / 100          // 1.00 .. 5.00, report 2 decimals
normalized100 = (overall − 1) / 4 × 100        // 0 .. 100
PASS gate: overall ≥ 3.00 AND no criterion ≤ 2
```

### 1.5 Machine-readable result format

Each criterion emits exactly one entry with these keys (extra keys forbidden in the entry; run metadata goes in the envelope):

```jsonc
// entry shape — REQUIRED keys, exactly these:
{ "criterion": "R1", "score": 3, "evidenceScreenshot": "qa/S3-hud-gs2.png",
  "note": "worst sub-check: R1.3 tooltip lore (--ui-text-dim): CR_bg 4.1:1, CR_sh 4.03:1 (threshold 4.5:1); shadow present; secondary text in the 3.0-4.5 band" }
```

Full report envelope:

```jsonc
{
  "rubricVersion": 1,
  "pr": 123,
  "date": "2026-07-11T18:20:00Z",        // ISO 8601 UTC, capture end time — REQUIRED (§6.3 trends join on it)
  "commit": "abc1234",                    // git SHA (or CI build id) of the build under review — REQUIRED (§5 joins bugs to runs)
  "capture": {
    "viewport": [1920, 1080], "dpr": 1, "seed": "8675309",
    "pack": "default",                    // primary pack — every criterion except R4's S9 triplet
    "packsTested": ["default", "smooth-cartoon", "gritty"],  // all packs shot this run (S9)
    "guiScaleTested": [1, 2, 3, 4]
  },
  "results": [
    { "criterion": "R1", "score": 4, "evidenceScreenshot": "qa/S3-hud-gs2.png", "note": "..." },
    { "criterion": "R2", "score": 5, "evidenceScreenshot": "qa/S3-hud-gs1.png", "note": "..." }
    // ... one entry per R1..R7
  ],
  "overall": { "weightedScore": 3.45, "normalized100": 61.3, "pass": false, "failures": ["R1"] },
  "bugs": ["BUG-17"]                      // ids/URLs of bugs filed per §5, one per criterion ≤ 2; [] if none
}
```

`evidenceScreenshot` is the single screenshot that best shows the **worst** sub-check (the one that set the score). `note` must name the sub-check id and the measured value vs threshold (or `gated:<id>` for not-scored sub-checks, §1.3).

**Field definitions (normative):**
- `overall.failures` = exactly the criteria with `score ≤ 2` (the other half of the gate is derivable: `pass = weightedScore ≥ 3.00 && failures.length === 0`).
- **Rounding:** `weightedScore` to **2 decimals**, `normalized100` to **1 decimal**, both round-half-up — `(3.45 − 1)/4 × 100 = 61.25 → 61.3`.
- `bugs` must be non-empty whenever `failures` is non-empty (§5 makes filing mandatory before the review is posted).

---

## 2. Criteria

### R1 — Text readability (weight 20)

**What:** every piece of HUD/menu/screen text is legible: sufficient luminance contrast against what it is actually drawn on.

**Reference values (UX_SPEC §0.5):** primary text `--ui-text #FFFFFF`; **panel text `--ui-text-panel #404040`** (dark static text on light `--ui-panel` faces — container/screen titles, slot-group labels — drawn with **no shadow**); dim `#A0A0A0`; warn `#FFFF55`; error `#FF5555`; XP text `--ui-xp #80FF20` with black outline; every other text draw carries a **drop shadow `#3F3F3F` at (+1gp,+1gp)**, except warn/err text on `--ui-panel`/`--ui-btn` faces (keybind conflicts §4.3, anvil §6.8), which carries a **1gp 4-offset black `#000000` outline** instead (§0.5). Panels are `--ui-panel #C6C6C6`; buttons `--ui-btn #6B6B6B`; screen dim `#000000 @ 0.50`; chat/text background `#000 @ textBackgroundOpacity` (default 50).

**WCAG relative-luminance / contrast formula (compute exactly this):**

For an 8-bit sRGB color `(R8, G8, B8)`:

```
for each channel: c  = V8 / 255
                  c_lin = c / 12.92                     if c ≤ 0.03928
                        = ((c + 0.055) / 1.055) ^ 2.4   otherwise
L  = 0.2126·R_lin + 0.7152·G_lin + 0.0722·B_lin
CR = (L_lighter + 0.05) / (L_darker + 0.05)
```

**Pass threshold: CR ≥ 4.5 : 1** [rubric-normative, adopted from WCAG 1.4.3] for normal-size text (all game text is < 18pt — the bitmap font is 8gp line-height, §0.5 — so the large-text 3:1 relaxation never applies).

Worked constants (verify your implementation against these): `#FFFFFF` vs `#3F3F3F` → **10.5:1**. `#FFFFFF` vs `#C6C6C6` → **1.71:1** (fails — white text straight onto a panel face without shadow/recess is a defect). `#FFFFFF` vs `#6B6B6B` → **5.33:1**. `#404040` vs `#C6C6C6` → **6.07:1** (the panel-text token). `#FF5555` vs `#000000` → **6.67:1**; `#FFFF55` vs `#000000` → **19.7:1** (why the black outline carries warn/err on panel/button faces). `#FF5555` vs `#3F3F3F` → **3.35:1** (why the plain shadow is NOT sufficient for err text — spec mandates the outline there instead). `#80FF20` vs `#000000` → **16.2:1**.

**Pixel-sampling method (text color vs surrounding-background median):**

1. **Locate** the text: DOM text → `getBoundingClientRect()` of the element; canvas-drawn text (F3 overlay, slot counts, level number) → the expected rect from the UX_SPEC §5 anchor table (see R2) padded by 2·S px.
2. **Glyph mask:** inside the rect, mark pixels whose color is within max-channel-distance ≤ 24 of the expected token color. Text color = per-channel **mode** of the glyph mask.
3. **Shadow mask:** pixels within distance ≤ 24 of `#3F3F3F`. Shadow **present** iff ≥ 60% of glyph pixels have a shadow-mask pixel at offset `(+S, +S)` px. **Outline mask** (warn/err on panel/button faces, §0.5): same construction vs `#000000`, but required at **all four** offsets `(+S,0) (−S,0) (0,+S) (0,−S)`; outline **present** iff ≥ 60% of glyph pixels have an outline-mask pixel at every one of the four offsets.
4. **Background:** dilate the glyph mask by 3 px; background = per-channel **median** of rect pixels outside (glyph ∪ shadow ∪ dilation ring).
5. `CR_bg = CR(text, background)`; `CR_sh = CR(text, shadow color)`.
6. **Element pass rule:**
   - **Dark panel text** (`--ui-text-panel #404040` on `--ui-panel` faces — container/furnace titles, screen titles, slot-group labels, §0.5): pass iff `CR_bg ≥ 4.5` (worked: 6.07:1 on `#C6C6C6`). No shadow expected — skip the step-3 check for these elements.
   - **Light text over a solid UI surface** (`--ui-text`, `--ui-text-dim`, `--ui-xp` on panels, buttons, list rows, tooltips): pass iff `CR_bg ≥ 4.5` **OR** (shadow present per step 3 AND `CR_sh ≥ 4.5`). Rationale: §0.5 mandates the shadow on these draws and defines no light-token/panel combination that reaches 4.5:1 unaided (white on `#C6C6C6` = 1.71:1) — the shadow is what carries legibility, so a spec-conformant draw must not fail on `CR_bg` alone.
   - **Warn/err text on `--ui-panel`/`--ui-btn` faces** (keybind-conflict rows §4.3, anvil `"Too Expensive!"` §6.8): pass iff **outline present** (step 3 outline mask) AND `CR(text, #000000) ≥ 4.5` (worked: `#FF5555` 6.67:1 ✓, `#FFFF55` 19.7:1 ✓). The plain shadow does NOT pass here (`#FF5555` vs `#3F3F3F` = 3.35:1); outline missing = element fail.
   - **Text over the live 3D world or over a translucent `#000 @ opacity` strip** (item-name popup §5.13, actionbar §5.16, level number §5.3, subtitles §5.11, nametags §5.19, **chat lines + input** — background `#000 @ textBackgroundOpacity`, §0.5/§4.5 — and the **F3 overlay** `#000@0.5` strip, §5.14): the effective background blends with whatever terrain is behind it (white over 50%-black-over-snow ≈ 4.35:1), so it is uncontrolled; pass iff **shadow/outline present AND `CR_sh ≥ 4.5`** (the spec mandates the shadow precisely for this case); additionally flag (score cap 4) if `CR_bg < 1.5` on the sampled frame (text nearly matches the composite behind it even with shadow). Record `CR_bg` in the note as informational only.
7. Sample at minimum: title-menu button labels (S1), world-select row line 2 dim text (S1), hotbar stack counts + selected-item name popup (S3), tooltip title/lore (S5), furnace/container titles (S6), chat lines + input (S10), death-screen title/score (S10), F3 overlay lines (any in-world shot with F3 — it has its own `#000@0.5` text background, §5.14).

**Exemption:** the crosshair uses an inverting blend (`difference` / `ONE_MINUS_DST_COLOR`, §5.7) — excluded from R1 (checked in R2/R7 for presence instead).

**Anchors:**
- **5** — every sampled element passes its rule; shadows/outlines present everywhere §0.5 requires them. **Disabled text is exempt from the 4.5:1 threshold** (WCAG 1.4.3 explicitly exempts inactive components — `--ui-text-dim #A0A0A0` on the disabled face `#4A4A4A` is 3.39:1 and spec-conformant); instead verify **presence + distinctness**: the disabled label's glyph mode is within max-channel-distance ≤ 24 of `#A0A0A0` AND ≥ 48 away from `--ui-text #FFFFFF` on every channel (i.e. it must render, and must not render as enabled text).
- **3** — all *primary* text (button labels, titles, hotbar counts, chat) passes, but secondary text (lore, dim line-2 metadata, timers) lands 3.0–4.5:1, or shadow missing on ≤2 over-world elements that still read ≥ 3.0:1 on the sampled frame.
- **1** — any primary text < 3.0:1 vs its background with no shadow/outline (e.g. white-on-`#C6C6C6` labels), or any text clipped/overlapped to illegibility, or missing entirely where the spec requires it.

---

### R2 — HUD layout conformance (weight 15)

**What:** HUD widgets sit exactly where UX_SPEC §5 anchors them, at every GUI scale 1–4, with no overlap and nothing off-screen.

**Expected rects** (gp; convert to px via ×S; `guiVW=1920/S`, `guiVH=1080/S`; y from top). All from UX_SPEC §5. The **Visible when** column is the widget's gate: an absent widget whose gate is unmet is **not scored** (§1.3 skip semantics), not "missing".

| Widget | Rect (gp, top-left / size) | Visible when |
|---|---|---|
| Hotbar sprite | `(guiVW/2 − 91, guiVH − 22)`, 182×22 | always (except F1/spectator) |
| Hotbar slot *i* icon (0-based) | `(guiVW/2 − 91 + 3 + 20i, guiVH − 19)`, 16×16 | slot non-empty (S3 fills all 9) |
| Selection highlight (slot *i*) | `(guiVW/2 − 91 − 1 + 20i, guiVH − 23)`, 24×24 | always with hotbar |
| Offhand frame (mainHand right) | `(guiVW/2 − 120, guiVH − 23)`, 22×22 | **offhand slot non-empty** (§5.2 default: hidden when empty — S3 equips one via `KeyF`) |
| XP bar | `(guiVW/2 − 91, guiVH − 29)`, 182×5 | survival-family modes |
| Level number | centered `x = guiVW/2`, baseline `guiVH − 31` | level > 0 (§5.3 — S3 grants XP) |
| Heart *k* (k = 0..9) | `(guiVW/2 − 91 + 8k, guiVH − 39)`, 9×9, pitch 8 | survival/hardcore/adventure |
| Armor icon *k* | `(guiVW/2 − 91 + 8k, guiVH − 49)`, 9×9 | `armorPoints > 0` (§5.5) |
| Hunger icon *k* (k = 0 rightmost) | `(guiVW/2 + 91 − 9 − 8k, guiVH − 39)`, 9×9 | survival/hardcore/adventure |
| Air bubbles | right-aligned like hunger, row `y = guiVH − 49` | underwater only (§5.6 — S4-underwater) |
| Crosshair | 9×9 centered `(guiVW/2, guiVH/2)` | no GUI screen open, not spectator, no F1 (§5.7) |
| Status-effect icons | top-right, 24×24, pitch **25gp**: `dx = −25 − 25·index` (§5.8 — the spec's former "26gp pitch" phrasing was a self-contradiction, resolved in §5.8 to 25gp; the dx formula governs), harmful row `dy +26` | `activeEffects.length > 0` (§5.8 — **gated:** S4-effects) |
| Boss bar | top-center, 182×5 | `bossEvents.length > 0` (§5.10 — no S1–S11 scenario spawns one: not scored unless present) |
| Toasts | top-right, 160×32 cards | a toast is live (§5.12 — not scored unless present) |
| Item-name popup / actionbar | centered `x = guiVW/2` above the bottom cluster (`≈ guiVH − 41 / − 42`) | ≤ ~2 s after slot change / actionbar message (§5.13/§5.16 — S3-itemname) |

**Method:**
1. For each of S3's four screenshots (guiScale 1–4), compute S and the expected px rects.
2. **Presence + position:** detect each widget by (a) DOM rect where DOM-backed, and (b) pixel evidence inside the expected rect — e.g. ≥ 30% of the heart rect within distance ≤ 32 of `--ui-hp #FF0000`; hunger vs `--ui-food #C4915B`; XP fill vs `--ui-xp #80FF20`. Tolerance: **± 2 physical px** [rubric-normative] on each edge (integer scaling + rounding).
3. **Overlap:** pairwise intersection area of all *visible* widget rects must be 0 (except the intentional 1px heart overlap within a row — pitch 8 for 9-wide sprites, §5.4).
4. **Safe area:** every rect fully inside the viewport; hotbar bottom edge flush at `guiVH` (bottom-anchored).
5. **Mode/state gating (§5):** creative shows hotbar+crosshair only (no health/hunger/armor/xp/air); armor row only when armorPoints > 0; air row only underwater (S4-underwater); offhand frame only when the offhand holds an item (S3's capture state equips one); status-effect icons only when effects are active (S4-effects, gated); boss bar/toasts only while their event is live; F1 hides all of `#hud-root`. **Skip semantics:** "any widget missing" in the anchors below applies **only to widgets whose gate is met** in the evaluated screenshot's capture state; a conditional widget absent while its gate is unmet is not scored (§1.3). A conditional widget *rendering while its gate is unmet* (e.g. offhand frame drawn empty on default config, air row on land) is a "3"-band gating defect.
6. **GUI-scale integrity:** across gs1→gs4 the same widget's gp-space position must be identical (its px position scales exactly by S); pixel-art must scale nearest-neighbor (no bilinear blur: edge transition width between a sprite pixel and its neighbor ≤ 1 px).

**Anchors:**
- **5** — every gate-met widget present, within ±2 px of spec at all four scales, zero overlaps, correct mode/state gating, crisp integer scaling.
- **3** — all gate-met widgets present and non-overlapping, but ≥1 widget off by **> 4 px (≤ 8 px)** (deviations ≤ 4 px = tolerance×2 fall in the 4-band, §1.3) or a row order swapped (e.g. armor/health rows exchanged), or blurry (non-integer) scaling at one scale, or a widget rendering while its gate is unmet.
- **1** — any gate-met widget missing (hotbar, hearts, crosshair…), any overlap at any scale 1–4, any widget clipped off-screen, or HUD ignores guiScale entirely.

---

### R3 — Menu flow friction (weight 10)

**What:** core tasks take few inputs; back/escape behavior matches the UX_SPEC §1 screen-flow graph and §0.4 stack semantics.

**Definitions:** an **input** = one mouse click (a double-click = 2) or one keypress. Counts are measured by executing the scripted task in Playwright and counting inputs between the start screenshot and the success screenshot.

**Tasks & budgets:**

| Task | Scripted path (click targets from UX_SPEC §1–§2, §7) | Budget |
|---|---|---|
| T1: title → in-world (existing world) | `Singleplayer` → double-click world row (§2.2 "Play: double-click row") | **≤ 3 inputs** |
| T2: title → in-world (new world, all defaults) | `Singleplayer` → `Create New World` → `Create New World` (§2.3 defaults are valid) | **≤ 3 inputs** |
| T3: switch texture pack, in-game | `Escape` → `Options...` → `Resource Packs...` → move-arrow on `gritty` card → `Done` → `Done` → `Back to Game` (§3.1, §4.1, §7) | **≤ 7 inputs** |
| T4: open + close inventory | `KeyE` → `KeyE` (or `Escape`) returns to pointer-locked gameplay (§0.4) | **= 2 inputs** |

**Consistency sub-checks (screenshot the before/after of each):**
- **T5 Esc symmetry:** on each of {`settings`, `settings.video`, `settings.texturePacks`, `inventory`, `container`, `chatOverlay`}, `Escape` pops exactly **one** level (§0.4 "Esc pops the top screen"); from in-world it opens `pause`; from `pause`, `Back to Game` returns and re-locks the pointer (§3.1).
- **T6 Settings return:** `settings` opened from Title returns to Title on `Done`/Esc; opened from Pause returns to Pause (§1: "pops back to whichever pushed it").
- **T7 No dead ends:** every screen in the S1/S5/S6/S10 set has a reachable `Done`/`Cancel`/`Back`/Esc path that does not lose unsaved state without a confirm (world Delete must confirm, §2.2).

**Anchors:**
- **5** — all budgets met, T5–T7 all consistent, pointer lock correctly released on screen push and re-acquired on pop (§10.3).
- **3** — one task over budget by ≤ 2 inputs, or one Esc inconsistency that has a workaround (e.g. Esc in settings skips to game but `Done` works).
- **1** — any task impossible or over budget by > 4 inputs; Esc quits the world / disconnects / discards state without confirmation; any screen traps the user (no exit).

---

### R4 — Color-palette cohesion (weight 15)

**What:** blocks on screen use the ART_DIRECTION §2.2 ramps; the three packs read as their §3.1 identities.

**Reference anchor hues (ART_DIRECTION §2.2/§2.3; H° in HSV):** grass 85–132 · dirt 24–38 · stone **216** (S 3–8%, never 0) · cobble 215 · sand 46 · gravel mixed 24/216 · wood_planks 30–42 · leaves 82–120 · water 192–212 · lava 6–48 · deepslate 216 · obsidian 265. Value band: albedos **0.25–0.85** (extremes only on ≤3-texel accents, §1.3). Grass/foliage/water are biome-tinted (§1.6 — plains grass tint `(0.57,0.74,0.35)`, plains water `(0.25,0.46,0.90)`) — compare grass/leaves/water hue **after** applying the biome's tint expectation, or exclude them from the hue check and verify tint presence instead.

**Method (per-face dominant-color sampling):**
1. Use `qa/S9-lineup-<pack>.png` (the test wall) plus `qa/S2-spawn-day.png`. Sample **top faces in full daylight** wherever possible — top faces get `shade = 1.00` (§1.5.1) so albedo is least distorted. Side faces are ×0.80/0.60 **in linear space** (§1.5.1, §6.6 ART): to un-multiply, **linearize** each sample with the R1 sRGB transfer, divide by the face's shade constant (and by the light-brightness/AO estimate where measurable), **re-encode to sRGB**, and only then convert to HSV. Never divide an sRGB-encoded value by a linear constant.
2. For each visible block face region (walls are built at known coordinates; project or crop manually): dominant color = per-channel median of the region; convert to HSV.
3. **Hue check:** hue within **± 20°** [rubric-normative] of the material's anchor (family hue-swing across a ramp is 20–40°, §3.2, so ±20° around the mid stop is the tolerance). **Saturation floor:** stone-family faces must have S ≥ 0.02 (§1.3 "never use pure gray"). Two material-specific rules (both mechanically forced by the art architecture):
   - **Stone-family (stone / cobble / deepslate):** compute the hue on the **mid-value pixel cluster only** — pixels whose V lies between the face's 25th and 75th V-percentiles. The baked §4.11 tint pushes the brightest texels warm (~50°) and the darkest cool (~227°) at S 3–8%, so a whole-face median hue can legitimately wander near the ±20° edge on a conforming build; the mid-value texels carry the 216° anchor.
   - **Gravel (dual anchor 24°/216°):** §5 #7 designs gravel as a warm/cool pebble **mix** — a single median of a bimodal hue population is near-neutral with an unstable hue and is NOT scored. Instead: take face pixels with S ≥ 0.02, assign each to the circularly-nearer of the two anchors (24° vs 216°); pass iff **both clusters hold ≥ 20% of the pixels** AND each cluster's circular-mean hue is within ±20° of its own anchor.
4. **Value band:** face median V within 0.25–0.85 after un-multiplying the face shade **in linear space** (step 1: linearize → ÷shade → re-encode → V).
5. **Pack identity (relative, same scene, same pose, block pixels only — the mechanical core):** `satScale` transforms **block albedos only** (§3.4) — sky/fog pixels are identical across packs and dilute the ratios toward 1, so compute over a **block-only mask**: shoot the S9 triplet with `F1` (hide GUI, §1.2) and either crop to the test wall's projected rect (preferred — the wall is at known coordinates) or mask out the sky (drop every row above the horizon line). Over that masked region compute mean saturation `S̄` and per-face contrast `C = V_max − V_min`:
   - `smooth-cartoon`: `S̄_cartoon ≥ 1.2 × S̄_default` AND `C_cartoon ≤ C_default` [rubric-normative ratios] (targets: sat mid 65–85% vs 40–60%; contrast ~0.25 vs ~0.35, §3.2).
   - `gritty`: `S̄_gritty ≤ 0.7 × S̄_default` AND `C_gritty ≥ 1.3 × C_default` (sat 15–35%; contrast ~0.55).
   - `default`: per-face `C ≈ 0.35 ± 0.12`.
6. **Cohesion (ramp hue-shift — measured WITHIN one face, never lit-vs-shaded):** §4.11's warm/cool tint is baked **per-texel into the albedo** and is identical on every face of a block; face shading (`shade[6]`, §1.5.1) and light brightness (§1.7) are hue-preserving scalar multiplies. On a conforming build a shaded face therefore has the **same** dominant hue as the lit face — do NOT compare faces against each other. Instead verify §1.3's hue-shift rule inside a single face texture: on one face region ≥ 64×64 px each of **stone and cobblestone** (lineup columns at 10 blocks ≈ 77 px/block at fov 70 — big enough), take pixels with S ≥ 0.02 and split them into the **darkest V-quartile** and **brightest V-quartile**; pass iff the dark quartile's circular-mean hue is closer (circular distance) to the **250° shadow anchor** than the bright quartile's hue is, per material. If > 80% of a face's pixels fall under the S guard, fall back to verifying the §2.2 ramp hex directly from a close-up (crosshair-distance shot, compare stops 0 and 4 hues the same way). Fail = no hue shift across the ramp (flat gray shading — the §1.3 defect).
7. **Pack switcher UI (S9-packswitcher):** three built-in cards present (`default`, `smooth-cartoon`, `gritty`, §7 UX_SPEC); live-preview canvas visibly changes on hover — diff `qa/S9-packswitcher.png` vs `qa/S9-packswitcher-hover.png` inside the preview-canvas rect: ≥ 5% of its pixels must change by > 8/255 in some channel; and the in-world S9 triplet proves the hot-swap applied without reload (world pose identical, textures changed).

**Anchors:**
- **5** — all sampled materials within hue/sat/value tolerances; all three pack-identity inequalities hold; hot-swap works; no material reads as pure gray.
- **3** — ≤ 2 materials out of hue tolerance (but still ordered correctly relative to each other — e.g. dirt warmer than stone), or one pack-identity inequality fails marginally (within 10% of its ratio) while the packs remain visually distinct.
- **1** — blocks share one mud palette (pairwise dominant-color ΔE_OKLab < 0.03 across ≥ 3 distinct materials), pure-gray stone (S = 0), packs indistinguishable in the S9 triplet, or hot-swap requires a reload/does nothing.

---

### R5 — Readability of the world (weight 15)

**What:** the player can tell blocks apart at distance, lighting grades smoothly, and the frame is free of z-fighting/seam artifacts.

**Sub-checks & methods:**

1. **R5.1 Block-vs-block distinguishability at 10 blocks.** On `qa/S9-lineup-default.png` (stone | cobblestone | gravel columns, camera 10 blocks away per F3 XYZ): compute per-column mean color (OKLab) and luminance std-dev (texture "busyness"). Pass per pair iff `ΔE_OKLab(meanA, meanB) ≥ 0.04` **or** `max(stdA,stdB)/min(stdA,stdB) ≥ 1.3` [rubric-normative]. ART_DIRECTION requires cobble darker + higher-contrast than stone (§2.2) and gravel warm/cool mixed pebbles — all three pairs must pass. Repeat for dirt|sand|planks if present in the lineup.
2. **R5.2 Lighting gradient smoothness.** `qa/S8-torch-tunnel.png`: torch emits 14, −1 per block (ART §1.7; PARITY §19 flood-fill). **All R5.2 thresholds are on LINEAR luminance** — linearize samples with the R1 sRGB transfer before any arithmetic. **Per-block aggregation (mandatory — never a single-pixel read):** the floor texture's per-texel contrast budget is ~0.35 (ART §1.4) plus jitter, which dwarfs the 2% tolerance; at each block center 1..10 from the torch take an **N×N-px patch** (N = 2·S, minimum 8 px) centered at the **same texel offset of each floor tile** (the tile repeats every 16 texels, so identical UV offsets sample identical texels and texture variation cancels), and use the patch **median linear luminance** as that block's value. The 10-value sequence must be **monotone non-increasing** with no upward step > 2% and no single downward cliff > 40% (linear) between adjacent blocks (banding); brightness must follow the general shape of `0.05 + 0.95·0.8^(15−level)` (Spearman rank correlation vs predicted ≥ 0.9 — the predicted curve is already linear-space, §1.7).
3. **R5.3 Temporal stability (z-fighting/shimmer).** Diff `qa/S8-static-a.png` vs `-b.png` (identical pose, no input between; captured with `doDaylightCycle=false`, `renderClouds: Off`, `particles: Minimal` per §1.1/§1.2): after masking known-animated regions (water/lava/fire, §5.32 ART), HUD timers, **and the sky region** (everything above the horizon, or equivalently diff only the bottom ⅔ of a ≥ 10°-pitched-down frame — sun/moon/stars/sky gradient and scrolling clouds, ART §5 #40, are licit motion, not shimmer), pixels differing by > 8/255 in any channel must be **< 0.5%** [rubric-normative] of the unmasked area. Z-fighting shows up as flickering stripes on coplanar faces; the block selection outline is nudged 0.002 outward precisely to avoid this (§5.7 UX_SPEC).
4. **R5.4 Seams.** On a large flat area (S2 spawn or the lineup wall): scan luminance columns/rows for periodic dark/bright lines at 16-block chunk boundaries and at per-block 16-texel tile edges (ART §1.2 forbids directional tile borders; §6.4 mip padding prevents atlas bleed). A repeated grid line (mean luminance dip > 5% at the periodic offset) = fail. Optionally toggle F3+G (chunk borders, §5.14) to locate boundaries, then re-shoot with it off.
5. **R5.5 Face shading.** A solid block must read as 3D: sample the top/side faces of one cube in uniform full daylight (same light level, patches away from AO-darkened edges, same-texel patches as R5.2 where possible). **Linearize first**: `shade[6]` multiplies in **linear** space (ART §1.5.1, §6.6), so compute mean **linear** luminance per face and require linear ratios `1.00 / 0.80 (±Z) / 0.60 (±X)` within ±0.10. Ratios computed on sRGB-**encoded** pixels come out ≈ `0.90 (±Z)` and `≈ 0.79 (±X)` and would spuriously fail a conforming build — never compare encoded ratios against the linear constants. All-faces-equal (linear ratio ≈ 1.00 everywhere) = flat world (the exact P0 defect §1.5.1 warns about).

**Anchors:**
- **5** — all five sub-checks pass numerically.
- **3** — one adjacent-material pair marginal (ΔE 0.02–0.04 with a std ratio 1.15–1.3), or minor banding (one non-monotone step ≤ 4%), or temporal diff 0.5–2% localized to one region.
- **1** — any material pair visually identical (ΔE < 0.02, std ratio < 1.15), lighting in visible hard bands or uniform full-bright at night, temporal diff > 2% (z-fighting), or grid seams across the terrain.

---

### R6 — Accessibility (weight 15)

**What:** critical states don't rely on hue alone, text is physically big enough at GUI scale 1, and the UX_SPEC §4.4/§4.5 accessibility surfaces exist.

**Sub-checks & methods:**

1. **R6.1 Colorblind-safe hotbar selection indicator.** The selected-slot indicator must survive deuteranopia, protanopia, **and tritanopia** simulation — UX_SPEC §4.5 ships all three as `colorblindMode` values, and tritanopia is the one that stresses the blue/yellow-confusable pairs (XP `#80FF20` vs warn `#FFFF55`, water-vs-sky cues). Simulate on `qa/S3-hud-gs2.png` using the standard LMS projection (Viénot–Brettel–Mollon 1999). All math in **linear** RGB (linearize/encode with the same sRGB transfer as R1):

   ```
   linear RGB → LMS:
   | L |   | 0.31399022  0.63951294  0.04649755 | | R |
   | M | = | 0.15537241  0.75789446  0.08670142 | | G |
   | S |   | 0.01775239  0.10944209  0.87256922 | | B |

   protanopia:    L' = 1.05118294·M − 0.05116099·S ;  M' = M ;  S' = S
   deuteranopia:  M' = 0.9513092·L + 0.04866992·S ;  L' = L ;  S' = S
   tritanopia:    S' = −0.86744736·L + 1.86727089·M ;  L' = L ;  M' = M

   LMS → linear RGB:
   | R |   |  5.47221206  −4.6419601   0.16963708 | | L |
   | G | = | −1.1252419    2.29317094 −0.1678952  | | M |
   | B |   |  0.02980165  −0.19318073  1.16364789 | | S |
   ```

   Then, in **each** of the three simulated images, the 24×24gp selection frame (rect from R2) must be detectable as a luminance edge: mean `|ΔL|` (WCAG relative luminance) across the frame's perimeter pixels vs the pixels 2px outside it ≥ **0.15** [rubric-normative]. Because the spec's indicator is a light frame (a luminance/shape cue, §5.1), a conforming build passes; a hue-only recolor (e.g. red vs green slot tint) fails — that is the defect this catches. Apply the same test (all three projections) to the 5-bar ping icon (green→yellow→red, §5.17) on `qa/S11-tablist.png` — colorblind mode must add a shape cue (§4.5: "never rely on hue alone"). **Gated:** the ping-bar half is not scored until a multiplayer server build exists (§1.1 S11).
2. **R6.2 Minimum font size at GUI scale 1.** On `qa/S3-hud-gs1.png` (S=1): bitmap-font line height must render at ≥ **8 px** (8gp line height, §0.5) with ≥ **5 px** cap height [rubric-normative — no cap-height figure exists in UX_SPEC; derived from the §0.5 8gp glyph grid: an 8gp line box leaves ~5–6gp for capitals after ascender/descender rows] and 1 px stems rendered crisp (`image-rendering: pixelated` — glyph edge transition ≤ 1 px, no grayscale smear). Any text rendering below 8 px line height at S=1, or scaled non-integer, fails. Check: hotbar counts, F3 lines, chat (`qa/S3-chat-gs1.png`), tooltip (`qa/S3-tooltip-gs1.png`) — chat and tooltip must be checked at S=1, which is why S3 captures them at gs1 (§1.1).
3. **R6.3 Effect icons distinguishable.** With ≥ 2 active status effects (`qa/S4-effects-none.png` / `qa/S4-effects-deuteranopia.png`, §1.1 — **gated on `/effect`**, PARITY P2 commands): icons are 24×24gp top-right, beneficial top row / harmful row `+26gp` below (§5.8); with `colorblindMode ≠ none` set in settings, each icon must carry a **shape badge** (§4.5, §5.8) — compare the pair: the icon region must differ (badge added; ≥ 3% of the 24×24gp icon rect's pixels change by > 24/255), and the two rows must be positionally separated per spec (row separation is itself a non-hue cue).
4. **R6.4 Subtitles/captions.** Enable `showSubtitles` (Audio §4.4); trigger a positional sound (break a block); evidence `qa/S4-subtitle.png` (§1.1): the subtitle box must appear bottom-right above the hotbar cluster (`dy ≈ −40`, §5.11) with `"<sound name> <arrow>"` including the **direction arrow**, background using `textBackgroundOpacity`. Missing subtitle system = fail.
5. **R6.5 Accessibility screen exists.** `settings.accessibility` reachable from Title (person icon button, §2.1) and Settings root (§4.1), containing at minimum: `highContrast`, `colorblindMode` (none/protanopia/deuteranopia/tritanopia), `damageTilt`, `distortionEffects`, `menuBlur`, `toggleSneak`, `toggleSprint` (§4.5). Presence check from `qa/S1-settings.png` + the screen itself in `qa/S1-accessibility.png` (§1.1).

**Anchors:**
- **5** — selection frame ΔL ≥ 0.15 in all three simulations; all text ≥ 8px at S=1; shape badges + subtitles + accessibility screen all present and functional.
- **3** — indicator passes simulations but marginally (ΔL 0.10–0.15 in the worst projection), or one secondary surface incomplete (e.g. subtitles render without the direction arrow; colorblind LUT applies but badges missing on ping bars only).
- **1** — selection indicator (or any critical state: hearts vs hunger, error text) distinguishable **only** by hue (ΔL < 0.10 in any of the three simulations), text below 8px line height at S=1, or the accessibility screen / colorblind mode / subtitles absent.

---

### R7 — Feedback & affordance (weight 10)

**What:** the UI shows state changes: hover/selection, mining progress, damage.

**Sub-checks & methods (all pixel-diff based — capture a before/after pair per interaction):**

1. **R7.1 Button hover.** `qa/S1-hover-off.png` vs `qa/S1-hover-on.png` (§1.1: cursor at viewport corner vs centered on the `Singleplayer` 200×20 button). The hovered button must brighten and its label shift to `#FFFFA0` (§0.5); diff within the button rect ≥ 5% of its pixels, label color check within distance ≤ 24 of `#FFFFA0`. Disabled buttons (`#4A4A4A` face) must show **no** hover response.
2. **R7.2 Slot hover.** S5 inventory: hovered slot draws `--ui-slot-hover` (`#FFFFFF @ 0.40`, §0.5/§6.0) + tooltip appears. Diff within the 18×18gp slot cell ≥ 10%.
3. **R7.3 Block selection outline.** `qa/S7-outline.png`: black wireframe (`rgba(0,0,0,0.4)`, ~2gp width, §5.7) tracing the targeted block's actual VoxelShape; must vanish when aiming at sky (raycast miss) and under F1. Detect: dark thin edges along the block's projected silhouette present/absent between the two shots.
4. **R7.4 Break-progress overlay.** `qa/S7-break-stage.png` (hold `Mouse0` on stone to ~50% — bare-hand stone is 7.5 s per the PARITY §4.1 formula, so shoot at ~3.7 s): the targeted face must show the crack overlay (destroy_stage ~4–5, dark RGB ≈ 0.15 cracks, ART §5.33). Diff vs the pre-mining reference (`qa/S7-outline.png`, same pose, §1.1) within the face region ≥ 2% of pixels, darker-biased. **Stage scaling (quantified):** crack coverage = count of face-region pixels within max-channel-distance ≤ 24 of the crack color (`RGB ≈ 0.15` → `#262626`); coverage in `qa/S7-break-stage-late.png` (~85%, ~6.4 s) must be ≥ **1.5×** the coverage in the ~50% shot.
5. **R7.5 Damage feedback.** `qa/S4-hurt-burst-*.png` (10 frames while taking damage): (a) heart-row vertical jitter — heart sprite row y-offset varies across frames (template-match the row; positional variance > 0), per §5.4 `dy = random(-2..2)` for ~10 ticks; (b) hearts visibly reduced after the event; (c) hurt flash / damage tilt, **quantified — pass iff at least one of:** (i) **red flash:** on ≥ 1 burst frame, mean red-channel gain over the central 400×400 px (a region that avoids all HUD widgets) ≥ **10%** vs the pre-damage frame (`mean(R_burst) / mean(R_pre) ≥ 1.10`); or (ii) **tilt:** camera roll ≥ **1°** — fit the horizon line (strongest near-horizontal luminance edge across the frame center, e.g. Hough/linear-regression on Sobel edges) in the pre-damage frame vs a burst frame and compare angles. Gated by the `damageTilt` setting (§4.5): with `damageTilt: 0` only path (i) applies.
6. **R7.6 Attack indicator & item-name popup.** With `attackIndicator: Crosshair` (default §4.2), a recovery arc/bar appears below the crosshair (`dy +8gp`) right after an attack. **Measure:** rect `x ∈ [guiVW/2 − 8, guiVW/2 + 8]`, `y ∈ [guiVH/2 + 4, guiVH/2 + 12]` gp (convert ×S); diff `qa/S4-attack-arc-post.png` (≤ 2 frames after `Mouse0`) vs `qa/S4-attack-arc-pre.png`: ≥ **5%** of the rect's pixels must change by > 24/255 in some channel. **Item-name popup** (`qa/S3-itemname.png`, shot ≤ 1 s after `Digit2`): popup centered above the hotbar (rect from R2); **rarity color check:** glyph-mask mode color (R1 step 2) within max-channel-distance ≤ **24** of the §5.13 hex for the selected item's effective rarity — Common `#FFFFFF`, Uncommon `#FFFF55`, Rare `#55FFFF`, Epic `#FF55FF`; fades over ~2 s (§5.13).

**Anchors:**
- **5** — all six sub-checks show the specified visible response in the right place with the specified colors.
- **3** — all core feedback present but ≤ 2 cosmetic misses (e.g. hover brightens but label doesn't turn `#FFFFA0`; cracks render but don't scale with progress; popup not rarity-colored).
- **1** — any of: no selection outline, no break-progress overlay, no damage feedback at all, or hover states entirely absent (UI reads as static image).

---

## 3. Score Sheet Template

### 3.1 Markdown table (paste into the review comment)

```markdown
## UX Review — PR #<n> — <date> — pack: default, 1920×1080@1x

| Id | Criterion | Weight | Score | Worst sub-check | Evidence | Measured vs threshold |
|---|---|---|---|---|---|---|
| R1 | Text readability        | 20 |   |   | qa/…png |   |
| R2 | HUD layout              | 15 |   |   | qa/…png |   |
| R3 | Menu flow friction      | 10 |   |   | qa/…png |   |
| R4 | Palette cohesion        | 15 |   |   | qa/…png |   |
| R5 | World readability       | 15 |   |   | qa/…png |   |
| R6 | Accessibility           | 15 |   |   | qa/…png |   |
| R7 | Feedback & affordance   | 10 |   |   | qa/…png |   |

**Overall:** <x.xx>/5 (<nn>/100) — **PASS/FAIL** (gate: ≥3.00 and no criterion ≤2)
**Bugs filed:** <links, one per criterion ≤2>
```

### 3.2 JSON (attach as `qa/ux-review.json`)

Use the §1.5 envelope verbatim — entries carry exactly `{criterion, score, evidenceScreenshot, note}`.

---

## 4. Worked Example (hypothetical first-playable PR)

Scenario: PR #12 "first playable — walk, break/place, chunks, HUD". QA agent captured the full S1–S10 set at 1920×1080@1x, seed `8675309`, default pack.

| Id | Score | What was measured |
|---|---|---|
| R1 | **2** | Hotbar counts: white glyphs, shadow present, `CR_sh = 10.5:1` ✓. F3 overlay (translucent-strip rule): shadow present, `CR_sh = 10.5:1` ✓ (`CR_bg = 10.6:1` over dark terrain, informational). **Creative tab labels: `#FFFFFF` drawn directly on the `#C6C6C6` panel with NO drop shadow — `CR_bg = 1.71:1`, no `CR_sh` fallback → R1 sub-check in the "1" band ⇒ criterion 2** (rest of text passes, so not a flat 1). Evidence `qa/S5-creative.png`. |
| R2 | **4** | All widgets present at gs1–gs4; hearts at `(guiVW/2−91+8k, guiVH−39)` ±1px ✓; hotbar/XP/hunger exact ✓; offhand frame 4px right of spec (`−116` instead of `−120`) at gs4 only — > 2px but ≤ 8px, single widget ⇒ 4. Evidence `qa/S3-hud-gs4.png`. |
| R3 | **5** | T1 = 3 inputs (Singleplayer + double-click) ✓; T2 = 3 ✓; T3 = 7 ✓; T4 = 2 ✓; Esc symmetric on all six screens; settings returned to its pusher both ways. Evidence `qa/S1-worldselect.png`. |
| R4 | **4** | Lineup medians (top faces): stone H=214° S=0.05 ✓, dirt H=29° ✓, sand H=47° ✓; grass tint present ✓. Pack triplet: `S̄_cartoon = 1.31×S̄_default` ✓, `C_gritty = 1.24×C_default` — misses the 1.3× ratio by < 10% while packs remain clearly distinct ⇒ marginal-inequality case ⇒ 4 (between 5 and 3). Evidence `qa/S9-gritty.png`. |
| R5 | **3** | stone↔cobble ΔE 0.051 ✓; stone↔gravel ΔE 0.048 ✓; cobble↔gravel ΔE 0.031 with std ratio 1.22 — marginal band. Torch gradient monotone, rank-corr 0.96 ✓; static diff 0.1% ✓; no chunk seams ✓; face shades 1.00/0.81/0.62 ✓. ⇒ 3. Evidence `qa/S9-lineup-default.png`. |
| R6 | **4** | Selection frame ΔL: 0.22 (deuteranopia), 0.21 (protanopia), 0.24 (tritanopia) ✓; S=1 line height 8px crisp ✓; accessibility screen present with colorblindMode ✓; R6.3 not scored (`gated:R6.3` — `/effect` not shipped at this milestone); subtitles render **without the direction arrow** — secondary surface incomplete ⇒ 4. Evidence `qa/S4-underwater.png`. |
| R7 | **3** | Hover brightens ✓ but label stays white (no `#FFFFA0`); slot hover + tooltip ✓; outline present, hides on sky ✓; cracks render but identical density at 30% vs 70% progress (no stage scaling); heart jitter variance ✓; attack arc ✓. Two cosmetic misses ⇒ 3. Evidence `qa/S7-break-stage.png`. |

```
overall = (2·20 + 4·15 + 5·10 + 4·15 + 3·15 + 4·15 + 3·10) / 100
        = (40 + 60 + 50 + 60 + 45 + 60 + 30) / 100 = 3.45
normalized100 = (3.45 − 1) / 4 × 100 = 61.3
gate: 3.45 ≥ 3.00 BUT R1 = 2 ⇒ FAIL
```

```json
{
  "rubricVersion": 1,
  "pr": 12,
  "date": "2026-07-11T17:04:12Z",
  "commit": "9f3c2e1",
  "capture": { "viewport": [1920, 1080], "dpr": 1, "seed": "8675309", "pack": "default",
               "packsTested": ["default", "smooth-cartoon", "gritty"], "guiScaleTested": [1, 2, 3, 4] },
  "results": [
    { "criterion": "R1", "score": 2, "evidenceScreenshot": "qa/S5-creative.png",
      "note": "R1.creative-tabs: #FFFFFF on #C6C6C6 CR_bg=1.71:1, no shadow (threshold 4.5:1 or CR_sh>=4.5 with shadow); all other sampled text passes" },
    { "criterion": "R2", "score": 4, "evidenceScreenshot": "qa/S3-hud-gs4.png",
      "note": "offhand frame at gp x=-116 vs spec -120 (4px off, tol 2px) at gs4 only; all else within tolerance, no overlaps" },
    { "criterion": "R3", "score": 5, "evidenceScreenshot": "qa/S1-worldselect.png",
      "note": "T1=3 T2=3 T3=7 T4=2 inputs, all within budget; Esc symmetric; settings returns to pusher" },
    { "criterion": "R4", "score": 4, "evidenceScreenshot": "qa/S9-gritty.png",
      "note": "hues within tolerance; C_gritty=1.24x C_default vs required 1.3x (within 10%); packs visually distinct; hot-swap OK" },
    { "criterion": "R5", "score": 3, "evidenceScreenshot": "qa/S9-lineup-default.png",
      "note": "cobble-gravel dE_OK=0.031 (marginal band 0.02-0.04, std ratio 1.22); lighting/stability/seams/shade all pass" },
    { "criterion": "R6", "score": 4, "evidenceScreenshot": "qa/S4-underwater.png",
      "note": "selection frame dL 0.22/0.21/0.24 under deuteranopia/protanopia/tritanopia (>=0.15); gated:R6.3 (/effect not shipped); subtitles missing direction arrow" },
    { "criterion": "R7", "score": 3, "evidenceScreenshot": "qa/S7-break-stage.png",
      "note": "crack coverage late/mid = 1.1x vs required >=1.5x (no stage scaling); hover label not #FFFFA0; core feedback present" }
  ],
  "overall": { "weightedScore": 3.45, "normalized100": 61.3, "pass": false, "failures": ["R1"] },
  "bugs": ["BUG-31"]
}
```

One bug filed (see §5): `[rubric:R1] Creative-tab labels illegible: white-on-#C6C6C6, CR_bg=1.71:1, no shadow (UX_SPEC §0.5: panel-face text must use --ui-text-panel #404040, or light text must carry its mandatory shadow)`.

---

## 5. Failure Triggers → Bug Filing

- **Any criterion with score ≤ 2 MUST produce a bug** filed per [`docs/BUG_TAXONOMY.md`](./BUG_TAXONOMY.md), before the review is posted.
- **Bug title format:** `[rubric:<Rn>] <one-line defect>` — the rubric criterion id is mandatory so bugs can be joined back to review runs.
- **Bug body must include:** the failing sub-check id, the measured value vs threshold (e.g. `CR_bg=1.71:1 vs ≥4.5:1`), the evidence screenshot path(s), the exact reproduction state (scenario id + capture settings from §1.2), and the spec citation this rubric grounds the threshold in (e.g. `UX_SPEC §0.5`).
- **Severity mapping** (BUG_TAXONOMY's `S0..S3` ladder is the only severity vocabulary — never "release-blocking"/"major"): score **2** ⇒ **S2**. Score **1** ⇒ grade via the BUG_TAXONOMY §2 decision tree with a **floor of S2**; when the anchor-1 defect also blocks a P0 test — e.g. hotbar, crosshair, or F3 missing entirely (PARITY §27 P0 HUD items) — it is **S1** (BUG_TAXONOMY S1-i/S1-l). Crash/data-loss symptoms surfaced by a rubric run still grade **S0** via that tree.
- Scores of 3 with recurring marginal sub-checks across ≥ 2 consecutive review runs should be filed as **S3** polish bugs at the reviewer's discretion (not mandatory).
- **Overall gate:** `overall < 3.00` or any criterion ≤ 2 ⇒ the review verdict is **FAIL** and the PR must not merge on UX grounds until the filed bugs are resolved or explicitly waived by the repo owner.

---

## 6. Reviewer Invariants (read before every run)

1. Never eyeball what §2 gives you a formula for — compute it. Eyeballing is only permitted as a *secondary* sanity check and must be labeled as such in the note.
2. One `evidenceScreenshot` per criterion = the worst sub-check's screenshot. Keep every captured file; the JSON references only the decisive one.
3. Same seed, same pose, same viewport across runs — trend lines matter more than any single score.
4. Re-run R2 and R6.2 whenever `guiScale` code changes; re-run R4/R5 whenever the texture generator or ART_DIRECTION changes; re-run everything on the first playable of each milestone.
5. If a spec doc and this rubric disagree on a **[spec]**-class number (header), the spec doc wins — then fix this rubric in the same PR. **[rubric-normative]** thresholds (the 4.5:1 contrast bar, ΔL 0.15, ΔE_OKLab 0.02/0.03/0.04, ±20° hue tolerance, the 5 px cap-height floor, the 1.2×/0.7×/1.3× pack-identity ratios, the 0.5%/2% temporal budgets, ±2 px layout tolerance) are defined **by this rubric**, deliberately appear in no spec doc, and are NOT voided by spec silence — a builder cannot dismiss them as "not in spec"; changing one requires editing this rubric itself.
