//! Property tests for spec section 11.
//!
//! - Clearing (invariants 3 and 4): random order books against `clearing::clear`,
//!   with invariant 4 checked by brute force over every tick price in range.
//! - The contract (invariants 1, 2 and 5): random sequences of calls in near-sdk's
//!   unit-testing context. Each call runs like a transaction: a panic restores the
//!   state from before it. After every step the totals are recomputed from views
//!   and compared with `get_totals` and with the dollars the contract holds.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::panic::{catch_unwind, AssertUnwindSafe};

use near_sdk::json_types::U128;
use near_sdk::mock::with_mocked_blockchain;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{
    env, test_vm_config, AccountId, Gas, MockedBlockchain, NearToken, PromiseResult,
    RuntimeFeesConfig,
};
use proptest::prelude::*;
use weir::clearing::{self, Order};
use weir::types::{CommitStateName, Params, Position, Side};
use weir::{Weir, REGISTRATION_FEE};

// ---- Invariants 3 and 4 ----

const TICK: u64 = 1_000;
/// Order prices are 1 to 20 ticks.
const MAX_TICKS: u64 = 20;

fn order_book() -> impl Strategy<Value = Vec<Order>> {
    prop::collection::vec((any::<bool>(), 1..=50u64, 1..=MAX_TICKS), 0..=40).prop_flat_map(|raw| {
        let n = raw.len();
        (
            Just(raw),
            Just((0..n as u32).collect::<Vec<_>>()).prop_shuffle(),
        )
            .prop_map(|(raw, seqs)| {
                raw.into_iter()
                    .zip(seqs)
                    .map(|((long, size, ticks), seq)| Order {
                        seq,
                        side: if long { Side::Long } else { Side::Short },
                        size,
                        price: ticks * TICK,
                    })
                    .collect()
            })
    })
}

/// Section 7.2's queue for one side, best first.
fn priority(orders: &[Order], side: Side, price: u64) -> Vec<usize> {
    let mut queue: Vec<usize> = (0..orders.len())
        .filter(|&i| {
            let o = orders[i];
            o.side == side
                && match side {
                    Side::Long => o.price >= price,
                    Side::Short => o.price <= price,
                }
        })
        .collect();
    queue.sort_by_key(|&i| {
        let o = orders[i];
        let rank = match side {
            Side::Long => u64::MAX - o.price,
            Side::Short => o.price,
        };
        (rank, o.seq)
    });
    queue
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2_000))]

    #[test]
    fn clearing_fills_are_balanced_bounded_and_within_limits(orders in order_book()) {
        let c = clearing::clear(&orders, TICK);
        prop_assert_eq!(c.fills.len(), orders.len());
        let filled = |side: Side| -> u64 {
            orders.iter().zip(&c.fills).filter(|(o, _)| o.side == side).map(|(_, f)| f).sum()
        };
        // Invariant 3.
        prop_assert_eq!(filled(Side::Long), c.volume);
        prop_assert_eq!(filled(Side::Short), c.volume);
        for (o, &f) in orders.iter().zip(&c.fills) {
            prop_assert!(f <= o.size);
            if f > 0 {
                let p = c.price.unwrap();
                match o.side {
                    Side::Long => prop_assert!(o.price >= p, "LONG filled above its limit"),
                    Side::Short => prop_assert!(o.price <= p, "SHORT filled below its limit"),
                }
            }
        }
        match c.price {
            None => {
                prop_assert_eq!(c.volume, 0);
                prop_assert!(c.fills.iter().all(|&f| f == 0));
            }
            Some(p) => {
                prop_assert!(c.volume > 0);
                prop_assert_eq!(p % TICK, 0);
                prop_assert!(p > 0 && p <= MAX_TICKS * TICK);
                prop_assert_eq!(clearing::volume_at(&orders, p), u128::from(c.volume));
                // Section 7.2: each side fills a prefix of its queue.
                for side in [Side::Long, Side::Short] {
                    let mut short_seen = false;
                    for i in priority(&orders, side, p) {
                        if short_seen {
                            prop_assert_eq!(c.fills[i], 0, "a later order filled before an earlier one was full");
                        }
                        short_seen |= c.fills[i] < orders[i].size;
                    }
                }
            }
        }
    }

    #[test]
    fn no_tick_price_trades_more_than_the_clearing_price(orders in order_book()) {
        let c = clearing::clear(&orders, TICK);
        // Invariant 4, by brute force over every tick price and one past each end.
        for ticks in 0..=MAX_TICKS + 1 {
            prop_assert!(clearing::volume_at(&orders, ticks * TICK) <= u128::from(c.volume));
        }
    }
}

