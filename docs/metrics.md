# Observability & Metrics — recommendations for `server/index.js`

Status: **recommendations only.** Nothing here is implemented yet. This doc is
written against the real server on `origin/feat/voxel-sandbox-game`
(`server/index.js`, Express 5 + `ws`, single file). It states honestly what the
server emits **today**, where the gaps are, and proposes a small, low-overhead
surface the builder can drop in without restructuring anything.

Design goals: **zero new dependencies** (Node builtins + the counters you
already have in scope), **O(1) per message** (integer bumps, no allocation on
the hot path), and **pull-based** (a JSON endpoint the CI harnesses can scrape),
so nothing has to be wired into a collector to be useful.

---

## 1. What the server emits today

### Console (stdout / stderr) — human logs, not machine-readable
| Line | When | Stream |
|---|---|---|
| `Loomfall server listening on http://localhost:<PORT>` | boot | stdout |
| `  WebSocket endpoint: ws://localhost:<PORT>/ws` | boot | stdout |
| `[ws] <pid> "<name>" joined <worldId> (<dim>)` | player join | stdout |
| `[ws] <pid> "<name>" left <worldId>` | last frame of a session (close) | stdout |
| `[server] <signal> received, flushing worlds...` | SIGINT / SIGTERM | stdout |
| `[ws] join failed: <msg>` | `handleJoin` threw | stderr |
| `[ws] socket error: <msg>` | socket `error` event | stderr |
| `[save] failed for <id>: <msg>` | debounced/last-leave write threw | stderr |

### REST
- `GET /api/health` → `{ "ok": true }`. A **bare liveness probe** — a constant,
  no counts, no uptime, no version.
- `GET /api/worlds`, `GET /api/worlds/:id`, `POST /api/worlds` — data endpoints;
  `:id` and the list include a live `players` count, but that is per-world world
  data, not a metrics surface.

### Client-directed error frames (sent, never aggregated)
The handlers already classify failures with stable `code` strings, but each one
is `send()`-ed to the offending socket and then **forgotten** — nothing counts
them:
`already_joined`, `bad_join`, `bad_world`, `bad_edit` (integer/bounds/bedrock/
dim-mismatch/reach), `move_rejected`, `chat_rate`, plus the `1008 "rate limit"`
close on message-flood strikeout. These `code`s are the single highest-value
metric already present in the source — they just need a `++`.

---

## 2. Gaps (what is NOT observable today)

- **No metrics endpoint and no in-process counters.** Nothing is retained; every
  signal above is either a one-shot log line or a frame to one client.
- **No message-rate visibility.** `move` / `edit` / `chat` / `join` throughput is
  invisible; the only rate machinery is the per-connection token buckets, which
  drop silently and keep no totals.
- **No reject/error aggregation.** The `bad_edit` / `move_rejected` / `chat_rate`
  / flood-strike counts are exactly the "rejected-message counts once authority
  checks exist" signal the spec asks for — and the authority checks now exist
  (reach, speed/fall budgets, dim-match, bedrock) — but nothing tallies them.
- **No loop/tick timing.** The server is event-driven: there is **no game tick or
  periodic broadcast loop**, only a 30 s liveness `heartbeat` interval. So there
  is no "tick duration" to measure — the analogous hot-path cost is
  **per-message handler time** and **`broadcast()` fan-out** (its cost scales
  with room population). Neither is timed.
- **No save observability.** Saves are debounced ~2 s and atomic (tmp+rename);
  only the **failure** path logs. There is no save count, no save latency, and
  **no success signal at all** — a silently-degrading disk looks identical to a
  healthy one until it throws.
- **No connection / room gauges.** `wss.clients.size` and `rooms.size` exist in
  scope but are never surfaced; the peak-concurrency and loaded-world counts the
  soak harness wants are not exposed.
- **No ws byte accounting.** Inbound frame size is capped (`MAX_WS_PAYLOAD_BYTES
  = 65536`) but bytes in/out are not summed, so bandwidth and broadcast-storm
  amplification are invisible.

---

## 3. Proposed minimal surface

A single flat `metrics` object of integer counters, bumped inline in the
handlers that already run, plus a `GET /api/metrics` that serializes it. Adds no
dependency, no timer, and no measurable per-message cost (counter increments and
one cheap duration sample). Percentiles come from a tiny fixed-size ring of
recent durations, reduced only on read.

### 3a. Counter object + helpers (top of `server/index.js`)
```js
// --- Metrics (in-process, best-effort; reset on restart) -------------------
const startedAt = Date.now();
const metrics = {
  msgIn: { join: 0, move: 0, edit: 0, chat: 0, respawn: 0, unknown: 0 },
  rejects: {},          // keyed by error `code`: bad_edit, move_rejected, ...
  floodCloses: 0,       // 1008 rate-limit disconnects
  edits: { applied: 0 },
  broadcasts: { frames: 0, recipients: 0 },
  saves: { ok: 0, failed: 0 },
  bytes: { in: 0, out: 0 },
  peak: { players: 0, rooms: 0 },
  // fixed-size rings of recent durations (ms), reduced to p50/p95 on read
  saveMs: [], msgMs: [],
};
const RING = 256;
function observe(ring, ms) { ring.push(ms); if (ring.length > RING) ring.shift(); }
function pct(ring, p) {
  if (!ring.length) return 0;
  const s = [...ring].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2);
}
function bumpReject(code) { metrics.rejects[code] = (metrics.rejects[code] || 0) + 1; }
```

