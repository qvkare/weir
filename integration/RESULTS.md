# Integration results

Second run, specification 0.4, on 2026-11-12: Apple-silicon laptop, Node 22.23, near-sandbox
2.14.0 (protocol 88), the wasm rebuilt by `contracts/build.sh` from the tree at commit
`ceaec38`. Wall time 449 s: lifecycle 96 s, full book 37 s, keeper 314 s. The full record is
`out/run.json`.

## Verdict

**238 of 239 checks pass. The contract and the model agree on everything: every return value,
every event (byte for byte), every view, and now every refusal text.** The one failing check is
a keeper finding (below, finding 1): with a second market, the single housekeeping key cannot
reach the second contract. `e2e` therefore exits 1. With the keeper on `h100-fast` alone
(`WEIR_E2E_SECOND=0`) the same run has no failure; see "One market" at the end.

- 995 state changes went through `ChainWeir` and were replayed on `ModelWeir` at the block time
  the contract ran them: every one matches. That includes 60 refused calls, compared word for
  word with no exceptions (52 distinct method and message pairs).
- 1,542 view calls at 10 checkpoints (every view of section 12, `get_pending_prints` and
  `get_print.state` included, limits exceeded, unknown series and accounts, pruned buckets)
  returned identical JSON from the contract and the model.

## What was proven

1. **Lifecycle** (`src/lifecycle.ts`, 177 checks), fast preset with only `usdc`, `reporters`
   and `t0` replaced. Exact free balances, positions, totals and token balances at every step;
   `get_totals` equal to the contract's token balance at 7 points; at the end every dollar
   deposited is free or burned (2,600,000,000 = 2,599,820,000 + 180,000).
   - **Commit fee**: 0.02 taken with every commit (`get_round` shows it per commit); a lock
     equal to the free balance is refused because the fee must fit too; the round's 6 fees
     burned at clearing with the 0.02 of forfeits (`burned` 140,000), the agent's 2 later.
   - **Void order keeps its fee**: Eve's LONG voided at reveal; her lock came back at once,
     her 0.02 did not.
   - **Guard fixed at commit**: Eve widened her guard from 0.005 to 0.05 after committing
     (enough to pass at reveal); the order was still void, by the guard and reference recorded
     at commit.
   - **Round lock limit**: Bob's `max_round_lock` of 2.00, holding 1.50, a further 1.00 refused
     with `over the round lock limit`; with a lock above his balance the balance is refused
     first, the order section 6.2 gives.
   - **Every way a bucket is decided**: by all three reporters (the two first reports return
     `false`); two reports agreeing within 2% decided by `finalize_print` after the window
     (mean 2.010; refused while open, refused twice, refused with no reports); two agreeing
     decided by a later report (events `report`, then `print` of the earlier bucket); two 10%
     apart decided by `finalize_print` as `NoPrint`; one report below quorum decided by a
     later report as `no_print`; two pending buckets decided by `settle` (events `print`,
     `print`, `settle`; `get_pending_prints` empty afterwards). Fixing 2.097 on 10 prints.
   - **Pruning releases storage**: `prune_result` freed 234 bytes of the contract's storage,
     `prune_print` 348 for a final print and some for a `NoPrint` one; pruned buckets read
     null; the last print and the accumulator are unchanged. Refused too early, with no
     reports, and on an undecided bucket.
   - No bonus: payouts are `long_payout` and `short_payout` only.
2. **Parity**: above.
3. **Errors**: every refusal the spec names, as before (stale index, round is full, not enough
   prints yet, nothing to redeem, a missing or extra yoctoNEAR, under-locked and wrong-hash
   reveals, unregistered accounts), plus the new ones: `over the round lock limit`, `too many
   sets`, `the report window of this bucket has not closed`, `bucket has no reports`, `bucket
   is already decided`, `bucket is not decided`, `a print can be pruned two periods after its
   bucket`.
