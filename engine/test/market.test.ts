import assert from "node:assert/strict";
import { test } from "node:test";
import { ERR, isAccountId, Market, type Params, type Totals } from "../src/mod.ts";
import { BUNDLE, PARAMS, print, revealSecret, sealedCommit } from "./fixtures.ts";

const sum = (t: Totals) => t.free + t.locked + t.setsBacking + t.unredeemed + t.burned;
const refused = (text: string) => ({ message: text });

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

test("a round from commit to redeem, with fees and forfeits burned", () => {
  const m = setup({ ...PARAMS, commitFee: 1000n });
  const a = sealedCommit(m, "alice", 0, 0, "Long", 10, 250_000, 2_500_000n);
  const b = sealedCommit(m, "bob", 0, 0, "Short", 10, 150_000, 2_500_000n);
  sealedCommit(m, "carol", 0, 0, "Long", 1, 100_000, 1_000_000n);
  assert.deepEqual([a.seq, b.seq], [0, 1]);
  const opened = m.getSeries(0)!;
  assert.deepEqual(
    [opened.anchor, opened.floor, opened.band, opened.openedAt, opened.pendingRounds],
    [2_000_000, 1_800_000, 400_000, 96_400, [0]],
  );
  assert.equal(m.getRound(0, 0)!.commits[2]!.fee, 1000n);
  assert.equal(m.getTotals().locked, 6_003_000n);

  m.setTime(96_520);
  revealSecret(m, a);
  revealSecret(m, b);
  m.setTime(96_580);
  const result = m.clear(0, 0);
  // Candidates 150_000 and 250_000 both have D = S = 10: midpoint 200_000.
  assert.deepEqual(result, {
    price: 200_000,
    volume: 10,
    longSize: 10,
    shortSize: 10,
    orders: 2,
    commits: 3,
    forfeited: 100_000n,
    fees: 3000n,
    clearedAt: 96_580,
    fills: [
      { seq: 0, owner: "alice", side: "Long", size: 10, price: 250_000, filled: 10 },
      { seq: 1, owner: "bob", side: "Short", size: 10, price: 150_000, filled: 10 },
    ],
  });
  assert.equal(m.getRound(0, 0), null);
  assert.deepEqual(m.getResult(0, 0), result);
  assert.deepEqual(m.getResults(0, 0, 10), [[0, result]]);
  assert.deepEqual(m.getResults(0, 1, 10), []);
  // Each side paid 2_000_000 of a 2_500_000 lock and its fee; carol forfeits 10% of hers.
  assert.equal(m.getAccount("alice")!.balance, 7_999_000n);
  assert.equal(m.getAccount("bob")!.balance, 7_999_000n);
  assert.equal(m.getAccount("carol")!.balance, 9_899_000n);
  assert.deepEqual(m.getPosition(0, "alice"), { long: 10, short: 0 });
  assert.deepEqual(m.getPosition(0, "bob"), { long: 0, short: 10 });
  assert.equal(m.getSeries(0)!.openSets, 10);
  assert.deepEqual(m.getTotals(), {
    free: 25_897_000n,
    locked: 0n,
    setsBacking: 4_000_000n,
    unredeemed: 0n,
    burned: 103_000n,
  });

  for (const bucket of [100_000, 100_300, 100_600]) print(m, bucket, 2_100_000);
  assert.deepEqual(m.getAccumulator(0), { sum: 6_300_000n, count: 3 });
  m.setTime(103_719);
  assert.throws(() => m.settle(0), refused(ERR.DELIVERY_NOT_OVER));
  m.setTime(103_720);
  assert.deepEqual(m.settle(0), {
    fixing: 2_100_000,
    longPayout: 300_000,
    shortPayout: 100_000,
    prints: 3,
    void: false,
    settledAt: 103_720,
  });
  assert.throws(() => m.settle(0), refused(ERR.SETTLED));
  assert.equal(m.getTotals().unredeemed, 4_000_000n);
  assert.equal(m.redeem(0, "alice"), 3_000_000n);
  assert.equal(m.redeem(0, "bob"), 1_000_000n);
  assert.throws(() => m.redeem(0, "bob"), refused(ERR.NO_POSITION));
  assert.deepEqual(m.getTotals(), { free: 29_897_000n, locked: 0n, setsBacking: 0n, unredeemed: 0n, burned: 103_000n });
  m.pruneResult(0, 0);
  assert.equal(m.getResult(0, 0), null);
  assert.throws(() => m.pruneResult(0, 0), refused(ERR.NO_RESULT));

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
  assert.deepEqual(m.events.at(-1), { event: "prune_result", data: { series: 0, round: 0 } });
});

