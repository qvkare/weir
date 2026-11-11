# Weir specification

Version 0.1. This file is the source of truth. The NEAR contract (`contracts/weir`) and
the TypeScript engine (`engine/`) are written from it independently and must agree
on every number. Where code and this file differ, the code is wrong.

## 1. What Weir is

Weir runs week-ahead auctions on the price of one GPU-hour. A buyer of compute and
a seller of compute each lock dollars, the auction sets one price for everyone, and
after the delivery week each side is paid the difference between that price and the
average index price over the week. Every position is fully paid for when it is
opened, so nobody is ever liquidated and nobody owes more than they locked.

Terms used below:

- **Index**: the price of one NVIDIA H100 GPU-hour in US dollars, posted on chain by
  reporters (section 9).
- **Series**: one delivery period. Series `s` settles on the average index over its
  delivery window.
- **Set**: one LONG unit plus one SHORT unit of a series. A set is always backed by
  exactly `band` dollars held by the contract.
- **LONG**: pays `clamp(fixing - floor, 0, band)` per unit at settlement. A compute
  buyer holds LONG: when the index rises, LONG pays the extra they spend on compute.
- **SHORT**: pays `band - (LONG payout)` per unit. A compute seller holds SHORT.
- **LONG price** `p`: what a LONG buyer pays per unit, `0 < p < band`. A SHORT buyer
  pays `band - p`. The implied forward price of a GPU-hour is `floor + p`.

## 2. Units

| Quantity | Type | Unit |
|---|---|---|
| Dollar amounts (balances, locks, payouts) | `u128` | micro-USDC (6 decimals) |
| Prices (index, floor, band, LONG price, tick) | `u64` | micro-USD per GPU-hour |
| Sizes (orders, positions, sets) | `u64` | whole GPU-hours |
| Time | `u64` | Unix seconds. The contract uses `block_timestamp / 1_000_000_000` |

`size * price` is therefore micro-USDC with no rounding. All arithmetic is checked;
overflow panics.

## 3. Parameters

Set once in `new(params)` and never changed. The contract has no owner and no admin
method.

| Name | Type | Meaning |
|---|---|---|
| `usdc` | account id | The NEP-141 token used as the dollar |
| `underlying` | string | Label of the index, for example `H100-USD-HR` |
| `t0` | u64 | Delivery start of series 0 |
| `period_secs` | u64 | Length of a delivery window |
| `lead_secs` | u64 | How long before delivery starts the auctions for a series open |
| `cutoff_secs` | u64 | No round may end later than `delivery_end - cutoff_secs` |
| `commit_secs` | u64 | Length of a round's commit phase |
| `reveal_secs` | u64 | Length of a round's reveal phase |
| `band_bps` | u32 | Half-width of the band as basis points of the anchor |
| `tick` | u64 | Price increment |
| `print_interval_secs` | u64 | Spacing of index prints |
| `report_grace_secs` | u64 | How long after a bucket ends a report for it is still accepted |
| `max_move_bps` | u32 | A print further than this from the last print needs every reporter |
| `min_prints` | u32 | Prints a series needs for a normal settlement |
| `void_after_secs` | u64 | After `delivery_end + void_after_secs` a series can settle without `min_prints` |
| `max_anchor_age_secs` | u64 | Oldest print a series may be opened on |
| `forfeit_bps` | u32 | Share of its lock a commit loses if it is not revealed |
| `min_lock` | u128 | Smallest lock a commit may carry |
| `max_commits` | u32 | Commits a round can hold |
| `max_order_size` | u64 | Largest order, in GPU-hours |
| `reporters` | account ids | Accounts allowed to report the index. 1 to 9, no duplicates |
| `quorum` | u32 | Reports needed to finalize a print, `1 <= quorum <= reporters.len()` |

`new` panics unless: every duration is above zero; `tick > 0`; `0 < band_bps < 10000`;
`forfeit_bps <= 10000`; `max_commits` is 1 to 128; `max_order_size >= 1`;
`cutoff_secs < period_secs`; `min_prints >= 1`; reporters and quorum are as above.

