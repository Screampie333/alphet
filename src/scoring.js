// scoring.js
// Turns the raw on-chain readings into the Alphet gauge.
//
// Three steps:
//   1. score each token on four metrics, 0-100, where 100 is Alpha-side
//   2. weigh those into one quality score per token, and cut the population
//      into Alpha and Beta at config.alphaCutoff
//   3. work out where the money went, which is what the gauge seam shows
//
// Unlike the weather index this replaced, the thresholds here are absolute
// rather than relative to our own history. "The top 10 wallets hold 62% of
// supply" is a complete statement about a token - it does not need a baseline
// to mean something - so the very first run is already a real reading, and two
// runs a month apart are directly comparable.

import { config } from "./config.js";

function clamp(n) {
  return Math.max(0, Math.min(100, n));
}

/**
 * Interpolate a value between a "good" and a "bad" anchor onto 0-100.
 * Works in either direction, so `good` may be the larger or the smaller number.
 *
 * `log` is for quantities that span orders of magnitude - volume per holder
 * runs from 30 to 12,000, and interpolating that linearly would put almost
 * every real token at one end or the other.
 */
function band(value, good, bad, { log = false } = {}) {
  let v = value;
  let g = good;
  let b = bad;

  if (log) {
    v = Math.log(Math.max(v, 1e-9));
    g = Math.log(Math.max(g, 1e-9));
    b = Math.log(Math.max(b, 1e-9));
  }

  if (g === b) return 50;
  return clamp(100 * (1 - (v - g) / (b - g)));
}

// --- 1. Holder distribution ---
// Concentrated supply is the loudest scam tell there is: one wallet holding
// most of the float can end the token in a single transaction, whatever the
// chart is doing.
export function scoreHolderDistribution(token) {
  const t = config.thresholds;
  const { top10Percent, holderCount } = token.holders;

  // The collector returns null when it could not enumerate the holder set.
  // A share computed from a partial sample understates concentration - badly,
  // and always in the flattering direction - so there is nothing to score.
  if (top10Percent === null || top10Percent === undefined) return null;

  const spread = band(top10Percent, t.top10GoodPercent, t.top10BadPercent);

  // Below about 25 holders the metric measures nothing: "the top 10 hold 80%"
  // is arithmetic, not concentration, when there are only 12 holders in total.
  // Rather than report a number it can't stand behind, it reports risk.
  if (holderCount < t.minHolders) return Math.min(spread, 30);

  return spread;
}

// --- 2. Liquidity permanence ---
// The only exit that matters is whether the dev can take the pool with them.
export function scoreLiquidityPermanence(token) {
  const liq = token.liquidity;
  if (!liq) return 0;

  // Uniswap V3/V4 hold liquidity as per-position NFTs rather than a fungible
  // LP token, so "what share can be pulled" needs the position manager and a
  // different answer per position. Returning null drops the metric for this
  // token and reweights the other three - scoring an unreadable pool as 0
  // would accuse it of something we never measured, and a large share of RHC
  // volume sits on exactly those pools.
  if (liq.measurable === false) return null;

  if (liq.drained) return 0;

  // A lock is worth what remains of it. An unlock next week is a rug with a
  // calendar entry, so a short lock is discounted toward the day it ends -
  // and an unknown lock length gets the floor rather than the benefit of the
  // doubt, because we cannot read most lockers' unlock times.
  const remaining = Math.min(1, (liq.lockDaysRemaining || 0) / config.thresholds.fullLockDays);
  const lockFactor = 0.3 + 0.7 * remaining;

  const secured = liq.burnedPercent + liq.lockedPercent * lockFactor;
  return clamp(secured);
}

// --- 3. Developer track record ---
export function scoreDevTrackRecord(token) {
  const dev = token.devRecord;

  // No record to read, so there is nothing to score.
  //
  // This used to return 45 - "slightly below neutral, because unproven is a
  // real cost to a buyer". That argument is about the world; the number was
  // about us. launches counts other tokens by the same deployer IN OUR INDEX,
  // and the index holds one chain and 835 contracts, so "no prior launches"
  // mostly means "we have not seen any".
  //
  // Every other metric here returns null when it cannot read something, and
  // has its weight shared out. This one scored the gap instead, which pulled
  // 16.4% of tokens toward 45 from whichever side they were on - flattering
  // the bad ones and penalising the good ones by the same arithmetic.
  if (!dev || !dev.known || dev.launches === 0) return null;

  const cleanRate = 1 - dev.rugs / dev.launches;

  if (dev.rugs === 0) {
    // A clean record earns more the longer it is. Ten shipped tokens with
    // nothing dead behind them is the strongest signal on this whole board.
    return clamp(60 + Math.min(dev.launches, 10) * 4);
  }

  // Once there is a rug in the history the ceiling drops hard, and a repeat
  // offender never climbs back. Someone who has done it three times is
  // telling you what the fourth one is.
  const scored = 45 * cleanRate;
  return clamp(dev.rugs >= 3 ? Math.min(scored, 15) : scored);
}

