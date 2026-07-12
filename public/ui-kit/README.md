# Loomfall UI Kit

Framework-free custom elements (`<lf-*>`) for the Loomfall game shell: menus, HUD,
containers and form widgets, all styled exclusively from the brand palette and built
with accessibility as a hard requirement — not a follow-up.

## 1. What this is

- **Design tokens, not hex.** Every color in the kit comes from
  [`tokens.css`](tokens.css), which is **generated from `brand/palette.json`**
  ("Light Through the Warp"). Component CSS only ever says `var(--lf-*)`. If a color
  looks wrong, fix the palette and regenerate — never patch a component with a raw hex.
- **Framework-free.** Vanilla Web Components (light DOM) + plain CSS. No React/Vue,
  no CDNs, no webfonts, no build step. ES modules that run directly in evergreen
  browsers and embed in the game's shell.
- **Light DOM by design.** Components render real children (no shadow roots) so the
  shell's theme cascades in, screenshot tooling can locate parts by class, and
  `image-rendering: pixelated` rules apply naturally. Collision safety comes from
  naming: elements are `lf-*`, classes are `lf-*`, custom properties are `--lf-*`.
- **A11y baked in.** Keyboard-navigable everywhere (roving tabindex in composite
  widgets), token-colored `:focus-visible` rings, ARIA roles/names/live-regions wired
  by the components, and **no hue-only indicators** — every status/selection cue pairs
  color with a shape, position, pattern, or luminance cue (survives protanopia,
  deuteranopia, and tritanopia).
- **State = attributes.** Component state is reflected as host attributes
  (`disabled`, `checked`, `selected`, `open`, `error`, `value`...), so CSS targets
  `lf-button[disabled]` and the game can drive components declaratively.
- **Events = `lf-*` CustomEvents.** Everything the user does surfaces as a bubbling
  `CustomEvent` (`lf-action`, `lf-change`, `lf-select`, ...) with a `detail` payload.

## 2. Quick start

```html
<!-- 1. Tokens first, then base, then the CSS for each component you use -->
<link rel="stylesheet" href="ui-kit/tokens.css">
<link rel="stylesheet" href="ui-kit/base.css">
<link rel="stylesheet" href="ui-kit/components/button.css">
<link rel="stylesheet" href="ui-kit/components/hotbar.css">
<link rel="stylesheet" href="ui-kit/components/inventory.css"><!-- hotbar uses lf-item-slot -->

<!-- 2. Import the modules you need; each registers its element(s) on import -->
<script type="module">
  import 'ui-kit/components/button.js';
  import 'ui-kit/components/hotbar.js';   // also registers <lf-item-slot>
</script>

<!-- 3. Use them -->
<lf-button variant="primary" action="create">Create World</lf-button>
<lf-hotbar selected="0" global-keys>
  <lf-item-slot item="Warpstone" count="12"></lf-item-slot>
  <!-- ...padded to 9 slots -->
</lf-hotbar>
```

**Registration.** Importing a component module registers it via `define()`
(idempotent — safe to import twice). Composite components import their JS
dependencies themselves (`settings-shell.js` pulls in `slider/toggle/dropdown/button`,
`world-select.js` pulls in `button/modal`, `hotbar.js` pulls in `inventory.js`), but
**CSS is not auto-loaded** — link the `.css` file for every element that ends up on
the page, including composed ones.

**Theming.** Dark is the default (`:root`). Opt into light with
`data-theme="light"` on `<html>` — or on any subtree; tokens re-resolve locally:

```js
document.documentElement.dataset.theme = 'light'; // and back to 'dark'
```

Both themes come from WCAG-verified pairs in `palette.json`. Tooltips stay a dark
loom-room card in both themes; the primary CTA is Everthread gold with a void-ink
label in both themes. `color-scheme` is set per theme so native controls follow.

**Foundation module.** `lf-core.js` exports `LFElement` (base class),
`RovingTabindex` (arrow-key nav helper), `define`, `emit`, `uid`, `clamp` — useful if
the game adds its own `lf-*` element.

## 3. Component reference

All events bubble and carry payloads on `event.detail`. Attributes marked *(refl.)*
are reflected and mirrored by a JS property of the same (camelCased) name.

