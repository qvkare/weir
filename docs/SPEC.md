# Weir specification

Version 0.4. This file is the source of truth. The NEAR contract (`contracts/weir`) and
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
| `cutoff_secs` | u64 | How long before delivery starts the auctions for a series close. May be zero |
| `commit_secs` | u64 | Length of a round's commit phase |
| `reveal_secs` | u64 | Length of a round's reveal phase |
| `band_bps` | u32 | Half-width of the band as basis points of the anchor |
| `tick` | u64 | Price increment |
| `print_interval_secs` | u64 | Spacing of index prints |
| `report_grace_secs` | u64 | How long after a bucket ends a report for it is still accepted |
| `max_spread_bps` | u32 | How far apart the two middle reports may be when an even number of reporters decide a print |
| `min_prints` | u32 | Prints a series needs for a normal settlement |
| `void_after_secs` | u64 | After `delivery_end + void_after_secs` a series can settle without `min_prints` |
| `max_anchor_age_secs` | u64 | Oldest print a series may be opened on |
| `forfeit_bps` | u32 | Share of its lock a commit loses if it is not revealed |
| `min_lock` | u128 | Smallest lock a commit may carry |
| `commit_fee` | u128 | Dollars burned for every commit that reaches clearing. May be zero |
| `max_commits` | u32 | Commits a round can hold |
| `max_order_size` | u64 | Largest order, in GPU-hours |
| `reporters` | account ids | Accounts allowed to report the index. 1 to 9, no duplicates |
| `quorum` | u32 | Reports needed to finalize a print, `1 <= quorum <= reporters.len()` |

`new` panics unless: every duration except `cutoff_secs` is above zero; `tick > 0`; `0 < band_bps < 10000`;
`forfeit_bps <= 10000`; `max_commits` is 1 to 128; `max_order_size >= 1`;
`cutoff_secs < lead_secs`; `1 <= min_prints <= period_secs / print_interval_secs`;
`void_after_secs >= report_grace_secs`; `report_grace_secs <= period_secs`, so a bucket
can never take a report after it may be pruned; `0 < max_spread_bps <= 10000`;
`max_order_size * max_commits * rounds_per_series < 2^52`, where `rounds_per_series =
(lead_secs - cutoff_secs) / round_secs`; `t0` and `period_secs` are multiples of
`print_interval_secs`, so a delivery window is a whole number of print buckets;
reporters and quorum are as above.

## 4. Time

For series `s` (a `u32`):

```
delivery_start(s) = t0 + s * period_secs
delivery_end(s)   = delivery_start(s) + period_secs
auction_open(s)   = delivery_start(s) - lead_secs      (saturating at 0)
auction_close(s)  = delivery_start(s) - cutoff_secs    (saturating at 0)
round_secs        = commit_secs + reveal_secs
round_start(s, r) = auction_open(s) + r * round_secs
```

Round `r` of series `s` exists if `round_start(s, r) + round_secs <= auction_close(s)`.
Its phases are:

- commit: `round_start <= now < round_start + commit_secs`
- reveal: `round_start + commit_secs <= now < round_start + round_secs`
- over: `now >= round_start + round_secs`. The round can be cleared.

Phases come from the clock alone. Nobody starts or ends a round.

Auctions for a series end before its delivery window starts: this is a week-ahead
market. With `lead_secs = period_secs + cutoff_secs` the auction windows of
consecutive series follow each other with no gap and no overlap, so exactly one
series is in auction at any time.

## 5. Accounts and dollars

- `register(account_id?)`, payable. Attaches at least `REGISTRATION_FEE`
  (0.02 NEAR) and creates an account record for `account_id` or the caller. Anything
  above the fee is refunded. Registering twice panics. The fee is not returned; it
  pays for the account's storage.
- Deposit: send USDC with `ft_transfer_call` to the contract. `ft_on_transfer`
  credits the account named in `msg` if `msg` is not empty, otherwise the sender. If
  the token is not `usdc`, the call panics. If `msg` is not a valid account id, or the
  account to credit is not registered, the whole amount is returned (the method
  returns `amount`).
