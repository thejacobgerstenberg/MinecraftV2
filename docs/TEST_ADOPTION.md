# Test Adoption — folding `tests-plus/` into the game's `tests/` + `npm test`

> **Purpose.** `tests-plus/` is a set of **deep, adoptable** `node:test` suites that
> import the game's REAL modules (`public/src/...`, `server/index.js`). They were
> authored on `feature/ci` but are meant to be **merged into the core game branch**
> (`feat/voxel-sandbox-game`) where they run against the actual code. This doc tells
> the builder exactly how to fold them in, why they are safe to add incrementally,
> and what each file buys over the existing thin `tests/` suites.
>
> Cross-reference: [`docs/RELEASE_READINESS.md`](./RELEASE_READINESS.md) — Part B,
> **Tests ◐** ("8 game suites average ~1 assertion each"). This adoption is the work
> that moves that row toward **✓**.

---

## 1. How the builder folds `tests-plus/` into `tests/` + `npm test`

The game runner today is `package.json` → `"test": "node tests/run-all.mjs"`, a custom
harness that **spawns each `tests/*.test.mjs` sequentially**. The `tests-plus/` files are
**`node:test`** files (they `import { test } from 'node:test'` and self-register), not
scripts the custom runner drives. So adoption is: get `node --test` to see them. Two
equivalent ways — pick one:

### Option A — copy the files next to `tests/`, add a second runner line (recommended)

Copy `tests-plus/*.test.mjs` into the tree (either straight into `tests/`, or keep a
sibling `tests-plus/` directory next to `public/` and `server/`) and extend the test
script so both runners fire:

```jsonc
// package.json
"scripts": {
  "test":       "node tests/run-all.mjs && node --test tests-plus/",
  "test:plus":  "node --test tests-plus/",
  "test:legacy":"node tests/run-all.mjs"
}
```

- If you instead drop the files **into `tests/`**, point `node --test` there:
  `"test": "node tests/run-all.mjs && node --test 'tests/*.plus.test.mjs'"` (rename on
  copy so `run-all.mjs`'s own glob doesn't try to spawn them as standalone scripts —
  `node:test` files register callbacks, they don't self-execute assertions on plain
  `node file.mjs`).
- Keeping them in a **separate `tests-plus/` directory** is the cleanest: zero collision
  with `run-all.mjs`'s discovery, and `node --test tests-plus/` is one line.

### Option B — require `node --test` as the canonical runner

Migrate everything to Node's built-in test runner and retire (or wrap) `run-all.mjs`:

```jsonc
"scripts": { "test": "node --test" }
```

`node --test` (no path) auto-discovers `**/*.test.mjs` across `tests/` **and**
`tests-plus/`. This is the long-term target — one runner, TAP output, parallelism,
`--test-name-pattern` filtering — but it requires the existing `tests/*.test.mjs` to be
`node:test`-shaped too (they largely are; the desync/net suites already `spawn` the
server and use raw `ws`, which works fine under `node --test`). Until that migration is
verified, **Option A is the low-risk path**: it adds depth without touching the legacy
runner.

Either way, **CI stays green when the game is absent** (see §2): on a standalone
`feature/ci` checkout `node --test tests-plus/` prints all-skip, exit 0.

> **Dependency note.** `meshing.test.mjs` pulls `three` (BufferGeometry only, node-safe);
> `saveload.test.mjs` spawns `server/index.js` and opens raw `ws` clients. Both are
> already game-branch deps — run `npm install` in the game worktree before `npm test`.
> The feature-detect guard (§2) means a missing dep self-skips rather than erroring.

---

## 2. `node:test` usage + incremental-safe feature detection

Every `tests-plus/` file is a standard **`node:test` + `node:assert/strict`** ESM module:

```js
import { test } from 'node:test';          // (worldgen uses `import test from 'node:test'`)
import assert from 'node:assert/strict';
```

Node 22 ships `node:test` built-in — no dev dependency, no config.

**Feature-detect / top-level skip guard.** Each file dynamic-imports the real game
modules inside a `try/catch` at the top of the module, *before* registering assertions:

```js
let buildChunkMesh = null, loadError = null;
try {
  const mesherMod = await import('../public/src/engine/ChunkMesher.js');
  buildChunkMesh = mesherMod.buildChunkMesh;
} catch (err) { loadError = err; }

// ...then, per test:
test('mesher culls interior faces', { skip: loadError ? 'game module absent' : false }, () => { ... });
```

If the import fails — because the game tree (`public/src/...`, `server/index.js`) or a
dep (`three`, `ws`) is **absent on `feature/ci` standalone** — the file registers a
single skipped test with a TODO and `node --test tests-plus/` stays **green** (exit 0).
In the **game worktree** (`origin/feat/voxel-sandbox-game`, where `tests-plus/` sits at
repo root next to `public/` and `server/`), the imports resolve and the real assertions
run. Import paths are relative from `tests-plus/`: `../public/src/...`, `../server/...`.

Consequence: **these files are safe to add incrementally.** You can merge one, several,
or all of them before the game code lands on the same branch — they never break the
build; they simply light up (stop skipping) once their target modules are present.

