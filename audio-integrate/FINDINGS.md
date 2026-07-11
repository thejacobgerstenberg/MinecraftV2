# AudioStack — Findings

Code-verified against the builder's real `GameAudio`
(`vendor-game/src/audio/GameAudio.js`), the vendored engine (`public/audio/`),
and the headless `OfflineAudioContext` proof (`demo.html`, 0 console errors,
15 events, 11/11 contract assertions).

| # | Finding | Severity | Owner | Detail | Action |
|---|---|---|---|---|---|
| 1 | Caption bridge is **net-new** — the game dispatches no `lf-audio-event` today | INFO (expected) | builder (adoption) | `GameAudio` + the engine play sound but emit no DOM event, so the ux-access / HudKit caption layer has nothing to listen to. This is the headline deliverable. | `AudioStack.attach(audio)` adds it in ~2 lines; closes HudKit PR #18 FINDINGS #1. |
| 2 | Gap-fill registry keys are **unwired** (`pop`/`pickup`, `door.open`/`door.close`, `chest.open`, `eat`, `drink`) | LOW | builder | These keys exist in the engine registry but have no call site. `item:collected` is emitted at `main.js:1048/1152` with no sound. | Helpers exist on `AudioStack`; wire the call sites (`item:collected -> pickup`, door/chest/eat/drink at their sites). |
| 3 | `GameAudio` takes **no injectable AudioContext** | LOW | builder (testability) | Offline harnesses must reach into `ga.engine.ctx` and re-`_buildBuses()`. | A `new GameAudio({ ctx })` passthrough would ease offline testing. Workaround (used by the proof): `ga.engine.ctx = off; ga.engine._buildBuses();`. |
| 4 | `setDimension` music **defers until `state.resumed`** | INFO | builder | Correct for browser autoplay policy — music is queued until a user gesture resumes the context. | No change; correct as-is. Headless harnesses must set `ga.state.resumed = true` before `setDimension`. |
| 5 | Peak > 1.0 when **many sounds fire the same instant** | LOW (expected) | n/a | The demo's NON-CLIPPING check fails only because the 15-sound battery all fires at offline `t=0` and the attacks sum. | Real gameplay staggers sounds so they never coincide; the engine's per-sound `OfflineAudioContext` render (`audio/README`) confirms each of the 66 sounds is individually non-clipping. |
| 6 | Builder **already ships** the 66-sound engine + a solid event->sound map | NOTE | coordinator | `GameAudio` already has the full event->sound map, per-frame listener, and volume wiring; the engine already reports "66 SFX / 5 music modes". | The brief's "early snapshot" premise appears **outdated**. This bundle's genuine, verified value is **(a)** the net-new caption bridge, **(b)** gap-fill for the unwired keys, and **(c)** docking the `<volume-settings>` widget — **not** a sound re-port. |

## Plain-language summary

Do not read this bundle as "we built the game's audio." The builder already did
the heavy lifting: 66 procedural sounds, a complete event->sound map in
`GameAudio`, a per-frame 3D listener, and live volume wiring — all present and
working before this bundle. What `AudioStack` genuinely adds, and what the proof
verifies:

1. **The `lf-audio-event` caption bridge** — the one thing that was missing.
   Without it, ux-access / HudKit captions have no signal to render. `attach()`
   decorates the existing `GameAudio` (non-invasively, restorable via `detach()`)
   so every sound also emits the event. This closes PR #18 FINDINGS #1.
2. **Gap-fill** for five registry keys the game defines but never calls.
3. **A dock** for the self-contained `<volume-settings>` shadow-DOM widget into
   `lf-settings-shell`.

Stating this plainly (as with the 2.60 clarification on the UI bundle) is the
honest read.
