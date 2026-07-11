// audio/discs.js
// Generative "music disc" tracks for the Web Audio engine. Dependency-free.
// NAMED exports: startUpbeat(engine, opts) / startMelancholy(engine, opts) /
// startMysterious(engine, opts).
// ORIGINAL compositions — nothing here reproduces any Minecraft/C418 melody;
// everything is procedurally generated from a seeded PRNG over abstract scales.
//
// Architecture mirrors audio/music.js exactly:
//   - each starter returns a controller { stop(fade = 2) };
//   - every voice routes through one internal group GainNode into engine.music;
//   - a lookahead setInterval scheduler keeps scheduling future bars for live
//     playback, AND the first ~8 seconds are scheduled synchronously at start
//     time so an OfflineAudioContext render (which never fires setInterval)
//     is non-silent;
//   - stop(fade) ramps the group gain down, stops all live sources, clears the
//     interval, and guards against double-stop.

import {
  mulberry32,
  noiseBuffer,
  noiseSource,
  osc,
  gain,
  filter,
  envGain,
  connect,
} from "./dsp.js";

// ---------------------------------------------------------------------------
// small helpers (same shapes as music.js)
// ---------------------------------------------------------------------------

/** MIDI note number -> frequency in Hz. */
function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** integer in [0, n) from a seeded rng. */
function randInt(rng, n) {
  return Math.floor(rng() * n) % n;
}

/** pick a random element of an array using rng. */
function pick(rng, arr) {
  return arr[randInt(rng, arr.length)];
}

// ---------------------------------------------------------------------------
// generic track scaffold: internal group gain, lookahead scheduler, sync
// prefill, and a guarded fade-out stop(). (Mirrors makeTrack in music.js.)
// ---------------------------------------------------------------------------

/**
 * @param {object} engine  AudioEngine (uses engine.ctx and engine.music)
 * @param {object} opts     { seed?, groupLevel? }
 * @param {()=>number} rng   seeded PRNG shared with planBar
 * @param {(ctx, group, when, barIndex, rng, addSource)=>number} planBar
 *        schedules one "bar" of music starting at `when` and returns the bar
 *        length in seconds.
 * @returns {{ stop:(fade?:number)=>void }}
 */
function makeTrack(engine, opts, rng, planBar) {
  const ctx = engine.ctx;
  const out = engine.music; // always a GainNode on the engine
  const groupLevel = opts.groupLevel != null ? opts.groupLevel : 0.8;

  // one group node all voices pass through — the fade handle.
  const group = gain(ctx, groupLevel);
  if (out && typeof group.connect === "function") group.connect(out);

  // track live source nodes so stop() can silence anything still playing.
  const sources = new Set();
  function addSource(node) {
    sources.add(node);
    // prune finished nodes during long live runs (harmless offline).
    try {
      node.onended = () => sources.delete(node);
    } catch (_e) {
      /* some environments disallow onended assignment; ignore */
    }
  }

  let stopped = false;
  let intervalId = null;
  let barIndex = 0;

  // anchor the timeline slightly ahead of "now" (offline: currentTime === 0).
  const t0 = (ctx.currentTime || 0) + 0.08;
  let nextBarTime = t0;

  const LOOKAHEAD = 2.0; // schedule notes up to this many seconds ahead of now
  const PREFILL = 8.0;   // synchronous fill window at start (offline safety)
  const MAX_BARS_PER_PUMP = 64; // guard against runaway scheduling

  function pump(horizon) {
    let guard = 0;
    while (nextBarTime < horizon && guard < MAX_BARS_PER_PUMP) {
      let barDur = 4;
      try {
        const d = planBar(ctx, group, nextBarTime, barIndex, rng, addSource);
        if (typeof d === "number" && isFinite(d) && d > 0.05) barDur = d;
      } catch (_e) {
        /* never let a bad note kill the scheduler */
      }
      nextBarTime += barDur;
      barIndex++;
      guard++;
    }
  }

  // (1) SYNCHRONOUS prefill — makes the first PREFILL seconds render offline.
  pump(t0 + PREFILL);

  // (2) LIVE lookahead — evolves the piece indefinitely until stop().
  if (typeof setInterval === "function") {
    intervalId = setInterval(() => {
      if (stopped) return;
      const now = ctx.currentTime || 0;
      pump(now + LOOKAHEAD);
    }, 250);
    // don't keep a Node process (offline verifier) alive on our account.
    if (intervalId && typeof intervalId.unref === "function") intervalId.unref();
  }

  function stop(fade = 2) {
    if (stopped) return; // guard against double-stop
    stopped = true;

    if (intervalId != null && typeof clearInterval === "function") {
      clearInterval(intervalId);
    }
    intervalId = null;

    const now = ctx.currentTime || 0;
    const f = Math.max(0.02, +fade || 0);

    // fade the whole group down, then hard-zero.
    try {
      const g = group.gain;
      const cur = Math.max(0.0001, g.value || groupLevel);
      g.cancelScheduledValues(now);
      g.setValueAtTime(cur, now);
      g.linearRampToValueAtTime(0.0001, now + f);
      g.setValueAtTime(0, now + f);
    } catch (_e) {
      /* ignore */
    }

    // stop every still-live source just after the fade completes.
    const stopAt = now + f + 0.05;
    for (const node of sources) {
      try {
        node.stop(stopAt);
      } catch (_e) {
        /* already stopped / never started — fine */
      }
    }
    sources.clear();

    // disconnect the group after the fade so we leave no dangling graph.
    if (typeof setTimeout === "function") {
      const tid = setTimeout(() => {
        try {
          group.disconnect();
        } catch (_e) {
          /* ignore */
        }
      }, (f + 0.25) * 1000);
      if (tid && typeof tid.unref === "function") tid.unref();
    }
  }

  return { stop };
}

