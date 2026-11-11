// The simulation: deterministic, conserves every dollar, and trades.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentReports, burned, createSimulation, MARKETS, type SimConfig } from "../src/sim.ts";

const DEFAULT: SimConfig = { seed: 7, buyers: 20, sellers: 5, makers: 2, noise: 3, market: "fast" };

test("same seed, same events, byte for byte; another seed differs", () => {
  const run = (seed: number) => {
    const s = createSimulation({ ...DEFAULT, seed });
    s.runRounds(14);
    s.step(437);
    s.skipToClearing();
    s.settleAll();
    return JSON.stringify(s.log);
  };
  const a = run(7);
  assert.equal(run(7), a);
  assert.notEqual(run(8), a);
  assert.ok(a.length > 100_000);
});

test("no dollar is created or lost: at every step and after a full settlement", () => {
  const s = createSimulation(DEFAULT);
  const deposits = s.agents.reduce((sum, a) => sum + BigInt(a.deposit), 0n);
  const contractHolds = () => {
    const t = s.market.getTotals();
    return t.free + t.locked + t.setsBacking + t.unredeemed + t.burned;
  };
  for (let i = 0; i < 20; i++) {
    s.step(150);
    assert.equal(contractHolds(), deposits, `after ${i + 1} steps`);
  }
  s.runRounds(10);
  s.settleAll();
  const t = s.market.getTotals();
  const balances = Object.values(s.balances()).reduce((sum, b) => sum + BigInt(b), 0n);
  assert.equal(t.locked, 0n);
  assert.equal(t.setsBacking, 0n);
  assert.equal(t.unredeemed, 0n);
  assert.equal(balances, t.free, "every free balance belongs to an agent");
  assert.equal(balances + t.burned, deposits, "what agents hold plus what was burned is what they deposited");
  const b = burned(s.market);
  assert.equal(b.fees + b.forfeits, t.burned);
  assert.ok(b.fees > 0n);
  const reports = agentReports(s);
  for (const r of reports) assert.equal(r.result, r.received - r.paid - r.fees - r.forfeited, r.id);
  assert.equal(reports.reduce((sum, r) => sum + r.fees + r.forfeited, 0n), t.burned);
});

test("20 buyers and 5 sellers trade in most rounds with the default seed", (t) => {
  const s = createSimulation({ seed: 7, buyers: 20, sellers: 5, makers: 0, noise: 0, market: "fast" });
  const clears = s.runRounds(24).filter((e) => e.kind === "clear");
  const volumes = clears.map((e) => (e.data as { volume: number }).volume);
  const traded = volumes.filter((v) => v > 0).length;
  t.diagnostic(`traded in ${traded} of ${clears.length} rounds, volumes ${volumes.join(" ")}`);
  assert.equal(clears.length, 24);
  assert.ok(traded >= 20, `traded in only ${traded} of 24 rounds`);
  assert.equal(s.log.filter((e) => e.kind === "forfeit" || e.kind === "error").length, 0);
});

test("an explicit price path is replayed: prints follow it (the median of the reporters' slight skews)", () => {
  const prices = [2_000_000, 2_100_000, 2_300_000, 1_900_000];
  const s = createSimulation({ ...DEFAULT, prices });
  s.step(3 * 300);
  const prints = s.market.getPrints(0, 10).map((p) => p.price!);
  // All three reporters (at -0.1%, exact and +0.1%) report, so each print is their median.
  assert.deepEqual(prints, prices);
});

test("the weekly preset runs: hourly rounds, a series opening on the first commit", () => {
  const s = createSimulation({ ...DEFAULT, market: "weekly" });
  const events = s.runRounds(3);
  assert.ok(events.some((e) => e.kind === "series_opened"));
  assert.equal(events.filter((e) => e.kind === "clear").length, 3);
  assert.ok(events.every((e, i) => i === 0 || e.at >= events[i - 1]!.at));
  assert.equal(s.now() % 3600, 0);
});

