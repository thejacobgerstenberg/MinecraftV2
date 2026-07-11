# Loomfall — Content Integration Checklist (builder wiring guide)

Branch: `feature/content-integrate`. Target: `feat/voxel-sandbox-game` (the
builder). Loader contract: **`content-integrate/LOADER_API.md`** (frozen —
`ContentPack`, async `load()`, synchronous deep-frozen getters, never throw).

Every builder `file:line` below was verified against the excerpts of
`origin/feat/voxel-sandbox-game` materialized at
`…/scratchpad/ci-src/builder/src/` (underscored paths, e.g.
`public_src_main.js` = `public/src/main.js`). Re-verify any line with
`git show origin/feat/voxel-sandbox-game:<path>` before editing — the builder
branch may have moved.

Convention used in the edits below: `pack` is a page-lifetime
`ContentPack` instance created next to the other page-lifetime singletons in
`public/src/main.js` (beside `const audio = new GameAudio()` at
`public/src/main.js:262`):

```js
// public/src/main.js — page lifetime, beside audio/help/achievements
import { ContentPack } from './systems/contentpack.js'; // loader from feature/content-integrate
const pack = new ContentPack();          // baseUrl '/content', uxUrl '/ux'
const packReady = pack.load();           // idempotent; per-file failures degrade
```

`packReady` should join the existing `contentReady` barrier
(`public/src/main.js:271` — `Promise.all([loadNaming(), loadDeathMessages()])`,
awaited at `public/src/main.js:558`).

---

## 0. Refresh the content snapshot (DO THIS FIRST)

The builder's `public/content/` is an **early copy** of canon. Before any code
wiring, replace it with the latest `origin/feature/story-content:content/`
and add the ux data files from `origin/feature/ux-access:ux/`:

```sh
# from the builder worktree root
git checkout origin/feature/story-content -- content/    # if exported as content/
rsync -a --delete <canon>/content/ public/content/
mkdir -p public/ux
cp <ux>/captions.json <ux>/bindings.default.json <ux>/tutorial.json public/ux/
```

Identical already (no-op): `deathmessages.json`, `ending.md`, `lore.md`,
`onboarding.md`.

### Stale-ID / stale-data table (old → new → what breaks if stale)

| File | Old (builder `public/content/`) | New (canon) | Breaks if stale |
|---|---|---|---|
| `molthkin.json` | **missing entirely** | full 3-phase encounter (hp 280 dmg 11 spd 2, phases "The Long Shift" / "Feeding the Fire" / "The Last of the Thread") | `pack.boss('molthkin')` returns `null`; MobManager's simplified 2-phase molthkin (`public/mobs/MobManager.js:493`) can never be corrected; no molthkin arena data |
| `boss.json` | `summonRequirement: all_of[kill_count:selvage_warden:4 …]` | `all_of[seal_released:seal_measured, seal_released:seal_folded, seal_released:seal_pinned, seal_released:seal_sewn]`; NEW `gauntlet.structure:'selvage_outpost'`, `gauntlet.ordered:false`, `gauntlet.seals[4]`, `gauntlet.sealRules` (released seals permanent) | boss-summon gate checks a condition canon no longer defines; seal system (§5c) has no data |
| `structures.json` | 14 structures | 16 — ADDED `selvage_outpost` (category `nevermend_gauntlet`, unique set of four named posts, seal-holder wiring) and `deepest_spindle` (category `cinderloom_arena`); descriptions updated on `twice_ford`, `spoolmare_picket`, `spindlegate`, `eye_of_the_last_hem` | gauntlet outposts and the molthkin arena cannot generate (§6); `book(structureId)` placement misses new ids |
| `bestiary.json` | no `husbandry` fields; spoolmare is a horse silhouette | `skeinling.husbandry {breedable:true, breedingFood:'raw_skein'}`, `bobbin_deer.husbandry {breedable:true, breedingFood:'sennit_grain'}`, `spoolmare.husbandry {breedable:false, tameable:true, tameFood:'raw_skein', mountRequires:'saddle_frame'}`; spoolmare `visual.silhouette` rewritten to six-legged spool-strider | breeding/taming (§4b) has no data source; spoolmare mesh/blurbs contradict every other rewritten string below |
| `items.json` | 40 items | 41 — ADDED `sennit_grain` (tier-0 Sennmeadows grain, bobbin-deer feed); `saddle_frame.recipe.note` extended ("will not sit an unbonded mare") | bobbin-deer breeding food doesn't exist → `breed_entity:bobbin_deer` permanently unwireable |
| `dialogue.json` | actors: wickerkin, lastNeedle, tutorialNarrator | + `molthkin` actor `{phaseIntros, attackTelegraphs, onFelled}` | molthkin fight (§5b) has no lines; `pack.dialogue('molthkin', …)` → null |
| `achievements.json` | `stitch_ground_beneath_hooves` name "Ground Beneath Its Own Hooves" | "Ground Beneath Every Stride" (+ description rewritten for the spool-strider) | achievement toast (`public/src/systems/achievements.js:180`) and achievements screen show retconned name |
| `splashes.json` | "Spoolmares: horses, but stringier!" | "Spoolmares: mares in name only!" (155 both sides) | main-menu splash contradicts new spoolmare canon |
| `tips.json` | bond-a-spoolmare tip: "runs…herds" | "walks…slow swaying bands…wound spool carried high on six thread-legs" (61 both sides) | loading-screen tip contradicts canon |
| `naming.json` | `mobs.Spoolmares` horse description | loom-spun six-legged strider ("stitching ground beneath its own legs") | tooltips/bestiary text contradict canon |
| `books.json` | old text | text changed in `warning_the_water_that_was`, `hymn_the_drumming_song` (21 both sides) | in-world book text stale |
| `GAME_GUIDE.md` | controls table: Sneak "C or Left Ctrl", Sprint "Left Shift" | Sneak "Left Shift", Sprint "Left Ctrl" (matches `ux/bindings.default.json`); spoolmare sections rewritten | Help panel (`public/src/ui/help.js:13,167`) documents controls that contradict the rebound Controls.js (§7) |
| `boss.md` | old gauntlet paragraph | expanded with selvage_outpost / named-posts seal wiring | help/lore prose stale |

