// collector.js
// Fetches the raw numbers we need from Solana / pump.fun.
//
// IMPORTANT: this file has two modes.
//
//   MOCK MODE  - makes up believable numbers so you can run and test
//                everything today, without an API key.
//   LIVE MODE  - talks to Helius for real. The four collect* functions
//                below fetch pump.fun transactions and decode them via
//                Helius's Enhanced Transactions API. Set DEBUG_COLLECTOR=1
//                to print a sample decoded transaction if the numbers ever
//                look wrong.
//
// Everything downstream (scoring, reports) works the same either way,
// so you can build the whole pipeline first and swap in real data later.

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { countWindows } from "./windows.js";

const HELIUS_URL = `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;


// Every Helius call this run has made. Free-tier quota is the real constraint
// on how often the collector can run and how wide a slice it can read, so the
// number is reported rather than estimated - pump.fun's traffic doubled in a
// single afternoon during development, and any figure worked out on paper
// went stale with it.
export const apiCalls = { rpc: 0, parse: 0, get total() { return this.rpc + this.parse; } };

// --- helper: one JSON-RPC call to Helius ---
async function rpc(method, params = []) {
  if (!config.heliusApiKey) {
    throw new Error("No HELIUS_API_KEY set. Run with --mock, or add a key to .env");
  }

  apiCalls.rpc++;
  const res = await fetch(HELIUS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "haboob",
      method,
      params,
    }),
  });

  if (!res.ok) {
    throw new Error(`Helius returned HTTP ${res.status}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`Helius error: ${json.error.message}`);
  }
  return json.result;
}

// ---------------------------------------------------------------
// MOCK DATA
// ---------------------------------------------------------------

function randomBetween(min, max) {
  return Math.round(min + Math.random() * (max - min));
}

function mockRaw() {
  const tokensCreated = randomBetween(2000, 9000);
  const tokensGraduated = randomBetween(10, Math.max(12, Math.round(tokensCreated * 0.02)));

  return {
    tokensCreated,
    tokensGraduated,
    totalVolumeSol: randomBetween(20000, 200000),
    tokensRugged: randomBetween(5, 400),
    activeTokens: randomBetween(500, 3000),
    avgPriceSwingPercent: randomBetween(10, 140),
  };
}

// ---------------------------------------------------------------
// LIVE DATA  (the four things Haboob reads)
// ---------------------------------------------------------------
//
// All four numbers below come from the same place: pump.fun transactions
// that happened in the last `intervalMinutes`. So instead of each function
// fetching its own data, they all share one fetch (see getWindowTransactions
// below) - that's 1 round of API calls per run instead of 4.
//
// The two steps are:
//   1. Ask Solana for every transaction signature that touched the pump.fun
//      program recently (plain RPC - free, just paging).
//   2. Send those signatures to Helius's "Enhanced Transactions" API, which
//      decodes them into readable JSON for us. We need this because pump.fun
//      is a custom program - plain Solana RPC can't decode its instructions
//      on its own, only Helius's parser knows how.
//
// A NOTE ON TRUST: we can't be 100% sure of the exact label Helius puts on a
// "coin created" vs "coin graduated" event without watching real traffic.
// Run once with DEBUG_COLLECTOR=1 to print a real sample event, and adjust
// the matching in classify() below if the counts look off.

// We read only the most recent `sampleSeconds` of each interval, not the whole
// thing - see the note on config.sampleSeconds for why. SAMPLE_SCALE converts
// the sample's rate-like numbers back up to full-window figures.
const SAMPLE_MS = config.sampleSeconds * 1000;
// Nominal scale, used only where a per-run figure is not to hand. The real
// one is computed per run from the span actually read (see fetchWindow).
const SAMPLE_SCALE = (config.intervalMinutes * 60) / config.sampleSeconds;
const LAMPORTS_PER_SOL = 1_000_000_000;
const HELIUS_PARSE_URL = `https://api.helius.xyz/v0/transactions/?api-key=${config.heliusApiKey}`;

// The hard ceiling on how much one run may read, and the reason the monthly
// quota is safe.
//
// Cost used to scale with pump.fun's traffic, which is not something we
// control: it went from 250 to 520 signatures/second inside one afternoon,
// and the same settings that cost 58% of the free tier at the low end cost
// 152% at the high end. Capping the signatures read makes a run cost about
// the same whatever the chain is doing - roughly 6,000 signatures is 60
// parse calls plus a handful of paging calls.
//
// When the cap bites, the run covers less time than sampleSeconds asked for.
// That is fine: collectSignaturesSince reports the span it actually read and
// the rate-like numbers scale from that, so runs stay comparable.
const MAX_SIGNATURES_PER_RUN = 6000;

