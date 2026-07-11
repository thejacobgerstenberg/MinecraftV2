// audio/sfx/environment.js
// Environment / ambience SFX family. ES module, DEFAULT-exports a registry
// object mapping key -> synth(ctx, out, when, opts) => { stop(at), duration }.
//
// Keys: 'splash', 'wind', 'cave', 'portal'.
//   splash — one-shot water plunk (~450ms): pitch-dropping bandpassed noise +
//            a short bubbly resonant blip.
//   wind   — LOOPING wind: slowly LFO-modulated filtered brown noise (gusts on
//            both a lowpass cutoff and a gain). stop(at) ramps to 0 over ~0.8s.
//   cave   — LOOPING cave: very low sparse drone + faint low rumble + occasional
//            randomized distant drips scheduled via an internal timer (rng).
//            stop(at) clears the timer and ramps down over ~0.8s.
//   portal — one-shot whoosh (~1.2s): detuned rising/falling osc+noise sweep
//            through a shimmery bandpass with a feedback DelayNode tail.
//
// Everything is scheduled relative to `when` (never ctx.currentTime) for the
// deterministic, offline-renderable portion. All randomness uses opts.rng when
// present so seeded renders are reproducible. Works with an OfflineAudioContext.

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

/** Ramp a fade gain (constant, un-automated) to 0 over `seconds` from `t`. */
function fadeOut(fadeGain, t, seconds) {
  const p = fadeGain.gain;
  const end = t + seconds;
  p.cancelScheduledValues(t);
  p.setValueAtTime(p.value, t);
  p.linearRampToValueAtTime(0.0001, end);
  p.setValueAtTime(0, end);
  return end;
}

// --- splash -----------------------------------------------------------------

// One-shot water plunk. A downward bandpass sweep on white noise gives the
// "ploonk", a pitch-dropping sine adds the watery body, and 1-2 tiny bubbles
// (randomized via rng) sparkle on top. ~0.45s.
function splash(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vs = velOf(opts);
  const sources = [];
  const dur = 0.45;

  // 1) pitch-dropping bandpassed noise plunk
  const nbuf = noiseBuffer(ctx, 0.6, "white");
  const nsrc = noiseSource(ctx, nbuf, {});
  const bp = filter(ctx, "bandpass", 1400, 3.2);
  sweep(bp.frequency, when, 1400, 260, 0.32, "exp");
  const nEnv = envGain(ctx, when, {
    attack: 0.006,
    decay: 0.14,
    sustain: 0,
    release: 0.16,
    peak: 0.55 * vs,
  });
  connect(nsrc, bp, nEnv, out);
  nsrc.start(when);
  nsrc.stop(when + dur + 0.1);
  sources.push(nsrc);

  // 2) watery body — a sine dropping in pitch
  const body = osc(ctx, "sine", 700);
  sweep(body.frequency, when, 700, 300, 0.2, "exp");
  const bEnv = envGain(ctx, when, {
    attack: 0.004,
    decay: 0.13,
    sustain: 0,
    release: 0.08,
    peak: 0.34 * vs,
  });
  connect(body, bEnv, out);
  body.start(when);
  body.stop(when + 0.32);
  sources.push(body);

  // 3) a couple of tiny randomized bubbles
  const nBub = 2;
  for (let i = 0; i < nBub; i++) {
    const t = when + 0.04 + rng() * 0.22;
    const f = 520 + rng() * 720; // 520 .. 1240
    const ob = osc(ctx, "sine", f);
    sweep(ob.frequency, t, f, f * 0.6, 0.06, "exp");
    const be = envGain(ctx, t, {
      attack: 0.002,
      decay: 0.05,
      sustain: 0,
      release: 0.03,
      peak: 0.14 * vs,
    });
    connect(ob, be, out);
    ob.start(t);
    ob.stop(t + 0.12);
    sources.push(ob);
  }

  return {
    duration: dur,
    stop(at) {
      stopSources(sources, at, when);
    },
  };
}

// --- wind (LOOPING) ---------------------------------------------------------

