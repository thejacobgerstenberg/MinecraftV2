/**
 * Loomfall UI Integrate — HudKit facade
 * =========================================================================
 * A thin, defensive adapter that lets the builder adopt the lf-* ui-kit +
 * brand palette onto its REAL HUD/menu with minimal, per-widget, revertible
 * churn. Nothing here imports from three; it only touches the DOM and the
 * builder's `ui.*` init objects.
 *
 * TWO TIERS
 * -------------------------------------------------------------------------
 *   TIER 1 — palette (applyTheme):  the cheapest, highest-value, fully
 *     revertible step. It injects ui-kit/tokens.css + base.css and the
 *     brand-theme.css overlay, which remaps the builder's bespoke :root
 *     vars onto the lf brand tokens. Every existing widget re-skins with
 *     ZERO markup change and the R1 contrast issues are fixed. This is the
 *     RECOMMENDED FIRST STEP — call applyTheme() (or adoptAll()) and stop
 *     there if you only want the palette/contrast lift.
 *
 *   TIER 2 — per-widget lf-* component adoption:  each adopt<X>() swaps one
 *     builder widget for its lf-* custom element and BRIDGES the builder's
 *     init API so live updates keep flowing. Each adopt is INDEPENDENT and
 *     IDEMPOTENT and returns { revert() }; you can adopt one widget, ship,
 *     and adopt the next later. If the builder element/selector is absent,
 *     that adopt no-ops and records it — it never throws.
 *
 * BRIDGING
 *   When constructed with `ui` (the builder's boot-created ui.* object), an
 *   adopt wraps the relevant init API so calling e.g. ui.hud.setHealth(n)
 *   also updates the mounted <lf-statbars>. Without `ui`, the caller drives
 *   the lf element directly (the element is returned on the adopt handle).
 *
 * See INTEGRATION.md for the exact main.js edits (link tags + the one-line
 * `HudKit.init({ ui }).adoptAll()` call and per-widget opt-ins).
 *
 *   TIER 3 — ux-access fold (foldUxAccess):  folds the genuine ux-access
 *     package (keybinds / options / captions / onboarding) into the same
 *     facade. These four are define()-registered lf-* custom elements wired
 *     purely through WINDOW CustomEvents — HudKit never imports three or any
 *     audio engine, it only mounts the elements and links their css. The
 *     window-event buses it observes / drives:
 *       - `lf-audio-event`   {name, direction?, volume?, loop?, ended?} —
 *         <lf-captions> self-subscribes to this on connect. THE BUILDER'S
 *         GameAudio MUST DISPATCH IT per engine.play() for captions to show;
 *         HudKit.emitAudioEvent(detail) is the tiny static bridge (used by
 *         the builder + the proof). <lf-captions> has no attach() method.
 *       - `lf-game-event`    {type:'on_first_block_broken'|...} — gates the
 *         <lf-tutorial> coach-mark beats. Drive it with
 *         HudKit.emitGameEvent(type). Beats anchor via
 *         document.querySelector('[data-lf-anchor="<id>"]') — tagHudAnchors()
 *         stamps the reserved anchor vocabulary onto the managed HUD widgets.
 *       - `lf-options-change` {key,value,options} — dispatched by the
 *         OptionsStore on every commit; it also sets html[data-lf-cvd] /
 *         [data-lf-reduced-motion] / --lf-ui-scale. subtitles===false is the
 *         store's signal to unmount <lf-captions>.
 *       - `lf-bindings-change` {action,slot,code,bindings} — emitted by
 *         <lf-keybinds>; the tutorial live-substitutes [MOVE]/[BREAK]/… from it.
 *     <lf-keybinds> and <lf-access-options> DOCK into an <lf-settings-shell>
 *     as <section data-category="Controls"> / ="Accessibility"> bodies. Note
 *     the shell consumes its sections at render() time, so foldUxAccess
 *     authors them as children BEFORE the shell connects.
 *     applyTheme() also links settings-shell-fix.css — a ui-kit follow-up
 *     overlay adding the narrow-width (~390px) breakpoint the kit's
 *     settings-shell.css lacks (rail pinned flex:0 0 168px crushes dropdowns).
 *
 * @example
 *   import HudKit from './ui-integrate/integrate.js';
 *   const kit = HudKit.init({ ui, assetBase: './' });
 *   kit.applyTheme();          // Tier 1 — palette + contrast, zero churn
 *   kit.adoptCrosshair();      // Tier 2 — opt in per widget
 *   kit.foldUxAccess({ uxBase: './ux/' });  // Tier 3 — ux-access fold
 *   // ...later
 *   kit.revertAll();           // full, clean revert
 */

/* eslint-disable no-empty */

/** Run a DOM op without ever throwing; log at debug level. */
function safe(fn, label) {
  try {
    return fn();
  } catch (err) {
    try {
      // eslint-disable-next-line no-console
      console.debug('[HudKit] ' + (label || 'op') + ' skipped:', err && err.message);
    } catch (_e) {}
    return undefined;
  }
}

/** True when the value is a callable function. */
function isFn(v) {
  return typeof v === 'function';
}

