// audio/sfx/blocks.js
// Block break/place sounds per material (stone, wood, dirt, grass, sand, glass).
// Each entry is a synth: (ctx, out, when, opts={}) => { stop(at), duration }.
// Everything is synthesized (oscillators + colored noise + envelopes/filters).
// All randomization uses opts.rng (seeded PRNG) so output is deterministic.

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

/** Uniform random in [lo, hi) using a seeded PRNG. */
function rnd(rng, lo, hi) {
  return lo + (hi - lo) * rng();
}

/**
 * Begin a voice: a single final GainNode routed into `out`.
 * All component envelopes connect into this master so stop() can mute the
 * whole voice at once. Returns a small handle used by the synth body.
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

/* ------------------------------------------------------------------ *
 * STONE — sharp filtered-noise crack + short low thud.
 * ------------------------------------------------------------------ */

function breakStone(ctx, out, when, opts = {}) {
  const rng = prng(opts);
  const v = vel(opts);
  const voice = beginVoice(ctx, out, 1);
  const duration = 0.26;

  // Low thud body — quick downward pitch drop.
  const thud = osc(ctx, "sine", 120);
  sweep(thud.frequency, when, 135, 68, 0.09, "exp");
  const thudEnv = envGain(ctx, when, {
    attack: 0.002,
    decay: 0.1,
    sustain: 0,
    release: 0.02,
    peak: 0.3 * v,
  });
  connect(thud, thudEnv, voice.master);
  fire(voice, thud, when, 0.16);

  // Bright sharp crack transient — high, filtered white noise.
  const crackBuf = noiseBuffer(ctx, 0.2, "white");
  const crack = noiseSource(ctx, crackBuf);
  const crackHp = filter(ctx, "highpass", rnd(rng, 1300, 1600), 0.7);
  const crackBp = filter(ctx, "bandpass", rnd(rng, 2300, 2900), 1.2);
  const crackEnv = envGain(ctx, when, {
    attack: 0.001,
    decay: 0.05,
    sustain: 0,
    release: 0.03,
    peak: 0.32 * v,
  });
  connect(crack, crackHp, crackBp, crackEnv, voice.master);
  fire(voice, crack, when, 0.12);

  // Tiny gravelly tail — brown noise, low-passed, slightly longer.
  const gravBuf = noiseBuffer(ctx, 0.3, "brown");
  const grav = noiseSource(ctx, gravBuf);
  const gravLp = filter(ctx, "lowpass", 950, 0.7);
  const gravEnv = envGain(ctx, when + 0.008, {
    attack: 0.01,
    decay: 0.14,
    sustain: 0.15,
    release: 0.08,
    peak: 0.13 * v,
  });
  connect(grav, gravLp, gravEnv, voice.master);
  fire(voice, grav, when + 0.008, 0.26);

  return finishVoice(voice, when, duration);
}

function placeStone(ctx, out, when, opts = {}) {
  const rng = prng(opts);
  const v = vel(opts);
  const voice = beginVoice(ctx, out, 1);
  const duration = 0.16;

  // Duller single knock — low thud.
  const thud = osc(ctx, "sine", 96);
  sweep(thud.frequency, when, 104, 62, 0.08, "exp");
  const thudEnv = envGain(ctx, when, {
    attack: 0.002,
    decay: 0.09,
    sustain: 0,
    release: 0.02,
    peak: 0.4 * v,
  });
  connect(thud, thudEnv, voice.master);
  fire(voice, thud, when, 0.15);

  // Soft, low-passed noise knock (no bright crack).
  const knockBuf = noiseBuffer(ctx, 0.16, "white");
  const knock = noiseSource(ctx, knockBuf);
  const knockLp = filter(ctx, "lowpass", rnd(rng, 1000, 1300), 0.7);
  const knockEnv = envGain(ctx, when, {
    attack: 0.001,
    decay: 0.04,
    sustain: 0,
    release: 0.02,
    peak: 0.2 * v,
  });
  connect(knock, knockLp, knockEnv, voice.master);
  fire(voice, knock, when, 0.1);

  return finishVoice(voice, when, duration);
}

/* ------------------------------------------------------------------ *
 * WOOD — resonant hollow knock (detuned decaying partials) + noise.
 * ------------------------------------------------------------------ */

