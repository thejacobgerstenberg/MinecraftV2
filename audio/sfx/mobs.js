// audio/sfx/mobs.js
// Mob voice SFX family. ES module, DEFAULT-exports a registry object mapping
// key -> synth(ctx, out, when, opts) => { stop(at), duration }.
//
// 15 keys: mob.<arch>.<variant> for arch in {grazer, groaner, exploder,
// screecher, trader} and variant in {idle, hurt, death}.
//
// These are ORIGINAL creature voices (not imitations of any existing game):
//   grazer    — soft warm bleat-ish hum: detuned triangles through two parallel
//               formant bandpasses, gentle vibrato + slow bleat tremolo.
//   groaner   — slow low hostile groan: pitch-dropping sawtooth (+ sub sine)
//               through a dark lowpass, with a growly tremolo'd noise layer.
//   exploder  — idle: quiet menacing hiss; hurt: sharp hiss spike; death: fuse
//               sizzle (crackle ticks) ending in a small fizzle-pop (NOT a full
//               explosion — that lives under the separate 'explosion' key).
//   screecher — airy high screech: bandpassed noise + fast pitch-swept tone;
//               idle has a flappy fast tremolo, death slows and falls.
//   trader    — melodic murmuring hum: short rng-picked pentatonic hum
//               syllables (triangle+sine, vibrato, warm lowpass).
//
// Shared design: each archetype has ONE base voice function parameterized by
// variant. hurt = shorter / sharper / pitched-up take; death = longer /
// pitch-falling / fading take. All timing is relative to `when` (never
// ctx.currentTime) so everything renders under OfflineAudioContext. All
// randomness comes from opts.rng when provided, so calls are
// seed-deterministic. Loudness: idle peaks ~0.2-0.35, hurt/death ~0.35-0.55.

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

// --- small local helpers ----------------------------------------------------

/** Resolve a seeded PRNG from opts, else fall back to Math.random. */
function rngOf(opts) {
  return opts && typeof opts.rng === "function" ? opts.rng : Math.random;
}

/** Map velocity (0..1, default 1) to a gentle, still-audible level scale. */
function velOf(opts) {
  let v = opts && opts.velocity != null ? opts.velocity : 1;
  if (!(v >= 0)) v = 1;
  if (v > 1) v = 1;
  return 0.55 + 0.45 * v; // 0.55 .. 1.0
}

/** Stop a list of sources at `at` (or fall back to `when`); ignore errors. */
function stopSources(sources, at, when) {
  const t = typeof at === "number" ? at : when != null ? when : 0;
  for (const s of sources) {
    try {
      s.stop(t);
    } catch (e) {
      /* already stopped / not started — ignore */
    }
  }
}

/** Build the standard one-shot handle. */
function handle(sources, when, dur) {
  return {
    duration: dur,
    stop(at) {
      stopSources(sources, at, when);
    },
  };
}

/**
 * Exponential-ish pitch contour helper: hold at f0*fromMul, then glide to
 * f0*toMul over `seconds` starting at `when + delay`.
 */
function glide(param, when, f0, fromMul, toMul, seconds, delay = 0) {
  const t0 = when + delay;
  param.cancelScheduledValues(t0);
  param.setValueAtTime(Math.max(1e-3, f0 * fromMul), t0);
  param.exponentialRampToValueAtTime(Math.max(1e-3, f0 * toMul), t0 + seconds);
}

