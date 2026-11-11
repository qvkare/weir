# Weir contracts

The NEAR side of Weir, written from `docs/SPEC.md` (version 0.6). Section numbers
below refer to it.

## Files

| Path | What it is |
|---|---|
| `build.sh` | Builds both wasm files to `target/near/` with `cargo near build non-reproducible-wasm --no-abi --locked` |
| `weir/src/lib.rs` | The contract: state, every method of sections 5 to 10 and 14, every view of section 12, the `ERR_*` messages |
| `weir/src/time.rs` | Section 4: delivery and auction windows, rounds, phases. Pure |
| `weir/src/clearing.rs` | Sections 7.1 and 7.2: the clearing price and the fills. Pure |
| `weir/src/settlement.rs` | Section 6.1 band arithmetic and section 10 fixing and payouts; a void series pays the centre of its band. Pure |
| `weir/src/index.rs` | Section 9: how a bucket's reports decide a print (median, quorum, spread) or no print. Pure |
| `weir/src/hash.rs` | Section 6.2: the commit preimage and its sha256, and the hex checks |
| `weir/src/types.rs` | Stored records and the JSON shapes of the views |
| `weir/src/events.rs` | Section 13: NEP-297 events, standard `weir`, version `1.0.0` |
| `weir/src/tests.rs` | Unit tests of every method, in near-sdk's mocked VM. Calls run like transactions: a panic rolls state back |
| `weir/tests/properties.rs` | Proptest: invariants 3 and 4 over random books; invariants 1 (as an equality), 2, 5, 6 and 7 over random call sequences, each ending by clearing, settling and redeeming everything |
| `weir/tests/audit_findings.rs` | The audit's first eight demonstrations, now asserting that each attack fails |
| `weir/tests/audit2_findings.rs` | The audit's second pass: `audit2_*` tests assert a fix, `limit_*` tests show what is still possible |
| `weir/tests/audit3_void.rs` | The audit's third pass, on the void settlement: the wash-trade attack now fails, and the limit that remains |
| `weir/tests/sandbox.rs` | The real wasm in near-sandbox with `mock-usdc`: a whole life (with a position moved after settlement, and a void series that traded, cancelled at the centre of its band), a failed withdraw, an agent's function-call key (trades, settles and redeems; refused on `withdraw`, `set_guard`, `transfer_position`), gas of a full `clear` and of a `settle` that decides pending buckets |
| `weir/tests/vectors.rs` | Writes or checks `../vectors/*.json`, the shared test vectors for the TypeScript engine |
| `mock-usdc/src/lib.rs` | A NEP-141 test dollar, `tUSDC`, 6 decimals, with an open `mint` faucet. Testnet and tests only |

The pure modules make no host calls except `sha256` in `hash.rs`, which near-sdk
also provides natively, so they are tested with plain `cargo test`.

There is no owner, no admin method and no upgrade method. The only `#[private]`
method is `on_withdraw`, the callback of `withdraw`. `new` is not private, because
there is no owner to restrict it to: deploy and call `new` in one transaction.

## Build and test

```sh
contracts/build.sh                                          # wasm, needed by the sandbox tests
cargo test --manifest-path contracts/Cargo.toml --workspace # everything
cargo clippy --manifest-path contracts/Cargo.toml --workspace --all-targets
```

The sandbox tests download a sandbox binary on first run, and refuse a wasm older
than its source. The vectors are regenerated with

```sh
WEIR_WRITE_VECTORS=1 cargo test --manifest-path contracts/Cargo.toml -p weir --test vectors
```

and without the variable the same test fails if a committed file differs from what
the code produces.

## Gas

`clear` of a full round, measured in the sandbox (`clearing_a_full_round_fits_in_one_transaction`).
Every commit is from a different account, revealed and filled, half LONG and half
SHORT, which is the most work a round can hold.

| `max_commits` | Tgas burnt by the whole transaction |
|---|---|
| 64 | 26.55 |
| 128 | 51.50 |

`settle` that first decides the undecided buckets of its delivery window
(`a_function_call_key_trades_but_cannot_move_money`): 3.20 Tgas for 3
buckets. That is the most it ever meets: a bucket joins the pending set only while
its report window is open, and every `report` decides up to four closed ones, so at
settlement only the buckets whose windows were still open at the last report can be
waiting (`(print_interval_secs + report_grace_secs) / print_interval_secs`, plus at
most four).

## Audit

An independent auditor made three passes (against spec 0.3, 0.4 and 0.5) and found
the dollar accounting sound every time. Each finding is either closed by a rule, with
a test that keeps the attack and asserts it fails, or stated in the spec as an open
limit, with a test that shows exactly what is still possible and the number it shows.
`docs/AUDIT.md` has the auditor's reasoning; the numbers below come from the tests.

### Closed by a rule