// --- 4. Time-to-rug signals ---
// Three live warning signs, combined. Each is weak alone and they are strong
// together, which is why they share one slot instead of taking three.
export function scoreRugSignals(token, windowKey = "h24") {
  const t = config.thresholds;

  const hp = token.honeypot || {};

  // The only metric that genuinely differs by timeframe. Supply concentration,
  // LP permanence and a dev's history are all facts about right now and read
  // the same whichever window you pick; how a token is trading is not.
  const activity = token.activity.windows?.[windowKey] || token.activity;

  // A token you cannot sell is not a risky investment, it is not an
  // investment. This zeroes the metric; scoreToken is what stops the other
  // three outvoting it, because zeroing one weight of four never could.
  if (hp.blocked) {
    return { score: 0, signals: { volumePerHolder: 0, buyPressure: 0, exit: 0 }, bad: 3 };
  }

  // These three signals all read trading behaviour, and a token nobody is
  // trading has none to read. Left unguarded the arithmetic is actively
  // misleading: zero volume divided by any holder count is zero, which lands
  // at the healthy end of the volume-per-holder band and scores a dead token
  // 100. The metric drops instead, and its weight moves to the three
  // structural ones - supply, liquidity and dev history are all still real
  // facts about a token nobody wants.
  if ((activity.trades || 0) < t.minTradesForSignal) {
    return { score: null, signals: {}, bad: 0, reason: "too few trades to read" };
  }

  // Volume per holder is only meaningful when the holder count is a count.
  // The replay is clipped for anything older or busier than one window, and
  // dividing real volume by a floor produces a number that climbs with a
  // token's popularity - which would read every large token as wash-traded.
  const holdersAreAFloor = token.holders.partial || token.holders.capped;

  const volumePerHolder = holdersAreAFloor
    ? null
    : band(
        activity.volumePerHolder,
        t.healthyVolumePerHolder,
        t.suspiciousVolumePerHolder,
        { log: true }
      );

  const buyPressure = band(activity.buyRatio, t.buyPressureGood, t.buyPressureBad);

  // A sell we never managed to simulate is not a sell that worked. It reads as
  // unknown so it can neither rescue a bad token nor sink a good one - marking
  // it a pass would hand a free 100 to every token too broken to test.
  const exit = hp.tested ? 100 : 50;

  const present = [volumePerHolder, buyPressure, exit].filter((s) => s !== null);
  if (!present.length) return { score: null, signals: {}, bad: 0 };

  const bad = present.filter((s) => s < 40).length;
  let score = present.reduce((sum, s) => sum + s, 0) / present.length;

  // Two bad signals at once is the pattern, not a coincidence: heavy volume
  // against a handful of holders while the flow is mostly sells is a
  // distribution, and it should land on the Beta side rather than average out
  // to something respectable.
  if (bad >= 2) score /= 2;

  return {
    score: clamp(score),
    signals: {
      volumePerHolder: volumePerHolder === null ? null : Math.round(volumePerHolder),
      buyPressure: Math.round(buyPressure),
      exit,
    },
    bad,
  };
}

export const METRIC_KEYS = [
  "holderDistribution",
  "liquidityPermanence",
  "devTrackRecord",
  "rugSignals",
];

function round(value) {
  return value === null ? null : Math.round(value);
}

