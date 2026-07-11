// audio/sfx/extras.js
// "Extras" SFX family: doors, chest, consumables, jingles and the big boom.
// ES module, DEFAULT-exports a registry object mapping
//   key -> synth(ctx, out, when, opts) => { stop(at), duration }.
//
// Keys:
//   'door.open'   — rising hinge creak (~0.45s): pitch-up resonant filtered saw
//                   + friction noise, preceded by a tiny latch click.
//   'door.close'  — short falling thud + latch click (~0.32s).
//   'chest.open'  — slower, lower creak (~0.55s) ending in a soft lid stop.
//   'eat'         — 3 rhythmic munch chomps (~0.72s): short lowpassed noise
//                   bursts, rng pitch/level variation, soft low jaw thump.
//   'drink'       — 3 descending bubbly gulps (~0.82s): downward sine blips +
//                   tiny upward bubble + a whisper of liquid noise.
//   'levelup'     — bright ascending 4-note chime arpeggio (~0.95s). Fixed
//                   original note set: E5, A5, B5, E6 (sine/triangle bells
//                   with fast-decaying octave/inharmonic sparkle partials).
//   'achievement' — short original fanfare (~1.9s). Fixed original note set in
//                   Bb major: Bb4 Bb4 D5 F5 G5 melody, then a held
//                   Bb3+Bb4+D5+F5+Bb5 chord. Soft saw+triangle "brass" through
//                   a warm lowpass; gentle, not harsh.
//   'explosion'   — big boom (~2.4s): sub sine pitch-drop 120->35Hz +
//                   broadband noise burst + long lowpassed brown rumble tail.
//                   The whole mix passes a tanh soft-clip output stage whose
//                   curve tops out at 0.78 linear, so it can peak near the
//                   allowed 0.8 but can NEVER clip regardless of layer phase.
//
// Everything is scheduled relative to `when` (never ctx.currentTime) so it
// renders correctly under an OfflineAudioContext. All randomness goes through
// opts.rng when provided, so seeded calls are deterministic (note: the raw
// noise-buffer sample content from dsp.noiseBuffer uses Math.random internally,
// same as the phase-1 families — timing, pitches and levels are what the seed
// controls).

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

/** Stop a list of sources at `at` (or `when` if omitted); ignore errors. */
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

/**
 * softClipCurve — WaveShaper curve: y = maxOut * tanh(drive*x) / tanh(drive).
 * Output magnitude never exceeds maxOut, even for |input| > 1 (WaveShaperNode
 * clamps out-of-range input to the curve endpoints).
 */
function softClipCurve(maxOut = 0.78, drive = 1.6, n = 1024) {
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = (maxOut * Math.tanh(drive * x)) / norm;
  }
  return curve;
}

/** Tiny highpassed noise tick (latch clicks). Returns the source. */
function click(ctx, out, t, peak, hpFreq = 2300) {
  const buf = noiseBuffer(ctx, 0.08, "white");
  const src = noiseSource(ctx, buf, {});
  const hp = filter(ctx, "highpass", hpFreq, 1.3);
  const env = envGain(ctx, t, {
    attack: 0.001,
    decay: 0.028,
    sustain: 0,
    release: 0.02,
    peak,
  });
  connect(src, hp, env, out);
  src.start(t);
  src.stop(t + 0.1);
  return src;
}

/**
 * creak — shared hinge-creak core for door.open / chest.open.
 * Saw sweeping up through a resonant rising bandpass, with a fast triangle-LFO
 * amplitude wobble (the "grain" of the hinge) plus a friction-noise layer.
 * Returns the started source nodes.
 */