## 4. Time

For series `s` (a `u32`):

```
delivery_start(s) = t0 + s * period_secs
delivery_end(s)   = delivery_start(s) + period_secs
auction_open(s)   = delivery_start(s) - lead_secs      (saturating at 0)
auction_close(s)  = delivery_end(s) - cutoff_secs
round_secs        = commit_secs + reveal_secs
round_start(s, r) = auction_open(s) + r * round_secs
```

Round `r` of series `s` exists if `round_start(s, r) + round_secs <= auction_close(s)`.
Its phases are:

- commit: `round_start <= now < round_start + commit_secs`
- reveal: `round_start + commit_secs <= now < round_start + round_secs`
- over: `now >= round_start + round_secs`. The round can be cleared.

Phases come from the clock alone. Nobody starts or ends a round.

## 5. Accounts and dollars

- `register(account_id?)`, payable. Attaches at least `REGISTRATION_FEE`
  (0.02 NEAR) and creates an account record for `account_id` or the caller. Anything
  above the fee is refunded. Registering twice panics. The fee is not returned; it
  pays for the account's storage.
- Deposit: send USDC with `ft_transfer_call` to the contract. `ft_on_transfer`
  credits the account named in `msg` if `msg` is not empty, otherwise the sender. If
  the token is not `usdc`, the call panics. If the account to credit is not
  registered, the whole amount is returned (the method returns `amount`).
- `withdraw(amount)`. Requires exactly 1 yoctoNEAR attached, so a function-call key
  cannot call it. Debits the caller's free balance and sends USDC with `ft_transfer`.
  If the transfer fails, the callback credits the amount back.
- `set_guard(guard?)`. Requires exactly 1 yoctoNEAR. Sets or clears the caller's
  guard (section 6.4).

Every account has a **free balance**. Locks, mints and auction costs are taken from
it; refunds, merges and payouts go to it.

## 6. Orders

### 6.1 Opening a series

A series record is created the first time `commit` or `mint` is called for it while
`auction_open(s) <= now < auction_close(s)`. Opening needs a last print with
`now - last_print.bucket <= max_anchor_age_secs`, otherwise the call panics with
`index is stale`.

```
anchor = last_print.price
mid    = anchor - (anchor % tick)
half   = (anchor * band_bps / 10000), rounded down to a multiple of tick
floor  = mid - half
band   = 2 * half
```

Opening panics if `half < tick` or `half > mid`. The second cannot happen with valid
parameters and is kept as a guard. `floor` and `band` never change.

### 6.2 Commit

`commit(series, hash, lock) -> seq`

- The caller is registered. `now` is in the commit phase of round
  `r = (now - auction_open(series)) / round_secs`, and round `r` exists.
- `hash` is 64 lowercase hex characters. `lock >= min_lock`. The caller's free
  balance covers `lock`, which moves from free balance into the commit.
- The commit gets `seq`, the round's next sequence number, starting at 0. Lower
  `seq` is earlier.
- If the round already holds `max_commits` commits, the new commit must carry a
  larger lock than the smallest lock in the round. The smallest one (the latest
  `seq` among equals) is removed and its lock returned to its owner in full. If the
  new lock is not larger, the call panics with `round is full`.
- An account may hold several commits in one round.

The hash is `sha256` of this UTF-8 string, in lowercase hex:

```
weir:v1|<series>|<round>|<account_id>|<side>|<size>|<price>|<salt>
```

`<side>` is `L` for LONG or `S` for SHORT. Numbers are decimal with no padding.
`<salt>` is 32 to 64 lowercase hex characters chosen by the caller.

Both sides lock dollars, so a commit shows neither side, size nor price; it shows
only an upper bound on what the order can cost.

### 6.3 Reveal

`reveal(series, round, seq, side, size, price, salt)`

- The caller owns commit `seq` of that round, it has not been revealed, and `now` is
  in the round's reveal phase.
- `salt` is 32 to 64 lowercase hex characters.
- The hash of the revealed values equals the committed hash.
- `1 <= size <= max_order_size`. `price` is a multiple of `tick` and
  `0 < price < band`.