/** Score one token on all four metrics and decide which side it falls. */
export function scoreToken(token, windowKey = "h24") {
  const rug = scoreRugSignals(token, windowKey);
  const activity = token.activity.windows?.[windowKey] || token.activity;
  const honeypot = Boolean(token.honeypot?.blocked);

  const scores = {
    holderDistribution: round(scoreHolderDistribution(token)),
    liquidityPermanence: round(scoreLiquidityPermanence(token)),
    devTrackRecord: round(scoreDevTrackRecord(token)),
    rugSignals: round(rug.score),
  };

  // A metric we could not measure is dropped and its weight shared out across
  // the ones we could, rather than counted as zero. The alternative reads
  // "unmeasured" as "bad", which would put every V3 pool on the Beta side for
  // no reason anyone could point at.
  const w = config.weights;
  const measured = METRIC_KEYS.filter((key) => scores[key] !== null);
  const totalWeight = measured.reduce((sum, key) => sum + w[key], 0);

  let quality = totalWeight > 0
    ? Math.round(
        clamp(measured.reduce((sum, key) => sum + scores[key] * w[key], 0) / totalWeight)
      )
    : null;

  // A simulated sell that reverted overrides the arithmetic entirely.
  //
  // scoreRugSignals already returns 0 for these, and the comment there used to
  // claim nothing could outvote it. That was simply wrong: rug signals carry
  // 20% of the weight, so the other three metrics kept 80% and BRIAN - spread
  // supply, burnt liquidity, $11M of volume - scored 65 and landed on the
  // Alpha side while flagged as a token you cannot sell out of.
  //
  // No arrangement of the other three can rescue that. Supply distribution
  // describes who is holding the bag, not whether you can put it down, and a
  // permanently locked pool you cannot sell into is a wall rather than a
  // floor. So the verdict is set here, above the weighted mean, rather than
  // by trying to pick weights that happen to land below the cutoff.
  //
  // Only `blocked` does this, never an untested one - see checkHoneypot,
  // which now reports a sell it could not simulate as unknown.
  if (quality !== null && honeypot) quality = 0;

  return {
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    dex: token.dex,
    imageUrl: token.imageUrl || null,
    // Kept so backfill can find the token's chart without re-running discovery.
    poolAddress: token.poolAddress || null,
    ageHours: token.ageHours,
    volumeUsd: activity.volumeUsd,
    liquidityUsd: token.liquidity?.liquidityUsd ?? null,
    holderCount: token.holders.holderCount,
    holderCountIsFloor: Boolean(token.holders.capped),
    top10Percent: token.holders.top10Percent,
    honeypot,
    scores,
    unmeasured: METRIC_KEYS.filter((key) => scores[key] === null),
    // Either flag means the holder count is a floor: the time window was
    // clipped, or the candidate cap bit before the set was enumerated.
    partialHolders: Boolean(token.holders.partial || token.holders.capped),
    rugSignals: rug.signals,
    quality,
    side: quality !== null && quality >= config.alphaCutoff ? "alpha" : "beta",
  };
}

/**
 * Where the gauge seam sits.
 *
 * alphaWeight is money-weighted rather than counted, because the question the
 * gauge answers is "where is the money going", not "how many tokens exist".
 * Junk launches outnumber good ones on every chain and always will - counting
 * heads would pin the seam to the Beta side permanently and the gauge would
 * never move again.
 */
export function determineVerdict(alphaWeight) {
  const t = config.verdictThresholds;

  if (alphaWeight >= t.alphaHeavy) {
    return {
      key: "alpha-heavy",
      label: "Alpha-heavy",
      summary:
        "Most money is buying spread supply and locked liquidity. The good end of a memecoin market.",
    };
  }
  if (alphaWeight >= t.alphaLean) {
    return {
      key: "alpha-lean",
      label: "Alpha lean",
      summary:
        "More money in quality than junk — but not by much. Read the token, not the gauge.",
    };
  }
  if (alphaWeight >= t.betaLean) {
    return {
      key: "balanced",
      label: "Balanced",
      summary:
        "Close to even. Which one you get is down to what you buy.",
    };
  }
  if (alphaWeight >= t.betaHeavy) {
    return {
      key: "beta-lean",
      label: "Beta lean",
      summary:
        "Money is leaning toward concentrated supply and pullable liquidity.",
    };
  }
  return {
    key: "beta-heavy",
    label: "Beta-heavy",
    summary:
      "Almost all the money is on the Beta side. Devs hold the float and can pull the pool.",
  };
}

// 0 keeps every scored token. The gauge is only as auditable as the list
// behind it, and truncating that list meant the page could not show the very
// tokens a reader wanted to check.
//
// Size is handled where it belongs: storage.js strips the token list from all
// but the newest few snapshots, since only the newest is ever displayed with
// its tokens and /api/history drops them anyway.
const TOKENS_KEPT = Number(process.env.TOKENS_KEPT || 0);

