// server.js
// A static file server for public/ - zero dependencies, just Node's built-in
// http module.
//
// It has no API routes because there is no API: the collector writes
// public/api/*.json after every run (see publish.js), so this serves exactly
// the same bytes Cloudflare Pages does. That is the point - local and
// deployed cannot drift apart if they are reading the same files.
//
//   npm run web   -> starts this on http://localhost:3000 (or PORT from .env)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config, ROOT } from "./config.js";

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

const server = http.createServer(serveStatic);

server.listen(config.port, () => {
  console.log(`\n  Alphet web server running at http://localhost:${config.port}`);
  console.log(`  chain: ${config.chainName} (id ${config.chainId})   |   discovery: GeckoTerminal /${config.network}\n`);
});
