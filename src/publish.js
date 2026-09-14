// publish.js
// Writes the dashboard's API as plain files under public/api/.
//
// The four endpoints were only ever derived from one JSON file, so serving
// them from a running process bought nothing. Writing them out instead makes
// the whole dashboard a static site: it deploys to Cloudflare Pages with no
// Workers, no server and no cost, and `npm run web` serves the very same files
// so local and deployed behave identically.
//
// The collector itself cannot follow it there - one run makes about 2,200
// outbound requests against a 50-subrequest limit on Workers' free plan, and
// needs a filesystem for its cache - so it runs elsewhere and its output is
// what gets deployed.

import fs from "node:fs";
import path from "node:path";
import { config, ROOT } from "./config.js";
import { readAll, latest, recent } from "./storage.js";

const API_DIR = path.join(ROOT, "public", "api");

function write(name, payload) {
  fs.writeFileSync(path.join(API_DIR, name), JSON.stringify(payload), "utf8");
}

/** Regenerate every API file from what is currently stored. */
export function publish() {
  fs.mkdirSync(API_DIR, { recursive: true });

  const snapshot = latest();

  write("latest.json", { snapshot });

  // The trend strip only reads the series, never the token lists, so they are
  // dropped here - they are the bulk of the payload and none of the use.
  write("history.json", {
    snapshots: recent(7)
      .slice(-200)
      .map(({ tokens, ...rest }) => rest),
  });

  write("windows.json",
    snapshot && snapshot.windows
      ? {
          windows: snapshot.windows,
          headlineWindow: snapshot.headlineWindow,
          measuredAt: snapshot.timestamp,
          tokensScored: (snapshot.tokens || []).length,
        }
      : { windows: null, reason: "no reading with timeframe data yet" }
  );

  write("meta.json", {
    chain: config.chainName,
    chainId: config.chainId,
    explorerUrl: config.explorerUrl,
    alphaCutoff: config.alphaCutoff,
    weights: config.weights,
    intervalMinutes: config.intervalMinutes,
    lookbackHours: config.lookbackHours,
    minLiquidityUsd: config.thresholds.minLiquidityUsd,
    // The rug-signal thresholds, so the page can re-score trading activity
    // between collection runs with the same numbers the collector used. The
    // scoring LOGIC is ported to public/live.js; the PARAMETERS stay here, in
    // one place, so the two cannot quietly disagree about what "healthy" means.
    thresholds: {
      healthyVolumePerHolder: config.thresholds.healthyVolumePerHolder,
      suspiciousVolumePerHolder: config.thresholds.suspiciousVolumePerHolder,
      buyPressureGood: config.thresholds.buyPressureGood,
      buyPressureBad: config.thresholds.buyPressureBad,
      minTradesForSignal: config.thresholds.minTradesForSignal,
    },
    generatedAt: new Date().toISOString(),
  });

  const bytes = fs
    .readdirSync(API_DIR)
    .reduce((sum, f) => sum + fs.statSync(path.join(API_DIR, f)).size, 0);

  return { files: 4, kb: Math.round(bytes / 1024), snapshots: readAll().length };
}
