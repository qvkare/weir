# Weir contract: review record

## Who did this, and what it is

An AI reviewer (Claude, an Anthropic model) that did not write the contract reviewed it in
two passes on 2026-11-12:

- the first pass against specification 0.3;
- the second pass against specification 0.4, after the authors changed the rules in
  response to the first pass.

The reviewer worked from `docs/SPEC.md`, the Rust source, and tests it wrote itself.

This is **not** an audit by a security firm. It is **not** a formal verification. No
person has signed it off. A finding that is absent here means only that the reviewer
did not find it within the scope and time below. It does not mean the problem is absent.

## Scope

**In scope:**
- `contracts/weir/src/` (all files), checked against `docs/SPEC.md`.
- `contracts/mock-usdc/src/lib.rs`, only for what would break tests or mislead a reader.

**Out of scope:**
- the TypeScript packages (`engine/`, `chain/`, `agents/`, `keeper/`, `web/`, `integration/`);
- the reporters' off-chain code and their data sources;
- any real token contract;
- NEAR protocol behaviour beyond what near-sdk 5.30.1 documents;
- the economic behaviour of real participants;
- deployment and key management.

## Method

1. Read the specification and every source file in full, in both passes.
2. Followed every path that moves dollars, by hand, against the five running totals behind
   `get_totals`.
3. Wrote unit tests that drive the contract through its public methods in near-sdk's mocked
   VM. Each call runs like a transaction: a panic rolls the state back. A test either
   demonstrates an attack or checks that a fix holds.
   - First pass: `contracts/weir/tests/audit_findings.rs`. Its authors later rewrote it to
     assert that each first-pass attack now fails.
   - Second pass: `contracts/weir/tests/audit2_findings.rs`.
4. The real wasm was **not** run for this review. The sandbox and integration runs in the
   repository were made by the authors. Gas figures for anything other than `clear` were not
   measured.

## Findings

Severity:
- **Critical**: funds can be stolen or frozen for good.
- **High**: a market can be stalled, or users can lose money under realistic conditions.
- **Medium**, **Low**, **Note**: lesser problems, in that order.

Numbers use the `weekly` preset in `agents/src/presets.ts`: 2 of 3 reporters, `max_spread_bps`
200, `forfeit_bps` 100, `commit_fee` 0.02 $, `max_commits` 64, 168 hourly rounds.

### First pass (spec 0.3)

| # | Severity | Finding | Status | Test |
|---|---|---|---|---|
| 1.1 | Critical | With 2 of 3 reporters the "median" of two reports was their mean. One reporter who reported first moved each print by up to `max_move`, and the moves compounded: 2.00 became 8.09 in 10 buckets. | Fixed in 0.4: no move rule, and a full set of reports gives the median. Residual: 2.1 and 2.2 below. | `audit_findings.rs::audit_one_reporter_can_no_longer_steer_the_index` |
| 1.2 | High | After a move larger than `max_move`, every print needed every reporter. One silent reporter froze the index, and no series could open. | Fixed in 0.4: no move limit. Residual: 2.2. | `audit_a_silent_reporter_can_no_longer_freeze_the_index` |
| 1.3 | Critical on testnet | Minting `u64::MAX` sets made every `clear` that traded overflow. The series could never settle, and locks were frozen. | Fixed in 0.4: `mint` cap. Residual: 2.6. | `audit_open_sets_can_no_longer_overflow` |
| 1.4 | High | A function-call agent committed a guarded account's whole balance and never revealed. A confederate holding open sets collected the forfeits. | Partly fixed in 0.4: forfeits are burned, so nobody profits. Destruction is bounded only if the owner sets `max_round_lock` (2.4). | `audit_function_call_agent_can_no_longer_drain_a_guarded_account` |
| 1.5 | High | Evicting every rival from a round cost nothing. | Partly fixed in 0.4: each slot costs `commit_fee`. Open at preset values (2.3). | `audit_eviction_griefing_now_costs_a_fee_per_slot` |
| 1.6 | Medium | The guard could be changed between commit and reveal, which cancelled an order for free after seeing others' reveals. | Fixed in 0.4: the commit records the guard and the reference. | `audit_guard_change_after_commit_no_longer_cancels` |
| 1.7 | Medium | Finalizing bucket B+1 first let a quorum put any price into bucket B. | Fixed in 0.4: nothing compares a print with earlier prints. | `audit_reporting_out_of_order_no_longer_bypasses_anything` |
| 1.8 | Medium | The contract paid for storage that grew without bound (prints, results) and could not charge it back. | Partly fixed in 0.4: results keep only filled orders, and anyone may call `prune_print` and `prune_result`. Accepted in spec 14: nobody is paid to prune or to top up NEAR. | `audit_storage_bytes_per_object_and_pruning` |
| 1.9 | Note | Missing parameter checks; `prune_result` emitted no event; the bonus/carry pool could be captured by minting; the mock token had an unchecked `+=`. | Fixed in 0.4: the bonus pool is removed, the event is added, the mock uses checked arithmetic. Checks were added but are incomplete (2.7). | none |
| 1.10 | Note | Public, sequential reveals give a last look to anyone willing to abandon a commit. | Open; cost in 0.4 is `forfeit_bps` of the lock plus `commit_fee` (2.5). | `audit2_a_non_reveal_changes_another_accounts_fill` |

