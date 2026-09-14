// Checks that public/live.js scores exactly like src/scoring.js.
//
// live.js is a port. It rebuilds the gauge in the browser between collection
// runs, and if it disagrees with the collector on the same inputs, the page
// shows two different measurements under one label with nothing to tell them
// apart. This runs the real score() and the port on identical data and fails
// on any difference.
//
//   node test/live-parity.mjs

import fs from "node:fs";
import { score } from "../src/scoring.js";
import { config } from "../src/config.js";

// Load the browser script against a fake window.
const window = {};
new Function("window", fs.readFileSync(new URL("../public/live.js", import.meta.url), "utf8"))(window);
const Live = window.AlphetLive;

const HOURS = { m15: 0.25, h1: 1, h6: 6, h24: 24 };

// Deterministic, so a failure reproduces.
let seed = 42;
function rand() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// A collector-shaped token, with activity built the way readToken() builds it.
function collectorToken(i) {
  const holderCount = pick([3, 12, 40, 300, 2500, 91000]);
  const partial = rand() < 0.25;
  const dayVolume = pick([0, 40, 900, 25000, 400000, 9000000]);

  // Windows are nested on chain: the last 15 minutes are part of the last
  // hour, which is part of the day. So trades and volume never shrink as the
  // window grows. The first version of this test drew them independently
  // and produced tokens with 3,000 trades in 15 minutes and 4 in a day -
  // which made the collector score tokens at m15 that it could not score at
  // h24, and the port disagree about a case that cannot exist.
  const dayTrades = pick([0, 4, 9, 10, 11, 60, 3000]);
  const windows = {};
  for (const key of Object.keys(HOURS)) {
    const share = HOURS[key] / 24;
    const volumeUsd = dayVolume * share * (0.5 + rand() * 0.5);
    const trades = key === "h24" ? dayTrades : Math.floor(dayTrades * share * (0.5 + rand() * 0.5));
    const buys = Math.round(trades * rand());
    const perDay = volumeUsd * (24 / HOURS[key]);
    windows[key] = {
      volumeUsd: Number(volumeUsd.toFixed(2)),
      buys,
      sells: trades - buys,
      trades,
      buyRatio: trades > 0 ? Number((buys / trades).toFixed(3)) : 0.5,
      volumePerHolder: Number((perDay / Math.max(1, holderCount)).toFixed(2)),
    };
  }

  const poolAddress = "0x" + String(i).padStart(40, "0");
  return {
    address: "0x" + String(i + 5000).padStart(40, "0"),
    symbol: "T" + i,
    name: "Token " + i,
    dex: "test",
    ageHours: 100,
    poolAddress,
    holders: {
      top10Percent: pick([null, 5, 30, 55, 90]),
      holderCount,
      partial,
      capped: false,
    },
    liquidity: rand() < 0.5
      ? { measurable: false }
      : { measurable: true, drained: false, burnedPercent: pick([0, 40, 100]), lockedPercent: 0, lockDaysRemaining: 0, liquidityUsd: 1000 },
    devRecord: rand() < 0.4 ? null : { known: true, launches: pick([1, 4, 12]), rugs: pick([0, 0, 1, 3]) },
    activity: {
      volumeUsd: windows.h24.volumeUsd,
      buyRatio: windows.h24.buyRatio,
      trades: windows.h24.trades,
      volumePerHolder: windows.h24.volumePerHolder,
      windows,
    },
    honeypot: { blocked: rand() < 0.05, tested: rand() < 0.7 },
  };
}

const N = 400;
const tokens = Array.from({ length: N }, (_, i) => collectorToken(i));

// The truth: what the collector publishes.
const expected = score({ source: "test", chain: "test", tokens, totals: {} });

// What the browser sees: the published snapshot, plus the same activity as
// if GeckoTerminal had just returned it.
const fresh = new Map(
  tokens.map((t) => [t.poolAddress, { poolAddress: t.poolAddress, windows: t.activity.windows }])
);
const meta = {
  alphaCutoff: config.alphaCutoff,
  weights: config.weights,
  thresholds: config.thresholds,
};
const got = Live.rescore(expected, fresh, meta);

let failures = 0;
function check(label, a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  failures++;
  if (failures <= 15) console.log(`  MISMATCH ${label}\n    collector: ${JSON.stringify(a)}\n    live:      ${JSON.stringify(b)}`);
}

for (const key of Object.keys(HOURS)) {
  const e = expected.windows[key];
  const g = got.windows[key];
  if (!e || !g) {
    check(`${key} present`, Boolean(e), Boolean(g));
    continue;
  }
  check(`${key}.alphaWeight`, e.alphaWeight, g.alphaWeight);
  check(`${key}.betaWeight`, e.betaWeight, g.betaWeight);
  check(`${key}.alphetIndex`, e.alphetIndex, g.alphetIndex);
  check(`${key}.subScores`, e.subScores, g.subScores);
  check(`${key}.measuredOn`, e.measuredOn, g.measuredOn);
  for (const f of ["alphaCount", "betaCount", "alphaVolume", "betaVolume", "totalVolume", "partialHolders"]) {
    check(`${key}.split.${f}`, e.split[f], g.split[f]);
  }
}

// Per token, on the headline window.
const byAddress = new Map(got.tokens.map((t) => [t.address, t]));
for (const e of expected.tokens) {
  const g = byAddress.get(e.address);
  if (!g) { check(`token ${e.symbol} present`, true, false); continue; }
  check(`token ${e.symbol}.quality`, e.quality, g.quality);
  check(`token ${e.symbol}.side`, e.side, g.side);
  check(`token ${e.symbol}.scores`, e.scores, g.scores);
}

const honeypots = tokens.filter((t) => t.honeypot.blocked).length;
console.log(`live parity: ${N} tokens (${honeypots} honeypots, ${expected.tokens.length} scored), 4 windows`);
if (failures) {
  console.log(`FAILED - ${failures} mismatch(es)`);
  process.exit(1);
}
console.log("OK - live.js matches scoring.js on every window and every token");