let windowPromise = null;

// Every collect* function below calls this. Only the first call per run
// actually hits the network - the rest reuse the same in-flight promise.
function getWindowTransactions() {
  if (!windowPromise) windowPromise = fetchWindow();
  return windowPromise;
}

async function fetchWindow() {
  const cutoffSeconds = Math.floor((Date.now() - SAMPLE_MS) / 1000);
  const { signatures, spanSeconds } = await collectSignaturesSince(cutoffSeconds);
  const events = await parseSignatures(signatures);
  const buckets = classify(events);

  // Scale from the span actually read, not the one configured. Under the cap
  // they are the same; over it, this is what keeps a heavy-traffic run
  // comparable with a quiet one.
  buckets.scale = (config.intervalMinutes * 60) / spanSeconds;
  buckets.spanSeconds = spanSeconds;

  if (process.env.DEBUG_COLLECTOR === "1") {
    console.log(`\n[debug] asked ${config.sampleSeconds}s, read ${spanSeconds}s (scale x${buckets.scale.toFixed(1)})`);
    console.log(`[debug] ${signatures.length} signature(s) -> ${events.length} parsed event(s)`);
    console.log(
      `[debug] kept: ${buckets.creates.length} create / ` +
        `${buckets.graduations.length} graduation / ${buckets.trades.length} trade`
    );
    console.log(`[debug] dropped: ${buckets.dropped.notPumpFun} not-pump.fun, ` +
      `${buckets.dropped.failed} failed tx, ${buckets.dropped.notATrade} not-a-trade`);
    console.log("[debug] sample event:", JSON.stringify(events[0], null, 2));
  }

  return buckets;
}

// Page backwards through the pump.fun program's recent signatures until we
// pass the start of our time window. Plain RPC, no Helius parsing yet.
async function collectSignaturesSince(cutoffSeconds) {
  const signatures = [];
  let newest = null;
  let oldest = null;
  let before;
  let hitCap = false;

  while (true) {
    const batch = await rpc("getSignaturesForAddress", [
      config.pumpFunProgramId,
      { limit: 1000, before },
    ]);
    if (!batch.length) break;

    let reachedCutoff = false;
    for (const item of batch) {
      if (item.blockTime && item.blockTime < cutoffSeconds) {
        reachedCutoff = true;
        break;
      }
      if (item.blockTime) {
        if (newest === null) newest = item.blockTime;
        oldest = item.blockTime;
      }
      signatures.push(item.signature);

      if (signatures.length >= MAX_SIGNATURES_PER_RUN) {
        hitCap = true;
        break;
      }
    }

    if (reachedCutoff || hitCap) break;
    before = batch[batch.length - 1].signature;
  }

  // How much time this actually covers. Normally it's sampleSeconds, but when
  // the cap bites it's less, and the caller scales by what was really read
  // rather than by what was asked for.
  const spanSeconds = newest !== null && oldest !== null ? Math.max(1, newest - oldest) : config.sampleSeconds;

  if (hitCap) {
    console.warn(
      `  note: traffic is heavy - read ${signatures.length} signatures covering ` +
        `${spanSeconds}s of the ${config.sampleSeconds}s sample. Scaling from the ` +
        `${spanSeconds}s actually read.`
    );
  }

  return { signatures, spanSeconds };
}

// Helius accepts up to 100 signatures per call and returns them decoded:
// who sent SOL to whom, which tokens moved, a plain-English description, etc.
async function parseSignatures(signatures) {
  const events = [];

  for (let i = 0; i < signatures.length; i += 100) {
    const chunk = signatures.slice(i, i + 100);
    apiCalls.parse++;
    const res = await fetch(HELIUS_PARSE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: chunk }),
    });

    if (!res.ok) {
      throw new Error(`Helius parse API returned HTTP ${res.status}`);
    }

    events.push(...(await res.json()));
  }

  return events;
}

