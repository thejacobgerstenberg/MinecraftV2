// graphics-lab/textures/painters.js
//
// Shared per-tile painter library for the Loomfall texture-pack system.
// One paint function per TILE_NAME (55 total), parameterized by pack knobs
// (see packFormat.js) and the brand palette (palettes.js).
//
// PURE module: no `three`, no DOM globals. Painters draw through a minimal
// Canvas2D surface API — ONLY: fillStyle (rgba string), fillRect, clearRect,
// getImageData, putImageData. That keeps them runnable in the browser AND
// under node via the software shim in selftest.mjs.
//
// SEAMLESS TILING: every opaque terrain painter samples its structure noise
// on a torus (wrapped lattices) and stamps multi-pixel features through
// pset(), which wraps coordinates — so left/right and top/bottom edges
// continue when the tile repeats. Per-pixel grain is independent noise and is
// statistically seamless by construction. Alpha/liquid tiles (water, lava,
// glass, leaves, torch, portal, doors) are art tiles and are exempted by the
// tiling selftest with reasons.
//
// Determinism: each painter receives an rng from makeRng() and consumes it in
// a fixed order — the same (pack, tile, seed) always yields identical pixels.

import { PALETTE } from './palettes.js';

// ---------------------------------------------------------------------------
// Canonical ordered tile list. APPEND-ONLY: indices are part of the atlas
// layout contract. The first 33 names replicate, in order, the builder list
// from origin/feat/voxel-sandbox-game:public/src/textures/texturePacks.js.
// ---------------------------------------------------------------------------
export const TILE_NAMES = [
  // --- builder's 33 (order frozen; do not touch) ---
  'grass_top', 'grass_side', 'dirt', 'stone', 'sand', 'water',
  'log_top', 'log_side', 'leaves', 'planks', 'glass', 'cobblestone',
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'bedrock', 'snow',
  'snow_side', 'cactus_top', 'cactus_side', 'gravel', 'netherrack',
  'soul_sand', 'glowstone', 'obsidian', 'end_stone', 'purpur', 'red_sand',
  'sandstone', 'sandstone_top', 'lava', 'portal',
  // --- richer set (appended) ---
  'birch_log_side', 'birch_log_top', 'birch_planks',
  'spruce_log_side', 'spruce_log_top', 'spruce_planks',
  'bricks', 'door_upper', 'door_lower', 'torch',
  'gem_ore', 'everthread_ore',
  'thread_block', 'weave_block', 'loom_block',
  'wool_white', 'wool_red', 'wool_blue', 'wool_green', 'wool_yellow', 'wool_black',
  'portal_frame',
  // --- emitter blocks (appended, graphics-wiring phase) ---
  'lantern',
];

// ---------------------------------------------------------------------------
// PRNG: xmur3 string hash seeding mulberry32. Deterministic, fast, [0,1).
// ---------------------------------------------------------------------------
export function makeRng(seedString) {
  let h = 1779033703 ^ seedString.length;
  for (let i = 0; i < seedString.length; i++) {
    h = Math.imul(h ^ seedString.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  let a = (h ^= h >>> 16) >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Color helpers. Colors are [r,g,b] arrays 0..255.
// ---------------------------------------------------------------------------
const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
export const css = (c, a = 1) => `rgba(${cl(c[0])},${cl(c[1])},${cl(c[2])},${a})`;
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c, f) => [c[0] * f, c[1] * f, c[2] * f];

/** Pack tint in HSV space: sat scales HSV saturation, light scales value,
 *  contrast stretches value about mid, rampMerge (smooth pack) soft-clamps
 *  value extremes ("ramp ends merged"). HSV-space keeps the knobs honest:
 *  the measured mean HSV saturation tracks the sat knob directly. */
export function tintWith(c, sat, light, contrast, rampMerge = false) {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  let s = mx > 0 ? d / mx : 0;
  let v = mx;
  s = Math.min(1, Math.max(0, s * sat));
  v *= light;
  v = 0.5 + (v - 0.5) * contrast;
  if (rampMerge) v = 0.5 + Math.tanh((v - 0.5) / 0.45) * 0.45;
  v = Math.min(1, Math.max(0, v));
  const C = v * s, X = C * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - C;
  let rr, gg, bb;
  if (h < 60) { rr = C; gg = X; bb = 0; }
  else if (h < 120) { rr = X; gg = C; bb = 0; }
  else if (h < 180) { rr = 0; gg = C; bb = X; }
  else if (h < 240) { rr = 0; gg = X; bb = C; }
  else if (h < 300) { rr = X; gg = 0; bb = C; }
  else { rr = C; gg = 0; bb = X; }
  return [(rr + m) * 255, (gg + m) * 255, (bb + m) * 255];
}
/** Full pack tint for base/ground colors. */
export const T = (S, c) => tintWith(c, S.sat, S.light, S.contrast, S.rampMerge);
/** Milder tint for accents (ore nuggets, glow, embers) — they keep identity
 *  even in the desaturated gritty pack. accentKeep=1 -> fully tinted. */
export const A = (S, c) => tintWith(
  c,
  1 - (1 - S.sat) * S.accentKeep,
  1 - (1 - S.light) * 0.5,
  1 + (S.contrast - 1) * 0.3,
  false,
);

// ---------------------------------------------------------------------------
// Torus drawing / noise primitives.
// ---------------------------------------------------------------------------

/** fillRect that wraps on the tile torus (up to 4 sub-rects). w,h <= px. */
export function pset(ctx, px, x, y, w = 1, h = 1) {
  x = Math.round(x); y = Math.round(y);
  x = ((x % px) + px) % px;
  y = ((y % px) + px) % px;
  const w1 = Math.min(w, px - x), h1 = Math.min(h, px - y);
  const w2 = w - w1, h2 = h - h1;
  ctx.fillRect(x, y, w1, h1);
  if (w2 > 0) ctx.fillRect(0, y, w2, h1);
  if (h2 > 0) ctx.fillRect(x, 0, w1, h2);
  if (w2 > 0 && h2 > 0) ctx.fillRect(0, 0, w2, h2);
}

const sm = (t) => t * t * (3 - 2 * t);

function lattice(rng, c) {
  const a = new Float64Array(c * c);
  for (let i = 0; i < a.length; i++) a[i] = rng();
  return a;
}
function sampleLat(a, c, u, v) {
  const x = u * c, y = v * c;
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = sm(x - xi), fy = sm(y - yi);
  const x0 = ((xi % c) + c) % c, y0 = ((yi % c) + c) % c;
  const x1 = (x0 + 1) % c, y1 = (y0 + 1) % c;
  const a00 = a[y0 * c + x0], a10 = a[y0 * c + x1];
  const a01 = a[y1 * c + x0], a11 = a[y1 * c + x1];
  return (a00 + (a10 - a00) * fx) * (1 - fy) + (a01 + (a11 - a01) * fx) * fy;
}

/** Two-octave torus value-noise field over a px-sized tile: fn(x,y) -> 0..1 */
export function noiseField(rng, cells, px) {
  const c1 = Math.max(2, cells | 0), c2 = c1 * 2;
  const l1 = lattice(rng, c1), l2 = lattice(rng, c2);
  return (x, y) => {
    const u = x / px, v = y / px;
    return 0.65 * sampleLat(l1, c1, u, v) + 0.35 * sampleLat(l2, c2, u, v);
  };
}

/** 1D wrapped noise along x: fn(x) -> 0..1 */
export function noise1D(rng, cells, px) {
  const c = Math.max(2, cells | 0);
  const a = new Float64Array(c);
  for (let i = 0; i < c; i++) a[i] = rng();
  return (x) => {
    const t = (((x / px) % 1) + 1) % 1 * c;
    const i0 = Math.floor(t) % c, i1 = (i0 + 1) % c;
    return a[i0] + (a[i1] - a[i0]) * sm(t - Math.floor(t));
  };
}

/** Opaque base: flat tinted fill + low-frequency torus mottle + pixel grain.
 *  Smooth packs (S.gradients) swap grain for larger, softer mottle. */
export function fillBase(ctx, px, rng, S, base, opts = {}) {
  const { low = 0.10, cells = 5, grain = 8, tint = T } = opts;
  const cc = tint(S, base);
  const nf = noiseField(rng, S.gradients ? Math.max(2, cells - 2) : cells, px);
  const lowAmp = low * (S.gradients ? 1.6 : 1);
  const g = grain * S.grain;
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const f = (nf(x, y) - 0.5) * 2;
      const d = (rng() * 2 - 1) * g;
      const m = 1 + f * lowAmp;
      ctx.fillStyle = css([cc[0] * m + d, cc[1] * m + d, cc[2] * m + d]);
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return cc;
}

/** Scatter wrapped single pixels/squares from a color list. */
export function speckle(ctx, px, rng, S, colors, count, size = 1, alpha = 1, tint = T) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = css(tint(S, colors[(rng() * colors.length) | 0]), alpha);
    pset(ctx, px, (rng() * px) | 0, (rng() * px) | 0, size, size);
  }
}