function creak(ctx, out, t0, len, cfg, rng, vs) {
  const sources = [];

  const saw = osc(ctx, "sawtooth", cfg.f0);
  sweep(saw.frequency, t0, cfg.f0, cfg.f1, len, "exp");
  const bp = filter(ctx, "bandpass", cfg.bp0, 8);
  sweep(bp.frequency, t0, cfg.bp0, cfg.bp1, len, "exp");

  const wobble = gain(ctx, 0.62);
  const lfo = osc(ctx, "triangle", cfg.wobHz + rng() * 4);
  const lfoDepth = gain(ctx, 0.3);
  connect(lfo, lfoDepth);
  lfoDepth.connect(wobble.gain);

  const env = envGain(ctx, t0, {
    attack: 0.03,
    decay: 0.12,
    sustain: 0.65,
    hold: Math.max(0, len - 0.2),
    release: 0.09,
    peak: cfg.peak * vs,
  });
  connect(saw, bp, wobble, env, out);

  // friction noise through its own rising bandpass
  const nbuf = noiseBuffer(ctx, len + 0.3, "white");
  const nsrc = noiseSource(ctx, nbuf, {});
  const nbp = filter(ctx, "bandpass", cfg.bp0 * 2.6, 3);
  sweep(nbp.frequency, t0, cfg.bp0 * 2.6, cfg.bp1 * 2.2, len, "exp");
  const nenv = envGain(ctx, t0, {
    attack: 0.03,
    decay: 0.15,
    sustain: 0.4,
    hold: Math.max(0, len - 0.22),
    release: 0.1,
    peak: cfg.peak * 0.32 * vs,
  });
  connect(nsrc, nbp, nenv, out);

  const end = t0 + len + 0.15;
  saw.start(t0);
  saw.stop(end);
  lfo.start(t0);
  lfo.stop(end);
  nsrc.start(t0);
  nsrc.stop(end);
  sources.push(saw, lfo, nsrc);
  return sources;
}

// --- door.open ----------------------------------------------------------------

// Latch click at `when`, then a ~0.36s rising hinge creak.
function doorOpen(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vs = velOf(opts);
  const dur = 0.45;
  const sources = [];

  sources.push(click(ctx, out, when, 0.24 * vs));
  sources.push(
    ...creak(
      ctx,
      out,
      when + 0.03,
      0.36,
      { f0: 70, f1: 150, bp0: 340, bp1: 980, wobHz: 9, peak: 0.34 },
      rng,
      vs
    )
  );

  return {
    duration: dur,
    stop(at) {
      stopSources(sources, at, when);
    },
  };
}

// --- door.close ---------------------------------------------------------------

// Falling thud (dropping sine + dark noise burst), latch click just after.
function doorClose(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vs = velOf(opts);
  const dur = 0.32;
  const sources = [];

  // 1) body thud — falling sine
  const thud = osc(ctx, "sine", 150);
  sweep(thud.frequency, when, 150, 58, 0.12, "exp");
  const tenv = envGain(ctx, when, {
    attack: 0.002,
    decay: 0.14,
    sustain: 0,
    release: 0.06,
    peak: 0.38 * vs,
  });
  connect(thud, tenv, out);
  thud.start(when);
  thud.stop(when + 0.28);
  sources.push(thud);

  // dark noise burst, lowpass falling with the thud
  const nbuf = noiseBuffer(ctx, 0.3, "white");
  const nsrc = noiseSource(ctx, nbuf, {});
  const lp = filter(ctx, "lowpass", 420, 0.8);
  sweep(lp.frequency, when, 420, 150, 0.15, "exp");
  const nenv = envGain(ctx, when, {
    attack: 0.002,
    decay: 0.1,
    sustain: 0,
    release: 0.05,
    peak: 0.28 * vs,
  });
  connect(nsrc, lp, nenv, out);
  nsrc.start(when);
  nsrc.stop(when + 0.25);
  sources.push(nsrc);

  // 2) latch click shortly after impact
  sources.push(click(ctx, out, when + 0.07 + rng() * 0.02, 0.2 * vs, 2600));

  return {
    duration: dur,
    stop(at) {
      stopSources(sources, at, when);
    },
  };
}

// --- chest.open ---------------------------------------------------------------

// Slower, lower creak than the door (~0.42s), ending in a soft lid stop.
function chestOpen(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vs = velOf(opts);
  const dur = 0.58;
  const sources = [];

  // Voice makeup bus: the low (48-96 Hz) saw through the narrow Q=8 creak
  // band sheds most of its energy, so without makeup the whole voice renders
  // ~0.14 peak vs ~0.37/0.40 for door.open/door.close. Bus x2.4 + nominal
  // creak peak 0.5 land the rendered peak around 0.2-0.25 (still the softest
  // of the door/chest family, as a chest lid should be).
  const bus = gain(ctx, 2.4);
  bus.connect(out);

  sources.push(
    ...creak(
      ctx,
      bus,
      when,
      0.42,
      { f0: 48, f1: 96, bp0: 210, bp1: 560, wobHz: 6.5, peak: 0.5 },
      rng,
      vs
    )
  );

  // soft lid stop — muffled thump + tiny low sine bump (through the same
  // makeup bus so the whole voice scales together; nominals shaved to keep
  // the lid at ~the creak's level)
  const ts = when + 0.44;
  const nbuf = noiseBuffer(ctx, 0.15, "white");
  const nsrc = noiseSource(ctx, nbuf, {});
  const lp = filter(ctx, "lowpass", 340, 0.9);
  const nenv = envGain(ctx, ts, {
    attack: 0.003,
    decay: 0.07,
    sustain: 0,
    release: 0.04,
    peak: 0.13 * vs,
  });
  connect(nsrc, lp, nenv, bus);
  nsrc.start(ts);
  nsrc.stop(ts + 0.14);
  sources.push(nsrc);

  const bump = osc(ctx, "sine", 88);
  sweep(bump.frequency, ts, 88, 55, 0.06, "exp");
  const benv = envGain(ctx, ts, {
    attack: 0.003,
    decay: 0.06,
    sustain: 0,
    release: 0.04,
    peak: 0.08 * vs,
  });
  connect(bump, benv, bus);
  bump.start(ts);
  bump.stop(ts + 0.14);
  sources.push(bump);

  return {
    duration: dur,
    stop(at) {
      stopSources(sources, at, when);
    },
  };
}