- `withdraw(amount)`, `amount >= 1`. Requires exactly 1 yoctoNEAR attached, so a function-call key
  cannot call it. Debits the caller's free balance and sends USDC with `ft_transfer`.
  If the transfer fails, the callback credits the amount back.
- `set_guard(guard?, max_round_lock?)`. Requires exactly 1 yoctoNEAR. Sets or clears
  the caller's two limits (section 6.4): `guard`, a price distance in micro-USD, and
  `max_round_lock`, the most the account's commits may lock in one round.

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
  balance covers `lock + commit_fee`; both move from the free balance into the commit.
- If the caller has a `max_round_lock`, the locks of all its commits in this round,
  this one included, may not exceed it. Otherwise the call panics with
  `over the round lock limit`.
- The commit records the caller's `guard` and the reference price
  `ref = clamp(last_print.price - floor, 0, band)` as they are at this moment.
- The commit gets `seq`, the round's next sequence number, starting at 0. Lower
  `seq` is earlier.
- If the round already holds `max_commits` commits, the new commit must carry a
  larger lock than the smallest lock in the round. The smallest one (the latest
  `seq` among equals) is removed and its lock and fee returned to its owner in full. If the
  new lock is not larger, the call panics with `round is full`.
- An account may hold several commits in one round.
- The checks run in this order: the caller is registered, the phase, the hash and
  the minimum lock, the free balance, the round lock limit (counted over the caller's
  commits in the round before any eviction this commit causes), then whether the
  round is full.

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

An account may set a guard `g`, in micro-USD. It is applied at reveal, using the
guard and the reference `ref` that the commit recorded when it was made
(section 6.2), not the values at reveal time:

- a LONG order with `price > ref + g` is void;
- a SHORT order with `price + g < ref` is void.

A void order takes no part in clearing. Its lock returns to the free balance at once
and nothing is forfeited; its fee stays with the round. Because the guard and the
reference are fixed at commit, whether an order is void is settled the moment it is
committed, so changing the guard afterwards cannot be used to back out of a bid.

An account that holds only a function-call key cannot change its guard or its
`max_round_lock`. Together they bound what a faulty or hijacked agent can do: it
cannot bid further than `g` from the reference, and it cannot put more than
`max_round_lock` at risk of forfeit in a round.

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
- Not revealed: `forfeit = lock * forfeit_bps / 10000` (rounded down) is burned.
  `lock - forfeit` returns to the free balance.

The fee of every commit the round holds at clearing is burned too. **Burned** dollars
stay in the contract and belong to nobody: there is no method that pays them out.
They are burned rather than shared so that nobody can profit from another account's
forfeit, and so that taking a slot in a round always costs something.

`V*` is added to the series' `open_sets`. The contract stores a result for the round
(section 12) and deletes the round's book.

Every matched LONG unit and SHORT unit together paid `p* + (band - p*) = band`, so
the new sets are fully backed.

## 8. Mint, merge, transfer

- `mint(series, sets)`: during the auction window, `sets >= 1`. Costs `sets * band` from the free
  balance and adds `sets` to both the caller's LONG and SHORT. Adds `sets` to
  `open_sets`. Opens the series if needed. It panics with `too many sets` if
  `open_sets` would exceed `2^53 - 1 - max_order_size * max_commits *
  rounds_per_series`; the margin is what the series' auctions can still add, so
  `clear` can never overflow and no unit count ever exceeds what JSON can carry.
- `merge(series, sets)`: before settlement, `sets >= 1`. Burns `sets` LONG and `sets` SHORT of the
  caller and credits `sets * band`. Subtracts `sets` from `open_sets`.
- `transfer_position(series, to, long, short)`: moves units to another registered
  account, before or after settlement. `to` may not be the caller. `long + short >= 1`. Requires exactly 1
  yoctoNEAR.

