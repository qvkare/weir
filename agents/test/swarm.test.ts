// The swarm on ModelWeir, ticked like a scheduler would: every minute through two full
// series, then with a gap that skips a reveal window.
import assert from "node:assert/strict";
import { test } from "node:test";
import { auctionOpen, commitHash, deliveryEnd, Market, sha256Hex } from "@weir/engine";
import { ModelWeir, paramsFromWire, type WeirPort } from "@weir/chain";
import { PRESETS } from "../src/presets.ts";
import { mulberry32 } from "../src/random.ts";
import { buyer, maker, noise, seller } from "../src/strategies/mod.ts";
import { MemoryStore, newestSeries, orderKey, rebuildOrder, saltFor, tick, timeParams, type LogEntry, type OrderStore, type StoredOrder, type SwarmContext } from "../src/swarm.ts";

const params = PRESETS.fast;
const tp = timeParams(params);

function setup(): { model: ModelWeir; store: MemoryStore; ctx: SwarmContext<WeirPort, OrderStore>; report: (t: number) => Promise<void> } {
  const model = new ModelWeir(new Market(paramsFromWire(params), auctionOpen(tp, 0) - 300), "keeper");
  const agents = [
    buyer("buyer-1", { need: 40, premiumBps: 400 }),
    buyer("buyer-2", { need: 30, premiumBps: 600 }),
    seller("seller-1", { capacity: 80, premiumBps: 300 }),
    maker("maker-1", { spreadBps: 400, shareBps: 1000, maxSize: 20 }),
    noise("noise-1", { viewBps: 1000, minSize: 3, maxSize: 8 }),
  ];
  const ports: Record<string, WeirPort> = {};
  for (const a of agents) {
    ports[a.id] = model.as(a.id);
    model.as(a.id).sync.change("register", {});
    model.as(a.id).sync.change("deposit", { amount: "200000000" });
  }
  const walk = mulberry32(3);
  let price = 2_000_000;
  const report = async (t: number) => {
    if (t % params.print_interval_secs !== 0) return;
    price = Math.round(price * (1 + (walk() - 0.5) * 0.02));
    for (const r of params.reporters) await model.as(r).report({ bucket: t, price, bundle: sha256Hex(`${t}`) });
  };
  const store = new MemoryStore();
  return { model, store, ctx: { market: "weir.test", store: store.async, agents, ports, secret: "test secret", keeper: model }, report };
}

const forfeits = (logs: LogEntry[]) => logs.filter((e) => e.action === "forfeit");

test("an order lost from the store is found again from its lock and hash", () => {
  const r = mulberry32(8);
  for (let i = 0; i < 500; i++) {
    const band = 2000 * (2 + Math.floor(r() * 800));
    const side = r() < 0.5 ? ("Long" as const) : ("Short" as const);
    const o = { side, size: 1 + Math.floor(r() * 500), price: 1000 * (1 + Math.floor(r() * (band / 1000 - 1))) };
    const at = { series: Math.floor(r() * 5), round: Math.floor(r() * 168), owner: `agent-${i % 7}` };
    const n = Math.floor(r() * 8);
    const salt = saltFor("s3cret", at.series, at.round, at.owner, n);
    const hash = commitHash({ series: at.series, round: at.round, accountId: at.owner, ...o, salt });
    const lock = (BigInt(o.size) * BigInt(side === "Long" ? o.price : band - o.price)).toString();
    assert.deepEqual(rebuildOrder("s3cret", params, band, { ...at, lock, hash }), { ...o, salt, hash, seq: null });
  }
  assert.equal(rebuildOrder("other secret", params, 800_000, { series: 0, round: 0, owner: "a", lock: "400000", hash: "0".repeat(64) }), null);
});

test("ticked every 60 s through two full series: no forfeits, every round cleared, both settled, every position redeemed", async () => {
  const { model, ctx, report } = setup();
  const logs: LogEntry[] = [];
  const end = deliveryEnd(tp, 1) + params.report_grace_secs + 600;
  let maxCalls = 0;
  for (let t = model.now(); t <= end; t += 60) {
    model.setTime(t);
    await report(t);
    // Trade series 0 and 1 only, then just finish them.
    const log = await tick({ ...ctx, trade: (newestSeries(tp, t) ?? 0) <= 1 });
    maxCalls = Math.max(maxCalls, log.calls);
    logs.push(...log.entries);
  }
  assert.deepEqual(forfeits(logs), []);
  assert.deepEqual(logs.filter((e) => e.status === "failed"), []);
  const commits = logs.filter((e) => e.action === "commit" && e.status === "done").length;
  const reveals = logs.filter((e) => e.action === "reveal" && e.status === "done").length;
  assert.ok(commits > 100, `${commits} commits`);
  assert.equal(reveals, commits);
  for (const series of [0, 1]) {
    const s = await model.get_series({ series });
    assert.ok(s?.settlement, `series ${series} settled`);
    assert.equal(s.pending_rounds, 0);
    const results = await model.get_results({ series, from_round: 0, limit: 100 });
    assert.equal(results.length, 12, `all 12 rounds of series ${series} cleared`);
    assert.ok(results.filter(([, r]) => r.volume > 0).length >= 10);
    for (const a of ctx.agents) assert.deepEqual(await model.get_position({ series, account_id: a.id }), { long: 0, short: 0 });
  }
  // Every lock is exactly what its order requires: size x price for LONG, size x (band - price) for SHORT.
  const locks = new Map<string, bigint>();
  let checked = 0;
  for (const e of model.market.events) {
    if (e.event === "commit") locks.set(`${e.data.series}/${e.data.round}/${e.data.seq}`, e.data.lock);
    if (e.event === "reveal") {
      const band = model.market.getSeries(e.data.series)!.band;
      const need = BigInt(e.data.size) * BigInt(e.data.side === "Long" ? e.data.price : band - e.data.price);
      assert.equal(locks.get(`${e.data.series}/${e.data.round}/${e.data.seq}`), need);
      checked++;
    }
  }
  assert.equal(checked, commits);
  const totals = await model.get_totals({});
  assert.deepEqual([totals.locked, totals.sets_backing, totals.unredeemed], ["0", "0", "0"]);
  assert.equal(BigInt(totals.free) + BigInt(totals.pools), 5n * 200_000_000n);
  assert.ok(maxCalls <= 200, `a tick made ${maxCalls} calls`);
});

