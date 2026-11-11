//! Test vectors for the TypeScript engine, generated from the contract's own pure
//! modules with a seeded PRNG, so they are the same on every machine.
//!
//! `WEIR_WRITE_VECTORS=1 cargo test --test vectors` writes them to `vectors/` at the
//! repository root. Without it, each test asserts the committed file is byte for byte
//! what the code produces today, so the files cannot go stale.

use std::path::PathBuf;

use near_sdk::serde_json::{json, Value};
use sha2::{Digest, Sha256};
use weir::clearing::{self, Order};
use weir::index;
use weir::settlement::{self, SettleInput};
use weir::time::{Phase, Schedule};
use weir::types::Side;

/// SplitMix64: small, fast and fully specified.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// Uniform in `lo..=hi`, near enough for test data.
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo + 1)
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }

    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.next() as usize % items.len()]
    }

    fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            items.swap(i, self.next() as usize % (i + 1));
        }
    }

    fn hex(&mut self, len: usize) -> String {
        (0..len).map(|_| char::from_digit((self.next() % 16) as u32, 16).unwrap()).collect()
    }
}

/// `{ "<header>": .., "cases": [ one case per line ] }`, with keys in the order given.
fn render(header: &[(&str, Value)], cases: &[Value]) -> String {
    let mut out = String::from("{\n");
    for (key, value) in header {
        out += &format!("  \"{key}\": {value},\n");
    }
    out += "  \"cases\": [\n";
    let lines: Vec<String> = cases.iter().map(|c| format!("    {c}")).collect();
    out += &lines.join(",\n");
    out += "\n  ]\n}\n";
    out
}

fn vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors")
}

fn write_or_check(file: &str, content: String) {
    let path = vectors_dir().join(file);
    if std::env::var("WEIR_WRITE_VECTORS").as_deref() == Ok("1") {
        std::fs::create_dir_all(vectors_dir()).unwrap();
        std::fs::write(&path, content).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("{} is missing: run WEIR_WRITE_VECTORS=1 cargo test --test vectors", path.display()));
    assert!(
        committed == content,
        "{} is stale: run WEIR_WRITE_VECTORS=1 cargo test --test vectors",
        path.display()
    );
}

fn side_name(side: Side) -> &'static str {
    match side {
        Side::Long => "Long",
        Side::Short => "Short",
    }
}

// ---- clearing.json ----

const TICK: u64 = 1_000;

fn l(seq: u32, size: u64, ticks: u64) -> Order {
    Order { seq, side: Side::Long, size, price: ticks * TICK }
}

fn s(seq: u32, size: u64, ticks: u64) -> Order {
    Order { seq, side: Side::Short, size, price: ticks * TICK }
}

fn clearing_case(name: &str, orders: &[Order]) -> Value {
    let c = clearing::clear(orders, TICK);
    json!({
        "name": name,
        "orders": orders.iter().map(|o| json!({
            "seq": o.seq, "side": side_name(o.side), "size": o.size, "price": o.price,
        })).collect::<Vec<_>>(),
        "expect": { "price": c.price, "volume": c.volume, "fills": c.fills },
    })
}