export class HudKit {
  /**
   * @param {object} [opts]
   * @param {Document|DocumentFragment} [opts.root=document] Root to query.
   * @param {object} [opts.ui] The builder's boot-created ui.* object
   *   (ui.hud, ui.hotbar, ui.chat, ui.debug, ui.inventory, ui.menus).
   *   Optional — when omitted, the caller drives the lf elements directly.
   * @param {('dark'|'light')} [opts.theme='dark'] data-theme to set on <html>.
   * @param {string} [opts.assetBase='./'] Path where ui-kit/ lives, relative
   *   to the page (must end with '/'). Used for tokens/base + lf component JS/CSS.
   * @param {string} [opts.themeHref] Explicit href for brand-theme.css. Needed
   *   when brand-theme.css does NOT live under assetBase (e.g. ui-kit/ is at the
   *   repo root but brand-theme.css sits beside the page). Defaults to
   *   `${assetBase}brand-theme.css`.
   * @param {string} [opts.wordmarkHref] Explicit href for the brand wordmark
   *   SVG fetched by adoptWordmark(). Defaults to
   *   `${assetBase}vendor-game/brand/wordmark-dark.svg`.
   * @param {string} [opts.uxBase='./ux/'] Path where the ux-access package
   *   (keybinds/ options/ captions/ onboarding/) lives in the game tree,
   *   relative to the page (must end with '/'). The demo passes
   *   './vendor-ux/ux/'. Used by adoptAccessibilitySettings/Captions/Onboarding
   *   and foldUxAccess (each accepts a per-call uxBase override).
   * @param {string} [opts.settingsFixHref] Explicit href for
   *   settings-shell-fix.css (the narrow-width breakpoint overlay linked by
   *   applyTheme). It sits BESIDE this module / the page — NOT under assetBase
   *   (which points at the ui-kit root) — so it defaults to the module-relative
   *   URL `new URL('./settings-shell-fix.css', import.meta.url)`. The demo may
   *   pass './settings-shell-fix.css'.
   */
  constructor(opts = {}) {
    this.root = opts.root || (typeof document !== 'undefined' ? document : null);
    this.ui = opts.ui || null;
    this.theme = opts.theme || 'dark';
    let base = opts.assetBase == null ? './' : String(opts.assetBase);
    if (base && !base.endsWith('/')) base += '/';
    this.assetBase = base;
    // brand-theme.css and the wordmark asset may live off the assetBase root
    // (ui-kit/ at repo root vs. brand-theme.css beside the page). Allow both to
    // be pinned independently; fall back to assetBase-relative defaults.
    this.themeHref = opts.themeHref != null ? String(opts.themeHref) : base + 'brand-theme.css';
    this.wordmarkHref =
      opts.wordmarkHref != null
        ? String(opts.wordmarkHref)
        : base + 'vendor-game/brand/wordmark-dark.svg';

    // Where the ux-access package sits in the game tree (default './ux/').
    let ux = opts.uxBase == null ? './ux/' : String(opts.uxBase);
    if (ux && !ux.endsWith('/')) ux += '/';
    this.uxBase = ux;
    // settings-shell-fix.css lives beside this module (ui-integrate/), off the
    // ui-kit assetBase root — default to a module-relative URL so it resolves
    // wherever HudKit is deployed. Overridable for bundlers/odd layouts.
    this.settingsFixHref =
      opts.settingsFixHref != null
        ? String(opts.settingsFixHref)
        : safe(() => new URL('./settings-shell-fix.css', import.meta.url).href, 'settingsFixHref') ||
          base + 'settings-shell-fix.css';

    /** @type {Map<string, {revert:Function}>} active adoptions, keyed by name. */
    this._adoptions = new Map();
    /** @type {HTMLLinkElement[]} theme <link>s we injected. */
    this._themeLinks = [];
    /** @type {Set<string>} hrefs we've already linked (idempotency). */
    this._linked = new Set();
    /** @type {string[]} names of adopts that no-op'd (missing element). */
    this.skipped = [];
  }

  /** @param {object} [opts] @returns {HudKit} */
  static init(opts) {
    return new HudKit(opts);
  }

  /** @returns {Document|null} owner document for element creation. */
  get _doc() {
    if (!this.root) return typeof document !== 'undefined' ? document : null;
    return this.root.ownerDocument || (this.root.nodeType === 9 ? this.root : document);
  }

  /** @param {string} sel @returns {Element|null} defensive query. */
  _q(sel) {
    return safe(() => (this.root ? this.root.querySelector(sel) : null), 'query ' + sel) || null;
  }

  /**
   * Inject a stylesheet <link> once (idempotent, tracked for revert).
   * @param {string} href @param {boolean} [track=true]
   * @returns {HTMLLinkElement|null}
   */
  _linkCss(href, track = true) {
    const doc = this._doc;
    if (!doc || !doc.head) return null;
    if (this._linked.has(href)) return null;
    return safe(() => {
      // Respect a link already present in the page.
      const existing = doc.head.querySelector('link[href="' + href + '"]');
      if (existing) {
        this._linked.add(href);
        return existing;
      }
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.hudkit = '';
      doc.head.appendChild(link);
      this._linked.add(href);
      if (track) this._themeLinks.push(link);
      return link;
    }, 'linkCss ' + href);
  }

  // =======================================================================
  // TIER 1 — palette
  // =======================================================================

  /**
   * Inject the token + base + brand-theme stylesheets and set data-theme.
   * Idempotent. This alone re-skins every builder widget and fixes the R1
   * contrast issues — the recommended first step, no markup change.
   * @returns {{revert:Function}} revert handle (calls removeTheme()).
   */
  applyTheme() {
    const b = this.assetBase;
    // Order matters: tokens -> base -> brand overlay (overlay must win).
    this._linkCss(b + 'ui-kit/tokens.css');
    this._linkCss(b + 'ui-kit/base.css');
    // brand-theme.css may live off the assetBase root — use the resolved href.
    this._linkCss(this.themeHref);
    // ui-kit follow-up: the narrow-width settings-shell breakpoint overlay.
    // Linked LAST so its @media rules win over settings-shell.css by source
    // order (equal specificity). Tracked, so removeTheme() unlinks it too.
    this._linkCss(this.settingsFixHref);
    safe(() => {
      const doc = this._doc;
      if (doc && doc.documentElement) doc.documentElement.dataset.theme = this.theme;
    }, 'set data-theme');
    const handle = { revert: () => this.removeTheme() };
    return handle;
  }

  /** Remove the injected theme links + data-theme. Idempotent. */
  removeTheme() {
    safe(() => {
      for (const link of this._themeLinks) {
        if (link && link.parentNode) link.parentNode.removeChild(link);
        this._linked.delete(link && link.href);
      }
      this._themeLinks = [];
      const doc = this._doc;
      if (doc && doc.documentElement) delete doc.documentElement.dataset.theme;
    }, 'removeTheme');
  }

  // =======================================================================
  // TIER 2 — per-widget adoption helpers
  // =======================================================================

