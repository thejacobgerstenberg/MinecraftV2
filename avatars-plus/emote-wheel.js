// avatars-plus/emote-wheel.js
// Radial <lf-emote-wheel> — a ring menu of the 8 EMOTES; select emits "lf-emote".

import { LFElement, RovingTabindex, define } from "./vendor/ui-kit/lf-core.js";
import { EMOTES } from "./emotes.js";

/**
 * One-time injection of the component stylesheet. Colors come exclusively
 * from --lf-* tokens (never raw hex); selection/hover/focus are signalled by
 * SHAPE + POSITION + TEXT (scale, ring border, wedge marker, always-visible
 * label) in addition to the brand-gold hue, so the widget is never hue-only.
 */
const STYLE_ID = "lf-emote-wheel-style";
function injectStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
lf-emote-wheel {
  position: fixed;
  left: 50%;
  top: 50%;
  z-index: var(--lf-z-hud);
  display: none;
  transform: translate(-50%, -50%);
  font-family: var(--lf-font-ui);
  pointer-events: none;
}
lf-emote-wheel[open] { display: block; }

lf-emote-wheel .lf-ew__ring {
  position: relative;
  width: 300px;
  height: 300px;
  border-radius: var(--lf-radius-pill);
  background: var(--lf-color-bg-panel);
  border: var(--lf-border-width) solid var(--lf-color-border-hem);
  box-shadow: 0 0 0 4px var(--lf-color-screen-dim);
  pointer-events: auto;
}

