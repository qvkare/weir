# Integration results

Run on 2026-11-12, Apple-silicon laptop, Node 22.23, near-sandbox 2.14.0 (protocol 88), the wasm
built by `contracts/build.sh` from the tree as it is (`weir.wasm` sha256 `376ca8f1…05a5`,
`mock_usdc.wasm` `2c1654c1…48a8`). Wall time 384 s: lifecycle 85 s, full book 34 s, keeper 263 s.
The full record is `out/run.json`.

## Verdict

**188 of 188 checks pass. The contract and the model agree on every return value, every event
and every view; they disagree on the wording of 20 panic messages.** `e2e` exits 1 because of
those 20 messages, as a parity difference must: nothing is waived.

- 860 state changes were made through `ChainWeir` and replayed on `ModelWeir` at the block time
  the contract ran them. 839 match exactly: same result (or same panic text) and the same
  NEP-297 log lines, byte for byte. The other 21 calls were refused by both, in different words.
- 1,504 view calls at 10 checkpoints (every view of SPEC section 12, including `get_results` and
  `get_prints` over their limits, never-opened series, unknown accounts and `commit_hash`)
  returned identical JSON from the contract and the model.

## What was proven

1. **Lifecycle through the client** (`src/lifecycle.ts`, 147 checks). Fast preset with only
   `usdc`, `reporters`, `t0` replaced (`get_params` returns exactly that). Token storage, faucet,
   registration (fee charged, no more), `ft_transfer_call` deposits (including one for another
   account), three reporters (quorum, the even-count median, a 25% move that needs all three, a
   repeat report on a final print returning `false`), a series opening on the print (anchor
   2.000, floor 1.700, band 0.600), six commits, a guard voiding a LONG at reveal, the clearing
   price 0.310 at the smallest |D − S|, forfeits of unrevealed and under-locked commits (0.02),
   mint and merge, ten prints in the delivery window, settlement (fixing 2.155, bonus 714 a side,
   8 carried), a transfer after settlement, redemption by third parties, pruning, a full
   withdrawal. Free balances, positions, `get_totals` and token balances asserted exactly at
   every step; `get_totals` summed equals the contract's token balance at 7 points.
2. **Parity**: above, and the table of messages below.
3. **Errors**: every refusal the spec names is refused by the contract and thrown by `ChainWeir`
   as an error carrying the contract's message: stale index (commit and mint), round is full,
   not enough prints yet, nothing to redeem (twice), a missing or extra yoctoNEAR (`withdraw`,
   `set_guard`, `transfer_position`, each with 0 and 2 yocto), an under-locked reveal, a
   wrong-hash reveal, an unregistered account (commit, set_guard, transfer target, deposit
   beneficiary, which keeps "0"). Plus 31 more: phases, double reveal/clear/settle/prune,
   non-owner reveal, bad hash/salt/bundle/bucket, report windows, non-reporter, self-transfer,
   a token that is not `usdc` (refunded in full, "0" kept), pending rounds at settlement.
4. **Agent keys**: an account whose only key is a function-call key for Weir limited to
   `AGENT_KEY_METHODS` (checked with `view_access_key_list`) committed, minted, merged, revealed,
   cleared, settled the series and redeemed. Refusals, as `ChainWeir` surfaces them (an
   `RpcError` thrown before any code runs):
   - `withdraw`, `set_guard`, `transfer_position`, `register`, and `deposit` (to the token):
     `INVALID_TRANSACTION … {"InvalidAccessKeyError":"DepositWithFunctionCall"}`. The client
     attaches 1 yocto (or the fee), and the node checks that before the method name.
   - `report`: `… {"InvalidAccessKeyError":{"MethodNameMismatch":{"method_name":"report"}}}`.
5. **Gas**: table below.
6. **Keeper and swarm**: below.
7. **Concurrency**: ten calls fired at once through one client landed in nonce order (10 of 10,
   consecutive nonces, seqs 0 to 9); two clients on one key, five calls each at once, got 5
   `InvalidNonce` replies, retried, and landed 10 of 10 with no duplicate; twenty accounts at once,
   20 of 20 in 0.39 s. Every call's effect was visible in a `final` view the moment it returned.
   64 commits, 64 reveals and 16 redemptions were also sent concurrently, then replayed on the
   model in the order the chain ran them.

## Parity: the 20 messages that differ

The contract's message is the `ERR_*` table in `contracts/README.md`; the model's is
`engine/src/market.ts`. 23 other refusals have identical text in both (`index is stale`, `round
is full`, `not enough prints yet`, `nothing to redeem`, `account is not registered`, …).

