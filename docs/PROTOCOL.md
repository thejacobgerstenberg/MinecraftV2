# Loomfall Multiplayer Protocol (v1)

Transport: **WebSocket** at path `/ws` on the same HTTP server that serves the
client and the REST API (default port 3000, `PORT` env override). Every frame
is a single JSON object with a `t` field naming the message type. Unknown or
malformed frames are ignored by both sides (the server may answer with an
`error` frame, see below). Frames larger than **65536 bytes** close the
connection (code 1009), and all inbound traffic is rate-limited and validated
server-side — see **§7 Security** for the complete enforcement table.

A companion REST API manages world records; the WebSocket layer manages live
rooms (one room per world).

---

## 1. REST API

All bodies are JSON. Worlds are persisted to `saves/<id>.json`.

### `GET /api/health`
`200 {"ok": true}` — liveness probe.

### `GET /api/worlds`
`200` with an array of world summaries:

```json
[{ "id": "my-world-k3f2", "name": "My World", "seed": 12345,
   "createdAt": "2026-07-11T05:00:00.000Z", "players": 2 }]
```

`players` is the number of currently connected sockets in that world's room
(0 when nobody is online).

### `POST /api/worlds`
Body: `{ "name": string (required, 1..64 chars), "seed"?: number|string }`.

Creates a world. `id` is a slug of the name plus a short random suffix
(e.g. `my-world-k3f2`), guaranteeing uniqueness and a filesystem-safe
filename. If `seed` is omitted it is derived deterministically from the
generated id (FNV-1a hash). Response `201`:

```json
{ "id": "my-world-k3f2", "name": "My World", "seed": 12345,
  "createdAt": "...", "players": 0,
  "edits": { "overworld": {}, "nether": {}, "end": {} } }
```

The record is written to `saves/<id>.json` immediately. Errors:
`400 {"error": "..."}` for a missing/invalid name.

### `GET /api/worlds/:id`
`200` with the full record (including `edits` and live `players` count) or
`404 {"error":"world not found"}`. Ids must match `[a-zA-Z0-9_-]{1,64}`
(anything else is a 400) — this also blocks path traversal.

### There is no REST write endpoint

`PUT /api/worlds/:id` (unauthenticated bulk edit-merge) was **removed** in the
security hardening pass: any HTTP client could overwrite any world with it.
World edits are persisted **exclusively** through validated WebSocket `edit`
messages. `PUT`/`PATCH`/`DELETE` on `/api/worlds/:id` now return `404`.

---

## 2. Edits model

An *edit* is a player-made block override on top of deterministic terrain:

```
world.edits[dim]["x,y,z"] = blockId
```

- `dim` ∈ `overworld | nether | end`.
- Key is integer block coordinates joined by commas (e.g. `"5,64,-2"`).
- `blockId` is an integer in `0..40` (0 = air, i.e. a broken block; the
  upper bound is reserved headroom above the current registry).
- On load, the client applies all edits for its dimension on top of
  generated chunks.

Persistence: the server debounces disk writes per world (**2 s** after the
last change) and also saves **immediately when the last client of a world
disconnects** and on server shutdown (SIGINT/SIGTERM).

---

## 3. WebSocket session lifecycle

1. Client opens `ws(s)://host/ws`.
2. Client sends `join`. Until a valid `join` is processed, all other frames
   from that socket are ignored.
3. Server replies `welcome` to the joining socket and broadcasts `peer-join`
   to everyone else in the world room.
4. Steady state: `move` / `edit` / `chat` in both directions as below.
5. On socket close the server broadcasts `peer-leave` to the room and, if the
   room is now empty, persists the world immediately and unloads it.

**Rooms and scoping.** A *room* is all sockets joined to the same world id.
Within a room, messages are scoped as follows:

| message      | delivered to                                   |
|--------------|-----------------------------------------------|
| `peer-join`  | whole room (all dimensions), excluding subject |
| `peer-leave` | whole room (all dimensions)                    |
| `move`       | peers in the same **dimension** only           |
| `edit`       | peers in the same **dimension** only           |
| `chat`       | whole room (all dimensions), **including** sender |

