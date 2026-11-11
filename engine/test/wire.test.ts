import assert from "node:assert/strict";
import { test } from "node:test";
import { callChange, callView, commitHash, ERR, eventLog, Market, wireEvent, type Params, type Side } from "../src/mod.ts";
import { BUNDLE, PARAMS as BASE, SALT } from "./fixtures.ts";

const PARAMS: Params = { ...BASE, commitFee: 1000n };
const USDC = PARAMS.usdc;

const hashOf = (owner: string, side: Side, size: number, price: number) =>
  commitHash({ series: 0, round: 0, accountId: owner, side, size, price, salt: SALT });

/** Commits through the wire and returns the seq. */
function commit(m: Market, owner: string, side: Side, size: number, price: number, lock: string): number {
  const hash = callView(m, "commit_hash", { series: 0, round: 0, account_id: owner, side, size, price, salt: SALT });
  return callChange(m, owner, "commit", { series: 0, hash, lock });
}

/** Every reporter reports `price`; the last report decides the bucket. */
function printBucket(m: Market, bucket: number, price: number): void {
  m.setTime(Math.max(m.now, bucket));
  assert.equal(callChange(m, "r0", "report", { bucket, price, bundle: BUNDLE }), false);
  assert.equal(callChange(m, "r1", "report", { bucket, price, bundle: BUNDLE }), false);
  assert.equal(callChange(m, "r2", "report", { bucket, price, bundle: BUNDLE }), true);
}