// ---- Invariants 1, 2 and 5 ----

const CONTRACT: &str = "weir.near";
const USDC: &str = "usdc.near";
const TRADERS: [&str; 4] = ["a.near", "b.near", "c.near", "d.near"];
const REPORTERS: [&str; 3] = ["r1.near", "r2.near", "r3.near"];
const SALT: &str = "0123456789abcdef0123456789abcdef";
const BUNDLE: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
const T0: u64 = 100_000;
const SERIES: [u32; 2] = [0, 1];
const DOLLAR: u128 = 1_000_000;
const FEE: u128 = 500;

fn id(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn params() -> Params {
    Params {
        usdc: id(USDC),
        underlying: "H100-USD-HR".into(),
        t0: T0,
        period_secs: 600,
        lead_secs: 650,
        cutoff_secs: 50,
        commit_secs: 30,
        reveal_secs: 20,
        band_bps: 1_000,
        tick: 1_000,
        print_interval_secs: 10,
        report_grace_secs: 20,
        max_spread_bps: 100,
        min_prints: 2,
        void_after_secs: 100,
        max_anchor_age_secs: 300,
        forfeit_bps: 2_500,
        min_lock: U128(1_000),
        commit_fee: U128(FEE),
        max_commits: 3,
        max_order_size: 20,
        reporters: REPORTERS.iter().map(|r| id(r)).collect(),
        quorum: 2,
    }
}

fn install(
    caller: &str,
    now: u64,
    deposit: u128,
    results: Vec<PromiseResult>,
    storage: HashMap<Vec<u8>, Vec<u8>>,
) {
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

/// Runs `f` as one transaction: on a panic, storage goes back to how it was.
fn call<R>(
    now: u64,
    caller: &str,
    deposit: u128,
    results: Vec<PromiseResult>,
    f: impl FnOnce(&mut Weir) -> R,
) -> Option<R> {
    let storage = with_mocked_blockchain(|b| b.take_storage());
    install(caller, now, deposit, results, storage.clone());
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let mut weir: Weir = env::state_read().expect("initialized");
        let result = f(&mut weir);
        env::state_write(&weir);
        result
    }));
    match outcome {
        Ok(result) => {
            SEEN.with(|seen| {
                let mut seen = seen.borrow_mut();
                for log in get_logs() {
                    let event: near_sdk::serde_json::Value =
                        near_sdk::serde_json::from_str(log.strip_prefix("EVENT_JSON:").unwrap())
                            .unwrap();
                    let mut name = event["event"].as_str().unwrap().to_string();
                    if name == "reveal" && event["data"]["void"] == true {
                        name = "void reveal".into();
                    }
                    if name == "clear" && event["data"]["volume"] != 0 {
                        name = "clear with a trade".into();
                    }
                    if name == "settle" && event["data"]["void"] == true {
                        name = "void settle".into();
                    }
                    *seen.entry(name).or_default() += 1;
                }
            });
            Some(result)
        }
        Err(payload) => {
            install(caller, now, 0, vec![], storage);
            let raw = payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            let reason = raw
                .split_once("panic_msg: \"")
                .map_or(raw.as_str(), |(_, m)| m.trim_end_matches("\" })"));
            SEEN.with(|seen| {
                *seen
                    .borrow_mut()
                    .entry(format!("refused: {reason}"))
                    .or_default() += 1
            });
            None
        }
    }
}

