//! Contract-level unit tests. Each call runs like a transaction: state is read from
//! storage, and written back only if the call does not panic, so a refused call
//! leaves nothing behind, as on chain. The rules themselves are tested on their
//! boundaries in the pure modules; these tests prove the methods are wired to them.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

use near_sdk::mock::{with_mocked_blockchain, MockAction};
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, MockedBlockchain, PromiseResult, RuntimeFeesConfig};

use super::*;

const CONTRACT: &str = "weir.near";
const USDC: &str = "usdc.near";
const ALICE: &str = "alice.near";
const BOB: &str = "bob.near";
const CAROL: &str = "carol.near";
const DAVE: &str = "dave.near";
const STRANGER: &str = "stranger.near";
const R1: &str = "r1.near";
const R2: &str = "r2.near";
const R3: &str = "r3.near";
const SALT: &str = "00112233445566778899aabbccddeeff";
const BUNDLE: &str = "abababababababababababababababababababababababababababababababab";

const T0: u64 = 1_000_000;
/// Series 0's auction runs over [OPEN, CLOSE), in 10 rounds of 100 seconds: 60
/// commit, 40 reveal. Series 1's auction starts at CLOSE.
const OPEN: u64 = T0 - 1_100;
const CLOSE: u64 = T0 - 100;
const END: u64 = T0 + 1_000;
/// A print of 2.000000 $/h gives floor 1.800000 and band 0.400000.
const PRICE: u64 = 2_000_000;
const FLOOR: u64 = 1_800_000;
const BAND: u64 = 400_000;
const DOLLAR: u128 = 1_000_000;

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
        max_spread_bps: 100,
        min_prints: 3,
        void_after_secs: 500,
        max_anchor_age_secs: 300,
        forfeit_bps: 1_000,
        min_lock: U128(1_000),
        commit_fee: U128(0),
        max_commits: 4,
        max_order_size: 1_000,
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

fn install(caller: &str, now: u64, deposit: u128, results: Vec<PromiseResult>, storage: HashMap<Vec<u8>, Vec<u8>>) {
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
        results,
        storage,
        Default::default(),
        None,
    ));
}

/// The contract's own message. The mocked host wraps `env::panic_str` in a
/// `GuestPanic { panic_msg: ".." }`, which this unwraps.
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

fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|json| serde_json::from_str(json).unwrap())
        .collect()
}

fn event(name: &str) -> Value {
    let all = events();
    let found = all.iter().find(|e| e["event"] == name).cloned();
    found.unwrap_or_else(|| panic!("no {name} event in {all:?}"))
}

struct H {
    now: u64,
}

impl H {
    /// Deployed with `params()`, before series 0's auction opens.
    fn new() -> Self {
        Self::with(params())
    }

    fn with(params: Params) -> Self {
        install(STRANGER, OPEN - 100, 0, vec![], HashMap::new());
        env::state_write(&Weir::new(params));
        Self { now: OPEN - 100 }
    }

    /// Moves the clock. Views read it, and the next call's logs start empty.
    fn at(&mut self, now: u64) -> &mut Self {
        self.now = now;
        let storage = with_mocked_blockchain(|b| b.take_storage());
        install(STRANGER, now, 0, vec![], storage);
        self
    }

    fn run<R>(
        &mut self,
        caller: &str,
        deposit: u128,
        results: Vec<PromiseResult>,
        f: impl FnOnce(&mut Weir) -> R,
    ) -> Result<R, String> {
        let storage = with_mocked_blockchain(|b| b.take_storage());
        install(caller, self.now, deposit, results, storage.clone());
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let mut weir: Weir = env::state_read().expect("initialized");
            let result = f(&mut weir);
            env::state_write(&weir);
            result
        }));
        outcome.map_err(|payload| {
            install(caller, self.now, deposit, vec![], storage);
            message(payload)
        })
    }

    fn call<R>(&mut self, caller: &str, f: impl FnOnce(&mut Weir) -> R) -> Result<R, String> {
        self.run(caller, 0, vec![], f)
    }

    fn ok<R>(&mut self, caller: &str, f: impl FnOnce(&mut Weir) -> R) -> R {
        self.call(caller, f).unwrap_or_else(|err| panic!("{caller}: {err}"))
    }

    fn refused<R: std::fmt::Debug>(&mut self, caller: &str, err: &str, f: impl FnOnce(&mut Weir) -> R) {
        self.refused_with(caller, 0, err, f)
    }

    fn refused_with<R: std::fmt::Debug>(
        &mut self,
        caller: &str,
        deposit: u128,
        err: &str,
        f: impl FnOnce(&mut Weir) -> R,
    ) {
        match self.run(caller, deposit, vec![], f) {
            Ok(value) => panic!("expected {err:?}, got {value:?}"),
            Err(got) => assert!(got.contains(err), "expected {err:?}, got {got:?}"),
        }
    }

    fn view<R>(&self, f: impl FnOnce(&Weir) -> R) -> R {
        let weir: Weir = env::state_read().expect("initialized");
        f(&weir)
    }

    fn register(&mut self, name: &str) {
        self.run(name, REGISTRATION_FEE.as_yoctonear(), vec![], |w| w.register(None))
            .unwrap();
    }

    fn deposit(&mut self, name: &str, amount: u128) {
        let refund = self.ok(USDC, |w| w.ft_on_transfer(id(name), U128(amount), String::new()));
        assert_eq!(refund, U128(0));
    }

    fn funded(&mut self, names: &[&str]) {
        for name in names {
            self.register(name);
            self.deposit(name, 100 * DOLLAR);
        }
    }

    /// Reporters report `price` for the current bucket until it is final.
    fn print(&mut self, price: u64) -> u64 {
        let bucket = self.now - self.now % 10;
        for reporter in [R1, R2, R3] {
            if self.ok(reporter, |w| w.report(bucket, price, BUNDLE.into())) {
                return bucket;
            }
        }
        panic!("bucket {bucket} did not become final");
    }

    fn commit(&mut self, name: &str, side: Side, size: u64, price: u64, lock: u128) -> u32 {
        self.try_commit(name, side, size, price, lock).unwrap()
    }

    fn try_commit(&mut self, name: &str, side: Side, size: u64, price: u64, lock: u128) -> Result<u32, String> {
        self.try_commit_in(0, name, side, size, price, lock)
    }

    fn try_commit_in(&mut self, series: u32, name: &str, side: Side, size: u64, price: u64, lock: u128) -> Result<u32, String> {
        let schedule = params().schedule();
        let round = self.now.saturating_sub(schedule.auction_open(series)) / schedule.round_secs();
        let hash = hex::encode(hash::commit_hash(series, round, name, side, size, price, SALT));
        self.call(name, |w| w.commit(series, hash, U128(lock)))
    }

    fn reveal(&mut self, name: &str, round: u64, seq: u32, side: Side, size: u64, price: u64) -> Result<(), String> {
        self.call(name, |w| w.reveal(0, round, seq, side, size, price, SALT.into()))
    }

    fn balance(&self, name: &str) -> u128 {
        self.view(|w| w.get_account(id(name)).map_or(0, |a| a.balance.0))
    }

    fn position(&self, name: &str) -> Position {
        self.view(|w| w.get_position(0, id(name)))
    }

    fn series(&self, series: u32) -> SeriesView {
        self.view(|w| w.get_series(series)).expect("series exists")
    }

    fn totals(&self) -> Totals {
        self.view(|w| w.totals)
    }

    /// Series 0 opened on a fresh print, at the start of round `round`'s commit phase.
    fn open_at_round(&mut self, round: u64) {
        self.at(round_start(round) - 5);
        self.print(PRICE);
        self.at(round_start(round));
    }
}

fn sum_of(t: Totals) -> u128 {
    t.free + t.locked + t.sets_backing + t.unredeemed + t.burned
}

// ---- new ----

#[test]
fn new_stores_the_params() {
    let h = H::new();
    assert_eq!(h.view(|w| w.get_params()), params());
    assert_eq!(h.view(|w| w.get_last_print()), None);
}