**Verify step 0:** `diff -r public/content <canon>/content` is empty;
`ls public/ux` shows `captions.json bindings.default.json tutorial.json`;
game boots, splash pool still 155 (`fetch('/content/splashes.json')` at
`public/src/ui/menu.js:77` still resolves).

**Revert step 0:** `git checkout HEAD~1 -- public/content public/ux` (snapshot
is pure data; no code references break by reverting it, only staleness
returns).

---

## 1. Achievements engine ↔ `getAchievements()`

**What wires up.** `public/src/systems/achievements.js` —
`initAchievements({ bus, audio, url, caps })` at
`public/src/systems/achievements.js:40` — currently `fetch()`es
`/content/achievements.json` itself inside `load()`
(`achievements.js:139-164`, fetch at `:143`). Replace that private fetch with
`pack.getAchievements()` so achievements and every other system read the SAME
loaded snapshot.

**Where.** `public/src/systems/achievements.js:40` (options) and
`:139-164` (`load()`); call site `public/src/main.js:283-298`.

**Edit (achievements.js).**

```js
// BEFORE (achievements.js:40)
export function initAchievements({ bus, audio, url = '/content/achievements.json', caps = {} } = {}) {

// AFTER — accept the shared pack; url stays as the no-pack fallback
export function initAchievements({ bus, audio, pack = null, url = '/content/achievements.json', caps = {} } = {}) {
```

```js
// BEFORE (achievements.js:141-146, inside load())
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
        const data = await res.json();
        defs = Array.isArray(data.achievements) ? data.achievements : [];

// AFTER — ContentPack when provided (getters are sync after load, deep-frozen,
// never throw); legacy fetch otherwise.
      try {
        let list;
        if (pack) {
          await pack.load();
          list = pack.getAchievements(); // [] before load / on failure
        } else {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
          list = (await res.json()).achievements;
        }
        defs = Array.isArray(list) ? list : [];
```

**Edit (main.js:283).** Add `pack,` to the `initAchievements({...})` options.
The `caps` block at `main.js:286-296` is unchanged — it already derives
killable/obtainable/placeable/enterable sets from `CANONICAL_ID`,
`CANON_BLOCK_ID`, `LOOT_TABLES`, `CREATIVE_BLOCKS`, `CANON_DIM`
(`main.js:115`).

**No trigger-grammar change needed.** `parseTrigger()`
(`achievements.js:96-137`) wires exactly `first_block_broken`,
`player_unpicked`, `survive_first_night`, `kill_entity:`, `enter_dimension:`,
`collect_count:`, `place_block:`, `place_count:` and returns `null` for
everything else (`:136`) — craft/tame/breed/seal/anchor/bind stay unwired by
design until those engines exist (§4b adds the breed/tame data). Bus listeners
at `achievements.js:231-266` (`block:broken`, `block:placed`,
`item:collected`, `mob:killed`, `boss:defeated`, `player:died`,
`dimension:entered`, `night:survived`) are unchanged; the emit sites in
main.js are `block:broken` `main.js:1149`, `item:collected` `:1048/:1152`,
`block:placed` `:1282`, `night:survived` `:1368`, `mob:killed` `:1042`,
`boss:defeated` `:1066`, `player:died` `:1096`, `dimension:entered` `:963`.