thread_local! {
    /// Events from successful calls, to show the random walks reach every stage.
    static SEEN: RefCell<BTreeMap<String, usize>> = const { RefCell::new(BTreeMap::new()) };
}

fn view<R>(f: impl FnOnce(&Weir) -> R) -> R {
    let weir: Weir = env::state_read().expect("initialized");
    f(&weir)
}

#[derive(Clone, Debug)]
enum Action {
    Advance(u64),
    /// To the next phase boundary of either series, plus a few seconds.
    NextPhase(u64),
    Deposit(usize, u128),
    Withdraw(usize, u128, bool),
    PrintAll(u64),
    Report(usize, u64),
    /// `lock` is `None` for a lock that covers any order of this size.
    Commit {
        who: usize,
        series: u32,
        long: bool,
        size: u64,
        ticks: u64,
        lock: Option<u128>,
    },
    Reveal(usize),
    Clear(usize),
    Mint(usize, u32, u64),
    Merge(usize, u32, u64),
    Transfer(usize, usize, u32, u64, u64),
    Settle(u32),
    Redeem(usize, usize, u32),
    Guard(usize, Option<u64>, Option<u128>),
    Finalize(usize),
}

fn action() -> impl Strategy<Value = Action> {
    let who = 0..TRADERS.len();
    let series = prop::sample::select(SERIES.to_vec());
    let price = prop::sample::select(vec![1_900_000u64, 2_000_000, 2_050_000, 2_400_000]);
    prop_oneof![
        3 => (1..=10u64).prop_map(Action::Advance),
        2 => (0..=3u64).prop_map(Action::NextPhase),
        1 => (150..=500u64).prop_map(Action::Advance),
        3 => (who.clone(), 1..=50 * DOLLAR).prop_map(|(w, a)| Action::Deposit(w, a)),
        1 => (who.clone(), 1..=60 * DOLLAR, any::<bool>()).prop_map(|(w, a, f)| Action::Withdraw(w, a, f)),
        3 => price.clone().prop_map(Action::PrintAll),
        1 => (0..REPORTERS.len(), price).prop_map(|(r, p)| Action::Report(r, p)),
        // Prices cluster around the middle of the band so that rounds cross; most
        // locks cover any order, some are too small for theirs.
        12 => (who.clone(), series.clone(), any::<bool>(), 1..=20u64, prop_oneof![9 => 150..=250u64, 1 => 1..=419u64], prop_oneof![
                6 => Just(None),
                1 => (1_000..=3 * DOLLAR).prop_map(Some),
            ])
            .prop_map(|(who, series, long, size, ticks, lock)| Action::Commit { who, series, long, size, ticks, lock }),
        14 => any::<usize>().prop_map(Action::Reveal),
        3 => any::<usize>().prop_map(Action::Clear),
        2 => (who.clone(), series.clone(), 1..=5u64).prop_map(|(w, s, n)| Action::Mint(w, s, n)),
        1 => (who.clone(), series.clone(), 1..=5u64).prop_map(|(w, s, n)| Action::Merge(w, s, n)),
        1 => (who.clone(), who.clone(), series.clone(), 0..=3u64, 0..=3u64)
            .prop_map(|(f, t, s, l, sh)| Action::Transfer(f, t, s, l, sh)),
        2 => series.clone().prop_map(Action::Settle),
        2 => (who.clone(), who.clone(), series).prop_map(|(by, of, s)| Action::Redeem(by, of, s)),
        1 => (who, prop::option::of(0..=50_000u64), prop::option::of(1_000..=20 * DOLLAR))
            .prop_map(|(w, g, l)| Action::Guard(w, g, l)),
        1 => any::<usize>().prop_map(Action::Finalize),
    ]
}

#[derive(Clone, Copy, Debug)]
struct Committed {
    series: u32,
    round: u64,
    seq: u32,
    who: usize,
    side: Side,
    size: u64,
    price: u64,
}

