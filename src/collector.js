// collector.js
// Reads the four things Alphet judges a memecoin on.
//
// Two sources, split by what each is actually good at:
//
//   GeckoTerminal (sources.js)  what exists, and what the market is doing -
//                               discovery, volume, liquidity, buy/sell split,
//                               symbol, age, venue. All in USD, no key.
//   Robinhood Chain RPC         everything the market data can't answer -
//                               holders, LP permanence, deployer, honeypot.
//
// Mock mode invents a believable population instead, so the gauge, the scoring
// and the page all work before touching the network. Nothing downstream knows
// which mode produced the numbers.

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { discoverTokens, apiCalls, WINDOWS } from "./sources.js";
import * as blockscout from "./blockscout.js";
import { fetchImages, apiCalls as imageCalls } from "./images.js";
import {
  SELECTOR,
  TOPIC,
  ZERO_ADDRESS,
  rpc,
  rpcBatch,
  rpcCalls,
  call,
  calldata,
  encodeAddress,
  encodeUint,
  readUint,
  readAddress,
  topicToAddress,
  blockNumber,
  blocksPerSecond,
  isAddress,
  getLogs,
  scanLogsBackwards,
} from "./chain.js";

export { rpcCalls, apiCalls };
export const indexerCalls = blockscout.apiCalls;
export { imageCalls };

// Hours each dashboard window covers, used to put every window on the same
// per-day footing before any ratio is taken.
const WINDOW_HOURS = Object.fromEntries(WINDOWS.map((w) => [w.key, w.ms / 3600000]));

// ---------------------------------------------------------------
// DISK CACHE
// ---------------------------------------------------------------
//
// Two things persist between runs:
//
//   deployers  which address deployed which token. There is no API on RHC
//              that answers "what else has this address deployed", so the
//              index is accumulated one run at a time and dev track record
//              gets better the longer Alphet has been running.
//   verdicts   whether a token we saw before is dead now. Once a token's pool
//              is empty that answer stops moving, so it is written down once.

let cache = null;

function loadCache() {
  if (cache) return cache;
  try {
    if (fs.existsSync(config.cacheFile)) {
      cache = JSON.parse(fs.readFileSync(config.cacheFile, "utf8"));
    }
  } catch (err) {
    console.error("  cache unreadable, starting fresh:", err.message);
  }
  if (!cache || typeof cache !== "object") cache = {};
  cache.deployers ||= {}; // token -> dev address
  cache.verdicts ||= {}; // token -> "alive" | "rug"
  cache.lastSeen ||= {}; // token -> ISO date, so verdicts can age
  cache.reads ||= {}; // token -> the slow-moving on-chain half, with a TTL
  return cache;
}