// Sort every parsed event into one of three buckets.
function classify(events) {
  const creates = [];
  const graduations = [];
  const trades = [];
  const dropped = { notPumpFun: 0, failed: 0, notATrade: 0 };

  for (const event of events) {
    if (event.source !== "PUMP_FUN") {
      dropped.notPumpFun++;
      continue; // not a pump.fun transaction
    }

    // Roughly a fifth of pump.fun transactions fail (slippage, sold-out
    // curves). They still carry the priority fee the sender paid, so counting
    // them would book failed attempts as trading volume.
    if (event.transactionError) {
      dropped.failed++;
      continue;
    }

    const type = (event.type || "").toUpperCase();
    const description = (event.description || "").toLowerCase();

    if (type === "CREATE" || (description.includes("created") && description.includes("coin"))) {
      creates.push(event);
    } else if (
      type === "COMPLETE" ||
      type === "MIGRATE" ||
      description.includes("complet") ||
      description.includes("migrat")
    ) {
      graduations.push(event);
    } else if (type === "SWAP") {
      trades.push(event); // buys and sells on the bonding curve
    } else {
      // Everything else that touches pump.fun but isn't a trade: plain token
      // transfers between wallets, account closures, and whatever Helius
      // couldn't label. These must not reach the trade bucket - a wallet-to-
      // wallet transfer moves tokens while only the gas fee moves SOL, so
      // treating it as a trade prices the token at fee/tokens and reports a
      // swing of several thousand percent that never happened.
      dropped.notATrade++;
    }
  }

  return { creates, graduations, trades, dropped };
}

// --- small helpers shared by the collect* functions below ---