test("fills list only the orders that were filled", () => {
  const m = setup();
  const a = sealedCommit(m, "alice", 0, 0, "Long", 5, 100_000, 500_000n);
  const b = sealedCommit(m, "bob", 0, 0, "Long", 5, 300_000, 1_500_000n);
  const c = sealedCommit(m, "carol", 0, 0, "Short", 5, 200_000, 1_000_000n);
  m.setTime(96_520);
  for (const s of [a, b, c]) revealSecret(m, s);
  m.setTime(96_580);
  const r = m.clear(0, 0);
  assert.deepEqual([r.price, r.orders, r.longSize], [250_000, 3, 10]);
  assert.deepEqual(r.fills.map((f) => [f.seq, f.filled]), [[1, 5], [2, 5]]);
});

test("opening needs a fresh print: index is stale", () => {
  const empty = new Market(PARAMS, 96_400);
  empty.register("alice");
  empty.deposit("alice", 10_000_000n);
  assert.throws(() => empty.mint("alice", 0, 1), refused(ERR.STALE));

  const m = new Market({ ...PARAMS, maxAnchorAgeSecs: 1900 }, 94_500);
  m.register("alice");
  m.deposit("alice", 10_000_000n);
  print(m, 94_500, 2_000_000);
  m.setTime(96_400);
  // 96_400 - 94_500 = 1900, exactly the limit.
  m.mint("alice", 0, 1);
  assert.equal(m.getSeries(0)!.anchor, 2_000_000);
  m.setTime(100_000);
  assert.throws(() => m.mint("alice", 1, 1), refused(ERR.STALE));
  assert.throws(() => sealedCommit(m, "alice", 1, 0, "Long", 1, 1000, 1000n), refused(ERR.STALE));
  assert.equal(m.getSeries(1), null);
});

test("a full round evicts the smallest, latest lock with its fee, else round is full", () => {
  const m = setup({ ...PARAMS, commitFee: 7n });
  for (const lock of [2000n, 1000n, 1000n, 3000n]) sealedCommit(m, "alice", 0, 0, "Long", 1, 1000, lock);
  const before = { bob: m.getAccount("bob")!.balance, events: m.events.length };
  assert.throws(() => sealedCommit(m, "bob", 0, 0, "Long", 1, 1000, 1000n), refused(ERR.ROUND_FULL));
  assert.deepEqual({ bob: m.getAccount("bob")!.balance, events: m.events.length }, before);

  sealedCommit(m, "bob", 0, 0, "Long", 1, 1000, 1001n);
  assert.deepEqual(m.events.at(-2), {
    event: "evict",
    data: { series: 0, round: 0, seq: 2, accountId: "alice", lock: 1000n, fee: 7n },
  });
  const round = m.getRound(0, 0)!;
  assert.equal(round.nextSeq, 5);
  assert.deepEqual(round.commits.map((c) => c.seq), [0, 1, 3, 4]);
  // Four commits with fees, one returned in full.
  assert.equal(m.getAccount("alice")!.balance, 10_000_000n - 6000n - 3n * 7n);
  assert.throws(() => sealedCommit(m, "bob", 0, 0, "Long", 1, 1000, 1000n), refused(ERR.ROUND_FULL));
});

test("the guard and reference recorded at commit decide whether an order is void", () => {
  const m = setup({ ...PARAMS, commitFee: 100n });
  m.setGuard("alice", 0);
  m.setGuard("bob", 0);
  // ref = 2_000_000 - 1_800_000 = 200_000.
  const a = sealedCommit(m, "alice", 0, 0, "Long", 1, 250_000, 250_000n);
  const b = sealedCommit(m, "bob", 0, 0, "Short", 1, 150_000, 250_000n);
  const c = sealedCommit(m, "carol", 0, 0, "Long", 1, 250_000, 250_000n);
  const okLong = sealedCommit(m, "alice", 0, 0, "Long", 1, 200_000, 200_000n);
  // Changing the guard or the index after committing changes nothing.
  m.setGuard("alice", null);
  m.setGuard("carol", 0);
  print(m, 96_500, 1_950_000);
  m.setTime(96_520);
  for (const s of [a, b, c, okLong]) revealSecret(m, s);
  assert.deepEqual(m.getRound(0, 0)!.commits.map((x) => x.state), ["Void", "Void", "Revealed", "Revealed"]);
  // A void lock is back at once; its fee stays with the round.
  assert.equal(m.getAccount("alice")!.balance, 10_000_000n - 200_000n - 200n);
  assert.equal(m.getAccount("bob")!.balance, 10_000_000n - 100n);
  assert.equal(m.getTotals().locked, 450_000n + 400n);
  m.setTime(96_580);
  const r = m.clear(0, 0);
  assert.deepEqual([r.price, r.orders, r.commits, r.forfeited, r.fees], [null, 2, 4, 0n, 400n]);
  assert.deepEqual(r.fills, []);
});

