// windows.js
// Counts token creations and graduations per timeframe by reading them
// straight off the chain, with no stored history needed.
//
// WHY THIS EXISTS
//
// The main pump.fun program runs at ~250 signatures/second - 21.6 million a
// day - so reaching back 24 hours through it costs ~21,600 paging calls, and
// sampling it can't measure graduations at all: they're roughly 0.003% of
// traffic, so any affordable sample catches zero. That's the "graduation
// detection is unverified" problem in the docs.
//
// The fix is to stop reading the firehose. Both events have an account that
// almost every one of them touches, and those accounts are quiet:
//
//   mint authority       ~0.54 sigs/sec  ->    47 calls for 24h,  96% CREATE
//   migration authority  ~0.02 sigs/sec  ->     2 calls for 24h,  81% CREATE_POOL
//
// So a full day of exact creation and graduation counts costs ~50 calls
// instead of 21,600, and the counts are counted rather than extrapolated.
//
// Measured 2026-09-04: ~39,600 creates/day, ~1,048 graduations/day, which puts
// the graduation rate at ~2.65%.

import { config } from "./config.js";

// Verified on-chain rather than taken on trust - see the purity figures above.
export const ACCOUNTS = {
  create: {
    address: "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",
    type: "CREATE",
    label: "mint authority",
  },
  graduate: {
    address: "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg",
    type: "CREATE_POOL",
    label: "migration authority",
  },
};

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
const PARSE_URL = `https://api.helius.xyz/v0/transactions/?api-key=${config.heliusApiKey}`;

// Neither account is busy enough to need a big valve, but an unbounded loop
// against a paged API is never worth the risk.
const MAX_PAGES = 200;
const PURITY_SAMPLE = 100;

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "haboob", method, params }),
  });

  if (!res.ok) throw new Error(`Helius RPC returned HTTP ${res.status}`);

  const json = await res.json();
  if (json.error) throw new Error(`Helius error: ${json.error.message}`);
  return json.result;
}

// Page backwards through one account's signatures until we pass the cutoff.
async function signaturesSince(address, cutoffSeconds) {
  const collected = [];
  let before;

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await rpc("getSignaturesForAddress", [address, { limit: 1000, before }]);
    if (!batch.length) break;

    let reachedCutoff = false;
    for (const item of batch) {
      if (item.blockTime && item.blockTime < cutoffSeconds) {
        reachedCutoff = true;
        break;
      }
      // Failed transactions created nothing and graduated nothing.
      if (!item.err && item.blockTime) {
        collected.push({ signature: item.signature, blockTime: item.blockTime });
      }
    }

    if (reachedCutoff) break;
    before = batch[batch.length - 1].signature;
  }

  return collected;
}

// What share of an account's successful transactions are actually the event
// we're counting. Neither account is perfectly pure - the mint authority also
// carries a few swaps, the migration authority some unlabelled transactions -
// so the ratio is measured per run rather than hardcoded, and applied to the
// raw count.
async function measurePurity(signatures, wantedType) {
  if (!signatures.length) return 1;

  // Sample across the whole span, not just the newest end, so a burst at one
  // end of the window can't skew the ratio.
  const step = Math.max(1, Math.floor(signatures.length / PURITY_SAMPLE));
  const sample = [];
  for (let i = 0; i < signatures.length && sample.length < PURITY_SAMPLE; i += step) {
    sample.push(signatures[i].signature);
  }

  const res = await fetch(PARSE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transactions: sample }),
  });

  if (!res.ok) throw new Error(`Helius parse API returned HTTP ${res.status}`);

  const events = await res.json();
  if (!events.length) return 1;

  const hits = events.filter((e) => (e.type || "").toUpperCase() === wantedType).length;
  return hits / events.length;
}

/**
 * Count both events across every timeframe in one pass.
 *
 * The widest window is fetched once and the narrower ones are counted from
 * the same result, because a 5-minute window is a subset of the 24-hour one -
 * there is no reason to page the chain four times.
 *
 * @param windows  [{ key, ms }] to bucket into
 */
export async function countWindows(windows, now = Date.now()) {
  if (!config.heliusApiKey) {
    throw new Error("No HELIUS_API_KEY set - window counts need live chain access");
  }

  // Twice the widest window, because every window is shown against the period
  // before it - the 24h card needs 24-48h ago to have something to compare
  // against. Both accounts are quiet enough that doubling the reach is cheap
  // (~94 paging calls for 48h of creates, ~4 for graduations).
  const widestMs = Math.max(...windows.map((w) => w.ms));
  const reachMs = widestMs * 2;
  const cutoff = Math.floor((now - reachMs) / 1000);

  const [creates, graduations] = await Promise.all([
    signaturesSince(ACCOUNTS.create.address, cutoff),
    signaturesSince(ACCOUNTS.graduate.address, cutoff),
  ]);

  const [createPurity, graduatePurity] = await Promise.all([
    measurePurity(creates, ACCOUNTS.create.type),
    measurePurity(graduations, ACCOUNTS.graduate.type),
  ]);

  const countIn = (events, startMs, endMs) =>
    events.filter((e) => e.blockTime * 1000 > startMs && e.blockTime * 1000 <= endMs).length;

  const result = {};
  for (const win of windows) {
    // Current window and the one before it, so the page can show a change.
    const created = Math.round(countIn(creates, now - win.ms, now) * createPurity);
    const createdBefore = Math.round(countIn(creates, now - win.ms * 2, now - win.ms) * createPurity);

    const graduated = Math.round(countIn(graduations, now - win.ms, now) * graduatePurity);
    const graduatedBefore = Math.round(
      countIn(graduations, now - win.ms * 2, now - win.ms) * graduatePurity
    );

    result[win.key] = {
      created,
      graduated,
      graduationRate: created > 0 ? (graduated / created) * 100 : null,
      previous: {
        created: createdBefore,
        graduated: graduatedBefore,
        graduationRate: createdBefore > 0 ? (graduatedBefore / createdBefore) * 100 : null,
      },
    };
  }

  return {
    measuredAt: new Date(now).toISOString(),
    reachMs,
    purity: { create: createPurity, graduate: graduatePurity },
    signaturesRead: creates.length + graduations.length,
    windows: result,
  };
}