| Pass | Finding | Rule (spec section) | Test |
|---|---|---|---|
| 1 | One reporter ratcheted the index through the two-report mean | All reporters: the median; one absent: the two must agree within `max_spread_bps` (9) | `audit_one_reporter_can_no_longer_steer_the_index` |
| 1 | One silent reporter froze the index after a large move | No move limit (9) | `audit_a_silent_reporter_can_no_longer_freeze_the_index` |
| 1 | Minting `u64::MAX` sets froze a series | `mint` stops at `2^53 - 1` less the auctions' capacity (8) | `audit_open_sets_can_no_longer_overflow` |
| 1 | A function-call agent forfeited an account's dollars to an accomplice | Forfeits are burned (7.3); `max_round_lock` (5, 6.2). Destruction without a limit stays open, below | `audit_function_call_agent_can_no_longer_drain_a_guarded_account` |
| 1 | Changing the guard after commit cancelled an order for free | The commit records the guard and reference (6.2, 6.4) | `audit_guard_change_after_commit_no_longer_cancels` |
| 1 | Out-of-order reports bypassed the move limit | Nothing compares prints (9) | `audit_reporting_out_of_order_no_longer_bypasses_anything` |
| 1 | Storage grew without bound | Results keep only fills; `prune_print`, `prune_result` (12, 14). A result of 64 unfilled orders: 220 B | `audit_storage_bytes_per_object_and_pruning` |
| 2 | A quorum of one in three let one reporter print alone | The quorum must be a majority (3) | `audit2_a_quorum_of_one_in_three_is_refused` |
| 2 | (soundness check) a pruned bucket could come back | It cannot: reports close before pruning opens (3) | `audit2_a_pruned_bucket_cannot_come_back` |
| 3 | Wash trades set the 0.5 void payout (0.397 against a fair 0.200; Bob lost 19.80 $) | A void series pays the centre of its band; nothing traded is read (10). Now Bob loses 0.10 $ and Mallory 0.30 $: their fees | `audit3_wash_trades_no_longer_set_the_void_payout` |

### Open limits

| Pass | Limit (spec section) | What the test shows | Test |
|---|---|---|---|
| 1, 2 | Blocking a round costs `max_commits * commit_fee` (15) | 1.28 $ a round at the test's 0.02 $ fee (64 slots); 6.40 $ at the deployed 0.10 $ | `limit_blocking_a_round_costs_1_28_dollars`, and `audit_eviction_griefing_now_costs_a_fee_per_slot` asserts exactly `max_commits * commit_fee` |
| 2 | With one reporter absent, a dishonest one chooses which buckets print (15) | True average 2.000, fixing 2.121 from the 10 buckets it agreed to | `limit_one_reporter_selects_which_buckets_print` |
| 2, 3 | A reporter can force a void, which pays half the band (10, 15) | Bought 10 SHORT at 0.10, gets 0.20: +1.00 $ | `limit_forcing_a_void_pays_a_reporter_half_the_band_for_a_cheap_side` |
| 3 | A reporter who trades buys the cheap side after a move, then forces the void (10, 15) | SHORT at 0.04 pays 0.20: +15.90 $ on 100 units at a 0.40 $ band; up to 0.299 $ a unit at the deployed 0.60 $ band | `limit_a_trading_reporter_forces_a_void_for_up_to_0_299_a_unit_at_the_deployed_band` |
| 2 | An account without `max_round_lock` can be burned by its agent (15) | 100 $ falls to 90.248889 $ in 10 rounds at a 1% forfeit | `limit_an_account_without_a_round_lock_limit_can_be_burned` |
| 2 | The last look: a non-reveal changes another account's fill (11) | Clearing moves from 0.150 to 0.225; the look costs 0.07 $ | `limit_last_look_a_non_reveal_changes_another_accounts_fill` |
| 2 | One account can take a series' whole mint cap (8) | The next minter gets `too many sets`; auctions still clear | `limit_one_account_can_take_the_whole_mint_cap` |
| 2 | Unwise but valid parameters (3) | A 100% spread lets one of two reporters print 3.0 for a true 2.0 | `limit_unwise_parameters_are_still_accepted` |

## Error messages

Every panic the contract raises on purpose is one of these (`weir::ERR_*`). They are
normative (spec section 16): the engine refuses the same calls with the same texts.