// --- eat ------------------------------------------------------------------------

// 3 rhythmic munch chomps: short lowpassed noise bursts with rng-varied
// brightness/level/timing, each over a soft low "jaw" thump. ~0.72s.
function eat(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vs = velOf(opts);
  const dur = 0.72;
  const sources = [];

  for (let i = 0; i < 3; i++) {
    const t = when + i * 0.24 + (i > 0 ? (rng() - 0.5) * 0.04 : 0);

    // chomp — noise burst through a falling lowpass
    const f0 = 700 + rng() * 500; // per-bite brightness 700..1200
    const buf = noiseBuffer(ctx, 0.2, "white");
    const src = noiseSource(ctx, buf, {});
    const lp = filter(ctx, "lowpass", f0, 1.4);
    sweep(lp.frequency, t, f0 + 400, 260, 0.09, "exp");
    const env = envGain(ctx, t, {
      attack: 0.004,
      decay: 0.09,
      sustain: 0,
      release: 0.05,
      peak: (0.24 + rng() * 0.08) * vs,
    });
    connect(src, lp, env, out);
    src.start(t);
    src.stop(t + 0.18);
    sources.push(src);

    // soft low jaw thump under each bite
    const jf = 130 + rng() * 30;
    const jaw = osc(ctx, "sine", jf);
    sweep(jaw.frequency, t, jf, 82, 0.07, "exp");
    const jenv = envGain(ctx, t, {
      attack: 0.003,
      decay: 0.06,
      sustain: 0,
      release: 0.04,
      peak: 0.12 * vs,
    });
    connect(jaw, jenv, out);
    jaw.start(t);
    jaw.stop(t + 0.15);
    sources.push(jaw);
  }

  return {
    duration: dur,
    stop(at) {
      stopSources(sources, at, when);
    },
  };
}

// --- drink ------------------------------------------------------------------------

// 3 descending bubbly gulps: downward sine blips (each gulp starts lower),
// a tiny upward "bubble" blip, and a whisper of bandpassed liquid noise. ~0.82s.
function drink(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vs = velOf(opts);
  const dur = 0.82;
  const sources = [];
  const bases = [520, 430, 350];

  for (let i = 0; i < 3; i++) {
    const t = when + i * 0.26 + (i > 0 ? (rng() - 0.5) * 0.03 : 0);
    const f0 = bases[i] * (0.95 + rng() * 0.1);

    // gulp blip — sine sweeping down
    const o = osc(ctx, "sine", f0);
    sweep(o.frequency, t, f0, f0 * 0.42, 0.13, "exp");
    const env = envGain(ctx, t, {
      attack: 0.006,
      decay: 0.11,
      sustain: 0,
      release: 0.05,
      peak: 0.28 * vs,
    });
    connect(o, env, out);
    o.start(t);
    o.stop(t + 0.22);
    sources.push(o);

    // tiny throat bubble — quick upward blip just after the gulp
    const tb = t + 0.06 + rng() * 0.05;
    const b = osc(ctx, "sine", f0 * 1.4);
    sweep(b.frequency, tb, f0 * 1.4, f0 * 2.1, 0.05, "exp");
    const benv = envGain(ctx, tb, {
      attack: 0.003,
      decay: 0.04,
      sustain: 0,
      release: 0.02,
      peak: 0.09 * vs,
    });
    connect(b, benv, out);
    b.start(tb);
    b.stop(tb + 0.1);
    sources.push(b);

    // whisper of liquid noise under the gulp
    const nbuf = noiseBuffer(ctx, 0.12, "white");
    const nsrc = noiseSource(ctx, nbuf, {});
    const nbp = filter(ctx, "bandpass", 1300, 2);
    const nenv = envGain(ctx, t, {
      attack: 0.004,
      decay: 0.05,
      sustain: 0,
      release: 0.03,
      peak: 0.07 * vs,
    });
    connect(nsrc, nbp, nenv, out);
    nsrc.start(t);
    nsrc.stop(t + 0.11);
    sources.push(nsrc);
  }

  return {
    duration: dur,
    stop(at) {
      stopSources(sources, at, when);
    },
  };
}

