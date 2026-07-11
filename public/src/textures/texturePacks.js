// Voxelheim procedural texture packs.
//
// PURE module: no `three` import — safe to load under plain node.
//
// Exports:
//   PACKS       — { default, smooth, gritty }, each { id, name, drawTile(ctx, name, px, rng) }
//   makeRng     — deterministic string-seeded PRNG (xmur3 hash -> mulberry32)
//   TILE_NAMES  — canonical ordered tile list (re-exported by TextureAtlas.js,
//                 which is the contract entry point for it)
//
// drawTile renders one tile into ctx at (0,0)..(px,px). It clears that rect
// first, so transparent tiles (glass, leaves holes, water, portal) come out
// with real alpha. The atlas builder clips the ctx to the tile rect, but the
// painters also stay in-bounds on their own.

// ---------------------------------------------------------------------------
// Tile list. Order is stable and part of the atlas layout — append only.
// Includes every tile referenced by blocks.js plus "portal" (reserved for the
// portal block, id 29, added by the dimensions phase).
// ---------------------------------------------------------------------------
export const TILE_NAMES = [
  'grass_top', 'grass_side', 'dirt', 'stone', 'sand', 'water',
  'log_top', 'log_side', 'leaves', 'planks', 'glass', 'cobblestone',
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'bedrock', 'snow',
  'snow_side', 'cactus_top', 'cactus_side', 'gravel', 'netherrack',
  'soul_sand', 'glowstone', 'obsidian', 'end_stone', 'purpur', 'red_sand',
  'sandstone', 'sandstone_top', 'lava', 'portal',
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
const css = (c, a = 1) => `rgba(${cl(c[0])},${cl(c[1])},${cl(c[2])},${a})`;
const lighten = (c, f) => [c[0] * f, c[1] * f, c[2] * f];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function tintWith(c, sat, light, contrast) {
  const l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const out = new Array(3);
  for (let i = 0; i < 3; i++) {
    let v = l + (c[i] - l) * sat;   // saturation about luma
    v *= light;                     // brightness
    v = 128 + (v - 128) * contrast; // contrast about mid-gray
    out[i] = v;
  }
  return out;
}
// Full pack tint for base/ground colors.
const T = (S, c) => tintWith(c, S.sat, S.light, S.contrast);
// Milder tint for accent features (ore nuggets, lava veins, glow, swirls) so
// they keep their identity even in the desaturated gritty pack.
const A = (S, c) => tintWith(c, 1 - (1 - S.sat) * 0.35, 1 - (1 - S.light) * 0.5, 1);

// ---------------------------------------------------------------------------
// Pack style knobs.
//   grain     — per-pixel noise multiplier
//   gradients — soft gradient bases + radial blotches (smooth pack)
//   wear      — cracks/scratch overlay (gritty pack)
//   sat/light/contrast — palette character
// ---------------------------------------------------------------------------
const STYLES = {
  default: { sat: 1.00, light: 1.00, contrast: 1.00, grain: 1.0, gradients: false, wear: 0 },
  smooth:  { sat: 1.38, light: 1.14, contrast: 0.82, grain: 0.1, gradients: true,  wear: 0 },
  gritty:  { sat: 0.50, light: 0.80, contrast: 1.30, grain: 1.7, gradients: false, wear: 1 },
};

// ---------------------------------------------------------------------------
// Painting primitives.
// ---------------------------------------------------------------------------

/** Opaque base fill: gradient (smooth) or flat + per-pixel grain.
 *  `tintFn` defaults to the full pack tint T; pass A for emissive bases
 *  (glowstone, lava) that must stay vivid in the desaturated gritty pack. */
function fillBase(ctx, px, rng, S, c, amp = 10, cell = 1, tintFn = T) {
  const cc = tintFn(S, c);
  if (S.gradients) {
    const g = ctx.createLinearGradient(0, 0, 0, px);
    g.addColorStop(0, css(lighten(cc, 1.10)));
    g.addColorStop(1, css(lighten(cc, 0.88)));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, px, px);
  } else {
    ctx.fillStyle = css(cc);
    ctx.fillRect(0, 0, px, px);
  }
  const a = amp * S.grain;
  if (a >= 2) {
    for (let y = 0; y < px; y += cell) {
      for (let x = 0; x < px; x += cell) {
        const d = (rng() * 2 - 1) * a;
        if (Math.abs(d) < a * 0.3) continue;
        ctx.fillStyle = css([cc[0] + d, cc[1] + d, cc[2] + d]);
        ctx.fillRect(x, y, cell, cell);
      }
    }
  }
}

/** Scatter single pixels/squares from a color list. */
function speckle(ctx, px, rng, S, colors, count, size = 1, alpha = 1) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = css(T(S, colors[(rng() * colors.length) | 0]), alpha);
    ctx.fillRect((rng() * (px - size + 1)) | 0, (rng() * (px - size + 1)) | 0, size, size);
  }
}

/** Soft blob at a random spot: radial gradient (smooth) or pixel cluster. */
function blotch(ctx, px, rng, S, c, r, alpha, tinted = true) {
  const x = rng() * px, y = rng() * px;
  const cc = tinted ? T(S, c) : c;
  if (S.gradients) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, css(cc, alpha));
    g.addColorStop(1, css(cc, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = css(cc, alpha);
    const n = (r * r * 2.4) | 0;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, d = rng() * r;
      ctx.fillRect((x + Math.cos(a) * d) | 0, (y + Math.sin(a) * d) | 0, 1, 1);
    }
  }
}

