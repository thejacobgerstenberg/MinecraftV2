#!/usr/bin/env node
// Loomfall status sidecar — optional tiny static server + same-origin /api/* proxy.
//
// Serves deploy/status/index.html and, when GAME_URL is set, proxies GET /api/*
// to the game host so the status page can read a REMOTE game without CORS
// (the page fetches its own origin; this server forwards to the game).
//
// Zero dependencies. Node 18+ (uses global fetch for the proxy).
//
//   node deploy/status/server.mjs
//
// Env:
//   STATUS_PORT   port to listen on            (default 8080)
//   GAME_URL      upstream game base URL to proxy /api/* to (e.g. http://localhost:3000)
//                 if unset, /api/* returns 502 and the page must be given ?target=
//
// This file lives ENTIRELY under deploy/ and does not touch the game server.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.STATUS_PORT) || 8080;
const GAME_URL = (process.env.GAME_URL || "").replace(/\/+$/, "");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

function extOf(p) {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i).toLowerCase();
}

// Forward a GET /api/* request to the upstream game host.
async function proxyApi(req, res, pathAndQuery) {
  if (!GAME_URL) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: "proxy disabled: set GAME_URL, or open the page with ?target=<game-url>",
    }));
    return;
  }
  const upstream = GAME_URL + pathAndQuery;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(upstream, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(to));
    const body = await r.text();
    res.writeHead(r.status, {
      "content-type": r.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `upstream fetch failed: ${err.message}` }));
  }
}

// Serve a static file from this directory (path traversal guarded).
async function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  // Normalize and confine to __dirname.
  const full = normalize(join(__dirname, rel));
  if (!full.startsWith(__dirname)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await readFile(full);
    res.writeHead(200, {
      "content-type": MIME[extOf(full)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  const method = req.method || "GET";
  const url = req.url || "/";

  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end("method not allowed");
    return;
  }
  // Same-origin proxy for the game's REST API.
  if (url === "/api" || url.startsWith("/api/")) {
    await proxyApi(req, res, url);
    return;
  }
  await serveStatic(res, url);
});

server.listen(PORT, () => {
  console.log(`[status] listening on http://localhost:${PORT}`);
  console.log(`[status] proxy /api/* -> ${GAME_URL || "(disabled — set GAME_URL or use ?target=)"}`);
});
