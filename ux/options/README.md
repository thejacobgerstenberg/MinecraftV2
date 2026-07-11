# Loomfall UX — Options & Accessibility (`ux/options/`)

Owner: **options builder** (LOOMFALL UX-ACCESS ARCHITECTURE CONTRACT v1, §1).
Data shape is normative in `ux/schemas/options.schema.json` (architect-owned).

## Files

| File | What it is |
| --- | --- |
| `options-store.js` | The propagation runtime (contract §5). Every demo/shell imports it; exports `OptionsStore`, `getStore()`, `DEFAULTS`, `motionReduced()`, `STORAGE_KEY`, `CHANGE_EVENT`. |
| `access-options.js` | `<lf-access-options>` — the panel element. Composes kit `lf-slider`/`lf-toggle`/`lf-dropdown`; docks into `<lf-settings-shell>` as a `<section data-category>` body. |
| `access-options.css` | Panel layout (tokens only). |
| `cvd.css` | Colorblind-mode token overrides, scoped `html[data-lf-cvd="<mode>"]` (+ light-theme blocks). **Canonical file** per contract §5. |
| `colorblind.css` | One-line `@import` alias of `cvd.css` for shells wired to the older name. Never diverges. |
| `motion.css` | Reduced-motion force-on collapse, opt-out rules, and the authoring pattern every `ux/` animation must follow. |
| `demo.html` / `demo.css` | Demo page: panel in the shell + live JSON + reacting samples + §4 simulation buttons. |

## Runtime contract (what the store does on load and on every commit)

1. `document.documentElement.dataset`:
   - `data-lf-cvd="<mode>"` when `colorblindMode != "none"` (removed when none).
   - `data-lf-reduced-motion="on"|"off"` when `reducedMotion != "system"` (removed when system).
   - Legacy mirrors `data-colorblind` / `data-reduced-motion` are set alongside
     (some earlier shell notes used those names); **`data-lf-*` is canonical** —
     all CSS in this directory targets only the canonical attributes.
   - `data-theme` is never touched.
