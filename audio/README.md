# Audio Engine — Integration Guide

A dependency-free, browser-only sound engine for the game. **Every sound is
procedurally synthesized at runtime** from oscillators and colored noise — there
are no audio samples, no assets to load, and nothing under copyright. That means
no network fetches, no decoding, no licensing to worry about: you import one
module and call methods.

This guide is written for the session wiring gameplay events (block break, step,
damage, dimension changes, UI) to sounds. It documents the **actual** exported
API, the complete list of sound names, and a paste-ready event → sound mapping.

---

## Overview

- **Dependency-free.** Pure ES modules, standard Web Audio API. No npm packages.
- **Browser-only.** Needs `AudioContext` (or `webkitAudioContext`). It throws a
  clear error in environments without one.
- **All synthesized.** Block/footstep/environment/UI SFX and both music tracks
  are generated from a seeded PRNG + Web Audio nodes. No `.wav`/`.mp3` files, no
  samples, no copyrighted melodies. Music is original generative composition.
- **Positional.** One-shots can be placed in 3D via a `PannerNode`; a listener
  tracks the player.
- **Verified non-silent / non-clipping** (see the last section).

---

## Quick start

```js
import AudioEngine from "./audio/engine.js";

// Create ONE instance for the whole game and keep it around.
const engine = new AudioEngine();

// Browsers block audio until a user gesture. Resume on the first click/keydown.
window.addEventListener("pointerdown", () => engine.resume(), { once: true });
window.addEventListener("keydown",     () => engine.resume(), { once: true });

// After resume(), you can play sounds:
engine.play("ui.click");
```

**Why `resume()` on a gesture?** Browser autoplay policy starts every
`AudioContext` in a `suspended` state. Until a real user interaction resumes it,
nothing is audible. `engine.resume()` lazily creates the context (if needed) and
resumes it; call it from your first `pointerdown`/`keydown`/`click` handler. It's
safe to call more than once.

**Serving requirement.** ES-module `import` does **not** work over `file://` —
browsers require `http(s)`. A tiny zero-dependency static server ships with the
engine:

```bash
node audio/server.mjs           # serves the repo on http://localhost:8123/
# open http://localhost:8123/   -> loads audio/demo.html
```

`audio/demo.html` is a working demo with buttons for every sound and both music
tracks — use it as a reference and to hear each name.

---

## API surface

The default export is the `AudioEngine` class. Everything below is a method on an
instance.

### `new AudioEngine(opts?)`

```js
const engine = new AudioEngine();            // normal: builds a live context lazily
const engine = new AudioEngine({ ctx });     // advanced: supply your own BaseAudioContext
```

- `opts.ctx` — optional. Pass an existing `AudioContext` / `OfflineAudioContext`
  to render into. Omit it in the game; the engine creates a live context on first
  use (`resume()` or `play()` will do it).

### `resume(): Promise<void>`

Lazily creates the live `AudioContext`, builds the master/sfx/music bus graph,
and resumes the context. **Call from a user gesture.** Safe to call repeatedly.

### `setMasterVolume(v)` / `setSfxVolume(v)` / `setMusicVolume(v)`

Set the gain of the three buses. `v` is clamped to `0..1`. Non-finite values
become `0`. The bus graph is `sfx → master → destination` and
`music → master → destination`, so master scales everything, and sfx/music let
you balance effects against music independently.

```js
engine.setMasterVolume(0.8);
engine.setMusicVolume(0.5);
engine.setSfxVolume(1.0);
```

### `setListener(pos, forward?)`

Positions the audio listener (the "ears") for positional sounds. Call it every
frame with the player's position, and pass a facing vector so panning matches the
camera.

```js
engine.setListener(
  { x: player.x, y: player.y, z: player.z },   // world coords
  { x: Math.sin(yaw), z: Math.cos(yaw) }        // facing (XZ), optional
);
```

- `pos` — `{x, y, z}` in world coordinates.
- `forward` — optional `{x, z}` facing direction (up is assumed `(0,1,0)`).