### Second pass (spec 0.4)

| # | Severity | Finding | Status | Test |
|---|---|---|---|---|
| 2.1 | High | When one honest reporter is absent, the other honest reporter and one dishonest reporter decide every bucket together. The dishonest one cannot move a print by more than `max_spread/2`, but it chooses which buckets print: it agrees where the price suits it and disagrees elsewhere. The fixing averages only the printed buckets. In the test the true average was 2.000; the fixing was 2.121 (10 of 20 buckets printed), and LONG was paid 0.321 instead of 0.200 per unit. This contradicts spec 9 and 15 ("cannot steer"). | Open | `audit2_findings.rs::audit2_one_reporter_selects_which_buckets_print` |
| 2.2 | High | Same condition: the dishonest reporter disagrees in every bucket. The series has no prints and settles void at mid-band whatever the price did. With the true price at the band top, LONG was paid 0.200 instead of 0.400. With the preset this needs 43 of 168 buckets without a third reporter. | Open; spec 15 acknowledges that a reporter can push a series toward void | `audit2_one_reporter_forces_the_void_fixing` |
| 2.3 | High | Blocking a round costs `max_commits * commit_fee`, which is 1.28 $ a round at the preset (about 215 $ a week), plus capital larger than the largest honest lock for one round. Blocked bidders get their locks and fees back. | Open; spec 15 accepts blocking as possible | `audit2_blocking_a_round_costs_1_28_dollars` |
| 2.4 | Medium | `max_round_lock` defaults to unset. An account that sets only a guard can still have its balance destroyed by a function-call agent, at 1% plus the fee per round: 100 $ fell to 90.25 $ in 10 rounds. | Open (by default) | `audit2_agent_still_burns_an_account_without_a_round_limit` |
| 2.5 | Medium | Invariant 6 is false as written. Whether Bob reveals decided whether Charlie traded (10 units at 0.225 against none) and what Alice paid. If one person controls both accounts, not revealing is an option priced at 1% plus the fee. Burning stops anyone from profiting from the forfeited dollars, not from the change in clearing. | Open (spec wording) | `audit2_a_non_reveal_changes_another_accounts_fill` |
| 2.6 | Low | On testnet (open faucet), one account can mint the whole cap. Every later `mint` in that series is then refused. Auctions still clear. | Open | `audit2_one_account_can_take_the_whole_mint_cap` |
| 2.7 | Medium | `new` still accepts parameters that undo the index rules: `quorum` 1 (one reporter alone printed 100× the price), quorum below a majority, an even number of reporters, `max_spread_bps` up to 10000, zero fee with zero forfeit (blocking is free), and `report_grace_secs = period_secs`. | Open | `audit2_dangerous_parameters_are_accepted` |
| 2.8 | Low | With a large `report_grace_secs`, up to `period/interval + 2` buckets can be pending at once. That list sits in the root state and is read on every call. `settle` decides every pending bucket of its window in one call, which can grow past what one call can do. Anyone can recover by calling `finalize_print` bucket by bucket. | Open; found by reading, not measured | none |
| 2.9 | Low | `prune_print` may delete the reports of a series' delivery buckets before that series settles, because settlement can be called arbitrarily late. The reports then survive only in transaction logs. | Open; found by reading | none |
| 2.10 | Note | The guard reference is the last print at commit time, with no age check. When only two reporters report, a bucket is decided only after its window closes, so the reference lags by one or two intervals. | Open; found by reading | none |
| 2.11 | Note | `get_prints` scans at most 4096 words of 64 buckets from the first print ever made. After old prints are pruned, it can return nothing although later prints exist, if they are more than 262,144 buckets later. | Open; found by reading (view only) | none |

