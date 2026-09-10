// backfill.js
// Reconstructs a trend for the days before Alphet started running.
//
//   npm run backfill            -> 4 days
//   npm run backfill -- --days 7
//
// WHAT THIS IS, EXACTLY
//
// The gauge needs two things per hour: which tokens were Alpha and which were
// Beta, and how much money went into each. Only the second is recoverable.
//
// Holder distribution and liquidity permanence - 60% of the weight - are reads
// of current state. Getting them for a past block needs an archive node, and
// the public Robinhood Chain endpoint refuses historical state outright
// ("metadata is not found") even one hour back. So a token's quality cannot be
// recomputed for the past at all.
//
// What this does instead is hold each token's quality at today's value and
// re-weight the aggregates with the volume each hour actually saw. Every
// number in a snapshot here is volume-weighted, so swapping in historical
// volume moves all of them legitimately - the only thing frozen is the per
// token score.
//
// It answers: "given what these tokens are today, where was the money going?"
// It does NOT answer: "what would Alphet have printed that hour?"
//
// THE BIAS YOU MUST KNOW ABOUT
//
// Tokens are discovered from today's pool feed, so anything that already died
// is absent - and dead tokens were disproportionately Beta and carried volume
// on their way down. Backfilled history is therefore biased toward Alpha, by
// an amount nobody can measure. That is why these snapshots are marked
// `backfilled` and kept off the timeframe card: a shape, not a reading.

import { config } from "./config.js";
import { discoverTokens, apiCalls } from "./sources.js";
import { readAll, writeAll, latest } from "./storage.js";

const BASE = "https://api.geckoterminal.com/api/v2";
const HOUR = 3600;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const args = process.argv.slice(2);
function arg(name, fallback) {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(args[at + 1]);
}

/**
 * Hourly candles for one pool, paged backwards until `days` are covered.
 *
 * One request returns at most 100 candles, so anything past about four days
 * needs `before_timestamp` paging.
 */
async function fetchCandles(poolAddress, days) {
  const wanted = days * 24;
  const candles = [];
  let before = null;

  while (candles.length < wanted) {
    const url = new URL(`${BASE}/networks/${config.network}/pools/${poolAddress}/ohlcv/hour`);
    url.searchParams.set("aggregate", "1");
    url.searchParams.set("limit", "100");
    url.searchParams.set("currency", "usd");
    if (before) url.searchParams.set("before_timestamp", String(before));

    apiCalls.count++;
    const res = await fetch(url, { headers: { Accept: "application/json" } });

    if (res.status === 429) {
      await sleep(20000);
      continue;
    }
    // A pool with no chart is normal - too new, or never traded.
    if (!res.ok) break;

    const body = await res.json();
    const list = body.data?.attributes?.ohlcv_list || [];
    if (!list.length) break;

    candles.push(...list);
    before = list[list.length - 1][0] - 1;

    if (list.length < 100) break;
    await sleep(2500);
  }

  return candles;
}