**Verify in-game.** Console: `LF.achievements.stats()` → `{ total: 60,
wired: <n> }` (the debug surface exposes achievements at `main.js:1982`).
Break one block → "Thread secured — achievement" toast for
`first_block_broken`. Open the achievements screen → the spool-strider
achievement reads "Ground Beneath Every Stride" (stale-table row 7).

**Revert.** Drop the `pack` option from both files — `url` fallback path is
byte-identical to today's behavior.

---

## 2. Death handler ↔ `deathMessage()`

**What wires up.** `public/src/systems/deathmessages.js` keeps its own
module-scope table (`loadDeathMessages` fetch at `deathmessages.js:17-39`,
`deathMessageFor` at `:46-50`). Delegate both to the pack; keep the exported
signatures so the call sites don't move: `main.js:271` (`contentReady`) and
`killPlayer(cause)` at `main.js:1090-1101` (`deathMessageFor` call at
`:1095`), plus `public/src/ui/deathscreen.js:11` `initDeathScreen({onRespawn})
→ { show(message), hide, isShowing }` which just renders the passed string.

**Edit (deathmessages.js) — whole-module delegation.**

```js
// BEFORE (deathmessages.js:17,46): private fetch + local table
export function loadDeathMessages(url = '/content/deathmessages.json') { /* fetch → table */ }
export function deathMessageFor(cause, playerName) {
  const pool = (table && table[cause]) || FALLBACK_MESSAGES;
  const msg = pool[Math.floor(Math.random() * pool.length)] || FALLBACK_MESSAGES[0];
  return msg.replace(/\{player\}/g, String(playerName || 'A Mender'));
}

// AFTER — thin adapter over ContentPack (same exports, same callers)
import { pack } from './contentpack.js'; // or setPack(pack) injection, builder's call

export function loadDeathMessages() { return pack.load(); }
export function deathMessageFor(cause, playerName) {
  return pack.deathMessage(cause, { player: playerName || 'A Mender' });
}
```

`pack.deathMessage` covers all 21 cause ids including `mob:<canonicalId>` and
falls back to canon-toned templated lines for unknown causes — the same
degradation the module implements today (`FALLBACK_MESSAGES`,
`deathmessages.js:9-12`).

**Causes actually produced today** (keep the list in a comment): only
`'void_unravel'` (kill-plane, `main.js:959`) and `` `mob:${detail.canonicalId}` ``
(`main.js:1054` explosion hit and `:1056` melee). `'fall'/'lava'/'drowning'`
etc. are defined in data but never emitted yet — wiring them is a
physics-damage task, not a content task.

**Verify in-game.** Fly below the kill plane → death screen shows a
`void_unravel` line with your player name templated in; let a waxling
detonate on you → a `mob:waxling` line. Chat also echoes the message
(`main.js:1097`).

**Revert.** Restore the fetch-based module (single file, no callers change).

---

## 3. Splash + loading tips ↔ `splash()` / `tip()`

**What wires up.** `public/src/ui/menu.js` has two module-scope fetches:
splashes into `splashPool` (`menu.js:75-86`, inline 22-line fallback
`SPLASHES` starting `menu.js:48`) and tips into `tipsPool` (`menu.js:88-99`),
random splash pick at `menu.js:265-273`, rotating loading tip
(`TIP_ROTATE_MS = 6000`, `menu.js:101`) via `showRandomTip`/`startTips`/
`stopTips` at `menu.js:551-580` driven from `setLoading` (`menu.js:577-588`).
Today the tip picker ignores the `system` category — `pack.tip(category?)`
adds the filter for free.

**Edit (menu.js).**

```js
// BEFORE (menu.js:76-86 / 89-99): two private fetches
const splashesReady = (typeof fetch === 'function' ? fetch('/content/splashes.json') … );
const tipsReady = (typeof fetch === 'function' ? fetch('/content/tips.json') … );

// AFTER — one pack, keep the same 'ready' promise names so nothing below moves
import { pack } from '../systems/contentpack.js';
const splashesReady = pack.load().then(() => null); // pool lives in the pack now
const tipsReady = splashesReady;
```