lf-emote-wheel .lf-ew__hub {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 120px;
  height: 120px;
  transform: translate(-50%, -50%);
  border-radius: var(--lf-radius-pill);
  background: var(--lf-color-bg-root);
  border: var(--lf-border-width) solid var(--lf-color-border-hem);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--lf-space-1);
  text-align: center;
  padding: var(--lf-space-2);
  box-sizing: border-box;
  pointer-events: none;
}
lf-emote-wheel .lf-ew__hub-icon { font-size: var(--lf-text-2xl); line-height: 1; }
lf-emote-wheel .lf-ew__hub-label {
  font-size: var(--lf-text-sm);
  color: var(--lf-color-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
lf-emote-wheel .lf-ew__hub-hint {
  font-size: var(--lf-text-xs);
  color: var(--lf-color-text-disabled);
}

lf-emote-wheel .lf-ew__slot {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 72px;
  height: 72px;
  margin: 0;
  padding: var(--lf-space-1);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  cursor: pointer;
  border-radius: var(--lf-radius-md);
  background: var(--lf-color-bg-raised);
  border: var(--lf-border-width) solid var(--lf-color-border-hem);
  color: var(--lf-color-text-body);
  transition: border-color var(--lf-dur-fast) var(--lf-ease),
              background var(--lf-dur-fast) var(--lf-ease);
}
lf-emote-wheel .lf-ew__slot-icon { font-size: var(--lf-text-xl); line-height: 1; }
lf-emote-wheel .lf-ew__slot-label {
  font-size: var(--lf-text-xs);
  line-height: 1;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Hover / focus / roving-active: gold ring border + wedge marker (shape/pos
   cues), never colour alone. */
lf-emote-wheel .lf-ew__slot:hover,
lf-emote-wheel .lf-ew__slot:focus-visible,
lf-emote-wheel .lf-ew__slot[data-active] {
  border-color: var(--lf-brand-primary);
  background: var(--lf-color-bg-panel);
  color: var(--lf-color-text-heading);
}
lf-emote-wheel .lf-ew__slot:hover::after,
lf-emote-wheel .lf-ew__slot:focus-visible::after,
lf-emote-wheel .lf-ew__slot[data-active]::after {
  content: "";
  position: absolute;
  top: -7px;
  left: 50%;
  width: 8px;
  height: 8px;
  transform: translateX(-50%) rotate(45deg);
  background: var(--lf-brand-primary);
  border-radius: var(--lf-radius-sm);
}
lf-emote-wheel .lf-ew__slot:focus-visible {
  outline: var(--lf-focus-ring);
  outline-offset: var(--lf-focus-ring-offset);
}
`;
  (document.head || document.documentElement).appendChild(style);
}

/**
 * <lf-emote-wheel> — a radial emote picker.
 *
 * Renders the ordered EMOTES registry as slots arranged in a ring (each slot
 * shows the emote icon + label). Keyboard navigation via RovingTabindex
 * (horizontal, wrapping); Enter/Space or click selects; Esc closes. Selecting
 * a slot fires a bubbling "lf-emote" CustomEvent whose detail is `{ id }` and
 * closes the wheel.
 *
 * The `open` state is a reflected boolean ATTRIBUTE (`<lf-emote-wheel open>`);
 * imperative control is via the open()/close()/toggle() methods.
 *
 * @attr {boolean} open - Reflected. Presence shows the ring; absence hides it.
 * @fires lf-emote - detail `{ id: string }` — the chosen emote id. Bubbles.
 */
export class LFEmoteWheel extends LFElement {
  static observedAttributes = ["open"];

  /**
   * @returns {boolean} whether the wheel is currently shown.
   * @private
   */
  _isOpen() {
    return this.hasAttribute("open");
  }

  /** Build the ring and its slots (once). @returns {void} */
  render() {
    injectStyle();

    const ring = document.createElement("div");
    ring.className = "lf-ew__ring";
    ring.setAttribute("role", "menu");
    ring.setAttribute("aria-label", "Emotes");

    const hub = document.createElement("div");
    hub.className = "lf-ew__hub";
    hub.setAttribute("aria-hidden", "true");
    const hubIcon = document.createElement("div");
    hubIcon.className = "lf-ew__hub-icon";
    const hubLabel = document.createElement("div");
    hubLabel.className = "lf-ew__hub-label";
    const hubHint = document.createElement("div");
    hubHint.className = "lf-ew__hub-hint";
    hubHint.textContent = "Enter to play";
    hub.append(hubIcon, hubLabel, hubHint);
    this._hubIcon = hubIcon;
    this._hubLabel = hubLabel;

    /** @type {Array<{id:string,label:string,icon:string}>} */
    const list = Array.isArray(EMOTES) ? EMOTES : [];
    this._emotes = list;
    const n = list.length;
    const radiusPx = 96; // ring placement radius for slot centers

    /** @type {HTMLElement[]} */
    this._slots = list.map((emote, i) => {
      const id = emote && emote.id != null ? String(emote.id) : `emote-${i}`;
      const label = emote && emote.label != null ? String(emote.label) : id;
      const icon = emote && emote.icon != null ? String(emote.icon) : "•";

      const slot = document.createElement("button");
      slot.type = "button";
      slot.className = "lf-ew__slot";
      slot.setAttribute("role", "menuitem");
      slot.dataset.index = String(i);
      slot.dataset.emoteId = id;
      slot.setAttribute("aria-label", label);
      slot.setAttribute("tabindex", "-1");

      // Place the slot on the ring, keeping its contents upright by
      // counter-rotating. Angle 0 = top, going clockwise.
      const a = n > 0 ? -90 + (i * 360) / n : -90;
      slot.style.transform =
        `translate(-50%, -50%) rotate(${a}deg) ` +
        `translateY(-${radiusPx}px) rotate(${-a}deg)`;

      const ic = document.createElement("span");
      ic.className = "lf-ew__slot-icon";
      ic.setAttribute("aria-hidden", "true");
      ic.textContent = icon;
      const lb = document.createElement("span");
      lb.className = "lf-ew__slot-label";
      lb.textContent = label;
      slot.append(ic, lb);

      slot.addEventListener("click", () => this._select(i));
      slot.addEventListener("pointerenter", () => this._focusIndex(i));

      ring.appendChild(slot);
      return slot;
    });

    ring.appendChild(hub);
    this.appendChild(ring);
    this._ring = ring;

    this._rove = new RovingTabindex(ring, {
      selector: ".lf-ew__slot",
      orientation: "horizontal",
      wrap: true,
      onActivate: (_item, index) => this._select(index),
      onFocusChange: (_item, index) => this._reflectActive(index),
    });

    // Esc closes. Arrows/Enter/Space are handled by RovingTabindex.
    this._onKeydown = (e) => {
      if (e.key === "Escape" || e.key === "Esc") {
        e.preventDefault();
        this.close();
      }
    };
    this.addEventListener("keydown", this._onKeydown);

    // Press-and-hold from an external opener, then release over a slot.
    this._onDocPointerUp = (e) => {
      if (!this._isOpen()) return;
      const el =
        typeof document !== "undefined" && document.elementFromPoint
          ? document.elementFromPoint(e.clientX, e.clientY)
          : null;
      const slot = el && el.closest ? el.closest(".lf-ew__slot") : null;
      if (slot && this.contains(slot)) {
        const idx = parseInt(slot.dataset.index || "-1", 10);
        if (idx >= 0) this._select(idx);
      }
    };

    this._reflectActive(0);
    this._wasOpen = false;
  }

  /** Sync visibility + a11y + focus with the reflected `open` attribute. */
  update() {
    const isOpen = this._isOpen();
    this.setAttribute("aria-hidden", isOpen ? "false" : "true");
    if (this._ring) this._ring.setAttribute("aria-hidden", isOpen ? "false" : "true");

    if (isOpen && !this._wasOpen) {
      // Opening: listen for hold-release and move focus onto the ring.
      if (typeof document !== "undefined") {
        document.addEventListener("pointerup", this._onDocPointerUp);
      }
      if (this._rove && this._slots && this._slots.length) {
        this._rove.setActive(0, { focus: true });
      }
    } else if (!isOpen && this._wasOpen) {
      // Closing: drop the hold-release listener.
      if (typeof document !== "undefined") {
        document.removeEventListener("pointerup", this._onDocPointerUp);
      }
    }
    this._wasOpen = isOpen;
  }

  /**
   * Move roving focus (and the hub readout) to a slot without selecting.
   * @param {number} index
   */
  _focusIndex(index) {
    if (!this._rove || !this._isOpen()) return;
    const items = this._rove.items();
    const idx = items.indexOf(this._slots[index]);
    if (idx !== -1) this._rove.setActive(idx, { focus: true });
  }

  /**
   * Mark one slot as the active/highlighted one (shape cue) and update the
   * center hub readout. Never throws on out-of-range input.
   * @param {number} index
   */
  _reflectActive(index) {
    if (!this._slots) return;
    for (let i = 0; i < this._slots.length; i += 1) {
      if (i === index) this._slots[i].setAttribute("data-active", "");
      else this._slots[i].removeAttribute("data-active");
    }
    const e = this._emotes && this._emotes[index];
    if (this._hubIcon) this._hubIcon.textContent = e && e.icon != null ? String(e.icon) : "";
    if (this._hubLabel) this._hubLabel.textContent = e && e.label != null ? String(e.label) : "";
  }

  /**
   * Commit a selection: emit `lf-emote` with the emote id and close. No-ops if
   * the wheel is already closed (guards double-fire from click + pointerup).
   * @param {number} index
   */
  _select(index) {
    if (!this._isOpen()) return;
    const emote = this._emotes && this._emotes[index];
    if (!emote) return;
    const id = emote.id != null ? String(emote.id) : null;
    if (!id) return;
    this.close();
    this.emit("lf-emote", { id });
  }

  /**
   * Show the wheel; roving focus lands on the first slot.
   * @returns {void}
   */
  open() {
    this.setAttribute("open", "");
  }

  /** Close the wheel (no selection). @returns {void} */
  close() {
    this.removeAttribute("open");
  }

  /** Toggle open/closed. @returns {void} */
  toggle() {
    if (this._isOpen()) this.close();
    else this.open();
  }

  disconnectedCallback() {
    if (this._rove) this._rove.destroy();
    if (this._onKeydown) this.removeEventListener("keydown", this._onKeydown);
    if (typeof document !== "undefined" && this._onDocPointerUp) {
      document.removeEventListener("pointerup", this._onDocPointerUp);
    }
  }
}

define("lf-emote-wheel", LFEmoteWheel);