#[test]
fn new_refuses_bad_params() {
    type Edit = fn(&mut Params);
    let cases: Vec<(Edit, &str)> = vec![
        (|p| p.period_secs = 0, ERR_DURATION),
        (|p| p.lead_secs = 0, ERR_DURATION),
        (|p| p.commit_secs = 0, ERR_DURATION),
        (|p| p.reveal_secs = 0, ERR_DURATION),
        (|p| p.print_interval_secs = 0, ERR_DURATION),
        (|p| p.report_grace_secs = 0, ERR_DURATION),
        (|p| p.void_after_secs = 0, ERR_DURATION),
        (|p| p.max_anchor_age_secs = 0, ERR_DURATION),
        (|p| p.tick = 0, ERR_TICK),
        (|p| p.band_bps = 0, ERR_BAND_BPS),
        (|p| p.band_bps = 10_000, ERR_BAND_BPS),
        (|p| p.forfeit_bps = 10_001, ERR_FORFEIT_BPS),
        (|p| p.max_commits = 0, ERR_MAX_COMMITS),
        (|p| p.max_commits = 129, ERR_MAX_COMMITS),
        (|p| p.max_order_size = 0, ERR_MAX_ORDER_SIZE),
        (|p| p.cutoff_secs = p.lead_secs, ERR_CUTOFF),
        (|p| p.min_prints = 0, ERR_MIN_PRINTS),
        (|p| p.min_prints = 101, ERR_MIN_PRINTS_TOO_MANY),
        (|p| p.void_after_secs = 19, ERR_VOID_AFTER),
        (|p| {
            p.report_grace_secs = 1_001;
            p.void_after_secs = 2_000;
        }, ERR_GRACE),
        (|p| p.max_spread_bps = 0, ERR_MAX_SPREAD),
        (|p| p.max_spread_bps = 10_001, ERR_MAX_SPREAD),
        (|p| p.max_order_size = 1 << 47, ERR_CAPACITY),
        (|p| p.t0 += 5, ERR_BUCKET_GRID),
        (|p| p.period_secs = 1_005, ERR_BUCKET_GRID),
        (|p| p.reporters.clear(), ERR_REPORTERS),
        (|p| p.reporters = (0..10).map(|i| id(&format!("r{i}.near"))).collect(), ERR_REPORTERS),
        (|p| p.reporters = vec![id(R1), id(R2), id(R1)], ERR_REPORTERS),
        (|p| p.quorum = 0, ERR_QUORUM),
        (|p| p.quorum = 4, ERR_QUORUM),
    ];
    for (edit, err) in cases {
        let mut p = params();
        edit(&mut p);
        assert_eq!(check_params(&p), Err(err));
    }
    let mut edges = params();
    edges.band_bps = 9_999;
    edges.forfeit_bps = 10_000;
    edges.max_commits = 128;
    edges.cutoff_secs = 1_099;
    edges.quorum = 3;
    edges.min_prints = 100;
    edges.void_after_secs = 20;
    edges.max_spread_bps = 10_000;
    // With cutoff 0 below: 11 rounds of 128 commits, just below 2^52.
    edges.max_order_size = ((1u64 << 52) - 1) / 1_408;
    edges.reporters = (0..9).map(|i| id(&format!("r{i}.near"))).collect();
    assert_eq!(check_params(&edges), Ok(()));
    edges.cutoff_secs = 0;
    assert_eq!(check_params(&edges), Ok(()), "cutoff_secs may be zero");

    install(STRANGER, 0, 0, vec![], HashMap::new());
    let refused = catch_unwind(|| {
        let mut p = params();
        p.tick = 0;
        Weir::new(p)
    });
    assert!(message(refused.err().unwrap()).contains(ERR_TICK));
}

// ---- Section 5 ----

#[test]
fn register_for_self_or_another_and_refund_the_excess() {
    let mut h = H::new();
    let extra = 5_000;
    h.run(ALICE, REGISTRATION_FEE.as_yoctonear() + extra, vec![], |w| w.register(None))
        .unwrap();
    assert_eq!(event("register")["data"]["account_id"], ALICE);
    let refunds: Vec<_> = get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == id(ALICE))
        .flat_map(|r| r.actions)
        .collect();
    assert!(
        matches!(refunds.as_slice(), [MockAction::Transfer { deposit, .. }] if deposit.as_yoctonear() == extra),
        "{refunds:?}"
    );
    assert_eq!(h.view(|w| w.get_account(id(ALICE))), Some(AccountView { balance: U128(0), guard: None, max_round_lock: None }));

    h.run(ALICE, REGISTRATION_FEE.as_yoctonear(), vec![], |w| w.register(Some(id(BOB))))
        .unwrap();
    assert!(get_created_receipts().is_empty(), "no refund for an exact fee");
    assert!(h.view(|w| w.get_account(id(BOB))).is_some());

    let fee = REGISTRATION_FEE.as_yoctonear();
    h.refused_with(ALICE, fee, ERR_REGISTERED, |w| w.register(None));
    h.refused_with(ALICE, fee, ERR_REGISTERED, |w| w.register(Some(id(BOB))));
    h.refused_with(CAROL, fee - 1, ERR_FEE, |w| w.register(None));
    assert!(h.view(|w| w.get_account(id(CAROL))).is_none());
}

#[test]
fn deposit_credits_the_sender_or_the_account_in_msg() {
    let mut h = H::new();
    h.register(ALICE);
    h.register(BOB);
    assert_eq!(h.ok(USDC, |w| w.ft_on_transfer(id(ALICE), U128(700), String::new())), U128(0));
    assert_eq!(event("deposit")["data"], serde_json::json!({ "account_id": ALICE, "amount": "700" }));
    assert_eq!(h.ok(USDC, |w| w.ft_on_transfer(id(ALICE), U128(300), BOB.into())), U128(0));
    assert_eq!((h.balance(ALICE), h.balance(BOB)), (700, 300));

    // Not registered, or not an account id at all: the whole amount goes back.
    assert_eq!(h.ok(USDC, |w| w.ft_on_transfer(id(CAROL), U128(50), String::new())), U128(50));
    assert_eq!(h.ok(USDC, |w| w.ft_on_transfer(id(ALICE), U128(50), "Not An Account!".into())), U128(50));
    assert!(events().is_empty());

    h.refused(STRANGER, ERR_WRONG_TOKEN, |w| w.ft_on_transfer(id(ALICE), U128(1), String::new()));
    assert_eq!(h.totals().free, 1_000);
}

#[test]
fn withdraw_needs_exactly_one_yocto() {
    let mut h = H::new();
    h.funded(&[ALICE]);
    h.refused_with(ALICE, 0, ERR_ONE_YOCTO, |w| w.withdraw(U128(1)));
    h.refused_with(ALICE, 2, ERR_ONE_YOCTO, |w| w.withdraw(U128(1)));
    h.refused_with(ALICE, 1, ERR_ZERO_AMOUNT, |w| w.withdraw(U128(0)));
    h.refused_with(ALICE, 1, ERR_BALANCE, |w| w.withdraw(U128(100 * DOLLAR + 1)));
    h.refused_with(CAROL, 1, ERR_NOT_REGISTERED, |w| w.withdraw(U128(1)));
}

#[test]
fn withdraw_sends_and_a_failed_transfer_credits_back() {
    let mut h = H::new();
    h.funded(&[ALICE]);
    h.run(ALICE, 1, vec![], |w| w.withdraw(U128(30 * DOLLAR))).unwrap();
    assert_eq!(h.balance(ALICE), 70 * DOLLAR);
    assert_eq!(event("withdraw")["data"]["amount"], "30000000");
    let receipts = get_created_receipts();
    let transfer = receipts.iter().find(|r| r.receiver_id == id(USDC)).expect("ft_transfer");
    match &transfer.actions[0] {
        MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => {
            assert_eq!(method_name, b"ft_transfer");
            assert_eq!(attached_deposit.as_yoctonear(), 1);
            let args: Value = serde_json::from_slice(args).unwrap();
            assert_eq!(args["receiver_id"], ALICE);
            assert_eq!(args["amount"], "30000000");
        }
        other => panic!("{other:?}"),
    }
    assert!(receipts.iter().any(|r| r.receiver_id == id(CONTRACT)), "callback");

    h.run(CONTRACT, 0, vec![PromiseResult::Successful(vec![])], |w| {
        w.on_withdraw(id(ALICE), U128(30 * DOLLAR))
    })
    .unwrap();
    assert!(events().is_empty());
    assert_eq!(h.balance(ALICE), 70 * DOLLAR);

    h.run(ALICE, 1, vec![], |w| w.withdraw(U128(20 * DOLLAR))).unwrap();
    h.run(CONTRACT, 0, vec![PromiseResult::Failed], |w| {
        w.on_withdraw(id(ALICE), U128(20 * DOLLAR))
    })
    .unwrap();
    assert_eq!(event("withdraw_failed")["data"]["amount"], "20000000");
    assert_eq!(h.balance(ALICE), 70 * DOLLAR);
    assert_eq!(h.totals().free, 70 * DOLLAR);
}

#[test]
fn set_guard_needs_exactly_one_yocto() {
    let mut h = H::new();
    h.register(ALICE);
    h.refused_with(ALICE, 0, ERR_ONE_YOCTO, |w| w.set_guard(Some(5), None));
    h.refused_with(CAROL, 1, ERR_NOT_REGISTERED, |w| w.set_guard(Some(5), None));
    h.run(ALICE, 1, vec![], |w| w.set_guard(Some(5), None)).unwrap();
    assert_eq!(event("guard")["data"], serde_json::json!({ "account_id": ALICE, "guard": 5, "max_round_lock": null }));
    assert_eq!(h.view(|w| w.get_account(id(ALICE))).unwrap().guard, Some(5));
    h.run(ALICE, 1, vec![], |w| w.set_guard(None, None)).unwrap();
    assert_eq!(h.view(|w| w.get_account(id(ALICE))).unwrap().guard, None);
}

// ---- Section 6.1 ----