// ---------------------------------------------------------------------------
// UPBEAT voices
// ---------------------------------------------------------------------------

/** Short bright pentatonic pluck — fast attack, quick decay. peak ~= level. */
function pluckVoice(ctx, group, when, freq, rng, addSource, level) {
  const g = envGain(ctx, when, {
    attack: 0.004,
    decay: 0.16 + rng() * 0.1,
    sustain: 0,
    release: 0.12,
    peak: level,
    hold: 0,
  });
  const lp = filter(ctx, "lowpass", 2200 + rng() * 1200, 0.8);
  const o = osc(ctx, "triangle", freq, (rng() * 2 - 1) * 6);
  connect(o, lp, g, group);

  const stopAt = when + 0.6;
  o.start(when);
  o.stop(stopAt);
  addSource(o);
}

/** Bouncy bass pulse — a sine with a tiny downward pitch dip. */
function bounceBassVoice(ctx, group, when, freq, rng, addSource, level) {
  const g = envGain(ctx, when, {
    attack: 0.006,
    decay: 0.14 + rng() * 0.06,
    sustain: 0,
    release: 0.1,
    peak: level,
    hold: 0,
  });
  const o = osc(ctx, "sine", freq * 1.12);
  try {
    o.frequency.setValueAtTime(freq * 1.12, when);
    o.frequency.exponentialRampToValueAtTime(freq, when + 0.07);
  } catch (_e) {
    /* ignore */
  }
  connect(o, g, group);

  const stopAt = when + 0.45;
  o.start(when);
  o.stop(stopAt);
  addSource(o);
}

/** Handclap-ish noise tick — short bandpassed white-noise burst. */
function clapVoice(ctx, group, when, rng, addSource, level) {
  const buf = noiseBuffer(ctx, 0.25, "white");
  const src = noiseSource(ctx, buf, {});
  const bp = filter(ctx, "bandpass", 1500 + rng() * 900, 1.4);
  const g = envGain(ctx, when, {
    attack: 0.002,
    decay: 0.05 + rng() * 0.03,
    sustain: 0,
    release: 0.05,
    peak: level,
    hold: 0,
  });
  connect(src, bp, g, group);

  const stopAt = when + 0.25;
  src.start(when);
  src.stop(stopAt);
  addSource(src);
}

// ---------------------------------------------------------------------------
// MELANCHOLY voices
// ---------------------------------------------------------------------------

/**
 * Piano-ish plucked sine — fundamental plus a quieter octave partial, both
 * with a long natural decay through a soft lowpass. peak ~= level.
 */