A holder leaves a position by buying the other side in an auction and merging.

## 9. Index

`report(bucket, price, bundle) -> bool`

- The caller is a reporter. `bucket` is a multiple of `print_interval_secs`.
- `bucket <= now < bucket + print_interval_secs + report_grace_secs`. This is the
  bucket's **report window**.
- `price > 0`. `bundle` is 64 lowercase hex characters: the `sha256` of the raw
  observations the reporter used.
- If the bucket is already decided, the call does nothing and returns `false`. This
  is checked before the next rule.
- A reporter reports once per bucket; a second report panics.

A bucket is **decided** once, at the first of these moments:

- every reporter has reported for it (inside `report`);
- its report window has closed and someone calls `finalize_print(bucket)`, or a later
  `report` or a `settle` reaches it (below).

Deciding a bucket with `n` reports, sorted ascending:

```
if n < quorum:                      no print
if n is odd:   price = the middle report
if n is even:  lo, hi = the two middle reports
               if (hi - lo) * 10000 > lo * max_spread_bps:   no print
               price = (lo + hi) / 2, rounded down
```

A bucket decided with a price has a **final print**. A bucket decided without one
has no print, for good. Nothing compares a print with earlier prints.

When a print becomes final:

- it is stored with its price and the reports behind it;
- if its bucket is higher than the last print's bucket, it becomes the last print;
- if `bucket >= t0`, with `s = (bucket - t0) / period_secs`, the accumulator of
  series `s` gains `sum += price` and `count += 1`.

`report` returns `true` when this call gave the bucket a final print. Before it
returns, `report` also decides up to four earlier buckets that have reports, are
undecided and whose report window has closed, oldest first. The events are logged in
this order: `report`, then `print` or `no_print` for the reported bucket if this
call decided it, then the events of the earlier buckets.

`finalize_print(bucket) -> bool`. Anyone may call it once the bucket's report window
has closed. The bucket must have at least one report and be undecided, otherwise the
call panics. It decides the bucket and returns whether it got a final print.

`prune_print(bucket)`. Anyone may call it for a decided bucket once
`now >= bucket + 2 * period_secs`. It deletes the stored reports and price of that
bucket. The last print and the accumulators are kept separately and are not
affected.

Why these rules: with every reporter present the print is the median, which fewer
than half of them cannot move beyond what the others report. When a reporter is
missing and an even number decide, they must agree with each other within
`max_spread_bps`; a single reporter can then stop a print by disagreeing, and can
move it by at most half that tolerance, but cannot steer it.

## 10. Settlement

`settle(series)`. Anyone may call it. It needs:

- a series record that is not settled;
- `now >= delivery_end + report_grace_secs`, when the report window of the last bucket
  of the delivery window has closed;
- no round of the series with commits still waiting to be cleared.

It first decides every undecided bucket of the delivery window that has reports
(their windows have all closed). Then, with the series' accumulator `(sum, count)`:

- if `count >= min_prints`: `fixing = sum / count` (rounded down), `void = false`;
- else if `now >= delivery_end + void_after_secs`: `fixing = sum / count` if
  `count >= 1`, otherwise `fixing = floor + band / 2`; `void = true`;
- else it panics with `not enough prints yet`.

```
long_payout  = min(max(fixing - floor, 0), band)
short_payout = band - long_payout
```

`redeem(series, account_id?)`. Anyone may call it for any account after settlement.
It credits `long * long_payout + short * short_payout` to that account's free balance
and deletes the position. It panics with `nothing to redeem` if the account holds no
position in the series.

## 11. Invariants

These hold after every call and are checked by property tests.

1. **Solvency.** The USDC the contract holds equals: all free balances, plus all
   commit locks and fees held in rounds not yet cleared, plus `open_sets * band` for
   every unsettled series, plus everything not yet redeemed on settled series, plus
   everything burned.
2. **Sets.** For every series, total LONG equals total SHORT equals `open_sets`
   until it is settled, and `open_sets` never exceeds `2^53 - 1`.
