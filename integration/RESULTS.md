# Integration results

Third run, **specification 0.6**, on 2026-11-12. `weir.wasm` sha256
`405832882376bcd26b7ee40e1e81635e1f807d47586d3d71879c45115aaf110c`, built by
`contracts/build.sh` from commit `5b17d66` ("Bring the contract and the engine to
specification 0.6"; the same bytes as the working tree before that commit), `mock_usdc.wasm`
`3838da4a…1b8a`. The engine's own tests passed with every vector before the run. Apple-silicon
laptop, Node 22.23, near-sandbox 2.14.0 (protocol 88). `pnpm --filter @weir/integration run e2e`
**exited 0 in 549 s** (lifecycle 121 s, void series 32 s, full book 51 s, keeper 343 s). Record:
`out/run.json`.

## What a reader may conclude, and what not

**May conclude:** the contract that will be deployed (these exact bytes) and the TypeScript
engine implement specification 0.6 identically, on every call this run made: 1,315 state changes
and 2,315 view calls, refusals included, with no difference at all. The chain client, the
agents and the keeper drive that contract correctly with the function-call keys a testnet
deployment will use, on two markets at once, through whole series, without a failed entry. The
gas the client attaches suffices for every method, with at least 2x to spare, including the
largest rounds the contract allows.

**May not conclude:** anything about a public network. This was one local node, quiet, with
blocks every 0.06 s and transactions final in about 0.3 s, a test token with an open faucet,
accounts created and funded by the sandbox's root account, saved index responses instead of
live sources, and the keeper run as a Node loop. Latency, RPC limits and failover, the real
USDC's `ft_transfer_call`, gas-price movements, funding and key handling by real operators,
live index sources and Cloudflare's limits are untested. It also says nothing about whether
the rules are economically sound; the audit addresses that, not this test.

## Results

**264 of 264 checks pass. Parity is total:** every return value, every NEP-297 event (byte for
byte), every view and every refusal text (61 refused calls, 52 distinct method and message
pairs) are identical on the contract and the model, at the block time the contract ran each
call.

1. **Lifecycle** (178 checks): as in the second run (commit fee of 0.10 on every commit, kept
   by a void order, the round lock limit, a guard changed after commit having no effect, every
   way a bucket is decided, `prune_result` and `prune_print` releasing 234 and 348 bytes of
   contract storage, exact balances at every step, the function-call-key agent), now with the
   0.5 series fields: the series records `traded_units` 12 and `traded_value` 3.68.
2. **Void series** (15 checks, `src/voids.ts`):
   - **Majority quorum.** `new` with a quorum of 1 of 3 reporters is refused on chain with
     `quorum must be a majority of the reporters`; the engine refuses the same parameters with
     the same text; nothing is deployed.
   - **A series that traded in several rounds at different prices, then a wash round.** A buys
     LONG from B: 10 at 0.30, 5 at 0.36, 4 at 0.24; then A trades 5 with itself at 0.59, the
     most extreme price it could reach. The series records `traded_units` 24 and
     `traded_value` 8.71. No delivery prints: `not enough prints yet`, then, after
     `void_after_secs`, void: **long and short payout both exactly 0.30, half the band**,
     fixing 2.00. A (paid 5.76 for 19 LONG) gets 5.70; B (paid 5.64 for 19 SHORT) gets 5.70;
     the wash round returns exactly what it cost; a minter of 3 sets gets 1.80 back. Balances
     exact to the micro-dollar, eight fees burned, `get_totals` equal to the token balance.
   - **A series with only mints:** void, half the band each side, the minter whole.
3. **Full book at 128 commits** (36 checks): the fast preset with `max_commits` 128, the most the
   contract allows. 128 commits from 128 accounts; an equal lock refused (`round is full`); a
   larger one evicts the latest of the smallest and returns its lock and fee; 128 reveals; a
   clear of 128 fills in 50.48 Tgas; the 128 fees burned. The cap on sets reached with real test
   money, one more refused (`too many sets`). Concurrency: ten calls through one client in nonce
   order; two clients on one key, 5 `InvalidNonce` replies, all retried, 10 of 10 landed, none
   twice; twenty accounts at once. A void settlement after an unrevealed round.
4. **Keeper** (35 checks), below.

## Keeper, two markets, as a testnet deployment

`runTick` from `keeper/`, its own `nearChain`, default budget of 40 requests, on `h100-fast`
and `h200-weekly` together for the whole run (108 ticks, three per five-minute round, three
periods of the fast market). Keys exactly as on testnet: the **three shared reporters** each
hold a `REPORTER_KEY_METHODS` key on each contract (`keys: { contract: key }`); six agents on
the fast market and three on the weekly one each hold one `AGENT_KEY_METHODS` key; **one
housekeeping account** holds a `KEEPER_KEY_METHODS` key on each contract. Index responses from
the index package's per-chip fixtures; any other request is refused (none was made).

| | |
|---|---|
| Fast market | final prints in all 25 buckets from its auction's opening to delivery end; 12 of 12 rounds of series 0 cleared, zero forfeits; settled normally (12 prints, fixing 2.90) and every agent redeemed |
| Missing reporter | one reporter left out for a bucket: two reports, decided by the housekeeping account's `finalize_print` |
| Second market | its rounds cleared every time by the housekeeping account's own key for that contract (2 clears, every one ok and signed by it); no round that is over left uncleared; H200 prints from its chip's bundle |
| Wrong receiver, driven deliberately | an extra agent of the weekly market listed with a key whose receiver is the fast contract: refused with `ReceiverMismatch`, **one** logged fault naming the fix, then nothing until the hour it is set aside has passed (attempts at 710, 4,310 and 7,910 s: one an hour), no transaction ever landed, no other entry failed |
| Fees | on both markets `burned` equals the keeper's own cost report (fast 15.60, weekly 0.40), and on the fast market `burned` plus the fees still held equals 0.10 x its agents' 159 commits |
| Storage | fast: 24 prunes (12 `prune_print`, 12 `prune_result`), each releasing 130 to 440 bytes; the contract grew 8,610 bytes in the first hour and 131 bytes in the last, when pruning kept pace (assertion: under 1% an hour). Weekly: grew about 1,900 bytes over the run and could not be pruned in it, by the rules: prints become prunable two weeks after their bucket and results once the series settles, a week on |
| Budget | both markets spent from one budget in all 108 ticks; RPC calls per tick median 33, 90th percentile 35, max 40 (the budget, reached in 39 ticks); 2,900 RPC calls and 252 index requests in all |
| Wall time per tick | median 2.2 s, 90th percentile 3.0 s, max 5.0 s, at about 0.3 s per transaction |
| Books | `get_totals` equal to each contract's token balance; the fast agents' deposits all accounted for |

## Gas against `GAS_TGAS`

Total gas burnt by the transaction and all its receipts, every successful call of the run.
No margin is under 2x; the two worst cases the second run could not reach are now measured.

| Method | Calls | Burnt min / median / max (Tgas) | `GAS_TGAS` | Margin |
|---|---|---|---|---|
| `commit` | 351 | 2.78 / 2.97 / 4.70 | 15 | 3.19x |
| `commit`, evicting from a full round of **128** | 1 | 5.09 | 15 | 2.95x |
| `reveal` | 309 | 2.42 / 2.51 / **4.61** (into a book of 128) | 10 | **2.17x** |
| `clear`, **128** commits all filled | 1 | 50.48 | 150 | 2.97x |
| `clear`, keeper's books | 36 | 2.83 / 3.96 / 5.00 | 150 | 30x |
| `settle`, deciding 2 pending buckets | 1 | 3.13 | 15 | 4.8x |
| `settle`, nothing pending | 4 | 2.33 / 2.33 / 2.36 | 15 | 6.4x |
| `report` deciding / not deciding | 51 / 111 | max 2.89 / 2.35 | 10 | 3.46x / 4.26x |
| `finalize_print` | 3 | max 2.61 | 10 | 3.84x |
| `prune_print`, `prune_result` | 14, 13 | max 2.43, 2.35 | 10 | 4.1x |
| `mint`, `merge`, `redeem`, `register`, `set_guard`, `transfer_position` | | max 2.73 | 10 | ≥3.67x |
| `withdraw` | 1 | 6.77 (needs 24, bisected) | 50 | 7.4x |
| `deposit` (`ft_transfer_call`) | 151 | max 6.86 (needs 14 on the test token) | 100 | 14.6x |
| token `storage_deposit`, `mint` | 11, 17 | max 2.05 | 10 | 4.9x |

`settle` deciding about six pending buckets could not be produced, and cannot be with every
bucket reported: each `report` decides up to four earlier buckets whose windows have closed,
and only the previous bucket's window is still open when a report comes, so at most two are
pending when `settle` runs (this run's lifecycle shows it: the reports in B8 decided B6, and so
on). Deciding a bucket costs about 0.4 Tgas; six would be about 4.7 Tgas, 3.2x under 15.

## Findings

1. **Chain client gas: `reveal` at 2.17x. Classification: chain client.** A reveal into a round
   of 128 commits burned 4.61 Tgas against 10. Still over 2x, so not failing, but the thinnest
   margin in the table; propose 15, as `commit` now has. Everything else is between 2.95x and 7x
   (the deposit 14.6x, deliberately, for the unmeasured real USDC).
   Done after this run: `GAS_TGAS.reveal` is 15 in `chain/src/weir.ts` (3.25x of the 4.61 Tgas
   measured here). The table above shows the run as it was, with 10.
2. **Sandbox only:** the harness's settings still need the one-million-block epoch to avoid the
   stall of the first run. A second run of `e2e` on the same machine (another session's) held
   port 33031 during this work; the harness now takes the first free port pair and
   `WEIR_E2E_OUT` keeps two runs' records apart.

No contract, engine, agents or keeper finding. The second run's keeper finding is closed:
per-contract keys work on two markets, a wrong key is logged once and set aside, and the
second market is housekept by its own key.

## Changes made in `chain/`

None in this run.

## Not done

- `settle` with six pending buckets (explained above: unreachable with every bucket reported).
- The weekly market ran 2.6 hours of its week: its pruning, settlement and redemption were not
  exercised on chain (they were on the fast market).
- Two markets, not four; no live index source; no public network.

## Second run, specification 0.4

449 s; 238 of 239 checks; 995 calls and 1,542 views identical, refusals included. The one
failure was a keeper bug: a single housekeeping key could not reach a second market's contract
(`ReceiverMismatch` on every turn, the round never cleared); fixed since with one key per
contract. Gas: `commit` at 2.44x (an eviction at 64 commits) and `settle` at 32x, both set to 15
since. With the keeper on one market the run passed in 436 s.

## First run, specification 0.3

384 s: 188 of 188 checks; 860 calls and 1,504 views with identical results, events and views;
20 refusal texts differed between engine and contract (since made one table, spec section 16).
Other findings then: the keeper's "already settled" pattern, every gas figure over 10x (the
table was then set from the measurements), the keeper README behind the spec, `NearAccount`
retrying a nonce only once, the sandbox's epoch stall. `chain/` gained `AnyTransaction` and the
account-setup actions in `src/tx.ts`, tested against `@near-js`.