**Heartbeat.** Every 30 s the server pings each socket (WebSocket ping
frame). A socket that has not answered the previous ping with a pong is
terminated (which triggers the normal `peer-leave` flow). Browsers answer
pings automatically; no client action is needed.

---

## 4. Client → Server messages

### `join`
```json
{ "t": "join", "worldId": "my-world-k3f2", "name": "Steve-ish", "dim": "overworld" }
```
- `worldId` (required): must match `[a-zA-Z0-9_-]{1,64}`. If no save exists
  for the id, the server **auto-creates** a world with `name = worldId` and a
  seed derived from the id (convenient for dev / direct joins; the menu flow
  normally creates worlds via REST first).
- `name`: display name. Server-side: control characters and `<>&"'` are
  stripped, the result is trimmed and capped at **24** chars; an empty result
  falls back to a generated `Wanderer-xxxx`; duplicates within the room are
  deduped by appending a numeral (`Kai` -> `Kai2`). The sanitized name is the
  one echoed in `welcome.peers`, `peer-join`, and `chat`.
- `dim` (optional): starting dimension, defaults to `overworld`.
- A second `join` on an already-joined socket is answered with an `error`
  frame and ignored.

### `move`
```json
{ "t": "move", "x": 1.5, "y": 70.0, "z": -3.25, "yaw": 1.57, "pitch": -0.2, "dim": "overworld" }
```
- Coordinates are floats (player position, feet). `yaw`/`pitch` radians.
- `dim` is the sender's current dimension; if omitted or invalid the
  previously known dimension is kept.
- Non-finite coordinates cause the frame to be dropped, as do positions with
  `|x|` or `|z| > 30,000,000` or `y` outside `[-64, 512]`.
- **Speed validation.** The server tracks each player's authoritative
  position and charges every accepted move's displacement against two
  server-side token buckets: *controllable* motion (horizontal + upward,
  **25 blocks/s** sustained, 25-block burst — creative sprint-fly is 20 b/s)
  and *fall* motion (downward, **90 blocks/s**, covering free fall which
  peaks near 81 b/s). A move exceeding its budget is **dropped**: the server
  keeps — and keeps broadcasting — the last valid position, and notifies the
  sender with `error: move_rejected` (throttled to one notice per second).
  The only exceptions ("grace teleports", which refill both budgets) are:
  the **first move after join** (the client computes its own spawn), a
  **dimension change** at most once per 2 s (portal travel remaps
  coordinates; the cooldown blocks dim-flap teleporting), and an
  **announced respawn** — a `respawn` frame followed by a move landing at
  the player's *spawn anchor* (horizontal distance ≤ 8). The spawn anchor is
  the first-move position, updated by every dimension-change grace (the
  arrival point is the new spawn column). There is **no** unconditional
  resync: an over-budget move that matches no rule above is never accepted
  or broadcast, no matter how long the sender waits.
- **Dimension changes:** a `move` whose `dim` differs from the sender's
  stored dimension performs the switch. The server updates its record and
  broadcasts a fresh **`peer-join`** (carrying the new `dim` and position)
  to the *whole room*; it does not forward that frame as a `move`. Clients
  must treat `peer-join` as an **upsert**: create the peer if unknown,
  otherwise update its position/dimension (and hide it locally if it is now
  in another dimension). No `peer-leave` is sent for dimension changes —
  `peer-leave` always means the socket is gone.

### `respawn`
```json
{ "t": "respawn" }
```
- Announces that the sender's next teleport-sized `move` is a **respawn**.
  The server flags the connection; the next over-budget move is accepted
  **only if** it lands within **8 blocks** (horizontal) of the sender's
  *spawn anchor* — the position of the first move after join, updated on
  every dimension change (main.js moves `player.spawn` to the arrival
  column at exactly those moments).
- The flag persists until consumed by a matching move: a respawn close to
  the death spot legitimately produces an ordinary within-budget move, so
  the flag must not expire, and denying a repeat respawn could permanently
  desync an honest client. There is deliberately **no cooldown**: the grace
  is anchored, so spamming it grants nothing a legitimate death would not
  (a bounce back to spawn).