3. **Clearing.** Total LONG fill equals total SHORT fill. No order is filled above its
   size. No LONG is filled at a price above its limit and no SHORT below its limit.
4. **No better price.** No other tick price trades more volume than `p*`.
5. **Bounded loss.** An account can never lose more than it locked or paid.
6. **No gain from a forfeit.** No account's balance can rise because another
   account's commit was not revealed.
7. **Always clearable.** A round that is over can be cleared, and a series whose
   rounds are cleared can be settled once its time comes, whatever anyone did.

## 12. Views

All views are free and take JSON.

| Method | Returns |
|---|---|
| `get_params()` | The parameters of section 3 |
| `get_status()` | `{ now, live: [{ series, delivery_start, delivery_end, auction_open, auction_close, round, phase, phase_ends_at }] }` for every series whose auction window contains `now`. `phase` is `Commit` or `Reveal`; `round` is null and `phase` is `Closed` when no round is in progress |
| `get_series(series)` | `{ series, anchor, floor, band, opened_at, open_sets, pending_rounds, settlement }` or null. `settlement` is null or `{ fixing, long_payout, short_payout, prints, void, settled_at }` |
| `get_account(account_id)` | `{ balance, guard, max_round_lock }` or null |
| `get_position(series, account_id)` | `{ long, short }` |
| `get_round(series, round)` | `{ next_seq, commits: [{ seq, owner, hash, lock, fee, state, order }] }` or null once cleared. `state` is `Committed`, `Revealed` or `Void`; `order` is `{ side, size, price }` once revealed |
| `get_result(series, round)` | `{ price, volume, long_size, short_size, orders, commits, forfeited, fees, cleared_at, fills: [{ seq, owner, side, size, price, filled }] }` or null |
| `get_results(series, from_round, limit)` | `[[round, result], ...]` for the rounds in range that have a result |
| `get_print(bucket)` | `{ bucket, price, state, reports: [{ reporter, price, bundle }] }` or null. `state` is `Open`, `Final` or `NoPrint` |
| `get_pending_prints()` | The undecided buckets that have reports, ascending |
| `get_last_print()` | `{ bucket, price }` or null |
| `get_prints(from_bucket, limit)` | Final prints from `from_bucket` upward, at most `limit` (up to 200) |
| `get_accumulator(series)` | `{ sum, count }` |
| `get_totals()` | `{ free, locked, sets_backing, unredeemed, burned }`, the five terms of invariant 1 |
| `commit_hash(series, round, account_id, side, size, price, salt)` | The hash of section 6.2, so a client can check its own |

Dollar amounts in JSON are decimal strings. Prices, sizes and times are numbers.
`side` is `"Long"` or `"Short"`.

Details:

- `get_status`: `phase_ends_at` is null when `phase` is `Closed`. At most 32 series are
  listed.
- `get_series`: `pending_rounds` is the list of round numbers, ascending, that hold
  commits and have not been cleared. A series can be settled only when it is empty.
- `get_result`: `long_size`, `short_size` and `orders` count the revealed orders that
  are not void. `commits` counts every commit the round held when it was cleared.
  `price` is null when nothing traded.
- `get_results`: the range is `from_round` to `from_round + limit - 1`.
- `get_print`: `price` is null unless `state` is `Final`. A pruned bucket returns null.
- `get_result`: `fills` lists only the orders that were filled, in `seq` order.
  `forfeited` and `fees` are what the round burned.
- `get_results`: a `limit` above 100 is treated as 100.
- `get_accumulator`: `sum` is a decimal string, `count` a number.

Return values of the state-changing methods: `commit` returns the commit's `seq`
(a number), `report` and `finalize_print` return a boolean, and `ft_on_transfer` returns the amount to send
back, as the token standard requires. Every other method returns nothing.

## 13. Events

Every state change logs one NEP-297 event: `EVENT_JSON:{"standard":"weir","version":"1.0.0","event":<name>,"data":{...}}`.

