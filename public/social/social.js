// social/social.js
// Top-level wire-up / integration entry point for the social & presence layer.
// A builder constructs ONE SocialLayer to get the whole feature: presence roster
// + player-list overlay, session feed (join/leave/dim toasts), whisper/mute/block
// on top of the broadcast chat, and a free-fly spectator camera.
//
// SocialLayer owns the plumbing between the game's net client, its chat element,
// and the DOM-free presence store. Every opt is optional: a headless demo may
// omit `net` (no networking) or `camera` (no spectator) and the layer still runs.
// Nothing here ever throws.
//
// ASSUMPTIONS / PROTOCOL NOTES:
//   - The game server ECHOES chat via room broadcast: when we sendChat(text) the
//     server rebroadcasts it to everyone INCLUDING us, arriving via net.onChat.
//     So we do NOT echo the local player's own public chat here — that would
//     double it. Whisper lines are rendered locally by WhisperController itself.
//   - The wire protocol has NO ping and NO directed/private messages. Pings
//     therefore default to null and render as "—" in the list; setPing(id, ms)
//     is a passthrough so a future measured RTT (or a server that adds ping) can
//     feed real values in. Whispers degrade to local-only unless a directed
//     transport is injected (see whisper.js).

import { PresenceStore } from "./presence.js";
import "./player-list.js"; // side-effect: registers <lf-player-list>
import "./vendor/ui-kit/components/toast.js"; // side-effect: registers <lf-toast-rack>
import { SessionFeed } from "./session-feed.js";
import { WhisperController } from "./whisper.js";
import { SpectatorCamera } from "./spectator.js";

/* -------------------------------------------------------------------------- */
/* Local helpers (defensive, never throw)                                      */
/* -------------------------------------------------------------------------- */

/** Call fn safely, swallowing any throw. */
function safe(fn) {
  try {
    return fn();
  } catch (_err) {
    return undefined;
  }
}

/** True if v looks like a DOM element with addEventListener. */
function isEl(v) {
  return !!v && typeof v.addEventListener === "function";
}

/* -------------------------------------------------------------------------- */
/* SocialLayer                                                                 */
/* -------------------------------------------------------------------------- */

export class SocialLayer {
  /**
   * @param {{
   *   net?: Object,
   *   chat?: (Element & {addMessage?:Function}),
   *   camera?: Object,
   *   isSolid?: (x:number,y:number,z:number)=>boolean,
   *   mount?: HTMLElement,
   *   toastRack?: (Element & {show?:Function}),
   *   feedMount?: HTMLElement,
   *   canvas?: HTMLElement,
   *   selfName?: string,
   *   localSkin?: *,
   *   getLocalDim?: ()=>string,
   *   tabKey?: string,
   * }} [opts]
   */
  constructor(opts = {}) {
    const o = opts && typeof opts === "object" ? opts : {};
    this._opts = o;

    /** @type {HTMLElement|null} */
    this._mount = o.mount instanceof HTMLElement ? o.mount : null;
    this._tabKey = typeof o.tabKey === "string" && o.tabKey ? o.tabKey : "Tab";
    this._getLocalDim = typeof o.getLocalDim === "function" ? o.getLocalDim : null;

    // --- Presence store ------------------------------------------------
    this._presence = new PresenceStore({
      selfName: o.selfName,
      localSkin: o.localSkin != null ? o.localSkin : null,
    });

    // --- Player-list overlay ------------------------------------------
    /** @type {(Element & {setStore?:Function, show?:Function, hide?:Function})|null} */
    this._playerList = safe(() => {
      if (typeof document === "undefined") return null;
      const el = document.createElement("lf-player-list");
      if (this._mount) this._mount.appendChild(el);
      if (el && typeof el.setStore === "function") el.setStore(this._presence);
      return el;
    }) || null;

    // --- Toast rack ----------------------------------------------------
    /** @type {(Element & {show?:Function})|null} */
    this._rack = o.toastRack && isEl(o.toastRack) ? o.toastRack : null;
    if (!this._rack) {
      this._rack = safe(() => {
        if (typeof document === "undefined") return null;
        const el = document.createElement("lf-toast-rack");
        if (this._mount) this._mount.appendChild(el);
        else if (typeof document !== "undefined" && document.body) document.body.appendChild(el);
        return el;
      }) || null;
    }

    // --- Session feed --------------------------------------------------
    this._feed = new SessionFeed({
      presence: this._presence,
      rack: this._rack,
      feedMount: o.feedMount instanceof HTMLElement ? o.feedMount : undefined,
    });

    // --- Whisper controller -------------------------------------------
    this._chat = o.chat && isEl(o.chat) ? o.chat : null;
    this._whisper = new WhisperController({
      presence: this._presence,
      chat: this._chat,
      feed: this._feed,
      // ADOPTION ADDITION (Loomfall): the server now relays {t:'whisper'}
      // frames, so a builder can inject a real directed transport via
      // opts.sendWhisper ({to, text} => void). Absent = local-only degrade.
      send: typeof o.sendWhisper === "function" ? o.sendWhisper : null,
    });

    // --- Spectator camera ---------------------------------------------
    /** @type {SpectatorCamera|null} */
    this._spectator = o.camera
      ? new SpectatorCamera(o.camera, { isSolid: typeof o.isSolid === "function" ? o.isSolid : undefined })
      : null;

    // --- Net + bound listener bookkeeping -----------------------------
    /** @type {Object|null} */
    this._net = null;
    /** @type {Array<Function>} net-unsubscribe callbacks (if the client returns any). */
    this._netUnsubs = [];

    // Bound DOM handlers (paired for clean removal).
    this._onChatSend = (e) => this._handleChatSend(e);
    this._onKeyDown = (e) => this._handleTabKey(e, true);
    this._onKeyUp = (e) => this._handleTabKey(e, false);

    this._enabled = false;
    this._chatBound = false;

    if (o.net) this.setNet(o.net);
  }

