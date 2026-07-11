# Voxelheim Server-Authority Security Findings

**Scope:** Authorized internal server-authority audit (no external targets; own live server, scratchpad worktree).
**Target:** `server/index.js` on branch `feat/voxel-sandbox-game` @ tip `1122b88` ("Fix integration issues from adversarial playtest").
**Audit run:** 2026-07-11 _(date placeholder — update on finalization)_.
**Harness:** `scripts/authority-test.mjs` — 15 automated checks over `ws://…/ws` + REST. Reproducible with:

```
PORT=3220 node server/index.js          # start server in a worktree (npm install first)
node scripts/authority-test.mjs --url ws://127.0.0.1:3220/ws
```

**Grading rubric:** `docs/BUG_TAXONOMY.md` §1 (S0..S3, first-match top-down). Ground-truth constants: `docs/MULTIPLAYER_PROTOCOL.md` §0/§1.1 (`EDIT_REACH_BLOCKS=6`, `EDIT_RATE_CAP_PER_S=20`, `CHAT_RATE={msgs:3,perMs:2000}`, `CHAT_MAX_CHARS=256`, `MAX_FRAME_BYTES_CONTROL=65536`, `WORLD_MIN_Y=-64`, `SPEED_FLY=10.89 b/s`, `displayName ≤32 chars`, `WORLD_MAX_XZ=30_000_000`).

**Result: 11 VULN / 4 PASS.** The automated tool reported 10 VULN / 5 PASS; check #14 was reclassified PASS→VULN after manual verification (see §14). Server did **not** crash under any destructive check — a crash would itself have been S0.

---

## 1. DoS patch status — BOTH OPEN

Two DoS mitigations were expected from the "adversarial playtest" fix commit. **Neither landed at tip `1122b88`.**

### Patch #1 — WS `maxPayload` cap → **OPEN**
- `dosPatch1_maxPayload_landed = false`.
- `grep -n maxPayload server/index.js` → **no matches**.
- `server/index.js:266`: `new WebSocketServer({ server, path: '/ws' })` sets **no `maxPayload`** ⇒ `ws` default (~100 MiB) per frame. The only byte cap in the file is REST-only (`express.json({ limit: '10mb' })`) and does not touch the WS path.
- Live evidence: an **8 MB WS frame was ACCEPTED** (not closed `1009`). See §15.
- Spec requires `MAX_FRAME_BYTES_CONTROL = 65536`.

### Patch #2 — per-connection message rate limit → **OPEN**
- `dosPatch2_rateLimit_landed = false`.
- `grep -niE "ratelimit|rate limit|throttle|tokens|bucket|strike|perMs" server/index.js` → only **unrelated** hits (world-shape comment L75; REST edit-merge loop L242–244). No per-connection message counter, no token bucket, no strike-and-close.
- Live evidence: a **50,000-message flood was fully absorbed** (not throttled, not closed `1008`). See §15.

Both are re-filed under §15 (DoS, **S0**).

---

## 2. Summary table

| # | Check | Verdict | Sev |
|---|---|---|---|
| 1 | teleport / speed-hack | **VULN** | S1 |
| 2 | edit reach (`EDIT_REACH_BLOCKS=6`) | **VULN** | S1 |
| 3 | edit XZ bounds | **VULN** | S1 |
| 4 | bedrock / protected floor | **VULN** | S2 |
| 5 | cross-dimension edit | **VULN** | S1 |
| 6 | block-id validity | PASS | — |
| 7 | edit rate cap (`20/s`) | **VULN** | S1 |
| 8 | id / authorship spoof | PASS | — |
| 9 | name charset / dedup / length | **VULN** | S2 |
| 10 | chat sanitization (+ sink scan) | **VULN** | S2 |
| 11 | chat rate cap (`3/2000ms`) | **VULN** | S2 |
| 12 | non-finite state integrity | PASS | — |
| 13 | concurrent consistency (LWW) | PASS | — |
| 14 | unauth REST write (`PUT /api/worlds/:id`) | **VULN** | S1 |
| 15 | DoS — frame + flood | **VULN** | S0 |

**Totals: VULN = 11, PASS = 4.**

---

## Vulnerabilities

Wire shapes (from `docs/PROTOCOL.md`): `join {t:'join',worldId,name,dim}` · `move {t:'move',x,y,z,yaw,pitch,dim}` · `edit {t:'edit',x,y,z,block,dim}` · `chat {t:'chat',text}`. In all repros the attacker first sends a valid `join` and a baseline `move`.