  /**
   * Dynamically import an lf component module + link its css.
   * @param {string} name component basename, e.g. 'crosshair'
   * @returns {Promise<any>} the module (or null on failure)
   */
  async _loadComponent(name) {
    this._linkCss(this.assetBase + 'ui-kit/components/' + name + '.css', false);
    return safe(
      () => import(/* @vite-ignore */ this.assetBase + 'ui-kit/components/' + name + '.js'),
      'import ' + name
    ) || Promise.resolve(null);
  }

  /** Create an lf element via the owner document. @returns {Element|null} */
  _make(tag) {
    const doc = this._doc;
    return doc ? safe(() => doc.createElement(tag), 'create ' + tag) : null;
  }

  /**
   * Resolve a ux-access base path (per-call override or the instance default),
   * normalizing a trailing slash.
   * @param {string} [override] @returns {string}
   */
  _uxBase(override) {
    let b = override != null ? String(override) : this.uxBase;
    if (b && !b.endsWith('/')) b += '/';
    return b;
  }

  /**
   * Dynamically import a ux-access module (never throws; returns a Promise).
   * @param {string} href absolute-or-page-relative module URL
   * @returns {Promise<any>}
   */
  _importUx(href) {
    return (
      safe(() => import(/* @vite-ignore */ href), 'import ux ' + href) || Promise.resolve(null)
    );
  }

  /**
   * Once `tag` is a defined custom element, run `fn(el)` (used to assign
   * bootstrap PROPERTIES like .defaults/.flow/.captions that are NOT observed
   * attributes and so are lost if set before upgrade). Never throws.
   * @param {string} tag @param {Element} el @param {(el:Element)=>void} fn
   */
  _whenDefined(tag, el, fn) {
    safe(() => {
      const ce = typeof customElements !== 'undefined' ? customElements : null;
      if (ce && isFn(ce.whenDefined)) {
        ce.whenDefined(tag).then(() => safe(() => fn(el), 'apply ' + tag));
      } else {
        safe(() => fn(el), 'apply ' + tag);
      }
    }, 'whenDefined ' + tag);
  }

  /**
   * Record an adoption under `name`, wiring idempotency + revert tracking.
   * If already adopted, returns the existing handle unchanged.
   * @param {string} name
   * @param {() => {revert:Function, [k:string]:any}} build
   * @returns {{revert:Function, [k:string]:any}}
   */
  _adopt(name, build) {
    if (this._adoptions.has(name)) return this._adoptions.get(name);
    const handle =
      safe(build, 'adopt ' + name) || { revert() {}, _noop: true, element: null };
    // Wrap revert so it also drops from the registry.
    const rawRevert = handle.revert;
    handle.revert = () => {
      safe(() => {
        if (isFn(rawRevert)) rawRevert();
      }, 'revert ' + name);
      this._adoptions.delete(name);
    };
    this._adoptions.set(name, handle);
    return handle;
  }

  /** Mark an adopt as a no-op because its builder element is missing. */
  _missing(name, sel) {
    if (this.skipped.indexOf(name) === -1) this.skipped.push(name);
    return { revert() {}, _missing: sel, element: null };
  }

  // ---- Wordmark ---------------------------------------------------------

  /**
   * Replace the text wordmark (#game-title.game-title = "LOOMFALL") with the
   * brand wordmark SVG, token-colored (.wm-key stroke void, .wm-thread
   * stroke gold, .wm-glyph fill muslin). revert() restores the original h1.
   * @returns {{revert:Function, element:Element|null}}
   */
  adoptWordmark() {
    return this._adopt('wordmark', () => {
      const h1 = this._q('#game-title') || this._q('.game-title');
      if (!h1) return this._missing('wordmark', '#game-title');
      const prevHTML = h1.innerHTML;
      const prevLabel = h1.getAttribute('aria-label');
      const doc = this._doc;
      const mount = (svg) => {
        h1.innerHTML = svg;
        h1.setAttribute('aria-label', 'LOOMFALL');
      };
      // Prefer the saved brand asset; fall back to an inline token-colored SVG.
      safe(() => {
        if (typeof fetch === 'function') {
          fetch(this.wordmarkHref)
            .then((r) => (r && r.ok ? r.text() : Promise.reject(new Error('no svg'))))
            .then((txt) => mount(txt))
            .catch(() => mount(INLINE_WORDMARK));
        } else {
          mount(INLINE_WORDMARK);
        }
      }, 'fetch wordmark') || mount(INLINE_WORDMARK);
      void doc;
      return {
        element: h1,
        revert: () => {
          h1.innerHTML = prevHTML;
          if (prevLabel == null) h1.removeAttribute('aria-label');
          else h1.setAttribute('aria-label', prevLabel);
        },
      };
    });
  }

  // ---- Crosshair --------------------------------------------------------

  /**
   * Hide the builder .crosshair; mount <lf-crosshair variant="cross" fixed>.
   * Bridges ui.hud.showCrosshair(b) -> toggle the lf element's [hidden].
   * @returns {{revert:Function, element:Element|null}}
   */
  adoptCrosshair() {
    return this._adopt('crosshair', () => {
      const host = this._q('#hud') || (this._doc && this._doc.body);
      const old = this._q('.crosshair');
      if (!host) return this._missing('crosshair', '#hud');
      this._loadComponent('crosshair');
      const el = this._make('lf-crosshair');
      if (!el) return this._missing('crosshair', 'lf-crosshair');
      el.setAttribute('variant', 'cross');
      el.setAttribute('fixed', '');
      const prevOldDisplay = old ? old.style.display : null;
      if (old) old.style.display = 'none';
      host.appendChild(el);

      const restore = this._bridge('hud', 'showCrosshair', (orig, args) => {
        const show = args[0];
        if (show) el.removeAttribute('hidden');
        else el.setAttribute('hidden', '');
        return isFn(orig) ? orig.apply(this.ui.hud, args) : undefined;
      });

      return {
        element: el,
        revert: () => {
          restore();
          if (el.parentNode) el.parentNode.removeChild(el);
          if (old) old.style.display = prevOldDisplay || '';
        },
      };
    });
  }

  // ---- Statbars ---------------------------------------------------------