/** Random-walk path (unclamped — pset wraps it onto the torus). */
export function wander(rng, px, steps) {
  let x = rng() * px, y = rng() * px, a = rng() * Math.PI * 2;
  const pts = [];
  for (let i = 0; i < steps; i++) {
    pts.push([x, y]);
    a += (rng() - 0.5) * 1.3;
    x += Math.cos(a); y += Math.sin(a);
  }
  return pts;
}

/** Cracks / vein lines drawn as wrapped wander paths. */
export function cracks(ctx, px, rng, S, color, count, steps, alpha = 0.7) {
  ctx.fillStyle = css(color, alpha);
  for (let c = 0; c < count; c++) {
    for (const [x, y] of wander(rng, px, steps)) pset(ctx, px, x, y, 1, 1);
  }
}

// ---------------------------------------------------------------------------
// Ore machinery. Default look: organic pixel clusters with a dark under-rim
// and a glint. Loudstone (S.patterns) look: each ore uses a DISTINCT stamp
// shape — dots / stripes / diamonds / crosses / rings / zigzag — so ores are
// distinguishable by shape + luminance, never hue alone.
// ---------------------------------------------------------------------------
const STAMPS = {
  dot: [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],
  stripe: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [0, 1], [1, 1], [2, 1], [3, 1], [4, 1]],
  diamond: [[2, 0], [1, 1], [2, 1], [3, 1], [0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [1, 3], [2, 3], [3, 3], [2, 4]],
  cross: [[2, 0], [2, 1], [0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [2, 3], [2, 4]],
  ring: [[1, 0], [2, 0], [3, 0], [0, 1], [4, 1], [0, 2], [4, 2], [0, 3], [4, 3], [1, 4], [2, 4], [3, 4]],
  zigzag: [[0, 2], [1, 1], [2, 0], [3, 1], [4, 2], [5, 1], [6, 0], [7, 1], [8, 2]],
};

function stampAt(ctx, px, cx, cy, pts, main, dark, glint) {
  ctx.fillStyle = css(dark);
  for (const [dx, dy] of pts) pset(ctx, px, cx + dx + 1, cy + dy + 1, 1, 1);
  ctx.fillStyle = css(main);
  for (const [dx, dy] of pts) pset(ctx, px, cx + dx, cy + dy, 1, 1);
  ctx.fillStyle = css(glint);
  pset(ctx, px, cx + pts[(pts.length / 2) | 0][0], cy + pts[(pts.length / 2) | 0][1], 1, 1);
}

export function oreBlobs(ctx, px, rng, S, spec) {
  const n = spec.n ?? 5;
  const main = A(S, spec.main);
  const dark = A(S, spec.dark);
  const glint = A(S, spec.glint || spec.main);
  for (let k = 0; k < n; k++) {
    const cx = (rng() * px) | 0, cy = (rng() * px) | 0;
    if (S.patterns && spec.shape) {
      stampAt(ctx, px, cx, cy, STAMPS[spec.shape], main, dark, glint);
    } else {
      ctx.fillStyle = css(dark);
      pset(ctx, px, cx + 1, cy + 1, 2, 2);
      ctx.fillStyle = css(main);
      const m = 3 + ((rng() * 4) | 0);
      pset(ctx, px, cx, cy, 2, 2);
      for (let i = 0; i < m; i++) {
        pset(ctx, px, cx + ((rng() * 4) | 0) - 1, cy + ((rng() * 4) | 0) - 1, 1, 1);
      }
      ctx.fillStyle = css(glint);
      pset(ctx, px, cx, cy, 1, 1);
    }
  }
}

/** Torus Voronoi cells: cobblestone / gravel / end-stone shells. */
export function voronoi(ctx, px, rng, S, opts) {
  const { n = 10, base, mortar, vary = 0.3, mortarWidth = 1.4, grain = 6, tint = T } = opts;
  const pts = [];
  for (let i = 0; i < n; i++) pts.push({ x: rng() * px, y: rng() * px, s: 1 - vary / 2 + rng() * vary });
  const bc = tint(S, base), mc = tint(S, mortar);
  const g = grain * S.grain;
  const half = px / 2;
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      let d1 = 1e9, d2 = 1e9, s = 1;
      for (const p of pts) {
        let dx = Math.abs(x - p.x); if (dx > half) dx = px - dx;
        let dy = Math.abs(y - p.y); if (dy > half) dy = px - dy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < d1) { d2 = d1; d1 = d; s = p.s; } else if (d < d2) { d2 = d; }
      }
      const dgrain = (rng() * 2 - 1) * g;
      if (d2 - d1 < mortarWidth) {
        ctx.fillStyle = css([mc[0] + dgrain, mc[1] + dgrain, mc[2] + dgrain]);
      } else {
        const f = s * (1 - Math.min(0.16, d1 * 0.012));
        ctx.fillStyle = css([bc[0] * f + dgrain, bc[1] * f + dgrain, bc[2] * f + dgrain]);
      }
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Composite family painters (shared by several tiles).
// ---------------------------------------------------------------------------
const P = PALETTE;

function stoneBase(ctx, px, rng, S) {
  fillBase(ctx, px, rng, S, P.stone, { low: 0.12, cells: 5, grain: 7 });
  speckle(ctx, px, rng, S, [P.stone_light], 10, 1, 0.5);
  cracks(ctx, px, rng, S, T(S, P.stone_dark), S.wear ? 3 : 1, 12, 0.55);
  if (S.wear) cracks(ctx, px, rng, S, T(S, P.stone_dark), 2, 18, 0.4);
}

function paintPlanks(ctx, px, rng, S, base, dark) {
  const bh = 8; // board height; 32/8 = 4 boards, wraps
  const nb = px / bh;
  const shades = [];
  for (let i = 0; i < nb; i++) shades.push(0.9 + rng() * 0.2);
  const cc = T(S, base), dd = T(S, dark);
  const g = 5 * S.grain;
  const grainN = noiseField(rng, 8, px);
  for (let b = 0; b < nb; b++) {
    for (let y = b * bh; y < (b + 1) * bh; y++) {
      for (let x = 0; x < px; x++) {
        const seam = (y % bh) === bh - 1;
        const f = shades[b] * (1 + (grainN(x, b * bh + (y % bh) * 0.3) - 0.5) * 0.18);
        const d = (rng() * 2 - 1) * g;
        const c = seam ? dd : [cc[0] * f + d, cc[1] * f + d, cc[2] * f + d];
        ctx.fillStyle = css(c);
        ctx.fillRect(x, y, 1, 1);
      }
    }
    // one wrapped vertical joint per board
    const jx = (rng() * px) | 0;
    ctx.fillStyle = css(dd, 0.9);
    pset(ctx, px, jx, b * bh, 1, bh - 1);
    // grain streaks
    ctx.fillStyle = css(mix(cc, dd, 0.5), 0.5);
    for (let s = 0; s < 3; s++) {
      pset(ctx, px, (rng() * px) | 0, b * bh + 1 + ((rng() * (bh - 2)) | 0), 3 + ((rng() * 5) | 0), 1);
    }
  }
}

function paintLogSide(ctx, px, rng, S, bark, barkLight, barkDark, dashes = 0) {
  const col = noise1D(rng, 8, px);
  const cc = T(S, bark), lc = T(S, barkLight), dc = T(S, barkDark);
  const g = 6 * S.grain;
  for (let x = 0; x < px; x++) {
    const t = col(x);
    const base = t < 0.35 ? dc : t > 0.72 ? lc : cc;
    for (let y = 0; y < px; y++) {
      const d = (rng() * 2 - 1) * g;
      ctx.fillStyle = css([base[0] + d, base[1] + d, base[2] + d]);
      ctx.fillRect(x, y, 1, 1);
    }
  }
  // vertical ridge dashes (wrap top-bottom)
  ctx.fillStyle = css(dc, 0.8);
  for (let i = 0; i < 6; i++) {
    pset(ctx, px, (rng() * px) | 0, (rng() * px) | 0, 1, 4 + ((rng() * 6) | 0));
  }
  // birch-style horizontal lenticel dashes
  if (dashes) {
    ctx.fillStyle = css(dc);
    for (let i = 0; i < dashes; i++) {
      pset(ctx, px, (rng() * px) | 0, (rng() * px) | 0, 2 + ((rng() * 3) | 0), 1);
    }
  }
  // a knot
  const kx = (rng() * px) | 0, ky = (rng() * px) | 0;
  ctx.fillStyle = css(dc);
  pset(ctx, px, kx, ky, 3, 2);
  ctx.fillStyle = css(lc);
  pset(ctx, px, kx + 1, ky, 1, 1);
}

function paintLogTop(ctx, px, rng, S, bark, heart, ringDark) {
  fillBase(ctx, px, rng, S, bark, { low: 0.08, cells: 4, grain: 5 });
  const hc = T(S, heart), rc = T(S, ringDark);
  const cx = px / 2 - 0.5, cy = px / 2 - 0.5;
  const wob = noiseField(rng, 4, px);
  for (let y = 2; y < px - 2; y++) {
    for (let x = 2; x < px - 2; x++) {
      const r = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) + (wob(x, y) - 0.5) * 2.2;
      if (r > 12.6) continue; // bark border stays -> uniform edges, tiles cleanly
      const ring = Math.floor(r * 0.85) % 2 === 0;
      ctx.fillStyle = css(ring ? hc : rc);
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.fillStyle = css(rc);
  pset(ctx, px, px / 2 - 1, px / 2 - 1, 2, 2);
}

function paintSand(ctx, px, rng, S, base, deep) {
  fillBase(ctx, px, rng, S, base, { low: 0.07, cells: 4, grain: 6 });
  const ph = noise1D(rng, 4, px);
  const dc = T(S, deep);
  ctx.fillStyle = css(dc, 0.75);
  for (let row = 0; row < 4; row++) {
    const y0 = row * 8 + 3;
    for (let x = 0; x < px; x++) {
      const y = y0 + Math.round(ph((x + row * 11) % px) * 3);
      if ((x + row) % 7 < 4) pset(ctx, px, x, y, 1, 1);
    }
  }
  speckle(ctx, px, rng, S, [deep, base], 14, 1, 0.6);
}

function paintWool(ctx, px, rng, S, colors) {
  const { base, dark, light } = colors;
  fillBase(ctx, px, rng, S, base, { low: 0.06, cells: 5, grain: 5 });
  const dc = T(S, dark), lc = T(S, light);
  // twisted-fiber rows: 4px yarn rows, diagonal two-tone dashes (period 8 wraps)
  for (let y = 0; y < px; y++) {
    const row = y >> 2;
    const ry = y & 3;
    for (let x = 0; x < px; x++) {
      const t = (x + row * 3 + (ry >> 1)) & 7;
      if (ry === 3) { ctx.fillStyle = css(dc, 0.55); ctx.fillRect(x, y, 1, 1); continue; }
      if (t < 2) { ctx.fillStyle = css(dc, 0.5); ctx.fillRect(x, y, 1, 1); }
      else if (t === 4 && ry === 1) { ctx.fillStyle = css(lc, 0.7); ctx.fillRect(x, y, 1, 1); }
    }
  }
  speckle(ctx, px, rng, S, [light], 6, 1, 0.5);
}

function paintMissing(ctx, px) {
  for (let y = 0; y < px; y += 8) {
    for (let x = 0; x < px; x += 8) {
      const on = ((x + y) >> 3) & 1;
      ctx.fillStyle = on ? 'rgba(255,0,255,1)' : 'rgba(10,0,10,1)';
      ctx.fillRect(x, y, 8, 8);
    }
  }
}

// ---------------------------------------------------------------------------
// The 55 painters. fn(ctx, px, rng, S, P) — S = pack knobs, P = PALETTE.
// ---------------------------------------------------------------------------
export const PAINTERS = {
  grass_top(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, P.grass, { low: 0.11, cells: 5, grain: 7 });
    speckle(ctx, px, rng, S, [P.grass_light, P.grass_fringe], 26, 1, 0.8);
    speckle(ctx, px, rng, S, [P.grass_dark], 18, 1, 0.8);
    speckle(ctx, px, rng, S, [P.weld], 3, 1, 0.6, A); // meadow weld-gold flecks
  },

  grass_side(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, P.dirt, { low: 0.1, cells: 5, grain: 8 });
    speckle(ctx, px, rng, S, [P.dirt_dark, P.dirt_light], 16, 1, 0.7);
    const hb = noise1D(rng, 5, px);
    const gc = T(S, P.grass), gl = T(S, P.grass_light), gd = T(S, P.grass_dark);
    for (let x = 0; x < px; x++) {
      const h = 5 + Math.round(hb(x) * 4);
      for (let y = 0; y < h; y++) {
        ctx.fillStyle = css(y === h - 1 ? gd : (rng() < 0.25 ? gl : gc));
        ctx.fillRect(x, y, 1, 1);
      }
      if (rng() < 0.3) { ctx.fillStyle = css(gc); ctx.fillRect(x, h, 1, 1); } // root fringe
    }
  },

  dirt(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, P.dirt, { low: 0.1, cells: 5, grain: 9 });
    speckle(ctx, px, rng, S, [P.dirt_dark], 20, 1, 0.8);
    speckle(ctx, px, rng, S, [P.dirt_light], 12, 2, 0.5);
    speckle(ctx, px, rng, S, [P.stone], 4, 2, 0.7); // tiny stones
  },

  stone(ctx, px, rng, S) { stoneBase(ctx, px, rng, S); },

  sand(ctx, px, rng, S) { paintSand(ctx, px, rng, S, P.sand, P.sand_deep); },

  water(ctx, px, rng, S) {
    // Semi-transparent dye-indigo ripple (liquid: tiling-exempt art tile).
    const wc = A(S, P.water);
    ctx.fillStyle = css(wc, 0.72);
    ctx.fillRect(0, 0, px, px);
    const ph = noise1D(rng, 4, px);
    const lc = A(S, P.water_light), dc = A(S, P.water_deep);
    for (let row = 0; row < 4; row++) {
      const y0 = row * 8 + 2;
      for (let x = 0; x < px; x++) {
        const y = y0 + Math.round(ph((x + row * 9) % px) * 4);
        if ((x + row * 3) % 9 < 5) { ctx.fillStyle = css(lc, 0.5); pset(ctx, px, x, y, 1, 1); }
        if ((x + row * 5) % 13 < 3) { ctx.fillStyle = css(dc, 0.45); pset(ctx, px, x, y + 3, 1, 1); }
      }
    }
    ctx.fillStyle = css(A(S, P.snow_sparkle), 0.7);
    for (let i = 0; i < 4; i++) pset(ctx, px, (rng() * px) | 0, (rng() * px) | 0, 1, 1);
  },

  log_top(ctx, px, rng, S) { paintLogTop(ctx, px, rng, S, P.oak_bark, P.oak_heart, P.oak_bark_dark); },
  log_side(ctx, px, rng, S) { paintLogSide(ctx, px, rng, S, P.oak_bark, P.oak_bark_light, P.oak_bark_dark); },

  leaves(ctx, px, rng, S) {
    // Dithered foliage with real alpha holes (transparent: tiling-exempt).
    const nf = noiseField(rng, 6, px);
    const c1 = T(S, P.leaf), c2 = T(S, P.leaf_light), c3 = T(S, P.leaf_dark);
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const f = nf(x, y) + (rng() - 0.5) * 0.25;
        if (f < 0.22) continue; // hole
        ctx.fillStyle = css(f > 0.66 ? c2 : f > 0.4 ? c1 : c3);
        ctx.fillRect(x, y, 1, 1);
      }
    }
    speckle(ctx, px, rng, S, [P.grass_fringe], 5, 1, 0.7);
  },

  planks(ctx, px, rng, S) { paintPlanks(ctx, px, rng, S, P.oak_plank, P.oak_plank_dark); },

  glass(ctx, px, rng, S) {
    // Pane: border + sparkle, mostly transparent (tiling-exempt).
    const ec = T(S, P.glass_edge), tc = A(S, P.glass_tint);
    ctx.fillStyle = css(tc, 0.09);
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = css(ec, 0.95);
    ctx.fillRect(0, 0, px, 1); ctx.fillRect(0, px - 1, px, 1);
    ctx.fillRect(0, 0, 1, px); ctx.fillRect(px - 1, 0, 1, px);
    ctx.fillStyle = css(ec, 0.55);
    ctx.fillRect(1, 1, 2, 1); ctx.fillRect(1, 1, 1, 2);
    ctx.fillRect(px - 3, px - 2, 2, 1); ctx.fillRect(px - 2, px - 3, 1, 2);
    const sp = A(S, P.glass_sparkle);
    ctx.fillStyle = css(sp, 0.85);
    for (let i = 0; i < 5; i++) ctx.fillRect(5 + i, 10 - i, 1, 1);
    for (let i = 0; i < 4; i++) ctx.fillRect(12 + i, 22 - i, 1, 1);
    ctx.fillStyle = css(tc, 0.3);
    for (let i = 0; i < 6; i++) ctx.fillRect(7 + i, 12 - i, 1, 1);
  },

  cobblestone(ctx, px, rng, S) {
    voronoi(ctx, px, rng, S, { n: 11, base: P.stone, mortar: P.stone_dark, vary: 0.3, grain: 6 });
    speckle(ctx, px, rng, S, [P.stone_light], 8, 1, 0.5);
    if (S.wear) cracks(ctx, px, rng, S, T(S, P.stone_dark), 2, 10, 0.5);
  },

  coal_ore(ctx, px, rng, S) {
    stoneBase(ctx, px, rng, S);
    oreBlobs(ctx, px, rng, S, { main: P.coal, dark: P.bedrock_dark, glint: P.coal_glint, shape: 'dot', n: 6 });
  },
  iron_ore(ctx, px, rng, S) {
    stoneBase(ctx, px, rng, S);
    oreBlobs(ctx, px, rng, S, { main: P.iron, dark: P.iron_dark, glint: P.iron_glint, shape: 'stripe', n: 5 });
  },
  gold_ore(ctx, px, rng, S) {
    stoneBase(ctx, px, rng, S);
    oreBlobs(ctx, px, rng, S, { main: P.gold, dark: P.gold_dark, glint: P.gold_pale, shape: 'diamond', n: 5 });
  },
  diamond_ore(ctx, px, rng, S) {
    stoneBase(ctx, px, rng, S);
    oreBlobs(ctx, px, rng, S, { main: P.diamond, dark: P.diamond_dark, glint: P.diamond_glint, shape: 'cross', n: 5 });
  },

  bedrock(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, P.bedrock, { low: 0.14, cells: 4, grain: 9 });
    const nf = noiseField(rng, 4, px);
    const dk = T(S, P.bedrock_dark);
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        if (nf(x, y) > 0.58) { ctx.fillStyle = css(dk, 0.9); ctx.fillRect(x, y, 1, 1); }
      }
    }
    speckle(ctx, px, rng, S, [P.stone], 8, 1, 0.4);
  },

  snow(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, P.snow, { low: 0.05, cells: 4, grain: 4 });
    speckle(ctx, px, rng, S, [P.snow_shade], 12, 1, 0.6);
    speckle(ctx, px, rng, S, [P.snow_deep], 5, 1, 0.4);
    speckle(ctx, px, rng, S, [P.snow_sparkle], 6, 1, 0.9, A);
  },

  snow_side(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, P.dirt, { low: 0.1, cells: 5, grain: 8 });
    speckle(ctx, px, rng, S, [P.dirt_dark, P.dirt_light], 14, 1, 0.7);
    const hb = noise1D(rng, 5, px);
    const sc = T(S, P.snow), sd = T(S, P.snow_shade);
    for (let x = 0; x < px; x++) {
      const h = 6 + Math.round(hb(x) * 4);
      for (let y = 0; y < h; y++) {
        ctx.fillStyle = css(y === h - 1 ? sd : sc);
        ctx.fillRect(x, y, 1, 1);
      }
      if (rng() < 0.25) { ctx.fillStyle = css(sc); ctx.fillRect(x, h, 1, 1); } // drip
    }
  },

  cactus_top(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, P.cactus, { low: 0.08, cells: 4, grain: 5 });
    const dk = T(S, P.cactus_dark), lt = T(S, P.cactus_light);
    ctx.fillStyle = css(dk);
    ctx.fillRect(0, 0, px, 2); ctx.fillRect(0, px - 2, px, 2);
    ctx.fillRect(0, 0, 2, px); ctx.fillRect(px - 2, 0, 2, px);
    ctx.fillStyle = css(lt);
    ctx.fillRect(10, 10, 12, 12);
    ctx.fillStyle = css(T(S, P.cactus));
    ctx.fillRect(12, 12, 8, 8);
    ctx.fillStyle = css(A(S, P.snow_sparkle), 0.9);
    for (const [sx, sy] of [[6, 6], [25, 6], [6, 25], [25, 25]]) ctx.fillRect(sx, sy, 1, 1);
  },

  cactus_side(ctx, px, rng, S) {
    const bc = T(S, P.cactus), lc = T(S, P.cactus_light), dc = T(S, P.cactus_dark);
    const g = 5 * S.grain;
    for (let x = 0; x < px; x++) {
      const m = x % 4;
      const base = m === 0 ? dc : m === 2 ? lc : bc;
      for (let y = 0; y < px; y++) {
        const d = (rng() * 2 - 1) * g;
        ctx.fillStyle = css([base[0] + d, base[1] + d, base[2] + d]);
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.fillStyle = css(A(S, P.snow_sparkle), 0.95); // spines on the dark ribs
    for (let x = 0; x < px; x += 4) {
      for (let k = 0; k < 2; k++) pset(ctx, px, x, ((rng() * px) | 0), 1, 1);
    }
  },

  gravel(ctx, px, rng, S) {
    voronoi(ctx, px, rng, S, { n: 26, base: P.gravel, mortar: P.gravel_dark, vary: 0.42, mortarWidth: 1.1, grain: 7 });
    speckle(ctx, px, rng, S, [P.gravel_deep, P.stone], 10, 1, 0.6);
  },

  netherrack(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, P.netherrack, { low: 0.14, cells: 5, grain: 8 });
    speckle(ctx, px, rng, S, [P.netherrack_dark], 18, 1, 0.8);
    cracks(ctx, px, rng, S, A(S, P.ember), 2, 14, 0.55); // Cinderloom ember veins
    cracks(ctx, px, rng, S, T(S, P.netherrack_dark), 2, 12, 0.6);
  },

  soul_sand(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, P.soul_sand, { low: 0.12, cells: 4, grain: 8 });
    const dk = T(S, P.soul_dark);
    ctx.fillStyle = css(dk, 0.9);
    for (let i = 0; i < 3; i++) { // trapped faces: eyes + mouth
      const fx = 3 + ((rng() * (px - 10)) | 0), fy = 3 + ((rng() * (px - 8)) | 0);
      pset(ctx, px, fx, fy, 2, 2); pset(ctx, px, fx + 4, fy, 2, 2);
      pset(ctx, px, fx + 1, fy + 4, 4, 1);
    }
    speckle(ctx, px, rng, S, [P.ember], 2, 1, 0.4, A); // faint ember flecks
  },

  glowstone(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, P.glowstone_base, { low: 0.12, cells: 4, grain: 7, tint: A });
    const nf = noiseField(rng, 5, px);
    const g1 = A(S, P.gold), g2 = A(S, P.gold_glow), g3 = A(S, P.gold_pale);
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const f = nf(x, y);
        if (f > 0.72) { ctx.fillStyle = css(g3); ctx.fillRect(x, y, 1, 1); }
        else if (f > 0.6) { ctx.fillStyle = css(g2); ctx.fillRect(x, y, 1, 1); }
        else if (f > 0.52) { ctx.fillStyle = css(g1, 0.85); ctx.fillRect(x, y, 1, 1); }
      }
    }
  },

  obsidian(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, P.obsidian, { low: 0.1, cells: 4, grain: 5 });
    ctx.fillStyle = css(A(S, P.obsidian_sheen), 0.7); // violet sheen (wrapped diagonals)
    for (let k = 0; k < 4; k++) {
      const x0 = (rng() * px) | 0, y0 = (rng() * px) | 0, len = 4 + ((rng() * 5) | 0);
      for (let i = 0; i < len; i++) pset(ctx, px, x0 + i, y0 + i, 1, 1);
    }
    speckle(ctx, px, rng, S, [P.obsidian_edge], 10, 1, 0.7);
    speckle(ctx, px, rng, S, [P.violet_lift], 3, 1, 0.5, A);
  },

  end_stone(ctx, px, rng, S) {
    voronoi(ctx, px, rng, S, { n: 7, base: P.end_stone, mortar: P.end_stone_deep, vary: 0.16, mortarWidth: 1.2, grain: 5 });
    speckle(ctx, px, rng, S, [P.end_stone_pale], 12, 1, 0.6);
  },

  purpur(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, P.purpur, { low: 0.07, cells: 4, grain: 5 });
    const lt = T(S, P.purpur_light), dk = T(S, P.purpur_dark);
    for (let by = 0; by < px; by += 8) { // 8px woven blocks (wraps: 32/8=4)
      for (let bx = 0; bx < px; bx += 8) {
        const even = (((bx + by) >> 3) & 1) === 0;
        if (even) { ctx.fillStyle = css(lt, 0.35); ctx.fillRect(bx + 1, by + 1, 6, 6); }
        ctx.fillStyle = css(dk, 0.8);
        ctx.fillRect(bx, by, 8, 1); ctx.fillRect(bx, by, 1, 8);
      }
    }
    speckle(ctx, px, rng, S, [P.violet_lift], 5, 1, 0.5);
  },

  red_sand(ctx, px, rng, S) { paintSand(ctx, px, rng, S, P.red_sand, P.red_sand_deep); },

  sandstone(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, P.sand, { low: 0.06, cells: 4, grain: 5 });
    const bands = [];
    for (let i = 0; i < 4; i++) bands.push(0.9 + rng() * 0.18);
    const cc = T(S, P.sand), dd = T(S, P.sand_deep);
    for (let y = 0; y < px; y++) { // horizontal strata, 8px bands (wrap)
      const b = bands[y >> 3];
      for (let x = 0; x < px; x++) {
        if (rng() < 0.5) continue;
        ctx.fillStyle = css(shade(cc, b), 0.55);
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.fillStyle = css(dd, 0.8);
    for (let r = 0; r < 4; r++) { // cracked strata dashes on band seams
      const y = r * 8 + 7;
      let x = (rng() * px) | 0;
      for (let k = 0; k < 3; k++) { pset(ctx, px, x, y, 4 + ((rng() * 4) | 0), 1); x += 9 + ((rng() * 5) | 0); }
    }
  },

  sandstone_top(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, P.sand, { low: 0.06, cells: 4, grain: 5 });
    const dd = T(S, P.sand_deep), oc = A(S, P.ochre);
    ctx.fillStyle = css(dd, 0.9);
    ctx.fillRect(2, 2, px - 4, 1); ctx.fillRect(2, px - 3, px - 4, 1);
    ctx.fillRect(2, 2, 1, px - 4); ctx.fillRect(px - 3, 2, 1, px - 4);
    // carved knot motif
    ctx.fillStyle = css(oc, 0.75);
    ctx.fillRect(12, 12, 8, 1); ctx.fillRect(12, 19, 8, 1);
    ctx.fillRect(12, 12, 1, 8); ctx.fillRect(19, 12, 1, 8);
    ctx.fillStyle = css(dd, 0.8);
    ctx.fillRect(15, 15, 2, 2);
  },

  lava(ctx, px, rng, S) {
    // Cinderloom swirl: quantized torus noise through the ember ramp.
    // (Liquid tile, but painted seamlessly anyway.)
    const nf = noiseField(rng, 4, px);
    const nf2 = noiseField(rng, 7, px);
    const ramp = [P.C[2], P.C[3], P.C[4], P.C[5], P.C[6]].map((c) => A(S, c));
    const core = A(S, P.C[7]);
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const f = nf(x, y) * 0.72 + nf2(x, y) * 0.28;
        if (f > 0.82) ctx.fillStyle = css(core);
        else ctx.fillStyle = css(ramp[Math.min(4, (f * 6.1) | 0)]);
        ctx.fillRect(x, y, 1, 1);
      }
    }
    speckle(ctx, px, rng, S, [P.C[7]], 4, 1, 0.9, A);
  },

  portal(ctx, px, rng, S) {
    // Violet swirl, semi-transparent (tiling-exempt art tile).
    const a1 = A(S, P.portal_a), a2 = A(S, P.portal_b), gl = A(S, P.portal_glow);
    ctx.fillStyle = css(A(S, P.N[1]), 0.55);
    ctx.fillRect(0, 0, px, px);
    const cx = px / 2, cy = px / 2;
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const dx = x - cx, dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        const ang = Math.atan2(dy, dx);
        const s = Math.sin(ang * 3 + r * 0.55);
        if (s > 0.55) { ctx.fillStyle = css(a2, 0.75); ctx.fillRect(x, y, 1, 1); }
        else if (s > 0.15) { ctx.fillStyle = css(a1, 0.6); ctx.fillRect(x, y, 1, 1); }
      }
    }
    ctx.fillStyle = css(gl, 0.9);
    for (let i = 0; i < 7; i++) pset(ctx, px, (rng() * px) | 0, (rng() * px) | 0, 1, 1);
  },

  // --- richer set ---

  birch_log_side(ctx, px, rng, S) {
    paintLogSide(ctx, px, rng, S, P.birch_bark, P.muslin, P.birch_bark_dark, 9);
  },
  birch_log_top(ctx, px, rng, S) {
    paintLogTop(ctx, px, rng, S, P.birch_bark, P.birch_plank, P.birch_plank_dark);
  },
  birch_planks(ctx, px, rng, S) { paintPlanks(ctx, px, rng, S, P.birch_plank, P.birch_plank_dark); },

  spruce_log_side(ctx, px, rng, S) {
    paintLogSide(ctx, px, rng, S, P.spruce_bark, P.spruce_bark_light, P.oak_bark_dark);
  },
  spruce_log_top(ctx, px, rng, S) {
    paintLogTop(ctx, px, rng, S, P.spruce_bark, P.spruce_plank, P.spruce_plank_dark);
  },
  spruce_planks(ctx, px, rng, S) { paintPlanks(ctx, px, rng, S, P.spruce_plank, P.spruce_plank_dark); },

  bricks(ctx, px, rng, S) {
    // 8x4 running bond; row parity offset 4 — wraps both axes (8 rows even).
    const bw = 8, bh = 4;
    const shadeLat = lattice(rng, 8); // per-brick shades (8 rows x 4 bricks)
    const bc = T(S, mix(P.madder, P.oak_bark, 0.45));
    const mc = T(S, P.gravel);
    const g = 5 * S.grain;
    for (let y = 0; y < px; y++) {
      const row = (y / bh) | 0;
      const off = (row & 1) * 4;
      for (let x = 0; x < px; x++) {
        const xx = (x + off) % px;
        const isMortar = (y % bh) === bh - 1 || (xx % bw) === bw - 1;
        const d = (rng() * 2 - 1) * g;
        if (isMortar) {
          ctx.fillStyle = css([mc[0] + d, mc[1] + d, mc[2] + d]);
        } else {
          const bi = (row % 8) * 8 + (((xx / bw) | 0) % 4);
          const f = 0.82 + shadeLat[bi % shadeLat.length] * 0.32;
          ctx.fillStyle = css([bc[0] * f + d, bc[1] * f + d, bc[2] * f + d]);
        }
        ctx.fillRect(x, y, 1, 1);
      }
    }
  },

  door_upper(ctx, px, rng, S) {
    // Door art (never terrain-tiled: tiling-exempt).
    paintPlanks(ctx, px, rng, S, P.oak_plank, P.oak_plank_dark);
    const dk = T(S, P.oak_bark_dark), lt = T(S, P.oak_plank);
    ctx.fillStyle = css(dk);
    ctx.fillRect(0, 0, px, 2); ctx.fillRect(0, 0, 2, px);
    ctx.fillRect(px - 2, 0, 2, px); ctx.fillRect(0, px - 2, px, 2);
    // 2x2 window, day-sky glass
    const gc = A(S, P.glass_tint);
    ctx.fillStyle = css(dk);
    ctx.fillRect(8, 6, 16, 14);
    ctx.fillStyle = css(gc, 0.85);
    ctx.fillRect(10, 8, 5, 4); ctx.fillRect(17, 8, 5, 4);
    ctx.fillRect(10, 14, 5, 4); ctx.fillRect(17, 14, 5, 4);
    ctx.fillStyle = css(A(S, P.snow_sparkle), 0.8);
    ctx.fillRect(11, 9, 1, 1); ctx.fillRect(18, 15, 1, 1);
    ctx.fillStyle = css(lt, 0.6);
    ctx.fillRect(3, 24, px - 6, 1);
  },

  door_lower(ctx, px, rng, S) {
    paintPlanks(ctx, px, rng, S, P.oak_plank, P.oak_plank_dark);
    const dk = T(S, P.oak_bark_dark), lt = T(S, mix(P.oak_plank, P.muslin, 0.25));
    ctx.fillStyle = css(dk);
    ctx.fillRect(0, 0, px, 2); ctx.fillRect(0, 0, 2, px);
    ctx.fillRect(px - 2, 0, 2, px); ctx.fillRect(0, px - 2, px, 2);
    // two recessed panels
    for (const [pxx, pyy] of [[6, 5], [6, 18]]) {
      ctx.fillStyle = css(dk, 0.9);
      ctx.fillRect(pxx, pyy, 20, 9);
      ctx.fillStyle = css(T(S, P.oak_plank_dark));
      ctx.fillRect(pxx + 1, pyy + 1, 18, 7);
      ctx.fillStyle = css(lt, 0.5);
      ctx.fillRect(pxx + 1, pyy + 1, 18, 1);
    }
    ctx.fillStyle = css(A(S, P.gold)); // Everthread-gold knob
    ctx.fillRect(26, 14, 2, 2);
    ctx.fillStyle = css(A(S, P.gold_glow));
    ctx.fillRect(26, 14, 1, 1);
  },

  torch(ctx, px, rng, S) {
    // Stick + bright head on transparent bg (tiling-exempt).
    const wood = T(S, P.oak_plank), woodDk = T(S, P.oak_plank_dark);
    for (let y = 13; y < px; y++) {
      ctx.fillStyle = css(wood);
      ctx.fillRect(14, y, 4, 1);
      ctx.fillStyle = css(woodDk);
      ctx.fillRect(17, y, 1, 1);
      if (y % 5 === 0) { ctx.fillStyle = css(woodDk, 0.7); ctx.fillRect(14, y, 4, 1); }
    }
    const g1 = A(S, P.ember_flare), g2 = A(S, P.gold_glow), g3 = A(S, P.gold_pale);
    ctx.fillStyle = css(A(S, P.ember_hot), 0.35); // halo
    ctx.fillRect(11, 4, 10, 11);
    ctx.fillStyle = css(g1);
    ctx.fillRect(12, 6, 8, 8);
    ctx.fillStyle = css(g2);
    ctx.fillRect(13, 7, 6, 6);
    ctx.fillStyle = css(g3);
    ctx.fillRect(14, 8, 4, 4);
    for (let i = 0; i < 3; i++) { // sparks
      ctx.fillStyle = css(g2, 0.9);
      ctx.fillRect(12 + ((rng() * 8) | 0), 3 + ((rng() * 3) | 0), 1, 1);
    }
  },

  lantern(ctx, px, rng, S) {
    // Hanging iron-cage lantern with an Everthread-gold glowing core, on a
    // transparent bg (tiling-exempt art tile, same convention as torch).
    const frame = T(S, P.iron_dark), glint = T(S, P.iron_glint);
    const g1 = A(S, P.gold), g2 = A(S, P.gold_glow), g3 = A(S, P.gold_pale);
    // Halo behind the cage so the glow reads at a distance.
    ctx.fillStyle = css(A(S, P.ember_hot), 0.28);
    ctx.fillRect(9, 9, 14, 16);
    // Hook + hanger ring.
    ctx.fillStyle = css(frame);
    ctx.fillRect(15, 3, 2, 3);
    ctx.fillRect(13, 6, 6, 2);
    // Cage body: vertical bars + top/bottom caps around the glass core.
    ctx.fillRect(10, 8, 12, 2);   // top cap
    ctx.fillRect(10, 24, 12, 2);  // bottom cap
    ctx.fillRect(10, 8, 2, 18);   // left bar
    ctx.fillRect(20, 8, 2, 18);   // right bar
    ctx.fillRect(15, 8, 2, 18);   // centre bar
    // Glowing core between the bars.
    ctx.fillStyle = css(g1);
    ctx.fillRect(12, 10, 8, 14);
    ctx.fillStyle = css(g2);
    ctx.fillRect(13, 11, 6, 12);
    ctx.fillStyle = css(g3);
    ctx.fillRect(14, 13, 4, 8);
    // Re-stroke the centre bar over the glow, plus glints on the caps.
    ctx.fillStyle = css(frame, 0.9);
    ctx.fillRect(15, 10, 2, 14);
    ctx.fillStyle = css(glint, 0.7);
    ctx.fillRect(10, 8, 12, 1);
    for (let i = 0; i < 2; i++) { // stray sparks under the base
      ctx.fillStyle = css(g2, 0.8);
      ctx.fillRect(12 + ((rng() * 8) | 0), 27 + ((rng() * 2) | 0), 1, 1);
    }
  },

  gem_ore(ctx, px, rng, S) {
    stoneBase(ctx, px, rng, S);
    oreBlobs(ctx, px, rng, S, { main: P.gem, dark: P.gem_dark, glint: P.gem_glint, shape: 'ring', n: 5 });
  },

  everthread_ore(ctx, px, rng, S) {
    stoneBase(ctx, px, rng, S);
    // Glowing thread-gold veins: wrapped wander paths with glow halo + knots.
    const gold = A(S, P.gold), glow = A(S, P.gold_glow), pale = A(S, P.gold_pale);
    for (let v = 0; v < (S.patterns ? 2 : 3); v++) {
      const pts = wander(rng, px, 16);
      ctx.fillStyle = css(glow, 0.4);
      for (const [x, y] of pts) { pset(ctx, px, x + 1, y, 1, 1); pset(ctx, px, x, y + 1, 1, 1); }
      ctx.fillStyle = css(gold);
      for (const [x, y] of pts) pset(ctx, px, x, y, 1, 1);
      const [nx, ny] = pts[(pts.length / 2) | 0];
      ctx.fillStyle = css(glow);
      pset(ctx, px, nx, ny, 2, 2);
      ctx.fillStyle = css(pale);
      pset(ctx, px, nx, ny, 1, 1);
    }
    if (S.patterns) { // Loudstone: zigzag stamps to set it apart by shape too
      oreBlobs(ctx, px, rng, S, { main: P.gold, dark: P.gold_dark, glint: P.gold_pale, shape: 'zigzag', n: 2 });
    }
  },

  thread_block(ctx, px, rng, S) {
    // Stitched-thread bundle: yarn rows with visible over-stitches.
    fillBase(ctx, px, rng, S, P.thread_base, { low: 0.06, cells: 5, grain: 4 });
    const sh = T(S, P.thread_shadow), dp = T(S, P.thread_deep), au = A(S, P.gold);
    for (let y = 0; y < px; y++) {
      const ry = y & 3;
      if (ry === 3) { // groove between yarn rows
        ctx.fillStyle = css(dp, 0.6);
        ctx.fillRect(0, y, px, 1);
      } else if (ry === 0) {
        ctx.fillStyle = css(sh, 0.4);
        ctx.fillRect(0, y, px, 1);
      }
    }
    for (let row = 0; row < 8; row++) { // twist dashes per yarn row (period 8)
      const y = row * 4 + 1;
      ctx.fillStyle = css(sh, 0.75);
      for (let x = 0; x < px; x++) {
        if (((x + row * 5) & 7) < 2) pset(ctx, px, x, y, 1, 1);
      }
    }
    // gold cross-stitches (the Everthread runs through)
    ctx.fillStyle = css(au);
    for (let row = 0; row < 4; row++) {
      const y = row * 8 + 2;
      const x0 = (row * 9 + 3) % px;
      pset(ctx, px, x0, y, 1, 1); pset(ctx, px, x0 + 1, y + 1, 1, 1); pset(ctx, px, x0 + 2, y, 1, 1);
    }
  },

  weave_block(ctx, px, rng, S) {
    // Over-under basket weave: 4px checker of warp(gold-weld)/weft(violet).
    const wa = T(S, P.weave_warp), wad = T(S, P.weave_warp_dark);
    const we = T(S, P.weave_weft), wed = T(S, P.weave_weft_dark);
    const prof = [0.78, 1.0, 1.06, 0.86];
    const g = 4 * S.grain;
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const horiz = ((((x >> 2) + (y >> 2)) & 1) === 0);
        const t = horiz ? (y & 3) : (x & 3);
        const s = horiz ? (x & 3) : (y & 3);
        const base = horiz ? wa : we;
        const dark = horiz ? wad : wed;
        let c = mix(dark, base, prof[t]);
        if (s === 3) c = mix(c, dark, 0.5); // strand end tucks under
        const d = (rng() * 2 - 1) * g;
        ctx.fillStyle = css([c[0] + d, c[1] + d, c[2] + d]);
        ctx.fillRect(x, y, 1, 1);
      }
    }
  },

  loom_block(ctx, px, rng, S) {
    // Loom face: wooden frame, dark shed, taut warp threads, gold shuttle line.
    fillBase(ctx, px, rng, S, P.loom_frame, { low: 0.07, cells: 4, grain: 5 });
    const fl = T(S, P.loom_frame_light), fd = T(S, P.spruce_plank_dark);
    ctx.fillStyle = css(fl, 0.7);
    ctx.fillRect(0, 0, px, 1); ctx.fillRect(0, 0, 1, px);
    ctx.fillStyle = css(fd, 0.8);
    ctx.fillRect(0, px - 1, px, 1); ctx.fillRect(px - 1, 0, 1, px);
    // shed (interior)
    ctx.fillStyle = css(T(S, P.loom_bed));
    ctx.fillRect(4, 4, px - 8, px - 8);
    // warp threads every 3px
    const th = T(S, P.thread_base), thd = T(S, P.thread_shadow);
    for (let x = 5; x < px - 4; x += 3) {
      ctx.fillStyle = css(th);
      ctx.fillRect(x, 4, 1, px - 8);
      ctx.fillStyle = css(thd, 0.5);
      ctx.fillRect(x, 6 + (x % 5), 1, 1); // tension shimmer
    }
    // gold shuttle mid-bar
    ctx.fillStyle = css(A(S, P.gold));
    ctx.fillRect(4, 15, px - 8, 2);
    ctx.fillStyle = css(A(S, P.gold_glow));
    ctx.fillRect(6, 15, 4, 1);
    // corner pegs
    ctx.fillStyle = css(A(S, P.gold_dark));
    for (const [cxx, cyy] of [[1, 1], [px - 3, 1], [1, px - 3], [px - 3, px - 3]]) ctx.fillRect(cxx, cyy, 2, 2);
  },

  wool_white(ctx, px, rng, S) { paintWool(ctx, px, rng, S, P.wool.white); },
  wool_red(ctx, px, rng, S) { paintWool(ctx, px, rng, S, P.wool.red); },
  wool_blue(ctx, px, rng, S) { paintWool(ctx, px, rng, S, P.wool.blue); },
  wool_green(ctx, px, rng, S) { paintWool(ctx, px, rng, S, P.wool.green); },
  wool_yellow(ctx, px, rng, S) { paintWool(ctx, px, rng, S, P.wool.yellow); },
  wool_black(ctx, px, rng, S) { paintWool(ctx, px, rng, S, P.wool.black); },

  portal_frame(ctx, px, rng, S) {
    // Obsidian body + glowing hemstone chips. The ONLY tile family allowed to
    // gleam Nevermend cyan (brand oath: cyan means beyond the hem).
    fillBase(ctx, px, rng, S, P.obsidian, { low: 0.1, cells: 4, grain: 5 });
    speckle(ctx, px, rng, S, [P.obsidian_edge], 8, 1, 0.7);
    const chip = A(S, P.hemstone), core = A(S, P.hemstone_pale), halo = A(S, P.N[5]);
    for (let k = 0; k < 5; k++) {
      // Chips stay inset from the tile edges: a bright discrete feature cut
      // by the wrap line would read as a seam when the tile repeats.
      const x = 2 + ((rng() * (px - 7)) | 0), y = 2 + ((rng() * (px - 7)) | 0);
      ctx.fillStyle = css(halo, 0.45);
      pset(ctx, px, x - 1, y, 4, 2); pset(ctx, px, x, y - 1, 2, 4);
      ctx.fillStyle = css(chip);
      pset(ctx, px, x, y, 2, 2);
      ctx.fillStyle = css(core);
      pset(ctx, px, x, y, 1, 1);
    }
    ctx.fillStyle = css(A(S, P.obsidian_sheen), 0.6);
    for (let k = 0; k < 3; k++) {
      const x0 = (rng() * px) | 0, y0 = (rng() * px) | 0;
      for (let i = 0; i < 5; i++) pset(ctx, px, x0 + i, y0 + i, 1, 1);
    }
  },
};

