#!/usr/bin/env node
// ============================================================================
// mobs/serve.mjs
//
// Tiny, dependency-free static file server for local demo/testing of the
// Loomfall mobs package (mobs/demo.html and friends). Rooted at the repo
// root (/home/user/MinecraftV2) so absolute-from-repo-root paths like
// /mobs/vendor/three.module.js resolve correctly regardless of where the
// server process is launched from.
//
// Usage:
//   node mobs/serve.mjs [port]
//   PORT=8130 node mobs/serve.mjs
//
// Then open:
//   http://localhost:8130/mobs/demo.html
//   http://localhost:8130/mobs/demo.html?mob=grazer
// ============================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo root is the parent of mobs/ (this file lives at <repo>/mobs/serve.mjs).
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 8130;

const MIME_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function safeJoin(root, urlPath) {
  // Strip query string / hash, decode, and normalize so ".." segments can't
  // escape ROOT.
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const normalized = path.normalize(path.join(root, decoded));
  if (!normalized.startsWith(root)) return null; // path traversal attempt
  return normalized;
}

const server = http.createServer((req, res) => {
  let filePath = safeJoin(ROOT, req.url || '/');
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  if (filePath.endsWith(path.sep)) {
    filePath = path.join(filePath, 'index.html');
  }

  fs.stat(filePath, (err, stats) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 Not Found: ${req.url}`);
      return;
    }

    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`404 Not Found: ${req.url}`);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        // Loosen CORS for local dev convenience (module fetches, etc).
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log(`Loomfall mobs demo server running at http://localhost:${PORT}/`);
  console.log(`  -> http://localhost:${PORT}/mobs/demo.html`);
  console.log(`  -> http://localhost:${PORT}/mobs/demo.html?mob=grazer`);
  console.log(`Serving from repo root: ${ROOT}`);
});