- Clients send this from the death screen's Respawn action
  (`NetClient.sendRespawn()`), immediately before the first post-respawn
  move.

### `edit`
```json
{ "t": "edit", "x": 5, "y": 64, "z": -2, "block": 3, "dim": "overworld" }
```
- `x,y,z,block` must be integers; `0 <= y < 128`; `|x|,|z| <= 30,000,000`;
  `0 <= block <= 40`. Invalid edits are rejected with an `error` frame and
  are neither stored nor broadcast.
- **Bedrock floor:** `y === 0` is the unbreakable bedrock layer (worldgen
  always places bedrock at y=0 in every dimension). The server rejects
  **any** edit at `y === 0` — breaking *and* placing — since it does not run
  worldgen and cannot distinguish blocks there.
- **Dimension binding:** the edit is applied to the sender's **server-tracked
  dimension** (from validated moves). The `dim` field is kept for
  compatibility, but if present it must match the server's value or the edit
  is rejected — a client can never write into a dimension it is not in.
- **Reach:** the block must be within **7** blocks of the player's
  server-tracked position (distance from the player's collision column,
  feet to feet+1.8, to the block center). Client-side reach is 6; the +1
  covers eye-height and latency slack.
- **Rate:** at most **20 edits/s** per connection (token bucket, burst 20);
  excess edits are dropped (no `error` frame, but the sender does receive an
  `editReject` rollback frame — see §5).
- **Rejection feedback:** every rejected edit — for ANY reason (rate, reach,
  bounds, protected bedrock, dimension mismatch, invalid shape) — answers the
  **sender** with an `editReject` frame (§5) carrying the authoritative block
  for the cell, so an optimistic client can roll its local change back
  instead of desyncing until rejoin. At most one `editReject` per inbound
  edit (no amplification).
