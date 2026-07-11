/**
 * loader.test.mjs — exercises EVERY ContentPack getter against the
 * materialized canon + ux data. Run: node loader.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContentPack } from './loader.js';

const CI_SRC =
  '/tmp/claude-0/-home-user-MinecraftV2/97d2c063-abec-5582-8174-3e66bef1d68c/scratchpad/ci-src';
const CANON = `${CI_SRC}/canon`;
const UX = `${CI_SRC}/ux`;

/** Deterministic rng factory (mulberry32). */
function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pack = new ContentPack({ baseUrl: CANON, uxUrl: UX });
const loadResult = await pack.load();

test('load: all 15 files load, ok=true, idempotent', async () => {
  assert.equal(loadResult.ok, true);
  assert.equal(loadResult.loaded.length, 15);
  assert.deepEqual(loadResult.failed, []);
  assert.equal(pack.isLoaded(), true);
  // Idempotent: same promise, same result object.
  const again = await pack.load();
  assert.equal(again, loadResult);
});

test('getAchievements: 60 entries, file order, canon rename present', () => {
  const achievements = pack.getAchievements();
  assert.equal(achievements.length, 60);
  const first = achievements[0];
  assert.equal(first.id, 'a_thread_comes_loose');
  assert.equal(first.trigger, 'first_block_broken');
  for (const key of ['id', 'name', 'description', 'trigger', 'tree', 'tier', 'parent', 'hidden']) {
    assert.ok(key in first, `achievement has ${key}`);
  }
  const strider = achievements.find((a) => a.id === 'stitch_ground_beneath_hooves');
  assert.equal(strider.name, 'Ground Beneath Every Stride'); // latest canon
  assert.ok(Object.isFrozen(achievements) && Object.isFrozen(first));
});

test('splash: random member of the 155-line pool, rng-deterministic', () => {
  const line = pack.splash();
  assert.equal(typeof line, 'string');
  const a = new ContentPack({ baseUrl: CANON, uxUrl: UX, rng: seededRng(7) });
  const b = new ContentPack({ baseUrl: CANON, uxUrl: UX, rng: seededRng(7) });
  return Promise.all([a.load(), b.load()]).then(() => {
    assert.equal(a.splash(), b.splash());
    assert.equal(a.splash(), b.splash());
  });
});

test('tip: category filter, unknown category falls back to all, shape', () => {
  const mountTip = pack.tip('mounts');
  assert.ok(mountTip);
  assert.equal(mountTip.system, 'mounts');
  assert.equal(typeof mountTip.id, 'string');
  assert.equal(typeof mountTip.text, 'string');
  const anyTip = pack.tip();
  assert.ok(anyTip && typeof anyTip.text === 'string');
  const unknownCategory = pack.tip('minecarts');
  assert.ok(unknownCategory, 'unknown category still returns a tip (from all)');
  assert.ok(pack.warnings.some((w) => w.includes("unknown category 'minecarts'")));
});

test('deathMessage: {player} templating, mob causes, unknown-cause fallback', () => {
  const fall = pack.deathMessage('fall', { player: 'Jacob' });
  assert.ok(fall.includes('Jacob'), `templated: ${fall}`);
  assert.ok(!fall.includes('{player}'));
  const needle = pack.deathMessage('mob:last_needle', { player: 'Jacob' });
  assert.equal(typeof needle, 'string');
  assert.ok(!needle.includes('{player}'));
  const noCtx = pack.deathMessage('lava');
  assert.ok(!noCtx.includes('{player}'), 'defaults {player} to A Mender');
  const unknown = pack.deathMessage('meteor', { player: 'Jacob' });
  assert.equal(typeof unknown, 'string');
  assert.ok(!unknown.includes('{player}'), 'fallback line still templated');
  assert.ok(pack.warnings.some((w) => w.includes("unknown cause 'meteor'")));
});

test('dialogue: all four actors, tutorialNarrator by index, unknown -> null', () => {
  const greeting = pack.dialogue('wickerkin', 'greeting');
  assert.ok(Array.isArray(greeting) && greeting.every((l) => typeof l === 'string'));
  const intros = pack.dialogue('lastNeedle', 'phaseIntros');
  assert.ok(Array.isArray(intros) && intros.length === 3);
  assert.ok('phase' in intros[0] && 'name' in intros[0] && Array.isArray(intros[0].lines));
  const telegraphs = pack.dialogue('molthkin', 'attackTelegraphs');
  assert.ok(Array.isArray(telegraphs) && 'attackId' in telegraphs[0]);
  assert.ok(Array.isArray(pack.dialogue('molthkin', 'onFelled')));
  assert.ok(Array.isArray(pack.dialogue('lastNeedle', 'onBound')));
  const beat0 = pack.dialogue('tutorialNarrator', 0);
  assert.equal(beat0.event, 'on_world_start');
  assert.equal(typeof beat0.line, 'string');
  const beat21 = pack.dialogue('tutorialNarrator', '21'); // string index accepted
  assert.ok(beat21 && typeof beat21.line === 'string');
  assert.equal(pack.dialogue('tutorialNarrator', 22), null);
  assert.equal(pack.dialogue('nobody', 'greeting'), null);
  assert.equal(pack.dialogue('wickerkin', 'monologue'), null);
});

