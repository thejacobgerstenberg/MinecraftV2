# scripts/

Dependency-free Node scripts that back the CI pipeline in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml). Both scripts run with
plain `node` — the repo has **no root `package.json`**, and nothing here creates
one (see [No root package.json](#no-root-packagejson)).

## CI: what runs and when

The workflow triggers on **push to `master`** and on **all pull requests**. It
defines three independent jobs, each of which **skips gracefully (stays green)**
when its target does not exist yet on the branch being built — so this repo is
green before the content, audio, and game branches land:

| Job | Needs | When target is missing | What it does |
|---|---|---|---|
| `content-validation` | `content/` directory | `echo "no content/ directory — skipping"` | `node scripts/validate-content.mjs` (no `setup-node`, no npm install — plain `node` on the runner is enough) |
| `audio-verification` | `audio/` directory | A `Check for audio/` step sets `present=false`; the install and verify steps are `if:`-gated off it | Installs `playwright` + Chromium into `$RUNNER_TEMP/pw` (outside the repo), then `PW_DIR="$RUNNER_TEMP/pw" node scripts/verify-audio.mjs` |
| `game-tests` | root `package.json` with a `test` script | `exit 0` with "no package.json — skipping" (or "no test script — skipping") | `npm ci` if `package-lock.json` exists, else `npm install`; then `npm test`. A real `npm test` failure fails the job — only a *missing* test script skips |

Timeouts: 5 min for `content-validation`, 15 min for the other two. The audio
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
- `verify-audio.mjs` uses Node builtins plus a Playwright resolved from an
  *external* directory (`PW_DIR` / `/tmp/pw`); CI installs it under
  `$RUNNER_TEMP/pw`, outside the checkout.
- The `game-tests` job only *consumes* a root `package.json` if another branch
  lands one — it never creates it, and skips cleanly until then.