  /* ----------------------------- getters ----------------------------- */

  /** @returns {PresenceStore} */
  get presence() {
    return this._presence;
  }
  /** @returns {WhisperController} */
  get whisper() {
    return this._whisper;
  }
  /** @returns {SessionFeed} */
  get feed() {
    return this._feed;
  }
  /** @returns {SpectatorCamera|null} */
  get spectator() {
    return this._spectator;
  }
  /** @returns {(Element)|null} the player-list overlay element. */
  get playerList() {
    return this._playerList;
  }

  /* ----------------------------- lifecycle --------------------------- */

  /**
   * Start the layer: subscribe the feed, bind chat + hold-Tab listeners. Idempotent.
   * @returns {this}
   */
  enable() {
    if (this._enabled) return this;
    this._enabled = true;
    safe(() => this._feed.start());
    this._bindChat();
    // Hold-Tab -> show player list (keyup hides). Bound on window.
    safe(() => {
      if (typeof window === "undefined") return;
      window.addEventListener("keydown", this._onKeyDown);
      window.addEventListener("keyup", this._onKeyUp);
    });
    return this;
  }

  /** Stop the layer: unbind listeners, stop the feed, disable spectator. Idempotent. */
  disable() {
    if (!this._enabled) return this;
    this._enabled = false;
    safe(() => this._feed.stop());
    this._unbindChat();
    safe(() => {
      if (typeof window === "undefined") return;
      window.removeEventListener("keydown", this._onKeyDown);
      window.removeEventListener("keyup", this._onKeyUp);
    });
    if (this._spectator && this._spectator.enabled) safe(() => this.toggleSpectator());
    return this;
  }

  /* ------------------------------- net ------------------------------- */

  /**
   * (Re)bind a NetClient-like object. Unbinds any previously wired client's
   * subscriptions that returned an unsubscribe fn. Never throws.
   * @param {Object} net
   * @returns {this}
   */
  setNet(net) {
    this._unbindNet();
    this._net = net || null;
    if (!this._net) return this;

    const on = (name, cb) => {
      const fn = this._net && typeof this._net[name] === "function" ? this._net[name] : null;
      if (!fn) return;
      const ret = safe(() => fn.call(this._net, cb));
      if (typeof ret === "function") this._netUnsubs.push(ret);
    };

    on("onState", (w) => safe(() => this._presence.ingestWelcome(w)));
    on("onPeerJoin", (m) => safe(() => this._presence.upsertPeer(m)));
    on("onPeerLeave", (m) => safe(() => this._presence.removePeer(m && m.id != null ? m.id : m)));
    on("onPeerMove", (m) => safe(() => this._presence.updateMove(m)));
    on("onChat", (m) => this._handleIncomingChat(m));
    on("onDisconnect", () => safe(() => this._feed.note("warn", "Disconnected")));

    return this;
  }

  _unbindNet() {
    for (const un of this._netUnsubs) safe(un);
    this._netUnsubs = [];
    this._net = null;
  }

  /**
   * Route an inbound public chat message: drop it if the sender is blocked,
   * else render it into the chat element. The server echoes our own chat here
   * too, so this is the single render site for public chat (no local echo).
   * @param {{name?:string, text?:string, id?:*}} m
   * @private
   */
  _handleIncomingChat(m) {
    safe(() => {
      if (!this._whisper.filterPublicChat(m)) return; // blocked sender
      if (this._chat && typeof this._chat.addMessage === "function") {
        this._chat.addMessage({ name: m && m.name, text: m && m.text });
      }
    });
  }

  /* ------------------------------ chat ------------------------------- */

  /**
   * Set (or replace) the chat element. Rebinds the lf-send listener if enabled.
   * @param {(Element & {addMessage?:Function})} chatEl
   * @returns {this}
   */
  setChat(chatEl) {
    this._unbindChat();
    this._chat = chatEl && isEl(chatEl) ? chatEl : null;
    // Keep the whisper controller pointed at the live chat element.
    if (this._whisper) this._whisper._chat = this._chat;
    if (this._enabled) this._bindChat();
    return this;
  }