test('dialogueLine: random string from string[] nodes, line from narrator beats', () => {
  const greeting = pack.dialogue('wickerkin', 'greeting');
  const line = pack.dialogueLine('wickerkin', 'greeting');
  assert.ok(greeting.includes(line));
  const narratorLine = pack.dialogueLine('tutorialNarrator', 0);
  assert.equal(narratorLine, pack.dialogue('tutorialNarrator', 0).line);
  assert.equal(pack.dialogueLine('nobody', 'greeting'), null);
});

test('book/books: placement index, 21 books, unknown -> null', () => {
  const manorBook = pack.book('unpicked_manor');
  assert.ok(manorBook);
  assert.ok(manorBook.placement.includes('unpicked_manor'));
  for (const key of ['id', 'title', 'type', 'placement', 'text']) assert.ok(key in manorBook);
  assert.equal(pack.books().length, 21);
  assert.equal(pack.book('nowhere_at_all'), null);
});

test('bestiary/mobs: 17 mobs, spoolmare husbandry, boss stats, unknown -> null', () => {
  assert.equal(pack.mobs().length, 17);
  const spoolmare = pack.bestiary('spoolmare');
  assert.equal(spoolmare.husbandry.mountRequires, 'saddle_frame');
  assert.equal(spoolmare.husbandry.tameable, true);
  assert.equal(spoolmare.husbandry.tameFood, 'raw_skein');
  assert.equal(spoolmare.husbandry.breedable, false);
  const skeinling = pack.bestiary('skeinling');
  assert.equal(skeinling.husbandry.breedable, true);
  assert.equal(skeinling.husbandry.breedingFood, 'raw_skein');
  const deer = pack.bestiary('bobbin_deer');
  assert.equal(deer.husbandry.breedingFood, 'sennit_grain');
  assert.equal(pack.bestiary('last_needle').stats.hp, 800);
  assert.equal(pack.bestiary('selvage_warden').stats.hp, 90);
  assert.ok(Object.isFrozen(spoolmare) && Object.isFrozen(spoolmare.stats));
  assert.equal(pack.bestiary('creeper'), null);
});

test('item/items/recipe: 41 items incl. sennit_grain, 9-slot shapes, unknown -> null', () => {
  assert.equal(pack.items().length, 41);
  const grain = pack.item('sennit_grain');
  assert.equal(grain.tier, 0);
  assert.equal(grain.displayName, 'Sennit Grain');
  const recipe = pack.recipe('loose_thread');
  assert.ok(recipe && Array.isArray(recipe.shape) && recipe.shape.length === 9);
  assert.equal(recipe, pack.item('loose_thread').recipe);
  assert.equal(pack.item('diamond_sword'), null);
  assert.equal(pack.recipe('diamond_sword'), null);
});

test('boss: last_needle (hp 800, seal gauntlet) and molthkin (hp 280, 3 phases)', () => {
  const needle = pack.boss('last_needle');
  assert.equal(needle.stats.hp, 800);
  assert.equal(needle.phases.length, 3);
  assert.equal(needle.gauntlet.structure, 'selvage_outpost');
  assert.equal(needle.gauntlet.ordered, false);
  assert.equal(needle.gauntlet.seals.length, 4);
  const molthkin = pack.boss('molthkin');
  assert.equal(molthkin.stats.hp, 280);
  assert.equal(molthkin.phases.length, 3);
  assert.ok(Object.isFrozen(molthkin) && Object.isFrozen(molthkin.phases));
  assert.equal(pack.boss('herobrine'), null);
});

test('structures/structure: 16 entries incl. new selvage_outpost + deepest_spindle', () => {
  const structures = pack.structures();
  assert.equal(structures.length, 16);
  const outpost = pack.structure('selvage_outpost');
  assert.ok(outpost);
  assert.equal(outpost.category, 'nevermend_gauntlet');
  assert.ok(pack.structure('deepest_spindle'));
  const manor = pack.structure('unpicked_manor');
  assert.deepEqual(manor.footprint, { x: 29, y: 14, z: 21 });
  assert.equal(pack.structure('stronghold'), null);
});

