# Weir contract: review record

## Who did this, and what it is

An AI reviewer (Claude, an Anthropic model) that did not write the contract reviewed it in
three passes on 2026-11-12:

- the first pass against specification 0.3;
- the second pass against 0.4;
- the third pass against 0.5.

After each of the first two passes, the authors changed the rules. The reviewer worked from
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
   - `contracts/weir/tests/audit_findings.rs`: first pass.
   - `contracts/weir/tests/audit2_findings.rs`: second pass.
   - `contracts/weir/tests/audit3_void.rs`: third pass.

   The authors now own the first two files and have rewritten or renamed their tests.
   - `audit*` tests assert that a finding is closed.
   - `limit_*` tests keep demonstrating something the specification now states as a known limit.
4. The real wasm was **not** run for this review. The sandbox and integration runs in the
   repository were made by the authors. Gas figures for anything other than `clear` were not
   measured.

## Deployed parameters used for the numbers below

The `weekly` preset in `agents/src/presets.ts`:

| Parameter | Value |
|---|---|
| Reporters | 3, quorum 2 |
| `max_spread_bps` | 200 |
| `min_prints` | 126 of 168 hourly buckets (75%) |
| `band_bps` | 1500, so a band of 0.60 $ on a 2.00 $ index |
| `commit_fee` | 0.10 $ |
| `forfeit_bps` | 100 |
| `max_commits` | 64 |
| Rounds per series | 168 |

## Third pass (spec 0.5)

### The void unwinding is not sound

Spec 0.5 settles a void series at `traded_value / traded_units`, the average price its
auctions traded at. Spec section 10 says that "stopping the index from printing cannot be
turned into a payout". That is false.

The average can be moved by wash trades between two accounts one person controls. Such
trades cost nothing but commit fees, because the sets they create pay `band` in total
whatever the payout split is. The person can also block the round they wash in, so that no
honest order trades at the wash price. At the deployed fee, blocking a round costs 6.40 $.

`audit3_void.rs::audit3_wash_trades_set_the_void_payout`:

| | |
|---|---|
| Test parameters | band 0.40 $, fee 0.10 $ |
| Honest trade | Mallory buys 100 LONG from Bob at 0.200, the fair price; the index stays at 2.000 throughout |
| Wash trade | Mallory's two accounts trade 10,000 units with each other at 0.399 |
| How the series goes void | Mallory is reporter R1. R3 is absent. She disagrees with R2 in every bucket, so the series has 0 prints and goes void |
| `long_payout` | 0.397029. A normal settlement would pay 0.200000 |
| Bob | loses 19.80 $ of his 20 $ stake |
| Mallory | gains 19.40 $ after fees |
| Solvency | still exact: free + burned = deposits, and nothing else remains |

What this means:
- **The ceiling.** A trader who can bring about a void, or who is simply present when one
  happens, can set the void payout anywhere in `(0, band)`. The most they gain is
  `band - tick - p` per unit of honest position they hold, where `p` is the price they paid
  for it. At the deployed band that is up to about 0.30 $ per unit bought at mid-band. The
  counterparty can lose its whole stake.
- **A free option for everyone.** Without any reporter power, every holder can wash-trade
  in advance at the extreme that favours them. It costs only fees, it is worth it if the
  index later fails, and it is harmless to them otherwise.
- **Who wins.** When both sides do this, the side with more capital sets the average:
  `band` per wash unit, at most 320,000 units a round.
- **The authors' test is too narrow.**
  `audit2_forcing_the_void_fixing_no_longer_pays_the_reporter` passes only because its
  series has one trade, so the average is the reporter's own price.

The other paths I checked are sound:
- **Mints** are not counted in the average. That is harmless: a minted set pays `band`
  whatever the split.
- **A late `clear`** cannot change the average after settlement, because `settle` refuses
  while any round is pending.
- **Rounding** goes down on LONG. The remainder of less than 1 micro-dollar per unit goes to
  SHORT, and each set still pays exactly `band`.

Nobody can force a series out of the void path, because the one way to do so is by making
prints.

### The majority rule

`quorum * 2 > reporters.len()` closes the lone-reporter print: 1 of 3 is refused. It does
nothing about the case that matters at the deployed size. With 3 reporters and one absent,
the other two must agree, so each of them can veto any bucket, which reaches the void path
above. The only remedy is more independent reporters, which this deployment does not have.

## Every finding, status under 0.5

