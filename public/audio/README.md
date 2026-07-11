# Audio Engine — Integration Guide

A dependency-free, browser-only sound engine for the game. **Every sound is
procedurally synthesized at runtime** from oscillators and colored noise — there
are no audio samples, no assets to load, and nothing under copyright. That means
no network fetches, no decoding, no licensing to worry about: you import one
module and call methods.

This guide is written for the session wiring gameplay events (block break, step,
damage, weather, mobs, doors/chests, dimension changes, UI) to sounds. It
documents the **actual** exported API, the complete list of sound names, and a
paste-ready event → sound mapping.

---

## Overview

- **Dependency-free.** Pure ES modules, standard Web Audio API. No npm packages.
- **Browser-only.** Needs `AudioContext` (or `webkitAudioContext`). It throws a
  clear error in environments without one.
- **All synthesized.** All **66 SFX** (blocks, footsteps, environment, weather,
  mobs, UI, extras) and all **five music modes** are generated from a seeded
  PRNG + Web Audio nodes. No `.wav`/`.mp3` files, no samples, no copyrighted
  melodies. Music is original generative composition.
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

`audio/demo.html` is a working demo with buttons for every sound and every music
mode (including a live rain-intensity slider) — use it as a reference and to
hear each name.

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
`{ stop(at?) }` — plus `setIntensity(v, ramp?)` when the sound supports live
control (currently `rain`). Unknown names return a harmless no-op handle (never
throws), so a typo can't crash the game.

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

// Looping rain takes an intensity (0..1) and can be re-ramped while running:
const rain = engine.play("rain", { intensity: 0.5 });
rain.setIntensity(0.9, 2);   // storm picks up over ~2s
rain.stop();                 // ~0.8s fade-out
```

| `opts` field | Type | Default | Meaning |
|---|---|---|---|
| `pos` | `{x,y,z}` | none | World position. If given, routed through a 3D panner. Omit → non-positional (plays centered). |
| `volume` | number 0..1 | `1` | Per-voice gain. |
| `velocity` | number 0..1 | `1` | Hit intensity; scales loudness and slightly shapes timbre. |
| `intensity` | number 0..1 | `0.7` | **`rain` only.** Storm strength: scales drop density, brightness, and level. Ramp it live with `handle.setIntensity(v, ramp?)`. |
| `rng` | `()=>number` | `Math.random` | Seed for deterministic renders. |

### `startMusic(mode?, opts?) → controller`

Start a generative music track. Automatically stops any current track first
(short crossfade). Returns a controller `{ stop(fade?) }`.

```js
engine.startMusic("calm");                 // overworld
engine.startMusic("nether", { seed: 42 }); // dimension theme, reproducible
engine.startMusic("upbeat");               // "music disc" mood
```

- `mode` — one of **five** modes (default `"calm"`; unknown modes fall back to
  `calm`):

| Mode | Mood | Default seed |
|---|---|---|
| `calm` | Gentle overworld theme — slow, sparse, consonant major-pentatonic pads and wandering arps. | `1234` |
| `nether` | Dark and uneasy — a low sustained drone, sparse minor-pentatonic fragments, occasional metallic clangs. | `6660` |
| `upbeat` | Bright and rhythmic — medium-tempo major-pentatonic plucks, a bouncy bass pulse, handclap ticks. Cheerful but background. | `7777` |
| `melancholy` | Slow minor key — sparse piano-ish decaying notes through a gentle echo, long silences, falling phrases. Wistful. | `2468` |
| `mysterious` | Whole-tone shimmer — soft FM bells at irregular intervals over slow detuned pad swells. Unresolved, spacious, strange. | `13579` |

`upbeat` / `melancholy` / `mysterious` are the "music disc" moods (from
`audio/discs.js`) — same architecture and controller shape as the two
dimension themes.

- `opts.seed` — integer seed for the composition. Same seed → same piece.
  Defaults per mode are in the table above.
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

Pull these exact keys into `play(name, …)`. Grouped by family. **66 sounds
total.**

### Blocks — break (per material)
`break.stone` · `break.wood` · `break.dirt` · `break.grass` · `break.sand` · `break.glass` ·
`break.leaves` · `break.gravel` · `break.snow` · `break.metal` · `break.wool`

### Blocks — place (per material)
`place.stone` · `place.wood` · `place.dirt` · `place.grass` · `place.sand` · `place.glass` ·
`place.leaves` · `place.gravel` · `place.snow` · `place.metal` · `place.wool`

### Footsteps (per material)
`step.stone` · `step.wood` · `step.dirt` · `step.grass` · `step.sand` · `step.glass` ·
`step.leaves` · `step.gravel` · `step.snow` · `step.metal` · `step.wool`

### Environment / ambience
- `splash` — one-shot water plunk (~0.45s)
- `wind` — **looping** ambient wind (call `handle.stop()` to end)
- `cave` — **looping** eerie cave drone + drips (call `handle.stop()` to end)
- `portal` — one-shot otherworldly whoosh (~1.2s)

### Weather
- `rain` — **looping** rain: dark wash + bright patter + individual drop ticks.
  Takes `intensity` (0..1, default `0.7`); the handle exposes
  `setIntensity(v, ramp?)` for live storm ramps and `stop()` (~0.8s fade). See
  [Rain usage](#rain-usage) below.
- `thunder` — one-shot **close** thunder crack (~2.6–3.4s): sharp transient +
  sub thump + long rolling rumble tail
- `thunder.distant` — one-shot **far** rolling rumble (~2–3s): no sharp
  transient, just a soft swelling roll

### Mobs (5 archetypes × idle / hurt / death)
Keys follow `mob.<archetype>.<variant>` — e.g. `mob.grazer.idle`,
`mob.groaner.hurt`, `mob.exploder.death`. Variants: **idle** (ambient call),
**hurt** (shorter, sharper, pitched-up), **death** (longer, pitch-falling,
fading). These are original creature voices:

- `mob.grazer.*` — soft warm bleat-ish hum (passive animal)
- `mob.groaner.*` — slow low hostile groan
- `mob.exploder.*` — menacing hiss; its **death** is a fuse sizzle ending in a
  small fizzle-pop (pair with the separate `explosion` key for the boom)
- `mob.screecher.*` — airy high screech (flappy tremolo on idle)
- `mob.trader.*` — melodic murmuring hum syllables

### UI / feedback
- `ui.click` — crisp menu/button click
- `hurt` — short player-hurt grunt
- `pop` — bubbly pop (item pickup)

### Doors / chest / consumables / jingles / explosion
- `door.open` — rising hinge creak + latch click (~0.45s)
- `door.close` — short falling thud + latch click (~0.32s)
- `chest.open` — slower, lower creak ending in a soft lid stop (~0.55s)
- `eat` — three rhythmic munch chomps (~0.7s)
- `drink` — three descending bubbly gulps (~0.8s)
- `levelup` — bright ascending 4-note chime arpeggio (~0.95s)
- `achievement` — short warm original fanfare with a held chord (~1.9s)
- `explosion` — big boom (~2.4s): sub pitch-drop + noise burst + long rumble
  tail, through a soft-clip output stage so it can never clip

> The block materials are **stone, wood, dirt, grass, sand, glass, leaves,
> gravel, snow, metal, wool** — the same eleven for `break.*`, `place.*`, and
> `step.*` (33 keys). Build a key with `"break." + material` etc.; mob keys
> with `"mob." + archetype + "." + variant`.

### Rain usage

`rain` is the one sound with a live control on its handle:

```js
// Start light rain (intensity 0..1 scales drop density, brightness, level):
const rain = engine.play("rain", { intensity: 0.4 });

