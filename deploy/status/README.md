# Loomfall Status Sidecar

A tiny, dependency-free live status page for a running Loomfall game server.
It polls the game's public REST endpoints and renders a dark status card:
health (up/down + latency) and worlds (count, names, per-world player count).

It is a **sidecar**: it lives entirely under `deploy/status/` and never touches
`server/`, `public/`, or `package.json`. It reads the game only through its
already-public HTTP API — nothing needs to change on the server for the basics.

## Files

| File         | What it is                                                            |
|--------------|-----------------------------------------------------------------------|
| `index.html` | Self-contained page (vanilla JS/CSS, no deps). Polls `/api/*`.        |
| `server.mjs` | Optional `node:http` static host + same-origin `/api/*` proxy.        |
| `README.md`  | This file.                                                            |

## Running

### Option A — point the page straight at a game host (no server needed)

Open `index.html` from anywhere and append a `?target=` query:

```
index.html?target=http://localhost:3000
```

The page fetches `<target>/api/health` and `<target>/api/worlds` directly.
This works only if the game host allows cross-origin reads (or is same-origin).

### Option B — run the sidecar server (recommended for a remote game)

The bundled server hosts the page **and** proxies `/api/*` to the game, so the
browser makes same-origin requests and CORS never enters the picture.

```bash
GAME_URL=http://localhost:3000 node deploy/status/server.mjs
# then open http://localhost:8080
```

Environment variables:

| Var           | Default  | Meaning                                              |
|---------------|----------|------------------------------------------------------|
| `STATUS_PORT` | `8080`   | Port the sidecar listens on.                         |
| `GAME_URL`    | (unset)  | Upstream game base URL to proxy `/api/*` to.         |

If `GAME_URL` is unset, the proxy returns 502 and you must instead use the
`?target=` form (Option A).

## What it shows RIGHT NOW (from the server as it exists today)

The current game server (`node server/index.js`, default `PORT=3000`) exposes:

- `GET /api/health` → `{ ok: true }`
  → page shows **up/down** plus client-measured **latency** (round-trip ms) and
    the last-check timestamp.
- `GET /api/worlds` → `[{ id, name, seed, createdAt, players }]`
  → page shows **world count**, each world's **name + id**, and **per-world
    player count** (the `players` field IS present — it is `room.clients.size`),
    plus a summed **total players online**.

Everything degrades gracefully: if a field is missing, the row renders
`n/a — see metrics.md`; if an endpoint is unreachable the health pill goes red
and worlds show the network error.

## What NEEDS THE BUILDER (richer stats — not yet exposed)

The page is built to display more, but the server does not emit it yet. The
following belong in a new `GET /api/metrics` endpoint on the game server. See
**`docs/metrics.md`** (on branch `feature/ci`) for the tracking doc; this
sidecar cross-references it wherever a stat is unavailable.

Stats the builder should expose:

- **Tick / simulation duration** — ms per server tick (avg + p95), so operators
  can see load. Currently there is no server-side tick loop metric surfaced.
- **Live player count (global)** — total connected WS clients across all rooms.
  Derivable today only by summing per-world `players`; a direct counter is
  cheaper and authoritative.
- **Room / world counts (live vs on-disk)** — how many rooms are actually loaded
  in memory (`rooms.size`) vs how many world files exist on disk.
- **Message rates** — inbound/outbound WS messages per second (`move`, `edit`,
  `chat` broken out), for throughput visibility.
- **Error counts** — dropped connections, rejected/rate-limited messages,
  malformed frames, persistence failures.
- **Uptime / start time** — process uptime and boot timestamp.
- **Memory** — RSS / heap used, for leak watching.

### Suggested `GET /api/metrics` shape

```jsonc
{
  "uptimeSeconds": 12345,
  "startedAt": "2026-07-11T16:00:00.000Z",
  "tick": { "avgMs": 3.2, "p95Ms": 7.1, "hz": 20 },
  "players": { "total": 4 },
  "rooms": { "live": 2, "onDisk": 7 },
  "messages": {                       // counters since boot + 1s rate
    "in":  { "total": 90210, "perSec": 41.2 },
    "out": { "total": 305112, "perSec": 133.7 },
    "byType": { "move": 84000, "edit": 210, "chat": 32 }
  },
  "errors": { "dropped": 3, "rateLimited": 12, "malformed": 0, "persistFail": 0 },
  "memory": { "rssMB": 88.4, "heapUsedMB": 41.9 }
}
```

Once that endpoint exists, extend `index.html` with a third card that polls
`/api/metrics` on the same interval and fills the rows currently marked
`n/a — see metrics.md`. No proxy or server changes to this sidecar are needed —
the same-origin `/api/*` forward already covers `/api/metrics`.
