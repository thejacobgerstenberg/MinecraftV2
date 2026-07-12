# Loomfall — Player Identity & Expression (`avatars-plus/`)

A drop-in **identity & expression** layer for Loomfall players: descriptor-driven
custom skins, an 8-emote expression system, a collision-aware third-person camera,
and health/status/team nameplates. It **reuses** the `../avatars/` rig (model +
animator) unchanged and composes on top of it, and is styled entirely with the
vendored `lf-*` UI kit.

Everything here is **pure native ES modules** — no build step, no npm, no bundler.
Import Three.js via the bare specifier `"three"` (the demo importmap maps it to
`../avatars/vendor/three.module.js`).

---

## Quick start

A zero-dependency static server is bundled:

```bash
node avatars-plus/server.mjs        # PORT env, default 8126
# open http://localhost:8126/       -> avatars-plus/demo.html
```

The demo is the standalone identity/expression harness: a voxel ground with solid
pillars/walls, a local player avatar walking a patrol, a third-person camera you
cycle with **F5**, an emote wheel (**E**) that broadcasts to peer bots, and a
character customizer whose changes live-apply to your avatar and produce the
exported wire string.

---

## How it reuses the rig and the UI kit

- **Rig** (`../avatars/`): `buildAvatarModel(skinSpec)` builds the feet-origin box
  avatar; `Animator(group, parts)` writes the walk/idle pose each frame. This
  package *composes* the rig — it never modifies `avatars/`. Emotes blend **on top
  of** the animator by reading the post-Animator pivot rotations and lerping toward
  a pose by a weight (so they layer over walking and release cleanly).
- **UI kit** (`lf-*`): vendored at `avatars-plus/vendor/ui-kit/` for the standalone
  demo (`tokens.css`, `base.css`, `lf-core.js`, `components/*`). Custom elements
  (`lf-button`, `lf-slider`, `lf-tabs`, `lf-modal`, `lf-toggle`, `lf-tooltip`,
  `lf-progress`, and our `lf-emote-wheel`) are styled only with `--lf-*` tokens.

> **In-game:** the UI kit is vendored here only so the demo stands alone. When you
> integrate into the main client, **repoint** the `./vendor/ui-kit/*` CSS links and
> JS imports at the top-level `ui-kit/` and drop this `vendor/` copy.

---

## Skin descriptor — the wire format

A skin is a compact, **deterministic** descriptor. The same descriptor renders
identically on every client, so peers only need to exchange the descriptor.

**Object shape** (`skin-descriptor.js`):

```js
{
  theme: "warpwold-mender",   // one of THEME_IDS (6 rig themes)
  threadHue: 128,             // int 0..359 — rotates the theme base cloth hue
  weave: 1,                   // int 0..5   — WEAVE_MOTIFS index (cell size/phase)
  accent: 44,                 // int 0..359 — hue of the dark/light weave threads
  accentStrength: 0.6         // 0..1       — how vividly the weave threads read
}
```

`THEME_IDS`: `warpwold-mender`, `cinderloom-scaldwarden`, `nevermend-selvage-warden`,
`everthread-forged`, `frostlace-snowline`, `understitch-unpicked`.
`WEAVE_MOTIFS`: `Plain`, `Twill`, `Basket`, `Herringbone`, `Houndstooth`, `Ripstop`.

**Compact encoded string** — five dotted **base36** fields (the format sent over the
wire):

```
"<themeIndex>.<threadHue>.<weave>.<accent>.<accentPct>"
example:  "0.3k.1.18.3c"
```

- `themeIndex` 0..5 (index into `THEME_IDS`)
- `threadHue` 0..359, `weave` 0..5, `accent` 0..359 (degrees / index)
- `accentPct` = `round(accentStrength * 100)` (0..100)

**API:**

```js
import {
  THEME_IDS, WEAVE_MOTIFS,
  defaultDescriptor, normalizeDescriptor,
  encodeDescriptor, decodeDescriptor,
  buildSkinFromDescriptor,
} from "./skin-descriptor.js";

const d = defaultDescriptor("frostlace-snowline"); // sensible defaults for a theme
const wire = encodeDescriptor(d);                   // -> compact string
const back = decodeDescriptor(wire);                // round-trip stable
const spec = buildSkinFromDescriptor(d);            // SkinSpec for buildAvatarModel
```

- `normalizeDescriptor(d)` clamps/validates and fills missing fields (never throws).
- `buildSkinFromDescriptor(d)` returns a `{ id, name, palette, makeMaterials(), textures[] }`
  SkinSpec compatible with `buildAvatarModel`. It replicates the rig's 64×64
  weave-texture technique in-file (nearest-filter, no mipmaps, repeat-wrapped,
  sRGB) — 3 textures (head/torso/limb) built once, `MeshLambertMaterial` per slot.

