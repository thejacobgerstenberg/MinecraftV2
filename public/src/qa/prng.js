// Loomfall — QA PRNG known-answer probes (window.__qa.prngSample backend).
//
// PURE module: no three.js, no DOM — runs under plain node.
//
// The QA plan (design/parity-spec docs/QA_PLAN.md §1.4) specifies golden
// vectors for two reference generators; both are implemented here exactly:
//
//   'legacy'    — java.util.Random(seed).nextInt() sequence
//                 (LCG mult 0x5DEECE66D, add 0xB, 48-bit state,
//                  scramble (seed ^ mult) & mask, output = top 32 signed bits)
//   'xoroshiro' — xoroshiro128++ next() u64 sequence
//                 (rotl 17/49/28, shift 21). Seed 'state:<s0>,<s1>' sets the
//                 raw 128-bit state; any other seed goes through the
//                 splitmix64/Stafford-mix13 derivation (lo = seed ^ golden,
//                 hi = lo + 0x9E3779B97F4A7C15).
//
// A third kind maps onto the ENGINE's actual randomness (worldgen noise):
//
//   'noise2d'   — makeNoise2D(seed) sampled at a fixed deterministic set of
//                 coordinates; values are the raw floats in [-1, 1] as
//                 decimal strings. This is the golden-vector probe for
//                 Loomfall's own terrain noise (the engine does not use
//                 java-Random or xoroshiro anywhere).
//
// All kinds return the first n outputs as decimal strings.

import { makeNoise2D } from '../world/noise.js';

const M48 = (1n << 48n) - 1n;
const M64 = (1n << 64n) - 1n;

/** Java seed semantics: numeric string -> 64-bit long; else String.hashCode. */
function javaSeedFrom(seedStr) {
  const s = String(seedStr);
  if (/^-?\d+$/.test(s)) return BigInt.asIntN(64, BigInt(s));
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return BigInt(h);
}

function legacySample(seedStr, n) {
  let state = (BigInt.asUintN(64, javaSeedFrom(seedStr)) ^ 0x5DEECE66Dn) & M48;
  const out = [];
  for (let i = 0; i < n; i++) {
    state = (state * 0x5DEECE66Dn + 0xBn) & M48;
    out.push(BigInt.asIntN(32, state >> 16n).toString());
  }
  return out;
}

const rotl64 = (x, k) => ((x << k) | (x >> (64n - k))) & M64;

/** splitmix64 finalizer (Stafford mix13) used by the xoroshiro derivation. */
function mixStafford13(z) {
  z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & M64;
  return (z ^ (z >> 31n)) & M64;
}

function xoroshiroSample(seedStr, n) {
  let s0, s1;
  const raw = /^state:(-?\d+),(-?\d+)$/.exec(String(seedStr));
  if (raw) {
    s0 = BigInt.asUintN(64, BigInt(raw[1]));
    s1 = BigInt.asUintN(64, BigInt(raw[2]));
  } else {
    const seed = BigInt.asUintN(64, javaSeedFrom(seedStr));
    const lo = (seed ^ 0x6A09E667F3BCC909n) & M64;
    const hi = (lo + 0x9E3779B97F4A7C15n) & M64;
    s0 = mixStafford13(lo);
    s1 = mixStafford13(hi);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(((rotl64((s0 + s1) & M64, 17n) + s0) & M64).toString());
    s1 ^= s0;
    s0 = (rotl64(s0, 49n) ^ s1 ^ ((s1 << 21n) & M64)) & M64;
    s1 = rotl64(s1, 28n);
  }
  return out;
}

function noise2dSample(seedStr, n) {
  const noise = makeNoise2D(String(seedStr));
  const out = [];
  for (let i = 0; i < n; i++) {
    // Fixed, irrational-ish sample lattice so consecutive samples never land
    // on integer lattice points (where gradient noise is exactly 0).
    out.push(String(noise(i * 12.9898 + 0.531, i * 78.233 + 0.417)));
  }
  return out;
}

/**
 * First n raw outputs of the requested generator as decimal strings.
 * @param {'legacy'|'xoroshiro'|'noise2d'} kind
 * @param {string|number} seed  see kind docs above
 * @param {number} n            sample count (clamped to 1..4096)
 */
export function prngSample(kind, seed, n) {
  const count = Math.max(1, Math.min(4096, Math.floor(Number(n) || 0)));
  switch (kind) {
    case 'legacy': return legacySample(seed, count);
    case 'xoroshiro': return xoroshiroSample(seed, count);
    case 'noise2d': return noise2dSample(seed, count);
    default: throw new Error(`prngSample: unknown kind "${kind}"`);
  }
}
