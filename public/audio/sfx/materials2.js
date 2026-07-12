// audio/sfx/materials2.js
// Phase 2 material sounds: break/place/step for leaves, gravel, snow, metal, wool.
// Each entry is a synth: (ctx, out, when, opts={}) => { stop(at), duration }.
// Everything is synthesized (oscillators + colored noise + envelopes/filters),
// scheduled strictly relative to `when` so it works under OfflineAudioContext.
// All randomization uses opts.rng (seeded PRNG) so output is deterministic.
//
// Loudness conventions (match blocks.js / footsteps.js):
//   break/place: per-voice peak ~0.3-0.7 nominal (filtered layers may use higher
//                nominal peaks because filtering sheds energy; comments note it).
//   step.*:      short (~80-160ms) and quiet — actual peak ~0.15-0.35.

import {
  noiseBuffer,
  noiseSource,
  osc,
  gain,
  filter,
  envGain,
  sweep,
  connect,
} from "../dsp.js";

/* ------------------------------------------------------------------ *
 * Small internal helpers (module-private, not exported).
 * ------------------------------------------------------------------ */

/** Resolve a seeded PRNG (fall back to Math.random). */
function prng(opts) {
  return opts && typeof opts.rng === "function" ? opts.rng : Math.random;
}

/** Resolve velocity in [0,1], default 1. */
function vel(opts) {
  const v = opts && opts.velocity != null ? opts.velocity : 1;
  return Math.max(0, Math.min(1, v));
}

/**
 * Footstep velocity mapping (matches footsteps.js): keep quiet steps audible.
 * velocity 0 -> 0.6, velocity 1 -> 1.0.
 */
function velGain(opts) {
  return 0.6 + 0.4 * vel(opts);
}

/** Uniform random in [lo, hi) using a seeded PRNG. */
function rnd(rng, lo, hi) {
  return lo + (hi - lo) * rng();
}

/**
 * Begin a voice: a single final GainNode routed into `out`.
 * All component envelopes connect into this master so stop() can mute the
 * whole voice at once.
 */
function beginVoice(ctx, out, level = 1) {
  const master = gain(ctx, level);
  master.connect(out);
  return { ctx, master, level, sources: [] };
}

/** Register + auto-schedule a source so it never runs forever. */
function fire(v, src, when, dur) {
  src.start(when);
  try {
    src.stop(when + Math.max(0.01, dur));
  } catch (e) {
    /* offline / already stopped — ignore */
  }
  v.sources.push(src);
  return src;
}

/** Finish a voice: build the { stop, duration } return object. */
function finishVoice(v, when, duration) {
  const stop = (at) => {
    const t = typeof at === "number" ? at : when;
    try {
      const p = v.master.gain;
      p.cancelScheduledValues(t);
      p.setValueAtTime(v.level, t);
      p.linearRampToValueAtTime(0.0001, t + 0.06);
    } catch (e) {
      /* ignore */
    }
    for (const s of v.sources) {
      try {
        s.stop(t + 0.07);
      } catch (e) {
        /* already stopped — ignore */
      }
    }
  };
  return { stop, duration };
}

/**
 * Filtered noise burst into a voice master.
 * Chain: noise -> [highpass] -> [bandpass] -> [lowpass] -> env -> master.
 * Returns its audible duration (attack + decay + release).
 */
function noiseBurst(voice, when, cfg) {
  const ctx = voice.ctx;
  const attack = cfg.attack != null ? cfg.attack : 0.004;
  const decay = cfg.decay != null ? cfg.decay : 0.07;
  const sustain = cfg.sustain != null ? cfg.sustain : 0;
  const release = cfg.release != null ? cfg.release : 0.03;
  const hold = cfg.hold != null ? cfg.hold : 0;
  const dur = attack + decay + hold + release;

  const buf = noiseBuffer(ctx, dur + 0.08, cfg.color || "white");
  const src = noiseSource(ctx, buf, { playbackRate: cfg.rate != null ? cfg.rate : 1 });

  const chain = [src];
  if (cfg.hp != null) chain.push(filter(ctx, "highpass", cfg.hp, cfg.hpQ != null ? cfg.hpQ : 0.7));
  if (cfg.bp != null) chain.push(filter(ctx, "bandpass", cfg.bp, cfg.bpQ != null ? cfg.bpQ : 1));
  if (cfg.lp != null) chain.push(filter(ctx, "lowpass", cfg.lp, cfg.lpQ != null ? cfg.lpQ : 0.7));
  const env = envGain(ctx, when, { attack, decay, sustain, release, hold, peak: cfg.peak });
  chain.push(env, voice.master);
  connect(...chain);

  fire(voice, src, when, dur + 0.05);
  return dur;
}

