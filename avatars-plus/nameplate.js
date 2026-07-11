// avatars-plus/nameplate.js
// Camera-facing name + health/status sprite (forked from the rig nametag): one
// canvas, two rows, team/self-tinted border, distance fade, redraw-on-change only.

import * as THREE from "three";

/** Clamp v into [0,1]; non-finite -> 0. */
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Clamp n into [lo, hi]; non-finite -> lo. */
function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

// ---- Canvas geometry (module-level so nothing allocates per nameplate beyond
// the single canvas/texture actually created) ---------------------------------
const CANVAS_W = 320; // texture width  (px)
const CANVAS_H = 132; // texture height (px) — two rows: name pill + bar/status
const MAX_CHARS = 20; // name truncation

// Name row
const NAME_FONT_PX = 40;
const NAME_PILL_Y = 8;
const NAME_PILL_H = 58;
const NAME_PAD_X = 20;
const PILL_RADIUS = 18;

// Health/status row
const BAR_Y = 74; // top of the health-bar track
const BAR_H = 20; // health-bar track height
const BAR_RADIUS = 6;
const STATUS_FONT_PX = 20;
const STATUS_Y = 100; // baseline band for optional status text

// Colours (drawn into the canvas — this is a THREE texture, not an lf element,
// so raw values are appropriate here; they mirror the lf brand ramp).
const PILL_BG = "rgba(6,10,16,0.66)"; // dark rounded pill
const TEXT_FILL = "#F7F2E4"; // near-white (lf muslin-ish)
const TEXT_STROKE = "rgba(4,7,12,0.9)";
const TEXT_STROKE_PX = 4;
const BAR_TRACK = "rgba(6,10,16,0.72)"; // empty portion of the bar
const BORDER_PX = 3;
const STATUS_FILL = "#EDE7DA";

// Team/self border tints (paired ALWAYS with the "self" pip shape below, and
// with the name text — never colour alone).
const BORDER_SELF = "#F2C14E"; // brand gold
const BORDER_TEAM_A = "#5F8A46"; // warp-green
const BORDER_TEAM_B = "#B03A52"; // madder
const BORDER_NEUTRAL = "#6A5F8C"; // hem

// Health stops (green -> amber -> red); the FILL WIDTH also encodes ratio, so
// the cue is length + colour, not hue alone.
const HP_GREEN = [0x5f, 0x8a, 0x46];
const HP_AMBER = [0xd9, 0xb9, 0x3a];
const HP_RED = [0xb0, 0x3a, 0x52];

// Default world sprite size (metres). Height derives from the canvas aspect so
// the two-row layout never distorts. Caller anchors it ~height+0.4 above feet.
const DEFAULT_W = 2.0;

/** Rounded-rect path (no allocations). */
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