  _bindChat() {
    if (this._chatBound || !this._chat) return;
    safe(() => this._chat.addEventListener("lf-send", this._onChatSend));
    this._chatBound = true;
  }

  _unbindChat() {
    if (!this._chatBound || !this._chat) {
      this._chatBound = false;
      return;
    }
    safe(() => this._chat.removeEventListener("lf-send", this._onChatSend));
    this._chatBound = false;
  }

  /**
   * Handle a chat submit: route through the whisper controller. If it resolves
   * to a public chat line, send it over the net (the server broadcasts it back
   * to us for rendering — we do NOT echo locally). Whisper/mod commands are
   * handled + rendered inside the controller.
   * @param {CustomEvent} e
   * @private
   */
  _handleChatSend(e) {
    safe(() => {
      const text = e && e.detail && typeof e.detail.text === "string" ? e.detail.text : "";
      if (!text) return;
      const result = this._whisper.handleInput(text);
      if (result && result.type === "chat" && typeof result.text === "string") {
        const send = this._net && typeof this._net.sendChat === "function" ? this._net.sendChat : null;
        if (send) safe(() => send.call(this._net, result.text));
      }
    });
  }

  /* ------------------------------ tab / list ------------------------- */

  /**
   * @param {KeyboardEvent} e
   * @param {boolean} down
   * @private
   */
  _handleTabKey(e, down) {
    if (!e || e.key !== this._tabKey) return;
    safe(() => {
      if (typeof e.preventDefault === "function") e.preventDefault();
    });
    if (down) this.showPlayerList();
    else this.hidePlayerList();
  }

  /** Show the player-list overlay. Never throws. */
  showPlayerList() {
    safe(() => {
      if (this._playerList && typeof this._playerList.show === "function") this._playerList.show();
    });
    return this;
  }

  /** Hide the player-list overlay. Never throws. */
  hidePlayerList() {
    safe(() => {
      if (this._playerList && typeof this._playerList.hide === "function") this._playerList.hide();
    });
    return this;
  }

  /* ---------------------------- spectator ---------------------------- */

  /**
   * Toggle the free-fly spectator camera. On enable it attaches to the canvas
   * for pointer-lock look + WASD fly; on disable it detaches. No-op if no
   * camera was provided.
   * @returns {boolean} the new spectating state.
   */
  toggleSpectator() {
    if (!this._spectator) return false;
    if (this._spectator.enabled) {
      safe(() => this._spectator.disable());
      safe(() => this._spectator.detach());
      return false;
    }
    safe(() => {
      this._spectator.enable();
      const canvas = this._resolveCanvas();
      if (canvas) this._spectator.attach(canvas, { pointerLock: true });
    });
    return this._spectator.enabled;
  }

  /** @returns {boolean} */
  isSpectating() {
    return !!(this._spectator && this._spectator.enabled);
  }

  /**
   * Best-effort resolve of a canvas element for spectator input.
   * @returns {HTMLElement|null}
   * @private
   */
  _resolveCanvas() {
    if (this._opts.canvas && isEl(this._opts.canvas)) return this._opts.canvas;
    return (
      safe(() => (typeof document !== "undefined" ? document.querySelector("canvas") : null)) ||
      safe(() => (typeof document !== "undefined" ? document.body : null)) ||
      null
    );
  }

  /* ------------------------------ ping ------------------------------- */

  /**
   * Passthrough to presence.setPing. The wire protocol has no ping, so this is
   * how a future measured RTT (or a ping-aware server) feeds real values; until
   * then pings stay null and render as "—".
   * @param {*} id
   * @param {number} ms
   */
  setPing(id, ms) {
    safe(() => this._presence.setPing(id, ms));
    return this;
  }

  /**
   * Sync the local player's dimension from the injected getLocalDim() into the
   * presence store (drives the feed's dim-change toast + list). Call from the
   * game when the local dim changes. No-op if no getLocalDim was provided.
   */
  syncSelfDim() {
    if (!this._getLocalDim) return this;
    safe(() => {
      const dim = this._getLocalDim();
      if (dim != null) this._presence.setSelfDim(dim);
    });
    return this;
  }

  /* ------------------------------ update ----------------------------- */

  /**
   * Per-frame tick: advances the spectator camera when it is flying. Never throws.
   * @param {number} dt seconds
   */
  update(dt) {
    if (this._spectator && this._spectator.enabled) safe(() => this._spectator.update(dt));
  }

  /* ------------------------------ dispose ---------------------------- */

  /** Tear everything down: unsubscribe net, remove listeners, dispose sub-objects. */
  dispose() {
    this.disable();
    this._unbindNet();
    safe(() => this._feed.stop());
    if (this._spectator) safe(() => this._spectator.dispose());
    // Detach player-list from its store (stop re-render subscriptions).
    safe(() => {
      if (this._playerList && typeof this._playerList.setStore === "function") this._playerList.setStore(null);
    });
    this._chat = null;
    this._net = null;
  }
}

export default SocialLayer;
