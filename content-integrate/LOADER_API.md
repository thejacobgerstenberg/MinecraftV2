# ContentPack — frozen loader API (feature/content-integrate)

Framework-free JS (node >= 18 + browser, zero deps). One class, one async
load, synchronous getters after load. All data comes verbatim from the latest
canon on `origin/feature/story-content` (`content/*`) and
`origin/feature/ux-access` (`ux/captions/captions.json`,
`ux/keybinds/bindings.default.json`, `ux/onboarding/tutorial.json`).
All returned objects/arrays are deep-frozen; getters never throw — unknown
ids return `null` (or `[]`/fallback strings where specified).

## Construction / load

```js
const pack = new ContentPack({
  baseUrl = '/content',      // dir serving the canon content JSON
  uxUrl   = '/ux',           // dir serving captions.json / bindings.default.json / tutorial.json
  fetchFn = globalThis.fetch // injectable for node/tests (e.g. fs-backed)
} = {});

await pack.load();
// Idempotent (returns the same promise on re-call). Fetches every file in
// parallel; a missing/invalid file is tolerated: its domain degrades to the
// documented fallback and the failure is recorded. Resolves to:
//   { ok: boolean, loaded: string[], failed: string[] }  // file basenames
pack.isLoaded();   // -> boolean (load() settled, even partially)
```

Files loaded: `achievements.json`, `bestiary.json`, `books.json`, `boss.json`,
`molthkin.json`, `deathmessages.json`, `dialogue.json`, `items.json`,
`naming.json`, `splashes.json`, `structures.json`, `tips.json` (from
`baseUrl`); `captions.json`, `bindings.default.json`, `tutorial.json` (from
`uxUrl`). The `.md` files (GAME_GUIDE, boss, lore, ending, onboarding) are
shipped alongside but not parsed by ContentPack (the help panel fetches
GAME_GUIDE.md itself, as today).

Optional `rng` option (`() => number` in [0,1), default `Math.random`) drives
`splash()` / `tip()` / `deathMessage()` / `book()` picks, for deterministic QA.

## Getters — exact signatures and return shapes

