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

Both modes work. `--mock` makes up believable numbers so you can test the
pipeline without an API key; without it, `src/collector.js` pulls real
pump.fun activity through Helius.

### Going live

1. Get a free API key at [helius.dev](https://helius.dev)
2. Copy `.env.example` to `.env` and paste your key in
3. Run `npm run once`

### Sampling — read this before you trust the numbers

pump.fun is far too busy to read a whole interval. Measured on 2026-09-04, the
program ran at **50–195 signatures per second**, so a 30-minute window is
90,000–350,000 transactions, and Helius parses only 100 per call.

So Haboob reads a short slice of each interval (`SAMPLE_SECONDS`, default 120)
and scales the rate-like numbers — tokens created, graduated, volume — up to
the full window. Two consequences:

- **Keep `SAMPLE_SECONDS` constant.** Every score is relative to your own past
  runs, so changing the sample size makes old snapshots incomparable.
- **Watch your credit burn.** A 120s sample is roughly 230 parse calls per run,
  about 11,000/day at a 30-minute interval. Check the Helius dashboard after a
  day and tune down if it's eating the free tier.

Rug detection is the weakest signal under sampling: it works by watching each
creator wallet for a dump, which needs fuller coverage than a slice gives. The
rug rate is consistently undercounted. It's still a usable *relative* signal —
a consistent undercount still moves when the market moves — but don't read the
absolute number as truth. Webhooks would fix this properly.

### What gets thrown away

Only about 6% of the signatures touching the pump.fun program are usable
trades. From one measured 20-second sample of 3,871 signatures:

| Bucket | Count | Why |
|---|---|---|
| Not pump.fun | 1,944 | Helius labels the source as something else |
| Failed transactions | 1,510 | Slippage, sold-out curves — they still carry a priority fee, so counting them books failed attempts as volume |
| Not a trade | 174 | Wallet-to-wallet transfers, account closures |
| **Kept** | **243** | 239 trades + 4 creates |

If the counts ever look wrong, run with `DEBUG_COLLECTOR=1` to print this
breakdown plus a sample decoded transaction, and adjust `classify()`.

**Graduation detection is still unverified.** Graduations are rare enough that
no test sample has caught one, so the `COMPLETE`/`MIGRATE` matching in
`classify()` has never been confirmed against a real event. If graduation
counts sit at zero for a full day of live running, that's the first thing to
check.

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
48 pulls/day is fine on its own, but each pull makes ~230 parse calls at the
default sample size — see the sampling section above. This is the single
thing most likely to bite you. Webhooks would remove the problem entirely.

**Defining "rug" is genuinely hard.** Not every liquidity removal is a rug.
Start strict (dev wallet dumps >80% within 24h of launch) and loosen it later.
A noisy rug rate poisons the whole index.

**Verify the program ID.** The pump.fun program ID in `.env.example` should be
double-checked against a block explorer before you trust live numbers.

---

## Next steps

Live data works now. The natural additions from here:

- Verifying graduation detection against a real event (see above)
- Moving collection to Helius webhooks, which fixes both the quota burn and
  the rug-detection coverage gap in one go
- Auto-posting to X (X API)
- A Telegram alert bot for sudden condition changes
- Moving from `snapshots.json` to a real database once the file gets large
