# Weir contract: review record

## Who did this, and what it is

An AI reviewer (Claude, an Anthropic model) that did not write the contract reviewed it in
four passes, all on 2026-11-12:

| Pass | Specification |
|---|---|
| 1 | 0.3 |
| 2 | 0.4 |
| 3 | 0.5 |
| 4 | 0.6 |

After each of the first three passes, the authors changed the rules. The reviewer worked from
`docs/SPEC.md`, the Rust source, and tests it wrote itself.

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

1. Read the specification and the changed source in each pass.
2. Followed every path that moves dollars, by hand, against the running totals behind
   `get_totals`.
3. Wrote unit tests that drive the contract through its public methods in near-sdk's mocked
   VM. Each call runs like a transaction: a panic rolls the state back.

   | File | Pass | Owner now |
   |---|---|---|
   | `contracts/weir/tests/audit_findings.rs` | 1 | the authors |
   | `contracts/weir/tests/audit2_findings.rs` | 2 | the authors |
   | `contracts/weir/tests/audit3_void.rs` | 3 | the authors |
   | `contracts/weir/tests/audit4_void_centre.rs` | 4 | the reviewer |

   The authors rewrote or renamed the tests in the first three files after each pass.
   - `audit*` tests assert that a finding is closed.
   - `limit_*` tests keep demonstrating something the specification states as an open limit.
4. The real wasm was **not** run for this review. The sandbox and integration runs in the
   repository were made by the authors. Gas figures for anything other than `clear` were not
   measured.

## Deployed parameters

The `weekly` preset in `agents/src/presets.ts`:

| Parameter | Value |
|---|---|
| Reporters | 3, quorum 2; all run by one operator |
| `max_spread_bps` | 200 |
| `min_prints` | 126 of 168 hourly buckets (75%) |
| `band_bps` | 1500, so on a 2.00 $ anchor the band is 0.60 $ and half the band is 0.30 $ |
| `commit_fee` | 0.10 $ |
| `forfeit_bps` | 100 |
| `max_commits` | 64 |
| Rounds per series | 168 |

## History

**First pass.** It found that one reporter could ratchet the index and one could freeze it,
that `clear` could overflow, that forfeits could be steered to an accomplice, that eviction
was free, and that the guard could be changed after commit. Specification 0.4 closed most of
these.

**Second pass.** It found that, when one reporter was absent, a single dishonest reporter
could force a void settlement at mid-band. Specification 0.5 replaced that rule.

**Third pass.** The 0.5 rule paid a void series at the average price its own auctions had
traded at. **That fix was faulty.** Wash trades between two accounts of one person, in a
round they alone used, set the average anywhere in the band for the price of commit fees.
In the test, a trading reporter took 19.40 $ of a counterparty's 20 $. It was a worse hole
than the one it replaced.

**Fourth pass.** Specification 0.6 withdrew the 0.5 rule. It now pays a void series half the
band on each side, and this pass checks that rule.

## Fourth pass (spec 0.6)

### The centre-of-band rule is sound against traders who are not reporters

`settlement::settle` sets `long_payout = band / 2` and `short_payout = band - band / 2`.

- **Rounding.** `band` is always even, because `settlement::band` builds it as
  `half.checked_mul(2)`. So `band / 2` is exact, and each set pays exactly `band`.
- **The old fields are inert.** `traded_units` and `traded_value` are still added up in
  `clear` and returned by `get_series`, but nothing reads them. They cannot overflow: the
  traded units of a series are at most its auction capacity, below `2^52`.

`audit4_void_centre.rs::audit4_a_non_reporter_cannot_move_the_void_payout` tries everything
a trader can do before a void:
- an honest trade below half the band;
- wash trades of 10,000 units at both extremes (0.399 and 0.001 on a 0.40 band);
- minting 500 sets and merging 200;
- moving positions both ways.

Then the index fails on its own, with no reports in the delivery window.