// --- levelup ------------------------------------------------------------------------

// Bright ascending 4-note chime arpeggio. Fixed ORIGINAL note set (a suspended
// A-major color, not borrowed from any game): E5, A5, B5, E6. Each note is a
// small additive bell: sine fundamental + quiet triangle body + fast-decaying
// octave and 3.02x inharmonic sparkle partials. Last note rings longer with a
// hint of detune shimmer. ~0.95s.
const LEVELUP_NOTES = [659.26, 880.0, 987.77, 1318.51]; // E5 A5 B5 E6

function levelup(ctx, out, when, opts = {}) {
  const vs = velOf(opts);
  const dur = 0.95;
  const sources = [];
  const step = 0.155;

  for (let i = 0; i < LEVELUP_NOTES.length; i++) {
    const f = LEVELUP_NOTES[i];
    const t = when + i * step;
    const last = i === LEVELUP_NOTES.length - 1;
    const decay = last ? 0.45 : 0.32;

    // fundamental — pure sine bell
    const o1 = osc(ctx, "sine", f);
    const e1 = envGain(ctx, t, {
      attack: 0.004,
      decay,
      sustain: 0,
      release: 0.08,
      peak: 0.24 * vs,
    });
    connect(o1, e1, out);

    // body — triangle adds warmth (last note lightly detuned for shimmer)
    const o2 = osc(ctx, "triangle", f, last ? 6 : 0);
    const e2 = envGain(ctx, t, {
      attack: 0.004,
      decay: decay * 0.8,
      sustain: 0,
      release: 0.08,
      peak: 0.1 * vs,
    });
    connect(o2, e2, out);

    // sparkle — octave + faint inharmonic partial, both decay fast
    const o3 = osc(ctx, "sine", f * 2);
    const e3 = envGain(ctx, t, {
      attack: 0.002,
      decay: 0.14,
      sustain: 0,
      release: 0.05,
      peak: 0.05 * vs,
    });
    connect(o3, e3, out);
    const o4 = osc(ctx, "sine", f * 3.02);
    const e4 = envGain(ctx, t, {
      attack: 0.002,
      decay: 0.09,
      sustain: 0,
      release: 0.04,
      peak: 0.025 * vs,
    });
    connect(o4, e4, out);

    const end = t + decay + 0.2;
    for (const o of [o1, o2, o3, o4]) {
      o.start(t);
      o.stop(end);
      sources.push(o);
    }
  }

  return {
    duration: dur,
    stop(at) {
      stopSources(sources, at, when);
    },
  };
}

// --- achievement ------------------------------------------------------------------------

// Short ORIGINAL fanfare (~1.9s), fixed note set in Bb major:
// melody Bb4, Bb4, D5, F5, G5 then a held Bb3+Bb4+D5+F5+Bb5 chord.
// Voice: soft sawtooth + triangle "brass" through a warm lowpass, gentle
// attack so it stays warm, never harsh. rng adds only tiny (deterministic)
// timing/detune humanization. Peak stays well under 0.6.
const ACH_MELODY = [
  // [freqHz, startSec, lengthSec]
  [466.16, 0.0, 0.13], // Bb4
  [466.16, 0.15, 0.13], // Bb4
  [587.33, 0.3, 0.13], // D5
  [698.46, 0.45, 0.17], // F5
  [783.99, 0.63, 0.2], // G5
];
const ACH_CHORD_START = 0.88;
const ACH_CHORD = [233.08, 466.16, 587.33, 698.46, 932.33]; // Bb3 Bb4 D5 F5 Bb5