  /**
   * Mount <lf-statbars health-max="20"> in the HUD. Bridges
   * ui.hud.setHealth(0..20) -> the `health` attr. The builder's shard row is
   * hidden (the lf statbars carry the same shape-coded shards); revert()
   * restores it.
   * @param {object} [opts]
   * @param {() => number} [opts.getHealth] optional seed for initial health.
   * @returns {{revert:Function, element:Element|null}}
   */
  adoptStatbars({ getHealth } = {}) {
    return this._adopt('statbars', () => {
      const host = this._q('#hud');
      if (!host) return this._missing('statbars', '#hud');
      this._loadComponent('statbars');
      const el = this._make('lf-statbars');
      if (!el) return this._missing('statbars', 'lf-statbars');
      el.setAttribute('health-max', '20');
      const seed = isFn(getHealth) ? safe(() => getHealth(), 'getHealth') : undefined;
      if (typeof seed === 'number') el.setAttribute('health', String(seed));
      // Hide the builder shard row (documented choice: lf shards replace it).
      const oldRow = this._q('.health');
      const prevDisplay = oldRow ? oldRow.style.display : null;
      if (oldRow) oldRow.style.display = 'none';
      host.appendChild(el);

      const restore = this._bridge('hud', 'setHealth', (orig, args) => {
        const v = args[0];
        if (typeof v === 'number') el.setAttribute('health', String(v));
        return isFn(orig) ? orig.apply(this.ui.hud, args) : undefined;
      });

      return {
        element: el,
        revert: () => {
          restore();
          if (el.parentNode) el.parentNode.removeChild(el);
          if (oldRow) oldRow.style.display = prevDisplay || '';
        },
      };
    });
  }

  // ---- Hotbar -----------------------------------------------------------

  /**
   * Mount <lf-hotbar global-keys show-label> with 9 <lf-item-slot>. Bridges
   * ui.hotbar.setSlots(ids) -> slot item/label/swatch, setSelected(i) ->
   * [selected], and forwards lf-select back to ui.hotbar's selection.
   * @returns {{revert:Function, element:Element|null}}
   */
  adoptHotbar() {
    return this._adopt('hotbar', () => {
      const old = this._q('#hotbar');
      const host = (old && old.parentNode) || (this._doc && this._doc.body);
      if (!host) return this._missing('hotbar', '#hotbar');
      this._loadComponent('hotbar');
      const el = this._make('lf-hotbar');
      if (!el) return this._missing('hotbar', 'lf-hotbar');
      el.setAttribute('global-keys', '');
      el.setAttribute('show-label', '');
      const doc = this._doc;
      for (let i = 0; i < 9; i++) {
        const s = doc.createElement('lf-item-slot');
        el.appendChild(s);
      }
      const prevOldDisplay = old ? old.style.display : null;
      if (old) old.style.display = 'none';
      host.appendChild(el);

      const applySlots = (ids) => {
        const slots = el.querySelectorAll('lf-item-slot');
        for (let i = 0; i < slots.length; i++) {
          const id = ids && ids[i];
          if (id == null || id === '') {
            slots[i].removeAttribute('item');
            slots[i].removeAttribute('swatch');
          } else {
            slots[i].setAttribute('item', String(id));
            slots[i].setAttribute('swatch', String(id));
          }
        }
      };

      const restoreSet = this._bridge('hotbar', 'setSlots', (orig, args) => {
        applySlots(args[0]);
        return isFn(orig) ? orig.apply(this.ui.hotbar, args) : undefined;
      });
      const restoreSel = this._bridge('hotbar', 'setSelected', (orig, args) => {
        const i = args[0];
        if (typeof i === 'number') el.setAttribute('selected', String(i));
        return isFn(orig) ? orig.apply(this.ui.hotbar, args) : undefined;
      });

      // Forward lf-select -> builder selection (if the builder exposes it).
      const onSelect = (e) => {
        const idx = e && e.detail && e.detail.index;
        const hb = this.ui && this.ui.hotbar;
        if (hb && isFn(hb.setSelected) && typeof idx === 'number') {
          // setSelected is wrapped; call the raw stored original to avoid echo.
          safe(() => hb.setSelected(idx), 'forward select');
        }
      };
      el.addEventListener('lf-select', onSelect);

      return {
        element: el,
        revert: () => {
          restoreSet();
          restoreSel();
          el.removeEventListener('lf-select', onSelect);
          if (el.parentNode) el.parentNode.removeChild(el);
          if (old) old.style.display = prevOldDisplay || '';
        },
      };
    });
  }

  // ---- Chat -------------------------------------------------------------

  /**
   * Mount <lf-chat>. Bridges ui.chat.addMessage -> el.addMessage and forwards
   * lf-send back to the builder. NOTE: if a social module already owns chat,
   * this overlaps — adopt only one owner. revert() restores the builder chat.
   * @returns {{revert:Function, element:Element|null}}
   */
  adoptChat() {
    return this._adopt('chat', () => {
      const old = this._q('#chat');
      const host = (old && old.parentNode) || (this._doc && this._doc.body);
      if (!host) return this._missing('chat', '#chat');
      this._loadComponent('chat');
      const el = this._make('lf-chat');
      if (!el) return this._missing('chat', 'lf-chat');
      const prevOldDisplay = old ? old.style.display : null;
      if (old) old.style.display = 'none';
      host.appendChild(el);

      const restoreAdd = this._bridge('chat', 'addMessage', (orig, args) => {
        // Builder addMessage(name, text, kind?) OR ({name,text,system}).
        let msg = args[0];
        if (typeof msg === 'string' || args.length > 1) {
          msg = { name: args[0], text: args[1], system: args[2] === 'system' };
        }
        if (el.addMessage) safe(() => el.addMessage(msg), 'lf addMessage');
        return isFn(orig) ? orig.apply(this.ui.chat, args) : undefined;
      });

      // Forward lf-send -> builder (if it exposes a send/submit hook).
      const onSend = (e) => {
        const text = e && e.detail && e.detail.text;
        const c = this.ui && this.ui.chat;
        if (c && isFn(c.onSend)) safe(() => c.onSend(text), 'forward send');
        else if (c && isFn(c.submit)) safe(() => c.submit(text), 'forward send');
      };
      el.addEventListener('lf-send', onSend);

      return {
        element: el,
        revert: () => {
          restoreAdd();
          el.removeEventListener('lf-send', onSend);
          if (el.parentNode) el.parentNode.removeChild(el);
          if (old) old.style.display = prevOldDisplay || '';
        },
      };
    });
  }

