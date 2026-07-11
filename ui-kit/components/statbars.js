/**
 * Loomfall UI Kit — <lf-statbars>
 *
 * HUD stat rows: health (vitality shards, kite shape), armor (loom-shield),
 * hunger (meal drumstick). Every stat has a DISTINCT pip silhouette, so the
 * rows never rely on hue alone; low-health adds a fray-knot warning triangle
 * (shape) on top of the pulse (motion) and color.
 *
 * Usage:
 *   <lf-statbars health="14" armor="8" hunger="16"></lf-statbars>
 *   <lf-statbars health="4" damaged></lf-statbars>
 *
 * Each pip = 2 points (10 pips at max 20); odd values render a half pip
 * (left-half fill — a positional cue, not a color change).
 *
 * @attr {number} health - Current health, 0..health-max (default 20).
 * @attr {number} health-max - Max health (default 20).
 * @attr {number} armor - Armor points; the armor row renders ONLY when > 0
 *   (spec 5: armor row is conditional).
 * @attr {number} armor-max - Max armor (default 20).
 * @attr {number} hunger - Current hunger, 0..hunger-max (default 20).
 * @attr {number} hunger-max - Max hunger (default 20).
 * @attr {boolean} damaged - Damage-flash state: brief jitter + brighten on
 *   the health row (animation-driven; honors prefers-reduced-motion).
 *   Cleared automatically after the flash when set via damage().
 * @attr {boolean} low - Low-health warning (auto-reflected when
 *   health/health-max <= 0.3): pulsing shards + fray-knot triangle glyph.
 *
 * Accessibility: pips are aria-hidden; a role="status" container carries
 * .lf-visually-hidden text ("Health 14 of 20. Armor 8 of 20. Hunger 16 of
 * 20.") updated on every change.
 *
 * @fires (none) - Display-only component.
 */
import { LFElement, define, clamp } from '../lf-core.js';

/** Distinct silhouettes per stat (viewBox 0 0 16 16, currentColor). */
const SHAPES = {
  health:
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<path d="M8 1 L13.2 6.2 L8 15 L2.8 6.2 Z"/></svg>',
  armor:
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<path d="M8 1 L14 3.6 V8 C14 11.8 11.4 14.4 8 15.4 C4.6 14.4 2 11.8 2 8 V3.6 Z"/></svg>',
  hunger:
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<path d="M10.2 1.6 a4.4 4.4 0 0 1 0 8.8 l-1.6 -0.2 -3.4 3.4 a1.6 1.6 0 1 1 -2.2 -2.2 l3.4 -3.4 -0.2 -1.6 a4.4 4.4 0 0 1 4 -4.8 z"/></svg>',
};

/** Fray-knot warning triangle (low-health shape cue). */
const FRAY_KNOT =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M8 2 L15 14 H1 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
  '<path d="M8 6 V10 M8 11.6 V12.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
  '<path d="M1.4 14.6 L0.2 15.8 M14.6 14.6 L15.8 15.8" stroke="currentColor" stroke-width="1"/>' +
  '</svg>';

const LOW_FRACTION = 0.3;
const FLASH_MS = 650;

/** @param {string} stat @returns {HTMLElement} one pip (base + fill layers) */
function makePip(stat) {
  const pip = document.createElement('span');
  pip.className = 'lf-statbars__pip';
  pip.dataset.fill = 'empty';
  const base = document.createElement('span');
  base.className = 'lf-statbars__pip-base';
  base.innerHTML = SHAPES[stat];
  const fill = document.createElement('span');
  fill.className = 'lf-statbars__pip-fill';
  fill.innerHTML = SHAPES[stat];
  pip.append(base, fill);
  return pip;
}

export class LFStatbars extends LFElement {
  static observedAttributes = [
    'health', 'health-max', 'armor', 'armor-max',
    'hunger', 'hunger-max', 'damaged',
  ];

