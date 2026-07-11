# Voxelheim Multiplayer Protocol (v1)

Transport: **WebSocket** at path `/ws` on the same HTTP server that serves the
client and the REST API (default port 3000, `PORT` env override). Every frame
is a single JSON object with a `t` field naming the message type. Unknown or
malformed frames are ignored by both sides (the server may answer with an
`error` frame, see below).

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

### `PUT /api/worlds/:id`
Body: `{ "edits": { "overworld"?: {...}, "nether"?: {...}, "end"?: {...} } }`.

**Merges** (does not replace) the given edits into the stored record,
per dimension: each `"x,y,z": blockId` entry overwrites the same key,
other keys are kept. Entries with malformed keys or block ids outside
`0..40` are silently skipped. Persists immediately. `200` with the updated
full record, or `404`.

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
- `name`: display name, trimmed, capped at 24 chars; defaults to `"player"`.
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
- Non-finite coordinates cause the frame to be dropped.
- **Dimension changes:** a `move` whose `dim` differs from the sender's
  stored dimension performs the switch. The server updates its record and
  broadcasts a fresh **`peer-join`** (carrying the new `dim` and position)
  to the *whole room*; it does not forward that frame as a `move`. Clients
  must treat `peer-join` as an **upsert**: create the peer if unknown,
  otherwise update its position/dimension (and hide it locally if it is now
  in another dimension). No `peer-leave` is sent for dimension changes —
  `peer-leave` always means the socket is gone.

### `edit`
```json
{ "t": "edit", "x": 5, "y": 64, "z": -2, "block": 3, "dim": "overworld" }
```
- `x,y,z,block` must be integers; `0 <= y < 128`; `0 <= block <= 40`;
  `dim`, if present, must be a valid dimension (defaults to the sender's
  current dimension). Invalid edits are rejected with an `error` frame and
  are neither stored nor broadcast.
- Applied to `world.edits[dim]["x,y,z"]`, marked for debounced persistence,
  and broadcast (with the sender's `id` added) to same-world **same-dim**
  peers. The sender does not receive its own edit back.

### `chat`
```json
{ "t": "chat", "text": "hello world" }
```
- Trimmed; capped at 256 chars; empty after trim → dropped.
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
`bad_join`, `already_joined`, `bad_edit`, `bad_world`.

---

## 6. Client library (`public/src/net/NetClient.js`)

`NetClient` wraps the above for the game:

- `connect(url, worldId, name)` → Promise resolving after `welcome`
  (`{ id, world, peers }`); stores `selfId` and `world` (incl. edits).
  `url` may be `ws://…/ws`, `wss://…/ws`, or an `http(s)` origin (converted).
- Callback registration (each takes one function, replacing any previous):
  `onState(cb)` — fired with the `welcome` payload;
  `onPeerJoin(cb)`, `onPeerLeave(cb)`, `onPeerMove(cb)`, `onEdit(cb)`,
  `onChat(cb)`, `onDisconnect(cb)` (receives `{code, reason, intentional}`).
- `sendMove(pos, yaw, pitch)` — throttled to **20 Hz**, latest-wins: calls
  during the 50 ms window overwrite the pending frame; nothing is sent when
  idle.
- `setDimension(dim)` — folds into the next outgoing `move`; if a position
  is already known, a move is scheduled immediately so the switch propagates
  without waiting for player input.
- `sendEdit(x, y, z, blockId)` — immediate (uses the current dimension).
- `sendChat(text)` — immediate.
- Outgoing frames are queued until the socket is open, then flushed after
  the `join` frame.
- `close()` — intentional shutdown; `onDisconnect` still fires, with
  `intentional: true`.
