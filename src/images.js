// images.js
// Token logos, from DexScreener, for the ones the other sources don't have.
//
// Neither of the two main sources covers this well. GeckoTerminal carries an
// image for about half the tokens on Robinhood Chain and null for the rest;
// Blockscout has an `icon_url` field that is null for every memecoin checked.
// DexScreener has them, indexes RHC, needs no key, and takes 30 addresses per
// call - so filling the gaps costs about eighteen requests for a 520-token
// run.
//
// This is cosmetic, so it is written to fail quietly: a run that cannot reach
// DexScreener still produces a complete reading, just with more monograms.

const BASE = "https://api.dexscreener.com/latest/dex/tokens";

// One address per request, even though the endpoint accepts a comma-separated
// list of thirty.
//
// The cap is on PAIRS RETURNED, not on addresses asked for: the response stops
// at thirty pairs whatever you send. Tokens here trade in several pools each,
// so a batch silently drops most of what it was asked about - measured, asking
// for 30 addresses answered 22, and asking for 5 answered 3, because a handful
// of busy tokens filled the whole response.
//
// A batch of one always fits, and the results are cached permanently, so the
// only run that pays for this is the first one.
const BATCH = 1;
const MIN_INTERVAL_MS = 250;
const REQUEST_TIMEOUT_MS = 20000;

export const apiCalls = { count: 0 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Logos for as many of these addresses as DexScreener knows about.
 *
 * @returns Map of lowercase address -> image URL. Addresses it has no image
 *          for are simply absent, so the caller keeps whatever it already had.
 */
export async function fetchImages(addresses) {
  const found = new Map();
  const list = [...new Set(addresses.map((a) => String(a).toLowerCase()))].filter(Boolean);

  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      apiCalls.count++;
      const res = await fetch(`${BASE}/${chunk.join(",")}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const body = await res.json();

        // A token can have several pairs and only some carry an image, so the
        // first non-empty one wins rather than the first pair.
        for (const pair of body?.pairs || []) {
          const address = String(pair?.baseToken?.address || "").toLowerCase();
          const image = pair?.info?.imageUrl;
          if (address && image && !found.has(address)) found.set(address, image);
        }
      }
    } catch {
      // Cosmetic. A missing logo is a monogram, not a broken reading.
    }

    if (i + BATCH < list.length) await sleep(MIN_INTERVAL_MS);
  }

  return found;
}