/* ------------------------------------------------------------------ *
 * LEAVES — soft airy rustle: highpassed noise swish.
 * break is slightly longer/denser (a second offset swish layer).
 * ------------------------------------------------------------------ */

function leavesRustle(ctx, out, when, opts, cfg) {
  const rng = prng(opts);
  const v = cfg.step ? velGain(opts) : vel(opts);
  const voice = beginVoice(ctx, out, 1);
  let end = 0;

  // Main airy swish — highpassed white noise.
  end = Math.max(
    end,
    noiseBurst(voice, when, {
      color: "white",
      hp: rnd(rng, cfg.hpLo, cfg.hpHi),
      hpQ: 0.6,
      lp: 11000,
      lpQ: 0.6,
      attack: cfg.attack,
      decay: cfg.decay,
      sustain: cfg.sustain,
      release: cfg.release,
      peak: cfg.swishPeak * v,
      rate: rnd(rng, 0.92, 1.1),
    })
  );

  // Denser second swish layer (break only), slightly later and higher.
  if (cfg.dense) {
    const t2 = when + rnd(rng, 0.025, 0.05);
    end = Math.max(
      end + 0.05,
      noiseBurst(voice, t2, {
        color: "white",
        hp: rnd(rng, cfg.hpHi, cfg.hpHi + 1200),
        hpQ: 0.6,
        lp: 12000,
        lpQ: 0.6,
        attack: 0.006,
        decay: cfg.decay * 0.8,
        sustain: 0,
        release: cfg.release,
        peak: cfg.swishPeak * 0.65 * v,
        rate: rnd(rng, 1.0, 1.15),
      }) + (t2 - when)
    );
  }

  // Very soft dark body for a hint of weight.
  noiseBurst(voice, when, {
    color: "pink",
    lp: rnd(rng, 600, 800),
    lpQ: 0.7,
    attack: 0.005,
    decay: cfg.decay * 0.8,
    sustain: 0,
    release: 0.03,
    peak: cfg.bodyPeak * v,
  });

  return finishVoice(voice, when, Math.max(cfg.duration, end));
}

function breakLeaves(ctx, out, when, opts = {}) {
  return leavesRustle(ctx, out, when, opts, {
    duration: 0.24,
    hpLo: 2800,
    hpHi: 3600,
    attack: 0.006,
    decay: 0.12,
    sustain: 0.12,
    release: 0.07,
    swishPeak: 0.3,
    bodyPeak: 0.1,
    dense: true,
    step: false,
  });
}

function placeLeaves(ctx, out, when, opts = {}) {
  return leavesRustle(ctx, out, when, opts, {
    duration: 0.15,
    hpLo: 3000,
    hpHi: 3800,
    attack: 0.005,
    decay: 0.08,
    sustain: 0,
    release: 0.05,
    swishPeak: 0.24,
    bodyPeak: 0.08,
    dense: false,
    step: false,
  });
}

function stepLeaves(ctx, out, when, opts = {}) {
  return leavesRustle(ctx, out, when, opts, {
    duration: 0.11,
    hpLo: 3600,
    hpHi: 4800,
    attack: 0.004,
    decay: 0.06,
    sustain: 0,
    release: 0.035,
    swishPeak: 0.2, // highpassed white noise; actual peak ~0.15-0.2
    bodyPeak: 0.07,
    dense: false,
    step: true,
  });
}

/* ------------------------------------------------------------------ *
 * GRAVEL — crunchy granular: cluster of short rng-timed noise ticks
 * over a low brown-noise scrape.
 * ------------------------------------------------------------------ */