#[test]
fn opening_needs_a_fresh_print() {
    let mut h = H::new();
    h.funded(&[ALICE]);
    h.at(OPEN);
    assert_eq!(h.try_commit(ALICE, Side::Long, 1, 1_000, 1_000), Err(ERR_STALE.into()));
    h.refused(ALICE, ERR_STALE, |w| w.mint(0, 1));

    // A print at OPEN - 300 is exactly max_anchor_age_secs old at OPEN.
    h.at(OPEN - 300);
    let bucket = h.print(PRICE);
    assert_eq!(bucket, OPEN - 300);
    h.at(OPEN + 1);
    assert_eq!(h.try_commit(ALICE, Side::Long, 1, 1_000, 1_000), Err(ERR_STALE.into()));
    h.at(OPEN);
    h.commit(ALICE, Side::Long, 1, 1_000, 1_000);
    assert_eq!(
        event("series_opened")["data"],
        serde_json::json!({ "series": 0, "anchor": PRICE, "floor": FLOOR, "band": BAND })
    );
    let s = h.series(0);
    assert_eq!((s.anchor, s.floor, s.band, s.opened_at, s.pending_rounds), (PRICE, FLOOR, BAND, OPEN, vec![0]));
}

#[test]
fn opening_refuses_a_band_narrower_than_a_tick() {
    let mut h = H::new();
    h.funded(&[ALICE]);
    h.at(OPEN);
    h.print(9_999);
    h.refused(ALICE, ERR_BAND_TOO_NARROW, |w| w.mint(0, 1));
}

// ---- Section 6.2 ----

#[test]
fn commit_phase_boundaries_at_the_exact_second() {
    let mut h = H::new();
    h.funded(&[ALICE]);
    h.at(OPEN - 1);
    h.print(PRICE);
    assert_eq!(h.try_commit(ALICE, Side::Long, 1, 1_000, 1_000), Err(ERR_NOT_COMMIT_PHASE.into()));
    h.at(OPEN);
    assert_eq!(h.try_commit(ALICE, Side::Long, 1, 1_000, 1_000), Ok(0));
    h.at(OPEN + 59);
    assert_eq!(h.try_commit(ALICE, Side::Long, 1, 1_000, 1_000), Ok(1));
    h.at(OPEN + 60);
    assert_eq!(h.try_commit(ALICE, Side::Long, 1, 1_000, 1_000), Err(ERR_NOT_COMMIT_PHASE.into()));
    h.at(OPEN + 100);
    assert_eq!(h.try_commit(ALICE, Side::Long, 1, 1_000, 1_000), Ok(0), "round 1 starts at seq 0");
    h.at(CLOSE - 100);
    assert_eq!(h.try_commit(ALICE, Side::Long, 1, 1_000, 1_000), Ok(0), "the last round");
    h.at(CLOSE);
    assert_eq!(h.try_commit(ALICE, Side::Long, 1, 1_000, 1_000), Err(ERR_NOT_COMMIT_PHASE.into()));
    assert_eq!(h.series(0).pending_rounds, vec![0, 1, 9]);
}

#[test]
fn commit_checks_its_inputs() {
    let mut h = H::new();
    h.funded(&[ALICE]);
    h.open_at_round(0);
    let hash = "ab".repeat(32);
    h.refused(CAROL, ERR_NOT_REGISTERED, |w| w.commit(0, "ab".repeat(32), U128(1_000)));
    h.refused(ALICE, ERR_BAD_HASH, |w| w.commit(0, "AB".repeat(32), U128(1_000)));
    h.refused(ALICE, ERR_BAD_HASH, |w| w.commit(0, "ab".repeat(31), U128(1_000)));
    h.refused(ALICE, ERR_LOCK_TOO_SMALL, |w| w.commit(0, "ab".repeat(32), U128(999)));
    h.refused(ALICE, ERR_BALANCE, |w| w.commit(0, "ab".repeat(32), U128(100 * DOLLAR + 1)));
    assert_eq!(h.ok(ALICE, |w| w.commit(0, hash.clone(), U128(100 * DOLLAR))), 0);
    assert_eq!(
        event("commit")["data"],
        serde_json::json!({ "series": 0, "round": 0, "seq": 0, "account_id": ALICE, "hash": "ab".repeat(32), "lock": "100000000", "fee": "0" })
    );
    assert_eq!(h.balance(ALICE), 0);
    let round = h.view(|w| w.get_round(0, 0)).unwrap();
    assert_eq!(round.next_seq, 1);
    assert_eq!(
        round.commits,
        vec![CommitView {
            seq: 0,
            owner: id(ALICE),
            hash: "ab".repeat(32),
            lock: U128(100 * DOLLAR),
            fee: U128(0),
            state: CommitStateName::Committed,
            order: None,
        }]
    );
}

#[test]
fn a_full_round_evicts_the_smallest_lock_latest_first() {
    let mut h = H::new();
    h.funded(&[ALICE, BOB, CAROL, DAVE]);
    h.open_at_round(0);
    h.commit(ALICE, Side::Long, 1, 1_000, 5_000);
    h.commit(BOB, Side::Long, 1, 1_000, 3_000);
    h.commit(CAROL, Side::Long, 1, 1_000, 3_000);
    h.commit(ALICE, Side::Long, 1, 1_000, 4_000);
    let before = h.balance(CAROL);

    // Equal to the smallest is not enough.
    assert_eq!(h.try_commit(DAVE, Side::Long, 1, 1_000, 3_000), Err(ERR_ROUND_FULL.into()));
    assert_eq!(h.balance(DAVE), 100 * DOLLAR, "a refused commit takes nothing");

    // Larger: the latest of the two smallest (Carol's, seq 2) goes, in full.
    assert_eq!(h.try_commit(DAVE, Side::Long, 1, 1_000, 3_001), Ok(4));
    assert_eq!(
        event("evict")["data"],
        serde_json::json!({ "series": 0, "round": 0, "seq": 2, "account_id": CAROL, "lock": "3000", "fee": "0" })
    );
    assert_eq!(h.balance(CAROL), before + 3_000);
    let seqs: Vec<u32> = h.view(|w| w.get_round(0, 0)).unwrap().commits.iter().map(|c| c.seq).collect();
    assert_eq!(seqs, vec![0, 1, 3, 4]);
    assert_eq!(h.totals().locked, 5_000 + 3_000 + 4_000 + 3_001);
}

// ---- Section 6.3 ----

#[test]
fn reveal_phase_boundaries_at_the_exact_second() {
    let mut h = H::new();
    h.funded(&[ALICE]);
    h.open_at_round(0);
    let a = h.commit(ALICE, Side::Long, 1, 1_000, 1_000);
    let b = h.commit(ALICE, Side::Long, 1, 1_000, 1_000);
    h.at(reveal_start(0) - 1);
    assert_eq!(h.reveal(ALICE, 0, a, Side::Long, 1, 1_000), Err(ERR_NOT_REVEAL_PHASE.into()));
    h.at(reveal_start(0));
    assert_eq!(h.reveal(ALICE, 0, a, Side::Long, 1, 1_000), Ok(()));
    h.at(round_end(0));
    assert_eq!(h.reveal(ALICE, 0, b, Side::Long, 1, 1_000), Err(ERR_NOT_REVEAL_PHASE.into()));
    h.at(round_end(0) - 1);
    assert_eq!(h.reveal(ALICE, 0, b, Side::Long, 1, 1_000), Ok(()));
}

#[test]
fn reveal_refuses_and_leaves_the_commit_unrevealed() {
    let mut h = H::new();
    h.funded(&[ALICE, BOB]);
    h.open_at_round(0);
    // Exactly covered: 10 * 200_000 for the LONG, 10 * (400_000 - 150_000) for the SHORT.
    let long = h.commit(ALICE, Side::Long, 10, 200_000, 2_000_000);
    let short = h.commit(ALICE, Side::Short, 10, 150_000, 2_500_000);
    let small = h.commit(ALICE, Side::Long, 10, 200_000, 1_999_999);
    let small_short = h.commit(ALICE, Side::Short, 10, 150_000, 2_499_999);
    h.at(reveal_start(0));

    let reveal = |h: &mut H, who: &str, seq: u32, side: Side, size: u64, price: u64, salt: &str| {
        h.call(who, |w| w.reveal(0, 0, seq, side, size, price, salt.into()))
    };
    assert_eq!(reveal(&mut h, ALICE, 9, Side::Long, 10, 200_000, SALT), Err(ERR_NO_COMMIT.into()));
    assert_eq!(h.call(ALICE, |w| w.reveal(0, 1, 0, Side::Long, 10, 200_000, SALT.into())), Err(ERR_NO_COMMIT.into()));
    assert_eq!(reveal(&mut h, BOB, long, Side::Long, 10, 200_000, SALT), Err(ERR_NOT_OWNER.into()));
    assert_eq!(reveal(&mut h, ALICE, long, Side::Long, 10, 200_000, "00"), Err(ERR_BAD_SALT.into()));
    // Wrong hash: any field differs.
    assert_eq!(reveal(&mut h, ALICE, long, Side::Short, 10, 200_000, SALT), Err(ERR_HASH_MISMATCH.into()));
    assert_eq!(reveal(&mut h, ALICE, long, Side::Long, 11, 200_000, SALT), Err(ERR_HASH_MISMATCH.into()));
    assert_eq!(reveal(&mut h, ALICE, long, Side::Long, 10, 201_000, SALT), Err(ERR_HASH_MISMATCH.into()));
    let other_salt = "ff".repeat(16);
    assert_eq!(reveal(&mut h, ALICE, long, Side::Long, 10, 200_000, &other_salt), Err(ERR_HASH_MISMATCH.into()));
    // Under-locked by one micro-dollar on each side.
    assert_eq!(reveal(&mut h, ALICE, small, Side::Long, 10, 200_000, SALT), Err(ERR_UNDER_LOCKED.into()));
    assert_eq!(reveal(&mut h, ALICE, small_short, Side::Short, 10, 150_000, SALT), Err(ERR_UNDER_LOCKED.into()));
    let states: Vec<_> = h.view(|w| w.get_round(0, 0)).unwrap().commits.iter().map(|c| c.state).collect();
    assert!(states.iter().all(|s| *s == CommitStateName::Committed));

    assert_eq!(reveal(&mut h, ALICE, long, Side::Long, 10, 200_000, SALT), Ok(()));
    assert_eq!(
        event("reveal")["data"],
        serde_json::json!({ "series": 0, "round": 0, "seq": long, "account_id": ALICE, "side": "Long", "size": 10, "price": 200_000, "void": false })
    );
    assert_eq!(reveal(&mut h, ALICE, long, Side::Long, 10, 200_000, SALT), Err(ERR_ALREADY_REVEALED.into()));
    assert_eq!(reveal(&mut h, ALICE, short, Side::Short, 10, 150_000, SALT), Ok(()));
    let commit = &h.view(|w| w.get_round(0, 0)).unwrap().commits[0];
    assert_eq!(commit.state, CommitStateName::Revealed);
    assert_eq!(commit.order, Some(OrderSpec { side: Side::Long, size: 10, price: 200_000 }));
}

