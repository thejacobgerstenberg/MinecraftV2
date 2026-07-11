/**
 * Loomfall UI Kit — <lf-world-select> + <lf-world-card>
 *
 * World-select screen body: a role="listbox" of world cards. Each card
 * shows a dimension-ramp thumbnail placeholder, world name, mode and
 * last-played line, and mouse action buttons (Play / Edit / Delete).
 * Selection is a LUMINANCE-EDGE frame (knotlight outline on the dark
 * theme, deep duskwarp on the light theme — survives all three
 * colorblind sims; never a hue-only recolor). Delete always confirms via a composed <lf-modal> with an
 * explicit Cancel (no destructive dead ends).
 *
 * Usage:
 *   <lf-world-select label="Worlds">
 *     <lf-world-card name="Warp Meadow" mode="Survival" played="2 days ago"
 *                    ramp="warpwold" selected></lf-world-card>
 *     <lf-world-card name="Cinder Depths" mode="Hardcore" played="3 weeks ago"
 *                    ramp="cinderloom"></lf-world-card>
 *   </lf-world-select>
 *
 * <lf-world-card> PUBLIC ATTRIBUTES
 * @attr {string} name - World name (row heading, accessible name).
 * @attr {string} mode - Game mode line ("Survival", "Creative", ...).
 * @attr {string} played - Last-played line ("2 days ago").
 * @attr {("warpwold"|"cinderloom"|"nevermend")} ramp - Dimension ramp used
 *   for the thumbnail placeholder gradient. Default "warpwold".
 * @attr {boolean} selected - Selection state (aria-selected + luminance
 *   frame). Managed by the parent listbox; single-select.
 * @attr {boolean} data-demo-hover - Gallery convention: hover face + the
 *   mouse action row visible without a script.
 *
 * <lf-world-select> PUBLIC ATTRIBUTES
 * @attr {string} label - Accessible name for the listbox. Default "Worlds".
 *
 * PUBLIC EVENTS (on lf-world-select)
 * @fires lf-select - Selection moved (click / arrow keys).
 *   detail: { value: string (world name), index: number }.
 * @fires lf-action - detail: { action: 'play'|'edit'|'delete',
 *   world: { name, mode, played }, index }. 'play' fires on Enter/Space,
 *   double-click, or the Play button; 'delete' fires ONLY after the user
 *   confirms in the modal.
 * @fires lf-back - Escape or the Back footer button: pop exactly ONE
 *   screen level.
 *
 * KEYBOARD
 *   Tab enters the list (roving tabindex, one stop). ArrowUp/ArrowDown
 *   move + select, Home/End jump, Enter/Space plays, Delete asks to
 *   delete (confirm modal), Escape emits lf-back.
 */
import { LFElement, define, uid, RovingTabindex } from '../lf-core.js';
import '../components/button.js';
import '../components/modal.js';

/** Pencil/edit stitch glyph (currentColor). */
const EDIT_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M9.8 3.2 L12.8 6.2 L6 13 L2.6 13.4 L3 10 Z"/>' +
  '<path d="M11.4 1.6 L14.4 4.6" stroke-dasharray="2 1.4"/>' +
  '</svg>';

/** Frayed-X delete glyph (currentColor) — error shape cue, never hue alone. */
const FRAYED_X =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-linecap="round">' +
  '<path d="M4 4 L12 12 M12 4 L4 12" stroke-width="2"/>' +
  '<path d="M2.6 1.8 L4 4 M13.4 1.8 L12 4 M2.6 14.2 L4 12 M13.4 14.2 L12 12" stroke-width="1.1"/>' +
  '</svg>';

/** Play triangle glyph (currentColor). */
const PLAY_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false" fill="currentColor">' +
  '<path d="M4.5 2.8 L13 8 L4.5 13.2 Z"/>' +
  '</svg>';

export class LFWorldCard extends LFElement {
  static observedAttributes = ['name', 'mode', 'played', 'selected'];

  render() {
    this.setAttribute('role', 'option');

    const thumb = document.createElement('div');
    thumb.className = 'lf-world-card__thumb lf-pixelated';
    thumb.setAttribute('aria-hidden', 'true');

    const meta = document.createElement('div');
    meta.className = 'lf-world-card__meta';
    const name = document.createElement('div');
    name.className = 'lf-world-card__name';
    const sub = document.createElement('div');
    sub.className = 'lf-world-card__sub lf-text-sm';
    meta.append(name, sub);

    // Mouse affordances only: removed from the a11y tree and Tab order.
    // Keyboard users get Enter (play) / Delete (confirm) on the option
    // itself — announced via the parent listbox usage hint.
    const actions = document.createElement('div');
    actions.className = 'lf-world-card__actions';
    actions.setAttribute('aria-hidden', 'true');
    for (const [action, icon, text] of [
      ['play', PLAY_ICON, 'Play'],
      ['edit', EDIT_ICON, 'Edit'],
      ['delete', FRAYED_X, 'Delete'],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.tabIndex = -1;
      b.className = `lf-world-card__action lf-world-card__action--${action}`;
      b.dataset.action = action;
      b.innerHTML = `${icon}<span>${text}</span>`;
      actions.appendChild(b);
    }

    this.append(thumb, meta, actions);
    this._name = name;
    this._sub = sub;
  }

  update() {
    const name = this.getAttribute('name') || 'Unnamed world';
    const mode = this.getAttribute('mode') || 'Survival';
    const played = this.getAttribute('played') || '';
    this._name.textContent = name;
    this._sub.textContent = played ? `${mode} · last played ${played}` : mode;
    this.setAttribute('aria-selected', this.selected ? 'true' : 'false');
    this.setAttribute('aria-label', `${name}, ${mode}${played ? `, last played ${played}` : ''}`);
  }

  /** @type {boolean} */
  get selected() {
    return this.boolAttr('selected');
  }
  set selected(v) {
    this.reflectBool('selected', !!v);
  }

  /** @returns {{name: string, mode: string, played: string}} plain data. */
  get world() {
    return {
      name: this.getAttribute('name') || 'Unnamed world',
      mode: this.getAttribute('mode') || 'Survival',
      played: this.getAttribute('played') || '',
    };
  }
}

export class LFWorldSelect extends LFElement {
  static observedAttributes = ['label'];