### §1 — Teleport / speed-hack — **S1**
**Severity:** S1 per BUG_TAXONOMY §1.2 — the P0 "stay in sync / server is authority" loop is broken. `handleMove` overwrites the server-tracked position with whatever the client asserts; no speed/delta/teleport cap (spec `SPEED_FLY=10.89 b/s`). Survivable state, so not S0; core-loop authority broken, so not S2.
**Repro:**
```json
{"t":"move","x":0,"y":80,"z":0}
{"t":"move","x":1000,"y":80,"z":0}
```
**Evidence:** an observing peer received the attacker at `Δx=1000` in a single `move` message — a +1000-block jump was rebroadcast verbatim.
**Fix:** track each player's last authoritative `(pos, time)`; reject (keep prior pos) any `move` whose implied horizontal speed exceeds `SPEED_FLY=10.89` (with a small margin, cap ~16 b/s); do not rebroadcast the impossible position.

### §2 — Edit out of reach — **S1**
**Severity:** S1 per §1.2, rule **S1-d** (which explicitly cites `EDIT_REACH_BLOCKS=6`). An out-of-reach edit is accepted, broadcast, and persisted — authoritative world state altered from a position the player cannot legally act from.
**Repro** (player at `(0,80,0)`):
```json
{"t":"edit","x":100,"y":80,"z":0,"block":1}
```
**Evidence:** `broadcast=true`; `GET /api/worlds/:id` confirmed the block persisted at `(100,80,0)`. Positive control (edit within 3 blocks) also accepted — no distance test exists at all.
**Fix:** in `handleEdit`, reject edits whose Euclidean distance from the player's authoritative position exceeds `EDIT_REACH_BLOCKS=6`.

### §3 — Edit XZ unbounded — **S1**
**Severity:** S1 per §1.2 — only `y` is bounded (`validEditKey` checks `0≤y<128`, not x/z), so edits at astronomical coordinates enter and persist. Unbounded keys bloat the in-memory `edits` map and the `saves/<id>.json` file (a state/disk-bloat griefing vector that borders S0; graded S1 as the realized impact is broken bounds, not an observed crash).
**Repro:**
```json
{"t":"edit","x":1000000000000,"y":80,"z":0,"block":1}
```
**Evidence:** `broadcast=true`; `GET` confirmed the `1e12,80,0` key persisted.
**Fix:** reject edits with `|x| > 30_000_000` or `|z| > 30_000_000` (`WORLD_MAX_XZ`).

### §4 — No bedrock / protected floor — **S2**
**Severity:** S2 per §1.3 — a feature disagrees with a spec number: `WORLD_MIN_Y=-64` defines an unbreakable bedrock layer; the server allows `0≤y<128` with no protected layer, so `y==0` is breakable. Core loop survives ⇒ not S1. Spec value cited ⇒ S2.
**Repro:**
```json
{"t":"edit","x":0,"y":0,"z":0,"block":0}
```
**Evidence:** break at `y==0` accepted; `GET` confirmed the floor cell was overwritten.
**Fix:** reject any edit/break where `y==0` (unbreakable bedrock floor).

### §5 — Cross-dimension edit — **S1**
**Severity:** S1 per §1.2 — `handleEdit` trusts `msg.dim` (validated only to be a `DIMENSIONS` member) instead of binding to the player's current dimension, so a client in one dimension writes into another. Breaks server-authority binding of edits to player state.
**Repro** (attacker joined in `overworld`):
```json
{"t":"edit","x":2,"y":80,"z":0,"block":1,"dim":"nether"}
```
**Evidence:** a `nether` observer received the edit; `GET` of the nether dimension confirmed it persisted.
**Fix:** apply edits to the player's **current server-tracked dimension**; ignore any client-supplied `dim` override.

### §7 — No edit rate cap — **S1**
**Severity:** S1 per §1.2 — no `EDIT_RATE_CAP_PER_S=20` throttle; a burst of edits is fully broadcast and persisted, a broadcast-storm / sync-under-load vector against the core loop.
**Repro:** send 100 in-reach edits within <1 s (each a valid `edit` near the player).
**Evidence:** the observer received all 100; all persisted.
**Fix:** cap edits at `EDIT_RATE_CAP_PER_S=20` per connection; drop the excess.

### §9 — Name charset / dedup / length — **S2**
**Severity:** S2 per §1.3 — spec `displayName ≤32 chars, server validates/dedups`. Implementation truncates to **24** (not 32), applies **no charset strip** (control chars and `<>` retained), and does **no dedup**. Cosmetic-but-wrong contract value, core loop survives ⇒ S2.
**Repro:** `join` with a 150-char `name` containing control characters and `<script>`; then a second client joins with the same `name`.
**Evidence:** observed name length 24, raw `<>`/control chars kept; two players shared an identical display name (`dedup=false`).
**Fix:** cap name at ≤32, strip control characters and `<>`, and dedup display names within a room.