| Check | Result |
|---|---|
| `settle` at delivery end + grace | refused (`not enough prints yet`) |
| `settle` after `void_after_secs` | void, 0.200 / 0.200 |
| Bob | lost exactly 100 × (0.250 − 0.200) plus his fee: −5.10 $ |
| Mallory | gained exactly 100 × (0.200 − 0.150) minus five fees: +4.50 $ |
| Wash trades, mints, merges, transfers | contributed exactly nothing |
| After redeeming everything | free + burned = deposits, with nothing left locked, backing or unredeemed |

This confirms the coordinator's statement. A trader who is not a reporter gains from a void
only by having bought a side for less than half the band. That is ordinary price risk.

There is no on-chain way to trade on the knowledge that a void is coming:
- auctions and `mint` close before delivery starts;
- `merge` is neutral;
- `transfer_position` moves units but sets no price.

One indirect path remains, found by reading and not tested (4.1). Prints can stop if the
contract runs out of NEAR for storage. Anyone can add storage to the contract (commits,
positions), but at today's costs this is expensive: about 6.40 $ of fees for 8 KB of book
storage. It matters only if the operator lets the NEAR balance run down.

### What remains for a reporter, at deployed parameters

Both cases need one of the three reporters to be absent, or the operator to control two of
them. With one operator running all three, that operator can set the fixing outright, so
these numbers measure what a single compromised reporter key can do.

| Case | Size | Test |
|---|---|---|
| **Choosing which buckets print** | Up to about 0.029 $ a unit, about 4.8% of the band (details below). | `limit_one_reporter_selects_which_buckets_print`, which shows the mechanism with ±5% hourly swings: fixing 2.121 against a true 2.000. |
| **Forcing a void while holding the cheap side** | Gain over price paid: `band/2 − price` per unit, up to 0.299 $ (49.8% of the band). Against the true settlement, up to 0.30 $ (50%). It needs 43 of 168 buckets without a print. | `limit_a_trading_reporter_forces_a_void_for_up_to_0_299_a_unit_at_the_deployed_band` and `limit_forcing_a_void_pays_a_reporter_half_the_band_for_a_cheap_side` |

How the 0.029 $ for choosing which buckets print is made up:
- **Leaning each print:** up to `max_spread/2` = 1% of the index, about 0.020 $ a unit
  (3.3% of the band).
- **Dropping hours:** up to 42 of 168 hours (25%). That adds about 0.42σ, where σ is the
  hourly spread of the index. At σ = 1% of the index this is about 0.009 $. I assumed σ; I
  did not measure it.
- **Together:** about 0.029 $ a unit, about 4.8% of the band.

These are acceptable on a testnet with test dollars and one known operator: that operator
already holds full power over the fixing, and nothing real is at stake.

They are not acceptable for real dollars. That needs at least:
- reporters run by independent parties;
- enough reporters that one absence does not leave two, each able to veto any bucket;
- a published policy, or a mechanism, for what happens to a reporter who causes no-prints.

## Every finding, status under 0.6

"Open" means the weakness exists in the deployed contract today. The test named
demonstrates it. Numbers are at deployed parameters.

