# Weir contracts

The NEAR side of Weir, written from `docs/SPEC.md` (version 0.5). Section numbers
below refer to it.

## Files

| Path | What it is |
|---|---|
| `build.sh` | Builds both wasm files to `target/near/` with `cargo near build non-reproducible-wasm --no-abi --locked` |
| `weir/src/lib.rs` | The contract: state, every method of sections 5 to 10 and 14, every view of section 12, the `ERR_*` messages |
| `weir/src/time.rs` | Section 4: delivery and auction windows, rounds, phases. Pure |
| `weir/src/clearing.rs` | Sections 7.1 and 7.2: the clearing price and the fills. Pure |
| `weir/src/settlement.rs` | Section 6.1 band arithmetic and section 10 fixing and payouts, including the unwinding of a void series at its traded average. Pure |
| `weir/src/index.rs` | Section 9: how a bucket's reports decide a print (median, quorum, spread) or no print. Pure |
| `weir/src/hash.rs` | Section 6.2: the commit preimage and its sha256, and the hex checks |
| `weir/src/types.rs` | Stored records and the JSON shapes of the views |
| `weir/src/events.rs` | Section 13: NEP-297 events, standard `weir`, version `1.0.0` |
| `weir/src/tests.rs` | Unit tests of every method, in near-sdk's mocked VM. Calls run like transactions: a panic rolls state back |
| `weir/tests/properties.rs` | Proptest: invariants 3 and 4 over random books; invariants 1 (as an equality), 2, 5, 6 and 7 over random call sequences, each ending by clearing, settling and redeeming everything |
| `weir/tests/audit_findings.rs` | The audit's first eight demonstrations, now asserting that each attack fails |
| `weir/tests/audit2_findings.rs` | The audit's second pass: `audit2_*` tests assert a fix, `limit_*` tests show what is still possible |
| `weir/tests/sandbox.rs` | The real wasm in near-sandbox with `mock-usdc`: a whole life (with a position moved after settlement, and a void series unwound at its traded price), a failed withdraw, an agent's function-call key (trades, settles and redeems; refused on `withdraw`, `set_guard`, `transfer_position`), gas of a full `clear` and of a `settle` that decides pending buckets |
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
| 64 | 26.59 |
| 128 | 51.44 |

`settle` that first decides the undecided buckets of its delivery window
(`a_function_call_key_trades_but_cannot_move_money`): 3.20 Tgas for 3
buckets. That is the most it ever meets: a bucket joins the pending set only while
its report window is open, and every `report` decides up to four closed ones, so at
settlement only the buckets whose windows were still open at the last report can be
waiting (`(print_interval_secs + report_grace_secs) / print_interval_secs`, plus at
most four).

## Audit

An independent audit found the accounting sound on both passes. Its findings are
either closed by a rule, with a test that keeps the attack and asserts it fails, or
stated in the spec as a known limit, with a test that shows exactly what is still
possible (`docs/AUDIT.md` has the reasoning).

### Closed by a rule

| Finding | Rule (spec section) | Test |
|---|---|---|
| Changing the guard after commit cancelled an order for free | The commit records the guard and reference; reveal applies those (6.2, 6.4) | `audit_guard_change_after_commit_no_longer_cancels` |
| A function-call agent could forfeit an account's dollars to a confederate | Forfeits are burned (7.3); `max_round_lock` caps a round (5, 6.2) | `audit_function_call_agent_can_no_longer_drain_a_guarded_account` |
| Evicting every rival cost nothing | Every commit pays `commit_fee`, burned at clearing (6.2) | `audit_eviction_griefing_now_costs_a_fee_per_slot` |
| One reporter could ratchet the index | All reporters: the median; two of three: within `max_spread_bps` or no print (9) | `audit_one_reporter_can_no_longer_steer_the_index` |
| One silent reporter froze the index after a large move | No move limit (9) | `audit_a_silent_reporter_can_no_longer_freeze_the_index` |
| Reporting out of order bypassed the move limit | Nothing compares prints with earlier prints (9) | `audit_reporting_out_of_order_no_longer_bypasses_anything` |
| Minting `u64::MAX` sets froze a series | `mint` stops at `2^53 - 1` less the auctions' capacity (8) | `audit_open_sets_can_no_longer_overflow` |
| Storage grew without bound | Results keep only fills; `prune_print`, `prune_result` (12, 14) | `audit_storage_bytes_per_object_and_pruning` |
| One reporter could force a void series to mid-band and profit | A void series unwinds at its traded average (10): the reporter's SHORT paid 1.00 $ and gets 1.00 $ back, where 0.4 paid 2.00 $ | `audit2_forcing_the_void_fixing_no_longer_pays_the_reporter` |
| A quorum of one in three let one reporter print alone | The quorum must be a majority (3) | `audit2_a_quorum_of_one_in_three_is_refused` |

### Stated limits

| Limit (spec section) | What the test shows | Test |
|---|---|---|
| With one reporter absent, one dishonest reporter chooses which buckets print (15) | True average 2.000000, fixing 2.121000 from the 10 buckets it agreed to | `limit_one_reporter_selects_which_buckets_print` |
| A round can be blocked at a price (15) | 64 slots at 0.02 $: 1.28 $ a round, 640 $ of capital for one round | `limit_blocking_a_round_costs_1_28_dollars` |
| An account without `max_round_lock` can be burned by its agent (15) | 100 $ falls to 90.248889 $ in 10 rounds at a 1% forfeit | `limit_an_account_without_a_round_lock_limit_can_be_burned` |
| The last look: a non-reveal changes another account's fill (11) | Clearing moves from 0.150 to 0.225; the look costs 0.07 $ | `limit_last_look_a_non_reveal_changes_another_accounts_fill` |
| One account can take a series' whole mint cap (8) | The next minter gets `too many sets`; auctions still clear | `limit_one_account_can_take_the_whole_mint_cap` |
| Unwise but valid parameters (3) | A 100% spread lets one of two reporters print 3.0 for a true 2.0 | `limit_unwise_parameters_are_still_accepted` |

`audit2_a_pruned_bucket_cannot_come_back` checks a soundness question the second pass
raised: a pruned bucket can never take reports again.

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