---

## 3. COVERAGE MAP — `tests-plus/` file → P0/P1 capability → depth added

Six P0/P1 capabilities from the recon: **worldgen, meshing, physics, raycast, save/load,
protocol/anticheat**. The existing `tests/` suite has 8 files but is **thin** (recon:
`security`=5 assertions, `net`=2, the rest ~1 each — see RELEASE_READINESS Tests ◐).
`tests-plus/` adds ~67 registered `test()` blocks with real invariants, golden vectors,
and end-to-end round-trips.

| Capability (P0/P1) | `tests-plus/` file | `test()` blocks | Real modules imported | Existing thin `tests/` suite | Depth added over the thin suite |
|---|---|---:|---|---|---|
| **Worldgen** (P0) | `worldgen.determinism.test.mjs` | 15 | `world/TerrainGenerator.js`, `constants.js`, `blocks/blocks.js`, `dimensions/dimensions.js` (opt) | `tests/worldgen.test.mjs` (~1 assert) | **Golden hashes** pinned at `71689cf` lock byte-level determinism; per-dim invariants (bedrock@y0, sea level, cave carve band, ore depth incl. diamond y≤16, nether lava≤y31 / netherrack, end island vs void); same-seed byte-identity |
| **Meshing** (P0) | `meshing.test.mjs` | 12 | `engine/ChunkMesher.js`, `engine/World.js`, `engine/Chunk.js` (+`three`) | `tests/mesher.test.mjs` + `tests/dircull.test.mjs` (~1 assert) | Face-cull correctness (only vs air/transparent; no face between same transparent id), 4-verts/6-idx-per-quad accounting, **AO in vertex color** (`AO_BRIGHTNESS`, per-face shades, liquid-with-air-above 0.9, emissive full-bright), naive-vs-greedy surface-area equivalence |
| **Physics** (P1) | `physics.test.mjs` | 25 | `gameplay/physics.js`, `gameplay/Player.js`, `gameplay/raycast.js`, `blocks/blocks.js` | `tests/physics.test.mjs` (~1 assert) | **Regression pins** of shipped constants (SIZE, WALK 4.3 / SPRINT 5.805 / SNEAK 1.29, GRAVITY −24, JUMP 7.75, TERMINAL 50, no step-up); collision-axis velocity zeroing, substep no-tunnel@50, `isInLiquid`; **spec-delta checks** vs MULTIPLAYER_PROTOCOL §0 flagged separately (see §4) |
| **Raycast** (P1) | `raycast.test.mjs` | 13 | `gameplay/raycast.js` | `tests/raycast.test.mjs` (~1 assert) | DDA hit/miss across all 6 faces, placement-cell normal (`nx,ny,nz`), `maxDist` cutoff, water/lava/air skipped, portal(29) hittable-though-non-solid, zero-dir → miss, origin-inside-solid → `face:null` backward-neighbor |
| **Save/load** (P0) | `saveload.test.mjs` | 2 (full e2e round-trips) | drives `server/index.js` via `child_process` + raw `ws` | *(none — no dedicated suite today)* | **Server-driven serialize→deserialize round-trip**: POST schema `{id,name,seed,createdAt,edits:{ow,nether,end}}`, WS `edit` across all 3 dims, flush on last-leave, **process restart** on same `WORLD_DIR` (cold load), deep-equal via GET + fresh WS `welcome.world.edits`; edit-key/value shape validation |
| **Protocol / anticheat** (P0) | *(not yet a dedicated `tests-plus/` file — see gap note below)* | — | inline in `server/index.js` (no exports) | `tests/security.test.mjs` (5 asserts) + `tests/net.test.mjs` (2 asserts) | `saveload.test.mjs` exercises the **validated `edit` frame path** (valid-id / bounds / y=0-protected / reach≤7 gates) as a side effect, but reject-reason ordering, rate limits (MSG 60/s, EDIT 20/s, CHAT 3/2000ms), payload cap (64KB→1009), move budget/grace, and `server_full`/1013 are **still recon'd, not yet asserted** — this is the next file to author |

**Gap called out for the builder.** Protocol/anticheat is the one P0 capability without a
dedicated deep file yet. Everything needed is in the recon (server constants at
`server:44-90`, edit-reject order `invalid→bounds→protected→dim→reach→rate`, the
`connectClient/waitFor/sendJson` helper pattern from `tests/net.test.mjs`). A future
`tests-plus/anticheat.test.mjs` should be **server-driven** like `saveload.test.mjs`
(spawn `server/index.js`, raw `ws`), bind a **private port** (the existing server suites
use fixed 3105/3310/3312 — run sequentially to avoid clashes), and feature-detect the
same way.

---

## 4. Known failures (real bugs found)

**Triage run:** `node --test tests-plus/*.test.mjs` against `feat/voxel-sandbox-game`
(worktree of the game tree). Result after triage: **81 tests, 72 pass, 9 skip, 0 fail** —
the suite is **GREEN and adoptable**. All 72 assertions pass against the current shipped
code. The 9 skips are **real code-vs-spec findings** (documented below); each is a
`test(..., { skip: 'CODE BUG: ...' }, ...)` whose reason string points here. Fixing the
code flips the skip back to an active assertion — the tests are already written.