| # | Severity | Finding | Status under 0.6 | Test |
|---|---|---|---|---|
| 1.1 | Critical | One reporter ratcheted the index through the two-report mean. | Closed: no move rule, and a full set of reports gives the median (spec 9). | `audit_one_reporter_can_no_longer_steer_the_index` |
| 1.2 | High | One silent reporter froze the index after a large move. | Closed: no move limit (9). | `audit_a_silent_reporter_can_no_longer_freeze_the_index` |
| 1.3 | Critical on testnet | Minting `u64::MAX` sets made `clear` overflow and froze the series. | Closed: the `mint` cap (8). | `audit_open_sets_can_no_longer_overflow` |
| 1.4 | High | A function-call agent forfeited an account's balance to an accomplice. | Closed for theft: forfeits are burned (7.3). The burning that remains is 2.4. | `audit_function_call_agent_can_no_longer_drain_a_guarded_account` |
| 1.5 | High | Evicting every rival from a round was free. | Open as 2.3. | `audit_eviction_griefing_now_costs_a_fee_per_slot` |
| 1.6 | Medium | Changing the guard after commit cancelled an order for free. | Closed: the commit records the guard and reference (6.2, 6.4). | `audit_guard_change_after_commit_no_longer_cancels` |
| 1.7 | Medium | Out-of-order reports bypassed the move limit. | Closed: nothing compares prints (9). | `audit_reporting_out_of_order_no_longer_bypasses_anything` |
| 1.8 | Medium | Storage the contract pays for grew without bound. | Partly closed: results keep only fills, and anyone may prune. Open: nobody is paid to prune or to send NEAR (14, 15). | `audit_storage_bytes_per_object_and_pruning` |
| 1.9 | Note | Missing parameter checks, a missing event, the bonus pool, an unchecked add in the mock. | Closed, except some parameter checks (2.7). | none |
| 2.1 | High | With one reporter absent, one dishonest reporter chooses which buckets print and leans each print. | **Open:** about 0.029 $ a unit (about 4.8% of the band) at an assumed 1% hourly σ. | `limit_one_reporter_selects_which_buckets_print` |
| 2.2 | High | Forcing a void paid mid-band (0.4). | Replaced in 0.5 by 3.1, then by the centre-of-band rule in 0.6. **Open** as a reporter gain: see 3.2. | `limit_forcing_a_void_pays_a_reporter_half_the_band_for_a_cheap_side` |
| 2.3 | High | Blocking a round costs `max_commits × commit_fee`. | **Open:** 6.40 $ a round, about 1,075 $ a week, plus capital above the largest honest lock. | `limit_blocking_a_round_costs_6_40_dollars_at_the_deployed_fee` |
| 2.4 | Medium | With `max_round_lock` unset (the default), an agent burns 1% plus the fee per round. | Open (stated limit, 15): 100 $ became 90.25 $ in 10 rounds. The deployment tool sets the limit for the agents it creates. | `limit_an_account_without_a_round_lock_limit_can_be_burned` |
| 2.5 | Medium | Not revealing changes others' fills, which gives a last look. | Open (stated limit, 15). A look costs 1% of the lock plus 0.10 $. Invariant 6 now reads "burned stays burned". | `limit_last_look_a_non_reveal_changes_another_accounts_fill` |
| 2.6 | Low | On testnet, one account can take the whole mint cap. | Open (stated limit, 8). | `limit_one_account_can_take_the_whole_mint_cap` |
| 2.7 | Medium | Dangerous parameters were accepted. | Quorum below a majority is closed (3). A 100% spread, 2 reporters, no fee with no forfeit, and grace = period are still accepted (15). | `audit2_a_quorum_of_one_in_three_is_refused`, `limit_unwise_parameters_are_still_accepted` |
| 2.8 | Low | Large grace: many pending buckets in the root state, and `settle` decides them all in one call. Recoverable through `finalize_print`. | Open; found by reading. | none |
| 2.9 | Low | `prune_print` can delete delivery reports before a late settlement. | Open; found by reading. | none |
| 2.10 | Note | The guard reference has no age check and lags 1 to 2 intervals. | Open; found by reading. | none |
| 2.11 | Note | `get_prints` scans 4096 words and can miss prints after pruning. | Open; found by reading (view only). | none |
| 3.1 | Critical | The 0.5 void payout (the traded average) was set by wash trades: a trading reporter took 19.40 $ of 20 $. | Closed: a void pays `band/2` on each side, and no rule reads the traded fields (10). | `audit3_wash_trades_no_longer_set_the_void_payout`, `audit4_a_non_reporter_cannot_move_the_void_payout` |
| 3.2 | High | A reporter who holds the cheap side and forces a void is paid half the band for it. | **Open:** up to 0.299 $ a unit, 49.8% of the band. It needs 43 of 168 buckets without a print. | `limit_a_trading_reporter_forces_a_void_for_up_to_0_299_a_unit_at_the_deployed_band` |
| 4.1 | Low | A non-reporter can cause a void only indirectly: by exhausting the contract's NEAR so that reports fail. It is expensive unless the balance has been allowed to run low. | Open; found by reading, not tested. | none |

