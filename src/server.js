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
import { publish } from "./publish.js";
import { latest } from "./storage.js";

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
  console.log(`  chain: ${config.chainName} (id ${config.chainId})   |   discovery: GeckoTerminal /${config.network}`);

  // Rebuild public/api from the snapshots on disk before serving.
  //
  // Those four files are derived data and are not in the repo, while the
  // snapshots they are built from are - the scheduled collector commits every
  // reading. So `git pull` brings the new data down without updating what the
  // page actually reads, and the dashboard sits on whatever was last built
  // here. That is invisible from the page, which is the problem with it.
  //
  // publish() is pure disk work - no network, no keys - so doing it on every
  // boot costs nothing and removes the step people have to remember. It also
  // closes the drift for good: the server can no longer serve API files older
  // than the snapshots sitting beside them.
  try {
    const built = publish();
    const newest = latest();
    const age = newest
      ? (Date.now() - new Date(newest.timestamp)) / 3600000
      : null;

    console.log(
      `  rebuilt public/api from ${built.files} file(s)` +
        (age === null
          ? " - no readings on file yet\n"
          : `, newest reading ${age.toFixed(1)}h old` +
            (age > 12 ? " - run `git pull` to fetch newer ones\n" : "\n"))
    );
  } catch (err) {
    // Never fatal. A server that will not start because it could not rebuild
    // derived data is worse than one serving slightly stale data, and the page
    // falls back to its built-in demo reading when the API is missing.
    console.log(`  could not rebuild public/api: ${err.message}\n`);
  }
});
