// audio/music.js
// Generative, dependency-free browser music for the Web Audio engine.
// NAMED exports: startCalm(engine, opts) / startNether(engine, opts).
// ORIGINAL composition — this does not reproduce any Minecraft/C418 melody;
// everything is procedurally generated from a seeded PRNG over abstract scales.
//
// Both starters return a controller { stop(fade = 2) } and route every voice
// through one internal group GainNode into engine.music (engine.ctx is the
// AudioContext, live or Offline). A lookahead scheduler (setInterval) keeps
// scheduling future notes for live playback; the FIRST several seconds are ALSO
// scheduled synchronously at start time so an OfflineAudioContext render (which
// never fires setInterval) is non-silent.

import { mulberry32, osc, gain, filter, envGain, connect } from "./dsp.js";

// ---------------------------------------------------------------------------
// small helpers
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
// prefill, and a guarded fade-out stop().
// ---------------------------------------------------------------------------

/**
 * @param {object} engine  AudioEngine (uses engine.ctx and engine.music)
 * @param {object} opts     { seed?, fade? }
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
// CALM voices
// ---------------------------------------------------------------------------

/**
 * Long, soft, detuned pad note with a slow LFO wobble on its lowpass.
 * peak ~= PAD_LEVEL. Two sine/triangle oscillators for width.
 */
function padVoice(ctx, group, when, freq, holdDur, rng, addSource, level) {
  const attack = 1.4 + rng() * 0.6;
  const decay = 1.0;
  const release = 2.8 + rng() * 1.2;
  const hold = Math.max(0.3, holdDur);

  const g = envGain(ctx, when, {
    attack,
    decay,
    sustain: 0.85,
    release,
    peak: level,
    hold,
  });

  const cutoff = 700 + rng() * 500;
  const lp = filter(ctx, "lowpass", cutoff, 0.7);

  // slow LFO opening/closing the filter for gentle motion.
  const lfo = osc(ctx, "sine", 0.05 + rng() * 0.06);
  const lfoGain = gain(ctx, 120 + rng() * 120);
  lfo.connect(lfoGain);
  lfoGain.connect(lp.frequency);

  const total = attack + decay + hold + release;
  const stopAt = when + total + 0.2;

  const detunes = [-6 - rng() * 4, 6 + rng() * 4];
  for (const d of detunes) {
    const o = osc(ctx, rng() < 0.5 ? "sine" : "triangle", freq, d);
    o.connect(lp);
    o.start(when);
    o.stop(stopAt);
    addSource(o);
  }

  connect(lp, g, group);

  lfo.start(when);
  lfo.stop(stopAt);
  addSource(lfo);
}

/** Sparse wandering arpeggio note (single triangle voice). peak ~= level. */
function arpVoice(ctx, group, when, freq, rng, addSource, level) {
  const hold = 0.4 + rng() * 0.8;
  const attack = 0.12 + rng() * 0.12;
  const decay = 0.35;
  const release = 0.8 + rng() * 0.6;

  const g = envGain(ctx, when, {
    attack,
    decay,
    sustain: 0.4,
    release,
    peak: level,
    hold,
  });
  const lp = filter(ctx, "lowpass", 1500 + rng() * 800, 0.6);
  const o = osc(ctx, "triangle", freq, (rng() * 2 - 1) * 5);
  o.connect(lp);
  connect(lp, g, group);

  const stopAt = when + attack + decay + hold + release + 0.2;
  o.start(when);
  o.stop(stopAt);
  addSource(o);
}

// ---------------------------------------------------------------------------
// NETHER voices
// ---------------------------------------------------------------------------