| # | Severity | Finding | Status under 0.5 | Test (current name) |
|---|---|---|---|---|
| 1.1 | Critical | One reporter ratcheted the index through the two-report mean. | Closed: no move rule, and a full set of reports gives the median (9). | `audit_one_reporter_can_no_longer_steer_the_index` |
| 1.2 | High | One silent reporter froze the index after a large move. | Closed: no move limit (9). | `audit_a_silent_reporter_can_no_longer_freeze_the_index` |
| 1.3 | Critical on testnet | Minting `u64::MAX` sets made `clear` overflow and froze the series. | Closed: the `mint` cap (8). | `audit_open_sets_can_no_longer_overflow` |
| 1.4 | High | A function-call agent forfeited an account's balance to an accomplice. | Theft closed: forfeits are burned (7.3). Destruction is a stated limit: see 2.4. | `audit_function_call_agent_can_no_longer_drain_a_guarded_account` |
| 1.5 | High | Evicting every rival from a round was free. | Stated limit, see 2.3. | `audit_eviction_griefing_now_costs_a_fee_per_slot` |
| 1.6 | Medium | Changing the guard after commit cancelled an order for free. | Closed: the commit records the guard and reference (6.2, 6.4). | `audit_guard_change_after_commit_no_longer_cancels` |
| 1.7 | Medium | Out-of-order reports bypassed the move limit. | Closed: nothing compares prints (9). | `audit_reporting_out_of_order_no_longer_bypasses_anything` |
| 1.8 | Medium | Storage the contract pays for grew without bound. | Partly closed: results keep only fills, and anyone may prune. Stated limit: nobody is paid to prune or to send NEAR (14, 15). | `audit_storage_bytes_per_object_and_pruning` |
| 1.9 | Note | Missing parameter checks, a missing event, the bonus pool, an unchecked add in the mock. | Closed, except the parameter checks (2.7). | none |
| 2.1 | High | With one reporter absent, one dishonest reporter chooses which buckets print, and leans every print by up to `max_spread/2`. Test: true average 2.000, fixing 2.121. | **Open.** At deployed parameters it can drop up to 25% of hours and lean every print 1% (0.02 $ on 2.00 $, 3.3% of the band per unit). Below 126 prints it reaches the void path, where 3.1 applies. | `limit_one_reporter_selects_which_buckets_print` |
| 2.2 | High | One reporter forced a void settlement at mid-band. | Replaced by 3.1, which is worse: the void payout is now chosen by whoever trades the most. | `audit2_forcing_the_void_fixing_no_longer_pays_the_reporter` (passes, but only for a single trade) |
| 2.3 | High | Blocking a round costs `max_commits * commit_fee`. | **Open** at deployed parameters: 6.40 $ a round, 1,075 $ a week for all 168 rounds, plus capital above the largest honest lock. It also lets the blocker choose the price of every trade in that round, which feeds 3.1. The test uses a 0.02 $ fixture: 1.28 $. | `limit_blocking_a_round_costs_1_28_dollars` |
| 2.4 | Medium | With `max_round_lock` unset (the default), an agent burns 1% plus the fee per round: 100 $ fell to 90.25 $ in 10 rounds. | Stated limit (15). The deployment tool sets it for the agents it creates. Accounts made any other way are unprotected. | `limit_an_account_without_a_round_lock_limit_can_be_burned` |
| 2.5 | Medium | Not revealing changes others' fills, which gives a last look. | Stated limit (15). Invariant 6 is restated as "burned stays burned". Cost of a look: 1% of the lock plus 0.10 $. | `limit_last_look_a_non_reveal_changes_another_accounts_fill` |
| 2.6 | Low | On testnet, one account can take the whole mint cap. | Stated limit (8). | `limit_one_account_can_take_the_whole_mint_cap` |
| 2.7 | Medium | Dangerous parameters were accepted. | Quorum of 1 in 3 closed (3). A 100% spread, 2 reporters, no fee with no forfeit, and grace = period are still accepted (15). | `audit2_a_quorum_of_one_in_three_is_refused`, `limit_unwise_parameters_are_still_accepted` |
| 2.8 | Low | Large grace: many pending buckets in the root state, and `settle` decides them all in one call. Recoverable through `finalize_print`. | Open; found by reading, not measured. | none |
| 2.9 | Low | `prune_print` can delete delivery reports before a late settlement. | Open; found by reading. | none |
| 2.10 | Note | The guard reference has no age check and lags 1 to 2 intervals with two reporters. | Open; found by reading. | none |
| 2.11 | Note | `get_prints` scans 4096 words; it can miss prints after pruning. | Open; found by reading (view only). | none |
| 3.1 | Critical | The void payout is the traded average, which wash trades in a blocked round set anywhere in `(0, band)` for fees only. A reporter who trades, with another reporter absent, forces the void and takes up to the counterparties' whole stake: 19.40 $ from a 20 $ trade in the test. Without reporter power, it is a free option on any natural void. | **Open.** | `audit3_void.rs::audit3_wash_trades_set_the_void_payout` |