| Method | Contract | Model (`market.ts` line) |
|---|---|---|
| `withdraw` | `free balance is too low` | `balance is too low` (300) |
| `commit` | `free balance is too low` | `balance does not cover lock` (327) |
| `commit` | `not in a commit phase` | `series is not in a commit phase` (325) |
| `reveal` | `not in the reveal phase` | `round is not in its reveal phase` (371) |
| `reveal` | `revealed values do not match the hash` | `revealed order does not match the hash` (378) |
| `reveal` | `caller does not own this commit` | `commit belongs to another account` (367) |
| `mint` | `sets must be above zero` | `sets must be at least 1` (454, via `count`) |
| `merge` | `position is too small` | `not enough units to merge` (477) |
| `transfer_position` | `position is too small` | `not enough units to transfer` (495) |
| `transfer_position` | `cannot transfer a position to yourself` | `cannot transfer to yourself` (490) |
| `transfer_position` | `long + short must be at least 1` | `nothing to transfer` (493) |
| `transfer_position` | `account is not registered` | `receiver is not registered` (489) |
| `report` | `bucket must be a multiple of print_interval_secs` | `bucket is not a multiple of print_interval_secs` (513) |
| `report` | `outside the report window of this bucket` | `bucket is outside its report window` (515) |
| `settle` | `the report window of the delivery has not closed` | `report window of the delivery is still open` (561) |
| `settle` | `a round of the series is waiting to be cleared` | `series has rounds waiting to be cleared` (562) |
| `settle` | `series is settled` | `series is already settled` (559, 769) |
| `settle` (never-opened series) | `series not found` | `series is not open` (558, 768) |
| `redeem` (never-opened series) | `series not found` | `series is not settled` (605: the model has no unknown-series check) |
| `prune_result` | `result not found` | `no result for this round` (621) |

## Gas

Total gas burnt by the transaction and all its receipts, for every successful call this run
made (Tgas). "Attached" is `CALLS` in `chain/src/weir.ts` and `TOKEN_CALLS` in
`chain/src/token.ts`. No method has a margin under 2x; every one attaches more than 10x what it
burns. The least gas that still works was found by bisection for the two calls that reserve
static gas for further calls: `withdraw` needs 24 Tgas (it reserves 10 + 10), a deposit through
the test token 14 Tgas. With 6 Tgas a deposit fails loudly (`Exceeded the prepaid gas.`), not
as a silent "0".

| Method | Calls | Burnt min / median / max | Attached | Margin | Proposed |
|---|---|---|---|---|---|
| `clear`, 64 commits from 64 accounts, all filled | 1 | 25.50 | 300 | 11.8x | |
| `clear`, keeper's books (6 to 9 commits) | 25 | 4.17 / 4.57 / 4.92 | 300 | 61x | |
| `clear`, lifecycle books | 2 | 2.96 / 3.65 | 300 | 82x | |
| `clear`, 40 unrevealed commits | 1 | 6.98 | 300 | 43x | |
| `clear` (any book) | | | 300 | | **150** |
| `commit` | 274 | 2.59 / 2.67 / 3.60 | 50 | 13.9x | **10** |
| `reveal` | 231 | 2.47 / 2.54 / 3.33 | 50 | 15.0x | **10** |
| `report` | 79 | 2.22 / 2.29 / 2.73 | 50 | 18.3x | **10** |
| `redeem` | 27 | 2.48 / 2.49 / 2.52 | 50 | 19.8x | **10** |
| `mint`, `merge` | 2 + 2 | 2.60 to 2.65 | 50 | 19x | **10** |
| `transfer_position` | 1 | 2.49 | 50 | 20.1x | **10** |
| `prune_result` | 1 | 2.24 | 50 | 22.3x | **10** |
| `settle` | 3 | 2.32 / 2.32 / 2.33 | 100 | 42.9x | **10** |
| `register` | 76 | 2.19 / 2.20 / 2.23 | 30 | 13.5x | **10** |
| `set_guard` | 1 | 2.23 | 30 | 13.4x | **10** |
| `withdraw` | 1 | 6.74 (needs 24) | 100 | 14.8x | **50** |
| `deposit` (`ft_transfer_call`) | 78 | 6.60 / 6.61 / 6.85 (needs 14 on the test token) | 100 | 14.6x | **100, unchanged** |
| token `storage_deposit` | 9 | 1.91 / 1.94 / 1.95 | 30 | 15.4x | **10** |
| token `mint` | 16 | 2.01 / 2.03 / 2.04 | 30 | 14.7x | **10** |

