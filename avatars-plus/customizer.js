// avatars-plus/customizer.js
// CharacterCustomizer — lf-* skin editor UI + live auto-rotating 3D avatar preview.

import * as THREE from "three";
import createAvatarPlus from "./avatar-plus.js";
import {
  THEME_IDS,
  WEAVE_MOTIFS,
  defaultDescriptor,
  normalizeDescriptor,
  encodeDescriptor,
  decodeDescriptor,
} from "./skin-descriptor.js";

// Register the vendored lf-* elements this UI instantiates (side-effect imports).
import "./vendor/ui-kit/components/button.js";
import "./vendor/ui-kit/components/slider.js";
import "./vendor/ui-kit/components/tabs.js";
import "./vendor/ui-kit/components/modal.js";
import "./vendor/ui-kit/components/toggle.js";
import "./vendor/ui-kit/components/tooltip.js";

import { RovingTabindex } from "./vendor/ui-kit/lf-core.js";

/** Clamp v into [0,1]; non-finite -> 0. */
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Finite-or-fallback scalar guard. */
const num = (v, d) => (Number.isFinite(v) ? v : d);

/** Default localStorage key for the saved profile. */
const DEFAULT_STORAGE_KEY = "loomfall.profile";

/** Schema version stamped into the persisted JSON blob. */
const SCHEMA_VERSION = 1;

/**
 * Per-theme swatch gradients, expressed ONLY with --lf-* tokens (no raw hex),
 * so the theme grid honours the token discipline. Index == THEME_IDS index.
 * Each swatch also carries its theme NAME + a selected shape cue, never hue-only.
 * @type {string[]}
 */
const THEME_SWATCH_BG = [
  "linear-gradient(135deg, var(--lf-ramp-warpwold-1), var(--lf-ramp-warpwold-3), var(--lf-ramp-warpwold-5))",
  "linear-gradient(135deg, var(--lf-ramp-cinderloom-2), var(--lf-ramp-cinderloom-4), var(--lf-ramp-cinderloom-6))",
  "linear-gradient(135deg, var(--lf-ramp-nevermend-2), var(--lf-ramp-nevermend-4), var(--lf-ramp-nevermend-6))",
  "linear-gradient(135deg, var(--lf-brand-primary-deep-ochre), var(--lf-brand-primary), var(--lf-brand-primary-glow))",
  "linear-gradient(135deg, var(--lf-accent-dye-indigo), var(--lf-accent-hemstone-cyan), var(--lf-brand-primary-pale))",
  "linear-gradient(135deg, var(--lf-color-border-hem), var(--lf-brand-muslin), var(--lf-color-text-dim))",
];

/** Title-case a hyphenated theme id, e.g. "warpwold-mender" -> "Warpwold Mender". */
function labelFromId(id) {
  return String(id || "")
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/* -------------------------------------------------------------------------- */
/* One-time stylesheet (all colors from --lf-* tokens; never raw hex)          */
/* -------------------------------------------------------------------------- */

const STYLE_ID = "ap-customizer-style";
function injectStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.ap-cz {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: var(--lf-space-3);
  padding: var(--lf-space-4);
  background: var(--lf-color-bg-panel);
  border: var(--lf-border-hem);
  border-radius: var(--lf-radius-lg);
  color: var(--lf-color-text-body);
  font-family: var(--lf-font-ui);
  font-size: var(--lf-text-md);
  z-index: var(--lf-z-screen);
}
.ap-cz[hidden] { display: none; }
.ap-cz__title {
  margin: 0;
  font-size: var(--lf-text-lg);
  color: var(--lf-color-text-heading);
  letter-spacing: 0.02em;
}
.ap-cz__section-label {
  font-size: var(--lf-text-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--lf-color-text-dim);
  margin-bottom: var(--lf-space-1);
}

/* Theme swatch grid ------------------------------------------------------- */
.ap-cz__swatches {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--lf-space-2);
}
.ap-cz__swatch {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  min-height: 56px;
  padding: var(--lf-space-1) var(--lf-space-2);
  border: var(--lf-border-width) solid var(--lf-color-border-hem);
  border-radius: var(--lf-radius-md);
  background: var(--lf-color-bg-raised);
  color: var(--lf-color-text-heading);
  font-family: var(--lf-font-ui);
  font-size: var(--lf-text-xs);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: border-color var(--lf-dur-fast) var(--lf-ease);
}
.ap-cz__swatch::before {
  content: "";
  position: absolute;
  inset: 0;
  background: var(--ap-swatch-bg, var(--lf-color-bg-raised));
  opacity: 0.9;
  z-index: 0;
}
.ap-cz__swatch-name {
  position: relative;
  z-index: 1;
  padding: 2px 4px;
  border-radius: var(--lf-radius-sm);
  background: var(--lf-color-screen-dim);
  color: var(--lf-color-text-heading);
  text-shadow: 0 1px 0 var(--lf-color-hud-shadow);
}
.ap-cz__swatch:hover,
.ap-cz__swatch:focus-visible {
  border-color: var(--lf-brand-primary);
}
.ap-cz__swatch:focus-visible {
  outline: var(--lf-focus-ring);
  outline-offset: var(--lf-focus-ring-offset);
}
/* Selected: thick gold hem + corner check glyph (shape cue, not hue-only). */
.ap-cz__swatch[aria-selected="true"] {
  border-color: var(--lf-brand-primary);
  box-shadow: inset 0 0 0 2px var(--lf-brand-primary);
}
.ap-cz__swatch-check {
  position: absolute;
  top: 3px;
  right: 3px;
  z-index: 1;
  width: 16px;
  height: 16px;
  display: none;
  align-items: center;
  justify-content: center;
  border-radius: var(--lf-radius-pill);
  background: var(--lf-brand-primary);
  color: var(--lf-brand-void);
  font-size: 11px;
  line-height: 1;
}
.ap-cz__swatch[aria-selected="true"] .ap-cz__swatch-check { display: flex; }