test('caption: exact beats wildcard, one-segment *, specificity, unknown -> null', () => {
  // Exact match wins over 'break.*'.
  assert.equal(pack.caption('break.glass').text, 'Glass shatters');
  assert.equal(pack.caption('break.glass').sound, 'break.glass');
  // Wildcard fallback: 'break.threadstone' has no exact entry.
  const threadstone = pack.caption('break.threadstone');
  assert.equal(threadstone.sound, 'break.*');
  assert.equal(threadstone.text, '{material} breaks'); // placeholder verbatim
  // '*' matches exactly ONE dot-segment.
  assert.equal(pack.caption('mob.grazer.hurt').sound, 'mob.*.hurt');
  // Exact boss entries win over the boss.* wildcards...
  assert.equal(pack.caption('boss.molthkin.telegraph').sound, 'boss.molthkin.telegraph');
  // ...while unlisted boss ids fall through to the wildcard patterns.
  assert.equal(pack.caption('boss.last_needle.defeated').sound, 'boss.*.defeated');
  assert.equal(pack.caption('boss.selvage_warden.telegraph').sound, 'boss.*.telegraph');
  assert.equal(pack.caption('music.calm').sound, 'music.calm'); // exact entry
  assert.equal(pack.caption('music.somber').sound, 'music.*'); // wildcard fallback
  // Segment-count must match: 'break.*' must NOT match 'break.a.b'.
  assert.equal(pack.caption('break.deep.stone'), null);
  assert.equal(pack.caption('no.such.sound.key'), null);
  const shape = pack.caption('step.wool');
  for (const key of ['sound', 'text', 'category', 'priority', 'durationMs']) {
    assert.ok(key in shape, `caption has ${key}`);
  }
});

test('caption: every one of the builder audio engine 66 sound keys resolves', () => {
  const materials = ['stone', 'wood', 'dirt', 'grass', 'sand', 'glass', 'leaves', 'gravel', 'snow', 'metal', 'wool'];
  const keys = [];
  for (const verb of ['break', 'place', 'step']) for (const m of materials) keys.push(`${verb}.${m}`);
  keys.push('splash', 'wind', 'cave', 'portal', 'ui.click', 'hurt', 'pop', 'rain', 'thunder', 'thunder.distant');
  for (const mob of ['grazer', 'groaner', 'exploder', 'screecher', 'trader'])
    for (const state of ['idle', 'hurt', 'death']) keys.push(`mob.${mob}.${state}`);
  keys.push('door.open', 'door.close', 'chest.open', 'eat', 'drink', 'levelup', 'achievement', 'explosion');
  assert.equal(keys.length, 66);
  for (const key of keys) assert.ok(pack.caption(key), `caption resolves for '${key}'`);
});

test('captionText: {material}/{mob} substitution, null passthrough', () => {
  assert.equal(pack.captionText('break.stone', { material: 'Threadstone' }), 'Threadstone breaks');
  const mobText = pack.captionText('mob.grazer.hurt', { mob: 'Skeinling' });
  assert.ok(mobText.includes('Skeinling'), mobText);
  assert.ok(!mobText.includes('{mob}'));
  assert.equal(pack.captionText('no.such.sound.key'), null);
});

test('binding/bindings: 27 actions, canon sneak/sprint fix, unknown -> null', () => {
  const all = pack.bindings();
  assert.equal(Object.keys(all).length, 27);
  assert.ok(Object.isFrozen(all));
  assert.equal(pack.binding('moveForward').primary, 'KeyW');
  assert.equal(pack.binding('moveForward').secondary, 'ArrowUp');
  // Canon fix: sneak = ShiftLeft, sprint = ControlLeft (opposite of builder).
  assert.equal(pack.binding('sneak').primary, 'ShiftLeft');
  assert.equal(pack.binding('sprint').primary, 'ControlLeft');
  assert.equal(pack.binding('jump').gamepad, 0);
  assert.ok(pack.binding('interact'));
  assert.ok(pack.binding('eat'));
  assert.equal(pack.binding('flyUp'), null);
});

test('tutorial: version 1, 22 beats, narratorLine verbatim from dialogue', () => {
  const tutorial = pack.tutorial();
  assert.equal(tutorial.version, 1);
  assert.equal(tutorial.beats.length, 22);
  const beat = tutorial.beats[0];
  assert.equal(beat.id, 'on_world_start');
  assert.equal(beat.narratorLine, pack.dialogue('tutorialNarrator', 0).line);
  for (const key of ['id', 'narratorLine', 'coachMark', 'gateEvent', 'skippable']) {
    assert.ok(key in beat, `beat has ${key}`);
  }
  assert.ok('anchor' in beat.coachMark && 'title' in beat.coachMark);
  assert.ok(Object.isFrozen(tutorial) && Object.isFrozen(beat.coachMark));
});

