// blockscout.js
// The official Robinhood Chain indexer, used for the two things a public RPC
// cannot answer at this chain's scale.
//
// WHY THIS EXISTS
//
// Holder distribution was being reconstructed by replaying each token's
// Transfer log and reading balanceOf per candidate wallet, capped at 400
// candidates. Measured against live data that does not work: PONS had 21,658
// unique receivers in 24 hours, so the cap sampled 1.8% of its holders. The
// resulting "top 10 hold 5%" was an artefact - the numerator came from the
// sample, the denominator from the whole circulating supply - and tokens where
// the cap bit reported a median top-10 of 30.6% against 91.6% for tokens read
// completely. Every large token was being flattered onto the Alpha side.
//
// Blockscout indexes the chain, so it answers both directly:
//   - the holder list, already ranked by balance
//   - the real holder count
//   - the contract's deployer, which findDeployer() missed on 114 of 154 tokens
//
// Two to four calls per token replace roughly twenty batched RPC round trips,
// so this is cheaper as well as correct.
//
// A key is required (free tier at dev.blockscout.com: 5 req/s, 100k/day).
// Without one this module reports itself disabled and the collector falls back
// to the RPC path, which still works - it just cannot measure the big tokens.

import { config } from "./config.js";

export const apiCalls = { count: 0 };

// Set when the account is out of credits or the key is refused.
//
// Both are answered per request, so without this a run keeps asking - once
// per token, several hundred times - and every one of them fails the same way
// after burning its retries. The first refusal is enough to know the rest of
// the run will be refused too, so the indexer is switched off and the RPC
// fallback takes over quietly.
let shutOff = null;

export function enabled() {
  return Boolean(config.blockscoutKey) && !shutOff;
}

/** Why the indexer stopped being used this run, if it did. */
export function disabledReason() {
  return shutOff;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Free tier is 5 requests a second. Paced rather than retried, for the same
// reason as everything else here: being throttled costs more than waiting.
const MIN_INTERVAL_MS = 220;

// Short on purpose. The hosted API fails often enough from a normal connection
// that a patient ladder spends the whole run waiting - one token cost 116s and
// 19 calls before this was tightened. There is a working fallback underneath
// (the RPC path, which reports "not measurable" rather than guessing), so
// failing fast and moving on beats holding the queue.
const BACKOFF_MS = [800, 2500, 6000];

// Measured against the hosted API from a normal connection, this endpoint
// fails in three different ways and only one of them is an HTTP status:
//   - it hangs (fetch has no default timeout, so a hang stalls the whole run)
//   - it fails at the network layer, which arrives as a TypeError
//   - it answers 200 with an empty body
// All three are transient and all three are retried. A response that parses
// is the only thing treated as an answer.
const REQUEST_TIMEOUT_MS = 45000;

let gate = Promise.resolve();
let lastCallAt = 0;

async function attemptOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    // Two different problems share this pair of codes, and the body says
    // which: a key the service will not accept, or a valid key on an account
    // with nothing left to spend. Neither is fixed by waiting, and both apply
    // to every later call, so the indexer shuts off for the rest of the run.
    if (res.status === 402 || res.status === 401) {
      const body = await res.text().catch(() => "");
      const outOfCredits = /out of credits/i.test(body);

      shutOff = outOfCredits
        ? "Blockscout account is out of credits"
        : `Blockscout refused the API key (HTTP ${res.status})`;

      const err = new Error(shutOff);
      err.fatal = true;
      throw err;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    if (!text.trim()) throw new Error("empty body");
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function send(url) {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);

  let last;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    lastCallAt = Date.now();
    apiCalls.count++;

    try {
      return await attemptOnce(url);
    } catch (err) {
      if (err.fatal) throw err;
      last = err;
      if (attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]);
    }
  }

  throw new Error(`Blockscout unreachable after ${BACKOFF_MS.length + 1} tries: ${last.message}`);
}

function get(path, params = {}) {
  const url = new URL(`${config.blockscoutBase}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("apikey", config.blockscoutKey);

  const result = gate.then(() => send(url));
  gate = result.then(() => {}, () => {});
  return result;
}

function toBig(value) {
  try {
    return BigInt(String(value ?? "0").split(".")[0] || "0");
  } catch {
    return 0n;
  }
}

/**
 * What share of circulating supply the top 10 wallets hold.
 *
 * Blockscout returns the holder list already ranked by balance, so the top ten
 * are the top ten rather than the top ten of whatever we managed to sample -
 * which is the whole reason this path exists.
 *
 * The pool and the burn address are still excluded, for the same reason as
 * before: almost all of a fresh memecoin's supply sits in its own liquidity
 * pool, and counting that as a holding would report every token on the chain
 * as maximally concentrated.
 */
export async function getHolderDistribution(tokenAddress, excluded = []) {
  const skip = new Set(
    [...excluded, ...config.burnAddresses]
      .filter(Boolean)
      .map((a) => String(a).toLowerCase())
  );

  const [holders, counters] = await Promise.all([
    get(`/tokens/${tokenAddress}/holders`),
    get(`/tokens/${tokenAddress}/counters`).catch(() => null),
  ]);

  const items = holders?.items || [];
  if (!items.length) {
    return { top10Percent: null, holderCount: 0, topHolders: [], source: "blockscout", empty: true };
  }

  const ranked = items
    .map((item) => ({
      address: String(item?.address?.hash || item?.address || "").toLowerCase(),
      balance: toBig(item?.value),
    }))
    .filter((h) => h.address && h.balance > 0n);

  const parked = ranked
    .filter((h) => skip.has(h.address))
    .reduce((sum, h) => sum + h.balance, 0n);

  const real = ranked.filter((h) => !skip.has(h.address));
  if (!real.length) {
    return { top10Percent: null, holderCount: 0, topHolders: [], source: "blockscout", empty: true };
  }

  // Circulating excludes what the pool and the burn address are sitting on,
  // so a holder's share is measured against supply that can actually move.
  const totalSupply = toBig(counters?.token_total_supply ?? holders?.total_supply);
  const listed = ranked.reduce((sum, h) => sum + h.balance, 0n);
  const base = totalSupply > parked ? totalSupply - parked : listed - parked;
  if (base <= 0n) {
    return { top10Percent: null, holderCount: 0, topHolders: [], source: "blockscout", empty: true };
  }

  const top10 = real.slice(0, 10);
  const topSum = top10.reduce((sum, h) => sum + h.balance, 0n);
  const share = (amount) => Number((amount * 10000n) / base) / 100;

  // The indexer's own count, which is the real one - the list is only its
  // first page.
  const holderCount = Number(counters?.token_holders_count ?? real.length) || real.length;

  return {
    top10Percent: Number(Math.min(100, share(topSum)).toFixed(2)),
    holderCount,
    holderCountIsFloor: false,
    topHolders: top10.map((h) => ({
      address: h.address,
      percent: Number(Math.min(100, share(h.balance)).toFixed(2)),
    })),
    capped: false,
    source: "blockscout",
  };
}

/** Who deployed this contract. */
export async function getCreator(address) {
  const info = await get(`/addresses/${address}`);
  const creator = info?.creator_address_hash;
  return creator ? String(creator).toLowerCase() : null;
}

/** One cheap call, so a bad key is reported at startup rather than per token. */
export async function check(tokenAddress) {
  const info = await get(`/addresses/${tokenAddress}`);
  return Boolean(info);
}
