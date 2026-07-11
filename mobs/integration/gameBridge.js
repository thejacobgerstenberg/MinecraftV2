// ============================================================================
// mobs/integration/gameBridge.js
//
// EXAMPLE adapter wiring mobs/MobManager.js into the voxel-sandbox game
// (branch feat/voxel-sandbox-game). This file is NOT imported by anything
// in mobs/ itself -- copy it into the game (or adapt it in place) and call
// createMobBridge() once, near where the game constructs its scene/world/
// player. See mobs/integration.md for the full copy-paste recipe.
//
// Every external dependency below (audioEngine, achievements, inventory) is
// OPTIONAL and touched only via `?.` optional chaining wrapped in try/catch,
// so a game that hasn't wired one of those systems yet still runs fine --
// missing pieces just silently no-op instead of throwing. `scene`/`world`/
// `player` are the only things assumed to exist by the time you call this
// (MobManager itself tolerates scene/world being null too, see its own
// constructor doc -- but a mob manager with no world can't do collision).
//
// This adapter deliberately does NOT hardcode audioEngine.play/achievements
// method names beyond a small guessed surface (play/unlock/grant/
// onMobKilled/onBossDefeated/fireTrigger/showEnding/onEverthreadObtained,
// inventory.addOrSpawnPickup) -- none of those are required to exist; every
// call is optional-chained. Rename/replace them to match the real APIs on
// feature/audio-engine / the game's achievement + inventory systems once
// those branches are merged; nothing here needs to change in MobManager.js
// itself to do so.
// ============================================================================

import { MobManager } from '../MobManager.js';

/**
 * createMobBridge(opts) -> { manager, update, setDimension, dispose, mount, dismount }
 *
 * @param {object} opts
 *   scene          - THREE.Scene | null
 *   world          - { getBlock(x,y,z): number } | null
 *   getBlockDef    - (id:number) => { solid:boolean, ... } -- pass the REAL
 *                     one from public/src/blocks/blocks.js. If omitted,
 *                     MobManager falls back to its own placeholder table.
 *   player         - the game's Player instance (public/src/gameplay/Player.js).
 *                     Read defensively: player.position for getPlayerPos,
 *                     player.hurt?.(dmg) for onPlayerHurt.
 *   audioEngine    - optional AudioEngine instance (feature/audio-engine),
 *                     expected shape: engine.play(name, { pos, volume }).
 *   achievements   - optional achievement/progress tracker. No fixed shape
 *                     is required; every method call below is optional.
 *   inventory      - optional Inventory. Expected shape:
 *                     inventory.addOrSpawnPickup(itemId, count, pos).
 *   rng            - optional () => number in [0,1); defaults to Math.random.
 *   dimension      - optional starting dimension id -- either an engine id
 *                     ('overworld'/'nether'/'end') or a Loomfall display key
 *                     ('warpwold'/'cinderloom'/'nevermend'); MobManager
 *                     normalizes either form. Defaults to 'overworld'.
 */