test("max_round_lock bounds what an account locks in one round", () => {
  const m = setup();
  m.setGuard("alice", null, 3000n);
  assert.deepEqual(m.events.at(-1), { event: "guard", data: { accountId: "alice", guard: null, maxRoundLock: 3000n } });
  assert.deepEqual(m.getAccount("alice"), { balance: 10_000_000n, guard: null, maxRoundLock: 3000n });
  sealedCommit(m, "alice", 0, 0, "Long", 1, 1000, 2000n);
  assert.throws(() => sealedCommit(m, "alice", 0, 0, "Long", 1, 1000, 1001n), refused(ERR.ROUND_LOCK));
  sealedCommit(m, "alice", 0, 0, "Long", 1, 1000, 1000n);
  // Other accounts' commits do not count, and the next round starts again.
  sealedCommit(m, "bob", 0, 0, "Long", 1, 1000, 5000n);
  m.setTime(96_580);
  sealedCommit(m, "alice", 0, 1, "Long", 1, 1000, 3000n);
  m.setGuard("alice", null);
  sealedCommit(m, "alice", 0, 1, "Long", 1, 1000, 9000n);
});

test("a failed reveal leaves the commit unrevealed", () => {
  const m = setup({ ...PARAMS, maxCommits: 8 });
  const s = sealedCommit(m, "alice", 0, 0, "Long", 10, 250_000, 2_500_000n);
  const tooBig = sealedCommit(m, "alice", 0, 0, "Long", 101, 1000, 101_000n);
  const thin = sealedCommit(m, "alice", 0, 0, "Long", 10, 250_000, 2_499_999n);
  const offTick = sealedCommit(m, "alice", 0, 0, "Long", 1, 1500, 2000n);
  const atBand = sealedCommit(m, "alice", 0, 0, "Long", 1, 400_000, 400_000n);
  assert.throws(() => revealSecret(m, s), refused(ERR.NOT_REVEAL_PHASE));
  m.setTime(96_520);
  assert.throws(() => revealSecret(m, { ...s, salt: "0".repeat(32) }), refused(ERR.HASH_MISMATCH));
  assert.throws(() => revealSecret(m, { ...s, price: 251_000 }), refused(ERR.HASH_MISMATCH));
  assert.throws(() => revealSecret(m, { ...s, salt: "XYZ" }), refused(ERR.BAD_SALT));
  assert.throws(() => revealSecret(m, { ...s, owner: "bob" }), refused(ERR.NOT_OWNER));
  assert.throws(() => revealSecret(m, { ...s, seq: 99 }), refused(ERR.NO_COMMIT));
  assert.throws(() => revealSecret(m, { ...s, round: 1 }), refused(ERR.NO_COMMIT));
  assert.throws(() => revealSecret(m, tooBig), refused(ERR.BAD_SIZE));
  assert.throws(() => revealSecret(m, thin), refused(ERR.UNDER_LOCKED));
  assert.throws(() => revealSecret(m, offTick), refused(ERR.BAD_PRICE));
  assert.throws(() => revealSecret(m, atBand), refused(ERR.BAD_PRICE));
  assert.equal(m.getRound(0, 0)!.commits[0]!.state, "Committed");
  revealSecret(m, s);
  assert.deepEqual(m.getRound(0, 0)!.commits[0]!.order, { side: "Long", size: 10, price: 250_000 });
  assert.throws(() => revealSecret(m, s), refused(ERR.ALREADY_REVEALED));
  m.setTime(96_580);
  assert.throws(() => revealSecret(m, thin), refused(ERR.NOT_REVEAL_PHASE));
});