/** Very low, slow sustained drone. Dark, quiet, overlapping bar to bar. */
function droneVoice(ctx, group, when, freq, holdDur, rng, addSource, level) {
  const attack = 1.8 + rng() * 0.8;
  const decay = 1.5;
  const release = 3.0 + rng() * 1.5;
  const hold = Math.max(0.3, holdDur);

  const g = envGain(ctx, when, {
    attack,
    decay,
    sustain: 0.9,
    release,
    peak: level,
    hold,
  });
  const lp = filter(ctx, "lowpass", 320 + rng() * 160, 0.9);

  const total = attack + decay + hold + release;
  const stopAt = when + total + 0.2;

  const o1 = osc(ctx, "sine", freq, -3 - rng() * 3);
  const o2 = osc(ctx, "triangle", freq, 3 + rng() * 3);
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

/** Sparse low-mid minor melodic fragment note. */
function netherMelodyVoice(ctx, group, when, freq, rng, addSource, level) {
  const hold = 0.5 + rng() * 1.0;
  const attack = 0.3 + rng() * 0.3;
  const decay = 0.5;
  const release = 1.2 + rng() * 0.8;

  const g = envGain(ctx, when, {
    attack,
    decay,
    sustain: 0.35,
    release,
    peak: level,
    hold,
  });
  const lp = filter(ctx, "lowpass", 1000 + rng() * 500, 0.7);
  const o = osc(ctx, rng() < 0.5 ? "sine" : "triangle", freq, (rng() * 2 - 1) * 4);
  o.connect(lp);
  connect(lp, g, group);

  const stopAt = when + attack + decay + hold + release + 0.2;
  o.start(when);
  o.stop(stopAt);
  addSource(o);
}

/** Occasional metallic / inharmonic FM clang, bandpassed. Short. */
function clangVoice(ctx, group, when, baseFreq, rng, addSource, level) {
  const decay = 0.4 + rng() * 0.4;
  const release = 0.35 + rng() * 0.3;

  const g = envGain(ctx, when, {
    attack: 0.002,
    decay,
    sustain: 0.0,
    release,
    peak: level,
    hold: 0,
  });

  const bp = filter(ctx, "bandpass", baseFreq * (2.5 + rng() * 2), 2 + rng() * 3);

  const car = osc(ctx, "sine", baseFreq);
  const mod = osc(ctx, "sine", baseFreq * (2.4 + rng() * 3.2)); // inharmonic ratio
  const modDepth = gain(ctx, baseFreq * (2 + rng() * 4));
  mod.connect(modDepth);
  modDepth.connect(car.frequency);

  car.connect(bp);
  connect(bp, g, group);

  const stopAt = when + 0.002 + decay + release + 0.2;
  car.start(when);
  car.stop(stopAt);
  mod.start(when);
  mod.stop(stopAt);
  addSource(car);
  addSource(mod);
}

// ---------------------------------------------------------------------------
// CALM track
// ---------------------------------------------------------------------------

/**
 * startCalm — slow, sparse, consonant major-pentatonic pads + wandering arps.
 * @param {object} engine
 * @param {{seed?:number}} [opts]
 * @returns {{ stop:(fade?:number)=>void }}
 */
export function startCalm(engine, opts = {}) {
  const rng = mulberry32((opts.seed != null ? opts.seed : 1234) >>> 0);

  // major pentatonic degrees.
  const penta = [0, 2, 4, 7, 9];
  const state = { root: 48 + randInt(rng, 8) }; // C3..G3 area

  const PAD_LEVEL = 0.06;
  const ARP_LEVEL = 0.11;

  function planBar(ctx, group, when, barIndex, rng2, addSource) {
    const barDur = 4.8 + rng2() * 1.8; // ~4.8-6.6s, slow with lots of space

    // gentle harmonic evolution: nudge the root along the pentatonic now & then.
    if (barIndex > 0 && rng2() < 0.35) {
      const step = pick(rng2, [-7, -5, 0, 2, 4, 5]);
      state.root = 45 + ((state.root + step - 45 + 24) % 12) + 12 * (rng2() < 0.5 ? 0 : 1);
      if (state.root < 45) state.root += 12;
      if (state.root > 60) state.root -= 12;
    }

    const root = state.root;
    // consonant chord: root, fifth, and a colour tone (third or ninth).
    const colour = rng2() < 0.5 ? 4 : 14; // major third or ninth
    const chord = [root, root + 7, root + colour];
    if (rng2() < 0.4) chord.push(root + 12); // add a shimmer octave sometimes

    for (const midi of chord) {
      padVoice(ctx, group, when, midiToFreq(midi), barDur * 1.15, rng2, addSource, PAD_LEVEL);
    }

    // sparse arpeggio notes drawn from the pentatonic, up an octave or two.
    const arpCount = rng2() < 0.6 ? 1 + randInt(rng2, 3) : 0;
    for (let k = 0; k < arpCount; k++) {
      const t = when + rng2() * barDur * 0.9;
      const deg = pick(rng2, penta);
      const oct = 12 * (1 + randInt(rng2, 2));
      arpVoice(ctx, group, t, midiToFreq(root + deg + oct), rng2, addSource, ARP_LEVEL);
    }

    return barDur;
  }

  return makeTrack(engine, { seed: opts.seed, groupLevel: 0.8 }, rng, planBar);
}

// ---------------------------------------------------------------------------
// NETHER track
// ---------------------------------------------------------------------------

/**
 * startNether — dark, uneasy: a low sustained drone, sparse minor-pentatonic
 * fragments, and occasional metallic clangs. Slower and sparser than calm.
 * @param {object} engine
 * @param {{seed?:number}} [opts]
 * @returns {{ stop:(fade?:number)=>void }}
 */
export function startNether(engine, opts = {}) {
  const rng = mulberry32((opts.seed != null ? opts.seed : 6660) >>> 0);

  // minor pentatonic degrees (dark / phrygian-leaning colour tones added ad hoc).
  const minPenta = [0, 3, 5, 7, 10];
  const state = { root: 33 + randInt(rng, 5) }; // A1..C#2 low drone region

  const DRONE_LEVEL = 0.1;
  const FIFTH_LEVEL = 0.07;
  const MEL_LEVEL = 0.1;
  const CLANG_LEVEL = 0.15;

  function planBar(ctx, group, when, barIndex, rng2, addSource) {
    const barDur = 6.0 + rng2() * 2.5; // 6-8.5s, slow and sparse

    // slow drifting root, kept low.
    if (barIndex > 0 && rng2() < 0.3) {
      const step = pick(rng2, [-3, -2, 0, 2, 3, 5]);
      state.root += step;
      if (state.root < 31) state.root = 31;
      if (state.root > 41) state.root = 41;
    }
    const root = state.root;

    // sustained low drone, overlapping across bars.
    droneVoice(ctx, group, when, midiToFreq(root), barDur * 1.2, rng2, addSource, DRONE_LEVEL);
    // an uneasy bare fifth an octave up, sometimes.
    if (rng2() < 0.5) {
      droneVoice(ctx, group, when + rng2() * 0.5, midiToFreq(root + 12 + 7), barDur * 1.0, rng2, addSource, FIFTH_LEVEL);
    }

    // sparse minor melodic fragment (1-2 notes) in a mid-low register.
    if (rng2() < 0.45) {
      const n = 1 + randInt(rng2, 2);
      for (let k = 0; k < n; k++) {
        const t = when + barDur * (0.2 + rng2() * 0.6) + k * (0.5 + rng2() * 0.6);
        const deg = pick(rng2, minPenta);
        const oct = 12 * (1 + randInt(rng2, 2));
        netherMelodyVoice(ctx, group, t, midiToFreq(root + deg + oct), rng2, addSource, MEL_LEVEL);
      }
    }

    // occasional metallic clang.
    if (rng2() < 0.3) {
      const t = when + rng2() * barDur;
      const deg = pick(rng2, minPenta);
      const base = midiToFreq(root + deg + 24);
      clangVoice(ctx, group, t, base, rng2, addSource, CLANG_LEVEL);
    }

    return barDur;
  }

  return makeTrack(engine, { seed: opts.seed, groupLevel: 0.8 }, rng, planBar);
}
