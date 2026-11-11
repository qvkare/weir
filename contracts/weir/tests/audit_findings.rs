//! Audit demonstrations. Each test drives the contract through its public API in
//! near-sdk's mocked VM, one call per "transaction" (a panic rolls state back), and
//! prints the bad state it reaches. Run with `--nocapture` to see the numbers.

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

const CONTRACT: &str = "weir.near";
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
const BAND: u64 = 400_000;
const DOLLAR: u128 = 1_000_000;

fn id(name: &str) -> AccountId {
    name.parse().unwrap()
}

/// The unit-test schedule (10 rounds of 100 s, prints every 10 s) with the economic
/// numbers of the `weekly` preset in agents/src/presets.ts: forfeit 1%, max move 15%,
/// 2 of 3 reporters.
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
        max_move_bps: 1_500,
        min_prints: 3,
        void_after_secs: 500,
        max_anchor_age_secs: 300,
        forfeit_bps: 100,
        min_lock: U128(1_000),
        max_commits: 4,
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
        .current_account_id(id(CONTRACT))
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
    /// Every reporter reports the current bucket until it is final.
    fn print(&mut self, price: u64) {
        let bucket = self.now - self.now % 10;
        for r in [R1, R2, R3] {
            if self.ok(r, |w| w.report(bucket, price, BUNDLE.into())) {
                return;
            }
        }
        panic!("no print");
    }
    fn hash(series: u32, round: u64, name: &str, side: Side, size: u64, price: u64) -> String {
        hex::encode(hash::commit_hash(series, round, name, side, size, price, SALT))
    }
    fn commit(&mut self, round: u64, name: &str, side: Side, size: u64, price: u64, lock: u128) -> Result<u32, String> {
        let hash = Self::hash(0, round, name, side, size, price);
        self.run(name, 0, |w| w.commit(0, hash, U128(lock)))
    }
    fn reveal(&mut self, round: u64, seq: u32, name: &str, side: Side, size: u64, price: u64) -> Result<(), String> {
        self.run(name, 0, |w| w.reveal(0, round, seq, side, size, price, SALT.into()))
    }
    /// Bytes the contract pays for, as NEAR counts them: key + value + 40 per record.
    fn storage_bytes(&mut self) -> u64 {
        let storage = with_mocked_blockchain(|b| b.take_storage());
        let bytes = storage.iter().map(|(k, v)| (k.len() + v.len() + 40) as u64).sum();
        install(STRANGER, self.now, 0, storage);
        bytes
    }
}

// ---------------------------------------------------------------------------------

/// Finding: the guard can be changed between commit and reveal, so an account can
/// look at the revealed book and walk away from an aggressive commit with no forfeit.
#[test]
fn audit_guard_change_after_commit_cancels_for_free() {
    let mut h = H::with(params());
    h.fund("alice.near", 100 * DOLLAR);
    h.fund("bob.near", 100 * DOLLAR);
    h.at(round_start(0) - 5);
    h.print(PRICE); // ref = 2.0 - 1.8 = 0.200000
    h.at(round_start(0));
    // Alice: no guard at commit time. LONG 10 @ 0.300 (above ref), lock 3 $.
    let a = h.commit(0, "alice.near", Side::Long, 10, 300_000, 3 * DOLLAR).unwrap();
    let b = h.commit(0, "bob.near", Side::Short, 10, 290_000, 2 * DOLLAR).unwrap();
    h.at(reveal_start(0) + 39); // last second of the reveal phase
    h.reveal(0, b, "bob.near", Side::Short, 10, 290_000).unwrap();
    // Alice sees Bob's SHORT at 0.290 and decides she does not like it.
    let before = h.balance("alice.near");
    h.run("alice.near", 1, |w| w.set_guard(Some(0))).unwrap();
    h.reveal(0, a, "alice.near", Side::Long, 10, 300_000).unwrap();
    let after = h.balance("alice.near");
    h.at(round_end(0));
    h.ok(STRANGER, |w| w.clear(0, 0));
    let r = h.view(|w| w.get_result(0, 0)).unwrap();
    println!(
        "alice free balance before reveal {before}, after void reveal {after}; result volume {} forfeited {}",
        r.volume, r.forfeited.0
    );
    println!("had alice simply not revealed she would have forfeited {}", 3 * DOLLAR / 100);
    assert_eq!(after - before, 3 * DOLLAR, "whole lock back, nothing forfeited");
    assert_eq!(r.forfeited.0, 0);
    assert_eq!(r.volume, 0);
}