## Examined and found sound

These were checked by reading. Some are also covered by the authors' property tests or by the
review tests named.

- **Dollar accounting on every path, in all four passes.** This includes the 0.6 void path:
  `audit4_a_non_reporter_cannot_move_the_void_payout` asserts free + burned = deposits after
  a full void redemption. Burned dollars are never credited.
- **The void payout under 0.6** cannot be moved by trades, mints, merges, transfers, or the
  timing of `clear` and `settle`.
- **Clearing matches sections 7.1 and 7.2.**
- **The commit hash** is unambiguous and cannot be replayed.
- **Access controls** (1 yoctoNEAR, the token check, the single private callback, `new` once)
  are as described.
- **The recorded guard**, **`max_round_lock`** and **the sets cap** behave as the specification
  says.
- **Pruning:** a pruned bucket cannot come back (`audit2_a_pruned_bucket_cannot_come_back`),
  and pruning does not touch the accumulators or the last print.
- **The index with all reporters present** gives the median, which a minority cannot move.
- **Invariant 7:** I found no state in which `clear` or `settle` fails for a reason other
  than time, a pending round, missing prints, or a short NEAR balance.

## Residual risks before real money (0.6)

- **Reporters decide the fixing.**
  - All three are run by one operator, who can set any price.
  - A single compromised reporter key, while another is absent, can lean and select prints
    (about 0.029 $ a unit, 2.1).
  - It can also force a void that pays its cheap side up to 0.299 $ a unit (3.2).
  - Nothing on chain checks a report against its published data.
- **A round can be blocked** for 6.40 $, a week of rounds for about 1,075 $.
- **Agent keys:** bounded only if the owner sets both `guard` and `max_round_lock`. Both
  are off by default.
- **Parameters:** `new` accepts parameters that remove protections. Read `get_params`.
- **Storage:** relies on someone pruning and sending NEAR. Nobody is paid to do either. A
  low balance stops reports, and with them settlement turns void.
- **No mainnet history and no upgrade path.** A bug means a new contract.

## Verdict

**Public testnet.** Weir 0.6 is fit for a public testnet with test dollars, with its
reporters run by one known operator and these limits stated where users will read them.
- Its accounting has stayed exact through four passes.
- The void rule now in force cannot be moved by traders.
- Everything that remains concerns the reporters, whom testnet users must trust anyway, or
  cheap blocking, which costs test dollars only.

**Not for real dollars.** It is not fit for real dollars until, at least:
- the reporters are independent parties, numerous enough that one absence does not hand
  every bucket to a two-reporter veto;
- blocking a round costs something that scales with what it blocks;
- `max_round_lock` is on by default;
- the contract's NEAR balance and pruning have a funded owner.

One fix in this review's history was itself found faulty: the 0.5 void rule. Any change made
to meet the conditions above needs its own review.

## How to re-run

```sh
cargo test --manifest-path contracts/Cargo.toml -p weir --test audit_findings -- --nocapture --test-threads=1
cargo test --manifest-path contracts/Cargo.toml -p weir --test audit2_findings -- --nocapture --test-threads=1
cargo test --manifest-path contracts/Cargo.toml -p weir --test audit3_void -- --nocapture --test-threads=1
cargo test --manifest-path contracts/Cargo.toml -p weir --test audit4_void_centre -- --nocapture --test-threads=1
contracts/build.sh && cargo test --manifest-path contracts/Cargo.toml --workspace   # everything, including the slow sandbox suite
```

On 2026-11-12, against the 0.6 source, all four files passed:

| File | Tests passed |
|---|---|
| `audit_findings` | 8 |
| `audit2_findings` | 9 |
| `audit3_void` | 2 |
| `audit4_void_centre` | 1 |

A test passing means its stated outcome happens. For `limit_*` tests, that outcome is the
weakness itself.
