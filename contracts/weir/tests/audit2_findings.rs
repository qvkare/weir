//! The audit's second pass (against spec 0.4), as of spec 0.5. Tests named `audit2_*`
//! assert that a finding is closed by a rule; tests named `limit_*` keep demonstrating
//! exactly what is still possible, because spec 0.5 states it as a known limit rather
//! than a fix. The numbers each limit shows are in its comment, for the README and the
//! audit record. Each test drives the contract through its public API in near-sdk's
//! mocked VM, one call per "transaction" (a panic rolls state back). Run with
//! `--nocapture --test-threads=1` to see the numbers.
//! Economic numbers follow the `weekly` preset (agents/src/presets.ts): 2 of 3
//! reporters, max_spread 2%, forfeit 1%, commit fee 0.02 $, 64 commits a round.

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
use weir::types::{Params, PrintState, Side};
use weir::{check_params, Weir, REGISTRATION_FEE};

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
const FEE: u128 = 20_000;

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
        min_prints: 3,
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

/// LIMIT (spec 15). With one honest reporter absent, the other
/// honest reporter and one dishonest reporter decide every bucket together. The
/// dishonest one cannot move a print by more than max_spread/2, but it chooses WHICH
/// buckets get a print (agree, or disagree by more than the spread), and the fixing
/// is the average of the printed buckets only. Spec 9 and 15 say a single reporter
/// "cannot steer" a print; it can choose which buckets print, and so moves the fixing.
/// Shown: true average 2.000000, fixing 2.121000 from the 10 high buckets (the 10 low
/// ones get no print): +0.121000 a unit, about 6% of the price.
#[test]
fn limit_one_reporter_selects_which_buckets_print() {
    let mut h = H::with(params());
    h.open_series();
    h.fund("a.near", 100 * DOLLAR);
    h.ok("a.near", |w| w.mint(0, 10));
    // Delivery: true price alternates 1.9 / 2.1 (true average 2.000000). R3 is down.
    let mut honest_sum = 0u64;
    let buckets: Vec<u64> = (0..20).map(|k| T0 + 10 * k).collect();
    for (k, &b) in buckets.iter().enumerate() {
        h.at(b);
        let honest = if k % 2 == 0 { 1_900_000 } else { 2_100_000 };
        honest_sum += honest;
        h.ok(R2, |w| w.report(b, honest, BUNDLE.into()));
        // R1 agrees (and leans +2%) when the price is high; disagrees when low.
        let evil = if honest > PRICE { honest + honest * 200 / 10_000 } else { honest / 2 };
        h.ok(R1, |w| w.report(b, evil, BUNDLE.into()));
    }
    h.at(END + 20);
    h.ok(STRANGER, |w| w.settle(0));
    let s = h.view(|w| w.get_series(0)).unwrap().settlement.unwrap();
    let states: Vec<PrintState> = buckets.iter().map(|&b| h.view(|w| w.get_print(b)).unwrap().state).collect();
    let no_prints = states.iter().filter(|s| **s == PrintState::NoPrint).count();
    println!(
        "true average {}; fixing {} from {} prints ({} buckets no print); void {}; long_payout {} short_payout {}",
        honest_sum / 20, s.fixing, s.prints, no_prints, s.void, s.long_payout, s.short_payout
    );
    assert_eq!(s.fixing, 2_121_000);
    assert!(!s.void);
}

