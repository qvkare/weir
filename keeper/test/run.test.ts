// The keeper ticked once a minute on the model, as cron would: a full run, missed minutes,
// failing sources, a small budget, and two runs at once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryEnd, roundEnd, roundCount } from "@weir/engine";
import { PRIORITY_ORDER } from "../src/budget.ts";
import type { KeeperEntry, TickReport } from "../src/keeper.ts";
import { KEYS } from "../src/store.ts";
import { AGENTS, PARAMS, START, TOTAL_DEPOSIT, TP, world, type World } from "./harness.ts";

const HOUR = 3600;

async function runFor(w: World, from: number, to: number, extra = {}): Promise<TickReport[]> {
  const out: TickReport[] = [];
  for (let t = from; t <= to; t += 60) out.push(await w.at(t, extra));
  return out;
}

const all = (reports: TickReport[]): KeeperEntry[] => reports.flatMap((r) => r.entries);

async function totalsBalance(w: World): Promise<void> {
  const t = await w.model.get_totals({});
  const sum = BigInt(t.free) + BigInt(t.locked) + BigInt(t.sets_backing) + BigInt(t.pools) + BigInt(t.unredeemed);
  assert.equal(sum, TOTAL_DEPOSIT, `get_totals ${JSON.stringify(t)} must add up to the deposits`);
}

test("three hours of the fast market, ticked every minute", async () => {
  const w = world();
  const end = START + 3 * HOUR;
  assert.ok(end >= deliveryEnd(TP, 1) + PARAMS.report_grace_secs, "two series can settle in the window");
  const reports = await runFor(w, START, end);
  const entries = all(reports);
  const m = w.model.market;

  // Prints: every bucket in the window had a fresh bundle, and every one is final.
  const interval = PARAMS.print_interval_secs;
  let buckets = 0;
  for (let b = Math.floor(START / interval) * interval; b <= end; b += interval) {
    const p = await w.model.get_print({ bucket: b });
    assert.ok(p?.final, `print for bucket ${b} is final`);
    buckets++;
  }
  assert.equal(buckets, 37);

  // Every round that had commits and is over was cleared; no reveal was missed; nothing forfeited.
  const committed = new Set<string>();
  const cleared = new Map<string, bigint>();
  for (const e of m.events) {
    if (e.event === "commit") committed.add(`${e.data.series}/${e.data.round}`);
    if (e.event === "clear") cleared.set(`${e.data.series}/${e.data.round}`, e.data.forfeited);
  }
  assert.ok(committed.size >= 20, `${committed.size} rounds had commits`);
  for (const key of committed) {
    const [s, r] = key.split("/").map(Number) as [number, number];
    if (roundEnd(TP, s, r) <= end) assert.ok(cleared.has(key), `round ${key} cleared`);
  }
  assert.deepEqual([...cleared.values()].filter((f) => f > 0n), [], "no forfeits");
  assert.deepEqual(entries.filter((e) => e.action === "forfeit"), []);
  // Every commit of a round whose reveal phase is over was revealed.
  const over = (e: { data: { series: number; round: number } }) => roundEnd(TP, e.data.series, e.data.round) <= end;
  const commits = m.events.filter((e) => e.event === "commit").length;
  const reveals = m.events.filter((e) => e.event === "reveal").length;
  assert.equal(m.events.filter((e) => e.event === "reveal" && over(e)).length, m.events.filter((e) => e.event === "commit" && over(e)).length);

  // Two series settled, every position redeemed.
  for (const series of [0, 1]) {
    const s = await w.model.get_series({ series });
    assert.ok(s?.settlement, `series ${series} settled`);
    assert.equal(s.settlement.void, false);
    assert.equal(s.pending_rounds, 0);
    for (const a of AGENTS) assert.deepEqual(await w.model.get_position({ series, account_id: a.account_id }), { long: 0, short: 0 });
  }
  const traded = (await w.model.get_results({ series: 0, from_round: 0, limit: 100 })).filter(([, r]) => r.volume > 0).length;
  assert.ok(traded >= 8, `series 0 traded in ${traded} of ${roundCount(TP, 0)} rounds`);
  await totalsBalance(w);

  // The keeper itself: no failure, never over budget, every transaction logged with its hash.
  assert.deepEqual(entries.filter((e) => e.status === "failed"), []);
  for (const r of reports) assert.ok(r.budget.used <= 40, `tick ${r.now} used ${r.budget.used}`);
  const txs = reports.flatMap((r) => r.txs);
  assert.ok(txs.every((t) => t.ok && t.tx_hash?.startsWith("model-")));
  assert.equal(txs.filter((t) => t.method === "commit").length, commits);
  const status = JSON.parse((await w.store.get(KEYS.status))!);
  assert.equal(status.log.length, 200);
  assert.equal(status.last_tick, end);
  console.log(
    `full run: ${reports.length} ticks, ${txs.length} transactions (${commits} commits, ${reveals} reveals), ` +
      `max ${Math.max(...reports.map((r) => r.budget.used))} requests in a tick, mean ${(reports.reduce((s, r) => s + r.budget.used, 0) / reports.length).toFixed(1)}, ` +
      `${w.store.writes} store writes`,
  );
});