---

## Emote system + broadcast contract

`emotes.js` exports `EMOTES` — an ordered registry of 8 original emotes:

| id | glyph | kind |
|----|-------|------|
| `wave` | 👋 | one-shot |
| `nod` | 🙂 | one-shot |
| `sit` | 🪑 | one-shot (hold) |
| `cheer` | 🙌 | one-shot |
| `point` | 👉 | one-shot (hold) |
| `dance` | 🕺 | loop |
| `bow` | 🙇 | one-shot |
| `facepalm` | 🤦 | one-shot |

**Local playback:**

```js
local.emote("wave");   // Promise; resolves when a one-shot ends / a loop is stopped
local.stopEmote();     // eases the active emote out
local.isEmoting();     // bool
local.currentEmote();  // id | null
```

`EmoteController` runs **after** `Animator.update(dt)` each frame, computes a weight
`w` (ease-in ≈0.18s, hold, ease-out ≈0.22s; loops hold at `w=1` until stopped), and
for each channel the emote uses assigns `pivot.rotation.<axis> = lerp(current, target, w)`.

**Broadcast contract (multiplayer):** playing an emote is local; to show it on other
clients, send a message and let each remote client replay it on that peer's avatar:

```jsonc
// sender:
{ "t": "emote", "id": "<playerId>", "emote": "wave" }

// receiver (per client):
peers.receiveEmote(playerId, "wave");   // plays the emote on that peer's avatar
```

The `<lf-emote-wheel>` element fires a bubbling `lf-emote` event `{ detail: { id } }`
on select; the demo calls `local.emote(id)` **and** fans out to every bot via
`peers.receiveEmote(botId, id)`.

---

## Third-person camera

`camera.js` — `ThirdPersonCamera(camera, opts)` drives one perspective camera across
three modes.

```js
const tp = new ThirdPersonCamera(camera, {
  isSolid,              // (x,y,z) => boolean — injected world solidity (see below)
  eyeHeight: 1.62,      // metres above feet
  backDistance: 3.2,
  frontDistance: 2.4,
  collisionRadius: 0.25,
});

tp.setViewMode("third-back");     // "first" | "third-back" | "third-front"
tp.cycleViewMode();               // first -> third-back -> third-front -> first
tp.viewMode;                      // getter
tp.shouldShowLocalAvatar();       // false in first-person (hide the local body)
tp.update(dt, playerFeet, yaw, pitch);
```

