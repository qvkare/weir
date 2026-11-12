//! Fourth audit pass (spec 0.6): the centre-of-band void rule, against a trader who
//! is NOT a reporter. Harness copied from audit3_void.rs.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

use near_sdk::json_types::U128;
use near_sdk::mock::with_mocked_blockchain;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{
    env, test_vm_config, AccountId, Gas, MockedBlockchain, NearToken, PromiseResult,
    RuntimeFeesConfig,
};
use weir::hash;
use weir::types::{Params, Side};
use weir::{Weir, REGISTRATION_FEE};

const USDC: &str = "usdc.near";
const STRANGER: &str = "stranger.near";
const R1: &str = "r1.near";
const R2: &str = "r2.near";
const R3: &str = "r3.near";
const SALT: &str = "00112233445566778899aabbccddeeff";
const BUNDLE: &str = "abababababababababababababababababababababababababababababababab";

const T0: u64 = 1_000_000;
const OPEN: u64 = T0 - 1_100;
const END: u64 = T0 + 1_000;
const PRICE: u64 = 2_000_000;
const DOLLAR: u128 = 1_000_000;
const FEE: u128 = 100_000; // the deployed ten-cent fee

fn id(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn params() -> Params {
    Params {
        usdc: id(USDC),
        underlying: "H100-USD-HR".into(),
        t0: T0,
        period_secs: 1_000,
        lead_secs: 1_100,
        cutoff_secs: 100,
        commit_secs: 60,
        reveal_secs: 40,
        band_bps: 1_000,
        tick: 1_000,
        print_interval_secs: 10,
        report_grace_secs: 20,
        max_spread_bps: 200,
        min_prints: 75, // 75% of the 100 buckets, as deployed
        void_after_secs: 500,
        max_anchor_age_secs: 300,
        forfeit_bps: 100,
        min_lock: U128(1_000),
        commit_fee: U128(FEE),
        max_commits: 64,
        max_order_size: 10_000,
        reporters: vec![id(R1), id(R2), id(R3)],
        quorum: 2,
    }
}

fn round_start(round: u64) -> u64 {
    OPEN + 100 * round
}
fn reveal_start(round: u64) -> u64 {
    round_start(round) + 60
}
fn round_end(round: u64) -> u64 {
    round_start(round) + 100
}

fn install(caller: &str, now: u64, deposit: u128, storage: HashMap<Vec<u8>, Vec<u8>>) {
    let context = VMContextBuilder::new()
        .current_account_id(id("weir.near"))
        .signer_account_id(id(caller))
        .predecessor_account_id(id(caller))
        .block_timestamp(now * 1_000_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300))
        .build();
    env::set_blockchain_interface(MockedBlockchain::new(
        context,
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Vec::<PromiseResult>::new(),
        storage,
        Default::default(),
        None,
    ));
}

fn message(payload: Box<dyn std::any::Any + Send>) -> String {
    let raw = payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    match raw.split_once("panic_msg: \"") {
        Some((_, rest)) => rest.trim_end_matches("\" })").to_string(),
        None => raw,
    }
}

struct H {
    now: u64,
}

impl H {
    fn with(params: Params) -> Self {
        install(STRANGER, OPEN - 100, 0, HashMap::new());
        env::state_write(&Weir::new(params));
        Self { now: OPEN - 100 }
    }
    fn at(&mut self, now: u64) -> &mut Self {
        self.now = now;
        let storage = with_mocked_blockchain(|b| b.take_storage());
        install(STRANGER, now, 0, storage);
        self
    }
    fn run<R>(
        &mut self,
        caller: &str,
        deposit: u128,
        f: impl FnOnce(&mut Weir) -> R,
    ) -> Result<R, String> {
        let storage = with_mocked_blockchain(|b| b.take_storage());
        install(caller, self.now, deposit, storage.clone());
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let mut weir: Weir = env::state_read().expect("initialized");
            let result = f(&mut weir);
            env::state_write(&weir);
            result
        }));
        outcome.map_err(|payload| {
            install(caller, self.now, deposit, storage);
            message(payload)
        })
    }
    fn ok<R>(&mut self, caller: &str, f: impl FnOnce(&mut Weir) -> R) -> R {
        self.run(caller, 0, f)
            .unwrap_or_else(|e| panic!("{caller}: {e}"))
    }
    fn view<R>(&mut self, f: impl FnOnce(&Weir) -> R) -> R {
        let storage = with_mocked_blockchain(|b| b.take_storage());
        install(STRANGER, self.now, 0, storage);
        let weir: Weir = env::state_read().expect("initialized");
        f(&weir)
    }
    fn fund(&mut self, name: &str, amount: u128) {
        self.run(name, REGISTRATION_FEE.as_yoctonear(), |w| w.register(None))
            .unwrap();
        let refund = self.ok(USDC, |w| {
            w.ft_on_transfer(id(name), U128(amount), String::new())
        });
        assert_eq!(refund, U128(0));
    }
    fn balance(&mut self, name: &str) -> u128 {
        self.view(|w| w.get_account(id(name)).map_or(0, |a| a.balance.0))
    }
    /// All three reporters report the current bucket: decided at once, the median.
    fn print_all(&mut self, price: u64) {
        let bucket = self.now - self.now % 10;
        for r in [R1, R2, R3] {
            self.ok(r, |w| w.report(bucket, price, BUNDLE.into()));
        }
    }
    fn commit(
        &mut self,
        round: u64,
        name: &str,
        side: Side,
        size: u64,
        price: u64,
        lock: u128,
    ) -> Result<u32, String> {
        let hash = hex::encode(hash::commit_hash(0, round, name, side, size, price, SALT));
        self.run(name, 0, |w| w.commit(0, hash, U128(lock)))
    }
    fn reveal(
        &mut self,
        round: u64,
        seq: u32,
        name: &str,
        side: Side,
        size: u64,
        price: u64,
    ) -> Result<(), String> {
        self.run(name, 0, |w| {
            w.reveal(0, round, seq, side, size, price, SALT.into())
        })
    }
    fn open_series(&mut self) {
        self.at(round_start(0) - 5);
        self.print_all(PRICE);
        self.at(round_start(0));
    }
}