4. **Agent key**: an account whose only key holds `AGENT_KEY_METHODS` committed, minted,
   merged, revealed, cleared, settled (deciding two buckets) and redeemed. Refused before any
   code runs: `withdraw`, `set_guard` (with `max_round_lock`), `transfer_position`, `register`
   and `deposit` with `DepositWithFunctionCall` (the client attaches 1 yocto or the fee);
   `report`, `finalize_print`, `prune_print`, `prune_result` with `MethodNameMismatch`.
5. **Full book** (`src/fullbook.ts`, 36 checks): 64 commits from 64 accounts; a 65th with an
   equal lock refused (`round is full`); a larger one evicts the latest of the smallest, and the
   `evict` event and the balance show **lock and fee returned**; 64 reveals, a clear of 64 fills
   (25.68 Tgas) burning the 64 fees and nothing else. **The cap on sets**: minting exactly up to
   the cap passes the cap check and stops at the balance; with 5.4e21 micro-dollars of test
   money one account then minted 9,007,199,247,060,991 - 320 sets, `open_sets` reached the cap
   (2^53 - 1 less 64 x 10,000 x 12), one more set was refused with `too many sets`, positions
   stayed safe JSON integers, and the series still settled void and redeemed. Concurrency as
   before. A series with no delivery prints: `not enough prints yet`, then void at floor +
   band/2.
6. **Keeper**: below.
7. **Concurrency**: ten calls at once through one client landed in nonce order (consecutive
   nonces, seqs 0 to 9); two clients on one key, five calls each: 5 `InvalidNonce` replies,
   all retried, 10 of 10 landed, none twice; twenty accounts at once, 20 of 20 in 0.39 s.

## Gas

Total gas burnt by the transaction and all its receipts, every successful call of the run,
against `GAS_TGAS` in `chain/src/weir.ts` (and `TOKEN_CALLS`). No margin is under 2x.

| Method | Calls | Burnt min / median / max (Tgas) | `GAS_TGAS` | Margin | Proposal |
|---|---|---|---|---|---|
| `commit` | 296 | 2.77 / 2.96 / **4.11** (an evicting commit into a full round) | 10 | 2.44x | **15** |
| `reveal` | 249 | 2.41 / 2.51 / 3.50 | 10 | 2.86x | 10 |
| `clear`, 64 commits, all filled | 1 | 25.68 | 150 | 5.84x | 150 |
| `clear`, keeper's books | 27 | 3.42 / 4.66 / 5.05 | 150 | 29.7x | 150 (sized for 128) |
| `clear`, 40 unrevealed commits | 1 | 7.10 | 150 | 21x | |
| `report`, deciding a bucket | 39 | 2.53 / 2.74 / 2.89 | 10 | 3.46x | 10 |
| `report`, not deciding | 87 | 2.24 / 2.31 / 2.34 | 10 | 4.27x | 10 |
| `finalize_print` | 3 | 2.26 / 2.46 / 2.61 | 10 | 3.84x | 10 |
| `settle`, deciding 2 pending buckets | 1 | 3.12 | 100 | 32x | **15** |
| `settle`, nothing pending | 2 | 2.32 / 2.35 | 100 | 42.6x | |
| `prune_print` | 6 | 2.22 / 2.43 / 2.43 | 10 | 4.12x | 10 |
| `prune_result` | 13 | 2.30 / 2.34 / 2.34 | 10 | 4.27x | 10 |
| `mint`, `merge` | 3 + 2 | 2.61 to 2.70 | 10 | 3.7x | 10 |
| `redeem` | 28 | 2.49 / 2.50 / 2.54 | 10 | 3.93x | 10 |
| `register` | 79 | 2.20 / 2.21 / 2.25 | 10 | 4.45x | 10 |
| `set_guard` | 3 | 2.25 / 2.26 / 2.26 | 10 | 4.43x | 10 |
| `transfer_position` | 1 | 2.50 | 10 | 4.0x | 10 |
| `withdraw` | 1 | 6.77 (needs 24, bisected) | 50 | 7.4x | 50 |
| `deposit` (`ft_transfer_call`) | 82 | 6.62 / 6.62 / 6.86 (needs 14 on the test token) | 100 | 14.6x | 100 (real USDC unmeasured) |
| token `storage_deposit`, `mint` | 10, 17 | 1.91 to 2.05 | 10 | 4.9x | 10 |