/* Sliders ----------------------------------------------------------------- */
.ap-cz__sliders { display: flex; flex-direction: column; gap: var(--lf-space-2); }

/* Weave motif tabs (panels are choice-only; hide the empty panel body) ----- */
.ap-cz__weave lf-tabs .lf-tabs__panels { display: none; }

/* Buttons + export -------------------------------------------------------- */
.ap-cz__actions { display: flex; flex-wrap: wrap; gap: var(--lf-space-2); }
.ap-cz__export { display: flex; gap: var(--lf-space-2); align-items: stretch; }
.ap-cz__export-field {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--lf-font-mono);
  font-size: var(--lf-text-sm);
  color: var(--lf-color-input-text);
  background: var(--lf-color-bg-input);
  border: var(--lf-border-width) solid var(--lf-color-border-hem);
  border-radius: var(--lf-radius-md);
  padding: var(--lf-space-1) var(--lf-space-2);
}
.ap-cz__export-field:focus-visible {
  outline: var(--lf-focus-ring);
  outline-offset: var(--lf-focus-ring-offset);
}
.ap-cz__status {
  min-height: var(--lf-text-md);
  font-size: var(--lf-text-xs);
  color: var(--lf-color-text-dim);
}
`;
  (document.head || document.documentElement).appendChild(style);
}

/* -------------------------------------------------------------------------- */
/* CharacterCustomizer                                                          */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {import("./skin-descriptor.js").Descriptor} Descriptor
 */

/**
 * CharacterCustomizer builds a Loomfall skin editor from vendored lf-* elements
 * (theme swatch grid + threadHue/accent/accentStrength sliders + a weave-motif
 * tab row + Randomize/Reset/Save/Load/Export buttons) and drives a small live,
 * auto-rotating 3D avatar preview (its own THREE.WebGLRenderer on the supplied
 * canvas). Every control change normalizes the working Descriptor, pushes it to
 * the preview (avatar.setDescriptor), refreshes the exported wire string, and
 * invokes the onChange callback. Save/Load persist to localStorage. Defensive:
 * missing mount/canvas/WebGL degrade gracefully and no method throws.
 */
export class CharacterCustomizer {
  /**
   * @param {{
   *   mount?: HTMLElement,
   *   previewCanvas?: HTMLCanvasElement,
   *   descriptor?: Partial<Descriptor>,
   *   onChange?: (descriptor: Descriptor) => void,
   *   storageKey?: string
   * }} [opts]
   */
  constructor(opts = {}) {
    const o = opts && typeof opts === "object" ? opts : {};
    /** @private */ this._mount = o.mount instanceof HTMLElement ? o.mount : null;
    /** @private */ this._canvas = o.previewCanvas || null;
    /** @private */ this._onChange = typeof o.onChange === "function" ? o.onChange : null;
    /** @private */ this._storageKey =
      typeof o.storageKey === "string" && o.storageKey ? o.storageKey : DEFAULT_STORAGE_KEY;

    /** @private @type {Descriptor} */
    this._descriptor = normalizeDescriptor(o.descriptor || defaultDescriptor(THEME_IDS[0]));

    // UI element handles (populated by _buildUI).
    /** @private */ this._root = null;
    /** @private */ this._swatches = [];
    /** @private */ this._swatchRove = null;
    /** @private */ this._weaveTabs = null;
    /** @private */ this._sHue = null;
    /** @private */ this._sAccent = null;
    /** @private */ this._sStrength = null;
    /** @private */ this._exportField = null;
    /** @private */ this._statusEl = null;

    // Preview (3D) handles.
    /** @private */ this._renderer = null;
    /** @private */ this._scene = null;
    /** @private */ this._camera = null;
    /** @private */ this._pivot = null;
    /** @private */ this._preview = null;
    /** @private */ this._raf = 0;
    /** @private */ this._lastT = 0;
    /** @private */ this._cw = 0;
    /** @private */ this._ch = 0;
    /** @private */ this._disposed = false;
    /** @private */ this._tick = null;

    try {
      injectStyle();
      this._buildUI();
      this._buildPreview();
      this._syncControls();
      this._syncExport();
      if (this._preview) this._preview.setDescriptor(this._descriptor);
      this._startLoop();
    } catch (_err) {
      /* never throw from the constructor */
    }
  }

  /* ---- Public API ------------------------------------------------------- */

  /**
   * @returns {Descriptor} a copy of the current working descriptor.
   */
  getDescriptor() {
    return { ...this._descriptor };
  }

  /**
   * Programmatically set the descriptor (does NOT fire onChange). Syncs every
   * control, the export string, and the live preview. Never throws.
   * @param {Partial<Descriptor>|string} d descriptor object OR an encoded string.
   */
  setDescriptor(d) {
    try {
      const desc = typeof d === "string" ? decodeDescriptor(d) : d;
      this._apply(desc, { user: false, resync: true });
    } catch (_err) {
      /* ignore */
    }
  }

  /** Show the customizer panel. @returns {void} */
  open() {
    if (this._root) this._root.hidden = false;
  }

  /** Hide the customizer panel (the preview loop keeps running). @returns {void} */
  close() {
    if (this._root) this._root.hidden = true;
  }

  /**
   * Tear down: stop the RAF loop, dispose the preview avatar + renderer, remove
   * listeners and DOM. Idempotent. Never throws.
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
    try {
      if (this._swatchRove) this._swatchRove.destroy();
    } catch (_e) {}
    try {
      if (this._preview) this._preview.dispose();
    } catch (_e) {}
    try {
      if (this._renderer) this._renderer.dispose();
    } catch (_e) {}
    try {
      if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    } catch (_e) {}
    this._preview = null;
    this._renderer = null;
    this._scene = null;
    this._pivot = null;
    this._swatches = [];
  }

  /* ---- UI construction -------------------------------------------------- */

  /** @private Build the lf-* editor DOM into the mount element. */
  _buildUI() {
    if (!this._mount || typeof document === "undefined") return;

    const root = document.createElement("div");
    root.className = "ap-cz";
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "Character customizer");

    const title = document.createElement("h2");
    title.className = "ap-cz__title";
    title.textContent = "Appearance";
    root.appendChild(title);

    // --- Theme swatch grid ---
    root.appendChild(this._sectionLabel("Theme"));
    const grid = document.createElement("div");
    grid.className = "ap-cz__swatches";
    grid.setAttribute("role", "listbox");
    grid.setAttribute("aria-label", "Theme");
    this._swatches = THEME_IDS.map((id, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ap-cz__swatch";
      btn.setAttribute("role", "option");
      btn.dataset.index = String(i);
      btn.style.setProperty("--ap-swatch-bg", THEME_SWATCH_BG[i] || "");
      const check = document.createElement("span");
      check.className = "ap-cz__swatch-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "✓"; // ✓
      const name = document.createElement("span");
      name.className = "ap-cz__swatch-name";
      name.textContent = labelFromId(id);
      btn.append(check, name);
      btn.addEventListener("click", () => this._selectTheme(i));
      grid.appendChild(btn);
      return btn;
    });
    root.appendChild(grid);
    try {
      this._swatchRove = new RovingTabindex(grid, {
        selector: ".ap-cz__swatch",
        orientation: "both",
        wrap: true,
        grid: { columns: 3 },
        onActivate: (_item, index) => this._selectTheme(index),
      });
    } catch (_e) {
      this._swatchRove = null;
    }

    // --- Sliders ---
    root.appendChild(this._sectionLabel("Threads"));
    const sliders = document.createElement("div");
    sliders.className = "ap-cz__sliders";

    this._sHue = this._makeSlider("Thread Hue", 0, 359, 1, this._descriptor.threadHue, "°");
    this._sHue.addEventListener("lf-input", (e) =>
      this._apply({ threadHue: this._detailValue(e) }, { user: true })
    );

    this._sAccent = this._makeSlider("Accent Hue", 0, 359, 1, this._descriptor.accent, "°");
    this._sAccent.addEventListener("lf-input", (e) =>
      this._apply({ accent: this._detailValue(e) }, { user: true })
    );

    this._sStrength = this._makeSlider(
      "Accent Strength",
      0,
      100,
      1,
      Math.round(this._descriptor.accentStrength * 100),
      "%"
    );
    this._sStrength.addEventListener("lf-input", (e) =>
      this._apply({ accentStrength: this._detailValue(e) / 100 }, { user: true })
    );

    sliders.append(this._sHue, this._sAccent, this._sStrength);
    root.appendChild(sliders);

    // --- Weave motif tabs ---
    root.appendChild(this._sectionLabel("Weave"));
    const weaveWrap = document.createElement("div");
    weaveWrap.className = "ap-cz__weave";
    const tabs = document.createElement("lf-tabs");
    tabs.setAttribute("label", "Weave motif");
    tabs.setAttribute("selected", String(this._descriptor.weave));
    WEAVE_MOTIFS.forEach((motif) => {
      const panel = document.createElement("section");
      panel.setAttribute("data-tab-label", motif);
      tabs.appendChild(panel);
    });
    tabs.addEventListener("lf-select", (e) => {
      const idx = e && e.detail ? e.detail.index : undefined;
      if (Number.isFinite(idx)) this._apply({ weave: idx }, { user: true });
    });
    weaveWrap.appendChild(tabs);
    root.appendChild(weaveWrap);
    this._weaveTabs = tabs;

    // --- Action buttons ---
    const actions = document.createElement("div");
    actions.className = "ap-cz__actions";
    actions.append(
      this._makeButton("Randomize", "randomize", "secondary", () => this._randomize()),
      this._makeButton("Reset", "reset", "secondary", () => this._reset()),
      this._makeButton("Save", "save", "primary", () => this._save()),
      this._makeButton("Load", "load", "secondary", () => this._load()),
      this._makeButton("Export", "export", "secondary", () => this._exportCopy())
    );
    root.appendChild(actions);

    // --- Export wire string (readonly) + copy ---
    root.appendChild(this._sectionLabel("Wire string"));
    const exportRow = document.createElement("div");
    exportRow.className = "ap-cz__export";
    const field = document.createElement("input");
    field.type = "text";
    field.readOnly = true;
    field.className = "ap-cz__export-field";
    field.setAttribute("aria-label", "Encoded skin descriptor (read only)");
    field.addEventListener("focus", () => field.select());
    exportRow.appendChild(field);
    exportRow.appendChild(
      this._makeButton("Copy", "copy", "secondary", () => this._exportCopy())
    );
    root.appendChild(exportRow);
    this._exportField = field;

    const status = document.createElement("div");
    status.className = "ap-cz__status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    root.appendChild(status);
    this._statusEl = status;

    this._mount.appendChild(root);
    this._root = root;
  }

  /** @private @param {string} text @returns {HTMLElement} */
  _sectionLabel(text) {
    const el = document.createElement("div");
    el.className = "ap-cz__section-label";
    el.textContent = text;
    return el;
  }

  /** @private Build a configured <lf-slider>. */
  _makeSlider(label, min, max, step, value, unit) {
    const s = document.createElement("lf-slider");
    s.setAttribute("label", label);
    s.setAttribute("min", String(min));
    s.setAttribute("max", String(max));
    s.setAttribute("step", String(step));
    s.setAttribute("value", String(value));
    if (unit) s.setAttribute("unit", unit);
    return s;
  }

  /** @private Build an <lf-button> wired to a handler via lf-action. */
  _makeButton(label, action, variant, handler) {
    const b = document.createElement("lf-button");
    b.setAttribute("variant", variant);
    b.setAttribute("action", action);
    b.setAttribute("size", "sm");
    b.textContent = label;
    b.addEventListener("lf-action", () => {
      try {
        handler();
      } catch (_e) {}
    });
    return b;
  }

  /** @private Safely read a numeric value off an lf-input/lf-change event. */
  _detailValue(e) {
    const v = e && e.detail ? e.detail.value : NaN;
    return Number.isFinite(v) ? v : 0;
  }

  /* ---- State transitions ------------------------------------------------ */

  /**
   * @private Merge a patch, normalize, push to preview + export, and (when the
   * change came from the user) invoke onChange.
   * @param {Partial<Descriptor>} patch
   * @param {{user?: boolean, resync?: boolean}} [flags]
   */
  _apply(patch, flags = {}) {
    const merged = { ...this._descriptor, ...(patch || {}) };
    this._descriptor = normalizeDescriptor(merged);
    if (flags.resync) this._syncControls();
    else this._syncSwatches(); // theme highlight may still change on user patches
    this._syncExport();
    if (this._preview) {
      try {
        this._preview.setDescriptor(this._descriptor);
      } catch (_e) {}
    }
    if (flags.user && this._onChange) {
      try {
        this._onChange({ ...this._descriptor });
      } catch (_e) {}
    }
  }

  /** @private @param {number} index theme index in THEME_IDS. */
  _selectTheme(index) {
    const id = THEME_IDS[index];
    if (!id) return;
    this._apply({ theme: id }, { user: true });
  }

  /** @private Randomize every field (UI action — appearance stays deterministic). */
  _randomize() {
    const r = () => Math.random();
    this._apply(
      {
        theme: THEME_IDS[Math.floor(r() * THEME_IDS.length)],
        threadHue: Math.floor(r() * 360),
        accent: Math.floor(r() * 360),
        weave: Math.floor(r() * WEAVE_MOTIFS.length),
        accentStrength: clamp01(r()),
      },
      { user: true, resync: true }
    );
    this._flash("Randomized");
  }

  /** @private Reset to the current theme's defaults. */
  _reset() {
    this._apply(defaultDescriptor(this._descriptor.theme), { user: true, resync: true });
    this._flash("Reset to defaults");
  }

  /** @private Persist the current descriptor to localStorage. */
  _save() {
    try {
      if (typeof localStorage === "undefined") {
        this._flash("Saving unavailable");
        return;
      }
      const blob = {
        v: SCHEMA_VERSION,
        descriptor: { ...this._descriptor },
        encoded: encodeDescriptor(this._descriptor),
        savedAt: Date.now(),
      };
      localStorage.setItem(this._storageKey, JSON.stringify(blob));
      this._flash("Saved");
    } catch (_e) {
      this._flash("Save failed");
    }
  }

  /** @private Load the persisted descriptor from localStorage (if any). */
  _load() {
    try {
      if (typeof localStorage === "undefined") {
        this._flash("Loading unavailable");
        return;
      }
      const raw = localStorage.getItem(this._storageKey);
      if (!raw) {
        this._flash("Nothing saved");
        return;
      }
      const blob = JSON.parse(raw);
      const desc =
        blob && blob.descriptor
          ? blob.descriptor
          : blob && typeof blob.encoded === "string"
          ? decodeDescriptor(blob.encoded)
          : blob;
      this._apply(desc, { user: true, resync: true });
      this._flash("Loaded");
    } catch (_e) {
      this._flash("Load failed");
    }
  }

  /** @private Copy the encoded wire string to the clipboard (best effort). */
  _exportCopy() {
    const str = encodeDescriptor(this._descriptor);
    if (this._exportField) {
      this._exportField.value = str;
      try {
        this._exportField.focus();
        this._exportField.select();
      } catch (_e) {}
    }
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(str).then(
          () => this._flash("Copied wire string"),
          () => this._flash(str)
        );
        return;
      }
    } catch (_e) {}
    this._flash(str);
  }

  /** @private Show a transient status message. @param {string} msg */
  _flash(msg) {
    if (this._statusEl) this._statusEl.textContent = String(msg == null ? "" : msg);
  }

  /* ---- Control <-> state sync ------------------------------------------ */

  /** @private Reflect the descriptor into every control. */
  _syncControls() {
    this._syncSwatches();
    this._syncSliders();
    this._syncWeave();
  }

  /** @private */
  _syncSwatches() {
    const idx = THEME_IDS.indexOf(this._descriptor.theme);
    for (let i = 0; i < this._swatches.length; i += 1) {
      this._swatches[i].setAttribute("aria-selected", i === idx ? "true" : "false");
    }
  }

  /** @private */
  _syncSliders() {
    if (this._sHue) this._sHue.setAttribute("value", String(this._descriptor.threadHue));
    if (this._sAccent) this._sAccent.setAttribute("value", String(this._descriptor.accent));
    if (this._sStrength)
      this._sStrength.setAttribute(
        "value",
        String(Math.round(this._descriptor.accentStrength * 100))
      );
  }

  /** @private */
  _syncWeave() {
    if (this._weaveTabs) this._weaveTabs.setAttribute("selected", String(this._descriptor.weave));
  }

  /** @private Refresh the readonly export field with the current wire string. */
  _syncExport() {
    if (this._exportField) this._exportField.value = encodeDescriptor(this._descriptor);
  }

  /* ---- Live 3D preview -------------------------------------------------- */

  /** @private Stand up the WebGL preview scene + avatar. Degrades if unavailable. */
  _buildPreview() {
    if (!this._canvas) return;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: this._canvas,
        antialias: true,
        alpha: true,
      });
      renderer.setPixelRatio(Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1));
      renderer.setClearColor(0x000000, 0);
      if ("outputColorSpace" in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
    } catch (_e) {
      this._renderer = null;
      return;
    }
    this._renderer = renderer;

    const scene = new THREE.Scene();
    this._scene = scene;

    const hemi = new THREE.HemisphereLight(0xf7f2e4, 0x2c3247, 1.05);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(1.4, 2.4, 1.8);
    scene.add(dir);

    const w = this._canvas.clientWidth || 320;
    const h = this._canvas.clientHeight || 360;
    this._cw = w;
    this._ch = h;
    renderer.setSize(w, h, false);
    const camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 100);
    camera.position.set(0, 1.05, 3.5);
    camera.lookAt(0, 0.95, 0);
    this._camera = camera;

    // Avatar in a spin pivot so the slow auto-rotation is independent of the
    // rig's own group.rotation.y (which the Animator writes each frame).
    const pivot = new THREE.Group();
    pivot.name = "ap-cz-pivot";
    scene.add(pivot);
    this._pivot = pivot;

    try {
      this._preview = createAvatarPlus({
        name: "Preview",
        self: true,
        descriptor: this._descriptor,
      });
      if (this._preview) {
        if (typeof this._preview.setNameVisible === "function")
          this._preview.setNameVisible(false);
        if (this._preview.group) pivot.add(this._preview.group);
      }
    } catch (_e) {
      this._preview = null;
    }
  }

  /** @private Start the requestAnimationFrame render loop. */
  _startLoop() {
    if (!this._renderer || typeof requestAnimationFrame === "undefined") return;
    this._lastT = typeof performance !== "undefined" ? performance.now() : Date.now();
    const tick = () => {
      if (this._disposed) return;
      this._raf = requestAnimationFrame(tick);
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      let dt = (now - this._lastT) / 1000;
      this._lastT = now;
      if (!(dt > 0) || dt > 0.1) dt = dt > 0.1 ? 0.1 : 0.016;
      this._renderFrame(dt);
    };
    this._tick = tick;
    this._raf = requestAnimationFrame(tick);
  }

  /** @private One preview frame: resize check, spin, avatar update, render. */
  _renderFrame(dt) {
    const canvas = this._canvas;
    const renderer = this._renderer;
    const camera = this._camera;
    if (!renderer || !camera) return;

    // Resize on demand (scalar compares only — no per-frame allocation).
    const w = canvas.clientWidth || this._cw || 320;
    const h = canvas.clientHeight || this._ch || 360;
    if (w !== this._cw || h !== this._ch) {
      this._cw = w;
      this._ch = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    if (this._pivot) this._pivot.rotation.y += dt * 0.6; // slow spin
    if (this._preview) {
      try {
        this._preview.update(dt, camera.position);
      } catch (_e) {}
    }
    try {
      renderer.render(this._scene, camera);
    } catch (_e) {}
  }
}

export default CharacterCustomizer;