export function createMobBridge(opts = {}) {
  const {
    scene = null,
    world = null,
    getBlockDef,
    player = null,
    audioEngine = null,
    achievements = null,
    inventory = null,
    rng,
    dimension = 'overworld',
  } = opts;

  const manager = new MobManager(scene, world, {
    getBlockDef,
    getPlayerPos: () => (player && player.position) || null,
    onPlayerHurt: (dmg) => {
      try { player?.hurt?.(dmg); } catch (e) { /* defensive: never let a hurt-hook throw back into MobManager */ }
    },
    isDay: () => {
      try { return typeof world?.isDay === 'function' ? !!world.isDay() : true; } catch (e) { return true; }
    },
    rng: typeof rng === 'function' ? rng : Math.random,
    dimension,
    onEvent: handleEvent,
  });

  // ---- audio -------------------------------------------------------------

  function playSound(archetype, variant, position, volume = 1.0) {
    try {
      audioEngine?.play?.(`mob.${archetype}.${variant}`, { pos: position, volume });
    } catch (e) { /* audio is best-effort, never blocks gameplay */ }
  }

  // ---- achievements --------------------------------------------------------

  function unlockAchievement(id) {
    if (!id) return;
    try {
      // Tolerate either an unlock(id) or grant(id) style API.
      if (typeof achievements?.unlock === 'function') achievements.unlock(id);
      else if (typeof achievements?.grant === 'function') achievements.grant(id);
    } catch (e) { /* ignore */ }
  }

  // ---- inventory -----------------------------------------------------------

  function addLoot(itemId, count, pos) {
    try {
      inventory?.addOrSpawnPickup?.(itemId, count, pos);
    } catch (e) { /* ignore */ }
  }

  // ---- event routing ---------------------------------------------------

  function handleEvent(name, detail) {
    switch (name) {
      case 'mobSpawn':
        // Occasional idle chirp on spawn (not every spawn -- would get noisy
        // with many ambient mobs). Tune/remove the chance as desired.
        if (Math.random() < 0.15) playSound(detail.archetype, 'idle', detail.position, 0.5);
        break;

      case 'mobHurt':
        playSound(detail.archetype, 'hurt', detail.position, 0.8);
        break;

      case 'mobDeath':
        playSound(detail.archetype, 'death', detail.position, 1.0);
        try { achievements?.onMobKilled?.(detail.canonicalId, detail.archetype); } catch (e) { /* ignore */ }
        break;

      case 'mobAttack':
        // No 'mob.<archetype>.attack' sound-key contract is guaranteed to
        // exist for every archetype yet -- wire this up once the audio
        // asset list is final, e.g.:
        //   const variant = detail.explosion ? 'explode' : 'attack';
        //   playSound(detail.archetype, variant, detail.position, 1.0);
        break;

      case 'bossDefeated':
        // bound:true (lastneedle) => victory/ending path. bound:false
        // (molthkin) => genuinely killed; its loot (everthread) arrives via
        // a following 'mobDrop' event, handled below.
        if (detail.achievement) unlockAchievement(detail.achievement);
        if (detail.victoryTrigger) {
          try { achievements?.fireTrigger?.(detail.victoryTrigger); } catch (e) { /* ignore */ }
        }
        if (detail.canonicalId === 'last_needle') {
          try {
            achievements?.showEnding?.('content/ending.md', { title: 'The Turning of the Needle' });
            achievements?.presentChoice?.({
              prompt: 'The choice was always this, and always yours.',
              options: [
                { id: 'finish_the_weaving', achievementId: 'to_finish_the_weaving' },
                { id: 'still_the_loom', achievementId: 'let_it_come_to_rest' },
              ],
            });
          } catch (e) { /* ignore */ }
        }
        try { achievements?.onBossDefeated?.(detail); } catch (e) { /* ignore */ }
        break;

      case 'mobDrop':
        addLoot(detail.itemId, detail.count, detail.pos);
        if (detail.itemId === 'everthread') {
          try { achievements?.onEverthreadObtained?.(detail); } catch (e) { /* ignore */ }
        }
        break;

      case 'mobMount':
      case 'mobDismount':
      case 'mobBreed':
      case 'mobDespawn':
        // No default wiring for these -- hook here if the game wants sound/
        // UI/achievement reactions (e.g. a "tamed a Spoolmare" achievement
        // on 'mobMount').
        break;

      default:
        break;
    }
  }

  // ---- public surface ----------------------------------------------------

  return {
    manager,
    update(dt) { manager.update(dt); },
    setDimension(id) { manager.setDimension(id); },
    dispose() { manager.dispose(); },
    mount(mob) { return manager.mountPlayer(mob); },
    dismount(mob) { manager.dismountPlayer(mob); },
  };
}

export default createMobBridge;