test("a scripted market through callChange, checked view by view", () => {
  const m = new Market(PARAMS, 96_000);
  const seen: unknown[] = [];
  const view: typeof callView = (market, method, args) => {
    const out = callView(market, method, args);
    seen.push(out);
    return out;
  };

  assert.equal(view(m, "get_last_print", {}), null);
  printBucket(m, 96_000, 2_000_000);
  assert.deepEqual(view(m, "get_last_print", {}), { bucket: 96_000, price: 2_000_000 });

  assert.equal(callChange(m, "alice", "register", {}), null);
  callChange(m, "anyone", "register", { account_id: "bob" });
  assert.equal(view(m, "get_account", { account_id: "carol" }), null);
  assert.equal(callChange(m, USDC, "deposit", { sender_id: "alice", amount: "10000000", msg: "" }), "0");
  assert.equal(callChange(m, USDC, "deposit", { sender_id: "carol", amount: "10000000", msg: "bob" }), "0");
  assert.equal(callChange(m, USDC, "deposit", { sender_id: "alice", amount: "7", msg: "zed" }), "7");
  assert.equal(callChange(m, USDC, "deposit", { sender_id: "alice", amount: "7", msg: "Not An Id" }), "7");
  assert.throws(() => callChange(m, "fake.near", "deposit", { sender_id: "alice", amount: "1", msg: "" }), {
    message: ERR.WRONG_TOKEN,
  });
  assert.throws(() => callChange(m, USDC, "deposit", { sender_id: "alice", amount: "1e6", msg: "" }), /decimal string/);
  assert.equal(callChange(m, "alice", "set_guard", { guard: 300_000, max_round_lock: "5000000" }), null);
  assert.deepEqual(view(m, "get_account", { account_id: "alice" }), {
    balance: "10000000",
    guard: 300_000,
    max_round_lock: "5000000",
  });
  callChange(m, "alice", "set_guard", {});
  assert.deepEqual(view(m, "get_account", { account_id: "alice" }), { balance: "10000000", guard: null, max_round_lock: null });

  m.setTime(96_400);
  assert.deepEqual(view(m, "get_status", {}), {
    now: 96_400,
    live: [
      {
        series: 0,
        delivery_start: 100_000,
        delivery_end: 103_600,
        auction_open: 96_400,
        auction_close: 100_000,
        round: 0,
        phase: "Commit",
        phase_ends_at: 96_520,
      },
    ],
  });
  assert.equal(commit(m, "alice", "Long", 10, 250_000, "2500000"), 0);
  assert.equal(commit(m, "bob", "Short", 10, 150_000, "2500000"), 1);
  assert.equal(commit(m, "bob", "Long", 1, 1000, "1000000"), 2);
  assert.deepEqual(view(m, "get_round", { series: 0, round: 0 }), {
    next_seq: 3,
    commits: [
      { seq: 0, owner: "alice", hash: hashOf("alice", "Long", 10, 250_000), lock: "2500000", fee: "1000", state: "Committed", order: null },
      { seq: 1, owner: "bob", hash: hashOf("bob", "Short", 10, 150_000), lock: "2500000", fee: "1000", state: "Committed", order: null },
      { seq: 2, owner: "bob", hash: hashOf("bob", "Long", 1, 1000), lock: "1000000", fee: "1000", state: "Committed", order: null },
    ],
  });
  assert.deepEqual(view(m, "get_series", { series: 0 }), {
    series: 0,
    anchor: 2_000_000,
    floor: 1_800_000,
    band: 400_000,
    opened_at: 96_400,
    open_sets: 0,
    pending_rounds: [0],
    settlement: null,
  });

  m.setTime(96_520);
  callChange(m, "alice", "reveal", { series: 0, round: 0, seq: 0, side: "Long", size: 10, price: 250_000, salt: SALT });
  callChange(m, "bob", "reveal", { series: 0, round: 0, seq: 1, side: "Short", size: 10, price: 150_000, salt: SALT });
  assert.deepEqual((view(m, "get_round", { series: 0, round: 0 }) as { commits: unknown[] }).commits[1], {
    seq: 1,
    owner: "bob",
    hash: hashOf("bob", "Short", 10, 150_000),
    lock: "2500000",
    fee: "1000",
    state: "Revealed",
    order: { side: "Short", size: 10, price: 150_000 },
  });

  m.setTime(96_580);
  assert.equal(callChange(m, "anyone", "clear", { series: 0, round: 0 }), null);
  const result = {
    price: 200_000,
    volume: 10,
    long_size: 10,
    short_size: 10,
    orders: 2,
    commits: 3,
    forfeited: "100000",
    fees: "3000",
    cleared_at: 96_580,
    fills: [
      { seq: 0, owner: "alice", side: "Long", size: 10, price: 250_000, filled: 10 },
      { seq: 1, owner: "bob", side: "Short", size: 10, price: 150_000, filled: 10 },
    ],
  };
  assert.equal(view(m, "get_round", { series: 0, round: 0 }), null);
  assert.deepEqual(view(m, "get_result", { series: 0, round: 0 }), result);
  assert.equal(view(m, "get_result", { series: 0, round: 1 }), null);
  assert.deepEqual(view(m, "get_results", { series: 0, from_round: 0, limit: 1 }), [[0, result]]);
  assert.deepEqual(view(m, "get_results", { series: 0, from_round: 1, limit: 100 }), []);

  callChange(m, "alice", "transfer_position", { series: 0, to: "bob", long: 1, short: 0 });
  assert.deepEqual(view(m, "get_position", { series: 0, account_id: "alice" }), { long: 9, short: 0 });
  assert.deepEqual(view(m, "get_position", { series: 0, account_id: "bob" }), { long: 1, short: 10 });
  assert.deepEqual(view(m, "get_position", { series: 0, account_id: "carol" }), { long: 0, short: 0 });
  callChange(m, "alice", "withdraw", { amount: "1" });

  for (const bucket of [100_000, 100_100, 100_200]) printBucket(m, bucket, 2_100_000);
  const delivered = (bucket: number) => ({
    bucket,
    price: 2_100_000,
    state: "Final",
    reports: ["r0", "r1", "r2"].map((reporter) => ({ reporter, price: 2_100_000, bundle: BUNDLE })),
  });
  assert.deepEqual(view(m, "get_print", { bucket: 100_100 }), delivered(100_100));
  assert.deepEqual(view(m, "get_prints", { from_bucket: 100_000, limit: 2 }), [delivered(100_000), delivered(100_100)]);
  assert.deepEqual(view(m, "get_accumulator", { series: 0 }), { sum: "6300000", count: 3 });
  assert.deepEqual(view(m, "get_accumulator", { series: 5 }), { sum: "0", count: 0 });
  m.setTime(100_300);
  assert.equal(callChange(m, "r2", "report", { bucket: 100_300, price: 2_100_000, bundle: BUNDLE }), false);
  assert.deepEqual(view(m, "get_print", { bucket: 100_300 }), {
    bucket: 100_300,
    price: null,
    state: "Open",
    reports: [{ reporter: "r2", price: 2_100_000, bundle: BUNDLE }],
  });
  assert.deepEqual(view(m, "get_pending_prints", {}), [100_300]);
  m.setTime(100_520);
  // One report is below quorum.
  assert.equal(callChange(m, "anyone", "finalize_print", { bucket: 100_300 }), false);
  assert.deepEqual(view(m, "get_print", { bucket: 100_300 }), {
    bucket: 100_300,
    price: null,
    state: "NoPrint",
    reports: [{ reporter: "r2", price: 2_100_000, bundle: BUNDLE }],
  });
  assert.deepEqual(view(m, "get_pending_prints", {}), []);

  m.setTime(103_720);
  callChange(m, "anyone", "settle", { series: 0 });
  assert.deepEqual(view(m, "get_series", { series: 0 }), {
    series: 0,
    anchor: 2_000_000,
    floor: 1_800_000,
    band: 400_000,
    opened_at: 96_400,
    open_sets: 10,
    pending_rounds: [],
    settlement: { fixing: 2_100_000, long_payout: 300_000, short_payout: 100_000, prints: 3, void: false, settled_at: 103_720 },
  });
  assert.equal(view(m, "get_series", { series: 1 }), null);
  // alice: 10M - 2.5M - 1000 fee + 0.5M back - 1 withdrawn; bob: 10M - 3.5M - 2000 + 0.5M + 0.9M.
  assert.deepEqual(view(m, "get_totals", {}), {
    free: "15896999",
    locked: "0",
    sets_backing: "0",
    unredeemed: "4000000",
    burned: "103000",
  });
  callChange(m, "alice", "redeem", { series: 0 });
  callChange(m, "alice", "redeem", { series: 0, account_id: "bob" });
  assert.throws(() => callChange(m, "bob", "redeem", { series: 0 }), { message: ERR.NO_POSITION });
  assert.deepEqual(view(m, "get_account", { account_id: "alice" }), { balance: "10698999", guard: null, max_round_lock: null });
  assert.deepEqual(view(m, "get_account", { account_id: "bob" }), { balance: "9198000", guard: null, max_round_lock: null });
  assert.deepEqual(view(m, "get_totals", {}), {
    free: "19896999",
    locked: "0",
    sets_backing: "0",
    unredeemed: "0",
    burned: "103000",
  });
  callChange(m, "anyone", "prune_result", { series: 0, round: 0 });
  assert.equal(view(m, "get_result", { series: 0, round: 0 }), null);
  m.setTime(100_000 + 2 * 3600);
  assert.equal(callChange(m, "anyone", "prune_print", { bucket: 100_000 }), null);
  assert.equal(view(m, "get_print", { bucket: 100_000 }), null);

  const params = view(m, "get_params", {});
  assert.deepEqual(params, {
    usdc: "usdc.near",
    underlying: "H100-USD-HR",
    t0: 100_000,
    period_secs: 3600,
    lead_secs: 3600,
    cutoff_secs: 0,
    commit_secs: 120,
    reveal_secs: 60,
    band_bps: 1000,
    tick: 1000,
    print_interval_secs: 100,
    report_grace_secs: 120,
    max_spread_bps: 500,
    min_prints: 3,
    void_after_secs: 2400,
    max_anchor_age_secs: 1800,
    forfeit_bps: 1000,
    min_lock: "1000",
    commit_fee: "1000",
    max_commits: 4,
    max_order_size: 100,
    reporters: ["r0", "r1", "r2"],
    quorum: 2,
  });
  assert.equal(
    view(m, "commit_hash", { series: 0, round: 0, account_id: "a", side: "Long", size: 1, price: 1000, salt: "0".repeat(32) }),
    commitHash({ series: 0, round: 0, accountId: "a", side: "Long", size: 1, price: 1000, salt: "0".repeat(32) }),
  );

  // No bigint reaches JSON (stringify would throw), and every view survives a round trip.
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), seen);
  const events = m.events.map(wireEvent);
  assert.deepEqual(JSON.parse(JSON.stringify(events)), events);
});

