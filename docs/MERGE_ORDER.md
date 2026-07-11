# Loomfall (MinecraftV2) — Merge Order Playbook

Recon basis: `scratchpad/release-recon.md` (recon date 2026-07-11).
Integration target: **`origin/feat/voxel-sandbox-game`** HEAD `98c7ea9` (the core game — the base everything integrates against).
Publish targets: `origin/master` (`81e81e9`) / `origin/main` (`5903850`).

> **Read this first.** Recon §4 shows the game branch already **bundles by copy** audio, story-content, mobs, weather, graphics render-src, and peer-avatars under `public/` — and `main.js` already imports them. The 11 standalone PRs target `master` and **duplicate** that content at divergent paths (`audio/` vs `public/audio/`, etc.). So this playbook has two lanes:
> - **Ship lane** — promote the game and its downstream deploy/CI. This is the release.
> - **Reconcile lane** — the standalone PRs to `master`. Merging them to master does **not** feed the game (§4 "Net"). Land them for their standalone value / provenance, or retarget-and-close.
>
> Pick the lane per PR using the tags below. Do not assume merging a feature PR to master changes the shipped game.

---

## 1. Recommended SEQUENCE

Numbered, with rationale. Adjusted to what recon actually shows (the game branch has **no open PR** — §2, §6 — so step 1 is a branch promotion, not a PR merge).

1. **Promote the core game `feat/voxel-sandbox-game` → `master`.**
   It is the base everything integrates against and already carries the real integration of audio/content/mobs/weather/graphics-src/peer-avatars (§4). Nothing formally opens it today (§6 "Gaps": *"Core game branch has no PR"*), so this is the gating action for the whole release. It **owns** root `package.json`, `package-lock.json`, `.gitignore`, `CONTRACT.md`, and the real `docs/` (§3) — landing it first establishes those files so later `master`-based PRs conflict against a real tree instead of an empty one.

