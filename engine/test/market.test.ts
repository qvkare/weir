import assert from "node:assert/strict";
import { test } from "node:test";
import { isAccountId, Market, type Params, type Totals } from "../src/mod.ts";
import { BUNDLE, PARAMS, print, revealSecret, sealedCommit } from "./fixtures.ts";

const sum = (t: Totals) => t.free + t.locked + t.setsBacking + t.pools + t.unredeemed;

/** A market with an anchor print of 2_000_000 at 96_000 and three funded traders, at the
 * start of round 0 of series 0. Series 0 opens with floor 1_800_000 and band 400_000. */
function setup(params: Params = PARAMS): Market {
  const m = new Market(params, 96_000);
  print(m, 96_000, 2_000_000);
  for (const a of ["alice", "bob", "carol"]) {
    m.register(a);
    m.deposit(a, 10_000_000n);
  }
  m.setTime(96_400);
  return m;
}

test("a round from commit to redeem", () => {
  const m = setup();
  const a = sealedCommit(m, "alice", 0, 0, "Long", 10, 250_000, 2_500_000n);
  const b = sealedCommit(m, "bob", 0, 0, "Short", 10, 150_000, 2_500_000n);
  sealedCommit(m, "carol", 0, 0, "Long", 1, 100_000, 1_000_000n);
  assert.deepEqual([a.seq, b.seq], [0, 1]);
  const opened = m.getSeries(0)!;
  assert.deepEqual(
    [opened.anchor, opened.floor, opened.band, opened.openedAt, opened.pendingRounds],
    [2_000_000, 1_800_000, 400_000, 96_400, [0]],
  );

  m.setTime(96_520);
  revealSecret(m, a);
  revealSecret(m, b);
  m.setTime(96_580);
  const result = m.clear(0, 0);
  // Candidates 150_000 and 250_000 both have D = S = 10: midpoint 200_000.
  assert.equal(result.price, 200_000);
  assert.equal(result.volume, 10);
  assert.deepEqual(
    [result.longSize, result.shortSize, result.orders, result.commits, result.forfeited, result.clearedAt],
    [10, 10, 2, 3, 100_000n, 96_580],
  );
  assert.deepEqual(result.fills.map((f) => [f.seq, f.owner, f.filled]), [[0, "alice", 10], [1, "bob", 10]]);
  assert.equal(m.getRound(0, 0), null);
  assert.deepEqual(m.getResult(0, 0), result);
  assert.deepEqual(m.getResults(0, 0, 10), [[0, result]]);
  assert.deepEqual(m.getResults(0, 1, 10), []);
  // Each side paid 2_000_000 of a 2_500_000 lock; carol forfeits 10% of hers.
  assert.equal(m.getAccount("alice")!.balance, 8_000_000n);
  assert.equal(m.getAccount("bob")!.balance, 8_000_000n);
  assert.equal(m.getAccount("carol")!.balance, 9_900_000n);
  assert.deepEqual(m.getPosition(0, "alice"), { long: 10, short: 0 });
  assert.deepEqual(m.getPosition(0, "bob"), { long: 0, short: 10 });
  assert.equal(m.getSeries(0)!.openSets, 10);
  assert.equal(m.getSeries(0)!.bonusPool, 100_000n);
  assert.deepEqual(m.getTotals(), { free: 25_900_000n, locked: 0n, setsBacking: 4_000_000n, pools: 100_000n, unredeemed: 0n });

  // Three delivery prints at 2_100_000; the first is a 5% move, which is not far.
  for (const bucket of [100_000, 100_300, 100_600]) print(m, bucket, 2_100_000);
  assert.deepEqual(m.getAccumulator(0), { sum: 6_300_000n, count: 3 });
  m.setTime(103_719);
  assert.throws(() => m.settle(0), /report window/);
  m.setTime(103_720);
  const s = m.settle(0);
  assert.deepEqual(s, {
    fixing: 2_100_000,
    longPayout: 300_000,
    shortPayout: 100_000,
    bonusLong: 5000n,
    bonusShort: 5000n,
    prints: 3,
    void: false,
    settledAt: 103_720,
  });
  assert.throws(() => m.settle(0), /already settled/);
  assert.equal(m.getTotals().unredeemed, 4_100_000n);
  assert.equal(m.redeem(0, "alice"), 3_050_000n);
  assert.equal(m.redeem(0, "bob"), 1_050_000n);
  assert.throws(() => m.redeem(0, "bob"), /nothing to redeem/);
  assert.deepEqual(m.getTotals(), { free: 30_000_000n, locked: 0n, setsBacking: 0n, pools: 0n, unredeemed: 0n });
  m.pruneResult(0, 0);
  assert.equal(m.getResult(0, 0), null);

  const names = m.events.map((e) => e.event);
  assert.deepEqual(names.slice(names.indexOf("series_opened"), names.indexOf("clear") + 1), [
    "series_opened",
    "commit",
    "commit",
    "commit",
    "reveal",
    "reveal",
    "clear",
  ]);
  assert.deepEqual(m.events.at(-1), { event: "redeem", data: { series: 0, accountId: "bob", amount: 1_050_000n } });
});