fn named_clearing_cases() -> Vec<(&'static str, Vec<Order>)> {
    vec![
        ("empty book", vec![]),
        ("one LONG only", vec![l(0, 5, 10)]),
        ("one SHORT only", vec![s(0, 5, 10)]),
        ("LONGs only", vec![l(0, 5, 10), l(1, 3, 12), l(2, 1, 1)]),
        ("SHORTs only", vec![s(0, 5, 10), s(1, 3, 12), s(2, 1, 1)]),
        ("SHORT limit one tick above LONG limit: no trade", vec![l(0, 5, 10), s(1, 5, 11)]),
        ("SHORT limit far above LONG limit: no trade", vec![l(0, 5, 2), s(1, 5, 30)]),
        ("cross at one price, equal sizes", vec![l(0, 5, 10), s(1, 5, 10)]),
        ("cross at one price, LONG larger", vec![l(0, 8, 10), s(1, 5, 10)]),
        ("cross at one price, SHORT larger", vec![l(0, 5, 10), s(1, 8, 10)]),
        ("step 3: excess demand at every candidate takes hi", vec![l(0, 10, 12), s(1, 3, 8)]),
        ("step 3: excess supply at every candidate takes lo", vec![s(0, 10, 5), l(1, 3, 9)]),
        ("step 3: balanced at both ends takes the midpoint", vec![l(0, 5, 10), s(1, 5, 8)]),
        ("step 3: midpoint 8.5 ticks rounds down to 8", vec![l(0, 5, 10), s(1, 5, 7)]),
        ("step 3: midpoint of adjacent ticks rounds down to lo", vec![l(0, 5, 10), s(1, 5, 9)]),
        ("step 3: midpoint between candidates of different sizes", vec![l(0, 4, 10), l(1, 4, 12), s(2, 5, 9), s(3, 3, 12)]),
        ("step 2: least imbalance keeps one candidate", vec![l(0, 10, 12), s(1, 3, 8), l(2, 10, 9)]),
        ("step 1: largest volume wins over balance", vec![l(0, 10, 10), s(1, 10, 6), l(2, 1, 4), s(3, 1, 4)]),
        ("partial LONG fill goes to the lower seq", vec![l(3, 4, 10), l(1, 4, 10), s(2, 5, 10)]),
        ("partial SHORT fill goes to the lower seq", vec![s(7, 4, 10), s(2, 4, 10), l(5, 5, 10)]),
        ("higher LONG price fills first", vec![l(0, 4, 10), l(1, 4, 12), s(2, 5, 9), s(3, 5, 8)]),
        ("lower SHORT price fills first", vec![s(0, 4, 10), s(1, 4, 6), l(2, 5, 12)]),
        ("price priority beats seq", vec![l(0, 3, 10), l(9, 3, 11), s(5, 4, 10)]),
        ("equal prices on both sides, many orders", vec![l(0, 2, 10), l(1, 3, 10), l(2, 4, 10), s(3, 1, 10), s(4, 5, 10), s(5, 2, 10)]),
        ("seq order differs from array order", vec![s(4, 3, 9), l(3, 2, 11), s(0, 3, 9), l(1, 2, 11), l(2, 2, 11)]),
        ("one large SHORT against many small LONGs", vec![l(0, 1, 15), l(1, 1, 14), l(2, 1, 13), l(3, 1, 12), s(4, 100, 10)]),
        ("one large LONG against many small SHORTs", vec![s(0, 1, 5), s(1, 1, 6), s(2, 1, 7), s(3, 1, 8), l(4, 100, 10)]),
        ("crossing over several levels", vec![l(0, 5, 14), l(1, 5, 12), l(2, 5, 10), s(3, 5, 9), s(4, 5, 11), s(5, 5, 13)]),
        ("minimum price of one tick", vec![l(0, 3, 1), s(1, 3, 1)]),
        ("wide cross: one tick SHORT, twenty tick LONG", vec![l(0, 7, 20), s(1, 7, 1)]),
        ("orders outside the cross take no part", vec![l(0, 5, 12), s(1, 5, 6), l(2, 1, 3), s(3, 1, 15)]),
        ("single unit each side", vec![l(0, 1, 10), s(1, 1, 10)]),
        ("LONG and SHORT from the same seq range interleaved", vec![l(0, 3, 9), s(1, 3, 9), l(2, 3, 9), s(3, 3, 9)]),
        ("unfilled orders behind the clearing price", vec![l(0, 5, 10), l(1, 5, 4), s(2, 5, 10), s(3, 5, 16)]),
    ]
}

#[test]
fn clearing_vectors() {
    let mut cases: Vec<Value> = named_clearing_cases()
        .iter()
        .map(|(name, orders)| clearing_case(name, orders))
        .collect();
    let mut rng = Rng(0x00c1_ea41_0001);
    for i in 0..3_000 {
        let n = rng.range(0, 40) as usize;
        // Vary how crowded the price range is, so ties and partial fills are common.
        let top = rng.pick(&[3u64, 8, 20, 60]);
        let big = rng.pick(&[3u64, 20, 500]);
        let mut seqs: Vec<u32> = (0..n as u32).collect();
        rng.shuffle(&mut seqs);
        let orders: Vec<Order> = seqs
            .into_iter()
            .map(|seq| Order {
                seq,
                side: if rng.chance(50) { Side::Long } else { Side::Short },
                size: rng.range(1, big),
                price: rng.range(1, top) * TICK,
            })
            .collect();
        cases.push(clearing_case(&format!("random {i}"), &orders));
    }
    write_or_check("clearing.json", render(&[("tick", json!(TICK))], &cases));
}

// ---- hash.json ----

