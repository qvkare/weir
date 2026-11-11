import assert from "node:assert/strict";
import { test } from "node:test";
import { callChange, callView, commitHash, eventLog, Market, wireEvent, type Side } from "../src/mod.ts";
import { BUNDLE, PARAMS, SALT } from "./fixtures.ts";

const USDC = PARAMS.usdc;

/** Commits through the wire and returns the seq. */
function commit(m: Market, owner: string, side: Side, size: number, price: number, lock: string): number {
  const hash = callView(m, "commit_hash", { series: 0, round: 0, account_id: owner, side, size, price, salt: SALT });
  return callChange(m, owner, "commit", { series: 0, hash, lock });
}

function printBucket(m: Market, bucket: number, price: number): void {
  m.setTime(Math.max(m.now, bucket));
  assert.equal(callChange(m, "r0", "report", { bucket, price, bundle: BUNDLE }), false);
  assert.equal(callChange(m, "r1", "report", { bucket, price, bundle: BUNDLE }), true);
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
  assert.throws(() => callChange(m, "fake.near", "deposit", { sender_id: "alice", amount: "1", msg: "" }), /usdc/);
  assert.throws(() => callChange(m, USDC, "deposit", { sender_id: "alice", amount: "1e6", msg: "" }), /decimal string/);
  callChange(m, "alice", "set_guard", { guard: 300_000 });
  assert.deepEqual(view(m, "get_account", { account_id: "alice" }), { balance: "10000000", guard: 300_000 });
  callChange(m, "alice", "set_guard", {});
  assert.deepEqual(view(m, "get_account", { account_id: "alice" }), { balance: "10000000", guard: null });

  m.setTime(96_400);
  assert.deepEqual(view(m, "get_status", {}), {
    now: 96_400,
    live: [
      {
        series: 0,
        delivery_start: 100_000,
        delivery_end: 103_600,
        auction_open: 96_400,
        auction_close: 103_000,
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
      { seq: 0, owner: "alice", lock: "2500000", state: "Committed", order: null },
      { seq: 1, owner: "bob", lock: "2500000", state: "Committed", order: null },
      { seq: 2, owner: "bob", lock: "1000000", state: "Committed", order: null },
    ],
  });

  m.setTime(96_520);
  callChange(m, "alice", "reveal", { series: 0, round: 0, seq: 0, side: "Long", size: 10, price: 250_000, salt: SALT });
  callChange(m, "bob", "reveal", { series: 0, round: 0, seq: 1, side: "Short", size: 10, price: 150_000, salt: SALT });
  assert.deepEqual((view(m, "get_round", { series: 0, round: 0 }) as { commits: unknown[] }).commits[1], {
    seq: 1,
    owner: "bob",
    lock: "2500000",
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
    final: true,
    reports: [
      { reporter: "r0", price: 2_100_000, bundle: BUNDLE },
      { reporter: "r1", price: 2_100_000, bundle: BUNDLE },
    ],
  });
  assert.deepEqual(view(m, "get_print", { bucket: 100_100 }), delivered(100_100));
  assert.deepEqual(view(m, "get_prints", { from_bucket: 100_000, limit: 2 }), [delivered(100_000), delivered(100_100)]);
  assert.deepEqual(view(m, "get_accumulator", { series: 0 }), { sum: "6300000", count: 3 });
  assert.deepEqual(view(m, "get_accumulator", { series: 5 }), { sum: "0", count: 0 });
  m.setTime(100_300);
  callChange(m, "r2", "report", { bucket: 100_300, price: 2_100_000, bundle: BUNDLE });
  assert.deepEqual(view(m, "get_print", { bucket: 100_300 }), {
    bucket: 100_300,
    price: null,
    final: false,
    reports: [{ reporter: "r2", price: 2_100_000, bundle: BUNDLE }],
  });

  m.setTime(103_720);
  callChange(m, "anyone", "settle", { series: 0 });
  assert.deepEqual(view(m, "get_series", { series: 0 }), {
    series: 0,
    anchor: 2_000_000,
    floor: 1_800_000,
    band: 400_000,
    opened_at: 96_400,
    open_sets: 10,
    bonus_pool: "0",
    pending_rounds: 0,
    settlement: {
      fixing: 2_100_000,
      long_payout: 300_000,
      short_payout: 100_000,
      bonus_long: "5000",
      bonus_short: "5000",
      prints: 3,
      void: false,
      settled_at: 103_720,
    },
  });
  assert.equal(view(m, "get_series", { series: 1 }), null);
  assert.deepEqual(view(m, "get_totals", {}), {
    free: "15899999",
    locked: "0",
    sets_backing: "0",
    pools: "0",
    unredeemed: "4100000",
  });
  callChange(m, "alice", "redeem", { series: 0 });
  callChange(m, "alice", "redeem", { series: 0, account_id: "bob" });
  assert.throws(() => callChange(m, "bob", "redeem", { series: 0 }), { message: "nothing to redeem" });
  // alice: 10M - 2M - 1 + 9 * 305_000; bob: 10M - 2M - 100_000 + 305_000 + 10 * 105_000.
  assert.deepEqual(view(m, "get_account", { account_id: "alice" }), { balance: "10744999", guard: null });
  assert.deepEqual(view(m, "get_account", { account_id: "bob" }), { balance: "9255000", guard: null });
  assert.deepEqual(view(m, "get_totals", {}), {
    free: "19999999",
    locked: "0",
    sets_backing: "0",
    pools: "0",
    unredeemed: "0",
  });
  callChange(m, "anyone", "prune_result", { series: 0, round: 0 });
  assert.equal(view(m, "get_result", { series: 0, round: 0 }), null);

  const params = view(m, "get_params", {});
  assert.deepEqual(params, {
    usdc: "usdc.near",
    underlying: "H100-USD-HR",
    t0: 100_000,
    period_secs: 3600,
    lead_secs: 3600,
    cutoff_secs: 600,
    commit_secs: 120,
    reveal_secs: 60,
    band_bps: 1000,
    tick: 1000,
    print_interval_secs: 100,
    report_grace_secs: 120,
    max_move_bps: 500,
    min_prints: 3,
    void_after_secs: 2400,
    max_anchor_age_secs: 1800,
    forfeit_bps: 1000,
    min_lock: "1000",
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
  m.setTime(96_400);
  commit(m, "alice", "Long", 1, 1000, "1000");
  m.setTime(96_520);
  callChange(m, "alice", "reveal", { series: 0, round: 0, seq: 0, side: "Long", size: 1, price: 1000, salt: SALT });
  m.setTime(96_580);
  callChange(m, "x", "clear", { series: 0, round: 0 });

  const logs = m.events.map(eventLog);
  assert.deepEqual(logs, [
    `EVENT_JSON:{"standard":"weir","version":"1.0.0","event":"report","data":{"bucket":96000,"reporter":"r0","price":2000000,"bundle":"${BUNDLE}"}}`,
    `EVENT_JSON:{"standard":"weir","version":"1.0.0","event":"report","data":{"bucket":96000,"reporter":"r1","price":2000000,"bundle":"${BUNDLE}"}}`,
    `EVENT_JSON:{"standard":"weir","version":"1.0.0","event":"print","data":{"bucket":96000,"price":2000000,"reports":2}}`,
    `EVENT_JSON:{"standard":"weir","version":"1.0.0","event":"register","data":{"account_id":"alice"}}`,
    `EVENT_JSON:{"standard":"weir","version":"1.0.0","event":"deposit","data":{"account_id":"alice","amount":"5000000"}}`,
    `EVENT_JSON:{"standard":"weir","version":"1.0.0","event":"series_opened","data":{"series":0,"anchor":2000000,"floor":1800000,"band":400000}}`,
    `EVENT_JSON:{"standard":"weir","version":"1.0.0","event":"commit","data":{"series":0,"round":0,"seq":0,"account_id":"alice","lock":"1000"}}`,
    `EVENT_JSON:{"standard":"weir","version":"1.0.0","event":"reveal","data":{"series":0,"round":0,"seq":0,"account_id":"alice","side":"Long","size":1,"price":1000,"void":false}}`,
    `EVENT_JSON:{"standard":"weir","version":"1.0.0","event":"clear","data":{"series":0,"round":0,"price":null,"volume":0,"forfeited":"0"}}`,
  ]);
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
