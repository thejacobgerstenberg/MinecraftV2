// Voxelheim server (foundation phase).
//
// Serves the static client from public/ and hosts a WebSocket endpoint at /ws.
// Right now the socket only logs connections and acks `join` messages; the
// multiplayer phase expands this into world rooms + REST world persistence.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

// Health check.
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Static client.
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);

// WebSocket server sharing the HTTP server, mounted at /ws.
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const addr = req.socket.remoteAddress;
  console.log(`[ws] client connected from ${addr}`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.warn('[ws] received non-JSON message, ignoring');
      return;
    }

    // Foundation stub: ack joins, echo everything else.
    if (msg.t === 'join') {
      console.log(`[ws] join: world=${msg.worldId} name=${msg.name}`);
      ws.send(JSON.stringify({ t: 'welcome', id: Date.now(), peers: [] }));
    } else {
      ws.send(JSON.stringify({ t: 'ack', echo: msg }));
    }
  });

  ws.on('close', () => {
    console.log(`[ws] client disconnected (${addr})`);
  });

  ws.on('error', (err) => {
    console.warn('[ws] socket error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`Voxelheim server listening on http://localhost:${PORT}`);
  console.log(`  WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
