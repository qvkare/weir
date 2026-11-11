//! Weir: sealed-bid, fully collateralized week-ahead auctions on the price of a
//! GPU-hour. `docs/SPEC.md` is the source of truth; section numbers below refer to it.
//!
//! There is no owner, no admin method and no upgrade path. The only `#[private]`
//! method is the callback of `withdraw`.

pub mod clearing;
pub mod events;
pub mod hash;
pub mod index;
pub mod settlement;
pub mod time;
pub mod types;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

use crate::clearing::Order;
use crate::events::WeirEvent;
use crate::time::Phase;
use crate::types::*;

/// Section 5. Pays for the account record; never returned.
pub const REGISTRATION_FEE: NearToken = NearToken::from_millinear(20);
pub const FT_TRANSFER_GAS: Gas = Gas::from_tgas(10);
pub const ON_WITHDRAW_GAS: Gas = Gas::from_tgas(10);
/// The most prints `get_prints` returns.
pub const MAX_PRINTS: u32 = 200;
/// `get_prints` looks at most this many chunks of 64 buckets per call.
pub const MAX_PRINT_CHUNKS: u64 = 4_096;
/// Closed, undecided buckets that one `report` decides on its way out.
pub const DECIDE_PER_REPORT: usize = 4;
/// The largest unit count JSON carries exactly: 2^53 - 1.
pub const MAX_UNITS: u128 = (1 << 53) - 1;
/// The most rounds `get_results` looks at.
pub const MAX_RESULTS: u32 = 100;

pub const ERR_DURATION: &str = "every duration but cutoff_secs must be above zero";
pub const ERR_TICK: &str = "tick must be above zero";
pub const ERR_BAND_BPS: &str = "band_bps must be between 1 and 9999";
pub const ERR_FORFEIT_BPS: &str = "forfeit_bps must be at most 10000";
pub const ERR_MAX_COMMITS: &str = "max_commits must be 1 to 128";
pub const ERR_MAX_ORDER_SIZE: &str = "max_order_size must be at least 1";
pub const ERR_CUTOFF: &str = "cutoff_secs must be below lead_secs";
pub const ERR_BUCKET_GRID: &str =
    "t0 and period_secs must be multiples of print_interval_secs";
pub const ERR_MIN_PRINTS: &str = "min_prints must be at least 1";
pub const ERR_MIN_PRINTS_TOO_MANY: &str =
    "min_prints must be at most period_secs / print_interval_secs";
pub const ERR_VOID_AFTER: &str = "void_after_secs must be at least report_grace_secs";
pub const ERR_GRACE: &str = "report_grace_secs must be at most period_secs";
pub const ERR_MAX_SPREAD: &str = "max_spread_bps must be between 1 and 10000";
pub const ERR_CAPACITY: &str =
    "max_order_size * max_commits * rounds_per_series must be below 2^52";
pub const ERR_REPORTERS: &str = "reporters must be 1 to 9 accounts with no duplicates";
pub const ERR_QUORUM: &str = "quorum must be 1 to the number of reporters";
pub const ERR_QUORUM_MAJORITY: &str = "quorum must be a majority of the reporters";

pub const ERR_FEE: &str = "attach at least 0.02 NEAR to register";
pub const ERR_REGISTERED: &str = "account is already registered";
pub const ERR_NOT_REGISTERED: &str = "account is not registered";
pub const ERR_WRONG_TOKEN: &str = "only the usdc token can be deposited";
pub const ERR_ONE_YOCTO: &str = "requires exactly 1 yoctoNEAR attached";
pub const ERR_ZERO_AMOUNT: &str = "amount must be above zero";
pub const ERR_BALANCE: &str = "free balance is too low";

pub const ERR_STALE: &str = "index is stale";
pub const ERR_BAND_TOO_NARROW: &str = "band is narrower than one tick";
pub const ERR_BAND_TOO_WIDE: &str = "band is wider than the price";
pub const ERR_NOT_COMMIT_PHASE: &str = "not in a commit phase";
pub const ERR_BAD_HASH: &str = "hash must be 64 lowercase hex characters";
pub const ERR_LOCK_TOO_SMALL: &str = "lock is below min_lock";
pub const ERR_ROUND_FULL: &str = "round is full";
pub const ERR_ROUND_LOCK: &str = "over the round lock limit";

pub const ERR_NO_COMMIT: &str = "commit not found";
pub const ERR_NOT_OWNER: &str = "caller does not own this commit";
pub const ERR_ALREADY_REVEALED: &str = "commit is already revealed";
pub const ERR_NOT_REVEAL_PHASE: &str = "not in the reveal phase";
pub const ERR_BAD_SALT: &str = "salt must be 32 to 64 lowercase hex characters";
pub const ERR_HASH_MISMATCH: &str = "revealed values do not match the hash";
pub const ERR_BAD_SIZE: &str = "size must be 1 to max_order_size";
pub const ERR_BAD_PRICE: &str = "price must be a multiple of tick above 0 and below band";
pub const ERR_UNDER_LOCKED: &str = "lock does not cover the order";

pub const ERR_ROUND_NOT_OVER: &str = "round is not over";
pub const ERR_NO_COMMITS: &str = "round has no commits";
pub const ERR_CLEARED: &str = "round is already cleared";

pub const ERR_WINDOW_CLOSED: &str = "auction window is closed";
pub const ERR_ZERO_SETS: &str = "sets must be above zero";
pub const ERR_UNKNOWN_SERIES: &str = "series not found";
pub const ERR_SETTLED: &str = "series is settled";
pub const ERR_POSITION_TOO_SMALL: &str = "position is too small";
pub const ERR_SELF_TRANSFER: &str = "cannot transfer a position to yourself";
pub const ERR_NOTHING_TO_TRANSFER: &str = "long + short must be at least 1";
pub const ERR_TOO_MANY_SETS: &str = "too many sets";

