#!/usr/bin/env node
/**
 * proof.mjs — end-to-end resolve/coverage proof for the Loomfall ContentPack.
 *
 * Loads the canon content + ux pack through ./loader.js (the frozen API in
 * LOADER_API.md), then asserts that every cross-file reference resolves
 * through pack getters, exercising each getter with the SAME argument shapes
 * the builder's real code uses (per the excerpts in
 * scratchpad/ci-src/builder/src/). Real content gaps are recorded as report
 * findings — the script itself must always run clean.
 *
 * Usage:
 *   node proof.mjs [--content-dir <dir>] [--ux-dir <dir>] [--builder-snapshot <dir>]
 *
 * Output: console coverage table + coverage.json next to this script.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import ContentPack from './loader.js';

// ---------------------------------------------------------------------------
// CLI / paths
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH =
  '/tmp/claude-0/-home-user-MinecraftV2/97d2c063-abec-5582-8174-3e66bef1d68c/scratchpad/ci-src';

function argValue(flag, fallback) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(flag + '='));
  return eq ? eq.slice(flag.length + 1) : fallback;
}

const CONTENT_DIR = argValue('--content-dir', path.join(SCRATCH, 'canon'));
const UX_DIR = argValue('--ux-dir', path.join(SCRATCH, 'ux'));
const SNAPSHOT_DIR = argValue(
  '--builder-snapshot',
  path.join(SCRATCH, 'builder', 'content-snapshot')
);

// Deterministic rng so repeated proof runs are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Builder-side constants (verbatim from the read-only builder excerpts;
// these define the *consumer* argument shapes and capability sets)
// ---------------------------------------------------------------------------

/** public/mobs/spawnRules.js — archetype -> canonical snake_case id. */
const CANONICAL_ID = {
  grazer: 'skeinling',
  bobbindeer: 'bobbin_deer',
  trader: 'wickerkin',
  groaner: 'understruck',
  frayedhound: 'frayed_hound',
  emberspinner: 'emberspinner',
  exploder: 'waxling',
  screecher: 'slagmoth',
  unpicked: 'unpicked',
  lastneedle: 'last_needle',
  needlejack: 'needlejack',
  scaldwarden: 'scaldwarden',
  raveler: 'raveler',
  spoolmare: 'spoolmare',
  silencemoth: 'silence_moth',
  selvagewarden: 'selvage_warden',
  molthkin: 'molthkin',
};

/** public/src/systems/naming.js — engine block -> canon block id. */
const CANON_BLOCK_ID_VALUES = [
  'warpsod', 'loamweft', 'threadstone', 'thrumwood_bole', 'knotwood_plank',
  'loomglass', 'needle_iron', 'giltspool', 'dawnthread', 'cinderthread',
  'tallowstone', 'mothdust_brick', 'cinderglass', 'hemstone', 'voidknot',
  'frostlace',
];

/** public/src/main.js L115 — CANON_DIM values. */
const CANON_DIM_VALUES = ['warpwold', 'cinderloom', 'nevermend'];

/** public/mobs/MobManager.js ARCHETYPE_CONFIG — hardcoded maxHp per archetype
 *  (each entry carries a '// canon: hpX ...' comment; this is the duplication
 *  the pack is meant to replace). */
const BUILDER_MAX_HP = {
  grazer: 8, trader: 20, groaner: 24, exploder: 10, screecher: 12,
  bobbindeer: 14, frayedhound: 14, emberspinner: 22, unpicked: 26,
  needlejack: 18, scaldwarden: 40, raveler: 18, lastneedle: 800,
  spoolmare: 26, silencemoth: 4, selvagewarden: 90, molthkin: 280,
};

/** Builder input surface (public/src/gameplay/Controls.js hardcoded e.code
 *  switch + input flags) mapped onto the ux bindings action vocabulary,
 *  with the builder's current hardcoded keys for conflict reporting. */
const BUILDER_INPUT = [
  { builder: 'forward (KeyW flag)',        action: 'moveForward', keys: ['KeyW'] },
  { builder: 'back (KeyS flag)',           action: 'moveBack',    keys: ['KeyS'] },
  { builder: 'left (KeyA flag)',           action: 'moveLeft',    keys: ['KeyA'] },
  { builder: 'right (KeyD flag)',          action: 'moveRight',   keys: ['KeyD'] },
  { builder: 'jump (Space)',               action: 'jump',        keys: ['Space'] },
  { builder: 'sprint (ShiftLeft)',         action: 'sprint',      keys: ['ShiftLeft'] },
  { builder: 'sneak (KeyC|ControlLeft)',   action: 'sneak',       keys: ['KeyC', 'ControlLeft'] },
  { builder: "'break'/'breakStart'/'breakEnd' (Mouse0)", action: 'break', keys: ['Mouse0'] },
  { builder: "'place' (Mouse2)",           action: 'place',       keys: ['Mouse2'] },
  { builder: "'selectSlot' 0 (Digit1)",    action: 'hotbar1',     keys: ['Digit1'] },
  { builder: "'selectSlot' 1 (Digit2)",    action: 'hotbar2',     keys: ['Digit2'] },
  { builder: "'selectSlot' 2 (Digit3)",    action: 'hotbar3',     keys: ['Digit3'] },
  { builder: "'selectSlot' 3 (Digit4)",    action: 'hotbar4',     keys: ['Digit4'] },
  { builder: "'selectSlot' 4 (Digit5)",    action: 'hotbar5',     keys: ['Digit5'] },
  { builder: "'selectSlot' 5 (Digit6)",    action: 'hotbar6',     keys: ['Digit6'] },
  { builder: "'selectSlot' 6 (Digit7)",    action: 'hotbar7',     keys: ['Digit7'] },
  { builder: "'selectSlot' 7 (Digit8)",    action: 'hotbar8',     keys: ['Digit8'] },
  { builder: "'selectSlot' 8 (Digit9)",    action: 'hotbar9',     keys: ['Digit9'] },
  { builder: "'scroll' -1 (wheel up)",     action: 'hotbarPrev',  keys: [] },
  { builder: "'scroll' +1 (wheel down)",   action: 'hotbarNext',  keys: [] },
  { builder: "'toggleInventory' (KeyE)",   action: 'inventory',   keys: ['KeyE'] },
  { builder: "'openChat' (KeyT)",          action: 'chat',        keys: ['KeyT'] },
  { builder: "'togglePause' (Escape)",     action: 'pause',       keys: ['Escape'] },
  { builder: "'toggleDebug' (F3)",         action: 'debug',       keys: ['F3'] },
  { builder: "'toggleFlight' (double-tap Space)", action: 'toggleFlight', keys: [] },
];

