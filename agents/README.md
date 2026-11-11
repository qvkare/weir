# @weir/agents

Trading agents for Weir: four small deterministic strategies, a simulation of a whole
market on the engine, and `tick`, a stateless runner that trades the same strategies on
any `WeirPort`, the in-memory model or the chain.

Everything in `src/` except `cli.ts` is browser- and Worker-safe (no Node imports; a test
checks it). The site imports `src/sim.ts`; a Worker imports `src/swarm.ts` with `@weir/chain`.

## Run it (no keys, no network)

```sh
node agents/src/cli.ts sim --market h100-fast --seed 7 --rounds 20
# optional: --buyers 20 --sellers 5 --makers 2 --noise 3 (the defaults),
#           --market h100-weekly | h200-weekly | a100-80-weekly (--preset fast|weekly still works)
```

It runs 20 rounds, keeps going without new orders until every series is settled and
redeemed, and prints (58 lines; excerpt):

```
Weir sim, H100, hourly (demo) (h100-fast): each hour of delivery is auctioned the hour before, in 3+2 min rounds. Seed 7: 20 buyers, 5 sellers, 2 makers, 3 noise. Prices per H100-hour.
Every commit burns a $0.10 fee, so taking a slot in a round always costs something and filling rounds to keep others out is not free.
series round  commits revealed  LONG price  forward  volume  forfeits
     0     0       15       15      $0.419   $2.924      68     $0.00
     0     1       18       18      $0.434   $2.939      84     $0.00
     0     2       17       17      $0.470   $2.975      82     $0.00
     ...
     1     7       15       15      $0.395   $2.900      69     $0.00
20 of 20 rounds traded. Series 0 fixed at $2.874, LONG paid $0.369. Series 1 fixed at $2.981, LONG paid $0.476.
Burned: $31.70 in commit fees and $0.00 in forfeits ($31.70 in all; burned dollars belong to nobody).
Money check: deposits $3090.00 = free $3058.30 + locked $0.00 + sets $0.00 + unredeemed $0.00 + burned $31.70.
agent       role    LONG  SHORT      paid  received   fees   result
buyer-01    buyer     26      0     $9.21    $11.20  $0.20   +$1.78
buyer-02    buyer    112      0    $45.12    $47.32  $1.00   +$1.19
...
seller-05   seller     0    359   $171.31   $168.01  $2.10   -$5.40
maker-01    maker    172     17    $70.67    $74.67  $4.20   -$0.21
maker-02    maker      0      0     $0.00     $0.00  $4.20   -$4.20
noise-01    noise     39     19    $27.14    $24.14  $0.80   -$3.81
paid: auction fills; received: payout at settlement; fees: commit fees and forfeits burned; result: balance now minus deposit.
```

With `--void` the reporters sit out series 0's delivery window, so it cannot reach
`min_prints` and settles void (SPEC section 10): the series is cancelled at the centre of the
band, every LONG and every SHORT paid half the band whatever was traded, so wash trades
cannot steer a void payout. The closing lines then read:

```
20 of 20 rounds traded. Series 0 void: cancelled at the centre of the band, $0.441 to every LONG and every SHORT. Series 1 fixed at $2.981, LONG paid $0.476.
Burned: $32.20 in commit fees and $0.00 in forfeits ($32.20 in all; burned dollars belong to nobody).
Money check: deposits $3090.00 = free $3057.80 + locked $0.00 + sets $0.00 + unredeemed $0.00 + burned $32.20.
Series 0 is void: the reporters were silent through its delivery, so it was cancelled and every LONG and every SHORT paid $0.441, half the band.
```

`LONG price` is the uniform clearing price `p*` (SPEC section 7); `forward` is `floor + p*`,
the implied price of a GPU-hour in the delivery window. Every auction for a series ends
before its delivery starts. A buyer gains when the index ends above where it hedged and
loses when below, and the sellers mirror it. That is the hedge working, not a profit or a
loss on compute: both sides fixed their price in the auction.