function gravelCrunch(ctx, out, when, opts, cfg) {
  const rng = prng(opts);
  const v = cfg.step ? velGain(opts) : vel(opts);
  // cfg.level: voice makeup gain — the narrow tick bandpasses + dark scrape
  // shed a lot of energy, leaving break/place well under family loudness.
  const voice = beginVoice(ctx, out, cfg.level != null ? cfg.level : 1);
  let end = 0;

  // Cluster of short, rng-timed bandpassed noise ticks (the "granular" part).
  const n = cfg.tickLo + Math.floor(rng() * (cfg.tickHi - cfg.tickLo + 1));
  let t = when;
  for (let i = 0; i < n; i++) {
    if (i > 0) t += rnd(rng, cfg.gapLo, cfg.gapHi);
    const d = noiseBurst(voice, t, {
      color: "white",
      bp: rnd(rng, 1100, 2600),
      bpQ: rnd(rng, 1.2, 2.2),
      lp: 6500,
      lpQ: 0.7,
      attack: 0.001,
      decay: rnd(rng, 0.015, 0.035),
      sustain: 0,
      release: 0.012,
      peak: rnd(rng, cfg.tickPeakLo, cfg.tickPeakHi) * v,
      rate: rnd(rng, 0.9, 1.15),
    });
    end = Math.max(end, t - when + d);
  }

  // Low gritty scrape underneath.
  end = Math.max(
    end,
    noiseBurst(voice, when, {
      color: "brown",
      lp: rnd(rng, 480, 660),
      lpQ: 0.7,
      attack: 0.008,
      decay: cfg.scrapeDecay,
      sustain: 0.12,
      release: 0.06,
      peak: cfg.scrapePeak * v, // brown + lowpass sheds energy; actual well below nominal
    })
  );

  return finishVoice(voice, when, Math.max(cfg.duration, end));
}

function breakGravel(ctx, out, when, opts = {}) {
  return gravelCrunch(ctx, out, when, opts, {
    duration: 0.28,
    tickLo: 6,
    tickHi: 8,
    gapLo: 0.014,
    gapHi: 0.038,
    tickPeakLo: 0.14,
    tickPeakHi: 0.22,
    scrapeDecay: 0.16,
    scrapePeak: 0.34,
    level: 1.7, // makeup: rendered peak ~0.15 without it — below break family
    step: false,
  });
}

function placeGravel(ctx, out, when, opts = {}) {
  return gravelCrunch(ctx, out, when, opts, {
    duration: 0.18,
    tickLo: 4,
    tickHi: 5,
    gapLo: 0.012,
    gapHi: 0.028,
    tickPeakLo: 0.12,
    tickPeakHi: 0.18,
    scrapeDecay: 0.1,
    scrapePeak: 0.3,
    level: 1.55, // makeup: rendered peak ~0.12 without it — below place family
    step: false,
  });
}

function stepGravel(ctx, out, when, opts = {}) {
  return gravelCrunch(ctx, out, when, opts, {
    duration: 0.13,
    tickLo: 3,
    tickHi: 4,
    gapLo: 0.01,
    gapHi: 0.024,
    tickPeakLo: 0.08,
    tickPeakHi: 0.13,
    scrapeDecay: 0.07,
    scrapePeak: 0.2,
    step: true,
  });
}

/* ------------------------------------------------------------------ *
 * SNOW — soft muffled crunch: heavily lowpassed noise + slight squeak.
 * ------------------------------------------------------------------ */

function snowCrunch(ctx, out, when, opts, cfg) {
  const rng = prng(opts);
  const v = cfg.step ? velGain(opts) : vel(opts);
  // cfg.level: voice makeup gain for variants the heavy lowpass leaves too quiet.
  const voice = beginVoice(ctx, out, cfg.level != null ? cfg.level : 1);
  let end = 0;

  // Muffled crunch body — brown noise through a heavy lowpass.
  end = Math.max(
    end,
    noiseBurst(voice, when, {
      color: "brown",
      lp: rnd(rng, cfg.lpLo, cfg.lpHi),
      lpQ: 0.7,
      attack: 0.004,
      decay: cfg.decay,
      sustain: 0.08,
      release: 0.045,
      peak: cfg.bodyPeak * v, // heavy lowpass sheds energy; actual well below nominal
      rate: rnd(rng, 0.9, 1.1),
    })
  );

  // Slight squeak — narrow bandpassed noise, a touch after the onset.
  const tSq = when + rnd(rng, 0.008, 0.02);
  end = Math.max(
    end,
    tSq -
      when +
      noiseBurst(voice, tSq, {
        color: "white",
        bp: rnd(rng, cfg.sqLo, cfg.sqHi),
        bpQ: rnd(rng, 4, 7),
        attack: 0.008,
        decay: cfg.sqDecay,
        sustain: 0,
        release: 0.03,
        peak: cfg.sqPeak * v,
        rate: rnd(rng, 0.95, 1.1),
      })
  );

  return finishVoice(voice, when, Math.max(cfg.duration, end));
}