// Weather intensifies — ramp the running loop, don't restart it:
rain.setIntensity(0.9, 2);   // target intensity, ramp seconds (default 0.5)

// Weather clears:
rain.stop();                 // ~0.8s fade-out
```

Keep the handle for as long as the rain runs — `setIntensity` ramps levels and
filter cutoffs smoothly and future drop ticks follow the new density, so one
loop covers everything from drizzle to downpour.

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
| **Rain starts** | `rain = play("rain", { intensity: 0.5 })` — keep the handle |
| **Storm ramps up / eases off** | `rain.setIntensity(0.9, 2)` |
| **Rain stops** | `rain.stop()` |
| **Lightning strike (near)** | `play("thunder", { pos })` |
| **Lightning (far off)** | `play("thunder.distant")` |
| Mob **ambient call** (throttle per mob) | `play("mob." + species + ".idle", { pos })` |
| Mob **takes damage** | `play("mob." + species + ".hurt", { pos })` |
| Mob **dies** | `play("mob." + species + ".death", { pos })` |
| **Door** opens / closes | `play("door.open", { pos })` / `play("door.close", { pos })` |
| **Chest** opens | `play("chest.open", { pos })` |
| **Eat** food | `play("eat")` |
| **Drink** | `play("drink")` |
| **Level up** | `play("levelup")` |
| **Achievement** unlocked | `play("achievement")` |
| **Explosion** (TNT, exploder mob) | `play("explosion", { pos })` |
| **Jukebox / mood music** | `startMusic("upbeat" \| "melancholy" \| "mysterious")` |

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

// --- weather -----------------------------------------------------------------
let rain = null;
function onWeatherChange(state) {           // "clear" | "rain" | "storm"
  if (state === "clear") {
    if (rain) { rain.stop(); rain = null; }
    return;
  }
  const intensity = state === "storm" ? 0.9 : 0.5;
  if (rain) rain.setIntensity(intensity, 2);      // ramp the running loop
  else      rain = engine.play("rain", { intensity });
}
const onLightning = (pos, far) =>
  far ? engine.play("thunder.distant") : engine.play("thunder", { pos });

// --- mobs (species: grazer | groaner | exploder | screecher | trader) --------
const onMobIdle  = (mob) => engine.play("mob." + mob.species + ".idle",  { pos: mob.pos, volume: 0.8 });
const onMobHurt  = (mob) => engine.play("mob." + mob.species + ".hurt",  { pos: mob.pos });
const onMobDeath = (mob) => engine.play("mob." + mob.species + ".death", { pos: mob.pos });

// --- doors / chest / consumables / progress ----------------------------------
const onDoorOpen    = (pos) => engine.play("door.open",  { pos });
const onDoorClose   = (pos) => engine.play("door.close", { pos });
const onChestOpen   = (pos) => engine.play("chest.open", { pos });
const onEat         = ()    => engine.play("eat");
const onDrink       = ()    => engine.play("drink");
const onLevelUp     = ()    => engine.play("levelup");
const onAchievement = ()    => engine.play("achievement");
const onExplosion   = (pos) => engine.play("explosion", { pos });
```