  // ---- Debug ------------------------------------------------------------

  /**
   * Mount <lf-debug-overlay>. Bridges ui.debug.setData(obj) -> setData and
   * ui.debug.setVisible(b)/toggle() -> the lf overlay. revert() restores it.
   * @returns {{revert:Function, element:Element|null}}
   */
  adoptDebug() {
    return this._adopt('debug', () => {
      const old = this._q('#debug');
      const host = (old && old.parentNode) || (this._doc && this._doc.body);
      if (!host) return this._missing('debug', '#debug');
      this._loadComponent('debug-overlay');
      const el = this._make('lf-debug-overlay');
      if (!el) return this._missing('debug', 'lf-debug-overlay');
      const prevOldDisplay = old ? old.style.display : null;
      if (old) old.style.display = 'none';
      host.appendChild(el);

      const restoreData = this._bridge('debug', 'setData', (orig, args) => {
        if (el.setData) safe(() => el.setData(args[0]), 'lf setData');
        return isFn(orig) ? orig.apply(this.ui.debug, args) : undefined;
      });
      const restoreVis = this._bridge('debug', 'setVisible', (orig, args) => {
        if (el.setVisible) safe(() => el.setVisible(!!args[0]), 'lf setVisible');
        return isFn(orig) ? orig.apply(this.ui.debug, args) : undefined;
      });
      const restoreToggle = this._bridge('debug', 'toggle', (orig, args) => {
        if (el.toggle) safe(() => el.toggle(), 'lf toggle');
        return isFn(orig) ? orig.apply(this.ui.debug, args) : undefined;
      });

      return {
        element: el,
        revert: () => {
          restoreData();
          restoreVis();
          restoreToggle();
          if (el.parentNode) el.parentNode.removeChild(el);
          if (old) old.style.display = prevOldDisplay || '';
        },
      };
    });
  }

  // ---- Inventory --------------------------------------------------------

  /**
   * Mount <lf-inventory-grid>. Bridges ui.inventory.setBlocks(list) -> grid
   * slots and open()/close()/toggle() -> element visibility. revert() restores.
   * @returns {{revert:Function, element:Element|null}}
   */
  adoptInventory() {
    return this._adopt('inventory', () => {
      const old = this._q('#inventory');
      const host = (old && old.parentNode) || (this._doc && this._doc.body);
      if (!host) return this._missing('inventory', '#inventory');
      this._loadComponent('inventory');
      const el = this._make('lf-inventory-grid');
      if (!el) return this._missing('inventory', 'lf-inventory-grid');
      el.setAttribute('columns', '9');
      el.setAttribute('label', 'Inventory');
      el.hidden = true;
      const prevOldDisplay = old ? old.style.display : null;
      if (old) old.style.display = 'none';
      host.appendChild(el);
      const doc = this._doc;

      const applyBlocks = (blocks) => {
        el.innerHTML = '';
        const list = Array.isArray(blocks) ? blocks : [];
        for (const b of list) {
          const s = doc.createElement('lf-item-slot');
          const id = b && (b.id != null ? b.id : b);
          if (id != null) {
            s.setAttribute('item', String(id));
            s.setAttribute('swatch', String(id));
          }
          el.appendChild(s);
        }
      };

      const restoreSet = this._bridge('inventory', 'setBlocks', (orig, args) => {
        applyBlocks(args[0]);
        return isFn(orig) ? orig.apply(this.ui.inventory, args) : undefined;
      });
      const restoreOpen = this._bridge('inventory', 'open', (orig, args) => {
        el.hidden = false;
        return isFn(orig) ? orig.apply(this.ui.inventory, args) : undefined;
      });
      const restoreClose = this._bridge('inventory', 'close', (orig, args) => {
        el.hidden = true;
        return isFn(orig) ? orig.apply(this.ui.inventory, args) : undefined;
      });
      const restoreToggle = this._bridge('inventory', 'toggle', (orig, args) => {
        el.hidden = !el.hidden;
        return isFn(orig) ? orig.apply(this.ui.inventory, args) : undefined;
      });

      return {
        element: el,
        revert: () => {
          restoreSet();
          restoreOpen();
          restoreClose();
          restoreToggle();
          if (el.parentNode) el.parentNode.removeChild(el);
          if (old) old.style.display = prevOldDisplay || '';
        },
      };
    });
  }

  // ---- Settings ---------------------------------------------------------

  /**
   * Mount <lf-settings-shell> with authored <section data-category> panels
   * mirroring the builder's settings rows. A future ux-access Accessibility
   * section docks as another <section data-category="Accessibility"> — the
   * placeholder is authored here so the rail slot exists.
   * @returns {{revert:Function, element:Element|null}}
   */
  adoptSettings() {
    return this._adopt('settings', () => {
      const host = this._q('#menu-root') || (this._doc && this._doc.body);
      if (!host) return this._missing('settings', '#menu-root');
      this._loadComponent('settings-shell');
      const el = this._make('lf-settings-shell');
      if (!el) return this._missing('settings', 'lf-settings-shell');
      el.setAttribute('heading', 'Settings');
      const doc = this._doc;
      // Author category panels mirroring the builder's .set-row groups.
      const categories = ['Graphics', 'Audio', 'Controls', 'Accessibility'];
      for (const cat of categories) {
        const sec = doc.createElement('section');
        sec.setAttribute('data-category', cat);
        // ux-access Accessibility section docks here (rows added later).
        if (cat === 'Accessibility') sec.setAttribute('data-ux-access-dock', '');
        el.appendChild(sec);
      }
      el.hidden = true;
      host.appendChild(el);

      return {
        element: el,
        revert: () => {
          if (el.parentNode) el.parentNode.removeChild(el);
        },
      };
    });
  }

  // ---- Main menu --------------------------------------------------------