function woodKnock(ctx, out, when, opts, cfg) {
  const rng = prng(opts);
  const v = vel(opts);
  const voice = beginVoice(ctx, out, 1);

  // Fundamental in the hollow-knock range 180-400Hz.
  const f1 = rnd(rng, cfg.fLo, cfg.fHi);
  const partials = [
    { f: f1, type: "sine", peak: cfg.p0, det: -6 },
    { f: f1 * 1.52, type: "triangle", peak: cfg.p1, det: 6 },
  ];
  if (cfg.thirdPartial) {
    partials.push({ f: f1 * 2.13, type: "sine", peak: cfg.p2, det: -3 });
  }
  for (const pt of partials) {
    const o = osc(ctx, pt.type, pt.f, pt.det);
    const e = envGain(ctx, when, {
      attack: 0.002,
      decay: cfg.decay,
      sustain: 0,
      release: cfg.release,
      peak: pt.peak * v,
    });
    connect(o, e, voice.master);
    fire(voice, o, when, cfg.decay + cfg.release + 0.05);
  }

  // Short noise attack — gives the knock its "tock" onset.
  const atkBuf = noiseBuffer(ctx, 0.06, "white");
  const atk = noiseSource(ctx, atkBuf);
  const atkBp = filter(ctx, "bandpass", cfg.attackFreq, 1.0);
  const atkEnv = envGain(ctx, when, {
    attack: 0.001,
    decay: 0.02,
    sustain: 0,
    release: 0.01,
    peak: 0.16 * v,
  });
  connect(atk, atkBp, atkEnv, voice.master);
  fire(voice, atk, when, 0.06);

  // Optional splintery high-passed noise burst (break only).
  if (cfg.splinter) {
    const spBuf = noiseBuffer(ctx, 0.14, "white");
    const sp = noiseSource(ctx, spBuf);
    const spHp = filter(ctx, "highpass", rnd(rng, 2800, 3400), 0.7);
    const spEnv = envGain(ctx, when + 0.004, {
      attack: 0.002,
      decay: 0.08,
      sustain: 0.1,
      release: 0.05,
      peak: 0.16 * v,
    });
    connect(sp, spHp, spEnv, voice.master);
    fire(voice, sp, when + 0.004, 0.14);
  }

  return finishVoice(voice, when, cfg.duration);
}

function breakWood(ctx, out, when, opts = {}) {
  return woodKnock(ctx, out, when, opts, {
    fLo: 200,
    fHi: 300,
    p0: 0.3,
    p1: 0.18,
    p2: 0.1,
    thirdPartial: true,
    decay: 0.14,
    release: 0.05,
    attackFreq: 1600,
    splinter: true,
    duration: 0.28,
  });
}

function placeWood(ctx, out, when, opts = {}) {
  return woodKnock(ctx, out, when, opts, {
    fLo: 180,
    fHi: 250,
    p0: 0.34,
    p1: 0.16,
    p2: 0.0,
    thirdPartial: false,
    decay: 0.1,
    release: 0.04,
    attackFreq: 1200,
    splinter: false,
    duration: 0.2,
  });
}

/* ------------------------------------------------------------------ *
 * DIRT — soft, muffled, low-passed noise thud.
 * ------------------------------------------------------------------ */

function dirtThud(ctx, out, when, opts, cfg) {
  const rng = prng(opts);
  const v = vel(opts);
  const voice = beginVoice(ctx, out, 1);

  // Muffled low-passed noise body.
  const bodyBuf = noiseBuffer(ctx, cfg.duration + 0.05, "brown");
  const body = noiseSource(ctx, bodyBuf);
  const bodyLp = filter(ctx, "lowpass", rnd(rng, cfg.lpLo, cfg.lpHi), 0.7);
  const bodyEnv = envGain(ctx, when, {
    attack: 0.003,
    decay: cfg.decay,
    sustain: 0.1,
    release: 0.04,
    peak: cfg.bodyPeak * v,
  });
  connect(body, bodyLp, bodyEnv, voice.master);
  fire(voice, body, when, cfg.duration + 0.05);

  // Very low soft thump for weight.
  const thump = osc(ctx, "sine", 82);
  sweep(thump.frequency, when, 90, 55, 0.06, "exp");
  const thumpEnv = envGain(ctx, when, {
    attack: 0.003,
    decay: 0.07,
    sustain: 0,
    release: 0.02,
    peak: 0.18 * v,
  });
  connect(thump, thumpEnv, voice.master);
  fire(voice, thump, when, 0.12);

  return finishVoice(voice, when, cfg.duration);
}