## Examined and found sound

These were checked by reading. Some are also covered by the authors' property tests or by the
review tests named.

- **Dollar accounting on every path.** The paths: deposit, withdraw and its callback (credits back only on `Failed`, once), commit lock plus fee, eviction refund of lock and fee, void refund of the lock with the fee kept, clear (released equals refunds plus forfeits plus fees plus `V*·band`), mint, merge, settle (backing moves to unredeemed exactly), redeem.
  - Burned dollars only grow; no method pays them out.
  - No path creates or loses a micro-dollar.
- **Clearing matches sections 7.1 and 7.2:** the three-way price rule, the midpoint rounded down to a tick, the fill order, partial fills. The midpoint still trades `V*`.
- **The commit hash** is unambiguous and cannot be replayed across series, round or account.
- **Access:** exactly 1 yoctoNEAR on `withdraw`, `set_guard` and `transfer_position`; `ft_on_transfer` accepts only the `usdc` account; `on_withdraw` is the only private method; `new` runs once.
- **The recorded guard** (finding 1.6): a commit's void outcome is fixed at commit; changing the guard later has no effect.
- **`max_round_lock`:** it counts the caller's commits before eviction, and it counts void commits too. An agent cannot change it. Two series are live at once only if `lead_secs > period_secs + cutoff_secs`, which the presets do not use.
- **The sets cap:** `mint` leaves room for every unit the series' auctions can still add. `open_sets` and every position stay at or below `2^53 - 1`. `clear`, `merge`, `transfer_position` and `redeem` cannot overflow.
- **Pruning:**
  - A bucket can be pruned only after it is decided and at least two periods have passed.
  - With `report_grace_secs <= period_secs` no report can recreate it. Tested: a report after pruning is refused, and so is `finalize_print`.
  - Pruning touches neither the accumulator nor the last print.
  - The print index bit is cleared.
- **The index, with all three reporters present:** the print is the median. One reporter cannot move it outside the range the other two report, whatever the timing (last-second reports, `finalize_print`, the four-earlier-buckets rule in `report`, or `settle`).
- **The index, with two dishonest reporters out of three:** they set any price. This is stated in spec 15.
- **Invariant 7** (a finished round can always be cleared, a series always settled). I found no state in which `clear` or `settle` panics for a reason other than time, a pending round or missing prints. Exception: `settle` and `decide` add storage, so they fail while the contract's NEAR balance is short, until someone sends NEAR.

## Residual risks before real money

- **Reporters decide the fixing.**
  - Two of three acting together set any price.
  - One dishonest reporter, while another is absent, can choose which hours count (2.1) or force a void settlement at mid-band (2.2).
  - Nothing on chain checks a report against the published data behind it.
- **A round can be blocked at a price:** 1.28 $ per round at the preset, plus capital.
- **Storage depends on volunteers.** It relies on someone calling `prune_print` and `prune_result` and on someone sending the contract NEAR. Nobody is paid to do either. While the balance is short, reports, commits and settlement fail.
- **Agent keys need two limits.** An agent key is bounded only if the owner has set both `guard` and `max_round_lock`. The default leaves both unset.
- **Parameters are not checked enough.** `new` accepts parameters that remove most of these protections (2.7). A deployment's parameters must be read, not assumed.
- **No mainnet history.** The contract has never run on mainnet and cannot be upgraded. A bug found after deployment needs a new contract and a migration by users.

## How to re-run

```sh
contracts/build.sh
cargo test --manifest-path contracts/Cargo.toml -p weir --test audit_findings -- --nocapture --test-threads=1
cargo test --manifest-path contracts/Cargo.toml -p weir --test audit2_findings -- --nocapture --test-threads=1
cargo test --manifest-path contracts/Cargo.toml --workspace   # everything, including the slow sandbox suite
```

`contracts/build.sh` is needed only for the sandbox suite. The two audit files run in the
mocked VM and print the states quoted above. On 2026-11-12, all 8 tests in each file passed.
