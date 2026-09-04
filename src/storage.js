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

// Add one snapshot to the end of the file.
export function append(snapshot) {
  const all = readAll();
  all.push(snapshot);
  fs.writeFileSync(config.dataFile, JSON.stringify(all, null, 2), "utf8");
  return all.length;
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