  /**
   * Heavier swap: mount <lf-main-menu version splash> (wordmark built-in) in
   * place of the builder title screen and forward lf-action -> the builder's
   * menu callbacks (ui.menus.* if present). revert() restores the builder menu.
   * @param {object} [opts]
   * @param {string} [opts.version='0.1.0']
   * @param {string} [opts.splash='Every thread returns!']
   * @returns {{revert:Function, element:Element|null}}
   */
  adoptMainMenu({ version = '0.1.0', splash = 'Every thread returns!' } = {}) {
    return this._adopt('mainMenu', () => {
      const host = this._q('#menu-root');
      if (!host) return this._missing('mainMenu', '#menu-root');
      this._loadComponent('main-menu');
      const el = this._make('lf-main-menu');
      if (!el) return this._missing('mainMenu', 'lf-main-menu');
      el.setAttribute('version', version);
      if (splash) el.setAttribute('splash', splash);
      // Hide the builder title contents while the lf menu is mounted.
      const prevChildrenDisplay = [];
      for (const child of Array.from(host.children)) {
        prevChildrenDisplay.push([child, child.style.display]);
        child.style.display = 'none';
      }
      host.appendChild(el);

      const menus = this.ui && this.ui.menus;
      const onAction = (e) => {
        const action = e && e.detail && e.detail.action;
        if (!menus) return;
        const map = {
          singleplayer: 'showWorldSelect',
          multiplayer: 'showWorldSelect',
          settings: 'showSettings',
          quit: 'hideAll',
        };
        const method = map[action];
        if (method && isFn(menus[method])) safe(() => menus[method](), 'menu action ' + action);
      };
      el.addEventListener('lf-action', onAction);

      return {
        element: el,
        revert: () => {
          el.removeEventListener('lf-action', onAction);
          if (el.parentNode) el.parentNode.removeChild(el);
          for (const [child, disp] of prevChildrenDisplay) child.style.display = disp || '';
        },
      };
    });
  }

  // =======================================================================
  // TIER 3 — ux-access fold (keybinds / options / captions / onboarding)
  // =======================================================================

  /**
   * Dock the ux-access keybinds + accessibility-options panels into an
   * <lf-settings-shell>. Finds an existing shell (e.g. from adoptSettings) or
   * creates one appended to `mountInto`. Imports the vendored modules and
   * inserts a <section data-category="Controls"><lf-keybinds></section> and a
   * <section data-category="Accessibility" data-ux-access-dock><lf-access-options></section>.
   * Because the shell consumes its sections at render() time, when we CREATE
   * the shell the sections are authored as children first, then the shell is
   * connected. When docking into an EXISTING (already-rendered) shell we
   * append the panels into its matching category bodies instead.
   * @param {object} [opts]
   * @param {string} [opts.uxBase] override the instance uxBase.
   * @param {object} [opts.bindingsDoc] parsed bindings.default.json; assigned
   *   to lf-keybinds .defaults once the element upgrades.
   * @param {Element} [opts.mountInto] host for a newly-created shell
   *   (default #menu-root, else <body>).
   * @returns {{revert:Function, element:Element|null, keybinds:Element|null, options:Element|null}}
   */
  adoptAccessibilitySettings({ uxBase, bindingsDoc, mountInto } = {}) {
    return this._adopt('a11ySettings', () => {
      const doc = this._doc;
      if (!doc) return this._missing('a11ySettings', 'document');
      const base = this._uxBase(uxBase);

      // The <lf-settings-shell> host itself is a ui-kit component — load its
      // definition (+ css) so the shell upgrades and builds its rail/pane/tabs
      // and CONSUMES our authored <section data-category> panels at render().
      // Without this the shell stays inert and the panels never dock into tabs.
      this._loadComponent('settings-shell');

      // Link the ux component css + import the modules (options-store is
      // pulled transitively by access-options; it auto-links cvd/motion css).
      this._linkCss(base + 'keybinds/keybinds.css', false);
      this._linkCss(base + 'options/access-options.css', false);
      this._importUx(base + 'keybinds/keybinds.js');
      this._importUx(base + 'options/access-options.js');

      const kb = this._make('lf-keybinds');
      const opts = this._make('lf-access-options');
      if (!kb || !opts) return this._missing('a11ySettings', 'lf-keybinds/lf-access-options');

      const existing = this._q('lf-settings-shell');
      let shell = existing;
      let createdShell = false;
      const added = []; // nodes we inserted, for revert

      if (existing) {
        // Dock into the already-rendered shell's category bodies (sections
        // were reparented into the pane but keep their data-category attr).
        const controls =
          existing.querySelector('section[data-category="Controls"]') ||
          existing.querySelector('.lf-settings-shell__panel[data-category="Controls"]');
        const access =
          existing.querySelector('section[data-ux-access-dock]') ||
          existing.querySelector('section[data-category="Accessibility"]');
        if (controls) {
          controls.appendChild(kb);
          added.push(kb);
        }
        if (access) {
          access.setAttribute('data-ux-access-dock', '');
          access.appendChild(opts);
          added.push(opts);
        }
        if (!controls && !access) {
          return this._missing('a11ySettings', 'shell Controls/Accessibility sections');
        }
      } else {
        // Author the sections as children BEFORE connecting the shell.
        shell = this._make('lf-settings-shell');
        if (!shell) return this._missing('a11ySettings', 'lf-settings-shell');
        shell.setAttribute('heading', 'Settings');
        const controls = doc.createElement('section');
        controls.setAttribute('data-category', 'Controls');
        controls.appendChild(kb);
        const access = doc.createElement('section');
        access.setAttribute('data-category', 'Accessibility');
        access.setAttribute('data-ux-access-dock', '');
        access.appendChild(opts);
        shell.appendChild(controls);
        shell.appendChild(access);
        const host = mountInto || this._q('#menu-root') || doc.body;
        if (!host) return this._missing('a11ySettings', '#menu-root');
        host.appendChild(shell); // renders now, consuming the two sections
        createdShell = true;
      }

      // Bootstrap the keybinds defaults once the element is upgraded.
      if (bindingsDoc) {
        this._whenDefined('lf-keybinds', kb, (el) => {
          el.defaults = bindingsDoc;
        });
      }

      return {
        element: shell,
        keybinds: kb,
        options: opts,
        revert: () => {
          if (createdShell) {
            if (shell && shell.parentNode) shell.parentNode.removeChild(shell);
          } else {
            for (const n of added) if (n && n.parentNode) n.parentNode.removeChild(n);
          }
        },
      };
    });
  }