// =============================================================================
// grazer — soft warm bleat-ish hum
// =============================================================================
// Two detuned triangles -> pre-gain -> two parallel formant bandpasses
// (throat + mouth) -> bleat tremolo -> ADSR -> out. Vibrato LFO on detune.
function grazerVoice(ctx, out, when, opts, variant) {
  const rng = rngOf(opts);
  const vs = velOf(opts);
  const sources = [];

  // Per-variant character.
  const f0 = (150 + rng() * 26) * (variant === "hurt" ? 1.5 : variant === "death" ? 1.02 : 1);
  let dur, peak, vibRate, vibDepth, tremRate, attack;
  if (variant === "hurt") {
    dur = 0.26 + rng() * 0.08;
    peak = 0.45;
    vibRate = 9 + rng() * 2;
    vibDepth = 45;
    tremRate = 11;
    attack = 0.008;
  } else if (variant === "death") {
    dur = 1.25 + rng() * 0.25;
    peak = 0.4;
    vibRate = 5.5 + rng();
    vibDepth = 35;
    tremRate = 6.5;
    attack = 0.03;
  } else {
    dur = 0.6 + rng() * 0.18;
    peak = 0.28;
    vibRate = 6 + rng() * 1.5;
    vibDepth = 28;
    tremRate = 7.5;
    attack = 0.04;
  }

  const oA = osc(ctx, "triangle", f0, -9);
  const oB = osc(ctx, "triangle", f0, 9);

  // Pitch contour: a little upward "bleh" onset, then settle / fall.
  for (const o of [oA, oB]) {
    if (variant === "death") {
      // long fall: brief hold then slide down to ~0.55x, fading away.
      glide(o.frequency, when, f0, 1.0, 0.55, dur * 0.85, dur * 0.12);
    } else if (variant === "hurt") {
      // quick startled chirp up then slight drop.
      o.frequency.setValueAtTime(f0 * 0.9, when);
      o.frequency.exponentialRampToValueAtTime(f0 * 1.08, when + dur * 0.35);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.92, when + dur);
    } else {
      // gentle hump: up a touch, back down.
      o.frequency.setValueAtTime(f0 * 0.94, when);
      o.frequency.exponentialRampToValueAtTime(f0 * 1.04, when + dur * 0.4);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.9, when + dur);
    }
  }

  // Vibrato on detune (cents).
  const vib = osc(ctx, "sine", vibRate);
  const vibG = gain(ctx, vibDepth);
  connect(vib, vibG);
  vibG.connect(oA.detune);
  vibG.connect(oB.detune);

  // Mix + formants (throat ~ 3.2*f0, mouth ~ 7*f0 — warm, vowel-ish "baa").
  const pre = gain(ctx, 0.5);
  oA.connect(pre);
  oB.connect(pre);
  const form1 = filter(ctx, "bandpass", f0 * 3.2, 2.2);
  const form2 = filter(ctx, "bandpass", f0 * 7.0, 3.0);
  const f1g = gain(ctx, 0.85);
  const f2g = gain(ctx, 0.4);
  // Makeup gain: the 0.5 pre-gain + parallel bandpasses attenuate the summed
  // triangles ~7x (measured offline), so recover level here. Rendered peaks
  // land near: idle ~0.26, hurt ~0.41, death ~0.42 (envelope `peak` * ~6.5/7).
  const mix = gain(ctx, 6.5);
  connect(pre, form1, f1g, mix);
  connect(pre, form2, f2g, mix);

  // Bleat tremolo: base 0.75 +/- 0.25 wobble.
  const trem = gain(ctx, 0.75);
  const tremLfo = osc(ctx, "sine", tremRate);
  const tremDepth = gain(ctx, 0.25);
  connect(tremLfo, tremDepth);
  tremDepth.connect(trem.gain);

  const env = envGain(ctx, when, {
    attack,
    decay: dur * 0.55,
    sustain: variant === "death" ? 0.35 : 0.5,
    hold: dur * 0.2,
    release: dur * 0.25,
    peak: peak * vs,
  });
  connect(mix, trem, env, out);

  const tail = 0.1;
  for (const s of [oA, oB, vib, tremLfo]) {
    s.start(when);
    s.stop(when + dur + tail);
    sources.push(s);
  }
  return handle(sources, when, dur);
}

