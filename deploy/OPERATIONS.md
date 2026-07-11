# Loomfall — Production Operations & Abuse Runbook

Operator reference for running the Loomfall multiplayer server (`node
server/index.js`, ws@8 + express) in production. Every limit below is quoted
from the server source and is enforced **server-side** — the server is
authoritative for player position, dimension, names, and world edits.

Cross-references:
- **`deploy/HOSTING.md`** — how to stand the server up (Docker / Node / reverse proxy).
- **`deploy/BACKUP.md`** + **`deploy/backup`** — world archive / restore tool.
- **`deploy/status/`** — live status sidecar (health + per-world player counts).
- **`docs/metrics.md`** (branch `feature/ci`) — tracking doc for the not-yet-exposed `/api/metrics` (tick duration, global player count, heap).
- **`docs/SECURITY_FINDINGS.md`** — security audit findings (e.g. S1: the removed unauthenticated `PUT /api/worlds/:id`).
- **`docs/PROTOCOL.md` §7** — the canonical message + limits reference.

---

## 1. What the server enforces (real limits & authority)

All values are from `server/index.js`. Do not assume anything the code does not
say; the server reads **only** `PORT` from the environment today.

### Transport / connection

| Control | Value | Enforcement | Source |
|---|---|---|---|
| WS endpoint | `ws(s)://<host>/ws` | single path on the HTTP server | `index.js` `WebSocketServer({ path:'/ws' })` |
| Max WS frame | **65536 bytes** (`MAX_WS_PAYLOAD_BYTES`) | oversized frame → socket closed **1009** by ws | `:39`, `:350` |
| Global inbound rate | **60 msg/s sustained, burst 120** (`MSG_RATE`) | per-connection token bucket (cap 120, refill 60/s); each over-limit message is **dropped and counts a strike** | `:41`, `:639`, `:644` |
| Strike policy | **3 strikes** (`maxStrikes`) | on the 3rd dropped message → `ws.close(1008, 'rate limit')` | `:646` |
| Heartbeat | **ping every 30s** (`HEARTBEAT_MS`) | server pings all clients; a socket that missed the previous pong is `terminate()`d (client sees a 1006-style drop) | `:34`, `:691`–`:697` |
| REST body cap | **64 kb** (`express.json({limit:'64kb'})`) | oversized JSON body rejected by express | `:264` |

### Chat / names

| Control | Value | Enforcement | Source |
|---|---|---|---|
| Chat rate | **3 messages / 2000 ms** sliding window (`CHAT_RATE`) | breach → message dropped + `error: chat_rate` to sender | `:45`, `:619`–`:627` |
| Chat length | trimmed, capped **256** chars (`CHAT_MAX`), control chars stripped, HTML-escaped (`&<>"'`) on broadcast | server rewrites the text | `:71`, `:612`–`:631` |
| Name | capped **24** chars (`NAME_MAX`), `<>&"'` + control chars stripped, empty → `Wanderer-xxxx`, deduped per room | server rewrites the name | `:70`, `:115`, `:410` |

### Edits (world writes)

| Control | Value | Enforcement | Source |
|---|---|---|---|
| Edit rate | **20 edits/s per connection** (`EDIT_RATE`, bucket cap 20) | excess edits **silently dropped** (no error frame) | `:43`, `:588` |
| Reach cap | **7 blocks** (`MAX_REACH`; client reach is 6, +1 slack) | distance from player collision column to block center > 7 → `error: bad_edit` | `:62`, `:585` |
| Bedrock floor | **y = 0 is unbreakable** | any edit (place or break) at y=0 → `error: bad_edit` | `:576`–`:578` |
| Vertical bounds | **0 ≤ y < 128** (`WORLD_HEIGHT`) | out of range → `error: bad_edit` | `:30`, `:573` |
| Horizontal bounds | **\|x\|, \|z\| ≤ 30,000,000** (`MAX_COORD_XZ`) | out of range → `error: bad_edit` | `:64`, `:573` |
| Block id | integer **0..40** (`MAX_BLOCK_ID`) | out of range / non-integer → `error: bad_edit` | `:29`, `:570` |
| Dimension binding | edit is bound to the sender's **server-tracked** dim; a client `dim` field is accepted only if it matches, else `error: bad_edit` | `:579`–`:582` |