test("clear panics before the round is over, without commits, and twice", () => {
  const m = setup();
  assert.throws(() => m.clear(0, 0), refused(ERR.NO_COMMITS));
  sealedCommit(m, "alice", 0, 0, "Long", 1, 1000, 1000n);
  m.setTime(96_579);
  assert.throws(() => m.clear(0, 0), refused(ERR.ROUND_NOT_OVER));
  m.setTime(96_580);
  // Nothing revealed: 10% of the lock is burned.
  assert.equal(m.clear(0, 0).forfeited, 100n);
  assert.equal(m.getTotals().burned, 100n);
  assert.throws(() => m.clear(0, 0), refused(ERR.CLEARED));
});

test("commit checks its inputs, the balance with the fee, and its phase", () => {
  const m = setup({ ...PARAMS, commitFee: 1n });
  const hash = "a".repeat(64);
  assert.throws(() => m.commit("zed", 0, hash, 1000n), refused(ERR.NOT_REGISTERED));
  assert.throws(() => m.commit("alice", 0, "A".repeat(64), 1000n), refused(ERR.BAD_HASH));
  assert.throws(() => m.commit("alice", 0, hash, 999n), refused(ERR.LOCK_TOO_SMALL));
  assert.throws(() => m.commit("alice", 0, hash, 10_000_000n), refused(ERR.BALANCE));
  // A failed commit did not open the series.
  assert.equal(m.getSeries(0), null);
  m.commit("alice", 0, hash, 9_999_999n);
  assert.equal(m.getAccount("alice")!.balance, 0n);
  m.setTime(96_520);
  assert.throws(() => m.commit("bob", 0, hash, 1000n), refused(ERR.NOT_COMMIT_PHASE));
  m.setTime(103_000);
  assert.throws(() => m.commit("bob", 0, hash, 1000n), refused(ERR.NOT_COMMIT_PHASE));
});

test("report checks and deciding a bucket when every reporter has reported", () => {
  const m = new Market(PARAMS, 96_000);
  assert.throws(() => m.report("alice", 96_000, 1, BUNDLE), refused(ERR.NOT_REPORTER));
  assert.throws(() => m.report("r0", 96_050, 1, BUNDLE), refused(ERR.BUCKET));
  assert.throws(() => m.report("r0", 96_100, 1, BUNDLE), refused(ERR.REPORT_WINDOW));
  assert.throws(() => m.report("r0", 96_000, 0, BUNDLE), refused(ERR.ZERO_PRICE));
  assert.throws(() => m.report("r0", 96_000, 1, "short"), refused(ERR.BAD_BUNDLE));
  assert.equal(m.report("r0", 96_000, 2_000_000, BUNDLE), false);
  assert.throws(() => m.report("r0", 96_000, 2_000_000, BUNDLE), refused(ERR.DUPLICATE_REPORT));
  // Quorum alone does not decide: the bucket waits for the last reporter or its window.
  assert.equal(m.report("r1", 96_000, 2_000_002, BUNDLE), false);
  assert.deepEqual(m.getPrint(96_000), {
    bucket: 96_000,
    price: null,
    state: "Open",
    reports: [
      { reporter: "r0", price: 2_000_000, bundle: BUNDLE },
      { reporter: "r1", price: 2_000_002, bundle: BUNDLE },
    ],
  });
  assert.deepEqual(m.getPendingPrints(), [96_000]);
  // A far-off third report does not move the median.
  assert.equal(m.report("r2", 96_000, 9_000_000, BUNDLE), true);
  assert.deepEqual(m.getPrint(96_000)!.price, 2_000_002);
  assert.equal(m.getPrint(96_000)!.state, "Final");
  assert.deepEqual(m.getLastPrint(), { bucket: 96_000, price: 2_000_002 });
  assert.deepEqual(m.getPendingPrints(), []);
  assert.deepEqual(m.events.at(-1), { event: "print", data: { bucket: 96_000, price: 2_000_002, reports: 3 } });
  // Bucket 96_000 is before t0, so no series accumulates it.
  assert.deepEqual(m.getAccumulator(0), { sum: 0n, count: 0 });
  // A decided bucket ignores further reports, even a repeat, and logs nothing.
  const events = m.events.length;
  assert.equal(m.report("r0", 96_000, 1, BUNDLE), false);
  assert.equal(m.events.length, events);
  m.setTime(96_220);
  assert.throws(() => m.report("r0", 96_000, 1, BUNDLE), refused(ERR.REPORT_WINDOW));
});

