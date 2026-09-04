// run.js
// The main entry point. This is the file you actually run.
//
//   npm run mock     -> one run with fake data (works with no API key)
//   npm run once     -> one run with live data
//   npm start        -> keeps running forever, every INTERVAL_MINUTES

import { config } from "./config.js";
import { collect } from "./collector.js";
import { score } from "./scoring.js";
import { append, recent } from "./storage.js";
import { consoleReport, xPostReport } from "./report.js";

const args = process.argv.slice(2);
const runOnce = args.includes("--once");
const useMock = args.includes("--mock");

async function tick() {
  try {
    console.log(`\n[${new Date().toISOString()}] collecting...`);

    // 1. get the raw numbers
    const raw = await collect({ mock: useMock });

    // 2. look at our own recent history to use as a baseline
    const history = recent(7);

    // 3. score it
    const snapshot = score(raw, history);

    // 4. save it
    const total = append(snapshot);

    // 5. show it
    console.log(consoleReport(snapshot));
    console.log("  --- X post version ---\n");
    console.log(xPostReport(snapshot));
    console.log(`\n  saved. ${total} snapshot(s) on file.\n`);

    return snapshot;
  } catch (err) {
    // Never crash the loop - a failed pull should just be skipped.
    console.error(`\n  collection failed: ${err.message}\n`);
    return null;
  }
}

async function main() {
  if (!useMock && !config.heliusApiKey) {
    console.log("\n  No HELIUS_API_KEY found in .env");
    console.log("  Running with --mock instead so you can see it work.\n");
  }

  await tick();

  if (runOnce) return;

  const ms = config.intervalMinutes * 60 * 1000;
  console.log(`  Running every ${config.intervalMinutes} minutes. Ctrl+C to stop.\n`);
  setInterval(tick, ms);
}

main();
