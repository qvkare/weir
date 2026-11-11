//! The audit's third pass (against spec 0.5), as of spec 0.6: the void settlement.
//! Tests named `audit3_*` assert that a finding is closed by a rule; tests named
//! `limit_*` demonstrate exactly what is still possible, because spec 0.6 states it as
//! a known limit. The numbers each test shows are in its comment, for the README and
//! the audit record. Each test drives the contract through its public API in
//! near-sdk's mocked VM, one call per "transaction" (a panic rolls state back). Run
//! with `--nocapture --test-threads=1` to see the numbers.
//! Economic numbers follow the `weekly` preset (agents/src/presets.ts): 2 of 3
//! reporters, max_spread 2%, forfeit 1%, commit fee 0.10 $, 64 commits a round, but a
//! 10% band (0.40 $ at the 2.00 $ anchor); the deployed band is 15% (0.60 $).

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
    fn run<R>(&mut self, caller: &str, deposit: u128, f: impl FnOnce(&mut Weir) -> R) -> Result<R, String> {
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
        self.run(caller, 0, f).unwrap_or_else(|e| panic!("{caller}: {e}"))
    }
    fn view<R>(&mut self, f: impl FnOnce(&Weir) -> R) -> R {
        let storage = with_mocked_blockchain(|b| b.take_storage());
        install(STRANGER, self.now, 0, storage);
        let weir: Weir = env::state_read().expect("initialized");
        f(&weir)
    }
    fn fund(&mut self, name: &str, amount: u128) {
        self.run(name, REGISTRATION_FEE.as_yoctonear(), |w| w.register(None)).unwrap();
        let refund = self.ok(USDC, |w| w.ft_on_transfer(id(name), U128(amount), String::new()));
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
    fn commit(&mut self, round: u64, name: &str, side: Side, size: u64, price: u64, lock: u128) -> Result<u32, String> {
        let hash = hex::encode(hash::commit_hash(0, round, name, side, size, price, SALT));
        self.run(name, 0, |w| w.commit(0, hash, U128(lock)))
    }
    fn reveal(&mut self, round: u64, seq: u32, name: &str, side: Side, size: u64, price: u64) -> Result<(), String> {
        self.run(name, 0, |w| w.reveal(0, round, seq, side, size, price, SALT.into()))
    }
    fn open_series(&mut self) {
        self.at(round_start(0) - 5);
        self.print_all(PRICE);
        self.at(round_start(0));
    }
}

// ---------------------------------------------------------------------------------

/// CLOSED (spec 10, 0.6). Under 0.5 a void series paid `traded_value /
/// traded_units`, and Mallory moved that average with wash trades between her own two
/// accounts to 0.397, taking 19.40 $ from Bob. Spec 0.6 cancels a void series at the
/// centre of its band, which nothing traded can move. The same trades now give:
/// - Bob paid 100 x 0.200 = 20.00 $ for SHORT and gets 100 x 0.200 back: -0.10 $, his fee.
/// - Mallory's honest 100 LONG at 0.200 come back at 0.200. Her wash, 10,000 LONG at 0.399
///   (3,990 $) and 10,000 SHORT at 0.001 (10 $), comes back as 2 x 2,000 $: nothing.
///   She is down her three fees, -0.30 $.
#[test]
fn audit3_wash_trades_no_longer_set_the_void_payout() {
    let mut h = H::with(params());
    h.open_series();
    h.fund("bob.near", 100 * DOLLAR);
    h.fund(R1, 5_000 * DOLLAR); // Mallory's LONG account, also a reporter
    h.fund("m2.near", 100 * DOLLAR); // Mallory's SHORT account
    let deposits = 5_200 * DOLLAR;
    // Round 0: the honest trade, 100 at 0.200.
    let b = h.commit(0, "bob.near", Side::Short, 100, 200_000, 20 * DOLLAR).unwrap();
    let m = h.commit(0, R1, Side::Long, 100, 200_000, 20 * DOLLAR).unwrap();
    h.at(reveal_start(0));
    h.reveal(0, b, "bob.near", Side::Short, 100, 200_000).unwrap();
    h.reveal(0, m, R1, Side::Long, 100, 200_000).unwrap();
    h.at(round_end(0));
    h.ok(STRANGER, |w| w.clear(0, 0));
    // Round 1: the wash, 10,000 at 0.399.
    h.at(round_start(1));
    let l = h.commit(1, R1, Side::Long, 10_000, 399_000, 3_990 * DOLLAR).unwrap();
    let s = h.commit(1, "m2.near", Side::Short, 10_000, 399_000, 10 * DOLLAR).unwrap();
    h.at(reveal_start(1));
    h.reveal(1, l, R1, Side::Long, 10_000, 399_000).unwrap();
    h.reveal(1, s, "m2.near", Side::Short, 10_000, 399_000).unwrap();
    h.at(round_end(1));
    h.ok(STRANGER, |w| w.clear(0, 1));
    let series = h.view(|w| w.get_series(0)).unwrap();
    assert_eq!((series.traded_units, series.traded_value.0), (10_100, 100 * 200_000 + 10_000 * 399_000));
    // Delivery at a true 2.000; R3 absent; R1 disagrees in every bucket.
    for k in 0..100u64 {
        let bkt = T0 + 10 * k;
        h.at(bkt);
        h.ok(R2, |w| w.report(bkt, PRICE, BUNDLE.into()));
        h.ok(R1, |w| w.report(bkt, PRICE / 2, BUNDLE.into()));
    }
    h.at(END + 500);
    h.ok(STRANGER, |w| w.settle(0));
    let st = h.view(|w| w.get_series(0)).unwrap().settlement.unwrap();
    for who in ["bob.near", R1, "m2.near"] {
        h.ok(STRANGER, |w| w.redeem(0, Some(id(who))));
    }
    let bob = h.balance("bob.near") as i128 - 100 * DOLLAR as i128;
    let mallory = (h.balance(R1) + h.balance("m2.near")) as i128 - 5_100 * DOLLAR as i128;
    let t = h.view(|w| w.get_totals());
    println!(
        "void {} prints {} long_payout {} (0.5 paid 397029); bob {bob} micro-$, mallory {mallory} micro-$; burned {}",
        st.void, st.prints, st.long_payout, t.burned.0
    );
    assert!(st.void);
    assert_eq!((st.long_payout, st.short_payout), (200_000, 200_000), "the centre of the band");
    assert_eq!(bob, -(FEE as i128), "Bob loses only his fee");
    assert_eq!(mallory, -3 * FEE as i128, "the wash gains Mallory nothing");
    // Solvency stays exact: everything is either free or burned.
    assert_eq!(t.free.0 + t.burned.0, deposits);
    assert_eq!(t.unredeemed.0 + t.locked.0 + t.sets_backing.0, 0);
}

