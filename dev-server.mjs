// Local test server: same game rules, rooms kept in memory instead of Netlify Blobs.
// Run with `npm run local`, then open http://localhost:8888

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { handleAction } from "./server/game.mjs";

const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const PORT = Number(process.env.PORT) || 8888;
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

const blobs = new Map();
const store = {
  async get(key, { type } = {}) {
    if (!blobs.has(key)) return null;
    return type === "json" ? JSON.parse(blobs.get(key)) : blobs.get(key);
  },
  async set(key, value, { onlyIfNew } = {}) {
    if (onlyIfNew && blobs.has(key)) return { modified: false };
    blobs.set(key, String(value));
    return { modified: true };
  },
  setJSON(key, value, options) {
    return this.set(key, JSON.stringify(value), options);
  },
  async delete(key) {
    blobs.delete(key);
  },
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/api") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {}
      const { status, data } = await handleAction(store, body);
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
      return;
    }

    const file = normalize(join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(PUBLIC)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404).end("Not found");
    }
  })
  .listen(PORT, () => console.log(`Guess Who's Thankful running at http://localhost:${PORT}`));
