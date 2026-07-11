# PlayerStack Integration — Findings & TODO

Every mismatch / friction point between the packages and the builder's **real** code,
found while building the code-verified proof (`avatars-integrate/demo.html`, which imports
the genuine `net/NetClient.js`, `engine/World.js`, `blocks/blocks.js`, `ui/chat.js` from
`feat/voxel-sandbox-game @ 71689cf`). Each row has a concrete action.

**Owner** = who does the work: **builder** (game repo), **builder(adoption)** (main.js
swap only, no server), **avatars/avatars-plus package**.

| # | Finding | Severity | Owner | Detail | Action |
|---|---------|----------|-------|--------|--------|
| 1 | **Emote transport gap** — NetClient has no emote path | HIGH | builder | `NetClient.js` has no `sendEmote`, no `'emote'` dispatch case, no `onEmote` registrar. Facade hooks (`stack.emote`, `onEmoteTransport`, `receivePeerEmote`) are ready and verified, but nothing carries emotes over the wire. | Add `sendEmote(name){ this._send({t:'emote',name}); }`, `case 'emote': if(this._cb.emote) this._cb.emote(msg); break;` in `_dispatch`, `emote:null` in `this._cb`, and `onEmote(cb){ this._cb.emote=cb; return this; }`. Wire `stack.onEmoteTransport(id=>net.sendEmote(id))` + `net.onEmote(m=>stack.receivePeerEmote(m.id,m.name))`. See INTEGRATION Step 7. |
| 2 | **Skin-on-join payload field missing** | HIGH | builder | Join frame is `{ t:'join', worldId, name, dim }` (`NetClient.js` L62) — no skin. Server does not echo a skin into `welcome.peers[]` / `peer-join`. So peer skins can't sync. | Attach `stack.setLocalSkin(desc)` (compact encoded string) to the join frame; echo it server-side into `welcome.peers[]` + `peer-join`. Facade `_peerMsg()` decodes `msg.skin` automatically. Until then: deterministic hash-of-id swatch fallback (verified working). See INTEGRATION Step 6. |
| 3 | **three r160 (packages) vs r185 (builder importmap)** | MED | avatars package | Packages pin/vendor three **r160** (`avatars/vendor/three.module.js` → `REVISION='160'`); builder importmap ships **r185**. Proof ran on r160 and was **NOT** exercised on r185. | Ensure a **single** `"three"` instance in-game (don't add a 2nd importmap mapping — packages use bare `"three"`). Smoke-test the avatars on r185 and watch the r160→r185 color-management changes (`.encoding` → `.colorSpace`, `ColorManagement` default-on). See INTEGRATION Step 8 / Appendix. |
| 4 | **Single-slot NetClient callbacks** | MED | builder(adoption) | `onState/onPeerJoin/onPeerLeave/onPeerMove/onChat/onDisconnect` each hold ONE callback — re-registering **clobbers** (`NetClient.js` L122–132). Two consumers (renderer + presence) can't each bind. | On adoption, REMOVE the builder's own `onPeerJoin/Leave/Move/onChat` (and `onState`) bindings — `main.js` L784/785, L787–790, L791, L792, L831. `PlayerStack` is the sole net owner and fans each event to both renderer and presence (verified working). Read extras from stack getters, never re-bind. See INTEGRATION Step 4. |
| 5 | **Real `chat.js` ships no CSS** | LOW | builder | The real `ui/chat.js` renders into `#chat` with classes `.chat` / `.chat-log` / `.chat-line` but ships **no** stylesheet — placement/appearance is undefined without host CSS. Functionally fine (log + input work). | Add game CSS for `.chat` / `.chat-log` / `.chat-line` (bottom-left placement, fade), or route chat through the `lf-chat` ui-kit component. The proof supplies a minimal inline stylesheet as a reference (`demo.html` `#chat` rules). |
| 6 | **`material.color` is `0xffffff` when a weave map is present** | LOW | avatars package (test guidance) | Skinned avatar materials keep `material.color === 0xffffff` and carry the skin as a **texture/palette** map, not a tinted base color. Tests asserting a skin via `material.color` will get white and misfire. | Assert skins via the texture / palette (map presence, descriptor round-trip), NOT `material.color`. Document in the avatars package test guidance. |
| 7 | **`connect`/`onState` ordering** — welcome fires before peer bindings | MED | builder(adoption) | `NetClient.connect()` calls `this._cb.state(msg)` and resolves with `welcome` the instant the welcome frame arrives (`NetClient.js` L76–85) — BEFORE today's peer bindings at `main.js` L784+. If the stack binds after `connect`, `onState` (the peer seed) is missed. | Build the stack + `setNet(net)` **before** `net.connect(...)` (reorder L621/L622/L653) so `onState` catches the welcome. Fallback: after connect, seed once from the returned `welcome` via `stack.peersManager.upsert(...)`. See INTEGRATION Step 3. |
| 8 | **No presence / ping / team / roster protocol** | LOW | builder | Protocol carries only movement/identity per peer (`{id,name,x,y,z,yaw,pitch,dim}`) — no ping, team, or presence roster. The social layer degrades gracefully: ping renders `"—"`, team is a local overlay. | Optional: add the `social/README` extensions — `{t:"presence", players:[{id,name,dim,ping,team?,skin?}]}` and `{t:"ping", id, ms}`. Client passthrough is ready (`stack.setPing(id,ms)`). Until added, the layer works with local-only overlays. |
| 9 | **`isSolid` must be sourced from the real builder oracle** | LOW | builder(adoption) | The stack needs solidity for the third-person + spectator cameras. A hand-rolled `isSolid` risks drifting from `physics.js`. | Pass `world` (from `engine/World.js`) + `getBlockDef` (from `blocks/blocks.js`); the facade derives `(x,y,z)=>getBlockDef(world.getBlock(⌊x⌋,⌊y⌋,⌊z⌋)).solid` — **verified identical** to `physics.js` isSolid. Don't pass a custom `isSolid`. |

## Verification basis

- Proof: `avatars-integrate/demo.html` — real NetClient/World/blocks/chat, `MockWS`
  socket, **0 console errors, 0 source edits**. Screenshots in
  `docs/screenshots/proof.png` + `proof-roster.png`.
- Facade: `avatars-integrate/integrate.js` (`PlayerStack`) — single net owner, fans each
  event to `PeerAvatarsPlus` (render) + `SocialLayer` (presence/whisper/spectator).
- Builder source: vendored at `avatars-integrate/vendor-game/src/` from
  `feat/voxel-sandbox-game @ 71689cf` (genuine, unmodified).