Reasons for the proposals: 10 Tgas is at least 2.7x every simple method's worst case. `clear`
grows with the book: 25.5 Tgas at 64 commits here, 51.25 at 128 in the contract's own sandbox
test, and 128 is the most `max_commits` allows, so 150 covers any deployment with 2.9x. `withdraw`
at 50 is twice its floor. The deposit stays at 100 because the gas the official testnet USDC
needs for `ft_transfer_call` is not something the test token can tell us.

What over-attaching costs: measured here, a function-call key's allowance is charged about the
gas actually burnt (the first agent's key: 79 transactions, 257.7 Tgas burnt, 0.0240 NEAR of
allowance used, against 10,250 Tgas attached), so the generous figures do not drain agents'
allowances. A key must still hold at least the attached gas's price at submission (0.03 NEAR for
a 300 Tgas `clear` at the minimum gas price).

## Keeper and swarm

`runTick` from `keeper/` with its own `nearChain` (so its own `ChainWeir`, `NearAccount` and
metered fetch), default budget of 40 requests, an in-memory store, a lease clock that follows
chain time, three reporters, six agents (two buyers, two sellers, a maker, a noise trader) whose
only keys are function-call keys, and a fetch that serves `index/test/fixtures/` for the six
sources and refuses anything but the sandbox (nothing else was asked for). Three ticks per
five-minute round (20, 110 and 200 s in) from series 0's auction opening to its settlement and
redemption: 78 ticks, 406 transactions, every one also made on the model with no difference.

| | |
|---|---|
| Prints | final in all 25 buckets from the auction's opening to delivery end (52 reports) |
| Rounds of series 0 | 12 of 12 cleared, 12 traded, 306 GPU-hours; every commit revealed; zero forfeits |
| Settlement | normal (12 prints, fixing 2.760), settled by the first agent's function-call key |
| Redemption | all six agents, series 0 positions zero afterwards |
| Books | `get_totals` equals the contract's token balance and the agents' deposits |
| RPC calls per tick | median 17, 90th percentile 34, max 40 (the budget); 1,745 in all, plus 156 source fetches |
| Wall time per tick | median 2.6 s, 90th percentile 3.0 s, max 3.3 s (the twin's own replay: 23 ms a tick) |
| Budget | 27 of 78 ticks left work for the next tick (commits, or redemption), all done within the round |
| Store writes | 599 |
| Allowance used per agent | 0.006 to 0.024 NEAR for the series |

The wall times are for sandbox blocks of 0.06 s (about 0.3 s per transaction, waited to
`FINAL`). On testnet a transaction takes about 2 to 3 s to be final, so the busiest tick (8
transactions) would take some 20 to 25 s: inside the minute, not inside a few seconds.

## Findings

1. **Panic messages: spec ambiguity, fixed in the engine.** (Evidence: the 20 rows above, 21
   calls.) SPEC 0.3 quotes only a few messages (`index is stale`, `round is full`, `not enough
   prints yet`, `nothing to redeem`) and the two implementations, written independently, chose
   their own words for the rest. Both are faithful to the spec; neither is wrong by it. But
   `chain/README.md` promises that `CallFailed` carries "the same text `ModelWeir` throws", and
   code matches on these texts (finding 2), so they must be one set. Suggested fix: take the
   contract's `ERR_*` table (it is deployed code, documented in `contracts/README.md`), add it
   to the spec as the normative list, and change the 19 strings in `engine/src/market.ts` listed
   above to the contract's, plus a `series not found` check at the top of `redeem` (and of
   `pruneResult`) before `series is not settled`. Then this run has no differences.
2. **Keeper: a settle race on chain is logged as a failure. Classification: keeper.**
   `keeper/src/keeper.ts`, `const ALREADY = /commit is already revealed|round is already
   cleared|series is already settled/`, written against the model's text; the contract says
   `series is settled`. When another caller settles between the keeper's read and its
   transaction, the keeper counts an error instead of "done by another caller first". Not
   triggered in this run (the race needs a second settler); the evidence is the contract's
   message, measured above. Patch: `/commit is already revealed|round is already cleared|series
   is (already )?settled/`. The other texts the keeper and swarm match (`already reported`,
   `nothing to redeem`) are the same on chain.