async function main() {
  const days = Math.min(Math.max(arg("days", 4), 1), 30);

  const newest = latest();
  if (!newest || !newest.tokens?.length) {
    console.log("\n  No live snapshot to take quality scores from.");
    console.log("  Run `npm run once` first - backfill re-weights that reading, it can't replace it.\n");
    return;
  }
  if (newest.raw?.source === "mock") {
    console.log("\n  The newest snapshot is mock data. Backfilling against invented");
    console.log("  quality scores would produce an invented trend.\n");
    return;
  }

  console.log(`\n  Backfilling ${days} day(s) from GeckoTerminal...`);
  console.log(`  Quality held at the reading from ${new Date(newest.timestamp).toLocaleString()}\n`);

  // Snapshots carry their tokens' pool addresses, so the usual case needs no
  // network at all. Older snapshots predate that field, and those fall back to
  // re-reading the feed.
  let scored = newest.tokens
    .filter((token) => token.poolAddress)
    .map((token) => ({ token, poolAddress: token.poolAddress }));

  if (!scored.length) {
    const { pools } = await discoverTokens();
    const poolFor = new Map(pools.map((pool) => [pool.address, pool]));

    scored = newest.tokens
      .map((token) => ({ token, poolAddress: poolFor.get(token.address)?.poolAddress }))
      .filter((entry) => entry.poolAddress);
  }

  console.log(`  ${scored.length} of ${newest.tokens.length} scored tokens still have a pool\n`);
  if (!scored.length) return;

  // hour bucket -> running totals
  const buckets = new Map();

  for (const { token, poolAddress } of scored) {
    const candles = await fetchCandles(poolAddress, days);
    process.stdout.write(`  ${token.symbol.padEnd(14)} ${String(candles.length).padStart(4)} candles\n`);

    for (const [ts, , , , , volume] of candles) {
      const hour = Math.floor(ts / HOUR) * HOUR;
      const usd = Number(volume) || 0;
      if (usd <= 0) continue;

      if (!buckets.has(hour)) buckets.set(hour, { alpha: 0, beta: 0, tokens: [] });
      const bucket = buckets.get(hour);
      bucket[token.side] += usd;
      bucket.tokens.push({ token, usd });
    }

    await sleep(2500);
  }

  const METRIC_KEYS = Object.keys(config.weights);

  const snapshots = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, bucket]) => {
      const total = bucket.alpha + bucket.beta;
      if (total <= 0) return null;

      const alphaWeight = (bucket.alpha / total) * 100;

      // Same volume weighting the live pipeline uses, with this hour's volume
      // standing in for the reading's own.
      const weighted = (getValue) => {
        let sum = 0;
        let weight = 0;
        for (const { token, usd } of bucket.tokens) {
          const value = getValue(token);
          if (value === null || value === undefined || !Number.isFinite(value)) continue;
          sum += value * usd;
          weight += usd;
        }
        return weight > 0 ? sum / weight : null;
      };

      const subScores = {};
      for (const key of METRIC_KEYS) {
        const mean = weighted((t) => t.scores[key]);
        subScores[key] = mean === null ? null : Math.round(mean);
      }

      const index = weighted((t) => t.quality);
      const alphaCount = new Set(
        bucket.tokens.filter((e) => e.token.side === "alpha").map((e) => e.token.address)
      ).size;
      const betaCount = new Set(
        bucket.tokens.filter((e) => e.token.side === "beta").map((e) => e.token.address)
      ).size;

      return {
        timestamp: new Date(hour * 1000).toISOString(),
        alphetIndex: index === null ? null : Math.round(index),
        alphaWeight: Number(alphaWeight.toFixed(1)),
        betaWeight: Number((100 - alphaWeight).toFixed(1)),
        verdict: verdictFor(alphaWeight),
        subScores,
        split: {
          alphaCount,
          betaCount,
          alphaVolume: Number(bucket.alpha.toFixed(2)),
          betaVolume: Number(bucket.beta.toFixed(2)),
          totalVolume: Number(total.toFixed(2)),
          honeypots: 0,
        },
        tokens: [],

        // The markers that keep this out of anything that should only ever
        // report measurements.
        backfilled: true,
        basis: "current quality x historical volume",
        coverage: alphaCount + betaCount,
        raw: {
          source: "backfill",
          chain: config.chainName,
          measuredAt: newest.timestamp,
        },
      };
    })
    .filter(Boolean);

  // Real readings always win: a backfilled hour is dropped wherever a measured
  // snapshot already covers it.
  const existing = readAll();
  const measuredHours = new Set(
    existing
      .filter((s) => !s.backfilled)
      .map((s) => Math.floor(new Date(s.timestamp).getTime() / 1000 / HOUR))
  );

  const kept = snapshots.filter(
    (s) => !measuredHours.has(Math.floor(new Date(s.timestamp).getTime() / 1000 / HOUR))
  );

  const merged = [...existing.filter((s) => !s.backfilled), ...kept].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  writeAll(merged);

  const first = kept[0];
  const last = kept[kept.length - 1];

  console.log(`\n  ${kept.length} backfilled hour(s) written (${snapshots.length - kept.length} skipped, already measured)`);
  if (first && last) {
    console.log(`  ${new Date(first.timestamp).toLocaleString()}  ->  ${new Date(last.timestamp).toLocaleString()}`);
    console.log(`  alpha share ranged ${Math.min(...kept.map((s) => s.alphaWeight)).toFixed(1)}% to ${Math.max(...kept.map((s) => s.alphaWeight)).toFixed(1)}%`);
  }
  console.log(`  ${merged.length} snapshot(s) on file, ${apiCalls.count} GeckoTerminal call(s) spent`);
  console.log(`\n  These are marked backfilled: shown dimmed on the trend strip and`);
  console.log(`  excluded from the timeframe card. Dead tokens are missing from`);
  console.log(`  them entirely, which biases the shape toward Alpha.\n`);
}

// Kept in step with determineVerdict() in scoring.js.
function verdictFor(alphaWeight) {
  const t = config.verdictThresholds;
  if (alphaWeight >= t.alphaHeavy) return { key: "alpha-heavy", label: "Alpha-heavy", summary: "Most of the money went into tokens that score on the Alpha side today." };
  if (alphaWeight >= t.alphaLean) return { key: "alpha-lean", label: "Alpha lean", summary: "More money in today's Alpha side than its Beta side, but not by much." };
  if (alphaWeight >= t.betaLean) return { key: "balanced", label: "Balanced", summary: "Money was split close to evenly across the two sides." };
  if (alphaWeight >= t.betaHeavy) return { key: "beta-lean", label: "Beta lean", summary: "Money leaned toward tokens that score on the Beta side today." };
  return { key: "beta-heavy", label: "Beta-heavy", summary: "Almost all the money went into tokens that score on the Beta side today." };
}

main().catch((err) => {
  console.error(`\n  backfill failed: ${err.message}\n`);
  process.exit(1);
});