### `play(name, opts?) → handle`

Play a one-shot (or looping) SFX by registry key. Returns a **handle**
`{ stop(at?) }`. Unknown names return a harmless no-op handle (never throws), so
a typo can't crash the game.

```js
const h = engine.play("break.stone", {
  pos:      { x: 10, y: 64, z: -3 },  // omit for non-positional (UI) sounds
  volume:   1.0,                       // 0..1 per-voice gain (default 1)
  velocity: 0.8,                       // 0..1 intensity; affects loudness/timbre (default 1)
  rng:      seededRandom,              // optional ()=>number PRNG for deterministic output
});

// Looping environment sounds (wind, cave) run until you stop them:
const wind = engine.play("wind", { volume: 0.6 });
wind.stop();          // fades out (~0.8s for wind/cave)
// wind.stop(when);   // optional AudioContext time to stop at
```

| `opts` field | Type | Default | Meaning |
|---|---|---|---|
| `pos` | `{x,y,z}` | none | World position. If given, routed through a 3D panner. Omit → non-positional (plays centered). |
| `volume` | number 0..1 | `1` | Per-voice gain. |
| `velocity` | number 0..1 | `1` | Hit intensity; scales loudness and slightly shapes timbre. |
| `rng` | `()=>number` | `Math.random` | Seed for deterministic renders. |

### `startMusic(mode?, opts?) → controller`

Start a generative music track. Automatically stops any current track first
(short crossfade). Returns a controller `{ stop(fade?) }`.

```js
engine.startMusic("calm");                 // overworld
engine.startMusic("nether", { seed: 42 }); // dimension theme, reproducible
```

- `mode` — `"calm"` (default) or `"nether"`.
- `opts.seed` — integer seed for the composition. Same seed → same piece.
  Defaults: `calm` = `1234`, `nether` = `6660`.
- `opts.fade` — crossfade seconds when replacing a current track (default `0.5`).

### `stopMusic(opts?)`

Fade out and stop the current music track. `opts.fade` = fade seconds (default `2`).

```js
engine.stopMusic();              // 2s fade
engine.stopMusic({ fade: 0.5 }); // quick fade
```

### `stopAll()`

Stop the music and every tracked SFX voice immediately (short fades). Good for
pausing, leaving the world, or resetting.

---

## Sound names

Pull these exact keys into `play(name, …)`. Grouped by family.

### Blocks — break (per material)
`break.stone` · `break.wood` · `break.dirt` · `break.grass` · `break.sand` · `break.glass`

### Blocks — place (per material)
`place.stone` · `place.wood` · `place.dirt` · `place.grass` · `place.sand` · `place.glass`

### Footsteps (per material)
`step.stone` · `step.wood` · `step.dirt` · `step.grass` · `step.sand` · `step.glass`

### Environment / ambience
- `splash` — one-shot water plunk (~0.45s)
- `wind` — **looping** ambient wind (call `handle.stop()` to end)
- `cave` — **looping** eerie cave drone + drips (call `handle.stop()` to end)
- `portal` — one-shot otherworldly whoosh (~1.2s)

### UI / feedback
- `ui.click` — crisp menu/button click
- `hurt` — short player-hurt grunt
- `pop` — bubbly pop (item pickup)

> The six block materials are **stone, wood, dirt, grass, sand, glass** — the
> same set for `break.*`, `place.*`, and `step.*`. Build a key with
> `"break." + material` etc.

---

## Event → sound mapping (for the builder)

| Gameplay event | Call |
|---|---|
| Block **break** | `play("break." + material, { pos, velocity })` |
| Block **place** | `play("place." + material, { pos, velocity })` |
| Player **step** (throttle to ~1 per stride) | `play("step." + material, { pos, velocity })` |
| **Enter water** | `play("splash", { pos })` |
| **Overworld / calm biome** ambience | `startMusic("calm", { seed })` |
| **Nether** dimension | `startMusic("nether", { seed })` + loop `play("wind")` / `play("cave")` for ambience |
| **Portal** use | `play("portal", { pos })` |
| **Take damage** | `play("hurt")` |
| **Menu / button** | `play("ui.click")` |
| **Item pickup** | `play("pop", { pos })` |

