# Weir contracts

The NEAR side of Weir, written from `docs/SPEC.md` (version 0.2). Section numbers
below refer to it.

## Files

| Path | What it is |
|---|---|
| `build.sh` | Builds both wasm files to `target/near/` with `cargo near build non-reproducible-wasm --no-abi --locked` |
| `weir/src/lib.rs` | The contract: state, every method of sections 5 to 10 and 14, every view of section 12, the `ERR_*` messages |
| `weir/src/time.rs` | Section 4: delivery and auction windows, rounds, phases. Pure |
| `weir/src/clearing.rs` | Sections 7.1 and 7.2: the clearing price and the fills. Pure |
| `weir/src/settlement.rs` | Section 6.1 band arithmetic and section 10 fixing, payouts, bonus and carry. Pure |
| `weir/src/index.rs` | Section 9: the median and whether a bucket's print is final. Pure |
| `weir/src/hash.rs` | Section 6.2: the commit preimage and its sha256, and the hex checks |
| `weir/src/types.rs` | Stored records and the JSON shapes of the views |
| `weir/src/events.rs` | Section 13: NEP-297 events, standard `weir`, version `1.0.0` |
| `weir/src/tests.rs` | Unit tests of every method, in near-sdk's mocked VM. Calls run like transactions: a panic rolls state back |
| `weir/tests/properties.rs` | Proptest: invariants 3 and 4 over random books; invariants 1, 2 and 5 over random call sequences |
| `weir/tests/sandbox.rs` | The real wasm in near-sandbox with `mock-usdc`: a whole life, a failed withdraw, function-call keys, gas of a full `clear` |
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
| 64 | 26.35 |
| 128 | 51.15 |

## Error messages

Every panic the contract raises on purpose is one of these (`weir::ERR_*`):

| Constant | Message |
|---|---|
| `ERR_DURATION` | `every duration but cutoff_secs must be above zero` |
| `ERR_TICK` | `tick must be above zero` |
| `ERR_BAND_BPS` | `band_bps must be between 1 and 9999` |
| `ERR_FORFEIT_BPS` | `forfeit_bps must be at most 10000` |
| `ERR_MAX_COMMITS` | `max_commits must be 1 to 128` |
| `ERR_MAX_ORDER_SIZE` | `max_order_size must be at least 1` |
| `ERR_CUTOFF` | `cutoff_secs must be below lead_secs` |
| `ERR_MIN_PRINTS` | `min_prints must be at least 1` |
| `ERR_REPORTERS` | `reporters must be 1 to 9 accounts with no duplicates` |
| `ERR_QUORUM` | `quorum must be 1 to the number of reporters` |
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
| `ERR_NOT_REPORTER` | `caller is not a reporter` |
| `ERR_BUCKET` | `bucket must be a multiple of print_interval_secs` |
| `ERR_REPORT_WINDOW` | `outside the report window of this bucket` |
| `ERR_ZERO_PRICE` | `price must be above zero` |
| `ERR_BAD_BUNDLE` | `bundle must be 64 lowercase hex characters` |
| `ERR_DUPLICATE_REPORT` | `reporter already reported this bucket` |
| `ERR_DELIVERY_NOT_OVER` | `the report window of the delivery has not closed` |
| `ERR_PENDING_ROUNDS` | `a round of the series is waiting to be cleared` |
| `ERR_NOT_ENOUGH_PRINTS` | `not enough prints yet` |
| `ERR_NOT_SETTLED` | `series is not settled` |
| `ERR_NO_POSITION` | `nothing to redeem` |
| `ERR_NO_RESULT` | `result not found` |
| `ERR_OVERFLOW` | `arithmetic overflow` |