| Element | Key attributes | Events | Keyboard |
|---|---|---|---|
| `<lf-button>` | `variant` `primary\|secondary\|danger`, `size` `md\|sm\|icon` (icon requires `aria-label`), `disabled`, `loading`, `action` | `lf-action` `{action}` | Native button: Enter/Space activate; disabled unfocusable |
| `<lf-toggle>` | `label`, `checked` *(refl.)*, `disabled` | `lf-change` `{value:boolean}` | Enter/Space toggle (native `role="switch"`) |
| `<lf-slider>` | `label`, `min`, `max`, `step`, `value` *(refl.)*, `unit`, `disabled` | `lf-input` (live), `lf-change` (commit) `{value:number}` | Native range: Arrows, Home/End, PageUp/PageDown |
| `<lf-input>` | `label`, `value` *(refl.)*, `placeholder`, `type`, `maxlength`, `hint`, `error` (message; presence = error state), `disabled` | `lf-input` (keystroke), `lf-change` (commit) `{value}` | Native text input |
| `<lf-dropdown>` | `label`, `value` *(refl.)*, `open` *(refl.)*, `disabled`; options as native `<option>` children | `lf-open`, `lf-close`, `lf-select` `{value,index}`, `lf-change` `{value}` | Enter/Space/Arrows open + focus selection; Arrows rove (skip disabled); Enter/Space select; Esc closes, focus returns to trigger |
| `<lf-tabs>` | `selected` *(refl., index)*, `label`; panels = children with `data-tab-label` (+ optional `data-tab-disabled`) | `lf-select` `{value,index}` | Left/Right rove (wrap), Home/End, Enter/Space activate (manual activation) |
| `<lf-modal>` | `open` *(refl.)*, `heading`, `confirm-label`, `cancel-label` (required for destructive flows), `danger`, `static`; methods `open()`/`close()` | `lf-close` (cancelable, `{reason}`), `lf-action` `{action:'confirm'\|'cancel'}` | Esc closes (one level), Tab/Shift+Tab focus-trapped, focus restored to invoker |
| `<lf-tooltip>` | `text`, `placement` `top\|bottom\|left\|right`, `open` *(refl.)*; wrap the trigger element | `lf-open`, `lf-close` | Shows on hover **and** focus; Esc hides (without popping screens) |
| `<lf-toast>` | `status` `info\|success\|warn\|error` (each pairs color with its glyph: droplet / stitch-check / fray-knot / frayed-X), `heading`, `message`, `duration` (0 = sticky; pauses on hover/focus); method `dismiss()` | `lf-dismiss` `{reason}` | Dismiss button is a real button; error = `role="alert"` |
| `<lf-toast-rack>` | `static`; method `show({status,heading,message,duration})` → `lf-toast` | (from child toasts) | Max 3 visible, overflow queues; polite live region |
| `<lf-progress>` | `value`, `max`, `label`, `show-value`, `indeterminate` | (output-only) | — (`role="progressbar"` with value ARIA) |
| `<lf-item-slot>` | `item` (absent = empty), `count` (shown only > 1), `rarity` `common\|uncommon\|rare\|epic` (color + solid/dashed/double-stitch pattern), `swatch` (ramp-token icon), `durability` 0..1, `selected`, `held`, `disabled`, `label` | `lf-select` `{value}` | Inner button; containers add roving nav |
| `<lf-inventory-grid>` | `columns` (default 9), `label` | `lf-move` `{from,to}`, `lf-select` `{index,value}`, `lf-close` (Esc, nothing held) | Arrows/Home/End rove (grid-aware, skips disabled); Enter/Space pick up → place/swap; Esc cancels pickup; moves announced to a live region. Pointer: drag or click-click |
| `<lf-hotbar>` | `selected` 0..8 *(refl.)*, `global-keys` (window-level Digit1-9, ignored while typing), `show-label`, `label` | `lf-select` `{index,value}` | Arrows rove, Enter/Space select, 1–9 direct, mouse wheel cycles (wraps) |
| `<lf-statbars>` | `health`/`health-max`, `armor`/`armor-max` (row renders only when armor > 0), `hunger`/`hunger-max`, `damaged` (flash), `low` (auto ≤ 30%: pulse + fray-knot triangle) | (display-only) | — (`role="status"` with hidden "Health 14 of 20…" text) |
| `<lf-crosshair>` | `variant` `cross\|dot\|circle\|tee\|chevron`, `fixed` (viewport-centered game mode), `hidden` | (display-only) | — (aria-hidden, `mix-blend-mode: difference`) |
| `<lf-chat>` | `open` *(refl.)*, `scrollback` (default 50), `no-timestamps`; seed lines as `<p data-name data-time>` / `<p data-system>`; API `open()/close()/isOpen()/addMessage()` | `lf-send` `{text}` (no local echo), `lf-open`, `lf-close` (cancelable) | Enter sends; Esc blurs input first (text-entry context), then closes |
| `<lf-debug-overlay>` | `open` *(refl.)*, `static`, `sections` (`perf loc sys`), `data-<key>` seed values; API `toggle()/setVisible()/setData()/toggleSection()` | (read-only) | — (aria-hidden dev readout; F3 handled by shell) |
| `<lf-main-menu>` | `version`, `splash`, `multiplayer-disabled`, `static` | `lf-action` `{action:'singleplayer'\|'multiplayer'\|'settings'\|'quit'\|'accessibility'}` | Tab order through buttons; Esc is a no-op (stack root) |
| `<lf-pause-menu>` | `open` *(refl.)*, `heading`, `static`; API `show()/close()` | `lf-action` `{action:'resume'\|'advancements'\|'statistics'\|'settings'\|'quit'}`, `lf-back` (Esc) | Esc pops exactly one level; Tab through buttons |
| `<lf-world-select>` / `<lf-world-card>` | card: `name`, `mode`, `played`, `ramp` `warpwold\|cinderloom\|nevermend`, `selected`; list: `label` | `lf-select` `{value,index}`, `lf-action` `{action:'play'\|'edit'\|'delete', world, index}` (`delete` only after modal confirm), `lf-back` | Tab enters list (one stop); Up/Down move + select, Home/End, Enter/Space play, Delete → confirm modal, Esc back |
| `<lf-settings-shell>` | `heading`, `active` *(refl., category slug)*; panels = `<section data-category="Name">` children of composed widgets | `lf-select` `{value,index}`, `lf-change` (bubbled from widgets — persist settings generically), `lf-back` (Done/Esc) | Rail: Up/Down rove, Home/End, Enter/Space activate; Esc = back (open dropdowns swallow their own Esc first) |

