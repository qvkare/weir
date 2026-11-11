//! Integration tests: the real wasm of both contracts in near-sandbox.
//!
//! Build first with `contracts/build.sh`. A wasm older than its source is refused, so
//! these tests cannot pass against code that is not the code in the tree.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{AccessKey, Account, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const DOLLAR: u128 = 1_000_000;
/// The commit fee of every deployment here: 0.001 $.
const FEE: u128 = 1_000;
const PRICE: u64 = 2_000_000;
const BAND: u64 = 400_000;
const SALT: &str = "5a175a175a175a175a175a175a175a17";
const BUNDLE: &str = "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b";
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const REGISTRATION: NearToken = NearToken::from_millinear(20);
const CALL_GAS: Gas = Gas::from_tgas(100);

fn wasm(crate_dir: &str, file: &str) -> Vec<u8> {
    let contracts = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let path = contracts.join("target/near").join(file);
    let built = std::fs::metadata(&path)
        .and_then(|meta| meta.modified())
        .unwrap_or_else(|_| panic!("{} is missing: run contracts/build.sh", path.display()));
    let newest_source = newest_file(&contracts.join(crate_dir).join("src"));
    assert!(
        built >= newest_source,
        "{} is older than its source: run contracts/build.sh",
        path.display()
    );
    std::fs::read(path).unwrap()
}

fn newest_file(dir: &PathBuf) -> SystemTime {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().metadata().unwrap().modified().unwrap())
        .max()
        .unwrap()
}

/// The parameters of a deployment, as the tests need them for timing.
#[derive(Clone, Copy)]
struct Timing {
    t0: u64,
    period: u64,
    lead: u64,
    cutoff: u64,
    commit: u64,
    reveal: u64,
    interval: u64,
    grace: u64,
}

impl Timing {
    fn open(&self) -> u64 {
        self.t0 - self.lead
    }
    fn round_secs(&self) -> u64 {
        self.commit + self.reveal
    }
    fn round_start(&self, round: u64) -> u64 {
        self.open() + round * self.round_secs()
    }
    fn reveal_start(&self, round: u64) -> u64 {
        self.round_start(round) + self.commit
    }
    fn round_end(&self, round: u64) -> u64 {
        self.round_start(round) + self.round_secs()
    }
    /// The same schedule seen from series `s`: every time moves by `s` periods.
    fn shifted(&self, s: u64) -> Timing {
        Timing { t0: self.t0 + s * self.period, ..*self }
    }
    fn end(&self) -> u64 {
        self.t0 + self.period
    }
}

struct Chain {
    worker: Worker<Sandbox>,
    usdc: Contract,
    reporters: Vec<Account>,
    /// Seconds a fast-forwarded block moves the clock, as last measured.
    secs_per_block: std::sync::Mutex<f64>,
}