#[derive(Default)]
struct World {
    now: u64,
    /// USDC the contract holds: deposits less withdrawals that went through.
    held: u128,
    commits: Vec<Committed>,
    rounds: BTreeSet<(u32, u64)>,
}

/// Every account's dollars: free balance plus the locks and fees its commits hold.
fn dollars(world: &World) -> Vec<u128> {
    let mut held = vec![0u128; TRADERS.len()];
    for (i, t) in TRADERS.iter().enumerate() {
        held[i] = view(|w| w.get_account(id(t))).map_or(0, |a| a.balance.0);
    }
    for &(series, round) in &world.rounds {
        for c in view(|w| w.get_round(series, round))
            .map(|r| r.commits)
            .unwrap_or_default()
        {
            held[trader(&c.owner)] += held_by(&c);
        }
    }
    held
}

fn locks_in(series: u32, round: u64) -> Vec<u128> {
    let mut locks = vec![0u128; TRADERS.len()];
    for c in view(|w| w.get_round(series, round))
        .map(|r| r.commits)
        .unwrap_or_default()
    {
        locks[trader(&c.owner)] += held_by(&c);
    }
    locks
}

/// What a commit still holds: its fee, and its lock unless the guard voided it.
fn held_by(c: &weir::types::CommitView) -> u128 {
    let lock = if c.state == CommitStateName::Void {
        0
    } else {
        c.lock.0
    };
    lock + c.fee.0
}

fn trader(account: &AccountId) -> usize {
    TRADERS
        .iter()
        .position(|t| account.as_str() == *t)
        .expect("a trader")
}

fn positions() -> BTreeMap<(u32, usize), Position> {
    let mut all = BTreeMap::new();
    for series in SERIES {
        for (i, t) in TRADERS.iter().enumerate() {
            all.insert((series, i), view(|w| w.get_position(series, id(t))));
        }
    }
    all
}

