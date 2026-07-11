# Loomfall UX — Accessibility & Onboarding Layer (`ux/`)

An accessibility + onboarding package built **on top of** the Loomfall UI kit
(`ui-kit/`). Framework-free ES modules, zero external dependencies, no build
step. Every component imports `../../ui-kit/lf-core.js`, reuses `lf-*` widgets,
and colors exclusively via `ui-kit/tokens.css` custom properties. `ui-kit/` is
never modified — everything here lives under `ux/`.

Four areas, one schema directory:

| Area | Element | Data contract | Purpose |
| --- | --- | --- | --- |
| [`keybinds/`](keybinds/README.md) | `<lf-keybinds>` | `schemas/bindings.schema.json` | Remappable input (keyboard/mouse/gamepad) |
| [`options/`](options/README.md) | `<lf-access-options>` | `schemas/options.schema.json` | Colorblind modes, UI scale, reduced motion, volumes, subtitles, difficulty, FOV |
| [`captions/`](captions/README.md) | `<lf-captions>` | `schemas/captions.schema.json` | Sound captions for deaf/HoH play, with directional indicators |
| [`onboarding/`](onboarding/README.md) | `<lf-tutorial>` | `onboarding/tutorial.json` (22 beats) | Skippable coach-mark tutorial gated on game events |

Each area's own README is the deep reference; this file is the map and the
integration index for the game builder.

## Running the demos

No build, no network. Serve the **repo root** over http (ES modules and
`fetch` of JSON need it):

```sh
python3 -m http.server        # from /home/user/MinecraftV2
```

Then open `http://localhost:8000/ux/<area>/demo.html` for `keybinds`,
`options`, `captions`, `onboarding`. Every demo includes simulation buttons
that fire the same window events the real game shell will emit, plus a live
event log / JSON view.

Import order everywhere: `tokens.css` → `base.css` → component CSS; JS modules
self-register their custom elements on import.

---

## keybinds — `<lf-keybinds>`

Key-binding editor panel. Composes `lf-button`, `lf-modal`, `lf-toast-rack`;
docks into `<lf-settings-shell>` as a `<section data-category>` body or stands
alone.

**Attributes / API** — `storage-key` (default `loomfall.bindings`);
`el.defaults = <bindings doc>` (required bootstrap); `el.bindings` (snapshot),
`el.exportBindings()`, `el.importBindings(doc) -> {ok, errors[]}`,
`el.resetAll({confirm})`. Capture mode grabs `KeyboardEvent.code`, `Mouse0–4`,
`WheelUp/WheelDown`, or gamepad buttons 0–16; Escape cancels,
Backspace/Delete clears. Conflicts get a fray-knot glyph + dashed hem (shape,
not hue alone) and a Swap / Unbind / Cancel modal.

**Event** — `lf-bindings-change` (bubbles + composed to `window`):
`detail: {action, slot: "primary"|"secondary"|"gamepad", code, bindings}`.

**Data contract** — `ux/schemas/bindings.schema.json`; factory defaults in
`ux/keybinds/bindings.default.json`. 27 actions, three slots each:

```json
{ "version": 1, "bindings": {
    "moveForward": { "primary": "KeyW", "secondary": "ArrowUp", "gamepad": null },
    "break":       { "primary": "Mouse0", "secondary": null, "gamepad": 7 },
    "pause":       { "primary": "Escape", "secondary": null, "gamepad": 9 } } }
```