test("finalize_print decides a closed bucket: a print, or none", () => {
  const m = new Market(PARAMS, 96_000);
  m.report("r0", 96_000, 2_000_000, BUNDLE);
  m.report("r1", 96_000, 2_100_000, BUNDLE);
  m.setTime(96_100);
  m.report("r0", 96_100, 2_000_000, BUNDLE);
  m.report("r1", 96_100, 2_100_001, BUNDLE);
  m.setTime(96_200);
  m.report("r0", 96_200, 2_000_000, BUNDLE);
  assert.throws(() => m.finalizePrint(96_300), refused(ERR.NO_REPORTS));
  assert.throws(() => m.finalizePrint(96_100), refused(ERR.REPORT_WINDOW_OPEN));
  m.setTime(96_419);
  assert.throws(() => m.finalizePrint(96_200), refused(ERR.REPORT_WINDOW_OPEN));
  // Two reports 5% apart: exactly the spread allowed.
  assert.equal(m.finalizePrint(96_000), true);
  assert.equal(m.getPrint(96_000)!.price, 2_050_000);
  assert.throws(() => m.finalizePrint(96_000), refused(ERR.DECIDED));
  // One unit further apart: no print, for good.
  assert.equal(m.finalizePrint(96_100), false);
  assert.deepEqual(m.events.at(-1), { event: "no_print", data: { bucket: 96_100, reports: 2 } });
  assert.deepEqual(m.getPrint(96_100)!.state, "NoPrint");
  assert.equal(m.getPrint(96_100)!.price, null);
  m.setTime(96_420);
  // One report is below quorum.
  assert.equal(m.finalizePrint(96_200), false);
  assert.deepEqual(m.getPrints(0, 10).map((p) => p.bucket), [96_000]);
  assert.deepEqual(m.getLastPrint(), { bucket: 96_000, price: 2_050_000 });
});

test("a report decides up to four earlier closed buckets, oldest first", () => {
  // Windows of 1100 s, so six buckets can be reported before any window closes.
  const m = new Market({ ...PARAMS, reportGraceSecs: 1000 }, 96_500);
  for (let i = 0; i < 6; i++) {
    m.report("r0", 96_000 + 100 * i, 2_000_000 + i, BUNDLE);
    m.report("r1", 96_000 + 100 * i, 2_000_000 + i, BUNDLE);
  }
  // At 97_700 the windows of buckets 96_000 to 96_500 have all closed.
  m.setTime(97_700);
  assert.deepEqual(m.getPendingPrints(), [96_000, 96_100, 96_200, 96_300, 96_400, 96_500]);
  const before = m.events.length;
  assert.equal(m.report("r0", 97_700, 2_000_000, BUNDLE), false);
  assert.deepEqual(
    m.events.slice(before).map((e) => [e.event, "bucket" in e.data ? e.data.bucket : null]),
    [["report", 97_700], ["print", 96_000], ["print", 96_100], ["print", 96_200], ["print", 96_300]],
  );
  assert.deepEqual(m.getPendingPrints(), [96_400, 96_500, 97_700]);
  assert.deepEqual(m.getLastPrint(), { bucket: 96_300, price: 2_000_003 });
});

test("prune_print deletes a decided bucket two periods later, keeping the last print and accumulators", () => {
  const m = new Market(PARAMS, 100_000);
  print(m, 100_000, 2_000_000);
  m.setTime(100_100);
  m.report("r0", 100_100, 2_000_000, BUNDLE);
  m.setTime(107_199);
  assert.throws(() => m.prunePrint(100_000), refused(ERR.TOO_EARLY_TO_PRUNE));
  assert.throws(() => m.prunePrint(100_100), refused(ERR.NOT_DECIDED));
  assert.throws(() => m.prunePrint(100_200), refused(ERR.NO_REPORTS));
  m.setTime(107_200);
  m.prunePrint(100_000);
  assert.deepEqual(m.events.at(-1), { event: "prune_print", data: { bucket: 100_000 } });
  assert.equal(m.getPrint(100_000), null);
  assert.deepEqual(m.getLastPrint(), { bucket: 100_000, price: 2_000_000 });
  assert.deepEqual(m.getAccumulator(0), { sum: 2_000_000n, count: 1 });
  assert.throws(() => m.prunePrint(100_000), refused(ERR.NO_REPORTS));
});

test("delivery prints feed the accumulator of their series", () => {
  const m = new Market(PARAMS, 100_000);
  print(m, 100_000, 2_000_000);
  print(m, 103_500, 2_000_001);
  print(m, 103_600, 2_050_000);
  assert.deepEqual(m.getAccumulator(0), { sum: 4_000_001n, count: 2 });
  assert.deepEqual(m.getAccumulator(1), { sum: 2_050_000n, count: 1 });
});