/// Finding: an agent with only a function-call key (commit/reveal/clear...) on an
/// account WITH a guard can still burn its dollars into the bonus pool by committing
/// and never revealing, and a confederate who holds the series' open sets collects.
#[test]
fn audit_function_call_agent_drains_a_guarded_account_through_forfeits() {
    let mut h = H::with(params());
    h.fund("victim.near", 100 * DOLLAR);
    h.fund("mallory.near", 1_000 * DOLLAR);
    // Victim protects herself as tightly as possible (needs a full-access key).
    h.run("victim.near", 1, |w| w.set_guard(Some(0))).unwrap();
    h.at(round_start(0) - 5);
    h.print(PRICE);
    h.at(round_start(0));
    // Mallory mints sets: risk free, gets band back at settlement plus the bonus.
    h.ok("mallory.near", |w| w.mint(0, 2_000));
    for round in 0..10 {
        h.at(round_start(round));
        let lock = h.balance("victim.near");
        // The agent (calls with no deposit, as a function-call key would) commits
        // the whole free balance with a random hash it never reveals.
        let junk = "ee".repeat(32);
        h.ok("victim.near", |w| w.commit(0, junk, U128(lock)));
        h.at(round_end(round));
        h.ok(STRANGER, |w| w.clear(0, round));
    }
    // Delivery with enough prints, then settle.
    for b in [T0, T0 + 10, T0 + 20] {
        h.at(b);
        h.print(PRICE);
    }
    h.at(END + 20);
    h.ok(STRANGER, |w| w.settle(0));
    h.ok(STRANGER, |w| w.redeem(0, Some(id("mallory.near"))));
    let victim = h.balance("victim.near");
    let mallory = h.balance("mallory.near");
    println!(
        "victim 100.000000 -> {}.{:06}; mallory 1000.000000 -> {}.{:06}",
        victim / DOLLAR, victim % DOLLAR, mallory / DOLLAR, mallory % DOLLAR
    );
    assert!(victim < 91 * DOLLAR);
    assert!(mallory > 1_009 * DOLLAR);
}

