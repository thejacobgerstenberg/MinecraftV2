# Loomfall Avatars

A standalone, drop-in **remote-player avatar renderer** for the Loomfall voxel
game (repo `MinecraftV2`). It replaces the old flat-box `PeerAvatars` renderer
with a jointed box-rig that has **legs + arms**, a **velocity-driven walk cycle**,
**head pitch**, a **one-shot swing** (block break/place), and **deterministic
procedural Loomfall skins** (woven warp/weft thread textures). Camera-facing
canvas name-tags are included.

Pure native **ES modules** — no build step, no npm deps, no bundler.

---

## Quick start

ES modules must be served over HTTP (not `file://`). A zero-dependency static
server is bundled:

```sh
node avatars/server.mjs        # PORT env, default 8125
# open http://localhost:8125/  -> avatars/demo.html
```

The demo spawns one bot per skin theme, patrols them on a ring, drives
`setPosition / setVelocity / setLook / swing`, and exposes a headless harness
surface at `window.avatarsDemo`.

---

## The `three` importmap requirement

Every **package** module (`avatars.js`, `model.js`, `skins.js`, `nametag.js`,
`animation.js`) imports Three.js via the **bare specifier only**:

```js
import * as THREE from "three";
```

The **host app must provide an importmap** mapping `"three"` to its own
Three.js build (r160+). The package uses only stable r160 APIs (`Group`, `Mesh`,
`BoxGeometry`, `MeshLambertMaterial`, `CanvasTexture`, `SpriteMaterial`,
`Sprite`, `Color`, `InstancedMesh`). All lit surfaces are `MeshLambertMaterial`
with `NearestFilter` pixel-art textures to match the game's block look.

> The bundled `avatars/demo.html` vendors Three.js under `avatars/vendor/` and
> maps `"three"` **and** `"three/addons/controls/OrbitControls.js"` in its own
> importmap. That addon is used by the **demo only** — the package never imports
> `./vendor/...` and never imports any `three/addons`.

---

## API reference

```js
import { createAvatar, resolveSkin, SKIN_THEMES } from "./avatars/avatars.js";
// createAvatar is also the default export.
```

### `createAvatar(opts = {}) -> AvatarHandle`

| opt        | type                     | default          | meaning                                                        |
| ---------- | ------------------------ | ---------------- | -------------------------------------------------------------- |
| `name`     | `string`                 | `""`             | Display name (also the default skin seed).                     |
| `skinSeed` | `string \| number`       | `name` → `"anon"`| Deterministic skin seed (see guarantee below).                 |
| `onStep`   | `(foot: 0\|1) => void`   | —                | Footstep hook, fired each foot-plant while walking.            |

Assembles: `resolveSkin(seed)` → `buildAvatarModel(spec)` →
`makeNameTag(name)` (anchored `height + 0.4` above the feet, added to the group)
→ `new Animator(group, parts, { onStep })`. All geometry/materials/textures are
created **once** here. Construction never throws.

### `AvatarHandle`

| member                         | signature                          | notes                                                                                                   |
| ------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `group`                        | `THREE.Group`                      | **Feet-origin**: soles at `y=0`, crown ~`1.8`, centred on `x=0,z=0`. Do `scene.add(handle.group)`.      |
| `setPosition(x, y, z)`         | `(number,number,number) => void`   | Sets `group.position` **directly** to feet coords. **No smoothing** — the builder interpolates.         |
| `setLook(yaw, pitch)`          | `(number,number) => void`          | Body (group) yaws to `yaw`; head pitches to `pitch` (clamped ~±1.2 rad). Eased in `update`.              |
| `setVelocity(vx, vy, vz)`      | `(number,number,number) => void`   | Stored; drives walk↔idle blend + stride amplitude (speed = horizontal magnitude). Does **not** move.    |
| `swing()`                      | `() => void`                       | One-shot arm swing (block break/place). Retriggerable.                                                   |
| `update(dt)`                   | `(number) => void`                 | Advance animation + apply eased look. **No per-frame allocations.**                                      |
| `setNameVisible(visible)`      | `(boolean) => void`                | Toggle the name-tag sprite.                                                                              |
| `dispose()`                    | `() => void`                       | Removes group from parent; frees **all** geometry/materials/textures (name-tag texture included). Idempotent. |
| `name`                         | `string`                           | Display name.                                                                                           |
| `skinId`                       | `string`                           | Resolved skin theme id.                                                                                 |

### Re-exports

- `resolveSkin(skinSeed) -> SkinSpec` — deterministic skin resolution.
- `SKIN_THEMES` — array of `{ id, name, blurb }` for building a gallery.

---

## Drop-in adapter: `PeerAvatars`

`avatars/peer-avatars.js` is a **scene-owning remote-player manager** whose API
is a **literal file-replacement** for the game's existing
`public/src/net/PeerAvatars.js`. Where `createAvatar` is the per-avatar
primitive, `PeerAvatars` is the manager the current host wires — the two layers
coexist.