// Looping ambient wind. Brown noise -> highpass (kill sub-rumble) -> lowpass
// whose cutoff is swept by a slow LFO -> a gain whose value is swept by a second
// slower LFO (the gusts) -> a fade gain into `out`. Gentle: peak ~0.2-0.25.
function wind(ctx, out, when, opts = {}) {
  const vs = velOf(opts);

  const buf = noiseBuffer(ctx, 2.5, "brown");
  const src = noiseSource(ctx, buf, { loop: true });

  const hp = filter(ctx, "highpass", 60, 0.7);
  const lp = filter(ctx, "lowpass", 480, 0.8);

  // LFO 1 -> lowpass cutoff: 480 +/- 240 => 240..720 Hz
  const lfoF = osc(ctx, "sine", 0.08);
  const lfoFDepth = gain(ctx, 240);
  connect(lfoF, lfoFDepth);
  lfoFDepth.connect(lp.frequency);

  // Gust gain: base 0.32 +/- 0.16 (LFO 2) => 0.16..0.48
  const gust = gain(ctx, 0.32 * vs);
  const lfoG = osc(ctx, "sine", 0.05);
  const lfoGDepth = gain(ctx, 0.16 * vs);
  connect(lfoG, lfoGDepth);
  lfoGDepth.connect(gust.gain);

  const fade = gain(ctx, 1);
  connect(src, hp, lp, gust, fade, out);

  src.start(when);
  lfoF.start(when);
  lfoG.start(when);

  const nodes = [src, lfoF, lfoG];

  return {
    duration: Infinity,
    stop(at) {
      const t = typeof at === "number" ? at : ctx.currentTime || when || 0;
      const end = fadeOut(fade, t, 0.8);
      for (const n of nodes) {
        try {
          n.stop(end + 0.05);
        } catch (e) {
          /* ignore */
        }
      }
    },
  };
}

// --- cave (LOOPING) ---------------------------------------------------------

// Looping cave ambience. Two detuned very-low sines form a breathing drone,
// a faint lowpassed brown-noise rumble sits underneath, and short resonant
// sine "drips" are scheduled — a couple pre-scheduled relative to `when` so
// offline renders always contain drips, plus an ongoing setTimeout loop (rng)
// for live playback. Eerie and quiet: drone ~0.1, drips ~0.18. stop() clears
// the timer and fades the whole thing out over ~0.8s.
function cave(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vs = velOf(opts);

  const fade = gain(ctx, 1);
  fade.connect(out);

  // --- low breathing drone: two detuned low sines ---
  const o1 = osc(ctx, "sine", 60, -4);
  const o2 = osc(ctx, "sine", 90, 6);
  const droneBus = gain(ctx, 0.045 * vs);
  const breath = osc(ctx, "sine", 0.1);
  const breathDepth = gain(ctx, 0.012 * vs);
  connect(breath, breathDepth);
  breathDepth.connect(droneBus.gain);
  o1.connect(droneBus);
  o2.connect(droneBus);
  droneBus.connect(fade);

  // --- faint low rumble ---
  const rbuf = noiseBuffer(ctx, 2.5, "brown");
  const rsrc = noiseSource(ctx, rbuf, { loop: true });
  const rlp = filter(ctx, "lowpass", 110, 0.7);
  const rgain = gain(ctx, 0.05 * vs);
  connect(rsrc, rlp, rgain, fade);

  // --- drips ---
  const dripSources = [];
  let stopped = false;
  let timer = null;

  function makeDrip(t) {
    if (stopped) return;
    const f = 640 + rng() * 900; // 640 .. 1540 Hz
    const o = osc(ctx, "sine", f);
    try {
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(1, f * 0.82), t + 0.25);
    } catch (e) {
      /* ignore scheduling edge cases */
    }
    const lp = filter(ctx, "lowpass", 2600, 0.9);
    const e = envGain(ctx, t, {
      attack: 0.002,
      decay: 0.4,
      sustain: 0,
      release: 0.05,
      peak: 0.18 * vs,
    });
    connect(o, lp, e, fade);
    try {
      o.start(t);
      o.stop(t + 0.6);
    } catch (er) {
      /* ignore */
    }
    dripSources.push(o);
  }

  // Pre-schedule a couple relative to `when` so offline renders have drips.
  makeDrip(when + 0.5);
  makeDrip(when + 1.25);

  // Ongoing live scheduling via internal timer (real-time only; harmless
  // no-op under offline rendering, which completes before timers fire).
  function scheduleNext() {
    if (stopped || typeof setTimeout !== "function") return;
    const wait = 700 + rng() * 1800; // 0.7 .. 2.5s
    timer = setTimeout(() => {
      if (stopped) return;
      const now = (typeof ctx.currentTime === "number" ? ctx.currentTime : 0) + 0.03;
      makeDrip(now);
      scheduleNext();
    }, wait);
  }
  scheduleNext();

  o1.start(when);
  o2.start(when);
  breath.start(when);
  rsrc.start(when);

  const persistent = [o1, o2, breath, rsrc];

  return {
    duration: Infinity,
    stop(at) {
      stopped = true;
      if (timer != null && typeof clearTimeout === "function") {
        clearTimeout(timer);
        timer = null;
      }
      const t = typeof at === "number" ? at : ctx.currentTime || when || 0;
      const end = fadeOut(fade, t, 0.8);
      for (const s of persistent.concat(dripSources)) {
        try {
          s.stop(end + 0.05);
        } catch (e) {
          /* ignore */
        }
      }
    },
  };
}

