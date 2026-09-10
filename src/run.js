// run.js
// The main entry point. This is the file you actually run.
//
//   npm run mock     -> one run with fake data (works with no RPC endpoint)
//   npm run once     -> one run against Robinhood Chain
//   npm start        -> keeps running forever, every INTERVAL_MINUTES

import { config } from "./config.js";
import { collect, rpcCalls, apiCalls, indexerCalls, imageCalls } from "./collector.js";
import { score } from "./scoring.js";
import { append, recent } from "./storage.js";
import { publish } from "./publish.js";
import { consoleReport, xPostReport } from "./report.js";

const args = process.argv.slice(2);
const runOnce = args.includes("--once");
const useMock = args.includes("--mock");

async function tick() {
  try {
    console.log(`\n[${new Date().toISOString()}] collecting...`);

    const raw = await collect({ mock: useMock });
    const history = recent(7);
    const snapshot = score(raw, history);
    const total = append(snapshot);
    const published = publish();

    console.log(consoleReport(snapshot));
    console.log("  --- X post version ---\n");
    console.log(xPostReport(snapshot));
    console.log(
      `\n  saved. ${total} snapshot(s) on file, ` +
        `${published.kb} KB of API written to public/api/.`
    );

    // Three budgets now, and they bind differently. GeckoTerminal is capped
    // per minute and a run spends under sixty. Blockscout is generous enough
    // that a run barely touches its daily credits. The RPC side is the one to
    // watch before raising MAX_TOKENS_PER_RUN - reported, never estimated.
    if (!useMock) {
      const perDay = Math.round(rpcCalls.count * (1440 / config.intervalMinutes));
      console.log(
        `  cost: ${apiCalls.count} GeckoTerminal + ${indexerCalls.count} Blockscout + ${imageCalls.count} DexScreener + ` +
          `${rpcCalls.count.toLocaleString("en-US")} RPC call(s) in ${rpcCalls.batches} batch(es) ` +
          `-> ~${perDay.toLocaleString("en-US")} RPC/day\n`
      );
      rpcCalls.count = 0;
      rpcCalls.batches = 0;
      apiCalls.count = 0;
      indexerCalls.count = 0;
      imageCalls.count = 0;
    } else {
      console.log("");
    }

    return snapshot;
  } catch (err) {
    // Never crash the loop - a failed pull should just be skipped.
    console.error(`\n  collection failed: ${err.message}\n`);
    return null;
  }
}

async function main() {
  // Said once, at the top, because the difference it makes is not visible in
  // the reading itself - a run without it prints a confident gauge built on
  // two of four metrics.
  if (!useMock && !config.blockscoutKey) {
    console.log("\n  No BLOCKSCOUT_API_KEY set.");
    console.log("  Holder distribution and developer track record will be mostly unmeasurable.");
    console.log("  Free key: https://dev.blockscout.com");
  }

  await tick();

  if (runOnce) return;

  const ms = config.intervalMinutes * 60 * 1000;
  console.log(`  Running every ${config.intervalMinutes} minutes. Ctrl+C to stop.\n`);
  setInterval(tick, ms);
}

main();
