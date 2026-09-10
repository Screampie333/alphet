// report.js
// Turns a scored snapshot into text a human can read.
//
// Two formats:
//   - a console version, for when you run this yourself
//   - a short X/Twitter version, ready to post

import { config } from "./config.js";

function bar(value, width = 10) {
  const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * width);
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

// The gauge as one line of text: the seam sits wherever the money is.
function gauge(alphaWeight, width = 40) {
  const seam = Math.round((alphaWeight / 100) * width);
  return "|" + "=".repeat(seam) + "><" + "~".repeat(width - seam) + "|";
}

const LABELS = {
  holderDistribution: "Holder spread",
  liquidityPermanence: "Liq. permanence",
  devTrackRecord: "Dev record",
  rugSignals: "Rug signals",
};

export function consoleReport(snapshot) {
  const { alphetIndex, alphaWeight, betaWeight, verdict, subScores, split, tokens, raw } = snapshot;

  if (alphetIndex === null) {
    return `\n  ALPHET - no readable tokens this run (${raw.source})\n`;
  }

  const lines = [
    "",
    "==============================================",
    "  ALPHET QUALITY GAUGE",
    `  ${new Date(snapshot.timestamp).toLocaleString("en-US", {
      timeZone: config.displayTimeZone,
      dateStyle: "full",
      timeStyle: "short",
    })}`,
    "==============================================",
    "",
    `  ALPHA ${alphaWeight.toFixed(1)}%   ${gauge(alphaWeight)}   ${betaWeight.toFixed(1)}% BETA`,
    "",
    `  ${verdict.label.toUpperCase()}   -   quality index ${alphetIndex}/100`,
    "",
    `  ${verdict.summary}`,
    "",
    "  ------------------------------------------",
    "  metrics (0-100, higher is more Alpha)",
    ...Object.entries(subScores).map(([key, value]) =>
      value === null
        ? `  ${LABELS[key].padEnd(16)} ${" ".repeat(12)}  not measurable`
        : `  ${LABELS[key].padEnd(16)} ${bar(value)}  ${value}`
    ),
    "  ------------------------------------------",
    "",
    "  The split",
    `    tokens read        ${raw.totals.tokensScored} of ${raw.totals.tokensSeen} found on ${raw.chain}`,
    ...(raw.totals.tokensSkipped
      ? [`    NOT READ           ${raw.totals.tokensSkipped} of ${raw.totals.tokensShortlisted} shortlisted - this reading covers less than it appears`]
      : []),
    `    alpha / beta       ${split.alphaCount} / ${split.betaCount} tokens`,
    `    money into alpha   $${split.alphaVolume.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    `    money into beta    $${split.betaVolume.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    `    honeypots found    ${split.honeypots}`,
    "",
  ];

  // The tokens carrying the reading. A gauge that moved and no way to see what
  // moved it is not something anyone can check.
  if (tokens.length) {
    lines.push("  Top by volume");
    for (const token of tokens.slice(0, 8)) {
      const side = token.side === "alpha" ? "ALPHA" : "beta ";
      lines.push(
        `    ${side}  ${String(token.quality).padStart(3)}  ${token.symbol.padEnd(12)} ` +
          `$${token.volumeUsd.toLocaleString("en-US", { maximumFractionDigits: 0 }).padStart(10)}` +
          `  ${token.holderCount} holders, top10 ${token.top10Percent}%` +
          (token.honeypot ? "  [HONEYPOT]" : "")
      );
    }
    lines.push("");
  }

  lines.push(`  data source: ${raw.source}   |   chain: ${raw.chain}`, "");
  return lines.join("\n");
}

export function xPostReport(snapshot) {
  const { alphetIndex, alphaWeight, betaWeight, verdict, split } = snapshot;

  if (alphetIndex === null) return "Alphet: no reading this run.";

  // Same zone the dashboard uses, so a post and the page never disagree about
  // what day it is.
  const date = new Date(snapshot.timestamp).toLocaleDateString("en-US", {
    timeZone: config.displayTimeZone,
    month: "short",
    day: "numeric",
  });

  return [
    `Alphet - ${config.chainName} memecoin quality - ${date}`,
    ``,
    `ALPHA ${alphaWeight.toFixed(0)}%  |  BETA ${betaWeight.toFixed(0)}%`,
    `${verdict.label} - quality index ${alphetIndex}/100`,
    ``,
    `${split.alphaCount} alpha / ${split.betaCount} beta tokens read`,
    split.honeypots ? `${split.honeypots} honeypot(s) flagged` : `no honeypots flagged`,
    ``,
    `$ALPHET`,
  ].join("\n");
}