test("opening needs a fresh print: index is stale", () => {
  const empty = new Market(PARAMS, 96_400);
  empty.register("alice");
  empty.deposit("alice", 10_000_000n);
  assert.throws(() => empty.mint("alice", 0, 1), { message: "index is stale" });

  const m = new Market({ ...PARAMS, maxAnchorAgeSecs: 1900 }, 94_500);
  m.register("alice");
  m.deposit("alice", 10_000_000n);
  print(m, 94_500, 2_000_000);
  m.setTime(96_400);
  // 96_400 - 94_500 = 1900, exactly the limit.
  m.mint("alice", 0, 1);
  assert.equal(m.getSeries(0)!.anchor, 2_000_000);
  m.setTime(100_000);
  assert.throws(() => m.mint("alice", 1, 1), { message: "index is stale" });
  assert.throws(() => sealedCommit(m, "alice", 1, 0, "Long", 1, 1000, 1000n), { message: "index is stale" });
  assert.equal(m.getSeries(1), null);
});

test("a full round evicts the smallest, latest lock, else round is full", () => {
  const m = setup();
  for (const lock of [2000n, 1000n, 1000n, 3000n]) sealedCommit(m, "alice", 0, 0, "Long", 1, 1000, lock);
  const before = { bob: m.getAccount("bob")!.balance, events: m.events.length };
  assert.throws(() => sealedCommit(m, "bob", 0, 0, "Long", 1, 1000, 1000n), { message: "round is full" });
  assert.deepEqual({ bob: m.getAccount("bob")!.balance, events: m.events.length }, before);

  sealedCommit(m, "bob", 0, 0, "Long", 1, 1000, 1001n);
  assert.deepEqual(m.events.at(-2), { event: "evict", data: { series: 0, round: 0, seq: 2, accountId: "alice", lock: 1000n } });
  const round = m.getRound(0, 0)!;
  assert.equal(round.nextSeq, 5);
  assert.deepEqual(round.commits.map((c) => c.seq), [0, 1, 3, 4]);
  assert.equal(m.getAccount("alice")!.balance, 10_000_000n - 6000n);
  assert.throws(() => sealedCommit(m, "bob", 0, 0, "Long", 1, 1000, 1000n), { message: "round is full" });
});

test("the guard voids orders far from the last print", () => {
  const m = setup();
  m.setGuard("alice", 0);
  m.setGuard("bob", 0);
  m.setGuard("carol", 50_000);
  // ref = 2_000_000 - 1_800_000 = 200_000.
  const a = sealedCommit(m, "alice", 0, 0, "Long", 1, 250_000, 250_000n);
  const b = sealedCommit(m, "bob", 0, 0, "Short", 1, 150_000, 250_000n);
  const c = sealedCommit(m, "carol", 0, 0, "Long", 1, 250_000, 250_000n);
  const okLong = sealedCommit(m, "alice", 0, 0, "Long", 1, 200_000, 200_000n);
  m.setTime(96_520);
  for (const s of [a, b, c, okLong]) revealSecret(m, s);
  assert.deepEqual(m.getRound(0, 0)!.commits.map((x) => x.state), ["Void", "Void", "Revealed", "Revealed"]);
  // The void lock is back at once; the other is still locked.
  assert.equal(m.getAccount("alice")!.balance, 10_000_000n - 200_000n);
  assert.equal(m.getAccount("bob")!.balance, 10_000_000n);
  assert.equal(m.getTotals().locked, 450_000n);
  m.setGuard("alice", null);
  assert.deepEqual(m.events.at(-1), { event: "guard", data: { accountId: "alice", guard: null } });
  m.setTime(96_580);
  const r = m.clear(0, 0);
  assert.deepEqual([r.price, r.orders, r.commits, r.forfeited], [null, 2, 4, 0n]);
});