- Accepted edits are applied to `world.edits[dim]["x,y,z"]`, marked for
  debounced persistence, and broadcast (with the sender's `id` added) to
  same-world **same-dim** peers. The sender does not receive its own edit
  back. Same-cell conflicts resolve last-writer-wins.

### `chat`
```json
{ "t": "chat", "text": "hello world" }
```
- Server-side: control characters stripped, trimmed, capped at 256 chars;
  empty after sanitization → dropped.
- On broadcast, `text` **and** `name` are HTML-escaped (`& < > " '` become
  entities) as defense-in-depth — clients must still render chat via
  `textContent`, never `innerHTML`. Note the escaped text can exceed 256
  chars (entities expand); the 256 cap applies to the raw text.
- Rate limited to **3 messages per 2 s** per connection; a breach drops the
  message and sends the sender an `error` frame with code `chat_rate`.
- Broadcast to the whole room **including the sender** (the sender renders
  its own line when the echo arrives, guaranteeing consistent ordering).

---

## 5. Server → Client messages

### `welcome` (reply to `join`)
```json
{ "t": "welcome", "id": "p1",
  "world": { "id": "my-world-k3f2", "name": "My World", "seed": 12345,
             "createdAt": "...",
             "edits": { "overworld": {"5,64,-2": 3}, "nether": {}, "end": {} } },
  "peers": [ { "id": "p2", "name": "Alex-ish", "x": 0, "y": 80, "z": 0,
               "yaw": 0, "pitch": 0, "dim": "overworld" } ] }
```
- `id` is the client's own session id (string, unique per server run).
- `world.edits` contains **all** dimensions so the client can switch
  dimensions without refetching.
- `peers` lists every *other* connected player in the world, in **any**
  dimension (each entry carries its `dim`; clients filter rendering by it).

### `peer-join`
```json
{ "t": "peer-join", "id": "p3", "name": "Kai", "x": 0, "y": 80, "z": 0,
  "yaw": 0, "pitch": 0, "dim": "nether" }
```
Sent to the whole room when a player joins **or changes dimension**
(upsert semantics — see `move` above).

### `peer-leave`
```json
{ "t": "peer-leave", "id": "p3" }
```
Sent to the whole room when a socket disconnects (or is terminated by the
heartbeat).

### `move`
```json
{ "t": "move", "id": "p2", "x": 1.5, "y": 70, "z": -3.25,
  "yaw": 1.57, "pitch": -0.2, "dim": "overworld" }
```
A peer's movement; only delivered to clients in the same dimension.

### `edit`
```json
{ "t": "edit", "id": "p2", "x": 5, "y": 64, "z": -2, "block": 3, "dim": "overworld" }
```
A peer's block change; only delivered to clients in the same dimension.
Apply it to the local world and remesh the affected chunk.

### `editReject`
```json
{ "t": "editReject", "x": 5, "y": 64, "z": -2, "block": -1,
  "dim": "overworld", "reason": "rate" }
```
Sent **only to the sender** whenever one of its `edit` frames is rejected,
for any reason. Fields:

- `x,y,z` — the rejected edit's coordinates, echoed back when they were
  integers (`null` otherwise — never reflects junk).
- `block` — the **authoritative** current block at that cell: the stored
  edit at that key if one exists, else **-1** meaning "untouched generated
  terrain — restore the value from your local deterministic generator copy"
  (terrain generation is seed-deterministic, so the client can recompute the
  exact block).
- `dim` — the sender's server-tracked dimension the edit was bound to.
- `reason` — one of `rate` | `reach` | `bounds` | `protected` | `dim` |
  `invalid`.

Clients that apply edits optimistically MUST roll the cell back on receipt:
set the block to `block` when `block >= 0`, otherwise recompute the
generated block and drop any local edit-record override for the key
(see `NetClient.onEditReject` and the main.js handler). Rejections that
also produce an `error: bad_edit` frame keep doing so (the `editReject` is
additive); rate-capped edits send `editReject` only.

### `chat`
```json
{ "t": "chat", "id": "p2", "name": "Alex-ish", "text": "hello world" }
```
Delivered to the whole room including the original sender.

### `error`
```json
{ "t": "error", "code": "bad_edit", "message": "block id out of range" }
```
Advisory only; the connection stays open. Codes currently used:
`bad_join`, `already_joined`, `bad_edit`, `bad_world`, `chat_rate`,
`move_rejected`. (Malformed `move` frames are dropped **silently**;
rate-capped edits get no `error` frame but DO get an `editReject` rollback
frame — one per inbound edit, so no amplification; speed-budget violations
answer with `move_rejected` at most **once per second** per connection — so
a flood cannot use the server as an amplifier, but a desynced client can see
why its position froze.)

---

## 6. Client library (`public/src/net/NetClient.js`)

`NetClient` wraps the above for the game:

- `connect(url, worldId, name)` → Promise resolving after `welcome`
  (`{ id, world, peers }`); stores `selfId` and `world` (incl. edits).
  `url` may be `ws://…/ws`, `wss://…/ws`, or an `http(s)` origin (converted).
- Callback registration (each takes one function, replacing any previous):
  `onState(cb)` — fired with the `welcome` payload;
  `onPeerJoin(cb)`, `onPeerLeave(cb)`, `onPeerMove(cb)`, `onEdit(cb)`,
  `onEditReject(cb)` (one of OUR edits was rejected — roll the cell back,
  see the `editReject` message in §5), `onChat(cb)`, `onDisconnect(cb)`
  (receives `{code, reason, intentional}`).
- `sendMove(pos, yaw, pitch)` — throttled to **20 Hz**, latest-wins: calls
  during the 50 ms window overwrite the pending frame; nothing is sent when
  idle.
- `setDimension(dim)` — folds into the next outgoing `move`; if a position
  is already known, a move is scheduled immediately so the switch propagates
  without waiting for player input.
- `sendRespawn()` — immediate; announces that the next move is a respawn
  teleport back to the spawn anchor (see the `respawn` message in §4).
- `sendEdit(x, y, z, blockId)` — immediate (uses the current dimension).
- `sendChat(text)` — immediate.
- Outgoing frames are queued until the socket is open, then flushed after
  the `join` frame.
- `close()` — intentional shutdown; `onDisconnect` still fires, with
  `intentional: true`.

---

## 7. SECURITY — server-side enforcement

The server is **authoritative** and validates everything a client sends; it
never trusts client-supplied identity, position, dimension, or content.
Summary of the enforcement added by the hardening pass (each rule has a
regression test in `tests/security.test.mjs`, run via `npm test`):

| # | Surface | Rule | On violation |
|---|---------|------|--------------|
| 1 | WS frame size | max **65536 bytes** per frame (`maxPayload`) | connection closed, code **1009** |
| 2 | WS message rate | **60 msg/s** sustained, burst 120, all message types; 3 strikes | over-limit frames dropped; 3rd strike closes, code **1008** `"rate limit"` |
| 3 | REST writes | `PUT /api/worlds/:id` **removed** (was an unauthenticated bulk write); REST JSON bodies capped at 64 kB | `404` |
| 4 | Identity | `id`/`name` on broadcasts are always the server-minted values; client-supplied `id`/`name` fields on `move`/`edit`/`chat` are ignored | spoofed fields never propagate |
| 5 | Move coords | finite numbers; `\|x\|,\|z\| <= 30,000,000`; `-64 <= y <= 512` | frame dropped |
| 6 | Move speed | **25 blocks/s** sustained (horizontal+up, 25-block burst), **90 blocks/s** down (free fall); dt measured server-side; grace teleports ONLY on join (first move), dimension change (max 1 per 2 s), and announced respawn into the spawn anchor (±8 blocks); **no unconditional resync** | move dropped + `error: move_rejected` (throttled 1/s), server keeps last valid position |
| 7 | Edit shape | integer coords, block `0..40`, `0 <= y < 128`, `\|x\|,\|z\| <= 30,000,000` | `error: bad_edit` |
| 8 | Bedrock | **no edit at `y === 0`** (bedrock layer is always y=0 in every dimension; the server does not run worldgen, so the whole layer is protected) | `error: bad_edit` |
| 9 | Edit dimension | bound to the **server-tracked** dimension; a `dim` field must match it | `error: bad_edit` |
| 10 | Edit reach | <= **7** blocks from the server-tracked player column (client reach is 6) | `error: bad_edit` |
| 11 | Edit rate | **20 edits/s** per connection (token bucket, burst 20) | excess dropped; sender gets an `editReject` rollback frame (no `error` frame) |
| 12 | Names | strip control chars + `<>&"'`, cap 24, fallback `Wanderer-xxxx`, dedup per room with numeral suffix | sanitized transparently at join |
| 13 | Chat | strip control chars, cap 256, HTML-escape `&<>"'` on broadcast (name too); **3 msgs / 2 s** | over-limit dropped + `error: chat_rate` to sender |
| 14 | Consistency | same-cell edits resolve **last-writer-wins**; all observers converge | n/a (locked by tests) |

The old "resync" grace (an over-budget move accepted at most once per 2 s,
which used to cover client respawn) is **gone**: respawn now has an explicit
wire signal (`respawn`, §4) whose grace is only honored back into the
player's recorded spawn anchor, so an arbitrary teleport move is never
accepted or broadcast — not on the first try, and not after any cooldown.

Known residuals (accepted, documented):

- A cheater can still *announce a respawn* and bounce back to their spawn
  anchor at will — identical in effect to legitimately dying, so it grants
  no new capability.
- A **dimension-change** move remains a grace teleport (max 1 per 2 s):
  portal travel remaps coordinates, and the server cannot verify the
  mapping without running worldgen. Flapping dimensions therefore relocates
  a cheater at most once per 2 s, and only ever surfaces to peers as
  `peer-join` upserts (never as a silent same-dimension `move` jump).
- A client that teleports itself *without* dying or changing dimension
  (e.g. a QA harness writing `player.position` directly) simply desyncs:
  the server keeps broadcasting its last valid position and answers with
  `move_rejected` until the client walks back or respawns/travels.