## Examined and found sound

These were checked by reading. Some are also covered by the authors' property tests or by the
review tests named.

- **Dollar accounting on every path.** This was checked in all three passes, including the
  0.5 void path. Solvency stays exact through a void settlement and full redemption
  (`audit3_wash_trades_set_the_void_payout` asserts free + burned = deposits). Burned
  dollars are never credited.
- **Clearing matches sections 7.1 and 7.2.**
- **The commit hash** is unambiguous and cannot be replayed.
- **Access controls** (1 yoctoNEAR, the token check, the single private callback, `new` once)
  are as described.
- **The recorded guard** decides a void at commit, so changing it later changes nothing.
- **`max_round_lock`** is counted before eviction and includes void commits.
- **The sets cap** keeps every unit count at or below `2^53 - 1`.
- **Pruning:**
  - A pruned bucket cannot come back (`audit2_a_pruned_bucket_cannot_come_back`).
  - Pruning does not touch the accumulators or the last print.
- **The index with all reporters present** gives the median, which a minority cannot move.
- **Invariant 7:** I found no state in which `clear` or `settle` fails for a reason other
  than time, a pending round, missing prints, or the contract's NEAR balance being short.

## Residual risks before real money (0.5)

- **Reporters decide the fixing.**
  - Two of the three set any price.
  - One, while another is absent, chooses which hours count and leans each print by 1%.
  - It can also force a void, and under 0.5 a void pays whatever wash trades made the
    average (3.1).
  - Nothing on chain checks a report against its published data.
  - There are three reporters, run by one party.
- **The void rule can be gamed.** Anyone with capital can pre-position the void payout for
  the price of commit fees.
- **A round can be blocked** for 6.40 $, a week of rounds for about 1,075 $.
- **Agent keys:** bounded only if the owner sets both `guard` and `max_round_lock`. Both
  are off by default.
- **Parameters:** `new` still accepts parameters that remove protections. Read `get_params`.
- **Storage:** relies on someone pruning and sending NEAR. Nobody is paid to do either.
- **No mainnet history and no upgrade path.** A bug means a new contract.

## Verdict

**Public testnet:** this contract is fit for a public testnet with test dollars. Its
accounting has held exact through three passes, every path that moved dollars balanced, and
the integration run reports the wasm and an independent model agreeing.

**Not for real dollars.** It is not fit for real dollars in its 0.5 form, for three reasons:
- **The void rule is wrong.** Finding 3.1 lets a trader who can cause a void, or who is
  merely present for one, take the other side's stake.
- **The index is too narrow.** With three reporters run by one party and an even-count
  veto, a single absence turns one dishonest reporter into the decider.
- **Blocking is cheap.** It costs about 1,075 $ a week, which also supports 3.1.

**Before real money, at minimum:**
- a void rule that cannot be priced by the traders themselves, such as refunding each
  position its own cost basis, or splitting evenly;
- more independent reporters;
- a blocking cost that scales with the lock rather than per slot;
- `max_round_lock` on by default.

None of these changes has been reviewed here.

## How to re-run

```sh
cargo test --manifest-path contracts/Cargo.toml -p weir --test audit_findings -- --nocapture --test-threads=1
cargo test --manifest-path contracts/Cargo.toml -p weir --test audit2_findings -- --nocapture --test-threads=1
cargo test --manifest-path contracts/Cargo.toml -p weir --test audit3_void -- --nocapture --test-threads=1
contracts/build.sh && cargo test --manifest-path contracts/Cargo.toml --workspace   # everything, including the slow sandbox suite
```

On 2026-11-12, against the 0.5 source, all three files passed:

| File | Tests passed |
|---|---|
| `audit_findings` | 8 |
| `audit2_findings` | 9 |
| `audit3_void` | 1 |

A test passing means its stated outcome happens. For `limit_*` tests, that outcome is the
weakness itself.