- The lock covers the order: `size * price` for LONG, `size * (band - price)` for
  SHORT.

If any check fails the call panics and the commit stays unrevealed.

`price` is always a LONG price. For a LONG order it is the most the buyer will pay.
For a SHORT order it is the lowest LONG price the buyer accepts, so the most they
pay per unit is `band - price`.

### 6.4 Guard

An account may set a guard `g`, in micro-USD. At reveal, with
`ref = clamp(last_print.price - floor, 0, band)`:

- a LONG order with `price > ref + g` is void;
- a SHORT order with `price + g < ref` is void.

A void order takes no part in clearing. Its lock returns to the free balance at once
and nothing is forfeited. An account that holds only a function-call key cannot
change its guard. If there is no print yet, the guard is not applied.

## 7. Clearing

`clear(series, round)`. Anyone may call it once the round is over. It panics if the
round has no commits or was already cleared.

### 7.1 Price

Take the revealed, non-void orders. For a price `p`:

```
D(p) = total size of LONG orders with price >= p
S(p) = total size of SHORT orders with price <= p
V(p) = min(D(p), S(p))
```

The candidates are the distinct order prices.

1. Keep the candidates with the largest `V`. Call it `V*`. If `V* = 0` there is no
   trade and no clearing price.
2. Of those, keep the candidates with the smallest `|D(p) - S(p)|`.
3. Let `lo` and `hi` be the lowest and highest remaining candidates.
   - If `D(p) > S(p)` at every remaining candidate, the clearing price is `hi`.
   - If `D(p) < S(p)` at every remaining candidate, it is `lo`.
   - Otherwise it is `(lo + hi) / 2` rounded down to a multiple of `tick`.

Call the result `p*`. Every filled LONG pays `p*` per unit and every filled SHORT
pays `band - p*` per unit.

### 7.2 Fills

- LONG orders with `price >= p*` are filled in order of highest price first, then
  lowest `seq`, until `V*` units are filled.
- SHORT orders with `price <= p*` are filled in order of lowest price first, then
  lowest `seq`, until `V*` units are filled.

The last order filled on a side may be filled in part. Total LONG fill equals total
SHORT fill equals `V*`.

### 7.3 Accounting

For each commit of the round:

- Revealed with fill `f`: a LONG order costs `f * p*` and adds `f` to the owner's
  LONG position; a SHORT order costs `f * (band - p*)` and adds `f` to the owner's
  SHORT position. `lock - cost` returns to the free balance.
- Void: nothing to do, the lock went back at reveal.
- Not revealed: `forfeit = lock * forfeit_bps / 10000` (rounded down) goes to the
  series' bonus pool. `lock - forfeit` returns to the free balance.

`V*` is added to the series' `open_sets`. The contract stores a result for the round
(section 12) and deletes the round's book.

Every matched LONG unit and SHORT unit together paid `p* + (band - p*) = band`, so
the new sets are fully backed.

## 8. Mint, merge, transfer

- `mint(series, sets)`: during the auction window, `sets >= 1`. Costs `sets * band` from the free
  balance and adds `sets` to both the caller's LONG and SHORT. Adds `sets` to
  `open_sets`. Opens the series if needed.
- `merge(series, sets)`: before settlement, `sets >= 1`. Burns `sets` LONG and `sets` SHORT of the
  caller and credits `sets * band`. Subtracts `sets` from `open_sets`.
- `transfer_position(series, to, long, short)`: moves units to another registered
  account, before or after settlement. `long + short >= 1`. Requires exactly 1
  yoctoNEAR.

A holder leaves a position by buying the other side in an auction and merging.

## 9. Index

`report(bucket, price, bundle) -> bool`

- The caller is a reporter. `bucket` is a multiple of `print_interval_secs`.
- `bucket <= now < bucket + print_interval_secs + report_grace_secs`.
- `price > 0`. `bundle` is 64 lowercase hex characters: the `sha256` of the raw
  observations the reporter used.
