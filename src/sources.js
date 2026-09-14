// sources.js
// GeckoTerminal, which is where Alphet finds out what exists.
//
// This replaced a launchpad-by-launchpad scan that needed each venue's
// contract address and the topic0 of its token-created event, filled in by
// hand. Robinhood Chain has no launchpad registry to look those up in, so
// that design could not run at all until someone did the archaeology - and it
// only ever covered the venues that had been done.
//
// Reading new pools instead inverts it: every memecoin has to open a pool to
// be tradeable, so the pool feed catches every launch on the chain whatever
// door it came through. That is Alphet's actual scope, and it needs no
// configuration.
//
// What this does NOT give us is holders, LP locks, or whether a sell goes
// through. Those are read on-chain in collector.js. GoPlus was measured as an
// alternative and only answers for verified blue-chip contracts (1 of the 8
// largest tokens on RHC, and none of the new ones), which is the exact
// opposite of the population Alphet scores.

import { config } from "./config.js";

const BASE = "https://api.geckoterminal.com/api/v2";

export const apiCalls = { count: 0 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The free tier allows 30 calls a minute and answers 429 rather than queueing.
// The budget is per MINUTE, so a short retry just burns another call against
// the same exhausted window - the waits below are sized to outlast it.
const BACKOFF_MS = [5000, 20000, 45000];

// 30 a minute is one every two seconds, so requests are paced to that rather
// than fired and retried.
//
// This matters more than it sounds. Sweeping forty venues means forty calls,
// and sending them back-to-back spends the whole minute's budget in a few
// seconds and then sits in escalating backoff - measured, that turned a
// 90-second sweep into one that had not finished after seven minutes. Pacing
// is strictly faster than being throttled.
const MIN_INTERVAL_MS = 2200;
const REQUEST_TIMEOUT_MS = 45000;

let gate = Promise.resolve();
let lastCallAt = 0;

// Extra delay this run has earned by being throttled.
//
// A fixed 2.2s pace is right when the budget really is 30/minute, but the
// limit that applies to a given key and endpoint is not always that - and when
// it is lower, a fixed pace means every call 429s, waits out the ladder, and
// succeeds once before doing it again. Measured on a forty-venue sweep that
// came to about one useful call every seventy seconds, which would have taken
// an hour and a half.
//
// So the pace adapts: every 429 slows the rest of the run, and a clean run of
// successes slowly speeds it back up. It settles near whatever the real limit
// is instead of arguing with it.
let pacePenaltyMs = 0;
let cleanStreak = 0;

async function send(url) {
  const wait = MIN_INTERVAL_MS + pacePenaltyMs - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);

  for (let attempt = 0; ; attempt++) {
    lastCallAt = Date.now();
    apiCalls.count++;

    // Node's fetch has no default timeout and everything here queues behind
    // one gate, so a hung connection stops the run rather than slowing it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    } catch (err) {
      if (attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      throw new Error(`GeckoTerminal unreachable: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      // Twenty clean calls in a row buys back a little speed.
      if (++cleanStreak >= 20 && pacePenaltyMs > 0) {
        pacePenaltyMs = Math.max(0, pacePenaltyMs - 500);
        cleanStreak = 0;
      }
      return res.json();
    }

    if (res.status === 429) {
      cleanStreak = 0;
      pacePenaltyMs = Math.min(pacePenaltyMs + 900, 12000);
    }

    if (res.status === 429 && attempt < BACKOFF_MS.length) {
      // Prefer the server's own answer when it gives one.
      const after = Number(res.headers.get("retry-after"));
      const pause = Number.isFinite(after) && after > 0 ? after * 1000 : BACKOFF_MS[attempt];
      console.warn(
        `  GeckoTerminal rate-limited, waiting ${Math.round(pause / 1000)}s ` +
          `(pace now ${((MIN_INTERVAL_MS + pacePenaltyMs) / 1000).toFixed(1)}s/call)`
      );
      await sleep(pause);
      continue;
    }

    // 5xx is the server failing, not us asking too often - and under the kind
    // of load that produces heavy 429s it is exactly what a gateway returns.
    //
    // This used to throw on anything that was not a 429, so one 504 ended the
    // whole run. It happened twice: the 10:33 scheduled run on Sep 11, and a
    // manual run on Sep 14 that had ridden out nine rate limits over nine
    // minutes of discovery and then died on a single gateway timeout, before
    // reading one token. chain.js has retried 5xx since the same lesson was
    // learned there; this client never got the same treatment.
    //
    // It does not touch the pace. A 5xx says nothing about how fast we are
    // going, and slowing the rest of the run for it would only lengthen a
    // job that is already the thing most at risk of running out of time.
    if (res.status >= 500 && attempt < BACKOFF_MS.length) {
      const pause = BACKOFF_MS[attempt];
      console.warn(`  GeckoTerminal answered HTTP ${res.status}, retrying in ${Math.round(pause / 1000)}s`);
      await sleep(pause);
      continue;
    }

    throw new Error(`GeckoTerminal returned HTTP ${res.status}`);
  }
}

function get(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  // Queue rather than race, and keep the gate alive when one call fails so a
  // single error doesn't wedge everything behind it.
  const result = gate.then(() => send(url));
  gate = result.then(() => {}, () => {});
  return result;
}

// The timeframes the dashboard offers, mapped onto GeckoTerminal's own keys.
// It also publishes m5 and m30; four buttons is already the most a gauge can
// carry without turning into a trading terminal.
export const WINDOW_SOURCE = { m15: "m15", h1: "h1", h6: "h6", h24: "h24" };

export const WINDOWS = [
  { key: "m15", label: "15m", ms: 15 * 60 * 1000 },
  { key: "h1", label: "1h", ms: 60 * 60 * 1000 },
  { key: "h6", label: "6h", ms: 6 * 60 * 60 * 1000 },
  { key: "h24", label: "24h", ms: 24 * 60 * 60 * 1000 },
];

// Token ids come back namespaced, e.g. "robinhood_0xabc…". Everything
// downstream wants a plain address.
function bareAddress(id) {
  return String(id || "").split("_").pop().toLowerCase();
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function usableImage(url) {
  if (!url || typeof url !== "string") return null;
  return /missing\.png|\/missing/i.test(url) ? null : url;
}

/**
 * Flatten one pool into the shape the collector works in.
 *
 * `included` carries the base token and DEX records when the request asked for
 * them, which is how a symbol and a venue name arrive without an extra call
 * each - and without an eth_call for symbol()/name() per token.
 */
function normalize(pool, byId) {
  const a = pool.attributes || {};
  const rel = pool.relationships || {};

  const baseId = rel.base_token?.data?.id;
  const baseToken = byId.get(baseId);
  const address = bareAddress(baseId);
  if (!address) return null;

  // GeckoTerminal reports volume and the buy/sell split at six granularities.
  // Taking all of them is what lets the dashboard offer real timeframes: a
  // 15-minute window is measured data here, where rolling it up from stored
  // snapshots would need the collector to run every few minutes - which the
  // RPC side cannot afford.
  const windows = {};
  for (const [key, label] of Object.entries(WINDOW_SOURCE)) {
    const tx = (a.transactions || {})[label] || {};
    const buys = toNumber(tx.buys);
    const sells = toNumber(tx.sells);
    const trades = buys + sells;

    windows[key] = {
      volumeUsd: toNumber((a.volume_usd || {})[label]),
      buys,
      sells,
      trades,
      // A window nobody traded in has no pressure to report, so it reads
      // neutral rather than as a maximally bad zero.
      buyRatio: trades > 0 ? Number((buys / trades).toFixed(3)) : 0.5,
    };
  }

  const day = windows.h24;
  const createdAt = a.pool_created_at ? new Date(a.pool_created_at) : null;

  return {
    poolAddress: (a.address || "").toLowerCase(),
    dex: rel.dex?.data?.id || "unknown",
    pairName: a.name || "",

    address,
    symbol: baseToken?.attributes?.symbol || address.slice(2, 8).toUpperCase(),
    name: baseToken?.attributes?.name || "Unknown",

    // About seven in ten RHC tokens carry one; the rest come back null, and
    // GeckoTerminal also uses a "missing.png" placeholder. Both are normalised
    // to null here so the page has one thing to fall back on rather than two.
    imageUrl: usableImage(baseToken?.attributes?.image_url),

    quoteAddress: bareAddress(rel.quote_token?.data?.id),

    createdAt: createdAt ? createdAt.toISOString() : null,
    ageHours: createdAt ? Number(((Date.now() - createdAt.getTime()) / 3600000).toFixed(1)) : null,

    liquidityUsd: toNumber(a.reserve_in_usd),
    fdvUsd: toNumber(a.fdv_usd),
    priceUsd: toNumber(a.base_token_price_usd),

    windows,

    // The 24h window promoted to the top level, because that is the headline
    // reading and most of the pipeline only ever wants one number.
    volumeUsd: day.volumeUsd,
    buyRatio: day.buyRatio,
    buys: day.buys,
    sells: day.sells,
    trades: day.trades,
  };
}

async function fetchPools(path, pages) {
  const pools = [];

  for (let page = 1; page <= pages; page++) {
    const body = await get(path, { include: "base_token,dex", page });

    // `included` is a flat array of every related record across the page.
    const byId = new Map((body.included || []).map((item) => [item.id, item]));

    const batch = (body.data || []).map((pool) => normalize(pool, byId)).filter(Boolean);
    pools.push(...batch);

    if (batch.length < 20) break; // last page
  }

  return pools;
}

/** Pools opened most recently - where new launches show up. */
export function fetchNewPools(pages = 2) {
  return fetchPools(`/networks/${config.network}/new_pools`, pages);
}

/** Pools by volume - where the money already is. */
export function fetchTopPools(pages = 1) {
  return fetchPools(`/networks/${config.network}/pools`, pages);
}

/**
 * Every DEX on the chain, so discovery isn't limited to one ranked list.
 *
 * This is the difference between seeing the market and seeing the top of it.
 * The network-wide /pools feed is ranked, so paging it only ever reaches the
 * biggest pools - measured on Robinhood Chain it tops out around 70 unique
 * tokens. Asking each venue for its own pools instead reached 249 from a
 * single page each, because a token that is 400th by network volume can still
 * be 3rd on the small DEX it launched on.
 *
 * Forty venues is forty requests against a 30-per-minute budget, so this is
 * the slow part of a run rather than the expensive one - it costs about a
 * minute and a half of waiting and no RPC at all.
 */
export async function fetchDexPools(dexes, pagesPerDex = 1) {
  const pools = [];
  for (const dex of dexes) {
    try {
      pools.push(
        ...(await fetchPools(`/networks/${config.network}/dexes/${dex}/pools`, pagesPerDex))
      );
    } catch (err) {
      // One dead venue must not cost us the other thirty-nine.
      console.error(`  skipped dex ${dex}: ${err.message}`);
    }
  }

  return pools;
}

/**
 * Everything worth scoring this run, one entry per token.
 *
 * Both feeds are read because they answer different halves of the question.
 * New pools alone would miss yesterday's launch that is carrying today's
 * volume; top pools alone would miss everything launched this morning, which
 * is the half a memecoin buyer is actually looking at.
 *
 * A token can have several pools. The deepest one is kept, since that is where
 * price is set and where a sell would actually route.
 */
/** Current market data for pools we already know about, 30 at a time. */
async function refreshPools(poolAddresses) {
  const pools = [];

  for (let i = 0; i < poolAddresses.length; i += 30) {
    const chunk = poolAddresses.slice(i, i + 30);
    const body = await get(
      `/networks/${config.network}/pools/multi/${chunk.join(",")}`,
      { include: "base_token,dex" }
    );

    const byId = new Map((body.included || []).map((item) => [item.id, item]));
    pools.push(...(body.data || []).map((pool) => normalize(pool, byId)).filter(Boolean));
  }

  return pools;
}

/**
 * Everything worth scoring this run, one entry per token.
 *
 * Discovery is split in two because the two halves have very different costs.
 *
 * FINDING pools is slow. The network-wide feeds are ranked, so they only ever
 * reach the top of the market - measured, about 70 unique tokens against the
 * 249 that exist. Reaching the rest means asking each of the chain's ~40
 * venues for its own pools, and at a couple of calls a second that is a minute
 * and a half. So the venue sweep rotates: a few per run, and what it finds is
 * remembered.
 *
 * REFRESHING them is cheap. /pools/multi takes 30 pool addresses per call, so
 * the entire accumulated universe gets current volume and buy/sell data for
 * about nine calls however large it has grown. That is what makes a
 * market-wide reading affordable every single run rather than once.
 *
 * @param known       [{ address, poolAddress }] remembered from earlier runs
 * @param dexCursor   where the last run's venue sweep stopped
 */
export async function discoverTokens({ known = [], dexCursor = 0 } = {}) {
  // Sequential, never Promise.all: these all queue through one paced gate, and
  // issuing them at once only interleaves them into the same rate window.
  const fresh = await fetchNewPools(config.newPoolPages);
  const top = await fetchTopPools(config.topPoolPages);

  let cursor = dexCursor;
  let sweep = [];

  {
    const body = await get(`/networks/${config.network}/dexes`);
    const dexes = (body.data || []).map((dex) => dex.id);

    if (dexes.length) {
      // dexSweepSize 0 means all of them; anything else rotates a window.
      const take = config.dexSweepSize > 0 ? Math.min(config.dexSweepSize, dexes.length) : dexes.length;
      const slice = [];
      for (let i = 0; i < take; i++) {
        slice.push(dexes[(cursor + i) % dexes.length]);
      }
      cursor = (cursor + slice.length) % dexes.length;
      sweep = await fetchDexPools(slice, config.dexPages);
    }
  }

  const seenThisRun = [...fresh, ...top, ...sweep];
  const covered = new Set(seenThisRun.map((pool) => pool.poolAddress));

  // Anything remembered but not caught by the feeds or this run's sweep still
  // needs today's numbers, or it would be scored on last week's volume.
  const stale = known
    .map((entry) => entry.poolAddress)
    .filter((poolAddress) => poolAddress && !covered.has(poolAddress));

  const refreshed = stale.length ? await refreshPools(stale) : [];
  const all = [...seenThisRun, ...refreshed];

  // A token can trade in several pools. The deepest one is kept, since that is
  // where price is set and where a sell would actually route.
  const best = new Map();
  for (const pool of all) {
    const seen = best.get(pool.address);
    if (!seen || pool.liquidityUsd > seen.liquidityUsd) best.set(pool.address, pool);
  }

  // The quote side of a pair is a stablecoin or wrapped native, not a
  // memecoin. Scoring WETH's "holder distribution" is meaningless, and being
  // the biggest thing on the chain it would dominate every volume-weighted
  // number on the page.
  //
  // Derived from the feed rather than hardcoded: anything the market prices
  // *against* is a quote asset by definition, so this keeps working when RHC
  // adds a stablecoin nobody told us about.
  const quotes = new Set(config.quoteTokens.map((a) => a.toLowerCase()));
  for (const pool of all) {
    if (pool.quoteAddress) quotes.add(pool.quoteAddress);
  }

  const pools = [...best.values()].filter((pool) => !quotes.has(pool.address));

  return {
    pools,
    dexCursor: cursor,
    // What to remember for next time, so the universe only ever grows.
    universe: pools.map((pool) => ({ address: pool.address, poolAddress: pool.poolAddress })),
    sweptThisRun: sweep.length,
    refreshed: refreshed.length,
  };
}