function sadPianoVoice(ctx, group, echoIn, when, freq, rng, addSource, level) {
  const g = envGain(ctx, when, {
    attack: 0.006,
    decay: 1.5 + rng() * 0.9,
    sustain: 0,
    release: 0.6,
    peak: level,
    hold: 0,
  });
  const lp = filter(ctx, "lowpass", 1800 + rng() * 600, 0.6);

  const stopAt = when + 3.4;

  const o1 = osc(ctx, "sine", freq, (rng() * 2 - 1) * 3);
  const o2 = osc(ctx, "sine", freq * 2, (rng() * 2 - 1) * 4);
  const octLevel = gain(ctx, 0.3);
  o1.connect(lp);
  connect(o2, octLevel, lp);
  connect(lp, g, echoIn || group);

  o1.start(when);
  o1.stop(stopAt);
  o2.start(when);
  o2.stop(stopAt);
  addSource(o1);
  addSource(o2);
}

/**
 * Build a gentle echo bus feeding `group`: dry passthrough plus a feedback
 * DelayNode (~0.3 feedback) wet path. Returns the bus input GainNode.
 */
function makeEchoBus(ctx, group) {
  const input = gain(ctx, 1);
  input.connect(group); // dry

  const delay = ctx.createDelay(1.5);
  delay.delayTime.value = 0.46;
  const fb = gain(ctx, 0.3);
  const wet = gain(ctx, 0.34);
  input.connect(delay);
  delay.connect(fb);
  fb.connect(delay); // feedback loop (< 1, so it decays)
  connect(delay, wet, group);

  return input;
}

// ---------------------------------------------------------------------------
// MYSTERIOUS voices
// ---------------------------------------------------------------------------

/** Soft FM bell — sine carrier, inharmonic sine modulator, long decay. */
function fmBellVoice(ctx, group, when, freq, rng, addSource, level) {
  const g = envGain(ctx, when, {
    attack: 0.01,
    decay: 1.1 + rng() * 0.9,
    sustain: 0,
    release: 0.9,
    peak: level,
    hold: 0,
  });

  const car = osc(ctx, "sine", freq);
  const ratio = 1.37 + rng() * 2.1; // inharmonic modulator ratio
  const mod = osc(ctx, "sine", freq * ratio);
  const modDepth = gain(ctx, freq * (1.2 + rng() * 2.2));
  mod.connect(modDepth);
  modDepth.connect(car.frequency);

  const lp = filter(ctx, "lowpass", 3600, 0.5);
  connect(car, lp, g, group);

  const stopAt = when + 3.2;
  car.start(when);
  car.stop(stopAt);
  mod.start(when);
  mod.stop(stopAt);
  addSource(car);
  addSource(mod);
}

/** Slow detuned pad swell — two triangles through a soft lowpass. */
function shimmerPadVoice(ctx, group, when, freq, holdDur, rng, addSource, level) {
  const attack = 1.8 + rng() * 1.0;
  const decay = 1.2;
  const release = 2.6 + rng() * 1.4;
  const hold = Math.max(0.3, holdDur);

  const g = envGain(ctx, when, {
    attack,
    decay,
    sustain: 0.8,
    release,
    peak: level,
    hold,
  });
  const lp = filter(ctx, "lowpass", 650 + rng() * 450, 0.7);

  const total = attack + decay + hold + release;
  const stopAt = when + total + 0.2;

  const o1 = osc(ctx, "triangle", freq, -7 - rng() * 5);
  const o2 = osc(ctx, "triangle", freq, 7 + rng() * 5);
  o1.connect(lp);
  o2.connect(lp);
  connect(lp, g, group);

  o1.start(when);
  o1.stop(stopAt);
  o2.start(when);
  o2.stop(stopAt);
  addSource(o1);
  addSource(o2);
}

// ---------------------------------------------------------------------------
// UPBEAT track
// ---------------------------------------------------------------------------

/**
 * startUpbeat — brighter and rhythmic: medium-tempo major-pentatonic plucks on
 * an eighth-note grid, a light bouncy bass pulse, and an occasional
 * handclap-ish noise tick on the backbeats. Cheerful but background (< 0.6).
 * @param {object} engine
 * @param {{seed?:number}} [opts]
 * @returns {{ stop:(fade?:number)=>void }}
 */
