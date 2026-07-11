// ws-transport.mjs — dependency-free RFC6455 WebSocket client + server.
//
// Built on Node builtins only (node:net, node:http, node:crypto, node:tls, node:events).
// No global WebSocket, no npm deps. Target: Node 20 (CI) / Node 22 (local).
//
// This is the linchpin transport for the load/chaos harness. It is deliberately
// protocol-agnostic: it moves opaque text/binary WebSocket messages, exposes the
// raw socket + chaos hooks, and NEVER lets one misbehaving connection throw out of
// the server. All higher-level game semantics live in scripts/lib/protocol.mjs.
//
// ---- tiny self-check (RFC6455 §1.3 known-answer vector) -------------------------
//   key    = "dGhlIHNhbXBsZSBub25jZQ=="
//   accept = sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11") -> base64
//          = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
// Run `node scripts/lib/ws-transport.mjs --selftest` to assert this vector plus a
// loopback echo / fragmentation / oversized-frame round-trip.
// --------------------------------------------------------------------------------

import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

// RFC6455 magic GUID used to derive Sec-WebSocket-Accept from Sec-WebSocket-Key.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// readyState values (mirror the browser WebSocket constants).
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

// Opcodes.
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const EMPTY = Buffer.alloc(0);
const DEFAULT_MAX_PAYLOAD = 1 << 20; // 1 MiB

/**
 * Compute the Sec-WebSocket-Accept response value for a given key.
 * @param {string} key base64 Sec-WebSocket-Key sent by the client
 * @returns {string} base64 sha1(key + GUID)
 */
function acceptFor(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/**
 * Encode a single WebSocket frame.
 * @param {{fin?:boolean, opcode:number, payload:Buffer, masked:boolean}} f
 * @returns {Buffer} the on-the-wire frame
 */
function encodeFrame({ fin = true, opcode, payload, masked }) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || EMPTY);
  const len = data.length;

  let lenField;
  let extBytes;
  if (len < 126) {
    lenField = len;
    extBytes = 0;
  } else if (len < 0x10000) {
    lenField = 126;
    extBytes = 2;
  } else {
    lenField = 127;
    extBytes = 8;
  }

  const maskBytes = masked ? 4 : 0;
  const header = Buffer.allocUnsafe(2 + extBytes + maskBytes);
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  header[1] = (masked ? 0x80 : 0x00) | lenField;

  let off = 2;
  if (extBytes === 2) {
    header.writeUInt16BE(len, off);
    off += 2;
  } else if (extBytes === 8) {
    header.writeBigUInt64BE(BigInt(len), off);
    off += 8;
  }

  if (masked) {
    const maskKey = crypto.randomBytes(4);
    maskKey.copy(header, off);
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = data[i] ^ maskKey[i & 3];
    return Buffer.concat([header, out], header.length + len);
  }
  return Buffer.concat([header, data], header.length + len);
}

/**
 * A single WebSocket connection (used for both client and server endpoints).
 * Extends EventEmitter. Events: "open","message"(data,isBinary),"close"(code,reason),
 * "error"(err),"ping"(payload),"pong"(payload).
 */
