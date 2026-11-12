//! The independent audit's eight demonstrations, turned around. Each test began as
//! the auditor's proof that an attack reached a bad state. Spec 0.4 changed the rules,
//! and each test now keeps the auditor's scenario and numbers and asserts that the
//! attack fails. Every test drives the contract through its public API in near-sdk's
//! mocked VM, one call per "transaction" (a panic rolls state back). Run with
//! `--nocapture` to see the numbers.

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
const FEE: u128 = 10_000;

fn id(name: &str) -> AccountId {
    name.parse().unwrap()
}

/// The unit-test schedule (10 rounds of 100 s, prints every 10 s) with the economic
/// numbers of the `weekly` preset in agents/src/presets.ts: forfeit 1%, 2 of 3
/// reporters; and the spec 0.4 additions: a 1% spread and a 0.01 $ commit fee.
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
        max_spread_bps: 100,
        min_prints: 3,
        void_after_secs: 500,
        max_anchor_age_secs: 300,
        forfeit_bps: 100,
        min_lock: U128(1_000),
        commit_fee: U128(FEE),
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
    /// Every reporter reports the current bucket; the third report decides it.
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
        hex::encode(hash::commit_hash(
            series, round, name, side, size, price, SALT,
        ))
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
        let hash = Self::hash(0, round, name, side, size, price);
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
    /// Bytes the contract pays for, as NEAR counts them: key + value + 40 per record.
    fn storage_bytes(&mut self) -> u64 {
        let storage = with_mocked_blockchain(|b| b.take_storage());
        let bytes = storage
            .iter()
            .map(|(k, v)| (k.len() + v.len() + 40) as u64)
            .sum();
        install(STRANGER, self.now, 0, storage);
        bytes
    }
}

// ---------------------------------------------------------------------------------

/// Finding 1: the guard could be changed between commit and reveal, so an account
/// could look at the revealed book and walk away from an aggressive commit for free.
/// Fix (6.2, 6.4): the commit records the guard and reference; reveal applies those.
#[test]
fn audit_guard_change_after_commit_no_longer_cancels() {
    let mut h = H::with(params());
    h.fund("alice.near", 100 * DOLLAR);
    h.fund("bob.near", 100 * DOLLAR);
    h.at(round_start(0) - 5);
    h.print(PRICE); // ref = 2.0 - 1.8 = 0.200000
    h.at(round_start(0));
    // Alice: no guard at commit time. LONG 10 @ 0.300 (above ref), lock 3 $.
    let a = h
        .commit(0, "alice.near", Side::Long, 10, 300_000, 3 * DOLLAR)
        .unwrap();
    let b = h
        .commit(0, "bob.near", Side::Short, 10, 290_000, 2 * DOLLAR)
        .unwrap();
    h.at(reveal_start(0) + 39);
    h.reveal(0, b, "bob.near", Side::Short, 10, 290_000)
        .unwrap();
    // Alice sees Bob's SHORT at 0.290 and tightens her guard: too late.
    let before = h.balance("alice.near");
    h.run("alice.near", 1, |w| w.set_guard(Some(0), None))
        .unwrap();
    h.reveal(0, a, "alice.near", Side::Long, 10, 300_000)
        .unwrap();
    let after = h.balance("alice.near");
    h.at(round_end(0));
    h.ok(STRANGER, |w| w.clear(0, 0));
    let r = h.view(|w| w.get_result(0, 0)).unwrap();
    println!(
        "alice's reveal returned {} (was the whole 3 $); the round traded {} at {:?}",
        after - before,
        r.volume,
        r.price
    );
    assert_eq!(after, before, "no lock back at reveal: the order stands");
    assert_eq!((r.volume, r.price), (10, Some(295_000)));
}