#[test]
fn hash_vectors() {
    let accounts = [
        "alice.near",
        "bob.testnet",
        "a-b_c.d.near",
        "x.y.z.weir.testnet",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "aa",
    ];
    let mut rng = Rng(0x00ba_5401);
    let cases: Vec<Value> = (0..50)
        .map(|i| {
            let series = if i < 5 { i } else { rng.range(0, 5_000) as u32 };
            let round = if i < 5 { 0 } else { rng.range(0, 3_000) };
            let account = accounts[i as usize % accounts.len()];
            let side = if rng.chance(50) { Side::Long } else { Side::Short };
            let size = rng.range(1, 100_000);
            let price = rng.range(1, 2_000) * TICK;
            let salt_len = rng.range(32, 64) as usize;
            let salt = rng.hex(salt_len);
            let hash = hex::encode(weir::hash::commit_hash(series, round, account, side, size, price, &salt));
            // Checked against an independent sha256 of the spec's string.
            let letter = if side == Side::Long { "L" } else { "S" };
            let preimage = format!("weir:v1|{series}|{round}|{account}|{letter}|{size}|{price}|{salt}");
            assert_eq!(hash, hex::encode(Sha256::digest(preimage.as_bytes())));
            json!({
                "series": series, "round": round, "account_id": account, "side": side_name(side),
                "size": size, "price": price, "salt": salt, "hash": hash,
            })
        })
        .collect();
    write_or_check("hash.json", render(&[], &cases));
}

// ---- band.json ----

#[test]
fn band_vectors() {
    let mut rng = Rng(0x00ba_4d01);
    let mut inputs: Vec<(u64, u64, u32)> = vec![
        // half < tick: 9_999 * 10% = 999 rounds to 0.
        (9_999, 1_000, 1_000),
        // The smallest anchor that works at 10% and a 1_000 tick.
        (10_000, 1_000, 1_000),
        // half < tick at the widest band: 1 bps of a small anchor.
        (2_000_000, 1_000, 1),
        // The widest band: half equals mid, so floor is 0. `half > mid` cannot happen.
        (3_999, 1_000, 9_999),
        (11_999, 4_000, 9_999),
        // tick 1: no rounding.
        (2_034_567, 1, 1_234),
        // An anchor below one tick.
        (999, 1_000, 5_000),
        // A large anchor whose band (about twice the anchor) still fits a JavaScript
        // number, 2^53 - 1.
        (4_503_599_627_370_495, 1_000, 9_999),
    ];
    while inputs.len() < 200 {
        let tick = rng.pick(&[1u64, 10, 100, 1_000, 5_000, 10_000]);
        let anchor = match rng.range(0, 3) {
            0 => rng.range(1, 50_000),
            1 => rng.range(500_000, 10_000_000),
            2 => rng.range(1, 1_000_000_000_000),
            _ => rng.range(1_000, 5_000_000),
        };
        let band_bps = match rng.range(0, 2) {
            0 => rng.range(1, 9_999),
            1 => rng.pick(&[1u64, 100, 500, 1_000, 2_500, 9_999]),
            _ => rng.range(1, 200),
        } as u32;
        inputs.push((anchor, tick, band_bps));
    }
    let cases: Vec<Value> = inputs
        .into_iter()
        .map(|(anchor, tick, band_bps)| {
            let expect = match settlement::band(anchor, tick, band_bps) {
                Ok(b) => json!({ "mid": b.mid, "half": b.half, "floor": b.floor, "band": b.band }),
                Err(_) => json!({ "error": true }),
            };
            json!({ "anchor": anchor, "tick": tick, "band_bps": band_bps, "expect": expect })
        })
        .collect();
    assert!(cases.iter().filter(|c| c["expect"]["error"] == true).count() >= 10);
    let safe = 9_007_199_254_740_991u64;
    assert!(cases.iter().all(|c| c["expect"]["band"].as_u64().unwrap_or(0) <= safe));
    write_or_check("band.json", render(&[], &cases));
}

// ---- print.json ----

/// Reports, quorum, reporters, max_spread_bps, window closed.
type PrintInput = (Vec<u64>, u32, u32, u32, bool);

