// audio/sfx/ui.js
// UI / feedback SFX family: ui.click, hurt, pop.
// Each entry is a synth(ctx, out, when, opts) => { stop(at), duration } that
// schedules everything relative to `when` and works with an OfflineAudioContext.
//
//   ui.click : crisp ~40-70ms click — a tiny filtered noise tick + a short high
//              sine blip. Clean, not harsh.
//   hurt     : short player-hurt grunt (~250-400ms) — a low-mid pitch-dropping
//              tone with a growly noise layer and fast decay. Fully synthetic.
//   pop      : short bubbly "pop" (~90-140ms) — a fast rising-then-cut sine/tri
//              blip with a click transient, like an item pickup.
//
// Randomised parameters are driven by opts.rng so output is deterministic when
// the caller seeds the PRNG; Math.random is the fallback. Loudness is set by a
// final envGain per voice (per-voice peak ~0.4-0.55 at velocity 1, never > 0.9).

import { noiseBuffer, noiseSource, osc, filter, envGain, sweep, connect } from "../dsp.js";

// --- small local helpers ----------------------------------------------------

/** Resolve a seeded PRNG from opts, else fall back to Math.random. */
function rngOf(opts) {
  return opts && typeof opts.rng === "function" ? opts.rng : Math.random;
}

/** Clamp velocity to 0..1 (default 1) and map to a gentle, still-audible gain. */
function velGain(opts) {
  let v = opts && opts.velocity != null ? opts.velocity : 1;
  if (!(v >= 0)) v = 1;
  if (v > 1) v = 1;
  // Keep low-velocity events clearly audible: 0.65 (silent-ish) .. 1.0 (full).
  return 0.65 + 0.35 * v;
}

/**
 * A short filtered noise burst. Pushes its source into `sources` and returns
 * the audible duration. Chain: noise -> [highpass] -> [bandpass] -> lowpass -> env.
 */
function noiseTick(ctx, out, when, sources, cfg) {
  const color = cfg.color || "white";
  const bufSec = cfg.bufSec != null ? cfg.bufSec : 0.2;
  const rate = cfg.rate != null ? cfg.rate : 1;

  const attack = cfg.attack != null ? cfg.attack : 0.001;
  const decay = cfg.decay != null ? cfg.decay : 0.02;
  const release = cfg.release != null ? cfg.release : 0.01;
  const peak = cfg.peak != null ? cfg.peak : 0.3;

  const buf = noiseBuffer(ctx, bufSec, color);
  const src = noiseSource(ctx, buf, { playbackRate: rate });

  const chain = [src];
  if (cfg.hp != null) chain.push(filter(ctx, "highpass", cfg.hp, cfg.hpQ != null ? cfg.hpQ : 0.7));
  if (cfg.bp != null) chain.push(filter(ctx, "bandpass", cfg.bp, cfg.bpQ != null ? cfg.bpQ : 1));
  chain.push(filter(ctx, "lowpass", cfg.lp != null ? cfg.lp : 8000, cfg.lpQ != null ? cfg.lpQ : 0.7));

  const env = envGain(ctx, when, { attack, decay, sustain: 0, release, peak, hold: cfg.hold || 0 });
  chain.push(env, out);
  connect(...chain);

  const dur = attack + decay + (cfg.hold || 0) + release;
  src.start(when);
  src.stop(when + dur + 0.05);
  sources.push(src);
  return dur;
}

/**
 * A short tonal blip. Optionally sweeps its frequency from `freq` to `toFreq`
 * over the audible span. Pushes its oscillator into `sources`; returns duration.
 */
function toneBlip(ctx, out, when, sources, cfg) {
  const attack = cfg.attack != null ? cfg.attack : 0.002;
  const decay = cfg.decay != null ? cfg.decay : 0.04;
  const release = cfg.release != null ? cfg.release : 0.02;
  const hold = cfg.hold != null ? cfg.hold : 0;
  const peak = cfg.peak != null ? cfg.peak : 0.3;
  const freq = cfg.freq != null ? cfg.freq : 440;

  const o = osc(ctx, cfg.type || "sine", freq);
  const dur = attack + decay + hold + release;

  if (cfg.toFreq != null) {
    // Sweep across the full audible span of the blip.
    sweep(o.frequency, when, freq, cfg.toFreq, dur, cfg.sweepType || "exp");
  }

  const env = envGain(ctx, when, { attack, decay, sustain: 0, release, peak, hold });
  connect(o, env, out);

  o.start(when);
  o.stop(when + dur + 0.05);
  sources.push(o);
  return dur;
}

/** Build the { stop, duration } handle shared by every one-shot in this family. */
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