test("events in their NEP-297 form", () => {
  const m = new Market(PARAMS, 96_000);
  printBucket(m, 96_000, 2_000_000);
  callChange(m, "alice", "register", {});
  callChange(m, USDC, "deposit", { sender_id: "alice", amount: "5000000", msg: "" });
  callChange(m, "alice", "set_guard", { guard: 5, max_round_lock: "9000" });
  m.setTime(96_400);
  commit(m, "alice", "Long", 1, 1000, "1000");
  m.setTime(96_520);
  callChange(m, "alice", "reveal", { series: 0, round: 0, seq: 0, side: "Long", size: 1, price: 1000, salt: SALT });
  m.setTime(96_580);
  callChange(m, "x", "clear", { series: 0, round: 0 });
  m.setTime(96_600);
  callChange(m, "r0", "report", { bucket: 96_600, price: 1, bundle: BUNDLE });
  m.setTime(96_820);
  callChange(m, "x", "finalize_print", { bucket: 96_600 });

  const head = `EVENT_JSON:{"standard":"weir","version":"1.0.0","event":`;
  const report = (r: string) => `${head}"report","data":{"bucket":96000,"reporter":"${r}","price":2000000,"bundle":"${BUNDLE}"}}`;
  assert.deepEqual(m.events.map(eventLog), [
    report("r0"),
    report("r1"),
    report("r2"),
    `${head}"print","data":{"bucket":96000,"price":2000000,"reports":3}}`,
    `${head}"register","data":{"account_id":"alice"}}`,
    `${head}"deposit","data":{"account_id":"alice","amount":"5000000"}}`,
    `${head}"guard","data":{"account_id":"alice","guard":5,"max_round_lock":"9000"}}`,
    `${head}"series_opened","data":{"series":0,"anchor":2000000,"floor":1800000,"band":400000}}`,
    `${head}"commit","data":{"series":0,"round":0,"seq":0,"account_id":"alice","hash":"${hashOf("alice", "Long", 1, 1000)}","lock":"1000","fee":"1000"}}`,
    `${head}"reveal","data":{"series":0,"round":0,"seq":0,"account_id":"alice","side":"Long","size":1,"price":1000,"void":false}}`,
    `${head}"clear","data":{"series":0,"round":0,"price":null,"volume":0,"forfeited":"0","fees":"1000"}}`,
    `${head}"report","data":{"bucket":96600,"reporter":"r0","price":1,"bundle":"${BUNDLE}"}}`,
    `${head}"no_print","data":{"bucket":96600,"reports":1}}`,
  ]);
});

