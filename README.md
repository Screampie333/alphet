# Alphet — memecoin quality gauge

Alphet reads every memecoin launched on **Robinhood Chain**, scores each one on
four on-chain quality signals, and splits the market into two sides:

- **Alpha** — supply is spread, liquidity can't be pulled, the dev has a record
- **Beta** — someone else is holding the exit

The gauge seam shows **where the money actually went**, not how many tokens
exist on each side. Junk launches outnumber good ones on every chain and always
will; counting heads would pin the seam to the Beta side permanently.

This runs with **zero dependencies** — no `npm install`. You need Node 18+.

It runs live out of the box with no addresses to fill in. One free API key
(Blockscout) is what makes all four metrics work — see Known gaps.

---

## Quick start

```bash
node --version        # needs v18 or higher

npm run mock          # one run on invented data - no RPC endpoint needed
npm run mock          # a few more, to build up some history
npm run history       # everything collected so far
npm run web           # the dashboard on http://localhost:3000
```

`npm run mock` is a complete run of the real pipeline against an invented
population of tokens. Nothing downstream knows the difference, so you can build
and demo the whole thing, or work offline, without touching the network.

---

## The four metrics

Each is scored 0–100, where 100 is the Alpha end. A token's quality score is the
weighted sum; at or above `ALPHA_CUTOFF` (default 55) it's Alpha.

| Metric | Weight | What it reads | Where it comes from |
|---|---|---|---|
| **Holder distribution** | 30% | What share of the float the top 10 wallets hold | Blockscout holder list (RPC replay as fallback) |
| **Liquidity permanence** | 30% | Whether the pool can be withdrawn | RPC — LP supply against burn + locker balances (V2 pools only) |
| **Developer track record** | 20% | Prior launches, and how many are dead now | Blockscout `creator_address_hash`, indexed across runs |
| **Time-to-rug signals** | 20% | Volume vs holders, buy/sell pressure, honeypot | GeckoTerminal trades + a simulated sell |

Two details worth knowing:

- **The pool and the burn address are excluded from the holder ranking.** Almost
  all of a fresh memecoin's supply sits in its own liquidity pool, so counting
  the pool as a holder would report every token as 90% concentrated and the
  metric would carry no information at all.
- **The honeypot check is simulated, never sent.** `eth_call` runs a transfer to
  the pair against current state and discards it. A pass is not a guarantee —
  sell taxes, per-block limits and owner-flippable contracts all pass it.

Unlike a market index, these thresholds are **absolute, not relative to our own
history**. "The top 10 wallets hold 62% of supply" is a complete statement about
a token, so the first-ever run is already a real reading.

---

## Timeframes

The dashboard offers **15m / 1h / 6h / 24h**, and each one is a full re-score of
the whole population — not a smoothing of the others.

Three of the four metrics are facts about *right now*: supply concentration, LP
permanence and a dev's history don't have a 15-minute version, so they read the
same whichever window you pick. How a token is trading does, and that is enough
to move the Alpha/Beta line — a token can be on one side over a day and the
other over the last quarter hour. **That gap is the most useful thing on the
page**: it is money rotating between the two sides while you watch.

These windows come from GeckoTerminal, which reports volume and the buy/sell
split at `m5 / m15 / m30 / h1 / h6 / h24` per pool. That matters, because the
obvious alternative — rolling stored snapshots up into windows — would need the
collector to run every few minutes, and at ~10,000 RPC calls per run it cannot.
Reading them from the market feed makes a 15-minute window measured data rather
than an approximation.

24h is the headline: enough trades behind it that one whale doesn't set the
reading. The other three are compared against it rather than against their own
previous period, since "how does right now differ from the day" is the question
a trader is actually asking.

---

## Where the data comes from

Three sources, split by what each can actually answer.

**GeckoTerminal** (`robinhood` network) — discovery, volume, liquidity, buy/sell
split, symbol, age, venue. All in USD.