test("missed minutes across a reveal window: the forfeits are logged and the keeper carries on", async () => {
  const w = world();
  // START is one minute into round 2's commit phase; its reveal phase is START+120 to START+240.
  const before = await runFor(w, START, START + 60);
  const round2 = await w.model.get_round({ series: 0, round: 2 });
  assert.ok(round2 && round2.commits.length >= 5, "agents committed in round 2");
  // The scheduler stops: the ticks at START+120 and START+180 never run.
  const after = await runFor(w, START + 240, START + 240 + HOUR);
  const entries = all(after);
  const lost = entries.filter((e) => e.action === "forfeit");
  assert.equal(lost.length, round2.commits.length, "one forfeit logged per unrevealed commit");
  assert.ok(lost.every((e) => e.series === 0 && e.round === 2 && e.step === "swarm"));
  const expected = round2.commits.reduce((s, c) => s + (BigInt(c.lock) * BigInt(PARAMS.forfeit_bps)) / 10_000n, 0n);
  assert.equal(lost.reduce((s, e) => s + BigInt((e.data as { forfeit: string }).forfeit), 0n), expected);
  assert.equal((await w.model.get_series({ series: 0 }))!.bonus_pool, expected.toString());
  // It carries on: no failure, later rounds traded and cleared without a forfeit.
  assert.deepEqual([...all(before), ...entries].filter((e) => e.status === "failed"), []);
  const cleared = w.model.market.events.filter((e) => e.event === "clear" && e.data.round > 2);
  assert.ok(cleared.length >= 9, `${cleared.length} later rounds cleared`);
  assert.ok(cleared.every((e) => e.event === "clear" && e.data.forfeited === 0n));
  await totalsBalance(w);
});

test("sources failing: no index, no report, the reason logged; reporting resumes when they return", async () => {
  const w = world();
  const interval = PARAMS.print_interval_secs;
  const b0 = Math.floor(START / interval) * interval;
  await runFor(w, START, b0 + 2 * interval - 60);
  const latestBefore = await w.store.get(KEYS.latest);
  // Shadeform (an aggregator of 13 providers), Vast and Lium fail for one whole bucket: 3 of 6 needed are left.
  const bad = b0 + 2 * interval;
  w.sources.failing = new Set(["shadeform", "vast", "lium"]);
  const during = await runFor(w, bad, bad + interval - 60);
  const entries = all(during);
  assert.equal(await w.model.get_print({ bucket: bad }), null, "no report at all for the bucket");
  const fetch = entries.filter((e) => e.step === "index");
  assert.equal(fetch.length, 1, "one fetch per five-minute window, not one per tick");
  assert.equal(fetch[0]!.status, "failed");
  assert.match(fetch[0]!.text, /no index: 3 providers included, need 6/);
  assert.match(fetch[0]!.text, /shadeform \(HTTP 503\)/);
  const skipped = entries.filter((e) => e.step === "report");
  assert.equal(skipped.length, during.length, "every tick of the bucket says why it did not report");
  for (const e of skipped) {
    assert.equal(e.status, "skipped");
    assert.match(e.text, new RegExp(`no report for bucket ${bad}: no bundle fetched within it; the fetch at ${bad} formed no index`));
  }
  assert.equal(await w.store.get(KEYS.latest), latestBefore, "the last good bundle is kept but not reused");
  assert.equal(entries.filter((e) => e.action === "tx" && e.text.startsWith("report")).length, 0);
  // The sources come back.
  w.sources.failing.clear();
  await runFor(w, bad + interval, bad + 2 * interval);
  assert.ok((await w.model.get_print({ bucket: bad + interval }))?.final, "the next bucket prints");
  assert.ok((await w.model.get_print({ bucket: bad + 2 * interval }))?.final);
});