Gallery-only conveniences: `data-demo-hover` / `data-demo-active` force hover/pressed
looks for static screenshots, and `static` renders full-viewport components in-flow.
Never ship either in game markup.

## 4. Integration map (builder branch `feat/voxel-sandbox-game`)

The game's current UI lives in `public/src/ui/*` — framework-free DOM modules wired
in `public/src/main.js` (init calls around lines 204–239 into the shared `ui`
object). The kit replaces each module's **DOM rendering** while keeping its **init
signature and callback contract**, so `main.js` wiring barely changes. General
recipe: inside `init*()`, mount the `lf-*` element instead of building divs, translate
the module's setter API onto attributes, and forward `lf-*` events into the existing
callbacks.

| Kit component | Builder module | How it docks |
|---|---|---|
| `<lf-hotbar>` + `<lf-item-slot>` | `public/src/ui/hotbar.js` | Replace the `#hotbar` / `.hb-slot` DOM render; keep `initHotbar({container, iconFor})` and its `{setSlots(ids[9]), setSelected(i)}` API. `setSlots` maps ids → slot `item`/icon (feed `iconFor(blockId)` canvases into slots; call `iconFor.invalidate()` from `icons.js` after texture-pack hot-swap); `setSelected(i)` → `selected` attribute. `lf-select` replaces the click handling; the built-in fading name popup replaces `.hotbar-label`. Enable `global-keys` for Digit1–9. |
| `<lf-inventory-grid>` + `<lf-item-slot>` | `public/src/ui/inventory.js` | Replace `.inv-grid` of `<button class="inv-slot">` inside the `#inventory` overlay panel; keep `initInventory({onPick, iconFor})` and `{toggle, open, close, isOpen, setBlocks}`. `setBlocks(ids)` → regenerate slot children; `lf-select` `{index,value}` → `onPick(id)`; `lf-close` (Esc) → the caller's close path. Grid drag/keyboard-move comes free for the future survival inventory (`lf-move`). |
| `<lf-statbars>` + `<lf-crosshair>` + `<lf-progress>` | `public/src/ui/hud.js` | Replace `#hud`'s hand-rolled `.crosshair`, `.health` shard spans and `.break-bar`; keep `initHUD()` returning `{showCrosshair, setHealth, setBreakProgress}`. `setHealth(0..20)` → `health` attribute (half-pips and the `low` ≤ 6 pulse are automatic — kit threshold is 30% of `health-max`); `showCrosshair(b)` → toggle `hidden` on a `fixed` crosshair; `setBreakProgress(p|null)` → an `<lf-progress>` shown/hidden with `value = p*100`. |
| `<lf-chat>` | `public/src/ui/chat.js` | Drop-in: same shape API. Keep `initChat({onSend})` and `{open, close, isOpen, addMessage({name,text,system})}` — all four exist on the element; wire `lf-send` → `onSend` (i.e. `G.net.sendChat` in `main.js:238`). Kit defaults match the module (scrollback 50, 256-char limit); line fading differs slightly (module FADE_MS 8000). |
| `<lf-debug-overlay>` | `public/src/ui/debug.js` | Drop-in: `initDebug()`'s `{toggle, setVisible, setData(partial)}` are element methods. The module's row keys (`fps, pos, chunk, dim, biome, facing, tris, calls, chunks`) are all supported (plus `light, mem, renderer, display`). Keep the F3 keybind in the shell; the overlay stays aria-hidden. |
| `<lf-pause-menu>` + `<lf-main-menu>` | `public/src/ui/menu.js` | Replace `.menu-screen--main` / `--pause` (and the `.vx-btn` stack + procedural backdrop — the kit's wordmark band and dim backdrop take over). Keep `initMenus({...})`'s `showMain()/showPause()/hideAll()`. Map `lf-action`: main `singleplayer` → `showWorldSelect()`, `settings` → settings screen, `accessibility` → settings' accessibility category; pause `resume` → `onResume`, `quit` → `onQuitToTitle`; `lf-back` (Esc) → resume + pointer-lock re-acquire. |
| `<lf-world-select>` + `<lf-world-card>` | `public/src/ui/menu.js` (worlds screen) | Replace `.menu-screen--worlds`'s `.world-list` / `.world-row`; keep the data flow: `getWorlds()` → one `<lf-world-card>` per world (`name`, `mode`, `played`). `lf-action` `play` → `onPlayWorld(name)`, `delete` → world removal (kit already confirmed via composed `<lf-modal>` — drop the module's own confirm), `lf-back` → `showMain()`. Create-world form stays `lf-input` (name/seed) + `lf-button` → `onCreateWorld({name, seed})`. |
| `<lf-settings-shell>` (+ `lf-slider`/`lf-toggle`/`lf-dropdown`) | `public/src/ui/menu.js` (settings screen) | Replace `.menu-screen--settings`; keep the settings shape `{renderDistance 2..12(6), fov 60..110(75), sensitivity 0.1..2(1), texturePack}` persisted to localStorage `loomfall.settings`. Author one `<section data-category>` per group; `renderDistance`/`fov`/`sensitivity` → `lf-slider`, `texturePack` → `lf-dropdown` fed from `PACKS` (`public/src/textures/texturePacks.js`). Listen for the bubbled `lf-change` to call `onSettingsChange(getSettings())`; `lf-back` returns to whichever screen pushed Settings (Title or Pause). |

