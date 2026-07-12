// Voxelheim deterministic noise (worldgen phase).
//
// PURE module: no three.js import — must run under plain node.
//
// Exports:
//   makeNoise2D(seed) -> (x, z) => value in [-1, 1]
//   makeNoise3D(seed) -> (x, y, z) => value in [-1, 1]
//   fbm2D(noise, x, z, octaves, lacunarity, gain) -> value in [-1, 1]
//
// Implementation: classic gradient (Perlin-style) noise with quintic
// interpolation. Lattice gradients come from a well-mixed integer hash of the
// lattice coordinates and the seed (no permutation table, so there is no
// repeat period and no visible grid artifacts). Fully deterministic from an
// integer or string seed.

/** FNV-1a 32-bit hash of a string -> uint32. */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Normalize a seed (string | number) to a well-mixed uint32. */
function normalizeSeed(seed) {
  let s;
  if (typeof seed === 'string') s = hashString(seed);
  else if (typeof seed === 'number' && Number.isFinite(seed)) s = seed >>> 0;
  else s = hashString(String(seed));
  return mix32(s ^ 0x9e3779b9);
}

/** Strong 32-bit avalanche mix (lowbias32 variant). */
function mix32(h) {
  h = h >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash 2D integer lattice coords with a seed -> uint32. Sequentially mixed. */
function latticeHash2(seed, xi, zi) {
  let h = (seed ^ Math.imul(xi, 0x9e3779b1)) >>> 0;
  h = mix32(h);
  h = (h ^ Math.imul(zi, 0x85ebca77)) >>> 0;
  return mix32(h);
}

/** Hash 3D integer lattice coords with a seed -> uint32. */
function latticeHash3(seed, xi, yi, zi) {
  let h = (seed ^ Math.imul(xi, 0x9e3779b1)) >>> 0;
  h = mix32(h);
  h = (h ^ Math.imul(yi, 0xc2b2ae3d)) >>> 0;
  h = mix32(h);
  h = (h ^ Math.imul(zi, 0x85ebca77)) >>> 0;
  return mix32(h);
}

/** Quintic fade curve: 6t^5 - 15t^4 + 10t^3 (C2 continuous). */
function quintic(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// 32 evenly spaced unit gradient directions for 2D noise.
const GRAD2 = new Float64Array(64);
for (let i = 0; i < 32; i++) {
  const a = (i / 32) * Math.PI * 2;
  GRAD2[i * 2] = Math.cos(a);
  GRAD2[i * 2 + 1] = Math.sin(a);
}

// 12 edge-vector gradients for 3D noise (Perlin improved noise set),
// padded to 16 entries so we can select with `& 15`.
const GRAD3 = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
  1, 1, 0, 0, -1, 1, -1, 1, 0, 0, -1, -1,
]);

/**
 * Create a deterministic 2D gradient-noise function.
 * @param {string|number} seed
 * @returns {(x:number, z:number) => number} value in [-1, 1]
 */
export function makeNoise2D(seed) {
  const s = normalizeSeed(seed);
  return function noise2D(x, z) {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const xf = x - xi;
    const zf = z - zi;

    const h00 = latticeHash2(s, xi, zi) & 31;
    const h10 = latticeHash2(s, xi + 1, zi) & 31;
    const h01 = latticeHash2(s, xi, zi + 1) & 31;
    const h11 = latticeHash2(s, xi + 1, zi + 1) & 31;

    const d00 = GRAD2[h00 * 2] * xf + GRAD2[h00 * 2 + 1] * zf;
    const d10 = GRAD2[h10 * 2] * (xf - 1) + GRAD2[h10 * 2 + 1] * zf;
    const d01 = GRAD2[h01 * 2] * xf + GRAD2[h01 * 2 + 1] * (zf - 1);
    const d11 = GRAD2[h11 * 2] * (xf - 1) + GRAD2[h11 * 2 + 1] * (zf - 1);

    const u = quintic(xf);
    const w = quintic(zf);
    const nx0 = d00 + (d10 - d00) * u;
    const nx1 = d01 + (d11 - d01) * u;
    let v = (nx0 + (nx1 - nx0) * w) * 1.4142135623730951;
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    return v;
  };
}

/**
 * Create a deterministic 3D gradient-noise function.
 * @param {string|number} seed
 * @returns {(x:number, y:number, z:number) => number} value in [-1, 1]
 */
export function makeNoise3D(seed) {
  const s = normalizeSeed(seed);
  return function noise3D(x, y, z) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = x - xi;
    const yf = y - yi;
    const zf = z - zi;

    const u = quintic(xf);
    const v = quintic(yf);
    const w = quintic(zf);

    let g = (latticeHash3(s, xi, yi, zi) & 15) * 3;
    const d000 = GRAD3[g] * xf + GRAD3[g + 1] * yf + GRAD3[g + 2] * zf;
    g = (latticeHash3(s, xi + 1, yi, zi) & 15) * 3;
    const d100 = GRAD3[g] * (xf - 1) + GRAD3[g + 1] * yf + GRAD3[g + 2] * zf;
    g = (latticeHash3(s, xi, yi + 1, zi) & 15) * 3;
    const d010 = GRAD3[g] * xf + GRAD3[g + 1] * (yf - 1) + GRAD3[g + 2] * zf;
    g = (latticeHash3(s, xi + 1, yi + 1, zi) & 15) * 3;
    const d110 = GRAD3[g] * (xf - 1) + GRAD3[g + 1] * (yf - 1) + GRAD3[g + 2] * zf;
    g = (latticeHash3(s, xi, yi, zi + 1) & 15) * 3;
    const d001 = GRAD3[g] * xf + GRAD3[g + 1] * yf + GRAD3[g + 2] * (zf - 1);
    g = (latticeHash3(s, xi + 1, yi, zi + 1) & 15) * 3;
    const d101 = GRAD3[g] * (xf - 1) + GRAD3[g + 1] * yf + GRAD3[g + 2] * (zf - 1);
    g = (latticeHash3(s, xi, yi + 1, zi + 1) & 15) * 3;
    const d011 = GRAD3[g] * xf + GRAD3[g + 1] * (yf - 1) + GRAD3[g + 2] * (zf - 1);
    g = (latticeHash3(s, xi + 1, yi + 1, zi + 1) & 15) * 3;
    const d111 = GRAD3[g] * (xf - 1) + GRAD3[g + 1] * (yf - 1) + GRAD3[g + 2] * (zf - 1);

    const x00 = d000 + (d100 - d000) * u;
    const x10 = d010 + (d110 - d010) * u;
    const x01 = d001 + (d101 - d001) * u;
    const x11 = d011 + (d111 - d011) * u;
    const y0 = x00 + (x10 - x00) * v;
    const y1 = x01 + (x11 - x01) * v;
    let out = (y0 + (y1 - y0) * w) * 0.9649214285521897; // normalize sqrt(2)-length gradients
    if (out > 1) out = 1;
    else if (out < -1) out = -1;
    return out;
  };
}

/**
 * Fractal Brownian motion over a 2D noise function. Amplitude-normalized so
 * the result stays in [-1, 1].
 * @param {(x:number, z:number) => number} noise a makeNoise2D function
 */
export function fbm2D(noise, x, z, octaves, lacunarity, gain) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