impl Chain {
    async fn start() -> anyhow::Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let usdc = worker.dev_deploy(&wasm("mock-usdc", "mock_usdc/mock_usdc.wasm")).await?;
        let mut reporters = Vec::new();
        for _ in 0..3 {
            reporters.push(worker.dev_create_account().await?);
        }
        Ok(Self {
            worker,
            usdc,
            reporters,
            secs_per_block: std::sync::Mutex::new(1.0),
        })
    }

    async fn now(&self) -> anyhow::Result<u64> {
        Ok(self.worker.view_block().await?.timestamp() / 1_000_000_000)
    }

    /// Moves the clock to at least `target`, overshooting by about a block at most.
    async fn warp_to(&self, target: u64) -> anyhow::Result<()> {
        loop {
            let now = self.now().await?;
            if now >= target {
                return Ok(());
            }
            let per_block = *self.secs_per_block.lock().unwrap();
            let blocks = (((target - now) as f64 * 0.8) / per_block).max(1.0) as u64;
            self.worker.fast_forward(blocks).await?;
            let moved = self.now().await?.saturating_sub(now);
            if blocks >= 20 && moved > 0 {
                *self.secs_per_block.lock().unwrap() = moved as f64 / blocks as f64;
            }
        }
    }

    /// A Weir deployment whose series 0 auction opens `open_in` seconds from now.
    async fn deploy_weir(&self, timing: impl Fn(u64) -> Timing, max_commits: u32) -> anyhow::Result<(Contract, Timing)> {
        let weir = self.worker.dev_deploy(&wasm("weir", "weir/weir.wasm")).await?;
        let t = timing(self.now().await?);
        let params = json!({
            "usdc": self.usdc.id(), "underlying": "H100-USD-HR", "t0": t.t0,
            "period_secs": t.period, "lead_secs": t.lead, "cutoff_secs": t.cutoff,
            "commit_secs": t.commit, "reveal_secs": t.reveal, "band_bps": 1_000, "tick": 1_000,
            "print_interval_secs": t.interval, "report_grace_secs": t.grace, "max_spread_bps": 100,
            "min_prints": 2, "void_after_secs": 3_600, "max_anchor_age_secs": 3_600,
            "forfeit_bps": 1_000, "min_lock": "1", "commit_fee": FEE.to_string(), "max_commits": max_commits,
            "max_order_size": 1_000,
            "reporters": self.reporters.iter().map(|r| r.id().clone()).collect::<Vec<_>>(),
            "quorum": 2,
        });
        weir.call("new").args_json(json!({ "params": params })).transact().await?.into_result()?;
        // The contract needs a storage record at the token to receive it.
        weir.as_account()
            .call(self.usdc.id(), "storage_deposit")
            .args_json(json!({}))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await?
            .into_result()?;
        Ok((weir, t))
    }

    async fn usdc_balance(&self, account: &near_workspaces::AccountId) -> anyhow::Result<u128> {
        let balance: Value = self.usdc.view("ft_balance_of").args_json(json!({ "account_id": account })).await?.json()?;
        Ok(balance.as_str().unwrap().parse()?)
    }

    /// A trader registered at `weir` with `deposit` dollars in it.
    async fn trader(&self, weir: &Contract, deposit: u128) -> anyhow::Result<Account> {
        let account = self.worker.dev_create_account().await?;
        fund(&account, &self.usdc, weir, deposit).await?;
        Ok(account)
    }

    /// Reporters report `price` for the bucket that contains now until it is final.
    async fn print(&self, weir: &Contract, t: &Timing, price: u64) -> anyhow::Result<u64> {
        let now = self.now().await?;
        let bucket = now - now % t.interval;
        for reporter in &self.reporters {
            let done: bool = reporter
                .call(weir.id(), "report")
                .args_json(json!({ "bucket": bucket, "price": price, "bundle": BUNDLE }))
                .transact()
                .await?
                .into_result()?
                .json()?;
            if done {
                return Ok(bucket);
            }
        }
        anyhow::bail!("bucket {bucket} did not become final")
    }
}

