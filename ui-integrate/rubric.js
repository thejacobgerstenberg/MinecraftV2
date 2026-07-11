/**
 * ui-integrate/rubric.js — in-page UX-rubric math, computed on RENDERED pixels.
 *
 * Two criteria are MEASURED from the live DOM/computed styles:
 *   R1  WCAG contrast (threshold 4.5:1, worst-of a sampled text set).
 *   R6  Colorblind separation of the hotbar SELECTION cue (Vienot-Brettel-
 *       Mollon dichromat projection; pass = mean |dL| >= 0.15 across deut/
 *       prot/trit).
 *
 * The remaining criteria (R2 layout, R3 flow, R5 world materials, R7 feedback)
 * cannot be measured from a static HUD; they are HELD at the committed rubric
 * worked-example baseline and reported as such. R4 palette cohesion is a light
 * check: brand ramp/token resolution post-theme.
 *
 * No dependency on the page — everything is pure functions over color strings
 * and a small set of DOM samplers. Exported as an ES module.
 */

/* =========================================================================
   Color parsing + WCAG relative luminance
   ========================================================================= */

/** Parse a CSS color string ("rgb(a)"/"#hex") into {r,g,b,a} in 0..255 / 0..1. */
export function parseColor(str) {
  if (!str) return null;
  str = String(str).trim();
  if (str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  // color(srgb r g b / a) — Chromium emits this for color-mix() results.
  // r,g,b are 0..1 floats; alpha optional after a slash.
  let m = str.match(/^color\(srgb\s+([^)]+)\)$/i);
  if (m) {
    const [rgbPart, aPart] = m[1].split('/');
    const parts = rgbPart.trim().split(/\s+/).map(parseFloat);
    let a = aPart != null ? parseFloat(aPart) : 1;
    if (/%$/.test(String(aPart))) a = parseFloat(aPart) / 100;
    return {
      r: parts[0] * 255,
      g: parts[1] * 255,
      b: parts[2] * 255,
      a: Number.isFinite(a) ? a : 1,
    };
  }
  m = str.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    // Accept comma-, space-, and slash-separated channels (modern + legacy).
    const parts = m[1].split(/[\s,/]+/).map((s) => s.trim()).filter(Boolean);
    const r = parseFloat(parts[0]);
    const g = parseFloat(parts[1]);
    const b = parseFloat(parts[2]);
    let a = parts.length > 3 ? parseFloat(parts[3]) : 1;
    if (/%$/.test(String(parts[3]))) a = parseFloat(parts[3]) / 100;
    return { r, g, b, a: Number.isFinite(a) ? a : 1 };
  }
  m = str.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
  }
  return null;
}