// =============================================================================
// groaner — slow low hostile groan
// =============================================================================
// Sawtooth (+ sub sine an octave down) with a falling pitch, through a dark
// lowpass, plus a growly brown-noise layer whose gain trembles at ~28 Hz.
function groanerVoice(ctx, out, when, opts, variant) {
  const rng = rngOf(opts);
  const vs = velOf(opts);
  const sources = [];

  const f0 = (78 + rng() * 14) * (variant === "hurt" ? 1.55 : 1);
  let dur, peak, fallTo, attack, lpFreq;
  if (variant === "hurt") {
    dur = 0.4 + rng() * 0.1;
    peak = 0.5;
    fallTo = 0.72;
    attack = 0.006;
    lpFreq = 620;
  } else if (variant === "death") {
    dur = 1.7 + rng() * 0.3;
    peak = 0.45;
    fallTo = 0.45;
    attack = 0.03;
    lpFreq = 420;
  } else {
    dur = 0.95 + rng() * 0.25;
    peak = 0.3;
    fallTo = 0.82;
    attack = 0.07;
    lpFreq = 430;
  }

  // Tonal core: saw + sub sine, both falling.
  const saw = osc(ctx, "sawtooth", f0, rng() * 8 - 4);
  const sub = osc(ctx, "sine", f0 * 0.5);
  glide(saw.frequency, when, f0, 1.0, fallTo, dur * 0.9, dur * 0.08);
  glide(sub.frequency, when, f0 * 0.5, 1.0, fallTo, dur * 0.9, dur * 0.08);

  // Slow menacing wobble on the saw pitch.
  const wob = osc(ctx, "sine", 3.2 + rng() * 1.2);
  const wobG = gain(ctx, 22); // cents
  connect(wob, wobG);
  wobG.connect(saw.detune);

  const sawG = gain(ctx, 0.6);
  const subG = gain(ctx, 0.45);
  const lp = filter(ctx, "lowpass", lpFreq, 1.4);
  if (variant === "death") {
    // voice darkens as it dies.
    sweep(lp.frequency, when + dur * 0.3, lpFreq, 180, dur * 0.6, "exp");
  }
  const tone = gain(ctx, 1);
  connect(saw, sawG, tone);
  connect(sub, subG, tone);

  // Growl: brown noise, lowpassed, gain trembling at growl rate (~28 Hz).
  const gbuf = noiseBuffer(ctx, 1.2, "brown");
  const gsrc = noiseSource(ctx, gbuf, { loop: true });
  const glp = filter(ctx, "lowpass", 340, 1.0);
  const growl = gain(ctx, 0.3);
  const growlLfo = osc(ctx, "sine", 26 + rng() * 6);
  const growlDepth = gain(ctx, 0.18);
  connect(growlLfo, growlDepth);
  growlDepth.connect(growl.gain);
  connect(gsrc, glp, growl, tone);

  const env = envGain(ctx, when, {
    attack,
    decay: dur * 0.4,
    sustain: variant === "death" ? 0.4 : 0.6,
    hold: dur * 0.3,
    release: dur * 0.3,
    peak: peak * vs,
  });
  connect(tone, lp, env, out);

  const tail = 0.12;
  for (const s of [saw, sub, wob, gsrc, growlLfo]) {
    s.start(when);
    s.stop(when + dur + tail);
    sources.push(s);
  }
  return handle(sources, when, dur);
}

