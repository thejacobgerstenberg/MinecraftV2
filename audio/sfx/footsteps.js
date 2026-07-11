// audio/sfx/footsteps.js
// Footstep SFX family — one short, soft, low-passed noise "thump" per material.
// Each entry is a synth(ctx, out, when, opts) => { stop(at), duration } that
// schedules everything relative to `when` and works with an OfflineAudioContext.
//
// Footsteps are deliberately SHORT (~80-160ms) and clearly quieter than block
// break/place (target per-voice peak ~0.15-0.35). Timbre is coloured per
// material; pitch/cutoff jitter is driven by opts.rng so repeated steps differ
// yet stay deterministic when the caller seeds the PRNG.

import { noiseBuffer, noiseSource, filter, envGain, osc, connect } from "../dsp.js";

// --- small local helpers ---------------------------------------------------

/** Resolve a seeded PRNG from opts, else fall back to Math.random. */
function rngOf(opts) {
  return opts && typeof opts.rng === "function" ? opts.rng : Math.random;
}

/** Clamp velocity to 0..1 (default 1) and map to a gentle, still-audible gain. */
function velGain(opts) {
  let v = opts && opts.velocity != null ? opts.velocity : 1;
  if (!(v >= 0)) v = 1;
  if (v > 1) v = 1;
  // Keep quiet steps audible: 0.6 (silent-ish input) .. 1.0 (full velocity).
  return 0.6 + 0.4 * v;
}

/**
 * A filtered noise burst. Pushes its source into `sources` and returns the
 * audible duration. Chain: noise -> [highpass] -> [bandpass] -> lowpass -> env.
 */
function noiseThump(ctx, out, when, sources, cfg) {
  const color = cfg.color || "white";
  const bufSec = cfg.bufSec != null ? cfg.bufSec : 0.3;
  const rate = cfg.rate != null ? cfg.rate : 1;

  const attack = cfg.attack != null ? cfg.attack : 0.004;
  const decay = cfg.decay != null ? cfg.decay : 0.07;
  const release = cfg.release != null ? cfg.release : 0.03;
  const peak = cfg.peak != null ? cfg.peak : 0.3;

  const buf = noiseBuffer(ctx, bufSec, color);
  const src = noiseSource(ctx, buf, { playbackRate: rate });

  const chain = [src];
  if (cfg.hp != null) chain.push(filter(ctx, "highpass", cfg.hp, cfg.hpQ != null ? cfg.hpQ : 0.7));
  if (cfg.bp != null) chain.push(filter(ctx, "bandpass", cfg.bp, cfg.bpQ != null ? cfg.bpQ : 1));
  chain.push(filter(ctx, "lowpass", cfg.lp != null ? cfg.lp : 1200, cfg.lpQ != null ? cfg.lpQ : 0.7));

  const env = envGain(ctx, when, { attack, decay, sustain: 0, release, peak, hold: 0 });
  chain.push(env, out);
  connect(...chain);

  const dur = attack + decay + release;
  src.start(when);
  src.stop(when + dur + 0.05);
  sources.push(src);
  return dur;
}

/**
 * A short tonal blip (used for wood's hollow body and glass's glassy tick).
 * Pushes its oscillator into `sources`; returns its audible duration.
 */
function toneBlip(ctx, out, when, sources, cfg) {
  const attack = cfg.attack != null ? cfg.attack : 0.003;
  const decay = cfg.decay != null ? cfg.decay : 0.06;
  const release = cfg.release != null ? cfg.release : 0.02;
  const peak = cfg.peak != null ? cfg.peak : 0.15;

  const o = osc(ctx, cfg.type || "sine", cfg.freq != null ? cfg.freq : 200);
  const env = envGain(ctx, when, { attack, decay, sustain: 0, release, peak, hold: 0 });
  connect(o, env, out);

  const dur = attack + decay + release;
  o.start(when);
  o.stop(when + dur + 0.05);
  sources.push(o);
  return dur;
}

/** Build the { stop, duration } handle shared by every footstep. */
function handle(when, sources, duration) {
  return {
    duration,
    stop(at) {
      const t = typeof at === "number" ? at : when;
      for (const s of sources) {
        try {
          s.stop(t);
        } catch (e) {
          /* already stopped / not started — ignore */
        }
      }
    },
  };
}

// --- per-material footsteps -------------------------------------------------

// Stone: firm mid click. White noise, band around ~1kHz, tight and short.
function stepStone(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vg = velGain(opts);
  const sources = [];
  const rate = 0.92 + rng() * 0.16; // 0.92 .. 1.08
  const lp = 1000 + rng() * 500; // 1000 .. 1500
  const dur = noiseThump(ctx, out, when, sources, {
    color: "white",
    hp: 220,
    hpQ: 0.7,
    lp,
    lpQ: 0.9,
    peak: 0.40 * vg, // nudge up to clear the 0.15 footstep floor (~0.16)
    attack: 0.003,
    decay: 0.07,
    release: 0.03,
    rate,
  });
  return handle(when, sources, dur);
}