```js
// BEFORE (menu.js:267-273): pick from pool array
      const splashEl = el('div', 'menu-splash', titleWrap,
        SPLASHES[Math.floor(Math.random() * SPLASHES.length)]);
      splashesReady.then((pool) => {
        if (Array.isArray(pool) && pool.length > 0) {
          splashEl.textContent = pool[Math.floor(Math.random() * pool.length)];
        }
      });

// AFTER — pack.splash() already falls back to a canon-toned inline line
      const splashEl = el('div', 'menu-splash', titleWrap,
        SPLASHES[Math.floor(Math.random() * SPLASHES.length)]);
      splashesReady.then(() => { splashEl.textContent = pack.splash(); });
```

```js
// BEFORE (menu.js:551-553)
  function showRandomTip() {
    if (!tipsPool || tipsPool.length === 0) return;
    const tip = tipsPool[Math.floor(Math.random() * tipsPool.length)];

// AFTER — null only when tips.json failed to load
  function showRandomTip() {
    const tip = pack.tip(); // pack.tip('mounts') etc. to theme a screen
    if (!tip) return;
```

Keep the inline `SPLASHES` (`menu.js:48`) as the pre-load/offline text — it is
shown synchronously before `load()` settles.

**Verify in-game.** Reload the main menu a few times — splash rotates over
the 155-pool (eventually "Spoolmares: mares in name only!", stale-table
row 8). Start a world — loading tip rotates every 6 s, and the spoolmare tip
reads the "six thread-legs" text.

**Revert.** Restore the two fetches; `showRandomTip` reverts to `tipsPool`.

---

## 4. Mob registry ↔ `mobs()` / `bestiary()`

### 4a. Stats (drift guard, then override)

**Where the truth is duplicated.** `public/mobs/MobManager.js`
`ARCHETYPE_CONFIG` (`MobManager.js:209-521`) hardcodes every stat, with
per-entry `// canon: hpX dmgY spdZ` comments (grazer 8, trader 20, groaner 24,
exploder 10, screecher 12, bobbindeer 14, frayedhound 14, emberspinner 22,
unpicked 26, needlejack 18, scaldwarden 40 at `:331`, raveler 18, spoolmare 26
rideable at `:419`, silencemoth 4 at `:438`, selvagewarden 90
regenPerSec:2/regenDelay:5 at `:455-461`, lastneedle maxHp 800 at `:371-382`,
molthkin maxHp 280 at `:491-493`). It reads **no** content JSON. The engine ↔
canon id mapping is `CANONICAL_ID` / `canonicalIdFor(archetype)` at
`public/mobs/spawnRules.js:57` / `:82`.

**Minimal edit — overlay canon stats at spawn time**, not a config rewrite.
`spawn(archetype, pos)` is at `MobManager.js:695`; it resolves
`const config = ARCHETYPE_CONFIG[archetype] || {}` at `:698`. MobManager is
constructed in `main.js:716-726` with an options object — add a lookup there:

```js
// main.js:716 — BEFORE
  const mobs = new MobManager(scene, mobWorld, {
    getPlayerPos: () => ({ … }),
    getBlockDef,
    isDay: () => S.isDay,
    dimension: dim,
    onEvent: (name, detail) => onMobEvent(name, detail),
  });

// AFTER — inject canonical stats; MobManager stays content-agnostic
  const mobs = new MobManager(scene, mobWorld, {
    getPlayerPos: () => ({ … }),
    getBlockDef,
    isDay: () => S.isDay,
    dimension: dim,
    onEvent: (name, detail) => onMobEvent(name, detail),
    getCanonStats: (canonicalId) => pack.bestiary(canonicalId)?.stats ?? null,
  });
```

```js
// MobManager.js spawn(), after `const config = ARCHETYPE_CONFIG[archetype] || {}` (:698)
    const canon = this._opts.getCanonStats
      ? this._opts.getCanonStats(canonicalIdFor(archetype)) : null;
    // canon stats win where they exist; config keeps AI-only tuning fields
    const maxHp = canon?.hp ?? config.maxHp;
    // …use maxHp where config.maxHp was read; likewise canon.damage for
    // contactDamage/blastDamage and canon.speed for speed/seekSpeed.
```

(Adapt the exact field plumbing to how `spawn()` reads `config.maxHp` /
`config.contactDamage` / `config.speed` — keep `phase*`/`regen*`/`aiBase`
fields config-owned.) Until the overlay lands, add a **dev drift check**: on
boot, compare each `ARCHETYPE_CONFIG` entry's hp/dmg/spd against
`pack.bestiary(canonicalIdFor(a))?.stats` and `console.warn` mismatches — the
`// canon:` comments prove drift has already been hand-maintained 17 times.

### 4b. Husbandry (NEW data — flag, don't fake)

