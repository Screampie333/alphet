// rollup.js
// Aggregates stored snapshots into timeframe windows (5m / 1h / 6h / 24h) and
// works out how each window compares with the one before it.
//
// The comparison is the point. "77K SOL" on its own says nothing; "77K, up
// 17.9% on the previous 6 hours" is a reading. So every window is computed
// twice - the current period and the one immediately before it - and the
// change between them is what the UI leads with.
//
// A window can only be as fine as the collector's interval: with a snapshot
// every 30 minutes there is no such thing as a 5-minute window. Windows
// shorter than one interval are reported unavailable, and windows that are
// only partly covered report how much of themselves they actually have, so
// the page can say "6h window, 2h of data" instead of quietly showing a
// number that looks complete.

import { config } from "./config.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const WINDOWS = [
  { key: "5m", label: "5m", ms: 5 * MINUTE },
  { key: "1h", label: "1h", ms: HOUR },
  { key: "6h", label: "6h", ms: 6 * HOUR },
  { key: "24h", label: "24h", ms: 24 * HOUR },
];

// The four signals, as the numbers a trader actually reads.
//
// Rates are computed as a ratio of sums across the window, never as a mean of
// each snapshot's ratio - averaging ratios lets a quiet snapshot with 3
// tokens weigh as heavily as a busy one with 3,000, which quietly skews the
// rate. `upIsGood` drives the colour of the change: more volume is good news,
// more rugs is not, and without it a rising rug rate would render green.
export const METRICS = [
  {
    key: "graduationRate",
    label: "Graduation rate",
    unit: "%",
    decimals: 2,
    upIsGood: true,
    score: "graduation",
    compute: (s) => ratio(sum(s, "tokensGraduated"), sum(s, "tokensCreated")) * 100,
  },
  {
    key: "volume",
    label: "Volume",
    unit: " SOL",
    decimals: 0,
    upIsGood: true,
    score: "volume",
    // A sum, so a window missing readings reports less than happened. Rates
    // and means above are ratios over whatever was collected and stay honest
    // at any coverage; this one does not.
    coverageSensitive: true,
    compute: (s) => sum(s, "totalVolumeSol"),
  },
  {
    key: "rugRate",
    label: "Rug rate",
    unit: "%",
    decimals: 2,
    upIsGood: false,
    score: "rug",
    compute: (s) => ratio(sum(s, "tokensRugged"), sum(s, "activeTokens")) * 100,
  },
  {
    key: "volatility",
    label: "Volatility",
    unit: "%",
    decimals: 1,
    upIsGood: false,
    score: "volatility",
    compute: (s) => mean(s.map((x) => Number(x.raw?.avgPriceSwingPercent) || 0)),
  },
];

// Secondary counts, shown underneath the four signals.
export const COUNTS = [
  { key: "tokensCreated", label: "Created", upIsGood: true },
  { key: "tokensGraduated", label: "Graduated", upIsGood: true },
  // Also a sum, and unlike created/graduated it has no on-chain source to
  // fall back on, so it shrinks with coverage too.
  { key: "tokensRugged", label: "Rugged", upIsGood: false, coverageSensitive: true },
];

function sum(snapshots, field) {
  return snapshots.reduce((total, s) => total + (Number(s.raw?.[field]) || 0), 0);
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((total, v) => total + v, 0) / values.length;
}

function ratio(top, bottom) {
  return bottom > 0 ? top / bottom : 0;
}

// Percentage change, or null when there's nothing to compare against.
// A previous value of zero has no meaningful percentage - "up from nothing"
// is not 100%, it's undefined - so it returns null and the UI shows a dash.
function percentChange(current, previous) {
  if (current === null || previous === null) return null;
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * Roll one window up.
 *
 * @param snapshots  every snapshot available, any order
 * @param windowMs   length of the window
 * @param now        end of the current period
 */
export function rollupWindow(snapshots, windowMs, now = Date.now()) {
  const at = (s) => new Date(s.timestamp).getTime();

  const currentStart = now - windowMs;
  const previousStart = now - windowMs * 2;

  const current = snapshots.filter((s) => at(s) > currentStart && at(s) <= now);
  const previous = snapshots.filter((s) => at(s) > previousStart && at(s) <= currentStart);

  const metrics = {};
  for (const metric of METRICS) {
    const value = current.length ? metric.compute(current) : null;
    const before = previous.length ? metric.compute(previous) : null;

    metrics[metric.key] = {
      label: metric.label,
      unit: metric.unit,
      decimals: metric.decimals,
      upIsGood: metric.upIsGood,
      coverageSensitive: Boolean(metric.coverageSensitive),
      value,
      previous: before,
      changePercent: percentChange(value, before),
      // the 0-100 sub-score, averaged, for the meter under each number
      score: current.length
        ? Math.round(mean(current.map((s) => Number(s.subScores?.[metric.score]) || 0)))
        : null,
    };
  }

  const counts = {};
  for (const count of COUNTS) {
    const value = current.length ? sum(current, count.key) : null;
    const before = previous.length ? sum(previous, count.key) : null;

    counts[count.key] = {
      label: count.label,
      upIsGood: count.upIsGood,
      coverageSensitive: Boolean(count.coverageSensitive),
      value,
      changePercent: percentChange(value, before),
    };
  }

  const indexNow = current.length ? mean(current.map((s) => s.index)) : null;
  const indexBefore = previous.length ? mean(previous.map((s) => s.index)) : null;

  return {
    readings: current.length,
    previousReadings: previous.length,
    index: indexNow === null ? null : Math.round(indexNow),
    indexChangePercent: percentChange(indexNow, indexBefore),
    metrics,
    counts,
  };
}

/**
 * Roll every window up at once, so switching timeframe on the page is
 * instant rather than another round trip.
 */
export function rollupAll(snapshots, now = Date.now()) {
  const intervalMs = config.intervalMinutes * MINUTE;

  const windows = WINDOWS.map((win) => {
    // A window needs to be at least one collection interval long to hold
    // anything at all.
    const available = win.ms >= intervalMs;

    if (!available) {
      return {
        key: win.key,
        label: win.label,
        ms: win.ms,
        available: false,
        reason: `Needs INTERVAL_MINUTES of ${Math.floor(win.ms / MINUTE)} or less (currently ${config.intervalMinutes}).`,
        readings: 0,
        coveragePercent: 0,
        index: null,
        metrics: {},
        counts: {},
      };
    }

    const rolled = rollupWindow(snapshots, win.ms, now);

    // How much of the window we actually have readings for. A 24h window with
    // 4 hours of collection behind it is a real number, but it is a number
    // about 4 hours - the page says so rather than implying a full day.
    const expected = Math.max(1, Math.round(win.ms / intervalMs));
    const coveragePercent = Math.min(100, Math.round((rolled.readings / expected) * 100));

    return {
      key: win.key,
      label: win.label,
      ms: win.ms,
      available: true,
      reason: null,
      expectedReadings: expected,
      coveragePercent,
      ...rolled,
    };
  });

  return { intervalMinutes: config.intervalMinutes, windows };
}
