# @weir/backtest

A daily H100 on-demand price history built from free public sources, and a backtest
of Weir's week-ahead band on it: how often the band would have held, what a hedge
would have done to a buyer's and a seller's weekly bill, what it costs when the
auction does not clear at a neutral price, and how badly it fits a buyer who pays one
provider rather than the index.

Everything in `results/` is recomputed from the small committed files in
`data/derived/`, offline, in about a second. Nothing is rounded in the reader's
favour; weeks the band failed are listed by date.

## Re-run

```sh
pnpm install                                   # from the repository root
pnpm --filter @weir/backtest run fetch         # downloads to data/raw/ (git-ignored, about 0.2 GB, cached, resumable)
pnpm --filter @weir/backtest run derive        # data/raw/ -> data/derived/
pnpm --filter @weir/backtest run backtest      # data/derived/ -> results/   (offline)
pnpm --filter @weir/backtest run test          # node --test, offline
pnpm --filter @weir/backtest run typecheck
python3 backtest/scripts/verify.py             # independent recomputation, stdlib only
```

`fetch` and `derive` need the network and take time (about an hour for `fetch`, run
sequentially with pauses between requests). `backtest`, `test` and `verify.py` need
only the committed files. `fetch` takes source names (`gpuhunt`, `hubbard`, `akash`,
`crosscheck`) to fetch one at a time.

## Method

**Offer.** A row in a source counts when the GPU is a plain H100 80 GB (H100 NVL
94 GB is excluded), it is on demand (spot, interruptible and preemptible rows are
excluded), price and GPU count are positive, it is not a multi-node cluster product,
and the source does not mark it unavailable. Its value is `price / gpu_count`, in
integer micro-dollars per GPU-hour.

**Provider value.** One per provider per day: the median of that provider's
qualifying offers (even count: mean of the two middle values, rounded down — the same
median the contract uses, imported from `engine/`). `offers` in `providers.csv` is the
number of qualifying rows (SKU × region; for Akash, model entries, each already a
median of bids). When two sources cover the same provider on the same day, the gpuhunt
catalog wins, then the afhubbard snapshot, then the Akash capture. DataCrunch renamed
itself Verda and gpuhunt publishes both files with the same rows for a while; they are
one provider (`verda`).

**Scope.** In the composite: on-demand neoclouds and marketplaces (Lambda, Nebius,
RunPod, Verda, Akash, Vast.ai, Cudo, and the others that appear in the sources).
Out of the composite and reported separately in `hyperscalers.csv`: AWS, Azure, GCP
and OCI on-demand. In this data they sit at 6 to 15 dollars (AWS, GCP) and a flat 10 (OCI): static list prices two to three
times the market; inside a median of five providers they would move it toward a price
almost nobody pays.

**Index.** For each day, the median of the in-composite provider values, if at least
4 providers have one. Otherwise the day has no value. Gaps are never interpolated or
carried forward.

**Weeks.** A delivery week runs Monday 00:00 UTC to the next Monday. Its auction opens
7 days earlier. A daily value for day X is treated as the print of the bucket that
starts at X 00:00, final when the day ends; so the anchor is the latest daily value
from 1 to 3 days before the opening day (spec `max_anchor_age_secs` = 3 days). The
fixing is `floor(sum / count)` of the delivery week's daily values (spec section 10),
and a week needs at least 4 of them. Weeks failing either rule are dropped and listed
in `summary.json` with the reason.

**Band and payoff.** `computeBand(anchor, tick = $0.001, band_bps)` and
`payouts(fixing, floor, band)` from `engine/src/band.ts` and
`engine/src/settlement.ts`, and `fixingOf` for the fixing. A buyer of 1,344
GPU-hours a week (8 GPUs) pays `fixing` per GPU-hour unhedged and
`fixing - LONG payout + p` hedged; a seller earns `fixing` unhedged and
`fixing + SHORT payout - (band - p)` hedged, which is the same number. At the neutral
price `p = half`, so the forward is `mid`.

**Surprise.** The hedge cannot remove the level of prices, only the part of next
week's bill that was not known when the auction opened. Every hedge table therefore
shows two standard deviations: of the weekly cost itself, and of the weekly cost minus
`1,344 × anchor` ("surprise"). Reporting only the second would flatter the hedge;
reporting only the first would hide what it does.

