# Haboob — indexer & scoring engine

The backend for Haboob: it pulls pump.fun market data, turns it into a 0–100
weather index, and prints a report you can post.

This runs with **zero dependencies** — no `npm install` needed. You just need
Node.js 18 or newer.

---

## Quick start

```bash
# 1. check you have Node
node --version        # needs v18 or higher

# 2. run it with fake data (works right now, no API key)
npm run mock

# 3. run it a bunch of times to build up some history
npm run mock
npm run mock
npm run mock

# 4. see everything you've collected
npm run history
```

If that prints a weather report, everything works.

---

## What each file does

| File | Job |
|---|---|
| `src/run.js` | The main file. Ties everything together and runs on a timer. |
| `src/collector.js` | Gets the raw numbers from Solana/Helius. **Has a mock mode.** |
| `src/scoring.js` | Turns raw numbers into the 0–100 index and picks the weather. |
| `src/storage.js` | Saves snapshots to `data/snapshots.json`. |
| `src/report.js` | Formats a snapshot into readable text + an X post. |
| `src/history.js` | Prints everything you've saved so far. |
| `src/config.js` | All the settings and tuneable numbers in one place. |

---

## The important part: mock vs live

Right now the project runs on **made-up numbers**. That's on purpose — it lets
you build and test the whole pipeline before dealing with blockchain data.

In `src/collector.js` there are four functions marked `TODO`:

- `collectTokenCounts()` — how many tokens created and graduated
- `collectVolume()` — total trading volume
- `collectRugs()` — how many tokens rugged
- `collectVolatility()` — how wild the price swings were

These are the only things that need real implementation. Everything downstream
already works. When you fill those in, drop the `--mock` flag and it's live.

### Going live

1. Get a free API key at [helius.dev](https://helius.dev)
2. Copy `.env.example` to `.env` and paste your key in
3. Implement the four functions above
4. Run `npm run once`

---

## How the scoring works

Four signals, each scored 0–100, then combined:

| Signal | What it measures | Weight |
|---|---|---|
| Graduation | Share of new tokens reaching Raydium | 35% |
| Volume | Total trading volume vs your usual | 30% |
| Rug safety | How few tokens rugged (inverted) | 25% |
| Stability | How calm price swings were (inverted) | 10% |

The final index maps to a condition:

| Index | Condition |
|---|---|
| 70–100 | Sunny ☀️ |
| 45–69 | Cloudy ⛅ |
| 25–44 | Overcast 🌧️ |
| 0–24 | Storm ⛈️ |
| override | Extreme 🌪️ |

**Scores are relative to your own history, not fixed numbers.** "60,000 SOL of
volume" means nothing alone; "double your usual volume" means a lot. This is why
your first run always shows 50 across the board — there's no baseline yet.

---

## Calibrating (do this after ~2 weeks)

The single biggest thing that will make or break this project: if every day
reports "Cloudy", nobody will care.

Run `npm run history` and look at the distribution at the bottom. You want a
spread — mostly Cloudy is realistic, but Sunny and Storm should show up
sometimes. If one condition dominates completely, open `src/config.js` and
adjust `thresholds`.

The same applies to `weights`. Those numbers are a starting guess, not a truth.

---

## Things to watch out for

**Free tier quota.** Helius free tier gives 1M credits/month at 10 req/sec.
Collecting every 30 minutes is 48 pulls/day, which is fine — but if each pull
loops over hundreds of tokens individually, it adds up fast. Use batched calls
and webhooks where you can.

**Defining "rug" is genuinely hard.** Not every liquidity removal is a rug.
Start strict (dev wallet dumps >80% within 24h of launch) and loosen it later.
A noisy rug rate poisons the whole index.

**Verify the program ID.** The pump.fun program ID in `.env.example` should be
double-checked against a block explorer before you trust live numbers.

---

## Next steps

Once live data works, the natural additions are:

- Auto-posting to X (X API)
- A Telegram alert bot for sudden condition changes
- Serving the latest snapshot as JSON so the landing page reads real data
- Moving from `snapshots.json` to a real database once the file gets large