```js
import { PeerAvatars } from "./peer-avatars.js"; // default export also available
const peers = new PeerAvatars(scene);

peers.upsert({ id: "p1", name: "Wren", x: 10, y: 64, z: -4, yaw: 1.2, dim: "overworld" });
peers.move({ id: "p1", x: 11, y: 64, z: -4, yaw: 1.4 }); // retarget
peers.setDimension("nether");   // show only peers whose dim === "nether"
peers.remove("p1");             // dispose + detach

// once per frame:
peers.update(dt);

peers.count; // number of peers
peers.ids;   // array of id strings
peers.dispose(); // remove + dispose every peer
```

| method                                   | behaviour                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `upsert({id,name,x,y,z,yaw,dim})`        | Add (unknown id) or retarget (known id). Ignores null/undefined id. Tolerates extra fields (e.g. `pitch`). |
| `move({id,x,y,z,yaw,dim})`               | Retarget the lerp target. Applies each of `x/y/z/yaw` only if `Number.isFinite`, `dim` only if a non-empty string. No-op for unknown id. |
| `remove(id)`                             | `handle.dispose()` (frees geometry/materials/textures) + `scene.remove(group)` + delete.           |
| `setDimension(dim)`                      | Store the local dim; set each `group.visible = (entry.dim === dim)`.                                |
| `update(dt)`                             | Manager-side smoothing + look + animation (see below).                                             |
| `get count` / `get ids`                  | Peer count / array of id strings.                                                                  |
| `dispose()`                              | Remove + dispose every peer, clear the Map.                                                        |

**Key behaviours:**

- **Deterministic skins seeded off the network `id`** — each peer is created with
  `createAvatar({ name, skinSeed: id })`, so every client renders the same peer
  identically (the `id` is the seed, not a separate `skinSeed` field).
- **Manager-side smoothing** — `update(dt)` eases current → target with
  `k = 1 - e^(-12·dt)`; yaw follows the shortest angular path via
  `atan2(sin, cos)`. The smoothed feet position is pushed with
  `handle.setPosition`, and the **walk animation is derived from the position
  delta** (`velocity = (cur − prevCur)/dt`, guarded on `dt > 0`) via
  `handle.setVelocity` — no transport velocity required. Look is **yaw-only**
  (`handle.setLook(yaw, 0)`); peers don't send pitch. Zero per-frame allocations.
- **Column-centering** — incoming `x/z` are block/feet coords whose column AABB
  is 0.6 wide; the adapter adds **`+0.3`** to both X and Z to centre the avatar
  in its column (matching the host). `y` (feet height) is used as-is.