/// Finding 2: an agent holding only a function-call key could commit the whole free
/// balance of a guarded account and never reveal, and a confederate holding the
/// series' sets collected the forfeits. Fix (6.2, 7.3): `max_round_lock` caps what
/// the agent can put at risk in a round, and forfeits are burned, not shared.
#[test]
fn audit_function_call_agent_can_no_longer_drain_a_guarded_account() {
    let mut h = H::with(params());
    h.fund("victim.near", 100 * DOLLAR);
    h.fund("mallory.near", 1_000 * DOLLAR);
    // The victim's full-access key sets both limits; the agent cannot change them.
    h.run("victim.near", 1, |w| {
        w.set_guard(Some(0), Some(U128(DOLLAR)))
    })
    .unwrap();
    h.at(round_start(0) - 5);
    h.print(PRICE);
    h.at(round_start(0));
    h.ok("mallory.near", |w| w.mint(0, 2_000));
    let junk = "ee".repeat(32);
    for round in 0..10 {
        h.at(round_start(round));
        let everything = h.balance("victim.near") - FEE;
        let all_in = h.run("victim.near", 0, |w| {
            w.commit(0, junk.clone(), U128(everything))
        });
        assert_eq!(all_in, Err("over the round lock limit".into()));
        h.ok("victim.near", |w| w.commit(0, junk.clone(), U128(DOLLAR)));
        h.at(round_end(round));
        h.ok(STRANGER, |w| w.clear(0, round));
    }
    for b in [T0, T0 + 10, T0 + 20] {
        h.at(b);
        h.print(PRICE);
    }
    h.at(END + 20);
    h.ok(STRANGER, |w| w.settle(0));
    h.ok(STRANGER, |w| w.redeem(0, Some(id("mallory.near"))));
    let victim = h.balance("victim.near");
    let mallory = h.balance("mallory.near");
    let burned = h.view(|w| w.get_totals()).burned.0;
    println!("victim 100 $ -> {victim}; mallory 1000 $ -> {mallory}; burned {burned}");
    // Ten rounds of 1% of 1 $ and a 0.01 $ fee: 0.2 $ in all, and nobody got it.
    assert_eq!(victim, 100 * DOLLAR - 10 * (DOLLAR / 100 + FEE));
    assert_eq!(
        mallory,
        1_000 * DOLLAR,
        "invariant 6: no gain from another's forfeit"
    );
    assert_eq!(burned, 10 * (DOLLAR / 100 + FEE));
}

/// Finding 3: eviction let anyone push every rival out of a round in the last second
/// of its commit phase and get every dollar back. Fix (6.2, 7.3): each slot taken
/// costs `commit_fee`, burned at clearing, so blocking a round costs exactly
/// `max_commits * commit_fee`.
#[test]
fn audit_eviction_griefing_now_costs_a_fee_per_slot() {
    let mut h = H::with(params()); // max_commits 4
    for who in ["a.near", "b.near", "c.near", "d.near"] {
        h.fund(who, 100 * DOLLAR);
    }
    h.fund("evil.near", 100 * DOLLAR);
    h.at(round_start(0) - 5);
    h.print(PRICE);
    h.at(round_start(0));
    h.commit(0, "a.near", Side::Long, 10, 210_000, 10 * DOLLAR)
        .unwrap();
    h.commit(0, "b.near", Side::Long, 10, 200_000, 10 * DOLLAR)
        .unwrap();
    h.commit(0, "c.near", Side::Short, 10, 190_000, 10 * DOLLAR)
        .unwrap();
    h.commit(0, "d.near", Side::Short, 10, 200_000, 10 * DOLLAR)
        .unwrap();
    let start = h.balance("evil.near");
    h.at(reveal_start(0) - 1);
    let mut seqs = vec![];
    for _ in 0..4 {
        seqs.push(
            h.commit(0, "evil.near", Side::Long, 1, 1_000, 10 * DOLLAR + 1)
                .unwrap(),
        );
    }
    // The evicted got lock and fee back in full.
    assert_eq!(h.balance("a.near"), 100 * DOLLAR);
    h.at(reveal_start(0));
    for seq in seqs {
        h.reveal(0, seq, "evil.near", Side::Long, 1, 1_000).unwrap();
    }
    h.at(round_end(0));
    h.ok(STRANGER, |w| w.clear(0, 0));
    let r = h.view(|w| w.get_result(0, 0)).unwrap();
    let end = h.balance("evil.near");
    println!(
        "blocking the round cost the griefer {} (4 slots at {FEE}); fees burned {}",
        start - end,
        r.fees.0
    );
    assert_eq!(start - end, 4 * FEE);
    assert_eq!(r.fees.0, 4 * FEE);
}

