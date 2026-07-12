// Voxelheim client networking (pure module — no three, no DOM beyond WebSocket).
//
// Wraps the /ws JSON protocol documented in docs/PROTOCOL.md.
// Works in the browser and in modern Node (>=22) via the global WebSocket.

const MOVE_INTERVAL_MS = 50; // 20 Hz outgoing move cap (latest-wins)
const WELCOME_TIMEOUT_MS = 10000;

export class NetClient {
  constructor() {
    this.ws = null;
    this.selfId = null;
    this.world = null; // { id, name, seed, createdAt, edits } from welcome
    this.connected = false;

    this._dim = 'overworld';
    this._queue = []; // raw JSON strings buffered until the socket opens
    this._pendingMove = null; // latest un-flushed move (latest-wins)
    this._lastPos = null; // last position handed to sendMove
    this._moveTimer = null;
    this._lastMoveSentAt = 0;
    this._intentionalClose = false;

    // Single callback per event; registering again replaces the previous one.
    this._cb = {
      state: null, peerJoin: null, peerLeave: null, peerMove: null,
      edit: null, editReject: null, chat: null, disconnect: null,
      emote: null, whisper: null, presence: null,
    };
  }

  /**
   * Open the socket, send `join`, and resolve with the welcome payload
   * ({ id, world, peers }) once the server accepts us.
   * `url` may be a ws(s):// endpoint (with or without /ws) or an http(s)
   * origin — it is normalized to ws(s)://host/ws.
   * `skin` (optional) is the compact encoded skin-descriptor string
   * (docs/PROTOCOL.md §4 join.skin, <=128 chars, [a-z0-9.]); the server
   * echoes it on welcome.peers / peer-join so peers render this look.
   */
  connect(url, worldId, name, dim = 'overworld', skin = '') {
    this._dim = dim || 'overworld';
    this._skin = typeof skin === 'string' ? skin.slice(0, 128) : '';
    this._intentionalClose = false;
    const wsUrl = normalizeWsUrl(url);

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const timer = setTimeout(
        () => fail(new Error('timed out waiting for welcome')), WELCOME_TIMEOUT_MS);

      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        return fail(err);
      }
      this.ws = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          t: 'join', worldId, name, dim: this._dim,
          ...(this._skin ? { skin: this._skin } : {}),
        }));
        // Flush anything queued before the socket opened (after the join).
        for (const raw of this._queue.splice(0)) ws.send(raw);
      };

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
        } catch {
          return;
        }
        if (!msg || typeof msg.t !== 'string') return;

        if (msg.t === 'welcome' && !settled) {
          settled = true;
          clearTimeout(timer);
          this.selfId = msg.id;
          this.world = msg.world;
          this.connected = true;
          if (this._cb.state) this._cb.state(msg);
          resolve(msg);
          return;
        }
        this._dispatch(msg);
      };

      ws.onerror = () => {
        fail(new Error(`websocket error connecting to ${wsUrl}`));
      };

      ws.onclose = (event) => {
        this.connected = false;
        if (this._moveTimer) { clearTimeout(this._moveTimer); this._moveTimer = null; }
        fail(new Error('socket closed before welcome'));
        if (this._cb.disconnect) {
          this._cb.disconnect({
            code: event && event.code,
            reason: (event && event.reason) || '',
            intentional: this._intentionalClose,
          });
        }
      };
    });
  }

  _dispatch(msg) {
    switch (msg.t) {
      case 'peer-join': if (this._cb.peerJoin) this._cb.peerJoin(msg); break;
      case 'peer-leave': if (this._cb.peerLeave) this._cb.peerLeave(msg); break;
      case 'move': if (this._cb.peerMove) this._cb.peerMove(msg); break;
      case 'edit': if (this._cb.edit) this._cb.edit(msg); break;
      case 'editReject': if (this._cb.editReject) this._cb.editReject(msg); break;
      case 'chat': if (this._cb.chat) this._cb.chat(msg); break;
      case 'emote': if (this._cb.emote) this._cb.emote(msg); break;
      case 'whisper': if (this._cb.whisper) this._cb.whisper(msg); break;
      case 'presence': if (this._cb.presence) this._cb.presence(msg); break;
      case 'error': console.warn('[net] server error:', msg.code, msg.message); break;
      default: break;
    }
  }

  // --- callback registration (each replaces the previous handler) ----------
  onState(cb) { this._cb.state = cb; return this; }
  onPeerJoin(cb) { this._cb.peerJoin = cb; return this; }
  onPeerLeave(cb) { this._cb.peerLeave = cb; return this; }
  onPeerMove(cb) { this._cb.peerMove = cb; return this; }
  onEdit(cb) { this._cb.edit = cb; return this; }
  /** Server rejected one of OUR edits: {x,y,z,block,dim,reason}. `block` is
   * the authoritative block at the cell (stored edit), or -1 meaning
   * "generated terrain — restore from the local deterministic generator". */
  onEditReject(cb) { this._cb.editReject = cb; return this; }
  onChat(cb) { this._cb.chat = cb; return this; }
  /** A peer played an emote: {id, emote} (same world + dimension only). */
  onEmote(cb) { this._cb.emote = cb; return this; }
  /** A directed whisper arrived: {from, text} — or our own echo {echo:true, to, text}. */
  onWhisper(cb) { this._cb.whisper = cb; return this; }
  /** Roster snapshot: {players: [{id, name, dim, ping?}]} on join/leave. */
  onPresence(cb) { this._cb.presence = cb; return this; }
  onDisconnect(cb) { this._cb.disconnect = cb; return this; }

  // --- outgoing -------------------------------------------------------------

  /**
   * Queue a movement update. Throttled to 20 Hz: calls within the 50 ms
   * window overwrite the pending frame (latest wins). `pos` is anything with
   * x/y/z (plain object or THREE.Vector3).
   */
  sendMove(pos, yaw = 0, pitch = 0) {
    this._lastPos = { x: pos.x, y: pos.y, z: pos.z, yaw, pitch };
    this._pendingMove = this._lastPos;
    this._scheduleMoveFlush();
  }

  /** Change dimension; folds into the next move. If we already know our
   * position, a move is scheduled right away so peers learn of the switch. */
  setDimension(dim) {
    this._dim = dim;
    if (this._lastPos) {
      this._pendingMove = this._lastPos;
      this._scheduleMoveFlush();
    }
  }

  /** Announce a respawn (immediate). The server only accepts the following
   * teleport-sized move if it lands at the spawn anchor (PROTOCOL.md §4), so
   * call this whenever the local player re-stitches at their spawn point. */
  sendRespawn() {
    this._send({ t: 'respawn' });
  }

  /** Immediate block edit in the current dimension. */
  sendEdit(x, y, z, blockId) {
    this._send({ t: 'edit', x, y, z, block: blockId, dim: this._dim });
  }

  sendChat(text) {
    const t = String(text ?? '').trim();
    if (!t) return;
    this._send({ t: 'chat', text: t.slice(0, 256) });
  }

  /** Play an emote for same-dimension peers (server rate-caps at 2/s). */
  sendEmote(emote) {
    const id = String(emote ?? '').trim().slice(0, 16);
    if (!id) return;
    this._send({ t: 'emote', emote: id });
  }

  /** Directed whisper to a player NAME (server delivers to the target only,
   * plus an {echo:true} copy back to us; rate-limited like chat). */
  sendWhisper(to, text) {
    const name = String(to ?? '').trim().slice(0, 24);
    const t = String(text ?? '').trim();
    if (!name || !t) return;
    this._send({ t: 'whisper', to: name, text: t.slice(0, 256) });
  }

  _scheduleMoveFlush() {
    if (this._moveTimer) return; // a flush is already scheduled; it sends the latest
    const wait = Math.max(0, MOVE_INTERVAL_MS - (Date.now() - this._lastMoveSentAt));
    this._moveTimer = setTimeout(() => {
      this._moveTimer = null;
      this._flushMove();
    }, wait);
  }

  _flushMove() {
    if (!this._pendingMove) return;
    const m = this._pendingMove;
    this._pendingMove = null;
    this._lastMoveSentAt = Date.now();
    this._send({ t: 'move', x: m.x, y: m.y, z: m.z, yaw: m.yaw, pitch: m.pitch, dim: this._dim });
  }

  /** Send now if the socket is open; otherwise queue until it opens. */
  _send(obj) {
    const raw = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(raw);
    } else {
      this._queue.push(raw);
    }
  }

  close() {
    this._intentionalClose = true;
    if (this._moveTimer) { clearTimeout(this._moveTimer); this._moveTimer = null; }
    this._pendingMove = null;
    this._queue.length = 0;
    if (this.ws) this.ws.close();
    this.connected = false;
  }
}

/** Normalize an http(s) origin or ws(s) URL to a ws(s)://host/ws endpoint. */
function normalizeWsUrl(url) {
  let u = String(url || '');
  if (u.startsWith('https://')) u = 'wss://' + u.slice(8);
  else if (u.startsWith('http://')) u = 'ws://' + u.slice(7);
  if (!u.startsWith('ws://') && !u.startsWith('wss://')) u = 'ws://' + u;
  // Append the /ws path if the URL is just an origin.
  const pathStart = u.indexOf('/', u.indexOf('://') + 3);
  if (pathStart === -1) return u + '/ws';
  if (u.slice(pathStart).replace(/\/+$/, '') === '') return u.slice(0, pathStart) + '/ws';
  return u;
}
