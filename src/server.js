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
import { rollupAll, WINDOWS } from "./rollup.js";
import { countWindows } from "./windows.js";

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

// Creation and graduation counts come straight off the chain (see windows.js),
// which takes about a minute of paging - far too slow to do per request. One
// cached result is shared by every visitor and refreshed in the background.
const WINDOW_CACHE_MS = 5 * 60 * 1000;
let windowCache = { at: 0, data: null, error: null, inFlight: null };

function refreshWindowCounts() {
  if (windowCache.inFlight) return windowCache.inFlight;

  windowCache.inFlight = countWindows(WINDOWS)
    .then((data) => {
      windowCache = { at: Date.now(), data, error: null, inFlight: null };
      return data;
    })
    .catch((err) => {
      // Keep serving the last good numbers if we have them - a page showing
      // slightly stale counts beats a page showing none.
      windowCache = {
        at: Date.now(),
        data: windowCache.data,
        error: err.message,
        inFlight: null,
      };
      return null;
    });

  return windowCache.inFlight;
}

// Every timeframe in one response, so switching between 5m / 1h / 6h / 24h on
// the page is instant instead of a fresh request each time.
//
// Two sources are merged here:
//   - created / graduated / graduation rate: counted live off the chain, so
//     they are exact from the very first request with no stored history
//   - volume / volatility / rug rate: rolled up from stored snapshots, which
//     do need the collector to have been running
async function serveRollups(res) {
  const rolled = rollupAll(recent(3));

  const stale = Date.now() - windowCache.at > WINDOW_CACHE_MS;
  if (stale || !windowCache.data) {
    // First request pays for the fetch; later ones ride the cache. If it
    // fails, the snapshot-based numbers below still render.
    await refreshWindowCounts();
  }

  const counts = windowCache.data;
  if (counts) {
    for (const win of rolled.windows) {
      const live = counts.windows[win.key];
      if (!live) continue;

      win.live = {
        created: live.created,
        graduated: live.graduated,
        graduationRate: live.graduationRate,
        previous: live.previous,
        measuredAt: counts.measuredAt,
      };
      // Chain counts don't depend on the collector, so a window with no
      // snapshots behind it still has real numbers to show.
      win.available = true;
    }
  }

  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      ...rolled,
      liveCounts: Boolean(counts),
      liveCountsError: windowCache.error,
    })
  );
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

  if (req.method === "GET" && route === "/api/rollups") {
    serveRollups(res).catch(() => {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "rollup failed" }));
    });
    return;
  }
  serveStatic(req, res);
});

server.listen(config.port, () => {
  console.log(`\n  Haboob web server running at http://localhost:${config.port}\n`);

  // Paging the chain for window counts takes about a minute, so warm the
  // cache now rather than making the first visitor wait for it. Refreshed on
  // a timer afterwards so it never goes stale enough to matter.
  if (config.heliusApiKey) {
    console.log("  warming on-chain window counts (~1 min)...");
    refreshWindowCounts().then((data) => {
      if (data) {
        const day = data.windows["24h"];
        console.log(
          `  ready: ${day.created.toLocaleString()} created / ${day.graduated.toLocaleString()} graduated in 24h ` +
            `(${day.graduationRate.toFixed(2)}% graduation rate)\n`
        );
      } else {
        console.log(`  window counts unavailable: ${windowCache.error}\n`);
      }
    });

    const timer = setInterval(refreshWindowCounts, WINDOW_CACHE_MS);
    timer.unref?.(); // don't hold the process open on its own account
  } else {
    console.log("  no HELIUS_API_KEY - window counts will fall back to stored snapshots\n");
  }
});