test("a tick is idempotent: calling it again at the same moment does nothing new", async () => {
  const { model, ctx, report } = setup();
  for (let t = model.now(); t <= auctionOpen(tp, 0) + 30; t += 60) {
    model.setTime(t);
    await report(t);
    await tick(ctx);
  }
  const before = model.market.events.length;
  const again = await tick(ctx);
  assert.equal(model.market.events.length, before);
  assert.deepEqual(again.entries, []);
});

test("ticks with a gap over a reveal window: the forfeit is in the log and in the bonus pool", async () => {
  const { model, ctx, report } = setup();
  const open = auctionOpen(tp, 0);
  for (let t = model.now(); t <= open + 60; t += 60) {
    model.setTime(t);
    await report(t);
    await tick(ctx);
  }
  const round0 = await model.get_round({ series: 0, round: 0 });
  assert.ok(round0 && round0.commits.length >= 5, "every agent committed");
  // The scheduler stops for six minutes: round 0's reveal window (180 s to 300 s) passes unseen.
  model.setTime(open + 420);
  const log = await tick(ctx);
  const lost = forfeits(log.entries);
  assert.equal(lost.length, round0.commits.length);
  const expected = round0.commits.reduce((sum, c) => sum + (BigInt(c.lock) * BigInt(params.forfeit_bps)) / 10_000n, 0n);
  assert.equal(lost.reduce((sum, e) => sum + BigInt((e.data as { forfeit: string }).forfeit), 0n), expected);
  assert.ok(log.entries.some((e) => e.action === "clear" && e.round === 0 && e.status === "done"));
  const series = await model.get_series({ series: 0 });
  assert.equal(series!.bonus_pool, expected.toString());
  assert.ok(expected > 0n);
});

async function commitThenWipe(recover: boolean) {
  const { model, store, ctx, report } = setup();
  const open = auctionOpen(tp, 0);
  for (let t = model.now(); t <= open + 60; t += 60) {
    model.setTime(t);
    await report(t);
    await tick({ ...ctx, recover });
  }
  const book = (await model.get_round({ series: 0, round: 0 }))!;
  const stored = JSON.parse((await ctx.store.get(orderKey("weir.test", 0, 0, "buyer-1", 0)))!) as StoredOrder;
  const mine = book.commits.find((c) => c.owner === "buyer-1")!;
  assert.equal(stored.hash, mine.hash);
  assert.equal(stored.seq, mine.seq);
  store.clear();
  const logs: LogEntry[] = [];
  for (let t = open + 180; t <= open + 300; t += 60) {
    model.setTime(t);
    await report(t);
    logs.push(...(await tick({ ...ctx, recover, trade: false })).entries);
  }
  return { model, logs, commits: book.commits.length };
}

test("a store wiped between commit and reveal: without recovery, each commit is logged and forfeited", async () => {
  const { model, logs, commits } = await commitThenWipe(false);
  const cannot = logs.filter((e) => e.text.startsWith("cannot reveal: order not in store"));
  // Logged at every tick of the reveal window (two here), for every commit.
  assert.equal(new Set(cannot.map((e) => (e.data as { seq: number }).seq)).size, commits);
  assert.equal(forfeits(logs).length, commits);
  assert.ok(BigInt((await model.get_series({ series: 0 }))!.bonus_pool) > 0n);
});

test("a store wiped between commit and reveal: with recovery (the default), every order is rebuilt and revealed", async () => {
  const { logs, commits } = await commitThenWipe(true);
  const rebuilt = logs.filter((e) => e.action === "reveal" && e.status === "done" && e.text.includes("rebuilt"));
  assert.equal(rebuilt.length, commits);
  assert.deepEqual(forfeits(logs), []);
});

test("a small budget stops the tick and says so; the next tick picks up the rest", async () => {
  const { model, ctx, report } = setup();
  const open = auctionOpen(tp, 0);
  model.setTime(open - 300);
  await report(open - 300);
  model.setTime(open);
  const first = await tick({ ...ctx, budget: 12 });
  assert.ok(first.calls <= 12);
  assert.equal(first.entries.at(-1)!.action, "budget");
  const committed = new Set((await model.get_round({ series: 0, round: 0 }))?.commits.map((c) => c.owner));
  assert.ok(committed.size < 5);
  await tick(ctx);
  assert.equal((await model.get_round({ series: 0, round: 0 }))!.commits.length >= 5, true);
});
