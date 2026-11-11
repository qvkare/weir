// The keeper ticked once a minute on the model, as cron would: four markets for three hours,
// missed minutes, failing sources, a missing reporter, the fairness rule, a small budget, and
// two runs at once.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MarketId } from "@weir/agents";
import { deliveryEnd, roundEnd, roundCount } from "@weir/engine";
import { PRIORITY_ORDER } from "../src/budget.ts";
import { cadence, runTick, type KeeperEntry, type StoredStatus, type TickReport } from "../src/keeper.ts";
import { KEYS } from "../src/store.ts";
import { AGENTS, FAST, IDS, PARAMS, paramsOf, REPORTERS, START, TOTAL_DEPOSIT, tpOf, TP, world, type World } from "./harness.ts";

const HOUR = 3600;

async function runFor(w: World, from: number, to: number, extra = {}): Promise<TickReport[]> {
  const out: TickReport[] = [];
  for (let t = from; t <= to; t += 60) out.push(await w.at(t, extra));
  return out;
}

const all = (reports: TickReport[]): KeeperEntry[] => reports.flatMap((r) => r.entries);

async function totalsBalance(w: World, id: MarketId): Promise<void> {
  const t = await w.models[id].get_totals({});
  const sum = BigInt(t.free) + BigInt(t.locked) + BigInt(t.sets_backing) + BigInt(t.unredeemed) + BigInt(t.burned);
  assert.equal(sum, TOTAL_DEPOSIT, `${id}: get_totals ${JSON.stringify(t)} must add up to the deposits`);
}

const status = async (w: World) => JSON.parse((await w.store.get(KEYS.status))!) as StoredStatus;

