# Loomfall UX — Onboarding (`ux/onboarding/`)

Coach-mark sequencing for the 22 first-ten-minutes beats
(`content/onboarding.md` order is canonical; `dialogue.json`
`tutorialNarrator` lines are the short captions).

## Files

| File | What it is |
| --- | --- |
| `tutorial.json` | The compiled 22-beat flow. Per beat: `id` (exact onboarding event key), `narratorLine` (dialogue.json, verbatim), `coachMark {anchor, title, body, placement}`, `gateEvent`, `skippable`. |
| `tutorial.js` | `<lf-tutorial>` overlay element (registered via `define()` from `lf-core.js`; imports `lf-button`, `lf-modal`, `lf-toggle`). |
| `tutorial.css` | Overlay styles — `var(--lf-*)` tokens only. |
| `demo.html` | Mock HUD with `data-lf-anchor` hooks + §4 simulation buttons. Serve from repo root: `python3 -m http.server`, then open `/ux/onboarding/demo.html`. |

## Flow semantics

`gateEvent` is the `lf-game-event` `detail.type` that advances the tutorial
**to** that beat. `<lf-tutorial>` arms silently; when the game shell
dispatches `window` CustomEvent `"lf-game-event"` with `detail.type`
matching a beat, that beat's coach mark is shown, replacing any earlier
mark. Forward jumps are allowed (out-of-order play); events for beats at or
before the current index are ignored (once per save). The final beat
(`minute_10_wrapup`) renders as a vellum journal page dismissed by any key
or the Finish button, then `lf-tutorial-done` fires.

Skip step (button or `Escape`) dismisses the current mark and waits for the
next gate. Skip tutorial opens a confirm dialog (`lf-modal`, danger, with a
"Don't show the tutorial again" `lf-toggle`); confirming emits
`lf-tutorial-done {reason:'skipped', dontShowAgain}`.

Persistence: `localStorage["loomfall.tutorial.dismissed"] = "1"` on natural
completion or when the don't-show-again toggle was checked. `reset()`
clears it.

## Keybind tokens

`[MOVE] [BREAK] [PLACE] [INVENTORY] [INTERACT] [EAT]` in `coachMark.body`
are substituted at render time into `<kbd>` chips from the ACTIVE bindings:

1. `localStorage["loomfall.bindings"]` (shape of `bindings.default.json`)
2. `ux/keybinds/bindings.default.json` (fetched relative to `tutorial.js`)
3. a hard-coded WASD fallback

The overlay listens for `lf-bindings-change` (§4) and re-renders live.
`[MOVE]` expands to the four movement primaries (one chip each).

## Coach-mark anchor vocabulary (contract §3 — maintained here)

The game shell (and any demo mocking HUD) exposes stable hooks as
`data-lf-anchor="<id>"` attributes on existing elements. The overlay
locates targets ONLY via
`document.querySelector('[data-lf-anchor="<id>"]')`. Reserved ids:

```
hotbar            hotbar-slot-0 .. hotbar-slot-8
healthbar         hungerbar          statbars
crosshair         chat               inventory
inventory-button  pause-button       debug
toast-rack        deathscreen-respawn
settings-button
```

Rules:

- Anchors are attributes on existing elements; nobody restyles the anchored
  element itself. The overlay draws its own stitched-outline spotlight
  (dashed Everthread hem + `box-shadow` dim cutout) in a `position:fixed`
  layer, repositioned on resize/scroll via `getBoundingClientRect`.
- A missing/hidden anchor degrades to a lower-center toast-style card —
  never throws, never blocks the queue.
- `anchor: null` in `tutorial.json` is deliberate: center-screen modal card
  over a full dim.
- **Additions to this vocabulary must be recorded in this list** (published
  contract with the game builder).

## `<lf-tutorial>` API

Attributes: `src` (flow JSON URL, read on connect), `autostart`,
`active` (reflected while running — read-only).
Properties: `flow`, `bindings`, `stepIndex`.
Methods: `start({force})`, `stop()`, `skipStep()`, `reset()`.
Events: `lf-tutorial-step {index, id}`,
`lf-tutorial-done {reason:'completed'|'skipped', dontShowAgain}`.

Keyboard: Tab reaches the card's buttons; `Escape` skips the current step
(an open dialog swallows its own `Escape` first); any key closes the final
journal page. Reduced motion honors both
`@media (prefers-reduced-motion: reduce)` and the forced
`html[data-lf-reduced-motion="on"|"off"]` override (§5).