/** Random-walk path of points; used for cracks, veins. */
function wander(rng, px, steps, margin = 0) {
  const pts = [];
  let x = margin + rng() * (px - margin * 2);
  let y = margin + rng() * (px - margin * 2);
  let dir = rng() * Math.PI * 2;
  for (let i = 0; i < steps; i++) {
    pts.push([x, y]);
    dir += (rng() - 0.5) * 1.1;
    x += Math.cos(dir);
    y += Math.sin(dir);
    if (x < 0 || y < 0 || x >= px || y >= px) break;
  }
  return pts;
}

/** 1px meandering crack line. `raw` colors skip pack tinting (overlays). */
function crackLine(ctx, px, rng, c, alpha, steps) {
  const pts = wander(rng, px, steps);
  ctx.fillStyle = css(c, alpha);
  for (const [x, y] of pts) ctx.fillRect(x | 0, y | 0, 1, 1);
}

/** Straight pixel streak (diagonal glints, sheens). */
function streak(ctx, x0, y0, dx, dy, len, c, alpha, w = 1) {
  ctx.fillStyle = css(c, alpha);
  let x = x0, y = y0;
  for (let i = 0; i < len; i++) {
    ctx.fillRect(x | 0, y | 0, w, w);
    x += dx; y += dy;
  }
}

/** Ore = pack stone base + clustered nuggets with highlight/shadow pixels. */
function oreNuggets(ctx, px, rng, S, main, hi, dark) {
  const clusters = 3 + ((rng() * 2) | 0);
  for (let ci = 0; ci < clusters; ci++) {
    const cx = 4 + rng() * (px - 10), cy = 4 + rng() * (px - 10);
    const n = 3 + ((rng() * 3) | 0);
    for (let i = 0; i < n; i++) {
      const x = cl2(cx + rng() * 5 - 2.5, 1, px - 4) | 0;
      const y = cl2(cy + rng() * 5 - 2.5, 1, px - 4) | 0;
      ctx.fillStyle = css(A(S, dark));
      ctx.fillRect(x + 1, y + 1, 2, 2);
      ctx.fillStyle = css(A(S, main));
      ctx.fillRect(x, y, 2, 2);
      if (rng() < 0.5) { // chunkier lobe
        ctx.fillStyle = css(A(S, main));
        ctx.fillRect(x + 2, y + ((rng() * 2) | 0), 1, 1);
      }
      ctx.fillStyle = css(A(S, hi));
      ctx.fillRect(x, y, 1, 1);
    }
  }
}
const cl2 = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Palette constants shared by painters.
// ---------------------------------------------------------------------------
const C = {
  grass:      [98, 155, 60],
  grassLite:  [150, 200, 80],
  grassDark:  [62, 110, 44],
  dirt:       [134, 96, 66],
  dirtDark:   [104, 72, 48],
  dirtLite:   [158, 118, 82],
  stone:      [127, 127, 127],
  sand:       [219, 203, 158],
  redSand:    [186, 110, 54],
  bark:       [110, 84, 54],
  wood:       [196, 158, 102],
  plank:      [178, 140, 86],
  leaf:       [70, 122, 48],
  waterBase:  [52, 108, 196],
  snow:       [238, 244, 250],
};