Headline numbers with the defaults (`h100-fast`, seed 7): 20 of 20 rounds traded, 71.2
GPU-hours per round on average, 15.2 commits per round, no forfeits, both series settled,
$31.70 burned in commit fees, every dollar accounted for. On a weekly market, for example
`--market h200-weekly --rounds 168`: 168 of 168 rounds traded, $266.00 burned in fees.

## Files

| File | What it is |
|---|---|
| `src/strategy.ts` | `Intent`, `Strategy`, `AgentView`; the shared forecast; `fit`, which puts every order on the tick, strictly inside the band, within `max_order_size` and within the free balance. |
| `src/strategies/` | `buyer`, `seller`, `maker`, `noise`: 22 to 26 lines each. |
| `src/swarm.ts` | `tick` (any `WeirPort`) and `tickSync` (the model's `SyncWeir`), one generator behind both; `OrderStore`, `MemoryStore`, `rebuildOrder`. |
| `src/sim.ts` | `createSimulation`, `MARKETS`, `PRESETS`, `SIM_T0`, `agentReports`, `burned`. |
| `src/presets.ts` | The two parameter sets, as `new(params)` JSON, and the `MARKETS` built on them. |
| `src/random.ts` | HMAC-SHA-256 over the engine's synchronous SHA-256, and a seeded PRNG. |
| `src/cli.ts` | Node only: the `sim` command. |

## Strategies

Every price is a LONG price on the tick, strictly between 0 and `band`. Each `rule` string
is one sentence the site can show.

**Fair value.** All four use the same forecast of the delivery window's average index: the
prints already inside the window plus the last print for every print still to come
(before delivery starts, simply the last print). That is the right forecast if the index is
a random walk, and nothing cleverer is claimed. As a LONG price it is
`clamp(forecast - floor, 0, band)`.

- **buyer** (need N GPU-hours, premium q): each round bids LONG for its unhedged hours
  spread over the rounds left, at up to fair value plus q of the band. When that even share
  is below the smallest order worth its fee, it bids that smallest order with probability
  share / smallest, so on average it still spreads its hedge over the rounds.
- **seller** (capacity N, premium q): the mirror image, SHORT at a LONG price down to fair
  value minus q of the band.
- **maker** (spread s, share h): LONG at fair minus s/2 and SHORT at fair plus s/2, each
  side sized to h of its free balance.
- **noise**: a uniform random view within 10% of the band around fair value; bids 3 to 10
  GPU-hours (at least the smallest order worth its fee) at that view, LONG if above fair,
  SHORT if below.

`fit` makes sure the free balance covers every order's lock, which is exactly what the
order can cost (`size × price` for LONG, `size × (band − price)` for SHORT), plus the commit
fee of each order. **Fee rule:** no order locks less than 50 commit fees (or `min_lock`, if
that is more), so the fee is never more than 2% of what an order puts up; with the 10-cent
fee that is a $5.00 minimum lock (12 units at a LONG price of $0.44).

## The swarm

`tick(ctx)` is meant to be called about once a minute. It is stateless and idempotent: it
reads `get_status`, and for every agent does what is due now, most urgent first: reveal
every commit it holds in a reveal phase; clear every round in the series' `pending_rounds` that is over, oldest first (and log, per
commit, any forfeit it finds); settle a series once its delivery and report window are
over and it has `min_prints` (or the void rule applies); redeem positions on settled
series; commit in a commit phase if the agent has no commit in this round yet. It stops at
`budget` calls (views and transactions, default 200) and logs what it did, skipped and why.

**The order store.** `tick` keeps one piece of state: an `OrderStore`
(`get(key)`, `put(key, value)`; a Cloudflare KV namespace fits as is, `MemoryStore` serves
tests and the simulation, and `tickSync` takes its synchronous face). Before sending a
commit the swarm stores the order (side, size, price, salt, commit hash) under
`market|series|round|agent|n`, so a crash between the two cannot lose a reveal, and adds the
seq once the commit lands. At reveal time it reads the agent's entries and matches them to
its commits in `get_round` by `hash`. The lock is exactly what the order requires, so a
commit shows only that amount, never the side, size or price separately.