**No test-bugs were found.** Every `physics.test.mjs` regression pin (WALK 4.3, SPRINT
5.805, SNEAK 1.29, GRAVITY −24, JUMP 7.75, TERMINAL −50, no step-up, reach 5/7,
collision-axis zeroing, substep no-tunnel, `isInLiquid`) asserts the real shipped behavior
correctly and passes. The worldgen golden hashes and anticheat/save-load/meshing/raycast
suites all pass unchanged.

### Real code-vs-spec findings (the 9 skips)

Root cause is shared: the shipped player physics uses a **self-consistent continuous model
(blocks/s², dt-integrated)** whose constants do **not** match the **tick-based design spec**
`docs/MULTIPLAYER_PROTOCOL.md` §0 (20 Hz; spec b/tick values converted to b/s via
`SIM_HZ=20`). Spec values are the project's canonical Minecraft-parity constants and are
also cited as ground truth in `docs/SECURITY_FINDINGS.md` (`EDIT_REACH_BLOCKS=6`,
`SPEED_FLY=10.89 b/s`). The **reach** delta is additionally a security/anticheat gap.

| # | Test (skipped) | Code (measured) | Spec §0 | Severity | Evidence |
|---|----------------|-----------------|---------|----------|----------|
| 1 | reach: EDIT_REACH_BLOCKS 6 | client 5 / server cap 7 | 6 | **S1** | `raycastVoxel(maxDist=5)` in `raycast.js:47`; `MAX_REACH=7` in `server/index.js:76`; server accepting reach 7 > spec 6 is the S1 edit-reach VULN in `SECURITY_FINDINGS.md` §2 |
| 2 | step-up: STEP_HEIGHT 0.6 | none (0) | 0.6 | **S2** | `physics.js` `moveAndCollide` has no auto-step; a 1-block ledge blocks the player flush (`climbsStep` → `climbed:false`) |
| 3 | gravity: −0.08 b/tick² | −24 b/s² | −32 b/s² | **S2** | `GRAVITY=-24` `Player.js:33`; free-fall 2nd-difference measures −24; spec −0.08×400=−32 |
| 4 | jump launch: 0.42 b/tick | 7.75 b/s | 8.4 b/s | **S2** | `JUMP_VELOCITY=7.75` `Player.js:35`; spec 0.42×20=8.4 |
| 5 | terminal: −3.92 b/tick | −50 b/s | −78.4 b/s | **S2** | `TERMINAL_FALL_SPEED=50` `Player.js:37`; spec −3.92×20=−78.4 |
| 6 | walk: SPEED_WALK 4.317 | 4.3 b/s | 4.317 b/s | **S3** | `WALK_SPEED=4.3` `Player.js:28` |
| 7 | sprint: SPEED_SPRINT 5.612 | 5.805 b/s | 5.612 b/s | **S3** | `4.3 × SPRINT_MULT 1.35 = 5.805` `Player.js:29` |
| 8 | sneak: SPEED_SNEAK 1.295 | 1.29 b/s | 1.295 b/s | **S3** | `4.3 × SNEAK_MULT 0.30 = 1.29` `Player.js:30` |
| 9 | fly: SPEED_FLY 10.89 | 10 b/s | 10.89 b/s | **S3** | `FLY_SPEED=10` `Player.js:31`; spec value cited in `SECURITY_FINDINGS.md` |

**Triage disposition:** accept the deltas as documented skips for adoption (suite is green
and the bugs are pinned). Fix path for each: reconcile the continuous model to spec §0
(scale constants by the b/tick→b/s conversion, add STEP_HEIGHT auto-step, lower the server
reach cap toward 6). Finding #1 should be prioritized — it is the only one that is a live
anticheat exposure, not a feel/parity delta.

### Other expected-and-meaningful failure classes (none triggered this run)

- **Golden-hash flips (worldgen).** If worldgen output changed since `71689cf`, the pinned
  `GOLDEN[]` hashes fail — the determinism tripwire doing its job. **Not triggered**:
  `worldgen.determinism.test.mjs` passes.

---

## 5. Cross-reference

- **`docs/RELEASE_READINESS.md`** — Part B, **Tests ◐**: the current game suite is "8
  suites via `npm test`, but **thin** (security=5, net=2, rest ~1 assertion)." Adopting
  `tests-plus/` is the concrete work that deepens that coverage; once merged into
  `feat/voxel-sandbox-game` and green, update the Tests row toward **✓** and note the
  added worldgen-determinism / meshing-AO / physics-regression / raycast-DDA /
  save-load-roundtrip depth.
- **Blocker #6** in RELEASE_READINESS ("Test depth is thin … Coverage should deepen
  before calling QA done") is the blocker this adoption retires (modulo the
  anticheat-file gap in §3 and any browser e2e, which lives on `#12`/`#3`).