### 3b. Bump points (drop into the existing handlers)
```js
// message dispatch (ws.on('message')): time every handled frame, count by type
const t0 = performance.now();
metrics.bytes.in += raw.length;
// ...existing JSON.parse + switch...
metrics.msgIn[msg.t] = (metrics.msgIn[msg.t] ?? metrics.msgIn.unknown)++ ;  // see note*
observe(metrics.msgMs, performance.now() - t0);

// on the flood-strike close:  metrics.floodCloses++;
// in each `send(ws, { t:'error', code })` reject path:  bumpReject(code);
// handleEdit success (after markDirty):  metrics.edits.applied++;

// broadcast(): account fan-out
metrics.broadcasts.frames++;
metrics.broadcasts.recipients += /* number of sockets written */ 0;
metrics.bytes.out += /* raw.length * recipients */ 0;

// saveRoom(): time the write and record ok/fail
const s0 = performance.now();
try { await writeWorldToDisk(room.world); metrics.saves.ok++; }
catch (e) { metrics.saves.failed++; throw e; }
finally { observe(metrics.saveMs, performance.now() - s0); }

// on connect / disconnect, keep the gauges honest:
metrics.peak.players = Math.max(metrics.peak.players, wss.clients.size);
metrics.peak.rooms   = Math.max(metrics.peak.rooms, rooms.size);
```
\* Keep the msg-type bump explicit (`switch (msg.t)` already exists) rather than
the terse one-liner above — shown compressed only to keep this snippet short.

### 3c. The endpoint
```js
app.get('/api/metrics', (req, res) => {
  res.json({
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    players: wss.clients.size,
    rooms: rooms.size,
    ...metrics,
    latencyMs: {
      msg:  { p50: pct(metrics.msgMs, 50),  p95: pct(metrics.msgMs, 95) },
      save: { p50: pct(metrics.saveMs, 50), p95: pct(metrics.saveMs, 95) },
    },
  });
});
```

Response shape (illustrative):
```json
{
  "uptimeSec": 612, "players": 24, "rooms": 3,
  "msgIn": { "join": 41, "move": 90233, "edit": 1876, "chat": 402, "respawn": 6, "unknown": 0 },
  "rejects": { "bad_edit": 12, "move_rejected": 5, "chat_rate": 3 },
  "floodCloses": 1,
  "edits": { "applied": 1864 },
  "broadcasts": { "frames": 88110, "recipients": 1650420 },
  "saves": { "ok": 37, "failed": 0 },
  "bytes": { "in": 5820113, "out": 141902288 },
  "peak": { "players": 31, "rooms": 4 },
  "latencyMs": { "msg": { "p50": 0.04, "p95": 0.21 }, "save": { "p50": 3.1, "p95": 8.7 } }
}
```

**Cheaper alternative** if a pull endpoint is unwanted: emit the same object as a
single-line `console.error('[metrics] ' + JSON.stringify(...))` on the existing
`heartbeat` interval (every 30 s). Same counters, no new route, greppable in the
process's own log stream — but not scrapable on demand, so the harnesses below
prefer the endpoint.

---

## 4. What the harnesses would consume

The CI harnesses in `scripts/` already sample the process externally; a
`/api/metrics` endpoint lets them cross-check the server's own view against the
OS view and turn today's pass/fail gates into trend dashboards.

- **`scripts/soak-test.mjs`** samples `/proc/<pid>` RSS / fd / threads and fits an
  RSS-slope leak verdict. Scraping `/api/metrics` alongside it correlates any RSS
  climb with `rooms`, `peak.players`, `broadcasts.recipients`, and
  `bytes.out` — i.e. tells you whether growth is a real leak or just more load,
  and whether `saves.failed` or `floodCloses` spiked during the run.
- **`scripts/persistence-test.mjs`** would gate on `saves.failed == 0` across its
  create/reload/concurrent/crash checks, and use `saves.ok` + `save` p95 latency
  as a durability-regression signal (a save-latency blowup precedes the debounce
  window overflowing and losing the last edits on SIGKILL).
- **Load / authority harnesses** (the `mock-server.mjs` chaos reference and any
  authority suite) consume `rejects{}` and `msgIn{}`: an authority regression
  shows up as `rejects.bad_edit` / `move_rejected` going to **zero** while
  hostile traffic is being sent (checks silently disabled), or spiking on
  **legitimate** traffic (checks too strict). `broadcasts.recipients / frames`
  is the fan-out amplification factor to watch for broadcast storms.

All of these read the endpoint over the same `--rest` base the persistence suite
already targets, so consuming it is additive — no new transport, no new dep.
