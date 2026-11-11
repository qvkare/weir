# Weir design brief: "The clearing sheet"

Change this brief before building something it does not allow. Pages I could not open while writing it: none fully; Agate's home stayed on its loading grid in a browser, so its visuals are judged from text only. Every figure on the site comes from the contract views (SPEC section 12), `evidence/`, `backtest/` results or the engine running in the browser. No page types a number.

## 1. Positioning

**Promise:** buyers and sellers of H100 time agree next week's price in one sealed auction, and every position is paid in full when it opens.

**First ten seconds, in this order:**
1. The H100 index now, and the sources it is the median of.
2. One sealed round sets one price for everyone; LONG pays the buyer when the week's average rises, SHORT pays the seller when it falls, both inside a stated band.
3. Nothing to liquidate: a LONG and a SHORT together are backed by exactly `band` dollars.

**With no wallet, the first screen lets a visitor:** read the live index and each source; see the current series, its band and the phase clock; drag a fixing across the payoff diagram; type GPU-hours and see the hedge size and cost at the last clearing price; open the last clearing; start the simulation.

## 2. Name check

**Verdict: workable.** No crypto, DeFi or compute-market product named Weir turned up (searches with DeFi, NEAR, token, .xyz, .finance; nearest is WeFi, a money market). Collisions outside the category: WEIR AI, a public-identity app that owns weir.ai (https://www.producthunt.com/p/weir-ai , https://f4.fund/startups/weir); The Weir Group, an engineering company (search noise); a hobby language (https://weirlang.pages.dev/). Pair the name with a product word ("Weir auction") for search.

**Alternates, if a clash appears:** **Clearhour**: one clearing price per GPU-hour, says the mechanism. **Batchrate**: a batch auction that sets a rate. Neither returned a product in a web search.

**Tagline:** "One price for next week's GPU-hour."
**Domains to propose (unchecked):** weir.market, weirauction.xyz, useweir.xyz.

## 3. Site map

| Path | Purpose |
|---|---|
| `/` | Index with sources, current series and band, phase clock, last clearing, payoff and hedge sizer |
| `/auction` | The round in progress; after clearing, the step chart, the price and every fill. `?series=&round=` for any past round |
| `/simulate` | A market of scripted agents cleared by the real engine, in the browser, with fast-forward |
| `/backtest` | Hedged against unhedged cost over real H100 history, and band coverage |
| `/how` | Series, rounds, commit and reveal, clearing rule, settlement, funding through NEAR Intents, limits |
| `/proof` | Contracts, parameters, transactions, bundle hashes re-verified in the browser, live solvency check |
| `/agents` | Get a key that can bid and cannot withdraw; agents seen on the book |

Header: wordmark, the seven links, a "Testnet" outline tag. No "Connect wallet" in the header; it appears only on `/auction` beside the order form.

## 4. Page by page

### `/`
1. **Index head.** Left: "H100, USD per GPU-hour", last final print at display size, bucket time, age. Right: sources (name, price, included or excluded with reason), median row in ink, then reporters (account, price, short bundle hash). Loading: grey bars, never `$0.00`. Error: "The NEAR RPC did not answer", last good read time, Read again. Stale (`now - bucket > max_anchor_age_secs`): `--flag`, "Last print is 3 h 10 m old. A series cannot open on it."
2. **Series strip.** One horizontal timeline for each live series: auction window as a row of round blocks (commit solid, reveal hatched), cutoff, delivery week, settlement. A "now" rule. Under it: floor, band, floor+band, `phase` and `phase_ends_at` as a countdown "Reveal ends in 04:12". Phone: vertical, time running down.
3. **Last clearing.** Small step chart (section 5) plus three figures: LONG price `p*`, implied forward `floor + p*`, volume in GPU-hours. Link "Open round 14". Empty: "No round of this series has cleared yet."
4. **Payoff and hedge sizer.** Payoff diagram with a draggable fixing. Beside it: input "GPU-hours you will use in the delivery week" (default 1,344 = 8 GPUs x 168 h), side toggle Buyer (LONG) / Seller (SHORT). Outputs: units, dollars locked, most you can lose, your effective price inside the band. Figures use the last clearing price and say so.
5. **Three facts** in plain sentences with a link each: sealed uniform price, fully paid positions, funding from any chain via NEAR Intents (tag live, built or planned, set from `evidence/`).
6. **Limits** (always on home, 5 lines): testnet only; index trusts `quorum` of named reporters; band caps the hedge; unrevealed commits forfeit `forfeit_bps`; settlement after `report_grace_secs`.

Phone (375): blocks stack; sources table becomes two columns (source, price) with the reason under each row; payoff chart full width, 240 px tall, sizer under it; tap targets 44 px.

### `/auction`
1. Head: series, round, phase, countdown, commits, total locked.
2. **Sealed book** (commit phase): one row per commit: seq, owner, lock, state. Columns for side, size, price show a lock glyph until reveal. Rows fill in as reveals land (state Revealed/Void).
3. **Order form** (wallet): side, size, price as LONG price with the forward price shown live; salt generated and offered as a download before commit; guard field. Commit hash shown and checked against `commit_hash`.
4. After clearing: **step chart**, then **fills table** (seq, owner, side, size, limit, filled, paid, refunded), partial fills marked "part", void orders and forfeits listed under it with amounts.
Empty: "No round in progress. Round 0 of series 47 opens Mon 17 Nov, 00:00 UTC." Phone: table columns collapse to owner, side, filled, paid; tap a row for the rest.

### `/simulate`
Banner "Simulation. Nothing here touches the chain." Controls: Play/Pause, speed 1x / 60x / 3600x, "Skip to clearing", "Run 10 rounds", seed, Reset. Left: agents (name, role, one-line rule, balance). Centre: `/auction`'s sealed book and step chart, fed by the engine. Right: event log. After settlement, a per-agent result table. Phone: roster and log become tabs under the chart.

### `/backtest`
Rule box first: data source and range, how each week's `p` is set, band rule, what is not modelled. Then the backtest chart, the coverage strip ("Average stayed inside the band in 41 of 52 weeks"), a table per week, caveats. Error: "Backtest file missing", never an empty chart.

### `/how`
Five sections, each a heading, a paragraph and a drawing: the series clock; commit and reveal (the `weir:v1|...` string); clearing, as a three-order worked step chart; settlement with numbers; funding from another chain. Then limits in full and trust (SPEC 15).

### `/proof`
Contracts table (account, NearBlocks link, code hash, keys remaining read live); parameters from `get_params`; transactions grouped by method (report, commit, reveal, clear, settle, redeem) with failed ones kept; **bundle verifier**: for each print, fetch the bundle, SHA-256 it with SubtleCrypto, compare to each report's hash, recompute the median, compare to the print; each check a row with "file 9f2c…a1 / chain 9f2c…a1 / matches". **Solvency**: `get_totals` five terms against the USDC balance, live.

### `/agents`
"Who can do what" with Can / Cannot columns for a full-access key and a function-call key. Steps to add the key (commands from `agents/`), the commit-hash string, a copyable minimal agent loop. Then "Agents on the book": the last 20 commits from function-call-only accounts.

## 5. Charts

**Auction step chart.** x: cumulative GPU-hours, 0 to max(D(0), S(band)). y: LONG price in USD per GPU-hour, 0 to `band`; right axis shows the same ticks as forward price `floor + p`. Demand: LONG orders, highest price first, a falling staircase in `--long`. Supply: SHORT orders, lowest first, a rising staircase in `--short`. Clearing: a 2 px ink horizontal at `p*` across the full width labelled "Clears at $0.62 · forward $2.31", and a dashed vertical at `V*` labelled with the volume. Filled steps drawn 3 px, unfilled 1 px at 50% opacity; the part-filled step split at `V*` with a tick. The rectangle 0..V* x 0..p* tinted `--long-soft`, `p*..band` above it to V* tinted `--short-soft`: what each side paid. Hover/tap a step: owner, seq, size, limit, filled. Must make obvious: one price, where the curves cross, who was in and who was out.

**Index chart.** x: UTC time, 7-day default, 24 h / 7 d / 30 d toggles. y: USD per GPU-hour, padded 10% beyond data and band. Each source a 1 px `--ink-3` line, labelled at its right end by name. The index as a 2 px ink step-after line over final prints; a missing print is a gap, never interpolated. Current series: band as a `--panel` rectangle across its delivery window, the running average as a dashed ink line with its value. Must make obvious: the index is the middle of the sources, and where it sits in the band.

**Payoff diagram.** x: fixing, `floor - band/2` to `floor + 1.5 band`. y: your cost (buyer) or revenue (seller) per GPU-hour. Unhedged: thin ink diagonal. Hedged: thick `--long` (or `--short`) line, flat at `floor + p` inside the band, sloped outside. Band shaded. A draggable vertical handle at the fixing (keyboard: arrows move one `tick`, shift x10); readout: unhedged, LONG payout, hedged, difference. Must make obvious: inside the band your price is fixed; outside it the hedge stops.

**Backtest chart.** x: delivery weeks. y: USD per GPU-hour. Each week a band rectangle; unhedged weekly average as ink dots joined thinly; hedged effective price as `--long` short horizontal ticks. Weeks where the average left the band carry a `--flag` mark under the axis. Must make obvious: how often and by how much hedging changed the bill, and the weeks it did not cover.

## 6. Visual identity

**Choice.** Weir looks like a printed clearing sheet: warm paper, ink, ruled tables, and two colours that mean the two sides. A market people trust is one whose results read like a ledger, so the step chart and the fills table are the heroes and decoration is absent. It differs from Levee's white metro map and from the winners' dark terminals and particle fields.

**Type.** **Archivo** (OFL, variable width 62 to 125 and weight): expanded 112 at 700 to 800 for headings and display figures, normal width 400 for text, condensed 85 for dense tables. One family, three voices. **IBM Plex Mono** (OFL) for hashes, accounts and the commit string. Confirm `tnum` on Archivo at build; fall back to Public Sans if missing. Sizes: 13, 15, 17, 21, 32, clamp(40px, 5vw, 72px). No italic.

**Colour tokens** (contrast against paper / panel):

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#F7F5EF` | `#13120E` | Ground |
| `--panel` | `#EDEAE1` | `#1D1B16` | Bands, cards |
| `--rule` | `#D6D0C2` | `#37332A` | Lines only |
| `--ink` | `#17150F` 16.7 / 15.2 | `#EEEAE0` 15.6 / 14.3 | Text, clearing line, index |
| `--ink-2` | `#5A5446` 6.9 / 6.3 | `#ABA494` 7.6 / 6.9 | Secondary text |
| `--ink-3` | `#7A7466` | `#857F70` | Source lines, gridlines; never text under 21 px |
| `--long` | `#B23F0C` 5.3 / 4.8 | `#F2894A` 7.5 / 6.9 | LONG, buyers, demand |
| `--short` | `#0A6670` 6.1 / 5.5 | `#52BEC4` 8.5 / 7.8 | SHORT, sellers, supply |
| `--flag` | `#875A00` 5.5 / 5.0 | `#E2B04C` 9.4 / 8.6 | Stale, unverified, outside band |
| `--bad` | `#A3202E` 6.9 / 6.2 | `#F27D86` 7.2 / 6.6 | Errors, failed checks |

White on `--long` 5.8, on `--short` 6.7. Soft tints (`--long-soft`, `--short-soft`) at 18% of the side colour over paper. Orange and teal stay apart under deuteranopia; every series is also labelled directly. No red/green, no purple, no gradients.

**Space.** 4, 8, 12, 16, 24, 32, 48, 64, 96 px. Gutter 16 px at 375, 4vw, 56 max. Radius 4 px; tables have no boxes, only rules.

**Numbers.** Tabular figures everywhere. A unit on every figure: "$2.31 /GPU-h", "1,344 GPU-h", "$41,200 locked". Dollars to cents; prices to the `tick`. Times in UTC with the zone written. Missing is "no data", never 0.

**Icons.** A small set drawn in SVG at 1.5 px: lock (sealed), eye (revealed), check, cross, clock, external link. No icon cards.

**Motion.** What moves: the countdown, reveals filling rows, the simulation at the speed chosen, the step chart drawing its curves once on clearing (400 ms). Never: scroll effects, count-ups, looping backgrounds, hover lifts. `prefers-reduced-motion` turns all of it into instant state changes.

## 7. Copy rules

Voice: a clerk reading the results: the figure, then its source. Headings are names without a full stop. No "X, not Y" turns, em dashes or emoji. Banned: revolutionary, seamless, unlock, empower, trustless, guaranteed, risk-free, insurance, yield, bet, AI-powered, next-gen. "Testnet" in the header and on `/proof`. A modelled or simulated figure says so in the same line; one not verifiable on chain carries "unverified" in `--flag`. Limits: one fact per line, naming the parameter that sets it.

Headline / sub pairs:
1. "One price for next week's GPU-hour" / "Buyers and sellers of H100 time bid in sealed rounds. Everyone filled pays the same clearing price."
2. "Round 14 reveals in 04:12" / "11 sealed commits, $41,200 locked. Sides and prices stay hidden until reveal."
3. "What a hedge would have done" / "52 weeks of H100 prices, hedged and unhedged. Clearing prices are modelled; the rule is above the chart."
4. "A key that bids and stops there" / "A function-call key can commit, reveal, clear and redeem. Withdrawing needs 1 yoctoNEAR, which that key cannot attach."
5. "Check every print yourself" / "Each report carries the hash of the data behind it. This page fetches the data and hashes it in your browser."

Microcopy: "Skip to clearing" · "No round in progress. Round 0 of series 47 opens Mon 17 Nov, 00:00 UTC." · "The NEAR RPC did not answer. Figures are from 14:02 UTC. Read again" · "Hash does not match: file 9f2c…a1, chain 41ab…07" · "Save your salt. Without it you cannot reveal, and 5% of the lock is forfeit." (Figures in these strings are examples; the real ones come from the views and `get_params`.)

## 8. What to steal and what to avoid

| Site | Steal | Avoid |
|---|---|---|
| PIRY | The browser-verified checklist ("file 0xa895… vs chain 0xa895…", "passed") for our bundle verifier. Its source table with status and "needs 3" quorum | Dark serif hero with italic accent; settlement prose nested three parentheses deep |
| Agate | "See where the price comes from" source bars with the middle value marked. The AI budget card (per-trade cap, trades per day) as the model for `/agents` | Tiles showing "$0.00" while prices load; in my browser the app sat on a loading grid |
| Rackrate | "Know the outcome before the week starts" slider with Unhedged and Hedged figures. The oracle publisher scorecard ("Avg. from final", "Worst") | Purple-on-black hero with "Connect wallet" in the header; a hedge example ($466 bid) that does not reconcile |
| Corpus | The versioned methodology ("2026.09.14-2", changelog, "Known limitations"). The "whats_live" Surface / Where / Status table | Particle-field hero and snake_case nav; "Permanently funded" contradicted by its FAQ |
| Levee | Failures kept on the record ("Failed and aborted runs stay on this page"). "Who can do what" Can / Can't boards | Its metro lanes, Overpass and white ground (Weir needs its own face); a hero paragraph of four sentences |

## 9. Build notes

Next.js App Router, React, TypeScript, no component library, charts in hand-written SVG drawn on the server at 375 and 1200 px and redrawn at real width. CSS variables in `app/globals.css`; light and dark via `prefers-color-scheme` plus a toggle. Views read through one `lib/near.ts` (JSON-RPC `call_function`). `/simulate` imports the engine from `engine/src/mod.ts` (not in the repo yet; the page waits on it) and runs it in a Web Worker. SHA-256 via SubtleCrypto.

Components:
- `SiteHeader`, `SiteFooter`: nav, Testnet tag, limits link.
- `IndexHead`, `SourcesTable`: last print and age; sources, reporters, median, exclusions.
- `IndexChart`, `StepChart`, `PayoffChart`, `BacktestChart`: section 5.
- `SeriesStrip`, `PhaseClock`: rounds, delivery, settlement; countdown from `get_status`.
- `SealedBook`, `FillsTable`, `OrderForm`: commits that fill on reveal; fills, void, forfeits; order entry with salt download.
- `HedgeSizer`: GPU-hours to units, lock, worst case.
- `SimRunner`, `AgentRoster`, `EventLog`: engine in a worker and its panels.
- `CoverageStrip`, `BacktestTable`: weeks inside and outside the band.
- `BundleVerifier`, `SolvencyCheck`: hash and median re-check; `get_totals` against the token balance.
- `KeyBoards`: Can / Cannot per key type.
- `Figure`: number, unit, source; the only way a figure renders.
- `State`: loading, empty, error, stale wrappers for every block.