/** The builder audio engine's full sound-key inventory (66 keys, enumerated
 *  from public/audio/sfx/index.js — see integration brief). Every key must
 *  resolve through pack.caption(). */
const MATERIALS = ['stone', 'wood', 'dirt', 'grass', 'sand', 'glass',
  'leaves', 'gravel', 'snow', 'metal', 'wool'];
const VOICED_FAMILIES = ['grazer', 'groaner', 'exploder', 'screecher', 'trader'];
const AUDIO_KEYS = [
  ...MATERIALS.map((m) => `break.${m}`),
  ...MATERIALS.map((m) => `place.${m}`),
  ...MATERIALS.map((m) => `step.${m}`),
  'splash', 'wind', 'cave', 'portal', 'ui.click', 'hurt', 'pop',
  'rain', 'thunder', 'thunder.distant',
  ...VOICED_FAMILIES.flatMap((f) => [`mob.${f}.idle`, `mob.${f}.hurt`, `mob.${f}.death`]),
  'door.open', 'door.close', 'chest.open', 'eat', 'drink',
  'levelup', 'achievement', 'explosion',
];

/** Extra caption keys the ux pack promises beyond the engine registry
 *  (boss stingers + music beds startMusic() can request). Informational. */
const EXTRA_CAPTION_KEYS = [
  'boss.molthkin.telegraph', 'boss.molthkin.defeated',
  'boss.lastneedle.telegraph', 'boss.lastneedle.defeated',
  'music.calm', 'music.nether', 'music.mysterious', 'music.upbeat',
  'music.melancholy',
];

/** tips.json system vocabulary (18) — menu.js requests tips uncategorized,
 *  but the loader API exposes category filtering; prove every system yields. */
const TIP_SYSTEMS = ['crafting', 'mining', 'lighting', 'anchoring', 'death',
  'combat', 'hunger', 'building', 'binding', 'the-ravelling', 'dimensions',
  'exploration', 'farming', 'mounts', 'trading', 'smelting', 'navigation',
  'the-understitch'];

// ---------------------------------------------------------------------------
// Stale-id list from the integration brief (builder content-snapshot vs canon)
// — verified programmatically against SNAPSHOT_DIR where it exists.
// ---------------------------------------------------------------------------

const STALE_IDS = [
  { file: 'molthkin.json', kind: 'missing-in-builder', id: 'molthkin encounter file (canon: 3 phases, own gauntlet, hp 280 dmg 11 spd 2; builder MobManager inlines a simplified 2-phase model)' },
  { file: 'achievements.json', kind: 'stale', id: "stitch_ground_beneath_hooves — name 'Ground Beneath Its Own Hooves' -> 'Ground Beneath Every Stride' + description rewrite" },
  { file: 'bestiary.json', kind: 'stale', id: 'skeinling — gained husbandry {breedable:true, breedingFood:raw_skein, tameable:false}' },
  { file: 'bestiary.json', kind: 'stale', id: 'bobbin_deer — gained husbandry {breedable:true, breedingFood:sennit_grain}' },
  { file: 'bestiary.json', kind: 'stale', id: 'spoolmare — gained husbandry {breedable:false, tameable:true, tameFood:raw_skein, mountRequires:saddle_frame} + visual.silhouette rewritten to six-legged spool-strider' },
  { file: 'items.json', kind: 'missing-in-builder', id: 'sennit_grain (tier 0 foraged grain, bobbin-deer breeding feed) — builder has 40/41 items' },
  { file: 'items.json', kind: 'stale', id: "saddle_frame — recipe.note extended ('the frame will not sit an unbonded mare')" },
  { file: 'boss.json', kind: 'stale', id: 'last_needle.gauntlet — NEW structure:selvage_outpost, ordered:false, seals [seal_measured, seal_folded, seal_pinned, seal_sewn], sealRules' },
  { file: 'boss.json', kind: 'stale', id: 'last_needle.summonRequirement — kill_count:selvage_warden:4 -> all_of[seal_released:seal_measured..seal_sewn]' },
  { file: 'structures.json', kind: 'missing-in-builder', id: 'selvage_outpost (nevermend_gauntlet unique_set of four named posts w/ seal-holder wiring)' },
  { file: 'structures.json', kind: 'missing-in-builder', id: 'deepest_spindle (molthkin arena)' },
  { file: 'structures.json', kind: 'stale', id: 'twice_ford / spoolmare_picket / spindlegate / eye_of_the_last_hem — descriptions updated' },
  { file: 'dialogue.json', kind: 'missing-in-builder', id: 'molthkin actor {phaseIntros, attackTelegraphs, onFelled}' },
  { file: 'splashes.json', kind: 'stale', id: "'Spoolmares: horses, but stringier!' -> 'Spoolmares: mares in name only!'" },
  { file: 'tips.json', kind: 'stale', id: 'bond-a-spoolmare tip text rewritten (six thread-legs strider flavor)' },
  { file: 'naming.json', kind: 'stale', id: 'mobs.Spoolmares description rewritten to loom-spun six-legged strider' },
  { file: 'books.json', kind: 'stale', id: 'warning_the_water_that_was — text changed' },
  { file: 'books.json', kind: 'stale', id: 'hymn_the_drumming_song — text changed' },
  { file: 'GAME_GUIDE.md', kind: 'stale', id: "spoolmare sections rewritten + controls table fixed (Sneak 'Left Shift', Sprint 'Left Ctrl')" },
  { file: 'boss.md', kind: 'stale', id: 'gauntlet paragraph expanded with selvage_outpost named-post seal wiring' },
  { file: '(builder code)', kind: 'stale-code', id: "main.js L1063 hardcodes 'The Last Needle is bound…' chat line instead of dialogue.json lastNeedle.onBound" },
  { file: '(builder code)', kind: 'stale-code', id: 'MobManager molthkin config: 2-phase (phase1HpFrac 0.5) vs canon molthkin.json 3 phases' },
];