test("three hours of four markets, ticked every minute", async () => {
  const w = world();
  const end = START + 3 * HOUR;
  assert.ok(end >= deliveryEnd(TP, 1) + PARAMS.report_grace_secs, "two fast series can settle in the window");
  const reports = await runFor(w, START, end);
  const entries = all(reports);

  for (const id of IDS) {
    const m = w.models[id].market;
    const p = paramsOf(id);
    const tp = tpOf(id);
    // Prints: every bucket that had a fresh bundle is final (all three reporters, decided at once),
    // except the fast buckets more than two periods old, which were pruned.
    let buckets = 0;
    for (let b = Math.floor(START / p.print_interval_secs) * p.print_interval_secs; b <= end; b += p.print_interval_secs) {
      const print = await w.models[id].get_print({ bucket: b });
      if (end >= b + 2 * p.period_secs) assert.equal(print, null, `${id} bucket ${b} pruned`);
      else assert.equal(print?.state, "Final", `${id} bucket ${b} printed`);
      buckets++;
    }
    assert.equal(buckets, id === FAST ? 37 : 4);
    // Every round with commits whose time is over was cleared, every commit revealed, no forfeit.
    const committed = new Set<string>();
    const cleared = new Map<string, bigint>();
    for (const e of m.events) {
      if (e.event === "commit") committed.add(`${e.data.series}/${e.data.round}`);
      if (e.event === "clear") cleared.set(`${e.data.series}/${e.data.round}`, e.data.forfeited);
    }
    assert.ok(committed.size >= (id === FAST ? 20 : 3), `${id}: ${committed.size} rounds had commits`);
    for (const key of committed) {
      const [s, r] = key.split("/").map(Number) as [number, number];
      if (roundEnd(tp, s, r) <= end) assert.ok(cleared.has(key), `${id} round ${key} cleared`);
    }
    assert.deepEqual([...cleared.values()].filter((f) => f > 0n), [], `${id}: no forfeits`);
    const over = (e: { data: { series: number; round: number } }) => roundEnd(tp, e.data.series, e.data.round) <= end;
    const commits = m.events.filter((e) => e.event === "commit" && over(e)).length;
    assert.equal(m.events.filter((e) => e.event === "reveal" && over(e)).length, commits, `${id}: every commit revealed`);
    if (id !== FAST) assert.ok(commits >= 3 * 6, `${id}: ${commits} commits in three weekly rounds`);
    await totalsBalance(w, id);
    // The cost of the swarm, from the chain: here every commit is one of ours, so the agents'
    // fees and forfeits are everything the market burned.
    const c = (await status(w)).markets[id]!.costs!;
    const burned = BigInt((await w.models[id].get_totals({})).burned);
    assert.equal(BigInt(c.fees) + BigInt(c.forfeits), burned, `${id}: fees + forfeits = burned`);
    assert.equal(BigInt(c.fees), BigInt(p.commit_fee) * BigInt(m.events.filter((e) => e.event === "clear").reduce((n, e) => n + (e.event === "clear" ? Number(e.data.fees) / Number(p.commit_fee) : 0), 0)));
    assert.equal(c.forfeits, "0");
    assert.ok(BigInt(c.fees) > 0n);
  }

  // The fast market: two series settled, every position redeemed, results of series 0 pruned.
  for (const series of [0, 1]) {
    const s = await w.models[FAST].get_series({ series });
    assert.ok(s?.settlement, `series ${series} settled`);
    assert.equal(s.settlement.void, false);
    assert.deepEqual(s.pending_rounds, []);
    for (const a of AGENTS) assert.deepEqual(await w.models[FAST].get_position({ series, account_id: a.account_id }), { long: 0, short: 0 });
  }
  assert.deepEqual(await w.models[FAST].get_results({ series: 0, from_round: 0, limit: 100 }), [], "series 0's results pruned");
  // 13 fast prints two hours old, and every result of series 0.
  const pruned = entries.filter((e) => e.action === "prune" && e.status === "done");
  assert.equal(pruned.filter((e) => e.text.startsWith("pruned the print")).length, 13);
  const results0 = w.models[FAST].market.events.filter((e) => e.event === "clear" && e.data.series === 0).length;
  assert.ok(results0 >= 9);
  assert.equal(pruned.filter((e) => e.text.startsWith("pruned the result of series 0")).length, results0);

  // The keeper itself: no failure, never over budget, every transaction logged with its hash.
  assert.deepEqual(entries.filter((e) => e.status === "failed"), []);
  for (const r of reports) assert.ok(r.budget.used <= 40, `tick ${r.now} used ${r.budget.used}`);
  const txs = reports.flatMap((r) => r.txs);
  assert.ok(txs.every((t) => t.ok && t.tx_hash?.startsWith("model-")));
  const st = await status(w);
  assert.equal(st.log.length, 200);
  assert.equal(st.last_tick, end);
  assert.ok(entries.some((e) => e.action === "costs" && /agents paid \$\d+\.\d\d in commit fees and lost \$0\.00 in forfeits/.test(e.text)));
  console.log(
    `full run: ${reports.length} ticks, 4 markets, ${txs.length} transactions, ` +
      `max ${Math.max(...reports.map((r) => r.budget.used))} requests in a tick, mean ${(reports.reduce((s, r) => s + r.budget.used, 0) / reports.length).toFixed(1)}, ` +
      `${w.store.writes} store writes; fees ${IDS.map((id) => `${id} ${st.markets[id]!.costs!.fees}`).join(", ")}`,
  );
});

test("missed minutes across a reveal window: the forfeits are logged, counted, and the keeper carries on", async () => {
  const w = world({ markets: [FAST] });
  const before = await runFor(w, START, START + 60);
  const round2 = await w.model.get_round({ series: 0, round: 2 });
  assert.ok(round2 && round2.commits.length >= 5, "agents committed in round 2");
  // The ticks at START+120 and START+180 never run: round 2's reveal phase passes unseen.
  const after = await runFor(w, START + 240, START + 240 + HOUR);
  const entries = all(after);
  const lost = entries.filter((e) => e.action === "forfeit");
  assert.equal(lost.length, round2.commits.length, "one forfeit logged per unrevealed commit");
  assert.ok(lost.every((e) => e.series === 0 && e.round === 2 && e.step === "swarm"));
  const expected = round2.commits.reduce((s, c) => s + (BigInt(c.lock) * BigInt(PARAMS.forfeit_bps)) / 10_000n, 0n);
  assert.equal(lost.reduce((s, e) => s + BigInt((e.data as { forfeit: string }).forfeit), 0n), expected);
  assert.equal((await status(w)).markets[FAST]!.costs!.forfeits, expected.toString(), "/status counts them");
  assert.deepEqual([...all(before), ...entries].filter((e) => e.status === "failed"), []);
  const cleared = w.model.market.events.filter((e) => e.event === "clear" && e.data.round > 2);
  assert.ok(cleared.length >= 9, `${cleared.length} later rounds cleared`);
  assert.ok(cleared.every((e) => e.event === "clear" && e.data.forfeited === 0n));
  await totalsBalance(w, FAST);
});