// =============================================================================
// exploder — hiss / hiss-spike / fuse-sizzle + fizzle-pop
// =============================================================================
function exploderVoice(ctx, out, when, opts, variant) {
  const rng = rngOf(opts);
  const vs = velOf(opts);
  const sources = [];

  if (variant === "hurt") {
    // Sharp hiss spike: fast bright noise burst with a downward bandpass snap.
    const dur = 0.22 + rng() * 0.06;
    const buf = noiseBuffer(ctx, 0.4, "white");
    const src = noiseSource(ctx, buf, {});
    const bp = filter(ctx, "bandpass", 5200, 1.6);
    sweep(bp.frequency, when, 5800 + rng() * 800, 2400, dur, "exp");
    const env = envGain(ctx, when, {
      attack: 0.003,
      decay: dur * 0.7,
      sustain: 0,
      release: dur * 0.3,
      peak: 0.5 * vs,
    });
    connect(src, bp, env, out);
    src.start(when);
    src.stop(when + dur + 0.08);
    sources.push(src);
    return handle(sources, when, dur);
  }

  if (variant === "death") {
    // Fuse sizzle (~0.95s) ending in a small fizzle-pop. NOT a big explosion.
    const sizzleDur = 0.9 + rng() * 0.15;
    const popAt = when + sizzleDur;
    const dur = sizzleDur + 0.35;

    // Continuous sizzle bed: bright bandpassed noise, slowly intensifying.
    const bed = noiseSource(ctx, noiseBuffer(ctx, 1.4, "white"), { loop: true });
    const bbp = filter(ctx, "bandpass", 4200, 1.1);
    sweep(bbp.frequency, when, 3600, 5600, sizzleDur, "exp");
    const bedEnv = envGain(ctx, when, {
      attack: 0.02,
      decay: sizzleDur * 0.2,
      sustain: 0.85,
      hold: sizzleDur * 0.75,
      release: 0.06,
      peak: 0.26 * vs,
    });
    connect(bed, bbp, bedEnv, out);
    bed.start(when);
    bed.stop(popAt + 0.1);
    sources.push(bed);

    // Crackle ticks: short bright pips at rng times, denser near the end.
    const nTicks = 9;
    for (let i = 0; i < nTicks; i++) {
      const frac = (i + rng() * 0.8) / nTicks;
      const t = when + frac * frac * sizzleDur * 0.95; // quadratic -> denser late
      const tick = noiseSource(ctx, noiseBuffer(ctx, 0.03, "white"), {});
      const thp = filter(ctx, "highpass", 3000 + rng() * 2500, 1.2);
      const te = envGain(ctx, t, {
        attack: 0.001,
        decay: 0.02,
        sustain: 0,
        release: 0.01,
        peak: (0.16 + rng() * 0.12) * vs,
      });
      connect(tick, thp, te, out);
      tick.start(t);
      tick.stop(t + 0.05);
      sources.push(tick);
    }

    // Fizzle-pop: small dull thump (sine drop) + a short dark noise puff.
    const pop = osc(ctx, "sine", 260);
    sweep(pop.frequency, popAt, 260, 70, 0.09, "exp");
    const popEnv = envGain(ctx, popAt, {
      attack: 0.002,
      decay: 0.1,
      sustain: 0,
      release: 0.12,
      peak: 0.5 * vs,
    });
    connect(pop, popEnv, out);
    pop.start(popAt);
    pop.stop(popAt + 0.3);
    sources.push(pop);

    const puff = noiseSource(ctx, noiseBuffer(ctx, 0.3, "white"), {});
    const plp = filter(ctx, "lowpass", 1100, 0.8);
    const puffEnv = envGain(ctx, popAt, {
      attack: 0.003,
      decay: 0.12,
      sustain: 0,
      release: 0.15,
      peak: 0.3 * vs,
    });
    connect(puff, plp, puffEnv, out);
    puff.start(popAt);
    puff.stop(popAt + 0.35);
    sources.push(puff);

    return handle(sources, when, dur);
  }

  // idle — quiet menacing hiss: soft bright noise with a slow swell and an
  // uneasy shimmer wobble on the bandpass.
  const dur = 0.85 + rng() * 0.2;
  const src = noiseSource(ctx, noiseBuffer(ctx, 1.2, "white"), { loop: true });
  const bp = filter(ctx, "bandpass", 3800 + rng() * 600, 1.4);
  const wob = osc(ctx, "sine", 2.4 + rng() * 1.2);
  const wobG = gain(ctx, 700);
  connect(wob, wobG);
  wobG.connect(bp.frequency);
  const env = envGain(ctx, when, {
    attack: dur * 0.3,
    decay: dur * 0.3,
    sustain: 0.6,
    hold: dur * 0.15,
    release: dur * 0.25,
    peak: 0.2 * vs,
  });
  connect(src, bp, env, out);
  src.start(when);
  src.stop(when + dur + 0.1);
  wob.start(when);
  wob.stop(when + dur + 0.1);
  sources.push(src, wob);
  return handle(sources, when, dur);
}