Latest bestiary adds `husbandry` to three mobs (stale-table row 4):
skeinling breed on `raw_skein`, bobbin_deer breed on `sennit_grain` (new item,
row 5), spoolmare tame on `raw_skein` + `saddle_frame` to mount
(`mountPlayer(mob)` already exists at `MobManager.js:860`, spoolmare
`rideable` config at `:419-421`; a `mobBreed` emit already exists at
`MobManager.js:1002`). No feeding/taming interaction exists in the builder
(no `interact` action — see §7), so this section is **data-ready, code-later**:
read all tunables from `pack.bestiary(id).husbandry` (breed radius 8, cooldown
1/day-cycle, crowd cap 8-in-24, spoolmare tame 15% base +10%/skein cap 75% —
all encoded in the `note` fields), and fire `breed_entity:<id>` /
`tame_entity:<id>` triggers so §1's parser can wire the matching achievements
when the capability sets grow.

### 4c. Spawn/drops

`SPAWN_TABLES` (`spawnRules.js:94`), `pickSpawn` (`:289`), `shouldDespawn`
(`:364`), `normalizeDimension` (`:241`) and `LOOT_TABLES`
(`public/mobs/lootTables.js`, imported at `main.js:49`) already agree with
bestiary `spawnRules`/`drops` per the builder's own comments; bosses and
selvagewarden are correctly absent from spawn tables. No edit — add them to
the same dev drift check as 4a.

**Verify in-game.** Console: `LF.mobs.spawn('grazer', pos)` (debug surface,
`main.js:1979-1980`) → its hp equals `pack.bestiary('skeinling').stats.hp`
(8). Drift check logs zero warnings after step 0.

**Revert.** Remove the `getCanonStats` option — `ARCHETYPE_CONFIG` values are
still fully populated and take back over.

---

## 5. Boss encounters ↔ `boss('last_needle')` / `boss('molthkin')` + seals

### 5a. Defeat line from dialogue.json (smallest win first)

`onMobEvent` `'bossDefeated'` branch hardcodes the chat line at
`main.js:1062-1065`:

```js
// BEFORE (main.js:1062-1065)
        ui.chat.addMessage({
          system: true,
          text: 'The Last Needle is bound. For a while, it will mend.',
        });

// AFTER — canon line per boss; hardcoded string becomes the fallback
        const actor = detail.canonicalId === 'molthkin' ? 'molthkin' : 'lastNeedle';
        const event = detail.canonicalId === 'molthkin' ? 'onFelled' : 'onBound';
        ui.chat.addMessage({
          system: true,
          text: pack.dialogueLine(actor, event)
            ?? 'The Last Needle is bound. For a while, it will mend.',
        });
```

(`bossDefeated` detail carries `canonicalId`/`achievement`/`victoryTrigger` —
emitted from `_killBoss` at `MobManager.js:2083`, config fields at
`MobManager.js:411-412`.)

### 5b. Phase intros + molthkin's third phase

Phase transitions are currently VFX-only inside
`_checkBossPhaseTransition` (`MobManager.js:1887-1896`) — no event reaches
`onMobEvent`. Minimal edit: emit one.

```js
// MobManager.js:1892, after `mob._lastBossPhase = cur;`
    this._emit('bossPhase', {
      canonicalId: canonicalIdFor(mob.archetype), phase: cur,
      position: { …mob.position },
    });
```

Then in `onMobEvent` (`main.js:1026`), add a `case 'bossPhase':` that prints
`pack.dialogue(actor, 'phaseIntros')` — pick the entry whose `phase` matches,
random line from its `lines[]` (shape per LOADER_API.md: `[{phase, name,
lines}]`). Same pattern later for `attackTelegraphs` keyed by `attackId` when
`_beginTelegraph` (`MobManager.js:1908`) learns attack ids.

Molthkin phase mismatch: builder models 2 phases (`phase1HpFrac 0.5`,
`bossPhase 0/1` per `MobManager.js:487`, `_aiMolthkin` at `:1659`); canon
`molthkin.json` has **3** phases with `hpRange`s. Update the molthkin
`ARCHETYPE_CONFIG` entry (`MobManager.js:493`) to the lastneedle-style
two-threshold model (`phase1HpFrac`/`phase2HpFrac` derived from
`pack.boss('molthkin').phases[*].hpRange`) and extend `_aiMolthkin`'s phase
derivation to 0/1/2 exactly as `_aiLastNeedle` does at `MobManager.js:1568-1572`.

### 5c. Gauntlet seals + summon gate (NEW mechanic — land as one unit with §6)

Canon `boss.json` `gauntlet` now reads: `structure:'selvage_outpost'`,
`ordered:false`, `seals: [seal_measured, seal_folded, seal_pinned,
seal_sewn]` — each bound to `kill_entity:selvage_warden` at its outpost's
spawn-tagged seal-holder — and `sealRules` (a released seal is **permanent**:
survives player death and full encounter reset). `summonRequirement` is now
`all_of[seal_released:<each of the four>]`, replacing
`kill_count:selvage_warden:4`.