**INTEGRATION** — the builder's single input module is
`public/src/gameplay/Controls.js` (hard-coded `KeyboardEvent.code` map, no
rebinding layer yet). To honor `bindings.json`, Controls.js replaces its
literal code checks with a lookup built from
`localStorage["loomfall.bindings"]` (falling back to
`bindings.default.json`), refreshed on the window `lf-bindings-change` event.
Action ids in the schema map 1:1 onto Controls' behavior: `moveForward/Back/
Left/Right` → `input.*`, `jump` (+ double-tap `toggleFlight`), `sneak`/`sprint`
(currently both driven by `ShiftLeft` — documented shared pair until the
builder splits them), `break`/`place` (mouse while pointer-locked),
`hotbar1–9` → `selectSlot 0–8`, `hotbarPrev/Next` → wheel `scroll`,
`inventory` → `toggleInventory`, `chat` → `openChat`, `pause` →
`togglePause`, `debug` → `toggleDebug`. Rebinding `pause` off Escape warns
but never blocks: pointer-lock loss still fires pause.

## options — `<lf-access-options>` + `options-store.js`

Accessibility/options panel plus the propagation runtime. Composes
`lf-slider`, `lf-toggle`, `lf-dropdown`; docks into `<lf-settings-shell>`.

**Controls** (schema dot-paths) — `colorblindMode`, `uiScale` (0.75–1.5×,
live preview on `lf-input`), `fov` (60–110°), `reducedMotion`
(`system|on|off`), `volumes.master|sfx|music` (shown 0–100 %, stored 0–1),
`subtitles`, `difficulty`.

**Events** — kit widgets bubble `lf-change` untouched (settings-shell
persistence hook still works); every committed change dispatches window
`lf-options-change` `detail: {key, value, options}` (`key: null` on
load/reset). The store also stamps `html[data-lf-cvd="<mode>"]`,
`html[data-lf-reduced-motion="on"|"off"]`, and `--lf-ui-scale` +
`font-size: calc(16px * var(--lf-ui-scale))` on `<html>`.

**Data contract** — `ux/schemas/options.schema.json`. All keys defaulted;
`{}` is valid:

```json
{ "colorblindMode": "deuteranopia", "uiScale": 1.1, "reducedMotion": "on",
  "subtitles": true, "fov": 90,
  "volumes": { "master": 1, "sfx": 1, "music": 0.7 },
  "difficulty": "standard" }
```

**INTEGRATION** — persistence merges into the builder's existing localStorage
`loomfall.settings` object (`public/src/ui/menu.js` SETTINGS_SPEC), preserving
unrelated keys (`renderDistance`, `sensitivity`, `texturePack`,
`graphicsQuality`). Flat mapping `volumes.master→volumeMaster`,
`volumes.sfx→volumeSfx`, `volumes.music→volumeMusic`, `fov→fov` — exactly what
`public/src/audio/GameAudio.js` `setVolumes(settings)` reads before forwarding
to the audio engine's `setMasterVolume/setSfxVolume/setMusicVolume`
(`audio/engine.js` bus gains), and what main.js `applySettings()` already
applies to camera FOV. Binding rule for the game shell: JS-driven motion
(screen shake, particles, camera bob) must consult `motionReduced()` from
`options-store.js` and re-check on every `lf-options-change`.

## captions — `<lf-captions>`

Sound-caption overlay (subtitles) for deaf/HoH and muted play. Dark loom-room
card in both themes; direction chevrons + screen-edge alignment specified in
`captions/DIRECTIONAL.md`.

**Attributes / API** — `corner` (`bottom-left` …), `max-lines` (default 3);
`el.captions = <captions.json doc>`. Priority-based line eviction (alerts
replace ambient, never vice versa), repeat coalescing (footstep spam holds one
line), sticky loop lines until `{ended: true}`. Emits `lf-show` and
`lf-dismiss {reason}`. Visible list is `aria-hidden`; a polite live region
mirrors every caption with spoken direction suffixes.

**Data contract** — `ux/schemas/captions.schema.json`; table at
`ux/captions/captions.json` covering all 66 engine sound keys plus
`music.<mode>` pseudo-keys and reserved `boss.<id>.<cue>` keys. `*` wildcards
match exactly one dot-segment; most-literal-segments wins:

```json
{ "version": 1, "captions": [
    { "sound": "step.*",  "text": "Footsteps on {material}", "category": "action", "priority": 3 },
    { "sound": "thunder", "text": "Thunder cracks",          "category": "alert",  "priority": 9 },
    { "sound": "mob.*.hurt", "text": "{mob} hurt",           "category": "mob",    "priority": 6 } ] }