#[test]
fn reveal_checks_size_and_price() {
    let mut params = params();
    params.max_commits = 8;
    let mut h = H::with(params);
    h.funded(&[ALICE]);
    h.open_at_round(0);
    let cases = [
        (0, 1_000, ERR_BAD_SIZE),
        (1_001, 1_000, ERR_BAD_SIZE),
        (1, 0, ERR_BAD_PRICE),
        (1, 1_500, ERR_BAD_PRICE),
        (1, BAND, ERR_BAD_PRICE),
    ];
    let seqs: Vec<u32> = cases
        .iter()
        .map(|&(size, price, _)| h.commit(ALICE, Side::Long, size, price, 10 * DOLLAR))
        .collect();
    let edge_size = h.commit(ALICE, Side::Long, 1_000, 1_000, 10 * DOLLAR);
    h.at(reveal_start(0));
    for (&(size, price, err), seq) in cases.iter().zip(seqs) {
        assert_eq!(h.reveal(ALICE, 0, seq, Side::Long, size, price), Err(err.into()), "{size} @ {price}");
    }
    assert_eq!(h.reveal(ALICE, 0, edge_size, Side::Long, 1_000, 1_000), Ok(()));
}

// ---- Section 6.4 ----

#[test]
fn guard_voids_a_long_above_and_a_short_below_the_reference() {
    let mut h = H::new();
    h.funded(&[ALICE, BOB]);
    for who in [ALICE, BOB] {
        h.run(who, 1, vec![], |w| w.set_guard(Some(10_000), None)).unwrap();
    }
    h.open_at_round(0);
    // ref = 2_000_000 - 1_800_000 = 200_000. LONG void above 210_000, SHORT below 190_000.
    let long_ok = h.commit(ALICE, Side::Long, 1, 210_000, DOLLAR);
    let long_void = h.commit(ALICE, Side::Long, 1, 211_000, DOLLAR);
    let short_ok = h.commit(BOB, Side::Short, 1, 190_000, DOLLAR);
    let short_void = h.commit(BOB, Side::Short, 1, 189_000, DOLLAR);
    h.at(reveal_start(0));
    // The last print moves after the commits; the guard uses the one at reveal.
    h.print(PRICE);
    let (alice, bob) = (h.balance(ALICE), h.balance(BOB));
    h.reveal(ALICE, 0, long_ok, Side::Long, 1, 210_000).unwrap();
    assert_eq!(event("reveal")["data"]["void"], false);
    h.reveal(ALICE, 0, long_void, Side::Long, 1, 211_000).unwrap();
    assert_eq!(event("reveal")["data"]["void"], true);
    assert_eq!(h.balance(ALICE), alice + DOLLAR, "the void lock returns at once");
    h.reveal(BOB, 0, short_ok, Side::Short, 1, 190_000).unwrap();
    h.reveal(BOB, 0, short_void, Side::Short, 1, 189_000).unwrap();
    assert_eq!(h.balance(BOB), bob + DOLLAR);
    let states: Vec<_> = h.view(|w| w.get_round(0, 0)).unwrap().commits.iter().map(|c| c.state).collect();
    use CommitStateName::*;
    assert_eq!(states, vec![Revealed, Void, Revealed, Void]);
    assert_eq!(h.totals().locked, 2 * DOLLAR);

    // Void orders take no part and lose nothing at clearing.
    h.at(round_end(0));
    h.ok(STRANGER, |w| w.clear(0, 0));
    let result = h.view(|w| w.get_result(0, 0)).unwrap();
    assert_eq!((result.orders, result.commits, result.price, result.volume), (2, 4, Some(200_000), 1));
    assert_eq!(result.forfeited, U128(0));
}

#[test]
fn guard_and_reference_are_fixed_when_the_commit_is_made() {
    let mut h = H::new();
    h.funded(&[ALICE, BOB]);
    h.run(ALICE, 1, vec![], |w| w.set_guard(Some(0), None)).unwrap();
    h.open_at_round(0);
    // Committed with ref 0.20 and guard 0: a LONG at 0.001 is inside it.
    let kept = h.commit(ALICE, Side::Long, 1, 1_000, DOLLAR);
    h.at(round_start(0) + 10);
    // The index crashes below the floor: ref would clamp to 0 now.
    for reporter in [R1, R2, R3] {
        h.ok(reporter, |w| w.report(round_start(0) + 10, 1_000_000, BUNDLE.into()));
    }
    // A commit made now records ref 0, and Bob's guard does not exist yet.
    let late = h.commit(ALICE, Side::Long, 1, 1_000, DOLLAR);
    let unguarded = h.commit(BOB, Side::Long, 1, 1_000, DOLLAR);
    // Guards changed after commit change nothing.
    h.run(ALICE, 1, vec![], |w| w.set_guard(None, None)).unwrap();
    h.run(BOB, 1, vec![], |w| w.set_guard(Some(0), None)).unwrap();
    h.at(reveal_start(0));
    h.reveal(ALICE, 0, kept, Side::Long, 1, 1_000).unwrap();
    assert_eq!(event("reveal")["data"]["void"], false);
    h.reveal(ALICE, 0, late, Side::Long, 1, 1_000).unwrap();
    assert_eq!(event("reveal")["data"]["void"], true, "0.001 > 0 + 0 against the recorded ref");
    h.reveal(BOB, 0, unguarded, Side::Long, 1, 1_000).unwrap();
    assert_eq!(event("reveal")["data"]["void"], false, "no guard when committed");
}

#[test]
fn a_void_order_gets_its_lock_back_but_its_fee_stays_with_the_round() {
    let mut params = params();
    params.commit_fee = U128(500);
    let mut h = H::with(params);
    h.funded(&[ALICE]);
    h.run(ALICE, 1, vec![], |w| w.set_guard(Some(0), None)).unwrap();
    h.open_at_round(0);
    let seq = h.commit(ALICE, Side::Long, 1, 300_000, DOLLAR);
    assert_eq!(h.balance(ALICE), 100 * DOLLAR - DOLLAR - 500);
    h.at(reveal_start(0));
    h.reveal(ALICE, 0, seq, Side::Long, 1, 300_000).unwrap();
    assert_eq!(event("reveal")["data"]["void"], true);
    assert_eq!(h.balance(ALICE), 100 * DOLLAR - 500);
    assert_eq!(h.totals().locked, 500);
    h.at(round_end(0));
    h.ok(STRANGER, |w| w.clear(0, 0));
    assert_eq!((h.totals().locked, h.totals().burned), (0, 500));
}

// ---- Section 7 ----

/// Round 0 of series 0 with a crossing book, revealed, and the round over.
/// Alice LONG 10 @ 0.21, Bob LONG 5 @ 0.20, Carol SHORT 8 @ 0.19, and Dave
/// SHORT 10 @ 0.20, which is never revealed and forfeits.
fn crossed_round() -> H {
    let mut h = H::new();
    h.funded(&[ALICE, BOB, CAROL, DAVE]);
    h.open_at_round(0);
    let a = h.commit(ALICE, Side::Long, 10, 210_000, 3 * DOLLAR);
    let b = h.commit(BOB, Side::Long, 5, 200_000, DOLLAR);
    let c = h.commit(CAROL, Side::Short, 8, 190_000, 2 * DOLLAR);
    h.commit(DAVE, Side::Short, 10, 200_000, 4 * DOLLAR);
    h.at(reveal_start(0));
    h.reveal(ALICE, 0, a, Side::Long, 10, 210_000).unwrap();
    h.reveal(BOB, 0, b, Side::Long, 5, 200_000).unwrap();
    h.reveal(CAROL, 0, c, Side::Short, 8, 190_000).unwrap();
    h.at(round_end(0));
    h
}