test("a failed reveal leaves the commit unrevealed", () => {
  const m = setup({ ...PARAMS, maxCommits: 8 });
  const s = sealedCommit(m, "alice", 0, 0, "Long", 10, 250_000, 2_500_000n);
  const tooBig = sealedCommit(m, "alice", 0, 0, "Long", 101, 1000, 101_000n);
  const thin = sealedCommit(m, "alice", 0, 0, "Long", 10, 250_000, 2_499_999n);
  const offTick = sealedCommit(m, "alice", 0, 0, "Long", 1, 1500, 2000n);
  const atBand = sealedCommit(m, "alice", 0, 0, "Long", 1, 400_000, 400_000n);
  assert.throws(() => revealSecret(m, s), /reveal phase/);
  m.setTime(96_520);
  assert.throws(() => revealSecret(m, { ...s, salt: "0".repeat(32) }), /does not match/);
  assert.throws(() => revealSecret(m, { ...s, price: 251_000 }), /does not match/);
  assert.throws(() => revealSecret(m, { ...s, salt: "XYZ" }), /salt/);
  assert.throws(() => revealSecret(m, { ...s, owner: "bob" }), /another account/);
  assert.throws(() => revealSecret(m, { ...s, seq: 99 }), /not found/);
  assert.throws(() => revealSecret(m, tooBig), /size is out of range/);
  assert.throws(() => revealSecret(m, thin), /lock does not cover/);
  assert.throws(() => revealSecret(m, offTick), /price is out of range/);
  assert.throws(() => revealSecret(m, atBand), /price is out of range/);
  assert.equal(m.getRound(0, 0)!.commits[0]!.state, "Committed");
  revealSecret(m, s);
  assert.deepEqual(m.getRound(0, 0)!.commits[0]!.order, { side: "Long", size: 10, price: 250_000 });
  assert.throws(() => revealSecret(m, s), /already revealed/);
  m.setTime(96_580);
  assert.throws(() => revealSecret(m, thin), /reveal phase/);
});

test("clear panics before the round is over, without commits, and twice", () => {
  const m = setup();
  assert.throws(() => m.clear(0, 0), /no commits/);
  sealedCommit(m, "alice", 0, 0, "Long", 1, 1000, 1000n);
  m.setTime(96_579);
  assert.throws(() => m.clear(0, 0), /not over/);
  m.setTime(96_580);
  // Nothing revealed: the whole lock is subject to forfeit.
  assert.equal(m.clear(0, 0).forfeited, 100n);
  assert.throws(() => m.clear(0, 0), /already cleared/);
});

test("commit checks its inputs and its phase", () => {
  const m = setup();
  const hash = "a".repeat(64);
  assert.throws(() => m.commit("zed", 0, hash, 1000n), /not registered/);
  assert.throws(() => m.commit("alice", 0, "A".repeat(64), 1000n), /hash/);
  assert.throws(() => m.commit("alice", 0, hash, 999n), /min_lock/);
  assert.throws(() => m.commit("alice", 0, hash, 10_000_001n), /balance/);
  // A failed commit did not open the series.
  assert.equal(m.getSeries(0), null);
  m.setTime(96_520);
  assert.throws(() => m.commit("alice", 0, hash, 1000n), /commit phase/);
  m.setTime(103_000);
  assert.throws(() => m.commit("alice", 0, hash, 1000n), /commit phase/);
});