| Event | Data |
|---|---|
| `register` | `account_id` |
| `deposit` | `account_id`, `amount` |
| `withdraw` | `account_id`, `amount` |
| `withdraw_failed` | `account_id`, `amount` |
| `series_opened` | `series`, `anchor`, `floor`, `band` |
| `commit` | `series`, `round`, `seq`, `account_id`, `hash`, `lock`, `fee` |
| `evict` | `series`, `round`, `seq`, `account_id`, `lock`, `fee` |
| `reveal` | `series`, `round`, `seq`, `account_id`, `side`, `size`, `price`, `void` |
| `clear` | `series`, `round`, `price`, `volume`, `forfeited`, `fees` |
| `mint`, `merge` | `series`, `account_id`, `sets` |
| `transfer_position` | `series`, `from`, `to`, `long`, `short` |
| `report` | `bucket`, `reporter`, `price`, `bundle` |
| `print` | `bucket`, `price`, `reports` (the number of reports behind it) |
| `no_print` | `bucket`, `reports` |
| `prune_print` | `bucket` |
| `prune_result` | `series`, `round` |
| `settle` | `series`, `fixing`, `long_payout`, `short_payout`, `void` |
| `redeem` | `series`, `account_id`, `amount` |
| `guard` | `account_id`, `guard`, `max_round_lock` |

## 14. Limits, gas and storage

- A round holds at most `max_commits` commits, so `clear` does a bounded amount of
  work. The sandbox tests measure the gas of clearing a full round and the README
  reports it. `clear` must fit in one transaction at `max_commits`.
- The contract pays for its own storage from its NEAR balance: the registration fees
  and whatever anyone sends it. Nothing it stores grows without bound: an account
  record is paid for by its registration; a round's book is deleted when the round
  is cleared; a result keeps only the orders that were filled and can be deleted with
  `prune_result(series, round)` once its series is settled; a print can be deleted
  with `prune_print` two periods after its bucket. Anyone may call the two prune
  methods. If the balance ever runs short, calls that add storage fail until someone
  sends the contract NEAR; no funds are at risk.

## 15. Trust

- **Reporters.** The index is what the reporters say it is. When all of them report,
  a print is the median of their reports, so fewer than half cannot move it past
  what the others say. When some are missing, at least `quorum` must report and, if
  an even number decide, the two middle reports must agree within `max_spread_bps`,
  or there is no print. A reporter can therefore stop a print when another is absent,
  which pushes a series towards the void rule of section 10, but cannot steer one.
  Every report carries the hash of the raw data behind it, which is published so
  anyone can recompute it. Reporters cannot take funds. A majority of reporters
  acting together can set the fixing.
- **USDC.** The contract trusts the `usdc` token contract.
- **No admin.** There is no owner, pause, fee switch or upgrade method. Once the
  contract account's keys are deleted, the code cannot change. `new` must be called
  in the transaction that deploys the code.
- **Agents.** An account that holds only a function-call key limited to `commit`,
  `reveal`, `clear`, `mint`, `merge`, `settle` and `redeem` can trade with the
  dollars already deposited for it. It cannot withdraw, cannot move positions and
  cannot change its guard or its round lock limit, because those need 1 yoctoNEAR.
  The worst such a key can do in a round is forfeit `forfeit_bps` of
  `max_round_lock`, pay `commit_fee` per commit, and trade at prices within the
  guard of the reference.
- **Blocking a round.** A round has `max_commits` slots. Someone can fill them, and a
  larger lock evicts a smaller one, so a determined bidder with capital can keep
  others out of a round; each slot they take costs them `commit_fee`. This raises
  the price of blocking; it does not make it impossible.

## 16. Error messages

When a call is refused, the contract panics with a fixed text. The texts are the
`ERR_*` constants of `contracts/weir/src/lib.rs`, listed in `contracts/README.md`,
and they are part of this specification: the engine refuses the same calls with the
same texts, and the integration test compares them call by call. A client may match
on them.
