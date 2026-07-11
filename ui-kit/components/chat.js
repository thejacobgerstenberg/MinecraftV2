/**
 * Loomfall UI Kit — <lf-chat>
 *
 * Chat panel: scrollback message log (role="log", polite live region) +
 * input row shown while [open]. System lines are distinguished by THREE
 * cues: knot glyph, italic style, and info color — never hue alone.
 *
 * Usage (initial messages are authored as light-DOM <p> children):
 *   <lf-chat open>
 *     <p data-name="Sona" data-time="12:04">Found a loom shrine!</p>
 *     <p data-system data-time="12:05">Ren joined the world</p>
 *   </lf-chat>
 *
 * @attr {boolean} open - Input row visible (chat "opened" with T/Slash in
 *   game). The log itself always renders; closed chat is read-only.
 * @attr {number} scrollback - Max retained lines (default 50; older lines
 *   are dropped from the DOM).
 * @attr {boolean} no-timestamps - Hide the HH:MM column (timestamps render
 *   by default).
 *
 * @fires lf-send - Enter with non-empty input. detail: { text: string }.
 *   The kit does NOT locally echo — the game decides what lands in the log.
 * @fires lf-open - After open() reflects [open].
 * @fires lf-close - Esc with the input NOT focused (cancelable; if not
 *   prevented, [open] is removed). Esc while typing only BLURS the input
 *   (text-entry context pops before any screen — UX_SPEC 7.1).
 *
 * API: open(), close(), isOpen(), addMessage({ name, text, system, time }).
 */
import { LFElement, define, uid } from '../lf-core.js';

/** Small knot glyph marking system lines (shape cue). */
const KNOT =
  '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">' +
  '<path d="M6 1.5 A 3.2 3.2 0 1 1 2.9 5.6 M6 10.5 A 3.2 3.2 0 1 1 9.1 6.4" ' +
  'stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';

const DEFAULT_SCROLLBACK = 50;
const MAX_LEN = 256;

/** @returns {string} current wall-clock HH:MM */
function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export class LFChat extends LFElement {
  static observedAttributes = ['open', 'no-timestamps'];

  render() {
    // Adopt authored <p data-name/data-time/data-system> children as lines.
    const seed = Array.from(this.querySelectorAll(':scope > p')).map((p) => ({
      name: p.dataset.name || null,
      text: p.textContent.trim(),
      system: p.hasAttribute('data-system'),
      time: p.dataset.time || null,
    }));
    this.textContent = '';

    const log = document.createElement('div');
    log.className = 'lf-chat__log lf-scroll-y';
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    log.setAttribute('aria-label', 'Chat messages');

    const row = document.createElement('form');
    row.className = 'lf-chat__row';

    const prompt = document.createElement('span');
    prompt.className = 'lf-chat__prompt';
    prompt.setAttribute('aria-hidden', 'true');
    prompt.textContent = '>';

    const inputId = uid('lf-chat');
    const label = document.createElement('label');
    label.className = 'lf-visually-hidden';
    label.htmlFor = inputId;
    label.textContent = 'Chat message';

    const input = document.createElement('input');
    input.className = 'lf-chat__input';
    input.id = inputId;
    input.type = 'text';
    input.maxLength = MAX_LEN;
    input.autocomplete = 'off';
    input.spellcheck = false;

    row.append(prompt, label, input);
    this.append(log, row);
    this._log = log;
    this._input = input;

    row.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      this.emit('lf-send', { text });
      input.value = '';
    });

    // Esc in text-entry context blurs FIRST; a second Esc (input unfocused)
    // asks to close. Screen-stack handling stays one level per press.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        input.blur();
      }
    });
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) this.close();
    });

    for (const msg of seed) this.addMessage(msg);
  }

  update() {
    this.reflectBool('no-timestamps', this.boolAttr('no-timestamps'));
  }

  /**
   * Append a chat line and trim scrollback.
   * @param {{ name?: string|null, text: string, system?: boolean,
   *           time?: string|null }} msg - time defaults to now (HH:MM).
   * @returns {HTMLElement} the line element.
   */
  addMessage(msg) {
    const line = document.createElement('div');
    line.className = 'lf-chat__line';
    if (msg.system) line.setAttribute('data-system', '');

    const time = document.createElement('span');
    time.className = 'lf-chat__time';
    time.textContent = msg.time || nowHHMM();
    line.appendChild(time);

    if (msg.system) {
      const glyph = document.createElement('span');
      glyph.className = 'lf-chat__glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = KNOT;
      line.appendChild(glyph);
    } else if (msg.name) {
      const name = document.createElement('span');
      name.className = 'lf-chat__name';
      name.textContent = `<${msg.name}>`;
      line.appendChild(name);
    }

    const text = document.createElement('span');
    text.className = 'lf-chat__text';
    text.textContent = msg.text;
    line.appendChild(text);

    this._log.appendChild(line);
    const max = this.scrollback;
    while (this._log.children.length > max) this._log.firstChild.remove();
    this._log.scrollTop = this._log.scrollHeight;
    return line;
  }

  /** Open the input row (and focus it). Emits lf-open. */
  open() {
    if (this.isOpen()) return;
    this.reflectBool('open', true);
    this.emit('lf-open');
    this._input.focus();
  }

  /** Ask to close (cancelable lf-close); removes [open] if not prevented. */
  close() {
    if (!this.isOpen()) return;
    if (this.emit('lf-close', {}, { cancelable: true })) {
      this.reflectBool('open', false);
    }
  }

  /** @returns {boolean} */
  isOpen() {
    return this.boolAttr('open');
  }

  /** @type {number} max retained lines. */
  get scrollback() {
    const v = parseInt(this.getAttribute('scrollback') || '', 10);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_SCROLLBACK;
  }
  set scrollback(v) {
    this.setAttribute('scrollback', String(v));
  }
}

define('lf-chat', LFChat);
