# ui-integrate — the UI drop-in bundle

Upgrades the builder's bespoke voxel-game UI to **components + brand +
accessibility + onboarding** as **one drop-in**. It links a token/brand theme
over the existing `public/css/style.css` (zero markup change), swaps each HUD
widget for its `lf-*` component on demand, and folds in the ux-access pack
(keybinds, accessibility options, captions, onboarding) — all wired over window
CustomEvents, with **no `three` dependency**.

## Quick start

```bash
node ui-integrate/server.mjs        # zero-dep static server -> http://localhost:8129/
```

- **`demo.html`** — before/after HUD, with `rubric.js` scoring the **rendered
  pixels** (exact WCAG contrast + Vienot-Brettel-Mollon colorblind math).
- **`accessibility.html`** — the ux-access fold: keybinds + options settings
  shell, a directional caption, a coach-mark, colorblind mode, and the 390w
  breakpoint.

Both pages run **headless with 0 console errors against the builder's real HUD
modules + the genuine ux-access package**.

## What it contains

| Path | What |
|------|------|
| `integrate.js` | `HudKit` (default export) — the three-tier adoption API |
| `brand-theme.css` | brand-token overlay linked after the game's stylesheet |
| `settings-shell-fix.css` | 390w breakpoint overlay for `settings-shell.css` |
| `vendor-game/` | read-only genuine copy of the builder's HUD modules + brand |
| `vendor-ux/` | read-only genuine copy of the ux-access package (`ux/`) |
| `demo.html` | before/after HUD proof |
| `accessibility.html` | ux-access fold proof |
| `rubric.js` | pixel-level rubric scorer (WCAG + colorblind math) |
| `server.mjs` | zero-dep static server (port 8129) |
| `docs/screenshots/` | `before.png`, `after.png`, `accessibility.png`, `settings-390.png` |

## The HudKit API — three tiers

```js
import HudKit from './ui-integrate/integrate.js';
const kit = HudKit.init({ ui, assetBase: './', uxBase: './ux/' });
```

- **Tier 1 — palette (zero markup):** `applyTheme()` injects
  `ui-kit/tokens.css` → `ui-kit/base.css` → `brand-theme.css` →
  `settings-shell-fix.css` and sets `data-theme`. `removeTheme()` reverts.
- **Tier 2 — per-widget adoption:** `adoptWordmark`, `adoptCrosshair`,
  `adoptStatbars({getHealth})`, `adoptHotbar`, `adoptChat`, `adoptDebug`,
  `adoptInventory`, `adoptSettings`, `adoptMainMenu` — each returns
  `{revert()}`. `adoptAll(list?)`, `revertAll()`, `dispose()`.
- **Tier 3 — accessibility + onboarding fold:**
  `adoptAccessibilitySettings`, `adoptCaptions`, `adoptOnboarding`,
  `tagHudAnchors`, and `foldUxAccess()` (= `applyTheme` + the four). Static
  bridges `HudKit.emitAudioEvent(detail)` / `HudKit.emitGameEvent(type)`.

Every adopt is **individually revertible**; missing targets no-op (recorded in
`kit.skipped`). See **[INTEGRATION.md](./INTEGRATION.md)** for the ordered,
step-by-step, revertible checklist and **[FINDINGS.md](./FINDINGS.md)** for the
severity/owner TODO table.

## The ux-access fold + the audio-bus contract

The pack is four `define()`-registered custom elements talking over window
CustomEvents: `<lf-keybinds>` (27 actions, persists `loomfall.bindings`, emits
`lf-bindings-change`), `<lf-access-options>` + `OptionsStore` (shares
`loomfall.settings`, emits `lf-options-change`, stamps `html[data-lf-cvd]` etc.),
`<lf-captions>` (43 entries → 66 keys), and `<lf-tutorial>` (22 beats, gated by
`lf-game-event`).

**Audio-bus contract (see FINDINGS #1, HIGH):** `<lf-captions>` **self-subscribes**
to window `lf-audio-event` `{name, direction?, volume?, loop?, ended?}` — there
is no `attach()`. The **builder's `GameAudio` must dispatch this event per
`engine.play`** (compute `direction` from sound pos vs. the listener;
`startMusic → music.<mode>`; looping stop emits `{name, ended:true}`), or the
caption layer stays silent. Exact code in INTEGRATION §3.2.

## The measured rubric result

`rubric.js` scores rendered pixels. On the **real current HUD**:
**BEFORE 3.80 → AFTER 4.35** (both clear the gate ≥3.00, no criterion ≤2).
The lift is MEASURED on **R1** text contrast (min CR **2.70 → 5.21**, score
3 → 5) and **R4** palette (4 → 5, all AFTER colors resolve to brand tokens);
**R6** colorblind passes both. **R2/R3/R5/R7 are HELD** (not moved by a restyle).

## On the baseline (no 2.60/5 doc exists)

There is **no 2.60/5 document anywhere in the repo** (searched all branches).
The only committed scorecard is the rubric's worked-example **3.45/5 FAIL**
(R1=2 from `#FFFFFF` on `#C6C6C6` creative tabs). The bundle's authoritative
figure is the pixel-measured real-HUD result: **3.80 → 4.35**. The UI kit is
`three`-free, so three r160/r185 compatibility questions are **N/A**.