2. `--lf-ui-scale` custom property on `<html>` **and** `font-size: calc(16px * var(--lf-ui-scale))`,
   so every rem-derived dimension scales. (Kit-internal px tokens do not scale;
   game-shell HUD chrome should derive sizes in rem — see the demo's rem card.)
3. `window.dispatchEvent(new CustomEvent("lf-options-change", { detail: { key, value, options } }))`
   — `key` is the dot-path (`"volumes.music"`), `key: null` on load/reset (§4 shape, additive only).
4. Persists into localStorage **`loomfall.settings`**, merged (unrelated keys such as
   `renderDistance`, `sensitivity`, `texturePack` are preserved). Flat mapping:
   `volumes.master→volumeMaster`, `volumes.sfx→volumeSfx`, `volumes.music→volumeMusic`,
   `fov→fov` — exactly the keys `GameAudio.setVolumes(settings)` and `menu.js`
   SETTINGS_SPEC already read.

Usage:

```js
import { getStore, motionReduced } from './ux/options/options-store.js';
const store = getStore();          // applies persisted options immediately
store.set('volumes.music', 0.5);   // clamp → apply → persist → dispatch
store.preview('uiScale', 1.2);     // visual-only (slider lf-input live preview)
store.reset();
```

The store auto-`<link>`s `cvd.css` + `motion.css` next to itself (deduped against
already-present links); pass `{ loadCss: false }` to manage stylesheets manually.

## `<lf-access-options>`

Controls (all schema dot-paths): `colorblindMode` (dropdown), `uiScale`
(slider 0.75–1.5 ×, live preview on `lf-input`), `fov` (slider 60–110°),
`reducedMotion` (dropdown `system|on|off` — the schema is tri-state, which
supersedes the originally sketched on/off toggle), `volumes.master|sfx|music`
(sliders rendered 0–100 %, stored 0–1), `subtitles` (toggle), `difficulty`
(dropdown with flavor line, `aria-live="polite"`).

Events: composed kit widgets bubble `lf-change` untouched (so
`lf-settings-shell`'s generic persistence hook still works); commits surface as
window `lf-options-change` from the store. The panel re-syncs from every
`lf-options-change`, so multiple mounts stay coherent. Assignable `store`
property for isolated shells/tests.

## Colorblind modes (`cvd.css`)

Only **meaning-bearing accents** shift (status, rarity edges, stat fills);
brand neutrals (gold CTAs, violet panels, muslin text, dimension ramps) are
untouched. Every value is a `var()` re-mapping of an existing `tokens.css`
token — no raw hex. Shape glyphs remain the primary channel; these overrides
widen hue/lightness separation.

Kept in **all** modes: `--lf-accent-knotlight` (selection frame) and
`--lf-color-focus-ring` — high-luminance golds; selection/focus are carried by
a luminance frame + stitched notch (shape), legible to all three types. The
`--lf-status-*` aliases resolve automatically (they are `var(--lf-color-*)`
references on the same element).

| Token (dark theme) | deuteranopia | protanopia | tritanopia |
| --- | --- | --- | --- |
| `--lf-color-success` | `--lf-accent-hemstone-cyan` | `--lf-accent-hemstone-cyan` | — |
| `--lf-color-error` | `--lf-ramp-cinderloom-5` | `--lf-ramp-cinderloom-5` | — |
| `--lf-color-warn` | — | — | `--lf-accent-weld` |
| `--lf-color-info` | `--lf-brand-secondary-lift` | `--lf-brand-secondary-lift` | `--lf-brand-primary-pale` |
| `--lf-accent-warp-green` (uncommon rarity) | `--lf-accent-dye-indigo` | `--lf-accent-dye-indigo` | — |
| `--lf-accent-hemstone-cyan` (rare rarity, armor pips) | — | — | `--lf-brand-secondary-lift` |
| `--lf-accent-madder` (health pips) | — | `--lf-ramp-cinderloom-5` | — |

Rationale (dark): deutan/protan lose red↔green, so *success* moves to the
intact blue axis (cyan, 8.8:1 on panel), *error* stays alarming-warm but drops
a full lightness step below warn gold (cinder orange, 5.2:1), *info* moves to
lavender to free the light-blue band (5.6:1). Protan additionally brightens the
health-pip madder (deep reds go near-black for protans). Tritan loses
blue↔yellow: *info* leaves the collapsing blue axis entirely (pale thread,
14:1), *warn* drops to weld so warn/error separate by lightness, and the cyan
accent (the classic tritan casualty) becomes lavender.

Light theme: each mode has a `[data-theme="light"]` block (html-level and
subtree). Values not re-declared there are explicitly **reset** to the
`--lf-pair-light-*-fg` tokens so a dark-tuned accent never lands on parchment.
Documented residuals (disambiguated by glyph shape): deutan-light info vs
success are both blues; tritan rare-lavender sits near epic gold (the epic
double-stitch edge pattern differs).

Audited residual — health pips: the madder fill body vs the empty socket
measures ΔL 0.115 under tritanopia mode (and 0.094 protan-projected when no
CVD mode is set). Legibility is carried by the pip's muslin seam stroke
(pixel-edge ΔL 0.76 in all CVD projections) and, for protanopia, by this
file's `--lf-accent-madder` → `--lf-ramp-cinderloom-5` remap (ΔL 0.245).
This matches the shipped ui-kit baseline (r3 analytic 0.1225); no token
change required.

## Reduced motion (`motion.css` + `motionReduced()`)

- `system` → no attribute; `base.css`'s `@media (prefers-reduced-motion: reduce)` collapse applies.
- `on` → `html[data-lf-reduced-motion="on"]` forces the same collapse (mirrored rule in `motion.css`).
- `off` → opt-out: transitions are globally restored to token timing; keyframe
  animations must opt back in per-animation (base.css's `!important` collapse
  cannot be un-set generically) using the triple pattern documented at the top
  of `motion.css` — base rule, media-reduce `animation: none`, forced-off
  restatement with `!important`. `demo.css`'s bob/shake are reference implementations.

**Game shake / particles rule (binding on the game shell):** JS-driven motion
(screen shake, particle bursts, camera bob, block-break jitter) must consult
`motionReduced()` before triggering, and re-check on every `lf-options-change`.
When true: no shake, no particle spawns; damage feedback falls back to the
statbars flash + hurt-overlay opacity step.

## Demo

Serve from the repo root (`python3 -m http.server`) and open
`http://localhost:8000/ux/options/demo.html`. Zero build, zero network.
Left: the panel inside `lf-settings-shell`. Right: live options JSON,
FOV wireframe (live while dragging), rem-sized UI-scale card, motion samples
(bob loop, shake card, statbars damage flash), status toasts + rarity/selection
item slots (react to colorblind mode), a subtitles-overlay mock, and §4
simulation buttons + an `lf-options-change` log.