export function startUpbeat(engine, opts = {}) {
  const rng = mulberry32((opts.seed != null ? opts.seed : 7777) >>> 0);

  const penta = [0, 2, 4, 7, 9]; // major pentatonic degrees
  const state = { root: 57 + randInt(rng, 6) }; // A3..D4 area

  const PLUCK_LEVEL = 0.12;
  const BASS_LEVEL = 0.14;
  const CLAP_LEVEL = 0.08;

  const beat = 60 / 116; // ~0.517s — medium tempo
  const barDur = beat * 4;

  function planBar(ctx, group, when, barIndex, rng2, addSource) {
    // occasional root movement inside a friendly major-pentatonic orbit.
    if (barIndex > 0 && barIndex % 4 === 0 && rng2() < 0.6) {
      state.root += pick(rng2, [-5, -3, 0, 2, 4]);
      if (state.root < 55) state.root += 5;
      if (state.root > 65) state.root -= 5;
    }
    const root = state.root;

    // --- bouncy bass: beats 0 and 2, sometimes an off-beat eighth push.
    const bassMidi = root - 12;
    bounceBassVoice(ctx, group, when, midiToFreq(bassMidi), rng2, addSource, BASS_LEVEL);
    bounceBassVoice(ctx, group, when + 2 * beat, midiToFreq(bassMidi), rng2, addSource, BASS_LEVEL);
    if (rng2() < 0.4) {
      const off = pick(rng2, [1.5, 3.5]);
      bounceBassVoice(
        ctx, group, when + off * beat,
        midiToFreq(bassMidi + pick(rng2, [0, 7])),
        rng2, addSource, BASS_LEVEL * 0.7
      );
    }

    // --- melody plucks on the eighth-note grid (skip some slots for groove).
    let lastDeg = randInt(rng2, penta.length);
    for (let e = 0; e < 8; e++) {
      const play = e % 2 === 0 ? rng2() < 0.75 : rng2() < 0.4;
      if (!play) continue;
      // wander mostly stepwise along the pentatonic for singable lines.
      lastDeg += pick(rng2, [-1, -1, 0, 1, 1, 2]);
      if (lastDeg < 0) lastDeg += penta.length;
      lastDeg %= penta.length;
      const oct = 12 * (1 + (rng2() < 0.25 ? 1 : 0));
      const midi = root + penta[lastDeg] + oct;
      pluckVoice(ctx, group, when + e * 0.5 * beat, midiToFreq(midi), rng2, addSource, PLUCK_LEVEL);
    }

    // --- handclap-ish tick on beats 1 and 3, not every bar.
    if (rng2() < 0.7) clapVoice(ctx, group, when + 1 * beat, rng2, addSource, CLAP_LEVEL);
    if (rng2() < 0.7) clapVoice(ctx, group, when + 3 * beat, rng2, addSource, CLAP_LEVEL);

    return barDur;
  }

  return makeTrack(engine, { seed: opts.seed, groupLevel: 0.8 }, rng, planBar);
}

// ---------------------------------------------------------------------------
// MELANCHOLY track
// ---------------------------------------------------------------------------

/**
 * startMelancholy — slow minor key: sparse piano-ish decaying sines through a
 * gentle feedback echo, long silences, falling phrases. Wistful (< 0.55).
 * @param {object} engine
 * @param {{seed?:number}} [opts]
 * @returns {{ stop:(fade?:number)=>void }}
 */