3. **Chain client gas table: every figure is more than 10x the gas used. Classification: chain
   client.** Not dangerous (allowances are charged on gas burnt), but the table's comment calls
   the figures guesses to be replaced by measurements; the proposed column is that measurement.
4. **Chain client: function-call-key refusals are `RpcError`, not `CallFailed`, and read
   `DepositWithFunctionCall`. Classification: chain client, documentation.** Because `ChainWeir`
   always attaches the 1 yoctoNEAR, the node refuses the transaction for the deposit before it
   looks at the method name; the Rust test's `MethodNameMismatch` appears only without a deposit.
   The error is clear and nothing is sent, but code that tells a contract refusal (`CallFailed`)
   from a node refusal (`RpcError`) should know this; worth a line in `chain/README.md`.
5. **Keeper README is behind the spec. Classification: keeper, documentation.** It says SPEC
   section 15 limits an agent key to six methods without `settle` and that the first agent's key
   "must also allow settle". SPEC 0.3 and `AGENT_KEY_METHODS` include `settle`; the test settled
   with exactly those seven.
6. **`NearAccount` retries `InvalidNonce` once.** Two writers on one key were fine (5 collisions,
   all retried). Three or more concurrent writers could exhaust the single retry; the call then
   fails with a clear `InvalidNonce` error, never silently. Not tested with more than two; the
   keeper's lease is meant to keep it at one.
7. **Sandbox only: block production stalls at an epoch boundary.** With
   `max_block_production_delay` raised (to make fast-forwarding cheap), near-sandbox 2.14.0
   stopped producing blocks at the first block of an epoch after a few fast-forwards, twice
   (heights 361 and 2,041, epoch length 60). A one-million-block epoch avoids it. Test harness
   only; no effect on Weir.

No contract bug was found: no result, balance, event or view differs from the model, the
invariants held at every check, and the full round clears in 25.5 Tgas.

## Changes made in `chain/`

- `src/tx.ts`: `AnyTransaction` and `SetupAction` (create account, deploy contract, transfer, add
  a full-access or function-call key) and their borsh encoding; `encodeTransaction`,
  `encodeSignedTransaction` and `signTransaction` accept them. `Transaction` (function calls
  only) is unchanged, so nothing that uses it changes.
- `test/tx_actions.test.ts`: 200 random transactions mixing every setup action with function
  calls, encoded and signed byte-identically to `@near-js/transactions` 2.5.1; out-of-range
  deposit, allowance and key length refused.
- `README.md`: the two additions above, and a pointer here.

No bug in `chain/` was exposed: `ChainWeir`, `Token`, `NearRpc` and `NearAccount` worked
unchanged for every call, including the keeper's.

## What the sandbox cannot tell us about testnet

- **Latency.** Sandbox transactions were final in about 0.3 s; testnet takes seconds, and the
  `send_tx` timeout-then-poll path was never exercised here.
- **Rate limits and failover.** One local node, never busy: no HTTP 429, 5xx or node timeouts,
  so `NearRpc` failover and the keeper's charging of retries were not tested. The keeper made up
  to 40 requests a tick (median 17), roughly 1,000 to 1,300 an hour at one tick a minute for
  the fast market, which public RPC limits have to allow.
- **Real accounts.** Here `test.near` created every account and paid every fee. On testnet the
  agents, reporters and the contract need funded accounts (faucet), the registration fee, and
  function-call keys added by their owners.
- **The official token.** Every deposit here went through `mock_usdc` with its open `mint`. Real
  testnet USDC has no faucet `mint`, may require a different storage deposit, and its
  `ft_transfer_call` gas needs are unknown: the 100 Tgas deposit figure is unverified against it.
- **Gas price and protocol.** Gas price stayed at the minimum and the protocol is 88 as in this
  binary; allowance charging was measured only here.
- **Live index sources.** The keeper read saved fixtures; real responses, failures and their
  effect on reporting were not exercised.
- **Cloudflare.** The keeper ran in Node, not as a Worker: no CPU limit, KV or cron timing.

## Not done

- `pnpm --filter @weir/integration run e2e` does not work yet: `integration` must be added to
  the root `pnpm-workspace.yaml` (a root file I was not to change). `node integration/src/e2e.ts`
  and `pnpm --dir integration run e2e` work now.
- The weekly preset was not run; nor more than 32 live series (`get_status`'s limit); nor
  `withdraw_failed` through the client (the contract's own sandbox test covers it).
- No minimal-gas bisection for `clear` at 128 commits on this run; the 51.25 Tgas figure comes
  from `contracts/README.md`.
