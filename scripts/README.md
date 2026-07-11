# scripts/

Dependency-free Node scripts that back the CI pipeline in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml). Everything here runs
with plain `node` (builtins only) — the repo has **no root `package.json`**, and
nothing here creates one (see [No root package.json](#no-root-packagejson)).

Contents:

- **[Backend load & robustness harness](#backend-load--robustness-harness)** —
  `load-test.mjs`, `chaos-test.mjs`, `mock-server.mjs`, and the `lib/*.mjs`
  transport / protocol / util modules.
- **[scripts/verify-audio.mjs](#scriptsverify-audiomjs)** — headless-Chromium
  audio engine verification.
- **[scripts/validate-content.mjs](#scriptsvalidate-contentmjs)** — game content
  JSON validator.

## CI: what runs and when

The workflow triggers on **push to `master`** and on **all pull requests**. It
defines **four** independent jobs. Each **skips gracefully (stays green)** when
its target does not exist yet on the branch being built — so this repo is green
before the content, audio, game, and server branches land:

| Job | Needs | When target is missing | What it does |
|---|---|---|---|
| `content-validation` | `content/` directory | `echo "no content/ directory — skipping"` | `node scripts/validate-content.mjs` (no `setup-node`, no npm install — plain `node` on the runner is enough) |
| `audio-verification` | `audio/` directory | A `Check for audio/` step sets `present=false`; the install and verify steps are `if:`-gated off it | Installs `playwright` + Chromium into `$RUNNER_TEMP/pw` (outside the repo), then `PW_DIR="$RUNNER_TEMP/pw" node scripts/verify-audio.mjs` |
| `game-tests` | root `package.json` with a `test` script | `exit 0` with "no package.json — skipping" (or "no test script — skipping") | `npm ci` if `package-lock.json` exists, else `npm install`; then `npm test`. A real `npm test` failure fails the job — only a *missing* test script skips |
| `backend-load` | *(always runs the mock self-test)*; the full suite needs a real server entrypoint | Runs the harness self-test against the bundled reference mock only | Self-test: `load-test.mjs --spawn` + `chaos-test.mjs --spawn`. When a real server is detected, additionally runs the full suite against it via `--server-cmd`. See [How CI runs the harness](#how-ci-runs-the-harness) |

Timeouts: 5 min for `content-validation`, 15 min for the other three. The audio
job's Playwright install is:

```bash
mkdir -p "$RUNNER_TEMP/pw"
cd "$RUNNER_TEMP/pw"
npm init -y
npm i playwright
npx playwright install --with-deps chromium
```

GitHub-hosted runners ship no browsers for Playwright, so CI installs its own
Chromium — into `$RUNNER_TEMP`, never into the repo checkout.

## Backend load & robustness harness

A dependency-free harness that drives concurrent bot clients at the **Voxelheim**
multiplayer server and gates CI on latency, correctness, and crash-resistance. It
targets the **real** wire protocol — `ws://host:3000/ws`, speaking `join` /
`move` / `edit` / `chat` — and still runs for real today against a bundled
reference mock:

- **Bot clients over a hand-rolled RFC6455 transport.** No `ws` package, no
  global `WebSocket` — `lib/ws-transport.mjs` implements the WebSocket client
  *and* server (opening handshake, framing, masking, fragmentation, control
  frames, oversized-frame rejection) on Node builtins alone.
- **An isolated protocol adapter.** `lib/protocol.mjs` matches the real Voxelheim
  wire format (`docs/PROTOCOL.md` v1). Every other module is protocol-agnostic
  and only calls its encoders / `decode()` / correlation helpers / `CAPS`.
- **Correlation with no `seq` field and no app ping.** The protocol carries
  neither, so the harness smuggles both signals into forwarded fields:
  - **RTT** off the **chat self-echo** — chat is broadcast to the whole room
    *including* the sender, so a bot times its own echo (`matchRttEcho`).
  - **Propagation / drops / out-of-order** off a monotonic per-bot `seq`
    **smuggled into the forwarded `pitch` field** (a finite float the server
    forwards verbatim, without range-validating), recovered via `readMoveSeq`.
- **A bundled reference mock server.** `mock-server.mjs` speaks exactly that wire
  protocol *and* models good-behaviour defences the real server lacks, so the
  whole thing **runs with zero external setup**. Point it at the real server with
  `--url`, `--server-cmd` (+ `--server-cwd`), or `--server-pid`.

**`lib/protocol.mjs` and `mock-server.mjs` are the only two protocol-specific
files.** The transport and both harnesses stay generic and measure via the
adapter's `CAPS`, so retargeting is a change to those two files alone.

Module layout (all under `scripts/`, Node 20 CI / Node 22 local, builtins only):

| File | Role |
|---|---|
| `lib/ws-transport.mjs` | RFC6455 WebSocket client + server. Protocol-agnostic; exposes the raw socket and chaos hooks (`sendRawFrame`, `sendRawBytes`); never lets one bad connection throw out of the server. Self-test: `node scripts/lib/ws-transport.mjs --selftest` |
| `lib/protocol.mjs` | **THE adapter (Voxelheim).** `join`/`move`/`edit`/`chat` encoders, server→client `decode()` (never throws), correlation helpers (`readMoveSeq`, `matchRttEcho`, `extractPlayerSeqs`), and the `CAPS` descriptor the generic layers read. See [THE PROTOCOL](#the-protocol) |
| `lib/util.mjs` | `parseArgs` (CLI + env + default precedence), typed env readers, `Stats` (percentiles), `startProcSampler` (Linux `/proc` CPU%/RSS), `printReport`, `writeJsonReport` |
| `mock-server.mjs` | Reference authoritative Voxelheim server + robustness spec. See [the reference server](#scriptsmock-servermjs--the-reference-server) |
| `load-test.mjs` | Load harness. See [below](#scriptsload-testmjs) |
| `chaos-test.mjs` | Adversarial-input chaos harness. See [below](#scriptschaos-testmjs) |

**Target selection** is shared by both harnesses, in precedence order (highest
first):

1. `--server-cmd "<cmd>"` — spawn an arbitrary server through a shell (in
   `--server-cwd <dir>` if given, load-test only), poll its port, then target it.
2. `--spawn` — spawn the bundled reference mock (`mock-server.mjs`).
3. `--url ws://host:port/ws` — target an already-running external server. Add
   `--server-pid <pid>` (env `SERVER_PID`) to sample CPU/RSS and detect crashes
   of a server the harness did **not** spawn.
4. *(nothing)* — **defaults to the mock**, same as `--spawn`.

The default target URL is `ws://127.0.0.1:${GAME_PORT||3000}/ws` (from the
adapter's `CAPS`).

### scripts/load-test.mjs

Spins up N headless bot clients that connect, `join`, then generate realistic
traffic (a ~15 Hz random walk of `move`s with the per-bot `seq` in `pitch`, an
`edit` every ~2 s, an RTT self-echo `chat` every ~1 s), staggered over a ~2 s
ramp to avoid a thundering herd. All bots share one world + `overworld` dim so
every move/edit fans out. There is **no client ping** — keepalive is the WS
control-frame pong. It measures how the server holds up under concurrent load.

**What it measures** (all latencies as p50 / p95 / p99 / max):

| Metric | Definition |
|---|---|
| **RTT** | **chat self-echo**: a bot sends `chat` carrying `rtt:<botIdx>:<seq>:<sendMs>`; the server echoes chat to the whole room *including* the sender, so RTT = recv − sendMs (matched only against the bot's own echo) |
| **Propagation** | time from a bot sending `move#seq` (seq smuggled in `pitch`) until that move is first re-broadcast to **another** same-dim bot |
| **Drops** | per `(receiver, source)`, skipped `seq` ranges (via `readMoveSeq` on forwarded moves), as a % of expected updates |
| **Out-of-order** | per `(receiver, source)`, `seq` that went backwards, as a % of expected updates |
| **Server CPU / mem** | `/proc`-sampled CPU% and RSS for a server the harness spawned **or** a `--server-pid` it was told to watch (**n/a** for a bare `--url` with no pid) |
| **Connection errors** | failed connects, unexpected mid-test closes, socket errors |

**Flags / env** (precedence: CLI flag > env > default):

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--players <n>` | `GAME_BOTS` | `50` | concurrent bot clients |
| `--duration-sec <s>` | `GAME_DURATION` | `30` | active-load window (after the ~2 s ramp) |
| `--url <ws-url>` | `GAME_URL` | `""` | target an external server (e.g. `ws://host:3000/ws`) |
| `--spawn` | — | off | spawn + target the bundled mock |
| `--server-cmd "<cmd>"` | `GAME_SERVER_CMD` | `""` | spawn an arbitrary server via shell |
| `--server-cwd <dir>` | `GAME_SERVER_CWD` | `""` | working directory for the spawned `--server-cmd` |
| `--server-pid <pid>` | `SERVER_PID` | `0` | sample CPU/mem (and detect a crash) of a server started outside the harness — use with `--url` |
| `--report <path>` | `GAME_REPORT` | `""` | also write the JSON report here |
| *(client frame cap)* | `GAME_MAX_PAYLOAD` | `1 MiB` | `wsConnect` `maxPayload` |

**Thresholds** (env-overridable; defaults shown) gate the process exit code, so
this doubles as a CI check. `P95_MS` / `P99_MS` gate the RTT histogram
(propagation p95/p99 are reported but not gated):

| Threshold | Default | Gates |
|---|---|---|
| `P95_MS` | `150` ms | RTT p95 ceiling |
| `P99_MS` | `300` ms | RTT p99 ceiling |
| `DROP_PCT` | `1` % | dropped-update ceiling |
| `OOO_PCT` | `1` % | out-of-order ceiling |
| `MAX_CONN_ERRORS` | `0` | tolerated socket errors + unexpected closes |

**Exit codes.** `0` = all thresholds met. `1` = any threshold breach, **or** a
spawned server died mid-test, **or** any bot failed to connect, **or** no RTT
self-echoes came back at all (server unresponsive), **or** the run was
interrupted by a signal, **or** the target server failed to start.

```bash
node scripts/load-test.mjs --spawn --players 20 --duration-sec 6 --report /tmp/load.json
node scripts/load-test.mjs --url ws://127.0.0.1:3000/ws                       # external server
node scripts/load-test.mjs --url ws://127.0.0.1:3000/ws --server-pid 12345    # + sample its CPU/RSS
node scripts/load-test.mjs --server-cmd "node server/index.js" --server-cwd /path/to/voxelheim
P95_MS=1 node scripts/load-test.mjs --spawn --players 5 --duration-sec 3      # forces a breach -> exit 1
```

### scripts/chaos-test.mjs

Hurls a battery of hostile packets and connection behaviours at the server and
asserts one thing above all: **the server must never crash, stall, or leak, and
well-behaved clients must keep being served.**

**The canary.** Before any attack runs, a healthy CANARY client is established in
its own dedicated world (`join`, then liveness on demand via **chat self-echo** —
Voxelheim has no app ping, so the canary proves the server is still processing
application messages by receiving back a chat whose echoed `id` equals its own
welcome id). It must stay responsive through *every* attack — the live proof that
per-connection misbehaviour is sandboxed.

**The 12 attack vectors** (run sequentially, each on a fresh connection unless
noted). The mock *defends*; the real Voxelheim server's *absence* of a defence is
recorded as a WARNING, not a failure:

| # | Vector | Expected outcome |
|---|---|---|
| 1 | invalid JSON text | **silently ignored** (Voxelheim `JSON.parse` in try/catch); no crash |
| 2 | oversized frame (`CHAOS_OVERSIZE_BYTES`, default 8 MB, never ≥ 100 MiB) | mock closes **1009**; real server has **no app size cap** → accepts it (WARNING), not OOM |
| 3 | type-confusion (valid JSON, wrong field types) | `bad_edit` where the edit handler validates, else ignored; no crash |
| 4 | unknown message type (incl. `__proto__`, `constructor`) | **silently ignored**; no prototype pollution |
| 5 | missing required fields | `bad_edit` / ignored per handler; no crash |
| 6 | binary frame where text is expected | ignored; must **not** join |
| 7 | valid fragmented reassembly **and** an unfinished fragment + abrupt disconnect | reassembly works; partial handled cleanly |
| 8 | raw garbage bytes with **no** handshake (`node:net`) | 400 / reset, no throw |
| 9 | mid-handshake disconnect (partial HTTP upgrade, then destroy) | no throw / leak |
| 10 | rapid reconnect storm (open+close ~200×) | survives churn without leaking |
| 11 | slow reader (join, then stop draining while a co-tenant broadcasts at us) | bounded server RSS growth (WS backpressure; broadcasts dropped) |
| 12 | message flood (~thousands msgs/sec for ~3 s) | mock sandbox-closes **1008**; real server has **no rate limit** → accepts flood (WARNING) |

**After each vector** it asserts, and records per vector: (i) the server is still
alive — a spawned server's (or `--server-pid`'s) pid is alive, else a fresh client
can still connect; (ii) the canary still self-echoes; (iii) a fresh healthy client
can still connect + join.

**Severity & exit codes.** Each vector is scored `ok` (safe), `warning` (a
*vulnerability* that is unsafe-but-not-a-crash — e.g. an accepted oversized
frame, no rate limit, unbounded buffering), or `critical` (crashed the server,
disrupted the canary, or caused a DoS). Exit `0` = no crash, canary stayed
responsive, no DoS (**warnings are reported but do not fail the run**); exit `1`
= any critical vector, or the final canary check was unresponsive, or the server
was down.

**Flags / env.** Precedence: `--server-cmd` > `--spawn` > `--url` > default
(mock). Note the chaos harness reads `SERVER_CMD` (not `GAME_SERVER_CMD`):

| Flag | Env | Meaning |
|---|---|---|
| `--spawn` | — | spawn + attack the bundled mock (**default**) |
| `--url <ws://…/ws>` | `GAME_URL` | attack an already-running server; "alive" judged by a fresh client still connecting (or by `--server-pid`) |
| `--server-cmd "<cmd>"` | `SERVER_CMD` | spawn an arbitrary server via shell, wait for its port, then attack |
| `--server-pid <pid>` | `SERVER_PID` | pid of a server started outside the harness — enables crash detection + slow-reader RSS sampling against a `--url` target |
| `--report <path>` | `CHAOS_REPORT` | write a JSON report |
| `--help` | — | usage |

Additional env: `GAME_PORT` (spawned mock port; a free port is chosen when
unset), `GAME_WS_PATH` (default `/ws`), `GAME_MAX_PAYLOAD` (the spawned mock's max
frame bytes; default `1048576`), and **`CHAOS_OVERSIZE_BYTES`** (vector 2 frame
size; default `8388608` = 8 MB, clamped to stay just below the 100 MiB `ws`
inbound cap so it probes the *application's* size cap, not the transport's).

```bash
node scripts/chaos-test.mjs --spawn --report /tmp/chaos.json
node scripts/chaos-test.mjs --url ws://127.0.0.1:3000/ws --server-pid 12345
```

### scripts/mock-server.mjs + the reference server

`mock-server.mjs` is the bundled reference server the harness runs against today —
a **faithful stand-in** for the real Voxelheim server (matches `docs/PROTOCOL.md`
v1). It is authoritative (assigns `p<N>` ids, tracks player state, forwards
`move`/`edit` to same-`(worldId, dim)` recipients and `chat` / `peer-join` /
`peer-leave` room-wide) and speaks the **exact** wire protocol, so the adapter and
both harnesses stay valid without the real game checked out. Keepalive is a
server-initiated WS ping (~2 s here); a missed pong is the only disconnect path.

On listen it prints exactly one line the harnesses key on (they otherwise poll
the port):

```
MOCK-SERVER READY port=<port> path=/ws
```

Config via env: `GAME_PORT` / `PORT` (default `3000`; `GAME_PORT` wins so the
harness can pin `GAME_PORT=0` for an ephemeral port), `GAME_WS_PATH` (default
`/ws`), `MOCK_MAX_PAYLOAD` (default 1 MiB). Run it standalone with
`node scripts/mock-server.mjs`; `node scripts/mock-server.mjs --selftest` asserts
every server→client frame it builds has the exact real-protocol shape.

**Robustness model — two layers:**

*Faithful (mirrors the real server's observed behaviour):*

- Every inbound message is validated field-by-field inside `try/catch`; a handler
  bug can never throw out of the server.
- Invalid JSON / non-object / missing `t` / **pre-join** / unknown `t` are
  **silently ignored** — no error frame, no close. Only `bad_join` /
  `already_joined` / `bad_edit` / `bad_world` produce a `{t:"error"}` reply, and
  the socket always stays open.
- `move` forwards the client `pitch` **verbatim** (not range-validated) — exactly
  what lets the harness smuggle a per-bot `seq` into it.

*Reference-of-good-behaviour extras (the real server LACKS these; the chaos test
records their absence against the real server as a WARNING, not a failure):*

- A per-message size cap (oversized frames closed **1009** instead of buffered) —
  the real server has the 100 MiB `ws` default and **no app cap**.
- A per-connection flood ceiling (> `FLOOD_MSGS_PER_SEC`, 200 msgs/s → sandbox
  close **1008**) — the real server has **no rate limit**. Sandboxing is strictly
  **per-connection**: other clients are never affected.
- Bounded sends: broadcasts are **dropped** to a backpressured (slow / non-reading)
  socket rather than buffered unbounded, so a slow reader can't grow memory.

### THE PROTOCOL

`scripts/lib/protocol.mjs` is the adapter for the **real Voxelheim wire format**
(`docs/PROTOCOL.md` v1). The wire is UTF-8 JSON text frames; every message carries
a short string tag under `"t"`. With `mock-server.mjs` it is one of the **only two
protocol-specific files** — the transport and both harnesses call only its
encoders / `decode()` / correlation helpers / `CAPS`, so retargeting is a
one-file change here. `PROTOCOL_VERSION` is `1`; `decode()` never throws (anything
unparseable, non-object, or unrecognized → `{kind:"unknown", raw}`).

**Handshake.** Open the socket, send `join`, receive `welcome`. Until a valid
`join`, the server silently ignores every other frame. `worldId` must match
`^[A-Za-z0-9_-]{1,64}$` (unknown → auto-created); `dim ∈ {overworld, nether, end}`.

**No `seq` field, no app ping.** The protocol has neither, so the adapter smuggles
correlation into forwarded fields — captured in `CAPS` (`appPing:false`,
`selfEchoChat:true`, `moveSeqCarrier:'pitch'`, `wsPath:'/ws'`, `defaultPort:3000`).

Client → server (encoders → JSON string ready for `WSConn.send`; `encPing()`
returns `null` — there is no app ping, keepalive is the WS pong):

| Kind | Wire shape |
|---|---|
| `join` | `{"t":"join","worldId":<string>,"name":<string>,"dim":<string>}` |
| `move` | `{"t":"move","x","y","z","yaw","pitch":<seq>,"dim"}` — floats; **no `seq` field** on the wire: the monotonic per-bot `seq` rides in `pitch` (forwarded verbatim, not range-validated) |
| `edit` | `{"t":"edit","x","y","z","block","dim"}` — ints; `0≤y<128`, `0≤block≤40`; `block===0` ⇒ **break**, `1..40` ⇒ place (`encBlock` is a back-compat alias of `encEdit`) |
| `chat` | `{"t":"chat","text":<string>}` — trimmed, ≤256 chars; echoes to the whole room **including the sender**. `encRttChat` packs `rtt:<botIdx>:<seq>:<ts>` for the RTT self-echo |

Server → client (`decode()` normalizes each to `{kind, …}`):

| Kind | Wire shape → decoded fields |
|---|---|
| `welcome` | `{"t":"welcome","id":"p<N>","world":{…},"peers":[…]}` → `{id, world, peers}` |
| `peer-join` | `{"t":"peer-join","id","name","x","y","z","yaw","dim"}` → entity fields (upsert; also on a peer's dim-change) |
| `peer-leave` | `{"t":"peer-leave","id"}` → `{id}` |
| `move` | `{"t":"move","id","x","y","z","yaw","pitch","dim"}` → entity fields (same-dim recipients only) |
| `edit` | `{"t":"edit","id","x","y","z","block","dim"}` → `{id, x, y, z, block, dim}` (same-dim only) |
| `chat` | `{"t":"chat","id","name","text"}` → `{id, name, text}` (whole room incl. sender) |
| `error` | `{"t":"error","code","message"}` → `{code, message}`; `code ∈ bad_join｜already_joined｜bad_edit｜bad_world` |
| *(anything else)* | → `{kind:"unknown", raw}` |

**Correlation helpers:**

- `readMoveSeq(decodedMove)` recovers the smuggled seq as `Math.round(pitch)`.
- `matchRttEcho(decodedChat, myId)` returns `{botIdx, seq, ts}` when a chat is
  this bot's own RTT self-echo (`id === myId` and text is `rtt:…`), else `null`.
- `extractPlayerSeqs(welcomeOrMove)` returns `[{id, seq, pos}]` — one entry per
  `welcome.peers` (seq unknown → 0) or a single entry for a `move` (seq =
  `readMoveSeq`) — the hook the load harness uses for drop / OOO / propagation.

### How CI runs the harness

The `backend-load` job (Node 20, 15-min timeout, builtins only — no browser, no
Playwright, never creates a root `package.json`) has two phases:

1. **Harness self-test — always runs, always green.** It exercises the harness
   against the bundled mock with relaxed latency thresholds so noisy shared
   runners don't flake:
   ```bash
   P95_MS=400 P99_MS=800 node scripts/load-test.mjs --spawn --players 20 --duration-sec 6
   node scripts/chaos-test.mjs --spawn
   ```
2. **Full suite against a real server — only when one is detected.** A
   *Detect real server entrypoint* step sets `real=true` and a launch `cmd` when
   **either** `$SERVER_CMD` is set, **or** a root `package.json` exposes a
   `start` script (→ `npm start`), **or** a top-level `server` file/dir exists
   (→ `node server`). When `real=true`, it installs deps (if a `package.json` is
   present) and runs both harnesses via `--server-cmd "<cmd>"`, which spawns the
   real server, waits for its port, and targets it. This lights up automatically
   once the server branch lands — no workflow edit needed.

### Latest measured results (real server)

From a **40-bot, 20 s** run against the **real Voxelheim server**
(`ws://127.0.0.1:3210/ws`, sampled via `--server-pid 672`; your numbers vary by
hardware and load):

**Load — PASS** (0 breaches, exit 0):

- **Connections:** 40/40 connected; **0** connect failures / socket errors /
  unexpected closes.
- **RTT** (chat self-echo, 860 samples): p50 **0.66** / p95 **3.33** / p99
  **6.47** / max **11.93** ms (mean 1.07).
- **Propagation** (move pitch-seq, 12,507 samples): p50 **0.46** / p95 **1.62** /
  p99 **2.16** / max **4.83** ms (mean 0.61).
- **Drops 0 %** (0 of 478,707 expected updates); **out-of-order 0 %** (0 events).
- **Server** (43 samples via `SERVER_PID 672`): CPU avg **~21 %** / peak
  **~28 %**; RSS avg **~81 MB** / peak **~84 MB**; no growth trend, never died.
- **Traffic:** ~480 k moves + ~15.6 k edits + ~33 k chats received; all 860 RTT
  chats matched their self-echo; **0** error / unknown frames. Non-zero
  matched-echo and pitch-seq counts confirm the adapter is on-protocol.

**Chaos — no crash; 2 vulnerabilities recorded** (survived all 12 vectors + a
200/200 reconnect storm; canary stayed responsive; clean SIGTERM shutdown):

- **No app-level message-size cap** — accepted an **8.0 MB** frame
  (`CHAOS_OVERSIZE_BYTES`) without closing; `ws` defaults to a 100 MiB inbound
  cap → single-frame OOM risk. *(WARNING)*
- **No server-side rate limiting** — accepted **~260,400** msgs in 3 s from one
  socket with no throttle/close → flood/DoS vector. *(WARNING)*
- Everything else safe: malformed / pre-join / unknown frames drew **0** errors
  and stayed open (documented Voxelheim behaviour; the `edit` handler returns
  `bad_edit` where it validates); a slow reader grew RSS by only **~0.1 MB** over
  3 s (WS backpressure); the server log shows no exceptions.

## scripts/verify-audio.mjs

Headless-Chromium verification suite for the procedural audio engine
(`audio/sfx/index.js` registry + `audio/engine.js`). It renders real audio
through an `OfflineAudioContext` (stereo, 44.1 kHz) inside actual Chromium, so
CI and humans exercise the exact same code path. Renders are deterministic:
every synth gets a `mulberry32(42)` RNG.

### What it proves

- **Every registered sound renders non-silent and non-clipping.** Each entry of
  the sfx registry is rendered offline; its peak must land in
  `[0.05, 0.99]` — audible but not clipping.
- **Loop `stop()` handling.** Known ambient loops (`wind`, `cave`, `rain`) —
  and any synth whose handle reports `duration === Infinity`, even if not in
  the known set — are rendered for 2.5 s with `handle.stop(2.0)` called, so the
  fade-out path is exercised. Long one-shots get duration hints (`thunder`,
  `explosion`, `achievement`, `mob.*.death`); everything else renders 1.5 s.
- **Rain intensity scaling.** `rain` at `intensity: 1.0` must have higher RMS
  than at `intensity: 0.15`.
- **All music modes.** Each mode in `AudioEngine.MUSIC_MODES` (fallback list:
  `calm`, `nether`, `upbeat`, `melancholy`, `mysterious`) is offline-rendered
  for 6 s: peak in `[0.02, 0.9]` **and** RMS > `0.0008` (sustained energy, not
  one blip). Modes the engine rejects as unknown/unsupported are SKIPped, not
  failed.
- **Positional panning.** `break.stone` played through the engine at
  `pos: {x: 5, y: 0, z: 0}` (listener at origin) must be audible
  (peak > `0.02`) with left/right channel RMS differing by ≥ 10%.

Output is a per-check table (`NAME PEAK RMS STATUS`) plus a summary line.
Exit code 0 = no FAILs (SKIPs are fine) *or* no `audio/` directory at all;
1 = any FAIL or infrastructure error.

### How it works

- Serves `process.cwd()` with an embedded `node:http` static server (with a
  path-traversal guard), so any checkout location works. It deliberately does
  **not** use `audio/server.mjs`, which hardcodes a developer-machine serve
  root.
- Navigates headless Chromium (flags:
  `--autoplay-policy=no-user-gesture-required --no-sandbox`) to
  `/audio/demo.html` just to acquire a same-origin page, then runs the whole
  suite in one `page.evaluate` that dynamically imports `/audio/sfx/index.js`,
  `/audio/dsp.js`, and `/audio/engine.js`.
- Resolves `playwright-core` or `playwright` via `createRequire` anchored at
  candidate directories — no repo `package.json` needed.

### Running it locally

You need Playwright's package in *some* `node_modules` — the script checks, in
order: `$PW_DIR`, `/tmp/pw`, then the current working directory. Using the
auto-detected `/tmp/pw`:

```bash
mkdir -p /tmp/pw
npm --prefix /tmp/pw install playwright
node scripts/verify-audio.mjs        # /tmp/pw is auto-detected; PW_DIR not needed
```

Or point anywhere explicitly:

```bash
PW_DIR="$RUNNER_TEMP/pw" node scripts/verify-audio.mjs
```

Chromium resolution order: `CHROMIUM_PATH` env → a `chrome` binary globbed
under `/opt/pw-browsers/chromium*/chrome-linux/chrome` (local dev containers;
auto-detected) → `undefined`, letting Playwright use its own installed browser
(the CI path after `npx playwright install chromium`). If none of those apply
locally:

```bash
npx --prefix /tmp/pw playwright install chromium
```

All environment variables (all optional):

| Env | Effect |
|---|---|
| `PW_DIR` | Directory whose `node_modules` contains `playwright(-core)`; checked before `/tmp/pw` and cwd |
| `CHROMIUM_PATH` | Explicit Chromium executable, overriding auto-detection |
| `AUDIO_PORT` | Pin the static server port (default: `8123` + random 0–500 to dodge collisions; retries on `EADDRINUSE` unless pinned) |
| `AUDIO_REPORT` | Path to write a full JSON report (bounds, per-check results, summary) |

## scripts/validate-content.mjs

Dependency-free validator for game content JSON. Recursively scans every
`*.json` under the target directory (skipping dotfiles/dot-dirs and
`node_modules`).

```bash
node scripts/validate-content.mjs               # validates ./content (relative to CWD)
node scripts/validate-content.mjs --dir <path>  # validate another directory
node scripts/validate-content.mjs --dir=<path>  # same, = form
node scripts/validate-content.mjs --help
```

Checks, in order:

1. **JSON parse** — every file must `JSON.parse`. Parse errors report line/col
   (when extractable from the error) and a short excerpt. Empty files,
   whitespace-only files, and files that parse to `null` are failures.
2. **Duplicate ids** — any object anywhere with a string `"id"` property
   declares that id. Duplicates (within *or across* files) fail, listing every
   declaration location.
3. **Generic reference resolution** — a string value (or string entry of an
   array) counts as a reference when its key matches
   `/(^|[._-])(id|ref)s?$/i` after camelCase normalization: `blockId`,
   `item_ref`, and `targetIds` match; `grid`, `valid`, and `href` do not. The
   `"id"` declaration key itself is excluded. Every reference must exist in the
   declared-id set.
   - **Warning downgrade:** if *zero* ids are declared anywhere, unresolved
     references become warnings instead of failures (the schema likely uses a
     different id convention), and a note explains the downgrade.

Output is per-file `OK`/`FAIL` lines with indented reasons, then a summary
(`files, ids, refs checked, failures, warnings`). Exit codes: `0` = passed, or
skipped because the target directory doesn't exist (`no content directory —
skipping`); `1` = any failure (warnings alone do not fail); `2` = bad usage.

## No root package.json

Nothing in this directory or in the CI workflow reads from, requires, or
creates a root `package.json`:

- `validate-content.mjs` uses only Node builtins.
- The backend harness (`load-test.mjs`, `chaos-test.mjs`, `mock-server.mjs`, and
  `lib/*.mjs`) uses only Node builtins — the WebSocket transport is hand-rolled,
  so there is no `ws` dependency and no `package.json` to install.
- `verify-audio.mjs` uses Node builtins plus a Playwright resolved from an
  *external* directory (`PW_DIR` / `/tmp/pw`); CI installs it under
  `$RUNNER_TEMP/pw`, outside the checkout.
- The `game-tests` and `backend-load` jobs only *consume* a root `package.json`
  if another branch lands one — they never create it, and both skip / self-test
  cleanly until then.
