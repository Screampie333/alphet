// scoring.js
// Turns raw numbers into the Haboob weather index.
//
// The idea in three steps:
//   1. turn each raw number into a 0-100 sub-score
//   2. combine the sub-scores using the weights in config.js
//   3. map the final 0-100 index onto a weather condition
//
// Sub-scores are relative to your own recent history, not to fixed numbers.
// That matters: "50,000 SOL of volume" means nothing on its own, but
// "double the usual volume" means a lot.

import { config } from "./config.js";

// Keep a number inside 0-100.
function clamp(n) {
  return Math.max(0, Math.min(100, n));
}

// Compare today's value to a baseline average.
// Same as baseline -> 50. Double the baseline -> 100. Half -> 25.
function relativeScore(current, baseline) {
  if (!baseline || baseline <= 0) return 50; // no history yet, assume neutral
  const ratio = current / baseline;
  return clamp(ratio * 50);
}

// Work out the average of one field across past snapshots.
function averageOf(snapshots, getValue) {
  if (!snapshots.length) return 0;
  const total = snapshots.reduce((sum, s) => sum + (getValue(s) || 0), 0);
  return total / snapshots.length;
}

/**
 * Calculate all four sub-scores.
 *
 * @param raw      today's raw numbers from collector.js
 * @param history  past snapshots, used as the baseline
 */
// Rates are read over a trailing window rather than off the single newest
// snapshot.
//
// A five-minute window holds 0-5 graduations, and a count that small is
// mostly Poisson noise: measured across 41 real snapshots the per-window
// graduation rate ran 0.0-8.3% with 61% variation, while the same data pooled
// over an hour ran 2.4-4.1% with 14%. The means agreed - 3.23% against 3.04%
// - so pooling costs no accuracy, it only stops the score reading market
// noise as market news. That swing was what pinned the tiles at 0 and 100.
//
// Twelve snapshots is an hour at the default five-minute interval.
const POOL_SNAPSHOTS = 12;

function sumOf(snapshots, getValue) {
  return snapshots.reduce((total, s) => total + (getValue(s) || 0), 0);
}

export function calculateSubScores(raw, history = []) {
  // The newest snapshot has not been stored yet, so it is prepended here to
  // stand at the head of its own trailing window.
  const withCurrent = [...history, { raw }];
  const recent = withCurrent.slice(-POOL_SNAPSHOTS);

  // The baseline must not overlap the pooled window, or each would drag the
  // other toward the middle and every score would sit near 50.
  const baseline = withCurrent.slice(0, Math.max(0, withCurrent.length - POOL_SNAPSHOTS));

  // --- 1. Graduation rate ---
  // A ratio of sums across the window, not the average of each snapshot's own
  // ratio: a quiet window with 3 tokens must not weigh as much as a busy one
  // with 300.
  const created = sumOf(recent, (s) => s.raw.tokensCreated);
  const gradRate = created > 0 ? sumOf(recent, (s) => s.raw.tokensGraduated) / created : 0;

  const baseCreated = sumOf(baseline, (s) => s.raw.tokensCreated);
  const baselineGradRate =
    baseCreated > 0 ? sumOf(baseline, (s) => s.raw.tokensGraduated) / baseCreated : 0;

  const graduationScore = relativeScore(gradRate, baselineGradRate);

  // --- 2. Volume ---
  const volume = averageOf(recent, (s) => s.raw.totalVolumeSol);
  const baselineVolume = averageOf(baseline, (s) => s.raw.totalVolumeSol);
  const volumeScore = relativeScore(volume, baselineVolume);

  // --- 3. Rug rate (inverted: more rugs = lower score) ---
  const active = sumOf(recent, (s) => s.raw.activeTokens);
  const rugRate = active > 0 ? sumOf(recent, (s) => s.raw.tokensRugged) / active : 0;

  const baseActive = sumOf(baseline, (s) => s.raw.activeTokens);
  const baselineRugRate =
    baseActive > 0 ? sumOf(baseline, (s) => s.raw.tokensRugged) / baseActive : 0;

  const rugRaw = relativeScore(rugRate, baselineRugRate);
  const rugScore = clamp(100 - rugRaw); // invert - high rugs should hurt

  // --- 4. Volatility (inverted: wilder swings = lower score) ---
  const swing = averageOf(recent, (s) => s.raw.avgPriceSwingPercent);
  const baselineSwing = averageOf(baseline, (s) => s.raw.avgPriceSwingPercent);
  const volatilityRaw = relativeScore(swing, baselineSwing);
  const volatilityScore = clamp(100 - volatilityRaw);

  return {
    graduation: Math.round(graduationScore),
    volume: Math.round(volumeScore),
    rug: Math.round(rugScore),
    volatility: Math.round(volatilityScore),

    // The pooled figures the scores were actually built from, plus how many
    // snapshots went into them - a score is not readable without knowing how
    // much it is standing on.
    rates: {
      graduationRatePercent: Number((gradRate * 100).toFixed(2)),
      rugRatePercent: Number((rugRate * 100).toFixed(2)),
      avgPriceSwingPercent: Number((swing || 0).toFixed(2)),
      volumeSol: Number((volume || 0).toFixed(2)),
      pooledSnapshots: recent.length,
      baselineSnapshots: baseline.length,
    },
  };
}