#[test]
fn clear_prices_fills_and_accounts_for_every_commit() {
    let mut h = crossed_round();
    let before = h.totals();
    h.ok(STRANGER, |w| w.clear(0, 0));
    // D(0.19)=15 S=8; D(0.20)=15 S=8; D(0.21)=10 S=8. V*=8, |D-S| least at 0.21: D>S, so hi.
    let p = 210_000u64;
    assert_eq!(
        event("clear")["data"],
        serde_json::json!({ "series": 0, "round": 0, "price": p, "volume": 8, "forfeited": "400000", "fees": "0" })
    );
    let result = h.view(|w| w.get_result(0, 0)).unwrap();
    assert_eq!(result.long_size, 15);
    assert_eq!(result.short_size, 8);
    assert_eq!(result.cleared_at, round_end(0));
    let filled: Vec<(u32, u64)> = result.fills.iter().map(|f| (f.seq, f.filled)).collect();
    // Only filled orders are kept: Bob's LONG at 0.20 took no part in the trade.
    assert_eq!(filled, vec![(0, 8), (2, 8)]);
    assert!(h.view(|w| w.get_round(0, 0)).is_none(), "the book is deleted");

    // Alice paid 8 * 0.21; Bob nothing; Carol 8 * (0.40 - 0.21); Dave forfeited 10%.
    assert_eq!(h.balance(ALICE), 100 * DOLLAR - 8 * 210_000);
    assert_eq!(h.balance(BOB), 100 * DOLLAR);
    assert_eq!(h.balance(CAROL), 100 * DOLLAR - 8 * 190_000);
    assert_eq!(h.balance(DAVE), 100 * DOLLAR - 400_000);
    assert_eq!(h.position(ALICE), Position { long: 8, short: 0 });
    assert_eq!(h.position(CAROL), Position { long: 0, short: 8 });
    let s = h.series(0);
    assert_eq!((s.open_sets, s.pending_rounds), (8, vec![]));
    let after = h.totals();
    assert_eq!(after.locked, 0);
    assert_eq!(after.sets_backing, 8 * u128::from(BAND));
    assert_eq!(after.burned, 400_000, "Dave's forfeit belongs to nobody");
    assert_eq!(sum_of(after), sum_of(before));
}

#[test]
fn clear_refuses_early_empty_and_repeated_calls() {
    let mut h = crossed_round();
    h.at(round_end(0) - 1);
    h.refused(STRANGER, ERR_ROUND_NOT_OVER, |w| w.clear(0, 0));
    h.at(round_end(0));
    h.refused(STRANGER, ERR_NO_COMMITS, |w| w.clear(0, 1));
    h.refused(STRANGER, ERR_NO_COMMITS, |w| w.clear(7, 0));
    h.ok(STRANGER, |w| w.clear(0, 0));
    h.refused(STRANGER, ERR_CLEARED, |w| w.clear(0, 0));
}

#[test]
fn clear_without_a_cross_refunds_every_revealed_lock() {
    let mut h = H::new();
    h.funded(&[ALICE, BOB]);
    h.open_at_round(0);
    let a = h.commit(ALICE, Side::Long, 5, 100_000, DOLLAR);
    let b = h.commit(BOB, Side::Short, 5, 150_000, 2 * DOLLAR);
    h.at(reveal_start(0));
    h.reveal(ALICE, 0, a, Side::Long, 5, 100_000).unwrap();
    h.reveal(BOB, 0, b, Side::Short, 5, 150_000).unwrap();
    h.at(round_end(0));
    h.ok(BOB, |w| w.clear(0, 0));
    assert_eq!(event("clear")["data"]["price"], Value::Null);
    assert_eq!((h.balance(ALICE), h.balance(BOB)), (100 * DOLLAR, 100 * DOLLAR));
    assert_eq!(h.series(0).open_sets, 0);
}

#[test]
fn forfeit_rounds_down() {
    let mut params = params();
    params.forfeit_bps = 3_333;
    let mut h = H::with(params);
    h.funded(&[ALICE]);
    h.open_at_round(0);
    h.commit(ALICE, Side::Long, 1, 1_000, 1_001);
    h.at(round_end(0));
    h.ok(ALICE, |w| w.clear(0, 0));
    // 1_001 * 3_333 / 10_000 = 333.6 -> 333.
    assert_eq!(h.totals().burned, 333);
    assert_eq!(h.balance(ALICE), 100 * DOLLAR - 333);
}

// ---- Section 8 ----

#[test]
fn mint_merge_and_transfer() {
    let mut h = H::new();
    h.funded(&[ALICE, BOB]);
    h.at(OPEN - 1);
    h.print(PRICE);
    h.refused(ALICE, ERR_WINDOW_CLOSED, |w| w.mint(0, 1));
    h.at(OPEN);
    h.refused(ALICE, ERR_ZERO_SETS, |w| w.mint(0, 0));
    h.refused(ALICE, ERR_BALANCE, |w| w.mint(0, 251));
    h.ok(ALICE, |w| w.mint(0, 10));
    assert_eq!(event("mint")["data"], serde_json::json!({ "series": 0, "account_id": ALICE, "sets": 10 }));
    assert_eq!(h.balance(ALICE), 100 * DOLLAR - 10 * u128::from(BAND));
    assert_eq!(h.position(ALICE), Position { long: 10, short: 10 });
    assert_eq!(h.series(0).open_sets, 10);

    h.refused_with(ALICE, 0, ERR_ONE_YOCTO, |w| w.transfer_position(0, id(BOB), 4, 0));
    h.refused_with(ALICE, 1, ERR_NOT_REGISTERED, |w| w.transfer_position(0, id(CAROL), 4, 0));
    h.refused_with(ALICE, 1, ERR_POSITION_TOO_SMALL, |w| w.transfer_position(0, id(BOB), 11, 0));
    h.refused_with(ALICE, 1, ERR_SELF_TRANSFER, |w| w.transfer_position(0, id(ALICE), 1, 0));
    h.refused_with(ALICE, 1, ERR_NOTHING_TO_TRANSFER, |w| w.transfer_position(0, id(BOB), 0, 0));
    h.run(ALICE, 1, vec![], |w| w.transfer_position(0, id(BOB), 4, 1)).unwrap();
    assert_eq!(
        event("transfer_position")["data"],
        serde_json::json!({ "series": 0, "from": ALICE, "to": BOB, "long": 4, "short": 1 })
    );
    assert_eq!(h.position(ALICE), Position { long: 6, short: 9 });
    assert_eq!(h.position(BOB), Position { long: 4, short: 1 });

    h.refused(ALICE, ERR_ZERO_SETS, |w| w.merge(0, 0));
    h.refused(ALICE, ERR_POSITION_TOO_SMALL, |w| w.merge(0, 7));
    h.refused(ALICE, ERR_UNKNOWN_SERIES, |w| w.merge(1, 1));
    h.ok(ALICE, |w| w.merge(0, 6));
    assert_eq!(event("merge")["data"], serde_json::json!({ "series": 0, "account_id": ALICE, "sets": 6 }));
    assert_eq!(h.position(ALICE), Position { long: 0, short: 3 });
    assert_eq!(h.balance(ALICE), 100 * DOLLAR - 4 * u128::from(BAND));
    assert_eq!(h.series(0).open_sets, 4);

    h.at(CLOSE);
    h.refused(ALICE, ERR_WINDOW_CLOSED, |w| w.mint(0, 1));
    h.ok(BOB, |w| w.merge(0, 1));
    assert_eq!(h.position(BOB), Position { long: 3, short: 0 });
}

// ---- Section 9 ----

#[test]
fn report_checks_caller_bucket_window_price_and_bundle() {
    let mut h = H::new();
    let b = 1_000_000 - 1_000;
    h.at(b);
    h.refused(STRANGER, ERR_NOT_REPORTER, |w| w.report(b, PRICE, BUNDLE.into()));
    h.refused(R1, ERR_BUCKET, |w| w.report(b + 5, PRICE, BUNDLE.into()));
    h.refused(R1, ERR_ZERO_PRICE, |w| w.report(b, 0, BUNDLE.into()));
    h.refused(R1, ERR_BAD_BUNDLE, |w| w.report(b, PRICE, "AB".repeat(32)));
    h.refused(R1, ERR_BAD_BUNDLE, |w| w.report(b, PRICE, "ab".repeat(31)));
    // The window is [bucket, bucket + 10 + 20).
    h.at(b - 1);
    h.refused(R1, ERR_REPORT_WINDOW, |w| w.report(b, PRICE, BUNDLE.into()));
    h.at(b + 30);
    h.refused(R1, ERR_REPORT_WINDOW, |w| w.report(b, PRICE, BUNDLE.into()));
    h.at(b + 29);
    assert!(!h.ok(R1, |w| w.report(b, PRICE, BUNDLE.into())));
    assert_eq!(
        event("report")["data"],
        serde_json::json!({ "bucket": b, "reporter": R1, "price": PRICE, "bundle": BUNDLE })
    );
    h.refused(R1, ERR_DUPLICATE_REPORT, |w| w.report(b, PRICE, BUNDLE.into()));
    let print = h.view(|w| w.get_print(b)).unwrap();
    assert_eq!((print.price, print.state, print.reports.len()), (None, PrintState::Open, 1));
}