pub const ERR_NOT_REPORTER: &str = "caller is not a reporter";
pub const ERR_BUCKET: &str = "bucket must be a multiple of print_interval_secs";
pub const ERR_REPORT_WINDOW: &str = "outside the report window of this bucket";
pub const ERR_ZERO_PRICE: &str = "price must be above zero";
pub const ERR_BAD_BUNDLE: &str = "bundle must be 64 lowercase hex characters";
pub const ERR_DUPLICATE_REPORT: &str = "reporter already reported this bucket";
pub const ERR_WINDOW_OPEN: &str = "the report window of this bucket has not closed";
pub const ERR_NO_REPORTS: &str = "bucket has no reports";
pub const ERR_DECIDED: &str = "bucket is already decided";
pub const ERR_UNDECIDED: &str = "bucket is not decided";
pub const ERR_PRUNE_TOO_EARLY: &str = "a print can be pruned two periods after its bucket";

pub const ERR_DELIVERY_NOT_OVER: &str = "the report window of the delivery has not closed";
pub const ERR_PENDING_ROUNDS: &str = "a round of the series is waiting to be cleared";
pub const ERR_NOT_ENOUGH_PRINTS: &str = "not enough prints yet";
pub const ERR_NOT_SETTLED: &str = "series is not settled";
pub const ERR_NO_POSITION: &str = "nothing to redeem";
pub const ERR_NO_RESULT: &str = "result not found";
pub const ERR_OVERFLOW: &str = "arithmetic overflow";

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

fn or_panic<T>(result: Result<T, &'static str>) -> T {
    result.unwrap_or_else(|err| env::panic_str(err))
}

fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b).unwrap_or_else(|| env::panic_str(ERR_OVERFLOW))
}

fn sub(a: u128, b: u128) -> u128 {
    a.checked_sub(b).unwrap_or_else(|| env::panic_str(ERR_OVERFLOW))
}

fn mul(a: u64, b: u64) -> u128 {
    u128::from(a) * u128::from(b)
}

fn add_units(a: u64, b: u64) -> u64 {
    a.checked_add(b).unwrap_or_else(|| env::panic_str(ERR_OVERFLOW))
}

fn now() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn require_one_yocto() {
    require!(
        env::attached_deposit() == NearToken::from_yoctonear(1),
        ERR_ONE_YOCTO
    );
}

/// Section 3, in the order the spec lists the rules.
pub fn check_params(params: &Params) -> Result<(), &'static str> {
    // `cutoff_secs` may be zero: auctions may run until delivery starts.
    let durations = [
        params.period_secs,
        params.lead_secs,
        params.commit_secs,
        params.reveal_secs,
        params.print_interval_secs,
        params.report_grace_secs,
        params.void_after_secs,
        params.max_anchor_age_secs,
    ];
    if !durations.iter().all(|&d| d > 0) {
        return Err(ERR_DURATION);
    }
    let checks = [
        (params.tick > 0, ERR_TICK),
        (params.band_bps > 0 && params.band_bps < 10_000, ERR_BAND_BPS),
        (params.forfeit_bps <= 10_000, ERR_FORFEIT_BPS),
        ((1..=128).contains(&params.max_commits), ERR_MAX_COMMITS),
        (params.max_order_size >= 1, ERR_MAX_ORDER_SIZE),
        (params.cutoff_secs < params.lead_secs, ERR_CUTOFF),
        (params.min_prints >= 1, ERR_MIN_PRINTS),
        (
            u64::from(params.min_prints) <= params.period_secs / params.print_interval_secs,
            ERR_MIN_PRINTS_TOO_MANY,
        ),
        (params.void_after_secs >= params.report_grace_secs, ERR_VOID_AFTER),
        (params.report_grace_secs <= params.period_secs, ERR_GRACE),
        (params.max_spread_bps > 0 && params.max_spread_bps <= 10_000, ERR_MAX_SPREAD),
    ];
    if let Some(&(_, err)) = checks.iter().find(|(ok, _)| !ok) {
        return Err(err);
    }
    // Below 2^52, so that `mint`'s cap leaves room for every auction of a series.
    if params.auction_capacity() >= 1 << 52 {
        return Err(ERR_CAPACITY);
    }
    // A delivery window is a whole number of print buckets, so its last bucket's
    // report window closes exactly when `settle` becomes possible.
    let interval = params.print_interval_secs;
    if !params.t0.is_multiple_of(interval) || !params.period_secs.is_multiple_of(interval) {
        return Err(ERR_BUCKET_GRID);
    }
    let reporters = &params.reporters;
    let distinct = reporters
        .iter()
        .enumerate()
        .all(|(i, r)| !reporters[..i].contains(r));
    if !(1..=9).contains(&reporters.len()) || !distinct {
        return Err(ERR_REPORTERS);
    }
    if params.quorum < 1 || params.quorum as usize > reporters.len() {
        return Err(ERR_QUORUM);
    }
    if params.quorum as usize * 2 <= reporters.len() {
        return Err(ERR_QUORUM_MAJORITY);
    }
    Ok(())
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Weir {
    params: Params,
    accounts: LookupMap<AccountId, Account>,
    positions: LookupMap<(u32, AccountId), Position>,
    series: LookupMap<u32, Series>,
    books: LookupMap<(u32, u64), Book>,
    results: LookupMap<(u32, u64), RoundResult>,
    prints: LookupMap<u64, Print>,
    /// Undecided buckets that have reports, ascending. Bounded: a bucket joins only
    /// while its report window is open, and every `report` decides up to
    /// `DECIDE_PER_REPORT` closed ones.
    pending: Vec<u64>,
    /// Which buckets have a stored final print, 64 buckets to a word, for
    /// `get_prints`. Pruning clears bits and deletes empty words.
    print_index: LookupMap<u64, u64>,
    /// The lowest bucket that ever had a final print, where `get_prints` starts.
    first_print: Option<u64>,
    /// Kept apart from `prints`, so pruning prints cannot touch them.
    accumulators: LookupMap<u32, Accumulator>,
    last_print: Option<LastPrint>,
    totals: Totals,
}