test("reports: windows, duplicates, finality and far moves", () => {
  const m = new Market(PARAMS, 96_000);
  assert.throws(() => m.report("alice", 96_000, 1, BUNDLE), /not a reporter/);
  assert.throws(() => m.report("r0", 96_050, 1, BUNDLE), /multiple/);
  assert.throws(() => m.report("r0", 96_300, 1, BUNDLE), /report window/);
  assert.throws(() => m.report("r0", 96_000, 0, BUNDLE), /above zero/);
  assert.throws(() => m.report("r0", 96_000, 1, "short"), /bundle/);
  assert.equal(m.report("r0", 96_000, 2_000_000, BUNDLE), false);
  assert.throws(() => m.report("r0", 96_000, 2_000_000, BUNDLE), /already reported/);
  assert.deepEqual(m.getPrint(96_000), {
    bucket: 96_000,
    price: null,
    final: false,
    reports: [{ reporter: "r0", price: 2_000_000, bundle: BUNDLE }],
  });
  assert.equal(m.report("r1", 96_000, 2_000_002, BUNDLE), true);
  assert.equal(m.report("r2", 96_000, 1, BUNDLE), false);
  assert.equal(m.getPrint(96_000)!.reports.length, 2);
  assert.deepEqual(m.getLastPrint(), { bucket: 96_000, price: 2_000_001 });
  // Bucket 96_000 is before t0, so no series accumulates it.
  assert.deepEqual(m.getAccumulator(0), { sum: 0n, count: 0 });

  // A 10% move needs all three reporters.
  m.setTime(96_419);
  assert.equal(m.report("r0", 96_300, 2_200_000, BUNDLE), false);
  assert.equal(m.report("r1", 96_300, 2_200_000, BUNDLE), false);
  assert.equal(m.report("r2", 96_300, 2_300_000, BUNDLE), true);
  assert.equal(m.getPrint(96_300)!.price, 2_200_000);
  m.setTime(96_420);
  assert.throws(() => m.report("r0", 96_000, 1, BUNDLE), /report window/);

  // Once a print is final, further reports for it do nothing, even a repeat.
  m.setTime(96_620);
  print(m, 96_600, 2_200_000);
  const events = m.events.length;
  assert.equal(m.report("r2", 96_600, 1, BUNDLE), false);
  assert.equal(m.report("r0", 96_600, 1, BUNDLE), false);
  assert.equal(m.events.length, events);
  assert.deepEqual(m.getPrints(0, 10).map((p) => p.bucket), [96_000, 96_300, 96_600]);
  assert.deepEqual(m.getPrints(96_301, 1).map((p) => p.bucket), [96_600]);
});

test("an earlier bucket finalizing late is not measured against a later print", () => {
  const m = new Market(PARAMS, 96_600);
  print(m, 96_600, 2_000_000);
  // Bucket 96_500's window runs to 96_720. Against 2_000_000 a 4_000_000 print would be far.
  assert.equal(m.report("r0", 96_500, 4_000_000, BUNDLE), false);
  assert.equal(m.report("r1", 96_500, 4_000_000, BUNDLE), true);
  assert.deepEqual(m.getLastPrint(), { bucket: 96_600, price: 2_000_000 });
});

test("delivery prints feed the accumulator of their series", () => {
  const m = new Market(PARAMS, 100_000);
  print(m, 100_000, 2_000_000);
  print(m, 103_500, 2_000_001);
  print(m, 103_600, 2_050_000);
  assert.deepEqual(m.getAccumulator(0), { sum: 4_000_001n, count: 2 });
  assert.deepEqual(m.getAccumulator(1), { sum: 2_050_000n, count: 1 });
});

test("void settlement with no prints and with some prints", () => {
  for (const prints of [0, 2]) {
    const m = setup();
    m.mint("alice", 0, 2);
    m.mint("bob", 0, 1);
    for (let i = 0; i < prints; i++) print(m, 100_000 + 300 * i, 2_050_001 + i);
    m.setTime(103_720);
    assert.throws(() => m.settle(0), { message: "not enough prints yet" });
    m.setTime(105_999);
    assert.throws(() => m.settle(0), { message: "not enough prints yet" });
    m.setTime(106_000);
    const s = m.settle(0);
    // No prints: floor + band / 2 = 2_000_000. Two: (2_050_001 + 2_050_002) / 2 = 2_050_001.
    const fixing = prints === 0 ? 2_000_000 : 2_050_001;
    assert.deepEqual([s.void, s.fixing, s.prints, s.longPayout, s.shortPayout], [true, fixing, prints, fixing - 1_800_000, 2_200_000 - fixing]);
    assert.equal(m.redeem(0, "alice"), 800_000n);
    assert.equal(m.redeem(0, "bob"), 400_000n);
  }
});