There is no summon code to edit — `spawnBoss(pos)` (`MobManager.js:841`, thin
wrapper over `spawn('lastneedle', pos)`) is only reachable from the debug
surface (`main.js:1979`). New module (suggest
`public/src/systems/gauntlet.js`), all data from
`pack.boss('last_needle').gauntlet`:

1. On selvage_outpost generation (§6), tag each of the four posts with its
   seal id and spawn its warden (selvagewarden config `MobManager.js:461`,
   never in `SPAWN_TABLES` — spawn explicitly via `mobs.spawn('selvagewarden',
   pos)` and record `mob → sealId`).
2. On `mob:killed` with `canonicalId === 'selvage_warden'`, if the mob was a
   tagged seal-holder: mark the seal released, persist in the world save
   (permanent per `sealRules`), chat-announce.
3. When all four seals in `gauntlet.seals` are released
   (`ordered:false` — any order), drop the arena barrier and allow
   `spawnBoss` at the eye_of_the_last_hem arena.

**Verify in-game.** Debug-spawn molthkin, whittle hp: phase-intro lines
appear at the canon hpRange boundaries, three distinct phases; defeat →
`onFelled` line + `boss:defeated` on the bus. Release four seals via
console-spawned tagged wardens → summon gate opens; dying between seal 3 and 4
does not reset seals 1-3.

**Revert.** 5a/5b are two localized diffs (chat line, one `_emit`, molthkin
config numbers). 5c is a new module + its two call sites — delete them and
the old debug-only `spawnBoss` behavior is back.

---

## 6. Worldgen ↔ `structures()` + `book(structureId)` loot

**Current state (verified).** The live generator
`public/src/world/TerrainGenerator.js` (`class TerrainGenerator` at
`TerrainGenerator.js:89`, `generateChunk(cx, cz)` at `:165`, `BIOME_NAMES` at
`:82`) contains **zero** structure code — no match for
structure/hut/ruin anywhere in the file. The only structure placement in the
repo is the graphics-lab demo `public/graphics/src/worldgen.js`
(`generateTestWorld` at `worldgen.js:359`, "Pass 2: scattered structures" at
`:412`, `placeHut` at `:445`, hash-grid hut/ruin siting at `:520-522`).
`content/structures.json` has **zero consumers** today.