/** Interpolate two [r,g,b] triples -> "rgb(...)". */
function mixRgb(a, b, t) {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

/** Health colour for a ratio in [0,1]: red@0 -> amber@0.5 -> green@1. */
function healthColor(ratio) {
  const r = clamp01(ratio);
  return r >= 0.5
    ? mixRgb(HP_AMBER, HP_GREEN, (r - 0.5) * 2)
    : mixRgb(HP_RED, HP_AMBER, r * 2);
}

/** Border tint for team/self. */
function borderColor(team, self) {
  if (self) return BORDER_SELF;
  if (team === "a") return BORDER_TEAM_A;
  if (team === "b") return BORDER_TEAM_B;
  return BORDER_NEUTRAL;
}

/**
 * Create a name/health/status nameplate.
 *
 * The returned sprite auto-faces the camera and is NOT positioned here — the
 * caller anchors it (~height+0.4 above feet). The canvas is redrawn ONLY when
 * name/health/status/team data changes; `update()` just refreshes the redraw
 * (if dirty) and sets distance-fade opacity — no per-frame canvas allocation.
 *
 * @param {object} [opts]
 * @param {string} [opts.name] - display name (truncated to ~20 chars).
 * @param {"a"|"b"|null} [opts.team] - team for border tint.
 * @param {boolean} [opts.self] - local player (gold border + "you" pip).
 * @param {number} [opts.width=2.0] - sprite world width (metres).
 * @param {number} [opts.maxDistance=48] - distance (m) at which the tag reaches
 *   its faint floor opacity; full opacity within ~half this.
 * @returns {{
 *   sprite: THREE.Sprite,
 *   setName(text:string):void,
 *   setHealth(cur:number, max:number):void,
 *   setStatus(text:string):void,
 *   setTeam(team:("a"|"b"|null)):void,
 *   update(dt:number, cameraPos:{x,y,z}, worldAnchorPos:{x,y,z}):void,
 *   dispose():void
 * }} nameplate handle
 */
export function makeNameplate(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};

  const width = clamp(o.width, 0.3, 8) || DEFAULT_W;
  const height = width * (CANVAS_H / CANVAS_W);
  const maxDistance = clamp(o.maxDistance, 4, 512) || 48;
  const fadeStart = maxDistance * 0.5; // full opacity within half range

  // ---- mutable data (setters mark dirty; update() redraws once) ----
  const state = {
    name: o.name == null ? "" : String(o.name),
    cur: 1,
    max: 1,
    status: "",
    team: o.team === "a" || o.team === "b" ? o.team : null,
    self: !!o.self,
  };
  let dirty = true;
  let disposed = false;

  // ---- single canvas / texture / material / sprite ----
  let canvas = null;
  let ctx = null;
  let texture = null;
  try {
    canvas = document.createElement("canvas");
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    ctx = canvas.getContext("2d");
  } catch (_e) {
    ctx = null;
  }
  if (ctx) {
    try {
      texture = new THREE.CanvasTexture(canvas);
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      if ("colorSpace" in texture) texture.colorSpace = THREE.SRGBColorSpace;
    } catch (_e) {
      texture = null;
    }
  }

  const material = new THREE.SpriteMaterial({
    map: texture || undefined,
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  material.opacity = 1;

  const sprite = new THREE.Sprite(material);
  sprite.name = "loomfall-nameplate";
  sprite.scale.set(width, height, 1);
  sprite.renderOrder = 10;

  /** Truncate + collapse whitespace for the name row. */
  function labelFor(text) {
    let s = text == null ? "" : String(text);
    s = s.replace(/\s+/g, " ").trim();
    if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS - 1) + "…";
    return s.length ? s : "?";
  }

  /** Redraw the whole canvas from `state`. Called only when dirty. */
  function redraw() {
    if (!ctx || !texture) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    const border = borderColor(state.team, state.self);
    const label = labelFor(state.name);

    // ---- Row 1: name pill ----
    const nameFont = `${NAME_FONT_PX}px ${"system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"}`;
    ctx.font = nameFont;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const textW = ctx.measureText(label).width;
    const pillW = Math.min(CANVAS_W - BORDER_PX * 2 - 4, textW + NAME_PAD_X * 2);
    const pillX = (CANVAS_W - pillW) / 2;

    ctx.fillStyle = PILL_BG;
    roundRect(ctx, pillX, NAME_PILL_Y, pillW, NAME_PILL_H, PILL_RADIUS);
    ctx.fill();
    // Team/self border on the pill (colour) — paired with the pip + text below.
    ctx.lineWidth = BORDER_PX;
    ctx.strokeStyle = border;
    roundRect(ctx, pillX, NAME_PILL_Y, pillW, NAME_PILL_H, PILL_RADIUS);
    ctx.stroke();

    // "self" pip: a small square notch on the left of the pill — a SHAPE cue so
    // "this is you" doesn't rely on gold alone.
    if (state.self) {
      const pip = 12;
      ctx.fillStyle = border;
      ctx.fillRect(pillX + 8, NAME_PILL_Y + (NAME_PILL_H - pip) / 2, pip, pip);
    }

    // Name text: dark outline then light fill (legible over any backdrop).
    ctx.font = nameFont;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = TEXT_STROKE_PX;
    ctx.strokeStyle = TEXT_STROKE;
    const nameCy = NAME_PILL_Y + NAME_PILL_H / 2 + 1;
    ctx.strokeText(label, CANVAS_W / 2, nameCy);
    ctx.fillStyle = TEXT_FILL;
    ctx.fillText(label, CANVAS_W / 2, nameCy);

    // ---- Row 2: health bar (length + colour encode ratio) ----
    const ratio = state.max > 0 ? clamp01(state.cur / state.max) : 0;
    const barX = pillX;
    const barW = pillW;

    // Track (empty) with a subtle border so the bar reads even when near-full.
    ctx.fillStyle = BAR_TRACK;
    roundRect(ctx, barX, BAR_Y, barW, BAR_H, BAR_RADIUS);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(4,7,12,0.85)";
    roundRect(ctx, barX, BAR_Y, barW, BAR_H, BAR_RADIUS);
    ctx.stroke();

    // Fill: WIDTH = ratio, colour = green/amber/red — dual cue, not hue-only.
    const fillW = Math.max(0, Math.round(barW * ratio));
    if (fillW > 1) {
      ctx.save();
      roundRect(ctx, barX, BAR_Y, barW, BAR_H, BAR_RADIUS);
      ctx.clip();
      ctx.fillStyle = healthColor(ratio);
      ctx.fillRect(barX, BAR_Y, fillW, BAR_H);
      ctx.restore();
    }

    // ---- Optional status text below the bar ----
    const status = state.status ? String(state.status).slice(0, 24) : "";
    if (status) {
      ctx.font = `${STATUS_FONT_PX}px ${"system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.lineJoin = "round";
      ctx.lineWidth = 3;
      ctx.strokeStyle = TEXT_STROKE;
      ctx.strokeText(status, CANVAS_W / 2, STATUS_Y);
      ctx.fillStyle = STATUS_FILL;
      ctx.fillText(status, CANVAS_W / 2, STATUS_Y);
    }

    texture.needsUpdate = true;
  }

  // ---- setters: mutate + mark dirty (redraw deferred to update) ----
  function setName(text) {
    const v = text == null ? "" : String(text);
    if (v !== state.name) {
      state.name = v;
      dirty = true;
    }
  }
  function setHealth(cur, max) {
    const c = Number.isFinite(+cur) ? +cur : state.cur;
    const m = Number.isFinite(+max) && +max > 0 ? +max : state.max;
    if (c !== state.cur || m !== state.max) {
      state.cur = c;
      state.max = m;
      dirty = true;
    }
  }
  function setStatus(text) {
    const v = text == null ? "" : String(text);
    if (v !== state.status) {
      state.status = v;
      dirty = true;
    }
  }
  function setTeam(team) {
    const v = team === "a" || team === "b" ? team : null;
    if (v !== state.team) {
      state.team = v;
      dirty = true;
    }
  }

  /**
   * Per-frame: redraw iff data changed, then fade opacity by camera distance.
   * No allocations — distance is scalar math on the passed-in positions.
   */
  function update(_dt, cameraPos, worldAnchorPos) {
    if (disposed) return;
    if (dirty) {
      dirty = false;
      try {
        redraw();
      } catch (_e) {
        /* never throw from a frame path */
      }
    }
    if (
      cameraPos &&
      worldAnchorPos &&
      Number.isFinite(cameraPos.x) &&
      Number.isFinite(worldAnchorPos.x)
    ) {
      const dx = cameraPos.x - worldAnchorPos.x;
      const dy = cameraPos.y - worldAnchorPos.y;
      const dz = cameraPos.z - worldAnchorPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let op;
      if (dist <= fadeStart) op = 1;
      else {
        const t = clamp01((dist - fadeStart) / (maxDistance - fadeStart));
        op = 1 + (0.15 - 1) * t; // lerp full -> faint floor
      }
      material.opacity = op;
    }
  }

  /** Free the texture + material. Idempotent. */
  function dispose() {
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
  }

  // First draw happens on first update() (dirty === true).
  return {
    sprite,
    setName,
    setHealth,
    setStatus,
    setTeam,
    update,
    dispose,
  };
}

export default makeNameplate;