Writes are broadcast only to peers **in the same dimension** and are persisted
to `saves/<id>.json`. There is deliberately **no REST write endpoint** — no
`PUT/PATCH/DELETE` on `/api/worlds/:id` (audit finding S1, `:335`–`:338`). The
only way to mutate a world is a validated WS `edit`.

### Movement (anti-cheat, server-authoritative position)

| Control | Value | Source |
|---|---|---|
| Controllable speed (horizontal + upward) | **25 b/s sustained, 25-block burst** (`MAX_MOVE_SPEED` × `MOVE_BURST_S`) | `:48`, `:52` |
| Fall speed (downward) | **90 b/s** (`MAX_FALL_SPEED`; free fall peaks ~81 b/s) | `:50` |
| Y sanity clamp for moves | **-64 ≤ y ≤ 512** (`MOVE_MIN_Y`/`MOVE_MAX_Y`) | `:66`–`:67` |
| Dimension | one of `overworld`, `nether`, `end` (`DIMENSIONS`) | `:31` |

An over-budget move is **dropped** — the server keeps the last valid position
and never broadcasts the jump — unless one of exactly three grace teleports
applies: (1) first move after join; (2) a dimension change, at most once per
**2000 ms** (`GRACE_COOLDOWN_MS`, anti dim-flap); (3) an announced `respawn`,
honored **only** back into the recorded spawn anchor (within `RESPAWN_RADIUS`
**8** blocks). A rejected move notifies the sender with `error: move_rejected`,
throttled to **1/s** (`MOVE_REJECT_NOTICE_MS`). There is no unconditional
"resync" grace: a 500-block teleport is never seen by peers, no matter how long
the sender waits (`:454`–`:555`).

### World id / join

- World ids match `^[a-zA-Z0-9_-]{1,64}$` (`ID_RE`, `:32`); invalid → `error: bad_join`.
- A second `join` on the same socket → `error: already_joined` (`:383`).
- Any non-`join` frame before a completed join is ignored (`:664`).

---

## 2. How to spot abuse

### Normal log lines (stdout)

Boot:
```
Loomfall server listening on http://localhost:3000
  WebSocket endpoint: ws://localhost:3000/ws
```
Join / leave (note the real format — id, quoted name, world id, and dim):
```
[ws] p1 "Wanderer-8f3a" joined my-world-x9k2 (overworld)
[ws] p1 "Wanderer-8f3a" left my-world-x9k2
```
Every connection that registers a player produces exactly one join line and,
on disconnect, exactly one leave line (`:451`, `:680`). The `pN` id increments
monotonically per process (`nextClientId`) — it is your correlation key.

### Abuse signals

- **Flood / message DoS → 1008 close.** A client that exceeds 60 msg/s beyond
  the 120 burst gets messages dropped, accrues strikes, and on the 3rd is
  `ws.close(1008, 'rate limit')` (`:646`). In the logs this shows as a `joined`
  line followed **very quickly** by a `left` line for the same `pN` with no
  legitimate gameplay in between. A single IP producing repeated
  join→(seconds)→left cycles is the classic reconnect-flood fingerprint.
- **Oversized-frame probing → 1009 close.** Frames over 64 kB are closed by ws
  with **1009** before your handlers run. Same visible symptom: a fast
  join→left pair. Legitimate clients never approach 64 kB (the biggest frame is
  a chat capped at 256 chars).
- **Fast reconnect churn.** Because strikes and buckets are per-socket, an
  attacker who is 1008'd will simply reconnect. Watch for a burst of new `pN`
  ids in a short window; the ids are sequential so `p204 … p251` in one second
  is a reconnect storm.
- **Grief edits.** Edits are rate-limited to 20/s per connection and are bounds/
  reach/dim-validated, so they cannot corrupt the world, but a determined
  client can still place up to ~20 blocks/s. The observable is **`saves/<id>.json`
  growing** (every edit is stored forever in the edit log) and the in-memory
  room growing with it. Watch save-file size (§5, memory growth).