**Wiring plan** (new pass, ported from the demo's proven pattern):

1. Add a structure pass to `TerrainGenerator.generateChunk` (or a post-chunk
   decorator) using the demo's deterministic hash-grid cell technique
   (`worldgen.js:412+`): one candidate per N×N cell, seeded by
   `(seed, cellX, cellZ)`, flat-enough + above-waterline checks as in
   `placeHut`/`placeRuin` (`worldgen.js:445,486`).
2. Drive candidates from `pack.structures()` filtered by the generator's
   dimension (`new TerrainGenerator(seed, dim)`): `footprint{x,y,z}` sizes
   the pad, `blockPalette[]` maps to engine blocks via
   `canonBlockIdFor`-inverse (see `CANON_BLOCK_ID`,
   `public/src/systems/naming.js:25`), `rarity`/`spawnRules` weight the cell
   roll. `category:'nevermend_gauntlet'` (`selvage_outpost`) and
   `'cinderloom_arena'` (`deepest_spindle`) are **unique-set placements**, not
   hash-grid scatter — site them once per world from the world seed and hand
   the four outpost positions to §5c.
3. **Book loot:** when a structure completes, roll `pack.book(structureId)` —
   non-null means this structure id appears in some book's `placement[]`
   (21 books). Place the book as chest/lectern loot at a palette-tagged loot
   block; store `{bookId}` in block metadata. A read-a-book UI can reuse
   `renderMarkdown` from the help panel (`public/src/ui/help.js:35`).

**Verify in-game.** New world: structures appear, deterministic per seed
(same seed twice → same sites); `pack.book('unpicked_manor')` structures
contain a readable book; four named selvage outposts exist in nevermend and
report their seal ids to §5c.

**Revert.** The pass is additive and seed-isolated — gate it behind a
`STRUCTURES_ENABLED` flag in TerrainGenerator so revert = flag off (old worlds
regenerate identically with the flag off; note that flipping the flag changes
worldgen for existing seeds, so land it before any save-compat promise).

---

## 7. Input ↔ `bindings()` (includes the sneak/sprint conflict fix)

**Current state (verified).** `public/src/gameplay/Controls.js`
(`class Controls` at `Controls.js:47`) hardcodes `e.code` switches in
`_handleKeyDown` (`:171-215`) / `_handleKeyUp` (`:217-235`); emits
`EVENT_NAMES` (`:42`) `['break','breakStart','breakEnd','place','selectSlot',
'scroll','toggleInventory','togglePause','toggleFlight','toggleDebug',
'openChat']`. No rebinding layer, no `interact`, no `eat`, no gamepad.

**KEY CONFLICT (must fix, and must land with step 0's GAME_GUIDE):** builder
has sprint=`ShiftLeft` (`:178-181`), sneak=`KeyC`/`ControlLeft` (`:182-186`);
`ux/bindings.default.json` and the FIXED canon GAME_GUIDE controls table say
**sneak=`ShiftLeft`, sprint=`ControlLeft`** (verified in
`ux/bindings.default.json`: sneak `{primary:'ShiftLeft'}`, sprint
`{primary:'ControlLeft'}`).

**Minimal edit — table-driven codes instead of literals.** Keep the switch
shape; hoist the codes:

```js
// BEFORE (Controls.js:171-186)
    switch (e.code) {
      case 'KeyW': this.input.forward = true; return;
      …
      case 'ShiftLeft':
        this._shiftDown = true;        // sprint (+descend in flight)
        this._refreshSneakFlags();
        return;
      case 'KeyC':
      case 'ControlLeft':
        this._sneakKeys.add(e.code);   // sneak
        this._refreshSneakFlags();
        return;

// AFTER — resolve action from pack.bindings() (falls back to canon defaults);
// note the roles SWAP to match canon: Shift sneaks, Ctrl sprints.
    const action = this._actionFor(e.code); // primary/secondary lookup over pack.bindings()
    switch (action) {
      case 'moveForward': this.input.forward = true; return;
      …
      case 'sprint':
        this._sprintKeys.add(e.code);
        this._refreshSneakFlags();
        return;
      case 'sneak':
        this._sneakKeys.add(e.code);
        this._refreshSneakFlags();
        return;
```

`_actionFor` is a `Map<code, action>` built once from `pack.bindings()`
(27 actions; `binding(action) → {primary, secondary, gamepad}`), rebuilt if a
future options screen writes user overrides. Mirror the same lookup in
`_handleKeyUp` (`:217-235`) and update the `_refreshSneakFlags` doc comment
(`:237-239`) plus the header comment (`:16-18`). Map ux action names onto the
existing emits: `hotbar1..9 → selectSlot(0..8)` (`:209-211`),
`inventory → toggleInventory` (`:201`), `chat → openChat` (`:202`),
`debug → toggleDebug` (`:203`), `pause → togglePause`, `toggleFlight`
stays on double-tap jump (`:190-198`).

**Unwired actions:** `interact` (`Mouse2`/`KeyF`) and `eat` (`Mouse2`) have no
gameplay yet — `Mouse2` currently emits `place`. Reserve `KeyF` → `interact`
now (needed for §4b feeding/taming); leave `eat` unbound until hunger exists.

**Verify in-game.** Hold `ShiftLeft` → player sneaks (slow + edge-guard);
hold `ControlLeft` → sprint. Open Help → GAME_GUIDE controls table matches
(step 0 row 12). All 11 existing `EVENT_NAMES` still fire (break/place/
hotbar/inventory/chat/debug/pause/flight).

**Revert.** `_actionFor` falls back to a frozen copy of today's hardcoded
map when `pack.bindings()` is empty — revert = delete the lookup and restore
the literal cases (one file).

---

## 8. Audio captions ↔ `caption(soundKey)` + `lf-audio-event`

**Tap point (verified).** Every sound in the game funnels through
`GameAudio.play(name, opts)` — `public/src/audio/GameAudio.js:161-167`
(increments `state.plays`/`state.lastSound`, then `engine.play`). All helpers
route through it: `ui()/hurt()/levelup()/achievement()/splash()/portal()`
(`GameAudio.js:178-183`), `blockBreak`/`blockPlace` via `materialForBlock`
(`:185-193`), mob voices via `onMobEvent` (`main.js:1032,1035`). Engine:
`public/audio/engine.js` `play(name, opts)` at `engine.js:149`.

**Edit (GameAudio.js:161) — emit the hook, resolve captions outside.**

```js
// BEFORE (GameAudio.js:161-167)
  play(name, opts) {
    this.state.plays++;
    this.state.lastSound = name;
    const h = this._safe(() => this.engine.play(name, opts));
    this._refreshCtxState();
    return h;
  }

// AFTER — one DOM event per play; zero behavior change when nobody listens
  play(name, opts) {
    this.state.plays++;
    this.state.lastSound = name;
    const h = this._safe(() => this.engine.play(name, opts));
    this._refreshCtxState();
    window.dispatchEvent(new CustomEvent('lf-audio-event', {
      detail: { sound: name, pos: opts?.pos ?? null },
    }));
    return h;
  }
```

**Caption overlay (new, small — suggest `public/src/ui/captions.js`).**
Listens for `lf-audio-event`, resolves `pack.caption(detail.sound)` (exact
match first, then `*` wildcard = exactly one dot-segment, most-literal-
segments wins), renders `captionText(sound, vars)` for `durationMs`, ordered
by `priority`, with a directional arrow when `directional` and `detail.pos`
is set (listener pose available via `setListener`, `GameAudio.js:170-174`).
Substitution vars: `{material}` from the key's material segment mapped
through `blockDisplayName` (`naming.js:122`); `{mob}` from
`SPECIES_BY_ARCHETYPE` (`spawnRules.js:32`).

**Coverage:** the engine registry (`public/audio/sfx/index.js`) defines 66
keys — `break/place/step × 11` materials, 10 environment/ui one-shots,
`mob.{grazer,groaner,exploder,screecher,trader}.{idle,hurt,death}`, and 8
extras (door/chest/eat/drink/levelup/achievement/explosion). `captions.json`
(43 entries) covers all 66 via exact + wildcard rules, and additionally
defines `boss.*.telegraph` / `boss.*.defeated` (+ per-boss
`boss.molthkin.*`/`boss.lastneedle.*`) keys the engine does **not** synthesize
yet — when §5b's telegraphs land, play a stinger under those names and the
captions light up with no data change.

**Verify in-game.** Enable captions, break threadstone → "<material> breaks"
caption; take a hit → hurt caption; walk near a grazer → directional
`mob.*.idle` caption. Confirm `LF.audio.state.lastSound` matches the caption
key shown.

**Revert.** Remove the `dispatchEvent` line (or don't mount the overlay —
the event is inert without a listener).

---

## Ordering + dependencies

Land in this order; each step is shippable alone unless bracketed together:

1. **Step 0 (snapshot refresh)** — prerequisite for everything; stale
   boss.json/structures.json will actively mis-wire §5/§6.
2. **§1 + §2 + §3** (achievements, death messages, splash/tips) — independent
   of each other; all only need `pack` in main.js. Lowest risk, do first.
3. **§7 input** — MUST land in the same PR as step 0's GAME_GUIDE.md refresh
   (the guide documents the swapped sneak/sprint; shipping either half alone
   means help contradicts the keys).
4. **§8 audio hook** — independent; the overlay needs `pack.caption` only.
5. **§4a stats overlay** — after step 0 (bestiary values), independent
   otherwise.
6. **§6 structures** — after step 0 (needs the 16-structure file). Book loot
   (§6.3) can trail.
7. **§5a/5b boss dialogue + molthkin phases** — after step 0
   (dialogue.molthkin, molthkin.json).
8. **§5c gauntlet seals** — LAST; depends on §6 (selvage_outpost placement)
   + §5 (boss data) + §4c (warden spawns) + save-format for seal persistence.
   §5c and §6's unique-set placement must land together.
9. **§4b husbandry** — gated on an `interact` action (§7) and a feeding UI;
   data is ready, no ordering pressure.

Shared prerequisite for 2-9: the `ContentPack` module itself plus the
`pack` singleton + `packReady` joined into `contentReady`
(`main.js:271`, awaited `main.js:558`).

## Rollback

- **Data:** `git checkout <prev> -- public/content public/ux` restores the old
  snapshot; every consumer degrades exactly as today (all fetch/`load()`
  failure paths verified above are warn-and-continue:
  `achievements.js:154-161`, `deathmessages.js:32-36`, `menu.js:86/99`,
  `help.js:167-168`, and `pack.load()` tolerates per-file failure by
  contract).
- **Code:** every section above is one file or one file + its main.js call
  site; each keeps the legacy path (`url` fetch in §1, fallback lines in §2,
  inline `SPLASHES` in §3, `ARCHETYPE_CONFIG` values in §4, hardcoded chat
  string in §5a, hardcoded key map fallback in §7, listener-less event in
  §8), so reverting any single section cannot strand another.
- **Worldgen (§6) is the only non-trivial revert:** the structure pass
  changes generation for a given seed. Keep it behind `STRUCTURES_ENABLED`
  until §5c ships, then freeze — after players keep worlds, revert only by
  flag, never by deleting the pass.
- **Full rollback:** revert the integration merge commit; the builder branch
  has no reverse dependency on `feature/content-integrate`.