function breakSnow(ctx, out, when, opts = {}) {
  return snowCrunch(ctx, out, when, opts, {
    duration: 0.2,
    lpLo: 380,
    lpHi: 500,
    decay: 0.12,
    bodyPeak: 0.5,
    sqLo: 1400,
    sqHi: 2000,
    sqDecay: 0.055,
    sqPeak: 0.09,
    step: false,
  });
}

function placeSnow(ctx, out, when, opts = {}) {
  return snowCrunch(ctx, out, when, opts, {
    duration: 0.13,
    lpLo: 330,
    lpHi: 430,
    decay: 0.08,
    bodyPeak: 0.45,
    sqLo: 1300,
    sqHi: 1800,
    sqDecay: 0.04,
    sqPeak: 0.06,
    level: 1.9, // makeup: rendered peak ~0.08 without it — half the quietest place
    step: false,
  });
}

function stepSnow(ctx, out, when, opts = {}) {
  return snowCrunch(ctx, out, when, opts, {
    duration: 0.12,
    lpLo: 380,
    lpHi: 520,
    decay: 0.075,
    bodyPeak: 0.42, // brown + heavy lowpass; actual ~0.15-0.25 (footstep range)
    sqLo: 1500,
    sqHi: 2200,
    sqDecay: 0.035,
    sqPeak: 0.05,
    step: true,
  });
}

/* ------------------------------------------------------------------ *
 * METAL — bright inharmonic clank: detuned non-integer partials
 * (800-3500Hz) summed through a shared bandpass + a click transient.
 * break rings longer; step is a light tick-clank.
 * ------------------------------------------------------------------ */

const METAL_RATIOS = [1, 1.79, 2.42, 3.17];

function metalClank(ctx, out, when, opts, cfg) {
  const rng = prng(opts);
  const v = cfg.step ? velGain(opts) : vel(opts);
  const voice = beginVoice(ctx, out, 1);

  // Shared bandpass shapes the summed partials into a "clank" band.
  const bp = filter(ctx, "bandpass", rnd(rng, 1500, 2100), 0.8);
  bp.connect(voice.master);

  // 2-4 detuned inharmonic partials, all kept within 800-3500Hz.
  const f0 = rnd(rng, cfg.f0Lo, cfg.f0Hi);
  for (let i = 0; i < cfg.partials; i++) {
    const f = Math.min(3500, f0 * METAL_RATIOS[i]);
    const type = i % 2 === 0 ? "triangle" : "sine";
    const o = osc(ctx, type, f, rnd(rng, -9, 9));
    const e = envGain(ctx, when, {
      attack: 0.001,
      decay: cfg.ring * rnd(rng, 0.85, 1.1),
      sustain: 0,
      release: cfg.release,
      peak: cfg.partialPeaks[i] * v,
    });
    connect(o, e, bp);
    fire(voice, o, when, cfg.ring * 1.1 + cfg.release + 0.05);
  }

  // Click transient — short bright noise snap straight into the master.
  noiseBurst(voice, when, {
    color: "white",
    bp: rnd(rng, 2500, 3300),
    bpQ: 1.2,
    hp: 1200,
    attack: 0.001,
    decay: 0.015,
    sustain: 0,
    release: 0.01,
    peak: cfg.clickPeak * v,
  });

  return finishVoice(voice, when, cfg.duration);
}

function breakMetal(ctx, out, when, opts = {}) {
  return metalClank(ctx, out, when, opts, {
    duration: 0.55,
    f0Lo: 900,
    f0Hi: 1100,
    partials: 4,
    partialPeaks: [0.3, 0.2, 0.15, 0.11],
    ring: 0.38, // longer ring on break
    release: 0.1,
    clickPeak: 0.22,
    step: false,
  });
}