function saveCache() {
  if (!cache) return;
  const dir = path.dirname(config.cacheFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(config.cacheFile, JSON.stringify(cache), "utf8");
}

// ---------------------------------------------------------------
// MOCK DATA
// ---------------------------------------------------------------

function between(min, max) {
  return min + Math.random() * (max - min);
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function fakeAddress() {
  let hex = "";
  for (let i = 0; i < 40; i++) hex += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return "0x" + hex;
}

// Four archetypes, because a memecoin population is not a bell curve. Most
// launches are junk, a few are competent, and the scams are the ones that
// spend money on looking busy - which is exactly what makes the gauge move.
const ARCHETYPES = [
  { key: "clean", share: 0.12 },
  { key: "ordinary", share: 0.28 },
  { key: "sketchy", share: 0.35 },
  { key: "scam", share: 0.25 },
];

/**
 * The mix, tilted by how the market is feeling that run.
 *
 * Without this every mock run draws from the same distribution and the gauge
 * lands on Beta-heavy every single time - true to life, but useless for
 * testing, because the four other verdicts and the whole right half of the
 * seam's travel never render.
 */
function moodShares(mood) {
  const tilt = mood * 0.12;
  return ARCHETYPES.map((type) => ({
    key: type.key,
    share: Math.max(0, type.share + (type.key === "clean" || type.key === "ordinary" ? tilt : -tilt)),
  }));
}

function rollArchetype(shares) {
  const total = shares.reduce((sum, type) => sum + type.share, 0);
  let roll = Math.random() * total;
  for (const type of shares) {
    roll -= type.share;
    if (roll <= 0) return type.key;
  }
  return "ordinary";
}

const MOCK_TICKERS = [
  "HOODIE", "GREENCANDLE", "TENDIE", "APEX", "MOONHOOD", "BRRR", "DIAMONDHND",
  "PAPERHND", "ROBIN", "STONKS", "BAGHOLDR", "LIQUIDIT", "RUGPULL", "SAFEMOON2",
  "WOLFPACK", "ALPHADOG", "BETAWAVE", "CHAINSAW", "FEEDBAG", "NOSELL", "MAXPAIN",
  "COPETOWN", "EXITLIQ", "PUMPKING", "DEGENZ", "HODLER", "SNIPER", "WHALEBAIT",
];

const MOCK_DEXES = ["pons-v2", "uniswap-v2-robinhood", "uniswap-v3-robinhood", "bankr-robinhood"];

// Per-window activity for a mock token. Short windows are noisier than long
// ones - a 15-minute slice of a real market swings far more than a day does -
// so the jitter shrinks as the window grows.
function mockWindows(dayVolume, dayVolumePerHolder, shape) {
  const windows = {};

  for (const win of WINDOWS) {
    const hours = win.ms / 3600000;
    const noise = 1 + between(-1, 1) * (0.65 / Math.sqrt(hours));
    const volumeUsd = Math.max(0, (dayVolume * (hours / 24)) * noise);
    const trades = Math.max(0, Math.round((hours / 24) * between(20, 9000)));
    const buyRatio = Math.min(
      0.95,
      Math.max(0.03, between(...shape.buyRatio) + between(-1, 1) * (0.2 / Math.sqrt(hours)))
    );

    windows[win.key] = {
      volumeUsd: Number(volumeUsd.toFixed(2)),
      buys: Math.round(trades * buyRatio),
      sells: trades - Math.round(trades * buyRatio),
      trades,
      buyRatio: Number(buyRatio.toFixed(3)),
      volumePerHolder: Number((dayVolumePerHolder * noise).toFixed(2)),
    };
  }

  return windows;
}

function mockToken(index, shares) {
  const archetype = rollArchetype(shares);

  // Each archetype fixes a plausible range for all four metrics at once. A
  // token that burns its liquidity does not usually also have one wallet
  // holding 80% of supply, and drawing them independently would produce a lot
  // of tokens that cannot exist.
  const shape = {
    clean: {
      top10: [8, 24], burned: [55, 100], locked: [0, 40],
      devLaunches: [3, 14], devRugRate: [0, 0.05], buyRatio: [0.48, 0.66],
      holders: [400, 4200], volumePerHolder: [8, 90], honeypot: 0,
    },
    ordinary: {
      top10: [18, 42], burned: [0, 30], locked: [5, 50],
      devLaunches: [1, 8], devRugRate: [0, 0.2], buyRatio: [0.42, 0.58],
      holders: [120, 1400], volumePerHolder: [15, 140], honeypot: 0,
    },
    sketchy: {
      top10: [38, 68], burned: [0, 20], locked: [0, 45],
      devLaunches: [1, 22], devRugRate: [0.15, 0.45], buyRatio: [0.3, 0.5],
      holders: [30, 400], volumePerHolder: [90, 700], honeypot: 0.05,
    },
    scam: {
      top10: [62, 94], burned: [0, 5], locked: [0, 15],
      devLaunches: [2, 40], devRugRate: [0.4, 0.95], buyRatio: [0.16, 0.4],
      holders: [12, 180], volumePerHolder: [400, 2600], honeypot: 0.35,
    },
  }[archetype];

  const holderCount = Math.round(between(...shape.holders));
  const volumePerHolder = between(...shape.volumePerHolder);
  const volumeUsd = Number((holderCount * volumePerHolder).toFixed(2));
  const launches = Math.round(between(...shape.devLaunches));
  const rugs = Math.min(launches, Math.round(launches * between(...shape.devRugRate)));

  const burnedPercent = Number(between(...shape.burned).toFixed(1));
  const lockedPercent = Number(Math.min(100 - burnedPercent, between(...shape.locked)).toFixed(1));

  return {
    address: fakeAddress(),
    symbol: MOCK_TICKERS[index % MOCK_TICKERS.length],
    name: MOCK_TICKERS[index % MOCK_TICKERS.length],
    dex: pick(MOCK_DEXES),
    ageHours: Number(between(1, 720).toFixed(1)),
    archetype, // mock only - lets you sanity-check that scoring agrees

    holders: {
      top10Percent: Number(between(...shape.top10).toFixed(1)),
      holderCount,
      topHolders: [],
      partial: false,
    },
    liquidity: {
      poolAddress: fakeAddress(),
      kind: "v2",
      measurable: true,
      burnedPercent,
      lockedPercent,
      withdrawablePercent: Number(Math.max(0, 100 - burnedPercent - lockedPercent).toFixed(1)),
      lockDaysRemaining: lockedPercent > 0 ? Math.round(between(0, 400)) : 0,
      liquidityUsd: Number(between(800, 400000).toFixed(0)),
    },
    devRecord: {
      address: fakeAddress(),
      launches,
      rugs,
      known: true,
    },
    activity: {
      volumeUsd,
      buyRatio: Number(between(...shape.buyRatio).toFixed(3)),
      trades: Math.round(between(20, 9000)),
      volumePerHolder: Number(volumePerHolder.toFixed(2)),
      // Each window gets its own draw rather than a clean fraction of the day,
      // so switching timeframe on the page actually moves the gauge - which is
      // the behaviour that needs testing.
      windows: mockWindows(volumeUsd, volumePerHolder, shape),
    },
    honeypot: {
      blocked: Math.random() < shape.honeypot,
      reason: "mock",
      tested: true,
    },
  };
}

function mockRaw() {
  // A fixed range, not one derived from maxTokensPerRun. That knob is now 0
  // for "no cap", and reading it here quietly turned `between(18, 0)` into a
  // population of seven.
  const count = Math.round(between(24, 48));
  const mood = between(-1, 1);
  const shares = moodShares(mood);

  const tokens = [];
  for (let i = 0; i < count; i++) tokens.push(mockToken(i, shares));

  return {
    source: "mock",
    mood: Number(mood.toFixed(2)),
    chain: config.chainName,
    measuredAt: new Date().toISOString(),
    lookbackHours: config.lookbackHours,
    tokens,
    totals: { tokensSeen: count, tokensScored: count },
  };
}

// ---------------------------------------------------------------
// LIVE: HOLDER DISTRIBUTION
// ---------------------------------------------------------------

/**
 * What share of supply the top 10 wallets hold, and how many holders exist.
 *
 * No API on this chain will answer it - GoPlus covers only verified blue-chip
 * contracts here, which is the opposite of the population Alphet scores - so
 * the holder set is rebuilt from the token's own Transfer log and balanceOf is
 * read for each candidate in batches.
 *
 * The pool and the burn address are excluded from the ranking on purpose.
 * Almost all of a fresh memecoin's supply sits in its own liquidity pool, so
 * counting the pool as a holder would report every token on earth as 90%
 * concentrated and the metric would carry no information at all. Burned supply
 * is likewise nobody's holding - it is supply that no longer exists.
 */
export async function getHolderDistribution(tokenAddress, fromBlock, toBlock, excluded = []) {
  const skip = new Set(
    [...excluded, ...config.burnAddresses, ZERO_ADDRESS].map((a) => a.toLowerCase())
  );

  // Walked newest-first and stopped as soon as the cap is full. The most
  // recent receivers are the likeliest current holders, and a token that has
  // been trading for two months has far more history than is worth reading to
  // find them.
  const seen = new Set();
  let reachedStart = true;

  await scanLogsBackwards({
    address: tokenAddress,
    topics: [TOPIC.transfer],
    fromBlock,
    toBlock,
    onPage(logs) {
      for (const log of logs) {
        const to = topicToAddress(log.topics[2] || "");
        if (!to || skip.has(to)) continue;
        seen.add(to);
        if (seen.size >= config.maxHolderCandidates) {
          reachedStart = false;
          return false;
        }
      }
      return true;
    },
  });

  const candidates = [...seen];
  if (!candidates.length) {
    return { top10Percent: 0, holderCount: 0, topHolders: [], candidatesRead: 0 };
  }

  const [supplyHex, ...balanceHexes] = await rpcBatch([
    { method: "eth_call", params: [{ to: tokenAddress, data: SELECTOR.totalSupply }, "latest"] },
    ...candidates.map((holder) => ({
      method: "eth_call",
      params: [
        { to: tokenAddress, data: calldata(SELECTOR.balanceOf, encodeAddress(holder)) },
        "latest",
      ],
    })),
  ]);

  const totalSupply = readUint(supplyHex);
  if (totalSupply === 0n) {
    return { top10Percent: 0, holderCount: 0, topHolders: [], candidatesRead: candidates.length };
  }

  // Circulating supply, not total: burned and pooled tokens were excluded from
  // the ranking above, so leaving them in the denominator would understate
  // every holder's share by exactly the amount we just removed.
  const excludedHexes = await rpcBatch(
    [...skip]
      .filter((a) => a !== ZERO_ADDRESS)
      .map((address) => ({
        method: "eth_call",
        params: [
          { to: tokenAddress, data: calldata(SELECTOR.balanceOf, encodeAddress(address)) },
          "latest",
        ],
      }))
  );
  const parked = excludedHexes.reduce((sum, hex) => sum + readUint(hex), 0n);
  const circulating = totalSupply > parked ? totalSupply - parked : totalSupply;

  const balances = candidates
    .map((address, i) => ({ address, balance: readUint(balanceHexes[i]) }))
    .filter((h) => h.balance > 0n)
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

  const top10 = balances.slice(0, 10);
  const topSum = top10.reduce((sum, h) => sum + h.balance, 0n);

  // BigInt has no fractions, so the ratio is taken in basis points and scaled
  // back down - dividing two BigInts directly would floor every share to 0.
  const share = (amount) => Number((amount * 10000n) / circulating) / 100;

  // A capped sample cannot answer "what share do the top 10 hold".
  //
  // The numerator would be the top of however many wallets we managed to look
  // at, while the denominator is the whole circulating supply - including
  // every holder we never sampled. That is not the top 10's share; it is the
  // sampled top 10's share, and it shrinks as the sample gets thinner.
  //
  // Measured on live data: tokens where the cap bit reported a median top-10
  // of 30.6%, against 91.6% for tokens read completely. That 3x gap is the
  // sampling, not the market. PONS alone had 21,658 receivers in 24h against
  // a 400-candidate cap, so its "5% top-10" came from 1.8% of its holders -
  // and reading that as low concentration is what put the gauge on the Alpha
  // side. Reporting nothing is the only honest answer here.
  const capped = !reachedStart;

  return {
    top10Percent: capped ? null : Number(Math.min(100, share(topSum)).toFixed(2)),
    // A floor when capped: at least this many holders, not exactly this many.
    holderCount: balances.length,
    holderCountIsFloor: capped,
    topHolders: top10.map((h) => ({
      address: h.address,
      percent: capped ? null : Number(share(h.balance).toFixed(2)),
    })),
    candidatesRead: candidates.length,
    capped,
  };
}

// ---------------------------------------------------------------
// LIVE: LIQUIDITY PERMANENCE
// ---------------------------------------------------------------

// A label only. What decides whether the pool is readable is whether it
// answers totalSupply and getReserves - see checkLiquidityLocked.
//
// This used to be the decision, matched off the DEX slug, and it was wrong in
// the expensive direction: 73 of 154 pools were written off as "unrecognised"
// purely because their venue name carried no version number. Robinhood Chain
// has forty venues with names like bankr-robinhood and pons-dot-family, and
// plenty of them are ordinary V2 forks that would have answered fine.
function poolKind(dex) {
  const slug = String(dex || "").toLowerCase();
  if (/v3|v4|clmm|dlmm/.test(slug)) return "concentrated";
  if (/v2/.test(slug)) return "v2";
  return "unlabelled";
}

/**
 * Whether the liquidity can leave.
 *
 * Measured on the LP token, not on the pool's reserves: pulling liquidity
 * means burning LP tokens to redeem the underlying, so whoever holds the LP
 * supply is who can pull. Burned LP can never be redeemed, locked LP cannot be
 * until it unlocks, and everything else is a dev decision away from gone.
 */
export async function checkLiquidityLocked(poolAddress, dex) {
  const kind = poolKind(dex);

  const unmeasurable = (reason) => ({
    poolAddress: poolAddress || null,
    kind,
    measurable: false,
    reason,
    burnedPercent: null,
    lockedPercent: null,
    withdrawablePercent: null,
    lockDaysRemaining: 0,
  });

  // Not a refusal to look - a refusal to invent. Scoring drops this metric for
  // the token and renormalises the others rather than reading a pool it could
  // not open as maximally bad.
  if (kind === "concentrated") return unmeasurable("concentrated liquidity (V3/V4)");
  if (!isAddress(poolAddress)) return unmeasurable("pool identified by id, not address");

  const holders = [...config.burnAddresses, ...config.lockerAddresses];

  // Ask the pool what it is rather than inferring it from its venue's name.
  // getReserves rides along because a contract with an LP supply but no
  // reserves is not a V2 pair, whatever else it might be.
  const [supplyHex, reservesHex, ...heldHexes] = await rpcBatch([
    { method: "eth_call", params: [{ to: poolAddress, data: SELECTOR.totalSupply }, "latest"] },
    { method: "eth_call", params: [{ to: poolAddress, data: SELECTOR.getReserves }, "latest"] },
    ...holders.map((address) => ({
      method: "eth_call",
      params: [{ to: poolAddress, data: calldata(SELECTOR.balanceOf, encodeAddress(address)) }, "latest"],
    })),
  ]);

  // A failed call comes back as null, which readUint would happily turn into
  // zero - and zero LP supply means "the liquidity has already been pulled".
  // Reporting a pool we could not read as a drained pool accuses it of the
  // worst thing on the board, so the two cases are kept apart here.
  if (supplyHex === null) return unmeasurable("pool did not answer totalSupply");
  if (reservesHex === null) return unmeasurable("not an LP-token pool");

  const lpSupply = readUint(supplyHex);
  if (lpSupply === 0n) {
    // A V2 pair that answered, with no LP supply, has been fully redeemed:
    // the liquidity really is gone. That is a measurement, not a gap.
    return {
      poolAddress, kind, measurable: true, drained: true,
      burnedPercent: 0, lockedPercent: 0, withdrawablePercent: 100, lockDaysRemaining: 0,
    };
  }

  const share = (amount) => Number((amount * 10000n) / lpSupply) / 100;
  const burnCount = config.burnAddresses.length;
  const burned = heldHexes.slice(0, burnCount).reduce((sum, hex) => sum + readUint(hex), 0n);
  const locked = heldHexes.slice(burnCount).reduce((sum, hex) => sum + readUint(hex), 0n);

  const burnedPercent = Number(share(burned).toFixed(2));
  const lockedPercent = Number(share(locked).toFixed(2));

  return {
    poolAddress,
    kind,
    measurable: true,
    burnedPercent,
    lockedPercent,
    withdrawablePercent: Number(Math.max(0, 100 - burnedPercent - lockedPercent).toFixed(2)),
    // Lockers expose unlock times through contract-specific calls we cannot
    // read without each locker's ABI. Until one is wired up a lock is treated
    // as short, so scoring discounts it rather than trusting it.
    lockDaysRemaining: 0,
  };
}

// ---------------------------------------------------------------
// LIVE: DEVELOPER TRACK RECORD
// ---------------------------------------------------------------

/**
 * Who deployed this token.
 *
 * Two ways, in order of confidence: an owner() that still points somewhere,
 * then whoever received the very first mint. Neither is free of doubt - a
 * renounced token has no owner, and launchpads often mint straight to the
 * pool - so the answer is cached the first time it is found and reused.
 */
async function findDeployer(tokenAddress, fromBlock, excluded) {
  const store = loadCache();
  if (store.deployers[tokenAddress]) return store.deployers[tokenAddress];

  let dev = null;

  try {
    const owner = readAddress(await call(tokenAddress, SELECTOR.owner));
    if (owner && owner !== ZERO_ADDRESS) dev = owner.toLowerCase();
  } catch {
    // No owner() at all is normal - plenty of tokens don't implement it.
  }

  if (!dev) {
    try {
      const mints = await getLogs({
        address: tokenAddress,
        topics: [TOPIC.transfer, "0x" + "0".repeat(64)],
        fromBlock,
        toBlock: fromBlock + 20000,
      });
      for (const log of mints) {
        const to = topicToAddress(log.topics[2] || "");
        if (to && to !== ZERO_ADDRESS && !excluded.has(to)) {
          dev = to;
          break;
        }
      }
    } catch {
      // A token whose creation block we mis-estimated just has no deployer.
    }
  }

  if (dev) store.deployers[tokenAddress] = dev;
  return dev;
}

/**
 * How many tokens this deployer has launched, and how many are dead now.
 *
 * There is no API on RHC that answers this, so the index is ours: every run
 * records the deployer of everything it scored, and every token we have seen
 * before gets a verdict once its pool empties. That means the metric starts
 * out knowing nothing and gets sharper the longer Alphet runs - a first run
 * reports every dev as unproven, which is honest rather than wrong.
 */
export function getDevTrackRecord(devAddress, currentToken) {
  const store = loadCache();
  if (!devAddress) return { address: null, launches: 0, rugs: 0, known: false };

  const theirs = Object.entries(store.deployers)
    .filter(([token, dev]) => dev === devAddress && token !== currentToken)
    .map(([token]) => token);

  const rugs = theirs.filter((token) => store.verdicts[token] === "rug").length;

  return {
    address: devAddress,
    launches: theirs.length,
    rugs,
    known: true,
    // How much of the index this verdict stands on, so a confident-looking
    // "0 rugs" can be read against how little we have actually seen.
    indexSize: Object.keys(store.deployers).length,
  };
}

// A token we have seen before whose pool has since emptied is a rug, and that
// verdict never needs revisiting. Run over the discovery feed each time.
function recordVerdicts(pools) {
  const store = loadCache();
  const now = new Date().toISOString();
  const live = new Set(pools.map((p) => p.address));

  for (const pool of pools) {
    store.lastSeen[pool.address] = now;
    // Still trading with real depth - alive, and may recover from a dip, so
    // this is refreshed rather than frozen.
    if (pool.liquidityUsd >= config.thresholds.minLiquidityUsd) {
      store.verdicts[pool.address] = "alive";
    } else if (store.verdicts[pool.address] === "alive") {
      store.verdicts[pool.address] = "rug";
    }
  }

  // Tokens we knew about that have dropped out of the feed entirely have no
  // pool worth listing any more.
  for (const token of Object.keys(store.deployers)) {
    if (!live.has(token) && store.verdicts[token] === undefined) {
      store.verdicts[token] = "rug";
    }
  }
}

// ---------------------------------------------------------------
// LIVE: HONEYPOT CHECK
// ---------------------------------------------------------------

/**
 * Can a holder actually get out?
 *
 * Simulated, never sent: eth_call runs the transfer against current state and
 * discards it, so this costs nothing and moves nothing. The destination is the
 * pool, because that is the first leg of a real sell and the leg honeypots
 * block - plenty allow wallet-to-wallet transfers and revert only when the
 * recipient is the pair.
 *
 * A pass is not a guarantee. Sell taxes, per-block limits and cooldowns all
 * let a transfer through and still take the exit away, and a contract that can
 * be flipped by its owner passes right up until it is flipped.
 */
/**
 * Bumped whenever the rules below change what "blocked" means.
 *
 * Honeypot verdicts are cached with the rest of a token's slow-moving reads,
 * for thirty days - so without this, a verdict reached by a previous version
 * of these rules outlives the fix by a month. That was tolerable while the
 * flag only nudged one metric of four. It is not tolerable now that a blocked
 * verdict forces a token to the Beta side on its own.
 *
 *   1 - every error read as a honeypot, transport failures included
 *   2 - only a revert the node actually evaluated counts
 */
export const HONEYPOT_LOGIC_VERSION = 2;

export async function checkHoneypot(tokenAddress, destination, holder, balance) {
  if (!holder || !balance || balance === 0n) {
    return { blocked: false, reason: "no holder to test from", tested: false };
  }

  // The destination has to be a real account. On Uniswap V4 the "pool" is a
  // 32-byte id against a singleton rather than a contract, and sending to a
  // padded id reverts every time - which reads as a honeypot and is not one.
  if (!isAddress(destination)) {
    return { blocked: false, reason: "no pair address to simulate a sell to", tested: false };
  }

  // A tenth of one holder's balance: big enough to trip a max-transaction
  // limit a real seller would hit, small enough not to trip one only a whale
  // would.
  const amount = balance / 10n || 1n;

  try {
    const result = await call(
      tokenAddress,
      calldata(SELECTOR.transfer, encodeAddress(destination), encodeUint(amount)),
      holder
    );

    // Some tokens don't revert - they return false, which a router reads as a
    // failed sell just the same.
    if (result && result !== "0x" && readUint(result) === 0n) {
      return { blocked: true, reason: "transfer returned false", tested: true };
    }
    return { blocked: false, reason: "sell simulated ok", tested: true };
  } catch (err) {
    const message = err.message || "";

    // Only a revert says anything about the token. Everything else that lands
    // here - a timeout, a 429, a dropped connection, a node refusing the
    // request - is a fact about our connection, and calling it a failed sell
    // is the same mistake this project has now made three times: treating a
    // measurement that did not happen as a measurement that came back bad.
    //
    // It matters more than it used to. This flag now forces a token to the
    // Beta side on its own, so a rate-limited run could otherwise convict a
    // third of the board on nothing.
    //
    // The test is deliberately narrow: the node has to have evaluated the
    // call (RPC eth_call:) AND said the execution itself failed. Anything we
    // do not positively recognise reads as untested, which neither rescues a
    // bad token nor sinks a good one.
    const evaluated = /^RPC eth_call:/.test(message);
    const reverted = /revert|VM Exception|invalid opcode|out of gas/i.test(message);

    if (evaluated && reverted) {
      return { blocked: true, reason: message.slice(0, 120), tested: true };
    }

    return {
      blocked: false,
      reason: "sell could not be simulated: " + message.slice(0, 90),
      tested: false,
    };
  }
}

// ---------------------------------------------------------------
// LIVE: PUTTING IT TOGETHER
// ---------------------------------------------------------------

// The slow-moving half of a token's reading, kept between runs.
//
// Without this, doubling how many tokens we cover doubles every run's cost
// forever. With it, the first run pays for everything and later ones only
// re-read what has gone stale - which is what makes a 150-token sweep of the
// whole chain affordable at all.
function cachedRead(address, ageHours) {
  const store = loadCache();
  const entry = (store.reads ||= {})[address];
  if (!entry) return null;

  // A launch's holder set changes by the minute, and that is exactly when the
  // reading matters most - so new tokens never come from cache.
  if (ageHours !== null && ageHours < config.newTokenHours) return null;

  const ageMs = Date.now() - new Date(entry.at).getTime();
  return ageMs < config.readCacheMinutes * 60000 ? entry : null;
}

function storeRead(address, data) {
  const store = loadCache();
  (store.reads ||= {})[address] = { at: new Date().toISOString(), ...data };
}

/**
 * Fill in the logos GeckoTerminal doesn't carry, from DexScreener.
 *
 * About half the tokens on this chain come back with no image, and a table
 * that is half monograms reads like the page is failing rather than like the
 * tokens being new. Results are remembered permanently - a logo is not
 * something that changes - so this only ever asks about tokens it has never
 * looked up.
 */
async function fillMissingImages(pools) {
  const store = loadCache();
  store.images ||= {};

  for (const pool of pools) {
    if (!pool.imageUrl && store.images[pool.address]) pool.imageUrl = store.images[pool.address];
  }

  const unknown = pools
    .filter((pool) => !pool.imageUrl && store.images[pool.address] === undefined)
    .map((pool) => pool.address);

  if (!unknown.length) return;

  const found = await fetchImages(unknown);
  for (const address of unknown) {
    // null is remembered too, so a token with no logo anywhere is not looked
    // up again on every run.
    store.images[address] = found.get(address) || null;
  }
  for (const pool of pools) {
    if (!pool.imageUrl) pool.imageUrl = store.images[pool.address] || null;
  }

  console.log(`  logos: filled ${found.size} of ${unknown.length} missing from DexScreener`);
}

async function readToken(pool, ctx) {
  const { head, blocksPerSec, rank = 0 } = ctx;

  // Highest volume first, so the indexer budget goes where the gauge is
  // actually weighted. Everything past the cut still gets the RPC path.
  const mayUseIndexer = blockscout.enabled() && rank < config.indexerTokenLimit;

  // GeckoTerminal knows exactly when the pool opened, which saves guessing how
  // far back the Transfer log goes. For anything older than the lookback the
  // replay is clipped - a token trading for two months has more history than
  // a public RPC will page through, and the recent window still holds whoever
  // is currently active.
  const ageHours = pool.ageHours === null ? config.lookbackHours : pool.ageHours;
  const createdBlock = Math.max(1, head - Math.round(blocksPerSec * ageHours * 3600));
  const windowBlock = Math.max(1, head - Math.round(blocksPerSec * config.lookbackHours * 3600));

  const fromBlock = Math.max(createdBlock, windowBlock);
  const partial = createdBlock < windowBlock;

  const excluded = new Set([pool.poolAddress, ...config.burnAddresses.map((a) => a.toLowerCase())]);

  const reuse = cachedRead(pool.address, pool.ageHours);
  let holders;
  let liquidity;
  let honeypot;
  let dev;

  if (reuse) {
    ({ holders, liquidity, honeypot, dev } = reuse);

    // The expensive half of a cached read - holders, liquidity, the deployer -
    // is unaffected by a change to the honeypot rules, so only the honeypot is
    // re-tested. One eth_call against a token whose verdict was reached under
    // rules we no longer trust, rather than throwing away a holder enumeration
    // that cost far more to obtain.
    // Only a guilty verdict needs revisiting. Version 2 blocks a strict
    // subset of what version 1 blocked - it removed reasons, it added none -
    // so anything the old rules cleared, the new rules clear too. Re-testing
    // those as well would cost two calls on every one of ~835 cached tokens
    // to confirm answers that cannot have changed.
    if ((reuse.hpVersion || 1) < HONEYPOT_LOGIC_VERSION && honeypot?.blocked) {
      const stale = holders?.topHolders?.[0];
      const staleBalanceHex = stale
        ? await call(pool.address, calldata(SELECTOR.balanceOf, encodeAddress(stale.address)))
        : null;

      honeypot = await checkHoneypot(
        pool.address,
        pool.poolAddress,
        stale?.address,
        staleBalanceHex ? readUint(staleBalanceHex) : 0n
      );

      storeRead(pool.address, {
        ...reuse,
        honeypot,
        hpVersion: HONEYPOT_LOGIC_VERSION,
      });
    }
  } else {
    // Sequential rather than Promise.all. Both are chains of batched calls,
    // and the RPC gate serialises them anyway - running them "concurrently"
    // only interleaves two tokens' worth of requests into the same rate window.
    //
    // The indexer answers holders and the deployer outright when a key is set.
    // The RPC fallback below still runs otherwise, but it cannot enumerate a
    // busy token's holders and says so rather than guessing.
    holders = mayUseIndexer
      ? await blockscout
          .getHolderDistribution(pool.address, [pool.poolAddress])
          .catch(async (err) => {
            // Said once, not once per token: a fatal error has already
            // switched the indexer off for the rest of the run.
            if (err.fatal) console.error(`
  ${err.message} - falling back to RPC for the rest of this run.
`);
            else console.error(`  blockscout holders failed for ${pool.symbol}: ${err.message}`);
            return getHolderDistribution(pool.address, fromBlock, head, [pool.poolAddress]);
          })
      : await getHolderDistribution(pool.address, fromBlock, head, [pool.poolAddress]);

    liquidity = await checkLiquidityLocked(pool.poolAddress, pool.dex);

    dev = mayUseIndexer
      ? await blockscout.getCreator(pool.address).catch(() => null)
      : null;
    if (!dev) dev = await findDeployer(pool.address, createdBlock, excluded);

    // The honeypot test needs a wallet that actually holds something to send
    // from, so it borrows the top holder found above.
    const top = holders.topHolders[0];
    const topBalanceHex = top
      ? await call(pool.address, calldata(SELECTOR.balanceOf, encodeAddress(top.address)))
      : null;

    honeypot = await checkHoneypot(
      pool.address,
      pool.poolAddress,
      top?.address,
      topBalanceHex ? readUint(topBalanceHex) : 0n
    );

    if (dev) loadCache().deployers[pool.address] = dev;
    storeRead(pool.address, {
      holders,
      liquidity,
      honeypot,
      hpVersion: HONEYPOT_LOGIC_VERSION,
      dev: dev || null,
    });
  }

  // Recomputed every run even when the reads are reused: it is a local lookup
  // against the deployer index, which grows as other tokens are scored, so a
  // cached dev can pick up a rug that only came to light this run.
  const devRecord = getDevTrackRecord(dev, pool.address);

  const holderCount = Math.max(1, holders.holderCount);

  // Volume per holder has to be comparable across windows, so each one is
  // scaled to a daily rate before dividing. Without that a 15-minute window
  // would always look 96x healthier than a 24-hour one purely because less
  // time passed in it.
  const windows = {};
  for (const [key, data] of Object.entries(pool.windows)) {
    const perDay = data.volumeUsd * (24 / WINDOW_HOURS[key]);
    windows[key] = {
      ...data,
      volumePerHolder: Number((perDay / holderCount).toFixed(2)),
    };
  }

  return {
    address: pool.address,
    symbol: pool.symbol,
    name: pool.name,
    dex: pool.dex,
    ageHours: pool.ageHours,
    poolAddress: pool.poolAddress,
    imageUrl: pool.imageUrl || null,

    holders: { ...holders, partial },
    liquidity: { ...liquidity, liquidityUsd: pool.liquidityUsd },
    devRecord,
    activity: {
      volumeUsd: pool.volumeUsd,
      buyRatio: pool.buyRatio,
      trades: pool.trades,
      volumePerHolder: windows.h24.volumePerHolder,
      windows,
    },
    honeypot,
  };
}

// ---------------------------------------------------------------
// MAIN ENTRY
// ---------------------------------------------------------------

export async function collect({ mock = false } = {}) {
  if (mock) return mockRaw();

  const store = loadCache();
  store.universe ||= [];
  store.dexCursor ||= 0;

  const found = await discoverTokens({ known: store.universe, dexCursor: store.dexCursor });
  const pools = found.pools;

  // The universe is remembered so the rotating venue sweep accumulates instead
  // of starting over: run one sees the ranked feeds plus eight venues, and a
  // few runs later it has the whole chain - after which refreshing all of it
  // costs about nine API calls.
  store.universe = found.universe;
  store.dexCursor = found.dexCursor;

  console.log(
    `  discovery: ${pools.length} tokens ` +
      `(${found.sweptThisRun} from this run's venue sweep, ${found.refreshed} refreshed from memory)`
  );

  await fillMissingImages(pools);

  recordVerdicts(pools);

  // Thin pools are dropped before anything is spent on them: below a few
  // hundred dollars a single trade moves the price, so the volume, the buy/
  // sell split and the price are all noise rather than a market.
  const tradeable = pools.filter(
    (pool) => pool.liquidityUsd >= config.thresholds.minLiquidityUsd
  );

  // Highest volume first. The sort matters even without a cap: if a run is
  // interrupted or the indexer starts refusing halfway through, what is
  // already read is the half that carries the money.
  const ranked = [...tradeable].sort((a, b) => b.volumeUsd - a.volumeUsd);
  const shortlist = config.maxTokensPerRun > 0
    ? ranked.slice(0, config.maxTokensPerRun)
    : ranked;

  const head = await blockNumber();
  const blocksPerSec = await blocksPerSecond(head);
  const ctx = { head, blocksPerSec };

  const tokens = [];
  const skipped = [];

  // Sequential on purpose. Each token is already dozens of batched calls, and
  // firing forty tokens' worth at a public endpoint at once is the reliable
  // way to get every one of them rate-limited.
  // Progress is reported, and the cache is flushed as it goes.
  //
  // Both because a full sweep is a long job: an uncapped run is several
  // hundred tokens at a few seconds each, and one that printed nothing for an
  // hour was indistinguishable from one that had hung. Flushing also means
  // stopping a run keeps the reads it already paid for, so a restart resumes
  // instead of starting over.
  const started = Date.now();
  const CHECKPOINT_EVERY = 25;

  for (const [index, pool] of shortlist.entries()) {
    try {
      tokens.push(await readToken(pool, { ...ctx, rank: index }));
    } catch (err) {
      console.error(`  skipped ${pool.symbol} (${pool.address}): ${err.message}`);
      skipped.push({ symbol: pool.symbol, address: pool.address, reason: err.message.slice(0, 120) });
    }

    const done = index + 1;
    if (done % CHECKPOINT_EVERY === 0 || done === shortlist.length) {
      saveCache();

      const elapsed = (Date.now() - started) / 1000;
      const perToken = elapsed / done;
      const left = Math.round((shortlist.length - done) * perToken);
      console.log(
        `  scored ${done}/${shortlist.length}` +
          ` (${Math.round((done / shortlist.length) * 100)}%)` +
          ` - ${perToken.toFixed(1)}s/token, ~${Math.max(0, Math.round(left / 60))} min left`
      );
    }
  }

  saveCache();

  // A run that lost most of its shortlist is not a quiet market, it is a
  // failed measurement - and the two look identical unless it is said out
  // loud. The shortlist is ordered by volume, so dropped tokens reshape the
  // sample rather than just shrinking it.
  if (skipped.length) {
    const share = Math.round((skipped.length / shortlist.length) * 100);
    console.error(
      `\n  WARNING: ${skipped.length} of ${shortlist.length} tokens (${share}%) could not be read.\n` +
        `  The reading below is that much less of the market than it looks.\n`
    );
  }

  return {
    source: "live",
    chain: config.chainName,
    measuredAt: new Date().toISOString(),
    lookbackHours: config.lookbackHours,
    headBlock: head,
    tokens,
    totals: {
      tokensSeen: pools.length,
      tokensTradeable: tradeable.length,
      tokensShortlisted: shortlist.length,
      tokensScored: tokens.length,
      tokensSkipped: skipped.length,
    },
    skipped,
  };
}

/** Small helper to confirm the endpoints work. */
export async function testConnection() {
  const chainId = await rpc("eth_chainId");
  const { pools } = await discoverTokens({ dexCursor: 0 });
  return { chainId: Number(readUint(chainId)), block: await blockNumber(), pools: pools.length };
}