// =============================================================================
// screecher — airy high screech
// =============================================================================
// Bandpassed white noise + a fast pitch-swept sawtooth "cry" tone; idle wears
// a flappy fast tremolo, hurt is a quick up-swept burst, death falls and slows.
function screecherVoice(ctx, out, when, opts, variant) {
  const rng = rngOf(opts);
  const vs = velOf(opts);
  const sources = [];

  let dur, peak, toneFrom, toneMid, toneTo, tremFrom, tremTo, attack;
  const j = 1 + (rng() - 0.5) * 0.12; // per-call pitch jitter
  if (variant === "hurt") {
    dur = 0.28 + rng() * 0.07;
    peak = 0.5;
    toneFrom = 750 * j; toneMid = 2350 * j; toneTo = 1900 * j;
    tremFrom = 18; tremTo = 18;
    attack = 0.004;
  } else if (variant === "death") {
    dur = 1.25 + rng() * 0.25;
    peak = 0.45;
    toneFrom = 1900 * j; toneMid = 1500 * j; toneTo = 380 * j;
    tremFrom = 13; tremTo = 4.5;
    attack = 0.015;
  } else {
    dur = 0.65 + rng() * 0.15;
    peak = 0.25;
    toneFrom = 950 * j; toneMid = 1500 * j; toneTo = 1050 * j;
    tremFrom = 12; tremTo = 12;
    attack = 0.03;
  }

  // Cry tone: thin sawtooth swept fast, softened by a tracking bandpass.
  const cry = osc(ctx, "sawtooth", toneFrom);
  cry.frequency.setValueAtTime(toneFrom, when);
  cry.frequency.exponentialRampToValueAtTime(toneMid, when + dur * 0.35);
  cry.frequency.exponentialRampToValueAtTime(Math.max(1, toneTo), when + dur);
  const cbp = filter(ctx, "bandpass", toneMid, 2.0);
  cbp.frequency.setValueAtTime(toneFrom * 1.1, when);
  cbp.frequency.exponentialRampToValueAtTime(toneMid * 1.1, when + dur * 0.35);
  cbp.frequency.exponentialRampToValueAtTime(Math.max(1, toneTo * 1.1), when + dur);
  const cryG = gain(ctx, 0.55);

  // Airy layer: high bandpassed noise following the same arc, gently.
  const air = noiseSource(ctx, noiseBuffer(ctx, Math.max(0.6, dur + 0.3), "white"), { loop: true });
  const abp = filter(ctx, "bandpass", 2800, 2.4);
  abp.frequency.setValueAtTime(2200 * j, when);
  abp.frequency.exponentialRampToValueAtTime(3400 * j, when + dur * 0.4);
  abp.frequency.exponentialRampToValueAtTime(1400 * j, when + dur);
  const airG = gain(ctx, 0.5);

  // Flappy tremolo (wing-beat feel): base 0.7 +/- 0.3.
  const trem = gain(ctx, 0.7);
  const tremLfo = osc(ctx, "sine", tremFrom);
  if (tremTo !== tremFrom) {
    tremLfo.frequency.setValueAtTime(tremFrom, when);
    tremLfo.frequency.exponentialRampToValueAtTime(tremTo, when + dur);
  }
  const tremDepth = gain(ctx, variant === "hurt" ? 0.15 : 0.3);
  connect(tremLfo, tremDepth);
  tremDepth.connect(trem.gain);

  const env = envGain(ctx, when, {
    attack,
    decay: dur * 0.45,
    sustain: variant === "death" ? 0.4 : 0.55,
    hold: dur * 0.25,
    release: dur * 0.3,
    peak: peak * vs,
  });

  // Makeup gain: both layers pass narrow bandpasses (Q 2-2.4) and a 0.7-base
  // tremolo, which sheds ~half the nominal level. x2 brings rendered peaks in
  // line with the other archetypes (~idle 0.2, hurt 0.4, death 0.45).
  const mix = gain(ctx, 2);
  connect(cry, cbp, cryG, mix);
  connect(air, abp, airG, mix);
  connect(mix, trem, env, out);

  const tail = 0.1;
  for (const s of [cry, air, tremLfo]) {
    s.start(when);
    s.stop(when + dur + tail);
    sources.push(s);
  }
  return handle(sources, when, dur);
}

// =============================================================================
// trader — melodic murmuring hum
// =============================================================================
// Short pentatonic hum syllables: triangle + soft sine an octave up, shared
// vibrato, warm lowpass, one little ADSR per syllable. rng picks degrees,
// lengths and gaps, so every murmur is different (but seed-deterministic).
const TRADER_SCALE = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3]; // major pentatonic ratios