test("sources failing: no chip forms an index, no market reports, each says why; reporting resumes", async () => {
  const w = world();
  const b0 = Math.floor(START / 300) * 300;
  await runFor(w, START, b0 + 600 - 60);
  // Shadeform (an aggregator) fails for one five-minute window: every chip falls below 6 providers.
  const bad = b0 + 600;
  w.sources.failing = new Set(["shadeform"]);
  const during = await runFor(w, bad, bad + 240);
  const entries = all(during);
  assert.equal(await w.models[FAST].get_print({ bucket: bad }), null, "no report at all for the bucket");
  const fetch = entries.filter((e) => e.step === "index");
  assert.deepEqual(fetch.map((e) => e.status), ["failed", "failed", "failed"], "one fetch per window, every chip without an index");
  assert.match(fetch[0]!.text, /^h100: no index: 4 providers included, need 6; failed sources: shadeform \(HTTP 503\)/);
  const skipped = entries.filter((e) => e.step === "report" && e.market === FAST);
  assert.equal(skipped.length, during.length, "every tick of the bucket says why it did not report");
  for (const e of skipped) assert.match(e.text, new RegExp(`no report for bucket ${bad}: no h100 bundle fetched within it; the fetch at ${bad} formed no h100 index \\(4 providers included, need 6\\)`));
  assert.equal(entries.filter((e) => e.action === "tx" && e.text.startsWith("report")).length, 0);
  w.sources.failing.clear();
  await runFor(w, bad + 300, bad + 600);
  assert.equal((await w.models[FAST].get_print({ bucket: bad + 300 }))?.state, "Final", "the next bucket prints");
});

test("a chip without a bundle: only its market goes without a report, and says so", async () => {
  const w = world({ markets: ["h100-fast", "h200-weekly"] });
  const r = await w.at(START, { chips: ["h100"] });
  assert.equal((await w.models["h100-fast"].get_print({ bucket: Math.floor(START / 300) * 300 }))?.state, "Final");
  const h200 = r.entries.filter((e) => e.market === "h200-weekly" && e.step === "report");
  assert.equal(h200.length, 1);
  assert.match(h200[0]!.text, /no h200 bundle fetched within it; there is no h200 bundle yet/);
});

