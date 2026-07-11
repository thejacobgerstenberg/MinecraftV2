// audio/dsp.js
// Dependency-free Web Audio DSP helpers. ES module, named exports.
// All helpers work with both a live AudioContext and an OfflineAudioContext.

/**
 * mulberry32 — small, fast, seeded PRNG. Standard implementation.
 * @param {number} seed
 * @returns {() => number} function returning a float in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * noiseBuffer — build a mono AudioBuffer filled with colored noise.
 * @param {BaseAudioContext} ctx
 * @param {number} seconds
 * @param {'white'|'pink'|'brown'} color
 * @returns {AudioBuffer}
 */
export function noiseBuffer(ctx, seconds, color = 'white') {
  const sampleRate = ctx.sampleRate || 44100;
  const length = Math.max(1, Math.floor(seconds * sampleRate));
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  if (color === 'pink') {
    // Paul Kellet's economical pink noise filter.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      let pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      data[i] = pink * 0.11; // scale roughly into [-1, 1]
    }
  } else if (color === 'brown') {
    // Integrated (leaky) white noise with clamp to avoid DC runaway.
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      if (last > 1) last = 1;
      if (last < -1) last = -1;
      data[i] = last * 3.5; // compensate for the low amplitude
    }
    // final safety clamp
    for (let i = 0; i < length; i++) {
      if (data[i] > 1) data[i] = 1;
      else if (data[i] < -1) data[i] = -1;
    }
  } else {
    // white
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
  }
  return buffer;
}

/**
 * noiseSource — create an AudioBufferSourceNode from a noise buffer.
 * @param {BaseAudioContext} ctx
 * @param {AudioBuffer} buffer
 * @param {{loop?: boolean, playbackRate?: number}} [opts]
 * @returns {AudioBufferSourceNode}
 */
export function noiseSource(ctx, buffer, opts = {}) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = !!opts.loop;
  if (opts.playbackRate != null) {
    src.playbackRate.value = opts.playbackRate;
  }
  return src;
}

/**
 * osc — create an OscillatorNode.
 * @param {BaseAudioContext} ctx
 * @param {OscillatorType} type
 * @param {number} freq
 * @param {number} [detune] cents
 * @returns {OscillatorNode}
 */
export function osc(ctx, type, freq, detune = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.detune.value = detune;
  return o;
}

/**
 * gain — create a GainNode with a constant value.
 * @param {BaseAudioContext} ctx
 * @param {number} [value]
 * @returns {GainNode}
 */
export function gain(ctx, value = 1) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

/**
 * filter — create a BiquadFilterNode.
 * @param {BaseAudioContext} ctx
 * @param {BiquadFilterType} type
 * @param {number} freq
 * @param {number} [Q]
 * @returns {BiquadFilterNode}
 */
export function filter(ctx, type, freq, Q = 1) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = Q;
  return f;
}

/**
 * envGain — build a GainNode and schedule a full ADSR envelope from `when`.
 * gain: 0 -> peak (attack), -> sustain*peak (decay), hold, -> 0 (release).
 * Never ramps exponentially to 0 (ramps to 0.0001 then setValueAtTime 0).
 * @param {BaseAudioContext} ctx
 * @param {number} when start time in the ctx timebase
 * @param {{attack?:number,decay?:number,sustain?:number,release?:number,peak?:number,hold?:number}} [opts]
 * @returns {GainNode}
 */
export function envGain(ctx, when, opts = {}) {
  const attack = opts.attack != null ? opts.attack : 0.005;
  const decay = opts.decay != null ? opts.decay : 0.1;
  const sustain = opts.sustain != null ? opts.sustain : 0;
  const release = opts.release != null ? opts.release : 0.05;
  const peak = opts.peak != null ? opts.peak : 1;
  const hold = opts.hold != null ? opts.hold : 0;

  const g = ctx.createGain();
  const p = g.gain;

  const sustainLevel = Math.max(0, sustain * peak);

  const t0 = when;
  const tAttack = t0 + Math.max(0, attack);
  const tDecay = tAttack + Math.max(0, decay);
  const tHoldEnd = tDecay + Math.max(0, hold);
  const tEnd = tHoldEnd + Math.max(0, release);

  p.cancelScheduledValues(t0);
  p.setValueAtTime(0.0001, t0);
  // Attack: linear ramp up to peak.
  p.linearRampToValueAtTime(Math.max(0.0001, peak), tAttack);
  // Decay: to sustain level.
  if (sustainLevel > 0.0001) {
    p.exponentialRampToValueAtTime(sustainLevel, tDecay);
  } else {
    p.linearRampToValueAtTime(0.0001, tDecay);
  }
  // Hold at sustain level.
  p.setValueAtTime(Math.max(0.0001, sustainLevel), tHoldEnd);
  // Release to (near) 0 — never exponential-ramp to exactly 0.
  p.exponentialRampToValueAtTime(0.0001, tEnd);
  p.setValueAtTime(0, tEnd);

  return g;
}

/**
 * sweep — ramp an AudioParam from fromHz to toHz over `seconds` starting at `when`.
 * type 'exp' uses exponentialRampToValueAtTime (clamps endpoints to > 0),
 * type 'lin' uses linearRampToValueAtTime.
 * @param {AudioParam} param
 * @param {number} when
 * @param {number} fromHz
 * @param {number} toHz
 * @param {number} seconds
 * @param {'exp'|'lin'} [type]
 * @returns {void}
 */
export function sweep(param, when, fromHz, toHz, seconds, type = 'exp') {
  const end = when + Math.max(0, seconds);
  if (type === 'lin') {
    param.cancelScheduledValues(when);
    param.setValueAtTime(fromHz, when);
    param.linearRampToValueAtTime(toHz, end);
  } else {
    const from = Math.max(1e-4, fromHz);
    const to = Math.max(1e-4, toHz);
    param.cancelScheduledValues(when);
    param.setValueAtTime(from, when);
    param.exponentialRampToValueAtTime(to, end);
  }
}

/**
 * connect — chain-connect a list of AudioNodes and return the last node.
 * @param {...AudioNode} nodes
 * @returns {AudioNode} the last node in the chain
 */
export function connect(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) {
    nodes[i].connect(nodes[i + 1]);
  }
  return nodes[nodes.length - 1];
}
