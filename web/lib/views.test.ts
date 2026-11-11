import assert from "node:assert/strict";
import { test } from "node:test";
import type { WireParams, WireResult, WireRound } from "@weir/engine";
import { average, bookRows, bookTotals, fillRows, lastResult, lastTraded, median, nextOpening, printView, stepOrdersFromResult, stepOrdersFromRound, summarize, timesOf, totalsSum } from "./views.ts";

const round: WireRound = {
  next_seq: 3,
  commits: [
    { seq: 2, owner: "c", hash: "c".repeat(64), lock: "3000000", fee: "20000", state: "Void", order: { side: "Long", size: 3, price: 10_000 } },
    { seq: 0, owner: "a", hash: "a".repeat(64), lock: "1000000", fee: "20000", state: "Committed", order: null },
    { seq: 1, owner: "b", hash: "b".repeat(64), lock: "2000000", fee: "20000", state: "Revealed", order: { side: "Short", size: 5, price: 20_000 } },
  ],
};

const result: WireResult = {
  price: 300_000,
  volume: 15,
  long_size: 20,
  short_size: 25,
  orders: 4,
  commits: 6,
  forfeited: "50000",
  fees: "120000",
  cleared_at: 1000,
  fills: [
    { seq: 1, owner: "b", side: "Long", size: 10, price: 400_000, filled: 5 },
    { seq: 0, owner: "a", side: "Long", size: 10, price: 600_000, filled: 10 },
    { seq: 2, owner: "c", side: "Short", size: 15, price: 300_000, filled: 15 },
  ],
};

test("the sealed book in seq order; sealed rows hide side, size and price", () => {
  const rows = bookRows(round);
  assert.deepEqual(rows.map((r) => r.seq), [0, 1, 2]);
  assert.equal(rows[0]!.side, null);
  assert.equal(rows[0]!.price, null);
  assert.equal(rows[1]!.side, "Short");
  const t = bookTotals(rows);
  assert.deepEqual(t, { commits: 3, revealed: 1, void: 1, sealed: 1, locked: "6000000", fees: "60000" });
});

test("an empty or cleared round has no rows", () => {
  assert.deepEqual(bookRows(null), []);
  assert.deepEqual(bookTotals([]), { commits: 0, revealed: 0, void: 0, sealed: 0, locked: "0", fees: "0" });
  assert.deepEqual(stepOrdersFromRound(null), []);
});

test("only revealed, non-void commits reach the chart before clearing", () => {
  assert.deepEqual(stepOrdersFromRound(round).map((o) => o.seq), [1]);
});

test("fills: LONG pays p*, SHORT pays band - p*, part fills marked; a result lists only filled orders", () => {
  const rows = fillRows(result, 1_000_000);
  assert.deepEqual(rows.map((r) => r.seq), [0, 1, 2]);
  assert.equal(rows[0]!.paid, String(10 * 300_000));
  assert.equal(rows[1]!.part, true);
  assert.equal(rows[1]!.paid, String(5 * 300_000));
  assert.equal(rows[2]!.paid, String(15 * 700_000));
  assert.ok(rows.every((r) => r.filled > 0));
  assert.equal(stepOrdersFromResult(result).length, 3);
});

test("no clearing price: nothing paid, no forward", () => {
  const none = { ...result, price: null, volume: 0, fills: result.fills.map((f) => ({ ...f, filled: 0 })) };
  assert.ok(fillRows(none, 1_000_000).every((r) => r.paid === "0"));
  const s = summarize(none, 2_000_000);
  assert.equal(s.price, null);
  assert.equal(s.forward, null);
  assert.equal(s.outside, 2);
  assert.equal(fillRows(null, 1).length, 0);
});

test("summary: forward is floor + p*", () => {
  assert.equal(summarize(result, 2_000_000).forward, 2_300_000);
  assert.equal(summarize(result, null).forward, null);
});

test("last result and last traded round", () => {
  const none = { ...result, price: null };
  assert.equal(lastResult([]), null);
  assert.equal(lastResult(null), null);
  assert.equal(lastResult([[3, result], [7, none], [5, result]])!.round, 7);
  assert.equal(lastTraded([[3, result], [7, none], [5, result]])!.round, 5);
  assert.equal(lastTraded([[7, none]]), null);
});

test("median as the contract takes it", () => {
  assert.equal(median([]), null);
  assert.equal(median([3]), 3);
  assert.equal(median([1, 4]), 2);
  assert.equal(median([5, 1, 3]), 3);
  const pv = printView({ bucket: 1, price: 3, state: "Final", reports: [{ reporter: "z", price: 5, bundle: "x" }, { reporter: "a", price: 1, bundle: "y" }, { reporter: "m", price: 3, bundle: "w" }] })!;
  assert.deepEqual(pv.middle, ["m"]);
  assert.equal(printView(null), null);
});

const params = { t0: 1000, period_secs: 100, lead_secs: 110, cutoff_secs: 10, commit_secs: 6, reveal_secs: 4, report_grace_secs: 5 } as WireParams;

test("series times follow SPEC 4", () => {
  const t = timesOf(2, params);
  // SPEC 0.2: auctions close cutoff_secs before delivery starts.
  assert.deepEqual(t, { series: 2, auctionOpen: 1090, auctionClose: 1190, deliveryStart: 1200, deliveryEnd: 1300, settleAt: 1305, commitSecs: 6, revealSecs: 4 });
  assert.deepEqual(nextOpening(params, 1150), { series: 3, at: 1190 });
});

test("averages and totals", () => {
  assert.equal(average({ sum: "10", count: 3 }), 3);
  assert.equal(average({ sum: "0", count: 0 }), null);
  assert.equal(average(null), null);
  assert.equal(totalsSum({ free: "1", locked: "2", sets_backing: "3", unredeemed: "4", burned: "5" }), 15n);
  assert.equal(totalsSum({ free: "x", locked: "2", sets_backing: "3", unredeemed: "4", burned: "5" }), null);
});
