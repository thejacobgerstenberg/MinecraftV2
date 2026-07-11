# Loomfall — Social & Presence Layer

A drop-in multiplayer social layer for the voxel game: a **presence roster** with a
hold-Tab **player list**, a **session feed** (join/leave/dimension toasts), a
**whisper / DM** system with mute & block on top of the broadcast chat, and a
free-fly **spectator camera**. One `SocialLayer` wires the whole feature to the
game's net client and chat.

Everything degrades gracefully: the v1 wire protocol carries only position and
public chat, so ping, team, and skin are *local overlays* today — the layer is
built so a later protocol extension lights them up with no UI rewrite (see
[Presence wire format](#presence-wire-format)).

---

## Quick start

```sh
node social/server.mjs        # PORT env, default 8127
# open http://localhost:8127/  → serves social/demo.html
```

The demo runs a `MockNet` (a fake NetClient) that emits a roster of ~6 players,
then simulates movement, dimension hops, join/leave churn, public chat, incoming
whispers, and **fabricated** ping values so the whole UI is exercised. A THREE
scene (voxel ground + solid pillars) backs the spectator so collision is visible.

Controls: **hold Tab** for the player list · type **`/w Sona hey`** to whisper
(a bot auto-replies) · **`/block Sona`** to hide a player · **Spectate** button
for the free-cam.

---

## What it reuses

- **`../avatars-plus/skin-descriptor.js`** — `buildSkinFromDescriptor()` derives a
  roster swatch from a peer's compact skin descriptor; `defaultDescriptor()` /
  `encodeDescriptor()` are the same wire strings the identity layer already ships.
- **`../avatars-plus` camera pattern** — the spectator borrows the ray-march
  collision *pattern* from `ThirdPersonCamera._marchCollision` but is standalone
  (a free-fly cam, not player-anchored). It does not import avatars-plus.
- **`../avatars` rig / vendored three** — the demo's importmap points `"three"` at
  `../avatars/vendor/three.module.js`, the single shared three build.
- **`social/vendor/ui-kit/` (lf-\*)** — vendored copy of the design-system
  components (`button`, `input`, `chat`, `toast`, `modal`, `dropdown`, `tabs`,
  `tooltip`, `progress`). **In-game, repoint these imports at the top-level
  `ui-kit/`** so there is one canonical copy; the vendored tree exists only so the
  demo is self-contained.

---

## Integration vs the game's real modules

The game already has:

- **`public/src/net/NetClient.js`** — the transport. Surface used here:
  `onState(cb)`, `onPeerJoin(cb)`, `onPeerLeave(cb)`, `onPeerMove(cb)`,
  `onChat(cb)`, `onDisconnect(cb)`, `sendChat(text)`, and a `selfId`.
  `SocialLayer` subscribes to all of them; if a subscribe method returns an
  unsubscribe function, it is tracked and released on `dispose()`.
- **`public/src/ui/chat.js`** — a plain-DOM chat facade,
  `initChat({ onSend }) -> { addMessage, open, close }`.

`SocialLayer` accepts **either** an `<lf-chat>` element **or** any object that
exposes `addMessage(...)` and emits an `lf-send` CustomEvent (`detail.text`) on
send. To use the game's existing chat facade, wrap it in a tiny shim:

```js
import { SocialLayer } from "./social/social.js";
import { NetClient } from "./public/src/net/NetClient.js";
import { initChat } from "./public/src/ui/chat.js";

const net = new NetClient(/* ...url/room... */);

// Adapt the plain-DOM chat into the {addMessage + lf-send} shape SocialLayer wants.
const bus = new EventTarget();
const facade = initChat({ onSend: (text) => bus.dispatchEvent(new CustomEvent("lf-send", { detail: { text } })) });
const chatShim = {
  addMessage: (m) => facade.addMessage(m),                       // {name,text,system}
  addEventListener: (t, fn) => bus.addEventListener(t, fn),
  removeEventListener: (t, fn) => bus.removeEventListener(t, fn),
};

const social = new SocialLayer({
  net,
  chat: chatShim,               // or pass an <lf-chat> element directly
  camera,                       // your THREE camera (enables the spectator)
  isSolid: world.isSolid,       // (x,y,z)=>bool — spectator collision oracle
  mount: document.body,
  selfName: myName,
  localSkin: myDescriptor,      // avatars-plus descriptor for your own swatch
  canvas: renderer.domElement,  // for spectator pointer-lock
});
social.enable();
```

**Important — `SocialLayer` takes over the chat binding.** `main.js` currently
does something like `net.onChat(msg => ui.chat.addMessage(...))`. Remove that:
`SocialLayer` becomes the single render site for public chat so it can run
`whisper.filterPublicChat(msg)` first (dropping blocked senders) before rendering.
Because the server echoes your own chat back via `onChat`, the layer never
locally echoes outbound public messages — it renders only what arrives.

Per-frame, call `social.update(dt)` (advances the spectator when flying). Feed
your own measured latency in with `social.setPing(net.selfId, ms)`, and call
`social.syncSelfDim()` when your local dimension changes (needs `getLocalDim`).

---

## Presence wire format

The layer is designed against a **proposed extension** to the v1 protocol. This
section documents both what the server sends **today** and what it **should** send
for a full presence experience.

### Today (v1)

The server sends, per peer, only the movement/identity fields — no ping, no team,
no skin:

```jsonc
// welcome / peer-join / peer-move  (per peer)
{ "id": "p-sona", "name": "Sona", "x": -4, "y": 0, "z": -4, "yaw": 0, "pitch": 0, "dim": "overworld" }

// chat  (broadcast to the whole room, including the sender)
{ "id": "p-sona", "name": "Sona", "text": "found a loom shrine!" }
```

`dim` is one of `overworld` | `nether` | `end` (displayed as Warpwold / Cinderloom
/ Nevermend). There is **no** private/directed message channel.

### Proposed extensions

- **Presence roster** — a periodic or on-change roster carrying the overlay fields:

  ```jsonc
  { "t": "presence", "players": [ { "id", "name", "dim", "ping", "team?", "skin?" } ] }
  ```

  Today only welcome + peer-join + peer-leave exist, each carrying the v1 fields
  above and nothing more.

- **Ping / latency** — either a dedicated message or an `rtt` field per roster row:

  ```jsonc
  { "t": "ping", "id": "p-sona", "ms": 42 }
  ```

  Today: absent → the list shows **"—"**. A client may self-measure its own RTT and
  feed it in with `social.setPing(selfId, ms)`.

- **Skin descriptor** — peers carry the compact `avatars-plus` skin-descriptor
  string on join, so their custom look renders. Today: absent → the roster swatch
  is derived from a deterministic **hash of the id** (`hashHueHex`), stable across
  clients.

- **Team** — an optional `team` field (`"a"` | `"b"`). Today: team is a purely
  **local** concept set via `presence.setTeam(id, team)`.

### Graceful degradation

| Field | Server sends today | Layer behavior when missing | Add server-side to light it up |
|---|---|---|---|
| **presence roster** | welcome + peer-join/leave with `{id,name,x,y,z,yaw,pitch,dim}` only | Roster is built incrementally from those events; overlays default off | `{t:"presence", players:[…]}` push (periodic or on-change) carrying the overlay fields below |
| **ping** | *nothing* | `ping = null` → UI shows **"—"** (empty meter). `setPing(id, ms)` is a live passthrough | `{t:"ping", id, ms}` (or per-row `rtt`); or client self-measures its own RTT |
| **skin** | *nothing* | Swatch = `hashHueHex(id)`, a deterministic per-id hue | Include the `avatars-plus` descriptor string on peer-join / in the roster row |
| **team** | *nothing* | `team = null` → no team dot/pip; team is a local overlay via `setTeam()` | Optional `team` field on the roster row |

The upshot: the game works **now** against v1, and each server-side field you add
lights up its UI with no client change beyond the new message handler.

---

## Whisper / DM + mute / block

A client-side DM convention layered on the broadcast chat. Commands (typed into
chat):

| Command | Effect |
|---|---|
| `/w <name> <msg>`, `/msg <name> <msg>` | Whisper a player |
| `/r <msg>` | Reply to the last person who whispered you |
| `/mute <name>` / `/unmute <name>` | Hide / show that player's **whispers** |
| `/block <name>` / `/unblock <name>` | Hide / show whispers **and** public chat |

Mute/block sets are **name-keyed** (lowercased — ids are ephemeral per session,
names are what players actually type) and persisted to `localStorage` under
**`loomfall.social`** as `{ muted: [...], blocked: [...] }`.

**Privacy caveat:** the v1 protocol has no directed channel, so a whisper cannot
be truly private. The layer takes an **injectable send transport** (`opts.send`
inside `WhisperController`): wire it to a real directed transport if/when the
server supports one. With no transport, whispers **degrade to local-only** — the
DM is rendered and tagged `🔒 (local only, unsent)` rather than silently
pretending it was delivered.

---

## Spectator free-cam

`SpectatorCamera` + `social.toggleSpectator()` detaches the camera into a
noclip-optional fly-cam:

- **WASD** move · **Space** up · **Ctrl** down · **Shift** boost · **mouse** look
  (pointer lock; click the canvas to capture).
- Collision is **injected**: the camera ray-marches its intended motion against
  the `isSolid(x,y,z)` oracle you pass to `SocialLayer`, so it won't fly through
  blocks (set `collide:false` for true noclip).
- `social.update(dt)` advances it each frame while flying; `isSpectating()`
  reports state; toggling off leaves the camera where you release it (the caller
  owns restoring the player view).

---

## Files

| File | Role |
|---|---|
| `social.js` | `SocialLayer` — the one wire-up entry point |
| `presence.js` | `PresenceStore` — DOM-free roster + local overlays; `dimDisplayName`, `hashHueHex` |
| `player-list.js` | `<lf-player-list>` — hold-Tab roster overlay |
| `session-feed.js` | `SessionFeed` — join/leave/dim toasts + notes |
| `whisper.js` | `WhisperController` — whisper/DM + mute/block |
| `spectator.js` | `SpectatorCamera` — free-fly cam with injected collision |
| `demo.html` | Standalone harness (MockNet + THREE scene) |
| `server.mjs` | Zero-dep static server (PORT 8127) |
| `vendor/ui-kit/` | Vendored lf-\* components (repoint to top-level `ui-kit/` in-game) |

### `window.socialDemo` (headless harness hooks)

Exposed by `demo.html` for automated/headless driving:

| Hook | Effect |
|---|---|
| `THREE`, `scene`, `camera`, `renderer` | The demo's three objects |
| `social`, `mockNet`, `presence`, `whisper` | Live layer instances |
| `showPlayers()` / `hidePlayers()` | Player-list overlay |
| `sendWhisperFromBot(name, text)` | Route an inbound whisper to you |
| `typeChat(text)` | Submit a chat line through the real `lf-send` path |
| `toggleSpectate()` | Toggle the spectator free-cam |
| `forcePing()` | Re-fabricate all pings; returns `[{id,name,ping}]` |
| `getFps()` | Rolling average FPS |