test("settle decides the delivery window's open buckets, and a refused settle decides nothing", () => {
  for (const buckets of [2, 3]) {
    const m = setup();
    m.mint("alice", 0, 1);
    // Two of three reporters per bucket, all before any window closes, never finalized.
    m.setTime(100_200);
    for (let i = 0; i < buckets; i++) {
      const bucket = 100_000 + 100 * i;
      m.report("r0", bucket, 2_100_000, BUNDLE);
      m.report("r1", bucket, 2_100_000, BUNDLE);
    }
    m.setTime(103_720);
    const pending = m.getPendingPrints();
    assert.equal(pending.length, buckets);
    if (buckets === 2) {
      const events = m.events.length;
      assert.throws(() => m.settle(0), refused(ERR.NOT_ENOUGH_PRINTS));
      assert.deepEqual([m.getPendingPrints(), m.events.length], [pending, events]);
      continue;
    }
    const s = m.settle(0);
    assert.deepEqual([s.fixing, s.prints, s.void], [2_100_000, 3, false]);
    assert.deepEqual(m.getPendingPrints(), []);
    assert.deepEqual(m.events.slice(-4).map((e) => e.event), ["print", "print", "print", "settle"]);
  }
});

test("a void series without trades splits the band, whatever prints it had", () => {
  for (const prints of [0, 2]) {
    const m = setup();
    m.mint("alice", 0, 2);
    m.mint("bob", 0, 1);
    for (let i = 0; i < prints; i++) print(m, 100_000 + 300 * i, 2_050_001 + i);
    m.setTime(103_720);
    assert.throws(() => m.settle(0), refused(ERR.NOT_ENOUGH_PRINTS));
    m.setTime(105_999);
    assert.throws(() => m.settle(0), refused(ERR.NOT_ENOUGH_PRINTS));
    m.setTime(106_000);
    const s = m.settle(0);
    assert.deepEqual([s.void, s.fixing, s.prints, s.longPayout, s.shortPayout], [true, 2_000_000, prints, 200_000, 200_000]);
    assert.equal(m.redeem(0, "alice"), 800_000n);
    assert.equal(m.redeem(0, "bob"), 400_000n);
  }
});

test("a void series splits the band even when its auctions traded", () => {
  const m = setup();
  const trade = (round: number, size: number, long: number, short: number, buyer: number) => {
    m.setTime(96_400 + 180 * round);
    const a = sealedCommit(m, "alice", 0, round, "Long", size, long, BigInt(size * long));
    const b = sealedCommit(m, "bob", 0, round, "Short", size, short, BigInt(size * (400_000 - short)));
    m.setTime(96_520 + 180 * round);
    revealSecret(m, a);
    revealSecret(m, b);
    m.setTime(96_580 + 180 * round);
    assert.equal(m.clear(0, round).price, buyer);
  };
  trade(0, 10, 250_000, 150_000, 200_000);
  trade(1, 5, 300_000, 300_000, 300_000);
  m.mint("carol", 0, 1);
  assert.deepEqual([m.getSeries(0)!.tradedUnits, m.getSeries(0)!.tradedValue], [15, 3_500_000n]);
  // Two prints are not enough; the void rule ignores them and the trades alike.
  for (const bucket of [100_000, 100_100]) print(m, bucket, 3_000_000);
  m.setTime(106_000);
  const s = m.settle(0);
  assert.deepEqual([s.void, s.fixing, s.longPayout, s.shortPayout], [true, 2_000_000, 200_000, 200_000]);
  assert.deepEqual([m.getSeries(0)!.tradedUnits, m.getSeries(0)!.tradedValue], [15, 3_500_000n]);
  assert.equal(m.redeem(0, "alice"), 15n * 200_000n);
  assert.equal(m.redeem(0, "carol"), 400_000n);
});

test("settle waits for pending rounds, and a forfeit pays nobody", () => {
  const m = setup();
  m.mint("alice", 0, 3);
  sealedCommit(m, "bob", 0, 0, "Long", 1, 1000, 1_000_005n);
  m.setTime(106_000);
  assert.throws(() => m.settle(0), refused(ERR.PENDING_ROUNDS));
  assert.deepEqual(m.getSeries(0)!.pendingRounds, [0]);
  // 10% of 1_000_005, rounded down, is burned.
  assert.equal(m.clear(0, 0).forfeited, 100_000n);
  m.settle(0);
  assert.equal(m.redeem(0, "alice"), 3n * 400_000n);
  assert.deepEqual(m.getTotals(), { free: 29_900_000n, locked: 0n, setsBacking: 0n, unredeemed: 0n, burned: 100_000n });
});