### §10 — Chat broadcast unescaped — **S2**
**Severity:** S2 per §1.3 (defense-in-depth). The server broadcasts chat `text` (and `name`) **unescaped**. A static scan of the worktree `public/src` found **no network-controlled HTML sink** — chat renders via `textContent`/`createTextNode` (`chat.js:59/63/65`), nametags via canvas `fillText` (`PeerAvatars.js:45`); the only `innerHTML` is `hud.js:60 = SHARD_SVG`, a static module constant. So this is **not currently exploitable client-side** (no S0/S1 live XSS), but the server relies entirely on every client keeping a safe sink. Graded S2 hardening gap.
**Repro:**
```json
{"t":"chat","text":"<img src=x onerror=alert(1)>"}
```
**Evidence:** observer received the payload raw/unescaped over the wire. Worktree sink scan: none live.
**Fix:** HTML-escape (`& < > " '` → entities) chat `text` **and** `name` server-side before broadcast; keep client sinks off `innerHTML`.

### §11 — No chat rate cap — **S2**
**Severity:** S2 per §1.3 — spec `CHAT_RATE={msgs:3, perMs:2000}` not enforced. Spam-adjacent nuisance, core loop survives; spec value cited ⇒ S2.
**Repro:** send 20 `chat` messages within <1 s.
**Evidence:** the observer received all 20 within 2 s.
**Fix:** cap chat at 3 messages / 2000 ms per connection; drop the excess.

### §14 — Unauthenticated REST bulk write — **S1**
**Severity:** S1 per §1.2/§1.1 — `PUT /api/worlds/:id` has **zero auth**; any HTTP client can bulk-write block edits into any loaded/created world → authoritative-state corruption/griefing (borders §1.1 S0 data-corruption; graded S1 as state remains overwritable/recoverable).
> **Correction:** the automated tool reported PASS only because it PUT to a fresh `worldId` never loaded into memory or disk, so the handler returned `404 "world not found"` **before** reaching write logic — a false negative. Reclassified to VULN after manual verification.
**Repro (no auth header on the PUT):**
```
POST /api/worlds                    -> { id: "t-tw25", ... }   (HTTP 200)
PUT  /api/worlds/t-tw25
   {"edits":{"overworld":{"5,10,5":40}}}                        -> HTTP 200
GET  /api/worlds/t-tw25             -> edits.overworld["5,10,5"] == 40
```
**Evidence:** the unauthenticated PUT returned 200 and the GET confirmed `5,10,5:40` persisted.
**Fix:** require an auth token on `PUT /api/worlds/:id` (401/403 otherwise), or disable bulk edit writes entirely.

### §15 — DoS: oversized frame + message flood — **S0**
**Severity:** S0 per §1.1 / §7 quick-reference ("crash → S0"). This is the crash / resource-exhaustion class: with **no `maxPayload`** (default ~100 MiB) and **no rate limit**, a single large frame or a sustained flood exhausts memory/CPU. No crash occurred during the test (which would itself have been S0), but both defenses that would bound the exhaustion are absent, so the vulnerability is graded by the class it enables.
**Repro:**
- Send one **8 MB** WS frame.
- Then send a **50,000-message** flood as fast as possible.
**Evidence:** the 8 MB frame was accepted (`closed=false`, not `1009`); the 50,000-message flood was fully absorbed (`throttled/closed=false`, not `1008`). `grep` confirms neither `maxPayload` nor any rate/throttle/bucket/strike code exists (see §1).
**Fix:** set the WS server `maxPayload = 65536` (reject/close oversized frames `1009`) **and** add a per-connection message-rate limit (strike → close `1008`).

---

## POSITIVES — locked in by the regression suite

These behaviors passed and are correct; keep them (each has a matching check in `scripts/authority-test.mjs`):

- **§8 Server-assigned identity — no impersonation.** Broadcasts always carry the server-minted `id`/`name` (e.g. `p16`); a raw `move` with a forged `id:"p999" name:"evil"` was ignored — observers saw the real id. Never trust a client `id`/`name` field.
- **§10 sink scan — no client XSS.** Chat/name reach the DOM via `textContent`/`createTextNode` (`chat.js`) and canvas `fillText` (`PeerAvatars.js`); the sole `innerHTML` (`hud.js` `SHARD_SVG`) is a static constant. No escapable HTML sink for network data. _(The server-side unescaped broadcast in §10 remains a defense-in-depth gap that goes live the instant any client adds an `innerHTML` sink.)_
- **§12 Non-finite integrity.** `null` / `"NaN"` / `"Infinity"` / non-number coordinates never propagate — `handleMove` early-returns on non-finite `x/y/z`.
- **§6 Block-id range.** `validBlockId` rejects non-integers and ids outside `0..40` (`9999` and `-1` rejected).
- **§13 Consistency.** Same-cell conflicts resolve deterministically last-writer-wins; all observers converge (documented rule in `docs/PROTOCOL.md` §2).

---

## CI gate

`scripts/authority-test.mjs` is wired into CI and exits non-zero on any VULN (this run exited `1`). Once the branch reaches `master`, it will **gate the server** — the 11 findings above must be remediated (or explicitly waived) for the suite to pass. The five PASS checks act as regression guards so the locked-in positives cannot silently regress.