Discovery matters more than it sounds. Alphet used to need each launchpad's
contract address and the `topic0` of its token-created event, filled in by hand
— and RHC has no registry to look those up in, so it could not run at all until
someone did the archaeology, and then only covered the venues that had been
done. Reading the pool feed inverts that: every memecoin has to open a pool to
be tradeable, so it catches every launch whatever door it came through. That is
Alphet's actual scope, and it needs no configuration.

**Robinhood Chain RPC** (public endpoint) — LP permanence and the simulated
sell. No key needed.

**Blockscout** (`BLOCKSCOUT_API_KEY`, free tier) — the ranked holder list, the
real holder count, and each contract's deployer. Optional in the sense that the
code runs without it, but two of the four metrics are largely unmeasurable
until it is set — see Known gaps.

**Measured and rejected:** GoPlus lists chain 4663 as supported, but on RHC it
only answers for verified blue-chip contracts — 1 of the 8 largest tokens, none
of the new ones, and no `holders` / `lp_holders` / `is_honeypot` in the reply.
That is the exact opposite of the population Alphet scores.

---

## Known gaps

Real, and visible on the page rather than smoothed over. A metric that could not
be read shows a dash and its weight is shared across the other three — scoring
an unreadable pool as zero would accuse it of something never measured.

**Liquidity permanence only works on V2-shaped pools.** Uniswap V3 and V4 hold
liquidity as per-position NFTs against a singleton, so "what share can be
pulled" needs the position manager and a different answer per position. A large
share of RHC volume sits on exactly those pools, so this metric is often
unmeasurable for the biggest tokens — which tilts live readings toward Alpha for
a structural reason, not a market one. Reading V3 positions is the highest-value
thing left to build.

**Holders need the indexer.** Without `BLOCKSCOUT_API_KEY`, holder distribution
is reconstructed from each token's `Transfer` log with a candidate cap — and at
this chain's scale that does not work. PONS had 21,658 unique receivers in 24
hours against a 400-candidate cap, so a "top 10 hold 5%" reading came from 1.8%
of its holders.

The failure was one-directional and therefore dangerous: the numerator came
from the sample, the denominator from the whole circulating supply, so thin
samples always understated concentration. Measured across 154 tokens, the ones
where the cap bit reported a median top-10 of **30.6%** against **91.6%** for
the ones read completely — every large token flattered onto the Alpha side.

The collector now returns `null` rather than a number it can't stand behind, so
without a key the metric reads "not measurable" for exactly the tokens that
carry the volume. With a key, Blockscout returns the ranked holder list and the
real holder count directly, and the same call path also supplies the deployer
that `findDeployer()` was missing three times in four.

**History can't be measured backwards.** The public endpoint keeps no archive
state — a `balanceOf` one hour back returns `metadata is not found` — so past
readings cannot be recomputed. `npm run backfill` reconstructs a shape instead;
see below for exactly what it is and isn't.

**Developer track record starts empty.** Nothing answers "what else has this
address deployed", so the index is accumulated one run at a time. Early runs
report every dev as unproven — honest rather than wrong — and it sharpens the
longer Alphet runs.

**A honeypot pass is not a guarantee.** The sell is simulated with `eth_call`
against current state. Sell taxes, per-block limits and owner-flippable
contracts all pass it.

---

## Backfill

```bash
npm run backfill            # 4 days
npm run backfill -- --days 7
```

Alphet's history normally only starts when you do. Backfill fills the strip
behind that — but it is **not** a record of what Alphet would have printed.

The gauge needs two things per hour: which tokens were Alpha and which were
Beta, and how much money went into each. Only the second is recoverable, since
holder distribution and liquidity permanence are reads of current state and the
public endpoint has no archive. So backfill holds each token's quality at
today's value and re-weights the aggregates with the volume each hour actually
saw.

It answers *"given what these tokens are today, where was the money going?"*
It does not answer *"what would the gauge have shown that hour?"*

Two things follow, and both are surfaced on the page rather than buried:

- **Survivorship bias.** Tokens are discovered from today's pool feed, so
  anything that already died is absent — and dead tokens were disproportionately
  Beta and carried volume on the way down. Backfilled history leans Alpha by an
  amount nobody can measure.
