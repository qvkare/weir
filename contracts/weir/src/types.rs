//! Stored records and view shapes. Dollar amounts are `u128` in storage and `U128`
//! (a decimal string) in JSON; prices, sizes and times are plain numbers (spec
//! sections 2 and 12).

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

use crate::time::{Phase, Schedule};

/// Section 3. Set once by `new`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Params {
    pub usdc: AccountId,
    pub underlying: String,
    pub t0: u64,
    pub period_secs: u64,
    pub lead_secs: u64,
    pub cutoff_secs: u64,
    pub commit_secs: u64,
    pub reveal_secs: u64,
    pub band_bps: u32,
    pub tick: u64,
    pub print_interval_secs: u64,
    pub report_grace_secs: u64,
    pub max_move_bps: u32,
    pub min_prints: u32,
    pub void_after_secs: u64,
    pub max_anchor_age_secs: u64,
    pub forfeit_bps: u32,
    pub min_lock: U128,
    pub max_commits: u32,
    pub max_order_size: u64,
    pub reporters: Vec<AccountId>,
    pub quorum: u32,
}

impl Params {
    pub fn schedule(&self) -> Schedule {
        Schedule {
            t0: self.t0,
            period_secs: self.period_secs,
            lead_secs: self.lead_secs,
            cutoff_secs: self.cutoff_secs,
            commit_secs: self.commit_secs,
            reveal_secs: self.reveal_secs,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Side {
    Long,
    Short,
}

impl Side {
    /// The letter used in the commit preimage (section 6.2).
    pub fn letter(self) -> char {
        match self {
            Side::Long => 'L',
            Side::Short => 'S',
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub balance: u128,
    pub guard: Option<u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Position {
    pub long: u64,
    pub short: u64,
}

/// What a reveal discloses.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OrderSpec {
    pub side: Side,
    pub size: u64,
    pub price: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitState {
    Committed,
    Revealed(OrderSpec),
    /// Revealed but voided by the owner's guard. The lock has already gone back.
    Void(OrderSpec),
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Commit {
    pub seq: u32,
    pub owner: AccountId,
    pub lock: u128,
    pub hash: [u8; 32],
    pub state: CommitState,
}

impl Commit {
    /// The dollars this commit still holds. A void commit's lock went back at reveal.
    pub fn held(&self) -> u128 {
        match self.state {
            CommitState::Void(_) => 0,
            _ => self.lock,
        }
    }
}

/// A round's book, stored as one value so `clear` reads and deletes it once.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Book {
    pub next_seq: u32,
    pub commits: Vec<Commit>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementView {
    pub fixing: u64,
    pub long_payout: u64,
    pub short_payout: u64,
    pub bonus_long: U128,
    pub bonus_short: U128,
    pub prints: u32,
    pub void: bool,
    pub settled_at: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Series {
    pub anchor: u64,
    pub floor: u64,
    pub band: u64,
    pub opened_at: u64,
    pub open_sets: u64,
    pub bonus_pool: u128,
    /// Rounds that hold commits and have not been cleared, in the order they got
    /// their first commit.
    pub pending_rounds: Vec<u64>,
    pub settlement: Option<SettlementView>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fill {
    pub seq: u32,
    pub owner: AccountId,
    pub side: Side,
    pub size: u64,
    pub price: u64,
    pub filled: u64,
}

/// What `clear` leaves behind for a round.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundResult {
    /// `p*`, or null when nothing traded.
    pub price: Option<u64>,
    pub volume: u64,
    /// Total size of the LONG orders that took part in clearing.
    pub long_size: u64,
    /// Total size of the SHORT orders that took part in clearing.
    pub short_size: u64,
    /// Orders that took part in clearing: revealed and not void.
    pub orders: u32,
    /// Commits the round held when it was cleared.
    pub commits: u32,
    pub forfeited: U128,
    pub cleared_at: u64,
    /// One entry per order that took part, in `seq` order, filled or not.
    pub fills: Vec<Fill>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub reporter: AccountId,
    pub price: u64,
    pub bundle: String,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Print {
    /// Set when the print becomes final.
    pub price: Option<u64>,
    pub reports: Vec<Report>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LastPrint {
    pub bucket: u64,
    pub price: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Accumulator {
    pub sum: u128,
    pub count: u32,
}

/// The five terms of invariant 1, kept as running totals.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Totals {
    pub free: u128,
    pub locked: u128,
    pub sets_backing: u128,
    pub pools: u128,
    pub unredeemed: u128,
}

// ---- View shapes (section 12) ----

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveSeries {
    pub series: u32,
    pub delivery_start: u64,
    pub delivery_end: u64,
    pub auction_open: u64,
    pub auction_close: u64,
    pub round: Option<u64>,
    pub phase: Phase,
    /// The end of the commit or reveal phase; null when `Closed`.
    pub phase_ends_at: Option<u64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusView {
    pub now: u64,
    pub live: Vec<LiveSeries>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeriesView {
    pub series: u32,
    pub anchor: u64,
    pub floor: u64,
    pub band: u64,
    pub opened_at: u64,
    pub open_sets: u64,
    pub bonus_pool: U128,
    pub pending_rounds: Vec<u64>,
    pub settlement: Option<SettlementView>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountView {
    pub balance: U128,
    pub guard: Option<u64>,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitStateName {
    Committed,
    Revealed,
    Void,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitView {
    pub seq: u32,
    pub owner: AccountId,
    pub hash: String,
    pub lock: U128,
    pub state: CommitStateName,
    pub order: Option<OrderSpec>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundView {
    pub next_seq: u32,
    pub commits: Vec<CommitView>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrintView {
    pub bucket: u64,
    /// Null until the print is final.
    pub price: Option<u64>,
    #[serde(rename = "final")]
    pub is_final: bool,
    pub reports: Vec<Report>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccumulatorView {
    pub sum: U128,
    pub count: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TotalsView {
    pub free: U128,
    pub locked: U128,
    pub sets_backing: U128,
    pub pools: U128,
    pub unredeemed: U128,
}
