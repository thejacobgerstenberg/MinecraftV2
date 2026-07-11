// audio-integrate/server.mjs
// Minimal dependency-free static file server for the demo + verification.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = "/home/user/MinecraftV2";
const PORT = process.env.PORT || 8130;
const TYPES = { ".js": "application/javascript", ".mjs": "application/javascript", ".html": "text/html", ".css": "text/css", ".json": "application/json" };

createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/audio-integrate/demo.html";
  const filePath = normalize(join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": TYPES[extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(PORT, () => console.log(`Audio demo server running at http://localhost:${PORT}/`));
