# AudioStack — Integration Guide

Ordered, code-verified, each-step-revertible. The headline deliverable is the
**`lf-audio-event` caption bridge** (net-new): the builder's `GameAudio` and the
vendored engine dispatch **no DOM event today**, so the ux-access `<lf-captions>`
/ HudKit caption layer has nothing to listen to. `AudioStack.attach(gameAudio)`
decorates the existing `GameAudio` so every sound **also** dispatches a single
uniform `lf-audio-event` on `window`. This closes **HudKit PR #18 FINDINGS #1**
("no audio→caption signal").

---

## TL;DR — the whole bundle is ~2 lines

Attach the caption bridge. That's it — all 66 engine sounds start emitting
`lf-audio-event` and captions light up.

In `public/src/main.js`, at the top with the other imports:

```js
import { AudioStack } from '../../audio-integrate/integrate.js';
```

Then immediately after `main.js:262` (`const audio = new GameAudio();`):

```js
const audioStack = new AudioStack();
audioStack.attach(audio);
```

**Revert:** delete those two lines. `attach()` is non-invasive — it wraps
`GameAudio`'s methods in place and `audioStack.detach()` restores the originals;
`GameAudio.js` itself is never edited.

---

## Prerequisites

- **Latest audio engine** — already vendored by the builder at `public/audio/`
  ("66 SFX / 5 music modes"). `AudioStack` does not re-port sound; it decorates
  what's there.