/// LIMIT (spec 10, 15; under 0.6). Same situation, other branch: the dishonest
/// reporter disagrees in every bucket, so the series has no prints and goes void. Spec
/// 0.6 cancels a void series at the centre of the band. Shown: the reporter bought 10
/// SHORT at 0.10 (paid 1.00 $) and gets 0.20 a unit, 2.00 $: +1.00 $, where the true
/// price (band top) pays SHORT nothing. The 0.5 rule paid it back 1.00 $ here only
/// because this series has one trade; see audit3_void.rs for why that rule was dropped.
#[test]
fn limit_forcing_a_void_pays_a_reporter_half_the_band_for_a_cheap_side() {
    let mut h = H::with(params());
    h.open_series();
    h.fund("a.near", 100 * DOLLAR);
    h.fund(R1, 100 * DOLLAR); // the dishonest reporter trades too
    h.ok("a.near", |w| w.mint(0, 10));
    // The auction: a buys 10 LONG at 0.30, the reporter 10 SHORT at 0.10.
    let a = h.commit(0, "a.near", Side::Long, 10, 300_000, 3 * DOLLAR + DOLLAR / 10).unwrap();
    let r = h.commit(0, R1, Side::Short, 10, 300_000, DOLLAR + DOLLAR / 10).unwrap();
    h.at(reveal_start(0));
    h.reveal(0, a, "a.near", Side::Long, 10, 300_000).unwrap();
    h.reveal(0, r, R1, Side::Short, 10, 300_000).unwrap();
    h.at(round_end(0));
    h.ok(STRANGER, |w| w.clear(0, 0));
    let paid = 100 * DOLLAR - FEE - h.balance(R1);
    for k in 0..20u64 {
        let b = T0 + 10 * k;
        h.at(b);
        h.ok(R2, |w| w.report(b, 2_200_000, BUNDLE.into())); // true price: band top
        h.ok(R1, |w| w.report(b, 1_000_000, BUNDLE.into()));
    }
    h.at(END + 20);
    let early = h.run(STRANGER, 0, |w| w.settle(0));
    h.at(END + 500);
    h.ok(STRANGER, |w| w.settle(0));
    let s = h.view(|w| w.get_series(0)).unwrap().settlement.unwrap();
    let before = h.balance(R1);
    h.ok(STRANGER, |w| w.redeem(0, Some(id(R1))));
    let got = h.balance(R1) - before;
    println!("settle at end+grace: {early:?}; void {} at long_payout {}; reporter paid {paid} for 10 SHORT, gets {got} (true price: 0)", s.void, s.long_payout);
    assert!(s.void);
    assert_eq!((s.long_payout, s.short_payout), (200_000, 200_000), "the centre of the band");
    assert_eq!(paid, DOLLAR);
    assert_eq!(got, 2 * DOLLAR, "+1.00 $ for forcing the void");
}

/// LIMIT (spec 15, "Blocking a round"). Blocking a round costs max_commits *
/// commit_fee. Shown: 64 * 0.02 = 1.28 $ a round (and 640 $ of capital tied up for
/// one round), about 215 $ a week at 168 rounds, to keep every honest bidder whose lock
/// is below the attacker's out of every round.
#[test]
fn limit_blocking_a_round_costs_1_28_dollars() {
    let mut h = H::with(params());
    for who in ["a.near", "b.near"] {
        h.fund(who, 100 * DOLLAR);
    }
    h.fund("evil.near", 1_000 * DOLLAR);
    h.open_series();
    h.commit(0, "a.near", Side::Long, 10, 210_000, 10 * DOLLAR).unwrap();
    h.commit(0, "b.near", Side::Short, 10, 190_000, 10 * DOLLAR).unwrap();
    let start = h.balance("evil.near");
    h.at(reveal_start(0) - 1);
    let mut seqs = vec![];
    for _ in 0..64 {
        seqs.push(h.commit(0, "evil.near", Side::Long, 1, 1_000, 10 * DOLLAR + 1).unwrap());
    }
    h.at(reveal_start(0));
    let honest = h.reveal(0, 0, "a.near", Side::Long, 10, 210_000);
    for seq in seqs {
        h.reveal(0, seq, "evil.near", Side::Long, 1, 1_000).unwrap();
    }
    h.at(round_end(0));
    h.ok(STRANGER, |w| w.clear(0, 0));
    let r = h.view(|w| w.get_result(0, 0)).unwrap();
    let cost = start - h.balance("evil.near");
    println!("honest reveal {honest:?}; volume {}; blocking cost {cost} micro-$ (capital tied up 640 $ for one round)", r.volume);
    assert_eq!(honest, Err("commit not found".into()));
    assert_eq!(cost, 64 * FEE);
}