test("a reporter missing: two agree and finalize_print gives the print after the window; two disagree and there is none", async () => {
  // rep-c is down; the keeper runs rep-a and rep-b.
  const w = world({ markets: [FAST], reporters: ["rep-a.test", "rep-b.test"] });
  const b = Math.floor(START / 300) * 300;
  const first = await w.at(START);
  assert.equal((await w.model.get_print({ bucket: b }))?.state, "Open", "two of three: not decided yet");
  assert.match(first.entries.find((e) => e.action === "report" && e.status === "skipped")!.text, /rep-c\.test not reported; it is decided when they do, or by finalize_print after/);
  const close = b + PARAMS.print_interval_secs + PARAMS.report_grace_secs;
  const reports = await runFor(w, START + 60, close + 60);
  const fin = all(reports).filter((e) => e.action === "finalize");
  assert.equal(fin[0]!.status, "done");
  assert.match(fin[0]!.text, new RegExp(`finalized bucket ${b}: its print is final`));
  assert.ok(fin[0]!.at >= close);
  assert.equal((await w.model.get_print({ bucket: b }))?.state, "Final");
  assert.ok((await w.model.get_series({ series: 0 })) !== null, "the series opened on it");

  // Now only rep-a is the keeper's; rep-b reports 5% higher by itself. The two middle (only)
  // reports are 500 bps apart, more than max_spread_bps 200: no print, and the log says why.
  const v = world({ markets: [FAST], reporters: ["rep-a.test"] });
  const log: KeeperEntry[] = [];
  for (let t = START; t <= START + 15 * 60; t += 60) {
    const r = await v.at(t);
    log.push(...r.entries);
    const bucket = Math.floor(t / 300) * 300;
    const mine = await v.model.get_print({ bucket });
    const theirs = mine?.reports.find((x) => x.reporter === "rep-a.test");
    if (theirs && !mine!.reports.some((x) => x.reporter === "rep-b.test")) {
      await v.model.as("rep-b.test").report({ bucket, price: Math.round(theirs.price * 1.05), bundle: theirs.bundle });
    }
  }
  const noPrint = log.filter((e) => e.action === "finalize");
  assert.ok(noPrint.length >= 2);
  for (const e of noPrint) {
    assert.match(e.text, /with no print: the two middle reports 2900000 and 3045000 are 500 bps apart, more than max_spread_bps 200/);
    assert.equal((await v.model.get_print({ bucket: (e.data as { bucket: number }).bucket }))?.state, "NoPrint");
  }
  assert.equal(await v.model.get_last_print({}), null, "no price came out of it");
});

test("fairness: weekly markets act on their own minutes, everyone is first in line within two turns, and all trade", async () => {
  const w = world();
  const reports = await runFor(w, START, START + HOUR);
  const turn = (id: MarketId) => cadence(paramsOf(id));
  assert.deepEqual(IDS.map(turn), [1, 5, 5, 5]);
  const lastFirst = new Map<MarketId, number>();
  for (const r of reports) {
    const minute = Math.floor(r.now / 60);
    // Who acts: the fast market every minute, weekly market i on minutes = i (mod 5).
    assert.deepEqual([...r.acting].sort(), IDS.filter((id, i) => minute % turn(id) === i % turn(id)).sort());
    // Only acting markets spend in the later steps.
    for (const q of r.requests) {
      if (["reveal-clear", "commit", "settle-redeem", "prune"].includes(q.priority)) assert.ok(r.acting.includes(q.market as MarketId), `${q.market} spent on ${q.priority} out of turn`);
    }
    // Head of the line: the gap between a market's turns at the front is at most two of its turns.
    const head = r.acting[0]!;
    if (lastFirst.has(head)) assert.ok(r.now - lastFirst.get(head)! <= 2 * turn(head) * 60, `${head} waited ${r.now - lastFirst.get(head)!} s`);
    lastFirst.set(head, r.now);
    for (const id of r.acting) if (!lastFirst.has(id)) lastFirst.set(id, r.now - 60);
  }
  // And it shows in the trading: every fast round of the hour had commits, and every agent
  // got its order into round 0 of each weekly market.
  for (const id of IDS) {
    const m = w.models[id].market;
    const committers = (s: number, r: number) => new Set(m.events.filter((e) => e.event === "commit" && e.data.series === s && e.data.round === r).map((e) => (e.event === "commit" ? e.data.accountId : ""))).size;
    // (Round 2 is the start-up minute, spent reading four markets' parameters and reporting.)
    if (id === FAST) for (let r = 3; r < roundCount(TP, 0); r++) assert.ok(committers(0, r) >= 6, `fast round ${r}: ${committers(0, r)} agents`);
    else assert.equal(committers(0, 0), 8, `${id} round 0: all eight agents`);
  }
  assert.deepEqual(all(reports).filter((e) => e.status === "failed" || e.action === "forfeit"), []);
});