// --- portal -----------------------------------------------------------------

// One-shot otherworldly whoosh (~1.2s). Two detuned sawtooths and a bandpassed
// noise layer all sweep up then back down; the mix passes a moving "shimmer"
// bandpass and an ADSR that rises and falls, then feeds a DelayNode with
// feedback for a shimmery, spacey tail.
function portal(ctx, out, when, opts = {}) {
  const vs = velOf(opts);
  const sources = [];
  const dur = 1.2;
  const tail = 0.7; // delay ring-out beyond the body

  // Rise-then-fall envelope for the whole whoosh.
  const env = envGain(ctx, when, {
    attack: 0.28,
    decay: 0.5,
    sustain: 0.5,
    release: 0.42,
    peak: 0.5 * vs,
    hold: 0,
  });

  // Moving shimmer bandpass on the mix.
  const shimmer = filter(ctx, "bandpass", 700, 2.5);
  shimmer.frequency.setValueAtTime(300, when);
  shimmer.frequency.exponentialRampToValueAtTime(1600, when + 0.5);
  shimmer.frequency.exponentialRampToValueAtTime(500, when + 1.15);

  // Detuned sawtooths sweeping up then down.
  const oA = osc(ctx, "sawtooth", 180, -12);
  const oB = osc(ctx, "sawtooth", 180, 14);
  const oGain = gain(ctx, 0.45);
  for (const o of [oA, oB]) {
    o.frequency.setValueAtTime(180, when);
    o.frequency.exponentialRampToValueAtTime(880, when + 0.5);
    o.frequency.exponentialRampToValueAtTime(300, when + 1.15);
  }
  connect(oA, oGain);
  oB.connect(oGain);

  // Airy noise layer with its own sweeping bandpass.
  const nbuf = noiseBuffer(ctx, 2.0, "white");
  const nsrc = noiseSource(ctx, nbuf, {});
  const nbp = filter(ctx, "bandpass", 800, 1.2);
  nbp.frequency.setValueAtTime(400, when);
  nbp.frequency.exponentialRampToValueAtTime(2200, when + 0.5);
  nbp.frequency.exponentialRampToValueAtTime(600, when + 1.15);
  const nGain = gain(ctx, 0.28);
  connect(nsrc, nbp, nGain);

  // Mix -> shimmer -> env.
  oGain.connect(shimmer);
  nGain.connect(shimmer);
  connect(shimmer, env);

  // Dry path.
  env.connect(out);

  // Wet feedback-delay path for the otherworldly tail.
  const delay = ctx.createDelay(1.0);
  delay.delayTime.value = 0.18;
  const fb = gain(ctx, 0.33);
  const wet = gain(ctx, 0.26 * vs);
  env.connect(delay);
  delay.connect(fb);
  fb.connect(delay); // feedback loop (fb < 1 so it decays)
  connect(delay, wet, out);

  oA.start(when);
  oA.stop(when + dur + tail);
  oB.start(when);
  oB.stop(when + dur + tail);
  nsrc.start(when);
  nsrc.stop(when + dur + tail);
  sources.push(oA, oB, nsrc);

  return {
    duration: dur,
    stop(at) {
      stopSources(sources, at, when);
    },
  };
}

// --- registry ---------------------------------------------------------------

export default {
  splash,
  wind,
  cave,
  portal,
};
