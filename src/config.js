// config.js
// Loads settings from the .env file and holds all the tuneable numbers
// for the Alphet quality gauge in one place.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, "..");

// --- tiny .env loader (so we don't need the dotenv package) ---
function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnv();

function list(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  // --- Robinhood Chain ---
  // An Arbitrum Orbit L2 (chain id 4663), so it speaks plain Ethereum
  // JSON-RPC. The public endpoint below is verified working; point this at
  // your own node or a provider if it starts rate-limiting.
  rpcUrl: process.env.RHC_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
  chainId: Number(process.env.RHC_CHAIN_ID || 4663),
  chainName: process.env.RHC_CHAIN_NAME || "Robinhood Chain",

  explorerUrl: (process.env.RHC_EXPLORER_URL || "").replace(/\/$/, ""),

  // --- Blockscout, the official RHC indexer ---
  //
  // Optional, but it is what makes two of the four metrics work at all. A
  // public RPC cannot enumerate the holders of a busy token - PONS had 21,658
  // receivers in 24h - so without a key here, holder distribution is reported
  // "not measurable" for every large token and developer track record falls
  // back to a deployer lookup that misses about three quarters of the time.
  //
  // Free tier at dev.blockscout.com is 100,000 credits a MONTH, and each call
  // costs 20 - so 5,000 calls a month in total, not the per-day budget the
  // docs suggest. Measured: one run asking about every token spent 1,000
  // calls, a fifth of the month. indexerTokenLimit and readCacheMinutes are
  // what keep it inside that.
  blockscoutKey: process.env.BLOCKSCOUT_API_KEY || "",
  get blockscoutBase() {
    return process.env.BLOCKSCOUT_BASE || `https://api.blockscout.com/${this.chainId}/api/v2`;
  },

  // GeckoTerminal's slug for this chain. It is where Alphet finds out which
  // tokens exist at all, so nothing runs live without it.
  network: process.env.GT_NETWORK || "robinhood",

  // How much of each feed to read. One page is 20 pools.
  //   new pools -> this morning's launches
  //   top pools -> where the money already is
  newPoolPages: Number(process.env.NEW_POOL_PAGES || 3),
  topPoolPages: Number(process.env.TOP_POOL_PAGES || 2),

  // The venue sweep, which is what makes the reading market-wide rather than a
  // leaderboard. The network-wide feeds are ranked and top out around 70
  // unique tokens; asking each of the chain's ~40 venues for its own pools
  // reaches several hundred, because a token that is 400th by network volume
  // can still be 3rd on the DEX it launched on.
  //
  // The sweep rotates: this many venues per run, resuming where the last one
  // stopped. 0 sweeps all of them every run.
  //
  // Rotating costs nothing in coverage, which is the part worth being clear
  // about. Every pool the sweep finds is remembered in the universe cache and
  // re-priced on every later run through /pools/multi, which returns 30 pools
  // per call. So rotation only changes how quickly a brand-new venue is first
  // noticed - not how much of the chain each reading covers.
  //
  // It has to rotate because the sweep is the one expensive thing left: forty
  // venues at two pages is ~80 calls, and measured against the live API that
  // saturated the limit so badly it managed about one useful call every
  // seventy seconds. Fourteen a run covers every venue inside three runs.
  dexSweepSize: Number(process.env.DEX_SWEEP_SIZE || 14),
  dexPages: Number(process.env.DEX_PAGES || 2),

  // Extra tokens to treat as quote assets and never score. Quote tokens are
  // detected from the feed automatically; this is only for anything that
  // slips through (a stablecoin that trades as a base against WETH, say).
  quoteTokens: list(process.env.QUOTE_TOKENS),

  intervalMinutes: Number(process.env.INTERVAL_MINUTES || 180),

  // The zone every timestamp is shown in - the dashboard, the console report
  // and npm run history all read from here, so they can never disagree about
  // what hour a reading belongs to.
  displayTimeZone: process.env.DISPLAY_TZ || "America/Chicago",

  port: Number(process.env.PORT || 3000),

  // Mock runs write to their own file.
  //
  // They used to share this one, and that quietly destroyed real readings:
  // appending a mock snapshot strips the token list off the previous one (only
  // the newest keeps it), so deleting the mock afterwards left the real
  // reading permanently hollowed out. Demo data and measurements should never
  // have been able to touch each other.
  dataFile: path.join(
    ROOT,
    "data",
    process.argv.includes("--mock") ? "snapshots-mock.json" : "snapshots.json"
  ),

  // Dev track records barely change, so they are accumulated on disk rather
  // than re-derived. There is no API on RHC that answers "what else has this
  // address deployed", so the index is built up one run at a time.
  cacheFile: path.join(ROOT, "data", "chain-cache.json"),

  // Addresses that count as "liquidity can never come back out".
  // Burn addresses are universal; locker contracts are chain-specific and have
  // to be added by hand.
  burnAddresses: [
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dEaD",
  ],
  lockerAddresses: list(process.env.RHC_LOCKERS),

  // --- Cost control ---
  //
  // 0 means no cap: score everything discovery finds that is tradeable.
  //
  // This used to be the binding constraint, because holders were rebuilt from
  // each token's Transfer log at roughly 975 RPC calls apiece. With the indexer
  // answering holders directly that fell to about two, so a cap now costs
  // coverage without buying anything. Set a number only to bound wall time.
  maxTokensPerRun: Number(process.env.MAX_TOKENS_PER_RUN || 0),

  // Only used by the RPC fallback, when there is no Blockscout key. It cannot
  // be raised far enough to matter - PONS has 90,780 holders - which is why
  // that path reports "not measurable" instead of a number from a thin sample.
  maxHolderCandidates: Number(process.env.MAX_HOLDER_CANDIDATES || 400),

  // How long an on-chain read stays good for.
  //
  // This is what makes a wide reading affordable. Holder distribution, LP
  // permanence and the deployer are slow-moving facts - a token's top-10 share
  // does not meaningfully change in an hour - while volume and buy/sell
  // pressure move constantly and come free from the market feed. So the
  // expensive half is cached and the cheap half is always fresh, and raising
  // maxTokensPerRun costs a lot on the first run and little on the ones after.
  //
  // Tokens younger than newTokenHours are always re-read: a launch's holder
  // set changes by the minute, which is exactly when it matters most.
  //
  // Everything older is cached for a month. That is deliberate rather than
  // lazy - an established token's top-10 share barely moves week to week,
  // while re-reading it every few hours is what burned a monthly API budget
  // in a single day.
  readCacheMinutes: Number(process.env.READ_CACHE_MINUTES || 43200),
  newTokenHours: Number(process.env.NEW_TOKEN_HOURS || 24),

  // How many tokens per run may use the indexer, highest volume first.
  //
  // Blockscout's free tier is 100,000 credits a month and every call costs 20
  // - so 5,000 calls a month, total. A full run asking about every token spent
  // 1,000 of them, a fifth of the month, in one go.
  //
  // The gauge is volume-weighted, so this costs very little: tokens outside
  // the top of the book move the seam by almost nothing, and they still get
  // the RPC path, which reports "not measurable" rather than guessing. Between
  // this and the long cache, steady-state spend is only what new arrivals cost.
  indexerTokenLimit: Number(process.env.INDEXER_TOKEN_LIMIT || 100),

  // How many calls ride in one HTTP request, and the minimum gap between
  // requests. The public endpoint counts requests rather than the calls inside
  // them, but rejects batches that are too large outright - so these two trade
  // against each other and both were set by watching it 429.
  //
  // Raise the batch and drop the delay if you move to your own node.
  rpcBatchSize: Number(process.env.RPC_BATCH_SIZE || 20),
  rpcMinDelayMs: Number(process.env.RPC_MIN_DELAY_MS || 250),

  // How many blocks one eth_getLogs asks for before it is split. Measured
  // against the public endpoint: 100k spans return in about 1.6s, 300k time
  // out, and any query matching 10,000 logs is rejected. chain.js halves on
  // either failure, so this is a starting point rather than a limit.
  logPageBlocks: Number(process.env.LOG_PAGE_BLOCKS || 100000),

  // How far back the holder replay reads, for tokens older than that.
  lookbackHours: Number(process.env.LOOKBACK_HOURS || 24),

  // --- Scoring weights ---
  // How much each of the four metrics counts toward a token's quality score.
  // Must add up to 1.0.
  weights: {
    holderDistribution: 0.3, // concentrated supply is the loudest scam tell
    liquidityPermanence: 0.3, // liquidity a dev can pull is the actual exit
    devTrackRecord: 0.2, // a repeat rugger will do it again
    rugSignals: 0.2, // the live warning signs, combined
  },

  // A token scoring at or above this is Alpha; below it is Beta.
  // Deliberately above the midpoint: "not obviously a scam" is not the same
  // as good.
  alphaCutoff: Number(process.env.ALPHA_CUTOFF || 55),

  // --- Metric thresholds ---
  // Absolute rather than relative to our own history. "The top 10 wallets hold
  // 62% of supply" means something on its own, so a first-ever run is already
  // a real reading and two runs a month apart are directly comparable.
  thresholds: {
    // Top 10 holders as a share of circulating supply.
    top10GoodPercent: 15,
    top10BadPercent: 70,

    // A lock this far out counts as good as a burn; anything shorter is
    // discounted toward the day it unlocks.
    fullLockDays: 180,

    // 24h volume per holder, in USD - GeckoTerminal prices every pool, so
    // unlike the on-chain reads this one has a real currency to live in.
    // A genuine holder base trades tens of dollars each per day; far above
    // that and the volume is a few wallets cycling size to draw a chart.
    healthyVolumePerHolder: 60,
    suspiciousVolumePerHolder: 900,

    // Share of trades that are buys. Half is neutral; below `bad` the token is
    // being distributed into whoever is left.
    buyPressureGood: 0.55,
    buyPressureBad: 0.35,

    // Below this many holders one wallet moves every ratio we compute, so the
    // numbers stop describing a market.
    minHolders: 25,

    // Pools thinner than this are skipped entirely. 0 scores everything with
    // a pool at all.
    //
    // Nothing is lost by opening it up: the gauge is volume-weighted, so a
    // token with no money in it moves the seam by nothing either way. What it
    // does change is the token counts and the table, which is the point - the
    // structural metrics (supply, liquidity, dev record) are perfectly real
    // for a token nobody is trading, and those are often the ones worth
    // seeing. The trading signals guard themselves via minTradesForSignal.
    minLiquidityUsd: Number(process.env.MIN_LIQUIDITY_USD || 0),

    // Trades a window needs before its buy/sell split and volume-per-holder
    // mean anything. Below this the time-to-rug metric reports nothing rather
    // than scoring silence as health.
    minTradesForSignal: Number(process.env.MIN_TRADES_FOR_SIGNAL || 10),
  },

  // Where the gauge seam sits. alphaWeight is the share of money flowing into
  // Alpha-side tokens, so these cutoffs name the picture rather than change it.
  verdictThresholds: {
    alphaHeavy: 65,
    alphaLean: 55,
    betaLean: 45,
    betaHeavy: 35,
  },
};