/// Applies one action and returns how many dollars each trader may have lost by it.
fn apply(world: &mut World, action: &Action) -> Vec<u128> {
    let now = world.now;
    let mut allowed = vec![0u128; TRADERS.len()];
    match *action {
        Action::Advance(secs) => world.now += secs,
        Action::NextPhase(extra) => {
            let schedule = params().schedule();
            let next = SERIES
                .iter()
                .filter_map(|&series| {
                    let open = schedule.auction_open(series);
                    let round = now.saturating_sub(open) / schedule.round_secs();
                    [
                        schedule.reveal_start(series, round),
                        schedule.round_end(series, round),
                        open,
                    ]
                    .into_iter()
                    .filter(|&t| t > now)
                    .min()
                })
                .min()
                .unwrap_or(now);
            world.now = next + extra;
        }
        Action::Deposit(who, amount) => {
            let refund = call(now, USDC, 0, vec![], |w| {
                w.ft_on_transfer(id(TRADERS[who]), U128(amount), String::new())
            });
            world.held += amount - refund.expect("ft_on_transfer never panics for usdc").0;
        }
        Action::Withdraw(who, amount, fails) => {
            if call(now, TRADERS[who], 1, vec![], |w| w.withdraw(U128(amount))).is_some() {
                let result = if fails {
                    PromiseResult::Failed
                } else {
                    PromiseResult::Successful(vec![])
                };
                call(now, CONTRACT, 0, vec![result], |w| {
                    w.on_withdraw(id(TRADERS[who]), U128(amount))
                })
                .expect("the callback never panics");
                if !fails {
                    world.held -= amount;
                    allowed[who] = amount;
                }
            }
        }
        Action::PrintAll(price) => {
            let bucket = now - now % 10;
            for r in REPORTERS {
                call(now, r, 0, vec![], |w| {
                    w.report(bucket, price, BUNDLE.into())
                });
            }
        }
        Action::Report(r, price) => {
            let bucket = now - now % 10;
            call(now, REPORTERS[r], 0, vec![], |w| {
                w.report(bucket, price, BUNDLE.into())
            });
        }
        Action::Commit {
            who,
            series,
            long,
            size,
            ticks,
            lock,
        } => {
            let schedule = params().schedule();
            let round = now.saturating_sub(schedule.auction_open(series)) / schedule.round_secs();
            let side = if long { Side::Long } else { Side::Short };
            // LONGs bid a little higher than SHORTs ask, so most books cross.
            let price = if long {
                ticks + 20
            } else {
                ticks.saturating_sub(20).max(1)
            } * 1_000;
            let account = TRADERS[who];
            // No band is wider than 420_000 with these prices and params.
            let lock = lock.unwrap_or(u128::from(size) * 420_000);
            let hash =
                view(|w| w.commit_hash(series, round, id(account), side, size, price, SALT.into()));
            if let Some(seq) = call(now, account, 0, vec![], |w| {
                w.commit(series, hash, U128(lock))
            }) {
                world.rounds.insert((series, round));
                world.commits.push(Committed {
                    series,
                    round,
                    seq,
                    who,
                    side,
                    size,
                    price,
                });
            }
        }
        Action::Reveal(pick) => {
            // Mostly a commit whose reveal phase is now, so that rounds trade.
            let schedule = params().schedule();
            let open: Vec<Committed> = world
                .commits
                .iter()
                .filter(|c| {
                    schedule.reveal_start(c.series, c.round) <= now
                        && now < schedule.round_end(c.series, c.round)
                })
                .copied()
                .collect();
            let pool = if open.is_empty() || pick % 8 == 0 {
                &world.commits
            } else {
                &open
            };
            if !pool.is_empty() {
                let c = pool[pick % pool.len()];
                call(now, TRADERS[c.who], 0, vec![], |w| {
                    w.reveal(
                        c.series,
                        c.round,
                        c.seq,
                        c.side,
                        c.size,
                        c.price,
                        SALT.into(),
                    )
                });
            }
        }
        Action::Clear(pick) => {
            if !world.rounds.is_empty() {
                let &(series, round) = world.rounds.iter().nth(pick % world.rounds.len()).unwrap();
                let locks = locks_in(series, round);
                if call(now, "anyone.near", 0, vec![], |w| w.clear(series, round)).is_some() {
                    allowed = locks;
                }
            }
        }
        Action::Mint(who, series, sets) => {
            let band = view(|w| w.get_series(series)).map(|s| s.band);
            if call(now, TRADERS[who], 0, vec![], |w| w.mint(series, sets)).is_some() {
                let band = band
                    .or_else(|| view(|w| w.get_series(series)).map(|s| s.band))
                    .unwrap();
                allowed[who] = u128::from(sets) * u128::from(band);
            }
        }
        Action::Merge(who, series, sets) => {
            call(now, TRADERS[who], 0, vec![], |w| w.merge(series, sets));
        }
        Action::Transfer(from, to, series, long, short) => {
            call(now, TRADERS[from], 1, vec![], |w| {
                w.transfer_position(series, id(TRADERS[to]), long, short)
            });
        }
        Action::Settle(series) => {
            call(now, "anyone.near", 0, vec![], |w| w.settle(series));
        }
        Action::Redeem(by, of, series) => {
            call(now, TRADERS[by], 0, vec![], |w| {
                w.redeem(series, Some(id(TRADERS[of])))
            });
        }
        Action::Guard(who, guard, limit) => {
            call(now, TRADERS[who], 1, vec![], |w| {
                w.set_guard(guard, limit.map(U128))
            });
        }
        Action::Finalize(pick) => {
            let pending = view(|w| w.get_pending_prints());
            if !pending.is_empty() {
                let bucket = pending[pick % pending.len()];
                call(now, "anyone.near", 0, vec![], |w| w.finalize_print(bucket));
            }
        }
    }
    allowed
}

