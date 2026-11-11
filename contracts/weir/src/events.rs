//! Section 13: NEP-297 events, standard `weir`, version `1.0.0`. Each logs as
//! `EVENT_JSON:{"standard":"weir","version":"1.0.0","event":<name>,"data":{...}}`.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

use crate::types::Side;

#[near(event_json(standard = "weir"))]
pub enum WeirEvent {
    #[event_version("1.0.0")]
    Register { account_id: AccountId },
    #[event_version("1.0.0")]
    Deposit { account_id: AccountId, amount: U128 },
    #[event_version("1.0.0")]
    Withdraw { account_id: AccountId, amount: U128 },
    #[event_version("1.0.0")]
    WithdrawFailed { account_id: AccountId, amount: U128 },
    #[event_version("1.0.0")]
    SeriesOpened {
        series: u32,
        anchor: u64,
        floor: u64,
        band: u64,
    },
    #[event_version("1.0.0")]
    Commit {
        series: u32,
        round: u64,
        seq: u32,
        account_id: AccountId,
        hash: String,
        lock: U128,
    },
    #[event_version("1.0.0")]
    Evict {
        series: u32,
        round: u64,
        seq: u32,
        account_id: AccountId,
        lock: U128,
    },
    #[event_version("1.0.0")]
    Reveal {
        series: u32,
        round: u64,
        seq: u32,
        account_id: AccountId,
        side: Side,
        size: u64,
        price: u64,
        void: bool,
    },
    #[event_version("1.0.0")]
    Clear {
        series: u32,
        round: u64,
        price: Option<u64>,
        volume: u64,
        forfeited: U128,
    },
    #[event_version("1.0.0")]
    Mint {
        series: u32,
        account_id: AccountId,
        sets: u64,
    },
    #[event_version("1.0.0")]
    Merge {
        series: u32,
        account_id: AccountId,
        sets: u64,
    },
    #[event_version("1.0.0")]
    TransferPosition {
        series: u32,
        from: AccountId,
        to: AccountId,
        long: u64,
        short: u64,
    },
    #[event_version("1.0.0")]
    Report {
        bucket: u64,
        reporter: AccountId,
        price: u64,
        bundle: String,
    },
    /// `reports` is how many reports the print was made from.
    #[event_version("1.0.0")]
    Print { bucket: u64, price: u64, reports: u32 },
    #[event_version("1.0.0")]
    Settle {
        series: u32,
        fixing: u64,
        long_payout: u64,
        short_payout: u64,
        void: bool,
    },
    #[event_version("1.0.0")]
    Redeem {
        series: u32,
        account_id: AccountId,
        amount: U128,
    },
    #[event_version("1.0.0")]
    Guard {
        account_id: AccountId,
        guard: Option<u64>,
    },
}