test("settle waits for pending rounds; forfeits are shared as bonus and the rest carries", () => {
  const m = setup();
  m.mint("alice", 0, 3);
  sealedCommit(m, "bob", 0, 0, "Long", 1, 1000, 1_000_005n);
  m.setTime(106_000);
  assert.throws(() => m.settle(0), /waiting to be cleared/);
  assert.deepEqual(m.getSeries(0)!.pendingRounds, [0]);
  // Forfeit 100_000 (rounded down from 100_000.5) over 3 sets: 33_333 per set, carry 1.
  assert.equal(m.clear(0, 0).forfeited, 100_000n);
  const s = m.settle(0);
  assert.deepEqual([s.bonusLong, s.bonusShort], [16_666n, 16_667n]);
  assert.equal(m.getTotals().pools, 1n);
  assert.equal(m.redeem(0, "alice"), 3n * 400_000n + 99_999n);
});

test("mint, transfer and merge", () => {
  const m = setup();
  assert.throws(() => m.mint("alice", 0, 0), /at least 1/);
  assert.throws(() => m.mint("alice", 0, 26), /balance/);
  m.mint("alice", 0, 3);
  assert.equal(m.getAccount("alice")!.balance, 8_800_000n);
  m.transferPosition("alice", 0, "bob", 1, 0);
  assert.throws(() => m.transferPosition("alice", 0, "nobody", 1, 0), /receiver/);
  assert.throws(() => m.transferPosition("alice", 0, "bob", 3, 0), /not enough/);
  assert.throws(() => m.transferPosition("alice", 0, "bob", 0, 0), /nothing/);
  assert.throws(() => m.merge("alice", 0, 3), /not enough/);
  m.merge("alice", 0, 2);
  assert.deepEqual(m.getPosition(0, "alice"), { long: 0, short: 1 });
  assert.deepEqual(m.getPosition(0, "bob"), { long: 1, short: 0 });
  assert.equal(m.getSeries(0)!.openSets, 1);
  assert.equal(m.getAccount("alice")!.balance, 9_600_000n);
  assert.deepEqual(m.events.at(-1), { event: "merge", data: { series: 0, accountId: "alice", sets: 2 } });
  m.setTime(103_000);
  assert.throws(() => m.mint("alice", 0, 1), /auction window/);
  assert.throws(() => m.merge("alice", 7, 1), /not open/);
});

test("accounts, deposits and withdrawals", () => {
  const m = new Market(PARAMS, 0);
  assert.equal(m.deposit("alice", 5n), 5n);
  m.register("alice");
  assert.throws(() => m.register("alice"), /already registered/);
  assert.equal(m.deposit("alice", 5n), 0n);
  assert.throws(() => m.deposit("alice", 0n), /above zero/);
  assert.throws(() => m.withdraw("alice", 6n), /too low/);
  m.withdraw("alice", 2n, { transferFails: true });
  assert.equal(m.getAccount("alice")!.balance, 5n);
  m.withdraw("alice", 2n);
  assert.deepEqual(m.getAccount("alice"), { balance: 3n, guard: null });
  assert.deepEqual(m.events.map((e) => e.event), ["register", "deposit", "withdraw", "withdraw_failed", "withdraw"]);
  assert.equal(m.getAccount("bob"), null);
  assert.equal(sum(m.getTotals()), 3n);
  assert.throws(() => m.setTime(-1), /non-negative/);
  m.setTime(10);
  assert.throws(() => m.setTime(9), /backwards/);
});