/// Everything a non-reporter can do before a void: wash trades at an extreme price,
/// an honest trade, mints, a merge and position transfers, in several rounds. The
/// index then fails on its own (no reporter reports at all). The void pays exactly
/// band / 2 on each side, and every account's result is units * (band/2 - price paid)
/// less fees: ordinary price risk, nothing the trades moved. Solvency stays exact.
#[test]
fn audit4_a_non_reporter_cannot_move_the_void_payout() {
    let mut h = H::with(params());
    h.open_series();
    for (who, amt) in [
        ("bob.near", 100 * DOLLAR),
        ("m1.near", 5_000 * DOLLAR),
        ("m2.near", 5_000 * DOLLAR),
    ] {
        h.fund(who, amt);
    }
    let deposits = 10_100 * DOLLAR;
    // Round 0: m1 buys 100 LONG from Bob at 0.150 (below half the band, 0.200).
    let b = h
        .commit(0, "bob.near", Side::Short, 100, 150_000, 30 * DOLLAR)
        .unwrap();
    let m = h
        .commit(0, "m1.near", Side::Long, 100, 150_000, 15 * DOLLAR)
        .unwrap();
    h.ok("m1.near", |w| w.mint(0, 500));
    h.at(reveal_start(0));
    h.reveal(0, b, "bob.near", Side::Short, 100, 150_000)
        .unwrap();
    h.reveal(0, m, "m1.near", Side::Long, 100, 150_000).unwrap();
    h.at(round_end(0));
    h.ok(STRANGER, |w| w.clear(0, 0));
    // Rounds 1 and 2: wash trades at the extremes, 10,000 each.
    for (round, price) in [(1u64, 399_000u64), (2, 1_000)] {
        h.at(round_start(round));
        let l = h
            .commit(
                round,
                "m1.near",
                Side::Long,
                10_000,
                price,
                u128::from(price) * 10_000,
            )
            .unwrap();
        let s = h
            .commit(
                round,
                "m2.near",
                Side::Short,
                10_000,
                price,
                u128::from(400_000 - price) * 10_000,
            )
            .unwrap();
        h.at(reveal_start(round));
        h.reveal(round, l, "m1.near", Side::Long, 10_000, price)
            .unwrap();
        h.reveal(round, s, "m2.near", Side::Short, 10_000, price)
            .unwrap();
        h.at(round_end(round));
        h.ok(STRANGER, |w| w.clear(0, round));
    }
    // Merge some, move positions around.
    h.ok("m1.near", |w| w.merge(0, 200));
    h.run("m1.near", 1, |w| {
        w.transfer_position(0, id("m2.near"), 5_000, 0)
    })
    .unwrap();
    h.run("m2.near", 1, |w| {
        w.transfer_position(0, id("m1.near"), 0, 3_000)
    })
    .unwrap();
    // No reports in the delivery window: the series goes void.
    h.at(END + 20);
    let early = h.run(STRANGER, 0, |w| w.settle(0));
    h.at(END + 500);
    h.ok(STRANGER, |w| w.settle(0));
    let st = h.view(|w| w.get_series(0)).unwrap().settlement.unwrap();
    for who in ["bob.near", "m1.near", "m2.near"] {
        h.ok(STRANGER, |w| w.redeem(0, Some(id(who))));
    }
    let bob = h.balance("bob.near") as i128 - 100 * DOLLAR as i128;
    let mallory = (h.balance("m1.near") + h.balance("m2.near")) as i128 - 10_000 * DOLLAR as i128;
    let t = h.view(|w| w.get_totals());
    let traded = h.view(|w| w.get_series(0)).unwrap();
    println!(
        "settle early {early:?}; void {} long {} short {}; bob {bob}; mallory {mallory}; free+burned {} deposits {deposits}; unredeemed {}",
        st.void, st.long_payout, st.short_payout, t.free.0 + t.burned.0, t.unredeemed.0
    );
    let _ = traded;
    assert!(st.void);
    assert_eq!((st.long_payout, st.short_payout), (200_000, 200_000));
    // Bob sold SHORT at band - 0.150 = 0.250 and gets 0.200: -5.00 $, plus his fee.
    assert_eq!(bob, -(100 * 50_000) - FEE as i128);
    // Mallory: +0.050 on 100 honest units, wash and mints exactly neutral, 5 fees.
    assert_eq!(mallory, 100 * 50_000 - 5 * FEE as i128);
    assert_eq!(t.free.0 + t.burned.0, deposits);
    assert_eq!(t.unredeemed.0 + t.locked.0 + t.sets_backing.0, 0);
}