- **They never reach the timeframe card.** That card only ever reports
  measurements. Backfilled hours appear on the trend strip, faded, with a note.

A measured snapshot always wins: backfill skips any hour already covered by a
real reading, and re-running it replaces only its own entries.

---

## Deploying

The dashboard is a static site. The collector is not, and cannot be.

**Why they split.** One collection run makes about 2,200 outbound requests,
takes ten minutes, and needs a filesystem for its cache. Cloudflare Workers
allow 50 subrequests per invocation on the free plan and have no filesystem, so
the collector will never run there. But everything it produces is four JSON
files, and the page only ever reads those — so the dashboard deploys to Pages
with no Workers, no server, and no cost.

`publish.js` writes `public/api/{latest,history,windows,meta}.json` after every
run, and `npm run web` serves those same files locally. Local and deployed read
identical bytes, so they cannot drift.

**What's already set up.** `.github/workflows/collect.yml` runs the collector
every three hours, commits the new snapshot, and deploys `public/` to Pages.

**What you need to add** — three repository secrets, under
Settings → Secrets and variables → Actions:

| Secret | Where to get it |
|---|---|
| `BLOCKSCOUT_API_KEY` | dev.blockscout.com (free) |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens, template "Edit Cloudflare Workers" |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard sidebar |

Then create a Pages project named `alphet` (or change `--project-name` in the
workflow), and enable Actions on the repo.

Two things the workflow handles that are easy to get wrong:

- **The chain cache is restored, not committed.** It is derived data — holder
  reads, deployers, logos — so losing it costs time, not correctness. The cache
  key rotates per run because GitHub cache entries are immutable: a fixed key
  would be written once and never updated again.
- **Snapshots are committed.** They are the history the trend strip draws, and
  a cache is not durable enough for that. `storage.js` caps the file at ~260
  readings so the repo stays bounded.

---

## Cost

GeckoTerminal costs about five calls a run against a 30/minute budget, so it is
never the constraint. The RPC side is, because holders are reconstructed by
replaying each token's `Transfer` log and reading `balanceOf` per candidate.
That's why:

- the interval is measured in **hours**, not minutes (`INTERVAL_MINUTES=180`)
- `MAX_TOKENS_PER_RUN` and `MAX_HOLDER_CANDIDATES` are hard ceilings
- calls are batched (one HTTP round trip per 20) and tokens are read one at a
  time — firing forty tokens' worth at a public endpoint at once is the reliable
  way to get all forty rate-limited

Every run prints what it actually spent. Watch that number before raising any
of the caps.

Dev track records and token metadata are cached to `data/chain-cache.json`
between runs. A token that reached zero a week ago is not coming back, so that
verdict is written down once and never recomputed.

---

## Layout

```
src/
  sources.js    GeckoTerminal - discovery and market data
  blockscout.js the RHC indexer - holders and deployers
  chain.js      minimal Ethereum JSON-RPC + ABI decoding (zero deps)
  collector.js  holders, LP permanence, deployer, honeypot - and the merge
  scoring.js    four metrics -> quality per token -> the Alpha/Beta split
  backfill.js   reconstructs a trend from GeckoTerminal OHLCV
  storage.js    snapshots, as a plain JSON file
  report.js     console + X post output
  run.js        entry point
  server.js     dashboard + JSON API
public/         the landing page (no build step, plain HTML/CSS/JS)
data/           snapshots and the chain cache
backup/         pre-Alphet Haboob data, kept for reference
```

### API

| Route | Returns |
|---|---|
| `GET /api/latest` | the most recent snapshot |
| `GET /api/history?days=7` | a series, for the trend strip |
| `GET /api/windows` | every timeframe at once |
| `GET /api/meta` | sources, cutoff, weights |

---

## Zero dependencies, and how

`chain.js` has no ethers/viem, which normally means no `keccak256` to hash
function signatures with. Alphet gets away with it because every selector and
event topic it needs is standard and has been the same value on every EVM chain
since 2017, so they're written out as constants.

Adding a **non-standard** call means computing its selector elsewhere (`cast
sig`, or a browser console) and pasting the result in. Don't guess one.