#[test]
fn every_reporter_reporting_decides_at_once_on_the_median() {
    let mut h = H::new();
    let b = T0 + 10;
    h.at(b);
    assert!(!h.ok(R1, |w| w.report(b, 2_000_000, BUNDLE.into())));
    assert!(!h.ok(R2, |w| w.report(b, 2_100_000, BUNDLE.into())));
    assert_eq!(h.view(|w| w.get_pending_prints()), vec![b]);
    // A wild third report cannot move the median.
    assert!(h.ok(R3, |w| w.report(b, 9_000_000, BUNDLE.into())));
    assert_eq!(event("print")["data"], serde_json::json!({ "bucket": b, "price": 2_100_000, "reports": 3 }));
    assert_eq!(h.view(|w| w.get_pending_prints()), Vec::<u64>::new());
    // Decided: nothing is stored and the call returns false, before the duplicate check.
    assert!(!h.ok(R1, |w| w.report(b, 2_000_000, BUNDLE.into())));
    assert!(events().is_empty());
    let print = h.view(|w| w.get_print(b)).unwrap();
    assert_eq!((print.price, print.state, print.reports.len()), (Some(2_100_000), PrintState::Final, 3));
    assert_eq!(h.view(|w| w.get_last_print()), Some(LastPrint { bucket: b, price: 2_100_000 }));
    assert_eq!(h.view(|w| w.get_accumulator(0)), AccumulatorView { sum: U128(2_100_000), count: 1 });
}

#[test]
fn a_bucket_short_of_reporters_waits_for_its_window_to_close() {
    let mut h = H::new();
    let b = T0 + 10;
    h.at(b);
    h.ok(R1, |w| w.report(b, 2_000_000, BUNDLE.into()));
    h.ok(R2, |w| w.report(b, 2_020_000, BUNDLE.into()));
    assert_eq!(h.view(|w| w.get_print(b)).unwrap().state, PrintState::Open);
    // The window is [b, b + 10 + 20).
    h.at(b + 29);
    h.refused(STRANGER, ERR_WINDOW_OPEN, |w| w.finalize_print(b));
    h.at(b + 30);
    h.refused(STRANGER, ERR_NO_REPORTS, |w| w.finalize_print(b - 10));
    // 2.00 and 2.02 are exactly 1% apart: within the spread, the mean.
    assert!(h.ok(STRANGER, |w| w.finalize_print(b)));
    assert_eq!(event("print")["data"], serde_json::json!({ "bucket": b, "price": 2_010_000, "reports": 2 }));
    h.refused(STRANGER, ERR_DECIDED, |w| w.finalize_print(b));
    h.refused(R3, ERR_REPORT_WINDOW, |w| w.report(b, 2_000_000, BUNDLE.into()));
}

#[test]
fn two_reports_further_apart_than_the_spread_make_no_print() {
    let mut h = H::new();
    h.at(T0);
    h.print(PRICE);
    let b = T0 + 10;
    h.at(b);
    h.ok(R1, |w| w.report(b, 2_000_000, BUNDLE.into()));
    h.ok(R2, |w| w.report(b, 2_020_001, BUNDLE.into()));
    h.at(b + 30);
    assert!(!h.ok(STRANGER, |w| w.finalize_print(b)));
    assert_eq!(event("no_print")["data"], serde_json::json!({ "bucket": b, "reports": 2 }));
    let print = h.view(|w| w.get_print(b)).unwrap();
    assert_eq!((print.price, print.state), (None, PrintState::NoPrint));
    assert_eq!(h.view(|w| w.get_last_print()).unwrap().bucket, T0);
    assert_eq!(h.view(|w| w.get_accumulator(0)).count, 1);
}

#[test]
fn fewer_reports_than_quorum_make_no_print() {
    let mut h = H::new();
    let b = T0 + 10;
    h.at(b);
    h.ok(R1, |w| w.report(b, 2_000_000, BUNDLE.into()));
    h.at(b + 30);
    assert!(!h.ok(STRANGER, |w| w.finalize_print(b)));
    assert_eq!(h.view(|w| w.get_print(b)).unwrap().state, PrintState::NoPrint);
    assert_eq!(h.view(|w| w.get_last_print()), None);
}

#[test]
fn a_report_decides_up_to_four_closed_buckets_oldest_first() {
    // A long grace keeps eleven buckets open at once, so six can wait together.
    let mut params = params();
    params.report_grace_secs = 100;
    let mut h = H::with(params);
    let now = T0 + 50;
    h.at(now);
    let waiting: Vec<u64> = (0..6).map(|k| T0 + 10 * k).collect();
    for &b in &waiting {
        h.ok(R1, |w| w.report(b, PRICE + b - T0, BUNDLE.into()));
        h.ok(R2, |w| w.report(b, PRICE + b - T0, BUNDLE.into()));
    }
    assert_eq!(h.view(|w| w.get_pending_prints()), waiting);
    // Every window above has closed by T0 + 160; a report for a new bucket decides
    // the four oldest, after storing its own report.
    let b = T0 + 160;
    h.at(b);
    assert!(!h.ok(R1, |w| w.report(b, PRICE, BUNDLE.into())));
    let names: Vec<String> = events().iter().map(|e| e["event"].as_str().unwrap().to_string()).collect();
    assert_eq!(names, vec!["report", "print", "print", "print", "print"]);
    let decided: Vec<u64> = events().iter().skip(1).map(|e| e["data"]["bucket"].as_u64().unwrap()).collect();
    assert_eq!(decided, waiting[..4]);
    assert_eq!(h.view(|w| w.get_pending_prints()), vec![T0 + 40, T0 + 50, b]);
    assert_eq!(h.view(|w| w.get_last_print()).unwrap().bucket, T0 + 30);
}

#[test]
fn the_pending_set_stays_small_whatever_reporters_do() {
    let mut h = H::new();
    // One reporter reports every bucket for a whole period, alone.
    for k in 0..100 {
        let b = T0 + 10 * k;
        h.at(b);
        h.ok(R1, |w| w.report(b, PRICE, BUNDLE.into()));
        // Open windows: 3 buckets; at most 4 closed ones are waiting at any time.
        assert!(h.view(|w| w.get_pending_prints()).len() <= 7);
    }
}

#[test]
fn prune_print_deletes_a_decided_bucket_but_not_the_index_state() {
    let mut h = H::new();
    let (a, b) = (T0 + 10, T0 + 20);
    h.at(a);
    h.print(PRICE);
    h.at(b);
    h.print(PRICE + 1_000);
    h.at(b + 10);
    h.ok(R1, |w| w.report(b + 10, PRICE, BUNDLE.into()));
    h.at(a + 1_999);
    h.refused(STRANGER, ERR_PRUNE_TOO_EARLY, |w| w.prune_print(a));
    h.refused(STRANGER, ERR_NO_REPORTS, |w| w.prune_print(a + 5));
    h.at(a + 2_000);
    h.refused(STRANGER, ERR_UNDECIDED, |w| w.prune_print(b + 10));
    h.ok(STRANGER, |w| w.prune_print(a));
    assert_eq!(event("prune_print")["data"], serde_json::json!({ "bucket": a }));
    assert!(h.view(|w| w.get_print(a)).is_none());
    assert_eq!(h.view(|w| w.get_prints(0, 10)).iter().map(|p| p.bucket).collect::<Vec<_>>(), vec![b]);
    assert_eq!(h.view(|w| w.get_last_print()), Some(LastPrint { bucket: b, price: PRICE + 1_000 }));
    assert_eq!(h.view(|w| w.get_accumulator(0)).count, 2);
    h.refused(STRANGER, ERR_NO_REPORTS, |w| w.prune_print(a));
}

#[test]
fn prints_before_t0_and_per_series_accumulators() {
    let mut h = H::new();
    h.at(T0 - 10);
    h.print(PRICE);
    h.at(T0 + 990);
    h.print(PRICE + 1);
    h.at(T0 + 1_000);
    h.print(PRICE + 3);
    assert_eq!(h.view(|w| w.get_accumulator(0)), AccumulatorView { sum: U128(u128::from(PRICE) + 1), count: 1 });
    assert_eq!(h.view(|w| w.get_accumulator(1)), AccumulatorView { sum: U128(u128::from(PRICE) + 3), count: 1 });
    let all = h.view(|w| w.get_prints(0, 200));
    assert_eq!(all.len(), 3);
    assert_eq!(h.view(|w| w.get_prints(T0, 1)).iter().map(|p| p.bucket).collect::<Vec<_>>(), vec![T0 + 990]);
    assert_eq!(h.view(|w| w.get_prints(T0 + 1_001, 5)), vec![]);
}

// ---- Sections 10 and 14 ----

/// `crossed_round` with `prints` prints in the delivery window and the clock at the
/// first second `settle` is allowed.
fn delivered(prints: &[u64]) -> H {
    let mut h = crossed_round();
    h.ok(STRANGER, |w| w.clear(0, 0));
    for (i, &price) in prints.iter().enumerate() {
        h.at(T0 + 100 * i as u64);
        h.print(price);
    }
    h.at(END + 20);
    h
}

#[test]
fn settle_waits_for_the_last_report_window() {
    let mut h = delivered(&[2_000_000, 2_000_000, 2_000_000]);
    h.at(END + 19);
    h.refused(STRANGER, ERR_DELIVERY_NOT_OVER, |w| w.settle(0));
    h.refused(STRANGER, ERR_UNKNOWN_SERIES, |w| w.settle(1));
    h.at(END + 20);
    h.ok(STRANGER, |w| w.settle(0));
    h.refused(STRANGER, ERR_SETTLED, |w| w.settle(0));
    h.refused(ALICE, ERR_SETTLED, |w| w.merge(0, 1));
}