// ---------------------------------------------------------------------------
// Check framework
// ---------------------------------------------------------------------------

/** @type {Map<string, {checked:number, resolved:number, unresolved:string[]}>} */
const systems = new Map();
const notes = [];

function check(system, id, ok, note) {
  if (!systems.has(system)) systems.set(system, { checked: 0, resolved: 0, unresolved: [] });
  const s = systems.get(system);
  s.checked += 1;
  if (ok) s.resolved += 1;
  else s.unresolved.push(note ? `${id} — ${note}` : id);
}

function info(text) {
  notes.push(text);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const pack = new ContentPack({
    baseUrl: CONTENT_DIR,
    uxUrl: UX_DIR,
    rng: mulberry32(0x100f4a11),
  });
  const loadResult = await pack.load();
  info(`pack.load() -> ok=${loadResult.ok} loaded=${loadResult.loaded.length} failed=[${loadResult.failed.join(', ')}]`);
  for (const name of ['achievements.json', 'bestiary.json', 'books.json', 'boss.json',
    'molthkin.json', 'deathmessages.json', 'dialogue.json', 'items.json', 'naming.json',
    'splashes.json', 'structures.json', 'tips.json', 'captions.json',
    'bindings.default.json', 'tutorial.json']) {
    check('pack-load', name, loadResult.loaded.includes(name), 'failed to load');
  }

  // Supplementary inventories the frozen API does not expose as getters:
  // the canon block/biome/dimension registry and the onboarding event list.
  const naming = JSON.parse(await fs.readFile(path.join(CONTENT_DIR, 'naming.json'), 'utf8'));
  const BLOCK_IDS = new Set(Object.values(naming.blocks).map((b) => b.id));
  const BIOME_IDS = new Set(naming.biomes.map((b) => b.id));
  const DIM_IDS = new Set(naming.dimensions.map((d) => String(d.name).toLowerCase()));
  const onboardingMd = await fs.readFile(path.join(CONTENT_DIR, 'onboarding.md'), 'utf8');
  const ONBOARDING_EVENTS = new Set(
    onboardingMd.match(/\b(?:on_[a-z0-9_]+|minute_10_wrapup)\b/g) || []
  );

  const mobs = pack.mobs();
  const items = pack.items();
  const structures = pack.structures();
  const achievements = pack.getAchievements();
  const MOB_IDS = new Set(mobs.map((m) => m.id));
  const ITEM_IDS = new Set(items.map((i) => i.id));
  const STRUCTURE_IDS = new Set(structures.map((s) => s.id));
  const STRUCTURE_VARIANT_IDS = new Set(
    structures.flatMap((s) => (Array.isArray(s.variants) ? s.variants.map((v) => v.id) : []))
  );
  const materialIds = new Set([...ITEM_IDS, ...BLOCK_IDS]); // collectable/craftable matter

  const lastNeedle = pack.boss('last_needle');
  const molthkin = pack.boss('molthkin');
  const choiceOptions =
    (lastNeedle?.onVictory || []).find((a) => a.action === 'present_choice')?.options || [];
  const CHOICE_IDS = new Set(choiceOptions.map((o) => o.id));
  const ACHIEVEMENT_IDS = new Set(achievements.map((a) => a.id));
  const ACHIEVEMENT_TRIGGERS = new Set(achievements.map((a) => a.trigger));

  // =========================================================================
  // 1. ACHIEVEMENTS — every trigger's entity/item/dimension/biome/structure/
  //    choice reference resolves through pack getters (or the canon registry).
  // =========================================================================
  check('achievements', 'count==60', achievements.length === 60, `got ${achievements.length}`);
  const armorPieces = ['helm', 'mail', 'leggings', 'boots'];
  for (const a of achievements) {
    const t = String(a.trigger || '');
    const tag = `${a.id} [${t}]`;
    let m;
    if ((m = /^(kill_entity|tame_entity|trade_with):(.+)$/.exec(t))) {
      const mob = pack.bestiary(m[2]); // builder arg shape: canonical snake_case id
      let ok = mob != null;
      let why = 'not in bestiary';
      if (ok && m[1] === 'tame_entity' && !(mob.husbandry && mob.husbandry.tameable)) {
        ok = false; why = 'bestiary entry is not tameable';
      }
      check('achievements', tag, ok, why);
    } else if ((m = /^trade_count:([^:]+):\d+$/.exec(t))) {
      check('achievements', tag, pack.bestiary(m[1]) != null, 'not in bestiary');
    } else if ((m = /^(collect_count):([^:]+):\d+$/.exec(t))) {
      check('achievements', tag, ITEM_IDS.has(m[2]) || BLOCK_IDS.has(m[2]),
        'not an item or canon block');
    } else if ((m = /^(craft_item|smelt_with):(.+)$/.exec(t))) {
      check('achievements', tag, pack.item(m[2]) != null || BLOCK_IDS.has(m[2]),
        'not an item or canon block');
    } else if ((m = /^(place_block):(.+)$/.exec(t)) || (m = /^(place_count):([^:]+):\d+$/.exec(t))) {
      check('achievements', tag, BLOCK_IDS.has(m[2]), 'not a canon block id');
    } else if ((m = /^(enter_dimension|ride_spoolmare_in|visit_all_biomes):(.+)$/.exec(t))) {
      check('achievements', tag, DIM_IDS.has(m[2]), 'not a canon dimension');
    } else if ((m = /^enter_biome:(.+)$/.exec(t))) {
      check('achievements', tag, BIOME_IDS.has(m[1]), 'not a canon biome');
    } else if ((m = /^choice:(.+)$/.exec(t))) {
      check('achievements', tag, CHOICE_IDS.has(m[1]),
        'not an option id in boss.json onVictory present_choice');
    } else if ((m = /^craft_full_set:(.+)_armor$/.exec(t))) {
      const missing = armorPieces.filter((p) => pack.item(`${m[1]}_${p}`) == null);
      check('achievements', tag, missing.length === 0,
        `missing armor piece items: ${missing.join(', ')}`);
    } else if (/^(first_block_broken|player_unpicked|survive_first_night|set_anchor|hear_thrum|seal_fray|bind_block)$/.test(t)
      || /^(depth_reached:-?\d+|bind_count:\d+)$/.test(t)) {
      check('achievements', tag, true); // parameterless / numeric-only grammar
    } else {
      check('achievements', tag, false, 'unknown trigger grammar');
    }
  }

  // =========================================================================
  // 2. RECIPES — every non-null recipe shape cell resolves (item or block);
  //    recipe(id) agrees with item(id).recipe.
  // =========================================================================
  check('recipes', 'items count==41', items.length === 41, `got ${items.length}`);
  for (const it of items) {
    const r = pack.recipe(it.id); // builder-shape: by item id
    check('recipes', `recipe(${it.id})===item(${it.id}).recipe`,
      r === (it.recipe ?? null), 'getter disagreement');
    const shape = it.recipe && it.recipe.shape;
    if (Array.isArray(shape)) {
      check('recipes', `${it.id}.recipe.shape length==9`, shape.length === 9,
        `got ${shape.length}`);
      for (const cell of new Set(shape.filter(Boolean))) {
        check('recipes', `${it.id} <- ${cell}`, materialIds.has(cell),
          'cell resolves to neither item nor canon block');
      }
    }
  }

  // =========================================================================
  // 3. MOB DROPS + HUSBANDRY — every drop item and husbandry food/gear
  //    resolves; roster and boss stats sanity.
  // =========================================================================
  check('mob-drops', 'mobs count==17', mobs.length === 17, `got ${mobs.length}`);
  for (const mob of mobs) {
    for (const d of mob.drops || []) {
      check('mob-drops', `${mob.id} drops ${d.item}`, materialIds.has(d.item),
        'not an item or canon block');
    }
    const h = mob.husbandry;
    if (h) {
      if (h.breedingFood) {
        check('mob-drops', `${mob.id}.husbandry.breedingFood=${h.breedingFood}`,
          materialIds.has(h.breedingFood), 'unresolvable food id');
      }
      if (h.tameFood) {
        check('mob-drops', `${mob.id}.husbandry.tameFood=${h.tameFood}`,
          materialIds.has(h.tameFood), 'unresolvable food id');
      }
      if (h.mountRequires) {
        check('mob-drops', `${mob.id}.husbandry.mountRequires=${h.mountRequires}`,
          pack.item(h.mountRequires) != null, 'not an item');
      }
    }
  }

  // =========================================================================
  // 4. STRUCTURES — every blockPalette id resolves against the canon block
  //    registry; boss-referenced structures exist.
  // =========================================================================
  check('structures', 'count==16', structures.length === 16, `got ${structures.length}`);
  for (const s of structures) {
    for (const b of s.blockPalette || []) {
      check('structures', `${s.id} palette ${b}`, BLOCK_IDS.has(b), 'not a canon block id');
    }
  }
  check('structures', "gauntlet.structure 'selvage_outpost'",
    pack.structure(lastNeedle?.gauntlet?.structure) != null, 'structure(id) returned null');
  check('structures', "molthkin arena 'deepest_spindle'",
    pack.structure('deepest_spindle') != null, 'structure(id) returned null');
  for (const seal of lastNeedle?.gauntlet?.seals || []) {
    check('structures', `seal ${seal.id} outpost ${seal.outpost}`,
      STRUCTURE_VARIANT_IDS.has(seal.outpost), 'not a selvage_outpost variant id');
  }
  // selvage_outpost variants must carry the same four seals the gauntlet names
  const outpostSeals = new Set(
    (pack.structure('selvage_outpost')?.variants || []).map((v) => v.seal)
  );
  for (const seal of lastNeedle?.gauntlet?.seals || []) {
    check('structures', `variant carries ${seal.id}`, outpostSeals.has(seal.id),
      'no outpost variant declares this seal');
  }

  // =========================================================================
  // 5. BOSSES — victory triggers <-> achievements, onVictory achievement ids,
  //    choice wiring, hp cross-check with bestiary, summon seal predicates.
  // =========================================================================
  for (const [bossId, boss, expectHp] of [['last_needle', lastNeedle, 800], ['molthkin', molthkin, 280]]) {
    check('bosses', `boss('${bossId}') != null`, boss != null, 'getter returned null');
    if (!boss) continue;
    const vt = boss.victoryCondition && boss.victoryCondition.trigger;
    check('bosses', `${bossId} victory trigger '${vt}' has an achievement`,
      ACHIEVEMENT_TRIGGERS.has(vt), 'no achievement carries this trigger');
    check('bosses', `${bossId} stats.hp==${expectHp}`,
      boss.stats && boss.stats.hp === expectHp, `got ${boss.stats && boss.stats.hp}`);
    check('bosses', `${bossId} hp matches bestiary`,
      pack.bestiary(bossId)?.stats?.hp === boss.stats.hp,
      `bestiary hp ${pack.bestiary(bossId)?.stats?.hp} != boss ${boss.stats.hp}`);
    check('bosses', `${bossId} phases==3`, Array.isArray(boss.phases) && boss.phases.length === 3,
      `got ${boss.phases && boss.phases.length}`);
    for (const act of boss.onVictory || []) {
      if (act.action === 'grant_achievement') {
        check('bosses', `${bossId} onVictory grants ${act.achievementId}`,
          ACHIEVEMENT_IDS.has(act.achievementId), 'unknown achievement id');
      }
    }
  }
  for (const opt of choiceOptions) {
    check('bosses', `choice option ${opt.id} trigger`, ACHIEVEMENT_TRIGGERS.has(opt.trigger),
      'no achievement carries this trigger');
    check('bosses', `choice option ${opt.id} -> ${opt.achievementId}`,
      ACHIEVEMENT_IDS.has(opt.achievementId), 'unknown achievement id');
  }
  // last_needle summonRequirement names four seal_released predicates that
  // must all exist as gauntlet seals released by kill_entity:selvage_warden.
  const summonSeals = String(lastNeedle?.summonRequirement || '')
    .match(/seal_released:(\w+)/g)?.map((s) => s.split(':')[1]) || [];
  const gauntletSealIds = new Set((lastNeedle?.gauntlet?.seals || []).map((s) => s.id));
  check('bosses', 'summonRequirement names 4 seals', summonSeals.length === 4,
    `got ${summonSeals.length}`);
  for (const sealId of summonSeals) {
    check('bosses', `summon seal ${sealId} in gauntlet.seals`, gauntletSealIds.has(sealId),
      'not a gauntlet seal');
  }
  for (const seal of lastNeedle?.gauntlet?.seals || []) {
    check('bosses', `${seal.id} releasedBy kill_entity:selvage_warden`,
      /kill_entity:selvage_warden/.test(String(seal.releasedBy)),
      `got '${seal.releasedBy}'`);
  }
  check('bosses', 'kill_entity:selvage_warden is an achievement trigger',
    ACHIEVEMENT_TRIGGERS.has('kill_entity:selvage_warden'), 'missing');

  // =========================================================================
  // 6. DIALOGUE TELEGRAPHS — 100% coverage of both bosses' attack ids, both
  //    directions, via the dialogue(actor, event) getter.
  // =========================================================================
  for (const [bossId, actor, boss] of [['last_needle', 'lastNeedle', lastNeedle], ['molthkin', 'molthkin', molthkin]]) {
    const telegraphs = pack.dialogue(actor, 'attackTelegraphs') || [];
    const telegraphIds = new Set(telegraphs.map((t) => t.attackId));
    const attackIds = new Set(
      (boss?.phases || []).flatMap((p) => (p.attacks || []).map((a) => a.id ?? a.name ?? a))
    );
    for (const id of attackIds) {
      check('dialogue-telegraphs', `${bossId} attack '${id}' telegraphed`,
        telegraphIds.has(id), `no ${actor}.attackTelegraphs entry`);
    }
    for (const id of telegraphIds) {
      check('dialogue-telegraphs', `${actor} telegraph '${id}' is a real attack`,
        attackIds.has(id), 'attackId not in any phase');
    }
    const intros = pack.dialogue(actor, 'phaseIntros') || [];
    check('dialogue-telegraphs', `${actor} phaseIntros covers 3 phases`,
      new Set(intros.map((i) => i.phase)).size === 3, `got ${intros.length} intros`);
  }
  check('dialogue-telegraphs', "dialogueLine('lastNeedle','onBound')",
    typeof pack.dialogueLine('lastNeedle', 'onBound') === 'string',
    'no onBound line (main.js L1063 hardcodes this today)');
  check('dialogue-telegraphs', "dialogueLine('molthkin','onFelled')",
    typeof pack.dialogueLine('molthkin', 'onFelled') === 'string', 'no onFelled line');
  for (const ev of ['greeting', 'trade', 'farewell', 'hurt']) {
    check('dialogue-telegraphs', `dialogueLine('wickerkin','${ev}')`,
      typeof pack.dialogueLine('wickerkin', ev) === 'string', 'no line');
  }

  // =========================================================================
  // 7. TUTORIAL <-> ONBOARDING <-> NARRATOR — beat gateEvents match
  //    onboarding.md events and dialogue.json tutorialNarrator verbatim.
  // =========================================================================
  const tutorial = pack.tutorial();
  check('tutorial', 'tutorial() != null && beats==22',
    tutorial != null && tutorial.beats.length === 22,
    `got ${tutorial && tutorial.beats.length}`);
  const beatEvents = new Set();
  (tutorial?.beats || []).forEach((beat, i) => {
    beatEvents.add(beat.gateEvent);
    const narrator = pack.dialogue('tutorialNarrator', i); // builder-shape: beat index
    check('tutorial', `beat[${i}] '${beat.id}' gateEvent==narrator.event`,
      narrator != null && narrator.event === beat.gateEvent,
      `narrator '${narrator && narrator.event}' vs gate '${beat.gateEvent}'`);
    check('tutorial', `beat[${i}] narratorLine verbatim`,
      narrator != null && narrator.line === beat.narratorLine, 'line drift vs dialogue.json');
    check('tutorial', `beat[${i}] gateEvent in onboarding.md`,
      ONBOARDING_EVENTS.has(beat.gateEvent), 'event not documented in onboarding.md');
    check('tutorial', `beat[${i}] coachMark shape`,
      beat.coachMark && typeof beat.coachMark.title === 'string'
        && typeof beat.coachMark.body === 'string'
        && typeof beat.coachMark.placement === 'string',
      'coachMark missing title/body/placement');
  });
  for (const ev of ONBOARDING_EVENTS) {
    check('tutorial', `onboarding.md event '${ev}' has a beat`, beatEvents.has(ev),
      'no tutorial beat gates on it');
  }

  // =========================================================================
  // 8. DEATH MESSAGES — every damaging mob has a mob:<id> cause; every cause
  //    resolves; consumed exactly as main.js killPlayer(cause) does.
  // =========================================================================
  const deathDoc = JSON.parse(
    await fs.readFile(path.join(CONTENT_DIR, 'deathmessages.json'), 'utf8'));
  const CAUSES = new Set(deathDoc.deathMessages.map((d) => d.cause));
  check('deathmessages', 'cause count==21', CAUSES.size === 21, `got ${CAUSES.size}`);
  const hostiles = mobs.filter((m) => (m.stats && m.stats.damage) > 0);
  for (const mob of hostiles) {
    const cause = `mob:${mob.id}`; // main.js killPlayer arg shape
    const before = pack.warnings.length;
    const msg = pack.deathMessage(cause, { player: 'Jacob' });
    const fellBack = pack.warnings.length > before;
    check('deathmessages', `${cause} (hostile dmg ${mob.stats.damage})`,
      CAUSES.has(cause) && !fellBack && typeof msg === 'string'
        && msg.length > 0 && !msg.includes('{player}'),
      fellBack ? 'fell back to inline lines (no cause entry)' : 'bad message');
  }
  for (const cause of CAUSES) {
    if (cause.startsWith('mob:')) {
      check('deathmessages', `cause ${cause} resolves to bestiary`,
        MOB_IDS.has(cause.slice(4)), 'unknown mob id');
    } else {
      const msg = pack.deathMessage(cause, { player: 'Jacob' });
      check('deathmessages', `env cause ${cause}`,
        typeof msg === 'string' && msg.includes('Jacob'), 'not templated');
    }
  }
  // The only causes the builder produces TODAY (main.js): void_unravel + mob:*.
  check('deathmessages', "builder cause 'void_unravel' (kill-plane, main.js L959)",
    CAUSES.has('void_unravel'), 'missing');
  info(`deathmessages: builder currently emits only 'void_unravel' + 'mob:<canonicalId>'; the 7 env causes (fall/lava/drowning/explosion/starvation/fire/cinderloom_heat) are authored but never produced by main.js yet.`);

  // =========================================================================
  // 9. BOOKS — every structure yields a book via book(structureId) (the
  //    intended consumer arg shape); every placement resolves.
  // =========================================================================
  const books = pack.books();
  check('books', 'count==23', books.length === 23, `got ${books.length}`);
  for (const s of structures) {
    check('books', `book('${s.id}')`, pack.book(s.id) != null, 'no book placed here');
  }
  for (const b of books) {
    for (const p of b.placement || []) {
      check('books', `${b.id} placed in ${p}`, STRUCTURE_IDS.has(p), 'unknown structure id');
    }
  }

  // =========================================================================
  // 10. CAPTIONS — the full 66-key builder audio inventory resolves with zero
  //     gaps, tapped exactly where GameAudio.play(name) would tap.
  // =========================================================================
  check('captions', 'audio key inventory==66', AUDIO_KEYS.length === 66,
    `got ${AUDIO_KEYS.length}`);
  for (const key of AUDIO_KEYS) {
    const cap = pack.caption(key);
    let ok = cap != null && typeof cap.text === 'string' && cap.priority >= 1;
    let why = 'no caption resolves (exact or wildcard)';
    if (ok) {
      // The GameAudio.play tap would render via captionText with material/mob
      const text = pack.captionText(key, { material: 'Threadstone', mob: 'Skeinling' });
      if (typeof text !== 'string' || /\{(material|mob)\}/.test(text)) {
        ok = false; why = `unsubstituted placeholder in '${text}'`;
      }
    }
    check('captions', key, ok, why);
  }
  for (const key of EXTRA_CAPTION_KEYS) {
    check('captions', `${key} (future engine key)`, pack.caption(key) != null,
      'defined in neither exact nor wildcard form');
  }

  // =========================================================================
  // 11. BINDINGS — cover the builder's input action list; report the exact
  //     overlap/mismatch including the sneak/sprint key conflict.
  // =========================================================================
  const allBindings = pack.bindings();
  check('bindings', 'bindings() has 27 actions', Object.keys(allBindings).length === 27,
    `got ${Object.keys(allBindings).length}`);
  const mappedActions = new Set();
  const keyConflicts = [];
  for (const row of BUILDER_INPUT) {
    mappedActions.add(row.action);
    const b = pack.binding(row.action); // builder-shape: action name
    check('bindings', `${row.builder} -> binding('${row.action}')`, b != null,
      'no ux binding for this builder action');
    if (b && row.keys.length && !row.keys.includes(b.primary)) {
      keyConflicts.push(
        `${row.action}: ux primary '${b.primary}' vs builder hardcoded [${row.keys.join('|')}]`);
    }
  }
  const uxOnly = Object.keys(allBindings).filter((a) => !mappedActions.has(a));
  info(`bindings overlap: ${mappedActions.size} ux actions consumed by builder Controls.js; ux-only actions (builder has NO handler yet): [${uxOnly.join(', ')}]`);
  info(`bindings key conflicts (builder must adopt canon): ${keyConflicts.length ? keyConflicts.join('; ') : 'none'}`);
  check('bindings', 'ux-only actions are exactly {interact, eat}',
    uxOnly.sort().join(',') === 'eat,interact', `got [${uxOnly.join(', ')}]`);
  check('bindings', 'sneak/sprint conflict detected as expected (sneak=ShiftLeft, sprint=ControlLeft in canon)',
    keyConflicts.length === 2
      && keyConflicts.some((c) => c.startsWith('sneak:'))
      && keyConflicts.some((c) => c.startsWith('sprint:')),
    `conflicts: ${keyConflicts.join('; ')}`);

  // =========================================================================
  // 12. FAITHFUL CONSUMER STUBS — replicate the builder call sites.
  // =========================================================================

  // (a) achievements.js initAchievements: parseTrigger() replica over
  //     getAchievements(), with caps built exactly like main.js L283-297.
  const lootItemIds = mobs.flatMap((m) => (m.drops || []).map((d) => d.item));
  const caps = {
    killableEntityIds: new Set(Object.values(CANONICAL_ID)),
    obtainableItemIds: new Set([...CANON_BLOCK_ID_VALUES, ...lootItemIds]),
    placeableCanonIds: new Set(CANON_BLOCK_ID_VALUES),
    enterableDimensions: new Set(CANON_DIM_VALUES),
  };
  function parseTriggerReplica(trigger) { // verbatim logic, achievements.js L96-137
    if (trigger === 'first_block_broken') return { kind: 'event', event: 'block:broken' };
    if (trigger === 'player_unpicked') return { kind: 'event', event: 'player:died' };
    if (trigger === 'survive_first_night') return { kind: 'event', event: 'night:survived' };
    let m = /^kill_entity:(.+)$/.exec(trigger);
    if (m) return caps.killableEntityIds.has(m[1]) ? { kind: 'kill', entity: m[1] } : null;
    m = /^enter_dimension:(.+)$/.exec(trigger);
    if (m) return caps.enterableDimensions.has(m[1]) ? { kind: 'dimension', dim: m[1] } : null;
    m = /^collect_count:([^:]+):(\d+)$/.exec(trigger);
    if (m) return caps.obtainableItemIds.has(m[1])
      ? { kind: 'count', counter: `collect:${m[1]}`, need: Number(m[2]) } : null;
    m = /^place_block:(.+)$/.exec(trigger);
    if (m) return caps.placeableCanonIds.has(m[1]) ? { kind: 'place', canonId: m[1] } : null;
    m = /^place_count:([^:]+):(\d+)$/.exec(trigger);
    if (m) return caps.placeableCanonIds.has(m[1])
      ? { kind: 'count', counter: `place:${m[1]}`, need: Number(m[2]) } : null;
    return null;
  }
  const wired = [];
  const unwired = [];
  for (const d of achievements) {
    check('consumer-stubs', `achievements.js shape ${d.id}`,
      typeof d.id === 'string' && typeof d.name === 'string'
        && typeof d.description === 'string' && typeof d.trigger === 'string',
      'missing id/name/description/trigger the toast renderer destructures');
    (parseTriggerReplica(String(d.trigger || '')) ? wired : unwired).push(d.id);
  }
  info(`achievements stub: stats() would report {total:${achievements.length}, wired:${wired.length}} — unwired triggers (no engine yet, matches builder behavior): ${unwired.length}`);
  check('consumer-stubs', 'achievements stub wires >= 25 triggers under builder caps',
    wired.length >= 25, `only ${wired.length} wired`);
  check('consumer-stubs', "kill_entity:last_needle wired (victory path)",
    wired.includes(achievements.find((a) => a.trigger === 'kill_entity:last_needle')?.id),
    'boss victory achievement not wireable under builder caps');

  // (b) deathmessages.js deathMessageFor(cause, playerName) — via main.js
  //     killPlayer: onMobEvent produces mob:<CANONICAL_ID[archetype]>.
  for (const [arch, canonId] of Object.entries(CANONICAL_ID)) {
    if (!(pack.bestiary(canonId)?.stats?.damage > 0)) continue; // passive: never a killer
    const msg = pack.deathMessage(`mob:${canonId}`, { player: 'Jacob' });
    check('consumer-stubs', `killPlayer('mob:${canonId}') via archetype '${arch}'`,
      typeof msg === 'string' && msg.includes('Jacob'), 'no templated message');
  }
  check('consumer-stubs', "killPlayer('void_unravel')",
    pack.deathMessage('void_unravel', { player: 'Jacob' }).includes('Jacob'), 'not templated');

  // (c) menu.js: splash pick + rotating loading tip (uncategorized, like
  //     showRandomTip); help.js: GAME_GUIDE.md present and controls-corrected.
  check('consumer-stubs', 'menu splash()', typeof pack.splash() === 'string'
    && pack.splash().length > 0, 'no splash');
  check('consumer-stubs', 'menu tip() (uncategorized rotation)',
    pack.tip() != null && typeof pack.tip().text === 'string', 'no tip');
  for (const sys of TIP_SYSTEMS) {
    const t = pack.tip(sys);
    check('consumer-stubs', `tip('${sys}')`, t != null && t.system === sys,
      'no tip for declared system');
  }
  const guide = await fs.readFile(path.join(CONTENT_DIR, 'GAME_GUIDE.md'), 'utf8');
  check('consumer-stubs', 'help.js GAME_GUIDE.md fetchable + non-empty', guide.length > 100,
    'guide missing/empty');
  check('consumer-stubs', 'GAME_GUIDE controls agree with bindings (Sneak=Left Shift, Sprint=Left Ctrl)',
    /Sneak[^\n]*Left Shift/.test(guide) && /Sprint[^\n]*Left Ctrl/.test(guide)
      && pack.binding('sneak')?.primary === 'ShiftLeft'
      && pack.binding('sprint')?.primary === 'ControlLeft',
    'guide table / bindings.default.json disagree');

  // (d) MobManager ARCHETYPE_CONFIG: hardcoded maxHp must equal
  //     pack.bestiary(CANONICAL_ID[archetype]).stats.hp — proving the pack
  //     can replace the inlined stats verbatim.
  for (const [arch, hp] of Object.entries(BUILDER_MAX_HP)) {
    const canonHp = pack.bestiary(CANONICAL_ID[arch])?.stats?.hp;
    check('consumer-stubs', `MobManager ${arch}.maxHp(${hp}) == bestiary('${CANONICAL_ID[arch]}').stats.hp`,
      canonHp === hp, `canon hp ${canonHp}`);
  }
  check('consumer-stubs', 'molthkin canon phases==3 (builder inlines only 2)',
    molthkin?.phases?.length === 3, `got ${molthkin?.phases?.length}`);

  // (e) GameAudio.play(name) caption tap — every registry key renders a
  //     caption string (covered exhaustively in system 10; spot-shape here).
  const capShape = pack.caption('break.stone');
  check('consumer-stubs', "caption('break.stone') shape {sound,text,category,priority,durationMs}",
    capShape != null && typeof capShape.sound === 'string' && typeof capShape.text === 'string'
      && typeof capShape.category === 'string' && typeof capShape.priority === 'number'
      && typeof capShape.durationMs === 'number',
    'caption record missing fields');

  // (f) deathscreen.show(message) — message is a plain non-empty string.
  const shown = pack.deathMessage('mob:last_needle', { player: 'Jacob' });
  check('consumer-stubs', 'deathscreen.show(deathMessage(...)) gets non-empty string',
    typeof shown === 'string' && shown.length > 0, 'empty message');

  // (g) getters never throw on unknown ids (builder passes raw user/world data)
  let threw = false;
  try {
    pack.bestiary('no_such_mob'); pack.item('no_such_item'); pack.boss('no_such_boss');
    pack.structure('nope'); pack.caption('no.such.key'); pack.binding('warpDrive');
    pack.dialogue('nobody', 'nothing'); pack.book('no_structure'); pack.recipe('none');
    pack.tip('not-a-system'); pack.deathMessage('mob:not_real', { player: 'X' });
  } catch (e) { threw = true; info(`getter threw: ${e.message}`); }
  check('consumer-stubs', 'unknown-id lookups never throw', !threw, 'a getter threw');

  // =========================================================================
  // Stale-id verification against the builder content snapshot (if present)
  // =========================================================================
  let staleVerification = 'snapshot dir not found — stale list reported as-is from brief';
  try {
    const snapFiles = await fs.readdir(SNAPSHOT_DIR);
    const snapItems = JSON.parse(
      await fs.readFile(path.join(SNAPSHOT_DIR, 'items.json'), 'utf8')).items;
    const snapStructs = JSON.parse(
      await fs.readFile(path.join(SNAPSHOT_DIR, 'structures.json'), 'utf8')).structures;
    const snapDialogue = JSON.parse(
      await fs.readFile(path.join(SNAPSHOT_DIR, 'dialogue.json'), 'utf8'));
    const snapAch = JSON.parse(
      await fs.readFile(path.join(SNAPSHOT_DIR, 'achievements.json'), 'utf8')).achievements;
    const checks = [
      ['molthkin.json missing in builder snapshot', !snapFiles.includes('molthkin.json')],
      ['sennit_grain missing in builder items.json',
        !snapItems.some((i) => i.id === 'sennit_grain')],
      ['selvage_outpost missing in builder structures.json',
        !snapStructs.some((s) => s.id === 'selvage_outpost')],
      ['deepest_spindle missing in builder structures.json',
        !snapStructs.some((s) => s.id === 'deepest_spindle')],
      ['molthkin actor missing in builder dialogue.json', snapDialogue.molthkin == null],
      ['stitch_ground_beneath_hooves name stale in builder',
        snapAch.find((a) => a.id === 'stitch_ground_beneath_hooves')?.name
          !== achievements.find((a) => a.id === 'stitch_ground_beneath_hooves')?.name],
    ];
    for (const [id, ok] of checks) check('stale-verify', id, ok, 'brief claim NOT confirmed');
    staleVerification = `verified against ${SNAPSHOT_DIR}`;
  } catch {
    // snapshot unavailable — skip verification, keep static list
  }

  // =========================================================================
  // Report
  // =========================================================================
  const rows = [];
  let totalChecked = 0;
  let totalResolved = 0;
  for (const [name, s] of systems) {
    totalChecked += s.checked;
    totalResolved += s.resolved;
    rows.push({
      system: name,
      checked: s.checked,
      resolved: s.resolved,
      unresolved: s.unresolved,
      coverage: s.checked ? +(100 * s.resolved / s.checked).toFixed(1) : 100,
    });
  }

  const pad = (v, n) => String(v).padEnd(n);
  const line = '-'.repeat(96);
  console.log('\nLOOMFALL CONTENT INTEGRATION — RESOLVE/COVERAGE PROOF');
  console.log(`content: ${CONTENT_DIR}\nux:      ${UX_DIR}\n${line}`);
  console.log(pad('SYSTEM', 24) + pad('CHECKED', 9) + pad('RESOLVED', 10)
    + pad('COVERAGE', 10) + 'UNRESOLVED');
  console.log(line);
  for (const r of rows) {
    console.log(pad(r.system, 24) + pad(r.checked, 9) + pad(r.resolved, 10)
      + pad(r.coverage + '%', 10) + (r.unresolved.length ? r.unresolved.length : '-'));
    for (const u of r.unresolved) console.log(`  !! ${u}`);
  }
  console.log(line);
  const totalPct = +(100 * totalResolved / totalChecked).toFixed(1);
  console.log(pad('TOTAL', 24) + pad(totalChecked, 9) + pad(totalResolved, 10)
    + pad(totalPct + '%', 10));
  console.log('\nNOTES');
  for (const n of notes) console.log(`  - ${n}`);
  console.log(`\nSTALE IDS (builder snapshot vs canon; ${staleVerification})`);
  for (const s of STALE_IDS) console.log(`  [${s.kind}] ${s.file}: ${s.id}`);
  if (pack.warnings.length) {
    console.log(`\npack.warnings recorded during proof: ${pack.warnings.length} (expected — negative lookups + real content gaps)`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    contentDir: CONTENT_DIR,
    uxDir: UX_DIR,
    load: loadResult,
    totals: { checked: totalChecked, resolved: totalResolved, coveragePct: totalPct },
    systems: rows,
    notes,
    staleIds: { verification: staleVerification, entries: STALE_IDS },
  };
  await fs.writeFile(path.join(HERE, 'coverage.json'), JSON.stringify(report, null, 2));
  console.log(`\ncoverage.json written to ${path.join(HERE, 'coverage.json')}`);

  // The script itself always exits 0 when it ran to completion — content
  // gaps are findings in the report, not crashes.
  console.log(`\nPROOF ${totalResolved === totalChecked ? 'CLEAN' : 'COMPLETE WITH FINDINGS'} — ${totalChecked - totalResolved} unresolved of ${totalChecked}`);
}

main().catch((err) => {
  console.error('proof.mjs crashed (script bug, not a content finding):', err);
  process.exit(1);
});
