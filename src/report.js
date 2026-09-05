// report.js
// Turns a scored snapshot into text a human can read.
//
// Two formats:
//   - a console version, for when you run this yourself
//   - a short X/Twitter version, ready to post

import { config } from "./config.js";

// Draws a little bar like: [######----] so numbers are easier to eyeball.
function bar(value, width = 10) {
  const filled = Math.round((value / 100) * width);
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

export function consoleReport(snapshot) {
  const { index, condition, subScores, raw, baselineSnapshots } = snapshot;
  const r = subScores.rates;

  const lines = [
    "",
    "==============================================",
    `  HABOOB WEATHER REPORT`,
    `  ${new Date(snapshot.timestamp).toLocaleString("en-US", {
      timeZone: config.displayTimeZone,
      dateStyle: "full",
      timeStyle: "short",
    })}`,
    "==============================================",
    "",
    `  ${condition.emoji}  ${condition.label.toUpperCase()}   -   index ${index}/100`,
    "",
    `  ${condition.summary}`,
    "",
    "  ------------------------------------------",
    `  Graduation  ${bar(subScores.graduation)}  ${subScores.graduation}`,
    `  Volume      ${bar(subScores.volume)}  ${subScores.volume}`,
    `  Rug safety  ${bar(subScores.rug)}  ${subScores.rug}`,
    `  Stability   ${bar(subScores.volatility)}  ${subScores.volatility}`,
    "  ------------------------------------------",
    "",
    "  Raw numbers",
    `    tokens created     ${raw.tokensCreated.toLocaleString("en-US")}`,
    `    tokens graduated   ${raw.tokensGraduated.toLocaleString("en-US")}  (${r.graduationRatePercent}%)`,
    `    volume             ${raw.totalVolumeSol.toLocaleString("en-US", { maximumFractionDigits: 2 })} SOL`,
    `    tokens rugged      ${raw.tokensRugged.toLocaleString("en-US")}  (${r.rugRatePercent}% of active)`,
    `    avg price swing    ${r.avgPriceSwingPercent.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`,
    "",
    `  data source: ${raw.source}   |   baseline from ${baselineSnapshots} past snapshot(s)`,
    "",
  ];

  return lines.join("\n");
}

export function xPostReport(snapshot) {
  const { index, condition, subScores } = snapshot;

  // Same zone the dashboard uses, so a post and the page never disagree about
  // what day it is. Without it this took the server's own zone, which put the
  // post a day ahead of the site whenever the two sat either side of midnight.
  const date = new Date(snapshot.timestamp).toLocaleDateString("en-US", {
    timeZone: config.displayTimeZone,
    month: "short",
    day: "numeric",
  });

  return [
    `${condition.emoji} pump.fun weather - ${date}`,
    ``,
    `${condition.label.toUpperCase()} - index ${index}/100`,
    ``,
    `${condition.summary}`,
    ``,
    `graduation ${subScores.graduation} | volume ${subScores.volume}`,
    `rug safety ${subScores.rug} | stability ${subScores.volatility}`,
    ``,
    `$HABOOB`,
  ].join("\n");
}