// --- sounds -----------------------------------------------------------------

// ui.click: crisp ~40-70ms tick. High, tight filtered-noise transient plus a
// very short high sine blip for a clean "pip". Deliberately bright but not harsh.
function uiClick(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vg = velGain(opts);
  const sources = [];

  // Filtered noise tick — highpassed, band-focused around ~3.5kHz, very short.
  const bp = 3000 + rng() * 1400; // 3000 .. 4400
  const dTick = noiseTick(ctx, out, when, sources, {
    color: "white",
    hp: 1800,
    hpQ: 0.7,
    bp,
    bpQ: 0.9,
    lp: 9000,
    lpQ: 0.7,
    peak: 0.34 * vg,
    attack: 0.001,
    decay: 0.02,
    release: 0.012,
  });

  // Short high sine "pip" on top for a clean click character.
  const pip = 2100 + rng() * 700; // 2100 .. 2800
  const dPip = toneBlip(ctx, out, when, sources, {
    type: "sine",
    freq: pip,
    peak: 0.28 * vg,
    attack: 0.001,
    decay: 0.03,
    release: 0.015,
  });

  return handle(when, sources, Math.max(dTick, dPip));
}

// hurt: short player-hurt grunt (~250-400ms). A low-mid tone that drops in
// pitch (saw through a lowpass for body/growl) layered with a band of noise
// for breathiness, with a fast overall decay. Original, not a voice sample.
function hurt(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vg = velGain(opts);
  const sources = [];

  // Body tone: sawtooth dropping ~200 -> ~110 Hz through a moving-ish lowpass.
  const startHz = 190 + rng() * 40; // 190 .. 230
  const endHz = 95 + rng() * 30; // 95 .. 125
  const bodyAttack = 0.006;
  const bodyDecay = 0.22;
  const bodyRelease = 0.08;
  const bodyDur = bodyAttack + bodyDecay + bodyRelease;

  const bo = osc(ctx, "sawtooth", startHz);
  sweep(bo.frequency, when, startHz, endHz, bodyDur, "exp");
  const bodyLp = filter(ctx, "lowpass", 1200, 0.9);
  // Nudge the cutoff down as the tone falls, softening the growl over time.
  sweep(bodyLp.frequency, when, 1400, 700, bodyDur, "exp");
  const bodyEnv = envGain(ctx, when, {
    attack: bodyAttack,
    decay: bodyDecay,
    sustain: 0,
    release: bodyRelease,
    peak: 0.42 * vg,
    hold: 0,
  });
  connect(bo, bodyLp, bodyEnv, out);
  bo.start(when);
  bo.stop(when + bodyDur + 0.05);
  sources.push(bo);

  // Growl / breath: low-mid band of noise, shorter and quieter than the tone.
  const growlBp = 420 + rng() * 220; // 420 .. 640
  const dGrowl = noiseTick(ctx, out, when, sources, {
    color: "brown",
    bp: growlBp,
    bpQ: 1.1,
    lp: 1600,
    lpQ: 0.7,
    peak: 0.24 * vg,
    attack: 0.005,
    decay: 0.14,
    release: 0.06,
    bufSec: 0.5,
  });

  return handle(when, sources, Math.max(bodyDur, dGrowl));
}

// pop: short bubbly "pop" (~90-140ms). A fast rising-then-cut sine/triangle
// blip (pitch sweeps up, amplitude cut sharply) plus a tiny click transient.
function pop(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vg = velGain(opts);
  const sources = [];

  // Click transient right at the onset — a very short high noise tick.
  const dClick = noiseTick(ctx, out, when, sources, {
    color: "white",
    hp: 2500,
    hpQ: 0.7,
    lp: 10000,
    lpQ: 0.7,
    peak: 0.22 * vg,
    attack: 0.0005,
    decay: 0.008,
    release: 0.006,
    bufSec: 0.05,
  });

  // Rising body blip: pitch sweeps up, then the envelope cuts it -> "bloop".
  const startHz = 380 + rng() * 120; // 380 .. 500
  const endHz = 820 + rng() * 260; // 820 .. 1080
  const dBody = toneBlip(ctx, out, when, sources, {
    type: rng() < 0.5 ? "sine" : "triangle",
    freq: startHz,
    toFreq: endHz,
    sweepType: "exp",
    peak: 0.5 * vg,
    attack: 0.004,
    decay: 0.06,
    hold: 0.01,
    release: 0.03, // fairly quick cut for the "pop"
  });

  return handle(when, sources, Math.max(dClick, dBody));
}

// --- registry ---------------------------------------------------------------

export default {
  "ui.click": uiClick,
  hurt: hurt,
  pop: pop,
};