class WSConn extends EventEmitter {
  /**
   * @param {net.Socket} socket underlying TCP/TLS socket (handshake already done)
   * @param {{isServer:boolean, maxPayload?:number, closeTimeoutMs?:number}} opts
   */
  constructor(socket, { isServer, maxPayload = DEFAULT_MAX_PAYLOAD, closeTimeoutMs = 5000 }) {
    super();
    this.setMaxListeners(0); // harness fans out to thousands of conns; no warnings

    this.raw = socket; // exposed for chaos tests / backpressure inspection
    this._socket = socket;
    this._isServer = !!isServer;
    this._maskOut = !isServer; // clients MUST mask; servers MUST NOT mask
    this._maxPayload = maxPayload > 0 ? maxPayload : DEFAULT_MAX_PAYLOAD;
    this._closeTimeoutMs = closeTimeoutMs;

    // receive buffer + fragmentation reassembly state
    this._buf = EMPTY;
    this._fragOpcode = null; // opcode of the in-progress fragmented message (TEXT/BIN)
    this._fragments = [];
    this._fragLen = 0;

    // lifecycle flags
    this._readyState = isServer ? OPEN : CONNECTING;
    this._sentClose = false;
    this._receivedClose = false;
    this._dead = false; // parser stopped (protocol failure / terminated)
    this._closeEmitted = false;
    this._peerCloseCode = null;
    this._peerCloseReason = '';
    this._localCloseCode = null;
    this._closeTimer = null;
    this._destroyTimer = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._onSocketError(err));
    socket.on('end', () => this._onSocketEnd());
    socket.on('close', () => this._onSocketClose());
  }

  // ---- public surface ----------------------------------------------------------

  get readyState() {
    return this._readyState;
  }

  /** Bytes queued in the OS/socket write buffer (for backpressure checks). */
  get bufferedAmount() {
    return this._socket ? this._socket.writableLength : 0;
  }

  /**
   * Send a text (string) or binary (Buffer/Uint8Array) message.
   * @returns {boolean} false if not open or the socket is backpressured/closed
   */
  send(data) {
    if (this._readyState !== OPEN) return false;
    let payload;
    let opcode;
    if (typeof data === 'string') {
      payload = Buffer.from(data, 'utf8');
      opcode = OP_TEXT;
    } else if (Buffer.isBuffer(data)) {
      payload = data;
      opcode = OP_BIN;
    } else if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
      payload = Buffer.from(data);
      opcode = OP_BIN;
    } else {
      payload = Buffer.from(String(data), 'utf8');
      opcode = OP_TEXT;
    }
    if (payload.length > this._maxPayload) return false; // do not emit oversized ourselves
    return this._write(encodeFrame({ opcode, payload, masked: this._maskOut }));
  }

  /** Send a ping control frame (payload capped at 125 bytes per RFC6455). */
  ping(buf) {
    if (this._readyState !== OPEN) return false;
    let payload = buf == null ? EMPTY : Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
    if (payload.length > 125) payload = payload.subarray(0, 125);
    return this._sendControl(OP_PING, payload);
  }

  /** Begin the closing handshake. */
  close(code = 1000, reason = '') {
    if (this._readyState === CLOSED || this._readyState === CLOSING) return;
    this._readyState = CLOSING;
    this._localCloseCode = code;
    try {
      if (!this._sentClose) {
        this._sentClose = true;
        this._writeClose(code, reason);
      }
    } catch { /* swallow — closing is best-effort */ }
    if (this._receivedClose) {
      this._endSocket();
    } else {
      // Peer may never reply; force-terminate after the close timeout.
      this._closeTimer = setTimeout(() => this.terminate(), this._closeTimeoutMs);
      if (this._closeTimer.unref) this._closeTimer.unref();
    }
  }

  /** Hard-terminate the connection immediately (no closing handshake). */
  terminate() {
    if (this._readyState === CLOSED) return;
    this._readyState = CLOSING;
    this._dead = true;
    this._clearTimers();
    try {
      this._socket.destroy();
    } catch { /* ignore */ }
    // 'close' on the socket drives _onSocketClose -> emits "close".
  }

  // ---- chaos hooks (hand-built frames / raw bytes) -----------------------------

  /**
   * Write a hand-built frame, bypassing state/maxPayload checks. For chaos tests.
   * @param {{opcode:number, payload?:Buffer|string, masked?:boolean, fin?:boolean}} f
   */
  sendRawFrame({ opcode, payload = EMPTY, masked = true, fin = true }) {
    const p = typeof payload === 'string' ? Buffer.from(payload, 'utf8')
      : Buffer.isBuffer(payload) ? payload : Buffer.from(payload || EMPTY);
    return this._write(encodeFrame({ fin, opcode, payload: p, masked }));
  }

  /** Write arbitrary bytes straight to the socket (garbage / partial handshake). */
  sendRawBytes(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    return this._write(b);
  }

  // ---- internals: writing ------------------------------------------------------

  _write(buf) {
    const s = this._socket;
    if (!s || s.destroyed || s.writableEnded) return false;
    try {
      return s.write(buf);
    } catch (err) {
      this._emitSafe('error', err);
      return false;
    }
  }

  _sendControl(opcode, payload) {
    const p = payload && payload.length ? payload : EMPTY;
    if (p.length > 125) return false; // control frames MUST be <= 125 bytes
    return this._write(encodeFrame({ opcode, payload: p, masked: this._maskOut }));
  }

  _writeClose(code, reason) {
    const rb = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
    const payload = Buffer.allocUnsafe(2 + rb.length);
    payload.writeUInt16BE(code, 0);
    rb.copy(payload, 2);
    this._write(encodeFrame({ opcode: OP_CLOSE, payload, masked: this._maskOut }));
  }

  // ---- internals: reading / framing --------------------------------------------

  _onData(chunk) {
    if (this._dead) return;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    while (!this._dead) {
      let progressed;
      try {
        progressed = this._tryParseFrame();
      } catch {
        this._failConnection(1002, 'parse error');
        return;
      }
      if (!progressed) break;
    }
  }

  /**
   * Attempt to parse exactly one frame off the front of the receive buffer.
   * Returns true if a frame was consumed (call again), false if more data is
   * needed OR a protocol failure was triggered (which sets _dead).
   *
   * maxPayload is enforced from the length header BEFORE the payload is buffered,
   * so an oversized declared length cannot cause unbounded memory growth.
   */
  _tryParseFrame() {
    const buf = this._buf;
    if (buf.length < 2) return false;

    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;

    if (rsv !== 0) {
      this._failConnection(1002, 'RSV bits set (no extension negotiated)');
      return false;
    }
    // Masking direction is mandatory and role-specific.
    if (this._isServer && !masked) {
      this._failConnection(1002, 'client frame not masked');
      return false;
    }
    if (!this._isServer && masked) {
      this._failConnection(1002, 'server frame must not be masked');
      return false;
    }

    if (len === 126) {
      if (buf.length < off + 2) return false;
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (buf.length < off + 8) return false;
      const big = buf.readBigUInt64BE(off);
      off += 8;
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this._failConnection(1009, '64-bit length too large');
        return false;
      }
      len = Number(big);
    }

    const isControl = opcode >= 0x8;
    if (isControl) {
      if (len > 125) {
        this._failConnection(1002, 'control frame payload > 125');
        return false;
      }
      if (!fin) {
        this._failConnection(1002, 'fragmented control frame');
        return false;
      }
    }

    // Single-frame cap (checked before buffering the payload).
    if (len > this._maxPayload) {
      this._failConnection(1009, 'frame exceeds maxPayload');
      return false;
    }
    // Reassembly cap: bound the total size of a fragmented message.
    if (opcode === OP_CONT && this._fragLen + len > this._maxPayload) {
      this._failConnection(1009, 'reassembled message exceeds maxPayload');
      return false;
    }

    const maskBytes = masked ? 4 : 0;
    const total = off + maskBytes + len;
    if (buf.length < total) return false; // need the rest of the payload

    let maskKey = null;
    if (masked) {
      maskKey = buf.subarray(off, off + 4);
      off += 4;
    }
    const rawPayload = buf.subarray(off, off + len);
    this._buf = buf.subarray(total); // consume

    let payload;
    if (masked) {
      payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = rawPayload[i] ^ maskKey[i & 3];
    } else {
      // Detach from the (possibly large) receive buffer so it can be freed.
      payload = Buffer.from(rawPayload);
    }

    this._handleFrame(fin, opcode, payload);
    return !this._dead;
  }

  _handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP_CONT: {
        if (this._fragOpcode == null) {
          this._failConnection(1002, 'unexpected continuation frame');
          return;
        }
        this._fragments.push(payload);
        this._fragLen += payload.length;
        if (fin) this._completeMessage();
        break;
      }
      case OP_TEXT:
      case OP_BIN: {
        if (this._fragOpcode != null) {
          this._failConnection(1002, 'new data frame during fragmentation');
          return;
        }
        if (fin) {
          this._emitMessage(opcode, payload);
        } else {
          this._fragOpcode = opcode;
          this._fragments = [payload];
          this._fragLen = payload.length;
        }
        break;
      }
      case OP_CLOSE:
        this._handleClose(payload);
        break;
      case OP_PING:
        this._emitSafe('ping', payload);
        if (!this._dead && this._readyState === OPEN && !this._sentClose) {
          try {
            this._sendControl(OP_PONG, payload);
          } catch { /* ignore */ }
        }
        break;
      case OP_PONG:
        this._emitSafe('pong', payload);
        break;
      default:
        this._failConnection(1002, `unknown opcode 0x${opcode.toString(16)}`);
    }
  }

  _completeMessage() {
    const opcode = this._fragOpcode;
    const data = this._fragments.length === 1
      ? this._fragments[0]
      : Buffer.concat(this._fragments, this._fragLen);
    this._fragOpcode = null;
    this._fragments = [];
    this._fragLen = 0;
    this._emitMessage(opcode, data);
  }

  _emitMessage(opcode, payload) {
    if (opcode === OP_BIN) {
      this._emitSafe('message', payload, true);
    } else {
      // Text frames are decoded to a string (lenient UTF-8 is fine for a harness).
      this._emitSafe('message', payload.toString('utf8'), false);
    }
  }

  _handleClose(payload) {
    let code = 1005; // "no status received"
    let reason = '';
    if (payload.length === 1) {
      this._failConnection(1002, 'invalid close payload length');
      return;
    }
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      reason = payload.subarray(2).toString('utf8');
    }
    this._receivedClose = true;
    this._peerCloseCode = code;
    this._peerCloseReason = reason;
    if (!this._sentClose) {
      this._readyState = CLOSING;
      this._sentClose = true;
      try {
        this._writeClose(code === 1005 ? 1000 : code, '');
      } catch { /* ignore */ }
    }
    this._endSocket();
  }

  // ---- internals: lifecycle ----------------------------------------------------

  /** Protocol failure: send a Close frame with `code`, then terminate. */
  _failConnection(code, reason) {
    if (this._dead) return;
    this._dead = true;
    this._localCloseCode = code;
    if (this._readyState < CLOSING) this._readyState = CLOSING;
    try {
      if (!this._sentClose) {
        this._sentClose = true;
        this._writeClose(code, reason || '');
      }
    } catch { /* ignore */ }
    this._endSocket();
  }

  _endSocket() {
    try {
      this._socket.end();
    } catch { /* ignore */ }
    // Guarantee the socket goes away even if the peer never FINs.
    if (!this._destroyTimer) {
      this._destroyTimer = setTimeout(() => {
        try {
          this._socket.destroy();
        } catch { /* ignore */ }
      }, 1000);
      if (this._destroyTimer.unref) this._destroyTimer.unref();
    }
  }

  _clearTimers() {
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
    if (this._destroyTimer) {
      clearTimeout(this._destroyTimer);
      this._destroyTimer = null;
    }
  }

  _onSocketError(err) {
    this._emitSafe('error', err);
    // A 'close' event always follows a socket 'error'; that emits our "close".
  }

  _onSocketEnd() {
    // Peer half-closed (FIN) without a WebSocket Close frame — e.g. a client
    // terminate(). After an HTTP upgrade the socket is half-open, so nothing
    // ends our writable side automatically; do it so 'close' fires and the
    // server can evict this connection (prevents leaks under reconnect storms).
    this._dead = true;
    if (!this._closeEmitted) {
      try {
        this._socket.end();
      } catch { /* ignore */ }
      // Safety net in case the writable side never flushes to 'close'.
      if (!this._destroyTimer) {
        this._destroyTimer = setTimeout(() => {
          try {
            this._socket.destroy();
          } catch { /* ignore */ }
        }, 1000);
        if (this._destroyTimer.unref) this._destroyTimer.unref();
      }
    }
  }

  _onSocketClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this._readyState = CLOSED;
    this._dead = true;
    this._clearTimers();

    let code;
    let reason;
    if (this._receivedClose) {
      code = this._peerCloseCode != null ? this._peerCloseCode : 1005;
      reason = this._peerCloseReason || '';
    } else if (this._sentClose && this._localCloseCode != null) {
      code = this._localCloseCode;
      reason = '';
    } else {
      code = 1006; // abnormal closure (no close frame exchanged)
      reason = '';
    }
    this._emitSafe('close', code, reason);
  }

  /**
   * Emit that isolates listener exceptions and avoids EventEmitter's
   * throw-on-unhandled-'error' so one bad connection can never crash the process.
   */
  _emitSafe(event, ...args) {
    if (event === 'error' && this.listenerCount('error') === 0) return;
    try {
      this.emit(event, ...args);
    } catch { /* isolate consumer/listener exceptions */ }
  }
}