- If the bucket's print is already final, the call does nothing and returns `false`.
  This is checked before the next rule.
- A reporter reports once per bucket; a second report panics.

After a report is stored, with `n` reports for the bucket:

```
candidate = median of the reports   (even count: mean of the two middle values, rounded down)
far = last print exists and |candidate - last.price| * 10000 > last.price * max_move_bps
```

`far` is measured against the contract's last print only when that print's bucket is
lower than this bucket. If there is no last print, or it is for this bucket or a later
one, `far` is false.

The print becomes final when `n >= quorum` and `far` is false, or when
`n = reporters.len()`. A print that is not final when its report window closes never
becomes final; that bucket has no print.

When a print becomes final:

- it is stored with its price and the reports behind it;
- if its bucket is higher than the last print's bucket, it becomes the last print;
- if `bucket >= t0`, with `s = (bucket - t0) / period_secs`, the accumulator of
  series `s` gains `sum += price` and `count += 1`.

`report` returns `true` when this call made the print final.

## 10. Settlement

`settle(series)`. Anyone may call it. It needs:

- a series record that is not settled;
- `now >= delivery_end + report_grace_secs`, when the report window of the last bucket
  of the delivery window has closed;
- no round of the series with commits still waiting to be cleared.

With the series' accumulator `(sum, count)`:

- if `count >= min_prints`: `fixing = sum / count` (rounded down), `void = false`;
- else if `now >= delivery_end + void_after_secs`: `fixing = sum / count` if
  `count >= 1`, otherwise `fixing = floor + band / 2`; `void = true`;
- else it panics with `not enough prints yet`.

```
long_payout  = min(max(fixing - floor, 0), band)
short_payout = band - long_payout
pool         = series.bonus_pool + carry_pool
if open_sets > 0:
    per_set     = pool / open_sets
    bonus_long  = per_set / 2
    bonus_short = per_set - bonus_long
    carry_pool  = pool - per_set * open_sets
else:
    bonus_long = bonus_short = 0
    carry_pool = pool
```

`redeem(series, account_id?)`. Anyone may call it for any account after settlement.
It credits `long * (long_payout + bonus_long) + short * (short_payout + bonus_short)`
to that account's free balance and deletes the position. It panics with
`nothing to redeem` if the account holds no position in the series.

## 11. Invariants

These hold after every call and are checked by property tests.

1. **Solvency.** The USDC the contract holds is at least: all free balances, plus all
   commit locks, plus `open_sets * band` for every unsettled series, plus every bonus
   pool and the carry pool, plus everything not yet redeemed on settled series.
2. **Sets.** For every series, total LONG equals total SHORT equals `open_sets`
   until it is settled.
3. **Clearing.** Total LONG fill equals total SHORT fill. No order is filled above its
   size. No LONG is filled at a price above its limit and no SHORT below its limit.
4. **No better price.** No other tick price trades more volume than `p*`.
5. **Bounded loss.** An account can never lose more than it locked or paid.

## 12. Views

All views are free and take JSON.

| Method | Returns |
|---|---|
| `get_params()` | The parameters of section 3 |
| `get_status()` | `{ now, live: [{ series, delivery_start, delivery_end, auction_open, auction_close, round, phase, phase_ends_at }] }` for every series whose auction window contains `now`. `phase` is `Commit` or `Reveal`; `round` is null and `phase` is `Closed` when no round is in progress |
| `get_series(series)` | `{ series, anchor, floor, band, opened_at, open_sets, bonus_pool, pending_rounds, settlement }` or null. `settlement` is null or `{ fixing, long_payout, short_payout, bonus_long, bonus_short, prints, void, settled_at }` |
| `get_account(account_id)` | `{ balance, guard }` or null |
| `get_position(series, account_id)` | `{ long, short }` |
| `get_round(series, round)` | `{ next_seq, commits: [{ seq, owner, lock, state, order }] }` or null once cleared. `state` is `Committed`, `Revealed` or `Void`; `order` is `{ side, size, price }` once revealed |
| `get_result(series, round)` | `{ price, volume, long_size, short_size, orders, commits, forfeited, cleared_at, fills: [{ seq, owner, side, size, price, filled }] }` or null |
| `get_results(series, from_round, limit)` | `[[round, result], ...]` for the rounds in range that have a result |
| `get_print(bucket)` | `{ bucket, price, final, reports: [{ reporter, price, bundle }] }` or null |
| `get_last_print()` | `{ bucket, price }` or null |
| `get_prints(from_bucket, limit)` | Final prints from `from_bucket` upward, at most `limit` (up to 200) |
| `get_accumulator(series)` | `{ sum, count }` |
| `get_totals()` | `{ free, locked, sets_backing, pools, unredeemed }`, the five terms of invariant 1 |
| `commit_hash(series, round, account_id, side, size, price, salt)` | The hash of section 6.2, so a client can check its own |

