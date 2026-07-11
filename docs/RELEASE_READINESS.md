# Loomfall (MinecraftV2) — Release Readiness Dashboard

> **LIVING DOCUMENT — as of the latest audit.** Status below is grounded in the
> Release Recon inventory (recon date 2026-07-11), not aspiration. Every claim
> cites the branch/PR that proves it. When branches move, update this file.
>
> - Repo: `thejacobgerstenberg/minecraftv2`
> - Integration target (core game): `origin/feat/voxel-sandbox-game` @ `98c7ea9`
> - `origin/main` = `5903850` · `origin/master` = `81e81e9`
> - Open PRs: **11, all DRAFT.** PR **#7 does not exist** (numbering gap).
> - **No open PR exists for the core game branch** — only `#12` targets it as a base.

Legend: **✓** done + verified · **◐** partial · **✗** gap ·
Class: **CODE** / **ASSET** / **CONTENT** / **DOCS-ONLY**

---

## PART A — PR / Branch integration table

One row per PR (#1–#12; #7 absent) plus the core game branch. "Integration status"
is measured against `feat/voxel-sandbox-game`. Note: **no feature branch is a literal
git ancestor of the game branch** (`merge-base --is-ancestor` = exit 1 for all) — the
game branch carries **vendored copies** under `public/`, so a capability can be present
in-game while its PR still reads "unmerged."

| PR | Branch (base) | Class | Delivers | Verification status (what's proven) | Integration into `feat/voxel-sandbox-game` | Blocking deps |
|----|---------------|-------|----------|-------------------------------------|--------------------------------------------|---------------|
| **#1** | `feature/audio-engine` (→master) | CODE | Procedural Web Audio engine: SFX, generative music, demo (`audio/`) | Audio **headless-verified** via `scripts/verify-audio.mjs` (playwright/Chromium) on CI harness | **INTEGRATED (copy) + WIRED** — `public/audio/*`, `public/src/audio/GameAudio.js`; `main.js` imports `GameAudio` | none |
| **#2** | `feature/story-content` (→master) | CONTENT | Lore, achievements, splashes, ending, naming, tips (`content/`) | Content **schema-validated** via `scripts/validate-content.mjs` (CI) | **INTEGRATED (copy)** — `public/content/*` | none |
| **#3** | `feature/ci` (→master) | CODE | CI: content-validation, headless audio verify, conditional game tests, **backend load + chaos + soak + authority + persistence** harness (`.github/workflows/ci.yml`, `scripts/`) | Harness self-tests green standalone; backend suites: load (20 players/6s), chaos, soak, authority, persistence. Jobs feature-detect + skip when target absent | **NOT STARTED** — 0 `.github/` and 0 `scripts/` in game branch; **CI never runs against the actual game today** | Needs retarget of workflow paths to game (`server/`, `public/`) |
| **#4** | `design/parity-spec` (→master) | DOCS-ONLY | Parity audit, art direction, UX spec, MP protocol, QA plans (`docs/*.md`, 9 files) | Design review only (docs) | **PARTIAL / DIVERGENT** — game `docs/` = 37 files (mostly `docs/shots/*.png`); the spec md set not confirmed present | `docs/` conflict hot-spot (ci + deploy + game) |
| **#5** | `feature/weather` (→master) | CODE+ASSET | Rain/snow/lightning/sky visuals (`weather/`) | Standalone visual module | **INTEGRATED (copy) + WIRED** — `public/weather/*`; `main.js` imports `WeatherSystem from '../weather/weather.js'` | none |
| **#6** | `feature/mobs` (→master) | CODE+ASSET | ~19 voxel creatures + MobManager, AI, breeding, loot (`mobs/`) | Standalone module + screenshots | **INTEGRATED (copy) + WIRED** — `public/mobs/*`; `main.js` imports `MobManager`/`spawnRules`/`lootTables` | none |
| **#8** | `feature/graphics-lab-v2` (→master) | CODE+ASSET | Production render modules + **richer texture packs**, settings, benchmark, 25 screenshots (`graphics-lab/`) | Benchmark + 25 shots (visual). Supersedes v1 `feature/graphics-lab` (no open PR) | **PARTIAL** — render **src** only in `public/graphics/src/*` (in `main.js`); the lab harness, richer packs & screenshots **not wired in** | Packs not integrated → texture-pack gap (see Part B) |
| **#9** | `feature/brand` (→master) | ASSET/DOCS | Logo, color system, landing page, brand guide (`brand/`) | Asset review only | **NOT STARTED** — 0 brand files in game branch | Optional for playable release |
| **#10** | `feature/ui-kit` (→master) | CODE | Palette widgets, HUD, accessible gallery (`ui-kit/`) | Component/a11y review | **NOT STARTED** — game ships its own `public/src/ui/*`; ui-kit not consumed | Optional (duplicate UI) |
| **#11** | `feature/avatars` (→master) | CODE+ASSET | Animated voxel avatars + PeerAvatars drop-in (`avatars/`) | Standalone package | **PARTIAL** — MP drop-in only: `public/src/net/PeerAvatars.js` in `main.js`; full avatars pkg absent | none |
| **#12** | `feature/deploy` (→ **feat/voxel-sandbox-game**) | CODE+DOCS | Dockerfile, hosting guide, run script, **smoke test**, **2-client e2e**, join UX, status page (`deploy/`) | **Deploy smoke** (`deploy/smoke.mjs`: `/api/health` 2xx, `/` 200 html, WS join→welcome). **2-client e2e 11/11** (`deploy/e2e-multiplayer.mjs`) | **DOWNSTREAM / closest to shippable** — the **only PR based on the game branch**; game HEAD IS an ancestor of deploy (exit 0); deploy carries full game (125 files) + deploy layer | Rides on game branch; carries root `.gitignore` + `docs/` (conflict paths) |
| **—** | `feat/voxel-sandbox-game` (CORE) | CODE | The game: `public/`, `server/`, `tests/`, root `package.json` (name `loomfall` v0.1.0; express5/three0.185/ws8) | `npm test` → `node tests/run-all.mjs`, **8 suites** (dircull, mesher, net, physics, raycast, security, worldgen). Coverage thin (security=5 assertions, net=2, rest ~1). No browser e2e in-branch | **THIS IS THE INTEGRATION POINT** — already bundles audio/content/mobs/weather/graphics-src/peer-avatars by copy | **Has NO PR** — nothing formally opens it to main/master |

**Path-divergence risk:** #1/#2/#5/#6/#8/#11 target **master** and **duplicate** content already
vendored into the game under `public/` (e.g. `audio/` vs `public/audio/`). Merging them to master
does **not** feed the game — treat as source reconciliation (retarget/close against master), not
integration work.

---

## PART B — Definition of Done (production-grade checklist → user requirements)

Mapped to the user's stated features. Status reflects recon evidence only.

| Requirement | Status | Evidence / why | Owner branch/PR |
|-------------|:-----:|----------------|-----------------|
| **Blocks** | ✓ | Block system present: `public/src/blocks/blocks.js`, `constants.js` | `feat/voxel-sandbox-game` |
| **Texture packs** | ◐ | **Procedural, 3 packs** (`{default,smooth,gritty}` canvas painters in `public/src/textures/texturePacks.js` + `TextureAtlas.js`) — functional but **no PNG assets**; graphics-lab-v2's richer packs **not wired in** | game branch (base) · richer packs on **#8** (unintegrated) |
| **Dimensions (overworld/nether/end)** | ✓ | All 3 generated **and portal-routed**: `public/src/dimensions/dimensions.js` (Warpwold/Cinderloom/Nevermend, per-dim sky+gen); `gameplay/portals.js` (obsidian→nether, end_stone→end); server persists `edits:{overworld,nether,end}` | `feat/voxel-sandbox-game` |
| **Multiplayer** | ✓ | `server/index.js` ws@8: room-per-world, join/welcome, pos/dim/edit sync, anticheat, 64KB cap; client `net/NetClient.js`+`PeerAvatars.js`. **2-client e2e 11/11** on `feature/deploy` | game branch · e2e proof on **#12** |
| **Controls** | ✓ | `gameplay/Controls.js`, `Player.js`, `physics.js`, `raycast.js`, `Inventory.js`; `dev/controls.html`. `physics`+`raycast` covered by test suites | `feat/voxel-sandbox-game` |
| **Worlds / saves** | ✓ | Server-side persistence: REST create/list/get, `saves/<id>.json`, 2s debounced autosave, WS-validated edits, per-dim buckets. Backed by CI **persistence-test** + **authority-test** harness (#3) | game branch · persistence/authority proof on **#3** |
| **Graphics (three.js)** | ✓ | Vendored `public/vendor/three.*`; `public/graphics/src/*` (postprocessing/fog/particles) + `engine/*` (ChunkRenderer, AutoQuality, DirectionalCulling). `mesher`+`dircull` test suites | game branch · extra render modules on **#8 (#8 partial)** |
| **Audio** | ✓ | `public/src/audio/GameAudio.js` imported in `main.js`; `public/audio/*` present + **wired**. Engine headless-verified (`verify-audio.mjs`). *(Note: on standalone PR #1 it is built+verified but the wiring lives in the game branch.)* | game branch · engine on **#1** |
| **Tests** | ◐ | Game suite: **8 suites** via `npm test`, but **thin** (security=5, net=2, rest ~1 assertion). CI harness (#3) adds load/chaos/soak/authority/persistence + audio verify **but is absent from the game branch** → **no CI runs against the game today**. No in-branch browser e2e | game `tests/` · harness on **#3 (not integrated)** · e2e on **#12** |
| **Deploy** | ◐ | **Gap in game branch** (no `deploy/`/Dockerfile/`.github/`). **Exists + verified on #12**: Dockerfile, run script, smoke (`/api/health`+`/`+WS join), 2-client e2e 11/11 — but **#12 is draft & unmerged** | **#12** `feature/deploy` |

---

## Top blockers to a merged, playable, production-grade release

_The 3–6 things that most gate shipping (as of the latest audit):_

1. **The core game branch has no PR.** `feat/voxel-sandbox-game` @ `98c7ea9` is the real
   integration point but nothing formally opens it to `main`/`master`. **Promote the game
   branch (or merge #12) — this is the #1 gate.**
2. **All 11 PRs are DRAFT.** Nothing is mergeable until they're marked ready. The path that
   ships is: game branch → **#12 (deploy, already based on it)** → retarget **#3 (CI)**.
3. **CI does not run against the actual game.** #3's `ci.yml` + `scripts/` are absent from
   both the game branch and deploy. Retarget the workflow to game paths (`server/`,`public/`)
   so backend load/chaos/soak/authority/persistence + audio verify gate the real code.
4. **Deploy layer is unmerged.** #12 is the only shippable bundle (full game + Docker + smoke +
   2-client e2e 11/11) and it's still draft. Merging it is the shortest path to "playable."
5. **Texture packs are procedural-only.** Playable, but graphics-lab-v2 (#8) richer packs aren't
   wired in — production-grade visual bar not met until integrated or explicitly descoped.
6. **Test depth is thin.** 8 game suites average ~1 assertion each (security=5, net=2); no
   in-branch browser e2e. Coverage should deepen before calling QA "done."

_Non-blockers / descope candidates:_ **brand (#9)** and **ui-kit (#10)** are standalone and not
consumed by the game (which ships its own `public/src/ui/*`); **#1/#2/#5/#6/#8/#11** duplicate
content already vendored into the game and only need source reconciliation against master, not
integration.
