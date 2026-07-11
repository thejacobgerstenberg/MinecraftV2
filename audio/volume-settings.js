// audio/volume-settings.js
// <volume-settings> — a drop-in custom element with three labeled sliders
// (Master, SFX, Music) that drive an AudioEngine's bus volumes.
//
// Usage:
//   import "./volume-settings.js";
//   const el = document.createElement("volume-settings"); // or in HTML: <volume-settings></volume-settings>
//   document.body.appendChild(el);
//   el.engine = engineInstance; // property setter — wires sliders to the engine
//
// Behavior:
//   - Renders inside a shadow root with minimal, self-contained dark styling.
//   - Sliders are 0..1 with step 0.01. On input they call
//     engine.setMasterVolume / engine.setSfxVolume / engine.setMusicVolume.
//   - Values persist to localStorage under the key "audio.volumes"
//     (JSON: { master, sfx, music }) and are re-applied to the engine every
//     time `engine` is assigned.
//   - With no engine assigned the sliders are still visible (and remember
//     their values) but drive nothing.
//
// The class is also the default export.

const STORAGE_KEY = "audio.volumes";

const DEFAULTS = { master: 1, sfx: 1, music: 1 };

/** Engine setter method for each slider id. */
const ENGINE_SETTERS = {
  master: "setMasterVolume",
  sfx: "setSfxVolume",
  music: "setMusicVolume",
};

const LABELS = { master: "Master", sfx: "SFX", music: "Music" };

/** Clamp to [0, 1]; non-finite input falls back to `fallback`. */
function clamp01(v, fallback = 1) {
  v = +v;
  if (!isFinite(v)) return fallback;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Read persisted volumes; always returns a full, clamped {master,sfx,music}. */
function loadVolumes() {
  const out = { ...DEFAULTS };
  try {
    const raw =
      typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const k of Object.keys(DEFAULTS)) {
          if (parsed[k] != null) out[k] = clamp01(parsed[k], DEFAULTS[k]);
        }
      }
    }
  } catch (_e) {
    // Missing/blocked storage or corrupt JSON — fall back to defaults.
  }
  return out;
}

/** Persist volumes; silently ignores unavailable/blocked storage. */
function saveVolumes(volumes) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(volumes));
    }
  } catch (_e) {
    // Storage full/blocked — non-fatal.
  }
}

const STYLE = `
  :host {
    display: inline-block;
    box-sizing: border-box;
    min-width: 220px;
    padding: 12px 14px;
    border-radius: 8px;
    background: #1c1f24;
    border: 1px solid #33383f;
    color: #d5d9de;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 13px;
    line-height: 1.4;
  }
  .title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #8b929b;
    margin-bottom: 10px;
  }
  .row {
    display: grid;
    grid-template-columns: 52px 1fr 34px;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
  }
  label {
    color: #aeb4bc;
    user-select: none;
  }
  .value {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: #8b929b;
  }
  input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 4px;
    margin: 0;
    border-radius: 2px;
    background: #3a4048;
    outline: none;
    cursor: pointer;
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #6fbf73;
    border: none;
  }
  input[type="range"]::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #6fbf73;
    border: none;
  }
  input[type="range"]:focus-visible {
    box-shadow: 0 0 0 2px rgba(111, 191, 115, 0.4);
  }
`;

/**
 * VolumeSettings — custom element class for <volume-settings>.
 * Assign `.engine` (an AudioEngine instance) to wire the sliders up; the
 * persisted volumes are pushed into the engine at assignment time.
 */
class VolumeSettings extends HTMLElement {
  constructor() {
    super();
    /** @private engine instance (or null while unassigned) */
    this._engine = null;
    /** @private current volumes, seeded from localStorage */
    this._volumes = loadVolumes();
    /** @private slider/value elements by id */
    this._inputs = {};
    this._values = {};

    const root = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = STYLE;
    root.appendChild(style);

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Volume";
    root.appendChild(title);

    for (const id of Object.keys(DEFAULTS)) {
      root.appendChild(this._buildRow(id));
    }
  }

  /**
   * @private Build one labeled slider row for `id` in {master,sfx,music}.
   */
  _buildRow(id) {
    const row = document.createElement("div");
    row.className = "row";

    const label = document.createElement("label");
    label.textContent = LABELS[id];
    label.htmlFor = id;

    const input = document.createElement("input");
    input.type = "range";
    input.id = id;
    input.min = "0";
    input.max = "1";
    input.step = "0.01";
    input.value = String(this._volumes[id]);
    input.addEventListener("input", () => {
      this._onInput(id, input.value);
    });

    const value = document.createElement("span");
    value.className = "value";
    value.textContent = formatPercent(this._volumes[id]);

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(value);

    this._inputs[id] = input;
    this._values[id] = value;
    return row;
  }

  /**
   * @private Slider input handler: update state, engine, storage, readout.
   */
  _onInput(id, rawValue) {
    const v = clamp01(rawValue, this._volumes[id]);
    this._volumes[id] = v;
    this._values[id].textContent = formatPercent(v);
    this._applyToEngine(id, v);
    saveVolumes(this._volumes);
  }

  /**
   * @private Call the engine setter for `id` if an engine is assigned.
   */
  _applyToEngine(id, v) {
    const engine = this._engine;
    if (!engine) return;
    const method = ENGINE_SETTERS[id];
    if (typeof engine[method] === "function") {
      try {
        engine[method](v);
      } catch (_e) {
        // Engine not ready (e.g. no ctx yet) — non-fatal.
      }
    }
  }

  /**
   * The AudioEngine this panel controls. Assigning re-applies the persisted
   * volumes to the engine and (re)wires the sliders. Assign null to detach.
   */
  get engine() {
    return this._engine;
  }

  set engine(engine) {
    this._engine = engine || null;
    if (!this._engine) return;
    // Re-apply persisted values so the engine matches the UI.
    for (const id of Object.keys(DEFAULTS)) {
      const v = this._volumes[id];
      this._inputs[id].value = String(v);
      this._values[id].textContent = formatPercent(v);
      this._applyToEngine(id, v);
    }
  }

  /** Current volumes as a plain object (copy). */
  get volumes() {
    return { ...this._volumes };
  }
}

/** Format 0..1 as a percent readout, e.g. 0.35 -> "35%". */
function formatPercent(v) {
  return Math.round(clamp01(v, 0) * 100) + "%";
}

// Define the element, guarded against double-definition (e.g. the module
// being imported from two different URLs, or hot reload).
if (
  typeof customElements !== "undefined" &&
  !customElements.get("volume-settings")
) {
  customElements.define("volume-settings", VolumeSettings);
}

export default VolumeSettings;
