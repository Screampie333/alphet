// app.js
// Drives the Alphet dashboard: pulls the latest reading off the API and draws
// the gauge, the four metric tiles, the timeframe rows and the token table.
//
// The page must render before any of that arrives, and must keep rendering if
// none of it ever does - so everything below reads from one `state` object
// that starts out holding a demo reading, and the fetches just replace it.

(function () {
  "use strict";

  var Shell = window.AlphetShell;

  // --------------------------------------------------------------
  // METRIC COPY
  // --------------------------------------------------------------

  var METRICS = [
    {
      key: "holderDistribution",
      name: "Holder distribution",
      weight: 0.3,
      desc: "What the top 10 wallets hold. Enough float in one hand ends a token in a single sale.",
      src: "RPC — balanceOf, replayed from the token's Transfer log",
    },
    {
      key: "liquidityPermanence",
      name: "Liquidity permanence",
      weight: 0.3,
      desc: "Whether the dev can pull the pool. Burned or locked is safe; anything else isn't.",
      src: "RPC — LP supply against burn and locker balances (V2 pools only)",
    },
    {
      key: "devTrackRecord",
      name: "Developer track record",
      weight: 0.2,
      desc: "How many tokens this dev launched before, and how many are dead now.",
      src: "RPC — deployer per token, indexed across runs",
    },
    {
      key: "rugSignals",
      name: "Time-to-rug signals",
      weight: 0.2,
      desc: "Volume against holder count, buy/sell flow, and whether a sell works. Two bad at once is a pattern.",
      src: "GeckoTerminal trades + a simulated sell (eth_call, never sent)",
    },
  ];

  var BANDS = [
    { key: "alpha-heavy", label: "Alpha-heavy", range: "65 – 100", color: "var(--alpha)", note: "Money is buying spread supply and locked liquidity." },
    { key: "alpha-lean", label: "Alpha lean", range: "55 – 64", color: "#dcff4d", note: "More money in quality than junk, but not by much." },
    { key: "balanced", label: "Balanced", range: "45 – 54", color: "#e9ff99", note: "Close to even. It comes down to what you buy." },
    { key: "beta-lean", label: "Beta lean", range: "35 – 44", color: "#f4ffd1", note: "Money leaning to concentrated supply, pullable liquidity." },
    { key: "beta-heavy", label: "Beta-heavy", range: "0 – 34", color: "var(--beta)", note: "Almost everything moving is on the Beta side." },
  ];

  // Rows per page in the token table.
  var PAGE_SIZE = 25;

  var DEMO_TICKERS = [
    "WOLFPACK", "GREENCANDLE", "HOODIE", "APEX", "BAGHOLDR", "STONKS",
    "EXITLIQ", "TENDIE", "MOONHOOD", "SNIPER", "DEGENZ", "ROBIN",
  ];

  // --------------------------------------------------------------
  // STATE
  // --------------------------------------------------------------

  // Seeded with a demo reading so the page is complete before the first fetch
  // lands - and stays complete if none of them ever do. Note this runs
  // demoSnapshot() at load, so everything it touches must be declared above.
  var state = {
    snapshot: demoSnapshot(48.6),
    meta: {
      chain: "Robinhood Chain",
      minLiquidityUsd: 500,
      sources: [],
      explorerUrl: "",
      alphaCutoff: 55,
      intervalMinutes: 180,
      lookbackHours: 24,
    },
    windows: null,
    headlineWindow: "h24",
    history: [],
    live: false,
    timeframe: "h24",
    tokenPage: 0,
    sample: null,
  };

  // --------------------------------------------------------------
  // HELPERS
  // --------------------------------------------------------------

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function num(value, decimals) {
    if (value === null || value === undefined || !isFinite(value)) return "—";
    return Number(value).toLocaleString("en-US", {
      minimumFractionDigits: decimals || 0,
      maximumFractionDigits: decimals === undefined ? 0 : decimals,
    });
  }

  // Volume spans four orders of magnitude across a token list, so the table
  // would be unreadable at full precision.
  function compact(value) {
    if (value === null || value === undefined || !isFinite(value)) return "—";
    var abs = Math.abs(value);
    if (abs >= 1e6) return (value / 1e6).toFixed(1) + "M";
    if (abs >= 1e3) return (value / 1e3).toFixed(1) + "k";
    if (abs >= 10) return value.toFixed(0);
    return value.toFixed(2);
  }

  function timeLabel(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  function dayLabel(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  // "8 AM", not "8:56 AM": the column stands for the hour, not for the minute
  // the collector happened to finish in.
  function hourLabel(date) {
    return date.toLocaleTimeString("en-US", { hour: "numeric" });
  }

  // A score's colour is its side: anything at or above the cutoff is Alpha.
  function scoreColor(score) {
    if (score === null || score === undefined) return "var(--dim)";
    return score >= state.meta.alphaCutoff ? "var(--alpha)" : "var(--beta)";
  }


  // --------------------------------------------------------------
  // DEMO + SAMPLE READINGS
  // --------------------------------------------------------------

  // A believable reading centred on a target Alpha share. Used for the design
  // demo before any snapshot exists, and for the preview buttons - which need
  // to show the four states the live feed may not reach for days.
  function demoSnapshot(alphaWeight) {
    var tilt = (alphaWeight - 50) / 50;
    var tokens = [];

    for (var i = 0; i < 10; i++) {
      var alpha = i / 10 < alphaWeight / 100;
      var base = alpha ? 62 + ((i * 7) % 26) : 14 + ((i * 11) % 30);
      tokens.push({
        symbol: DEMO_TICKERS[i % DEMO_TICKERS.length],
        dex: i % 2 ? "uniswap-v3-robinhood" : "pons-v2",
        quality: base,
        side: base >= 55 ? "alpha" : "beta",
        volumeUsd: Math.round(180000 / (i + 1.4)),
        holderCount: alpha ? 400 + i * 190 : 30 + i * 17,
        top10Percent: alpha ? 14 + i * 1.6 : 52 + i * 3.4,
      });
    }

    var alphaVolume = 0;
    var betaVolume = 0;
    tokens.forEach(function (t) {
      if (t.side === "alpha") alphaVolume += t.volumeUsd;
      else betaVolume += t.volumeUsd;
    });

    return {
      timestamp: new Date().toISOString(),
      alphetIndex: Math.round(clamp(46 + tilt * 26, 8, 92)),
      alphaWeight: alphaWeight,
      betaWeight: Number((100 - alphaWeight).toFixed(1)),
      verdict: verdictFor(alphaWeight),
      subScores: {
        holderDistribution: Math.round(clamp(48 + tilt * 30, 6, 96)),
        liquidityPermanence: Math.round(clamp(43 + tilt * 34, 4, 96)),
        devTrackRecord: Math.round(clamp(50 + tilt * 22, 10, 94)),
        rugSignals: Math.round(clamp(52 + tilt * 28, 8, 96)),
      },
      split: {
        alphaCount: tokens.filter(function (t) { return t.side === "alpha"; }).length,
        betaCount: tokens.filter(function (t) { return t.side === "beta"; }).length,
        alphaVolume: alphaVolume,
        betaVolume: betaVolume,
        totalVolume: alphaVolume + betaVolume,
        // Invented to match a real reading, where honeypots are removed from
        // the population before the split is taken.
        honeypots: 3,
        honeypotVolume: 41000,
      },
      tokens: tokens,
      raw: { source: "demo", chain: "Robinhood Chain", lookbackHours: 24, totals: { tokensSeen: 71, tokensScored: 10 } },
      demo: true,
    };
  }

  // Mirrors determineVerdict() in src/scoring.js. Duplicated rather than
  // fetched because the preview buttons have to work with no server at all.
  function verdictFor(alphaWeight) {
    if (alphaWeight >= 65) return { key: "alpha-heavy", label: "Alpha-heavy", summary: "Most money is buying spread supply and locked liquidity. The good end of a memecoin market." };
    if (alphaWeight >= 55) return { key: "alpha-lean", label: "Alpha lean", summary: "More money in quality than junk — but not by much. Read the token, not the gauge." };
    if (alphaWeight >= 45) return { key: "balanced", label: "Balanced", summary: "Close to even. Which one you get is down to what you buy." };
    if (alphaWeight >= 35) return { key: "beta-lean", label: "Beta lean", summary: "Money is leaning toward concentrated supply and pullable liquidity." };
    return { key: "beta-heavy", label: "Beta-heavy", summary: "Almost all the money is on the Beta side. Devs hold the float and can pull the pool." };
  }

  var SAMPLES = [
    { id: "live", label: "Live reading" },
    { id: "alpha-heavy", label: "Alpha-heavy", weight: 78 },
    { id: "alpha-lean", label: "Alpha lean", weight: 59 },
    { id: "balanced", label: "Balanced", weight: 49.5 },
    { id: "beta-lean", label: "Beta lean", weight: 39 },
    { id: "beta-heavy", label: "Beta-heavy", weight: 17 },
  ];

  // --------------------------------------------------------------
  // RENDER: GAUGE
  // --------------------------------------------------------------

  function currentSnapshot() {
    return state.sample ? state.sample : state.snapshot;
  }

  function renderGauge() {
    var snap = currentSnapshot();
    var alpha = snap.alphaWeight;

    if (alpha === null || alpha === undefined) {
      $("alphaPct").textContent = "—";
      $("betaPct").textContent = "—";
      $("verdictLabel").textContent = "No reading";
      $("verdictIndex").textContent = "";
      $("verdictSummary").textContent = "No tokens were readable on the last run.";
      return;
    }

    // The seam is clamped away from the very edges: at 0% the badge would sit
    // half outside the bar, and a 100/0 split is a reading you still need to
    // be able to see the shape of.
    var seam = clamp(alpha, 3, 97);

    $("alphaPct").textContent = alpha.toFixed(1) + "%";
    $("betaPct").textContent = snap.betaWeight.toFixed(1) + "%";
    $("gaugeAlpha").style.width = seam + "%";
    $("gaugeSeam").style.left = seam + "%";

    $("alphaNote").textContent = snap.split.alphaCount + " tokens · $" + compact(snap.split.alphaVolume);
    $("betaNote").textContent = snap.split.betaCount + " tokens · $" + compact(snap.split.betaVolume);

    $("verdictLabel").textContent = snap.verdict.label;
    $("verdictLabel").style.color = alpha >= 55 ? "var(--alpha)" : alpha >= 45 ? "var(--ink)" : "var(--beta)";
    // Honeypots are excluded from the split above, so the count has to say
    // "excluded" rather than read as one more category inside it - and it has
    // to carry the money, because the number of tokens removed says nothing
    // about how far their removal moved the seam.
    var out = snap.split.honeypots;
    var outVolume = snap.split.honeypotVolume;
    $("verdictIndex").textContent = "quality index " + snap.alphetIndex + "/100 · " +
      snap.split.alphaCount + " alpha / " + snap.split.betaCount + " beta" +
      (out
        ? " · " + out + " honeypot" + (out > 1 ? "s" : "") + " excluded" +
          (outVolume ? " ($" + compact(outVolume) + ")" : "")
        : "");
    $("verdictSummary").textContent = snap.verdict.summary;
  }

  function renderTicks() {
    var host = $("gaugeTicks");
    host.textContent = "";
    [35, 45, 55, 65].forEach(function (at) {
      var tick = el("div", "gauge-tick");
      tick.style.left = at + "%";
      tick.appendChild(el("span", null, at));
      host.appendChild(tick);
    });
  }

  function renderSamples() {
    var host = $("samplesRow");
    host.textContent = "";

    SAMPLES.forEach(function (sample) {
      var btn = el("button", "sample-btn", sample.label);
      btn.type = "button";
      if (sample.id === "live") btn.className += " live-btn";

      var isActive = sample.id === "live" ? !state.sample : state.sample && state.sample.sampleId === sample.id;
      if (isActive) btn.className += " active";

      btn.addEventListener("click", function () {
        if (sample.id === "live") {
          state.sample = null;
        } else {
          var snap = demoSnapshot(sample.weight);
          snap.sampleId = sample.id;
          state.sample = snap;
        }
        renderAll();
      });

      host.appendChild(btn);
    });
  }

  /**
   * One column per hour, rather than one per run.
   *
   * The collector runs whenever it is asked to, and a morning of manual runs
   * produced 8:56, 9:12, 9:24 and 9:59 as four separate columns - a log,
   * rather than a chart. Grouping by the hour a reading falls in fixes the
   * axis without inventing anything: each bar is still one reading that
   * actually happened, the last one taken in that hour.
   *
   * Deliberately not an average. Consecutive readings are 24h-window
   * measurements taken minutes apart, so they overlap almost entirely -
   * averaging them would put the bar at a number the gauge never showed while
   * barely changing its height.
   */
  function byHour(series) {
    var order = [];
    var index = {};

    series.forEach(function (snap) {
      var d = new Date(snap.timestamp);
      if (isNaN(d)) return;
      d.setMinutes(0, 0, 0);

      // Keyed on the full hour, not the hour of the day, so the same clock
      // hour on two different days stays two columns.
      var key = d.getTime();
      if (!index[key]) {
        index[key] = { hour: d, snaps: [] };
        order.push(index[key]);
      }
      index[key].snaps.push(snap);
    });

    order.sort(function (a, b) { return a.hour - b.hour; });

    return order.map(function (bucket) {
      // A measured reading beats a backfilled one sharing its hour, and a
      // later measured reading beats an earlier one.
      var measured = bucket.snaps.filter(function (s) { return !s.backfilled; });
      var pool = measured.length ? measured : bucket.snaps;

      return { hour: bucket.hour, snap: pool[pool.length - 1], count: bucket.snaps.length };
    });
  }

  function renderTrend() {
    var host = $("trend");
    host.textContent = "";

    var series = state.history.filter(function (s) {
      return s.alphaWeight !== null && s.alphaWeight !== undefined;
    });

    if (!series.length) {
      host.appendChild(el("div", "trend-empty", "No stored readings yet. Run `npm run mock` a few times, or `npm start` against a live endpoint."));
      $("trendMeta").textContent = "";
      return;
    }

    var hours = byHour(series).slice(-36);

    var readings = hours.reduce(function (sum, h) { return sum + h.count; }, 0);
    var filled = hours.filter(function (h) { return h.snap.backfilled; }).length;

    // Both numbers, when they differ. "10 hours" alone would look like the
    // collector had run ten times, which is the thing the grouping hides.
    var meta = [hours.length + " hour" + (hours.length === 1 ? "" : "s")];
    if (readings > hours.length) meta.push(readings + " readings");
    if (filled) meta.push(filled + " backfilled");
    $("trendMeta").textContent = meta.join(" · ");

    var lastDay = null;

    hours.forEach(function (entry) {
      var snap = entry.snap;
      var day = entry.hour.toDateString();
      var dayBreak = lastDay !== null && day !== lastDay;
      lastDay = day;

      var col = el("div", "trend-col" +
        (snap.backfilled ? " trend-filled" : "") +
        (dayBreak ? " trend-daybreak" : ""));

      var bar = el("div", "trend-bar");

      var a = el("div", "trend-alpha");
      a.style.height = clamp(snap.alphaWeight, 0, 100) + "%";
      bar.appendChild(a);
      bar.appendChild(el("div", "trend-beta"));

      col.title =
        snap.verdict.label + " — Alpha " + snap.alphaWeight.toFixed(1) + "%" +
        "\nRead at " + dayLabel(snap.timestamp) + ", " + timeLabel(snap.timestamp) +
        (entry.count > 1 ? " (last of " + entry.count + " readings this hour)" : "") +
        (snap.backfilled
          ? "\nBackfilled: today's quality scores re-weighted by this hour's volume. Not a measurement."
          : "");

      col.appendChild(bar);
      col.appendChild(el("div", "trend-time", hourLabel(entry.hour)));
      host.appendChild(col);
    });

    // A dimmed bar next to a solid one is not self-explanatory, and the
    // difference between the two is the whole caveat.
    // Short on the page, full explanation on hover. The caveat has to be
    // present, but it does not have to be a paragraph in the middle of a chart.
    setTrendNote(
      filled ? "Faded bars are reconstructed, not measured — they lean Alpha." : "",
      "Holder and liquidity data can't be read for past blocks, so those hours reuse today's quality " +
        "scores against the volume each hour actually saw. Tokens that already died are missing from them, " +
        "which biases the shape toward Alpha. They never reach the timeframe card."
    );
  }

  function setTrendNote(text, detail) {
    var note = $("trendNote");
    if (!note) return;
    note.textContent = text;
    note.title = detail || "";
    note.hidden = !text;
  }

  // --------------------------------------------------------------
  // RENDER: METRICS
  // --------------------------------------------------------------

  function renderMetrics() {
    var host = $("metricGrid");
    host.textContent = "";

    var snap = currentSnapshot();
    var scores = snap.subScores || {};
    var measuredOn = snap.measuredOn || {};

    // The whole scored population, not the trimmed list that rides along in
    // the snapshot. measuredOn counts against everything that was read, so
    // using tokens.length here would report "1 of 24" for something that was
    // actually 1 of 40.
    var total = (snap.raw && snap.raw.totals && snap.raw.totals.tokensScored) ||
      (snap.tokens || []).length;

    METRICS.forEach(function (metric) {
      var score = scores[metric.key];
      var unmeasured = score === undefined || score === null;
      var card = el("div", "metric");

      var top = el("div", "metric-top");
      top.appendChild(el("div", "metric-name", metric.name));
      top.appendChild(el("div", "metric-weight", Math.round(metric.weight * 100) + "% of score"));
      card.appendChild(top);

      var value = el("div", "metric-score", unmeasured ? "—" : score);
      value.style.color = scoreColor(unmeasured ? null : score);
      card.appendChild(value);

      var meter = el("div", "metric-meter");
      var fill = el("div", "metric-fill");
      fill.style.width = (unmeasured ? 0 : clamp(score, 0, 100)) + "%";
      fill.style.background = scoreColor(unmeasured ? null : score);
      meter.appendChild(fill);
      card.appendChild(meter);

      // Coverage is part of the reading. A metric that could only be read on a
      // third of the population is a different claim from one read on all of
      // it, and hiding that would make the tile look more certain than it is.
      var covered = measuredOn[metric.key];

      if (unmeasured) {
        card.appendChild(el("p", "metric-gap",
          "Not measurable here — weight shared across the other three."));
      } else if (total && covered !== undefined && covered < total) {
        // A score averaged over a handful of tokens is not a claim about the
        // market, and at a glance "100" reads like one. Below a quarter
        // coverage the tile says so in its own right rather than leaving the
        // reader to notice the fraction.
        var thin = covered / total < 0.25;
        card.appendChild(el("p", "metric-gap" + (thin ? " metric-gap-thin" : ""),
          thin
            ? "Only read on " + covered + " of " + total + " tokens — too few to call it a market reading."
            : "Read on " + covered + " of " + total + " tokens."));
      }

      card.appendChild(el("p", "metric-desc", metric.desc));
      card.appendChild(el("p", "metric-src", metric.src));
      host.appendChild(card);
    });
  }

  var TIMEFRAMES = [
    { key: "m15", label: "15m" },
    { key: "h1", label: "1h" },
    { key: "h6", label: "6h" },
    { key: "h24", label: "24h" },
  ];

  function timeframeLabel(key) {
    for (var i = 0; i < TIMEFRAMES.length; i++) {
      if (TIMEFRAMES[i].key === key) return TIMEFRAMES[i].label;
    }
    return key;
  }

  // The gauge re-scored over each window.
  //
  // Three of the four metrics are facts about right now and read the same
  // whichever timeframe you pick — supply concentration, LP permanence and a
  // dev's history don't have a 15-minute version. How a token is trading does,
  // so the Alpha/Beta line can fall differently at 15 minutes than over a day.
  // The gap between the two is money rotating between the sides.
  function renderTimeframes() {
    var row = $("tfRow");
    var body = $("tfBody");
    row.textContent = "";
    body.textContent = "";

    var windows = state.windows;
    if (!windows) {
      body.appendChild(el("div", "tf-note", "Timeframes fill in after the first live reading."));
      return;
    }

    var available = TIMEFRAMES.filter(function (t) { return windows[t.key]; });
    if (!available.length) {
      body.appendChild(el("div", "tf-note", "This reading carries no timeframe data."));
      return;
    }

    if (!windows[state.timeframe]) state.timeframe = available[available.length - 1].key;
    var active = windows[state.timeframe];

    TIMEFRAMES.forEach(function (tf) {
      var btn = el("button", "tf-btn" + (tf.key === state.timeframe ? " active" : ""), tf.label);
      btn.type = "button";
      btn.disabled = !windows[tf.key];
      btn.addEventListener("click", function () {
        state.timeframe = tf.key;
        renderTimeframes();
      });
      row.appendChild(btn);
    });

    var summary = el("div", "tf-summary");
    summary.appendChild(stat("Alpha share", active.alphaWeight.toFixed(1) + "%", "var(--alpha)"));
    summary.appendChild(stat("Beta share", active.betaWeight.toFixed(1) + "%", "var(--beta)"));
    summary.appendChild(stat("Quality index", active.alphetIndex, scoreColor(active.alphetIndex)));
    summary.appendChild(stat("Volume", "$" + compact(active.split.totalVolume), "var(--ink)"));
    summary.appendChild(stat("Split", active.split.alphaCount + " / " + active.split.betaCount, "var(--muted)"));
    body.appendChild(summary);

    var headline = windows[state.headlineWindow] || windows.h24;

    METRICS.forEach(function (metric) {
      var value = active.subScores[metric.key];
      var unmeasured = value === null || value === undefined;

      var line = el("div", "row");
      line.appendChild(el("div", "row-label", metric.name));

      var meter = el("div", "row-meter");
      var fill = el("div", "metric-fill");
      fill.style.width = (unmeasured ? 0 : clamp(value, 0, 100)) + "%";
      fill.style.background = scoreColor(unmeasured ? null : value);
      meter.appendChild(fill);
      line.appendChild(meter);

      var cell = el("div", "row-value", unmeasured ? "—" : value);
      cell.style.color = scoreColor(unmeasured ? null : value);
      line.appendChild(cell);

      // Against the headline window rather than against the previous period:
      // there is no "previous 15 minutes" in this data, and "how does right
      // now differ from the day" is the more useful question anyway.
      var ref = headline ? headline.subScores[metric.key] : null;
      if (state.timeframe === state.headlineWindow || unmeasured || ref === null || ref === undefined) {
        line.appendChild(el("span", "row-change flat", "—"));
      } else {
        var delta = value - ref;
        var span = el("span", "row-change " + (Math.abs(delta) < 0.5 ? "flat" : delta > 0 ? "up" : "down"));
        span.textContent = (delta > 0 ? "+" : "") + delta.toFixed(0);
        span.title = "vs " + timeframeLabel(state.headlineWindow);
        line.appendChild(span);
      }

      body.appendChild(line);
    });

    var note;
    if (state.timeframe === state.headlineWindow) {
      note = "The window the gauge above shows. Other timeframes are compared against it.";
    } else {
      var shift = active.alphaWeight - (headline ? headline.alphaWeight : active.alphaWeight);
      note = "Alpha share is " + (shift >= 0 ? "+" : "") + shift.toFixed(1) + " points vs " +
        timeframeLabel(state.headlineWindow) + ". Only rug signals differ by timeframe — the other three are current-state reads.";
    }
    body.appendChild(el("div", "tf-note", note));
  }

  function stat(label, value, color) {
    var wrap = el("div", "tf-stat");
    wrap.appendChild(el("div", "tf-stat-label", label));
    var node = el("div", "tf-stat-value", value);
    node.style.color = color;
    wrap.appendChild(node);
    return wrap;
  }

  // --------------------------------------------------------------
  // RENDER: TOKENS
  // --------------------------------------------------------------

  function shortAddress(address) {
    return address.slice(0, 6) + "…" + address.slice(-4);
  }

  // A stable number from an address, so a token's mark looks the same every
  // time the page is drawn.
  function hashOf(text) {
    var hash = 0;
    for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return hash;
  }

  /**
   * A token's logo, or a monogram when it has none.
   *
   * Roughly three in ten RHC tokens have no image on file, and a broken-image
   * icon in every third row looks like the page is failing rather than like
   * the token being new. The monogram is the same shape and size, so a row
   * with a picture and a row without still line up.
   *
   * Remote images can also 404 after the fact, so the fallback is wired to
   * `onerror` too rather than only to a missing URL.
   */
  function tokenLogo(token) {
    var wrap = el("div", "token-logo");

    var monogram = el("span", "token-monogram", (token.symbol || "?").slice(0, 2).toUpperCase());
    var tint = token.side === "alpha" ? "204, 255, 0" : "255, 255, 255";

    // Tinted in its own side's colour, at a depth fixed by the address. Three
    // in ten RHC tokens have no logo on file at all, so this has to read as a
    // mark the page meant to draw rather than as an image that failed - a flat
    // grey circle in every third row looks like breakage.
    var depth = [0.1, 0.16, 0.22][hashOf(token.address || token.symbol || "") % 3];
    monogram.style.background = "rgba(" + tint + ", " + depth + ")";
    monogram.style.color = token.side === "alpha" ? "var(--alpha)" : "var(--beta)";
    wrap.appendChild(monogram);

    if (!token.imageUrl) return wrap;

    var img = document.createElement("img");
    img.className = "token-img";
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", function () {
      img.remove();
    });
    img.src = token.imageUrl;
    wrap.appendChild(img);

    return wrap;
  }

  /**
   * Copy text, the long way round when the short way isn't available.
   *
   * navigator.clipboard only exists in a secure context. localhost counts, but
   * this page is also opened straight off disk and over plain http on a LAN,
   * and there the modern API is simply undefined - so the old textarea trick
   * stays as a fallback rather than the copy silently doing nothing.
   */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var tmp = document.createElement("textarea");
        tmp.value = text;
        tmp.style.position = "fixed";
        tmp.style.opacity = "0";
        document.body.appendChild(tmp);
        tmp.select();
        document.execCommand("copy");
        tmp.remove();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * The contract address, click to copy.
   *
   * Shown on every row rather than only on colliding tickers. A ticker is not
   * an identity on this chain - four of them are used by more than one
   * contract in this very reading - so the address is the only thing that
   * actually names the token you are about to buy.
   */
  function addressButton(token) {
    var btn = el("button", "token-ca");
    btn.type = "button";

    var label = el("span", "token-ca-text", shortAddress(token.address));
    btn.appendChild(label);
    btn.appendChild(el("span", "token-ca-icon", "⧉"));

    btn.title = token.duplicateSymbol
      ? "Another token in this reading uses this ticker — they are different contracts. Click to copy this address."
      : "Click to copy: " + token.address;

    btn.addEventListener("click", function () {
      copyText(token.address).then(
        function () { flash("Copied"); },
        function () { flash("Copy failed"); }
      );

      function flash(message) {
        label.textContent = message;
        btn.classList.add("copied");
        setTimeout(function () {
          label.textContent = shortAddress(token.address);
          btn.classList.remove("copied");
        }, 1200);
      }
    });

    return btn;
  }

  function renderTokens() {
    var host = $("tokenTable");
    host.textContent = "";

    var snap = currentSnapshot();
    var tokens = snap.tokens || [];

    if (!tokens.length) {
      host.appendChild(el("div", "token-empty", "No scored tokens in the latest reading."));
      $("tokensMeta").textContent = "";
      return;
    }

    var totals = (snap.raw && snap.raw.totals) || {};
    $("tokensMeta").textContent =
      (totals.tokensScored || tokens.length) + " scored of " +
      (totals.tokensSeen || tokens.length) + " found on " + ((snap.raw && snap.raw.chain) || "chain");

    // A run that lost part of its shortlist read less of the market than the
    // gauge implies, and the shortlist is ordered by volume — so the tokens
    // that go missing are not a random sample of it.
    if (totals.tokensSkipped) {
      var share = Math.round((totals.tokensSkipped / totals.tokensShortlisted) * 100);
      host.appendChild(el("div", "token-warn",
        "Couldn't read " + totals.tokensSkipped + " of " + totals.tokensShortlisted + " tokens (" + share +
        "%) this run — usually RPC throttling. This covers less of the market than it looks."));
    }

    var head = el("div", "token-head");
    ["#", "Side", "Token", "Score", "Volume", "Holders", "Top 10"].forEach(function (label, i) {
      head.appendChild(el("div", i >= 3 ? "token-num" : null, label));
    });
    host.appendChild(head);

    // Several hundred rows is a wall, so the table pages rather than
    // truncating. Ranks run across pages — page two starts at 26 — so a row's
    // number always means its place in the whole market, not on the screen.
    var pages = Math.max(1, Math.ceil(tokens.length / PAGE_SIZE));
    if (state.tokenPage >= pages) state.tokenPage = 0;

    var start = state.tokenPage * PAGE_SIZE;
    var shown = tokens.slice(start, start + PAGE_SIZE);

    shown.forEach(function (token, index) {
      var row = el("div", "token-row");
      row.appendChild(el("div", "token-rank", start + index + 1));

      var sideCell = el("div");
      sideCell.appendChild(el("span", "pill " + (token.side === "alpha" ? "pill-alpha" : "pill-beta"), token.side));
      row.appendChild(sideCell);

      var nameCell = el("div", "token-name");
      nameCell.appendChild(tokenLogo(token));

      var text = el("div", "token-text");
      var sym = el("div", "token-sym", token.symbol);
      if (token.honeypot) sym.appendChild(el("span", "token-flag", " · honeypot"));
      text.appendChild(sym);

      if (token.address) text.appendChild(addressButton(token));

      nameCell.appendChild(text);
      row.appendChild(nameCell);

      var score = el("div", "token-num", token.quality);
      score.style.color = scoreColor(token.quality);
      score.style.fontWeight = "700";

      // Which metrics were readable stays in the tooltip rather than as a
      // mark on the number - the asterisk sat on most rows, and a footnote
      // that applies to almost everything stops being a footnote.
      var gaps = token.unmeasured || [];
      if (gaps.length) {
        score.title = gaps.length + " of 4 metrics couldn't be read for this token (" +
          gaps.join(", ") + "). Its score is the rest, reweighted.";
      }
      row.appendChild(score);

      row.appendChild(el("div", "token-num", "$" + compact(token.volumeUsd)));

      // "≥" when the holder set couldn't be enumerated. Printing a bare 400
      // there would be reporting the candidate cap as a fact about the token.
      var holders = el("div", "token-num",
        (token.holderCountIsFloor ? "≥" : "") + num(token.holderCount));
      if (token.holderCountIsFloor) {
        holders.style.color = "var(--dim)";
        holders.title = "At least this many — the holder set was too large to enumerate.";
      }
      row.appendChild(holders);

      var top10 = el("div", "token-num",
        token.top10Percent === null || token.top10Percent === undefined
          ? "—"
          : token.top10Percent.toFixed(1) + "%");
      if (token.top10Percent === null || token.top10Percent === undefined) {
        top10.style.color = "var(--dim)";
        top10.title = "Not measurable: the holder set was too large to read in full, " +
          "and a share taken from part of it understates concentration.";
      }
      row.appendChild(top10);

      host.appendChild(row);
    });

    if (pages > 1) host.appendChild(pager(pages, start, shown.length, tokens.length));
  }

  /**
   * Page numbers, windowed with ellipses so fourteen pages don't become
   * fourteen buttons: ‹ 1 … 5 6 [7] 8 9 … 14 ›
   */
  function pager(pages, start, showing, total) {
    var wrap = el("div", "pager");
    var current = state.tokenPage;

    var go = function (page) {
      return function () {
        state.tokenPage = clamp(page, 0, pages - 1);
        renderTokens();
      };
    };

    var button = function (label, page, opts) {
      var btn = el("button", "page-btn" + ((opts && opts.className) || ""), label);
      btn.type = "button";
      if (opts && opts.disabled) btn.disabled = true;
      else btn.addEventListener("click", go(page));
      return btn;
    };

    wrap.appendChild(button("‹", current - 1, { disabled: current === 0 }));

    // Always the first and last page, plus a window either side of current.
    var wanted = { 0: true };
    wanted[pages - 1] = true;
    for (var i = current - 1; i <= current + 1; i++) {
      if (i >= 0 && i < pages) wanted[i] = true;
    }

    var last = -1;
    Object.keys(wanted)
      .map(Number)
      .sort(function (a, b) { return a - b; })
      .forEach(function (page) {
        if (page - last > 1) wrap.appendChild(el("span", "page-gap", "…"));
        wrap.appendChild(button(String(page + 1), page, {
          className: page === current ? " page-current" : "",
        }));
        last = page;
      });

    wrap.appendChild(button("›", current + 1, { disabled: current === pages - 1 }));
    wrap.appendChild(el("span", "page-count",
      (start + 1) + "–" + (start + showing) + " of " + total));

    return wrap;
  }

  // --------------------------------------------------------------
  // RENDER: STATIC SECTIONS
  // --------------------------------------------------------------

  function renderScale() {
    var host = $("scale");
    host.textContent = "";

    BANDS.forEach(function (bandInfo) {
      var item = el("div", "scale-item");
      item.style.borderLeftColor = bandInfo.color;
      item.appendChild(el("div", "scale-range", bandInfo.range + "% alpha"));
      var name = el("div", "scale-name", bandInfo.label);
      name.style.color = bandInfo.color;
      item.appendChild(name);
      item.appendChild(el("div", "scale-note", bandInfo.note));
      host.appendChild(item);
    });
  }

  function renderStatus() {
    var snap = currentSnapshot();
    var dot = $("statusDot");
    var text = $("statusText");
    var foot = $("footNote");

    if (state.sample) {
      dot.className = "dot";
      text.textContent = "Preview reading";
      foot.textContent = "You're looking at a preview reading, not a measurement. Press “Live reading” to go back to the feed.";
      return;
    }

    if (state.live && !snap.demo) {
      dot.className = "dot live";
      var source = (snap.raw && snap.raw.source) || "live";
      text.textContent = source === "mock" ? "Mock feed" : "Live feed";
      foot.textContent = "Last reading " + new Date(snap.timestamp).toLocaleString() +
        " from " + ((snap.raw && snap.raw.chain) || state.meta.chain) +
        ", source: " + source + ".";
      return;
    }

    dot.className = "dot";
    text.textContent = "Demo data";
    foot.textContent = "This page is a design demo. The numbers shown are illustrative until a live snapshot is available at /api/latest.";
  }

  function renderCutoffs() {
    $("vsAlphaCut").textContent = "score ≥ " + state.meta.alphaCutoff;
    $("vsBetaCut").textContent = "score < " + state.meta.alphaCutoff;
  }

  function renderAll() {
    renderGauge();
    renderSamples();
    renderMetrics();
    renderTimeframes();
    renderTokens();
    renderStatus();
    renderCutoffs();
  }

  // --------------------------------------------------------------
  // DATA
  // --------------------------------------------------------------

  function getJson(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error(url + " returned " + res.status);
      return res.json();
    });
  }

  function load() {
    // Each of these renders on arrival rather than waiting for the others, so
    // a slow or broken endpoint costs only its own section.
    getJson("/api/meta.json")
      .then(function (meta) {
        state.meta = Object.assign(state.meta, meta);
        renderCutoffs();
      })
      .catch(function () {});

    getJson("/api/latest.json")
      .then(function (data) {
        if (!data.snapshot) return;
        state.snapshot = data.snapshot;
        state.live = true;
        renderAll();
      })
      .catch(function () {});

    getJson("/api/history.json")
      .then(function (data) {
        state.history = data.snapshots || [];
        renderTrend();
      })
      .catch(function () {
        renderTrend();
      });

    getJson("/api/windows.json")
      .then(function (data) {
        state.windows = data.windows;
        if (data.headlineWindow) state.headlineWindow = data.headlineWindow;
        renderTimeframes();
      })
      .catch(function () {});
  }

  // --------------------------------------------------------------
  // BOOT
  // --------------------------------------------------------------

  if (Shell) {
    Shell.initDrawer();
    Shell.initContractCopy();
    Shell.initScrollSpy("#nav .nav-item");
  }

  renderTicks();
  renderScale();
  renderAll();
  renderTrend();
  load();
})();