// Tokens whose value for this metric is null are left out entirely rather
// than counted as zero - see the note on unmeasured metrics in scoreToken.
function weightedMean(items, getValue, getWeight) {
  const usable = items.filter((item) => {
    const v = getValue(item);
    return v !== null && v !== undefined && Number.isFinite(v);
  });
  if (!usable.length) return null;

  const totalWeight = usable.reduce((sum, item) => sum + getWeight(item), 0);

  // With no volume anywhere there is nothing to weigh by, so every token
  // counts once. This is the normal state on a quiet chain, not an error.
  if (totalWeight <= 0) {
    return usable.reduce((sum, item) => sum + getValue(item), 0) / usable.length;
  }

  return usable.reduce((sum, item) => sum + getValue(item) * getWeight(item), 0) / totalWeight;
}

/**
 * Score the whole population over one timeframe.
 *
 * Split out because the dashboard offers four of them. Three of the metrics
 * are facts about right now and read the same whichever window you pick, but
 * how a token is trading is not - so the Alpha/Beta line itself can fall
 * differently at 15 minutes than it does over a day, and that difference is
 * the most useful thing on the page: it is money rotating between the two
 * sides while you watch.
 */
function scoreWindow(tokens, windowKey) {
  // Scored once, then split into what can be read and what cannot - both
  // halves are reported, the second one by name in the snapshot.
  const everyToken = tokens.map((token) => scoreToken(token, windowKey));
  const readable = everyToken.filter((t) => t.quality !== null);
  const unscoreable = everyToken.filter((t) => t.quality === null);

  const volume = (token) => Math.max(0, token.volumeUsd || 0);

  // Honeypots are disqualified rather than scored.
  //
  // A token you cannot sell out of is not a low-quality memecoin, it is not a
  // memecoin. The gauge asks where money went, and for these the answer is
  // that it did not go anywhere - it went in. Ranking them against tokens that
  // can actually be traded compares two different kinds of thing.
  //
  // Removing them silently would be worse than leaving them in, though, and
  // by a lot. Measured on the 02:30 reading: 15 honeypots carried $44.4M, or
  // 15.8% of all volume and 22.2% of Beta's, and dropping them moved the seam
  // from 28.9% to 34.3% Alpha. A gauge that reads healthier because its worst
  // tokens were deleted is exactly the survivorship bias this project already
  // warns about in backfill - so what was removed is counted, priced, and put
  // on the page next to the number it would otherwise have flattered.
  const disqualified = readable.filter((t) => t.honeypot);
  const scored = readable.filter((t) => !t.honeypot);

  if (!scored.length) return null;

  const alpha = scored.filter((token) => token.side === "alpha");
  const beta = scored.filter((token) => token.side === "beta");

  const alphaVolume = alpha.reduce((sum, token) => sum + volume(token), 0);
  const betaVolume = beta.reduce((sum, token) => sum + volume(token), 0);
  const totalVolume = alphaVolume + betaVolume;

  const alphaWeight =
    totalVolume > 0
      ? (alphaVolume / totalVolume) * 100
      : (alpha.length / scored.length) * 100;

  const subScores = {};
  const measuredOn = {};
  for (const key of METRIC_KEYS) {
    const mean = weightedMean(scored, (t) => t.scores[key], volume);
    subScores[key] = mean === null ? null : Math.round(mean);
    measuredOn[key] = scored.filter((t) => t.scores[key] !== null).length;
  }

  return {
    scored,
    // Returned so score() can name them in the snapshot. Both are left out of
    // every number above, and until now neither was recorded by name.
    disqualified,
    unscoreable,
    alphetIndex: Math.round(weightedMean(scored, (t) => t.quality, volume)),
    alphaWeight: Number(alphaWeight.toFixed(1)),
    betaWeight: Number((100 - alphaWeight).toFixed(1)),
    verdict: determineVerdict(alphaWeight),
    subScores,
    measuredOn,
    split: {
      alphaCount: alpha.length,
      betaCount: beta.length,
      alphaVolume: Number(alphaVolume.toFixed(2)),
      betaVolume: Number(betaVolume.toFixed(2)),
      totalVolume: Number(totalVolume.toFixed(2)),
      // Disqualified, so by definition none are left in `scored` - this
      // counts what was taken out, which is the only reason it is worth
      // reporting at all.
      honeypots: disqualified.length,
      honeypotVolume: Number(
        disqualified.reduce((sum, token) => sum + volume(token), 0).toFixed(2)
      ),
      partialHolders: scored.filter((t) => t.partialHolders).length,
    },
  };
}