test("a budget of 10: never an eleventh request, spent in priority order, and the work still gets done", async () => {
  const w = world({ markets: [FAST] });
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
  // get_status and get_round, so at most 2 x (10 - 2) / 2 = 8 fit; only what could not fit is lost.
  const committed10 = w.model.market.events.filter((e) => e.event === "commit" && e.data.series === 0 && e.data.round === 10).length;
  const reveals = entries.filter((e) => e.action === "reveal" && e.status === "done" && e.series === 0 && e.round === 10);
  assert.equal(reveals.length, Math.min(8, committed10));
  assert.deepEqual([...new Set(reveals.map((e) => e.at))], [switchAt, switchAt + 60]);
  assert.equal(entries.filter((e) => e.action === "forfeit").length, committed10 - reveals.length);
  // Three reports a bucket (6 requests after get_print) still land, over two ticks when needed.
  const interval = PARAMS.print_interval_secs;
  for (let b = Math.floor(switchAt / interval) * interval; b <= reports.at(-1)!.now; b += interval) {
    assert.equal((await w.model.get_print({ bucket: b }))?.state, "Final", `bucket ${b} printed`);
  }
  const s0 = await w.model.get_series({ series: 0 });
  assert.ok(s0?.settlement);
  for (const a of AGENTS) assert.deepEqual(await w.model.get_position({ series: 0, account_id: a.account_id }), { long: 0, short: 0 });
  assert.deepEqual(entries.filter((e) => e.status === "failed"), []);
  assert.equal(w.model.market.events.filter((e) => e.event === "commit").length, lastCommits, "a commit cannot fit in 10");
  await totalsBalance(w, FAST);
});

test("pruning needs the housekeeping account: without it nothing is pruned and /status says why", async () => {
  const w = world({ markets: [FAST], keeper: false });
  await runFor(w, START, START + 2 * HOUR + 600);
  const st = await status(w);
  assert.match(st.markets[FAST]!.pruning, /^off: no KEEPER account/);
  assert.equal((await w.model.get_print({ bucket: Math.floor(START / 300) * 300 }))?.state, "Final", "old print kept");
  assert.ok(st.log.every((e) => e.action !== "prune"));
});

test("two overlapping runs for the same minute: one works, the other stands aside", async () => {
  const w = world({ markets: [FAST] });
  const solo = world({ markets: [FAST] });
  for (let t = START; t <= START + 30 * 60; t += 60) {
    w.setTime(t);
    const env = w.env({ leaseConfirmMs: 5 });
    const [a, b] = await Promise.all([runTick({ ...env, runId: `a-${t}` }, t), runTick({ ...env, runId: `b-${t}` }, t)]);
    assert.equal([a, b].filter((r) => r.ran).length, 1, `exactly one run worked at ${t}`);
    const idle = a.ran ? b : a;
    assert.match(idle.entries[0]!.text, /holds the lease/);
    assert.deepEqual([...a.entries, ...b.entries].filter((e) => e.status === "failed"), []);
    await solo.at(t);
  }
  const shape = (x: World) =>
    x.model.market.events
      .filter((e) => e.event === "commit" || e.event === "report" || e.event === "reveal")
      .map((e) => JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  assert.deepEqual(shape(w), shape(solo));
  assert.ok(shape(w).length > 50);
});

test("without the lease the contract still refuses a second report or reveal, and nothing stops", async () => {
  const w = world({ markets: [FAST] });
  let refused = 0;
  for (let t = START; t <= START + 30 * 60; t += 60) {
    w.setTime(t);
    const env = w.env({ lease: false });
    const runs = await Promise.all([runTick({ ...env, runId: "a" }, t), runTick({ ...env, runId: "b" }, t)]);
    assert.ok(runs.every((r) => r.ran));
    for (const e of runs.flatMap((r) => r.entries).filter((x) => x.status === "failed")) {
      assert.equal(e.action, "tx");
      assert.match(e.text, /: (commit is already revealed|reporter already reported this bucket|round is already cleared|bucket is already decided)$/);
      refused++;
    }
    const bucket = Math.floor(t / PARAMS.print_interval_secs) * PARAMS.print_interval_secs;
    const p = await w.model.get_print({ bucket });
    if (p) assert.equal(new Set(p.reports.map((r) => r.reporter)).size, p.reports.length, "one report per reporter");
  }
  assert.ok(refused > 0, "the runs really did overlap");
  assert.ok(REPORTERS.length === 3);
  await totalsBalance(w, FAST);
});