Salts stay HMAC-SHA-256(secret, series|round|agent|n). If an entry is lost, the order can
still be found cheaply: the lock is `size × unit` exactly, so the swarm hashes the two sides
for each size dividing it and each `n` (at most a few thousand SHA-256s) until one matches
the commit's hash. This recovery is on by default (`recover: false` turns it off). A commit
the swarm owns that it can neither find nor rebuild is logged as `cannot reveal: order not
in store` at every tick of the reveal window, and the forfeit is logged when it clears.
Store reads and writes count against the budget, three calls per order committed.

**Limits the swarm respects.** The swarm sets nothing on guards itself. If an account has a
`max_round_lock` (set by its owner with a full-access key), the swarm reads it from
`get_account` and shrinks the agent's orders, in order, so their locks fit; it logs the trim
(`trimmed its orders to its max_round_lock`). Every commit also pays the commit fee, which is
burned at clearing along with any forfeit.

With 60-second ticks, 2-minute (fast) or 15-minute (weekly) reveal windows always see at
least one tick, so the swarm never forfeits by its own doing. If ticks are missed past a
reveal window, the next tick logs each forfeit (`action: "forfeit"`, the amount) as it
clears the round. A forfeit is only seen if this swarm clears the round itself: when
someone else clears it first, the per-commit detail is gone from the views.

## Simulation

```ts
import { createSimulation } from "@weir/agents/sim";
const sim = createSimulation({ seed: 7, buyers: 20, sellers: 5, makers: 2, noise: 3, market: "fast" });
sim.runRounds(5); sim.skipToClearing(); sim.step(600); sim.settleAll(); sim.balances();
```