  render() {
    const rows = document.createElement('div');
    rows.className = 'lf-statbars__rows';
    rows.setAttribute('aria-hidden', 'true');

    this._rows = {};
    this._pips = {};
    for (const stat of ['health', 'armor', 'hunger']) {
      const row = document.createElement('div');
      row.className = `lf-statbars__row lf-statbars__row--${stat}`;
      const pips = document.createElement('div');
      pips.className = 'lf-statbars__pips';
      row.appendChild(pips);
      if (stat === 'health') {
        const warn = document.createElement('span');
        warn.className = 'lf-statbars__warn';
        warn.innerHTML = FRAY_KNOT;
        row.appendChild(warn);
        this._warn = warn;
      }
      rows.appendChild(row);
      this._rows[stat] = row;
      this._pips[stat] = pips;
    }

    // Spoken summary: single polite status region.
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    const sr = document.createElement('span');
    sr.className = 'lf-visually-hidden';
    status.appendChild(sr);

    this.append(rows, status);
    this._sr = sr;
    this._flashTimer = 0;
  }

  update() {
    const health = this._num('health', 20);
    const healthMax = this._num('health-max', 20);
    const armor = this._num('armor', 0);
    const armorMax = this._num('armor-max', 20);
    const hunger = this._num('hunger', 20);
    const hungerMax = this._num('hunger-max', 20);

    this._fillRow('health', health, healthMax);
    this._fillRow('hunger', hunger, hungerMax);
    // Armor row is conditional: only rendered when armorPoints > 0.
    this._rows.armor.hidden = armor <= 0;
    if (armor > 0) this._fillRow('armor', armor, armorMax);

    // Low-health warning: auto-reflected attribute (pulse + triangle glyph).
    const low = healthMax > 0 && health / healthMax <= LOW_FRACTION;
    this.reflectBool('low', low);
    this._warn.hidden = !low;

    const parts = [`Health ${clamp(health, 0, healthMax)} of ${healthMax}.`];
    if (armor > 0) parts.push(`Armor ${clamp(armor, 0, armorMax)} of ${armorMax}.`);
    parts.push(`Hunger ${clamp(hunger, 0, hungerMax)} of ${hungerMax}.`);
    if (low) parts.push('Health critical.');
    const text = parts.join(' ');
    if (this._sr.textContent !== text) this._sr.textContent = text;
  }

  /**
   * Apply damage: set the new health value and run the damage flash
   * (jitter + brighten), clearing [damaged] afterwards.
   * @param {number} newHealth
   */
  damage(newHealth) {
    this.setAttribute('health', String(newHealth));
    this.removeAttribute('damaged'); // restart animation
    // Force reflow so re-adding the attribute retriggers the CSS animation.
    void this._rows.health.offsetWidth;
    this.setAttribute('damaged', '');
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => this.removeAttribute('damaged'), FLASH_MS);
  }

  /** @param {string} attr @param {number} dflt @returns {number} */
  _num(attr, dflt) {
    const v = parseInt(this.getAttribute(attr) || '', 10);
    return Number.isFinite(v) ? v : dflt;
  }

  /**
   * Render value/max as full/half/empty pips (1 pip = 2 points).
   * @param {string} stat @param {number} value @param {number} max
   */
  _fillRow(stat, value, max) {
    const pipsWanted = Math.max(1, Math.ceil(max / 2));
    const holder = this._pips[stat];
    while (holder.children.length < pipsWanted) holder.appendChild(makePip(stat));
    while (holder.children.length > pipsWanted) holder.lastChild.remove();
    const v = clamp(value, 0, max);
    for (let i = 0; i < pipsWanted; i++) {
      const pts = clamp(v - i * 2, 0, 2);
      holder.children[i].dataset.fill = pts === 2 ? 'full' : pts === 1 ? 'half' : 'empty';
    }
  }

  /** @type {number} */
  get health() {
    return this._num('health', 20);
  }
  set health(v) {
    this.setAttribute('health', String(v));
  }

  /** @type {number} */
  get armor() {
    return this._num('armor', 0);
  }
  set armor(v) {
    this.setAttribute('armor', String(v));
  }

  /** @type {number} */
  get hunger() {
    return this._num('hunger', 20);
  }
  set hunger(v) {
    this.setAttribute('hunger', String(v));
  }
}

define('lf-statbars', LFStatbars);
