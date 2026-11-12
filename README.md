# Weir

Weir runs sealed-bid, single-price, week-ahead auctions on the price of one GPU-hour, on NEAR. It is for people who rent GPU time and want to fix next week's price today, and for people who own GPUs and want to fix what they will earn. There is one market per chip: H100 (weekly, plus an hourly demo market that runs 168 times faster), H200 weekly and A100 80 GB weekly. Buyers of compute buy LONG, owners of GPUs buy SHORT. Every position is paid in full when it opens, so nothing is ever liquidated. A series settles on the average of a public GPU price index over its delivery week. AI agents can bid with NEAR function-call keys that cannot withdraw.

## The problem

GPU rental prices move, and the bill for next week is not known when the work is planned. In the backtest in this repository (69 delivery weeks of H100 on-demand prices, 2025-04-14 to 2026-11-02), the weekly average moved between -9.4% and +22.5% against the price known 8 to 10 days earlier, and the weekly average went from 2.63 USD (week of 2026-01-26) to 4.26 USD (week of 2026-10-26) per GPU-hour. For a team running 8 GPUs around the clock (1,344 GPU-hours a week), the part of the weekly bill that was not known when the auction would have opened had a standard deviation of 184.72 USD. These figures are list prices, not trades; see [Backtest](#backtest).

## Try it with no keys

The site is not deployed yet. To run it locally in model mode (every view answered by the engine, no chain): `pnpm install`, then `make web`, then open http://localhost:3000.

From a clone, with Node 22.18 or newer, pnpm 10 and Python 3:

```sh
pnpm install
make judge
```

| Do | See |
|---|---|
| `make judge` | Everything below except the last three rows, then a summary of what was and was not checked. 2 s on an Apple-silicon laptop, plus one network call |
| `make verify` | The four recorded index bundles (the first H100 print and the newest H100, H200 and A100 80 GB prints) recomputed from the raw source bodies and re-hashed: 113, 115, 76 and 90 checks. The engine reproducing all 4,584 cases the contract wrote to `vectors/`. "no deployment recorded yet" |
| `make sim` | 30 agents (20 buyers, 5 sellers, 2 makers, 3 noise traders) trading the hourly H100 demo market on the engine: 20 of 20 rounds traded, both series settled and redeemed, and a money check (deposits equal free balances plus locks plus backing plus unredeemed plus burned) that the target asserts |
| `make backtest` | The backtest recomputed from `backtest/data/derived/`, its four result files compared byte for byte with the committed ones, then `backtest/scripts/verify.py` recomputing 900 numbers in Python with 0 mismatches |
| `make quote-dry` | A live NEAR Intents dry quote for 20 USDC from Arbitrum to NEAR. Nothing is sent. If the service cannot be reached or does not quote the pair, it says which and still exits 0 |
| `make audit` | Needs Rust. The 20 tests from the four passes of the independent review (8, 9, 2 and 1 per file), each with what it shows, then the state each one printed |
| `make web` | The site at http://localhost:3000 in model mode, with a ribbon on every page saying so |
| `make index` | Needs the network. This hour's index for the three chips from six public, keyless sources (8 HTTP requests), written to a temporary directory and verified |

`make test` runs every suite that needs no running node (needs Rust 1.96 and cargo-near 0.23). `make test-sandbox` runs the real wasm on a local NEAR node. `make help` lists every target.

## What is proven, and by what

| Claim | Checked by | Kind of evidence |
|---|---|---|
| The contract and the engine, written separately from [`docs/SPEC.md`](docs/SPEC.md), compute the same numbers | `make verify`: the engine reproduces 4,584 cases written by the Rust code (band, clearing, hash, print, settlement, time) | Recomputation from committed data |
| On a local NEAR node, the real wasm and the engine agree on every result, event, view and refusal | `make test-sandbox` (integration `e2e`). Third run, specification 0.6 ([`integration/RESULTS.md`](integration/RESULTS.md)): 264 of 264 checks passed; 1,315 state changes and 2,315 views compared with no difference, 61 refusals among them, word for word; 549 s. That run used the wasm built before the contracts were formatted with rustfmt (sha256 `40583288…110c`). The same command was rerun on the formatted, current build (`13536f3b…413c`, same size, 303,753 bytes): 264 of 264 checks, 1,315 calls and 2,315 views with no difference, 533 s | Test on the authors' machine, local sandbox only |
| Solvency (the contract's USDC equals free balances, locks, backing, unredeemed payouts and burned dollars) and the other invariants of spec section 11 | `make test-contracts`: property tests over 2,000 random order books per clearing invariant and 96 random sequences of up to 300 calls, each ended by clearing, settling and redeeming everything; the engine's own 300 random sequences in `pnpm --dir engine test` | Test on this machine |
| An index print can be recomputed by anyone | `make verify-index`: every provider value and the index re-derived from the offers and from the raw responses, and the bundle hash recomputed | Recomputation from committed data |
| An agent's function-call key can trade but cannot withdraw, move positions or change its limits | `make test-sandbox`: the sandbox test `a_function_call_key_trades_but_cannot_move_money`, and the integration run (refused before any code runs: `withdraw`, `set_guard`, `transfer_position`, `register`, deposits) | Test on a local sandbox node. Not yet shown on a public network |
| Clearing a full round fits in one transaction | `make test-sandbox`: `clearing_a_full_round_fits_in_one_transaction`. Measured on 2026-11-12: about 26.6 Tgas for 64 commits (the presets' limit) and 51.5 Tgas for 128 (the contract's limit) in this test ([`contracts/README.md`](contracts/README.md)); 50.48 Tgas for 128 in the third integration run. The chain client attaches 150 Tgas to `clear`. Every commit from a different account, revealed and filled | Test on a local sandbox node |
| The backtest's numbers follow from its data | `make backtest`: byte-identical results and an independent Python recomputation of 900 numbers | Recomputation from committed data. The data itself was fetched once by the authors (`backtest/data/derived/provenance.json` lists every file with its sha256) |
| The contract has no owner, no admin method and no upgrade method | Reading `contracts/weir/src/lib.rs`: the only `#[private]` method is the withdraw callback | Statement by the authors, checked by the review in [`docs/AUDIT.md`](docs/AUDIT.md) |

## How a round runs

Spec sections [4](docs/SPEC.md#4-time), [6](docs/SPEC.md#6-orders) and [7](docs/SPEC.md#7-clearing). Figures are the weekly preset (`agents/src/presets.ts`).

1. Each delivery week is a series. Its auctions run in the week before delivery, in back-to-back hourly rounds (45 minutes commit, 15 minutes reveal), 168 rounds, ending one hour before delivery starts. Only the clock sets the phases.
2. The first commit or mint opens the series on the last index print, which must be at most 3 hours old. The band is fixed then: `half` is 15% of that price rounded down to the 0.001 USD tick, `floor = price - half`, `band = 2 * half`. LONG pays `clamp(fixing - floor, 0, band)` per GPU-hour at settlement; SHORT pays the rest of the band.
3. In the commit phase a bidder sends `sha256("weir:v1|series|round|account|side|size|price|salt")` and a lock in dollars, and pays a commit fee (0.10 USD). The lock shows only an upper bound on what the order can cost. A round holds 64 commits; a larger lock evicts the smallest, which gets its lock and fee back.
4. In the reveal phase the bidder sends side, size, price and salt. The lock must cover the order. If the account has a guard, an order priced further than the guard from the reference price recorded at commit is void: its lock returns at once, its fee does not.
5. When the round is over, anyone calls `clear`. One price `p*` is chosen: the one that trades the most units; among ties, the one with the smallest imbalance; among those, the highest, the lowest or their midpoint, depending on which side has more left over. Every filled LONG pays `p*` and every filled SHORT pays `band - p*`, so each matched pair is backed by exactly `band` dollars. A commit that was not revealed loses 1% of its lock. Fees and forfeits are burned: they stay in the contract and belong to nobody.

## How a series settles

Spec sections [9](docs/SPEC.md#9-index) and [10](docs/SPEC.md#10-settlement).

1. Three reporters post `report(bucket, price, bundle)` every hour, where `bundle` is the sha256 of the published evidence. With all three, the print is the median. With two, they must agree within 2%, or the hour has no print.
2. After the delivery week and a 15-minute grace, once every round of the series is cleared, anyone calls `settle`. With at least 126 of 168 hourly prints, the fixing is their average, and LONG and SHORT payouts follow from the band.
3. With fewer prints, two days after delivery ends, the series is void and cancelled at the centre of its band: every LONG and every SHORT is paid half the band, whatever was traded and whatever prints exist. Nothing a trader does moves that number. A side bought for less than half the band gets more back than it paid, a side bought for more gets less.
4. Anyone calls `redeem` for any account, which credits that account's free balance. Withdrawing needs the account's full-access key.

## The index

Method `weir-gpu-od/2` ([`index/METHOD.md`](index/METHOD.md)): the price of one on-demand GPU-hour of a chip, all form factors, in micro-USD.

- **Sources**, all public and keyless: Vast.ai, RunPod, Akash, Lium, Verda and Shadeform. Shadeform resells many clouds; each cloud there counts as its own provider.
- **Rule**: a provider's value is the median of its qualifying offers; the index is the median of the provider values. It needs at least 6 providers, 3 of them rate cards, or there is no index for that hour and no report. Offers below 25% of the median offer are dropped as placeholders. Nothing is carried forward or interpolated.
- **Evidence**: each print is a bundle with every offer and the sha256 of every raw response. Its sha256 is what goes on chain. `make verify-index` recomputes it.

Recorded prints, bucket 2026-11-11 21:00 UTC, fetched 21:54 UTC:

| Index | USD per GPU-hour | Providers included (rate card + open market) | File |
|---|---|---|---|
| H100-OD | 2.90 | 17 (15 + 2) | `evidence/bundles/h100/1794430800-778ad1c29b90.json` |
| H200-OD | 4.25 | 9 (7 + 2) | `evidence/bundles/h200/1794430800-9eb06ccea683.json` |
| A100-80-OD | 1.55125 | 12 (10 + 2) | `evidence/bundles/a100-80/1794430800-501e30c4ce8e.json` |

The first H100 print, two hours earlier under method version 1, was 2.76 USD (`evidence/bundles/1794423600-1c0e2cb8b9c8.json`).

Cross-checks: the backtest compares its own H100 composite with two outside series ([`backtest/README.md`](backtest/README.md)). It sits 28.1% above Ornn's transaction-based H100 index on average over 91 days, and 9.4% from henryzhangpku's weekly index on average over 38 weeks.

Limits:

- These are asking prices and rate cards, not trades. Nothing shows anyone paid them or how much capacity was there.
- Shadeform supplies most providers (13 of 17 for H100, 5 of 9 for H200, 8 of 12 for A100 80 GB). Without it no chip has 6 providers, so one Shadeform outage or API change takes every index to no print at once.
- The open-market sources are thin and anyone can list there. Each index had 2 open-market providers on the recorded print.
- List prices move in steps and can stay unchanged for weeks; a listed GPU may not be available at that price.
- A renamed model at a source drops that provider silently, because names are matched exactly.

## Backtest

`backtest/` replays H100 on-demand prices from free public sources: the dstack gpuhunt catalogs, the afhubbard/gpu-prices dataset and archived Akash captures. 69 delivery weeks, 2025-04-14 to 2026-11-02 (13 of 82 weeks dropped for a stale anchor or too few prints). The band is set at the anchor, the price 8 to 10 days before delivery, and the auction is assumed to clear at the anchor.

| band_bps | ±10% | ±15% | ±20% | ±25% |
|---|---|---|---|---|
| Weeks the fixing stayed inside the band | 64 of 69 | 68 of 69 | 68 of 69 | 69 of 69 |

| 1,344 GPU-hours a week, band ±15% | Unhedged | Hedged |
|---|---|---|
| Weekly cost, mean | 4,055.99 USD | 4,017.96 USD |
| Weekly cost, standard deviation | 554.91 USD | 502.38 USD |
| Standard deviation of the part not known at the auction | 184.72 USD | 32.37 USD |
| Largest week-on-week increase | 500.45 USD | 528.19 USD |

What it says, and what it does not:

- The hedge removes 96.9% of the variance of the part of the bill not known at the auction, but only 18.0% of the variance of the bill itself. It fixes next week's price at this week's level, so a buyer still follows a rising market, one week late. It did not reduce the largest week-on-week increase.
- The ±15% band was chosen as the smallest in the grid covering at least 95% of weeks. 69 weeks cannot show 95% coverage with 95% confidence for any band tested. The one breach, 2026-06-01, was a +22.5% market-wide repricing; the buyer paid 0.200 USD per GPU-hour above the cap that week.
- For a buyer whose own provider does not follow the index, the hedge does little or harm. It removes 27% (RunPod) to 33% (Nebius, Verda) of their surprise variance at best, and adds risk for Lambda (-140%), Akash (-37%) and the hyperscalers.
- The composite is a list-price index and sits 28% above a transaction-based index where they overlap. It is also not the live index: its 4 to 8 providers per day gave 4.09 USD on 2026-11-10, while the live H100-OD, with 17 providers, printed 2.90 USD the next day.
- 69 weeks hold one gentle decline and one sharp rise. No real order flow: the clearing price is assumed. No fees, no cost of locked capital.

Method, sources, licences and every table: [`backtest/README.md`](backtest/README.md), [`backtest/results/summary.md`](backtest/results/summary.md).

## What each key can do

| Actor | Can | Cannot |
|---|---|---|
| Anyone | Read every view. Call `clear`, `settle`, `redeem` (for any account), `finalize_print`, `prune_print`, `prune_result` | Report a price. Move anyone's dollars except into their own free balance by `redeem` |
| An account's full-access key | Register, deposit, withdraw its free balance, set its guard and round lock limit, move positions, commit, reveal, mint, merge | Take a lock back before its round clears (it returns early only if evicted or void). Change the contract's parameters |
| An agent's function-call key, limited to `commit`, `reveal`, `clear`, `mint`, `merge`, `settle`, `redeem` | Trade with dollars already deposited for the account | Withdraw, move positions, change its guard or round lock limit (all need 1 yoctoNEAR, which the protocol refuses on a function-call key), register, deposit, report. At worst, per round: lose 1% of the round lock limit plus 0.10 USD per commit, at prices within the guard. Both limits are off until the account sets them |
| A reporter, key limited to `report`, `finalize_print` | Report once per bucket | Take funds. With all three present, move a print outside what the other two report. Two of three together can set any price. One, while another is absent, can choose which hours print ([`docs/AUDIT.md`](docs/AUDIT.md) finding 2.1) |
| The keeper's housekeeping key, agent methods plus `finalize_print`, `prune_print`, `prune_result` | Run the calls anyone may make, on schedule | Hold or move dollars, report, withdraw |
| The contract | Hold the USDC and pay what the rules say | Pay out burned dollars. Change its code or parameters: it has no owner and no upgrade method, and once its account's keys are deleted nothing can change it |

## NEAR pieces

- **Function-call access keys** are the agent boundary, enforced by the protocol, not by Weir's code. A key limited to the trading methods cannot attach a deposit, and `withdraw`, `set_guard` and `transfer_position` require exactly 1 yoctoNEAR, so an agent key cannot reach them. The contract adds two limits the key cannot change: the guard and the round lock limit. Shown on a local sandbox node; not yet on a public network.
- **Named sub-accounts.** The deploy tool gives each agent and reporter its own account under one operator account (`h100-weekly-buyer-1.weir-ops-<suffix>.testnet`), each with its own key and allowance. Run on a sandbox only.
- **A contract with no keys.** The contract has no owner or upgrade method. `node deploy/src/cli.ts seal` deletes the contract account's keys, after which its code cannot change; the sealed sandbox market still took reports and commits. Not done on a public network.
- **Cheap, frequent transactions.** A weekly market has 168 rounds, so an active agent sends up to 336 commits and reveals a week. Measured on the sandbox (third integration run), a commit burns 2.97 Tgas and a reveal 2.51 Tgas at the median. At the gas price read on testnet on 2026-11-12 (0.0001 NEAR per Tgas), that is about 0.0003 NEAR each.
- **NEAR Intents.** `make quote-dry` and the site take live dry quotes from the 1Click API for moving USDC from Arbitrum, Base, Ethereum or Solana to NEAR. The client refuses anything but a dry quote. No transfer has been made through Intents.

## Audit

An AI reviewer (Claude, an Anthropic model) that did not write the contract reviewed it in four passes, all on 2026-11-12, against specifications 0.3, 0.4, 0.5 and 0.6, and kept its findings as tests. It covered `contracts/weir/src/` only: not the TypeScript packages, the reporters' code, deployment or real tokens. It did not run the real wasm. It is not an audit by a security firm and not a formal verification, and no person has signed it off. Its record is [`docs/AUDIT.md`](docs/AUDIT.md); `make audit` runs its tests and prints what each one shows.

Found sound in all four passes: the dollar accounting on every path, the 0.6 void path included (`audit4_a_non_reporter_cannot_move_the_void_payout` asserts free plus burned equals deposits after a full void redemption; burned dollars are never credited). Also found sound, by reading: clearing as the spec defines it, the commit hash, the access controls, the recorded guard, the round lock limit and the sets cap.

One fix was itself found faulty. After the second pass, specification 0.5 settled a void series at its average traded price. The third pass showed that wash trades between two accounts one person controls set that average anywhere in the band for the cost of commit fees: in its test a trading reporter took 19.40 USD of a counterparty's 20 USD (finding 3.1). Specification 0.6 replaced the rule: a void series pays half the band on each side and reads nothing that was traded. The fourth pass checked that rule and found it sound against traders who are not reporters: wash trades, mints, merges and transfers before a void changed nothing.

The verdict, as the record states it: fit for a public testnet with test dollars, with its reporters run by one known operator and these limits stated. Not fit for real dollars until, at least, the reporters are independent parties, numerous enough that one absence does not leave two reporters each able to veto any hour; blocking a round costs something that scales with what it blocks; the round lock limit is on by default; and the contract's NEAR balance and pruning have a funded owner.

What stays open, at the deployed parameters (weekly preset, 0.10 USD fee, a 0.60 USD band on a 2.00 USD index):

| # | Open | Size | Test |
|---|---|---|---|
| 2.1 | With one reporter absent, one dishonest reporter chooses which hours print and leans each print | About 0.029 USD a unit, 4.8% of the band, at an hourly spread the reviewer assumed (1% of the index), not measured | `limit_one_reporter_selects_which_buckets_print` |
| 3.2 (and 2.2) | A reporter holding a side bought cheaply forces a void and is paid half the band | Up to 0.299 USD a unit, 49.8% of the band. Needs 43 of 168 hours without a print | `limit_a_trading_reporter_forces_a_void_for_up_to_0_299_a_unit_at_the_deployed_band` |
| 2.3 (and 1.5) | Blocking a round | 6.40 USD a round, about 1,075 USD a week, plus capital above the largest honest lock | `limit_blocking_a_round_costs_6_40_dollars_at_the_deployed_fee` |
| 2.4 | An agent key burns an account with no round lock limit at 1% plus the fee a round | The deploy tool sets the limit for the agents it creates; the limit is off by default | `limit_an_account_without_a_round_lock_limit_can_be_burned` |
| 2.5 | Not revealing changes who else is filled: a last look | 1% of the lock plus 0.10 USD | `limit_last_look_a_non_reveal_changes_another_accounts_fill` |
| 1.8 | Nobody is paid to prune or to send the contract NEAR | A low balance stops reports, and settlement then turns void | `audit_storage_bytes_per_object_and_pruning` |
| 2.6, 2.7 | One account can take a series' mint cap; `new` still accepts unwise parameters (a 100% spread, two reporters, no fee and no forfeit) | Read `get_params` before trusting a deployment | `limit_one_account_can_take_the_whole_mint_cap`, `limit_unwise_parameters_are_still_accepted` |
| 2.8 to 2.11, 4.1 | Pending-bucket growth; early pruning; a lagging guard reference; a view limit; a void caused only indirectly by draining the contract's NEAR | Low or note; found by reading, not tested | none |

Closed, each with a test that keeps the attack and asserts it fails: one reporter steering, freezing or reordering the index (1.1, 1.2, 1.7); the mint overflow (1.3); forfeits paid to an accomplice (1.4, theft part); changing the guard after commit (1.6); a quorum below a majority (part of 2.7); the 0.5 void payout set by wash trades (3.1).

## Contracts and accounts

Nothing is deployed yet, on testnet or mainnet. `deployments.json` lists no market.

<!-- TO FILL after the testnet deployment: one row per account, from deploy/out/testnet/record.json. -->

| Contract or account | Network | Account | What it is |
|---|---|---|---|
| H100 weekly market | NEAR testnet | (not deployed) | `contracts/weir`, preset `weekly` |
| H100 hourly demo market | NEAR testnet | (not deployed) | `contracts/weir`, preset `fast` |
| H200 weekly market | NEAR testnet | (not deployed) | `contracts/weir`, preset `weekly` |
| A100 80 GB weekly market | NEAR testnet | (not deployed) | `contracts/weir`, preset `weekly` |
| Test dollar tUSDC (open mint) | NEAR testnet | (not deployed) | `contracts/mock-usdc` |
| Operator account (reporters, agents, keeper) | NEAR testnet | (not deployed) | parent of every operator account |

## When it fails

- **The index has no print.** A chip with fewer than 6 providers or 3 rate cards gets no index for that hour. If Shadeform is down, every chip is. A series with too few prints is void and pays both sides half the band: the hedge is cancelled.
- **Reporters disagree or are wrong.** One operator runs all three reporters from one fetch, so the quorum protects against a failed transaction, not a wrong price. Two reporters agreeing can set any price. Nothing on chain checks a report against its bundle.
- **One reporter is absent and another is dishonest.** The dishonest one can choose which hours print and lean each print, about 0.029 USD a GPU-hour at an assumed hourly spread (finding 2.1, open). Or it can veto 43 of 168 hours to make the series void, which pays half the band to a side it may have bought cheaply: up to 0.299 USD a GPU-hour at a 0.60 USD band (finding 3.2, open).
- **The index moves more than 15% in a week.** Payouts stop at the band; the rest is not hedged. This happened once in 69 backtest weeks.
- **The buyer's provider does not follow the index.** The hedge then adds risk (Lambda in the backtest).
- **Nobody bids on one side.** A round with no crossing orders does not trade.
- **A bidder with capital blocks a round.** It fills all 64 slots with larger locks; it costs 6.40 USD a round in fees at the presets.
- **A late revealer takes a last look.** Not revealing costs 1% of the lock and the fee, and can change who else is filled.
- **The keeper stops.** Reveals are missed and each commit forfeits 1% of its lock. Rounds still clear and series still settle when anyone calls them.
- **The contract runs short of NEAR for storage.** Reports, commits and settlement fail until someone sends it NEAR; no dollars are stolen, but a series whose hours go unreported settles void. Nobody is paid to prune or to send NEAR.
- **An agent's account has no round lock limit.** A stolen agent key can then burn 1% of the balance plus the fee every round (finding 2.4).

## Not built yet

- **No deployment.** Nothing runs on testnet or mainnet. The deploy tool has run on a local sandbox only.
- **No mainnet and no real USDC.** The test dollar has an open mint.
- **No AMD market.** Of the six sources only RunPod lists an AMD chip (MI300X), and one provider cannot make an index. B200 meets the provider count but its values spread by a factor of 2.7, so it is not offered either ([`index/METHOD.md`](index/METHOD.md)).
- **Independent reporters.** One operator runs all three.
- **No wallet in the site.** It is read-only; agents trade through their own keys.
- **No external audit firm, no formal verification and no reproducible build** (`contracts/build.sh` builds `non-reproducible-wasm`).
- **The keeper needs a paid plan or a machine that stays on.** On the Cloudflare free plan, its index ticks exceed the 10 ms CPU limit and it needs about 11,600 store writes a day against 1,000 ([`keeper/README.md`](keeper/README.md), Cloudflare's published limits, not tried against an account).
- **Funding through NEAR Intents.** Dry quotes only; no transfer.
- **The weekly preset end to end.** The sandbox runs covered whole series of the hourly demo market; in the third run an H200 weekly market ran 2.6 hours of its week alongside, so its pruning, settlement and redemption were not exercised on chain.
- **Raw source bodies are not published by the keeper.** The committed evidence has them; a live deployment would publish bundles only.

## Repository

| Path | What |
|---|---|
| `docs/SPEC.md` | The rules, version 0.5. The source of truth |
| `docs/AUDIT.md` | The independent review's record |
| `contracts/` | The NEAR contract `weir` and the test dollar `mock-usdc`, Rust, near-sdk 5.30.1 |
| `engine/` | The second implementation of the spec, TypeScript, no runtime dependencies |
| `vectors/` | Test cases written by the contract, reproduced by the engine |
| `index/` | The GPU price indexes: sources, method, bundles, verifier |
| `evidence/` | Recorded index bundles and their raw responses ([`evidence/README.md`](evidence/README.md)) |
| `chain/` | NEAR JSON-RPC client that signs its own transactions; NEAR Intents dry quotes |
| `agents/` | Trading strategies, the swarm runner and the simulation |
| `keeper/` | The scheduled job: index reports, agents, clearing, settlement, pruning |
| `deploy/` | Takes the contracts to testnet with reporters, agents and keys |
| `integration/` | The real wasm on a local NEAR node against the engine, call by call |
| `backtest/` | H100 price history and the week-ahead backtest |
| `web/` | The site, Next.js on Cloudflare Workers |

## Running it yourself

- **Deploy to testnet**: [`deploy/README.md`](deploy/README.md). `node deploy/src/cli.ts plan --network testnet` shows every account and transaction without sending anything.
- **The keeper**: [`keeper/README.md`](keeper/README.md). A Node loop or a Cloudflare Worker, with the keys `deploy` writes to `deploy/out/testnet/keeper.env`.
- **The site**: [`web/README.md`](web/README.md).

## About this entry

Built for the NEAR Hackathon (deadline 2026-11-14). Everything here was built in the hackathon window; the repository began on 2026-11-11. It enters four tracks:

- **AI Swarms**: a swarm of agents with four strategies makes the market, driven by one stateless `tick` that runs on the engine or on the chain.
- **Agent Economy**: agents buy and sell next week's GPU-hours for the people who use and own the GPUs, with dollars deposited for them.
- **Unstoppable DeFi**: fully paid positions, no liquidation, no owner, no upgrade method, settlement anyone can call.
- **AI Security & Defense**: agent keys bounded by the protocol and by two limits the agent cannot change, and an AI review whose findings are kept as tests.

The same author also entered Levee (https://github.com/qvkare/levee), an independent project that shares no code with this one.

Most of the code was written by AI coding agents under human direction.

## License

MIT