function traderVoice(ctx, out, when, opts, variant) {
  const rng = rngOf(opts);
  const vs = velOf(opts);
  const sources = [];

  const base = (255 + rng() * 40) * (variant === "hurt" ? 1.5 : 1);

  // Build the syllable plan per variant.
  const syls = []; // { t, freq, len, peak }
  let dur;
  if (variant === "hurt") {
    // one short, sharp, high "mh!" that dips at the end.
    const len = 0.2 + rng() * 0.06;
    syls.push({
      t: when,
      freq: base * TRADER_SCALE[3 + Math.floor(rng() * 2)],
      len,
      peak: 0.45,
      bend: 0.85,
      attack: 0.006,
    });
    dur = len + 0.05;
  } else if (variant === "death") {
    // descending, slowing, fading murmur — 4 syllables walking down the scale.
    let t = when;
    let deg = 3 + Math.floor(rng() * 2); // start near the top
    const n = 4;
    for (let i = 0; i < n; i++) {
      const len = 0.22 + i * 0.08 + rng() * 0.05; // each longer than the last
      syls.push({
        t,
        freq: base * TRADER_SCALE[Math.max(0, deg)] * (i === n - 1 ? 0.5 : 1),
        len,
        peak: 0.4 * Math.pow(0.72, i), // each quieter
        bend: i === n - 1 ? 0.7 : 0.94,
        attack: 0.02,
      });
      t += len + 0.06 + i * 0.05 + rng() * 0.04;
      deg -= 1 + (rng() < 0.35 ? 1 : 0);
    }
    dur = t - when + 0.2;
  } else {
    // idle: 3 gentle murmured syllables on rng-picked pentatonic degrees.
    let t = when;
    const n = 3;
    for (let i = 0; i < n; i++) {
      const len = 0.16 + rng() * 0.12;
      syls.push({
        t,
        freq: base * TRADER_SCALE[Math.floor(rng() * TRADER_SCALE.length)],
        len,
        peak: 0.26 + rng() * 0.05,
        bend: 0.92 + rng() * 0.12, // tiny up or down inflection
        attack: 0.025,
      });
      t += len + 0.05 + rng() * 0.08;
    }
    dur = t - when + 0.1;
  }

  // Shared vibrato + warm lowpass bus.
  const vib = osc(ctx, "sine", 5.4 + rng() * 0.8);
  const vibG = gain(ctx, 14); // cents — gentle
  connect(vib, vibG);
  const lp = filter(ctx, "lowpass", 1500, 0.9);
  lp.connect(out);

  for (const s of syls) {
    const oT = osc(ctx, "triangle", s.freq);
    const oS = osc(ctx, "sine", s.freq * 2);
    // small end-of-syllable inflection.
    glide(oT.frequency, s.t, s.freq, 1.0, s.bend, s.len, s.len * 0.45);
    glide(oS.frequency, s.t, s.freq * 2, 1.0, s.bend, s.len, s.len * 0.45);
    vibG.connect(oT.detune);
    vibG.connect(oS.detune);
    const oSG = gain(ctx, 0.25); // octave shimmer sits behind the fundamental
    const env = envGain(ctx, s.t, {
      attack: s.attack,
      decay: s.len * 0.6,
      sustain: 0.45,
      hold: s.len * 0.2,
      release: s.len * 0.4 + 0.03,
      peak: s.peak * vs,
    });
    oT.connect(env);
    connect(oS, oSG, env);
    env.connect(lp);
    const end = s.t + s.len + 0.15;
    oT.start(s.t);
    oT.stop(end);
    oS.start(s.t);
    oS.stop(end);
    sources.push(oT, oS);
  }

  vib.start(when);
  vib.stop(when + dur + 0.1);
  sources.push(vib);

  return handle(sources, when, dur);
}

// --- registry ---------------------------------------------------------------

function entry(voiceFn, variant) {
  return (ctx, out, when, opts = {}) => voiceFn(ctx, out, when, opts, variant);
}

export default {
  "mob.grazer.idle": entry(grazerVoice, "idle"),
  "mob.grazer.hurt": entry(grazerVoice, "hurt"),
  "mob.grazer.death": entry(grazerVoice, "death"),

  "mob.groaner.idle": entry(groanerVoice, "idle"),
  "mob.groaner.hurt": entry(groanerVoice, "hurt"),
  "mob.groaner.death": entry(groanerVoice, "death"),

  "mob.exploder.idle": entry(exploderVoice, "idle"),
  "mob.exploder.hurt": entry(exploderVoice, "hurt"),
  "mob.exploder.death": entry(exploderVoice, "death"),

  "mob.screecher.idle": entry(screecherVoice, "idle"),
  "mob.screecher.hurt": entry(screecherVoice, "hurt"),
  "mob.screecher.death": entry(screecherVoice, "death"),

  "mob.trader.idle": entry(traderVoice, "idle"),
  "mob.trader.hurt": entry(traderVoice, "hurt"),
  "mob.trader.death": entry(traderVoice, "death"),
};
