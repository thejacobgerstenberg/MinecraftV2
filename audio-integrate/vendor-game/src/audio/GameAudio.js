// Loomfall — game-side audio integration (audio phase).
//
// Thin, crash-proof wrapper around the procedural audio engine
// (public/audio/engine.js — see public/audio/README.md). Every public method
// is wrapped so an audio failure (no AudioContext, autoplay policy, headless
// quirks) can NEVER break gameplay: calls degrade to silent no-ops while
// `state` keeps counting what was attempted (QA stub-checks read it).
//
// Responsibilities:
//   * lazy engine creation + resume() on the first user gesture
//   * block id -> engine material mapping (break./place./step. keys)
//   * per-dimension music + ambience beds (overworld/nether/end)
//   * rain loop handle + thunder one-shots (paired with the weather system)
//   * master/sfx/music volume application from the settings object
//
// The AudioContext may sit in the 'suspended' state until a real user gesture
// arrives (browser autoplay policy); play() calls made before that are
// harmless (nodes schedule into the suspended context and are discarded).

import AudioEngine from '../../audio/engine.js';
import { getBlockDef } from '../blocks/blocks.js';

// Block name -> engine material family (stone, wood, dirt, grass, sand,
// glass, leaves, gravel, snow, metal, wool). null = no block sound (liquids).
const MATERIAL_BY_BLOCK = {
  air: null,
  grass: 'grass',
  dirt: 'dirt',
  stone: 'stone',
  cobblestone: 'stone',
  sand: 'sand',
  sandstone: 'stone',
  gravel: 'gravel',
  water: null,
  log: 'wood',
  leaves: 'leaves',
  planks: 'wood',
  glass: 'glass',
  coal_ore: 'stone',
  iron_ore: 'stone',
  gold_ore: 'stone',
  diamond_ore: 'stone',
  bedrock: 'stone',
  snow_block: 'snow',
  snow_grass: 'snow',
  cactus: 'leaves',
  red_sand: 'sand',
  netherrack: 'stone',
  soul_sand: 'sand',
  glowstone: 'glass',
  obsidian: 'stone',
  end_stone: 'stone',
  purpur: 'stone',
  lava: null,
  portal: 'glass',
};

/** Engine sound-material for a block id ('stone', 'wood', …) or null. */
export function materialForBlock(blockId) {
  const def = getBlockDef(blockId);
  const mat = MATERIAL_BY_BLOCK[def.name];
  return mat === undefined ? 'stone' : mat;
}