| Constant | Message |
|---|---|
| `ERR_DURATION` | `every duration but cutoff_secs must be above zero` |
| `ERR_TICK` | `tick must be above zero` |
| `ERR_BAND_BPS` | `band_bps must be between 1 and 9999` |
| `ERR_FORFEIT_BPS` | `forfeit_bps must be at most 10000` |
| `ERR_MAX_COMMITS` | `max_commits must be 1 to 128` |
| `ERR_MAX_ORDER_SIZE` | `max_order_size must be at least 1` |
| `ERR_CUTOFF` | `cutoff_secs must be below lead_secs` |
| `ERR_BUCKET_GRID` | `t0 and period_secs must be multiples of print_interval_secs` |
| `ERR_MIN_PRINTS` | `min_prints must be at least 1` |
| `ERR_MIN_PRINTS_TOO_MANY` | `min_prints must be at most period_secs / print_interval_secs` |
| `ERR_VOID_AFTER` | `void_after_secs must be at least report_grace_secs` |
| `ERR_GRACE` | `report_grace_secs must be at most period_secs` |
| `ERR_MAX_SPREAD` | `max_spread_bps must be between 1 and 10000` |
| `ERR_CAPACITY` | `max_order_size * max_commits * rounds_per_series must be below 2^52` |
| `ERR_REPORTERS` | `reporters must be 1 to 9 accounts with no duplicates` |
| `ERR_QUORUM` | `quorum must be 1 to the number of reporters` |
| `ERR_QUORUM_MAJORITY` | `quorum must be a majority of the reporters` |
| `ERR_FEE` | `attach at least 0.02 NEAR to register` |
| `ERR_REGISTERED` | `account is already registered` |
| `ERR_NOT_REGISTERED` | `account is not registered` |
| `ERR_WRONG_TOKEN` | `only the usdc token can be deposited` |
| `ERR_ONE_YOCTO` | `requires exactly 1 yoctoNEAR attached` |
| `ERR_ZERO_AMOUNT` | `amount must be above zero` |
| `ERR_BALANCE` | `free balance is too low` |
| `ERR_STALE` | `index is stale` |
| `ERR_BAND_TOO_NARROW` | `band is narrower than one tick` |
| `ERR_BAND_TOO_WIDE` | `band is wider than the price` |
| `ERR_NOT_COMMIT_PHASE` | `not in a commit phase` |
| `ERR_BAD_HASH` | `hash must be 64 lowercase hex characters` |
| `ERR_LOCK_TOO_SMALL` | `lock is below min_lock` |
| `ERR_ROUND_FULL` | `round is full` |
| `ERR_ROUND_LOCK` | `over the round lock limit` |
| `ERR_NO_COMMIT` | `commit not found` |
| `ERR_NOT_OWNER` | `caller does not own this commit` |
| `ERR_ALREADY_REVEALED` | `commit is already revealed` |
| `ERR_NOT_REVEAL_PHASE` | `not in the reveal phase` |
| `ERR_BAD_SALT` | `salt must be 32 to 64 lowercase hex characters` |
| `ERR_HASH_MISMATCH` | `revealed values do not match the hash` |
| `ERR_BAD_SIZE` | `size must be 1 to max_order_size` |
| `ERR_BAD_PRICE` | `price must be a multiple of tick above 0 and below band` |
| `ERR_UNDER_LOCKED` | `lock does not cover the order` |
| `ERR_ROUND_NOT_OVER` | `round is not over` |
| `ERR_NO_COMMITS` | `round has no commits` |
| `ERR_CLEARED` | `round is already cleared` |
| `ERR_WINDOW_CLOSED` | `auction window is closed` |
| `ERR_ZERO_SETS` | `sets must be above zero` |
| `ERR_UNKNOWN_SERIES` | `series not found` |
| `ERR_SETTLED` | `series is settled` |
| `ERR_POSITION_TOO_SMALL` | `position is too small` |
| `ERR_SELF_TRANSFER` | `cannot transfer a position to yourself` |
| `ERR_NOTHING_TO_TRANSFER` | `long + short must be at least 1` |
| `ERR_TOO_MANY_SETS` | `too many sets` |
| `ERR_NOT_REPORTER` | `caller is not a reporter` |
| `ERR_BUCKET` | `bucket must be a multiple of print_interval_secs` |
| `ERR_REPORT_WINDOW` | `outside the report window of this bucket` |
| `ERR_ZERO_PRICE` | `price must be above zero` |
| `ERR_BAD_BUNDLE` | `bundle must be 64 lowercase hex characters` |
| `ERR_DUPLICATE_REPORT` | `reporter already reported this bucket` |
| `ERR_WINDOW_OPEN` | `the report window of this bucket has not closed` |
| `ERR_NO_REPORTS` | `bucket has no reports` |
| `ERR_DECIDED` | `bucket is already decided` |
| `ERR_UNDECIDED` | `bucket is not decided` |
| `ERR_PRUNE_TOO_EARLY` | `a print can be pruned two periods after its bucket` |
| `ERR_DELIVERY_NOT_OVER` | `the report window of the delivery has not closed` |
| `ERR_PENDING_ROUNDS` | `a round of the series is waiting to be cleared` |
| `ERR_NOT_ENOUGH_PRINTS` | `not enough prints yet` |
| `ERR_NOT_SETTLED` | `series is not settled` |
| `ERR_NO_POSITION` | `nothing to redeem` |
| `ERR_NO_RESULT` | `result not found` |
| `ERR_OVERFLOW` | `arithmetic overflow` |