test("a budget of 10: never an eleventh request, spent in priority order, and the work still gets done", async () => {
  const w = world();
  // Agents commit at the default budget through round 10's commit phase of series 0, then the
  // budget drops to 10 for its reveals, the clears, every print, settlement and redemption.
  const switchAt = roundEnd(TP, 0, 9) + PARAMS.commit_secs;
  await runFor(w, START, switchAt - 60);
  const lastCommits = w.model.market.events.filter((e) => e.event === "commit").length;
  const reports = await runFor(w, switchAt, deliveryEnd(TP, 0) + PARAMS.report_grace_secs + 20 * 60, { budget: 10 });
  const rank = (p: string) => PRIORITY_ORDER.indexOf(p as never);
  let cut = 0;
  for (const r of reports) {
    assert.ok(r.requests.length <= 10, `tick ${r.now} made ${r.requests.length} requests`);
    assert.equal(r.budget.used, r.requests.length);
    const ranks = r.requests.map((q) => rank(q.priority));
    for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i]! >= ranks[i - 1]!, `tick ${r.now}: ${r.requests.map((q) => q.priority).join(",")}`);
    if (r.undone.length > 0) {
      cut++;
      assert.ok(r.entries.some((e) => e.action === "budget" || e.text.includes("left for the next tick")), "a cut tick says what it left");
    }
  }
  assert.ok(cut >= 10, `${cut} ticks ran out of budget`);
  assert.ok(reports.some((r) => r.requests[1]?.priority === "urgent-reveal"), "reveals about to expire come right after the status read");
  const entries = all(reports);
  // Round 10's reveals: each costs 2 requests and the phase has two ticks, each starting with
  // get_status and get_round, so at most 2 x (10 - 2) / 2 = 8 fit. They were spread over both
  // ticks, the second tick spent its budget on them first, and only what could not fit was lost.
  const committed10 = w.model.market.events.filter((e) => e.event === "commit" && e.data.series === 0 && e.data.round === 10).length;
  const reveals = entries.filter((e) => e.action === "reveal" && e.status === "done" && e.series === 0 && e.round === 10);
  assert.equal(reveals.length, Math.min(8, committed10));
  assert.deepEqual([...new Set(reveals.map((e) => e.at))], [switchAt, switchAt + 60]);
  const lost = entries.filter((e) => e.action === "forfeit");
  assert.equal(lost.length, committed10 - reveals.length, "a forfeit only where the budget could not fit the reveal, and it is logged");
  // Every bucket printed; every round cleared; series 0 settled and every position redeemed.
  const interval = PARAMS.print_interval_secs;
  for (let b = Math.floor(switchAt / interval) * interval; b <= reports.at(-1)!.now; b += interval) {
    assert.ok((await w.model.get_print({ bucket: b }))?.final, `bucket ${b} printed`);
  }
  const s0 = await w.model.get_series({ series: 0 });
  assert.ok(s0?.settlement);
  for (const a of AGENTS) assert.deepEqual(await w.model.get_position({ series: 0, account_id: a.account_id }), { long: 0, short: 0 });
  assert.ok(entries.filter((e) => e.action === "redeem" && e.status === "done").length >= 6);
  assert.deepEqual(entries.filter((e) => e.status === "failed"), []);
  // What 10 requests cannot buy: a commit needs 11 (status, 5 shared views, 2 per agent, 2 to send it).
  assert.equal(w.model.market.events.filter((e) => e.event === "commit").length, lastCommits);
  await totalsBalance(w);
});

test("two overlapping runs for the same minute: one works, the other stands aside", async () => {
  const w = world();
  const solo = world();
  for (let t = START; t <= START + 30 * 60; t += 60) {
    w.setTime(t);
    const env = w.env({ leaseConfirmMs: 5 });
    const [a, b] = await Promise.all([
      (await import("../src/keeper.ts")).runTick({ ...env, runId: `a-${t}` }, t),
      (await import("../src/keeper.ts")).runTick({ ...env, runId: `b-${t}` }, t),
    ]);
    assert.equal([a, b].filter((r) => r.ran).length, 1, `exactly one run worked at ${t}`);
    const idle = a.ran ? b : a;
    assert.match(idle.entries[0]!.text, /holds the lease/);
    assert.deepEqual([...a.entries, ...b.entries].filter((e) => e.status === "failed"), []);
    await solo.at(t);
  }
  // The same commits, reveals and reports as a single run would have made.
  const shape = (x: World) =>
    x.model.market.events
      .filter((e) => e.event === "commit" || e.event === "report" || e.event === "reveal")
      .map((e) => JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  assert.deepEqual(shape(w), shape(solo));
  assert.ok(shape(w).length > 50);
});

test("without the lease the contract still refuses a second report or reveal, and nothing stops", async () => {
  const w = world();
  const { runTick } = await import("../src/keeper.ts");
  let refused = 0;
  for (let t = START; t <= START + 30 * 60; t += 60) {
    w.setTime(t);
    const env = w.env({ lease: false });
    const runs = await Promise.all([runTick({ ...env, runId: "a" }, t), runTick({ ...env, runId: "b" }, t)]);
    assert.ok(runs.every((r) => r.ran));
    const entries = runs.flatMap((r) => r.entries);
    // The only failures are the second copies of transactions, which the contract refused.
    for (const e of entries.filter((x) => x.status === "failed")) {
      assert.equal(e.action, "tx");
      assert.match(e.text, /already revealed|already reported|already cleared/);
      refused++;
    }
    const bucket = Math.floor(t / PARAMS.print_interval_secs) * PARAMS.print_interval_secs;
    const p = await w.model.get_print({ bucket });
    if (p) assert.equal(new Set(p.reports.map((r) => r.reporter)).size, p.reports.length, "one report per reporter");
  }
  assert.ok(refused > 0, "the runs really did overlap");
  await totalsBalance(w);
});
