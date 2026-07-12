// audio/sfx/weather.js
// Weather SFX family. ES module, DEFAULT-exports a registry object mapping
// key -> synth(ctx, out, when, opts) => { stop(at), duration }.
//
// Keys: 'rain', 'thunder', 'thunder.distant'.
//   rain            — LOOPING rain: a dark lowpassed wash layer + a bright
//                     highpassed patter layer + individually rng-scheduled
//                     drop ticks. opts.intensity (0..1, default 0.7) scales
//                     drop density, brightness (filter cutoffs) and level.
//                     Returns { stop(at), duration: Infinity,
//                     setIntensity(v, ramp=0.5) }. ~3s of drop ticks are
//                     pre-scheduled relative to `when` so offline renders
//                     are never tick-less; a setTimeout loop takes over for
//                     live playback. stop(at) clears the timer, fades ~0.8s
//                     and stops every source.
//   thunder         — one-shot close thunder crack (~2.6-3.4s): sharp
//                     broadband darkening transient + sub-sine pitch thump +
//                     long undulating lowpassed rumble tail. Peak ~0.75.
//   thunder.distant — one-shot soft rolling rumble (~2-3s): no sharp
//                     transient, slow swelling lowpassed noise with a second
//                     offset swell and a faint sub sine. Peak ~0.2-0.4.
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

/** Clamp x into [0, 1]; non-numbers become the fallback. */
function clamp01(x, fallback = 0.7) {
  if (typeof x !== "number" || !isFinite(x)) return fallback;
  return x < 0 ? 0 : x > 1 ? 1 : x;
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

/** Linear-ramp an AudioParam from its current value to `target` over t..end. */
function rampTo(param, target, t, end) {
  try {
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(target, end);
  } catch (e) {
    try {
      param.value = target;
    } catch (e2) {
      /* ignore */
    }
  }
}

// --- rain (LOOPING) -----------------------------------------------------------

// intensity -> parameter maps. Levels are conservative so the sum of the two
// noise layers + drop ticks stays well under the 0.9 hard bound even at
// intensity 1 (uncorrelated noise; theoretical sum ~0.65 at i=1).
const rainMap = {
  washCutoff: (i) => 300 + 700 * i, // 300 .. 1000 Hz
  washLevel: (i) => 0.08 + 0.18 * i, // 0.08 .. 0.26
  patterCutoff: (i) => 2500 + 6500 * i, // 2500 .. 9000 Hz
  patterLevel: (i) => 0.04 + 0.22 * i, // 0.04 .. 0.26
  dropsPerSec: (i) => 2 + 16 * i, // 2 .. 18 ticks/s
  dropPeak: (i) => 0.05 + 0.07 * i, // 0.05 .. 0.12
};

// Looping rain. Layer 1 ("wash") is pink noise through a lowpass — the dull
// body of rain on ground/roof. Layer 2 ("patter") is white noise through a
// highpass + intensity-controlled lowpass — the bright hiss of many drops.
// Layer 3 is individual drop ticks: tiny bandpassed noise blips (and the
// occasional sine "plink") scheduled by rng. ~3s of ticks are pre-scheduled
// relative to `when` (offline-render safe); a timer loop continues live and
// only emits ticks after the pre-scheduled window to avoid doubling.
function rain(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vs = velOf(opts);
  let intensity = clamp01(opts.intensity != null ? opts.intensity : 0.7);

  const PRE = 3.2; // seconds of pre-scheduled drop ticks

  const fade = gain(ctx, 1);
  fade.connect(out);

  // --- layer 1: dark wash ---
  const washBuf = noiseBuffer(ctx, 2.5, "pink");
  const washSrc = noiseSource(ctx, washBuf, { loop: true });
  const washLp = filter(ctx, "lowpass", rainMap.washCutoff(intensity), 0.6);
  const washG = gain(ctx, rainMap.washLevel(intensity) * vs);
  connect(washSrc, washLp, washG, fade);

  // --- layer 2: bright patter ---
  const patBuf = noiseBuffer(ctx, 2.0, "white");
  const patSrc = noiseSource(ctx, patBuf, { loop: true });
  const patHp = filter(ctx, "highpass", 1800, 0.7);
  const patLp = filter(ctx, "lowpass", rainMap.patterCutoff(intensity), 0.7);
  const patG = gain(ctx, rainMap.patterLevel(intensity) * vs);
  connect(patSrc, patHp, patLp, patG, fade);

  // --- layer 3: individual drop ticks ---
  // Shared tiny noise buffer; each tick is a buffer source at a random
  // playback rate through its own bandpass + fast envelope.
  const tickBuf = noiseBuffer(ctx, 0.1, "white");
  const dropSources = [];
  let stopped = false;
  let timer = null;
  let dropCount = 0;

  function makeDrop(t) {
    if (stopped) return;
    dropCount++;
    const pk = rainMap.dropPeak(intensity) * (0.5 + 0.7 * rng()) * vs;
    if (dropCount % 6 === 0) {
      // occasional sine "plink" for character
      const f = 2400 + rng() * 2600; // 2400 .. 5000 Hz
      const o = osc(ctx, "sine", f);
      try {
        o.frequency.setValueAtTime(f, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(1, f * 0.7), t + 0.05);
      } catch (e) {
        /* ignore scheduling edge cases */
      }
      const e2 = envGain(ctx, t, {
        attack: 0.001,
        decay: 0.045,
        sustain: 0,
        release: 0.02,
        peak: pk * 0.8,
      });
      connect(o, e2, fade);
      try {
        o.start(t);
        o.stop(t + 0.12);
      } catch (er) {
        /* ignore */
      }
      dropSources.push(o);
    } else {
      const src = noiseSource(ctx, tickBuf, {
        playbackRate: 0.8 + rng() * 0.8,
      });
      const bp = filter(ctx, "bandpass", 3000 + rng() * 5000, 2.0);
      const e2 = envGain(ctx, t, {
        attack: 0.001,
        decay: 0.02 + rng() * 0.03,
        sustain: 0,
        release: 0.015,
        peak: pk,
      });
      connect(src, bp, e2, fade);
      try {
        src.start(t);
        src.stop(t + 0.12);
      } catch (er) {
        /* ignore */
      }
      dropSources.push(src);
    }
    // Prune the (long-finished) oldest sources so the array stays bounded.
    if (dropSources.length > 48) dropSources.splice(0, 24);
  }

  // Pre-schedule ~PRE seconds of ticks relative to `when` (offline safe).
  {
    let t = when + 0.02 + rng() * 0.05;
    while (t < when + PRE) {
      makeDrop(t);
      t += (1 / rainMap.dropsPerSec(intensity)) * (0.4 + 1.2 * rng());
    }
  }

  // Ongoing live scheduling via internal timer (real-time only; harmless
  // no-op under offline rendering, which completes before timers fire).
  // Ticks landing inside the pre-scheduled window are skipped to avoid
  // doubling. Density follows the current (possibly ramped) intensity.
  function scheduleNext() {
    if (stopped || typeof setTimeout !== "function") return;
    const wait =
      (1000 / rainMap.dropsPerSec(intensity)) * (0.4 + 1.2 * rng());
    timer = setTimeout(() => {
      if (stopped) return;
      const now =
        (typeof ctx.currentTime === "number" ? ctx.currentTime : 0) + 0.03;
      if (now >= when + PRE) makeDrop(now);
      scheduleNext();
    }, wait);
  }
  scheduleNext();

  washSrc.start(when);
  patSrc.start(when);
  const persistent = [washSrc, patSrc];

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
      for (const s of persistent.concat(dropSources)) {
        try {
          s.stop(end + 0.05);
        } catch (e) {
          /* ignore */
        }
      }
    },
    // Best-effort live intensity control: ramps levels and filter cutoffs
    // over `ramp` seconds; future rng-scheduled drop ticks follow the new
    // density (already pre-scheduled ticks are unaffected).
    setIntensity(v, ramp = 0.5) {
      intensity = clamp01(v, intensity);
      const t = Math.max(
        typeof ctx.currentTime === "number" ? ctx.currentTime : 0,
        when
      );
      const end = t + Math.max(0.01, ramp);
      rampTo(washG.gain, rainMap.washLevel(intensity) * vs, t, end);
      rampTo(patG.gain, rainMap.patterLevel(intensity) * vs, t, end);
      rampTo(washLp.frequency, rainMap.washCutoff(intensity), t, end);
      rampTo(patLp.frequency, rainMap.patterCutoff(intensity), t, end);
    },
  };
}