/**
 * Connect to a WebSocket server and complete the RFC6455 opening handshake.
 * @param {string} url ws:// or wss:// URL
 * @param {{maxPayload?:number, headers?:Record<string,string>, handshakeTimeoutMs?:number}} opts
 * @returns {Promise<WSConn>} resolves once "open" (handshake validated)
 */
export function wsConnect(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const {
      maxPayload = DEFAULT_MAX_PAYLOAD,
      headers = {},
      handshakeTimeoutMs = 5000,
    } = opts;

    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`invalid url: ${url}`));
      return;
    }
    const isSecure = u.protocol === 'wss:';
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
      reject(new Error(`unsupported protocol: ${u.protocol}`));
      return;
    }
    const host = u.hostname;
    const port = u.port ? Number(u.port) : isSecure ? 443 : 80;
    const path = (u.pathname || '/') + (u.search || '');
    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = acceptFor(key);

    let settled = false;
    let socket;

    const timer = setTimeout(() => fail(new Error('handshake timeout')), handshakeTimeoutMs);
    if (timer.unref) timer.unref();

    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket && socket.destroy();
      } catch { /* ignore */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    }

    const onConnect = () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}${u.port ? ':' + u.port : ''}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ];
      for (const [k, v] of Object.entries(headers || {})) lines.push(`${k}: ${v}`);
      lines.push('', '');
      try {
        socket.write(lines.join('\r\n'));
      } catch (err) {
        fail(err);
      }
    };

    if (isSecure) {
      socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, onConnect);
    } else {
      socket = net.connect({ host, port }, onConnect);
    }
    socket.once('error', fail);

    let hsBuf = EMPTY;
    const onHandshakeData = (chunk) => {
      hsBuf = hsBuf.length ? Buffer.concat([hsBuf, chunk]) : chunk;
      const idx = hsBuf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (hsBuf.length > 64 * 1024) fail(new Error('handshake response headers too large'));
        return;
      }
      const headerText = hsBuf.subarray(0, idx).toString('latin1');
      const rest = hsBuf.subarray(idx + 4);
      const hlines = headerText.split('\r\n');
      const statusLine = hlines[0] || '';
      const m = /^HTTP\/1\.1\s+(\d{3})/.exec(statusLine);
      if (!m || m[1] !== '101') {
        fail(new Error(`unexpected handshake response: ${statusLine}`));
        return;
      }
      const hdrs = {};
      for (let i = 1; i < hlines.length; i++) {
        const c = hlines[i].indexOf(':');
        if (c > 0) hdrs[hlines[i].slice(0, c).trim().toLowerCase()] = hlines[i].slice(c + 1).trim();
      }
      if ((hdrs['upgrade'] || '').toLowerCase() !== 'websocket') {
        fail(new Error('handshake missing "Upgrade: websocket"'));
        return;
      }
      if ((hdrs['sec-websocket-accept'] || '') !== expectedAccept) {
        fail(new Error('bad Sec-WebSocket-Accept'));
        return;
      }

      // Success.
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onHandshakeData);
      socket.removeListener('error', fail);

      const conn = new WSConn(socket, { isServer: false, maxPayload });
      conn._readyState = OPEN;
      resolve(conn);
      conn._emitSafe('open');
      // Feed any bytes the server sent after the 101, but AFTER the caller's
      // await-continuation has attached its "message" listeners.
      if (rest.length) setImmediate(() => conn._onData(rest));
    };
    socket.on('data', onHandshakeData);
  });
}