/// Finding 4: with 2 of 3 reporters, one reporter who reported first moved each
/// print by up to max_move against the last print, compounding. Fix (9): with every
/// reporter present the print is the median; with one missing, the two must agree
/// within max_spread_bps or there is no print. Nothing compares with earlier prints.
#[test]
fn audit_one_reporter_can_no_longer_steer_the_index() {
    let mut h = H::with(params());
    let start = OPEN - 200;
    h.at(start);
    h.print(PRICE);
    let honest = PRICE;
    let mut evil = PRICE;
    let mut prints = vec![];
    for k in 1..=10u64 {
        let bucket = start + 10 * k;
        h.at(bucket);
        evil += evil * 1_500 / 10_000;
        assert!(!h.ok(R1, |w| w.report(bucket, evil, BUNDLE.into())));
        assert!(
            !h.ok(R2, |w| w.report(bucket, honest, BUNDLE.into())),
            "two reports decide nothing yet"
        );
        assert!(
            h.ok(R3, |w| w.report(bucket, honest, BUNDLE.into())),
            "the third decides on the median"
        );
        prints.push(h.view(|w| w.get_print(bucket)).unwrap().price.unwrap());
    }
    // One honest and one dishonest reporter, the third silent: no print.
    let mut no_prints = 0;
    for k in 11..=20u64 {
        let bucket = start + 10 * k;
        h.at(bucket);
        evil += evil * 1_500 / 10_000;
        h.ok(R1, |w| w.report(bucket, evil, BUNDLE.into()));
        h.ok(R2, |w| w.report(bucket, honest, BUNDLE.into()));
        h.at(bucket + 30);
        if !h.ok(STRANGER, |w| w.finalize_print(bucket)) {
            no_prints += 1;
        }
    }
    let last = h.view(|w| w.get_last_print()).unwrap();
    println!("true price 2000000; prints with all three: {prints:?}; buckets with one honest and one dishonest: {no_prints} of 10 without a print; last print {last:?}");
    assert!(prints.iter().all(|&p| p == honest));
    assert_eq!(no_prints, 10);
    assert_eq!(last.price, honest);
}

/// Finding 5: after a move larger than max_move_bps every print needed every
/// reporter, so one silent reporter froze the index and no series could open. Fix
/// (9): there is no move limit; two agreeing reporters make a print once the window
/// closes.
#[test]
fn audit_a_silent_reporter_can_no_longer_freeze_the_index() {
    let mut h = H::with(params());
    h.at(OPEN - 400);
    h.print(PRICE);
    // The market moves 20%. R3 stays silent.
    for b in (OPEN - 390..OPEN + 400).step_by(10) {
        h.at(b);
        h.ok(R1, |w| w.report(b, 2_400_000, BUNDLE.into()));
        h.ok(R2, |w| w.report(b, 2_400_000, BUNDLE.into()));
    }
    // Later reports decided the closed buckets on their way; finalize the rest.
    h.at(OPEN + 430);
    for b in h.view(|w| w.get_pending_prints()) {
        h.ok(STRANGER, |w| w.finalize_print(b));
    }
    let finals = h.view(|w| w.get_prints(OPEN - 390, 200)).len();
    h.at(round_start(4));
    h.fund("alice.near", 100 * DOLLAR);
    let open = h.commit(4, "alice.near", Side::Long, 1, 200_000, DOLLAR);
    let last = h.view(|w| w.get_last_print());
    println!("79 buckets reported by 2 of 3 at 2.4: {finals} final; last print {last:?}; commit: {open:?}");
    assert_eq!(finals, 79);
    assert_eq!(last.unwrap().price, 2_400_000);
    assert!(open.is_ok());
}