#[test]
fn settle_waits_for_pending_rounds() {
    let mut h = crossed_round();
    for i in 0..3 {
        h.at(T0 + 100 * i);
        h.print(PRICE);
    }
    h.at(END + 20);
    h.refused(STRANGER, ERR_PENDING_ROUNDS, |w| w.settle(0));
    h.ok(STRANGER, |w| w.clear(0, 0));
    h.ok(STRANGER, |w| w.settle(0));
}

#[test]
fn settle_at_min_prints_and_redeem_for_another_account() {
    let mut h = delivered(&[2_100_000, 2_000_000, 2_000_001]);
    h.refused(STRANGER, ERR_NOT_SETTLED, |w| w.redeem(0, Some(id(ALICE))));
    h.refused(STRANGER, ERR_NOT_SETTLED, |w| w.prune_result(0, 0));
    let before = sum_of(h.totals());
    h.ok(STRANGER, |w| w.settle(0));
    // fixing = 6_100_001 / 3 = 2_033_333; LONG pays 233_333, SHORT 166_667.
    assert_eq!(
        event("settle")["data"],
        serde_json::json!({ "series": 0, "fixing": 2_033_333, "long_payout": 233_333, "short_payout": 166_667, "void": false })
    );
    let s = h.series(0).settlement.unwrap();
    assert_eq!((s.prints, s.void, s.settled_at), (3, false, END + 20));
    let t = h.totals();
    assert_eq!((t.sets_backing, t.unredeemed, t.burned), (0, 8 * 400_000, 400_000));
    assert_eq!(sum_of(t), before);

    let alice = h.balance(ALICE);
    h.ok(STRANGER, |w| w.redeem(0, Some(id(ALICE))));
    assert_eq!(event("redeem")["data"], serde_json::json!({ "series": 0, "account_id": ALICE, "amount": "1866664" }));
    assert_eq!(h.balance(ALICE), alice + 8 * 233_333);
    assert_eq!(h.position(ALICE), Position::default());
    h.refused(STRANGER, ERR_NO_POSITION, |w| w.redeem(0, Some(id(ALICE))));
    h.refused(BOB, ERR_NO_POSITION, |w| w.redeem(0, None));
    // Units still move after settlement.
    h.run(CAROL, 1, vec![], |w| w.transfer_position(0, id(BOB), 0, 2)).unwrap();
    let (carol, bob) = (h.balance(CAROL), h.balance(BOB));
    h.ok(CAROL, |w| w.redeem(0, None));
    h.ok(CAROL, |w| w.redeem(0, Some(id(BOB))));
    assert_eq!(h.balance(CAROL), carol + 6 * 166_667);
    assert_eq!(h.balance(BOB), bob + 2 * 166_667);
    assert_eq!(h.totals().unredeemed, 0);

    h.ok(STRANGER, |w| w.prune_result(0, 0));
    assert_eq!(event("prune_result")["data"], serde_json::json!({ "series": 0, "round": 0 }));
    assert!(h.view(|w| w.get_result(0, 0)).is_none());
    h.refused(STRANGER, ERR_NO_RESULT, |w| w.prune_result(0, 0));
}

#[test]
fn settle_decides_the_undecided_buckets_of_its_window_first() {
    let mut h = crossed_round();
    h.ok(STRANGER, |w| w.clear(0, 0));
    // Three buckets with two reports each, never finalized: each waits for its window.
    // The last bucket of the window is still pending when settle comes.
    for b in [T0 + 900, T0 + 960, T0 + 990] {
        h.at(b);
        h.ok(R1, |w| w.report(b, PRICE, BUNDLE.into()));
        h.ok(R2, |w| w.report(b, PRICE, BUNDLE.into()));
    }
    assert!(h.view(|w| w.get_pending_prints()).contains(&(T0 + 990)));
    h.at(END + 20);
    h.ok(STRANGER, |w| w.settle(0));
    assert_eq!(h.view(|w| w.get_pending_prints()), Vec::<u64>::new());
    let s = h.series(0).settlement.unwrap();
    assert_eq!((s.prints, s.void, s.fixing), (3, false, PRICE));
}

#[test]
fn void_settlement_with_some_prints_averages_them() {
    let mut h = delivered(&[2_100_000, 2_000_001]);
    h.refused(STRANGER, ERR_NOT_ENOUGH_PRINTS, |w| w.settle(0));
    h.at(END + 499);
    h.refused(STRANGER, ERR_NOT_ENOUGH_PRINTS, |w| w.settle(0));
    h.at(END + 500);
    h.ok(STRANGER, |w| w.settle(0));
    let s = h.series(0).settlement.unwrap();
    assert_eq!((s.fixing, s.long_payout, s.short_payout, s.prints, s.void), (2_050_000, 250_000, 150_000, 2, true));
}

#[test]
fn void_settlement_with_no_prints_fixes_mid_band() {
    let mut h = delivered(&[]);
    h.at(END + 500);
    h.ok(STRANGER, |w| w.settle(0));
    let s = h.series(0).settlement.unwrap();
    assert_eq!((s.fixing, s.long_payout, s.short_payout, s.prints, s.void), (2_000_000, 200_000, 200_000, 0, true));
}

#[test]
fn forfeits_and_fees_are_burned_and_nobody_collects_them() {
    let mut params = params();
    params.commit_fee = U128(1_000);
    let mut h = H::with(params);
    h.funded(&[ALICE, BOB]);
    h.open_at_round(0);
    // Alice holds every set of the series; Bob forfeits.
    h.ok(ALICE, |w| w.mint(0, 10));
    h.commit(BOB, Side::Long, 1, 1_000, 2 * DOLLAR);
    assert_eq!(event("commit")["data"]["fee"], "1000");
    h.at(round_end(0));
    h.ok(STRANGER, |w| w.clear(0, 0));
    assert_eq!(
        event("clear")["data"],
        serde_json::json!({ "series": 0, "round": 0, "price": null, "volume": 0, "forfeited": "200000", "fees": "1000" })
    );
    let result = h.view(|w| w.get_result(0, 0)).unwrap();
    assert_eq!((result.forfeited, result.fees), (U128(200_000), U128(1_000)));
    assert_eq!(h.totals().burned, 201_000);
    for i in 0..3 {
        h.at(T0 + 100 * i);
        h.print(PRICE);
    }
    h.at(END + 20);
    h.ok(STRANGER, |w| w.settle(0));
    let alice = h.balance(ALICE);
    h.ok(STRANGER, |w| w.redeem(0, Some(id(ALICE))));
    // Exactly the band per set: nothing of Bob's forfeit.
    assert_eq!(h.balance(ALICE), alice + 10 * u128::from(BAND));
    assert_eq!(h.balance(BOB), 100 * DOLLAR - 201_000);
}

#[test]
fn eviction_returns_the_fee_with_the_lock() {
    let mut params = params();
    params.commit_fee = U128(777);
    params.max_commits = 1;
    let mut h = H::with(params);
    h.funded(&[ALICE, BOB]);
    h.open_at_round(0);
    h.commit(ALICE, Side::Long, 1, 1_000, 5_000);
    h.commit(BOB, Side::Long, 1, 1_000, 5_001);
    assert_eq!(event("evict")["data"]["fee"], "777");
    assert_eq!(h.balance(ALICE), 100 * DOLLAR);
    assert_eq!(h.totals().locked, 5_001 + 777);
    let round = h.view(|w| w.get_round(0, 0)).unwrap();
    assert_eq!(round.commits[0].fee, U128(777));
}

#[test]
fn commits_beyond_the_round_lock_limit_are_refused() {
    let mut h = H::new();
    h.funded(&[ALICE]);
    h.refused_with(ALICE, 0, ERR_ONE_YOCTO, |w| w.set_guard(None, Some(U128(5 * DOLLAR))));
    h.run(ALICE, 1, vec![], |w| w.set_guard(None, Some(U128(5 * DOLLAR)))).unwrap();
    assert_eq!(event("guard")["data"]["max_round_lock"], "5000000");
    assert_eq!(h.view(|w| w.get_account(id(ALICE))).unwrap().max_round_lock, Some(U128(5 * DOLLAR)));
    h.open_at_round(0);
    h.commit(ALICE, Side::Long, 1, 1_000, 3 * DOLLAR);
    h.commit(ALICE, Side::Long, 1, 1_000, 2 * DOLLAR);
    assert_eq!(h.try_commit(ALICE, Side::Long, 1, 1_000, 1_000), Err(ERR_ROUND_LOCK.into()));
    // The limit is per round.
    h.at(round_start(1));
    h.commit(ALICE, Side::Long, 1, 1_000, 5 * DOLLAR);
}

#[test]
fn the_round_lock_limit_counts_commits_before_any_eviction() {
    let mut params = params();
    params.max_commits = 1;
    let mut h = H::with(params);
    h.funded(&[ALICE]);
    h.run(ALICE, 1, vec![], |w| w.set_guard(None, Some(U128(5 * DOLLAR)))).unwrap();
    h.open_at_round(0);
    h.commit(ALICE, Side::Long, 1, 1_000, 3 * DOLLAR);
    // This would evict Alice's own 3 $ commit and leave 4 $ in the round, but the
    // limit is counted first: 3 + 4 > 5.
    assert_eq!(h.try_commit(ALICE, Side::Long, 1, 1_000, 4 * DOLLAR), Err(ERR_ROUND_LOCK.into()));
}