test("unknown and unsettled series", () => {
  const m = setup();
  assert.throws(() => m.settle(7), refused(ERR.UNKNOWN_SERIES));
  assert.throws(() => m.redeem(7, "alice"), refused(ERR.UNKNOWN_SERIES));
  assert.throws(() => m.pruneResult(7, 0), refused(ERR.UNKNOWN_SERIES));
  assert.throws(() => m.merge("alice", 7, 1), refused(ERR.UNKNOWN_SERIES));
  m.mint("alice", 0, 1);
  assert.throws(() => m.redeem(0, "alice"), refused(ERR.NOT_SETTLED));
  assert.throws(() => m.pruneResult(0, 0), refused(ERR.NOT_SETTLED));
});

test("mint, transfer and merge", () => {
  const m = setup();
  assert.throws(() => m.mint("alice", 0, 0), refused(ERR.ZERO_SETS));
  assert.throws(() => m.mint("alice", 0, 26), refused(ERR.BALANCE));
  m.mint("alice", 0, 3);
  assert.equal(m.getAccount("alice")!.balance, 8_800_000n);
  m.transferPosition("alice", 0, "bob", 1, 0);
  assert.throws(() => m.transferPosition("alice", 0, "nobody", 1, 0), refused(ERR.NOT_REGISTERED));
  assert.throws(() => m.transferPosition("alice", 0, "alice", 1, 0), refused(ERR.SELF_TRANSFER));
  assert.throws(() => m.transferPosition("alice", 0, "bob", 3, 0), refused(ERR.POSITION_TOO_SMALL));
  assert.throws(() => m.transferPosition("alice", 0, "bob", 0, 0), refused(ERR.NOTHING_TO_TRANSFER));
  assert.throws(() => m.merge("alice", 0, 3), refused(ERR.POSITION_TOO_SMALL));
  assert.throws(() => m.merge("alice", 0, 0), refused(ERR.ZERO_SETS));
  m.merge("alice", 0, 2);
  assert.deepEqual(m.getPosition(0, "alice"), { long: 0, short: 1 });
  assert.deepEqual(m.getPosition(0, "bob"), { long: 1, short: 0 });
  assert.equal(m.getSeries(0)!.openSets, 1);
  assert.equal(m.getAccount("alice")!.balance, 9_600_000n);
  assert.deepEqual(m.events.at(-1), { event: "merge", data: { series: 0, accountId: "alice", sets: 2 } });
  m.setTime(103_000);
  assert.throws(() => m.mint("alice", 0, 1), refused(ERR.WINDOW_CLOSED));
});

test("mint stops short of what the auctions could still add to 2^53 - 1", () => {
  const m = setup();
  m.deposit("alice", 10n ** 25n);
  // max_order_size 100 * max_commits 4 * 20 rounds = 8000 units the auctions could add.
  const most = 2 ** 53 - 1 - 8000;
  assert.throws(() => m.mint("alice", 0, most + 1), refused(ERR.TOO_MANY_SETS));
  m.mint("alice", 0, most - 1);
  assert.throws(() => m.mint("alice", 0, 2), refused(ERR.TOO_MANY_SETS));
  m.mint("alice", 0, 1);
  assert.equal(m.getSeries(0)!.openSets, most);
});