/// LIMIT (spec 15, "Agents"). Forfeits are burned, so nobody profits, but an account
/// that leaves `max_round_lock` unset (the default) can still have its balance burned
/// by a function-call agent at forfeit_bps of everything plus the fee, every round.
/// Shown: 100 $ falls to about 90.25 $ after 10 rounds at the preset's 1% forfeit.
#[test]
fn limit_an_account_without_a_round_lock_limit_can_be_burned() {
    let mut h = H::with(params());
    h.fund("victim.near", 100 * DOLLAR);
    h.run("victim.near", 1, |w| w.set_guard(Some(0), None)).unwrap();
    h.open_series();
    for round in 0..10 {
        h.at(round_start(round));
        let lock = h.balance("victim.near") - FEE;
        h.ok("victim.near", |w| w.commit(0, "ee".repeat(32), U128(lock)));
        h.at(round_end(round));
        h.ok(STRANGER, |w| w.clear(0, round));
    }
    let left = h.balance("victim.near");
    let burned = h.view(|w| w.get_totals()).burned.0;
    println!("victim 100 $ -> {left} micro-$ after 10 rounds; burned {burned}");
    assert!(left < 91 * DOLLAR);
}

/// LIMIT (spec 11, invariant 6 now reads "forfeits and fees are never credited to any
/// account"). Whether Bob reveals still decides whether Charlie trades and at what
/// price: if Bob and Charlie are one person, not revealing is a last look. Shown: with
/// Bob's reveal the round clears at 0.150 and Charlie gets nothing; without it, at 0.225
/// and Charlie sells 10. The look costs 1% of Bob's 5 $ lock plus the 0.02 $ fee: 0.07 $.
#[test]
fn limit_last_look_a_non_reveal_changes_another_accounts_fill() {
    let outcome = |bob_reveals: bool| {
        let mut h = H::with(params());
        for who in ["alice.near", "bob.near", "charlie.near"] {
            h.fund(who, 100 * DOLLAR);
        }
        h.open_series();
        let a = h.commit(0, "alice.near", Side::Long, 10, 250_000, 5 * DOLLAR).unwrap();
        let b = h.commit(0, "bob.near", Side::Short, 10, 150_000, 5 * DOLLAR).unwrap();
        let c = h.commit(0, "charlie.near", Side::Short, 10, 200_000, 5 * DOLLAR).unwrap();
        h.at(reveal_start(0));
        h.reveal(0, a, "alice.near", Side::Long, 10, 250_000).unwrap();
        if bob_reveals {
            h.reveal(0, b, "bob.near", Side::Short, 10, 150_000).unwrap();
        }
        h.reveal(0, c, "charlie.near", Side::Short, 10, 200_000).unwrap();
        h.at(round_end(0));
        h.ok(STRANGER, |w| w.clear(0, 0));
        let r = h.view(|w| w.get_result(0, 0)).unwrap();
        let charlie = h.view(|w| w.get_position(0, id("charlie.near"))).short;
        (r.price, charlie, h.balance("alice.near"))
    };
    let with = outcome(true);
    let without = outcome(false);
    println!("bob reveals: price {:?}, charlie SHORT {}, alice free {}", with.0, with.1, with.2);
    println!("bob silent:  price {:?}, charlie SHORT {}, alice free {}", without.0, without.1, without.2);
    assert_eq!((with.0, with.1), (Some(150_000), 0));
    assert_eq!((without.0, without.1), (Some(225_000), 10));
}

/// CLOSED (spec 3). A quorum of one out of three let a lone reporter make any print.
/// `new` now requires a majority.
#[test]
fn audit2_a_quorum_of_one_in_three_is_refused() {
    let mut p = params();
    p.quorum = 1;
    assert_eq!(check_params(&p), Err("quorum must be a majority of the reporters"));
    let refused = catch_unwind(|| {
        install(STRANGER, OPEN, 0, HashMap::new());
        Weir::new(p)
    });
    assert_eq!(message(refused.err().unwrap()), "quorum must be a majority of the reporters");
    let mut p = params();
    p.reporters = vec![id(R1), id(R2)];
    p.quorum = 1;
    assert_eq!(check_params(&p), Err("quorum must be a majority of the reporters"));
}

