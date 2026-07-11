import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Billboard — camera-facing nametag + HP bar for hostiles/bosses.
//
// Loomfall lore: renders as a THREE.Sprite (Sprites auto-face the camera,
// no manual lookAt bookkeeping needed) whose map is a THREE.CanvasTexture
// drawn by hand: the species name up top (outlined + shadowed for
// readability over any background) and a two-layer HP bar (dark
// background track + colored fill) beneath it. Boss variant renders larger
// with a distinct gold frame around the whole plate.
//
// Dependency-free: only 'three' is imported. Defensive against headless /
// non-browser environments — if `document` doesn't exist (no Canvas2D
// available) this degrades to a plain colored Sprite with no text, so the
// caller still gets a valid `.sprite` to add above the mob's head.
//
// THREE classes used: Sprite, SpriteMaterial, CanvasTexture, Color,
// (Texture as CanvasTexture's base — not used directly). If CanvasTexture
// were ever unavailable in the vendored three build, this module falls
// back to a small Mesh(BoxGeometry, MeshBasicMaterial) health bar instead
// (checked once at module load via HAS_CANVAS_TEXTURE below) so mobs still
// render *something* over their heads rather than throwing.
//
// Public API (kept intentionally small & stable):
//   new Billboard({ name, color, boss })
//   .sprite                — THREE.Sprite (or THREE.Group in the mesh
//                             fallback path) to add above the mob's head
//   .setName(name)          — change the displayed species name
//   .setHp(frac)            — 0..1 health fraction; redraws the bar fill,
//                              throttled so redraws only happen when frac
//                              actually changed beyond a small epsilon
//   .setVisible(bool)
//   .setScale(s)
//   .dispose()               — frees canvas/texture/material/geometry
// ---------------------------------------------------------------------------

const HAS_DOCUMENT = typeof document !== 'undefined';
const HAS_CANVAS_TEXTURE = typeof THREE.CanvasTexture === 'function';

// Canvas-space layout constants (logical pixels before devicePixelRatio-ish
// oversampling below). Boss plates get a larger canvas + thicker chrome.
const LAYOUT = {
  normal: { w: 256, h: 96, fontPx: 34, barW: 220, barH: 20, pad: 14 },
  boss:   { w: 384, h: 140, fontPx: 46, barW: 336, barH: 30, pad: 20 },
};

const HP_EPSILON = 0.01; // throttle: ignore HP changes smaller than this

function clamp01(v) {
  if (Number.isNaN(v) || v === undefined || v === null) return 0;
  return Math.max(0, Math.min(1, v));
}

// Green -> amber -> red ramp driven by HP fraction.
function hpColor(frac) {
  const f = clamp01(frac);
  let r, g, b;
  if (f > 0.5) {
    // green (0.5..1.0) -> amber at 0.5
    const t = (1 - f) / 0.5; // 0 at f=1, 1 at f=0.5
    r = Math.round(0x33 + t * (0xf5 - 0x33));
    g = Math.round(0xcc + t * (0xa6 - 0xcc));
    b = Math.round(0x55 + t * (0x1a - 0x55));
  } else {
    // amber (0.5) -> red (0.0)
    const t = 1 - f / 0.5; // 0 at f=0.5, 1 at f=0
    r = Math.round(0xf5 + t * (0xe0 - 0xf5));
    g = Math.round(0xa6 + t * (0x2a - 0xa6));
    b = Math.round(0x1a + t * (0x2a - 0x1a));
  }
  return `rgb(${r},${g},${b})`;
}

export class Billboard {
  constructor({ name = '', color = '#e0e0e0', boss = false } = {}) {
    this.boss = !!boss;
    this.color = color;
    this._name = name || '';
    this._hpFrac = 1;
    this._visible = true;
    this._disposed = false;
    this._layout = this.boss ? LAYOUT.boss : LAYOUT.normal;

    this._canvas = null;
    this._ctx = null;
    this._texture = null;
    this._material = null;
    this._sprite = null;

    // Mesh-fallback-only fields (used when CanvasTexture is unavailable).
    this._hpFillMesh = null;
    this._hpFillGeom = null;
    this._hpFillMat = null;
    this._hpBgMesh = null;

    if (!HAS_DOCUMENT) {
      this._buildNoDomFallback();
    } else if (!HAS_CANVAS_TEXTURE) {
      this._buildMeshFallback();
    } else {
      this._buildCanvasSprite();
    }

    this.setScale(1);
  }