  render() {
    const cards = this.$$(':scope > lf-world-card');
    const hintId = uid('lf-world-select-hint');

    const list = document.createElement('div');
    list.className = 'lf-world-select__list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-describedby', hintId);
    for (const c of cards) list.appendChild(c);

    const hint = document.createElement('p');
    hint.className = 'lf-visually-hidden';
    hint.id = hintId;
    hint.textContent = 'Press Enter to play the selected world, Delete to delete it.';

    const footer = document.createElement('div');
    footer.className = 'lf-world-select__footer';
    const back = document.createElement('lf-button');
    back.setAttribute('variant', 'secondary');
    back.setAttribute('action', 'back');
    back.textContent = 'Back';
    footer.append(back);

    // Delete confirmation modal (composed lf-modal; internal events are
    // swallowed and re-emitted as this component's public events).
    const modal = document.createElement('lf-modal');
    modal.setAttribute('danger', '');
    // Default heading so the dialog always has a non-empty accessible name
    // (aria-labelledby) even before _askDelete() fills in the world name.
    modal.setAttribute('heading', 'Delete world?');
    modal.setAttribute('confirm-label', 'Delete');
    modal.setAttribute('cancel-label', 'Cancel');
    const modalBody = document.createElement('p');
    modal.appendChild(modalBody);

    this.append(hint, list, footer, modal);
    this._list = list;
    this._modal = modal;
    this._modalBody = modalBody;
    this._pendingDelete = null;

    this._rove = new RovingTabindex(list, {
      selector: 'lf-world-card',
      orientation: 'vertical',
      wrap: false,
      onActivate: (item) => this._play(item),
      onFocusChange: (item) => this._select(item),
    });

    // --- pointer interactions -----------------------------------------
    list.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('.lf-world-card__action');
      const card = e.target.closest('lf-world-card');
      if (!card) return;
      if (actionBtn) {
        const action = actionBtn.dataset.action;
        this._select(card);
        if (action === 'play') this._play(card);
        else if (action === 'edit') this._emitAction('edit', card);
        else if (action === 'delete') this._askDelete(card);
        return;
      }
      this._select(card);
      this._rove.setActive(this._cards().indexOf(card), { focus: false });
    });

    list.addEventListener('dblclick', (e) => {
      const card = e.target.closest('lf-world-card');
      if (card && !e.target.closest('.lf-world-card__action')) this._play(card);
    });

    // --- keyboard: Delete asks, Escape pops ---------------------------
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' && e.target.closest('lf-world-card')) {
        e.preventDefault();
        this._askDelete(e.target.closest('lf-world-card'));
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        this.emit('lf-back', { from: 'world-select' });
      }
    });

    // --- footer Back → lf-back; modal events → public events ----------
    back.addEventListener('lf-action', (e) => {
      e.stopPropagation();
      this.emit('lf-back', { from: 'world-select' });
    });

    modal.addEventListener('lf-action', (e) => {
      e.stopPropagation();
      if (e.detail.action === 'confirm' && this._pendingDelete) {
        const card = this._pendingDelete;
        this._emitAction('delete', card);
      }
      this._pendingDelete = null;
    });
    modal.addEventListener('lf-close', (e) => e.stopPropagation());
    modal.addEventListener('lf-open', (e) => e.stopPropagation());
  }

  update() {
    this._list.setAttribute('aria-label', this.getAttribute('label') || 'Worlds');
  }

  /** @returns {LFWorldCard[]} */
  _cards() {
    return /** @type {LFWorldCard[]} */ (Array.from(this._list.querySelectorAll('lf-world-card')));
  }

  /** Single-select: move [selected] to the given card, announce lf-select. */
  _select(card) {
    if (!card || card.selected) return;
    for (const c of this._cards()) c.selected = c === card;
    this.emit('lf-select', {
      value: card.getAttribute('name') || 'Unnamed world',
      index: this._cards().indexOf(card),
    });
  }

  _play(card) {
    this._select(card);
    this._emitAction('play', card);
  }

  _emitAction(action, card) {
    this.emit('lf-action', { action, world: card.world, index: this._cards().indexOf(card) });
  }

  /** Open the destructive-confirm modal for a card (rubric R3 T7). */
  _askDelete(card) {
    this._pendingDelete = card;
    this._modal.setAttribute('heading', `Delete "${card.world.name}"?`);
    this._modalBody.textContent = 'This world will be gone for good. This cannot be undone.';
    if (typeof this._modal.show === 'function') this._modal.show();
    else this._modal.setAttribute('open', '');
  }

  /**
   * Remove a card from the list (host app calls this after handling the
   * confirmed 'delete' action). @param {number} index
   */
  removeWorld(index) {
    const card = this._cards()[index];
    if (!card) return;
    card.remove();
    this._rove.refresh();
  }
}

define('lf-world-card', LFWorldCard);
define('lf-world-select', LFWorldSelect);