/// Invariants 1 and 2, with every total recomputed from views.
fn check_books(world: &World) -> Result<(), TestCaseError> {
    let totals = view(|w| w.get_totals());
    let free: u128 = TRADERS
        .iter()
        .map(|t| view(|w| w.get_account(id(t))).map_or(0, |a| a.balance.0))
        .sum();
    let mut locked = 0u128;
    let mut burned = 0u128;
    for &(series, round) in &world.rounds {
        for c in view(|w| w.get_round(series, round))
            .map(|r| r.commits)
            .unwrap_or_default()
        {
            locked += held_by(&c);
        }
        if let Some(r) = view(|w| w.get_result(series, round)) {
            burned += r.forfeited.0 + r.fees.0;
        }
    }
    let mut backing = 0u128;
    let mut unredeemed = 0u128;
    for series in SERIES {
        let Some(s) = view(|w| w.get_series(series)) else {
            continue;
        };
        let (long, short) = TRADERS.iter().fold((0u64, 0u64), |(l, sh), t| {
            let p = view(|w| w.get_position(series, id(t)));
            (l + p.long, sh + p.short)
        });
        prop_assert!(u128::from(s.open_sets) <= weir::MAX_UNITS);
        match &s.settlement {
            None => {
                // Invariant 2.
                prop_assert_eq!(long, s.open_sets, "series {} LONG", series);
                prop_assert_eq!(short, s.open_sets, "series {} SHORT", series);
                backing += u128::from(s.open_sets) * u128::from(s.band);
            }
            Some(st) => {
                for t in TRADERS {
                    let p = view(|w| w.get_position(series, id(t)));
                    unredeemed += u128::from(p.long) * u128::from(st.long_payout)
                        + u128::from(p.short) * u128::from(st.short_payout);
                }
            }
        }
    }
    prop_assert_eq!(totals.free.0, free);
    prop_assert_eq!(totals.locked.0, locked);
    prop_assert_eq!(totals.sets_backing.0, backing);
    prop_assert_eq!(totals.unredeemed.0, unredeemed);
    prop_assert_eq!(totals.burned.0, burned);
    // Invariant 1, an equality: withdrawals resolve within the step, so nothing is in
    // flight.
    prop_assert_eq!(world.held, free + locked + backing + unredeemed + burned);
    Ok(())
}

/// Invariant 7: whatever happened, once time has passed every round that holds
/// commits can be cleared and every opened series settled, and then every unit
/// redeemed. Afterwards only free balances and burned dollars remain.
fn finish(world: &mut World) -> Result<(), TestCaseError> {
    world.now = world.now.max(T0 + 2 * 600 + 100 + 1);
    let now = world.now;
    for &(series, round) in &world.rounds.clone() {
        if view(|w| w.get_round(series, round)).is_some() {
            let cleared = call(now, "anyone.near", 0, vec![], |w| w.clear(series, round));
            prop_assert!(
                cleared.is_some(),
                "round {}/{} cannot be cleared",
                series,
                round
            );
        }
    }
    for series in SERIES {
        let Some(s) = view(|w| w.get_series(series)) else {
            continue;
        };
        if s.settlement.is_none() {
            let settled = call(now, "anyone.near", 0, vec![], |w| w.settle(series));
            prop_assert!(settled.is_some(), "series {} cannot be settled", series);
        }
        for t in TRADERS {
            if view(|w| w.get_position(series, id(t))) != Position::default() {
                prop_assert!(call(now, "anyone.near", 0, vec![], |w| w
                    .redeem(series, Some(id(t))))
                .is_some());
            }
        }
    }
    check_books(world)?;
    let totals = view(|w| w.get_totals());
    prop_assert_eq!(
        (totals.locked.0, totals.sets_backing.0, totals.unredeemed.0),
        (0, 0, 0)
    );
    Ok(())
}

