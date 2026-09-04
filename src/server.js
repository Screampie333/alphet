// server.js
// A tiny web server for the Haboob landing page - zero dependencies, just
// Node's built-in http module.
//
// Two jobs:
//   1. Serve everything in public/ as static files (the landing page).
//   2. Serve GET /api/latest - the most recent snapshot as JSON, so the
//      page can show real numbers instead of the design-demo ones.
//
//   npm run web   -> starts this on http://localhost:3000 (or PORT from .env)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config, ROOT } from "./config.js";
import { latest, recent } from "./storage.js";

const PUBLIC_DIR = path.join(ROOT, "public");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function serveLatestSnapshot(res) {
  // No snapshot yet is a normal state (e.g. before the first `npm run once`),
  // not an error - the page is expected to handle `snapshot: null` itself.
  const snapshot = latest();
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ snapshot }));
}

// The weather view needs a series, not just the newest reading - the
// half-hourly strip and the daily rows are both drawn from this.
function serveHistory(res, requestUrl) {
  const params = new URL(requestUrl, "http://localhost").searchParams;
  const days = Math.min(Math.max(Number(params.get("days")) || 7, 1), 30);

  // Cap the payload: at 48 snapshots/day, a month of history is a lot of JSON
  // to push at a page that only draws the tail of it.
  const snapshots = recent(days).slice(-400);

  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ snapshots }));
}

function serveStatic(req, res) {
  const requestedPath = decodeURIComponent(req.url.split("?")[0]);
  const relativePath = requestedPath === "/" ? "/index.html" : requestedPath;

  // Resolve against public/ and make sure the result is still inside it -
  // stops requests like /../src/config.js from escaping the folder.
  const filePath = path.normalize(path.join(PUBLIC_DIR, relativePath));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const route = req.url.split("?")[0];

  if (req.method === "GET" && route === "/api/latest") {
    serveLatestSnapshot(res);
    return;
  }

  if (req.method === "GET" && route === "/api/history") {
    serveHistory(res, req.url);
    return;
  }
  serveStatic(req, res);
});

server.listen(config.port, () => {
  console.log(`\n  Haboob web server running at http://localhost:${config.port}\n`);
});
