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

A dependency-free harness that drives concurrent bot clients at a multiplayer
server and gates CI on latency, correctness, and crash-resistance. It exists to
stress the game backend **before that backend has been pushed**:

- **Bot clients over a hand-rolled RFC6455 transport.** No `ws` package, no
  global `WebSocket` — `lib/ws-transport.mjs` implements the WebSocket client
  *and* server (opening handshake, framing, masking, fragmentation, control
  frames, oversized-frame rejection) on Node builtins alone.
- **An isolated protocol adapter.** `lib/protocol.mjs` is the *single* place the
  assumed wire format lives. Every other module is protocol-agnostic and only
  calls its encoders / `decode` / `extractPlayerSeqs`.
- **A bundled reference mock server.** `mock-server.mjs` is an authoritative,
  hardened server that speaks exactly the adapter's protocol, so the whole thing
  **runs for real today** with zero external setup. When the real server lands,
  point the harness at it (`--url` / `--server-cmd`).

Module layout (all under `scripts/`, Node 20 CI / Node 22 local, builtins only):

| File | Role |
|---|---|
| `lib/ws-transport.mjs` | RFC6455 WebSocket client + server. Protocol-agnostic; exposes the raw socket and chaos hooks (`sendRawFrame`, `sendRawBytes`); never lets one bad connection throw out of the server. Self-test: `node scripts/lib/ws-transport.mjs --selftest` |
| `lib/protocol.mjs` | **THE adapter.** Client→server encoders, server→client `decode()` (never throws), and `extractPlayerSeqs()`. See [THE PROTOCOL](#the-protocol) |
| `lib/util.mjs` | `parseArgs` (CLI + env + default precedence), typed env readers, `Stats` (percentiles), `startProcSampler` (Linux `/proc` CPU%/RSS), `printReport`, `writeJsonReport` |
| `mock-server.mjs` | Reference authoritative server + robustness spec. See [the reference server](#scriptsmock-servermjs--the-reference-server) |
| `load-test.mjs` | Load harness. See [below](#scriptsload-testmjs) |
| `chaos-test.mjs` | Adversarial-input chaos harness. See [below](#scriptschaos-testmjs) |

**Target selection** is shared by both harnesses, in precedence order (highest
first):

1. `--server-cmd "<cmd>"` — spawn an arbitrary server through a shell, poll its
   port, then target it.
2. `--spawn` — spawn the bundled reference mock (`mock-server.mjs`).
3. `--url ws://host:port` — target an already-running external server.
4. *(nothing)* — **defaults to the mock**, same as `--spawn`.

### scripts/load-test.mjs

Spins up N headless bot clients that connect, `join`, then generate realistic
traffic (a ~15 Hz random walk of `move`s, a `block` edit every ~2 s, a `chat`
every ~10 s, a `ping` every ~1 s), staggered over a ~2 s ramp to avoid a
thundering herd. It measures how the server holds up under concurrent load.

**What it measures** (all latencies as p50 / p95 / p99 / max):

| Metric | Definition |
|---|---|
| **RTT** | `ping`→`pong` round-trip, matched on the echoed `ts` |
| **Propagation** | time from a bot sending `move#seq` until that `seq` first appears in a broadcast `state` frame (recorded once per `(id, seq)`) |
| **Drops** | per `(receiver, source)`, skipped `seq` ranges, as a % of expected updates |
| **Out-of-order** | per `(receiver, source)`, `seq` that went backwards, as a % of expected updates |
| **Server CPU / mem** | `/proc`-sampled CPU% and RSS for a server the harness spawned (**n/a** for a bare `--url` it did not launch) |
| **Connection errors** | failed connects, unexpected mid-test closes, socket errors |

**Flags / env** (precedence: CLI flag > env > default):

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--players <n>` | `GAME_BOTS` | `50` | concurrent bot clients |
| `--duration-sec <s>` | `GAME_DURATION` | `30` | active-load window (after the ~2 s ramp) |
| `--url <ws-url>` | `GAME_URL` | `""` | target an external server |
| `--spawn` | — | off | spawn + target the bundled mock |
| `--server-cmd "<cmd>"` | `GAME_SERVER_CMD` | `""` | spawn an arbitrary server via shell |
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
spawned server died mid-test, **or** any bot failed to connect, **or** no pongs
came back at all (server unresponsive), **or** the run was interrupted by a
signal, **or** the target server failed to start.

```bash
node scripts/load-test.mjs --spawn --players 20 --duration-sec 6 --report /tmp/load.json
node scripts/load-test.mjs --url ws://127.0.0.1:8080/        # target external server
P95_MS=1 node scripts/load-test.mjs --spawn --players 5 --duration-sec 3   # forces a breach -> exit 1
```

### scripts/chaos-test.mjs

Hurls a battery of hostile packets and connection behaviours at the server and
asserts one thing above all: **the server must never crash, stall, or leak, and
well-behaved clients must keep being served.**

**The canary.** Before any attack runs, a healthy CANARY client is established
(`join` + `ping` every 500 ms). It must stay connected and keep receiving pongs
through *every* attack — the live proof that per-connection misbehaviour is
sandboxed.

**The 12 attack vectors** (run sequentially, each on a fresh connection unless
noted):

| # | Vector | Expectation |
|---|---|---|
| 1 | invalid JSON text | `{t:"error"}` replies; not a crash |
| 2 | oversized frame > `maxPayload` (~5 MB) | Close **1009**, not OOM |
| 3 | type-confusion (valid JSON, wrong field types) | error replies / sandbox, not a crash |
| 4 | unknown message type (incl. `__proto__`, `constructor`) | error replies; no prototype pollution |
| 5 | missing required fields | error replies |
| 6 | binary frame where text is expected | rejected; must **not** join |
| 7 | valid fragmented reassembly **and** an unfinished fragment + abrupt disconnect | reassembly works; partial handled cleanly |
| 8 | raw garbage bytes with **no** handshake (`node:net`) | 400 / reset, no throw |
| 9 | mid-handshake disconnect (partial HTTP upgrade, then destroy) | no throw / leak |
| 10 | rapid reconnect storm (open+close ~200×) | survives churn without leaking |
| 11 | slow reader (join, then stop draining while the server broadcasts) | bounded server RSS growth (drops to backpressured sockets) |
| 12 | message flood (~thousands msgs/sec for ~3 s) | rate-limit / sandbox close **1008** |

**After each vector** it asserts, and records per vector: (i) the server is still
alive — a spawned server's pid is alive, or (targeted) a fresh client can still
connect+ping; (ii) the canary still receives pongs; (iii) a fresh healthy client
can still connect+join+ping.

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
| `--url <ws://…>` | `GAME_URL` | attack an already-running server; "alive" judged by a fresh client still connecting |
| `--server-cmd "<cmd>"` | `SERVER_CMD` | spawn an arbitrary server via shell, wait for its port, then attack |
| `--report <path>` | `CHAOS_REPORT` | write a JSON report |
| `--help` | — | usage |

Additional env: `GAME_PORT` (spawned mock port; a free port is chosen when
unset), `GAME_WS_PATH` (default `/`), `GAME_MAX_PAYLOAD` (server max frame bytes;
default `1048576`).

```bash
node scripts/chaos-test.mjs --spawn --report /tmp/chaos.json
node scripts/chaos-test.mjs --url ws://127.0.0.1:8080/
```

### scripts/mock-server.mjs + the reference server

`mock-server.mjs` is the bundled reference server the harness runs against today.
It is authoritative (assigns ids, tracks player state, broadcasts world `state`
at ~20 Hz) and — critically — **hardened**, so no malformed / oversized /
type-confused / flooding client can crash it or degrade service for well-behaved
clients. **It is also the spec the builder's real server must satisfy.**

On listen it prints exactly one line the harnesses key on (they otherwise poll
the port):

```
MOCK-SERVER READY port=<port> path=<path>
```

Config via env: `GAME_PORT` (default `8080`), `GAME_WS_PATH` (default `/`),
`GAME_MAX_PAYLOAD` (default 1 MiB). Run it standalone with
`node scripts/mock-server.mjs`; `node scripts/mock-server.mjs --selftest` asserts
that every server→client frame it builds round-trips through `protocol.decode()`.

**Robustness model (the contract the real server must meet):**

- Every inbound message is validated field-by-field inside `try/catch`; a handler
  bug can never throw out of the server.
- Bad input → a small `{t:"error"}` reply **plus a per-connection strike**; after
  `MAX_STRIKES` (10) the offending connection is sandbox-closed (code **1008**).
- A per-connection flood (> `FLOOD_MSGS_PER_SEC`, 200 msgs/sec) is
  sandbox-closed too.
- Sandboxing is strictly **per-connection**: other clients are never affected.
- Sends are bounded: `state` / broadcasts are **dropped** to a backpressured
  (slow / non-reading) socket rather than buffered unbounded, so a slow reader
  cannot grow server memory without limit.

### THE PROTOCOL

`scripts/lib/protocol.mjs` defines the **assumed** wire format. The wire is
UTF-8 JSON text frames; every message carries a short string tag under `"t"`.
This is the **single adapter to edit when the builder finalizes the real
protocol** — the transport, both harnesses, and the mock only ever call this
module's encoders / `decode` / `extractPlayerSeqs`, so retargeting the harness to
the real server is a one-file change here. `PROTOCOL_VERSION` is `1`;
`decode()` never throws (anything unparseable, non-object, or unrecognized →
`{kind:"unknown", raw}`).

Client → server (encoders → JSON string ready for `WSConn.send`):

| Kind | Wire shape |
|---|---|
| `join` | `{"t":"join","name":<string>,"v":1}` |
| `move` | `{"t":"move","seq":<n>,"pos":{x,y,z},"yaw":<n>,"pitch":<n>[,"vel":…]}` — `seq` is a monotonic per-bot counter used for drop / out-of-order / propagation tracking; `vel` included only when supplied |
| `block` | `{"t":"block","action":"place"\|"break","pos":{x,y,z},"block":<any>}` |
| `chat` | `{"t":"chat","text":<string>}` |
| `ping` | `{"t":"ping","ts":<number>}` — `ts` is the client clock, echoed back for RTT |

Server → client (`decode()` normalizes each to `{kind, …}`):

| Kind | Wire shape (as the mock emits it) → decoded fields |
|---|---|
| `welcome` | `{"t":"welcome","v":1,"id":<n>,"tick":<n>,"spawn":{x,y,z},"players":[{id,pos,yaw,seq}]}` → `{id, tick, spawn, players}` |
| `state` | `{"t":"state","tick":<n>,"players":[{id,pos,yaw,seq}]}` → `{tick, players}` (broadcast ~20 Hz) |
| `block` | `{"t":"block","by":<id>,"action":…,"pos":{x,y,z},"block":…,"seq":<n>}` → `{by, action, pos, block, seq}` |
| `chat` | `{"t":"chat","from":<id>,"text":<string>}` → `{from, text}` |
| `pong` | `{"t":"pong","ts":<number>}` → `{ts}` (echoes the client `ts`) |
| `error` | `{"t":"error","code":…,"msg":…}` → `{code, msg}` |
| *(anything else)* | → `{kind:"unknown", raw}` |

`extractPlayerSeqs(welcomeOrState)` returns `[{id, seq, pos}]` for every player a
`welcome` / `state` carries — the hook the load harness uses for drop /
out-of-order / propagation tracking.

**Builder handoff:** when the real protocol is known, edit `protocol.mjs` to
match it, and use `mock-server.mjs` as the reference for the server behaviour
(id assignment, state broadcast cadence, and the robustness/sandboxing model
above) the real server should reproduce.

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

### Latest local results

From a local run against the bundled reference mock on this machine (mock target,
Linux; your numbers will vary by hardware and load):

- **Load** (`--spawn --players 40 --duration-sec 15`): **PASS** — 40/40 bots
  connected, 0 connection errors. RTT p50/p95/p99 = **0.62 / 21.18 / 31.29 ms**;
  propagation p50/p95/p99 = **25.54 / 47.83 / 50.34 ms**; drops **0.23 %**,
  out-of-order **0 %**. Mock server CPU avg/peak **6.3 % / 12 %**, RSS avg/peak
  **75 / 83 MB**. (Well inside the default 150/300 ms thresholds.)
- **Chaos** (`--spawn`): **PASS** — 12/12 vectors `ok`, **0 warnings, 0
  failures**; canary stayed responsive throughout and the server stayed alive.
  Vector 2 closed a 5 MB frame with **1009**, vector 12 sandbox-closed the
  flooder with **1008** after ~400 messages, and the slow-reader vector grew
  server RSS by **~0 MB** (broadcasts dropped to the backpressured socket).

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