2. **Land `feature/ci` (#3) early-ish — right after the game.**
   Rationale: its CI matrix should be in place to **gate** every subsequent merge, but it is **harmless until targets land** — every job feature-detects its target and skips when absent (recon RULES: *"every job feature-detects its target and skips when absent"*; §5 jobs are conditional). Merging it now means later merges run against `content-validation`, `game-tests`, `backend-load`, `authority-audit`, `persistence`, `soak`. Caveat in §6: the CI workflow currently retargets/assumes game paths — land it, then confirm `.github/workflows/ci.yml` sees `server/index.js`, `/api/health`, `tests/` now present from step 1. Touches `.github/workflows/` (sole owner — no conflict there) and `docs/` + `scripts/` (§3).

3. **Docs-only / low-risk PRs — `design/parity-spec` (#4), `feature/brand` (#9), `feature/story-content` (#2).**
   These rarely conflict (§3: brand + content are isolated dirs; parity-spec is `docs/*.md` DOCS-ONLY). Land them before feature code so the design/QA spec (#4) and content are on `master` as reference for the code reviews that follow. **Only real conflict watch here is #4 vs the `docs/` tree** created by steps 1–2 (§3 conflict hot-spot: `docs/` shared by ci + parity-spec + deploy + game).

4. **Feature code — `feature/audio-engine` (#1), `feature/graphics-lab-v2` (#8), `feature/mobs` (#6), `feature/weather` (#5), `feature/avatars` (#11), `feature/ui-kit` (#10).**
   All isolated top-level dirs (§3) → low mutual conflict, but each is CODE and must go **green through the step-2 CI matrix** before merge. Order within the group is flexible; suggested: audio → graphics → mobs → weather (matches the task's audio/graphics/mobs/weather grouping) → avatars → ui-kit. Note #8 **supersedes** the v1 `graphics-lab` branch (§2, §3) — merge #8, do not merge v1. Reconcile-lane reminder: these duplicate content already vendored into the game (§4), so treat as standalone-package publishes, not game changes.

5. **Deploy LAST — `feature/deploy` (#12).**
   It is based **ON** the game branch, not master (§2 base = `feat/voxel-sandbox-game`; §4: game branch IS ancestor of deploy, exit=0). It carries the full game `public/`+`server/` (125 files) plus the deploy layer, and its `deploy/smoke.mjs` / `deploy/e2e-multiplayer.mjs` assume the hardened server (§5). Land it after the game is on master so the deploy layer sits on top of the shipped trunk. It is *"the closest thing to a shippable bundle"* (§4) — this is the release bundle.

**One-line spine (from §6):** game trunk → deploy (#12, already based on it) → CI retargeted to game paths → treat #1/#2/#5/#6/#8/#11 as already-copied source reconciliation → brand/ui-kit optional.

---

## 2. Per-PR CONFLICT-RISK

Shared-file collisions are the only real merge conflicts here; most feature branches are isolated top-level dirs (§3).

### Conflict hot-spots (from §3)
- **root `package.json` / `package-lock.json` / `.gitignore`** — owned by the **game branch only**. Feature branches target `master` (which lacks them), so on a **master-first** world they don't collide; after step 1 lands them, `feature/deploy` (#12) also touches root `.gitignore` + `CONTRACT.md` → **watch #12 vs game**.
- **`docs/`** — shared by **ci (#3) + parity-spec (#4) + deploy (#12) + game** (§3). Highest-fan-out conflict path. Sequence steps 1→2→3→5 deliberately spread these so each lands against a settled `docs/` tree.
- **`.github/workflows/`** — **only `feature/ci` (#3)** touches it (§3). No competitor → no conflict.

### Per-PR table

| PR | Branch | Isolated dir? | Shared/conflict paths | Conflict risk |
|----|--------|--------------|-----------------------|---------------|
| #1 | audio-engine | `audio/` yes | none | **SAFE** (isolated, no deps — §3) |
| #2 | story-content | `content/` yes | none | **SAFE** (isolated, JSON+md — §3) |
| #3 | ci | no | `.github/workflows/`, `scripts/`, `docs/SECURITY_FINDINGS.md`, `docs/metrics.md` | **MEDIUM** — `docs/` overlap w/ #4/#12/game; sole owner of `.github/` (§3) |
| #4 | design/parity-spec | no | `docs/*.md` (9) | **MEDIUM** — `docs/` overlap w/ #3/#12/game (§3) |
| #5 | weather | `weather/` yes | none | **SAFE** (isolated — §3) |
| #6 | mobs | `mobs/` yes | none | **SAFE** (isolated — §3) |
| #8 | graphics-lab-v2 | `graphics-lab/` yes | own `graphics-lab/package.json` (not root) | **SAFE** but **supersedes v1** — merge #8, skip v1 (§2/§3) |
| #9 | brand | `brand/` yes | none | **SAFE** (isolated svg/css/html/json — §3) |
| #10 | ui-kit | `ui-kit/` yes | none | **SAFE** (isolated css+js — §3) |
| #11 | avatars | `avatars/` yes | none | **SAFE** (isolated — §3) |
| #12 | deploy | no | **full game `public/`+`server/` (125 files)**, root `.gitignore`, `CONTRACT.md`, `docs/DEV.md`, `docs/PROTOCOL.md`, `docs/shots/*` | **HIGH vs master, LOW vs game** — merge into the game trunk (its base), not raw master; `docs/` + root `.gitignore` overlap (§3) |

**Docs/asset-only PRs that are safe to land in any order:** #2 (content), #4 (docs), #9 (brand assets) — plus the isolated-dir CODE PRs #1/#5/#6/#8/#10/#11 which don't share files but do need CI green.

---

## 3. DEPENDENCIES

Hard "must-precede" edges (from §2 bases, §4 ancestry, §5 test assumptions):

- **#12 deploy → REQUIRES the game trunk first.** Its base IS `feat/voxel-sandbox-game` (§2), and it is a descendant of game HEAD (§4, exit=0). Its `deploy/smoke.mjs` spawns `node server/index.js` and asserts `/api/health`, `/`, WS join→welcome (§5) — i.e. **assumes the hardened server**. Merge order: step 1 before step 5.
- **#3 ci `game-tests` / `backend-load` / `authority-audit` / `persistence` / `soak` → ASSUME the game server+tests.** These jobs run root `npm test` (`tests/run-all.mjs`), `load-test`/`chaos-test` against a spawned server, `authority-test` against `/ws`+`/api/health` (§5). They **skip when the target is absent** (RULES), so #3 can land before the game — but they only do useful work **after** step 1. The CI authority/e2e authority tests **assume the hardened server** (RULES: server on `feat/voxel-sandbox-game`, `/ws`, `/api/health`, `/api/worlds`).
- **audio wiring → the audio engine.** In the reconcile lane, #1 `feature/audio-engine` delivers the engine; the game's `main.js` audio wiring (`public/src/audio/GameAudio.js` import — §4/§6) assumes that engine. In the game trunk this is already satisfied by copy (§4 "INTEGRATED + wired"); as standalone PRs, #1 is the source of truth the wiring depends on.
- **CI `verify-audio` (playwright) → a Chromium binary.** Uses `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, reusing `/tmp/pw` playwright-core, **no playwright install** (RULES). Ensure that path exists on the runner before relying on `audio-verification` output; otherwise the job should skip, not fail.
- **e2e multiplayer (`deploy/e2e-multiplayer.mjs`, §5) → the hardened server + a second client.** Runs only in the deploy lane (#12) on top of the game trunk.
- **#8 graphics-lab-v2 supersedes v1.** Not a build dependency, but an exclusivity edge: do **not** merge the v1 `graphics-lab` branch (no open PR anyway — §2). #8 is the v1 superset (§3).

**No dependency (fully parallel once CI is up):** #2, #4, #5, #6, #9, #10, #11 — isolated dirs, no shared files, no runtime coupling to each other (§3).

---

## 4. Per-PR TAG + merge-readiness

Every open PR is **DRAFT** (§2, §6: *"All 11 PRs are draft"*) → each needs un-drafting + review before merge. Readiness notes below.

| PR | Tag | Readiness note |
|----|-----|----------------|
| **game** `feat/voxel-sandbox-game` | **CODE** (the game) | **No PR exists (§6).** Open one to `master` (or promote branch). Verified surface: `npm test` = 8 suites but **thin coverage** (security=5, net=2, rest ~1 assertion — §5); no browser e2e in-branch (§6). Merge-ready as trunk; test depth is a known risk, not a blocker. |
| #1 audio-engine | **CODE** (client JS, no deps — §3) | DRAFT. Isolated `audio/`. Reconcile-lane: duplicates `public/audio/*` already in game (§4). Ready standalone; no rebase needed (isolated). |
| #2 story-content | **CONTENT / ASSET** (JSON+md — §3) | DRAFT. Isolated `content/`. Duplicates `public/content/*` (§4). Low-risk; ready. |
| #3 ci | **CODE** (test harness — §3) | DRAFT. Jobs skip when targets absent (RULES) → harmless to land early. **Needs confirm** that `ci.yml` retargets game paths (§6: *"CI workflow absent from game branch"*) after step 1. Owns `.github/workflows/` (no conflict). |
| #4 design/parity-spec | **DOCS-ONLY** (§3) | DRAFT. `docs/*.md` (9). **Needs rebase check vs `docs/`** created by game+ci+deploy (§3 hot-spot). Otherwise ready — rarely conflicts. |
| #5 weather | **CODE + ASSET** (effects JS + vendored three — §3) | DRAFT. Isolated `weather/`. Duplicates `public/weather/*` + wired in game (§4). Ready standalone. |
| #6 mobs | **CODE + ASSET** (JS + screenshot pngs — §3) | DRAFT. Isolated `mobs/`. Duplicates `public/mobs/*` + wired in game (§4). Ready standalone. |
| #8 graphics-lab-v2 | **CODE + ASSET** (modules + packs + 25 pngs — §3) | DRAFT. **Supersedes v1** (§2/§3) — merge this, skip v1. Own `graphics-lab/package.json` (not root). Game only integrates render-src, not the lab (§4 PARTIAL) → this PR is the lab's home. Ready. |
| #9 brand | **ASSET / DOCS** (svg/css/html/json — §3) | DRAFT. Isolated `brand/`. **NOT STARTED in game** (§4) — genuinely additive, no duplication. Ready; low-risk. |
| #10 ui-kit | **CODE** (css+js — §3) | DRAFT. Isolated `ui-kit/`. Game ships its own `public/src/ui/*` (§4 NOT STARTED / §6) → ui-kit is **not consumed**. Optional (§6 spine: *"brand/ui-kit optional"*). Ready standalone. |
| #11 avatars | **CODE + ASSET** (§3) | DRAFT. Isolated `avatars/`. Game has only the MP drop-in `PeerAvatars.js` (§4 PARTIAL); full pkg absent → additive. Ready standalone. |
| #12 deploy | **CODE + DOCS** (§3) | DRAFT. **Based on game trunk** (§2) → merge after step 1, into/onto the game, not raw master. Carries 125 game files + deploy layer; smoke + e2e assume hardened server (§5). Closest to shippable bundle (§4). Needs game-first, then ready. |

Tag legend: **DOCS-ONLY** = #4. **CONTENT/ASSET-leaning** = #2, #9. **CODE** = game, #1, #3, #5, #6, #8, #10, #11, #12.

---

## 5. Note on `feature/ci`'s matrix (why it lands early but is safe)

Merge `feature/ci` (#3) **early-ish** (step 2, right after the game) so its CI matrix **gates** every subsequent merge — content, feature-code, and deploy PRs then run against `content-validation`, `audio-verification`, `game-tests`, `backend-load`, `authority-audit`, `persistence`, `soak` (§5 jobs).

It is **harmless until targets land** because **every job feature-detects its target and skips when absent** (recon RULES: *"Everything must stay GREEN standalone on feature/ci (every job feature-detects its target and skips when absent)"*; §5 lists the game-tests as *conditional* root `npm test`). Concretely:
- Before the game is on the base, `game-tests` / `backend-load` / `authority-audit` / `persistence` / `soak` find no `server/index.js` or `tests/` → **skip green**, not fail.
- `audio-verification` (playwright) skips if the Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` or `public/audio/*` is absent.
- `content-validation` skips absent `content/`.

So #3 introduces the gate with **zero risk of red on an empty tree**, and the jobs "wake up" automatically as steps 1, 3, 4, 5 land their targets. One post-merge check (§6 gap): confirm `ci.yml` paths point at the **game's** `server/`, `tests/`, `/api/health`, `/ws` (RULES) once the game is on master — today CI is *absent from the game branch and from deploy*, so no CI runs against the actual game until this retarget is verified.

---

## 6. TL;DR merge order

1. Promote **game** `feat/voxel-sandbox-game` → master (open its missing PR). *(base for everything — §6)*
2. **#3 ci** — gate on, jobs skip-green until targets land *(RULES / §5)*.
3. Docs/low-risk: **#4** parity-spec (rebase vs `docs/`), **#9** brand, **#2** content.
4. Feature code through CI green: **#1** audio, **#8** graphics-v2 (skip v1), **#6** mobs, **#5** weather, **#11** avatars, **#10** ui-kit *(optional)*.
5. **#12 deploy** last — sits on the game trunk, ships the bundle *(§2/§4/§5)*.

Reconcile-lane caveat (§4): steps 3–4 land standalone packages to master that the game **already vendors by copy**; they do not change the shipped game. The release is the **game trunk + #12**.