/** sRGB 0..255 channel -> linear 0..1 (WCAG / IEC 61966-2-1). */
export function linearizeChannel(c8) {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance L from an {r,g,b} (0..255) color. */
export function relLuminance({ r, g, b }) {
  const R = linearizeChannel(r);
  const G = linearizeChannel(g);
  const B = linearizeChannel(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** Alpha-composite fg (may be translucent) over an opaque bg. Returns {r,g,b}. */
export function composite(fg, bg) {
  const a = fg.a == null ? 1 : fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

/** WCAG contrast ratio between two opaque colors. */
export function contrastRatio(c1, c2) {
  const L1 = relLuminance(c1);
  const L2 = relLuminance(c2);
  const light = Math.max(L1, L2);
  const dark = Math.min(L1, L2);
  return (light + 0.05) / (dark + 0.05);
}

/* =========================================================================
   Effective background sampling (walk up for a non-transparent bg, then
   composite onto the document/world backdrop pixel behind the element).
   ========================================================================= */

/**
 * Resolve the EFFECTIVE opaque background behind an element by walking
 * ancestors and compositing every non-transparent background-color, finally
 * over the page's world/backdrop color sampled at the element's center.
 * @param {Element} el
 * @param {{worldColor?:{r,g,b,a}, worldColorAt?:(el:Element)=>({r,g,b,a}|null)}} [opts]
 * @returns {{r,g,b}} opaque background
 */
export function effectiveBackground(el, opts = {}) {
  const win = el.ownerDocument.defaultView;
  const stack = [];
  let node = el;
  while (node && node.nodeType === 1) {
    const cs = win.getComputedStyle(node);
    const bg = parseColor(cs.backgroundColor);
    if (bg && bg.a > 0) stack.push(bg);
    node = node.parentElement;
  }
  // Base: the "world"/body backdrop the HUD text ultimately sits over. Prefer
  // a per-element read of the actual rendered world pixel behind this element.
  let base = null;
  if (typeof opts.worldColorAt === 'function') base = opts.worldColorAt(el);
  base = base || opts.worldColor || { r: 20, g: 16, b: 31, a: 1 };
  base = { r: base.r, g: base.g, b: base.b };
  // Composite from the outermost (deepest ancestor) inward.
  for (let i = stack.length - 1; i >= 0; i--) {
    base = composite(stack[i], base);
  }
  return base;
}

/** True when the element carries a text-shadow using a dark (low-L) color. */
export function hasDarkTextShadow(cs) {
  const ts = cs.textShadow;
  if (!ts || ts === 'none') return { present: false };
  // Extract the first color in the shadow (rgb/rgba/#hex).
  const m = ts.match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/);
  const shadowColor = m ? parseColor(m[0]) : null;
  return { present: true, color: shadowColor };
}

/* =========================================================================
   R1 — WCAG contrast over a sampled text set
   ========================================================================= */

const R1_TEXT_SELECTORS = [
  // --- Shared menu chrome (present in both BEFORE and AFTER) ---
  '.menu-tagline',
  '.menu-footer',
  '.menu-footer--left',
  '.menu-footer--right',
  '.menu-h2',
  '.inv-hint',
  '.set-value',
  '.set-label',
  // --- BEFORE: bespoke builder HUD widgets ---
  '.dbg-v',
  '.dbg-k',
  '.dbg-title',
  '.chat-line',
  '.chat-name',
  '.chat-line--system',
  '.hb-num',
  // --- AFTER: adopted lf-* HUD widgets (different class names) ---
  '.lf-debug-overlay__val',
  '.lf-debug-overlay__key',
  '.lf-debug-overlay__title',
  '.lf-debug-overlay__section-title',
  '.lf-chat__line',
  '.lf-chat__name',
  '.lf-chat__text',
  '.lf-chat__time',
  '.lf-hotbar__label',
  '.lf-item-slot__count',
];

/** Which sampled selectors are "primary" reading text (rubric weighting). */
const R1_PRIMARY = new Set([
  '.menu-tagline', '.menu-h2', '.inv-hint', '.dbg-v', '.chat-line', '.set-value',
  '.lf-debug-overlay__val', '.lf-chat__text',
]);

/**
 * Sample text contrast across the rendered HUD/menu.
 * @param {Document|Element} root
 * @param {{worldColor?:{r,g,b,a}, threshold?:number}} [opts]
 * @returns {{samples:Array, minCR:number, primaryMinCR:number, r1:number,
 *            allPass:boolean}}
 */
export function sampleTextContrast(root, opts = {}) {
  const doc = root.ownerDocument || root;
  const win = doc.defaultView;
  const threshold = opts.threshold || 4.5;
  const samples = [];

  for (const sel of R1_TEXT_SELECTORS) {
    const els = root.querySelectorAll(sel);
    for (const el of els) {
      const cs = win.getComputedStyle(el);
      // Skip elements that are not rendered / have no text.
      const rect = el.getBoundingClientRect();
      const text = (el.textContent || '').trim();
      if (rect.width < 1 || rect.height < 1) continue;
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (parseFloat(cs.opacity) === 0) continue;
      if (!text) continue;

      const fg = parseColor(cs.color);
      if (!fg) continue;
      const bg = effectiveBackground(el, opts);
      const fgOpaque = composite(fg, bg);
      const cr = contrastRatio(fgOpaque, bg);

      // Text-shadow outline path (HUD-over-world text): a dark shadow forms a
      // legible edge even when fg-vs-bg is weak. Pass iff the shadow-vs-fg CR
      // >= threshold (the outline itself carries the contrast).
      const shadow = hasDarkTextShadow(cs);
      let shadowCR = null;
      let shadowPasses = false;
      if (shadow.present && shadow.color) {
        const shOpaque = composite(shadow.color, bg);
        shadowCR = contrastRatio(fgOpaque, shOpaque);
        shadowPasses = shadowCR >= threshold;
      }

      const pass = cr >= threshold || shadowPasses;
      samples.push({
        selector: sel,
        primary: R1_PRIMARY.has(sel),
        fg: cs.color,
        bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
        cr: Math.round(cr * 100) / 100,
        hasShadow: shadow.present,
        shadowCR: shadowCR == null ? null : Math.round(shadowCR * 100) / 100,
        shadowPasses,
        pass,
      });
    }
  }

  const crs = samples.map((s) => s.cr);
  const minCR = crs.length ? Math.min(...crs) : 0;
  const primary = samples.filter((s) => s.primary);
  const primaryMinCR = primary.length ? Math.min(...primary.map((s) => s.cr)) : 0;

  const allPass = samples.length > 0 && samples.every((s) => s.pass);
  const anyPrimaryHardFail = samples.some(
    (s) => s.primary && s.cr < 3.0 && !s.shadowPasses
  );
  const anySecondaryMid = samples.some(
    (s) => !s.pass && s.cr >= 3.0 && s.cr < 4.5
  );

  // R1 mapping: 5 = all pass; 3 = primary ok but some secondary 3.0-4.5;
  // 1 = any primary < 3.0 with no shadow.
  let r1 = 5;
  if (anyPrimaryHardFail) r1 = 1;
  else if (!allPass) r1 = anySecondaryMid ? 3 : 3;

  return { samples, minCR, primaryMinCR, r1, allPass };
}

/* =========================================================================
   R6.1 — Colorblind separation (Vienot-Brettel-Mollon dichromat sims)
   ========================================================================= */

/** linear RGB (0..1) -> LMS (Vienot-Brettel-Mollon). */
function rgbToLms(R, G, B) {
  return {
    L: 0.31399022 * R + 0.63951294 * G + 0.04649755 * B,
    M: 0.15537241 * R + 0.75789446 * G + 0.08670142 * B,
    S: 0.01775239 * R + 0.10944209 * G + 0.87256922 * B,
  };
}

/** LMS -> linear RGB (0..1). */
function lmsToRgb({ L, M, S }) {
  return {
    R: 5.47221206 * L - 4.6419601 * M + 0.16963708 * S,
    G: -1.1252419 * L + 2.29317094 * M - 0.1678952 * S,
    B: 0.02980165 * L - 0.19318073 * M + 1.16364789 * S,
  };
}

/** Apply a dichromat projection ('prot'|'deut'|'trit') to an LMS triple. */
function project(lms, kind) {
  const { L, M, S } = lms;
  if (kind === 'prot') return { L: 1.05118294 * M - 0.05116099 * S, M, S };
  if (kind === 'deut') return { L, M: 0.9513092 * L + 0.04866992 * S, S };
  if (kind === 'trit') return { L, M, S: -0.86744736 * L + 1.86727089 * M };
  return lms;
}

/**
 * Relative luminance of an {r,g,b} 0..255 color AS SEEN under a dichromat sim.
 * (linearize -> LMS -> project -> back to linear RGB -> WCAG luminance)
 * @param {{r,g,b}} c @param {'prot'|'deut'|'trit'} kind
 * @returns {number} luminance in 0..1
 */
export function simulatedLuminance(c, kind) {
  const R = linearizeChannel(c.r);
  const G = linearizeChannel(c.g);
  const B = linearizeChannel(c.b);
  const lms = rgbToLms(R, G, B);
  const proj = project(lms, kind);
  const back = lmsToRgb(proj);
  // Clamp negative excursions the projection can produce.
  const Rl = Math.max(0, Math.min(1, back.R));
  const Gl = Math.max(0, Math.min(1, back.G));
  const Bl = Math.max(0, Math.min(1, back.B));
  return 0.2126 * Rl + 0.7152 * Gl + 0.0722 * Bl;
}

/**
 * Pick the most salient "selection-frame" color from a selected element:
 * the candidate (outline / border / box-shadow / background) whose luminance
 * differs most from the neighbor background — i.e. the actual visual cue.
 * @param {Element} el @param {{r,g,b}} neighborBg
 * @returns {{color:{r,g,b}, source:string}|null}
 */
export function selectionFrameColor(el, neighborBg) {
  const win = el.ownerDocument.defaultView;
  const cs = win.getComputedStyle(el);
  const candidates = [];
  const push = (raw, source) => {
    const c = parseColor(raw);
    if (c && c.a > 0) candidates.push({ color: composite(c, neighborBg), source });
  };
  push(cs.outlineColor, 'outline');
  push(cs.borderTopColor, 'border');
  // box-shadow: pull every color token out of the shorthand.
  const bs = cs.boxShadow;
  if (bs && bs !== 'none') {
    const cols = bs.match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/g) || [];
    cols.forEach((raw, i) => push(raw, 'box-shadow[' + i + ']'));
  }
  push(cs.backgroundColor, 'background');
  if (!candidates.length) return null;
  // Choose the candidate with the largest normal-vision luminance delta.
  const bgL = relLuminance(neighborBg);
  candidates.sort(
    (a, b) => Math.abs(relLuminance(b.color) - bgL) - Math.abs(relLuminance(a.color) - bgL)
  );
  return candidates[0];
}

/**
 * Measure the hotbar selection cue's colorblind separation.
 * @param {Element} selectedEl the selected slot element
 * @param {Element} neighborEl an adjacent unselected slot
 * @param {{worldColor?:{r,g,b,a}, threshold?:number}} [opts]
 * @returns {{frame:{r,g,b}, neighborBg:{r,g,b}, source:string,
 *            dL:{deut:number, prot:number, trit:number}, mean:number,
 *            pass:boolean}|null}
 */
export function sampleSelectionColorblind(selectedEl, neighborEl, opts = {}) {
  if (!selectedEl || !neighborEl) return null;
  const threshold = opts.threshold || 0.15;
  const neighborBg = effectiveBackground(neighborEl, opts);
  const frameHit = selectionFrameColor(selectedEl, neighborBg);
  if (!frameHit) return null;
  const frame = frameHit.color;

  const dL = {};
  for (const kind of ['deut', 'prot', 'trit']) {
    const lf = simulatedLuminance(frame, kind);
    const lb = simulatedLuminance(neighborBg, kind);
    dL[kind] = Math.round(Math.abs(lf - lb) * 1000) / 1000;
  }
  const mean = Math.round(((dL.deut + dL.prot + dL.trit) / 3) * 1000) / 1000;
  const pass = dL.deut >= threshold && dL.prot >= threshold && dL.trit >= threshold;
  return {
    frame: { r: Math.round(frame.r), g: Math.round(frame.g), b: Math.round(frame.b) },
    neighborBg: {
      r: Math.round(neighborBg.r),
      g: Math.round(neighborBg.g),
      b: Math.round(neighborBg.b),
    },
    source: frameHit.source,
    dL,
    mean,
    pass,
  };
}

/* =========================================================================
   R4 — palette cohesion (light check): do sampled UI colors resolve to brand
   ramp/token values? Post-theme every widget reads --lf-* tokens.
   ========================================================================= */

/**
 * @param {Document|Element} root
 * @param {boolean} themed whether applyTheme() has run
 * @returns {{r4:number, tokenPresent:boolean}}
 */
export function samplePaletteCohesion(root, themed) {
  const doc = root.ownerDocument || root;
  const win = doc.defaultView;
  // The brand token is defined once applyTheme() links tokens.css.
  const rootStyle = win.getComputedStyle(doc.documentElement);
  const brandPrimary = rootStyle.getPropertyValue('--lf-brand-primary').trim();
  const tokenPresent = !!brandPrimary;
  // AFTER: all widget colors resolve through brand tokens -> 5.
  // BEFORE: bespoke palette, internally consistent -> baseline 4.
  const r4 = themed && tokenPresent ? 5 : 4;
  return { r4, tokenPresent };
}

/* =========================================================================
   Composite score()
   ========================================================================= */

/** Held-at-baseline criteria (rubric worked example) — NOT measured here. */
export const HELD_BASELINE = { R2: 4, R3: 5, R5: 3, R7: 3 };

/** Rubric weights (percent). */
export const WEIGHTS = { R1: 20, R2: 15, R3: 10, R4: 15, R5: 15, R6: 15, R7: 10 };

/**
 * Compute the full per-criterion + overall score for the CURRENT rendered
 * state. R1/R6 are MEASURED on pixels; R4 is a measured palette check; the
 * rest are held at the committed baseline.
 * @param {object} args
 * @param {Document|Element} args.root
 * @param {boolean} args.themed
 * @param {Element} args.selectedSlot
 * @param {Element} args.neighborSlot
 * @param {{worldColor?:{r,g,b,a}}} [args.opts]
 * @returns {object} report
 */
export function score({ root, themed, selectedSlot, neighborSlot, opts = {} }) {
  const contrast = sampleTextContrast(root, opts);
  const cb = sampleSelectionColorblind(selectedSlot, neighborSlot, opts);
  const palette = samplePaletteCohesion(root, themed);

  const R1 = contrast.r1;
  const R6 = cb ? (cb.pass ? 5 : cb.mean >= 0.1 ? 3 : 1) : 1;
  const R4 = palette.r4;
  const { R2, R3, R5, R7 } = HELD_BASELINE;

  const overall =
    (R1 * WEIGHTS.R1 +
      R2 * WEIGHTS.R2 +
      R3 * WEIGHTS.R3 +
      R4 * WEIGHTS.R4 +
      R5 * WEIGHTS.R5 +
      R6 * WEIGHTS.R6 +
      R7 * WEIGHTS.R7) /
    100;

  const criteria = { R1, R2, R3, R4, R5, R6, R7 };
  const measured = { R1: true, R2: false, R3: false, R4: true, R5: false, R6: true, R7: false };
  const anyLow = Object.values(criteria).some((v) => v <= 2);
  const gatePass = overall >= 3.0 && !anyLow;

  return {
    themed,
    criteria,
    measured,
    overall: Math.round(overall * 100) / 100,
    gatePass,
    contrast: {
      minCR: Math.round(contrast.minCR * 100) / 100,
      primaryMinCR: Math.round(contrast.primaryMinCR * 100) / 100,
      allPass: contrast.allPass,
      sampleCount: contrast.samples.length,
      samples: contrast.samples,
    },
    colorblind: cb,
    palette,
  };
}