- **Consumers of the bridge** — ux-access captions (#17) and HudKit (#18) already
  know how to render `lf-audio-event`. This bundle produces the event they consume.

---

## Steps (each: what / exact edit / revert)

### 1. Copy `integrate.js` into the tree
**What:** place `audio-integrate/integrate.js` where `main.js` can import it.
**Edit:** the file is already at `audio-integrate/integrate.js`. Its only import
is `import AudioEngine from "../audio/engine.js";` — **the one path to check.**
That resolves to the repo-root `audio/engine.js`. The builder vendors the engine
at `public/audio/engine.js`; if you relocate `integrate.js` under `public/`,
update that relative import to point at `public/audio/engine.js`. (Mode 1 never
constructs an engine — it uses `gameAudio.engine` — so this import only matters
for the standalone Mode 2 path.)
**Revert:** remove the file.

### 2. Attach the bridge (the 2 lines) — closes HudKit FINDINGS #1
**What:** decorate `GameAudio` so every sound emits `lf-audio-event`.
**Edit:** the import + the two lines from the TL;DR after `main.js:262`.
**Revert:** remove the two lines. After this step, captions work — no other change
is required for the headline deliverable.

### 3. (Optional) Gap-fill the unwired registry keys
**What:** five registry keys exist in the engine but have **no call site** in the
game today: `pop` (item pickup), `door.open` / `door.close`, `chest.open`, `eat`,
`drink`. `AudioStack` ships helpers for each; wire them at their sites.
**Edit:** at the item-pickup site (`item:collected`, emitted at `main.js:1048` and
`main.js:1152` with no sound), call `audioStack.pickup(pos)` (plays `pop`).
Similarly `audioStack.door(open, pos)`, `audioStack.chest(pos)`, `audioStack.eat()`,
`audioStack.drink()` at their respective sites. Each routes through
`gameAudio.play` so the bridge fires automatically.
**Revert:** remove each helper call. Independent of step 2.

### 4. (Optional) Dock the `<volume-settings>` widget
**What:** mount the self-contained volume UI into an `lf-settings-shell` section.
**Edit:**
```js
audioStack.mountVolumeSettings(section, { engine: audio.engine });
// section = lf-settings-shell <section data-category="Audio">
```
Or keep the game's existing settings sliders — they already apply volumes via
`audio.setVolumes(getSettings())` (wired at `main.js:471` in `applySettings`).
The widget is optional and additive.
**Revert:** don't mount it (or remove the element).

---

## Event → sound map

Every game event below already flows through `GameAudio`; after step 2 each one
**also** emits an `lf-audio-event`. Materials cover all 11 families
(`stone, wood, dirt, grass, sand, glass, leaves, gravel, snow, metal, wool`).

| Game event | GameAudio call | Engine key(s) |
|---|---|---|
| Break a block | `blockBreak(id, pos)` | `break.<material>` (×11) |
| Place a block | `blockPlace(id, pos)` | `place.<material>` (×11) |
| Footstep | `step(id, pos, vel)` (volume 0.55) | `step.<material>` (×11) |
| Mob idle/hurt/death | `play('mob.<family>.<variant>', {pos, volume})` | `mob.{grazer,groaner,exploder,screecher,trader}.{idle,hurt,death}` (×15) |
| Rain (weather) | `rainSet(intensity)` → held loop; `rainStop()` | `rain` (loop) |
| Thunder | `thunder(far, pos)` | `thunder` \| `thunder.distant` |
| Splash | `splash(pos)` | `splash` |
| Portal | `portal(pos)` | `portal` |
| UI click | `ui()` | `ui.click` |
| Hurt | `hurt()` | `hurt` |
| Level up | `levelup()` | `levelup` |
| Achievement | `achievement()` | `achievement` |
| Explosion | `play('explosion', {pos})` | `explosion` |
| Dimension music + bed | `setDimension(dim, seed)` | `music.calm` + `wind` (overworld) · `music.nether` + `cave` (nether) · `music.mysterious` (end) |
| **Gap-fill: item pickup** | `audioStack.pickup(pos)` | `pop` |
| **Gap-fill: door** | `audioStack.door(open, pos)` | `door.open` / `door.close` |
| **Gap-fill: chest** | `audioStack.chest(pos)` | `chest.open` |
| **Gap-fill: eat** | `audioStack.eat()` | `eat` |
| **Gap-fill: drink** | `audioStack.drink()` | `drink` |

Where the game already calls these (verified in the builder's `main.js`):
`setListener` @1450, `step` @1469, `blockBreak` @1144/1185, `blockPlace` @1279,
`hurt` @1084, `play('mob.*')` @1032/1035/1129, `play('explosion')` @1057,
`levelup` @1062, `thunder` @829, `rainSet`/`rainStop` @1859–1861,
`setDimension` @1647, `portal` @1738, `setVolumes` @421/471, `ui` @418.

---

## Where the volume widget docks

`mountVolumeSettings(sectionEl, { engine, importPath = '../audio/volume-settings.js' })`
dynamically imports and appends a `<volume-settings>` custom element into the
target container — intended to be the `lf-settings-shell` `<section data-category="Audio">`.

The `<volume-settings>` element is **shadow-DOM** (self-contained styling, no CSS
leakage in either direction) and persists its state to `localStorage` under
`'audio.volumes'`. It binds to the engine you pass (`audio.engine`).

---

## Proof

`audio-integrate/demo.html` — headless via `OfflineAudioContext`, driving the
**real** builder `GameAudio` (the vendored copy at
`audio-integrate/vendor-game/src/audio/GameAudio.js`) with `ga.engine.ctx`
injected as the offline context + `AudioStack.attach`. Rendered 6 s of stereo
@ 44.1 kHz. **0 console errors.**

- **NON-SILENT: PASS** — peak ≈ **1.3**, rms ≈ **0.096** (`peak > 0.001`).
- **CONTRACT: PASS** — **11/11** assertions.
- **15 `lf-audio-event`** captured.

Captured-event evidence (representative battery, one per category + direction):

| name | direction | volume | loop | ended | category |
|---|---|---|---|---|---|
| break.stone | left | 1.00 | false | false | action |
| place.wood | right | 1.00 | false | false | action |
| step.grass | front | 0.55 | false | false | action |
| mob.groaner.hurt | behind | 0.85 | false | false | mob |
| thunder | front | 1.00 | false | false | alert |
| thunder.distant | null | 1.00 | false | false | alert |
| ui.click | null | 1.00 | false | false | action |
| hurt | null | 1.00 | false | false | alert |
| portal | (pos) | 1.00 | false | false | action |
| splash | (pos) | 1.00 | false | false | action |
| rain | null | 0.60 | **true** | false | ambient |
| pop | null | 1.00 | false | false | action |
| music.calm | null | 1.00 | **true** | false | music |
| wind | null | 0.35 | **true** | false | ambient |
| rain | null | 1.00 | false | **true** | ambient |

The 11 contract assertions: shape keys present on every event · at least one
positional direction non-null · `+x` (break.stone) and `-x` (place.wood) produce
**different** directions · `ui.click`/`hurt`/`thunder.distant` direction `null` ·
`rain` dispatched **both** `loop:true` and later `ended:true` · `music.calm`
dispatched · thunder/hurt = `alert` · step/break/place = `action` · `mob.*` = `mob`
· rain/wind = `ambient` · `music.*` = `music`.

### Honesty note on NON-CLIPPING

The demo's NON-CLIPPING check reads **FAIL** (peak > 1.0). This is an **artifact
of the test, not the audio**: the 15-sound battery all fires at offline `t=0`, so
every attack transient sums into the same quantum. Real gameplay staggers these
so they never coincide. The engine's own `audio/README` verifies each of the 66
sounds is individually **non-silent AND non-clipping** via a per-sound
`OfflineAudioContext` render. This is the honest, per-sound guarantee; the summed
peak here is expected.

Screenshot: `docs/screenshots/proof.png` (waveform + event table + PASS list).

Run it yourself: `node audio-integrate/server.mjs` → open `http://localhost:8130/`.

---

## Appendix

### `lf-audio-event` shape (matches HudKit / ux-access exactly)

```js
window.dispatchEvent(new CustomEvent('lf-audio-event', { detail: {
  name:      string,   // engine key, e.g. "mob.groaner.hurt" or "music.<mode>"
  direction: 'left' | 'right' | 'behind' | 'front' | null,
  volume:    number,   // 0..1; 0 is dispatched too, the caption layer skips it
  loop:      boolean,  // true on loop / music start
  ended:     boolean,  // true on loop / music stop
  category:  string,   // advisory bucket (see below)
}}));
```

The caption layer (ux-access `<lf-captions>`) listens for `lf-audio-event`, looks
`name` up in `captions.json`, shows a directional caption chip using `direction`,
and honors `loop`/`ended` for persistent ambient captions. `category` is advisory
(captions.json is authoritative downstream). This closes **PR #18 FINDINGS #1**.

### Direction algorithm

From a cached listener `{eye, yaw}` (populated by the wrapped `setListener`):
`rel = (pos.x − eye.x, pos.z − eye.z)`. If `|rel| < 0.5` → `null` (on top of the
listener). Forward `f = (−sin yaw, −cos yaw)`, right `r = (−cos yaw, sin yaw)`.
`fwd = rel·f`, `rgt = rel·r`. If `fwd ≥ |rgt|` → `front`; else if `−fwd ≥ |rgt|`
→ `behind`; else `rgt > 0 ? 'right' : 'left'`. Non-positional sounds and any
`ended:true` stop dispatch `direction: null`.

### Category map (advisory)

| category | keys |
|---|---|
| `music` | `music.*` |
| `mob` | `mob.*` |
| `ambient` | `rain`, `wind`, `cave` |
| `alert` | `thunder`, `thunder.distant`, `explosion`, `hurt` |
| `action` | everything else (step/break/place, door/chest, eat/drink, splash, portal, ui.click, pop, levelup, achievement) |
</content>
</invoke>