### Paste-ready wiring

```js
import AudioEngine from "./audio/engine.js";

const engine = new AudioEngine();
addEventListener("pointerdown", () => engine.resume(), { once: true });

// --- per-frame: keep the listener on the player -----------------------------
function updateAudio(player) {
  engine.setListener(
    { x: player.x, y: player.y, z: player.z },
    { x: Math.sin(player.yaw), z: Math.cos(player.yaw) }
  );
}

// --- block edits ------------------------------------------------------------
function onBlockBreak(block) {
  engine.play("break." + block.material, { pos: block.pos, velocity: 1 });
}
function onBlockPlace(block) {
  engine.play("place." + block.material, { pos: block.pos, velocity: 1 });
}

// --- footsteps (throttled) --------------------------------------------------
let lastStep = 0;
function onPlayerMove(player, groundMaterial, now) {
  if (now - lastStep < 300) return;           // ~1 step per 300ms while walking
  lastStep = now;
  engine.play("step." + groundMaterial, {
    pos: { x: player.x, y: player.y, z: player.z },
    velocity: player.sprinting ? 1 : 0.7,
  });
}

// --- water / combat / pickup / UI ------------------------------------------
const onEnterWater = (pos) => engine.play("splash", { pos });
const onDamage     = ()    => engine.play("hurt");
const onPickup     = (pos) => engine.play("pop", { pos });
const onButton     = ()    => engine.play("ui.click");

// --- dimensions -------------------------------------------------------------
let netherAmb = [];
function enterOverworld() {
  netherAmb.forEach((h) => h.stop());
  netherAmb = [];
  engine.startMusic("calm");
}
function enterNether() {
  engine.startMusic("nether");
  netherAmb = [engine.play("wind", { volume: 0.5 }),
               engine.play("cave", { volume: 0.6 })]; // looping ambience beds
}

function onPortalUse(pos) { engine.play("portal", { pos }); }
```

---

## Notes

### Positional audio
- Pass `pos` in **world coordinates** on any spatial sound (block edits, steps,
  splash, portal, pickup). UI sounds (`ui.click`, `hurt`) are non-positional —
  omit `pos`.
- Call `setListener(pos, forward)` **every frame** with the player's position and
  facing so panning and distance attenuation track the camera. Distance
  attenuation is an inverse model (reference distance ~4, max ~48 world units),
  so nearby edits are loud and far ones fall off naturally.
- The looping beds `wind` / `cave` are typically played **without** `pos`
  (ambient, everywhere). Keep their handles so you can `stop()` them on a
  dimension change.

### Volume channels
- Three independent gains: **master** (everything), **sfx** (all `play()`
  voices), **music** (both tracks). Wire these to your settings sliders with
  `setMasterVolume` / `setSfxVolume` / `setMusicVolume` (each `0..1`).
- `play({ volume })` is an additional per-voice trim on top of the sfx bus.

### Seeding music
- Music is generated from a seed. `startMusic(mode, { seed })` with the **same
  seed** always produces the **same** piece — useful for a per-world theme
  (`seed = worldSeed`) or reproducible captures. Omit `seed` for the built-in
  default (`calm` 1234, `nether` 6660).
- `startMusic` replaces any current track with a short crossfade; you don't need
  to `stopMusic()` first when switching biomes/dimensions.

---

## Verified

Every SFX and both music tracks are checked to produce **non-silent** and
**non-clipping** output: each is rendered through an `OfflineAudioContext` in
**headless Chromium**, and the resulting buffer is asserted to have real signal
(above a silence floor) and to stay within `[-1, 1]` (no clipping). Because
generation is deterministic under a seeded `rng`, these checks are reproducible.
The synth modules are also written to be offline-render-safe (music synchronously
prefills its first several seconds so an offline render is never empty).