// The timeframes the dashboard offers. 24h is the headline: it is the window
// with enough trades behind it that one whale doesn't set the reading.
export const WINDOW_KEYS = ["m15", "h1", "h6", "h24"];
const HEADLINE_WINDOW = "h24";

/** Run the whole pipeline on one collection. */
export function score(raw, history = []) {
  const tokens = raw.tokens || [];

  // Every timeframe is computed up front so switching one on the page is
  // instant rather than another collection run - which at RPC prices would be
  // several minutes.
  const windows = {};
  for (const key of WINDOW_KEYS) {
    const result = scoreWindow(tokens, key);
    if (!result) continue;
    const { scored: _dropped, disqualified: _d, unscoreable: _u, ...summary } = result;
    windows[key] = summary;
  }

  const headline = scoreWindow(tokens, HEADLINE_WINDOW);
  // A token where every metric came back unmeasurable has no reading to
  // contribute and must not dilute the ones that do.
  const scored = headline ? headline.scored : [];

  if (!scored.length) {
    return {
      timestamp: new Date().toISOString(),
      alphetIndex: null,
      alphaWeight: null,
      betaWeight: null,
      verdict: {
        key: "no-data",
        label: "No reading",
        summary: "No tokens were readable this run.",
      },
      subScores: {},
      split: { alphaCount: 0, betaCount: 0, alphaVolume: 0, betaVolume: 0 },
      tokens: [],
      raw: { ...raw, tokens: [] },
      excluded: raw.excluded || [],
      baselineSnapshots: history.length,
    };
  }

  const volume = (token) => Math.max(0, token.volumeUsd || 0);

  // Two contracts trading under one ticker is the oldest trick on a memecoin
  // chain: copy a name that is working and collect the mistaken buys. We
  // cannot tell which one is the original - the copy is often the busier of
  // the two - so neither is accused and both are marked, because the danger
  // is not knowing there are two.
  const symbolCounts = new Map();
  for (const token of scored) {
    symbolCounts.set(token.symbol, (symbolCounts.get(token.symbol) || 0) + 1);
  }
  for (const token of scored) {
    token.duplicateSymbol = symbolCounts.get(token.symbol) > 1;
  }

  return {
    timestamp: new Date().toISOString(),

    // The headline reading is the 24-hour window - enough trades behind it
    // that one whale doesn't set it. The others sit alongside in `windows`.
    alphetIndex: headline.alphetIndex,
    alphaWeight: headline.alphaWeight,
    betaWeight: headline.betaWeight,
    verdict: headline.verdict,
    subScores: headline.subScores,
    // How many tokens each metric could actually be read on, so a tile can say
    // "42 of 58 tokens" instead of implying it covered the whole population.
    measuredOn: headline.measuredOn,
    split: headline.split,

    windows,
    headlineWindow: HEADLINE_WINDOW,

    tokens: (() => {
      const ranked = [...scored].sort((a, b) => volume(b) - volume(a));
      return TOKENS_KEPT > 0 ? ranked.slice(0, TOKENS_KEPT) : ranked;
    })(),
    raw: {
      source: raw.source,
      chain: raw.chain,
      measuredAt: raw.measuredAt,
      lookbackHours: raw.lookbackHours,
      totals: raw.totals,
    },

    // Every token that is not in `tokens`, and why: whatever discovery and the
    // run dropped before scoring, plus the headline window's honeypots and
    // unscoreable tokens. Kept on the newest snapshot only, like tokens.
    excluded: [
      ...(raw.excluded || []),
      ...headline.disqualified.map((t) => ({
        address: t.address,
        symbol: t.symbol,
        volumeUsd: t.volumeUsd,
        reason: "honeypot",
        detail: "a simulated sell reverted",
      })),
      ...headline.unscoreable.map((t) => ({
        address: t.address,
        symbol: t.symbol,
        volumeUsd: t.volumeUsd,
        reason: "unscoreable",
        detail: "no metric could be read",
      })),
    ],
    baselineSnapshots: history.length,
  };
}