#[test]
fn print_vectors() {
    let mut rng = Rng(0x0091_4702);
    let mut inputs: Vec<PrintInput> = vec![
        // Every reporter: the median, however wild one report is.
        (vec![2_000_000, 2_000_000, 400_000_000], 2, 3, 100, false),
        // Two of three, window open: undecided.
        (vec![2_000_000, 2_020_000], 2, 3, 100, false),
        // Two of three, window closed: exactly at the spread is a print; one more is not.
        (vec![2_000_000, 2_020_000], 2, 3, 100, true),
        (vec![2_000_000, 2_020_001], 2, 3, 100, true),
        // Below quorum.
        (vec![2_000_000], 2, 3, 100, true),
        // Even count rounds the mean of the middle two down.
        (vec![1, 2], 2, 2, 10_000, false),
        (vec![4, 1, 3, 2], 4, 9, 10_000, true),
        // The widest spread allowed.
        (vec![1, 2], 1, 3, 10_000, true),
        (vec![1, 3], 1, 3, 10_000, true),
    ];
    while inputs.len() < 500 {
        let reporters = rng.range(1, 9) as u32;
        let quorum = rng.range(1, u64::from(reporters)) as u32;
        let n = rng.range(1, u64::from(reporters)) as usize;
        let center = rng.pick(&[1_000u64, 2_000_000, 2_500_000, 40_000_000]);
        let spread = center / rng.pick(&[1u64, 20, 200, 2_000, 20_000]);
        let reports: Vec<u64> = (0..n)
            .map(|_| rng.range(center.saturating_sub(spread).max(1), center + spread))
            .collect();
        let max_spread_bps = rng.pick(&[1u32, 10, 50, 100, 500, 10_000]);
        inputs.push((reports, quorum, reporters, max_spread_bps, rng.chance(60)));
    }
    let cases: Vec<Value> = inputs
        .into_iter()
        .map(|(reports, quorum, reporters, max_spread_bps, window_closed)| {
            let (state, price) = index::state(&reports, quorum, reporters, max_spread_bps, window_closed);
            json!({
                "reports": reports, "quorum": quorum, "reporters": reporters,
                "max_spread_bps": max_spread_bps, "window_closed": window_closed,
                "expect": { "state": state, "price": price },
            })
        })
        .collect();
    for state in ["Open", "Final", "NoPrint"] {
        assert!(cases.iter().filter(|c| c["expect"]["state"] == state).count() >= 50, "{state}");
    }
    write_or_check("print.json", render(&[], &cases));
}

// ---- settlement.json ----

#[test]
fn settlement_vectors() {
    let mut rng = Rng(0x0053_7702);
    let base = SettleInput {
        floor: 1_800_000,
        band: 400_000,
        sum: 0,
        count: 0,
        void_allowed: false,
        min_prints: 3,
    };
    // `traded_units` and `traded_value` stay in the shape for readers; no rule reads
    // them, so these cases show that trades never move a void payout.
    let traded = (20u64, 5 * 210_000 + 15 * 250_000u128);
    let none = (0u64, 0u128);
    let mut inputs: Vec<(SettleInput, (u64, u128))> = vec![
        // At min_prints, and one short of it, with and without the void window.
        (SettleInput { sum: 6_000_000, count: 3, ..base }, none),
        (SettleInput { sum: 4_000_000, count: 2, ..base }, none),
        (SettleInput { sum: 4_100_001, count: 2, void_allowed: true, ..base }, none),
        (SettleInput { void_allowed: true, ..base }, none),
        // Fixing below the floor, at it, and above the cap.
        (SettleInput { sum: 3_000_000, count: 3, ..base }, none),
        (SettleInput { sum: 5_400_000, count: 3, ..base }, none),
        (SettleInput { sum: 9_000_000, count: 3, ..base }, none),
        // The fixing rounds down.
        (SettleInput { sum: 6_100_001, count: 3, ..base }, none),
        // Void after trading: the centre of the band, whatever was traded or printed.
        (SettleInput { sum: 4_100_001, count: 2, void_allowed: true, ..base }, traded),
        (SettleInput { void_allowed: true, ..base }, traded),
        // Wash trades one tick below the band change nothing either.
        (SettleInput { void_allowed: true, ..base }, (10_000, 10_000 * 399_000)),
        // Not yet void, and enough prints: trades are ignored.
        (SettleInput { sum: 4_100_001, count: 2, ..base }, traded),
        (SettleInput { sum: 6_000_000, count: 3, void_allowed: true, ..base }, traded),
    ];
    while inputs.len() < 500 {
        let half = rng.range(1, 5_000) * rng.pick(&[1u64, 10, 1_000]);
        let floor = rng.range(0, 10_000_000);
        let count = match rng.range(0, 3) {
            0 => 0,
            1 => rng.range(1, 5),
            _ => rng.range(1, 2_100),
        } as u32;
        let around = floor + half;
        let sum: u128 = (0..count)
            .map(|_| u128::from(rng.range(around.saturating_sub(3 * half).max(1), around + 3 * half)))
            .sum();
        let traded_units = if rng.chance(30) { 0 } else { rng.range(1, 1_000_000) };
        // Every round's price is below band, so the average is too.
        let traded_value = if traded_units == 0 {
            0
        } else {
            u128::from(traded_units) * u128::from(rng.range(1, 2 * half - 1)) + u128::from(rng.range(0, traded_units - 1))
        };
        let input = SettleInput {
            floor,
            band: 2 * half,
            sum,
            count,
            void_allowed: rng.chance(40),
            min_prints: rng.range(1, 2_016) as u32,
        };
        inputs.push((input, (traded_units, traded_value)));
    }
    let cases: Vec<Value> = inputs
        .into_iter()
        .map(|(i, (traded_units, traded_value))| {
            let expect = match settlement::settle(i) {
                Ok(s) => json!({
                    "fixing": s.fixing, "long_payout": s.long_payout,
                    "short_payout": s.short_payout, "void": s.void,
                }),
                Err(err) => json!({ "error": err }),
            };
            json!({
                "floor": i.floor, "band": i.band, "sum": i.sum.to_string(), "count": i.count,
                "traded_units": traded_units, "traded_value": traded_value.to_string(),
                "void_allowed": i.void_allowed, "min_prints": i.min_prints, "expect": expect,
            })
        })
        .collect();
    assert!(cases.iter().any(|c| c["expect"]["error"] == "not enough prints yet"));
    assert!(cases
        .iter()
        .filter(|c| c["expect"]["void"] == true)
        .all(|c| c["expect"]["long_payout"].as_u64().unwrap() * 2 == c["band"].as_u64().unwrap()));
    write_or_check("settlement.json", render(&[], &cases));
}

