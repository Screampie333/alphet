// history.js
// Prints every snapshot you've saved so far, oldest first.
// Useful for checking whether alphaCutoff is sensible - if every run says
// "Balanced", the cutoff in config.js is doing no work.

import { config } from "./config.js";
import { readAll } from "./storage.js";

const all = readAll();

if (!all.length) {
  console.log("\n  No snapshots yet. Run `npm run mock` a few times first.\n");
  process.exit(0);
}

console.log(`\n  ${all.length} snapshot(s)\n`);
console.log("  date                   alpha    beta   index   verdict");
console.log("  ---------------------------------------------------------------");

for (const s of all) {
  // Shown in the same zone as the dashboard rather than UTC, so a row here
  // and a column there refer to the same hour.
  const date = new Date(s.timestamp).toLocaleString("sv-SE", {
    timeZone: config.displayTimeZone,
    dateStyle: "short",
    timeStyle: "short",
  });

  const alpha = s.alphaWeight === null ? "  -  " : `${s.alphaWeight.toFixed(1)}%`.padStart(6);
  const beta = s.betaWeight === null ? "  -  " : `${s.betaWeight.toFixed(1)}%`.padStart(6);
  const index = String(s.alphetIndex ?? "-").padStart(5);

  console.log(`  ${date}   ${alpha}  ${beta}   ${index}   ${s.verdict.label}`);
}

const counts = {};
for (const s of all) {
  counts[s.verdict.label] = (counts[s.verdict.label] || 0) + 1;
}

console.log("\n  distribution");
for (const [label, n] of Object.entries(counts)) {
  const pct = Math.round((n / all.length) * 100);
  console.log(`    ${label.padEnd(14)} ${String(n).padStart(3)}  (${pct}%)`);
}
console.log("");