// Mints that show up inside pump.fun transactions but are not the token being
// traded - a swap routed through USDC leaves a USDC transfer in the same
// transaction, and picking that as "the token" produces nonsense prices.
const NOT_THE_TRADED_TOKEN = new Set([
  "So11111111111111111111111111111111111111112", // wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

// Which token this transaction moved. pump.fun trades touch one token at a
// time, but the transfer list can also carry the quote leg, so take the mint
// that actually moved the most rather than whichever happens to be first.
function pickMint(event) {
  const transfers = event.tokenTransfers || [];

  const totals = new Map();
  for (const transfer of transfers) {
    if (!transfer.mint || NOT_THE_TRADED_TOKEN.has(transfer.mint)) continue;
    const moved = Math.abs(transfer.tokenAmount || 0);
    totals.set(transfer.mint, (totals.get(transfer.mint) || 0) + moved);
  }

  let best = null;
  let bestAmount = 0;
  for (const [mint, amount] of totals) {
    if (amount > bestAmount) {
      best = mint;
      bestAmount = amount;
    }
  }
  return best;
}

// Total SOL that changed hands in this transaction.
// How much SOL the trade actually moved.
//
// Read from the trader's own balance change, not from nativeTransfers. On a
// lot of pump.fun trades the SOL leg goes through the bonding curve as an
// inner instruction and never appears as a native transfer at all, so summing
// that list picks up only the fee - while on multi-hop transactions it counts
// the same lamports at every hop. The two cases priced the same token ~100x
// apart, which is where the four-figure "price swings" came from: measured on
// live traffic, the median swing was 2,262% off nativeTransfers and 27.8% off
// the balance delta, with blow-ups falling from 7 mints in 14 to 2 in 12.
//
// The fee is backed out so a buy and a sell of the same size price the same.
function solAmount(event) {
  const self = (event.accountData || []).find((a) => a.account === event.feePayer);

  if (self && self.nativeBalanceChange) {
    const moved = Math.abs(self.nativeBalanceChange) - (event.fee || 0);
    if (moved > 0) return moved / LAMPORTS_PER_SOL;
  }

  // Older or unusual payloads without accountData still get an answer.
  const transfers = event.nativeTransfers || [];
  const lamports = transfers.reduce((sum, t) => sum + Math.abs(t.amount || 0), 0);
  return lamports / LAMPORTS_PER_SOL;
}

// Total of one specific token that changed hands in this transaction.
function tokenAmount(event, mint) {
  const transfers = event.tokenTransfers || [];
  return transfers
    .filter((t) => t.mint === mint)
    .reduce((sum, t) => sum + Math.abs(t.tokenAmount || 0), 0);
}

// How much of one token a specific wallet received / sent in this
// transaction. Split by direction (not just "was this a buy or a sell tx")
// because pump.fun's own "create" transactions often bundle the creator's
// first buy into the same transaction as the token launch.
function tokensReceivedBy(event, mint, wallet) {
  return (event.tokenTransfers || [])
    .filter((t) => t.mint === mint && t.toUserAccount === wallet)
    .reduce((sum, t) => sum + Math.abs(t.tokenAmount || 0), 0);
}

function tokensSentBy(event, mint, wallet) {
  return (event.tokenTransfers || [])
    .filter((t) => t.mint === mint && t.fromUserAccount === wallet)
    .reduce((sum, t) => sum + Math.abs(t.tokenAmount || 0), 0);
}

// 1. How many tokens were created, and how many graduated?
//
// Not from the sample. Graduations are ~0.003% of pump.fun traffic, so a
// 30-second sample of the main program catches zero of them essentially
// always - and it did: every snapshot collected this way reported 0
// graduated, which pinned the graduation sub-score at 50 permanently,
// because a baseline of zero makes relativeScore fall back to neutral.
//
// windows.js counts both events directly off the accounts they all pass
// through, so these are exact counts for the whole interval rather than a
// sample scaled up - which is also why they must not be multiplied by
// SAMPLE_SCALE afterwards.
async function collectTokenCounts() {
  const intervalMs = config.intervalMinutes * 60 * 1000;
  const counts = await countWindows([{ key: "interval", ms: intervalMs }]);
  const window = counts.windows.interval;

  return { created: window.created, graduated: window.graduated, exact: true };
}

// 2. How much total volume traded?
// Volume over the window, scaled by the span actually read (see fetchWindow).
//
// An earlier version capped each trade at the 95th percentile of its sample.
// The theory was that the heavy tail drove the swinging score, and the tail
// is real: the top 5% of trades carry ~25% of volume, and one 3.55 SOL trade
// was 9.7% of a sample. Measured across five runs it changed nothing - 2.54x
// spread capped against 2.55x uncapped - while understating volume by 15%, so
// it is gone.
//
// What that measurement did settle is that the reading is sound. Taken as a
// rate, three consecutive runs agreed within 2.8% (10.37, 10.24, 10.53
// SOL/s); the wider spread across the day was the market itself climbing from
// 4.14 SOL/s. A score that swings on a precise reading is a thin baseline,
// not a noisy collector - and baselines are fixed by time, not by code.
async function collectVolume() {
  const { trades, scale, spanSeconds } = await getWindowTransactions();
  const totalSol = trades.reduce((sum, event) => sum + solAmount(event), 0);

  return {
    totalSol: totalSol * scale,
    observedSol: totalSol,
    spanSeconds,
    trades: trades.length,
  };
}

// A rug can happen well after a token's creation, so we can't judge it from
// one 30-minute window alone. We keep a small watchlist on disk instead:
// every new token goes on it when created, each run folds in that run's
// trades, and a token comes off once the creator has clearly dumped (>80%
// sold, the strict definition from the README) or 24h have passed clean.
const RUG_WINDOW_MS = 24 * 60 * 60 * 1000;

function readWatchlist() {
  try {
    if (!fs.existsSync(config.rugWatchlistFile)) return [];
    const parsed = JSON.parse(fs.readFileSync(config.rugWatchlistFile, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Could not read rug watchlist:", err.message);
    return [];
  }
}

function writeWatchlist(list) {
  const dir = path.dirname(config.rugWatchlistFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(config.rugWatchlistFile, JSON.stringify(list, null, 2), "utf8");
}

// 3. How many tokens rugged?
async function collectRugs() {
  const { creates, trades } = await getWindowTransactions();
  const now = Date.now();

  const watched = new Map(
    readWatchlist().map((entry) => [`${entry.mint}:${entry.creator}`, entry])
  );

  // Start watching every token created this window. pump.fun "create"
  // transactions often bundle the creator's first buy into the same
  // transaction as the launch itself, so we credit that here too - not
  // doing this was a real bug we caught by inspecting a live create event.
  for (const create of creates) {
    const mint = pickMint(create);
    const creator = create.feePayer;
    if (!mint || !creator) continue;

    const key = `${mint}:${creator}`;
    if (!watched.has(key)) {
      watched.set(key, {
        mint,
        creator,
        bought: tokensReceivedBy(create, mint, creator),
        sold: tokensSentBy(create, mint, creator),
        createdAt: now,
      });
    }
  }

  // Fold this window's trades into whichever watched creator+token they match.
  for (const trade of trades) {
    const mint = pickMint(trade);
    const creator = trade.feePayer;
    if (!mint || !creator) continue;

    const entry = watched.get(`${mint}:${creator}`);
    if (!entry) continue; // not a wallet/token we're watching

    entry.bought += tokensReceivedBy(trade, mint, creator);
    entry.sold += tokensSentBy(trade, mint, creator);
  }

  // Judge each watched token: ruled a rug, still too young to judge, or
  // aged out clean.
  let ruggedCount = 0;
  const stillWatching = [];

  for (const entry of watched.values()) {
    const isRugged = entry.bought > 0 && entry.sold / entry.bought > 0.8;

    if (isRugged) {
      ruggedCount++; // dev dumped - resolved, stop watching
    } else if (now - entry.createdAt < RUG_WINDOW_MS) {
      stillWatching.push(entry); // inside the 24h window, keep watching
    }
    // else: 24h passed with nothing suspicious - drop it, verdict is "clean"
  }

  writeWatchlist(stillWatching);

  // "Active" tokens = tokens younger than 24h that we're still watching.
  // A closer stand-in for "how many tokens are alive right now" than any
  // single collection window could give us on its own.
  return { count: ruggedCount, activeTokens: stillWatching.length };
}

// Volatility guards, both set from live measurement rather than taste:
// trades under this much SOL are fee-and-rent noise whose implied price is
// meaningless, and a mint needs this many surviving trades before its price
// range is worth reading.
const MIN_TRADE_SOL = 0.001;
const MIN_TRADES_FOR_SWING = 5;

// Value at a percentile of an already-sorted array.
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index];
}

// 4. How wild were the price swings?
async function collectVolatility() {
  const { trades } = await getWindowTransactions();

  // Bucket every trade by token, and work out the implied price (SOL per
  // token) at that moment: sol moved / tokens moved.
  const byMint = new Map();

  for (const trade of trades) {
    const mint = pickMint(trade);
    if (!mint) continue;

    const sol = solAmount(trade);
    const tokens = tokenAmount(trade, mint);
    if (!sol || !tokens) continue;

    // Skip dust. Below this the SOL leg is mostly fees and rent rather than
    // the trade itself, so the implied price says nothing about the market -
    // and being near zero, it distorts every range it lands in.
    if (sol < MIN_TRADE_SOL) continue;

    if (!byMint.has(mint)) byMint.set(mint, { prices: [], volumeSol: 0 });
    const entry = byMint.get(mint);
    entry.prices.push(sol / tokens);
    entry.volumeSol += sol;
  }

  // Need enough trades for a range to mean anything. Three was too few: with
  // that little to go on, percentiles can't trim anything and one odd trade
  // still sets the answer.
  const topMints = [...byMint.values()]
    .filter((entry) => entry.prices.length >= MIN_TRADES_FOR_SWING)
    .sort((a, b) => b.volumeSol - a.volumeSol)
    .slice(0, 20);

  if (!topMints.length) return { avgSwingPercent: 0 };

  // The 10th and 90th percentile, not the outright min and max.
  //
  // min/max is as outlier-sensitive as a measure can be, and the outliers
  // here are real: a trade moving 0.000005 SOL against millions of tokens
  // implies a price near zero, and (max - min) / min then explodes. Measured
  // live, one mint read 288,760% on min/max against 10,374% on p10/p90, and
  // the run's overall figure came out at 24,018% - which is not a market
  // condition, it is dust.
  const swings = topMints.map(({ prices }) => {
    const sorted = [...prices].sort((a, b) => a - b);
    const low = percentile(sorted, 0.1);
    const high = percentile(sorted, 0.9);
    return low > 0 ? ((high - low) / low) * 100 : 0;
  });

  // Median, not mean - one wild token shouldn't drag the whole number.
  const avgSwingPercent = median(swings);
  return { avgSwingPercent };
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------------------------------------------------------------
// MAIN ENTRY
// ---------------------------------------------------------------

export async function collect({ mock = false } = {}) {
  if (mock) {
    return { ...mockRaw(), source: "mock" };
  }

  windowPromise = null; // start a fresh window for this run

  const [counts, volume, rugs, volatility] = await Promise.all([
    collectTokenCounts(),
    collectVolume(),
    collectRugs(),
    collectVolatility(),
  ]);

  // Volume is sampled, so it scales from the sample up to the full interval.
  // The creation and graduation counts do not: they are counted directly off
  // the chain for the whole interval, so scaling them would multiply a
  // complete number by 10. The other two don't scale either -
  // avgPriceSwingPercent is a median ratio, and the rug numbers come off a
  // watchlist that persists across runs; both already describe the whole
  // population rather than a per-minute count.
  return {
    tokensCreated: counts.created,
    tokensGraduated: counts.graduated,
    totalVolumeSol: Number(volume.totalSol.toFixed(2)),
    tokensRugged: rugs.count,
    activeTokens: rugs.activeTokens,
    avgPriceSwingPercent: volatility.avgSwingPercent,
    source: "live",
    sampleSeconds: config.sampleSeconds,
    // What the run actually saw, before scaling. Kept so a suspicious number
    // can be traced back to the size of the sample behind it.
    observedSpanSeconds: volume.spanSeconds,
    observedTrades: volume.trades,
    observedVolumeSol: Number(volume.observedSol.toFixed(2)),
  };
}

// Small helper you can use later to confirm your key works.
export async function testConnection() {
  const slot = await rpc("getSlot");
  return slot;
}