// Wood: hollow small knock. Mid noise tick + a low resonant sine "tonk".
function stepWood(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vg = velGain(opts);
  const sources = [];
  const rate = 0.9 + rng() * 0.2; // 0.90 .. 1.10
  const bp = 380 + rng() * 160; // hollow band 380 .. 540
  const dNoise = noiseThump(ctx, out, when, sources, {
    color: "white",
    bp,
    bpQ: 1.4,
    lp: 1600,
    lpQ: 0.8,
    peak: 0.22 * vg,
    attack: 0.003,
    decay: 0.06,
    release: 0.025,
    rate,
  });
  const knockHz = 170 + rng() * 90; // 170 .. 260
  const dTone = toneBlip(ctx, out, when, sources, {
    type: "sine",
    freq: knockHz,
    peak: 0.18 * vg,
    attack: 0.002,
    decay: 0.07,
    release: 0.03,
  });
  return handle(when, sources, Math.max(dNoise, dTone));
}

// Dirt: soft muffled. Brown noise through a low lowpass, no high content.
function stepDirt(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vg = velGain(opts);
  const sources = [];
  const rate = 0.9 + rng() * 0.18; // 0.90 .. 1.08
  const lp = 420 + rng() * 180; // 420 .. 600
  const dur = noiseThump(ctx, out, when, sources, {
    color: "brown",
    lp,
    lpQ: 0.7,
    peak: 0.46 * vg, // brown noise + heavy lowpass loses energy; nudge to clear 0.15 floor
    attack: 0.004,
    decay: 0.09,
    release: 0.035,
    rate,
  });
  return handle(when, sources, dur);
}

// Grass: soft muffled thump + a faint high rustle.
function stepGrass(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vg = velGain(opts);
  const sources = [];
  const rate = 0.9 + rng() * 0.2;
  const lp = 520 + rng() * 220; // 520 .. 740
  const dBody = noiseThump(ctx, out, when, sources, {
    color: "pink",
    lp,
    lpQ: 0.7,
    peak: 0.34 * vg,
    attack: 0.004,
    decay: 0.08,
    release: 0.035,
    rate,
  });
  // Faint high-frequency rustle layered on top.
  const hp = 3800 + rng() * 1600; // 3800 .. 5400
  const dRustle = noiseThump(ctx, out, when, sources, {
    color: "white",
    hp,
    hpQ: 0.6,
    lp: 11000,
    lpQ: 0.6,
    peak: 0.09 * vg,
    attack: 0.003,
    decay: 0.06,
    release: 0.03,
    rate: 1,
  });
  return handle(when, sources, Math.max(dBody, dRustle));
}

// Sand: soft grainy "shh". Wide mid-high band, slightly longer and softer.
function stepSand(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vg = velGain(opts);
  const sources = [];
  const rate = 0.94 + rng() * 0.14;
  const bp = 1600 + rng() * 900; // 1600 .. 2500
  const dur = noiseThump(ctx, out, when, sources, {
    color: "pink",
    bp,
    bpQ: 0.5, // wide band -> airy "shh"
    lp: 5200,
    lpQ: 0.6,
    peak: 0.85 * vg, // wide-band pink noise loses ~4x energy; actual ~0.19
    attack: 0.008, // softer, grainier onset
    decay: 0.1,
    release: 0.045,
    rate,
  });
  return handle(when, sources, dur);
}

// Glass: light glassy tick. Bright highpassed noise + a faint high sine.
function stepGlass(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vg = velGain(opts);
  const sources = [];
  const rate = 0.95 + rng() * 0.16;
  const hp = 2800 + rng() * 1400; // 2800 .. 4200
  const dTick = noiseThump(ctx, out, when, sources, {
    color: "white",
    hp,
    hpQ: 0.8,
    lp: 12000,
    lpQ: 0.6,
    peak: 0.24 * vg,
    attack: 0.002,
    decay: 0.045,
    release: 0.025,
    rate,
  });
  const ping = 2400 + rng() * 1200; // 2400 .. 3600
  const dPing = toneBlip(ctx, out, when, sources, {
    type: "triangle",
    freq: ping,
    peak: 0.1 * vg,
    attack: 0.002,
    decay: 0.05,
    release: 0.025,
  });
  return handle(when, sources, Math.max(dTick, dPing));
}

// --- registry ---------------------------------------------------------------

export default {
  "step.stone": stepStone,
  "step.wood": stepWood,
  "step.dirt": stepDirt,
  "step.grass": stepGrass,
  "step.sand": stepSand,
  "step.glass": stepGlass,
};
