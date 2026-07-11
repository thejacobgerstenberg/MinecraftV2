# INTEGRATION.md — dropping the UI bundle into the voxel game

Ordered, code-verified, **each step individually revertible**. Land the tiers in
order; stop at any tier and the game still runs. Every Tier-2/3 step lists the
exact edit and its one-line revert.

## TL;DR

Components + brand + accessibility + onboarding as **ONE drop-in**. Start with
**Tier 1** (link the brand theme) — an instant contrast/palette lift with **zero
markup change** (measured R1 minimum text-contrast CR **2.70 → 5.21**). Then
adopt widgets one at a time, then fold in the ux-access accessibility pack.

Minimal adopted snippet (after your existing boot creates `ui.*`):

```js
import HudKit from './ui-integrate/integrate.js';

const kit = HudKit.init({ ui, assetBase: './', uxBase: './ux/' });
kit.applyTheme();      // Tier 1 — palette, zero markup
kit.adoptAll();        // Tier 2 — per-widget lf-* adoption
kit.foldUxAccess();    // Tier 3 — keybinds + options + captions + onboarding
// revert everything: kit.dispose();
```

`HudKit.init(opts)` constructs and returns the instance (it does **not**
auto-apply anything). Constructor opts:
`{ root=document, ui, theme='dark', assetBase='./', themeHref, wordmarkHref,
settingsFixHref, uxBase='./ux/' }`.

---

## Prereqs