/** Small deterministic string -> uint32 hash (music seeds from world seeds). */
function hashSeed(seed) {
  const s = String(seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Dimension id -> { music mode, ambience bed sound names }.
const DIMENSION_AUDIO = {
  overworld: { music: 'calm', beds: [{ name: 'wind', volume: 0.35 }] },
  nether: { music: 'nether', beds: [{ name: 'cave', volume: 0.5 }] },
  end: { music: 'mysterious', beds: [] },
};

export class GameAudio {
  constructor() {
    this.engine = new AudioEngine(); // no AudioContext yet (lazy)
    this._failed = false; // a hard engine failure latches audio off
    this._beds = []; // looping ambience handles for the current dimension
    this._rain = null; // looping rain handle (weather pairing)
    this._pendingDim = null; // dimension music requested before first resume
    this._dimSeed = 0;

    /** QA-visible state (docs/DEV.md): counters, last keys, context state. */
    this.state = {
      resumed: false,
      contextState: 'none', // none | suspended | running | closed | failed
      plays: 0, // total play() attempts (incl. pre-resume)
      lastSound: null,
      music: null, // current music mode string or null
      rain: false, // rain loop currently held
      volumes: { master: 1, sfx: 1, music: 0.7 },
    };
  }

  _refreshCtxState() {
    try {
      this.state.contextState = this.engine.ctx ? this.engine.ctx.state : 'none';
    } catch { /* ignore */ }
  }

  /** Guarded engine call. Returns fn() result or null; never throws. */
  _safe(fn) {
    if (this._failed) return null;
    try {
      return fn();
    } catch (err) {
      // First failure only: log once, keep the game running silently.
      this._failed = true;
      this.state.contextState = 'failed';
      console.warn('[loomfall] audio disabled:', err && err.message ? err.message : err);
      return null;
    }
  }

  /** Resume/create the AudioContext. Call from a user gesture. Idempotent. */
  resume() {
    this._safe(() => {
      const p = this.engine.resume();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          this.state.resumed = true;
          this._refreshCtxState();
          // Music was requested (dimension entered) before the gesture —
          // start it now that the context can actually run.
          if (this._pendingDim) {
            const dim = this._pendingDim;
            this._pendingDim = null;
            this.setDimension(dim, this._dimSeed);
          }
        }).catch(() => {});
      }
    });
    this._refreshCtxState();
  }

  /** Apply {volumeMaster, volumeSfx, volumeMusic} (each 0..1) live. */
  setVolumes(settings) {
    const m = Number(settings.volumeMaster);
    const s = Number(settings.volumeSfx);
    const mu = Number(settings.volumeMusic);
    this._safe(() => {
      if (Number.isFinite(m)) this.engine.setMasterVolume(m);
      if (Number.isFinite(s)) this.engine.setSfxVolume(s);
      if (Number.isFinite(mu)) this.engine.setMusicVolume(mu);
    });
    if (Number.isFinite(m)) this.state.volumes.master = m;
    if (Number.isFinite(s)) this.state.volumes.sfx = s;
    if (Number.isFinite(mu)) this.state.volumes.music = mu;
  }

  /** Core guarded one-shot. Returns the engine handle or null. */
  play(name, opts) {
    this.state.plays++;
    this.state.lastSound = name;
    const h = this._safe(() => this.engine.play(name, opts));
    this._refreshCtxState();
    return h;
  }

  /** Update the 3D listener from the eye position + look yaw (radians). */
  setListener(pos, yaw) {
    this._safe(() => {
      this.engine.setListener(pos, { x: -Math.sin(yaw), z: -Math.cos(yaw) });
    });
  }

  // ---- gameplay one-shots ---------------------------------------------------

  ui() { this.play('ui.click'); }
  hurt() { this.play('hurt'); }
  levelup() { this.play('levelup'); }
  achievement() { this.play('achievement'); }
  splash(pos) { this.play('splash', { pos }); }
  portal(pos) { this.play('portal', pos ? { pos } : undefined); }

  blockBreak(blockId, pos) {
    const mat = materialForBlock(blockId);
    if (mat) this.play(`break.${mat}`, { pos });
  }

  blockPlace(blockId, pos) {
    const mat = materialForBlock(blockId);
    if (mat) this.play(`place.${mat}`, { pos });
  }

  /** Footstep on the block the player stands on (throttled by the caller). */
  step(blockId, pos, velocity = 0.7) {
    const mat = materialForBlock(blockId);
    if (mat) this.play(`step.${mat}`, { pos, velocity, volume: 0.55 });
  }

  // ---- weather pairing --------------------------------------------------------

  /** Ensure the rain loop runs at `intensity` (ramping if already running). */
  rainSet(intensity, ramp = 2) {
    if (this._rain) {
      this._safe(() => this._rain.setIntensity && this._rain.setIntensity(intensity, ramp));
    } else {
      this.state.plays++;
      this.state.lastSound = 'rain';
      this._rain = this._safe(() => this.engine.play('rain', { intensity }));
    }
    this.state.rain = !!this._rain;
  }

  rainStop() {
    if (this._rain) {
      const h = this._rain;
      this._rain = null;
      this._safe(() => h.stop());
    }
    this.state.rain = false;
  }

  thunder(far, pos) {
    if (far) this.play('thunder.distant');
    else this.play('thunder', pos ? { pos } : undefined);
  }

  // ---- dimension music + ambience beds ---------------------------------------

  /**
   * Switch music + ambience for a dimension. Stops the previous beds. Music
   * only actually starts once the context has been resumed by a gesture
   * (queued until then), so a suspended context never accumulates a backlog.
   */
  setDimension(dimId, worldSeed = 0) {
    this._dimSeed = worldSeed;
    const spec = DIMENSION_AUDIO[dimId];
    if (!spec) return;

    // Stop old ambience beds (music crossfades inside startMusic).
    for (const bed of this._beds.splice(0)) {
      this._safe(() => bed.stop());
    }

    if (!this.state.resumed) {
      // Autoplay policy: defer until resume() succeeds on a gesture.
      this._pendingDim = dimId;
      this.state.music = null;
      return;
    }

    this._safe(() => {
      this.engine.startMusic(spec.music, { seed: hashSeed(`${worldSeed}:${spec.music}`) });
    });
    this.state.music = spec.music;
    for (const bed of spec.beds) {
      const h = this._safe(() => this.engine.play(bed.name, { volume: bed.volume }));
      if (h) this._beds.push(h);
    }
  }

  /** Stop music, beds, rain and every live voice (session teardown). */
  stopAll() {
    this.rainStop();
    for (const bed of this._beds.splice(0)) this._safe(() => bed.stop());
    this._pendingDim = null;
    this.state.music = null;
    this._safe(() => this.engine.stopAll());
  }
}