/// LIMIT (spec 3, 15). Parameter combinations `new` still accepts that weaken the
/// index or the blocking cost. Shown: a 100% spread lets one of two reporters move a
/// print by up to 50%; with two reporters every print is a two-report mean; with no fee
/// and no forfeit blocking a round is free again; grace = period keeps a whole period
/// of buckets open at once. Choosing parameters is the deployer's job.
#[test]
fn limit_unwise_parameters_are_still_accepted() {
    let mut p = params();
    p.max_spread_bps = 10_000;
    assert_eq!(check_params(&p), Ok(()), "100% spread");
    let mut p = params();
    p.reporters = vec![id(R1), id(R2)];
    assert_eq!(check_params(&p), Ok(()), "2 reporters, quorum 2");
    let mut p = params();
    p.commit_fee = U128(0);
    p.forfeit_bps = 0;
    assert_eq!(check_params(&p), Ok(()), "no fee, no forfeit");
    let mut p = params();
    p.report_grace_secs = p.period_secs;
    p.void_after_secs = p.period_secs;
    assert_eq!(check_params(&p), Ok(()), "grace = period");

    // A 100% spread: R1 and R2 disagree by 2x, the print is their mean.
    let mut p = params();
    p.max_spread_bps = 10_000;
    let mut h = H::with(p);
    let b = OPEN - 200;
    h.at(b);
    h.ok(R1, |w| w.report(b, 2 * PRICE, BUNDLE.into()));
    h.ok(R2, |w| w.report(b, PRICE, BUNDLE.into()));
    h.at(b + 30);
    assert!(h.ok(STRANGER, |w| w.finalize_print(b)));
    let last = h.view(|w| w.get_last_print()).unwrap();
    println!("100% spread: one honest 2.0 and one dishonest 4.0 print {}", last.price);
    assert_eq!(last.price, 3 * PRICE / 2);
}

/// Pruning, checked for soundness: a pruned bucket cannot come back, and pruning
/// does not touch the accumulator or the last print.
#[test]
fn audit2_a_pruned_bucket_cannot_come_back() {
    let mut h = H::with(params());
    let b = T0 + 50;
    h.at(b);
    h.ok(R1, |w| w.report(b, PRICE, BUNDLE.into()));
    h.ok(R2, |w| w.report(b, PRICE, BUNDLE.into()));
    h.at(b + 30);
    assert!(h.ok(STRANGER, |w| w.finalize_print(b)));
    let early = h.run(STRANGER, 0, |w| w.prune_print(b));
    h.at(b + 2_000);
    h.ok(STRANGER, |w| w.prune_print(b));
    let again = h.run(R3, 0, |w| w.report(b, 1, BUNDLE.into()));
    let fin = h.run(STRANGER, 0, |w| w.finalize_print(b));
    let acc = h.view(|w| w.get_accumulator(0));
    let last = h.view(|w| w.get_last_print());
    println!("prune early {early:?}; report after prune {again:?}; finalize {fin:?}; acc {} {}; last {last:?}", acc.sum.0, acc.count);
    assert!(early.is_err() && again.is_err() && fin.is_err());
    assert_eq!(acc.count, 1);
    assert!(h.view(|w| w.get_print(b)).is_none());
}

/// LIMIT (spec 8). The cap protects `clear`, but one account with enough dollars (on
/// testnet, the open faucet) can mint the whole cap, after which nobody else can mint
/// in that series. Shown: the second minter gets `too many sets`; auctions still clear.
#[test]
fn limit_one_account_can_take_the_whole_mint_cap() {
    let p = params();
    let cap = (1u128 << 53) - 1 - p.auction_capacity();
    let mut h = H::with(p);
    h.fund("whale.near", cap * 400_000);
    h.fund("a.near", 100 * DOLLAR);
    h.fund("b.near", 100 * DOLLAR);
    h.open_series();
    h.ok("whale.near", |w| w.mint(0, cap as u64));
    let other = h.run("a.near", 0, |w| w.mint(0, 1));
    let a = h.commit(0, "a.near", Side::Long, 10_000, 1_000, 10 * DOLLAR).unwrap();
    let b = h.commit(0, "b.near", Side::Short, 100, 1_000, 40 * DOLLAR).unwrap();
    h.at(reveal_start(0));
    h.reveal(0, a, "a.near", Side::Long, 10_000, 1_000).unwrap();
    let rb = h.reveal(0, b, "b.near", Side::Short, 100, 1_000);
    h.at(round_end(0));
    let clear = h.run(STRANGER, 0, |w| w.clear(0, 0));
    println!("other mint {other:?}; short reveal {rb:?}; clear {clear:?}");
    assert_eq!(other, Err("too many sets".into()));
    assert!(clear.is_ok());
}