---

## Volume settings widget

`audio/volume-settings.js` ships a drop-in `<volume-settings>` custom element:
three labeled sliders (Master / SFX / Music) wired straight to the engine's
buses. No framework, no CSS to write — it renders in its own shadow root with
self-contained dark styling.

```js
import "./audio/volume-settings.js";   // side effect: defines <volume-settings>

const el = document.createElement("volume-settings");
document.body.appendChild(el);         // or write <volume-settings></volume-settings> in HTML
el.engine = engine;                    // wire the sliders to your AudioEngine
```

- Sliders are `0..1` (step `0.01`) and call `setMasterVolume` / `setSfxVolume` /
  `setMusicVolume` on input.
- Values **persist to `localStorage`** (key `"audio.volumes"`, JSON
  `{ master, sfx, music }`) and are **re-applied to the engine every time
  `.engine` is assigned** — the player's mix survives reloads with zero extra
  wiring.
- Safe before/without an engine: the sliders render and remember their values,
  they just drive nothing until `.engine` is set. Assign `null` to detach.
- The element class is also the module's default export (`volumes` getter
  returns the current `{ master, sfx, music }`).

---

## Notes

### Positional audio
- Pass `pos` in **world coordinates** on any spatial sound (block edits, steps,
  splash, portal, pickup, mob calls, doors, chest, explosion, close `thunder`).
  UI/feedback sounds (`ui.click`, `hurt`, `eat`, `drink`, `levelup`,
  `achievement`) are non-positional — omit `pos`. `thunder.distant` reads
  better non-positional too (it's "everywhere far away").
- Call `setListener(pos, forward)` **every frame** with the player's position and
  facing so panning and distance attenuation track the camera. Distance
  attenuation is an inverse model (reference distance ~4, max ~48 world units),
  so nearby edits are loud and far ones fall off naturally.
- The looping beds `wind` / `cave` / `rain` are typically played **without**
  `pos` (ambient, everywhere). Keep their handles so you can `stop()` them on a
  dimension/weather change (and `setIntensity` the rain).

### Volume channels
- Three independent gains: **master** (everything), **sfx** (all `play()`
  voices), **music** (all modes). Wire these to your settings sliders with
  `setMasterVolume` / `setSfxVolume` / `setMusicVolume` (each `0..1`) — or skip
  building sliders and drop in the `<volume-settings>` widget (see above),
  which persists the mix to `localStorage` for free.
- `play({ volume })` is an additional per-voice trim on top of the sfx bus.

### Seeding music
- Music is generated from a seed. `startMusic(mode, { seed })` with the **same
  seed** always produces the **same** piece — useful for a per-world theme
  (`seed = worldSeed`) or reproducible captures. Omit `seed` for the built-in
  defaults (`calm` 1234, `nether` 6660, `upbeat` 7777, `melancholy` 2468,
  `mysterious` 13579).
- `startMusic` replaces any current track with a short crossfade; you don't need
  to `stopMusic()` first when switching biomes/dimensions.

---

## Verified

Every SFX (all 66) and every music mode (all five) are checked to produce
**non-silent** and **non-clipping** output: each is rendered through an `OfflineAudioContext` in
**headless Chromium**, and the resulting buffer is asserted to have real signal
(above a silence floor) and to stay within `[-1, 1]` (no clipping). Because
generation is deterministic under a seeded `rng`, these checks are reproducible.
The synth modules are also written to be offline-render-safe (music synchronously
prefills its first several seconds so an offline render is never empty).