/// LIMIT (spec 10, 15). What remains: a reporter who also trades can buy, after the
/// market has moved, the side that costs less than half the band, then cause the void
/// (with another reporter absent, by disagreeing in every bucket) and be paid half the
/// band for it. The gain is `band / 2 - price paid` per unit, at most `band / 2 - tick`.
/// Shown here, band 0.40 $: the index moved to the band top, an honest buyer pays 0.36
/// for LONG, the reporter takes SHORT at 0.04 and gets 0.20: +0.16 $ a unit, 15.90 $ on
/// 100 units after the 0.10 $ fee, where the true price would have paid it nothing. At
/// the deployed band of 0.60 $ the same move is worth up to 0.299 $ a unit.
#[test]
fn limit_a_trading_reporter_forces_a_void_for_up_to_0_299_a_unit_at_the_deployed_band() {
    let mut h = H::with(params());
    h.open_series();
    h.fund("honest.near", 100 * DOLLAR);
    h.fund(R1, 100 * DOLLAR);
    // The market has moved up: the honest buyer pays 0.36 for LONG; R1 sells it.
    let a = h.commit(0, "honest.near", Side::Long, 100, 360_000, 36 * DOLLAR).unwrap();
    let r = h.commit(0, R1, Side::Short, 100, 360_000, 4 * DOLLAR).unwrap();
    h.at(reveal_start(0));
    h.reveal(0, a, "honest.near", Side::Long, 100, 360_000).unwrap();
    h.reveal(0, r, R1, Side::Short, 100, 360_000).unwrap();
    h.at(round_end(0));
    h.ok(STRANGER, |w| w.clear(0, 0));
    // Delivery at the band top (a true settlement pays SHORT 0); R3 absent.
    for k in 0..100u64 {
        let bkt = T0 + 10 * k;
        h.at(bkt);
        h.ok(R2, |w| w.report(bkt, 2_200_000, BUNDLE.into()));
        h.ok(R1, |w| w.report(bkt, 1_000_000, BUNDLE.into()));
    }
    h.at(END + 500);
    h.ok(STRANGER, |w| w.settle(0));
    let st = h.view(|w| w.get_series(0)).unwrap().settlement.unwrap();
    for who in ["honest.near", R1] {
        h.ok(STRANGER, |w| w.redeem(0, Some(id(who))));
    }
    let reporter = h.balance(R1) as i128 - 100 * DOLLAR as i128;
    let honest = h.balance("honest.near") as i128 - 100 * DOLLAR as i128;
    println!("void {} at {}; reporter {reporter} micro-$ (true settlement: -4.10 $); honest {honest} micro-$", st.void, st.long_payout);
    assert!(st.void);
    assert_eq!(reporter, 100 * (200_000 - 40_000) - FEE as i128);
    assert_eq!(honest, -(100 * (360_000 - 200_000)) - FEE as i128);
}