test("accounts, deposits and withdrawals", () => {
  const m = new Market(PARAMS, 0);
  assert.equal(m.deposit("alice", 5n), 5n);
  m.register("alice");
  assert.throws(() => m.register("alice"), refused(ERR.REGISTERED));
  assert.equal(m.deposit("alice", 5n), 0n);
  assert.throws(() => m.deposit("alice", 0n), refused(ERR.ZERO_AMOUNT));
  assert.throws(() => m.withdraw("alice", 6n), refused(ERR.BALANCE));
  assert.throws(() => m.withdraw("alice", 0n), refused(ERR.ZERO_AMOUNT));
  assert.throws(() => m.withdraw("bob", 1n), refused(ERR.NOT_REGISTERED));
  m.withdraw("alice", 2n, { transferFails: true });
  assert.equal(m.getAccount("alice")!.balance, 5n);
  m.withdraw("alice", 2n);
  assert.deepEqual(m.getAccount("alice"), { balance: 3n, guard: null, maxRoundLock: null });
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

test("params are validated with the contract's texts", () => {
  const bad: [Partial<Params>, string][] = [
    [{ commitSecs: 0 }, ERR.DURATION],
    [{ voidAfterSecs: 0 }, ERR.DURATION],
    [{ tick: 0 }, ERR.TICK],
    [{ bandBps: 10_000 }, ERR.BAND_BPS],
    [{ bandBps: 0 }, ERR.BAND_BPS],
    [{ forfeitBps: 10_001 }, ERR.FORFEIT_BPS],
    [{ maxCommits: 129 }, ERR.MAX_COMMITS],
    [{ maxOrderSize: 0 }, ERR.MAX_ORDER_SIZE],
    [{ cutoffSecs: 3600 }, ERR.CUTOFF],
    [{ minPrints: 0 }, ERR.MIN_PRINTS],
    [{ minPrints: 37 }, ERR.MAX_PRINTS],
    [{ voidAfterSecs: 119 }, ERR.VOID_AFTER],
    [{ reportGraceSecs: 3601, voidAfterSecs: 3601 }, ERR.GRACE],
    [{ maxSpreadBps: 0 }, ERR.MAX_SPREAD_BPS],
    [{ maxSpreadBps: 10_001 }, ERR.MAX_SPREAD_BPS],
    // 225 s rounds give 16 rounds; 2^41 * 128 * 16 reaches 2^52 exactly.
    [{ maxCommits: 128, commitSecs: 165, maxOrderSize: 2 ** 41 }, ERR.CAPACITY],
    [{ t0: 100_050 }, ERR.BUCKET_GRID],
    [{ periodSecs: 3650, leadSecs: 3650 }, ERR.BUCKET_GRID],
    [{ usdc: "USDC" }, ERR.BAD_USDC],
    [{ reporters: ["ra", "ra"], quorum: 1 }, ERR.REPORTERS],
    [{ reporters: ["R0"], quorum: 1 }, ERR.REPORTERS],
    [{ reporters: [], quorum: 1 }, ERR.REPORTERS],
    [{ quorum: 4 }, ERR.QUORUM],
    [{ quorum: 0 }, ERR.QUORUM],
    [{ quorum: 1 }, ERR.QUORUM_MAJORITY],
    [{ reporters: ["ra", "rb", "rc", "rd"], quorum: 2 }, ERR.QUORUM_MAJORITY],
  ];
  for (const [change, text] of bad) assert.throws(() => new Market({ ...PARAMS, ...change }), refused(text), JSON.stringify(change));
  new Market({ ...PARAMS, reportGraceSecs: 3600, voidAfterSecs: 3600 });
  // Several faults at once are refused in the contract's order.
  assert.throws(() => new Market({ ...PARAMS, reportGraceSecs: 3601, maxSpreadBps: 0 }), refused(ERR.VOID_AFTER));
  assert.throws(() => new Market({ ...PARAMS, reportGraceSecs: 3601, voidAfterSecs: 3601, maxSpreadBps: 0 }), refused(ERR.GRACE));
  new Market({ ...PARAMS, minPrints: 36, voidAfterSecs: 120, maxSpreadBps: 10_000, maxCommits: 128, commitSecs: 165, maxOrderSize: 2 ** 41 - 1 });
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

test("account ids and deposits to bad ids", () => {
  for (const ok of ["ab", "alice", "alice.near", "a-b_c.d1", "0x", "a".repeat(64)]) assert.ok(isAccountId(ok), ok);
  for (const bad of ["", "a", "Alice", "a..b", ".a", "a.", "a-", "-a", "a b", "a@b", "a".repeat(65)]) {
    assert.ok(!isAccountId(bad), bad);
  }
  const m = setup();
  assert.throws(() => m.register("Bad"), refused(ERR.BAD_ACCOUNT_ID));
  assert.equal(m.deposit("a..b", 5n), 5n);
  assert.equal(m.deposit("A", 5n), 5n);
});

test("status lists at most 32 series", () => {
  // A lead of 40 periods puts series 1 to 40 in auction at t0.
  const m = new Market({ ...PARAMS, t0: 200_000, leadSecs: 40 * 3600 }, 200_000);
  const live = m.getStatus().live.map((l) => l.series);
  assert.equal(live.length, 32);
  assert.deepEqual([live[0], live.at(-1)], [1, 32]);
});