```js
getAchievements() -> Array<Achievement>            // 60 entries, file order; [] before load/on failure
// Achievement = { id, name, description, trigger, tree, tier, parent, hidden }
//   trigger grammar (unchanged from achievements.json): 'first_block_broken',
//   'kill_entity:<id>', 'player_unpicked', 'enter_dimension:<dim>',
//   'survive_first_night', 'collect_count:<itemId>:<n>', 'place_block:<canonId>',
//   'place_count:<canonId>:<n>', 'craft_item:<id>', 'tame_entity:<id>',
//   'breed_entity:<id>', 'seal_fray', 'set_anchor', 'bind_block', ...

splash() -> string
// Random pick from the 155-entry splashes.json pool; canon-toned inline
// fallback string when unloaded.

tip(category?) -> { id, system, text } | null
// Random tip; `category` filters on the `system` field. Valid systems (18):
// crafting, mining, lighting, anchoring, death, combat, hunger, building,
// binding, the-ravelling, dimensions, exploration, farming, mounts, trading,
// smelting, navigation, the-understitch. Unknown/omitted category -> random
// from all 61. null only when tips.json failed to load.

deathMessage(cause, ctx) -> string
// cause: one of the 21 deathmessages.json cause ids — 'fall','lava','drowning',
// 'explosion','starvation','fire','cinderloom_heat','void_unravel', or
// 'mob:<canonicalId>' for the 13 mob causes (needlejack, understruck,
// frayed_hound, silence_moth, emberspinner, waxling, scaldwarden, slagmoth,
// molthkin, unpicked, raveler, selvage_warden, last_needle).
// ctx: { player: string } — templated into '{player}' (default 'A Mender').
// Unknown cause / unloaded -> random canon-toned fallback line (still templated).

dialogue(actor, event) -> DeepFrozen<Array|Object> | null
// Raw node for dialogue.json[actor][event]; null when either key is missing.
//   actor 'wickerkin'        events: 'greeting'|'trade'|'farewell'|'hurt' -> string[]
//   actor 'lastNeedle'       events: 'phaseIntros' -> [{phase,name,lines:string[]}],
//                             'attackTelegraphs' -> [{attackId,lines:string[]}],
//                             'onBound' -> string[]
//   actor 'molthkin'         events: 'phaseIntros'|'attackTelegraphs' (same shapes),
//                             'onFelled' -> string[]
//   actor 'tutorialNarrator' event: beat index '0'..'21' (string or number)
//                             -> { event, line }
// Convenience: dialogueLine(actor, event) -> string|null — random line drawn
// from the node above when it is (or contains only) strings.

book(structureId) -> Book | null
// Random book whose `placement` array includes structureId; null if none.
books() -> Array<Book>                              // all 21, file order
// Book = { id, title, type, placement: string[], text }
//   type: 'journal_page' | 'letter' | 'hymn' | 'warning' | ... (as in data)

bestiary(id) -> MobEntry | null                     // canonical snake_case id
mobs() -> Array<MobEntry>                           // all 17, file order
// MobEntry = { id, name, dimension, role, core, audioArchetype, spawnRules,
//              behavior, stats: { hp, damage, speed }, drops,
//              husbandry?: { breedable, breedingFood, tameable, tameFood?,
//                            mountRequires?, note },   // on skeinling,
//                            // bobbin_deer, spoolmare (latest canon)
//              visual?: { palette: string[5], silhouette },
//              statsNote?, dropsNote? }              // bosses only
// ids: skeinling, bobbin_deer, spoolmare, wickerkin, needlejack, understruck,
// frayed_hound, silence_moth, emberspinner, waxling, scaldwarden, slagmoth,
// molthkin, unpicked, raveler, selvage_warden, last_needle

item(id) -> Item | null
items() -> Array<Item>                              // all 41 (incl. sennit_grain)
// Item = { id, displayName, tier, description,
//          recipe: { shape: Array(9)<string|null>, note?, source? } }
recipe(id) -> Item['recipe'] | null                 // === item(id)?.recipe ?? null

boss(id) -> BossEntry | null                        // id: 'last_needle' | 'molthkin'
// 'last_needle' -> boss.json .boss ; 'molthkin' -> molthkin.json .boss
// BossEntry = { id, name, epithet, dimension, biome, arena, gauntlet,
//               arenaFeatures, summonRequirement,
//               stats: { hp, defense, ... },        // hp 800 / hp 280
//               phases: Array<{ index, name, hpRange, description, attacks,
//                               mechanics, transition }>,  // 3 phases each
//               victoryCondition, onVictory, rewards }
// last_needle gauntlet includes { structure:'selvage_outpost', ordered:false,
//   seals: [seal_measured, seal_folded, seal_pinned, seal_sewn], sealRules }.

structures() -> Array<Structure>                    // all 16, file order
structure(id) -> Structure | null                   // convenience by id
// Structure = { id, name, category, dimension, footprint: {x,y,z},
//               blockPalette: string[], rarity, spawnRules, loreHook,
//               description }
// ids: unpicked_manor, tangle_spire, fallen_loomgate, twice_ford,
// meadow_beneath, unhemmed_stair, wickerkin_weft_hamlet, spoolmare_picket,
// menders_vigil_waystation, stitched_stead, scaldwatch_bastion, spindlegate,
// deepest_spindle, tallow_reliquary, selvage_outpost, eye_of_the_last_hem

caption(soundKey) -> Caption | null
// Caption = { sound, text, category: 'action'|'mob'|'alert'|'ambient'|'music',
//             priority: 1..10, durationMs, directional?: true }
// Resolution: exact `sound` match first; otherwise wildcard patterns where
// '*' matches exactly ONE dot-segment ('break.*' matches 'break.stone';
// 'mob.*.hurt' matches 'mob.grazer.hurt'; 'boss.*.telegraph' matches
// 'boss.molthkin.telegraph'; 'music.*' matches 'music.calm'). Among multiple
// wildcard hits the one with the most literal (non-*) segments wins; ties go
// to the later (more specific, per file convention) entry. null when nothing
// matches. Placeholders '{material}'/'{mob}' are returned verbatim — the
// caller substitutes (captionText(soundKey, vars) convenience does it:
// captionText('break.stone', { material: 'Threadstone' }) -> 'Threadstone breaks').

binding(action) -> { primary: string|null, secondary: string|null,
                     gamepad: number|null } | null
bindings() -> DeepFrozen<Record<action, Binding>>   // all 27 actions
// actions: moveForward, moveBack, moveLeft, moveRight, jump, sneak, sprint,
// break, place, interact, eat, hotbar1..hotbar9, hotbarPrev, hotbarNext,
// inventory, chat, pause, debug, toggleFlight
// NOTE (canon fix the builder must adopt): sneak = ShiftLeft, sprint =
// ControlLeft — the OPPOSITE of the builder's current Controls.js mapping;
// latest GAME_GUIDE.md agrees with bindings.default.json.

tutorial() -> { version: 1,
                beats: Array<{ id, narratorLine,
                               coachMark: { anchor: string|null, title, body,
                                            placement: 'center'|'top'|... },
                               gateEvent, skippable }> } | null
// 22 beats, order canonical; narratorLine verbatim from dialogue.json
// tutorialNarrator.
```

## Sound-key inventory the captions must cover (builder audio engine, 66 keys)

break/place/step × {stone, wood, dirt, grass, sand, glass, leaves, gravel,
snow, metal, wool} (33); splash, wind, cave, portal, ui.click, hurt, pop,
rain, thunder, thunder.distant; mob.{grazer,groaner,exploder,screecher,
trader}.{idle,hurt,death} (15); door.open, door.close, chest.open, eat,
drink, levelup, achievement, explosion.
Every one of the 66 resolves through caption() via the exact + wildcard rules
above (mob.* families via 'mob.*.idle/hurt/death'; boss.* keys are defined in
captions.json for future boss stingers even though the engine registry does
not synthesize them yet).