test("status lists every live series and its phase", () => {
  const m = new Market(PARAMS, 96_399);
  assert.deepEqual(m.getStatus(), { now: 96_399, live: [] });
  m.setTime(96_400);
  assert.deepEqual(m.getStatus().live, [
    {
      series: 0,
      deliveryStart: 100_000,
      deliveryEnd: 103_600,
      auctionOpen: 96_400,
      auctionClose: 100_000,
      round: 0,
      phase: "Commit",
      phaseEndsAt: 96_520,
    },
  ]);
  const brief = () => m.getStatus().live.map((l) => [l.series, l.round, l.phase, l.phaseEndsAt]);
  // Series 0's last round, 19, runs until 100_000, the second series 1's auctions open.
  m.setTime(99_999);
  assert.deepEqual(brief(), [[0, 19, "Reveal", 100_000]]);
  m.setTime(100_000);
  assert.deepEqual(brief(), [[1, 0, "Commit", 100_120]]);
  m.setTime(102_900);
  assert.deepEqual(brief(), [[1, 16, "Commit", 103_000]]);
});

test("params are validated", () => {
  assert.throws(() => new Market({ ...PARAMS, quorum: 4 }), /quorum/);
  assert.throws(() => new Market({ ...PARAMS, reporters: ["ra", "ra"], quorum: 1 }), /repeat/);
  assert.throws(() => new Market({ ...PARAMS, cutoffSecs: 3600 }), /cutoff/);
  assert.throws(() => new Market({ ...PARAMS, bandBps: 10_000 }), /band_bps/);
  assert.throws(() => new Market({ ...PARAMS, maxCommits: 129 }), /max_commits/);
  assert.throws(() => new Market({ ...PARAMS, commitSecs: 0 }), /commitSecs/);
  assert.throws(() => new Market({ ...PARAMS, tick: 0 }), /tick/);
  assert.throws(() => new Market({ ...PARAMS, t0: 100_050 }), /multiples of print_interval_secs/);
  assert.throws(() => new Market({ ...PARAMS, periodSecs: 3650, leadSecs: 3650 }), /multiples of print_interval_secs/);
  assert.throws(() => new Market({ ...PARAMS, reporters: ["R0"], quorum: 1 }), /reporters/);
  assert.throws(() => new Market({ ...PARAMS, usdc: "USDC" }), /usdc/);
  new Market({ ...PARAMS, cutoffSecs: 0 });
});

test("pending rounds are listed ascending until cleared", () => {
  const m = setup();
  sealedCommit(m, "alice", 0, 0, "Long", 1, 1000, 1000n);
  m.setTime(96_400 + 2 * 180);
  sealedCommit(m, "alice", 0, 2, "Long", 1, 1000, 1000n);
  assert.deepEqual(m.getSeries(0)!.pendingRounds, [0, 2]);
  m.clear(0, 0);
  assert.deepEqual(m.getSeries(0)!.pendingRounds, [2]);
});

test("account ids, deposits to bad ids, withdrawing zero, transfer to yourself", () => {
  for (const ok of ["ab", "alice", "alice.near", "a-b_c.d1", "0x", "a".repeat(64)]) assert.ok(isAccountId(ok), ok);
  for (const bad of ["", "a", "Alice", "a..b", ".a", "a.", "a-", "-a", "a b", "a@b", "a".repeat(65)]) {
    assert.ok(!isAccountId(bad), bad);
  }
  const m = setup();
  assert.throws(() => m.register("Bad"), /account id/);
  assert.equal(m.deposit("a..b", 5n), 5n);
  assert.equal(m.deposit("A", 5n), 5n);
  assert.throws(() => m.withdraw("alice", 0n), /above zero/);
  m.mint("alice", 0, 1);
  assert.throws(() => m.transferPosition("alice", 0, "alice", 1, 0), /yourself/);
});

test("status lists at most 32 series", () => {
  // A lead of 40 periods puts series 1 to 40 in auction at t0.
  const m = new Market({ ...PARAMS, t0: 200_000, leadSecs: 40 * 3600 }, 200_000);
  const live = m.getStatus().live.map((l) => l.series);
  assert.equal(live.length, 32);
  assert.deepEqual([live[0], live.at(-1)], [1, 32]);
});