- **`group.name = \`peer:${id}\`** — so QA hooks resolve:
  `scene.getObjectByName('peer:<id>')` returns the avatar group, and a host that
  exposes the manager as `__game.peers` gets working `.count` / `.ids`.
- **Never throws** — dispose is wrapped in `try/catch`, unknown ids are tolerated.

### Integration

`peer-avatars.js` imports its sibling modules relatively (`./avatars.js` →
`./model.js`, `./skins.js`, …), so drop the **whole `avatars/` folder** into the
game tree (e.g. `public/src/avatars/`), then either import `PeerAvatars` from
there directly, or replace `public/src/net/PeerAvatars.js` with a one-line
re-export:

```js
export { PeerAvatars } from '../avatars/peer-avatars.js';
```

Because the surface matches exactly, no call-site changes are needed — the host
keeps calling `upsert / move / remove / setDimension / update / dispose` and
reading `.count` / `.ids`.

---

## Deterministic `skinSeed` guarantee

The **same `skinSeed`** (string or number) renders the **byte-identical skin on
every client**. The seed is FNV-1a hashed; the hash both selects a theme and
drives every per-avatar variation (hue/sat/light jitter, weave pattern offset).
The woven texture grain uses a hash-seeded PRNG (`mulberry32`) — **no
`Math.random` anywhere on the appearance path**. `skinSeed` defaults to `name`,
then `"anon"`.

---

## Skin themes (Loomfall lore)

Reality is woven cloth on a great Loom; loose threads fall to the void.

| id                          | name                       | lore                                                                              |
| --------------------------- | -------------------------- | --------------------------------------------------------------------------------- |
| `warpwold-mender`           | Warpwold Mender            | Overworld thread come loose — embroidered greens over dawn-earth. The player kind. |
| `cinderloom-scaldwarden`    | Cinderloom Scaldwarden     | Furnace-realm warden in molten red + ash-black; seams smoulder (faint emissive).  |
| `nevermend-selvage-warden`  | Nevermend Selvage-Warden   | Keeper of the world's-edge tapestry — cold violet + ghost-pale, unlit.            |
| `everthread-forged`         | Everthread Forged          | Bearer of the oldest molten-forged thread — brilliant gold-orange, glows.         |
| `frostlace-snowline`        | Frostlace Snowline         | Brittle icelace along the snowline — white-blue threads, cold light.              |
| `understitch-unpicked`      | Understitch Unpicked       | A figure being unpicked from the pattern — desaturated tan-grey, doubled weave.   |

Motif: **warp** (vertical foundation threads) + **weft** (horizontal cross-threads)
= a subtle woven/plaid grain, baked once per avatar to a 64×64 `CanvasTexture`.

---

## Compatibility / deltas vs `PeerAvatars`

The prior renderer (`public/src/net/PeerAvatars.js`, branch
`feat/voxel-sandbox-game`) was a **manager** over all peers:

- API: `upsert({ id, name, x, y, z, yaw, dim })`, `move({ id, x, y, z, yaw })`,
  `remove(id)`, `setDimension(dim)`, `update(dt)`, `dispose()`.
- Rendering: **flat Lambert boxes** (head + body only), **yaw-only** (no pitch,
  no limbs, no walk cycle), canvas-sprite name tags.
- Coordinates: **`+0.3` column-centering** applied internally (world column →
  avatar centre).

**This package is different in shape and richer in behaviour:**

| aspect         | PeerAvatars (old)                       | Loomfall Avatars (this)                                              |
| -------------- | --------------------------------------- | ------------------------------------------------------------------- |
| unit           | one manager for **all** peers           | **factory per avatar** (`createAvatar` → handle)                     |
| origin         | body-centre + internal `+0.3` centering | **feet-origin** at the group origin; **builder maps coords/centering** |
| smoothing      | internal position lerp                  | **none** — `setPosition` is direct; builder interpolates             |
| rig            | head + body boxes                       | head + torso + **2 arms + 2 legs**, pivot joints, neck gap, tuft, pauldrons |
| motion         | yaw only                                | yaw **+ head pitch** + **velocity-driven walk↔idle** + **swing**    |
| skins          | flat colors                             | **deterministic procedural Loomfall weave** (6+ themes)             |
| audio hook     | none                                    | **`onStep(foot)`** footstep hook                                     |

Because centering/coords now live on the **builder** side, wrap the factory in a
manager that reproduces the old surface:

```js
// Builder-side adapter: old PeerAvatars manager API over the new factory.
import { createAvatar } from "./avatars/avatars.js";

class PeerAvatarManager {
  constructor(scene) { this.scene = scene; this.peers = new Map(); }

  upsert({ id, name, x, y, z, yaw, dim }) {
    let a = this.peers.get(id);
    if (!a) {
      a = createAvatar({
        name,
        skinSeed: id, // stable per peer -> identical skin everywhere
        onStep: (foot) => engine.play("step." + this.materialUnder(x, y, z),
                                       { pos: a.group.position, velocity: 1 }),
      });
      this.scene.add(a.group);
      this.peers.set(id, a);
    }
    // builder owns centering: e.g. +0.3 column centre, feet at block top
    a.setPosition(x + 0.3, y, z + 0.3);
    a.setLook(yaw, 0);
    return a;
  }

  move({ id, x, y, z, yaw, pitch = 0, vx = 0, vy = 0, vz = 0 }) {
    const a = this.peers.get(id);
    if (!a) return;
    a.setPosition(x + 0.3, y, z + 0.3); // already-lerped feet coords each frame
    a.setLook(yaw, pitch);
    a.setVelocity(vx, vy, vz);          // drives the walk cycle automatically
  }

  remove(id) {
    const a = this.peers.get(id);
    if (a) { a.dispose(); this.peers.delete(id); } // frees geo/mat/textures + detaches
  }

  update(dt) { for (const a of this.peers.values()) a.update(dt); }

  dispose() { for (const a of this.peers.values()) a.dispose(); this.peers.clear(); }
}
```

If a peer's transport doesn't carry velocity, derive it builder-side from the
frame delta (`(cur - prev) / dt`) and pass it to `setVelocity` — that's exactly
what `demo.html` does.

---

## Audio pairing

The animator's footstep hook is where the builder fires step SFX. Footsteps use
**dot-namespaced** keys `step.<material>`:

| trigger                          | fire                                                                             | material set                                  |
| -------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------- |
| `onStep(foot)` (each foot-plant) | `engine.play("step." + material, { pos: avatar.group.position, velocity })`      | `stone`, `wood`, `dirt`, `grass`, `sand`, `glass` |
| `swing()` (block break/place)    | `engine.play("block.break" / "block.place", { pos: avatar.group.position })`     | —                                             |

`material` is resolved by the builder from the block the avatar stands on. This
mirrors the audio engine at `audio/engine.js` (branch `feature/audio-engine`).

```js
const a = createAvatar({
  name,
  skinSeed: id,
  onStep: (foot) => {
    const mat = worldMaterialUnder(a.group.position); // "grass", "stone", ...
    engine.play("step." + mat, { pos: a.group.position, velocity });
  },
});
```