test('warnings: unknown-id lookups are collected', () => {
  const before = pack.warnings.length;
  pack.bestiary('zombie');
  pack.item('netherite');
  pack.boss('wither');
  pack.structure('village');
  pack.caption('does.not.exist');
  pack.binding('crouchToggle');
  assert.ok(pack.warnings.length >= before + 6);
  assert.ok(pack.warnings.some((w) => w.includes("unknown mob 'zombie'")));
});

test('before load: getters degrade gracefully, never throw', () => {
  const cold = new ContentPack({ baseUrl: CANON, uxUrl: UX });
  assert.equal(cold.isLoaded(), false);
  assert.deepEqual(cold.getAchievements(), []);
  assert.equal(typeof cold.splash(), 'string'); // inline fallback
  assert.equal(cold.tip(), null);
  const msg = cold.deathMessage('fall', { player: 'Jacob' });
  assert.ok(msg.includes('Jacob') && !msg.includes('{player}'));
  assert.equal(cold.dialogue('wickerkin', 'greeting'), null);
  assert.equal(cold.book('unpicked_manor'), null);
  assert.deepEqual(cold.books(), []);
  assert.equal(cold.bestiary('spoolmare'), null);
  assert.deepEqual(cold.mobs(), []);
  assert.equal(cold.item('sennit_grain'), null);
  assert.equal(cold.recipe('loose_thread'), null);
  assert.equal(cold.boss('molthkin'), null);
  assert.deepEqual(cold.structures(), []);
  assert.equal(cold.caption('break.stone'), null);
  assert.equal(cold.binding('jump'), null);
  assert.deepEqual(cold.bindings(), {});
  assert.equal(cold.tutorial(), null);
});

test('partial failure: missing files degrade their domain, load reports them', async () => {
  const partial = new ContentPack({
    baseUrl: CANON,
    uxUrl: '/tmp/definitely-not-a-real-ux-dir',
  });
  const result = await partial.load();
  assert.equal(result.ok, false);
  assert.equal(result.loaded.length, 12);
  assert.deepEqual(
    result.failed.sort(),
    ['bindings.default.json', 'captions.json', 'tutorial.json']
  );
  assert.equal(partial.isLoaded(), true);
  // Content getters still work; ux domains degrade.
  assert.equal(partial.bestiary('spoolmare').husbandry.mountRequires, 'saddle_frame');
  assert.equal(partial.caption('break.stone'), null);
  assert.equal(partial.tutorial(), null);
  assert.ok(partial.warnings.some((w) => w.startsWith('load: captions.json failed')));
});

test('preloaded files map: browser-style construction without I/O', async () => {
  const fs = await import('node:fs/promises');
  const files = {};
  for (const name of [
    'achievements.json', 'bestiary.json', 'books.json', 'boss.json', 'molthkin.json',
    'deathmessages.json', 'dialogue.json', 'items.json', 'naming.json', 'splashes.json',
    'structures.json', 'tips.json',
  ]) files[name] = await fs.readFile(`${CANON}/${name}`, 'utf8'); // JSON text form
  for (const name of ['captions.json', 'bindings.default.json', 'tutorial.json'])
    files[name] = JSON.parse(await fs.readFile(`${UX}/${name}`, 'utf8')); // parsed form
  const mapped = new ContentPack({ files });
  const result = await mapped.load();
  assert.equal(result.ok, true);
  assert.equal(mapped.boss('molthkin').stats.hp, 280);
  assert.equal(mapped.binding('sneak').primary, 'ShiftLeft');
});

test('rng injection drives deathMessage/tip/book picks deterministically', async () => {
  const a = new ContentPack({ baseUrl: CANON, uxUrl: UX, rng: seededRng(42) });
  const b = new ContentPack({ baseUrl: CANON, uxUrl: UX, rng: seededRng(42) });
  await Promise.all([a.load(), b.load()]);
  assert.equal(a.deathMessage('fall', { player: 'X' }), b.deathMessage('fall', { player: 'X' }));
  assert.deepEqual(a.tip('combat'), b.tip('combat'));
  assert.deepEqual(a.book('unpicked_manor'), b.book('unpicked_manor'));
  assert.equal(a.dialogueLine('wickerkin', 'trade'), b.dialogueLine('wickerkin', 'trade'));
});