function placeMetal(ctx, out, when, opts = {}) {
  return metalClank(ctx, out, when, opts, {
    duration: 0.24,
    f0Lo: 850,
    f0Hi: 1050,
    partials: 3,
    partialPeaks: [0.3, 0.18, 0.12],
    ring: 0.13,
    release: 0.05,
    clickPeak: 0.18,
    step: false,
  });
}

function stepMetal(ctx, out, when, opts = {}) {
  return metalClank(ctx, out, when, opts, {
    duration: 0.1,
    f0Lo: 950,
    f0Hi: 1250,
    partials: 2,
    partialPeaks: [0.16, 0.1], // light tick-clank, footstep-quiet
    ring: 0.055,
    release: 0.03,
    clickPeak: 0.1,
    step: true,
  });
}

/* ------------------------------------------------------------------ *
 * WOOL — very soft padded thump: dark lowpassed noise, fast decay,
 * quiet, with a tiny sub-thump for weight.
 * ------------------------------------------------------------------ */

function woolThump(ctx, out, when, opts, cfg) {
  const rng = prng(opts);
  const v = cfg.step ? velGain(opts) : vel(opts);
  const voice = beginVoice(ctx, out, 1);
  let end = 0;

  // Dark padded body — brown noise through a very low lowpass, fast decay.
  end = Math.max(
    end,
    noiseBurst(voice, when, {
      color: "brown",
      lp: rnd(rng, cfg.lpLo, cfg.lpHi),
      lpQ: 0.7,
      attack: 0.005,
      decay: cfg.decay,
      sustain: 0,
      release: 0.035,
      peak: cfg.bodyPeak * v, // very dark filtering; actual peak stays quiet
      rate: rnd(rng, 0.9, 1.08),
    })
  );

  // Tiny soft sub-thump.
  const thump = osc(ctx, "sine", 80);
  sweep(thump.frequency, when, rnd(rng, 82, 95), 55, 0.05, "exp");
  const thumpEnv = envGain(ctx, when, {
    attack: 0.004,
    decay: cfg.decay * 0.8,
    sustain: 0,
    release: 0.02,
    peak: cfg.thumpPeak * v,
  });
  connect(thump, thumpEnv, voice.master);
  fire(voice, thump, when, cfg.decay + 0.08);
  end = Math.max(end, cfg.decay + 0.08);

  return finishVoice(voice, when, Math.max(cfg.duration, end));
}

function breakWool(ctx, out, when, opts = {}) {
  return woolThump(ctx, out, when, opts, {
    duration: 0.15,
    lpLo: 420,
    lpHi: 540,
    decay: 0.085,
    bodyPeak: 0.42,
    thumpPeak: 0.1,
    step: false,
  });
}

function placeWool(ctx, out, when, opts = {}) {
  return woolThump(ctx, out, when, opts, {
    duration: 0.11,
    lpLo: 330,
    lpHi: 430,
    decay: 0.065,
    bodyPeak: 0.38,
    thumpPeak: 0.09,
    step: false,
  });
}

function stepWool(ctx, out, when, opts = {}) {
  return woolThump(ctx, out, when, opts, {
    duration: 0.09,
    lpLo: 300,
    lpHi: 400,
    decay: 0.05,
    bodyPeak: 0.34, // very dark; actual peak ~0.15 (quiet end of footstep range)
    thumpPeak: 0.07,
    step: true,
  });
}

/* ------------------------------------------------------------------ *
 * Registry (default export).
 * ------------------------------------------------------------------ */

export default {
  "break.leaves": breakLeaves,
  "break.gravel": breakGravel,
  "break.snow": breakSnow,
  "break.metal": breakMetal,
  "break.wool": breakWool,
  "place.leaves": placeLeaves,
  "place.gravel": placeGravel,
  "place.snow": placeSnow,
  "place.metal": placeMetal,
  "place.wool": placeWool,
  "step.leaves": stepLeaves,
  "step.gravel": stepGravel,
  "step.snow": stepSnow,
  "step.metal": stepMetal,
  "step.wool": stepWool,
};