/**
 * Combine the sub-scores into one 0-100 index using the config weights.
 */
export function calculateIndex(subScores) {
  const w = config.weights;

  const index =
    subScores.graduation * w.graduationRate +
    subScores.volume * w.volume +
    subScores.rug * w.rugRate +
    subScores.volatility * w.volatility;

  return Math.round(clamp(index));
}

/**
 * Map the index onto a weather condition.
 */
export function determineCondition(index, subScores, historyCount = 0) {
  const t = config.thresholds;

  // Extreme overrides everything: when swings are this wild, the average
  // index stops being meaningful and people just need a warning.
  //
  // But "wild" is measured against your own baseline, so with only a couple
  // of snapshots on file the baseline is meaningless and this fires almost
  // every run. We require a real baseline before it can trigger at all.
  const hasRealBaseline = historyCount >= config.minSnapshotsForExtreme;
  const swingIsExtreme =
    hasRealBaseline &&
    100 - subScores.volatility >= config.extremeVolatilityCutoff;

  if (swingIsExtreme) {
    return {
      key: "extreme",
      label: "Extreme",
      emoji: "🌪️",
      summary:
        "Wild swings across the board. One token is dragging the whole market, or everything is moving at once.",
    };
  }

  if (index >= t.sunny) {
    return {
      key: "sunny",
      label: "Sunny",
      emoji: "☀️",
      summary:
        "Lots of tokens graduating, volume is up, rugs are below normal. The friendliest conditions to enter.",
    };
  }

  if (index >= t.cloudy) {
    return {
      key: "cloudy",
      label: "Cloudy",
      emoji: "⛅",
      summary:
        "Normal volume, no clear trend either way. Nothing here rewards rushing.",
    };
  }

  if (index >= t.overcast) {
    return {
      key: "overcast",
      label: "Overcast",
      emoji: "🌧️",
      summary:
        "Volume is fading and fewer tokens are making it off the bonding curve.",
    };
  }

  return {
    key: "storm",
    label: "Storm",
    emoji: "⛈️",
    summary:
      "Rugs are above normal and tokens are collapsing together. Hard conditions.",
  };
}

/**
 * Run the whole scoring pipeline on one set of raw numbers.
 */
export function score(raw, history = []) {
  const subScores = calculateSubScores(raw, history);
  const index = calculateIndex(subScores);
  const condition = determineCondition(index, subScores, history.length);

  return {
    timestamp: new Date().toISOString(),
    index,
    condition,
    subScores,
    raw,
    baselineSnapshots: history.length,
  };
}