function achievement(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vs = velOf(opts);
  const dur = 1.9;
  const sources = [];

  // shared warm "brass" bus
  const lp = filter(ctx, "lowpass", 1900, 0.7);
  lp.connect(out);

  function brass(f, t, len, level, release) {
    // tiny humanization — clamped to >= when so the first note (offset 0.0)
    // can never be scheduled at a negative time (envGain would throw on
    // cancelScheduledValues with a negative timestamp, e.g. when=0 offline)
    const jt = Math.max(when, t + (rng() - 0.5) * 0.012);
    const det = (rng() - 0.5) * 6; // +/- 3 cents
    const saw = osc(ctx, "sawtooth", f, det);
    const tri = osc(ctx, "triangle", f, -det);
    const sawG = gain(ctx, 0.35);
    const triG = gain(ctx, 0.75);
    saw.connect(sawG);
    tri.connect(triG);
    const env = envGain(ctx, jt, {
      attack: 0.02,
      decay: len * 0.35,
      sustain: 0.6,
      hold: len * 0.5,
      release,
      peak: level * vs,
    });
    sawG.connect(env);
    triG.connect(env);
    env.connect(lp);
    const end = jt + 0.02 + len * 0.85 + release + 0.1;
    saw.start(jt);
    saw.stop(end);
    tri.start(jt);
    tri.stop(end);
    sources.push(saw, tri);
  }

  // melody
  for (const [f, t, len] of ACH_MELODY) {
    brass(f, when + t, len, 0.16, 0.1);
  }

  // final held chord — bass a touch quieter so it stays clear
  for (let i = 0; i < ACH_CHORD.length; i++) {
    const level = i === 0 ? 0.07 : 0.085;
    brass(ACH_CHORD[i], when + ACH_CHORD_START, 0.55, level, 0.45);
  }

  return {
    duration: dur,
    stop(at) {
      stopSources(sources, at, when);
    },
  };
}

// --- explosion ------------------------------------------------------------------------

// Big boom (~2.4s): sub sine pitch-drop 120 -> 35 Hz, broadband noise burst
// through a falling lowpass, and a long lowpassed brown rumble tail. All three
// layers sum into a tanh soft-clip output stage whose curve tops out at 0.78
// linear, so the boom peaks near (but never over) the allowed 0.8 and cannot
// clip no matter how the random layers align.
function explosion(ctx, out, when, opts = {}) {
  const vs = velOf(opts);
  const dur = 2.4;
  const sources = [];

  const shaper = ctx.createWaveShaper();
  shaper.curve = softClipCurve(0.78, 1.6, 1024);
  shaper.oversample = "none";
  shaper.connect(out);

  const bus = gain(ctx, vs); // velocity drives the saturator harder/softer
  bus.connect(shaper);

  // 1) sub boom — sine dropping 120 -> 35 Hz
  const sub = osc(ctx, "sine", 120);
  sweep(sub.frequency, when, 120, 35, 0.55, "exp");
  const senv = envGain(ctx, when, {
    attack: 0.005,
    decay: 0.5,
    sustain: 0.25,
    hold: 0.25,
    release: 0.5,
    peak: 0.85,
  });
  connect(sub, senv, bus);
  sub.start(when);
  sub.stop(when + 1.6);
  sources.push(sub);

  // 2) broadband blast — white noise through a fast-falling lowpass
  const bbuf = noiseBuffer(ctx, 1.2, "white");
  const bsrc = noiseSource(ctx, bbuf, {});
  const blp = filter(ctx, "lowpass", 6000, 0.7);
  sweep(blp.frequency, when, 6000, 220, 0.7, "exp");
  const benv = envGain(ctx, when, {
    attack: 0.002,
    decay: 0.4,
    sustain: 0.12,
    hold: 0.15,
    release: 0.5,
    peak: 0.9,
  });
  connect(bsrc, blp, benv, bus);
  bsrc.start(when);
  bsrc.stop(when + 1.3);
  sources.push(bsrc);

  // 3) long lowpassed rumble tail — brown noise, slow swell, long decay
  const rbuf = noiseBuffer(ctx, 2.6, "brown");
  const rsrc = noiseSource(ctx, rbuf, {});
  const rlp = filter(ctx, "lowpass", 110, 0.6);
  const renv = envGain(ctx, when, {
    attack: 0.06,
    decay: 1.9,
    sustain: 0,
    release: 0.4,
    peak: 0.5,
  });
  connect(rsrc, rlp, renv, bus);
  rsrc.start(when);
  rsrc.stop(when + dur + 0.2);
  sources.push(rsrc);

  return {
    duration: dur,
    stop(at) {
      stopSources(sources, at, when);
    },
  };
}

// --- registry ---------------------------------------------------------------

export default {
  "door.open": doorOpen,
  "door.close": doorClose,
  "chest.open": chestOpen,
  eat,
  drink,
  levelup,
  achievement,
  explosion,
};