Dollar amounts in JSON are decimal strings. Prices, sizes and times are numbers.
`side` is `"Long"` or `"Short"`.

Details:

- `get_status`: `phase_ends_at` is null when `phase` is `Closed`.
- `get_result`: `long_size`, `short_size` and `orders` count the revealed orders that
  are not void. `commits` counts every commit the round held when it was cleared.
  `price` is null when nothing traded.
- `get_results`: the range is `from_round` to `from_round + limit - 1`.
- `get_print`: `price` is null until the print is final.
- `get_results`: a `limit` above 100 is treated as 100.
- `get_accumulator`: `sum` is a decimal string, `count` a number.

Return values of the state-changing methods: `commit` returns the commit's `seq`
(a number) and `report` returns a boolean. Every other method returns nothing.

## 13. Events

Every state change logs one NEP-297 event: `EVENT_JSON:{"standard":"weir","version":"1.0.0","event":<name>,"data":{...}}`.

| Event | Data |
|---|---|
| `register` | `account_id` |
| `deposit` | `account_id`, `amount` |
| `withdraw` | `account_id`, `amount` |
| `withdraw_failed` | `account_id`, `amount` |
| `series_opened` | `series`, `anchor`, `floor`, `band` |
| `commit` | `series`, `round`, `seq`, `account_id`, `lock` |
| `evict` | `series`, `round`, `seq`, `account_id`, `lock` |
| `reveal` | `series`, `round`, `seq`, `account_id`, `side`, `size`, `price`, `void` |
| `clear` | `series`, `round`, `price`, `volume`, `forfeited` |
| `mint`, `merge` | `series`, `account_id`, `sets` |
| `transfer_position` | `series`, `from`, `to`, `long`, `short` |
| `report` | `bucket`, `reporter`, `price`, `bundle` |
| `print` | `bucket`, `price`, `reports` (the number of reports behind it) |
| `settle` | `series`, `fixing`, `long_payout`, `short_payout`, `void` |
| `redeem` | `series`, `account_id`, `amount` |
| `guard` | `account_id`, `guard` |

## 14. Limits and gas

- A round holds at most `max_commits` commits, so `clear` does a bounded amount of
  work. The sandbox tests measure the gas of clearing a full round and the README
  reports it.
- `clear` must fit in one transaction (300 Tgas) at `max_commits`.
- Results keep their fills. `prune_result(series, round)` deletes a result once its
  series is settled; anyone may call it.

## 15. Trust

- **Reporters.** The index is whatever `quorum` of the reporters say it is. A print
  is the median of their reports, a large move needs all of them, and every report
  carries the hash of the raw data behind it, which is published so anyone can
  recompute it. Reporters cannot take funds; they can move the fixing.
- **USDC.** The contract trusts the `usdc` token contract.
- **No admin.** There is no owner, pause, fee switch or upgrade method. Once the
  contract account's keys are deleted, the code cannot change.
- **Agents.** An account that holds only a function-call key limited to `commit`,
  `reveal`, `clear`, `mint`, `merge` and `redeem` can trade with the dollars already
  deposited for it. It cannot withdraw, cannot move positions and cannot change its
  guard, because those need 1 yoctoNEAR.