- **Eye** = `{ x: feet.x + 0.3, y: feet.y + eyeHeight, z: feet.z + 0.3 }` (the +0.3
  matches the rig's column-centering). `yaw = 0` faces `-Z`; pitch is clamped to
  ±1.2 rad (the rig `PITCH_LIMIT`).
- **third-back / third-front** ray-march from the eye toward the desired boom
  position against `isSolid` and **pull the camera in** to just before the first
  solid cell (minus `collisionRadius`); the boom length is smoothed so pull-in/
  release is not jarring. No per-frame allocation.

**Injected `isSolid`** — the camera does not know your world; you inject solidity.
In-game:

```js
const isSolid = (x, y, z) =>
  getBlockDef(world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))).solid;
```

Hide your own avatar when `shouldShowLocalAvatar()` is false so the body does not
occlude a first-person view.

---

## Nameplate

`nameplate.js` — `makeNameplate({ name, team, self, width?, maxDistance? })` returns a
camera-facing `THREE.Sprite` handle. Anchor it `height + 0.4` above the feet.

```js
const np = makeNameplate({ name: "Thren", team: "a", self: false });
np.setName(text); np.setHealth(cur, max); np.setStatus(text); np.setTeam(team);
np.update(dt, cameraPos, worldAnchorPos);   // distance fade
np.dispose();
```

- **Health bar** is a *bar* (shape), not hue-only: fill width = `cur/max`, colour
  green → amber → red by ratio; optional status glyph/text below the name.
- **Border colour** cues team/self and is paired with position/text: self = brand
  gold, team a = warp-green, team b = madder, neutral = hem border.
- **Distance fade**: full opacity within ~half `maxDistance` (default 48 m), fading
  toward ~0.15 near the limit. `depthWrite: false`, `transparent: true`.
- The canvas is redrawn **only** when name/health/status/team change — never per
  frame.

---

## Peer avatars (`PeerAvatarsPlus`)

`peer-avatars-plus.js` — a **superset drop-in** of the rig's `PeerAvatars`. It adds
per-peer **descriptors** and **`receiveEmote`** on top of the same manager surface,
so it can replace `PeerAvatars` wherever remote players are rendered.

```js
const peers = new PeerAvatarsPlus(scene, { maxDistance: 48 });

peers.upsert({ id, name, x, y, z, yaw, dim, descriptor?, team?, health?, maxHealth?, status? });
peers.move({ id, x, y, z, yaw, dim?, health?, status? });   // finite-checked retarget
peers.remove(id);
peers.setDimension(dim);                                     // visibility filter
peers.receiveEmote(id, emoteId);                             // replay a peer emote
peers.update(dt, cameraPos);                                 // manager-side smoothing
peers.count; peers.ids; peers.dispose();
```

- Unknown ids build a fresh avatar; when no `descriptor` is sent the skin is seeded
  deterministically off the peer `id` (so unnamed peers still look consistent).
- Manager-side smoothing `k = 1 - exp(-12·dt)`, shortest-path yaw, and a derived
  velocity so walk cycles read correctly. Targets are column-centered by +0.3 X/Z.

---

## Assembling one avatar (`createAvatarPlus`)

`avatar-plus.js` composes the whole pipeline into one handle:

```js
import createAvatarPlus from "./avatar-plus.js";

const you = createAvatarPlus({ name: "You", self: true, descriptor, team, maxDistance });
scene.add(you.group);

you.setPosition(x, y, z);        // direct, no smoothing
you.setLook(yaw, pitch);
you.setVelocity(vx, vy, vz);
you.emote("cheer");              // Promise
you.setDescriptor(newDescriptor);// rebuild skin, dispose old materials/textures
you.setName(name); you.setHealth(cur, max); you.setStatus(text); you.setNameVisible(bool);
you.update(dt, cameraPos);       // animator.update -> emote blend -> nameplate fade
you.dispose();
```

Pipeline: `buildSkinFromDescriptor(normalizeDescriptor(descriptor))` →
`buildAvatarModel(spec)` → `makeNameplate(...)` anchored at `height+0.4` →
`new Animator(...)` → `new EmoteController(...)`. **Update order is critical:**
`animator.update(dt)` runs *before* `emoteController.update(dt)`.

---

## Audio pairing

- **Emotes** can trigger a UI/vocal cue on play — hook `local.emote(id)` (or the
  `lf-emote` event) to `audio.play("emote." + id)` / a vocal bark.
- **Footsteps** ride the rig's `onStep` callback: pass `onStep` into
  `createAvatarPlus({ onStep })` and, per footfall, `audio.play("step." + material,
  { pos, velocity })`.

---

## `window.apDemo` (demo harness surface)

The demo exposes a headless-friendly surface:

```
THREE, scene, camera, renderer, local, peers, customizer, tpCamera,
EMOTE_IDS, THEME_IDS,
setViewMode(mode), cycleViewMode(), playEmote(id), stopEmote(),
openCustomizer(), closeCustomizer(),
applyDescriptor(d), getDescriptor(), exportDescriptor(),
getFps(), framePose(mode), captureEmote(id)
```

`framePose(mode)` re-frames the camera in `mode` and renders one frame (returns the
camera position + `showLocal`). `captureEmote(id)` plays an emote and resolves at a
representative mid-pose for screenshot capture.

---

## Files

| File | Purpose |
|------|---------|
| `skin-descriptor.js` | Deterministic skin descriptor: defaults, normalize, encode/decode, `buildSkinFromDescriptor` (SkinSpec + weave textures). |
| `emotes.js` | `EMOTES` registry (8 emotes) + `EmoteController` (blends over the animator). |
| `emote-wheel.js` | `<lf-emote-wheel>` radial menu; emits `lf-emote { id }`. |
| `camera.js` | `ThirdPersonCamera` — first / third-back / third-front + ray-marched collision. |
| `nameplate.js` | `makeNameplate` — canvas sprite with health/status, team/self tint, distance fade. |
| `avatar-plus.js` | `createAvatarPlus` — composes skin + rig + nameplate + animator + emotes into one handle. |
| `peer-avatars-plus.js` | `PeerAvatarsPlus` — superset drop-in of the rig `PeerAvatars` (descriptors + `receiveEmote`). |
| `customizer.js` | `CharacterCustomizer` — `lf-*` UI + live 3D preview; save/load/export descriptors. |
| `demo.html` | Standalone identity/expression harness (`window.apDemo`). |
| `server.mjs` | Zero-dep static server (default port 8126). |
| `README.md` | This guide. |
| `vendor/ui-kit/` | Vendored `lf-*` UI kit (repoint at the top-level `ui-kit/` in-game). |

Depends on the sibling **rig** package at `../avatars/` (`model.js`, `animation.js`,
`skins.js`, `vendor/three.module.js`).