- **Chat spam.** Rate-limited to 3 / 2 s; excess is dropped server-side, so
  spam is self-throttling and never reaches peers. No log line is emitted for a
  dropped chat — the only trace is client-side `error: chat_rate`.
- **Anti-cheat rejections are not logged.** `move_rejected`, `bad_edit`,
  `chat_rate`, `bad_join`, and strike accounting are sent to the offending
  client but **not** written to server stdout. Do not expect them in the logs;
  the server-side trace of persistent abuse is the 1008/1009-driven fast
  join→left pattern and reconnect churn.

Error-ish lines you may also see:
```
[ws] socket error: <msg>          (console.warn, transient socket faults, :686)
[ws] join failed: <msg>           (world load failed during join, :659)
[save] failed for <id>: <msg>     (disk write error, :236 / :254)
```

### Correlate a noisy client

The server logs no IP, so identify the source at the **edge** (reverse proxy /
load balancer access log), correlating by timestamp with the `pN` join/left
lines. Mitigation is done at the proxy: rate-limit or block the offending IP
there. The server's own defenses (1008/1009, per-socket buckets) already contain
a single connection; the proxy is your tool for connection-churn / multi-socket
abuse. See `deploy/HOSTING.md` for the reverse-proxy setup.

---

## 3. Clean restart & graceful shutdown

The server installs handlers for **SIGINT and SIGTERM**. Both run `shutdown()`,
which flushes every loaded room to disk and then `process.exit(0)` (`:708`–`:717`):

```
[server] SIGTERM received, flushing worlds...
```
That log line, followed by the process exiting 0, is what a clean shutdown looks
like. `shutdown()` is idempotent (guarded by `shuttingDown`), so a double signal
is safe.

**What "drain" means here.** `flushAllRooms()` (`:704`) awaits `saveRoom()` for
every loaded world before exit, so **all world edits are persisted**. There is no
per-connection drain: open sockets are dropped when the process exits, and there
is no in-app reconnect — connected players will see their socket close and must
refresh / rejoin. Ephemeral state (live positions, un-broadcast chat) is lost;
durable state (world edits) is not. To drain politely, announce the restart to
players out-of-band first, then signal.

### Restart recipes

Docker Compose (PID 1 is `node`; Compose sends SIGTERM, so the flush runs):
```bash
# In-place restart (recommended for config-free bounces):
docker compose restart loomfall

# Explicit stop then start:
docker compose stop loomfall && docker compose start loomfall

# Full recreate (e.g. after an image rebuild). Saves survive via the
# loomfall-saves named volume:
docker compose up -d --build
```
The compose service is `restart: unless-stopped`, so a crash auto-restarts;
`docker compose stop` will not fight the policy.

Node directly (via `deploy/run` or `node server/index.js`):
```bash
# Graceful — triggers the SIGTERM flush:
kill -TERM <pid>
# Ctrl+C at the foreground console sends SIGINT — also flushes.
```
Do **not** use `kill -9` (SIGKILL) for a routine restart: it bypasses the flush
(see §5 for why the world is still not corrupted, only up to ~2 s stale).

Even without a signal, the server flushes a world the moment its **last client
leaves** (`unloadRoomIfEmpty`, `:251`), and every edit debounce-saves within
**2000 ms** (`SAVE_DEBOUNCE_MS`, `:33`). So an empty server is already fully
persisted.

---

## 4. Logs, saves, and the health probe

### Where the logs are

The server logs to **stdout/stderr** only (plain `console.log/.warn/.error`).
Retrieve them by how you launched it:

- **Docker Compose:** `docker compose logs -f loomfall` (or `docker logs -f loomfall`).
- **systemd:** `journalctl -u <your-unit> -f`.
- **Bare `deploy/run` / `node`:** wherever you redirected it, e.g.
  `node server/index.js >> /var/log/loomfall.log 2>&1`. There is no built-in
  log file or rotation — redirect and rotate at the OS/proxy layer.

### Where saves live

One JSON file per world:
```
<repo>/saves/<id>.json          # bare Node / deploy/run  (SAVES_DIR = server/../saves, :24)
/app/saves/<id>.json            # inside the container, backed by the loomfall-saves volume
```
Each file is `{ id, name, seed, createdAt, edits }` — metadata plus the full
per-dimension edit log. Deleting a file deletes that world. The saves directory
is the **entire** durable game state. Back it up with `deploy/backup` (§5, `deploy/BACKUP.md`).