Also available for the shell: `<lf-toast-rack>` (save/join notifications),
`<lf-modal>` (any confirm), `<lf-tabs>` (create-world Game|World|More),
`<lf-tooltip>`, `<lf-button>`/`<lf-input>` as general replacements for
`.vx-btn`/`.vx-input`. Migration note: builder file headers still say "Voxelheim UI"
— that's a stale codename; user-facing strings and storage keys are already Loomfall.

## 5. Gallery

Open **[`ui-kit/gallery.html`](gallery.html)** directly in a browser (fully
self-contained — inlined styles and modules, no server needed). It shows every
component in every notable state (hover/active/disabled/error/selected via the
`data-demo-*` attributes), with a dark/light theme toggle in the header. Per-component
fragments live in `ui-kit/gallery-fragments/` for screenshot tooling.

## 6. Do's and don'ts

**Do**

- Use `var(--lf-*)` tokens for every color; for guaranteed contrast in odd contexts,
  use the `--lf-pair-*-fg/bg` pairs (WCAG-verified from `palette.json`).
- Pair every status/selection color with a non-hue cue. The kit's set: info=droplet,
  success=stitch-check, warn=fray-knot triangle, error=frayed-X; selection = stitched
  knotlight luminance frame + notch. Reuse these — don't invent hue-only variants.
- Drive components via attributes/properties and listen for `lf-*` events; check
  `event.detail` for payloads.
- Give `size="icon"` buttons an `aria-label`, and destructive `<lf-modal>`s a
  `cancel-label`.
- Regenerate `tokens.css` from `brand/palette.json` when the palette changes
  (header comment in the file documents the command).

**Don't**

- **No raw hex** in component or shell CSS — tokens only. Pure `#000`/`#FFF` are
  forbidden by the brand (void ink `--lf-brand-void` and muslin `--lf-brand-muslin`
  exist for a reason).
- Don't remove or restyle `:focus-visible` outlines without replacement; the ring
  color must stay `--lf-color-focus-ring` (gold on dark, deep violet on light,
  ≥ 3:1 against surfaces).
- Don't add motion that ignores `prefers-reduced-motion` — `base.css` collapses kit
  animations under it (the indeterminate progress shuttle goes static, damage jitter
  calms); custom shell animation must do the same.
- Don't hand-set `tabindex` inside roving widgets (hotbar, grid, tabs, dropdown,
  settings rail) — `RovingTabindex` manages it.
- Don't ship `static` or `data-demo-*` attributes in game markup — they're for
  galleries and screenshots only.
- Don't put interactive content inside `<lf-tooltip>` bubbles, and never make
  information hover-only.