// --- thunder (close crack) ----------------------------------------------------

// One-shot close thunder (~2.6-3.4s, rng-varied). Three layers:
//   1) crack  — white noise through a highpass and a rapidly darkening lowpass,
//               near-instant attack. This is the sharp broadband transient.
//   2) thump  — a sub sine dropping 110 -> 38 Hz under the crack.
//   3) rumble — long brown-noise tail through a slowly closing lowpass, with an
//               rng-driven undulation gain (rolling echoes off terrain).
// Layer peaks are staggered in time so the instantaneous sum peaks ~0.75 at the
// crack and stays well below the 0.9 bound afterwards.
function thunder(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vs = velOf(opts);
  const dur = 2.6 + rng() * 0.8; // 2.6 .. 3.4s
  const sources = [];

  // 1) sharp broadband crack (fast, darkening)
  const cbuf = noiseBuffer(ctx, 0.8, "white");
  const csrc = noiseSource(ctx, cbuf, {});
  const chp = filter(ctx, "highpass", 250, 0.7);
  const clp = filter(ctx, "lowpass", 9000, 0.7);
  sweep(clp.frequency, when, 9000, 800, 0.5, "exp");
  const cEnv = envGain(ctx, when, {
    attack: 0.002,
    decay: 0.26,
    sustain: 0,
    release: 0.2,
    // 0.48 (not higher): with unlucky noise phase the crack + sub + rumble
    // onsets can align — 0.55 was measured peaking >0.9 on some seeds.
    peak: 0.48 * vs,
  });
  connect(csrc, chp, clp, cEnv, out);
  csrc.start(when);
  csrc.stop(when + 0.8);
  sources.push(csrc);

  // 2) sub thump under the crack
  const sub = osc(ctx, "sine", 110);
  sweep(sub.frequency, when, 110, 38, 0.9, "exp");
  const sEnv = envGain(ctx, when, {
    attack: 0.004,
    decay: 0.75,
    sustain: 0,
    release: 0.35,
    peak: 0.19 * vs,
  });
  connect(sub, sEnv, out);
  sub.start(when);
  sub.stop(when + 1.4);
  sources.push(sub);

  // 3) long rolling rumble tail
  const rbuf = noiseBuffer(ctx, dur + 0.6, "brown");
  const rsrc = noiseSource(ctx, rbuf, {});
  const rlp = filter(ctx, "lowpass", 170, 0.8);
  sweep(rlp.frequency, when + 0.3, 170, 65, dur - 0.6, "exp");
  // slower attack than the crack so the layers' peaks are staggered
  const hold = Math.max(0.1, dur - 0.05 - 0.8 - 1.2);
  const rEnv = envGain(ctx, when, {
    attack: 0.05,
    decay: 0.8,
    sustain: 0.55,
    hold,
    release: 1.2,
    peak: 0.36 * vs,
  });
  // rng undulation — rolling loudness of the tail
  const und = gain(ctx, 0.85);
  {
    const p = und.gain;
    p.setValueAtTime(0.85, when);
    let t = when + 0.25 + rng() * 0.2;
    while (t < when + dur) {
      p.linearRampToValueAtTime(0.5 + 0.5 * rng(), t);
      t += 0.25 + rng() * 0.35;
    }
    p.linearRampToValueAtTime(0.45, when + dur);
  }
  connect(rsrc, rlp, rEnv, und, out);
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

// --- thunder.distant ------------------------------------------------------------

// One-shot distant thunder (~2-3s, rng-varied). No sharp transient: just a slow
// swelling lowpassed brown-noise rumble with an rng undulation, a smaller
// offset second swell, and a very faint sub sine for body. Peak ~0.2-0.4.
function thunderDistant(ctx, out, when, opts = {}) {
  const rng = rngOf(opts);
  const vs = velOf(opts);
  const dur = 2.0 + rng() * 1.0; // 2 .. 3s
  const sources = [];

  // main swell
  const buf = noiseBuffer(ctx, dur + 0.6, "brown");
  const src = noiseSource(ctx, buf, {});
  const lp = filter(ctx, "lowpass", 130, 0.8);
  sweep(lp.frequency, when + 0.2, 130, 55, dur - 0.4, "exp");
  const hold = Math.max(0.05, dur - 0.35 - 0.5 - 1.0);
  const env = envGain(ctx, when, {
    attack: 0.35,
    decay: 0.5,
    sustain: 0.6,
    hold,
    release: 1.0,
    // nominal 0.38: brown noise + lowpass shed energy, rendered peak ~0.2
    peak: 0.38 * vs,
  });
  // rng undulation — the slow "rolling" quality
  const und = gain(ctx, 0.8);
  {
    const p = und.gain;
    p.setValueAtTime(0.8, when);
    let t = when + 0.3 + rng() * 0.3;
    while (t < when + dur) {
      p.linearRampToValueAtTime(0.5 + 0.5 * rng(), t);
      t += 0.3 + rng() * 0.45;
    }
    p.linearRampToValueAtTime(0.5, when + dur);
  }
  connect(src, lp, env, und, out);
  src.start(when);
  src.stop(when + dur + 0.2);
  sources.push(src);

  // smaller second swell, offset later — a farther echo of the same strike
  const t2 = when + 0.6 + rng() * 0.5;
  const buf2 = noiseBuffer(ctx, dur, "brown");
  const src2 = noiseSource(ctx, buf2, {});
  const lp2 = filter(ctx, "lowpass", 100, 0.8);
  const env2 = envGain(ctx, t2, {
    attack: 0.3,
    decay: 0.5,
    sustain: 0.4,
    hold: Math.max(0.05, dur * 0.3),
    release: 0.8,
    peak: 0.16 * vs,
  });
  connect(src2, lp2, env2, und, out);
  src2.start(t2);
  src2.stop(when + dur + 0.4);
  sources.push(src2);

  // faint sub body
  const sub = osc(ctx, "sine", 52);
  sweep(sub.frequency, when, 52, 36, dur * 0.8, "exp");
  const sEnv = envGain(ctx, when, {
    attack: 0.3,
    decay: 0.6,
    sustain: 0.4,
    hold: Math.max(0.05, dur - 0.3 - 0.6 - 0.9),
    release: 0.9,
    peak: 0.09 * vs,
  });
  connect(sub, sEnv, out);
  sub.start(when);
  sub.stop(when + dur + 0.2);
  sources.push(sub);

  return {
    duration: dur,
    stop(at) {
      stopSources(sources, at, when);
    },
  };
}

// --- registry ---------------------------------------------------------------

export default {
  rain,
  thunder,
  "thunder.distant": thunderDistant,
};
