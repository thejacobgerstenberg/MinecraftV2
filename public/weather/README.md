<!-- weather/README.md -->

# Loomfall Weather

A standalone, build-free weather-visuals package for the Loomfall voxel game. Pure
native ES modules — no bundler, no npm install, no build step. It renders GPU-driven
**rain**, **snow**, and **lightning** into any Three.js scene, plus a **sky
controller** that owns the background, fog, and lights and pulses the whole scene on
each lightning flash.

The public surface deliberately mirrors the audio engine (imperative
`setWeather` / `setIntensity` / `strike`) so one integrator can wire visuals and
audio together in the same call. See the [pairing table](#audio-pairing) below.

## Quick start

ES modules must be served over HTTP — opening `demo.html` from `file://` will fail
on the import map. Use the bundled zero-dependency server:

```sh
node weather/server.mjs        # PORT env, default 8124; serves the repo root
# then open:
open http://localhost:8124/    # -> weather/demo.html
```

The demo gives you a voxel ground plane, orbit controls, Clear / Rain / Storm / Snow
buttons, an intensity slider, a Strike button, a Day / Night toggle, a live FPS
readout, and an on-screen event log.

## Vendored Three.js

Three.js r160 is vendored at `weather/vendor/three.module.js` (and `OrbitControls.js`).
Every module imports it through the **bare specifier** `"three"`, resolved by an import
map in the host page:

```html
<script type="importmap">
{
  "imports": {
    "three": "./vendor/three.module.js",
    "three/addons/controls/OrbitControls.js": "./vendor/OrbitControls.js"
  }
}
</script>
```

**To use your own copy of Three.js**, remap the bare specifier — point `"three"` at
your build. Nothing in this package imports Three from a URL or a relative path, so the
import map is the single source of truth:

```html
<script type="importmap">
{ "imports": { "three": "/vendor/three/build/three.module.js" } }
</script>
```

## Wiring example

```js
import * as THREE from "three";
import WeatherSystem from "./weather/weather.js";

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);

// SkyController takes over scene.background, scene.fog, and adds its own lights.
const weather = new WeatherSystem(scene, camera);

weather.setWeather("storm");     // rain + auto periodic lightning
weather.setIntensity(0.8, 1.5);  // ramp to 0.8 over 1.5s

const clock = new THREE.Clock();
function frame() {
  weather.update(clock.getDelta()); // ramps intensity, drives effects, pulses sky
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();
```

## API reference

### `class WeatherSystem extends EventTarget`

Also exported as `default`.

```js
new WeatherSystem(scene, camera, opts = {})
```

Instantiates a `SkyController`, `RainEffect`, `SnowEffect`, and `LightningEffect`.
State starts `"clear"` with all precipitation hidden. `opts` may carry per-effect
option bags: `{ intensity?, ramp?, sky?, rain?, snow?, lightning? }`.

| Method | Signature | Behavior |
| --- | --- | --- |
| `setWeather` | `(state, opts?) => void` | `state` is `"clear" \| "rain" \| "storm" \| "snow"`. Activates the matching effects (`rain` → rain; `storm` → rain + auto lightning; `snow` → snow; `clear` → precip off), retargets the sky palette, and emits `weatherChange`. Idempotent for the same state. `opts.ramp` overrides the intensity ramp. |
| `setIntensity` | `(v, ramp = 1.5) => void` | Sets the **target** intensity `0..1` (clamped). `update()` eases the current value toward it over ~`ramp` seconds and feeds it into the active precip effect + `sky.setIntensity`. |
| `strike` | `(opts?) => Promise<{far:boolean}>` | Triggers a lightning flash in **any** weather (manual strike works in clear). Emits `lightningStrike` at flash **start**, and returns a promise that **resolves at the flash peak** (~90ms). `opts.far` → dimmer, no bolt. Never throws. |
| `update` | `(dt) => void` | Call every frame. Clamps `dt` to ≤ 0.1s, advances a monotonic clock, ramps intensity, updates all effects, reads `lightning.getFlash()` → `sky.applyFlash()`, and during storms auto-fires `strike()` at randomized ~4–12s intervals (more frequent at higher intensity). |
| `on` | `(type, handler) => () => void` | Sugar for `addEventListener`; returns an `off()` function. |
| `off` | `(type, handler) => void` | Sugar for `removeEventListener`. |
| `getState` | `() => { weather, intensity }` | Current snapshot (`intensity` is the **current** ramped value). |
| `dispose` | `() => void` | Disposes all effects + sky and stops scheduling. Safe to call once; each sub-dispose is wrapped in try/catch. |

Read-only getters expose the sub-systems for advanced use (day/night, tests):
`weather.sky`, `weather.rain`, `weather.snow`, `weather.lightning`. Day/night is a sky
concern — reach it via `weather.sky.setDayNight("day" | "night")`.

### Events

Both are `CustomEvent`s dispatched on the `WeatherSystem` instance.

| Event | `detail` | When |
| --- | --- | --- |
| `"weatherChange"` | `{ from: string, to: string }` | On every state change via `setWeather`. |
| `"lightningStrike"` | `{ far: boolean }` | At the **start** of every strike (manual or storm-auto). |

```js
const off = weather.on("lightningStrike", (e) => {
  console.log("bolt, far =", e.detail.far);
});
// later: off();
```

<a name="audio-pairing"></a>
## Audio pairing

The weather API is shaped to line up 1:1 with the Loomfall audio engine
(`play(name, opts) -> { stop, setIntensity? }`, `setIntensity(v, ramp)`). Wire both
from the same call sites:

| Visual (WeatherSystem) | Audio (AudioEngine) |
| --- | --- |
| `setWeather("rain")` / `setIntensity(v)` | `play("rain", { intensity: v })`; `handle.setIntensity(v, ramp)` |
| `setWeather("storm")` | `play("rain", { intensity: 0.9 })` + periodic thunder |
| `strike()` near → `await`, then | `play("thunder", { pos })` |
| `strike({ far: true })` → `await`, then | `play("thunder.distant")` |
| `setWeather("snow")` | (ambient wind bed; no rain loop) |
| `setWeather("clear")` | stop the rain loop |

### Light before sound

`strike()` returns a promise that **resolves at the flash peak** — the brightest
moment of the visible flash, ~90ms in. Await it before playing thunder so the audio
lands just after the light, the way real lightning reads:

```js
weather.on("lightningStrike", async (e) => {
  const { far } = await weather.strike({ far: e.detail.far });
  // resolves at the flash peak — play thunder now, right after the visible flash:
  audio.play(far ? "thunder.distant" : "thunder");
});
```

(For storm auto-lightning, `update()` already calls `strike()` for you; subscribe to
the `lightningStrike` event and `await weather.strike(...)` — or await the promise from
your own manual `strike()` call — to time the thunder SFX.)

## Files

| File | Role |
| --- | --- |
| `weather/weather.js` | `WeatherSystem` orchestrator (this API). |
| `weather/effects/rain.js` | `RainEffect` — GPU rain streaks, camera-following volume. |
| `weather/effects/snow.js` | `SnowEffect` — GPU drifting flakes. |
| `weather/effects/lightning.js` | `LightningEffect` — flash envelope + optional bolt. |
| `weather/effects/sky.js` | `SkyController` — background, fog, lights, day/night, flash. |
| `weather/demo.html` | Standalone Three.js harness. |
| `weather/server.mjs` | Zero-dependency static server (`node weather/server.mjs`). |
| `weather/vendor/` | Vendored Three.js r160 + OrbitControls. |