### Health probe

```bash
curl -fsS http://localhost:3000/api/health      # -> {"ok":true}
```
`GET /api/health` returns `{ok:true}` unconditionally when the event loop is
alive (`:266`). The Docker/Compose healthcheck hits it every 30 s (timeout 5 s,
3 retries, 10 s start period) via node's `fetch` (`docker-compose.yml`).
For richer signals (world count, per-world player counts, latency) run the
**status sidecar** in `deploy/status/`. Tick duration / global heap are not yet
exposed — see `docs/metrics.md`.

---

## 5. Incident quick-reference

### Server unresponsive
1. `curl -fsS http://localhost:3000/api/health` — if this fails, the HTTP
   server is wedged or the process is down.
2. Check it's running: `docker compose ps` / `systemctl status <unit>` / `ps aux | grep index.js`.
3. Check the logs (§4) for a stack trace, `[save] failed`, or repeated
   `[ws] socket error`.
4. If up but health hangs, it is CPU-bound or event-loop-blocked — grab logs,
   then restart gracefully (§3). The SIGTERM flush protects the worlds.
5. If a specific dimension/world is implicated, note its `<id>` for the save check.

### Memory / save growth
- Per-connection state (buckets, chat window, anchors) is freed on socket close;
  empty rooms are deleted from the `rooms` map on last-leave (`:255`), so idle
  memory should return to baseline. Growth that does **not** return is the
  signal to investigate.
- The one intentionally-unbounded structure is `world.edits`: every accepted
  edit is stored forever, so a heavily-built or griefed world grows both the
  loaded room and `saves/<id>.json`. Track it: `ls -lh saves/*.json` — a file
  ballooning past expectations (recall edits are capped at 20/s/connection)
  points at the culprit world.
- Reproduce / measure sustained load with the **soak harness** (long-running
  multi-client load test) and track heap/tick against `docs/metrics.md`; the
  connection primitive it builds on is the same inline WS client used by
  `deploy/smoke.mjs`. If heap climbs with all clients disconnected and all rooms
  empty, that is a leak — capture a heap snapshot and restart gracefully to
  restore service while you triage.

### Corrupt or truncated save
This should not happen: `writeWorldToDisk` writes to `<file>.tmp` then
`fs.rename`s it into place (`:207`–`:213`). Rename is atomic on a single
filesystem, so a reader — the server on boot, `tar`, or `deploy/backup` — never
observes a half-written JSON. This is the **SIGKILL-recovery guarantee**: if the
process is `kill -9`'d (or the box loses power) mid-write, the destination file
is either the previous complete version or the new complete version, never a
splice of both. You lose at most the last debounce window (**≤ 2 s** of edits
that were never flushed), never a corrupt world.
- If a `.json` genuinely won't parse (`readWorldFromDisk` returns null and the
  world silently vanishes from `/api/worlds`), check for a stray `<id>.json.tmp`
  next to it (evidence of a write interrupted before rename) and restore from
  backup (below).

### Roll a world back with `deploy/backup`
```bash
# List available backups:
deploy/backup list

# Restore a single archived snapshot into the saves dir (‑‑force overwrites):
deploy/backup restore <archive> --force

# Take a fresh backup before you overwrite anything:
deploy/backup backup
```
For a strictly consistent point-in-time snapshot across all worlds, stop the
server (or use an LVM/ZFS/cloud disk snapshot) first — routine hot backups are
safe thanks to the atomic writes above. Full details and `WORLD_DIR` handling:
`deploy/BACKUP.md`. After restoring, restart the server so it reloads worlds
from disk (rooms are loaded lazily on join / REST access, so a restart is the
clean way to pick up externally-changed files).

### Flood / DoS in progress
The server already contains a single abusive socket (1008/1009, per-socket
buckets, §1). For connection churn or multi-socket floods, block or rate-limit
the source **at the reverse proxy** — correlate the proxy access log against the
`pN` join/left timestamps (§2). A graceful restart resets all per-socket state
but does not stop a persistent attacker; edge mitigation does.