#[test]
fn commit_refuses_an_unregistered_caller_before_anything_else() {
    let mut h = H::new();
    // Outside any commit phase and with a bad hash: registration is still checked first.
    h.at(OPEN - 1);
    h.refused(CAROL, ERR_NOT_REGISTERED, |w| w.commit(0, "XYZ".into(), U128(0)));
}

#[test]
fn mint_stops_at_the_cap_and_a_full_round_still_clears() {
    let mut params = params();
    params.max_commits = 2;
    let mut h = H::with(params.clone());
    let cap = (1u64 << 53) - 1 - params.max_order_size * 2 * params.rounds_per_series();
    let whale_dollars = u128::from(cap) * u128::from(BAND);
    h.run(ALICE, REGISTRATION_FEE.as_yoctonear(), vec![], |w| w.register(None)).unwrap();
    h.ok(USDC, |w| w.ft_on_transfer(id(ALICE), U128(whale_dollars + 300 * DOLLAR), String::new()));
    h.funded(&[BOB]);
    h.deposit(BOB, 200 * DOLLAR);
    h.open_at_round(0);
    h.refused(ALICE, ERR_TOO_MANY_SETS, |w| w.mint(0, cap + 1));
    h.ok(ALICE, |w| w.mint(0, cap - 5));
    h.refused(ALICE, ERR_TOO_MANY_SETS, |w| w.mint(0, 6));
    h.ok(ALICE, |w| w.mint(0, 5));
    // Each round at most max_order_size * max_commits more: a full trading round.
    let a = h.commit(ALICE, Side::Long, 1_000, 200_000, 200 * DOLLAR);
    let b = h.commit(BOB, Side::Short, 1_000, 200_000, 200 * DOLLAR);
    h.at(reveal_start(0));
    h.reveal(ALICE, 0, a, Side::Long, 1_000, 200_000).unwrap();
    h.reveal(BOB, 0, b, Side::Short, 1_000, 200_000).unwrap();
    h.at(round_end(0));
    h.ok(STRANGER, |w| w.clear(0, 0));
    assert_eq!(u128::from(h.series(0).open_sets), u128::from(cap) + 1_000);
    assert!(u128::from(h.series(0).open_sets) <= MAX_UNITS);
}

// ---- Section 12 ----

#[test]
fn status_lists_live_series_with_round_and_phase() {
    let mut h = H::new();
    h.at(OPEN - 1);
    assert_eq!(h.view(|w| w.get_status()), StatusView { now: OPEN - 1, live: vec![] });
    let live = |h: &mut H, now: u64| {
        h.at(now);
        h.view(|w| w.get_status()).live
    };
    let s = live(&mut h, reveal_start(3));
    assert_eq!(
        s,
        vec![LiveSeries {
            series: 0,
            delivery_start: T0,
            delivery_end: END,
            auction_open: OPEN,
            auction_close: CLOSE,
            round: Some(3),
            phase: Phase::Reveal,
            phase_ends_at: Some(round_end(3)),
        }]
    );
    let s = live(&mut h, round_start(8) + 1);
    assert_eq!((s[0].round, s[0].phase, s[0].phase_ends_at), (Some(8), Phase::Commit, Some(reveal_start(8))));
    // lead = period + cutoff: one series is in auction at a time, back to back.
    let s = live(&mut h, CLOSE - 1);
    assert_eq!((s.len(), s[0].series, s[0].round, s[0].phase), (1, 0, Some(9), Phase::Reveal));
    let s = live(&mut h, CLOSE);
    assert_eq!((s.len(), s[0].series, s[0].round, s[0].phase), (1, 1, Some(0), Phase::Commit));
    let s = live(&mut h, T0 + 400);
    assert_eq!((s.len(), s[0].series, s[0].round), (1, 1, Some(5)));
}

#[test]
fn closed_tail_of_a_window_has_no_round() {
    let mut params = params();
    params.cutoff_secs = 150;
    let mut h = H::with(params);
    // Nine whole rounds end at T0 - 200; the window closes at T0 - 150.
    h.at(T0 - 180);
    let s = h.view(|w| w.get_status()).live;
    assert_eq!((s[0].round, s[0].phase, s[0].phase_ends_at), (None, Phase::Closed, None));
}

#[test]
fn results_are_listed_by_round() {
    let mut h = crossed_round();
    h.ok(STRANGER, |w| w.clear(0, 0));
    h.at(round_start(2));
    h.commit(ALICE, Side::Long, 1, 1_000, 1_000);
    h.at(round_end(2));
    h.ok(STRANGER, |w| w.clear(0, 2));
    let rounds: Vec<u64> = h.view(|w| w.get_results(0, 0, 10)).iter().map(|(r, _)| *r).collect();
    assert_eq!(rounds, vec![0, 2]);
    assert_eq!(h.view(|w| w.get_results(0, 1, 1)), vec![]);
    assert_eq!(h.view(|w| w.get_results(0, u64::MAX, 200)), vec![]);
    // The range is from_round to from_round + limit - 1.
    assert_eq!(h.view(|w| w.get_results(0, 0, 2)).len(), 1);
    assert_eq!(h.view(|w| w.get_results(0, 0, 3)).len(), 2);
}

#[test]
fn get_results_looks_at_100_rounds_at_most() {
    let mut params = params();
    params.lead_secs = 20_000;
    let mut h = H::with(params);
    h.funded(&[ALICE]);
    let open = T0 - 20_000;
    for round in [0u64, 100] {
        let start = open + 100 * round;
        h.at(start);
        h.print(PRICE);
        let hash = hex::encode(hash::commit_hash(0, round, ALICE, Side::Long, 1, 1_000, SALT));
        h.ok(ALICE, |w| w.commit(0, hash, U128(1_000)));
        h.at(start + 100);
        h.ok(ALICE, |w| w.clear(0, round));
    }
    let rounds = |h: &H, from: u64, limit: u32| -> Vec<u64> {
        h.view(|w| w.get_results(0, from, limit)).into_iter().map(|(r, _)| r).collect()
    };
    assert_eq!(rounds(&h, 0, 101), vec![0]);
    assert_eq!(rounds(&h, 0, u32::MAX), vec![0]);
    assert_eq!(rounds(&h, 1, 100), vec![100]);
    assert_eq!(rounds(&h, 0, 0), Vec::<u64>::new());
}

#[test]
fn commit_hash_view_matches_section_6_2() {
    let h = H::new();
    let got = h.view(|w| w.commit_hash(0, 0, id("a.near"), Side::Long, 1, 1_000, "0".repeat(32)));
    assert_eq!(got, "b8cb1fd8d730d14e83eeee09dbf77f01a86fbb18655fb1e083d06d248c277c1e");
    let refused = catch_unwind(|| h.view(|w| w.commit_hash(0, 0, id("a.near"), Side::Long, 1, 1_000, "0".into())));
    assert!(message(refused.err().unwrap()).contains(ERR_BAD_SALT));
}

#[test]
fn views_serialize_as_section_12_says() {
    let mut h = delivered(&[2_000_000, 2_000_000, 2_000_000]);
    h.ok(STRANGER, |w| w.settle(0));
    let series = serde_json::to_value(h.series(0)).unwrap();
    assert!(series.get("bonus_pool").is_none());
    assert!(series["settlement"].get("bonus_long").is_none());
    assert_eq!(series["settlement"]["fixing"], 2_000_000);
    let result = serde_json::to_value(h.view(|w| w.get_result(0, 0))).unwrap();
    assert_eq!((result["forfeited"].as_str(), result["fees"].as_str()), (Some("400000"), Some("0")));
    assert_eq!(result["fills"][0]["side"], "Long");
    let print = serde_json::to_value(h.view(|w| w.get_print(T0))).unwrap();
    assert_eq!(print["state"], "Final");
    let totals = serde_json::to_value(h.view(|w| w.get_totals())).unwrap();
    let mut keys: Vec<_> = totals.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, vec!["burned", "free", "locked", "sets_backing", "unredeemed"]);
    let account = serde_json::to_value(h.view(|w| w.get_account(id(ALICE)))).unwrap();
    assert_eq!(account["max_round_lock"], Value::Null);
}

#[test]
fn totals_balance_the_books_through_a_whole_life() {
    let mut h = crossed_round();
    let deposits = 400 * DOLLAR;
    assert_eq!(sum_of(h.totals()), deposits);
    h.ok(STRANGER, |w| w.clear(0, 0));
    for i in 0..3 {
        h.at(T0 + 100 * i);
        h.print(PRICE);
    }
    h.at(END + 20);
    h.ok(STRANGER, |w| w.settle(0));
    for who in [ALICE, CAROL] {
        h.ok(STRANGER, |w| w.redeem(0, Some(id(who))));
    }
    let t = h.totals();
    assert_eq!((t.locked, t.sets_backing, t.unredeemed, t.burned), (0, 0, 0, 400_000));
    assert_eq!(t.free + t.burned, deposits);
    let each: u128 = [ALICE, BOB, CAROL, DAVE].iter().map(|w| h.balance(w)).sum();
    assert_eq!(each, deposits - 400_000);
}