```

**INTEGRATION** — the bridge is the window CustomEvent **`lf-audio-event`**:
the builder's `public/src/audio/GameAudio.js` wrapper dispatches
`detail: {name, direction, volume, loop, ended}` alongside every
`engine.play(name, opts)`, computing `direction` from the sound's `pos`
relative to the listener (`setListener(eyePos, yaw)`). `startMusic(mode)`
emits `name: "music.<mode>"`; loop handles (`wind`, `cave`, `rain`) emit
`{name, ended: true}` on stop. Captioned key families come straight from
`audio/sfx/index.js`: `break/place/step` × 11 materials (GameAudio's
`MATERIAL_BY_BLOCK` chooses the material), `mob.<archetype>.<variant>`
(GameAudio's `VOICE_FAMILY` maps game mobs onto the 5 archetypes),
environment/weather/UI/extras keys. Options integration: when
`subtitles === false` the shell unmounts the element entirely.

## onboarding — `<lf-tutorial>`

Coach-mark sequencer for the 22 first-ten-minutes beats
(`content/onboarding.md` order; `dialogue.json` `tutorialNarrator` lines as
short captions). Composes `lf-button`, `lf-modal`, `lf-toggle`.

**Attributes / API** — `src` (flow JSON URL), `autostart`, `active`
(reflected, read-only); `flow`, `bindings`, `stepIndex` properties;
`start({force})`, `stop()`, `skipStep()`, `reset()`. Events:
`lf-tutorial-step {index, id}`, `lf-tutorial-done {reason:'completed'|
'skipped', dontShowAgain}`. Escape skips a step; Skip-tutorial confirm modal
carries a "don't show again" toggle; completion persists to
`localStorage["loomfall.tutorial.dismissed"]`. Final beat renders as a
full-screen vellum journal page, dismissed by any key.

**Data contract** — `ux/onboarding/tutorial.json`; per beat:

```json
{ "id": "on_first_block_broken", "gateEvent": "first_block_broken",
  "narratorLine": "…", "skippable": true,
  "coachMark": { "anchor": "crosshair", "title": "…",
                 "body": "Hold [BREAK] to unravel a block.", "placement": "bottom" } }
```

`[MOVE] [BREAK] [PLACE] [INVENTORY] [INTERACT] [EAT]` tokens are substituted
into `<kbd>` chips from the ACTIVE bindings (localStorage →
`bindings.default.json` → WASD fallback), re-rendered live on
`lf-bindings-change`.

**INTEGRATION** — gating rides the builder's game-event bus
(`public/src/systems/events.js`, `gameEvents`): the shell forwards bus/canon
triggers (`first_block_broken`, `set_anchor`, `survive_first_night`,
`player_unpicked`, `hear_thrum`, plus client-side UI events like first
inventory open) as window CustomEvent `"lf-game-event"` with `detail.type`
equal to the beat's `gateEvent`. Coach marks locate targets ONLY via
`data-lf-anchor="<id>"` attributes the builder adds to its existing HUD
elements — `public/src/ui/hud.js` (`crosshair`, `healthbar`, `statbars`),
`hotbar.js` (`hotbar`, `hotbar-slot-0..8`), `inventory.js` (`inventory`),
`chat.js` (`chat`), `debug.js` (`debug`), `deathscreen.js`
(`deathscreen-respawn`), menu buttons (`pause-button`, `settings-button`),
toast rack (`toast-rack`). Full reserved-id list is maintained in
`ux/onboarding/README.md` (published contract); a missing anchor degrades to
a lower-center card, never throws. Canon-trigger beats show after the
matching achievement banner clears (per `content/onboarding.md` conventions).

---

## Accessibility statement

The whole package holds the ui-kit's bar — keyboard-first, `:focus-visible`
rings via `--lf-color-focus-ring`, ARIA roles/live-regions on every dynamic
surface, and **no hue-only meaning** (every status/selection cue pairs color
with a shape glyph) — and extends it per audience:

- **Deaf / hard of hearing** — full sound captioning (`captions/`) of all 66
  engine keys plus music, with category glyphs, priority-managed line budget,
  and **directional indicators** (chevron shape + screen-edge position, never
  color) so gameplay-critical audio (mob approach, thunder, explosions) is
  playable silent. Master `subtitles` switch in options.
- **Colorblind** — deuteranopia / protanopia / tritanopia token overrides
  (`options/cvd.css`) re-map only meaning-bearing accents, contrast-audited in
  dark and light themes; shape glyphs remain the primary channel.
- **Motor** — everything operable by keyboard alone (roving tabindex, modals
  with focus trap/restore), full input remapping including mouse-button and
  gamepad slots (`keybinds/`), UI scale up to 1.5×.
- **Cognitive** — the tutorial is fully skippable (per-step Escape and a
  don't-show-again global skip), one coach mark at a time, plain-language
  narrator lines, and a reduced-motion mode (tri-state: system / forced on /
  forced off) that also gates game shake and particles.