/// Finding: eviction lets anyone push every rival out of a round in the last second
/// of its commit phase, and get every dollar back by revealing an order that cannot
/// trade.
#[test]
fn audit_eviction_griefing_costs_nothing() {
    let mut h = H::with(params()); // max_commits 4
    for who in ["a.near", "b.near", "c.near", "d.near"] {
        h.fund(who, 100 * DOLLAR);
    }
    h.fund("evil.near", 100 * DOLLAR);
    h.at(round_start(0) - 5);
    h.print(PRICE);
    h.at(round_start(0));
    h.commit(0, "a.near", Side::Long, 10, 210_000, 10 * DOLLAR).unwrap();
    h.commit(0, "b.near", Side::Long, 10, 200_000, 10 * DOLLAR).unwrap();
    h.commit(0, "c.near", Side::Short, 10, 190_000, 10 * DOLLAR).unwrap();
    h.commit(0, "d.near", Side::Short, 10, 200_000, 10 * DOLLAR).unwrap();
    let start = h.balance("evil.near");
    h.at(reveal_start(0) - 1);
    let mut seqs = vec![];
    for _ in 0..4 {
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
    let end = h.balance("evil.near");
    println!("honest reveal: {honest:?}; result volume {} commits {}; evil balance {start} -> {end}", r.volume, r.commits);
    assert_eq!(honest, Err("commit not found".into()));
    assert_eq!(r.volume, 0);
    assert_eq!(start, end, "the griefer paid nothing");
}

/// Finding: with quorum 2 of 3, the "median" of two reports is their mean, so ONE
/// reporter who reports first moves each print by up to max_move against the last
/// print, and the moves compound bucket after bucket while the true price stands still.
#[test]
fn audit_one_reporter_ratchets_the_index() {
    let mut h = H::with(params()); // max_move 15%
    let start = OPEN - 200;
    h.at(start);
    h.print(PRICE);
    let honest = PRICE;
    let mut prints = vec![];
    for k in 1..=10u64 {
        let bucket = start + 10 * k;
        h.at(bucket);
        let last = h.view(|w| w.get_last_print()).unwrap().price;
        let target = last + last * 1_500 / 10_000;
        let evil = 2 * target - honest;
        assert!(!h.ok(R1, |w| w.report(bucket, evil, BUNDLE.into())));
        assert!(h.ok(R2, |w| w.report(bucket, honest, BUNDLE.into())), "honest report finalizes");
        assert!(!h.ok(R3, |w| w.report(bucket, honest, BUNDLE.into())), "third honest report ignored");
        prints.push(h.view(|w| w.get_print(bucket)).unwrap().price.unwrap());
    }
    println!("true price 2000000 throughout; prints: {prints:?}");
    assert!(*prints.last().unwrap() > 4 * PRICE);
}

/// Finding: after a move larger than max_move_bps, every print needs every reporter,
/// so one reporter who is offline or withholding freezes the index for good, and no
/// series can open.
#[test]
fn audit_one_reporter_freezes_the_index_after_a_big_move() {
    let mut h = H::with(params());
    h.at(OPEN - 400);
    h.print(PRICE);
    // The market moves 20%. R3 stays silent.
    let mut finals = 0;
    for b in (OPEN - 390..OPEN + 400).step_by(10) {
        h.at(b);
        if h.ok(R1, |w| w.report(b, 2_400_000, BUNDLE.into())) { finals += 1; }
        if h.ok(R2, |w| w.report(b, 2_400_000, BUNDLE.into())) { finals += 1; }
    }
    h.at(round_start(4));
    h.fund("alice.near", 100 * DOLLAR);
    let open = h.commit(4, "alice.near", Side::Long, 1, 200_000, DOLLAR);
    let last = h.view(|w| w.get_last_print());
    println!("79 buckets reported by 2 of 3 at 2.4: {finals} final; last print {last:?}; commit: {open:?}");
    assert_eq!(finals, 0);
    assert_eq!(open, Err("index is stale".into()));
}

/// Finding: `far` is skipped when the last print is for a later bucket, so a quorum
/// that finalizes bucket B+1 first can then put ANY price into bucket B inside its
/// grace window, straight into the series accumulator.
#[test]
fn audit_quorum_bypasses_max_move_by_reporting_out_of_order() {
    let mut h = H::with(params());
    let b = T0 + 100; // in series 0's delivery window
    h.at(b - 10);
    h.print(PRICE);
    h.at(b + 10); // bucket b is still open until b + 30
    h.ok(R1, |w| w.report(b + 10, PRICE, BUNDLE.into()));
    assert!(h.ok(R2, |w| w.report(b + 10, PRICE, BUNDLE.into())));
    h.ok(R1, |w| w.report(b, 100 * PRICE, BUNDLE.into()));
    let made_final = h.ok(R2, |w| w.report(b, 100 * PRICE, BUNDLE.into()));
    let acc = h.view(|w| w.get_accumulator(0));
    println!("bucket {b} at 100x the last print, final: {made_final}; accumulator sum {} count {}", acc.sum.0, acc.count);
    assert!(made_final);
}

/// Finding (testnet: the mock token mints any amount): one account can mint
/// u64::MAX sets, after which `open_sets + volume` overflows in every `clear` that
/// trades, the round can never be cleared, and the series can never settle.
#[test]
fn audit_open_sets_overflow_freezes_a_series() {
    let mut h = H::with(params());
    h.fund("a.near", 100 * DOLLAR);
    h.fund("b.near", 100 * DOLLAR);
    h.fund("whale.near", u128::from(u64::MAX) * u128::from(BAND));
    h.at(round_start(0) - 5);
    h.print(PRICE);
    h.at(round_start(0));
    let a = h.commit(0, "a.near", Side::Long, 10, 200_000, 2 * DOLLAR).unwrap();
    let b = h.commit(0, "b.near", Side::Short, 10, 200_000, 2 * DOLLAR).unwrap();
    h.ok("whale.near", |w| w.mint(0, u64::MAX));
    h.at(reveal_start(0));
    h.reveal(0, a, "a.near", Side::Long, 10, 200_000).unwrap();
    h.reveal(0, b, "b.near", Side::Short, 10, 200_000).unwrap();
    h.at(round_end(0));
    let clear = h.run(STRANGER, 0, |w| w.clear(0, 0));
    for bucket in [T0, T0 + 10, T0 + 20] {
        h.at(bucket);
        h.print(PRICE);
    }
    h.at(END + 600);
    let clear_later = h.run(STRANGER, 0, |w| w.clear(0, 0));
    let settle = h.run(STRANGER, 0, |w| w.settle(0));
    let locked = h.view(|w| w.get_totals()).locked.0;
    println!("clear: {clear:?}; clear later: {clear_later:?}; settle: {settle:?}; locked {locked}");
    assert_eq!(clear, Err("arithmetic overflow".into()));
    assert_eq!(settle, Err("a round of the series is waiting to be cleared".into()));
    assert_eq!(locked, 4 * DOLLAR);
}

/// Storage the contract pays for and cannot charge back: per print, per full round
/// book, per stored result.
#[test]
fn audit_storage_bytes_per_object() {
    let mut p = params();
    p.max_commits = 64;
    p.reporters = vec![id("reporter-a.weir.testnet"), id("reporter-b.weir.testnet"), id("reporter-c.weir.testnet")];
    let mut h = H::with(p);
    let base = h.storage_bytes();
    let who = "a".repeat(64); // an implicit account id
    h.fund(&who, 1_000 * DOLLAR);
    let account = h.storage_bytes() - base;

    // One hourly print with all three reports (the keeper keeps reporting until final
    // but a third report after final is a no-op; count the worst case of 3).
    h.at(round_start(0) - 5);
    let bucket = h.now - h.now % 10;
    let s0 = h.storage_bytes();
    for r in ["reporter-a.weir.testnet", "reporter-b.weir.testnet"] {
        h.ok(r, |w| w.report(bucket, PRICE, BUNDLE.into()));
    }
    let print = h.storage_bytes() - s0;

    h.at(round_start(0));
    let s1 = h.storage_bytes();
    let mut seqs = vec![];
    for i in 0..64u64 {
        seqs.push(h.commit(0, &who, Side::Long, 1, 1_000 * (i % 3 + 1), DOLLAR).unwrap());
    }
    let book = h.storage_bytes() - s1;
    h.at(reveal_start(0));
    for (i, seq) in seqs.iter().enumerate() {
        h.reveal(0, *seq, &who, Side::Long, 1, 1_000 * (i as u64 % 3 + 1)).unwrap();
    }
    h.at(round_end(0));
    h.ok(STRANGER, |w| w.clear(0, 0));
    let result = h.storage_bytes() - s1;
    let near = |b: u64| b as f64 * 1e19 / 1e24;
    println!("account {account} B ({:.4} NEAR, fee 0.02)", near(account));
    println!("print with 2 reports {print} B ({:.5} NEAR)", near(print));
    println!("book of 64 commits {book} B ({:.4} NEAR)", near(book));
    println!("result of 64 unfilled orders (kept until settle + prune) {result} B ({:.4} NEAR)", near(result));
}