`commit` is the one figure to raise: an evicting commit scans the round for its smallest lock,
and at 64 commits that already burns 4.11 Tgas; at the 128 the contract allows it will burn more
(not measured here), and 10 would fall below 2x. `settle` deciding buckets costs about 0.4 Tgas
a bucket over the 2.3 base, and `contracts/README.md` bounds what it can meet at about 6, so 15
covers it with room; 100 is 32x. Allowances are charged about the gas burnt (the housekeeping
key: 0.016 NEAR for the series; the busiest agent 0.027), so the high figures cost nothing but
headroom.

## Keeper

`runTick` from `keeper/` (commit `01f30a7`), its own `nearChain`, default budget 40, an
in-memory store, a lease clock following chain time. Market `h100-fast` from `MARKETS` (its
parameters checked equal to the preset), three reporters with `REPORTER_KEY_METHODS` keys, six
agents (two buyers, two sellers, a maker, a noise trader) whose only key holds
`AGENT_KEY_METHODS`, a housekeeping account whose only key holds `KEEPER_KEY_METHODS`, a fetch
serving the index package's per-chip fixtures and refusing everything else (nothing else was
asked for). Three ticks per five-minute round from series 0's auction opening to two periods
after it, 84 ticks, 509 transactions, every fast-market transaction replayed on the model with
no difference.

| | |
|---|---|
| Prints | final in all 25 buckets from the auction's opening to delivery end, all 12 delivery buckets counted |
| Missing reporter | the third reporter left out for one bucket: two reports, decided by the housekeeping account's `finalize_print` once the window closed |
| Rounds of series 0 | 12 of 12 cleared, zero forfeits, every commit revealed |
| Settlement | normal, 12 prints, fixing 2.900 (the fixtures' H100 index), settled by the housekeeping key |
| Redemption | all six agents, positions zero |
| Fees | `burned` (3,360,000) equals the fees of every cleared round, equals the keeper's own cost report (fees + forfeits), and with the fees still held in open rounds equals 0.02 x the 175 agent commits |
| Pruning | 12 `prune_result` (each freed 239 to 440 bytes) and 4 `prune_print` (348 bytes each), every one releasing contract storage |
| Books | `get_totals` equals the contract's token balance and the agents' deposits |
| RPC calls per tick | median 27, 90th percentile 34, max 40 (the budget) in 31 of 84 ticks; 2,187 in all, plus 186 source fetches |
| Wall time per tick | median 2.9 s, 90th percentile 3.0 s, max 4.5 s, at about 0.3 s per transaction |

**Two markets sharing the budget.** For the first 90 minutes an `h200-weekly` market (another
chip, its own three reporters and three agents, the same keeper) ran alongside: 64 ticks spent
the one budget on both (for example 23 requests for `h100-fast`, 10 for `h200-weekly`, 7 for the
index), the weekly market acted on its own minute, got H200 prints from its chip's bundle, and
its agents committed and revealed. Its rounds were never cleared: finding 1.

## Findings

1. **Keeper: one housekeeping key cannot serve two markets. Classification: keeper.**
   Evidence: with `KEEPER` set, the keeper signs `clear`, `settle`, `finalize_print` and the
   prunes for every market with that one account. A function-call key names one receiver, so a
   key holding `KEEPER_KEY_METHODS` for `weir-h100-fast` is refused on `weir-h200-weekly`:
   `INVALID_TRANSACTION … {"ReceiverMismatch":{"ak_receiver":"weir-h100-fast.test.near",
   "tx_receiver":"weir-h200-weekly.test.near"}}`, 7 times (every turn after the round ended,
   2 requests each), and the weekly market's round was never cleared or settled. The README asks
   for "a function-call key for `KEEPER_KEY_METHODS` on each market's contract", which one
   secret key cannot be. The same holds for an agent configured for several markets (the
   default of `markets` is all of them): its one key reaches one contract. Not run here; the
   agents were given one market each. Suggested fix: let `KEEPER` (and each agent) name its
   markets, or take one entry per market (`{ "h100-fast": {account_id, secret_key}, … }`), use
   the housekeeper only where its key's receiver is the market's contract, and fall back to the
   first agent and first reporter elsewhere, as without `KEEPER`; and treat
   `ReceiverMismatch` as a configuration error logged once, not retried every turn.
2. **Chain client gas: `commit` at 2.44x. Classification: chain client.** Measured above;
   propose 15 Tgas. `settle` at 100 is 32x what deciding two buckets costs; propose 15.
3. **Sandbox only:** the epoch-boundary stall of the first run still applies to the harness's
   settings and is still avoided with a one-million-block epoch.

No contract, engine or agents finding: no result, event, view or refusal differs, every
invariant checked held, and the audit's rules (fee, burn, guard at commit, round lock, the cap,
the index rules, pruning) behave on chain as the spec says.

