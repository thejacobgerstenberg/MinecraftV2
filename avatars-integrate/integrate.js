// avatars-integrate/integrate.js
// =============================================================================
// PlayerStack — a single turnkey facade that collapses the whole
// player / multiplayer-presence stack into one drop-in for the builder:
//
//     avatars-plus (PeerAvatarsPlus + ThirdPersonCamera + skins/emotes)
//   + social       (SocialLayer: presence store, whisper, player list, feed,
//                   spectator camera)
//
// into a single object with one constructor, one setNet(), one update(dt),
// and one dispose(). The builder wires its real NetClient, scene, camera and
// chat into it once and gets remote-avatar rendering, nameplates, a player
// list, whisper filtering, third-person camera and emote hooks — all fanned
// out from the facade.
//
// -----------------------------------------------------------------------------
// WHY THE FACADE IS THE *SINGLE NET OWNER*
// -----------------------------------------------------------------------------
// The builder's NetClient uses SINGLE-SLOT callbacks: calling onPeerJoin(cb)
// (or onPeerLeave / onPeerMove / onState / onChat / onDisconnect) REPLACES any
// previously-registered callback rather than adding a second listener. That
// means two independent consumers (the avatar renderer AND the social presence
// store) cannot each bind the net directly — the second registration would
// silently clobber the first.
//
// PlayerStack solves this by being the ONE AND ONLY owner of the net
// callbacks. In setNet() it registers a single callback per net event, and
// each of those callbacks fans the event out to BOTH:
//   - rendering  -> this.peers  (PeerAvatarsPlus)
//   - presence   -> this.social.presence / whisper / feed  (SocialLayer)
//
// Consequently SocialLayer is constructed WITHOUT a net (net:undefined) so it
// does NOT bind the net itself — the facade drives social.presence.* directly.
//
// ADOPTION NOTE FOR THE BUILDER: when adopting PlayerStack, the builder should
// REMOVE its own onPeerJoin / onPeerLeave / onPeerMove / onChat (and, if it
// forwards them, onState / onDisconnect) bindings. PlayerStack.setNet() takes
// them over. Anything the builder still needs from those events should be read
// from PlayerStack's getters (presence, peersManager, ...) or added as a
// follow-up hook, NOT by re-binding the net (which would clobber the facade).
//
// -----------------------------------------------------------------------------
// EMOTE PATH (needs a small builder-side NetClient addition)
// -----------------------------------------------------------------------------
// The current NetClient does NOT have sendEmote/onEmote. Emotes therefore ride
// on two facade hooks that the builder wires once the NetClient gains support
// (see INTEGRATION.md):
//   OUTGOING: PlayerStack.emote(id) plays locally and calls the transport
//             registered via onEmoteTransport(fn) or opts.sendEmote
//             (fn === net.sendEmote once the builder adds it).
//   INCOMING: the builder calls PlayerStack.receivePeerEmote(id, emoteId) from
//             net.onEmote(...) once that dispatch case exists.
// Required NetClient additions (documented in INTEGRATION.md):
//   * sendEmote(emoteId)                        // outgoing wire frame
//   * an 'emote' case in the message dispatch   // {type:'emote', id, emoteId}
//   * onEmote(cb)                               // incoming single-slot callback
//
// -----------------------------------------------------------------------------
// SKIN ON JOIN
// -----------------------------------------------------------------------------
// Remote peer skins flow through as-is: setNet's upsert passes the raw net
// message to PeerAvatarsPlus, so a msg.descriptor (object) or msg.skin
// (encoded string, decoded here) renders the peer once the server relays it.
// For the LOCAL player, setLocalSkin(descriptorOrEncoded) returns the compact
// encoded string the builder must attach to the NetClient JOIN frame so other
// clients can render this player. (Builder-side: add that string to the join
// payload — see INTEGRATION.md.)
//
// -----------------------------------------------------------------------------
// THREE.JS VERSION GAP
// -----------------------------------------------------------------------------
// These packages pin three r160 (see each package's vendor/ + importmap),
// while the builder's importmap ships three r185. The APIs PlayerStack and its
// dependencies use (Scene/Group/Vector3/PerspectiveCamera basics, rotation
// order "YXZ") are stable across that range, so the mismatch is benign in
// practice — but keep both importmaps resolving "three" to a SINGLE instance to
// avoid duplicate-module `instanceof` breakage. See FINDINGS for detail.
// =============================================================================