/**
 * A dependency-free WebSocket server.
 * Extends EventEmitter. Events: "listening"(addressInfo), "connection"(conn,req), "error".
 */
class WSServer extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.setMaxListeners(0);
    const {
      port = 0,
      host = '127.0.0.1',
      path = '/',
      maxPayload = DEFAULT_MAX_PAYLOAD,
    } = opts;

    this._host = host;
    this._path = path;
    this._maxPayload = maxPayload;
    this.clients = new Set();
    this.port = null;

    this._http = http.createServer((req, res) => {
      // A plain (non-upgrade) HTTP request — answer politely, never crash.
      res.writeHead(426, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('Upgrade Required');
    });
    this._http.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
    // Malformed HTTP (garbage bytes, partial requests) lands here — just destroy.
    this._http.on('clientError', (_err, socket) => {
      try {
        socket.destroy();
      } catch { /* ignore */ }
    });
    this._http.on('error', (err) => this._emitSafe('error', err));

    this._http.listen(port, host, () => {
      const addr = this._http.address();
      this.port = addr && typeof addr === 'object' ? addr.port : port;
      this._emitSafe('listening', addr);
    });
  }

  address() {
    return { port: this.port };
  }

  close(cb) {
    for (const c of this.clients) {
      try {
        c.terminate();
      } catch { /* ignore */ }
    }
    this.clients.clear();
    try {
      this._http.close(cb);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  _emitSafe(event, ...args) {
    if (event === 'error' && this.listenerCount('error') === 0) return;
    try {
      this.emit(event, ...args);
    } catch { /* isolate listener exceptions */ }
  }

  _onUpgrade(req, socket, head) {
    // Never let a bad upgrade throw out of the server.
    try {
      socket.on('error', () => {
        try {
          socket.destroy();
        } catch { /* ignore */ }
      });

      const key = req.headers['sec-websocket-key'];
      const upgradeHdr = String(req.headers['upgrade'] || '').toLowerCase();
      const version = String(req.headers['sec-websocket-version'] || '');
      if (upgradeHdr !== 'websocket' || !key || version !== '13') {
        this._rejectUpgrade(socket, 400, 'Bad Request');
        return;
      }

      const reqPath = String(req.url || '/').split('?')[0];
      if (this._path && this._path !== '*' && reqPath !== this._path) {
        this._rejectUpgrade(socket, 404, 'Not Found');
        return;
      }

      const accept = acceptFor(key);
      const response = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n');
      try {
        socket.write(response);
      } catch {
        try {
          socket.destroy();
        } catch { /* ignore */ }
        return;
      }

      const conn = new WSConn(socket, { isServer: true, maxPayload: this._maxPayload });
      this.clients.add(conn);
      conn.on('close', () => this.clients.delete(conn));
      // Any frame bytes that arrived with the upgrade request.
      if (head && head.length) conn._onData(head);
      this._emitSafe('connection', conn, req);
    } catch {
      try {
        this._rejectUpgrade(socket, 400, 'Bad Request');
      } catch { /* ignore */ }
    }
  }

  _rejectUpgrade(socket, code, text) {
    try {
      const body = text || 'Bad Request';
      socket.write(
        `HTTP/1.1 ${code} ${text}\r\n` +
          'Connection: close\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          '\r\n' +
          body
      );
    } catch { /* ignore */ }
    try {
      socket.destroy();
    } catch { /* ignore */ }
  }
}

/**
 * Create a WebSocket server.
 * @param {{port?:number, host?:string, path?:string, maxPayload?:number}} opts
 * @returns {WSServer}
 */
export function wsCreateServer(opts = {}) {
  return new WSServer(opts);
}

export { WSConn, WSServer, CONNECTING, OPEN, CLOSING, CLOSED };

// ---- optional runnable self-check --------------------------------------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain && process.argv.includes('--selftest')) {
  const assert = (cond, msg) => {
    if (!cond) {
      console.error('SELFTEST FAIL:', msg);
      process.exit(1);
    }
  };
  // 1) RFC6455 known-answer accept vector.
  assert(acceptFor('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'accept vector');

  // 2) Loopback: echo, binary, fragmentation (via chaos hook), oversized rejection.
  const server = wsCreateServer({ port: 0, maxPayload: 1 << 16 });
  server.on('connection', (conn) => {
    conn.on('message', (data, isBinary) => conn.send(isBinary ? data : `echo:${data}`));
  });
  server.on('listening', async () => {
    const url = `ws://127.0.0.1:${server.port}/`;
    let closeCode = null;
    try {
      const c = await wsConnect(url, { maxPayload: 1 << 16 });
      const got = [];
      c.on('message', (d, bin) => got.push([d, bin]));
      c.on('close', (code) => { closeCode = code; });

      c.send('hello');
      c.send(Buffer.from([1, 2, 3]));
      // Two-part fragmented text message "ab" using raw frames (client must mask).
      c.sendRawFrame({ opcode: OP_TEXT, payload: 'a', fin: false, masked: true });
      c.sendRawFrame({ opcode: OP_CONT, payload: 'b', fin: true, masked: true });

      await new Promise((r) => setTimeout(r, 120));
      assert(got.some(([d, bin]) => !bin && d === 'echo:hello'), 'text echo');
      assert(got.some(([d, bin]) => bin && Buffer.isBuffer(d) && d.length === 3), 'binary echo');
      assert(got.some(([d, bin]) => !bin && d === 'echo:ab'), 'fragment reassembly');

      // Oversized frame -> server closes with 1009.
      const big = Buffer.alloc((1 << 16) + 100, 0x61);
      c.sendRawFrame({ opcode: OP_TEXT, payload: big, masked: true });
      await new Promise((r) => setTimeout(r, 150));
      assert(closeCode === 1009, `oversized -> close 1009 (got ${closeCode})`);

      server.close(() => {
        console.log('SELFTEST OK');
        process.exit(0);
      });
    } catch (err) {
      console.error('SELFTEST ERROR:', err);
      process.exit(1);
    }
  });
}