#[near]
impl Weir {
    /// Not `#[private]`: the contract has no owner, so deploy and call this in one
    /// transaction.
    #[init]
    pub fn new(params: Params) -> Self {
        or_panic(check_params(&params));
        Self {
            params,
            accounts: LookupMap::new(b"a"),
            positions: LookupMap::new(b"p"),
            series: LookupMap::new(b"s"),
            books: LookupMap::new(b"b"),
            results: LookupMap::new(b"r"),
            prints: LookupMap::new(b"i"),
            pending: Vec::new(),
            print_index: LookupMap::new(b"x"),
            first_print: None,
            accumulators: LookupMap::new(b"c"),
            last_print: None,
            totals: Totals::default(),
        }
    }

    // ---- Section 5: accounts and dollars ----

    #[payable]
    pub fn register(&mut self, account_id: Option<AccountId>) {
        let deposit = env::attached_deposit();
        require!(deposit >= REGISTRATION_FEE, ERR_FEE);
        let payer = env::predecessor_account_id();
        let account_id = account_id.unwrap_or_else(|| payer.clone());
        require!(!self.accounts.contains_key(&account_id), ERR_REGISTERED);
        self.accounts.insert(
            account_id.clone(),
            Account {
                balance: 0,
                guard: None,
                max_round_lock: None,
            },
        );
        let refund = deposit.saturating_sub(REGISTRATION_FEE);
        if !refund.is_zero() {
            Promise::new(payer).transfer(refund).detach();
        }
        WeirEvent::Register { account_id }.emit();
    }

