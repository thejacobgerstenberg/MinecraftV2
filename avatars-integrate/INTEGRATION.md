# PlayerStack Integration Guide

Land the whole player / multiplayer-presence stack — **avatars** (#11) + **avatars-plus**
(#14) + **social** (#15) — into the builder's voxel game as **ONE drop-in** via
`avatars-integrate/integrate.js` (`PlayerStack`).

Everything below is **code-verified** against the builder's real, unmodified modules
(`net/NetClient.js`, `engine/World.js`, `blocks/blocks.js`, `ui/chat.js`) from
`feat/voxel-sandbox-game @ 71689cf`. A headless proof
(`avatars-integrate/demo.html`) already renders a wire-driven peer with a synced skin,
a networked-emote hook, a nameplate, and real chat with **zero console errors and zero
source edits** — see [PROOF](#proof).

---

## TL;DR

**3 PRs → one drop-in. ~10 lines in `main.js`.**

`PlayerStack` is the single owner of the NetClient's (single-slot) callbacks. It fans
every net event out to BOTH the avatar renderer (`PeerAvatarsPlus`) and the social
presence layer (`SocialLayer`: player list, whisper, spectator). You construct it once,
call `setNet(net)` **before** `net.connect(...)`, then `update(dt)` / `dispose()`.

The minimal adopted `main.js` (only the load-bearing lines shown):

```js
// L28 — was: import { PeerAvatars } from './net/PeerAvatars.js';
import { PlayerStack } from '../../avatars-integrate/integrate.js';

// --- world bootstrap (reorder so the stack owns the net BEFORE connect) ------
const net = new NetClient();                                   // L621 (unchanged)

// was L653: const peers = new PeerAvatars(scene);
const stack = PlayerStack.init({
  net, scene, camera,
  chat: ui.chat,                 // the real initChat() handle
  world, getBlockDef,            // real World + real block-def → exact isSolid
  mount: document.body,
  localName: getPlayerName(),
  localSkin: /* optional descriptor or encoded string */ undefined,
  getLocalFeet: () => ({ x: S.pos.x, y: S.pos.y, z: S.pos.z }),
  getLocalLook: () => ({ yaw: S.yaw, pitch: S.pitch }),
  getLocalDim:  () => S.dim,
});
S.stack = stack;

// connect AFTER the stack is bound: onState (welcome) now seeds peers itself.
const welcome = await net.connect(location.origin, worldMeta.id, getPlayerName(), dim); // L622

// REMOVE the old peer bindings (L784, L785, L787–790, L791, L792, L831) —
// PlayerStack owns onState/onPeerJoin/onPeerLeave/onPeerMove/onChat.

// per-frame + teardown:
S.stack.update(dt);   // was L1377: S.peers.update(dt)
S.stack.dispose();    // was L1498: S.peers.dispose()
```

That's it. After the swap you have custom-avatar peers + nameplates + player list +
whisper filtering + spectator camera, with **zero server changes**. Two optional steps
(6 & 7) light up **synced skins** and **networked emotes**.

---

## Prereqs

Land these PRs (or copy the folders — see Step 1). Stack build order matters:
**#11 ← #14 ← #15** (avatars-plus imports avatars; social + integrate import avatars-plus).

| PR | Package | Provides |
|----|---------|----------|
| #10 | `ui-kit/` | shared `lf-*` design tokens + components (player list, toasts, chat CSS) |
| #11 | `avatars/` | base voxel avatar model, skins, nametag, animation |
| #14 | `avatars-plus/` | `PeerAvatarsPlus`, `ThirdPersonCamera`, skin descriptor, emotes, customizer |
| #15 | `social/` | `SocialLayer`: presence store, whisper, player list, session feed, spectator |
| —  | `avatars-integrate/integrate.js` | `PlayerStack` facade (this drop-in) |

The packages import three as the bare specifier `"three"`, which resolves under the
game's importmap (`"three" -> ./vendor/three.module.js`, r185). Keep a **single** three
instance — see Step 8.

---

## Step-by-step

Each step is individually revertible and safe to stop after. Line numbers are the swap
sites in `public/src/main.js` @ `71689cf`.

### 1. Copy the packages into the game tree

Copy these folders to the repo root (siblings of `public/`, matching how `integrate.js`
resolves `../avatars-plus/...` and `../social/...`):

```
avatars/            (PR #11)
avatars-plus/       (PR #14)
social/             (PR #15)
avatars-integrate/  (integrate.js — at minimum integrate.js)
```

The standalone demos vendor a copy of the `lf-*` ui-kit under
`avatars-plus/vendor/ui-kit` and `social/vendor/ui-kit`. In-game you can either leave
those vendored, or repoint them to the top-level `ui-kit/` (PR #10) to avoid duplicate
copies (see Step 8).

**Revert:** delete the copied folders.

### 2. Import `PlayerStack` in `main.js`

Replace the `PeerAvatars` import at **L28**:

```js
// - import { PeerAvatars } from './net/PeerAvatars.js';
+ import { PlayerStack } from '../../avatars-integrate/integrate.js';
```

(Or keep the `PeerAvatars` import and leave it unused — either works.)

**Revert:** remove the `PlayerStack` import (restore the `PeerAvatars` import).

### 3. Swap `PeerAvatars` → `PlayerStack.init({...})` and reorder net ownership

**This is the load-bearing step.** The real `NetClient.connect()` calls
`this._cb.state(msg)` and resolves with `welcome` **the moment the welcome frame
arrives** (`NetClient.js` L76–85) — i.e. `onState` fires **during** `connect`, before
today's peer bindings at L784+ are attached. So the stack must own `onState` **before**
`connect` is awaited.

Reorder the bootstrap so the stack is built and bound **before** `net.connect`:

```js
const net = new NetClient();                        // L621 (keep)

// was L653: const peers = new PeerAvatars(scene);
const stack = PlayerStack.init({
  net,                          // stack.setNet(net) runs in the constructor
  scene, camera,
  chat: ui.chat,
  world, getBlockDef,           // World from engine/World.js, getBlockDef from blocks/blocks.js
  mount: document.body,
  localName: getPlayerName(),
  localSkin: undefined,         // optional; set later via stack.setLocalSkin(...)
  getLocalFeet: () => ({ x: S.pos.x, y: S.pos.y, z: S.pos.z }),
  getLocalLook: () => ({ yaw: S.yaw, pitch: S.pitch }),
  getLocalDim:  () => S.dim,
});
S.stack = stack;

// L622 — now AFTER the stack: onState catches the welcome and seeds peers.
const welcome = await net.connect(location.origin, worldMeta.id, getPlayerName(), dim);
```

If you cannot move `connect` earlier for other reasons, the fallback is to construct the
stack, `await` connect, then seed once from the returned `welcome`
(`for (const p of welcome.peers || []) stack.peersManager.upsert(p)`). The recommended
path is the reorder above — it needs no manual seeding.

`isSolid` is derived automatically from `world + getBlockDef`:
`(x,y,z) => getBlockDef(world.getBlock(⌊x⌋,⌊y⌋,⌊z⌋)).solid` — **verified identical to
`physics.js` isSolid**. Pass `world` and `getBlockDef`; do not pass an explicit
`isSolid` unless you want to override it.

**Revert:** restore `const peers = new PeerAvatars(scene);` at L653 and the original
L621/L622/L653 order.

### 4. Remove the now-duplicated net bindings

`PlayerStack.setNet()` is the sole owner of these callbacks (the NetClient uses
single-slot callbacks — re-binding clobbers). Remove:

| Line | Original | Why remove |
|------|----------|-----------|
| L784 | `for (const p of welcome.peers \|\| []) peers.upsert(p);` | `onState` seeds peers (Step 3 ordering) |
| L785 | `peers.setDimension(S.dim);` | stack applies the local dim on each peer event |
| L787–790 | `net.onPeerJoin((msg) => { peers.upsert(msg); peers.setDimension(S.dim); });` | stack binds `onPeerJoin` |
| L791 | `net.onPeerLeave((msg) => peers.remove(msg.id));` | stack binds `onPeerLeave` |
| L792 | `net.onPeerMove((msg) => peers.move(msg));` | stack binds `onPeerMove` |
| L831 | `net.onChat((msg) => ui.chat.addMessage({ name: msg.name, text: msg.text }));` | stack binds `onChat`, filtered through the whisper block-list, then `chat.addMessage` |

`S.peers.setDimension(dimId)` at **L1746** can be removed or kept harmlessly — the stack
tracks the local dim via `getLocalDim` and applies it on every peer event.

**Revert:** restore each removed line.

### 5. Replace the per-frame update and teardown

```js
// L1377:  S.peers.update(dt);   →  S.stack.update(dt);
// L1498:  S.peers.dispose();    →  S.stack.dispose();
```

`update(dt)` advances peer avatars, the social layer, and (given `getLocalFeet` +
`getLocalLook`) the third-person camera. `dispose()` detaches the stack's net callbacks
and tears down peers / social / camera / customizer (idempotent).

**Revert:** restore `S.peers.update(dt)` / `S.peers.dispose()`.

> **After steps 1–5** you have working custom-avatar peers, nameplates, player list,
> whispers, and spectator — with **zero server changes**. Skins fall back to a
> deterministic hash-of-id swatch, and emotes are local-only. Steps 6–7 light up synced
> skins and networked emotes.

### 6. (Optional enhancement) Skin-on-join

Today the join frame is `{ t:'join', worldId, name, dim }` (`NetClient.js` L62) — no
skin field. To sync the local player's custom skin to peers:

**Client** — attach the encoded descriptor returned by `stack.setLocalSkin(...)` to the
join payload. Simplest: pass the encoded string into `connect` and add it to the frame.

```js
// NetClient.js — connect(url, worldId, name, dim, skin='') ; L62 onopen:
ws.send(JSON.stringify({ t: 'join', worldId, name, dim: this._dim, skin }));
```

```js
// main.js — before connect:
const encodedSkin = stack.setLocalSkin(localDescriptor);   // compact encoded string
const welcome = await net.connect(location.origin, worldMeta.id, getPlayerName(), dim, encodedSkin);
```

**Server** — echo the `skin` string into `welcome.peers[]` and each `peer-join` frame.

Then `PlayerStack` renders custom peer skins automatically: its `_peerMsg()` decodes
`msg.skin` (encoded string) or passes through `msg.descriptor` (object) to
`PeerAvatarsPlus`. Until the server echoes it, peers fall back to the hash-of-id swatch.

**Revert:** drop the `skin` field from the join frame and the server echo.

### 7. (Optional enhancement) Emote wire

`NetClient` has **no** emote path. Add these four pieces:

```js
// NetClient.js — outgoing frame:
sendEmote(name) { this._send({ t: 'emote', name }); }

// NetClient.js — _dispatch() switch, add a case:
case 'emote': if (this._cb.emote) this._cb.emote(msg); break;

// NetClient.js — constructor this._cb: add `emote: null,`
// NetClient.js — registrar:
onEmote(cb) { this._cb.emote = cb; return this; }
```

```js
// main.js — wire both directions to the facade hooks:
stack.onEmoteTransport((id) => net.sendEmote(id));            // OUTGOING
net.onEmote((msg) => stack.receivePeerEmote(msg.id, msg.name)); // INCOMING
```

`PlayerStack.emote(id)` plays locally and forwards to the transport; incoming frames
call `receivePeerEmote(id, emoteId)`, which plays the emote on the remote peer's avatar.
The facade hooks are already in place (verified in the proof) — only the NetClient
additions are needed.

**Revert:** drop `sendEmote` / the `emote` case / `onEmote` / the two `main.js` bindings.

### 8. (Optional) Single-three / ui-kit repoint

Ensure `"three"` resolves to **one** instance. The game importmap already maps
`"three" -> ./vendor/three.module.js` (r185); the packages import bare `"three"`, so
they resolve to the same module — do **not** add a second three mapping. Duplicate three
copies break `instanceof` checks across module boundaries.

Repoint the vendored `lf-*` ui-kit (`avatars-plus/vendor/ui-kit`,
`social/vendor/ui-kit`) to the top-level `ui-kit/` (PR #10) to avoid duplicate CSS/asset
copies — or leave them vendored (both work; vendored is self-contained, repointed is
DRY).

**Revert:** restore the vendored ui-kit references / any extra importmap entry.

---

## PROOF

`avatars-integrate/demo.html` is a headless proof that imports the builder's **real,
unmodified** modules and drives `PlayerStack` through the genuine protocol:

- `net/NetClient.js` — the single net owner, driven by a `MockWS` (swaps the global
  `WebSocket`) fed **real** protocol frames (`welcome`, `peer-join`, `move`, `chat`).
- `engine/World.js` — a real voxel store painted with a floor + pillars → the `isSolid`
  oracle.
- `blocks/blocks.js` — real `getBlockDef` → block solidity.
- `ui/chat.js` — the real chat log.

Screenshots: `docs/screenshots/proof.png` (peer with synced skin + nameplate),
`docs/screenshots/proof-roster.png` (player list roster).

**Proven, with 0 console errors and 0 source edits:**

- A peer (`Wren`) renders as a full voxel avatar **group + nameplate**.
- Wren's skin comes **from the wire** — an encoded descriptor string on the `welcome`
  peer, decoded by the facade and rendered by `PeerAvatarsPlus` (a second peer `Odd`
  with no skin gets the deterministic hash swatch, proving the fallback).
- A peer emote plays via the facade hook (`stack.receivePeerEmote`).
- Live `move` sync routes through the real NetClient dispatch.
- Public chat routes through the **real** `chat.js`, filtered by the whisper block-list.
- The player-list roster renders from the presence store.

Run it: `node avatars-integrate/server.mjs` then open
`/avatars-integrate/demo.html`. The headless harness is exposed on `window.proof`
(`.errors` collects any console.error / onerror / unhandledrejection).

---

## Appendix

**isSolid one-liner** (exact builder physics, derived by the facade from `world` +
`getBlockDef`):

```js
const isSolid = (x, y, z) =>
  getBlockDef(world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))).solid;
```

**Single-slot callback gotcha.** `NetClient`'s `onState/onPeerJoin/onPeerLeave/
onPeerMove/onChat/onDisconnect` each store **one** callback — registering again
**replaces** the previous one (`NetClient.js` L122–132). `PlayerStack` is the sole
owner; the builder must remove its own bindings (Step 4). Read anything else you need
from the stack getters (`presence`, `whisper`, `spectator`, `peersManager`,
`thirdPersonCamera`) — never re-bind the net.

**three r160 vs r185.** The packages pin/vendor three **r160**; the builder's importmap
ships **r185**. The APIs the stack uses (Scene / Group / Vector3 / PerspectiveCamera,
rotation order `"YXZ"`) are stable across that range, so the mismatch is benign in
practice. The proof ran on r160; it was **not** exercised on r185. When adopting, ensure
a single three instance (Step 8) and watch the r160→r185 color-management changes
(`.encoding` → `.colorSpace`, `ColorManagement` default-on). See `FINDINGS.md`.
