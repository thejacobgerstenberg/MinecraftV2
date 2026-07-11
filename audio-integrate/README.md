# audio-integrate — AudioStack

The audio integration bundle for MinecraftV2 / Loomfall.

**Headline:** the `lf-audio-event` **caption bridge** — the net-new piece that
makes the ux-access `<lf-captions>` / HudKit caption layer work. The builder's
`GameAudio` and the vendored engine already play sound but dispatch **no DOM
event**, so captions have nothing to listen to. `AudioStack.attach(gameAudio)`
decorates the existing `GameAudio` so every sound **also** dispatches a single
uniform `lf-audio-event` on `window`. Beyond the bridge, the bundle provides the
full event→sound reference map, **gap-fill** helpers for unwired registry keys,
and a **dock** for the `<volume-settings>` widget.

This is not a sound re-port — the builder already ships the 66-sound engine and a
solid event→sound map. See [FINDINGS.md](./FINDINGS.md) #6 for the honest read.

---

## Quick start

```bash
node audio-integrate/server.mjs
# -> http://localhost:8130/   (the OfflineAudioContext proof, demo.html)
```

The proof drives the **real** builder `GameAudio` through an `OfflineAudioContext`
+ `AudioStack.attach`, renders 6 s of audio, and asserts the bridge contract.
Result: **0 console errors**, non-silent (peak ≈ 1.3, rms ≈ 0.096), **15**
`lf-audio-event` captured, **11/11** contract assertions PASS. See
[INTEGRATION.md](./INTEGRATION.md) for the full proof section, the captured-event
table, and the non-clipping honesty note.

## Integrate it (~2 lines)

In `public/src/main.js` — import at the top, then after `main.js:262`
(`const audio = new GameAudio();`):

```js
import { AudioStack } from '../../audio-integrate/integrate.js';

const audioStack = new AudioStack();
audioStack.attach(audio);   // every sound now emits lf-audio-event
```

Non-invasive (`GameAudio.js` is never edited; `audioStack.detach()` restores the
originals). Full step-by-step in [INTEGRATION.md](./INTEGRATION.md).

---

## API

`AudioStack` (default export) — also exports `attach(gameAudio, opts)`,
`REGISTRY_KEYS` (66), `MATERIALS` (11), `DIMENSION_MODE`
(`{overworld:'calm', nether:'nether', end:'mysterious'}`).

### Mode 1 — decorate the builder's `GameAudio` (primary)
```js
new AudioStack().attach(gameAudio);   // or: attach(gameAudio)
```
Wraps `setListener` (caches `{eye, yaw}` for direction), `play`, `engine.play`
(rain + dimension wind/cave beds), and `engine.startMusic`; dispatches the bridge
for each. Loop keys (`rain`/`wind`/`cave`) emit `{loop:true}` then `{ended:true}`
on stop; `startMusic` emits `music.<mode>` loop+ended. Returns a handle with
`detach()`. Additive gap-fill helpers: `pop`/`pickup`, `door`, `chest`, `eat`,
`drink`.

### Mode 2 — standalone facade over a raw `AudioEngine`
```js
const stack = new AudioStack({ ctx });
stack.setListener(eye, yaw);
stack.blockBreak('stone', pos);   // plays AND emits the bridge
```
Full surface: `resume`, `setListener`, `setVolumes`, `blockBreak`, `blockPlace`,
`step`, `mob`, `rainSet`/`rainStop`, `thunder`, `splash`, `portal`, `ui`, `hurt`,
`pop`/`pickup`, `door`, `chest`, `eat`, `drink`, `levelup`, `achievement`,
`explosion`, `music`, `stopMusic`, `stopAll`. Unknown materials normalize to
`stone`.

### Volume-widget dock
```js
audioStack.mountVolumeSettings(sectionEl, { engine: audio.engine });
```
Mounts the shadow-DOM `<volume-settings>` element (self-contained styling,
persists `localStorage['audio.volumes']`) into an `lf-settings-shell` Audio
section.

---

## The `lf-audio-event` contract

Matches HudKit / ux-access **exactly** (same owner on both sides; `captions.json`
is the authoritative category source downstream).

```js
window.dispatchEvent(new CustomEvent('lf-audio-event', { detail: {
  name:      string,   // engine key, e.g. "mob.groaner.hurt" or "music.<mode>"
  direction: 'left' | 'right' | 'behind' | 'front' | null,
  volume:    number,   // 0..1 (0 is dispatched; caption layer skips it)
  loop:      boolean,  // true on loop / music start
  ended:     boolean,  // true on loop / music stop
  category:  string,   // advisory: music.*=music, mob.*=mob,
                       // rain/wind/cave=ambient,
                       // thunder/thunder.distant/explosion/hurt=alert,
                       // else=action
}}));
```

Consumed by ux-access `<lf-captions>` / HudKit. This closes **PR #18 FINDINGS #1**
("no audio→caption signal").

---

## More

- [INTEGRATION.md](./INTEGRATION.md) — ordered, revertible steps + full
  event→sound map + proof + appendix (event shape, direction algorithm, categories).
- [FINDINGS.md](./FINDINGS.md) — severity/owner table; the honest note that the
  builder's audio is already largely wired, so this bundle's verified value is the
  **bridge + gap-fill + dock**, not a sound re-port.
</content>