test("change methods return what section 12 says", () => {
  const m = new Market(PARAMS, 96_000);
  const results: unknown[] = [
    callChange(m, "r0", "report", { bucket: 96_000, price: 2_000_000, bundle: BUNDLE }),
    callChange(m, "alice", "register", {}),
    callChange(m, USDC, "deposit", { sender_id: "alice", amount: "5000000", msg: "" }),
    callChange(m, "alice", "withdraw", { amount: "1" }),
    callChange(m, "alice", "set_guard", {}),
  ];
  m.setTime(96_220);
  results.push(callChange(m, "x", "finalize_print", { bucket: 96_000 }));
  assert.deepEqual(results, [false, null, "0", null, null, false]);
});

test("get_results returns at most 100 rounds", () => {
  // 20 s rounds give series 0 well over 100 rounds; commit to each, then clear it unrevealed.
  const m = new Market({ ...PARAMS, commitSecs: 10, revealSecs: 10 }, 96_000);
  printBucket(m, 96_000, 2_000_000);
  callChange(m, "alice", "register", {});
  callChange(m, USDC, "deposit", { sender_id: "alice", amount: "1000000", msg: "" });
  for (let round = 0; round < 105; round++) {
    m.setTime(96_400 + round * 20);
    callChange(m, "alice", "commit", { series: 0, hash: "c".repeat(64), lock: "1000" });
    m.setTime(96_400 + round * 20 + 20);
    callChange(m, "alice", "clear", { series: 0, round });
  }
  const page = callView(m, "get_results", { series: 0, from_round: 3, limit: 500 });
  assert.equal(page.length, 100);
  assert.deepEqual([page[0]![0], page.at(-1)![0]], [3, 102]);
  assert.deepEqual(callView(m, "get_results", { series: 0, from_round: 100, limit: 10 }).map(([r]) => r), [100, 101, 102, 103, 104]);
});

test("unknown methods are rejected", () => {
  const m = new Market(PARAMS);
  assert.throws(() => callView(m, "get_nothing" as "get_totals", {}), /unknown view/);
  assert.throws(() => callChange(m, "a", "toString" as "settle", { series: 0 }), /unknown method/);
});