// ---- time.json ----

#[test]
fn time_vectors() {
    // 2026-01-01 UTC, hourly series. Each auction opens 65 minutes before its delivery
    // and closes 5 minutes before it, so lead = period + cutoff and the windows of
    // consecutive series meet. 3_600 / 420 leaves a closed tail of 240 seconds.
    let schedule = Schedule {
        t0: 1_767_225_600,
        period_secs: 3_600,
        lead_secs: 3_900,
        cutoff_secs: 300,
        commit_secs: 300,
        reveal_secs: 120,
    };
    let rounds = (schedule.auction_close(0) - schedule.auction_open(0)) / schedule.round_secs();
    let mut rng = Rng(0x0071_3e01);
    let mut inputs: Vec<(u32, u64)> = Vec::new();
    for series in [0u32, 1, 7] {
        let open = schedule.auction_open(series);
        let close = schedule.auction_close(series);
        let last = rounds - 1;
        for now in [
            open - 1,
            open,
            schedule.reveal_start(series, 0) - 1,
            schedule.reveal_start(series, 0),
            schedule.round_end(series, 0) - 1,
            schedule.round_end(series, 0),
            schedule.round_end(series, last) - 1,
            schedule.round_end(series, last),
            close - 1,
            close,
            schedule.delivery_start(series),
            schedule.delivery_end(series),
        ] {
            inputs.push((series, now));
        }
    }
    while inputs.len() < 300 {
        let series = rng.range(0, 60) as u32;
        let round = rng.range(0, rounds + 2);
        let start = schedule.auction_open(series) + round * schedule.round_secs();
        let now = match rng.range(0, 5) {
            0 => start - 1,
            1 => start,
            2 => start + schedule.commit_secs - 1,
            3 => start + schedule.commit_secs,
            4 => start + schedule.round_secs() - 1,
            _ => start + rng.range(0, schedule.round_secs() - 1),
        };
        inputs.push((series, now));
    }
    let cases: Vec<Value> = inputs
        .into_iter()
        .map(|(series, now)| {
            let (round, phase) = schedule.current(series, now);
            let phase = match phase {
                Phase::Commit => "Commit",
                Phase::Reveal => "Reveal",
                Phase::Closed => "Closed",
            };
            json!({ "series": series, "now": now, "expect": { "round": round, "phase": phase } })
        })
        .collect();
    assert!(cases.iter().filter(|c| c["expect"]["phase"] == "Closed").count() >= 20);
    let params = json!({
        "t0": schedule.t0, "period_secs": schedule.period_secs, "lead_secs": schedule.lead_secs,
        "cutoff_secs": schedule.cutoff_secs, "commit_secs": schedule.commit_secs,
        "reveal_secs": schedule.reveal_secs,
    });
    write_or_check("time.json", render(&[("params", params)], &cases));
}