// ---------------------------------------------------------------------------
// Per-tile painters: paint(ctx, px, rng, S). All layered art, no raw noise.
// ---------------------------------------------------------------------------
const PAINTERS = {

  grass_top(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, C.grass, 12);
    for (let i = 0; i < 6; i++) blotch(ctx, px, rng, S, mix(C.grass, C.grassLite, 0.7), 2.5 + rng() * 4, 0.5);
    for (let i = 0; i < 5; i++) blotch(ctx, px, rng, S, C.grassDark, 2 + rng() * 4, 0.45);
    speckle(ctx, px, rng, S, [[172, 212, 92], [128, 184, 70]], 46, 1);
    speckle(ctx, px, rng, S, [[52, 96, 40]], 26, 1);
  },

  grass_side(ctx, px, rng, S) {
    PAINTERS.dirt(ctx, px, rng, S);
    // Grass fringe hanging over the TOP edge of the face (canvas y=0 = block
    // top; see the UV convention note in TextureAtlas.js).
    const gLite = T(S, C.grassLite), gMid = T(S, C.grass), gDark = T(S, C.grassDark);
    for (let x = 0; x < px; x++) {
      let h = 4 + ((rng() * 4) | 0);              // 4..7 px fringe
      const strand = rng() < 0.22 ? 2 + ((rng() * 2) | 0) : 0; // dangling strand
      for (let y = 0; y < h; y++) {
        const c = y < 2 ? gLite : gMid;
        ctx.fillStyle = css([c[0] + (rng() * 14 - 7), c[1] + (rng() * 14 - 7), c[2] + (rng() * 10 - 5)]);
        ctx.fillRect(x, y, 1, 1);
      }
      ctx.fillStyle = css(gDark);
      ctx.fillRect(x, h - 1, 1, 1);
      if (strand) {
        ctx.fillStyle = css(gDark, 0.9);
        ctx.fillRect(x, h, 1, strand);
      }
    }
  },

  dirt(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, C.dirt, 12);
    for (let i = 0; i < 7; i++) blotch(ctx, px, rng, S, C.dirtDark, 2 + rng() * 3.5, 0.55);
    for (let i = 0; i < 6; i++) blotch(ctx, px, rng, S, C.dirtLite, 2 + rng() * 3, 0.5);
    speckle(ctx, px, rng, S, [[90, 62, 40]], 20, 1);
    speckle(ctx, px, rng, S, [[150, 148, 142]], 5, 2, 0.8); // tiny stones
  },

  stone(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, C.stone, 9);
    for (let i = 0; i < 6; i++) blotch(ctx, px, rng, S, [104, 104, 106], 2.5 + rng() * 4, 0.5);
    for (let i = 0; i < 5; i++) blotch(ctx, px, rng, S, [148, 148, 150], 2 + rng() * 3.5, 0.45);
    for (let i = 0; i < 3; i++) crackLine(ctx, px, rng, T(S, [86, 86, 88]), 0.8, 8 + rng() * 10);
    speckle(ctx, px, rng, S, [[160, 160, 162]], 12, 1, 0.8);
  },

  cobblestone(ctx, px, rng, S) {
    // Dark mortar background.
    fillBase(ctx, px, rng, S, [52, 50, 48], 6);
    const cell = px / 3;
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        const x = gx * cell + cell / 2 + (rng() * 4 - 2);
        const y = gy * cell + cell / 2 + (rng() * 4 - 2);
        const rx = cell * (0.44 + rng() * 0.12), ry = cell * (0.40 + rng() * 0.12);
        const g = 94 + rng() * 52;
        const stone = T(S, [g, g, g + 3]);
        // mortar-shadow outline ring
        ctx.fillStyle = css(T(S, [34, 32, 30]), 0.9);
        ellipse(ctx, x + 0.4, y + 0.7, rx + 1, ry + 1);
        // shaded lower body, then main body restoring the upper-left
        ctx.fillStyle = css(lighten(stone, 0.74));
        ellipse(ctx, x, y, rx, ry);
        ctx.fillStyle = css(stone);
        ellipse(ctx, x - rx * 0.12, y - ry * 0.16, rx * 0.86, ry * 0.84);
        // small top-left highlight
        ctx.fillStyle = css(lighten(stone, 1.22), 0.55);
        ellipse(ctx, x - rx * 0.3, y - ry * 0.36, rx * 0.36, ry * 0.3);
        if (!S.gradients) {
          // pixel-grain the stone face a little
          for (let i = 0; i < 7; i++) {
            const d = (rng() * 2 - 1) * 14;
            ctx.fillStyle = css([stone[0] + d, stone[1] + d, stone[2] + d], 0.8);
            ctx.fillRect((x + (rng() * 2 - 1) * rx * 0.7) | 0, (y + (rng() * 2 - 1) * ry * 0.7) | 0, 1, 1);
          }
        }
      }
    }
  },

  sand(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, C.sand, 9);
    speckle(ctx, px, rng, S, [[236, 224, 182], [228, 214, 170]], 40, 1);
    speckle(ctx, px, rng, S, [[190, 172, 128], [178, 158, 116]], 34, 1);
    speckle(ctx, px, rng, S, [[168, 148, 108]], 5, 2, 0.85); // pebbles
    for (let i = 0; i < 3; i++) blotch(ctx, px, rng, S, [206, 188, 140], 3 + rng() * 4, 0.4);
  },

  red_sand(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, C.redSand, 10);
    speckle(ctx, px, rng, S, [[206, 132, 70], [214, 144, 82]], 38, 1);
    speckle(ctx, px, rng, S, [[156, 86, 42], [140, 76, 38]], 32, 1);
    for (let i = 0; i < 3; i++) blotch(ctx, px, rng, S, [170, 96, 46], 3 + rng() * 4, 0.4);
    speckle(ctx, px, rng, S, [[120, 62, 30]], 4, 2, 0.85);
  },

  sandstone(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, [216, 196, 148], 6);
    // Horizontal strata bands with jittered seams.
    let y = 0, k = 0;
    while (y < px) {
      const h = 4 + ((rng() * 4) | 0);
      const f = k % 2 === 0 ? 1.09 : 0.88;
      ctx.fillStyle = css(T(S, lighten([216, 196, 148], f)), 0.75);
      ctx.fillRect(0, y, px, h);
      // seam row
      ctx.fillStyle = css(T(S, [158, 132, 88]), 0.9);
      for (let x = 0; x < px; x++) ctx.fillRect(x, y + h - 1 + (rng() < 0.2 ? 1 : 0), 1, 1);
      y += h; k++;
    }
    speckle(ctx, px, rng, S, [[232, 214, 168]], 20, 1);
    speckle(ctx, px, rng, S, [[190, 168, 120]], 16, 1);
  },

  sandstone_top(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, [222, 204, 156], 5);
    for (let i = 0; i < 4; i++) blotch(ctx, px, rng, S, [206, 186, 136], 3 + rng() * 4, 0.35);
    // carved inset frame
    ctx.strokeStyle = css(T(S, [184, 162, 112]), 0.7);
    ctx.lineWidth = 1;
    ctx.strokeRect(2.5, 2.5, px - 5, px - 5);
    ctx.strokeStyle = css(T(S, [238, 222, 176]), 0.6);
    ctx.strokeRect(3.5, 3.5, px - 7, px - 7);
    speckle(ctx, px, rng, S, [[210, 190, 142]], 14, 1);
  },

  gravel(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, [122, 118, 114], 10);
    for (let i = 0; i < 30; i++) {
      const x = (rng() * (px - 3)) | 0, y = (rng() * (px - 3)) | 0;
      const g = 84 + rng() * 84;
      const brown = rng() < 0.25;
      const c = T(S, brown ? [g + 16, g - 2, g - 18] : [g, g, g + 2]);
      const w = 2 + ((rng() * 2) | 0), h = 2 + ((rng() * 2) | 0);
      ctx.fillStyle = css(lighten(c, 0.6));
      ctx.fillRect(x + 1, y + 1, w, h);       // under-shadow
      ctx.fillStyle = css(c);
      ctx.fillRect(x, y, w, h);               // pebble
      ctx.fillStyle = css(lighten(c, 1.3), 0.8);
      ctx.fillRect(x, y, 1, 1);               // glint
    }
  },

  water(ctx, px, rng, S) {
    // Translucent — keep alpha ~0.7 overall. No opaque speckle here.
    ctx.fillStyle = css(T(S, C.waterBase), 0.62);
    ctx.fillRect(0, 0, px, px);
    for (let k = 0; k < 5; k++) {
      const y0 = k * (px / 5) + rng() * 3;
      const phase = rng() * Math.PI * 2;
      const bright = k % 2 === 0;
      const c = T(S, bright ? [150, 200, 240] : [20, 56, 138]);
      ctx.fillStyle = css(c, bright ? 0.42 : 0.38);
      for (let x = 0; x < px; x++) {
        const y = y0 + Math.sin((x / px) * Math.PI * 3 + phase) * 1.8;
        ctx.fillRect(x, y | 0, 1, 2);
      }
    }
    // sparse sparkles
    ctx.fillStyle = css(T(S, [210, 235, 255]), 0.4);
    for (let i = 0; i < 6; i++) ctx.fillRect((rng() * px) | 0, (rng() * px) | 0, 1, 1);
  },

  lava(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, [56, 14, 8], 8);
    for (let i = 0; i < 4; i++) blotch(ctx, px, rng, S, [30, 8, 4], 3 + rng() * 3, 0.6); // dark crust
    // Bright flow veins: wide orange body + yellow core.
    for (let v = 0; v < 4; v++) {
      const pts = wander(rng, px, 22 + ((rng() * 10) | 0), 2);
      ctx.fillStyle = css(A(S, [214, 92, 12]), 0.9);
      for (const [x, y] of pts) ctx.fillRect((x - 1) | 0, (y - 1) | 0, 3, 3);
      ctx.fillStyle = css(A(S, [252, 150, 24]));
      for (const [x, y] of pts) ctx.fillRect(x | 0, y | 0, 2, 2);
      ctx.fillStyle = css(A(S, [255, 224, 96]));
      for (const [x, y] of pts) ctx.fillRect(x | 0, y | 0, 1, 1);
    }
    // glow embers
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = css(A(S, [255, 196, 64]), 0.7);
      ctx.fillRect((rng() * px) | 0, (rng() * px) | 0, 1, 1);
    }
  },

  log_side(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, C.bark, 8);
    // Vertical bark striations.
    for (let i = 0; i < 26; i++) {
      const x = (rng() * px) | 0;
      const y0 = (rng() * px) | 0;
      const len = 6 + ((rng() * 12) | 0);
      const dark = rng() < 0.55;
      ctx.fillStyle = css(T(S, dark ? [82, 60, 38] : [140, 108, 72]), 0.85);
      ctx.fillRect(x, y0, 1, Math.min(len, px - y0));
    }
    // Edge shading so stacked logs read as columns.
    ctx.fillStyle = css(T(S, [76, 56, 36]), 0.7);
    ctx.fillRect(0, 0, 1, px);
    ctx.fillRect(px - 1, 0, 1, px);
    // A knot, sometimes.
    if (rng() < 0.6) {
      const kx = 6 + rng() * (px - 12), ky = 6 + rng() * (px - 12);
      ctx.fillStyle = css(T(S, [70, 50, 32]));
      ellipse(ctx, kx, ky, 2.4, 3.2);
      ctx.fillStyle = css(T(S, [128, 98, 64]));
      ellipse(ctx, kx, ky, 1.1, 1.6);
    }
  },

  log_top(ctx, px, rng, S) {
    // Bark rim.
    fillBase(ctx, px, rng, S, C.bark, 9);
    // Inner cut face.
    const inset = 3;
    ctx.fillStyle = css(T(S, C.wood));
    ctx.fillRect(inset, inset, px - inset * 2, px - inset * 2);
    if (!S.gradients) {
      // grain the face
      const w = T(S, C.wood);
      for (let y = inset; y < px - inset; y++) {
        for (let x = inset; x < px - inset; x++) {
          const d = (rng() * 2 - 1) * 7 * S.grain;
          if (Math.abs(d) < 2) continue;
          ctx.fillStyle = css([w[0] + d, w[1] + d, w[2] + d]);
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    // Concentric growth rings, slightly off-center.
    const cx = px / 2 + (rng() * 2 - 1), cy = px / 2 + (rng() * 2 - 1);
    ctx.save();
    ctx.beginPath();
    ctx.rect(inset, inset, px - inset * 2, px - inset * 2);
    ctx.clip();
    for (let r = 2; r < px * 0.52; r += 2.6) {
      ctx.strokeStyle = css(T(S, r % 5.2 < 2.6 ? [150, 116, 66] : [176, 140, 88]), 0.9);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r + rng() * 0.6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = css(T(S, [122, 92, 56]));
    ctx.fillRect((cx - 1) | 0, (cy - 1) | 0, 2, 2);
  },

  leaves(ctx, px, rng, S) {
    // Transparent holes: blobby mask, big enough to actually read as holes.
    const holes = new Set();
    const nHoles = 9 + ((rng() * 4) | 0);
    for (let i = 0; i < nHoles; i++) {
      const hx = 2 + rng() * (px - 4), hy = 2 + rng() * (px - 4);
      const r = 1 + rng() * 1.5;
      for (let y = Math.floor(hy - r - 1); y <= hy + r + 1; y++) {
        for (let x = Math.floor(hx - r - 1); x <= hx + r + 1; x++) {
          const d = Math.hypot(x - hx, y - hy);
          if (d <= r + (rng() - 0.5) * 0.9) holes.add(((x + px) % px) + ',' + ((y + px) % px));
        }
      }
    }
    // Clumpy foliage: 2x2 leaf cells from a green palette (not per-px noise).
    const pal = [[50, 92, 36], [62, 114, 44], [76, 136, 52], [90, 154, 60]];
    for (let y = 0; y < px; y += 2) {
      for (let x = 0; x < px; x += 2) {
        const c = T(S, pal[(rng() * pal.length) | 0]);
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            if (holes.has((x + dx) + ',' + (y + dy))) continue;
            const d = (rng() * 2 - 1) * 6;
            ctx.fillStyle = css([c[0] + d, c[1] + d, c[2] + d]);
            ctx.fillRect(x + dx, y + dy, 1, 1);
          }
        }
      }
    }
    // Layered depth (source-atop keeps the holes transparent).
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 6; i++) blotch(ctx, px, rng, S, [38, 74, 30], 3 + rng() * 4, 0.55);
    for (let i = 0; i < 4; i++) blotch(ctx, px, rng, S, [108, 172, 70], 2 + rng() * 3, 0.5);
    speckle(ctx, px, rng, S, [[134, 192, 86]], 20, 1, 0.9);
    ctx.restore();
  },

  planks(ctx, px, rng, S) {
    const boardH = px / 4;
    for (let b = 0; b < 4; b++) {
      const y = b * boardH;
      const shade = 1 + (rng() * 0.16 - 0.08);
      const base = T(S, lighten(C.plank, shade));
      if (S.gradients) {
        const g = ctx.createLinearGradient(0, y, 0, y + boardH);
        g.addColorStop(0, css(lighten(base, 1.07)));
        g.addColorStop(1, css(lighten(base, 0.9)));
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = css(base);
      }
      ctx.fillRect(0, y, px, boardH);
      // wood grain streaks
      for (let i = 0; i < 3; i++) {
        const gy = y + 1 + ((rng() * (boardH - 2)) | 0);
        ctx.fillStyle = css(lighten(base, 0.82), 0.5);
        const x0 = (rng() * px * 0.5) | 0;
        ctx.fillRect(x0, gy, (px * (0.3 + rng() * 0.5)) | 0, 1);
      }
      if (!S.gradients) {
        // pixel grain
        for (let i = 0; i < 40 * S.grain; i++) {
          const d = (rng() * 2 - 1) * 9;
          ctx.fillStyle = css([base[0] + d, base[1] + d, base[2] + d]);
          ctx.fillRect((rng() * px) | 0, y + ((rng() * boardH) | 0), 1, 1);
        }
      }
      // top bevel highlight + bottom seam
      ctx.fillStyle = css(lighten(base, 1.14), 0.7);
      ctx.fillRect(0, y, px, 1);
      ctx.fillStyle = css(T(S, [104, 78, 46]));
      ctx.fillRect(0, y + boardH - 1, px, 1);
      // staggered end-joint + nails
      const jx = ((b * 13 + 5 + ((rng() * 6) | 0)) % (px - 4)) + 2;
      ctx.fillStyle = css(T(S, [104, 78, 46]), 0.9);
      ctx.fillRect(jx, y, 1, boardH);
      ctx.fillStyle = css(T(S, [70, 54, 34]));
      ctx.fillRect(jx - (2 + ((rng() * 2) | 0)), (y + boardH / 2) | 0, 1, 1);
      ctx.fillRect(jx + (2 + ((rng() * 2) | 0)), (y + boardH / 2) | 0, 1, 1);
    }
  },

  glass(ctx, px, rng, S) {
    // ~85% transparent pane with a visible frame + diagonal glints.
    ctx.fillStyle = css(A(S, [208, 234, 246]), 0.08);
    ctx.fillRect(0, 0, px, px);
    const frame = A(S, [226, 242, 248]);
    ctx.fillStyle = css(frame, 0.95);
    ctx.fillRect(0, 0, px, 1); ctx.fillRect(0, px - 1, px, 1);
    ctx.fillRect(0, 0, 1, px); ctx.fillRect(px - 1, 0, 1, px);
    // inner frame shadow line
    ctx.strokeStyle = css(A(S, [140, 170, 190]), 0.35);
    ctx.lineWidth = 1;
    ctx.strokeRect(1.5, 1.5, px - 3, px - 3);
    // corner accents
    ctx.fillStyle = css(frame, 0.95);
    ctx.fillRect(0, 0, 3, 3); ctx.fillRect(px - 3, 0, 3, 3);
    ctx.fillRect(0, px - 3, 3, 3); ctx.fillRect(px - 3, px - 3, 3, 3);
    // two diagonal glint streaks (bottom-left direction)
    streak(ctx, px * 0.58, px * 0.14, -1, 1, 12, A(S, [255, 255, 255]), 0.55, 2);
    streak(ctx, px * 0.74, px * 0.2, -1, 1, 15, A(S, [255, 255, 255]), 0.35, 1);
  },

  coal_ore(ctx, px, rng, S) {
    PAINTERS.stone(ctx, px, rng, S);
    oreNuggets(ctx, px, rng, S, [44, 44, 48], [82, 82, 88], [16, 16, 18]);
  },
  iron_ore(ctx, px, rng, S) {
    PAINTERS.stone(ctx, px, rng, S);
    oreNuggets(ctx, px, rng, S, [206, 158, 118], [232, 194, 154], [142, 88, 52]);
  },
  gold_ore(ctx, px, rng, S) {
    PAINTERS.stone(ctx, px, rng, S);
    oreNuggets(ctx, px, rng, S, [250, 208, 62], [255, 238, 140], [176, 134, 28]);
  },
  diamond_ore(ctx, px, rng, S) {
    PAINTERS.stone(ctx, px, rng, S);
    oreNuggets(ctx, px, rng, S, [86, 216, 210], [178, 250, 246], [34, 138, 138]);
  },

  bedrock(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, [70, 70, 74], 24);
    for (let i = 0; i < 8; i++) blotch(ctx, px, rng, S, [30, 30, 34], 3 + rng() * 4, 0.85);
    for (let i = 0; i < 6; i++) blotch(ctx, px, rng, S, [112, 112, 118], 2 + rng() * 4, 0.7);
    for (let i = 0; i < 4; i++) crackLine(ctx, px, rng, T(S, [16, 16, 18]), 0.9, 10 + rng() * 12);
  },

  snow(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, C.snow, 4);
    for (let i = 0; i < 5; i++) blotch(ctx, px, rng, S, [206, 222, 240], 3 + rng() * 4, 0.5);
    speckle(ctx, px, rng, S, [[255, 255, 255]], 30, 1);
    speckle(ctx, px, rng, S, [[196, 212, 232]], 12, 1, 0.8);
  },

  snow_side(ctx, px, rng, S) {
    PAINTERS.dirt(ctx, px, rng, S);
    // Snow cap with jagged bottom edge (canvas y=0 = block top).
    const sw = T(S, C.snow), shadow = T(S, [176, 192, 214]);
    for (let x = 0; x < px; x++) {
      const h = 8 + ((rng() * 4) | 0); // 8..11
      for (let y = 0; y < h; y++) {
        const d = (rng() * 2 - 1) * 5 * Math.max(S.grain, 0.3);
        ctx.fillStyle = css([sw[0] + d, sw[1] + d, sw[2] + d]);
        ctx.fillRect(x, y, 1, 1);
      }
      ctx.fillStyle = css(shadow);
      ctx.fillRect(x, h - 1, 1, 1);
      if (rng() < 0.2) { // drip
        ctx.fillStyle = css(sw, 0.9);
        ctx.fillRect(x, h, 1, 1 + ((rng() * 2) | 0));
      }
    }
  },

  cactus_top(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, [72, 126, 50], 8);
    // outer edge
    ctx.strokeStyle = css(T(S, [42, 82, 32]), 0.9);
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, px - 2, px - 2);
    // ribbed ring
    ctx.strokeStyle = css(T(S, [46, 90, 36]));
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px / 2, px / 2, px * 0.32, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = css(T(S, [104, 158, 70]), 0.8);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(px / 2, px / 2, px * 0.32 - 1.5, 0, Math.PI * 2);
    ctx.stroke();
    // radial ribs + spine dots on the ring
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + 0.4;
      const dx = Math.cos(a), dy = Math.sin(a);
      streak(ctx, px / 2 + dx * px * 0.36, px / 2 + dy * px * 0.36, dx, dy, 5, T(S, [46, 90, 36]), 0.8);
      ctx.fillStyle = css(A(S, [228, 238, 200]));
      ctx.fillRect((px / 2 + dx * px * 0.32) | 0, (px / 2 + dy * px * 0.32) | 0, 1, 1);
    }
    // center
    ctx.fillStyle = css(T(S, [110, 164, 74]));
    ellipse(ctx, px / 2, px / 2, 2.4, 2.4);
    ctx.fillStyle = css(T(S, [46, 90, 36]));
    ctx.fillRect(px / 2 - 1, px / 2 - 1, 2, 2);
  },

  cactus_side(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, [58, 110, 44], 7);
    // vertical ribs: dark groove + light ridge pairs
    for (let x = 2; x < px - 1; x += 4) {
      ctx.fillStyle = css(T(S, [40, 80, 32]), 0.9);
      ctx.fillRect(x, 0, 1, px);
      ctx.fillStyle = css(T(S, [92, 150, 64]), 0.9);
      ctx.fillRect(x + 1, 0, 1, px);
      // spines on the ridges
      let y = 2 + ((rng() * 4) | 0);
      while (y < px - 1) {
        ctx.fillStyle = css(A(S, [230, 240, 208]));
        ctx.fillRect(x + 1, y, 1, 1);
        ctx.fillStyle = css(T(S, [34, 68, 28]), 0.8);
        ctx.fillRect(x + 2, y + 1, 1, 1);
        y += 5 + ((rng() * 4) | 0);
      }
    }
    // darker outer columns
    ctx.fillStyle = css(T(S, [40, 80, 32]), 0.7);
    ctx.fillRect(0, 0, 1, px);
    ctx.fillRect(px - 1, 0, 1, px);
  },

  netherrack(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, [98, 34, 34], 13);
    for (let i = 0; i < 6; i++) crackLine(ctx, px, rng, T(S, [56, 14, 14]), 0.85, 12 + rng() * 14);
    for (let i = 0; i < 6; i++) blotch(ctx, px, rng, S, [142, 58, 52], 2 + rng() * 3.5, 0.55);
    for (let i = 0; i < 5; i++) blotch(ctx, px, rng, S, [64, 18, 18], 2 + rng() * 4, 0.6);
    speckle(ctx, px, rng, S, [[172, 82, 72]], 18, 1, 0.85);
  },

  soul_sand(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, [92, 72, 55], 10);
    for (let i = 0; i < 5; i++) blotch(ctx, px, rng, S, [70, 52, 40], 2.5 + rng() * 3.5, 0.5);
    for (let i = 0; i < 4; i++) blotch(ctx, px, rng, S, [112, 90, 68], 2 + rng() * 3, 0.5);
    // faint dark swirls
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = css(T(S, [54, 40, 30]), 0.5);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      const a0 = rng() * Math.PI * 2;
      ctx.arc(4 + rng() * (px - 8), 4 + rng() * (px - 8), 3 + rng() * 4, a0, a0 + Math.PI * (0.9 + rng() * 0.7));
      ctx.stroke();
    }
    // spooky hollow pairs (subtle)
    for (let i = 0; i < 2; i++) {
      const x = 5 + rng() * (px - 12), y = 5 + rng() * (px - 10);
      ctx.fillStyle = css(T(S, [50, 38, 28]), 0.75);
      ellipse(ctx, x, y, 1.4, 1.9);
      ellipse(ctx, x + 4, y + (rng() * 2 - 1), 1.4, 1.9);
    }
    speckle(ctx, px, rng, S, [[112, 90, 68]], 14, 1, 0.8);
  },

  glowstone(ctx, px, rng, S) {
    // Accent-tinted base: an emissive block should glow in every pack.
    fillBase(ctx, px, rng, S, [206, 152, 66], 12, 1, A);
    // crystalline mottle
    for (let i = 0; i < 9; i++) blotch(ctx, px, rng, S, A(S, [244, 204, 108]), 2 + rng() * 3.5, 0.8, false);
    for (let i = 0; i < 4; i++) crackLine(ctx, px, rng, A(S, [148, 98, 38]), 0.8, 8 + rng() * 10);
    // hot glow cores (accent — stays bright in every pack)
    for (let i = 0; i < 5; i++) {
      const x = 3 + rng() * (px - 7), y = 3 + rng() * (px - 7);
      ctx.fillStyle = css(A(S, [255, 234, 150]), 0.95);
      ctx.fillRect((x - 1) | 0, y | 0, 3, 1);
      ctx.fillRect(x | 0, (y - 1) | 0, 1, 3);
      ctx.fillStyle = css(A(S, [255, 248, 208]));
      ctx.fillRect(x | 0, y | 0, 1, 1);
    }
  },

  obsidian(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, [24, 18, 36], 7);
    for (let i = 0; i < 5; i++) blotch(ctx, px, rng, S, [10, 8, 18], 3 + rng() * 4, 0.7);
    // purple sheen streaks
    for (let i = 0; i < 4; i++) {
      const x0 = rng() * px, y0 = rng() * px, len = 7 + rng() * 10;
      streak(ctx, x0, y0, 1, -1, len, A(S, [96, 58, 142]), 0.55);
      streak(ctx, x0 + 1, y0, 1, -1, len * 0.6, A(S, [150, 100, 210]), 0.4);
    }
    speckle(ctx, px, rng, S, [[132, 90, 190]], 6, 1, 0.7);
    speckle(ctx, px, rng, S, [[52, 40, 78]], 14, 1, 0.8);
  },

  end_stone(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, [219, 222, 162], 7);
    for (let i = 0; i < 6; i++) blotch(ctx, px, rng, S, [198, 200, 140], 2.5 + rng() * 4, 0.55);
    for (let i = 0; i < 5; i++) crackLine(ctx, px, rng, T(S, [166, 168, 112]), 0.9, 10 + rng() * 12);
    for (let i = 0; i < 3; i++) blotch(ctx, px, rng, S, [236, 238, 186], 2 + rng() * 3, 0.5);
    speckle(ctx, px, rng, S, [[152, 154, 100]], 10, 1, 0.8);
  },

  purpur(ctx, px, rng, S) {
    fillBase(ctx, px, rng, S, [170, 128, 170], 6);
    const cell = px / 2;
    for (let gy = 0; gy < 2; gy++) {
      for (let gx = 0; gx < 2; gx++) {
        const x = gx * cell, y = gy * cell;
        // block face
        ctx.fillStyle = css(T(S, [182, 140, 182]), 0.8);
        ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
        // border
        ctx.strokeStyle = css(T(S, [126, 90, 126]), 0.95);
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
        // bevel highlight
        ctx.fillStyle = css(T(S, [206, 166, 206]), 0.7);
        ctx.fillRect(x + 1, y + 1, cell - 2, 1);
        // center stud
        ctx.fillStyle = css(T(S, [148, 108, 148]));
        ctx.fillRect(x + cell / 2 - 2, y + cell / 2 - 2, 4, 4);
        ctx.fillStyle = css(T(S, [196, 156, 196]));
        ctx.fillRect(x + cell / 2 - 2, y + cell / 2 - 2, 1, 1);
      }
    }
    if (!S.gradients) speckle(ctx, px, rng, S, [[158, 118, 158], [190, 148, 190]], 20, 1, 0.6);
  },

  portal(ctx, px, rng, S) {
    // Translucent violet swirl.
    ctx.fillStyle = css(A(S, [88, 26, 152]), 0.72);
    ctx.fillRect(0, 0, px, px);
    // darker vignette edges
    ctx.fillStyle = css(A(S, [50, 10, 96]), 0.5);
    ctx.fillRect(0, 0, px, 2); ctx.fillRect(0, px - 2, px, 2);
    ctx.fillRect(0, 0, 2, px); ctx.fillRect(px - 2, 0, 2, px);
    // twin spiral arms
    for (let arm = 0; arm < 2; arm++) {
      const phase = arm * Math.PI + rng() * 0.8;
      for (let t = 0; t < 34; t++) {
        const r = 1.5 + t * 0.36;
        const a = phase + t * 0.32;
        const x = px / 2 + Math.cos(a) * r;
        const y = px / 2 + Math.sin(a) * r * 0.9;
        const fade = 1 - t / 40;
        ctx.fillStyle = css(A(S, [186, 118, 242]), 0.28 + 0.35 * fade);
        ctx.fillRect(x | 0, y | 0, 2, 2);
        if (t % 5 === 0) {
          ctx.fillStyle = css(A(S, [226, 178, 255]), 0.5 * fade + 0.2);
          ctx.fillRect(x | 0, y | 0, 1, 1);
        }
      }
    }
    // sparkles
    for (let i = 0; i < 7; i++) {
      ctx.fillStyle = css(A(S, [240, 208, 255]), 0.75);
      ctx.fillRect((rng() * px) | 0, (rng() * px) | 0, 1, 1);
    }
  },

  // Visible fallback for unknown tile names — magenta/black checker.
  missing(ctx, px, rng, S) {
    const h = px / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#f0f';
    ctx.fillRect(0, 0, h, h);
    ctx.fillRect(h, h, h, h);
  },
};