function breakDirt(ctx, out, when, opts = {}) {
  return dirtThud(ctx, out, when, opts, {
    duration: 0.17,
    lpLo: 650,
    lpHi: 800,
    decay: 0.1,
    bodyPeak: 0.42,
  });
}

function placeDirt(ctx, out, when, opts = {}) {
  return dirtThud(ctx, out, when, opts, {
    duration: 0.13,
    lpLo: 480,
    lpHi: 580,
    decay: 0.08,
    bodyPeak: 0.4,
  });
}

/* ------------------------------------------------------------------ *
 * GRASS — dirt-like thud + brighter rustly high-passed layer, softer.
 * ------------------------------------------------------------------ */

function grassStep(ctx, out, when, opts, cfg) {
  const rng = prng(opts);
  const v = vel(opts);
  const voice = beginVoice(ctx, out, 1);

  // Soft muffled body (dirt-like but quieter).
  const bodyBuf = noiseBuffer(ctx, cfg.duration + 0.05, "brown");
  const body = noiseSource(ctx, bodyBuf);
  const bodyLp = filter(ctx, "lowpass", 620, 0.7);
  const bodyEnv = envGain(ctx, when, {
    attack: 0.003,
    decay: cfg.decay,
    sustain: 0.08,
    release: 0.04,
    peak: cfg.bodyPeak * v,
  });
  connect(body, bodyLp, bodyEnv, voice.master);
  fire(voice, body, when, cfg.duration + 0.05);

  // Bright rustly high-passed layer — the "grassy" character.
  const rusBuf = noiseBuffer(ctx, cfg.duration + 0.05, "white");
  const rus = noiseSource(ctx, rusBuf);
  const rusHp = filter(ctx, "highpass", rnd(rng, cfg.hpLo, cfg.hpHi), 0.7);
  const rusEnv = envGain(ctx, when, {
    attack: 0.002,
    decay: cfg.rustleDecay,
    sustain: 0.15,
    release: 0.05,
    peak: cfg.rustlePeak * v,
  });
  connect(rus, rusHp, rusEnv, voice.master);
  fire(voice, rus, when, cfg.duration + 0.05);

  return finishVoice(voice, when, cfg.duration);
}

function breakGrass(ctx, out, when, opts = {}) {
  return grassStep(ctx, out, when, opts, {
    duration: 0.16,
    decay: 0.09,
    bodyPeak: 0.26,
    hpLo: 3800,
    hpHi: 4600,
    rustleDecay: 0.08,
    rustlePeak: 0.2,
  });
}

function placeGrass(ctx, out, when, opts = {}) {
  return grassStep(ctx, out, when, opts, {
    duration: 0.12,
    decay: 0.07,
    bodyPeak: 0.24,
    hpLo: 3200,
    hpHi: 3800,
    rustleDecay: 0.06,
    rustlePeak: 0.14,
  });
}

/* ------------------------------------------------------------------ *
 * SAND — very soft grainy shhh (band-passed noise, no tonal thud).
 * ------------------------------------------------------------------ */

function sandShhh(ctx, out, when, opts, cfg) {
  const rng = prng(opts);
  const v = vel(opts);
  const voice = beginVoice(ctx, out, 1);

  // Two lightly-detuned band-passed noise layers for a grainy texture.
  const center = rnd(rng, cfg.cLo, cfg.cHi);
  const layers = [
    { f: center, q: 0.9, peak: cfg.peak },
    { f: center * rnd(rng, 1.25, 1.6), q: 1.1, peak: cfg.peak * 0.6 },
  ];
  for (const l of layers) {
    const buf = noiseBuffer(ctx, cfg.duration + 0.05, "pink");
    const src = noiseSource(ctx, buf);
    const bp = filter(ctx, "bandpass", l.f, l.q);
    const e = envGain(ctx, when, {
      attack: 0.004,
      decay: cfg.decay,
      sustain: 0.2,
      release: 0.05,
      peak: l.peak * v,
    });
    connect(src, bp, e, voice.master);
    fire(voice, src, when, cfg.duration + 0.05);
  }

  return finishVoice(voice, when, cfg.duration);
}

function breakSand(ctx, out, when, opts = {}) {
  return sandShhh(ctx, out, when, opts, {
    duration: 0.16,
    cLo: 2400,
    cHi: 2900,
    decay: 0.09,
    peak: 1.0, // bandpassed pink noise loses ~4x energy; nominal high, actual ~0.23
  });
}