export function startMelancholy(engine, opts = {}) {
  const rng = mulberry32((opts.seed != null ? opts.seed : 2468) >>> 0);

  const minor = [0, 2, 3, 5, 7, 10]; // natural-minor colour set
  const state = { root: 55 + randInt(rng, 5) }; // G3..B3 area
  let echoIn = null; // lazily-built echo bus (needs ctx + group)

  const NOTE_LEVEL = 0.13;
  const LOW_LEVEL = 0.1;

  function planBar(ctx, group, when, barIndex, rng2, addSource) {
    const barDur = 5.0 + rng2() * 2.0; // ~5-7s, slow with long silences

    if (!echoIn) echoIn = makeEchoBus(ctx, group);

    // slow, mostly-downward root drift.
    if (barIndex > 0 && rng2() < 0.3) {
      state.root += pick(rng2, [-4, -2, -2, 0, 3]);
      if (state.root < 50) state.root = 50 + randInt(rng2, 4);
      if (state.root > 62) state.root = 62;
    }
    const root = state.root;

    // some bars stay (almost) silent — space is part of the mood.
    if (barIndex > 0 && rng2() < 0.22) {
      if (rng2() < 0.5) {
        // just a lone low anchor note in the silence.
        sadPianoVoice(ctx, group, echoIn, when + rng2() * 1.5,
          midiToFreq(root - 12), rng2, addSource, LOW_LEVEL);
      }
      return barDur;
    }

    // a falling phrase: 2-4 notes stepping down through the minor scale.
    const n = 2 + randInt(rng2, 3);
    let degIdx = 2 + randInt(rng2, minor.length - 2); // start mid-high
    let t = when + 0.2 + rng2() * 1.2;
    for (let k = 0; k < n; k++) {
      const oct = 12 * (1 + (rng2() < 0.3 ? 1 : 0));
      const midi = root + minor[degIdx] + oct;
      sadPianoVoice(ctx, group, echoIn, t, midiToFreq(midi), rng2, addSource, NOTE_LEVEL);
      degIdx -= 1 + (rng2() < 0.3 ? 1 : 0); // fall
      if (degIdx < 0) degIdx += minor.length;
      t += 0.8 + rng2() * 1.1; // unhurried, uneven spacing
    }

    // occasional low root anchor under the phrase.
    if (rng2() < 0.5) {
      sadPianoVoice(ctx, group, echoIn, when + 0.1,
        midiToFreq(root - 12), rng2, addSource, LOW_LEVEL);
    }

    return barDur;
  }

  return makeTrack(engine, { seed: opts.seed, groupLevel: 0.8 }, rng, planBar);
}

// ---------------------------------------------------------------------------
// MYSTERIOUS track
// ---------------------------------------------------------------------------

/**
 * startMysterious — whole-tone shimmer: soft FM bells at irregular intervals
 * over slow detuned pad swells; unresolved, spacious, strange (< 0.55).
 * @param {object} engine
 * @param {{seed?:number}} [opts]
 * @returns {{ stop:(fade?:number)=>void }}
 */
export function startMysterious(engine, opts = {}) {
  const rng = mulberry32((opts.seed != null ? opts.seed : 13579) >>> 0);

  const wholeTone = [0, 2, 4, 6, 8, 10]; // never resolves
  const state = { root: 50 + randInt(rng, 6) }; // D3..G3 area

  const BELL_LEVEL = 0.11;
  const PAD_LEVEL = 0.05;

  function planBar(ctx, group, when, barIndex, rng2, addSource) {
    const barDur = 5.5 + rng2() * 2.5; // ~5.5-8s, irregular

    // drift the root by whole steps / tritones — stays unresolved by design.
    if (barIndex > 0 && rng2() < 0.4) {
      state.root += pick(rng2, [-6, -4, -2, 2, 4, 6]);
      if (state.root < 46) state.root += 12;
      if (state.root > 58) state.root -= 12;
    }
    const root = state.root;

    // --- slow pad swell: root + a whole-tone colour (2nd, tritone, or aug 5th).
    if (barIndex % 2 === 0 || rng2() < 0.35) {
      shimmerPadVoice(ctx, group, when, midiToFreq(root), barDur * 1.2, rng2, addSource, PAD_LEVEL);
      const colour = pick(rng2, [2, 6, 8]);
      shimmerPadVoice(ctx, group, when + rng2() * 0.8,
        midiToFreq(root + colour + 12), barDur * 1.0, rng2, addSource, PAD_LEVEL);
    }

    // --- FM bells at irregular moments, 1-3 per bar, high whole-tone notes.
    const nBells = 1 + randInt(rng2, 3);
    for (let k = 0; k < nBells; k++) {
      const t = when + rng2() * barDur * 0.9;
      const deg = pick(rng2, wholeTone);
      const oct = 12 * (2 + randInt(rng2, 2));
      fmBellVoice(ctx, group, t, midiToFreq(root + deg + oct), rng2, addSource, BELL_LEVEL);
    }

    return barDur;
  }

  return makeTrack(engine, { seed: opts.seed, groupLevel: 0.8 }, rng, planBar);
}