fn setup() -> World {
    // Most random calls are refused on purpose; their panic messages are noise.
    std::panic::set_hook(Box::new(|_| {}));
    install("deployer.near", T0 - 670, 0, vec![], HashMap::new());
    env::state_write(&Weir::new(params()));
    let now = T0 - 670;
    for t in TRADERS {
        call(now, t, REGISTRATION_FEE.as_yoctonear(), vec![], |w| {
            w.register(None)
        })
        .unwrap();
    }
    World {
        now,
        ..World::default()
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(96))]

    #[test]
    fn random_calls_keep_the_books_whole(actions in prop::collection::vec(action(), 1..=300)) {
        let mut world = setup();
        for action in &actions {
            let dollars_before = dollars(&world);
            let positions_before = positions();
            let totals_before = view(|w| w.get_totals());
            let allowed = apply(&mut world, action);
            check_books(&world)?;

            // Invariant 5: a trader's dollars fall only by what it withdrew or paid to
            // mint, or by at most what it locked in a round being cleared.
            let dollars_after = dollars(&world);
            for i in 0..TRADERS.len() {
                prop_assert!(
                    dollars_after[i] + allowed[i] >= dollars_before[i],
                    "{} lost {} on {:?}, allowed {}", TRADERS[i], dollars_before[i] - dollars_after[i], action, allowed[i]
                );
            }
            // Invariant 6: forfeits and fees are never credited to any account. Burned
            // only grows; at a clear, what the accounts own (free balances, locks, set
            // backing and unredeemed payouts) falls by exactly what was burned, and no
            // single account's dollars rise.
            let totals_after = view(|w| w.get_totals());
            prop_assert!(totals_after.burned.0 >= totals_before.burned.0, "burned fell on {:?}", action);
            if matches!(action, Action::Clear(_)) {
                let owned = |t: &weir::types::TotalsView| t.free.0 + t.locked.0 + t.sets_backing.0 + t.unredeemed.0;
                let burned = totals_after.burned.0 - totals_before.burned.0;
                prop_assert_eq!(owned(&totals_before) - owned(&totals_after), burned);
                for i in 0..TRADERS.len() {
                    prop_assert!(dollars_after[i] <= dollars_before[i], "{} gained on a clear", TRADERS[i]);
                }
            }
            // And nobody's units fall except by its own merge or transfer, or a redeem.
            let positions_after = positions();
            for (&(series, i), before) in &positions_before {
                let after = positions_after[&(series, i)];
                let own_move = match *action {
                    Action::Merge(w, s, _) | Action::Transfer(w, _, s, _, _) | Action::Redeem(_, w, s) => w == i && s == series,
                    _ => false,
                };
                if !own_move {
                    prop_assert!(after.long >= before.long && after.short >= before.short, "{:?} took units of {}", action, TRADERS[i]);
                }
            }
        }
        finish(&mut world)?;
    }
}

/// The walks above are only worth something if they reach the interesting states.
/// This runs a fixed-seed batch of them and counts what happened.
#[test]
fn random_walks_reach_every_stage() {
    use proptest::strategy::ValueTree;
    use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};
    let config = Config {
        cases: 64,
        ..Config::default()
    };
    let rng = TestRng::from_seed(RngAlgorithm::ChaCha, &[7; 32]);
    let mut runner = TestRunner::new_with_rng(config, rng);
    let strategy = prop::collection::vec(action(), 300);
    SEEN.with(|seen| seen.borrow_mut().clear());
    for _ in 0..64 {
        let actions = strategy.new_tree(&mut runner).unwrap().current();
        let mut world = setup();
        for action in &actions {
            apply(&mut world, action);
        }
        check_books(&world).unwrap();
        finish(&mut world).unwrap();
    }
    let seen = SEEN.with(|seen| seen.borrow().clone());
    println!("{seen:#?}");
    for stage in [
        "series_opened",
        "commit",
        "evict",
        "reveal",
        "void reveal",
        "clear",
        "clear with a trade",
        "mint",
        "merge",
        "transfer_position",
        "print",
        "no_print",
        "settle",
        "void settle",
        "redeem",
        "withdraw",
        "withdraw_failed",
        "guard",
    ] {
        assert!(
            seen.get(stage).copied().unwrap_or(0) > 0,
            "no {stage} in {seen:#?}"
        );
    }
}