The first run's findings are closed: refusal texts are identical (the engine now uses the
contract's `ERR` table); the keeper's "already settled" pattern and README were fixed by its
agent (not exercised here: no other caller settled first); `GAS_TGAS` follows the measurements;
`NearAccount` retries `InvalidNonce` three times (two writers: 5 collisions, all retried).

## Changes made in `chain/`

None in this run. (First run: `AnyTransaction` and the setup actions in `src/tx.ts`, with
`test/tx_actions.test.ts` against `@near-js`.)

## What the sandbox cannot tell us about testnet

Latency (transactions here were final in about 0.3 s; testnet takes seconds, so a 7-transaction
tick takes 15 to 25 s, and the `send_tx` timeout path was never taken); RPC rate limits and
failover (one quiet local node; the keeper asks up to 40 requests a minute); real accounts and
funding (here `test.near` paid for everything); the official USDC (no `mint`; its
`ft_transfer_call` gas and storage are unmeasured); gas price movements; live index sources;
Cloudflare's CPU, KV and cron behaviour.

## Not done

- `commit` and `settle` gas at their worst cases (128 commits; six pending buckets) were not
  measured: the fast preset holds 64 commits and the run left at most two buckets for `settle`.
- The weekly preset was not run through a whole series; the second market ran 90 minutes.
- An agent configured for two markets with one key (finding 1) was reasoned, not run.

## One market

`WEIR_E2E_SECOND=0` runs the keeper on `h100-fast` alone; everything else is identical.
That run, right after the two-market one: **235 of 235 checks passed, `e2e` exited 0**, 977
calls and 1,542 views compared with no difference, the keeper 84 ticks and 490 transactions with
no failed entry, 436 s in all. `out/run.json` keeps the two-market run.

## First run, specification 0.3

2026-11-12, 384 s: 188 of 188 checks passed; 860 calls and 1,504 views compared, results,
events and views identical; 20 refusal texts differed (engine against contract, since made one
table, spec section 16). Findings then: the refusal texts (spec ambiguity), the keeper's
`series is already settled` pattern, every gas figure over 10x (the table was then set from the
measurements), function-call-key refusals arriving as `RpcError`, the keeper README behind the
spec on `settle`, `NearAccount` retrying a nonce only once, and the sandbox's epoch stall. The
keeper ran one fast series in 78 ticks (406 transactions, RPC calls per tick median 17, max 40;
median 2.6 s a tick); `clear` of a full 64-commit round burned 25.5 Tgas.