1. Land or copy the three UI PRs into the game tree:
   - **ui-kit** (#10) → `ui-kit/` at the game repo root (tokens/base/components).
   - **brand** (#9) → brand tokens consumed by `brand-theme.css`.
   - **ux-access** (#17) → `ux/` (four custom elements, vendored read-only here
     at `ui-integrate/vendor-ux/ux/`).
2. Copy into the game tree: `ui-kit/`, and from `ui-integrate/`:
   `integrate.js`, `brand-theme.css`, `settings-shell-fix.css`, plus the `ux/`
   package.
3. **The UI is `three`-free.** Nothing here imports `three`, touches WebGL, or
   registers on the render loop — the four ux elements talk over **window
   CustomEvents** only. Your `three` importmap is unaffected. (Three r160/r185
   compatibility questions are **N/A** — the kit never loads three.)

---

## TIER 1 — palette (highest ROI, zero markup, fully revertible)

The bespoke `public/css/style.css` uses hand-picked hex with **no `--lf-*`
tokens**. Tier 1 links the token layer + brand overlay **after** it, so brand
tokens win by source order with zero specificity fights and **zero markup
change**.

**Option A — static, in `index.html`** (link AFTER `public/css/style.css`):

```html
<link rel="stylesheet" href="public/css/style.css" />
<!-- UI bundle: tokens → base → brand overlay → settings 390w fix -->
<link rel="stylesheet" href="ui-kit/tokens.css" />
<link rel="stylesheet" href="ui-kit/base.css" />
<link rel="stylesheet" href="ui-integrate/brand-theme.css" />
<link rel="stylesheet" href="ui-integrate/settings-shell-fix.css" />
```
Also set `document.documentElement.dataset.theme = 'dark'`.

**Option B — programmatic (recommended, one call):**

```js
const kit = HudKit.init({ ui, assetBase: './' });
const t = kit.applyTheme();   // injects the 4 links (in this order) + data-theme
```
`applyTheme()` (integrate.js L216) links, in order,
`ui-kit/tokens.css` → `ui-kit/base.css` → `brand-theme.css` (resolved
`themeHref`) → `settings-shell-fix.css` (resolved `settingsFixHref`), and sets
`documentElement.dataset.theme`. Order matters: the brand overlay must win, and
the 390w fix is linked LAST so its `@media` beats `settings-shell.css` at equal
specificity.

**Revert:** unlink the four `<link>`s, or `t.revert()` / `kit.removeTheme()`
(integrate.js L236) — removes the injected links and clears `data-theme`.

**Measured lift (MEASURED, not held):** R1 min text-contrast CR **2.70 → 5.21**
(worst case was `.dbg-k` dim text over a translucent panel with no outline),
R1 score **3 → 5**; R4 palette **4 → 5** (every AFTER UI color resolves to a
brand token). See PROOF.

---

## TIER 2 — per-widget lf-* adoption (ordered highest-visibility / lowest-risk)

Each `adopt*()` returns `{ revert() }`, is tracked in `kit._adoptions`, and
no-ops (recorded in `kit.skipped`) if its target element is absent — so partial
adoption is always safe. Call each **after** boot has created the widget on
`ui.*`. The builder init lines below are from the game's `main.js`.

> lf HUD widgets do **not** self-position — the game shell owns HUD layout.
> Place adopted `lf-hotbar`/`lf-statbars`/`lf-chat` exactly where the bespoke
> widgets sat (see FINDINGS #6; `demo.html` shows the anchoring CSS).

| # | Widget | Builder init (main.js) | Adopt call | Revert |
|---|--------|------------------------|------------|--------|
| 1 | Wordmark `#game-title.game-title` | `ui.menus=initMenus` (L357) | `kit.adoptWordmark()` (L347) | `.revert()` restores the text `<h1>` |
| 2 | Crosshair `#hud > .crosshair` | `ui.hud=initHUD` (L392) | `kit.adoptCrosshair()` (L388) | `.revert()` |
| 3 | Hotbar `#hotbar.hotbar > .hb-slot` | `ui.hotbar=initHotbar` (L393) | `kit.adoptHotbar()` (L472) | `.revert()` |
| 4 | Statbars `.health > .shard` (health 0..20) | `ui.hud=initHUD` (L392) | `kit.adoptStatbars({ getHealth })` (L431) | `.revert()` |
| 5 | Debug `#debug.debug > .dbg-line` | `ui.debug=initDebug` (L409) | `kit.adoptDebug()` (L597) | `.revert()` |
| 6 | Chat `#chat.chat > .chat-log` | `ui.chat=initChat` (L394) | `kit.adoptChat()` (L547) | `.revert()` |
| 7 | Inventory `#inventory.inv-overlay > .inv-grid` | `ui.inventoryUI=initInventory` (L400) | `kit.adoptInventory()` (L642) | `.revert()` |
| 8 | Settings rows `.set-row` | `ui.menus=initMenus` (L357) | `kit.adoptSettings()` (L712) | `.revert()` |
| 9 | Main menu `#menu-root` | `ui.menus=initMenus` (L357) | `kit.adoptMainMenu()` (L753) | `.revert()` |

Example (step 3), right after `ui.hotbar = initHotbar(...)` at L393:

```js
const hb = kit.adoptHotbar();   // upgrades #hotbar .hb-slot -> lf styling
// later, to back out just this widget:  hb.revert();
```

`adoptStatbars` takes `{ getHealth }` returning current health on a **0..20**
scale (matches the HUD's `.shard--full/--half/--empty`; there is no hunger/armor
bar). `adoptAll(list?)` runs steps 1–9 (optionally a subset); `revertAll()`
backs them all out; `dispose()` reverts theme + every adoption.

---

## TIER 3 — accessibility + onboarding fold (numbered, revertible)

The ux-access pack is four `define()`-registered custom elements wired **only**
over window CustomEvents (no three, no audio import). `kit.foldUxAccess({uxBase})`
= `applyTheme()` + the four adopts below. Each sub-adopt is independently
revertible.

### 3.1 — Accessibility settings (`adoptAccessibilitySettings`, L818)

```js
kit.adoptAccessibilitySettings({ uxBase: './ux/' });
```
Mounts `<lf-settings-shell>` with
`<section data-category="Controls"><lf-keybinds></section>` (27 actions in 4
groups from `bindings.default.json`, persisted to `localStorage['loomfall.bindings']`,
emits window `lf-bindings-change`) and
`<section data-category="Accessibility" data-ux-access-dock><lf-access-options></section>`.

`<lf-access-options>` + `OptionsStore` persist to `localStorage['loomfall.settings']`
(`STORAGE_KEY`), emit window `lf-options-change` `{key,value,options}` (`CHANGE_EVENT`),
and on change set `html[data-lf-cvd]`, `html[data-lf-reduced-motion]`, and
`--lf-ui-scale`. DEFAULTS cover colorblindMode / uiScale / fov / reducedMotion /
volumes / subtitles / difficulty.

**Wire into the game:** the store already **shares** `loomfall.settings` with the
game's `menu.js` `SETTINGS_SPEC` (flattens `volumes.* → volumeMaster/Sfx/Music`,
`fov → fov`, preserves other keys) — so it is one source of truth. Additionally
subscribe to push volumes into the engine:

```js
window.addEventListener('lf-options-change', (e) => {
  const o = e.detail.options;
  GameAudio.setVolumes({ master: o.volumes.master, sfx: o.volumes.sfx, music: o.volumes.music });
});
```
Setting `subtitles === false` **unmounts** the caption layer automatically.

**Revert:** the returned `{revert()}` (or `dispose()`).

### 3.2 — Captions (`adoptCaptions`, L922)

```js
kit.adoptCaptions({ uxBase: './ux/', corner: 'bottom-right' });
```
Mounts `<lf-captions>` (`captions.json` — 43 entries → 66 audio keys via
wildcards). It **self-subscribes** on connect to window `lf-audio-event`
`{name, direction?, volume?, loop?, ended?}` — there is **no `attach()`**.
Directional chevrons: `◀` left, `▶` right, `▲` front, `▼` behind.

**REQUIRED builder change (FINDINGS #1, HIGH):** the builder's `GameAudio` must
dispatch `lf-audio-event` **per `engine.play`** — without it the caption layer
stays silent. Exact bridge:

```js
// in GameAudio, once per sound played:
function emitCaption(name, soundPos /* THREE.Vector3|null */, opts = {}) {
  let direction = null;
  if (soundPos) {
    // direction from sound position vs. the listener set via setListener(pos, forward)
    const v = soundPos.clone().sub(listenerPos);
    const fwd = listenerForward;                 // normalized
    const right = new THREE.Vector3().crossVectors(fwd, listenerUp).normalize();
    const f = v.dot(fwd), r = v.dot(right);
    direction = Math.abs(r) > Math.abs(f)
      ? (r > 0 ? 'right' : 'left')
      : (f >= 0 ? 'front' : 'behind');
  }
  window.dispatchEvent(new CustomEvent('lf-audio-event', {
    detail: { name, direction, volume: opts.volume, loop: opts.loop }
  }));
}

// engine.play(sfxName, pos):     emitCaption(sfxName, pos);
// engine.startMusic(mode):       emitCaption('music.' + mode, null, { loop: true });
// on a looping sound stopping:    window.dispatchEvent(new CustomEvent('lf-audio-event',
//                                   { detail: { name, ended: true } }));
```
(Or, from a test/host with no `three`, use the static bridge
`HudKit.emitAudioEvent(detail)` at L1078.)

**Revert:** returned `{revert()}` unmounts `<lf-captions>`.

### 3.3 — Onboarding (`adoptOnboarding`, L962)

```js
kit.adoptOnboarding({ uxBase: './ux/', autostart: true });
kit.tagHudAnchors();   // stamps data-lf-anchor on the HUD (see below)
```
Mounts `<lf-tutorial>` (`tutorial.json` — 22 beats). Each beat anchors a
coach-mark via `document.querySelector('[data-lf-anchor="<id>"]')` and is
**gated** by window `lf-game-event` `{type}` matching `beat.gateEvent` **or**
`beat.id`. `tutorial.json` uses the **`on_` prefix** (e.g.
`on_first_block_broken`) — see FINDINGS #5.

`tagHudAnchors(map?)` (L997) stamps `data-lf-anchor` on:
`hotbar`, `healthbar`, `crosshair`, `chat`, `debug`, `inventory-button`
(reserved vocabulary also includes `hungerbar`, `statbars`, `pause-button`,
`deathscreen-respawn`, `settings-button`). Beats substitute `[MOVE]`/`[BREAK]`/…
from the current bindings.

**Wire into the game:** dispatch progression as window events, e.g.:

```js
window.dispatchEvent(new CustomEvent('lf-game-event', { detail: { type: 'on_first_block_broken' } }));
// or via the static bridge:  HudKit.emitGameEvent('on_first_block_broken');  // L1091
```

**Revert:** returned `{revert()}` unmounts the tutorial; `tagHudAnchors` returns
a revert that strips the stamped attributes.

### 3.4 — 390w settings breakpoint (already linked by `applyTheme`)

`settings-shell.css` (ui-kit) has **no** narrow-width breakpoint: the rail is
pinned `flex: 0 0 168px`, so the pane collapses to ~124px at 390w.
`settings-shell-fix.css` ships an `@media (max-width: 440px)` that stacks the
rail; `applyTheme()` already links it LAST. **Verified:** at 390w the pane goes
**124px → 308px** and the dropdown **101px → 285px**. This is a **ui-kit
follow-up** — upstream should fold the `@media` into `settings-shell.css`
(FINDINGS #2).

---

## PROOF

Both proofs run **headless with 0 console errors against the builder's REAL HUD
modules + the genuine ux-access package**. Serve with `node ui-integrate/server.mjs`
(→ http://localhost:8129/).

### `demo.html` — before/after HUD, rubric on rendered pixels

`rubric.js` computes scores on **rendered pixels**: exact WCAG contrast +
Vienot-Brettel-Mollon colorblind math.

| Criterion | Before | After | Note |
|-----------|:-----:|:-----:|------|
| R1 text contrast | 3 | 5 | **MEASURED** — min CR 2.70 → 5.21 |
| R2 widget layout | 4 | 4 | HELD (baseline; not moved by a restyle) |
| R3 | 5 | 5 | HELD |
| R4 palette | 4 | 5 | **MEASURED** — all AFTER colors → brand tokens |
| R5 | 3 | 3 | HELD |
| R6 colorblind | pass | pass | **MEASURED** — mean \|dL\| 0.842 / 0.743 |
| R7 | 3 | 3 | HELD |
| **Overall** `Σ(weight×score)/100` | **3.80** | **4.35** | both clear the gate (≥3.00, no criterion ≤2) |

Screenshots: `docs/screenshots/before.png`, `docs/screenshots/after.png`.

### `accessibility.html` — ux-access fold

All four ux elements registered + mounted; settings-shell shows **Controls**
(`lf-keybinds`, 27 rows) + **Accessibility** (`lf-access-options`); caption
**`◀ Thunder cracks!`** after `emitAudioEvent({ name: 'thunder', direction: 'left' })`;
coach-mark lands on the crosshair after `emitGameEvent('on_first_block_broken')`;
setting colorblindMode stamps `html[data-lf-cvd]=deuteranopia`; at 390w the rail
stacks. Screenshots: `docs/screenshots/accessibility.png`,
`docs/screenshots/settings-390.png`.

---

## Appendix — the window-event bus

| Event | Direction | Payload | Purpose |
|-------|-----------|---------|---------|
| `lf-audio-event` | builder → captions | `{name, direction?, volume?, loop?, ended?}` | drives `<lf-captions>` (builder MUST emit, per `engine.play`) |
| `lf-game-event` | builder → onboarding | `{type}` (`on_…`) | gates `<lf-tutorial>` beats |
| `lf-options-change` | options → builder | `{key, value, options}` | accessibility/volume changes |
| `lf-bindings-change` | keybinds → builder | bindings map | rebound controls |

Static bridges: `HudKit.emitAudioEvent(detail)` (L1078),
`HudKit.emitGameEvent(type)` (L1091).

**Anchor vocabulary** (`data-lf-anchor`): `hotbar`, `healthbar`, `hungerbar`,
`statbars`, `crosshair`, `chat`, `inventory-button`, `pause-button`, `debug`,
`deathscreen-respawn`, `settings-button`.

**localStorage keys:** `loomfall.settings` (OptionsStore ⇄ `menu.js`
SETTINGS_SPEC), `loomfall.bindings` (lf-keybinds).