  /**
   * Mount <lf-captions> into the HUD layer. It self-subscribes on connect to
   * the window `lf-audio-event` bus — so the BUILDER'S GameAudio must dispatch
   * `window` 'lf-audio-event' {name, direction?, volume?, loop?, ended?} per
   * engine.play() for lines to appear (there is no attach() method). Use the
   * static HudKit.emitAudioEvent(detail) bridge from the builder or a test.
   * @param {object} [opts]
   * @param {string} [opts.uxBase] override the instance uxBase.
   * @param {object} [opts.captionsDoc] parsed captions.json; assigned to
   *   .captions once the element upgrades.
   * @param {('bottom-left'|'bottom-right'|'top-left'|'top-right')} [opts.corner]
   * @returns {{revert:Function, element:Element|null}}
   */
  adoptCaptions({ uxBase, captionsDoc, corner } = {}) {
    return this._adopt('captions', () => {
      const doc = this._doc;
      const host = this._q('#hud') || (doc && doc.body);
      if (!host) return this._missing('captions', '#hud');
      const base = this._uxBase(uxBase);
      this._linkCss(base + 'captions/captions.css', false);
      this._importUx(base + 'captions/captions.js');
      const el = this._make('lf-captions');
      if (!el) return this._missing('captions', 'lf-captions');
      if (corner) el.setAttribute('corner', corner);
      host.appendChild(el); // connects + self-subscribes to lf-audio-event
      if (captionsDoc) {
        this._whenDefined('lf-captions', el, (c) => {
          c.captions = captionsDoc;
        });
      }
      return {
        element: el,
        revert: () => {
          if (el.parentNode) el.parentNode.removeChild(el);
        },
      };
    });
  }

  /**
   * Mount <lf-tutorial> onboarding coach-marks. Gate the beats by dispatching
   * window 'lf-game-event' {type:'on_first_block_broken'|...} — use the static
   * HudKit.emitGameEvent(type) bridge. Beats anchor via
   * document.querySelector('[data-lf-anchor="<id>"]'); call tagHudAnchors()
   * first so those anchors exist on the managed HUD widgets.
   * @param {object} [opts]
   * @param {string} [opts.uxBase] override the instance uxBase.
   * @param {object} [opts.flowDoc] parsed tutorial.json; assigned to .flow.
   * @param {string} [opts.src] flow JSON URL (alternative to flowDoc).
   * @param {boolean} [opts.autostart=true] arm the overlay (start({force}))
   *   so gate events advance it. Set false to arm it yourself later.
   * @returns {{revert:Function, element:Element|null}}
   */
  adoptOnboarding({ uxBase, flowDoc, src, autostart = true } = {}) {
    return this._adopt('onboarding', () => {
      const doc = this._doc;
      const host = this._q('#hud') || (doc && doc.body);
      if (!host) return this._missing('onboarding', 'body');
      const base = this._uxBase(uxBase);
      this._linkCss(base + 'onboarding/tutorial.css', false);
      this._importUx(base + 'onboarding/tutorial.js');
      const el = this._make('lf-tutorial');
      if (!el) return this._missing('onboarding', 'lf-tutorial');
      if (src && !flowDoc) el.setAttribute('src', src);
      host.appendChild(el);
      this._whenDefined('lf-tutorial', el, (t) => {
        if (flowDoc) t.flow = flowDoc;
        if (autostart && isFn(t.start)) t.start({ force: true });
      });
      return {
        element: el,
        revert: () => {
          if (el.parentNode) el.parentNode.removeChild(el);
        },
      };
    });
  }

  /**
   * Stamp data-lf-anchor onto the managed HUD widgets using the reserved
   * onboarding anchor vocabulary, so <lf-tutorial> coach-marks can locate
   * them. Prefers the adopted lf-* elements, falling back to the builder's
   * bare widgets. One element carries at most one anchor id (later ids for an
   * already-tagged element are skipped). Idempotent; revert removes only the
   * attrs we added.
   * @param {Record<string, string|string[]>} [map] anchorId -> selector(s).
   * @returns {{revert:Function}}
   */
  tagHudAnchors(map) {
    return this._adopt('anchors', () => {
      const resolve = (candidates) => {
        const list = Array.isArray(candidates) ? candidates : [candidates];
        for (const sel of list) {
          const el = this._q(sel);
          if (el) return el;
        }
        return null;
      };
      const defaults = {
        hotbar: ['lf-hotbar', '#hotbar'],
        healthbar: ['lf-statbars', '.health', '.healthbar'],
        statbars: ['lf-statbars', '.statbars', '.health'],
        crosshair: ['lf-crosshair', '.crosshair'],
        chat: ['lf-chat', '#chat'],
        debug: ['lf-debug-overlay', '#debug'],
        'inventory-button': ['#inventory-button', '.inventory-button', '[data-inventory-open]'],
      };
      const spec = map || defaults;
      const applied = []; // [el] we stamped
      for (const anchorId of Object.keys(spec)) {
        const el = resolve(spec[anchorId]);
        if (!el) continue;
        // Don't clobber a pre-existing anchor (incl. one we set this run).
        if (el.getAttribute('data-lf-anchor') != null) continue;
        safe(() => el.setAttribute('data-lf-anchor', anchorId), 'anchor ' + anchorId);
        applied.push(el);
      }
      return {
        revert: () => {
          for (const el of applied) safe(() => el.removeAttribute('data-lf-anchor'), 'unanchor');
        },
      };
    });
  }