/// Registers `account` at `weir` and deposits `amount` freshly minted dollars there.
async fn fund(account: &Account, usdc: &Contract, weir: &Contract, amount: u128) -> anyhow::Result<()> {
    account.call(weir.id(), "register").args_json(json!({})).deposit(REGISTRATION).transact().await?.into_result()?;
    account
        .call(usdc.id(), "mint")
        .args_json(json!({ "account_id": account.id(), "amount": amount.to_string() }))
        .transact()
        .await?
        .into_result()?;
    account
        .call(usdc.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": weir.id(), "amount": amount.to_string(), "msg": "" }))
        .deposit(ONE_YOCTO)
        .gas(CALL_GAS)
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

fn side_letter(side: &str) -> &str {
    if side == "Long" { "L" } else { "S" }
}

/// The hash of spec section 6.2, computed here independently of the contract.
fn commit_hash(series: u32, round: u64, account: &str, side: &str, size: u64, price: u64) -> String {
    let preimage = format!("weir:v1|{series}|{round}|{account}|{}|{size}|{price}|{SALT}", side_letter(side));
    hex::encode(Sha256::digest(preimage.as_bytes()))
}

async fn commit(account: &Account, weir: &Contract, round: u64, side: &str, size: u64, price: u64, lock: u128) -> anyhow::Result<u32> {
    commit_in(0, account, weir, round, side, size, price, lock).await
}

#[allow(clippy::too_many_arguments)]
async fn commit_in(series: u32, account: &Account, weir: &Contract, round: u64, side: &str, size: u64, price: u64, lock: u128) -> anyhow::Result<u32> {
    let hash = commit_hash(series, round, account.id().as_str(), side, size, price);
    let seq = account
        .call(weir.id(), "commit")
        .args_json(json!({ "series": series, "hash": hash, "lock": lock.to_string() }))
        .transact()
        .await?
        .into_result()?
        .json()?;
    Ok(seq)
}

async fn reveal(account: &Account, weir: &Contract, round: u64, seq: u32, side: &str, size: u64, price: u64) -> anyhow::Result<ExecutionFinalResult> {
    reveal_in(0, account, weir, round, seq, side, size, price).await
}

#[allow(clippy::too_many_arguments)]
async fn reveal_in(series: u32, account: &Account, weir: &Contract, round: u64, seq: u32, side: &str, size: u64, price: u64) -> anyhow::Result<ExecutionFinalResult> {
    Ok(account
        .call(weir.id(), "reveal")
        .args_json(json!({ "series": series, "round": round, "seq": seq, "side": side, "size": size, "price": price, "salt": SALT }))
        .transact()
        .await?)
}

async fn view(weir: &Contract, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(weir.view(method).args_json(args).await?.json()?)
}

async fn free(weir: &Contract, account: &Account) -> anyhow::Result<u128> {
    let a = view(weir, "get_account", json!({ "account_id": account.id() })).await?;
    Ok(a["balance"].as_str().unwrap().parse()?)
}

async fn position(weir: &Contract, account: &Account) -> anyhow::Result<(u64, u64)> {
    let p = view(weir, "get_position", json!({ "series": 0, "account_id": account.id() })).await?;
    Ok((p["long"].as_u64().unwrap(), p["short"].as_u64().unwrap()))
}

/// Invariant 1 against the token's own ledger: the contract holds exactly what it owes.
async fn assert_books_balance(chain: &Chain, weir: &Contract) -> anyhow::Result<()> {
    let t = view(weir, "get_totals", json!({})).await?;
    let owed: u128 = ["free", "locked", "sets_backing", "unredeemed", "burned"]
        .iter()
        .map(|k| t[*k].as_str().unwrap().parse::<u128>().unwrap())
        .sum();
    assert_eq!(chain.usdc_balance(weir.id()).await?, owed, "totals {t}");
    Ok(())
}

fn event(outcome: &ExecutionFinalResult, name: &str) -> Value {
    outcome
        .logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|json| serde_json::from_str::<Value>(json).unwrap())
        .find(|e| e["event"] == name)
        .unwrap_or_else(|| panic!("no {name} event in {:?}", outcome.logs()))
}

/// The round whose commit phase has at least `margin` seconds left, warping to the
/// next round's start if the current one is too far along.
async fn a_fresh_commit_phase(chain: &Chain, t: &Timing, margin: u64) -> anyhow::Result<u64> {
    let now = chain.now().await?.max(t.open());
    let mut round = (now - t.open()) / t.round_secs();
    if now + margin > t.reveal_start(round) {
        round += 1;
    }
    chain.warp_to(t.round_start(round)).await?;
    Ok(round)
}

/// The first multiple of `interval` at or after `at`: t0 sits on the print grid.
fn on_grid(at: u64, interval: u64) -> u64 {
    at.div_ceil(interval) * interval
}

fn lifecycle_timing(now: u64) -> Timing {
    let lead = 1_260;
    Timing {
        t0: on_grid(now + lead + 60, 60),
        period: 1_200,
        lead,
        cutoff: 60,
        commit: 120,
        reveal: 120,
        interval: 60,
        grace: 120,
    }
}

#[tokio::test]
async fn a_whole_life_with_exact_balances() -> anyhow::Result<()> {
    let chain = Chain::start().await?;
    let (weir, t) = chain.deploy_weir(lifecycle_timing, 16).await?;
    let alice = chain.trader(&weir, 500 * DOLLAR).await?;
    let bob = chain.trader(&weir, 500 * DOLLAR).await?;
    let carol = chain.trader(&weir, 500 * DOLLAR).await?;
    for who in [&alice, &bob, &carol] {
        assert_eq!(free(&weir, who).await?, 500 * DOLLAR);
        assert_eq!(chain.usdc_balance(who.id()).await?, 0);
    }
    assert_eq!(chain.usdc_balance(weir.id()).await?, 1_500 * DOLLAR);
    assert_books_balance(&chain, &weir).await?;

    // The series opens on a fresh print.
    chain.warp_to(t.open()).await?;
    chain.print(&weir, &t, PRICE).await?;
    let round = a_fresh_commit_phase(&chain, &t, 60).await?;

    // Alice LONG 10 @ 0.21, Bob LONG 5 @ 0.20, Carol SHORT 8 @ 0.19, and a Carol
    // SHORT she never reveals.
    let a = commit(&alice, &weir, round, "Long", 10, 210_000, 3 * DOLLAR).await?;
    let b = commit(&bob, &weir, round, "Long", 5, 200_000, DOLLAR).await?;
    let c = commit(&carol, &weir, round, "Short", 8, 190_000, 2 * DOLLAR).await?;
    commit(&carol, &weir, round, "Short", 2, 300_000, DOLLAR).await?;
    let ours: String = view(&weir, "commit_hash", json!({
        "series": 0, "round": round, "account_id": alice.id(), "side": "Long", "size": 10, "price": 210_000, "salt": SALT,
    })).await?.as_str().unwrap().into();
    assert_eq!(ours, commit_hash(0, round, alice.id().as_str(), "Long", 10, 210_000));
    assert_eq!(free(&weir, &alice).await?, 497 * DOLLAR - FEE);
    assert_eq!(free(&weir, &carol).await?, 497 * DOLLAR - 2 * FEE);
    let series = view(&weir, "get_series", json!({ "series": 0 })).await?;
    assert_eq!((series["floor"].as_u64(), series["band"].as_u64()), (Some(1_800_000), Some(BAND)));
    assert_books_balance(&chain, &weir).await?;

    chain.warp_to(t.reveal_start(round)).await?;
    for (who, seq, side, size, price) in [(&alice, a, "Long", 10, 210_000), (&bob, b, "Long", 5, 200_000), (&carol, c, "Short", 8, 190_000)] {
        reveal(who, &weir, round, seq, side, size, price).await?.into_result()?;
    }
    chain.warp_to(t.round_end(round)).await?;
    bob.call(weir.id(), "clear").args_json(json!({ "series": 0, "round": round })).gas(CALL_GAS).transact().await?.into_result()?;
    let result = view(&weir, "get_result", json!({ "series": 0, "round": round })).await?;
    assert_eq!((result["price"].as_u64(), result["volume"].as_u64(), result["forfeited"].as_str()), (Some(210_000), Some(8), Some("100000")));
    assert_eq!(result["fees"].as_str(), Some("4000"));
    assert_eq!(free(&weir, &alice).await?, 500 * DOLLAR - 8 * 210_000 - FEE);
    assert_eq!(free(&weir, &bob).await?, 500 * DOLLAR - FEE);
    assert_eq!(free(&weir, &carol).await?, 500 * DOLLAR - 8 * 190_000 - 100_000 - 2 * FEE);
    let burned = view(&weir, "get_totals", json!({})).await?["burned"].clone();
    assert_eq!(burned, json!((100_000 + 4 * FEE).to_string()));
    assert_eq!(position(&weir, &alice).await?, (8, 0));
    assert_eq!(position(&weir, &carol).await?, (0, 8));
    assert_books_balance(&chain, &weir).await?;

    // Two prints in the delivery window: 2.10 and 2.00, so the fixing is 2.05.
    let first = t.t0.div_ceil(t.interval) * t.interval;
    chain.warp_to(first).await?;
    chain.print(&weir, &t, 2_100_000).await?;
    chain.warp_to(first + 600).await?;
    chain.print(&weir, &t, 2_000_000).await?;
    let acc = view(&weir, "get_accumulator", json!({ "series": 0 })).await?;
    assert_eq!(acc, json!({ "sum": "4100000", "count": 2 }));

    chain.warp_to(t.end() + t.grace).await?;
    bob.call(weir.id(), "settle").args_json(json!({ "series": 0 })).transact().await?.into_result()?;
    let s = view(&weir, "get_series", json!({ "series": 0 })).await?["settlement"].clone();
    // Carol's forfeit was burned: payouts are the band and nothing more.
    assert_eq!(
        (s["fixing"].as_u64(), s["long_payout"].as_u64(), s["short_payout"].as_u64(), s["void"].as_bool()),
        (Some(2_050_000), Some(250_000), Some(150_000), Some(false))
    );
    assert_books_balance(&chain, &weir).await?;

    // Units still move after settlement: Carol gives Bob 2 of her 8 SHORT.
    carol
        .call(weir.id(), "transfer_position")
        .args_json(json!({ "series": 0, "to": bob.id(), "long": 0, "short": 2 }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;
    assert_eq!(position(&weir, &carol).await?, (0, 6));
    assert_eq!(position(&weir, &bob).await?, (0, 2));

    // Bob redeems for Alice and for himself; Carol for herself.
    bob.call(weir.id(), "redeem").args_json(json!({ "series": 0, "account_id": alice.id() })).transact().await?.into_result()?;
    bob.call(weir.id(), "redeem").args_json(json!({ "series": 0 })).transact().await?.into_result()?;
    carol.call(weir.id(), "redeem").args_json(json!({ "series": 0 })).transact().await?.into_result()?;
    let alice_free = 500 * DOLLAR - 8 * 210_000 - FEE + 8 * 250_000;
    let carol_free = 500 * DOLLAR - 8 * 190_000 - 100_000 - 2 * FEE + 6 * 150_000;
    assert_eq!(free(&weir, &alice).await?, alice_free);
    assert_eq!(free(&weir, &bob).await?, 500 * DOLLAR - FEE + 2 * 150_000);
    assert_eq!(free(&weir, &carol).await?, carol_free);
    for who in [&alice, &bob, &carol] {
        assert_eq!(position(&weir, who).await?, (0, 0));
    }
    assert_books_balance(&chain, &weir).await?;

    // Alice takes everything out.
    alice
        .call(weir.id(), "withdraw")
        .args_json(json!({ "amount": alice_free.to_string() }))
        .deposit(ONE_YOCTO)
        .gas(CALL_GAS)
        .transact()
        .await?
        .into_result()?;
    assert_eq!(free(&weir, &alice).await?, 0);
    assert_eq!(chain.usdc_balance(alice.id()).await?, alice_free);
    assert_eq!(chain.usdc_balance(weir.id()).await?, 1_500 * DOLLAR - alice_free);
    assert_books_balance(&chain, &weir).await?;

    // A void series that traded. Series 2's auction is open now; Bob buys 5 LONG at
    // 0.22 from Carol, and then nobody reports during its delivery window.
    let t2 = t.shifted(2);
    chain.print(&weir, &t, PRICE).await?;
    let round = a_fresh_commit_phase(&chain, &t2, 60).await?;
    let (bob_before, carol_before) = (free(&weir, &bob).await?, free(&weir, &carol).await?);
    let b = commit_in(2, &bob, &weir, round, "Long", 5, 220_000, 2 * DOLLAR).await?;
    let c = commit_in(2, &carol, &weir, round, "Short", 5, 220_000, 2 * DOLLAR).await?;
    chain.warp_to(t2.reveal_start(round)).await?;
    reveal_in(2, &bob, &weir, round, b, "Long", 5, 220_000).await?.into_result()?;
    reveal_in(2, &carol, &weir, round, c, "Short", 5, 220_000).await?.into_result()?;
    chain.warp_to(t2.round_end(round)).await?;
    bob.call(weir.id(), "clear").args_json(json!({ "series": 2, "round": round })).gas(CALL_GAS).transact().await?.into_result()?;
    let series = view(&weir, "get_series", json!({ "series": 2 })).await?;
    assert_eq!((series["traded_units"].as_u64(), series["traded_value"].as_str()), (Some(5), Some("1100000")));
    assert_eq!(free(&weir, &bob).await?, bob_before - FEE - 5 * 220_000);
    assert_eq!(free(&weir, &carol).await?, carol_before - FEE - 5 * 180_000);

    chain.warp_to(t2.end() + t.grace).await?;
    let early = bob.call(weir.id(), "settle").args_json(json!({ "series": 2 })).transact().await?;
    assert!(format!("{:?}", early.failures()).contains("not enough prints yet"));
    chain.warp_to(t2.end() + 3_600).await?;
    bob.call(weir.id(), "settle").args_json(json!({ "series": 2 })).transact().await?.into_result()?;
    let s = view(&weir, "get_series", json!({ "series": 2 })).await?["settlement"].clone();
    // Cancelled at the centre of the band: 0.20 to each side, whatever was traded.
    assert_eq!(
        (s["fixing"].as_u64(), s["long_payout"].as_u64(), s["short_payout"].as_u64(), s["prints"].as_u64(), s["void"].as_bool()),
        (Some(2_000_000), Some(200_000), Some(200_000), Some(0), Some(true))
    );
    for who in [&bob, &carol] {
        bob.call(weir.id(), "redeem").args_json(json!({ "series": 2, "account_id": who.id() })).transact().await?.into_result()?;
    }
    // Bob paid 0.22 a LONG and gets 0.20: -0.10 $ on 5. Carol paid 0.18 a SHORT and
    // gets 0.20: +0.10 $. Each also paid its commit fee.
    assert_eq!(free(&weir, &bob).await?, bob_before - FEE - 5 * 20_000);
    assert_eq!(free(&weir, &carol).await?, carol_before - FEE + 5 * 20_000);
    assert_books_balance(&chain, &weir).await?;
    Ok(())
}

#[tokio::test]
async fn a_failed_withdraw_credits_back() -> anyhow::Result<()> {
    let chain = Chain::start().await?;
    let (weir, _) = chain.deploy_weir(lifecycle_timing, 16).await?;
    let funder = chain.trader(&weir, 10 * DOLLAR).await?;
    // Dave is registered at Weir but has no storage at the token, so a transfer to
    // him fails.
    let dave = chain.worker.dev_create_account().await?;
    dave.call(weir.id(), "register").args_json(json!({})).deposit(REGISTRATION).transact().await?.into_result()?;
    chain.usdc.call("mint").args_json(json!({ "account_id": funder.id(), "amount": "7000000" })).transact().await?.into_result()?;
    funder
        .call(chain.usdc.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": weir.id(), "amount": "7000000", "msg": dave.id() }))
        .deposit(ONE_YOCTO)
        .gas(CALL_GAS)
        .transact()
        .await?
        .into_result()?;
    assert_eq!(free(&weir, &dave).await?, 7 * DOLLAR);
    // Only the funder has a record at the token.
    assert!(view(&chain.usdc, "storage_balance_of", json!({ "account_id": dave.id() })).await?.is_null());

    let outcome = dave
        .call(weir.id(), "withdraw")
        .args_json(json!({ "amount": "3000000" }))
        .deposit(ONE_YOCTO)
        .gas(CALL_GAS)
        .transact()
        .await?;
    println!("the failed ft_transfer: {:?}", outcome.failures());
    assert_eq!(event(&outcome, "withdraw")["data"]["amount"], "3000000");
    assert_eq!(event(&outcome, "withdraw_failed")["data"]["amount"], "3000000");
    assert_eq!(free(&weir, &dave).await?, 7 * DOLLAR);
    assert_eq!(chain.usdc_balance(weir.id()).await?, 17 * DOLLAR);
    assert_books_balance(&chain, &weir).await?;
    Ok(())
}

#[tokio::test]
async fn a_function_call_key_trades_but_cannot_move_money() -> anyhow::Result<()> {
    let chain = Chain::start().await?;
    let (weir, t) = chain.deploy_weir(lifecycle_timing, 16).await?;
    let owner = chain.trader(&weir, 100 * DOLLAR).await?;
    let other = chain.trader(&weir, 10 * DOLLAR).await?;

    // The agent's key, limited as section 15 says.
    let methods = ["commit", "reveal", "clear", "mint", "merge", "settle", "redeem"];
    let key = SecretKey::from_random(KeyType::ED25519);
    owner
        .batch(owner.id())
        .add_key(key.public_key(), AccessKey::function_call_access(weir.id(), &methods, Some(NearToken::from_near(1))))
        .transact()
        .await?
        .into_result()?;
    let agent = Account::from_secret_key(owner.id().clone(), key, &chain.worker);

    chain.warp_to(t.open()).await?;
    chain.print(&weir, &t, PRICE).await?;
    let round = a_fresh_commit_phase(&chain, &t, 60).await?;
    let long = commit(&agent, &weir, round, "Long", 3, 200_000, DOLLAR).await?;
    let short = commit(&agent, &weir, round, "Short", 3, 200_000, DOLLAR).await?;
    agent.call(weir.id(), "mint").args_json(json!({ "series": 0, "sets": 2 })).transact().await?.into_result()?;
    agent.call(weir.id(), "merge").args_json(json!({ "series": 0, "sets": 1 })).transact().await?.into_result()?;
    chain.warp_to(t.reveal_start(round)).await?;
    reveal(&agent, &weir, round, long, "Long", 3, 200_000).await?.into_result()?;
    reveal(&agent, &weir, round, short, "Short", 3, 200_000).await?.into_result()?;
    chain.warp_to(t.round_end(round)).await?;
    agent.call(weir.id(), "clear").args_json(json!({ "series": 0, "round": round })).gas(CALL_GAS).transact().await?.into_result()?;
    assert_eq!(position(&weir, &owner).await?, (4, 4));
    // 2 sets minted, 1 merged, and 3 units each side bought at 0.20 + 0.20.
    assert_eq!(free(&weir, &owner).await?, 100 * DOLLAR - u128::from(BAND) - 3 * u128::from(BAND) - 2 * FEE);
    // `redeem` reaches the contract, which refuses only because nothing is settled.
    let redeem = agent.call(weir.id(), "redeem").args_json(json!({ "series": 0 })).transact().await?;
    assert!(format!("{:?}", redeem.failures()).contains("series is not settled"));

    // The rest fail before any code runs.
    let refused = [
        ("withdraw", json!({ "amount": "1" })),
        ("set_guard", json!({ "guard": 1 })),
        ("transfer_position", json!({ "series": 0, "to": other.id(), "long": 1, "short": 0 })),
    ];
    for (method, args) in &refused {
        let error = agent.call(weir.id(), method).args_json(args).transact().await.expect_err(method);
        println!("limited key, {method}: {error:?}");
        assert!(format!("{error:?}").contains("MethodNameMismatch"), "{method}: {error:?}");
    }

    // Even a key allowed every method cannot attach the 1 yoctoNEAR these need.
    let any_key = SecretKey::from_random(KeyType::ED25519);
    owner
        .batch(owner.id())
        .add_key(any_key.public_key(), AccessKey::function_call_access(weir.id(), &[], Some(NearToken::from_near(1))))
        .transact()
        .await?
        .into_result()?;
    let open_agent = Account::from_secret_key(owner.id().clone(), any_key, &chain.worker);
    for (method, args) in &refused {
        let error = open_agent.call(weir.id(), method).args_json(args).deposit(ONE_YOCTO).transact().await.expect_err(method);
        println!("any-method key with 1 yocto, {method}: {error:?}");
        assert!(format!("{error:?}").contains("DepositWithFunctionCall"), "{method}: {error:?}");
        let outcome = open_agent.call(weir.id(), method).args_json(args).transact().await?;
        println!("any-method key without deposit, {method}: {:?}", outcome.failures());
        assert!(format!("{:?}", outcome.failures()).contains("requires exactly 1 yoctoNEAR attached"), "{method}");
    }
    assert_eq!(position(&weir, &other).await?, (0, 0));
    assert_eq!(free(&weir, &owner).await?, 100 * DOLLAR - 4 * u128::from(BAND) - 2 * FEE);

    // The same key settles the series once delivery is over, and redeems. The last
    // buckets of the window get two reports of three and nobody finalizes them, so
    // `settle` has to decide them itself: the most it ever has to decide, since every
    // report decides up to four closed buckets and only the last windows stay open.
    let first = on_grid(t.t0, t.interval);
    chain.warp_to(first).await?;
    chain.print(&weir, &t, PRICE).await?;
    let mut tail = Vec::new();
    for k in (1..=3).rev() {
        let bucket = t.end() - k * t.interval;
        chain.warp_to(bucket).await?;
        for reporter in &chain.reporters[..2] {
            reporter
                .call(weir.id(), "report")
                .args_json(json!({ "bucket": bucket, "price": PRICE, "bundle": BUNDLE }))
                .transact()
                .await?
                .into_result()?;
        }
        tail.push(bucket);
    }
    let pending: Vec<u64> = serde_json::from_value(view(&weir, "get_pending_prints", json!({})).await?)?;
    chain.warp_to(t.end() + t.grace).await?;
    let settled = agent.call(weir.id(), "settle").args_json(json!({ "series": 0 })).gas(Gas::from_tgas(300)).transact().await?;
    let settle_tgas = settled.total_gas_burnt.as_gas() as f64 / 1e12;
    settled.into_result()?;
    println!("GAS settle deciding {} pending buckets {pending:?}: {settle_tgas:.2} Tgas", pending.len());
    assert!(pending.len() >= 2 && pending.iter().all(|b| tail.contains(b)), "{pending:?}");
    assert_eq!(view(&weir, "get_pending_prints", json!({})).await?, json!([]));
    let s = view(&weir, "get_series", json!({ "series": 0 })).await?["settlement"].clone();
    assert_eq!((s["fixing"].as_u64(), s["prints"].as_u64(), s["void"].as_bool()), (Some(PRICE), Some(4), Some(false)));
    agent.call(weir.id(), "redeem").args_json(json!({ "series": 0 })).transact().await?.into_result()?;
    // 4 sets at 0.40 each, nothing forfeited: every dollar is back but the two fees.
    assert_eq!(free(&weir, &owner).await?, 100 * DOLLAR - 2 * FEE);
    assert_eq!(position(&weir, &owner).await?, (0, 0));
    assert_books_balance(&chain, &weir).await?;
    Ok(())
}

fn gas_timing(now: u64) -> Timing {
    let lead = 7_260;
    Timing {
        t0: on_grid(now + lead + 3_600, 60),
        period: 7_200,
        lead,
        cutoff: 60,
        commit: 1_800,
        reveal: 1_800,
        interval: 60,
        grace: 120,
    }
}

/// Fills a round with `n` commits from `n` accounts, half LONG and half SHORT, every
/// one revealed and every one filled: the most work `clear` can have.
async fn full_round_gas(chain: &Chain, n: u32) -> anyhow::Result<f64> {
    let (weir, t) = chain.deploy_weir(gas_timing, n).await?;
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..n {
        let (worker, usdc, weir) = (chain.worker.clone(), chain.usdc.clone(), weir.clone());
        tasks.spawn(async move {
            let account = worker.dev_create_account().await?;
            fund(&account, &usdc, &weir, 3 * DOLLAR + FEE).await?;
            anyhow::Ok(account)
        });
    }
    let traders: Vec<Account> = tasks.join_all().await.into_iter().collect::<Result<_, _>>()?;

    chain.warp_to(t.open()).await?;
    chain.print(&weir, &t, PRICE).await?;
    let round = a_fresh_commit_phase(chain, &t, 600).await?;
    let order = |i: usize| if i.is_multiple_of(2) { ("Long", 210_000u64) } else { ("Short", 190_000u64) };
    let mut tasks = tokio::task::JoinSet::new();
    for (i, trader) in traders.iter().enumerate() {
        let (trader, weir) = (trader.clone(), weir.clone());
        let (side, price) = order(i);
        tasks.spawn(async move {
            let seq = commit(&trader, &weir, round, side, 10, price, 3 * DOLLAR).await?;
            anyhow::Ok((trader, seq, side, price))
        });
    }
    let commits: Vec<_> = tasks.join_all().await.into_iter().collect::<Result<_, _>>()?;
    assert_eq!(view(&weir, "get_round", json!({ "series": 0, "round": round })).await?["commits"].as_array().unwrap().len(), n as usize);

    chain.warp_to(t.reveal_start(round)).await?;
    let mut tasks = tokio::task::JoinSet::new();
    for (trader, seq, side, price) in commits {
        let weir = weir.clone();
        tasks.spawn(async move { reveal(&trader, &weir, round, seq, side, 10, price).await?.into_result().map(|_| ()).map_err(anyhow::Error::from) });
    }
    tasks.join_all().await.into_iter().collect::<Result<Vec<_>, _>>()?;

    chain.warp_to(t.round_end(round)).await?;
    let outcome = traders[0]
        .call(weir.id(), "clear")
        .args_json(json!({ "series": 0, "round": round }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    let receipt_tgas = outcome.receipt_outcomes().iter().map(|r| r.gas_burnt.as_gas()).max().unwrap_or(0) as f64 / 1e12;
    let total_tgas = outcome.total_gas_burnt.as_gas() as f64 / 1e12;
    outcome.into_result()?;
    let result = view(&weir, "get_result", json!({ "series": 0, "round": round })).await?;
    assert_eq!(result["volume"].as_u64(), Some(u64::from(n / 2) * 10));
    assert_eq!(result["fills"].as_array().unwrap().len(), n as usize);
    println!("clear of a full round, max_commits = {n}: {total_tgas:.2} Tgas burnt in all, {receipt_tgas:.2} Tgas by the contract");
    assert!(total_tgas < 300.0);
    assert_books_balance(chain, &weir).await?;
    Ok(total_tgas)
}

#[tokio::test]
async fn clearing_a_full_round_fits_in_one_transaction() -> anyhow::Result<()> {
    let chain = Chain::start().await?;
    let at_64 = full_round_gas(&chain, 64).await?;
    let at_128 = full_round_gas(&chain, 128).await?;
    println!("GAS clear: 64 commits {at_64:.2} Tgas, 128 commits {at_128:.2} Tgas");
    Ok(())
}
