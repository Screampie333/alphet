// storage.js
// Saves every snapshot to a plain JSON file.
// A real database (Postgres/SQLite) is better long term, but a JSON file
// is enough to start and you can read it with any text editor.

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

function ensureFile() {
  const dir = path.dirname(config.dataFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(config.dataFile)) {
    fs.writeFileSync(config.dataFile, "[]", "utf8");
  }
}

// Read every snapshot we've ever saved.
export function readAll() {
  ensureFile();
  try {
    const raw = fs.readFileSync(config.dataFile, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Could not read snapshots file:", err.message);
    return [];
  }
}

// Only the newest snapshots keep their token list.
//
// A full reading carries every token it scored - several hundred, about a
// quarter of a megabyte - and that is the point: the table is the gauge's
// working, so truncating it would hide the rows a reader wants to check. But
// only the newest reading is ever displayed with its tokens, and /api/history
// strips them anyway, so keeping them on every past snapshot would grow the
// file by megabytes a day for nothing.
const SNAPSHOTS_WITH_TOKENS = 1;

// Roughly a month at a three-hour interval. History has to live in the repo
// for the deploy to carry it, so it is bounded rather than left to grow.
const KEEP_SNAPSHOTS = 260;

// Add one snapshot to the end of the file.
export function append(snapshot) {
  const all = readAll();
  all.push(snapshot);

  const capped = all.slice(-KEEP_SNAPSHOTS);
  const cutoff = capped.length - SNAPSHOTS_WITH_TOKENS;
  const pruned = capped.map((s, i) => (i < cutoff && s.tokens?.length ? { ...s, tokens: [] } : s));

  fs.writeFileSync(config.dataFile, JSON.stringify(pruned, null, 2), "utf8");
  return pruned.length;
}

// Replace the whole file. Only backfill needs this - it inserts snapshots
// before existing ones, which append() cannot do.
export function writeAll(snapshots) {
  ensureFile();
  fs.writeFileSync(config.dataFile, JSON.stringify(snapshots, null, 2), "utf8");
  return snapshots.length;
}

// Get the snapshots from the last N days - used for rolling averages.
export function recent(days = 7) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return readAll().filter((s) => new Date(s.timestamp).getTime() >= cutoff);
}

// Get the most recent snapshot, or null if there isn't one yet.
export function latest() {
  const all = readAll();
  return all.length ? all[all.length - 1] : null;
}