/// Finding 6: `far` was skipped when the last print was for a later bucket, so a
/// quorum that finalized bucket B+1 first could put any price into bucket B. Fix (9):
/// nothing compares a print with earlier prints, so there is no limit to bypass and
/// the order of reporting changes nothing. A majority of reporters can set the
/// fixing, as section 15 says; one honest third reporter keeps the median.
#[test]
fn audit_reporting_out_of_order_no_longer_bypasses_anything() {
    let b = T0 + 100;
    let outcome = |out_of_order: bool, honest_third: bool| {
        let mut h = H::with(params());
        h.at(b - 10);
        h.print(PRICE);
        h.at(b + 10);
        if out_of_order {
            h.print(PRICE);
        }
        h.ok(R1, |w| w.report(b, 100 * PRICE, BUNDLE.into()));
        h.ok(R2, |w| w.report(b, 100 * PRICE, BUNDLE.into()));
        if honest_third {
            h.ok(R3, |w| w.report(b, PRICE, BUNDLE.into()));
        }
        h.at(b + 30);
        if h.view(|w| w.get_pending_prints()).contains(&b) {
            h.ok(STRANGER, |w| w.finalize_print(b));
        }
        h.view(|w| w.get_print(b)).unwrap().price
    };
    let (in_order, reordered) = (outcome(false, false), outcome(true, false));
    let (in_order_3, reordered_3) = (outcome(false, true), outcome(true, true));
    println!("two colluding reporters at 100x: in order {in_order:?}, out of order {reordered:?}; with an honest third: {in_order_3:?} / {reordered_3:?}");
    assert_eq!(in_order, reordered, "order changes nothing");
    assert_eq!(in_order_3, reordered_3);
    assert_eq!(
        in_order_3,
        Some(100 * PRICE),
        "two of three are a majority: section 15"
    );
}

/// Finding 7: one account could mint u64::MAX sets, after which `clear` overflowed in
/// every round that traded and the series could never settle. Fix (8): `mint` stops
/// at 2^53 - 1 less what the series' auctions can still add, so `clear` always fits.
#[test]
fn audit_open_sets_can_no_longer_overflow() {
    let mut p = params();
    p.max_order_size = 1_000;
    let cap = (1u64 << 53) - 1 - 1_000 * 4 * p.rounds_per_series();
    let mut h = H::with(p);
    h.fund("a.near", 1_000 * DOLLAR);
    h.fund("b.near", 1_000 * DOLLAR);
    h.fund("whale.near", u128::from(cap) * u128::from(BAND));
    h.at(round_start(0) - 5);
    h.print(PRICE);
    h.at(round_start(0));
    let a = h
        .commit(0, "a.near", Side::Long, 1_000, 200_000, 200 * DOLLAR)
        .unwrap();
    let b = h
        .commit(0, "b.near", Side::Short, 1_000, 200_000, 200 * DOLLAR)
        .unwrap();
    let max = h.run("whale.near", 0, |w| w.mint(0, u64::MAX));
    h.ok("whale.near", |w| w.mint(0, cap));
    let one_more = h.run("whale.near", 0, |w| w.mint(0, 1));
    h.at(reveal_start(0));
    h.reveal(0, a, "a.near", Side::Long, 1_000, 200_000)
        .unwrap();
    h.reveal(0, b, "b.near", Side::Short, 1_000, 200_000)
        .unwrap();
    h.at(round_end(0));
    let clear = h.run(STRANGER, 0, |w| w.clear(0, 0));
    for bucket in [T0, T0 + 10, T0 + 20] {
        h.at(bucket);
        h.print(PRICE);
    }
    h.at(END + 600);
    let settle = h.run(STRANGER, 0, |w| w.settle(0));
    let open_sets = h.view(|w| w.get_series(0)).unwrap().open_sets;
    println!("mint u64::MAX: {max:?}; mint to the cap {cap} ok, one more: {one_more:?}; clear: {clear:?}; settle: {settle:?}; open_sets {open_sets}");
    assert_eq!(max, Err("too many sets".into()));
    assert_eq!(one_more, Err("too many sets".into()));
    assert_eq!(clear, Ok(()));
    assert_eq!(settle, Ok(()));
    assert_eq!(open_sets, cap + 1_000);
    assert!(u128::from(open_sets) < 1 << 53);
}