test("every market satisfies every rule of SPEC section 3", () => {
  for (const { id, params: p } of Object.values(MARKETS)) {
    const roundSecs = p.commit_secs + p.reveal_secs;
    const rounds = (p.lead_secs - p.cutoff_secs) / roundSecs;
    for (const d of [p.period_secs, p.lead_secs, p.commit_secs, p.reveal_secs, p.print_interval_secs, p.report_grace_secs, p.void_after_secs, p.max_anchor_age_secs]) {
      assert.ok(Number.isSafeInteger(d) && d > 0, id);
    }
    assert.ok(p.cutoff_secs >= 0 && p.cutoff_secs < p.lead_secs, id);
    assert.ok(p.tick > 0 && p.band_bps > 0 && p.band_bps < 10_000 && p.forfeit_bps <= 10_000, id);
    assert.ok(p.max_commits >= 1 && p.max_commits <= 128 && p.max_order_size >= 1, id);
    assert.ok(p.min_prints >= 1 && p.min_prints <= p.period_secs / p.print_interval_secs, id);
    assert.ok(p.void_after_secs >= p.report_grace_secs && p.report_grace_secs <= p.period_secs, id);
    assert.ok(p.max_spread_bps > 0 && p.max_spread_bps <= 10_000, id);
    assert.ok(p.max_order_size * p.max_commits * Math.floor(rounds) < 2 ** 52, id);
    assert.equal(p.t0 % p.print_interval_secs, 0, id);
    assert.equal(p.period_secs % p.print_interval_secs, 0, id);
    assert.ok(p.reporters.length >= 1 && p.reporters.length <= 9 && new Set(p.reporters).size === p.reporters.length, id);
    assert.ok(p.quorum >= 1 && p.quorum <= p.reporters.length, id);
    assert.ok(p.quorum * 2 > p.reporters.length, `${id}: the quorum is a majority`);
    assert.ok(BigInt(p.min_lock) >= 0n && BigInt(p.commit_fee) >= 0n, id);
    // Weir's own choices: back-to-back auction windows, whole rounds, the agreed numbers.
    assert.equal(p.lead_secs, p.period_secs + p.cutoff_secs, id);
    assert.equal(rounds, Math.floor(rounds), id);
    assert.deepEqual([p.band_bps, p.max_spread_bps, p.commit_fee], [1500, 200, "100000"], id);
  }
  assert.deepEqual(
    Object.values(MARKETS).map((m) => [m.id, m.chip, m.underlying, m.preset]),
    [
      ["h100-fast", "h100", "H100-USD-HR", "fast"],
      ["h100-weekly", "h100", "H100-USD-HR", "weekly"],
      ["h200-weekly", "h200", "H200-USD-HR", "weekly"],
      ["a100-80-weekly", "a100-80", "A100-80-USD-HR", "weekly"],
    ],
  );
});

test("each chip's simulation starts its index near that chip's level", () => {
  for (const id of ["h100-weekly", "h200-weekly", "a100-80-weekly"] as const) {
    const s = createSimulation({ ...DEFAULT, market: id });
    const first = s.market.getPrints(0, 1)[0]!.price!;
    assert.equal(first, MARKETS[id].startPrice);
    assert.equal(s.market.params.underlying, MARKETS[id].underlying);
  }
});

test("both presets satisfy SPEC section 3: t0 and period_secs are multiples of print_interval_secs, cutoff < lead", async () => {
  const { PRESETS, SIM_T0 } = await import("../src/mod.ts");
  for (const p of Object.values(PRESETS)) {
    assert.equal(p.t0, SIM_T0);
    assert.equal(p.t0 % p.print_interval_secs, 0);
    assert.equal(p.period_secs % p.print_interval_secs, 0);
    assert.ok(p.cutoff_secs < p.lead_secs);
    assert.equal(p.lead_secs, p.period_secs + p.cutoff_secs);
  }
});

test("default agents trade in most rounds on every market, with the 10-cent fee", (t) => {
  for (const id of Object.keys(MARKETS) as (keyof typeof MARKETS)[]) {
    const s = createSimulation({ ...DEFAULT, market: id });
    const clears = s.runRounds(24).filter((e) => e.kind === "clear");
    const traded = clears.filter((e) => (e.data as { volume: number }).volume > 0).length;
    t.diagnostic(`${id}: traded in ${traded} of ${clears.length} rounds`);
    assert.ok(traded >= 20, `${id} traded in only ${traded} of ${clears.length}`);
  }
});

test("a void series: reporters silent through its delivery, every LONG and SHORT paid half the band, money check balances", () => {
  const s = createSimulation({ ...DEFAULT, silentSeries: 0 });
  s.runRounds(14);
  s.settleAll();
  const series = s.market.getSeries(0)!;
  const settlement = series.settlement!;
  assert.equal(settlement.void, true);
  assert.equal(settlement.longPayout, series.band / 2);
  assert.equal(settlement.shortPayout, series.band / 2);
  assert.equal(settlement.fixing, series.floor + settlement.longPayout);
  assert.ok(s.log.some((e) => e.kind === "settle" && e.text.includes("void: cancelled at the centre of the band")));
  const t = s.market.getTotals();
  const deposits = s.agents.reduce((sum, a) => sum + BigInt(a.deposit), 0n);
  assert.equal(t.locked + t.setsBacking + t.unredeemed, 0n);
  assert.equal(t.free + t.burned, deposits);
  assert.equal(s.market.getSeries(1)!.settlement!.void, false, "the next series prints again and settles normally");
});