/** Filled ellipse helper (rounded cobbles, knots, hollows). */
function ellipse(ctx, x, y, rx, ry) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Pack finishing passes.
// ---------------------------------------------------------------------------

// Tiles whose translucency / glow must not be scribbled over.
const NO_WEAR = new Set(['water', 'glass', 'portal', 'lava', 'leaves']);
const NO_SHEEN = new Set(['water', 'glass', 'portal']);

function applyFinish(ctx, name, px, rng, S) {
  if (S.wear && !NO_WEAR.has(name)) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop'; // respect existing alpha
    for (let i = 0; i < 3; i++) crackLine(ctx, px, rng, [0, 0, 0], 0.30, 10 + rng() * 18);
    for (let i = 0; i < 36; i++) {
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect((rng() * px) | 0, (rng() * px) | 0, 1, 1);
    }
    for (let i = 0; i < 12; i++) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect((rng() * px) | 0, (rng() * px) | 0, 1, 1);
    }
    // worn edges
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(0, 0, px, 1); ctx.fillRect(0, px - 1, px, 1);
    ctx.fillRect(0, 0, 1, px); ctx.fillRect(px - 1, 0, 1, px);
    ctx.restore();
  }
  if (S.gradients && !NO_SHEEN.has(name)) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    const g = ctx.createRadialGradient(px * 0.35, px * 0.3, 0, px * 0.35, px * 0.3, px * 0.95);
    g.addColorStop(0, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, px, px);
    ctx.restore();
  }
}

function makeDrawTile(S) {
  return function drawTile(ctx, name, px, rng) {
    ctx.clearRect(0, 0, px, px);
    const paint = PAINTERS[name] || PAINTERS.missing;
    paint(ctx, px, rng, S);
    applyFinish(ctx, name, px, rng, S);
  };
}

// ---------------------------------------------------------------------------
// The packs.
//   default — classic crisp pixel look, medium saturation, per-pixel speckle
//   smooth  — soft gradients, rounded shapes, cartoon-bright, minimal noise
//   gritty  — desaturated darker palette, high contrast, cracks & wear
// ---------------------------------------------------------------------------
export const PACKS = {
  default: { id: 'default', name: 'Voxelheim Classic', drawTile: makeDrawTile(STYLES.default) },
  smooth:  { id: 'smooth',  name: 'Softstone',         drawTile: makeDrawTile(STYLES.smooth) },
  gritty:  { id: 'gritty',  name: 'Gritstone',         drawTile: makeDrawTile(STYLES.gritty) },
};