// ---------------------------------------------------------------------------
// Painter lookup with warn-once + magenta/black 'missing' fallback.
// ---------------------------------------------------------------------------
const warnedPainters = new Set();

export function getPainter(name) {
  const fn = PAINTERS[name];
  if (fn) return fn;
  if (!warnedPainters.has(name)) {
    warnedPainters.add(name);
    console.warn(`painters: unknown tile name "${name}" — using missing-texture painter`);
  }
  return (ctx, px) => paintMissing(ctx, px);
}

export { paintMissing };

// ---------------------------------------------------------------------------
// Pack-level post passes (Threadbare weave/fray/sheen, Gritty edge wear,
// Loudstone outline). Pixel ops via getImageData so alpha is respected —
// overlays never paint over fully transparent pixels.
// ---------------------------------------------------------------------------
export function applyOverlays(ctx, px, rng, S) {
  if (!(S.weave || S.fray || S.edge || S.outline || S.sheen || S.dither)) return;
  const img = ctx.getImageData(0, 0, px, px);
  const d = img.data;
  const mul = (i, f) => {
    d[i] = cl(d[i] * f); d[i + 1] = cl(d[i + 1] * f); d[i + 2] = cl(d[i + 2] * f);
  };
  const prof = [0.86, 1.0, 1.07, 0.9]; // strand cross-profile (period 4, wraps)

  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const i = (y * px + x) * 4;
      if (!d[i + 3]) continue;
      if (S.weave) {
        const horiz = ((((x >> 2) + (y >> 2)) & 1) === 0);
        const t = horiz ? (y & 3) : (x & 3);
        const s = horiz ? (x & 3) : (y & 3);
        let f = 1 + (prof[t] - 1) * S.weave;
        if (s === 3) f *= 1 - 0.1 * S.weave;
        mul(i, f);
      }
      if (S.dither && ((x + y) & 1)) mul(i, 1 - 0.07 * S.dither);
      if (S.sheen) {
        const k = (x - y) & 15; // 32 % 16 == 0 -> wraps
        if (k === 0) mul(i, 1 + 0.14 * S.sheen);
        else if (k === 1) mul(i, 1 + 0.07 * S.sheen);
      }
    }
  }

  if (S.fray || S.edge) {
    // Frayed / weathered edge pixels. Each random decision is applied to BOTH
    // opposite edges at once, so when the tile repeats the frayed pattern on
    // the right edge continues into the left edge of the next copy — the wear
    // itself tiles seamlessly instead of creating a seam line.
    const rate0 = 0.4 * S.fray + 0.3 * S.edge;
    const rate1 = 0.16 * S.fray + 0.12 * S.edge;
    const fuzzPair = (xa, ya, xb, yb, r) => {
      let f = 0;
      if (rng() < r) f = 0.72 + rng() * 0.12;
      else if (rng() < r * 0.5) f = 1.1;
      if (!f) return;
      const ia = (ya * px + xa) * 4, ib = (yb * px + xb) * 4;
      if (d[ia + 3]) mul(ia, f);
      if (d[ib + 3]) mul(ib, f);
    };
    for (let x = 0; x < px; x++) {
      fuzzPair(x, 0, x, px - 1, rate0);
      fuzzPair(x, 1, x, px - 2, rate1);
    }
    for (let y = 0; y < px; y++) {
      fuzzPair(0, y, px - 1, y, rate0);
      fuzzPair(1, y, px - 2, y, rate1);
    }
  }

  if (S.outline) {
    const w = S.outline | 0;
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        if (x >= w && x < px - w && y >= w && y < px - w) continue;
        const i = (y * px + x) * 4;
        if (!d[i + 3]) continue;
        const outer = x === 0 || y === 0 || x === px - 1 || y === px - 1;
        mul(i, outer ? 0.5 : 0.62);
      }
    }
  }

  ctx.putImageData(img, 0, 0);
}
