# ux/keybinds — `<lf-keybinds>`

Key-binding editor for Loomfall. Framework-free, built on `ui-kit/`
(`lf-core.js`, `lf-button`, `lf-modal`, `lf-toast-rack`), tokens-only colors.
Docks into `<lf-settings-shell>` as panel content or stands alone.

## Files

| File | What |
| --- | --- |
| `bindings.default.json` | Factory defaults (architect-validated against `../schemas/bindings.schema.json`). Do not regenerate. |
| `keybinds.js` | `<lf-keybinds>` element + exported helpers (`validateBindingsDoc`, `prettyKey`, `prettyPad`, `KEYCODE_RE`, `GROUPS`, `ACTIONS`). |
| `keybinds.css` | Panel styles (tokens only, motion-gated per contract §5). |
| `demo.html` | Full panel docked in the settings shell + export/import textarea + live JSON view + event log + §4 simulation buttons. Serve over http from the repo root. |

## Bootstrap

```js
import './keybinds.js';
const el = document.querySelector('lf-keybinds');
el.defaults = await (await fetch('./bindings.default.json')).json(); // required
```

Setting `defaults` loads any persisted user map from localStorage
`"loomfall.bindings"` (attribute `storage-key` overrides the key). The stored
value is `{ version: 1, bindings: { ... } }` — exactly the
`bindings.schema.json` shape; invalid or foreign payloads are ignored.

## API

- `el.bindings` → deep-copied current action→binding map (read-only snapshot).
- `el.exportBindings()` → `{ version: 1, bindings }` (schema shape).
- `el.importBindings(doc)` → `{ ok, errors[] }`; structural validation
  (27 actions, slot keys, keyCode pattern, gamepad 0–16) before applying as a
  full replacement.
- `el.resetAll({ confirm = true })` → factory reset (confirm modal by default).

## Event

`lf-bindings-change` — bubbles + composed (reaches `window`, contract §4).
Emitted once per changed slot on every commit (capture, clear, swap,
overwrite, reset, import).
`detail: { action, slot: "primary"|"secondary"|"gamepad", code: string|number|null, bindings }`
where `bindings` is the full deep-copied map.

## Capture semantics

- Click / Enter / Space on a bind button → capture mode
  (`[capturing]` attribute, dashed focus-ring hem, "Press a key…").
- Keyboard slots: next `keydown` captures `KeyboardEvent.code`; `mousedown`
  captures `Mouse0–Mouse4`; `wheel` captures `WheelUp`/`WheelDown`.
- `Escape` cancels, `Backspace`/`Delete` clears — both reserved (never
  capturable; import can still bind them). Capture events are swallowed in
  the window capture phase, so the settings shell never sees the Escape.
- Polite live region announces capture start / commit / cancel.

## Gamepad capture — STUB

While a gamepad slot is capturing, the panel listens for `gamepadconnected`
and polls `navigator.getGamepads()` each animation frame; the first pressed
button index (0–16, Standard Gamepad mapping) is captured. Escape cancels,
Backspace clears. No axis/stick capture (hard-wired per schema) and no
gamepad-driven UI navigation — the real input layer replaces this stub.

## Conflicts

Keyboard pool = primary + secondary across all actions; gamepad pool is
separate. Exempt context-share sets (documented in the schema):
`{place, interact, eat}` and `{sneak, sprint}`. On a conflicting assignment:

1. Both rows get `[conflict]` — dashed error hem + fray-knot triangle glyph
   (shape cue paired with color, never hue alone).
2. Warning toast names the current owner(s).
3. A modal offers **Swap** (first owner takes this slot's previous code;
   additional owners are unbound), **Unbind & Assign**, or **Cancel**.

Rebinding `pause` so that neither keyboard slot is `Escape` warns (does not
block): pointer-lock loss still fires pause via Escape.

Per-row reset restores that action's defaults and unbinds any other action
that had taken one of the restored codes (info toast lists them). Reset-all
sits behind a danger confirm modal.