**Basis.** For a provider with at least 20 usable weeks, its own weekly mean price
replaces the index as spot, while the hedge still settles on the index. The table
reports how much of that provider's weekly surprise variance the hedge removes, which
is negative when it adds risk.

**Regimes.** The sample is split at the week with the lowest centred 5-week mean
fixing: falling before and including it, rising after.

**Robustness.** The composite's provider set changes from day to day. As a check the
index is rebuilt from a fixed panel (providers present on at least 95% of index days,
on days all are present) and the move distribution and coverage are recomputed.

## Sources and licences

| Source | Used for | Licence as stated | Coverage achieved |
|---|---|---|---|
| [dstack gpuhunt catalogs](https://github.com/dstackai/gpuhunt) (`dstack-gpu-pricing` S3 bucket, v1 to 2026-08-18, v2 after) | Spine: Lambda, Nebius, RunPod, Verda/DataCrunch, and AWS/GCP/OCI | gpuhunt is MPL-2.0; the catalog files carry no separate data licence | 627 of 740 days (2024-11-01 to 2026-11-10). The 113 missing days are mostly stretches when dstack's catalog workflow failed (for example 2026-04-30 to 05-24 and 2026-06-25 to 07-22; GitHub lists no successful run for them) |
| [afhubbard/gpu-prices](https://huggingface.co/datasets/afhubbard/gpu-prices) | Cudo, Vast.ai, Daytona, Lium, and gpuhunt providers on days the catalog is missing | CC BY 4.0 (Alex Hubbard, *GPU Price Tracker*, 2026) | 231 days with a snapshot, 2026-01-12 to 2026-11-08 (70 days missing); earliest snapshot of each day used |
| Akash Console API via the [Wayback Machine](https://web.archive.org/) | Akash | none stated by the source | 278 days with a capture, 2025-07-16 to 2026-11-11 (206 days in that range without one) |
| [henryzhangpku/gpu-price-index](https://github.com/henryzhangpku/gpu-price-index) | Cross-check only | MIT, unaudited | 38 overlapping weeks |
| [Ornn OCPI-H100](https://data.ornn.com/) | Cross-check only; series not redistributed | reuse terms not checked | 91 overlapping days |

Every file read is listed with its URL and sha256 in `data/derived/provenance.json`.
The gpuhunt bucket cannot be listed: catalogs were found by probing run numbers around
an estimate for each day, confirming the recent year against GitHub's record of
successful workflow runs, and probing every run number between the neighbouring found
days for the remaining gaps (`data/raw/gpuhunt/probes.json` keeps every miss).

**Composite coverage.** The index has a value on 536 of 740 days. Before 2025-04-01
only three market providers (Lambda, RunPod, Verda) are in any source, so the index
starts on 2025-04-01 and runs to 2026-11-10; within that span 53 days have no value.
Providers per index day: 4 to 8, mean 5.04. The provider set changes on 243 days.

## Cross-checks (`data/derived/validation.json`)

| Comparison | Overlap | Mean abs. gap | Max abs. gap | Mean signed gap (ours vs theirs) |
|---|---|---|---|---|
| henryzhangpku weekly `value` (normalised) | 38 weeks | 9.4% | 27.8% (2026-04-06) | -8.2% |
| henryzhangpku weekly raw on-demand median | 38 weeks | 12.9% | 48.8% (2025-08-04) | -3.3% |
| Ornn OCPI-H100 daily (transaction-based) | 91 days | 28.1% | 59.1% (2026-10-04) | **+28.1%** |
| gpuhunt catalog vs afhubbard, same provider and day | 1,207 provider-days | 0.14% | 29.5% (Verda, 2026-05-25) | -0.03% (998 identical) |

The Ornn gap is the important one: on every overlapping day our list-price composite
is above a transaction-based index, by 28% on average. Weir would settle on whatever
its reporters post; if they post transaction prices, the level here is too high and
the volatility may differ.

## Headline results (`results/summary.md` has every table)

69 delivery weeks from 2025-04-14 to 2026-11-02 (82 candidates; 8 dropped for a stale
anchor, 5 for fewer than 4 daily prints). Weekly `move = fixing / anchor - 1`:
median 0.0%, 5th percentile -4.8%, 95th +10.4%, worst -9.4% and +22.5% (2026-06-01).

| band_bps | ±10% | ±15% | ±20% | ±25% | ±30% | ±40% |
|---|---|---|---|---|---|---|
| Weeks inside | 64/69 | 68/69 | 68/69 | 69/69 | 69/69 | 69/69 |
| Share | 92.8% | 98.6% | 98.6% | 100% | 100% | 100% |
| Wilson 95% lower bound | 84.1% | 92.2% | 92.2% | 94.7% | 94.7% | 94.7% |

**Recommendation: `band_bps = 1500`**, by the rule "smallest value in the grid
covering at least 95% of weeks". Read it with its limits: no band in the grid can
show 95% coverage with 95% confidence on 69 weeks; 2500 is the smallest with no breach
at all; on a fixed provider panel ±10% has 1 breach instead of 5, so
part of the measured tail is composition noise rather than market moves; and the one
breach at ±15% (2026-06-01, +22.5%) is a real market-wide repricing.

Hedge at a neutral price, `band_bps = 1500`, 1,344 GPU-hours a week:

| | Unhedged | Hedged |
|---|---|---|
| Weekly cost, mean | $4,055.99 | $4,017.96 |
| Weekly cost, std dev | $554.91 | $502.38 |
| Std dev of the surprise (cost minus cost at the anchor) | $184.72 | $32.37 |
| Largest week-on-week increase | +$500.45 | +$528.19 |
| Total, 69 weeks | $279,863.17 | $277,238.98 |
| Locked per week (buyer; seller the same at this price) | | $601.55 |

The hedge removes 96.9% of the surprise variance but only 18.0% of the raw weekly cost
variance, and it does not reduce the largest week-on-week increase: it fixes next
week's price at this week's level, so a buyer still sees a rising market, one week
late. The seller's figures are identical by construction. One week (2026-06-01) was
capped: the buyer paid $0.200 per GPU-hour ($268.80 for the week) above the cap. At a
forward 5% above the anchor the buyer pays $11,257.98 over spot across the sample; at
5% below, the seller gives up $16,445.89.

**Basis risk.** Hedging one provider's bill with the index removes 27% (RunPod) to 33%
(Nebius, Verda) of the surprise variance at best. For Lambda (-140%) and Akash (-37%)
the hedge adds risk: their prices moved on different weeks than the index. For AWS,
GCP and OCI it adds risk too; their on-demand list prices (AWS $8.26 to $14.75, GCP
$6.14 to $12.45, OCI $10.00 flat) do not follow the market.

**Regimes.** Split at 2026-01-12. Falling (33 weeks, mean move -0.7%, sd 2.4%): every
week inside ±10%. Rising (36 weeks, mean +2.6%, sd 5.7%): 86.1% inside ±10%, 97.2%
inside ±15%. In the rising period a hedge struck at the anchor saved buyers $3,481
over spot; in the falling period it cost them $857. A real auction would price the
drift in, so neither number is a promise.

## What this does not show

- No real order flow; the clearing price is assumed.
- Asks and rate cards, not trades, and 28% above the one transaction index we could
  compare with. List prices are sticky (Lambda's did not change for over a year), so
  measured volatility is a floor, not an estimate.
- 69 weeks, one gentle decline and one sharp rise. The 2024 to early-2025 fall is not
  in the sample because fewer than 4 providers are in the data then.
- The provider set changes; providers that left the market are not represented. A
  provider's value is the median of its SKUs, so a change in SKU mix moves it.
- Gaps are left as gaps; 13 weeks were dropped, 5 of them in the 2026-03 to 2026-07 run-up, so drops are not obviously random.
- One snapshot a day, at whatever hour the source ran.
- No fees, no cost of locked capital, flat usage.

## Engineering notes

- `engine/` supplies `computeBand`, `payouts`, `fixingOf` and `median` (imported as
  `@weir/engine`); nothing of the band or payoff is re-implemented here.
- One runtime dependency: `hyparquet@1.31.5` (MIT, no dependencies of its own) to read
  the afhubbard parquet files, with Node's built-in `zlib.zstdDecompressSync` for
  their ZSTD pages. It is only used by `derive`. The gpuhunt zip files are read with a
  short reader over `node:zlib`.
- `scripts/verify.py` recomputes the index from `providers.csv`, then week selection,
  move distribution, coverage, the recommendation, neutral and shifted hedges, capped
  weeks and the regime split from `index.csv`, and compares 900 numbers with
  `summary.json`. It does not re-check the basis-risk table or the fixed-panel check.
- `fetch` keeps every response under `data/raw/`; a re-run makes no requests for
  anything already there. Expect the probing to take about an hour from empty.