import { PeerAvatarsPlus } from "../avatars-plus/peer-avatars-plus.js";
import { SocialLayer } from "../social/social.js";
import { ThirdPersonCamera } from "../avatars-plus/camera.js";
import {
  encodeDescriptor,
  decodeDescriptor,
  normalizeDescriptor,
} from "../avatars-plus/skin-descriptor.js";
import { CharacterCustomizer } from "../avatars-plus/customizer.js";

/** Run fn, swallow any throw, return fallback. Nothing in this facade throws. */
function safe(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

/**
 * Coerce a descriptor-or-encoded-string into a normalized descriptor object.
 * Accepts: an encoded string (decoded), a descriptor object (normalized),
 * or null/undefined (-> null). Never throws.
 * @param {object|string|null|undefined} v
 * @returns {object|null}
 */
function toDescriptor(v) {
  if (v == null) return null;
  if (typeof v === "string") {
    return safe(() => normalizeDescriptor(decodeDescriptor(v)), null);
  }
  if (typeof v === "object") {
    return safe(() => normalizeDescriptor(v), null);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* PlayerStack                                                                */
/* -------------------------------------------------------------------------- */

export class PlayerStack {
  /**
   * @param {object} [opts]
   * @param {object} [opts.net]        real NetClient (need not be connected yet)
   * @param {object} opts.scene        THREE.Scene remote avatars are added to
   * @param {object} opts.camera       THREE.Camera driven by the 3rd-person rig
   * @param {object} [opts.chat]       initChat()-style { addMessage, open, close, isOpen }
   * @param {object} [opts.world]      builder world (with getBlock) — for isSolid
   * @param {Function} [opts.getBlockDef] builder block-def lookup — for isSolid
   * @param {Function} [opts.isSolid]  explicit (x,y,z)=>bool (overridden by world+getBlockDef)
   * @param {HTMLElement} [opts.mount] mount for social overlays (player list, toasts)
   * @param {string} [opts.localName]  local player's display name (default 'Player')
   * @param {object|string} [opts.localSkin] local descriptor or encoded string
   * @param {Function} [opts.getLocalDim]  ()=>dim for dimension filtering
   * @param {Function} [opts.getLocalFeet] ()=>({x,y,z}) local feet position (camera)
   * @param {Function} [opts.getLocalLook] ()=>({yaw,pitch}) local look (camera)
   * @param {string} [opts.tabKey]     hold-to-show player-list key (default 'Tab')
   * @param {Function} [opts.sendEmote] outgoing emote transport fn(emoteId)
   * @param {HTMLElement} [opts.customizerMount] mount for the optional customizer
   * @param {HTMLCanvasElement} [opts.previewCanvas] preview canvas for the customizer
   */
  constructor(opts = {}) {
    const o = opts && typeof opts === "object" ? opts : {};
    this.opts = o;

    this.scene = o.scene || null;
    this.camera = o.camera || null;
    this.chat = o.chat || null;

    this._localName = typeof o.localName === "string" && o.localName ? o.localName : "Player";
    this._getLocalDim = typeof o.getLocalDim === "function" ? o.getLocalDim : null;
    this._getLocalFeet = typeof o.getLocalFeet === "function" ? o.getLocalFeet : null;
    this._getLocalLook = typeof o.getLocalLook === "function" ? o.getLocalLook : null;

    // --- resolve isSolid (exact builder physics formula) ------------------
    // Priority: world + getBlockDef (builder formula) > explicit isSolid > false.
    if (o.world && typeof o.getBlockDef === "function" &&
        o.world && typeof o.world.getBlock === "function") {
      const world = o.world;
      const getBlockDef = o.getBlockDef;
      this.isSolid = (x, y, z) =>
        safe(() => {
          const def = getBlockDef(world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
          return !!(def && def.solid);
        }, false);
    } else if (typeof o.isSolid === "function") {
      this.isSolid = o.isSolid;
    } else {
      this.isSolid = () => false;
    }

    // --- remote-avatar renderer ------------------------------------------
    this.peers = new PeerAvatarsPlus(this.scene);

    // --- social layer (NET-LESS: facade is the single net owner) ----------
    // Pass net:undefined so SocialLayer does NOT bind the net; the facade
    // drives social.presence.* directly to avoid the single-slot clash.
    this.social = new SocialLayer({
      net: undefined,
      chat: o.chat,
      camera: this.camera,
      isSolid: this.isSolid,
      mount: o.mount,
      selfName: this._localName,
      localSkin: o.localSkin != null ? o.localSkin : null,
      tabKey: typeof o.tabKey === "string" && o.tabKey ? o.tabKey : "Tab",
      canvas: o.canvas,
    });
    safe(() => this.social.enable());

    // --- third-person camera rig -----------------------------------------
    this.tpCamera = new ThirdPersonCamera(this.camera, { isSolid: this.isSolid });

    // --- optional character customizer -----------------------------------
    this.customizer = null;
    if (o.customizerMount || o.previewCanvas) {
      this.customizer = safe(
        () =>
          new CharacterCustomizer({
            mount: o.customizerMount,
            previewCanvas: o.previewCanvas,
            descriptor: toDescriptor(o.localSkin) || undefined,
            onChange: (desc) => this.setLocalSkin(desc),
          }),
        null
      );
    }

    // --- net ownership bookkeeping ---------------------------------------
    this.net = null;
    /** @type {object|null} the callbacks THIS facade installed on the net. */
    this._netCbs = null;

    // --- emote transport -------------------------------------------------
    this._sendEmote = typeof o.sendEmote === "function" ? o.sendEmote : null;

    // --- local avatar handle (builder-managed; hidden in first-person) ----
    this._localAvatar = null;

    if (o.net) this.setNet(o.net);
  }

  /** Convenience constructor. */
  static init(opts = {}) {
    return new PlayerStack(opts);
  }

  /* --------------------------- internal helpers ------------------------- */

  /**
   * Resolve the local player's active dimension for peer visibility filtering.
   * Defensive: getLocalDim override, else the net's world dimension, else
   * 'overworld'. Never throws.
   * @returns {*}
   */
  _dim() {
    return safe(() => {
      if (this._getLocalDim) {
        const d = this._getLocalDim();
        if (d != null) return d;
      }
      const w = this.net && this.net.world;
      if (w != null) {
        if (typeof w === "object") {
          if (w.dim != null) return w.dim;
          if (w.dimension != null) return w.dimension;
        } else {
          return w;
        }
      }
      return "overworld";
    }, "overworld");
  }

  /**
   * Normalize a raw net peer message so any encoded skin STRING is turned into
   * a descriptor object before handing it to PeerAvatarsPlus (which expects a
   * `descriptor` object). A msg.descriptor object is passed through untouched.
   * @param {object} msg
   * @returns {object}
   */
  _peerMsg(msg) {
    if (!msg || typeof msg !== "object") return msg;
    // Already carries a descriptor object -> pass through as-is.
    if (msg.descriptor && typeof msg.descriptor === "object") return msg;
    // Carries an encoded skin STRING -> decode into a descriptor.
    const enc = typeof msg.skin === "string" ? msg.skin : (typeof msg.descriptor === "string" ? msg.descriptor : null);
    if (enc) {
      const d = toDescriptor(enc);
      if (d) return { ...msg, descriptor: d };
    }
    return msg;
  }

  /* ------------------------------ net owner ----------------------------- */

  /**
   * Become THE single owner of the NetClient's single-slot callbacks. Binds
   * one callback per event; each fans out to BOTH rendering (this.peers) and
   * presence (this.social.presence / whisper / feed).
   *
   * The builder MUST remove its own onPeerJoin/Leave/Move/onChat (and onState/
   * onDisconnect if it forwards them) bindings when adopting PlayerStack — this
   * takes them over (single-slot: re-binding clobbers). Never throws.
   *
   * @param {object} net a real NetClient instance.
   * @returns {this}
   */
  setNet(net) {
    if (!net) return this;
    this.net = net;
    // NOTE: the facade owns the net; SocialLayer is intentionally left net-less.

    // Build our fan-out callbacks (kept for dispose()).
    const onState = (w) => safe(() => {
      const welcome = w || {};
      this.social.presence.ingestWelcome(welcome);
      const list = Array.isArray(welcome.peers) ? welcome.peers : [];
      for (const p of list) this.peers.upsert(this._peerMsg(p));
      this.peers.setDimension(this._dim());
    });

    const onPeerJoin = (m) => safe(() => {
      this.peers.upsert(this._peerMsg(m));
      this.peers.setDimension(this._dim());
      this.social.presence.upsertPeer(m);
    });

    const onPeerLeave = (m) => safe(() => {
      const id = m && m.id != null ? m.id : m;
      this.peers.remove(id);
      this.social.presence.removePeer(id);
    });

    const onPeerMove = (m) => safe(() => {
      this.peers.move(m);
      this.social.presence.updateMove(m);
    });

    const onChat = (m) => safe(() => {
      if (this.social.whisper.filterPublicChat(m)) {
        this.chat && this.chat.addMessage && this.chat.addMessage({ name: m.name, text: m.text });
      }
    });

    const onDisconnect = () => safe(() => {
      this.social.feed && this.social.feed.note && this.social.feed.note("warn", "Disconnected");
    });

    this._netCbs = { onState, onPeerJoin, onPeerLeave, onPeerMove, onChat, onDisconnect };

    safe(() => net.onState && net.onState(onState));
    safe(() => net.onPeerJoin && net.onPeerJoin(onPeerJoin));
    safe(() => net.onPeerLeave && net.onPeerLeave(onPeerLeave));
    safe(() => net.onPeerMove && net.onPeerMove(onPeerMove));
    safe(() => net.onChat && net.onChat(onChat));
    safe(() => net.onDisconnect && net.onDisconnect(onDisconnect));

    return this;
  }

  /* ------------------------------- skins -------------------------------- */

  /**
   * Set the LOCAL player's skin. Normalizes/decodes the input, updates the
   * presence store (so the local player-list row reflects it) and the live
   * customizer preview if present, and RETURNS the compact encoded string the
   * builder should attach to the NetClient JOIN frame so peers can render it.
   *
   * Builder-side: add the returned string to the join payload (INTEGRATION.md).
   *
   * @param {object|string} descriptorOrEncoded
   * @returns {string} encoded descriptor for the join frame (empty string on failure)
   */
  setLocalSkin(descriptorOrEncoded) {
    const desc = toDescriptor(descriptorOrEncoded);
    if (!desc) return "";
    safe(() => this.social.presence.setLocalSkin(desc));
    if (this.customizer) safe(() => this.customizer.setDescriptor(desc));
    return safe(() => encodeDescriptor(desc), "");
  }

  /* ------------------------------- emotes ------------------------------- */

  /**
   * LOCAL emote trigger + broadcast hook. Plays the emote on the local avatar
   * if one is managed, then forwards to the registered transport (opts.sendEmote
   * or onEmoteTransport). Broadcast requires the builder-side NetClient
   * sendEmote addition (INTEGRATION.md). Never throws.
   * @param {string|number} id emote id.
   */
  emote(id) {
    safe(() => {
      if (this._localAvatar && typeof this._localAvatar.playEmote === "function") {
        this._localAvatar.playEmote(id);
      }
    });
    if (typeof this._sendEmote === "function") safe(() => this._sendEmote(id));
  }

  /**
   * Register the builder's outgoing emote transport (net.sendEmote-style).
   * @param {(id:string|number)=>void} fn
   * @returns {this}
   */
  onEmoteTransport(fn) {
    this._sendEmote = typeof fn === "function" ? fn : null;
    return this;
  }

  /**
   * INCOMING peer-emote entry point. The builder calls this from net.onEmote
   * (once the NetClient 'emote' dispatch case + onEmote callback exist —
   * INTEGRATION.md). Plays the emote on the remote peer's avatar. Never throws.
   * @param {string} id peer id.
   * @param {string|number} emoteId emote id.
   */
  receivePeerEmote(id, emoteId) {
    safe(() => this.peers.receiveEmote(id, emoteId));
  }

  /* ------------------------------- camera ------------------------------- */

  /**
   * Register the builder's local-avatar handle so first-person can hide it.
   * @param {object|null} avatar an object with .visible / .setVisible / .group.
   * @returns {this}
   */
  setLocalAvatar(avatar) {
    this._localAvatar = avatar || null;
    this._applyLocalAvatarVisibility();
    return this;
  }

  /** @private Sync local-avatar visibility to the current view mode. */
  _applyLocalAvatarVisibility() {
    const a = this._localAvatar;
    if (!a) return;
    const show = safe(() => this.tpCamera.shouldShowLocalAvatar(), true);
    safe(() => {
      if (typeof a.setVisible === "function") a.setVisible(show);
      else if (a.group && "visible" in a.group) a.group.visible = show;
      else if ("visible" in a) a.visible = show;
    });
  }

  /**
   * Set the third-person view mode ("first" | "third-back" | "third-front").
   * @param {string} mode
   * @returns {this}
   */
  setViewMode(mode) {
    safe(() => this.tpCamera.setViewMode(mode));
    this._applyLocalAvatarVisibility();
    return this;
  }

  /** Cycle first -> third-back -> third-front -> first. @returns {this} */
  cycleViewMode() {
    safe(() => this.tpCamera.cycleViewMode());
    this._applyLocalAvatarVisibility();
    return this;
  }

  /* ------------------------------- misc --------------------------------- */

  /**
   * Passthrough to social.setPing (for a future ping source). Default pings are
   * null and render as "—".
   * @param {string} id peer id.
   * @param {number|null} ms round-trip ms.
   * @returns {this}
   */
  setPing(id, ms) {
    safe(() => this.social.setPing(id, ms));
    return this;
  }

  /* ------------------------------ per-frame ----------------------------- */

  /**
   * Per-frame update. Advances peer avatars, the social layer, and (when local
   * feet + look are available) the third-person camera. Never throws.
   * @param {number} dt seconds since last frame.
   */
  update(dt) {
    safe(() => this.peers.update(dt));
    safe(() => this.social.update(dt));
    if (this._getLocalFeet && this._getLocalLook) {
      safe(() => {
        const feet = this._getLocalFeet();
        const look = this._getLocalLook() || {};
        this.tpCamera.update(dt, feet, look.yaw, look.pitch);
      });
    }
  }

  /* ------------------------------ accessors ----------------------------- */

  /** @returns {object} SocialLayer presence store. */
  get presence() {
    return this.social ? this.social.presence : null;
  }
  /** @returns {object} SocialLayer whisper controller. */
  get whisper() {
    return this.social ? this.social.whisper : null;
  }
  /** @returns {object|null} SocialLayer spectator camera. */
  get spectator() {
    return this.social ? this.social.spectator : null;
  }
  /** @returns {PeerAvatarsPlus} remote-avatar manager. */
  get peersManager() {
    return this.peers;
  }
  /** @returns {ThirdPersonCamera} the 3rd-person camera rig. */
  get thirdPersonCamera() {
    return this.tpCamera;
  }

  /* ------------------------------- dispose ------------------------------ */

  /**
   * Tear down: null out the callbacks we installed on the net (we do NOT
   * restore any prior builder callback — the builder removes its own bindings
   * when adopting PlayerStack), then dispose peers / social / camera /
   * customizer. Idempotent and never throws.
   */
  dispose() {
    // Detach our net callbacks by re-registering no-ops (single-slot: this
    // frees our closures without resurrecting a prior binding).
    if (this.net && this._netCbs) {
      const noop = () => {};
      safe(() => this.net.onState && this.net.onState(noop));
      safe(() => this.net.onPeerJoin && this.net.onPeerJoin(noop));
      safe(() => this.net.onPeerLeave && this.net.onPeerLeave(noop));
      safe(() => this.net.onPeerMove && this.net.onPeerMove(noop));
      safe(() => this.net.onChat && this.net.onChat(noop));
      safe(() => this.net.onDisconnect && this.net.onDisconnect(noop));
    }
    this._netCbs = null;
    this.net = null;
    this._sendEmote = null;
    this._localAvatar = null;

    safe(() => this.peers && this.peers.dispose());
    safe(() => this.social && this.social.dispose());
    safe(() => this.customizer && this.customizer.dispose && this.customizer.dispose());
    // ThirdPersonCamera holds no external resources; drop the reference.
    this.tpCamera = null;
  }
}

export default PlayerStack;