/// Finding 8: storage the contract pays for and cannot charge back. Fix (12, 14):
/// a result keeps only the orders that were filled, and `prune_print` and
/// `prune_result` release prints and results.
#[test]
fn audit_storage_bytes_per_object_and_pruning() {
    let mut p = params();
    p.max_commits = 64;
    p.reporters = vec![
        id("reporter-a.weir.testnet"),
        id("reporter-b.weir.testnet"),
        id("reporter-c.weir.testnet"),
    ];
    let reporters = [
        "reporter-a.weir.testnet",
        "reporter-b.weir.testnet",
        "reporter-c.weir.testnet",
    ];
    let mut h = H::with(p);
    let base = h.storage_bytes();
    let who = "a".repeat(64); // an implicit account id
    h.fund(&who, 1_000 * DOLLAR);
    let account = h.storage_bytes() - base;

    h.at(round_start(0) - 5);
    let bucket = h.now - h.now % 10;
    let s0 = h.storage_bytes();
    for r in reporters {
        h.ok(r, |w| w.report(bucket, PRICE, BUNDLE.into()));
    }
    let print = h.storage_bytes() - s0;

    h.at(round_start(0));
    let s1 = h.storage_bytes();
    let mut seqs = vec![];
    for i in 0..64u64 {
        seqs.push(
            h.commit(0, &who, Side::Long, 1, 1_000 * (i % 3 + 1), DOLLAR)
                .unwrap(),
        );
    }
    let book = h.storage_bytes() - s1;
    h.at(reveal_start(0));
    for (i, seq) in seqs.iter().enumerate() {
        h.reveal(0, *seq, &who, Side::Long, 1, 1_000 * (i as u64 % 3 + 1))
            .unwrap();
    }
    h.at(round_end(0));
    h.ok(STRANGER, |w| w.clear(0, 0));
    let result = h.storage_bytes() - s1;

    // Settle, then prune the result and, two periods on, the print.
    for b in [T0, T0 + 10, T0 + 20] {
        h.at(b);
        for r in reporters {
            h.ok(r, |w| w.report(b, PRICE, BUNDLE.into()));
        }
    }
    h.at(END + 20);
    h.ok(STRANGER, |w| w.settle(0));
    let s2 = h.storage_bytes();
    h.ok(STRANGER, |w| w.prune_result(0, 0));
    let result_freed = s2 - h.storage_bytes();
    h.at(bucket + 2_000);
    let s3 = h.storage_bytes();
    h.ok(STRANGER, |w| w.prune_print(bucket));
    let print_freed = s3 - h.storage_bytes();

    let near = |b: u64| b as f64 * 1e19 / 1e24;
    println!("account {account} B ({:.4} NEAR, fee 0.02)", near(account));
    println!(
        "print with 3 reports {print} B ({:.5} NEAR); prune_print frees {print_freed} B",
        near(print)
    );
    println!("book of 64 commits {book} B ({:.4} NEAR)", near(book));
    println!(
        "result of 64 unfilled orders {result} B ({:.5} NEAR); prune_result frees {result_freed} B",
        near(result)
    );
    assert!(result < 300, "a result with no fills is small: {result} B");
    // The 220 B above also hold the series record the first commit opened; the
    // result itself is what pruning frees.
    assert!(
        result_freed > 0 && result_freed <= result,
        "prune_result frees the result: {result_freed} B"
    );
    assert!(
        print_freed > 0 && print_freed + 100 >= print,
        "prune_print releases the print: {print_freed} of {print}"
    );
}
