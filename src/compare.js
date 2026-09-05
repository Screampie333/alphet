// compare.js
// Checks Haboob's on-chain counts against pump.fun's own API.
//
//   node src/compare.js [minutes]     default 30
//
// The point is not to switch data sources. It is to find out whether the
// numbers Haboob reports agree with the numbers pump.fun reports about
// itself, because a market index nobody can check is worth very little - and
// because the creation count is the denominator of the graduation rate, so an
// error there moves the heaviest-weighted signal in the whole index.
//
// WHAT IS AND IS NOT COMPARABLE
//
// Creations are directly comparable: both sides can count tokens created
// inside a time window.
//
// Graduations are not. Haboob counts graduation *events* in a window - pool
// creations that happened during it, whenever the token was born. The API has
// created_timestamp but no graduated_timestamp, so the closest it can offer is
// "tokens created in this window that are already complete", which for a
// recent window is near zero because graduating takes hours. Those two are
// different quantities and this script does not pretend otherwise; it reports
// the graduation figures side by side and labelled, rather than subtracting
// one from the other and calling the result a discrepancy.

import { countWindows } from "./windows.js";
import { config } from "./config.js";

const API = "https://frontend-api-v3.pump.fun/coins";

// The API caps a page at about 70 whatever you ask for, so 50 is a page size
// it will actually honour.
const PAGE = 50;
const MAX_PAGES = 60;
// Someone else's server, and an undocumented one. Space the requests out.
const PAUSE_MS = 350;

const minutes = Math.min(Math.max(Number(process.argv[2]) || 30, 5), 180);
const windowMs = minutes * 60 * 1000;

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getPage(offset) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(
      `${API}?limit=${PAGE}&offset=${offset}&sort=created_timestamp&order=DESC`,
      { signal: controller.signal, headers: { accept: "application/json" } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = await res.json();
    return Array.isArray(body) ? body : body.coins || [];
  } finally {
    clearTimeout(timer);
  }
}

// Page back until the results fall out of the window, collecting what's inside.
async function apiCreationsSince(cutoff) {
  const inside = [];
  let offset = 0;
  let pages = 0;
  let reachedCutoff = false;

  while (pages < MAX_PAGES) {
    const batch = await getPage(offset);
    pages++;
    if (!batch.length) break;

    for (const coin of batch) {
      const at = Number(coin.created_timestamp);
      if (!at) continue;
      if (at < cutoff) {
        reachedCutoff = true;
        continue;
      }
      inside.push(coin);
    }

    if (reachedCutoff) break;
    offset += PAGE;
    await pause(PAUSE_MS);
  }

  return { coins: inside, pages, reachedCutoff };
}

function pct(a, b) {
  if (!b) return "n/a";
  return (((a - b) / b) * 100).toFixed(1) + "%";
}

async function main() {
  const now = Date.now();
  const cutoff = now - windowMs;

  console.log(`\n  Haboob vs pump.fun API — last ${minutes} minutes`);
  console.log(`  window: ${new Date(cutoff).toISOString().slice(11, 19)} → ${new Date(now).toISOString().slice(11, 19)} UTC\n`);

  if (!config.heliusApiKey) {
    console.log("  No HELIUS_API_KEY set - the on-chain side needs one.\n");
    return;
  }

  console.log("  reading chain...");
  const chain = await countWindows([{ key: "w", ms: windowMs }], now);
  const onChain = chain.windows.w;

  console.log("  reading pump.fun API...");
  let api;
  try {
    api = await apiCreationsSince(cutoff);
  } catch (err) {
    console.log(`\n  API request failed: ${err.message}`);
    console.log("  That is the risk this comparison exists to measure: the v1 host");
    console.log("  already returns Cloudflare 530, and this one carries no guarantee.\n");
    return;
  }

  const apiCreated = api.coins.length;
  const complete = api.coins.filter((c) => c.complete).length;

  console.log("");
  console.log("  CREATIONS  (directly comparable)");
  console.log(`    on-chain, mint authority   ${String(onChain.created).padStart(7)}`);
  console.log(`    pump.fun API               ${String(apiCreated).padStart(7)}`);
  console.log(`    difference                 ${pct(onChain.created, apiCreated).padStart(7)}  (on-chain vs API)`);
  if (!api.reachedCutoff) {
    console.log(`    NOTE: stopped after ${api.pages} pages without reaching the cutoff,`);
    console.log(`          so the API figure is a floor, not a total.`);
  }

  console.log("");
  console.log("  GRADUATIONS  (NOT the same quantity - see the header of this file)");
  console.log(`    on-chain, pool creations in the window        ${String(onChain.graduated).padStart(5)}`);
  console.log(`    API, tokens created in the window now complete ${String(complete).padStart(4)}`);

  console.log("");
  console.log("  GRADUATION RATE");
  const chainRate = onChain.graduationRate;
  console.log(`    Haboob reports             ${chainRate === null ? "n/a" : chainRate.toFixed(2) + "%"}`);
  console.log(`    if the API creation count is right, it would be  ${
    apiCreated > 0 ? ((onChain.graduated / apiCreated) * 100).toFixed(2) + "%" : "n/a"
  }`);

  console.log("");
  console.log("  READING THIS");
  const ratio = apiCreated > 0 ? onChain.created / apiCreated : null;
  if (ratio === null) {
    console.log("    No API creations in the window - nothing to compare against.");
  } else if (Math.abs(ratio - 1) <= 0.15) {
    console.log("    The two agree within 15%. The creation count, and so the");
    console.log("    denominator of the graduation rate, holds up independently.");
  } else {
    console.log(`    The two differ by ${ratio.toFixed(2)}x, which is worth explaining before`);
    console.log("    launch rather than after. Candidates, in the order worth checking:");
    console.log("      - the API may hide some tokens by default (nsfw, banned) while");
    console.log("        the mint authority sees every one");
    console.log("      - the on-chain count scales by a measured purity ratio, and");
    console.log(`        this run measured ${(chain.purity.create * 100).toFixed(0)}% - if that sample was unlucky,`);
    console.log("        the count moves with it");
    console.log("      - the API paged " + api.pages + " page(s); if it truncated, its figure is low");
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\n  failed: ${err.message}\n`);
  process.exitCode = 1;
});
