// config.js
// Loads settings from the .env file and holds all the tuneable numbers
// for the Haboob weather index in one place.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, "..");

// --- tiny .env loader (so we don't need the dotenv package) ---
function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnv();

export const config = {
  // Your Helius API key. Get a free one at helius.dev, then put it in .env
  heliusApiKey: process.env.HELIUS_API_KEY || "",

  // How often to collect data, in minutes.
  // Every 30 min = 48 pulls/day. Stay generous here to protect your free quota.
  intervalMinutes: Number(process.env.INTERVAL_MINUTES || 30),

  // The pump.fun program is far too busy to read a whole interval. Measured
  // 2026-09-04: between 50 and 195 signatures per SECOND, so a 30-minute
  // window runs to 90,000-350,000 transactions, and Helius parses only 100
  // per call. So we read a short slice of each interval instead and scale the
  // rate-like numbers back up to the full window.
  //
  // Budget per run, at the higher end of that measured range:
  //   parse calls ~= sampleSeconds * 195 / 100
  // So 120s is ~230 parse calls per run, ~11,000/day at a 30-minute interval.
  // Check your actual credit burn on the Helius dashboard after a day and
  // tune this down if it's eating the free tier.
  //
  // Keep it CONSTANT once you start collecting history: every score is
  // relative to your own past runs, so a sample size that moves around makes
  // old snapshots incomparable.
  sampleSeconds: Number(process.env.SAMPLE_SECONDS || 120),

  // The pump.fun program on Solana.
  // VERIFY THIS before trusting real data - program IDs can change or be wrong.
  pumpFunProgramId:
    process.env.PUMPFUN_PROGRAM_ID ||
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",

  // The zone every timestamp is shown in - the dashboard, the X post and
  // npm run history all read from here, so they can never disagree about
  // what hour or day a reading belongs to.
  displayTimeZone: process.env.DISPLAY_TZ || "America/Chicago",

  // Port for the web server (npm run web).
  port: Number(process.env.PORT || 3000),

  // Where snapshots get saved
  dataFile: path.join(ROOT, "data", "snapshots.json"),

  // Tracks newly-created tokens for up to 24h so collectRugs() can catch a
  // dev dump that happens in a later run, not just the one it launched in.
  rugWatchlistFile: path.join(ROOT, "data", "rug-watchlist.json"),

  // --- Scoring weights ---
  // These decide how much each signal matters in the final index.
  // They must add up to 1.0. Tune them once you have real data.
  weights: {
    graduationRate: 0.35, // more graduations = better weather
    volume: 0.3, // more volume = better weather
    rugRate: 0.25, // more rugs = worse weather (inverted below)
    volatility: 0.1, // extreme swings = worse weather (inverted below)
  },

  // --- Weather thresholds ---
  // Index runs 0-100. These cutoffs decide which condition gets reported.
  // Calibrate these after ~2 weeks of real data, or every day will look the same.
  thresholds: {
    sunny: 70, // 70 and above
    cloudy: 45, // 45-69
    overcast: 25, // 25-44
    // below 25 = storm
  },

  // An "extreme" reading overrides everything else when volatility is this high.
  extremeVolatilityCutoff: 92,

  // Don't allow the "extreme" override until we have at least this many past
  // snapshots. Before that the baseline is too thin to mean anything.
  minSnapshotsForExtreme: 12,
};