It registers and funds the agents, runs
three reporters that post the index at every print (at -0.1%, exact and +0.1%; with all
three reporting, each print is their median, the exact value), and drives every phase through `ModelWeir`
with the same `tickSync` the live swarm uses (and a `MemoryStore`), at the preset's cadence (60 s fast, 15 min
weekly). The index is a seeded random walk scaled to about 6% volatility per delivery
period with an 8 to 15% jump about once every four periods, or an explicit array of prices
(`prices`, micro-USD, one per print) to replay real history. Same seed, same events, byte
for byte. Agents' needs and capacities are GPU-hours per delivery period: on the fast
preset as drawn (buyers 20 to 60, sellers 120 to 240), on a weekly market 8.4 times that (a
buyer uses 1 to 3 GPUs all week, a seller rents out 6 to 12); deposits (buyers $60, sellers
$200, makers $400, noise $30 on `h100-fast`) scale the same way and with the chip's price.
`silentSeries` (the CLI's `--void`) makes the reporters sit out one series' delivery window.
Additions to the requested API: `log` (every event), `settleAll()`, the
`deposit` of each `SimAgent`, `prices` in `SimConfig`, and `agentReports(sim)`.

## Markets

One market per chip, exported as `MARKETS` for deployment and the simulation. `chip` is the
id `index/src/chips.ts` uses; `startPrice` is the chip's index level on 2026-11-12, where the
simulation's random index starts.

| `id` | `label` | `chip` | `underlying` | preset | `startPrice` |
|---|---|---|---|---|---|
| `h100-fast` | H100, hourly (demo) | `h100` | `H100-USD-HR` | fast | $2.90 |
| `h100-weekly` | H100, weekly | `h100` | `H100-USD-HR` | weekly | $2.90 |
| `h200-weekly` | H200, weekly | `h200` | `H200-USD-HR` | weekly | $4.25 |
| `a100-80-weekly` | A100 80 GB, weekly | `a100-80` | `A100-80-USD-HR` | weekly | $1.55 |

`createSimulation({ market })` takes one of these ids (default `h100-weekly`); `weekly` and
`fast` still work and mean the H100 market.

## Presets

Both are exported as `PRESETS` in the contract's `new(params)` JSON. Deployment replaces only
`usdc`, `reporters` and `t0`. The commit fee is there so that taking a slot in a round always
costs something: filling rounds to keep others out is not free. It is ten cents because the
audit showed that filling every slot of a round cost $1.28 a round at two cents; at ten
cents it costs $6.40 a round, about $1,075 for a week of a weekly market.

| Parameter | `weekly` | `fast` |
|---|---|---|
| `period_secs` | 604800 (7 days) | 3600 |
| `cutoff_secs` | 3600 | 300 |
| `lead_secs` = period + cutoff | 608400 | 3900 |
| `commit_secs` / `reveal_secs` | 2700 / 900 | 180 / 120 |
| rounds per series | 168 | 12 |
| `print_interval_secs` | 3600 | 300 |
| `report_grace_secs` | 900 | 60 |
| `min_prints` | 126 of 168 | 9 of 12 |
| `void_after_secs` | 172800 | 1800 |
| `max_anchor_age_secs` | 10800 | 900 |
| `band_bps` | 1500 (from `backtest/results/summary.md`) | 1500 |
| `tick` | 1000 ($0.001) | 1000 |
| `max_spread_bps` | 200 | 200 |
| `commit_fee` | 100000 ($0.10) | 100000 |
| `forfeit_bps` | 100 | 100 |
| `min_lock` | 1000000 ($1) | 1000000 |
| `max_commits` | 64 | 64 |
| `max_order_size` | 10000 | 10000 |
| reporters, `quorum` | 3, 2 | 3, 2 |
| `underlying` | `H100-USD-HR` | `H100-USD-HR` |

With `lead_secs = period_secs + cutoff_secs` (SPEC 0.2, `auction_close = delivery_start -
cutoff_secs`), a series is auctioned in the week (or, fast, the hour) before its delivery,
ending `cutoff_secs` before delivery starts, and the next series' auctions begin exactly
then: one series in auction at any time, always the next one to be delivered, in
back-to-back rounds.

## Tests

```sh
pnpm --filter @weir/agents test        # node:test, offline
pnpm --filter @weir/agents typecheck   # tsc --noEmit
```

- `strategies.test.ts`: the forecast; buyer and seller reservation prices, sizes, balance
  limits and tick rounding on hand-worked cases; maker and noise; 5,000 random views where
  every order of every strategy must be valid for band, tick, size, `min_lock` and balance.
- `random.test.ts`: HMAC against RFC 4231 and against `node:crypto` on 300 random inputs.
- `swarm.test.ts`: `rebuildOrder` on 500 random orders; ticked every 60 s through two full
  fast series on `ModelWeir`: zero forfeits and failures, every commit revealed, every lock
  exactly its order's requirement, all 12 rounds of each series cleared, both settled, every
  position redeemed, no tick over 200 calls; idempotence; a gap over a reveal window puts
  each forfeit in the log and their sum in the round's `forfeited` and in `burned`; an
  account's `max_round_lock` trims orders, and the trim is logged; a store wiped between commit and
  reveal gives "cannot reveal" and a logged forfeit with recovery off, and rebuilt reveals
  with it on; a small budget stops and resumes.
- `sim.test.ts`: two runs with one seed give identical logs (and another seed does not); at
  every step deposits equal the five terms of `get_totals` (free, locked, sets, unredeemed,
  burned), fees and forfeits add up to `burned` per agent and in total, and after settlement every
  agent's free balance sums to `free` with nothing locked; 20 buyers and 5 sellers alone
  trade in 23 of 24 rounds with seed 7 (asserted: at least 20); the default agents trade in
  24 of the first 24 rounds on every market (asserted: at least 20); price replay; the weekly
  preset; every market checked against every rule of SPEC section 3 (including a majority
  quorum) plus Weir's own choices; each chip's index starting at its level; a void series
  paying half the band to every LONG and SHORT, with the money check balanced.
- `portable.test.ts`.

## Not proven

The swarm has only run on `ModelWeir`. Its chain path is the same code over `ChainWeir`,
whose own limits are listed in `chain/README.md`; on chain each tick would send one
transaction per commit, reveal, clear, settle and redeem, which has not been costed. The
strategies are simple by design and have not been tested against real price history.