  /**
   * Convenience: fold the whole ux-access package in one call —
   * applyTheme() (which also links settings-shell-fix.css) +
   * adoptAccessibilitySettings + adoptCaptions + adoptOnboarding +
   * tagHudAnchors. Returns an aggregate revert that tears down all of them.
   * @param {object} [opts]
   * @param {string} [opts.uxBase]
   * @param {object} [opts.bindingsDoc]
   * @param {object} [opts.captionsDoc]
   * @param {object} [opts.flowDoc]
   * @param {string} [opts.captionsCorner]
   * @param {Record<string, string|string[]>} [opts.anchorMap]
   * @returns {{revert:Function, settings, captions, onboarding, anchors}}
   */
  foldUxAccess({ uxBase, bindingsDoc, captionsDoc, flowDoc, captionsCorner, anchorMap } = {}) {
    const base = this._uxBase(uxBase);
    // Ensure the palette + the settings-shell narrow-width fix are linked.
    this.applyTheme();
    const settings = this.adoptAccessibilitySettings({ uxBase: base, bindingsDoc });
    const captions = this.adoptCaptions({ uxBase: base, captionsDoc, corner: captionsCorner });
    const onboarding = this.adoptOnboarding({ uxBase: base, flowDoc });
    const anchors = this.tagHudAnchors(anchorMap);
    return {
      settings,
      captions,
      onboarding,
      anchors,
      revert: () => {
        for (const h of [anchors, onboarding, captions, settings]) {
          safe(() => h && isFn(h.revert) && h.revert(), 'foldUxAccess revert');
        }
      },
    };
  }

  // =======================================================================
  // Static window-event bridges (the ux-access buses, contract §4)
  // =======================================================================

  /**
   * Dispatch the window `lf-audio-event` that <lf-captions> consumes. The
   * builder's GameAudio calls this per engine.play(); the proof drives it too.
   * @param {{name:string, direction?:string, volume?:number, loop?:boolean, ended?:boolean, category?:string}} detail
   */
  static emitAudioEvent(detail) {
    if (typeof window === 'undefined') return;
    safe(
      () => window.dispatchEvent(new CustomEvent('lf-audio-event', { detail: detail || {} })),
      'emitAudioEvent'
    );
  }

  /**
   * Dispatch the window `lf-game-event` that gates <lf-tutorial> beats.
   * @param {string} type e.g. 'on_first_block_broken'
   * @param {object} [extra] merged into detail alongside {type}
   */
  static emitGameEvent(type, extra) {
    if (typeof window === 'undefined') return;
    safe(
      () =>
        window.dispatchEvent(
          new CustomEvent('lf-game-event', { detail: Object.assign({ type: type }, extra || {}) })
        ),
      'emitGameEvent'
    );
  }

  // =======================================================================
  // Bulk helpers
  // =======================================================================

  /**
   * applyTheme() + a default safe set of adoptions. Pass a list to override.
   * The default set is the low-risk, high-value widgets.
   * @param {string[]} [list] adopt names: wordmark|crosshair|statbars|hotbar
   *   |chat|debug|inventory|settings|mainMenu
   * @returns {{revert:Function}}
   */
  adoptAll(list) {
    this.applyTheme();
    const set = list || ['wordmark', 'crosshair', 'statbars', 'hotbar'];
    const map = {
      wordmark: () => this.adoptWordmark(),
      crosshair: () => this.adoptCrosshair(),
      statbars: () => this.adoptStatbars(),
      hotbar: () => this.adoptHotbar(),
      chat: () => this.adoptChat(),
      debug: () => this.adoptDebug(),
      inventory: () => this.adoptInventory(),
      settings: () => this.adoptSettings(),
      mainMenu: () => this.adoptMainMenu(),
    };
    for (const name of set) {
      if (map[name]) safe(map[name], 'adoptAll ' + name);
    }
    return { revert: () => this.revertAll() };
  }

  /** Revert every adoption + removeTheme(). Safe to call repeatedly. */
  revertAll() {
    for (const handle of Array.from(this._adoptions.values())) {
      safe(() => handle.revert(), 'revertAll');
    }
    this._adoptions.clear();
    this.removeTheme();
  }

  /** Full teardown. Reverts everything and drops references. */
  dispose() {
    this.revertAll();
    this.ui = null;
    this.root = null;
  }

  // =======================================================================
  // Internal bridging
  // =======================================================================

  /**
   * Wrap a method on a builder ui.<obj> so `wrapper(orig, args)` runs on
   * every call (letting us mirror into the lf element). No-ops safely when
   * `ui` was not provided or the object/method is absent — the caller then
   * drives the lf element directly.
   * @param {string} objName e.g. 'hud'
   * @param {string} method e.g. 'setHealth'
   * @param {(orig:Function|undefined, args:any[]) => any} wrapper
   * @returns {Function} restore() — puts the original method back.
   */
  _bridge(objName, method, wrapper) {
    const obj = this.ui && this.ui[objName];
    if (!obj) return function noop() {};
    const orig = obj[method];
    const self = this;
    const wrapped = function wrappedMethod(...args) {
      return wrapper.call(self, orig, args);
    };
    wrapped.__hudkitWrapped = true;
    safe(() => {
      obj[method] = wrapped;
    }, 'bridge ' + objName + '.' + method);
    return function restore() {
      safe(() => {
        if (obj[method] === wrapped) obj[method] = orig;
      }, 'unbridge ' + objName + '.' + method);
    };
  }
}

/**
 * Inline fallback wordmark (token-colored via CSS classes: .wm-key stroke
 * void, .wm-thread stroke gold, .wm-glyph fill muslin). Used only when the
 * saved brand asset can't be fetched.
 */
const INLINE_WORDMARK =
  '<svg viewBox="0 0 740 240" role="img" aria-label="LOOMFALL" xmlns="http://www.w3.org/2000/svg">' +
  '<g class="wm-key" stroke="var(--lf-brand-void,#14101F)" fill="none" stroke-linecap="round">' +
  '<path stroke-width="8.75" d="M17.5 84.3 C22 87 26 88 33 88 H638 C649 88 652.5 97 652 110"/>' +
  '</g>' +
  '<g class="wm-thread" stroke="var(--lf-brand-primary,#F2C14E)" fill="none" stroke-linecap="round">' +
  '<path stroke-width="6.75" d="M17.5 84.3 C22 87 26 88 33 88 H638 C649 88 652.5 97 652 110"/>' +
  '</g>' +
  '<g class="wm-glyph" fill="var(--lf-brand-muslin,#EDE7DA)">' +
  '<text x="24" y="150" font-size="120" font-family="var(--lf-font-display, sans-serif)" ' +
  'font-weight="800" letter-spacing="4">LOOMFALL</text>' +
  '</g>' +
  '</svg>';

export default HudKit;
