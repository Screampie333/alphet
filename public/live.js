/* ============================================================
   live.js - the gauge between collection runs

   The collector runs every six hours, because reading holders, liquidity and
   deployers for ~1,400 tokens is slow and costs API credits. Those three are
   facts about a token's structure and barely move in a day.

   What does move is where the money is going. So this re-reads only the
   market data - volume, buys, sells - every five minutes, straight from
   GeckoTerminal in the visitor's browser, and rebuilds the gauge against the
   quality verdicts from the last full reading.

   THIS IS A PORT, AND IT MUST STAY ONE.

   rugScore(), qualityOf() and rescore() reproduce scoreRugSignals(),
   scoreToken() and scoreWindow() in src/scoring.js. If a live number and a
   collected number disagree on the same inputs, the page is showing two
   different measurements under one label. test/live-parity checks that; any
   change to scoring.js has to be made here too.

   The PARAMETERS are not duplicated: thresholds, weights and the cutoff come
   from /api/meta.json, which publish.js writes from config.js.

   Pure functions except fetchFresh(), so all of it runs in Node for testing.
   ============================================================ */

window.AlphetLive = (function () {
  "use strict";

  // Hours each window covers. Volume per holder is put on a daily footing
  // before dividing, exactly as the collector does, or a 15-minute window
  // would always look 96x healthier than a day purely because less time passed.
  var WINDOW_HOURS = { m15: 0.25, h1: 1, h6: 6, h24: 24 };
  var WINDOW_KEYS = ["m15", "h1", "h6", "h24"];
  var METRIC_KEYS = ["holderDistribution", "liquidityPermanence", "devTrackRecord", "rugSignals"];

  // Only used if meta.json predates the thresholds being published. They
  // match config.js at the time of writing.
  var DEFAULTS = {
    alphaCutoff: 55,
    weights: { holderDistribution: 0.3, liquidityPermanence: 0.3, devTrackRecord: 0.2, rugSignals: 0.2 },
    thresholds: {
      healthyVolumePerHolder: 60,
      suspiciousVolumePerHolder: 900,
      buyPressureGood: 0.55,
      buyPressureBad: 0.35,
      minTradesForSignal: 10,
    },
  };

  // How many tokens to refresh. Volume is extremely concentrated: measured on
  // the Sep 14 reading, the top 200 carried 98.6% of it and the top 300 carried
  // 99.9%. That is ten GeckoTerminal calls for essentially all of the money.
  var DEFAULT_LIMIT = 300;

  /* ---------------------------------------------------- scoring.js ports */

  function clamp(n) {
    return Math.max(0, Math.min(100, n));
  }

  function round(value) {
    return value === null ? null : Math.round(value);
  }

  function band(value, good, bad, log) {
    var v = value;
    var g = good;
    var b = bad;
    if (log) {
      v = Math.log(Math.max(v, 1e-9));
      g = Math.log(Math.max(g, 1e-9));
      b = Math.log(Math.max(b, 1e-9));
    }
    if (g === b) return 50;
    return clamp(100 * (1 - (v - g) / (b - g)));
  }

  function weightedMean(items, getValue, getWeight) {
    var usable = items.filter(function (item) {
      var v = getValue(item);
      return v !== null && v !== undefined && isFinite(v);
    });
    if (!usable.length) return null;

    var totalWeight = usable.reduce(function (sum, item) { return sum + getWeight(item); }, 0);
    if (totalWeight <= 0) {
      return usable.reduce(function (sum, item) { return sum + getValue(item); }, 0) / usable.length;
    }
    return usable.reduce(function (sum, item) { return sum + getValue(item) * getWeight(item); }, 0) / totalWeight;
  }

  /**
   * scoreRugSignals() for one window.
   *
   * `act` is { trades, buyRatio, volumePerHolder } for the window. The exit
   * signal is the honeypot simulation, which the market does not change, so it
   * is carried from the last reading. Honeypots themselves never get here -
   * they are disqualified before a snapshot is written.
   */
  function rugScore(token, act, t) {
    if ((act.trades || 0) < t.minTradesForSignal) return null;

    var volumePerHolder = token.partialHolders
      ? null
      : band(act.volumePerHolder, t.healthyVolumePerHolder, t.suspiciousVolumePerHolder, true);
    var buyPressure = band(act.buyRatio, t.buyPressureGood, t.buyPressureBad, false);

    // 100 when the sell was simulated, 50 when it could not be. A reading that
    // carried no rug signals at all (too few trades then) left no exit value;
    // 50 is what the collector would have assigned to an untested one.
    var exit = token.rugSignals && typeof token.rugSignals.exit === "number" ? token.rugSignals.exit : 50;

    var present = [volumePerHolder, buyPressure, exit].filter(function (s) { return s !== null; });
    if (!present.length) return null;

    var bad = present.filter(function (s) { return s < 40; }).length;
    var score = present.reduce(function (sum, s) { return sum + s; }, 0) / present.length;
    if (bad >= 2) score /= 2;
    return clamp(score);
  }

  /** scoreToken()'s quality: a weighted mean, with unmeasured metrics dropped. */
  function qualityOf(scores, weights) {
    var measured = METRIC_KEYS.filter(function (k) { return scores[k] !== null && scores[k] !== undefined; });
    var total = measured.reduce(function (sum, k) { return sum + weights[k]; }, 0);
    if (total <= 0) return null;
    return Math.round(clamp(measured.reduce(function (sum, k) { return sum + scores[k] * weights[k]; }, 0) / total));
  }

  /* ------------------------------------------------------- GeckoTerminal */

  /** A /pools/multi item, reduced to the per-window activity scoring needs. */
  function normalizePool(pool) {
    var a = (pool && pool.attributes) || {};
    var poolAddress = String(a.address || "").toLowerCase();
    if (!poolAddress) return null;

    var windows = {};
    WINDOW_KEYS.forEach(function (key) {
      var tx = (a.transactions || {})[key] || {};
      var buys = Number(tx.buys) || 0;
      var sells = Number(tx.sells) || 0;
      var trades = buys + sells;
      windows[key] = {
        volumeUsd: Number((a.volume_usd || {})[key]) || 0,
        buys: buys,
        sells: sells,
        trades: trades,
        // A window nobody traded in reads neutral, as in sources.js.
        buyRatio: trades > 0 ? Number((buys / trades).toFixed(3)) : 0.5,
      };
    });

    return { poolAddress: poolAddress, windows: windows };
  }

  /** The pools worth refreshing: the highest-volume tokens of the last reading. */
  function pickPools(snapshot, limit) {
    return (snapshot.tokens || [])
      .filter(function (t) { return t.poolAddress; })
      .slice()
      .sort(function (x, y) { return (y.volumeUsd || 0) - (x.volumeUsd || 0); })
      .slice(0, limit || DEFAULT_LIMIT)
      .map(function (t) { return String(t.poolAddress).toLowerCase(); });
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * Current activity for up to 30 pools per call, one call at a time.
   *
   * Paced because GeckoTerminal allows 30 calls a minute and answers bursts
   * with 429. Retries 429 and 5xx the way src/sources.js now does. A chunk
   * that still fails is skipped rather than failing the refresh: its tokens
   * fall back to the last reading, and the result says how many came back so
   * the page never presents a partial refresh as a full one.
   */
  function fetchFresh(poolAddresses, opts) {
    opts = opts || {};
    var doFetch = opts.fetch || fetch;
    var network = opts.network || "robinhood";
    var spacingMs = opts.spacingMs === undefined ? 2200 : opts.spacingMs;
    var backoff = opts.backoff || [3000, 8000, 15000];

    var pools = new Map();
    var chunks = [];
    for (var i = 0; i < poolAddresses.length; i += 30) chunks.push(poolAddresses.slice(i, i + 30));
    var failed = 0;

    function attempt(url, n) {
      return doFetch(url, { headers: { Accept: "application/json" } }).then(
        function (res) {
          if (res.ok) return res.json();
          var transient = res.status === 429 || res.status >= 500;
          if (transient && n < backoff.length) {
            return sleep(backoff[n]).then(function () { return attempt(url, n + 1); });
          }
          throw new Error("HTTP " + res.status);
        },
        function (err) {
          if (n < backoff.length) return sleep(backoff[n]).then(function () { return attempt(url, n + 1); });
          throw err;
        }
      );
    }

    return chunks
      .reduce(function (chain, chunk, index) {
        return chain.then(function () {
          var url = "https://api.geckoterminal.com/api/v2/networks/" + network + "/pools/multi/" + chunk.join(",");
          return (index ? sleep(spacingMs) : Promise.resolve())
            .then(function () { return attempt(url, 0); })
            .then(function (body) {
              (body.data || []).forEach(function (item) {
                var n = normalizePool(item);
                if (n) pools.set(n.poolAddress, n);
              });
            })
            .catch(function () { failed++; });
        });
      }, Promise.resolve())
      .then(function () {
        return { pools: pools, requested: poolAddresses.length, returned: pools.size, failedChunks: failed };
      });
  }

  /* -------------------------------------------------------------- rescore */

  /**
   * scoreWindow() for all four windows, from the last reading's verdicts and
   * fresh activity.
   *
   * Holder distribution, liquidity permanence and dev record are carried as
   * they were measured - the collector reads them once and they do not vary
   * by window. Rug signals are re-scored per window from the fresh activity,
   * which is what lets a token be Alpha over a day and Beta over 15 minutes.
   *
   * A token with no fresh data keeps its last reading. For the three shorter
   * windows its volume is taken as that window's share of the day - an
   * estimate, but one that applies only to the tokens outside the refreshed
   * set, which carry about 0.1% of the money.
   */
  function rescore(snapshot, fresh, meta) {
    meta = meta || {};
    var t = Object.assign({}, DEFAULTS.thresholds, meta.thresholds || {});
    var weights = Object.assign({}, DEFAULTS.weights, meta.weights || {});
    var cutoff = typeof meta.alphaCutoff === "number" ? meta.alphaCutoff : DEFAULTS.alphaCutoff;
    var tokens = snapshot.tokens || [];

    var windows = {};
    var headlineTokens = null;

    WINDOW_KEYS.forEach(function (key) {
      var hours = WINDOW_HOURS[key];

      var rows = tokens.map(function (token) {
        var live = fresh && token.poolAddress ? fresh.get(String(token.poolAddress).toLowerCase()) : null;
        var act = live && live.windows[key];

        if (!act) {
          return {
            token: token,
            fresh: false,
            volume: Math.max(0, (token.volumeUsd || 0) * (hours / 24)),
            scores: token.scores,
            quality: token.quality,
          };
        }

        var holderCount = Math.max(1, token.holderCount || 0);
        var perDay = act.volumeUsd * (24 / hours);
        var rug = rugScore(token, {
          trades: act.trades,
          buyRatio: act.buyRatio,
          volumePerHolder: Number((perDay / holderCount).toFixed(2)),
        }, t);

        var scores = {
          holderDistribution: token.scores.holderDistribution,
          liquidityPermanence: token.scores.liquidityPermanence,
          devTrackRecord: token.scores.devTrackRecord,
          rugSignals: round(rug),
        };

        return {
          token: token,
          fresh: true,
          volume: Math.max(0, act.volumeUsd),
          scores: scores,
          quality: qualityOf(scores, weights),
          act: act,
        };
      });

      var scored = rows.filter(function (r) { return r.quality !== null; });
      if (!scored.length) return;

      var alpha = scored.filter(function (r) { return r.quality >= cutoff; });
      var beta = scored.filter(function (r) { return r.quality < cutoff; });
      var vol = function (r) { return r.volume; };
      var alphaVolume = alpha.reduce(function (s, r) { return s + r.volume; }, 0);
      var betaVolume = beta.reduce(function (s, r) { return s + r.volume; }, 0);
      var totalVolume = alphaVolume + betaVolume;

      // Rounded in the same order as scoreWindow: betaWeight comes from the
      // UNROUNDED alpha share, so the two do not always sum to exactly 100.0.
      var rawAlpha = totalVolume > 0 ? (alphaVolume / totalVolume) * 100 : (alpha.length / scored.length) * 100;

      var subScores = {};
      var measuredOn = {};
      METRIC_KEYS.forEach(function (k) {
        var mean = weightedMean(scored, function (r) { return r.scores[k]; }, vol);
        subScores[k] = mean === null ? null : Math.round(mean);
        measuredOn[k] = scored.filter(function (r) { return r.scores[k] !== null && r.scores[k] !== undefined; }).length;
      });

      windows[key] = {
        alphetIndex: Math.round(weightedMean(scored, function (r) { return r.quality; }, vol)),
        alphaWeight: Number(rawAlpha.toFixed(1)),
        betaWeight: Number((100 - rawAlpha).toFixed(1)),
        subScores: subScores,
        measuredOn: measuredOn,
        split: {
          alphaCount: alpha.length,
          betaCount: beta.length,
          alphaVolume: Number(alphaVolume.toFixed(2)),
          betaVolume: Number(betaVolume.toFixed(2)),
          totalVolume: Number(totalVolume.toFixed(2)),
          // Disqualified tokens are not in the snapshot and are not refreshed,
          // so these are the last reading's and say so by being unchanged.
          honeypots: snapshot.split ? snapshot.split.honeypots : 0,
          honeypotVolume: snapshot.split ? snapshot.split.honeypotVolume : 0,
          partialHolders: scored.filter(function (r) { return r.token.partialHolders; }).length,
        },
        freshCount: rows.filter(function (r) { return r.fresh; }).length,
      };

      if (key === "h24") headlineTokens = rows;
    });

    // The token table shows the 24-hour picture, like the gauge.
    var liveTokens = (headlineTokens || []).map(function (r) {
      if (!r.fresh) return r.token;
      var copy = Object.assign({}, r.token, {
        volumeUsd: r.volume,
        quality: r.quality,
        side: r.quality !== null && r.quality >= cutoff ? "alpha" : "beta",
        scores: r.scores,
      });
      return copy;
    });

    return { windows: windows, tokens: liveTokens };
  }

  return {
    WINDOW_KEYS: WINDOW_KEYS,
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    band: band,
    rugScore: rugScore,
    qualityOf: qualityOf,
    normalizePool: normalizePool,
    pickPools: pickPools,
    fetchFresh: fetchFresh,
    rescore: rescore,
  };
})();
