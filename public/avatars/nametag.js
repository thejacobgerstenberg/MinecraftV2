// avatars/nametag.js
// Builds a camera-facing canvas-texture name-tag sprite (dark pill + light text).

import * as THREE from "three";

/** Clamp a number into [lo, hi]; NaN/undefined fall back to lo. */
function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

// Canvas + layout constants (kept module-level so nothing allocates per tag
// beyond the single canvas/texture actually returned).
const CANVAS_W = 320; // texture width  (px)
const CANVAS_H = 80; // texture height (px)  — keeps CANVAS_W/H = 4:1 (matches sprite)
const MAX_CHARS = 20; // truncate long names (…)
const FONT_PX = 48; // glyph height (px) inside the canvas — larger for gallery/walk legibility
const PILL_BG = "rgba(6,10,16,0.62)"; // dark rounded pill background
const TEXT_FILL = "#f2f6ff"; // near-white text
const TEXT_STROKE = "rgba(4,7,12,0.85)"; // thin dark outline so glyphs read on any backdrop
const TEXT_STROKE_PX = 4; // outline width (px)
const PILL_PAD_X = 22; // horizontal padding inside the pill (px)
const PILL_RADIUS = 26; // pill corner radius (px)

// Default world-space sprite size (metres). Readable at distance; the caller
// anchors it ~0.4 above the head — we never set world position here.
const DEFAULT_W = 2.2;
const DEFAULT_H = 0.55;

/** Draw a rounded-rectangle path on a 2D context (no allocations). */
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Create a name-tag sprite for a remote player.
 *
 * The sprite auto-faces the camera. It is NOT positioned in world space here —
 * the caller anchors it (~0.4 above the head). Disposal is attached at
 * `sprite.userData.dispose` and frees the texture and material.
 *
 * @param {string} text - display name; truncated to ~20 chars.
 * @param {object} [opts]
 * @param {number} [opts.width=1.8]  - sprite world width (metres).
 * @param {number} [opts.height=0.45] - sprite world height (metres).
 * @param {boolean} [opts.depthTest=true] - keep true so nearer geometry occludes;
 *   false makes the tag draw on top of everything (see-through walls).
 * @returns {THREE.Sprite} sprite with `userData.dispose()` set.
 */
export function makeNameTag(text, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const width = clamp(o.width, 0.2, 8) || DEFAULT_W;
  const height = clamp(o.height, 0.05, 4) || DEFAULT_H;
  const depthTest = o.depthTest !== false; // default true

  // --- normalise + truncate the label ---
  let label = text == null ? "" : String(text);
  label = label.replace(/\s+/g, " ").trim();
  if (label.length > MAX_CHARS) label = label.slice(0, MAX_CHARS - 1) + "…";
  if (label.length === 0) label = "?";

  // --- draw to an offscreen canvas ---
  let texture = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Monospace so proportional widths stay predictable across browsers.
    const font = `${FONT_PX}px "SFMono-Regular", ui-monospace, "Menlo", "Consolas", monospace`;
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Size the pill to the measured text width (clamped to the canvas).
    const textW = ctx.measureText(label).width;
    const pillW = Math.min(CANVAS_W - 4, textW + PILL_PAD_X * 2);
    const pillH = FONT_PX + 20;
    const pillX = (CANVAS_W - pillW) / 2;
    const pillY = (CANVAS_H - pillH) / 2;

    ctx.fillStyle = PILL_BG;
    roundRect(ctx, pillX, pillY, pillW, pillH, PILL_RADIUS);
    ctx.fill();

    // Text (re-set font: fill/measure can be reset after path ops).
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Thin dark outline first, then the light fill on top — keeps glyphs legible
    // against bright (gold/ice) avatar bodies as well as the dark scene.
    ctx.lineJoin = "round";
    ctx.lineWidth = TEXT_STROKE_PX;
    ctx.strokeStyle = TEXT_STROKE;
    ctx.strokeText(label, CANVAS_W / 2, CANVAS_H / 2 + 1);
    ctx.fillStyle = TEXT_FILL;
    ctx.fillText(label, CANVAS_W / 2, CANVAS_H / 2 + 1);

    texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    if ("colorSpace" in texture) texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
  } catch (_e) {
    texture = null; // fall through to a plain (untextured) tint
  }

  const material = new THREE.SpriteMaterial({
    map: texture || undefined,
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    depthTest,
  });

  const sprite = new THREE.Sprite(material);
  sprite.name = "loomfall-nametag";
  sprite.scale.set(width, height, 1);
  // Keep name tags above regular transparent geometry.
  sprite.renderOrder = 10;

  let disposed = false;
  sprite.userData.dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      if (texture) texture.dispose();
    } catch (_e) {
      /* ignore */
    }
    try {
      material.dispose();
    } catch (_e) {
      /* ignore */
    }
  };

  return sprite;
}

export default makeNameTag;