    /// NEP-141 receiver. Returns the amount to refund: all of it when the account to
    /// credit is not registered, nothing otherwise.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        require!(
            env::predecessor_account_id() == self.params.usdc,
            ERR_WRONG_TOKEN
        );
        let account_id = if msg.is_empty() {
            sender_id
        } else {
            match msg.parse::<AccountId>() {
                Ok(account_id) => account_id,
                Err(_) => return amount,
            }
        };
        if !self.accounts.contains_key(&account_id) {
            return amount;
        }
        self.credit(&account_id, amount.0);
        WeirEvent::Deposit { account_id, amount }.emit();
        U128(0)
    }

    /// The 1 yoctoNEAR means a function-call key cannot call this.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) {
        require_one_yocto();
        require!(amount.0 > 0, ERR_ZERO_AMOUNT);
        let account_id = env::predecessor_account_id();
        self.debit(&account_id, amount.0);
        WeirEvent::Withdraw {
            account_id: account_id.clone(),
            amount,
        }
        .emit();
        ext_ft::ext(self.params.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(account_id.clone(), amount, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_WITHDRAW_GAS)
                    .on_withdraw(account_id, amount),
            )
            .detach();
    }

    /// Credits the amount back if the transfer failed. Only a failed call proves the
    /// dollars did not leave, so any other outcome counts as sent.
    #[private]
    pub fn on_withdraw(&mut self, account_id: AccountId, amount: U128) {
        if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            self.credit(&account_id, amount.0);
            WeirEvent::WithdrawFailed { account_id, amount }.emit();
        }
    }

    #[payable]
    pub fn set_guard(&mut self, guard: Option<u64>, max_round_lock: Option<U128>) {
        require_one_yocto();
        let account_id = env::predecessor_account_id();
        let account = self.account_mut(&account_id);
        account.guard = guard;
        account.max_round_lock = max_round_lock.map(|limit| limit.0);
        WeirEvent::Guard {
            account_id,
            guard,
            max_round_lock,
        }
        .emit();
    }

    // ---- Section 6: orders ----

    /// Checks in the order of section 6.2: registered, phase, hash and minimum lock,
    /// free balance, round lock limit (before any eviction), round full.
    pub fn commit(&mut self, series: u32, hash: String, lock: U128) -> u32 {
        let owner = env::predecessor_account_id();
        require!(self.accounts.contains_key(&owner), ERR_NOT_REGISTERED);
        let now = now();
        let round = match self.params.schedule().current(series, now) {
            (Some(round), Phase::Commit) => round,
            _ => env::panic_str(ERR_NOT_COMMIT_PHASE),
        };
        let hash = hash::parse_digest(&hash).unwrap_or_else(|| env::panic_str(ERR_BAD_HASH));
        let lock = lock.0;
        require!(lock >= self.params.min_lock.0, ERR_LOCK_TOO_SMALL);
        let fee = self.params.commit_fee.0;
        let held = add(lock, fee);
        self.debit(&owner, held);
        self.totals.locked = add(self.totals.locked, held);
        self.open_series(series, now);

        let account = self.account_mut(&owner).clone();
        let (floor, band) = {
            let record = self.series_mut(series);
            (record.floor, record.band)
        };
        let reference = self
            .last_print
            .map(|last| last.price.saturating_sub(floor).min(band));
        let key = (series, round);
        if !self.books.contains_key(&key) {
            self.series_mut(series).pending_rounds.push(round);
            self.books.insert(key, Book::default());
        }
        let book = self
            .books
            .get_mut(&key)
            .unwrap_or_else(|| env::panic_str(ERR_NO_COMMIT));
        if let Some(limit) = account.max_round_lock {
            let mine = book
                .commits
                .iter()
                .filter(|c| c.owner == owner)
                .fold(lock, |sum, c| add(sum, c.lock));
            require!(mine <= limit, ERR_ROUND_LOCK);
        }
        let mut evicted = None;
        if book.commits.len() >= self.params.max_commits as usize {
            // The smallest lock goes; among equals, the latest.
            let (index, smallest) = book
                .commits
                .iter()
                .enumerate()
                .min_by_key(|(_, c)| (c.lock, std::cmp::Reverse(c.seq)))
                .unwrap_or_else(|| env::panic_str(ERR_ROUND_FULL));
            require!(lock > smallest.lock, ERR_ROUND_FULL);
            evicted = Some(book.commits.remove(index));
        }
        let seq = book.next_seq;
        book.next_seq = seq
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str(ERR_OVERFLOW));
        book.commits.push(Commit {
            seq,
            owner: owner.clone(),
            lock,
            fee,
            hash,
            guard: account.guard,
            reference,
            state: CommitState::Committed,
        });

        if let Some(evicted) = evicted {
            let back = add(evicted.lock, evicted.fee);
            self.totals.locked = sub(self.totals.locked, back);
            self.credit(&evicted.owner, back);
            WeirEvent::Evict {
                series,
                round,
                seq: evicted.seq,
                account_id: evicted.owner,
                lock: U128(evicted.lock),
                fee: U128(evicted.fee),
            }
            .emit();
        }
        WeirEvent::Commit {
            series,
            round,
            seq,
            account_id: owner,
            hash: hex::encode(hash),
            lock: U128(lock),
            fee: U128(fee),
        }
        .emit();
        seq
    }

    #[allow(clippy::too_many_arguments)]
    pub fn reveal(
        &mut self,
        series: u32,
        round: u64,
        seq: u32,
        side: Side,
        size: u64,
        price: u64,
        salt: String,
    ) {
        let caller = env::predecessor_account_id();
        let now = now();
        let schedule = self.params.schedule();
        let book = self
            .books
            .get_mut(&(series, round))
            .unwrap_or_else(|| env::panic_str(ERR_NO_COMMIT));
        let commit = book
            .commits
            .iter_mut()
            .find(|c| c.seq == seq)
            .unwrap_or_else(|| env::panic_str(ERR_NO_COMMIT));
        require!(commit.owner == caller, ERR_NOT_OWNER);
        require!(
            commit.state == CommitState::Committed,
            ERR_ALREADY_REVEALED
        );
        require!(
            schedule.reveal_start(series, round) <= now && now < schedule.round_end(series, round),
            ERR_NOT_REVEAL_PHASE
        );
        require!(hash::is_salt(&salt), ERR_BAD_SALT);
        let expected = hash::commit_hash(series, round, caller.as_str(), side, size, price, &salt);
        require!(expected == commit.hash, ERR_HASH_MISMATCH);
        require!(
            (1..=self.params.max_order_size).contains(&size),
            ERR_BAD_SIZE
        );
        let record = self
            .series
            .get(&series)
            .unwrap_or_else(|| env::panic_str(ERR_UNKNOWN_SERIES));
        let band = record.band;
        require!(
            price.is_multiple_of(self.params.tick) && price > 0 && price < band,
            ERR_BAD_PRICE
        );
        let cost = match side {
            Side::Long => mul(size, price),
            Side::Short => mul(size, band - price),
        };
        require!(cost <= commit.lock, ERR_UNDER_LOCKED);

        // Section 6.4, with the guard and reference the commit recorded. Without a
        // guard or a print there is nothing to compare with.
        let void = match (commit.guard, commit.reference) {
            (Some(guard), Some(reference)) => {
                let (price, guard, reference) =
                    (u128::from(price), u128::from(guard), u128::from(reference));
                match side {
                    Side::Long => price > reference + guard,
                    Side::Short => price + guard < reference,
                }
            }
            _ => false,
        };
        let order = OrderSpec { side, size, price };
        let lock = commit.lock;
        if void {
            commit.state = CommitState::Void(order);
            self.totals.locked = sub(self.totals.locked, lock);
            self.credit(&caller, lock);
        } else {
            commit.state = CommitState::Revealed(order);
        }
        WeirEvent::Reveal {
            series,
            round,
            seq,
            account_id: caller,
            side,
            size,
            price,
            void,
        }
        .emit();
    }

    // ---- Section 7: clearing ----

    pub fn clear(&mut self, series: u32, round: u64) {
        let now = now();
        require!(!self.results.contains_key(&(series, round)), ERR_CLEARED);
        let book = self
            .books
            .remove(&(series, round))
            .unwrap_or_else(|| env::panic_str(ERR_NO_COMMITS));
        require!(
            now >= self.params.schedule().round_end(series, round),
            ERR_ROUND_NOT_OVER
        );
        let band = self.series_mut(series).band;

        let orders: Vec<Order> = book
            .commits
            .iter()
            .filter_map(|c| match c.state {
                CommitState::Revealed(o) => Some(Order {
                    seq: c.seq,
                    side: o.side,
                    size: o.size,
                    price: o.price,
                }),
                _ => None,
            })
            .collect();
        let outcome = clearing::clear(&orders, self.params.tick);

        // Section 7.3. Credits and new units are gathered per account so each account
        // and position is written once.
        let mut credits: BTreeMap<AccountId, u128> = BTreeMap::new();
        let mut gains: BTreeMap<AccountId, Position> = BTreeMap::new();
        let mut released = 0u128;
        let mut forfeited = 0u128;
        let mut fees = 0u128;
        let mut fills = Vec::new();
        let mut next_order = 0;
        for commit in &book.commits {
            fees = add(fees, commit.fee);
            released = add(released, add(commit.held_lock(), commit.fee));
            let refund = match commit.state {
                CommitState::Void(_) => continue,
                CommitState::Committed => {
                    let forfeit = commit.lock * u128::from(self.params.forfeit_bps) / 10_000;
                    forfeited = add(forfeited, forfeit);
                    commit.lock - forfeit
                }
                CommitState::Revealed(order) => {
                    let filled = outcome.fills[next_order];
                    next_order += 1;
                    let unit_cost = match (outcome.price, order.side) {
                        (None, _) => 0,
                        (Some(p), Side::Long) => p,
                        (Some(p), Side::Short) => band - p,
                    };
                    if filled > 0 {
                        fills.push(Fill {
                            seq: commit.seq,
                            owner: commit.owner.clone(),
                            side: order.side,
                            size: order.size,
                            price: order.price,
                            filled,
                        });
                        let gain = gains.entry(commit.owner.clone()).or_default();
                        match order.side {
                            Side::Long => gain.long = add_units(gain.long, filled),
                            Side::Short => gain.short = add_units(gain.short, filled),
                        }
                    }
                    commit.lock - mul(filled, unit_cost)
                }
            };
            let credit = credits.entry(commit.owner.clone()).or_default();
            *credit = add(*credit, refund);
        }

        for (account_id, amount) in credits {
            self.credit(&account_id, amount);
        }
        for (account_id, gain) in gains {
            self.add_position(series, account_id, gain.long, gain.short);
        }
        self.totals.locked = sub(self.totals.locked, released);
        self.totals.sets_backing = add(self.totals.sets_backing, mul(outcome.volume, band));
        self.totals.burned = add(self.totals.burned, add(forfeited, fees));

        let record = self.series_mut(series);
        record.open_sets = add_units(record.open_sets, outcome.volume);
        if let Some(price) = outcome.price {
            // What the series' auctions traded, for unwinding it if it goes void.
            record.traded_units = add_units(record.traded_units, outcome.volume);
            record.traded_value = add(record.traded_value, mul(outcome.volume, price));
        }
        record.pending_rounds.retain(|&r| r != round);

        let size_of = |side: Side| {
            orders
                .iter()
                .filter(|o| o.side == side)
                .fold(0, |sum, o| add_units(sum, o.size))
        };
        self.results.insert(
            (series, round),
            RoundResult {
                price: outcome.price,
                volume: outcome.volume,
                long_size: size_of(Side::Long),
                short_size: size_of(Side::Short),
                orders: orders.len() as u32,
                commits: book.commits.len() as u32,
                forfeited: U128(forfeited),
                fees: U128(fees),
                cleared_at: now,
                fills,
            },
        );
        WeirEvent::Clear {
            series,
            round,
            price: outcome.price,
            volume: outcome.volume,
            forfeited: U128(forfeited),
            fees: U128(fees),
        }
        .emit();
    }

    // ---- Section 8: mint, merge, transfer ----

    pub fn mint(&mut self, series: u32, sets: u64) {
        require!(sets > 0, ERR_ZERO_SETS);
        let now = now();
        require!(
            self.params.schedule().in_window(series, now),
            ERR_WINDOW_CLOSED
        );
        let account_id = env::predecessor_account_id();
        self.open_series(series, now);
        // Section 8: room is left for everything the series' auctions can still add.
        let cap = MAX_UNITS - self.params.auction_capacity();
        let record = self.series_mut(series);
        require!(
            u128::from(record.open_sets) + u128::from(sets) <= cap,
            ERR_TOO_MANY_SETS
        );
        record.open_sets += sets;
        let cost = mul(sets, record.band);
        self.debit(&account_id, cost);
        self.totals.sets_backing = add(self.totals.sets_backing, cost);
        self.add_position(series, account_id.clone(), sets, sets);
        WeirEvent::Mint {
            series,
            account_id,
            sets,
        }
        .emit();
    }

    pub fn merge(&mut self, series: u32, sets: u64) {
        require!(sets > 0, ERR_ZERO_SETS);
        let account_id = env::predecessor_account_id();
        let record = self.series_mut(series);
        require!(record.settlement.is_none(), ERR_SETTLED);
        record.open_sets = record
            .open_sets
            .checked_sub(sets)
            .unwrap_or_else(|| env::panic_str(ERR_POSITION_TOO_SMALL));
        let value = mul(sets, record.band);
        self.take_position(series, &account_id, sets, sets);
        self.totals.sets_backing = sub(self.totals.sets_backing, value);
        self.credit(&account_id, value);
        WeirEvent::Merge {
            series,
            account_id,
            sets,
        }
        .emit();
    }

    #[payable]
    pub fn transfer_position(&mut self, series: u32, to: AccountId, long: u64, short: u64) {
        require_one_yocto();
        require!(self.accounts.contains_key(&to), ERR_NOT_REGISTERED);
        let from = env::predecessor_account_id();
        require!(from != to, ERR_SELF_TRANSFER);
        require!(
            u128::from(long) + u128::from(short) >= 1,
            ERR_NOTHING_TO_TRANSFER
        );
        self.take_position(series, &from, long, short);
        self.add_position(series, to.clone(), long, short);
        WeirEvent::TransferPosition {
            series,
            from,
            to,
            long,
            short,
        }
        .emit();
    }

    // ---- Section 9: index ----

    pub fn report(&mut self, bucket: u64, price: u64, bundle: String) -> bool {
        let reporter = env::predecessor_account_id();
        let params = &self.params;
        require!(params.reporters.contains(&reporter), ERR_NOT_REPORTER);
        require!(bucket.is_multiple_of(params.print_interval_secs), ERR_BUCKET);
        let now = now();
        require!(
            bucket <= now && now < self.window_end(bucket),
            ERR_REPORT_WINDOW
        );
        require!(price > 0, ERR_ZERO_PRICE);
        require!(hash::parse_digest(&bundle).is_some(), ERR_BAD_BUNDLE);

        let print = self.prints.entry(bucket).or_insert(Print {
            state: PrintState::Open,
            price: None,
            reports: Vec::new(),
        });
        if print.state != PrintState::Open {
            return false;
        }
        require!(
            print.reports.iter().all(|r| r.reporter != reporter),
            ERR_DUPLICATE_REPORT
        );
        print.reports.push(Report {
            reporter: reporter.clone(),
            price,
            bundle: bundle.clone(),
        });
        let reports = print.reports.len();
        WeirEvent::Report {
            bucket,
            reporter,
            price,
            bundle,
        }
        .emit();
        if reports == 1 {
            let at = self.pending.partition_point(|&b| b < bucket);
            self.pending.insert(at, bucket);
        }
        let made_final = reports == self.params.reporters.len() && self.decide(bucket);

        // Up to four earlier buckets whose windows have closed, oldest first.
        let closed: Vec<u64> = self
            .pending
            .iter()
            .copied()
            .filter(|&b| b < bucket && self.window_end(b) <= now)
            .take(DECIDE_PER_REPORT)
            .collect();
        for earlier in closed {
            self.decide(earlier);
        }
        made_final
    }

    /// Decides a bucket whose report window has closed. Returns whether it got a
    /// final print.
    pub fn finalize_print(&mut self, bucket: u64) -> bool {
        require!(now() >= self.window_end(bucket), ERR_WINDOW_OPEN);
        let print = self
            .prints
            .get(&bucket)
            .unwrap_or_else(|| env::panic_str(ERR_NO_REPORTS));
        require!(print.state == PrintState::Open, ERR_DECIDED);
        self.decide(bucket)
    }

    /// Deletes a decided bucket's reports and price. The last print and the
    /// accumulators are kept apart and do not change.
    pub fn prune_print(&mut self, bucket: u64) {
        let print = self
            .prints
            .get(&bucket)
            .unwrap_or_else(|| env::panic_str(ERR_NO_REPORTS));
        require!(print.state != PrintState::Open, ERR_UNDECIDED);
        let is_final = print.state == PrintState::Final;
        // `new` keeps report_grace_secs <= period_secs, so this is past the bucket's
        // report window too: no report can recreate a pruned bucket.
        let prunable = bucket.saturating_add(self.params.period_secs.saturating_mul(2));
        require!(now() >= prunable, ERR_PRUNE_TOO_EARLY);
        self.prints.remove(&bucket);
        if is_final {
            let (word, bit) = self.index_slot(bucket);
            let left = self.print_index.get(&word).copied().unwrap_or(0) & !(1 << bit);
            if left == 0 {
                self.print_index.remove(&word);
            } else {
                self.print_index.insert(word, left);
            }
        }
        WeirEvent::PrunePrint { bucket }.emit();
    }

    // ---- Section 10: settlement ----

    pub fn settle(&mut self, series: u32) {
        let now = now();
        let schedule = self.params.schedule();
        let (start, end) = (schedule.delivery_start(series), schedule.delivery_end(series));
        let (grace, void_after, min_prints) = (
            self.params.report_grace_secs,
            self.params.void_after_secs,
            self.params.min_prints,
        );
        let record = self.series_mut(series);
        require!(record.settlement.is_none(), ERR_SETTLED);
        require!(now >= end.saturating_add(grace), ERR_DELIVERY_NOT_OVER);
        require!(record.pending_rounds.is_empty(), ERR_PENDING_ROUNDS);

        // Every bucket of the window has closed; decide the ones still undecided.
        let window: Vec<u64> = self
            .pending
            .iter()
            .copied()
            .filter(|&b| start <= b && b < end)
            .collect();
        for bucket in window {
            self.decide(bucket);
        }

        let acc = self.accumulators.get(&series).copied().unwrap_or_default();
        let record = self.series_mut(series);
        let s = or_panic(settlement::settle(settlement::SettleInput {
            floor: record.floor,
            band: record.band,
            sum: acc.sum,
            count: acc.count,
            traded_units: record.traded_units,
            traded_value: record.traded_value,
            void_allowed: now >= end.saturating_add(void_after),
            min_prints,
        }));
        let backing = mul(record.open_sets, record.band);
        record.settlement = Some(SettlementView {
            fixing: s.fixing,
            long_payout: s.long_payout,
            short_payout: s.short_payout,
            prints: acc.count,
            void: s.void,
            settled_at: now,
        });
        // Each set pays long_payout + short_payout = band: the backing becomes owed.
        let totals = &mut self.totals;
        totals.sets_backing = sub(totals.sets_backing, backing);
        totals.unredeemed = add(totals.unredeemed, backing);
        WeirEvent::Settle {
            series,
            fixing: s.fixing,
            long_payout: s.long_payout,
            short_payout: s.short_payout,
            void: s.void,
        }
        .emit();
    }

    /// Anyone may redeem for any account.
    pub fn redeem(&mut self, series: u32, account_id: Option<AccountId>) {
        let account_id = account_id.unwrap_or_else(env::predecessor_account_id);
        let s = self
            .series
            .get(&series)
            .unwrap_or_else(|| env::panic_str(ERR_UNKNOWN_SERIES))
            .settlement
            .clone()
            .unwrap_or_else(|| env::panic_str(ERR_NOT_SETTLED));
        let position = self
            .positions
            .remove(&(series, account_id.clone()))
            .unwrap_or_else(|| env::panic_str(ERR_NO_POSITION));
        let amount = or_panic(settlement::payout(
            position.long,
            position.short,
            s.long_payout,
            s.short_payout,
        ));
        self.totals.unredeemed = sub(self.totals.unredeemed, amount);
        self.credit(&account_id, amount);
        WeirEvent::Redeem {
            series,
            account_id,
            amount: U128(amount),
        }
        .emit();
    }

    /// Section 14. Anyone may delete a settled series' round result.
    pub fn prune_result(&mut self, series: u32, round: u64) {
        let record = self
            .series
            .get(&series)
            .unwrap_or_else(|| env::panic_str(ERR_UNKNOWN_SERIES));
        require!(record.settlement.is_some(), ERR_NOT_SETTLED);
        require!(
            self.results.remove(&(series, round)).is_some(),
            ERR_NO_RESULT
        );
        WeirEvent::PruneResult { series, round }.emit();
    }

    // ---- Section 12: views ----

    pub fn get_params(&self) -> Params {
        self.params.clone()
    }

    pub fn get_status(&self) -> StatusView {
        let now = now();
        let schedule = self.params.schedule();
        let live = schedule
            .live_series(now)
            .into_iter()
            .map(|series| {
                let (round, phase) = schedule.current(series, now);
                let phase_ends_at = match (round, phase) {
                    (Some(r), Phase::Commit) => Some(schedule.reveal_start(series, r)),
                    (Some(r), _) => Some(schedule.round_end(series, r)),
                    (None, _) => None,
                };
                LiveSeries {
                    series,
                    delivery_start: schedule.delivery_start(series),
                    delivery_end: schedule.delivery_end(series),
                    auction_open: schedule.auction_open(series),
                    auction_close: schedule.auction_close(series),
                    round,
                    phase,
                    phase_ends_at,
                }
            })
            .collect();
        StatusView { now, live }
    }

    pub fn get_series(&self, series: u32) -> Option<SeriesView> {
        self.series.get(&series).map(|s| SeriesView {
            series,
            anchor: s.anchor,
            floor: s.floor,
            band: s.band,
            opened_at: s.opened_at,
            open_sets: s.open_sets,
            traded_units: s.traded_units,
            traded_value: U128(s.traded_value),
            pending_rounds: s.pending_rounds.clone(),
            settlement: s.settlement.clone(),
        })
    }

    pub fn get_account(&self, account_id: AccountId) -> Option<AccountView> {
        self.accounts.get(&account_id).map(|a| AccountView {
            balance: U128(a.balance),
            guard: a.guard,
            max_round_lock: a.max_round_lock.map(U128),
        })
    }

    pub fn get_position(&self, series: u32, account_id: AccountId) -> Position {
        self.positions
            .get(&(series, account_id))
            .copied()
            .unwrap_or_default()
    }

    pub fn get_round(&self, series: u32, round: u64) -> Option<RoundView> {
        self.books.get(&(series, round)).map(|book| RoundView {
            next_seq: book.next_seq,
            commits: book
                .commits
                .iter()
                .map(|c| {
                    let (state, order) = match c.state {
                        CommitState::Committed => (CommitStateName::Committed, None),
                        CommitState::Revealed(o) => (CommitStateName::Revealed, Some(o)),
                        CommitState::Void(o) => (CommitStateName::Void, Some(o)),
                    };
                    CommitView {
                        seq: c.seq,
                        owner: c.owner.clone(),
                        hash: hex::encode(c.hash),
                        lock: U128(c.lock),
                        fee: U128(c.fee),
                        state,
                        order,
                    }
                })
                .collect(),
        })
    }

    pub fn get_result(&self, series: u32, round: u64) -> Option<RoundResult> {
        self.results.get(&(series, round)).cloned()
    }

    /// The rounds `from_round ..= from_round + limit - 1` that have a result. A
    /// `limit` above `MAX_RESULTS` is treated as `MAX_RESULTS`.
    pub fn get_results(&self, series: u32, from_round: u64, limit: u32) -> Vec<(u64, RoundResult)> {
        let end = from_round.saturating_add(u64::from(limit.min(MAX_RESULTS)));
        (from_round..end)
            .filter_map(|round| {
                self.results
                    .get(&(series, round))
                    .map(|result| (round, result.clone()))
            })
            .collect()
    }

    pub fn get_print(&self, bucket: u64) -> Option<PrintView> {
        self.prints.get(&bucket).map(|p| PrintView {
            bucket,
            price: p.price,
            state: p.state,
            reports: p.reports.clone(),
        })
    }

    /// The undecided buckets that have reports, ascending.
    pub fn get_pending_prints(&self) -> Vec<u64> {
        self.pending.clone()
    }

    pub fn get_last_print(&self) -> Option<LastPrint> {
        self.last_print
    }

    /// Final prints from `from_bucket` upward, at most `limit` (up to 200). It walks
    /// the print index from the first final print ever made to the last print, and
    /// looks at no more than `MAX_PRINT_CHUNKS` words of 64 buckets per call.
    pub fn get_prints(&self, from_bucket: u64, limit: u32) -> Vec<PrintView> {
        let (Some(first), Some(last)) = (self.first_print, self.last_print) else {
            return Vec::new();
        };
        let interval = self.params.print_interval_secs;
        let from = from_bucket.div_ceil(interval).max(first / interval);
        let last = last.bucket / interval;
        let limit = limit.min(MAX_PRINTS) as usize;
        let mut prints = Vec::new();
        let mut word = from / 64;
        while word <= last / 64 && word < (from / 64).saturating_add(MAX_PRINT_CHUNKS) && prints.len() < limit {
            let mut bits = self.print_index.get(&word).copied().unwrap_or(0);
            if word == from / 64 {
                bits &= u64::MAX << (from % 64);
            }
            while bits != 0 && prints.len() < limit {
                let bit = u64::from(bits.trailing_zeros());
                bits &= bits - 1;
                prints.extend(self.get_print((word * 64 + bit) * interval));
            }
            word += 1;
        }
        prints
    }

    pub fn get_accumulator(&self, series: u32) -> AccumulatorView {
        let acc = self.accumulators.get(&series).copied().unwrap_or_default();
        AccumulatorView {
            sum: U128(acc.sum),
            count: acc.count,
        }
    }

    pub fn get_totals(&self) -> TotalsView {
        let t = self.totals;
        TotalsView {
            free: U128(t.free),
            locked: U128(t.locked),
            sets_backing: U128(t.sets_backing),
            unredeemed: U128(t.unredeemed),
            burned: U128(t.burned),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn commit_hash(
        &self,
        series: u32,
        round: u64,
        account_id: AccountId,
        side: Side,
        size: u64,
        price: u64,
        salt: String,
    ) -> String {
        require!(hash::is_salt(&salt), ERR_BAD_SALT);
        hex::encode(hash::commit_hash(
            series,
            round,
            account_id.as_str(),
            side,
            size,
            price,
            &salt,
        ))
    }
}

impl Weir {
    fn account_mut(&mut self, account_id: &AccountId) -> &mut Account {
        self.accounts
            .get_mut(account_id)
            .unwrap_or_else(|| env::panic_str(ERR_NOT_REGISTERED))
    }

    fn credit(&mut self, account_id: &AccountId, amount: u128) {
        let account = self.account_mut(account_id);
        account.balance = add(account.balance, amount);
        self.totals.free = add(self.totals.free, amount);
    }

    fn debit(&mut self, account_id: &AccountId, amount: u128) {
        let account = self.account_mut(account_id);
        account.balance = account
            .balance
            .checked_sub(amount)
            .unwrap_or_else(|| env::panic_str(ERR_BALANCE));
        self.totals.free = sub(self.totals.free, amount);
    }

    fn series_mut(&mut self, series: u32) -> &mut Series {
        self.series
            .get_mut(&series)
            .unwrap_or_else(|| env::panic_str(ERR_UNKNOWN_SERIES))
    }

    /// Section 6.1. The caller has checked that the auction window is open.
    fn open_series(&mut self, series: u32, now: u64) {
        if self.series.contains_key(&series) {
            return;
        }
        let last = self
            .last_print
            .filter(|last| now.saturating_sub(last.bucket) <= self.params.max_anchor_age_secs)
            .unwrap_or_else(|| env::panic_str(ERR_STALE));
        let b = or_panic(settlement::band(
            last.price,
            self.params.tick,
            self.params.band_bps,
        ));
        self.series.insert(
            series,
            Series {
                anchor: last.price,
                floor: b.floor,
                band: b.band,
                opened_at: now,
                open_sets: 0,
                traded_units: 0,
                traded_value: 0,
                pending_rounds: Vec::new(),
                settlement: None,
            },
        );
        WeirEvent::SeriesOpened {
            series,
            anchor: last.price,
            floor: b.floor,
            band: b.band,
        }
        .emit();
    }

    fn add_position(&mut self, series: u32, account_id: AccountId, long: u64, short: u64) {
        if long == 0 && short == 0 {
            return;
        }
        let position = self.positions.entry((series, account_id)).or_default();
        position.long = add_units(position.long, long);
        position.short = add_units(position.short, short);
    }

    /// An emptied position is deleted, so storage does not grow with churn.
    fn take_position(&mut self, series: u32, account_id: &AccountId, long: u64, short: u64) {
        let key = (series, account_id.clone());
        let position = self.positions.get(&key).copied().unwrap_or_default();
        let left = position
            .long
            .checked_sub(long)
            .zip(position.short.checked_sub(short))
            .unwrap_or_else(|| env::panic_str(ERR_POSITION_TOO_SMALL));
        match left {
            (0, 0) => {
                self.positions.remove(&key);
            }
            (long, short) => {
                self.positions.insert(key, Position { long, short });
            }
        }
    }

    /// The first second at which a report for `bucket` is no longer accepted.
    fn window_end(&self, bucket: u64) -> u64 {
        bucket
            .saturating_add(self.params.print_interval_secs)
            .saturating_add(self.params.report_grace_secs)
    }

    /// The word of `print_index` that holds `bucket`, and its bit there.
    fn index_slot(&self, bucket: u64) -> (u64, u64) {
        let slot = bucket / self.params.print_interval_secs;
        (slot / 64, slot % 64)
    }

    /// Section 9: decides an undecided bucket. Returns whether it got a final print.
    fn decide(&mut self, bucket: u64) -> bool {
        let (quorum, max_spread) = (self.params.quorum, self.params.max_spread_bps);
        let print = self
            .prints
            .get_mut(&bucket)
            .unwrap_or_else(|| env::panic_str(ERR_NO_REPORTS));
        let prices: Vec<u64> = print.reports.iter().map(|r| r.price).collect();
        let reports = prices.len() as u32;
        let price = index::decide(&prices, quorum, max_spread);
        print.state = if price.is_some() {
            PrintState::Final
        } else {
            PrintState::NoPrint
        };
        print.price = price;
        self.pending.retain(|&b| b != bucket);
        let Some(price) = price else {
            WeirEvent::NoPrint { bucket, reports }.emit();
            return false;
        };
        WeirEvent::Print {
            bucket,
            price,
            reports,
        }
        .emit();

        if self.last_print.is_none_or(|last| bucket > last.bucket) {
            self.last_print = Some(LastPrint { bucket, price });
        }
        if self.first_print.is_none_or(|first| bucket < first) {
            self.first_print = Some(bucket);
        }
        let (word, bit) = self.index_slot(bucket);
        let bits = self.print_index.get(&word).copied().unwrap_or(0) | (1 << bit);
        self.print_index.insert(word, bits);
        if bucket >= self.params.t0 {
            // A series number past u32 has no record and can never settle.
            if let Ok(series) = u32::try_from((bucket - self.params.t0) / self.params.period_secs) {
                let acc = self.accumulators.entry(series).or_default();
                acc.sum = add(acc.sum, u128::from(price));
                acc.count = acc
                    .count
                    .checked_add(1)
                    .unwrap_or_else(|| env::panic_str(ERR_OVERFLOW));
            }
        }
        true
    }
}