  // -- construction paths ----------------------------------------------

  _buildCanvasSprite() {
    const { w, h } = this._layout;
    const canvas = document.createElement('canvas');
    // Oversample a bit for crisper text/edges without inflating scale math.
    const oversample = 2;
    canvas.width = w * oversample;
    canvas.height = h * oversample;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      // Extremely defensive: some headless canvases have no 2d context.
      this._buildMeshFallback();
      return;
    }
    ctx.scale(oversample, oversample);

    this._canvas = canvas;
    this._ctx = ctx;
    this._texture = new THREE.CanvasTexture(canvas);
    if ('colorSpace' in this._texture) {
      // Keep UI text crisp/correct if the renderer uses color-managed space.
      try { this._texture.colorSpace = THREE.SRGBColorSpace; } catch (_) { /* older three */ }
    }
    this._material = new THREE.SpriteMaterial({
      map: this._texture,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      sizeAttenuation: true,
    });
    this._sprite = new THREE.Sprite(this._material);

    // World-space base size for the plate; scaled uniformly by setScale().
    const worldH = this.boss ? 1.1 : 0.7;
    const worldW = worldH * (w / h);
    this._sprite.scale.set(worldW, worldH, 1);
    this._sprite.renderOrder = 999;

    this._redraw();
  }

  // Fallback when CanvasTexture doesn't exist in the vendored three build:
  // a small Mesh(BoxGeometry) pair (background track + colored fill) with
  // no text, grouped under a THREE.Group so `.sprite` is still a single
  // Object3D the caller can add above the mob's head and position/scale.
  _buildMeshFallback() {
    const group = new THREE.Group();

    const bgGeom = new THREE.BoxGeometry(1, 0.12, 0.02);
    const bgMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a, depthWrite: false });
    const bgMesh = new THREE.Mesh(bgGeom, bgMat);
    bgMesh.renderOrder = 999;
    group.add(bgMesh);

    const fillGeom = new THREE.BoxGeometry(1, 0.1, 0.021);
    const fillMat = new THREE.MeshBasicMaterial({ color: 0x33cc55, depthWrite: false });
    const fillMesh = new THREE.Mesh(fillGeom, fillMat);
    fillMesh.renderOrder = 1000;
    group.add(fillMesh);

    this._hpBgMesh = bgMesh;
    this._hpFillGeom = fillGeom;
    this._hpFillMat = fillMat;
    this._hpFillMesh = fillMesh;
    this._sprite = group;

    this._applyHpToFallbackMesh(1);
  }

  // No `document` at all (pure headless/non-browser eval context): plain
  // colored Sprite, no canvas, no text. Still a valid Object3D.
  _buildNoDomFallback() {
    if (typeof THREE.SpriteMaterial === 'function' && typeof THREE.Sprite === 'function') {
      this._material = new THREE.SpriteMaterial({ color: this.color, transparent: true });
      this._sprite = new THREE.Sprite(this._material);
      this._sprite.scale.set(this.boss ? 1.1 : 0.7, this.boss ? 0.4 : 0.25, 1);
    } else {
      // Last-resort: an empty Group so callers never get a null sprite.
      this._sprite = new THREE.Group();
    }
  }

  // -- drawing ------------------------------------------------------------

  _redraw() {
    if (!this._ctx || this._disposed) return;
    const ctx = this._ctx;
    const { w, h, fontPx, barW, barH, pad } = this._layout;

    ctx.clearRect(0, 0, w, h);

    // Boss plates get a subtle backing panel + gold frame; normal mobs get
    // no panel at all (name + bar float over the world).
    if (this.boss) {
      const px = w / 2 - barW / 2 - 12;
      const py = pad - 10;
      const pw = barW + 24;
      const ph = h - pad + 6;
      ctx.fillStyle = 'rgba(10,8,4,0.55)';
      ctx.fillRect(px, py, pw, ph);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#d4af37';
      ctx.strokeRect(px + 1.5, py + 1.5, pw - 3, ph - 3);
    }

    // Name text: outlined + shadowed for legibility over any world backdrop.
    const nameY = this.boss ? fontPx * 0.85 + 6 : fontPx * 0.85;
    ctx.font = `bold ${fontPx}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;
    ctx.lineWidth = Math.max(3, fontPx / 9);
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.strokeText(this._name, w / 2, nameY);
    ctx.restore();

    ctx.fillStyle = this.boss ? '#ffe9a8' : this.color;
    ctx.fillText(this._name, w / 2, nameY);

    // HP bar: dark background track + colored fill, centered under name.
    const barX = w / 2 - barW / 2;
    const barY = nameY + pad;

    ctx.fillStyle = 'rgba(15,15,15,0.85)';
    _roundRect(ctx, barX, barY, barW, barH, barH / 4);
    ctx.fill();

    const frac = clamp01(this._hpFrac);
    const fillW = Math.max(0, barW * frac);
    if (fillW > 0.5) {
      ctx.fillStyle = hpColor(frac);
      _roundRect(ctx, barX, barY, fillW, barH, barH / 4);
      ctx.fill();
    }

    ctx.lineWidth = this.boss ? 2.5 : 1.5;
    ctx.strokeStyle = this.boss ? '#d4af37' : 'rgba(0,0,0,0.6)';
    _roundRect(ctx, barX, barY, barW, barH, barH / 4);
    ctx.stroke();

    if (this._texture) this._texture.needsUpdate = true;
  }

  _applyHpToFallbackMesh(frac) {
    if (!this._hpFillMesh) return;
    const f = clamp01(frac);
    this._hpFillMesh.scale.x = Math.max(0.0001, f);
    // Keep the fill left-aligned within the [-0.5, 0.5] track as it shrinks.
    this._hpFillMesh.position.x = -0.5 * (1 - f);
    if (this._hpFillMat && this._hpFillMat.color) {
      this._hpFillMat.color.set(hpColor(f));
    }
  }

  // -- public API -----------------------------------------------------

  get sprite() {
    return this._sprite;
  }

  setName(name) {
    const next = name || '';
    if (next === this._name) return;
    this._name = next;
    this._redraw();
  }

  setHp(frac) {
    const f = clamp01(frac);
    if (Math.abs(f - this._hpFrac) < HP_EPSILON) return; // throttle redraws
    this._hpFrac = f;
    if (this._ctx) {
      this._redraw();
    } else if (this._hpFillMesh) {
      this._applyHpToFallbackMesh(f);
    }
  }

  setVisible(visible) {
    this._visible = !!visible;
    if (this._sprite) this._sprite.visible = this._visible;
  }

  setScale(s) {
    const scale = (typeof s === 'number' && s > 0) ? s : 1;
    this._scale = scale;
    if (!this._sprite) return;
    if (this._sprite.isSprite) {
      // Capture the base (world-space) scale set at construction time
      // BEFORE ever mutating it, so repeated setScale() calls are always
      // relative multipliers of the original plate size, not compounding.
      if (!this._baseScale) {
        this._baseScale = this._sprite.scale.clone();
      }
      this._sprite.scale.set(
        this._baseScale.x * scale,
        this._baseScale.y * scale,
        this._baseScale.z * scale
      );
    } else if (this._sprite.isGroup) {
      this._sprite.scale.setScalar(scale);
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    if (this._texture) {
      this._texture.dispose();
      this._texture = null;
    }
    if (this._material) {
      this._material.dispose();
      this._material = null;
    }
    if (this._hpFillGeom) { this._hpFillGeom.dispose(); this._hpFillGeom = null; }
    if (this._hpFillMat) { this._hpFillMat.dispose(); this._hpFillMat = null; }
    if (this._hpBgMesh && this._hpBgMesh.geometry) { this._hpBgMesh.geometry.dispose(); }
    if (this._hpBgMesh && this._hpBgMesh.material) { this._hpBgMesh.material.dispose(); }

    this._canvas = null;
    this._ctx = null;
    this._sprite = null;
    this._hpFillMesh = null;
    this._hpBgMesh = null;
  }
}

// Rounded-rect path helper (avoids depending on ctx.roundRect, which isn't
// universally available in older/headless Canvas2D implementations).
function _roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
