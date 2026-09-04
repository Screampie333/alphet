// history.js
// Prints every snapshot you've saved so far, oldest first.
// Useful for checking whether your thresholds are sensible - if every
// single day says "Cloudy", your cutoffs in config.js need adjusting.

import { readAll } from "./storage.js";

const all = readAll();

if (!all.length) {
  console.log("\n  No snapshots yet. Run `npm run mock` a few times first.\n");
  process.exit(0);
}

console.log(`\n  ${all.length} snapshot(s)\n`);
console.log("  date                      index   condition");
console.log("  ------------------------------------------------");

for (const s of all) {
  const date = new Date(s.timestamp).toISOString().slice(0, 16).replace("T", " ");
  const index = String(s.index).padStart(3, " ");
  console.log(`  ${date}      ${index}     ${s.condition.label}`);
}

// Count how often each condition showed up.
const counts = {};
for (const s of all) {
  counts[s.condition.label] = (counts[s.condition.label] || 0) + 1;
}

console.log("\n  distribution");
for (const [label, n] of Object.entries(counts)) {
  const pct = Math.round((n / all.length) * 100);
  console.log(`    ${label.padEnd(10)} ${String(n).padStart(3)}  (${pct}%)`);
}
console.log("");