function placeSand(ctx, out, when, opts = {}) {
  return sandShhh(ctx, out, when, opts, {
    duration: 0.12,
    cLo: 1800,
    cHi: 2200,
    decay: 0.07,
    peak: 0.85, // bandpassed pink noise loses ~4x energy; actual ~0.20
  });
}

/* ------------------------------------------------------------------ *
 * GLASS — bright, tinkly. Break = cluster of pings + shatter noise;
 *         place = single soft high clink.
 * ------------------------------------------------------------------ */

function breakGlass(ctx, out, when, opts = {}) {
  const rng = prng(opts);
  const v = vel(opts);
  const voice = beginVoice(ctx, out, 1);

  // Cluster of short, high, randomized pings (1500-4000Hz).
  const n = 4 + Math.floor(rng() * 3); // 4..6 pings
  let t = when;
  let maxEnd = when;
  for (let i = 0; i < n; i++) {
    if (i > 0) t += rnd(rng, 0.012, 0.045);
    const freq = rnd(rng, 1500, 4000);
    const decay = rnd(rng, 0.08, 0.18);
    const peak = rnd(rng, 0.12, 0.2) * v;
    const type = rng() < 0.5 ? "sine" : "triangle";
    const o = osc(ctx, type, freq, rnd(rng, -8, 8));
    const e = envGain(ctx, t, {
      attack: 0.001,
      decay,
      sustain: 0,
      release: 0.03,
      peak,
    });
    connect(o, e, voice.master);
    fire(voice, o, t, decay + 0.05);
    maxEnd = Math.max(maxEnd, t + decay + 0.05);
  }

  // Bright shatter noise.
  const shBuf = noiseBuffer(ctx, 0.25, "white");
  const sh = noiseSource(ctx, shBuf);
  const shHp = filter(ctx, "highpass", 3000, 0.7);
  const shBp = filter(ctx, "bandpass", rnd(rng, 3800, 4600), 1.0);
  const shEnv = envGain(ctx, when, {
    attack: 0.001,
    decay: 0.12,
    sustain: 0.1,
    release: 0.08,
    peak: 0.16 * v,
  });
  connect(sh, shHp, shBp, shEnv, voice.master);
  fire(voice, sh, when, 0.24);
  maxEnd = Math.max(maxEnd, when + 0.24);

  return finishVoice(voice, when, maxEnd - when);
}

function placeGlass(ctx, out, when, opts = {}) {
  const rng = prng(opts);
  const v = vel(opts);
  const voice = beginVoice(ctx, out, 1);
  const duration = 0.18;

  // Single soft high clink — a tone plus a quiet octave partial.
  const freq = rnd(rng, 2200, 3200);
  const o1 = osc(ctx, "sine", freq);
  const e1 = envGain(ctx, when, {
    attack: 0.001,
    decay: 0.12,
    sustain: 0,
    release: 0.04,
    peak: 0.4 * v,
  });
  connect(o1, e1, voice.master);
  fire(voice, o1, when, 0.16);

  const o2 = osc(ctx, "triangle", freq * 2.01, 4);
  const e2 = envGain(ctx, when, {
    attack: 0.001,
    decay: 0.07,
    sustain: 0,
    release: 0.03,
    peak: 0.12 * v,
  });
  connect(o2, e2, voice.master);
  fire(voice, o2, when, 0.1);

  // Tiny high noise tick for the "t" of the clink.
  const tickBuf = noiseBuffer(ctx, 0.05, "white");
  const tick = noiseSource(ctx, tickBuf);
  const tickHp = filter(ctx, "highpass", 4000, 0.7);
  const tickEnv = envGain(ctx, when, {
    attack: 0.001,
    decay: 0.02,
    sustain: 0,
    release: 0.01,
    peak: 0.1 * v,
  });
  connect(tick, tickHp, tickEnv, voice.master);
  fire(voice, tick, when, 0.05);

  return finishVoice(voice, when, duration);
}

/* ------------------------------------------------------------------ *
 * Registry (default export).
 * ------------------------------------------------------------------ */

export default {
  "break.stone": breakStone,
  "break.wood": breakWood,
  "break.dirt": breakDirt,
  "break.grass": breakGrass,
  "break.sand": breakSand,
  "break.glass": breakGlass,
  "place.stone": placeStone,
  "place.wood": placeWood,
  "place.dirt": placeDirt,
  "place.grass": placeGrass,
  "place.sand": placeSand,
  "place.glass": placeGlass,
};
